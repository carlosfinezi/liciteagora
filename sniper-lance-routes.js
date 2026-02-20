/**
 * sniper-lance-routes.js — Endpoints REST para o Sniper de Lances
 * 
 * O sniper agora funciona de forma autônoma:
 * - Recebe Bearer token via POST /api/auth/token (da extensão Chrome)
 * - Faz chamadas HTTP diretas ao Comprasnet (sem Puppeteer)
 * 
 * Uso no server.js:
 *   const { registrarRotasSniper } = require('./sniper-lance-routes');
 *   registrarRotasSniper(app, db);
 */

const SniperLance = require('./sniper-lance');

// Singleton — sempre inicializado
const sniper = new SniperLance();
console.log('[Sniper] Inicializado (aguardando Bearer token da extensão)');

function registrarRotasSniper(app, monitorGetter, db) {

  // ==================== AUTH / TOKEN ====================

  /**
   * POST /api/auth/token
   * Recebe Bearer token da extensão Chrome (Token Relay).
   * Também aceita envio manual.
   */
  app.post('/api/auth/token', (req, res) => {
    try {
      const { token, captchaToken, source } = req.body;
      if (!token) {
        return res.status(400).json({ success: false, error: 'Token obrigatório' });
      }
      sniper.setToken(token, source || 'api');

      // Captcha token (hCaptcha) — para APIs de mensagem/fase-externa
      if (captchaToken) {
        sniper.setCaptchaToken(captchaToken);
      }

      // Backward compat: MonitorV2
      try {
        const monitor = typeof monitorGetter === 'function' ? monitorGetter() : monitorGetter;
        if (monitor && typeof monitor.setBearerToken === 'function') {
          monitor.setBearerToken(token);
        }
      } catch (e) {}

      res.json({
        success: true,
        message: 'Token recebido' + (captchaToken ? ' + captcha' : ''),
        tokenAge: sniper.idadeTokenSegundos(),
        temCaptcha: sniper.temCaptcha(),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== STATUS ====================

  app.get('/api/sniper/status', (req, res) => {
    try {
      res.json({ success: true, ...sniper.getStatus() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sniper/logs', (req, res) => {
    try {
      res.json({ success: true, logs: sniper.logs });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== CALIBRAÇÃO ====================

  app.post('/api/sniper/calibrar', async (req, res) => {
    try {
      const resultado = await sniper.calibrarTempo();
      res.json({ success: true, ...resultado });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== LANCE ====================

  app.post('/api/sniper/lance', async (req, res) => {
    try {
      const { compraId, itemNumero, valor, faseItem } = req.body;
      if (!compraId || !itemNumero || valor == null) {
        return res.status(400).json({ success: false, error: 'compraId, itemNumero e valor obrigatórios' });
      }

      const lance = await sniper.enviarLance(compraId, itemNumero, valor, faseItem || 'LA');

      if (lance.sucesso) {
        res.json({ success: true, lance });
      } else {
        res.json({ success: false, lance, error: `HTTP ${lance.status}` });
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== AGENDAMENTO ====================

  app.post('/api/sniper/agendar', (req, res) => {
    try {
      const { compraId, itemNumero, valor, faseItem, horarioAlvo, antecedenciaMs, tentativas, intervaloTentativasMs } = req.body;
      if (!compraId || !itemNumero || !valor || !horarioAlvo) {
        return res.status(400).json({ success: false, error: 'compraId, itemNumero, valor e horarioAlvo obrigatórios' });
      }

      if (!sniper.temToken()) {
        return res.status(400).json({
          success: false,
          error: 'Sem Bearer token! Abra o Comprasnet com a extensão Token Relay ativa.',
        });
      }

      const id = `sniper-${compraId}-${itemNumero}-${Date.now()}`;
      const resultado = sniper.agendar({
        id,
        compraId,
        itemNumero,
        valor,
        faseItem: faseItem || 'LA',
        horarioAlvo,
        antecedenciaMs: antecedenciaMs || 300,
        tentativas: tentativas || 5,
        intervaloTentativasMs: intervaloTentativasMs || 50,
      });

      res.json(resultado);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sniper/cancelar/:id', (req, res) => {
    try {
      const ok = sniper.cancelar(req.params.id);
      res.json({ success: true, cancelado: ok });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sniper/cancelar-todos', (req, res) => {
    try {
      let cancelados = 0;
      for (const [id, ag] of sniper.agendamentos) {
        if (!ag.executado) {
          sniper.cancelar(id);
          cancelados++;
        }
      }
      res.json({ success: true, cancelados });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sniper/agendamentos', (req, res) => {
    try {
      res.json({ success: true, agendamentos: sniper.listarAgendamentos() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sniper/historico', (req, res) => {
    try {
      res.json({ success: true, historico: sniper.historico });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== CONSULTA DE DISPUTA ====================

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

  app.get('/api/sniper/consultar/:compraId', async (req, res) => {
    try {
      const result = await sniper.consultarItens(req.params.compraId);
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sniper/disputas-ativas', async (req, res) => {
    try {
      const disputas = await sniper.buscarDisputasAtivas(db);
      res.json({ success: true, disputas });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== SYNC & MENSAGENS ====================

  /**
   * POST /api/sync/participacoes
   * Recebe participações em bulk da extensão Chrome.
   * A extensão busca direto da API Comprasnet (mesmo IP = captcha válido).
   */
  app.post('/api/sync/participacoes', (req, res) => {
    try {
      const { participacoes } = req.body;
      if (!Array.isArray(participacoes)) {
        return res.status(400).json({ success: false, error: 'participacoes deve ser array' });
      }

      let inseridas = 0, atualizadas = 0;

      for (const item of participacoes) {
        const compra = item.compra || item;
        const compraId = compra.compraId;
        if (!compraId) continue;

        const existe = db.prepare('SELECT id FROM participacoes_comprasnet WHERE compraId = ?').get(compraId);

        if (existe) {
          db.prepare(`UPDATE participacoes_comprasnet SET
            situacao = COALESCE(?, situacao),
            faseCompra = COALESCE(?, faseCompra),
            objeto = COALESCE(?, objeto),
            orgao = COALESCE(?, orgao),
            dataAtualizacao = CURRENT_TIMESTAMP
            WHERE compraId = ?`).run(
            compra.situacaoCompraFaseExterna || compra.situacao || null,
            compra.faseCompraFaseExterna || compra.faseCompra || null,
            compra.objetoCompra || compra.objeto || null,
            compra.nomeOrgao || compra.nomeUasg || compra.orgao || null,
            compraId,
          );
          atualizadas++;
        } else {
          db.prepare(`INSERT INTO participacoes_comprasnet
            (compraId, cnpj, ano, sequencial, orgao, objeto, situacao, faseCompra, ativo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
            compraId,
            compra.numeroUasg || compra.cnpj || '',
            compra.ano || 0,
            compra.numero || compra.sequencial || 0,
            compra.nomeOrgao || compra.nomeUasg || compra.orgao || '',
            compra.objetoCompra || compra.objeto || '',
            compra.situacaoCompraFaseExterna || compra.situacao || '',
            compra.faseCompraFaseExterna || compra.faseCompra || '',
          );
          inseridas++;
        }
      }

      console.log(`[Sync] Participações: ${inseridas} novas, ${atualizadas} atualizadas (de ${participacoes.length} recebidas)`);
      res.json({ success: true, inseridas, atualizadas, total: participacoes.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sync/mensagens
   * Recebe mensagens de uma licitação em bulk da extensão Chrome.
   */
  app.post('/api/sync/mensagens', (req, res) => {
    try {
      const { compraId, mensagens } = req.body;
      if (!compraId || !Array.isArray(mensagens)) {
        return res.status(400).json({ success: false, error: 'compraId e mensagens[] obrigatórios' });
      }

      let novas = 0;

      for (const msg of mensagens) {
        const id = msg.id || msg.identificador;
        if (!id) continue;

        const existe = db.prepare('SELECT id FROM chat_mensagens WHERE mensagemId = ?').get(String(id));
        if (existe) continue;

        try {
          db.prepare(`INSERT INTO chat_mensagens
            (compraId, mensagemId, cnpjOrgao, ano, sequencial, dataHoraMensagem,
             remetente, conteudo, tipo, notificado)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
            compraId,
            String(id),
            msg.cnpjOrgao || '',
            msg.ano || 0,
            msg.sequencial || 0,
            msg.dataHora || msg.dataHoraMensagem || new Date().toISOString(),
            msg.remetente || msg.nomeRemetente || '',
            msg.mensagem || msg.conteudo || '',
            msg.tipo || 'MSG',
          );
          novas++;
        } catch (e) {
          // Duplicate — skip
        }
      }

      if (novas > 0) {
        console.log(`[Sync] Mensagens ${compraId}: ${novas} novas (de ${mensagens.length})`);
      }
      res.json({ success: true, novas, total: mensagens.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/sync-participacoes — legacy (server-side, requer captcha IP)
   */
  app.post('/api/sniper/sync-participacoes', async (req, res) => {
    try {
      const result = await sniper.syncParticipacoes(db);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sniper/capturar-mensagens', async (req, res) => {
    try {
      const { compraId } = req.body;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      const novas = await sniper.capturarMensagens(compraId, db);
      res.json({ success: true, novasMensagens: novas });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sniper/capturar-todas-mensagens', async (req, res) => {
    try {
      const total = await sniper.capturarTodasMensagens(db);
      res.json({ success: true, novasMensagens: total });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

function getSniper() {
  return sniper;
}

module.exports = { registrarRotasSniper, getSniper };
