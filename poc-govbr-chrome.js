'use strict';

/**
 * poc-govbr-chrome.js — POC (NÃO produção). Roda um Chrome REAL neste servidor
 * (via puppeteer-core + /usr/bin/google-chrome-stable, sob xvfb), faz o login
 * gov.br/Comprasnet do tenant, resolve o hCaptcha via NopeCHA Token API se
 * bloquear, e CAPTURA o Bearer JWT — pra medir empiricamente se datacenter +
 * solver funciona. Ver /root/.claude/plans/nested-bubbling-lollipop.md.
 *
 * Uso:
 *   NOPECHA_KEY=xxx xvfb-run -a node poc-govbr-chrome.js
 *   NOPECHA_KEY=xxx PROXY=http://user:pass@host:port xvfb-run -a node poc-govbr-chrome.js
 * Env: TENANT(=1bit) NOPECHA_KEY PROXY USER_DATA_DIR DELIVER(=0) SERVER_URL HEADFUL
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
const KEEPALIVE_MIN = parseInt(process.env.KEEPALIVE_MIN || '0', 10); // duração total do keepalive (0=off)
const RENEW_SEC = parseInt(process.env.RENEW_SEC || '240', 10);       // intervalo de re-mint (default 4min)
const USE_EXTENSION = process.env.USE_EXTENSION === '1';
const EXT_DIR = path.join(__dirname, 'nopecha-ext');
const SERVER_URL = process.env.SERVER_URL || 'https://1bit.liciteagora.app';
const CHROME = '/usr/bin/google-chrome-stable';
const BEARER_HOST = 'cnetmobile.estaleiro.serpro.gov.br';
const LOGIN_URL = 'https://www.comprasnet.gov.br/seguro/loginPortal.asp';
const SITEKEY_FALLBACK = '93b08d40-d46c-400a-ba07-6f91cda815b9';
const SHOTS = path.join(__dirname, 'poc-shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));
function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }

let SHOT_N = 0;
async function shot(page, name) {
  try {
    if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
    const f = path.join(SHOTS, `${String(++SHOT_N).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: f, fullPage: false });
    log(`  📸 ${f}`);
  } catch (e) { log(`  (shot ${name} falhou: ${e.message})`); }
}

// ─── credenciais do tenant (SQLite direto) ──────────────────────────────────
function readCreds(tenant) {
  const dbPath = path.join(__dirname, 'data', 'tenants', tenant, 'pncp.db');
  if (!fs.existsSync(dbPath)) throw new Error(`pncp.db não encontrado: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  const get = (k) => { const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k); return r ? r.valor : null; };
  const creds = { cpf: get('govbr_cpf'), senha: get('govbr_senha'), apiKey: get('api_key') };
  db.close();
  if (!creds.cpf || !creds.senha) throw new Error('govbr_cpf/govbr_senha não configurados no tenant');
  return creds;
}

// ─── NopeCHA Token API ──────────────────────────────────────────────────────
function nopechaReq(method, apiPath, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.nopecha.com', path: apiPath, method,
      headers: Object.assign({ Authorization: 'Basic ' + NOPECHA_KEY, Accept: 'application/json' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      timeout: 30000,
    }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: d.slice(0, 200) }); }); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (payload) req.write(payload); req.end();
  });
}
async function nopechaSolve(sitekey, url, rqdata) {
  if (!NOPECHA_KEY) return { ok: false, error: 'sem NOPECHA_KEY (defina a env pra resolver)' };
  const body = { key: NOPECHA_KEY, sitekey, url };
  if (rqdata) body.data = { rqdata };
  if (PROXY) { try { const u = new URL(PROXY); body.proxy = { scheme: u.protocol.replace(':', ''), host: u.hostname, port: Number(u.port), username: u.username || undefined, password: u.password || undefined }; } catch (e) {} }
  const sub = await nopechaReq('POST', '/v1/token/hcaptcha', body);
  log(`  NopeCHA submit → HTTP ${sub.status} ${sub.body ? JSON.stringify(sub.body).slice(0, 100) : sub.raw || sub.error}`);
  if (sub.status === 401) return { ok: false, error: 'API key inválida (401)' };
  if (sub.status === 402) return { ok: false, error: 'Token API fora do plano (402)' };
  if (sub.status === 403) return { ok: false, error: 'Sem crédito / IP banido (403)' };
  if (!sub.body || !sub.body.data) return { ok: false, error: `submit sem job id (HTTP ${sub.status})` };
  const jobId = sub.body.data;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    await sleep(1500);
    const r = await nopechaReq('GET', `/v1/token/hcaptcha?id=${encodeURIComponent(jobId)}&key=${encodeURIComponent(NOPECHA_KEY)}`, null);
    if (r.status === 409) continue;
    if (r.body && typeof r.body.data === 'string' && r.body.data.length > 10) return { ok: true, token: r.body.data };
    if (r.body && r.body.error) return { ok: false, error: r.body.error };
  }
  return { ok: false, error: 'timeout NopeCHA 120s' };
}

// ─── captura passiva do Bearer + compras-id (CDP em cada target) ────────────
const bearerState = { token: null, url: null };
let lastComprasId = null; // capturado de qualquer URL/redirect com compras-id= (igual reauth.js do Electron)
function scanComprasId(u) { if (!u) return; const m = u.match(/compras-id=([0-9a-f-]+)/i); if (m) lastComprasId = m[1]; }
async function attachBearerCapture(page) {
  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    client.on('Network.requestWillBeSent', (e) => {
      try {
        const url = (e.request && e.request.url) || '';
        scanComprasId(url);
        if (e.redirectResponse && e.redirectResponse.url) scanComprasId(e.redirectResponse.url);
        const h = (e.request && e.request.headers) || {};
        const auth = h.Authorization || h.authorization;
        if (url.includes(BEARER_HOST) && auth && /^Bearer /.test(auth) && auth !== bearerState.token) {
          bearerState.token = auth; bearerState.url = url;
          log(`  🔑 Bearer capturado (${auth.length} chars) em ${url.slice(0, 70)}`);
        }
      } catch (_) {}
    });
  } catch (e) { log(`  (attachCapture falhou: ${e.message})`); }
}

// ─── validação do Bearer (mesmo teste do sniper) ────────────────────────────
function validateBearer(token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: BEARER_HOST, path: '/comprasnet-disputa/v1/datahorabrasilia', method: 'GET',
      headers: { Authorization: token, Accept: 'application/json', 'x-device-platform': 'web', 'x-version-number': '6.0.0' },
      timeout: 15000,
    }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 120) })); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
}

function deliverBearer(token, apiKey) {
  return new Promise((resolve) => {
    const u = new URL(SERVER_URL + '/api/auth/token');
    const mod = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({ token, source: 'poc', timestamp: new Date().toISOString() });
    const req = mod.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Api-Key': apiKey } },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 200) })); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.write(payload); req.end();
  });
}

// ─── navegação do login (porta de auto-login.js) ────────────────────────────
async function expandirCardFornecedor(page) {
  return page.evaluate(() => {
    if (typeof mudaPerfilBotao === 'function') { try { mudaPerfilBotao(1); } catch (e) {} }
    const els = Array.from(document.querySelectorAll('button, a, div, [role="button"]'));
    const card = els.find((el) => /fornecedor brasileiro/i.test((el.textContent || '').trim()) && (el.textContent || '').length < 80);
    if (card) { card.click(); return 'card'; }
    const bf = document.querySelector('button.fornecedor, button.expand.fornecedor'); if (bf) { bf.click(); return 'button.fornecedor'; }
    return 'nao-achou-card';
  });
}
async function clickEntrarGovbr(page) {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
    const g = els.find((el) => { const t = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().toLowerCase(); return t.includes('entrar') && t.includes('gov'); });
    if (g) { g.click(); return 'govbtn'; }
    const l = document.querySelector('a[href*="acesso.gov.br"], a[href*="sso"]'); if (l) { l.click(); return 'link'; }
    return 'nao-achou';
  });
}
async function waitForURL(page, frag, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (page.url().includes(frag)) return true; await sleep(700); } return false; }

// ─── Re-auth SSO estilo Lancer (renova o Bearer SEM captcha) — porta de reauth.js ─
const SSO_AUTHORIZE_URL = 'https://sso.acesso.gov.br/authorize?response_type=code&client_id=comprasnet.gov.br&scope=openid+profile+email+phone+govbr_confiabilidades&state=F&redirect_uri=https://www.comprasnet.gov.br/seguro/landing_sso.asp';
const DISPENSA_URL = 'https://www.comprasnet.gov.br/assinadas/dispensa_eletronica.asp';

async function mouseJiggle(page) {
  try { for (let i = 0; i < 3; i++) { await page.mouse.move(rnd(100, 1200), rnd(100, 800), { steps: rnd(3, 8) }); await sleep(rnd(150, 400)); } } catch (e) {}
}

// re-navega o SSO (cookie gov.br ainda válido → sem captcha) e força um cnetmobile
// call que re-minta o Bearer. Retorna { reloginNeeded }.
async function reauth(page) {
  await page.goto(SSO_AUTHORIZE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(6000);
  const u = (() => { try { return page.url(); } catch (e) { return ''; } })();
  if (u.includes('acesso.gov.br/login') || u.includes('acesso-nao-autorizado')) return { reloginNeeded: true };
  await page.goto(DISPENSA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(3000);
  // compras-id: tenta DOM; senão usa o capturado via redirect no interceptor (mais confiável)
  const domId = await page.evaluate(() => { const el = document.getElementById('compras-id'); if (el) return el.value; const i = document.querySelector('input[name="compras-id"]'); return i ? i.value : null; }).catch(() => null);
  const cnetId = domId || lastComprasId;
  if (cnetId) { await page.goto(`https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras?compras-id=${cnetId}&compra=`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); await sleep(4000); }
  return { reloginNeeded: false, cnetId, src: domId ? 'dom' : (cnetId ? 'redirect' : 'none') };
}

async function main() {
  log(`POC gov.br — tenant=${TENANT} proxy=${PROXY ? 'SIM' : 'não'} nopecha=${NOPECHA_KEY ? 'SIM' : 'NÃO'} deliver=${DELIVER}`);
  const creds = readCreds(TENANT);
  log(`Creds lidas: CPF ***${creds.cpf.slice(-3)} senha(${creds.senha.length} chars) apiKey=${creds.apiKey ? 'sim' : 'não'}`);

  const args = ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=pt-BR',
    '--ignore-gpu-blocklist', '--disable-features=IsolateOrigins,site-per-process', '--ignore-certificate-errors',
    '--disable-dev-shm-usage', '--window-size=1366,900'];
  if (PROXY) args.push(`--proxy-server=${PROXY.replace(/^([a-z0-9]+):\/\/([^@]*@)?/i, '$1://')}`);
  if (USE_EXTENSION) log('extensão NopeCHA: via política do Chrome (force-install, sem --load-extension)');

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: USE_EXTENSION ? false : (process.env.HEADFUL ? false : 'new'),
    args,
    // Em modo extensão: remove flags do puppeteer que impediriam o force-install
    // (background-networking) ou disparam sinais de bot (enable-automation).
    ignoreDefaultArgs: USE_EXTENSION ? ['--disable-extensions', '--enable-automation', '--disable-background-networking', '--disable-component-update', '--disable-default-apps'] : [],
    userDataDir: USER_DATA_DIR || undefined, ignoreHTTPSErrors: true, defaultViewport: { width: 1366, height: 900 },
  });
  if (USE_EXTENSION) { try { await browser.waitForTarget((t) => t.url().includes('ogomknllijkjboianknlncoagialpnlm'), { timeout: 30000 }); log('  ✓ extensão NopeCHA force-installed'); } catch (e) { log('  ⚠ extensão não detectada em 30s'); } }
  browser.on('targetcreated', async (t) => { try { const p = await t.page(); if (p) await attachBearerCapture(p); } catch (e) {} });

  const page = (await browser.pages())[0] || await browser.newPage();
  // proxy auth (se user:pass no PROXY)
  if (PROXY) { try { const u = new URL(PROXY); if (u.username) await page.authenticate({ username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }); } catch (e) {} }
  const ua = (await browser.userAgent()).replace(/HeadlessChrome/g, 'Chrome').replace(/\s{2,}/g, ' ');
  await page.setUserAgent(ua);
  await attachBearerCapture(page);
  log(`Chrome up. UA=${ua.slice(0, 60)}...`);

  const result = { step: 'start', loggedIn: false, bearer: false };
  try {
    // 1) login page
    log('1) loginPortal...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => log(`  goto: ${e.message}`));
    await sleep(rnd(2500, 3500));
    await shot(page, 'login-portal');
    if (page.url().includes('cnetmobile') && !page.url().includes('acesso-nao-autorizado')) { log('  já logado!'); result.loggedIn = true; }

    if (!result.loggedIn) {
      // 2a) expandir card Fornecedor Brasileiro
      log('2) expandindo card Fornecedor + Entrar com Gov.br...');
      const exp = await expandirCardFornecedor(page); log(`  expand: ${exp}`);
      await sleep(rnd(1800, 2600));
      await shot(page, 'card-expandido');
      // 2b) Entrar com Gov.br
      const c = await clickEntrarGovbr(page); log(`  clique gov: ${c}`);
      // 3) SSO
      const atSSO = await waitForURL(page, 'acesso.gov.br', 30000);
      log(`  chegou acesso.gov.br? ${atSSO} (url=${page.url().slice(0, 60)})`);
      await sleep(rnd(6000, 8000));
      await shot(page, 'sso-cpf');

      // 4) CPF
      log('4) preenchendo CPF...');
      const cpfSel = await page.evaluate(() => { const ss = ['input[name="accountId"]', 'input#accountId', 'input[inputmode="numeric"]', 'input[type="text"]']; for (const s of ss) if (document.querySelector(s)) return s; return null; });
      if (cpfSel) {
        await page.click(cpfSel).catch(() => {});
        await page.type(cpfSel, creds.cpf, { delay: rnd(60, 140) });
        await sleep(rnd(700, 1300));
        await page.evaluate(() => { const b = document.querySelector('button[type="submit"]') || document.querySelector('input[type="submit"]') || document.querySelector('.btn-primary') || Array.from(document.querySelectorAll('button')).find((x) => { const t = (x.textContent || '').toLowerCase(); return t.includes('continuar') || t.includes('avançar') || t.includes('entrar'); }); if (b) b.click(); });
      } else { log('  ⚠ campo CPF não achado'); }
      await sleep(3500);
      await shot(page, 'apos-cpf');

      // 5) hCaptcha? espera senha
      log('5) aguardando campo de senha / detectando hCaptcha...');
      let temSenha = false;
      for (let i = 0; i < 15; i++) { temSenha = await page.evaluate(() => !!document.querySelector('input[type="password"]')); if (temSenha) break; if (page.url().includes('cnetmobile')) { result.loggedIn = true; break; } await sleep(1000); }

      if (!temSenha && !result.loggedIn) {
        // provável hCaptcha
        result.step = 'hcaptcha';
        const info = await page.evaluate(() => { let el = document.querySelector('[data-sitekey]'); let sk = el ? el.getAttribute('data-sitekey') : null; if (!sk) { const ifr = document.querySelector('iframe[src*="hcaptcha"]'); if (ifr) { const m = ifr.src.match(/sitekey=([0-9a-fA-F-]+)/); if (m) sk = m[1]; } } const dc = document.querySelector('[data-callback]'); return { sitekey: sk, callback: dc ? dc.getAttribute('data-callback') : null, hasIframe: !!document.querySelector('iframe[src*="hcaptcha"]') }; });
        log(`  hCaptcha: sitekey=${info.sitekey || SITEKEY_FALLBACK} iframe=${info.hasIframe} cb=${info.callback || '-'}`);
        await shot(page, 'hcaptcha');
        if (USE_EXTENSION) {
          log('  hCaptcha detectado — aguardando a extensão NopeCHA resolver o widget in-page (até ~150s)...');
          for (let i = 0; i < 50 && !temSenha && !result.loggedIn; i++) {
            await sleep(3000);
            // evaluate pode estourar "context destroyed" quando a extensão resolve e
            // a página navega — tratamos como "ainda navegando" e seguimos.
            temSenha = await page.evaluate(() => !!document.querySelector('input[type="password"]')).catch(() => false);
            const url = (() => { try { return page.url(); } catch (e) { return ''; } })();
            if (temSenha) { log(`  ✓ senha apareceu após ~${(i + 1) * 3}s — a extensão resolveu o widget!`); break; }
            if (url.includes('cnetmobile') || url.includes('comprasnet.gov.br/intro')) { result.loggedIn = true; break; }
            if (i % 5 === 0) { log(`    ...aguardando extensão (${(i + 1) * 3}s, url=${url.slice(0, 45)})`); await shot(page, `ext-${String(i).padStart(2, '0')}`).catch(() => {}); }
          }
          if (!temSenha && !result.loggedIn) { result.error = 'extensão NopeCHA não resolveu o hCaptcha em ~150s'; await shot(page, 'ext-timeout'); throw new Error(result.error); }
        } else {
        const sol = await nopechaSolve(info.sitekey || SITEKEY_FALLBACK, page.url(), null);
        if (!sol.ok) { result.error = 'NopeCHA: ' + sol.error; throw new Error(result.error); }
        log(`  token NopeCHA len=${sol.token.length} (${sol.token.slice(0, 4)})`);
        const inj = await page.evaluate((tk) => {
          let set = 0;
          document.querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"], #h-captcha-response, #g-recaptcha-response, [name="h-captcha-response"]').forEach((t) => { try { t.value = tk; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true })); set++; } catch (e) {} });
          // modo invisível: sobrescreve as APIs que o gov.br chama no submit pra
          // devolver nosso token em vez de abrir novo desafio.
          let over = false;
          try {
            if (window.hcaptcha) {
              window.hcaptcha.getResponse = function () { return tk; };
              window.hcaptcha.getRespKey = function () { return ''; };
              window.hcaptcha.execute = function () { return Promise.resolve({ response: tk, key: '' }); };
              try { window.hcaptcha.close && window.hcaptcha.close(); } catch (e) {}
              over = true;
            }
          } catch (e) {}
          const dc = document.querySelector('[data-callback]'); const cb = dc ? dc.getAttribute('data-callback') : null;
          let cbOk = false; if (cb && typeof window[cb] === 'function') { try { window[cb](tk); cbOk = true; } catch (e) {} }
          return { set, over, cbOk, cb };
        }, sol.token);
        log(`  injeção: textareas=${inj.set} hcaptchaOverride=${inj.over} callback=${inj.cb || '-'}(${inj.cbOk})`);
        await sleep(1500);
        // re-submeter o CPF (agora execute() devolve o token na hora)
        await page.evaluate(() => { const b = document.querySelector('button[type="submit"]') || document.querySelector('input[type="submit"]') || Array.from(document.querySelectorAll('button')).find((x) => { const t = (x.textContent || '').toLowerCase(); return t.includes('continuar') || t.includes('avançar') || t.includes('entrar'); }); if (b) b.click(); });
        await sleep(4000);
        await shot(page, 'apos-token');
        for (let i = 0; i < 15; i++) { temSenha = await page.evaluate(() => !!document.querySelector('input[type="password"]')); if (temSenha) break; if (page.url().includes('cnetmobile')) { result.loggedIn = true; break; } await sleep(1000); }
        }
      }

      // 6) senha
      if (temSenha) {
        log('6) digitando senha...');
        await page.click('input[type="password"]').catch(() => {});
        await page.type('input[type="password"]', creds.senha, { delay: rnd(60, 140) });
        await sleep(rnd(600, 1200));
        await page.evaluate(() => { const b = document.querySelector('button[type="submit"]') || document.querySelector('input[type="submit"]') || Array.from(document.querySelectorAll('button')).find((x) => { const t = (x.textContent || '').toLowerCase(); return t.includes('entrar') || t.includes('acessar') || t.includes('login'); }); if (b) b.click(); });
        await shot(page, 'apos-senha');
      }

      // 7) redirect pós-login
      log('7) aguardando redirect pós-login...');
      for (let i = 0; i < 60 && !result.loggedIn; i++) { const u = page.url(); if ((u.includes('comprasnet.gov.br/intro') || u.includes('comprasnet.gov.br/main') || (u.includes('comprasnet.gov.br/seguro/') && !u.includes('loginPortal') && !u.includes('landing_sso'))) || (u.includes('cnetmobile') && !u.includes('acesso-nao-autorizado'))) { result.loggedIn = true; break; } await sleep(1000); }
      log(`  loggedIn=${result.loggedIn} url=${page.url().slice(0, 70)}`);
    }

    // 8) disparar o Bearer
    if (result.loggedIn) {
      result.step = 'bearer';
      log('8) abrindo dispensa_eletronica.asp pra gerar o Bearer...');
      await page.goto('https://www.comprasnet.gov.br/assinadas/dispensa_eletronica.asp', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log(`  goto disp: ${e.message}`));
      for (let i = 0; i < 30 && !bearerState.token; i++) await sleep(1000);
      await shot(page, 'pos-dispensa');
    }

    // 9) validar
    if (bearerState.token) {
      result.bearer = true;
      log('9) validando Bearer...');
      const v = await validateBearer(bearerState.token);
      log(`  validação HTTP ${v.status} ${v.body || v.error || ''}`);
      result.valid = v.status === 200;
      if (DELIVER && result.valid) { const d = await deliverBearer(bearerState.token, creds.apiKey); log(`  entrega /api/auth/token → HTTP ${d.status} ${d.body}`); }
    }

    // ── KEEPALIVE: re-mint periódico SEM re-login (mede durabilidade da sessão) ──
    if (KEEPALIVE_MIN > 0 && result.bearer) {
      log(`── KEEPALIVE: ${KEEPALIVE_MIN}min, re-mint a cada ${RENEW_SEC}s (~${Math.floor(KEEPALIVE_MIN * 60 / RENEW_SEC)} ciclos), sem solve ──`);
      const kaStart = Date.now();
      let cycle = 0, fails = 0;
      while (Date.now() - kaStart < KEEPALIVE_MIN * 60000) {
        const chunks = Math.max(1, Math.floor(RENEW_SEC / 60));
        for (let c = 0; c < chunks; c++) { await mouseJiggle(page); await sleep((RENEW_SEC * 1000) / chunks); }
        cycle++;
        const prev = bearerState.token;
        const r = await reauth(page);
        const tmin = Math.round((Date.now() - kaStart) / 60000);
        if (r.reloginNeeded) { log(`[keepalive] ciclo ${cycle} t+${tmin}min: ⚠ SSO cookie MORREU → re-login (com captcha) necessário. FIM da sessão viva.`); break; }
        await sleep(2000);
        const fresh = bearerState.token && bearerState.token !== prev;
        const v = await validateBearer(bearerState.token);
        const okv = v.status === 200;
        fails = okv ? 0 : fails + 1;
        log(`[keepalive] ciclo ${cycle} t+${tmin}min: bearer=${fresh ? 'NOVO' : 'mesmo'} válido=${okv ? 'SIM 200' : 'NÃO ' + v.status} compras-id=${r.cnetId ? r.src : '-'}`);
        if (fails >= 2) { log('[keepalive] 2 validações falhas seguidas → sessão degradou, parando.'); break; }
      }
      log(`── KEEPALIVE fim: ${cycle} ciclos, sobreviveu ~${Math.round((Date.now() - kaStart) / 60000)}min sem re-login ──`);
    }
  } catch (e) {
    result.error = result.error || e.message;
    log(`❌ ERRO no passo '${result.step}': ${e.message}`);
    try { await shot(page, 'erro'); } catch (_) {}
  } finally {
    log('──────── RESULTADO ────────');
    if (result.bearer && result.valid) log(`✅ BEARER CAPTURADO e VÁLIDO (${bearerState.token.length} chars). Datacenter+POC FUNCIONOU 🎉`);
    else if (result.bearer) log(`⚠ Bearer capturado mas validação != 200. Ver logs.`);
    else if (result.loggedIn) log(`⚠ Logou mas não capturou Bearer (a dispensa não gerou token?). Ver poc-shots/.`);
    else log(`❌ Não logou. Parou em '${result.step}'${result.error ? ': ' + result.error : ''}. Ver poc-shots/.`);
    // exit garantido mesmo se browser.close() travar (evita node zumbi)
    const code = result.bearer && result.valid ? 0 : 1;
    await Promise.race([browser.close().catch(() => {}), sleep(8000)]);
    try { const proc = browser.process(); if (proc) proc.kill('SIGKILL'); } catch (e) {}
    process.exit(code);
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
