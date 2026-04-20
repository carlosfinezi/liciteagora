// sync-routes.js
//
// Rotas HTTP de controle da sincronização com o PNCP — status e disparo
// manual dos jobs de sync. Extraído de server.js em NFSE-M06 onda 6.16.
//
// Escopo: 4 rotas /api/sync/*:
//   GET  /api/sync/status       → métricas do banco + estado do motor
//                                  (running, progresso, última sync,
//                                  cobertura futura, dias desatualizado)
//   POST /api/sync/full         → dispara sincronização completa
//   POST /api/sync/incremental  → dispara sincronização incremental
//   POST /api/sync/start        → endpoint legado: incremental se há
//                                  dados, completa se banco vazio
//
// DEPENDÊNCIAS:
//   - db          better-sqlite3 (SELECT COUNT, config lastSync*,
//                 dataEncerramentoProposta)
//   - pncpSync    o motor (módulo ./pncp-sync-scheduler) — precisa
//                 ter sido iniciado com pncpSync.init({db, …}) antes
//                 do registerRotas; o server.js já faz isso.
//
// GATE ROLE=worker (NFSE-M06 onda 5C passo 2):
// GET /api/sync/status é seguro em qualquer processo — apenas LÊ o
// estado in-memory (no worker será o estado zerado; o front já sabe
// lidar com isso). Mas os POSTs de disparo (/full, /incremental,
// /start) só fazem sentido no master: é lá que roda o motor de sync
// (com seus prepared statements, fila de análise, axios agent). Se
// caíssem no worker, o motor do worker executaria e o estado
// in-memory divergiria do master — que continua rodando sync
// automática a cada 5min em paralelo, DOBRANDO o tráfego ao PNCP.
// Por isso: POSTs no worker retornam 503 com orientação ao admin.
//
// A leitura de ROLE é feita em runtime de cada request (não no
// registro), para facilitar testes e preservar o comportamento
// idêntico ao monolito.

function _rejeitaSyncNoWorker(res) {
  return res.status(503).json({
    success: false,
    error: 'Sincronização manual indisponível no worker HTTP. O master executa sync incremental a cada 5min automaticamente; para forçar agora, reinicie o serviço liciteagora (master).'
  });
}

