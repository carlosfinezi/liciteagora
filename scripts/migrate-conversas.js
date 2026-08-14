#!/usr/bin/env node
// migrate-conversas.js — central de conversas (conv_conversas, conv_eventos)
// e base da IA (ia_base, ia_correcoes).
//
// As migrações dentro de registrarRotas* são no-op no boot multi-tenant, então
// rodam aqui tenant a tenant. Tenant novo já nasce migrado via
// applyRouteMigrations.
//
// Também deriva conversas das mensagens que já existem em whatsapp_messages,
// para o inbox não nascer vazio onde já houve conversa.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarConversasDB, sincronizar } = require('../conversas-routes');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-conversas] tenants: ${tenants.length}`);

let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const tabela = (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
    const antes = { conv: tabela('conv_conversas'), base: tabela('ia_base') };

    migrarConversasDB(db);
    const derivadas = sincronizar(db);

    const partes = [];
    if (!antes.conv) partes.push('conv_conversas + conv_eventos');
    if (!antes.base) partes.push('ia_base + ia_correcoes');
    if (derivadas) partes.push(`${derivadas} conversa(s) derivada(s) do histórico`);
    if (partes.length) mudados++;
    console.log(partes.length ? `  ${t.slug}: ${partes.join(' · ')}` : `  ${t.slug}: já estava aplicado`);
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
  } finally {
    db.close();
  }
}
console.log(`[migrate-conversas] ${mudados} tenant(s) alterado(s)`);
