// stmt-cache.js
//
// Cache de prepared statements por (db, sql). Necessário porque em
// multi-tenant o `db` pode ser um Proxy que resolve para DBs diferentes
// a cada request — não podemos mais preparar statements no boot e
// guardar em closure (o stmt fica ligado ao DB da hora da preparação).
//
// Uso típico:
//
//   const { createStmtCache } = require('./stmt-cache');
//   const stmt = createStmtCache();
//
//   function salvarX(db, x) {
//     stmt(db, 'INSERT INTO x ...').run(x);
//   }
//
// O cache usa WeakMap<realDb, Map<sql, stmt>>. Para descobrir o DB real
// por trás de um Proxy, aceita-se a convenção de que o Proxy expõe a
// propriedade mágica `__real` (ver tenant-middleware.createDbProxy).
// Se não houver, cai no próprio db (single-tenant).
//
// Prepared statements do better-sqlite3 são leves (~0.01ms) mas o parse
// do SQL em cada chamada custa o suficiente para justificar cache quando
// o stmt roda milhares de vezes (hot paths como sync PNCP).

function createStmtCache() {
  const cache = new WeakMap();

  function getStmt(db, sql) {
    const real = (db && db.__real) || db;
    let per = cache.get(real);
    if (!per) {
      per = new Map();
      cache.set(real, per);
    }
    let s = per.get(sql);
    if (!s) {
      s = real.prepare(sql);
      per.set(sql, s);
    }
    return s;
  }

  return getStmt;
}

module.exports = { createStmtCache };
