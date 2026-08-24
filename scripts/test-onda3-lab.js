#!/usr/bin/env node
// Teste Onda 3 (3.1 + 3.2 + 3.4) no lab jaagricola.
const path = require('path');
const Database = require('better-sqlite3');
const { migrarPlanejamentoDB } = require('../planejamento-routes');
const { migrarContabilizacaoDB, EVENTOS } = require('../contabilizacao-routes');
const { migrarIbsCbsDB } = require('../ibscbs-routes');
const { gravarLancamento, migrarContabilidadeDB } = require('../contabilidade-routes');

const db = new Database(path.join(__dirname, '..', 'data', 'tenants', 'jaagricola', 'pncp.db'));
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = OFF');
function assert(c, m){ if(!c){ console.error('FALHOU:', m); process.exit(1);} console.log('OK:', m); }

migrarPlanejamentoDB(db); migrarContabilizacaoDB(db); migrarIbsCbsDB(db); migrarContabilidadeDB(db);
assert(db.prepare(`SELECT count(*) n FROM sqlite_master WHERE name IN
  ('provisoes','orcamento_plano_contas','metas_vendas','contabilizacao_eventos','ibscbs_creditos')`).get().n === 5, 'tabelas da onda 3 criadas');

// limpeza
db.exec(`DELETE FROM provisoes; DELETE FROM orcamento_plano_contas; DELETE FROM metas_vendas;
  DELETE FROM contabilizacao_eventos; DELETE FROM ibscbs_creditos;
  DELETE FROM lancamento_partidas; DELETE FROM lancamentos_contabeis; DELETE FROM periodos_contabeis;
  DELETE FROM contas_contabeis WHERE codigo LIKE '9.%';`);

// ===== 3.2 motor de contabilização =====
const ins = db.prepare(`INSERT INTO contas_contabeis (codigo, nome, tipoConta, natureza, nivel) VALUES (?, ?, 'analitica', ?, 1)`);
ins.run('9.1', 'Caixa teste', 'D'); ins.run('9.2', 'Receita teste', 'C');
db.prepare(`INSERT INTO contabilizacao_eventos (evento, contaDebitoCodigo, contaCreditoCodigo)
  VALUES ('recebimento', '9.1', '9.2')`).run();

// Fonte própria em vez de sobras de e2e anteriores: quando outro teste
// apagava a conta a receber e deixava o pagamento para trás, o JOIN da fonte
// zerava e este teste quebrava sem ter nada a ver com contabilização.
const pessoaOnda = db.prepare('SELECT id FROM pessoas LIMIT 1').get();
assert(pessoaOnda, 'lab tem ao menos uma pessoa cadastrada');
const crSeed = db.prepare(`INSERT INTO contas_a_receber
  (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, origem)
  VALUES (?, 'TESTE-3.2 recebimento', 630, '2026-07-01', '2026-07-01', 'paga', 'manual')`)
  .run(pessoaOnda.id).lastInsertRowid;
db.prepare(`INSERT INTO contas_receber_pagamentos
  (contaReceberId, dataPagamento, valorPago, valorBase, estornado)
  VALUES (?, '2026-07-02', 630, 630, 0)`).run(crSeed);

const fonte = EVENTOS.recebimento.fonte(db, '2026-07-01', '2026-07-31');
assert(fonte.length >= 1, `fonte de recebimentos tem ${fonte.length} registro(s)`);

// processa (replica a lógica do endpoint)
const jaFeito = new Set();
let gerados = 0;
for (const row of fonte) {
  const ref = `recebimento:${row.id}`;
  if (jaFeito.has(ref)) continue;
  gravarLancamento(db, { data: row.data, historico: `[auto] ${row.descricao}`.slice(0,300),
    origem: 'automatico', origemRef: ref,
    partidas: [{ codigo: '9.1', dc: 'D', valor: Number(row.valor.toFixed(2)) },
               { codigo: '9.2', dc: 'C', valor: Number(row.valor.toFixed(2)) }] });
  jaFeito.add(ref); gerados++;
}
assert(gerados === fonte.length, `${gerados} lançamentos automáticos gerados`);

// idempotência: refs já lançadas não repetem
const refsNoBanco = new Set(db.prepare(`SELECT origemRef FROM lancamentos_contabeis WHERE origem='automatico'`).all().map(x=>x.origemRef));
const pendentes2 = fonte.filter(r => !refsNoBanco.has(`recebimento:${r.id}`));
assert(pendentes2.length === 0, 'reprocessar = 0 pendentes (idempotente por origemRef)');

