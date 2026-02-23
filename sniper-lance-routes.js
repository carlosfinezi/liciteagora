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

  // Tracking da extensão
  let ultimoSyncExtensao = null; // timestamp do último POST da extensão

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
      if (source === 'extension') ultimoSyncExtensao = Date.now();

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

  // ==================== FILA DE LANCES (via extensão/browser) ====================

  let filaLances = [];  // { id, compraId, itemNumero, valor, faseItem, criadoEm, status }
  let resultadosLances = []; // últimos 50 resultados

  /**
   * POST /api/sniper/lance
   * Adiciona lance à fila (extensão processa via browser).
   * Também tenta enviar direto (fallback se servidor tiver acesso).
   */
  app.post('/api/sniper/lance', async (req, res) => {
    try {
      const { compraId, itemNumero, valor, faseItem } = req.body;
      if (!compraId || !itemNumero || valor == null) {
        return res.status(400).json({ success: false, error: 'compraId, itemNumero e valor obrigatórios' });
      }

      const id = Date.now() + '-' + Math.random().toString(36).substring(2, 6);
      const lance = {
        id,
        compraId,
        itemNumero: parseInt(itemNumero),
        valor: parseFloat(valor),
        faseItem: faseItem || 'LA',
        criadoEm: new Date().toISOString(),
        status: 'pendente',
      };

      filaLances.push(lance);
      console.log(`[Sniper] 🎯 Lance adicionado à fila: ${compraId} item ${itemNumero} R$${valor} (id: ${id})`);
      sniper.log(`🎯 Lance na fila: ${compraId} item ${itemNumero} R$${parseFloat(valor).toFixed(2)}`);

      res.json({ success: true, id, message: 'Lance adicionado à fila. Extensão processará via browser.', fila: filaLances.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/fila-lances
   * Retorna lances pendentes (para extensão processar).
   */
  app.get('/api/sniper/fila-lances', (req, res) => {
    const pendentes = filaLances.filter(l => l.status === 'pendente');
    // Marcar como "processando"
    pendentes.forEach(l => l.status = 'processando');
    res.json({ success: true, lances: pendentes, total: filaLances.length });
  });

  /**
   * POST /api/sniper/resultado-lance
   * Recebe resultado do lance enviado pela extensão.
   */
  app.post('/api/sniper/resultado-lance', (req, res) => {
    try {
      const { id, compraId, itemNumero, valor, status, sucesso, resposta, tempoMs } = req.body;

      // Atualizar na fila
      const idx = filaLances.findIndex(l => l.id === id);
      if (idx >= 0) {
        filaLances[idx].status = sucesso ? 'sucesso' : 'falha';
        filaLances[idx].httpStatus = status;
        filaLances[idx].resposta = resposta;
        filaLances[idx].tempoMs = tempoMs;
        filaLances[idx].processadoEm = new Date().toISOString();
      }

      // Adicionar ao histórico
      const resultado = {
        id, compraId, itemNumero, valor, status, sucesso, resposta, tempoMs,
        timestamp: new Date().toISOString(),
        fonte: 'extensao-browser',
      };
      resultadosLances.unshift(resultado);
      if (resultadosLances.length > 50) resultadosLances.pop();

      // Log no sniper
      if (sucesso) {
        sniper.log(`🎯✅ LANCE ENVIADO (browser)! R$ ${parseFloat(valor).toFixed(2)} item ${itemNumero} (${tempoMs}ms)`);
      } else {
        sniper.log(`🎯❌ Lance falhou (browser): HTTP ${status} item ${itemNumero} (${tempoMs}ms) — ${(resposta||'').substring(0, 100)}`);
      }

      // Também salvar no histórico do sniper
      sniper.historico.unshift({ compraId, itemNumero, valor, status, sucesso, tempoMs, timestamp: new Date().toISOString(), fonte: 'browser' });
      if (sniper.historico.length > 50) sniper.historico.pop();

      console.log(`[Sniper] Lance resultado: ${sucesso ? '✅' : '❌'} ${compraId} item ${itemNumero} R$${valor} HTTP ${status} (${tempoMs}ms)`);

      // Persistir no banco
      try {
        db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, itemNumero, valor, status, sucesso ? 1 : 0, tempoMs, (resposta||'').substring(0, 500), 'browser');
        // Atualizar status do item no sniper_itens
        db.prepare(`UPDATE sniper_itens SET status = ?, ultimoResultado = ?, ultimoEnvio = CURRENT_TIMESTAMP, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE compraId = ? AND itemNumero = ?`).run(sucesso ? 'enviado' : 'erro', `HTTP ${status} (${tempoMs}ms)`, compraId, itemNumero);
      } catch (dbErr) { console.error('[Sniper] Erro salvando no banco:', dbErr.message); }

      // Limpar da fila após 30s
      setTimeout(() => {
        const i = filaLances.findIndex(l => l.id === id);
        if (i >= 0) filaLances.splice(i, 1);
      }, 30000);

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/fila-status
   * Status completo da fila de lances.
   */
  app.get('/api/sniper/fila-status', (req, res) => {
    const sniperStatus = sniper.getStatus();
    const extensaoConectada = !!(ultimoSyncExtensao && (Date.now() - ultimoSyncExtensao) < 5 * 60 * 1000);
    res.json({
      success: true,
      fila: filaLances,
      resultados: resultadosLances.slice(0, 20),
      totalResultados: resultadosLances.length,
      extensaoConectada,
      temBearer: sniperStatus.temToken,
      bearerIdade: sniperStatus.tokenIdadeSegundos,
      tokenExpirado: sniperStatus.tokenExpirado,
      disputasCache: {
        total: disputasCache.disputas.length,
        atualizadoEm: disputasCache.atualizadoEm,
        idadeSegundos: disputasCache.atualizadoEm ? Math.floor((Date.now() - new Date(disputasCache.atualizadoEm).getTime()) / 1000) : null,
      },
      stats: {
        pendentes: filaLances.filter(l => l.status === 'pendente').length,
        processando: filaLances.filter(l => l.status === 'processando').length,
        sucesso: filaLances.filter(l => l.status === 'sucesso').length,
        falha: filaLances.filter(l => l.status === 'falha').length,
      },
    });
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
      const emDisputa = req.query.emDisputa === 'true';
      let query = 'SELECT compraId, cnpj, ano, sequencial, orgao, objeto, etapa, situacao, faseCompra, dataSessao, dataAtualizacao FROM participacoes_comprasnet WHERE ativo = 1';
      const params = [];

      if (emDisputa) {
        // Filtrar apenas participações em fase ativa (não encerradas/fracassadas)
        query += " AND situacao NOT IN ('FR', 'EN') AND (faseCompra IS NULL OR faseCompra NOT IN ('4', 'encerrada', 'ENCERRADA'))";
      }

      if (busca) {
        query += ' AND (objeto LIKE ? OR orgao LIKE ? OR compraId LIKE ?)';
        const like = `%${busca}%`;
        params.push(like, like, like);
      }
      query += ' ORDER BY dataAtualizacao DESC';
      const lista = db.prepare(query).all(...params);
      res.json({ success: true, participacoes: lista, total: lista.length });
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

  // ==================== DISPUTAS (dados da extensão) ====================

  // Cache em memória das disputas recebidas da extensão
  let disputasCache = { disputas: [], atualizadoEm: null };

  /**
   * POST /api/sync/disputas
   * Recebe dados de disputas da extensão Chrome (consulta feita pelo browser).
   */
  app.post('/api/sync/disputas', (req, res) => {
    try {
      const { disputas, merge } = req.body;
      if (!Array.isArray(disputas)) {
        return res.status(400).json({ success: false, error: 'disputas deve ser array' });
      }

      ultimoSyncExtensao = Date.now();

      if (merge) {
        // Merge: add/update individual items without replacing full cache
        for (const d of disputas) {
          const idx = disputasCache.disputas.findIndex(c => c.compraId === d.compraId);
          if (idx >= 0) {
            disputasCache.disputas[idx] = d;
          } else {
            disputasCache.disputas.push(d);
          }
        }
        disputasCache.atualizadoEm = new Date().toISOString();
      } else {
        // Full replace (from regular sync)
        disputasCache = {
          disputas: disputas,
          atualizadoEm: new Date().toISOString(),
        };
      }
      const ativas = disputasCache.disputas.filter(d => d.itensAtivos > 0);
      console.log(`[Sync] Disputas: ${disputas.length} ${merge ? 'merged' : 'replaced'}, ${ativas.length} com itens ativos (total: ${disputasCache.disputas.length})`);
      res.json({ success: true, recebidas: disputas.length, ativas: ativas.length, total: disputasCache.disputas.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/disputas-ativas
   * Retorna disputas do cache (preenchido pela extensão).
   * Não faz mais chamadas API do servidor (captcha IP-bound ao browser).
   */
  app.get('/api/sniper/disputas-ativas', async (req, res) => {
    try {
      // Se tem cache recente (< 5 min), retorna direto
      if (disputasCache.atualizadoEm) {
        const idadeMs = Date.now() - new Date(disputasCache.atualizadoEm).getTime();
        const idadeMin = Math.round(idadeMs / 60000);
        res.json({
          success: true,
          disputas: disputasCache.disputas,
          atualizadoEm: disputasCache.atualizadoEm,
          idadeMinutos: idadeMin,
          fonte: 'extensao',
        });
      } else {
        // Sem cache — orienta o usuário
        res.json({
          success: true,
          disputas: [],
          atualizadoEm: null,
          fonte: 'sem-dados',
          mensagem: 'Aguardando sync da extensão. Verifique se o Chrome está aberto com Comprasnet logado.',
        });
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/diagnostico?compraId=XXXX
   * Testa TODOS os endpoints possíveis e mostra o resultado bruto.
   * Para debug quando itens não são encontrados.
   */
  app.get('/api/sniper/diagnostico', async (req, res) => {
    try {
      const { compraId } = req.query;
      if (!compraId) return res.status(400).json({ error: 'compraId obrigatório' });

      const status = sniper.getStatus();
      const resultados = [];

      const endpoints = [
        { path: `/comprasnet-disputa/v1/compras/${compraId}/itens`, tipo: 'disputa-itens', needsCaptcha: false },
        { path: `/comprasnet-disputa/v1/compras/${compraId}/itens/classificacao`, tipo: 'disputa-classificacao', needsCaptcha: false },
        { path: `/comprasnet-fase-externa/v1/compras/${compraId}/itens`, tipo: 'fase-externa-itens', needsCaptcha: false },
        { path: `/comprasnet-fase-externa/v1/compras/${compraId}/itens/em-selecao-fornecedores`, tipo: 'fase-externa-selecao', needsCaptcha: false },
      ];

      // Com captcha
      if (status.temCaptcha) {
        endpoints.push(
          { path: `/comprasnet-fase-externa/v1/compras/${compraId}/itens/em-selecao-fornecedores`, tipo: 'fase-externa-selecao+captcha', needsCaptcha: true },
          { path: `/comprasnet-fase-externa/v1/compras/${compraId}/itens`, tipo: 'fase-externa-itens+captcha', needsCaptcha: true },
        );
      }

      for (const ep of endpoints) {
        try {
          const result = ep.needsCaptcha
            ? await sniper.apiGetCaptcha(ep.path)
            : await sniper.apiGet(ep.path);

          const data = result.data;
          const isArray = Array.isArray(data);
          const itens = isArray ? data : (data ? [data] : []);

          resultados.push({
            tipo: ep.tipo,
            status: result.status,
            isArray,
            totalItens: itens.length,
            primeiroItem: itens[0] ? {
              numero: itens[0].numero,
              identificador: itens[0].identificador,
              fase: itens[0].fase || itens[0].faseItem,
              situacao: itens[0].situacao,
              podeEnviarLances: itens[0].podeEnviarLances,
              descricao: (itens[0].descricao || itens[0].objetoItem || '').substring(0, 80),
              melhorValorGeral: itens[0].melhorValorGeral,
              dataHoraFimContagem: itens[0].dataHoraFimContagem,
              // Dump all keys
              _keys: Object.keys(itens[0]),
            } : null,
            rawPreview: JSON.stringify(data).substring(0, 500),
          });
        } catch (e) {
          resultados.push({
            tipo: ep.tipo,
            error: e.message,
          });
        }
      }

      // Também checar no cache
      const cached = disputasCache.disputas.find(d => d.compraId === compraId);

      res.json({
        compraId,
        tokenStatus: { temToken: status.temToken, temCaptcha: status.temCaptcha, tokenIdade: status.tokenIdade },
        cacheDisputa: cached || null,
        totalCacheDisputas: disputasCache.disputas.length,
        cacheAtualizadoEm: disputasCache.atualizadoEm,
        resultados,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  let pendingItemQueries = []; // { compraId, requestedAt, status }

  /**
   * GET /api/sniper/consultar-itens?compraId=XXXX
   * Retorna do cache, ou enfileira para extensão consultar.
   */
  app.get('/api/sniper/consultar-itens', async (req, res) => {
    try {
      const { compraId } = req.query;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });

      // 1. Verificar cache de disputas
      const cached = disputasCache.disputas.find(d => d.compraId === compraId);
      if (cached && cached.itens?.length > 0) {
        const idadeMs = Date.now() - new Date(disputasCache.atualizadoEm).getTime();
        return res.json({
          success: true,
          fonte: 'cache-extensao',
          idadeSegundos: Math.round(idadeMs / 1000),
          compraId,
          ...cached,
        });
      }

      // 2. Enfileirar para extensão consultar (se não já na fila)
      const jaEnfileirado = pendingItemQueries.some(q => q.compraId === compraId && q.status === 'pendente');
      if (!jaEnfileirado) {
        pendingItemQueries.push({ compraId, requestedAt: new Date().toISOString(), status: 'pendente' });
        console.log(`[Sniper] 🔍 Query enfileirada para extensão: ${compraId}`);
      }

      // 3. Responder que está na fila
      res.json({
        success: false,
        fonte: 'aguardando-extensao',
        compraId,
        error: 'Itens enfileirados para consulta via extensão (~5s). Tente novamente em instantes.',
        cacheDisputas: {
          totalNoCache: disputasCache.disputas.length,
          atualizadoEm: disputasCache.atualizadoEm,
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/fila-queries
   * Retorna queries pendentes (extensão consulta).
   */
  app.get('/api/sniper/fila-queries', (req, res) => {
    const pendentes = pendingItemQueries.filter(q => q.status === 'pendente');
    pendentes.forEach(q => q.status = 'processando');
    res.json({ success: true, queries: pendentes });
    // Limpar processadas/velhas
    pendingItemQueries = pendingItemQueries.filter(q =>
      q.status === 'pendente' || q.status === 'processando'
    );
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

      ultimoSyncExtensao = Date.now();
      let inseridas = 0, atualizadas = 0;

      for (const item of participacoes) {
        const compra = item.compra || item;

        // Construir compraId: {uasg:06}{modalidade:02}{numero:05}{ano:04}
        const uasg = String(compra.numeroUasg || '').padStart(6, '0');
        const mod = String(compra.modalidade || '').padStart(2, '0');
        const num = String(compra.numero || '').padStart(5, '0');
        const ano = String(compra.ano || '');
        const compraId = compra.compraId || (uasg + mod + num + ano);
        if (!compraId || compraId.length < 10) continue;

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
   * POST /api/sync/participacoes-encerradas
   * Recebe IDs de compras que sumiram do filtro=5 por 2 ciclos consecutivos.
   * Marca como encerradas no banco e remove do cache de disputas.
   */
  app.post('/api/sync/participacoes-encerradas', (req, res) => {
    try {
      const { compraIds } = req.body;
      if (!Array.isArray(compraIds) || compraIds.length === 0) {
        return res.status(400).json({ success: false, error: 'compraIds deve ser array não-vazio' });
      }

      ultimoSyncExtensao = Date.now();
      let atualizadas = 0;

      for (const compraId of compraIds) {
        const result = db.prepare(
          `UPDATE participacoes_comprasnet SET situacao = 'EN', faseCompra = 'encerrada', dataAtualizacao = CURRENT_TIMESTAMP
           WHERE compraId = ? AND situacao != 'EN'`
        ).run(compraId);
        if (result.changes > 0) atualizadas++;

        // Remover do cache de disputas em memória
        const idx = disputasCache.disputas.findIndex(d => d.compraId === compraId);
        if (idx >= 0) disputasCache.disputas.splice(idx, 1);
      }

      console.log(`[Sync] Encerradas: ${atualizadas} de ${compraIds.length} marcadas como EN`);
      res.json({ success: true, atualizadas, total: compraIds.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sync/mensagens
   * Recebe mensagens de uma licitação em bulk da extensão Chrome.
   */
  app.post('/api/sync/mensagens', async (req, res) => {
    try {
      const { compraId, mensagens } = req.body;
      if (!compraId || !Array.isArray(mensagens)) {
        return res.status(400).json({ success: false, error: 'compraId e mensagens[] obrigatórios' });
      }

      // Obter CNPJ do fornecedor para detectar mensagens direcionadas
      let meuCnpj = '';
      try {
        const fornConfig = db.prepare('SELECT cnpj FROM fornecedor WHERE id = 1').get();
        meuCnpj = (fornConfig?.cnpj || '').replace(/\D/g, '');
        if (!meuCnpj) {
          const configVal = db.prepare("SELECT valor FROM config WHERE chave = 'fornecedor_cnpj'").get();
          meuCnpj = (configVal?.valor || '').replace(/\D/g, '');
        }
      } catch (e) {}

      let novas = 0;
      const alertas = []; // mensagens direcionadas a mim

      for (const msg of mensagens) {
        const conteudo = msg.mensagem || msg.conteudo || msg.texto || '';
        const remetente = msg.remetente || msg.nomeRemetente || msg.identificadorRemetente || '';
        const dataHora = msg.dataHora || msg.dataHoraMensagem || msg.dataEnvio || new Date().toISOString();
        const destinatario = msg.identificadorDestinatario || '';

        // Gerar hash para deduplicação
        const hashMensagem = require('crypto').createHash('md5')
          .update(compraId + '|' + dataHora + '|' + remetente + '|' + conteudo)
          .digest('hex');

        const existe = db.prepare('SELECT id FROM chat_mensagens WHERE hashMensagem = ?').get(hashMensagem);
        if (existe) continue;

        try {
          db.prepare(`INSERT INTO chat_mensagens
            (compraId, cnpjOrgao, ano, sequencial, dataHoraMensagem,
             remetente, mensagem, hashMensagem, tipoRemetente,
             identificadorRemetente, identificadorDestinatario, notificado)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
            compraId,
            msg.cnpjOrgao || '',
            msg.ano || 0,
            msg.sequencial || 0,
            dataHora,
            remetente,
            conteudo,
            hashMensagem,
            msg.tipoRemetente || '',
            msg.identificadorRemetente || '',
            destinatario,
          );
          novas++;

          // Detectar mensagem direcionada a mim
          if (meuCnpj && destinatario === meuCnpj) {
            alertas.push({ conteudo, dataHora, compraId });
          }
        } catch (e) {
          // Duplicate hash — skip
        }
      }

      if (novas > 0) {
        console.log(`[Sync] Mensagens ${compraId}: ${novas} novas (de ${mensagens.length})`);
      }

      // Enviar alertas Telegram para mensagens direcionadas
      if (alertas.length > 0) {
        try {
          const telegramConfig = db.prepare('SELECT botToken, chatId FROM telegram_config WHERE id = 1 AND ativo = 1').get();
          if (telegramConfig?.botToken && telegramConfig?.chatId) {
            // Buscar info da participação
            const participacao = db.prepare('SELECT orgao, objeto FROM participacoes_comprasnet WHERE compraId = ?').get(compraId);
            const orgao = participacao?.orgao || compraId;
            const objeto = participacao?.objeto || '';

            for (const alerta of alertas) {
              const texto = `🚨 <b>MENSAGEM DIRECIONADA A VOCÊ!</b>\n\n` +
                `📋 <b>Compra:</b> ${compraId}\n` +
                `🏢 <b>Órgão:</b> ${orgao}\n` +
                (objeto ? `📝 <b>Objeto:</b> ${objeto.substring(0, 100)}...\n` : '') +
                `⏰ <b>Hora:</b> ${alerta.dataHora}\n\n` +
                `💬 ${alerta.conteudo}\n\n` +
                `⚠️ <b>RESPONDA IMEDIATAMENTE — prazo pode ser de apenas 10 minutos!</b>`;

              const axios = require('axios');
              await axios.post(`https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage`, {
                chat_id: telegramConfig.chatId,
                text: texto,
                parse_mode: 'HTML'
              });
              console.log(`[ALERTA] Telegram enviado: mensagem direcionada em ${compraId}`);
            }
          }
        } catch (telegramErr) {
          console.error('[ALERTA] Erro Telegram:', telegramErr.message);
        }
      }

      res.json({ success: true, novas, total: mensagens.length, alertas: alertas.length });
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

  // ==================== SNIPER ITENS (config por item no banco) ====================

  /**
   * GET /api/sniper/itens?compraId=XXXX
   * Lista itens configurados para uma compra.
   */
  app.get('/api/sniper/itens', (req, res) => {
    try {
      const { compraId } = req.query;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      const itens = db.prepare('SELECT * FROM sniper_itens WHERE compraId = ? ORDER BY itemNumero').all(compraId);
      res.json({ success: true, itens });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/itens
   * Cria ou atualiza um item (upsert por compraId+itemNumero).
   */
  app.post('/api/sniper/itens', (req, res) => {
    try {
      const { compraId, itemNumero, descricao, valorLance, faseItem, horarioAlvo,
              antecedenciaMs, tentativas, intervaloMs, ativo,
              valorMinimo, descontoMinimo, descontoMaximo, valorEstimado } = req.body;
      if (!compraId || !itemNumero) return res.status(400).json({ success: false, error: 'compraId e itemNumero obrigatórios' });

      const stmt = db.prepare(`INSERT INTO sniper_itens (compraId, itemNumero, descricao, valorLance, faseItem, horarioAlvo, antecedenciaMs, tentativas, intervaloMs, ativo, valorMinimo, descontoMinimo, descontoMaximo, valorEstimado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(compraId, itemNumero) DO UPDATE SET
          descricao = COALESCE(excluded.descricao, descricao),
          valorLance = COALESCE(excluded.valorLance, valorLance),
          faseItem = COALESCE(excluded.faseItem, faseItem),
          horarioAlvo = COALESCE(excluded.horarioAlvo, horarioAlvo),
          antecedenciaMs = COALESCE(excluded.antecedenciaMs, antecedenciaMs),
          tentativas = COALESCE(excluded.tentativas, tentativas),
          intervaloMs = COALESCE(excluded.intervaloMs, intervaloMs),
          ativo = COALESCE(excluded.ativo, ativo),
          valorMinimo = COALESCE(excluded.valorMinimo, valorMinimo),
          descontoMinimo = COALESCE(excluded.descontoMinimo, descontoMinimo),
          descontoMaximo = COALESCE(excluded.descontoMaximo, descontoMaximo),
          valorEstimado = COALESCE(excluded.valorEstimado, valorEstimado),
          dataAtualizacao = CURRENT_TIMESTAMP`);

      stmt.run(compraId, itemNumero, descricao || null, valorLance || null, faseItem || 'LA',
               horarioAlvo || null, antecedenciaMs || 3000, tentativas || 3, intervaloMs || 500,
               ativo !== undefined ? (ativo ? 1 : 0) : 1,
               valorMinimo !== undefined ? valorMinimo : null,
               descontoMinimo !== undefined ? descontoMinimo : null,
               descontoMaximo !== undefined ? descontoMaximo : null,
               valorEstimado !== undefined ? valorEstimado : null);

      const item = db.prepare('SELECT * FROM sniper_itens WHERE compraId = ? AND itemNumero = ?').get(compraId, itemNumero);
      res.json({ success: true, item });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/itens/bulk
   * Cria/atualiza vários itens de uma vez.
   */
  app.post('/api/sniper/itens/bulk', (req, res) => {
    try {
      const { compraId, itens } = req.body;
      if (!compraId || !itens?.length) return res.status(400).json({ success: false, error: 'compraId e itens obrigatórios' });

      const stmt = db.prepare(`INSERT INTO sniper_itens (compraId, itemNumero, descricao, valorLance, faseItem, ativo, valorEstimado)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(compraId, itemNumero) DO UPDATE SET
          descricao = COALESCE(excluded.descricao, descricao),
          valorLance = COALESCE(excluded.valorLance, valorLance),
          faseItem = COALESCE(excluded.faseItem, faseItem),
          ativo = COALESCE(excluded.ativo, ativo),
          valorEstimado = COALESCE(excluded.valorEstimado, valorEstimado),
          dataAtualizacao = CURRENT_TIMESTAMP`);

      const numerosRecebidos = itens.map(i => i.itemNumero);
      const inserir = db.transaction((itens) => {
        for (const i of itens) {
          stmt.run(compraId, i.itemNumero, i.descricao || null, i.valorLance || null, i.faseItem || 'LA', i.ativo !== undefined ? (i.ativo ? 1 : 0) : 1, i.valorEstimado || null);
        }
        // Remover itens que não existem mais na fonte (evita itens fantasma)
        if (numerosRecebidos.length > 0) {
          const placeholders = numerosRecebidos.map(() => '?').join(',');
          db.prepare(`DELETE FROM sniper_itens WHERE compraId = ? AND itemNumero NOT IN (${placeholders})`).run(compraId, ...numerosRecebidos);
        }
      });
      inserir(itens);

      const saved = db.prepare('SELECT * FROM sniper_itens WHERE compraId = ? ORDER BY itemNumero').all(compraId);
      res.json({ success: true, itens: saved });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * DELETE /api/sniper/itens/:compraId/:itemNumero
   */
  app.delete('/api/sniper/itens/:compraId/:itemNumero', (req, res) => {
    try {
      const { compraId, itemNumero } = req.params;
      db.prepare('DELETE FROM sniper_itens WHERE compraId = ? AND itemNumero = ?').run(compraId, parseInt(itemNumero));
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/itens-pncp?compraId=XXXX
   * Busca itens da tabela PNCP (licitacoes + itens) para uma participação Comprasnet.
   * Usa codigoUnidade + ano + objeto para encontrar a licitação correspondente.
   */
  app.get('/api/sniper/itens-pncp', (req, res) => {
    try {
      const { compraId } = req.query;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });

      // Extrair UASG e ano do compraId (formato: UASG6 + MOD2 + NUM5 + ANO4)
      const participacao = db.prepare(
        'SELECT compraId, cnpj, codigoUnidade, ano, sequencial, objeto FROM participacoes_comprasnet WHERE compraId = ?'
      ).get(compraId);
      if (!participacao) return res.json({ success: false, error: 'Participação não encontrada' });

      // Extrair UASG do compraId (primeiros 6 dígitos)
      const uasg = compraId.substring(0, 6);

      // Buscar licitação no PNCP: codigoUnidade contém a UASG, mesmo ano, objeto similar
      const palavrasObjeto = (participacao.objeto || '').split(/\s+/).filter(p => p.length > 4).slice(0, 3);
      let licitacao = null;

      if (palavrasObjeto.length > 0) {
        // Tentar match por UASG + ano + palavras do objeto
        const likeClause = palavrasObjeto.map(() => 'objetoCompra LIKE ?').join(' AND ');
        const likeParams = palavrasObjeto.map(p => `%${p}%`);
        licitacao = db.prepare(
          `SELECT id, codigoUnidade, anoCompra, sequencialCompra, objetoCompra, numeroControlePNCP
           FROM licitacoes WHERE codigoUnidade LIKE ? AND anoCompra = ? AND ${likeClause}
           ORDER BY id DESC LIMIT 1`
        ).get(`%${uasg}%`, participacao.ano, ...likeParams);
      }

      if (!licitacao) {
        return res.json({ success: false, error: 'Licitação PNCP não encontrada para esta participação' });
      }

      const itens = db.prepare(
        'SELECT numeroItem, descricao, quantidade, unidadeMedida, valorUnitarioEstimado, valorTotal FROM itens WHERE licitacaoId = ? ORDER BY numeroItem'
      ).all(licitacao.id);

      res.json({
        success: true,
        licitacaoId: licitacao.id,
        numeroControlePNCP: licitacao.numeroControlePNCP,
        itens: itens.map(i => ({
          itemNumero: i.numeroItem,
          descricao: i.descricao,
          quantidade: i.quantidade,
          unidadeMedida: i.unidadeMedida,
          valorEstimado: i.valorUnitarioEstimado,
          valorTotal: i.valorTotal,
        })),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/historico?compraId=XXXX
   * Histórico de lances enviados.
   */
  app.get('/api/sniper/historico', (req, res) => {
    try {
      const { compraId, limit } = req.query;
      let query = 'SELECT * FROM sniper_historico';
      const params = [];
      if (compraId) { query += ' WHERE compraId = ?'; params.push(compraId); }
      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(parseInt(limit) || 50);
      res.json({ success: true, historico: db.prepare(query).all(...params) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

} // end registrarRotasSniper

function getSniper() {
  return sniper;
}

module.exports = { registrarRotasSniper, getSniper };
