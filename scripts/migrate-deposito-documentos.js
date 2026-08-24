#!/usr/bin/env node
// migrate-deposito-documentos.js — adiciona depositoId em pedidos,
// os_ordens e inventarios, para cada documento dizer de qual depósito a
// mercadoria sai.
//
// Uso: node scripts/migrate-deposito-documentos.js [--dry-run]
//
// Backfill: documentos existentes recebem o depósito padrão — é o que já
// acontecia na prática, agora fica explícito. Idempotente.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const DRY = process.argv.includes('--dry-run');
const log = m => console.log('[migrate-depsel] ' + m);
const TABELAS = ['pedidos', 'os_ordens', 'inventarios'];

const mgr = createTenantManager({ initSchema });
// listAll, nao listActive: applyRouteMigrations so roda na CRIACAO do
// tenant (control-plane-routes.js:402). Tenant suspenso que voltar a ativo
// nao reaplica migracao nenhuma e ficaria sem as colunas novas.
const tenants = mgr.listAll();
log(`tenants ativos: ${tenants.length}${DRY ? ' (DRY-RUN)' : ''}`);

let ok = 0, erro = 0;
for (const t of tenants) {
  let db;
  try {
    db = new Database(t.db_path);
    db.pragma('busy_timeout = 10000');
    const padrao = (db.prepare('SELECT id FROM depositos WHERE padrao = 1 AND ativo = 1 LIMIT 1').get()
      || db.prepare('SELECT id FROM depositos WHERE ativo = 1 ORDER BY id LIMIT 1').get() || {}).id;

    const feito = [];
    for (const tb of TABELAS) {
      const existe = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?").get(tb).n;
      if (!existe) { feito.push(`${tb}: sem tabela`); continue; }
      const tinha = db.prepare(`PRAGMA table_info(${tb})`).all().some(c => c.name === 'depositoId');
      if (!DRY) {
        if (!tinha) db.exec(`ALTER TABLE ${tb} ADD COLUMN depositoId INTEGER`);
        const agora = db.prepare(`PRAGMA table_info(${tb})`).all().some(c => c.name === 'depositoId');
        if (!agora) throw new Error(`${tb}.depositoId não aplicada`);
        const n = padrao
          ? db.prepare(`UPDATE ${tb} SET depositoId = ? WHERE depositoId IS NULL`).run(padrao).changes : 0;
        feito.push(`${tb}: ${tinha ? 'já tinha' : 'criada'}, ${n} preenchido(s)`);
      } else {
        const n = db.prepare(`SELECT COUNT(*) n FROM ${tb}`).get().n;
        feito.push(`${tb}: ${tinha ? 'já tem' : 'criar'}, ${n} registro(s)`);
      }
    }
    log(`${t.slug}: OK (padrão #${padrao ?? '—'}) — ${feito.join(' · ')}`);
    ok++;
  } catch (err) {
    erro++;
    log(`${t.slug}: ERRO ${err.message}`);
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}
log(`fim — ${ok} OK, ${erro} erro(s)`);
process.exit(erro ? 1 : 0);
