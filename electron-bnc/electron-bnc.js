// electron-bnc.js — Main process do app "LiciteAgora BNC".
//
// App SEPARADO e PARALELO ao electron-standalone/ (Comprasnet). Não compartilha
// código nem userData. Roda em janela própria, com webview em partition isolada
// `persist:bnc` (cookies não vazam entre app Comprasnet e app BNC).
//
// Responsabilidades:
//   1) Carregar https://bnccompras.com/Home/Login na webview
//   2) Ler credenciais (email + senha 6 dígitos) do servidor liciteagora
//   3) Auto-login via injeção de snippet (bnc-login.js) que opera o teclado
//      virtual sorteado por sessão + dispara reCAPTCHA invisible
//   4) Capturar cookies de bnccompras.com via session.cookies e enviar pro
//      servidor (bnc-cookie-sync.js)
//   5) Botão manual "Login" pra disparar autologin sob demanda
//
// CLI args:
//   --server-url URL    base do servidor liciteagora (default: lê do store ou env)
//   --api-key KEY       X-Api-Key pro tenant (default: store/env)
//   --minimized         inicia minimizado na tray
//   --headless          sem janela visível (modo daemon)
//
// PRODUÇÃO: empacotado via electron-builder NSIS → LiciteAgora-BNC-Setup.exe.
// Instala em "C:\Program Files\LiciteAgora BNC". userData fica em
// %APPDATA%\LiciteAgora BNC.

'use strict';

const { app, BrowserWindow, session, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./store');
const serverBridge = require('./server-bridge');
const { buildAutoLoginSnippet } = require('./bnc-login');
const cookieSync = require('./bnc-cookie-sync');

const BNC_LOGIN_URL = 'https://bnccompras.com/Home/Login';
const APP_VERSION = '1.0.0';

// ─── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1 || !args[i + 1]) return fallback;
  return args[i + 1];
}
const headless = args.includes('--headless');
const startMinimized = args.includes('--minimized');

let serverUrlArg = argVal('--server-url') || process.env.LICITEAGORA_SERVER_URL;
let apiKeyArg = argVal('--api-key') || process.env.LICITEAGORA_API_KEY;

// ─── Estado runtime ────────────────────────────────────────────────────────
let mainWindow = null;
let webviewContents = null;
let trayIcon = null;
let isQuitting = false;
let currentUserEmail = null; // setado quando autologin lê credenciais
const recentLogs = []; // últimos N logs pra push pro servidor

// ─── Logger ────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(...parts) {
  const line = `[${ts()}] ${parts.join(' ')}`;
  console.log(line);
  recentLogs.push({ time: new Date().toISOString(), text: parts.join(' ') });
  if (recentLogs.length > 500) recentLogs.shift();
  if (mainWindow && !mainWindow.isDestroyed()) {
    // não envia log no IPC pra não inundar — usa status-update pra estado-chave
  }
}

function setStatus(text, kind = '') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', { text, kind });
  }
}

// ─── userData portátil ─────────────────────────────────────────────────────
function resolveUserDataDir() {
  // No build instalado, fica em %APPDATA%\LiciteAgora BNC (default do Electron).
  // No portable/dev, fica ao lado do exe.
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, '.liciteagora-bnc-profile');
  }
  return app.getPath('userData');
}
const USER_DATA_DIR = resolveUserDataDir();
try { fs.mkdirSync(USER_DATA_DIR, { recursive: true }); } catch {}
app.setPath('userData', USER_DATA_DIR);
log(`userData: ${USER_DATA_DIR}`);

// ─── Inicializa store + serverBridge ───────────────────────────────────────
store.init(USER_DATA_DIR);
// Resolução de config: CLI > env > store
if (!serverUrlArg) serverUrlArg = store.get('serverUrl');
if (!apiKeyArg) apiKeyArg = store.get('apiKey');
// Persiste o que veio via CLI/env pra próxima execução
if (serverUrlArg) store.set('serverUrl', serverUrlArg);
if (apiKeyArg) store.set('apiKey', apiKeyArg);

