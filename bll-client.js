// bll-client.js
//
// Cliente autenticado para bllcompras.com (BLL Compras).
//
// A BLL é bolsa ASP.NET clássica, análoga à BNC: login real exige captcha e
// fluxo de browser, então a sessão (cookies) é capturada pelo app Electron
// (Chromium real) e enviada ao servidor via POST /api/electron/bll/cookies.
// Aqui só CONSUMIMOS o cookie persistido — não logamos server-side.
//
// Cookies persistem em `config`:
//   - bll_session_cookie  → string "name1=value1; name2=value2; ..."
//   - bll_session_at      → ISO timestamp da última captura
//   - bll_session_user    → usuário/email logado (pra detectar troca)
//   - bll_session_perfil  → perfil escolhido (multi-perfil) — opcional
//
// Exports:
//   - bllFetch(db, path, { method, body, headers, contentType, followRedirects })
//                                                   → { status, body, headers, finalUrl }
//   - bllGet(db, path, headers)
//   - bllPost(db, path, body, headers)              (form-urlencoded por padrão)
//   - getSessionInfo(db)                            → { configurado, idadeMs, usuario, perfil }
//   - clearSession(db)
//
// Erros tipados:
//   - BllSessaoIndisponivelError : sem cookie em config (Electron nunca logou)
//   - BllSessaoExpiradaError     : servidor BLL indicou que cookie morreu (redirect p/ login)
//
// Espelha bnc-client.js — única diferença relevante: bllPost manda
// application/x-www-form-urlencoded por padrão (BLL serializa #jsonForm1 via
// $.ajax / $.serialize), e bllGet aceita text/html (parse da página de proposta).

'use strict';

const https = require('https');

const BLL_HOST = 'bllcompras.com';
const BLL_BASE = `https://${BLL_HOST}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1h — heurística; servidor real pode invalidar antes

class BllSessaoIndisponivelError extends Error {
  constructor(msg = 'Sessão BLL não configurada. Abra o app LiciteAgora BLL e faça login.') {
    super(msg);
    this.name = 'BllSessaoIndisponivelError';
    this.code = 'BLL_SEM_SESSAO';
  }
}

class BllSessaoExpiradaError extends Error {
  constructor(msg = 'Sessão BLL expirou. Abra o app LiciteAgora BLL pra renovar.') {
    super(msg);
    this.name = 'BllSessaoExpiradaError';
    this.code = 'BLL_SESSAO_EXPIRADA';
  }
}

// ─── leitura/escrita de cookies em config ──────────────────────────────────

function readSessionFromDb(db) {
  const cookie = db.prepare("SELECT valor FROM config WHERE chave='bll_session_cookie'").get();
  if (!cookie?.valor) return null;
  const at = db.prepare("SELECT valor FROM config WHERE chave='bll_session_at'").get();
  const user = db.prepare("SELECT valor FROM config WHERE chave='bll_session_user'").get();
  const perfil = db.prepare("SELECT valor FROM config WHERE chave='bll_session_perfil'").get();
  return {
    cookie: cookie.valor,
    capturedAt: at?.valor ? Date.parse(at.valor) : 0,
    usuario: user?.valor || null,
    perfil: perfil?.valor || null,
  };
}

function getSessionInfo(db) {
  const s = readSessionFromDb(db);
  if (!s) return { configurado: false };
  const idadeMs = s.capturedAt ? Date.now() - s.capturedAt : null;
  return {
    configurado: true,
    idadeMs,
    capturadoEm: s.capturedAt ? new Date(s.capturedAt).toISOString() : null,
    usuario: s.usuario,
    perfil: s.perfil,
    expirando: idadeMs != null && idadeMs > SESSION_MAX_AGE_MS,
  };
}

function clearSession(db) {
  db.prepare(`DELETE FROM config WHERE chave IN
    ('bll_session_cookie','bll_session_at','bll_session_user','bll_session_perfil')`).run();
}

// ─── HTTP fetcher autenticado ──────────────────────────────────────────────

function requestPromise(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.setTimeout(20000);
    if (body) req.write(body);
    req.end();
  });
}

async function bllFetch(db, urlPath, {
  method = 'GET',
  body = null,
  headers = {},
  contentType = null,            // se null e há body string → form-urlencoded
  accept = 'text/html,application/json, text/plain, */*',
  xhr = true,                    // X-Requested-With: XMLHttpRequest
  followRedirects = true,
} = {}) {
  const session = readSessionFromDb(db);
  if (!session) throw new BllSessaoIndisponivelError();

  let cur = urlPath.startsWith('http') ? urlPath : BLL_BASE + urlPath;
  let lastResp = null;
  let finalUrl = cur;

  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(cur);
    const baseHeaders = {
      'User-Agent': UA,
      Accept: accept,
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      Cookie: session.cookie,
    };
    if (xhr) baseHeaders['X-Requested-With'] = 'XMLHttpRequest';
    const opts = {
      method,
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      headers: { ...baseHeaders, ...headers },
    };
    if (body) {
      const buf = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(buf);
      opts.headers['Content-Type'] = opts.headers['Content-Type']
        || contentType
        || (typeof body === 'string' ? 'application/x-www-form-urlencoded; charset=UTF-8' : 'application/json;charset=utf-8');
      lastResp = await requestPromise(opts, buf);
    } else {
      lastResp = await requestPromise(opts);
    }
    finalUrl = cur;

    if (followRedirects && [301, 302, 303, 307, 308].includes(lastResp.status)) {
      const loc = lastResp.headers.location;
      if (!loc) break;
      cur = loc.startsWith('http') ? loc : new URL(loc, cur).toString();
      // segue redirects como GET (303/302 sempre; 307/308 simplificados pra GET)
      method = 'GET';
      body = null;
      continue;
    }
    break;
  }

  // Detectar sessão expirada: ASP.NET redireciona pra página de login quando
  // o cookie morre (ex.: /Account/Login, /Home/Login, /Login). Como mandamos
  // X-Requested-With:XMLHttpRequest, pode vir 200 com o HTML do login no body.
  const sessaoMorta =
    /\/(account|home)?\/?login/i.test(new URL(finalUrl).pathname) ||
    lastResp.status === 401 ||
    lastResp.status === 403 ||
    /name=["']?(Password|UserName|Email)["']?[^>]*type=["']?password|id=["']?(Password|UserName)["']?/i.test(lastResp.body || '');

  if (sessaoMorta) {
    throw new BllSessaoExpiradaError();
  }

  return { ...lastResp, finalUrl };
}

async function bllGet(db, path, headers = {}) {
  return bllFetch(db, path, { method: 'GET', headers });
}

// Por padrão form-urlencoded (BLL serializa o form DOM). Para JSON, passe
// header Content-Type explícito ou um body objeto.
async function bllPost(db, path, body, headers = {}) {
  return bllFetch(db, path, { method: 'POST', body, headers });
}

module.exports = {
  bllFetch,
  bllGet,
  bllPost,
  getSessionInfo,
  clearSession,
  BllSessaoIndisponivelError,
  BllSessaoExpiradaError,
  BLL_BASE,
  BLL_HOST,
  UA,
};
