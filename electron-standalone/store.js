// store.js — Persistência local (entre reinícios do Electron):
//   - Bearer token (sessão Comprasnet) — STORE_DIR (ao lado do exe)
//   - Config multi-tenant: serverUrl + apiKey — CONFIG_DIR (%APPDATA%)
//
// 2026-04-30: separado em duas pastas. CONFIG_DIR usa app.getPath('userData')
// para persistir a API Key através de reboots do Windows e reinstalações
// (no target `portable` o exe extrai pra %TEMP% a cada execução, então
// path.dirname(process.execPath) seria wipado). STORE_DIR continua ao
// lado do exe pra preservar o comportamento atual de cookies/perfil
// Chromium (memory: deletar .electron-profile ao mudar versão por causa
// de fingerprint hCaptcha).
'use strict';

const fs = require('fs');
const path = require('path');

// STORE_DIR — bearer token + perfil Chromium (volátil entre versões)
// CONFIG_DIR — apiKey + serverUrl (persistente entre reboots/reinstall)
let STORE_DIR;
let CONFIG_DIR;
try {
  const { app } = require('electron');
  STORE_DIR = app.isPackaged
    ? path.join(path.dirname(process.execPath), '.electron-profile')
    : path.join(__dirname, '.electron-profile');
  CONFIG_DIR = app.isPackaged
    ? app.getPath('userData')
    : path.join(__dirname, '.electron-profile');
} catch {
  STORE_DIR = path.join(__dirname, '.electron-profile');
  CONFIG_DIR = path.join(__dirname, '.electron-profile');
}
const STORE_PATH = path.join(STORE_DIR, 'liciteagora-session.json');
const CONFIG_PATH = path.join(CONFIG_DIR, 'liciteagora-config.json');
// Fallback legado: configs salvas pela v4.x ficavam em STORE_DIR. Se
// existir lá e não em CONFIG_DIR, migra na primeira leitura.
const LEGACY_CONFIG_PATH = path.join(STORE_DIR, 'liciteagora-config.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ==================== TOKEN ====================

function saveToken(tokenData) {
  try {
    ensureDir(STORE_DIR);
    fs.writeFileSync(STORE_PATH, JSON.stringify(tokenData, null, 2));
  } catch (e) {
    console.error('[Store] Erro ao salvar token:', e.message);
  }
}

function loadToken() {
  try {
    if (!fs.existsSync(STORE_PATH)) return null;
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function clearToken() {
  try {
    if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
  } catch {
    // ignore
  }
}

// ==================== CONFIG MULTI-TENANT ====================
//
// { serverUrl: "https://1bit.liciteagora.app", apiKey: "abc...", tenantSlug: "1bit" }
//
// serverUrl: URL base do tenant (sem trailing slash). apiKey: chave
// do tenant (valor de config.api_key). tenantSlug: conveniência.

function saveConfig(cfg) {
  try {
    ensureDir(CONFIG_DIR);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('[Store] Erro ao salvar config:', e.message);
  }
}

function loadConfig() {
  try {
    let raw = null;
    if (fs.existsSync(CONFIG_PATH)) {
      raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    } else if (CONFIG_PATH !== LEGACY_CONFIG_PATH && fs.existsSync(LEGACY_CONFIG_PATH)) {
      // Migração one-shot v4.x → v5: copia config legada para o caminho persistente.
      raw = fs.readFileSync(LEGACY_CONFIG_PATH, 'utf8');
      try {
        ensureDir(CONFIG_DIR);
        fs.writeFileSync(CONFIG_PATH, raw);
      } catch (e) {
        console.error('[Store] Erro ao migrar config legada:', e.message);
      }
    }
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (!cfg || !cfg.serverUrl || !cfg.apiKey) return null;
    return cfg;
  } catch {
    return null;
  }
}

function clearConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  } catch {
    // ignore
  }
}

// Normaliza uma entrada de usuário (slug ou URL completa) em serverUrl
// limpo sem trailing slash. Aceita: "1bit" → https://1bit.liciteagora.app
//                                  "1bit.liciteagora.app" → https://...
//                                  "https://1bit.liciteagora.app/" → sem /
function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('serverUrl vazio');
  // slug simples (sem ponto, sem protocolo)
  if (!/[./:]/.test(s)) s = `https://${s}.liciteagora.app`;
  else if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}

module.exports = {
  saveToken, loadToken, clearToken,
  saveConfig, loadConfig, clearConfig,
  normalizeServerUrl,
  CONFIG_PATH,
};