serverBridge.init({ serverUrl: serverUrlArg, apiKey: apiKeyArg, log });
log(`server-url: ${serverUrlArg || '(não configurado)'}  api-key: ${apiKeyArg ? apiKeyArg.slice(0, 8) + '…' : '(não configurada)'}`);

// ─── Single instance lock ──────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log('Outra instância de LiciteAgora BNC já está rodando. Saindo.');
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ─── Certificados: aceitar autoassinados do BNC se aparecerem ──────────────
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (url.includes('bnccompras.com')) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// ─── Autologin: dispara snippet + polling de resultado ─────────────────────
let autoLoginInProgress = false;

async function triggerAutoLogin({ manual = false } = {}) {
  if (autoLoginInProgress) {
    log('Autologin já em andamento — ignorando');
    return;
  }
  if (!webviewContents || webviewContents.isDestroyed()) {
    log('Autologin: webview não pronto');
    return;
  }

  let creds;
  try {
    setStatus('Buscando credenciais...', 'warn');
    creds = await serverBridge.fetchCredentials();
  } catch (e) {
    log(`Autologin: falha credenciais — ${e.message}`);
    setStatus(`Sem credenciais: ${e.message}`, 'err');
    return;
  }

  currentUserEmail = creds.usuario;
  autoLoginInProgress = true;
  setStatus(`Logando como ${creds.usuario}...`, 'warn');

  // Garante que estamos na página de login
  const url = webviewContents.getURL();
  if (!/\/Home\/Login/i.test(url)) {
    log(`Navegando para ${BNC_LOGIN_URL} (estava em ${url})`);
    await webviewContents.loadURL(BNC_LOGIN_URL);
    // espera DOM
    await new Promise(r => setTimeout(r, 1500));
  }

  // Injeta snippet
  const snippet = buildAutoLoginSnippet({ email: creds.usuario, senha: creds.senha });
  try {
    await webviewContents.executeJavaScript(snippet, true);
  } catch (e) {
    log(`Autologin: erro ao injetar snippet — ${e.message}`);
    setStatus(`Erro snippet: ${e.message}`, 'err');
    autoLoginInProgress = false;
    return;
  }

  // Polling do resultado
  const inicio = Date.now();
  const POLL_MAX_MS = 45000;
  while (Date.now() - inicio < POLL_MAX_MS) {
    await new Promise(r => setTimeout(r, 1000));
    let res;
    try {
      res = await webviewContents.executeJavaScript('window.__bncLoginResult', true);
    } catch (e) {
      log(`Polling: ${e.message}`);
      continue;
    }
    if (res === null || res === undefined) {
      // tenta ver o status intermediário
      try {
        const s = await webviewContents.executeJavaScript('window.__bncLoginStatus', true);
        if (s) setStatus(`autologin: ${s}`, 'warn');
      } catch {}
      continue;
    }
    autoLoginInProgress = false;
    if (res.ok) {
      log(`Autologin OK: ${res.etapa} ${res.url || ''}`);
      if (res.etapa === 'escolha-perfil') {
        setStatus('Login OK — escolha de perfil exige clique manual', 'warn');
      } else {
        setStatus(`Logado: ${creds.usuario}`, 'ok');
      }
      // Força sync de cookies após login bem-sucedido
      if (cookieSyncHandle) {
        setTimeout(() => cookieSyncHandle.forceSync(), 2000);
      }
    } else {
      log(`Autologin FALHA (${res.etapa}): ${res.error}`);
      setStatus(`Falha (${res.etapa}): ${res.error}`, 'err');
      try { await serverBridge.reportError('bnc-autologin', new Error(`${res.etapa}: ${res.error}`)); } catch {}
    }
    return;
  }

  autoLoginInProgress = false;
  log('Autologin: polling timeout');
  setStatus('Login timeout (45s)', 'err');
}

