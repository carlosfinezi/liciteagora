/**
 * boleto-provedores/mercadopago.js — Provedor Mercado Pago (wrapper do cliente legado).
 *
 * Reusa `mercadopago-client.js` existente; apenas adapta a interface de registry.
 * Credenciais vêm do configJson da conta financeira em `contas_financeiras_boleto`
 * (não mais da tabela legada `mp_config`, que permanece pra compat mas será
 * migrada gradualmente).
 */

const { MercadoPagoClient } = require('../mercadopago-client');

module.exports = {
  nome: 'mercadopago',
  label: 'Mercado Pago',
  requerCertificado: false,
  webhookPath: '/webhook/boleto/mercadopago',

  camposConfig: [
    { name: 'accessToken', label: 'Access Token', type: 'password', required: true },
    { name: 'agencia', label: 'Agência (opcional)', placeholder: '0000', required: false },
    { name: 'conta', label: 'Conta (opcional)', placeholder: '00000-0', required: false },
  ],

  validarConfig(cfg) {
    if (!cfg || !cfg.accessToken) return { ok: false, erro: 'accessToken obrigatório' };
    return { ok: true };
  },

  async autenticar(cfg) {
    // MP usa Bearer fixo, sem OAuth — só checa configuração
    if (!cfg.accessToken) throw new Error('MercadoPago sem accessToken');
    return { ok: true };
  },

  async criarBoleto(db, cfg, payload) {
    const client = new MercadoPagoClient({ accessToken: cfg.accessToken });
    const resp = await client.criarBoleto({
      amount: payload.valor,
      expirationDate: payload.dataVencimento,
      customerDocument: payload.pagador.documento,
      customerName: payload.pagador.nome,
      customerEmail: payload.pagador.email || 'pagador@email.com',
      description: payload.descricao,
      address: payload.pagador.endereco || {},
      nfseNumero: payload.referencia?.nfseNumero,
      competencia: payload.referencia?.competencia,
    });
    return {
      nossoNumero: String(resp.id),
      linhaDigitavel: resp.writable_line,
      codigoBarras: resp.barcode,
      urlBoleto: resp.external_resource_url,
      pdfBase64: null,
      statusProvedor: 'registrado',
      raw: resp.raw,
    };
  },

  async consultarBoleto(db, cfg, nossoNumero) {
    const client = new MercadoPagoClient({ accessToken: cfg.accessToken });
    if (!client.consultar) return { status: 'nao_suportado' };
    return await client.consultar(nossoNumero);
  },

  async baixarBoleto(db, cfg, nossoNumero, motivo) {
    // MP não tem baixa por motivo — apenas cancelamento do pagamento
    return { status: 'nao_suportado', mensagem: 'Mercado Pago não suporta baixa por motivo via API' };
  },

  async processarWebhook(req, db, cfg) {
    // MP envia { type: 'payment', data: { id: '...' } }
    const body = req.body || {};
    if (body.type !== 'payment' || !body.data?.id) return null;
    try {
      const client = new MercadoPagoClient({ accessToken: cfg.accessToken });
      const pay = await (client.consultarPagamento ? client.consultarPagamento(body.data.id) : null);
      if (!pay) return null;
      // Localiza o boleto correspondente pelo nossoNumero (= payment id)
      const boleto = db.prepare('SELECT contaReceberId, id FROM boletos WHERE mpId = ?').get(String(body.data.id));
      if (!boleto) return null;
      const aprovado = pay.status === 'approved';
      return {
        contaReceberId: boleto.contaReceberId,
        boletoId: boleto.id,
        status: aprovado ? 'pago' : (pay.status || 'pendente'),
        valorPago: Number(pay.transaction_amount) || null,
        dataPagamento: pay.date_approved || null,
      };
    } catch (e) {
      return null;
    }
  },
};
