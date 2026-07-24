/**
 * sc-scheduler.js — Scheduler per-tenant para o robô SC.
 *
 * Espelha o padrão de `_iniciarAgendamentoTenant` em sniper-lance-routes.js:
 * boot lazy (na primeira requisição que toca o tenant) e setInterval embrulhado
 * em tenantStorage.run() para os callbacks recuperarem tenant + db.
 *
 * Master tick a cada 5s (CADENCIA_MASTER_MS). Em cada tick:
 *   1. syncParticipacoes — quando última execução > 5min e nenhum sync em curso.
 *   2. Para cada participação ativa:
 *      - syncDisputa com cadência adaptativa baseada em dataFimLances:
 *          • > 10 min até o fim: a cada 30s
 *          • > 1 min até o fim:  a cada 5s
 *          • < 1 min até o fim:  a cada 1s
 *          • após o fim (negociação): a cada 60s (só pra ver mudanças de fase)
 *      - syncChat a cada 60s.
 *
 * Cada job tem flag `inProgress` para impedir concorrência (ex: master tick de
 * 5s acionando 2x syncParticipacoes que dura 21s). A próxima execução só
 * dispara quando a anterior terminou.
 */

const { tenantStorage } = require('./tenant-middleware');
const { SCClient } = require('./sc-client');
const { syncParticipacoes, syncDisputa, syncChat } = require('./sc-sync');
const { avaliarSniper } = require('./sc-sniper');

const CADENCIA_MASTER_MS = 5_000;
const CADENCIA_PARTICIPACOES_MS = 5 * 60 * 1000;
const CADENCIA_CHAT_MS = 60 * 1000;
const CADENCIA_DISPUTA_LONGE_MS = 30_000;     // > 10 min até dataFimLances
const CADENCIA_DISPUTA_MEDIO_MS = 5_000;      // > 1 min até dataFimLances
const CADENCIA_DISPUTA_PERTO_MS = 1_000;      // < 1 min até dataFimLances
const CADENCIA_DISPUTA_POS_MS = 60_000;       // após dataFimLances (em negociação)

// Pool por-tenant. SCClient é singleton para reusar token + TLS keepalive.
const _scPool = new Map();         // slug -> SCClient
const _schedules = new Map();      // slug -> { masterTimer, ... }

/**
 * Estado por-tenant das execuções.
 * - lastSync: { __participacoes: epochMs, 'disputa:<id>': ms, 'chat:<id>': ms }
 * - inProgress: { __participacoes: bool, 'disputa:<id>': bool, 'chat:<id>': bool }
 */
const _state = new Map();

let _telegramFn = null; // setado uma vez em initSCScheduler

function getSCClientForTenant(tenant, db) {
  if (!_scPool.has(tenant.slug)) {
    _scPool.set(tenant.slug, new SCClient(db));
  }
  return _scPool.get(tenant.slug);
}

/**
 * Recebe a função de Telegram (vinda do route-registry).
 * Chamada uma vez no boot, antes de qualquer request.
 */
function setSCTelegramFn(fn) {
  _telegramFn = typeof fn === 'function' ? fn : null;
}

/**
 * Garante que o scheduler está rodando para o tenant. Boot lazy — chamado pelas
 * rotas SC na primeira requisição.
 */
function ensureScheduleForTenant(tenant, db) {
  if (!tenant || !tenant.slug || !db) return;
  if (_schedules.has(tenant.slug)) return;
  if (process.env.DISABLE_SCHEDULERS === '1') {
    _schedules.set(tenant.slug, { masterTimer: null });
    console.log(`[SC-sched] DESABILITADO para tenant "${tenant.slug}" (DISABLE_SCHEDULERS=1)`);
    return;
  }

  _state.set(tenant.slug, { lastSync: new Map(), inProgress: new Map() });

  const masterTick = async () => {
    try {
      await tenantStorage.run({ kind: 'tenant', tenant, db }, async () => {
        await _executarTick(tenant.slug, db);
      });
    } catch (e) {
      console.error(`[SC-sched ${tenant.slug}] tick error: ${e.message}`);
    }
  };
  const masterTimer = setInterval(masterTick, CADENCIA_MASTER_MS);
  if (masterTimer.unref) masterTimer.unref();

  _schedules.set(tenant.slug, { masterTimer });

  // Primeiro tick em 5s para o resto do boot terminar.
  setTimeout(masterTick, 5000);

  console.log(`[SC-sched] agendado para tenant "${tenant.slug}" (master tick a cada ${CADENCIA_MASTER_MS}ms)`);
}

