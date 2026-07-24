'use strict';
/**
 * cert-mtls-flow.js — login gov.br→Comprasnet por CERTIFICADO (e-CNPJ), 100% HTTP, sem browser.
 * Replica o OAuth (sem PKCE) apresentando o e-CNPJ no endpoint mTLS. Objetivo: capturar o bearer do cnetmobile.
 * Rodar como carlosfinezi no dir private. NÃO entrega nada (só loga). Uso: TENANT=1bit node cert-mtls-flow.js
 */
const https = require('https');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');

const TENANT = process.env.TENANT || '1bit';
const USE_SOCKS = process.env.NO_SOCKS !== '1';
const socks = USE_SOCKS ? new SocksProxyAgent('socks5://127.0.0.1:1080') : undefined;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const AUTHORIZE = 'https://sso.acesso.gov.br/authorize?response_type=code&client_id=comprasnet.gov.br&scope=openid+profile+email+phone+govbr_confiabilidades&state=F&redirect_uri=https://www.comprasnet.gov.br/seguro/landing_sso.asp';

// --- certificado do tenant ---
function loadCert() {
  const db = new Database(path.join(__dirname, 'data', 'tenants', TENANT, 'pncp.db'), { readonly: true });
  const c = db.prepare('SELECT certificadoBase64, senhaCriptografada FROM certificado_digital WHERE id=1').get();
  db.close();
  return { pfx: Buffer.from(c.certificadoBase64, 'base64'), passphrase: Buffer.from(c.senhaCriptografada, 'base64').toString() };
}
const CERT = loadCert();

// --- 2Captcha: resolve o hCaptcha invisível (sitekey do gov.br) ---
const TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_KEY || '';
const SITEKEY = '93b08d40-d46c-400a-ba07-6f91cda815b9';
function tc2(pathn, body) {
  return new Promise((resolve) => {
    const p = JSON.stringify(body);
    const r = https.request({ hostname: 'api.2captcha.com', path: pathn, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ error: d }); } }); });
    r.on('error', () => resolve({ error: 'net' })); r.write(p); r.end();
  });
}
async function solveHcaptcha() {
  const c = await tc2('/createTask', { clientKey: TWOCAPTCHA_KEY, task: { type: 'HCaptchaTaskProxyless', websiteURL: 'https://sso.acesso.gov.br/', websiteKey: SITEKEY, isInvisible: true } });
  if (!c.taskId) return { ok: false, error: 'createTask: ' + JSON.stringify(c).slice(0, 80) };
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    await new Promise(r => setTimeout(r, 5000));
    const r = await tc2('/getTaskResult', { clientKey: TWOCAPTCHA_KEY, taskId: c.taskId });
    if (r.status === 'ready') return { ok: true, token: r.solution.token || r.solution.gRecaptchaResponse, s: Math.round((Date.now() - t0) / 1000) };
    if (r.errorId) return { ok: false, error: r.errorCode };
  }
  return { ok: false, error: 'timeout' };
}

// --- cookie jar simples (por host, sem path/expiry sofisticado) ---
const jar = {}; // host -> {name: value}
function storeCookies(host, headers) {
  const sc = headers['set-cookie']; if (!sc) return;
  const base = host.split('.').slice(-4).join('.'); // agrupa por domínio amplo
  for (const line of sc) {
    const [kv] = line.split(';');
    const i = kv.indexOf('='); if (i < 0) continue;
    const name = kv.slice(0, i).trim(), val = kv.slice(i + 1).trim();
    (jar[host] = jar[host] || {})[name] = val;
    (jar[base] = jar[base] || {})[name] = val;
  }
}
function cookieFor(host) {
  const out = {};
  for (const h of Object.keys(jar)) if (host === h || host.endsWith('.' + h) || h.endsWith(host) || host.endsWith(h.split('.').slice(-4).join('.'))) Object.assign(out, jar[h]);
  return Object.entries(out).map(([k, v]) => `${k}=${v}`).join('; ');
}

function req(url, { cert = false, referer = '', method = 'GET', body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method, hostname: u.hostname, port: 443, path: u.pathname + u.search,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9', 'Accept-Encoding': 'gzip, deflate, br',
        'Upgrade-Insecure-Requests': '1', Connection: 'keep-alive',
        'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-User': '?1',
        Cookie: cookieFor(u.hostname) },
      agent: socks, servername: u.hostname,
    };
    if (referer) opts.headers.Referer = referer;
    if (method === 'POST') { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.headers['Content-Length'] = Buffer.byteLength(body); opts.headers['Sec-Fetch-Mode'] = 'navigate'; }
    if (cert) { opts.pfx = CERT.pfx; opts.passphrase = CERT.passphrase; }
    if (process.env.DBG) console.log(`   [dbg] → Cookie enviado: ${(opts.headers.Cookie || '(vazio)').slice(0, 80)}`);
    const r = https.request(opts, (res) => {
      storeCookies(u.hostname, res.headers);
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks); const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try { if (enc === 'gzip') buf = zlib.gunzipSync(buf); else if (enc === 'deflate') buf = zlib.inflateSync(buf); else if (enc === 'br') buf = zlib.brotliDecompressSync(buf); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, location: res.headers.location, body: buf.toString('utf8').slice(0, 20000) });
      });
    });
    r.on('error', reject); r.setTimeout(30000, () => { r.destroy(new Error('timeout')); });
    if (method === 'POST' && body) r.write(body);
    r.end();
  });
}

