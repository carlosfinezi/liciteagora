// bll-signalr-client.js
//
// Cliente SignalR v2 (ASP.NET classic) para o hub `batchScreenHub` da BLL.
// Porta de bnc-signalr-client.js — a BLL roda a MESMA plataforma do BNC
// (mesmo hub, mesmos eventos, mesmo heartbeat). Mapeado in-vivo 2026-06-29 via
// /Scripts/JS/Dispute-1.0.3.js + script inline da página /BatchList:
//   $.connection.batchScreenHub
//   $.connection.hub.qs = "Pid=<param1 da sala [gkz]>&Uid=<[gkz] participante>"
//   hub.client.UpdateStatus      → signalrUpdateBatch     (lance/status)
//   hub.client.UpdateInfoStatus  → signalrUpdateBatchInfo
//   hub.client.newDisputingBatch → signalrNewDisputingBatch
//   hub.client.PingCallback      → marca lastPingTime
//   POST Notification/Ping?connectionId=<id> a cada 60s (heartbeat)
//
// Reusa o cookie de sessão capturado pelo Electron BLL (config.bll_session_cookie
// via bll-client.js) — o mesmo cookie autentica negotiate, WebSocket e Ping.
//
// IMPORTANTE: este cliente é SOMENTE LEITURA. Não envia lance (PerformBid). O
// envio fica no bll-dispute-engine (Fase 3 seguinte), sempre com dryRun default.
//
// Protocolo SignalR v2:
//   1) GET  /signalr/negotiate?clientProtocol=2.1&connectionData=[{name:"batchScreenHub"}]&Pid=...&Uid=...
//        → { ConnectionToken, ConnectionId, TryWebSockets, KeepAliveTimeout, ... }
//   2) WS   /signalr/connect?transport=webSockets&clientProtocol=2.0
//        &connectionToken=<urlenc>&connectionData=<urlenc>&Pid=...&Uid=...&tid=<rand>
//   3) GET  /signalr/start?transport=webSockets&clientProtocol=2.0&connectionToken=...&connectionData=...
//        → { Response: "started" }
//   4) Cada frame WS é JSON. Hub invocations do servidor:
//        { "C": "msgId", "M": [ { "H": "batchScreenHub", "M": "UpdateStatus", "A": [arg0, ...] } ] }
//      Outros frames: {} = keep-alive, { "S": 1 } = initialized.
//   5) Heartbeat: POST /Notification/Ping?connectionId=<id> a cada 60s (HTTP, não no WS)
//
// API:
//   const c = createClient({ db, processId, userId, log? });
//   c.on('UpdateStatus', (data) => {...});
//   c.on('UpdateInfoStatus', (data) => {...});
//   c.on('newDisputingBatch', (data) => {...});
//   c.on('connected', () => {...});
//   c.on('disconnected', (reason) => {...});
//   c.on('frame', (raw) => {...});   // debug, todos os frames
//   c.on('error', (err) => {...});
//   await c.start();
//   c.stop();
//   c.status() → { state, connectionId, lastFrameAt, frameCount }

'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const {
  bllFetch, bllPost, BLL_BASE, UA,
  BllSessaoIndisponivelError,
} = require('./bll-client');

const HUB_NAME = 'batchScreenHub';
const CLIENT_PROTOCOL = '2.1';
const PING_INTERVAL_MS = 60 * 1000;
const RECONNECT_DELAY_MS = 5000;

function readCookie(db) {
  const r = db.prepare("SELECT valor FROM config WHERE chave='bll_session_cookie'").get();
  if (!r?.valor) throw new BllSessaoIndisponivelError();
  return r.valor;
}

function buildConnectionData() {
  return JSON.stringify([{ name: HUB_NAME }]);
}

