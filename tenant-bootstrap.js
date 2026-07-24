// tenant-bootstrap.js
//
// Bootstrap multi-tenant do processo WORKER (HTTP). Substitui o
// db-bootstrap.js nessa role: não abre um pncp.db fixo — cria o
// tenant-manager (que gerencia control.db + pool de tenants) e
// devolve um `db` que é um Proxy dinâmico, resolvendo por request
// para o DB do tenant atual via tenant-middleware + AsyncLocalStorage.
//
// O MASTER (scheduler.js) continua usando db-bootstrap.js single-tenant
// até a Fase 5, quando passará a iterar tenants ativos.
//
// Retorna a mesma tupla de db-bootstrap para manter o contrato com
// route-registry.js e role-dispatch.js. A única diferença é que
// `dbPath` passa a ser uma função `() => currentTenant.db_path` —
// código que usa `dbPath` fora de contexto de request continua
// quebrando explicitamente (escolha consciente).

const { createTenantManager } = require('./tenant-manager');
const { createDbProxy, createTenantMiddleware, currentTenant } = require('./tenant-middleware');
const { initSchema } = require('./db-schema');
const { createPersistence } = require('./licitacoes-persistence');
const { createConfigHelpers } = require('./config-helpers');
const pncpSync = require('./pncp-sync-scheduler');

function bootstrapTenantAware({ processarFilaAnalise } = {}) {
  // 1) Tenant-manager + control.db (abre data/control.db, cria schema
  //    se não existir, prepara pool de tenants lazy).
  const manager = createTenantManager({ initSchema });

  // 2) Proxy de DB que resolve via AsyncLocalStorage.
  const db = createDbProxy();

  // 3) Persistência + config — factories reescritas para usar o proxy
  //    lazy (stmt-cache por DB real via db.__real).
  const { salvarItens } = createPersistence(db);
  const { getConfigValue, setConfigValue, getIAKeys } = createConfigHelpers(db);

  // 4) Motor PNCP — init guarda refs ao proxy e aos helpers derivados.
  //    No worker não é chamado iniciarSyncEngine/startMasterOnlyTimers;
  //    apenas getSyncStatus (pra UI) e as rotas /api/sync/* (que
  //    retornam 503 no worker).
  pncpSync.init({ db, processarFilaAnalise });

  // 5) Middleware para o Express — atacha tenant ao req e corre o
  //    restante da chain dentro do tenantStorage.run().
  //
  //    allowWithoutTenant: dá bypass para ACME challenges e health.
  //    Novas rotas "globais" (control-plane admin) usam req.tenantCtx
  //    para decidir acesso.
  const middleware = createTenantMiddleware({
    manager,
    allowWithoutTenant: (req) => {
      return req.path.startsWith('/.well-known/') || req.path === '/health' || req.path === '/api/whatsapp/webhook';
    },
  });

  // dbPath como getter dinâmico — mostra o caminho do tenant atual
  // se houver contexto, senão null. Código legado que imprime/usa
  // dbPath em contextos sem tenant (ex.: logStartupBanner) precisará
  // ser ajustado; esse é o "canário" de onde falta migração.
  const dbPath = function getCurrentDbPath() {
    const t = currentTenant();
    return t ? t.db_path : null;
  };

  return {
    db,
    dbPath,
    salvarItens,
    pncpSync,
    getConfigValue,
    setConfigValue,
    getIAKeys,
    manager,
    middleware,
  };
}

module.exports = { bootstrapTenantAware };
