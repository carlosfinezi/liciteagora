/**
 * nicsrs-client.js — Cliente HTTP da API de revenda NicSRS (portal.nicsrs.com).
 *
 * Autenticação: `api_token` vai no CORPO de todo POST (não é header). O token
 * sai do painel em console.nicsrs.com/interface (Access Secret) ou do suporte
 * NicSRS; fica em config['nicsrs_api_token'] de cada tenant.
 *
 * Códigos de resposta (Appendix – Response Codes):
 *    1  sucesso
 *    2  certificado ainda sendo emitido, tentar depois
 *   -1  falha de validação de parâmetro
 *   -2  erro desconhecido
 *   -3  erro de produto ou de preço
 *   -4  crédito insuficiente na conta NicSRS
 *   -6  a CA recusou o pedido
 *  400  permissão negada (token ausente/errado ou IP fora da allowlist)
 *
 * Este módulo é só transporte: não toca banco e não decide nada de negócio.
 */

const BASE = 'https://portal.nicsrs.com';
const TIMEOUT_MS = 45000;

const CODIGO_SUCESSO = 1;
const CODIGO_EM_EMISSAO = 2;

const MENSAGEM_CODIGO = {
  1: 'sucesso',
  2: 'certificado ainda em emissao',
  '-1': 'falha de validacao de parametro',
  '-2': 'erro desconhecido na NicSRS',
  '-3': 'erro de produto ou preco',
  '-4': 'credito insuficiente na conta NicSRS',
  '-6': 'a autoridade certificadora recusou o pedido',
  400: 'permissao negada (token invalido ou IP fora da allowlist)',
};

function descreverErro(code, errors) {
  const base = MENSAGEM_CODIGO[String(code)] || `codigo ${code}`;
  if (!errors) return base;
  // A NicSRS manda `errors` ora como array, ora como objeto campo->mensagens
  // ({"years":["years is required"]}). Sem tratar o objeto, String(errors)
  // virava "[object Object]" e o motivo do erro se perdia.
  let detalhe;
  if (Array.isArray(errors)) {
    detalhe = errors.join('; ');
  } else if (errors && typeof errors === 'object') {
    detalhe = Object.entries(errors)
      .map(([campo, msgs]) => `${campo}: ${Array.isArray(msgs) ? msgs.join(', ') : msgs}`)
      .join('; ');
  } else {
    detalhe = String(errors);
  }
  return detalhe ? `${base}: ${detalhe}` : base;
}

/**
 * POST em /<caminho> com api_token no corpo. Devolve o objeto inteiro da
 * NicSRS quando code=1 ou code=2; lança Error nos demais códigos.
 */
async function chamar(caminho, apiToken, corpo = {}) {
  if (!apiToken) throw new Error('NicSRS: api_token nao configurado');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(`${BASE}/${caminho}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_token: apiToken, ...corpo }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(`NicSRS ${caminho}: falha de rede (${err.name === 'AbortError' ? 'timeout' : err.message})`);
  } finally {
    clearTimeout(timer);
  }

  const texto = await resp.text();
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new Error(`NicSRS ${caminho}: resposta nao-JSON (HTTP ${resp.status}) ${texto.slice(0, 200)}`);
  }

  if (json.code !== CODIGO_SUCESSO && json.code !== CODIGO_EM_EMISSAO) {
    throw new Error(`NicSRS ${caminho}: ${descreverErro(json.code, json.errors)}`);
  }
  return json;
}

// ==================== Catálogo ====================

/** Produtos e preços de uma CA. vendor ex.: 'Sectigo', 'Certum', 'DigiCert'. */
async function productList(apiToken, vendor) {
  return chamar('ssl/productList', apiToken, { vendor });
}

// ==================== Ciclo de vida ====================

/**
 * Compra um certificado. GASTA SALDO REAL da conta NicSRS.
 *   productCode  código do produto (vem do productList)
 *   years        1..6 — período da assinatura, não da validade do arquivo
 *   refId        nosso id idempotente (evita compra duplicada em retry)
 *   params       { csr, server, domainInfo[], Administrator{}, organizationInfo{} }
 * Devolve data.certId.
 */
async function place(apiToken, { productCode, years, refId, params }) {
  return chamar('ssl/place', apiToken, { productCode, years, refId, params });
}

/** Status + material do certificado. status: PENDING | COMPLETE | CANCELLED. */
async function collect(apiToken, certId) {
  return chamar('ssl/collect', apiToken, { certId });
}

/**
 * Reemite um certificado JÁ EMITIDO. É o mecanismo que cobre o teto de ~200
 * dias de validade dentro de uma assinatura de 1+ ano — e é gratuito.
 * Não recebe CSR: a NicSRS reaproveita o do pedido original.
 */
async function reissue(apiToken, { certId, reason, uniqueValue, refId }) {
  return chamar('ssl/reissue', apiToken, { certId, reason, uniqueValue, refId });
}

/** Renova a assinatura. Só liberado quando o certificado expira em <= 90 dias. */
async function renew(apiToken, { renewId, years, refId, params }) {
  return chamar('ssl/renew', apiToken, { renewId, years, refId, params });
}

/** Troca o método de validação de domínio de um pedido em andamento. */
async function updateDCV(apiToken, { certId, domainName, dcvMethod, dcvEmail }) {
  return chamar('ssl/updateDCV', apiToken, { certId, domainName, dcvMethod, dcvEmail });
}

/** Cancela pedido em Processing/Paid/Issued (emitido: até 30 dias). Estorna. */
async function cancel(apiToken, { certId, reason }) {
  return chamar('ssl/cancel', apiToken, { certId, reason });
}

/** Revoga um certificado emitido. Não estorna. */
async function revoke(apiToken, { certId, reason }) {
  return chamar('ssl/revoke', apiToken, { certId, reason });
}

module.exports = {
  BASE,
  CODIGO_SUCESSO,
  CODIGO_EM_EMISSAO,
  MENSAGEM_CODIGO,
  descreverErro,
  chamar,
  productList,
  place,
  collect,
  reissue,
  renew,
  updateDCV,
  cancel,
  revoke,
};
