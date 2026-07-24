'use strict';

/**
 * portals/licitanet/server-bridge.js — HTTP client pros endpoints Licitanet do
 * servidor LiciteAgora. Mesma mecânica dos bridges BNC/BLL (X-Api-Key).
 *
 * Endpoints usados (servidor JÁ pronto — ver PLANO_COLETOR_LICITANET.md):
 *   GET  /api/electron/licitanet/pendentes?limit=N
 *        → { pendentes: [{ cnpj, ano, sequencial, processId, objeto }] }
 *   POST /api/electron/licitanet/ata  body { cnpj, ano, sequencial, ataUrl }
 *        → { ok, status, itensAta, mapeados, gravados }
 *   POST /api/electron/error  (sem auth) — relata exception
 *
 * Autenticação: header `X-Api-Key` (mesma apiKey que o Electron já usa).
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
function setServerUrl(u) { _serverUrl = u; }

function request(method, path, body, { timeout = 20000, requireAuth = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!_serverUrl) return reject(new Error('serverUrl não configurado'));
    if (requireAuth && !_apiKey) return reject(new Error('apiKey não configurada'));

    const u = new URL(_serverUrl + path);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json', 'User-Agent': 'LiciteAgora-Licitanet/1.0' };
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
        try { json = JSON.parse(text); } catch { /* não-JSON ok */ }
        resolve({ status: res.statusCode, body: json !== null ? json : text });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchPendentes(limit = 10) {
  const r = await request('GET', `/api/electron/licitanet/pendentes?limit=${encodeURIComponent(limit)}`);
  if (r.status !== 200) throw new Error(`pendentes HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  const list = r.body && Array.isArray(r.body.pendentes) ? r.body.pendentes : [];
  return list;
}

async function sendAta({ cnpj, ano, sequencial, ataUrl }) {
  const r = await request('POST', '/api/electron/licitanet/ata', { cnpj, ano, sequencial, ataUrl });
  if (r.status !== 200) throw new Error(`ata HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function reportError(context, err) {
  try {
    await request('POST', '/api/electron/error', {
      context,
      error: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
      timestamp: new Date().toISOString(),
    }, { requireAuth: false, timeout: 5000 });
  } catch (e) { /* silencioso */ }
}

module.exports = { init, setApiKey, setServerUrl, fetchPendentes, sendAta, reportError };
