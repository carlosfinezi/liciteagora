#!/usr/bin/env node
/**
 * test-nova-nota-ui.js — a tela de NF manual, em Chrome headless.
 *
 * O `npm run verify` só passa `node --check` nos .js da raiz: um erro de sintaxe
 * no <script> inline de um HTML passa verde e derruba a tela só no navegador.
 * Este teste fecha esse buraco para a nova-nota.html.
 *
 * Sobe um Express servindo `public/` + as rotas de que a tela depende, apontado
 * para o tenant `labfiscal`, e dirige o Chrome local. A página precisa rodar
 * DENTRO de um iframe: sidebar.js redireciona carga top-level para /app.html.
 *
 * Uso: node scripts/test-nova-nota-ui.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const express = require(BASE + '/node_modules/express');
const Database = require(BASE + '/node_modules/better-sqlite3');
const puppeteer = require(BASE + '/node_modules/puppeteer-core');

const PORTA = 34119;
const DB_PATH = BASE + '/data/tenants/labfiscal/pncp.db';
const db = new Database(DB_PATH);

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

// ─── Massa própria ──────────────────────────────────────────────────────────
// Não depender de outro teste da bateria: o de integração limpa fiscal_regras_trib
// ao terminar, e a ordem de execução não é garantida.
function prepararMassa() {
  const temForn = db.prepare('SELECT COUNT(*) c FROM fornecedor WHERE id = 1').get().c;
  if (!temForn) db.prepare("INSERT INTO fornecedor (id, razaoSocial) VALUES (1, 'Lab Fiscal')").run();
  db.prepare("UPDATE fornecedor SET regimeTributario = 'NAO_OPTANTE', uf = 'TO' WHERE id = 1").run();

  db.prepare('DELETE FROM fiscal_regras_trib').run();
  db.prepare(`INSERT INTO fiscal_regras_trib
      (descricao, prioridade, ativo, regimeEmitente, ncmPrefixo, cstIcms, modBC, pIcms, pRedBC,
       cstPis, pPis, cstCofins, pCofins)
    VALUES ('Fertilizante 3105 c/ reducao', 10, 1, 3, '3105', '20', 3, 12, 78.95, '01', 1.65, '01', 7.6)`).run();

  if (!db.prepare("SELECT id FROM pessoas WHERE cpfCnpj = '11444777000161'").get()) {
    db.prepare(`INSERT INTO pessoas (razaoSocial, cpfCnpj, tipo, uf, cidade, endereco, numero, bairro, cep, codigoMunicipio)
      VALUES ('CLIENTE LAB LTDA', '11444777000161', 'juridica', 'TO', 'PALMAS', 'AV TESTE', '100', 'CENTRO', '77000000', '1721000')`).run();
  }
  if (!db.prepare("SELECT id FROM produtos WHERE sku = 'LAB-FERT-01'").get()) {
    db.prepare(`INSERT INTO produtos (sku, descricao, ncm, unidade, precoVenda, origem)
      VALUES ('LAB-FERT-01', 'FERTILIZANTE LAB 10L', '31051000', 'UN', 100, '0')`).run();
  }
}
prepararMassa();

// ─── Servidor: estáticos + as rotas que a tela consome ──────────────────────
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, username: 'admin', role: 'admin' }; next(); });

require(BASE + '/nf-avulsa-routes').registrarRotasNfAvulsa(app, db);

// Stubs mínimos das rotas de apoio — o alvo do teste é a tela, não elas.
app.get('/api/tipos-operacao', (req, res) => {
  const tipos = db.prepare(`SELECT * FROM tipos_operacao WHERE ativo = 1 AND usarEmNFAvulsa = 1`).all();
  res.json({ success: true, tipos });
});
app.get('/api/pessoas/autocomplete', (req, res) => {
  const like = `%${String(req.query.q || '').toLowerCase()}%`;
  const pessoas = db.prepare(
    `SELECT id, cpfCnpj, tipo, razaoSocial, uf FROM pessoas
      WHERE LOWER(razaoSocial) LIKE ? OR cpfCnpj LIKE ? LIMIT 10`).all(like, like);
  res.json({ success: true, pessoas });
});
app.get('/api/produtos/autocomplete', (req, res) => {
  const like = `%${String(req.query.q || '').toLowerCase()}%`;
  const produtos = db.prepare(
    `SELECT id, sku, descricao, unidade, precoVenda FROM produtos
      WHERE LOWER(sku) LIKE ? OR LOWER(descricao) LIKE ? LIMIT 10`).all(like, like);
  res.json({ success: true, produtos });
});
app.get('/api/produtos/:id', (req, res) => {
  const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(Number(req.params.id));
  res.json({ success: true, produto });
});

// Wrapper com iframe: sem window.__liciteShell o sidebar.js chuta a página para /app.html.
app.get('/__wrapper', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <script>window.__liciteShell = true;</script></head>
    <body style="margin:0"><iframe id="f" src="/fiscal/nova-nota.html"
      style="width:100vw;height:100vh;border:0"></iframe></body></html>`);
});
app.use(express.static(BASE + '/public'));

const server = app.listen(PORTA);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    userDataDir: '/tmp/chrome-test-nova-nota',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const errosJS = [];
  page.on('pageerror', e => errosJS.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error') errosJS.push('console: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${PORTA}/__wrapper`, { waitUntil: 'networkidle0' });
  const frame = page.frames().find(f => f.url().includes('nova-nota.html'));

  secao('Carga da página');
  assert(!!frame, 'iframe da tela carregou');
  const semErroFatal = errosJS.filter(e => !/favicon|404/i.test(e));
  assert(semErroFatal.length === 0, 'nenhum erro de JavaScript na carga',
    semErroFatal.slice(0, 3).join('\n      '));

  await frame.waitForSelector('#tipoOperacaoId', { timeout: 5000 });
  const nOpcoes = await frame.$eval('#tipoOperacaoId', el => el.options.length);
  assert(nOpcoes > 1, `select de operação populado (${nOpcoes - 1} operações com usarEmNFAvulsa)`);

  secao('Montagem da nota');
  // Destinatário via autocomplete
  await frame.type('#destBusca', 'CLIENTE');
  await frame.waitForFunction(() => {
    const l = document.getElementById('destLista');
    return l && l.style.display === 'block' && l.children.length > 0;
  }, { timeout: 5000 });
  await frame.evaluate(() => document.getElementById('destLista').children[0].click());
  const cli = await frame.evaluate(() => eval('clienteId'));
  assert(!!cli, 'destinatário selecionado pelo autocomplete');

  // Operação
  await frame.evaluate(() => {
    const s = document.getElementById('tipoOperacaoId');
    s.value = s.options[1].value;
    s.dispatchEvent(new Event('change'));
  });
  const hint = await frame.$eval('#hintOperacao', el => el.textContent);
  assert(hint.length > 0, `operação mostra os efeitos ("${hint}")`);

  // Produto via autocomplete
  await frame.type('#prodBusca', 'FERTILIZANTE');
  await frame.waitForFunction(() => {
    const l = document.getElementById('prodLista');
    return l && l.style.display === 'block' && l.children.length > 0;
  }, { timeout: 5000 });
  await frame.evaluate(() => document.getElementById('prodLista').children[0].click());
  await frame.waitForFunction(() => eval('typeof itens !== "undefined" && itens.length === 1'), { timeout: 5000 });
  const it0 = await frame.evaluate(() => eval('itens[0]'));
  assert(it0.ncm === '31051000', `NCM veio do cadastro do produto (${it0.ncm})`);

  // Quantidade e preço
  await frame.evaluate(() => { eval('itens[0].quantidade = 3; itens[0].precoUnitario = 50; renderItens();'); });
  const totalTxt = await frame.$eval('#tProdutos', el => el.textContent);
  assert(totalTxt === '150,00', `total de produtos 150,00 (veio ${totalTxt})`);

  secao('Tributação por item');
  await frame.evaluate(() => window.abrirModalTrib(0));
  const modalAberto = await frame.$eval('#modalTrib', el => el.style.display === 'flex');
  assert(modalAberto, 'modal de tributação abre');
  await frame.evaluate(() => {
    document.getElementById('mInfAdProd').value = 'LOTE 2508-29116 VALID 13.08.2027';
    window.salvarTribItem();
  });
  const inf = await frame.evaluate(() => eval('itens[0].infAdProd'));
  assert(/LOTE/.test(inf || ''), 'informação adicional do item gravada no modelo');

  secao('Salvar e calcular impostos');
  await frame.evaluate(() => window.salvar());
  await frame.waitForFunction(() => eval('typeof notaId !== "undefined" && notaId != null'), { timeout: 8000 });
  const notaId = await frame.evaluate(() => eval('notaId'));
  assert(!!notaId, `rascunho salvo (id ${notaId})`);

  const noBanco = db.prepare('SELECT numero, status, valorTotal FROM faturas WHERE id = ?').get(notaId);
  assert(noBanco && noBanco.status === 'rascunho', 'gravado como rascunho no banco');
  assert(noBanco && Number(noBanco.valorTotal) === 150, `total 150,00 no banco (veio ${noBanco && noBanco.valorTotal})`);

  await frame.evaluate(() => window.calcularImpostos());
  await frame.waitForFunction(() => eval('itens[0] && itens[0]._trib'), { timeout: 8000 });
  const trib = await frame.evaluate(() => eval('itens[0]._trib'));
  assert(trib.ok, 'prévia calculou o item', trib.erro);
  assert(trib.icms && trib.icms.CST === '20', `CST 20 na tela (veio ${trib.icms && trib.icms.CST})`);
  assert(trib.icms && trib.icms.vICMS === '3.79', `ICMS 3,79 na tela (veio ${trib.icms && trib.icms.vICMS})`);

  const badge = await frame.$eval('#itensBody', el => el.textContent);
  assert(/ICMS/.test(badge), 'coluna Tributação mostra o resultado');
  const memoriaVisivel = await frame.$eval('#panelMemoria', el => el.style.display !== 'none');
  assert(memoriaVisivel, 'painel de memória de cálculo aparece');
  const memTxt = await frame.$eval('#memoriaConteudo', el => el.textContent);
  assert(/REDUCAOBASE/.test(memTxt), 'memória exibe a fórmula da redução de base');

  secao('Erros de JavaScript ao longo do fluxo');
  const errosFinais = errosJS.filter(e => !/favicon|404/i.test(e));
  assert(errosFinais.length === 0, 'nenhum erro de JS durante a interação',
    errosFinais.slice(0, 5).join('\n      '));

  // Limpeza da massa criada pela UI
  db.prepare('DELETE FROM fatura_itens WHERE faturaId = ?').run(notaId);
  db.prepare('DELETE FROM faturas WHERE id = ?').run(notaId);

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
