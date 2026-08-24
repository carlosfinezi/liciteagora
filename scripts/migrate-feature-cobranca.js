#!/usr/bin/env node
// migrate-feature-cobranca.js — liga a feature 'cobranca' em quem ja tinha
// financeiro. As telas de cobranca sairam do bloco Financeiro para um modulo
// proprio; sem esta flag elas sumiriam do menu de quem ja as usava.
//
// listAll e nao listActive: applyRouteMigrations so roda na criacao do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const DRY = process.argv.includes('--dry-run');
const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-cobranca] tenants: ${tenants.length}${DRY ? ' (DRY-RUN)' : ''}`);

let ligados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const ler = (k) => (db.prepare('SELECT valor FROM config WHERE chave = ?').get(k) || {}).valor;
    const fin = ler('financeiro_enabled');
    const cob = ler('cobranca_enabled');

    if (cob === '1') { console.log(`  ${t.slug}: ja estava ligada`); continue; }
    // Espelha o financeiro: quem nao tinha o modulo tambem nao passa a ter.
    // Ligar por conta propria seria dar acesso a quem nao contratou.
    if (fin !== '1') { console.log(`  ${t.slug}: sem financeiro — cobranca fica desligada`); continue; }
    if (DRY) { console.log(`  ${t.slug}: ligaria cobranca`); continue; }

    db.prepare(`INSERT INTO config (chave, valor) VALUES ('cobranca_enabled', '1')
      ON CONFLICT(chave) DO UPDATE SET valor = '1'`).run();
    console.log(`  ${t.slug}: cobranca ligada (espelhando financeiro)`);
    ligados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}
console.log(`\n${ligados} tenant(s) com a feature ligada.`);
