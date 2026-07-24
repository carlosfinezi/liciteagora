const puppeteer=require('puppeteer-core');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const NOPE='ogomknllijkjboianknlncoagialpnlm';
(async()=>{
  const b=await puppeteer.launch({executablePath:'/usr/bin/google-chrome-stable',headless:false,
    userDataDir:'/home/carlosfinezi/web/liciteagora.com.br/private/.pocprofile',
    ignoreDefaultArgs:['--disable-extensions','--enable-automation','--disable-background-networking','--disable-component-update','--disable-default-apps'],
    args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled']});
  console.log('aguardando NopeCHA force-install (até 30s)...');
  let ok=false;
  try{ await b.waitForTarget(t=>t.url().includes(NOPE),{timeout:30000}); ok=true; }catch(e){}
  console.log('NopeCHA instalou?', ok);
  if(!ok){ for(const t of b.targets()) console.log('  target',t.type(),'|',t.url().slice(0,60)); await b.close(); process.exit(1); }
  // testa na demo
  const p=(await b.pages())[0];
  console.log('abrindo demo hCaptcha...');
  await p.goto('https://nopecha.com/demo/hcaptcha',{waitUntil:'domcontentloaded'}).catch(e=>console.log('goto',e.message));
  let solved=false;
  for(let i=0;i<25&&!solved;i++){ await sleep(3000);
    solved=await p.evaluate(()=>{const ta=document.querySelector('textarea[name="h-captcha-response"]');return !!(ta&&ta.value&&ta.value.length>20);}).catch(()=>false);
    if(i%3===0||solved){ await p.screenshot({path:`poc-shots/demo-${String(i).padStart(2,'0')}.png`}).catch(()=>{}); console.log(`${(i+1)*3}s solved=${solved}`);} }
  console.log(solved?'✅ EXTENSÃO RESOLVEU A DEMO!':'❌ instalou mas não resolveu a demo');
  await b.close();process.exit(0);
})().catch(e=>{console.error(String(e));process.exit(2)});
