#!/usr/bin/env node
// migrate-conciliacao-regras.js — regra de conciliação passa a apontar para o
// plano de contas, com modo de casamento e faixa de valor.
//
// Antes a regra só gravava um texto em categoriaSugerida, que não alimentava
// o orçamento nem relatório nenhum.
//
// listAll e não listActive: applyRouteMigrations só roda na criação do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarRegrasConciliacao } = require('../tesouraria-routes');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-concil] tenants: ${tenants.length}`);
let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conciliacao_regras'").get()) {
      console.log(`  ${t.slug}: sem tesouraria, pulando`); continue;
    }
    const antes = db.prepare('PRAGMA table_info(conciliacao_regras)').all().map(c => c.name);
    migrarRegrasConciliacao(db);
    const novas = db.prepare('PRAGMA table_info(conciliacao_regras)').all()
      .map(c => c.name).filter(c => !antes.includes(c));

    // Regra que categoriza sem conta do plano não pode ficar ativa: produziria
    // classificação que não alimenta o orçamento. A migração desativa e diz qual.
    const desativadas = db.prepare(
      "SELECT padraoTexto FROM conciliacao_regras WHERE ativo=0 AND acao='categorizar' AND planoContaId IS NULL").all();
    const temCheck = /categorizar_exige_conta/.test(
      (db.prepare("SELECT sql FROM sqlite_master WHERE name='conciliacao_regras'").get() || {}).sql || '');

    const partes = [];
    if (novas.length) partes.push(`${novas.length} coluna(s)`);
    if (temCheck) partes.push('trava categorizar-exige-conta ativa');
    if (desativadas.length) {
      // Estado, não ação: a regra pode ter sido desativada agora ou numa
      // passagem anterior. O que importa é que está fora de operação e por quê.
      partes.push(`INATIVA(S) por falta de conta do plano: ${desativadas.map(d => d.padraoTexto).join(', ')}`);
    }
    console.log(partes.length ? `  ${t.slug}: ${partes.join(' · ')}` : `  ${t.slug}: já estava aplicado`);
    if (novas.length || desativadas.length) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}
console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
