/**
 * Teste do vínculo pedido → reserva: reabertura recria, marketplace
 * reserva e baixa, e pedido confirmado sem reserva fica visível.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasEstoque } = require('../estoque-routes');
const { registrarRotasReservas, criarReservasPedido, consumirReservasPedido } = require('../reservas-routes');

const DB = '/tmp/vp-reservas.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-reservas-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec('CREATE TABLE IF NOT EXISTS tipos_operacao (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, movimentaEstoque INTEGER DEFAULT 1)');

const app = express();
registrarRotasEstoque(app, db);
registrarRotasReservas(app, db);
const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(h, o = {}) {
  let out = null, st = 200;
  h({ params: o.params || {}, query: o.query || {}, body: o.body || {}, session: {}, user: {} },
    { json: x => { out = x; return { json: y => { out = y; } }; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- seed ----------
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (1,'00000000000191','Cliente','cliente',1)").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, ativo, precoCusto, codigoBarras) VALUES (1,'SKU-A','Produto A',1,10,'7891234567895')").run();
db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, origem, data)
  VALUES (1,'entrada',100,10,'nfe_entrada',date('now'))`).run();

const hoje = new Date().toISOString().slice(0, 10);
function novoPedido(status, { comProduto = true, tipo = 'manual' } = {}) {
  const id = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal)
    VALUES (?, ?, 'pedido', 1, ?, ?, 100)`).run('P-' + Math.random().toString(36).slice(2, 7), tipo, status, hoje).lastInsertRowid;
  db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
    VALUES (?, ?, 'Item', 5, 20, 100)`).run(id, comProduto ? 1 : null);
  return id;
}

// ---------- painel de pedidos sem reserva ----------
t('pedido confirmado sem reserva aparece no painel', () => {
  const p = novoPedido('confirmado');
  const r = chamar(achar('/api/reservas/pedidos-sem-reserva', 'get'), {});
  assert(r.out.success, 'erro: ' + r.out.error);
  const achado = r.out.pedidos.find(x => x.id === p);
  assert(achado, 'pedido não apareceu no painel');
  assert(/sem reserva/.test(achado.motivo), 'motivo: ' + achado.motivo);
});

t('motivo distingue item sem produto vinculado', () => {
  const p = novoPedido('confirmado', { comProduto: false, tipo: 'marketplace' });
  const achado = chamar(achar('/api/reservas/pedidos-sem-reserva', 'get'), {}).out.pedidos.find(x => x.id === p);
  assert(achado.itensSemProduto === 1, 'itensSemProduto: ' + achado.itensSemProduto);
  assert(/sem produto vinculado/.test(achado.motivo), 'motivo: ' + achado.motivo);
});

t('pedido com reserva ativa sai do painel', () => {
  const p = novoPedido('confirmado');
  criarReservasPedido(db, p);
  const achado = chamar(achar('/api/reservas/pedidos-sem-reserva', 'get'), {}).out.pedidos.find(x => x.id === p);
  assert(!achado, 'pedido com reserva não devia aparecer');
});

t('rascunho e entregue não entram no painel', () => {
  const r = novoPedido('rascunho'), e = novoPedido('entregue');
  const lista = chamar(achar('/api/reservas/pedidos-sem-reserva', 'get'), {}).out.pedidos.map(x => x.id);
  assert(!lista.includes(r) && !lista.includes(e), 'status fora do escopo vazou');
});

// ---------- reservar pelo painel ----------
t('reservar agora cria as reservas que faltavam', () => {
  const p = novoPedido('confirmado');
  const r = chamar(achar('/api/reservas/pedidos/:pedidoId/reservar', 'post'), { params: { pedidoId: String(p) } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.reservasCriadas === 1, 'reservas: ' + r.out.reservasCriadas);
  const n = db.prepare("SELECT COUNT(*) n FROM reservas_estoque WHERE pedidoId=? AND status='ativa'").get(p).n;
  assert(n === 1, 'não gravou a reserva');
});

t('reservar recusa pedido que já tem reserva', () => {
  const p = novoPedido('confirmado');
  chamar(achar('/api/reservas/pedidos/:pedidoId/reservar', 'post'), { params: { pedidoId: String(p) } });
  const r = chamar(achar('/api/reservas/pedidos/:pedidoId/reservar', 'post'), { params: { pedidoId: String(p) } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/já tem reserva/.test(r.out.error), 'erro: ' + r.out.error);
});

t('reservar explica quando não há produto vinculado', () => {
  const p = novoPedido('confirmado', { comProduto: false });
  const r = chamar(achar('/api/reservas/pedidos/:pedidoId/reservar', 'post'), { params: { pedidoId: String(p) } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/vincule o produto/.test(r.out.error), 'erro pouco claro: ' + r.out.error);
});

t('reservar recusa pedido em status incompatível', () => {
  const p = novoPedido('rascunho');
  const r = chamar(achar('/api/reservas/pedidos/:pedidoId/reservar', 'post'), { params: { pedidoId: String(p) } });
  assert(r.st === 400, 'status: ' + r.st);
});

// ---------- listagem ----------
t('totais vêm do backend e o truncamento é sinalizado', () => {
  const cheia = chamar(achar('/api/reservas', 'get'), { query: { status: 'ativa' } });
  assert(cheia.out.totais.registros >= 3, 'registros: ' + cheia.out.totais.registros);
  assert(cheia.out.truncado === false, 'não devia truncar');
  const corta = chamar(achar('/api/reservas', 'get'), { query: { status: 'ativa', limit: '1' } });
  assert(corta.out.truncado === true, 'não sinalizou truncamento');
  assert(corta.out.totais.registros === cheia.out.totais.registros, 'totais devem ser do filtro todo');
});

t('busca por SKU, produto ou número do pedido', () => {
  assert(chamar(achar('/api/reservas', 'get'), { query: { status: 'ativa', q: 'SKU-A' } }).out.reservas.length >= 1, 'busca por SKU');
  assert(chamar(achar('/api/reservas', 'get'), { query: { status: 'ativa', q: 'Produto A' } }).out.reservas.length >= 1, 'busca por descrição');
  assert(chamar(achar('/api/reservas', 'get'), { query: { status: 'ativa', q: 'nada-disso' } }).out.reservas.length === 0, 'busca sem resultado');
});

// ---------- consumo mantém a coerência ----------
t('consumir a reserva tira o pedido do painel e baixa o estoque', () => {
  const p = novoPedido('confirmado');
  criarReservasPedido(db, p);
  const antes = db.prepare("SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade WHEN tipo='saida' THEN -quantidade ELSE quantidade END),0) s FROM movimentacoes_estoque WHERE produtoId=1").get().s;
  consumirReservasPedido(db, p, hoje);
  const depois = db.prepare("SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade WHEN tipo='saida' THEN -quantidade ELSE quantidade END),0) s FROM movimentacoes_estoque WHERE produtoId=1").get().s;
  assert(depois === antes - 5, `saldo ${antes} -> ${depois}, esperado -5`);
  const st = db.prepare("SELECT status FROM reservas_estoque WHERE pedidoId=?").get(p).status;
  assert(st === 'consumida', 'reserva: ' + st);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
