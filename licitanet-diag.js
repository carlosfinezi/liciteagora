'use strict';
// Diagnóstico: 1 load do sessao/176262 pra achar window.axios + tokens de segurança.
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IP = process.env.LICITANET_IP || '52.223.56.206';
(async () => {
  const b = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable', headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--lang=pt-BR', '--ignore-certificate-errors', `--host-resolver-rules=MAP licitanet.com.br ${IP}`],
    ignoreHTTPSErrors: true, defaultViewport: { width: 1366, height: 900 },
  });
  const page = (await b.pages())[0] || await b.newPage();
  await page.setUserAgent((await b.userAgent()).replace(/HeadlessChrome/g, 'Chrome'));
  console.log('carregando sessao/176262...');
  await page.goto('https://licitanet.com.br/sessao/176262', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('goto', e.message));
  // espera axios aparecer (até 20s)
  for (let i = 0; i < 20; i++) {
    const hasAx = await page.evaluate(() => typeof window.axios !== 'undefined' && !!window.axios).catch(() => false);
    if (hasAx) { console.log(`window.axios apareceu após ~${i}s`); break; }
    await sleep(1000);
  }
  const info = await page.evaluate(() => {
    const out = {};
    out.hasAxios = typeof window.axios !== 'undefined' && !!window.axios;
    try { out.axiosCommonHeaders = window.axios && window.axios.defaults && window.axios.defaults.headers && window.axios.defaults.headers.common ? Object.keys(window.axios.defaults.headers.common) : null; } catch (e) {}
    // metas
    out.metas = {};
    document.querySelectorAll('meta[name]').forEach((m) => { const n = m.getAttribute('name'); if (/csrf|token|fingerprint|client/i.test(n)) out.metas[n] = (m.content || '').slice(0, 30); });
    // globals suspeitos
    out.globals = Object.keys(window).filter((k) => /csrf|fingerprint|token|client|xsrf|security/i.test(k)).slice(0, 20);
    // cookies (nomes)
    out.cookies = document.cookie.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean);
    // localStorage keys
    try { out.localStorage = Object.keys(localStorage).slice(0, 20); } catch (e) {}
    return out;
  }).catch((e) => ({ err: e.message }));
  console.log(JSON.stringify(info, null, 2));
  await b.close(); process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