function registrarRotasSync(app, db, { pncpSync }) {
  if (!pncpSync) {
    throw new Error('sync-routes: pncpSync é obrigatório (import do pncp-sync-scheduler)');
  }

  /**
   * Endpoint para consultar status da sincronização
   */
  app.get('/api/sync/status', (req, res) => {
    try {
      // Estatísticas do banco
      const licitacoesCount = db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count;
      const itensCount = db.prepare('SELECT COUNT(*) as count FROM itens').get().count;

      // Configurações de sync
      const lastFullSync = db.prepare("SELECT valor FROM config WHERE chave = 'lastFullSync'").get();
      const lastIncrementalSync = db.prepare("SELECT valor FROM config WHERE chave = 'lastIncrementalSync'").get();
      const lastSyncDate = db.prepare("SELECT valor FROM config WHERE chave = 'lastSyncDate'").get();

      // Calcular dias desatualizados
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      let diasDesatualizados = 0;
      let lastSyncDateStr = lastSyncDate ? lastSyncDate.valor : null;

      if (lastSyncDateStr) {
        const dataSync = new Date(lastSyncDateStr + 'T00:00:00');
        diasDesatualizados = Math.floor((hoje - dataSync) / (1000 * 60 * 60 * 24));
        if (diasDesatualizados < 0) diasDesatualizados = 0;
      }

      // Licitações futuras (data de encerramento > hoje)
      const licitacoesFuturasResult = db.prepare("SELECT COUNT(*) as count FROM licitacoes WHERE dataEncerramentoProposta > datetime('now')").get();
      const licitacoesFuturas = licitacoesFuturasResult ? licitacoesFuturasResult.count : 0;

      // Cobertura futura em dias
      const maxDataFutura = db.prepare("SELECT MAX(date(dataEncerramentoProposta)) as maxData FROM licitacoes WHERE dataEncerramentoProposta > datetime('now') AND dataEncerramentoProposta < datetime('now', '+365 days')").get();

      let coberturaFuturaDias = 0;
      if (maxDataFutura && maxDataFutura.maxData) {
        const dataMax = new Date(maxDataFutura.maxData + 'T00:00:00');
        coberturaFuturaDias = Math.floor((dataMax - hoje) / (1000 * 60 * 60 * 24));
        if (coberturaFuturaDias < 0) coberturaFuturaDias = 0;
      }

      // NFSE-M06 onda 5C passo 2: estado in-memory vem do módulo
      // pncp-sync-scheduler (zerado no worker, populado no master).
      const _ss = pncpSync.getSyncStatus();
      res.json({
        running: _ss.running,
        type: _ss.type,
        progress: _ss.progress,
        total: _ss.total,
        currentDay: _ss.currentDay,
        licitacoesNoBanco: licitacoesCount,
        itensNoBanco: itensCount,
        lastFullSync: lastFullSync ? lastFullSync.valor : null,
        lastIncrementalSync: lastIncrementalSync ? lastIncrementalSync.valor : null,
        lastSyncDate: lastSyncDateStr,
        diasDesatualizados,
        coberturaFuturaDias,
        licitacoesFuturas,
        dadosAtualizados: diasDesatualizados === 0,
        syncIntervalMinutes: 30,
        nextScheduledSync: _ss.nextScheduledSync || null
      });
    } catch (error) {
      console.error('Erro ao obter status de sync:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Endpoint para iniciar sincronização completa
   */
  app.post('/api/sync/full', (req, res) => {
    if ((process.env.ROLE || 'master') !== 'master') return _rejeitaSyncNoWorker(res);
    const { diasAtras = 30, diasFrente = 7 } = req.body || {};

    if (pncpSync.isRunning()) {
      return res.json({ success: false, message: 'Sincronização já em andamento', status: pncpSync.getSyncStatus() });
    }

    pncpSync.sincronizarCompleta(diasAtras, diasFrente);
    res.json({ success: true, message: 'Sincronização completa iniciada', status: pncpSync.getSyncStatus() });
  });

  /**
   * Endpoint para iniciar sincronização incremental
   */
  app.post('/api/sync/incremental', (req, res) => {
    if ((process.env.ROLE || 'master') !== 'master') return _rejeitaSyncNoWorker(res);

    if (pncpSync.isRunning()) {
      return res.json({ success: false, message: 'Sincronização já em andamento', status: pncpSync.getSyncStatus() });
    }

    pncpSync.sincronizarIncremental();
    res.json({ success: true, message: 'Sincronização incremental iniciada', status: pncpSync.getSyncStatus() });
  });

  /**
   * Endpoint legado (mantido para compatibilidade)
   */
  app.post('/api/sync/start', (req, res) => {
    if ((process.env.ROLE || 'master') !== 'master') return _rejeitaSyncNoWorker(res);
    const { diasAtras = 30, diasFrente = 7 } = req.body || {};

    if (pncpSync.isRunning()) {
      return res.json({ success: false, message: 'Sincronização já em andamento', status: pncpSync.getSyncStatus() });
    }

    // Se já tem dados, faz incremental; senão, faz completa
    const stats = db.prepare('SELECT COUNT(*) as count FROM licitacoes').get();
    if (stats.count > 0) {
      pncpSync.sincronizarIncremental();
      res.json({ success: true, message: 'Sincronização incremental iniciada', status: pncpSync.getSyncStatus() });
    } else {
      pncpSync.sincronizarCompleta(diasAtras, diasFrente);
      res.json({ success: true, message: 'Sincronização completa iniciada', status: pncpSync.getSyncStatus() });
    }
  });

  console.log('[Sync] Rotas registradas');
}

module.exports = { registrarRotasSync };
