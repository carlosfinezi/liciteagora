/**
 * loja-pagamento.js — Pix do pedido da loja, pelo provedor de cobrança do ERP.
 *
 * Não existe um caminho de pagamento paralelo: o Pix é uma conta a receber
 * amarrada ao pedido (`contas_a_receber.pedidoId`, origem 'loja'), emitida pelo
 * boleto-orchestrator (Asaas), e a baixa vem pelo webhook e pelo polling que já
 * existem. Quando a conta a receber é baixada, `sincronizarPagamentoPedido`
 * leva `statusPagamento = 'pago'` ao pedido. É isso que faz o pedido "virar
 * pago sozinho".
 *
 * Duas situações:
 *   - o total é conhecido no checkout (retirada, ou entrega com taxa fixa, por
 *     bairro ou grátis): o Pix nasce logo depois do pedido e o cliente paga na
 *     tela de confirmação;
 *   - entrega com taxa a combinar: o pedido entra sem cobrança, e o Pix nasce
 *     quando a loja lança a taxa na tela do pedido.
 *
 * O link que o cliente recebe é `/loja/#/pagar/<token>`. O token é daqui, e não
 * o `pedidos.tokenPublico`: aquele abre o orçamento público, com os dados do
 * cliente, e um link de pagamento repassado não pode carregar isso.
 */

const crypto = require('crypto');

const MODOS_PIX = ['pix', 'pix-ou-boleto'];
const r2c = (v) => Math.round((Number(v) || 0) * 100) / 100;

