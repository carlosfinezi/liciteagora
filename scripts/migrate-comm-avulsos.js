#!/usr/bin/env node
// migrate-comm-avulsos.js — permite contato avulso nas listas de comunicação
// e imagem no modelo de mensagem.
//
//   comm_templates.imagemPath              (coluna nova)
//   comm_lista_membros.destinoManual/nomeManual  (colunas novas)
//   comm_lista_membros.pessoaId            NOT NULL -> nulo permitido
//
// A última exige recriar a tabela (SQLite não afrouxa NOT NULL com ALTER). A
// recriação preserva as linhas existentes e só acontece uma vez.
//
// As migrações dentro de registrarRotas* são no-op no boot multi-tenant, então
// rodam aqui tenant a tenant. Rode o backup antes.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-comm] tenants: ${tenants.length}`);

const alterSafe = (db, sql) => {
  try { db.exec(sql); return true; }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; return false; }
};

let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const temTabela = (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
    if (!temTabela('comm_lista_membros')) { console.log(`  ${t.slug}: sem o módulo comm — pulado`); continue; }

    const feito = [];
    if (alterSafe(db, 'ALTER TABLE comm_templates ADD COLUMN imagemPath TEXT')) feito.push('comm_templates.imagemPath');
    if (alterSafe(db, 'ALTER TABLE comm_lista_membros ADD COLUMN destinoManual TEXT')) feito.push('destinoManual');
    if (alterSafe(db, 'ALTER TABLE comm_lista_membros ADD COLUMN nomeManual TEXT')) feito.push('nomeManual');

    const col = db.prepare('PRAGMA table_info(comm_lista_membros)').all().find(c => c.name === 'pessoaId');
    if (col && col.notnull) {
      const antes = db.prepare('SELECT COUNT(*) n FROM comm_lista_membros').get().n;
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE comm_lista_membros_novo (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            listaId INTEGER NOT NULL,
            pessoaId INTEGER,
            destinoManual TEXT,
            nomeManual TEXT,
            dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (listaId) REFERENCES comm_listas(id) ON DELETE CASCADE,
            FOREIGN KEY (pessoaId) REFERENCES pessoas(id),
            UNIQUE(listaId, pessoaId),
            UNIQUE(listaId, destinoManual)
          );
          INSERT INTO comm_lista_membros_novo (id, listaId, pessoaId, destinoManual, nomeManual, dataCriacao)
            SELECT id, listaId, pessoaId, destinoManual, nomeManual, dataCriacao FROM comm_lista_membros;
          DROP TABLE comm_lista_membros;
          ALTER TABLE comm_lista_membros_novo RENAME TO comm_lista_membros;
          CREATE INDEX IF NOT EXISTS idx_membros_lista ON comm_lista_membros(listaId);
        `);
      })();
      db.pragma('foreign_keys = ON');
      const depois = db.prepare('SELECT COUNT(*) n FROM comm_lista_membros').get().n;
      if (antes !== depois) throw new Error(`perda de linhas: ${antes} -> ${depois}`);
      feito.push(`pessoaId agora aceita nulo (${depois} membro(s) preservado(s))`);
    }

    if (feito.length) mudados++;
    console.log(feito.length ? `  ${t.slug}: ${feito.join(' · ')}` : `  ${t.slug}: já estava aplicado`);
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
  } finally {
    db.close();
  }
}
console.log(`[migrate-comm] ${mudados} tenant(s) alterado(s)`);