async function negotiate({ db, processId, userId }) {
  const qs = new URLSearchParams({
    clientProtocol: CLIENT_PROTOCOL,
    connectionData: buildConnectionData(),
    Pid: processId,
    Uid: userId,
    _: String(Date.now()),
  }).toString();
  const r = await bllFetch(db, '/signalr/negotiate?' + qs, {
    method: 'GET',
    headers: { Accept: 'text/plain, */*; q=0.01' },
  });
  if (r.status !== 200) {
    throw new Error(`negotiate HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  }
  return JSON.parse(r.body);
}

async function callStart({ db, connectionToken, processId, userId }) {
  const qs = new URLSearchParams({
    transport: 'webSockets',
    clientProtocol: CLIENT_PROTOCOL,
    connectionToken,
    connectionData: buildConnectionData(),
    Pid: processId,
    Uid: userId,
    _: String(Date.now()),
  }).toString();
  const r = await bllFetch(db, '/signalr/start?' + qs, {
    method: 'GET',
    headers: { Accept: 'text/plain, */*; q=0.01' },
  });
  if (r.status !== 200) {
    throw new Error(`start HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  }
  return JSON.parse(r.body);
}

function createClient({ db, processId, userId, log }) {
  if (!db) throw new Error('db obrigatório');
  if (!processId) throw new Error('processId obrigatório');
  if (!userId) throw new Error('userId obrigatório');
  const _log = log || ((...a) => console.log('[bll-signalr]', ...a));
  const emitter = new EventEmitter();

  let state = 'idle';   // idle | negotiating | connecting | connected | reconnecting | stopped
  let ws = null;
  let connectionId = null;
  let connectionToken = null;
  let keepAliveMs = 20000;
  let pingTimer = null;
  let stopRequested = false;
  let lastFrameAt = null;
  let frameCount = 0;
  let reconnectAttempts = 0;

  function setState(s) {
    if (state === s) return;
    state = s;
    emitter.emit('state', s);
    _log('state →', s);
  }

  async function doNegotiate() {
    setState('negotiating');
    const neg = await negotiate({ db, processId, userId });
    if (!neg.TryWebSockets) throw new Error('servidor não permite WebSockets');
    connectionId = neg.ConnectionId;
    connectionToken = neg.ConnectionToken;
    keepAliveMs = (neg.KeepAliveTimeout || 20) * 1000;
    _log(`negotiate ok connId=${connectionId} keepAlive=${keepAliveMs}ms`);
    return neg;
  }

  function buildWsUrl() {
    const tid = Math.floor(Math.random() * 11);
    const qs = new URLSearchParams({
      transport: 'webSockets',
      clientProtocol: CLIENT_PROTOCOL,
      connectionToken,
      connectionData: buildConnectionData(),
      Pid: processId,
      Uid: userId,
      tid: String(tid),
    }).toString();
    return 'wss://bllcompras.com/signalr/connect?' + qs;
  }

  function handleFrame(raw) {
    lastFrameAt = Date.now();
    frameCount++;
    emitter.emit('frame', raw);
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // {} = keep-alive
    if (!msg || Object.keys(msg).length === 0) {
      emitter.emit('keepAlive');
      return;
    }

    // {S:1} = init confirmation
    if (msg.S === 1) {
      _log('frame init S=1');
      emitter.emit('initialized');
      return;
    }

    // Hub invocations
    if (Array.isArray(msg.M)) {
      for (const inv of msg.M) {
        const method = inv.M;
        const args = inv.A || [];
        const payload = args.length === 1 ? args[0] : args;
        emitter.emit(method, payload, inv);
        emitter.emit('hub', { method, payload, inv });
      }
      return;
    }

    // Response a invocação client→server (não usamos hoje, mas log)
    if ('I' in msg) {
      emitter.emit('rpcResponse', msg);
      return;
    }
  }

  function startPingTimer() {
    stopPingTimer();
    pingTimer = setInterval(async () => {
      if (state !== 'connected' || !connectionId) return;
      try {
        const r = await bllPost(db, '/Notification/Ping?connectionId=' + encodeURIComponent(connectionId), null, {
          'Content-Type': 'application/json;charset=utf-8',
        });
        if (r.status !== 200) {
          _log(`ping HTTP ${r.status} — vai reconectar`);
          scheduleReconnect('ping-fail');
        }
      } catch (e) {
        _log('ping erro:', e.message);
        scheduleReconnect('ping-error');
      }
    }, PING_INTERVAL_MS);
  }

  function stopPingTimer() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function scheduleReconnect(reason) {
    if (stopRequested) return;
    if (state === 'reconnecting' || state === 'negotiating' || state === 'connecting') return;
    setState('reconnecting');
    emitter.emit('disconnected', reason);
    stopPingTimer();
    if (ws) {
      try { ws.removeAllListeners(); ws.close(); } catch {}
      ws = null;
    }
    const attempt = ++reconnectAttempts;
    const delay = Math.min(RECONNECT_DELAY_MS * Math.min(attempt, 6), 30000);
    _log(`reconectar em ${delay}ms (${reason}, tentativa ${attempt})`);
    setTimeout(() => {
      if (!stopRequested) connectOnce().catch(e => {
        _log('reconnect falhou:', e.message);
        scheduleReconnect('reconnect-err');
      });
    }, delay);
  }

  async function connectOnce() {
    if (stopRequested) return;
    await doNegotiate();
    setState('connecting');

    const cookie = readCookie(db);
    const wsUrl = buildWsUrl();
    _log('WS connect…');
    ws = new WebSocket(wsUrl, {
      headers: {
        Cookie: cookie,
        'User-Agent': UA,
        Origin: BLL_BASE,
      },
      perMessageDeflate: false,
    });

    await new Promise((resolve, reject) => {
      const onOpen = () => { ws.off('error', onErr); resolve(); };
      const onErr = (e) => { ws.off('open', onOpen); reject(e); };
      ws.once('open', onOpen);
      ws.once('error', onErr);
    });

    _log('WS aberto, chamando /signalr/start');
    ws.on('message', (data) => {
      const raw = data.toString('utf8');
      try { handleFrame(raw); } catch (e) { _log('handleFrame err:', e.message); }
    });
    ws.on('close', (code, reason) => {
      _log(`WS close code=${code} reason=${reason}`);
      if (!stopRequested) scheduleReconnect(`ws-close-${code}`);
    });
    ws.on('error', (e) => {
      _log('WS error:', e.message);
      emitter.emit('error', e);
    });

    await callStart({ db, connectionToken, processId, userId });
    _log('start ok');
    setState('connected');
    reconnectAttempts = 0;
    startPingTimer();
    emitter.emit('connected', { connectionId });
  }

  async function start() {
    if (state !== 'idle' && state !== 'stopped') return;
    stopRequested = false;
    reconnectAttempts = 0;
    try {
      await connectOnce();
    } catch (e) {
      _log('connectOnce falhou:', e.message);
      scheduleReconnect('initial-fail');
      throw e;
    }
  }

  function stop() {
    stopRequested = true;
    stopPingTimer();
    if (ws) {
      try { ws.removeAllListeners(); ws.close(); } catch {}
      ws = null;
    }
    setState('stopped');
  }

  function status() {
    return {
      state,
      connectionId,
      lastFrameAt: lastFrameAt ? new Date(lastFrameAt).toISOString() : null,
      frameCount,
      reconnectAttempts,
    };
  }

  // EventEmitter façade
  return Object.assign(emitter, { start, stop, status });
}

module.exports = { createClient, negotiate };
