#!/usr/bin/env node
// migrate-orcamento-classificacao.js — triggers que fazem o título herdar o
// plano de contas da sua categoria, e backfill do histórico.
//
// Sem isso o previsto x realizado do orçamento fica zerado: ele só soma
// título classificado, e a classificação dependia de alguém preencher à mão.
//
// listAll e não listActive: applyRouteMigrations só roda na criação do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarClassificacaoDB, classificarPendentes } = require('../orcamento-classificacao');

const DRY = process.argv.includes('--dry-run');
const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-orc] tenants: ${tenants.length}${DRY ? ' (DRY-RUN)' : ''}`);

let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const temCR = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contas_a_receber'").get();
    if (!temCR) { console.log(`  ${t.slug}: sem financeiro, pulando`); continue; }

    const pendentesAntes = db.prepare(`SELECT COUNT(*) n FROM contas_a_receber
      WHERE planoContaId IS NULL AND categoriaId IS NOT NULL`).get().n;
    if (DRY) { console.log(`  ${t.slug}: ${pendentesAntes} título(s) CR herdariam da categoria`); continue; }

    migrarClassificacaoDB(db);
    const r = classificarPendentes(db);
    const total = (r.receber || 0) + (r.pagar || 0);

    // O que sobra é o que a própria categoria não sabe classificar — precisa
    // de decisão humana, então vale reportar em vez de deixar quieto.
    const semCat = db.prepare(`SELECT COUNT(*) n FROM contas_a_receber WHERE planoContaId IS NULL`).get().n;
    console.log(`  ${t.slug}: triggers ok · ${total} título(s) classificado(s)`
      + (semCat ? ` · ${semCat} CR ainda sem plano (categoria sem conta ou título sem categoria)` : ''));
    if (total) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}
console.log(`\n${mudados} tenant(s) com títulos reclassificados, de ${tenants.length}.`);
