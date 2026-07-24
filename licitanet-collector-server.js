'use strict';
/**
 * licitanet-collector-server.js — Coletor de MARCA do Licitanet, SERVER-SIDE.
 *
 * Substitui a Abordagem A do Electron: em vez do webview do cliente, roda um
 * Chrome REAL no servidor, roteado pelo túnel da loja (ip route dos IPs do
 * licitanet.com.br → ppp0/wg-loja) — combinação "IP da loja + browser real"
 * que passa o WAF (o datacenter direto e o curl tomam 403; ver
 * project_licitanet_marca_scraping). As 2 chamadas rodam in-page (mesmo snippet
 * do portal Electron); o servidor baixa do CloudFront + parseia + grava via os
 * endpoints /api/electron/licitanet/{pendentes,ata} (licitanet-marca.js).
 *
 * Uso:  xvfb-run -a node licitanet-collector-server.js
 * Env:  TENANT(=1bit) SERVER_URL LICITANET_IP(=52.223.56.206) LIMIT(=10)
 *       SERVICE(=0: roda 1x e sai; =1: loop) LOOP_MIN(=30)
 */

const path = require('path');
const https = require('https');
const http = require('http');
const puppeteer = require('puppeteer-core');
const Database = require('better-sqlite3');

const TENANT = process.env.TENANT || '1bit';
const SERVER_URL = process.env.SERVER_URL || 'https://1bit.liciteagora.app';
const LICITANET_IP = process.env.LICITANET_IP || '52.223.56.206'; // IP do licitanet roteado pela loja
const FP = process.env.FP || '4fa1408c9193497d5747221ba2780c76'; // x-browser-fingerprint (valor válido conhecido, não amarrado à sessão)
const LIMIT = parseInt(process.env.LIMIT || '10', 10);
const SERVICE = process.env.SERVICE === '1';
const LOOP_MIN = parseInt(process.env.LOOP_MIN || '30', 10);
const CHROME = '/usr/bin/google-chrome-stable';
const SESSAO = (pid) => `https://licitanet.com.br/sessao/${pid}`;
const SPACING_MS = parseInt(process.env.SPACING_MS || '3500', 10); // rate-limit /report (Laravel throttle) — devagar
const SPA_BOOT_MS = 3500;     // deixa a SPA setar cookie XSRF + fingerprint
const COLLECT_TIMEOUT_MS = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

function readApiKey(tenant) {
  const dbPath = path.join(__dirname, 'data', 'tenants', tenant, 'pncp.db');
  const db = new Database(dbPath, { readonly: true });
  const r = db.prepare("SELECT valor FROM config WHERE chave='api_key'").get();
  db.close();
  if (!r || !r.valor) throw new Error('api_key não configurada no tenant ' + tenant);
  return r.valor;
}

function apiReq(method, apiPath, apiKey, body) {
  return new Promise((resolve) => {
    const u = new URL(SERVER_URL + apiPath);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json', 'X-Api-Key': apiKey, 'User-Agent': 'LiciteAgora-LicitanetSrv/1.0' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method, headers, timeout: 40000 }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j !== null ? j : d }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (payload) r.write(payload); r.end();
  });
}

// Snippet in-page das 2 chamadas com os headers de segurança que o /report exige
// (validados via "Copy as cURL" do navegador do cliente 2026-07-09):
//   x-csrf-token       = <meta name="csrf-token"> (da NOSSA sessão)
//   x-client-token     = base64("<unix_seconds>|<random>") gerado na hora
//   x-browser-fingerprint = valor fixo conhecido (não é amarrado à sessão — testado)
// NÃO usa x-xsrf-token nem window.axios (a SPA não expõe axios).
function kickJs(processId, fp) {
  return `(function(){
    window.__licitanetResult = null;
    (async function(){
      var diag = { step: 'start' };
      try {
        function csrf(){ var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute('content') : null; }
        function clientToken(){ var ts = Math.floor(Date.now()/1000); var r = Math.random().toString(36).slice(2,13); return btoa(ts + '|' + r); }
        var fp = ${JSON.stringify(fp)};
        var pid = ${JSON.stringify(String(processId))};
        function sec(extra){ return Object.assign({ 'accept':'application/json', 'x-requested-with':'XMLHttpRequest', 'x-csrf-token': csrf(), 'x-browser-fingerprint': fp, 'x-client-token': clientToken() }, extra||{}); }
        diag.hasCsrf = !!csrf();
        // (1) gerar relatório Extrato de Ata
        diag.step = 'report';
        var f1 = await fetch('/report/' + pid, { method: 'POST', credentials: 'same-origin', headers: sec({ 'content-type':'application/json' }), body: JSON.stringify({ relatorio: 'RELATORIO_EXTRATO_ATA', dados: '' }) });
        diag.reportStatus = f1.status; var t1 = await f1.text(); diag.reportBody = t1.slice(0, 200);
        var identifier = null; try { var j1 = JSON.parse(t1); identifier = j1 && (j1.identifier || j1.id); } catch(e){}
        diag.identifier = identifier || null;
        if (!identifier) { window.__licitanetResult = { ok: false, error: 'sem identifier', diag: diag }; return; }
        // (2) resolver URL do CloudFront
        diag.step = 'download';
        var f2 = await fetch('/report/' + identifier + '/download/2', { credentials: 'same-origin', headers: sec() });
        diag.downloadStatus = f2.status; var t2 = await f2.text(); diag.downloadBody = t2.slice(0, 200);
        var url = null; try { var j2 = JSON.parse(t2); url = j2 && j2.url; } catch(e){}
        diag.url = url || null;
        if (!url) { window.__licitanetResult = { ok: false, error: 'sem url', diag: diag }; return; }
        window.__licitanetResult = { ok: true, ataUrl: url, diag: diag };
      } catch (e) { diag.error = e && e.message ? e.message : String(e); window.__licitanetResult = { ok: false, error: diag.error, diag: diag }; }
    })();
    return 'kicked';
  })();`;
}