function migrarPagamento(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loja_pagamentos (
      pedidoId INTEGER PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      freteACombinar INTEGER NOT NULL DEFAULT 0,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/** A loja cobra por Pix no fechamento do pedido público? */
const pixNoCheckout = (cfg) => MODOS_PIX.includes(cfg && cfg.pagamentoModo);

/**
 * Há provedor capaz de gerar Pix? Sem isto o pedido entra sem cobrança e a loja
 * combina com o cliente, em vez de nascer uma conta a receber que ninguém emite.
 */
function provedorPixPronto(db) {
  try {
    const orq = require('./boleto-orchestrator');
    const conta = orq.getContaFinanceiraPadraoBoleto(db);
    if (!conta) return false;
    const r = orq._internal.getProvedorConfig(db, conta);
    return !!(r && typeof r.modulo.criarPix === 'function');
  } catch { return false; }
}

/** Registra o pedido da loja e devolve o token do link de pagamento. Roda na transação do pedido. */
function registrarPedido(db, pedidoId, { freteACombinar = false } = {}) {
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO loja_pagamentos (pedidoId, token, freteACombinar) VALUES (?, ?, ?)')
    .run(pedidoId, token, freteACombinar ? 1 : 0);
  return token;
}

const linhaDoPedido = (db, pedidoId) => {
  try { return db.prepare('SELECT * FROM loja_pagamentos WHERE pedidoId = ?').get(pedidoId) || null; }
  catch { return null; }
};

const crDoPedido = (db, pedidoId) => db.prepare(`SELECT id, status, valor, valorPago, dataVencimento, dataPagamento
  FROM contas_a_receber WHERE pedidoId = ? AND origem = 'loja' AND status != 'cancelada'
  ORDER BY id DESC LIMIT 1`).get(pedidoId) || null;

const cobrancaDaCR = (db, crId) => {
  try {
    return db.prepare(`SELECT id, tipoCobranca, pixPayload, pixQrImage, externalUrl, status, nossoNumero
      FROM boletos WHERE contaReceberId = ? ORDER BY id DESC LIMIT 1`).get(crId) || null;
  } catch { return null; }
};

/**
 * O estado do pagamento, sem dado pessoal: é o que a página pública mostra a
 * quem tem o link. Nome, telefone e endereço ficam de fora.
 */
function estadoDoPedido(db, pedidoId) {
  const p = db.prepare(`SELECT id, numero, status, valorTotal, valorFrete, valorPago, statusPagamento,
      tipoAtendimento FROM pedidos WHERE id = ?`).get(pedidoId);
  if (!p) return null;
  const lp = linhaDoPedido(db, pedidoId);
  const cr = crDoPedido(db, pedidoId);
  const b = cr ? cobrancaDaCR(db, cr.id) : null;
  return {
    numero: p.numero,
    total: r2c(p.valorTotal),
    frete: r2c(p.valorFrete),
    atendimento: p.tipoAtendimento || null,
    aCombinar: !!(lp && lp.freteACombinar),
    cancelado: p.status === 'cancelado',
    pago: p.statusPagamento === 'pago',
    pagoEm: p.statusPagamento === 'pago' && cr ? (cr.dataPagamento || null) : null,
    pix: b && b.tipoCobranca === 'pix' && cr ? {
      copiaECola: b.pixPayload || null,
      qr: b.pixQrImage || null,
      url: b.externalUrl || null,
      valor: r2c(cr.valor),
      vencimento: cr.dataVencimento,
    } : null,
  };
}

function documentoDoCliente(db, pedidoId) {
  const r = db.prepare(`SELECT pe.cpfCnpj, pe.semDocumento FROM pedidos p
    JOIN pessoas pe ON pe.id = p.clienteId WHERE p.id = ?`).get(pedidoId);
  if (!r || Number(r.semDocumento) === 1) return null;
  const d = String(r.cpfCnpj || '').replace(/\D/g, '');
  return d.length === 11 || d.length === 14 ? d : null;
}

const somaDias = (n) => new Date(Date.now() - 3 * 3600 * 1000 + (Number(n) || 0) * 86400000)
  .toISOString().slice(0, 10);

/**
 * Cancela o Pix aberto do pedido, para outro valor tomar o lugar.
 *
 * Antes de cancelar pergunta ao provedor se ele já foi pago: o cliente pode ter
 * pagado segundos antes de a loja mudar a taxa, e cancelar um Pix pago deixaria
 * o dinheiro entrado sem conta a receber para baixar.
 */
async function cancelarPixAberto(db, cr) {
  const orq = require('./boleto-orchestrator');
  const b = cobrancaDaCR(db, cr.id);
  if (b && b.status === 'registrado') {
    const r = await orq.consultarBoleto(db, b.id);
    const sit = String((r && (r.situacao || r.status)) || '').toUpperCase();
    if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'PAGO'].includes(sit)) {
      const e = new Error('O Pix anterior já foi pago. A baixa entra em instantes.');
      e.status = 409;
      throw e;
    }
    try { await orq.baixarBoleto(db, b.id, 'Substituído por novo valor'); }
    catch (e) { console.warn(`[loja-pix] cancelar cobrança #${b.id} no provedor falhou:`, e.message); }
    db.prepare("UPDATE boletos SET status = 'baixado', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(b.id);
  }
  db.prepare("UPDATE contas_a_receber SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(cr.id);
}

/**
 * Gera (ou devolve) o Pix do saldo do pedido.
 *
 * Idempotente: se já existe Pix aberto no valor certo, devolve o mesmo, e é
 * isso que deixa o cliente recarregar a página sem criar cobrança nova. Se o
 * valor mudou (a loja lançou ou corrigiu a taxa), o antigo é cancelado antes.
 */
async function emitirPixDoPedido(db, pedidoId, { vencimentoDias = 1 } = {}) {
  const falha = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  const p = db.prepare('SELECT id, numero, status, clienteId, valorTotal, statusPagamento FROM pedidos WHERE id = ?').get(pedidoId);
  if (!p) throw falha(404, 'Pedido não encontrado.');
  if (p.status === 'cancelado') throw falha(409, 'O pedido está cancelado.');
  if (p.status === 'rascunho') throw falha(409, 'Confirme o pedido antes de cobrar.');
  if (p.statusPagamento === 'pago') throw falha(409, 'O pedido já está pago.');
  const lp = linhaDoPedido(db, pedidoId);
  if (lp && lp.freteACombinar) throw falha(422, 'Lance a taxa de entrega antes de gerar o Pix.');
  if (!provedorPixPronto(db)) throw falha(409, 'Nenhuma conta de cobrança com Pix está ativa. Configure o Asaas em Financeiro › Contas financeiras.');
  if (!documentoDoCliente(db, pedidoId)) throw falha(422, 'O Pix exige o CPF ou CNPJ do cliente. Complete a ficha do cliente e tente de novo.');

  const recebido = Number(db.prepare(`SELECT COALESCE(SUM(valorPago), 0) t FROM contas_a_receber
    WHERE pedidoId = ? AND status != 'cancelada'`).get(pedidoId).t) || 0;
  const valor = r2c(p.valorTotal - recebido);
  if (!(valor > 0)) throw falha(409, 'Não há valor a cobrar neste pedido.');

  let cr = crDoPedido(db, pedidoId);
  if (cr && cr.status !== 'paga') {
    const b = cobrancaDaCR(db, cr.id);
    const mesmaConta = Math.abs(r2c(cr.valor) - valor) < 0.005 && Number(cr.valorPago || 0) === 0;
    if (mesmaConta && b && b.tipoCobranca === 'pix' && b.status === 'registrado') return estadoDoPedido(db, pedidoId);
    if (!mesmaConta || (b && b.status !== 'registrado')) { await cancelarPixAberto(db, cr); cr = null; }
  } else cr = null;

  if (!cr) {
    const id = db.prepare(`INSERT INTO contas_a_receber
        (pessoaId, descricao, valor, valorPago, dataEmissao, dataVencimento, status, origem,
         origemTipo, pedidoId, formaPagamento, dataAtualizacao)
      VALUES (?, ?, ?, 0, ?, ?, 'aberta', 'loja', 'pedido', ?, '17', CURRENT_TIMESTAMP)`)
      .run(p.clienteId, `Pedido ${p.numero} — loja virtual`, valor, somaDias(0),
           somaDias(vencimentoDias), pedidoId).lastInsertRowid;
    cr = { id };
  }
  const r = await require('./boleto-orchestrator').emitirCobrancaPixParaCR(db, cr.id);
  if (r && r.skipped) throw falha(409, r.motivo || 'O provedor de cobrança não gerou o Pix.');
  return estadoDoPedido(db, pedidoId);
}

/** Tira a marca de "a combinar" e grava a taxa no pedido, recalculando o total. */
function lancarTaxaDeEntrega(db, pedidoId, taxa) {
  const { recalcularTotal } = require('./pedidos-routes');
  db.transaction(() => {
    db.prepare('UPDATE pedidos SET valorFrete = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(r2c(taxa), pedidoId);
    recalcularTotal(db, pedidoId);
    db.prepare('UPDATE loja_pagamentos SET freteACombinar = 0 WHERE pedidoId = ?').run(pedidoId);
  })();
}

function registrarRotasPagamentoPublico(app, db) {
  // A página de pagamento: quem tem o link vê o valor, o QR e se já foi pago.
  app.get('/loja/api/pagamento/:token', (req, res) => {
    try {
      const token = String(req.params.token || '');
      if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return res.status(404).json({ success: false, error: 'Link de pagamento inválido.' });
      const lp = db.prepare('SELECT pedidoId FROM loja_pagamentos WHERE token = ?').get(token);
      if (!lp) return res.status(404).json({ success: false, error: 'Link de pagamento inválido.' });
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, pagamento: estadoDoPedido(db, lp.pedidoId) });
    } catch (e) {
      console.error('[loja] pagamento:', e.message);
      res.status(500).json({ success: false, error: 'Não foi possível carregar agora. Tente de novo em instantes.' });
    }
  });
}

function registrarRotasPagamentoAdmin(app, db) {
  const recusa = (res, e) => res.status(e.status || 500).json({ success: false, error: e.message });

  const dadosDoPedido = (id) => db.prepare(`SELECT p.id, p.numero, p.tipo, p.status, p.tipoAtendimento,
      p.telefoneEntrega, pe.razaoSocial AS cliente, pe.celular, pe.telefone
    FROM pedidos p LEFT JOIN pessoas pe ON pe.id = p.clienteId WHERE p.id = ?`).get(id);

  const resposta = (id) => {
    const p = dadosDoPedido(id);
    const lp = linhaDoPedido(db, id);
    return {
      success: true,
      loja: !!lp,
      token: lp ? lp.token : null,
      provedorPronto: provedorPixPronto(db),
      lojaNome: (() => { try { return (db.prepare('SELECT nome FROM loja_config WHERE id = 1').get() || {}).nome || null; } catch { return null; } })(),
      cliente: p ? { nome: p.cliente || null, telefone: p.telefoneEntrega || p.celular || p.telefone || null } : null,
      estado: estadoDoPedido(db, id),
    };
  };

  app.get('/api/pedidos/:id/pix', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!dadosDoPedido(id)) return res.status(404).json({ success: false, error: 'Pedido não encontrado.' });
      res.json(resposta(id));
    } catch (e) { recusa(res, e); }
  });

  /* Gera o Pix do pedido. Com `taxaEntrega`, grava a taxa antes (é o caso da
     entrega a combinar). Pedido de fora da loja ganha o registro aqui, para ter
     link de pagamento também. */
  app.post('/api/pedidos/:id/pix', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const p = dadosDoPedido(id);
      if (!p) return res.status(404).json({ success: false, error: 'Pedido não encontrado.' });
      const b = req.body || {};
      if (b.taxaEntrega != null && b.taxaEntrega !== '') {
        const taxa = Number(String(b.taxaEntrega).replace(',', '.'));
        if (!Number.isFinite(taxa) || taxa < 0 || taxa > 10000) return res.status(422).json({ success: false, error: 'Taxa de entrega inválida.' });
        if (p.status === 'cancelado') return res.status(409).json({ success: false, error: 'O pedido está cancelado.' });
        if (!linhaDoPedido(db, id)) registrarPedido(db, id);
        lancarTaxaDeEntrega(db, id, taxa);
      }
      if (!linhaDoPedido(db, id)) registrarPedido(db, id);
      const cfg = db.prepare('SELECT pagamentoVencimentoDias FROM loja_config WHERE id = 1').get() || {};
      await emitirPixDoPedido(db, id, { vencimentoDias: cfg.pagamentoVencimentoDias ?? 1 });
      res.json(resposta(id));
    } catch (e) {
      if (!e.status) console.error('[loja-pix] gerar Pix:', e.message);
      recusa(res, e);
    }
  });
}

module.exports = {
  migrarPagamento, pixNoCheckout, provedorPixPronto, registrarPedido,
  estadoDoPedido, emitirPixDoPedido, lancarTaxaDeEntrega, cancelarPixAberto,
  registrarRotasPagamentoPublico, registrarRotasPagamentoAdmin,
};
