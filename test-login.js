const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
puppeteer.use(StealthPlugin());

const ANTICAPTCHA_KEY = 'COLE_SUA_KEY_AQUI';
const HCAPTCHA_SITEKEY = '93b08d40-d46c-400a-ba07-6f91cda815b9';
const CPF = '00602500206';
const SENHA = 'Lombardi6392@#';

async function solveHCaptcha(pageUrl) {
  console.log('  [AntiCaptcha] Criando tarefa hCaptcha...');
  
  const createRes = await axios.post('https://api.anti-captcha.com/createTask', {
    clientKey: ANTICAPTCHA_KEY,
    task: {
      type: 'HCaptchaTaskProxyless',
      websiteURL: pageUrl,
      websiteKey: HCAPTCHA_SITEKEY,
      isInvisible: true
    }
  });
  
  if (createRes.data.errorId !== 0) {
    throw new Error(`AntiCaptcha createTask: ${createRes.data.errorCode} - ${createRes.data.errorDescription}`);
  }
  
  const taskId = createRes.data.taskId;
  console.log('  [AntiCaptcha] TaskId:', taskId);
  
  await new Promise(r => setTimeout(r, 10000));
  
  for (let i = 0; i < 30; i++) {
    const resultRes = await axios.post('https://api.anti-captcha.com/getTaskResult', {
      clientKey: ANTICAPTCHA_KEY,
      taskId: taskId
    });
    
    if (resultRes.data.errorId !== 0) {
      throw new Error(`AntiCaptcha getResult: ${resultRes.data.errorCode}`);
    }
    
    if (resultRes.data.status === 'ready') {
      const token = resultRes.data.solution.gRecaptchaResponse;
      console.log('  [AntiCaptcha] Resolvido! Token:', token.substring(0, 30) + '...');
      return token;
    }
    
    if (i % 2 === 0) console.log('  [AntiCaptcha] Aguardando...', 10 + (i+1)*5, 's');
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('AntiCaptcha timeout');
}

(async () => {
  const balRes = await axios.post('https://api.anti-captcha.com/getBalance', { clientKey: ANTICAPTCHA_KEY });
  if (balRes.data.errorId !== 0) {
    console.log('❌ API Key inválida:', balRes.data.errorCode);
    return;
  }
  console.log('Saldo AntiCaptcha: $' + balRes.data.balance);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors', '--window-size=1366,768'],
    protocolTimeout: 180000
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  try {
    console.log('1. Acessando SSO gov.br...');
    await page.goto('https://sso.acesso.gov.br/authorize?response_type=code&client_id=comprasnet.gov.br&scope=openid+profile+email+phone+govbr_confiabilidades&state=F&redirect_uri=https://www.comprasnet.gov.br/seguro/landing_sso.asp', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await new Promise(r => setTimeout(r, 3000));
    const loginUrl = page.url();
    console.log('   URL:', loginUrl);
    await page.waitForSelector('#accountId', { timeout: 10000 });

    console.log('2. Resolvendo hCaptcha (CPF) via AntiCaptcha...');
    const captchaToken1 = await solveHCaptcha(loginUrl);

    console.log('3. Digitando CPF e injetando token...');
    await page.type('#accountId', CPF, { delay: 80 });
    await new Promise(r => setTimeout(r, 500));

    await page.evaluate((token) => {
      document.querySelectorAll('[name="h-captcha-response"]').forEach(el => el.value = token);
      document.querySelectorAll('[name="g-recaptcha-response"]').forEach(el => el.value = token);
    }, captchaToken1);

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

    console.log('5. Campo senha encontrado! Digitando...');
    const senhaUrl = page.url();

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
