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

/**
 * Últimas sincronizações — lidas de onde elas realmente são gravadas.
 *
 * BUG (achado em 2026-08-02): esta rota lia `lastFullSync`,
 * `lastIncrementalSync` e `lastSyncDate` do `config` do TENANT. Esses
 * marcadores saíram de lá na Fase 8 (2026-04-22), para
 * `catalog_sync_state` (catálogo global), e na Fase 3c (2026-05-23) para o
 * Postgres. Nenhum dos 11 tenants tinha as chaves — os três voltavam null.
 *
 * O efeito na tela não era um campo vazio discreto: com `lastFullSync` null,
 * status.html mostra o alerta vermelho "Sincronização completa nunca foi
 * executada!". Ou seja, a tela afirmava que a coleta nunca rodou enquanto o
 * incremental rodava a cada poucos minutos — o que se lê, com razão, como
 * "o catálogo parou de receber licitações".
 *
 * Fallback para o `config` do tenant continua por último, para não regredir
 * uma instalação que ainda tenha os marcadores antigos.
 */
async function _marcadoresDeSync(db) {
  const vazio = { lastFullSync: null, lastIncrementalSync: null, lastSyncDate: null };
  const CHAVES = ['lastFullSync', 'lastIncrementalSync', 'lastSyncDate'];

  if (USE_PG) {
    try {
      const rows = await catalogPg.query(
        'SELECT "key", "value" FROM catalog_sync_state WHERE "key" = ANY($1::text[])', [CHAVES]);
      const m = new Map(rows.map((r) => [r.key, r.value]));
      if (m.size) return { lastFullSync: m.get('lastFullSync') || null,
                           lastIncrementalSync: m.get('lastIncrementalSync') || null,
                           lastSyncDate: m.get('lastSyncDate') || null };
    } catch (err) {
      console.error('[sync/status] catalog_sync_state (PG):', err.message);
    }
  } else {
    // No worker o catálogo entra por ATTACH e catalog_sync_state é TEMP VIEW:
    // o SELECT resolve, o schema não lista. Testar o acesso é o que vale.
    try {
      const rows = db.prepare(
        `SELECT key, value FROM catalog_sync_state WHERE key IN ('${CHAVES.join("','")}')`).all();
      const m = new Map(rows.map((r) => [r.key, r.value]));
      if (m.size) return { lastFullSync: m.get('lastFullSync') || null,
                           lastIncrementalSync: m.get('lastIncrementalSync') || null,
                           lastSyncDate: m.get('lastSyncDate') || null };
    } catch { /* catálogo ausente: cai no legado */ }
  }

  try {
    const ler = (c) => {
      const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(c);
      return r ? r.valor : null;
    };
    return { lastFullSync: ler('lastFullSync'), lastIncrementalSync: ler('lastIncrementalSync'),
             lastSyncDate: ler('lastSyncDate') };
  } catch { return vazio; }
}

function _rejeitaSyncNoWorker(res) {
  return res.status(503).json({
    success: false,
    error: 'Sincronização manual indisponível no worker HTTP. O master executa sync incremental a cada 5min automaticamente; para forçar agora, reinicie o serviço liciteagora (master).'
  });
}

// Fase 3g (2026-05-23): stats catalog via PG
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

