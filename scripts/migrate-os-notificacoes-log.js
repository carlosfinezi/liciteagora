#!/usr/bin/env node
// migrate-os-notificacoes-log.js — cria os_notificacoes_log em todos os
// tenants ativos.
//
// Uso: node scripts/migrate-os-notificacoes-log.js [--dry-run]
//
// migrarNotificacoesDB roda dentro de registrarRotasOS, que é no-op no boot
// multi-tenant (server.js:85). Sem isto, o log de envio nunca é criado e o
// dispatcher volta a falhar em silêncio. Idempotente.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarNotificacoesDB } = require('../os-notificacoes');

const DRY = process.argv.includes('--dry-run');
const log = m => console.log('[migrate-notif] ' + m);

const mgr = createTenantManager({ initSchema });
// listAll, nao listActive: applyRouteMigrations so roda na CRIACAO do
// tenant (control-plane-routes.js:402). Tenant suspenso que voltar a ativo
// nao reaplica migracao nenhuma e ficaria sem as colunas novas.
const tenants = mgr.listAll();
log(`tenants ativos: ${tenants.length}${DRY ? ' (DRY-RUN)' : ''}`);

let ok = 0, erro = 0, pulados = 0;
for (const t of tenants) {
  let db;
  try {
    db = new Database(t.db_path);
    db.pragma('busy_timeout = 10000');

    const temOS = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='os_ordens'").get().n;
    if (!temOS) { log(`${t.slug}: sem módulo de OS — pulado`); pulados++; continue; }

    const jaTinha = db.prepare(
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='os_notificacoes_log'").get().n > 0;

    if (!DRY) {
      migrarNotificacoesDB(db);
      const agora = db.prepare(
        "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='os_notificacoes_log'").get().n;
      if (!agora) throw new Error('os_notificacoes_log não criada');
    }

    log(`${t.slug}: OK${jaTinha ? ' (já existia)' : ' (criada)'}`);
    ok++;
  } catch (err) {
    erro++;
    log(`${t.slug}: ERRO ${err.message}`);
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

log(`fim — ${ok} OK, ${pulados} pulado(s), ${erro} erro(s)`);
process.exit(erro ? 1 : 0);
