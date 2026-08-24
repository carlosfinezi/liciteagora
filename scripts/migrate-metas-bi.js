#!/usr/bin/env node
// migrate-metas-bi.js — cria metas_equipe e as colunas de meta de margem/
// pedidos em metas_vendas, em todos os tenants ativos.
//
// Uso: node scripts/migrate-metas-bi.js [--dry-run]
//
// Escopo estreito de propósito: migração dentro de registrarRotasX é no-op
// em multi-tenant (server.js:85), e rodar migrate-all-tenants.js inteiro
// para duas colunas tem raio de ação grande demais. Idempotente.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const DRY = process.argv.includes('--dry-run');
const COLUNAS = ['valorMetaMargem', 'metaPedidos'];
const PASSOS = [
  `CREATE TABLE IF NOT EXISTS metas_equipe (
     competencia TEXT PRIMARY KEY,
     valorMeta REAL NOT NULL DEFAULT 0,
     valorMetaMargem REAL,
     observacao TEXT,
     dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
   )`,
  'ALTER TABLE metas_vendas ADD COLUMN valorMetaMargem REAL',
  'ALTER TABLE metas_vendas ADD COLUMN metaPedidos INTEGER',
];

const log = m => console.log('[migrate-metas] ' + m);

const mgr = createTenantManager({ initSchema });
// listAll, nao listActive: applyRouteMigrations so roda na CRIACAO do
// tenant (control-plane-routes.js:402). Tenant suspenso que voltar a ativo
// nao reaplica migracao nenhuma e ficaria sem as colunas novas.
const tenants = mgr.listAll();
log(`tenants ativos: ${tenants.length}${DRY ? ' (DRY-RUN)' : ''}`);

let ok = 0, erro = 0, pulados = 0;
for (const t of tenants) {
  let db;
  try {
    db = new Database(t.db_path);
    db.pragma('busy_timeout = 10000');

    const temTabela = db.prepare(
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='metas_vendas'").get().n;
    if (!temTabela) { log(`${t.slug}: sem tabela metas_vendas — pulado`); pulados++; continue; }

    const antes = db.prepare('PRAGMA table_info(metas_vendas)').all().map(c => c.name);
    const faltando = COLUNAS.filter(c => !antes.includes(c));

    if (!DRY) {
      for (const sql of PASSOS) {
        try { db.exec(sql); }
        catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      }
      // alterSafe engole erro por design; aqui um ALTER que falhou de
      // verdade some com a meta de margem em silêncio.
      const depois = db.prepare('PRAGMA table_info(metas_vendas)').all().map(c => c.name);
      const aindaFalta = COLUNAS.filter(c => !depois.includes(c));
      if (aindaFalta.length) throw new Error('colunas não aplicadas: ' + aindaFalta.join(', '));
      const temEquipe = db.prepare(
        "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='metas_equipe'").get().n;
      if (!temEquipe) throw new Error('metas_equipe não criada');
    }

    log(`${t.slug}: OK${faltando.length ? ' (+' + faltando.join(', ') + ')' : ' (já estava migrado)'}`);
    ok++;
  } catch (err) {
    erro++;
    log(`${t.slug}: ERRO ${err.message}`);
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

log(`fim — ${ok} OK, ${pulados} pulado(s), ${erro} erro(s)`);
process.exit(erro ? 1 : 0);
