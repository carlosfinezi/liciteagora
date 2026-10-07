/**
 * boleto-provedores/asaas.js — Provedor Asaas (API v3).
 *
 * Sem certificado, sem OAuth. Auth via header `access_token` fixo:
 *   - Sandbox:    $aact_hmlg_…   →  https://api-sandbox.asaas.com/v3
 *   - Produção:   $aact_prod_…   →  https://api.asaas.com/v3
 *
 * O Asaas modela cobrança em 2 passos: customer + payment.
 *   1) POST /customers (idempotente via filtro cpfCnpj) → cus_xxx
 *   2) POST /payments { customer, billingType:'BOLETO', value, dueDate, ... } → pay_xxx
 *      Resposta traz bankSlipUrl + nossoNumero do banco, mas linhaDigitavel/codigoBarras
 *      vêm num GET separado: /payments/{id}/identificationField.
 *
 * Webhook: o cliente registra a URL manualmente em "Notificações via webhook" no painel
 * Asaas (ou via POST /v3/webhooks). Opcionalmente seta um token (`asaas-access-token`
 * header) que validamos contra cfg.webhookToken. Eventos relevantes:
 *   - PAYMENT_RECEIVED         (boleto/PIX liquidado)
 *   - PAYMENT_CONFIRMED        (cartão capturado)
 *   - PAYMENT_REFUNDED / REVERSED / CHARGEBACK_REQUESTED → estorno
 *
 * URL pra cadastrar no painel:
 *   https://<dominio-tenant>/webhook/boleto/asaas
 */

const crypto = require('crypto');

const API_BASE = {
  homologacao: 'https://api-sandbox.asaas.com/v3',
  producao: 'https://api.asaas.com/v3',
};

/**
 * Os dois segredos são iguais? Comparação de tempo constante.
 *
 * `===` em string sai no primeiro byte diferente, e a diferença de tempo entre
 * "errou no 1º caractere" e "errou no 20º" é mensurável por quem tenta adivinhar
 * caractere a caractere.
 *
 * Compara os DIGESTS, não os textos: SHA-256 dá sempre 32 bytes, então
 * `timingSafeEqual` nunca recebe tamanhos diferentes (ele lança quando recebe) e
 * o comprimento do segredo não vaza pelo caminho do erro.
 */
function segredoConfere(recebido, esperado) {
  if (typeof recebido !== 'string' || typeof esperado !== 'string') return false;
  if (!recebido || !esperado) return false;
  const h = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
  return crypto.timingSafeEqual(h(recebido), h(esperado));
}

/**
 * Esta conta pode receber aviso de pagamento com segurança?
 *
 * É a pergunta que decide se o pagamento ONLINE pode ser oferecido ao
 * consumidor, e a resposta é só uma: existe segredo de webhook configurado.
 *
 * O porquê, medido em 07/10/2026: a URL do boleto que vai ao cliente é a do
 * provedor, e ela carrega o id da cobrança no caminho
 * (`asaas.com/b/pdf/pay_xxx`). Sem segredo, quem recebe um boleto conhece o
 * `pay_id` e um POST para `/webhook/boleto/asaas` daquele tenant baixa a conta
 * a receber sem ter pagado nada. Conhecer o identificador nunca pode ser
 * suficiente para dar uma venda por paga.
 *
 * Isto NÃO fala sobre emitir, consultar, conciliar ou importar extrato: nesses
 * casos quem bate à porta somos nós, com a credencial da conta. A exigência é
 * só sobre requisição que CHEGA.
 */
function webhookAutenticado(cfg) {
  return !!(cfg && typeof cfg.webhookToken === 'string' && cfg.webhookToken.trim());
}

function _baseUrl(cfg) {
  return API_BASE[cfg.ambiente] || API_BASE.homologacao;
}

function _digitos(s) {
  return String(s || '').replace(/\D/g, '');
}

function _headers(cfg) {
  return {
    'access_token': cfg.accessToken,
    'User-Agent': 'liciteagora/1.0',
  };
}

