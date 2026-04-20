// db-bootstrap.js
//
// NFSE-M06 onda 6.41 (2026-04-20): consolida a inicializacao da camada
// de dados do server.js em uma unica funcao. Reune cinco passos que
// antes viviam no topo do server.js em ~38 linhas comentadas:
//
//   1. Abre better-sqlite3 em pncp.db (dbPath = <__dirname>/pncp.db)
//   2. initSchema(db)                           -- db-schema.js
//   3. createPersistence(db)                    -- licitacoes-persistence.js
//   4. pncpSync.init({ db, processarFilaAnalise }) -- pncp-sync-scheduler.js
//   5. createConfigHelpers(db)                  -- config-helpers.js
//
// Retorna a tupla minima consumida pelo resto do server.js e pelas
// factories downstream (route-registry, role-dispatch, auth-bootstrap):
//
//   { db, dbPath, salvarItens, pncpSync,
//     getConfigValue, setConfigValue, getIAKeys }
//
// salvarLicitacao e analisarLicitacao eram destructured no server.js
// sem consumer -- agora ficam internas aos modulos que realmente os
// usam (pncp-sync-scheduler e analise-ia respectivamente). Se um dia
// server.js precisar de salvarLicitacao de novo, basta adicionar ao
// objeto de retorno aqui.
//
// Ordem de chamada: db-bootstrap roda ANTES de qualquer factory de
// rota ou scheduler que precise de db, pncpSync ou dos configHelpers.
// No worker (server.js) eh chamado logo apos o applyBaseMiddleware;
// o scheduler (scheduler.js) nao usa db-bootstrap -- ele instancia
// diretamente pois tem necessidades de boot diferentes (iniciarSync +
// startMasterOnlyTimers + ciclo de vida master).
//
// Nao e re-entrant: abrir pncp.db duas vezes no mesmo processo e
// benigno com better-sqlite3 (novas handles), mas duplicaria o
// initSchema e o pncpSync.init.

const path = require('path');
const Database = require('better-sqlite3');

const { initSchema } = require('./db-schema');
const { createPersistence } = require('./licitacoes-persistence');
const { createConfigHelpers } = require('./config-helpers');
const pncpSync = require('./pncp-sync-scheduler');

function bootstrapDatabase({ processarFilaAnalise }) {
  const dbPath = path.join(__dirname, 'pncp.db');
  const db = new Database(dbPath);

  // 1) Schema + migracoes ad-hoc idempotentes.
  initSchema(db);

  // 2) Persistencia de licitacao/itens. salvarLicitacao nao eh
  //    exposto porque nao ha consumer em server.js -- o motor PNCP
  //    usa sua propria referencia via pncp-sync-scheduler.
  const { salvarItens } = createPersistence(db);

  // 3) Motor PNCP + schedulers master-only. No worker o init e um
  //    no-op para os schedulers; apenas prepara getSyncStatus() e
  //    faz /api/sync/* responder 503 (gate ROLE=worker).
  pncpSync.init({ db, processarFilaAnalise });

  // 4) Helpers de config (getConfigValue/setConfigValue/getIAKeys).
  const { getConfigValue, setConfigValue, getIAKeys } = createConfigHelpers(db);

  return {
    db,
    dbPath,
    salvarItens,
    pncpSync,
    getConfigValue,
    setConfigValue,
    getIAKeys,
  };
}

module.exports = { bootstrapDatabase };
