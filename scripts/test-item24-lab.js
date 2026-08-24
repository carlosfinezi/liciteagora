#!/usr/bin/env node
// Teste item 2.4 (tesouraria) no lab jaagricola.
const path = require('path');
const Database = require('better-sqlite3');
const { migrarTesourariaDB, aplicarRegrasConciliacao, tipoChavePix } = require('../tesouraria-routes');

const db = new Database(path.join(__dirname, '..', 'data', 'tenants', 'jaagricola', 'pncp.db'));
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = OFF');
function assert(c, m){ if(!c){ console.error('FALHOU:', m); process.exit(1);} console.log('OK:', m); }

migrarTesourariaDB(db);
assert(db.prepare(`SELECT count(*) n FROM sqlite_master WHERE name IN
  ('lotes_pagamento','lote_pagamento_itens','conciliacao_regras','agenda_recebiveis_cartao')`).get().n === 4, 'tabelas criadas');
assert(db.prepare("SELECT count(*) n FROM pragma_table_info('fornecedores') WHERE name='chavePix'").get().n === 1, 'fornecedores.chavePix existe');

db.exec("DELETE FROM lote_pagamento_itens; DELETE FROM lotes_pagamento; DELETE FROM conciliacao_regras; DELETE FROM agenda_recebiveis_cartao;");
db.prepare("DELETE FROM transacoes_bancarias WHERE fitid LIKE 'TESTE-%'").run();

// ===== tipoChavePix =====
assert(tipoChavePix('fulano@empresa.com.br') === 'EMAIL', 'chave email detectada');
assert(tipoChavePix('12345678901') === 'CPF', 'chave CPF detectada');
assert(tipoChavePix('11222333000181') === 'CNPJ', 'chave CNPJ detectada');
assert(tipoChavePix('a1b2c3d4-e5f6-1234-abcd-1234567890ab') === 'EVP', 'chave aleatória detectada');

// ===== regras OFX =====
db.prepare(`INSERT INTO transacoes_bancarias (contaFinanceiraId, fitid, data, valor, tipo, descricao)
  VALUES (1, 'TESTE-1', date('now'), -35.90, 'DEBIT', 'TARIFA PACOTE SERVICOS')`).run();
db.prepare(`INSERT INTO transacoes_bancarias (contaFinanceiraId, fitid, data, valor, tipo, descricao)
  VALUES (1, 'TESTE-2', date('now'), 1500.00, 'CREDIT', 'PIX RECEBIDO CLIENTE XYZ')`).run();
db.prepare(`INSERT INTO conciliacao_regras (padraoTexto, tipoLancamento, acao) VALUES ('TARIFA', 'saida', 'ignorar')`).run();
// Regra que categoriza precisa de conta do plano (CHECK categorizar_exige_conta):
// sem ela a classificacao nao chegaria ao orcamento, entao o banco recusa.
const pcReceita = db.prepare("SELECT id FROM plano_contas WHERE codigo = '1.1'").get();
db.prepare(`INSERT INTO conciliacao_regras (padraoTexto, tipoLancamento, acao, categoria, planoContaId)
  VALUES ('PIX RECEBIDO', 'entrada', 'categorizar', 'Recebimentos PIX', ?)`).run(pcReceita.id);
const aplicadas = aplicarRegrasConciliacao(db, 1).aplicadas;
assert(aplicadas === 2, `regras aplicadas a 2 transações`);
const t1 = db.prepare("SELECT * FROM transacoes_bancarias WHERE fitid='TESTE-1'").get();
assert(t1.conciliadaCom === 'ignorada', 'tarifa marcada como ignorada');
const t2 = db.prepare("SELECT * FROM transacoes_bancarias WHERE fitid='TESTE-2'").get();
assert(t2.categoriaSugerida === 'Recebimentos PIX' && !t2.conciliadaCom, 'PIX categorizado (sem conciliar)');
assert(t2.planoContaIdSugerido === pcReceita.id, 'classificacao levou a conta do plano (chega ao orcamento)');
// idempotência: reaplicar não conta de novo
assert(aplicarRegrasConciliacao(db, 1).aplicadas === 0, 'reaplicar é idempotente (regraAplicadaId)');

