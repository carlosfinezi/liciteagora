// bll-dispute-scheduler.js
//
// Gerencia engines de disputa BLL por tenant. Cada sala ativa em `bll_salas`
// vira uma instância de bll-dispute-engine conectada via SignalR. Porta de
// bnc-dispute-scheduler.js.
//
// ⚠️ ADAPTAÇÕES BLL (vs BNC):
//   1) Uid ROTACIONA por page-load → startEngineParaSala é ASSÍNCRONO e busca
//      Uid fresco via bllSalas.descobrirInfo() antes de createEngine(). Pid
//      (sala.processId) é estável.
//   2) requestCaptchaToken plugado do bll-captcha-bridge (cunha token v3 via
//      Electron relay) — só usado quando dryRun=0.
//   3) onUpdateStatus persiste com extração TOLERANTE (nomes de campo do payload
//      cru do BLL ainda a confirmar via rawSample) + dump único.
//
// Hoje DRY-RUN por padrão (bll_salas.dryRun default=1). Lance real só quando a
// sala tiver dryRun=0 E bll_auto_lance.ativo=1 pro lote E batchToken conhecido.

'use strict';

const { createEngine } = require('./bll-dispute-engine');
const bllSalas = require('./bll-salas');
const bllCaptchaBridge = require('./bll-captcha-bridge');

const SYNC_TICK_MS = 60 * 1000;

// Candidatos de campo do payload cru (a confirmar in-vivo — ver bll-dispute-engine)
const BEST_KEYS = ['WinnerBidValue', 'WinnerValue', 'BestValue', 'BestBidValue', 'bidValue', 'Value', 'value'];
const BASE_KEYS = ['BaseValue', 'baseValue', 'StartValue', 'ReferenceValue'];
const LIDER_KEYS = ['fkParticipant', 'FkParticipant', 'WinnerParticipant', 'ParticipantId'];
const BATCHID_KEYS = ['idBatch', 'IdBatch', 'idBatchUuid', 'BatchUuid', 'BatchId'];
const WINNERBIDDER_KEYS = ['WinnerBidderId', 'winnerBidderId', 'BidderId'];
const OFFERS_KEYS = ['Offers', 'offers', 'BidCount'];

function pickNum(o, keys) {
  for (const k of keys) {
    if (o[k] != null) { const n = Number(o[k]); if (Number.isFinite(n)) return n; }
  }
  return null;
}
function pickStr(o, keys) {
  for (const k of keys) { if (o[k] != null && o[k] !== '') return String(o[k]); }
  return null;
}

const tenants = new Map();

function ensureSchedulerForTenant(tenant, db) {
  if (tenants.has(tenant.slug)) return tenants.get(tenant.slug);
  const state = { tenant, db, engines: new Map(), cache: { disputas: [], updatedAt: null }, tickTimer: null, rawDumped: false };
  tenants.set(tenant.slug, state);
  if (process.env.DISABLE_SCHEDULERS === '1') {
    console.log(`[BLL-Scheduler ${tenant.slug}] DESABILITADO (DISABLE_SCHEDULERS=1)`);
    return state;
  }
  console.log(`[BLL-Scheduler ${tenant.slug}] iniciando`);
  syncEngines(state).catch(e => console.error(`[BLL-Scheduler ${tenant.slug}] sync inicial:`, e.message));
  state.tickTimer = setInterval(() => {
    syncEngines(state).catch(e => console.error(`[BLL-Scheduler ${tenant.slug}] tick:`, e.message));
  }, SYNC_TICK_MS);
  return state;
}

async function syncEngines(state) {
  const ativas = bllSalas.listarSalas(state.db, { ativo: true });
  const ativasIds = new Set(ativas.map(s => s.id));

  // Para engines de salas não mais ativas
  for (const [salaId, holder] of state.engines) {
    if (!ativasIds.has(salaId)) {
      console.log(`[BLL-Scheduler ${state.tenant.slug}] parando engine sala #${salaId}`);
      try { holder.engine.stop(); } catch (e) { /* swallow */ }
      state.engines.delete(salaId);
    }
  }

  for (const sala of ativas) {
    let holder = state.engines.get(sala.id);
    if (!holder) {
      // Marca placeholder pra evitar start duplicado durante o await
      state.engines.set(sala.id, { engine: null, sala, starting: true });
      try {
        holder = await startEngineParaSala(state, sala);
        state.engines.set(sala.id, holder);
      } catch (e) {
        console.error(`[BLL-Engine ${state.tenant.slug}/#${sala.id}] start falhou:`, e.message);
        state.engines.delete(sala.id);
      }
    } else if (!holder.starting && holder.engine) {
      const novoDryRun = dryRunOf(sala);
      const antigoDryRun = dryRunOf(holder.sala);
      if (novoDryRun !== antigoDryRun) {
        console.log(`[BLL-Engine ${state.tenant.slug}/#${sala.id}] dryRun ${antigoDryRun}→${novoDryRun}`);
        try { holder.engine.updateConfig({ dryRun: novoDryRun }); } catch (e) { /* swallow */ }
      }
      holder.sala = sala;
    }
  }

  rebuildCache(state);
}

function dryRunOf(sala) {
  return sala.dryRun === undefined || sala.dryRun === null ? true : !!Number(sala.dryRun);
}

