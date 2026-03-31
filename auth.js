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

/**
 * Cria tabela users e usuario admin inicial
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

  const existente = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!existente) {
    const hash = bcrypt.hashSync('admin', 10);
    db.prepare('INSERT INTO users (username, passwordHash) VALUES (?, ?)').run('admin', hash);
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
 * Middleware requireAuth — redireciona para login ou retorna 401
 */
function requireAuth(apiKey) {
  return (req, res, next) => {
    // Bypass: webhook MercadoPago
    if (req.path === '/api/webhooks/mercadopago') return next();

    // Bypass: endpoints públicos do Electron (auto-update, erros, logs)
    if (req.path.startsWith('/api/electron/')) return next();

    // Bypass: extensão Chrome via X-Api-Key
    const headerKey = req.headers['x-api-key'];
    if (headerKey && headerKey === apiKey) return next();

    // Verificar sessão
    if (req.session && req.session.userId) return next();

    // Não autenticado
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Não autenticado' });
    }

    // Páginas HTML — redirecionar para login
    res.redirect('/login.html');
  };
}

module.exports = { createSessionStore, criarUsuarioInicial, getSessionSecret, getApiKey, requireAuth };
