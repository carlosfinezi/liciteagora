'use strict';

/**
 * bnc-session-service.js — Login BNC (bnccompras.com) SERVER-SIDE, sem Electron.
 *
 * Clona o harness provado do gov.br (govbr-bearer-service.js): Chrome REAL neste
 * servidor via puppeteer-core + /usr/bin/google-chrome-stable, sob xvfb, com a
 * extensão NopeCHA force-installed por política (/etc/opt/chrome/policies/managed)
 * resolvendo o reCAPTCHA in-page. Substitui o app Electron BNC:
 *
 *   FASE 1 (sessão)  — loga (teclado virtual + reCAPTCHA v2 invisible), extrai o
 *                      cookie BNC e entrega em POST /api/electron/bnc/cookies
 *                      (o servidor grava bnc_session_cookie/_at/_user/_perfil na
 *                      tabela config; bnc-client.js/bnc-proposta.js já consomem).
 *                      Keepalive via GET /Home/GetTimeNow; re-login ao expirar.
 *   FASE 2 (lances)  — relay de token reCAPTCHA v3: polla o servidor em
 *                      /api/electron/bnc/captcha-pending, roda grecaptcha.execute
 *                      numa página BNC viva e devolve em /api/electron/bnc/captcha-token
 *                      (porta de electron-standalone/portals/bnc/captcha-relay.js).
 *
 * Login portado de electron-standalone/portals/bnc/auto-login.js (o snippet dirige
 * as funções NATIVAS do site: window.soma monta a senha de 12 chars via teclado
 * virtual; window.doLogin dispara o reCAPTCHA invisible + POST /Home/Login).
 *
 * Uso:
 *   # teste one-shot (loga, entrega cookie, sai):
 *   NOPECHA_KEY=xxx USE_EXTENSION=1 DELIVER=1 xvfb-run -a node bnc-session-service.js
 *   # serviço (keepalive + relay infinito, systemd):
 *   NOPECHA_KEY=xxx USE_EXTENSION=1 SERVICE=1 DELIVER=1 RELAY=1 xvfb-run -a node bnc-session-service.js
 *
 * Env: TENANT(=1bit) NOPECHA_KEY PROXY USE_EXTENSION SERVICE DELIVER RELAY
 *      SERVER_URL PROBE_SEC(=45) REDELIVER_SEC(=600) ROTATE_MIN(=0=off) HEADFUL
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const puppeteer = require('puppeteer-core');
const Database = require('better-sqlite3');

const TENANT = process.env.TENANT || '1bit';
const NOPECHA_KEY = process.env.NOPECHA_KEY || '';
const PROXY = process.env.PROXY || '';
const USER_DATA_DIR = process.env.USER_DATA_DIR || '';
const DELIVER = process.env.DELIVER === '1';
const SERVICE = process.env.SERVICE === '1';      // keepalive infinito (até morte → systemd reinicia)
const RELAY = process.env.RELAY === '1';          // Fase 2: relay de token de lance
const USE_EXTENSION = process.env.USE_EXTENSION === '1';
const SERVER_URL = process.env.SERVER_URL || 'https://1bit.liciteagora.app';
const PROBE_SEC = parseInt(process.env.PROBE_SEC || '45', 10);        // cadência do keepalive GetTimeNow
const REDELIVER_SEC = parseInt(process.env.REDELIVER_SEC || '600', 10); // re-entrega o cookie a cada N s (rotação de cookie)
const ROTATE_MIN = parseInt(process.env.ROTATE_MIN || '0', 10);      // 0=off. reciclar Chrome (leak). cuidado: blackout no relay durante restart
const LOGIN_MAX_TRIES = parseInt(process.env.LOGIN_MAX_TRIES || '3', 10);
const CHROME = '/usr/bin/google-chrome-stable';
const EXT_ID = 'ogomknllijkjboianknlncoagialpnlm';
const EXT_SERVE_DIR = path.join(__dirname, 'nopecha-serve');

const BNC_BASE = 'https://bnccompras.com';
const BNC_LOGIN_URL = `${BNC_BASE}/Home/Login`;
const SITEKEY = '6LestvomAAAAAG9MNzlBaMEufF1QLdpKoL48qGsq';
const UA_FALLBACK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const COOKIE_TRACKING = /^(_ga|_gid|_gat|_fbp|gads|_gcl)/i;
const RELAY_POLL_MS = 1000;
const RELAY_EXECUTE_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));
function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }

// ─── servidor HTTP in-process p/ force-install da extensão (idem gov.br) ─────
function startExtServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const name = path.basename((req.url || '').split('?')[0]);
      const f = path.join(EXT_SERVE_DIR, name);
      if (!f.startsWith(EXT_SERVE_DIR)) { res.writeHead(403); return res.end(); }
      fs.readFile(f, (e, data) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(data); } });
    });
    srv.on('error', () => { log('[ext-server] porta 8899 já em uso — reusando'); resolve(null); });
    srv.listen(8899, '127.0.0.1', () => { log('[ext-server] servindo extensão em 127.0.0.1:8899'); resolve(srv); });
  });
}

// ─── credenciais do tenant (SQLite direto, readonly) ────────────────────────
function readCreds(tenant) {
  const dbPath = path.join(__dirname, 'data', 'tenants', tenant, 'pncp.db');
  if (!fs.existsSync(dbPath)) throw new Error(`pncp.db não encontrado: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  const get = (k) => { const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k); return r ? r.valor : null; };
  const creds = {
    usuario: get('bnc_usuario'),
    senha: get('bnc_senha'),
    perfilPreferido: get('bnc_perfil_preferido'),
    apiKey: get('api_key'),
  };
  db.close();
  if (!creds.usuario || !creds.senha) throw new Error('bnc_usuario/bnc_senha não configurados no tenant');
  return creds;
}

// ─── HTTP JSON helper (fala com o servidor liciteagora: cookies + relay) ─────
function serverReq(method, apiPath, body, apiKey) {
  return new Promise((resolve) => {
    const u = new URL(SERVER_URL + apiPath);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: Object.assign(
        { Accept: 'application/json', 'X-Api-Key': apiKey || '' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
      ),
      timeout: 20000,
    }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: d.slice(0, 200) }); }); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (payload) req.write(payload); req.end();
  });
}

// probe de sessão viva com o cookie capturado. Sonda /Participant/ProcessSearch
// (tela autenticada: 200 logado, 302→/Home/Login deslogado). Critério de MORTA =
// mesmo do bnc-client (redirect-login / 401 / 403 / HTML de login); qualquer outra
// coisa é viva (GetTimeNow, p.ex., dá 404 mesmo logado — não é sinal de morte).
function probeSession(cookieStr) {
  return new Promise((resolve) => {
    const u = new URL(`${BNC_BASE}/Participant/ProcessSearch?param1=0`);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': UA_FALLBACK, Accept: 'text/html,application/xhtml+xml,*/*', Cookie: cookieStr },
      timeout: 15000,
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => {
        const loc = res.headers.location || '';
        const morta = /\/Home\/Login/i.test(loc) || /\/Base\/UserErrorLoad/i.test(loc) ||
          res.statusCode === 401 || res.statusCode === 403 ||
          /id="Email"\s+name="Email"|id="Password"\s+name="Password"/.test(d || '') ||
          /n[aã]o est[aá] autenticado/i.test(d || '');
        resolve({ alive: !morta, status: res.statusCode });
      });
    });
    req.on('error', () => resolve({ alive: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ alive: false, status: 0 }); });
    req.end();
  });
}

