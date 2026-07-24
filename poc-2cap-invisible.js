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
let puppeteer = require('puppeteer-core');
if (process.env.USE_STEALTH === '1') {
  try {
    const { addExtra } = require('puppeteer-extra'); const pe = addExtra(require('puppeteer-core'));
    const stealth = require('puppeteer-extra-plugin-stealth')();
    // NÃO spoofar o WebGL: numa máquina com GPU REAL queremos que o renderizador
    // verdadeiro (AMD/Intel/NVIDIA) apareça — spoofar p/ "Intel" cria inconsistência
    // com os pixels reais e o hCaptcha flaga. Remove a evasão de WebGL.
    try { stealth.enabledEvasions.delete('webgl.vendor'); } catch (e) {}
    pe.use(stealth); puppeteer = pe; console.log('[stealth] plugin ativo (webgl.vendor OFF — GPU real)');
  } catch (e) { console.log('[stealth] indisponível (' + e.message + ') — puppeteer-core puro'); }
}
const Database = require('better-sqlite3');

const TENANT = process.env.TENANT || '1bit';
const NOPECHA_KEY = process.env.NOPECHA_KEY || '';
const PROXY = process.env.PROXY || '';
const USER_DATA_DIR = process.env.USER_DATA_DIR || '';
const DELIVER = process.env.DELIVER === '1';
const KEEPALIVE_MIN = parseInt(process.env.KEEPALIVE_MIN || '0', 10); // duração do keepalive (0=off, ignorado se SERVICE)
const SERVICE = process.env.SERVICE === '1';                          // modo serviço: keepalive INFINITO (até morte → systemd reinicia)
const RENEW_SEC = parseInt(process.env.RENEW_SEC || '180', 10);       // OBSOLETO: cadência agora é dirigida pelo TTL real do JWT (ver POLL_SEC/REMINT_TTL)
// ── keepalive zero-gap (TTL do JWT = 600s) ──
const POLL_SEC = parseInt(process.env.POLL_SEC || '20', 10);            // granularidade de amostragem do TTL
const REMINT_TTL = parseInt(process.env.REMINT_TTL || '300', 10);       // re-mintar quando faltar < isso (runway > pior caso de fullLogin)
const HARD_FLOOR = parseInt(process.env.HARD_FLOOR || '120', 10);       // < isso = emergência
const ROTATE_MIN = parseInt(process.env.ROTATE_MIN || '90', 10);        // rotação proativa do SSO antes da morte (~120min)
const FULLLOGIN_MAX_FAILS = parseInt(process.env.FULLLOGIN_MAX_FAILS || '3', 10); // após N re-logins falhos → exit p/ systemd
const USE_EXTENSION = process.env.USE_EXTENSION === '1';
const USE_RECOGNITION = process.env.USE_RECOGNITION === '1'; // resolvedor primário via Recognition API (extensão = fallback)
const MANUAL_CAPTCHA = process.env.MANUAL_CAPTCHA === '1'; // aguarda humano resolver o hCaptcha via VNC (nenhum solver de IA)
const MANUAL_WAIT_S = parseInt(process.env.MANUAL_WAIT_S || '360', 10);
const USE_2CAPTCHA = process.env.USE_2CAPTCHA === '1'; // resolve via 2Captcha token (rejeitado por PAT — NÃO usar)
const USE_2CAPTCHA_GRID = process.env.USE_2CAPTCHA_GRID === '1'; // 2Captcha GridTask IN-PAGE (humano diz quadros, nós clicamos no widget real)
const WEBGL_SPOOF = process.env.WEBGL_SPOOF === '1'; // falsifica UNMASKED_RENDERER/VENDOR (llvmpipe -> GPU real) p/ o fingerprint do hCaptcha
const PAT_DISABLE = process.env.PAT_DISABLE === '1'; // desabilita Private State Token (Privacy Pass) + bloqueia pst-issuer do hCaptcha
const USE_CERT = process.env.USE_CERT === '1'; // login por CERTIFICADO digital (e-CNPJ A1 no cofre NSS) — pula CPF+senha+hCaptcha
const TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_KEY || '';
const { solveHcaptcha } = require('./nopecha-recognition');
const { solveGrid2captcha, clickCellsAndVerify } = require('./grid2captcha');
const EXT_DIR = path.join(__dirname, 'nopecha-ext');
const SERVER_URL = process.env.SERVER_URL || 'https://1bit.liciteagora.app';
const CHROME = '/usr/bin/google-chrome-stable';
const BEARER_HOST = 'cnetmobile.estaleiro.serpro.gov.br';
const LOGIN_URL = 'https://www.comprasnet.gov.br/seguro/loginPortal.asp';
const SITEKEY_FALLBACK = '93b08d40-d46c-400a-ba07-6f91cda815b9';
const SHOTS = path.join(__dirname, 'poc-shots');
const EXT_SERVE_DIR = path.join(__dirname, 'nopecha-serve');