async function follow(startUrl, { maxHops = 12 } = {}) {
  let url = startUrl, hops = 0, last;
  while (url && hops++ < maxHops) {
    const useCert = /certificado\.sso\.acesso\.gov\.br/.test(url);
    last = await req(url, { cert: useCert });
    const loc = last.location ? new URL(last.location, url).toString() : null;
    console.log(`[${hops}] ${last.status} ${useCert ? '(CERT) ' : ''}${url.slice(0, 95)}`);
    if (loc) console.log(`     → ${loc.slice(0, 110)}`);
    if (last.status >= 300 && last.status < 400 && loc) {
      // no /login (SPA) o gov.br não redireciona; precisamos ir ao endpoint de cert manualmente
      url = loc;
    } else break;
  }
  return { last, url };
}

(async () => {
  console.log('=== 1) authorize → login (cookies, com retry anti-WAF) ===');
  let r, authIdTmp;
  for (let waf = 1; waf <= 4; waf++) {
    r = await follow(AUTHORIZE);
    authIdTmp = (r.url.match(/authorization_id=([a-z0-9]+)/i) || [])[1];
    if (authIdTmp) break;
    console.log(`  (WAF challenge — retry ${waf} com cookies TS)`);
  }
  const loginUrl = r.url;
  console.log('parou em:', loginUrl.slice(0, 110));
  const authId = (loginUrl.match(/authorization_id=([a-z0-9]+)/i) || [])[1];
  console.log('authorization_id:', authId || 'NÃO achado');
  console.log('cookies gov.br:', Object.keys(jar['acesso.gov.br'] || jar['sso.acesso.gov.br'] || {}).join(', ') || '(nenhum)');

  if (!authId) { console.log('sem authorization_id — abortando'); return; }

  // extrai o _csrf da página de login (input hidden)
  let csrf = (r.last.body.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];
  if (!csrf) {
    // body pode ter vindo truncado/desafio: re-GET a página de login cheia
    console.log('  (_csrf não no follow; re-GET login. body len=' + r.last.body.length + ', tem csrf=' + /csrf/i.test(r.last.body) + ', TSPD=' + /TSPD|tsMetaData|challenge/i.test(r.last.body) + ')');
    const lg = await req(loginUrl, { referer: loginUrl });
    csrf = (lg.body.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];
    if (!csrf) console.log('  re-GET body len=' + lg.body.length + ' head=' + lg.body.slice(0, 120).replace(/\s+/g, ' '));
  }
  console.log('  _csrf:', csrf || 'NÃO achado');
  if (!csrf) { console.log('sem _csrf — abortando'); return; }

  console.log('\n=== 1.5) resolvendo hCaptcha invisível via 2Captcha ===');
  const sol = await solveHcaptcha();
  if (!sol.ok) { console.log('  hCaptcha FALHOU:', sol.error); return; }
  console.log(`  ✓ token h-captcha (${sol.token.length} chars, ${sol.token.slice(0,4)}) em ${sol.s}s`);

  console.log('\n=== 2) POST no mTLS (corpo real capturado: _csrf+operation+h-captcha) ===');
  const certPost = `https://certificado.sso.acesso.gov.br/login?client_id=comprasnet.gov.br&authorization_id=${authId}`;
  const postBody = `accountId=&_csrf=${encodeURIComponent(csrf)}&operation=login-certificate&h-captcha-response=${encodeURIComponent(sol.token)}`;
  const rp = await req(certPost, { method: 'POST', body: postBody, cert: true, referer: loginUrl });
  console.log('  POST cert:', rp.status, '→', (rp.location || '').slice(0, 90));

  console.log('\n=== 3) seguir a cadeia até o CODE do Comprasnet ===');
  let cur = rp.location ? new URL(rp.location, certPost).toString() : null;
  let code = null, hops = 0, comprasId = null;
  while (cur && hops++ < 12) {
    const useCert = /certificado\.sso\.acesso\.gov\.br/.test(cur);
    const rr = await req(cur, { cert: useCert, referer: certPost });
    console.log(`  [${hops}] ${rr.status} ${cur.slice(0, 95)}`);
    const m = cur.match(/[?&]code=([^&]+)/); if (m) { code = m[1]; }
    const ci = cur.match(/compras-id=([0-9a-f-]+)/i); if (ci) comprasId = ci[1];
    if (rr.location) { console.log(`       → ${new URL(rr.location, cur).toString().slice(0, 100)}`); cur = new URL(rr.location, cur).toString(); }
    else break;
    if (/intro\.htm|main\.asp|cnetmobile/.test(cur)) break;
  }
  console.log('\n=== RESULTADO ===');
  console.log('  CODE:', code ? '✅ ' + code : '❌ não saiu');
  console.log('  compras-id:', comprasId || '(nenhum)');
  console.log('  logado no Comprasnet:', /intro\.htm|main\.asp|loginPortalFornecedor\?envia=1|cnetmobile/.test(cur || '') ? '✅ SIM' : 'não confirmado (' + (cur||'').slice(0,60) + ')');
})().catch((e) => console.error('ERRO:', e.message));
