/**
 * Ciclo de aprovação, segurança e faturamento da Fase 1 — no tenant SANDBOX.
 *
 * Complementa `sandbox-fase1-matriz.js`, que cobre a matriz de desconto e o
 * tipo de atendimento. Aqui ficam as três coisas que a matriz não alcança:
 *
 *   9  — o ciclo completo da aprovação, incluindo o CONSUMO (a aprovação não
 *        pode liberar duas confirmações);
 *   11 — as tentativas de burlar, cada uma barrada pelo backend;
 *   12 — a herança do desconto na fatura: omitir herda, informar substitui,
 *        nunca soma.
 *
 * Roda contra o banco real do sandbox. Toda massa criada leva a marca
 * `FASE1-APROV` em `observacoesInterna` e é removida ao final — o sandbox volta
 * ao estado em que estava.
 */
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const DB = path.join(RAIZ, 'data', 'tenants', 'sandbox', 'pncp.db');
const MARCA = 'FASE1-APROV';

const db = new Database(DB);
const { registrarRotasPedidos } = require(RAIZ + '/pedidos-routes');
const { registrarRotasProdutos } = require(RAIZ + '/produtos-routes');
const { registrarRotasReservas } = require(RAIZ + '/reservas-routes');
const { registrarRotasFaturas } = require(RAIZ + '/faturas-routes');
const descontos = require(RAIZ + '/pedido-desconto');

const app = express();
registrarRotasPedidos(app, db);
registrarRotasProdutos(app, db);
registrarRotasReservas(app, db);
registrarRotasFaturas(app, db);

