// marca-backfill.js — Onda 3 (2026-05-06)
//
// Backfill em background da extração heurística de marca em catalog.itens.
// Roda no master process (scheduler.js). Lê itens com marcaExtraidaEm IS NULL,
// chama marca-extractor sobre i.descricao, persiste em catalog.itens.
//
// É CPU-bound — sem chamada de rede. Lotes maiores que o resultados-backfill.
//
// Persistência em catalog.catalog_sync_state:
//   - marcaBackfillLastRun
//   - marcaBackfillCount     (itens processados, com ou sem marca)
//   - marcaBackfillEncontrou (itens onde achou marca)
//
// Fase 3d (2026-05-23): dual-stack SQLite/Postgres via CATALOG_BACKEND_PG=1.

'use strict';

const { extrairMarca } = require('./marca-extractor');
const catalogPg = require('./catalog-pg');

// Ajustado 2026-05-06: a versão original (2000/30s) saturava o I/O do
// catálogo (11GB) competindo com o resultados-backfill. Agora 500/120s
// — ~15k/h = 4.3M em ~12 dias, sem afogar o disco.
const CYCLE_MS = 120 * 1000;
const LOTE_SIZE = 500;

let _db = null;
let _timer = null;
let _running = false;

function init({ db }) {
  if (!db) throw new Error('marca-backfill.init: db obrigatório');
  _db = db;
}

function _ensure() {
  if (!_db) throw new Error('marca-backfill não inicializado');
}

function _usePg() { return process.env.CATALOG_BACKEND_PG === '1'; }

async function _getState(key, fallback) {
  if (_usePg()) {
    const r = await catalogPg.queryOne('SELECT "value" FROM catalog_sync_state WHERE "key"=$1', [key]);
    return r ? r.value : fallback;
  }
  const row = _db.prepare('SELECT value FROM catalog_sync_state WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

async function _setState(key, value) {
  if (_usePg()) {
    await catalogPg.execute(
      `INSERT INTO catalog_sync_state ("key","value","updated_at") VALUES ($1,$2,$3)
       ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value", "updated_at"=EXCLUDED."updated_at"`,
      [key, String(value), Date.now()]
    );
    return;
  }
  _db.prepare(`
    INSERT INTO catalog_sync_state (key, value, updated_at)
    VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
  `).run(key, String(value));
}

async function _incState(key, delta) {
  const atual = parseInt(await _getState(key, '0'), 10) || 0;
  await _setState(key, atual + delta);
}

async function _ciclo() {
  if (_running) return;
  _running = true;
  const t0 = Date.now();
  try {
    let lote;
    if (_usePg()) {
      // idx_itens_marca_pend é WHERE marcaExtraidaEm IS NULL — planner usa
      // direto. ORDER BY id mantém scan sequencial pelo índice.
      lote = await catalogPg.query(`
        SELECT "id", "descricao" FROM itens
         WHERE "marcaExtraidaEm" IS NULL AND "descricao" IS NOT NULL
         ORDER BY "id" ASC
         LIMIT $1
      `, [LOTE_SIZE]);
    } else {
      lote = _db.prepare(`
        SELECT id, descricao FROM itens
         WHERE marcaExtraidaEm IS NULL
           AND descricao IS NOT NULL
         ORDER BY id ASC
         LIMIT ?
      `).all(LOTE_SIZE);
    }

    if (lote.length === 0) {
      await _setState('marcaBackfillLastRun', new Date().toISOString());
      console.log('[marca-backfill] nada pra fazer (todos itens processados)');
      return;
    }

    const ts = new Date().toISOString();
    let encontrou = 0;

    if (_usePg()) {
      // Single transaction, batch UPDATEs. Para 500 itens cabe em uma tx
      // sem locks longos (idx_itens_marca_pend só lista id pendente).
      await catalogPg.withTx(async (client) => {
        for (const row of lote) {
          const out = extrairMarca(row.descricao);
          await client.query(
            `UPDATE itens SET "marcaExtraida"=$1, "marcaConfianca"=$2, "marcaExtraidaEm"=$3 WHERE "id"=$4`,
            [out.marca, out.marca ? out.confianca : null, ts, row.id]
          );
          if (out.marca) encontrou++;
        }
      });
    } else {
      const stmt = _db.prepare(`
        UPDATE itens SET marcaExtraida = ?, marcaConfianca = ?, marcaExtraidaEm = ?
         WHERE id = ?
      `);
      // Transação grande para minimizar fsync (better-sqlite3 sync API).
      const tx = _db.transaction((rows) => {
        for (const row of rows) {
          const out = extrairMarca(row.descricao);
          stmt.run(out.marca, out.marca ? out.confianca : null, ts, row.id);
          if (out.marca) encontrou++;
        }
      });
      tx(lote);
    }

    await _incState('marcaBackfillCount', lote.length);
    if (encontrou > 0) await _incState('marcaBackfillEncontrou', encontrou);
    await _setState('marcaBackfillLastRun', ts);

    const ms = Date.now() - t0;
    const totalAcum = parseInt(await _getState('marcaBackfillCount', '0'), 10) || 0;
    const acumEnc = parseInt(await _getState('marcaBackfillEncontrou', '0'), 10) || 0;
    console.log(`[marca-backfill] +${lote.length} itens (${encontrou} com marca) em ${ms}ms — acum: ${totalAcum} (${acumEnc} com marca)`);
  } catch (err) {
    console.error('[marca-backfill] ciclo falhou:', err.message);
  } finally {
    _running = false;
  }
}

function iniciarBackfillEngine() {
  _ensure();
  // Primeiro ciclo em 60s (deixa boot + WAL acomodarem)
  _timer = setTimeout(async function loop() {
    await _ciclo();
    _timer = setTimeout(loop, CYCLE_MS);
  }, 60 * 1000);
  console.log(`[marca-backfill] engine iniciada (${LOTE_SIZE} itens a cada ${CYCLE_MS/1000}s${_usePg() ? ' — PG' : ''})`);
}

function pararBackfillEngine() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

async function getBackfillStatus() {
  _ensure();
  let total, processados, comMarca;
  if (_usePg()) {
    total = Number((await catalogPg.queryOne('SELECT COUNT(*) AS c FROM itens'))?.c || 0);
    processados = Number((await catalogPg.queryOne('SELECT COUNT(*) AS c FROM itens WHERE "marcaExtraidaEm" IS NOT NULL'))?.c || 0);
    comMarca = Number((await catalogPg.queryOne('SELECT COUNT(*) AS c FROM itens WHERE "marcaExtraida" IS NOT NULL'))?.c || 0);
  } else {
    total = _db.prepare(`SELECT COUNT(*) c FROM itens`).get().c;
    processados = _db.prepare(`SELECT COUNT(*) c FROM itens WHERE marcaExtraidaEm IS NOT NULL`).get().c;
    comMarca = _db.prepare(`SELECT COUNT(*) c FROM itens WHERE marcaExtraida IS NOT NULL`).get().c;
  }
  return {
    totalItens: total,
    processados,
    pendentes: total - processados,
    comMarca,
    progresso: total > 0 ? processados / total : 0,
    taxaCaptura: processados > 0 ? comMarca / processados : 0,
    lastRun: await _getState('marcaBackfillLastRun', null),
    contador: parseInt(await _getState('marcaBackfillCount', '0'), 10) || 0,
    encontrou: parseInt(await _getState('marcaBackfillEncontrou', '0'), 10) || 0,
  };
}

module.exports = { init, iniciarBackfillEngine, pararBackfillEngine, getBackfillStatus };
