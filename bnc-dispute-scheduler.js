// bnc-dispute-scheduler.js
//
// Gerencia engines de disputa BNC por tenant. Cada sala ativa em `bnc_salas`
// vira uma instância de bnc-dispute-engine conectada via SignalR.
//
// Estratégia:
//   - ensureSchedulerForTenant(tenant, db) — chamado no boot do servidor
//     (3s pós-start) pra cada tenant ativo. Inicializa estado e dispara tick.
//   - Tick a cada 60s: sincroniza engines com bnc_salas WHERE ativo=1:
//       - Sala nova/ativada → cria engine, start()
//       - Sala desativada/removida → engine.stop(), remove do Map
//   - Engine handlers: ao receber updateStatus/updateInfoStatus, atualiza
//     bnc_salas_lotes + cache em memória pra UI consumir.
//
// API exposta:
//   ensureSchedulerForTenant(tenant, db)
//   getDisputasCache(tenantSlug) → { disputas: [...], updatedAt }
//   getEngineForSala(tenantSlug, compraId) → engine|null  (pra sendBid)
//   refreshTenant(tenantSlug)  — força sync imediato (após cadastro/toggle)
//   stopAll()                  — pra graceful shutdown
//
// Hoje DRY-RUN: engine criada com cfg.dryRun=true. Lances reais virão na 5D
// quando a rota /api/sniper/lance chamar engine.sendBid() diretamente.

'use strict';

const { createEngine } = require('./bnc-dispute-engine');
const bncSalas = require('./bnc-salas');
const { sincronizarMensagens } = require('./bnc-mensagens');

const SYNC_TICK_MS = 60 * 1000;
const MSG_POLL_MS = 45 * 1000;   // polling das mensagens do pregão → Telegram

// Estado por tenant: { tenant, db, engines: Map<salaId, {engine, sala}>, cache, tickTimer }
const tenants = new Map();

function ensureSchedulerForTenant(tenant, db) {
  if (tenants.has(tenant.slug)) return tenants.get(tenant.slug);
  if (process.env.DISABLE_SCHEDULERS === '1') {
    const state = { tenant, db, engines: new Map(), cache: { disputas: [], updatedAt: null }, tickTimer: null };
    tenants.set(tenant.slug, state);
    console.log(`[BNC-Scheduler ${tenant.slug}] DESABILITADO (DISABLE_SCHEDULERS=1)`);
    return state;
  }
  const state = {
    tenant,
    db,
    engines: new Map(),
    cache: { disputas: [], updatedAt: null },
    tickTimer: null,
  };
  tenants.set(tenant.slug, state);

  console.log(`[BNC-Scheduler ${tenant.slug}] iniciando`);

  syncEngines(state).catch(e => console.error(`[BNC-Scheduler ${tenant.slug}] sync inicial:`, e.message));
  state.tickTimer = setInterval(() => {
    syncEngines(state).catch(e => console.error(`[BNC-Scheduler ${tenant.slug}] tick:`, e.message));
  }, SYNC_TICK_MS);

  return state;
}

async function syncEngines(state) {
  const ativas = bncSalas.listarSalas(state.db, { ativo: true });
  const ativasIds = new Set(ativas.map(s => s.id));

  // Para engines de salas que não estão mais ativas
  for (const [salaId, holder] of state.engines) {
    if (!ativasIds.has(salaId)) {
      console.log(`[BNC-Scheduler ${state.tenant.slug}] parando engine sala #${salaId}`);
      if (holder.msgTimer) clearInterval(holder.msgTimer);
      try { holder.engine.stop(); } catch (e) { /* swallow */ }
      state.engines.delete(salaId);
    }
  }

  // Cria engines novas / restaura tokens
  for (const sala of ativas) {
    let holder = state.engines.get(sala.id);
    if (!holder) {
      holder = startEngineParaSala(state, sala);
      state.engines.set(sala.id, holder);
    } else {
      // sala já existe — propaga mudança de dryRun (UI pode ter trocado)
      const novoDryRun = sala.dryRun === undefined || sala.dryRun === null
        ? true
        : !!Number(sala.dryRun);
      const antigoDryRun = holder.sala.dryRun === undefined || holder.sala.dryRun === null
        ? true
        : !!Number(holder.sala.dryRun);
      if (novoDryRun !== antigoDryRun) {
        console.log(`[BNC-Engine ${state.tenant.slug}/#${sala.id}] dryRun ${antigoDryRun}→${novoDryRun}`);
        try { holder.engine.updateConfig({ dryRun: novoDryRun }); } catch (e) { /* swallow */ }
      }
      holder.sala = sala;
    }
  }

  rebuildCache(state);
}

