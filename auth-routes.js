/**
 * auth-routes.js
 * ------------------------------------------------------------------
 * Extraído do server.js (NFSE-M06 onda 6.31).
 *
 * Dois factories — split porque as rotas vivem em lados opostos da
 * barreira `app.use(requireAuth(...))`:
 *
 *   registrarRotasAuthPublicas(app, db)
 *     - POST /api/login    (com rate limit + uniform error anti-enumeração)
 *     - POST /api/logout
 *
 *   registrarRotasAuthProtegidas(app, db, { apiKey })
 *     - POST /api/change-password
 *     - GET  /api/auth/api-key
 *
 * O middleware session e a instalação de requireAuth continuam no
 * server.js (são infra de bootstrap, não rotas).
 *
 * Estado privado do rate-limiter (_loginAttempts Map + cleanup timer)
 * vive no escopo do módulo. O timer usa .unref() para não segurar o
 * event loop no shutdown — preserva o comportamento que tinha quando
 * morava inline no server.js.
 *
 * Observação: o comportamento SEC-03 de rate limit por IP (5 tentativas
 * falhas em 15 min → 429 por mais 15 min) e a mensagem uniforme para
 * usuário inexistente / senha errada / inativo (anti-enumeração) são
 * preservados byte-a-byte.
 */

const bcrypt = require('bcryptjs');

// ---------- Rate limiter state (privado do módulo) ----------
// IP → { fails, firstAt, blockedUntil }
const _loginAttempts = new Map();
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

// Cleanup periódico: libera entradas expiradas e janelas fora do limite.
// .unref() evita segurar o event loop ao encerrar.
setInterval(() => {
  const agora = Date.now();
  for (const [ip, st] of _loginAttempts) {
    if ((st.blockedUntil && st.blockedUntil < agora) || (agora - st.firstAt) > LOGIN_WINDOW_MS) {
      _loginAttempts.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

function _loginClientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Registra as rotas de autenticação PÚBLICAS (antes da barreira
 * requireAuth). POST /api/login aplica rate limit por IP + auditoria
 * best-effort de falhas.
 */
function registrarRotasAuthPublicas(app, db) {
  // Login (público) — SEC-03 (2026-04-18): rate limit por IP + mensagem uniforme
  // anti-enumeração. 5 tentativas falhas em 15 min → 429 por mais 15 min.
  app.post('/api/login', (req, res) => {
    const ip = _loginClientIp(req);
    const agora = Date.now();
    const st = _loginAttempts.get(ip);
    if (st && st.blockedUntil && st.blockedUntil > agora) {
      const retryIn = Math.ceil((st.blockedUntil - agora) / 1000);
      res.set('Retry-After', String(retryIn));
      return res.status(429).json({ success: false, error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
    }

    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'Informe usuário e senha' });

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const senhaOk = !!user && bcrypt.compareSync(password, user.passwordHash);
    // Mensagem uniforme — não diferencia usuário inexistente, senha errada ou inativo.
    if (!senhaOk || !user || user.ativo === 0) {
      const cur = _loginAttempts.get(ip) || { fails: 0, firstAt: agora, blockedUntil: 0 };
      if ((agora - cur.firstAt) > LOGIN_WINDOW_MS) { cur.fails = 0; cur.firstAt = agora; }
      cur.fails += 1;
      if (cur.fails >= LOGIN_MAX_FAILS) cur.blockedUntil = agora + LOGIN_BLOCK_MS;
      _loginAttempts.set(ip, cur);
      // Auditoria de tentativas falhas (best-effort)
      try {
        db.prepare(`INSERT INTO audit_log (username, action, entity, payload, ip) VALUES (?, 'login_fail', 'auth', ?, ?)`)
          .run(String(username).slice(0, 120), JSON.stringify({ reason: !user ? 'no_user' : (user.ativo === 0 ? 'inactive' : 'bad_password') }), ip);
      } catch { /* tabela pode não existir ainda em migração */ }
      return res.status(401).json({ success: false, error: 'Usuário ou senha incorretos' });
    }

    _loginAttempts.delete(ip); // sucesso limpa contador
    db.prepare('UPDATE users SET ultimoLogin = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true, username: user.username, nome: user.nome, role: user.role });
  });

  // Logout (público)
  app.post('/api/logout', (req, res) => {
    if (req.session) {
      req.session.destroy(() => {
        res.clearCookie('liciteagora.sid');
        res.json({ success: true });
      });
    } else {
      res.json({ success: true });
    }
  });

  console.log('[Auth] Rotas públicas registradas (/api/login, /api/logout)');
}

/**
 * Registra as rotas de autenticação PROTEGIDAS (depois da barreira
 * requireAuth). Dependem de req.session.userId ter sido setado pelo
 * login prévio.
 */
function registrarRotasAuthProtegidas(app, db, opts = {}) {
  const { apiKey } = opts;

  // Alterar senha (protegido)
  app.post('/api/change-password', (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Informe senha atual e nova' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user || !bcrypt.compareSync(currentPassword, user.passwordHash)) {
      return res.status(400).json({ error: 'Senha atual incorreta' });
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(hash, user.id);
    res.json({ success: true });
  });

  // API key para extensão (protegido)
  app.get('/api/auth/api-key', (req, res) => {
    res.json({ apiKey });
  });

  console.log('[Auth] Rotas protegidas registradas (/api/change-password, /api/auth/api-key)');
}

module.exports = { registrarRotasAuthPublicas, registrarRotasAuthProtegidas };
