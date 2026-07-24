#!/usr/bin/env node
// migrate-all-tenants.js — aplica db-schema.js (CREATE IF NOT EXISTS,
// ALTER idempotente, seeds) em TODOS os tenants ACTIVE/TRIAL.
//
// Uso: node scripts/migrate-all-tenants.js
//
// Precisa ser rodado sempre que:
//   - Nova tabela adicionada em db-schema.js
//   - Nova coluna via ALTER TABLE
//   - Novo seed idempotente (INSERT OR IGNORE)
//
// Seguro rodar múltiplas vezes — tudo é idempotente.

const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { attachCatalog, CATALOG_DB_PATH } = require('../catalog-manager');
const { applyRouteMigrations } = require('../tenant-provision');

function log(msg) { console.log(`[migrate-all] ${msg}`); }

async function main() {
  const mgr = createTenantManager({ initSchema });
  const tenants = mgr.listActive();
  log(`tenants ativos: ${tenants.length}`);

  if (tenants.length === 0) {
    log('nenhum tenant ativo — nada a fazer.');
    return;
  }

  let okCount = 0, errCount = 0;
  for (const t of tenants) {
    log(`== ${t.slug} (${t.status}) ==`);
    let db;
    try {
      db = new Database(t.db_path);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.pragma('foreign_keys = OFF'); // durante migração

      // Attach do catálogo para que os route-migrations não quebrem em
      // referências como catalog.licitacoes (e que futuras migrations
      // possam usar se precisarem).
      if (fs.existsSync(CATALOG_DB_PATH)) {
        try { attachCatalog(db); } catch (e) { log(`  attach catalog: ${e.message}`); }
      }

      // 1) db-schema — CREATE IF NOT EXISTS + ALTERs idempotentes + seeds
      const startSchema = Date.now();
      initSchema(db);
      log(`  initSchema OK (${Date.now() - startSchema}ms)`);

      // 2) Route migrations (os-routes.migrarDB e demais *-routes com
      //    CREATE TABLE IF NOT EXISTS no register-time, via app throwaway).
      const startRoutes = Date.now();
      applyRouteMigrations(db, t);
      log(`  applyRouteMigrations OK (${Date.now() - startRoutes}ms)`);

      db.pragma('foreign_keys = ON');
      okCount++;
    } catch (err) {
      errCount++;
      log(`  ERRO: ${err.message}`);
    } finally {
      if (db) { try { db.close(); } catch (_) {} }
    }
  }

  mgr.closeAll();
  log(`\n=== RESUMO ===`);
  log(`OK: ${okCount}   FALHAS: ${errCount}`);
  log(`Pronto. Restart do worker aplicará mudanças de código correspondentes.`);
  process.exit(errCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[migrate-all] FATAL:', err);
  process.exit(1);
});
