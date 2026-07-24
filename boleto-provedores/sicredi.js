/**
 * boleto-provedores/sicredi.js — Provedor Sicredi (API Cobrança v3.9, nov/2025).
 *
 * Sem mTLS — só OAuth2 password grant + header x-api-key. Suporta boleto NORMAL ou
 * HIBRIDO (com QR Pix dinâmico).
 *
 * Credenciais:
 *   - xApiKey:       criado no Portal do Desenvolvedor (developer.sicredi.com.br) UMA VEZ
 *                    pela equipe Liciteagora — mesma chave funciona pra qualquer cliente.
 *   - codigoAcesso:  gerado pelo cliente no Internet Banking em
 *                    Cobrança > Código de Acesso > Gerar (precisa modalidade API habilitada).
 *   - cooperativa, posto, codigoBeneficiario: do contrato Cobrança Online do cliente.
 *
 * Username OAuth = codigoBeneficiario(zfill5) + cooperativa(zfill4) → 9 dígitos.
 *
 * Webhook (v3.9): a Sicredi tem API pra cadastrar a URL programaticamente —
 *   POST /cobranca/boleto/v1/webhook/contrato/   (criar)
 *   GET  /cobranca/boleto/v1/webhook/contratos/  (consultar)
 *   PATCH /cobranca/boleto/v1/webhook/contrato/{id} (alterar)
 * Eventos suportados: LIQUIDACAO_PIX, LIQUIDACAO_REDE, LIQUIDACAO_COMPE_H5/H6/H8,
 * LIQUIDACAO_CARTORIO, ESTORNO_LIQUIDACAO_REDE.
 *
 * A URL contratada deve ser HTTPS público (TLS 1.2, certificado não auto-assinado),
 * responder 200 em até 10s. Apontar para:
 *   https://<dominio-tenant>/webhook/boleto/sicredi
 * Roteamento já existe em pre-auth-routes.js → boleto-orchestrator.processarWebhook().
 */

const AUTH_URL = {
  homologacao: 'https://api-parceiro.sicredi.com.br/sb/auth/openapi/token',
  producao: 'https://api-parceiro.sicredi.com.br/auth/openapi/token',
};
const COBRANCA_BASE = {
  homologacao: 'https://api-parceiro.sicredi.com.br/sb/cobranca/boleto/v1',
  producao: 'https://api-parceiro.sicredi.com.br/cobranca/boleto/v1',
};

// Cache de tokens em memória, chaveado por (xApiKey + username + ambiente).
// Sicredi: access_token expira em ~300s, refresh_token em ~1800s.
const tokenCache = new Map();
const SAFETY_MARGIN_MS = 30_000;

function cacheKey(cfg) {
  return `${cfg.ambiente || 'homologacao'}|${cfg.xApiKey || ''}|${buildUsername(cfg)}`;
}

function buildUsername(cfg) {
  const benef = String(cfg.codigoBeneficiario || '').padStart(5, '0');
  const coop = String(cfg.cooperativa || '').padStart(4, '0');
  return benef + coop;
}

async function _httpJson(method, url, { headers = {}, body = null, form = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (body != null) {
    if (form) {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(body).toString();
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(url, init);
  const raw = await res.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { /* não-json */ }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.error_description))
      || raw.slice(0, 300)
      || res.statusText;
    const err = new Error(`Sicredi ${res.statusCode || res.status}: ${msg}`);
    err.statusCode = res.status;
    err.response = json || raw;
    throw err;
  }
  return json;
}

