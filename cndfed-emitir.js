/**
 * cndfed-emitir.js — emissão da CND Federal conjunta (Receita Federal + PGFN:
 * Certidão de Débitos Relativos a Créditos Tributários Federais e à Dívida
 * Ativa da União) para o módulo Certidões & Habilitação.
 *
 * Site PÚBLICO (sem login): servicos.receitafederal.gov.br/servico/certidoes/
 * (SPA gov.br-design-system). Fluxo: #/home/cnpj → CNPJ → "Emitir Certidão"
 * (dispara hCaptcha INVISÍVEL, resolvido pela extensão NopeCHA) → certidão PDF.
 * Validade da CND conjunta = 180 dias.
 *
 * IMPORTANTE: se a empresa tiver pendência fiscal federal (situação NÃO
 * regular), a Receita responde "023 - Não foi possível concluir a ação...".
 * Nesse caso NÃO há certidão negativa a emitir — reportamos o erro. O caminho
 * de SUCESSO (empresa regular) não pôde ser testado ao vivo (o CNPJ de teste
 * estava com imposto em atraso); a captura do PDF de sucesso segue o padrão
 * dos outros conectores e deve ser conferida na 1ª emissão bem-sucedida.
 *
 * Uso:
 *   TENANT=1bit xvfb-run -a node cndfed-emitir.js                 # dry-run
 *   DOC_ID=3 TENANT=1bit xvfb-run -a node cndfed-emitir.js        # grava no doc
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');
const Database = require('better-sqlite3');

const TENANT = process.env.TENANT || '1bit';
const DOC_ID = process.env.DOC_ID ? Number(process.env.DOC_ID) : null;
const PROXY = process.env.PROXY || ''; // opcional; datacenter funciona p/ este site
const CHROME = '/usr/bin/google-chrome-stable';
const EXT_ID = 'ogomknllijkjboianknlncoagialpnlm';
const EXT_SERVE_DIR = path.join(__dirname, 'nopecha-serve');
const URL = 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj';
const DL_DIR = path.join(__dirname, 'cndfed-downloads', String(process.pid));
const SHOTS = path.join(__dirname, 'cndfed-shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }
async function shot(page, n) { if (process.env.CNDFED_SHOTS !== '1') return; try { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, n + '.png') }); } catch {} }

function resolverCnpj(tenant) {
  if (process.env.CNPJ) return process.env.CNPJ.replace(/\D/g, '');
  const db = new Database(path.join(__dirname, 'data', 'tenants', tenant, 'pncp.db'), { readonly: true });
  try { const r = db.prepare("SELECT cnpj FROM fornecedor WHERE cnpj IS NOT NULL AND cnpj!='' ORDER BY id LIMIT 1").get(); if (!r || !r.cnpj) throw new Error('CNPJ da empresa não encontrado'); return String(r.cnpj).replace(/\D/g, ''); }
  finally { db.close(); }
}
function startExtServer() {
  return new Promise((resolve) => { const srv = http.createServer((req, res) => { const name = path.basename((req.url || '').split('?')[0]); const f = path.join(EXT_SERVE_DIR, name); if (!f.startsWith(EXT_SERVE_DIR)) { res.writeHead(403); return res.end(); } fs.readFile(f, (e, data) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(data); } }); }); srv.on('error', () => resolve(null)); srv.listen(8899, '127.0.0.1', () => resolve(srv)); });
}
const brToIso = (b) => { const [d, m, y] = b.split('/'); return `${y}-${m}-${d}`; };
const isoHoje = () => new Date().toISOString().slice(0, 10);
const isoMais = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

async function parsePdf(buf) {
  const out = { dataEmissao: null, dataValidade: null, numero: null, negativa: null };
  try {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const data = await parser.getText(); await parser.destroy().catch(() => {});
    const txt = (data.text || '').replace(/\s+/g, ' ');
    out.negativa = /CERTID[ÃA]O NEGATIVA|n[ãa]o consta.*pend[êe]ncia|regular/i.test(txt) && !/POSITIVA/i.test(txt) ? true : (/POSITIVA/i.test(txt) ? false : null);
    const emi = txt.match(/Emitida.*?(\d{2}\/\d{2}\/\d{4})|Data da emiss[ãa]o[:\s]*(\d{2}\/\d{2}\/\d{4})/i);
    const val = txt.match(/V[áa]lida at[ée][:\s]*(\d{2}\/\d{2}\/\d{4})|Validade[:\s]*.*?(\d{2}\/\d{2}\/\d{4})/i);
    const num = txt.match(/C[óo]digo de controle[^:]*:\s*([\dA-Za-z.]+)|Certid[ãa]o n[º°.:\s]*([\dA-Za-z./-]+)/i);
    if (emi) out.dataEmissao = brToIso(emi[1] || emi[2]);
    if (val) out.dataValidade = brToIso(val[1] || val[2]);
    if (num) out.numero = (num[1] || num[2] || '').replace(/[.\s]+$/, '');
  } catch (e) { log('  (parse PDF: ' + e.message + ')'); }
  return out;
}

async function main() {
  const result = { ok: false, step: 'start', tenant: TENANT, docId: DOC_ID };
  const cnpj = resolverCnpj(TENANT);
  result.cnpj = cnpj;
  log(`CND Federal p/ CNPJ ${cnpj} (tenant ${TENANT}${DOC_ID ? `, doc ${DOC_ID}` : ', dry-run'})`);
  fs.mkdirSync(DL_DIR, { recursive: true });
  await startExtServer();

  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--window-size=1366,900', '--disable-blink-features=AutomationControlled', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
  if (PROXY) args.push('--proxy-server=' + PROXY);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, args,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation', '--disable-background-networking', '--disable-component-update', '--disable-default-apps'],
    ignoreHTTPSErrors: true, defaultViewport: { width: 1366, height: 900 },
  });
  try {
    await browser.waitForTarget((t) => t.url().includes(EXT_ID), { timeout: 25000 }).catch(() => log('  ⚠ NopeCHA não detectada'));
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.setUserAgent((await browser.userAgent()).replace(/HeadlessChrome/g, 'Chrome'));
    const cli = await page.target().createCDPSession();
    await cli.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR });

    result.step = 'goto';
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(5000);
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((e) => /^aceitar$/i.test((e.textContent || '').trim())); if (b) b.click(); }).catch(() => {});
    await sleep(800);

    // CNPJ (input gov.br-ds precisa do evento input do Angular)
    result.step = 'cnpj';
    await page.waitForSelector('input[name="niContribuinte"]', { timeout: 15000 });
    await page.click('input[name="niContribuinte"]').catch(() => {});
    await page.type('input[name="niContribuinte"]', cnpj, { delay: 80 });
    let v = await page.$eval('input[name="niContribuinte"]', (e) => e.value).catch(() => '');
    if (!v || v.replace(/\D/g, '').length < 14) {
      await page.evaluate((c) => { const el = document.querySelector('input[name="niContribuinte"]'); if (el) { const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, c); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true })); } }, cnpj);
    }
    log('  CNPJ: ' + await page.$eval('input[name="niContribuinte"]', (e) => e.value).catch(() => '?'));

    // Emitir Certidão (dispara hCaptcha invisível)
    result.step = 'emitir';
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button,a,[role=button]')).find((e) => /^emitir certid/i.test((e.textContent || '').trim())); if (b) b.click(); });
    await sleep(3000);
    // hCaptcha (NopeCHA)
    for (let i = 0; i < 45; i++) { const t = await page.evaluate(() => Array.from(document.querySelectorAll('[name="h-captcha-response"]')).some((x) => x.value && x.value.length > 20)).catch(() => false); if (t) break; await sleep(2000); }
    await sleep(4000);

    // Resultado: erro (023/pendência) | PDF | aba nova
    result.step = 'resultado';
    const erro = await page.evaluate(() => { const t = (document.body ? document.body.innerText : ''); const m = t.match(/N[ãa]o foi poss[íi]vel concluir a a[çc][ãa]o[^.]*\.\s*[^.]*\.\s*(\d{3})?[^\n]{0,30}/i); return m ? m[0].replace(/\s+/g, ' ').trim() : null; }).catch(() => null);
    if (erro) { await shot(page, 'erro'); throw new Error('Receita recusou: "' + erro + '". Este código NÃO indica pendência fiscal — foi medido em 03/08/2026 emitindo normalmente pelo navegador com certidão válida vigente. Causa provável: hCaptcha invisível reprovando o cliente automatizado.'); }

    // procura PDF (download ou nova aba)
    let pdfBuf = null;
    for (let i = 0; i < 25 && !pdfBuf; i++) {
      const files = fs.existsSync(DL_DIR) ? fs.readdirSync(DL_DIR).filter((f) => /\.pdf$/i.test(f) && !/\.crdownload$/i.test(f)) : [];
      if (files.length) { pdfBuf = fs.readFileSync(path.join(DL_DIR, files[0])); break; }
      const nova = (await browser.pages()).find((p) => /\.pdf($|\?)/i.test(p.url()) || /certidao.*\.pdf/i.test(p.url()));
      if (nova) { try { const cli2 = await nova.target().createCDPSession(); const r = await cli2.send('Page.printToPDF', { printBackground: true }); pdfBuf = Buffer.from(r.data, 'base64'); break; } catch {} }
      await sleep(1500);
    }
    if (!pdfBuf) { await shot(page, 'sem-pdf'); throw new Error('emissão sem erro visível mas PDF não capturado — conferir o fluxo de sucesso (não testável com pendência fiscal)'); }

    const meta = await parsePdf(pdfBuf);
    const dataEmissao = meta.dataEmissao || isoHoje();
    const dataValidade = meta.dataValidade || isoMais(180);
    Object.assign(result, { tamanho: pdfBuf.length, numero: meta.numero, dataEmissao, dataValidade, negativa: meta.negativa });
    log(`  ✓ CND emitida — validade ${dataValidade} nº ${meta.numero}`);

    if (DOC_ID) {
      const db = new Database(path.join(__dirname, 'data', 'tenants', TENANT, 'pncp.db'));
      try {
        const doc = db.prepare('SELECT * FROM habilitacao_documentos WHERE id=?').get(DOC_ID);
        if (!doc) throw new Error(`documento ${DOC_ID} não existe`);
        const destDir = path.join(__dirname, 'public', 'uploads', 'habilitacao', String(DOC_ID));
        fs.mkdirSync(destDir, { recursive: true });
        const destName = `cnd-federal-${dataValidade}.pdf`;
        fs.writeFileSync(path.join(destDir, destName), pdfBuf);
        const rel = path.relative(path.join(__dirname, 'public'), path.join(destDir, destName)).replace(/\\/g, '/');
        db.prepare(`UPDATE habilitacao_documentos SET
            orgaoEmissor=COALESCE(NULLIF(orgaoEmissor,''),'Receita Federal / PGFN'), esfera='federal',
            numero=?, dataEmissao=?, dataValidade=?,
            arquivo=?, arquivoNome=?, arquivoMime='application/pdf', arquivoTamanho=?,
            origem='automatico', ultimaBuscaAuto=CURRENT_TIMESTAMP, dataAtualizacao=CURRENT_TIMESTAMP
          WHERE id=?`).run(meta.numero || doc.numero, dataEmissao, dataValidade, rel, destName, pdfBuf.length, DOC_ID);
        result.arquivo = rel;
        log(`  ✓ documento ${DOC_ID} atualizado (${rel})`);
      } finally { db.close(); }
    }
    result.ok = true; result.step = 'done';
  } finally {
    await browser.close().catch(() => {});
    try { fs.rmSync(DL_DIR, { recursive: true, force: true }); } catch {}
  }
  return result;
}

main()
  .then((r) => { console.log('__RESULT__ ' + JSON.stringify(r)); process.exit(r.ok ? 0 : 2); })
  .catch((e) => { console.log('__RESULT__ ' + JSON.stringify({ ok: false, error: e.message, step: 'exception' })); log('ERRO:', e.message); process.exit(2); });
