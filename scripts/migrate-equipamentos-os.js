#!/usr/bin/env node
// migrate-equipamentos-os.js — cria o cadastro de equipamentos, a coluna
// os_ordens.equipamentoId, os_itens_pecas.custoUnitario, e faz o backfill
// das OS existentes.
//
// Uso: node scripts/migrate-equipamentos-os.js [--dry-run]
//
// Migração dentro de registrarRotasX é no-op em multi-tenant (server.js:85),
// então precisa rodar por tenant. Idempotente.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const DRY = process.argv.includes('--dry-run');
const log = m => console.log('[migrate-equip] ' + m);

const DDL = [
  `CREATE TABLE IF NOT EXISTS equipamentos (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     clienteId INTEGER, descricao TEXT NOT NULL, marca TEXT, modelo TEXT,
     numeroSerie TEXT, patrimonio TEXT, produtoId INTEGER, serialNumberId INTEGER,
     dataAquisicao TEXT, garantiaFabricanteAte TEXT, observacoes TEXT,
     ativo INTEGER NOT NULL DEFAULT 1,
     dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
     dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS equipamento_eventos (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     equipamentoId INTEGER NOT NULL, tipo TEXT NOT NULL, descricao TEXT,
     clienteAnteriorId INTEGER, clienteNovoId INTEGER, osId INTEGER,
     usuario TEXT, data TEXT DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (equipamentoId) REFERENCES equipamentos(id) ON DELETE CASCADE)`,
  'CREATE INDEX IF NOT EXISTS idx_equip_cliente ON equipamentos(clienteId, ativo)',
  'CREATE INDEX IF NOT EXISTS idx_equip_serie ON equipamentos(numeroSerie)',
  'CREATE INDEX IF NOT EXISTS idx_equip_modelo ON equipamentos(marca, modelo)',
  'CREATE INDEX IF NOT EXISTS idx_equip_ev ON equipamento_eventos(equipamentoId, data)',
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_equip_serie_unica ON equipamentos(clienteId, numeroSerie)
     WHERE numeroSerie IS NOT NULL AND numeroSerie <> ''`,
  'ALTER TABLE os_ordens ADD COLUMN equipamentoId INTEGER',
  'CREATE INDEX IF NOT EXISTS idx_os_equipamento ON os_ordens(equipamentoId, dataAbertura)',
  'ALTER TABLE os_itens_pecas ADD COLUMN custoUnitario REAL',
];

const normSerie = s => String(s || '').trim().toUpperCase().replace(/[\s\-._/]/g, '');

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

    const temOS = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='os_ordens'").get().n;
    if (!temOS) { log(`${t.slug}: sem módulo de OS — pulado`); pulados++; continue; }

    if (!DRY) {
      for (const sql of DDL) {
        try { db.exec(sql); }
        catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      }
      const cols = db.prepare('PRAGMA table_info(os_ordens)').all().map(c => c.name);
      if (!cols.includes('equipamentoId')) throw new Error('os_ordens.equipamentoId não aplicada');
    }

    // Backfill: cada OS com informação de equipamento vira/aponta para um
    // registro. Série normalizada é a chave; sem série, cliente + textos.
    const candidatas = db.prepare(`SELECT id, clienteId, equipamento, marca, modelo, numeroSerieEquipamento
      FROM os_ordens
      WHERE ${DRY ? '1=1' : 'equipamentoId IS NULL'}
        AND ( (equipamento IS NOT NULL AND equipamento <> '')
           OR (marca IS NOT NULL AND marca <> '')
           OR (modelo IS NOT NULL AND modelo <> '')
           OR (numeroSerieEquipamento IS NOT NULL AND numeroSerieEquipamento <> '') )`).all();

    let criados = 0, vinculadas = 0;
    if (!DRY && candidatas.length) {
      const porSerie = new Map();   // serie normalizada -> equipamentoId
      const porTexto = new Map();   // cliente|marca|modelo|desc -> equipamentoId
      const insEq = db.prepare(`INSERT INTO equipamentos (clienteId, descricao, marca, modelo, numeroSerie)
        VALUES (?, ?, ?, ?, ?)`);
      const insEv = db.prepare(`INSERT INTO equipamento_eventos (equipamentoId, tipo, descricao, clienteNovoId)
        VALUES (?, 'cadastro', 'Criado no backfill a partir das OS existentes', ?)`);

      db.transaction(() => {
        for (const os of candidatas) {
          const serie = String(os.numeroSerieEquipamento || '').trim();
          const chaveSerie = serie ? normSerie(serie) : null;
          const chaveTexto = [os.clienteId, (os.marca || '').toLowerCase(),
                              (os.modelo || '').toLowerCase(), (os.equipamento || '').toLowerCase()].join('|');
          let eqId = chaveSerie ? porSerie.get(chaveSerie) : porTexto.get(chaveTexto);

          if (!eqId) {
            const desc = (os.equipamento || '').trim()
              || [os.marca, os.modelo].filter(Boolean).join(' ')
              || 'Equipamento sem descrição';
            eqId = insEq.run(os.clienteId || null, desc,
              (os.marca || '').trim() || null, (os.modelo || '').trim() || null, serie || null).lastInsertRowid;
            insEv.run(eqId, os.clienteId || null);
            criados++;
            if (chaveSerie) porSerie.set(chaveSerie, eqId); else porTexto.set(chaveTexto, eqId);
          }
          db.prepare('UPDATE os_ordens SET equipamentoId = ? WHERE id = ?').run(eqId, os.id);
          vinculadas++;
        }
      })();
    }

    log(`${t.slug}: OK — ${candidatas.length} OS com equipamento`
      + (DRY ? ' (nada gravado)' : ` → ${criados} equipamento(s) criado(s), ${vinculadas} OS vinculada(s)`));
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
