/**
 * loja-pagamento.js — a cobrança online do pedido da loja, pelo provedor do ERP.
 *
 * Não existe um caminho de pagamento paralelo: a cobrança é uma conta a receber
 * amarrada ao pedido (`contas_a_receber.pedidoId`, origem 'loja'), emitida pelo
 * boleto-orchestrator (Asaas), e a baixa vem pelo webhook e pelo polling que já
 * existem. Quando a conta a receber é baixada, `sincronizarPagamentoPedido`
 * leva `statusPagamento = 'pago'` ao pedido. É isso que faz o pedido "virar
 * pago sozinho".
 *
 * Duas situações:
 *   - o total é conhecido no checkout (retirada, ou entrega com taxa fixa, por
 *     bairro ou grátis): a cobrança nasce logo depois do pedido e o cliente paga
 *     na tela de confirmação;
 *   - entrega com taxa a combinar: o pedido entra sem cobrança, e ela nasce
 *     quando a loja lança a taxa na tela do pedido.
 *
 * O link que o cliente recebe é `/loja/#/pagar/<token>`. O token é daqui, e não
 * o `pedidos.tokenPublico`: aquele abre o orçamento público, com os dados do
 * cliente, e um link de pagamento repassado não pode carregar isso.
 *
 * ── Por que o despacho é uma TABELA, e não um `if` por método ──────────────
 *
 * Até 07/10/2026 havia um `emitirPixDoPedido`, e o checkout emitia só quando o
 * método era `pix_online` — com `boleto_online` ativável e aparecendo ao
 * cliente, o pedido de boleto nascia sem conta a receber, sem cobrança e sem
 * link, e a tela ainda afirmava que o boleto tinha sido gerado. O defeito não
 * era a falta de um `||`: era o nome do meio estar escrito dentro da regra.
 *
 * Aqui o meio é DADO (`ONLINE`), e o que varia entre pix e boleto é só a função
 * do orquestrador e o `tipoCobranca` gravado. Todo o resto — reaproveitar a
 * cobrança aberta de mesmo valor, cancelar a de valor diferente, exigir
 * documento, somar o que já entrou, registrar o token — é igual nos dois, e
 * continua escrito uma vez só.
 */

const crypto = require('crypto');

/**
 * Os meios que se pagam NO SITE, e o que cada um muda.
 *
 * `emitir` é o nome do método do `boleto-orchestrator`, e não uma
 * reimplementação: quem fala com o provedor, grava em `boletos`, resolve a
 * conta financeira e aplica o split continua sendo ele.
 *
 * `tipo` é o que vai para `boletos.tipoCobranca`, e é por ele que a baixa sabe
 * se a forma de pagamento da CR é 'pix' ou 'boleto' (ver `processarWebhook` e
 * o polling), e que a tela pública sabe o que desenhar.
 *
 * O código fiscal NÃO está aqui: ele é do `loja-metodos-pagamento.CATALOGO`,
 * que é o vocabulário, e duplicá-lo criaria duas verdades sobre o tPag.
 */
const ONLINE = {
  pix_online:    { tipo: 'pix',    emitir: 'emitirCobrancaPixParaCR', rotulo: 'Pix' },
  boleto_online: { tipo: 'boleto', emitir: 'emitirBoletoParaCR',      rotulo: 'boleto' },
};

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

/* `pixNoCheckout(cfg)` morava aqui e respondia "a loja cobra por Pix?" lendo
   `loja_config.pagamentoModo`. Saiu em 30/09, quando quem passou a responder
   isso foi `loja-metodos-pagamento`: a pergunta deixou de ser da LOJA e passou
   a ser do PEDIDO, porque a mesma loja agora aceita Pix no site e dinheiro na
   entrega ao mesmo tempo. */

/**
 * Há provedor capaz de emitir este meio? Sem isto o pedido entra sem cobrança e
 * a loja combina com o cliente, em vez de nascer uma conta a receber que ninguém
 * emite.
 *
 * A pergunta é do `loja-metodos-pagamento`, que já a responde por MÉTODO e é o
 * mesmo que monta o checkout — um provedor pode gerar Pix e não gerar boleto.
 * Havia uma segunda implementação aqui, só para Pix, e duas leituras da mesma
 * pergunta é uma a mais para divergir.
 */
