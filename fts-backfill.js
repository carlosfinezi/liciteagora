// fts-backfill.js — Onda 3 perf v2 (2026-05-06)
//
// Popula a tabela virtual FTS5 itens_fts com itens existentes que ainda
// não estão indexados. Para itens NOVOS chegando via pncp-sync, o trigger
// itens_fts_insert mantém sincronizado automaticamente.
//
// Estratégia: cursor por id DESCENDENTE — indexa do mais NOVO para o mais
// antigo. Alinha com a prioridade do resultados-backfill (últimos 365 dias),
// garantindo que items recém-indexados no FTS já tenham vencedor cacheado.
// (v1 indexava ASC e ficava órfã: FTS cobria items antigos, vencedores
// só nos recentes — overlap zero.)
//
// Persistência:
//   - ftsBackfillCursor  (próximo "teto" de id; começa em MAX(id)+1, decresce)
//   - ftsBackfillCount   (total acumulado de inserts)
//   - ftsBackfillLastRun (ISO timestamp)

'use strict';

const CYCLE_MS = 60 * 1000;     // 60s entre lotes
const LOTE_SIZE = 5000;          // 5k itens por lote (~10s de I/O)

let _db = null;
let _timer = null;
let _running = false;

function init({ db }) {
  if (!db) throw new Error('fts-backfill.init: db obrigatório');
  _db = db;
}

function _ensure() { if (!_db) throw new Error('fts-backfill não inicializado'); }

function _getState(key, fallback) {
  const row = _db.prepare('SELECT value FROM catalog_sync_state WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function _setState(key, value) {
  _db.prepare(`
    INSERT INTO catalog_sync_state (key, value, updated_at)
    VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
  `).run(key, String(value));
}

function _ciclo() {
  if (_running) return;
  _running = true;
  const t0 = Date.now();
  try {
    // Cursor representa o "teto exclusivo" do próximo lote — pegamos id < cursor.
    // Inicializa em MAX(id) + 1 (1ª execução pega tudo do mais novo até MAX-LOTE).
    const cursorRaw = _getState('ftsBackfillCursor', null);
    let cursor;
    if (cursorRaw == null) {
      cursor = (_db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS c FROM itens`).get().c);
    } else {
      cursor = parseInt(cursorRaw, 10);
    }

    const lote = _db.prepare(`
      SELECT id, descricao FROM itens
       WHERE id < ? AND descricao IS NOT NULL AND descricao != ''
       ORDER BY id DESC
       LIMIT ?
    `).all(cursor, LOTE_SIZE);

    if (lote.length === 0) {
      _setState('ftsBackfillLastRun', new Date().toISOString());
      console.log('[fts-backfill] catálogo todo indexado (cursor =', cursor, ')');
      return;
    }

    // Trigger AFTER INSERT em itens já adiciona ao FTS para inserts via
    // master sync. Aqui no backfill estamos lidando com itens que JÁ
    // existem em catalog.itens mas ainda não foram indexados — INSERT OR IGNORE
    // absorve duplicatas (caso o backfill rode em paralelo com insert via trigger).
    const insertSafe = _db.prepare(`INSERT OR IGNORE INTO itens_fts(rowid, descricao) VALUES (?, ?)`);
    const tx = _db.transaction((rows) => {
      for (const r of rows) insertSafe.run(r.id, r.descricao);
    });
    tx(lote);

    // Lote vem ORDER BY id DESC, então o id mais BAIXO é o último elemento.
    // Próximo cursor = esse id (próximo ciclo pega id < esse id).
    const minIdLote = lote[lote.length - 1].id;
    _setState('ftsBackfillCursor', minIdLote);
    const novoTotal = (parseInt(_getState('ftsBackfillCount', '0'), 10) || 0) + lote.length;
    _setState('ftsBackfillCount', novoTotal);
    _setState('ftsBackfillLastRun', new Date().toISOString());

    const ms = Date.now() - t0;
    console.log(`[fts-backfill] +${lote.length} itens em ${ms}ms (cursor agora ${minIdLote}, total ${novoTotal})`);
  } catch (err) {
    console.error('[fts-backfill] ciclo falhou:', err.message);
  } finally {
    _running = false;
  }
}

function iniciarBackfillEngine() {
  _ensure();
  // Fase 3d (2026-05-23): Postgres já tem GIN tsvector nativo
  // (idx_itens_desc_fts) mantido on-write por to_tsvector na index. FTS5 do
  // SQLite e o backfill que o popula viram desnecessários — engine vira no-op.
  if (process.env.CATALOG_BACKEND_PG === '1') {
    console.log('[fts-backfill] desativado (PG GIN tsvector cobre — sem backfill necessário)');
    return;
  }
  // Primeiro ciclo em 90s (deixa boot + outros backfills acomodarem).
  // Reagendamento em finally: se algo escapar do _ciclo(), a engine sobrevive.
  // Ver resultados-backfill.js — lá esse padrão matou a engine em 2026-08-07.
  // (_ciclo aqui é síncrono — better-sqlite3.)
  _timer = setTimeout(function loop() {
    try {
      _ciclo();
    } catch (err) {
      console.error('[fts-backfill] ciclo escapou:', err.message);
    } finally {
      _timer = setTimeout(loop, CYCLE_MS);
    }
  }, 90 * 1000);
  console.log(`[fts-backfill] engine iniciada (${LOTE_SIZE} itens a cada ${CYCLE_MS/1000}s)`);
}

function pararBackfillEngine() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

function getStatus() {
  _ensure();
  const total = _db.prepare(`SELECT COUNT(*) c FROM itens`).get().c;
  const indexados = _db.prepare(`SELECT COUNT(*) c FROM itens_fts`).get().c;
  return {
    totalItens: total,
    indexados,
    pendentes: total - indexados,
    progresso: total > 0 ? indexados / total : 0,
    cursor: parseInt(_getState('ftsBackfillCursor', '0'), 10) || 0,
    lastRun: _getState('ftsBackfillLastRun', null),
  };
}

module.exports = { init, iniciarBackfillEngine, pararBackfillEngine, getStatus };
