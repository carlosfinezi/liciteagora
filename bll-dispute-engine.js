// bll-dispute-engine.js
//
// Motor de decisão de lance pra sala BLL (bllcompras.com). Porta de
// bnc-dispute-engine.js — mesma plataforma/protocolo (hub batchScreenHub,
// PerformBid). Encapsula:
//   - cliente SignalR (bll-signalr-client)
//   - estado por lote (currentBest, fkParticipantLider, lastUpdate)
//   - regra de decisão (decremento, limiteMinimo, throttle, dryRun)
//   - emissão de "decision" events que a camada superior consome
//
// ⚠️  DIFERENÇAS BLL vs BNC (importantes):
//   1) value do PerformBid é REAIS INTEIROS (confirmado in-vivo 2026-06-29:
//      value=11850 = R$ 11.850,00), NÃO 4 casas decimais como o BNC. myNextBid
//      é arredondado pra inteiro.
//   2) O frontend BLL (Dispute-1.0.3.js) NÃO lê o valor direto do payload do
//      UpdateStatus — faz POST BatchList/ConvertBatchDataToViewModel e usa
//      {VmBatchData, IsWinner}. Logo os NOMES DOS CAMPOS CRUS do UpdateStatus
//      do BLL podem diferir do BNC (WinnerBidValue/fkParticipant). Ainda não
//      capturamos um UpdateStatus ao vivo. Por isso:
//        - extractBest()/extractLider() tentam VÁRIOS nomes candidatos;
//        - no PRIMEIRO UpdateStatus o engine faz dump do payload cru (evento
//          'rawSample' + log) pra revelarmos os nomes reais e finalizarmos.
//   3) captcha: o token reCAPTCHA v3 (action 'performBid') é injetado via
//      config.requestCaptchaToken (sem hard-dep no bridge, que é Fase seguinte).
//
// 🔒 SEGURANÇA: dryRun default = true. Só envia PerformBid com dryRun=false
//    E requestCaptchaToken fornecido E batchToken [gkz] conhecido.
//
// API:
//   const eng = createEngine({
//     db, processId, userId,
//     config: { limiteMinimo, decremento, throttleMs, dryRun, requestCaptchaToken },
//     getLoteConfig,  // (idBatch) → { ativo, limiteMinimo, decremento, throttleMs } | null
//   });
//   eng.on('decision'|'updateStatus'|'rawSample'|'connected'|'disconnected'|'error', ...);
//   await eng.start();  eng.stop();  eng.status();

'use strict';

const { EventEmitter } = require('events');
const { createClient } = require('./bll-signalr-client');
const { bllFetch } = require('./bll-client');

// Nomes candidatos pros campos do payload cru do UpdateStatus (a confirmar com
// captura ao vivo — ver nota (2) no topo). A ordem é a preferência.
const BEST_KEYS = ['WinnerBidValue', 'WinnerValue', 'BestValue', 'BestBidValue', 'bidValue', 'Value', 'value'];
const LIDER_KEYS = ['fkParticipant', 'FkParticipant', 'WinnerParticipant', 'ParticipantId', 'fkParticipantWinner'];
const BATCH_KEYS = ['idBatch', 'IdBatch', 'idBatchUuid', 'BatchUuid', 'BatchId', 'BatchNumber'];

function firstFinite(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null) {
      const n = Number(String(obj[k]).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
      if (Number.isFinite(n)) return n;
    }
  }
  return NaN;
}

