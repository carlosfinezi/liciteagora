// auth-bootstrap.js
//
// NFSE-M06 onda 6.40 (2026-04-20): consolida autenticação inicial,
// session middleware, barreira requireAuth e static protegido.
//
// Multi-tenant (2026-04-22):
//   - session_secret vem do CONTROL DB (único global) para que o
//     Express valide cookies independente do tenant.
//   - sessions são gravadas no DB do TENANT atual via SqliteSessionStore
//     que usa stmt-cache lazy.
//   - api_key vira lookup-per-request no requireAuth (compat: quando
//     não há controlDb, o modo single-tenant legado continua válido).
//   - criarUsuarioInicial MOVEU para provisionamento via control-plane;
//     o boot do worker não toca no DB de tenants.
//   - Cookie de sessão é por subdomínio (sem `domain` explícito), para
//     isolar tenants: login em a.liciteagora.app NÃO sobrescreve a
//     sessão de b.liciteagora.app. Versão anterior usava
//     `.liciteagora.app` como domain compartilhado, que derrubava a
//     sessão do tenant A ao logar no tenant B (mesmo cookie SID no
//     browser, regerado pelo express-session).

const path = require('path');
const express = require('express');
const session = require('express-session');
const {
  createSessionStore,
  criarUsuarioInicial,
  getSessionSecret,
  getApiKey,
  requireAuth,
} = require('./auth');

// Modo multi-tenant: controlDb obrigatório (fonte do session_secret
// único global), db é o proxy do tenant atual. Session store grava
// sessions no DB do tenant resolvido por AsyncLocalStorage.
//
// Modo single-tenant (compat): controlDb = null → session_secret e
// api_key vêm do próprio db (comportamento antigo). Usado por
// scheduler.js e dev local.
function initAuthAndSession(app, db, { controlDb = null } = {}) {
  if (!controlDb) {
    // Compat single-tenant: cria schema de users/audit/sessions e
    // semeia admin/admin no db passado.
    criarUsuarioInicial(db);
  }

  const secretSource = controlDb || db;
  const sessionSecret = getSessionSecret(secretSource);

  // apiKey fixo só em compat single-tenant. Em multi-tenant passamos
  // null e o requireAuth resolve o api_key do tenant atual em runtime.
  const apiKey = controlDb ? null : getApiKey(db);

  const isProd = process.env.NODE_ENV === 'production';

  app.use(session({
    store: createSessionStore(session, db, controlDb),
    secret: sessionSecret,
    name: 'liciteagora.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      // Sem `domain`: cada subdomínio tenant tem seu próprio cookie,
      // evitando colisão de SID entre tenants no mesmo browser.
    },
  }));

  return { apiKey };
}

function installAuthBarrier(app, db, { apiKey }) {
  app.use(requireAuth(apiKey, db));
}

function installProtectedStatic(app) {
  app.use(express.static(path.join(__dirname, 'public')));
}

module.exports = { initAuthAndSession, installAuthBarrier, installProtectedStatic };
