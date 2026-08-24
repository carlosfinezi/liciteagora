/**
 * /api/sync/status — de onde vêm as últimas sincronizações.
 *
 * O DEFEITO: a rota lia lastFullSync/lastIncrementalSync/lastSyncDate do
 * `config` do TENANT. Esses marcadores saíram de lá em 2026-04-22 (Fase 8,
 * para `catalog_sync_state`) e em 2026-05-23 foram para o Postgres. Nenhum
 * dos 11 tenants tinha as chaves, então os três voltavam null — e com
 * lastFullSync null a tela mostra o alerta vermelho "Sincronização completa
 * nunca foi executada!".
 *
 * Resultado: a tela afirmava que a coleta nunca rodou enquanto o incremental
 * rodava a cada poucos minutos. Lido de fora, isso é exatamente
 * "o catálogo parou de receber licitações".
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

delete process.env.CATALOG_BACKEND_PG;   // exercita o caminho SQLite
const { registrarRotasSync } = require('../sync-routes');

const DB = '/tmp/vp-syncmark.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(`
CREATE TABLE config (chave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE catalog_sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
CREATE TABLE licitacoes (id INTEGER PRIMARY KEY, dataEncerramentoProposta TEXT, dataEncerramentoPortal TEXT);
CREATE TABLE itens (id INTEGER PRIMARY KEY);
`);

const pncpSync = {
  getSyncStatus: () => ({ running: false, type: null, progress: 0, total: 0, currentDay: null }),
  isRunning: () => false,
};

const app = express();
app.use(express.json());
registrarRotasSync(app, db, { pncpSync });

// Invoca o handler registrado sem subir servidor.
function chamar(metodo, caminho) {
  const camada = app.router.stack.find((l) => l.route && l.route.path === caminho
    && l.route.methods[metodo.toLowerCase()]);
  if (!camada) throw new Error('rota não registrada: ' + caminho);
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      set() { return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    Promise.resolve(camada.route.stack[0].handle({ query: {}, body: {} }, res, reject)).catch(reject);
  });
}

let ok = 0, fail = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m} (esperado ${b}, veio ${a})`);

const limpar = () => { db.exec('DELETE FROM catalog_sync_state; DELETE FROM config;'); };

(async () => {
console.log('\n== a regressão que motivou a correção ==');

await t('marcadores no catálogo são encontrados (antes voltavam null)', async () => {
  limpar();
  db.prepare('INSERT INTO catalog_sync_state (key, value, updated_at) VALUES (?,?,0)')
    .run('lastFullSync', '2026-05-29T22:34:50.210Z');
  db.prepare('INSERT INTO catalog_sync_state (key, value, updated_at) VALUES (?,?,0)')
    .run('lastIncrementalSync', '2026-08-02T15:28:35.755Z');
  db.prepare('INSERT INTO catalog_sync_state (key, value, updated_at) VALUES (?,?,0)')
    .run('lastSyncDate', '2026-08-09');
  const r = await chamar('get', '/api/sync/status');
  eq(r.body.lastFullSync, '2026-05-29T22:34:50.210Z', 'lastFullSync');
  eq(r.body.lastIncrementalSync, '2026-08-02T15:28:35.755Z', 'lastIncrementalSync');
  eq(r.body.lastSyncDate, '2026-08-09', 'lastSyncDate');
});

await t('com o marcador presente a tela NÃO acusa "sync nunca executada"', async () => {
  const r = await chamar('get', '/api/sync/status');
  // status.html dispara o alerta vermelho exatamente com `!data.lastFullSync`.
  assert(r.body.lastFullSync, 'lastFullSync vazio reacenderia o alerta falso');
});

await t('config do tenant vazio não zera os marcadores do catálogo', async () => {
  // Este é o estado real dos 11 tenants: config sem nenhuma das chaves.
  const r = await chamar('get', '/api/sync/status');
  eq(db.prepare('SELECT COUNT(*) n FROM config').get().n, 0, 'config está vazio de propósito');
  assert(r.body.lastIncrementalSync, 'deveria vir do catálogo mesmo com config vazio');
});

console.log('\n== compatibilidade e bordas ==');

await t('instalação legada com marcadores no config ainda funciona', async () => {
  limpar();
  db.prepare('INSERT INTO config (chave, valor) VALUES (?,?)').run('lastFullSync', '2025-01-01T00:00:00Z');
  db.prepare('INSERT INTO config (chave, valor) VALUES (?,?)').run('lastSyncDate', '2025-01-01');
  const r = await chamar('get', '/api/sync/status');
  eq(r.body.lastFullSync, '2025-01-01T00:00:00Z', 'fallback para config');
});

await t('catálogo tem precedência sobre o config antigo', async () => {
  db.prepare('INSERT INTO catalog_sync_state (key, value, updated_at) VALUES (?,?,0)')
    .run('lastFullSync', '2026-05-29T22:34:50.210Z');
  const r = await chamar('get', '/api/sync/status');
  eq(r.body.lastFullSync, '2026-05-29T22:34:50.210Z', 'o valor novo vence');
});

await t('sem marcador em lugar nenhum devolve null sem quebrar', async () => {
  limpar();
  const r = await chamar('get', '/api/sync/status');
  eq(r.body.lastFullSync, null, 'lastFullSync');
  eq(r.body.diasDesatualizados, 0, 'dias desatualizados');
});

await t('catálogo ausente (sem ATTACH) não derruba a rota', async () => {
  const semCatalogo = new Database(':memory:');
  semCatalogo.exec(`CREATE TABLE config (chave TEXT PRIMARY KEY, valor TEXT);
    CREATE TABLE licitacoes (id INTEGER PRIMARY KEY, dataEncerramentoProposta TEXT, dataEncerramentoPortal TEXT);
    CREATE TABLE itens (id INTEGER PRIMARY KEY);`);
  const app2 = express();
  registrarRotasSync(app2, semCatalogo, { pncpSync });
  const camada = app2.router.stack.find((l) => l.route && l.route.path === '/api/sync/status');
  const r = await new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; },
      set() { return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    Promise.resolve(camada.route.stack[0].handle({ query: {}, body: {} }, res, reject)).catch(reject);
  });
  eq(r.status, 200, 'status HTTP');
  eq(r.body.lastFullSync, null, 'sem marcador');
});

console.log(`\n${ok} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
})();
