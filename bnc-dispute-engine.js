// bnc-dispute-engine.js
//
// Motor de decisão de lance pra sala BNC. Encapsula:
//   - cliente SignalR (bnc-signalr-client)
//   - estado por lote (currentBest, fkParticipantLider, lastUpdate)
//   - regra de decisão (decremento, limiteMinimo, throttle, dryRun)
//   - emissão de "decision" events que a camada superior consome
//
// API:
//   const eng = createEngine({
//     db, processId, userId,
//     config: { limiteMinimo, decremento, throttleMs, dryRun }
//   });
//   eng.on('decision', (d) => {...});       // { action, batchId, currentBest, myNextBid, reason }
//   eng.on('updateStatus', (data) => {...}); // pass-through do hub event
//   eng.on('connected'|'disconnected'|'error', ...);
//   await eng.start();
//   eng.stop();
//   eng.setMyParticipantUuid(uuid);          // aprendizado reativo opcional
//   eng.setBatchToken(idBatchUuid, gkzToken); // mapeia UUID→[gkz] descoberto via outras rotas
//   eng.status();
//
// Política dry-run:
//   - config.dryRun=true → emite 'decision' com action='bid'|'skip' mas NUNCA envia PerformBid
//   - O caller é livre pra logar/agir. Fase 4 vai plugar o envio real.
//
// Regra de decisão (versão 0):
//   - skip se best <= limiteMinimo
//   - skip se já sou o líder (fkParticipant === myParticipantUuid, quando conhecido)
//   - skip se next < limiteMinimo
//   - skip se último lance < throttleMs atrás (anti-flood)
//   - senão → bid com myNextBid = best - decremento
//
// Limitações conhecidas:
//   - Não cuida de empate ME/EPP (5% sobre o lance ganhador)
//   - Não trata prorrogação aleatória (a confirmar como vem no payload)
//   - Não cuida de lotes paralelos com configs diferentes (config é global)

'use strict';

const { EventEmitter } = require('events');
const { createClient } = require('./bnc-signalr-client');
const { bncFetch } = require('./bnc-client');
const captchaBridge = require('./bnc-captcha-bridge');

