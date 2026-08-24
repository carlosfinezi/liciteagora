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

// ── Estratégia de ESCADA (posicionamento) — validada in-vivo 2026-08-05 ───────
// A BLL expõe a escada COMPLETA de participantes via /BatchListParticipant/BidAndInfo
// (≠ Comprasnet). Diferente da regra antiga (só cobrir o líder), o motor agora
// se posiciona no melhor degrau alcançável respeitando o piso. As leituras são:
//   1) /BatchList/PartialUnique?idProcess=<Pid>&idStatus=7 → 1 <tr id="rowN"> por
//      lote em disputa; do onclick extraímos:
//        FastBid   → ['[gkz]TOKEN_A','1']            (TOKEN_A = batchId do PerformBid)
//        BidAndInfo→ ['[gkz]TOKEN_A','[gkz]TOKEN_B'] (param2 = TOKEN_B p/ a escada)
//   2) /BatchListParticipant/BidAndInfo?param1=TOKEN_A&param2=TOKEN_B → {html} com
//      a tabela "PARTICIPANTE NNN | melhor lance" + "LANCE (PARTICIPANTE <nós>)".
// value do PerformBid é REAIS INTEIROS.

function pbrl(s) { // parse número pt-BR "4.485,00" → 4485
  if (s == null) return null;
  const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Linhas de lote do PartialUnique com os tokens de lance/escada.
function parsePartialRows(html) {
  const out = [];
  const rows = String(html || '').match(/<tr[^>]*id="row\d+"[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const td = (id) => {
      const m = row.match(new RegExp('<td[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)<\\/td>', 'i'));
      return m ? m[1].replace(/<[^>]+>/g, '').replace(/&#\d+;|&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim() : null;
    };
    const batchNumber = td('BatchNumber') != null ? Number(td('BatchNumber')) : null;
    if (batchNumber == null || Number.isNaN(batchNumber)) continue;
    const fb = row.match(/'FastBid'\s*,\s*\[\s*'(\[gkz\][^']+)'/);
    const bi = row.match(/'BidAndInfo'\s*,\s*\[\s*'(\[gkz\][^']+)'\s*,\s*'(\[gkz\][^']+)'/);
    out.push({
      batchNumber,
      title: td('Title') || ('LOTE ' + batchNumber),
      statusName: td('CurrentStatusName') || null,
      winnerBidderId: td('WinnerBidderId') || null,
      winnerBidValue: pbrl(td('WinnerBidValue')),
      fbToken: fb ? fb[1] : null,       // = batchId do PerformBid
      biToken1: bi ? bi[1] : (fb ? fb[1] : null),
      biToken2: bi ? bi[2] : null,
    });
  }
  return out;
}

// Escada + nossa posição a partir do JSON {html} do BidAndInfo.
function parseEscada(bodyJsonOrHtml) {
  let html = bodyJsonOrHtml;
  try { const j = JSON.parse(bodyJsonOrHtml); if (j && j.html) html = j.html; } catch { /* já é html */ }
  html = String(html || '');
  const ladder = [...html.matchAll(/PARTICIPANTE (\d+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)/g)]
    .map(m => ({ p: m[1], v: pbrl(m[2]) }))
    .filter(x => x.v != null);
  ladder.sort((a, b) => a.v - b.v);
  const meuId = (html.match(/LANCE \(PARTICIPANTE (\d+)\)/) || [])[1] || null;
  const minha = meuId ? ladder.find(x => x.p === meuId) : null;
  return {
    ladder,
    meuParticipante: meuId,
    meuValor: minha ? minha.v : null,
    minhaPosicao: minha ? ladder.indexOf(minha) + 1 : null,
  };
}

// Menor degrau (excluindo o nosso) coberto por V-dec >= piso → alvo = V-dec.
// Retorna null se já estamos na melhor posição alcançável ou nada é viável.
function calcAlvoEscada(escada, piso, dec) {
  const cand = escada.ladder.find(x => x.p !== escada.meuParticipante && x.v - dec >= piso);
  if (!cand) return null;
  const alvo = Math.floor(cand.v - dec);
  if (escada.meuValor != null && alvo >= escada.meuValor) return null; // já posicionado
  return { alvo, cobre: cand };
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
    escadaMode: config.escadaMode !== false,   // default: estratégia de escada
    fallbackMs: Number(config.fallbackMs ?? 5000),  // re-leitura periódica da escada
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

  // Estado da estratégia de escada
  const escadaLastBidAt = new Map(); // batchNumber → ts do último PerformBid (throttle)
  let escadaBusy = false;            // 1 ciclo por vez
  let escadaPending = false;         // pedido chegou durante um ciclo → re-roda
  let escadaTimer = null;            // fallback interval
  let disputaEncerrada = false;      // idStatus=7 sem FastBid → fim

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

    // Estratégia de escada: o UpdateStatus é só um GATILHO — a decisão vem da
    // leitura fresca da escada (posição real de todos), não dos campos do payload.
    if (cfg.escadaMode) {
      escadaCycle('push').catch(e => emitter.emit('error', e));
      return;
    }

    // Legado (cobrir só o líder pelos campos do payload) — mantido p/ fallback.
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

  // ── Ciclo de ESCADA ────────────────────────────────────────────────────────
  // Lê a escada ao vivo (PartialUnique + BidAndInfo), persiste via evento
  // 'escada' e — se dryRun=0 e o lote tiver auto-lance ativo — se reposiciona.
  async function escadaCycle(trigger) {
    if (disputaEncerrada) return;
    if (escadaBusy) { escadaPending = true; return; }
    escadaBusy = true;
    try {
      let pu;
      try {
        pu = await bllFetch(db, '/BatchList/PartialUnique?idProcess=' + encodeURIComponent(processId) + '&idStatus=7&startingNumber=0', {
          method: 'GET', headers: { Accept: 'text/html,*/*' },
        });
      } catch (e) { _log('escada: PartialUnique falhou:', e.message); return; }
      const rows = parsePartialRows(pu.body || '');
      const comLance = rows.filter(r => r.fbToken);
      if (!comLance.length) {
        // Sem botão de lance em idStatus=7 → disputa saiu da fase (encerrou/julgamento)
        disputaEncerrada = true;
        _log('escada: sem lote com FastBid (fase de lances encerrou) — motor em repouso');
        emitter.emit('escadaEncerrada', { trigger });
        return;
      }
      for (const row of comLance) {
        let esc;
        try {
          if (!row.biToken2) { esc = { ladder: [], meuParticipante: null, meuValor: null, minhaPosicao: null }; }
          else {
            const bi = await bllFetch(db, '/BatchListParticipant/BidAndInfo?param1=' + encodeURIComponent(row.biToken1) + '&param2=' + encodeURIComponent(row.biToken2), {
              method: 'GET', headers: { Accept: 'application/json,*/*', 'X-Requested-With': 'XMLHttpRequest' },
            });
            esc = parseEscada(bi.body || '');
          }
        } catch (e) { _log(`escada: BidAndInfo lote ${row.batchNumber} falhou:`, e.message); continue; }

        // Persistência (o scheduler grava em bll_salas_lotes + rebuild cache)
        emitter.emit('escada', {
          batchNumber: row.batchNumber,
          title: row.title,
          statusName: row.statusName,
          fbToken: row.fbToken,
          winnerBidderId: (esc.ladder[0] && ('PARTICIPANTE ' + esc.ladder[0].p)) || row.winnerBidderId,
          currentBest: (esc.ladder[0] && esc.ladder[0].v) != null ? esc.ladder[0].v : row.winnerBidValue,
          escada: esc,
        });

        // Decisão de lance
        let loteCfg = null;
        if (resolveLoteConfig) { try { loteCfg = resolveLoteConfig(row.batchNumber); } catch { loteCfg = null; } }
        const piso = Number(loteCfg ? (loteCfg.limiteMinimo ?? cfg.limiteMinimo) : cfg.limiteMinimo);
        const dec = Number(loteCfg ? (loteCfg.decremento ?? cfg.decremento) : cfg.decremento);
        const thr = Number(loteCfg ? (loteCfg.throttleMs ?? cfg.throttleMs) : cfg.throttleMs);
        const ativo = loteCfg ? !!loteCfg.ativo : false;

        const plano = calcAlvoEscada(esc, piso, dec);
        const posLabel = esc.minhaPosicao ? `${esc.minhaPosicao}º/${esc.ladder.length}` : '—';

        if (cfg.dryRun) {
          const msg = plano
            ? `🤖 DRY-RUN lote ${row.batchNumber} [${posLabel}] DARIA LANCE R$${plano.alvo} (cobre ${plano.cobre.p}@${plano.cobre.v}, piso ${piso})`
            : `🤖 DRY-RUN lote ${row.batchNumber} [${posLabel}] skip (nosso ${esc.meuValor ?? '—'}, líder ${esc.ladder[0] ? esc.ladder[0].v : '—'}, piso ${piso})`;
          _log(msg);
          continue;
        }
        if (!ativo) continue;
        if (!plano) continue;
        const since = escadaLastBidAt.has(row.batchNumber) ? Date.now() - escadaLastBidAt.get(row.batchNumber) : Infinity;
        if (since < thr) continue;
        escadaLastBidAt.set(row.batchNumber, Date.now());
        await sendBidEscada(row.fbToken, plano.alvo, row.batchNumber, plano.cobre)
          .catch(e => emitter.emit('error', e));
      }
    } finally {
      escadaBusy = false;
      if (escadaPending && !disputaEncerrada) {
        escadaPending = false;
        setTimeout(() => escadaCycle('pending').catch(() => {}), 40);
      }
    }
  }

  // PerformBid da estratégia de escada: batchId = token do FastBid da linha.
  async function sendBidEscada(fbToken, value, batchNumber, cobre) {
    if (!requestCaptchaToken) {
      emitter.emit('bidFailed', { batchNumber, value, error: 'sem requestCaptchaToken', stage: 'captcha-missing' });
      return;
    }
    let captchaToken;
    try {
      captchaToken = await requestCaptchaToken({ action: 'performBid', timeoutMs: 20000 });
    } catch (e) {
      _log(`⚠️  captcha falhou (lote ${batchNumber}): ${e.message}`);
      emitter.emit('bidFailed', { batchNumber, value, error: e.message, stage: 'captcha' });
      return;
    }
    const qs = new URLSearchParams({ batchId: fbToken, value: String(value), token: captchaToken }).toString();
    const t0 = Date.now();
    let resp;
    try {
      resp = await bllFetch(db, '/BatchListParticipant/PerformBid?' + qs, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
    } catch (e) {
      _log(`⚠️  PerformBid HTTP falhou (lote ${batchNumber}): ${e.message}`);
      emitter.emit('bidFailed', { batchNumber, value, error: e.message, stage: 'http' });
      return;
    }
    let body; try { body = JSON.parse(resp.body); } catch { body = { raw: resp.body }; }
    if (body && body.message === 'null') {
      _log(`✅ LANCE ACEITO lote ${batchNumber}: R$${value}${cobre ? ` (cobriu ${cobre.p}@${cobre.v})` : ''} em ${Date.now() - t0}ms`);
      emitter.emit('bidSent', { batchNumber, value, response: body });
      // re-lê logo em seguida pra confirmar posição
      escadaPending = true;
      return;
    }
    if (body && body.modal === 'error') {
      const errHtml = String(body.html || '').replace(/<[^>]+>/g, '').trim().slice(0, 200);
      _log(`❌ PerformBid recusado (lote ${batchNumber}): ${errHtml}`);
      emitter.emit('bidFailed', { batchNumber, value, error: errHtml, stage: 'server', raw: body });
      return;
    }
    _log(`⚠️  PerformBid resposta inesperada (lote ${batchNumber}) status=${resp.status}: ${JSON.stringify(body).slice(0, 160)}`);
    emitter.emit('bidUnknown', { batchNumber, value, response: body, status: resp.status });
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

  sig.on('updateInfoStatus', (data) => {
    emitter.emit('updateInfoStatus', data);
    if (cfg.escadaMode) escadaCycle('push-info').catch(e => emitter.emit('error', e));
  });
  sig.on('newDisputingBatch', (data) => emitter.emit('newDisputingBatch', data));
  // Sinais de chat (só gatilhos — não trazem texto; o conteúdo vem por fetch).
  for (const ev of ['newBatchMsg', 'newProcessMsg', 'newReadBatchMsg', 'newProcessAlert']) {
    sig.on(ev, (data) => emitter.emit('chatSignal', { event: ev, data }));
  }
  sig.on('connected', (info) => emitter.emit('connected', info));
  sig.on('disconnected', (reason) => emitter.emit('disconnected', reason));
  sig.on('error', (e) => emitter.emit('error', e));

  async function start() {
    await sig.start();
    if (cfg.escadaMode) {
      escadaCycle('boot').catch(e => emitter.emit('error', e));
      // fallback: re-lê a escada periodicamente mesmo sem push do SignalR
      escadaTimer = setInterval(() => {
        if (!disputaEncerrada) escadaCycle('fallback').catch(() => {});
      }, cfg.fallbackMs);
    }
  }
  function stop() {
    if (escadaTimer) { clearInterval(escadaTimer); escadaTimer = null; }
    sig.stop();
  }

  return Object.assign(emitter, {
    start,
    stop,
    status: () => ({
      signalR: sig.status(),
      cfg: { ...cfg, hasCaptcha: !!requestCaptchaToken },
      myParticipantUuid,
      disputaEncerrada,
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

module.exports = { createEngine, parsePartialRows, parseEscada, calcAlvoEscada };
