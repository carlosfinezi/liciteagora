const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
puppeteer.use(StealthPlugin());

const CAPSOLVER_KEY = 'CAP-9A27CE7EEA7E922431991048822968A26CE6E8A7DF283F4D969B90877A89AC92';
const HCAPTCHA_SITEKEY = '93b08d40-d46c-400a-ba07-6f91cda815b9';
const GOV_BR_URL = 'https://sso.acesso.gov.br';
const CPF = '00602500206';
const SENHA = 'Lombardi6392@#';

async function solveHCaptcha(pageUrl) {
  console.log('  [CapSolver] Criando tarefa hCaptcha...');
  const createRes = await axios.post('https://api.capsolver.com/createTask', {
    clientKey: CAPSOLVER_KEY,
    task: {
      type: 'HCaptchaTaskProxyLess',
      websiteKey: HCAPTCHA_SITEKEY,
      websiteURL: pageUrl
    }
  });

  if (createRes.data.errorId) {
    throw new Error(`CapSolver createTask error: ${createRes.data.errorDescription}`);
  }

  const taskId = createRes.data.taskId;
  console.log('  [CapSolver] TaskId:', taskId);

  // Polling para resultado
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    
    const resultRes = await axios.post('https://api.capsolver.com/getTaskResult', {
      clientKey: CAPSOLVER_KEY,
      taskId: taskId
    });

    const status = resultRes.data.status;
    if (status === 'ready') {
      const token = resultRes.data.solution.gRecaptchaResponse;
      console.log('  [CapSolver] Resolvido! Token:', token.substring(0, 40) + '...');
      return token;
    }
    if (status === 'failed') {
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
    const loginUrl = page.url();
    console.log('   URL:', loginUrl);

    // === PASSO 2: Digitar CPF ===
    console.log('2. Digitando CPF...');
    await page.type('#accountId', CPF, { delay: 80 });
    await new Promise(r => setTimeout(r, 500));

    // === PASSO 3: Resolver hCaptcha via CapSolver ===
    console.log('3. Resolvendo hCaptcha (CPF)...');
    const captchaToken1 = await solveHCaptcha(loginUrl);

    // Injetar token no form
    await page.evaluate((token) => {
      // Setar no textarea do hcaptcha
      const textarea = document.querySelector('[name="h-captcha-response"]') || document.querySelector('textarea[name="h-captcha-response"]');
      if (textarea) {
        textarea.value = token;
        textarea.style.display = 'block';
      }
      // Setar no campo g-recaptcha-response (hcaptcha usa esse nome também)
      const gResponse = document.querySelector('[name="g-recaptcha-response"]');
      if (gResponse) gResponse.value = token;
      
      // Callback do hcaptcha se existir
      if (typeof hcaptcha !== 'undefined') {
        try {
          // Tentar setar via API
          const iframes = document.querySelectorAll('iframe[data-hcaptcha-widget-id]');
          iframes.forEach(f => {
            const widgetId = f.getAttribute('data-hcaptcha-widget-id');
            if (widgetId && hcaptcha.setResponse) {
              hcaptcha.setResponse(widgetId, token);
            }
          });
        } catch(e) {}
      }
    }, captchaToken1);

    // === PASSO 4: Submeter CPF ===
    console.log('4. Submetendo CPF...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => console.log('   (timeout navegação)')),
      page.click('.button-continuar')
    ]);

    await new Promise(r => setTimeout(r, 2000));
    console.log('   URL:', page.url());

    // Verificar se chegou na tela de senha
    let temSenha = await page.evaluate(() => !!document.querySelector('input[type=password]')).catch(() => false);
    
    if (!temSenha) {
      // Talvez precisa submeter via form.submit()
      console.log('   Tentando form.submit()...');
      await page.evaluate((token) => {
        const form = document.querySelector('form');
        // Garantir que o token está no form
        let input = form.querySelector('[name="h-captcha-response"]');
        if (!input) {
          input = document.createElement('input');
          input.type = 'hidden';
          input.name = 'h-captcha-response';
          form.appendChild(input);
        }
        input.value = token;
        form.submit();
      }, captchaToken1);
      
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      console.log('   URL após submit:', page.url());
      temSenha = await page.evaluate(() => !!document.querySelector('input[type=password]')).catch(() => false);
    }

    if (!temSenha) {
      const body = await page.evaluate(() => document.body.innerText.substring(0, 400)).catch(() => '');
      console.log('FALHOU na etapa CPF. Body:', body);
      await browser.close();
      return;
    }

    // === PASSO 5: Digitar senha ===
    console.log('5. Campo senha encontrado! Digitando...');
    await page.type('input[type=password]', SENHA, { delay: 80 });
    await new Promise(r => setTimeout(r, 500));

    // === PASSO 6: Resolver hCaptcha da senha (se houver) ===
    const temCaptcha2 = await page.evaluate(() => {
      return !!document.querySelector('iframe[src*="hcaptcha"]');
    }).catch(() => false);

    if (temCaptcha2) {
      console.log('6. Resolvendo hCaptcha (senha)...');
      const captchaToken2 = await solveHCaptcha(page.url());
      await page.evaluate((token) => {
        const textarea = document.querySelector('[name="h-captcha-response"]') || document.querySelector('textarea[name="h-captcha-response"]');
        if (textarea) textarea.value = token;
        const gResponse = document.querySelector('[name="g-recaptcha-response"]');
        if (gResponse) gResponse.value = token;
      }, captchaToken2);
    } else {
      console.log('6. Sem captcha na senha.');
    }

    // === PASSO 7: Submeter senha ===
    console.log('7. Submetendo senha...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => console.log('   (timeout navegação)')),
      page.click('.button-continuar')
    ]);

    await new Promise(r => setTimeout(r, 3000));
    console.log('   URL:', page.url());
    console.log('   Título:', await page.title());

    // === PASSO 8: Verificar login ===
    const finalUrl = page.url();
    if (finalUrl.includes('comprasnet') || finalUrl.includes('intro.htm')) {
      console.log('\n✅ LOGIN OK!');
      const cookies = await page.cookies();
      console.log('   Cookies:', cookies.length);
      console.log('   URL:', finalUrl);
    } else {
      const body = await page.evaluate(() => document.body.innerText.substring(0, 400)).catch(() => '');
      console.log('\n❌ Login não completou. Body:', body);
    }

  } catch (err) {
    console.log('ERRO:', err.message);
  }

  await browser.close();
})();
