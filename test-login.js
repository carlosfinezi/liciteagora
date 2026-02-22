const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors'] 
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  console.log('1. Acessando SSO...');
  await page.goto('https://sso.acesso.gov.br/authorize?response_type=code&client_id=comprasnet.gov.br&scope=openid+profile+email+phone+govbr_confiabilidades&state=F&redirect_uri=https://www.comprasnet.gov.br/seguro/landing_sso.asp', { waitUntil: 'networkidle2', timeout: 30000 });
  
  console.log('2. Digitando CPF...');
  await page.type('#accountId', '00602500206', { delay: 80 });
  
  console.log('3. Clicando Continuar...');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => console.log('  (timeout navegação)')),
    page.click('.button-continuar')
  ]);
  
  console.log('4. URL:', page.url());
  
  const result = await page.evaluate(() => {
    const pwdInput = document.querySelector('input[type=password]');
    const errors = Array.from(document.querySelectorAll('[class*=error], [class*=alert], .msg-erro')).map(e => e.textContent.trim());
    return { temSenha: !!pwdInput, errors, body: document.body.innerText.substring(0, 300) };
  });
  console.log('Tem campo senha:', result.temSenha);
  if (result.errors.length) console.log('Erros:', result.errors);
  console.log('Body:', result.body);
  
  if (result.temSenha) {
    console.log('5. Digitando senha...');
    await page.type('input[type=password]', 'Lombardi6392@#', { delay: 80 });
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => console.log('  (timeout navegação)')),
      page.click('.button-continuar')
    ]);
    
    console.log('6. URL:', page.url());
    console.log('  Título:', await page.title());
  }
  
  await browser.close();
})().catch(e => console.log('Erro:', e.message));
