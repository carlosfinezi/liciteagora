// pncp-sync-scheduler.js
//
// Motor de sincronização PNCP + schedulers master-only correlatos.
// Extraído de server.js em NFSE-M06 onda 5C passo 2 (2026-04-20).
//
// Conteúdo:
//   - syncStatus (shared state in-memory)
//   - sincronizarCompleta / sincronizarIncremental / agendarProximaSync
//   - iniciarWatchdogSync (alerta Telegram se sync parar por >15min)
//   - verificarAlertasDisputa (30min antes do início) + timer
//   - agendarVerificacaoDiaria (às 03:00) + execução da verificacaoCompletaDiaria
//
// Uso no master (via scheduler.js):
//   const pncpSync = require('./pncp-sync-scheduler');
//   pncpSync.init({ db, processarFilaAnalise });
//   pncpSync.iniciarSyncEngine();       // dispara sync inicial + agenda
//   pncpSync.startMasterOnlyTimers();   // watchdog + disputa + verificação diária
//
// Uso no worker (server.js):
//   const pncpSync = require('./pncp-sync-scheduler');
//   pncpSync.init({ db, processarFilaAnalise });
//   // NÃO chama iniciarSyncEngine/startMasterOnlyTimers; só usa getSyncStatus()
//   // para GET /api/sync/status e rejeita POST /api/sync/* com 503.
//
// Nota sobre syncStatus no worker: fica sempre zerado (running=false,
// progress=0) porque o worker não executa sync. Para fidelidade no UI,
// GET /api/sync/status consome campos persistidos (lastFullSync,
// lastIncrementalSync em config) — in-memory só serve pro master.

const axios = require('axios');
const { createPersistence, salvarLicitacaoPg, salvarItensPg } = require('./licitacoes-persistence');
const { sendTelegram } = require('./telegram-client');
const { criarVerificador } = require('./verificacao-lacunas');

// NFSE-M06 onda 6.45 (2026-04-20): PNCP_API_BASE/PNCP_API_ITENS
// migrados para require('./config') -- unica fonte de verdade.
const { PNCP_API_BASE, PNCP_API_ITENS } = require('./config');
const SYNC_INTERVAL_MINUTES = 5;
// Sweep de reconciliação por dataAtualizacaoGlobal (edições do órgão em
// licitações já publicadas — ex.: mudança de data de encerramento). O sweep
// por publicação não revisita o dia da publicação, então edições posteriores
// ficavam invisíveis. Roda master-only, serializado com o sync via
// syncStatus.running (nunca curl PNCP em paralelo).
const ATUALIZACAO_SWEEP_HORA = Number(process.env.PNCP_ATUALIZACAO_SWEEP_HORA || 4); // 1x/dia, 04h

// ============== Estado do módulo ==============
let _db = null;
let _salvarLicitacao = null;
let _salvarItens = null;
let _verificarECorrigirLacunas = null;
let _verificacaoCompletaDiaria = null;
let _processarFilaAnalise = null;

let syncStatus = {
  running: false,
  type: '',
  progress: 0,
  total: 0,
  currentDay: '',
  lastSync: null,
  lastIncrementalSync: null,
  licitacoesCount: 0,
  itensCount: 0,
  nextScheduledSync: null
};

let syncInterval = null;
let atualizacaoSweepTimer = null;
let ultimoAlertaSyncEnviado = null;
let disputaAlertInterval = null;
let disputaAlertBootTimer = null;
let verificacaoDiariaTimer = null;

// ============== init / helpers ==============

/**
 * Bootstrap do módulo. Deve ser chamado antes de qualquer outra função.
 * Cria persistência + verificador e guarda referências em closures.
 *
 * @param {object} opts
 * @param {BetterSqlite3.Database} opts.db — DB aberto em WAL.
 * @param {function} [opts.processarFilaAnalise] — opcional, de ./analise-ia;
 *   se ausente, dispararAnaliseIA vira no-op silencioso.
 */
function init({ db, processarFilaAnalise }) {
  if (!db) throw new Error('pncp-sync-scheduler.init: db obrigatório');
  _db = db;

  const { salvarLicitacao, salvarItens } = createPersistence(db);
  _salvarLicitacao = salvarLicitacao;
  _salvarItens = salvarItens;

  // Fase 3c (2026-05-23): se CATALOG_BACKEND_PG=1, sync escreve no Postgres.
  // Funciona como wrapper que decide entre versão sync (sqlite) e async (pg)
  // — chamadas do sync wrapper retornam Promise, callsites usam await.
  if (process.env.CATALOG_BACKEND_PG === '1') {
    console.log('[pncp-sync] usando catalog Postgres pra escritas (CATALOG_BACKEND_PG=1)');
    _salvarLicitacao = (lic) => salvarLicitacaoPg(lic);  // async
    _salvarItens = (n, itens) => salvarItensPg(n, itens); // async
    // Warmup async em background — preenche cache antes que getConfigValue
    // seja chamado pelo watchdog/sync. Boot do master é 60-90s, então há
    // sobra de tempo. Falhas são logadas mas não bloqueiam init.
    warmupPgConfig();
  }

  const ver = criarVerificador(db, _salvarLicitacao, _salvarItens);
  _verificarECorrigirLacunas = ver.verificarECorrigirLacunas;
  _verificacaoCompletaDiaria = ver.verificacaoCompletaDiaria;

  _processarFilaAnalise = processarFilaAnalise || null;
}

function _ensureInit() {
  if (!_db) throw new Error('pncp-sync-scheduler: chame init({ db }) antes.');
}

