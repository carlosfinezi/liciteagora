#!/usr/bin/env node
/**
 * Rateio de cotação: cotacao_rateios + cotacao_respostas.quantidadeDisponivel.
 *
 * As migrações dentro de registrarRotasCotacoes são no-op no boot multi-tenant
 * (server.js:85), então a mudança precisa ser aplicada tenant a tenant.
 */
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

// listAll, nao listActive: applyRouteMigrations so roda na CRIACAO do
// tenant (control-plane-routes.js:402). Tenant suspenso que voltar a ativo
// nao reaplica migracao nenhuma e ficaria sem as colunas novas.
const tenants = createTenantManager({ initSchema }).listAll();
let mudados = 0;

for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const tem = (tabela) => !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(tabela);
    if (!tem('cotacoes')) { console.log(`  ${t.slug}: sem módulo de cotações, pulando`); continue; }

    let fez = [];

    if (!tem('cotacao_rateios')) {
      db.exec(`
        CREATE TABLE cotacao_rateios (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cotacaoId INTEGER NOT NULL,
          cotacaoItemId INTEGER NOT NULL,
          cotacaoFornecedorId INTEGER NOT NULL,
          quantidade REAL NOT NULL,
          dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (cotacaoId) REFERENCES cotacoes(id),
          FOREIGN KEY (cotacaoItemId) REFERENCES cotacao_itens(id),
          FOREIGN KEY (cotacaoFornecedorId) REFERENCES cotacao_fornecedores(id),
          UNIQUE (cotacaoItemId, cotacaoFornecedorId)
        );
        CREATE INDEX idx_cotrateio_cot ON cotacao_rateios(cotacaoId);`);
      fez.push('cotacao_rateios');
    }

    const temCol = db.prepare('PRAGMA table_info(cotacao_respostas)').all()
      .some(c => c.name === 'quantidadeDisponivel');
    if (!temCol) {
      db.exec('ALTER TABLE cotacao_respostas ADD COLUMN quantidadeDisponivel REAL');
      fez.push('quantidadeDisponivel');
    }

    console.log(fez.length ? `  ${t.slug}: ${fez.join(', ')}` : `  ${t.slug}: já estava aplicado`);
    if (fez.length) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
