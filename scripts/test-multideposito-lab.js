#!/usr/bin/env node
// Teste do multi-depósito no tenant lab jaagricola (sem servidor):
// migra schema, cria depósito, movimenta, transfere e valida saldos.
const path = require('path');
const Database = require('better-sqlite3');
const { migrarEstoqueDB, calcularSaldo, calcularCustoMedio, calcularContextoMovimento, getDepositoPadraoId } = require('../estoque-routes');

const DB = path.join(__dirname, '..', 'data', 'tenants', 'jaagricola', 'pncp.db');
const db = new Database(DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

function assert(cond, msg) {
  if (!cond) { console.error('FALHOU:', msg); process.exit(1); }
  console.log('OK:', msg);
}

migrarEstoqueDB(db);
assert(db.prepare("SELECT COUNT(*) n FROM depositos").get().n >= 1, 'depósito Principal seedado');
const padraoId = getDepositoPadraoId(db);
assert(padraoId != null, `depósito padrão id=${padraoId}`);

// produto de teste
db.prepare("INSERT OR IGNORE INTO produtos (sku, descricao, unidade, ativo) VALUES ('TESTE-MD-1','Produto teste multideposito','UN',1)").run();
const prod = db.prepare("SELECT id FROM produtos WHERE sku='TESTE-MD-1'").get();

// limpa execuções anteriores do teste
db.prepare("DELETE FROM movimentacoes_estoque WHERE produtoId = ?").run(prod.id);
db.prepare("DELETE FROM transferencia_itens WHERE produtoId = ?").run(prod.id);
db.prepare("DELETE FROM depositos WHERE nome = 'Galpao Teste'").run();

// segundo depósito
const dep2 = db.prepare("INSERT INTO depositos (nome, tipo) VALUES ('Galpao Teste','interno')").run().lastInsertRowid;

// entrada 100 no padrão (depositoId NULL — convenção legado) + 20 explícito no dep2
const ins = db.prepare(`INSERT INTO movimentacoes_estoque
  (produtoId, tipo, quantidade, custoUnitario, origem, data, depositoId,
   custoMedioAnterior, custoMedioPosterior, saldoPosterior)
  VALUES (?, ?, ?, ?, 'ajuste_manual', date('now'), ?, ?, ?, ?)`);
let ctx = calcularContextoMovimento(db, prod.id, 'entrada', 100, 10);
ins.run(prod.id, 'entrada', 100, 10, null, ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior);
ctx = calcularContextoMovimento(db, prod.id, 'entrada', 20, 10);
ins.run(prod.id, 'entrada', 20, 10, dep2, ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior);

assert(calcularSaldo(db, prod.id) === 120, 'saldo global = 120');
assert(calcularSaldo(db, prod.id, padraoId) === 100, 'saldo padrão = 100 (NULL conta como padrão)');
assert(calcularSaldo(db, prod.id, dep2) === 20, 'saldo dep2 = 20');

// transferência padrão → dep2 de 30 (envio + recebimento)
const tid = db.prepare(`INSERT INTO transferencias_estoque (numero, depositoOrigemId, depositoDestinoId)
  VALUES ('TRF-TESTE-0001', ?, ?)`).run(padraoId, dep2).lastInsertRowid;
db.prepare('INSERT INTO transferencia_itens (transferenciaId, produtoId, quantidade) VALUES (?, ?, 30)').run(tid, prod.id);

// envio (saída na origem)
ctx = calcularContextoMovimento(db, prod.id, 'saida', 30, null);
ins.run(prod.id, 'saida', 30, null, padraoId, ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior);
assert(calcularSaldo(db, prod.id, padraoId) === 70, 'após envio: padrão = 70');
assert(calcularSaldo(db, prod.id) === 90, 'após envio: global = 90 (30 em trânsito)');

// recebimento (entrada no destino com custo médio — média não muda)
const cmAntes = calcularCustoMedio(db, prod.id);
ctx = calcularContextoMovimento(db, prod.id, 'entrada', 30, cmAntes);
ins.run(prod.id, 'entrada', 30, cmAntes, dep2, ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior);
assert(calcularSaldo(db, prod.id, dep2) === 50, 'após receber: dep2 = 50');
assert(calcularSaldo(db, prod.id) === 120, 'após receber: global = 120');
const cmDepois = calcularCustoMedio(db, prod.id);
assert(Math.abs(cmAntes - cmDepois) < 0.0001, `custo médio inalterado pela transferência (${cmAntes} → ${cmDepois})`);

// limpeza
db.prepare("DELETE FROM movimentacoes_estoque WHERE produtoId = ?").run(prod.id);
db.prepare("DELETE FROM transferencia_itens WHERE transferenciaId = ?").run(tid);
db.prepare("DELETE FROM transferencias_estoque WHERE id = ?").run(tid);
db.prepare("DELETE FROM depositos WHERE id = ?").run(dep2);
db.prepare("DELETE FROM produtos WHERE id = ?").run(prod.id);
db.close();
console.log('\nTODOS OS TESTES PASSARAM');
process.exit(0);