function provedorProntoPara(db, metodo) {
  try { return require('./loja-metodos-pagamento').provedorPronto(db, metodo); }
  catch { return false; }
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
    /* `linhaDigitavel` entrou com o boleto do checkout. A coluna existe desde o
       `migrarSchema` do orquestrador, e é a mesma que o boleto do ERP grava. */
    return db.prepare(`SELECT id, tipoCobranca, pixPayload, pixQrImage, linhaDigitavel,
        externalUrl, status, nossoNumero
      FROM boletos WHERE contaReceberId = ? ORDER BY id DESC LIMIT 1`).get(crId) || null;
  } catch { return null; }
};

/**
 * O estado do pagamento, sem dado pessoal: é o que a página pública mostra a
 * quem tem o link. Nome, telefone e endereço ficam de fora.
 *
 * ── Dois campos para a mesma cobrança, de propósito ────────────────────────
 *
 * `cobranca` é o campo novo e o que vale: ele diz o TIPO e carrega só o que
 * aquele tipo tem. `pix` continua sendo preenchido quando o tipo é pix, e isso
 * não é esquecimento — `public/loja/catalogo.js` e `public/comercial/pedido.html`
 * são arquivos estáticos, e no instante em que este código sobe existem abas
 * abertas lendo `p.pix`. Tirá-lo deixaria o cliente que está com o QR na tela
 * sem QR na próxima volta do polling, de 5 em 5 segundos.
 *
 * `pix` é derivado de `cobranca`, nunca montado em paralelo: uma fonte, duas
 * leituras. Quando não houver mais aba antiga, apagar o `pix` é remover três
 * linhas e nada mais.
 */
