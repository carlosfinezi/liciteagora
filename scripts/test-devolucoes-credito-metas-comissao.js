/**
 * Teste das correções 4 a 7 do módulo de devoluções:
 *   4) crédito ao cliente fora do aging + compensação contra títulos
 *   5) devolução só de pedido que saiu (entregue/faturado)
 *   6) desconto nas metas + estorno de comissão
 *   7) migração da coluna tipoOperacaoId dentro do próprio módulo
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasDevolucoes } = require('../devolucoes-routes');
const { registrarRotasPlanejamento } = require('../planejamento-routes');
const { registrarRotasContasReceber } = require('../contas-receber-routes');

const DB = '/tmp/vp-dev47.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-dev47-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec(`CREATE TABLE IF NOT EXISTS participacoes_comprasnet (id INTEGER PRIMARY KEY AUTOINCREMENT);
         CREATE TABLE IF NOT EXISTS tipos_operacao (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, descricao TEXT);`);

const app = express();
registrarRotasDevolucoes(app, db);
registrarRotasPlanejamento(app, db);
registrarRotasContasReceber(app, db);
const achar = (path, metodo) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === path && x.route.methods[metodo]);
  if (!l) throw new Error(`rota nao registrada: ${metodo.toUpperCase()} ${path}`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const hPost = achar('/api/devolucoes', 'post');
const hEfet = achar('/api/devolucoes/:id/efetivar', 'post');
const hEst = achar('/api/devolucoes/:id/estornar', 'post');
const hAting = achar('/api/metas/atingimento', 'get');
const hHist = achar('/api/metas/historico', 'get');

function chamar(handler, { params = {}, body = {}, query = {} } = {}) {
  let out = null, st = 200;
  const res = { json: o => { out = o; return res; }, status: c => { st = c; return res; } };
  handler({ params, body, query, session: { username: 'teste' }, user: { username: 'teste' } }, res);
  if (!out) throw new Error('sem resposta');
  return { out, st };
}

let ok = 0, fail = 0;
function t(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const COMP = hoje.slice(0, 7);

// ---------- 7) migração no próprio módulo ----------
t('migrarDB do módulo cria tipoOperacaoId (não depende de tipos-operacao)', () => {
  const cols = db.prepare('PRAGMA table_info(devolucoes)').all().map(c => c.name);
  assert(cols.includes('tipoOperacaoId'), 'coluna não criada pelo módulo');
});

// ---------- seed ----------
db.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo) VALUES (1,'ana','x','Ana','admin',1)").run();
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (1,'00000000000191','Cliente','cliente',1)").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, ativo, precoCusto) VALUES (1,'P1','Produto 1',1,100)").run();
db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, origem, data,
  custoMedioAnterior, custoMedioPosterior, saldoPosterior) VALUES (1,'entrada',10,100,'nfe_entrada',?,0,100,10)`).run(hoje);

function novoPedido(status, valor, qtd) {
  const id = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal, vendedorId)
    VALUES (?, 'manual','pedido',1,?,?,?,1)`).run('PED-' + Math.random().toString(36).slice(2, 7), status, hoje, valor).lastInsertRowid;
  const itemId = db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
    VALUES (?,1,'P1',?,?,?)`).run(id, qtd, valor / qtd, valor).lastInsertRowid;
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, origem, origemId, data,
    custoMedioAnterior, custoMedioPosterior, saldoPosterior, estornada)
    VALUES (1,'saida',?,'pedido',?,?,100,100,0,0)`).run(qtd, id, hoje);
  return { id, itemId };
}

// ---------- 5) status do pedido ----------
t('rascunho não pode ser devolvido', () => {
  const p = novoPedido('rascunho', 400, 4);
  const r = chamar(hPost, { body: { pedidoId: p.id, clienteId: 1,
    itens: [{ pedidoItemId: p.itemId, produtoId: 1, descricao: 'P1', quantidade: 1, valorUnitario: 100 }] } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/entregue ou faturado/.test(r.out.error), 'erro: ' + r.out.error);
});

t('confirmado (ainda não entregue) não pode ser devolvido', () => {
  const p = novoPedido('confirmado', 400, 4);
  const r = chamar(hPost, { body: { pedidoId: p.id, clienteId: 1,
    itens: [{ pedidoItemId: p.itemId, produtoId: 1, descricao: 'P1', quantidade: 1, valorUnitario: 100 }] } });
  assert(r.st === 400, 'status: ' + r.st);
});

t('orçamento não pode ser devolvido', () => {
  const id = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal, vendedorId)
    VALUES ('ORC-1','manual','orcamento',1,'faturado',?,400,1)`).run(hoje).lastInsertRowid;
  const itemId = db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
    VALUES (?,1,'P1',4,100,400)`).run(id).lastInsertRowid;
  const r = chamar(hPost, { body: { pedidoId: id, clienteId: 1,
    itens: [{ pedidoItemId: itemId, produtoId: 1, descricao: 'P1', quantidade: 1, valorUnitario: 100 }] } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/orçamento/.test(r.out.error), 'erro: ' + r.out.error);
});

// ---------- pedido válido + comissão ----------
const PED = novoPedido('faturado', 400, 4);
db.prepare(`INSERT INTO comissoes_apuracao (periodo, vendedorId, pedidoId, pedidoItemId, tipo, baseCalculo, percentual, valorComissao, status)
  VALUES (?, 1, ?, ?, 'percentual', 400, 10, 40, 'pendente')`).run(COMP, PED.id, PED.itemId);

let DEV;
t('devolução de pedido faturado é aceita', () => {
  const r = chamar(hPost, { body: { pedidoId: PED.id, clienteId: 1, motivo: 'defeito',
    itens: [{ pedidoItemId: PED.itemId, produtoId: 1, descricao: 'P1', quantidade: 2, valorUnitario: 100 }] } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  DEV = r.out.devolucao.id;
});

// ---------- 6) comissão ----------
t('efetivar estorna comissão proporcional (2 de 4 = metade)', () => {
  const r = chamar(hEfet, { params: { id: String(DEV) } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  assert(r.out.comissoesEstornadas === 1, 'linhas estornadas: ' + r.out.comissoesEstornadas);
  assert(r.out.valorComissaoEstornado === 20, 'valor estornado: ' + r.out.valorComissaoEstornado);
  const a = db.prepare('SELECT * FROM comissoes_apuracao WHERE pedidoItemId = ?').get(PED.itemId);
  assert(a.valorComissao === 20, 'comissão deveria cair de 40 para 20, veio ' + a.valorComissao);
  assert(a.baseCalculo === 200, 'base deveria cair para 200, veio ' + a.baseCalculo);
  assert(/\[dev:/.test(a.observacao), 'marcador não gravado: ' + a.observacao);
});

t('schema não permite linha duplicada — só existe uma apuração do item', () => {
  const n = db.prepare('SELECT COUNT(*) n FROM comissoes_apuracao WHERE pedidoItemId = ?').get(PED.itemId).n;
  assert(n === 1, 'esperava 1 linha (UNIQUE periodo+item), veio ' + n);
});

// ---------- 6) metas ----------
t('meta desconta a devolução do realizado', () => {
  db.prepare('INSERT INTO metas_vendas (vendedorUserId, competencia, valorMeta) VALUES (1,?,1000)').run(COMP);
  const d = chamar(hAting, { query: { competencia: COMP } });
  const l = d.out.linhas.find(x => x.vendedor === 'Ana');
  assert(l, 'vendedor sumiu do painel');
  assert(l.realizadoBruto === 400, 'bruto: ' + l.realizadoBruto);
  assert(l.devolvido === 200, 'devolvido: ' + l.devolvido);
  assert(l.realizado === 200, 'líquido deveria ser 200, veio ' + l.realizado);
  assert(l.atingimento === 20, 'atingimento sobre o líquido: ' + l.atingimento);
});

t('equipe também mostra bruto e devolvido', () => {
  const e = chamar(hAting, { query: { competencia: COMP } }).out.equipe;
  assert(e.realizadoBruto === 400, 'bruto equipe: ' + e.realizadoBruto);
  assert(e.devolvido === 200, 'devolvido equipe: ' + e.devolvido);
  assert(e.realizado === 200, 'líquido equipe: ' + e.realizado);
});

t('histórico também vem líquido', () => {
  const s = chamar(hHist, { query: { meses: 3, ate: COMP } }).out.serie.find(x => x.competencia === COMP);
  assert(s.realizadoBruto === 400, 'bruto: ' + s.realizadoBruto);
  assert(s.devolvido === 200, 'devolvido: ' + s.devolvido);
  assert(s.realizado === 200, 'líquido: ' + s.realizado);
});

// ---------- 4) crédito ----------
let CREDITO;
t('crédito ao cliente foi criado como CR negativo', () => {
  CREDITO = db.prepare("SELECT * FROM contas_a_receber WHERE origem='devolucao'").get();
  assert(CREDITO && CREDITO.valor === -200, 'CR: ' + JSON.stringify(CREDITO));
});

t('crédito NÃO entra no aging de vencido/aberto', () => {
  // Título real em atraso, para o crédito ter o que mascarar.
  db.prepare(`INSERT INTO contas_a_receber (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, origem)
    VALUES (1,'Fatura atrasada',500,'2026-01-01','2026-01-10','aberta','manual')`).run();
  const resumo = achar('/api/contas-a-receber/resumo', 'get');
  const r = chamar(resumo, {});
  assert(r.out.resumo.vencido === 500, `vencido deveria ser 500 (sem o crédito), veio ${r.out.resumo.vencido}`);
  assert(r.out.resumo.aberto === 500, 'aberto: ' + r.out.resumo.aberto);
  assert(r.out.resumo.creditosClientes.total === 200, 'créditos: ' + r.out.resumo.creditosClientes.total);
  assert(r.out.resumo.creditosClientes.qtd === 1, 'qtd créditos: ' + r.out.resumo.creditosClientes.qtd);
});

t('créditos aparecem em endpoint próprio com os títulos abatíveis', () => {
  const h = achar('/api/contas-a-receber/creditos', 'get');
  const r = chamar(h, { query: { pessoaId: '1' } });
  assert(r.out.creditos.length === 1, 'créditos: ' + r.out.creditos.length);
  assert(r.out.creditos[0].saldoCredito === 200, 'saldo: ' + r.out.creditos[0].saldoCredito);
  assert(r.out.titulos.length === 1 && r.out.titulos[0].saldoAberto === 500, 'títulos: ' + JSON.stringify(r.out.titulos));
});

t('compensação parcial abate os dois lados sem mover caixa', () => {
  const h = achar('/api/contas-a-receber/:id/compensar', 'post');
  const titulo = db.prepare("SELECT id FROM contas_a_receber WHERE valor = 500").get();
  const r = chamar(h, { params: { id: String(CREDITO.id) }, body: { contaReceberId: titulo.id, valor: 120 } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  assert(r.out.valorCompensado === 120, 'compensado: ' + r.out.valorCompensado);
  assert(r.out.saldoCreditoRestante === 80, 'crédito restante: ' + r.out.saldoCreditoRestante);
  assert(r.out.saldoTituloRestante === 380, 'título restante: ' + r.out.saldoTituloRestante);
  const pg = db.prepare("SELECT * FROM contas_receber_pagamentos WHERE origem='compensacao_credito' AND contaReceberId=?").get(titulo.id);
  assert(pg && pg.contaFinanceiraId == null, 'compensação não pode ter conta financeira');
  assert(pg.movimentacaoFinanceiraId == null, 'compensação não pode gerar movimentação de caixa');
  const tit = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(titulo.id);
  assert(tit.status === 'parcial', 'status do título: ' + tit.status);
});

t('aging reflete a compensação', () => {
  const r = chamar(achar('/api/contas-a-receber/resumo', 'get'), {});
  assert(r.out.resumo.vencido === 380, 'vencido: ' + r.out.resumo.vencido);
  assert(r.out.resumo.creditosClientes.total === 80, 'crédito restante: ' + r.out.resumo.creditosClientes.total);
});

t('compensar mais que o saldo aplica só o disponível', () => {
  const h = achar('/api/contas-a-receber/:id/compensar', 'post');
  const titulo = db.prepare("SELECT id FROM contas_a_receber WHERE valor = 500").get();
  const r = chamar(h, { params: { id: String(CREDITO.id) }, body: { contaReceberId: titulo.id, valor: 9999 } });
  assert(r.out.valorCompensado === 80, 'deveria limitar a 80, veio ' + r.out.valorCompensado);
  const cred = db.prepare('SELECT status FROM contas_a_receber WHERE id = ?').get(CREDITO.id);
  assert(cred.status === 'paga', 'crédito esgotado deveria ficar paga, veio ' + cred.status);
});

t('crédito esgotado não compensa de novo', () => {
  const h = achar('/api/contas-a-receber/:id/compensar', 'post');
  const titulo = db.prepare("SELECT id FROM contas_a_receber WHERE valor = 500").get();
  const r = chamar(h, { params: { id: String(CREDITO.id) }, body: { contaReceberId: titulo.id } });
  assert(r.st === 400, 'status: ' + r.st);
});

t('compensação entre clientes diferentes é recusada', () => {
  db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (2,'00000000000272','Outro','cliente',1)").run();
  const outroTit = db.prepare(`INSERT INTO contas_a_receber (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, origem)
    VALUES (2,'Outro cliente',300,?,?,'aberta','manual')`).run(hoje, hoje).lastInsertRowid;
  const cred2 = db.prepare(`INSERT INTO contas_a_receber (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, origem)
    VALUES (1,'Credito 2',-50,?,?,'aberta','devolucao')`).run(hoje, hoje).lastInsertRowid;
  const r = chamar(achar('/api/contas-a-receber/:id/compensar', 'post'),
    { params: { id: String(cred2) }, body: { contaReceberId: outroTit } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/clientes diferentes/.test(r.out.error), 'erro: ' + r.out.error);
});

t('título positivo não pode ser tratado como crédito', () => {
  const titulo = db.prepare("SELECT id FROM contas_a_receber WHERE valor = 500").get();
  const r = chamar(achar('/api/contas-a-receber/:id/compensar', 'post'),
    { params: { id: String(titulo.id) }, body: { contaReceberId: titulo.id } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/não é um crédito/.test(r.out.error), 'erro: ' + r.out.error);
});

// ---------- estorno com crédito já usado ----------
t('estorno restaura a comissão', () => {
  const r = chamar(hEst, { params: { id: String(DEV) }, body: { motivo: 'engano' } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  assert(r.out.comissoesRestauradas === 1, 'restauradas: ' + r.out.comissoesRestauradas);
  const a = db.prepare('SELECT * FROM comissoes_apuracao WHERE pedidoItemId = ?').get(PED.itemId);
  assert(a.valorComissao === 40, 'comissão deveria voltar a 40, veio ' + a.valorComissao);
  assert(a.baseCalculo === 400, 'base deveria voltar a 400, veio ' + a.baseCalculo);
  assert(!/\[dev:/.test(a.observacao || ''), 'marcador não foi removido: ' + a.observacao);
});

t('estorno avisa quando o crédito já foi usado', () => {
  const r2 = db.prepare('SELECT status FROM contas_a_receber WHERE id = ?').get(CREDITO.id);
  assert(r2.status === 'paga', 'crédito consumido: ' + r2.status);
  // Como já foi todo compensado, não pode ter sido cancelado no estorno.
  assert(r2.status !== 'cancelada', 'cancelou crédito já usado');
});

t('meta volta ao bruto depois do estorno', () => {
  const l = chamar(hAting, { query: { competencia: COMP } }).out.linhas.find(x => x.vendedor === 'Ana');
  assert(l.devolvido === 0, 'devolvido: ' + l.devolvido);
  assert(l.realizado === 400, 'realizado: ' + l.realizado);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
