/**
 * auth.js — Autenticação e sessões para o Licite Agora
 *
 * Multi-tenant (2026-04-22):
 *   - session_secret vive no control.db (único, global) — passado via
 *     `controlDb` nas factories que precisam.
 *   - Sessions (tabela `sessions`) vivem no DB de cada tenant. O
 *     SqliteSessionStore usa stmt-cache para preparar statements lazy
 *     contra o DB atual (resolvido por AsyncLocalStorage).
 *   - `api_key` vive no DB de cada tenant. `requireAuth` lê o api_key
 *     do `req.tenant.db` em cada request (custa ~0.01ms com cache).
 *   - `criarUsuarioInicial` NÃO roda mais no boot do worker — é chamada
 *     em control-plane-routes ao CREATE TENANT.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createStmtCache } = require('./stmt-cache');

/**
 * Cria SqliteSessionStore. Em multi-tenant, `db` é um Proxy que
 * resolve para o DB do tenant atual via AsyncLocalStorage. Quando
 * não há tenant no contexto (ex.: admin.liciteagora.app, apex), a
 * sessão é persistida em `controlDb` (fallback global).
 *
 * Em single-tenant (legado), `db` é um Database direto e controlDb
 * é null.
 */
function createSessionStore(session, db, controlDb = null) {
  const Store = session.Store;
  const stmt = createStmtCache();

  const SQL_GET = 'SELECT sess FROM sessions WHERE sid = ? AND expired > ?';
  const SQL_SET = 'INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)';
  const SQL_DESTROY = 'DELETE FROM sessions WHERE sid = ?';
  const SQL_CLEANUP = 'DELETE FROM sessions WHERE expired < ?';

  function ensureTable(database) {
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          sid TEXT PRIMARY KEY,
          sess TEXT NOT NULL,
          expired INTEGER NOT NULL
        )
      `);
    } catch (_) { /* no-op */ }
  }

  // Em single-tenant, cria tabela no db direto. Em multi-tenant, a
  // tabela vem do initSchema por-tenant, e controlDb precisa dela
  // (criada abaixo).
  try {
    if (db && typeof db.exec === 'function' && db.__real === undefined) {
      ensureTable(db);
    }
  } catch (_) { /* proxy em contexto vazio — ok */ }
  if (controlDb) ensureTable(controlDb);

  // Resolve qual DB usar para a sessão atual: se estamos dentro de um
  // request com tenant, usa o proxy (tenant DB). Caso contrário (admin,
  // apex, ou boot), usa controlDb.
  function resolveDb() {
    if (!controlDb) return db; // single-tenant legado
    // Proxy expõe __real como o DB atual; se não há tenant no contexto,
    // __real é null e caímos em controlDb.
    const real = db.__real;
    return real || controlDb;
  }

  function SqliteSessionStore() {
    Store.call(this);
    // Limpeza periódica — roda no DB que estiver resolvível.
    setInterval(() => {
      try { stmt(resolveDb(), SQL_CLEANUP).run(Date.now()); } catch (_) { /* */ }
    }, 15 * 60 * 1000).unref();
  }

  SqliteSessionStore.prototype = Object.create(Store.prototype);
  SqliteSessionStore.prototype.constructor = SqliteSessionStore;

  SqliteSessionStore.prototype.get = function(sid, callback) {
    try {
      const row = stmt(resolveDb(), SQL_GET).get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      callback(err);
    }
  };

  SqliteSessionStore.prototype.set = function(sid, sess, callback) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge) || 7 * 24 * 60 * 60 * 1000;
      const expired = Date.now() + maxAge;
      stmt(resolveDb(), SQL_SET).run(sid, JSON.stringify(sess), expired);
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  SqliteSessionStore.prototype.destroy = function(sid, callback) {
    try {
      stmt(resolveDb(), SQL_DESTROY).run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  return new SqliteSessionStore();
}

// Perfis disponíveis (cada perfil corresponde a um conjunto de áreas do menu)
const ROLES = ['admin', 'financeiro', 'comercial', 'operacional', 'licitacoes'];

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna ja existe */ } }

/**
 * Cria tabela users, audit_log e usuario admin inicial.
 *
 * Chamada em dois momentos:
 *   - provisionamento de tenant (via control-plane): criarUsuarioInicial(db)
 *     cria admin/admin se não existir
 *   - bootstrap single-tenant legado (scheduler.js / dev): idem
 *
 * NÃO é mais chamada no worker HTTP (multi-tenant) — cada tenant já
 * tem admin criado quando provisionado.
 */
function criarUsuarioInicial(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const col of [
    "nome TEXT",
    "email TEXT",
    "role TEXT NOT NULL DEFAULT 'admin'",
    "ativo INTEGER NOT NULL DEFAULT 1",
    "ultimoLogin TEXT",
    // Multi-loja RBAC (Fase 4.3): NULL = acesso a todos os estabelecimentos;
    // um id = usuário restrito àquela loja (escopo forçado em getEstabelecimentoAtivo).
    "estabelecimentoId INTEGER",
    // Tema visual escolhido pelo usuário (padrao/grafite/meianoite/claro) — /api/user/prefs
    "tema TEXT"
  ]) {
    alterSafe(db, `ALTER TABLE users ADD COLUMN ${col}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entityId TEXT,
      payload TEXT,
      ip TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(userId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entityId);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(createdAt);
  `);

  // Garante que a tabela sessions também exista (sem ela, o session
  // middleware falha na primeira escrita).
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired INTEGER NOT NULL
    )
  `);

  const existente = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!existente) {
    const hash = bcrypt.hashSync('admin', 10);
    db.prepare("INSERT INTO users (username, passwordHash, nome, role, ativo) VALUES (?, ?, ?, 'admin', 1)").run('admin', hash, 'Administrador');
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  USUARIO INICIAL CRIADO: admin / admin       ║');
    console.log('║  TROQUE A SENHA IMEDIATAMENTE!               ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
  }

  // Cria/garante api_key do tenant (usado pelo Electron remoto).
  const apiKeyRow = db.prepare("SELECT valor FROM config WHERE chave = 'api_key'").get();
  if (!apiKeyRow) {
    const key = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)')
      .run('api_key', key);
  }
}

