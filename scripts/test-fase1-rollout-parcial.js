/**
 * Fase 1 — compatibilidade durante ROLLOUT PARCIAL.
 *
 * Enquanto só o sandbox tiver a migration, o mesmo código roda sobre dois
 * schemas diferentes. Este teste prova que nenhum caminho produz 500 por causa
 * das colunas ausentes: um banco descartável no schema ANTIGO é exercitado
 * ponta a ponta (pedido, item, confirmar, entregar, FATURAR) e comparado com o
 * sandbox migrado.
 *
 * O ponto sensível é `POST /api/pedidos/:id/faturar`, que desde 2026-09-10
 * chama `descontoDoPedido` — a função tolerante que devolve 0 quando a coluna
 * não existe.
 *
 * Schema: sqlite3 data/tenants/1bit/pncp.db .schema > /tmp/app-backend-schema.sql
 */
// Prova que o código novo NÃO quebra em tenant SEM a migration da Fase 1.
// Compara: banco no schema ANTIGO (descartável) × sandbox MIGRADO.
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const express = require('express');
const Database = require('better-sqlite3');
const desconto = require(RAIZ + '/pedido-desconto');

const DB = '/tmp/rollout-antigo.db';
try { fs.unlinkSync(DB); } catch {}

/**
 * O schema ANTIGO é CONSTRUÍDO, não pressuposto.
 *
 * Até 2026-09-11 bastava não rodar a migration: o schema de referência (extraído
 * de um tenant real) ainda não tinha as colunas. Depois do rollout do relatório
 * 18, **todos os 19 tenants as têm** — e o teste passou a montar um banco já
 * migrado, medindo o oposto do que diz medir. Passava por acidente antes, e
 * falhava por acidente depois.
 *
 * Agora as colunas são removidas do texto do CREATE TABLE. O teste volta a valer
 * enquanto existir a possibilidade de um banco sem elas — que é o caso de um
 * tenant provisionado antes de o schema base as criar.
 */
const COLUNAS_FASE1 = ['descontoTipo', 'descontoValor', 'descontoAplicado',
  'descontoMotivo', 'tipoAtendimento', 'semDocumento'];
const schemaAntigo = require('./schema-de-tenant').lerSchema('/tmp/app-backend-schema.sql')
  .replace(new RegExp(`,\\s*"?(${COLUNAS_FASE1.join('|')})"?\\s+[A-Za-z]+[^,)]*`, 'g'), '');

const db = new Database(DB);
db.exec(schemaAntigo.split(/;\s*\n/).filter(s => !/sqlite_sequence/i.test(s)).join(';\n'));
// Schema ANTIGO de propósito: NÃO aplicamos migrate-fase1-pedido.js aqui.

const { registrarRotasPedidos } = require(RAIZ + '/pedidos-routes');
const { registrarRotasProdutos } = require(RAIZ + '/produtos-routes');
const { registrarRotasReservas } = require(RAIZ + '/reservas-routes');
const { registrarRotasFaturas } = require(RAIZ + '/faturas-routes');
const app = express();
registrarRotasPedidos(app, db); registrarRotasProdutos(app, db);
registrarRotasReservas(app, db); registrarRotasFaturas(app, db);
const achar = (p, m) => ((app.router || app._router).stack || [])
  .find(x => x.route && x.route.path === p && x.route.methods[m]).route.stack.at(-1).handle;
function chamar(p, m, o = {}) { let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: {}, body: o.body || {}, session: o.session || {}, user: o.user, ip: '1.1.1.1', headers: {} },
    { json: x => { out = x; return { json: y => { out = y; } }; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st }; }

