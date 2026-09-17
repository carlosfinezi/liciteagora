/**
 * Backend preparado para o app móvel de vendas.
 *
 * Cobre os testes A–L de docs/auditoria-app-mobile-2026-08-26/04-backend-preparado-para-app.md:
 * preço não adulterável, vendedorId não falsificável, "meus pedidos" com escopo
 * e paginação, disponibilidade mínima sob /api/produtos, e o pedido resultante
 * continuar sendo um pedido comum do ERP.
 *
 * O bloco P cobre a §4.1 do mesmo documento (2026-09-10): vendedor restrito não
 * define preço manual — o corpo é ignorado, item sem produto é recusado, e nem
 * 'auditar' nem 'estrito' devolvem essa autoridade a ele.
 *
 * Schema: gere antes o dump de um tenant real —
 *   sqlite3 data/tenants/1bit/pncp.db .schema > /tmp/app-backend-schema.sql
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

const SCHEMA = '/tmp/app-backend-schema.sql';
if (!fs.existsSync(SCHEMA)) {
  console.error(`schema ausente: ${SCHEMA}\n  sqlite3 data/tenants/1bit/pncp.db .schema > ${SCHEMA}`);
  process.exit(2);
}
const DB = '/tmp/app-backend-teste.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
// `.schema` traz sqlite_sequence, que o SQLite recusa recriar ("object name
// reserved for internal use"). Ela nasce sozinha com o primeiro AUTOINCREMENT.
db.exec(fs.readFileSync(SCHEMA, 'utf8')
  .split(/;\s*\n/)
  .filter((s) => !/sqlite_sequence/i.test(s))
  .join(';\n'));

const { registrarRotasPedidos } = require('../pedidos-routes');
const { registrarRotasProdutos } = require('../produtos-routes');
const { registrarRotasReservas } = require('../reservas-routes');
const politicas = require('../pedido-politicas');

const app = express();
registrarRotasPedidos(app, db);
registrarRotasProdutos(app, db);
registrarRotasReservas(app, db);

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
db.prepare("INSERT INTO pessoas (id, cpfCnpj, tipo, razaoSocial, ativo) VALUES (1,'00000000000191','PJ','Cliente Teste',1)").run();
db.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor)
  VALUES (10,'vend1','x','Vendedor Um','comercial',1,1)`).run();
db.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor)
  VALUES (11,'vend2','x','Vendedor Dois','comercial',1,1)`).run();
db.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor)
  VALUES (1,'admin','x','Admin','admin',1,0)`).run();
// Vendedor que TAMBÉM administra metas/comissões: não é restrito (delega
// vendedor, informa preço), mas também não é irrestrito (não fura piso). É a
// faixa do meio, e é ela que mantém o 422 do modo estrito vivo depois que o
// vendedor restrito deixou de escolher preço.
db.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor)
  VALUES (12,'gerente','x','Gerente Comercial','gerente-comercial',1,1)`).run();
// Perfil restrito real: as páginas que um vendedor precisa, sem metas/comissões.
db.prepare(`INSERT INTO perfis_acesso (slug, nome, paginas, ativo)
  VALUES ('comercial','Vendedor',?,1)`)
  .run(JSON.stringify(['pedidos', 'pessoas', 'produtos', 'meu-perfil']));
db.prepare(`INSERT INTO perfis_acesso (slug, nome, paginas, ativo)
  VALUES ('gerente-comercial','Gerente Comercial',?,1)`)
  .run(JSON.stringify(['pedidos', 'pessoas', 'produtos', 'meu-perfil', 'comercial-metas', 'comissoes']));

db.prepare(`INSERT INTO produtos (id, sku, descricao, unidade, precoVenda, precoMinimoVenda, ativo)
  VALUES (1,'SKU-A','Tempero verde','UN',100,80,1)`).run();
db.prepare(`INSERT INTO produtos (id, sku, descricao, unidade, precoVenda, ativo)
  VALUES (2,'SKU-B','Produto sem piso','UN',50,1)`).run();
// Unidade fracionável e unidade ambígua: a regra de decimal depende disso, e
// as duas existem no cadastro real (KG em 3 produtos, 'MES'/'6' como resto de
// importação). Ver 08-fase-0-limites-quantidade-pagamento.md.
db.prepare(`INSERT INTO produtos (id, sku, descricao, unidade, precoVenda, ativo)
  VALUES (3,'SKU-KG','Tempero a granel','KG',20,1)`).run();
db.prepare(`INSERT INTO produtos (id, sku, descricao, unidade, precoVenda, ativo)
  VALUES (4,'SKU-AMB','Produto com unidade ambigua','6',10,1)`).run();
db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, origem, data)
  VALUES (1,'entrada',10,'ajuste',date('now'))`).run();
// Sem tipo de operação o motor de CFOP não tem de onde partir — é o mesmo seed
// que db-schema.js aplica no provisionamento de cada tenant.
db.prepare(`INSERT INTO tipos_operacao (id, codigo, descricao, categoriaOperacao, emiteNFe,
  geraFinanceiro, movimentaEstoque, cfopInterno, cfopInterestadual, usarEmPedido, ativo)
  VALUES (1,'VDA-NORMAL','Venda normal','venda',1,1,1,'5102','6102',1,1)`).run();

const VEND = { session: { userId: 10, username: 'vend1' }, user: { id: 10, username: 'vend1', role: 'comercial', ativo: 1, ehVendedor: 1 } };
const VEND2 = { session: { userId: 11, username: 'vend2' }, user: { id: 11, username: 'vend2', role: 'comercial', ativo: 1, ehVendedor: 1 } };
const ADMIN = { session: { userId: 1, username: 'admin' }, user: { id: 1, username: 'admin', role: 'admin', ativo: 1, ehVendedor: 0 } };
const GERENTE = { session: { userId: 12, username: 'gerente' }, user: { id: 12, username: 'gerente', role: 'gerente-comercial', ativo: 1, ehVendedor: 1 } };
const SISTEMA = { session: {}, user: undefined };   // X-Api-Key

const novoPedido = (ator, body = {}) => chamar('/api/pedidos', 'post', { ...ator, body });

// ---------- A. vendedor comum cria pedido para si ----------
t('A. vendedor cria pedido e ele nasce em seu nome', () => {
  const r = novoPedido(VEND, { clienteId: 1 });
  assert(r.out.success, 'criacao falhou');
  assert(r.out.pedido.vendedorId === 10, 'vendedorId=' + r.out.pedido.vendedorId);
  assert(r.out.pedido.tipo === 'manual', 'tipo=' + r.out.pedido.tipo);
});

t('A2. app declara origem e o pedido nasce tipo=app', () => {
  const r = novoPedido(VEND, { clienteId: 1, origem: 'app' });
  assert(r.out.pedido.tipo === 'app', 'tipo=' + r.out.pedido.tipo);
});

t('A3. origem forjada é recusada e cai em manual', () => {
  const r = novoPedido(VEND, { clienteId: 1, origem: 'licitacao' });
  assert(r.out.pedido.tipo === 'manual', 'aceitou origem forjada: ' + r.out.pedido.tipo);
});

// ---------- B. vendedorId de outro usuário ----------
t('B. vendedor nao assume pedido de outro vendedor no POST', () => {
  const r = novoPedido(VEND, { clienteId: 1, vendedorId: 11 });
  assert(r.out.pedido.vendedorId === 10, 'assumiu outro: ' + r.out.pedido.vendedorId);
});

t('B2. vendedor nao reatribui via PUT', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = chamar('/api/pedidos/:id', 'put', { ...VEND, params: { id: p.id }, body: { vendedorId: 11 } });
  assert(r.out.pedido.vendedorId === 10, 'PUT reatribuiu: ' + r.out.pedido.vendedorId);
});

t('B3. vendedor nao reatribui via acao-massa (403)', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = chamar('/api/pedidos/acao-massa', 'post', { ...VEND, body: { ids: [p.id], acao: 'vendedor', vendedorId: 11 } });
  assert(r.st === 403, 'status=' + r.st);
  assert(db.prepare('SELECT vendedorId FROM pedidos WHERE id=?').get(p.id).vendedorId === 10, 'mudou o vendedor');
});

t('B4. admin PODE delegar (nao quebrar a tela web)', () => {
  const p = novoPedido(ADMIN, { clienteId: 1, vendedorId: 11 }).out.pedido;
  assert(p.vendedorId === 11, 'admin nao delegou: ' + p.vendedorId);
  const r = chamar('/api/pedidos/acao-massa', 'post', { ...ADMIN, body: { ids: [p.id], acao: 'vendedor', vendedorId: 10 } });
  assert(r.out.success, 'acao-massa do admin falhou');
});

t('B5. X-Api-Key (sem sessao) mantem comportamento antigo', () => {
  const p = novoPedido(SISTEMA, { clienteId: 1, vendedorId: 11 }).out.pedido;
  assert(p.vendedorId === 11, 'integracao quebrou: ' + p.vendedorId);
});

// ---------- C/D. preço ----------
// Estes dois usam o GERENTE, não o vendedor restrito: desde a regra de
// 2026-09-10 o preço que o restrito manda é ignorado, então ele não tem mais
// como produzir um desconto para auditar nem para o modo estrito recusar.
t('C. preco adulterado abaixo do piso fica registrado (politica padrao)', () => {
  const p = novoPedido(GERENTE, { clienteId: 1 }).out.pedido;
  const r = chamar('/api/pedidos/:id/itens', 'post',
    { ...GERENTE, params: { id: p.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: 1 } });
  assert(r.out.success, 'recusou no modo auditar');
  const log = db.prepare("SELECT * FROM audit_log WHERE action='preco-abaixo-do-sugerido' ORDER BY id DESC LIMIT 1").get();
  assert(log, 'nao registrou o desconto no audit_log');
  assert(JSON.parse(log.payload).sugerido === 100, 'sugerido errado');
});

t('C2. politica estrita RECUSA abaixo do piso para quem informa preco', () => {
  db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('preco_politica','estrito')").run();
  const p = novoPedido(GERENTE, { clienteId: 1 }).out.pedido;
  const r = chamar('/api/pedidos/:id/itens', 'post',
    { ...GERENTE, params: { id: p.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: 1 } });
  assert(r.st === 422, 'status=' + r.st);
  assert(r.out.precoMinimo === 80, 'piso nao veio na resposta');
});

t('C3. politica estrita: admin ainda pode furar o piso', () => {
  const p = novoPedido(ADMIN, { clienteId: 1 }).out.pedido;
  const r = chamar('/api/pedidos/:id/itens', 'post',
    { ...ADMIN, params: { id: p.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: 1 } });
  assert(r.out.success, 'admin bloqueado');
  db.prepare("DELETE FROM config WHERE chave='preco_politica'").run();
});

t('D. preco omitido: o SERVIDOR resolve (caminho do app)', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = chamar('/api/pedidos/:id/itens', 'post',
    { ...VEND, params: { id: p.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 2 } });
  assert(r.out.success, r.out.error);
  assert(r.out.item.precoUnitario === 100, 'preco=' + r.out.item.precoUnitario);
  assert(r.out.item.valorTotal === 200, 'total=' + r.out.item.valorTotal);
  assert(r.out.precoFonte === 'produto', 'fonte=' + r.out.precoFonte);
});

t('D2. preco correto informado passa sem registro de desconto', () => {
  const antes = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='preco-abaixo-do-sugerido'").get().n;
  const p = novoPedido(GERENTE, { clienteId: 1 }).out.pedido;
  const r = chamar('/api/pedidos/:id/itens', 'post',
    { ...GERENTE, params: { id: p.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: 120 } });
  assert(r.out.success, 'recusou preco acima da tabela');
  assert(r.out.item.precoUnitario === 120, 'preco manual do gerente nao valeu: ' + r.out.item.precoUnitario);
  const depois = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='preco-abaixo-do-sugerido'").get().n;
  assert(antes === depois, 'registrou desconto onde nao havia');
});

t('D3. item sem produto (servico/desconto) continua aceitando preco livre de ator irrestrito', () => {
  const p = novoPedido(ADMIN, { clienteId: 1 }).out.pedido;
  const r = chamar('/api/pedidos/:id/itens', 'post',
    { ...ADMIN, params: { id: p.id }, body: { descricao: 'Desconto negociado', quantidade: 1, precoUnitario: -50 } });
  assert(r.out.success, 'quebrou o item avulso do ator irrestrito: ' + r.out.error);
  assert(r.out.item.precoUnitario === -50, 'preco=' + r.out.item.precoUnitario);
});

t('D4. itens no POST /api/pedidos tambem passam pela politica', () => {
  const r = novoPedido(VEND, { clienteId: 1, itens: [{ produtoId: 1, descricao: 'Tempero', quantidade: 1 }] });
  assert(r.out.pedido.itens.length === 1, 'item nao entrou');
  assert(r.out.pedido.itens[0].precoUnitario === 100, 'preco nao resolvido: ' + r.out.pedido.itens[0].precoUnitario);
});

// ---------- P. vendedor restrito NÃO define preço (regra de 2026-09-10) ----------
// O produto 1 custa 100 (precoVenda) e tem piso 80. Todo caso abaixo confere o
// mesmo desfecho: o item nasce a 100, venha no corpo o que vier.
const OFICIAL = 100;
const itemDoRestrito = (body) => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  return chamar('/api/pedidos/:id/itens', 'post', { ...VEND, params: { id: p.id }, body });
};
const ultimoIgnorado = () => {
  const l = db.prepare("SELECT * FROM audit_log WHERE action='preco-manual-ignorado' ORDER BY id DESC LIMIT 1").get();
  return l ? JSON.parse(l.payload) : null;
};

t('P-A. restrito sem precoUnitario usa o preco oficial', () => {
  const r = itemDoRestrito({ produtoId: 1, descricao: 'Tempero', quantidade: 1 });
  assert(r.out.success, r.out.error);
  assert(r.out.item.precoUnitario === OFICIAL, 'preco=' + r.out.item.precoUnitario);
});

t('P-B. restrito enviando preco ACIMA: valor ignorado, vale o oficial', () => {
  const r = itemDoRestrito({ produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: 150 });
  assert(r.out.success, r.out.error);
  assert(r.out.item.precoUnitario === OFICIAL, 'preco=' + r.out.item.precoUnitario);
  const log = ultimoIgnorado();
  assert(log && log.enviado === 150 && log.aplicado === OFICIAL, 'nao auditou o preco ignorado: ' + JSON.stringify(log));
});

t('P-C. restrito enviando preco entre sugerido e piso: ignorado', () => {
  const r = itemDoRestrito({ produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: 90 });
  assert(r.out.success, r.out.error);
  assert(r.out.item.precoUnitario === OFICIAL, 'preco=' + r.out.item.precoUnitario);
});

t('P-D. restrito enviando preco ABAIXO do piso: ignorado, sem 422', () => {
  const r = itemDoRestrito({ produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: 10 });
  assert(r.st === 200, 'status=' + r.st + ' (nao pode virar erro: quebraria a tela web)');
  assert(r.out.item.precoUnitario === OFICIAL, 'preco=' + r.out.item.precoUnitario);
});

t('P-E. restrito enviando preco NEGATIVO: ignorado', () => {
  const r = itemDoRestrito({ produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: -10 });
  assert(r.out.success, r.out.error);
  assert(r.out.item.precoUnitario === OFICIAL, 'preco=' + r.out.item.precoUnitario);
});

t('P-F. ator irrestrito mantem o preco manual', () => {
  const p = novoPedido(ADMIN, { clienteId: 1 }).out.pedido;
  const r = chamar('/api/pedidos/:id/itens', 'post',
    { ...ADMIN, params: { id: p.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: 150 } });
  assert(r.out.success, r.out.error);
  assert(r.out.item.precoUnitario === 150, 'admin perdeu o preco manual: ' + r.out.item.precoUnitario);
});

t('P-G. modo auditar (padrao) nao devolve autoridade de preco ao restrito', () => {
  assert(politicas.politicaPreco(db) === 'auditar', 'a politica de teste nao esta em auditar');
  const r = itemDoRestrito({ produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: 55 });
  assert(r.out.item.precoUnitario === OFICIAL, 'preco=' + r.out.item.precoUnitario);
});

t('P-H. modo estrito: restrito segue sem preco E o piso segue recusando quem informa', () => {
  db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('preco_politica','estrito')").run();
  try {
    const r = itemDoRestrito({ produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: 10 });
    assert(r.st === 200, 'restrito virou 422 no estrito: ' + r.st);
    assert(r.out.item.precoUnitario === OFICIAL, 'preco=' + r.out.item.precoUnitario);
    // A regra de piso não morreu com a mudança: quem AINDA informa preço e não
    // é irrestrito continua sendo recusado.
    const pg = novoPedido(GERENTE, { clienteId: 1 }).out.pedido;
    const rg = chamar('/api/pedidos/:id/itens', 'post',
      { ...GERENTE, params: { id: pg.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: 10 } });
    assert(rg.st === 422, 'piso parou de recusar: ' + rg.st);
    assert(rg.out.precoMinimo === 80, 'piso nao veio na resposta');
  } finally {
    db.prepare("DELETE FROM config WHERE chave='preco_politica'").run();
  }
});

t('P-I. restrito nao cria item avulso (sem produtoId) — 422', () => {
  const r = itemDoRestrito({ descricao: 'Servico avulso', quantidade: 1, precoUnitario: 200 });
  assert(r.st === 422, 'status=' + r.st);
  assert(/produto cadastrado/i.test(r.out.error || ''), 'mensagem=' + r.out.error);
});

t('P-J. restrito nao zera o pedido com item avulso negativo — 422', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  chamar('/api/pedidos/:id/itens', 'post',
    { ...VEND, params: { id: p.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 1 } });
  const r = chamar('/api/pedidos/:id/itens', 'post',
    { ...VEND, params: { id: p.id }, body: { descricao: 'Desconto negociado', quantidade: 1, precoUnitario: -100 } });
  assert(r.st === 422, 'status=' + r.st);
  assert(db.prepare('SELECT valorTotal FROM pedidos WHERE id=?').get(p.id).valorTotal === OFICIAL,
    'o total do pedido foi derrubado pelo item avulso');
});

t('P-K. PUT de item: preco do restrito tambem e ignorado', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const it = chamar('/api/pedidos/:id/itens', 'post',
    { ...VEND, params: { id: p.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 1 } }).out.item;
  const r = chamar('/api/pedidos/:id/itens/:itemId', 'put',
    { ...VEND, params: { id: p.id, itemId: it.id }, body: { quantidade: 2, precoUnitario: 7 } });
  assert(r.out.success, r.out.error);
  const gravado = db.prepare('SELECT * FROM pedido_itens WHERE id=?').get(it.id);
  assert(gravado.precoUnitario === OFICIAL, 'PUT gravou preco do corpo: ' + gravado.precoUnitario);
  assert(gravado.valorTotal === 200, 'total=' + gravado.valorTotal);
});

t('P-L. POST /api/pedidos com itens: preco do restrito tambem e ignorado', () => {
  const r = novoPedido(VEND, {
    clienteId: 1, itens: [{ produtoId: 1, descricao: 'Tempero', quantidade: 1, precoUnitario: 3 }],
  });
  assert(r.out.pedido.itens[0].precoUnitario === OFICIAL, 'preco=' + r.out.pedido.itens[0].precoUnitario);
});

t('P-M. POST /api/pedidos: item avulso do restrito nao entra, vira aviso', () => {
  const r = novoPedido(VEND, {
    clienteId: 1, itens: [{ descricao: 'Servico avulso', quantidade: 1, precoUnitario: 500 }],
  });
  assert(r.out.pedido.itens.length === 0, 'item avulso entrou pela criacao do pedido');
  assert(r.out.avisos && /produto cadastrado/i.test(r.out.avisos[0].erro), 'sem aviso: ' + JSON.stringify(r.out.avisos));
});

t('P-N. resolver indisponivel nao vira bypass do restrito (e nao muda o irrestrito)', () => {
  // Tenant não migrado: sem `tabelas_preco`, resolverPreco lança. Antes disso o
  // preço do corpo passava — para o restrito, seria a porta dos fundos.
  const DB_C = '/tmp/app-backend-teste-sem-tabela.db';
  try { fs.unlinkSync(DB_C); } catch {}
  const dbC = new Database(DB_C);
  dbC.exec(fs.readFileSync(SCHEMA, 'utf8')
    .split(/;\s*\n/).filter((s) => !/sqlite_sequence/i.test(s)).join(';\n'));
  dbC.exec('DROP TABLE tabelas_preco');
  dbC.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor)
    VALUES (10,'vend1','x','Vendedor Um','comercial',1,1)`).run();
  dbC.prepare(`INSERT INTO perfis_acesso (slug, nome, paginas, ativo) VALUES ('comercial','Vendedor',?,1)`)
    .run(JSON.stringify(['pedidos', 'produtos']));
  dbC.prepare(`INSERT INTO produtos (id, sku, descricao, unidade, precoVenda, ativo)
    VALUES (1,'SKU-A','Tempero verde','UN',100,1)`).run();

  const arg = (ator) => ({ pedido: { id: 1, clienteId: null }, produtoId: 1, quantidade: 1,
    precoInformado: 9, req: ator });
  const rv = politicas.precoDeItem(dbC, arg(VEND));
  assert(rv.ok === false, 'restrito passou com o preco do corpo: ' + JSON.stringify(rv));
  assert(/preço oficial/i.test(rv.erro || ''), 'mensagem=' + rv.erro);

  const ra = politicas.precoDeItem(dbC, arg(ADMIN));
  assert(ra.ok === true && ra.preco === 9 && ra.fonte === 'indisponivel',
    'comportamento legado do irrestrito mudou: ' + JSON.stringify(ra));
  dbC.close();
});

// ---------- FR. frete nunca é negativo (Fase 0, 2026-09-10) ----------
// `valorFrete` compõe o total e é gravável pelo PUT. Negativo, era o desconto
// sem alçada que sobrou depois da trava de preço — ver
// docs/auditoria-app-mobile-2026-08-26/06-fase-0-frete-pagamento.md.
const pedidoComItem = (ator) => {
  const p = novoPedido(ator, { clienteId: 1 }).out.pedido;
  chamar('/api/pedidos/:id/itens', 'post',
    { ...ator, params: { id: p.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 1 } });
  return p;
};
const freteDoPedido = (id) => db.prepare('SELECT valorFrete, valorTotal FROM pedidos WHERE id=?').get(id);
const porFrete = (ator, id, valorFrete) =>
  chamar('/api/pedidos/:id', 'put', { ...ator, params: { id }, body: { valorFrete } });

t('FR1. restrito com frete POSITIVO: aceito e somado ao total', () => {
  const p = pedidoComItem(VEND);
  const r = porFrete(VEND, p.id, 30);
  assert(r.out.success, r.out.error);
  const d = freteDoPedido(p.id);
  assert(d.valorFrete === 30, 'frete=' + d.valorFrete);
  assert(d.valorTotal === 130, 'total=' + d.valorTotal + ' (100 do item + 30 de frete)');
});

t('FR2. restrito com frete ZERO: aceito', () => {
  const p = pedidoComItem(VEND);
  const r = porFrete(VEND, p.id, 0);
  assert(r.out.success, r.out.error);
  const d = freteDoPedido(p.id);
  assert(d.valorFrete === 0, 'frete=' + d.valorFrete);
  assert(d.valorTotal === 100, 'total=' + d.valorTotal);
});

t('FR3. restrito com frete NEGATIVO: 422 e nada gravado', () => {
  const p = pedidoComItem(VEND);
  const r = porFrete(VEND, p.id, -50);
  assert(r.st === 422, 'status=' + r.st);
  assert(/negativo/i.test(r.out.error || ''), 'mensagem=' + r.out.error);
  const d = freteDoPedido(p.id);
  assert((d.valorFrete || 0) === 0, 'gravou frete negativo: ' + d.valorFrete);
  assert(d.valorTotal === 100, 'total foi derrubado: ' + d.valorTotal);
});

t('FR4. pedido que JA tem frete nao pode ser alterado para negativo', () => {
  const p = pedidoComItem(VEND);
  porFrete(VEND, p.id, 40);
  assert(freteDoPedido(p.id).valorTotal === 140, 'preparacao falhou');
  const r = porFrete(VEND, p.id, -40);
  assert(r.st === 422, 'status=' + r.st);
  const d = freteDoPedido(p.id);
  assert(d.valorFrete === 40, 'frete anterior perdido: ' + d.valorFrete);
  assert(d.valorTotal === 140, 'total=' + d.valorTotal);
});

t('FR5. a invariavel vale para ATOR IRRESTRITO tambem (nenhum frete negativo em 13 tenants)', () => {
  const p = pedidoComItem(ADMIN);
  const r = porFrete(ADMIN, p.id, -50);
  assert(r.st === 422, 'admin passou com frete negativo: status=' + r.st);
  assert(freteDoPedido(p.id).valorTotal === 100, 'total=' + freteDoPedido(p.id).valorTotal);
});

t('FR6. frete negativo como STRING tambem e recusado', () => {
  const p = pedidoComItem(VEND);
  const r = porFrete(VEND, p.id, '-50');
  assert(r.st === 422, 'status=' + r.st);
  assert(freteDoPedido(p.id).valorTotal === 100, 'total=' + freteDoPedido(p.id).valorTotal);
});

t('FR7. frete continua opcional: PUT sem o campo nao mexe no que ja estava', () => {
  const p = pedidoComItem(VEND);
  porFrete(VEND, p.id, 25);
  const r = chamar('/api/pedidos/:id', 'put', { ...VEND, params: { id: p.id }, body: { observacao: 'sem tocar no frete' } });
  assert(r.out.success, r.out.error);
  const d = freteDoPedido(p.id);
  assert(d.valorFrete === 25, 'frete=' + d.valorFrete);
  assert(d.valorTotal === 125, 'total=' + d.valorTotal);
});

// ---------- QT. quantidade de item é sempre > 0 (Fase 0, 2026-09-10) ----------
// `-1` é truthy, e a validação antiga era `if (!quantidade)`. O item negativo
// derrubava o total e, na entrega, virava saída negativa (estoque inflado).
// Ver docs/auditoria-app-mobile-2026-08-26/07-fase-0-quantidade.md.
const addItem = (ator, pedidoId, body) =>
  chamar('/api/pedidos/:id/itens', 'post', { ...ator, params: { id: pedidoId }, body });
const itensDoPedido = (id) => db.prepare('SELECT * FROM pedido_itens WHERE pedidoId=?').all(id);
const totalDoPedido = (id) => db.prepare('SELECT valorTotal FROM pedidos WHERE id=?').get(id).valorTotal;

t('QT1. quantidade positiva INTEIRA continua funcionando', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 3 });
  assert(r.out.success, r.out.error);
  assert(r.out.item.quantidade === 3, 'qtd=' + r.out.item.quantidade);
  assert(totalDoPedido(p.id) === 300, 'total=' + totalDoPedido(p.id));
});

// Usava o produto 1 (unidade UN) até 2026-09-10, quando a regra de unidade
// passou a recusar fração em UN — com razão. O que o teste prova ("decimal
// continua funcionando") vale igual, na unidade em que decimal faz sentido.
t('QT2. quantidade positiva DECIMAL continua funcionando (unidade fracionavel)', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = addItem(VEND, p.id, { produtoId: 3, descricao: 'A granel', quantidade: 2.5 });
  assert(r.out.success, r.out.error);
  assert(r.out.item.quantidade === 2.5, 'qtd=' + r.out.item.quantidade);
  assert(totalDoPedido(p.id) === 50, 'total=' + totalDoPedido(p.id));
});

t('QT3. string numerica valida continua aceita (comportamento atual)', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: '2' });
  assert(r.out.success, r.out.error);
  assert(r.out.item.quantidade === 2, 'qtd=' + r.out.item.quantidade);
});

t('QT4. quantidade ZERO -> 422 e nada gravado', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 0 });
  assert(r.st === 422, 'status=' + r.st);
  assert(/maior que zero|obrigatoria/i.test(r.out.error || ''), 'mensagem=' + r.out.error);
  assert(itensDoPedido(p.id).length === 0, 'gravou item com quantidade zero');
});

t('QT5. quantidade NEGATIVA -> 422, total intacto (o bypass confirmado)', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 2 });
  assert(totalDoPedido(p.id) === 200, 'preparacao: total=' + totalDoPedido(p.id));
  const r = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: -1 });
  assert(r.st === 422, 'status=' + r.st);
  assert(/maior que zero/i.test(r.out.error || ''), 'mensagem=' + r.out.error);
  assert(itensDoPedido(p.id).length === 1, 'gravou o item negativo');
  assert(totalDoPedido(p.id) === 200, 'total derrubado para ' + totalDoPedido(p.id));
});

t('QT6. string INVALIDA -> 422', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 'abc' });
  assert(r.st === 422, 'status=' + r.st);
  assert(itensDoPedido(p.id).length === 0, 'gravou quantidade nao numerica');
});

t('QT7. Infinity e NaN -> 422', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  for (const v of ['Infinity', '-Infinity', 'NaN', 1e400]) {
    const r = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: v });
    assert(r.st === 422, `valor ${v}: status=` + r.st);
  }
  assert(itensDoPedido(p.id).length === 0, 'gravou quantidade nao finita');
});

t('QT8. string numerica NEGATIVA -> 422', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: '-3' });
  assert(r.st === 422, 'status=' + r.st);
  assert(itensDoPedido(p.id).length === 0, 'gravou negativo em string');
});

t('QT9. POST /api/pedidos com itens[]: o invalido nao entra e vira aviso', () => {
  const r = novoPedido(VEND, { clienteId: 1, itens: [
    { produtoId: 1, descricao: 'Bom', quantidade: 2 },
    { produtoId: 1, descricao: 'Ruim', quantidade: -1 },
  ] });
  const itens = r.out.pedido.itens;
  assert(itens.length === 1, 'entraram ' + itens.length + ' itens');
  assert(itens[0].descricao === 'Bom', 'entrou o item errado');
  assert(r.out.pedido.valorTotal === 200, 'total=' + r.out.pedido.valorTotal);
  assert(r.out.avisos && /maior que zero/i.test(r.out.avisos[0].erro), 'sem aviso: ' + JSON.stringify(r.out.avisos));
});

t('QT10. PUT de item nao aceita quantidade invalida', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const it = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 2 }).out.item;
  for (const v of [-1, 0, 'abc']) {
    const r = chamar('/api/pedidos/:id/itens/:itemId', 'put',
      { ...VEND, params: { id: p.id, itemId: it.id }, body: { quantidade: v } });
    assert(r.st === 422, `valor ${v}: status=` + r.st);
  }
  const gravado = db.prepare('SELECT * FROM pedido_itens WHERE id=?').get(it.id);
  assert(gravado.quantidade === 2, 'qtd=' + gravado.quantidade);
  assert(gravado.valorTotal === 200, 'valorTotal=' + gravado.valorTotal);
  assert(totalDoPedido(p.id) === 200, 'total=' + totalDoPedido(p.id));
});

t('QT11. PUT sem quantidade preserva a que ja estava', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const it = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 2 }).out.item;
  const r = chamar('/api/pedidos/:id/itens/:itemId', 'put',
    { ...VEND, params: { id: p.id, itemId: it.id }, body: { descricao: 'Tempero verde' } });
  assert(r.out.success, r.out.error);
  const gravado = db.prepare('SELECT * FROM pedido_itens WHERE id=?').get(it.id);
  assert(gravado.quantidade === 2, 'qtd=' + gravado.quantidade);
  assert(gravado.descricao === 'Tempero verde', 'descricao=' + gravado.descricao);
});

t('QT12. a invariavel vale para ator IRRESTRITO tambem', () => {
  const p = novoPedido(ADMIN, { clienteId: 1 }).out.pedido;
  const r = addItem(ADMIN, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: -5 });
  assert(r.st === 422, 'admin passou com quantidade negativa: status=' + r.st);
  assert(itensDoPedido(p.id).length === 0, 'gravou');
});

t('QT13. quantidade invalida nao chega a estoque: sem item, sem reserva, sem movimentacao', () => {
  // Este é o único teste do arquivo que ENTREGA um pedido e, portanto, consome
  // saldo. A entrada abaixo devolve a unidade consumida, para o teste F — que
  // afirma `disponivel === 10` — continuar valendo independentemente da ordem.
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, origem, observacao, data)
    VALUES (1,'entrada',1,'ajuste','Reposicao do proprio QT13',date('now'))`).run();
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 1 });
  addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: -4 });   // 422
  const c = chamar('/api/pedidos/:id/confirmar', 'post', { ...VEND, params: { id: p.id }, body: {} });
  assert(c.out.success, 'confirmacao falhou: ' + c.out.error);
  const reservas = db.prepare("SELECT * FROM reservas_estoque WHERE pedidoId=? AND status='ativa'").all(p.id);
  assert(reservas.length === 1 && reservas[0].quantidade === 1, 'reservas=' + JSON.stringify(reservas));
  const e = chamar('/api/pedidos/:id/entregar', 'post', { ...VEND, params: { id: p.id }, body: {} });
  assert(e.out.success, 'entrega falhou: ' + e.out.error);
  // O fallback da entrega grava movimentação com a quantidade crua do item —
  // uma saída negativa viraria ENTRADA no saldo. Sem item inválido, não há.
  const negativas = db.prepare(`SELECT COUNT(*) n FROM movimentacoes_estoque
    WHERE origem='pedido' AND origemId=? AND quantidade <= 0`).get(p.id).n;
  assert(negativas === 0, 'gerou movimentacao com quantidade nao positiva');
  assert(totalDoPedido(p.id) === 100, 'total=' + totalDoPedido(p.id));
});

// ---------- LM. teto, precisão e unidade (Fase 0, 2026-09-10) ----------
// `1e308` é finito e positivo: passava. E `1.5 UN` não existe no mundo real,
// mas passava também. Ver 08-fase-0-limites-quantidade-pagamento.md.
const LIMITE = 1e9;

t('LM1. exatamente NO limite (1e9) e aceito', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: LIMITE });
  assert(r.out.success, r.out.error);
  assert(r.out.item.quantidade === LIMITE, 'qtd=' + r.out.item.quantidade);
});

t('LM2. um acima do limite -> 422', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: LIMITE + 1 });
  assert(r.st === 422, 'status=' + r.st);
  assert(/maximo permitido/i.test(r.out.error || ''), 'mensagem=' + r.out.error);
  assert(itensDoPedido(p.id).length === 0, 'gravou acima do limite');
});

t('LM3. 1e308 -> 422 (era o caso que passava por ser finito)', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 1e308 });
  assert(r.st === 422, 'status=' + r.st);
  assert(itensDoPedido(p.id).length === 0, 'gravou 1e308');
  assert(totalDoPedido(p.id) === 0, 'total=' + totalDoPedido(p.id));
});

t('LM4. unidade NAO fracionavel (UN): inteiro aceita, 2.0 aceita, 1.5 recusa', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  assert(addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 1 }).out.success, 'inteiro recusado');
  assert(addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 2.0 }).out.success, '2.0 recusado');
  const r = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 1.5 });
  assert(r.st === 422, 'status=' + r.st);
  assert(/fracionada/i.test(r.out.error || ''), 'mensagem=' + r.out.error);
  assert(itensDoPedido(p.id).length === 2, 'itens=' + itensDoPedido(p.id).length);
});

t('LM5. unidade FRACIONAVEL (KG): 0.5 e 1.25 aceitam', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const a = addItem(VEND, p.id, { produtoId: 3, descricao: 'A granel', quantidade: 0.5 });
  assert(a.out.success, a.out.error);
  assert(a.out.item.quantidade === 0.5, 'qtd=' + a.out.item.quantidade);
  assert(a.out.item.valorTotal === 10, 'total do item=' + a.out.item.valorTotal);
  const b = addItem(VEND, p.id, { produtoId: 3, descricao: 'A granel', quantidade: 1.25 });
  assert(b.out.success, b.out.error);
  assert(totalDoPedido(p.id) === 35, 'total=' + totalDoPedido(p.id));
});

t('LM6. precisao: 4 casas aceita, 5 recusa (mesmo padrao do qCom da NF-e)', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const ok = addItem(VEND, p.id, { produtoId: 3, descricao: 'A granel', quantidade: 1.2345 });
  assert(ok.out.success, ok.out.error);
  const r = addItem(VEND, p.id, { produtoId: 3, descricao: 'A granel', quantidade: 1.23456 });
  assert(r.st === 422, 'status=' + r.st);
  assert(/casas decimais/i.test(r.out.error || ''), 'mensagem=' + r.out.error);
  assert(itensDoPedido(p.id).length === 1, 'itens=' + itensDoPedido(p.id).length);
});

t('LM7. unidade AMBIGUA nao restringe fracao (cadastro sujo nao barra venda)', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const r = addItem(VEND, p.id, { produtoId: 4, descricao: 'Ambiguo', quantidade: 1.5 });
  assert(r.out.success, 'unidade "6" barrou fracao: ' + r.out.error);
  assert(r.out.item.quantidade === 1.5, 'qtd=' + r.out.item.quantidade);
});

t('LM8. item AVULSO (sem produto) nao sofre a regra de unidade, mas sofre as demais', () => {
  const p = novoPedido(ADMIN, { clienteId: 1 }).out.pedido;   // avulso é do ator irrestrito
  const frac = chamar('/api/pedidos/:id/itens', 'post',
    { ...ADMIN, params: { id: p.id }, body: { descricao: 'Servico avulso', quantidade: 1.5, precoUnitario: 100 } });
  assert(frac.out.success, 'avulso fracionado recusado: ' + frac.out.error);
  const acima = chamar('/api/pedidos/:id/itens', 'post',
    { ...ADMIN, params: { id: p.id }, body: { descricao: 'Servico avulso', quantidade: LIMITE + 1, precoUnitario: 100 } });
  assert(acima.st === 422, 'avulso acima do limite passou: ' + acima.st);
  const zero = chamar('/api/pedidos/:id/itens', 'post',
    { ...ADMIN, params: { id: p.id }, body: { descricao: 'Servico avulso', quantidade: 0, precoUnitario: 100 } });
  assert(zero.st === 422, 'avulso com zero passou: ' + zero.st);
});

t('LM9. PUT respeita teto, precisao e unidade', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  const it = addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 2 }).out.item;
  for (const v of [LIMITE + 1, 1.5, 1.23456]) {
    const r = chamar('/api/pedidos/:id/itens/:itemId', 'put',
      { ...VEND, params: { id: p.id, itemId: it.id }, body: { quantidade: v } });
    assert(r.st === 422, `valor ${v}: status=` + r.st);
  }
  assert(db.prepare('SELECT quantidade FROM pedido_itens WHERE id=?').get(it.id).quantidade === 2, 'quantidade mudou');
  assert(totalDoPedido(p.id) === 200, 'total=' + totalDoPedido(p.id));
});

t('LM10. POST /api/pedidos com itens[]: teto e unidade viram aviso', () => {
  const r = novoPedido(VEND, { clienteId: 1, itens: [
    { produtoId: 3, descricao: 'A granel', quantidade: 0.5 },
    { produtoId: 1, descricao: 'Fracionado em UN', quantidade: 1.5 },
    { produtoId: 1, descricao: 'Absurdo', quantidade: 1e308 },
  ] });
  assert(r.out.pedido.itens.length === 1, 'entraram ' + r.out.pedido.itens.length);
  assert(r.out.avisos.length === 2, 'avisos=' + JSON.stringify(r.out.avisos));
  assert(r.out.pedido.valorTotal === 10, 'total=' + r.out.pedido.valorTotal);
});

t('LM11. quantidade recusada nao cria reserva nem movimentacao', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 1e308 });   // 422
  addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 1.5 });     // 422
  assert(itensDoPedido(p.id).length === 0, 'gravou item invalido');
  const c = chamar('/api/pedidos/:id/confirmar', 'post', { ...VEND, params: { id: p.id }, body: {} });
  assert(c.st === 400 && /sem itens/i.test(c.out.error || ''), 'confirmou pedido vazio: ' + JSON.stringify(c));
  const reservas = db.prepare('SELECT COUNT(*) n FROM reservas_estoque WHERE pedidoId=?').get(p.id).n;
  assert(reservas === 0, 'criou reserva');
  const movs = db.prepare("SELECT COUNT(*) n FROM movimentacoes_estoque WHERE origem='pedido' AND origemId=?").get(p.id).n;
  assert(movs === 0, 'movimentou estoque');
});

// ---------- RP. registrar-pagamento descontinuado (410) ----------
t('RP1. endpoint responde 410 e nao altera valorPago', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  addItem(VEND, p.id, { produtoId: 1, descricao: 'Tempero', quantidade: 1 });
  const antes = db.prepare('SELECT valorPago, statusPagamento FROM pedidos WHERE id=?').get(p.id);
  const r = chamar('/api/pedidos/:id/registrar-pagamento', 'post',
    { ...VEND, params: { id: p.id }, body: { valor: 100 } });
  assert(r.st === 410, 'status=' + r.st);
  assert(/descontinuado/i.test(r.out.error || ''), 'mensagem=' + r.out.error);
  const depois = db.prepare('SELECT valorPago, statusPagamento FROM pedidos WHERE id=?').get(p.id);
  assert((depois.valorPago || 0) === (antes.valorPago || 0), 'valorPago mudou: ' + depois.valorPago);
  assert(depois.statusPagamento === antes.statusPagamento, 'statusPagamento mudou');
});

t('RP2. nao cria conta a receber nem movimentacao financeira', () => {
  const crAntes = db.prepare('SELECT COUNT(*) n FROM contas_a_receber').get().n;
  const movAntes = db.prepare('SELECT COUNT(*) n FROM movimentacoes_financeiras').get().n;
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  chamar('/api/pedidos/:id/registrar-pagamento', 'post', { ...VEND, params: { id: p.id }, body: { valor: 500 } });
  assert(db.prepare('SELECT COUNT(*) n FROM contas_a_receber').get().n === crAntes, 'criou CR');
  assert(db.prepare('SELECT COUNT(*) n FROM movimentacoes_financeiras').get().n === movAntes, 'lancou caixa');
});

t('RP3. a tentativa fica registrada no audit_log', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  chamar('/api/pedidos/:id/registrar-pagamento', 'post', { ...VEND, params: { id: p.id }, body: { valor: 77 } });
  const log = db.prepare("SELECT * FROM audit_log WHERE action='endpoint-descontinuado' ORDER BY id DESC LIMIT 1").get();
  assert(log, 'nao auditou a tentativa');
  assert(log.userId === 10, 'autor errado: ' + log.userId);
  assert(JSON.parse(log.payload).valorEnviado === 77, 'payload=' + log.payload);
});

// ---------- E. estoque insuficiente ----------
t('E. confirmar sem saldo devolve 409 com insuficiencias', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  chamar('/api/pedidos/:id/itens', 'post',
    { ...VEND, params: { id: p.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 999 } });
  const r = chamar('/api/pedidos/:id/confirmar', 'post', { ...VEND, params: { id: p.id }, body: {} });
  assert(r.st === 409, 'status=' + r.st);
  assert(r.out.insuficiencias && r.out.insuficiencias.length, 'sem lista de insuficiencias');
});

// ---------- F/G. disponibilidade e RBAC ----------
t('F. disponibilidade minima responde sob /api/produtos', () => {
  const r = chamar('/api/produtos/disponibilidade', 'post', { ...VEND, body: { itens: [{ produtoId: 1, quantidade: 3 }] } });
  assert(r.out.success, r.out.error);
  const i = r.out.itens[0];
  assert(i.disponivel === 10 && i.suficiente === true, JSON.stringify(i));
  assert(i.custoMedio === undefined && i.valorEstoque === undefined, 'vazou dado de custo');
});

t('G. RBAC: perfil de vendedor alcanca /api/produtos e NAO alcanca /api/estoque', () => {
  const { podeChamarApi, acessoDoUsuario } = require('../perfis-acesso');
  const acesso = acessoDoUsuario(db, VEND.user);
  assert(!acesso.irrestrito, 'perfil de teste ficou irrestrito');
  assert(podeChamarApi(acesso, '/api/produtos/disponibilidade'), 'vendedor barrado na disponibilidade');
  assert(!podeChamarApi(acesso, '/api/estoque/verificar-disponibilidade'), 'vendedor alcancou /api/estoque');
  assert(!podeChamarApi(acesso, '/api/estoque/valorizacao'), 'vendedor alcancou valorizacao');
  assert(podeChamarApi(acesso, '/api/pedidos'), 'vendedor barrado em pedidos');
  assert(podeChamarApi(acesso, '/api/precos/resolver'), 'vendedor barrado em precos');
});

// ---------- H/I. meus pedidos ----------
t('H. vendedor ve somente os proprios pedidos', () => {
  novoPedido(VEND2, { clienteId: 1 });
  const r = chamar('/api/pedidos', 'get', { ...VEND, query: {} });
  assert(r.out.escopo === 'proprio', 'escopo=' + r.out.escopo);
  assert(r.out.pedidos.every(p => p.vendedorId === 10), 'vazou pedido de outro vendedor');
  assert(r.out.pedidos.length > 0, 'nao devolveu nada');
});

t('H2. vendedorId na query nao amplia acesso', () => {
  const r = chamar('/api/pedidos', 'get', { ...VEND, query: { vendedorId: '11' } });
  assert(r.out.pedidos.every(p => p.vendedorId === 10), 'query ampliou o acesso');
});

t('H3. resumo tambem respeita o escopo', () => {
  const meu = chamar('/api/pedidos/resumo', 'get', { ...VEND, query: {} }).out.resumo;
  const geral = chamar('/api/pedidos/resumo', 'get', { ...ADMIN, query: {} }).out.resumo;
  assert(meu.total < geral.total, `resumo do vendedor (${meu.total}) devia ser menor que o geral (${geral.total})`);
});

t('H4. paginacao funciona e informa total', () => {
  const r = chamar('/api/pedidos', 'get', { ...ADMIN, query: { page: '1', limit: '2' } });
  assert(r.out.pedidos.length === 2, 'len=' + r.out.pedidos.length);
  assert(r.out.total > 2, 'total=' + r.out.total);
  const p2 = chamar('/api/pedidos', 'get', { ...ADMIN, query: { page: '2', limit: '2' } });
  assert(p2.out.pedidos[0].id !== r.out.pedidos[0].id, 'pagina 2 repetiu a 1');
});

t('H5. sem page/limit o retorno segue completo (compat da tela web)', () => {
  const r = chamar('/api/pedidos', 'get', { ...ADMIN, query: {} });
  assert(r.out.total === undefined, 'passou a paginar sem pedirem');
  assert(r.out.pedidos.length > 2, 'cortou a lista');
});

t('I. perfil superior mantem acesso amplo', () => {
  const r = chamar('/api/pedidos', 'get', { ...ADMIN, query: {} });
  assert(r.out.escopo === 'todos', 'escopo=' + r.out.escopo);
  assert(r.out.pedidos.some(p => p.vendedorId === 11), 'admin nao ve pedido de outro');
  const f = chamar('/api/pedidos', 'get', { ...ADMIN, query: { vendedorId: '11' } });
  assert(f.out.pedidos.every(p => p.vendedorId === 11), 'filtro do admin nao aplicou');
});

// ---------- K/L. o pedido continua sendo um pedido normal ----------
t('K. pedido do app aparece na listagem comum, com numeracao normal', () => {
  const p = novoPedido(VEND, { clienteId: 1, origem: 'app' }).out.pedido;
  assert(/^PED-\d{4}-\d{5}$/.test(p.numero), 'numero fora do padrao: ' + p.numero);
  const naListaGeral = chamar('/api/pedidos', 'get', { ...ADMIN, query: {} }).out.pedidos.some(x => x.id === p.id);
  assert(naListaGeral, 'sumiu da listagem geral');
});

t('L. pedido do app confirma, reserva estoque e segue o fluxo normal', () => {
  const p = novoPedido(VEND, { clienteId: 1, origem: 'app' }).out.pedido;
  const it = chamar('/api/pedidos/:id/itens', 'post',
    { ...VEND, params: { id: p.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 2 } });
  assert(it.out.success, it.out.error);
  const c = chamar('/api/pedidos/:id/confirmar', 'post', { ...VEND, params: { id: p.id }, body: {} });
  assert(c.out.success, 'confirmacao falhou: ' + c.out.error);
  assert(c.out.pedido.status === 'confirmado', 'status=' + c.out.pedido.status);
  const res = db.prepare("SELECT * FROM reservas_estoque WHERE pedidoId=? AND status='ativa'").all(p.id);
  assert(res.length === 1 && res[0].quantidade === 2, 'reserva nao criada');
  assert(c.out.pedido.valorTotal === 200, 'total=' + c.out.pedido.valorTotal);
});

// ---------- auditoria ----------
t('M. acao do vendedor entra no audit_log com o usuario real', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  chamar('/api/pedidos/:id', 'put', { ...VEND, params: { id: p.id }, body: { vendedorId: 11 } });
  const log = db.prepare("SELECT * FROM audit_log WHERE action='vendedor-ignorado' ORDER BY id DESC LIMIT 1").get();
  assert(log, 'nao auditou a tentativa');
  assert(log.userId === 10 && log.username === 'vend1', 'autor errado: ' + log.username);
});

// ---------- CFOP: os dois caminhos de criação de item precisam empatar ----------
t('J1. item por POST /itens nasce com CFOP resolvido', () => {
  const p = novoPedido(VEND, { clienteId: 1 }).out.pedido;
  chamar('/api/pedidos/:id', 'put', { ...VEND, params: { id: p.id }, body: { tipoOperacaoId: 1 } });
  const r = chamar('/api/pedidos/:id/itens', 'post',
    { ...VEND, params: { id: p.id }, body: { produtoId: 1, descricao: 'Tempero', quantidade: 1 } });
  assert(r.out.item.cfop === '5102', 'cfop=' + r.out.item.cfop);
});

t('J2. item no POST /api/pedidos nasce com o MESMO CFOP (antes vinha NULL)', () => {
  const r = novoPedido(VEND, {
    clienteId: 1, tipoOperacaoId: 1,
    itens: [{ produtoId: 1, descricao: 'Tempero', quantidade: 1 }],
  });
  // tipoOperacaoId não entra pelo POST (só pelo PUT), então aqui o motor cai no
  // VDA-NORMAL padrão — que é exatamente o comportamento da tela web.
  assert(r.out.pedido.itens[0].cfop === '5102', 'cfop=' + r.out.pedido.itens[0].cfop);
});

// ---------- J. isolamento entre tenants ----------
t('J3. dois tenants: pedido de A nao existe em B', () => {
  const DB_B = '/tmp/app-backend-teste-b.db';
  try { fs.unlinkSync(DB_B); } catch {}
  const dbB = new Database(DB_B);
  dbB.exec(fs.readFileSync(SCHEMA, 'utf8')
    .split(/;\s*\n/).filter((s) => !/sqlite_sequence/i.test(s)).join(';\n'));
  dbB.prepare("INSERT INTO pessoas (id, cpfCnpj, tipo, razaoSocial, ativo) VALUES (1,'11222333000181','PJ','Cliente B',1)").run();
  dbB.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor)
    VALUES (10,'vend1','x','Homonimo','comercial',1,1)`).run();

  const appB = express();
  registrarRotasPedidos(appB, dbB);
  const acharB = (p, m) => ((appB.router || appB._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]).route.stack.at(-1).handle;

  const daA = db.prepare('SELECT id, numero FROM pedidos ORDER BY id DESC LIMIT 1').get();
  let out = null, st = 200;
  acharB('/api/pedidos/:id', 'get')(
    { params: { id: daA.id }, query: {}, body: {}, session: VEND.session, user: VEND.user, headers: {} },
    { json: x => { out = x; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  assert(st === 404, 'tenant B respondeu ' + st + ' para pedido do tenant A');

  // E o mesmo userId em B não enxerga nada de A.
  let lista = null;
  acharB('/api/pedidos', 'get')(
    { params: {}, query: {}, body: {}, session: VEND.session, user: VEND.user, headers: {} },
    { json: x => { lista = x; }, status: () => ({ json: x => { lista = x; } }) });
  assert(lista.pedidos.length === 0, 'tenant B listou ' + lista.pedidos.length + ' pedido(s) de A');
  dbB.close();
});

// ---------- unitários da política ----------
t('N. vendedorRestrito e podeDelegar refletem o perfil', () => {
  assert(politicas.vendedorRestrito(db, VEND) === true, 'vendedor devia ser restrito');
  assert(politicas.vendedorRestrito(db, ADMIN) === false, 'admin nao pode ser restrito');
  assert(politicas.podeDelegarVendedor(db, VEND) === false, 'vendedor nao pode delegar');
  assert(politicas.podeDelegarVendedor(db, ADMIN) === true, 'admin deve delegar');
  assert(politicas.podeDelegarVendedor(db, SISTEMA) === true, 'X-Api-Key deve manter comportamento');
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