// ─── Bootstrap UI ──────────────────────────────────────────────────────────
let cookieSyncHandle = null;

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:bnc');

  // User-Agent limpo (sem "Electron/<ver>")
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.requestHeaders['User-Agent']) {
      details.requestHeaders['User-Agent'] = details.requestHeaders['User-Agent']
        .replace(/Electron\/[\d.]+\s?/g, '')
        .replace(/\s{2,}/g, ' ');
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const hasIcon = fs.existsSync(iconPath);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !headless && !startMinimized,
    icon: hasIcon ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });

  // Tray (mesma UX do app Comprasnet)
  try {
    const trayImg = hasIcon ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    trayIcon = new Tray(trayImg);
    trayIcon.setToolTip('LiciteAgora BNC');
    const trayMenu = Menu.buildFromTemplate([
      { label: 'Mostrar janela', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { label: 'Esconder janela', click: () => { if (mainWindow) mainWindow.hide(); } },
      { type: 'separator' },
      { label: 'Forçar login', click: () => triggerAutoLogin({ manual: true }) },
      { type: 'separator' },
      { label: 'Sair', click: () => { isQuitting = true; app.quit(); } },
    ]);
    trayIcon.setContextMenu(trayMenu);
    trayIcon.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    });
  } catch (e) {
    log(`Tray falhou: ${e.message}`);
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting && trayIcon) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  await mainWindow.loadFile(path.join(__dirname, 'nav.html'));
  mainWindow.webContents.send('set-url', BNC_LOGIN_URL);

  // Quando o webview anexar, pega webContents e amarra cookie-sync + autologin
  mainWindow.webContents.on('did-attach-webview', (event, wvContents) => {
    webviewContents = wvContents;
    log(`Webview anexado (id=${wvContents.id})`);

    // Cookie sync na MESMA session do webview (persist:bnc)
    cookieSyncHandle = cookieSync.start({
      session: ses,
      serverBridge,
      log,
      getCurrentUserEmail: () => currentUserEmail,
    });

    // Quando a página de login terminar de carregar, dispara autologin se temos creds
    wvContents.on('did-finish-load', async () => {
      const url = wvContents.getURL();
      log(`did-finish-load: ${url}`);
      if (/\/Home\/Login/i.test(url) && serverBridge.getApiKey()) {
        // Aguarda ProcessUserSession completar (~2s suficiente em conexão normal)
        setTimeout(() => triggerAutoLogin({ manual: false }), 2500);
      }
    });
  });

  ipcMain.on('webview-navigated', (event, url) => {
    log(`navigated → ${url}`);
  });

  ipcMain.on('webview-ready', (event, wcId) => {
    log(`webview-ready id=${wcId}`);
  });

  ipcMain.on('trigger-login', () => {
    triggerAutoLogin({ manual: true });
  });

  // Heartbeat de logs pro servidor (a cada 60s)
  setInterval(async () => {
    if (recentLogs.length === 0) return;
    const batch = recentLogs.splice(0, recentLogs.length);
    try {
      await serverBridge.sendLogs(batch, autoLoginInProgress ? 'logging-in' : 'idle');
    } catch {}
  }, 60000);

  setStatus(`v${APP_VERSION} pronto`, '');
  log(`LiciteAgora BNC v${APP_VERSION} pronto`);
});

app.on('window-all-closed', () => {
  // No Windows/Linux: tray mantém vivo. macOS: dock standard.
  if (process.platform === 'darwin' && !trayIcon) app.quit();
});

app.on('before-quit', () => { isQuitting = true; });

process.on('uncaughtException', async (err) => {
  log(`UNCAUGHT: ${err.message}\n${err.stack}`);
  try { await serverBridge.reportError('uncaughtException', err); } catch {}
});
process.on('unhandledRejection', async (reason) => {
  log(`UNHANDLED REJECTION: ${reason && reason.message ? reason.message : reason}`);
  try { await serverBridge.reportError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))); } catch {}
});
