#!/usr/bin/env node
// migrate-loja.js — tabela loja_config (vitrine pública do tenant) e a
// coluna produtos.publicadoNaLoja.
//
// As migrações dentro de registrarRotas* são no-op no boot multi-tenant
// (o db do boot é um proxy com stubs), então rodam aqui tenant a tenant.
// Tenant NOVO já nasce migrado via applyRouteMigrations.
//
// listAll e não listActive: applyRouteMigrations só roda na criação do
// tenant, então suspenso que volte a ativo ficaria sem.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarLojaDB } = require('../loja-routes');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-loja] tenants: ${tenants.length}`);

let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const tabela = (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
    const coluna = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);
    const antes = {
      config: tabela('loja_config'), carrinho: tabela('loja_carrinho'),
      publicado: coluna('produtos', 'publicadoNaLoja'), origem: coluna('pedidos', 'origemLoja'),
    };

    migrarLojaDB(db);

    const partes = [];
    if (!antes.config) partes.push('loja_config');
    if (!antes.carrinho) partes.push('loja_carrinho');
    if (!antes.publicado) partes.push('produtos.publicadoNaLoja');
    if (!antes.origem) partes.push('pedidos.origemLoja');
    if (partes.length) mudados++;
    console.log(partes.length ? `  ${t.slug}: ${partes.join(' · ')}` : `  ${t.slug}: já estava aplicado`);
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
  } finally {
    db.close();
  }
}
console.log(`[migrate-loja] ${mudados} tenant(s) alterado(s)`);
