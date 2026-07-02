'use strict';

/**
 * core/logger.js — Logger compartilhado entre todos os portais.
 *
 * Mantém um buffer circular dos últimos N logs (LOG_BUFFER_MAX) e provê
 * envio periódico ao servidor LiciteAgora via /api/electron/logs (a cada
 * LOG_FLUSH_INTERVAL ms). Comportamento idêntico ao logger inline anterior
 * em electron-browser.js — só foi extraído pra módulo.
 *
 * Uso:
 *   const { log, getBuffer, startLogSync } = require('./core/logger');
 *   log('hello');
 *   startLogSync({ apiKey, serverUrl, getState, getBearerTimestamp });
 */

const fs = require('fs');
const path = require('path');

const LOG_BUFFER_MAX = 200;
const LOG_FLUSH_INTERVAL = 5000;
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB → rotaciona pra main.1.log
const PENDING_MAX = 500;

const logBuffer = [];

// Log persistente em arquivo (diagnóstico de crashes). Até initFileLog() ser
// chamado (precisa do userData resolvido) as linhas de boot ficam em
// pendingFileLines e são descarregadas no arquivo assim que ele abre.
const pendingFileLines = [];
let logFilePath = null;

function _writeLine(line) {
  if (!logFilePath) {
    pendingFileLines.push(line);
    if (pendingFileLines.length > PENDING_MAX) pendingFileLines.shift();
    return;
  }
  try { fs.appendFileSync(logFilePath, line + '\n'); } catch (_) { /* nunca quebra o app por I/O */ }
}

// Abre (ou rotaciona) o arquivo de log e descarrega o buffer de boot.
// Retorna o caminho do arquivo, ou null se não conseguiu escrever.
function initFileLog(logDir) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, 'main.log');
    try {
      const st = fs.statSync(file);
      if (st.size > LOG_FILE_MAX_BYTES) fs.renameSync(file, path.join(logDir, 'main.1.log'));
    } catch (_) { /* arquivo ainda não existe */ }
    logFilePath = file;
    fs.appendFileSync(logFilePath, `\n===== sessão iniciada ${new Date().toISOString()} =====\n`);
    if (pendingFileLines.length) {
      fs.appendFileSync(logFilePath, pendingFileLines.join('\n') + '\n');
      pendingFileLines.length = 0;
    }
  } catch (_) {
    logFilePath = null;
  }
  return logFilePath;
}

function getLogFilePath() { return logFilePath; }

function log(msg) {
  const t = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  const line = `[${t}] ${msg}`;
  console.log(line);
  logBuffer.push({ time: new Date().toISOString(), msg });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  _writeLine(line);
}

function getBuffer() {
  return logBuffer;
}

let syncStarted = false;
let syncTimer = null;

function startLogSync({ getApiKey, getServerUrl, getState, getBearerTimestamp }) {
  if (syncStarted) return;
  syncStarted = true;
  syncTimer = setInterval(() => {
    const apiKey = typeof getApiKey === 'function' ? getApiKey() : null;
    const serverUrl = typeof getServerUrl === 'function' ? getServerUrl() : null;
    if (logBuffer.length === 0 || !apiKey || !serverUrl) return;
    const entries = logBuffer.splice(0, logBuffer.length);
    try {
      const url = new URL('/api/electron/logs', serverUrl);
      const mod = url.protocol === 'https:' ? require('https') : require('http');
      const ts = typeof getBearerTimestamp === 'function' ? getBearerTimestamp() : null;
      const body = JSON.stringify({
        logs: entries,
        state: typeof getState === 'function' ? getState() : null,
        bearerAge: ts ? Math.floor((Date.now() - ts) / 1000) : null,
      });
      const req = mod.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      }, () => {});
      req.on('error', () => {}); // silencia erros de rede
      req.end(body);
    } catch (_) { /* ignora URL malformada */ }
  }, LOG_FLUSH_INTERVAL);
}

function stopLogSync() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  syncStarted = false;
}

module.exports = {
  log,
  getBuffer,
  initFileLog,
  getLogFilePath,
  startLogSync,
  stopLogSync,
  LOG_BUFFER_MAX,
  LOG_FLUSH_INTERVAL,
};
