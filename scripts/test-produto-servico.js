/**
 * test-produto-servico.js — produto que é serviço não tem estoque, e por isso
 * não falta, não reserva e não se compra.
 *
 * O defeito que isto guarda estava no ar: um orçamento com "Hora técnica
 * avulsa" mostrava o aviso "Sem saldo para 1 item", oferecia o botão "Comprar
 * faltantes" e pedia a compra de 7 unidades de hora técnica. Vinha de
 * `explodirItensPedido`, por onde passam os QUATRO caminhos de estoque de um
 * pedido: criar reserva, calcular a falta, completar reserva por lote e as
 * necessidades consolidadas de compra.
 *
 * A prova que importa é a de dentro para fora: o serviço sai, e o produto
 * físico sem saldo CONTINUA faltando. Um filtro largo demais passaria no
 * primeiro teste e esconderia o estoque inteiro.
 *
 * Roda da raiz do projeto: `node scripts/test-produto-servico.js`
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const RAIZ = path.join(__dirname, '..');
const { lerSchema } = require('./schema-de-tenant');
const {
  explodirItensPedido, calcularFaltaPedido, criarReservasPedido,
} = require(path.join(RAIZ, 'reservas-routes'));
const { registrarRotasProdutos } = require(path.join(RAIZ, 'produtos-routes'));

let ok = 0, fail = 0;
function t(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

// ---------------------------------------------------------------- banco
const DB = '/tmp/vp-produto-servico-' + process.pid + '.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(lerSchema());

// ---------------------------------------------------------------- semente
// Um serviço (hora técnica), um produto físico COM saldo e um SEM saldo. O
// terceiro é o controle: se ele parar de faltar, o filtro pegou demais.
const idServico = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ehServico, ativo)
  VALUES ('SRV-HORA', 'Hora técnica avulsa', 'H', 180, 1, 1)`).run().lastInsertRowid;
const idComSaldo = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo)
  VALUES ('NB-001', 'Notebook 14 polegadas', 'UN', 4200, 1)`).run().lastInsertRowid;
const idSemSaldo = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo)
  VALUES ('MON-24', 'Monitor 24 polegadas', 'UN', 980, 1)`).run().lastInsertRowid;

db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, data)
  VALUES (?, 'entrada', 10, datetime('now'))`).run(idComSaldo);

db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, ativo)
  VALUES ('11222333000181', 'juridica', 'Cliente de Teste', 1)`).run();

const pedidoId = db.prepare(`INSERT INTO pedidos
  (numero, tipo, clienteId, status, dataPedido, valorTotal, modoDocumento)
  VALUES ('ORC-1', 'venda', 1, 'confirmado', date('now'), 7000, 'orcamento')`).run().lastInsertRowid;

const item = db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
  VALUES (?, ?, ?, ?, ?, ?)`);
item.run(pedidoId, idServico, 'Hora técnica avulsa', 7, 180, 1260);   // o que pedia compra
item.run(pedidoId, idComSaldo, 'Notebook 14 polegadas', 2, 4200, 8400);
item.run(pedidoId, idSemSaldo, 'Monitor 24 polegadas', 3, 980, 2940);

// ---------------------------------------------------------------- schema
console.log('A. a marcação existe no schema de todo tenant');

t('A1 a coluna ehServico é declarada pelo db-schema', () => {
  const cols = db.prepare('PRAGMA table_info(produtos)').all().map(c => c.name);
  assert(cols.includes('ehServico'), 'produtos.ehServico não existe no schema');
});

t('A2 ela nasce em 0: produto existente não vira serviço de repente', () => {
  const p = db.prepare('SELECT ehServico FROM produtos WHERE id = ?').get(idComSaldo);
  assert(Number(p.ehServico) === 0, 'o default não é 0: ' + p.ehServico);
});

t('A3 a marcação NÃO foi para `tipoProduto`, que já tem dois vocabulários', () => {
  const esquema = ler('db-schema.js');
  assert(/'ehServico INTEGER DEFAULT 0'/.test(esquema), 'a coluna saiu do db-schema');
  // 'servico' em tipoProduto seria recusado pelo import, que valida 00..07/99.
  const imp = ler('produtos-import.js');
  assert(/TIPOS_SEFAZ/.test(imp), 'o import deixou de validar tipoProduto — reveja a escolha da coluna');
  assert(!/tipoProduto\s*===\s*'servico'/.test(ler('reservas-routes.js')),
    'o filtro voltou a usar tipoProduto');
});

// ---------------------------------------------------------------- estoque
console.log('\nB. o serviço sai dos quatro caminhos de estoque');

t('B1 a explosão do pedido não devolve a linha do serviço', () => {
  const ids = explodirItensPedido(db, pedidoId).map(i => i.produtoId);
  assert(!ids.includes(idServico), 'a hora técnica continua na explosão de estoque');
  assert(ids.includes(idComSaldo) && ids.includes(idSemSaldo),
    'a explosão perdeu os produtos físicos: ' + JSON.stringify(ids));
});

t('B2 a falta do pedido ignora o serviço e mantém o físico sem saldo', () => {
  const falta = calcularFaltaPedido(db, pedidoId);
  const porId = new Map(falta.map(l => [l.produtoId, l]));
  assert(!porId.has(idServico), 'o serviço aparece na conta de falta');
  const mon = porId.get(idSemSaldo);
  assert(mon, 'o monitor sem saldo deixou de ser calculado — o filtro pegou demais');
  assert(Number(mon.faltando) === 3, 'faltando do monitor: ' + mon.faltando);
  const nb = porId.get(idComSaldo);
  assert(nb && Number(nb.faltando) === 0, 'o notebook tem saldo e não deveria faltar');
});

t('B3 era isto que pedia "comprar 7 unidades de hora técnica"', () => {
  const faltantes = calcularFaltaPedido(db, pedidoId).filter(l => Number(l.faltando) > 0);
  assert(!faltantes.some(l => l.produtoId === idServico),
    'o aviso "Sem saldo" e o botão "Comprar faltantes" voltariam a listar o serviço');
  assert(faltantes.length === 1 && faltantes[0].produtoId === idSemSaldo,
    'o único faltante tem de ser o monitor: ' + JSON.stringify(faltantes.map(f => f.sku)));
});

t('B4 confirmar o pedido não gera insuficiência de serviço (era o 409 na cara)', () => {
  const { insuficiencias } = criarReservasPedido(db, pedidoId);
  assert(!insuficiencias.some(i => i.produtoId === idServico),
    'o serviço gera insuficiência e o modal de falta abre na confirmação');
  assert(insuficiencias.some(i => i.produtoId === idSemSaldo),
    'o monitor sem saldo parou de gerar insuficiência — a guarda de estoque sumiu');
});

t('B5 o serviço não reserva saldo nenhum', () => {
  const r = db.prepare('SELECT COUNT(*) c FROM reservas_estoque WHERE produtoId = ?').get(idServico);
  assert(r.c === 0, 'há ' + r.c + ' reserva(s) de hora técnica');
});

// A sabotagem ao contrário: desmarcando o serviço, o defeito VOLTA. É o que
// prova que o teste mede o filtro, e não outra coisa qualquer do caminho.
t('B6 desmarcado, o mesmo item volta a pedir compra (o teste reprova o defeito)', () => {
  db.prepare('UPDATE produtos SET ehServico = 0 WHERE id = ?').run(idServico);
  const voltou = calcularFaltaPedido(db, pedidoId).find(l => l.produtoId === idServico);
  db.prepare('UPDATE produtos SET ehServico = 1 WHERE id = ?').run(idServico);
  assert(voltou && Number(voltou.faltando) === 7,
    'sem a marcação o item deveria faltar 7 — se não falta, o teste não está medindo o filtro');
});

// ---------------------------------------------------------------- cadastro
console.log('\nC. o cadastro grava e devolve a marcação');

const app = express();
app.use(express.json());
registrarRotasProdutos(app, db);
const achar = (p, metodo) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[metodo]);
  if (!l) throw new Error(`rota não registrada: ${metodo.toUpperCase()} ${p}`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
function chamar(handler, { params = {}, body = {} } = {}) {
  let out = null, st = 200;
  const res = { json: o => { out = o; return res; }, status: c => { st = c; return res; } };
  handler({ params, body, query: {}, session: { username: 'teste' }, user: { username: 'teste' } }, res);
  return { out, st };
}

t('C1 POST /api/produtos grava o serviço', () => {
  const { out } = chamar(achar('/api/produtos', 'post'), {
    body: { sku: 'SRV-SITE', descricao: 'Criação de site institucional', unidade: 'UN',
            precoVenda: 4800, ehServico: true },
  });
  assert(out && out.success, 'não gravou: ' + JSON.stringify(out));
  assert(Number(out.produto.ehServico) === 1, 'ehServico não foi gravado: ' + out.produto.ehServico);
});

t('C2 PUT /api/produtos/:id marca e desmarca', () => {
  const put = achar('/api/produtos/:id', 'put');
  chamar(put, { params: { id: String(idComSaldo) }, body: { ehServico: true } });
  assert(Number(db.prepare('SELECT ehServico FROM produtos WHERE id = ?').get(idComSaldo).ehServico) === 1,
    'não marcou');
  chamar(put, { params: { id: String(idComSaldo) }, body: { ehServico: false } });
  assert(Number(db.prepare('SELECT ehServico FROM produtos WHERE id = ?').get(idComSaldo).ehServico) === 0,
    'não desmarcou: `false` precisa virar 0, e não null');
});

t('C3 a ficha do produto tem a marcação e desliga os campos de estoque', () => {
  const h = ler('public/catalogo/produto.html');
  assert(/id="ehServico"/.test(h), 'a ficha não tem a marcação');
  assert(/ehServico: document\.getElementById\('ehServico'\)\.checked \? 1 : 0/.test(h),
    'a ficha não envia a marcação');
  assert(/document\.getElementById\('ehServico'\)\.checked = !!p\.ehServico/.test(h),
    'a ficha não mostra a marcação ao abrir um produto');
  assert(/function alternarServico/.test(h), 'os campos de estoque continuam editáveis para serviço');
  const corpo = h.slice(h.indexOf('function alternarServico'), h.indexOf('function recalcVolume'));
  for (const campo of ['estoqueMinimo', 'pontoReposicao', 'rastreiaLote']) {
    assert(corpo.includes(`'${campo}'`), `${campo} continua editável em serviço`);
  }
});

t('C4 a coluna Disponível do pedido mostra traço para quem não veio na resposta', () => {
  const h = ler('public/comercial/pedido.html');
  // É isto que faz o serviço sair da coluna sem nenhuma mudança na tela.
  assert(/if \(!info\) \{ td\.textContent = '—';/.test(h),
    'sem este ramo o serviço mostraria saldo zero em vez de traço');
});

// ---------------------------------------------------------------- fim
db.close();
try { fs.unlinkSync(DB); } catch {}
console.log(`\n${ok} OK, ${fail} FALHA(S)`);
if (fail) { console.log(`FALHOU: ${fail} problema(s)`); process.exit(1); }
console.log('PASSOU');