async function _httpJson(method, url, { headers = {}, body = null } = {}) {
  const init = { method, headers: { ...headers } };
  if (body != null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const raw = await res.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { /* não-json */ }
  if (!res.ok) {
    const msg = (json && Array.isArray(json.errors) && json.errors.length)
      ? json.errors.map(e => e.description || e.code).join('; ')
      : (raw.slice(0, 300) || res.statusText);
    const err = new Error(`Asaas ${res.status}: ${msg}`);
    err.statusCode = res.status;
    err.response = json || raw;
    throw err;
  }
  return json;
}

async function _findCustomerByDoc(cfg, doc) {
  const url = `${_baseUrl(cfg)}/customers?cpfCnpj=${encodeURIComponent(doc)}&limit=1`;
  const resp = await _httpJson('GET', url, { headers: _headers(cfg) });
  return resp && Array.isArray(resp.data) && resp.data[0] ? resp.data[0].id : null;
}

async function _createCustomer(cfg, pagador) {
  const end = pagador.endereco || {};
  const body = {
    name: (pagador.nome || 'Cliente').slice(0, 100),
    cpfCnpj: _digitos(pagador.documento),
    email: pagador.email || undefined,
    postalCode: _digitos(end.cep) || undefined,
    address: (end.logradouro || end.endereco) || undefined,
    addressNumber: end.numero || undefined,
    complement: end.complemento || undefined,
    province: end.bairro || undefined,
    city: end.cidade || undefined,
    state: (end.uf || '').slice(0, 2).toUpperCase() || undefined,
  };
  const resp = await _httpJson('POST', `${_baseUrl(cfg)}/customers`, {
    headers: _headers(cfg), body,
  });
  return resp.id;
}

async function _ensureCustomer(cfg, pagador) {
  const doc = _digitos(pagador.documento);
  if (!doc) throw new Error('Asaas: pagador sem CPF/CNPJ');
  const existing = await _findCustomerByDoc(cfg, doc);
  if (existing) return existing;
  return await _createCustomer(cfg, pagador);
}

module.exports = {
  nome: 'asaas',
  label: 'Asaas',
  requerCertificado: false,
  webhookPath: '/webhook/boleto/asaas',

  camposConfig: [
    { name: 'accessToken', label: 'Access Token', type: 'password', required: true,
      placeholder: '$aact_prod_… (produção) ou $aact_hmlg_… (sandbox)' },
    { name: 'webhookToken', label: 'Token do Webhook (opcional)', type: 'password', required: false,
      placeholder: 'header asaas-access-token configurado no painel' },
  ],

  validarConfig(cfg) {
    if (!cfg) return { ok: false, erro: 'Configuração vazia' };
    if (!cfg.accessToken) return { ok: false, erro: 'accessToken obrigatório' };
    if (!cfg.accessToken.startsWith('$aact_')) {
      return { ok: false, erro: 'accessToken inválido (deve começar com $aact_)' };
    }
    if (cfg.ambiente === 'producao' && !cfg.accessToken.startsWith('$aact_prod_')) {
      return { ok: false, erro: 'Ambiente Produção exige chave que comece com $aact_prod_.' };
    }
    // O inverso só é recusado quando o prefixo declara produção. O Asaas emitiu por anos
    // chaves de sandbox sem marcador de ambiente, e a regra estrita recusaria quem as tem.
    if (cfg.ambiente && cfg.ambiente !== 'producao' && cfg.accessToken.startsWith('$aact_prod_')) {
      return { ok: false, erro: 'Chave de produção ($aact_prod_) gravada com ambiente Homologação. O sandbox do Asaas recusa essa chave. Troque o ambiente para Produção.' };
    }
    return { ok: true };
  },

  async autenticar(cfg) {
    // Asaas usa access_token fixo. Testa com um GET barato.
    await _httpJson('GET', `${_baseUrl(cfg)}/customers?limit=1`, { headers: _headers(cfg) });
    return { ok: true };
  },

  async criarBoleto(db, cfg, payload) {
    const pagador = payload.pagador || {};
    const customerId = await _ensureCustomer(cfg, pagador);

    const body = {
      customer: customerId,
      billingType: 'BOLETO',
      value: Number(payload.valor),
      dueDate: payload.dataVencimento, // YYYY-MM-DD
      description: (payload.descricao || '').slice(0, 500) || undefined,
      externalReference: payload.seuNumero || String(payload.nossoNumero || '') || undefined,
    };

    if (cfg.splitWalletId && cfg.splitPercentual) {
      const pct = Number(cfg.splitPercentual);
      if (Number.isFinite(pct) && pct > 0) {
        const bruto = body.value * pct / 100;
        const teto = Number(cfg.splitTetoBoleto);
        const walletId = String(cfg.splitWalletId).trim();
        if (Number.isFinite(teto) && teto >= 0.01 && bruto > teto) {
          // Teto por boleto: a tarifa do Asaas por boleto emitido já é alta, e
          // sem teto o split cresce junto com o valor do título. Acima do teto
          // o split deixa de ser percentual e vira valor fixo.
          body.split = [{ walletId, fixedValue: Number(teto.toFixed(2)) }];
        } else if (bruto >= 0.01) {
          // Asaas exige split mínimo de R$ 0,01 — abaixo disso, boleto sem split.
          body.split = [{ walletId, percentualValue: pct }];
        }
      }
    }

    const pay = await _httpJson('POST', `${_baseUrl(cfg)}/payments`, {
      headers: _headers(cfg), body,
    });

    // identificationField vem num endpoint separado — boleto registrado leva alguns
    // segundos pra ficar disponível, mas a 1ª chamada normalmente já retorna.
    let linhaDigitavel = '';
    let codigoBarras = '';
    try {
      const ident = await _httpJson('GET', `${_baseUrl(cfg)}/payments/${pay.id}/identificationField`, {
        headers: _headers(cfg),
      });
      linhaDigitavel = ident.identificationField || '';
      codigoBarras = ident.barCode || '';
    } catch (e) {
      console.warn(`[Asaas] identificationField indisponível pra ${pay.id}: ${e.message}`);
    }

    return {
      nossoNumero: String(pay.id), // pay_xxx — chave de rastreio interna
      linhaDigitavel,
      codigoBarras,
      urlBoleto: pay.bankSlipUrl || pay.invoiceUrl || '',
      pdfBase64: null,
      statusProvedor: pay.status || 'PENDING',
      raw: pay,
    };
  },

  async criarPix(db, cfg, payload) {
    const pagador = payload.pagador || {};
    const customerId = await _ensureCustomer(cfg, pagador);

    const body = {
      customer: customerId,
      billingType: 'PIX',
      value: Number(payload.valor),
      dueDate: payload.dataVencimento, // YYYY-MM-DD (data limite p/ pagar o PIX)
      description: (payload.descricao || '').slice(0, 500) || undefined,
      externalReference: payload.seuNumero || String(payload.nossoNumero || '') || undefined,
    };

    if (cfg.splitWalletId && cfg.splitPercentual) {
      const pct = Number(cfg.splitPercentual);
      if (Number.isFinite(pct) && pct > 0 && (body.value * pct / 100) >= 0.01) {
        body.split = [{ walletId: String(cfg.splitWalletId).trim(), percentualValue: pct }];
      }
    }

    const pay = await _httpJson('POST', `${_baseUrl(cfg)}/payments`, {
      headers: _headers(cfg), body,
    });

    // QR dinâmico vem de endpoint separado — pode levar 1-2s a ficar disponível.
    // Se falhar, o invoiceUrl (link) já permite pagar; o QR completa num reenvio.
    let pixPayload = '', pixQrImage = '', pixExpiration = null;
    try {
      const qr = await _httpJson('GET', `${_baseUrl(cfg)}/payments/${pay.id}/pixQrCode`, {
        headers: _headers(cfg),
      });
      pixPayload = qr.payload || '';       // copia-e-cola (EMV)
      pixQrImage = qr.encodedImage || '';  // PNG base64
      pixExpiration = qr.expirationDate || null;
    } catch (e) {
      console.warn(`[Asaas] pixQrCode indisponível pra ${pay.id}: ${e.message}`);
    }

    return {
      nossoNumero: String(pay.id),
      invoiceUrl: pay.invoiceUrl || '',
      pixPayload, pixQrImage, pixExpiration,
      statusProvedor: pay.status || 'PENDING',
      raw: pay,
    };
  },

  async consultarBoleto(db, cfg, nossoNumero) {
    const pay = await _httpJson('GET', `${_baseUrl(cfg)}/payments/${nossoNumero}`, {
      headers: _headers(cfg),
    });
    return {
      situacao: pay.status,
      valorNominal: pay.value,
      dataVencimento: pay.dueDate,
      dataPagamento: pay.paymentDate || null,
      urlBoleto: pay.bankSlipUrl || pay.invoiceUrl || null,
      raw: pay,
    };
  },

  async baixarBoleto(db, cfg, nossoNumero, motivo) {
    // Asaas: DELETE /payments/{id} cancela boleto pendente. Pagos exigem refund (POST /refund).
    const resp = await _httpJson('DELETE', `${_baseUrl(cfg)}/payments/${nossoNumero}`, {
      headers: _headers(cfg),
    });
    return { status: 'baixado', motivo: motivo || null, raw: resp };
  },

  webhookAutenticado,

  /**
   * O aviso de pagamento do Asaas.
   *
   * ── Fail closed, e a ordem importa ────────────────────────────────────────
   *
   * A autenticação vem ANTES de qualquer consulta ao banco, e antes de olhar o
   * corpo. Quem não se autentica não descobre nada: nem se o `pay_id` existe,
   * nem se o tenant tem aquela cobrança, nem quanto tempo a resposta demora
   * conforme o id. Até 07/10/2026 a validação era condicional — `if
   * (cfg.webhookToken)` — e conta sem segredo aceitava qualquer POST.
   *
   * Três recusas, e as três são a MESMA para quem está do lado de fora:
   *   - a conta não tem segredo configurado;
   *   - o aviso chegou sem o header;
   *   - o segredo não confere.
   */
  async processarWebhook(req, db, cfg) {
    const sent = (req.get && req.get('asaas-access-token'))
      || (req.headers && req.headers['asaas-access-token']);

    if (!webhookAutenticado(cfg)) {
      /* Sem segredo na conta, nenhum aviso é aceito — nem o legítimo. É o
         custo deliberado de não deixar a porta aberta, e a saída é configurar
         o token em Financeiro › Contas financeiras e no painel do Asaas. O
         polling continua baixando enquanto isso, com atraso de até 30 min. */
      console.warn('[Asaas webhook] recusado: a conta não tem segredo de webhook configurado');
      return null;
    }
    if (!segredoConfere(sent, cfg.webhookToken)) {
      /* Sem o valor nem o tamanho de nenhum dos dois: o log fica no servidor,
         mas um log é lido por gente, copiado para chamado e colado em
         conversa. O que o operador precisa saber é que houve recusa. */
      console.warn('[Asaas webhook] recusado: segredo ausente ou incorreto');
      return null;
    }

    const body = req.body || {};
    const event = String(body.event || '').toUpperCase();
    const payment = body.payment;
    console.log('[Asaas webhook]', event, payment?.id || '(sem payment)');

    if (!payment || !payment.id) return null;

    const boleto = db.prepare(
      'SELECT id, contaReceberId FROM boletos WHERE provedor = ? AND nossoNumero = ?'
    ).get('asaas', String(payment.id));
    if (!boleto) return null;

    const pago = event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED';
    const estornado = event === 'PAYMENT_REFUNDED'
      || event === 'PAYMENT_REVERSED'
      || event === 'PAYMENT_CHARGEBACK_REQUESTED';

    return {
      contaReceberId: boleto.contaReceberId,
      boletoId: boleto.id,
      status: pago ? 'pago' : (estornado ? 'estornado' : (payment.status || 'pendente').toLowerCase()),
      valorPago: Number(payment.value) || null,
      dataPagamento: payment.paymentDate || null,
      event,
    };
  },
};
