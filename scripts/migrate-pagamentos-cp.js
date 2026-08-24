#!/usr/bin/env node
// migrate-pagamentos-cp.js — alinha contas_pagar_pagamentos com a de receber:
// adiciona `origem` e deixa `contaFinanceiraId` aceitar nulo.
//
// Sem isso, nenhuma quitação sem caixa funciona do lado do fornecedor
// (adiantamento, compensação de crédito, encontro de contas): o INSERT
// estourava por falta de coluna e por NOT NULL.
//
// Reconstrói a tabela (SQLite não remove NOT NULL com ALTER). Confere a
// contagem de linhas antes e depois.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarPagamentosCP } = require('../financeiro-avancado-routes');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-cpp] tenants: ${tenants.length}`);

let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const tem = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contas_pagar_pagamentos'").get();
    if (!tem) { console.log(`  ${t.slug}: sem a tabela, pulando`); continue; }

    const antes = db.prepare('SELECT COUNT(*) n FROM contas_pagar_pagamentos').get().n;
    const colsAntes = db.prepare('PRAGMA table_info(contas_pagar_pagamentos)').all();
    const precisava = !colsAntes.some(c => c.name === 'origem')
      || colsAntes.find(c => c.name === 'contaFinanceiraId')?.notnull === 1;

    migrarPagamentosCP(db);

    const depois = db.prepare('SELECT COUNT(*) n FROM contas_pagar_pagamentos').get().n;
    if (antes !== depois) throw new Error(`PERDA DE DADOS: ${antes} -> ${depois} linhas`);
    const cf = db.prepare('PRAGMA table_info(contas_pagar_pagamentos)').all()
      .find(c => c.name === 'contaFinanceiraId');
    if (cf.notnull === 1) throw new Error('contaFinanceiraId continua NOT NULL');

    console.log(precisava
      ? `  ${t.slug}: tabela alinhada (${depois} pagamento(s) preservado(s))`
      : `  ${t.slug}: já estava aplicado`);
    if (precisava) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}
console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
