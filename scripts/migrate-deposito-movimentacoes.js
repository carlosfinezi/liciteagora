#!/usr/bin/env node
// migrate-deposito-movimentacoes.js — preenche depositoId nas movimentações
// e reservas antigas que ficaram NULL.
//
// Uso: node scripts/migrate-deposito-movimentacoes.js [--dry-run]
//
// NÃO muda nenhum saldo: as consultas já faziam COALESCE(depositoId,
// padrão), então NULL já era contado como padrão. O backfill só torna isso
// explícito, para o dado ser auditável e para o filtro por depósito na
// listagem parar de depender da inferência. Idempotente.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const DRY = process.argv.includes('--dry-run');
const log = m => console.log('[migrate-dep] ' + m);

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

    const temMov = db.prepare(
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='movimentacoes_estoque'").get().n;
    if (!temMov) { log(`${t.slug}: sem movimentacoes_estoque — pulado`); pulados++; continue; }

    const padrao = (db.prepare('SELECT id FROM depositos WHERE padrao = 1 AND ativo = 1 LIMIT 1').get()
      || db.prepare('SELECT id FROM depositos WHERE ativo = 1 ORDER BY id LIMIT 1').get() || {}).id;
    if (!padrao) { log(`${t.slug}: sem depósito cadastrado — pulado`); pulados++; continue; }

    const movNull = db.prepare('SELECT COUNT(*) n FROM movimentacoes_estoque WHERE depositoId IS NULL').get().n;
    let resNull = 0;
    try { resNull = db.prepare('SELECT COUNT(*) n FROM reservas_estoque WHERE depositoId IS NULL').get().n; } catch {}

    // Confere que o saldo total não muda — é a garantia de que o backfill
    // é cosmético e não mexe em número nenhum.
    const saldoAntes = db.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
      WHEN tipo='saida' THEN -quantidade ELSE quantidade END),0) s FROM movimentacoes_estoque`).get().s;

    if (!DRY) {
      db.transaction(() => {
        db.prepare('UPDATE movimentacoes_estoque SET depositoId = ? WHERE depositoId IS NULL').run(padrao);
        try { db.prepare('UPDATE reservas_estoque SET depositoId = ? WHERE depositoId IS NULL').run(padrao); } catch {}
        try { db.prepare('UPDATE lotes SET depositoId = ? WHERE depositoId IS NULL').run(padrao); } catch {}
      })();

      const saldoDepois = db.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
        WHEN tipo='saida' THEN -quantidade ELSE quantidade END),0) s FROM movimentacoes_estoque`).get().s;
      if (Math.abs(saldoAntes - saldoDepois) > 1e-9) throw new Error('saldo total mudou — abortado');
      const sobrou = db.prepare('SELECT COUNT(*) n FROM movimentacoes_estoque WHERE depositoId IS NULL').get().n;
      if (sobrou) throw new Error(`${sobrou} movimentação(ões) ainda com NULL`);
    }

    log(`${t.slug}: OK — depósito padrão #${padrao} · ${movNull} movimentação(ões)`
      + `${resNull ? ` e ${resNull} reserva(s)` : ''} ${DRY ? 'seriam preenchidas' : 'preenchidas'}`);
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
