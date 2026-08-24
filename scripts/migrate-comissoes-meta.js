#!/usr/bin/env node
// migrate-comissoes-meta.js — gatilho/acelerador de meta nas regras e rastro do
// pagamento nas apurações.
//
// O rastro (contaPagarId, movimentacaoId) é o que permite o estorno desfazer o
// pagamento de verdade. Sem essas colunas o estorno só mudava o status e o
// dinheiro ficava fora do caixa.
//
// listAll e não listActive: applyRouteMigrations só roda na criação do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const COLUNAS = [
  ['comissoes_regras', 'metaMinimaPercentual REAL'],
  ['comissoes_regras', 'valorAcelerado REAL'],
  ['comissoes_apuracao', 'contaPagarId INTEGER'],
  ['comissoes_apuracao', 'movimentacaoId INTEGER'],
  ['comissoes_apuracao', 'motivoSemComissao TEXT'],
  ['comissoes_apuracao', 'baseApuracao TEXT'],
];

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-comissoes] tenants: ${tenants.length}`);
let mudados = 0;

for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const criadas = [];
    const ausentes = new Set();
    for (const [tabela, definicao] of COLUNAS) {
      const existe = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(tabela);
      // Tenant sem o modulo nao é "ja aplicado": dizer isso esconderia que ele
      // vai precisar da migracao quando o modulo for provisionado.
      if (!existe) { ausentes.add(tabela); continue; }
      const coluna = definicao.split(' ')[0];
      const jaTem = db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
      if (jaTem) continue;
      db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${definicao}`);
      criadas.push(`${tabela}.${coluna}`);
    }

    // Apurações pagas antes desta migração não têm o rastro: o estorno delas
    // não vai encontrar conta a pagar para cancelar. Melhor saber quantas são.
    let pagasSemRastro = 0;
    try {
      pagasSemRastro = db.prepare(
        "SELECT COUNT(*) n FROM comissoes_apuracao WHERE status = 'paga' AND contaPagarId IS NULL").get().n;
    } catch { /* tabela ausente */ }

    const resumo = ausentes.size === new Set(COLUNAS.map((c) => c[0])).size
      ? 'sem o módulo de comissões (tabelas não existem)'
      : (criadas.length ? `${criadas.length} coluna(s) — ${criadas.join(', ')}` : 'já estava aplicado');
    console.log(`  ${t.slug}: ${resumo}`
      + (pagasSemRastro ? ` · ATENÇÃO: ${pagasSemRastro} comissão(ões) já paga(s) sem rastro — o estorno delas só muda o status` : ''));
    if (criadas.length) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}

console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
