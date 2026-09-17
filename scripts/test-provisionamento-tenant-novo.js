/**
 * Um tenant recém-provisionado funciona? (relatório 15)
 *
 * Exercita o fluxo comercial inteiro contra um tenant criado pelo mecanismo
 * OFICIAL, **sem nenhum script de "completar schema"**. É o teste que prova que
 * o provisionamento nasce correto — não que dá para consertá-lo depois.
 *
 * Antes das correções de 2026-09-11 este arquivo falhava já no terceiro caso:
 * `POST /api/pedidos` respondia 500 com `table pedidos has no column named
 * vendedorId`.
 *
 *   node scripts/test-provisionamento-tenant-novo.js [slug]      (padrão: sandbox5)
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const SLUG = process.argv[2] || 'sandbox5';
const DB_PATH = path.join(RAIZ, 'data', 'tenants', SLUG, 'pncp.db');

// Trava: só opera em tenant interno de teste.
if (!/^sandbox\d*$/.test(SLUG)) {
  console.error(`RECUSADO: "${SLUG}" não é um tenant interno de teste.`);
  process.exit(2);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`RECUSADO: ${DB_PATH} não existe. Crie com scripts/sandbox-criar.js --slug=${SLUG} --aplicar`);
  process.exit(2);
}

const db = new Database(DB_PATH);
const { registrarRotasPedidos } = require(path.join(RAIZ, 'pedidos-routes'));
const { registrarRotasProdutos } = require(path.join(RAIZ, 'produtos-routes'));
const { registrarRotasReservas } = require(path.join(RAIZ, 'reservas-routes'));
const { registrarRotasFaturas } = require(path.join(RAIZ, 'faturas-routes'));
const { registrarRotasFinanceiro } = require(path.join(RAIZ, 'financeiro-routes'));
const { registrarRotasContasReceber } = require(path.join(RAIZ, 'contas-receber-routes'));
const perfis = require(path.join(RAIZ, 'perfis-acesso'));

const app = express();
registrarRotasPedidos(app, db);
registrarRotasProdutos(app, db);
registrarRotasReservas(app, db);
registrarRotasFaturas(app, db);
registrarRotasFinanceiro(app, db);
registrarRotasContasReceber(app, db);

const achar = (p, m) => {
  const l = ((app.router || app._router).stack || []).find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                session: o.session || {}, user: o.user, ip: '127.0.0.1', headers: {} },
    { json: x => { out = x; return { json: y => { out = y; } }; },
      status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log(`\n=== tenant "${SLUG}" — provisionado pelo mecanismo oficial, sem remendo ===\n`);

const u = (n) => db.prepare('SELECT id, username, role, ativo, ehVendedor FROM users WHERE username = ?').get(n);
const ator = (n) => { const x = u(n); return { session: { userId: x.id, username: x.username }, user: x }; };
let ADM, VEND;
const marca = Date.now().toString().slice(-8);

// ---------- 1. LOGIN / USUÁRIOS ----------
t('1. usuários e perfis nasceram (login tem base)', () => {
  ADM = ator('admin'); VEND = ator('vendedor');
  assert(ADM.user && ADM.user.role === 'admin', 'admin ausente');
  assert(VEND.user && VEND.user.ehVendedor === 1, 'vendedor ausente ou sem ehVendedor');
  assert(db.prepare('SELECT COUNT(*) n FROM perfis_acesso WHERE ativo=1').get().n >= 2, 'perfis ausentes');
  assert(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('sessions','audit_log')").get().n === 2,
    'sessions/audit_log ausentes');
});

t('2. PERMISSÕES: perfil restrito é reconhecido e limitado', () => {
  const acesso = perfis.acessoDoUsuario(db, VEND.user);
  assert(!acesso.irrestrito, 'vendedor ficou irrestrito — perfil não foi cadastrado');
  assert(perfis.podeChamarApi(acesso, '/api/pedidos'), 'vendedor barrado em pedidos');
  assert(!perfis.podeChamarApi(acesso, '/api/estoque/valorizacao'), 'vendedor alcançou estoque');
});

// ---------- 3. CLIENTE ----------
let clienteId;
t('3. criação de CLIENTE pela API', () => {
  const h = achar('/api/pessoas', 'post');
  let out = null, st = 200;
  h({ body: { cpfCnpj: '1122233300018' + (marca[7] || '1'), razaoSocial: 'Cliente Provisionamento ' + marca, telefone: '11999990000' },
      params: {}, query: {}, session: ADM.session, user: ADM.user, headers: {}, ip: '127.0.0.1' },
    { json: x => { out = x; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  assert(st === 200 && out.success, `status=${st} ${JSON.stringify(out)}`);
  clienteId = out.pessoa.id;
});

// ---------- 4. PRODUTO ----------
let produtoId;
t('4. criação de PRODUTO pela API', () => {
  const h = achar('/api/produtos', 'post');
  let out = null, st = 200;
  h({ body: { sku: 'PROV-' + marca, descricao: 'Produto do teste de provisionamento', unidade: 'UN', precoVenda: 100 },
      params: {}, query: {}, session: ADM.session, user: ADM.user, headers: {}, ip: '127.0.0.1' },
    { json: x => { out = x; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  assert(st === 200 && out.success, `status=${st} ${JSON.stringify(out).slice(0, 200)}`);
  produtoId = out.produto.id;
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, origem, observacao, data)
              VALUES (?, 'entrada', 100, 'ajuste', 'teste de provisionamento', date('now'))`).run(produtoId);
});

// ---------- 5. PEDIDO ----------
let pedidoId;
t('5. criação de PEDIDO — era aqui que dava 500 por vendedorId', () => {
  const r = chamar('/api/pedidos', 'post', { ...VEND, body: { clienteId } });
  assert(r.st === 200 && r.out.success, `status=${r.st} ${JSON.stringify(r.out)}`);
  pedidoId = r.out.pedido.id;
});

t('6. vendedorId foi gravado (coluna existe e o hardening funciona)', () => {
  const p = db.prepare('SELECT vendedorId FROM pedidos WHERE id=?').get(pedidoId);
  assert(p.vendedorId === VEND.user.id, 'vendedorId=' + p.vendedorId);
});

t('7. inclusão de ITEM, com preço resolvido pelo servidor', () => {
  const r = chamar('/api/pedidos/:id/itens', 'post',
    { ...VEND, params: { id: pedidoId }, body: { produtoId, descricao: 'Produto', quantidade: 3 } });
  assert(r.st === 200 && r.out.success, `status=${r.st} ${JSON.stringify(r.out)}`);
  assert(r.out.item.precoUnitario === 100, 'preço=' + r.out.item.precoUnitario);
  assert(db.prepare('SELECT valorTotal FROM pedidos WHERE id=?').get(pedidoId).valorTotal === 300, 'total errado');
});

t('8. CONFIRMAÇÃO do pedido', () => {
  const r = chamar('/api/pedidos/:id/confirmar', 'post', { ...VEND, params: { id: pedidoId }, body: {} });
  assert(r.st === 200 && r.out.success, `status=${r.st} ${JSON.stringify(r.out)}`);
});

t('9. RESERVA de estoque criada', () => {
  const res = db.prepare("SELECT * FROM reservas_estoque WHERE pedidoId=? AND status='ativa'").all(pedidoId);
  assert(res.length === 1 && res[0].quantidade === 3, JSON.stringify(res));
});

t('10. API de DISPONIBILIDADE responde', () => {
  const r = chamar('/api/produtos/disponibilidade', 'post', { ...VEND, body: { itens: [{ produtoId, quantidade: 1 }] } });
  assert(r.st === 200 && r.out.success, `status=${r.st} ${JSON.stringify(r.out)}`);
  const i = r.out.itens[0];
  assert(i.disponivel === 97, 'disponível=' + i.disponivel + ' (100 − 3 reservados)');
});

t('11. ENTREGA baixa o estoque', () => {
  const r = chamar('/api/pedidos/:id/entregar', 'post', { ...VEND, params: { id: pedidoId }, body: {} });
  assert(r.st === 200 && r.out.success, `status=${r.st} ${JSON.stringify(r.out)}`);
  const saidas = db.prepare("SELECT COUNT(*) n FROM movimentacoes_estoque WHERE produtoId=? AND tipo='saida'").get(produtoId).n;
  assert(saidas >= 1, 'nenhuma saída gerada');
});

t('12. FATURAMENTO básico', () => {
  const h = achar('/api/pedidos/:id/faturar', 'post');
  let out = null, st = 200;
  h({ params: { id: pedidoId }, query: {}, body: {}, session: ADM.session, user: ADM.user, headers: {}, ip: '127.0.0.1' },
    { json: x => { out = x; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  assert(st === 200 && out.success, `status=${st} ${JSON.stringify(out).slice(0, 220)}`);
  const f = db.prepare('SELECT * FROM faturas WHERE pedidoId=? ORDER BY id DESC LIMIT 1').get(pedidoId);
  assert(f && f.valorBruto === 300 && f.valorTotal === 300, JSON.stringify(f && { b: f.valorBruto, t: f.valorTotal }));
});

t('13. FINANCEIRO: a conta a receber nasceu e é legível', () => {
  const h = achar('/api/contas-a-receber', 'get');
  let out = null, st = 200;
  h({ query: { limit: 5 }, params: {}, body: {}, session: ADM.session, user: ADM.user, headers: {} },
    { json: x => { out = x; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  assert(st === 200 && out.success, `status=${st} ${JSON.stringify(out).slice(0, 180)}`);
  assert(Array.isArray(out.contas), 'sem lista de contas');
});

t('14. LISTAGEM de pedidos com escopo de vendedor', () => {
  const r = chamar('/api/pedidos', 'get', { ...VEND, query: {} });
  assert(r.st === 200 && r.out.success, `status=${r.st}`);
  assert(r.out.escopo === 'proprio', 'escopo=' + r.out.escopo);
  assert(r.out.pedidos.every(p => p.vendedorId === VEND.user.id), 'vazou pedido de outro vendedor');
});

t('15. nenhum 500 por schema: as tabelas centrais respondem a SELECT', () => {
  const centrais = ['pedidos', 'pedido_itens', 'pessoas', 'produtos', 'faturas', 'fatura_itens',
    'contas_a_receber', 'movimentacoes_estoque', 'reservas_estoque', 'comissoes_regras',
    'metas_vendas', 'crm_funis', 'tipos_operacao', 'regras_alcada', 'aprovacoes'];
  for (const tb of centrais) {
    try { db.prepare(`SELECT * FROM ${tb} LIMIT 1`).get(); }
    catch (e) { throw new Error(`${tb}: ${e.message}`); }
  }
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
