#!/usr/bin/env node
// migrate-dda-boletos.js — caixa de entrada de boletos a pagar (DDA + manual)
// e os campos de boleto no título e no item do lote de pagamento.
//
// Sem isso o lote só sabia pagar por PIX: boleto de fornecedor e conta de
// concessionária não tinham por onde entrar.
//
// listAll e não listActive: applyRouteMigrations só roda na criação do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarDdaDB } = require('../dda-boletos');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-dda] tenants: ${tenants.length}`);
let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contas_a_pagar'").get()) {
      console.log(`  ${t.slug}: sem financeiro, pulando`); continue;
    }
    const tinha = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dda_boletos'").get();
    const colsAntes = db.prepare('PRAGMA table_info(contas_a_pagar)').all().map(c => c.name);
    migrarDdaDB(db);
    const novas = db.prepare('PRAGMA table_info(contas_a_pagar)').all()
      .map(c => c.name).filter(c => !colsAntes.includes(c));

    const partes = [];
    if (!tinha) partes.push('dda_boletos criada');
    if (novas.length) partes.push(`contas_a_pagar +${novas.join(', ')}`);
    console.log(partes.length ? `  ${t.slug}: ${partes.join(' · ')}` : `  ${t.slug}: já estava aplicado`);
    if (partes.length) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}
console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