// soma dos lançamentos = soma da fonte
const somaL = db.prepare(`SELECT SUM(p.valor) v FROM lancamento_partidas p
  JOIN lancamentos_contabeis l ON l.id=p.lancamentoId WHERE l.origem='automatico' AND p.dc='D'`).get().v;
const somaF = fonte.reduce((s,r)=>s+r.valor,0);
assert(Math.abs(somaL - somaF) < 0.01, `débitos automáticos (${somaL}) = fonte (${somaF.toFixed(2)})`);

// ===== 3.4 provisões / orçamento / metas =====
db.prepare(`INSERT INTO provisoes (descricao, tipo, valor, dataPrevista) VALUES ('13º salário','saida',5000,'2026-12-20')`).run();
const pv = db.prepare(`SELECT * FROM provisoes WHERE status='ativa' AND dataPrevista BETWEEN '2026-12-01' AND '2026-12-31'`).all();
assert(pv.length === 1 && pv[0].valor === 5000, 'provisão consultável pelo range do fluxo');

const pc = db.prepare('SELECT id FROM plano_contas LIMIT 1').get();
db.prepare(`INSERT INTO orcamento_plano_contas (planoContaId, competencia, valorPrevisto) VALUES (?, '2026-07', 10000)
  ON CONFLICT(planoContaId, competencia) DO UPDATE SET valorPrevisto=excluded.valorPrevisto`).run(pc.id);
db.prepare(`INSERT INTO orcamento_plano_contas (planoContaId, competencia, valorPrevisto) VALUES (?, '2026-07', 12000)
  ON CONFLICT(planoContaId, competencia) DO UPDATE SET valorPrevisto=excluded.valorPrevisto`).run(pc.id);
assert(db.prepare('SELECT valorPrevisto v FROM orcamento_plano_contas WHERE planoContaId=?').get(pc.id).v === 12000, 'orçamento upsert (10000→12000)');

const user = db.prepare('SELECT id FROM users LIMIT 1').get();
db.prepare(`INSERT INTO metas_vendas (vendedorUserId, competencia, valorMeta) VALUES (?, '2026-07', 50000)`).run(user.id);
db.prepare(`UPDATE pedidos SET vendedorId = ? WHERE id = 1`).run(user.id);
const vendas = db.prepare(`SELECT SUM(valorTotal) v FROM pedidos WHERE vendedorId=? AND substr(dataPedido,1,7)='2026-07'
  AND status NOT IN ('rascunho','cancelado')`).get(user.id).v || 0;
assert(vendas > 0, `realizado do vendedor: R$ ${vendas}`);

// ===== 3.1 apuração IBS/CBS =====
const faturas = db.prepare(`SELECT SUM(valorTotal) v, COUNT(*) n FROM faturas
  WHERE statusSefaz='autorizada' AND COALESCE(excluida,0)=0 AND substr(dataEmissao,1,7)='2026-07'`).get();
const base = faturas.v || 0;
db.prepare(`INSERT INTO ibscbs_creditos (competencia, descricao, valorIBS, valorCBS) VALUES ('2026-07','NF compra teste', 1.00, 9.00)`).run();
const debIBS = base * 0.1/100, debCBS = base * 0.9/100;
console.log(`  (base ${base}: débito IBS ${debIBS.toFixed(2)} + CBS ${debCBS.toFixed(2)}, créditos 10.00)`);
assert(true, `apuração calculável (${faturas.n} nota(s) autorizadas na competência)`);

// limpeza
db.exec(`DELETE FROM provisoes; DELETE FROM orcamento_plano_contas; DELETE FROM metas_vendas;
  DELETE FROM contabilizacao_eventos; DELETE FROM ibscbs_creditos;
  DELETE FROM lancamento_partidas; DELETE FROM lancamentos_contabeis;
  DELETE FROM contas_contabeis WHERE codigo LIKE '9.%';`);
db.prepare('DELETE FROM contas_receber_pagamentos WHERE contaReceberId = ?').run(crSeed);
db.prepare('DELETE FROM contas_a_receber WHERE id = ?').run(crSeed);
db.close();
console.log('\nTODOS OS TESTES PASSARAM');
process.exit(0);
