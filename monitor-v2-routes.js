/**
 * monitor-v2-routes.js — Endpoints REST para o MonitorV2
 * 
 * Uso no server.js:
 *   const { registrarRotasMonitorV2, inicializarMonitorV2 } = require('./monitor-v2-routes');
 *   registrarRotasMonitorV2(app, db, { enviarTelegram, getConfigValue });
 *   // Após o server.listen():
 *   inicializarMonitorV2();
 */

const MonitorV2 = require('./monitor-v2');

let monitor = null;

/**
 * Inicializa a instância do MonitorV2 (chamada uma vez).
 */
function criarMonitor(db, options) {
  monitor = new MonitorV2(db, options);
  return monitor;
}

/**
 * Tenta iniciar o monitoramento automaticamente.
 * Chamada após server.listen() com um delay para dar tempo do Chrome estar pronto.
 */
async function inicializarMonitorV2() {
  if (!monitor) {
    console.log('[MonitorV2] Não inicializado — chame criarMonitor() primeiro');
    return;
  }

  const autoIniciar = true; // pode ler de config se quiser
  if (!autoIniciar) {
    console.log('[MonitorV2] Auto-iniciar desabilitado');
    return;
  }

  console.log('[MonitorV2] Tentando iniciar monitoramento automaticamente em 5s...');
  await new Promise(r => setTimeout(r, 5000));

  try {
    const result = await monitor.iniciar();
    console.log(`[MonitorV2] ${result.message}`);
  } catch (e) {
    console.log(`[MonitorV2] Auto-início falhou: ${e.message}`);
    console.log('[MonitorV2] Use POST /api/monitor-v2/iniciar quando o Chrome estiver pronto');
  }
}

/**
 * Registra todas as rotas do MonitorV2 no Express app.
 */
