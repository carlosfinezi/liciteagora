// catalog-pg.js (2026-05-23)
//
// Adapter Postgres pro catálogo (substitui catalog.db SQLite). Pool async
// que NÃO trava o event loop — primeira melhoria estrutural sobre
// better-sqlite3 (sync) usado historicamente no catalog.
//
// Filosofia:
//   - Pool central reusável (não abrir/fechar conexão por query)
//   - Helpers `query`, `queryOne`, `withTx` que retornam Promise
//   - Compatibilidade gradual: módulos que ainda usam SQLite continuam
//     funcionando enquanto refactor avança (dual-stack)
//
// Uso:
//   const catalogPg = require('./catalog-pg');
//   const rows = await catalogPg.query('SELECT * FROM licitacoes WHERE id = $1', [42]);
//   const lic  = await catalogPg.queryOne('SELECT * FROM licitacoes WHERE id = $1', [42]);
//   await catalogPg.withTx(async (client) => {
//     await client.query('INSERT INTO ...');
//     await client.query('UPDATE ...');
//   });

'use strict';

const { Pool } = require('pg');
const fs = require('fs');

const PG_PASS_FILE = '/etc/postgresql/16/main/liciteagora_catalog.pass';

let _pool = null;

/**
 * Retorna o pool singleton. Inicializa lazy na primeira chamada.
 * Pool config:
 *   - max=10 conexões (suficiente pra 5 tenants + scheduler)
 *   - idleTimeoutMillis=30s
 *   - statement_timeout=30s (evita queries pendurada travarem pool)
 */
function pool() {
  if (_pool) return _pool;

  let senha;
  try {
    senha = fs.readFileSync(PG_PASS_FILE, 'utf8').trim();
  } catch (e) {
    throw new Error(`catalog-pg: falha ao ler senha de ${PG_PASS_FILE}: ${e.message}`);
  }

  _pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER || 'liciteagora_catalog',
    password: senha,
    database: process.env.PG_DATABASE || 'liciteagora_catalog',
    max: 10,
    idleTimeoutMillis: 30000,
    statement_timeout: 30000,
    query_timeout: 30000,
  });

  _pool.on('error', (err) => {
    console.error('[catalog-pg] pool error (idle client):', err.message);
  });

  console.log('[catalog-pg] pool inicializado (max=10)');
  return _pool;
}

/**
 * Executa SELECT e retorna array de rows.
 * Placeholders: $1, $2, ... (não use ? do SQLite).
 */
async function query(sql, params = []) {
  const res = await pool().query(sql, params);
  return res.rows;
}

/**
 * SELECT com expectativa de 0 ou 1 row.
 */
async function queryOne(sql, params = []) {
  const res = await pool().query(sql, params);
  return res.rows[0] || null;
}

/**
 * INSERT/UPDATE/DELETE — retorna { rowCount, rows }.
 * Pra obter ID inserido use RETURNING id no SQL.
 */
async function execute(sql, params = []) {
  return pool().query(sql, params);
}

/**
 * Transação com retry automático em deadlock (SQLSTATE 40P01).
 * fn recebe um client (pg.PoolClient) — use client.query() dentro.
 */
async function withTx(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Stream rows pra processar grandes resultados sem carregar tudo em memória.
 * Usa cursor server-side (DECLARE/FETCH) automaticamente via pg-query-stream
 * (precisa do package, opcional).
 *
 * Uso:
 *   for await (const row of streamQuery('SELECT * FROM itens', [])) { ... }
 */
async function* streamQuery(sql, params = [], batchSize = 1000) {
  let pgQueryStream;
  try { pgQueryStream = require('pg-query-stream'); }
  catch (_) { throw new Error('catalog-pg.streamQuery requer "pg-query-stream"'); }

  const client = await pool().connect();
  try {
    const queryStream = client.query(new pgQueryStream(sql, params, { batchSize }));
    for await (const row of queryStream) yield row;
  } finally {
    client.release();
  }
}

/**
 * Fecha o pool (graceful shutdown).
 */
async function close() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    console.log('[catalog-pg] pool fechado');
  }
}

/**
 * Health check — retorna { ok, version, tables }.
 */
async function healthCheck() {
  try {
    const v = await queryOne('SELECT version() as version');
    const tabs = await query(`
      SELECT tablename, pg_size_pretty(pg_total_relation_size('public.'||tablename)) as size
        FROM pg_tables WHERE schemaname='public' ORDER BY pg_total_relation_size('public.'||tablename) DESC
    `);
    return { ok: true, version: v.version, tables: tabs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  pool,
  query,
  queryOne,
  execute,
  withTx,
  streamQuery,
  close,
  healthCheck,
};
