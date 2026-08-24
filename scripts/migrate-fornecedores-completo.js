#!/usr/bin/env node
// migrate-fornecedores-completo.js — amplia o cadastro de fornecedores:
// dados fiscais, comerciais, bancários, homologação, contatos e documentos.
//
// As migrações dentro de registrarRotasFornecedores são no-op no boot
// multi-tenant (server.js:85), então rodam aqui tenant a tenant.
//
// Uso: node scripts/migrate-fornecedores-completo.js [--dry-run]

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarFornecedoresDB } = require('../fornecedores-routes');

const DRY = process.argv.includes('--dry-run');
const mgr = createTenantManager({ initSchema });
// listAll, não listActive: applyRouteMigrations só roda na CRIAÇÃO do tenant
// (control-plane-routes.js:402). Tenant suspenso que voltar a ativo não
// reaplica migração nenhuma — ficaria sem as colunas novas e o cadastro
// quebraria no primeiro INSERT.
const tenants = (mgr.listAll ? mgr.listAll() : mgr.listActive());
console.log(`[migrate-forn] tenants: ${tenants.length}${DRY ? ' (DRY-RUN)' : ''}`);

let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const temTabela = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fornecedores'").get();
    if (!temTabela) { console.log(`  ${t.slug}: sem tabela fornecedores, pulando`); continue; }

    const antes = new Set(db.prepare('PRAGMA table_info(fornecedores)').all().map(c => c.name));
    const tabelasAntes = db.prepare(
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('fornecedor_contatos','fornecedor_documentos')").get().n;

    if (DRY) {
      console.log(`  ${t.slug}: ${antes.size} colunas hoje, ${tabelasAntes}/2 tabelas filhas`);
      continue;
    }

    migrarFornecedoresDB(db);

    const depois = db.prepare('PRAGMA table_info(fornecedores)').all().map(c => c.name);
    const novas = depois.filter(c => !antes.has(c));
    const tabelasDepois = db.prepare(
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('fornecedor_contatos','fornecedor_documentos')").get().n;

    // Migra o contato solto do cadastro antigo para a lista de contatos, para
    // o dado não ficar órfão numa tela que passou a mostrar outra coisa.
    let migrados = 0;
    const jaTem = db.prepare('SELECT COUNT(*) n FROM fornecedor_contatos').get().n;
    if (!jaTem) {
      const ins = db.prepare(`INSERT INTO fornecedor_contatos
        (fornecedorId, nome, email, telefone, principal, observacao)
        VALUES (?, ?, ?, ?, 1, 'Importado do campo "contato" do cadastro')`);
      for (const f of db.prepare("SELECT id, contato, email, telefone FROM fornecedores WHERE contato IS NOT NULL AND TRIM(contato) <> ''").all()) {
        ins.run(f.id, f.contato, f.email || null, f.telefone || null);
        migrados++;
      }
    }

    const partes = [];
    if (novas.length) partes.push(`${novas.length} coluna(s)`);
    if (tabelasDepois > tabelasAntes) partes.push(`${tabelasDepois - tabelasAntes} tabela(s)`);
    if (migrados) partes.push(`${migrados} contato(s) migrado(s)`);
    console.log(partes.length ? `  ${t.slug}: ${partes.join(', ')}` : `  ${t.slug}: já estava aplicado`);
    if (partes.length) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
