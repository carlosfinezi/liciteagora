/**
 * Autenticidade do webhook de cobrança (Fase 1.5, 07/10/2026).
 *
 * ── A vulnerabilidade, exata ───────────────────────────────────────────────
 *
 * A URL do boleto que vai ao cliente é a do provedor, e ela carrega o id da
 * cobrança no caminho: `asaas.com/b/pdf/pay_xxx`. Medido na Fase 1.
 *
 * Até aqui, `processarWebhook` do Asaas validava o segredo só quando a conta
 * tinha um configurado (`if (cfg.webhookToken)`). Numa conta sem segredo —
 * que o cadastro permitia, porque o campo é opcional — qualquer POST para
 * `https://<tenant>.liciteagora.app/webhook/boleto/asaas` com
 * `{event:'PAYMENT_RECEIVED', payment:{id:'pay_xxx'}}` baixava a conta a
 * receber, lançava o caixa e dava o pedido por pago. Quem recebeu um boleto
 * tinha tudo o que precisava para não pagá-lo.
 *
 * A resposta do endpoint também diferenciava os casos (`skipped` x `aplicado`,
 * este último com `contaReceberId` e `boletoId` dentro), então dava para varrer
 * `pay_id` e descobrir quais cobranças existem sem acertar segredo nenhum.
 *
 * ── A regra ───────────────────────────────────────────────────────────────
 *
 * Fail closed, nas duas pontas:
 *   - conta sem segredo NÃO é provedor pronto para pagamento online, e a API
 *     recusa ativar `pix_online` e `boleto_online` nela;
 *   - webhook sem o segredo certo NUNCA baixa nada, e a resposta é a mesma
 *     para recusa e para sucesso.
 *
 * Conhecer `pay_xxx` deixou de ser suficiente para marcar uma venda como paga.
 *
 * Blocos:
 *   A. o webhook autenticado continua funcionando
 *   B. fail closed: sem token, token errado, conta sem segredo
 *   C. a tentativa inválida não deixa rastro em lugar nenhum
 *   D. isolamento entre tenants
 *   E. a resposta não serve para enumerar
 *   F. habilitação dos métodos online
 *   G. o que NÃO pode ser quebrado: emissão, polling, consulta
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };
const perto = (a, b, m) => assert(Math.abs(Number(a) - Number(b)) < 0.005, `${m}: esperado ${b}, veio ${a}`);

const SEGREDO = 'segredo-do-webhook-do-tenant';

/* ───────────── Asaas falso ───────────── */
const ASAAS = { pagamentos: new Map(), chamadas: [], seq: 0 };
const LINHA = '34191790010104351004791020150008291070026000';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
global.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host !== 'api-sandbox.asaas.com') throw new Error('chamada externa na suíte: ' + url);
  const metodo = init.method || 'GET';
  const corpo = init.body ? JSON.parse(init.body) : null;
  ASAAS.chamadas.push({ metodo, caminho: u.pathname + u.search, corpo });
  const resp = (status, obj) => ({ ok: status < 300, status, statusText: String(status), text: async () => JSON.stringify(obj) });
  const p = u.pathname.replace('/v3', '');
  if (metodo === 'GET' && p === '/customers') return resp(200, { data: [] });
  if (metodo === 'POST' && p === '/customers') return resp(200, { id: 'cus_' + corpo.cpfCnpj });
  if (metodo === 'POST' && p === '/payments') {
    const id = 'pay_' + (++ASAAS.seq);
    ASAAS.pagamentos.set(id, { ...corpo, id, status: 'PENDING' });
    const fora = { id, status: 'PENDING', invoiceUrl: 'https://sandbox.asaas.com/i/' + id };
    if (corpo.billingType === 'BOLETO') fora.bankSlipUrl = 'https://sandbox.asaas.com/b/pdf/' + id;
    return resp(200, fora);
  }
  let m = /^\/payments\/(pay_\d+)\/identificationField$/.exec(p);
  if (m) return resp(200, { identificationField: LINHA, barCode: LINHA.slice(0, 44) });
  m = /^\/payments\/(pay_\d+)\/pixQrCode$/.exec(p);
  if (m) return resp(200, { payload: '00020126PIX' + m[1], encodedImage: PNG });
  m = /^\/payments\/(pay_\d+)$/.exec(p);
  if (m && metodo === 'GET') { const x = ASAAS.pagamentos.get(m[1]); return resp(x ? 200 : 404, x || {}); }
  if (m && metodo === 'DELETE') { const x = ASAAS.pagamentos.get(m[1]); if (x) x.status = 'DELETED'; return resp(200, { deleted: true }); }
  return resp(404, { errors: [{ description: 'rota desconhecida: ' + p }] });
};

