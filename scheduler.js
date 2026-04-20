// scheduler.js
//
// Entrypoint master-only do LiciteAgora. Introduzido em NFSE-M06 onda 5C
// passo 4 (2026-04-20). Substitui `node server.js` com ROLE=master no
// systemd unit liciteagora.service — sem Express, sem app.listen, apenas
// os schedulers que antes rodavam embutidos no processo HTTP.
//
// Responsabilidades:
//   - Motor PNCP (sync completa/incremental + watchdog) via
//     pncp-sync-scheduler.js
//   - Timers master-only do motor PNCP (alertas de disputa 30min,
//     verificação diária de lacunas às 03:00)
//   - Jornal diário de licitações
//   - Régua de cobranças + recorrências NFSe
//   - Polling de boletos MercadoPago
//   - Reconciliador S6 NFSe (busca status/DANFSe de emissões pendentes)
//
// Dependência de schema: este processo NÃO cria tabelas nem executa
// migrações — delega isso ao worker (server.js, ROLE=worker na unit
// consulta-licitacoes.service). Para cold-start em máquina nova, suba o
// worker uma vez antes de iniciar este entrypoint.

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, 'pncp.db');
const db = new Database(dbPath);

// Consistente com server.js (WAL + synchronous=NORMAL). busy_timeout dá
// 5s para o worker soltar locks em conflitos de escrita esporádicos.
try {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
} catch (e) {
  console.warn('[master] Aviso ao ajustar pragmas:', e.message);
}

const { processarFilaAnalise } = require('./analise-ia');
const pncpSync = require('./pncp-sync-scheduler');
const { agendarJornal } = require('./jornal-scheduler');
const { agendarRecorrencias } = require('./recorrencia-scheduler');
const { agendarCobrancas } = require('./cobranca-scheduler');
const { agendarPollingBoletos } = require('./financeiro-routes');
const { iniciarReconciliadorS6 } = require('./nfse-routes');

function _startupBanner() {
  let licitacoes = 0, itens = 0, lastSyncDate = null;
  try {
    licitacoes = db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count;
    itens = db.prepare('SELECT COUNT(*) as count FROM itens').get().count;
    const row = db.prepare(`SELECT valor FROM config WHERE chave = 'lastSyncDate'`).get();
    lastSyncDate = row ? row.valor : null;
  } catch (e) {
    console.warn('[master] Banco sem schema esperado — suba o worker (ROLE=worker) uma vez antes do master. Erro:', e.message);
  }
  console.log(`[master] Banco de dados: ${dbPath}`);
  console.log(`[master] Dados no banco: ${licitacoes} licitações, ${itens} itens`);
  if (lastSyncDate) console.log(`[master] Última sincronização: ${lastSyncDate}`);
  console.log('[master] ROLE=master — schedulers-only (NÃO escuta HTTP)');
}

function _ligarSchedulers() {
  // Motor PNCP: init → sync inicial (completa se vazio, incremental
  // senão) → 3 timers master-only (watchdog a cada 10min com alerta
  // Telegram, disputa-alert a cada 5min, verificação diária às 03:00).
  pncpSync.init({ db, processarFilaAnalise });
  pncpSync.iniciarSyncEngine();
  pncpSync.startMasterOnlyTimers();

  // Jornal de Licitações (diário)
  agendarJornal(db);
  // Recorrências NFSe (emissão automática por calendário)
  agendarRecorrencias(db);
  // Régua de cobranças (verificação diária)
  agendarCobrancas(db);
  // Polling de boletos MercadoPago (a cada 30 min)
  agendarPollingBoletos(db);
  // Reconciliador S6 NFSe (busca DANFSe/status de notas pendentes)
  iniciarReconciliadorS6(db);

  console.log('[master] todos os schedulers ativos');
}

function _gracefulShutdown(signal) {
  console.log(`[master] recebido ${signal}, encerrando...`);
  try { db.close(); } catch (e) { /* best-effort */ }
  // setImmediate dá 1 tick para timers/logs pendentes descarregarem.
  setImmediate(() => process.exit(0));
}

process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => _gracefulShutdown('SIGINT'));

// Logs para crashes. Schedulers têm retry interno, então não derrubamos
// o processo por um erro isolado — systemd reinicia em crash real.
process.on('uncaughtException', (err) => {
  console.error('[master] uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[master] unhandledRejection:', reason);
});

try {
  _startupBanner();
  _ligarSchedulers();
} catch (err) {
  console.error('[master] FATAL erro no bootstrap:', err && err.stack || err);
  process.exit(1);
}