// ─── snippet de auto-login (PORTA de portals/bnc/auto-login.js) ─────────────
// Dirige as funções nativas do site (soma/doLogin). aguardarResultadoLogin com
// timeout estendido (90s) porque headless o reCAPTCHA invisible pode exibir
// challenge que a extensão NopeCHA leva alguns segundos p/ resolver.
function buildAutoLoginSnippet({ email, senha, perfilPreferido }) {
  const senhaLimpa = String(senha).replace(/\D/g, '').slice(0, 6);
  if (senhaLimpa.length !== 6) {
    return `window.__bncLoginResult = { ok: false, etapa: 'senha-invalida', error: 'Senha BNC deve ter 6 dígitos' };`;
  }
  const emailJs = JSON.stringify(String(email).trim());
  const senhaJs = JSON.stringify(senhaLimpa);
  const perfilPrefJs = JSON.stringify(perfilPreferido ? String(perfilPreferido).trim() : '');

  return `(function () {
    window.__bncLoginResult = null;
    window.__bncLoginStatus = 'iniciando';
    const EMAIL = ${emailJs};
    const SENHA = ${senhaJs};
    const PERFIL_PREFERIDO = ${perfilPrefJs};
    function setResult(r) { window.__bncLoginResult = r; }
    function setStatus(s) { window.__bncLoginStatus = s; }

    function readPares() {
      const inputs = document.querySelectorAll('input[onclick]');
      const pares = [];
      inputs.forEach((el) => {
        const oc = el.getAttribute('onclick') || '';
        const m = oc.match(/soma\\(['"]([^'"]+)['"]\\)/);
        if (!m) return;
        const token = m[1];
        const name = el.getAttribute('name') || '';
        const digitos = (name.match(/\\d|\\*/g) || []);
        const dgs = digitos.length ? digitos : (token.match(/\\d|\\*/g) || []);
        pares.push({ token, digitos: dgs });
      });
      return pares;
    }
    function montarMapaDigitoToken(pares) {
      const map = {};
      for (const p of pares) for (const d of p.digitos) { const key = d === '0' ? '*' : d; if (!map[key]) map[key] = p.token; }
      return map;
    }
    async function aguardarTeclado(maxMs = 15000) {
      const inicio = Date.now();
      while (Date.now() - inicio < maxMs) { const pares = readPares(); if (pares.length >= 5) return pares; await new Promise(r => setTimeout(r, 250)); }
      return null;
    }
    async function tentarSelecionarPerfil() {
      const modal = document.querySelector('#modalContent');
      if (!modal) return null;
      const title = modal.querySelector('.modal-title');
      if (!title || !/perfil/i.test(title.textContent || '')) return null;
      function textoDoContainer(linkEl) {
        let cur = linkEl.parentElement;
        for (let i = 0; i < 6 && cur; i++) {
          const tag = (cur.tagName || '').toLowerCase();
          const txt = (cur.innerText || cur.textContent || '').trim();
          if (tag === 'tr' || tag === 'li' || /\\b(row|card|profile|perfil|item)\\b/i.test(cur.className || '')) { if (txt.length > 4) return txt; }
          if (txt.length >= 12) return txt;
          cur = cur.parentElement;
        }
        return (linkEl.innerText || linkEl.textContent || '').trim();
      }
      const candidatos = [];
      modal.querySelectorAll('a, button, [onclick], [href]').forEach(el => {
        const oc = el.getAttribute('onclick') || ''; const href = el.getAttribute('href') || '';
        if (/ProfileChooser/i.test(oc) || /ProfileChooser/i.test(href) || /profileId/i.test(href)) candidatos.push({ el, txt: textoDoContainer(el), oc, href });
      });
      if (!candidatos.length) modal.querySelectorAll('.modal-body a, .modal-body button').forEach(el => { const txt = textoDoContainer(el); if (txt) candidatos.push({ el, txt, oc: '', href: el.getAttribute('href') || '' }); });
      if (!candidatos.length) return { erro: 'modal de perfil sem candidatos clicáveis' };
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      let preferido = null, estrategiaMatch = null;
      if (PERFIL_PREFERIDO) {
        const alvoN = norm(PERFIL_PREFERIDO);
        preferido = candidatos.find(c => norm(c.txt) === alvoN); if (preferido) estrategiaMatch = 'exato';
        if (!preferido) { preferido = candidatos.find(c => norm(c.txt).includes(alvoN)); if (preferido) estrategiaMatch = 'contains'; }
        if (!preferido) { preferido = candidatos.find(c => { const cn = norm(c.txt); return cn.length >= 4 && alvoN.includes(cn); }); if (preferido) estrategiaMatch = 'alvo-contains'; }
      }
      if (!preferido) { preferido = candidatos.find(c => /operador|principal|comprador/i.test(c.txt)) || candidatos[0]; estrategiaMatch = 'fallback'; }
      try { preferido.el.click(); return { ok: true, escolhido: preferido.txt.slice(0, 120), estrategia: estrategiaMatch }; }
      catch (e) { return { erro: 'click falhou: ' + e.message }; }
    }
    async function aguardarResultadoLogin(maxMs = 90000) {
      const inicio = Date.now();
      let perfilSelecionado = false, infoSelecao = null;
      while (Date.now() - inicio < maxMs) {
        if (!location.pathname.toLowerCase().startsWith('/home/login')) return Object.assign({ ok: true, etapa: 'redirect', url: location.href }, infoSelecao ? { selecao: infoSelecao } : {});
        const errModal = document.querySelector('#errorModal.show, #errorModal[style*="block"]');
        if (errModal) return { ok: false, etapa: 'erro-bnc', error: (errModal.innerText || '').trim().slice(0, 400) };
        const perfilModal = document.querySelector('#modalContent .modal-title');
        if (perfilModal && /perfil/i.test(perfilModal.textContent || '')) {
          if (!perfilSelecionado) {
            setStatus('escolhendo-perfil');
            const sel = await tentarSelecionarPerfil();
            if (sel && sel.ok) { perfilSelecionado = true; infoSelecao = { escolhido: sel.escolhido, estrategia: sel.estrategia }; setStatus('aguardando-pos-perfil'); await new Promise(r => setTimeout(r, 1500)); continue; }
            if (sel && sel.erro) return { ok: true, etapa: 'escolha-perfil', precisaInteracao: true, erro: sel.erro };
          }
        }
        await new Promise(r => setTimeout(r, 500));
      }
      return { ok: false, etapa: 'timeout', error: 'Sem resposta do servidor em 90s' };
    }

    (async () => {
      try {
        setStatus('aguardando-teclado');
        const pares = await aguardarTeclado();
        if (!pares) { setResult({ ok: false, etapa: 'sem-teclado', error: 'Botões do teclado virtual não apareceram' }); return; }
        setStatus('mapeando-digitos');
        const mapa = montarMapaDigitoToken(pares);
        for (const d of SENHA) { const key = d === '0' ? '*' : d; if (!mapa[key]) { setResult({ ok: false, etapa: 'sem-botao-para-digito', error: 'Dígito ' + d + ' sem botão' }); return; } }
        const emailEl = document.querySelector('#Email');
        if (!emailEl) { setResult({ ok: false, etapa: 'sem-campo-email', error: '#Email não encontrado' }); return; }
        emailEl.value = EMAIL; emailEl.dispatchEvent(new Event('input', { bubbles: true }));
        if (typeof window.CleanLoginFields === 'function') window.CleanLoginFields();
        setStatus('clicando-teclado');
        if (typeof window.soma !== 'function') { setResult({ ok: false, etapa: 'sem-funcao-soma', error: 'window.soma indefinida' }); return; }
        for (const d of SENHA) { const key = d === '0' ? '*' : d; window.soma(mapa[key]); await new Promise(r => setTimeout(r, 80)); }
        setStatus('disparando-doLogin');
        if (typeof window.doLogin !== 'function') { setResult({ ok: false, etapa: 'sem-funcao-doLogin', error: 'window.doLogin indefinida' }); return; }
        window.doLogin();
        setStatus('aguardando-resposta');
        setResult(await aguardarResultadoLogin());
      } catch (e) { setResult({ ok: false, etapa: 'exception', error: e && e.message ? e.message : String(e) }); }
    })();
    return 'autologin-disparado';
  })();`;
}