function registrarRotasSync(app, db, { pncpSync }) {
  if (!pncpSync) {
    throw new Error('sync-routes: pncpSync é obrigatório (import do pncp-sync-scheduler)');
  }

  /**
   * Endpoint para consultar status da sincronização
   */
  // ==================== STATUS DO NEGÓCIO ====================
  // /api/sync/status responde "o cano está cheio?" (935 mil licitações) e "o
  // sync rodou?". Não responde se a empresa está pegando alguma coisa — que é
  // o que decide o dia de quem trabalha com licitação.
  const negocio = require('./status-negocio');

  // async: desde a migração do catálogo para o Postgres, ler catálogo é I/O.
  app.get('/api/status/negocio', async (req, res) => {
    try {
      res.json({ success: true, painel: await negocio.painel(db, {
        dias: Number(req.query.dias) || 30,
        limite: Number(req.query.limite) || 10,
      }) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Separada porque varre o catálogo por grupo e leva segundos — junto do
  // resto travaria o carregamento da tela.
  app.get('/api/status/negocio/grupos', async (req, res) => {
    try {
      const r = await negocio.grupoImprodutivo(db, { dias: Number(req.query.dias) || 30 });
      res.json({ success: true, ...r });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/sync/status', async (req, res) => {
    try {
      // Estatísticas do banco
      let licitacoesCount, itensCount;
      if (USE_PG) {
        // COUNT(*) exato em `itens` (18M+ linhas) estoura o statement_timeout de 30s.
        // São números de display: usar estimativa de pg_class.reltuples (instantâneo).
        const _est = await catalogPg.queryOne(
          `SELECT
             (SELECT reltuples::bigint FROM pg_class WHERE oid = 'licitacoes'::regclass) AS lic,
             (SELECT reltuples::bigint FROM pg_class WHERE oid = 'itens'::regclass) AS itens`
        );
        licitacoesCount = Number(_est?.lic || 0);
        itensCount = Number(_est?.itens || 0);
      } else {
        licitacoesCount = db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count;
        itensCount = db.prepare('SELECT COUNT(*) as count FROM itens').get().count;
      }

      // Configurações de sync (ver _marcadoresDeSync: NÃO ficam no config do tenant)
      const marcadores = await _marcadoresDeSync(db);

      // Calcular dias desatualizados
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      let diasDesatualizados = 0;
      let lastSyncDateStr = marcadores.lastSyncDate;

      if (lastSyncDateStr) {
        const dataSync = new Date(lastSyncDateStr + 'T00:00:00');
        diasDesatualizados = Math.floor((hoje - dataSync) / (1000 * 60 * 60 * 24));
        if (diasDesatualizados < 0) diasDesatualizados = 0;
      }

      // Licitações futuras (data de encerramento > hoje)
      let licitacoesFuturas, maxDataFutura;
      if (USE_PG) {
        const fr = await catalogPg.queryOne(`SELECT COUNT(*)::int AS count FROM licitacoes WHERE "dataEncerramentoProposta" > now()`);
        licitacoesFuturas = Number(fr?.count || 0);
        maxDataFutura = await catalogPg.queryOne(`SELECT to_char(MAX("dataEncerramentoProposta")::date, 'YYYY-MM-DD') AS "maxData" FROM licitacoes WHERE "dataEncerramentoProposta" > now() AND "dataEncerramentoProposta" < now() + interval '365 days'`);
      } else {
        const licitacoesFuturasResult = db.prepare("SELECT COUNT(*) as count FROM licitacoes WHERE dataEncerramentoProposta > datetime('now')").get();
        licitacoesFuturas = licitacoesFuturasResult ? licitacoesFuturasResult.count : 0;
        maxDataFutura = db.prepare("SELECT MAX(date(dataEncerramentoProposta)) as maxData FROM licitacoes WHERE dataEncerramentoProposta > datetime('now') AND dataEncerramentoProposta < datetime('now', '+365 days')").get();
      }

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
        lastFullSync: marcadores.lastFullSync,
        lastIncrementalSync: marcadores.lastIncrementalSync,
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
  app.post('/api/sync/start', async (req, res) => {
    if ((process.env.ROLE || 'master') !== 'master') return _rejeitaSyncNoWorker(res);
    const { diasAtras = 30, diasFrente = 7 } = req.body || {};

    if (pncpSync.isRunning()) {
      return res.json({ success: false, message: 'Sincronização já em andamento', status: pncpSync.getSyncStatus() });
    }

    // Se já tem dados, faz incremental; senão, faz completa
    let count;
    if (USE_PG) count = Number((await catalogPg.queryOne('SELECT COUNT(*) AS count FROM licitacoes'))?.count || 0);
    else count = db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count;
    if (count > 0) {
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