function startEngineParaSala(state, sala) {
  const log = (...a) => console.log(`[BNC-Engine ${state.tenant.slug}/#${sala.id}]`, ...a);
  // dryRun lido da coluna bnc_salas.dryRun (default=1 seguro). Pode ser
  // alterado pela UI ou via UPDATE direto. Engine respeita o valor da
  // sala — config per-lote (limiteMinimo/decremento/throttle) é lida em
  // sendBid() consultando bnc_auto_lance pelo loteId.
  const dryRun = sala.dryRun === undefined || sala.dryRun === null
    ? true
    : !!Number(sala.dryRun);
  log(`startEngine: dryRun=${dryRun}`);
  // Callback que resolve config de auto-lance por lote consultando o DB.
  // Engine só dispara lance automático se bnc_auto_lance.ativo=1 pro lote.
  const getLoteConfig = (idBatchUuid) => {
    if (!idBatchUuid) return null;
    return state.db.prepare(`
      SELECT a.ativo, a.limiteMinimo, a.decremento, a.throttleMs
        FROM bnc_auto_lance a
        JOIN bnc_salas_lotes l ON l.id = a.loteId
       WHERE l.salaId = ? AND l.idBatchUuid = ?
       LIMIT 1
    `).get(sala.id, idBatchUuid) || null;
  };

  const engine = createEngine({
    db: state.db,
    processId: sala.processId,
    userId: sala.uid,
    log,
    getLoteConfig,
    config: {
      // Defaults usados se o lote não tiver registro em bnc_auto_lance
      // (mas o gate em decide() já bloqueia esse caso — esses valores
      // só viram referência caso o gate seja desativado no futuro).
      limiteMinimo: 0,
      decremento: 1,
      throttleMs: 2000,
      dryRun,
    },
  });

  // Re-popula batchTokens conhecidos
  for (const lote of (sala.lotes || [])) {
    if (lote.idBatchUuid && lote.batchTokenGkz) {
      engine.setBatchToken(lote.idBatchUuid, lote.batchTokenGkz);
    }
  }

  engine.on('updateStatus', (data) => onUpdateStatus(state, sala.id, data));
  engine.on('updateInfoStatus', (data) => onUpdateInfoStatus(state, sala.id, data));
  engine.on('connected', () => log('connected'));
  engine.on('disconnected', (r) => log('disconnected', r));
  engine.on('error', (e) => log('error', e.message));

  // Poll das mensagens da sala → Telegram. Usa o payload estável persistido em
  // bnc_salas_lotes.statusPayloadJson (gravado no onUpdateStatus) — não depende
  // de UpdateStatus ao vivo, então funciona na negociação e após restart.
  // Dedup + escopo (PROCESSO + PREGOEIRO) ficam em bnc-mensagens.js.
  const msgTimer = setInterval(() => {
    const lotes = state.db.prepare(
      `SELECT idBatchUuid, statusPayloadJson FROM bnc_salas_lotes WHERE salaId = ? AND statusPayloadJson IS NOT NULL`
    ).all(sala.id);
    for (const l of lotes) {
      let data;
      try { data = JSON.parse(l.statusPayloadJson); } catch { continue; }
      Promise.resolve(sincronizarMensagens(state.db, { salaId: sala.id, idBatch: l.idBatchUuid, processNumber: sala.processNumber }, data))
        .then((r) => { if (r && r.alertadas) log(`📨 ${r.alertadas} mensagem(ns) do pregão → Telegram`); })
        .catch((e) => log('msg-sync erro:', e.message));
    }
  }, MSG_POLL_MS);

  engine.start().catch(e => log('start falhou:', e.message));

  return { engine, sala, msgTimer };
}

