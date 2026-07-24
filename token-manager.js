// token-manager.js — Captura e gerenciamento do JWT do Comprasnet
'use strict';

const { saveToken, loadToken, clearToken } = require('./store');

const API_BASE = 'https://cnetmobile.estaleiro.serpro.gov.br';
const TOKEN_MAX_AGE_MS = 540000; // 9 min (mesmo da extensão)
const REFRESH_THRESHOLD_MS = 420000; // 7 min — fazer retoken antes de expirar

// ─── Parseia JWT sem biblioteca externa ───────────────────────────────────

function parseJWT(token) {
  try {
    // Remover "Bearer " se presente
    const raw = token.startsWith('Bearer ') ? token.substring(7) : token;
    const base64 = raw.split('.')[1]
      .replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base64, 'base64').toString());
  } catch {
    return null;
  }
}

// ─── Verifica se token ainda é válido ─────────────────────────────────────

function isTokenValid(tokenData) {
  if (!tokenData?.token) return false;
  const now = Date.now();
  // Usar expiresAt do JWT ou issuedAt + 9min
  if (tokenData.expiresAt) return tokenData.expiresAt > now;
  if (tokenData.issuedAt) return (now - tokenData.issuedAt) < TOKEN_MAX_AGE_MS;
  return false;
}

// ─── Verifica se token precisa de refresh ─────────────────────────────────

function isTokenExpiringSoon(tokenData) {
  if (!tokenData?.issuedAt) return true;
  return (Date.now() - tokenData.issuedAt) > REFRESH_THRESHOLD_MS;
}

// ─── Tempo restante em segundos ───────────────────────────────────────────

function tokenTTL(tokenData) {
  if (!tokenData) return 0;
  if (tokenData.expiresAt) return Math.max(0, Math.floor((tokenData.expiresAt - Date.now()) / 1000));
  if (tokenData.issuedAt) return Math.max(0, Math.floor((TOKEN_MAX_AGE_MS - (Date.now() - tokenData.issuedAt)) / 1000));
  return 0;
}

// ─── Salva token capturado pelo onBeforeSendHeaders ───────────────────────

function saveBearer(bearer) {
  const claims = parseJWT(bearer);
  const tokenData = {
    token: bearer,
    issuedAt: Date.now(),
    expiresAt: claims?.exp ? claims.exp * 1000 : Date.now() + TOKEN_MAX_AGE_MS,
    sub: claims?.sub || null,
  };
  saveToken(tokenData);
  return tokenData;
}

// ─── Tenta retoken via API do Comprasnet ──────────────────────────────────

async function tryRetoken(webContents, currentBearer) {
  try {
    const bearer = currentBearer || '';
    const result = await webContents.executeJavaScript(`
      (async () => {
        try {
          const resp = await fetch('${API_BASE}/comprasnet-disputa/v1/retoken', {
            method: 'PUT',
            credentials: 'include',
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'Content-Type': 'application/json',
              'x-device-platform': 'web',
              'x-version-number': '6.0.0',
              'Authorization': '${bearer}',
            },
          });
          return { ok: resp.ok, status: resp.status };
        } catch (e) {
          return { ok: false, status: 0, error: e.message };
        }
      })()
    `);

    if (result.ok) {
      console.log('[TokenManager] Retoken OK');
      // Novo bearer será capturado automaticamente via onBeforeSendHeaders
      // Forçar uma chamada para capturar o novo token
      await new Promise(r => setTimeout(r, 500));
      await webContents.executeJavaScript(`
        fetch('${API_BASE}/comprasnet-disputa/v1/datahorabrasilia', {
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'x-device-platform': 'web',
            'x-version-number': '6.0.0',
            'Authorization': '${bearer}'
          }
        }).catch(() => {});
      `).catch(() => {});
      return true;
    } else {
      console.log(`[TokenManager] Retoken falhou: ${result.status}`);
      return false;
    }
  } catch (e) {
    console.error('[TokenManager] Retoken erro:', e.message);
    return false;
  }
}

// ─── Keepalive da API (datahorabrasilia) ──────────────────────────────────

async function keepaliveAPI(webContents, bearer) {
  try {
    const result = await webContents.executeJavaScript(`
      (async () => {
        try {
          const resp = await fetch('${API_BASE}/comprasnet-disputa/v1/datahorabrasilia', {
            credentials: 'include',
            headers: {
              'Accept': 'application/json',
              'x-device-platform': 'web',
              'x-version-number': '6.0.0',
              'Authorization': '${bearer || ''}',
            },
          });
          const text = await resp.text();
          return { ok: resp.ok, status: resp.status, body: text.substring(0, 50) };
        } catch (e) {
          return { ok: false, status: 0, error: e.message };
        }
      })()
    `);
    return result;
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

// ─── Keepalive legado (main.asp) ──────────────────────────────────────────

async function keepaliveLegacy(webContents) {
  try {
    await webContents.executeJavaScript(`
      fetch('https://www.comprasnet.gov.br/main.asp?login=keepalive', {
        credentials: 'include', mode: 'no-cors'
      }).catch(() => {});
    `);
  } catch (e) {
    // Silencioso
  }
}

module.exports = {
  parseJWT,
  isTokenValid,
  isTokenExpiringSoon,
  tokenTTL,
  saveBearer,
  tryRetoken,
  keepaliveAPI,
  keepaliveLegacy,
  loadToken,
  clearToken,
};
