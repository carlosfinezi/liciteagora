// bll-captcha-bridge.js
//
// Bridge servidor↔Electron BLL pra obtenção de tokens reCAPTCHA v3 sob demanda.
// Porta de bnc-captcha-bridge.js — só muda o SITEKEY (BLL) e os endpoints.
//
// Fluxo:
//   1) Engine server-side precisa de token pra PerformBid → chama requestToken({action})
//      → registra pedido com id único, retorna Promise
//   2) Electron BLL roda captcha-relay que polla `getNextPending()` via HTTP
//   3) Electron executa grecaptcha.execute(sitekey, {action}) no webview da sala
//   4) Electron POSTa /api/electron/bll/captcha-token com {id, token}
//      → servidor chama deliverToken(id, token) que resolve a Promise pendente
//   5) Engine recebe token, monta PerformBid e dispara
//
// SITEKEY confirmado in-vivo 2026-06-29 (HAR do lance + data-sitekey do /Home/Login):
//   reCAPTCHA v3 invisible, action 'performBid'.
//
// Estado global (single Electron BLL ativo por servidor — só 1bit roda Electron).
// Pedidos pendentes morrem com restart (Promise rejeita por timeout). Aceitável.

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const DEFAULT_TIMEOUT_MS = 30000;
const events = new EventEmitter();

// reqId → { action, resolve, reject, createdAt, timeoutTimer, deliveredAt? }
const pending = new Map();
const SITEKEY = '6LdpKvsmAAAAAA4rzH5iQNswgItyulQ1J2HQ1FkK';

function requestToken({ action = 'performBid', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeoutTimer = setTimeout(() => {
      const r = pending.get(id);
      if (r && !r.deliveredAt) {
        pending.delete(id);
        reject(new Error(`captcha timeout ${timeoutMs}ms action=${action}`));
      }
    }, timeoutMs);
    pending.set(id, { action, resolve, reject, createdAt: Date.now(), timeoutTimer });
    events.emit('newRequest', { id, action });
  });
}

function getNextPending() {
  // FIFO: primeiro do Map (ordem de inserção)
  for (const [id, req] of pending) {
    if (req.deliveredAt) continue;
    return { id, action: req.action, sitekey: SITEKEY, ageMs: Date.now() - req.createdAt };
  }
  return null;
}

function deliverToken(id, token, error = null) {
  const req = pending.get(id);
  if (!req) return { ok: false, error: 'request desconhecido ou expirado' };
  if (req.deliveredAt) return { ok: false, error: 'já entregue' };
  clearTimeout(req.timeoutTimer);
  req.deliveredAt = Date.now();
  pending.delete(id);
  if (error) req.reject(new Error(`captcha relay erro: ${error}`));
  else if (!token) req.reject(new Error('token vazio'));
  else req.resolve(token);
  return { ok: true };
}

function cancelAll(reason = 'cancelled') {
  for (const [id, req] of pending) {
    clearTimeout(req.timeoutTimer);
    req.reject(new Error(reason));
    pending.delete(id);
  }
}

function stats() {
  const items = [];
  for (const [id, req] of pending) {
    items.push({ id, action: req.action, ageMs: Date.now() - req.createdAt });
  }
  return { pendingCount: items.length, items };
}

module.exports = {
  requestToken,
  getNextPending,
  deliverToken,
  cancelAll,
  stats,
  events,
  SITEKEY,
};
