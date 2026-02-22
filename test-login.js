const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
puppeteer.use(StealthPlugin());

const TWOCAPTCHA_KEY = 'dc5cc8c6935df2f85fa329f28dd19f53';
const HCAPTCHA_SITEKEY = '93b08d40-d46c-400a-ba07-6f91cda815b9';
const CPF = '00602500206';
const SENHA = 'Lombardi6392@#';

const TwoCaptcha = require('@2captcha/captcha-solver');
const solver = new TwoCaptcha.Solver(TWOCAPTCHA_KEY);

async function solveHCaptcha(pageUrl) {
  console.log('  [2Captcha] Enviando hCaptcha via SDK...');
  const result = await solver.hcaptcha({
    sitekey: HCAPTCHA_SITEKEY,
    pageurl: pageUrl,
    invisible: 1
  });
  console.log('  [2Captcha] Resolvido! Token:', result.data.substring(0, 30) + '...');
  return result.data;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors', '--window-size=1366,768'],
    protocolTimeout: 180000
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  try {
    // === PASSO 1: Acessar SSO ===
    console.log('1. Acessando SSO gov.br...');
    await page.goto('https://sso.acesso.gov.br/authorize?response_type=code&client_id=comprasnet.gov.br&scope=openid+profile+email+phone+govbr_confiabilidades&state=F&redirect_uri=https://www.comprasnet.gov.br/seguro/landing_sso.asp', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await new Promise(r => setTimeout(r, 3000));
    const loginUrl = page.url();
    console.log('   URL:', loginUrl);
    
    await page.waitForSelector('#accountId', { timeout: 10000 });

    // === PASSO 2: Resolver hCaptcha ===
    console.log('2. Resolvendo hCaptcha (CPF) via 2Captcha...');
    const captchaToken1 = await solveHCaptcha(loginUrl);

    // === PASSO 3: Digitar CPF e injetar token ===
    console.log('3. Digitando CPF e injetando token...');
    await page.type('#accountId', CPF, { delay: 80 });
    await new Promise(r => setTimeout(r, 500));

    await page.evaluate((token) => {
      document.querySelectorAll('[name="h-captcha-response"]').forEach(el => el.value = token);
      document.querySelectorAll('[name="g-recaptcha-response"]').forEach(el => el.value = token);
    }, captchaToken1);

    // === PASSO 4: Submeter CPF ===
    console.log('4. Submetendo CPF...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => console.log('   (timeout navegação)')),
      page.click('.button-continuar')
    ]);

    await new Promise(r => setTimeout(r, 3000));
    console.log('   URL:', page.url());

    let temSenha = await page.evaluate(() => !!document.querySelector('input[type=password]')).catch(() => false);
    
    if (!temSenha) {
      const body = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => '');
      console.log('   Body:', body.substring(0, 200));
      console.log('❌ Captcha não foi aceito ou CPF não avançou');
      await browser.close();
      return;
    }

    // === PASSO 5: Senha ===
    console.log('5. Campo senha encontrado! Digitando...');
    const senhaUrl = page.url();

    // Resolver captcha da senha se houver
    const temCaptcha2 = await page.evaluate(() => !!document.querySelector('iframe[src*="hcaptcha"]')).catch(() => false);
    if (temCaptcha2) {
      console.log('6. Resolvendo hCaptcha (senha)...');
      const captchaToken2 = await solveHCaptcha(senhaUrl);
      await page.evaluate((token) => {
        document.querySelectorAll('[name="h-captcha-response"]').forEach(el => el.value = token);
        document.querySelectorAll('[name="g-recaptcha-response"]').forEach(el => el.value = token);
      }, captchaToken2);
    }

    await page.type('input[type=password]', SENHA, { delay: 80 });
    await new Promise(r => setTimeout(r, 500));

    // === PASSO 6: Submeter senha ===
    console.log('7. Submetendo senha...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => console.log('   (timeout navegação)')),
      page.click('.button-continuar')
    ]);

    await new Promise(r => setTimeout(r, 3000));
    const finalUrl = page.url();
    console.log('   URL:', finalUrl);
    console.log('   Título:', await page.title());

    if (finalUrl.includes('comprasnet') || finalUrl.includes('intro.htm') || finalUrl.includes('landing_sso')) {
      console.log('\n✅ LOGIN OK!');
      const cookies = await page.cookies();
      console.log('   Cookies:', cookies.length);
      cookies.filter(c => c.name.includes('session') || c.name.includes('token') || c.name.includes('ASP'))
        .forEach(c => console.log('   ', c.name, '=', c.value.substring(0, 30) + '...'));
    } else {
      const body = await page.evaluate(() => document.body.innerText.substring(0, 400)).catch(() => '');
      console.log('\n❌ Login não completou. Body:', body.substring(0, 200));
    }

  } catch (err) {
    console.log('ERRO:', err.message);
  }

  await browser.close();
})();