/**
 * Obtém ou gera o session secret (salvo na tabela config).
 *
 * Em multi-tenant, deve ser chamada com o `controlDb` (único secret
 * global) — o worker guarda em memória e passa para o Express session.
 */
function getSessionSecret(db) {
  // Garante tabela antes de preparar (control.db ainda não tem config
  // em boot virgem; tenant db já tem via initSchema).
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      chave TEXT PRIMARY KEY,
      valor TEXT,
      dataAtualizacao TEXT
    )
  `);

  const getConfig = db.prepare('SELECT valor FROM config WHERE chave = ?');
  const setConfig = db.prepare('INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)');

  let secret = getConfig.get('session_secret')?.valor;
  if (!secret) {
    secret = crypto.randomBytes(48).toString('hex');
    setConfig.run('session_secret', secret);
  }
  return secret;
}

/**
 * Legado single-tenant: lê api_key do tenant único. No worker
 * multi-tenant, requireAuth lê em tempo-real do req.tenant.db.
 */
function getApiKey(db) {
  const getConfig = db.prepare('SELECT valor FROM config WHERE chave = ?');
  const setConfig = db.prepare('INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)');

  let key = getConfig.get('api_key')?.valor;
  if (!key) {
    key = crypto.randomBytes(32).toString('hex');
    setConfig.run('api_key', key);
    console.log(`[Auth] API Key gerada: ${key}`);
  }
  return key;
}

/**
 * Middleware requireAuth.
 *
 * Em multi-tenant, `apiKey` é ignorado (pode ser null) — a validação
 * do header X-Api-Key é feita contra o `api_key` do tenant atual,
 * lido do `req.tenant.db` em tempo real. A lookup usa stmt-cache,
 * então é barata (~microsegundos).
 */
function requireAuth(apiKey, db) {
  const stmt = createStmtCache();
  const SQL_GET_USER = 'SELECT id, username, nome, email, role, ativo, estabelecimentoId FROM users WHERE id = ?';
  const SQL_GET_API_KEY = "SELECT valor FROM config WHERE chave = 'api_key'";

  return (req, res, next) => {
    // Bypass: webhook MercadoPago
    if (req.path === '/api/webhooks/mercadopago') return next();

    // Bypass: endpoints públicos do Electron
    const electronPublic = new Set([
      '/api/electron/download',
      '/api/electron/download-exe',
      '/api/electron/download-installer',
      '/api/electron/check-version',
      '/api/electron/error',
      '/api/electron/logs'
    ]);
    if (electronPublic.has(req.path)) return next();

    // Bypass: feed do electron-updater (latest.yml + instalador + blockmap).
    // O cliente NSIS (electron-updater) não envia X-Api-Key nessas requisições;
    // são binários públicos. A rota faz whitelist de nomes (anti path-traversal).
    if (req.path.startsWith('/api/electron/updates/')) return next();

    // Bypass: callback OAuth + webhook de notificações do Mercado Livre (apex, sem sessão —
    // o ML chama sem auth; o tenant é resolvido pelo state/user_id).
    if (req.path === '/api/marketplaces/ml/callback') return next();
    if (req.path === '/api/marketplaces/ml/webhook') return next();

    // Bypass: portal externo do cliente
    if (req.path.startsWith('/portal/')) return next();

    // Bypass: control plane (admin.liciteagora.app) — auth própria
    // via super_admins na tabela do control.db.
    if (req.path.startsWith('/api/admin/')) return next();

    // Bypass: orçamento público de OS — auth é via token criptográfico
    // na URL (ver os-routes.js GET/POST /api/orcamento/:token/*).
    // Token é 64 chars hex aleatório; rate-limit interno no handler.
    if (req.path.startsWith('/api/orcamento/')) return next();

    // Bypass X-Api-Key — valida contra o api_key do tenant atual.
    const headerKey = req.headers['x-api-key'];
    if (headerKey && req.tenant) {
      try {
        const row = stmt(req.tenantDb, SQL_GET_API_KEY).get();
        if (row && row.valor === headerKey) return next();
      } catch (_) { /* sem contexto de tenant; cai fora */ }
    }
    // Fallback compat single-tenant: valida contra apiKey fixo.
    if (headerKey && apiKey && headerKey === apiKey) return next();

    // Verificar sessão
    if (req.session && req.session.userId) {
      const userDb = req.tenantDb || db;
      if (userDb) {
        try {
          const user = stmt(userDb, SQL_GET_USER).get(req.session.userId);
          if (user && user.ativo) {
            req.user = user;
            return next();
          }
        } catch (_) { /* no tenant / no user */ }
        req.session.destroy(() => {});
      } else {
        return next();
      }
    }

    // Não autenticado
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    res.redirect('/login.html');
  };
}

/**
 * Factory de middleware: exige que req.user.role esteja em roles.
 * X-Api-Key (req.user undefined) passa por sem checagem (atua como sistema).
 */
function requireRole(roles) {
  const allowed = new Set(Array.isArray(roles) ? roles : [roles]);
  return (req, res, next) => {
    if (!req.user) return next(); // X-Api-Key bypass
    if (allowed.has(req.user.role)) return next();
    res.status(403).json({ error: 'Acesso negado: perfil insuficiente' });
  };
}

module.exports = { createSessionStore, criarUsuarioInicial, getSessionSecret, getApiKey, requireAuth, requireRole, ROLES };
