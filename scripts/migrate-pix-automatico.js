#!/usr/bin/env node
// migrate-pix-automatico.js — campos do pagamento automatico por PIX nas
// recorrencias de contas a pagar.
//
// Nasce DESLIGADO em todo lugar: ligar sozinho seria autorizar dinheiro a sair
// da conta de alguem sem essa pessoa pedir.
//
// listAll e nao listActive: applyRouteMigrations so roda na criacao do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarPagamentoAutomaticoCP } = require('../tesouraria-routes');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-pixauto] tenants: ${tenants.length}`);
let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contas_pagar_recorrencias'").get()) {
      console.log(`  ${t.slug}: sem contas a pagar, pulando`); continue;
    }
    const antes = db.prepare('PRAGMA table_info(contas_pagar_recorrencias)').all().map(c => c.name);
    migrarPagamentoAutomaticoCP(db);
    const novas = db.prepare('PRAGMA table_info(contas_pagar_recorrencias)').all()
      .map(c => c.name).filter(c => !antes.includes(c));

    const ligadas = db.prepare('SELECT COUNT(*) n FROM contas_pagar_recorrencias WHERE pagarAutomatico = 1').get().n;
    console.log(novas.length
      ? `  ${t.slug}: ${novas.length} coluna(s) · ${ligadas} recorrência(s) com PIX automático`
      : `  ${t.slug}: já estava aplicado · ${ligadas} com PIX automático`);
    if (novas.length) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}
console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
