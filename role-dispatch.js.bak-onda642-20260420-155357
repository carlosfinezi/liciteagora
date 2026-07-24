/**
 * role-dispatch.js
 * ------------------------------------------------------------------
 * Extraído do server.js (NFSE-M06 onda 6.34).
 *
 * Contexto do split master/worker (herdado da onda NFSE-M06 original):
 * cada systemd unit tinha sua própria corrida para bindar :3000 dentro
 * de app.listen(). Só quem ganhava o bind chegava a executar o callback
 * — e com isso, os schedulers dependiam da sorte do EADDRINUSE. Desde
 * então:
 *   - master NÃO escuta HTTP: roda apenas schedulers (sync PNCP,
 *     jornal, recorrências, cobranças, polling boletos, reconciliador
 *     NFSe S6). Libera ~180MB de RSS ocioso.
 *   - worker escuta :3000 normalmente e não agenda nada.
 * Benefício colateral: pronto para multi-tenant (um master por
 * instalação, vários workers horizontal-scale) sem re-arranjar o código.
 *
 * Historia recente:
 *   - onda 5C passo 4 (2026-04-20) introduziu scheduler.js como
 *     entrypoint dedicado para ROLE=master (liciteagora.service
 *     roda `node scheduler.js`). O ramo `master` deste factory passou
 *     a ser "cinturão e suspensórios" — serve para testes manuais
 *     de `node server.js` sem ROLE setado, mas a produção não
 *     encosta nele.
 *   - onda 6.34 (este módulo) move o dispatch e os helpers de startup
 *     do server.js para cá.
 *
 * Dependências injetadas (todas explícitas — nenhuma global):
 *   db, app, PORT, apiKey, dbPath, PNCP_API_BASE, getConfigValue,
 *   pncpSync, agendarJornal, agendarRecorrencias, agendarCobrancas,
 *   agendarPollingBoletos, iniciarReconciliadorS6.
 *
 * Uso:
 *   const { createRoleDispatch } = require('./role-dispatch');
 *   const rd = createRoleDispatch({ db, app, PORT, ... });
 *   rd.dispatch();                  // usa process.env.ROLE || 'master'
 *   rd.dispatch('worker');          // força worker
 *   rd.startWorker() / rd.startMaster(); // se precisar chamar direto
 */

function createRoleDispatch(deps) {
  const {
    db, app, PORT, apiKey, dbPath, PNCP_API_BASE, getConfigValue,
    pncpSync, agendarJornal, agendarRecorrencias, agendarCobrancas,
    agendarPollingBoletos, iniciarReconciliadorS6,
  } = deps;

  function logStartupBanner(role) {
    const stats = {
      licitacoes: db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count,
      itens: db.prepare('SELECT COUNT(*) as count FROM itens').get().count
    };
    console.log(`[${role}] Banco de dados: ${dbPath}`);
    console.log(`[${role}] API do PNCP: ${PNCP_API_BASE}`);
    console.log(`[${role}] API Key extensão: ${apiKey}`);
    console.log(`[${role}] Dados no banco: ${stats.licitacoes} licitações, ${stats.itens} itens`);
    const lastSyncDate = getConfigValue('lastSyncDate');
    if (lastSyncDate) {
      console.log(`[${role}] Última sincronização: ${lastSyncDate}`);
    }
    return stats;
  }

  function startMaster() {
    logStartupBanner('master');
    console.log('[master] ROLE=master — schedulers-only (NÃO escuta HTTP)');

    // NFSE-M06 onda 5C passo 2: motor PNCP + 3 timers master-only (watchdog,
    // disputa-alert, verificação diária de lacunas) vivem em
    // pncp-sync-scheduler.js. Na onda 5C passo 4 o entrypoint vira
    // scheduler.js (sem Express) chamando essas mesmas funções.
    pncpSync.iniciarSyncEngine();
    pncpSync.startMasterOnlyTimers();

    // Jornal de Licitações
    agendarJornal(db);
    // Recorrências NFSe
    agendarRecorrencias(db);
    // Cobranças (régua diária)
    agendarCobrancas(db);
    // Polling boletos MercadoPago (a cada 30 min)
    agendarPollingBoletos(db);
    // NFSE-M06: Reconciliador S6 NFSe — decouplado de registrarRotasNfse.
    // Chamada explícita aqui para que o scheduler.js possa chamar o mesmo
    // helper sem precisar montar Express app.
    iniciarReconciliadorS6(db);
  }

  function startWorker() {
    app.listen(PORT, () => {
      logStartupBanner('worker');
      console.log(`[worker] Servidor rodando em http://localhost:${PORT}`);
      console.log('[worker] Endpoints disponíveis:');
      console.log(`  GET  http://localhost:${PORT}/api/licitacoes`);
      console.log(`  GET  http://localhost:${PORT}/api/licitacoes/:cnpj/:sequencial/:ano`);
      console.log(`  GET  http://localhost:${PORT}/api/orgaos`);
      console.log(`  GET  http://localhost:${PORT}/api/sync/status`);
      console.log(`  POST http://localhost:${PORT}/api/sync/start        (auto: incremental ou completa)`);
      console.log(`  POST http://localhost:${PORT}/api/sync/full         (força sync completa)`);
      console.log(`  POST http://localhost:${PORT}/api/sync/incremental  (força sync incremental)`);
      console.log('[worker] ROLE=worker — HTTP-only (nenhum scheduler rodando aqui)');
    }).on('error', (err) => {
      // Quando o worker perde a corrida do bind, queremos log explícito
      // ao invés de stacktrace cru no uncaughtException.
      if (err && err.code === 'EADDRINUSE') {
        console.error(`[worker] FATAL EADDRINUSE :${PORT} — outro processo já escuta. Abortando.`);
      } else {
        console.error('[worker] FATAL erro no listen:', err);
      }
      process.exit(1);
    });
  }

  function dispatch(role) {
    const serverRole = role || process.env.ROLE || 'master';
    if (serverRole === 'master') {
      startMaster();
    } else {
      startWorker();
    }
  }

  return { dispatch, startMaster, startWorker, logStartupBanner };
}

module.exports = { createRoleDispatch };
