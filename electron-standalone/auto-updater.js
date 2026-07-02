'use strict';

/**
 * auto-updater.js — Auto-update para Electron portable exe
 *
 * electron-updater NÃO suporta portable. Implementação customizada:
 *   1. Check: GET /api/electron/version → compara semver
 *   2. Download: baixa novo exe, verifica SHA256
 *   3. Apply: lança novo exe com --replace-old, sai do atual
 *   4. Cleanup: novo exe deleta o antigo na inicialização
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Multi-tenant (Fase 6): SERVER_URL vem do init(). Cada tenant tem
// sua própria URL e pode servir sua própria versão do Electron.
let SERVER_URL = null;
const CHECK_INTERVAL_MS = 3600000; // 1 hora

let _log = console.log;
let _currentVersion = '1.0.0';
let _onUpdateAvailable = null;
let downloadedPath = null;
let checkTimer = null;

// ─── Init ───────────────────────────────────────────────────────────────────

function init(opts) {
  _log = opts.log || console.log;
  _currentVersion = opts.version || '1.0.0';
  _onUpdateAvailable = opts.onUpdateAvailable || (() => {});
  SERVER_URL = opts.serverUrl || null;
}

// ─── Check periódico ────────────────────────────────────────────────────────

function startPeriodicCheck() {
  // Primeiro check 30s após iniciar
  setTimeout(() => checkAndNotify(), 30000);
  // Depois a cada 1 hora
  checkTimer = setInterval(() => checkAndNotify(), CHECK_INTERVAL_MS);
}

function stopPeriodicCheck() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

async function checkAndNotify() {
  try {
    const update = await checkForUpdate();
    if (update.available) {
      _log(`[Update] Nova versão disponível: v${update.version} (atual: v${_currentVersion})`);
      _onUpdateAvailable(update);
    }
  } catch (e) {
    _log(`[Update] Erro ao verificar: ${e.message}`);
  }
}

// ─── Check for update ───────────────────────────────────────────────────────

function checkForUpdate() {
  return new Promise((resolve, reject) => {
    if (!SERVER_URL) return reject(new Error('auto-updater: SERVER_URL não configurado'));
    const url = `${SERVER_URL}/api/electron/check-version`;
    const client = url.startsWith('https') ? https : http;

    const req = client.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          const available = compareSemver(info.version, _currentVersion) > 0;
          resolve({
            available,
            version: info.version,
            downloadUrl: info.downloadUrl,
            checksum: info.checksum,
            releaseNotes: info.releaseNotes || '',
          });
        } catch {
          resolve({ available: false, error: 'Parse error' });
        }
      });
    });

    req.on('error', (e) => resolve({ available: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ available: false, error: 'timeout' }); });
  });
}

// ─── Download update ────────────────────────────────────────────────────────

function downloadUpdate(downloadUrl, onProgress) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(
      path.dirname(process.execPath),
      `update-${Date.now()}.tmp`
    );
    const file = fs.createWriteStream(tmpPath);
    const client = downloadUrl.startsWith('https') ? https : http;

    _log(`[Update] Baixando de ${downloadUrl}...`);

    const req = client.get(downloadUrl, { timeout: 300000 }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // Follow redirect
        file.close();
        fs.unlinkSync(tmpPath);
        return downloadUpdate(res.headers.location, onProgress).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(tmpPath); } catch {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const totalBytes = parseInt(res.headers['content-length']) || 0;
      let receivedBytes = 0;

      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (totalBytes && onProgress) {
          onProgress(Math.round((receivedBytes / totalBytes) * 100));
        }
      });

      res.pipe(file);

      file.on('finish', () => {
        file.close();
        _log(`[Update] Download completo: ${(receivedBytes / 1048576).toFixed(1)}MB`);
        downloadedPath = tmpPath;
        resolve({ ok: true, path: tmpPath, size: receivedBytes });
      });
    });

    req.on('error', (e) => {
      file.close();
      try { fs.unlinkSync(tmpPath); } catch {}
      reject(e);
    });

    req.on('timeout', () => {
      req.destroy();
      file.close();
      try { fs.unlinkSync(tmpPath); } catch {}
      reject(new Error('Download timeout'));
    });
  });
}

// ─── Verify checksum ────────────────────────────────────────────────────────

function verifyChecksum(filePath, expectedHash) {
  return new Promise((resolve, reject) => {
    if (!expectedHash) return resolve(true); // sem checksum = skip

    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => {
      const actual = hash.digest('hex');
      const expected = expectedHash.replace('sha256:', '');
      if (actual === expected) {
        resolve(true);
      } else {
        reject(new Error(`Checksum mismatch: ${actual} != ${expected}`));
      }
    });
    stream.on('error', reject);
  });
}

// ─── Apply update ───────────────────────────────────────────────────────────

function applyUpdate(newExeTmpPath, checksum) {
  return new Promise(async (resolve, reject) => {
    try {
      // Verificar checksum
      await verifyChecksum(newExeTmpPath, checksum);

      // Renomear .tmp para .exe
      const newExePath = newExeTmpPath.replace('.tmp', '.exe');
      fs.renameSync(newExeTmpPath, newExePath);

      _log(`[Update] Lançando nova versão: ${newExePath}`);
      _log(`[Update] Argumento: --replace-old "${process.execPath}"`);

      // Lançar novo exe com flag para limpar o antigo
      const child = spawn(newExePath, ['--replace-old', process.execPath], {
        detached: true,
        stdio: 'ignore',
      });

      child.unref();

      resolve({ ok: true, newExePath });

      // Dar tempo do spawn e sair
      setTimeout(() => {
        const { app } = require('electron');
        app.quit();
      }, 1000);
    } catch (e) {
      reject(e);
    }
  });
}

// ─── Handle --replace-old (cleanup na inicialização) ────────────────────────

function handleReplaceOld(oldExePath) {
  if (!oldExePath || !fs.existsSync(oldExePath)) return false;

  _log(`[Update] Limpando versão anterior: ${oldExePath}`);

  // Aguardar o processo antigo morrer (tentar até 10x, 1s cada)
  let attempts = 0;
  const tryDelete = () => {
    try {
      fs.unlinkSync(oldExePath);
      _log('[Update] Versão anterior removida com sucesso');

      // Limpar .electron-profile (obrigatório ao mudar versão)
      const profileDir = path.join(path.dirname(process.execPath), '.electron-profile');
      if (fs.existsSync(profileDir)) {
        fs.rmSync(profileDir, { recursive: true, force: true });
        _log('[Update] .electron-profile limpo (mudança de versão)');
      }

      return true;
    } catch (e) {
      attempts++;
      if (attempts < 10) {
        _log(`[Update] Aguardando processo antigo morrer... (tentativa ${attempts})`);
        // Usar sync sleep (startup, antes de qualquer UI)
        const start = Date.now();
        while (Date.now() - start < 1000) {} // busy-wait 1s
        return tryDelete();
      }
      _log(`[Update] Não conseguiu remover versão anterior: ${e.message}`);
      return false;
    }
  };

  return tryDelete();
}

// ─── Semver compare ─────────────────────────────────────────────────────────

function compareSemver(a, b) {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  init,
  startPeriodicCheck,
  stopPeriodicCheck,
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  handleReplaceOld,
  get downloadedPath() { return downloadedPath; },
};
