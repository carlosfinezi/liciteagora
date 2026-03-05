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

  /**
   * A1: Pré-calcula TODOS os degraus de lance de nossoValor até valorMinimo.
   * Retorna array de lances prontos para enfileirar.
   */
  function calcularBatchLances(cfgItem, liveItem, compraId) {
    const nossoValor = liveItem.nossoValor;
    const melhorValor = liveItem.melhorValor;
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

      // Skip values that match melhorValor (Comprasnet rejects duplicate values from other suppliers)
      if (melhorValor != null && novoValor === Math.round(melhorValor * 100) / 100) {
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
          // Buscar filtros extras (3=perdendo, 4=enc.aleatória, 5=2min)
          const filterMeta = {};
          if (qtdes && qtdes.qtdeItensEmDisputa > 0) {
            const filtrosExtras = [
              { filtro: 3, campo: 'perdendo' },
              { filtro: 4, campo: 'encAleat' },
              { filtro: 5, campo: 'doisMin' },
            ];
            const filtroNomes = { 3: 'perdendo', 4: 'enc.aleat', 5: '2min' };
            for (const fe of filtrosExtras) {
              try {
                const fRes = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa?tamanhoPagina=50&pagina=0&filtro=${fe.filtro}`);
                if ((fRes.status === 200 || fRes.status === 206) && Array.isArray(fRes.data)) {
                  // LOG detalhado
                  const fItens = fRes.data.map(fi => ({
                    num: fi.numero || fi.identificador,
                    fase: fi.fase,
                    sit: fi.situacaoParticipanteDisputa,
                    fimContagem: fi.dataHoraFimContagem,
                    sitAposContagem: fi.situacaoAposContagem,
                    melhor: (fi.melhorValorGeral || {}).valorInformado,
                    nosso: (fi.melhorValorFornecedor || {}).valorInformado,
                  }));
                  logAuto(`FILTRO=${fe.filtro} (${filtroNomes[fe.filtro]}) ${compraId}: ${fRes.data.length} itens — ${JSON.stringify(fItens)}`);

                  for (const fi of fRes.data) {
                    const fNum = fi.numero || fi.identificador;
                    if (fNum != null) {
                      if (!filterMeta[fNum]) filterMeta[fNum] = {};
                      filterMeta[fNum][fe.campo] = true;
                    }
                  }
                } else {
                  logAuto(`FILTRO=${fe.filtro} (${filtroNomes[fe.filtro]}) ${compraId}: HTTP ${fRes.status} (sem dados)`);
                }
              } catch (e) {
                logAuto(`FILTRO=${fe.filtro} (${filtroNomes[fe.filtro]}) ${compraId}: ERRO ${e.message}`);
              }
            }
          }

          const itens = data.map(i => {
            const num = i.numero || i.identificador;
            const fm = (num != null && filterMeta[num]) ? filterMeta[num] : {};
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
              estaPerdendo: !!fm.perdendo,
              emEncAleatoria: !!fm.encAleat,
              nosDoisMinFinais: !!fm.doisMin,
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

            // Check if already in filaLances (pendente or processando)
            const jaEnfileirado = filaLances.some(l =>
              l.compraId === compraId &&
              l.itemNumero === cfgItem.itemNumero &&
              (l.status === 'pendente' || l.status === 'processando')
            );
            if (jaEnfileirado) continue;

            // MODO CONTÍNUO: lance único reativo — envia UM degrau por vez, espera resultado, re-avalia
            if (cfgItem.modoAuto === 'continuo') {
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
                    const id = `cont-init-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
                    filaLances.push({
                      id, compraId, itemNumero: cfgItem.itemNumero,
                      valor: initVal, faseItem: cfgItem.faseItem || 'LA',
                      criadoEm: new Date().toISOString(), status: 'pendente', fonte: 'auto-continuo',
                    });
                    autoLanceStats.lancesEnviados++;
                    logAuto(`CONTÍNUO INIT: ${compraId} item ${cfgItem.itemNumero} — R$${initVal.toFixed(2)} (primeiro lance grupo)`);
                    continue;
                  }
                }
                if (logDiag) logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — dados insuficientes (nosso=${nossoValor}, var=${varMinEfetivo})`);
                continue;
              }

              let novoValor;
              if (nossoValor != null && varMinEfetivo != null) {
                // Calcular próximo degrau a partir do nosso valor atual
                if (tipoVarEfetivo === 'P') {
                  novoValor = nossoValor * (1 - varMinEfetivo / 100);
                } else {
                  novoValor = nossoValor - varMinEfetivo;
                }
                novoValor = Math.round(novoValor * 100) / 100;
                if (novoValor < cfgItem.valorMinimo) novoValor = cfgItem.valorMinimo;
                if (novoValor >= nossoValor) continue; // sem espaço para baixar

                // Não enviar valor igual ao melhor (Comprasnet rejeita duplicata de outro fornecedor)
                if (melhorGeral != null && novoValor === Math.round(melhorGeral * 100) / 100) {
                  if (tipoVarEfetivo === 'P') {
                    novoValor = novoValor * (1 - varMinEfetivo / 100);
                  } else {
                    novoValor = novoValor - varMinEfetivo;
                  }
                  novoValor = Math.round(novoValor * 100) / 100;
                  if (novoValor < cfgItem.valorMinimo) novoValor = cfgItem.valorMinimo;
                }
              }

              if (novoValor <= 0) continue;

              const id = `cont-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
              filaLances.push({
                id,
                compraId,
                itemNumero: cfgItem.itemNumero,
                valor: novoValor,
                faseItem: cfgItem.faseItem || 'LA',
                criadoEm: new Date().toISOString(),
                status: 'pendente',
                fonte: 'auto-continuo',
              });
              autoLanceStats.lancesEnviados++;

              const flagsStr = [estaPerdendo && 'PERDENDO', emEncAleatoria && 'ENC.ALEATORIA', nosDoisMinFinais && '2MIN'].filter(Boolean).join(' ');
              logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — R$${(nossoValor||0).toFixed(2)} → R$${novoValor.toFixed(2)} ` +
                `(melhor=${melhorGeral != null ? 'R$'+melhorGeral.toFixed(2) : '?'}, var ${tipoVarEfetivo}=${varMinEfetivo}, min=R$${cfgItem.valorMinimo})` +
                `${flagsStr ? ' [' + flagsStr + ']' : ''}`);
              continue;
            }

            // Fallback: lance único (primeiro lance sem nossoValor, ou caso especial)
            let novoLance;
            if (nossoValor != null && varMin != null) {
              if (tipoVar === 'P') {
                novoLance = nossoValor * (1 - varMin / 100);
              } else {
                novoLance = nossoValor - varMin;
              }
              novoLance = Math.round(novoLance * 100) / 100;
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
    // Limpar lances travados em 'processando' há mais de 30s (extensão não respondeu)
    const agora = Date.now();
    for (let i = filaLances.length - 1; i >= 0; i--) {
      const l = filaLances[i];
      if (l.status === 'processando' && l.processandoDesde && agora - l.processandoDesde > 30000) {
        logAuto(`⚠️ Lance ${l.id} travado em processando há 30s — removendo (item ${l.itemNumero})`);
        filaLances.splice(i, 1);
      }
    }

    const pendentes = filaLances.filter(l => l.status === 'pendente');
    // Marcar como "processando" com timestamp
    pendentes.forEach(l => { l.status = 'processando'; l.processandoDesde = agora; });

    // A4: Determine poll interval based on proximity to end
    let pollIntervalMs = 5000; // default
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

    res.json({ success: true, lances: pendentes, total: filaLances.length, pollIntervalMs });
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

      // Update disputasCache with nossoValor
      if (compraId && itemNumero != null) {
        const cachedD = disputasCache.disputas.find(d => d.compraId === compraId);
        if (cachedD && cachedD.itens) {
          if (sucesso) {
            // Lance succeeded — set nossoValor to the value we sent
            let cachedItem = cachedD.itens.find(i => i.numero === parseInt(itemNumero));
            if (cachedItem) {
              cachedItem.nossoValor = parseFloat(valor);
            } else {
              // Sub-item not in cache yet — add it with lance data
              const grupoItem = cachedD.itens.find(i => i.numero === -1 || i.tipo === 'G');
              if (grupoItem) {
                cachedD.itens.push({
                  numero: parseInt(itemNumero),
                  tipo: 'S',
                  melhorValor: null,
                  nossoValor: parseFloat(valor),
                  variacaoMinima: grupoItem.variacaoMinima,
                  tipoVariacao: grupoItem.tipoVariacao,
                  fimContagem: grupoItem.fimContagem,
                  podeEnviar: grupoItem.podeEnviar,
                  fase: grupoItem.fase,
                  estaPerdendo: false,
                  emEncAleatoria: grupoItem.emEncAleatoria || false,
                  nosDoisMinFinais: grupoItem.nosDoisMinFinais || false,
                });
                console.log(`[Sniper] Cache: added sub-item ${itemNumero} to grupo ${compraId} nosso=R$${valor}`);
              }
            }
          } else if (status === 422 && resposta && resposta.includes('melhor que seu')) {
            // 422 "deve ser melhor que seu último lance" — our real position is already
            // at or below the attempted value. Update nossoValor so contínuo steps down.
            let cachedItem = cachedD.itens.find(i => i.numero === parseInt(itemNumero));
            if (cachedItem) {
              const tentado = parseFloat(valor);
              if (cachedItem.nossoValor == null || tentado < cachedItem.nossoValor) {
                console.log(`[Sniper] Cache: 422 "melhor que seu" — ajustando nossoValor item ${itemNumero} de R$${cachedItem.nossoValor} para R$${tentado} (real já é ≤ este valor)`);
                cachedItem.nossoValor = tentado;
              }
            }
          }
        }
      }

      // Auto-lance pending cleanup
      // A5: Blitz and auto-continuo lances bypass cooldown
      const pendingKey = `${compraId}-${itemNumero}`;
      const lanceObj = idx >= 0 ? filaLances[idx] : null;
      const isBatch = lanceObj && (lanceObj.fonte === 'blitz' || lanceObj.fonte === 'auto-continuo');

      if (sucesso) {
        if (isBatch) {
          // Batch (blitz/contínuo): no cooldown — next lance comes immediately
          delete autoLancePendentes[pendingKey];
        } else {
          // Normal: keep cooldown on success (prevent re-bidding immediately)
          autoLancePendentes[pendingKey] = Date.now();
        }
      } else {
        // Clear pending on failure so auto-lance can retry
        delete autoLancePendentes[pendingKey];
      }

      // Limpar da fila imediatamente para contínuo (liberar jaEnfileirado), senão delay normal
      const isContínuo = lanceObj && lanceObj.fonte === 'auto-continuo';
      if (isContínuo) {
        // Remover imediatamente para desbloquear próximo lance
        const i2 = filaLances.findIndex(l => l.id === id);
        if (i2 >= 0) filaLances.splice(i2, 1);
      } else {
        setTimeout(() => {
          const i = filaLances.findIndex(l => l.id === id);
          if (i >= 0) filaLances.splice(i, 1);
        }, isBatch ? 5000 : 30000);
      }

      // A6: Reactive trigger — after result, run cycle immediately (success) or with delay (failure)
      if (autoLanceAtivo) {
        if (sucesso) {
          setImmediate(() => executarCicloAutoLance(true));
        } else if (isContínuo) {
          // Contínuo failure: retry after 3s delay (nossoValor already adjusted above)
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

        // Update disputasCache with nossoValor
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
                }
              }
            } else if (status === 422 && resposta && resposta.includes('melhor que seu')) {
              // 422 "deve ser melhor que seu último lance" — update nossoValor so contínuo steps down
              let cachedItem = cachedD.itens.find(i => i.numero === parseInt(itemNumero));
              if (cachedItem) {
                const tentado = parseFloat(valor);
                if (cachedItem.nossoValor == null || tentado < cachedItem.nossoValor) {
                  console.log(`[Sniper] Cache batch: 422 "melhor que seu" — ajustando nossoValor item ${itemNumero} de R$${cachedItem.nossoValor} para R$${tentado}`);
                  cachedItem.nossoValor = tentado;
                }
              }
            }
          }
        }

        // Cooldown: blitz and auto-continuo lances bypass
        const pendingKey = `${compraId}-${itemNumero}`;
        const lanceObj = idx >= 0 ? filaLances[idx] : null;
        const isBatch = lanceObj && (lanceObj.fonte === 'blitz' || lanceObj.fonte === 'auto-continuo');
        if (sucesso) {
          if (isBatch) {
            delete autoLancePendentes[pendingKey];
          } else {
            autoLancePendentes[pendingKey] = Date.now();
          }
        } else {
          delete autoLancePendentes[pendingKey];
        }

        // Clean from queue — contínuo limpa imediato para liberar jaEnfileirado
        const isContínuo = lanceObj && lanceObj.fonte === 'auto-continuo';
        if (isContínuo) {
          const i2 = filaLances.findIndex(l => l.id === id);
          if (i2 >= 0) filaLances.splice(i2, 1);
        } else {
          setTimeout(() => {
            const i = filaLances.findIndex(l => l.id === id);
            if (i >= 0) filaLances.splice(i, 1);
          }, isBatch ? 5000 : 30000);
        }
      }

      // Trim results history
      if (resultadosLances.length > 50) resultadosLances.length = 50;
      if (sniper.historico.length > 50) sniper.historico.length = 50;

      console.log(`[Sniper] Batch resultado: ${sucessos} ✅ ${falhas} ❌ (${resultados.length} total)`);

      // Reactive trigger after batch
      if (autoLanceAtivo) {
        if (sucessos > 0) {
          setImmediate(() => executarCicloAutoLance(true));
        } else if (falhas > 0) {
          // Delay on failure to avoid hammering (nossoValor already adjusted above)
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
          const uasg = String(compra.numeroUasg || '').padStart(6, '0');
          const mod = String(compra.modalidade || '').padStart(2, '0');
          const num = String(compra.numero || '').padStart(5, '0');
          const ano = String(compra.ano || '');
          const compraId = compra.compraId || (uasg + mod + num + ano);
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
              variacaoMinima, tipoVariacao } = req.body;
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
          // Se tem itensParticipacao ou situação indica participação ativa
          jaParticipando = true;
          sniper.log(`ℹ️ Compra: situacao=${compraInfo.situacaoCompraFaseExterna}, fase=${compraInfo.faseCompraFaseExterna}, exigeEquidade=${compraInfo.exigeDeclaracaoEquidadeGenero}`);
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
            resultados.push({ fase: 'declaracoes', sucesso: true, status: 200, info: 'Já participando' });
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

      // Salvar status no banco apenas se houve sucesso
      if (sucessos > 0) {
        try {
          db.prepare(`UPDATE participacoes_comprasnet SET situacao = 'PE', dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ?`).run(compraId);
        } catch (e) {}
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
