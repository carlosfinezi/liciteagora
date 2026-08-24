#!/usr/bin/env node
// Teste item 1.3 (adiantamentos + renegociação + incobráveis) no lab jaagricola.
// Exercita a lógica via SQL direto (mesmas regras dos endpoints).
const path = require('path');
const Database = require('better-sqlite3');
const { migrarFinanceiroAvancado } = require('../financeiro-avancado-routes');

const db = new Database(path.join(__dirname, '..', 'data', 'tenants', 'jaagricola', 'pncp.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

function assert(cond, msg) {
  if (!cond) { console.error('FALHOU:', msg); process.exit(1); }
  console.log('OK:', msg);
}

migrarFinanceiroAvancado(db);
assert(db.prepare(`SELECT count(*) n FROM sqlite_master WHERE name IN ('adiantamentos','adiantamento_utilizacoes','renegociacoes')`).get().n === 3,
  'tabelas do financeiro avançado criadas');
assert(db.prepare(`SELECT count(*) n FROM pragma_table_info('contas_a_receber') WHERE name IN ('renegociacaoId','dataPerda','motivoPerda')`).get().n === 3,
  'colunas novas em contas_a_receber');

// cenário: cliente com 2 títulos vencidos → renegocia em 3 parcelas
const pessoa = db.prepare("SELECT id FROM pessoas WHERE cpfCnpj = '11222333000181'").get();
assert(pessoa, 'cliente de teste existe (criado no e2e do 1.2)');

// limpeza de execuções anteriores
// Os pagamentos primeiro: apagar só o título deixa o pagamento apontando para
// um id que não existe mais, e quem consulta recebimentos por JOIN some com ele.
db.prepare(`DELETE FROM contas_receber_pagamentos WHERE contaReceberId IN (
  SELECT id FROM contas_a_receber
   WHERE descricao LIKE 'TESTE-1.3%' OR descricao LIKE 'Renegociação #%')`).run();
db.prepare("DELETE FROM contas_a_receber WHERE descricao LIKE 'TESTE-1.3%' OR descricao LIKE 'Renegociação #%'").run();
db.prepare("DELETE FROM renegociacoes").run();
db.prepare("DELETE FROM adiantamento_utilizacoes").run();
db.prepare("DELETE FROM adiantamentos").run();

const insCR = db.prepare(`INSERT INTO contas_a_receber
  (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, origem)
  VALUES (?, ?, ?, '2026-05-01', '2026-06-01', 'aberta', 'manual')`);
const t1 = insCR.run(pessoa.id, 'TESTE-1.3 titulo 1', 1000).lastInsertRowid;
const t2 = insCR.run(pessoa.id, 'TESTE-1.3 titulo 2', 500).lastInsertRowid;

// --- renegociação: 1500 + 90 juros - 0 = 1590 em 3x530
const reneg = db.transaction(() => {
  const r = db.prepare(`INSERT INTO renegociacoes
    (escopo, pessoaId, dataAcordo, valorOriginal, juros, desconto, valorAcordado)
    VALUES ('receber', ?, date('now'), 1500, 90, 0, 1590)`).run(pessoa.id);
  const rid = r.lastInsertRowid;
  for (const t of [t1, t2]) {
    db.prepare("UPDATE contas_a_receber SET status='renegociada', renegociacaoId=? WHERE id=?").run(rid, t);
  }
  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO contas_a_receber
      (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, origem, parcelaNumero, totalParcelas, renegociacaoId)
      VALUES (?, ?, 530, date('now'), date('now', '+' || ? || ' months'), 'aberta', 'renegociacao', ?, 3, ?)`)
      .run(pessoa.id, `Renegociação #${rid} — parcela ${i}/3`, i, i, rid);
  }
  return rid;
})();

assert(db.prepare("SELECT status FROM contas_a_receber WHERE id=?").get(t1).status === 'renegociada', 'título original marcado renegociada');
const somaAbertas = db.prepare("SELECT SUM(valor) v FROM contas_a_receber WHERE renegociacaoId=? AND status='aberta'").get(reneg).v;
assert(Math.abs(somaAbertas - 1590) < 0.01, `parcelas novas somam o acordado (${somaAbertas})`);

// CRÍTICO: título renegociado NÃO conta como "em aberto" (whitelist aberta/parcial)
const emAberto = db.prepare("SELECT COUNT(*) n FROM contas_a_receber WHERE status IN ('aberta','parcial') AND id IN (?,?)").get(t1, t2).n;
assert(emAberto === 0, 'renegociados fora dos filtros de em-aberto');

// --- adiantamento de cliente: 600, abate a 1ª parcela (530) e sobra 70
const parcela1 = db.prepare("SELECT * FROM contas_a_receber WHERE renegociacaoId=? AND parcelaNumero=1").get(reneg);
const adiant = db.prepare(`INSERT INTO adiantamentos (tipo, pessoaId, valor, saldo, data, contaFinanceiraId)
  VALUES ('cliente', ?, 600, 600, date('now'), NULL)`).run(pessoa.id).lastInsertRowid;

db.transaction(() => {
  db.prepare(`INSERT INTO contas_receber_pagamentos
    (contaReceberId, dataPagamento, valorPago, valorBase, juros, multa, desconto, formaPagamento, contaFinanceiraId, origem)
    VALUES (?, date('now'), 530, 530, 0, 0, 0, 'adiantamento', NULL, 'adiantamento')`).run(parcela1.id);
  db.prepare("UPDATE contas_a_receber SET status='paga', valorPago=530 WHERE id=?").run(parcela1.id);
  db.prepare("UPDATE adiantamentos SET saldo=70 WHERE id=?").run(adiant);
  db.prepare(`INSERT INTO adiantamento_utilizacoes (adiantamentoId, contaReceberId, valor, data)
    VALUES (?, ?, 530, date('now'))`).run(adiant, parcela1.id);
})();

assert(db.prepare("SELECT status FROM contas_a_receber WHERE id=?").get(parcela1.id).status === 'paga', 'parcela 1 quitada com adiantamento');
assert(db.prepare("SELECT saldo FROM adiantamentos WHERE id=?").get(adiant).saldo === 70, 'saldo do adiantamento decrementado (70)');

// --- incobrável: parcela 3 vira perda e some do em-aberto
const parcela3 = db.prepare("SELECT * FROM contas_a_receber WHERE renegociacaoId=? AND parcelaNumero=3").get(reneg);
db.prepare("UPDATE contas_a_receber SET status='incobravel', dataPerda=date('now'), motivoPerda='Cliente encerrou atividades' WHERE id=?").run(parcela3.id);
const perdas = db.prepare("SELECT COUNT(*) n, SUM(valor - COALESCE(valorPago,0)) v FROM contas_a_receber WHERE status='incobravel'").get();
assert(perdas.n === 1 && Math.abs(perdas.v - 530) < 0.01, `relatório de perdas: 1 título, R$ ${perdas.v}`);
assert(db.prepare("SELECT COUNT(*) n FROM contas_a_receber WHERE status IN ('aberta','parcial') AND id=?").get(parcela3.id).n === 0,
  'incobrável fora dos filtros de em-aberto');

// limpeza
db.prepare("DELETE FROM contas_receber_pagamentos WHERE contaReceberId IN (SELECT id FROM contas_a_receber WHERE renegociacaoId=?)").run(reneg);
db.prepare("DELETE FROM contas_receber_pagamentos WHERE contaReceberId IN (?,?)").run(t1, t2);
db.prepare("DELETE FROM contas_a_receber WHERE renegociacaoId=? OR id IN (?,?)").run(reneg, t1, t2);
db.prepare("DELETE FROM renegociacoes WHERE id=?").run(reneg);
db.prepare("DELETE FROM adiantamento_utilizacoes WHERE adiantamentoId=?").run(adiant);
db.prepare("DELETE FROM adiantamentos WHERE id=?").run(adiant);
db.close();
console.log('\nTODOS OS TESTES PASSARAM');
process.exit(0);