function onUpdateStatus(state, salaId, data) {
  const now = new Date().toISOString();
  const lote = state.db.prepare(`SELECT * FROM bnc_salas_lotes WHERE salaId = ? AND (idBatchUuid = ? OR batchNumber = ?)`)
    .get(salaId, data.idBatch, data.BatchNumber);
  if (lote) {
    state.db.prepare(`UPDATE bnc_salas_lotes SET
      idBatchUuid = COALESCE(idBatchUuid, ?),
      batchNumber = COALESCE(batchNumber, ?),
      title = COALESCE(title, ?),
      baseValue = ?, currentBest = ?, fkParticipantLider = ?, winnerBidderId = ?,
      offers = ?, lastUpdate = ?
      WHERE id = ?`)
      .run(data.idBatch, data.BatchNumber, data.Title, Number(data.BaseValue), Number(data.WinnerBidValue),
           data.fkParticipant, data.WinnerBidderId, Number(data.Offers || 0), now, lote.id);
  } else {
    state.db.prepare(`INSERT INTO bnc_salas_lotes (salaId, idBatchUuid, batchNumber, title, baseValue, currentBest, fkParticipantLider, winnerBidderId, offers, lastUpdate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(salaId, data.idBatch, data.BatchNumber, data.Title, Number(data.BaseValue), Number(data.WinnerBidValue),
           data.fkParticipant, data.WinnerBidderId, Number(data.Offers || 0), now);
  }
  state.db.prepare(`UPDATE bnc_salas SET statusName = ?, updatedAt = ? WHERE id = ?`)
    .run(data.CurrentStatusName, now, salaId);

  // Persiste o payload estável (UUIDs) do lote pra o polling de mensagens
  // conseguir montar o ConvertBatchDataToViewModel mesmo sem UpdateStatus ao
  // vivo (negociação / pós-restart). Só grava quando os UUIDs necessários vêm.
  if (data.fkBatchProposal && data.fkParticipant && data.fkProcess) {
    state.db.prepare(`UPDATE bnc_salas_lotes SET statusPayloadJson = ? WHERE salaId = ? AND idBatchUuid = ?`)
      .run(JSON.stringify(stablePayload(data)), salaId, data.idBatch);
  }
  rebuildCache(state);
}

// Campos estáveis que o ConvertBatchDataToViewModel exige (validado: os valores
// dinâmicos de lance NÃO são necessários; só os identificadores).
function stablePayload(data) {
  return {
    idBatch: data.idBatch,
    fkStatus: data.fkStatus,
    fkBatchProposal: data.fkBatchProposal,
    fkParticipant: data.fkParticipant,
    fkProcess: data.fkProcess,
    fkProposal: data.fkProposal,
    ProcessNumber: data.ProcessNumber,
    BatchNumber: data.BatchNumber,
    fkModality: data.fkModality,
  };
}

function onUpdateInfoStatus(state, salaId, data) {
  // updateInfoStatus payload ainda não foi mapeado in-vivo. Por hora,
  // se tem idBatch + algum valor relevante, encaminhar pra mesma lógica.
  if (data && data.idBatch) onUpdateStatus(state, salaId, data);
}

function rebuildCache(state) {
  const salas = bncSalas.listarSalas(state.db, { ativo: true });
  state.cache.disputas = salas.map(s => ({
    compraId: s.compraId,
    processNumber: s.processNumber,
    title: s.title,
    statusName: s.statusName,
    ativo: !!s.ativo,
    lotes: (s.lotes || []).map(l => ({
      id: l.id,
      idBatchUuid: l.idBatchUuid,
      batchNumber: l.batchNumber,
      title: l.title,
      baseValue: l.baseValue,
      currentBest: l.currentBest,
      fkParticipantLider: l.fkParticipantLider,
      winnerBidderId: l.winnerBidderId,
      isWinner: !!l.isWinner,
      offers: l.offers,
      lastUpdate: l.lastUpdate,
      knowsBatchToken: !!l.batchTokenGkz,
    })),
  }));
  state.cache.updatedAt = new Date().toISOString();
}

function getDisputasCache(tenantSlug) {
  const state = tenants.get(tenantSlug);
  if (!state) return { disputas: [], updatedAt: null };
  return state.cache;
}

function getEngineForSala(tenantSlug, compraId) {
  const state = tenants.get(tenantSlug);
  if (!state) return null;
  for (const [, holder] of state.engines) {
    if (holder.sala.compraId === compraId) return holder.engine;
  }
  return null;
}

function refreshTenant(tenantSlug) {
  const state = tenants.get(tenantSlug);
  if (!state) return;
  syncEngines(state).catch(e => console.error(`[BNC-Scheduler ${tenantSlug}] refresh:`, e.message));
}

function stopAll() {
  for (const [slug, state] of tenants) {
    if (state.tickTimer) clearInterval(state.tickTimer);
    for (const [, holder] of state.engines) {
      if (holder.msgTimer) clearInterval(holder.msgTimer);
      try { holder.engine.stop(); } catch {}
    }
    console.log(`[BNC-Scheduler ${slug}] parado`);
  }
  tenants.clear();
}

module.exports = {
  ensureSchedulerForTenant,
  getDisputasCache,
  getEngineForSala,
  refreshTenant,
  stopAll,
};
