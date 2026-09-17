// pcp-edital-download.js
//
// Registra no PCP o download do aviso/edital — pré-requisito do portal para
// QUALQUER manifestação do fornecedor (proposta, esclarecimento, impugnação).
// Enquanto não está registrado, /Pregoes/RegistroProposta/ devolve uma página
// sem formulário e sem itens ("Retorne para a página de dados do processo"),
// o que por fora parece falha das declarações.
//
// O modal de download (/4/Pregoes/Download/Arquivo/) exige reCAPTCHA v2, então
// não há caminho por HTTP puro: o POST sem token responde "Preencha o campo
// abaixo novamente!". Aqui abrimos um Chrome real com a extensão NopeCHA (a
// mesma engrenagem dos session-services BLL/BNC, force-installed por política
// em /etc/opt/chrome/policies), injetamos os cookies da sessão IIS já
// autenticada pelo pcp-client, esperamos o token e submetemos o form.
//
// O Chrome precisa de display, e o server.js não roda sob X — por isso este
// arquivo tem dois modos:
//   registrarDownloadEdital(db, chave)        → spawn de si mesmo sob xvfb-run
//   node pcp-edital-download.js <db> <chave>  → imprime o JSON do resultado
//
// Custo: 1 solve pago de captcha por edital (só quando o portal está bloqueando).

'use strict';

const { execFile } = require('child_process');

const BASE = 'https://operacao.portaldecompraspublicas.com.br';
const CHROME = '/usr/bin/google-chrome-stable';
const EXT_ID = 'ogomknllijkjboianknlncoagialpnlm'; // NopeCHA
const SOLVE_TIMEOUT_MS = 180000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A chave do solver vem do ambiente (unit) ou da config do tenant.
function chaveNopecha(db) {
  if (process.env.NOPECHA_KEY) return process.env.NOPECHA_KEY.trim();
  try {
    const r = db.prepare("SELECT valor FROM config WHERE chave='nopecha_key'").get();
    if (r && r.valor) return String(r.valor).trim();
  } catch (e) {}
  return '';
}

function linksDownload(html) {
  return [...html.matchAll(/<a\b[^>]*class="[^"]*downloadEdital[^"]*"[^>]*href="([^"]+)"/gi)]
    .map((m) => m[1].replace(/&amp;/g, '&'));
}

function jaRegistrado(html) {
  return /Download\s+j[áa]\s+realizado/i.test(html.replace(/<[^>]+>/g, ' '));
}

// ─── modo servidor: delega ao processo com display ──────────────────────────

function registrarDownloadEdital(db, chave) {
  const key = chaveNopecha(db);
  if (!key) {
    return Promise.resolve({ ok: false, erro: 'sem chave NopeCHA (env NOPECHA_KEY ou config nopecha_key)' });
  }
  return new Promise((resolve) => {
    execFile('/usr/bin/xvfb-run', ['-a', process.execPath, __filename, db.name, String(chave)], {
      timeout: SOLVE_TIMEOUT_MS + 60000,
      env: Object.assign({}, process.env, { NOPECHA_KEY: key }),
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const ultima = String(stdout || '').trim().split('\n').filter(Boolean).pop() || '';
      try {
        const j = JSON.parse(ultima);
        if (j && typeof j.ok === 'boolean') return resolve(j);
      } catch (e) {}
      resolve({ ok: false, erro: (err && err.message) || String(stderr || '').slice(-300) || 'saída inesperada do downloader' });
    });
  });
}

// ─── modo CLI: Chrome + extensão ────────────────────────────────────────────

async function executar(dbPath, chave) {
  const Database = require('better-sqlite3');
  const puppeteer = require('puppeteer-core');
  const { fetchPcpHtml, getJars } = require('./pcp-client');

  const db = new Database(dbPath, { readonly: true });
  const dpUrl = `${BASE}/4/Pregoes/DadosPregao/?ttCD_CHAVE=${encodeURIComponent(chave)}`;

  const dados = await fetchPcpHtml(db, dpUrl);
  if (jaRegistrado(dados.body)) return { ok: true, jaEstava: true };
  const hrefs = linksDownload(dados.body);
  if (!hrefs.length) return { ok: false, erro: 'nenhum link de download de edital na página do processo' };

  const jars = await getJars(db);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false, // a extensão só resolve o captcha num Chrome de verdade (daí o xvfb)
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=pt-BR',
      '--disable-dev-shm-usage', '--window-size=1366,900'],
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation', '--disable-background-networking',
      '--disable-component-update', '--disable-default-apps'],
    ignoreHTTPSErrors: true,
    defaultViewport: { width: 1366, height: 900 },
  });

  try {
    await browser.waitForTarget((t) => t.url().includes(EXT_ID), { timeout: 30000 })
      .catch(() => { throw new Error('extensão NopeCHA não carregou no Chrome'); });
    // Sem a key semeada o solve cai no tier grátis (fila longa) ou não acontece.
    let semeada = false;
    for (let i = 0; i < 10 && !semeada; i++) {
      const t = browser.targets().find((x) => x.type() === 'service_worker' && x.url().includes(EXT_ID));
      if (t) {
        try {
          const w = await t.worker();
          await w.evaluate((k) => new Promise((r) => chrome.storage.local.set({ key: k }, () => r(1))), process.env.NOPECHA_KEY);
          semeada = true;
        } catch (e) { await sleep(800); }
      } else await sleep(800);
    }

    const page = await browser.newPage();
    for (const host of Object.keys(jars)) {
      for (const [name, value] of Object.entries(jars[host])) {
        await page.setCookie({ name, value, domain: host, path: '/' }).catch(() => {});
      }
    }

    for (const href of hrefs) {
      const url = BASE + href;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const t0 = Date.now();
      let token = '';
      while (Date.now() - t0 < SOLVE_TIMEOUT_MS) {
        token = await page.evaluate(() => {
          const t = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]');
          return t ? t.value : '';
        }).catch(() => '');
        if (token && token.length > 20) break;
        await sleep(2000);
      }
      if (!token) return { ok: false, erro: 'captcha do download não foi resolvido em ' + (SOLVE_TIMEOUT_MS / 1000) + 's', semeada };
      await page.evaluate(() => { const b = document.querySelector('#btGravar'); if (b) b.click(); });
      await sleep(6000);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Fonte da verdade é a página do processo, não a resposta do modal.
  const conf = await fetchPcpHtml(db, dpUrl);
  if (jaRegistrado(conf.body)) return { ok: true, arquivos: hrefs.length };
  return { ok: false, erro: 'o portal continua marcando o download como não realizado' };
}

if (require.main === module) {
  const [, , dbPath, chave] = process.argv;
  if (!dbPath || !chave) {
    console.log(JSON.stringify({ ok: false, erro: 'uso: node pcp-edital-download.js <caminho-do-db> <chave>' }));
    process.exit(1);
  }
  executar(dbPath, chave)
    .then((r) => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(1); });
}

module.exports = { registrarDownloadEdital };
