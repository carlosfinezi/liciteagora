/**
 * Fase 1 — origem do pedido, desconto com alçada, total e cliente.
 *
 * Roda inteiramente em banco descartável (/tmp). A migration da Fase 1 é
 * aplicada AQUI, no banco de teste, pelo mesmo script que um dia rodará em
 * produção — assim o que se testa é a migration de verdade, não uma cópia dela.
 *
 * Schema base: sqlite3 data/tenants/1bit/pncp.db .schema > /tmp/app-backend-schema.sql
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const express = require('express');
const Database = require('better-sqlite3');

const SCHEMA = '/tmp/app-backend-schema.sql';
if (!fs.existsSync(SCHEMA)) {
  console.error(`schema ausente: ${SCHEMA}\n  sqlite3 data/tenants/1bit/pncp.db .schema > ${SCHEMA}`);
  process.exit(2);
}
const DB = '/tmp/fase1-pedido.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(fs.readFileSync(SCHEMA, 'utf8')
  .split(/;\s*\n/).filter((s) => !/sqlite_sequence/i.test(s)).join(';\n'));
db.close();

// A migration proposta, aplicada no descartável.
execFileSync('node', [`${__dirname}/migrate-fase1-pedido.js`, '--arquivo', DB, '--aplicar'], { stdio: 'pipe' });

const dbt = new Database(DB);
const { registrarRotasPedidos } = require('../pedidos-routes');
const { registrarRotasProdutos } = require('../produtos-routes');
const { registrarRotasReservas } = require('../reservas-routes');
const politicas = require('../pedido-politicas');
const desconto = require('../pedido-desconto');
const alcadas = require('../governanca-alcadas');

const app = express();
registrarRotasPedidos(app, dbt);
registrarRotasProdutos(app, dbt);
registrarRotasReservas(app, dbt);

const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                session: o.session || {}, user: o.user, ip: '203.0.113.9', headers: {} },
    { json: x => { out = x; return { json: y => { out = y; } }; },
      status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- seed ----------
dbt.prepare("INSERT INTO pessoas (id, cpfCnpj, tipo, razaoSocial, telefone, ativo) VALUES (1,'00000000000191','PJ','Cliente Teste','(11) 98888-7777',1)").run();
dbt.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor) VALUES (10,'vend1','x','Vendedor Um','comercial',1,1)`).run();
dbt.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor) VALUES (12,'gerente','x','Gerente','gerente-comercial',1,1)`).run();
dbt.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor) VALUES (1,'admin','x','Admin','admin',1,0)`).run();
dbt.prepare(`INSERT INTO perfis_acesso (slug, nome, paginas, ativo) VALUES ('comercial','Vendedor',?,1)`)
  .run(JSON.stringify(['pedidos', 'pessoas', 'produtos']));
// O perfil do gerente precisa EXISTIR para ele ser um ator restrito: sem
// cadastro, `atorIrrestrito` aplica o fail-open de perfis-acesso.js e o trata
// como privilegiado — o que faria o fail-closed do desconto não valer para ele.
// É o mesmo efeito que um tenant teria se esquecesse de cadastrar o perfil.
dbt.prepare(`INSERT INTO perfis_acesso (slug, nome, paginas, ativo) VALUES ('gerente-comercial','Gerente',?,1)`)
  .run(JSON.stringify(['pedidos', 'pessoas', 'produtos', 'comercial-metas', 'comissoes']));
dbt.prepare(`INSERT INTO produtos (id, sku, descricao, unidade, precoVenda, ativo) VALUES (1,'SKU-A','Produto','UN',100,1)`).run();
dbt.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, origem, data) VALUES (1,'entrada',999,'ajuste',date('now'))`).run();
dbt.prepare(`INSERT INTO tipos_operacao (id, codigo, descricao, categoriaOperacao, emiteNFe, geraFinanceiro, movimentaEstoque, cfopInterno, cfopInterestadual, usarEmPedido, ativo)
  VALUES (1,'VDA-NORMAL','Venda normal','venda',1,1,1,'5102','6102',1,1)`).run();

const VEND = { session: { userId: 10 }, user: { id: 10, username: 'vend1', role: 'comercial', ativo: 1, ehVendedor: 1 } };
const GERENTE = { session: { userId: 12 }, user: { id: 12, username: 'gerente', role: 'gerente-comercial', ativo: 1, ehVendedor: 1 } };
const ADMIN = { session: { userId: 1 }, user: { id: 1, username: 'admin', role: 'admin', ativo: 1, ehVendedor: 0 } };

const novoPedido = (ator, body = {}) => chamar('/api/pedidos', 'post', { ...ator, body });
const comItens = (ator, qtd = 5) => {
  const p = novoPedido(ator, { clienteId: 1 }).out.pedido;
  chamar('/api/pedidos/:id/itens', 'post', { ...ator, params: { id: p.id }, body: { produtoId: 1, descricao: 'Produto', quantidade: qtd } });
  return p;
};
const subtotal = (id) => dbt.prepare('SELECT COALESCE(SUM(valorTotal),0) s FROM pedido_itens WHERE pedidoId=?').get(id).s;

// ==================== A. MIGRATION ====================
t('A1. migration criou as 5 colunas e nao apagou nada', () => {
  const cols = dbt.prepare('PRAGMA table_info(pedidos)').all().map(c => c.name);
  for (const c of ['descontoTipo', 'descontoValor', 'descontoAplicado', 'descontoMotivo', 'tipoAtendimento']) {
    assert(cols.includes(c), 'faltou ' + c);
  }
  for (const c of ['valorFrete', 'valorTotal', 'vendedorId', 'origemLoja', 'politicaPrazoId']) {
    assert(cols.includes(c), 'migration removeu ' + c);
  }
});

t('A2. migration e idempotente (rodar de novo nao quebra)', () => {
  execFileSync('node', [`${__dirname}/migrate-fase1-pedido.js`, '--arquivo', DB, '--aplicar'], { stdio: 'pipe' });
  const n = dbt.prepare('PRAGMA table_info(pedidos)').all().filter(c => c.name === 'descontoAplicado').length;
  assert(n === 1, 'coluna duplicada: ' + n);
});

t('A3. pedido antigo (sem desconto) mantem o total de antes', () => {
  const p = comItens(VEND, 3);
  const antes = dbt.prepare('SELECT valorTotal FROM pedidos WHERE id=?').get(p.id).valorTotal;
  assert(antes === 300, 'total=' + antes);
  const d = dbt.prepare('SELECT descontoAplicado FROM pedidos WHERE id=?').get(p.id).descontoAplicado;
  assert((d || 0) === 0, 'nasceu com desconto: ' + d);
});

// ==================== B. ORIGEM ====================
t('B1. pedido do ERP continua nascendo manual', () => {
  assert(novoPedido(VEND, { clienteId: 1 }).out.pedido.tipo === 'manual', 'tipo errado');
});

t('B2. PDV declara origem e o pedido nasce tipo=pdv', () => {
  assert(novoPedido(VEND, { clienteId: 1, origem: 'pdv' }).out.pedido.tipo === 'pdv', 'tipo errado');
});

t('B3. app continua valendo (nao regrediu)', () => {
  assert(novoPedido(VEND, { clienteId: 1, origem: 'app' }).out.pedido.tipo === 'app', 'tipo errado');
});

t('B4. origem interna NAO pode ser declarada pelo corpo', () => {
  for (const forjada of ['licitacao', 'os', 'marketplace', 'catalogo']) {
    const p = novoPedido(VEND, { clienteId: 1, origem: forjada }).out.pedido;
    assert(p.tipo === 'manual', `aceitou origem forjada ${forjada}: ${p.tipo}`);
  }
});

t('B5. origem desconhecida cai em manual, sem erro', () => {
  assert(novoPedido(VEND, { clienteId: 1, origem: 'xpto' }).out.pedido.tipo === 'manual', 'nao normalizou');
});

t('B6. o vocabulario de exibicao cobre todos os valores gravaveis', () => {
  for (const o of [...politicas.ORIGENS_CLIENTE, 'catalogo', 'os', 'licitacao', 'marketplace']) {
    assert(politicas.ORIGENS_PEDIDO[o], 'sem rotulo para ' + o);
  }
});

// ==================== C. DESCONTO (cálculo puro) ====================
t('C1. percentual valido: 10% de 500 = 50', () => {
  const r = desconto.calcularDesconto({ subtotal: 500, tipo: 'percentual', valor: 10 });
  assert(r.ok && r.aplicado === 50, JSON.stringify(r));
});

t('C2. valor fixo valido: R$ 30 de 500', () => {
  const r = desconto.calcularDesconto({ subtotal: 500, tipo: 'valor', valor: 30 });
  assert(r.ok && r.aplicado === 30 && r.percentual === 6, JSON.stringify(r));
});

t('C3. desconto zero e ausente sao aceitos e valem 0', () => {
  assert(desconto.calcularDesconto({ subtotal: 500, tipo: 'valor', valor: 0 }).aplicado === 0, 'zero');
  assert(desconto.calcularDesconto({ subtotal: 500 }).aplicado === 0, 'ausente');
});

t('C4. desconto MAIOR que o subtotal e recusado', () => {
  const r = desconto.calcularDesconto({ subtotal: 500, tipo: 'valor', valor: 500.01 });
  assert(!r.ok && /maior que o subtotal/i.test(r.erro), JSON.stringify(r));
});

t('C5. desconto NEGATIVO e recusado (valor e percentual)', () => {
  assert(!desconto.calcularDesconto({ subtotal: 500, tipo: 'valor', valor: -1 }).ok, 'valor');
  assert(!desconto.calcularDesconto({ subtotal: 500, tipo: 'percentual', valor: -1 }).ok, 'percentual');
});

t('C6. percentual acima de 100 e recusado', () => {
  assert(!desconto.calcularDesconto({ subtotal: 500, tipo: 'percentual', valor: 100.1 }).ok, 'passou');
  assert(desconto.calcularDesconto({ subtotal: 500, tipo: 'percentual', valor: 100 }).aplicado === 500, '100% deve valer');
});

t('C7. tipo invalido e recusado; NaN e Infinity tambem', () => {
  assert(!desconto.calcularDesconto({ subtotal: 500, tipo: 'metade', valor: 1 }).ok, 'tipo');
  assert(!desconto.calcularDesconto({ subtotal: 500, tipo: 'valor', valor: 'abc' }).ok, 'NaN');
  assert(!desconto.calcularDesconto({ subtotal: 500, tipo: 'valor', valor: Infinity }).ok, 'Infinity');
});

t('C8. pedido sem itens nao aceita desconto em reais', () => {
  assert(!desconto.calcularDesconto({ subtotal: 0, tipo: 'valor', valor: 10 }).ok, 'passou');
});

// ==================== D. TOTAL ====================
t('D1. total = itens - desconto + frete', () => {
  assert(desconto.totalDoPedido({ subtotalItens: 500, desconto: 50, frete: 20 }) === 470, 'caso base');
  assert(desconto.totalDoPedido({ subtotalItens: 500, desconto: 0, frete: 0 }) === 500, 'sem nada');
});

t('D2. frete negativo nao reduz o total (invariavel da Fase 0)', () => {
  assert(desconto.totalDoPedido({ subtotalItens: 500, desconto: 0, frete: -100 }) === 500, 'frete negativo entrou');
});

t('D3. desconto nunca leva o total abaixo de zero', () => {
  assert(desconto.totalDoPedido({ subtotalItens: 100, desconto: 500, frete: 0 }) === 0, 'total negativo');
  assert(desconto.totalDoPedido({ subtotalItens: 100, desconto: 500, frete: 30 }) === 30, 'frete some');
});

t('D4. desconto NAO altera o preco dos itens', () => {
  const p = comItens(VEND, 5);
  const antes = dbt.prepare('SELECT precoUnitario, valorTotal FROM pedido_itens WHERE pedidoId=?').all(p.id);
  dbt.prepare('UPDATE pedidos SET descontoTipo=?, descontoValor=?, descontoAplicado=? WHERE id=?')
    .run('percentual', 10, 50, p.id);
  const depois = dbt.prepare('SELECT precoUnitario, valorTotal FROM pedido_itens WHERE pedidoId=?').all(p.id);
  assert(JSON.stringify(antes) === JSON.stringify(depois), 'o item mudou');
  assert(depois[0].precoUnitario === 100, 'preco=' + depois[0].precoUnitario);
  assert(desconto.totalDoPedido({ subtotalItens: subtotal(p.id), desconto: 50, frete: 0 }) === 450, 'total');
});

// ==================== E0. FAIL-CLOSED (sem alçada configurada) ====================
// Antes de cadastrar qualquer faixa: tabela vazia NÃO é "tudo liberado".
t('E0-a. SEM alcada, desconto ZERO e aceito (nao bloqueia venda)', () => {
  const p = comItens(VEND, 5);
  const r = desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 0, req: VEND });
  assert(r.liberado === true, JSON.stringify(r));
});

t('E0-b. SEM alcada, desconto > 0 do vendedor e REJEITADO (fail-closed)', () => {
  const p = comItens(VEND, 5);
  const r = desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 1, req: VEND });
  assert(r.liberado === false && r.status === 'sem_alcada', JSON.stringify(r));
  assert(/0%/.test(r.motivo || ''), 'motivo=' + r.motivo);
  assert(dbt.prepare("SELECT COUNT(*) n FROM aprovacoes WHERE tipoEvento='desconto_venda'").get().n === 0,
    'fail-closed nao deve criar aprovacao pendente');
});

t('E0-c. SEM alcada, ADMIN (privilegiado) passa', () => {
  const p = comItens(ADMIN, 5);
  const r = desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 40, req: ADMIN });
  assert(r.liberado === true && r.autoridade === 'privilegiado', JSON.stringify(r));
});

t('E0-d. SEM alcada, GERENTE (nao privilegiado) tambem e barrado', () => {
  const p = comItens(GERENTE, 5);
  const r = desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 5, req: GERENTE });
  assert(r.liberado === false && r.status === 'sem_alcada', JSON.stringify(r));
});

// ==================== E. ALÇADA ====================
// Faixas em PERCENTUAL: acima de 10% exige gerente; acima de 25%, admin.
t('E1. faixas de desconto sao cadastraveis no motor existente', () => {
  dbt.prepare(`INSERT INTO regras_alcada (tipoEvento, limiteValor, papelAprovador, validadeDias, descricao, ativo)
    VALUES ('desconto_venda', 10, 'gerente-comercial', 7, 'Acima de 10% exige gerente', 1)`).run();
  dbt.prepare(`INSERT INTO regras_alcada (tipoEvento, limiteValor, papelAprovador, validadeDias, descricao, ativo)
    VALUES ('desconto_venda', 25, 'admin', 7, 'Acima de 25% exige admin', 1)`).run();
  const f = alcadas.faixas(dbt, 'desconto_venda');
  assert(f.length === 2 && f[0].limiteValor === 10, JSON.stringify(f.map(x => x.limiteValor)));
});

t('E2. vendedor DENTRO da alcada base (abaixo da menor faixa) passa direto', () => {
  const p = comItens(VEND, 5);
  const r = desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 8, req: VEND });
  assert(r.liberado === true && r.autoridade === 'alcada_base', JSON.stringify(r));
  assert(dbt.prepare("SELECT COUNT(*) n FROM aprovacoes WHERE tipoEvento='desconto_venda' AND referenciaId=?").get(p.id).n === 0,
    'criou aprovacao desnecessaria');
});

t('E3. vendedor ACIMA da alcada nao passa e abre aprovacao pendente', () => {
  const p = comItens(VEND, 5);
  const r = desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 15, req: VEND });
  assert(r.liberado === false && r.status === 'pendente', JSON.stringify(r));
  const ap = dbt.prepare("SELECT * FROM aprovacoes WHERE tipoEvento='desconto_venda' AND referenciaId=?").get(p.id);
  assert(ap && ap.papelExigido === 'gerente-comercial', 'papel=' + (ap && ap.papelExigido));
  assert(Number(ap.valorReferencia) === 15, 'valorReferencia=' + ap.valorReferencia);
  assert(ap.solicitante === 'vend1', 'solicitante=' + ap.solicitante);
});

t('E3-b. GERENTE dentro da PROPRIA autoridade aplica direto, sem aprovacao', () => {
  // 20% ultrapassa a faixa de 10%, cuja autoridade é 'gerente-comercial' — que
  // é o papel dele. Pedir que outro gerente aprove seria burocracia inútil.
  const p = comItens(GERENTE, 5);
  const r = desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 20, req: GERENTE });
  assert(r.liberado === true && r.autoridade === 'propria', JSON.stringify(r));
  assert(dbt.prepare("SELECT COUNT(*) n FROM aprovacoes WHERE tipoEvento='desconto_venda' AND referenciaId=?").get(p.id).n === 0,
    'gerente nao deveria precisar de aprovacao dentro da propria alcada');
});

t('E3-c. GERENTE ACIMA da propria autoridade exige nivel superior (admin)', () => {
  const p = comItens(GERENTE, 5);
  const r = desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 30, req: GERENTE });
  assert(r.liberado === false && r.status === 'pendente', JSON.stringify(r));
  const ap = dbt.prepare("SELECT * FROM aprovacoes WHERE tipoEvento='desconto_venda' AND referenciaId=?").get(p.id);
  assert(ap.papelExigido === 'admin', 'papel=' + ap.papelExigido);
});

t('E3-d. ADMIN aplica qualquer desconto direto (regra privilegiada)', () => {
  const p = comItens(ADMIN, 5);
  const r = desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 90, req: ADMIN });
  assert(r.liberado === true && r.autoridade === 'propria', JSON.stringify(r));
});

t('E4. a faixa aplicada e a de MAIOR limite ultrapassado', () => {
  const p = comItens(VEND, 5);
  desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 30, req: VEND });
  const ap = dbt.prepare("SELECT * FROM aprovacoes WHERE tipoEvento='desconto_venda' AND referenciaId=?").get(p.id);
  assert(ap.papelExigido === 'admin', 'papel=' + ap.papelExigido + ' (30% deve cair na faixa de 25%)');
});

t('E5. depois de aprovada, o desconto passa — e a aprovacao e consumida', () => {
  const p = comItens(VEND, 5);
  desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 15, req: VEND });
  const ap = dbt.prepare("SELECT id FROM aprovacoes WHERE tipoEvento='desconto_venda' AND referenciaId=?").get(p.id);
  dbt.prepare("UPDATE aprovacoes SET status='aprovada', aprovador='gerente', valorAprovado=15 WHERE id=?").run(ap.id);
  const r = desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 15, req: VEND });
  assert(r.liberado === true, JSON.stringify(r));
  assert(dbt.prepare('SELECT consumida FROM aprovacoes WHERE id=?').get(ap.id).consumida === 1, 'nao consumiu');
});

t('E6. aprovacao NAO cobre um desconto maior depois (valor travado)', () => {
  const p = comItens(VEND, 5);
  desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 15, req: VEND });
  const ap = dbt.prepare("SELECT id FROM aprovacoes WHERE tipoEvento='desconto_venda' AND referenciaId=?").get(p.id);
  dbt.prepare("UPDATE aprovacoes SET status='aprovada', valorAprovado=15 WHERE id=?").run(ap.id);
  const r = desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 40, req: VEND });
  assert(r.liberado === false && r.status === 'valor_excedido', JSON.stringify(r));
});

t('E7. desconto zero nao aciona alcada (nem com faixas cadastradas)', () => {
  const p = comItens(VEND, 5);
  assert(desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 0, req: VEND }).liberado === true, 'barrou');
});

t('E8. X-Api-Key (sem req.user) e tratada como sistema, nao barrada', () => {
  const p = comItens(ADMIN, 5);
  const r = desconto.verificarAlcadaDesconto(dbt, { pedidoId: p.id, percentual: 50, req: null });
  assert(r.liberado === true, JSON.stringify(r));
});

// ==================== F. CLIENTE ====================
t('F1. busca de cliente por TELEFONE (com e sem mascara)', () => {
  const { registrarRotasFinanceiro } = require('../financeiro-routes');
  const appF = express(); registrarRotasFinanceiro(appF, dbt);
  const h = ((appF.router || appF._router).stack || [])
    .find(x => x.route && x.route.path === '/api/pessoas' && x.route.methods.get).route.stack.at(-1).handle;
  const busca = (q) => { let out = null; h({ query: { q }, params: {}, body: {}, session: {}, user: ADMIN.user, headers: {} },
    { json: x => { out = x; }, status: () => ({ json: x => { out = x; } }) }); return out; };
  assert(busca('98888').pessoas.length === 1, 'nao achou por trecho do telefone');
  assert(busca('11988887777').pessoas.length === 1, 'nao achou por digitos sem mascara');
  assert(busca('Cliente Teste').pessoas.length === 1, 'quebrou a busca por nome');
  assert(busca('00000000000191').pessoas.length === 1, 'quebrou a busca por documento');
  assert(busca('zzz-inexistente').pessoas.length === 0, 'trouxe quem nao devia');
});

t('F2. cadastro rapido: CPF/CNPJ + nome bastam', () => {
  const { registrarRotasFinanceiro } = require('../financeiro-routes');
  const appF = express(); registrarRotasFinanceiro(appF, dbt);
  const h = ((appF.router || appF._router).stack || [])
    .find(x => x.route && x.route.path === '/api/pessoas' && x.route.methods.post).route.stack.at(-1).handle;
  let out = null, st = 200;
  h({ body: { cpfCnpj: '11144477735', razaoSocial: 'Maria do Balcao', telefone: '11977776666' },
      params: {}, query: {}, session: {}, user: ADMIN.user, headers: {}, ip: '1.1.1.1' },
    { json: x => { out = x; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  assert(st === 200 && out.success, `status=${st} ${JSON.stringify(out)}`);
  const p = dbt.prepare("SELECT * FROM pessoas WHERE cpfCnpj='11144477735'").get();
  assert(p && p.ativo === 1, 'nao gravou');
  assert(p.tipo === 'PF', 'tipo detectado errado: ' + p.tipo);
});

t('F3. cliente continua obrigatorio para confirmar', () => {
  const p = novoPedido(VEND, {}).out.pedido;          // sem clienteId
  chamar('/api/pedidos/:id/itens', 'post', { ...VEND, params: { id: p.id }, body: { produtoId: 1, descricao: 'P', quantidade: 1 } });
  const r = chamar('/api/pedidos/:id/confirmar', 'post', { ...VEND, params: { id: p.id }, body: {} });
  assert(r.st === 400 && /cliente/i.test(r.out.error || ''), JSON.stringify(r));
});

// ==================== G. TIPO DE ATENDIMENTO ====================
t('G1. a coluna aceita os tres modos e NULL (pedido legado)', () => {
  const p = comItens(VEND, 1);
  for (const modo of ['local', 'retirada', 'entrega']) {
    dbt.prepare('UPDATE pedidos SET tipoAtendimento=? WHERE id=?').run(modo, p.id);
    assert(dbt.prepare('SELECT tipoAtendimento FROM pedidos WHERE id=?').get(p.id).tipoAtendimento === modo, modo);
  }
  dbt.prepare('UPDATE pedidos SET tipoAtendimento=NULL WHERE id=?').run(p.id);
  assert(dbt.prepare('SELECT tipoAtendimento FROM pedidos WHERE id=?').get(p.id).tipoAtendimento === null, 'NULL');
});

t('G2. ENTREGA: os campos de endereco que o pedido ja tem bastam', () => {
  const p = comItens(VEND, 1);
  chamar('/api/pedidos/:id', 'put', { ...VEND, params: { id: p.id }, body: {
    enderecoEntrega: 'Rua das Flores', numeroEntrega: '100', bairroEntrega: 'Centro',
    cidadeEntrega: 'São Paulo', ufEntrega: 'SP', cepEntrega: '01000000', valorFrete: 15 } });
  const g = dbt.prepare('SELECT * FROM pedidos WHERE id=?').get(p.id);
  assert(g.enderecoEntrega === 'Rua das Flores' && g.ufEntrega === 'SP', 'endereco nao gravou');
  assert(g.valorFrete === 15 && g.valorTotal === 115, 'total=' + g.valorTotal);
});

t('G3. RETIRADA: sem endereco, frete zero, total = itens', () => {
  const p = comItens(VEND, 2);
  dbt.prepare("UPDATE pedidos SET tipoAtendimento='retirada' WHERE id=?").run(p.id);
  const g = dbt.prepare('SELECT * FROM pedidos WHERE id=?').get(p.id);
  assert(!g.enderecoEntrega, 'exigiu endereco');
  assert((g.valorFrete || 0) === 0 && g.valorTotal === 200, 'total=' + g.valorTotal);
});

// ==================== H. REGRESSÃO ====================
t('H1. estoque: confirmar reserva, entregar baixa (regra da Fase 0 intacta)', () => {
  const p = comItens(VEND, 2);
  const c = chamar('/api/pedidos/:id/confirmar', 'post', { ...VEND, params: { id: p.id }, body: {} });
  assert(c.out.success, 'confirmar: ' + c.out.error);
  assert(dbt.prepare("SELECT COUNT(*) n FROM reservas_estoque WHERE pedidoId=? AND status='ativa'").get(p.id).n === 1, 'sem reserva');
  const e = chamar('/api/pedidos/:id/entregar', 'post', { ...VEND, params: { id: p.id }, body: {} });
  assert(e.out.success, 'entregar: ' + e.out.error);
  assert(dbt.prepare("SELECT COUNT(*) n FROM movimentacoes_estoque WHERE origem IN ('pedido','reserva') AND quantidade <= 0").get().n === 0,
    'movimentacao nao positiva');
});

t('H2. hardening da Fase 0 intacto: frete e quantidade negativos', () => {
  const p = comItens(VEND, 1);
  assert(chamar('/api/pedidos/:id', 'put', { ...VEND, params: { id: p.id }, body: { valorFrete: -10 } }).st === 422, 'frete');
  assert(chamar('/api/pedidos/:id/itens', 'post',
    { ...VEND, params: { id: p.id }, body: { produtoId: 1, descricao: 'P', quantidade: -1 } }).st === 422, 'quantidade');
});

t('H3. preco do vendedor restrito continua resolvido pelo servidor', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = chamar('/api/pedidos/:id/itens', 'post',
    { ...VEND, params: { id: p.id }, body: { produtoId: 1, descricao: 'P', quantidade: 1, precoUnitario: 5 } });
  assert(r.out.item.precoUnitario === 100, 'preco=' + r.out.item.precoUnitario);
});

t('H4. registrar-pagamento continua 410', () => {
  const p = comItens(VEND, 1);
  assert(chamar('/api/pedidos/:id/registrar-pagamento', 'post',
    { ...VEND, params: { id: p.id }, body: { valor: 50 } }).st === 410, 'nao e 410');
});

// ==================== I. PEDIDO → FATURA ====================
const { registrarRotasFaturas } = require('../faturas-routes');
const appFat = express(); registrarRotasFaturas(appFat, dbt);
const faturar = (ator, pedidoId, body = {}) => {
  const h = ((appFat.router || appFat._router).stack || [])
    .find(x => x.route && x.route.path === '/api/pedidos/:id/faturar' && x.route.methods.post).route.stack.at(-1).handle;
  let out = null, st = 200;
  h({ params: { id: pedidoId }, query: {}, body, session: ator.session, user: ator.user, headers: {}, ip: '1.1.1.1' },
    { json: x => { out = x; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
};
const prontoParaFaturar = (qtd, descontoAplicado) => {
  const p = comItens(ADMIN, qtd);
  if (descontoAplicado != null) {
    dbt.prepare('UPDATE pedidos SET descontoTipo=?, descontoValor=?, descontoAplicado=? WHERE id=?')
      .run('valor', descontoAplicado, descontoAplicado, p.id);
  }
  // Faturar exige status 'entregue' (o estoque baixa antes da nota) — regra
  // anterior a esta fase, preservada.
  chamar('/api/pedidos/:id/confirmar', 'post', { ...ADMIN, params: { id: p.id }, body: {} });
  chamar('/api/pedidos/:id/entregar', 'post', { ...ADMIN, params: { id: p.id }, body: {} });
  return p;
};

t('I1. fatura HERDA o desconto do pedido quando o corpo nao informa', () => {
  const p = prontoParaFaturar(5, 50);                       // 500 de itens, 50 de desconto
  const r = faturar(ADMIN, p.id, {});
  assert(r.out && r.out.success, JSON.stringify(r));
  const f = dbt.prepare('SELECT * FROM faturas WHERE pedidoId=? ORDER BY id DESC LIMIT 1').get(p.id);
  assert(f.valorDesconto === 50, 'desconto=' + f.valorDesconto);
  assert(f.valorBruto === 500 && f.valorTotal === 450, `bruto=${f.valorBruto} total=${f.valorTotal}`);
});

t('I2. pedido SEM desconto continua faturando igual (compat)', () => {
  const p = prontoParaFaturar(5, null);
  const r = faturar(ADMIN, p.id, {});
  assert(r.out.success, JSON.stringify(r));
  const f = dbt.prepare('SELECT * FROM faturas WHERE pedidoId=? ORDER BY id DESC LIMIT 1').get(p.id);
  assert((f.valorDesconto || 0) === 0 && f.valorTotal === 500, `desc=${f.valorDesconto} total=${f.valorTotal}`);
});

t('I3. desconto informado no corpo SUBSTITUI o do pedido — nunca soma', () => {
  const p = prontoParaFaturar(5, 50);                       // pedido tem 50
  const r = faturar(ADMIN, p.id, { valorDesconto: 80 });    // corpo manda 80
  assert(r.out.success, JSON.stringify(r));
  const f = dbt.prepare('SELECT * FROM faturas WHERE pedidoId=? ORDER BY id DESC LIMIT 1').get(p.id);
  assert(f.valorDesconto === 80, 'desconto=' + f.valorDesconto + ' (80 substitui, nao 130)');
  assert(f.valorTotal === 420, 'total=' + f.valorTotal);
});

t('I4. corpo com desconto ZERO fatura SEM desconto (presenca, nao valor)', () => {
  const p = prontoParaFaturar(5, 50);
  const r = faturar(ADMIN, p.id, { valorDesconto: 0 });
  assert(r.out.success, JSON.stringify(r));
  const f = dbt.prepare('SELECT * FROM faturas WHERE pedidoId=? ORDER BY id DESC LIMIT 1').get(p.id);
  assert(f.valorDesconto === 0 && f.valorTotal === 500, `desc=${f.valorDesconto} total=${f.valorTotal}`);
});

t('I5. desconto negativo ou maior que a fatura e recusado', () => {
  const p1 = prontoParaFaturar(5, null);
  assert(faturar(ADMIN, p1.id, { valorDesconto: -10 }).st === 400, 'negativo passou');
  const p2 = prontoParaFaturar(5, null);
  assert(faturar(ADMIN, p2.id, { valorDesconto: 600 }).st === 400, 'maior que a fatura passou');
});

// ==================== J. TIPO DE ATENDIMENTO ====================
t('J1. os tres valores aprovados sao no_local | retirada | entrega', () => {
  const p = comItens(VEND, 1);
  for (const modo of ['no_local', 'retirada', 'entrega']) {
    dbt.prepare('UPDATE pedidos SET tipoAtendimento=? WHERE id=?').run(modo, p.id);
    assert(dbt.prepare('SELECT tipoAtendimento FROM pedidos WHERE id=?').get(p.id).tipoAtendimento === modo, modo);
  }
});

t('J2. ERP manual continua valido com tipoAtendimento NULL', () => {
  const p = comItens(VEND, 1);
  const g = dbt.prepare('SELECT tipo, tipoAtendimento FROM pedidos WHERE id=?').get(p.id);
  assert(g.tipo === 'manual' && g.tipoAtendimento === null, JSON.stringify(g));
  const c = chamar('/api/pedidos/:id/confirmar', 'post', { ...VEND, params: { id: p.id }, body: {} });
  assert(c.out.success, 'pedido legado deixou de confirmar: ' + c.out.error);
});

t('J3. PDV e catalogo nascem SEM tipoAtendimento — a regra ainda nao e aplicada', () => {
  // Documenta o estado atual: a coluna existe e aceita os valores, mas a
  // obrigatoriedade para pdv/catalogo depende de ligar pedido-desconto.js e a
  // validação de atendimento, o que só acontece depois da migration aprovada.
  const p = novoPedido(VEND, { clienteId: 1, origem: 'pdv' }).out.pedido;
  const g = dbt.prepare('SELECT tipo, tipoAtendimento FROM pedidos WHERE id=?').get(p.id);
  assert(g.tipo === 'pdv' && g.tipoAtendimento === null, JSON.stringify(g));
});

t('J4. no_local e retirada nao exigem endereco; entrega grava o endereco', () => {
  const semEnd = comItens(VEND, 1);
  for (const modo of ['no_local', 'retirada']) {
    dbt.prepare('UPDATE pedidos SET tipoAtendimento=? WHERE id=?').run(modo, semEnd.id);
    const g = dbt.prepare('SELECT * FROM pedidos WHERE id=?').get(semEnd.id);
    assert(!g.enderecoEntrega, modo + ' exigiu endereco');
    assert((g.valorFrete || 0) === 0, modo + ' com frete');
  }
  const comEnd = comItens(VEND, 1);
  chamar('/api/pedidos/:id', 'put', { ...VEND, params: { id: comEnd.id },
    body: { enderecoEntrega: 'Rua A', cidadeEntrega: 'SP', ufEntrega: 'SP', valorFrete: 20 } });
  dbt.prepare("UPDATE pedidos SET tipoAtendimento='entrega' WHERE id=?").run(comEnd.id);
  const g = dbt.prepare('SELECT * FROM pedidos WHERE id=?').get(comEnd.id);
  assert(g.enderecoEntrega === 'Rua A' && g.valorFrete === 20 && g.valorTotal === 120, JSON.stringify(g));
});

// ==================== K. CLIENTE: documento e telefone ====================
t('K1. busca por DOCUMENTO continua sendo a chave forte', () => {
  const { registrarRotasFinanceiro } = require('../financeiro-routes');
  const appF = express(); registrarRotasFinanceiro(appF, dbt);
  const h = ((appF.router || appF._router).stack || [])
    .find(x => x.route && x.route.path === '/api/pessoas' && x.route.methods.get).route.stack.at(-1).handle;
  const busca = (q) => { let out = null; h({ query: { q }, params: {}, body: {}, session: {}, user: ADMIN.user, headers: {} },
    { json: x => { out = x; }, status: () => ({ json: x => { out = x; } }) }); return out; };
  assert(busca('00000000000191').pessoas.length === 1, 'documento nao achou');
  assert(busca('0000000000019').pessoas.length === 1, 'documento parcial nao achou');
});

t('K2. telefone igual em DUAS pessoas: a busca sugere as duas, nao funde', () => {
  dbt.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, telefone, ativo)
    VALUES ('52998224725','PF','Joao da Casa','(11) 98888-7777',1)`).run();
  const { registrarRotasFinanceiro } = require('../financeiro-routes');
  const appF = express(); registrarRotasFinanceiro(appF, dbt);
  const h = ((appF.router || appF._router).stack || [])
    .find(x => x.route && x.route.path === '/api/pessoas' && x.route.methods.get).route.stack.at(-1).handle;
  let out = null;
  h({ query: { q: '11988887777' }, params: {}, body: {}, session: {}, user: ADMIN.user, headers: {} },
    { json: x => { out = x; }, status: () => ({ json: x => { out = x; } }) });
  assert(out.pessoas.length === 2, 'esperava as DUAS pessoas, veio ' + out.pessoas.length);
  const docs = out.pessoas.map(p => p.cpfCnpj).sort();
  assert(docs[0] !== docs[1], 'as duas pessoas continuam distintas');
  // Nenhuma foi inativada, mesclada ou reescrita pela busca.
  assert(dbt.prepare("SELECT COUNT(*) n FROM pessoas WHERE telefone='(11) 98888-7777' AND ativo=1").get().n === 2,
    'a busca alterou cadastro');
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
