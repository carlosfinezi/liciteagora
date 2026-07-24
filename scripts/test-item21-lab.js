#!/usr/bin/env node
// Teste item 2.1 CTB-A no lab jaagricola: regras de partida dobrada.
const path = require('path');
const Database = require('better-sqlite3');
const { migrarContabilidadeDB, gravarLancamento } = require('../contabilidade-routes');

const db = new Database(path.join(__dirname, '..', 'data', 'tenants', 'jaagricola', 'pncp.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

function assert(cond, msg) {
  if (!cond) { console.error('FALHOU:', msg); process.exit(1); }
  console.log('OK:', msg);
}
function deveFalhar(fn, trecho, msg) {
  try { fn(); console.error('FALHOU (não lançou erro):', msg); process.exit(1); }
  catch (e) {
    if (!e.message.includes(trecho)) { console.error(`FALHOU (erro errado: ${e.message}):`, msg); process.exit(1); }
    console.log('OK:', msg);
  }
}

migrarContabilidadeDB(db);
// limpeza total do módulo no lab e re-seed
db.exec(`DELETE FROM lancamento_partidas; DELETE FROM lancamentos_contabeis;
  DELETE FROM periodos_contabeis; DELETE FROM contas_contabeis;`);
migrarContabilidadeDB(db);
assert(db.prepare('SELECT COUNT(*) n FROM contas_contabeis').get().n === 4, 'seed nível 1 (4 contas sintéticas)');

// plano mínimo p/ teste
const ativo = db.prepare("SELECT id FROM contas_contabeis WHERE codigo='1'").get().id;
const receitas = db.prepare("SELECT id FROM contas_contabeis WHERE codigo='3'").get().id;
const ins = db.prepare(`INSERT INTO contas_contabeis (codigo, nome, tipoConta, natureza, parentId, nivel) VALUES (?, ?, ?, ?, ?, ?)`);
ins.run('1.1', 'DISPONÍVEL', 'sintetica', 'D', ativo, 2);
const caixaSint = db.prepare("SELECT id FROM contas_contabeis WHERE codigo='1.1'").get().id;
ins.run('1.1.001', 'Caixa Geral', 'analitica', 'D', caixaSint, 3);
ins.run('3.1.001', 'Receita de Vendas', 'analitica', 'C', receitas, 2);
const caixa = db.prepare("SELECT id FROM contas_contabeis WHERE codigo='1.1.001'").get().id;
const receita = db.prepare("SELECT id FROM contas_contabeis WHERE codigo='3.1.001'").get().id;

// 1) D != C rejeitado
deveFalhar(() => gravarLancamento(db, { data: '2026-07-02', historico: 'x', partidas: [
  { contaContabilId: caixa, dc: 'D', valor: 100 }, { contaContabilId: receita, dc: 'C', valor: 90 }
]}), 'Débitos', 'lançamento desbalanceado rejeitado');

// 2) partida em sintética rejeitada
deveFalhar(() => gravarLancamento(db, { data: '2026-07-02', historico: 'x', partidas: [
  { contaContabilId: caixaSint, dc: 'D', valor: 100 }, { contaContabilId: receita, dc: 'C', valor: 100 }
]}), 'sintética', 'partida em conta sintética rejeitada');

// 3) lançamento válido: venda à vista 1000
const l1 = gravarLancamento(db, { data: '2026-07-02', historico: 'Venda à vista', partidas: [
  { contaContabilId: caixa, dc: 'D', valor: 1000 }, { contaContabilId: receita, dc: 'C', valor: 1000 }
]});
assert(l1 > 0, `lançamento válido gravado (#${l1})`);

// 4) implantação de saldo em junho: caixa 500 (contrapartida receita p/ simplificar)
const l0 = gravarLancamento(db, { data: '2026-06-30', historico: 'Implantação de saldos', tipo: 'implantacao', origem: 'migracao', partidas: [
  { codigo: '1.1.001', dc: 'D', valor: 500 }, { codigo: '3.1.001', dc: 'C', valor: 500 }
]});
assert(l0 > 0, 'implantação por CÓDIGO de conta funciona');

// 5) fechar junho e tentar lançar nele
db.prepare(`INSERT INTO periodos_contabeis (competencia, status) VALUES ('2026-06','fechado')`).run();
deveFalhar(() => gravarLancamento(db, { data: '2026-06-15', historico: 'x', partidas: [
  { contaContabilId: caixa, dc: 'D', valor: 10 }, { contaContabilId: receita, dc: 'C', valor: 10 }
]}), 'fechada', 'competência fechada rejeita lançamento');

// 6) balancete julho: saldo anterior do caixa 500, movimento D 1000, final 1500; roll-up até ATIVO
//    (replica a lógica do endpoint via require? endpoint precisa de app — validamos com SQL equivalente)
const antes = db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.dc='D' THEN p.valor ELSE -p.valor END),0) v
  FROM lancamento_partidas p JOIN lancamentos_contabeis l ON l.id=p.lancamentoId
  WHERE p.contaContabilId=? AND l.data <= '2026-06-30'`).get(caixa).v;
assert(antes === 500, `saldo anterior caixa em 30/06 = ${antes}`);
const mov = db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.dc='D' THEN p.valor ELSE 0 END),0) d
  FROM lancamento_partidas p JOIN lancamentos_contabeis l ON l.id=p.lancamentoId
  WHERE p.contaContabilId=? AND l.data BETWEEN '2026-07-01' AND '2026-07-31'`).get(caixa).d;
assert(mov === 1000, `movimento débitos julho = ${mov}`);

// 7) estorno: inverso vinculado; saldo volta
const partidas = db.prepare('SELECT * FROM lancamento_partidas WHERE lancamentoId = ?').all(l1);
const eid = gravarLancamento(db, {
  data: '2026-07-02', historico: `Estorno #${l1}`, origem: 'estorno', origemRef: String(l1), lancamentoOriginalId: l1,
  partidas: partidas.map(p => ({ contaContabilId: p.contaContabilId, dc: p.dc === 'D' ? 'C' : 'D', valor: p.valor }))
});
db.prepare('UPDATE lancamentos_contabeis SET estornado=1, lancamentoEstornoId=? WHERE id=?').run(eid, l1);
const saldoCaixa = db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.dc='D' THEN p.valor ELSE -p.valor END),0) v
  FROM lancamento_partidas p JOIN lancamentos_contabeis l ON l.id=p.lancamentoId
  WHERE p.contaContabilId=?`).get(caixa).v;
assert(saldoCaixa === 500, `após estorno, caixa volta a 500 (${saldoCaixa})`);

// limpeza (mantém plano seed)
db.exec(`DELETE FROM lancamento_partidas; DELETE FROM lancamentos_contabeis; DELETE FROM periodos_contabeis;
  DELETE FROM contas_contabeis WHERE codigo IN ('1.1','1.1.001','3.1.001');`);
db.close();
console.log('\nTODOS OS TESTES PASSARAM');
process.exit(0);