function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

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
  // Injeção do provedor de token reCAPTCHA v3 (action 'performBid'). Sem ele,
  // sendBid falha de forma controlada (nunca em dryRun, que não envia).
  const requestCaptchaToken = typeof config.requestCaptchaToken === 'function'
    ? config.requestCaptchaToken : null;

  const resolveLoteConfig = typeof getLoteConfig === 'function' ? getLoteConfig : null;

  const _log = log || ((...a) => console.log('[bll-engine]', ...a));
  const emitter = new EventEmitter();
  const sig = createClient({ db, processId, userId, log: _log });

  const lotes = new Map();           // idBatch → { currentBest, fkParticipantLider, lastUpdate, lastBidAt }
  const batchTokens = new Map();     // idBatch → [gkz] token (necessário pra PerformBid)
  let myParticipantUuid = null;      // aprendido reativamente
  let pendingLearnBid = null;        // { value, sentAt }
  let rawSampleDumped = false;       // dump único do payload cru pra mapear campos

  function fmtBatch(idBatch) {
    return idBatch ? String(idBatch).slice(0, 8) : '?';
  }

  function extractBest(data) { return firstFinite(data, BEST_KEYS); }
  function extractLider(data) { return firstDefined(data, LIDER_KEYS); }
  function extractBatchId(data) { return firstDefined(data, BATCH_KEYS); }

  function decide(data, loteState) {
    const best = extractBest(data);
    const idBatch = extractBatchId(data);
    const lider = extractLider(data);
    const base = {
      batchId: idBatch,
      currentBest: best,
      fkParticipantLider: lider,
      knowsBatchToken: batchTokens.has(idBatch),
    };

    if (!Number.isFinite(best)) {
      return { ...base, action: 'skip', reason: 'best inválido (campo do payload a confirmar — ver rawSample)', myNextBid: null };
    }

    // Gate de auto-lance por lote (bll_auto_lance).
    let loteConfig = null;
    if (resolveLoteConfig) {
      try { loteConfig = resolveLoteConfig(idBatch); } catch (e) { loteConfig = null; }
      if (!loteConfig) {
        return { ...base, action: 'skip', reason: 'lote sem config bll_auto_lance', myNextBid: null };
      }
      if (!loteConfig.ativo) {
        return { ...base, action: 'skip', reason: 'auto-lance desligado pro lote', myNextBid: null };
      }
    }
    const lim = loteConfig ? Number(loteConfig.limiteMinimo ?? cfg.limiteMinimo) : cfg.limiteMinimo;
    const dec = loteConfig ? Number(loteConfig.decremento ?? cfg.decremento) : cfg.decremento;
    const thr = loteConfig ? Number(loteConfig.throttleMs ?? cfg.throttleMs) : cfg.throttleMs;

    if (best <= lim) {
      return { ...base, action: 'skip', reason: `best ${best} <= limiteMinimo ${lim}`, myNextBid: null };
    }
    if (myParticipantUuid && lider === myParticipantUuid) {
      return { ...base, action: 'skip', reason: 'eu sou o líder', myNextBid: null };
    }
    // value em REAIS INTEIROS (semântica BLL confirmada). Arredonda pra baixo.
    const myNextBid = Math.floor(best - dec);
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
    // Dump único do payload cru — revela os nomes reais dos campos do BLL.
    if (!rawSampleDumped) {
      rawSampleDumped = true;
      let s; try { s = JSON.stringify(data); } catch { s = String(data); }
      _log('🔬 PRIMEIRO UpdateStatus (payload cru p/ mapear campos): ' + (s || '').slice(0, 800));
      emitter.emit('rawSample', data);
    }

    const idBatch = extractBatchId(data);
    const prev = lotes.get(idBatch) || {};
    const novo = {
      ...prev,
      currentBest: extractBest(data),
      fkParticipantLider: extractLider(data),
      lastUpdate: Date.now(),
    };
    lotes.set(idBatch, novo);

    // Aprendizado reativo do meu participantUuid
    const best = novo.currentBest;
    if (!myParticipantUuid && pendingLearnBid &&
        Math.abs(Date.now() - pendingLearnBid.sentAt) < 5000 &&
        Number(best) === pendingLearnBid.value) {
      myParticipantUuid = novo.fkParticipantLider;
      _log(`✨ aprendi meu fkParticipant = ${myParticipantUuid} (correlacionado com lance ${pendingLearnBid.value})`);
      pendingLearnBid = null;
      emitter.emit('learnedParticipant', myParticipantUuid);
    }

    emitter.emit('updateStatus', data);

    const decision = decide(data, novo);
    emitter.emit('decision', decision);

    if (cfg.dryRun) {
      const msg = decision.action === 'bid'
        ? `🤖 DRY-RUN [batch ${fmtBatch(idBatch)}] DARIA LANCE R$${decision.myNextBid} (best=${decision.currentBest}, líder=${fmtBatch(decision.fkParticipantLider)})`
        : `🤖 DRY-RUN [batch ${fmtBatch(idBatch)}] skip: ${decision.reason} (best=${decision.currentBest})`;
      _log(msg);
      return;
    }

    if (decision.action === 'bid') {
      lotes.set(idBatch, { ...novo, lastBidAt: Date.now() });
      sendBid(decision).catch(e => emitter.emit('error', e));
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
    if (!requestCaptchaToken) {
      const err = 'requestCaptchaToken não fornecido — não dá pra cunhar token reCAPTCHA v3 (action performBid)';
      _log('⚠️  ' + err);
      emitter.emit('bidFailed', { ...decision, error: err, stage: 'captcha-missing' });
      return;
    }

    // 1) Token reCAPTCHA v3 (cunhado no webview Electron via bridge injetado)
    let captchaToken;
    try {
      captchaToken = await requestCaptchaToken({ action: 'performBid', timeoutMs: 20000 });
    } catch (e) {
      _log(`⚠️  captcha falhou: ${e.message}`);
      emitter.emit('bidFailed', { ...decision, error: e.message, stage: 'captcha' });
      return;
    }

    // 2) POST /BatchListParticipant/PerformBid?batchId=<gkz>&value=<reais inteiros>&token=<recaptcha>
    const qs = new URLSearchParams({
      batchId: gkz,
      value: String(decision.myNextBid),   // BLL: reais inteiros
      token: captchaToken,
    }).toString();

    _log(`🚀 enviando PerformBid value=${decision.myNextBid} batch=${fmtBatch(idBatch)}`);
    let resp;
    try {
      resp = await bllFetch(db, '/BatchListParticipant/PerformBid?' + qs, {
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

    // 3) Interpretar resposta — sucesso BLL: {"message":"null"}; erro: {"modal":"error","html":...}
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
      pendingLearnBid = { value: Number(decision.myNextBid), sentAt: Date.now() };
      emitter.emit('bidSent', { ...decision, response: body });
      return;
    }
    _log(`⚠️  PerformBid resposta inesperada status=${resp.status}: ${JSON.stringify(body).slice(0, 200)}`);
    emitter.emit('bidUnknown', { ...decision, response: body, status: resp.status });
  }

  // Descobre tokens [gkz] dos lotes via GET /BatchList parseando o HTML.
  // ⚠️  O regex abaixo é o do BNC ('FastBid') — a estrutura do botão de lance da
  // BLL PODE diferir. A confirmar com a página /BatchList real (ver Dispute-1.0.3.js
  // / room.html). Por ora capturamos qualquer [gkz] próximo a 'PerformBid'/'Bid'.
  async function discoverBatchTokens() {
    const r = await bllFetch(db, '/BatchList?param1=' + encodeURIComponent(processId) + '&param2=7', {
      method: 'GET',
      headers: { Accept: 'text/html,*/*' },
    });
    if (r.status !== 200) throw new Error(`GET /BatchList HTTP ${r.status}`);
    const tokens = new Set();
    const reList = [
      /'FastBid'\s*,\s*\[\s*'(\[gkz\][^']+)'/g,          // padrão BNC
      /PerformBid[^'"]*['"]?\?[^'"]*batchId=(\[gkz\][^'"&]+)/gi, // fallback BLL
    ];
    for (const re of reList) {
      let m;
      while ((m = re.exec(r.body || '')) !== null) tokens.add(m[1]);
    }
    _log(`discoverBatchTokens: ${tokens.size} token(s) encontrado(s)`);
    return Array.from(tokens);
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
      cfg: { ...cfg, hasCaptcha: !!requestCaptchaToken },
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
