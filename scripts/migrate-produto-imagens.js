#!/usr/bin/env node
// migrate-produto-imagens.js — tabela produto_imagens (galeria por produto,
// com a URL de origem e quem declarou a autorização de uso).
//
// listAll e não listActive: applyRouteMigrations só roda na criação do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarImagensDB } = require('../produto-imagens');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-prodimg] tenants: ${tenants.length}`);
let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const existia = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='produto_imagens'").get();
    migrarImagensDB(db);
    console.log(existia ? `  ${t.slug}: já estava aplicado` : `  ${t.slug}: produto_imagens criada`);
    if (!existia) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}
console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
