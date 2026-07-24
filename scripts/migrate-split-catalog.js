#!/usr/bin/env node
// migrate-split-catalog.js — Fase 8 (2026-04-22)
//
// Separa dados de catálogo (PNCP público) do DB do tenant 1bit para o
// novo data/catalog.db compartilhado. Outros tenants (demo, demo2)
// ficam com as tabelas vazias (que serão descartadas) — eles já veem
// o catalog inteiro via ATTACH + TEMP VIEW.
//
// PASSOS:
//   1. Abre data/catalog.db (cria se não existir, aplica schema)
//   2. Para cada tenant existente, verifica quais das 5 tabelas têm dados
//   3. Se for o tenant "1bit" (ou o primeiro com dados substanciais),
//      copia dados para catalog.db via ATTACH + INSERT
//   4. Copia lastFullSync/lastIncrementalSync/lastSyncDate de config
//      → catalog_sync_state
//   5. DROP das 5 tabelas + seus índices em CADA tenant pncp.db
//   6. VACUUM em cada arquivo para recuperar espaço físico
//
// PRÉ-REQUISITO: `systemctl stop liciteagora consulta-licitacoes` antes
// de executar, porque vamos escrever em DBs que normalmente estão
// abertos pelo worker. O próprio script não tenta parar/iniciar — é o
// admin que controla a janela de manutenção.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { initCatalogDb, CATALOG_DB_PATH, CATALOG_DATA_TABLES } = require('../catalog-manager');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

function log(msg) { console.log(`[migrate] ${msg}`); }