// ─── 2Captcha (worker humano) ───────────────────────────────────────────────
function tc2Req(pathn, body) {
  return new Promise((resolve) => {
    const p = JSON.stringify(body);
    const req = https.request({ hostname: 'api.2captcha.com', path: pathn, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) }, timeout: 30000 },
      (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: r.statusCode, body: j, raw: d.slice(0, 200) }); }); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.write(p); req.end();
  });
}
async function solve2captcha(pageurl, ua) {
  if (!TWOCAPTCHA_KEY) return { ok: false, error: 'sem TWOCAPTCHA_KEY' };
  const c = await tc2Req('/createTask', { clientKey: TWOCAPTCHA_KEY, task: { type: 'HCaptchaTaskProxyless', websiteURL: pageurl, websiteKey: SITEKEY_FALLBACK, isInvisible: true, userAgent: ua } });
  if (!c.body || c.body.errorId) return { ok: false, error: `createTask: ${c.body ? c.body.errorCode : c.raw}` };
  const id = c.body.taskId; const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    await sleep(5000);
    const r = await tc2Req('/getTaskResult', { clientKey: TWOCAPTCHA_KEY, taskId: id });
    if (r.body && r.body.status === 'ready') return { ok: true, token: r.body.solution.token || r.body.solution.gRecaptchaResponse, elapsedS: Math.round((Date.now() - t0) / 1000) };
    if (r.body && r.body.errorId) return { ok: false, error: `getResult: ${r.body.errorCode}` };
  }
  return { ok: false, error: 'timeout 150s' };
}
// falsifica o WebGL pra reportar GPU real (esconde llvmpipe/Mesa do servidor headless)
async function installWebglSpoof(pg) {
  try {
    await pg.evaluateOnNewDocument(() => {
      const spoof = { 37445: 'Intel Inc.', 37446: 'Intel Iris OpenGL Engine', 7936: 'WebKit', 7937: 'WebKit WebGL', 7938: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)' };
      for (const proto of [self.WebGLRenderingContext && WebGLRenderingContext.prototype, self.WebGL2RenderingContext && WebGL2RenderingContext.prototype]) {
        if (!proto) continue;
        const orig = proto.getParameter;
        proto.getParameter = function (p) { if (spoof[p] !== undefined) return spoof[p]; return orig.apply(this, arguments); };
      }
    });
  } catch (e) {}
}
// hook do hcaptcha.render pra capturar o callback que o gov.br registra (não é data-callback)
async function installHcapHook(pg) {
  try {
    await pg.evaluateOnNewDocument(() => {
      window.__hcapCbs = []; let store;
      try {
        Object.defineProperty(window, 'hcaptcha', { configurable: true, get() { return store; }, set(v) {
          try { if (v && v.render && !v.__wrapped) { const orig = v.render.bind(v); v.render = function (c, o) { try { if (o && typeof o.callback === 'function') window.__hcapCbs.push(o.callback); } catch (e) {} return orig(c, o); }; v.__wrapped = true; } } catch (e) {}
          store = v;
        } });
      } catch (e) {}
    });
  } catch (e) {}
}

