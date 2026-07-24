/**
 * cndt-emitir.js — robô de emissão da CNDT (Certidão Negativa de Débitos
 * Trabalhistas, TST) para o módulo Certidões & Habilitação.
 *
 * Portal https://cndt-certidao.tst.jus.br é JSF/RichFaces com reCAPTCHA v2 e
 * download do PDF ao clicar "Emitir Certidão" — inviável por HTTP cru. Aqui
 * dirigimos um Chrome real (headful sob xvfb) com a extensão NopeCHA
 * force-installed (mesma stack do govbr-bearer-service.js), que resolve o
 * reCAPTCHA in-page.
 *
 * Uso (standalone, para teste):
 *   xvfb-run -a node cndt-emitir.js                 # dry-run: emite p/ CNPJ do tenant, NÃO grava no DB
 *   TENANT=1bit CNPJ=19884430000141 xvfb-run -a node cndt-emitir.js
 *   DOC_ID=12 TENANT=1bit xvfb-run -a node cndt-emitir.js   # grava no documento 12
 *
 * Saída: imprime uma linha JSON `__RESULT__ {...}` no stdout (consumida pelo
 * provider habilitacao-provedores/cndt.js).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');
const Database = require('better-sqlite3');

const TENANT = process.env.TENANT || '1bit';
const DOC_ID = process.env.DOC_ID ? Number(process.env.DOC_ID) : null;
const CHROME = '/usr/bin/google-chrome-stable';
const EXT_ID = 'ogomknllijkjboianknlncoagialpnlm';
const EXT_SERVE_DIR = path.join(__dirname, 'nopecha-serve');
const SHOTS = path.join(__dirname, 'cndt-shots');
const DL_DIR = process.env.DL_DIR || path.join(__dirname, 'cndt-downloads', String(process.pid));

const INICIO_URL = 'https://cndt-certidao.tst.jus.br/inicio.faces';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));
function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }

let SHOT_N = 0;
async function shot(page, name) {
  if (process.env.CNDT_SHOTS !== '1') return; // debug only — evita acúmulo em produção
  try {
    if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
    const f = path.join(SHOTS, `${String(++SHOT_N).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: f, fullPage: false });
    log(`  📸 ${f}`);
  } catch (e) { log(`  (shot ${name} falhou: ${e.message})`); }
}

// Resolve o CNPJ da empresa do tenant (registro único da tabela fornecedor =
// emitente/prestador). Env CNPJ tem precedência.
function resolverCnpj(tenant) {
  if (process.env.CNPJ) return process.env.CNPJ.replace(/\D/g, '');
  const dbPath = path.join(__dirname, 'data', 'tenants', tenant, 'pncp.db');
  if (!fs.existsSync(dbPath)) throw new Error(`pncp.db não encontrado: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT cnpj FROM fornecedor WHERE cnpj IS NOT NULL AND cnpj != '' ORDER BY id LIMIT 1").get();
    if (!row || !row.cnpj) throw new Error('CNPJ da empresa não encontrado (tabela fornecedor vazia)');
    return String(row.cnpj).replace(/\D/g, '');
  } finally { db.close(); }
}

// Servidor HTTP in-process p/ a política do Chrome force-installar a extensão
// (Chrome 146 bloqueia --load-extension). Idempotente: se 8899 já está em uso
// (govbr-bearer-service.js), reusa.
function startExtServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const name = path.basename((req.url || '').split('?')[0]);
      const f = path.join(EXT_SERVE_DIR, name);
      if (!f.startsWith(EXT_SERVE_DIR)) { res.writeHead(403); return res.end(); }
      fs.readFile(f, (e, data) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(data); } });
    });
    srv.on('error', () => { log('[ext-server] 8899 já em uso — reusando'); resolve(null); });
    srv.listen(8899, '127.0.0.1', () => { log('[ext-server] servindo extensão em 127.0.0.1:8899'); resolve(srv); });
  });
}

function fmtCnpj(d) {
  const s = String(d).replace(/\D/g, '').padStart(14, '0');
  return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12, 14)}`;
}

// Extrai datas (expedição/validade) e negativa/positiva do PDF da CNDT.
async function parsePdf(pdfPath) {
  const out = { negativa: null, dataEmissao: null, dataValidade: null, numero: null };
  try {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(pdfPath)) });
    const data = await parser.getText();
    await parser.destroy().catch(() => {});
    const txt = (data.text || '').replace(/\s+/g, ' ');
    out.negativa = /CERTID[ÃA]O NEGATIVA/i.test(txt) ? true : (/CERTID[ÃA]O POSITIVA/i.test(txt) ? false : null);
    // "Expedição: 09/07/2026" e "Validade: 05/01/2027" (formatos comuns no rodapé)
    const exp = txt.match(/Expedi[çc][ãa]o:\s*(\d{2}\/\d{2}\/\d{4})/i);
    const val = txt.match(/Validade:\s*(\d{2}\/\d{2}\/\d{4})/i);
    const num = txt.match(/Certid[ãa]o n[º°.:\s]*([\d./-]+)/i);
    const br2iso = (b) => { const [d, m, y] = b.split('/'); return `${y}-${m}-${d}`; };
    if (exp) out.dataEmissao = br2iso(exp[1]);
    if (val) out.dataValidade = br2iso(val[1]);
    if (num) out.numero = num[1].replace(/[.\s]+$/, '');
  } catch (e) { log(`  (parse PDF falhou: ${e.message})`); }
  return out;
}

function isoHoje() { return new Date().toISOString().slice(0, 10); }
function isoMais(dias) { const d = new Date(); d.setDate(d.getDate() + dias); return d.toISOString().slice(0, 10); }

// O captcha do CNDT é uma imagem de texto distorcido → OCR por modelo de visão.
// Cadeia: Groq (Llama 4 Scout, quota própria) → Gemini (fallback). Assim não
// dependemos da chave Gemini, que o BI/análise-IA já consome pesado.
function readKeys(tenant) {
  const dbPath = path.join(__dirname, 'data', 'tenants', tenant, 'pncp.db');
  const db = new Database(dbPath, { readonly: true });
  try {
    const g = (k) => { const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k); return r && r.valor ? r.valor : null; };
    return { gemini: g('gemini_api_key'), groq: g('groq_api_key') };
  } finally { db.close(); }
}

const OCR_PROMPT = 'Transcreva exatamente os 6 caracteres alfanuméricos escritos nesta imagem. Ignore linhas, círculos e ruído de fundo. Responda somente com os caracteres, em minúsculas, sem espaços nem pontuação.';
const limparResp = (t) => (t || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

async function ocrGroq(dataUri, apiKey) {
  const body = {
    model: 'meta-llama/llama-4-scout-17b-16e-instruct', temperature: 0, max_tokens: 20,
    messages: [{ role: 'user', content: [
      { type: 'text', text: OCR_PROMPT },
      { type: 'image_url', image_url: { url: dataUri } },
    ] }],
  };
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  const t = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  if (!t) log('  (Groq raw: ' + JSON.stringify(j).slice(0, 200) + ')');
  return limparResp(t);
}

async function ocrGemini(base64, mime, apiKey) {
  const body = {
    contents: [{ parts: [{ text: OCR_PROMPT }, { inline_data: { mime_type: mime || 'image/png', data: base64 } }] }],
    generationConfig: { temperature: 0 },
  };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  const txt = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text) || '';
  if (!txt) log('  (Gemini raw: ' + JSON.stringify(j).slice(0, 200) + ')');
  return limparResp(txt);
}

async function solveCaptcha(base64, mime, keys) {
  const dataUri = `data:${mime || 'image/png'};base64,${base64}`;
  if (keys.groq) { const s = await ocrGroq(dataUri, keys.groq).catch((e) => { log('  (Groq erro: ' + e.message + ')'); return ''; }); if (s && s.length >= 4) return s; }
  if (keys.gemini) { const s = await ocrGemini(base64, mime, keys.gemini).catch((e) => { log('  (Gemini erro: ' + e.message + ')'); return ''; }); if (s && s.length >= 4) return s; }
  return '';
}

async function main() {
  const result = { ok: false, step: 'start', tenant: TENANT, docId: DOC_ID };
  const cnpj = resolverCnpj(TENANT);
  result.cnpj = cnpj;
  const keys = readKeys(TENANT);
  if (!keys.groq && !keys.gemini) throw new Error('nenhuma chave de visão (groq/gemini) configurada p/ OCR do captcha');
  log(`CNDT p/ CNPJ ${fmtCnpj(cnpj)} (tenant ${TENANT}${DOC_ID ? `, doc ${DOC_ID}` : ', dry-run'})`);

  fs.mkdirSync(DL_DIR, { recursive: true });
  await startExtServer();

  const args = [
    '--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=1366,900',
  ];
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, args,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation', '--disable-background-networking', '--disable-component-update', '--disable-default-apps'],
    ignoreHTTPSErrors: true, defaultViewport: { width: 1366, height: 900 },
  });
  try {
    try { await browser.waitForTarget((t) => t.url().includes(EXT_ID), { timeout: 30000 }); log('  ✓ extensão NopeCHA force-installed'); }
    catch { log('  ⚠ extensão NopeCHA não detectada em 30s (segue mesmo assim)'); }

    const page = (await browser.pages())[0] || await browser.newPage();
    const ua = (await browser.userAgent()).replace(/HeadlessChrome/g, 'Chrome');
    await page.setUserAgent(ua);

    // Direciona downloads pro nosso diretório.
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR });

    // 1) landing → clica "Emitir Certidão" → form gerarCertidao.faces
    result.step = 'inicio';
    log('1) inicio.faces...');
    await page.goto(INICIO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await shot(page, 'inicio');
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('input[type="submit"],button'))
        .find((x) => /emitir certid/i.test(x.value || x.textContent || ''));
      if (b) b.click();
    });
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#gerarCertidaoForm\\:cpfCnpj, [name="gerarCertidaoForm:cpfCnpj"]', { timeout: 20000 });
    result.step = 'form';
    log('2) formulário de emissão carregado');
    await shot(page, 'form');

    // 2) CNPJ (a máscara formataCnpjCpf reage ao keyup)
    await page.click('#gerarCertidaoForm\\:cpfCnpj');
    await page.type('#gerarCertidaoForm\\:cpfCnpj', cnpj, { delay: rnd(60, 120) });
    log(`3) CNPJ digitado: ${await page.$eval('#gerarCertidaoForm\\:cpfCnpj', (el) => el.value)}`);

    // 3-5) loop: resolve captcha (OCR Gemini) → emite → espera PDF. Captcha
    // errado regenera a imagem; tentamos até 4x com imagens novas.
    // Garante o formulário de emissão pronto (campo CNPJ visível + preenchido).
    // Após um captcha recusado o CNDT mostra "Código de validação inválido" e
    // troca a tela — é preciso clicar "Emitir Nova Certidão" pra novo captcha.
    const prepararForm = async () => {
      const temCampo = await page.evaluate(() => {
        const el = document.getElementById('gerarCertidaoForm:cpfCnpj');
        return !!(el && el.offsetParent !== null);
      }).catch(() => false);
      if (!temCampo) {
        await page.evaluate(() => {
          const b = Array.from(document.querySelectorAll('input[type="submit"],button'))
            .find((x) => /emitir nova certid/i.test(x.value || x.textContent || ''));
          if (b) b.click();
        });
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      }
      await page.waitForSelector('#gerarCertidaoForm\\:cpfCnpj', { timeout: 15000 });
      const val = await page.$eval('#gerarCertidaoForm\\:cpfCnpj', (el) => el.value).catch(() => '');
      if (!val || val.replace(/\D/g, '').length < 14) {
        await page.click('#gerarCertidaoForm\\:cpfCnpj', { clickCount: 3 });
        await page.type('#gerarCertidaoForm\\:cpfCnpj', cnpj, { delay: rnd(50, 100) });
      }
    };

    let pdf = null;
    const MAX_TENT = 6;
    for (let tent = 1; tent <= MAX_TENT && !pdf; tent++) {
      result.step = 'captcha';
      await prepararForm();
      // lê a imagem do captcha (base64 data-URI em #idImgBase64)
      let src = null;
      for (let i = 0; i < 15; i++) {
        src = await page.evaluate(() => { const img = document.getElementById('idImgBase64'); return img && img.src && img.src.startsWith('data:') ? img.src : null; }).catch(() => null);
        if (src) break;
        await sleep(1000);
      }
      if (!src) { await shot(page, `captcha-sem-img-${tent}`); throw new Error('imagem do captcha não carregou'); }
      const m = src.match(/^data:([^;]+);base64,([\s\S]+)$/);
      if (!m) throw new Error('formato inesperado da imagem do captcha');
      const b64 = m[2].replace(/\s/g, ''); // remove espaços/quebras que quebram o decode do OCR
      const resposta = await solveCaptcha(b64, m[1], keys);
      log(`4.${tent}) captcha OCR → "${resposta}"`);
      if (!resposta || resposta.length < 4) { await shot(page, `captcha-ocr-vazio-${tent}`); continue; }

      await page.click('#idCampoResposta', { clickCount: 3 }).catch(() => {});
      await page.type('#idCampoResposta', resposta, { delay: rnd(40, 90) });

      result.step = 'emitir';
      log(`5.${tent}) Emitir Certidão...`);
      await page.evaluate(() => { const b = document.getElementById('gerarCertidaoForm:btnEmitirCertidao'); if (b) b.click(); });

      // espera PDF; sai cedo se aparecer o erro "código de validação inválido"
      result.step = 'download';
      let recusado = false;
      for (let i = 0; i < 14; i++) {
        const files = fs.readdirSync(DL_DIR).filter((f) => /\.pdf$/i.test(f) && !/\.crdownload$/i.test(f));
        if (files.length) { pdf = path.join(DL_DIR, files[0]); break; }
        recusado = await page.evaluate(() => /c[óo]digo de valida[çc][ãa]o inv[áa]lido|caracteres.*inv[áa]lid/i.test(document.body.innerText || '')).catch(() => false);
        if (recusado) break;
        await sleep(1500);
      }
      if (!pdf) { await shot(page, `retry-${tent}`); log(`  ↻ tentativa ${tent}${recusado ? ' (captcha recusado)' : ''} — novo captcha`); }
    }
    if (!pdf) { await shot(page, 'download-timeout'); throw new Error(`PDF não baixou após ${MAX_TENT} tentativas de captcha`); }
    const tamanho = fs.statSync(pdf).size;
    log(`  ✓ PDF baixado: ${pdf} (${tamanho} bytes)`);
    await shot(page, 'ok');

    // 6) parse do PDF (datas + negativa/positiva); fallback: hoje + 180 dias
    const meta = await parsePdf(pdf);
    const dataEmissao = meta.dataEmissao || isoHoje();
    const dataValidade = meta.dataValidade || isoMais(180);
    Object.assign(result, { pdf, tamanho, negativa: meta.negativa, numero: meta.numero, dataEmissao, dataValidade });
    log(`  negativa=${meta.negativa} emissão=${dataEmissao} validade=${dataValidade}`);

    // 7) grava no documento (se DOC_ID)
    if (DOC_ID) {
      const dbPath = path.join(__dirname, 'data', 'tenants', TENANT, 'pncp.db');
      const db = new Database(dbPath);
      try {
        const doc = db.prepare('SELECT * FROM habilitacao_documentos WHERE id = ?').get(DOC_ID);
        if (!doc) throw new Error(`documento ${DOC_ID} não existe no tenant ${TENANT}`);
        const destDir = path.join(__dirname, 'public', 'uploads', 'habilitacao', String(DOC_ID));
        fs.mkdirSync(destDir, { recursive: true });
        const destName = `cndt-${dataEmissao}.pdf`;
        const destAbs = path.join(destDir, destName);
        fs.copyFileSync(pdf, destAbs);
        const rel = path.relative(path.join(__dirname, 'public'), destAbs).replace(/\\/g, '/');
        db.prepare(`UPDATE habilitacao_documentos SET
            orgaoEmissor = COALESCE(NULLIF(orgaoEmissor,''),'TST'), esfera = 'federal',
            numero = ?, dataEmissao = ?, dataValidade = ?,
            arquivo = ?, arquivoNome = ?, arquivoMime = 'application/pdf', arquivoTamanho = ?,
            origem = 'automatico', ultimaBuscaAuto = CURRENT_TIMESTAMP, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?`).run(
          meta.numero || doc.numero, dataEmissao, dataValidade, rel, destName, tamanho, DOC_ID
        );
        result.arquivo = rel;
        log(`  ✓ documento ${DOC_ID} atualizado (arquivo=${rel})`);
      } finally { db.close(); }
    }

    result.ok = true;
    result.step = 'done';
  } finally {
    await browser.close().catch(() => {});
    // limpa downloads temporários
    try { fs.rmSync(DL_DIR, { recursive: true, force: true }); } catch {}
  }
  return result;
}

main()
  .then((r) => { console.log('__RESULT__ ' + JSON.stringify(r)); process.exit(r.ok ? 0 : 2); })
  .catch((e) => { console.log('__RESULT__ ' + JSON.stringify({ ok: false, error: e.message, step: 'exception' })); log('ERRO:', e.stack || e.message); process.exit(2); });