function createEngine({ db, processId, userId, config = {}, log, getLoteConfig }) {
  if (!db) throw new Error('db obrigatório');
  if (!processId) throw new Error('processId obrigatório');
  if (!userId) throw new Error('userId obrigatório');

  const cfg = {
    limiteMinimo: Number(config.limiteMinimo ?? 0),
    decremento: Number(config.decremento ?? 1),
    throttleMs: Number(config.throttleMs ?? 2000),
    dryRun: config.dryRun !== false,  // default DRY-RUN por segurança
  };

  // getLoteConfig(idBatchUuid) → { ativo, limiteMinimo, decremento, throttleMs } | null
  // Quando passado, decide() consulta config por lote antes de aplicar a regra.
  // Sem registro ou ativo=0 → skip com reason 'auto-lance desligado'.
  // Lance manual via sendBid() (chamado pela UI) IGNORA esse gate.
  const resolveLoteConfig = typeof getLoteConfig === 'function' ? getLoteConfig : null;

  const _log = log || ((...a) => console.log('[bnc-engine]', ...a));
  const emitter = new EventEmitter();
  const sig = createClient({ db, processId, userId, log: _log });

  const lotes = new Map();           // idBatch UUID → { currentBest, fkParticipantLider, lastUpdate, lastBidAt }
  const batchTokens = new Map();     // idBatch UUID → [gkz] token (necessário pra PerformBid)
  let myParticipantUuid = null;      // aprendido reativamente
  let pendingLearnBid = null;        // { value, sentAt } — usado pra correlacionar primeiro lance próprio

  function fmtBatch(idBatch) {
    return idBatch ? idBatch.slice(0, 8) : '?';
  }

  function decide(data, loteState) {
    const best = Number(data.WinnerBidValue);
    const idBatch = data.idBatch;
    const base = {
      batchId: idBatch,
      currentBest: best,
      fkParticipantLider: data.fkParticipant,
      knowsBatchToken: batchTokens.has(idBatch),
    };

    if (!Number.isFinite(best)) {
      return { ...base, action: 'skip', reason: 'WinnerBidValue inválido', myNextBid: null };
    }

    // Gate de auto-lance por lote (bnc_auto_lance). Sem callback ou sem
    // registro/ativo=0 → engine não dispara lance automático.
    let loteConfig = null;
    if (resolveLoteConfig) {
      try { loteConfig = resolveLoteConfig(idBatch); } catch (e) { loteConfig = null; }
      if (!loteConfig) {
        return { ...base, action: 'skip', reason: 'lote sem config bnc_auto_lance', myNextBid: null };
      }
      if (!loteConfig.ativo) {
        return { ...base, action: 'skip', reason: 'auto-lance desligado pro lote', myNextBid: null };
      }
    }
    // Resolve thresholds: usa loteConfig se presente, senão cfg global
    const lim = loteConfig ? Number(loteConfig.limiteMinimo ?? cfg.limiteMinimo) : cfg.limiteMinimo;
    const dec = loteConfig ? Number(loteConfig.decremento ?? cfg.decremento) : cfg.decremento;
    const thr = loteConfig ? Number(loteConfig.throttleMs ?? cfg.throttleMs) : cfg.throttleMs;

    if (best <= lim) {
      return { ...base, action: 'skip', reason: `best ${best} <= limiteMinimo ${lim}`, myNextBid: null };
    }
    if (myParticipantUuid && data.fkParticipant === myParticipantUuid) {
      return { ...base, action: 'skip', reason: 'eu sou o líder', myNextBid: null };
    }
    const myNextBid = +(best - dec).toFixed(4);
    if (myNextBid < lim) {
      return { ...base, action: 'skip', reason: `next ${myNextBid} < limiteMinimo ${lim}`, myNextBid };
    }
    const since = loteState.lastBidAt ? Date.now() - loteState.lastBidAt : Infinity;
    if (since < thr) {
      return { ...base, action: 'skip', reason: `throttle (${since}ms < ${thr}ms)`, myNextBid };
    }
    return { ...base, action: 'bid', reason: 'ok', myNextBid };
  }

  sig.on('updateStatus', (data) => {
    const idBatch = data.idBatch;
    const prev = lotes.get(idBatch) || {};
    const novo = {
      ...prev,
      currentBest: Number(data.WinnerBidValue),
      fkParticipantLider: data.fkParticipant,
      lastUpdate: Date.now(),
      title: data.Title,
      timeSpent: data.TimeSpent,
      statusName: data.CurrentStatusName,
    };
    lotes.set(idBatch, novo);

    // Aprendizado reativo do meu participantUuid:
    // se mandei lance recente e WinnerBidValue casa, presumir que fkParticipant é meu
    if (!myParticipantUuid && pendingLearnBid &&
        Math.abs(Date.now() - pendingLearnBid.sentAt) < 5000 &&
        Number(data.WinnerBidValue) === pendingLearnBid.value) {
      myParticipantUuid = data.fkParticipant;
      _log(`✨ aprendi meu fkParticipant = ${myParticipantUuid} (correlacionado com lance ${pendingLearnBid.value})`);
      pendingLearnBid = null;
      emitter.emit('learnedParticipant', myParticipantUuid);
    }

    emitter.emit('updateStatus', data);

    const decision = decide(data, novo);
    emitter.emit('decision', decision);

    if (cfg.dryRun) {
      if (decision.action === 'bid') {
        // Exercita a descoberta do token de verdade (sem lançar) — valida o
        // caminho ponta-a-ponta ao vivo. NÃO envia PerformBid.
        discoverBatchTokens(data)
          .then((t) => _log(`🤖 DRY-RUN [batch ${fmtBatch(idBatch)}] DARIA LANCE R$${decision.myNextBid} (best=${decision.currentBest}) — token [gkz] OK (${t.slice(5, 17)}…)`))
          .catch((e) => _log(`🤖 DRY-RUN [batch ${fmtBatch(idBatch)}] DARIA LANCE R$${decision.myNextBid} — mas discoverBatchTokens FALHOU: ${e.message}`));
      } else {
        _log(`🤖 DRY-RUN [batch ${fmtBatch(idBatch)}] skip: ${decision.reason} (best=${decision.currentBest})`);
      }
      return;
    }

    if (decision.action === 'bid') {
      // marca lastBidAt logo (evita re-disparo durante a I/O assíncrona)
      lotes.set(idBatch, { ...novo, lastBidAt: Date.now() });
      // Descobre o token [gkz] FRESCO deste tick antes de lançar (tokens
      // re-mintam a cada UpdateStatus; o payload atual garante validade).
      discoverBatchTokens(data)
        .then(() => sendBid(decision))
        .catch((e) => emitter.emit('bidFailed', { ...decision, error: e.message, stage: 'discover' }));
    }
  });

  async function sendBid(decision) {
    const idBatch = decision.batchId;
    const gkz = batchTokens.get(idBatch);
    if (!gkz) {
      const err = `batchToken [gkz] desconhecido pro lote ${idBatch} — chame setBatchToken() ou discoverBatchTokens() antes`;
      _log('⚠️  ' + err);
      emitter.emit('bidFailed', { ...decision, error: err, stage: 'token-lookup' });
      return;
    }

    // 1) Obter token reCAPTCHA via Electron (bridge)
    let captchaToken;
    try {
      captchaToken = await captchaBridge.requestToken({ action: 'performBid', timeoutMs: 20000 });
    } catch (e) {
      _log(`⚠️  captcha falhou: ${e.message}`);
      emitter.emit('bidFailed', { ...decision, error: e.message, stage: 'captcha' });
      return;
    }

    // 2) POST /BatchListParticipant/PerformBid?batchId=<gkz>&value=<v>&token=<recaptcha>
    const qs = new URLSearchParams({
      batchId: gkz,
      value: String(decision.myNextBid),
      token: captchaToken,
    }).toString();

    _log(`🚀 enviando PerformBid value=${decision.myNextBid} batch=${fmtBatch(idBatch)}`);
    let resp;
    try {
      resp = await bncFetch(db, '/BatchListParticipant/PerformBid?' + qs, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
      });
    } catch (e) {
      _log(`⚠️  PerformBid HTTP falhou: ${e.message}`);
      emitter.emit('bidFailed', { ...decision, error: e.message, stage: 'http' });
      return;
    }

    // 3) Interpretar resposta
    // sucesso: {"message":"null"} (literal string "null") → callback faz doNothing
    // erro:    {"modal":"error", "html":"..."}
    let body;
    try { body = JSON.parse(resp.body); } catch { body = { raw: resp.body }; }

    if (body && body.modal === 'error') {
      const errHtml = String(body.html || '').replace(/<[^>]+>/g, '').trim().slice(0, 200);
      _log(`❌ PerformBid erro do servidor: ${errHtml}`);
      emitter.emit('bidFailed', { ...decision, error: errHtml, stage: 'server', raw: body });
      return;
    }

    if (body && body.message === 'null') {
      _log(`✅ PerformBid aceito value=${decision.myNextBid}`);
      // marca pro learning reativo do participantUuid
      pendingLearnBid = { value: Number(decision.myNextBid), sentAt: Date.now() };
      emitter.emit('bidSent', { ...decision, response: body });
      return;
    }

    // resposta inesperada — log mas não rejeita
    _log(`⚠️  PerformBid resposta inesperada status=${resp.status}: ${JSON.stringify(body).slice(0, 200)}`);
    emitter.emit('bidUnknown', { ...decision, response: body, status: resp.status });
  }

  // Descobre o token [gkz] do lote via POST /BatchList/ConvertBatchDataToViewModel.
  // Na disputa VIVA o FastBid NÃO vem no HTML estático de /BatchList — o servidor
  // o renderiza a cada tick do SignalR, a partir do próprio payload UpdateStatus
  // (mesmos campos/UUIDs). Reproduzimos essa chamada server-side, extraímos o
  // [gkz] do botão FastBid e mapeamos por idBatch UUID. Esse token serve como
  // batchId do PerformBid. (Protocolo capturado do HAR da sala viva e descoberta
  // validada em dry-run 2026-07-14; ver project_liciteagora_bnc_sala_resolver.)
  async function discoverBatchTokens(data) {
    if (!data || !data.idBatch) {
      throw new Error('discoverBatchTokens requer o payload UpdateStatus (com idBatch)');
    }
    const r = await bncFetch(db, '/BatchList/ConvertBatchDataToViewModel', {
      method: 'POST',
      body: data,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    });
    if (r.status !== 200) throw new Error(`ConvertBatchDataToViewModel HTTP ${r.status}`);
    // A resposta é JSON; o onclick do FastBid escapa aspas simples como '.
    // Decodifica e casa doAction(...,'FastBid', ['[gkz]<X>', '1']).
    const raw = (typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '')).replace(/\\u0027/g, "'");
    const m = raw.match(/'FastBid'\s*,\s*\[\s*'(\[gkz\][^']+)'/);
    if (!m) throw new Error('token FastBid [gkz] ausente na resposta ConvertBatchDataToViewModel');
    const token = m[1];
    batchTokens.set(data.idBatch, token);
    _log(`discoverBatchTokens: lote ${fmtBatch(data.idBatch)} → token [gkz] descoberto (${token.slice(5, 17)}…)`);
    return token;
  }

  sig.on('updateInfoStatus', (data) => emitter.emit('updateInfoStatus', data));
  sig.on('newDisputingBatch', (data) => emitter.emit('newDisputingBatch', data));
  sig.on('connected', (info) => emitter.emit('connected', info));
  sig.on('disconnected', (reason) => emitter.emit('disconnected', reason));
  sig.on('error', (e) => emitter.emit('error', e));

  return Object.assign(emitter, {
    start: () => sig.start(),
    stop: () => sig.stop(),
    status: () => ({
      signalR: sig.status(),
      cfg,
      myParticipantUuid,
      lotes: Array.from(lotes.entries()).map(([id, s]) => ({ id, ...s })),
      batchTokens: Array.from(batchTokens.entries()),
    }),
    setMyParticipantUuid: (uuid) => { myParticipantUuid = uuid; },
    setBatchToken: (uuid, gkz) => batchTokens.set(uuid, gkz),
    markLanceEnviado: (value) => { pendingLearnBid = { value: Number(value), sentAt: Date.now() }; },
    updateConfig: (patch) => Object.assign(cfg, patch),
    discoverBatchTokens,
    sendBid,    // exposto pra teste manual
  });
}

module.exports = { createEngine };
