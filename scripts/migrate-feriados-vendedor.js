#!/usr/bin/env node
// migrate-feriados-vendedor.js — cria a tabela `feriados` e a coluna
// vendas_perdidas.vendedorUserId em todos os tenants ativos.
//
// Uso: node scripts/migrate-feriados-vendedor.js [--dry-run]
//
// Migração dentro de registrarRotasX é no-op em multi-tenant
// (server.js:85). Idempotente.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const DRY = process.argv.includes('--dry-run');
const log = m => console.log('[migrate-f5] ' + m);

const PASSOS = [
  `CREATE TABLE IF NOT EXISTS feriados (
     data TEXT PRIMARY KEY, descricao TEXT,
     ativo INTEGER NOT NULL DEFAULT 1,
     dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`,
  'ALTER TABLE vendas_perdidas ADD COLUMN vendedorUserId INTEGER',
  'CREATE INDEX IF NOT EXISTS idx_vp_vendedor ON vendas_perdidas(vendedorUserId, data)',
];

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

    const temVP = db.prepare(
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='vendas_perdidas'").get().n;
    if (!temVP) { log(`${t.slug}: sem vendas_perdidas — pulado`); pulados++; continue; }

    const antes = db.prepare('PRAGMA table_info(vendas_perdidas)').all().map(c => c.name);
    const faltava = !antes.includes('vendedorUserId');

    if (!DRY) {
      for (const sql of PASSOS) {
        try { db.exec(sql); }
        catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      }
      const depois = db.prepare('PRAGMA table_info(vendas_perdidas)').all().map(c => c.name);
      if (!depois.includes('vendedorUserId')) throw new Error('vendedorUserId não aplicada');
      const temFer = db.prepare(
        "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='feriados'").get().n;
      if (!temFer) throw new Error('tabela feriados não criada');
    }

    // Backfill: perda já ligada a pedido herda o vendedor dele.
    let herdadas = 0;
    if (!DRY) {
      try {
        herdadas = db.prepare(`UPDATE vendas_perdidas
          SET vendedorUserId = (SELECT p.vendedorId FROM pedidos p WHERE p.id = vendas_perdidas.pedidoId)
          WHERE vendedorUserId IS NULL AND pedidoId IS NOT NULL
            AND (SELECT p.vendedorId FROM pedidos p WHERE p.id = vendas_perdidas.pedidoId) IS NOT NULL`).run().changes;
      } catch { /* tenant sem pedidos.vendedorId */ }
    }

    log(`${t.slug}: OK${faltava ? ' (+vendedorUserId, feriados)' : ' (já estava migrado)'}`
      + (herdadas ? ` · ${herdadas} perda(s) herdaram o vendedor do pedido` : ''));
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
