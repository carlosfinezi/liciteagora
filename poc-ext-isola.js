'use strict';
// Isolamento: extensão NopeCHA na demo oficial de hCaptcha, no mesmo setup puppeteer.
const path = require('path');
const puppeteer = require('puppeteer-core');
const EXT = path.join(__dirname, 'nopecha-ext');
const SHOTS = path.join(__dirname, 'poc-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable', headless: false,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-size=1366,900'],
    defaultViewport: { width: 1366, height: 900 },
  });
  // service worker da extensão?
  await sleep(1500);
  for (const t of browser.targets()) if (t.type() === 'service_worker') log('SW ativo:', t.url().slice(0, 60));
  browser.on('targetcreated', (t) => { if (t.type() === 'service_worker') log('SW criado:', t.url().slice(0, 60)); });

  const page = (await browser.pages())[0] || await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (/nopecha|captcha|error|key/i.test(t)) log('PAGE:', t.slice(0, 140)); });

  log('abrindo demo hCaptcha da NopeCHA...');
  await page.goto('https://nopecha.com/demo/hcaptcha', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => log('goto:', e.message));
  let solved = false;
  for (let i = 0; i < 25 && !solved; i++) {
    await sleep(3000);
    solved = await page.evaluate(() => {
      const ta = document.querySelector('textarea[name="h-captcha-response"]');
      return !!(ta && ta.value && ta.value.length > 20);
    }).catch(() => false);
    if (i % 3 === 0 || solved) { await page.screenshot({ path: path.join(SHOTS, `demo-${String(i).padStart(2, '0')}.png`) }).catch(() => {}); log(`${(i + 1) * 3}s → solved=${solved}`); }
  }
  log(solved ? '✅ EXTENSÃO RESOLVEU a demo (funciona no puppeteer!)' : '❌ extensão NÃO resolveu a demo (integração puppeteer)');
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
