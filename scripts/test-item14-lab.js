#!/usr/bin/env node
// Teste item 1.4 (cotações) no lab jaagricola — schema e fluxo.
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { migrarCotacoesDB } = require('../cotacoes-routes');

const db = new Database(path.join(__dirname, '..', 'data', 'tenants', 'jaagricola', 'pncp.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

function assert(cond, msg) {
  if (!cond) { console.error('FALHOU:', msg); process.exit(1); }
  console.log('OK:', msg);
}

migrarCotacoesDB(db);
assert(db.prepare(`SELECT count(*) n FROM sqlite_master WHERE name IN
  ('cotacoes','cotacao_itens','cotacao_fornecedores','cotacao_respostas')`).get().n === 4, 'tabelas de cotação criadas');

// limpeza
db.prepare("DELETE FROM cotacao_respostas").run();
db.prepare("DELETE FROM cotacao_fornecedores").run();
db.prepare("DELETE FROM cotacao_itens").run();
db.prepare("DELETE FROM cotacoes").run();
db.prepare("DELETE FROM fornecedores WHERE razaoSocial LIKE 'Forn Teste%'").run();

// fornecedores e produto
const f1 = db.prepare("INSERT INTO fornecedores (razaoSocial, cpfCnpj) VALUES ('Forn Teste A','00000000000101')").run().lastInsertRowid;
const f2 = db.prepare("INSERT INTO fornecedores (razaoSocial, cpfCnpj) VALUES ('Forn Teste B','00000000000202')").run().lastInsertRowid;
const prod = db.prepare("SELECT id FROM produtos WHERE sku='CAD-A4-75'").get();
assert(prod, 'produto CAD-A4-75 existe (do e2e 1.2)');

// cotação com 1 item vinculado + 1 avulso, 2 fornecedores
const cot = db.prepare(`INSERT INTO cotacoes (numero, descricao, status, dataLimite)
  VALUES ('COT-TESTE-01','Teste','enviada', date('now','+5 days'))`).run().lastInsertRowid;
const i1 = db.prepare("INSERT INTO cotacao_itens (cotacaoId, produtoId, descricao, quantidade) VALUES (?, ?, 'Caderno A4', 100)").run(cot, prod.id).lastInsertRowid;
const i2 = db.prepare("INSERT INTO cotacao_itens (cotacaoId, descricao, quantidade) VALUES (?, 'Item avulso sem produto', 10)").run(cot).lastInsertRowid;
const tk1 = crypto.randomBytes(24).toString('hex');
const tk2 = crypto.randomBytes(24).toString('hex');
const cf1 = db.prepare("INSERT INTO cotacao_fornecedores (cotacaoId, fornecedorId, tokenPublico, dataEnvio) VALUES (?, ?, ?, date('now'))").run(cot, f1, tk1).lastInsertRowid;
const cf2 = db.prepare("INSERT INTO cotacao_fornecedores (cotacaoId, fornecedorId, tokenPublico, dataEnvio) VALUES (?, ?, ?, date('now'))").run(cot, f2, tk2).lastInsertRowid;

// respostas: A cota 6.50, B cota 5.90 (vence B)
const insResp = db.prepare(`INSERT INTO cotacao_respostas (cotacaoFornecedorId, cotacaoItemId, precoUnitario, prazoEntregaDias)
  VALUES (?, ?, ?, ?)`);
insResp.run(cf1, i1, 6.50, 10);
insResp.run(cf2, i1, 5.90, 7);
insResp.run(cf2, i2, 2.00, 7);
db.prepare("UPDATE cotacao_fornecedores SET status='respondida', dataResposta=date('now') WHERE id IN (?,?)").run(cf1, cf2);

// upsert de re-resposta (fornecedor revisa preço)
db.prepare(`INSERT INTO cotacao_respostas (cotacaoFornecedorId, cotacaoItemId, precoUnitario)
  VALUES (?, ?, 5.75)
  ON CONFLICT(cotacaoFornecedorId, cotacaoItemId) DO UPDATE SET precoUnitario = excluded.precoUnitario`).run(cf2, i1);
const rev = db.prepare("SELECT precoUnitario FROM cotacao_respostas WHERE cotacaoFornecedorId=? AND cotacaoItemId=?").get(cf2, i1);
assert(rev.precoUnitario === 5.75, 'reenvio do fornecedor atualiza o preço (upsert)');

// menor preço do item 1 é do fornecedor B
const menor = db.prepare(`SELECT cf.fornecedorId, MIN(r.precoUnitario) p FROM cotacao_respostas r
  JOIN cotacao_fornecedores cf ON cf.id = r.cotacaoFornecedorId
  WHERE r.cotacaoItemId = ?`).get(i1);
assert(menor.fornecedorId === f2 && menor.p === 5.75, `comparativo: menor preço R$ ${menor.p} do fornecedor B`);

// geração de pedido do vencedor (item com produto): 100 × 5.75 = 575
const pc = db.prepare(`INSERT INTO pedidos_compra (numero, fornecedorId, status, valorTotal, observacoes)
  VALUES ('PC-TESTE-COT', ?, 'rascunho', 575, 'Gerado pela cotação COT-TESTE-01')`).run(f2).lastInsertRowid;
db.prepare("INSERT INTO pedido_compra_itens (pedidoCompraId, produtoId, quantidade, custoUnitario) VALUES (?, ?, 100, 5.75)").run(pc, prod.id);
const tot = db.prepare("SELECT SUM(quantidade*custoUnitario) v FROM pedido_compra_itens WHERE pedidoCompraId=?").get(pc);
assert(Math.abs(tot.v - 575) < 0.01, `pedido de compra do vencedor: R$ ${tot.v}`);

// token inválido não encontra nada
const nada = db.prepare("SELECT id FROM cotacao_fornecedores WHERE tokenPublico = ?").get('x'.repeat(48));
assert(!nada, 'token inválido não resolve');

// limpeza
db.prepare("DELETE FROM pedido_compra_itens WHERE pedidoCompraId=?").run(pc);
db.prepare("DELETE FROM pedidos_compra WHERE id=?").run(pc);
db.prepare("DELETE FROM cotacao_respostas").run();
db.prepare("DELETE FROM cotacao_fornecedores WHERE cotacaoId=?").run(cot);
db.prepare("DELETE FROM cotacao_itens WHERE cotacaoId=?").run(cot);
db.prepare("DELETE FROM cotacoes WHERE id=?").run(cot);
db.prepare("DELETE FROM fornecedores WHERE id IN (?,?)").run(f1, f2);
db.close();
console.log('\nTODOS OS TESTES PASSARAM');
process.exit(0);
