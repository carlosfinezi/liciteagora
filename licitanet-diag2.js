'use strict';
// Captura os headers que a PRÓPRIA SPA do Licitanet manda (pra achar o x-browser-fingerprint).
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
  const seen = new Set();
  page.on('request', (req) => {
    try {
      const url = req.url();
      if (!/licitanet\.com\.br/.test(url)) return;
      const h = req.headers();
      // só XHR/fetch com headers de segurança custom
      const custom = Object.keys(h).filter((k) => /^x-|authorization|csrf|xsrf|fingerprint|client|token/i.test(k));
      if (custom.length && !seen.has(url)) {
        seen.add(url);
        const short = url.replace('https://licitanet.com.br', '');
        console.log(`\n[${req.method()}] ${short.slice(0, 70)}`);
        custom.forEach((k) => console.log(`   ${k}: ${String(h[k]).slice(0, 60)}`));
      }
    } catch (e) {}
  });
  console.log('carregando sessao/176262 e capturando headers das chamadas da SPA...');
  await page.goto('https://licitanet.com.br/sessao/176262', { waitUntil: 'networkidle2', timeout: 40000 }).catch((e) => console.log('goto', e.message));
  await sleep(8000);
  console.log('\n=== fim (', seen.size, 'endpoints com headers custom capturados) ===');
  await b.close(); process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
