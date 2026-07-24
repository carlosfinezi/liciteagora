/**
 * mrb-emitir.js — emissão da Certidão Negativa de Débitos Municipais de
 * Marabá-PA (tributos municipais) para o módulo Certidões & Habilitação.
 *
 * Portal NotaControl (SPA Angular) — `maraba.notacontrol.com.br`. SEM captcha,
 * SEM login, SEM proxy (datacenter funciona). Validade municipal = 60 dias.
 *
 * Fluxo: home → menu "Certidão Nada Consta" → "Emissão de Certidão" → tipo
 * CPF/CNPJ + CNPJ → AVANÇAR → seleciona o cadastro (ícone de ação na linha do
 * cadastro Econômico / inscrição municipal) → GERA DOCUMENTO → modal
 * (Finalidade=Licitação, Pessoa Autorizada) → CONFIRMAR → abre Report.aspx
 * (relatoriosv2) → baixa o PDF ORIGINAL via Node https (cookies do browser).
 *
 * Uso: DOC_ID=5 TENANT=1bit xvfb-run -a node mrb-emitir.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL: NodeURL } = require('url');
const puppeteer = require('puppeteer-core');
const Database = require('better-sqlite3');

const TENANT = process.env.TENANT || '1bit';
const DOC_ID = process.env.DOC_ID ? Number(process.env.DOC_ID) : null;
const PROXY = process.env.PROXY || '';
const CHROME = '/usr/bin/google-chrome-stable';
const EXT_ID = 'ogomknllijkjboianknlncoagialpnlm';
const EXT_SERVE_DIR = path.join(__dirname, 'nopecha-serve');
const VALIDADE_DIAS = 60;
const CAMINHO = '/portal/areas/certidao-alvara/emissao-certidao';
const SHOTS = path.join(__dirname, 'mrb-shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }
async function shot(page, n) { if (process.env.MRB_SHOTS !== '1') return; try { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, n + '.png') }); } catch {} }

// Deriva o subdomínio NotaControl da cidade do tenant (ex.: "Marabá" → "maraba").
// Muitos municípios usam <cidade>.notacontrol.com.br. Convenções fogem à regra
// (cidades compostas, homônimos), então config `notacontrol_subdominio` (ou env
// NC_SUBDOMINIO) sobrescreve.
function normalizarCidade(c) { return (c || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function resolverCad(tenant) {
  const db = new Database(path.join(__dirname, 'data', 'tenants', tenant, 'pncp.db'), { readonly: true });
  try {
    const r = db.prepare("SELECT cnpj, inscricaoMunicipal, cidade FROM fornecedor WHERE cnpj IS NOT NULL AND cnpj!='' ORDER BY id LIMIT 1").get() || {};
    // Multi-loja: env.CNPJ/IM/CIDADE (passado pelo provedor por estabelecimento)
    // têm prioridade; senão cai no cadastro do fornecedor (matriz).
    const cnpj = process.env.CNPJ || r.cnpj;
    if (!cnpj) throw new Error('CNPJ da empresa não encontrado');
    const im = process.env.IM || r.inscricaoMunicipal || '';
    const cidade = process.env.CIDADE || r.cidade || '';
    const cfg = (k) => { const x = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k); return x && x.valor ? x.valor : null; };
    const override = process.env.NC_SUBDOMINIO || cfg('notacontrol_subdominio');
    const sub = (override ? String(override) : normalizarCidade(cidade)).replace(/[^a-z0-9-]/gi, '').toLowerCase();
    if (!sub) throw new Error('subdomínio NotaControl não determinado (cidade vazia; configure notacontrol_subdominio)');
    return { cnpj: String(cnpj).replace(/\D/g, ''), im: im ? String(im).replace(/\D/g, '') : '', cidade, sub };
  } finally { db.close(); }
}
function startExtServer() { return new Promise((resolve) => { const srv = http.createServer((req, res) => { const name = path.basename((req.url || '').split('?')[0]); const f = path.join(EXT_SERVE_DIR, name); if (!f.startsWith(EXT_SERVE_DIR)) { res.writeHead(403); return res.end(); } fs.readFile(f, (e, data) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(data); } }); }); srv.on('error', () => resolve(null)); srv.listen(8899, '127.0.0.1', () => resolve(srv)); }); }
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
    out.negativa = /CERTID[ÃA]O NEGATIVA|n[ãa]o constam pend[êe]ncias/i.test(txt) ? true : (/POSITIVA/i.test(txt) ? false : null);
    const emi = txt.match(/Emiss[ãa]o:\s*(\d{2}\/\d{2}\/\d{4})/i);
    const val = txt.match(/Validade:\s*(\d{2}\/\d{2}\/\d{4})/i);
    const num = txt.match(/N[º°]:\s*([\d./-]+)/i);
    if (emi) out.dataEmissao = brToIso(emi[1]);
    if (val) out.dataValidade = brToIso(val[1]);
    if (num) out.numero = num[1].replace(/[.\s]+$/, '');
  } catch (e) { log('  (parse PDF: ' + e.message + ')'); }
  return out;
}

async function main() {
  const result = { ok: false, step: 'start', tenant: TENANT, docId: DOC_ID };
  const { cnpj, im, cidade, sub } = resolverCad(TENANT);
  const emissaoUrl = `https://${sub}.notacontrol.com.br${CAMINHO}`;
  Object.assign(result, { cnpj, im, cidade, subdominio: sub });
  log(`CND Municipal ${cidade || sub} p/ CNPJ ${cnpj} (im ${im || '-'}, ${sub}.notacontrol.com.br, tenant ${TENANT}${DOC_ID ? `, doc ${DOC_ID}` : ', dry-run'})`);
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

    // 1) carrega (redireciona p/ home) → navega pelo menu até o form
    result.step = 'nav';
    await page.goto(emissaoUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(5000);
    await page.evaluate(() => { const el = Array.from(document.querySelectorAll('a,button,li,span,div')).find((e) => /^certid[ãa]o nada consta/i.test((e.textContent || '').trim().slice(0, 30))); if (el) (el.closest('a,button,li') || el).click(); });
    await sleep(2500);
    await page.evaluate(() => { const el = Array.from(document.querySelectorAll('a,button,li,span')).find((e) => /emiss[ãa]o de certid/i.test((e.textContent || '').trim().slice(0, 40)) && !/nada consta/i.test((e.textContent || '').trim())); if (el) (el.closest('a,button') || el).click(); });
    await sleep(6000);
    await page.waitForSelector('#opRg', { timeout: 20000 });

    // 2) tipo=CPF/CNPJ, valorBusca=CNPJ, AVANÇAR
    result.step = 'buscar';
    await page.evaluate(() => { const s = document.getElementById('opRg'); const o = Array.from(s.options).find((x) => /cnpj/i.test(x.textContent || '')); if (o) { const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); } });
    await sleep(1500);
    await page.evaluate((c) => { const el = document.getElementById('valorBusca'); el.focus(); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, c); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true })); }, cnpj);
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button,a')).find((e) => /^avan[çc]ar$/i.test((e.textContent || '').trim())); if (b) b.click(); });
    await sleep(7000);
    await shot(page, '01-cadastros');

    // 3) seleciona o cadastro: linha do Econômico (ou que casa a inscrição municipal)
    result.step = 'cadastro';
    const clicou = await page.evaluate((imV) => {
      const rows = Array.from(document.querySelectorAll('tr')).filter((r) => r.querySelector('td'));
      let row = imV && rows.find((r) => (r.textContent || '').includes(imV));
      if (!row) row = rows.find((r) => /econ[ôo]mico/i.test(r.textContent || ''));
      if (!row) row = rows.find((r) => (r.querySelector('td') || {}).textContent);
      if (!row) return 'sem-linha';
      const btn = Array.from(row.querySelectorAll('a,button,i,mat-icon,[role=button]')).pop();
      if (btn) { btn.click(); return 'ok'; }
      return 'sem-acao';
    }, im);
    if (clicou !== 'ok') { await shot(page, 'sem-cadastro'); throw new Error('cadastro não encontrado/selecionável (' + clicou + ')'); }
    await sleep(6000);

    // 4) GERA DOCUMENTO → modal
    result.step = 'gera';
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button,a,[role=button]')).find((e) => /gera\s*documento/i.test((e.textContent || '').trim())); if (b) b.click(); });
    await sleep(4000);
    await shot(page, '02-modal');
    // Finalidade=Licitação (ou 1ª válida), Pessoa Autorizada=1ª válida
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('select')).forEach((s) => {
        const lbl = (s.previousElementSibling && s.previousElementSibling.textContent || '').toLowerCase();
        if (/finalidade/i.test(lbl)) { const o = Array.from(s.options).find((x) => /licita/i.test(x.textContent || '')) || Array.from(s.options).find((x) => x.value && !/null|undefined/.test(x.value) && !/selecione/i.test(x.textContent || '')); if (o) { const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); } }
        if (/pessoa|autoriz/i.test(lbl)) { const o = Array.from(s.options).find((x) => x.value && !/null|undefined/.test(x.value) && !/selecione/i.test(x.textContent || '')); if (o) { const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); } }
      });
    });
    await sleep(1500);

    // 5) CONFIRMAR → Report.aspx (nova aba) → baixa PDF original via Node https
    result.step = 'confirmar';
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button,a')).find((e) => /^confirmar$/i.test((e.textContent || '').trim())); if (b) b.click(); });
    await sleep(9000);
    const pp = (await browser.pages()).find((p) => /Report\.aspx/i.test(p.url()));
    if (!pp) { await shot(page, 'sem-report'); throw new Error('relatório (Report.aspx) não abriu — verificar finalidade/pessoa'); }
    const reportUrl = pp.url();
    const cookies = await pp.cookies();
    const cookieHdr = cookies.map((c) => c.name + '=' + c.value).join('; ');
    const pdfBuf = await new Promise((resolve, reject) => {
      const u = new NodeURL(reportUrl);
      https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { Cookie: cookieHdr, 'User-Agent': 'Mozilla/5.0' }, rejectUnauthorized: false }, (res) => {
        const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    if (!pdfBuf || pdfBuf.slice(0, 4).toString('latin1') !== '%PDF') throw new Error('PDF do relatório inválido (' + (pdfBuf ? pdfBuf.length : 0) + 'B)');

    result.step = 'salvar';
    const meta = await parsePdf(pdfBuf);
    const dataEmissao = meta.dataEmissao || isoHoje();
    const dataValidade = meta.dataValidade || isoMais(VALIDADE_DIAS);
    Object.assign(result, { tamanho: pdfBuf.length, numero: meta.numero, negativa: meta.negativa, dataEmissao, dataValidade });
    log(`  ✓ certidão ${meta.negativa ? 'negativa' : ''} nº ${meta.numero} — válida até ${dataValidade}`);

    if (DOC_ID) {
      const db = new Database(path.join(__dirname, 'data', 'tenants', TENANT, 'pncp.db'));
      try {
        const doc = db.prepare('SELECT * FROM habilitacao_documentos WHERE id=?').get(DOC_ID);
        if (!doc) throw new Error(`documento ${DOC_ID} não existe`);
        const destDir = path.join(__dirname, 'public', 'uploads', 'habilitacao', String(DOC_ID));
        fs.mkdirSync(destDir, { recursive: true });
        const destName = `cnd-municipal-maraba-${dataValidade}.pdf`;
        fs.writeFileSync(path.join(destDir, destName), pdfBuf);
        const rel = path.relative(path.join(__dirname, 'public'), path.join(destDir, destName)).replace(/\\/g, '/');
        db.prepare(`UPDATE habilitacao_documentos SET
            orgaoEmissor=COALESCE(NULLIF(orgaoEmissor,''),'Prefeitura de Marabá'), esfera='municipal',
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
  }
  return result;
}

main()
  .then((r) => { console.log('__RESULT__ ' + JSON.stringify(r)); process.exit(r.ok ? 0 : 2); })
  .catch((e) => { console.log('__RESULT__ ' + JSON.stringify({ ok: false, error: e.message, step: 'exception' })); log('ERRO:', e.message); process.exit(2); });
