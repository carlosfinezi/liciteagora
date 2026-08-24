/**
 * Pedido de compra, o caminho que a tela pedido.html percorre:
 * criar rascunho vazio → cabeçalho → itens → enviar → receber.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasCompras } = require('../compras-routes');

const DB = '/tmp/vp-pcompra.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-pcompra-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT, acao TEXT, entidade TEXT, entidadeId INTEGER, detalhes TEXT, ip TEXT,
  dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);

const app = express();
registrarRotasCompras(app, db);
const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                session: { username: 'tester' }, user: { username: 'tester' } },
    { json: x => { out = x; return { json: y => { out = y; } }; },
      status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- seed ----------
db.prepare("INSERT INTO produtos (id, sku, descricao, unidade, ativo, precoCusto) VALUES (1,'P1','Produto 1','UN',1,10)").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, unidade, ativo, precoCusto) VALUES (2,'P2','Produto 2','UN',1,20)").run();
db.prepare("INSERT INTO fornecedores (id, razaoSocial, cpfCnpj, ativo) VALUES (1,'Fornecedor','00000000000191',1)").run();

// ---------- criação ----------
let PED;
t('a tela consegue abrir um pedido novo (rascunho sem itens)', () => {
  // É exatamente o corpo que pedido.html?novo=1 envia.
  const r = chamar('/api/pedidos-compra', 'post', { body: { itens: [] } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.pedido.status === 'rascunho', 'status: ' + r.out.pedido.status);
  assert(r.out.pedido.numero, 'sem número');
  PED = r.out.pedido.id;
});

t('pedido novo sem corpo nenhum também abre', () => {
  const r = chamar('/api/pedidos-compra', 'post', { body: {} });
  assert(r.out.success, 'erro: ' + r.out.error);
});

t('itens que não são array são recusados', () => {
  const r = chamar('/api/pedidos-compra', 'post', { body: { itens: 'x' } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/array/.test(r.out.error), 'erro: ' + r.out.error);
});

t('item sem produto não vira pedido zerado em silêncio', () => {
  const r = chamar('/api/pedidos-compra', 'post', { body: { itens: [{ quantidade: 5 }] } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/Nenhum item válido/.test(r.out.error), 'erro: ' + r.out.error);
});

t('criação com itens válidos continua funcionando', () => {
  const r = chamar('/api/pedidos-compra', 'post', { body: {
    fornecedorId: 1, itens: [{ produtoId: 1, quantidade: 3, custoUnitario: 10 }] } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const n = db.prepare('SELECT COUNT(*) n FROM pedido_compra_itens WHERE pedidoCompraId=?').get(r.out.pedido.id).n;
  assert(n === 1, 'itens gravados: ' + n);
  assert(r.out.pedido.valorTotal === 30, 'total: ' + r.out.pedido.valorTotal);
});

// ---------- cabeçalho e itens ----------
t('cabeçalho é salvo depois da criação', () => {
  const r = chamar('/api/pedidos-compra/:id', 'put', { params: { id: String(PED) },
    body: { fornecedorId: 1, dataPrevistaEntrega: '2026-08-15', observacoes: 'teste' } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const p = db.prepare('SELECT * FROM pedidos_compra WHERE id=?').get(PED);
  assert(p.fornecedorId === 1 && p.dataPrevistaEntrega === '2026-08-15', JSON.stringify(p));
});

let ITEM;
t('item é adicionado ao rascunho e o total recalcula', () => {
  const r = chamar('/api/pedidos-compra/:id/itens', 'post', { params: { id: String(PED) },
    body: { produtoId: 1, quantidade: 10, custoUnitario: 7 } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const p = db.prepare('SELECT valorTotal FROM pedidos_compra WHERE id=?').get(PED);
  assert(p.valorTotal === 70, 'total: ' + p.valorTotal);
  ITEM = db.prepare('SELECT id FROM pedido_compra_itens WHERE pedidoCompraId=?').get(PED).id;
});

t('item é editado e o total acompanha', () => {
  const r = chamar('/api/pedidos-compra/:id/itens/:itemId', 'put',
    { params: { id: String(PED), itemId: String(ITEM) }, body: { quantidade: 4, custoUnitario: 25 } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(db.prepare('SELECT valorTotal v FROM pedidos_compra WHERE id=?').get(PED).v === 100, 'total não recalculou');
});

// ---------- envio ----------
t('rascunho sem item nenhum não pode ser enviado', () => {
  const vazio = chamar('/api/pedidos-compra', 'post', { body: { itens: [] } }).out.pedido.id;
  const r = chamar('/api/pedidos-compra/:id/enviar', 'post', { params: { id: String(vazio) } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/sem itens/i.test(r.out.error), 'erro: ' + r.out.error);
});

t('pedido com item é enviado', () => {
  const r = chamar('/api/pedidos-compra/:id/enviar', 'post', { params: { id: String(PED) } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(db.prepare('SELECT status s FROM pedidos_compra WHERE id=?').get(PED).s === 'enviado', 'status');
});

// ---------- recebimento ----------
t('recebimento parcial dá entrada no estoque e mantém o pedido aberto', () => {
  const r = chamar('/api/pedidos-compra/:id/receber', 'post', { params: { id: String(PED) },
    body: { itens: [{ itemId: ITEM, quantidadeRecebida: 1 }] } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const p = db.prepare('SELECT status s FROM pedidos_compra WHERE id=?').get(PED);
  assert(p.s === 'recebido_parcial', 'status: ' + p.s);
  const saldo = db.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
    WHEN tipo='saida' THEN -quantidade ELSE quantidade END),0) s
    FROM movimentacoes_estoque WHERE produtoId=1`).get().s;
  assert(saldo === 1, 'saldo após receber 1: ' + saldo);
});

t('recebimento do restante fecha o pedido', () => {
  const r = chamar('/api/pedidos-compra/:id/receber', 'post', { params: { id: String(PED) },
    body: { itens: [{ itemId: ITEM, quantidadeRecebida: 3 }] } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const p = db.prepare('SELECT status s FROM pedidos_compra WHERE id=?').get(PED);
  assert(p.s === 'recebido', 'status: ' + p.s);
});

t('não deixa receber mais do que foi pedido', () => {
  const r = chamar('/api/pedidos-compra/:id/receber', 'post', { params: { id: String(PED) },
    body: { itens: [{ itemId: ITEM, quantidadeRecebida: 1 }] } });
  assert(r.st >= 400, 'aceitou receber além do pedido (status ' + r.st + ')');
});

// ---------- listagem e detalhe ----------
t('detalhe traz o pedido com itens', () => {
  const r = chamar('/api/pedidos-compra/:id', 'get', { params: { id: String(PED) } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.itens.length === 1, 'itens: ' + r.out.itens.length);
  assert(r.out.itens[0].sku === 'P1', 'sku ausente no detalhe');
});

t('listagem responde', () => {
  const r = chamar('/api/pedidos-compra', 'get', {});
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.pedidos.length >= 4, 'pedidos: ' + r.out.pedidos.length);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
