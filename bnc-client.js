// bnc-client.js
//
// Cliente autenticado para bnccompras.com.
//
// IMPORTANTE: BNC não permite login server-side. O fluxo de login exige:
//   1) POST /Home/ProcessUserSession (sorteia pareamento aleatório do teclado virtual)
//   2) Clicar em botões "X ou Y" baseado nos pares sorteados (encoding *=0)
//   3) reCAPTCHA v2 invisible (sitekey 6LestvomAAAAAG9MNzlBaMEufF1QLdpKoL48qGsq)
//   4) POST /Home/Login?password=<12chars>&email=...&token=<recaptcha>
//   5) Possível modal "Escolha de perfil"
//
// Por isso a sessão é capturada pelo app electron-bnc (Chromium real) e
// enviada ao servidor via POST /api/electron/bnc/cookies. Aqui só consumimos.
//
// Cookies persistem em `config`:
//   - bnc_session_cookie  → string "name1=value1; name2=value2; ..."
//   - bnc_session_at      → ISO timestamp da última captura
//   - bnc_session_user    → usuário/email logado (pra detectar troca)
//   - bnc_session_perfil  → perfil escolhido (multi-perfil) — opcional
//
// Exports:
//   - bncFetch(db, path, { method, body, headers })   → { status, body, headers, finalUrl }
//   - bncGet(db, path)
//   - bncPost(db, path, body)
//   - getSessionInfo(db)                              → { configurado, idadeMs, usuario, perfil }
//   - clearSession(db)
//
// Erros tipados:
//   - BncSessaoIndisponivelError : sem cookie em config (electron nunca logou ou foi limpa)
//   - BncSessaoExpiradaError     : servidor BNC indicou que cookie morreu (redirect pra Login)

const https = require('https');

const BNC_HOST = 'bnccompras.com';
const BNC_BASE = `https://${BNC_HOST}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1h — heurística; servidor real pode invalidar antes

class BncSessaoIndisponivelError extends Error {
  constructor(msg = 'Sessão BNC não configurada. Abra o app LiciteAgora BNC e faça login.') {
    super(msg);
    this.name = 'BncSessaoIndisponivelError';
    this.code = 'BNC_SEM_SESSAO';
  }
}

class BncSessaoExpiradaError extends Error {
  constructor(msg = 'Sessão BNC expirou. Abra o app LiciteAgora BNC pra renovar.') {
    super(msg);
    this.name = 'BncSessaoExpiradaError';
    this.code = 'BNC_SESSAO_EXPIRADA';
  }
}

// ─── leitura/escrita de cookies em config ──────────────────────────────────

function readSessionFromDb(db) {
  const cookie = db.prepare("SELECT valor FROM config WHERE chave='bnc_session_cookie'").get();
  if (!cookie?.valor) return null;
  const at = db.prepare("SELECT valor FROM config WHERE chave='bnc_session_at'").get();
  const user = db.prepare("SELECT valor FROM config WHERE chave='bnc_session_user'").get();
  const perfil = db.prepare("SELECT valor FROM config WHERE chave='bnc_session_perfil'").get();
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
    ('bnc_session_cookie','bnc_session_at','bnc_session_user','bnc_session_perfil')`).run();
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

async function bncFetch(db, urlPath, { method = 'GET', body = null, headers = {}, followRedirects = true } = {}) {
  const session = readSessionFromDb(db);
  if (!session) throw new BncSessaoIndisponivelError();

  let cur = urlPath.startsWith('http') ? urlPath : BNC_BASE + urlPath;
  let lastResp = null;
  let finalUrl = cur;

  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(cur);
    const opts = {
      method,
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: session.cookie,
        ...headers,
      },
    };
    if (body) {
      const buf = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(buf);
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json;charset=utf-8';
      lastResp = await requestPromise(opts, buf);
    } else {
      lastResp = await requestPromise(opts);
    }
    finalUrl = cur;

    if (followRedirects && [301, 302, 303, 307, 308].includes(lastResp.status)) {
      const loc = lastResp.headers.location;
      if (!loc) break;
      cur = loc.startsWith('http') ? loc : new URL(loc, cur).toString();
      // só GET nos redirects (303 e 302 sempre, 307/308 preservam mas trataremos como GET pra simplicidade)
      method = 'GET';
      body = null;
      continue;
    }
    break;
  }

  // Detectar sessão expirada: BNC redireciona pra /Home/Login quando cookie morre
  // ou retorna 401/403. Como bncFetch chama com X-Requested-With:XMLHttpRequest,
  // o servidor MVC pode devolver 200 com HTML da página de login no body.
  // BNC também responde 200 redirecionando pra /Base/UserErrorLoad com a
  // mensagem "Você não está autenticado" quando a sessão morre (2026-07-14).
  const sessaoMorta =
    finalUrl.includes('/Home/Login') ||
    finalUrl.includes('/Base/UserErrorLoad') ||
    lastResp.status === 401 ||
    lastResp.status === 403 ||
    /id="Email"\s+name="Email"|id="Password"\s+name="Password"/.test(lastResp.body || '') ||
    /n[aã]o est[aá] autenticado/i.test(lastResp.body || '');

  if (sessaoMorta) {
    throw new BncSessaoExpiradaError();
  }

  return { ...lastResp, finalUrl };
}

async function bncGet(db, path, headers = {}) {
  return bncFetch(db, path, { method: 'GET', headers });
}

async function bncPost(db, path, body, headers = {}) {
  return bncFetch(db, path, { method: 'POST', body, headers });
}

module.exports = {
  bncFetch,
  bncGet,
  bncPost,
  getSessionInfo,
  clearSession,
  BncSessaoIndisponivelError,
  BncSessaoExpiradaError,
  BNC_BASE,
  UA,
};
