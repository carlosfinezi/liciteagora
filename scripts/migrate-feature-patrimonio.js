#!/usr/bin/env node
// migrate-feature-patrimonio.js — Patrimônio saiu de dentro do módulo RH.
//
// A tela ficava no grupo RH e dependia da flag `rh_enabled`. Com o módulo
// próprio ela passa a depender de `patrimonio_enabled`; sem esta migração o
// item sumiria do menu de todo mundo que já usava.
//
// Espelha o RH em vez de ligar para todos: quem não tinha o módulo continua
// sem — separar um módulo não é oportunidade de dar acesso a quem não contratou.
//
// listAll e não listActive: applyRouteMigrations só roda na criação do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const DRY = process.argv.includes('--dry-run');
const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-patrimonio] tenants: ${tenants.length}${DRY ? ' (DRY-RUN)' : ''}`);

let ligados = 0, desligados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const ler = (k) => (db.prepare('SELECT valor FROM config WHERE chave = ?').get(k) || {}).valor;
    const rh = ler('rh_enabled');
    const pat = ler('patrimonio_enabled');

    if (pat != null) { console.log(`  ${t.slug}: já tem a flag (${pat})`); continue; }
    if (rh !== '1') {
      console.log(`  ${t.slug}: sem RH — patrimônio nasce desligado`);
      desligados++;
      continue;
    }
    if (DRY) { console.log(`  ${t.slug}: ligaria patrimônio (espelhando RH)`); continue; }

    db.prepare(`INSERT INTO config (chave, valor) VALUES ('patrimonio_enabled', '1')
      ON CONFLICT(chave) DO UPDATE SET valor = '1'`).run();

    const bens = (() => {
      try { return db.prepare('SELECT COUNT(*) n FROM patrimonio_bens').get().n; }
      catch { return null; }
    })();
    console.log(`  ${t.slug}: patrimônio ligado (espelhando RH)`
      + (bens == null ? ' · sem as tabelas ainda' : ` · ${bens} bem(ns) cadastrado(s)`));
    ligados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}

console.log(`\n${ligados} ligado(s), ${desligados} mantido(s) desligado(s), de ${tenants.length}.`);
