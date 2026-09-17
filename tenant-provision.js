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

  /**
   * Três passadas, com isolamento por módulo (2026-09-11).
   *
   * ANTES: duas passadas, e um único try/catch em volta de
   * `registerProtectedRoutes`. A primeira exceção abortava a cadeia e todos os
   * módulos seguintes ficavam sem criar as tabelas deles — o tenant nascia com
   * ~277 tabelas em vez de ~374 e `POST /api/pedidos` respondia 500
   * (relatório 14 §1.5).
   *
   * AGORA: `isolarFalhasDeMigracao` faz o registry embrulhar cada módulo no
   * seu próprio try/catch e devolver a lista do que falhou. Um módulo quebrado
   * não impede os outros 123.
   *
   * Por que TRÊS passadas e não duas: as dependências de ordem são
   * encadeadas — o módulo A cria a tabela que o B altera, e o B cria a que o C
   * usa. Com duas, a terceira camada da cadeia ainda ficava para trás. A
   * passada extra custa segundos, só no provisionamento, e o critério de
   * parada é objetivo: se uma passada não deixa nenhuma falha nova, as
   * seguintes não teriam o que fazer.
   */
  let falhas = [];
  for (const pass of [1, 2, 3]) {
    const app = express();
    falhas = [];
    try {
      tenantStorage.run(
        { kind: 'tenant', tenant: tenantMeta, db: tenantDb },
        () => {
          try {
            const r = registerProtectedRoutes(app, { ...deps, isolarFalhasDeMigracao: true });
            falhas = (r && r.falhasDeMigracao) || [];
          } catch (err) {
            // Com isolamento ligado isto não deveria acontecer — se acontecer,
            // é falha fora dos módulos (o próprio registry), e precisa aparecer.
            console.error(`[tenant-provision pass${pass}] falha FORA dos módulos: ${err.message}`);
          }
        }
      );
    } catch (err) {
      console.warn(`[tenant-provision pass${pass} storage] ${err.message}`);
    }
    if (!falhas.length) break;   // nada mais a resolver nas próximas passadas
  }

  /**
   * A terceira camada de migrations: a do BOOT LOOP do server.js.
   *
   * Alguns módulos não migram no registro — o comentário deles diz o motivo
   * ("contra o proxy seria no-op"). Em vez disso, `server.js:140-149` itera os
   * tenants no boot e chama `migrarSchema(tdb)` de cada um. O provisionamento
   * **não fazia isso**, e por isso um tenant novo nascia sem
   * `faturas.faturaOrigemId`, `fatura_itens.valorDesconto` e o schema do
   * espelho de devolução (relatório 15).
   *
   * A lista é a mesma do boot, e é curta de propósito: se um módulo novo passar
   * a migrar por lá, precisa entrar aqui também. Enquanto a duplicação existir,
   * os dois pontos têm de ser lidos juntos.
   */
  for (const [modulo, metodo] of [
    ['./boleto-orchestrator', 'migrarSchema'],
    ['./devolucao-compra', 'migrarSchema'],
    ['./devolucao-venda', 'migrarSchema'],
    ['./marketplaces-ml', 'migrarSchemaTenant'],
  ]) {
    try { require(modulo)[metodo](tenantDb); }
    catch (err) { console.warn(`[tenant-provision] ${modulo}.${metodo}: ${err.message}`); }
  }

  // As falhas que sobreviveram às três passadas são reais: dependência que não
  // se resolve por ordem. Ficam visíveis em vez de silenciosas.
  if (falhas.length) {
    console.warn(`[tenant-provision] ${falhas.length} módulo(s) com falha de migração:`);
    for (const f of falhas) console.warn(`  - ${f.modulo}: ${f.erro}`);
  }

  // criarUsuarioInicial: cria users/audit_log/sessions + admin user +
  // api_key. Roda direto no tenantDb (não proxy).
  try { criarUsuarioInicial(tenantDb); }
  catch (err) { console.warn('[tenant-provision] criarUsuarioInicial falhou:', err.message); }

  /**
   * Segunda passada do db-schema — DEPOIS que os módulos E o criarUsuarioInicial
   * criaram as tabelas deles (2026-09-11, relatório 15).
   *
   * `db-schema.js` acumula dezenas de migrations de compatibilidade escritas
   * para tenants que JÁ EXISTIAM: `ALTER TABLE contas_a_receber ADD COLUMN
   * parcelaNumero`, `fatura_itens ADD COLUMN valorDesconto`, e assim por
   * diante. Só que `contas_a_receber` nasce em financeiro-routes e
   * `fatura_itens` em faturas-routes — os dois rodam DEPOIS. No provisionamento
   * de um tenant novo a ordem é o inverso da histórica: **212 ALTERs caíam em
   * "no such table"** e eram engolidos pelo `alterSafe`. As colunas nunca
   * nasciam, e `initSchema` roda uma vez só — as passadas de rota não o
   * repetem.
   *
   * Roda por ÚLTIMO de propósito: `users` só nasce em `criarUsuarioInicial`
   * (auth.js), e os ALTERs de `users` do db-schema precisam dela no lugar.
   *
   * Rodar `initSchema` de novo, agora com as tabelas no lugar, resolve a classe
   * inteira de uma vez — em vez de mover 212 ALTERs, um a um, para 40 módulos
   * diferentes.
   *
   * É seguro porque `initSchema` é idempotente por construção (`CREATE TABLE IF
   * NOT EXISTS`, `alterSafe`, seeds com guarda). Verificado em execução:
   * rodando duas vezes num banco limpo, **nenhuma das 199 tabelas muda de
   * contagem de linhas**.
   */
  try {
    const { initSchema } = require('./db-schema');
    initSchema(tenantDb);
  } catch (err) {
    console.warn('[tenant-provision] 2ª passada do db-schema falhou:', err.message);
  }


  tenantDb.pragma('foreign_keys = ON');
  return { falhasDeMigracao: falhas };
}

module.exports = { applyRouteMigrations };
