'use strict';

/**
 * updater-electron.js — Auto-update via electron-updater (NSIS per-user).
 *
 * Substitui o modelo "portable" do auto-updater.js para installs NSIS em
 * %LOCALAPPDATA% (diretório gravável pelo usuário → update silencioso, sem
 * UAC). Lê o feed `latest.yml` (generic provider) servido pelo servidor.
 *
 * Política:
 *   - DOWNLOAD é sempre permitido (não reinicia o app).
 *   - INSTALAÇÃO (quitAndInstall reinicia) é gated por isSafeToUpdate():
 *     nunca reinstala no meio de disputa/lance. Se baixou e não pôde
 *     instalar, reavalia no próximo check periódico e, como rede de
 *     segurança, instala no quit do app (autoInstallOnAppQuit).
 *   - Clique manual / API /apply-update força (ignora a salvaguarda).
 */

const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL_MS = 3600000; // 1h

let _log = console.log;
let _isSafe = () => true;
let _onProgress = () => {};
let _onApplying = () => {};
let _onAvailable = () => {};
let _onDownloaded = () => {};
let _onNotAvailable = () => {};
let checkTimer = null;
let downloaded = false;
let forceInstall = false; // clique manual ignora a salvaguarda
let latestVersion = null;

function init(opts) {
  _log = opts.log || console.log;
  _isSafe = opts.isSafeToUpdate || (() => true);
  _onProgress = opts.onProgress || (() => {});
  _onApplying = opts.onApplying || (() => {});
  _onAvailable = opts.onAvailable || (() => {});
  _onDownloaded = opts.onDownloaded || (() => {});
  _onNotAvailable = opts.onNotAvailable || (() => {});

  autoUpdater.logger = { info: _log, warn: _log, error: _log, debug: () => {} };
  autoUpdater.autoDownload = true; // baixar é inofensivo (não reinicia)
  autoUpdater.autoInstallOnAppQuit = true; // rede de segurança

  if (opts.feedUrl) {
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: opts.feedUrl });
      _log(`[Update] feed: ${opts.feedUrl}`);
    } catch (e) {
      _log(`[Update] setFeedURL falhou: ${e.message}`);
    }
  }

  autoUpdater.on('update-available', (info) => {
    latestVersion = info.version;
    _log(`[Update] v${info.version} disponível (atual v${autoUpdater.currentVersion}) — baixando...`);
    try { _onAvailable({ version: info.version }); } catch (_) {}
  });
  autoUpdater.on('update-not-available', () => {
    downloaded = false;
    try { _onNotAvailable({ version: String(autoUpdater.currentVersion) }); } catch (_) {}
  });
  autoUpdater.on('download-progress', (p) => { try { _onProgress(Math.round(p.percent)); } catch (_) {} });
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true;
    latestVersion = info.version;
    _log(`[Update] v${info.version} baixado.`);
    try { _onDownloaded({ version: info.version }); } catch (_) {}
    maybeInstall('download concluído');
  });
  autoUpdater.on('error', (e) => _log(`[Update] erro: ${(e && e.message) || e}`));
}

function maybeInstall(motivo) {
  if (!downloaded) return false;
  if (!forceInstall && !_isSafe()) {
    _log(`[Update] instalação adiada (disputa/lance ativo) — ${motivo}. Instala quando ocioso ou no quit.`);
    return false;
  }
  _log(`[Update] aplicando v${latestVersion} (reinício silencioso) — ${motivo}`);
  try { _onApplying(); } catch (_) {}
  // 1 tick pra resposta HTTP/IPC sair antes do quit
  setTimeout(() => {
    try { autoUpdater.quitAndInstall(true, true); } // isSilent, isForceRunAfter
    catch (e) { _log(`[Update] quitAndInstall falhou: ${e.message}`); }
  }, 300);
  return true;
}

async function check() {
  // Já baixou e ficou seguro → instala em vez de re-checar.
  if (downloaded) {
    maybeInstall('check periódico');
    return { available: true, version: latestVersion, downloaded: true };
  }
  try {
    const r = await autoUpdater.checkForUpdates(); // autoDownload=true já dispara o download
    const v = r && r.updateInfo && r.updateInfo.version;
    const available = !!v && v !== autoUpdater.currentVersion;
    return { available, version: v || autoUpdater.currentVersion };
  } catch (e) {
    _log(`[Update] check falhou: ${e.message}`);
    return { available: false, error: e.message };
  }
}

function startPeriodicCheck() {
  setTimeout(() => check(), 30000);
  checkTimer = setInterval(() => check(), CHECK_INTERVAL_MS);
}

function stopPeriodicCheck() {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
}

// Clique manual / API /apply-update: força a instalação (ignora salvaguarda).
async function applyNow() {
  forceInstall = true;
  if (downloaded) return maybeInstall('manual');
  await check(); // dispara download; update-downloaded chama maybeInstall (forceInstall=true)
  return false;
}

module.exports = {
  init,
  startPeriodicCheck,
  stopPeriodicCheck,
  check,
  applyNow,
  isDownloaded: () => downloaded,
  get latestVersion() { return latestVersion; },
};
