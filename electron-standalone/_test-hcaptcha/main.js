// POC — RESOLVER o hCaptcha do LOGIN gov.br via NopeCHA Token API (local, IP
// residencial). Navega o login real → detecta sitekey → NopeCHA resolve e
// devolve token P0_/P1_ → injeta no widget → vê se o campo de senha aparece
// (= token ACEITO pelo gov.br). API key da NopeCHA e CPF digitados na hora
// (não embutidos — exe é público). NÃO salva senha, não completa login.

const { app, BrowserWindow, session } = require('electron');
const https = require('https');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('lang', 'pt-BR');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

const LOGIN_URL = 'https://www.comprasnet.gov.br/seguro/loginPortal.asp';
const SITEKEY_FALLBACK = '93b08d40-d46c-400a-ba07-6f91cda815b9';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));

// ─── NopeCHA Token API (main process, sem CORS) ─────────────────────────────
function nopechaReq(method, path, apiKey, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.nopecha.com', path, method,
      headers: Object.assign(
        { 'Authorization': 'Basic ' + apiKey, 'Accept': 'application/json' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      timeout: 30000,
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: d.slice(0, 200) }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function nopechaSolve(apiKey, sitekey, url, rqdata, log) {
  const body = { key: apiKey, sitekey, url };
  if (rqdata) body.data = { rqdata };
  const sub = await nopechaReq('POST', '/v1/token/hcaptcha', apiKey, body);
  log(`NopeCHA submit → HTTP ${sub.status} ${sub.body ? JSON.stringify(sub.body).slice(0, 120) : sub.raw || sub.error}`);
  if (sub.status === 401) return { ok: false, error: 'API key inválida (401)' };
  if (sub.status === 402) return { ok: false, error: 'Token API não disponível no seu plano (402)' };
  if (sub.status === 403) return { ok: false, error: 'Sem crédito ou IP banido (403)' };
  if (!sub.body || !sub.body.data) return { ok: false, error: `submit sem job id (HTTP ${sub.status})` };
  const jobId = sub.body.data;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    await sleep(1500);
    const r = await nopechaReq('GET', `/v1/token/hcaptcha?id=${encodeURIComponent(jobId)}&key=${encodeURIComponent(apiKey)}`, apiKey, null);
    if (r.status === 409) continue; // incompleto
    if (r.body && typeof r.body.data === 'string' && r.body.data.length > 10) return { ok: true, token: r.body.data };
    if (r.body && r.body.error) return { ok: false, error: r.body.error };
  }
  return { ok: false, error: 'timeout NopeCHA 120s' };
}

// ─── UI ─────────────────────────────────────────────────────────────────────
const BUILD_FORM = `(function(){
  document.title='POC NopeCHA — login gov.br';
  document.body.style.cssText='font-family:Segoe UI,Arial,sans-serif;background:#0b1120;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0';
  document.body.innerHTML='<div style="font-size:20px;font-weight:700;margin-bottom:10px">POC: resolver hCaptcha do login via NopeCHA</div>'
    +'<div style="font-size:13px;color:#94a3b8;margin-bottom:18px;text-align:center;max-width:520px">Cole sua API key da NopeCHA (com Token API) e seu CPF. Vou navegar o login real, mandar o hCaptcha pra NopeCHA e ver se o token passa. NAO salvo senha, NAO completo login.</div>'
    +'<input id=key placeholder="NopeCHA API key" style="font-size:15px;padding:8px 12px;border-radius:6px;border:1px solid #475569;background:#111827;color:#e2e8f0;width:340px;text-align:center;margin-bottom:10px">'
    +'<input id=cpf inputmode=numeric placeholder="CPF (so numeros)" style="font-size:15px;padding:8px 12px;border-radius:6px;border:1px solid #475569;background:#111827;color:#e2e8f0;width:220px;text-align:center">'
    +'<button id=go style="margin-top:16px;font-size:15px;padding:8px 24px;border-radius:6px;border:0;background:#2563eb;color:#fff;cursor:pointer">Iniciar POC</button>'
    +'<div id=st style="margin-top:16px;font-size:13px;color:#fbbf24;min-height:20px;text-align:center;max-width:600px"></div>';
  document.getElementById('go').addEventListener('click',function(){
    var k=(document.getElementById('key').value||'').trim();
    var c=(document.getElementById('cpf').value||'').replace(/[^0-9]/g,'');
    if(k.length<6||c.length<11){document.getElementById('st').textContent='Preencha API key e CPF válidos.';return;}
    window.__poc={key:k,cpf:c};
    document.getElementById('go').textContent='Rodando...';document.getElementById('go').style.background='#475569';
  });
})()`;

function overlay(wc, cor, titulo, linhas) {
  const html = `<div style="font-size:24px;font-weight:700;color:${cor};margin-bottom:14px">${titulo}</div>`
    + linhas.map((l) => `<div style="font-size:13px;color:#cbd5e1;margin:5px 0;max-width:780px;line-height:1.45">${l}</div>`).join('')
    + `<div style="font-size:14px;color:#fbbf24;margin-top:18px">📸 Tire um PRINT e mande pro suporte.</div>`;
  const js = `(function(){var d=document.createElement('div');
    d.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#0b1120;color:#e2e8f0;font-family:Segoe UI,Arial,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px;overflow:auto';
    d.innerHTML=${JSON.stringify(html)};document.documentElement.appendChild(d);})()`;
  return wc.executeJavaScript(js, true).catch(() => {});
}

function status(wc, msg) {
  return wc.executeJavaScript(`(function(){var s=document.getElementById('st');if(s)s.textContent=${JSON.stringify(msg)};})()`, true).catch(() => {});
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1024, height: 760, title: 'POC NopeCHA — LiciteAgora',
    webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'pocnope-mem' } });
  const wc = win.webContents;
  const ua = wc.getUserAgent().replace(/Electron\/[\d.]+\s?/g, '').replace(/\s{2,}/g, ' ');
  wc.setUserAgent(ua);
  const js = (code) => wc.executeJavaScript(code, true).catch(() => null);
  const diag = [];
  const log = (m) => { diag.push(m); status(wc, m); };

  await win.loadURL('about:blank');
  await js(BUILD_FORM);
  let poc = null;
  for (let i = 0; i < 3600 && !poc; i++) { poc = await js('window.__poc||null'); if (!poc) await sleep(500); }
  if (!poc) { await overlay(wc, '#dc2626', 'Cancelado', ['Feche e rode de novo.']); return; }

  try {
    // 1) navegar o login real até o ponto do hCaptcha
    log('Navegando login...');
    await win.loadURL(LOGIN_URL); await sleep(rnd(1500, 2500));
    await js(`(function(){ if(typeof mudaPerfilBotao==='function'){mudaPerfilBotao(1);return;} var b=document.querySelector('button.fornecedor');if(b)b.click(); })()`);
    await sleep(rnd(1500, 2500));
    await js(`(function(){var e=[].slice.call(document.querySelectorAll('button,a,input[type=button],input[type=submit]'));var g=e.find(function(x){var t=(x.textContent||x.value||'').replace(/\\s+/g,' ').trim().toLowerCase();return (t.indexOf('entrar')>=0&&t.indexOf('gov')>=0)||t==='entrar';});if(g){g.click();return;}var l=document.querySelector('a[href*="acesso.gov.br"],a[href*="loginPortalFornecedor"]');if(l)l.click();})()`);
    for (let i = 0; i < 30; i++) { if (wc.getURL().indexOf('acesso.gov.br') >= 0) break; await sleep(1000); }
    await sleep(rnd(6000, 8000));
    const cpfSel = await js(`(function(){var ss=['input[name=accountId]','input#accountId','input[inputmode=numeric]','input[type=text]'];for(var i=0;i<ss.length;i++)if(document.querySelector(ss[i]))return ss[i];return null;})()`);
    if (cpfSel) {
      await js(`(function(){var el=document.querySelector('${cpfSel}');el.focus();el.value='${poc.cpf}';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await sleep(rnd(800, 1500));
      await js(`(function(){var b=document.querySelector('button[type=submit]')||[].slice.call(document.querySelectorAll('button')).find(function(x){var t=(x.textContent||'').toLowerCase();return t.indexOf('continuar')>=0||t.indexOf('entrar')>=0;});if(b)b.click();})()`);
    }
    await sleep(4000);

    // 2) detectar sitekey + rqdata na página
    const info = await js(`(function(){
      var el=document.querySelector('[data-sitekey]'); var sk=el?el.getAttribute('data-sitekey'):null;
      if(!sk){var ifr=document.querySelector('iframe[src*=hcaptcha]');if(ifr){var m=ifr.src.match(/sitekey=([0-9a-fA-F-]+)/);if(m)sk=m[1];}}
      var rq=null; var cb=null;
      var dc=document.querySelector('[data-callback]'); if(dc)cb=dc.getAttribute('data-callback');
      return { sitekey: sk, rqdata: rq, callback: cb, hasHcaptchaIframe: !!document.querySelector('iframe[src*=hcaptcha]'), hasPassword: !!document.querySelector('input[type=password]'), url: location.href };
    })()`);
    if (info && info.hasPassword) { await overlay(wc, '#16a34a', '✅ SEM hCAPTCHA (passou passivo)', ['O campo de senha apareceu sem desafio — trust ativo, nem precisou da NopeCHA nesta tentativa.', ...diag]); return; }
    const sitekey = (info && info.sitekey) || SITEKEY_FALLBACK;
    log(`sitekey=${sitekey.slice(0, 12)}… iframe=${info && info.hasHcaptchaIframe} cb=${info && info.callback || '-'}`);

    // 3) NopeCHA resolve
    log('Enviando pro NopeCHA (pode levar 10-40s)...');
    const sol = await nopechaSolve(poc.key, sitekey, wc.getURL(), (info && info.rqdata) || null, log);
    if (!sol.ok) { await overlay(wc, '#dc2626', '❌ NopeCHA não resolveu', [sol.error, '', ...diag]); return; }
    log(`token recebido (len=${sol.token.length}, começa ${sol.token.slice(0, 4)})`);

    // 4) injetar token + disparar callback + submeter
    const inj = await js(`(function(){
      var tk=${JSON.stringify(sol.token)}; var set=0;
      [].slice.call(document.querySelectorAll('textarea[name="h-captcha-response"],textarea[name="g-recaptcha-response"],#h-captcha-response,#g-recaptcha-response,[name="h-captcha-response"]')).forEach(function(t){try{t.value=tk;set++;}catch(e){}});
      var dc=document.querySelector('[data-callback]'); var cbName=dc?dc.getAttribute('data-callback'):null;
      var cbOk=false; if(cbName&&typeof window[cbName]==='function'){try{window[cbName](tk);cbOk=true;}catch(e){}}
      var b=document.querySelector('button[type=submit]')||[].slice.call(document.querySelectorAll('button')).find(function(x){var t=(x.textContent||'').toLowerCase();return t.indexOf('continuar')>=0||t.indexOf('entrar')>=0||t.indexOf('avan')>=0;});
      if(b)b.click();
      return { set: set, cbOk: cbOk, cbName: cbName };
    })()`);
    log(`injeção: textareas=${inj && inj.set} callback=${inj && inj.cbName || '-'}(${inj && inj.cbOk})`);

    // 5) veredito: apareceu senha?
    let ok = false;
    for (let i = 0; i < 20; i++) {
      const st = await js(`(function(){return { senha: !!document.querySelector('input[type=password]'), url: location.href };})()`);
      if (st && (st.senha || (st.url && st.url.indexOf('cnetmobile') >= 0))) { ok = true; break; }
      await sleep(1500);
    }
    if (ok) await overlay(wc, '#16a34a', '✅ TOKEN ACEITO — login passou!', ['O campo de senha apareceu após injetar o token da NopeCHA.', 'Resolver o hCaptcha do login por API FUNCIONA nesta máquina. 🎉', '', ...diag]);
    else await overlay(wc, '#d97706', '⚠ Token não aceito (ainda)', ['A NopeCHA devolveu token, mas o gov.br não liberou a senha.', 'Provável causa: hCaptcha enterprise (precisa de rqdata) ou callback diferente.', 'Isso é iterável — o diagnóstico abaixo mostra onde parou:', '', ...diag]);
  } catch (e) {
    await overlay(wc, '#d97706', '⚠ ERRO', [String(e && e.message || e), '', ...diag]);
  }
});

app.on('window-all-closed', () => app.quit());