function estadoDoPedido(db, pedidoId) {
  const p = db.prepare(`SELECT id, numero, status, valorTotal, valorFrete, valorPago, statusPagamento,
      tipoAtendimento FROM pedidos WHERE id = ?`).get(pedidoId);
  if (!p) return null;
  const lp = linhaDoPedido(db, pedidoId);
  const cr = crDoPedido(db, pedidoId);
  const b = cr ? cobrancaDaCR(db, cr.id) : null;

  /* Cobrança 'baixada' é a que foi substituída por outro valor, e cobrança de
     tipo que este módulo não conhece não é desenhável. Nos dois casos a tela
     cai no "a loja vai combinar", que é a verdade. */
  const tipo = b && ['pix', 'boleto'].includes(b.tipoCobranca) ? b.tipoCobranca : null;
  const cobranca = tipo && cr ? {
    tipo,
    valor: r2c(cr.valor),
    vencimento: cr.dataVencimento,
    /* A URL do provedor: `invoiceUrl` no Pix, `bankSlipUrl` no boleto. É ela
       que abre o boleto, e não um PDF nosso — o provedor já serve o documento
       com a linha, o código de barras e o logo do banco. */
    url: b.externalUrl || null,
    ...(tipo === 'pix'
      ? { copiaECola: b.pixPayload || null, qr: b.pixQrImage || null }
      : { linhaDigitavel: b.linhaDigitavel || null }),
  } : null;

  return {
    numero: p.numero,
    total: r2c(p.valorTotal),
    frete: r2c(p.valorFrete),
    atendimento: p.tipoAtendimento || null,
    aCombinar: !!(lp && lp.freteACombinar),
    cancelado: p.status === 'cancelado',
    pago: p.statusPagamento === 'pago',
    pagoEm: p.statusPagamento === 'pago' && cr ? (cr.dataPagamento || null) : null,
    cobranca,
    // Compatibilidade com a aba aberta e com a tela do pedido no ERP. Ver acima.
    pix: cobranca && cobranca.tipo === 'pix' ? {
      copiaECola: cobranca.copiaECola,
      qr: cobranca.qr,
      url: cobranca.url,
      valor: cobranca.valor,
      vencimento: cobranca.vencimento,
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
 * Cancela a cobrança aberta do pedido, para outro valor tomar o lugar.
 *
 * Antes de cancelar pergunta ao provedor se ela já foi paga: o cliente pode ter
 * pagado segundos antes de a loja mudar a taxa, e cancelar uma cobrança paga
 * deixaria o dinheiro entrado sem conta a receber para baixar.
 */
async function cancelarCobrancaAberta(db, cr) {
  const orq = require('./boleto-orchestrator');
  const b = cobrancaDaCR(db, cr.id);
  if (b && b.status === 'registrado') {
    const r = await orq.consultarBoleto(db, b.id);
    const sit = String((r && (r.situacao || r.status)) || '').toUpperCase();
    if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'PAGO'].includes(sit)) {
      const e = new Error('A cobrança anterior já foi paga. A baixa entra em instantes.');
      e.status = 409;
      throw e;
    }
    try { await orq.baixarBoleto(db, b.id, 'Substituído por novo valor'); }
    catch (e) { console.warn(`[loja-cobranca] cancelar cobrança #${b.id} no provedor falhou:`, e.message); }
    db.prepare("UPDATE boletos SET status = 'baixado', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(b.id);
  }
  db.prepare("UPDATE contas_a_receber SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(cr.id);
}

/**
 * Gera (ou devolve) a cobrança online do saldo do pedido, no meio pedido.
 *
 * `metodo` é a chave de `loja_metodos_pagamento` ('pix_online', 'boleto_online'),
 * e é o ÚNICO lugar desta função que sabe de qual meio se trata — o resto vale
 * para os dois.
 *
 * Idempotente: se já existe cobrança aberta do MESMO TIPO no valor certo,
 * devolve a mesma, e é isso que deixa o cliente recarregar a página e o
 * checkout ser reenviado sem criar cobrança nova. Se o valor mudou (a loja
 * lançou ou corrigiu a taxa), ou se o meio pedido é outro, a anterior é
 * cancelada antes — e nunca há duas cobranças vivas para o mesmo pedido, que é
 * a condição que o faturamento recusa (`faturas-routes.js`, fail closed).
 */
async function emitirCobrancaDoPedido(db, pedidoId, metodo, { vencimentoDias = 1 } = {}) {
  const falha = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  const meio = ONLINE[metodo];
  /* Meio desconhecido é erro de programação, não de uso: nenhuma requisição
     chega aqui sem passar por `metodosLoja.validar`. Recusar com 409 em vez de
     emitir o meio errado é a diferença entre um pedido sem cobrança e um
     cliente pagando a coisa errada. */
  if (!meio) throw falha(409, 'Esta forma de pagamento não é cobrada pelo site.');

  const p = db.prepare('SELECT id, numero, status, clienteId, valorTotal, statusPagamento FROM pedidos WHERE id = ?').get(pedidoId);
  if (!p) throw falha(404, 'Pedido não encontrado.');
  if (p.status === 'cancelado') throw falha(409, 'O pedido está cancelado.');
  if (p.status === 'rascunho') throw falha(409, 'Confirme o pedido antes de cobrar.');
  if (p.statusPagamento === 'pago') throw falha(409, 'O pedido já está pago.');
  const lp = linhaDoPedido(db, pedidoId);
  if (lp && lp.freteACombinar) throw falha(422, `Lance a taxa de entrega antes de gerar o ${meio.rotulo}.`);
  if (!provedorProntoPara(db, metodo)) {
    throw falha(409, `Nenhuma conta de cobrança com ${meio.rotulo} está ativa. `
      + 'Configure o Asaas em Financeiro › Contas financeiras.');
  }
  /* Os dois meios exigem documento: o `emitirBoletoParaCR` o exige pelo
     `exigirDocumentoFiscal` e LANÇA, e o provedor recusa o Pix sem ele. Aqui a
     recusa sai com a mensagem que o lojista entende, antes da chamada de rede. */
  if (!documentoDoCliente(db, pedidoId)) {
    throw falha(422, `O ${meio.rotulo} exige o CPF ou CNPJ do cliente. `
      + 'Complete a ficha do cliente e tente de novo.');
  }

  const recebido = Number(db.prepare(`SELECT COALESCE(SUM(valorPago), 0) t FROM contas_a_receber
    WHERE pedidoId = ? AND status != 'cancelada'`).get(pedidoId).t) || 0;
  const valor = r2c(p.valorTotal - recebido);
  if (!(valor > 0)) throw falha(409, 'Não há valor a cobrar neste pedido.');

  let cr = crDoPedido(db, pedidoId);
  if (cr && cr.status !== 'paga') {
    const b = cobrancaDaCR(db, cr.id);
    const mesmaConta = Math.abs(r2c(cr.valor) - valor) < 0.005 && Number(cr.valorPago || 0) === 0;
    /* O TIPO entra na comparação: a CR aberta com um boleto registrado não
       serve a quem agora pede Pix, e devolvê-la mandaria o cliente para uma
       tela de QR que não existe. Trocar de meio cancela e reemite, pelo mesmo
       caminho de quem troca de valor. */
    const servivel = !!b && b.tipoCobranca === meio.tipo && b.status === 'registrado';
    if (mesmaConta && servivel) return estadoDoPedido(db, pedidoId);
    /* CR aberta no valor certo e SEM cobrança nenhuma: emitir sobre ela é o que
       recupera a falha de rede do provedor. Cancelá-la para criar outra deixaria
       uma CR cancelada por tentativa, e a condição `!b` tem de ser testada à
       parte justamente porque "sem cobrança" não é "cobrança de outro meio". */
    if (!(mesmaConta && !b)) {
      await cancelarCobrancaAberta(db, cr);
      cr = null;
    }
  } else cr = null;

  if (!cr) {
    /* O tPag sai do catálogo de métodos, que é a fonte única: 17 no Pix, 15 no
       boleto. Estava escrito '17' fixo aqui, e um boleto gravado como Pix
       sairia errado na conciliação por forma de pagamento e na nota. */
    const tPag = (require('./loja-metodos-pagamento').CATALOGO[metodo] || {}).meioFiscal || null;
    const id = db.prepare(`INSERT INTO contas_a_receber
        (pessoaId, descricao, valor, valorPago, dataEmissao, dataVencimento, status, origem,
         origemTipo, pedidoId, formaPagamento, dataAtualizacao)
      VALUES (?, ?, ?, 0, ?, ?, 'aberta', 'loja', 'pedido', ?, ?, CURRENT_TIMESTAMP)`)
      .run(p.clienteId, `Pedido ${p.numero} — loja virtual`, valor, somaDias(0),
           somaDias(vencimentoDias), pedidoId, tPag).lastInsertRowid;
    cr = { id };
  }
  /* Quem fala com o provedor é o orquestrador, pelo método que a tabela nomeia.
     Nada de emissão é reimplementado aqui: conta financeira, split, nosso
     número, gravação em `boletos` e bloqueio por meio da pessoa são dele. */
  const r = await require('./boleto-orchestrator')[meio.emitir](db, cr.id);
  if (r && r.skipped) throw falha(409, r.motivo || `O provedor de cobrança não gerou o ${meio.rotulo}.`);
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
      /* Esta rota é o botão "Gerar Pix" da tela do pedido no ERP, e continua
         sendo só do Pix nesta fase: o boleto do ERP se emite pela tela de
         contas a receber, que é onde ele sempre esteve. */
      provedorPronto: provedorProntoPara(db, 'pix_online'),
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
      await emitirCobrancaDoPedido(db, id, 'pix_online', { vencimentoDias: cfg.pagamentoVencimentoDias ?? 1 });
      res.json(resposta(id));
    } catch (e) {
      if (!e.status) console.error('[loja-pix] gerar Pix:', e.message);
      recusa(res, e);
    }
  });
}

module.exports = {
  ONLINE,
  migrarPagamento, provedorProntoPara, registrarPedido,
  estadoDoPedido, emitirCobrancaDoPedido, lancarTaxaDeEntrega, cancelarCobrancaAberta,
  registrarRotasPagamentoPublico, registrarRotasPagamentoAdmin,
};
