#!/usr/bin/env node
// migrate-ml-anuncios.js — tabela ml_anuncios (rascunho de anúncio do
// Mercado Livre gerado por IA, antes da publicação).
//
// As migrações dentro de registrarRotasTenant são no-op no boot multi-tenant
// (server.js:85), então rodam aqui tenant a tenant.
//
// listAll e não listActive: applyRouteMigrations só roda na criação do tenant
// (control-plane-routes.js:402), então suspenso que volte a ativo ficaria sem.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarAnunciosDB } = require('../marketplaces-ml-anuncios');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-mlanuncio] tenants: ${tenants.length}`);

let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const existia = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ml_anuncios'").get();
    // Contar só a criação da tabela sub-reportava: numa base que já a tinha,
    // uma coluna nova entrava e o script dizia "já estava aplicado".
    const colsAntes = existia
      ? db.prepare('PRAGMA table_info(ml_anuncios)').all().map(c => c.name) : [];
    migrarAnunciosDB(db);
    const colsDepois = db.prepare('PRAGMA table_info(ml_anuncios)').all().map(c => c.name);
    const novas = colsDepois.filter(c => !colsAntes.includes(c));

    const partes = [];
    if (!existia) partes.push('tabela criada');
    else if (novas.length) partes.push(`${novas.length} coluna(s): ${novas.join(', ')}`);
    console.log(partes.length ? `  ${t.slug}: ${partes.join(' · ')}` : `  ${t.slug}: já estava aplicado`);
    if (partes.length) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
