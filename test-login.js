const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
puppeteer.use(StealthPlugin());

const CAPSOLVER_KEY = 'CAP-9A27CE7EEA7E922431991048822968A26CE6E8A7DF283F4D969B90877A89AC92';
const HCAPTCHA_SITEKEY = '93b08d40-d46c-400a-ba07-6f91cda815b9';
const CPF = '00602500206';
const SENHA = 'Lombardi6392@#';

async function solveHCaptcha(pageUrl) {
  console.log('  [CapSolver] Criando tarefa hCaptcha...');
  let createRes;
  try {
    createRes = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: CAPSOLVER_KEY,
      task: {
        type: 'HCaptchaTaskProxyless',
        websiteKey: HCAPTCHA_SITEKEY,
        websiteURL: pageUrl
      }
    });
  } catch (err) {
    console.log('  [CapSolver] HTTP Error:', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
  console.log('  [CapSolver] Response:', JSON.stringify(createRes.data));

  if (createRes.data.errorId) {
    throw new Error(`CapSolver error: ${createRes.data.errorCode} - ${createRes.data.errorDescription}`);
  }

  const taskId = createRes.data.taskId;
  console.log('  [CapSolver] TaskId:', taskId);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    
    const resultRes = await axios.post('https://api.capsolver.com/getTaskResult', {
      clientKey: CAPSOLVER_KEY,
      taskId: taskId
    });

    if (resultRes.data.status === 'ready') {
      const token = resultRes.data.solution.gRecaptchaResponse;
      console.log('  [CapSolver] Resolvido em', (i+1)*2, 's! Token:', token.substring(0, 30) + '...');
      return token;
    }
    if (resultRes.data.status === 'failed') {
      throw new Error(`CapSolver falhou: ${resultRes.data.errorDescription}`);
    }
    if (i % 5 === 4) console.log('  [CapSolver] Aguardando...', (i+1)*2, 's');
  }
  throw new Error('CapSolver timeout 120s');
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors', '--window-size=1366,768'],
    protocolTimeout: 120000
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
    
    // Aguardar redirect estabilizar
    await new Promise(r => setTimeout(r, 2000));
    const loginUrl = page.url();
    console.log('   URL:', loginUrl);

    // Aguardar campo CPF
    await page.waitForSelector('#accountId', { timeout: 10000 });

    // === PASSO 2: Resolver hCaptcha ANTES de interagir ===
    console.log('2. Resolvendo hCaptcha (CPF)...');
    const captchaToken1 = await solveHCaptcha(loginUrl);

    // === PASSO 3: Digitar CPF ===
    console.log('3. Digitando CPF...');
    await page.type('#accountId', CPF, { delay: 80 });
    await new Promise(r => setTimeout(r, 500));

    // Injetar token do captcha
    console.log('4. Injetando token captcha...');
    await page.evaluate((token) => {
      // Textarea do hcaptcha
      document.querySelectorAll('[name="h-captcha-response"]').forEach(el => el.value = token);
      document.querySelectorAll('[name="g-recaptcha-response"]').forEach(el => el.value = token);
      
      // Tentar setar via hidden input se não existir
      const form = document.querySelector('form');
      if (form && !form.querySelector('[name="h-captcha-response"]')) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'h-captcha-response';
        input.value = token;
        form.appendChild(input);
      }
    }, captchaToken1);

    // === PASSO 4: Submeter CPF ===
    console.log('5. Submetendo CPF...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => console.log('   (timeout navegação)')),
      page.click('.button-continuar')
    ]);

    await new Promise(r => setTimeout(r, 3000));
    console.log('   URL:', page.url());

    // Verificar se chegou na tela de senha
    let temSenha = await page.evaluate(() => !!document.querySelector('input[type=password]')).catch(() => false);
    
    if (!temSenha) {
      // Verificar mensagem de erro
      const body = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
      console.log('   Não encontrou campo senha. Body:', body.substring(0, 200));
      
      // Tentar form.submit direto
      console.log('   Tentando form.submit()...');
      await page.evaluate((token) => {
        document.querySelectorAll('[name="h-captcha-response"]').forEach(el => el.value = token);
        const form = document.querySelector('form');
        if (form) form.submit();
      }, captchaToken1);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      console.log('   URL:', page.url());
      temSenha = await page.evaluate(() => !!document.querySelector('input[type=password]')).catch(() => false);
    }

    if (!temSenha) {
      console.log('❌ FALHOU na etapa CPF');
      await browser.close();
      return;
    }

    // === PASSO 5: Digitar senha ===
    console.log('6. Campo senha encontrado! Digitando...');
    const senhaUrl = page.url();
    await page.type('input[type=password]', SENHA, { delay: 80 });
    await new Promise(r => setTimeout(r, 500));

    // === PASSO 6: Resolver 2º hCaptcha se houver ===
    const temCaptcha2 = await page.evaluate(() => !!document.querySelector('iframe[src*="hcaptcha"]')).catch(() => false);

    if (temCaptcha2) {
      console.log('7. Resolvendo hCaptcha (senha)...');
      const captchaToken2 = await solveHCaptcha(senhaUrl);
      await page.evaluate((token) => {
        document.querySelectorAll('[name="h-captcha-response"]').forEach(el => el.value = token);
        document.querySelectorAll('[name="g-recaptcha-response"]').forEach(el => el.value = token);
      }, captchaToken2);
    } else {
      console.log('7. Sem captcha na tela de senha.');
    }

    // === PASSO 7: Submeter senha ===
    console.log('8. Submetendo senha...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => console.log('   (timeout navegação)')),
      page.click('.button-continuar')
    ]);

    await new Promise(r => setTimeout(r, 3000));
    const finalUrl = page.url();
    console.log('   URL:', finalUrl);
    console.log('   Título:', await page.title());

    // === RESULTADO ===
    if (finalUrl.includes('comprasnet') || finalUrl.includes('intro.htm') || finalUrl.includes('landing_sso')) {
      console.log('\n✅ LOGIN OK!');
      const cookies = await page.cookies();
      console.log('   Cookies:', cookies.length);
    } else {
      const body = await page.evaluate(() => document.body.innerText.substring(0, 400)).catch(() => '');
      console.log('\n❌ Login não completou. Body:', body.substring(0, 200));
    }

  } catch (err) {
    console.log('ERRO:', err.message);
  }

  await browser.close();
})();