async function startEngineParaSala(state, sala) {
  const log = (...a) => console.log(`[BLL-Engine ${state.tenant.slug}/#${sala.id}]`, ...a);
  const dryRun = dryRunOf(sala);

  // Uid FRESCO (rotaciona) — busca da página da sala autenticada.
  let uid = sala.uid;
  try {
    const info = await bllSalas.descobrirInfo(state.db, sala.processId);
    if (info.uid) {
      uid = info.uid;
      if (info.uid !== sala.uid) {
        state.db.prepare('UPDATE bll_salas SET uid=?, updatedAt=? WHERE id=?')
          .run(info.uid, new Date().toISOString(), sala.id);
      }
    }
  } catch (e) {
    log('descobrirInfo (uid fresco) falhou, usando uid armazenado:', e.message);
  }
  if (!uid) throw new Error('sem Uid — sala precisa estar logada no BLL');

  log(`startEngine: dryRun=${dryRun} (uid fresco=${uid.slice(0, 12)}…)`);

  const getLoteConfig = (idBatchUuid) => {
    if (!idBatchUuid) return null;
    return state.db.prepare(`
      SELECT a.ativo, a.limiteMinimo, a.decremento, a.throttleMs
        FROM bll_auto_lance a
        JOIN bll_salas_lotes l ON l.id = a.loteId
       WHERE l.salaId = ? AND l.idBatchUuid = ?
       LIMIT 1
    `).get(sala.id, idBatchUuid) || null;
  };

  const engine = createEngine({
    db: state.db,
    processId: sala.processId,
    userId: uid,
    log,
    getLoteConfig,
    config: {
      limiteMinimo: 0,
      decremento: 1,
      throttleMs: 2000,
      dryRun,
      requestCaptchaToken: (o) => bllCaptchaBridge.requestToken(o),
    },
  });

  // Re-popula batchTokens já conhecidos (preenchidos via SignalR em rodadas anteriores)
  for (const lote of (sala.lotes || [])) {
    if (lote.idBatchUuid && lote.batchTokenGkz) {
      engine.setBatchToken(lote.idBatchUuid, lote.batchTokenGkz);
    }
  }

  engine.on('rawSample', (data) => {
    if (!state.rawDumped) {
      state.rawDumped = true;
      let s; try { s = JSON.stringify(data); } catch { s = String(data); }
      log('🔬 rawSample UpdateStatus (mapear campos):', (s || '').slice(0, 600));
    }
  });
  engine.on('updateStatus', (data) => onUpdateStatus(state, sala.id, data));
  engine.on('updateInfoStatus', (data) => { if (data && pickStr(data, BATCHID_KEYS)) onUpdateStatus(state, sala.id, data); });
  engine.on('connected', () => log('connected'));
  engine.on('disconnected', (r) => log('disconnected', r));
  engine.on('error', (e) => log('error', e.message));

  await engine.start().catch(e => log('start falhou:', e.message));

  return { engine, sala, starting: false };
}

function onUpdateStatus(state, salaId, data) {
  const now = new Date().toISOString();
  const idBatch = pickStr(data, BATCHID_KEYS);
  const batchNumber = data.BatchNumber != null ? Number(data.BatchNumber) : null;
  const best = pickNum(data, BEST_KEYS);
  const base = pickNum(data, BASE_KEYS);
  const lider = pickStr(data, LIDER_KEYS);
  const winnerBidder = pickStr(data, WINNERBIDDER_KEYS);
  const offers = pickNum(data, OFFERS_KEYS) || 0;
  const statusName = pickStr(data, ['CurrentStatusName', 'StatusName', 'statusName']);

  const lote = state.db.prepare(
    `SELECT * FROM bll_salas_lotes WHERE salaId = ? AND ((idBatchUuid IS NOT NULL AND idBatchUuid = ?) OR (batchNumber IS NOT NULL AND batchNumber = ?))`
  ).get(salaId, idBatch, batchNumber);

  if (lote) {
    state.db.prepare(`UPDATE bll_salas_lotes SET
      idBatchUuid = COALESCE(idBatchUuid, ?),
      batchNumber = COALESCE(batchNumber, ?),
      baseValue = COALESCE(?, baseValue),
      currentBest = COALESCE(?, currentBest),
      fkParticipantLider = COALESCE(?, fkParticipantLider),
      winnerBidderId = COALESCE(?, winnerBidderId),
      offers = ?, lastUpdate = ?
      WHERE id = ?`)
      .run(idBatch, batchNumber, base, best, lider, winnerBidder, offers, now, lote.id);
  } else {
    state.db.prepare(`INSERT INTO bll_salas_lotes (salaId, idBatchUuid, batchNumber, baseValue, currentBest, fkParticipantLider, winnerBidderId, offers, lastUpdate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(salaId, idBatch, batchNumber, base, best, lider, winnerBidder, offers, now);
  }

  if (statusName) {
    state.db.prepare(`UPDATE bll_salas SET statusName = ?, updatedAt = ? WHERE id = ?`).run(statusName, now, salaId);
  }
  rebuildCache(state);
}

function rebuildCache(state) {
  const salas = bllSalas.listarSalas(state.db, { ativo: true });
  state.cache.disputas = salas.map(s => ({
    compraId: s.compraId,
    processNumber: s.processNumber,
    title: s.title,
    statusName: s.statusName,
    ativo: !!s.ativo,
    dryRun: dryRunOf(s),
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
    if (holder.engine && holder.sala.compraId === compraId) return holder.engine;
  }
  return null;
}

function refreshTenant(tenantSlug) {
  const state = tenants.get(tenantSlug);
  if (!state) return;
  syncEngines(state).catch(e => console.error(`[BLL-Scheduler ${tenantSlug}] refresh:`, e.message));
}

function stopAll() {
  for (const [slug, state] of tenants) {
    if (state.tickTimer) clearInterval(state.tickTimer);
    for (const [, holder] of state.engines) {
      try { holder.engine && holder.engine.stop(); } catch {}
    }
    console.log(`[BLL-Scheduler ${slug}] parado`);
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
