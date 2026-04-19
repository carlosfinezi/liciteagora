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
const { buildCompraId } = require('./sniper-lance');
const { getPuppeteerSession } = require('./puppeteer-session');

// Singleton — sempre inicializado
const sniper = new SniperLance();
console.log('[Sniper] Inicializado (aguardando Bearer token da extensão)');

function registrarRotasSniper(app, monitorGetter, db) {

  sniper.initDb(db);
  // ==================== MIGRAÇÃO: colunas extras em participacoes_comprasnet ====================
  try {
    const infoP = db.pragma('table_info(participacoes_comprasnet)');
    const colunasP = infoP.map(c => c.name);
    const novasColunas = [
      { col: 'modoDisputa',           sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN modoDisputa TEXT' },
      { col: 'dataHoraInicioDisputa', sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN dataHoraInicioDisputa TEXT' },
      { col: 'dataHoraFimDisputa',    sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN dataHoraFimDisputa TEXT' },
      { col: 'linkPncp',             sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN linkPncp TEXT' },
      { col: 'exclusivaMeEpp',       sql: 'ALTER TABLE participacoes_comprasnet ADD COLUMN exclusivaMeEpp INTEGER DEFAULT 0' },
    ];
    for (const m of novasColunas) {
      if (!colunasP.includes(m.col)) {
        db.exec(m.sql);
        console.log(`[Sniper] Migração: coluna "${m.col}" adicionada a participacoes_comprasnet`);
      }
    }
  } catch (e) {
    console.error('[Sniper] Erro na migração:', e.message);
  }

  // ==================== MIGRAÇÃO: colunas extras em sniper_itens ====================
  try {
    const infoSI = db.pragma('table_info(sniper_itens)');
    const colunasSI = infoSI.map(c => c.name);
    if (!colunasSI.includes('custo')) {
      db.exec('ALTER TABLE sniper_itens ADD COLUMN custo REAL');
      console.log('[Sniper] Migração: coluna "custo" adicionada a sniper_itens');
    }
    if (!colunasSI.includes('variacaoMinima')) {
      db.exec('ALTER TABLE sniper_itens ADD COLUMN variacaoMinima REAL');
      console.log('[Sniper] Migração: coluna "variacaoMinima" adicionada a sniper_itens');
    }
    if (!colunasSI.includes('tipoVariacao')) {
      db.exec("ALTER TABLE sniper_itens ADD COLUMN tipoVariacao TEXT DEFAULT 'V'");
      console.log('[Sniper] Migração: coluna "tipoVariacao" adicionada a sniper_itens');
    }
  } catch (e) {
    console.error('[Sniper] Erro na migração:', e.message);
  }

  // Tracking da extensão
  let ultimoSyncExtensao = null; // timestamp do último POST da extensão

  // ==================== AUTH / TOKEN ====================

  /**
   * POST /api/auth/token
   * Recebe Bearer token da extensão Chrome (Token Relay).
   * Também aceita envio manual.
   */
  app.post('/api/auth/token', async (req, res) => {
    try {
      const { token, captchaToken, source } = req.body;
      if (!token) {
        return res.status(400).json({ success: false, error: 'Token obrigatório' });
      }

      const normalizedToken = token.startsWith('Bearer ') ? token : `Bearer ${token}`;

      // Validar token contra Comprasnet antes de aceitar
      const validation = await sniper.validateToken(normalizedToken);

      if (!validation.valid) {
        sniper.log(`🚫 Token REJEITADO de ${source || 'api'} (HTTP ${validation.status})`);
        return res.json({
          success: false,
          validated: false,
          error: `Token inválido (Comprasnet retornou ${validation.status})`,
          needsToken: !sniper.temToken() || sniper.tokenExpirado(),
          tokenSource: sniper.tokenSource,
          tokenAge: sniper.tokenRecebidoEm ? Math.floor(sniper.idadeTokenSegundos()) : null,
        });
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
        validated: !validation.cached,
        cached: validation.cached,
        message: 'Token recebido' + (captchaToken ? ' + captcha' : ''),
        needsToken: false,
        tokenSource: sniper.tokenSource,
        tokenAge: Math.floor(sniper.idadeTokenSegundos()),
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

  // ==================== FILA DE TAREFAS GENÉRICA (via extensão/browser) ====================
  let filaTarefas = [];  // { id, tipo, dados, status, criadoEm, processadoEm, resultado }
  let tarefaIdCounter = 0;

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

  // ==================== GUARD MODE (detecção sub-segundo) ====================
  let guardLoops = {};    // { compraId: { active, timer, itens: Set, intervalMs, iniciadoEm, ultimaClassificacao } }
  let guardStats = { totalPolls: 0, detections: 0, lancesEnqueued: 0 };

  // Parsear timestamp de Brasília (UTC-3) para Date.
  // Comprasnet retorna datas sem timezone suffix — são sempre horário de Brasília.
  function parseBrasilia(dateStr) {
    if (!dateStr) return null;
    // Se já tem timezone suffix no final (Z, +HH:MM, -HH:MM), parsear direto
    // NÃO usar includes('-0') pois match o mês/dia (ex: 2026-03-05)
    if (/Z$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(dateStr)) return new Date(dateStr);
    // Senão, é Brasília (UTC-3): adicionar sufixo
    return new Date(dateStr + '-03:00');
  }

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

  // Calcula o próximo degrau respeitando o intervalo mínimo do Comprasnet.
  // Why: Math.round em modo percentual pode arredondar PARA CIMA (ex: 2220,39 * 0,99 = 2198,1861 → 2198,19),
  // violando o intervalo mínimo exigido (Comprasnet responde 422 "Intervalo Mínimo Entre Lances").
  // Math.floor garante que o valor é estritamente abaixo do mínimo permitido pelo último lance.
  function calcularProximoDegrau(valorBase, varMin, tipoVar) {
    if (tipoVar === 'P') {
      const novo = valorBase * (1 - varMin / 100);
      return Math.floor(novo * 100) / 100;
    } else {
      const novo = valorBase - varMin;
      return Math.round(novo * 100) / 100;
    }
  }

  /**
   * A1: Pré-calcula degraus de lance para cobrir o concorrente até valorMinimo.
   * Se estamos ganhando (melhorGeral === nossoValor), retorna vazio — não concorrer consigo mesmo.
   * Se estamos perdendo, começa de melhorGeral - varMin (pula direto para cobrir).
   * Retorna array de lances prontos para enfileirar.
   */
  function calcularBatchLances(cfgItem, liveItem, compraId, maxSteps = 50, modo = 'cobrir') {
    const nossoValor = liveItem.nossoValor;
    const melhorValor = liveItem.melhorValor;
    const varMin = liveItem.variacaoMinima != null ? liveItem.variacaoMinima : cfgItem.variacaoMinima;
    const tipoVar = liveItem.tipoVariacao || 'V';
    const valorMinimo = cfgItem.valorMinimo;
    const situacao = liveItem.situacaoParticipante || liveItem.situacaoParticipanteDisputa;

    if (nossoValor == null || varMin == null || valorMinimo == null) return [];
    if (nossoValor <= valorMinimo) return [];

    // Modo sequencial: descer do nossoValor, ignorando concorrente e situação
    if (modo === 'sequencial') {
      const lances = [];
      let valorAtual = nossoValor;
      let step = 0;
      while (valorAtual > valorMinimo && step < maxSteps) {
        let novoValor = calcularProximoDegrau(valorAtual, varMin, tipoVar);
        if (novoValor < valorMinimo) novoValor = valorMinimo;
        if (novoValor >= valorAtual) break;
        step++;
        lances.push({
          id: `blitz-${Date.now()}-${step}-${Math.random().toString(36).substring(2, 5)}`,
          compraId, itemNumero: cfgItem.itemNumero, valor: novoValor,
          faseItem: cfgItem.faseItem || 'LA', criadoEm: new Date().toISOString(),
          status: 'pendente', fonte: 'blitz', batchIndex: step - 1, batchTotal: 0,
        });
        valorAtual = novoValor;
        if (novoValor <= valorMinimo) break;
      }
      for (const l of lances) l.batchTotal = lances.length;
      return lances;
    }

    // Se estamos ganhando (melhorGeral é nosso), não dar lance
    if (melhorValor != null && nossoValor <= melhorValor) return [];
    if (situacao === 'G') return [];

    // Ponto de partida: cobrir o concorrente, não descer do nosso valor
    let valorInicial;
    if (melhorValor != null && melhorValor < nossoValor) {
      // Concorrente está na frente — começar abaixo dele
      valorInicial = calcularProximoDegrau(melhorValor, varMin, tipoVar);
    } else {
      // melhorValor desconhecido — fallback para nossoValor
      valorInicial = nossoValor;
    }

    if (valorInicial < valorMinimo) valorInicial = valorMinimo;

    const lances = [];
    let valorAtual = valorInicial;
    let step = 0;

    // Primeiro lance: o valor inicial calculado (cobertura do concorrente)
    if (valorAtual > 0 && valorAtual < nossoValor) {
      // Pular se igual ao melhorValor (Comprasnet rejeita lance igual ao de outro fornecedor)
      const melhorValorRound = melhorValor != null ? Math.round(melhorValor * 100) / 100 : null;
      if (melhorValorRound == null || valorAtual !== melhorValorRound) {
        step++;
        lances.push({
          id: `blitz-${Date.now()}-${step}-${Math.random().toString(36).substring(2, 5)}`,
          compraId,
          itemNumero: cfgItem.itemNumero,
          valor: valorAtual,
          faseItem: cfgItem.faseItem || 'LA',
          criadoEm: new Date().toISOString(),
          status: 'pendente',
          fonte: 'blitz',
          batchIndex: step - 1,
          batchTotal: 0,
        });
      }
    }

    // Degraus seguintes até valorMinimo (limitado por maxSteps)
    while (valorAtual > valorMinimo && step < maxSteps) {
      let novoValor = calcularProximoDegrau(valorAtual, varMin, tipoVar);
      if (novoValor < valorMinimo) novoValor = valorMinimo;

      if (novoValor >= valorAtual) break;

      // Pular valor igual ao melhorValor
      const melhorValorRound = melhorValor != null ? Math.round(melhorValor * 100) / 100 : null;
      if (melhorValorRound != null && novoValor === melhorValorRound) {
        valorAtual = novoValor;
        continue;
      }

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
        batchTotal: 0,
      });

      valorAtual = novoValor;
      if (novoValor <= valorMinimo) break;
    }

    // Update batchTotal
    for (const l of lances) l.batchTotal = lances.length;

    return lances;
  }

  // ==================== GUARD MODE FUNCTIONS ====================

  // Rastreia mudanças no estado do mercado (melhorGeral, situação)
  // Só registra quando há mudança, não a cada poll
  let guardUltimoEstado = {}; // { 'compraId-itemNum': { melhorGeral, nossoValor, situacao } }

  function registrarEstadoMercado(compraId, apiData, fonte) {
    try {
      const insertStmt = db.prepare(
        `INSERT INTO sniper_classificacao (compraId, itemNumero, melhorGeral, nossoValor, situacao, fonte, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      );

      for (const apiItem of apiData) {
        const itemNum = apiItem.numero || apiItem.identificador;
        const melhorGeral = (apiItem.melhorValorGeral || {}).valorInformado;
        const nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado;
        const situacao = apiItem.situacaoParticipanteDisputa || null;

        const key = `${compraId}-${itemNum}`;
        const anterior = guardUltimoEstado[key];

        // Só registrar se houve mudança
        if (anterior &&
            anterior.melhorGeral === melhorGeral &&
            anterior.nossoValor === nossoValor &&
            anterior.situacao === situacao) {
          continue;
        }

        guardUltimoEstado[key] = { melhorGeral, nossoValor, situacao };
        insertStmt.run(compraId, itemNum, melhorGeral, nossoValor, situacao, fonte);
      }
    } catch (e) {
      // Best-effort
    }
  }

  function updateCacheFromGuardPoll(compraId, apiData) {
    let cached = disputasCache.disputas.find(d => d.compraId === compraId);
    if (!cached) {
      cached = { compraId, itens: [], totalItens: 0, itensAtivos: 0 };
      disputasCache.disputas.push(cached);
    }

    for (const apiItem of apiData) {
      const num = apiItem.numero || apiItem.identificador;
      let cachedItem = cached.itens.find(i => i.numero === num);
      if (!cachedItem) {
        cachedItem = { numero: num };
        cached.itens.push(cachedItem);
      }
      cachedItem.melhorValor = (apiItem.melhorValorGeral || {}).valorInformado ?? cachedItem.melhorValor;
      cachedItem.nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado ?? cachedItem.nossoValor;
      cachedItem.variacaoMinima = apiItem.variacaoMinimaEntreLances ?? cachedItem.variacaoMinima;
      cachedItem.tipoVariacao = apiItem.tipoVariacaoMinimaEntreLances || cachedItem.tipoVariacao || 'V';
      cachedItem.podeEnviar = apiItem.podeEnviarLances ?? cachedItem.podeEnviar;
      cachedItem.fase = apiItem.fase || cachedItem.fase;
      cachedItem.fimContagem = apiItem.dataHoraFimContagem || cachedItem.fimContagem;
      cachedItem.situacaoParticipante = apiItem.situacaoParticipanteDisputa || null;
      cachedItem.estaPerdendo = apiItem.situacaoParticipanteDisputa === 'P';
      cachedItem.emEncAleatoria = (apiItem.situacaoAposContagem === 'EA');
      cachedItem.nosDoisMinFinais = !!(apiItem.dataHoraFimContagem && (parseBrasilia(apiItem.dataHoraFimContagem).getTime() - Date.now()) < 120000);
    }

    cached.totalItens = cached.itens.length;
    cached.itensAtivos = cached.itens.filter(i => i.podeEnviar || i.fase === 'LA').length;
    disputasCache.atualizadoEm = new Date().toISOString();
  }

  async function guardPoll(compraId) {
    const guard = guardLoops[compraId];
    if (!guard || !guard.active) return;

    // Token check
    if (!sniper.temToken()) {
      logAuto(`GUARD ${compraId}: sem token, pausa 5s`);
      guard.timer = setTimeout(() => guardPoll(compraId), 5000);
      return;
    }

    const inicio = Date.now();
    try {
      const { status, data } = await sniper.apiGet(
        `/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`
      );
      const elapsed = Date.now() - inicio;
      guardStats.totalPolls++;

      if (status !== 200 && status !== 206) {
        logAuto(`GUARD ${compraId}: HTTP ${status} (${elapsed}ms)`);
        guard.timer = setTimeout(() => guardPoll(compraId), 2000);
        return;
      }

      if (!Array.isArray(data) || data.length === 0) {
        guard.timer = setTimeout(() => guardPoll(compraId), guard.intervalMs);
        return;
      }

      // Atualizar cache com dados frescos
      updateCacheFromGuardPoll(compraId, data);

      // Registrar mudanças no estado do mercado
      registrarEstadoMercado(compraId, data, 'guard');

      // Buscar config dos itens monitorados
      const autoItens = db.prepare(
        `SELECT compraId, itemNumero, valorMinimo, variacaoMinima, tipoVariacao, faseItem
         FROM sniper_itens WHERE compraId = ? AND modoAuto = 'continuo' AND valorMinimo IS NOT NULL`
      ).all(compraId);

      // Auto-stop: remover itens onde disputa fechou
      let anyActive = false;
      for (const itemNum of [...guard.itens]) {
        const apiItem = data.find(i => (i.numero || i.identificador) === itemNum);
        if (apiItem && apiItem.podeEnviarLances) {
          anyActive = true;
        } else if (apiItem && !apiItem.podeEnviarLances) {
          guard.itens.delete(itemNum);
          logAuto(`GUARD: item ${itemNum} disputa fechou, removido`);
        }
      }
      if (!anyActive || guard.itens.size === 0) {
        pararGuard(compraId, null);
        return;
      }

      // Verificar cada item monitorado
      for (const cfgItem of autoItens) {
        if (!guard.itens.has(cfgItem.itemNumero)) continue;

        const apiItem = data.find(i => (i.numero || i.identificador) === cfgItem.itemNumero);
        if (!apiItem) continue;

        const sit = apiItem.situacaoParticipanteDisputa;
        const melhorGeral = (apiItem.melhorValorGeral || {}).valorInformado;
        const nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado;
        const varMin = apiItem.variacaoMinimaEntreLances;
        const tipoVar = apiItem.tipoVariacaoMinimaEntreLances || 'V';

        if (sit === 'P' && melhorGeral != null && varMin != null) {
          // Perdendo — calcular lance reativo
          let novoValor = calcularProximoDegrau(melhorGeral, varMin, tipoVar);

          // Respeitar piso
          if (novoValor < cfgItem.valorMinimo) novoValor = cfgItem.valorMinimo;
          // Já no piso
          if (nossoValor != null && nossoValor <= cfgItem.valorMinimo) continue;
          // Valor não melhora
          if (nossoValor != null && novoValor >= nossoValor) continue;
          // Pular valor igual ao melhorGeral (Comprasnet rejeita)
          const melhorGeralRound = Math.round(melhorGeral * 100) / 100;
          if (novoValor === melhorGeralRound) {
            // Tentar um degrau a mais
            novoValor = calcularProximoDegrau(novoValor, varMin, tipoVar);
            if (novoValor < cfgItem.valorMinimo) continue;
          }

          // Não duplicar na fila
          const jaEnfileirado = filaLances.some(l =>
            l.compraId === compraId && l.itemNumero === cfgItem.itemNumero &&
            (l.status === 'pendente' || l.status === 'processando')
          );
          if (jaEnfileirado) continue;

          // Não interferir com blitz em execução (últimos 5s)
          const blitzKey = `${compraId}-${cfgItem.itemNumero}`;
          const blitzRecente = blitzDisparados[blitzKey];
          if (blitzRecente && (Date.now() - blitzRecente) < 5000) continue;

          guardStats.detections++;
          autoLanceStats.lancesEnviados++;

          logAuto(`⚡ GUARD DETECTED: ${compraId} item ${cfgItem.itemNumero} sit=P — ` +
            `lance R$${novoValor.toFixed(2)} DIRETO (melhor=R$${melhorGeral}, nosso=R$${nossoValor}, var=${varMin}, ${elapsed}ms)`);

          // Enviar direto pelo servidor (async, não bloqueia o loop)
          sniper.enviarLance(compraId, cfgItem.itemNumero, novoValor, cfgItem.faseItem || 'LA').then(resultado => {
            const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
            try { db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, cfgItem.itemNumero, novoValor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'guard-servidor', new Date().toISOString()); } catch (e) {}
            guardStats.lancesEnqueued++;
            if (resultado.sucesso) logAuto(`⚡ GUARD OK: ${compraId} item ${cfgItem.itemNumero} R$${novoValor.toFixed(2)} (${resultado.tempoMs}ms)`);
            else logAuto(`⚡ GUARD FALHA: ${compraId} item ${cfgItem.itemNumero} HTTP ${resultado.status}`);
          }).catch(() => {});
        }
      }

      // Intervalo adaptativo: se API demorou >500ms, desacelerar
      const nextInterval = elapsed > 500 ? 500 : guard.intervalMs;
      guard.timer = setTimeout(() => guardPoll(compraId), nextInterval);

    } catch (e) {
      logAuto(`GUARD ${compraId}: erro ${e.message}`);
      guard.timer = setTimeout(() => guardPoll(compraId), 2000);
    }
  }

  function iniciarGuard(compraId, itemNumero) {
    if (!guardLoops[compraId]) {
      guardLoops[compraId] = {
        active: true,
        timer: null,
        itens: new Set(),
        intervalMs: 200,
        iniciadoEm: new Date().toISOString(),
      };
      logAuto(`⚡ GUARD START: ${compraId} (polling ${200}ms)`);
      guardPoll(compraId);
    }
    guardLoops[compraId].itens.add(itemNumero);
  }

  function pararGuard(compraId, itemNumero) {
    const guard = guardLoops[compraId];
    if (!guard) return;

    if (itemNumero != null) {
      guard.itens.delete(itemNumero);
    }

    if (guard.itens.size === 0 || itemNumero == null) {
      guard.active = false;
      if (guard.timer) { clearTimeout(guard.timer); guard.timer = null; }
      delete guardLoops[compraId];
      logAuto(`GUARD STOP: ${compraId}`);
    }
  }

  function pararTodosGuards() {
    for (const compraId of Object.keys(guardLoops)) {
      pararGuard(compraId, null);
    }
  }

  /**
   * Busca itens de uma compra diretamente da API Comprasnet e popula o cache.
   * Usado como fallback quando a extensão não sincronizou os dados.
   * Usa /qtdes primeiro (leve) para decidir qual endpoint chamar.
   */
  let fetchDirectoCooldown = {}; // { compraId: timestamp } — evita spam na API
  async function fetchItensDirecto(compraId) {
    // Cooldown de 60s por compra
    if (fetchDirectoCooldown[compraId] && (Date.now() - fetchDirectoCooldown[compraId]) < 60000) return null;
    fetchDirectoCooldown[compraId] = Date.now();

    if (!sniper.temToken()) return null;

    // Passo 1: /qtdes para detectar fase (chamada leve)
    let qtdes = null;
    try {
      const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${compraId}/itens/qtdes`);
      if (status === 200 || status === 206) qtdes = data;
    } catch (e) {}

    // Se /qtdes mostra 0 itens em disputa, não vale buscar itens detalhados
    if (qtdes && qtdes.qtdeItensEmDisputa === 0 && qtdes.qtdeItensAguardandoDisputa === 0) {
      logAuto(`Fetch direto: ${compraId} sem itens em disputa (qtdes: disputa=${qtdes.qtdeItensEmDisputa}, encerrada=${qtdes.qtdeItensComDisputaEncerrada})`);
      // Atualizar faseCompra no banco se tudo encerrado
      if (qtdes.qtdeItensComDisputaEncerrada > 0 && qtdes.qtdeItensEmDisputa === 0 && qtdes.qtdeItensAguardandoDisputa === 0) {
        try {
          db.prepare(`UPDATE participacoes_comprasnet SET faseCompra = '4', dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ? AND faseCompra = '3'`).run(compraId);
        } catch (e) {}
      }
      return null;
    }

    // Passo 2: escolher endpoint baseado em /qtdes
    const endpoints = [];
    if (qtdes && qtdes.qtdeItensEmDisputa > 0) {
      endpoints.push(`/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`);
    }
    // Fallbacks
    endpoints.push(`/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`);
    endpoints.push(`/comprasnet-disputa/v1/compras/${compraId}/itens`);

    // Deduplica
    const uniqueEndpoints = [...new Set(endpoints)];

    for (const path of uniqueEndpoints) {
      try {
        const { status, data } = await sniper.apiGet(path);
        if ((status === 200 || status === 206) && Array.isArray(data) && data.length > 0) {
          // Derivar flags direto da resposta (filtro=3,4,5 não funciona para fornecedor)
          const itens = data.map(i => {
            const num = i.numero || i.identificador;
            return {
              numero: num,
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
              estaPerdendo: i.situacaoParticipanteDisputa === 'P',
              emEncAleatoria: (i.situacaoAposContagem === 'EA'),
              nosDoisMinFinais: !!(i.dataHoraFimContagem && (parseBrasilia(i.dataHoraFimContagem).getTime() - Date.now()) < 120000),
            };
          });
          const disputaData = {
            compraId,
            totalItens: itens.length,
            itensAtivos: itens.filter(i => i.podeEnviar || i.fase === 'LA').length,
            itens,
            qtdes, // guardar dados do /qtdes no cache
          };
          const idx = disputasCache.disputas.findIndex(d => d.compraId === compraId);
          if (idx >= 0) {
            disputasCache.disputas[idx] = { ...disputasCache.disputas[idx], ...disputaData };
          } else {
            disputasCache.disputas.push(disputaData);
          }
          disputasCache.atualizadoEm = new Date().toISOString();
          // Registrar estado do mercado
          registrarEstadoMercado(compraId, data, 'fetch-direto');
          logAuto(`Fetch direto OK: ${compraId} — ${itens.length} itens (${disputaData.itensAtivos} ativos)`);
          return disputaData;
        }
      } catch (e) { /* tentar próximo */ }
    }
    return null;
  }

  /**
   * Core loop: checks all items with modoAuto set and enqueues bids when losing.
   * @param {boolean} modoRapido - If true, only processes compras in autoLanceComprasFast
   */
  async function executarCicloAutoLance(modoRapido = false) {
    try {
      // Query DB for compras with auto items
      const autoItens = db.prepare(
        `SELECT si.compraId, si.itemNumero, si.valorMinimo, si.valorLance, si.modoAuto, si.faseItem, si.antecedenciaMs, si.variacaoMinima, si.tipoVariacao
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
          let cached = disputasCache.disputas.find(d => d.compraId === compraId);
          if (!cached || !cached.itens || cached.itens.length === 0) {
            // Fallback: buscar direto da API Comprasnet
            const direto = await fetchItensDirecto(compraId);
            if (direto) {
              cached = direto;
            } else {
              if (logDiag) logAuto(`Cache vazio: ${compraId} (extensão não sincronizou, fetch direto falhou ou em cooldown)`);
              continue;
            }
          }

          const itensAuto = porCompra[compraId];

          for (const cfgItem of itensAuto) {
            let liveItem = cached.itens.find(i => i.numero === cfgItem.itemNumero);
            if (!liveItem) {
              // Grupo fallback: sub-items (1,2,3) inherit data from grupo (-1)
              const grupoItem = cached.itens.find(i => i.numero === -1 || i.tipo === 'G');
              if (grupoItem) {
                // Get last known nossoValor from successful lance history
                let ultimoValor = null;
                try {
                  const lastLance = db.prepare(
                    `SELECT valor FROM sniper_historico WHERE compraId = ? AND itemNumero = ? AND sucesso = 1 ORDER BY rowid DESC LIMIT 1`
                  ).get(compraId, cfgItem.itemNumero);
                  if (lastLance) ultimoValor = parseFloat(lastLance.valor);
                } catch (e) {}
                // Fallback: use valorLance from config
                if (ultimoValor == null && cfgItem.valorLance != null) {
                  ultimoValor = parseFloat(cfgItem.valorLance);
                }

                liveItem = {
                  numero: cfgItem.itemNumero,
                  tipo: 'S',
                  melhorValor: null,
                  nossoValor: ultimoValor,
                  variacaoMinima: grupoItem.variacaoMinima,
                  tipoVariacao: grupoItem.tipoVariacao,
                  fimContagem: grupoItem.fimContagem,
                  podeEnviar: grupoItem.podeEnviar,
                  fase: grupoItem.fase,
                  estaPerdendo: grupoItem.estaPerdendo || false,
                  emEncAleatoria: grupoItem.emEncAleatoria || false,
                  nosDoisMinFinais: grupoItem.nosDoisMinFinais || false,
                  sintetico: true,
                };
                // Persist synthetic sub-item to cache so resultado-lance can find and update it
                cached.itens.push(liveItem);
                if (logDiag) logAuto(`Item ${cfgItem.itemNumero} sintético (grupo) nosso=${ultimoValor} var=${grupoItem.variacaoMinima}`);
              } else {
                if (logDiag) logAuto(`Item ${cfgItem.itemNumero} não no cache de ${compraId} (${cached.itens.length} itens: ${cached.itens.slice(0,5).map(i=>i.numero).join(',')})`);
                continue;
              }
            }

            const melhorGeral = liveItem.melhorValor;
            const nossoValor = liveItem.nossoValor;
            const varMin = liveItem.variacaoMinima;
            const tipoVar = liveItem.tipoVariacao || 'V';
            const fimContagem = liveItem.fimContagem;
            const podeEnviar = liveItem.podeEnviar;

            // Filter flags do Comprasnet
            const estaPerdendo = !!liveItem.estaPerdendo;
            const emEncAleatoria = !!liveItem.emEncAleatoria;
            const nosDoisMinFinais = !!liveItem.nosDoisMinFinais;

            if (!podeEnviar) {
              if (logDiag) logAuto(`Item ${cfgItem.itemNumero}: podeEnviar=false fase=${liveItem.fase||'?'}`);
              continue;
            }

            // Log filtros do Comprasnet quando ativos
            if (logDiag && (estaPerdendo || emEncAleatoria || nosDoisMinFinais)) {
              const flags = [estaPerdendo && 'PERDENDO', emEncAleatoria && 'ENC.ALEATORIA', nosDoisMinFinais && '2MIN'].filter(Boolean).join(' ');
              logAuto(`Item ${cfgItem.itemNumero}: [${flags}]`);
            }

            // Check countdown for sniper mode
            let segRestantes = null;
            if (fimContagem) {
              segRestantes = Math.floor((parseBrasilia(fimContagem).getTime() - Date.now()) / 1000);
            }

            // Sniper mode: only act in last N seconds (configurable via antecedenciaMs, default 60s)
            // nosDoisMinFinais do Comprasnet serve como gatilho adicional (mais confiável que cálculo de clock)
            if (cfgItem.modoAuto === 'sniper') {
              const sniperSeg = Math.round((cfgItem.antecedenciaMs || 60000) / 1000);
              const dentroJanela = (segRestantes != null && segRestantes <= sniperSeg && segRestantes > 0);
              const gatilho2min = nosDoisMinFinais && sniperSeg >= 120;
              if (!dentroJanela && !gatilho2min) continue;
              // Fast polling when approaching sniper window
              if ((segRestantes != null && segRestantes < sniperSeg + 30 && segRestantes > 0) || nosDoisMinFinais) {
                autoLanceComprasFast[compraId] = true;
              }
            }

            // nosDoisMinFinais: ativar fast polling mesmo em modo contínuo
            if (nosDoisMinFinais) {
              autoLanceComprasFast[compraId] = true;
            }

            // emEncAleatoria: ativar ultra-fast timer (1s) — pode fechar a qualquer momento
            if (emEncAleatoria) {
              autoLanceComprasFast[compraId] = true;
              if (!autoLanceTimerUltra) {
                autoLanceTimerUltra = setInterval(() => executarCicloAutoLance(true), 1000);
                logAuto(`ULTRA-FAST timer ativado (1s) — item ${cfgItem.itemNumero} em ENC.ALEATÓRIA`);
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
            // EXCETO se Comprasnet diz que estamos perdendo (cache stale)
            if (nossoValor != null && melhorGeral != null && nossoValor <= melhorGeral && !estaPerdendo) continue;

            // Need valorMinimo to know where to bid
            if (cfgItem.valorMinimo == null) continue;

            // Already at our floor
            if (nossoValor != null && nossoValor <= cfgItem.valorMinimo) continue;

            // A2: BLITZ MODE — sniper with batch pre-calculation
            const blitzKey = `${compraId}-${cfgItem.itemNumero}`;
            if (cfgItem.modoAuto === 'sniper' && segRestantes != null && segRestantes > 0 && !blitzDisparados[blitzKey]) {
              // Calculate batch
              const batchLances = calcularBatchLances(cfgItem, liveItem, compraId, 50);
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

            // Check if already in filaLances (pendente or processando)
            const jaEnfileirado = filaLances.some(l =>
              l.compraId === compraId &&
              l.itemNumero === cfgItem.itemNumero &&
              (l.status === 'pendente' || l.status === 'processando')
            );
            if (jaEnfileirado) continue;

            // MODO CONTÍNUO: lance único reativo — envia UM degrau por vez, espera resultado, re-avalia
            if (cfgItem.modoAuto === 'continuo') {
              // Contínuo sempre entra no fast polling (para setImmediate pós-lance funcionar)
              autoLanceComprasFast[compraId] = true;
              // Não enviar sem dados reais do Comprasnet (stub = extensão não sincronizou)
              if (!cached || cached.stub) {
                if (logDiag) logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — aguardando sync (dados stub)`);
                continue;
              }
              // Não enviar se disputa já encerrou
              if (fimContagem) {
                const segRest = Math.floor((parseBrasilia(fimContagem).getTime() - Date.now()) / 1000);
                if (segRest < -60) { // margem de 60s por clock drift
                  if (logDiag) logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — disputa encerrada há ${Math.abs(segRest)}s`);
                  continue;
                }
              }
              // Precisa de nossoValor e variacaoMinima reais para calcular degraus
              // Fallback varMin: usar campo da config do item (sniper_itens.variacaoMinima)
              let varMinEfetivo = varMin;
              let tipoVarEfetivo = tipoVar;
              if (varMinEfetivo == null && cfgItem.variacaoMinima != null) {
                varMinEfetivo = parseFloat(cfgItem.variacaoMinima);
                tipoVarEfetivo = cfgItem.tipoVariacao || 'V';
              }

              if (nossoValor == null || varMinEfetivo == null) {
                // Grupo sub-item: enviar valorLance como primeiro lance (só se nossoValor desconhecido)
                if (liveItem.sintetico && nossoValor == null && cfgItem.valorLance != null && cfgItem.valorLance > 0) {
                  const initVal = parseFloat(cfgItem.valorLance);
                  if (initVal >= cfgItem.valorMinimo) {
                    autoLanceStats.lancesEnviados++;
                    logAuto(`CONTÍNUO INIT DIRETO: ${compraId} item ${cfgItem.itemNumero} — R$${initVal.toFixed(2)} (primeiro lance grupo)`);
                    sniper.enviarLance(compraId, cfgItem.itemNumero, initVal, cfgItem.faseItem || 'LA').then(r => {
                      const rs = typeof r.resposta === 'string' ? r.resposta.substring(0, 1500) : (r.resposta ? JSON.stringify(r.resposta).substring(0, 1500) : '');
                      try { db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, cfgItem.itemNumero, initVal, r.status, r.sucesso ? 1 : 0, r.tempoMs, rs, 'continuo-servidor', new Date().toISOString()); } catch (e) {}
                    }).catch(() => {});
                    continue;
                  }
                }
                if (logDiag) logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — dados insuficientes (nosso=${nossoValor}, var=${varMinEfetivo})`);
                continue;
              }

              // Não dar lance se estamos GANHANDO — guard mode vigia e reage em <270ms
              if (!estaPerdendo) {
                iniciarGuard(compraId, cfgItem.itemNumero);
                if (logDiag) logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — ganhando, GUARD ativo (nosso=R$${nossoValor.toFixed(2)})`);
                continue;
              }

              // Batch sizing inteligente: calcular quantos passos até superar melhorGeral
              let stepsNeeded;
              if (melhorGeral != null && nossoValor > melhorGeral) {
                let vCalc = nossoValor;
                stepsNeeded = 0;
                while (vCalc >= melhorGeral && stepsNeeded < 50) {
                  vCalc = calcularProximoDegrau(vCalc, varMinEfetivo, tipoVarEfetivo);
                  stepsNeeded++;
                }
                stepsNeeded += 2; // margem de segurança
              } else {
                stepsNeeded = 5; // melhorGeral desconhecido → batch pequeno
              }
              const BATCH_SIZE = Math.min(Math.max(stepsNeeded, 3), 50);
              let v = nossoValor;
              let batchCount = 0;
              const melhorGeralRound = melhorGeral != null ? Math.round(melhorGeral * 100) / 100 : null;

              while (batchCount < BATCH_SIZE) {
                let novoValor = calcularProximoDegrau(v, varMinEfetivo, tipoVarEfetivo);
                if (novoValor < cfgItem.valorMinimo) novoValor = cfgItem.valorMinimo;
                if (novoValor >= v) break; // sem espaço para baixar

                // Pular valor igual ao melhor geral (Comprasnet rejeita)
                if (melhorGeralRound != null && novoValor === melhorGeralRound) {
                  v = novoValor;
                  continue; // skip this value but keep going
                }

                if (novoValor <= 0) break;

                // Enviar direto pelo servidor (async em background)
                const _cid = compraId, _inum = cfgItem.itemNumero, _nv = novoValor, _fi = cfgItem.faseItem || 'LA';
                sniper.enviarLance(_cid, _inum, _nv, _fi).then(r => {
                  const rs = typeof r.resposta === 'string' ? r.resposta.substring(0, 1500) : (r.resposta ? JSON.stringify(r.resposta).substring(0, 1500) : '');
                  try { db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(_cid, _inum, _nv, r.status, r.sucesso ? 1 : 0, r.tempoMs, rs, 'continuo-servidor', new Date().toISOString()); } catch (e) {}
                }).catch(() => {});
                autoLanceStats.lancesEnviados++;
                batchCount++;
                v = novoValor;
                if (novoValor <= cfgItem.valorMinimo) break; // atingiu mínimo
              }

              if (batchCount > 0) {
                const primeiro = calcularProximoDegrau(nossoValor, varMinEfetivo, tipoVarEfetivo);
                const flagsStr = [estaPerdendo && 'PERDENDO', emEncAleatoria && 'ENC.ALEATORIA', nosDoisMinFinais && '2MIN'].filter(Boolean).join(' ');
                logAuto(`CONTÍNUO BATCH: ${compraId} item ${cfgItem.itemNumero} — ${batchCount} lances R$${primeiro.toFixed(2)}→R$${v.toFixed(2)} ` +
                  `(nosso=R$${nossoValor.toFixed(2)}, var ${tipoVarEfetivo}=${varMinEfetivo}, min=R$${cfgItem.valorMinimo})` +
                  `${flagsStr ? ' [' + flagsStr + ']' : ''}`);
              }
              continue;
            }

            // Fallback: lance único (primeiro lance sem nossoValor, ou caso especial)
            let novoLance;
            if (nossoValor != null && varMin != null) {
              novoLance = calcularProximoDegrau(nossoValor, varMin, tipoVar);
            } else if (nossoValor == null && cfgItem.valorLance != null && cfgItem.valorLance > 0) {
              novoLance = parseFloat(cfgItem.valorLance);
            } else {
              continue;
            }

            if (novoLance < cfgItem.valorMinimo) novoLance = cfgItem.valorMinimo;

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
            autoLanceStats.lancesEnviados++;
            liveItem.nossoValor = novoLance;

            const logMelhor = melhorGeral != null ? `melhor R$${melhorGeral.toFixed(2)}` : 'sem melhor';
            const flagsStr = [estaPerdendo && 'PERDENDO', emEncAleatoria && 'ENC.ALEATORIA', nosDoisMinFinais && '2MIN'].filter(Boolean).join(' ');
            logAuto(`LANCE: ${compraId} item ${cfgItem.itemNumero} — ${logMelhor}, nosso R$${(nossoValor||0).toFixed(2)} → R$${novoLance.toFixed(2)} (var ${tipoVar}=${varMin}, modo=${cfgItem.modoAuto})${flagsStr ? ' [' + flagsStr + ']' : ''}`);
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
    pararTodosGuards();
    logAuto('Engine DESLIGADO');
  }

  // A3: Auto-cleanup ultra timer when no items near end or in encerramento aleatório
  function verificarUltraTimer() {
    if (!autoLanceTimerUltra) return;
    // Check if any item is still < 30s from end OR in encerramento aleatório
    let precisaUltra = false;
    for (const d of disputasCache.disputas) {
      if (!d.itens) continue;
      for (const item of d.itens) {
        if (item.emEncAleatoria) { precisaUltra = true; break; }
        if (item.fimContagem) {
          const seg = Math.floor((parseBrasilia(item.fimContagem).getTime() - Date.now()) / 1000);
          if (seg > 0 && seg < 30) { precisaUltra = true; break; }
        }
      }
      if (precisaUltra) break;
    }
    if (!precisaUltra) {
      clearInterval(autoLanceTimerUltra);
      autoLanceTimerUltra = null;
      logAuto('ULTRA-FAST timer desativado (nenhum item próximo do fim ou em enc.aleatória)');
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
      if (!sniper.temToken()) return res.status(400).json({ success: false, error: 'Sem Bearer token' });

      // Enviar direto pelo servidor
      const resultado = await sniper.enviarLance(compraId, parseInt(itemNumero), parseFloat(valor), faseItem || 'LA');
      const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
      try {
        db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, parseInt(itemNumero), parseFloat(valor), resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'manual-servidor', new Date().toISOString());
      } catch (dbErr) {}

      console.log(`[Sniper] 🎯 Lance direto: ${compraId} item ${itemNumero} R$${parseFloat(valor).toFixed(2)} — ${resultado.sucesso ? 'OK' : 'FALHA ' + resultado.status} (${resultado.tempoMs}ms)`);

      res.json({ success: resultado.sucesso, via: 'servidor', resultado, tempoMs: resultado.tempoMs });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/disparar-blitz
   * Disparo manual da rajada blitz — calcula batch e enfileira lances REAIS.
   * Permite testar o modo sniper a qualquer momento, sem esperar o timer automático.
   */
  // Blitz agendadas: { 'compraId-itemNumero': { timer, horario, compraId, itemNumero, totalLances } }
  var blitzAgendadas = {};

  app.post('/api/sniper/disparar-blitz', (req, res) => {
    try {
      const { compraId, itemNumero, horario, maxLances, modoBlitz } = req.body;
      if (!compraId || itemNumero == null) {
        return res.status(400).json({ success: false, error: 'compraId e itemNumero obrigatórios' });
      }

      // Ler config do item
      const cfgItem = db.prepare('SELECT * FROM sniper_itens WHERE compraId = ? AND itemNumero = ?').get(compraId, parseInt(itemNumero));
      if (!cfgItem || !cfgItem.valorMinimo) {
        return res.status(400).json({ success: false, error: 'Item sem valorMinimo configurado' });
      }

      // Ler dados live do cache de disputas
      const cached = disputasCache.disputas.find(d => d.compraId === compraId);
      const liveItem = cached && cached.itens ? cached.itens.find(i => i.numero === parseInt(itemNumero)) : null;

      // Para agendamento futuro, não exigir cache agora — será lido na hora do disparo
      if (!horario) {
        if (!cached || !cached.itens) {
          return res.status(400).json({ success: false, error: 'Sem dados de disputa no cache. Aguarde sync da extensão.' });
        }
        if (!liveItem) {
          return res.status(400).json({ success: false, error: `Item ${itemNumero} não encontrado no cache de disputas` });
        }
        if (liveItem.nossoValor == null) {
          return res.status(400).json({ success: false, error: 'nossoValor desconhecido para este item' });
        }
      }

      // Verificar se já tem lances pendentes para este item
      const jaEnfileirado = filaLances.some(l =>
        l.compraId === compraId &&
        l.itemNumero === parseInt(itemNumero) &&
        (l.status === 'pendente' || l.status === 'processando')
      );
      if (jaEnfileirado) {
        return res.status(409).json({ success: false, error: 'Já existem lances pendentes para este item' });
      }

      // Função que calcula e envia lances DIRETO pelo servidor (sem Electron)
      const executarBlitz = async () => {
        let cachedAgora = disputasCache.disputas.find(d => d.compraId === compraId);
        let liveItemAgora = cachedAgora && cachedAgora.itens ? cachedAgora.itens.find(i => i.numero === parseInt(itemNumero)) : null;

        // Se faltam dados críticos (tipoVariacao) — provavelmente extensão antiga que não envia o campo —
        // puxar direto da API para evitar calcular com fallback 'V' errado
        if (liveItemAgora && liveItemAgora.tipoVariacao == null && sniper.temToken()) {
          try {
            const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`);
            if ((status === 200 || status === 206) && Array.isArray(data)) {
              const apiItem = data.find(i => (i.numero || i.identificador) === parseInt(itemNumero));
              if (apiItem) {
                liveItemAgora.variacaoMinima = apiItem.variacaoMinimaEntreLances ?? liveItemAgora.variacaoMinima;
                liveItemAgora.tipoVariacao = apiItem.tipoVariacaoMinimaEntreLances || liveItemAgora.tipoVariacao;
                liveItemAgora.melhorValor = (apiItem.melhorValorGeral || {}).valorInformado ?? liveItemAgora.melhorValor;
                liveItemAgora.nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado ?? liveItemAgora.nossoValor;
                liveItemAgora.situacaoParticipante = apiItem.situacaoParticipanteDisputa || liveItemAgora.situacaoParticipante;
                logAuto(`🔄 BLITZ refresh: ${compraId} item ${itemNumero} — varMin=${liveItemAgora.variacaoMinima} tipo=${liveItemAgora.tipoVariacao} nosso=${liveItemAgora.nossoValor}`);
              }
            }
          } catch (e) {
            logAuto(`⚠️ BLITZ refresh falhou: ${e.message}`);
          }
        }

        const itemAtual = liveItemAgora || liveItem;
        if (!itemAtual || itemAtual.nossoValor == null) {
          console.log(`[Sniper] 🚀 BLITZ: ${compraId} item ${itemNumero} — sem dados live, abortando`);
          logAuto(`🚀 BLITZ: ${compraId} item ${itemNumero} — sem dados live, abortando`);
          return 0;
        }

        const itemParaCalculo = {
          ...itemAtual,
          variacaoMinima: itemAtual.variacaoMinima != null ? itemAtual.variacaoMinima : cfgItem.variacaoMinima,
          tipoVariacao: itemAtual.tipoVariacao || cfgItem.tipoVariacao || 'V',
        };

        const batchLances = calcularBatchLances(cfgItem, itemParaCalculo, compraId, maxLances || 50, modoBlitz || 'cobrir');
        if (batchLances.length === 0) {
          const dbg = `nosso=${itemParaCalculo.nossoValor} melhor=${itemParaCalculo.melhorValor} varMin=${itemParaCalculo.variacaoMinima} valMin=${cfgItem.valorMinimo} sit=${itemParaCalculo.situacaoParticipante} modo=${modoBlitz||'cobrir'}`;
          console.log(`[Sniper] 🚀 BLITZ: ${compraId} item ${itemNumero} — 0 lances (${dbg})`);
          logAuto(`🚀 BLITZ: ${compraId} item ${itemNumero} — 0 lances (${dbg})`);
          return 0;
        }

        const blitzKey = `${compraId}-${parseInt(itemNumero)}`;
        blitzDisparados[blitzKey] = Date.now();
        delete blitzAgendadas[blitzKey];
        try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(blitzKey); } catch (e) {}

        const valorInicial = itemParaCalculo.nossoValor.toFixed(2);
        const valorFinal = batchLances[batchLances.length - 1].valor.toFixed(2);
        console.log(`[Sniper] 🚀 BLITZ DIRETO: ${compraId} item ${itemNumero} — ${batchLances.length} lances (R$${valorInicial} → R$${valorFinal}) varMin=${itemParaCalculo.variacaoMinima}`);
        logAuto(`🚀 BLITZ DIRETO: ${compraId} item ${itemNumero} — ${batchLances.length} lances (R$${valorInicial} → R$${valorFinal})`);

        // Enviar lances direto pelo servidor
        let sucessos = 0, falhas = 0;
        for (const lance of batchLances) {
          try {
            const resultado = await sniper.enviarLance(compraId, parseInt(itemNumero), lance.valor, lance.faseItem || 'LA');
            // Salvar no histórico
            const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
            try {
              db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, parseInt(itemNumero), lance.valor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'blitz-servidor', new Date().toISOString());
            } catch (dbErr) {}

            if (resultado.sucesso) {
              sucessos++;
            } else {
              falhas++;
              if (resultado.status === 422) break; // Item rejeitado, parar
              if (resultado.status === 401) break; // Token inválido
            }
          } catch (e) {
            falhas++;
            break;
          }
        }

        itemAtual.nossoValor = batchLances[batchLances.length - 1].valor;
        console.log(`[Sniper] 🚀 BLITZ DIRETO resultado: ${compraId} item ${itemNumero} — ${sucessos} ✅ ${falhas} ❌`);
        logAuto(`🚀 BLITZ DIRETO: ${compraId} item ${itemNumero} — ${sucessos} ✅ ${falhas} ❌`);

        iniciarGuard(compraId, parseInt(itemNumero));
        return sucessos;
      };

      // Se horário foi especificado, agendar em vez de disparar imediatamente
      if (horario) {
        const agora = new Date();
        const partes = horario.split(':');
        const hh = parseInt(partes[0]) || 0;
        const mm = parseInt(partes[1]) || 0;
        const secParts = (partes[2] || '0').split('.');
        const ss = parseInt(secParts[0]) || 0;
        const ms = parseInt((secParts[1] || '0').padEnd(3, '0').substring(0, 3)) || 0;
        const alvo = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), hh, mm, ss, ms);
        // Usar relógio calibrado com Comprasnet (compensa offset)
        const delayMs = alvo.getTime() - sniper.tempoServidorAgora();

        if (delayMs < -5000) {
          return res.status(400).json({ success: false, error: `Horário ${horario} já passou (agora: ${agora.toTimeString().slice(0,8)}, offset: ${sniper.offsetServidorMs}ms)` });
        }

        const blitzKey = `${compraId}-${parseInt(itemNumero)}`;

        // Cancelar agendamento anterior se existir
        if (blitzAgendadas[blitzKey]) {
          clearTimeout(blitzAgendadas[blitzKey].timer);
        }

        const alvoMs = alvo.getTime();
        // Recalibrar 30s antes do disparo
        if (delayMs > 35000) {
          setTimeout(() => {
            sniper.calibrarTempo()
              .then(r => console.log(`[Sniper] Recalibração pré-blitz: offset=${r.offset}ms`))
              .catch(() => {});
          }, delayMs - 30000);
        }

        // Warmup 1s antes — aquece conexões TLS
        if (delayMs > 2000) {
          setTimeout(() => {
            Promise.all([
              sniper.apiGet('/comprasnet-disputa/v1/datahorabrasilia').catch(() => {}),
              sniper.apiGet('/comprasnet-disputa/v1/datahorabrasilia').catch(() => {}),
              sniper.apiGet('/comprasnet-disputa/v1/datahorabrasilia').catch(() => {}),
            ]);
          }, delayMs - 1000);
        }

        // Disparo direto no momento exato (calibrado com Comprasnet)
        const timer = setTimeout(async () => {
          const agoraMs = Date.now();
          const desvioMs = Math.round(sniper.tempoServidorAgora() - alvoMs);
          const d = new Date(agoraMs); const horaReal = d.toTimeString().slice(0,8) + '.' + String(d.getMilliseconds()).padStart(3,'0');
          console.log(`[Sniper] ⏰ BLITZ DIRETO disparando: ${compraId} item ${itemNumero} — alvo=${horario} real=${horaReal} desvio=${desvioMs}ms (offset=${sniper.offsetServidorMs}ms)`);
          logAuto(`⏰ BLITZ DIRETO: ${compraId} item ${itemNumero} — desvio=${desvioMs}ms`);
          await executarBlitz();
        }, Math.max(0, delayMs));

        blitzAgendadas[blitzKey] = { timer, horario, compraId, itemNumero: parseInt(itemNumero), maxLances: maxLances || 50, modoBlitz: modoBlitz || 'cobrir', agendadoEm: agora.toISOString() };

        // Persistir no banco para sobreviver a restart do servidor
        try {
          db.prepare(`INSERT OR REPLACE INTO blitz_agendadas
            (blitzKey, compraId, itemNumero, horario, alvoMs, maxLances, modoBlitz, agendadoEm)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(blitzKey, compraId, parseInt(itemNumero), horario, alvoMs, maxLances || 50, modoBlitz || 'cobrir', agora.toISOString());
        } catch (e) { console.warn('[BLITZ] persist falhou:', e.message); }

        console.log(`[Sniper] ⏰ BLITZ AGENDADA: ${compraId} item ${itemNumero} para ${horario} (em ${Math.round(delayMs/1000)}s)`);
        logAuto(`⏰ BLITZ AGENDADA: ${compraId} item ${itemNumero} para ${horario} (em ${Math.round(delayMs/1000)}s)`);

        return res.json({
          success: true,
          agendado: true,
          horario,
          maxLances: maxLances || 50,
          delayMs,
          message: `Blitz agendada para ${horario} (em ${Math.round(delayMs/1000)}s)`,
        });
      }

      // Disparo imediato — direto pelo servidor
      const itemParaCalculo = {
        ...liveItem,
        variacaoMinima: liveItem.variacaoMinima != null ? liveItem.variacaoMinima : cfgItem.variacaoMinima,
        tipoVariacao: liveItem.tipoVariacao || cfgItem.tipoVariacao || 'V',
      };

      const batchLances = calcularBatchLances(cfgItem, itemParaCalculo, compraId, maxLances || 50, modoBlitz || 'cobrir');
      if (batchLances.length === 0) {
        return res.json({ success: true, totalLances: 0, message: 'Nenhum lance a enviar (já no mínimo ou sem variação)' });
      }

      const blitzKey = `${compraId}-${parseInt(itemNumero)}`;
      blitzDisparados[blitzKey] = Date.now();

      console.log(`[Sniper] 🚀 BLITZ DIRETO: ${compraId} item ${itemNumero} — ${batchLances.length} lances (R$${itemParaCalculo.nossoValor.toFixed(2)} → R$${batchLances[batchLances.length - 1].valor.toFixed(2)})`);
      logAuto(`🚀 BLITZ DIRETO: ${compraId} item ${itemNumero} — ${batchLances.length} lances`);

      // Enviar em background (não bloquear response)
      setImmediate(async () => {
        let sucessos = 0, falhas = 0;
        for (const lance of batchLances) {
          try {
            const resultado = await sniper.enviarLance(compraId, parseInt(itemNumero), lance.valor, lance.faseItem || 'LA');
            const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
            try {
              db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, parseInt(itemNumero), lance.valor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'blitz-servidor', new Date().toISOString());
            } catch (dbErr) {}
            if (resultado.sucesso) { sucessos++; } else { falhas++; if (resultado.status === 422 || resultado.status === 401) break; }
          } catch (e) { falhas++; break; }
        }
        liveItem.nossoValor = batchLances[batchLances.length - 1].valor;
        console.log(`[Sniper] 🚀 BLITZ DIRETO resultado: ${compraId} item ${itemNumero} — ${sucessos} ✅ ${falhas} ❌`);
        iniciarGuard(compraId, parseInt(itemNumero));
      });

      res.json({
        success: true,
        totalLances: batchLances.length,
        via: 'servidor',
        lances: batchLances.map(l => ({ id: l.id, valor: l.valor, batchIndex: l.batchIndex })),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Cancelar blitz agendada
  app.post('/api/sniper/cancelar-blitz', (req, res) => {
    const { compraId, itemNumero } = req.body;
    const blitzKey = `${compraId}-${parseInt(itemNumero)}`;
    const agendada = blitzAgendadas[blitzKey];
    if (!agendada) {
      return res.json({ success: false, error: 'Nenhuma blitz agendada para este item' });
    }
    // Só cancelar o timer se nenhum outro item compartilha ele
    const timer = agendada.timer;
    delete blitzAgendadas[blitzKey];
    try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(blitzKey); } catch (e) {}
    const outrosUsam = Object.values(blitzAgendadas).some(b => b.timer === timer);
    if (!outrosUsam && timer) clearTimeout(timer);
    logAuto(`❌ BLITZ CANCELADA: ${compraId} item ${itemNumero} (era para ${agendada.horario})`);
    res.json({ success: true, message: `Blitz cancelada (era para ${agendada.horario})` });
  });

  // Agendar lance único para horário específico
  var lancesAgendados = {};

  app.post('/api/sniper/agendar-lance', (req, res) => {
    try {
      const { compraId, itemNumero, valor, horario } = req.body;
      if (!compraId || itemNumero == null || !valor || !horario) {
        return res.status(400).json({ success: false, error: 'compraId, itemNumero, valor e horario obrigatórios' });
      }

      const agora = new Date();
      let h = horario;
      if (h.length === 5) h += ':00.500';
      else if (h.length === 8) h += '.500';

      const partes = h.split(':');
      const hh = parseInt(partes[0]) || 0;
      const mm = parseInt(partes[1]) || 0;
      const secParts = (partes[2] || '0').split('.');
      const ss = parseInt(secParts[0]) || 0;
      const ms = parseInt((secParts[1] || '0').padEnd(3, '0').substring(0, 3)) || 0;
      const alvo = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), hh, mm, ss, ms);
      const delayMs = alvo.getTime() - agora.getTime();

      if (delayMs < 0) {
        return res.status(400).json({ success: false, error: `Horário ${horario} já passou (agora: ${agora.toTimeString().slice(0,8)})` });
      }

      const lanceKey = `${compraId}-${parseInt(itemNumero)}`;

      if (lancesAgendados[lanceKey]) {
        clearTimeout(lancesAgendados[lanceKey].timer);
      }

      const alvoMs = alvo.getTime();
      const valorFloat = parseFloat(valor);
      // Usar relógio calibrado
      const delayCalibrado = alvoMs - sniper.tempoServidorAgora();
      const timer = setTimeout(async () => {
        const desvioMs = Math.round(sniper.tempoServidorAgora() - alvoMs);
        console.log(`[Sniper] ⏰ LANCE AGENDADO DIRETO: ${compraId} item ${itemNumero} R$${valorFloat.toFixed(2)} — alvo=${h} desvio=${desvioMs}ms`);
        logAuto(`⏰ LANCE AGENDADO DIRETO: ${compraId} item ${itemNumero} R$${valorFloat.toFixed(2)} — desvio=${desvioMs}ms`);

        try {
          const resultado = await sniper.enviarLance(compraId, parseInt(itemNumero), valorFloat, 'LA');
          const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
          db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, parseInt(itemNumero), valorFloat, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'agendado-servidor', new Date().toISOString());
          console.log(`[Sniper] ⏰ LANCE AGENDADO: ${resultado.sucesso ? '✅' : '❌'} R$${valorFloat.toFixed(2)} (${resultado.tempoMs}ms)`);
        } catch (e) {
          console.error(`[Sniper] ⏰ LANCE AGENDADO erro: ${e.message}`);
        }
        delete lancesAgendados[lanceKey];
      }, Math.max(0, delayCalibrado));

      lancesAgendados[lanceKey] = { timer, horario: h, compraId, itemNumero: parseInt(itemNumero), valor: valorFloat, agendadoEm: agora.toISOString() };

      console.log(`[Sniper] ⏰ LANCE AGENDADO: ${compraId} item ${itemNumero} R$${valorFloat.toFixed(2)} para ${h} (em ${Math.round(delayMs/1000)}s)`);
      logAuto(`⏰ LANCE AGENDADO: ${compraId} item ${itemNumero} R$${valorFloat.toFixed(2)} para ${h} (em ${Math.round(delayMs/1000)}s)`);

      res.json({ success: true, horario: h, valor: valorFloat, delayMs, message: `Lance R$${valorFloat.toFixed(2)} agendado para ${h} (em ${Math.round(delayMs/1000)}s)` });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sniper/cancelar-lance-agendado', (req, res) => {
    const { compraId, itemNumero } = req.body;
    const lanceKey = `${compraId}-${parseInt(itemNumero)}`;
    const agendado = lancesAgendados[lanceKey];
    if (!agendado) {
      return res.json({ success: false, error: 'Nenhum lance agendado para este item' });
    }
    clearTimeout(agendado.timer);
    delete lancesAgendados[lanceKey];
    logAuto(`❌ LANCE CANCELADO: ${compraId} item ${itemNumero} R$${agendado.valor.toFixed(2)} (era para ${agendado.horario})`);
    res.json({ success: true, message: `Lance cancelado (era para ${agendado.horario})` });
  });

  /**
   * POST /api/sniper/blitz-global
   * Agenda blitz para TODOS os itens com valorMinimo de todas as compras em disputa.
   */
  app.post('/api/sniper/blitz-global', (req, res) => {
    try {
      const { horario, modoBlitz, maxLancesDefault, milesimoAlvo } = req.body;
      if (!horario) return res.status(400).json({ success: false, error: 'Horário obrigatório' });

      // Calcular milésimo automaticamente se não informado
      // Usa latência medida e número de lances para acertar o milésimo alvo (~900)
      const agora = new Date();
      const partes = horario.split(':');
      const hh = parseInt(partes[0]) || 0, mm = parseInt(partes[1]) || 0;
      const secParts = (partes[2] || '0').split('.');
      const ss = parseInt(secParts[0]) || 0;
      let msInput = secParts[1] ? parseInt((secParts[1] || '0').padEnd(3, '0').substring(0, 3)) : -1; // -1 = não informado

      // Buscar itens elegíveis ANTES do auto-cálculo (precisa do maxLances)
      const itensElegiveis = db.prepare(`
        SELECT si.compraId, si.itemNumero, si.valorMinimo, si.faseItem, si.variacaoMinima, si.tipoVariacao, si.maxLances
        FROM sniper_itens si
        JOIN participacoes_comprasnet pc ON si.compraId = pc.compraId
        WHERE si.valorMinimo IS NOT NULL AND si.valorMinimo > 0
          AND pc.ativo = 1 AND pc.faseCompra = '3' AND pc.situacao IN ('PD', 'AB', '5')
        ORDER BY si.compraId, si.itemNumero
      `).all();

      if (itensElegiveis.length === 0) {
        return res.json({ success: false, error: 'Nenhum item elegível (sem valorMinimo ou sem compra em disputa)' });
      }

      let msCalculado = null;
      const milesimoTarget = milesimoAlvo || 970;

      if (msInput < 0) {
        // Calcular automaticamente com valores calibrados
        const oneWay = 76;          // mediana RTT/2
        const rttMediana = 153;     // mediana RTT (para 1 item sequencial)
        const intervaloRR = 157;    // mediana entre rodadas round-robin (2+ itens)
        const bufferSpike = 30;     // compensar jitter residual

        // maxLances: usar o do item (ignorar itens sem configuração no cálculo)
        const lancesConfigurados = itensElegiveis.map(i => i.maxLances).filter(m => m > 0);
        const maxLancesReal = lancesConfigurados.length > 0
          ? Math.max(...lancesConfigurados)
          : (maxLancesDefault || 5);
        const numRodadas = maxLancesReal - 1;

        // Intervalo depende de quantos itens: 1 item = RTT puro, 2+ = round-robin
        const numItens = itensElegiveis.length;
        const intervalo = numItens > 1 ? intervaloRR : rttMediana;
        const duracaoTotal = oneWay + (numRodadas * intervalo) + bufferSpike;

        msCalculado = milesimoTarget - duracaoTotal;
        // Se negativo (rajada > 1s), começar no segundo anterior
        let ssAjustado = ss;
        if (msCalculado < 0) {
          ssAjustado = ss - 1;
          msCalculado = 1000 + msCalculado;
        }
        if (ssAjustado < 0) { ssAjustado = 59; }

        msInput = Math.max(0, Math.round(msCalculado));
        console.log(`[BLITZ-GLOBAL] Auto-cálculo: alvo=${milesimoTarget}ms, oneWay=${oneWay}ms, intervalo=${intervalo}ms, rodadas=${numRodadas}, duração=${duracaoTotal}ms → milésimo=${msInput} (segundo=${ssAjustado})`);

        // Reconstruir partes com segundo ajustado
        partes[2] = String(ssAjustado);
      }

      const ms = Math.max(0, msInput);
      const alvo = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), hh, mm, parseInt(partes[2]) || ss, ms);
      const delayMs = alvo.getTime() - sniper.tempoServidorAgora();
      if (delayMs < -5000) return res.status(400).json({ success: false, error: `Horário ${horario} já passou` });

      const horarioEfetivo = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(parseInt(partes[2])||ss).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;

      const agendados = [];
      const erros = [];
      const modo = modoBlitz || 'sequencial';
      const alvoMs = alvo.getTime();

      const agendadosList = [];

      for (const item of itensElegiveis) {
        const blitzKey = `${item.compraId}-${item.itemNumero}`;
        if (blitzAgendadas[blitzKey]) clearTimeout(blitzAgendadas[blitzKey].timer);
        const jaEnfileirado = filaLances.some(l =>
          l.compraId === item.compraId && l.itemNumero === item.itemNumero &&
          (l.status === 'pendente' || l.status === 'processando')
        );
        if (jaEnfileirado) { erros.push(`${item.compraId} item ${item.itemNumero}: já tem lances pendentes`); continue; }
        agendadosList.push(item);
        const itemMaxLances = item.maxLances || maxLancesDefault || 5;
        agendados.push({ compraId: item.compraId, itemNumero: item.itemNumero, maxLances: itemMaxLances });
        blitzAgendadas[blitzKey] = { timer: null, horario, compraId: item.compraId, itemNumero: item.itemNumero, maxLances: itemMaxLances, modoBlitz: modo, agendadoEm: agora.toISOString() };
        // Persistir no banco para sobreviver a restart
        try {
          db.prepare(`INSERT OR REPLACE INTO blitz_agendadas
            (blitzKey, compraId, itemNumero, horario, alvoMs, maxLances, modoBlitz, agendadoEm)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(blitzKey, item.compraId, item.itemNumero, horario, alvoMs, itemMaxLances, modo, agora.toISOString());
        } catch (e) { console.warn('[BLITZ-GLOBAL] persist falhou:', e.message); }
      }

      if (agendadosList.length === 0) {
        return res.json({ success: false, error: erros.length > 0 ? erros.join('; ') : 'Nenhum item elegível' });
      }

      // Helper: enviar lances de um item sequencialmente e salvar no histórico
      const enviarLancesItem = async (compraId, itemNumero, batchLances) => {
        let sucessos = 0, falhas = 0;
        for (const lance of batchLances) {
          try {
            const resultado = await sniper.enviarLance(compraId, itemNumero, lance.valor, lance.faseItem || 'LA');
            const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
            try { db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, itemNumero, lance.valor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'blitz-servidor', new Date().toISOString()); } catch (e) {}
            if (resultado.sucesso) { sucessos++; } else { falhas++; if (resultado.status === 422 || resultado.status === 401) break; }
          } catch (e) { falhas++; break; }
        }
        return { sucessos, falhas };
      };

      // Recalibrar 30s antes do disparo para offset mais preciso
      if (delayMs > 35000) {
        setTimeout(() => {
          sniper.calibrarTempo()
            .then(r => console.log(`[BLITZ-GLOBAL] Recalibração pré-disparo: offset=${r.offset}ms, latência=${r.latencia}ms`))
            .catch(() => {});
        }, delayMs - 30000);
      }

      // Warmup 1s antes — aquece N+2 conexões TLS paralelas (extras para compensar interferência)
      if (delayMs > 2000) {
        const numConexoes = agendadosList.length + 2;
        setTimeout(() => {
          const warmups = Array.from({ length: numConexoes }, () =>
            sniper.apiGet('/comprasnet-disputa/v1/datahorabrasilia').catch(() => {})
          );
          Promise.all(warmups)
            .then(() => console.log(`[BLITZ-GLOBAL] Warmup ${numConexoes}x TLS OK`))
            .catch(() => {});
        }, delayMs - 1000);
      }

      // Guard pré-blitz: ativa 3s antes para detectar qualquer mudança do concorrente
      // no último instante. Guard respeita blitzDisparados para não duplicar durante a rajada.
      if (delayMs > 3000) {
        setTimeout(() => {
          for (const item of agendadosList) {
            iniciarGuard(item.compraId, item.itemNumero);
          }
          logAuto(`🛡️ GUARD pré-blitz ativado para ${agendadosList.length} item(ns) — 3s antes do disparo`);
        }, delayMs - 3000);
      } else {
        // Blitz muito próxima — ativar guard imediatamente
        for (const item of agendadosList) {
          iniciarGuard(item.compraId, item.itemNumero);
        }
      }

      // Um único timer para TODOS os itens
      const timer = setTimeout(async () => {
        const desvioMs = Math.round(sniper.tempoServidorAgora() - alvoMs);
        console.log(`[BLITZ-GLOBAL] DIRETO disparando ${agendadosList.length} itens — desvio=${desvioMs}ms (offset=${sniper.offsetServidorMs}ms)`);
        logAuto(`⏰ BLITZ-GLOBAL DIRETO: ${agendadosList.length} itens — desvio=${desvioMs}ms`);

        // Calcular batches para todos os itens
        const itensBatches = [];
        for (const item of agendadosList) {
          const blitzKey = `${item.compraId}-${item.itemNumero}`;
          const cached = disputasCache.disputas.find(d => d.compraId === item.compraId);
          const liveItem = cached && cached.itens ? cached.itens.find(i => i.numero === item.itemNumero) : null;
          if (!liveItem || liveItem.nossoValor == null) continue;

          // Refresh direto da API se faltar tipoVariacao (extensão antiga que não envia o campo)
          if (liveItem.tipoVariacao == null && sniper.temToken()) {
            try {
              const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${item.compraId}/itens/em-disputa`);
              if ((status === 200 || status === 206) && Array.isArray(data)) {
                const apiItem = data.find(i => (i.numero || i.identificador) === item.itemNumero);
                if (apiItem) {
                  liveItem.variacaoMinima = apiItem.variacaoMinimaEntreLances ?? liveItem.variacaoMinima;
                  liveItem.tipoVariacao = apiItem.tipoVariacaoMinimaEntreLances || liveItem.tipoVariacao;
                  liveItem.melhorValor = (apiItem.melhorValorGeral || {}).valorInformado ?? liveItem.melhorValor;
                  liveItem.nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado ?? liveItem.nossoValor;
                  liveItem.situacaoParticipante = apiItem.situacaoParticipanteDisputa || liveItem.situacaoParticipante;
                  logAuto(`🔄 BLITZ-GLOBAL refresh: ${item.compraId} item ${item.itemNumero} — varMin=${liveItem.variacaoMinima} tipo=${liveItem.tipoVariacao} nosso=${liveItem.nossoValor}`);
                }
              }
            } catch (e) {
              logAuto(`⚠️ BLITZ-GLOBAL refresh falhou: ${e.message}`);
            }
          }

          const itemParaCalculo = {
            ...liveItem,
            variacaoMinima: liveItem.variacaoMinima != null ? liveItem.variacaoMinima : item.variacaoMinima,
            tipoVariacao: liveItem.tipoVariacao || item.tipoVariacao || 'V',
          };
          const itemMaxLances = item.maxLances || maxLancesDefault || 5;
          const batchLances = calcularBatchLances(item, itemParaCalculo, item.compraId, itemMaxLances, modo);
          if (batchLances.length === 0) continue;
          blitzDisparados[blitzKey] = Date.now();
          delete blitzAgendadas[blitzKey];
          try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(blitzKey); } catch (e) {}
          const vi = itemParaCalculo.nossoValor.toFixed(2);
          const vf = batchLances[batchLances.length - 1].valor.toFixed(2);
          console.log(`[BLITZ-GLOBAL] DIRETO: ${item.compraId} item ${item.itemNumero} — ${batchLances.length} lances (R$${vi} → R$${vf})`);
          itensBatches.push({ compraId: item.compraId, itemNumero: item.itemNumero, batchLances, liveItem });
        }

        if (itensBatches.length === 0) return;

        // Round-robin paralelo: cada rodada envia 1 lance de cada item via Promise.all
        const maxRodadas = Math.max(...itensBatches.map(ib => ib.batchLances.length));
        const itemFalhou = new Set(); // itens que falharam (422/401) — skip nas próximas rodadas
        const itemOk = {};
        const itemFalha = {};
        for (const ib of itensBatches) { itemOk[ib.compraId + '-' + ib.itemNumero] = 0; itemFalha[ib.compraId + '-' + ib.itemNumero] = 0; }

        for (let rodada = 0; rodada < maxRodadas; rodada++) {
          // Coletar 1 lance de cada item ativo nesta rodada
          const lancesRodada = [];
          for (const ib of itensBatches) {
            const key = ib.compraId + '-' + ib.itemNumero;
            if (itemFalhou.has(key)) continue;
            if (rodada >= ib.batchLances.length) continue;
            lancesRodada.push({ ib, lance: ib.batchLances[rodada], key });
          }
          if (lancesRodada.length === 0) break;

          // Promise.all: todos os itens desta rodada simultaneamente
          const resultados = await Promise.all(lancesRodada.map(({ ib, lance, key }) =>
            sniper.enviarLance(ib.compraId, ib.itemNumero, lance.valor, lance.faseItem || 'LA')
              .then(r => ({ key, ib, lance, resultado: r }))
              .catch(e => ({ key, ib, lance, resultado: { sucesso: false, status: 0, resposta: e.message, tempoMs: 0 } }))
          ));

          // Processar resultados da rodada
          for (const { key, ib, lance, resultado } of resultados) {
            const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
            try { db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ib.compraId, ib.itemNumero, lance.valor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'blitz-servidor', new Date().toISOString()); } catch (e) {}
            if (resultado.sucesso) {
              itemOk[key]++;
            } else {
              itemFalha[key]++;
              if (resultado.status === 422 || resultado.status === 401) itemFalhou.add(key);
            }
          }
        }

        // Log resultados e cleanup
        for (const ib of itensBatches) {
          const key = ib.compraId + '-' + ib.itemNumero;
          ib.liveItem.nossoValor = ib.batchLances[ib.batchLances.length - 1].valor;
          console.log(`[BLITZ-GLOBAL] DIRETO resultado: ${ib.compraId} item ${ib.itemNumero} — ${itemOk[key]} ✅ ${itemFalha[key]} ❌`);
          iniciarGuard(ib.compraId, ib.itemNumero);
        }
      }, Math.max(0, delayMs));

      // Registrar timer único no blitzAgendadas (para cancelamento)
      for (const item of agendadosList) {
        const blitzKey = `${item.compraId}-${item.itemNumero}`;
        if (blitzAgendadas[blitzKey]) blitzAgendadas[blitzKey].timer = timer;
      }

      console.log(`[BLITZ-GLOBAL] ${agendados.length} itens agendados para ${horarioEfetivo} (modo: ${modo})${msCalculado !== null ? ' [auto-calc]' : ''}`);
      res.json({
        success: agendados.length > 0,
        message: `${agendados.length} itens agendados para ${horarioEfetivo}${msCalculado !== null ? ' (auto)' : ''}`,
        agendados, erros: erros.length > 0 ? erros : undefined,
        horario: horarioEfetivo, modoBlitz: modo,
        autoCalc: msCalculado !== null ? { milesimoAlvo: milesimoTarget, milesimoCalculado: ms } : undefined,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Status das blitz agendadas
  app.get('/api/sniper/blitz-agendadas', (req, res) => {
    const lista = Object.values(blitzAgendadas).map(b => ({
      compraId: b.compraId,
      itemNumero: b.itemNumero,
      horario: b.horario,
      maxLances: b.maxLances || 50,
      modoBlitz: b.modoBlitz || 'cobrir',
      agendadoEm: b.agendadoEm,
    }));
    res.json({ success: true, agendadas: lista });
  });

  /**
   * GET /api/sniper/fila-lances
   * Retorna lances pendentes (para extensão processar).
   */
  app.get('/api/sniper/fila-lances', (req, res) => {
    // Limpar lances travados em 'processando' há mais de 30s (extensão não respondeu)
    const agora = Date.now();
    for (let i = filaLances.length - 1; i >= 0; i--) {
      const l = filaLances[i];
      if (l.status === 'processando' && l.processandoDesde) {
        const timeout = (l.fonte === 'auto-continuo' || l.fonte === 'guard') ? 10000 : 60000;
        if (agora - l.processandoDesde > timeout) {
          filaLances.splice(i, 1);
        }
      }
    }

    // Só entregar lances cujo fireAt já chegou (ou sem fireAt)
    const pendentes = filaLances.filter(l => l.status === 'pendente' && (!l.fireAt || l.fireAt <= agora));
    // Marcar como "processando" com timestamp
    pendentes.forEach(l => { l.status = 'processando'; l.processandoDesde = agora; });

    // A4: Determine poll interval — fast when contínuo/guard/blitz has pending lances or blitz imminent
    let pollIntervalMs = 5000; // default
    const temFastPendente = filaLances.some(l =>
      (l.fonte === 'auto-continuo' || l.fonte === 'guard' || l.fonte === 'blitz' || l.fonte === 'agendado') &&
      (l.status === 'pendente' || l.status === 'processando')
    );
    // Blitz iminente (< 10s): extensão deve estar pronta para pegar lances instantaneamente
    let blitzIminente = false;
    for (const bk in blitzAgendadas) {
      const b = blitzAgendadas[bk];
      if (b.horario) {
        const agr = new Date();
        const [hh2, mm2, ss2] = b.horario.split(':').map(Number);
        const alvo2 = new Date(agr.getFullYear(), agr.getMonth(), agr.getDate(), hh2, mm2, ss2 || 0);
        if (alvo2.getTime() - agr.getTime() < 30000 && alvo2.getTime() - agr.getTime() > -5000) {
          blitzIminente = true;
          break;
        }
      }
    }
    // Lance agendado iminente (< 30s)
    let lanceAgendadoIminente = false;
    for (const lk in lancesAgendados) {
      const la = lancesAgendados[lk];
      if (la.horario) {
        const agr2 = new Date();
        const parts2 = la.horario.split(':');
        const hh3 = parseInt(parts2[0]) || 0, mm3 = parseInt(parts2[1]) || 0;
        const secP2 = (parts2[2] || '0').split('.'); const ss3 = parseInt(secP2[0]) || 0;
        const alvo3 = new Date(agr2.getFullYear(), agr2.getMonth(), agr2.getDate(), hh3, mm3, ss3);
        if (alvo3.getTime() - agr2.getTime() < 30000 && alvo3.getTime() - agr2.getTime() > -5000) {
          lanceAgendadoIminente = true;
          break;
        }
      }
    }
    if (temFastPendente || blitzIminente || lanceAgendadoIminente || pendentes.some(l => l.fonte === 'auto-continuo' || l.fonte === 'guard' || l.fonte === 'blitz' || l.fonte === 'agendado')) {
      pollIntervalMs = 200; // tight loop
    } else {
      for (const d of disputasCache.disputas) {
        if (!d.itens) continue;
        for (const item of d.itens) {
          if (item.fimContagem) {
            const seg = Math.floor((parseBrasilia(item.fimContagem).getTime() - Date.now()) / 1000);
            if (seg > 0 && seg < 60) { pollIntervalMs = 1000; break; }
          }
        }
        if (pollIntervalMs === 1000) break;
      }
    }

    // Incluir info de blitz agendadas para extensão criar alarms precisos
    var proximaBlitz = null;
    for (var bk in blitzAgendadas) {
      var b = blitzAgendadas[bk];
      if (b.horario) {
        var agr = new Date();
        var [hh, mm, ss] = b.horario.split(':').map(Number);
        var alvo = new Date(agr.getFullYear(), agr.getMonth(), agr.getDate(), hh, mm, ss || 0);
        var diffMs = alvo.getTime() - agr.getTime();
        if (diffMs > 0 && (!proximaBlitz || diffMs < proximaBlitz.diffMs)) {
          proximaBlitz = { horario: b.horario, diffMs, timestamp: alvo.getTime() };
        }
      }
    }

    // Incluir info de lances agendados (similar a blitz)
    var proximoLanceAgendado = null;
    for (var lk in lancesAgendados) {
      var la = lancesAgendados[lk];
      if (la.horario) {
        var agr3 = new Date();
        var parts3 = la.horario.split(':');
        var hh4 = parseInt(parts3[0])||0, mm4 = parseInt(parts3[1])||0;
        var secP3 = (parts3[2]||'0').split('.'); var ss4 = parseInt(secP3[0])||0;
        var alvo4 = new Date(agr3.getFullYear(), agr3.getMonth(), agr3.getDate(), hh4, mm4, ss4);
        var diffMs4 = alvo4.getTime() - agr3.getTime();
        if (diffMs4 > 0 && (!proximoLanceAgendado || diffMs4 < proximoLanceAgendado.diffMs)) {
          proximoLanceAgendado = { horario: la.horario, diffMs: diffMs4, timestamp: alvo4.getTime() };
        }
      }
    }

    res.json({ success: true, lances: pendentes, total: filaLances.length, pollIntervalMs, proximaBlitz, proximoLanceAgendado });
  });

  /**
   * POST /api/sniper/log
   * Recebe logs da extensão (idle dialogs, erros, eventos).
   */
  app.post('/api/sniper/log', (req, res) => {
    const { tipo, msg, detalhes } = req.body;
    const entry = `[EXT:${tipo || 'info'}] ${msg || ''}`;
    sniper.log(entry);
    logAuto(entry);
    console.log(`[Extensão] ${entry}`, detalhes ? JSON.stringify(detalhes).substring(0, 200) : '');
    res.json({ success: true });
  });

  /**
   * SNIPER-C05: helper compartilhado para processar um resultado de lance.
   * Extraído de /resultado-lance (single) e /resultado-lances-batch (loop) para
   * eliminar ~200 linhas de duplicação. Retorna { sucesso, isContinuo, fonteOriginal }
   * para orquestração pelo caller (trigger reativo do ciclo auto-lance).
   */
  function processarResultadoLance(r) {
    const { id, compraId, itemNumero, valor, status, sucesso, resposta, tempoMs, enviadoMs, recebidoMs } = r;

    // 1. Atualizar na fila + recuperar fonte original
    const idx = filaLances.findIndex(l => l.id === id);
    let fonteOriginal = 'browser';
    if (idx >= 0) {
      fonteOriginal = filaLances[idx].fonte || 'browser';
      filaLances[idx].status = sucesso ? 'sucesso' : 'falha';
      filaLances[idx].httpStatus = status;
      filaLances[idx].resposta = resposta;
      filaLances[idx].tempoMs = tempoMs;
      filaLances[idx].processadoEm = new Date().toISOString();
    }

    // 2. Histórico recente (in-memory)
    resultadosLances.unshift({
      id, compraId, itemNumero, valor, status, sucesso, resposta, tempoMs,
      timestamp: new Date().toISOString(),
      fonte: fonteOriginal,
    });
    if (resultadosLances.length > 50) resultadosLances.pop();

    // 3. Log
    const fonteTag = fonteOriginal !== 'browser' ? ' [' + fonteOriginal.toUpperCase() + ']' : ' (browser)';
    const envIso = enviadoMs ? new Date(enviadoMs).toISOString().substring(11, 23) : '?';
    const recIso = recebidoMs ? new Date(recebidoMs).toISOString().substring(11, 23) : '?';
    const hasTiming = enviadoMs || recebidoMs;
    if (sucesso) {
      sniper.log(hasTiming
        ? `🎯✅ LANCE${fonteTag}! R$ ${parseFloat(valor).toFixed(2)} item ${itemNumero} HTTP ${status} (${tempoMs}ms) env=${envIso} rec=${recIso}`
        : `🎯✅ LANCE ENVIADO${fonteTag}! R$ ${parseFloat(valor).toFixed(2)} item ${itemNumero} (${tempoMs}ms)`);
    } else {
      sniper.log(hasTiming
        ? `🎯❌ Lance falhou${fonteTag}: HTTP ${status} item ${itemNumero} (${tempoMs}ms) env=${envIso} rec=${recIso}`
        : `🎯❌ Lance falhou${fonteTag}: HTTP ${status} item ${itemNumero} (${tempoMs}ms) — ${String(resposta || '').substring(0, 100)}`);
    }

    // 4. Sniper historico in-memory
    sniper.historico.unshift({ compraId, itemNumero, valor, status, sucesso, tempoMs, timestamp: new Date().toISOString(), fonte: fonteOriginal });
    if (sniper.historico.length > 50) sniper.historico.pop();

    // 5. Persist
    try {
      const respostaStr = typeof resposta === 'string' ? resposta.substring(0, 1500) : (resposta ? JSON.stringify(resposta).substring(0, 1500) : '');
      if (hasTiming) {
        db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp, enviadoEm, recebidoEm)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            compraId, itemNumero, valor, status, sucesso ? 1 : 0, tempoMs || 0, respostaStr, fonteOriginal, new Date().toISOString(),
            enviadoMs ? new Date(enviadoMs).toISOString() : null,
            recebidoMs ? new Date(recebidoMs).toISOString() : null);
      } else {
        db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, itemNumero, valor, status, sucesso ? 1 : 0, tempoMs || 0, respostaStr, fonteOriginal, new Date().toISOString());
      }
      db.prepare(`UPDATE sniper_itens SET status = ?, ultimoResultado = ?, ultimoEnvio = CURRENT_TIMESTAMP, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE compraId = ? AND itemNumero = ?`).run(sucesso ? 'enviado' : 'erro', `HTTP ${status} (${tempoMs}ms)`, compraId, itemNumero);
    } catch (dbErr) { console.error('[Sniper] Erro salvando no banco:', dbErr.message); }

    // 6. disputasCache update
    if (compraId && itemNumero != null) {
      const cachedD = disputasCache.disputas.find(d => d.compraId === compraId);
      if (cachedD && cachedD.itens) {
        if (sucesso) {
          let cachedItem = cachedD.itens.find(i => i.numero === parseInt(itemNumero));
          if (cachedItem) {
            cachedItem.nossoValor = parseFloat(valor);
          } else {
            const grupoItem = cachedD.itens.find(i => i.numero === -1 || i.tipo === 'G');
            if (grupoItem) {
              cachedD.itens.push({
                numero: parseInt(itemNumero), tipo: 'S', melhorValor: null,
                nossoValor: parseFloat(valor), variacaoMinima: grupoItem.variacaoMinima,
                tipoVariacao: grupoItem.tipoVariacao, fimContagem: grupoItem.fimContagem,
                podeEnviar: grupoItem.podeEnviar, fase: grupoItem.fase,
                estaPerdendo: false, emEncAleatoria: grupoItem.emEncAleatoria || false,
                nosDoisMinFinais: grupoItem.nosDoisMinFinais || false,
              });
              console.log(`[Sniper] Cache: added sub-item ${itemNumero} to grupo ${compraId} nosso=R$${valor}`);
            }
          }
        } else if (status === 422 && resposta && String(resposta).includes('melhor que seu')) {
          const tentado = parseFloat(valor);
          let cachedItem = cachedD.itens.find(i => i.numero === parseInt(itemNumero));
          if (cachedItem) {
            if (cachedItem.nossoValor == null || tentado < cachedItem.nossoValor) {
              console.log(`[Sniper] Cache: 422 "melhor que seu" — ajustando nossoValor item ${itemNumero} de R$${cachedItem.nossoValor} para R$${tentado}`);
              cachedItem.nossoValor = tentado;
            }
          } else {
            const grupoItem = cachedD.itens.find(i => i.numero === -1 || i.tipo === 'G');
            if (grupoItem) {
              cachedD.itens.push({
                numero: parseInt(itemNumero), tipo: 'S', melhorValor: null,
                nossoValor: tentado, variacaoMinima: grupoItem.variacaoMinima,
                tipoVariacao: grupoItem.tipoVariacao, fimContagem: grupoItem.fimContagem,
                podeEnviar: grupoItem.podeEnviar, fase: grupoItem.fase,
                estaPerdendo: false, emEncAleatoria: grupoItem.emEncAleatoria || false,
                nosDoisMinFinais: grupoItem.nosDoisMinFinais || false,
              });
              console.log(`[Sniper] Cache: 422 — criado sub-item ${itemNumero} com nosso=R$${tentado}`);
            }
          }
        }

        // Propagar estaPerdendo reativamente após lance bem-sucedido
        if (sucesso) {
          const grupoItem = cachedD.itens.find(i => i.numero === -1 || i.tipo === 'G');
          if (grupoItem && grupoItem.melhorValor != null && grupoItem.nossoValor != null) {
            const ganhando = grupoItem.nossoValor <= grupoItem.melhorValor;
            cachedD.itens.forEach(i => { i.estaPerdendo = !ganhando; });
          }
        }
      }

      // GUARD MODE: após lance contínuo/guard aceito, ativar guard
      if (sucesso) {
        const cfgGuard = db.prepare(
          'SELECT modoAuto, valorMinimo FROM sniper_itens WHERE compraId = ? AND itemNumero = ?'
        ).get(compraId, parseInt(itemNumero));
        if (cfgGuard && cfgGuard.modoAuto === 'continuo' && cfgGuard.valorMinimo != null) {
          iniciarGuard(compraId, parseInt(itemNumero));
        }
      }
    }

    // 7. Cooldown/fila cleanup
    const pendingKey = `${compraId}-${itemNumero}`;
    const lanceObj = idx >= 0 ? filaLances[idx] : null;
    const isBatchFonte = lanceObj && (lanceObj.fonte === 'blitz' || lanceObj.fonte === 'auto-continuo' || lanceObj.fonte === 'guard');
    if (sucesso) {
      if (isBatchFonte) delete autoLancePendentes[pendingKey];
      else autoLancePendentes[pendingKey] = Date.now();
    } else {
      delete autoLancePendentes[pendingKey];
    }

    const isContinuo = lanceObj && (lanceObj.fonte === 'auto-continuo' || lanceObj.fonte === 'guard');
    if (isContinuo) {
      const i2 = filaLances.findIndex(l => l.id === id);
      if (i2 >= 0) filaLances.splice(i2, 1);
    } else {
      setTimeout(() => {
        const i = filaLances.findIndex(l => l.id === id);
        if (i >= 0) filaLances.splice(i, 1);
      }, isBatchFonte ? 5000 : 30000);
    }

    return { sucesso, isContinuo, fonteOriginal };
  }

  /**
   * POST /api/sniper/resultado-lance
   * Recebe resultado do lance enviado pela extensão.
   */
  app.post('/api/sniper/resultado-lance', (req, res) => {
    try {
      const r = req.body || {};
      const { sucesso, isContinuo } = processarResultadoLance(r);

      console.log(`[Sniper] Lance resultado: ${sucesso ? '✅' : '❌'} ${r.compraId} item ${r.itemNumero} R$${r.valor} HTTP ${r.status} (${r.tempoMs}ms)`);

      // A6: trigger reativo
      if (autoLanceAtivo) {
        if (sucesso) {
          setImmediate(() => executarCicloAutoLance(true));
        } else if (isContinuo) {
          setTimeout(() => executarCicloAutoLance(true), 3000);
        }
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

      // SNIPER-C05: delega processamento individual para helper compartilhado
      for (const r of resultados) {
        try {
          const out = processarResultadoLance(r);
          if (out.sucesso) sucessos++; else falhas++;
        } catch (rowErr) {
          falhas++;
          console.warn(`[Sniper] Erro processando resultado lance ${r && r.id}: ${rowErr.message}`);
        }
      }

      console.log(`[Sniper] Batch resultado: ${sucessos} ✅ ${falhas} ❌ (${resultados.length} total)`);

      // Reactive trigger after batch
      if (autoLanceAtivo) {
        if (sucessos > 0) {
          setImmediate(() => executarCicloAutoLance(true));
        } else if (falhas > 0) {
          setTimeout(() => executarCicloAutoLance(true), 3000);
        }
      }

      res.json({ success: true, sucessos, falhas, total: resultados.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== AUTO-LANCE ROUTES ====================

  /**
   * GET /api/sniper/mercado?compraId=...&itemNumero=...
   * Histórico do estado do mercado — cada mudança em melhorGeral/nossoValor/situação.
   * Permite reconstruir a timeline de lances nossos vs concorrentes.
   */
  app.get('/api/sniper/mercado', (req, res) => {
    try {
      const { compraId, itemNumero } = req.query;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });

      let query = `SELECT * FROM sniper_classificacao WHERE compraId = ?`;
      const params = [compraId];
      if (itemNumero) {
        query += ` AND itemNumero = ?`;
        params.push(parseInt(itemNumero));
      }
      query += ` ORDER BY timestamp, id LIMIT 1000`;

      const rows = db.prepare(query).all(...params);
      res.json({ success: true, total: rows.length, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

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
        guardLoops: Object.keys(guardLoops).map(cid => ({
          compraId: cid,
          itens: [...guardLoops[cid].itens],
          intervalMs: guardLoops[cid].intervalMs,
          iniciadoEm: guardLoops[cid].iniciadoEm,
        })),
        guardStats,
        log: autoLanceLog.slice(0, 200),
        filaLances: filaLances.length,
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
   * GET /api/sniper/auto-compras
   * Retorna lista de compraIds com auto-lance ativo.
   * Usado pela extensão para decidir quais compras precisam de filtros extras.
   */
  app.get('/api/sniper/auto-compras', (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT DISTINCT compraId FROM sniper_itens WHERE modoAuto IS NOT NULL AND modoAuto != ''`
      ).all();
      res.json({ success: true, compraIds: rows.map(r => r.compraId) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/log-filtro
   * Recebe log de filtro da extensão para visibilidade centralizada.
   */
  app.post('/api/sniper/log-filtro', (req, res) => {
    try {
      const { compraId, filtro, nome, qtde, itens } = req.body;
      logAuto(`[EXT] FILTRO=${filtro} (${nome}) ${compraId}: ${qtde} itens — ${JSON.stringify(itens)}`);
      res.json({ success: true });
    } catch (e) {
      res.json({ success: true }); // não falhar para não atrapalhar extensão
    }
  });

  /**
   * GET /api/sniper/fila-status
   * Status completo da fila de lances.
   */
  app.get('/api/sniper/fila-status', (req, res) => {
    const sniperStatus = sniper.getStatus();
    const extensaoConectada = !!(ultimoSyncExtensao && (Date.now() - ultimoSyncExtensao) < 5 * 60 * 1000);
    const ps = getPuppeteerSession();
    res.json({
      success: true,
      fila: filaLances,
      resultados: resultadosLances.slice(0, 20),
      totalResultados: resultadosLances.length,
      extensaoConectada,
      temBearer: sniperStatus.temToken,
      bearerIdade: sniperStatus.tokenIdadeSegundos,
      tokenExpirado: sniperStatus.tokenExpirado,
      puppeteer: {
        state: ps.state,
        loggedIn: ps.state === 'logged_in',
        bearerFresh: ps.tokenEstaFresco(),
        bearerAge: ps.bearerTimestamp ? ps.tokenIdadeSegundos() : null,
        uptime: ps.launchedAt ? Math.floor((Date.now() - new Date(ps.launchedAt).getTime()) / 1000) : null,
      },
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

  // ==================== CONSULTA DE DISPUTA ====================

  app.get('/api/sniper/participacoes', (req, res) => {
    try {
      const busca = req.query.busca || '';
      const emDisputa = req.query.emDisputa === 'true';
      let query = 'SELECT compraId, cnpj, ano, sequencial, orgao, objeto, etapa, situacao, faseCompra, dataSessao, dataAtualizacao, modoDisputa, dataHoraFimDisputa, linkPncp, exclusivaMeEpp, criterioJulgamento FROM participacoes_comprasnet WHERE ativo = 1';
      const params = [];

      if (emDisputa) {
        // Filtrar apenas participações em fase de disputa (faseCompra = '3')
        query += " AND faseCompra = '3' AND situacao NOT IN ('FR', 'EN', 'SU')";
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

  /**
   * POST /api/sniper/refresh-participacoes
   * Atualiza participações consultando a API Comprasnet diretamente do servidor.
   * Usa GET /compras/{compraId}/participacao (funciona sem captcha) para cada compra ativa.
   * Também verifica compraIds de interesses que ainda não estão em participacoes_comprasnet.
   */
  // ==================== REFRESH AUTOMÁTICO DE PARTICIPAÇÕES ====================

  async function executarRefreshParticipacoes() {
    if (!sniper.temToken() || sniper.tokenExpirado()) return null;

    const delay = ms => new Promise(r => setTimeout(r, ms));

    // 1. Coletar compraIds para verificar (prioridade: em disputa/ativas recentes)
    const comprasDB = db.prepare(`
      SELECT compraId, cnpj, ano, sequencial, situacao, faseCompra
      FROM participacoes_comprasnet
      WHERE ativo = 1 AND situacao NOT IN ('FR', 'EN', 'EX')
        AND (faseCompra IN ('1', '2', '3') OR situacao IN ('PD', 'AB', 'PE', '5', 'SU', '')
             OR dataAtualizacao > datetime('now', '-7 days'))
      ORDER BY CASE WHEN faseCompra = '3' THEN 0 WHEN situacao IN ('PD', 'PE') THEN 1 ELSE 2 END,
               dataAtualizacao DESC
      LIMIT 80
    `).all();

    const interesseCompras = db.prepare(`
      SELECT ic.compraId, ic.cnpj, ic.ano, ic.sequencial
      FROM interesse_compra_id ic
      WHERE ic.compraId IS NOT NULL AND ic.compraId != ''
        AND ic.compraId NOT LIKE 'NAO_COMPRASNET:%'
        AND NOT EXISTS (SELECT 1 FROM participacoes_comprasnet p WHERE p.compraId = ic.compraId)
    `).all();

    const todosCompraIds = new Map();
    for (const c of comprasDB) todosCompraIds.set(c.compraId, c);
    for (const c of interesseCompras) if (!todosCompraIds.has(c.compraId)) todosCompraIds.set(c.compraId, c);

    if (todosCompraIds.size === 0) return { verificadas: 0 };

    let atualizadas = 0, inseridas = 0, erros = 0;

    const stmtSelect = db.prepare('SELECT id, situacao, faseCompra FROM participacoes_comprasnet WHERE compraId = ?');
    const stmtUpdate = db.prepare(`UPDATE participacoes_comprasnet SET
      situacao = ?, faseCompra = ?,
      objeto = COALESCE(?, objeto), orgao = COALESCE(?, orgao),
      ativo = 1, dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ?`);
    const stmtInsert = db.prepare(`INSERT INTO participacoes_comprasnet
      (compraId, cnpj, ano, sequencial, orgao, objeto, situacao, faseCompra, ativo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);

    for (const [compraId, info] of todosCompraIds) {
      try {
        const { status, data } = await sniper.apiGet(`/comprasnet-fase-externa/v1/compras/${compraId}/participacao`);
        if (status === 200 && data && typeof data === 'object') {
          const sit = data.situacaoCompraFaseExterna || '';
          const fase = data.faseCompraFaseExterna || '';
          const objeto = data.objetoCompra || '';
          const orgao = data.nomeOrgao || data.nomeUasg || '';
          const existe = stmtSelect.get(compraId);
          if (existe) {
            if (existe.situacao !== sit || existe.faseCompra !== fase) {
              stmtUpdate.run(sit, fase, objeto || null, orgao || null, compraId);
              atualizadas++;
            }
          } else {
            stmtInsert.run(compraId, info.cnpj || '', info.ano || 0, info.sequencial || 0, orgao, objeto, sit, fase);
            inseridas++;
          }
        }
        await delay(100); // 100ms entre requests (era 300ms)
      } catch (e) { erros++; }
    }

    // Fase 2: Buscar itens de disputa para popular disputasCache
    const comprasEmDisputa = db.prepare(`
      SELECT compraId, orgao, objeto, dataSessao
      FROM participacoes_comprasnet
      WHERE ativo = 1 AND faseCompra = '3' AND situacao IN ('PD', 'AB', '5')
    `).all();

    let disputasAtualizadas = 0;
    for (const compra of comprasEmDisputa) {
      try {
        const result = await sniper.consultarItens(compra.compraId);
        if (result.success && result.itens?.length > 0) {
          const itens = result.itens.map(i => {
            const mv = i.melhorValorGeral || i.melhorLanceGeral;
            const nv = i.melhorValorFornecedor || i.melhorLanceFornecedor;
            const melhorValor = mv?.valorInformado ?? mv?.valor ?? i.valorMelhorLance ?? null;
            const nossoValor = nv?.valorInformado ?? nv?.valor ?? null;
            const fase = i.fase || i.faseItem || '';
            return {
              numero: i.numero ?? i.identificador, tipo: i.tipo || null,
              descricao: (i.descricao || i.objetoItem || '').substring(0, 120),
              fase, situacao: i.situacao || '', melhorValor, nossoValor,
              valorEstimado: i.valorEstimadoUnitario || i.valorEstimado || null,
              situacaoParticipante: i.situacaoParticipanteDisputa || null,
              variacaoMinima: i.variacaoMinimaEntreLances ?? null,
              podeEnviar: i.podeEnviarLances || false,
              fimContagem: i.dataHoraFimContagem || null,
              quantidadeSolicitada: i.quantidadeSolicitada || null,
              disputaPorValorUnitario: !!i.disputaPorValorUnitario,
              estaPerdendo: nossoValor != null && melhorValor != null ? nossoValor > melhorValor : false,
            };
          });
          const faseAtiva = f => ['LA', 'D1', 'D2'].includes((f || '').toUpperCase());
          const itensAtivos = itens.filter(i => faseAtiva(i.fase) || i.podeEnviar).length;
          const disputa = {
            compraId: compra.compraId, orgao: compra.orgao || '', objeto: compra.objeto || '',
            dataSessao: compra.dataSessao || '', totalItens: itens.length, itensAtivos, itens,
            _atualizadoEm: new Date().toISOString(), _fonte: 'servidor',
          };
          const idx = disputasCache.disputas.findIndex(d => d.compraId === compra.compraId);
          if (idx >= 0) {
            const existente = disputasCache.disputas[idx];
            const idadeExistente = existente._atualizadoEm ? Date.now() - new Date(existente._atualizadoEm).getTime() : Infinity;
            if (idadeExistente > 120000) { disputasCache.disputas[idx] = disputa; disputasAtualizadas++; }
          } else {
            disputasCache.disputas.push(disputa); disputasAtualizadas++;
          }
        }
        await delay(100);
      } catch (e) {}
    }

    if (disputasAtualizadas > 0) disputasCache.atualizadoEm = new Date().toISOString();

    const msg = `${todosCompraIds.size} compras, ${atualizadas} atualizadas, ${inseridas} novas, ${disputasAtualizadas} disputas`;
    if (atualizadas > 0 || inseridas > 0 || disputasAtualizadas > 0) console.log(`[REFRESH] ${msg}`);
    return { success: true, verificadas: todosCompraIds.size, atualizadas, inseridas, erros, disputasAtualizadas, message: msg };
  }

  // Auto-refresh: roda no startup (5s após token) e a cada 2 min
  let refreshInterval = null;
  function iniciarAutoRefresh() {
    if (refreshInterval) return;
    refreshInterval = setInterval(async () => {
      try { await executarRefreshParticipacoes(); } catch (e) {}
    }, 120000); // 2 min
    // Primeiro refresh imediato
    executarRefreshParticipacoes().catch(() => {});
    // Calibrar relógio com Comprasnet (e recalibrar a cada 10 min)
    sniper.calibrarTempo().then(r => console.log(`[CALIBRAÇÃO] offset=${r.offset}ms, latência=${r.latencia}ms`)).catch(() => {});
    setInterval(() => { sniper.calibrarTempo().catch(() => {}); }, 600000);
    console.log('[REFRESH] Auto-refresh ativado (a cada 2 min) + calibração de relógio');
  }

  // Observar quando token chegar para iniciar auto-refresh
  const origSetToken = sniper.setToken.bind(sniper);
  sniper.setToken = function(token, source) {
    origSetToken(token, source);
    iniciarAutoRefresh();
  };
  // Se já tem token no startup
  if (sniper.temToken()) setTimeout(iniciarAutoRefresh, 5000);

  // Endpoint manual (botão Sync API)
  app.post('/api/sniper/refresh-participacoes', async (req, res) => {
    try {
      if (!sniper.temToken()) return res.status(400).json({ success: false, error: 'Sem Bearer token.' });
      if (sniper.tokenExpirado()) return res.status(400).json({ success: false, error: 'Bearer token expirado.' });
      const result = await executarRefreshParticipacoes();
      res.json(result || { success: false, error: 'Sem token' });
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

      // Helper: preserve accumulated sub-items when sync only brings grupo (-1)
      function mergeDisputa(existing, incoming) {
        if (!existing || !existing.itens || !incoming.itens) return incoming;
        // Derivar estaPerdendo quando ausente (merge de resposta de lance não traz filtros)
        for (const item of incoming.itens) {
          if (item.estaPerdendo === undefined || item.estaPerdendo === null) {
            if (item.melhorValor != null && item.nossoValor != null) {
              item.estaPerdendo = item.nossoValor > item.melhorValor;
            } else {
              const existItem = existing.itens.find(e => e.numero === item.numero);
              if (existItem) item.estaPerdendo = existItem.estaPerdendo;
            }
          }
        }
        // Find sub-items in existing cache that are NOT in incoming data
        const incomingNums = new Set(incoming.itens.map(i => i.numero));
        const preservados = existing.itens.filter(i =>
          i.tipo === 'S' && !incomingNums.has(i.numero)
        );
        if (preservados.length > 0) {
          incoming.itens = incoming.itens.concat(preservados);
        }
        return incoming;
      }

      if (merge) {
        // Merge: add/update individual items without replacing full cache
        for (const d of disputas) {
          const idx = disputasCache.disputas.findIndex(c => c.compraId === d.compraId);
          if (idx >= 0) {
            disputasCache.disputas[idx] = mergeDisputa(disputasCache.disputas[idx], d);
          } else {
            disputasCache.disputas.push(d);
          }
        }
        disputasCache.atualizadoEm = new Date().toISOString();
      } else {
        // Full replace — but preserve sub-items for groups
        const oldMap = {};
        for (const d of disputasCache.disputas) {
          if (d.compraId) oldMap[d.compraId] = d;
        }
        for (let i = 0; i < disputas.length; i++) {
          const old = oldMap[disputas[i].compraId];
          if (old) disputas[i] = mergeDisputa(old, disputas[i]);
        }
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
   * TTL: queries em 'processando' há >60s são descartadas (extensão caiu ou falhou silenciosamente).
   */
  app.get('/api/sniper/fila-queries', (req, res) => {
    const agora = Date.now();
    const TTL_PROCESSANDO_MS = 60 * 1000;

    const pendentes = pendingItemQueries.filter(q => q.status === 'pendente');
    pendentes.forEach(q => {
      q.status = 'processando';
      q.processandoDesde = agora;
    });
    res.json({ success: true, queries: pendentes });

    // Limpar: mantém pendentes e processando recentes (<60s).
    pendingItemQueries = pendingItemQueries.filter(q => {
      if (q.status === 'pendente') return true;
      if (q.status === 'processando') {
        return q.processandoDesde && (agora - q.processandoDesde) < TTL_PROCESSANDO_MS;
      }
      return false;
    });
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

      const stmtSelect = db.prepare('SELECT id, situacao, faseCompra FROM participacoes_comprasnet WHERE compraId = ?');
      const stmtUpdate = db.prepare(`UPDATE participacoes_comprasnet SET
        situacao = COALESCE(?, situacao), faseCompra = COALESCE(?, faseCompra),
        objeto = COALESCE(?, objeto), orgao = COALESCE(?, orgao),
        dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ?`);
      // Quando vem do filtro=5 (em andamento), forçar remoção do status encerrado
      const stmtReativar = db.prepare(`UPDATE participacoes_comprasnet SET
        situacao = CASE WHEN situacao IN ('EN', 'FR', 'SU') THEN '' ELSE situacao END,
        faseCompra = CASE WHEN faseCompra IN ('encerrada', 'ENCERRADA', '4', '99') THEN '3' ELSE COALESCE(?, faseCompra) END,
        objeto = COALESCE(?, objeto), orgao = COALESCE(?, orgao),
        ativo = 1, dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ?`);
      const stmtInsert = db.prepare(`INSERT INTO participacoes_comprasnet
        (compraId, cnpj, ano, sequencial, orgao, objeto, situacao, faseCompra, ativo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);

      const syncTransaction = db.transaction((items) => {
        for (const item of items) {
          const compra = item.compra || item;
          const compraId = buildCompraId(compra);
          if (!compraId || compraId.length < 10) continue;

          const filtro = item._filtro; // 5=em andamento, 4=em disputa, 3=proposta enviada
          const existe = stmtSelect.get(compraId);
          if (existe) {
            // Se veio do filtro=5 e está marcada como encerrada, reativar
            if (filtro === 5 && (existe.situacao === 'EN' || existe.situacao === 'FR' || existe.situacao === 'SU' ||
                ['encerrada', 'ENCERRADA', '4', '99'].includes(existe.faseCompra))) {
              console.log(`[Sync] Reativando ${compraId} (estava ${existe.situacao}/${existe.faseCompra}, voltou no filtro=5)`);
              stmtReativar.run(
                compra.faseCompraFaseExterna || compra.faseCompra || null,
                compra.objetoCompra || compra.objeto || null,
                compra.nomeOrgao || compra.nomeUasg || compra.orgao || null,
                compraId,
              );
            } else if (filtro === 3 && existe.situacao !== 'PE') {
              // filtro=3 = Comprasnet confirma proposta enviada
              console.log(`[Sync] Proposta confirmada ${compraId} (era ${existe.situacao} → PE)`);
              stmtUpdate.run('PE',
                compra.faseCompraFaseExterna || compra.faseCompra || null,
                compra.objetoCompra || compra.objeto || null,
                compra.nomeOrgao || compra.nomeUasg || compra.orgao || null,
                compraId,
              );
            } else {
              stmtUpdate.run(
                filtro === 3 ? 'PE' : (compra.situacaoCompraFaseExterna || compra.situacao || null),
                compra.faseCompraFaseExterna || compra.faseCompra || null,
                compra.objetoCompra || compra.objeto || null,
                compra.nomeOrgao || compra.nomeUasg || compra.orgao || null,
                compraId,
              );
            }
            atualizadas++;
          } else {
            stmtInsert.run(
              compraId,
              compra.numeroUasg || compra.cnpj || '',
              compra.ano || 0,
              compra.numero || compra.sequencial || 0,
              compra.nomeOrgao || compra.nomeUasg || compra.orgao || '',
              compra.objetoCompra || compra.objeto || '',
              filtro === 3 ? 'PE' : (compra.situacaoCompraFaseExterna || compra.situacao || ''),
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
   * POST /api/sync/participacao-detalhes
   * Recebe dados detalhados da API /participacao do Comprasnet.
   * Salva campos extras (modoDisputa, horários, linkPncp, etc.) no banco.
   */
  app.post('/api/sync/participacao-detalhes', (req, res) => {
    try {
      const {
        compraId, modoDisputa, criterioJulgamento,
        dataHoraInicioDisputa, dataHoraFimDisputa, dataHoraAbertura,
        chaveCompraPncp, linkPncp, exclusivaMeEpp,
        fundamentoLegal, situacaoCompra, faseCompra, objeto, orgao,
      } = req.body;

      if (!compraId) {
        return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      }

      const existe = db.prepare('SELECT id FROM participacoes_comprasnet WHERE compraId = ?').get(compraId);
      if (existe) {
        db.prepare(`UPDATE participacoes_comprasnet SET
          modoDisputa = COALESCE(?, modoDisputa),
          criterioJulgamento = COALESCE(?, criterioJulgamento),
          dataHoraInicioDisputa = COALESCE(?, dataHoraInicioDisputa),
          dataHoraFimDisputa = COALESCE(?, dataHoraFimDisputa),
          dataSessao = COALESCE(?, dataSessao),
          chaveCompraPncp = COALESCE(?, chaveCompraPncp),
          linkPncp = COALESCE(?, linkPncp),
          exclusivaMeEpp = COALESCE(?, exclusivaMeEpp),
          fundamentoLegal = COALESCE(?, fundamentoLegal),
          situacao = COALESCE(?, situacao),
          faseCompra = COALESCE(?, faseCompra),
          objeto = COALESCE(?, objeto),
          orgao = COALESCE(?, orgao),
          dataAtualizacao = CURRENT_TIMESTAMP
          WHERE compraId = ?`).run(
          modoDisputa, criterioJulgamento,
          dataHoraInicioDisputa, dataHoraFimDisputa, dataHoraAbertura,
          chaveCompraPncp, linkPncp, exclusivaMeEpp,
          fundamentoLegal, situacaoCompra, faseCompra, objeto, orgao,
          compraId,
        );
        console.log(`[Sync] Participação detalhes: ${compraId} atualizada (modo=${modoDisputa}, fim=${dataHoraFimDisputa})`);
      } else {
        // Se não existe no banco, criar registro básico
        db.prepare(`INSERT INTO participacoes_comprasnet
          (compraId, cnpj, ano, sequencial, orgao, objeto, situacao, faseCompra,
           modoDisputa, criterioJulgamento, dataHoraInicioDisputa, dataHoraFimDisputa,
           dataSessao, chaveCompraPncp, linkPncp, exclusivaMeEpp, fundamentoLegal, ativo)
          VALUES (?, '', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
          compraId, orgao || '', objeto || '', situacaoCompra || '', faseCompra || '',
          modoDisputa, criterioJulgamento,
          dataHoraInicioDisputa, dataHoraFimDisputa, dataHoraAbertura,
          chaveCompraPncp, linkPncp, exclusivaMeEpp || 0, fundamentoLegal,
        );
        console.log(`[Sync] Participação detalhes: ${compraId} inserida (modo=${modoDisputa})`);
      }

      res.json({ success: true });
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
   * POST /api/sync/mensagens-global
   * Recebe mensagens do endpoint global /comprasnet-mensagem/v1/mensagens
   * Formato diferente do v2/chat — campos: id, titulo, texto, origemMensagem, categoria, etc.
   */
  app.post('/api/sync/mensagens-global', async (req, res) => {
    try {
      const { mensagens } = req.body;
      if (!Array.isArray(mensagens)) {
        return res.status(400).json({ success: false, error: 'mensagens[] obrigatório' });
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
      const alertas = [];

      const insertStmt = db.prepare(`INSERT OR IGNORE INTO chat_mensagens
        (compraId, cnpjOrgao, ano, sequencial, dataHoraMensagem,
         remetente, mensagem, hashMensagem, titulo, categoria,
         origemMensagem, lidaComprasnet, tipoCompra, excluida,
         vinculadaADiligencia, descricaoModalidade, numeroCompraFormatado,
         identificadorItem, mensagemIdComprasnet, origemCaptura, notificado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extensao-v1', 0)`);

      for (const msg of mensagens) {
        // Montar compraId via helper centralizado (SNIPER-C01)
        const compraId = buildCompraId(msg);
        if (!compraId || compraId.length < 10) continue;
        const uasg = String(msg.numeroUasg || '').padStart(6, '0');

        const conteudo = msg.texto || '';
        const remetente = msg.remetente || '';
        const dataHora = msg.dataHoraPublicacao || new Date().toISOString();

        // Hash para deduplicação (fallback se não tiver id do Comprasnet)
        const hashMensagem = require('crypto').createHash('md5')
          .update(compraId + '|' + dataHora + '|' + remetente + '|' + conteudo)
          .digest('hex');

        // Se já temos pelo ID do Comprasnet, skip
        if (msg.id) {
          const existe = db.prepare('SELECT id FROM chat_mensagens WHERE mensagemIdComprasnet = ?').get(msg.id);
          if (existe) continue;
        }

        try {
          insertStmt.run(
            compraId,
            uasg,                               // cnpjOrgao (aqui é UASG, não CNPJ)
            parseInt(msg.anoCompra) || 0,        // ano
            parseInt(msg.numeroCompra) || 0,     // sequencial
            dataHora,
            remetente,
            conteudo,
            hashMensagem,
            msg.titulo || '',
            msg.categoria || '',
            msg.origemMensagem || '',
            msg.lida ? 1 : 0,
            msg.tipoCompra || '',
            msg.excluida ? 1 : 0,
            msg.vinculadaADiligencia ? 1 : 0,
            msg.descricaoModalidade || '',
            msg.numeroCompraFormatado || '',
            msg.identificadorItem || '',
            msg.id || null
          );
          novas++;

          // Detectar mensagem direcionada (categoria 830 = convocação)
          if (msg.categoria === '830' || (msg.identificadorParticipante && meuCnpj)) {
            alertas.push({ conteudo, dataHora, compraId, titulo: msg.titulo || '' });
          }
        } catch (e) {
          // Duplicate hash ou id — skip
        }
      }

      if (novas > 0) {
        console.log(`[Sync] Mensagens global: ${novas} novas (de ${mensagens.length})`);
      }

      // Enviar alertas Telegram para convocações
      if (alertas.length > 0) {
        try {
          const telegramConfig = db.prepare('SELECT botToken, chatId FROM telegram_config WHERE id = 1 AND ativo = 1').get();
          if (telegramConfig?.botToken && telegramConfig?.chatId) {
            for (const alerta of alertas) {
              const participacao = db.prepare('SELECT orgao, objeto FROM participacoes_comprasnet WHERE compraId = ?').get(alerta.compraId);
              const orgao = participacao?.orgao || alerta.compraId;
              const objeto = participacao?.objeto || '';

              const texto = `🚨 <b>${alerta.titulo || 'MENSAGEM IMPORTANTE'}</b>\n\n` +
                `📋 <b>Compra:</b> ${alerta.compraId}\n` +
                `🏢 <b>Órgão:</b> ${orgao}\n` +
                (objeto ? `📝 <b>Objeto:</b> ${objeto.substring(0, 100)}...\n` : '') +
                `⏰ <b>Hora:</b> ${alerta.dataHora}\n\n` +
                `💬 ${alerta.conteudo}\n\n` +
                `⚠️ <b>VERIFIQUE NO COMPRASNET!</b>`;

              const axios = require('axios');
              await axios.post(`https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage`, {
                chat_id: telegramConfig.chatId,
                text: texto,
                parse_mode: 'HTML'
              });
              console.log(`[ALERTA] Telegram enviado: ${alerta.titulo} em ${alerta.compraId}`);
            }
          }
        } catch (telegramErr) {
          console.error('[ALERTA] Erro Telegram:', telegramErr.message);
        }
      }

      res.json({ success: true, novas, total: mensagens.length, alertas: alertas.length });
    } catch (e) {
      console.error('[Sync] Erro mensagens-global:', e.message);
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
              valorMinimo, descontoMinimo, descontoMaximo, valorEstimado, modoAuto, custo,
              variacaoMinima, tipoVariacao, maxLances } = req.body;
      if (!compraId || !itemNumero) return res.status(400).json({ success: false, error: 'compraId e itemNumero obrigatórios' });

      const stmt = db.prepare(`INSERT INTO sniper_itens (compraId, itemNumero, descricao, valorLance, faseItem, horarioAlvo, antecedenciaMs, tentativas, intervaloMs, ativo, valorMinimo, descontoMinimo, descontoMaximo, valorEstimado, custo, variacaoMinima, tipoVariacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          custo = COALESCE(excluded.custo, custo),
          variacaoMinima = COALESCE(excluded.variacaoMinima, variacaoMinima),
          tipoVariacao = COALESCE(excluded.tipoVariacao, tipoVariacao),
          dataAtualizacao = CURRENT_TIMESTAMP`);

      stmt.run(compraId, itemNumero, descricao || null, valorLance || null, faseItem || 'LA',
               horarioAlvo || null, antecedenciaMs || 3000, tentativas || 3, intervaloMs || 500,
               ativo !== undefined ? (ativo ? 1 : 0) : 1,
               valorMinimo !== undefined ? valorMinimo : null,
               descontoMinimo !== undefined ? descontoMinimo : null,
               descontoMaximo !== undefined ? descontoMaximo : null,
               valorEstimado !== undefined ? valorEstimado : null,
               custo !== undefined ? custo : null,
               variacaoMinima !== undefined ? variacaoMinima : null,
               tipoVariacao || null);

      // Campos que permitem limpar (null = explicitly clear, undefined = don't touch)
      if ('modoAuto' in req.body) {
        db.prepare(`UPDATE sniper_itens SET modoAuto = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ? AND itemNumero = ?`)
          .run(modoAuto || null, compraId, itemNumero);
      }
      if ('maxLances' in req.body) {
        db.prepare(`UPDATE sniper_itens SET maxLances = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ? AND itemNumero = ?`)
          .run(maxLances || null, compraId, itemNumero);
      }
      if ('valorMinimo' in req.body) {
        db.prepare(`UPDATE sniper_itens SET valorMinimo = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ? AND itemNumero = ?`)
          .run(valorMinimo != null ? valorMinimo : null, compraId, itemNumero);
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
      const { compraId, itemNumero, limit } = req.query;
      let query = 'SELECT id, compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp FROM sniper_historico WHERE 1=1';
      const params = [];
      if (compraId) { query += ' AND compraId = ?'; params.push(compraId); }
      if (itemNumero) { query += ' AND itemNumero = ?'; params.push(parseInt(itemNumero)); }
      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(parseInt(limit) || 50);
      const rows = db.prepare(query).all(...params);
      res.json({ success: true, historico: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/relatorio-lances
   * Relatório detalhado de lances com filtros e resumo.
   */
  app.get('/api/relatorio-lances', (req, res) => {
    try {
      const { compraId, itemNumero, sucesso, fonte, dataInicio, dataFim, limit } = req.query;
      let query = 'SELECT id, compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp FROM sniper_historico WHERE 1=1';
      const params = [];

      if (compraId) { query += ' AND compraId LIKE ?'; params.push(`%${compraId}%`); }
      if (itemNumero) { query += ' AND itemNumero = ?'; params.push(parseInt(itemNumero)); }
      if (sucesso === '1' || sucesso === '0') { query += ' AND sucesso = ?'; params.push(parseInt(sucesso)); }
      if (fonte) { query += ' AND fonte = ?'; params.push(fonte); }
      if (dataInicio) { query += ' AND timestamp >= ?'; params.push(dataInicio + 'T00:00:00Z'); }
      if (dataFim) { query += ' AND timestamp <= ?'; params.push(dataFim + 'T23:59:59Z'); }

      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(parseInt(limit) || 100);

      const lances = db.prepare(query).all(...params);

      // Extrair hora Comprasnet de cada lance
      for (const l of lances) {
        if (l.resposta) {
          try {
            const resp = typeof l.resposta === 'string' ? JSON.parse(l.resposta) : l.resposta;
            const item0 = Array.isArray(resp) ? resp[0] : resp;
            if (item0 && item0.dataHoraAtualizacao) {
              l.comprasnetHora = item0.dataHoraAtualizacao.substring(11, 23);
            }
          } catch (e) {}
          delete l.resposta; // não enviar resposta completa (pesada)
        }
      }

      // Resumo
      const ok = lances.filter(l => l.sucesso).length;
      const falha = lances.length - ok;
      const avgMs = lances.length > 0 ? Math.round(lances.filter(l => l.sucesso && l.tempoMs < 500).reduce((a, l) => a + (l.tempoMs || 0), 0) / Math.max(1, lances.filter(l => l.sucesso && l.tempoMs < 500).length)) : 0;
      const compras = new Set(lances.map(l => l.compraId)).size;
      const itens = new Set(lances.map(l => l.compraId + '-' + l.itemNumero)).size;

      res.json({
        success: true,
        lances,
        resumo: {
          total: lances.length,
          ok, falha,
          taxa: lances.length > 0 ? Math.round(ok / lances.length * 100) : 0,
          avgMs, compras, itens,
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/timeline-lances
   * Linha do tempo unificada: nossos lances + transições do concorrente.
   */
  app.get('/api/timeline-lances', (req, res) => {
    try {
      const { compraId, itemNumero, dataInicio, dataFim, quem } = req.query;
      const diDefault = dataInicio || new Date(Date.now() - 7*86400000 - 3*3600000).toISOString().slice(0,10);
      const eventos = [];

      if (quem !== 'concorrente') {
        let q = `SELECT compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, fonte, timestamp
                 FROM sniper_historico WHERE date(timestamp,'-3 hours') >= ?`;
        const p = [diDefault];
        if (dataFim)    { q += ` AND date(timestamp,'-3 hours') <= ?`; p.push(dataFim); }
        if (compraId)   { q += ' AND compraId = ?'; p.push(compraId); }
        if (itemNumero) { q += ' AND itemNumero = ?'; p.push(Number(itemNumero)); }
        for (const r of db.prepare(q).all(...p)) {
          eventos.push({ quem: 'nosso', timestamp: r.timestamp, compraId: r.compraId, itemNumero: r.itemNumero, valor: r.valor, httpStatus: r.httpStatus, sucesso: r.sucesso, tempoMs: r.tempoMs, fonte: r.fonte });
        }
      }

      if (quem !== 'nosso') {
        let q = `SELECT compraId, itemNumero, melhorGeral, nossoValor, situacao, timestamp
                 FROM sniper_classificacao WHERE date(timestamp,'-3 hours') >= ?`;
        const p = [diDefault];
        if (dataFim)    { q += ` AND date(timestamp,'-3 hours') <= ?`; p.push(dataFim); }
        if (compraId)   { q += ' AND compraId = ?'; p.push(compraId); }
        if (itemNumero) { q += ' AND itemNumero = ?'; p.push(Number(itemNumero)); }
        q += ' ORDER BY timestamp ASC';
        let prev = null;
        for (const r of db.prepare(q).all(...p)) {
          const key = r.compraId + '|' + r.itemNumero;
          if (!prev || prev.key !== key || prev.valor !== r.melhorGeral) {
            eventos.push({ quem: 'concorrente', timestamp: r.timestamp, compraId: r.compraId, itemNumero: r.itemNumero, valor: r.melhorGeral, situacao: r.situacao, nossoValor: r.nossoValor });
            prev = { key, valor: r.melhorGeral };
          }
        }
      }

      // Normaliza timestamps para ISO (alguns antigos vieram sem T / sem ms)
      for (const e of eventos) {
        let t = String(e.timestamp || '').trim();
        if (t.indexOf('T') < 0) t = t.replace(' ', 'T');
        if (!/[Z+\-]\d{2}:?\d{2}$/.test(t) && !t.endsWith('Z')) t += 'Z';
        e.timestamp = t;
      }
      eventos.sort((a,b) => a.timestamp.localeCompare(b.timestamp));
      res.json({ success: true, eventos });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/relatorio-concorrentes
   * Histórico de mudanças do melhor lance geral (guard) com transições de preço.
   */
  app.get('/api/relatorio-concorrentes', (req, res) => {
    try {
      const { compraId, itemNumero, dataInicio, dataFim } = req.query;
      const diDefault = dataInicio || new Date(Date.now() - 7*86400000 - 3*3600000).toISOString().slice(0,10);
      let sql = `SELECT compraId, itemNumero, melhorGeral, nossoValor, situacao, timestamp FROM sniper_classificacao WHERE date(timestamp,'-3 hours') >= ?`;
      const params = [diDefault];
      if (dataFim)    { sql += ` AND date(timestamp,'-3 hours') <= ?`; params.push(dataFim); }
      if (compraId)   { sql += ' AND compraId = ?';   params.push(compraId); }
      if (itemNumero) { sql += ' AND itemNumero = ?'; params.push(Number(itemNumero)); }
      sql += ' ORDER BY timestamp ASC';
      const rows = db.prepare(sql).all(...params);

      const grupos = {};
      for (const r of rows) {
        const k = r.compraId + '|' + r.itemNumero;
        if (!grupos[k]) grupos[k] = { compraId: r.compraId, itemNumero: r.itemNumero, transicoes: [] };
        const t = grupos[k].transicoes;
        const ult = t[t.length - 1];
        if (!ult || ult.melhorGeral !== r.melhorGeral) {
          t.push({ melhorGeral: r.melhorGeral, nossoValor: r.nossoValor, situacao: r.situacao, timestamp: r.timestamp });
        }
      }
      // Filtra grupos com ≥2 transições (movimentação real) e ordena por última transição
      const out = Object.values(grupos)
        .filter(g => g.transicoes.length >= 2)
        .sort((a,b) => (b.transicoes[b.transicoes.length-1].timestamp).localeCompare(a.transicoes[a.transicoes.length-1].timestamp))
        .slice(0, 50);
      res.json({ success: true, grupos: out, totalGruposEncontrados: Object.keys(grupos).length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== ENVIO DE PROPOSTA VIA API ====================

  /**
   * POST /api/proposta/enviar-api
   * Envia proposta diretamente via API Comprasnet usando o Bearer token.
   *
   * Fluxo correto (HAR-verified):
   *  1. GET  .../compras/{compraId}/participacao        → verifica status
   *  2. POST .../compras/{compraId}/participacao        → aceita declarações (se necessário)
   *  3. POST .../compras/{compraId}/itens/{n}/participacao → envia proposta por item
   *
   * Body: {
   *   compraId: string,
   *   itens: [{ numero, valor, quantidade?, marca?, modelo? }],
   *   declaracoes?: { declaracaoMeEpp, declaracaoProgramasIntegridade, declaracaoEquidadeGenero }
   * }
   */
  app.post('/api/proposta/enviar-api', async (req, res) => {
    try {
      const { compraId, itens, declaracoes } = req.body;

      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      if (!itens || !Array.isArray(itens) || itens.length === 0) return res.status(400).json({ success: false, error: 'Array de itens obrigatório' });
      if (!sniper.temToken()) return res.status(400).json({ success: false, error: 'Sem Bearer token. Abra o Comprasnet com a extensão Token Relay.' });
      if (sniper.tokenExpirado()) return res.status(400).json({ success: false, error: 'Bearer token expirado. Recarregue o Comprasnet.' });

      const basePath = `/comprasnet-fase-externa/v1/compras/${compraId}`;
      const resultados = [];
      let sucessos = 0;
      const delay = ms => new Promise(r => setTimeout(r, ms));

      // Helper: POST/PUT via https nativo (axios causa 400 "Failed to read request" no Comprasnet)
      const https = require('https');
      const rawPost = (method, path, body) => new Promise((resolve) => {
        const bodyStr = JSON.stringify(body);
        const opts = {
          hostname: 'cnetmobile.estaleiro.serpro.gov.br',
          path, method,
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Authorization': sniper.getToken(),
            'x-device-platform': 'web',
            'x-version-number': '6.0.0',
            'Content-Length': Buffer.byteLength(bodyStr),
          },
        };
        const r = https.request(opts, (resp) => {
          let data = '';
          resp.on('data', c => data += c);
          resp.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(data); } catch(e) { parsed = data; }
            resolve({ status: resp.statusCode, data: parsed });
          });
        });
        r.on('error', e => resolve({ status: 0, data: e.message }));
        r.write(bodyStr);
        r.end();
      });

      // --- Passo 1: Verificar estado da compra e garantir participação ---
      // Primeiro GET para saber se já participa e quais declarações a compra exige
      let jaParticipando = false;
      let compraInfo = null;
      try {
        const getResp = await sniper.apiGet(`${basePath}/participacao`);
        sniper.log(`ℹ️ GET participação: HTTP ${getResp.status}`);
        if (getResp.status === 200 && getResp.data && typeof getResp.data === 'object') {
          compraInfo = getResp.data;
          // Só considerar "já participando" se a resposta indicar participação real
          // (itensParticipacao presente, ou situação que implica participação ativa)
          const sit = compraInfo.situacaoCompraFaseExterna;
          jaParticipando = !!(compraInfo.itensParticipacao || sit === 'AB' || sit === 'PE' || sit === 'EN');
          sniper.log(`ℹ️ Compra: situacao=${sit}, fase=${compraInfo.faseCompraFaseExterna}, exigeEquidade=${compraInfo.exigeDeclaracaoEquidadeGenero}, jaParticipando=${jaParticipando}`);
        }
      } catch (e) {
        sniper.log(`⚠️ GET participação erro: ${e.message}`);
      }

      // Montar declarações respeitando exigências e tipos da API Comprasnet
      // declaracaoEquidadeGenero: NÃO aceita boolean! Aceita: null (quando não exigido), "N" (não), 1 (sim)
      const exigeEquidade = compraInfo?.exigeDeclaracaoEquidadeGenero === true;
      const exigeIntegridade = compraInfo?.exigeDeclaracaoProgramasIntegridade === true;
      const declBody = {
        declaracaoMeEpp: declaracoes?.declaracaoMeEpp ?? false,
        declaracaoProgramasIntegridade: declaracoes?.declaracaoProgramasIntegridade ?? false,
        declaracaoEquidadeGenero: exigeEquidade
          ? (declaracoes?.declaracaoEquidadeGenero ? 1 : "N")
          : (declaracoes?.declaracaoEquidadeGenero ? 1 : null),
      };
      sniper.log(`ℹ️ Declarações body: ${JSON.stringify(declBody)} (exigeEquidade=${exigeEquidade}, exigeIntegridade=${exigeIntegridade})`);

      try {
        // POST via https nativo (axios causa 400 no Comprasnet)
        let { status, data } = await rawPost('POST', `${basePath}/participacao`, declBody);
        sniper.log(`ℹ️ POST participação (nativo): HTTP ${status} — ${JSON.stringify(data).substring(0, 300)}`);

        if (status >= 200 && status < 300) {
          resultados.push({ fase: 'declaracoes', sucesso: true, status });
          jaParticipando = true;
        } else if (jaParticipando) {
          // POST falhou mas já participa — tentar PUT
          const putResp = await rawPost('PUT', `${basePath}/participacao`, declBody);
          sniper.log(`ℹ️ PUT participação (nativo): HTTP ${putResp.status} — ${JSON.stringify(putResp.data).substring(0, 300)}`);
          if (putResp.status >= 200 && putResp.status < 300) {
            resultados.push({ fase: 'declaracoes', sucesso: true, status: putResp.status, info: 'Atualizado via PUT' });
          } else {
            // POST e PUT falharam — propagar o erro real, não mascarar como sucesso
            const erroMsg = JSON.stringify(putResp.data || data).substring(0, 300);
            resultados.push({ fase: 'declaracoes', sucesso: false, status: putResp.status || status, erro: erroMsg });
            jaParticipando = false;
          }
        } else {
          resultados.push({ fase: 'declaracoes', sucesso: false, status, erro: JSON.stringify(data).substring(0, 300) });
        }
        await delay(1500);
      } catch (e) {
        resultados.push({ fase: 'declaracoes', sucesso: false, erro: e.message });
      }

      // --- Passo 2: GET itens para inicializar participação (fluxo igual ao Comprasnet web) ---
      try {
        const getItensResp = sniper.temCaptcha()
          ? await sniper.apiGetCaptcha(`${basePath}/itens/aguardando-abertura-sessao-publica`)
          : await sniper.apiGet(`${basePath}/itens/aguardando-abertura-sessao-publica`);
        sniper.log(`ℹ️ GET itens aguardando: HTTP ${getItensResp.status} (${Array.isArray(getItensResp.data) ? getItensResp.data.length + ' itens' : 'não-array'})`);
        await delay(500);
      } catch (e) {
        sniper.log(`⚠️ GET itens aguardando falhou: ${e.message}`);
      }

      // --- Passo 3: Enviar proposta item a item ---
      for (const item of itens) {
        if (!item.numero || !item.valor || item.valor <= 0) {
          resultados.push({ numero: item.numero, sucesso: false, erro: 'Valor inválido' });
          continue;
        }

        const itemBody = {
          quantidadeOfertada: item.quantidade || 1,
          valor: parseFloat(item.valor),
          marcaFabricante: item.marca || null,
          modeloVersao: item.modelo || null,
          codigoPaisOrigemItem: null,
          propostaTrabalhoMre: null,
          declaracoesMargemPreferencia: null,
          declaracaoConteudoNacional: false,
          modificado: true,
        };
        sniper.log(`ℹ️ Item ${item.numero} body: ${JSON.stringify(itemBody)}`);

        const itemPath = `${basePath}/itens/${item.numero}/participacao`;
        try {
          // POST via https nativo
          let { status, data } = await rawPost('POST', itemPath, itemBody);
          sniper.log(`ℹ️ POST item ${item.numero}: HTTP ${status}`);

          // Se 500, tentar PUT
          if (status === 500) {
            await delay(1000);
            ({ status, data } = await rawPost('PUT', itemPath, itemBody));
            sniper.log(`ℹ️ PUT item ${item.numero}: HTTP ${status}`);
          }

          if (status >= 200 && status < 300) {
            resultados.push({ numero: item.numero, sucesso: true, status });
            sucessos++;
            sniper.log(`✅ Item ${item.numero}: R$ ${item.valor} (HTTP ${status})`);
          } else {
            const erro = typeof data === 'string' ? data.substring(0, 500) : JSON.stringify(data).substring(0, 500);
            resultados.push({ numero: item.numero, sucesso: false, status, erro });
            sniper.log(`❌ Item ${item.numero}: HTTP ${status} — ${erro}`);
          }
        } catch (e) {
          resultados.push({ numero: item.numero, sucesso: false, erro: e.message });
        }

        await delay(1500);
      }

      // Salvar status e valores no banco apenas se houve sucesso
      if (sucessos > 0) {
        try {
          db.prepare(`UPDATE participacoes_comprasnet SET situacao = 'PE', dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ?`).run(compraId);
        } catch (e) {}

        // Salvar valores enviados (marca, modelo, etc.) em valores_proposta
        try {
          const participacao = db.prepare(
            'SELECT cnpj, ano, sequencial FROM participacoes_comprasnet WHERE compraId = ?'
          ).get(compraId);
          if (participacao) {
            const stmtVP = db.prepare(`
              INSERT OR REPLACE INTO valores_proposta
              (cnpj, ano, sequencial, numeroItem, valorUnitario, marca, modelo, fabricante, selecionado, dataAtualizacao)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
            `);
            for (const r of resultados) {
              if (r.sucesso && r.numero) {
                const item = itens.find(i => i.numero === r.numero);
                if (item) {
                  stmtVP.run(
                    participacao.cnpj, participacao.ano, participacao.sequencial,
                    item.numero, item.valor, item.marca || null, item.modelo || null, null
                  );
                }
              }
            }
          }
        } catch (e) {
          console.warn('[PROPOSTA-API] Erro ao salvar valores_proposta:', e.message);
        }
      }

      console.log(`[PROPOSTA-API] ${compraId}: ${sucessos}/${itens.length} OK`);

      res.json({
        success: sucessos > 0,
        message: `${sucessos} de ${itens.length} itens enviados com sucesso`,
        compraId, sucessos, total: itens.length, resultados
      });

    } catch (error) {
      console.error('[PROPOSTA-API] Erro:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * DELETE /api/proposta/excluir/:compraId
   * Exclui participação e todas as propostas de itens da compra.
   * Endpoint Comprasnet: DELETE /comprasnet-fase-externa/v1/compras/{compraId}/participacao
   */
  app.delete('/api/proposta/excluir/:compraId', async (req, res) => {
    try {
      const { compraId } = req.params;
      if (!sniper.temToken()) return res.status(400).json({ success: false, error: 'Sem Bearer token.' });
      if (sniper.tokenExpirado()) return res.status(400).json({ success: false, error: 'Bearer token expirado.' });

      const basePath = `/comprasnet-fase-externa/v1/compras/${compraId}`;

      // DELETE via https nativo (mesmo padrão do enviar-api)
      const https = require('https');
      const result = await new Promise((resolve) => {
        const opts = {
          hostname: 'cnetmobile.estaleiro.serpro.gov.br',
          path: `${basePath}/participacao`,
          method: 'DELETE',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Authorization': sniper.getToken(),
            'x-device-platform': 'web',
            'x-version-number': '6.0.0',
          },
        };
        const r = https.request(opts, (resp) => {
          let data = '';
          resp.on('data', c => data += c);
          resp.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(data); } catch(e) { parsed = data; }
            resolve({ status: resp.statusCode, data: parsed });
          });
        });
        r.on('error', e => resolve({ status: 0, data: e.message }));
        r.end();
      });

      sniper.log(`🗑️ DELETE participação ${compraId}: HTTP ${result.status}`);

      if (result.status >= 200 && result.status < 300) {
        // Atualizar banco local
        try {
          db.prepare(`UPDATE participacoes_comprasnet SET situacao = 'EX', dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ?`).run(compraId);
        } catch (e) {}

        console.log(`[PROPOSTA-API] DELETE ${compraId}: OK`);
        res.json({
          success: true,
          message: `Participação excluída. isFornecedorParticipante: ${result.data?.isFornecedorParticipante}`,
        });
      } else {
        const erro = typeof result.data === 'string' ? result.data : JSON.stringify(result.data).substring(0, 500);
        console.log(`[PROPOSTA-API] DELETE ${compraId}: FALHA HTTP ${result.status}`);
        res.json({ success: false, error: `HTTP ${result.status}: ${erro}` });
      }
    } catch (error) {
      console.error('[PROPOSTA-API] DELETE erro:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/proposta/diagnostico/:compraId
   * Diagnóstico completo: testa cada chamada à API Comprasnet e retorna resultados.
   */
  app.get('/api/proposta/diagnostico/:compraId', async (req, res) => {
    const https = require('https');
    const { compraId } = req.params;
    const token = sniper.getToken();
    const diag = { token: !!token };

    if (!token) return res.json({ success: false, error: 'Sem token', diagnostico: diag });

    // Helper: request via Node https nativo (bypass axios)
    const rawRequest = (method, path, body) => new Promise((resolve) => {
      const bodyStr = body ? JSON.stringify(body) : null;
      const opts = {
        hostname: 'cnetmobile.estaleiro.serpro.gov.br',
        path,
        method,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'Authorization': token,
          'x-device-platform': 'web',
          'x-version-number': '6.0.0',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      };
      const r = https.request(opts, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => resolve({ status: resp.statusCode, data: data.substring(0, 1000) }));
      });
      r.on('error', e => resolve({ status: 0, error: e.message }));
      if (bodyStr) r.write(bodyStr);
      r.end();
    });

    const delay = ms => new Promise(r => setTimeout(r, ms));
    const basePath = `/comprasnet-fase-externa/v1/compras/${compraId}`;

    // 1. GET participacao
    diag['1_GET'] = await rawRequest('GET', `${basePath}/participacao`);
    // Parse flags do GET completo (não do truncado)
    let compraFull = {};
    try {
      const fullGet = await rawRequest('GET', `${basePath}/participacao`);
      compraFull = typeof fullGet.data === 'string' ? JSON.parse(fullGet.data) : fullGet.data;
    } catch(e) {}
    diag.exigeEquidade = compraFull.exigeDeclaracaoEquidadeGenero;
    diag.exigeIntegridade = compraFull.exigeDeclaracaoProgramasIntegridade;

    // Testar tipos para declaracaoEquidadeGenero (boolean causa 400)
    const base = { declaracaoMeEpp: true, declaracaoProgramasIntegridade: true };
    const tests = {
      'A_string_S': { ...base, declaracaoEquidadeGenero: "S" },
      'B_string_N': { ...base, declaracaoEquidadeGenero: "N" },
      'C_string_true': { ...base, declaracaoEquidadeGenero: "true" },
      'D_number_1': { ...base, declaracaoEquidadeGenero: 1 },
      'E_object': { ...base, declaracaoEquidadeGenero: { valor: true } },
    };

    for (const [label, body] of Object.entries(tests)) {
      await delay(2000);
      const r = await rawRequest('POST', `${basePath}/participacao`, body);
      diag[label] = { status: r.status, body: JSON.stringify(body), resp: typeof r.data === 'string' ? r.data.substring(0, 250) : JSON.stringify(r.data).substring(0, 250) };
    }

    res.json({ success: true, compraId, diagnostico: diag });
  });

  /**
   * POST /api/proposta/backfill-chave-pncp
   * Busca chaveCompraPncp via API para participações que não a têm.
   * Foca nos interesses sem compraId — busca nas participações por CNPJ/objeto.
   * Requer Bearer token ativo.
   */
  app.post('/api/proposta/backfill-chave-pncp', async (req, res) => {
    try {
      if (!sniper.temToken()) {
        return res.status(400).json({ success: false, error: 'Sem Bearer token' });
      }

      // Buscar participações sem chaveCompraPncp
      const semChave = db.prepare(`
        SELECT compraId FROM participacoes_comprasnet
        WHERE (chaveCompraPncp IS NULL OR chaveCompraPncp = '') AND ativo = 1
        ORDER BY dataAtualizacao DESC
      `).all();

      let atualizados = 0;
      let erros = 0;
      const maxRequests = Math.min(semChave.length, 50); // Limitar para não gastar rate limit

      for (let i = 0; i < maxRequests; i++) {
        const { compraId } = semChave[i];
        try {
          const { status, data } = await sniper.apiGet(
            `/comprasnet-fase-externa/v1/compras/${compraId}/participacao`
          );
          if (status === 200 && data && data.chaveCompraPncp) {
            db.prepare(`UPDATE participacoes_comprasnet SET chaveCompraPncp = ? WHERE compraId = ?`)
              .run(data.chaveCompraPncp, compraId);
            atualizados++;
          } else if (status === 401 || status === 403 || status === 429) {
            break; // Parar se rate limited ou sem acesso
          }
        } catch (e) {
          erros++;
        }
      }

      console.log(`[BACKFILL] ${atualizados}/${maxRequests} chaveCompraPncp atualizadas (${erros} erros)`);
      res.json({ success: true, atualizados, total: semChave.length, processados: maxRequests, erros });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/proposta/participar-e-listar/:compraId
   * Aceita declarações de participação e depois lista itens via fase-externa.
   * Resolve o 401 em compras na fase de propostas onde o fornecedor ainda não participou.
   *
   * Body (opcional): { declaracaoMeEpp?, declaracaoProgramasIntegridade?, declaracaoEquidadeGenero? }
   */
  app.post('/api/proposta/participar-e-listar/:compraId', async (req, res) => {
    try {
      const { compraId } = req.params;
      if (!sniper.temToken()) {
        return res.status(400).json({ success: false, error: 'Sem Bearer token' });
      }
      if (sniper.tokenExpirado()) {
        return res.status(400).json({ success: false, error: 'Bearer token expirado' });
      }

      const basePath = `/comprasnet-fase-externa/v1/compras/${compraId}`;
      const etapas = [];

      // Passo 1: Verificar participação
      let jaParticipando = false;
      try {
        const { status, data } = await sniper.apiGet(`${basePath}/participacao`);
        etapas.push({ etapa: 'verificar', status, jaParticipando: status === 200 });
        if (status === 200 && data) {
          jaParticipando = true;
          const preview = typeof data === 'string' ? data.substring(0, 500) : JSON.stringify(data).substring(0, 500);
          etapas[etapas.length - 1].body = preview;
        }
      } catch (e) {
        etapas.push({ etapa: 'verificar', erro: e.message });
      }

      // Passo 2: Aceitar declarações se necessário
      if (!jaParticipando) {
        // Verificar se compra exige equidade (da resposta do GET)
        const compraData = etapas[0]?.body ? (() => { try { return JSON.parse(etapas[0].body); } catch(e) { return null; } })() : null;
        const exigeEquidade = compraData?.exigeDeclaracaoEquidadeGenero === true;
        const declBody = {
          declaracaoMeEpp: req.body?.declaracaoMeEpp ?? false,
          declaracaoProgramasIntegridade: req.body?.declaracaoProgramasIntegridade ?? false,
          declaracaoEquidadeGenero: exigeEquidade
            ? (req.body?.declaracaoEquidadeGenero ? 1 : "N")
            : (req.body?.declaracaoEquidadeGenero ? 1 : null),
        };
        try {
          const { status, data } = await sniper.apiPost(`${basePath}/participacao`, declBody);
          etapas.push({ etapa: 'participar', status, sucesso: status >= 200 && status < 300 });
          if (status < 200 || status >= 300) {
            const erro = typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300);
            return res.json({
              success: false,
              error: `Não foi possível aceitar participação (HTTP ${status}): ${erro}`,
              etapas
            });
          }
        } catch (e) {
          etapas.push({ etapa: 'participar', erro: e.message });
          return res.json({ success: false, error: `Erro ao participar: ${e.message}`, etapas });
        }
      }

      // Passo 3: Listar itens via fase-externa (vários paths possíveis)
      const endpointsItens = [
        `${basePath}/itens?situacoes=1,2,3,4`,
        `${basePath}/itens?situacoes=PD,AB,EN`,
        `${basePath}/itens/em-selecao-fornecedores`,
      ];

      // Passo 3b: Se nenhum endpoint de lista funcionar, tentar itens individuais (1..20)
      let tentarItensIndividuais = true;

      for (const path of endpointsItens) {
        try {
          const { status, data } = await sniper.apiGet(path);
          const bodyPreview = typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300);
          etapas.push({ etapa: 'listar-itens', path: path.split('/v1/')[1], status, body: bodyPreview });

          if ((status === 200 || status === 206) && data) {
            const arr = Array.isArray(data) ? data : (data.itens || data.content || []);
            if (arr.length > 0) {
              const itens = arr.map(i => ({
                numero: i.numero || i.identificador || i.sequencialItem,
                descricao: (i.descricao || i.objetoItem || i.descricaoDetalhada || '').substring(0, 300),
                quantidade: i.quantidadeEstimada || i.quantidadeOfertada || i.quantidade || 1,
                unidadeMedida: i.unidadeMedida || i.siglaUnidadeMedida || '',
                valorEstimado: i.valorEstimadoUnitario || i.valorEstimado || i.valorUnitarioEstimado || null,
                valorTotal: i.valorTotalEstimado || null,
                situacao: i.situacao || i.situacaoItem || '',
                criterioJulgamento: i.criterioJulgamento || '',
              }));

              console.log(`[PARTICIPAR-E-LISTAR] ${compraId}: ${itens.length} itens encontrados via ${path.split('/v1/')[1]}`);
              return res.json({ success: true, compraId, itens, etapas });
            }
          }
        } catch (e) {
          etapas.push({ etapa: 'listar-itens', path: path.split('/v1/')[1], erro: e.message });
        }
      }

      // Se fase-externa não retornou, tentar disputa como fallback
      try {
        const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${compraId}/itens`);
        etapas.push({ etapa: 'listar-itens-disputa', status });
        if ((status === 200 || status === 206) && Array.isArray(data) && data.length > 0) {
          const itens = data.map(i => ({
            numero: i.numero || i.identificador,
            descricao: (i.descricao || i.objetoItem || '').substring(0, 300),
            quantidade: i.quantidadeEstimada || i.quantidade || 1,
            unidadeMedida: i.unidadeMedida || '',
            valorEstimado: i.valorEstimadoUnitario || i.valorEstimado || null,
            situacao: i.situacao || i.fase || '',
          }));
          return res.json({ success: true, compraId, itens, etapas, fonte: 'disputa' });
        }
      } catch (e) {
        etapas.push({ etapa: 'listar-itens-disputa', erro: e.message });
      }

      // Passo 3c: Tentar buscar itens individuais (GET .../itens/1, .../itens/2, etc.)
      // Útil quando nenhum endpoint de lista retorna itens (compras na fase PD)
      const itensIndividuais = [];
      for (let n = 1; n <= 30; n++) {
        try {
          const { status, data } = await sniper.apiGet(`${basePath}/itens/${n}/participacao`);
          if (status === 200 && data) {
            itensIndividuais.push({
              numero: data.numero || data.identificador || n,
              descricao: (data.descricao || data.objetoItem || data.descricaoDetalhada || `Item ${n}`).substring(0, 300),
              quantidade: data.quantidadeEstimada || data.quantidadeSolicitada || data.quantidade || 1,
              unidadeMedida: data.unidadeMedida || data.siglaUnidadeMedida || '',
              valorEstimado: data.valorEstimadoUnitario || data.valorEstimado || data.valor || null,
              situacao: data.situacao || data.situacaoItem || '',
              criterioJulgamento: data.criterioJulgamento || '',
              _raw: typeof data === 'object' ? JSON.stringify(data).substring(0, 1500) : '',
            });
          } else if (status === 404 || status === 400) {
            // Não existe mais itens
            break;
          }
          // 401/403/429 = parar para não gastar rate limit
          if (status === 401 || status === 403 || status === 429) break;
        } catch (e) {
          break;
        }
      }

      if (itensIndividuais.length > 0) {
        etapas.push({ etapa: 'itens-individuais', total: itensIndividuais.length });
        console.log(`[PARTICIPAR-E-LISTAR] ${compraId}: ${itensIndividuais.length} itens encontrados via busca individual`);
        return res.json({ success: true, compraId, itens: itensIndividuais, etapas, fonte: 'individual' });
      }

      res.json({ success: false, error: 'Participação aceita mas não foi possível listar itens', etapas });

    } catch (error) {
      console.error('[PARTICIPAR-E-LISTAR] Erro:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/proposta/valores-compra/:compraId
   * Retorna valores salvos em valores_proposta para um compraId (marca, modelo, valor).
   */
  app.get('/api/proposta/valores-compra/:compraId', (req, res) => {
    try {
      const { compraId } = req.params;
      const participacao = db.prepare(
        'SELECT cnpj, ano, sequencial FROM participacoes_comprasnet WHERE compraId = ?'
      ).get(compraId);
      if (!participacao) return res.json({ success: true, valores: {} });

      const rows = db.prepare(`
        SELECT numeroItem, valorUnitario, marca, modelo, fabricante, selecionado
        FROM valores_proposta
        WHERE cnpj = ? AND ano = ? AND sequencial = ?
      `).all(participacao.cnpj, participacao.ano, participacao.sequencial);

      const valores = {};
      for (const v of rows) {
        valores[v.numeroItem] = {
          valor: v.valorUnitario, marca: v.marca || '', modelo: v.modelo || '',
          fabricante: v.fabricante || '', selecionado: v.selecionado === 1,
        };
      }
      res.json({ success: true, valores });
    } catch (error) {
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

  // ==================== PUPPETEER SESSION ====================

  const pSession = getPuppeteerSession();

  // Callback: quando Puppeteer captura um Bearer, atualizar o sniper também
  pSession.onBearerCaptured = (bearer) => {
    sniper.setToken(bearer, 'puppeteer');
    console.log('[Sniper] Bearer recebido do Puppeteer');
  };

  /**
   * Executa lance diretamente via Puppeteer (sem fila).
   * Fallback: enfileira para extensão se Puppeteer não estiver disponível.
   * @returns {{ direto: boolean, resultado?: object, lanceId?: string }}
   */
  async function executarLanceDireto(compraId, itemNumero, valor, faseItem, fonte) {
    const ps = getPuppeteerSession();

    if (ps.state === 'logged_in' && ps.tokenEstaFresco()) {
      // Execução direta via Puppeteer
      const inicio = Date.now();
      try {
        const resultado = ps.enviarLance(compraId, parseInt(itemNumero), valor, faseItem || 'LA');
        // Aguardar resultado (pode ser Promise)
        const res = await resultado;
        const tempoMs = Date.now() - inicio;

        // Gravar no histórico do banco
        try {
          db.prepare(`INSERT INTO sniper_historico
            (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(compraId, parseInt(itemNumero), valor,
              res.httpStatus, res.sucesso ? 1 : 0, tempoMs,
              (res.resposta || '').substring(0, 500),
              (fonte || 'puppeteer'), new Date().toISOString());
        } catch (e) { /* ok se tabela não existir */ }

        return { direto: true, resultado: res };
      } catch (e) {
        console.log(`[Sniper] Puppeteer lance falhou: ${e.message} — fallback para fila`);
      }
    }

    // Fallback: enfileirar para extensão
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const lance = {
      id, compraId, itemNumero: parseInt(itemNumero),
      valor: parseFloat(valor), faseItem: faseItem || 'LA',
      criadoEm: new Date().toISOString(), status: 'pendente',
      fonte: fonte || 'browser',
    };
    filaLances.push(lance);
    return { direto: false, lanceId: id };
  }

  // --- Rotas Puppeteer ---

  app.get('/api/puppeteer/status', (req, res) => {
    try {
      res.json({ success: true, ...pSession.getStatus() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/puppeteer/launch', async (req, res) => {
    try {
      const { headless } = req.body || {};
      const result = await pSession.launch({ headless: headless !== false });
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/puppeteer/login', async (req, res) => {
    try {
      const result = await pSession.login();
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/puppeteer/close', async (req, res) => {
    try {
      const result = await pSession.close();
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/puppeteer/logs', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const logs = pSession.logs.slice(-limit);
      res.json({ success: true, logs });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== TESTE DE CONEXÃO ====================

  /**
   * GET /api/conexao/status
   * Retorna status completo de todas as conexões: servidor, extensão, bearer, Comprasnet.
   */
  app.get('/api/conexao/status', (req, res) => {
    try {
      const sniperStatus = sniper.getStatus();
      const extensaoConectada = !!(ultimoSyncExtensao && (Date.now() - ultimoSyncExtensao) < 5 * 60 * 1000);
      const ps = getPuppeteerSession();
      res.json({
        success: true,
        servidor: { online: true, timestamp: new Date().toISOString() },
        extensao: {
          conectada: extensaoConectada,
          ultimoSync: ultimoSyncExtensao ? new Date(ultimoSyncExtensao).toISOString() : null,
          idadeSegundos: ultimoSyncExtensao ? Math.floor((Date.now() - ultimoSyncExtensao) / 1000) : null,
        },
        bearer: {
          presente: sniperStatus.temToken,
          fonte: sniperStatus.tokenSource,
          idade: sniperStatus.tokenIdade,
          idadeSegundos: sniperStatus.tokenIdadeSegundos,
          expirado: sniperStatus.tokenExpirado,
          recebidoEm: sniperStatus.tokenRecebidoEm,
        },
        captcha: {
          presente: sniperStatus.temCaptcha,
          idade: sniperStatus.captchaIdade,
        },
        puppeteer: {
          state: ps.state,
          loggedIn: ps.state === 'logged_in',
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/conexao/testar-comprasnet
   * Testa a conectividade real com o Comprasnet fazendo um GET /datahorabrasilia.
   * Opcionalmente testa GET participação de uma compra específica.
   * Body: { compraId?: string }
   */
  app.post('/api/conexao/testar-comprasnet', async (req, res) => {
    try {
      if (!sniper.temToken()) {
        return res.json({ success: false, erro: 'sem_bearer', mensagem: 'Sem Bearer token. Abra o Comprasnet com a extensão Token Relay ativa.' });
      }
      if (sniper.tokenExpirado()) {
        return res.json({ success: false, erro: 'bearer_expirado', mensagem: 'Bearer token expirado. Recarregue o Comprasnet.' });
      }

      const testes = [];

      // Teste 1: GET /datahorabrasilia (não requer captcha)
      try {
        const inicio = Date.now();
        const { status, data } = await sniper.apiGet('/comprasnet-disputa/v1/datahorabrasilia');
        const tempoMs = Date.now() - inicio;
        testes.push({
          nome: 'Data/Hora Brasília',
          endpoint: '/comprasnet-disputa/v1/datahorabrasilia',
          status,
          sucesso: status === 200,
          tempoMs,
          resposta: status === 200 ? data : null,
        });
      } catch (e) {
        testes.push({ nome: 'Data/Hora Brasília', sucesso: false, erro: e.message });
      }

      // Teste 2: Se compraId fornecido, testa GET participação
      const { compraId } = req.body || {};
      if (compraId) {
        try {
          const inicio = Date.now();
          const path = `/comprasnet-fase-externa/v1/compras/${compraId}/participacao`;
          const { status, data } = await sniper.apiGet(path);
          const tempoMs = Date.now() - inicio;
          const resumo = status === 200 && data
            ? { situacao: data.situacaoCompraFaseExterna, fase: data.faseCompraFaseExterna, itens: data.itensParticipacao?.length }
            : null;
          testes.push({
            nome: `Participação (${compraId})`,
            endpoint: path,
            status,
            sucesso: status === 200,
            tempoMs,
            resumo,
            erro: status !== 200 ? (typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200)) : null,
          });
        } catch (e) {
          testes.push({ nome: `Participação (${compraId})`, sucesso: false, erro: e.message });
        }
      }

      const todosSucesso = testes.every(t => t.sucesso);
      res.json({
        success: true,
        conectado: todosSucesso,
        bearerIdade: sniper.idadeTokenSegundos() + 's',
        testes,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== FILA DE TAREFAS GENÉRICA ====================

  /**
   * POST /api/tarefas/criar
   * Cria uma tarefa na fila para a extensão executar no browser.
   * Body: { tipo: 'testar-conexao'|'testar-participacao'|'enviar-proposta', dados: {...} }
   */
  app.post('/api/tarefas/criar', (req, res) => {
    try {
      const { tipo, dados } = req.body;
      if (!tipo) return res.status(400).json({ success: false, error: 'tipo obrigatório' });

      const tiposValidos = ['testar-conexao', 'testar-participacao', 'enviar-proposta'];
      if (!tiposValidos.includes(tipo)) {
        return res.status(400).json({ success: false, error: `Tipo inválido. Válidos: ${tiposValidos.join(', ')}` });
      }

      const tarefa = {
        id: ++tarefaIdCounter,
        tipo,
        dados: dados || {},
        status: 'pendente',
        criadoEm: new Date().toISOString(),
        processadoEm: null,
        resultado: null,
      };
      filaTarefas.push(tarefa);

      // Limpar tarefas antigas (> 5 min, já concluídas/falhas)
      const cincoMinAtras = Date.now() - 5 * 60 * 1000;
      filaTarefas = filaTarefas.filter(t =>
        t.status === 'pendente' || t.status === 'processando' ||
        new Date(t.criadoEm).getTime() > cincoMinAtras
      );

      console.log(`[Tarefas] Criada tarefa #${tarefa.id} tipo=${tipo}`);
      res.json({ success: true, id: tarefa.id, status: 'pendente' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/tarefas/pendentes
   * Extensão busca tarefas pendentes (como fila-lances).
   * Marca como 'processando' ao entregar. Cleanup por TTL também aqui — se não houver
   * POST /criar por muito tempo, esta rota ainda limpa tarefas antigas.
   */
  app.get('/api/tarefas/pendentes', (req, res) => {
    const agora = Date.now();
    const TTL_PROCESSANDO_MS = 2 * 60 * 1000;   // 2min stuck = perdida
    const TTL_CONCLUIDA_MS   = 5 * 60 * 1000;   // 5min após concluída

    // Descartar tarefas stuck em 'processando' ou já terminadas há tempo
    filaTarefas = filaTarefas.filter(t => {
      if (t.status === 'pendente') return true;
      if (t.status === 'processando') {
        const idade = agora - new Date(t.criadoEm).getTime();
        return idade < TTL_PROCESSANDO_MS;
      }
      // concluida | falha
      const idade = agora - new Date(t.processadoEm || t.criadoEm).getTime();
      return idade < TTL_CONCLUIDA_MS;
    });

    const pendentes = filaTarefas.filter(t => t.status === 'pendente');
    pendentes.forEach(t => { t.status = 'processando'; });
    res.json({ success: true, tarefas: pendentes, total: filaTarefas.length });
  });

  /**
   * POST /api/tarefas/resultado
   * Extensão reporta resultado de uma tarefa.
   * Body: { id, sucesso, resultado, erro, tempoMs }
   */
  app.post('/api/tarefas/resultado', (req, res) => {
    try {
      const { id, sucesso, resultado, erro, tempoMs } = req.body;
      const tarefa = filaTarefas.find(t => t.id === id);
      if (!tarefa) return res.status(404).json({ success: false, error: 'Tarefa não encontrada' });

      tarefa.status = sucesso ? 'concluida' : 'falha';
      tarefa.resultado = resultado || null;
      tarefa.erro = erro || null;
      tarefa.tempoMs = tempoMs || null;
      tarefa.processadoEm = new Date().toISOString();

      console.log(`[Tarefas] Resultado tarefa #${id}: ${tarefa.status} (${tempoMs}ms)`);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/tarefas/:id
   * Página consulta resultado de uma tarefa.
   */
  app.get('/api/tarefas/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const tarefa = filaTarefas.find(t => t.id === id);
    if (!tarefa) return res.status(404).json({ success: false, error: 'Tarefa não encontrada' });
    res.json({ success: true, tarefa });
  });

  // ==================== HEALTH CHECK PERIÓDICO DO TOKEN ====================

  const HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutos

  setInterval(async () => {
    if (!sniper.temToken() || sniper.tokenExpirado()) return;

    try {
      const validation = await sniper.validateToken(sniper.bearerToken);
      if (!validation.valid && !validation.cached) {
        sniper.log(`💀 Health check: token inválido (HTTP ${validation.status}) — marcando expirado`);
        sniper.forceExpireToken();
        // Limpar cache de validação para que o próximo token não seja cached
        sniper._lastValidatedToken = null;
        sniper._lastValidatedAt = null;
      }
    } catch (e) {
      sniper.log(`⚠️ Health check erro: ${e.message}`);
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  sniper.log('🏥 Health check de token ativado (a cada 2 min)');

  // ===== Recuperação de blitz agendadas após restart =====
  // Roda 2s após o startup para permitir que cache e configs sejam carregados
  setTimeout(() => recuperarBlitzesAgendadas(), 2000);

  async function recuperarBlitzesAgendadas() {
    try {
      const now = Date.now();
      const rows = db.prepare('SELECT * FROM blitz_agendadas ORDER BY alvoMs').all();
      if (rows.length === 0) return;

      // Limpar expiradas
      const expiradas = rows.filter(r => r.alvoMs <= now);
      if (expiradas.length > 0) {
        const stmt = db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?');
        for (const r of expiradas) stmt.run(r.blitzKey);
        console.log(`[BLITZ-RECOVERY] ${expiradas.length} agendamento(s) expirado(s) removido(s)`);
      }

      const ativas = rows.filter(r => r.alvoMs > now);
      if (ativas.length === 0) return;

      console.log(`[BLITZ-RECOVERY] Recuperando ${ativas.length} agendamento(s) pendente(s)`);

      for (const row of ativas) {
        agendarBlitzRecuperada(row);
      }
    } catch (e) {
      console.error('[BLITZ-RECOVERY] Erro:', e.message);
    }
  }

  function agendarBlitzRecuperada(row) {
    const delayMs = row.alvoMs - Date.now();
    if (delayMs <= 0) {
      try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(row.blitzKey); } catch (e) {}
      return;
    }

    const cfgItem = db.prepare('SELECT * FROM sniper_itens WHERE compraId = ? AND itemNumero = ?').get(row.compraId, row.itemNumero);
    if (!cfgItem || !cfgItem.valorMinimo) {
      console.log(`[BLITZ-RECOVERY] ${row.blitzKey} sem config válida — descartando`);
      try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(row.blitzKey); } catch (e) {}
      return;
    }

    // Guard pré-blitz 3s antes
    if (delayMs > 3000) {
      setTimeout(() => {
        iniciarGuard(row.compraId, row.itemNumero);
        logAuto(`🛡️ GUARD pré-blitz (recuperado) ativado para ${row.compraId} item ${row.itemNumero}`);
      }, delayMs - 3000);
    }

    const timer = setTimeout(async () => {
      try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(row.blitzKey); } catch (e) {}
      await executarBlitzRecuperada(row, cfgItem);
    }, delayMs);

    blitzAgendadas[row.blitzKey] = {
      timer, horario: row.horario, compraId: row.compraId, itemNumero: row.itemNumero,
      maxLances: row.maxLances, modoBlitz: row.modoBlitz, agendadoEm: row.agendadoEm,
    };

    console.log(`[BLITZ-RECOVERY] ${row.compraId} item ${row.itemNumero} reagendado para ${row.horario} (em ${Math.round(delayMs/1000)}s)`);
    logAuto(`⏰ BLITZ RECUPERADA: ${row.compraId} item ${row.itemNumero} para ${row.horario}`);
  }

  async function executarBlitzRecuperada(row, cfgItem) {
    let cached = disputasCache.disputas.find(d => d.compraId === row.compraId);
    let liveItem = cached && cached.itens ? cached.itens.find(i => i.numero === row.itemNumero) : null;

    // Refresh API se faltar tipoVariacao (cache antigo sem o campo)
    if (liveItem && liveItem.tipoVariacao == null && sniper.temToken()) {
      try {
        const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${row.compraId}/itens/em-disputa`);
        if ((status === 200 || status === 206) && Array.isArray(data)) {
          const apiItem = data.find(i => (i.numero || i.identificador) === row.itemNumero);
          if (apiItem) {
            liveItem.variacaoMinima = apiItem.variacaoMinimaEntreLances ?? liveItem.variacaoMinima;
            liveItem.tipoVariacao = apiItem.tipoVariacaoMinimaEntreLances || liveItem.tipoVariacao;
            liveItem.melhorValor = (apiItem.melhorValorGeral || {}).valorInformado ?? liveItem.melhorValor;
            liveItem.nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado ?? liveItem.nossoValor;
            liveItem.situacaoParticipante = apiItem.situacaoParticipanteDisputa || liveItem.situacaoParticipante;
            logAuto(`🔄 BLITZ-RECOVERY refresh: ${row.compraId} item ${row.itemNumero} — varMin=${liveItem.variacaoMinima} tipo=${liveItem.tipoVariacao}`);
          }
        }
      } catch (e) {}
    }

    // Se ainda não há dados live, tentar fetch completo
    if (!liveItem || liveItem.nossoValor == null) {
      if (sniper.temToken()) {
        try {
          const d = await fetchItensDirecto(row.compraId);
          if (d) {
            liveItem = d.itens.find(i => i.numero === row.itemNumero);
          }
        } catch (e) {}
      }
    }

    if (!liveItem || liveItem.nossoValor == null) {
      console.log(`[BLITZ-RECOVERY] ${row.compraId} item ${row.itemNumero} — sem live data, abortando`);
      logAuto(`🚀 BLITZ-RECOVERY: ${row.compraId} item ${row.itemNumero} — sem live data, abortando`);
      return;
    }

    const itemParaCalculo = {
      ...liveItem,
      variacaoMinima: liveItem.variacaoMinima != null ? liveItem.variacaoMinima : cfgItem.variacaoMinima,
      tipoVariacao: liveItem.tipoVariacao || cfgItem.tipoVariacao || 'V',
    };

    const batchLances = calcularBatchLances(cfgItem, itemParaCalculo, row.compraId, row.maxLances || 50, row.modoBlitz || 'cobrir');
    if (batchLances.length === 0) {
      console.log(`[BLITZ-RECOVERY] ${row.compraId} item ${row.itemNumero} — 0 lances calculados`);
      return;
    }

    blitzDisparados[row.blitzKey] = Date.now();
    delete blitzAgendadas[row.blitzKey];

    const vi = itemParaCalculo.nossoValor.toFixed(2);
    const vf = batchLances[batchLances.length - 1].valor.toFixed(2);
    console.log(`[BLITZ-RECOVERY] DIRETO: ${row.compraId} item ${row.itemNumero} — ${batchLances.length} lances (R$${vi} → R$${vf})`);
    logAuto(`🚀 BLITZ-RECOVERY DIRETO: ${row.compraId} item ${row.itemNumero} — ${batchLances.length} lances`);

    let sucessos = 0, falhas = 0;
    for (const lance of batchLances) {
      try {
        const resultado = await sniper.enviarLance(row.compraId, row.itemNumero, lance.valor, lance.faseItem || 'LA');
        const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
        try {
          db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.compraId, row.itemNumero, lance.valor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'blitz-servidor', new Date().toISOString());
        } catch (e) {}
        if (resultado.sucesso) sucessos++;
        else { falhas++; if (resultado.status === 422 || resultado.status === 401) break; }
      } catch (e) { falhas++; break; }
    }
    console.log(`[BLITZ-RECOVERY] DIRETO resultado: ${row.compraId} item ${row.itemNumero} — ${sucessos} ✅ ${falhas} ❌`);
    iniciarGuard(row.compraId, row.itemNumero);
  }

} // end registrarRotasSniper

function getSniper() {
  return sniper;
}

module.exports = { registrarRotasSniper, getSniper, getPuppeteerSession };
