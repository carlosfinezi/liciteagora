// pcp-auth.js
//
// Autenticação no Portal de Compras Públicas (Keycloak realm "Portal").
//
// Por que não password grant: o realm anuncia grant_types_supported=[password],
// mas o client `aspclient` rejeita com unauthorized_client (Direct Access Grants
// desabilitado).
//
// Por que não troca direta do code: `aspclient` é confidencial; client_secret
// vive no backend de operacao.portaldecompraspublicas.com.br. Direct exchange
// devolve 401.
//
// Fluxo que funciona (replica browser):
//   1) GET iam.../auth → HTML + cookies KC_AUTH_SESSION_HASH
//   2) POST iam.../login-actions/authenticate → 302 para operacao.../loginext/oAuth/?code=
//   3) GET nessa URL (cookie-jar por host) → backend do PCP troca o code, retorna
//      200 e set-cookie ASPSESSIONIDSQBRSARC (sessão IIS — é o "login real")
//
// Exports:
//   - loginPcp(usuario, senha) → { jars, trace } (jars por host); throws em falha
//   - probePcpLogin(usuario, senha) → { ok, ... } pra diagnóstico (não throws)

const KEYCLOAK_BASE = 'https://iam.secure.portaldecompraspublicas.com.br/realms/Portal';
const AUTH_URL = `${KEYCLOAK_BASE}/protocol/openid-connect/auth`;
const REDIRECT_URI = 'https://operacao.portaldecompraspublicas.com.br/18/loginext/oAuth/';
const CLIENT_ID = 'aspclient';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function parseSetCookies(headers) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

function jarToHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Erros estruturados para diferenciar falha de credencial vs falha sistêmica.
class PcpLoginError extends Error {
  constructor(etapa, message, extra = {}) {
    super(message);
    this.name = 'PcpLoginError';
    this.etapa = etapa;
    Object.assign(this, extra);
  }
}

async function loginPcp(usuario, senha) {
  const trace = [];
  const kcJar = {};

  // 1) GET auth
  const authUrl =
    `${AUTH_URL}?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code&scope=openid`;

  const r1 = await fetch(authUrl, {
    method: 'GET',
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    redirect: 'follow',
  });
  trace.push(`GET /auth → ${r1.status}`);
  if (r1.status !== 200) throw new PcpLoginError('auth-get', `GET /auth retornou ${r1.status}`, { trace });
  Object.assign(kcJar, parseSetCookies(r1.headers));
  const html = await r1.text();

  if (/recaptcha|hcaptcha|g-recaptcha/i.test(html)) {
    throw new PcpLoginError('captcha', 'Login do PCP passou a exigir captcha', { trace });
  }

  const actionMatch = html.match(/action="([^"]*login-actions\/authenticate[^"]*)"/);
  if (!actionMatch) throw new PcpLoginError('parse-action', 'action URL não encontrada no HTML', { trace });
  const actionUrl = actionMatch[1].replace(/&amp;/g, '&');

  // 2) POST credenciais
  const r2 = await fetch(actionUrl, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
      Cookie: jarToHeader(kcJar),
    },
    body: new URLSearchParams({ username: usuario, password: senha, credentialId: '' }).toString(),
    redirect: 'manual',
  });
  trace.push(`POST /login-actions/authenticate → ${r2.status}`);
  Object.assign(kcJar, parseSetCookies(r2.headers));

  if (r2.status === 200) {
    const body2 = await r2.text();
    const errMatch =
      body2.match(/class="[^"]*kc-feedback-text[^"]*"[^>]*>\s*([^<]+)/) ||
      body2.match(/id="input-error"[^>]*>\s*([^<]+)/);
    const err = errMatch ? errMatch[1].trim() : 'login rejeitado';
    throw new PcpLoginError('credenciais-invalidas', err, { trace });
  }
  if (r2.status !== 302 && r2.status !== 303) {
    throw new PcpLoginError('authenticate-post', `Status inesperado ${r2.status}`, { trace });
  }

  const loc = r2.headers.get('location') || '';
  trace.push(`location: ${loc.slice(0, 160)}`);
  if (!loc.startsWith('https://operacao.portaldecompraspublicas.com.br')) {
    throw new PcpLoginError('redirect-inesperado', 'Keycloak redirecionou para outro host (required-action?)', { location: loc, trace });
  }
  if (!/[?&]code=/.test(loc)) {
    throw new PcpLoginError('sem-code', 'redirect sem ?code=', { location: loc, trace });
  }

  // 3) Seguir cadeia com cookie-jar por host
  const jars = {
    'iam.secure.portaldecompraspublicas.com.br': { ...kcJar },
    'operacao.portaldecompraspublicas.com.br': {},
  };

  let nextUrl = loc;
  let lastStatus = 0;
  let lastBody = '';
  for (let hop = 0; hop < 8 && nextUrl; hop++) {
    const u = new URL(nextUrl);
    if (!jars[u.host]) jars[u.host] = {};
    const r = await fetch(nextUrl, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'text/html', Cookie: jarToHeader(jars[u.host]) },
      redirect: 'manual',
    });
    lastStatus = r.status;
    trace.push(`hop ${hop}: ${u.host}${u.pathname} → ${r.status}`);
    Object.assign(jars[u.host], parseSetCookies(r.headers));

    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const next = r.headers.get('location');
      if (!next) break;
      nextUrl = next.startsWith('http') ? next : new URL(next, nextUrl).toString();
      continue;
    }
    if (r.status === 200) lastBody = await r.text();
    break;
  }

  const opCookies = jars['operacao.portaldecompraspublicas.com.br'] || {};
  if (Object.keys(opCookies).length === 0) {
    throw new PcpLoginError('sem-sessao', 'Sem cookies em operacao.* após redirects', { trace });
  }
  if (/id="kc-form-login"|action="[^"]*login-actions\/authenticate/i.test(lastBody)) {
    throw new PcpLoginError('relogou', 'Token exchange interno do PCP falhou', { trace });
  }

  return { jars, trace, lastStatus };
}

async function probePcpLogin(usuario, senha) {
  try {
    const { jars, trace, lastStatus } = await loginPcp(usuario, senha);
    const opCookies = jars['operacao.portaldecompraspublicas.com.br'];
    const cookieNames = Object.keys(opCookies);
    return {
      ok: true,
      lastStatus,
      cookies: cookieNames,
      cookieAmostra: cookieNames.slice(0, 3).map((n) => `${n}=${opCookies[n].slice(0, 16)}…`),
      trace,
    };
  } catch (e) {
    if (e instanceof PcpLoginError) {
      return { ok: false, etapa: e.etapa, error: e.message, location: e.location, trace: e.trace };
    }
    return { ok: false, etapa: 'erro-rede', error: e.message };
  }
}

module.exports = { loginPcp, probePcpLogin, PcpLoginError, parseSetCookies, jarToHeader, UA };
