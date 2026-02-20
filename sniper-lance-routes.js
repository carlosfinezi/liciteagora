/**
 * sniper-lance-routes.js — Endpoints REST para o Sniper de Lances
 * 
 * Uso no server.js:
 *   const { registrarRotasSniper, inicializarSniper } = require('./sniper-lance-routes');
 *   registrarRotasSniper(app, monitorV2);
 *   // Após server.listen():
 *   inicializarSniper();
 */

const SniperLance = require('./sniper-lance');

let sniper = null;
let _monitorRef = null;

function registrarRotasSniper(app, monitorGetter, dbRef) {
  _monitorRef = monitorGetter;
  const db = dbRef;

  // Lazy init do sniper - cria quando o monitor estiver disponível
  function getSniper() {
    if (sniper) return sniper;
    const monitor = typeof _monitorRef === 'function' ? _monitorRef() : _monitorRef;
    if (monitor && monitor.page) {
      sniper = new SniperLance(monitor);
      console.log('[Sniper] Inicializado com MonitorV2');
    }
    return sniper;
  }

  // ==================== STATUS ====================

  app.get('/api/sniper/status', (req, res) => {
    try {
      const s = getSniper(); if (!s) {
        return res.json({ success: true, ativo: false, message: 'Sniper não inicializado' });
      }
      res.json({ success: true, ativo: true, ...s.getStatus() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sniper/logs', (req, res) => {
    try {
      const s = getSniper();
      res.json({ success: true, logs: s ? s.logs : [] });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== CALIBRAÇÃO ====================

  app.post('/api/sniper/calibrar', async (req, res) => {
    try {
      const s = getSniper(); if (!s) return res.status(400).json({ success: false, error: 'Sniper não inicializado' });
      const resultado = await s.calibrarTempo();
      res.json({ success: true, ...resultado });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== LANCE IMEDIATO ====================

  /**
   * POST /api/sniper/lance
   * Body: { compraId, itemNumero, valor, faseItem? }
   * 
   * Envia um lance AGORA (para testes ou uso manual)
   */
  app.post('/api/sniper/lance', async (req, res) => {
    try {
      const s = getSniper(); if (!s) return res.status(400).json({ success: false, error: 'Sniper não inicializado' });

      const { compraId, itemNumero, valor, faseItem } = req.body || {};

      if (!compraId || !itemNumero || !valor) {
        return res.status(400).json({
          success: false,
          error: 'Parâmetros obrigatórios: compraId, itemNumero, valor',
          exemplo: { compraId: '93119906000012026', itemNumero: 1, valor: 1745.00 },
        });
      }

      const resultado = await s.enviarLance(compraId, itemNumero, valor, faseItem || 'LA');
      res.json({ success: resultado.sucesso, lance: resultado });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== AGENDAMENTO SNIPER ====================

  /**
   * POST /api/sniper/agendar
   * Body: {
   *   compraId: "93119906000012026",
   *   itemNumero: 1,
   *   valor: 1700.00,
   *   horarioAlvo: "2026-02-20T17:00:00.000Z",  // UTC
   *   antecedenciaMs: 500,       // opcional, ms antes do alvo
   *   tentativas: 3,              // opcional
   *   intervaloTentativasMs: 200   // opcional
   * }
   */
  app.post('/api/sniper/agendar', (req, res) => {
    try {
      const s = getSniper(); if (!s) return res.status(400).json({ success: false, error: 'Sniper não inicializado' });

      const body = req.body || {};
      const { compraId, itemNumero, valor, horarioAlvo, antecedenciaMs, tentativas, intervaloTentativasMs, faseItem } = body;

      if (!compraId || !itemNumero || !valor || !horarioAlvo) {
        return res.status(400).json({
          success: false,
          error: 'Parâmetros obrigatórios: compraId, itemNumero, valor, horarioAlvo',
          exemplo: {
            compraId: '93119906000012026',
            itemNumero: 1,
            valor: 1700.00,
            horarioAlvo: '2026-02-20T17:00:00.000Z',
            antecedenciaMs: 500,
            tentativas: 3,
          },
        });
      }

      const id = `sniper-${compraId}-${itemNumero}-${Date.now()}`;

      const resultado = s.agendar({
        id,
        compraId,
        itemNumero,
        valor: parseFloat(valor),
        faseItem: faseItem || 'LA',
        horarioAlvo,
        antecedenciaMs: antecedenciaMs || 500,
        tentativas: tentativas || 3,
        intervaloTentativasMs: intervaloTentativasMs || 200,
      });

      res.json(resultado);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== CANCELAR ====================

  app.post('/api/sniper/cancelar/:id', (req, res) => {
    try {
      const s = getSniper(); if (!s) return res.status(400).json({ success: false, error: 'Sniper não inicializado' });
      const ok = s.cancelar(req.params.id);
      res.json({ success: ok, message: ok ? 'Cancelado' : 'Agendamento não encontrado' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sniper/cancelar-todos', (req, res) => {
    try {
      const s = getSniper(); if (!s) return res.status(400).json({ success: false, error: 'Sniper não inicializado' });
      let cancelados = 0;
      for (const [id] of s.agendamentos) {
        if (s.cancelar(id)) cancelados++;
      }
      res.json({ success: true, cancelados });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== LISTAR ====================

  app.get('/api/sniper/agendamentos', (req, res) => {
    try {
      const s = getSniper(); if (!s) return res.json({ success: true, agendamentos: [] });
      res.json({ success: true, agendamentos: s.listarAgendamentos() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sniper/historico', (req, res) => {
    try {
      const s = getSniper(); if (!s) return res.json({ success: true, historico: [] });
      res.json({ success: true, historico: s.historico });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== CONSULTA DE DISPUTA ====================

  /**
   * GET /api/sniper/participacoes
   * Lista todas as participações ativas do banco, com filtro opcional.
   * Query: ?busca=texto
   */
  app.get('/api/sniper/participacoes', (req, res) => {
    try {
      const busca = req.query.busca || '';
      let query = 'SELECT compraId, cnpj, ano, sequencial, orgao, objeto, etapa, situacao, faseCompra, dataSessao, dataAtualizacao FROM participacoes_comprasnet WHERE ativo = 1';
      const params = [];
      if (busca) {
        query += ' AND (objeto LIKE ? OR orgao LIKE ? OR compraId LIKE ?)';
        const like = `%${busca}%`;
        params.push(like, like, like);
      }
      query += ' ORDER BY dataAtualizacao DESC';
      const lista = db.prepare(query).all(...params);
      res.json({ success: true, participacoes: lista });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/consultar/:compraId
   * Consulta o estado real dos itens de uma disputa via API do Comprasnet.
   */
  app.get('/api/sniper/consultar/:compraId', async (req, res) => {
    try {
      const s = getSniper();
      if (!s) return res.status(503).json({ success: false, error: 'Sniper não inicializado (Chrome desconectado?)' });
      const result = await s.consultarItens(req.params.compraId);
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/disputas-ativas
   * Verifica TODAS as participações no banco para encontrar disputas em andamento.
   * LENTO — consulta cada participação na API do Comprasnet.
   */
  app.get('/api/sniper/disputas-ativas', async (req, res) => {
    try {
      const s = getSniper();
      if (!s) return res.status(503).json({ success: false, error: 'Sniper não inicializado' });
      const disputas = await s.buscarDisputasAtivas(db);
      res.json({ success: true, disputas });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

function inicializarSniper() {
  // Será chamado depois que o MonitorV2 estiver disponível
  // O sniper precisa do monitor para o Bearer token
}

function getOrCreateSniper(monitor) {
  if (!sniper && monitor) {
    sniper = new SniperLance(monitor);
    console.log('[Sniper] Inicializado');
  }
  return sniper;
}

module.exports = { registrarRotasSniper, inicializarSniper, getOrCreateSniper };
