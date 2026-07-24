// tenant-provision.js
//
// Aplica todas as migrations espalhadas em *-routes.js num DB de
// tenant NOVO. Em vez de centralizar os CREATE TABLE / ALTER TABLE /
// seeds em db-schema.js (seriam ~40 tabelas reescritas, cada uma com
// risco de desincronização versus a versão "canônica" do módulo),
// reusamos o próprio registerProtectedRoutes num app Express
// throwaway — cada migrarDB() é chamado normalmente e cria suas
// tabelas no DB do tenant atual (resolvido via AsyncLocalStorage).
//
// Side effects aceitos durante o throwaway:
//   - handlers são registrados no app descartado (nunca usado)
//   - alguns módulos fazem console.log de "rotas registradas"
//   - loops timers unref() em pncpSync/monitor-v2 não disparam pois
//     seu estado global foi inicializado uma vez no boot do worker
//
// Depois do provision, a função criarUsuarioInicial também é
// executada para garantir schema de users/sessions/audit_log +
// admin user + api_key, igual ao que o worker fazia no single-tenant.

const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const { tenantStorage, createDbProxy } = require('./tenant-middleware');
const { registerProtectedRoutes } = require('./route-registry');
const { criarUsuarioInicial } = require('./auth');
const { processarFilaAnalise } = require('./analise-ia');
const { createPersistence } = require('./licitacoes-persistence');
const { createConfigHelpers } = require('./config-helpers');
const { attachCatalog, CATALOG_DB_PATH } = require('./catalog-manager');
const fs = require('fs');
const pncpSync = require('./pncp-sync-scheduler');

// Proxy é compartilhado (mesmo do server). registerProtectedRoutes
// recebe este proxy e as dependências derivadas dele.
let _provisionDeps = null;

function getProvisionDeps() {
  if (_provisionDeps) return _provisionDeps;
  const db = createDbProxy();
  const { salvarItens } = createPersistence(db);
  const { getConfigValue, setConfigValue, getIAKeys } = createConfigHelpers(db);
  _provisionDeps = {
    db, salvarItens, pncpSync, getConfigValue, setConfigValue, getIAKeys,
    dbPath: () => null,
  };
  return _provisionDeps;
}

// Aplica as migrations de TODOS os módulos de rota no DB do tenant.
// Precisa ser chamado APÓS initSchema(tenantDb).
function applyRouteMigrations(tenantDb, tenantMeta = {}) {
  const deps = getProvisionDeps();

  // Desliga FK durante a migração — alguns seeds/ALTERs tocam tabelas
  // que ainda serão criadas em passos seguintes (ordem entre módulos
  // é frágil). Religamos depois.
  tenantDb.pragma('foreign_keys = OFF');

  // Fase 8: ATTACH catalog.db para que views estejam disponíveis e
  // escritas no catálogo (bi-routes, pedidos-routes, analise-ia-routes)
  // não quebrem durante as passadas de migração.
  if (fs.existsSync(CATALOG_DB_PATH)) {
    try { attachCatalog(tenantDb); } catch (_) { /* best-effort */ }
  }

  // Faz DUAS passadas — a ordem em route-registry.js tem dependências
  // implícitas (cobrancas-routes tenta ALTER em pessoas criada por
  // financeiro-routes que vem depois). Na 1ª passada, erros são
  // silenciados. Na 2ª, todas as tabelas já existem e os ALTERs
  // pendentes rodam.
  for (const pass of [1, 2]) {
    const app = express();
    try {
      tenantStorage.run(
        { kind: 'tenant', tenant: tenantMeta, db: tenantDb },
        () => {
          try {
            registerProtectedRoutes(app, deps);
          } catch (err) {
            console.warn(`[tenant-provision pass${pass}] ${err.message}`);
          }
        }
      );
    } catch (err) {
      console.warn(`[tenant-provision pass${pass} storage] ${err.message}`);
    }
  }

  // criarUsuarioInicial: cria users/audit_log/sessions + admin user +
  // api_key. Roda direto no tenantDb (não proxy).
  try { criarUsuarioInicial(tenantDb); }
  catch (err) { console.warn('[tenant-provision] criarUsuarioInicial falhou:', err.message); }

  tenantDb.pragma('foreign_keys = ON');
}

module.exports = { applyRouteMigrations };
