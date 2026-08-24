/**
 * Recebíveis de cartão: do pedido à liquidação.
 * A agenda manda na baixa da conta a receber, e a taxa da adquirente vira
 * despesa financeira — o faturamento fica bruto.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const T = require('../tesouraria-routes');

const DB = '/tmp/vp-cartao.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-cartao-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT, acao TEXT, entidade TEXT, entidadeId INTEGER, detalhes TEXT, ip TEXT,
  dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);

const app = express();
T.registrarRotasTesouraria(app, db);
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
const perto = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ---------- seed ----------
const CONTA = db.prepare("INSERT INTO contas_financeiras (nome, tipo, ativo) VALUES ('Banco','corrente',1)").run().lastInsertRowid;
const PC52 = db.prepare("INSERT INTO plano_contas (codigo, nome, tipo, nivel) VALUES ('5.2','Despesas Financeiras','financeiro_despesa',2)").run().lastInsertRowid;
const CLIENTE = db.prepare("INSERT INTO pessoas (cpfCnpj, razaoSocial, tipo, ativo) VALUES ('00000000000191','Cliente','cliente',1)").run().lastInsertRowid;
// Adquirente com taxa 3% e liquidação em 30 dias.
const ADQ = db.prepare(`INSERT INTO adquirentes_cartao (nome, taxaPercentual, prazoLiquidacaoDias, contaFinanceiraPadraoId, ativo)
  VALUES ('Cielo', 3.0, 30, ?, 1)`).run(CONTA).lastInsertRowid;

const PEDIDO = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal)
  VALUES ('PED-1','manual','pedido',?, 'faturado','2026-08-01',1000)`).run(CLIENTE).lastInsertRowid;
const FATURA = db.prepare(`INSERT INTO faturas (numero, pedidoId, clienteId, valorBruto, valorTotal, dataEmissao, dataVencimento, status)
  VALUES ('FAT-1', ?, ?, 1000, 1000, '2026-08-01', '2026-08-31', 'emitida')`).run(PEDIDO, CLIENTE).lastInsertRowid;
// A CR que o faturamento cria: em nome do CLIENTE, vinculada à adquirente.
const CR = db.prepare(`INSERT INTO contas_a_receber
  (pessoaId, faturaId, descricao, valor, dataEmissao, dataVencimento, status, origem, adquirenteCartaoId, parcelaNumero)
  VALUES (?, ?, 'Fatura FAT-1', 1000, '2026-08-01', '2026-08-31', 'aberta', 'cartao_adquirente', ?, 1)`)
  .run(CLIENTE, FATURA, ADQ).lastInsertRowid;
const PARC = db.prepare(`INSERT INTO pedido_parcelas (pedidoId, numeroParcela, valor, dataVencimento, meioPagamento, bandeiraId)
  VALUES (?, 1, 1000, '2026-08-31', '03', ?)`).run(PEDIDO, ADQ).lastInsertRowid;

// ---------- geração da agenda ----------
t('a agenda nasce ligada à conta a receber daquela parcela', () => {
  const r = chamar('/api/cartoes/agenda/gerar', 'post', {});
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.geradas === 1, 'geradas: ' + r.out.geradas);
  const ag = db.prepare('SELECT * FROM agenda_recebiveis_cartao WHERE parcelaId = ?').get(PARC);
  // Sem este elo, conciliar o recebível deixava a CR aberta para sempre.
  assert(ag.contaReceberId === CR, 'nao amarrou a CR: ' + ag.contaReceberId);
});

t('taxa e líquido saem do cadastro da adquirente', () => {
  const ag = db.prepare('SELECT * FROM agenda_recebiveis_cartao WHERE parcelaId = ?').get(PARC);
  assert(perto(ag.valorBruto, 1000), 'bruto: ' + ag.valorBruto);
  assert(perto(ag.taxa, 30), 'taxa 3% de 1000: ' + ag.taxa);
  assert(perto(ag.valorLiquido, 970), 'liquido: ' + ag.valorLiquido);
  assert(ag.dataPrevistaLiquidacao === '2026-08-31', 'previsao (30 dias): ' + ag.dataPrevistaLiquidacao);
});

t('gerar de novo não duplica a mesma parcela', () => {
  const r = chamar('/api/cartoes/agenda/gerar', 'post', {});
  assert(r.out.geradas === 0, 'duplicou: ' + r.out.geradas);
});

// ---------- liquidação ----------
let AG;
t('conciliar baixa a conta a receber pelo valor BRUTO', () => {
  AG = db.prepare('SELECT * FROM agenda_recebiveis_cartao WHERE parcelaId = ?').get(PARC);
  // O banco credita o líquido: é isso que aparece no extrato.
  const trx = db.prepare(`INSERT INTO transacoes_bancarias (contaFinanceiraId, fitid, data, valor, descricao)
    VALUES (?, 'FIT-CARD', '2026-08-31', 970, 'CIELO LIQUIDACAO')`).run(CONTA).lastInsertRowid;
  const r = chamar('/api/cartoes/agenda/:id/conciliar', 'post',
    { params: { id: String(AG.id) }, body: { transacaoBancariaId: trx } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(!r.out.divergente, 'nao devia divergir: liquido bate com o extrato');

  const cr = db.prepare('SELECT status, valorPago FROM contas_a_receber WHERE id = ?').get(CR);
  assert(cr.status === 'paga', 'CR ficou ' + cr.status);
  // Faturamento bruto: baixar pelo liquido encolheria a receita.
  assert(perto(cr.valorPago, 1000), 'baixou pelo liquido: ' + cr.valorPago);
});

t('a taxa vira despesa financeira no plano de contas', () => {
  const ag = db.prepare('SELECT contaPagarTaxaId FROM agenda_recebiveis_cartao WHERE id = ?').get(AG.id);
  assert(ag.contaPagarTaxaId, 'nao lancou a taxa');
  const cp = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(ag.contaPagarTaxaId);
  assert(perto(cp.valor, 30), 'valor da taxa: ' + cp.valor);
  assert(cp.planoContaId === PC52, 'plano de contas: ' + cp.planoContaId);
  assert(cp.status === 'paga', 'a taxa ja foi retida, deveria nascer paga: ' + cp.status);
  assert(cp.origem === 'taxa_cartao', 'origem: ' + cp.origem);
});

t('a adquirente vira fornecedor, para a despesa ter dono', () => {
  const cp = db.prepare("SELECT fornecedorId FROM contas_a_pagar WHERE origem='taxa_cartao'").get();
  const f = db.prepare('SELECT razaoSocial FROM fornecedores WHERE id = ?').get(cp.fornecedorId);
  assert(f && f.razaoSocial === 'Cielo', 'fornecedor: ' + JSON.stringify(f));
});

t('o caixa fecha no líquido: entra o bruto, sai a taxa', () => {
  const mov = db.prepare('SELECT tipo, valor FROM movimentacoes_financeiras WHERE contaId = ? ORDER BY id').all(CONTA);
  const entrada = mov.filter(m => m.tipo === 'entrada').reduce((s, m) => s + m.valor, 0);
  const saida = mov.filter(m => m.tipo === 'saida').reduce((s, m) => s + m.valor, 0);
  assert(perto(entrada, 1000), 'entrada bruta: ' + entrada);
  assert(perto(saida, 30), 'saida da taxa: ' + saida);
  // O saldo tem de bater com o que o banco creditou.
  assert(perto(entrada - saida, 970), 'saldo liquido: ' + (entrada - saida));
});

t('a transação do extrato fica conciliada com o recebível', () => {
  const trx = db.prepare("SELECT conciliadaCom, conciliadaId FROM transacoes_bancarias WHERE fitid='FIT-CARD'").get();
  assert(trx.conciliadaCom === 'cartao' && trx.conciliadaId === AG.id, JSON.stringify(trx));
});

t('conciliar duas vezes é recusado', () => {
  const r = chamar('/api/cartoes/agenda/:id/conciliar', 'post',
    { params: { id: String(AG.id) }, body: { transacaoBancariaId: 1 } });
  assert(r.st === 400, 'status: ' + r.st);
});

// ---------- casos de borda ----------
t('recebível sem CR vinculada avisa em vez de baixar às cegas', () => {
  const p2 = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal)
    VALUES ('PED-2','manual','pedido',?, 'confirmado','2026-08-02',500)`).run(CLIENTE).lastInsertRowid;
  db.prepare(`INSERT INTO pedido_parcelas (pedidoId, numeroParcela, valor, dataVencimento, meioPagamento, bandeiraId)
    VALUES (?, 1, 500, '2026-09-01', '03', ?)`).run(p2, ADQ);
  chamar('/api/cartoes/agenda/gerar', 'post', {});
  const ag = db.prepare('SELECT * FROM agenda_recebiveis_cartao WHERE pedidoId = ?').get(p2);
  assert(ag.contaReceberId === null, 'pedido sem fatura nao devia ter CR');

  const trx = db.prepare(`INSERT INTO transacoes_bancarias (contaFinanceiraId, fitid, data, valor, descricao)
    VALUES (?, 'FIT-2', '2026-09-01', 485, 'CIELO')`).run(CONTA).lastInsertRowid;
  const r = chamar('/api/cartoes/agenda/:id/conciliar', 'post',
    { params: { id: String(ag.id) }, body: { transacaoBancariaId: trx } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(!r.out.crBaixada, 'baixou uma CR que nao existe');
  assert(r.out.avisos.some(a => /sem conta a receber/i.test(a)), 'avisos: ' + JSON.stringify(r.out.avisos));
});

t('divergência entre extrato e previsto é sinalizada', () => {
  const p3 = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal)
    VALUES ('PED-3','manual','pedido',?, 'confirmado','2026-08-03',200)`).run(CLIENTE).lastInsertRowid;
  db.prepare(`INSERT INTO pedido_parcelas (pedidoId, numeroParcela, valor, dataVencimento, meioPagamento, bandeiraId)
    VALUES (?, 1, 200, '2026-09-02', '03', ?)`).run(p3, ADQ);
  chamar('/api/cartoes/agenda/gerar', 'post', {});
  const ag = db.prepare('SELECT * FROM agenda_recebiveis_cartao WHERE pedidoId = ?').get(p3);
  const trx = db.prepare(`INSERT INTO transacoes_bancarias (contaFinanceiraId, fitid, data, valor, descricao)
    VALUES (?, 'FIT-3', '2026-09-02', 150, 'CIELO MENOR')`).run(CONTA).lastInsertRowid;
  const r = chamar('/api/cartoes/agenda/:id/conciliar', 'post',
    { params: { id: String(ag.id) }, body: { transacaoBancariaId: trx } });
  assert(r.out.divergente === true, 'extrato 150 x previsto 194 deveria divergir');
  const salvo = db.prepare('SELECT status, observacao FROM agenda_recebiveis_cartao WHERE id = ?').get(ag.id);
  assert(salvo.status === 'divergente', 'status: ' + salvo.status);
  assert(/Diverg/.test(salvo.observacao || ''), 'sem o motivo: ' + salvo.observacao);
});

t('adquirente sem taxa não gera despesa nenhuma', () => {
  const semTaxa = db.prepare(`INSERT INTO adquirentes_cartao (nome, taxaPercentual, prazoLiquidacaoDias, contaFinanceiraPadraoId, ativo)
    VALUES ('SemTaxa', 0, 1, ?, 1)`).run(CONTA).lastInsertRowid;
  const p4 = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal)
    VALUES ('PED-4','manual','pedido',?, 'confirmado','2026-08-04',100)`).run(CLIENTE).lastInsertRowid;
  db.prepare(`INSERT INTO pedido_parcelas (pedidoId, numeroParcela, valor, dataVencimento, meioPagamento, bandeiraId)
    VALUES (?, 1, 100, '2026-08-05', '03', ?)`).run(p4, semTaxa);
  chamar('/api/cartoes/agenda/gerar', 'post', {});
  const ag = db.prepare('SELECT * FROM agenda_recebiveis_cartao WHERE pedidoId = ?').get(p4);
  assert(perto(ag.taxa, 0) && perto(ag.valorLiquido, 100), 'sem taxa: ' + JSON.stringify(ag));
  const antes = db.prepare("SELECT COUNT(*) n FROM contas_a_pagar WHERE origem='taxa_cartao'").get().n;
  const trx = db.prepare(`INSERT INTO transacoes_bancarias (contaFinanceiraId, fitid, data, valor, descricao)
    VALUES (?, 'FIT-4', '2026-08-05', 100, 'X')`).run(CONTA).lastInsertRowid;
  chamar('/api/cartoes/agenda/:id/conciliar', 'post',
    { params: { id: String(ag.id) }, body: { transacaoBancariaId: trx } });
  const depois = db.prepare("SELECT COUNT(*) n FROM contas_a_pagar WHERE origem='taxa_cartao'").get().n;
  assert(antes === depois, 'lancou despesa de taxa zero');
});

t('pedido em rascunho não entra na agenda', () => {
  const p5 = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal)
    VALUES ('PED-5','manual','pedido',?, 'rascunho','2026-08-05',300)`).run(CLIENTE).lastInsertRowid;
  db.prepare(`INSERT INTO pedido_parcelas (pedidoId, numeroParcela, valor, dataVencimento, meioPagamento, bandeiraId)
    VALUES (?, 1, 300, '2026-09-05', '03', ?)`).run(p5, ADQ);
  chamar('/api/cartoes/agenda/gerar', 'post', {});
  const ag = db.prepare('SELECT id FROM agenda_recebiveis_cartao WHERE pedidoId = ?').get(p5);
  assert(!ag, 'rascunho virou recebivel');
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
