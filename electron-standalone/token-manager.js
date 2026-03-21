// token-manager.js — Captura e gerenciamento do JWT do Comprasnet
'use strict';

const { saveToken, loadToken, clearToken } = require('./store');

const TOKEN_MAX_AGE_MS = 540000; // 9 min (mesmo da extensão)
const REFRESH_THRESHOLD_MS = 420000; // 7 min — reload webview antes de expirar

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

module.exports = {
  parseJWT,
  isTokenValid,
  isTokenExpiringSoon,
  tokenTTL,
  saveBearer,
  loadToken,
  clearToken,
};