function registrarRotasMonitorV2(app, db, options = {}) {
  // Criar instância
  criarMonitor(db, options);

  // ==================== STATUS ====================

  /**
   * GET /api/monitor-v2/status
   * Retorna status completo do monitoramento.
   */
  app.get('/api/monitor-v2/status', (req, res) => {
    try {
      const status = monitor.getStatus();
      const participacoes = db.prepare(
        'SELECT COUNT(*) as total FROM participacoes_comprasnet WHERE ativo = 1'
      ).get();
      const mensagensNaoLidas = db.prepare(
        'SELECT COUNT(*) as total FROM chat_mensagens WHERE lido = 0 OR lido IS NULL'
      ).get();

      res.json({
        success: true,
        monitor: {
          ...status,
          ativo: monitor.ativo,
        },
        participacoesAtivas: participacoes.total,
        mensagensNaoLidas: mensagensNaoLidas.total,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/monitor-v2/logs
   * Retorna logs recentes do monitor.
   */
  app.get('/api/monitor-v2/logs', (req, res) => {
    const n = parseInt(req.query.n) || 50;
    res.json({ success: true, logs: monitor.getLogs(n) });
  });

  // ==================== CONTROLE ====================

  /**
   * POST /api/monitor-v2/iniciar
   * Inicia o monitoramento.
   */
  app.post('/api/monitor-v2/iniciar', async (req, res) => {
    try {
      const intervalo = req.body.intervaloMinutos || 3;
      monitor.intervaloMinutos = intervalo;
      const result = await monitor.iniciar();
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/monitor-v2/parar
   * Para o monitoramento.
   */
  app.post('/api/monitor-v2/parar', (req, res) => {
    const result = monitor.parar();
    res.json(result);
  });

  /**
   * POST /api/monitor-v2/ciclo
   * Executa um ciclo manualmente (debug/teste).
   */
  app.post('/api/monitor-v2/ciclo', async (req, res) => {
    try {
      if (!monitor.status.chromeConectado) {
        await monitor.conectarChrome();
      }
      await monitor._executarCiclo();
      res.json({ success: true, status: monitor.getStatus() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== PARTICIPAÇÕES ====================

  /**
   * POST /api/monitor-v2/sync-participacoes
   * Força sincronização de participações.
   */
  app.post('/api/monitor-v2/sync-participacoes', async (req, res) => {
    try {
      if (!monitor.status.chromeConectado) {
        await monitor.conectarChrome();
      }
      const dados = await monitor.syncParticipacoes();
      res.json({
        success: true,
        total: dados.length,
        participacoes: dados.map(d => ({
          compraId: monitor._montarCompraId(d.compra),
          uasg: d.compra.numeroUasg,
          numero: d.compra.numero,
          ano: d.compra.ano,
          orgao: d.compra.nomeUasg,
          objeto: d.compra.objetoCompra?.substring(0, 100),
          situacao: d.compra.situacaoCompraFaseExterna,
          fase: d.compra.faseCompraFaseExterna,
        })),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/monitor-v2/participacoes
   * Lista participações do banco local.
   */
  app.get('/api/monitor-v2/participacoes', (req, res) => {
    try {
      const lista = db.prepare(
        'SELECT * FROM participacoes_comprasnet WHERE ativo = 1 ORDER BY dataAtualizacao DESC'
      ).all();
      res.json({ success: true, participacoes: lista });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== MENSAGENS ====================

  /**
   * POST /api/monitor-v2/capturar-mensagens
   * Força captura de mensagens de uma licitação específica.
   */
  app.post('/api/monitor-v2/capturar-mensagens', async (req, res) => {
    try {
      const { compraId, completa } = req.body;
      if (!compraId) {
        return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      }

      if (!monitor.status.chromeConectado) {
        await monitor.conectarChrome();
      }

      // Buscar info da participação
      const p = db.prepare('SELECT * FROM participacoes_comprasnet WHERE compraId = ?').get(compraId);
      const infoCompra = p ? {
        cnpjOrgao: p.cnpj,
        ano: p.ano,
        sequencial: p.sequencial,
        orgao: p.orgao,
        objeto: p.objeto,
      } : { cnpjOrgao: '', ano: 0, sequencial: 0, orgao: '', objeto: '' };

      const novas = await monitor.capturarMensagens(compraId, infoCompra, !!completa);

      res.json({ success: true, mensagensNovas: novas });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/monitor-v2/mensagens/:compraId
   * Lista mensagens de uma licitação.
   */
  app.get('/api/monitor-v2/mensagens/:compraId', (req, res) => {
    try {
      const { compraId } = req.params;
      const pagina = parseInt(req.query.pagina) || 0;
      const tamanho = Math.min(parseInt(req.query.tamanho) || 50, 200);
      const categoria = req.query.categoria || null;

      let query = 'SELECT * FROM chat_mensagens WHERE compraId = ?';
      const params = [compraId];

      if (categoria) {
        query += ' AND categoria = ?';
        params.push(categoria);
      }

      query += ' ORDER BY dataHoraMensagem DESC LIMIT ? OFFSET ?';
      params.push(tamanho, pagina * tamanho);

      const mensagens = db.prepare(query).all(...params);
      const total = db.prepare(
        'SELECT COUNT(*) as total FROM chat_mensagens WHERE compraId = ?'
      ).get(compraId);

      res.json({
        success: true,
        mensagens,
        total: total.total,
        pagina,
        tamanho,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/monitor-v2/mensagens-nao-lidas
   * Contagem e lista de mensagens não lidas, agrupadas por licitação.
   */
  app.get('/api/monitor-v2/mensagens-nao-lidas', (req, res) => {
    try {
      const resumo = db.prepare(`
        SELECT 
          compraId, 
          COUNT(*) as total,
          MAX(dataHoraMensagem) as ultimaMensagem,
          GROUP_CONCAT(DISTINCT categoria) as categorias
        FROM chat_mensagens 
        WHERE (lido = 0 OR lido IS NULL) AND compraId IS NOT NULL
        GROUP BY compraId
        ORDER BY ultimaMensagem DESC
      `).all();

      const totalGeral = db.prepare(
        'SELECT COUNT(*) as total FROM chat_mensagens WHERE lido = 0 OR lido IS NULL'
      ).get();

      res.json({
        success: true,
        total: totalGeral.total,
        porLicitacao: resumo,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== hCAPTCHA (debug) ====================

  /**
   * POST /api/monitor-v2/testar-captcha
   * Testa geração de token hCaptcha (debug).
   */
  app.post('/api/monitor-v2/testar-captcha', async (req, res) => {
    try {
      if (!monitor.status.chromeConectado) {
        await monitor.conectarChrome();
      }
      const token = await monitor.gerarTokenCaptcha();
      res.json({
        success: true,
        token: token.substring(0, 30) + '...',
        tamanho: token.length,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/monitor-v2/conectar
   * Conecta ao Chrome manualmente.
   */
  app.post('/api/monitor-v2/conectar', async (req, res) => {
    try {
      const ok = await monitor.conectarChrome();
      res.json({ success: ok, status: monitor.getStatus() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

module.exports = {
  registrarRotasMonitorV2,
  inicializarMonitorV2,
};
