// auth-bootstrap.js
//
// NFSE-M06 onda 6.40 (2026-04-20): consolida autenticacao inicial +
// session middleware + barreira requireAuth + static protegido do
// server.js em tres funcoes expostas na ordem de boot.
//
// Ordem de chamada NO server.js (preservada 1:1 com a onda 6.39):
//
//   1. initAuthAndSession(app, db) -> { apiKey }
//        - criarUsuarioInicial(db)  (seed admin/admin se nao existir)
//        - getSessionSecret(db)    (rotaciona em 30 dias)
//        - getApiKey(db)           (chave de API para X-Api-Key)
//        - app.use(session({ ... }))
//
//   2. registrarRotasAuthPublicas(app, db)   [em server.js]
//   3. registerPreAuthRoutes(app, db, { apiKey })  [em server.js]
//
//   4. installAuthBarrier(app, db, { apiKey })
//        - app.use(requireAuth(apiKey, db))  (barreira das rotas /api/*)
//
//   5. registrarRotasAuthProtegidas(app, db, { apiKey })  [em server.js]
//
//   6. installProtectedStatic(app)
//        - app.use(express.static(path.join(__dirname, 'public')))
//        APOS rotas de API -- nao intercepta.
//
//   7. registerProtectedRoutes(app, { ... })  [em server.js]
//
// Observacao: apiKey retornado por initAuthAndSession e consumido
// diretamente por installAuthBarrier, por registrarRotasAuthProtegidas,
// por registerPreAuthRoutes e pelo createRoleDispatch. O caller
// repassa apiKey manualmente para esses consumers.

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

function initAuthAndSession(app, db) {
  criarUsuarioInicial(db);
  const sessionSecret = getSessionSecret(db);
  const apiKey = getApiKey(db);

  // Session middleware (antes de tudo que precisa de sessao)
  app.use(session({
    store: createSessionStore(session, db),
    secret: sessionSecret,
    name: 'liciteagora.sid',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: false },
  }));

  return { apiKey };
}

function installAuthBarrier(app, db, { apiKey }) {
  // Tudo abaixo requer autenticacao (exceto webhook e X-Api-Key).
  app.use(requireAuth(apiKey, db));
}

function installProtectedStatic(app) {
  // Arquivos estaticos protegidos (APOS rotas de API para nao interceptar).
  app.use(express.static(path.join(__dirname, 'public')));
}

module.exports = { initAuthAndSession, installAuthBarrier, installProtectedStatic };