async function obterAccessToken(cfg) {
  const key = cacheKey(cfg);
  const cached = tokenCache.get(key);
  const now = Date.now();
  if (cached && cached.accessExp - SAFETY_MARGIN_MS > now) return cached.accessToken;

  const url = AUTH_URL[cfg.ambiente] || AUTH_URL.homologacao;
  const headers = { 'x-api-key': cfg.xApiKey, 'context': 'COBRANCA' };

  // Tenta refresh primeiro se ainda válido
  if (cached && cached.refreshToken && cached.refreshExp - SAFETY_MARGIN_MS > now) {
    try {
      const resp = await _httpJson('POST', url, {
        headers,
        form: true,
        body: { grant_type: 'refresh_token', refresh_token: cached.refreshToken },
      });
      _gravarCache(key, resp);
      return resp.access_token;
    } catch {
      // Falhou refresh — cai no fluxo password
    }
  }

  const resp = await _httpJson('POST', url, {
    headers,
    form: true,
    body: {
      grant_type: 'password',
      scope: 'cobranca',
      username: buildUsername(cfg),
      password: cfg.codigoAcesso,
    },
  });
  _gravarCache(key, resp);
  return resp.access_token;
}

function _gravarCache(key, resp) {
  const now = Date.now();
  tokenCache.set(key, {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token,
    accessExp: now + (Number(resp.expires_in) || 300) * 1000,
    refreshExp: now + (Number(resp.refresh_expires_in) || 1800) * 1000,
  });
}

function _headersAutenticados(cfg, accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'x-api-key': cfg.xApiKey,
    'cooperativa': String(cfg.cooperativa || '').padStart(4, '0'),
    'posto': String(cfg.posto || '').padStart(2, '0'),
  };
}

function _baseUrl(cfg) {
  return COBRANCA_BASE[cfg.ambiente] || COBRANCA_BASE.homologacao;
}

// ==================== INTERFACE DO REGISTRY ====================

