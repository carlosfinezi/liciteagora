#!/usr/bin/env node
// migrate-patrimonio-contabil.js — contabilização do imobilizado e origem na
// NF-e de entrada.
//
// Cria as tabelas de mapeamento de contas e de depreciação apurada, e as
// colunas de rastro no bem. NÃO cria mapeamento de contas: qual conta contábil
// recebe cada categoria de bem é decisão do contador, e chutar uma conta faria
// o balanço mentir com aparência de certo.
//
// listAll e não listActive: applyRouteMigrations só roda na criação do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const ctb = require('../patrimonio-contabil');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-patrimonio-contabil] tenants: ${tenants.length}`);
let mudados = 0;

for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='patrimonio_bens'").get()) {
      console.log(`  ${t.slug}: sem o módulo de patrimônio, pulando`);
      continue;
    }
    const tinha = !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='patrimonio_depreciacoes'").get();

    ctb.migrarDB(db);

    const bens = db.prepare('SELECT COUNT(*) n FROM patrimonio_bens').get().n;
    const mapas = db.prepare('SELECT COUNT(*) n FROM patrimonio_contas_padrao').get().n;
    const analiticas = (() => {
      try {
        return db.prepare(
          "SELECT COUNT(*) n FROM contas_contabeis WHERE ativo = 1 AND tipoConta = 'analitica'").get().n;
      } catch { return 0; }
    })();

    const partes = [tinha ? 'já estava aplicado' : 'tabelas e colunas criadas'];
    if (bens) partes.push(`${bens} bem(ns)`);
    if (!mapas) {
      partes.push(analiticas
        ? 'PENDENTE: mapear as contas contábeis antes de apurar depreciação'
        : 'PENDENTE: plano contábil sem contas analíticas — crie-as antes de mapear');
    }
    console.log(`  ${t.slug}: ${partes.join(' · ')}`);
    if (!tinha) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}

console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