async function _executarTick(slug, db) {
  // Sai sem fazer nada se ainda não tem credenciais — evita logs ruidosos
  // pra tenants que não usam SC.
  const u = db.prepare(`SELECT valor FROM config WHERE chave = 'sc_usuario'`).get();
  const s = db.prepare(`SELECT valor FROM config WHERE chave = 'sc_senha'`).get();
  if (!u?.valor || !s?.valor) return;

  const state = _state.get(slug);
  const tenant = { slug }; // shape mínimo, suficiente para getSCClientForTenant
  const client = getSCClientForTenant(tenant, db);
  const now = Date.now();

  // 1. syncParticipacoes (5min, mutex próprio)
  const lastPart = state.lastSync.get('__participacoes') || 0;
  if (!state.inProgress.get('__participacoes') && (now - lastPart >= CADENCIA_PARTICIPACOES_MS)) {
    state.inProgress.set('__participacoes', true);
    state.lastSync.set('__participacoes', now);
    // fire-and-forget: dura ~21s, não bloqueia o tick atual.
    syncParticipacoes(client, db)
      .catch((e) => console.error(`[SC-sched ${slug}] syncParticipacoes: ${e.message}`))
      .finally(() => state.inProgress.set('__participacoes', false));
  }

  // 2. Para cada participação ativa, decide sync de disputa e chat
  let ativas;
  try {
    ativas = db.prepare(`
      SELECT cotacaoId, dataFimLances, situacao
      FROM sc_participacoes WHERE ativo = 1
    `).all();
  } catch (e) {
    return; // schema ainda não criado em tenants que nunca tocaram SC
  }

  for (const p of ativas) {
    // dataFimLances vem sem timezone; o servidor SC opera em BRT (UTC-3).
    const fimMs = p.dataFimLances ? new Date(p.dataFimLances + '-03:00').getTime() : NaN;
    const segParaFim = Number.isFinite(fimMs) ? (fimMs - now) / 1000 : Infinity;

    let intervaloDisputa;
    if (segParaFim < 0) intervaloDisputa = CADENCIA_DISPUTA_POS_MS;
    else if (segParaFim < 60) intervaloDisputa = CADENCIA_DISPUTA_PERTO_MS;
    else if (segParaFim < 600) intervaloDisputa = CADENCIA_DISPUTA_MEDIO_MS;
    else intervaloDisputa = CADENCIA_DISPUTA_LONGE_MS;

    const keyDisputa = 'disputa:' + p.cotacaoId;
    const lastDisputa = state.lastSync.get(keyDisputa) || 0;
    if (!state.inProgress.get(keyDisputa) && (now - lastDisputa >= intervaloDisputa)) {
      state.inProgress.set(keyDisputa, true);
      state.lastSync.set(keyDisputa, now);
      syncDisputa(client, db, p.cotacaoId)
        .catch((e) => console.error(`[SC-sched ${slug}] syncDisputa(${p.cotacaoId}): ${e.message}`))
        .finally(() => state.inProgress.set(keyDisputa, false));
    }

    const keyChat = 'chat:' + p.cotacaoId;
    const lastChat = state.lastSync.get(keyChat) || 0;
    if (!state.inProgress.get(keyChat) && (now - lastChat >= CADENCIA_CHAT_MS)) {
      state.inProgress.set(keyChat, true);
      state.lastSync.set(keyChat, now);
      syncChat(client, db, p.cotacaoId, _telegramFn)
        .catch((e) => console.error(`[SC-sched ${slug}] syncChat(${p.cotacaoId}): ${e.message}`))
        .finally(() => state.inProgress.set(keyChat, false));
    }
  }

  // 3. Motor sniper — síncrono, agenda setTimeouts. Idempotente entre ticks.
  try {
    avaliarSniper(client, db);
  } catch (e) {
    console.error(`[SC-sched ${slug}] avaliarSniper: ${e.message}`);
  }
}

/** Para testes: status atual do scheduler de um tenant */
function getScheduleStatus(slug) {
  const state = _state.get(slug);
  if (!state) return null;
  return {
    slug,
    lastSync: Object.fromEntries(state.lastSync),
    inProgress: Object.fromEntries(state.inProgress),
  };
}

module.exports = {
  ensureScheduleForTenant,
  setSCTelegramFn,
  getScheduleStatus,
  getSCClientForTenant,
};
