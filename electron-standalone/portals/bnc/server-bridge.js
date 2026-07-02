'use strict';

/**
 * portals/bnc/server-bridge.js — HTTP client pra endpoints BNC do servidor
 * LiciteAgora.
 *
 * Portado de electron-bnc/server-bridge.js. Comportamento idêntico.
 * Sem alterações de payload/headers/auth — só foi movido pro layout do
 * binário unificado (electron-standalone com --portal=bnc).
 *
 * Endpoints usados:
 *   GET  /api/electron/bnc/credentials  → { usuario, senha }
 *   POST /api/electron/bnc/cookies      → { cookie, usuario?, perfil? }
 *   GET  /api/electron/bnc/session      → { configurado, idadeMs, usuario, perfil, expirando }
 *   POST /api/electron/error            → relata exception (sem auth)
 *   POST /api/electron/logs             → push de logs (com auth)
 *
 * Autenticação: header `X-Api-Key`. Lê do init.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

let _serverUrl = null;
let _apiKey = null;
let _log = (...a) => console.log(...a);

function init({ serverUrl, apiKey, log }) {
  _serverUrl = serverUrl;
  _apiKey = apiKey;
  if (log) _log = log;
}

function setApiKey(k) { _apiKey = k; }
function getApiKey() { return _apiKey; }
function setServerUrl(u) { _serverUrl = u; }

function request(method, pathOrUrl, body, { timeout = 15000, requireAuth = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!_serverUrl && !pathOrUrl.startsWith('http')) {
      return reject(new Error('serverUrl não configurado'));
    }
    if (requireAuth && !_apiKey) {
      return reject(new Error('apiKey não configurada'));
    }

    const fullUrl = pathOrUrl.startsWith('http') ? pathOrUrl : (_serverUrl + pathOrUrl);
    const u = new URL(fullUrl);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'LiciteAgora-BNC/1.0',
    };
    if (requireAuth) headers['X-Api-Key'] = _apiKey;
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = mod.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* não-JSON é ok */ }
        resolve({ status: res.statusCode, body: json !== null ? json : text });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error('timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchCredentials() {
  const r = await request('GET', '/api/electron/bnc/credentials');
  if (r.status !== 200) {
    throw new Error(`credentials HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  }
  if (r.body && r.body.error) throw new Error(r.body.error);
  if (!r.body || !r.body.usuario || !r.body.senha) throw new Error('resposta sem usuario/senha');
  return r.body;
}

async function sendCookies({ cookie, usuario, perfil }) {
  const r = await request('POST', '/api/electron/bnc/cookies', { cookie, usuario, perfil });
  if (r.status !== 200) throw new Error(`cookies HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function getSessionStatus() {
  const r = await request('GET', '/api/electron/bnc/session');
  if (r.status !== 200) throw new Error(`session HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function reportError(ctx, err) {
  try {
    await request('POST', '/api/electron/error', {
      context: ctx,
      error: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
      timestamp: new Date().toISOString(),
    }, { requireAuth: false, timeout: 5000 });
  } catch (e) {
    _log(`[bridge] reportError falhou: ${e.message}`);
  }
}

async function sendLogs(logs, state = 'running') {
  if (!_apiKey) return;
  try {
    await request('POST', '/api/electron/logs', { logs, state }, { timeout: 5000 });
  } catch (e) {
    // silencioso
  }
}

// Façade genérica pra módulos consumirem qualquer endpoint do servidor
// (usado pelo captcha-relay que polla /api/electron/bnc/captcha-pending e
// /captcha-token, sem precisar de helpers dedicados).
async function requestRaw(method, path, body) {
  return request(method, path, body);
}

module.exports = {
  init,
  setApiKey,
  getApiKey,
  setServerUrl,
  fetchCredentials,
  sendCookies,
  getSessionStatus,
  reportError,
  sendLogs,
  requestRaw,
};
