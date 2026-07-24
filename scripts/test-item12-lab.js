#!/usr/bin/env node
// Teste item 1.2 (códigos alternativos + kits) no tenant lab jaagricola.
const path = require('path');
const Database = require('better-sqlite3');
const { initSchema } = require('../db-schema');

const db = new Database(path.join(__dirname, '..', 'data', 'tenants', 'jaagricola', 'pncp.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

function assert(cond, msg) {
  if (!cond) { console.error('FALHOU:', msg); process.exit(1); }
  console.log('OK:', msg);
}

initSchema(db);
assert(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('produto_codigos','produto_kit_itens')").get().n === 2,
  'tabelas produto_codigos e produto_kit_itens criadas');

// limpa execuções anteriores
for (const sku of ['KIT-T-1','COMP-T-1','COMP-T-2']) {
  const p = db.prepare('SELECT id FROM produtos WHERE sku = ?').get(sku);
  if (p) {
    db.prepare('DELETE FROM produto_codigos WHERE produtoId = ?').run(p.id);
    db.prepare('DELETE FROM produto_kit_itens WHERE produtoPaiId = ? OR produtoFilhoId = ?').run(p.id, p.id);
    db.prepare('DELETE FROM movimentacoes_estoque WHERE produtoId = ?').run(p.id);
    db.prepare('DELETE FROM produtos WHERE id = ?').run(p.id);
  }
}

const ins = db.prepare("INSERT INTO produtos (sku, descricao, unidade, ativo) VALUES (?, ?, 'UN', 1)");
const kitId = ins.run('KIT-T-1', 'Kit teste').lastInsertRowid;
const c1 = ins.run('COMP-T-1', 'Componente 1').lastInsertRowid;
const c2 = ins.run('COMP-T-2', 'Componente 2').lastInsertRowid;

// códigos alternativos + unicidade
db.prepare("INSERT INTO produto_codigos (produtoId, codigo, tipo) VALUES (?, 'ALT-XYZ-99', 'anterior')").run(c1);
let dup = false;
try { db.prepare("INSERT INTO produto_codigos (produtoId, codigo, tipo) VALUES (?, 'ALT-XYZ-99', 'anterior')").run(c2); }
catch (e) { dup = /UNIQUE/.test(e.message); }
assert(dup, 'UNIQUE(codigo,tipo,fornecedorId) bloqueia duplicata');

// busca por código alternativo (mesma query do GET /api/produtos)
const found = db.prepare(`SELECT p.id FROM produtos p WHERE p.ativo = 1 AND (p.sku LIKE ? OR p.descricao LIKE ?
  OR EXISTS (SELECT 1 FROM produto_codigos pc WHERE pc.produtoId = p.id AND pc.ativo = 1 AND pc.codigo LIKE ?))`)
  .all('%XYZ-99%','%XYZ-99%','%XYZ-99%');
assert(found.length === 1 && found[0].id === c1, 'busca encontra produto pelo código alternativo');

// kit: composição + explosão de reserva (mesma lógica de criarReservasPedido)
db.prepare('INSERT INTO produto_kit_itens (produtoPaiId, produtoFilhoId, quantidade) VALUES (?, ?, 2)').run(kitId, c1);
db.prepare('INSERT INTO produto_kit_itens (produtoPaiId, produtoFilhoId, quantidade) VALUES (?, ?, 3)').run(kitId, c2);
db.prepare("UPDATE produtos SET tipoProduto = 'kit' WHERE id = ?").run(kitId);

const itemPedido = { produtoId: kitId, quantidade: 5 };
const prod = db.prepare('SELECT id, tipoProduto FROM produtos WHERE id = ?').get(itemPedido.produtoId);
const explodidos = [];
if (prod.tipoProduto === 'kit') {
  for (const c of db.prepare('SELECT produtoFilhoId, quantidade FROM produto_kit_itens WHERE produtoPaiId = ?').all(prod.id)) {
    explodidos.push({ produtoId: c.produtoFilhoId, quantidade: itemPedido.quantidade * c.quantidade });
  }
}
assert(explodidos.length === 2, 'kit explode em 2 componentes');
assert(explodidos.find(e => e.produtoId === c1).quantidade === 10, 'componente 1: 5 kits × 2 = 10');
assert(explodidos.find(e => e.produtoId === c2).quantidade === 15, 'componente 2: 5 kits × 3 = 15');

// match NF-e por código de fornecedor aprendido
db.prepare("INSERT OR IGNORE INTO produto_codigos (produtoId, codigo, tipo, fornecedorId) VALUES (?, 'FORN-0042', 'fornecedor', 999)").run(c2);
const m = db.prepare(`SELECT produtoId FROM produto_codigos
  WHERE codigo = 'FORN-0042' AND tipo = 'fornecedor' AND fornecedorId = 999 AND ativo = 1`).get();
assert(m && m.produtoId === c2, 'match por código de fornecedor aprendido funciona');

// limpeza
db.prepare('DELETE FROM produto_codigos WHERE produtoId IN (?,?,?)').run(kitId, c1, c2);
db.prepare('DELETE FROM produto_kit_itens WHERE produtoPaiId = ?').run(kitId);
db.prepare('DELETE FROM produtos WHERE id IN (?,?,?)').run(kitId, c1, c2);
db.close();
console.log('\nTODOS OS TESTES PASSARAM');
process.exit(0);
