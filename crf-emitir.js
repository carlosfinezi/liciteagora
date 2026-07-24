/**
 * crf-emitir.js — emissão do CRF FGTS (Caixa) para o módulo Certidões &
 * Habilitação.
 *
 * O portal consulta-crf.caixa.gov.br está atrás do bot-manager ShieldSquare/
 * Radware. Para passar de forma confiável a partir do servidor usamos:
 *   - Chrome real headful sob xvfb + perfil PERSISTENTE (.crf-profile) p/
 *     reusar o cookie de validação do ShieldSquare
 *   - stealth (webdriver/plugins/languages) + --disable-blink-features=
 *     AutomationControlled
 *   - SOCKS residencial (VPN "loja", 127.0.0.1:1080) + anti-leak WebRTC, senão
 *     o ShieldSquare pega o IP do datacenter e desafia em loop
 *   - NopeCHA resolve o hCaptcha do desafio
 *
 * Fluxo: consultaEmpregador.jsf → CNPJ → Consultar → (desafio) → resultado →
 * link "Certificado de Regularidade do FGTS - CRF" → parseia validade/número →
 * gera PDF (Visualizar/printToPDF) → grava no documento (DOC_ID).
 *
 * Uso:
 *   TENANT=1bit PROXY=socks5://127.0.0.1:1080 xvfb-run -a node crf-emitir.js
 *   DOC_ID=2 TENANT=1bit PROXY=socks5://127.0.0.1:1080 xvfb-run -a node crf-emitir.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');
const Database = require('better-sqlite3');

const TENANT = process.env.TENANT || '1bit';
const DOC_ID = process.env.DOC_ID ? Number(process.env.DOC_ID) : null;
const PROXY = process.env.PROXY || 'socks5://127.0.0.1:1080';
const CHROME = '/usr/bin/google-chrome-stable';
const EXT_ID = 'ogomknllijkjboianknlncoagialpnlm';
const EXT_SERVE_DIR = path.join(__dirname, 'nopecha-serve');
const PROFILE = path.join(__dirname, '.crf-profile');
const URL = 'https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf';
const DL_DIR = path.join(__dirname, 'crf-downloads', String(process.pid));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }
const SHOTS = path.join(__dirname, 'crf-shots');
async function shot(page, n) { if (process.env.CRF_SHOTS !== '1') return; try { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, n + '.png') }); } catch {} }

function resolverCnpj(tenant) {
  if (process.env.CNPJ) return process.env.CNPJ.replace(/\D/g, '');
  const dbPath = path.join(__dirname, 'data', 'tenants', tenant, 'pncp.db');
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT cnpj FROM fornecedor WHERE cnpj IS NOT NULL AND cnpj != '' ORDER BY id LIMIT 1").get();
    if (!row || !row.cnpj) throw new Error('CNPJ da empresa não encontrado (tabela fornecedor)');
    return String(row.cnpj).replace(/\D/g, '');
  } finally { db.close(); }
}

function startExtServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const name = path.basename((req.url || '').split('?')[0]);
      const f = path.join(EXT_SERVE_DIR, name);
      if (!f.startsWith(EXT_SERVE_DIR)) { res.writeHead(403); return res.end(); }
      fs.readFile(f, (e, data) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(data); } });
    });
    srv.on('error', () => resolve(null));
    srv.listen(8899, '127.0.0.1', () => resolve(srv));
  });
}

const brToIso = (b) => { const [d, m, y] = b.split('/'); return `${y}-${m}-${d}`; };

async function main() {
  const result = { ok: false, step: 'start', tenant: TENANT, docId: DOC_ID };
  const cnpj = resolverCnpj(TENANT);
  result.cnpj = cnpj;
  log(`CRF FGTS p/ CNPJ ${cnpj} (tenant ${TENANT}${DOC_ID ? `, doc ${DOC_ID}` : ', dry-run'}) via ${PROXY}`);
  fs.mkdirSync(DL_DIR, { recursive: true });
  await startExtServer();

  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--window-size=1366,900',
    '--disable-blink-features=AutomationControlled', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
  if (PROXY) args.push('--proxy-server=' + PROXY);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, args, userDataDir: PROFILE,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation', '--disable-background-networking', '--disable-component-update', '--disable-default-apps'],
    ignoreHTTPSErrors: true, defaultViewport: { width: 1366, height: 900 },
  });
  try {
    await browser.waitForTarget((t) => t.url().includes(EXT_ID), { timeout: 20000 }).catch(() => {});
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = window.chrome || { runtime: {} };
    });
    await page.setUserAgent((await browser.userAgent()).replace(/HeadlessChrome/g, 'Chrome'));
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR });

    const naChallenge = () => page.evaluate(() => /verifica[çc][ãa]o de seguran[çc]a|n[ãa]o é rob[ôo]/i.test(document.body ? document.body.innerText : '')).catch(() => false);
    const temForm = () => page.evaluate(() => !!document.getElementById('mainForm:txtInscricao1')).catch(() => false);

    const passarDesafio = async () => {
      for (let round = 1; round <= 3; round++) {
        if (!(await naChallenge())) return true;
        log(`  desafio ShieldSquare (round ${round}) — NopeCHA...`);
        let tok = false;
        for (let i = 0; i < 40; i++) { tok = await page.evaluate(() => { const t = document.querySelector('[name="h-captcha-response"], #g-recaptcha-response'); return !!(t && t.value && t.value.length > 20); }).catch(() => false); if (tok) break; await sleep(2000); }
        await page.evaluate(() => { const b = Array.from(document.querySelectorAll('input[type=submit],button,input[type=button]')).find((x) => /submit|enviar|verificar|continuar/i.test(x.value || x.textContent || '')); if (b) b.click(); });
        for (let i = 0; i < 25; i++) { await sleep(2000); if (!(await naChallenge())) return true; }
      }
      return !(await naChallenge());
    };

    // 1) abre + passa desafio
    result.step = 'goto';
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(5000);
    await passarDesafio();

    // 2) consulta (loop até resultado)
    result.step = 'consulta';
    let resultadoTxt = null;
    for (let tent = 1; tent <= 5 && !resultadoTxt; tent++) {
      await passarDesafio();
      if (await temForm()) {
        await page.waitForSelector('#mainForm\\:txtInscricao1', { timeout: 15000 });
        await page.click('#mainForm\\:txtInscricao1', { clickCount: 3 }).catch(() => {});
        await page.type('#mainForm\\:txtInscricao1', cnpj, { delay: 60 });
        await page.click('#mainForm\\:btnConsultar').catch(() => {});
        await sleep(6000);
      }
      await passarDesafio();
      const txt = await page.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ')).catch(() => '');
      if (/situa[çc][ãa]o.*(regular|irregular)|empregador.{0,30}regular/i.test(txt.replace(/.*CNPJ b[áa]sico[^.]*\./i, ''))) resultadoTxt = txt;
      else await sleep(2000);
    }
    if (!resultadoTxt) { await shot(page, 'sem-resultado'); throw new Error('não chegou ao resultado da consulta (ShieldSquare)'); }
    const regular = /REGULAR no FGTS|situa[çc][ãa]o regular|encontra-se em situa[çc][ãa]o regular/i.test(resultadoTxt) && !/irregular/i.test(resultadoTxt);
    log('  situação: ' + (regular ? 'REGULAR' : 'IRREGULAR/indefinida'));
    result.regular = regular;
    await shot(page, 'resultado');

    // 3) abre o certificado (link A4J)
    result.step = 'certificado';
    await page.evaluate(() => { const a = Array.from(document.querySelectorAll('a,input,button')).find((e) => /obtenha.*certificado|certificado de regularidade do fgts/i.test(e.textContent || e.value || '')); if (a) a.click(); });
    await sleep(6000);
    await passarDesafio();
    const certTxt = await page.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ')).catch(() => '');
    await shot(page, 'certificado');

    // 4) parse validade + número
    const mVal = certTxt.match(/Validade:\s*(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/i);
    const mNum = certTxt.match(/Certificado N[úu]mero:\s*([\dA-Za-z]+)/i);
    if (!mVal) { await shot(page, 'sem-validade'); throw new Error('não achei a Validade no certificado (situação pode ser irregular)'); }
    const dataEmissao = brToIso(mVal[1]);
    const dataValidade = brToIso(mVal[2]);
    const numero = mNum ? mNum[1] : null;
    Object.assign(result, { dataEmissao, dataValidade, numero });
    log(`  validade ${mVal[1]} a ${mVal[2]} | nº ${numero}`);

    // 5) gera PDF do certificado — tenta "Visualizar" (PDF oficial), senão printToPDF
    result.step = 'pdf';
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('a,input,button')).find((e) => /^visualizar$/i.test((e.value || e.textContent || '').trim())); if (b) b.click(); });
    await sleep(6000);
    await passarDesafio();
    let pdfBuf = null;
    const baixados = fs.existsSync(DL_DIR) ? fs.readdirSync(DL_DIR).filter((f) => /\.pdf$/i.test(f)) : [];
    if (baixados.length) { pdfBuf = fs.readFileSync(path.join(DL_DIR, baixados[0])); log('  PDF via Visualizar (' + pdfBuf.length + ' bytes)'); }
    if (!pdfBuf) {
      // fallback: imprime a página do certificado em PDF
      const alvo = (await browser.pages()).find((p) => /consulta-crf\.caixa/i.test(p.url())) || page;
      const cli = await alvo.target().createCDPSession();
      const { data } = await cli.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
      pdfBuf = Buffer.from(data, 'base64');
      log('  PDF via printToPDF (' + pdfBuf.length + ' bytes)');
    }
    result.tamanho = pdfBuf.length;

    // 6) grava no documento
    if (DOC_ID) {
      const dbPath = path.join(__dirname, 'data', 'tenants', TENANT, 'pncp.db');
      const db = new Database(dbPath);
      try {
        const doc = db.prepare('SELECT * FROM habilitacao_documentos WHERE id = ?').get(DOC_ID);
        if (!doc) throw new Error(`documento ${DOC_ID} não existe`);
        const destDir = path.join(__dirname, 'public', 'uploads', 'habilitacao', String(DOC_ID));
        fs.mkdirSync(destDir, { recursive: true });
        const destName = `crf-fgts-${dataValidade}.pdf`;
        fs.writeFileSync(path.join(destDir, destName), pdfBuf);
        const rel = path.relative(path.join(__dirname, 'public'), path.join(destDir, destName)).replace(/\\/g, '/');
        db.prepare(`UPDATE habilitacao_documentos SET
            orgaoEmissor = COALESCE(NULLIF(orgaoEmissor,''),'Caixa Econômica Federal'), esfera='federal',
            numero=?, dataEmissao=?, dataValidade=?,
            arquivo=?, arquivoNome=?, arquivoMime='application/pdf', arquivoTamanho=?,
            origem='automatico', ultimaBuscaAuto=CURRENT_TIMESTAMP, dataAtualizacao=CURRENT_TIMESTAMP
          WHERE id=?`).run(numero || doc.numero, dataEmissao, dataValidade, rel, destName, pdfBuf.length, DOC_ID);
        result.arquivo = rel;
        log(`  ✓ documento ${DOC_ID} atualizado (${rel})`);
      } finally { db.close(); }
    }
    result.ok = true;
    result.step = 'done';
  } finally {
    await browser.close().catch(() => {});
    try { fs.rmSync(DL_DIR, { recursive: true, force: true }); } catch {}
  }
  return result;
}

main()
  .then((r) => { console.log('__RESULT__ ' + JSON.stringify(r)); process.exit(r.ok ? 0 : 2); })
  .catch((e) => { console.log('__RESULT__ ' + JSON.stringify({ ok: false, error: e.message, step: 'exception' })); log('ERRO:', e.stack || e.message); process.exit(2); });
