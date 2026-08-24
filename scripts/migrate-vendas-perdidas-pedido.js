#!/usr/bin/env node
// migrate-vendas-perdidas-pedido.js — aplica só as colunas/índices do
// vínculo venda perdida × pedido de venda em todos os tenants ativos.
//
// Uso: node scripts/migrate-vendas-perdidas-pedido.js [--dry-run]
//
// Escopo deliberadamente estreito: não roda initSchema nem as demais
// route-migrations (migrate-all-tenants.js faz isso). Idempotente.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const DRY = process.argv.includes('--dry-run');
const COLUNAS = ['pedidoId', 'pedidoItemId', 'pedidoNumero', 'concorrente'];
const PASSOS = [
  'ALTER TABLE vendas_perdidas ADD COLUMN pedidoId INTEGER REFERENCES pedidos(id) ON DELETE SET NULL',
  'ALTER TABLE vendas_perdidas ADD COLUMN pedidoItemId INTEGER REFERENCES pedido_itens(id) ON DELETE SET NULL',
  'ALTER TABLE vendas_perdidas ADD COLUMN pedidoNumero TEXT',
  'ALTER TABLE vendas_perdidas ADD COLUMN concorrente TEXT',
  'CREATE INDEX IF NOT EXISTS idx_vp_pedido ON vendas_perdidas(pedidoId)',
  'CREATE INDEX IF NOT EXISTS idx_vp_cliente ON vendas_perdidas(clienteId, data)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_vp_item_unico ON vendas_perdidas(pedidoItemId) WHERE pedidoItemId IS NOT NULL',
];

const log = m => console.log('[migrate-vp] ' + m);

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
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='vendas_perdidas'").get().n;
    if (!temTabela) { log(`${t.slug}: sem tabela vendas_perdidas — pulado`); pulados++; continue; }

    const antes = db.prepare('PRAGMA table_info(vendas_perdidas)').all().map(c => c.name);
    const faltando = COLUNAS.filter(c => !antes.includes(c));

    if (!DRY) {
      for (const sql of PASSOS) {
        try { db.exec(sql); }
        catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      }
    }

    const depois = DRY ? antes : db.prepare('PRAGMA table_info(vendas_perdidas)').all().map(c => c.name);
    const aindaFalta = DRY ? [] : COLUNAS.filter(c => !depois.includes(c));
    if (aindaFalta.length) throw new Error('colunas não aplicadas: ' + aindaFalta.join(', '));

    const idx = db.prepare(
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_vp_item_unico'").get().n;
    if (!DRY && !idx) throw new Error('índice único idx_vp_item_unico não criado');

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
