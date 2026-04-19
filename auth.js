/**
 * auth.js — Autenticação e sessões para o Licite Agora
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

/**
 * Cria SqliteSessionStore como subclasse de session.Store
 */
function createSessionStore(session, db) {
  const Store = session.Store;

  function SqliteSessionStore() {
    Store.call(this);

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `);

    this._get = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?');
    this._set = db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)');
    this._destroy = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._cleanup = db.prepare('DELETE FROM sessions WHERE expired < ?');

    // Limpar sessoes expiradas a cada 15 min
    setInterval(() => this._cleanup.run(Date.now()), 15 * 60 * 1000).unref();
  }

  SqliteSessionStore.prototype = Object.create(Store.prototype);
  SqliteSessionStore.prototype.constructor = SqliteSessionStore;

  SqliteSessionStore.prototype.get = function(sid, callback) {
    try {
      const row = this._get.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      callback(err);
    }
  };

  SqliteSessionStore.prototype.set = function(sid, sess, callback) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge) || 7 * 24 * 60 * 60 * 1000;
      const expired = Date.now() + maxAge;
      this._set.run(sid, JSON.stringify(sess), expired);
      callback(null);
    } catch (err) {
      callback(err);
    }
  };

  SqliteSessionStore.prototype.destroy = function(sid, callback) {
    try {
      this._destroy.run(sid);
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
 * Migra users legados para role='admin' (compat retroativo).
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

  // Migrações idempotentes
  for (const col of [
    "nome TEXT",
    "email TEXT",
    "role TEXT NOT NULL DEFAULT 'admin'",
    "ativo INTEGER NOT NULL DEFAULT 1",
    "ultimoLogin TEXT"
  ]) {
    alterSafe(db, `ALTER TABLE users ADD COLUMN ${col}`);
  }

  // Tabela de auditoria
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
}

/**
 * Obtém ou gera o session secret (salvo na tabela config)
 */
function getSessionSecret(db) {
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
 * Obtém ou gera a API key para extensão Chrome
 */
function getApiKey(db) {
  const getConfig = db.prepare('SELECT valor FROM config WHERE chave = ?');
  const setConfig = db.prepare('INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)');

  let key = getConfig.get('api_key')?.valor;
  if (!key) {
    key = crypto.randomBytes(32).toString('hex');
    setConfig.run('api_key', key);
    console.log(`[Auth] API Key gerada para extensão: ${key}`);
  }
  return key;
}

/**
 * Middleware requireAuth — redireciona para login ou retorna 401.
 * Quando autenticado por sessão, injeta req.user = { id, username, nome, role, email, ativo }.
 */
function requireAuth(apiKey, db) {
  const getUser = db ? db.prepare('SELECT id, username, nome, email, role, ativo FROM users WHERE id = ?') : null;

  return (req, res, next) => {
    // Bypass: webhook MercadoPago
    if (req.path === '/api/webhooks/mercadopago') return next();

    // Bypass: endpoints públicos do Electron — somente os estritamente necessários para
    // auto-update e coleta de logs/erros antes do bootstrap de sessão.
    // SEC-01 (2026-04-18): /credentials NÃO está aqui — requer X-Api-Key explícito no handler.
    // /errors e /status não bypassam mais porque expõem logs/estado do cliente.
    const electronPublic = new Set([
      '/api/electron/download',
      '/api/electron/download-exe',
      '/api/electron/check-version',
      '/api/electron/error',
      '/api/electron/logs'
    ]);
    if (electronPublic.has(req.path)) return next();

    // Bypass: portal externo do cliente (auth próprio via cliente_logins)
    if (req.path.startsWith('/portal/')) return next();

    // Bypass: extensão Chrome via X-Api-Key (sem req.user — atua como sistema)
    const headerKey = req.headers['x-api-key'];
    if (headerKey && headerKey === apiKey) return next();

    // Verificar sessão
    if (req.session && req.session.userId) {
      if (getUser) {
        const user = getUser.get(req.session.userId);
        if (user && user.ativo) {
          req.user = user;
          return next();
        }
        // Usuário foi inativado/deletado — destruir sessão
        req.session.destroy(() => {});
      } else {
        return next();
      }
    }

    // Não autenticado
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Não autenticado' });
    }

    // Páginas HTML — redirecionar para login
    res.redirect('/login.html');
  };
}

/**
 * Factory de middleware: exige que req.user.role esteja em roles.
 * Extensão Chrome (X-Api-Key) passa por sem checagem (req.user undefined → assume sistema).
 */
function requireRole(roles) {
  const allowed = new Set(Array.isArray(roles) ? roles : [roles]);
  return (req, res, next) => {
    if (!req.user) return next(); // X-Api-Key bypass — atua como sistema
    if (allowed.has(req.user.role)) return next();
    res.status(403).json({ error: 'Acesso negado: perfil insuficiente' });
  };
}

module.exports = { createSessionStore, criarUsuarioInicial, getSessionSecret, getApiKey, requireAuth, requireRole, ROLES };