// Fase 8 (2026-04-22): sync state migrou de `config` (por tenant) para
// `catalog_sync_state` (global, catalog.db). No master, _db é o próprio
// catalog.db (tabela direta). No worker, _db é o tenant DB com ATTACH
// catalog — a TEMP VIEW catalog_sync_state (criada por attachCatalog)
// resolve SELECT. Writes via worker não acontecem (só o master escreve).
// Fase 3c (2026-05-23): catalog_sync_state pode estar no PG. Quando
// CATALOG_BACKEND_PG=1, lê/escreve direto no Postgres.
function getConfigValue(chave) {
  _ensureInit();
  if (process.env.CATALOG_BACKEND_PG === '1') {
    // Sync→async bridge não rola aqui (callers são sync). Cache em memória
    // populado por bootstrap; mas como esse path só é chamado em pontos
    // que já são async (ou no startup), expomos versão sync que faz
    // deasync-style? Não. Solução: getConfigValue mantém sync para SQLite,
    // PG-mode usa o cache populado por warmup. Se cache miss, retorna null.
    return _pgConfigCache.get(chave) || null;
  }
  const row = _db.prepare(`SELECT value AS valor FROM catalog_sync_state WHERE key = ?`).get(chave);
  return row ? row.valor : null;
}

function setConfigValue(chave, valor) {
  _ensureInit();
  const v = String(valor == null ? '' : valor);
  if (process.env.CATALOG_BACKEND_PG === '1') {
    _pgConfigCache.set(chave, v);
    // fire-and-forget (writes não são críticos pra latência do caller; logs vão pra console)
    require('./catalog-pg').execute(
      `INSERT INTO catalog_sync_state ("key","value","updated_at") VALUES ($1,$2,$3)
       ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value", "updated_at"=EXCLUDED."updated_at"`,
      [chave, v, Date.now()]
    ).catch(err => console.error('[PG] setConfigValue err:', err.message));
    return;
  }
  _db.prepare(
    `INSERT INTO catalog_sync_state (key, value, updated_at) VALUES (?, ?, ?) ` +
    `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(chave, v, Date.now());
}

// Cache PG-only de catalog_sync_state. Populado por warmupPgConfig() no init.
const _pgConfigCache = new Map();
async function warmupPgConfig() {
  if (process.env.CATALOG_BACKEND_PG !== '1') return;
  const catalogPg = require('./catalog-pg');
  try {
    const rows = await catalogPg.query(`SELECT "key","value" FROM catalog_sync_state`);
    for (const r of rows) _pgConfigCache.set(r.key, r.value);
    console.log(`[pncp-sync] warmup PG config: ${rows.length} chaves`);
  } catch (err) {
    console.error('[pncp-sync] warmup PG config falhou:', err.message);
  }
}

function gerarDiasEntre(dataInicial, dataFinal) {
  const dias = [];
  const inicio = new Date(dataInicial);
  const fim = new Date(dataFinal);
  for (let d = new Date(inicio); d <= fim; d.setDate(d.getDate() + 1)) {
    dias.push(d.toISOString().split('T')[0]);
  }
  return dias;
}

// ============== PNCP API ==============

// PNCP API tem load balancer com servidor backend doente — ~50% das chamadas
// caem num node que dá timeout. Estratégia:
//   - timeout curto (6s) pra falhar rápido em vez de esperar 30s do default
//   - retry imediato até MAX_RETRIES_PAGINA na MESMA página (cai em servidor
//     diferente do pool; testes mostram 3-5 tentativas resolvem >95%)
//   - só pula a página após esgotar retries (não aborta o dia inteiro)
//   - abort-dia só se MAX_FALHAS_PAGINAS_SEGUIDAS páginas consecutivas
//     esgotarem retries — indica problema sistêmico, não LB ruim
const PAGINA_TIMEOUT_MS = 6000;
const MAX_RETRIES_PAGINA = 5;
const MAX_FALHAS_PAGINAS_SEGUIDAS = 3;

// endpoint: 'publicacao' (default, varre por data de publicação) ou
// 'atualizacao' (varre por dataAtualizacaoGlobal — pega edições posteriores).
// Os dois retornam o MESMO objeto de contratação e a mesma paginação, então
// todo o resto (retry/abort/cap de 200 páginas) é compartilhado.
// opts (default = comportamento histórico do incremental, zero mudança):
//   timeoutMs    — timeout por página (default PAGINA_TIMEOUT_MS=6000)
//   maxRetries   — tentativas por página (default MAX_RETRIES_PAGINA=5)
//   backoffMs    — se >0, espera backoffMs*tentativa entre retries (anti-429).
//                  O incremental usa 0 (retry imediato, conta com o LB). O sweep
//                  de atualização passa backoff porque o /atualizacao em volume
//                  dispara rate-limit (429/timeout) no IP do servidor.
//   pacingMs     — espera entre páginas com sucesso (default 50)
async function buscarLicitacoesDoDia(dia, modalidade, endpoint = 'publicacao', opts = {}) {
  const timeoutMs = opts.timeoutMs || PAGINA_TIMEOUT_MS;
  const maxRetries = opts.maxRetries || MAX_RETRIES_PAGINA;
  const backoffMs = opts.backoffMs || 0;
  const pacingMs = opts.pacingMs || 50;
  const resultados = [];
  let paginaAtual = 1;
  let temMaisPaginas = true;
  let paginasFalhasSeguidas = 0;
  const diaAPI = dia.replace(/-/g, '');

  while (temMaisPaginas && paginaAtual <= 200) {
    let sucesso = false;
    let ultimoErro = null;
    let parou = false;  // 4xx etc → fim natural

    for (let tentativa = 1; tentativa <= maxRetries; tentativa++) {
      try {
        const response = await axios.get(`${PNCP_API_BASE}/contratacoes/${endpoint}`, {
          params: {
            dataInicial: diaAPI,
            dataFinal: diaAPI,
            codigoModalidadeContratacao: modalidade,
            pagina: paginaAtual,
            tamanhoPagina: 50
          },
          headers: { 'Accept': 'application/json' },
          timeout: timeoutMs
        });

        if (response?.data?.data?.length > 0) {
          resultados.push(...response.data.data);
          sucesso = true;
        } else {
          // 204 ou data vazia = fim do range
          temMaisPaginas = false;
          parou = true;
          sucesso = true;
        }
        break;
      } catch (err) {
        if (err.response?.status === 400 || err.response?.status === 422) {
          temMaisPaginas = false;
          parou = true;
          sucesso = true;
          break;
        }
        ultimoErro = err;
        // 429/timeout: com backoff, espera antes de tentar de novo (dá tempo do
        // rate-limit do IP aliviar). Sem backoff = retry imediato (incremental).
        if (backoffMs > 0 && tentativa < maxRetries) {
          await new Promise(r => setTimeout(r, backoffMs * tentativa));
        }
      }
    }

    if (sucesso) {
      paginasFalhasSeguidas = 0;
      paginaAtual++;
      if (parou) break;
      await new Promise(r => setTimeout(r, pacingMs));
    } else {
      paginasFalhasSeguidas++;
      console.warn(`Erro ${dia} mod ${modalidade} pag ${paginaAtual} (após ${maxRetries} retries): ${ultimoErro?.message}`);
      if (paginasFalhasSeguidas >= MAX_FALHAS_PAGINAS_SEGUIDAS) {
        console.warn(`[abort-dia] ${dia} mod ${modalidade}: ${paginasFalhasSeguidas} páginas seguidas esgotaram retries. Pulando dia.`);
        // Registra em bi_aborts pra retry posterior (cron noturno). Best-effort.
        const motivoAbort = `${paginasFalhasSeguidas} retries: ${ultimoErro?.message?.substring(0, 80) || 'unknown'}`;
        if (process.env.CATALOG_BACKEND_PG === '1') {
          require('./catalog-pg').execute(
            `INSERT INTO bi_aborts ("dia","modalidade","servidor","motivo") VALUES ($1,$2,'principal',$3) ON CONFLICT DO NOTHING`,
            [dia, modalidade, motivoAbort]
          ).catch(() => {});
        } else {
          try {
            _db.prepare(`INSERT OR IGNORE INTO bi_aborts (dia, modalidade, servidor, motivo) VALUES (?, ?, 'principal', ?)`)
               .run(dia, modalidade, motivoAbort);
          } catch (_) { /* tabela pode não existir em ambiente legado */ }
        }
        break;
      }
      paginaAtual++;  // pula essa página, tenta a próxima
    }
  }

  return resultados;
}

async function buscarItensLicitacao(cnpj, ano, sequencial) {
  try {
    const todosItens = [];
    let pagina = 1;
    let temMais = true;

    while (temMais) {
      const response = await axios.get(
        `${PNCP_API_ITENS}/orgaos/${cnpj}/compras/${ano}/${sequencial}/itens`,
        {
          params: { pagina, tamanhoPagina: 100 },
          headers: { 'Accept': 'application/json' },
          timeout: 15000
        }
      );
      const itens = response.data || [];
      // Guard: o WAF do PNCP às vezes devolve uma página HTML de bloqueio
      // ("Request Rejected") com HTTP 200. Sem isto, `push(...string)` espalharia
      // o HTML caractere a caractere, criando itens com todos os campos NULL.
      if (!Array.isArray(itens)) {
        throw new Error('resposta de itens não é array (provável bloqueio WAF do PNCP)');
      }
      if (itens.length > 0) {
        todosItens.push(...itens);
        pagina++;
        if (itens.length < 100) temMais = false;
      } else {
        temMais = false;
      }
    }
    return todosItens;
  } catch (err) {
    return [];
  }
}

// ============== Análise IA (opcional) ==============

function getIAKeys() {
  const cerebras = getConfigValue('cerebras_api_key');
  const gemini = getConfigValue('gemini_api_key');
  const deepseek = getConfigValue('deepseek_api_key');
  const groq = getConfigValue('groq_api_key');
  const anthropic = getConfigValue('anthropic_api_key');
  if (!cerebras && !gemini && !deepseek && !groq && !anthropic) return null;
  return {
    cerebras: cerebras || null,
    gemini: gemini || null,
    deepseek: deepseek || null,
    groq: groq || null,
    anthropic: anthropic || null,
  };
}

function dispararAnaliseIA() {
  if (!_processarFilaAnalise) return;
  const keys = getIAKeys();
  if (!keys) return;
  setTimeout(async () => {
    try {
      const processadas = await _processarFilaAnalise(_db, keys, 10);
      if (processadas > 0) {
        console.log(`[IA] Auto-análise pós-sync: ${processadas} licitações processadas`);
      }
    } catch (e) {
      console.error('[IA] Erro na auto-análise:', e.message);
    }
  }, 3000);
}

// ============== Sincronização ==============

/**
 * Sincronização completa (primeira vez ou forçada)
 */
// Checkpoint persistente em catalog_sync_state. Permite retomar sync
// retroativo de onde parou após restart (deploy/crash/OOM). Sync de 720
// dias leva ~3-7 dias — sem checkpoint, qualquer restart joga o progresso
// fora e o incremental normal não cobre o gap.
const MODALIDADES_PADRAO = [6, 1, 7, 8];

async function sincronizarCompleta(diasAtras = 30, diasFrente = 7, opts = {}) {
  _ensureInit();
  if (syncStatus.running) {
    console.log('Sincronização já está em andamento');
    return false;
  }

  syncStatus.running = true;
  syncStatus.type = 'full';
  syncStatus.licitacoesCount = 0;
  syncStatus.itensCount = 0;

  // Resumo de checkpoint: usa datas + modalidades + posição salvos em vez
  // de recalcular do "hoje" (que mudou no restart). Garante continuidade
  // do range original mesmo após dias parados.
  let dataInicialISO, dataFinalISO, modalidades, modalidadeStartIdx, diaStartIdx;

  if (opts.resumir) {
    dataInicialISO = opts.dataInicial;
    dataFinalISO = opts.dataFinal;
    modalidades = opts.modalidades || MODALIDADES_PADRAO;
    modalidadeStartIdx = opts.modalidadeStartIdx || 0;
    diaStartIdx = opts.diaStartIdx || 0;
    console.log(`[SYNC COMPLETA] RETOMANDO checkpoint: mod ${modalidadeStartIdx}/${modalidades.length}, dia ${diaStartIdx} de ${dataInicialISO}..${dataFinalISO}`);
  } else {
    const hoje = new Date();
    const dInicial = new Date(hoje); dInicial.setDate(hoje.getDate() - diasAtras);
    const dFinal = new Date(hoje); dFinal.setDate(hoje.getDate() + diasFrente);
    dataInicialISO = dInicial.toISOString().split('T')[0];
    dataFinalISO = dFinal.toISOString().split('T')[0];
    modalidades = MODALIDADES_PADRAO;
    modalidadeStartIdx = 0;
    diaStartIdx = 0;
    // Grava metadados do novo job (reseta checkpoint anterior)
    setConfigValue('syncRetroativo.status', 'rodando');
    setConfigValue('syncRetroativo.dataInicial', dataInicialISO);
    setConfigValue('syncRetroativo.dataFinal', dataFinalISO);
    setConfigValue('syncRetroativo.modalidades', JSON.stringify(modalidades));
    setConfigValue('syncRetroativo.modalidadeAtualIdx', 0);
    setConfigValue('syncRetroativo.diaAtualIdx', 0);
    setConfigValue('syncRetroativo.iniciadoEm', new Date().toISOString());
  }

  const dias = gerarDiasEntre(dataInicialISO, dataFinalISO);
  syncStatus.total = dias.length * modalidades.length;
  syncStatus.progress = modalidadeStartIdx * dias.length + diaStartIdx;

  console.log(`[SYNC COMPLETA] ${dias.length} dias × ${modalidades.length} modalidades = ${syncStatus.total} ciclos (começando em ${syncStatus.progress})`);

  // Helper: processa 1 (dia, modalidade) — busca licitações, salva, depois
  // busca itens das licitações novas e salva. Async, libera event loop em axios.
  // SQLite é sync no momento de salvar (better-sqlite3); 2 chamadas paralelas
  // intercalam naturalmente — write lock do WAL serializa sem dar erro.
  async function _processarDiaModalidade(dia, modalidade) {
    const licitacoes = await buscarLicitacoesDoDia(dia, modalidade);
    const usePg = process.env.CATALOG_BACKEND_PG === '1';

    if (usePg) {
      // Postgres: cada salvarLicitacaoPg já é UPSERT atômico próprio, sem
      // precisar de transação externa. Mais simples e libera event loop.
      for (const licitacao of licitacoes) {
        if (await _salvarLicitacao(licitacao)) syncStatus.licitacoesCount++;
      }
    } else {
      // SQLite: transação síncrona com better-sqlite3
      const transaction = _db.transaction(() => {
        for (const licitacao of licitacoes) {
          if (_salvarLicitacao(licitacao)) syncStatus.licitacoesCount++;
        }
      });
      transaction();
    }

    for (const licitacao of licitacoes) {
      let count;
      if (usePg) {
        const r = await require('./catalog-pg').queryOne(`SELECT COUNT(*) AS count FROM itens WHERE "numeroControlePNCP"=$1`, [licitacao.numeroControlePNCP]);
        count = Number(r?.count || 0);
      } else {
        count = _db.prepare('SELECT COUNT(*) as count FROM itens WHERE numeroControlePNCP = ?').get(licitacao.numeroControlePNCP)?.count || 0;
      }

      if (count === 0) {
        const itens = await buscarItensLicitacao(
          licitacao.orgaoEntidade?.cnpj,
          licitacao.anoCompra,
          licitacao.sequencialCompra
        );
        if (itens.length > 0) {
          const ok = usePg ? await _salvarItens(licitacao.numeroControlePNCP, itens) : _salvarItens(licitacao.numeroControlePNCP, itens);
          if (ok) syncStatus.itensCount += itens.length;
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  // Concorrência: 2 dias em paralelo. Mais que isso aumenta pressão no WAL
  // sem ganho proporcional (PNCP API rate-limita) e arrisca page cache do
  // worker que serve HTTP. Speedup esperado: ~1.7-2x.
  const SYNC_PARALELISMO = 2;

  try {
    for (let modIdx = modalidadeStartIdx; modIdx < modalidades.length; modIdx++) {
      const modalidade = modalidades[modIdx];
      // No primeiro modalidade resumida, começa do diaStartIdx; nas seguintes, do 0
      const diaInicio = (modIdx === modalidadeStartIdx) ? diaStartIdx : 0;
      for (let diaIdx = diaInicio; diaIdx < dias.length; diaIdx += SYNC_PARALELISMO) {
        const batch = dias.slice(diaIdx, diaIdx + SYNC_PARALELISMO);
        syncStatus.currentDay = `${batch[0]}..${batch[batch.length-1]} - Modalidade ${modalidade}`;

        // Roda batch em paralelo. Se um falha, allSettled garante que o outro
        // termina; o erro fica logado no console pelo catch interno de buscar*.
        await Promise.all(batch.map(dia => _processarDiaModalidade(dia, modalidade)));

        syncStatus.progress += batch.length;
        // Checkpoint após batch inteiro: se cair aqui, retoma em diaIdx+batch.length.
        // Vale a perda de até SYNC_PARALELISMO dias em re-trabalho num crash.
        setConfigValue('syncRetroativo.modalidadeAtualIdx', modIdx);
        setConfigValue('syncRetroativo.diaAtualIdx', diaIdx + batch.length);
        setConfigValue('syncRetroativo.ultimaAtualizacaoEm', new Date().toISOString());

        await new Promise(r => setTimeout(r, 100));
      }
      // Terminou todos os dias dessa modalidade — próxima começa do dia 0
      setConfigValue('syncRetroativo.modalidadeAtualIdx', modIdx + 1);
      setConfigValue('syncRetroativo.diaAtualIdx', 0);
    }

    const now = new Date().toISOString();
    syncStatus.lastSync = now;
    setConfigValue('lastFullSync', now);
    setConfigValue('lastSyncDate', dataFinalISO);
    setConfigValue('syncRetroativo.status', 'concluido');
    setConfigValue('syncRetroativo.terminadoEm', now);

    console.log(`[SYNC COMPLETA] Concluída: ${syncStatus.licitacoesCount} licitações, ${syncStatus.itensCount} novos itens`);

    // Auto-análise desabilitada — apenas sob demanda via botão na UI
    // dispararAnaliseIA();

    return true;
  } catch (err) {
    console.error('[SYNC COMPLETA] Erro:', err.message);
    setConfigValue('syncRetroativo.status', 'erro');
    setConfigValue('syncRetroativo.ultimoErro', err.message);
    return false;
  } finally {
    syncStatus.running = false;
    syncStatus.currentDay = '';
  }
}

// Verifica se há sync retroativo pendente (checkpoint salvo com status='rodando').
// Chamada pelo scheduler.js no boot pra retomar após restart.
function retomarSyncRetroativoSeAplicavel() {
  _ensureInit();
  const status = getConfigValue('syncRetroativo.status');
  if (status !== 'rodando') return false;
  const dataInicial = getConfigValue('syncRetroativo.dataInicial');
  const dataFinal = getConfigValue('syncRetroativo.dataFinal');
  if (!dataInicial || !dataFinal) return false;
  let modalidades;
  try {
    modalidades = JSON.parse(getConfigValue('syncRetroativo.modalidades') || '[]');
  } catch { modalidades = MODALIDADES_PADRAO; }
  if (!modalidades.length) modalidades = MODALIDADES_PADRAO;
  const modalidadeStartIdx = parseInt(getConfigValue('syncRetroativo.modalidadeAtualIdx') || '0', 10);
  const diaStartIdx = parseInt(getConfigValue('syncRetroativo.diaAtualIdx') || '0', 10);
  // Se já passou da última modalidade, considera concluído mas não foi marcado
  if (modalidadeStartIdx >= modalidades.length) {
    setConfigValue('syncRetroativo.status', 'concluido');
    return false;
  }
  console.log(`[SYNC RETROATIVO] Detectado checkpoint pendente, retomando em background...`);
  // Não aguarda — dispara assíncrono pra não bloquear o boot do scheduler
  setImmediate(() => {
    sincronizarCompleta(0, 0, {
      resumir: true,
      dataInicial,
      dataFinal,
      modalidades,
      modalidadeStartIdx,
      diaStartIdx,
    }).catch(err => console.error('[SYNC RETROATIVO] Retomada falhou:', err && err.message));
  });
  return true;
}

/**
 * Sincronização incremental (apenas novos dados desde última sync)
 */
async function sincronizarIncremental() {
  _ensureInit();
  if (syncStatus.running) {
    console.log('Sincronização já está em andamento');
    // Reagenda o próximo ciclo antes de sair. Sem isto, se o incremental
    // bater neste guard (ex.: durante um sincronizarCompleta disparado por
    // SIGUSR2), o early-return pula o agendarProximaSync() do finally e a
    // corrente de 5min morre permanentemente.
    agendarProximaSync();
    return false;
  }

  const lastSyncDate = getConfigValue('lastSyncDate');
  if (!lastSyncDate) {
    console.log('[SYNC INCREMENTAL] Nenhuma sincronização anterior, executando sync completa...');
    return sincronizarCompleta(30, 7);
  }

  syncStatus.running = true;
  syncStatus.type = 'incremental';
  syncStatus.progress = 0;
  syncStatus.licitacoesCount = 0;
  syncStatus.itensCount = 0;

  const hoje = new Date();
  const dataInicial = new Date(lastSyncDate);
  dataInicial.setDate(dataInicial.getDate() - 1);
  const dataFinal = new Date(hoje);
  dataFinal.setDate(hoje.getDate() + 7);

  const dias = gerarDiasEntre(dataInicial.toISOString().split('T')[0], dataFinal.toISOString().split('T')[0]);
  const modalidades = [6, 1, 7, 8];

  syncStatus.total = dias.length * modalidades.length;

  console.log(`[SYNC INCREMENTAL] Iniciando desde ${lastSyncDate}: ${dias.length} dias`);

  const usePg = process.env.CATALOG_BACKEND_PG === '1';
  const catalogPg = usePg ? require('./catalog-pg') : null;

  try {
    for (const modalidade of modalidades) {
      for (const dia of dias) {
        syncStatus.currentDay = `${dia} - Modalidade ${modalidade} (incremental)`;

        const licitacoes = await buscarLicitacoesDoDia(dia, modalidade);

        if (usePg) {
          for (const licitacao of licitacoes) {
            if (await _salvarLicitacao(licitacao)) syncStatus.licitacoesCount++;
          }
        } else {
          const transaction = _db.transaction(() => {
            for (const licitacao of licitacoes) {
              if (_salvarLicitacao(licitacao)) syncStatus.licitacoesCount++;
            }
          });
          transaction();
        }

        for (const licitacao of licitacoes) {
          let count;
          if (usePg) {
            const r = await catalogPg.queryOne(`SELECT COUNT(*) AS count FROM itens WHERE "numeroControlePNCP"=$1`, [licitacao.numeroControlePNCP]);
            count = Number(r?.count || 0);
          } else {
            count = _db.prepare('SELECT COUNT(*) as count FROM itens WHERE numeroControlePNCP = ?').get(licitacao.numeroControlePNCP)?.count || 0;
          }

          if (count === 0) {
            const itens = await buscarItensLicitacao(
              licitacao.orgaoEntidade?.cnpj,
              licitacao.anoCompra,
              licitacao.sequencialCompra
            );
            if (itens.length > 0) {
              const ok = usePg ? await _salvarItens(licitacao.numeroControlePNCP, itens) : _salvarItens(licitacao.numeroControlePNCP, itens);
              if (ok) syncStatus.itensCount += itens.length;
            }
            await new Promise(r => setTimeout(r, 50));
          }
        }

        syncStatus.progress++;
        await new Promise(r => setTimeout(r, 50));
      }
    }

    const now = new Date().toISOString();
    syncStatus.lastIncrementalSync = now;
    setConfigValue('lastIncrementalSync', now);
    setConfigValue('lastSyncDate', dataFinal.toISOString().split('T')[0]);

    console.log(`[SYNC INCREMENTAL] Concluída: ${syncStatus.licitacoesCount} licitações, ${syncStatus.itensCount} novos itens`);

    if (_verificarECorrigirLacunas) {
      setTimeout(() => _verificarECorrigirLacunas(3), 5000);
    }

    // Auto-análise desabilitada — apenas sob demanda via botão na UI
    // dispararAnaliseIA();

    return true;
  } catch (err) {
    console.error('[SYNC INCREMENTAL] Erro:', err.message);
    return false;
  } finally {
    syncStatus.running = false;
    syncStatus.currentDay = '';
    agendarProximaSync();
  }
}

/**
 * Agenda próxima sincronização incremental
 */
function agendarProximaSync() {
  if (syncInterval) {
    clearTimeout(syncInterval);
  }

  const proximaSync = new Date();
  proximaSync.setMinutes(proximaSync.getMinutes() + SYNC_INTERVAL_MINUTES);
  syncStatus.nextScheduledSync = proximaSync.toISOString();

  syncInterval = setTimeout(() => {
    console.log(`[AGENDAMENTO] Executando sincronização incremental agendada...`);
    sincronizarIncremental();
  }, SYNC_INTERVAL_MINUTES * 60 * 1000);

  console.log(`[AGENDAMENTO] Próxima sincronização em ${SYNC_INTERVAL_MINUTES} minutos (${proximaSync.toLocaleTimeString()})`);
}

/**
 * Sweep de reconciliação: varre o PNCP por dataAtualizacaoGlobal (endpoint
 * /contratacoes/atualizacao) na janela [hoje-diasAtras .. hoje] e dá UPSERT
 * em cada contratação. Diferente do sync por publicação, isto pega edições
 * feitas pelo órgão DEPOIS da publicação (mudança de data de encerramento,
 * cancelamento, etc.) em licitações que o sync normal já não revisita.
 *
 * Serializado com o sync principal via syncStatus.running — se um sync já
 * estiver rodando, reagenda e sai (evita curl PNCP em paralelo). Itens só
 * são buscados quando ainda não temos nenhum (mesmo critério do incremental).
 */
async function sincronizarAtualizacoes(diasAtras = 1) {
  _ensureInit();
  if (syncStatus.running) {
    console.log('[SWEEP ATUALIZAÇÃO] Sync em andamento, reagendando sweep...');
    agendarProximoSweepAtualizacoes();
    return false;
  }

  syncStatus.running = true;
  syncStatus.type = 'atualizacao';
  syncStatus.progress = 0;
  syncStatus.licitacoesCount = 0;
  syncStatus.itensCount = 0;

  const hoje = new Date();
  const dataInicial = new Date(hoje);
  dataInicial.setDate(hoje.getDate() - diasAtras);

  const dias = gerarDiasEntre(dataInicial.toISOString().split('T')[0], hoje.toISOString().split('T')[0]);
  const modalidades = MODALIDADES_PADRAO;
  syncStatus.total = dias.length * modalidades.length;

  console.log(`[SWEEP ATUALIZAÇÃO] Janela ${dias[0]}..${dias[dias.length - 1]} × ${modalidades.length} modalidades`);

  const usePg = process.env.CATALOG_BACKEND_PG === '1';
  const catalogPg = usePg ? require('./catalog-pg') : null;
  let atualizadas = 0;

  try {
    for (const modalidade of modalidades) {
      for (const dia of dias) {
        syncStatus.currentDay = `${dia} - Modalidade ${modalidade} (atualização)`;

        // WAF-tolerante: o /atualizacao em volume dispara 429/timeout no IP.
        // Timeout maior + backoff entre retries + pacing entre páginas dão
        // tempo do rate-limit aliviar (sem isto o sweep aborta e reconcilia 0).
        const licitacoes = await buscarLicitacoesDoDia(dia, modalidade, 'atualizacao', {
          timeoutMs: 20000, maxRetries: 6, backoffMs: 3000, pacingMs: 400
        });

        if (usePg) {
          for (const licitacao of licitacoes) {
            if (await _salvarLicitacao(licitacao)) { syncStatus.licitacoesCount++; atualizadas++; }
          }
        } else {
          const transaction = _db.transaction(() => {
            for (const licitacao of licitacoes) {
              if (_salvarLicitacao(licitacao)) { syncStatus.licitacoesCount++; atualizadas++; }
            }
          });
          transaction();
        }

        for (const licitacao of licitacoes) {
          let count;
          if (usePg) {
            const r = await catalogPg.queryOne(`SELECT COUNT(*) AS count FROM itens WHERE "numeroControlePNCP"=$1`, [licitacao.numeroControlePNCP]);
            count = Number(r?.count || 0);
          } else {
            count = _db.prepare('SELECT COUNT(*) as count FROM itens WHERE numeroControlePNCP = ?').get(licitacao.numeroControlePNCP)?.count || 0;
          }

          if (count === 0) {
            const itens = await buscarItensLicitacao(
              licitacao.orgaoEntidade?.cnpj,
              licitacao.anoCompra,
              licitacao.sequencialCompra
            );
            if (itens.length > 0) {
              const ok = usePg ? await _salvarItens(licitacao.numeroControlePNCP, itens) : _salvarItens(licitacao.numeroControlePNCP, itens);
              if (ok) syncStatus.itensCount += itens.length;
            }
            await new Promise(r => setTimeout(r, 50));
          }
        }

        syncStatus.progress++;
        await new Promise(r => setTimeout(r, 50));
      }
    }

    setConfigValue('lastAtualizacaoSweep', new Date().toISOString());
    console.log(`[SWEEP ATUALIZAÇÃO] Concluído: ${atualizadas} licitações reconciliadas, ${syncStatus.itensCount} novos itens`);
    return true;
  } catch (err) {
    console.error('[SWEEP ATUALIZAÇÃO] Erro:', err.message);
    return false;
  } finally {
    syncStatus.running = false;
    syncStatus.currentDay = '';
    agendarProximoSweepAtualizacoes();
  }
}

/**
 * Agenda o próximo sweep nacional para a próxima madrugada (hora ATUALIZACAO_SWEEP_HORA).
 * Roda 1x/dia (não em intervalo curto): a varredura ampla dispara o rate-limit
 * do PNCP e compete com o incremental, então fica restrita ao horário de baixa.
 * O grosso da reconciliação fica no reconciliador direcionado de interesse
 * (scheduler.js, a cada 30min), que é leve. Este sweep é só a rede de segurança
 * pra licitações FORA do interesse de qualquer tenant.
 */
function agendarProximoSweepAtualizacoes() {
  if (atualizacaoSweepTimer) clearTimeout(atualizacaoSweepTimer);
  const agora = new Date();
  const prox = new Date();
  prox.setHours(ATUALIZACAO_SWEEP_HORA, 0, 0, 0);
  if (agora >= prox) prox.setDate(prox.getDate() + 1);
  atualizacaoSweepTimer = setTimeout(() => {
    sincronizarAtualizacoes(1).catch(err =>
      console.error('[SWEEP ATUALIZAÇÃO] Erro no agendado:', err.message));
  }, prox - agora);
  console.log(`[SWEEP ATUALIZAÇÃO] Próximo sweep nacional agendado para ${prox.toLocaleString()}`);
}

// ============== Watchdog ==============

function iniciarWatchdogSync() {
  _ensureInit();
  const TEMPO_MAXIMO_SEM_SYNC = 15 * 60 * 1000; // 15 min
  const INTERVALO_VERIFICACAO = 10 * 60 * 1000; // 10 min

  const lastSyncFromDb = getConfigValue('lastIncrementalSync');
  if (lastSyncFromDb && !syncStatus.lastIncrementalSync) {
    syncStatus.lastIncrementalSync = lastSyncFromDb;
    console.log(`[WATCHDOG] Restaurado lastIncrementalSync do banco: ${lastSyncFromDb}`);
  }

  setInterval(async () => {
    try {
      const agora = new Date();
      const ultimaSync = syncStatus.lastIncrementalSync ? new Date(syncStatus.lastIncrementalSync) : null;
      if (ultimaSync) {
        const tempoSemSync = agora - ultimaSync;
        if (tempoSemSync > TEMPO_MAXIMO_SEM_SYNC) {
          if (!ultimoAlertaSyncEnviado || (agora - ultimoAlertaSyncEnviado) > 30 * 60 * 1000) {
            const minutosSemSync = Math.round(tempoSemSync / 60000);
            console.log(`[WATCHDOG] ⚠️ Sincronização parada há ${minutosSemSync} minutos!`);
            await sendTelegram(_db, `⚠️ <b>ALERTA: Sincronização parada!</b>\n\nÚltima sync: há ${minutosSemSync} minutos\nVerifique o servidor PNCP.`);
            ultimoAlertaSyncEnviado = agora;
          }
        }
      }
    } catch (error) {
      console.error('[WATCHDOG] Erro:', error.message);
    }
  }, INTERVALO_VERIFICACAO);

  console.log('[WATCHDOG] Monitoramento de sincronização ativo (alerta se parar por >15min)');
}

// ============== Alertas de disputa (30min antes) ==============

async function verificarAlertasDisputa() {
  _ensureInit();
  try {
    const proximas = _db.prepare(`
      SELECT p.compraId, p.orgao, p.objeto, p.dataHoraInicioDisputa, p.modoDisputa, p.faseCompra
      FROM participacoes_comprasnet p
      LEFT JOIN alertas_enviados a ON a.tipo = 'disputa_30min' AND a.referencia = p.compraId
      WHERE p.ativo = 1
        AND p.dataHoraInicioDisputa IS NOT NULL
        AND p.dataHoraInicioDisputa != ''
        AND p.faseCompra IN ('1', '3')
        AND a.id IS NULL
        AND datetime(p.dataHoraInicioDisputa) > datetime('now')
        AND datetime(p.dataHoraInicioDisputa) <= datetime('now', '+35 minutes')
    `).all();

    if (proximas.length === 0) return;

    const agora = new Date();
    for (const p of proximas) {
      const inicio = new Date(p.dataHoraInicioDisputa);
      const diffMin = Math.round((inicio - agora) / 60000);

      const msg = [
        `⚔️ <b>DISPUTA EM ${diffMin} MINUTOS</b>`,
        `━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `📋 <b>${(p.objeto || '').substring(0, 200)}</b>`,
        `🏛 ${p.orgao || 'Órgão não informado'}`,
        `🕐 Início: ${inicio.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
        p.modoDisputa ? `📊 Modo: ${p.modoDisputa === 'A' ? 'Aberto' : p.modoDisputa === 'F' ? 'Fechado' : p.modoDisputa === 'AF' ? 'Aberto-Fechado' : p.modoDisputa}` : '',
        `🔗 CompraId: ${p.compraId}`,
        ``,
        `<i>Prepare suas propostas!</i>`,
      ].filter(Boolean).join('\n');

      const enviou = await sendTelegram(_db, msg);
      if (enviou) {
        _db.prepare('INSERT OR IGNORE INTO alertas_enviados (tipo, referencia) VALUES (?, ?)').run('disputa_30min', p.compraId);
        console.log(`[Alerta] Telegram enviado: disputa ${p.compraId} em ${diffMin} min`);
      }
    }
  } catch (e) {
    console.error('[Alerta] Erro ao verificar disputas:', e.message);
  }
}

// ============== Verificação diária de lacunas (03:00) ==============

function agendarVerificacaoDiaria() {
  _ensureInit();
  const agora = new Date();
  const proximaVerificacao = new Date();
  proximaVerificacao.setHours(3, 0, 0, 0);

  if (agora >= proximaVerificacao) {
    proximaVerificacao.setDate(proximaVerificacao.getDate() + 1);
  }

  const msAteProxima = proximaVerificacao - agora;
  console.log(`[VERIFICAÇÃO DIÁRIA] Agendada para ${proximaVerificacao.toLocaleString()}`);

  verificacaoDiariaTimer = setTimeout(async () => {
    console.log('[VERIFICAÇÃO DIÁRIA] Iniciando...');
    if (_verificacaoCompletaDiaria) {
      await _verificacaoCompletaDiaria();
    }
    agendarVerificacaoDiaria();
  }, msAteProxima);
}

// ============== Bootstrap helpers (master-only) ==============

/**
 * Dispara sync inicial (completa se banco vazio, senão incremental) e
 * agenda próximas execuções. Chamar UMA vez no bootstrap do master.
 */
async function iniciarSyncEngine() {
  _ensureInit();
  let count;
  if (process.env.CATALOG_BACKEND_PG === '1') {
    const r = await require('./catalog-pg').queryOne('SELECT COUNT(*) AS count FROM licitacoes');
    count = Number(r?.count || 0);
  } else {
    count = _db.prepare('SELECT COUNT(*) as count FROM licitacoes').get()?.count || 0;
  }
  if (count === 0) {
    console.log('[master] Banco vazio, iniciando sincronização completa...');
    sincronizarCompleta(30, 7).then(() => agendarProximaSync());
  } else {
    console.log(`[master] Agendando sincronização incremental a cada ${SYNC_INTERVAL_MINUTES} minutos...`);
    agendarProximaSync();
  }
}

/**
 * Liga os 3 timers master-only (watchdog + disputa + verificação diária).
 * Idempotente em si mesmo; se chamado duas vezes, limpa o anterior antes.
 */
function startMasterOnlyTimers() {
  _ensureInit();

  if (disputaAlertInterval) { clearInterval(disputaAlertInterval); disputaAlertInterval = null; }
  if (disputaAlertBootTimer) { clearTimeout(disputaAlertBootTimer); disputaAlertBootTimer = null; }
  if (verificacaoDiariaTimer) { clearTimeout(verificacaoDiariaTimer); verificacaoDiariaTimer = null; }
  if (atualizacaoSweepTimer) { clearTimeout(atualizacaoSweepTimer); atualizacaoSweepTimer = null; }

  iniciarWatchdogSync();

  // Alertas de disputa: a cada 5min + um disparo após 30s do boot.
  disputaAlertInterval = setInterval(verificarAlertasDisputa, 5 * 60 * 1000);
  disputaAlertBootTimer = setTimeout(verificarAlertasDisputa, 30000);

  agendarVerificacaoDiaria();

  // Sweep nacional por dataAtualizacaoGlobal: agenda só pra próxima madrugada
  // (sem disparo no boot — evita hammerar o PNCP logo após subir e competir
  // com o incremental). A reconciliação frequente fica no reconciliador
  // direcionado de interesse (scheduler.js).
  agendarProximoSweepAtualizacoes();
}

// ============== Getters para routes ==============

/**
 * Snapshot do syncStatus (leitura). No worker sempre retorna estado
 * zerado — use `getSyncStatusFromDb(db)` para UI.
 */
function getSyncStatus() {
  return { ...syncStatus };
}

/**
 * Verifica se uma sync está em andamento (in-memory). Sem sentido no worker.
 */
function isRunning() {
  return !!syncStatus.running;
}

module.exports = {
  init,
  iniciarSyncEngine,
  startMasterOnlyTimers,
  sincronizarCompleta,
  sincronizarIncremental,
  sincronizarAtualizacoes,
  agendarProximaSync,
  iniciarWatchdogSync,
  verificarAlertasDisputa,
  agendarVerificacaoDiaria,
  getSyncStatus,
  isRunning,
  retomarSyncRetroativoSeAplicavel,
  getConfigValue,
  // Helper puro (só axios), exportado para a rota POST /api/licitacoes/.../sync-itens
  // que precisa ressincronizar itens de uma licitação sob demanda.
  buscarItensLicitacao,
  SYNC_INTERVAL_MINUTES,
};