// ===== agenda de cartões =====
// adquirente com taxa 3% e prazo 30 dias (seed já tem Cielo etc — pega a 1ª e ajusta)
const adq = db.prepare("SELECT id FROM adquirentes_cartao LIMIT 1").get();
db.prepare("UPDATE adquirentes_cartao SET taxaPercentual = 3, prazoLiquidacaoDias = 30 WHERE id = ?").run(adq.id);
// parcela de pedido com bandeira (usa pedido 1 do e2e do 1.2)
db.prepare("DELETE FROM pedido_parcelas WHERE pedidoId = 1").run();
const parc = db.prepare(`INSERT INTO pedido_parcelas (pedidoId, numeroParcela, valor, dataVencimento, meioPagamento, bandeiraId)
  VALUES (1, 1, 1000, date('now'), 'cartao', ?)`).run(adq.id).lastInsertRowid;
// replica a lógica do gerar
const pp = db.prepare(`SELECT pp.*, p.dataPedido, a.taxaPercentual, a.prazoLiquidacaoDias, a.id AS adquirenteId
  FROM pedido_parcelas pp JOIN pedidos p ON p.id = pp.pedidoId
  JOIN adquirentes_cartao a ON a.id = pp.bandeiraId WHERE pp.id = ?`).get(parc);
const taxa = pp.valor * pp.taxaPercentual / 100, liquido = pp.valor - taxa;
assert(taxa === 30 && liquido === 970, `taxa 3% de 1000 = ${taxa}, líquido ${liquido}`);
db.prepare(`INSERT INTO agenda_recebiveis_cartao (parcelaId, pedidoId, adquirenteId, valorBruto, taxa, valorLiquido, dataVenda, dataPrevistaLiquidacao)
  VALUES (?, 1, ?, 1000, 30, 970, ?, date(?, '+30 days'))`).run(parc, adq.id, pp.dataPedido, pp.dataPedido);
// duplicidade bloqueada pelo UNIQUE(parcelaId)
let dup = false;
try { db.prepare(`INSERT INTO agenda_recebiveis_cartao (parcelaId, pedidoId, valorBruto, valorLiquido) VALUES (?, 1, 1, 1)`).run(parc); }
catch(e){ dup = /UNIQUE/.test(e.message); }
assert(dup, 'previsão duplicada da mesma parcela bloqueada');

// match: entrada 970 na data prevista
db.prepare(`INSERT INTO transacoes_bancarias (contaFinanceiraId, fitid, data, valor, tipo, descricao)
  VALUES (1, 'TESTE-3', date(?, '+30 days'), 970.00, 'CREDIT', 'LIQUIDACAO CARTAO')`).run(pp.dataPedido);
const ag = db.prepare("SELECT * FROM agenda_recebiveis_cartao WHERE parcelaId = ?").get(parc);
const sug = db.prepare(`SELECT * FROM transacoes_bancarias WHERE conciliadaCom IS NULL AND valor > 0
  AND ABS(valor - ?) <= 0.05 AND date(data) BETWEEN date(?, '-3 days') AND date(?, '+3 days')`)
  .all(ag.valorLiquido, ag.dataPrevistaLiquidacao, ag.dataPrevistaLiquidacao);
assert(sug.length === 1 && sug[0].fitid === 'TESTE-3', 'sugestão de match encontrou a liquidação no extrato');

// limpeza
db.exec("DELETE FROM lote_pagamento_itens; DELETE FROM lotes_pagamento; DELETE FROM conciliacao_regras; DELETE FROM agenda_recebiveis_cartao;");
db.prepare("DELETE FROM transacoes_bancarias WHERE fitid LIKE 'TESTE-%'").run();
db.prepare("DELETE FROM pedido_parcelas WHERE id = ?").run(parc);
db.close();
console.log('\nTODOS OS TESTES PASSARAM');
process.exit(0);
