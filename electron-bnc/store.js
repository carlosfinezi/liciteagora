// store.js — persistência leve em JSON dentro do userData
'use strict';

const fs = require('fs');
const path = require('path');

let _file = null;
let _cache = null;

function init(userDataDir) {
  _file = path.join(userDataDir, 'bnc-store.json');
  try {
    _cache = JSON.parse(fs.readFileSync(_file, 'utf8'));
  } catch {
    _cache = {};
  }
}

function get(key, fallback = null) {
  if (!_cache) return fallback;
  return _cache[key] !== undefined ? _cache[key] : fallback;
}

function set(key, value) {
  if (!_cache) _cache = {};
  _cache[key] = value;
  try {
    fs.writeFileSync(_file, JSON.stringify(_cache, null, 2));
  } catch (e) {
    console.error('[store] erro ao salvar:', e.message);
  }
}

function del(key) {
  if (!_cache) return;
  delete _cache[key];
  try { fs.writeFileSync(_file, JSON.stringify(_cache, null, 2)); } catch {}
}

module.exports = { init, get, set, del };