// Servidor HTTP in-process p/ a política do Chrome force-installar a extensão
// (Chrome 146 bloqueia --load-extension). Serve nopecha-serve/ em 127.0.0.1:8899.
// Se a porta já estiver ocupada (outro server), segue em frente (idempotente).
function startExtServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const name = path.basename((req.url || '').split('?')[0]);
      const f = path.join(EXT_SERVE_DIR, name);
      if (!f.startsWith(EXT_SERVE_DIR)) { res.writeHead(403); return res.end(); }
      fs.readFile(f, (e, data) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(data); } });
    });
    srv.on('error', () => { log('[ext-server] porta 8899 já em uso — reusando server existente'); resolve(null); });
    srv.listen(8899, '127.0.0.1', () => { log('[ext-server] servindo extensão em 127.0.0.1:8899'); resolve(srv); });
  });
}

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
    // source='electron': prioridade top no sniper (setToken) — este serviço SUBSTITUI
    // o Electron no 1bit, então precisa ser autoritativo (senão um token velho de
    // prioridade maior bloquearia). Ver sniper-lance.js setToken (electron:3).
    const payload = JSON.stringify({ token, source: 'electron', timestamp: new Date().toISOString() });
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
  // INSTRUMENTADO: mede cada passo. domcontentloaded (minta) + dwell no cnetmobile.
  const before = bearerState.token;
  const t0 = Date.now();
  await page.goto(SSO_AUTHORIZE_URL, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
  const t1 = Date.now();
  await sleep(3000);
  const u = (() => { try { return page.url(); } catch (e) { return ''; } })();
  if (u.includes('acesso.gov.br/login') || u.includes('acesso-nao-autorizado')) return { reloginNeeded: true };
  await page.goto(DISPENSA_URL, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
  const t2 = Date.now();
  await sleep(2000);
  const domId = await page.evaluate(() => { const el = document.getElementById('compras-id'); if (el) return el.value; const i = document.querySelector('input[name="compras-id"]'); return i ? i.value : null; }).catch(() => null);
  const cnetId = domId || lastComprasId;
  let t3 = Date.now(), gotBearer = false;
  if (cnetId) {
    await page.goto(`https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras?compras-id=${cnetId}&compra=`, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
    t3 = Date.now();
    for (let d = 0; d < 30; d++) { await sleep(500); if (bearerState.token && bearerState.token !== before) { gotBearer = true; break; } }
  }
  const t4 = Date.now();
  log(`  [reauth] sso=${t1 - t0}ms disp=${t2 - t1}ms cnet_nav=${t3 - t2}ms dwell=${t4 - t3}ms(new=${gotBearer}) total=${Math.round((t4 - t0) / 1000)}s`);
  return { reloginNeeded: false, minted: gotBearer, cnetId, src: domId ? 'dom' : (cnetId ? 'redirect' : 'none') };
}

// exp (unixseconds) do JWT do Bearer, ou null.
function parseExp(bearer) {
  try {
    const jwt = String(bearer).replace(/^Bearer\s+/i, '');
    const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    return typeof p.exp === 'number' ? p.exp : null;
  } catch (e) { return null; }
}

// limpa cookies do Chrome (fura o short-circuit "já logado" → força SSO novo). A chave
// NopeCHA vive em chrome.storage.local (intocada); perfil é efêmero.
async function clearGovbrCookies(page) {
  try {
    const c = await page.target().createCDPSession();
    await c.send('Network.clearBrowserCookies');
    await c.detach().catch(() => {});
  } catch (e) { log(`  clearCookies falhou: ${e.message}`); }
}

async function main() {
  log(`govbr-bearer-service — tenant=${TENANT} service=${SERVICE} deliver=${DELIVER} poll=${POLL_SEC}s remint<${REMINT_TTL}s rotate=${ROTATE_MIN}min`);
  if (USE_EXTENSION) await startExtServer();
  const creds = readCreds(TENANT);
  log(`Creds lidas: CPF ***${creds.cpf.slice(-3)} senha(${creds.senha.length} chars) apiKey=${creds.apiKey ? 'sim' : 'não'}`);

  const disableFeat = 'IsolateOrigins,site-per-process' + (PAT_DISABLE ? ',PrivateStateTokens,TrustTokens,PrivacySandboxAdsAPIs,FledgeBiddingAndAuctionServer' : '');
  const args = ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=pt-BR',
    '--ignore-gpu-blocklist', `--disable-features=${disableFeat}`, '--ignore-certificate-errors',
    '--disable-dev-shm-usage', '--window-size=1366,900',
    '--enable-gpu-rasterization', '--enable-accelerated-2d-canvas', '--enable-webgl'];
  if (process.platform === 'win32' && process.env.SWIFTSHADER !== '1') args.push('--use-angle=d3d11'); // usa a GPU real via D3D11 no Windows
  if (process.env.SWIFTSHADER === '1') args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  if (PROXY) args.push(`--proxy-server=${PROXY.replace(/^([a-z0-9]+):\/\/([^@]*@)?/i, '$1://')}`);
  if (USE_EXTENSION) log('extensão NopeCHA: via política do Chrome (force-install, sem --load-extension)');

  const CLEAN = process.env.CLEAN_CHROME === '1';
  let browser;
  if (CLEAN) {
    // Launch "limpo" tipo Chrome de usuário: SEM flags de automação, isolamento de
    // sites LIGADO (não desliga IsolateOrigins/site-per-process), sem AutomationControlled.
    const cleanArgs = ['--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-dev-shm-usage', '--window-size=1366,900', '--lang=pt-BR', '--remote-debugging-port=0'];
    if (PROXY) cleanArgs.push(`--proxy-server=${PROXY.replace(/^([a-z0-9]+):\/\/([^@]*@)?/i, '$1://')}`);
    log('[clean] Chrome mínimo — sem flags de automação, isolamento de sites LIGADO');
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: false, args: cleanArgs,
      ignoreDefaultArgs: true,
      userDataDir: USER_DATA_DIR || path.join(__dirname, '.govbr-clean-profile'),
      ignoreHTTPSErrors: true, defaultViewport: { width: 1366, height: 900 },
    });
  } else {
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: USE_EXTENSION ? false : (process.env.HEADFUL ? false : 'new'),
      args,
      // Em modo extensão: remove flags do puppeteer que impediriam o force-install
      // (background-networking) ou disparam sinais de bot (enable-automation).
      ignoreDefaultArgs: USE_EXTENSION ? ['--disable-extensions', '--enable-automation', '--disable-background-networking', '--disable-component-update', '--disable-default-apps'] : [],
      userDataDir: USER_DATA_DIR || undefined, ignoreHTTPSErrors: true, defaultViewport: { width: 1366, height: 900 },
    });
  }
  if (USE_EXTENSION) { try { await browser.waitForTarget((t) => t.url().includes('ogomknllijkjboianknlncoagialpnlm'), { timeout: 30000 }); log('  ✓ extensão NopeCHA force-installed'); } catch (e) { log('  ⚠ extensão não detectada em 30s'); } }
  // Semeia a API key paga no chrome.storage.local da extensão (campo "key"). Este
  // build da NopeCHA IGNORA nopecha.key do manifest em runtime e só lê do storage;
  // sem isso cai no tier grátis e o solve emperra quando a cota esgota. Semear no
  // startup (o SW pega a mudança ao vivo) deixa o serviço stateless — funciona com
  // perfil efêmero, sem depender de um perfil persistente que pode ser apagado.
  if (USE_EXTENSION && NOPECHA_KEY) {
    let seeded = false;
    for (let i = 0; i < 10 && !seeded; i++) {
      const swT = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('ogomknllijkjboianknlncoagialpnlm'));
      if (swT) {
        try {
          const worker = await swT.worker();
          await worker.evaluate((k) => new Promise((res) => chrome.storage.local.set({ key: k }, () => res(1))), NOPECHA_KEY);
          log('  ✓ NopeCHA key semeada no storage da extensão');
          seeded = true;
        } catch (e) { await sleep(800); }
      } else { await sleep(800); }
    }
    if (!seeded) log('  ⚠ não consegui semear a NopeCHA key (SW não pronto) — pode cair no tier grátis');
  }
  browser.on('targetcreated', async (t) => { try { const p = await t.page(); if (p) await attachBearerCapture(p); } catch (e) {} });

  let page = (await browser.pages())[0] || await browser.newPage();
  // proxy auth (se user:pass no PROXY)
  if (PROXY) { try { const u = new URL(PROXY); if (u.username) await page.authenticate({ username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }); } catch (e) {} }
  const ua = (await browser.userAgent()).replace(/HeadlessChrome/g, 'Chrome').replace(/\s{2,}/g, ' ');
  if (USE_2CAPTCHA) await installHcapHook(page);
  if (WEBGL_SPOOF) await installWebglSpoof(page);
  if (PAT_DISABLE) { try { const cdp = await page.target().createCDPSession(); await cdp.send('Network.enable'); await cdp.send('Network.setBlockedURLs', { urls: ['*pst-issuer.hcaptcha.com*', '*pst.hcaptcha.com*', '*private-state-token*', '*/pat/*'] }); log('  [pat] pst-issuer/PAT bloqueado (CDP)'); } catch (e) { log('  [pat] block falhou: ' + e.message); } }
  await page.setUserAgent(ua);
  await attachBearerCapture(page);
  // auto-aceita diálogos (beforeunload etc). Sem isso, ao sair de uma página
  // autenticada do comprasnet (no re-login/rotação) o beforeunload TRAVA o page.goto.
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  log(`Chrome up. UA=${ua.slice(0, 60)}...`);
  // Diagnóstico GPU: mostra qual renderer o Chrome DESTE processo realmente usa.
  // Se aparecer SwiftShader/llvmpipe/Software = render por software → hCaptcha difícil
  // rejeita (ERL0000900). Precisa aparecer o nome da GPU real (AMD/Intel/NVIDIA D3D11).
  try {
    const gpu = await page.evaluate(() => {
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        if (!gl) return 'sem-webgl';
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const r = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        const v = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        return v + ' | ' + r;
      } catch (e) { return 'erro:' + e.message; }
    });
    const soft = /swiftshader|llvmpipe|software|mesa|basic render/i.test(gpu);
    log(`[gpu] WebGL renderer: ${gpu}  ${soft ? '⚠ SOFTWARE — hCaptcha difícil vai REJEITAR (ERL)' : '✓ GPU real'}`);
  } catch (e) { log('[gpu] não consegui ler o renderer: ' + e.message); }

  // ── estado + helpers zero-gap (fecham sobre page/creds/browser) ──
  let lastGood = null;                 // { token, exp } — ÚNICA fonte da verdade entregue
  let lastFullLoginAt = 0, fullLoginFails = 0;

  const shutdown = async (code) => {
    await Promise.race([browser.close().catch(() => {}), sleep(8000)]);
    try { const proc = browser.process(); if (proc) proc.kill('SIGKILL'); } catch (e) {}
    process.exit(code);
  };
  // Fecha o browser em qualquer encerramento por sinal (stop/restart do systemd = SIGTERM;
  // Ctrl-C / fechar terminal em teste = SIGINT/SIGHUP). Sem isto o Node morria na hora e
  // deixava Chrome + Xvfb órfãos + o cat do xvfb-run como zumbi.
  let closing = false;
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(sig, () => {
      if (closing) return;
      closing = true;
      log(`↩ ${sig} recebido — encerrando browser limpo`);
      shutdown(0);
    });
  }
  // ÚNICO escritor de lastGood: só entrega token válido (200) com TTL > 15s.
  const promoteAndDeliver = async (cand) => {
    if (!cand) return false;
    const exp = parseExp(cand);
    if (!exp || exp * 1000 - Date.now() < 15000) return false;
    const v = await validateBearer(cand);
    if (v.status !== 200) return false;
    lastGood = { token: cand, exp };
    if (DELIVER) { const d = await deliverBearer(cand, creds.apiKey); log(`  entrega /api/auth/token → HTTP ${d.status}`); }
    return true;
  };
  // re-mint barato via reauth (sem captcha). Só entrega se veio token NOVO e válido.
  const attemptRemint = async () => {
    const before = lastGood ? lastGood.token : bearerState.token;
    const r = await reauth(page);
    if (r.reloginNeeded) return { ok: false, reason: 'cookie-morto' };
    if (!r.minted) return { ok: false, reason: 'stall-sem-mint' };
    const cand = bearerState.token;
    if (!cand || cand === before) return { ok: false, reason: 'sem-novo' };
    return { ok: await promoteAndDeliver(cand), reason: 'mint-invalido' };
  };
  // login gov.br completo (com captcha) reaproveitável — inicial E re-login in-process.
  const fullLogin = async (opts = {}) => {
    const result = { step: 'start', loggedIn: false, error: null };
    if (opts.forceFresh) {
      // re-login numa ABA NOVA: CDP/página limpos, sem beforeunload nem estado
      // autenticado stale. Limpar cookie na página atual travava o page.goto seguinte
      // (passava do timeout). A aba nova replica a condição do login inicial (confiável).
      const np = await browser.newPage();
      try { if (USE_2CAPTCHA) await installHcapHook(np); if (WEBGL_SPOOF) await installWebglSpoof(np); await np.setUserAgent(ua); } catch (e) {}
      np.on('dialog', (d) => { d.accept().catch(() => {}); });
      await attachBearerCapture(np);
      await clearGovbrCookies(np);
      const old = page;
      page = np;
      if (old) old.close().catch(() => {});
      log('  (forceFresh) aba nova + cookies limpos → SSO novo');
    }
    const before = bearerState.token;
    try {
    // RETRY do login: a challenge do hCaptcha às vezes emperra (~25%). Recarrega a
    // página e tenta uma challenge nova, até 3x, antes de desistir.
    for (let loginTry = 1; loginTry <= 3 && !result.loggedIn; loginTry++) {
    if (loginTry > 1) log(`↻ RE-LOGIN ${loginTry}/3 (solve anterior emperrou) — recarregando...`);
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

      // 4) CERTIFICADO digital (pula CPF/senha/hCaptcha) OU CPF
      if (USE_CERT) {
        log('4) CAPTURA token hCaptcha NATIVO (NopeCHA in-page) p/ o cert POST (Node)...');
        const authIdC = (page.url().match(/authorization_id=([a-z0-9]+)/i) || [])[1];
        const csrfC = await page.evaluate(() => { const el = document.querySelector('input[name="_csrf"]'); return el ? el.value : null; }).catch(() => null);
        log(`  authId=${authIdC} csrf=${csrfC ? csrfC.slice(0, 10) + '…' : 'NÃO'}`);
        // dispara o hCaptcha invisível; NopeCHA resolve in-page → token com PAT nativo
        await page.evaluate(() => { try { if (window.hcaptcha && hcaptcha.execute) hcaptcha.execute(); } catch (e) {} }).catch(() => {});
        let hcToken = null;
        for (let i = 0; i < 60 && !hcToken; i++) {
          await sleep(2000);
          hcToken = await page.evaluate(() => { const t = document.querySelector('textarea[name="h-captcha-response"], #h-captcha-response'); return t && t.value ? t.value : null; }).catch(() => null);
          if (i % 5 === 0) log(`    ...aguardando NopeCHA (${(i + 1) * 2}s)`);
          if (i === 20 || i === 40) await page.evaluate(() => { try { hcaptcha.execute(); } catch (e) {} }).catch(() => {});
        }
        log(`  h-captcha: ${hcToken ? hcToken.length + ' chars ' + hcToken.slice(0, 4) : 'NÃO resolveu'}`);
        const cdpC = await page.target().createCDPSession();
        const cookiesC = (await cdpC.send('Network.getAllCookies')).cookies;
        require('fs').writeFileSync('/tmp/certtok.json', JSON.stringify({ authId: authIdC, csrf: csrfC, hcToken, cookies: cookiesC.map((c) => ({ name: c.name, value: c.value, domain: c.domain })) }));
        log(`  ✓ dump /tmp/certtok.json (${cookiesC.length} cookies, token=${!!hcToken})`);
        result.loggedIn = true; // pula o resto; o POST mTLS é no Node
        await shot(page, 'apos-cert');
      } else {
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
      }

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
        if (MANUAL_CAPTCHA && !temSenha && !result.loggedIn) {
          log(`  🖐️  MANUAL: resolva o hCaptcha na tela (VNC). Aguardando até ${MANUAL_WAIT_S}s...`);
          for (let i = 0; i < Math.ceil(MANUAL_WAIT_S / 3) && !temSenha && !result.loggedIn; i++) {
            await sleep(3000);
            temSenha = await page.evaluate(() => !!document.querySelector('input[type="password"]')).catch(() => false);
            const u = (() => { try { return page.url(); } catch (e) { return ''; } })();
            if (temSenha) { log(`  ✓ senha apareceu após ~${(i + 1) * 3}s — captcha resolvido manualmente!`); break; }
            if ((u.includes('comprasnet.gov.br/intro') || u.includes('comprasnet.gov.br/main') || (u.includes('comprasnet.gov.br/seguro/') && !u.includes('loginPortal') && !u.includes('landing_sso'))) || (u.includes('cnetmobile') && !u.includes('acesso-nao-autorizado'))) { log(`  ✓ logou (redirect ${u.slice(0, 50)}) — via QR/senha!`); result.loggedIn = true; break; }
            if (i % 10 === 0) { log(`    ...aguardando solve manual (${(i + 1) * 3}s)`); await shot(page, `manual-${String(i).padStart(2, '0')}`).catch(() => {}); }
          }
          if (!temSenha && !result.loggedIn) { result.error = `solve manual não concluído (${MANUAL_WAIT_S}s)`; log('  ⚠ tempo de solve manual esgotado'); }
        }
        if (USE_2CAPTCHA_GRID && !temSenha && !result.loggedIn) {
          log('  hCaptcha — resolvendo via 2Captcha GridTask (in-page)...');
          for (let round = 0; round < 10 && !temSenha && !result.loggedIn; round++) {
            const gr = await solveGrid2captcha(page, { key: TWOCAPTCHA_KEY, log }).catch((e) => ({ ok: false, error: e.message }));
            if (!gr.ok) { log(`  [grid] falhou round ${round + 1}: ${gr.error}`); result.error = 'gridtask: ' + gr.error; break; }
            await clickCellsAndVerify(gr.frame, gr.cells, log);
            await sleep(2500);
            let erl = false;
            for (let i = 0; i < 10 && !temSenha && !result.loggedIn; i++) {
              await sleep(1500);
              const st = await page.evaluate(() => ({ pass: !!document.querySelector('input[type="password"]'), url: location.href, erl: /ERL0000900|Captcha inválid/i.test(document.body.innerText || '') })).catch(() => ({}));
              temSenha = !!st.pass; erl = !!st.erl;
              if (st.url && (st.url.includes('cnetmobile') || st.url.includes('comprasnet.gov.br/intro'))) { result.loggedIn = true; break; }
              if (erl) break;
            }
            if (temSenha || result.loggedIn) { log('  ✓✓✓ GridTask ACEITO — senha apareceu (in-page solve passou)!'); await shot(page, 'grid-ok'); break; }
            if (erl) { log('  ⚠ GridTask → ERL0000900 (fingerprint/PAT) — re-login'); result.error = 'gridtask ERL0000900'; break; }
            log(`  [grid] round ${round + 1}: sem senha/sem ERL — provável nova challenge, re-solvendo...`);
          }
          if (!temSenha && !result.loggedIn && !result.error) result.error = 'gridtask não resolveu';
        }
        if (USE_2CAPTCHA && !temSenha && !result.loggedIn) {
          log('  hCaptcha — resolvendo via 2Captcha (worker humano)...');
          const sol = await solve2captcha(page.url(), ua);
          if (sol.ok) {
            const inj = await page.evaluate((tk) => {
              let set = 0;
              document.querySelectorAll('textarea[name="h-captcha-response"], #h-captcha-response, textarea[name="g-recaptcha-response"]').forEach((t) => { try { t.value = tk; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true })); set++; } catch (e) {} });
              try { if (window.hcaptcha) { window.hcaptcha.getResponse = () => tk; window.hcaptcha.execute = () => Promise.resolve({ response: tk, key: '' }); } } catch (e) {}
              let cbFired = 0; try { (window.__hcapCbs || []).forEach((fn) => { try { fn(tk); cbFired++; } catch (e) {} }); } catch (e) {}
              return { set, cbFired, hooked: (window.__hcapCbs || []).length };
            }, sol.token);
            log(`  2Captcha ok em ${sol.elapsedS}s — injeção: textareas=${inj.set} cbFired=${inj.cbFired}/${inj.hooked}; submetendo...`);
            await sleep(700);
            await page.evaluate(() => { const b = document.querySelector('button[type="submit"]') || Array.from(document.querySelectorAll('button')).find((x) => /continuar/i.test(x.textContent || '')); if (b) b.click(); }).catch(() => {});
            let erl = false;
            for (let i = 0; i < 12 && !temSenha && !result.loggedIn && !erl; i++) {
              await sleep(1500);
              const st = await page.evaluate(() => ({ pass: !!document.querySelector('input[type="password"]'), url: location.href, erl: /ERL0000900|Captcha inválid/i.test(document.body.innerText || '') })).catch(() => ({}));
              temSenha = !!st.pass; erl = !!st.erl;
              if (st.url && (st.url.includes('cnetmobile') || st.url.includes('comprasnet.gov.br/intro'))) { result.loggedIn = true; break; }
            }
            if (temSenha || result.loggedIn) { log('  ✓✓ captcha 2Captcha ACEITO!'); await shot(page, '2cap-ok'); }
            else { result.error = erl ? '2captcha ERL0000900 (PAT) — re-login' : '2captcha sem senha — re-login'; log('  ⚠ ' + result.error); }
          } else { result.error = '2captcha: ' + sol.error; log('  ⚠ ' + result.error); }
        }
        if (USE_RECOGNITION && !temSenha && !result.loggedIn) {
          log('  hCaptcha — tentando Recognition API (primário)...');
          const rec = await solveHcaptcha(page, { key: NOPECHA_KEY, log, shot }).catch((e) => ({ ok: false, error: e.message }));
          if (rec.ok) { temSenha = await page.evaluate(() => !!document.querySelector('input[type="password"]')).catch(() => false); log(`  ✓ Recognition resolveu o hCaptcha (senha=${temSenha})`); await shot(page, 'rec-ok'); }
          else log(`  ⚠ Recognition falhou: ${rec.error} — caindo pro fallback (extensão)`);
        }
        if (USE_EXTENSION && !temSenha && !result.loggedIn) {
          log('  hCaptcha detectado — aguardando a extensão NopeCHA resolver o widget in-page (até ~120s; senão re-loga)...');
          for (let i = 0; i < 40 && !temSenha && !result.loggedIn; i++) {
            await sleep(3000);
            // evaluate pode estourar "context destroyed" quando a extensão resolve e
            // a página navega — tratamos como "ainda navegando" e seguimos.
            temSenha = await page.evaluate(() => !!document.querySelector('input[type="password"]')).catch(() => false);
            const url = (() => { try { return page.url(); } catch (e) { return ''; } })();
            if (temSenha) { log(`  ✓ senha apareceu após ~${(i + 1) * 3}s — a extensão resolveu o widget!`); break; }
            if (url.includes('cnetmobile') || url.includes('comprasnet.gov.br/intro')) { result.loggedIn = true; break; }
            // aos ~120s, se ainda travado, re-clica Continuar → challenge nova (outra chance p/ a extensão)
            if (i === 40) { log('    ...challenge emperrou; re-disparando (nova challenge)'); await page.evaluate(() => { const b = document.querySelector('button[type="submit"]') || Array.from(document.querySelectorAll('button')).find((x) => { const t = (x.textContent || '').toLowerCase(); return t.includes('continuar') || t.includes('entrar') || t.includes('avan'); }); if (b) b.click(); }).catch(() => {}); }
            if (i % 5 === 0) { log(`    ...aguardando extensão (${(i + 1) * 3}s, url=${url.slice(0, 45)})`); await shot(page, `ext-${String(i).padStart(2, '0')}`).catch(() => {}); }
          }
          if (!temSenha && !result.loggedIn) { result.error = 'solve emperrou (~120s)'; await shot(page, 'ext-timeout'); log('  ⚠ solve emperrou — recarrega e re-tenta o login'); }
        } else if (!temSenha && !result.loggedIn && !MANUAL_CAPTCHA && !USE_2CAPTCHA && !USE_2CAPTCHA_GRID) {
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

      // 7) redirect pós-login — só espera se a senha foi submetida (temSenha) OU já logou.
      // Se o solve emperrou (sem senha), não há redirect pra esperar: pula os 60s ociosos
      // e re-tenta já → mais tentativas por minuto = recupera mais rápido no streak de solve.
      if (temSenha || result.loggedIn) {
        log('7) aguardando redirect pós-login...');
        for (let i = 0; i < 60 && !result.loggedIn; i++) { const u = page.url(); if ((u.includes('comprasnet.gov.br/intro') || u.includes('comprasnet.gov.br/main') || (u.includes('comprasnet.gov.br/seguro/') && !u.includes('loginPortal') && !u.includes('landing_sso'))) || (u.includes('cnetmobile') && !u.includes('acesso-nao-autorizado'))) { result.loggedIn = true; break; } await sleep(1000); }
        log(`  loggedIn=${result.loggedIn} url=${page.url().slice(0, 70)}`);
      } else {
        log('  (solve emperrou — pulando espera de redirect, re-tentando já)');
      }
    }
    } // fim do retry de login (até 3x)
    if (!result.loggedIn) return { loggedIn: false, token: null, error: result.error || 'login falhou após 3 tentativas' };
    // 8) disparar o Bearer — MESMO caminho do reauth (dispensa → lê compras-id →
    // cnetmobile/compras). Antes só abria a dispensa e torcia pro XHR do Bearer disparar
    // sozinho → às vezes não disparava ("bearer não capturado", ~1 em cada N re-logins).
    // O que REALMENTE dispara o Bearer é navegar pra página cnetmobile/compras?compras-id=X.
    result.step = 'bearer';
    log('8) disparando o Bearer (dispensa → compras-id → cnetmobile)...');
    for (let tent = 1; tent <= 2 && (!bearerState.token || bearerState.token === before); tent++) {
      await page.goto(DISPENSA_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch((e) => log(`  goto disp: ${e.message}`));
      await sleep(2000);
      const domId = await page.evaluate(() => { const el = document.getElementById('compras-id'); if (el) return el.value; const i = document.querySelector('input[name="compras-id"]'); return i ? i.value : null; }).catch(() => null);
      const cnetId = domId || lastComprasId;
      log(`  compras-id=${cnetId || 'não achado'}${tent > 1 ? ` (retry ${tent})` : ''}`);
      if (cnetId) {
        await page.goto(`https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras?compras-id=${cnetId}&compra=`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }
      for (let i = 0; i < 30 && (!bearerState.token || bearerState.token === before); i++) await sleep(500);
    }
    await shot(page, 'pos-dispensa');
    } catch (e) {
      log(`  ❌ fullLogin erro '${result.step}': ${e.message}`);
      try { await shot(page, 'erro'); } catch (_) {}
    }
    const tk = (bearerState.token && bearerState.token !== before) ? bearerState.token : null;
    return { loggedIn: result.loggedIn, token: tk, error: tk ? null : (result.error || 'bearer não capturado') };
  }; // ── fim fullLogin ──

  const doFullLogin = async (forceFresh) => {
    // top-up: cobre o servidor durante o login bloqueante se o token entregue está baixo
    if (lastGood && lastGood.exp * 1000 - Date.now() < REMINT_TTL * 1000) { try { await attemptRemint(); } catch (e) {} }
    const r = await fullLogin({ forceFresh });
    if (r.loggedIn && await promoteAndDeliver(r.token)) { fullLoginFails = 0; lastFullLoginAt = Date.now(); return true; }
    fullLoginFails++;
    log(`[keepalive] fullLogin falhou (${fullLoginFails}/${FULLLOGIN_MAX_FAILS}) err=${r.error || '-'}`);
    if (fullLoginFails >= FULLLOGIN_MAX_FAILS) { log('[keepalive] MAX_FAILS → fallback systemd (exit 1)'); await shutdown(1); }
    return false;
  };

  const boot = { loggedIn: false, valid: false, error: null };
  try {
    // ── LOGIN INICIAL (mesmo caminho do re-login) ──
    const r0 = await fullLogin({ forceFresh: false });
    boot.loggedIn = r0.loggedIn;
    if (!r0.loggedIn) { boot.error = r0.error; throw new Error(r0.error || 'login inicial falhou'); }
    boot.valid = await promoteAndDeliver(r0.token);
    if (!boot.valid) { boot.error = 'bearer inicial inválido/não capturado'; throw new Error(boot.error); }
    lastFullLoginAt = Date.now();
    log(`✅ Login inicial OK — Bearer válido entregue (TTL ${Math.round(lastGood.exp - Date.now() / 1000)}s).`);

    // ── KEEPALIVE zero-gap (dirigido pelo TTL real do JWT) ──
    if (SERVICE || KEEPALIVE_MIN > 0) {
      log(`── KEEPALIVE: ${SERVICE ? 'SERVIÇO (infinito)' : KEEPALIVE_MIN + 'min'} — poll ${POLL_SEC}s, re-mint<${REMINT_TTL}s, rotação ${ROTATE_MIN}min ──`);
      const kaStart = Date.now();
      while (SERVICE || Date.now() - kaStart < KEEPALIVE_MIN * 60000) {
        const now = Date.now();
        const ttl = lastGood ? (lastGood.exp * 1000 - now) / 1000 : -1;
        const elapsedMin = (now - lastFullLoginAt) / 60000;
        if (ttl >= 0 && ttl < HARD_FLOOR) {
          log(`[keepalive] ⚠ EMERGÊNCIA ttl=${Math.round(ttl)}s`);
          const rr = await attemptRemint();
          if (!rr.ok) await doFullLogin(true); else log('[keepalive] re-mint emergencial OK');
        } else if (elapsedMin >= ROTATE_MIN) {
          // Rotação = RECICLAR o Chrome (o re-login in-process/aba-nova NÃO libera os
          // renderers acumulados → count cresce ~+20/h sem limite). Restart do processo
          // dá Chrome fresco + SSO novo. Zero-gap: top-up do token (fresco ~597s) cobre os
          // ~50s do restart; systemd (Restart=always) reinicia no exit.
          log(`[keepalive] 🔄 rotação (${Math.round(elapsedMin)}min sessão) ttl=${Math.round(ttl)}s — top-up + restart p/ reciclar Chrome`);
          await attemptRemint();
          log('[keepalive] → exit(0) p/ systemd reiniciar (Chrome fresco + SSO novo)');
          await shutdown(0);
        } else if (ttl < REMINT_TTL) {
          const rr = await attemptRemint();
          if (rr.ok) log(`[keepalive] re-mint OK ttl=${Math.round((lastGood.exp * 1000 - Date.now()) / 1000)}s`);
          else { log(`[keepalive] reauth falhou (${rr.reason}) ttl=${Math.round(ttl)}s → fullLogin proativo`); await doFullLogin(true); }
        }
        // idle: só sleep. mouseJiggle (page.mouse.move) TRAVA na SPA do cnetmobile e
        // congelava o loop — o anti-idle não vale o risco num serviço zero-gap.
        await sleep(POLL_SEC * 1000);
      }
    }
  } catch (e) {
    boot.error = boot.error || e.message;
    log(`❌ ERRO: ${e.message}`);
    try { await shot(page, 'erro'); } catch (_) {}
  } finally {
    log('──────── RESULTADO ────────');
    if (boot.valid) log(`✅ Login inicial OK e Bearer válido entregue.`);
    else if (boot.loggedIn) log(`⚠ Logou mas não entregou Bearer válido.`);
    else log(`❌ Não logou${boot.error ? ': ' + boot.error : ''}. Ver poc-shots/.`);
    await shutdown(boot.valid ? 0 : 1);
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