let ok = 0, fail = 0;
const t = (n, f) => { try { f(); console.log('  OK  ' + n); ok++; } catch (e) { console.log('FALHA ' + n + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

db.prepare("INSERT INTO pessoas (id,cpfCnpj,tipo,razaoSocial,ativo) VALUES (1,'00000000000191','PJ','C',1)").run();
db.prepare("INSERT INTO users (id,username,passwordHash,nome,role,ativo,ehVendedor) VALUES (10,'v','x','V','comercial',1,1)").run();
db.prepare("INSERT INTO perfis_acesso (slug,nome,paginas,ativo) VALUES ('comercial','V',?,1)").run(JSON.stringify(['pedidos','produtos']));
db.prepare("INSERT INTO produtos (id,sku,descricao,unidade,precoVenda,ativo) VALUES (1,'A','P','UN',100,1)").run();
db.prepare("INSERT INTO movimentacoes_estoque (produtoId,tipo,quantidade,origem,data) VALUES (1,'entrada',999,'ajuste',date('now'))").run();
db.prepare(`INSERT INTO tipos_operacao (id,codigo,descricao,categoriaOperacao,emiteNFe,geraFinanceiro,movimentaEstoque,cfopInterno,cfopInterestadual,usarEmPedido,ativo)
  VALUES (1,'VDA-NORMAL','V','venda',1,1,1,'5102','6102',1,1)`).run();
const VEND = { session: { userId: 10 }, user: { id: 10, username: 'v', role: 'comercial', ativo: 1, ehVendedor: 1 } };

console.log('\n=== TENANT SEM A MIGRATION (schema antigo) ===');
t('as colunas da Fase 1 realmente NAO existem', () => {
  const c = db.prepare('PRAGMA table_info(pedidos)').all().map(x => x.name);
  assert(!c.includes('descontoAplicado') && !c.includes('tipoAtendimento'), 'o banco nao esta no schema antigo');
  const p = db.prepare('PRAGMA table_info(pessoas)').all().map(x => x.name);
  assert(!p.includes('semDocumento'), 'pessoas ja migrada');
});
t('temColunaDesconto detecta a ausencia', () => assert(desconto.temColunaDesconto(db) === false, 'detectou coluna inexistente'));
t('descontoDoPedido devolve 0 sem 500', () => assert(desconto.descontoDoPedido(db, 1) === 0, 'nao devolveu 0'));
t('POST /api/pedidos funciona', () => {
  const r = chamar('/api/pedidos', 'post', { ...VEND, body: { clienteId: 1 } });
  assert(r.out && r.out.success, JSON.stringify(r).slice(0, 200));
});
let pedido;
t('adicionar item, confirmar e entregar funcionam', () => {
  pedido = chamar('/api/pedidos', 'post', { ...VEND, body: { clienteId: 1 } }).out.pedido;
  const i = chamar('/api/pedidos/:id/itens', 'post', { ...VEND, params: { id: pedido.id }, body: { produtoId: 1, descricao: 'P', quantidade: 5 } });
  assert(i.out.success, 'item: ' + i.out.error);
  assert(chamar('/api/pedidos/:id/confirmar', 'post', { ...VEND, params: { id: pedido.id }, body: {} }).out.success, 'confirmar');
  assert(chamar('/api/pedidos/:id/entregar', 'post', { ...VEND, params: { id: pedido.id }, body: {} }).out.success, 'entregar');
});
t('FATURAR funciona — e e aqui que descontoDoPedido e chamado', () => {
  const h = achar('/api/pedidos/:id/faturar', 'post');
  let out = null, st = 200;
  h({ params: { id: pedido.id }, query: {}, body: {}, session: VEND.session, user: VEND.user, headers: {}, ip: '1.1.1.1' },
    { json: x => { out = x; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  assert(st === 200 && out.success, `status=${st} ${JSON.stringify(out).slice(0,180)}`);
  const f = db.prepare('SELECT * FROM faturas WHERE pedidoId=? ORDER BY id DESC LIMIT 1').get(pedido.id);
  assert(f.valorBruto === 500 && (f.valorDesconto || 0) === 0 && f.valorTotal === 500,
    `bruto=${f.valorBruto} desc=${f.valorDesconto} total=${f.valorTotal}`);
});
t('faturar com desconto manual continua funcionando no schema antigo', () => {
  const p2 = chamar('/api/pedidos', 'post', { ...VEND, body: { clienteId: 1 } }).out.pedido;
  chamar('/api/pedidos/:id/itens', 'post', { ...VEND, params: { id: p2.id }, body: { produtoId: 1, descricao: 'P', quantidade: 5 } });
  chamar('/api/pedidos/:id/confirmar', 'post', { ...VEND, params: { id: p2.id }, body: {} });
  chamar('/api/pedidos/:id/entregar', 'post', { ...VEND, params: { id: p2.id }, body: {} });
  const h = achar('/api/pedidos/:id/faturar', 'post');
  let out = null, st = 200;
  h({ params: { id: p2.id }, query: {}, body: { valorDesconto: 70 }, session: VEND.session, user: VEND.user, headers: {}, ip: '1.1.1.1' },
    { json: x => { out = x; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  assert(st === 200 && out.success, `status=${st}`);
  const f = db.prepare('SELECT * FROM faturas WHERE pedidoId=? ORDER BY id DESC LIMIT 1').get(p2.id);
  assert(f.valorDesconto === 70 && f.valorTotal === 430, `desc=${f.valorDesconto} total=${f.valorTotal}`);
});
t('a alcada nao quebra sem as tabelas/faixas (fail-closed para restrito)', () => {
  const r = desconto.verificarAlcadaDesconto(db, { pedidoId: 1, percentual: 10, req: VEND });
  assert(r.liberado === false && r.status === 'sem_alcada', JSON.stringify(r));
});

console.log('\n=== SANDBOX (migrado) — o mesmo codigo ===');
const sbx = new Database(RAIZ + '/data/tenants/sandbox/pncp.db', { readonly: true });
t('temColunaDesconto detecta a presenca', () => assert(desconto.temColunaDesconto(sbx) === true, 'nao detectou'));
t('descontoDoPedido le a coluna de verdade', () => {
  const p = sbx.prepare('SELECT id, descontoAplicado FROM pedidos WHERE COALESCE(descontoAplicado,0) > 0 LIMIT 1').get();
  if (!p) { console.log('      (sem pedido com desconto no sandbox — ok)'); return; }
  assert(desconto.descontoDoPedido(sbx, p.id) === p.descontoAplicado, 'leitura divergente');
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
