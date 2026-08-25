#!/usr/bin/env node
/**
 * test-regras-tributarias-ui.js — a tela da matriz de regras, em Chrome headless.
 *
 * Mesma motivação do test-nova-nota-ui: o `npm run verify` não olha o <script>
 * inline de um HTML, então um erro lá passa verde e só quebra no navegador.
 *
 * Uso: node scripts/test-regras-tributarias-ui.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const express = require(BASE + '/node_modules/express');
const Database = require(BASE + '/node_modules/better-sqlite3');
const puppeteer = require(BASE + '/node_modules/puppeteer-core');
const { registrarRotasFiscalRegras } = require(BASE + '/fiscal-regras-routes');

const PORTA = 34123;
const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

// Massa própria
db.prepare('DELETE FROM fiscal_regras_trib').run();
if (!db.prepare('SELECT COUNT(*) c FROM fornecedor WHERE id = 1').get().c) {
  db.prepare("INSERT INTO fornecedor (id, razaoSocial) VALUES (1, 'Lab Fiscal')").run();
}
db.prepare("UPDATE fornecedor SET regimeTributario = 'NAO_OPTANTE', uf = 'TO' WHERE id = 1").run();

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, role: 'admin' }; next(); });
registrarRotasFiscalRegras(app, db);
app.get('/api/tipos-operacao', (_req, res) => {
  res.json({ success: true, tipos: db.prepare('SELECT * FROM tipos_operacao WHERE ativo = 1').all() });
});
app.get('/__wrapper', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <script>window.__liciteShell = true;</script></head>
    <body style="margin:0"><iframe src="/fiscal/regras-tributarias.html"
      style="width:100vw;height:100vh;border:0"></iframe></body></html>`);
});
app.use(express.static(BASE + '/public'));
const server = app.listen(PORTA);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    userDataDir: '/tmp/chrome-test-regras',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });

  const errosJS = [];
  page.on('pageerror', e => errosJS.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error') errosJS.push('console: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${PORTA}/__wrapper`, { waitUntil: 'networkidle0' });
  const frame = page.frames().find(f => f.url().includes('regras-tributarias.html'));

  secao('Carga');
  assert(!!frame, 'iframe da tela carregou');
  assert(errosJS.filter(e => !/favicon|404/i.test(e)).length === 0, 'sem erro de JS na carga',
    errosJS.slice(0, 3).join('\n      '));

  await frame.waitForSelector('#corpo', { timeout: 5000 });
  const vazio = await frame.$eval('#corpo', el => el.textContent);
  assert(/Nenhuma regra/.test(vazio), 'estado vazio explica a consequência de não haver regra');

  secao('Cadastro pela tela');
  await frame.evaluate(() => window.abrirNova());
  assert(await frame.$eval('#modalRegra', el => el.style.display === 'flex'), 'modal de nova regra abre');

  const nCst = await frame.$eval('#rCstIcms', el => el.options.length);
  assert(nCst > 5, `select de CST populado pela API (${nCst - 1} opções)`);

  await frame.evaluate(() => {
    document.getElementById('rDescricao').value = 'Fertilizante 3105 pela tela';
    document.getElementById('rRegimeEmitente').value = '3';
    document.getElementById('rNcmPrefixo').value = '3105';
    document.getElementById('rCstIcms').value = '20';
    document.getElementById('rModBC').value = '3';
    document.getElementById('rPIcms').value = '12';
    document.getElementById('rPRedBC').value = '78.95';
    document.getElementById('rCstPis').value = '01';
    document.getElementById('rPPis').value = '1.65';
    document.getElementById('rCstCofins').value = '01';
    document.getElementById('rPCofins').value = '7.6';
    window.salvarRegra();
  });
  await frame.waitForFunction(() => eval('regras.length === 1'), { timeout: 8000 });

  const gravada = db.prepare('SELECT * FROM fiscal_regras_trib').get();
  assert(gravada && gravada.pRedBC === 78.95, `regra gravada no banco pela tela (redução ${gravada && gravada.pRedBC})`);
  assert(gravada && gravada.cstIcms === '20', 'CST veio do select');

  const linha = await frame.$eval('#corpo', el => el.textContent);
  assert(/Fertilizante 3105 pela tela/.test(linha), 'aparece na grade');
  assert(/CST 20/.test(linha), 'grade mostra o CST');
  assert(/NCM: 3105/.test(linha), 'grade mostra o contexto de aplicação');

  secao('Validação chega na tela');
  await frame.evaluate(() => window.abrirNova());
  await frame.evaluate(() => {
    document.getElementById('rDescricao').value = 'Invalida';
    document.getElementById('rRegimeEmitente').value = '3';
    window.salvarRegra();  // regime normal sem CST
  });
  await frame.waitForFunction(
    () => document.getElementById('alertBox').textContent.includes('CST'), { timeout: 8000 });
  const msg = await frame.$eval('#alertBox', el => el.textContent);
  assert(/regime normal precisa/.test(msg), `erro do servidor exibido ("${msg.slice(0, 60)}…")`);
  await frame.evaluate(() => window.fecharModal());

  secao('Simulador');
  await frame.evaluate(() => window.abrirSimulador());
  assert(await frame.$eval('#modalSim', el => el.style.display === 'flex'), 'modal do simulador abre');
  await frame.evaluate(() => {
    document.getElementById('sCrt').value = '3';
    document.getElementById('sNcm').value = '31051000';
    document.getElementById('sUfOrigem').value = 'TO';
    document.getElementById('sUfDestino').value = 'TO';
    document.getElementById('sVProd').value = '1';
    window.simular();
  });
  await frame.waitForFunction(
    () => document.getElementById('simResultado').textContent.includes('vence'), { timeout: 8000 });
  const res = await frame.$eval('#simResultado', el => el.textContent);
  assert(/vence/.test(res), 'mostra qual regra vence');
  assert(/especificidade 2/.test(res), 'explica a especificidade que decidiu');
  assert(/0,03/.test(res), 'mostra o ICMS calculado (0,03 — o valor do ERP de referência)');
  assert(/REDUCAOBASE/.test(res), 'mostra a memória de cálculo');

  secao('Duplicar e excluir');
  const idRegra = gravada.id;
  await frame.evaluate((id) => window.duplicar(id), idRegra);
  await frame.waitForFunction(() => eval('regras.length === 2'), { timeout: 8000 });
  const nDup = db.prepare("SELECT COUNT(*) c FROM fiscal_regras_trib WHERE descricao LIKE '%cópia%'").get().c;
  assert(nDup === 1, 'duplicata criada pela tela');
  await frame.evaluate(() => window.fecharModal());

  const idCopia = db.prepare("SELECT id FROM fiscal_regras_trib WHERE descricao LIKE '%cópia%'").get().id;
  await frame.evaluate((id) => {
    window.confirm = () => true;   // o handler pede confirmação
    return window.excluir(id);
  }, idCopia);
  await frame.waitForFunction(() => eval('regras.length === 1'), { timeout: 8000 });
  const sobrou = db.prepare('SELECT COUNT(*) c FROM fiscal_regras_trib').get().c;
  assert(sobrou === 1, 'exclusão pela tela removeu a cópia');

  secao('Camada 3 — alíquotas por UF e vigência na tela');
  await frame.evaluate(() => window.abrirAliquotas());
  await frame.waitForFunction(
    () => document.getElementById('ufConteudo').textContent.includes('UF') ||
          document.querySelectorAll('#ufConteudo tbody tr').length > 0, { timeout: 8000 });
  const nUf = await frame.$$eval('#ufConteudo tbody tr', els => els.length);
  assert(nUf === 27, `27 UFs na tela (veio ${nUf})`);
  const resumoUf = await frame.$eval('#ufResumo', el => el.textContent);
  assert(/0 de 27/.test(resumoUf), `resumo mostra quantas faltam ("${resumoUf}")`);

  await frame.evaluate(() => {
    document.getElementById('uf_GO_aliq').value = '19';
    document.getElementById('uf_GO_fcp').value = '2';
    window.salvarUf('GO');
  });
  await frame.waitForFunction(
    () => document.getElementById('ufResumo').textContent.includes('1 de 27'), { timeout: 8000 });
  const go = db.prepare("SELECT * FROM fiscal_aliquotas_uf WHERE uf = 'GO'").get();
  assert(go && go.aliquotaInterna === 19 && go.pFcp === 2, 'alíquota de GO gravada pela tela');
  await frame.evaluate(() => window.fecharAliquotas());

  // Vigência aparece na grade
  await frame.evaluate(() => window.abrirNova());
  await frame.evaluate(() => {
    document.getElementById('rDescricao').value = 'Regra com vigencia 2026';
    document.getElementById('rRegimeEmitente').value = '3';
    document.getElementById('rCstIcms').value = '00';
    document.getElementById('rModBC').value = '3';
    document.getElementById('rPIcms').value = '18';
    document.getElementById('rVigenciaInicio').value = '2026-01-01';
    document.getElementById('rVigenciaFim').value = '2026-12-31';
    document.getElementById('rCodBenef').value = 'TO800001';
    window.salvarRegra();
  });
  await frame.waitForFunction(
    () => document.getElementById('corpo').textContent.includes('vigente'), { timeout: 8000 });
  const grade = await frame.$eval('#corpo', el => el.textContent);
  assert(/vigente: 01\/01\/2026/.test(grade), 'grade mostra a vigência em formato brasileiro');
  assert(/cBenef TO800001/.test(grade), 'grade mostra o código de benefício');

  db.prepare('UPDATE fiscal_aliquotas_uf SET aliquotaInterna = NULL, pFcp = NULL').run();

  secao('Erros de JavaScript no fluxo todo');
  // A seção de validação provoca UM 400 de propósito (regime normal sem CST) e o
  // navegador loga isso no console. Tolera-se exatamente esse; qualquer 400 a mais
  // — ou qualquer outro erro — é falha de verdade.
  const finais = errosJS.filter(e => !/favicon|404/i.test(e));
  const esperados400 = finais.filter(e => /status of 400/.test(e));
  const inesperados = finais.filter(e => !/status of 400/.test(e));
  assert(inesperados.length === 0, 'nenhum erro de JS inesperado', inesperados.slice(0, 5).join('\n      '));
  assert(esperados400.length === 1,
    `exatamente 1 resposta 400 — a da validação deliberada (vieram ${esperados400.length})`);

  db.prepare('DELETE FROM fiscal_regras_trib').run();
  await browser.close();
  server.close();
  db.close();
  console.log(`\n${'─'.repeat(56)}`);
  console.log(fail === 0 ? `TODOS OS ${ok} ASSERTS PASSARAM` : `${ok} OK · ${fail} FALHARAM`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('ERRO FATAL:', err);
  try { server.close(); } catch {}
  process.exit(1);
});