/* ───────────── banco ───────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-seg-'));
const SCHEMA = require('./schema-de-tenant').schemaDeTenant();
let seq = 0;
let MODELO = null;
function modelo() {
  if (MODELO) return MODELO;
  MODELO = path.join(tmp, 'modelo.db');
  const db = new Database(MODELO);
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA);
  require('../db-schema').initSchema(db);
  require('../loja-routes').migrarLojaDB(db);
  try { require('../tipos-operacao-routes').migrar(db); } catch (_) {}
  try { require('../precos-routes').migrarPrecosDB(db); } catch (_) {}
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL, caminho TEXT, ordem INTEGER DEFAULT 0)`);
  db.pragma('journal_mode = DELETE');
  db.close();
  return MODELO;
}

/**
 * Um tenant. `segredo` null monta a conta SEM `webhookToken` — que é
 * exatamente a configuração que o cadastro permitia e que esta fase fecha.
 */
function montar({ segredo = SEGREDO, modo = 'pix-ou-boleto', provedor = true } = {}) {
  const arq = path.join(tmp, `w${++seq}.db`);
  fs.copyFileSync(modelo(), arq);
  const db = new Database(arq);
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO produtos (sku, descricao, categoria, ativo, publicadoNaLoja, precoVenda, precoCusto)
    VALUES ('CAD-01', 'Cadeira de praia', 'Lazer', 1, 1, 80, 40)`).run();
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, data)
    VALUES (1, 'entrada', 50, 40, date('now'))`).run();
  const nat = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = 'VDA-NORMAL' AND ativo = 1`).get()
    || db.prepare('SELECT id FROM tipos_operacao WHERE ativo = 1 AND usarEmPedido = 1 AND movimentaEstoque = 1 ORDER BY id LIMIT 1').get();
  db.prepare(`UPDATE loja_config SET ativa = 1, nome = 'LOJA PROVA', whatsapp = '94991769924',
      servicoRetirada = 1, servicoDelivery = 0, freteModo = 'gratis', mostrarPreco = 1,
      pagamentoModo = ?, pagamentoVencimentoDias = 3, tipoOperacaoPedidoId = ? WHERE id = 1`).run(modo, nat.id);
  if (provedor) {
    const conta = db.prepare("INSERT INTO contas_financeiras (nome, tipo) VALUES ('Asaas', 'banco')").run().lastInsertRowid;
    const cfg = { accessToken: '$aact_hmlg_teste' };
    if (segredo) cfg.webhookToken = segredo;
    db.prepare(`INSERT INTO contas_financeiras_boleto (contaFinanceiraId, provedor, ambiente, ativo, ehPadrao, configJson)
      VALUES (?, 'asaas', 'homologacao', 1, 1, ?)`).run(conta, JSON.stringify(cfg));
  }
  db.exec('DELETE FROM loja_metodos_pagamento');
  require('../loja-metodos-pagamento').migrarMetodos(db);
  return db;
}

function montarApp(db) {
  const rotas = new Map();
  const reg = (m) => (url, ...fns) => rotas.set(m + ' ' + url, fns[fns.length - 1]);
  const app = {
    get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), use() {},
    async chamar(m, url, body, params) {
      const fn = rotas.get(m + ' ' + url);
      if (!fn) throw new Error('rota não registrada: ' + m + ' ' + url);
      let saida = null, status = 200;
      const res = { json: (d) => { saida = d; return res; }, status: (s) => { status = s; return res; },
                    set() { return res; }, setHeader() { return res; }, end() { return res; } };
      await fn({ body: body || {}, query: {}, params: params || {}, session: {}, headers: {}, protocol: 'https',
                 get: () => 'loja.local', tenant: { slug: 'prova' + seq } }, res);
      return { status, body: saida };
    },
  };
  require('../reservas-routes').registrarRotasReservas(app, db);
  require('../pedidos-routes').registrarRotasPedidos(app, db);
  require('../loja-routes').registrarRotasLojaPublica(app, db);
  require('../loja-routes').registrarRotasLojaAdmin(app, db);
  return app;
}

/** O POST que o provedor faz, com o header que ele manda (ou sem). */
function aviso(db, payId, segredo, extra) {
  const headers = {};
  if (segredo !== undefined && segredo !== null) headers['asaas-access-token'] = segredo;
  const req = {
    body: { event: 'PAYMENT_RECEIVED', payment: { id: payId, value: 160, paymentDate: '2026-10-07' }, ...(extra || {}) },
    headers,
    get: (h) => headers[String(h).toLowerCase()],
  };
  return require('../boleto-orchestrator').processarWebhook(db, 'asaas', req);
}

const FINALIZAR = '/loja/api/pedido/finalizar';
const CPF = '52998224725';
const corpo = (extra) => ({
  idempotencyKey: crypto.randomUUID(),
  cliente: { nome: 'JOANA COMPRADORA', telefone: '94999887766', cpfCnpj: CPF },
  atendimento: 'retirada', metodo: 'boleto_online',
  itens: [{ produtoId: 1, quantidade: 2, opcoes: [], textos: {} }],
  ...extra,
});
const pedidoPor = (db, numero) => db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(numero);
const crDo = (db, pedidoId) => db.prepare(
  "SELECT * FROM contas_a_receber WHERE pedidoId = ? AND status != 'cancelada' ORDER BY id DESC LIMIT 1").get(pedidoId);
const ultimoPayId = () => [...ASAAS.pagamentos.keys()].pop();

/** Tudo o que uma baixa toca. Serve para provar que NADA foi tocado. */
function retrato(db, pedidoId) {
  const cr = crDo(db, pedidoId);
  return {
    pedidoStatusPag: db.prepare('SELECT statusPagamento FROM pedidos WHERE id = ?').get(pedidoId).statusPagamento,
    pedidoValorPago: db.prepare('SELECT COALESCE(valorPago,0) v FROM pedidos WHERE id = ?').get(pedidoId).v,
    crStatus: cr ? cr.status : null,
    crValorPago: cr ? Number(cr.valorPago || 0) : null,
    pagamentos: db.prepare('SELECT COUNT(*) n FROM contas_receber_pagamentos').get().n,
    movimentacoes: db.prepare('SELECT COUNT(*) n FROM movimentacoes_financeiras').get().n,
    boletoStatus: cr ? (db.prepare('SELECT status FROM boletos WHERE contaReceberId = ? ORDER BY id DESC LIMIT 1').get(cr.id) || {}).status : null,
    contasPagar: db.prepare('SELECT COUNT(*) n FROM contas_a_pagar').get().n,
  };
}

/* ═════════════ A. o webhook autenticado funciona ═════════════ */

t('A1. token correto processa o evento e baixa a conta a receber', async () => {
  const db = montar(); const app = montarApp(db);
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  await aviso(db, ultimoPayId(), SEGREDO);
  const d = retrato(db, ped.id);
  assert(d.pedidoStatusPag === 'pago', 'statusPagamento: ' + d.pedidoStatusPag);
  assert(d.crStatus === 'paga', 'CR: ' + d.crStatus);
  assert(d.pagamentos === 1, 'pagamentos: ' + d.pagamentos);
  assert(d.movimentacoes >= 1, 'não lançou no caixa');
  assert(d.boletoStatus === 'pago', 'boleto: ' + d.boletoStatus);
  db.close();
});

t('A2. webhook duplicado continua idempotente', async () => {
  const db = montar(); const app = montarApp(db);
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  const id = ultimoPayId();
  await aviso(db, id, SEGREDO);
  const depois1 = retrato(db, ped.id);
  await aviso(db, id, SEGREDO);
  await aviso(db, id, SEGREDO);
  const depois3 = retrato(db, ped.id);
  assert(depois3.pagamentos === depois1.pagamentos, `reentrega duplicou pagamento: ${depois1.pagamentos} → ${depois3.pagamentos}`);
  assert(depois3.movimentacoes === depois1.movimentacoes, 'reentrega duplicou movimentação');
  perto(depois3.crValorPago, depois1.crValorPago, 'valorPago da CR mudou na reentrega');
  db.close();
});

/* ═════════════ B. fail closed ═════════════ */

t('B1. aviso SEM o header é recusado', async () => {
  const db = montar(); const app = montarApp(db);
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  const antes = retrato(db, ped.id);
  await aviso(db, ultimoPayId(), undefined);
  assert(JSON.stringify(retrato(db, ped.id)) === JSON.stringify(antes), 'o aviso sem header mexeu em algo');
  db.close();
});

t('B2. aviso com token ERRADO é recusado', async () => {
  const db = montar(); const app = montarApp(db);
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  const antes = retrato(db, ped.id);
  await aviso(db, ultimoPayId(), 'nao-e-o-segredo');
  assert(JSON.stringify(retrato(db, ped.id)) === JSON.stringify(antes), 'o token errado mexeu em algo');
  db.close();
});

t('B3. token com o PREFIXO certo e o resto errado é recusado', async () => {
  const db = montar(); const app = montarApp(db);
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  const antes = retrato(db, ped.id);
  // Mesmo tamanho, só o último caractere diferente: é o caso que uma comparação
  // frouxa (prefixo, startsWith, truncada) deixaria passar.
  await aviso(db, ultimoPayId(), SEGREDO.slice(0, -1) + 'X');
  assert(JSON.stringify(retrato(db, ped.id)) === JSON.stringify(antes), 'token quase certo passou');
  // E o prefixo sozinho também não basta.
  await aviso(db, ultimoPayId(), SEGREDO.slice(0, 10));
  assert(JSON.stringify(retrato(db, ped.id)) === JSON.stringify(antes), 'prefixo do token passou');
  db.close();
});

t('B4. tenant SEM segredo configurado é fail closed, mesmo com o pay_id certo', async () => {
  /* O cenário exato da vulnerabilidade: a conta não tem `webhookToken`, e o
     atacante tem o `pay_id` porque ele está na URL do boleto que recebeu.
     Para montar a cobrança o segredo é posto e depois RETIRADO — é o estado
     que o cadastro permitia, e que agora não aceita aviso nenhum. */
  const db = montar(); const app = montarApp(db);
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  db.prepare(`UPDATE contas_financeiras_boleto SET configJson = ?`)
    .run(JSON.stringify({ accessToken: '$aact_hmlg_teste' }));
  const antes = retrato(db, ped.id);

  await aviso(db, ultimoPayId(), undefined);
  await aviso(db, ultimoPayId(), SEGREDO);
  await aviso(db, ultimoPayId(), '');
  assert(JSON.stringify(retrato(db, ped.id)) === JSON.stringify(antes),
    'conta sem segredo aceitou aviso — é a vulnerabilidade da Fase 1.5');
  db.close();
});

t('B5. segredo só com espaços não é segredo', async () => {
  const db = montar({ segredo: '   ' }); const app = montarApp(db);
  const { webhookAutenticado } = require('../boleto-provedores/asaas');
  assert(webhookAutenticado({ webhookToken: '   ' }) === false, 'espaço em branco passou por segredo');
  assert(webhookAutenticado({ webhookToken: '' }) === false, 'vazio passou');
  assert(webhookAutenticado({}) === false, 'ausente passou');
  assert(webhookAutenticado({ webhookToken: 'x' }) === true, 'segredo de verdade foi recusado');
  db.close();
});

t('B6. conhecer o pay_id NUNCA basta: nenhum evento passa sem o segredo', async () => {
  const db = montar(); const app = montarApp(db);
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  const id = ultimoPayId();
  const antes = retrato(db, ped.id);
  for (const ev of ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED_IN_CASH']) {
    await aviso(db, id, undefined, { event: ev });
    await aviso(db, id, 'chute', { event: ev });
  }
  assert(JSON.stringify(retrato(db, ped.id)) === JSON.stringify(antes), 'algum evento passou sem segredo');
  db.close();
});

/* ═════════════ C. a tentativa inválida não deixa rastro ═════════════ */

t('C1. tentativa inválida não cria pagamento, não lança caixa, não mexe no pedido', async () => {
  const db = montar(); const app = montarApp(db);
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  const antes = retrato(db, ped.id);
  for (const tok of [undefined, '', 'errado', SEGREDO + 'a']) await aviso(db, ultimoPayId(), tok);
  const depois = retrato(db, ped.id);
  assert(depois.pagamentos === 0, 'criou pagamento: ' + depois.pagamentos);
  assert(depois.movimentacoes === antes.movimentacoes, 'lançou no caixa');
  assert(depois.pedidoStatusPag === 'pendente', 'pedido virou ' + depois.pedidoStatusPag);
  assert(depois.crStatus === 'aberta', 'CR virou ' + depois.crStatus);
  assert(depois.boletoStatus === 'registrado', 'boleto virou ' + depois.boletoStatus);
  assert(depois.contasPagar === antes.contasPagar, 'criou conta a pagar (tarifa) numa tentativa inválida');
  db.close();
});

/* ═════════════ D. isolamento entre tenants ═════════════ */

t('D1. cobrança do tenant A não é baixada pelo webhook do tenant B', async () => {
  const dbA = montar(); const appA = montarApp(dbA);
  const rA = await appA.chamar('POST', FINALIZAR, corpo());
  const pedA = pedidoPor(dbA, rA.body.numero);
  const idA = ultimoPayId();

  const dbB = montar(); const appB = montarApp(dbB);
  const rB = await appB.chamar('POST', FINALIZAR, corpo());
  const pedB = pedidoPor(dbB, rB.body.numero);

  const antesA = retrato(dbA, pedA.id);
  const antesB = retrato(dbB, pedB.id);
  /* O webhook do tenant B, com o segredo de B (que aqui é o mesmo texto, o
     pior caso), mandando o `pay_id` de A. O banco é o de B, e lá aquela
     cobrança não existe. */
  await aviso(dbB, idA, SEGREDO);
  assert(JSON.stringify(retrato(dbA, pedA.id)) === JSON.stringify(antesA), 'o tenant A foi tocado pelo webhook de B');
  assert(JSON.stringify(retrato(dbB, pedB.id)) === JSON.stringify(antesB), 'o tenant B baixou cobrança que não é dele');
  dbA.close(); dbB.close();
});

t('D2. e com o segredo de A no webhook de B também não', async () => {
  const dbA = montar({ segredo: 'segredo-do-tenant-A-xxxxxxxxxxxx' }); const appA = montarApp(dbA);
  const rA = await appA.chamar('POST', FINALIZAR, corpo());
  const idA = ultimoPayId();
  const pedA = pedidoPor(dbA, rA.body.numero);
  const dbB = montar({ segredo: 'segredo-do-tenant-B-yyyyyyyyyyyy' });
  const antesA = retrato(dbA, pedA.id);
  await aviso(dbB, idA, 'segredo-do-tenant-A-xxxxxxxxxxxx');
  assert(JSON.stringify(retrato(dbA, pedA.id)) === JSON.stringify(antesA), 'o segredo de A moveu algo em A pelo webhook de B');
  dbA.close(); dbB.close();
});

/* ═════════════ E. a resposta não serve para enumerar ═════════════ */

t('E1. a resposta é a MESMA em todos os caminhos', async () => {
  const db = montar(); const app = montarApp(db);
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const id = ultimoPayId();
  const respostas = [
    await aviso(db, id, undefined),                  // sem header
    await aviso(db, id, 'errado'),                   // token errado
    await aviso(db, 'pay_999999', SEGREDO),          // token certo, cobrança inexistente
    await aviso(db, id, SEGREDO),                    // token certo, cobrança existente (aplica)
    await aviso(db, id, SEGREDO),                    // reentrega da aplicada
  ];
  const sem = require('../boleto-orchestrator');
  const desconhecido = await sem.processarWebhook(db, 'provedor-que-nao-existe', { body: {}, headers: {}, get: () => undefined });
  respostas.push(desconhecido);
  const forma = respostas.map((x) => JSON.stringify(x));
  assert(forma.every((f) => f === '{}'),
    'as respostas diferem entre si e viram oráculo de pay_id: ' + forma.join(' | '));
  db.close();
});

t('E2. a resposta não carrega id interno nenhum', async () => {
  const db = montar(); const app = montarApp(db);
  await app.chamar('POST', FINALIZAR, corpo());
  const r = await aviso(db, ultimoPayId(), SEGREDO);
  const bruto = JSON.stringify(r);
  for (const proibido of ['contaReceberId', 'boletoId', 'pay_', 'aplicado', 'skipped', 'evento']) {
    assert(!bruto.includes(proibido), `a resposta do webhook contém "${proibido}": ${bruto}`);
  }
  db.close();
});

t('E3. nenhum segredo aparece na resposta', async () => {
  const db = montar(); const app = montarApp(db);
  await app.chamar('POST', FINALIZAR, corpo());
  for (const tok of [undefined, 'errado', SEGREDO]) {
    const bruto = JSON.stringify(await aviso(db, ultimoPayId(), tok));
    assert(!bruto.includes(SEGREDO) && !bruto.includes('aact'), 'segredo na resposta: ' + bruto);
  }
  db.close();
});

/* ═════════════ F. habilitação dos métodos online ═════════════ */

t('F1. sem segredo, os meios online NÃO são provedor pronto', async () => {
  const db = montar({ segredo: null });
  const met = require('../loja-metodos-pagamento');
  assert(met.provedorPronto(db, 'pix_online') === false, 'pix_online ficou pronto sem segredo');
  assert(met.provedorPronto(db, 'boleto_online') === false, 'boleto_online ficou pronto sem segredo');
  db.close();
});

t('F2. com segredo, os dois ficam prontos', async () => {
  const db = montar();
  const met = require('../loja-metodos-pagamento');
  assert(met.provedorPronto(db, 'pix_online') === true, 'pix_online não ficou pronto');
  assert(met.provedorPronto(db, 'boleto_online') === true, 'boleto_online não ficou pronto');
  db.close();
});

t('F3. a API recusa ATIVAR pix_online sem a autenticação configurada', async () => {
  const db = montar({ segredo: null, modo: 'nenhum' }); const app = montarApp(db);
  const r = await app.chamar('PUT', '/api/loja/metodos-pagamento',
    { metodos: [{ metodo: 'pix_online', ativo: true, entrega: false, retirada: true }] });
  assert(r.status === 422, 'status: ' + r.status);
  assert(/webhook/i.test(r.body.error || ''), 'mensagem: ' + r.body.error);
  assert(Number(db.prepare("SELECT ativo FROM loja_metodos_pagamento WHERE metodo='pix_online'").get().ativo) === 0,
    'gravou pix_online ativo mesmo recusando');
  db.close();
});

t('F4. a API recusa ATIVAR boleto_online sem a autenticação configurada', async () => {
  const db = montar({ segredo: null, modo: 'nenhum' }); const app = montarApp(db);
  const r = await app.chamar('PUT', '/api/loja/metodos-pagamento',
    { metodos: [{ metodo: 'boleto_online', ativo: true, entrega: false, retirada: true }] });
  assert(r.status === 422, 'status: ' + r.status);
  assert(/webhook/i.test(r.body.error || ''), 'mensagem: ' + r.body.error);
  assert(Number(db.prepare("SELECT ativo FROM loja_metodos_pagamento WHERE metodo='boleto_online'").get().ativo) === 0,
    'gravou boleto_online ativo mesmo recusando');
  db.close();
});

t('F5. a recusa NÃO grava nada da requisição, nem os métodos válidos dela', async () => {
  const db = montar({ segredo: null, modo: 'nenhum' }); const app = montarApp(db);
  /* A migração do legado liga os manuais, e `dinheiro` já nasceria ativo: o
     que este caso mede é o EFEITO da requisição recusada, então o estado
     anterior precisa ser o oposto do que ela pediria. */
  db.prepare('UPDATE loja_metodos_pagamento SET ativo = 0').run();
  const r = await app.chamar('PUT', '/api/loja/metodos-pagamento', { metodos: [
    { metodo: 'dinheiro', ativo: true, entrega: false, retirada: true },
    { metodo: 'boleto_online', ativo: true, entrega: false, retirada: true },
  ] });
  assert(r.status === 422, 'status: ' + r.status);
  const d = db.prepare("SELECT ativo FROM loja_metodos_pagamento WHERE metodo='dinheiro'").get();
  assert(Number(d.ativo) === 0, 'gravou metade da tela: dinheiro ficou ativo numa requisição recusada');
  db.close();
});

t('F6. com segredo, ativar os dois é aceito', async () => {
  const db = montar(); const app = montarApp(db);
  const r = await app.chamar('PUT', '/api/loja/metodos-pagamento', { metodos: [
    { metodo: 'pix_online', ativo: true, entrega: false, retirada: true },
    { metodo: 'boleto_online', ativo: true, entrega: false, retirada: true },
  ] });
  assert(r.status === 200 && r.body.success, JSON.stringify(r.body));
  const ativos = db.prepare("SELECT COUNT(*) n FROM loja_metodos_pagamento WHERE ativo=1 AND metodo LIKE '%_online'").get().n;
  assert(ativos === 2, 'ativos: ' + ativos);
  db.close();
});

t('F7. a mensagem distingue "falta provedor" de "falta autenticação", e não vaza nada', async () => {
  const met = require('../loja-metodos-pagamento');
  const semProvedor = montar({ provedor: false });
  const semSegredo = montar({ segredo: null });
  const mSem = met.motivoIndisponivel(semProvedor, 'boleto_online');
  const mTok = met.motivoIndisponivel(semSegredo, 'boleto_online');
  assert(mSem && /provedor de cobran/i.test(mSem), 'sem provedor: ' + mSem);
  assert(mTok && /webhook/i.test(mTok), 'sem segredo: ' + mTok);
  assert(mSem !== mTok, 'as duas mensagens são iguais');
  for (const m of [mSem, mTok]) {
    assert(!/token|webhookToken|aact|configJson|undefined|null/i.test(m.replace(/webhook/ig, '')),
      'a mensagem carrega nome interno: ' + m);
  }
  // E a listagem leva o motivo à tela, sem segredo junto.
  const lista = met.listar(semSegredo);
  const linha = lista.find((x) => x.metodo === 'boleto_online');
  assert(linha && linha.provedorPronto === false && /webhook/i.test(linha.motivo || ''), JSON.stringify(linha));
  assert(!JSON.stringify(lista).includes('aact'), 'a listagem vaza credencial');
  /* A tela mostra o motivo numa pílula arredondada, do tamanho de "Em breve".
     A frase inteira da API ali esticaria a linha e empurraria as caixas de
     marcação — por isso são dois textos, e este limite é o que guarda a
     diferença. 40 é a folga do maior rótulo que cabe sem quebrar. */
  assert(linha.motivo.length <= 40, `a etiqueta ficou longa demais para a pílula (${linha.motivo.length}): ${linha.motivo}`);
  assert(mTok.length > linha.motivo.length, 'a mensagem da API devia ser a frase inteira, não a etiqueta');
  semProvedor.close(); semSegredo.close();
});

t('F9. método JÁ ativo no banco some do checkout quando o segredo falta', async () => {
  /* O cenário dos tenants reais, e o que a recusa na API sozinha não cobre:
     `pix_online` e `boleto_online` já estão `ativo = 1` na tabela desde a
     migração do legado. Se o segredo sumir depois — alguém apaga no cadastro,
     ou a conta é trocada — a LINHA continua ativa.
     Quem fecha a porta é `disponiveis`, em tempo de requisição: a tabela diz
     o que o lojista quer, e o provedor pronto diz o que pode. Sem isto o
     consumidor escolheria um meio cuja baixa não pode ser confiada. */
  const db = montar({ modo: 'pix-ou-boleto' }); const app = montarApp(db);
  const met = require('../loja-metodos-pagamento');
  const cfg = db.prepare('SELECT * FROM loja_config WHERE id = 1').get();
  assert(met.disponiveis(db, 'retirada', cfg).some((m) => m.metodo === 'boleto_online'),
    'com segredo o boleto devia estar disponível');

  db.prepare('UPDATE contas_financeiras_boleto SET configJson = ?')
    .run(JSON.stringify({ accessToken: '$aact_hmlg_teste' }));

  assert(Number(db.prepare("SELECT ativo FROM loja_metodos_pagamento WHERE metodo='boleto_online'").get().ativo) === 1,
    'o cenário exige a linha ainda ativa');
  const abertos = met.disponiveis(db, 'retirada', cfg).map((m) => m.metodo);
  assert(!abertos.includes('boleto_online') && !abertos.includes('pix_online'),
    'meio online continuou aberto ao consumidor sem segredo: ' + abertos.join(','));

  // E o checkout recusa, mesmo que o navegador insista.
  const r = await app.chamar('POST', FINALIZAR, corpo());
  assert(r.status === 422, 'o checkout aceitou boleto sem segredo: ' + JSON.stringify(r.body));
  assert(db.prepare("SELECT COUNT(*) n FROM pedidos WHERE tipo='catalogo'").get().n === 0, 'criou pedido');
  db.close();
});

t('F8. cartao_online continua indisponível, com ou sem segredo', async () => {
  for (const segredo of [SEGREDO, null]) {
    const db = montar({ segredo }); const app = montarApp(db);
    const r = await app.chamar('PUT', '/api/loja/metodos-pagamento',
      { metodos: [{ metodo: 'cartao_online', ativo: true, entrega: true, retirada: true }] });
    assert(Number(db.prepare("SELECT ativo FROM loja_metodos_pagamento WHERE metodo='cartao_online'").get().ativo) === 0,
      'cartao_online ficou ativo (segredo=' + segredo + '), status ' + r.status);
    db.close();
  }
});

/* ═════════════ G. o que NÃO pode ter sido quebrado ═════════════ */

t('G1. com segredo, o PIX continua emitindo', async () => {
  const db = montar({ modo: 'pix' }); const app = montarApp(db);
  const r = await app.chamar('POST', FINALIZAR, corpo({ metodo: 'pix_online' }));
  assert(r.status === 200 && r.body.success, JSON.stringify(r.body));
  const c = r.body.cobranca.cobranca;
  assert(c && c.tipo === 'pix' && c.copiaECola && c.qr, JSON.stringify(c));
  db.close();
});

t('G2. com segredo, o BOLETO continua emitindo (Fase 1 intacta)', async () => {
  const db = montar({ modo: 'boleto' }); const app = montarApp(db);
  const r = await app.chamar('POST', FINALIZAR, corpo());
  assert(r.status === 200 && r.body.success, JSON.stringify(r.body));
  const c = r.body.cobranca.cobranca;
  assert(c && c.tipo === 'boleto' && c.linhaDigitavel === LINHA && c.url, JSON.stringify(c));
  const ped = pedidoPor(db, r.body.numero);
  assert(crDo(db, ped.id), 'sem conta a receber');
  db.close();
});

t('G3. o POLLING continua baixando, inclusive sem segredo de webhook', async () => {
  /* A exigência é sobre requisição que CHEGA. Quando somos NÓS que batemos no
     provedor, com a credencial da conta, não há o que autenticar do outro
     lado — e é justamente o polling que segura a baixa de quem ainda não
     configurou o webhook. Quebrá-lo deixaria a venda sem baixa nenhuma. */
  const db = montar(); const app = montarApp(db);
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  const id = ultimoPayId();
  // Agora a conta perde o segredo, e a cobrança é paga no provedor.
  db.prepare('UPDATE contas_financeiras_boleto SET configJson = ?')
    .run(JSON.stringify({ accessToken: '$aact_hmlg_teste' }));
  ASAAS.pagamentos.get(id).status = 'RECEIVED';
  ASAAS.pagamentos.get(id).paymentDate = '2026-10-07';

  // O mesmo caminho do polling: consultar no provedor e baixar pelo resultado.
  const orq = require('../boleto-orchestrator');
  const b = db.prepare("SELECT id, nossoNumero, contaReceberId, contaFinanceiraId FROM boletos WHERE nossoNumero = ?").get(id);
  const consulta = await orq.consultarBoleto(db, b.id);
  assert(String(consulta.situacao).toUpperCase() === 'RECEIVED', 'a consulta ao provedor quebrou: ' + JSON.stringify(consulta));
  require('../contas-receber-routes').registrarBaixaCR(db, {
    contaReceberId: b.contaReceberId, dataPagamento: consulta.dataPagamento,
    contaFinanceiraId: b.contaFinanceiraId, formaPagamento: 'boleto', origem: 'polling_asaas',
  });
  assert(retrato(db, ped.id).pedidoStatusPag === 'pago', 'o polling não conseguiu baixar');
  db.close();
});

t('G4. a emissão NÃO exige segredo de webhook pelo caminho do ERP', async () => {
  /* A conta sem segredo continua emitindo boleto pelo financeiro: é o caso do
     tenant que usa o ERP e não vende pelo catálogo. Fechar isso derrubaria
     cobrança em produção sem necessidade — a exigência é do pagamento ONLINE. */
  const db = montar({ segredo: null });
  const pessoaId = db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, telefone, ativo)
    VALUES (?, 'PF', 'CLIENTE DO ERP', '94999887766', 1)`).run(CPF).lastInsertRowid;
  const crId = db.prepare(`INSERT INTO contas_a_receber
      (pessoaId, descricao, valor, valorPago, dataEmissao, dataVencimento, status, origem)
    VALUES (?, 'Venda do balcão', 100, 0, date('now'), date('now','+3 days'), 'aberta', 'manual')`)
    .run(pessoaId).lastInsertRowid;
  const r = await require('../boleto-orchestrator').emitirBoletoParaCR(db, crId);
  assert(r && r.sucesso, 'a emissão pelo ERP foi bloqueada: ' + JSON.stringify(r));
  assert(r.linhaDigitavel === LINHA, 'linha: ' + r.linhaDigitavel);
  db.close();
});

/* ───────────── execução ───────────── */
(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); ok++; console.log('  ok   ' + nome); }
    catch (e) { fail++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
