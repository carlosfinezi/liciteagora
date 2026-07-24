// store.js — Persistência do token em disco (entre reinícios do Electron)
'use strict';

const fs = require('fs');
const path = require('path');

const STORE_DIR = path.join(__dirname, '.electron-profile');
const STORE_PATH = path.join(STORE_DIR, 'liciteagora-session.json');

function saveToken(tokenData) {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(tokenData, null, 2));
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
  if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
}

module.exports = { saveToken, loadToken, clearToken };