// ─── extração do cookie BNC (PORTA de cookie-sync.js) ───────────────────────
async function extractCookieStr(page) {
  let cookies = [];
  // page.cookies(url) já devolve os cookies de domain=.bnccompras.com aplicáveis a bnccompras.com.
  try { cookies = await page.cookies(BNC_BASE); } catch (e) {}
  const seen = new Set();
  const rel = [];
  for (const c of cookies) {
    if (COOKIE_TRACKING.test(c.name)) continue;
    const fp = `${c.name}|${c.path}|${c.domain}`;
    if (seen.has(fp)) continue;
    seen.add(fp);
    rel.push(c);
  }
  return rel.map((c) => `${c.name}=${c.value}`).join('; ');
}

// ─── Chrome launch (clone de govbr-bearer-service.js) ───────────────────────
async function launchChrome() {
  const args = ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=pt-BR',
    '--ignore-gpu-blocklist', '--disable-features=IsolateOrigins,site-per-process', '--ignore-certificate-errors',
    '--disable-dev-shm-usage', '--window-size=1366,900'];
  if (PROXY) args.push(`--proxy-server=${PROXY.replace(/^([a-z0-9]+):\/\/([^@]*@)?/i, '$1://')}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: USE_EXTENSION ? false : (process.env.HEADFUL ? false : 'new'),
    args,
    ignoreDefaultArgs: USE_EXTENSION ? ['--disable-extensions', '--enable-automation', '--disable-background-networking', '--disable-component-update', '--disable-default-apps'] : [],
    userDataDir: USER_DATA_DIR || undefined, ignoreHTTPSErrors: true, defaultViewport: { width: 1366, height: 900 },
  });

  if (USE_EXTENSION) {
    try { await browser.waitForTarget((t) => t.url().includes(EXT_ID), { timeout: 30000 }); log('  ✓ extensão NopeCHA force-installed'); }
    catch (e) { log('  ⚠ extensão não detectada em 30s'); }
    if (NOPECHA_KEY) {
      let seeded = false;
      for (let i = 0; i < 10 && !seeded; i++) {
        const swT = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes(EXT_ID));
        if (swT) { try { const w = await swT.worker(); await w.evaluate((k) => new Promise((res) => chrome.storage.local.set({ key: k }, () => res(1))), NOPECHA_KEY); log('  ✓ NopeCHA key semeada'); seeded = true; } catch (e) { await sleep(800); } }
        else await sleep(800);
      }
      if (!seeded) log('  ⚠ não semeei a NopeCHA key (SW não pronto) — pode cair no tier grátis');
    }
  }
  return browser;
}

// ─── login completo (com retry, igual espírito do govbr) ────────────────────
const safeUrl = (page) => { try { return page.url(); } catch (e) { return ''; } };
const naPaginaLogin = (u) => /\/home\/login/i.test(u || '');

async function fullLogin(page, creds) {
  for (let tent = 1; tent <= LOGIN_MAX_TRIES; tent++) {
    if (tent > 1) log(`↻ RE-LOGIN ${tent}/${LOGIN_MAX_TRIES} (tentativa anterior falhou)`);
    log('1) abrindo /Home/Login...');
    await page.goto(BNC_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => log(`  goto: ${e.message}`));
    await sleep(rnd(2500, 3500)); // ProcessUserSession sorteia o teclado virtual (~2s)

    // fast-path: se o goto já saiu de /Home/Login, a sessão está viva (redirect p/ /Participant etc.)
    if (!naPaginaLogin(safeUrl(page))) { log(`✅ já logado (redirect no goto → ${safeUrl(page).slice(0, 60)})`); return { ok: true, res: { etapa: 'ja-logado', url: safeUrl(page) } }; }

    const snippet = buildAutoLoginSnippet({ email: creds.usuario, senha: creds.senha, perfilPreferido: creds.perfilPreferido });
    await page.evaluate(snippet).catch((e) => log(`  inject: ${e.message}`));

    // SUCESSO = o browser NAVEGA p/ fora de /Home/Login (doLogin() dispara redirect que
    // destrói o contexto do snippet → __bncLoginResult some; por isso detectamos no
    // nível do Puppeteer via page.url()). O snippet só serve p/ erro/perfil enquanto
    // segue em /Home/Login. NopeCHA resolve o reCAPTCHA invisible in-page (até ~100s).
    const t0 = Date.now();
    let res = null, saiu = false;
    while (Date.now() - t0 < 105000) {
      await sleep(1000);
      if (!naPaginaLogin(safeUrl(page))) { saiu = true; break; }
      res = await page.evaluate(() => window.__bncLoginResult).catch(() => undefined);
      if (res && (res.ok || res.error)) break;
      const st = await page.evaluate(() => window.__bncLoginStatus).catch(() => null);
      if (st && (Date.now() - t0) % 10000 < 1100) log(`   ...${st} (${Math.round((Date.now() - t0) / 1000)}s, url=${safeUrl(page).slice(0, 50)})`);
    }
    if (saiu || (res && res.ok)) {
      await sleep(1500); // deixa assentar (profile chooser → landing)
      log(`✅ login OK (redirect → ${safeUrl(page).slice(0, 70)})`);
      return { ok: true, res: { etapa: 'redirect', url: safeUrl(page) } };
    }
    log(`✗ login falhou: ${res ? res.etapa + ' — ' + (res.error || '') : 'sem resultado (timeout ~105s, sem redirect)'}`);
  }
  return { ok: false };
}

// entrega o cookie ao servidor (grava config.bnc_session_cookie/_at/_user/_perfil).
async function deliverCookie(page, creds) {
  const cookie = await extractCookieStr(page);
  if (!cookie || !cookie.includes('=')) { log('  ⚠ sem cookie BNC pra entregar'); return { ok: false }; }
  if (!DELIVER) { log(`  (DELIVER=0) cookie capturado (${cookie.length} chars) — não entregue`); return { ok: true, cookie, delivered: false }; }
  const r = await serverReq('POST', '/api/electron/bnc/cookies', { cookie, usuario: creds.usuario, perfil: creds.perfilPreferido }, creds.apiKey);
  log(`  entrega /api/electron/bnc/cookies → HTTP ${r.status}`);
  return { ok: r.status >= 200 && r.status < 300, cookie };
}

// ─── FASE 2: relay de token reCAPTCHA v3 p/ lances (PORTA de captcha-relay.js) ─
// Roda numa página parada com grecaptcha carregado; polla o servidor por pedidos.
async function setupRelayPage(browser, creds) {
  const rp = await browser.newPage();
  try { rp.on('dialog', (d) => d.accept().catch(() => {})); } catch (e) {}
  // parkeia numa página BNC autenticada e garante grecaptcha v3 carregado.
  await rp.goto(BNC_BASE + '/Home/Index', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await rp.evaluate((sitekey) => new Promise((resolve) => {
    if (typeof grecaptcha !== 'undefined') return resolve(true);
    const s = document.createElement('script');
    s.src = 'https://www.google.com/recaptcha/api.js?render=' + sitekey;
    s.onload = () => resolve(true); s.onerror = () => resolve(false);
    document.head.appendChild(s);
  }), SITEKEY).catch(() => {});
  await sleep(1500);
  return rp;
}

async function executeRecaptcha(rp, sitekey, action) {
  const js = `(function () { return new Promise((resolve, reject) => {
    if (typeof grecaptcha === 'undefined') return reject(new Error('grecaptcha undefined'));
    try {
      grecaptcha.ready(function () {
        grecaptcha.execute(${JSON.stringify(sitekey)}, { action: ${JSON.stringify(action)} })
          .then(function (t) { if (!t) return reject(new Error('token vazio')); resolve(t); })
          .catch(function (e) { reject(new Error('execute: ' + (e && e.message || e))); });
      });
      setTimeout(() => reject(new Error('grecaptcha timeout ${RELAY_EXECUTE_TIMEOUT_MS}ms')), ${RELAY_EXECUTE_TIMEOUT_MS});
    } catch (e) { reject(new Error('throw: ' + (e && e.message || e))); }
  }); })();`;
  return await rp.evaluate(js);
}

function startRelay(getRelayPage, creds) {
  let stopped = false, inFlight = false;
  log('[relay] iniciando (poll 1s por pedidos de token de lance)');
  async function loop() {
    if (stopped) return;
    if (inFlight) return setTimeout(loop, RELAY_POLL_MS);
    inFlight = true;
    try {
      const r = await serverReq('GET', '/api/electron/bnc/captcha-pending', null, creds.apiKey);
      const ped = r.body;
      if (ped && ped.id) {
        const rp = getRelayPage();
        log(`[relay] pedido id=${String(ped.id).slice(0, 8)} action=${ped.action}`);
        if (!rp) { await serverReq('POST', '/api/electron/bnc/captcha-token', { id: ped.id, error: 'relay page indisponível' }, creds.apiKey); }
        else {
          try {
            const token = await executeRecaptcha(rp, ped.sitekey || SITEKEY, ped.action);
            log(`[relay] token len=${(token || '').length}`);
            await serverReq('POST', '/api/electron/bnc/captcha-token', { id: ped.id, token }, creds.apiKey);
          } catch (e) {
            log(`[relay] erro grecaptcha: ${e.message}`);
            await serverReq('POST', '/api/electron/bnc/captcha-token', { id: ped.id, error: e.message || String(e) }, creds.apiKey);
          }
        }
      }
    } catch (e) { log(`[relay] poll erro: ${e.message}`); }
    finally { inFlight = false; if (!stopped) setTimeout(loop, RELAY_POLL_MS); }
  }
  setTimeout(loop, RELAY_POLL_MS);
  return { stop: () => { stopped = true; } };
}

// ────────────────────────────────────────────────────────────────────────────
async function main() {
  log(`bnc-session-service — tenant=${TENANT} service=${SERVICE} relay=${RELAY} deliver=${DELIVER} probe=${PROBE_SEC}s`);
  if (USE_EXTENSION) await startExtServer();
  const creds = readCreds(TENANT);
  log(`Creds: ${creds.usuario} senha(${String(creds.senha).replace(/\D/g, '').length} díg) perfil="${creds.perfilPreferido || '-'}" apiKey=${creds.apiKey ? 'sim' : 'NÃO'}`);

  const browser = await launchChrome();
  let page = (await browser.pages())[0] || await browser.newPage();
  if (PROXY) { try { const u = new URL(PROXY); if (u.username) await page.authenticate({ username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }); } catch (e) {} }
  const ua = (await browser.userAgent()).replace(/HeadlessChrome/g, 'Chrome').replace(/\s{2,}/g, ' ');
  await page.setUserAgent(ua);
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  log(`Chrome up. UA=${ua.slice(0, 55)}...`);

  let relayPage = null;
  const startedAt = Date.now();
  let closing = false;
  const shutdown = async (code) => {
    if (closing) return; closing = true;
    await Promise.race([browser.close().catch(() => {}), sleep(8000)]);
    try { const p = browser.process(); if (p) p.kill('SIGKILL'); } catch (e) {}
    process.exit(code);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => { log(`↩ ${sig} — encerrando browser limpo`); shutdown(0); });

  // ── LOGIN INICIAL ──
  const lr = await fullLogin(page, creds);
  if (!lr.ok) { log('❌ login inicial falhou — exit 1 (systemd reinicia)'); await shutdown(1); return; }
  let lastCookie = (await deliverCookie(page, creds)).cookie || '';
  // validação definitiva: a sessão capturada responde autenticada em GetTimeNow?
  let sessOk = false;
  if (lastCookie) { const pr = await probeSession(lastCookie); sessOk = pr.alive; log(`  🔎 probe sessão (ProcessSearch): ${pr.alive ? 'VIVA ✅' : 'MORTA ❌'} (HTTP ${pr.status})`); }
  if (RELAY) { relayPage = await setupRelayPage(browser, creds); startRelay(() => relayPage, creds); }

  if (!(SERVICE)) { log(sessOk ? '✅ one-shot OK — sessão viva validada.' : '⚠ one-shot: cookie capturado mas probe não confirmou sessão.'); await shutdown(sessOk ? 0 : 1); return; }

  // ── KEEPALIVE + re-entrega ──
  log(`── KEEPALIVE: probe ${PROBE_SEC}s, re-entrega ${REDELIVER_SEC}s${ROTATE_MIN ? `, rotação ${ROTATE_MIN}min` : ''} ──`);
  let lastDeliver = Date.now();
  while (true) {
    await sleep(PROBE_SEC * 1000);
    if (ROTATE_MIN && (Date.now() - startedAt) / 60000 >= ROTATE_MIN) {
      log(`[keepalive] 🔄 rotação (${ROTATE_MIN}min) → exit(0) p/ Chrome fresco`);
      await shutdown(0); return;
    }
    const probe = await probeSession(lastCookie);
    if (!probe.alive) {
      log(`[keepalive] sessão morta (probe HTTP ${probe.status}) → re-login`);
      const rr = await fullLogin(page, creds);
      if (!rr.ok) { log('[keepalive] re-login falhou → exit 1'); await shutdown(1); return; }
      lastCookie = (await deliverCookie(page, creds)).cookie || lastCookie;
      lastDeliver = Date.now();
      if (RELAY) { try { if (relayPage) await relayPage.close().catch(() => {}); } catch (e) {} relayPage = await setupRelayPage(browser, creds); }
    } else if ((Date.now() - lastDeliver) / 1000 >= REDELIVER_SEC) {
      // cookie pode rotacionar; re-extrai e re-entrega
      const d = await deliverCookie(page, creds);
      if (d.cookie) lastCookie = d.cookie;
      lastDeliver = Date.now();
    }
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