async function collectAtaUrl(page, processId) {
  await page.evaluate(kickJs(processId, FP)).catch((e) => log('  kick erro:', e.message));
  const deadline = Date.now() + COLLECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(400);
    let res = null;
    try { res = await page.evaluate('window.__licitanetResult'); } catch (e) { continue; }
    if (res) return res;
  }
  return { ok: false, error: `timeout ${COLLECT_TIMEOUT_MS}ms`, diag: null };
}

async function processarPendentes(page, apiKey) {
  const p = await apiReq('GET', `/api/electron/licitanet/pendentes?limit=${LIMIT}`, apiKey);
  if (p.status !== 200 || !p.body || !Array.isArray(p.body.pendentes)) { log(`pendentes falhou: HTTP ${p.status} ${JSON.stringify(p.body).slice(0, 120)}`); return; }
  const pend = p.body.pendentes;
  if (!pend.length) { log('fila vazia — nada a coletar'); return; }
  log(`${pend.length} pendente(s) — coletando...`);
  for (const it of pend) {
    const tag = `${it.cnpj}/${it.ano}/${it.sequencial} pid=${it.processId}`;
    if (!it.processId) { log(`  pulando (sem processId): ${tag}`); continue; }
    try {
      await page.goto(SESSAO(it.processId), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(SPA_BOOT_MS);
      const res = await collectAtaUrl(page, it.processId);
      if (!res.ok) {
        const d = res.diag || {};
        log(`  ✗ ${tag} — ${res.error} (report=${d.reportStatus} download=${d.downloadStatus} csrf=${d.hasCsrf})`);
        if (d.reportBody) log(`     reportBody: ${d.reportBody}`);
        if (d.reportStatus === 429 || d.downloadStatus === 429) { log('     ⏳ rate-limit (429) — aguardando 60s...'); await sleep(60000); }
      } else {
        log(`  ataUrl ${tag} → ${res.ataUrl.slice(0, 70)}...`);
        const g = await apiReq('POST', '/api/electron/licitanet/ata', apiKey, { cnpj: it.cnpj, ano: it.ano, sequencial: it.sequencial, ataUrl: res.ataUrl });
        if (g.status === 200 && g.body && g.body.ok) log(`  ✓ ${tag} — servidor gravou: itensAta=${g.body.itensAta} mapeados=${g.body.mapeados} gravados=${g.body.gravados}`);
        else log(`  ✗ ${tag} — /ata HTTP ${g.status} ${JSON.stringify(g.body).slice(0, 140)}`);
      }
    } catch (e) { log(`  ✗ ${tag} — erro: ${e.message}`); }
    await sleep(SPACING_MS);
  }
}

async function main() {
  const apiKey = readApiKey(TENANT);
  log(`coletor Licitanet server-side — tenant=${TENANT} limit=${LIMIT} licitanetIP=${LICITANET_IP} service=${SERVICE}`);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, // headed sob xvfb = combinação que provou passar o WAF
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--lang=pt-BR', '--ignore-certificate-errors',
      `--host-resolver-rules=MAP licitanet.com.br ${LICITANET_IP}`],
    ignoreHTTPSErrors: true, defaultViewport: { width: 1366, height: 900 },
  });
  const page = (await browser.pages())[0] || await browser.newPage();
  const ua = (await browser.userAgent()).replace(/HeadlessChrome/g, 'Chrome').replace(/\s{2,}/g, ' ');
  await page.setUserAgent(ua);
  log('Chrome up (headed/xvfb). UA=' + ua.slice(0, 55) + '...');
  try {
    do {
      await processarPendentes(page, apiKey);
      if (SERVICE) { log(`aguardando ${LOOP_MIN}min pro próximo ciclo...`); await sleep(LOOP_MIN * 60000); }
    } while (SERVICE);
  } finally {
    await Promise.race([browser.close().catch(() => {}), sleep(8000)]);
    try { const pr = browser.process(); if (pr) pr.kill('SIGKILL'); } catch (e) {}
    log('coletor encerrado.');
    process.exit(0);
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
