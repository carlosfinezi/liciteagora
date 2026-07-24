'use strict';
// Testa /report no NOSSO Chrome com os headers de segurança reconstruídos.
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IP = process.env.LICITANET_IP || '52.223.56.206';
const FP = process.env.FP || '4fa1408c9193497d5747221ba2780c76'; // fingerprint do usuário (teste)
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
  await sleep(4000);
  const r = await page.evaluate(async (fp) => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    const csrf = meta ? meta.getAttribute('content') : null;
    const ts = Math.floor(Date.now() / 1000);
    const rnd = Math.random().toString(36).slice(2, 13);
    const clientToken = btoa(ts + '|' + rnd);
    const out = { csrf: csrf ? csrf.slice(0, 10) + '...' : null, clientToken, fp };
    try {
      const resp = await fetch('/report/176262', {
        method: 'POST', credentials: 'same-origin',
        headers: {
          'accept': 'application/json', 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest',
          'x-csrf-token': csrf, 'x-browser-fingerprint': fp, 'x-client-token': clientToken,
        },
        body: JSON.stringify({ relatorio: 'RELATORIO_EXTRATO_ATA', dados: '' }),
      });
      out.status = resp.status;
      out.body = (await resp.text()).slice(0, 250);
    } catch (e) { out.err = e.message; }
    return out;
  }, FP).catch((e) => ({ evalErr: e.message }));
  console.log(JSON.stringify(r, null, 2));
  await b.close(); process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
