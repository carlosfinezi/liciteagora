/**
 * Prova do Pix da loja contra o SANDBOX do Asaas, de verdade (29/09/2026).
 *
 * A suíte test-montagem-pix usa um Asaas falso. Este script faz o mesmo
 * caminho contra a API de testes do Asaas, sem dinheiro de verdade:
 *
 *   ASAAS_SANDBOX_KEY='$aact_hmlg_...' node scripts/provar-asaas-sandbox.js [tenant]
 *
 * O que ele faz, sempre numa CÓPIA do banco do tenant (o de produção só é lido):
 *   1. liga uma conta Asaas em homologação na cópia, com a chave informada;
 *   2. fecha um pedido de retirada pelo checkout público, e o Pix nasce;
 *   3. confirma o pagamento no sandbox (endpoint de simulação do Asaas);
 *   4. manda à rota do webhook o aviso com os dados que o Asaas devolve;
 *   5. confere que o pedido ficou pago.
 *
 * Recusa chave de produção: o prefixo tem de ser $aact_hmlg_.
 */
const Database = require('better-sqlite3');
const crypto = require('crypto');

const CHAVE = process.env.ASAAS_SANDBOX_KEY || '';
const TENANT = process.argv[2] || 'cantinhoverde';
const BASE = 'https://api-sandbox.asaas.com/v3';

async function asaas(metodo, caminho, corpo) {
  const r = await fetch(BASE + caminho, { method: metodo,
    headers: { access_token: CHAVE, 'Content-Type': 'application/json', 'User-Agent': 'liciteagora/1.0' },
    body: corpo ? JSON.stringify(corpo) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, corpo: j };
}

(async () => {
  if (!CHAVE.startsWith('$aact_hmlg_')) {
    console.error('Informe ASAAS_SANDBOX_KEY com uma chave de SANDBOX ($aact_hmlg_...).');
    process.exit(2);
  }
  const { copiaDoTenant } = require('./banco-de-teste');
  const db = new Database(copiaDoTenant(TENANT));
  require('../db-schema').initSchema(db);

  const conta = db.prepare("INSERT INTO contas_financeiras (nome, tipo) VALUES ('Asaas sandbox (prova)', 'banco')").run().lastInsertRowid;
  db.prepare('UPDATE contas_financeiras_boleto SET ativo = 0').run();
  db.prepare(`INSERT INTO contas_financeiras_boleto (contaFinanceiraId, provedor, ambiente, ativo, ehPadrao, configJson)
    VALUES (?, 'asaas', 'homologacao', 1, 1, ?)`).run(conta, JSON.stringify({ accessToken: CHAVE }));
  db.prepare("UPDATE loja_config SET pagamentoModo = 'pix', servicoRetirada = 1 WHERE id = 1").run();
  // Sem natureza o checkout recusa todo pedido. Na cópia, usa uma de venda.
  const nat = db.prepare(`SELECT id FROM tipos_operacao WHERE ativo = 1 AND usarEmPedido = 1
    AND categoriaOperacao = 'venda' AND movimentaEstoque = 1 AND geraFinanceiro = 1 ORDER BY emiteNFe, id LIMIT 1`).get();
  db.prepare('UPDATE loja_config SET tipoOperacaoPedidoId = COALESCE(tipoOperacaoPedidoId, ?) WHERE id = 1').run(nat && nat.id);

  // As rotas, sem servidor HTTP: o mesmo handler que a produção usa.
  const rotas = new Map();
  const reg = (m) => (url, ...fns) => rotas.set(m + ' ' + url, fns[fns.length - 1]);
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), use() {} };
  require('../pedidos-routes').registrarRotasPedidos(app, db);
  require('../loja-routes').registrarRotasLojaPublica(app, db);
  require('../loja-routes').registrarRotasLojaAdmin(app, db);
  const chamar = async (m, url, body, params) => {
    let saida = null, status = 200;
    const res = { json: (d) => { saida = d; return res; }, status: (s) => { status = s; return res; }, set() { return res; } };
    await rotas.get(m + ' ' + url)({ body, params: params || {}, query: {}, session: {}, headers: {}, get: () => '' }, res);
    return { status, body: saida };
  };

  // Um item qualquer da vitrine: o primeiro montável, ou o primeiro produto com preço.
  const mont = (await chamar('GET', '/loja/api/montagem')).body.montaveis || [];
  let item;
  if (mont.length) {
    const m = mont[0]; const f = m.formatos[0];
    const cor = m.cores.find((c) => c.quantidades.includes(f.precos[0].quantidade));
    item = { produtoId: m.produtoId, quantidade: 1, montagem: { formatoId: f.id, quantidade: f.precos[0].quantidade, corId: cor && cor.id } };
  } else {
    const p = (await chamar('GET', '/loja/api/produtos')).body.produtos.find((x) => x.preco > 0);
    item = { produtoId: p.id, quantidade: 1 };
  }
  const fim = await chamar('POST', '/loja/api/pedido/finalizar', {
    idempotencyKey: crypto.randomUUID(), atendimento: 'retirada', pagamento: 'pix', itens: [item],
    cliente: { nome: 'Prova Sandbox', telefone: '94999990000', cpfCnpj: '52998224725' } });
  if (!fim.body || !fim.body.success || !fim.body.cobranca || !fim.body.cobranca.pix) {
    console.error('1-2 FALHOU: o Pix não nasceu no checkout:', JSON.stringify(fim.body));
    process.exit(1);
  }
  const b = db.prepare("SELECT nossoNumero FROM boletos WHERE tipoCobranca = 'pix' ORDER BY id DESC LIMIT 1").get();
  console.log(`1-2 ok: pedido ${fim.body.numero}, Pix ${b.nossoNumero} de R$ ${fim.body.cobranca.pix.valor}, copia e cola com ${String(fim.body.cobranca.pix.copiaECola || '').length} caracteres`);

  // 3. Simula o pagamento. O Asaas tem um endpoint de confirmação só do sandbox.
  let conf = await asaas('POST', `/sandbox/payment/${b.nossoNumero}/confirm`);
  if (conf.status >= 300) conf = await asaas('POST', `/payments/${b.nossoNumero}/receiveInCash`,
    { paymentDate: new Date().toISOString().slice(0, 10), value: fim.body.cobranca.pix.valor, notifyCustomer: false });
  console.log(`3   confirmação no sandbox: HTTP ${conf.status}`);
  const pay = (await asaas('GET', `/payments/${b.nossoNumero}`)).corpo;
  console.log(`    situação no Asaas: ${pay.status}`);

  // 4. O aviso, como o Asaas manda à rota /webhook/boleto/asaas.
  const evento = ['RECEIVED', 'CONFIRMED'].includes(pay.status) ? 'PAYMENT_RECEIVED' : 'PAYMENT_' + pay.status;
  const w = await require('../boleto-orchestrator').processarWebhook(db, 'asaas',
    { body: { event: evento, payment: pay }, headers: {}, get: () => undefined });
  const ped = db.prepare('SELECT statusPagamento FROM pedidos WHERE numero = ?').get(fim.body.numero);
  console.log(`4-5 webhook ${evento}: ${w.aplicado ? 'aplicado' : 'ignorado'}; pedido ${ped.statusPagamento}`);
  if (ped.statusPagamento !== 'pago') {
    console.error('FALHOU: o pedido não ficou pago.');
    process.exit(1);
  }
  console.log('PROVA OK: Pix gerado no sandbox, pago e baixado no pedido.');
  process.exit(0);
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