module.exports = {
  nome: 'sicredi',
  label: 'Sicredi',
  requerCertificado: false,
  webhookPath: '/webhook/boleto/sicredi',

  camposConfig: [
    { name: 'xApiKey', label: 'X-API-KEY (Portal Desenvolvedor)', type: 'password', required: true,
      placeholder: 'token UUID da APP no developer.sicredi.com.br' },
    { name: 'codigoAcesso', label: 'Código de Acesso (Internet Banking)', type: 'password', required: true,
      placeholder: 'gerado em Cobrança > Código de Acesso' },
    { name: 'cooperativa', label: 'Cooperativa', placeholder: '0804', required: true },
    { name: 'posto', label: 'Posto', placeholder: '29', required: true },
    { name: 'codigoBeneficiario', label: 'Código Beneficiário', placeholder: '58385', required: true },
    { name: 'tipoCobranca', label: 'Tipo Cobrança', type: 'select',
      options: ['NORMAL', 'HIBRIDO'], required: false },
    { name: 'especieDocumentoPadrao', label: 'Espécie Documento Padrão', type: 'select',
      options: [
        'DUPLICATA_MERCANTIL_INDICACAO',
        'DUPLICATA_SERVICO_INDICACAO',
        'NOTA_PROMISSORIA',
        'RECIBO',
        'OUTROS',
      ],
      required: false },
  ],

  validarConfig(cfg) {
    if (!cfg) return { ok: false, erro: 'Configuração vazia' };
    const faltantes = [];
    if (!cfg.xApiKey) faltantes.push('xApiKey');
    if (!cfg.codigoAcesso) faltantes.push('codigoAcesso');
    if (!cfg.cooperativa) faltantes.push('cooperativa');
    if (!cfg.posto) faltantes.push('posto');
    if (!cfg.codigoBeneficiario) faltantes.push('codigoBeneficiario');
    if (faltantes.length) return { ok: false, erro: 'Campos obrigatórios: ' + faltantes.join(', ') };
    return { ok: true };
  },

  async autenticar(cfg) {
    const token = await obterAccessToken(cfg);
    if (!token) throw new Error('Sicredi não retornou access_token');
    return { ok: true };
  },

  async criarBoleto(db, cfg, payload) {
    const token = await obterAccessToken(cfg);
    const tipoCobranca = (cfg.tipoCobranca === 'HIBRIDO') ? 'HIBRIDO' : 'NORMAL';
    const especieDoc = cfg.especieDocumentoPadrao || 'DUPLICATA_MERCANTIL_INDICACAO';

    const pagador = payload.pagador || {};
    const end = pagador.endereco || {};

    // nossoNumero do orquestrador (zero-padded para 9 dígitos exigidos pela Sicredi)
    const nossoNumero = String(payload.nossoNumero || '').replace(/\D/g, '').padStart(9, '0').slice(-9);

    const body = {
      codigoBeneficiario: String(cfg.codigoBeneficiario),
      pagador: {
        tipoPessoa: _tipoPessoa(pagador.documento),
        documento: _digitos(pagador.documento),
        nome: (pagador.nome || '').slice(0, 40),
        endereco: (end.logradouro || '').slice(0, 40),
        cidade: (end.cidade || '').slice(0, 25),
        uf: (end.uf || '').slice(0, 2).toUpperCase(),
        cep: _digitos(end.cep),
        ...(pagador.email ? { email: pagador.email.slice(0, 40) } : {}),
      },
      especieDocumento: especieDoc,
      seuNumero: (payload.seuNumero || '').slice(0, 10),
      nossoNumero,
      dataVencimento: payload.dataVencimento,
      valor: Number(payload.valor),
      tipoCobranca,
    };

    if (payload.descricao) {
      body.mensagens = String(payload.descricao).match(/.{1,80}/g)?.slice(0, 4) || [];
    }

    const url = `${_baseUrl(cfg)}/boletos`;
    const resp = await _httpJson('POST', url, {
      headers: _headersAutenticados(cfg, token),
      body,
    });

    return {
      nossoNumero: String(resp.nossoNumero || nossoNumero),
      linhaDigitavel: resp.linhaDigitavel || '',
      codigoBarras: resp.codigoBarras || '',
      urlBoleto: null,
      pdfBase64: null,
      statusProvedor: 'registrado',
      raw: resp,
    };
  },

  async consultarBoleto(db, cfg, nossoNumero) {
    const token = await obterAccessToken(cfg);
    const params = new URLSearchParams({
      codigoBeneficiario: String(cfg.codigoBeneficiario),
      nossoNumero: String(nossoNumero).padStart(9, '0').slice(-9),
    });
    const url = `${_baseUrl(cfg)}/boletos?${params}`;
    const resp = await _httpJson('GET', url, { headers: _headersAutenticados(cfg, token) });
    return {
      situacao: resp.situacao || null,
      valorNominal: resp.valorNominal,
      dataVencimento: resp.dataVencimento,
      linhaDigitavel: resp.linhaDigitavel,
      codigoBarras: resp.codigoBarras,
      raw: resp,
    };
  },

  async baixarBoleto(db, cfg, nossoNumero, motivo) {
    const token = await obterAccessToken(cfg);
    const nn = String(nossoNumero).padStart(9, '0').slice(-9);
    const url = `${_baseUrl(cfg)}/boletos/${nn}/baixa`;
    // PATCH body vazio; codigoBeneficiario vai em HEADER (manual v3.9 §7.4)
    const headers = {
      ..._headersAutenticados(cfg, token),
      'codigoBeneficiario': String(cfg.codigoBeneficiario),
    };
    const resp = await _httpJson('PATCH', url, { headers, body: {} });
    return { status: 'baixado', motivo: motivo || null, raw: resp };
  },

  // Webhook payload (Sicredi v3.9 §16):
  //   { agencia, posto, beneficiario, nossoNumero, dataEvento:[Y,M,D,H,m,s,ns],
  //     movimento:"LIQUIDACAO_PIX"|..., valorLiquidacao, valorDesconto, valorJuros,
  //     valorMulta, valorAbatimento, dataPrevisaoPagamento:[Y,M,D],
  //     idEventoWebhook }
  // Estorno: movimento === "ESTORNO_LIQUIDACAO_REDE" reverte uma liquidação anterior.
  async processarWebhook(req, db, cfg) {
    const body = req.body || {};
    console.log('[Sicredi webhook]', body.idEventoWebhook || '(sem id)', body.movimento || '(sem movimento)');

    const nossoNumero = body.nossoNumero;
    const movimento = String(body.movimento || '').toUpperCase();
    if (!nossoNumero || !movimento) return null;

    const boleto = db.prepare(
      'SELECT id, contaReceberId FROM boletos WHERE provedor = ? AND nossoNumero = ?'
    ).get('sicredi', String(nossoNumero));
    if (!boleto) return null;

    const isLiquidacao = movimento.startsWith('LIQUIDACAO_');
    const isEstorno = movimento === 'ESTORNO_LIQUIDACAO_REDE';

    return {
      contaReceberId: boleto.contaReceberId,
      boletoId: boleto.id,
      status: isLiquidacao ? 'pago' : (isEstorno ? 'estornado' : 'pendente'),
      valorPago: Number(body.valorLiquidacao) || null,
      dataPagamento: _dataEventoParaIso(body.dataPrevisaoPagamento || body.dataEvento),
      idEventoWebhook: body.idEventoWebhook || null,
      movimento,
    };
  },

  // ==================== CONTRATAÇÃO DE WEBHOOK (v3.9) ====================
  // Cada beneficiário pode ter 1 contrato. Use criarContratoWebhook na primeira vez
  // ou alterarContratoWebhook(idContrato, ...) pra atualizar a URL/status.

  async criarContratoWebhook(cfg, { url, eventos = ['LIQUIDACAO'], nomeResponsavel,
                                     email, telefone, header, token,
                                     enviarIdTituloEmpresa = false }) {
    const accessToken = await obterAccessToken(cfg);
    const body = {
      cooperativa: String(cfg.cooperativa || '').padStart(4, '0'),
      posto: String(cfg.posto || '').padStart(2, '0'),
      codBeneficiario: String(cfg.codigoBeneficiario),
      eventos,
      url,
      urlStatus: 'ATIVO',
      contratoStatus: 'ATIVO',
      ...(nomeResponsavel ? { nomeResponsavel } : {}),
      ...(email ? { email } : {}),
      ...(telefone ? { telefone } : {}),
      ...(header ? { header } : {}),
      ...(token ? { token } : {}),
      enviarIdTituloEmpresa,
    };
    return _httpJson('POST', `${_baseUrl(cfg)}/webhook/contrato/`, {
      headers: _headersAutenticados(cfg, accessToken),
      body,
    });
  },

  async consultarContratosWebhook(cfg) {
    const accessToken = await obterAccessToken(cfg);
    const params = new URLSearchParams({
      cooperativa: String(cfg.cooperativa || '').padStart(4, '0'),
      posto: String(cfg.posto || '').padStart(2, '0'),
      beneficiario: String(cfg.codigoBeneficiario),
    });
    return _httpJson('GET', `${_baseUrl(cfg)}/webhook/contratos/?${params}`, {
      headers: _headersAutenticados(cfg, accessToken),
    });
  },

  async alterarContratoWebhook(cfg, idContrato, alteracoes) {
    const accessToken = await obterAccessToken(cfg);
    return _httpJson('PATCH', `${_baseUrl(cfg)}/webhook/contrato/${idContrato}`, {
      headers: _headersAutenticados(cfg, accessToken),
      body: alteracoes,
    });
  },
};

// ==================== HELPERS LOCAIS ====================

function _digitos(s) { return String(s || '').replace(/\D/g, ''); }
function _tipoPessoa(doc) {
  const d = _digitos(doc);
  return d.length === 14 ? 'PESSOA_JURIDICA' : 'PESSOA_FISICA';
}

// Sicredi envia datas como array [YYYY,MM,DD,HH,mm,ss,ns] (LocalDateTime serializado).
// Converte para ISO YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss.
function _dataEventoParaIso(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return null;
  const [y, m, d, h, mi, s] = arr;
  const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (h == null) return date;
  return `${date}T${String(h).padStart(2, '0')}:${String(mi || 0).padStart(2, '0')}:${String(s || 0).padStart(2, '0')}`;
}
