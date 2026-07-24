'use strict';
// Testa se o licitanet.com.br responde a um Chrome REAL headed (não headless) do datacenter.
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable', headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--lang=pt-BR', '--ignore-certificate-errors',
      // fixa licitanet.com.br → 52.223.56.206 (o IP roteado pela ppp0/loja)
      '--host-resolver-rules=MAP licitanet.com.br 52.223.56.206'],
    ignoreHTTPSErrors: true, defaultViewport: { width: 1366, height: 900 },
  });
  const page = (await b.pages())[0] || await b.newPage();
  const ua = (await b.userAgent()).replace(/HeadlessChrome/g, 'Chrome').replace(/\s{2,}/g, ' ');
  await page.setUserAgent(ua);
  console.log('UA:', ua);
  for (const url of ['https://licitanet.com.br/', 'https://licitanet.com.br/sessao/176262', 'https://dv7rs78smtpx8.cloudfront.net/']) {
    let status = 'ERR', server = '', body = '';
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      status = resp ? resp.status() : 'no-resp';
      try { server = (resp.headers()['server'] || '') + (resp.headers()['x-amzn-requestid'] ? ' amzn' : ''); } catch (e) {}
      body = (await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 160)).catch(() => '')).replace(/\s+/g, ' ');
    } catch (e) { status = 'EXC'; body = e.message; }
    console.log(`\n${url}\n  → HTTP ${status} server=${server}\n  body: ${body.slice(0, 140)}`);
    await sleep(1500);
  }
  await b.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
