#!/usr/bin/env node
// Teste lote 2.2 (requisições) + 2.3 (tabelas de preço + vendas perdidas) no lab.
const path = require('path');
const Database = require('better-sqlite3');
const { migrarRequisicoesDB } = require('../requisicoes-routes');
const { migrarPrecosDB, resolverPreco } = require('../precos-routes');
const { calcularSaldo, getDepositoPadraoId, calcularContextoMovimento } = require('../estoque-routes');

const db = new Database(path.join(__dirname, '..', 'data', 'tenants', 'jaagricola', 'pncp.db'));
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = OFF');
function assert(c, m){ if(!c){ console.error('FALHOU:', m); process.exit(1);} console.log('OK:', m); }

migrarRequisicoesDB(db); migrarPrecosDB(db);
assert(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('requisicoes','requisicao_itens','tabelas_preco','tabela_preco_itens','vendas_perdidas')").get().n === 5, 'tabelas do lote criadas');
assert(db.prepare("SELECT count(*) n FROM pragma_table_info('pessoas') WHERE name='tabelaPrecoId'").get().n === 1, 'pessoas.tabelaPrecoId existe');

// limpeza
db.exec("DELETE FROM requisicao_itens; DELETE FROM requisicoes; DELETE FROM tabela_preco_itens; DELETE FROM tabelas_preco; DELETE FROM vendas_perdidas;");
db.prepare("DELETE FROM movimentacoes_estoque WHERE origem='requisicao'").run();

const prod = db.prepare("SELECT id, precoVenda FROM produtos WHERE sku='CAD-A4-75'").get();
const depPadrao = getDepositoPadraoId(db);

// ===== 2.2 requisição: atender 5 gera saída no depósito padrão =====
const saldoAntes = calcularSaldo(db, prod.id, depPadrao);
const reqId = db.prepare("INSERT INTO requisicoes (numero, setorTexto) VALUES ('REQ-T-1','Escritorio')").run().lastInsertRowid;
const itId = db.prepare("INSERT INTO requisicao_itens (requisicaoId, produtoId, quantidadeSolicitada) VALUES (?, ?, 5)").run(reqId, prod.id).lastInsertRowid;
const ctx = calcularContextoMovimento(db, prod.id, 'saida', 5, null);
db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, origem, origemId, observacao, data, depositoId,
  custoMedioAnterior, custoMedioPosterior, saldoPosterior) VALUES (?, 'saida', 5, 'requisicao', ?, 'REQ-T-1', date('now'), ?, ?, ?, ?)`)
  .run(prod.id, reqId, depPadrao, ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior);
db.prepare("UPDATE requisicao_itens SET quantidadeAtendida = 5 WHERE id = ?").run(itId);
assert(calcularSaldo(db, prod.id, depPadrao) === saldoAntes - 5, `saída da requisição baixou o depósito (${saldoAntes} → ${saldoAntes-5})`);

// ===== 2.3 resolução de preço =====
const tabGov = db.prepare("INSERT INTO tabelas_preco (nome, prioridade) VALUES ('Governo', 10)").run().lastInsertRowid;
const tabPromo = db.prepare("INSERT INTO tabelas_preco (nome, prioridade, vigenciaFim) VALUES ('Promo vencida', 99, '2026-01-31')").run().lastInsertRowid;
db.prepare("INSERT INTO tabela_preco_itens (tabelaId, produtoId, preco, qtdMinima) VALUES (?, ?, 11.00, 0)").run(tabGov, prod.id);
db.prepare("INSERT INTO tabela_preco_itens (tabelaId, produtoId, preco, qtdMinima) VALUES (?, ?, 9.50, 100)").run(tabGov, prod.id);
db.prepare("INSERT INTO tabela_preco_itens (tabelaId, produtoId, preco, qtdMinima) VALUES (?, ?, 1.00, 0)").run(tabPromo, prod.id);

let r = resolverPreco(db, prod.id, { quantidade: 1 });
assert(r.preco === 11.00 && r.fonte === 'tabela', `qtd 1 → tabela Governo R$ ${r.preco} (promo vencida ignorada)`);
r = resolverPreco(db, prod.id, { quantidade: 150 });
assert(r.preco === 9.50, `qtd 150 → faixa qtdMinima 100 R$ ${r.preco}`);

// cliente com tabela própria
const tabVip = db.prepare("INSERT INTO tabelas_preco (nome, prioridade) VALUES ('VIP', 1)").run().lastInsertRowid;
db.prepare("INSERT INTO tabela_preco_itens (tabelaId, produtoId, preco, qtdMinima) VALUES (?, ?, 8.00, 0)").run(tabVip, prod.id);
db.prepare("UPDATE pessoas SET tabelaPrecoId = ? WHERE id = 1").run(tabVip);
r = resolverPreco(db, prod.id, { pessoaId: 1, quantidade: 1 });
assert(r.preco === 8.00 && r.fonte === 'tabela_cliente', `cliente com tabela própria → VIP R$ ${r.preco} (vence prioridade geral)`);

// produto fora de qualquer tabela → precoVenda
const prod2 = db.prepare("SELECT id, precoVenda FROM produtos WHERE sku='LAPIS-HB'").get();
r = resolverPreco(db, prod2.id, {});
assert(r.fonte === 'produto' && r.preco === prod2.precoVenda, `sem tabela → preço do cadastro R$ ${r.preco}`);

// ===== vendas perdidas =====
db.prepare("INSERT INTO vendas_perdidas (data, produtoId, quantidade, precoAlvo, motivo) VALUES (date('now'), ?, 50, 12.5, 'sem_estoque')").run(prod.id);
const vp = db.prepare("SELECT COUNT(*) n, SUM(quantidade*precoAlvo) v FROM vendas_perdidas WHERE motivo='sem_estoque'").get();
assert(vp.n === 1 && Math.abs(vp.v - 625) < 0.01, `venda perdida registrada (R$ ${vp.v})`);

// limpeza
db.exec("DELETE FROM requisicao_itens; DELETE FROM requisicoes; DELETE FROM tabela_preco_itens; DELETE FROM tabelas_preco; DELETE FROM vendas_perdidas;");
db.prepare("UPDATE pessoas SET tabelaPrecoId = NULL WHERE id = 1").run();
db.prepare("DELETE FROM movimentacoes_estoque WHERE origem='requisicao'").run();
db.close();
console.log('\nTODOS OS TESTES PASSARAM');
process.exit(0);
