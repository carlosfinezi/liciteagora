// auth-pipeline.js
//
// NFSE-M06 onda 6.43 (2026-04-20): wiring completo da autenticacao
// consolidado em uma unica chamada de 6 passos. Antes desta onda, o
// server.js tinha esses passos interlevados em ~20 linhas com 3
// requires separados (auth-bootstrap, auth-routes, pre-auth-routes).
//
// Ordem CRITICA (tudo acima da barreira aceita publico; tudo abaixo
// exige autenticacao, exceto webhook + X-Api-Key):
//
//   1. initAuthAndSession(app, db)           -> cria admin inicial,
//      rotaciona sessionSecret, gera apiKey, instala session middleware.
//      Retorna { apiKey }.
//   2. registrarRotasAuthPublicas(app, db)   -> POST /api/login (com
//      rate limit SEC-03), POST /api/logout. Publicas.
//   3. registerPreAuthRoutes(app, db, { apiKey }) -> Portal do Cliente,
//      download publico do Browser, auto-login Comprasnet, Electron
//      remoto. Fica ANTES da barreira, preservando a ordem portal >
//      download > comprasnet > electron.
//   4. installAuthBarrier(app, db, { apiKey }) -> app.use(requireAuth)
//      -- tudo abaixo exige sessao valida ou X-Api-Key.
//   5. registrarRotasAuthProtegidas(app, db, { apiKey }) -> /api/change-password,
//      /api/auth/api-key. Protegidas.
//   6. installProtectedStatic(app) -> app.use(express.static('public'))
//      apos as rotas de API para nao interceptar.
//
// Nao e re-entrant -- chamar duas vezes duplica todos os app.use().
//
// Retorna { apiKey } para que o caller possa injetar o mesmo valor
// em consumers downstream (role-dispatch banner, ou qualquer factory
// que precise validar X-Api-Key).

const { initAuthAndSession, installAuthBarrier, installProtectedStatic } = require('./auth-bootstrap');
const { registrarRotasAuthPublicas, registrarRotasAuthProtegidas } = require('./auth-routes');
const { registerPreAuthRoutes } = require('./pre-auth-routes');
const { registerControlPlaneRoutes } = require('./control-plane-routes');
const { registerLandingRoutes } = require('./landing-routes');

// Multi-tenant (2026-04-22): quando `controlDb` é passado, o pipeline
// entra em modo multi-tenant — session_secret vem do control.db,
// o api_key é resolvido por-request no requireAuth via req.tenantDb,
// e o control plane (/api/admin/*) é montado antes do authBarrier
// (auth própria via super_admins). Quando omitido, mantém o
// comportamento single-tenant legado.
function installAuthPipeline(app, db, { controlDb = null, tenantManager = null } = {}) {
  const { apiKey } = initAuthAndSession(app, db, { controlDb });

  registrarRotasAuthPublicas(app, db);
  registerPreAuthRoutes(app, db, { apiKey });

  if (controlDb && tenantManager) {
    registerControlPlaneRoutes(app, { controlDb, manager: tenantManager });
    // Landing page no apex — público (GET / e assets + POST /api/landing/signup + trial)
    registerLandingRoutes(app, { controlDb, tenantManager });
  }

  installAuthBarrier(app, db, { apiKey });

  registrarRotasAuthProtegidas(app, db, { apiKey });
  installProtectedStatic(app, db);

  return { apiKey };
}

module.exports = { installAuthPipeline };