const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find((x) => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                session: o.session || {}, user: o.user, ip: '127.0.0.1', headers: {} },
    { json: (x) => { out = x; return { json: (y) => { out = y; } }; },
      status: (c) => { st = c; return { json: (x) => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

const u = (n) => db.prepare('SELECT * FROM users WHERE username = ?').get(n);
const ator = (n) => { const r = u(n); return { session: { userId: r.id },
  user: { id: r.id, username: r.username, role: r.role, ativo: 1, ehVendedor: r.ehVendedor } }; };
const VEND = ator('vendedor'), GERENTE = ator('gerente'), ADMIN = ator('admin');

const cliente = db.prepare('SELECT * FROM pessoas WHERE ativo = 1 ORDER BY id LIMIT 1').get();
const produto = db.prepare('SELECT * FROM produtos WHERE ativo = 1 AND precoVenda > 0 ORDER BY id LIMIT 1').get();

const criados = [];
function montar(a, qtd = 5) {
  const p = chamar('/api/pedidos', 'post', { ...a, body: { clienteId: cliente.id } }).out.pedido;
  criados.push(p.id);
  chamar('/api/pedidos/:id', 'put', { ...a, params: { id: p.id }, body: { observacoesInterna: MARCA } });
  chamar('/api/pedidos/:id/itens', 'post', { ...a, params: { id: p.id },
    body: { produtoId: produto.id, descricao: produto.descricao, quantidade: qtd } });
  return p.id;
}
const ler = (id) => db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
const put = (a, id, body) => chamar('/api/pedidos/:id', 'put', { ...a, params: { id }, body });
const confirmar = (a, id) => chamar('/api/pedidos/:id/confirmar', 'post', { ...a, params: { id }, body: {} });
const aprovDe = (id) => db.prepare(
  "SELECT * FROM aprovacoes WHERE tipoEvento='desconto_venda' AND referenciaId=? ORDER BY id DESC").get(id);

console.log('### Sandbox — aprovação, segurança e faturamento (processo com o código ativo)\n');

// ==================== 9. APROVAÇÃO ====================
console.log('--- 9. ciclo da aprovação ---');

let PED_APROV;
t('9a. desconto acima da alcada CRIA a solicitacao, com todos os dados', () => {
  PED_APROV = montar(VEND);
  const r = put(VEND, PED_APROV, { descontoPercentual: 10, descontoMotivo: 'cliente fecha 12x, volume alto' });
  assert(r.st === 200, 'status=' + r.st + ' ' + JSON.stringify(r.out.error));
  const a = aprovDe(PED_APROV);
  assert(a, 'nao criou solicitacao');
  assert(a.status === 'pendente', 'status=' + a.status);
  assert(a.solicitante === 'vendedor', 'solicitante=' + a.solicitante);
  assert(Number(a.valorReferencia) === 10, 'percentual=' + a.valorReferencia);
  assert(a.papelExigido === 'gerente-comercial', 'papel=' + a.papelExigido);
  assert(a.dataCriacao && a.expiraEm, 'sem data/hora ou validade');
  assert(ler(PED_APROV).descontoMotivo === 'cliente fecha 12x, volume alto', 'motivo nao gravado');
});

t('9b. motivo OBRIGATORIO acima da alcada, e sem ele nada e aberto', () => {
  const p = montar(VEND);
  const r = put(VEND, p, { descontoPercentual: 10 });
  assert(r.st === 422, 'status=' + r.st);
  assert(/descontoMotivo/i.test(r.out.error), 'msg=' + r.out.error);
  assert(!aprovDe(p), 'abriu solicitacao sem motivo');
});

t('9c. o pedido NAO confirma antes da aprovacao', () => {
  const r = confirmar(VEND, PED_APROV);
  assert(r.st === 409, 'status=' + r.st);
  assert(/aguarda aprovação/i.test(r.out.error), 'msg=' + r.out.error);
  assert(ler(PED_APROV).status === 'rascunho', 'virou venda: ' + ler(PED_APROV).status);
});

t('9d. a aprovacao pode ser decidida (gerente aprova)', () => {
  const a = aprovDe(PED_APROV);
  db.prepare(`UPDATE aprovacoes SET status='aprovada', aprovador='gerente',
    dataDecisao=datetime('now','-3 hours'), valorAprovado=? WHERE id=?`).run(10, a.id);
  const d = aprovDe(PED_APROV);
  assert(d.status === 'aprovada' && d.aprovador === 'gerente' && d.dataDecisao, 'nao registrou decisao');
});

t('9e. depois de aprovada, o pedido confirma', () => {
  const r = confirmar(VEND, PED_APROV);
  assert(r.st === 200, 'nao confirmou: ' + JSON.stringify(r.out.error));
  assert(ler(PED_APROV).status === 'confirmado', 'status=' + ler(PED_APROV).status);
});

t('9f. a aprovacao foi CONSUMIDA', () => {
  assert(aprovDe(PED_APROV).consumida === 1, 'ficou aberta para reuso');
});

t('9g. a aprovacao NAO pode ser reutilizada por outro pedido', () => {
  const p2 = montar(VEND);
  const r = put(VEND, p2, { descontoPercentual: 10, descontoMotivo: 'tentando reaproveitar' });
  assert(r.st === 200, JSON.stringify(r.out.error));
  // Uma solicitação NOVA tem de nascer; a anterior foi consumida e é de outro pedido.
  const a2 = aprovDe(p2);
  assert(a2 && a2.status === 'pendente', 'nao abriu nova solicitacao');
  assert(a2.id !== aprovDe(PED_APROV).id, 'reaproveitou a aprovacao de outro pedido');
  assert(confirmar(VEND, p2).st === 409, 'confirmou reaproveitando aprovacao alheia');
});

t('9h. aprovacao NAO cobre percentual MAIOR do que o aprovado', () => {
  const p = montar(VEND);
  put(VEND, p, { descontoPercentual: 8, descontoMotivo: 'negociacao inicial' });
  const a = aprovDe(p);
  db.prepare("UPDATE aprovacoes SET status='aprovada', aprovador='gerente', valorAprovado=8 WHERE id=?").run(a.id);
  // Sobe o desconto DEPOIS de aprovado.
  db.prepare('UPDATE pedidos SET descontoAplicado = 100 WHERE id = ?').run(p);   // 20% de 500
  assert(confirmar(VEND, p).st === 409, 'aprovacao de 8% liberou 20%');
});

t('9i. aprovacao REPROVADA barra, e diz por que', () => {
  const p = montar(VEND);
  put(VEND, p, { descontoPercentual: 9, descontoMotivo: 'tentativa' });
  const a = aprovDe(p);
  db.prepare("UPDATE aprovacoes SET status='reprovada', aprovador='gerente', motivo='margem insuficiente' WHERE id=?").run(a.id);
  const r = confirmar(VEND, p);
  assert(r.st === 409 && /reprovado/i.test(r.out.error), 'msg=' + r.out.error);
  assert(/margem insuficiente/.test(r.out.error), 'nao diz o motivo: ' + r.out.error);
});

// ==================== 11. SEGURANÇA ====================
console.log('\n--- 11. segurança, no código ativo ---');

t('11a. vendedor restrito NAO define preco manual', () => {
  const p = chamar('/api/pedidos', 'post', { ...VEND, body: { clienteId: cliente.id } }).out.pedido;
  criados.push(p.id);
  chamar('/api/pedidos/:id/itens', 'post', { ...VEND, params: { id: p.id },
    body: { produtoId: produto.id, descricao: produto.descricao, quantidade: 1, precoUnitario: 1 } });
  const it = db.prepare('SELECT * FROM pedido_itens WHERE pedidoId = ?').get(p.id);
  assert(Number(it.precoUnitario) === Number(produto.precoVenda),
    `preco manual passou: ${it.precoUnitario} (oficial ${produto.precoVenda})`);
});

t('11b. vendedorId forjado NAO e aceito', () => {
  const outro = db.prepare('SELECT id FROM users WHERE username = ?').get('gerente');
  const r = chamar('/api/pedidos', 'post', { ...VEND, body: { clienteId: cliente.id, vendedorId: outro.id } });
  criados.push(r.out.pedido.id);
  assert(r.out.pedido.vendedorId === VEND.user.id, 'vendedorId=' + r.out.pedido.vendedorId);
});

t('11c. desconto NEGATIVO rejeitado', () => {
  const p = montar(ADMIN);
  const r = put(ADMIN, p, { descontoPercentual: -10 });
  assert(r.st === 422 && /negativo/i.test(r.out.error), 'status=' + r.st + ' ' + r.out.error);
  assert(Number(ler(p).valorTotal) === 500, 'total mudou: ' + ler(p).valorTotal);
});

t('11d. desconto acima de 100% rejeitado', () => {
  const p = montar(ADMIN);
  assert(put(ADMIN, p, { descontoPercentual: 101 }).st === 422, 'aceitou > 100%');
});

t('11e. frete NEGATIVO rejeitado', () => {
  const p = montar(ADMIN);
  assert(put(ADMIN, p, { valorFrete: -50 }).st === 422, 'aceitou frete negativo');
});

t('11f. valorTotal no corpo e IGNORADO e recalculado', () => {
  const p = montar(ADMIN);
  put(ADMIN, p, { valorTotal: 1 });
  assert(Number(ler(p).valorTotal) === 500, 'o corpo mandou no total: ' + ler(p).valorTotal);
});

t('11g. descontoAplicado no corpo nao entra pela porta dos fundos', () => {
  const p = montar(VEND);
  put(VEND, p, { descontoAplicado: 400, descontoTipo: 'valor' });
  assert(Number(ler(p).descontoAplicado || 0) === 0, 'gravou sem alcada: ' + ler(p).descontoAplicado);
  assert(Number(ler(p).valorTotal) === 500, 'total=' + ler(p).valorTotal);
});

t('11h. tipoAtendimento invalido rejeitado', () => {
  const p = montar(VEND);
  assert(put(VEND, p, { tipoAtendimento: 'drone' }).st === 422, 'aceitou valor invalido');
});

t('11i. origem reservada nao pode ser forjada', () => {
  for (const forjada of ['catalogo', 'licitacao', 'os', 'marketplace']) {
    const r = chamar('/api/pedidos', 'post', { ...VEND, body: { clienteId: cliente.id, origem: forjada } });
    criados.push(r.out.pedido.id);
    assert(r.out.pedido.tipo === 'manual', `aceitou ${forjada}: ${r.out.pedido.tipo}`);
  }
});

// ==================== 12. FATURAMENTO ====================
console.log('\n--- 12. faturamento: herda x substitui ---');

function prepararParaFaturar(a, pct) {
  const id = montar(a);
  put(a, id, { descontoPercentual: pct });
  chamar('/api/pedidos/:id/confirmar', 'post', { ...a, params: { id }, body: {} });
  chamar('/api/pedidos/:id/entregar', 'post', { ...a, params: { id }, body: {} });
  return id;
}

t('12a. faturar SEM informar valorDesconto -> HERDA o desconto do pedido', () => {
  const id = prepararParaFaturar(ADMIN, 10);            // 10% de 500 = 50
  assert(ler(id).status === 'entregue', 'status=' + ler(id).status);
  assert(descontos.descontoDoPedido(db, id) === 50, 'desconto do pedido=' + descontos.descontoDoPedido(db, id));
  const r = chamar('/api/pedidos/:id/faturar', 'post', { ...ADMIN, params: { id }, body: {} });
  assert(r.st === 200, 'faturar falhou: ' + JSON.stringify(r.out.error));
  const f = db.prepare('SELECT * FROM faturas WHERE pedidoId = ? ORDER BY id DESC').get(id);
  assert(f, 'fatura nao criada');
  assert(Number(f.valorDesconto) === 50, 'nao herdou: valorDesconto=' + f.valorDesconto);
  assert(Number(f.valorTotal) === Number(f.valorBruto) + Number(f.valorFrete) - 50,
    `total incoerente: ${f.valorBruto} + ${f.valorFrete} - ${f.valorDesconto} != ${f.valorTotal}`);
});

t('12b. faturar INFORMANDO valorDesconto -> SUBSTITUI, nunca soma', () => {
  const id = prepararParaFaturar(ADMIN, 10);            // pedido tem 50
  const r = chamar('/api/pedidos/:id/faturar', 'post', { ...ADMIN, params: { id }, body: { valorDesconto: 30 } });
  assert(r.st === 200, 'faturar falhou: ' + JSON.stringify(r.out.error));
  const f = db.prepare('SELECT * FROM faturas WHERE pedidoId = ? ORDER BY id DESC').get(id);
  assert(Number(f.valorDesconto) === 30, 'esperado 30 (substitui), veio ' + f.valorDesconto);
  assert(Number(f.valorDesconto) !== 80, 'SOMOU os dois (50+30)');
});

t('12c. valorDesconto: 0 e "faturar sem desconto", nao "herdar"', () => {
  const id = prepararParaFaturar(ADMIN, 10);
  const r = chamar('/api/pedidos/:id/faturar', 'post', { ...ADMIN, params: { id }, body: { valorDesconto: 0 } });
  assert(r.st === 200, JSON.stringify(r.out.error));
  const f = db.prepare('SELECT * FROM faturas WHERE pedidoId = ? ORDER BY id DESC').get(id);
  assert(Number(f.valorDesconto) === 0, 'valorDesconto=' + f.valorDesconto);
});

// ==================== limpeza ====================
const limpar = db.transaction(() => {
  for (const id of criados) {
    const fats = db.prepare('SELECT id FROM faturas WHERE pedidoId = ?').all(id).map((r) => r.id);
    for (const fid of fats) {
      for (const tab of ['contas_a_receber', 'fatura_itens']) {
        try { db.prepare(`DELETE FROM "${tab}" WHERE faturaId = ?`).run(fid); } catch {}
      }
      try { db.prepare('DELETE FROM faturas WHERE id = ?').run(fid); } catch {}
    }
    for (const tab of ['contas_a_receber', 'reservas_estoque', 'pedido_parcelas', 'pedido_historico', 'pedido_itens']) {
      try { db.prepare(`DELETE FROM "${tab}" WHERE pedidoId = ?`).run(id); } catch {}
    }
    try { db.prepare('DELETE FROM movimentacoes_estoque WHERE origem = ? AND origemId = ?').run('pedido', id); } catch {}
    try { db.prepare("DELETE FROM aprovacoes WHERE tipoEvento='desconto_venda' AND referenciaId=?").run(id); } catch {}
    try { db.prepare('DELETE FROM pedidos WHERE id = ?').run(id); } catch {}
  }
});
limpar();

console.log(`\n  limpeza: ${criados.length} pedido(s) de massa removido(s) do sandbox`);
console.log(`\n${ok} ok, ${fail} falha(s)`);
db.close();
process.exit(fail ? 1 : 0);
