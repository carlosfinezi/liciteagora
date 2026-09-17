/**
 * nicsrs-console-client.js — cliente da API do PAINEL da NicSRS.
 *
 * É outra API, não a de revenda (`nicsrs-client.js`). A diferença importa:
 *
 *   portal.nicsrs.com  — API de revenda. Autentica por `api_token` no corpo.
 *                        Faz o ciclo de vida (collect, reissue, list...), mas
 *                        o /ssl/place recusa toda tentativa de compra desta
 *                        conta (13 formatos testados em 2026-08-29, sempre -1)
 *                        e pressupõe saldo pré-pago, que a conta não usa.
 *   facevg.nicsrs.com  — API que o console usa. Autentica por JWT de sessão.
 *                        É ela que CRIA o pedido, e sem exigir saldo: a ordem
 *                        nasce "unpaid" e o pagamento é feito por PayPal/cartão.
 *
 * Levantada observando o próprio console em 2026-08-29. NÃO é documentada:
 * pode mudar sem aviso, e o sintoma será pedido que não cria. Por isso o
 * módulo mantém o modo 'painel' como alternativa (ver ssl-certificados-routes).
 *
 * SESSÃO
 * O login do console exige senha + captcha, e por isso NÃO é feito aqui: ele é
 * humano, uma vez, e o que fica guardado é o `refresh_token`. A partir dele
 * este cliente renova o access_token sozinho — e como cada renovação devolve um
 * refresh NOVO, a sessão se sustenta enquanto o ciclo não for interrompido.
 * Parado mais que a validade do refresh (~13h), precisa de login humano de novo.
 */

const BASE = 'https://facevg.nicsrs.com/console/v1';
const TIMEOUT_MS = 30000;

// Renova com folga: não adianta esperar o access expirar para descobrir isso
// no meio de uma compra.
const FOLGA_RENOVACAO_MS = 5 * 60 * 1000;

let _cache = null;   // { accessToken, expiraEm } — por processo, some no restart

function decodificarExp(jwt) {
  try {
    const p = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64').toString('utf8'));
    return p.exp ? p.exp * 1000 : null;
  } catch { return null; }
}

async function chamar(caminho, { metodo = 'GET', corpo = null, accessToken = null } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}/${caminho}`, {
      method: metodo,
      headers: {
        Accept: 'application/json, text/plain, */*',
        ...(corpo ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: accessToken } : {}),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    // A API responde HTTP 200 mesmo em erro; o que vale é o `code` (0 = ok).
    if (j.code !== 0) {
      const detalhe = j.message || `code ${j.code}`;
      const erro = new Error(`NicSRS console ${caminho}: ${detalhe}`);
      erro.codigoNicsrs = j.code;
      throw erro;
    }
    return j.data || {};
  } finally { clearTimeout(t); }
}

/**
 * Access token válido, renovando quando preciso.
 *
 * Guarda o refresh NOVO a cada renovação — sem isso a sessão morre na validade
 * do refresh original, e o ganho de não precisar de captcha se perde.
 */
async function obterAccessToken(db, { getConfig, setConfig }) {
  if (_cache && _cache.expiraEm - Date.now() > FOLGA_RENOVACAO_MS) return _cache.accessToken;

  const refresh = getConfig(db, 'nicsrs_console_refresh_token');
  if (!refresh) {
    throw new Error('Sessão do painel NicSRS não configurada — informe o refresh token em Certificados SSL › Integração');
  }

  let dados;
  try {
    dados = await chamar('account/refresh-token', { metodo: 'POST', corpo: { refresh_token: refresh } });
  } catch (err) {
    // Refresh vencido/invalidado: só um login humano resolve (senha + captcha).
    throw new Error(`Sessão do painel NicSRS expirou — refaça o login no console e atualize o refresh token. (${err.message})`);
  }

  const accessToken = dados.accessToken || dados.access_token;
  const refreshNovo = dados.refreshToken || dados.refresh_token;
  if (!accessToken) throw new Error('NicSRS console: resposta de refresh sem accessToken');

  if (refreshNovo && refreshNovo !== refresh) setConfig(db, 'nicsrs_console_refresh_token', refreshNovo);

  const expiraEm = decodificarExp(accessToken)
    || Date.now() + (Number(dados.expiresIn) > 0 ? Number(dados.expiresIn) * 1000 : 3600000);
  _cache = { accessToken, expiraEm };
  return accessToken;
}

/** Metadados do produto no painel — é a ponte entre o nosso `code` e o id numérico. */
async function configDoProduto(db, deps, code) {
  const token = await obterAccessToken(db, deps);
  const d = await chamar(`product/new-config?code=${encodeURIComponent(code)}`, { accessToken: token });
  return {
    productId: d.id ? String(d.id) : null,
    nome: d.name || null,
    maxYear: Number(d.maxYear) || null,
    // `payTypes` alimenta o period_type do order/create. Nos 69 produtos desta
    // conta é sempre [2]; o primeiro é o que o console usa.
    periodType: Array.isArray(d.payTypes) && d.payTypes.length ? Number(d.payTypes[0]) : 2,
  };
}

/**
 * Cria a ordem. NÃO paga: devolve o orderNo e a ordem fica "unpaid" até alguém
 * pagar no console por PayPal/cartão. É por isso que não exige saldo.
 */
async function criarOrdem(db, deps, { productId, quantidade = 1, periodos = 1, periodType = 2 }) {
  const token = await obterAccessToken(db, deps);
  const d = await chamar('order/create', {
    metodo: 'POST', accessToken: token,
    corpo: {
      product_id: String(productId),
      num: Number(quantidade) || 1,
      period_type: Number(periodType) || 2,
      periods: Number(periodos) || 1,
      type: 'new',
    },
  });
  const orderNo = d.orderNo || d.order_no || null;
  if (!orderNo) throw new Error('NicSRS console: order/create não devolveu orderNo');
  return { orderNo, urlPagamento: `https://console.nicsrs.com/product/payment?order=${encodeURIComponent(orderNo)}` };
}

/** Só para a tela de configuração dizer se a sessão está de pé. */
async function testarSessao(db, deps) {
  const token = await obterAccessToken(db, deps);
  await chamar('cart/GetCount', { accessToken: token });
  return { ok: true, expiraEm: _cache ? new Date(_cache.expiraEm).toISOString() : null };
}

function limparCache() { _cache = null; }

module.exports = {
  BASE, chamar, obterAccessToken, configDoProduto, criarOrdem, testarSessao, limparCache,
};
