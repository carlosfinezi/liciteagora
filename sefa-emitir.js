/**
 * sefa-emitir.js — emissão da Certidão Negativa Estadual (SEFA-PA, tributos
 * estaduais/ICMS) para o módulo Certidões & Habilitação.
 *
 * Portal app.sefa.pa.gov.br/emissao-certidao (Struts). SEM captcha e SEM login,
 * mas o datacenter é BLOQUEADO → obrigatoriamente via SOCKS residencial (VPN
 * "loja"). Emite por INSCRIÇÃO ESTADUAL (o CNPJ sozinho pede a IE).
 *
 * Fluxo: template.action → tipo=INSCRIÇÃO ESTADUAL + IE no campo Identificação
 * → Continuar → "Visualizar Certidão" (abre PDF em nova aba) → captura via
 * Page.printToPDF. Validade estadual PA = 180 dias.
 *
 * IE vem de fornecedor.inscricaoEstadual. Uso:
 *   DOC_ID=4 TENANT=1bit xvfb-run -a node sefa-emitir.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');
const Database = require('better-sqlite3');

const TENANT = process.env.TENANT || '1bit';
const DOC_ID = process.env.DOC_ID ? Number(process.env.DOC_ID) : null;
const PROXY = process.env.PROXY || 'socks5://127.0.0.1:1080'; // datacenter é bloqueado
const CHROME = '/usr/bin/google-chrome-stable';
const EXT_ID = 'ogomknllijkjboianknlncoagialpnlm';
const EXT_SERVE_DIR = path.join(__dirname, 'nopecha-serve');
const URL = 'https://app.sefa.pa.gov.br/emissao-certidao/';
const VALIDADE_DIAS = 180;
const SHOTS = path.join(__dirname, 'sefa-shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }
async function shot(page, n) { if (process.env.SEFA_SHOTS !== '1') return; try { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, n + '.png') }); } catch {} }

function resolverIE(tenant) {
  if (process.env.IE) return process.env.IE.replace(/\D/g, '');
  const db = new Database(path.join(__dirname, 'data', 'tenants', tenant, 'pncp.db'), { readonly: true });
  try { const r = db.prepare("SELECT inscricaoEstadual FROM fornecedor WHERE inscricaoEstadual IS NOT NULL AND inscricaoEstadual!='' ORDER BY id LIMIT 1").get(); if (!r || !r.inscricaoEstadual) throw new Error('Inscrição Estadual não cadastrada (fornecedor.inscricaoEstadual)'); return String(r.inscricaoEstadual).replace(/\D/g, ''); }
  finally { db.close(); }
}
function startExtServer() { return new Promise((resolve) => { const srv = http.createServer((req, res) => { const name = path.basename((req.url || '').split('?')[0]); const f = path.join(EXT_SERVE_DIR, name); if (!f.startsWith(EXT_SERVE_DIR)) { res.writeHead(403); return res.end(); } fs.readFile(f, (e, data) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(data); } }); }); srv.on('error', () => resolve(null)); srv.listen(8899, '127.0.0.1', () => resolve(srv)); }); }
const isoMais = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const isoHoje = () => new Date().toISOString().slice(0, 10);

async function main() {
  const result = { ok: false, step: 'start', tenant: TENANT, docId: DOC_ID };
  const ie = resolverIE(TENANT);
  result.ie = ie;
  log(`CND Estadual (SEFA-PA) p/ IE ${ie} (tenant ${TENANT}${DOC_ID ? `, doc ${DOC_ID}` : ', dry-run'}) via ${PROXY}`);
  await startExtServer();

  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--window-size=1366,900', '--disable-blink-features=AutomationControlled', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
  if (PROXY) args.push('--proxy-server=' + PROXY);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, args,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation', '--disable-background-networking', '--disable-component-update', '--disable-default-apps'],
    ignoreHTTPSErrors: true, defaultViewport: { width: 1366, height: 900 },
  });
  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.setUserAgent((await browser.userAgent()).replace(/HeadlessChrome/g, 'Chrome'));

    result.step = 'goto';
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    await page.waitForSelector('#tipo', { timeout: 20000 });

    // tipo=INSCRIÇÃO ESTADUAL, IE no campo Identificação (identificacao)
    result.step = 'preencher';
    const tipoVal = await page.evaluate(() => { const s = document.getElementById('tipo'); const o = Array.from(s.options).find((x) => /inscri/i.test(x.textContent || '')); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return o.value; } return null; });
    if (!tipoVal) throw new Error('opção INSCRIÇÃO ESTADUAL não encontrada');
    await sleep(2500);
    await page.evaluate((v) => { const el = document.getElementById('identificacao'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('keyup', { bubbles: true })); }, ie);
    log('  identificacao=' + await page.$eval('#identificacao', (e) => e.value).catch(() => '?'));
    await shot(page, '01-preenchido');

    // Continuar
    result.step = 'continuar';
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button,input[type=submit],input[type=button],a')).find((e) => /^continuar$/i.test((e.value || e.textContent || '').trim())); if (b) b.click(); });
    await sleep(7000);
    const temVisualizar = await page.evaluate(() => Array.from(document.querySelectorAll('a,button,input')).some((e) => /visualizar certid/i.test((e.value || e.textContent || '').trim()))).catch(() => false);
    if (!temVisualizar) {
      const msg = await page.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').match(/requerido|inv[áa]lid|n[ãa]o.{0,20}(encontrad|localizad)|erro[^.]{0,60}/i)).catch(() => null);
      await shot(page, 'sem-visualizar');
      throw new Error('não avançou para emissão' + (msg ? ' — ' + msg[0] : ' (verificar IE/dados)'));
    }
    await shot(page, '02-resultado');

    // Visualizar → PDF em nova aba → printToPDF
    result.step = 'pdf';
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('a,button,input[type=submit],input[type=button]')).find((e) => /visualizar certid/i.test((e.value || e.textContent || '').trim())); if (b) b.click(); });
    await sleep(7000);
    let pdfBuf = null;
    const pdfPage = (await browser.pages()).find((p) => /emitirCertidao\.action/i.test(p.url()));
    if (pdfPage) {
      const cdp = await pdfPage.target().createCDPSession();
      const r = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
      pdfBuf = Buffer.from(r.data, 'base64');
    }
    if (!pdfBuf || pdfBuf.slice(0, 4).toString('latin1') !== '%PDF') { await shot(page, 'sem-pdf'); throw new Error('PDF da certidão não capturado'); }
    // heurística: a certidão real tem 2 páginas (~centenas de KB); o alerta
    // "informe a IE" tem 1 página (~20KB). Se veio pequeno, provável erro.
    if (pdfBuf.length < 60000) throw new Error('resposta pequena (' + pdfBuf.length + 'B) — provável alerta/erro, não a certidão');
    const dataEmissao = isoHoje();
    const dataValidade = isoMais(VALIDADE_DIAS);
    Object.assign(result, { tamanho: pdfBuf.length, dataEmissao, dataValidade });
    log(`  ✓ certidão capturada (${pdfBuf.length}B) — válida até ${dataValidade}`);

    if (DOC_ID) {
      const db = new Database(path.join(__dirname, 'data', 'tenants', TENANT, 'pncp.db'));
      try {
        const doc = db.prepare('SELECT * FROM habilitacao_documentos WHERE id=?').get(DOC_ID);
        if (!doc) throw new Error(`documento ${DOC_ID} não existe`);
        const destDir = path.join(__dirname, 'public', 'uploads', 'habilitacao', String(DOC_ID));
        fs.mkdirSync(destDir, { recursive: true });
        const destName = `cnd-estadual-pa-${dataValidade}.pdf`;
        fs.writeFileSync(path.join(destDir, destName), pdfBuf);
        const rel = path.relative(path.join(__dirname, 'public'), path.join(destDir, destName)).replace(/\\/g, '/');
        db.prepare(`UPDATE habilitacao_documentos SET
            orgaoEmissor=COALESCE(NULLIF(orgaoEmissor,''),'SEFA-PA'), esfera='estadual',
            dataEmissao=?, dataValidade=?,
            arquivo=?, arquivoNome=?, arquivoMime='application/pdf', arquivoTamanho=?,
            origem='automatico', ultimaBuscaAuto=CURRENT_TIMESTAMP, dataAtualizacao=CURRENT_TIMESTAMP
          WHERE id=?`).run(dataEmissao, dataValidade, rel, destName, pdfBuf.length, DOC_ID);
        result.arquivo = rel;
        log(`  ✓ documento ${DOC_ID} atualizado (${rel})`);
      } finally { db.close(); }
    }
    result.ok = true; result.step = 'done';
  } finally {
    await browser.close().catch(() => {});
  }
  return result;
}

main()
  .then((r) => { console.log('__RESULT__ ' + JSON.stringify(r)); process.exit(r.ok ? 0 : 2); })
  .catch((e) => { console.log('__RESULT__ ' + JSON.stringify({ ok: false, error: e.message, step: 'exception' })); log('ERRO:', e.message); process.exit(2); });
