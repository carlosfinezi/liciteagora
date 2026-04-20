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
const { createPersistence } = require('./licitacoes-persistence');
const { sendTelegram } = require('./telegram-client');
const { criarVerificador } = require('./verificacao-lacunas');

const PNCP_API_BASE = 'https://pncp.gov.br/api/consulta/v1';
const PNCP_API_ITENS = 'https://pncp.gov.br/api/pncp/v1';
const SYNC_INTERVAL_MINUTES = 5;

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

  const ver = criarVerificador(db, salvarLicitacao, salvarItens);
  _verificarECorrigirLacunas = ver.verificarECorrigirLacunas;
  _verificacaoCompletaDiaria = ver.verificacaoCompletaDiaria;

  _processarFilaAnalise = processarFilaAnalise || null;
}

function _ensureInit() {
  if (!_db) throw new Error('pncp-sync-scheduler: chame init({ db }) antes.');
}

function getConfigValue(chave) {
  _ensureInit();
  const row = _db.prepare(`SELECT valor FROM config WHERE chave = ?`).get(chave);
  return row ? row.valor : null;
}

function setConfigValue(chave, valor) {
  _ensureInit();
  _db.prepare(`INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)`)
    .run(chave, valor);
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

async function buscarLicitacoesDoDia(dia, modalidade) {
  const resultados = [];
  let paginaAtual = 1;
  let temMaisPaginas = true;
  const diaAPI = dia.replace(/-/g, '');

  while (temMaisPaginas && paginaAtual <= 200) {
    try {
      const response = await axios.get(`${PNCP_API_BASE}/contratacoes/publicacao`, {
        params: {
          dataInicial: diaAPI,
          dataFinal: diaAPI,
          codigoModalidadeContratacao: modalidade,
          pagina: paginaAtual,
          tamanhoPagina: 50
        },
        headers: { 'Accept': 'application/json' },
        timeout: 30000
      });

      if (response?.data?.data?.length > 0) {
        resultados.push(...response.data.data);
        paginaAtual++;
        await new Promise(r => setTimeout(r, 50));
      } else {
        temMaisPaginas = false;
      }
    } catch (err) {
      if (err.response?.status === 400 || err.response?.status === 422) {
        temMaisPaginas = false;
      } else {
        console.warn(`Erro ${dia} mod ${modalidade} pag ${paginaAtual}:`, err.message);
        paginaAtual++;
      }
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
  const gemini = getConfigValue('gemini_api_key');
  const anthropic = getConfigValue('anthropic_api_key');
  if (!gemini && !anthropic) return null;
  return { gemini: gemini || null, anthropic: anthropic || null };
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
async function sincronizarCompleta(diasAtras = 30, diasFrente = 7) {
  _ensureInit();
  if (syncStatus.running) {
    console.log('Sincronização já está em andamento');
    return false;
  }

  syncStatus.running = true;
  syncStatus.type = 'full';
  syncStatus.progress = 0;
  syncStatus.licitacoesCount = 0;
  syncStatus.itensCount = 0;

  const hoje = new Date();
  const dataInicial = new Date(hoje);
  dataInicial.setDate(hoje.getDate() - diasAtras);
  const dataFinal = new Date(hoje);
  dataFinal.setDate(hoje.getDate() + diasFrente);

  const dias = gerarDiasEntre(dataInicial.toISOString().split('T')[0], dataFinal.toISOString().split('T')[0]);
  const modalidades = [6, 1, 7, 8];

  syncStatus.total = dias.length * modalidades.length;

  console.log(`[SYNC COMPLETA] Iniciando: ${dias.length} dias, ${modalidades.length} modalidades`);

  try {
    for (const modalidade of modalidades) {
      for (const dia of dias) {
        syncStatus.currentDay = `${dia} - Modalidade ${modalidade}`;

        const licitacoes = await buscarLicitacoesDoDia(dia, modalidade);

        const transaction = _db.transaction(() => {
          for (const licitacao of licitacoes) {
            if (_salvarLicitacao(licitacao)) {
              syncStatus.licitacoesCount++;
            }
          }
        });
        transaction();

        for (const licitacao of licitacoes) {
          const existingItems = _db.prepare('SELECT COUNT(*) as count FROM itens WHERE numeroControlePNCP = ?')
            .get(licitacao.numeroControlePNCP);

          if (!existingItems || existingItems.count === 0) {
            const itens = await buscarItensLicitacao(
              licitacao.orgaoEntidade?.cnpj,
              licitacao.anoCompra,
              licitacao.sequencialCompra
            );
            if (itens.length > 0) {
              _salvarItens(licitacao.numeroControlePNCP, itens);
              syncStatus.itensCount += itens.length;
            }
            await new Promise(r => setTimeout(r, 100));
          }
        }

        syncStatus.progress++;
        await new Promise(r => setTimeout(r, 100));
      }
    }

    const now = new Date().toISOString();
    syncStatus.lastSync = now;
    setConfigValue('lastFullSync', now);
    setConfigValue('lastSyncDate', dataFinal.toISOString().split('T')[0]);

    console.log(`[SYNC COMPLETA] Concluída: ${syncStatus.licitacoesCount} licitações, ${syncStatus.itensCount} novos itens`);

    // Auto-análise desabilitada — apenas sob demanda via botão na UI
    // dispararAnaliseIA();

    return true;
  } catch (err) {
    console.error('[SYNC COMPLETA] Erro:', err.message);
    return false;
  } finally {
    syncStatus.running = false;
    syncStatus.currentDay = '';
  }
}

/**
 * Sincronização incremental (apenas novos dados desde última sync)
 */
async function sincronizarIncremental() {
  _ensureInit();
  if (syncStatus.running) {
    console.log('Sincronização já está em andamento');
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

  try {
    for (const modalidade of modalidades) {
      for (const dia of dias) {
        syncStatus.currentDay = `${dia} - Modalidade ${modalidade} (incremental)`;

        const licitacoes = await buscarLicitacoesDoDia(dia, modalidade);

        const transaction = _db.transaction(() => {
          for (const licitacao of licitacoes) {
            if (_salvarLicitacao(licitacao)) {
              syncStatus.licitacoesCount++;
            }
          }
        });
        transaction();

        for (const licitacao of licitacoes) {
          const existingItems = _db.prepare('SELECT COUNT(*) as count FROM itens WHERE numeroControlePNCP = ?')
            .get(licitacao.numeroControlePNCP);

          if (!existingItems || existingItems.count === 0) {
            const itens = await buscarItensLicitacao(
              licitacao.orgaoEntidade?.cnpj,
              licitacao.anoCompra,
              licitacao.sequencialCompra
            );
            if (itens.length > 0) {
              _salvarItens(licitacao.numeroControlePNCP, itens);
              syncStatus.itensCount += itens.length;
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
function iniciarSyncEngine() {
  _ensureInit();
  const stats = _db.prepare('SELECT COUNT(*) as count FROM licitacoes').get();
  if (stats.count === 0) {
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

  iniciarWatchdogSync();

  // Alertas de disputa: a cada 5min + um disparo após 30s do boot.
  disputaAlertInterval = setInterval(verificarAlertasDisputa, 5 * 60 * 1000);
  disputaAlertBootTimer = setTimeout(verificarAlertasDisputa, 30000);

  agendarVerificacaoDiaria();
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
  agendarProximaSync,
  iniciarWatchdogSync,
  verificarAlertasDisputa,
  agendarVerificacaoDiaria,
  getSyncStatus,
  isRunning,
  // Helper puro (só axios), exportado para a rota POST /api/licitacoes/.../sync-itens
  // que precisa ressincronizar itens de uma licitação sob demanda.
  buscarItensLicitacao,
  SYNC_INTERVAL_MINUTES,
};
