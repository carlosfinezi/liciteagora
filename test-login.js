const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors', '--window-size=1366,768'] 
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  
  console.log('1. Acessando SSO...');
  await page.goto('https://sso.acesso.gov.br/authorize?response_type=code&client_id=comprasnet.gov.br&scope=openid+profile+email+phone+govbr_confiabilidades&state=F&redirect_uri=https://www.comprasnet.gov.br/seguro/landing_sso.asp', { waitUntil: 'networkidle2', timeout: 30000 });
  
  console.log('2. Digitando CPF...');
  await page.type('#accountId', '00602500206', { delay: 100 });
  
  // Tentar resolver hcaptcha antes de clicar
  console.log('3. Tentando hcaptcha...');
  const captchaResult = await page.evaluate(() => {
    return new Promise((resolve) => {
      if (typeof hcaptcha !== 'undefined') {
        hcaptcha.execute({ async: true }).then(r => {
          resolve({ ok: true, token: r.response ? r.response.substring(0, 30) + '...' : 'vazio' });
        }).catch(e => resolve({ ok: false, error: e.message }));
      } else {
        resolve({ ok: false, error: 'hcaptcha não encontrado' });
      }
    });
  }).catch(e => ({ ok: false, error: e.message }));
  console.log('  Captcha:', JSON.stringify(captchaResult));
  
  console.log('4. Clicando Continuar...');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => console.log('  (timeout navegação)')),
    page.click('.button-continuar')
  ]);
  
  console.log('5. URL:', page.url());
  
  const result = await page.evaluate(() => {
    const pwdInput = document.querySelector('input[type=password]');
    const errors = Array.from(document.querySelectorAll('[class*=error], [class*=alert], .msg-erro')).map(e => e.textContent.trim()).filter(t => t.length > 0);
    return { temSenha: !!pwdInput, errors, body: document.body.innerText.substring(0, 400) };
  });
  console.log('Tem campo senha:', result.temSenha);
  if (result.errors.length) console.log('Erros:', result.errors);
  console.log('Body:', result.body.substring(0, 200));
  
  if (result.temSenha) {
    console.log('6. Digitando senha...');
    await page.type('input[type=password]', 'Lombardi6392@#', { delay: 80 });
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => console.log('  (timeout navegação)')),
      page.click('.button-continuar')
    ]);
    
    console.log('7. URL:', page.url());
    console.log('  Título:', await page.title());
    
    // Verificar cookies/sessão
    const cookies = await page.cookies();
    console.log('  Cookies:', cookies.length);
  }
  
  await browser.close();
})().catch(e => console.log('Erro:', e.message));