async function main() {
  log('Iniciando migração split catalog/tenant');

  // 1. Abre/cria catalog.db
  const catalogDb = initCatalogDb(CATALOG_DB_PATH);
  log(`catalog.db aberto em ${CATALOG_DB_PATH}`);

  // Lista tenants
  const mgr = createTenantManager({ initSchema });
  const tenants = mgr.listAll();
  log(`tenants encontrados: ${tenants.map(t => t.slug).join(', ')}`);

  if (tenants.length === 0) {
    log('Nenhum tenant — nada a migrar. Catalog inicializado vazio.');
    return;
  }

  // 2. Determinar fonte principal (o tenant com maior volume de licitações)
  let fonte = null, maxCount = -1;
  for (const t of tenants) {
    try {
      const db = new Database(t.db_path, { readonly: true });
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='licitacoes'").get();
      const count = row ? db.prepare('SELECT COUNT(*) c FROM licitacoes').get().c : 0;
      log(`  ${t.slug}: ${count} licitações`);
      if (count > maxCount) { maxCount = count; fonte = t; }
      db.close();
    } catch (err) {
      log(`  ${t.slug}: erro ao abrir — ${err.message}`);
    }
  }

  if (maxCount > 0 && fonte) {
    log(`Copiando catálogo do tenant "${fonte.slug}" (${maxCount} licitações)`);

    // 3. ATTACH o tenant fonte e copia tabelas
    // Desabilita FK durante a cópia — a tabela itens tem FK → licitacoes,
    // mas queremos INSERT livre.
    catalogDb.pragma('foreign_keys = OFF');
    catalogDb.exec(`ATTACH DATABASE '${fonte.db_path.replace(/'/g, "''")}' AS src`);

    for (const tabela of CATALOG_DATA_TABLES) {
      // Verifica se a tabela existe no src
      const exists = catalogDb.prepare(
        "SELECT name FROM src.sqlite_master WHERE type='table' AND name = ?"
      ).get(tabela);
      if (!exists) {
        log(`  skip ${tabela} (não existe no src)`);
        continue;
      }
      const before = catalogDb.prepare(`SELECT COUNT(*) c FROM main.${tabela}`).get().c;
      const srcCount = catalogDb.prepare(`SELECT COUNT(*) c FROM src.${tabela}`).get().c;
      if (srcCount === 0) { log(`  skip ${tabela} (src vazio)`); continue; }

      const start = Date.now();
      // Usa INSERT OR IGNORE para permitir re-run da migração
      // (se já copiamos parte, não duplica).
      catalogDb.exec(`INSERT OR IGNORE INTO main.${tabela} SELECT * FROM src.${tabela}`);
      const after = catalogDb.prepare(`SELECT COUNT(*) c FROM main.${tabela}`).get().c;
      log(`  ${tabela}: ${after - before} copiados (${after} total, ${srcCount} origem, ${((Date.now()-start)/1000).toFixed(1)}s)`);
    }

    // 4. Copia sync state de config → catalog_sync_state
    const syncKeys = ['lastFullSync', 'lastIncrementalSync', 'lastSyncDate', 'lastSyncStart', 'lastSyncEnd'];
    for (const key of syncKeys) {
      try {
        const row = catalogDb.prepare('SELECT valor FROM src.config WHERE chave = ?').get(key);
        if (row && row.valor) {
          catalogDb.prepare(
            `INSERT INTO catalog_sync_state (key, value, updated_at) VALUES (?, ?, ?) ` +
            `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
          ).run(key, row.valor, Date.now());
          log(`  sync_state: ${key} = ${row.valor}`);
        }
      } catch (err) {
        log(`  sync_state ${key}: falhou — ${err.message}`);
      }
    }

    catalogDb.exec('DETACH DATABASE src');
    catalogDb.pragma('foreign_keys = ON');
    log(`Cópia concluída para catalog.db`);
  }

  catalogDb.close();

  // 5. Para CADA tenant, dropa as 5 tabelas de catálogo + seus índices + VACUUM
  for (const t of tenants) {
    log(`Limpando tenant "${t.slug}"`);
    let db;
    try { db = new Database(t.db_path); }
    catch (err) { log(`  erro abrindo: ${err.message}`); continue; }

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');

    for (const tabela of CATALOG_DATA_TABLES) {
      try {
        // Drop índices relacionados primeiro (evita erro em ALTER)
        const indexes = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL"
        ).all(tabela);
        for (const idx of indexes) {
          try { db.exec(`DROP INDEX IF EXISTS ${idx.name}`); } catch (_) { /* ignore */ }
        }
        db.exec(`DROP TABLE IF EXISTS ${tabela}`);
        log(`  ${tabela}: dropped`);
      } catch (err) {
        log(`  ${tabela}: falha drop — ${err.message}`);
      }
    }

    // Remove as chaves de sync state do config do tenant (migradas ao catalog)
    const syncKeys = ['lastFullSync', 'lastIncrementalSync', 'lastSyncDate', 'lastSyncStart', 'lastSyncEnd'];
    try {
      db.prepare(`DELETE FROM config WHERE chave IN (${syncKeys.map(() => '?').join(',')})`).run(...syncKeys);
    } catch (_) { /* tenant pode não ter config ainda */ }

    // VACUUM: reclaim de espaço físico (pode levar minutos no 1bit)
    const sizeBefore = (fs.statSync(t.db_path).size / 1024 / 1024).toFixed(1);
    log(`  VACUUM ${t.slug}... (antes: ${sizeBefore} MB)`);
    const start = Date.now();
    db.exec('VACUUM');
    const sizeAfter = (fs.statSync(t.db_path).size / 1024 / 1024).toFixed(1);
    log(`  VACUUM ok — ${sizeBefore} MB → ${sizeAfter} MB (${((Date.now()-start)/1000).toFixed(1)}s)`);

    db.pragma('foreign_keys = ON');
    db.close();
  }

  // Tamanhos finais
  const catSize = (fs.statSync(CATALOG_DB_PATH).size / 1024 / 1024).toFixed(1);
  log(`\n=== RESUMO ===`);
  log(`catalog.db: ${catSize} MB`);
  for (const t of tenants) {
    if (fs.existsSync(t.db_path)) {
      log(`${t.slug}: ${(fs.statSync(t.db_path).size / 1024 / 1024).toFixed(1)} MB`);
    }
  }
  mgr.closeAll();
  log('Concluído. Agora pode iniciar: systemctl start liciteagora consulta-licitacoes');
}

main().catch(err => {
  console.error('[migrate] FATAL:', err);
  process.exit(1);
});
