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

  // Cache em memória das disputas recebidas da extensão (declarado aqui para uso no auto-lance)
  let disputasCache = { disputas: [], atualizadoEm: null };

  // ==================== AUTO-LANCE ENGINE ====================
  let autoLanceAtivo = false;
  let autoLanceTimerNormal = null;   // 15s cycle
  let autoLanceTimerRapido = null;   // 5s cycle (fast poll for sniper/ambos)
  let autoLancePendentes = {};       // { 'compraId-itemNumero': timestamp } cooldown 30s
  let autoLanceComprasFast = {};     // { compraId: true } compras that need fast polling (fimContagem < 90s)
  let autoLanceLog = [];             // últimos 100 log entries
  let autoLanceStats = { ciclos: 0, lancesEnviados: 0, ultimoCiclo: null };

  function logAuto(msg) {
    const entry = { ts: new Date().toISOString(), msg };
    autoLanceLog.unshift(entry);
    if (autoLanceLog.length > 100) autoLanceLog.pop();
    console.log(`[AutoLance] ${msg}`);
  }

  // ==================== BLITZ MODE ====================
  let blitzDisparados = {};  // { 'compraId-itemNumero': timestamp } prevent re-trigger
  let autoLanceTimerUltra = null;  // 1s cycle for items near end

  /**
   * A7: Calcula média de tempo real por lance usando sniper_historico.
   * Retorna tempo médio em ms (default 800ms se sem dados).
   */
  function calcularMediaTempoLance(compraId, itemNumero) {
    try {
      const rows = db.prepare(
        `SELECT tempoMs FROM sniper_historico
         WHERE compraId = ? AND itemNumero = ? AND sucesso = 1 AND tempoMs > 0
         ORDER BY timestamp DESC LIMIT 20`
      ).all(compraId, itemNumero);
      if (rows.length === 0) return 800;
      const soma = rows.reduce((s, r) => s + r.tempoMs, 0);
      return Math.round(soma / rows.length);
    } catch (e) {
      return 800;
    }
  }

  /**
   * A1: Pré-calcula TODOS os degraus de lance de nossoValor até valorMinimo.
   * Retorna array de lances prontos para enfileirar.
   */
  function calcularBatchLances(cfgItem, liveItem, compraId) {
    const nossoValor = liveItem.nossoValor;
    const varMin = liveItem.variacaoMinima;
    const tipoVar = liveItem.tipoVariacao || 'V';
    const valorMinimo = cfgItem.valorMinimo;

    if (nossoValor == null || varMin == null || valorMinimo == null) return [];
    if (nossoValor <= valorMinimo) return [];

    const lances = [];
    let valorAtual = nossoValor;
    let step = 0;

    while (valorAtual > valorMinimo) {
      let novoValor;
      if (tipoVar === 'P') {
        novoValor = valorAtual * (1 - varMin / 100);
      } else {
        novoValor = valorAtual - varMin;
      }
      novoValor = Math.round(novoValor * 100) / 100;
      if (novoValor < valorMinimo) novoValor = valorMinimo;

      // Don't create duplicate of current value
      if (novoValor >= valorAtual) break;

      step++;
      lances.push({
        id: `blitz-${Date.now()}-${step}-${Math.random().toString(36).substring(2, 5)}`,
        compraId,
        itemNumero: cfgItem.itemNumero,
        valor: novoValor,
        faseItem: cfgItem.faseItem || 'LA',
        criadoEm: new Date().toISOString(),
        status: 'pendente',
        fonte: 'blitz',
        batchIndex: step - 1,
        batchTotal: 0, // will be updated after loop
      });

      valorAtual = novoValor;
      if (novoValor <= valorMinimo) break;
      // Safety: max 50 steps
      if (step >= 50) break;
    }

    // Update batchTotal
    for (const l of lances) l.batchTotal = lances.length;

    return lances;
  }

  /**
   * Core loop: checks all items with modoAuto set and enqueues bids when losing.
   * @param {boolean} modoRapido - If true, only processes compras in autoLanceComprasFast
   */
  async function executarCicloAutoLance(modoRapido = false) {
    try {
      // Query DB for compras with auto items
      const autoItens = db.prepare(
        `SELECT si.compraId, si.itemNumero, si.valorMinimo, si.valorLance, si.modoAuto, si.faseItem, si.antecedenciaMs
         FROM sniper_itens si
         WHERE si.modoAuto IS NOT NULL AND si.modoAuto != ''`
      ).all();

      if (autoItens.length === 0) return;

      // Group by compraId
      const porCompra = {};
      for (const item of autoItens) {
        if (!porCompra[item.compraId]) porCompra[item.compraId] = [];
        porCompra[item.compraId].push(item);
      }

      // In fast mode, only process compras near end
      const compraIds = modoRapido
        ? Object.keys(porCompra).filter(id => autoLanceComprasFast[id])
        : Object.keys(porCompra);

      if (compraIds.length === 0) return;

      autoLanceStats.ciclos++;
      autoLanceStats.ultimoCiclo = new Date().toISOString();

      // Log diagnóstico a cada 20 ciclos (~5min) ou nos primeiros 3 ciclos
      const logDiag = (autoLanceStats.ciclos <= 3 || autoLanceStats.ciclos % 20 === 0);

      // Reset fast list (will be rebuilt)
      if (!modoRapido) autoLanceComprasFast = {};

      for (const compraId of compraIds) {
        try {
          // Usar dados do cache (populado pela extensão via POST /api/sync/disputas)
          const cached = disputasCache.disputas.find(d => d.compraId === compraId);
          if (!cached || !cached.itens || cached.itens.length === 0) {
            if (logDiag) logAuto(`Cache vazio: ${compraId} (extensão não sincronizou ainda)`);
            continue;
          }

          const itensAuto = porCompra[compraId];

          for (const cfgItem of itensAuto) {
            const liveItem = cached.itens.find(i => i.numero === cfgItem.itemNumero);
            if (!liveItem) {
              if (logDiag) logAuto(`Item ${cfgItem.itemNumero} não no cache de ${compraId} (${cached.itens.length} itens: ${cached.itens.slice(0,5).map(i=>i.numero).join(',')})`);
              continue;
            }

            const melhorGeral = liveItem.melhorValor;
            const nossoValor = liveItem.nossoValor;
            const varMin = liveItem.variacaoMinima;
            const tipoVar = liveItem.tipoVariacao || 'V';
            const fimContagem = liveItem.fimContagem;
            const podeEnviar = liveItem.podeEnviar;

            if (!podeEnviar) {
              if (logDiag) logAuto(`Item ${cfgItem.itemNumero}: podeEnviar=false fase=${liveItem.fase||'?'}`);
              continue;
            }

            // Check countdown for sniper mode
            let segRestantes = null;
            if (fimContagem) {
              segRestantes = Math.floor((new Date(fimContagem).getTime() - Date.now()) / 1000);
            }

            // Sniper mode: only act in last N seconds (configurable via antecedenciaMs, default 60s)
            if (cfgItem.modoAuto === 'sniper') {
              const sniperSeg = Math.round((cfgItem.antecedenciaMs || 60000) / 1000);
              if (segRestantes == null || segRestantes > sniperSeg || segRestantes <= 0) continue;
              // Fast polling when approaching sniper window
              if (segRestantes < sniperSeg + 30 && segRestantes > 0) {
                autoLanceComprasFast[compraId] = true;
              }
            }

            // A3: Ultra-fast polling when < 30s from end
            if (segRestantes != null && segRestantes > 0 && segRestantes < 30) {
              autoLanceComprasFast[compraId] = true;
              if (!autoLanceTimerUltra) {
                autoLanceTimerUltra = setInterval(() => executarCicloAutoLance(true), 1000);
                logAuto(`ULTRA-FAST timer ativado (1s) — item ${cfgItem.itemNumero} a ${segRestantes}s do fim`);
              }
            }

            // Already at best price — nothing to do
            if (nossoValor != null && melhorGeral != null && nossoValor <= melhorGeral) continue;

            // Need valorMinimo to know where to bid
            if (cfgItem.valorMinimo == null) continue;

            // Already at our floor
            if (nossoValor != null && nossoValor <= cfgItem.valorMinimo) continue;

            // A2: BLITZ MODE — sniper with batch pre-calculation
            const blitzKey = `${compraId}-${cfgItem.itemNumero}`;
            if (cfgItem.modoAuto === 'sniper' && segRestantes != null && segRestantes > 0 && !blitzDisparados[blitzKey]) {
              // Calculate batch
              const batchLances = calcularBatchLances(cfgItem, liveItem, compraId);
              if (batchLances.length > 0) {
                // Calculate timing: steps * avgBidTime + safety margin
                const avgMs = calcularMediaTempoLance(compraId, cfgItem.itemNumero);
                const tempoEstimadoMs = batchLances.length * avgMs;
                const safetyMs = 3000;
                const momentoIdealSeg = Math.ceil((tempoEstimadoMs + safetyMs) / 1000);

                if (segRestantes <= momentoIdealSeg) {
                  // DISPARA BLITZ! Enqueue ALL at once
                  const jaEnfileirado = filaLances.some(l =>
                    l.compraId === compraId &&
                    l.itemNumero === cfgItem.itemNumero &&
                    (l.status === 'pendente' || l.status === 'processando')
                  );
                  if (!jaEnfileirado) {
                    for (const lance of batchLances) {
                      filaLances.push(lance);
                    }
                    blitzDisparados[blitzKey] = Date.now();
                    autoLanceStats.lancesEnviados += batchLances.length;
                    liveItem.nossoValor = batchLances[batchLances.length - 1].valor;

                    logAuto(`🚀 BLITZ: ${compraId} item ${cfgItem.itemNumero} — ${batchLances.length} lances enfileirados! ` +
                      `R$${nossoValor.toFixed(2)} → R$${batchLances[batchLances.length - 1].valor.toFixed(2)} ` +
                      `(avg ${avgMs}ms/lance, estimado ${Math.round(tempoEstimadoMs/1000)}s, restam ${segRestantes}s)`);
                    continue; // blitz handled this item
                  }
                } else if (logDiag) {
                  logAuto(`BLITZ aguardando: item ${cfgItem.itemNumero} — ${batchLances.length} passos, momento ideal T-${momentoIdealSeg}s, restam ${segRestantes}s`);
                }
                continue; // sniper waits for blitz moment
              }
            }

            // Calculate: one step down from our current value (respecting varMin)
            let novoLance;
            if (nossoValor != null && varMin != null) {
              if (tipoVar === 'P') {
                novoLance = nossoValor * (1 - varMin / 100);
              } else {
                novoLance = nossoValor - varMin;
              }
              novoLance = Math.round(novoLance * 100) / 100;
            } else if (nossoValor == null && cfgItem.valorLance != null && cfgItem.valorLance > 0) {
              // First bid — use valorLance
              novoLance = parseFloat(cfgItem.valorLance);
            } else {
              continue;
            }

            // Clamp to floor
            if (novoLance < cfgItem.valorMinimo) novoLance = cfgItem.valorMinimo;

            // Check cooldown (30s per item — A5: blitz lances bypass cooldown)
            const pendingKey = `${compraId}-${cfgItem.itemNumero}`;
            if (autoLancePendentes[pendingKey] && (Date.now() - autoLancePendentes[pendingKey]) < 30000) {
              continue; // still in cooldown
            }

            // Check if already in filaLances (pendente or processando)
            const jaEnfileirado = filaLances.some(l =>
              l.compraId === compraId &&
              l.itemNumero === cfgItem.itemNumero &&
              (l.status === 'pendente' || l.status === 'processando')
            );
            if (jaEnfileirado) continue;

            // Enqueue!
            const id = 'auto-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
            const lance = {
              id,
              compraId,
              itemNumero: cfgItem.itemNumero,
              valor: novoLance,
              faseItem: cfgItem.faseItem || 'LA',
              criadoEm: new Date().toISOString(),
              status: 'pendente',
              fonte: 'auto-lance',
            };
            filaLances.push(lance);
            autoLancePendentes[pendingKey] = Date.now();
            autoLanceStats.lancesEnviados++;

            // Atualizar cache local para o próximo ciclo não repetir o mesmo lance
            liveItem.nossoValor = novoLance;

            const logMelhor = melhorGeral != null ? `melhor R$${melhorGeral.toFixed(2)}` : 'sem melhor';
            logAuto(`LANCE: ${compraId} item ${cfgItem.itemNumero} — ${logMelhor}, nosso R$${(nossoValor||0).toFixed(2)} → R$${novoLance.toFixed(2)} (var ${tipoVar}=${varMin}, modo=${cfgItem.modoAuto})`);
          }
        } catch (e) {
          logAuto(`ERRO compra ${compraId}: ${e.message}`);
        }
      }
      // A3: Check if ultra timer still needed (only on normal cycles)
      if (!modoRapido) verificarUltraTimer();
    } catch (e) {
      logAuto(`ERRO ciclo: ${e.message}`);
    }
  }

  function iniciarAutoLance() {
    if (autoLanceAtivo) return;
    autoLanceAtivo = true;
    logAuto('Engine LIGADO');

    // Normal cycle every 15s
    autoLanceTimerNormal = setInterval(() => executarCicloAutoLance(false), 15000);
    // Fast cycle every 5s (for sniper/ambos near end)
    autoLanceTimerRapido = setInterval(() => executarCicloAutoLance(true), 5000);
    // Run immediately
    executarCicloAutoLance(false);
  }

  function pararAutoLance() {
    if (!autoLanceAtivo) return;
    autoLanceAtivo = false;
    if (autoLanceTimerNormal) { clearInterval(autoLanceTimerNormal); autoLanceTimerNormal = null; }
    if (autoLanceTimerRapido) { clearInterval(autoLanceTimerRapido); autoLanceTimerRapido = null; }
    if (autoLanceTimerUltra) { clearInterval(autoLanceTimerUltra); autoLanceTimerUltra = null; }
    autoLanceComprasFast = {};
    blitzDisparados = {};
    logAuto('Engine DESLIGADO');
  }

  // A3: Auto-cleanup ultra timer when no items near end
  function verificarUltraTimer() {
    if (!autoLanceTimerUltra) return;
    // Check if any item is still < 30s from end
    let precisaUltra = false;
    for (const d of disputasCache.disputas) {
      if (!d.itens) continue;
      for (const item of d.itens) {
        if (item.fimContagem) {
          const seg = Math.floor((new Date(item.fimContagem).getTime() - Date.now()) / 1000);
          if (seg > 0 && seg < 30) { precisaUltra = true; break; }
        }
      }
      if (precisaUltra) break;
    }
    if (!precisaUltra) {
      clearInterval(autoLanceTimerUltra);
      autoLanceTimerUltra = null;
      logAuto('ULTRA-FAST timer desativado (nenhum item próximo do fim)');
    }
  }

  function verificarAutoLanceNecessario() {
    try {
      const count = db.prepare(
        `SELECT COUNT(*) as n FROM sniper_itens WHERE modoAuto IS NOT NULL AND modoAuto != ''`
      ).get();
      if (count.n > 0 && !autoLanceAtivo) {
        iniciarAutoLance();
      } else if (count.n === 0 && autoLanceAtivo) {
        pararAutoLance();
      }
    } catch (e) {}
  }

  // Auto-start on boot (after 5s to let everything initialize)
  setTimeout(verificarAutoLanceNecessario, 5000);

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

    // A4: Determine poll interval based on proximity to end
    let pollIntervalMs = 5000; // default
    for (const d of disputasCache.disputas) {
      if (!d.itens) continue;
      for (const item of d.itens) {
        if (item.fimContagem) {
          const seg = Math.floor((new Date(item.fimContagem).getTime() - Date.now()) / 1000);
          if (seg > 0 && seg < 60) { pollIntervalMs = 1000; break; }
        }
      }
      if (pollIntervalMs === 1000) break;
    }

    res.json({ success: true, lances: pendentes, total: filaLances.length, pollIntervalMs });
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

      // Auto-lance pending cleanup
      // A5: Blitz lances bypass cooldown
      const pendingKey = `${compraId}-${itemNumero}`;
      const lanceObj = idx >= 0 ? filaLances[idx] : null;
      const isBlitz = lanceObj && lanceObj.fonte === 'blitz';

      if (sucesso) {
        if (isBlitz) {
          // Blitz: no cooldown — next lance in batch comes immediately
          delete autoLancePendentes[pendingKey];
        } else {
          // Normal: keep cooldown on success (prevent re-bidding immediately)
          autoLancePendentes[pendingKey] = Date.now();
        }
      } else {
        // Clear pending on failure so auto-lance can retry
        delete autoLancePendentes[pendingKey];
      }

      // Limpar da fila após 30s (or 5s for blitz to reduce clutter)
      setTimeout(() => {
        const i = filaLances.findIndex(l => l.id === id);
        if (i >= 0) filaLances.splice(i, 1);
      }, isBlitz ? 5000 : 30000);

      // A6: Reactive trigger — after success in continuo mode, run mini-cycle immediately
      if (sucesso && !isBlitz && autoLanceAtivo) {
        setImmediate(() => executarCicloAutoLance(true));
      }

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== A8: BATCH RESULT ENDPOINT ====================

  /**
   * POST /api/sniper/resultado-lances-batch
   * Recebe array de resultados de lances de uma vez (extensão envia batch).
   */
  app.post('/api/sniper/resultado-lances-batch', (req, res) => {
    try {
      const { resultados } = req.body;
      if (!Array.isArray(resultados) || resultados.length === 0) {
        return res.status(400).json({ success: false, error: 'resultados deve ser array não-vazio' });
      }

      let sucessos = 0, falhas = 0;

      for (const r of resultados) {
        const { id, compraId, itemNumero, valor, status, sucesso, resposta, tempoMs } = r;

        // Update queue item
        const idx = filaLances.findIndex(l => l.id === id);
        if (idx >= 0) {
          filaLances[idx].status = sucesso ? 'sucesso' : 'falha';
          filaLances[idx].httpStatus = status;
          filaLances[idx].resposta = resposta;
          filaLances[idx].tempoMs = tempoMs;
          filaLances[idx].processadoEm = new Date().toISOString();
        }

        // Add to recent results
        resultadosLances.unshift({
          id, compraId, itemNumero, valor, status, sucesso, resposta, tempoMs,
          timestamp: new Date().toISOString(),
          fonte: 'extensao-browser',
        });

        // Log
        if (sucesso) {
          sniper.log(`🎯✅ LANCE (batch)! R$ ${parseFloat(valor).toFixed(2)} item ${itemNumero} (${tempoMs}ms)`);
          sucessos++;
        } else {
          sniper.log(`🎯❌ Lance falhou (batch): HTTP ${status} item ${itemNumero} (${tempoMs}ms)`);
          falhas++;
        }

        // Persist to DB
        try {
          db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, itemNumero, valor, status, sucesso ? 1 : 0, tempoMs, (resposta||'').substring(0, 500), 'browser');
          db.prepare(`UPDATE sniper_itens SET status = ?, ultimoResultado = ?, ultimoEnvio = CURRENT_TIMESTAMP, dataAtualizacao = CURRENT_TIMESTAMP
            WHERE compraId = ? AND itemNumero = ?`).run(sucesso ? 'enviado' : 'erro', `HTTP ${status} (${tempoMs}ms)`, compraId, itemNumero);
        } catch (dbErr) {}

        // Sniper history
        sniper.historico.unshift({ compraId, itemNumero, valor, status, sucesso, tempoMs, timestamp: new Date().toISOString(), fonte: 'browser' });

        // Cooldown: blitz lances bypass
        const pendingKey = `${compraId}-${itemNumero}`;
        const lanceObj = idx >= 0 ? filaLances[idx] : null;
        const isBlitz = lanceObj && lanceObj.fonte === 'blitz';
        if (sucesso) {
          if (isBlitz) {
            delete autoLancePendentes[pendingKey];
          } else {
            autoLancePendentes[pendingKey] = Date.now();
          }
        } else {
          delete autoLancePendentes[pendingKey];
        }

        // Clean from queue
        setTimeout(() => {
          const i = filaLances.findIndex(l => l.id === id);
          if (i >= 0) filaLances.splice(i, 1);
        }, isBlitz ? 5000 : 30000);
      }

      // Trim results history
      if (resultadosLances.length > 50) resultadosLances.length = 50;
      if (sniper.historico.length > 50) sniper.historico.length = 50;

      console.log(`[Sniper] Batch resultado: ${sucessos} ✅ ${falhas} ❌ (${resultados.length} total)`);

      // Reactive trigger after batch
      if (sucessos > 0 && autoLanceAtivo) {
        setImmediate(() => executarCicloAutoLance(true));
      }

      res.json({ success: true, sucessos, falhas, total: resultados.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== AUTO-LANCE ROUTES ====================

  /**
   * GET /api/sniper/auto/status
   * Estado do auto-lance engine + log.
   */
  app.get('/api/sniper/auto/status', (req, res) => {
    try {
      const autoItens = db.prepare(
        `SELECT compraId, itemNumero, modoAuto, valorMinimo FROM sniper_itens WHERE modoAuto IS NOT NULL AND modoAuto != ''`
      ).all();
      res.json({
        success: true,
        ativo: autoLanceAtivo,
        itensMonitorados: autoItens.length,
        itens: autoItens,
        stats: autoLanceStats,
        comprasFastPoll: Object.keys(autoLanceComprasFast),
        pendentes: Object.keys(autoLancePendentes).length,
        blitzDisparados: Object.keys(blitzDisparados),
        ultraTimerAtivo: !!autoLanceTimerUltra,
        log: autoLanceLog.slice(0, 30),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/auto/toggle
   * Ligar/desligar engine manualmente.
   */
  app.post('/api/sniper/auto/toggle', (req, res) => {
    try {
      if (autoLanceAtivo) {
        pararAutoLance();
      } else {
        iniciarAutoLance();
      }
      res.json({ success: true, ativo: autoLanceAtivo });
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
        // Filtrar apenas participações realmente em disputa/ativas
        // Exclui: FR (fracassada), EN (encerrada), SU (suspensa)
        // Exclui fases: 4 (encerrada), 99 (concluída/desconhecida), 1 (cadastrada, ainda não abriu)
        query += " AND situacao NOT IN ('FR', 'EN', 'SU') AND (faseCompra IS NULL OR faseCompra NOT IN ('4', '99', '1', 'encerrada', 'ENCERRADA'))";
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
   * GET /api/sniper/itens-live?compraId=XXXX
   * Busca itens em disputa DIRETO da API Comprasnet usando Bearer token.
   * Retorna melhorValor, nossoValor, variacaoMinima, fimContagem etc.
   * Não depende do cache da extensão.
   */
  app.get('/api/sniper/itens-live', async (req, res) => {
    try {
      const { compraId } = req.query;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      if (!sniper.temToken()) return res.json({ success: false, error: 'Sem Bearer token' });

      // Tentar /itens/em-disputa primeiro (tem preços live), fallback para /itens e /itens/classificacao
      const endpoints = [
        `/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`,
        `/comprasnet-disputa/v1/compras/${compraId}/itens`,
        `/comprasnet-disputa/v1/compras/${compraId}/itens/classificacao`,
      ];

      const tentativas = [];
      for (const path of endpoints) {
        try {
          const { status, data } = await sniper.apiGet(path);
          tentativas.push({ endpoint: path.split('/v1/')[1], status, isArray: Array.isArray(data), len: Array.isArray(data) ? data.length : 0 });
          if ((status === 200 || status === 206) && Array.isArray(data) && data.length > 0) {
            const itens = data.map(i => ({
              numero: i.numero || i.identificador,
              descricao: (i.descricao || i.objetoItem || '').substring(0, 200),
              fase: i.fase || '',
              melhorValor: (i.melhorValorGeral || {}).valorInformado != null ? i.melhorValorGeral.valorInformado : null,
              nossoValor: (i.melhorValorFornecedor || {}).valorInformado != null ? i.melhorValorFornecedor.valorInformado : null,
              valorEstimado: i.valorEstimadoUnitario || i.valorEstimado || null,
              situacaoParticipante: i.situacaoParticipanteDisputa || null,
              variacaoMinima: i.variacaoMinimaEntreLances != null ? i.variacaoMinimaEntreLances : null,
              tipoVariacao: i.tipoVariacaoMinimaEntreLances || 'V',
              podeEnviar: i.podeEnviarLances || false,
              fimContagem: i.dataHoraFimContagem || null,
              versaoParticipante: i.versaoParticipante || null,
            }));

            // Atualizar cache de disputas também
            const idx = disputasCache.disputas.findIndex(d => d.compraId === compraId);
            const disputaData = {
              compraId,
              totalItens: itens.length,
              itensAtivos: itens.filter(i => i.podeEnviar || i.fase === 'LA').length,
              itens,
            };
            if (idx >= 0) {
              disputasCache.disputas[idx] = { ...disputasCache.disputas[idx], ...disputaData };
            } else {
              disputasCache.disputas.push(disputaData);
            }
            disputasCache.atualizadoEm = new Date().toISOString();

            return res.json({ success: true, itens, fonte: 'api-direta', endpoint: path.split('/v1/')[1] });
          }
        } catch (e) {
          // Tentar próximo endpoint
        }
      }

      return res.json({ success: false, error: 'Nenhum endpoint retornou dados de itens', tentativas });
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

      const stmtSelect = db.prepare('SELECT id FROM participacoes_comprasnet WHERE compraId = ?');
      const stmtUpdate = db.prepare(`UPDATE participacoes_comprasnet SET
        situacao = COALESCE(?, situacao), faseCompra = COALESCE(?, faseCompra),
        objeto = COALESCE(?, objeto), orgao = COALESCE(?, orgao),
        dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ?`);
      const stmtInsert = db.prepare(`INSERT INTO participacoes_comprasnet
        (compraId, cnpj, ano, sequencial, orgao, objeto, situacao, faseCompra, ativo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);

      const syncTransaction = db.transaction((items) => {
        for (const item of items) {
          const compra = item.compra || item;
          const uasg = String(compra.numeroUasg || '').padStart(6, '0');
          const mod = String(compra.modalidade || '').padStart(2, '0');
          const num = String(compra.numero || '').padStart(5, '0');
          const ano = String(compra.ano || '');
          const compraId = compra.compraId || (uasg + mod + num + ano);
          if (!compraId || compraId.length < 10) continue;

          const existe = stmtSelect.get(compraId);
          if (existe) {
            stmtUpdate.run(
              compra.situacaoCompraFaseExterna || compra.situacao || null,
              compra.faseCompraFaseExterna || compra.faseCompra || null,
              compra.objetoCompra || compra.objeto || null,
              compra.nomeOrgao || compra.nomeUasg || compra.orgao || null,
              compraId,
            );
            atualizadas++;
          } else {
            stmtInsert.run(
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
      });
      syncTransaction(participacoes);

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
              valorMinimo, descontoMinimo, descontoMaximo, valorEstimado, modoAuto } = req.body;
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

      // modoAuto: handle separately (null = explicitly clear, undefined = don't touch)
      if ('modoAuto' in req.body) {
        db.prepare(`UPDATE sniper_itens SET modoAuto = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ? AND itemNumero = ?`)
          .run(modoAuto || null, compraId, itemNumero);
      }

      const item = db.prepare('SELECT * FROM sniper_itens WHERE compraId = ? AND itemNumero = ?').get(compraId, itemNumero);

      // Check if auto-lance engine needs to start/stop
      verificarAutoLanceNecessario();

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

  // ==================== ENVIO DE PROPOSTA VIA API ====================

  /**
   * POST /api/proposta/enviar-api
   * Envia proposta diretamente via API Comprasnet usando o Bearer token.
   * Não depende da extensão para o envio — usa chamadas HTTP diretas.
   *
   * Body: {
   *   compraId: string,
   *   itens: [{ numero: number, valor: number, marca?: string, modelo?: string, fabricante?: string }]
   * }
   */
  app.post('/api/proposta/enviar-api', async (req, res) => {
    try {
      const { compraId, itens } = req.body;

      if (!compraId) {
        return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      }
      if (!itens || !Array.isArray(itens) || itens.length === 0) {
        return res.status(400).json({ success: false, error: 'Array de itens obrigatório' });
      }
      if (!sniper.temToken()) {
        return res.status(400).json({ success: false, error: 'Sem Bearer token. Abra o Comprasnet com a extensão Token Relay.' });
      }
      if (sniper.tokenExpirado()) {
        return res.status(400).json({ success: false, error: 'Bearer token expirado. Recarregue o Comprasnet.' });
      }

      const resultados = [];
      let sucessos = 0;

      for (const item of itens) {
        if (!item.numero || !item.valor || item.valor <= 0) {
          resultados.push({ numero: item.numero, sucesso: false, erro: 'Valor inválido' });
          continue;
        }

        // Tentar enviar proposta para este item
        // Endpoint: POST /comprasnet-fase-externa/v1/compras/{compraId}/itens/{itemNumero}/proposta
        const body = {
          valorUnitario: parseFloat(item.valor),
          valorInformado: parseFloat(item.valor),
          marcaFabricante: item.marca || item.fabricante || '',
          modeloVersao: item.modelo || '',
          descricaoDetalhada: item.descricao || '',
        };

        const endpoints = [
          { method: 'post', path: `/comprasnet-fase-externa/v1/compras/${compraId}/itens/${item.numero}/proposta`, body },
          { method: 'post', path: `/comprasnet-fase-externa/v1/compras/${compraId}/itens/${item.numero}/proposta/fornecedor`, body },
          { method: 'post', path: `/comprasnet-disputa/v1/compras/${compraId}/itens/${item.numero}/proposta`, body: { valorInformado: parseFloat(item.valor) } },
        ];

        let enviado = false;
        for (const ep of endpoints) {
          try {
            const result = ep.method === 'post'
              ? await sniper.apiPost(ep.path, ep.body)
              : await sniper.apiGet(ep.path);

            if (result.status >= 200 && result.status < 300) {
              resultados.push({
                numero: item.numero,
                sucesso: true,
                status: result.status,
                endpoint: ep.path.split('/v1/')[1],
                resposta: typeof result.data === 'string' ? result.data.substring(0, 200) : JSON.stringify(result.data).substring(0, 200)
              });
              sucessos++;
              enviado = true;
              sniper.log(`✅ Proposta item ${item.numero}: R$ ${item.valor} (${ep.path.split('/v1/')[1]})`);
              break;
            } else {
              // Se não é 404/405, registrar como resultado
              if (result.status !== 404 && result.status !== 405) {
                resultados.push({
                  numero: item.numero,
                  sucesso: false,
                  status: result.status,
                  endpoint: ep.path.split('/v1/')[1],
                  erro: typeof result.data === 'string' ? result.data.substring(0, 200) : JSON.stringify(result.data).substring(0, 200)
                });
                enviado = true; // Don't try other endpoints
                sniper.log(`❌ Proposta item ${item.numero}: HTTP ${result.status}`);
                break;
              }
            }
          } catch (e) {
            // Continue to next endpoint
          }
        }

        if (!enviado) {
          resultados.push({
            numero: item.numero,
            sucesso: false,
            erro: 'Nenhum endpoint de proposta retornou resposta válida'
          });
        }
      }

      // Salvar no banco de participações que tentamos enviar
      try {
        db.prepare(`UPDATE participacoes_comprasnet SET
          situacao = CASE WHEN ? > 0 THEN 'PE' ELSE situacao END,
          dataAtualizacao = CURRENT_TIMESTAMP
          WHERE compraId = ?`).run(sucessos, compraId);
      } catch (e) {}

      console.log(`[PROPOSTA-API] compraId=${compraId}: ${sucessos}/${itens.length} itens enviados`);

      res.json({
        success: sucessos > 0,
        message: `${sucessos} de ${itens.length} itens enviados com sucesso`,
        compraId,
        sucessos,
        total: itens.length,
        resultados,
        linkCadastroProposta: `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/cadastro-propostas?compra=${compraId}`
      });

    } catch (error) {
      console.error('[PROPOSTA-API] Erro:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/proposta/itens-compra/:compraId
   * Busca itens de uma compra via API Comprasnet (usando bearer token do servidor).
   * Tenta vários endpoints por fase.
   */
  app.get('/api/proposta/itens-compra/:compraId', async (req, res) => {
    try {
      const { compraId } = req.params;
      if (!sniper.temToken()) {
        return res.status(400).json({ success: false, error: 'Sem Bearer token' });
      }

      // Primeiro, verificar cache de disputas
      const cached = disputasCache.disputas.find(d => d.compraId === compraId);
      if (cached && cached.itens?.length > 0) {
        return res.json({
          success: true,
          fonte: 'cache',
          compraId,
          itens: cached.itens,
          totalItens: cached.totalItens,
          orgao: cached.orgao,
          objeto: cached.objeto,
        });
      }

      // Sem cache — tentar via API
      const result = await sniper.consultarItens(compraId);
      if (!result.success) {
        return res.status(404).json({ success: false, error: 'Não foi possível obter itens' });
      }

      const itens = result.itens.map(i => ({
        numero: i.numero || i.identificador,
        descricao: (i.descricao || '').substring(0, 200),
        fase: i.fase || '',
        situacao: i.situacao || '',
        melhorValor: i.melhorValorGeral?.valorInformado || null,
        nossoValor: i.melhorValorFornecedor?.valorInformado || null,
        valorEstimado: i.valorEstimado || null,
        situacaoParticipante: i.situacaoParticipanteDisputa || null,
        variacaoMinima: i.variacaoMinimaEntreLances || null,
        podeEnviar: i.podeEnviarLances || false,
        fimContagem: i.dataHoraFimContagem || null,
        quantidade: i.quantidade || 1,
        unidadeMedida: i.unidadeMedida || 'UN',
      }));

      res.json({
        success: true,
        fonte: 'api',
        compraId,
        endpoint: result.endpoint,
        itens,
        totalItens: itens.length,
      });

    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

} // end registrarRotasSniper

function getSniper() {
  return sniper;
}

module.exports = { registrarRotasSniper, getSniper };
