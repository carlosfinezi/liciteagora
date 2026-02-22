const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({ 
    headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors', '--window-size=1366,768'],
    protocolTimeout: 60000
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  
  console.log('1. Acessando SSO...');
  await page.goto('https://sso.acesso.gov.br/authorize?response_type=code&client_id=comprasnet.gov.br&scope=openid+profile+email+phone+govbr_confiabilidades&state=F&redirect_uri=https://www.comprasnet.gov.br/seguro/landing_sso.asp', { waitUntil: 'networkidle2', timeout: 30000 });
  
  console.log('2. Digitando CPF...');
  await page.type('#accountId', '00602500206', { delay: 100 });
  await new Promise(r => setTimeout(r, 1000));
  
  console.log('3. Clicando Continuar...');
  await page.click('.button-continuar');
  
  // Polling: esperar campo senha ou mudança
  console.log('4. Aguardando resposta (até 30s)...');
  let avancou = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const temSenha = await page.evaluate(() => !!document.querySelector('input[type=password]')).catch(() => false);
    if (temSenha) {
      console.log('   Campo senha apareceu em ' + (i+1) + 's!');
      avancou = true;
      break;
    }
    if (i % 5 === 4) console.log('   ' + (i+1) + 's...');
  }
  
  if (!avancou) {
    console.log('BLOQUEADO - captcha não passou');
    const body = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => '');
    console.log('Body:', body);
    await browser.close();
    return;
  }
  
  // Digitar senha
  console.log('5. Digitando senha...');
  await page.type('input[type=password]', 'Lombardi6392@#', { delay: 80 });
  await new Promise(r => setTimeout(r, 500));
  
  console.log('6. Clicando Entrar...');
  await page.click('.button-continuar');
  
  // Esperar redirecionamento
  for (let j = 0; j < 30; j++) {
    await new Promise(r => setTimeout(r, 1000));
    const url = page.url();
    if (url.includes('comprasnet') || url.includes('intro.htm')) {
      console.log('7. LOGIN OK! URL:', url);
      console.log('   Título:', await page.title());
      break;
    }
    if (j % 5 === 4) console.log('   ' + (j+1) + 's... URL:', url);
  }
  
  console.log('URL final:', page.url());
  await browser.close();
})().catch(e => console.log('Erro:', e.message));
