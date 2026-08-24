#!/usr/bin/env node
// migrate-serie-dps.js — serie do DPS e codigo do municipio saem da config da
// tela de NFS-e e passam a morar no cadastro da empresa.
//
// Nao inventa valor: so copia a chave antiga para o cadastro quando o cadastro
// esta vazio. Quem ja tinha codigoMunicipio preenchido continua com o dele —
// era o que a emissao usava, e mudar isso mudaria a nota.
//
// listAll e nao listActive: applyRouteMigrations so roda na criacao do tenant,
// entao um tenant suspenso que voltar precisa ter a coluna.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarSerieDps } = require('../nfse-routes');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-serie-dps] tenants: ${tenants.length}`);
let mudados = 0;

for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fornecedor'").get()) {
      console.log(`  ${t.slug}: sem tabela fornecedor, pulando`); continue;
    }
    const tinha = db.prepare('PRAGMA table_info(fornecedor)').all().some(c => c.name === 'serieDps');
    const r = migrarSerieDps(db);

    const forn = db.prepare('SELECT serieDps, codigoMunicipio FROM fornecedor WHERE id = 1').get() || {};
    const copiou = [];
    if (r.serie) copiou.push(`serie ${r.serie}`);
    if (r.municipio) copiou.push(`municipio ${r.municipio}`);

    console.log(`  ${t.slug}: ${tinha ? 'coluna ja existia' : 'coluna criada'}`
      + (copiou.length ? ` · copiado da config antiga: ${copiou.join(', ')}` : '')
      + ` · cadastro agora: serie=${forn.serieDps || '(vazio, usa 1)'}`
      + ` municipio=${forn.codigoMunicipio || '(vazio)'}`);
    if (!tinha || copiou.length) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}

console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
