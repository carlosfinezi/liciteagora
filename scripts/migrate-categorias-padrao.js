#!/usr/bin/env node
// migrate-categorias-padrao.js — categorias padrão de CR/CP já ligadas ao
// plano de contas gerencial, para o orçamento funcionar sem o cliente montar
// o de-para na mão.
//
// Não sobrescreve vínculo já definido pelo tenant: a partir do primeiro
// ajuste dele, o padrão deixa de ser a verdade.
//
// Uso: node scripts/migrate-categorias-padrao.js [--dry-run]

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { aplicarPadrao, diagnostico } = require('../plano-categorias-padrao');
const { classificarPendentes } = require('../orcamento-classificacao');

const DRY = process.argv.includes('--dry-run');
const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-cat] tenants: ${tenants.length}${DRY ? ' (DRY-RUN)' : ''}`);

let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const tem = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='categorias_cr'").get();
    if (!tem) { console.log(`  ${t.slug}: sem financeiro, pulando`); continue; }

    if (DRY) {
      const d = diagnostico(db);
      console.log(`  ${t.slug}: ${d.semConta.receber.length} cat CR e ${d.semConta.pagar.length} cat CP sem conta`);
      continue;
    }

    const r = aplicarPadrao(db);
    const cls = classificarPendentes(db);
    const titulos = (cls.receber || 0) + (cls.pagar || 0);

    const partes = [];
    if (r.contasCriadas.length) partes.push(`conta ${r.contasCriadas.join(', ')}`);
    if (r.categoriasCriadas.length) partes.push(`${r.categoriasCriadas.length} categoria(s) nova(s)`);
    if (r.vinculadas) partes.push(`${r.vinculadas} vinculada(s)`);
    if (r.remapeadas) partes.push(`${r.remapeadas} corrigida(s) de sintética`);
    if (titulos) partes.push(`${titulos} título(s) classificado(s)`);
    if (r.semConta.length) partes.push(`SEM CONTA NO PLANO: ${r.semConta.join(', ')}`);

    console.log(partes.length ? `  ${t.slug}: ${partes.join(' · ')}` : `  ${t.slug}: já estava aplicado`);
    if (partes.length) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}
console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
