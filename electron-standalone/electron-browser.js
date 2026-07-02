'use strict';

/**
 * electron-browser.js — Browser CEF-like para Comprasnet (Windows standalone)
 *
 * Funciona como o Lancer do concorrente:
 *   - Electron = CEF (Chromium Embedded Framework) para Node.js
 *   - Sem navigator.webdriver, sem CDP markers, sem flags de automação
 *   - hCaptcha invisible auto-resolve (fingerprint limpo)
 *   - Captura Bearer tokens via interceptação de requests
 *   - Keepalive automático
 *   - Controle total via IPC do Node.js
 *   - Integração com servidor LiciteAgora (sync + lances)
 *
 * Flags:
 *   --headless        Rodar sem janela
 *   --url URL         URL inicial (default: Comprasnet)
 *   --name NOME       Nome da sessão para logs
 *   --api-key KEY     API key para servidor LiciteAgora
 *   --db PATH         Caminho para pncp.db
 */

const { app, BrowserWindow, session, ipcMain, Tray, Menu, nativeImage, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs');
const { saveBearer, isTokenValid, tokenTTL, loadToken, clearToken, parseJWT } = require('./token-manager');
const { saveToken } = require('./store');
const cnet = require('./comprasnet-api');
const serverSync = require('./server-sync');
const lanceProcessor = require('./lance-processor');
const sessionTimers = require('./session-timers');
const autoUpdater = require('./auto-updater');   // legado portable: só handleReplaceOld (--replace-old)
const appUpdater = require('./updater-electron'); // NSIS per-user: auto-update real (electron-updater)
const logger = require('./core/logger');

// Refactor multi-portal Fase 2A: módulos extraídos do fluxo Comprasnet.
// Instâncias são construídas dentro de app.whenReady, depois que o state
// mutável está disponível (vide ctx mais abaixo).
const cnetUtils = require('./portals/comprasnet/utils');
const cnetBearer = require('./portals/comprasnet/bearer-interceptor');
const cnetPopupMgr = require('./portals/comprasnet/popup-mgr');
const cnetAutoLogin = require('./portals/comprasnet/auto-login');
const cnetIntegration = require('./portals/comprasnet/integration');
const cnetFetch = require('./portals/comprasnet/fetch');
const cnetApiHandlersFactory = require('./portals/comprasnet/api-handlers');
const bncPortal = require('./portals/bnc');
const bllPortal = require('./portals/bll');
const tokenManager = require('./token-manager');

// ─── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const headless = args.includes('--headless');
// --minimized: inicia sem janela visível, fica apenas no system tray.
// Usado pelo Task Scheduler /sc onlogon (build NSIS) e por usuários que
// querem o app rodando em segundo plano após reboot.
const startMinimized = args.includes('--minimized');
// --portal: agora é apenas HINT do portal inicial visível na boot (v5.1.0+,
// 2026-05-20: janela única com Comprasnet+BNC carregados em paralelo).
// Os 2 portais sempre rodam — flag só decide qual webview começa na frente.
const portalArg = (args.find((_, i, a) => a[i - 1] === '--portal') || 'comprasnet').toLowerCase();
const initialPortal = ['bnc', 'bll'].includes(portalArg) ? portalArg : 'comprasnet';
const _urlArgRaw = args.find((_, i, a) => a[i - 1] === '--url') || null;
// URL inicial por portal. --url custom só sobrescreve o portal hint
// (preserva retrocompat com atalhos --portal=bnc --url=...).
const COMPRASNET_DEFAULT_URL = initialPortal === 'comprasnet' && _urlArgRaw
  ? _urlArgRaw : 'https://comprasnet.gov.br/seguro/loginPortal.asp';
const BNC_DEFAULT_URL = initialPortal === 'bnc' && _urlArgRaw
  ? _urlArgRaw : 'https://bnccompras.com/Home/Login';
const BLL_DEFAULT_URL = initialPortal === 'bll' && _urlArgRaw
  ? _urlArgRaw : 'https://bllcompras.com/Home/Login';
const nameArg = args.find((_, i, a) => a[i - 1] === '--name') || 'liciteagora';
let apiKeyArg = args.find((_, i, a) => a[i - 1] === '--api-key') || process.env.LICITEAGORA_API_KEY || null;

// Multi-tenant config (Fase 6, 2026-04-22): lido do store (dialog de
// setup na 1ª execução) OU de --server-url / LICITEAGORA_SERVER_URL.
// Default null — exige setup explícito.
const store = require('./store');
let serverUrlArg = args.find((_, i, a) => a[i - 1] === '--server-url')
  || process.env.LICITEAGORA_SERVER_URL
  || null;
if (serverUrlArg) {
  try { serverUrlArg = store.normalizeServerUrl(serverUrlArg); } catch (_) { serverUrlArg = null; }
}

// Carrega config salva do disco (se existir) e usa como fallback.
const _persistedCfg = store.loadConfig();
if (_persistedCfg) {
  if (!serverUrlArg) serverUrlArg = _persistedCfg.serverUrl;
  if (!apiKeyArg) apiKeyArg = _persistedCfg.apiKey;
}

// userData ao lado do exe (portátil, fora do asar). Para builds NSIS
// instaladas em Program Files o diretório do exe é read-only — nesse
// caso, usa app.getPath('userData') (= %APPDATA%\LiciteAgora Browser),
// que persiste entre reboots e o Chromium aceita escrever.
const IS_PACKAGED = app.isPackaged;
function isExeDirWritable() {
  if (!IS_PACKAGED) return true;
  // fs.accessSync(W_OK) é NÃO-confiável no Windows: não enxerga as ACLs do
  // Program Files (retorna "gravável" e só dá EPERM na hora de escrever).
  // Faz um teste de escrita real: cria e apaga um arquivo-sonda.
  const probe = path.join(path.dirname(process.execPath), `.write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch (_) { return false; }
}
const USE_NEXT_TO_EXE = isExeDirWritable();
// Profile path único (v5.1.0+, 2026-05-20): janela única hospeda Comprasnet
// e BNC em paralelo, isolados pelo `partition` do webview tag
// (persist:comprasnet / persist:bnc). Profile path agora é só `.electron-profile`.
const PROFILE_DIR_NAME = '.electron-profile';
const USER_DATA_DIR = !IS_PACKAGED
  ? path.join(__dirname, PROFILE_DIR_NAME)
  : USE_NEXT_TO_EXE
    ? path.join(path.dirname(process.execPath), PROFILE_DIR_NAME)
    : app.getPath('userData');
const RECORDINGS_DIR = path.join(USER_DATA_DIR, 'recordings');
const LOG_DIR = path.join(USER_DATA_DIR, 'logs');
const TOKEN_MAX_AGE_MS = 540000; // 9 min

// Log persistente em arquivo: userData/logs/main.log. Inicializado já no
// load do módulo (antes de qualquer log()) pra capturar crashes de boot.
// Veja onde fica o userData no comentário de USER_DATA_DIR acima.
try { logger.initFileLog(LOG_DIR); } catch (_) { /* I/O nunca derruba o boot */ }

// ─── State ───────────────────────────────────────────────────────────────────

let mainWindow = null;
let trayIcon = null;
// Quando true, fechar a janela apenas a esconde (mantém app + sync rodando).
// Setado após o tray ser criado com sucesso.
let isQuitting = false;
let webviewContents = null;
let bearerToken = null;
let bearerTimestamp = null;
let state = 'idle'; // idle | connected | logged_in | error
let loginAt = null;
const apiLog = [];
const startTime = Date.now();

function ts() { return Date.now() - startTime; }

// Logger compartilhado vive em ./core/logger.js. logBuffer + log + startLogSync
// são reexpostos como aliases pra preservar todas as referências internas
// (incluindo `logBuffer.slice(-100)` em /logs do API server).
const log = logger.log;
const logBuffer = logger.getBuffer();

function startLogSync() {
  logger.startLogSync({
    getApiKey: () => apiKeyArg,
    getServerUrl: () => serverUrlArg,
    getState: () => state,
    getBearerTimestamp: () => bearerTimestamp,
  });
}

// ─── Diagnóstico de crashes ──────────────────────────────────────────────────
// Sem estes handlers o processo principal morre calado em qualquer exceção
// não tratada (sintoma relatado: "o app encerra sozinho e sem aviso nenhum").
// Aqui registramos a causa em userData/logs/main.log (via logger) ANTES de
// qualquer saída, e mantemos o app vivo quando o crash é só de um renderer.
let crashHandlersInstalled = false;
function installCrashHandlers() {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;

  // Minidumps nativos do Chromium (GPU/renderer) em userData/Crashpad/.
  // uploadToServer:false → ficam locais, sem mandar nada pra fora.
  try { crashReporter.start({ uploadToServer: false }); } catch (_) {}

  // Exceção/promise não tratada no MAIN: a causa nº1 de "fechou sozinho".
  // Logamos a stack e NÃO chamamos process.exit — sumir calado é pior que
  // seguir num estado possivelmente degradado (o usuário fecha se precisar).
  process.on('uncaughtException', (err) => {
    try { log(`[FATAL] uncaughtException: ${err && err.stack ? err.stack : err}`); } catch (_) {}
  });
  process.on('unhandledRejection', (reason) => {
    try { log(`[FATAL] unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`); } catch (_) {}
  });

  // Crash/kill do processo de renderização (navbar ou webview de um portal).
  app.on('render-process-gone', (event, webContents, details) => {
    log(`[CRASH] render-process-gone reason=${details && details.reason} exitCode=${details && details.exitCode}`);
    // Se foi a janela principal (navbar) que caiu, recarrega em vez de deixar
    // a UI morta. Webviews de portal se recuperam no reload da própria página.
    try {
      if (mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents) {
        log('[CRASH] Recarregando janela principal após render-process-gone');
        mainWindow.reload();
      }
    } catch (_) {}
  });

  // Crash de processo filho (GPU, utility, network service).
  app.on('child-process-gone', (event, details) => {
    log(`[CRASH] child-process-gone type=${details && details.type} reason=${details && details.reason} exitCode=${details && details.exitCode}`);
  });

  // Registra TODA saída do app com o código — diferencia quit normal de morte.
  app.on('quit', (event, exitCode) => {
    log(`[App] quit (exitCode=${exitCode})`);
  });
}
installCrashHandlers();

function tokenFresco() {
  return bearerToken && bearerTimestamp && (Date.now() - bearerTimestamp) < TOKEN_MAX_AGE_MS;
}

// ─── Holders pra módulos do portal Comprasnet (init em app.whenReady) ──
let registerBearerInterceptor = null;  // criado por cnetBearer.createRegister(ctx)
let autoLoginModule = null;            // criado por cnetAutoLogin.create({ ctx, utils })
let portalCtxSingleton = null;         // ctx único reusado por integration.start, etc.
let comprasnetFetch = null;            // helper criado por cnetFetch.create({ ctx })
let cnetApiHandlers = null;            // dispatcher dos endpoints HTTP do portal

// ctx exposto aos módulos do portal — getters/setters pro state mutável
// que continua vivendo neste arquivo. Construído depois que mainWindow +
// webview estão disponíveis (idealmente no início de whenReady).
function buildPortalCtx() {
  return {
    log,
    serverSync,
    tokenManager,
    userDataDir: USER_DATA_DIR,
    dbPath: DB_PATH,
    getWebview: () => webviewContents,
    getMainWindow: () => mainWindow,
    getBearer: () => bearerToken,
    getBearerTimestamp: () => bearerTimestamp,
    setBearer: (auth, ts) => { bearerToken = auth; bearerTimestamp = ts; },
    getState: () => state,
    setState: (s) => { state = s; },
    setLoggedIn: () => { state = 'logged_in'; loginAt = new Date().toISOString(); },
    tokenFresco,
    saveBearer: (token) => tokenManager.saveBearer(token),
    startServerIntegration: () => startServerIntegration(),
    startLogSync,
    getApiKey: () => apiKeyArg,
    setApiKey: (k) => { apiKeyArg = k; },
    getServerUrl: () => serverUrlArg,
    onLoggedInTransition: () => startServerIntegration(),
  };
}

// ─── Electron App ────────────────────────────────────────────────────────────

// v5.1.0+ (2026-05-20): app único hospeda Comprasnet + BNC na mesma janela.
// Single-instance global pra evitar 2 cópias do binário rodando.
app.setName('LiciteAgora Browser');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[Electron] Outra instância já está rodando — saindo.');
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// User data dir persistente (cookies, sessão)
app.setPath('userData', USER_DATA_DIR);

// Remover flags de automação do Chromium
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('lang', 'pt-BR');
app.commandLine.appendSwitch('disable-infobars');

// GPU — manter ignore-gpu-blocklist para hCaptcha WebGL
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// Ignorar erros de certificado ICP-Brasil (SERPRO) e BNC autoassinados
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (url.includes('comprasnet.gov.br') || url.includes('serpro.gov.br') || url.includes('acesso.gov.br')) {
    event.preventDefault();
    callback(true);
  } else if (url.includes('bnccompras.com') || url.includes('bllcompras.com')) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// Multi-tenant (Fase 6): exibe dialog HTML para o usuário colocar
// subdomain + API key na primeira execução. Persiste via store.
async function showSetupDialog() {
  const { BrowserWindow, ipcMain } = require('electron');
  const win = new BrowserWindow({
    width: 480,
    height: 420,
    title: 'Licite Agora — Configuração inicial',
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Setup</title>
<style>
  body { font-family: -apple-system, "Segoe UI", sans-serif; background: #0b1120; color: #e2e8f0; padding: 28px; }
  h1 { font-size: 18px; margin: 0 0 6px; color: #60a5fa; }
  p.sub { font-size: 12px; color: #94a3b8; margin-bottom: 22px; }
  label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 4px; }
  input { width: 100%; padding: 9px 12px; border: 1px solid #334155; border-radius: 6px;
          background: #0f172a; color: #e2e8f0; font-size: 13px; margin-bottom: 14px; box-sizing: border-box; }
  button { background: #3b82f6; color: white; border: none; padding: 10px; width: 100%;
           border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
  button:hover { background: #2563eb; }
  .err { color: #fca5a5; font-size: 12px; margin-top: 10px; display: none; }
</style></head><body>
  <h1>Configuração inicial</h1>
  <p class="sub">Conecte este Electron a um tenant do Licite Agora.</p>
  <label>Subdomínio ou URL completa</label>
  <input id="url" placeholder="ex: 1bit   ou   https://1bit.liciteagora.app" autofocus>
  <label>API Key do tenant</label>
  <input id="key" placeholder="32-64 caracteres hex">
  <button id="ok">Salvar e continuar</button>
  <div class="err" id="err"></div>
  <script>
    const { ipcRenderer } = require('electron');
    const err = document.getElementById('err');
    document.getElementById('ok').addEventListener('click', () => {
      const url = document.getElementById('url').value.trim();
      const key = document.getElementById('key').value.trim();
      if (!url || !key) { err.textContent = 'Preencha os dois campos'; err.style.display = 'block'; return; }
      ipcRenderer.send('setup:submit', { url, key });
    });
    document.getElementById('url').addEventListener('keydown', e => e.key === 'Enter' && document.getElementById('key').focus());
    document.getElementById('key').addEventListener('keydown', e => e.key === 'Enter' && document.getElementById('ok').click());
  </script>
</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return new Promise((resolve, reject) => {
    ipcMain.once('setup:submit', (_, data) => {
      try {
        const serverUrl = store.normalizeServerUrl(data.url);
        const apiKey = String(data.key || '').trim();
        if (!apiKey) return reject(new Error('apiKey vazio'));
        const tenantSlug = (serverUrl.match(/https?:\/\/([^.]+)\./) || [])[1] || null;
        store.saveConfig({ serverUrl, apiKey, tenantSlug });
        win.close();
        resolve({ serverUrl, apiKey, tenantSlug });
      } catch (err) { reject(err); }
    });
    win.on('closed', () => reject(new Error('janela de setup fechada sem salvar')));
  });
}

app.whenReady().then(async () => {
  // Multi-tenant: se config ainda não foi definida, abre setup dialog.
  if (!serverUrlArg || !apiKeyArg) {
    try {
      const cfg = await showSetupDialog();
      serverUrlArg = cfg.serverUrl;
      apiKeyArg = cfg.apiKey;
      log(`[Setup] Config salva: ${serverUrlArg} (${apiKeyArg.substring(0, 8)}...)`);
    } catch (err) {
      log(`[Setup] Cancelado: ${err.message}`);
      app.quit();
      return;
    }
  } else {
    log(`[Config] Server: ${serverUrlArg}  Key: ${apiKeyArg.substring(0, 8)}...`);
  }

  // Auto-update: handle --replace-old (cleanup da versão anterior)
  const replaceIdx = process.argv.indexOf('--replace-old');
  if (replaceIdx !== -1 && process.argv[replaceIdx + 1]) {
    autoUpdater.handleReplaceOld(process.argv[replaceIdx + 1]);
  }

  const appVersion = require('./package.json').version;
  log(`Electron ${process.versions.electron} / Chrome ${process.versions.chrome} / App v${appVersion}`);
  log(`Modo: ${headless ? 'headless' : 'headed'}  Portal inicial visível: ${initialPortal}`);
  log('[v5.1.0+] Comprasnet + BNC carregados em paralelo (alternar pela barra superior)');

  // Salvaguarda: a INSTALAÇÃO reinicia o app. NÃO reinstalar no meio de
  // disputa ou lance — interromper a sessão perde lances. O download é
  // sempre permitido (não reinicia); só o restart é adiado.
  function isSafeToUpdate() {
    let emDisputa = false, processandoLance = false;
    try { emDisputa = serverSync.getActiveCompraIds().length > 0; } catch (_) {}
    try { processandoLance = !!lanceProcessor.stats().processing; } catch (_) {}
    return !emDisputa && !processandoLance;
  }

  const sendToNav = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  // Estado da atualização espelhado na BANDEJA (visível com a janela minimizada).
  let updateState = { status: 'idle', pct: null, version: null };
  let buildTrayMenu = null;
  function refreshTray() {
    if (!trayIcon || (trayIcon.isDestroyed && trayIcon.isDestroyed())) return;
    let suffix = '';
    if (updateState.status === 'downloading') suffix = ` — Baixando ${updateState.pct != null ? updateState.pct + '%' : '…'}`;
    else if (updateState.status === 'downloaded') suffix = ` — Atualização v${updateState.version || ''} pronta`;
    else if (updateState.status === 'applying') suffix = ' — Instalando…';
    try {
      trayIcon.setToolTip(`LiciteAgora Browser v${app.getVersion()}${suffix} — Comprasnet + BNC + BLL`);
      if (typeof buildTrayMenu === 'function') trayIcon.setContextMenu(buildTrayMenu());
    } catch (_) {}
  }
  function setUpdateState(patch) { updateState = { ...updateState, ...patch }; refreshTray(); }
  function triggerCheckUpdate() {
    setUpdateState({ status: 'checking' });
    sendToNav('update-checking');
    appUpdater.check().then((r) => {
      if (r && !r.available && !r.downloaded) { setUpdateState({ status: 'none' }); sendToNav('update-none', { version: app.getVersion() }); }
    }).catch((e) => sendToNav('update-error', { error: e.message }));
  }
  // Forçar atualização: baixa (se preciso) E instala, ignorando a salvaguarda.
  // applyNow() já dispara o fluxo completo; os callbacks (progress/downloaded/
  // applying) atualizam o estado na nav e na bandeja.
  function triggerForceUpdate() {
    setUpdateState({ status: 'checking' });
    sendToNav('update-checking');
    appUpdater.applyNow().catch((e) => { log(`[Update] Forçar falhou: ${e.message}`); sendToNav('update-error', { error: e.message }); });
  }

  // Auto-update via electron-updater (NSIS per-user). Feed por-tenant:
  // serverUrlArg muda por cliente; setFeedURL em runtime aponta pro feed dele.
  appUpdater.init({
    log,
    feedUrl: `${serverUrlArg}/api/electron/updates`,
    isSafeToUpdate,
    onAvailable: (u) => { setUpdateState({ status: 'downloading', version: u && u.version, pct: 0 }); sendToNav('update-available', u); },
    onProgress: (pct) => { setUpdateState({ status: 'downloading', pct }); sendToNav('update-progress', pct); },
    onApplying: () => { setUpdateState({ status: 'applying' }); sendToNav('update-applying'); },
    onDownloaded: (u) => { setUpdateState({ status: 'downloaded', version: u && u.version }); sendToNav('update-downloaded', u); },
    onNotAvailable: (u) => { setUpdateState({ status: 'none' }); sendToNav('update-none', u); },
  });
  appUpdater.startPeriodicCheck();

  // Verificação manual de update disparada pelo nav (clique no badge) ou pela tray.
  ipcMain.on('check-update-now', () => triggerCheckUpdate());
  // Forçar atualização (botão dedicado na nav e na bandeja).
  ipcMain.on('force-update', () => triggerForceUpdate());

  // Stealth/fingerprint desligados (2026-04-22): injeção pós-load era
  // detectada pelo hCaptcha. Electron puro passa OOTB — o limpeza do
  // User-Agent em registerBearerInterceptor() já basta.

  // ─── Device ID Salt: rotacionar a cada startup ────────────────────────
  try {
    const prefsPath = path.join(USER_DATA_DIR, 'Preferences');
    if (fs.existsSync(prefsPath)) {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      if (!prefs.electron) prefs.electron = {};
      if (!prefs.electron.media) prefs.electron.media = {};
      prefs.electron.media.device_id_salt = sessionFingerprint.deviceIdSalt;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));
      log(`[Fingerprint] Device ID salt rotacionado`);
    }
  } catch (e) {
    // Primeira execução — arquivo não existe ainda, normal
  }

  // Verificar sessão salva em disco
  const savedToken = loadToken();
  if (savedToken && isTokenValid(savedToken)) {
    const ttl = tokenTTL(savedToken);
    log(`Sessão anterior encontrada! TTL: ${ttl}s`);
    bearerToken = savedToken.token;
    bearerTimestamp = savedToken.issuedAt;
    state = 'logged_in';
    loginAt = new Date(savedToken.issuedAt).toISOString();
    // Keepalive será iniciado após webview carregar
  } else if (savedToken) {
    log('Sessão anterior expirada. Login manual necessário.');
    clearToken();
  }

  // Sessions paralelas (v5.1.0+, 2026-05-20):
  // - persist:comprasnet — webview Comprasnet (era default session)
  // - persist:bnc — webview BNC
  // bearer-interceptor é registrado só na session Comprasnet pois o filter
  // por host (cnetmobile.estaleiro.serpro.gov.br) só capta lá. captcha-relay
  // do BNC consome a session BNC pra grecaptcha.execute.
  const sesComprasnet = session.fromPartition('persist:comprasnet');
  const sesBnc = session.fromPartition('persist:bnc');
  const sesBll = session.fromPartition('persist:bll');

  // Gravar chamadas de API (não assets) — ambos portais
  const IGNORE = ['.png', '.jpg', '.css', '.woff', '.svg', '.ico', '.js', '.map',
    'fonts.googleapis.com', 'google-analytics.com', 'googletagmanager.com'];

  function attachApiLogger(ses, urls) {
    ses.webRequest.onCompleted({ urls }, (details) => {
      const url = details.url.toLowerCase();
      if (IGNORE.some(p => url.includes(p))) return;
      apiLog.push({
        url: details.url,
        method: details.method,
        statusCode: details.statusCode,
        timestamp: ts(),
        time: new Date().toISOString(),
      });
      const icon = details.statusCode >= 400 ? 'X' : '>';
      const short = details.url.length > 90 ? details.url.substring(0, 90) + '...' : details.url;
      log(`${icon} ${details.method} ${details.statusCode} ${short}`);
    });
  }
  attachApiLogger(sesComprasnet, ['https://cnetmobile.estaleiro.serpro.gov.br/*', 'https://www.comprasnet.gov.br/*']);
  attachApiLogger(sesBnc, ['https://bnccompras.com/*', 'https://*.bnccompras.com/*']);
  attachApiLogger(sesBll, ['https://bllcompras.com/*', 'https://*.bllcompras.com/*']);

  // ─── Criar janela com barra de navegação (webview architecture) ─────

  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const hasIcon = fs.existsSync(iconPath);

  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    show: !headless && !startMinimized,
    icon: hasIcon ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });

  // Versão visível no título da janela (taskbar) — fica fixa mesmo se a página
  // tentar mudar o título. Fonte: app.getVersion() (package.json empacotado).
  const APP_TITLE = `LiciteAgora Browser v${app.getVersion()}`;
  mainWindow.setTitle(APP_TITLE);
  mainWindow.on('page-title-updated', (e) => { e.preventDefault(); mainWindow.setTitle(APP_TITLE); });

  // Tray icon: permite app continuar rodando em background mesmo com
  // a janela fechada. Necessário pro modo --minimized e pra UX de
  // "app sempre rodando" pedida na build NSIS (instalado como serviço-like
  // via Task Scheduler /sc onlogon).
  try {
    if (hasIcon) {
      const trayImg = nativeImage.createFromPath(iconPath);
      trayIcon = new Tray(trayImg);
    } else {
      trayIcon = new Tray(nativeImage.createEmpty());
    }
    buildTrayMenu = () => {
      // Item dinâmico de atualização — visível mesmo com a janela minimizada.
      const updItems = [];
      const v = updateState.version;
      if (updateState.status === 'downloading') {
        updItems.push({ label: `⬇ Baixando atualização ${updateState.pct != null ? updateState.pct + '%' : '…'}`, enabled: false });
      } else if (updateState.status === 'downloaded') {
        updItems.push({ label: `✅ Instalar atualização${v ? ' v' + v : ''}`, click: () => { appUpdater.applyNow().catch(() => {}); } });
      } else if (updateState.status === 'applying') {
        updItems.push({ label: 'Instalando… reiniciando', enabled: false });
      } else if (updateState.status === 'checking') {
        updItems.push({ label: 'Verificando atualização…', enabled: false });
      } else if (updateState.status === 'none') {
        updItems.push({ label: '✓ App atualizado', enabled: false });
      }
      updItems.push({ label: 'Verificar atualização agora', click: () => triggerCheckUpdate() });
      updItems.push({ label: '🔄 Forçar atualização (baixar + instalar)', click: () => triggerForceUpdate() });

      return Menu.buildFromTemplate([
        { label: `LiciteAgora Browser v${app.getVersion()}`, enabled: false },
        { type: 'separator' },
        ...updItems,
        { type: 'separator' },
        {
          label: 'Mostrar janela',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show();
              mainWindow.focus();
            }
          },
        },
        {
          label: 'Esconder janela',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); },
        },
        { type: 'separator' },
        {
          label: 'Sair (parar sync)',
          click: () => { isQuitting = true; app.quit(); },
        },
      ]);
    };
    refreshTray();
    trayIcon.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    });
    log('[Tray] Ícone criado — fechar janela mantém app rodando');
  } catch (e) {
    log(`[Tray] Falha ao criar tray (${e.message}) — app continua sem tray`);
  }

  // Fechar janela esconde em vez de matar (a menos que isQuitting=true)
  mainWindow.on('close', (event) => {
    if (!isQuitting && trayIcon) {
      event.preventDefault();
      mainWindow.hide();
      log('[Window] Janela fechada → escondida na tray. App continua sync.');
    }
  });

  // ctx compartilhado — webviewContents aponta pro Comprasnet (compat com
  // handlers HTTP /nav, /exec, /reload, etc.). BNC tem seu próprio webview
  // passado explicitamente pra bncPortal.init.
  portalCtxSingleton = buildPortalCtx();

  // ─── Init dos módulos do portal Comprasnet (antes do loadFile pra
  // garantir que listeners did-attach-webview estejam armados) ───
  registerBearerInterceptor = cnetBearer.createRegister(portalCtxSingleton);
  autoLoginModule = cnetAutoLogin.create({ ctx: portalCtxSingleton, utils: cnetUtils });
  comprasnetFetch = cnetFetch.create({ ctx: portalCtxSingleton });
  cnetApiHandlers = cnetApiHandlersFactory.create({
    ctx: portalCtxSingleton,
    autoLoginModule,
    comprasnetFetch,
    readBody,
  });

  // Bearer interceptor registrado na session Comprasnet (filtro por host
  // só captura cnetmobile.estaleiro.serpro.gov.br).
  registerBearerInterceptor(sesComprasnet, 'persist:comprasnet');

  // v5.1.0+: did-attach-webview dispara 2x (1 por webview). Diferenciamos
  // pela session — wvContents.session === sesBnc identifica o webview BNC.
  // CRÍTICO: este listener TEM que ser registrado ANTES do loadFile, senão
  // pode perder os eventos de attach (que disparam durante o parse do HTML).
  let bncBootstrapped = false;
  let bllBootstrapped = false;
  let cnetBootstrapped = false;
  mainWindow.webContents.on('did-attach-webview', async (event, wvContents) => {
    // Limpar UA do webview (vale pra todos — some Electron/<ver>)
    const ua = wvContents.getUserAgent()
      .replace(/Electron\/[\d.]+\s?/g, '')
      .replace(/\s{2,}/g, ' ');
    wvContents.setUserAgent(ua);

    const isBncWv = wvContents.session === sesBnc;
    const isBllWv = wvContents.session === sesBll;
    const portalLabel = isBncWv ? 'bnc' : (isBllWv ? 'bll' : 'comprasnet');
    log(`Webview attached (id: ${wvContents.id}, portal: ${portalLabel})`);

    wvContents.on('did-navigate', (event, url) => {
      log(`[${portalLabel}] navegou: ${url.substring(0, 80)}`);
    });

    if (isBncWv) {
      if (bncBootstrapped) return;
      bncBootstrapped = true;
      const bncCtx = {
        ...portalCtxSingleton,
        getWebview: () => wvContents,
      };
      bncPortal.init({ ses: wvContents.session, ctx: bncCtx, ipcMain });
      log('[BNC] Portal BNC inicializado');
      return;
    }

    if (isBllWv) {
      if (bllBootstrapped) return;
      bllBootstrapped = true;
      const bllCtx = {
        ...portalCtxSingleton,
        getWebview: () => wvContents,
      };
      bllPortal.init({ ses: wvContents.session, ctx: bllCtx, ipcMain });
      log('[BLL] Portal BLL inicializado');
      return;
    }

    if (cnetBootstrapped) return;
    cnetBootstrapped = true;
    webviewContents = wvContents;
    registerBearerInterceptor(wvContents.session, 'webview-guest-comprasnet');
    cnetPopupMgr.install({ wvContents, ctx: portalCtxSingleton, registerBearerInterceptor });

    if (!apiKeyArg) {
      autoLoginModule.readCredentialsFromServer().then(() => {
        if (apiKeyArg) {
          startLogSync();
          log('[Logs] Envio de logs ao servidor ativo');
        }
      }).catch(() => {});
    } else {
      startLogSync();
    }

    if (state === 'logged_in') {
      log('Sessão anterior válida — iniciando server integration...');
      startServerIntegration();
      wvContents.loadURL('https://comprasnet.gov.br/seguro/loginPortal.asp');
    } else {
      autoLoginModule.autoLoginFromDB();
    }
  });

  // Carregar a página com navbar + 2 webviews (Comprasnet + BNC em
  // partitions isoladas). HTML único electron-nav.html (v5.1.0+).
  await mainWindow.loadFile(path.join(__dirname, 'electron-nav.html'));

  // Enviar URL inicial pros 2 webviews (depois de loadFile pra garantir
  // que o renderer JS está rodando e tem listener do IPC 'set-url')
  mainWindow.webContents.send('set-url', { portal: 'comprasnet', url: COMPRASNET_DEFAULT_URL });
  mainWindow.webContents.send('set-url', { portal: 'bnc', url: BNC_DEFAULT_URL });
  mainWindow.webContents.send('set-url', { portal: 'bll', url: BLL_DEFAULT_URL });
  if (initialPortal !== 'comprasnet') {
    mainWindow.webContents.send('switch-portal', initialPortal);
  }
  state = 'connected';
  log(`Carregados Comprasnet (${COMPRASNET_DEFAULT_URL}) + BNC (${BNC_DEFAULT_URL}) + BLL (${BLL_DEFAULT_URL})`);

  // Receber notificações de navegação do webview
  // IPC: aplicar update do navbar
  ipcMain.on('apply-update', async () => {
    // Clique manual = intenção explícita: baixa (se preciso) e aplica, sem salvaguarda.
    try {
      await appUpdater.applyNow();
    } catch (e) {
      log(`[Update] Erro: ${e.message}`);
    }
  });

  // Versão do app pro badge da nav (renderer pede via invoke).
  ipcMain.handle('get-app-version', () => app.getVersion());

  ipcMain.on('webview-navigated', (event, payload) => {
    // v5.1.0+: payload é {portal, url}. Manter retrocompat se vier string antiga.
    const portal = typeof payload === 'object' && payload ? payload.portal : 'comprasnet';
    const url = typeof payload === 'object' && payload ? payload.url : payload;
    log(`Navegação [${portal}]: ${url}`);
    if (portal === 'comprasnet' && url.includes('cnetmobile') && !url.includes('acesso-nao-autorizado') && state !== 'logged_in' && bearerToken) {
      state = 'logged_in';
      loginAt = new Date().toISOString();
      log('Login Comprasnet detectado! Estado → logged_in');
    }
  });

  ipcMain.on('portal-switched', (event, name) => {
    log(`[Portal] Usuário trocou pra ${name}`);
  });

  // Enviar status periodicamente para a navbar
  setInterval(() => {
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        state,
        loggedIn: state === 'logged_in',
        bearerAge: bearerTimestamp ? Math.floor((Date.now() - bearerTimestamp) / 1000) : null,
      });
    }
  }, 2000);

  // Window fechou
  mainWindow.on('closed', () => {
    mainWindow = null;
    webviewContents = null;
    saveRecording();
    log('Janela fechada');
  });

  log('');
  log('╔══════════════════════════════════════════════════╗');
  log('║  LICITEAGORA BROWSER v5.1.0+                    ║');
  log('║  Comprasnet + BNC em paralelo.                  ║');
  log('║  Alterne pelos botões na barra superior.        ║');
  log('║  Feche a janela ou Ctrl+C para sair.            ║');
  log('╚══════════════════════════════════════════════════╝');
  log('');
});

// ─── Integração com Servidor LiciteAgora ────────────────────────────────────
// Extraído pra portals/comprasnet/integration.js (Fase 2B do refactor).
// O bootstrap dos módulos (cnet/serverSync/lanceProcessor/sessionTimers)
// + ReAuth SSO 3-passos vivem lá. Aqui ficou só o wrapper que delega.

function startServerIntegration() {
  cnetIntegration.start({ ctx: portalCtxSingleton, autoLoginModule });
}

// ─── Fetch no contexto da página: extraído pra portals/comprasnet/fetch.js ───
// Helper criado em app.whenReady (vide comprasnetFetch holder no topo).

// ─── Auto-login na inicialização (lê credenciais do banco) ────────────────────

const DB_PATH = args.find((_, i, a) => a[i - 1] === '--db')
  || process.env.LICITEAGORA_DB
  || path.join(__dirname, '..', 'pncp.db');

// Multi-tenant (Fase 6): SERVER_URL veio de serverUrlArg (argv/env/store).
// Abaixo usa diretamente a variável serverUrlArg.

// ─── API Server (para integrar com o server.js existente) ────────────────────

const http = require('http');

const apiServer = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  try {
    // Handlers Comprasnet-específicos extraídos (Fase 2C):
    //   /popups, /exec-popup, /fetch, /reload-popup, /reload-all, /login
    // Se um casar, encerra aqui. Senão, segue pros handlers portal-agnósticos.
    if (cnetApiHandlers && await cnetApiHandlers.tryHandle(req, res, url)) return;

    // GET /status
    if (url.pathname === '/status') {
      const saved = loadToken();
      const ttl = saved ? tokenTTL(saved) : 0;
      res.writeHead(200);
      res.end(JSON.stringify({
        state,
        bearerFresh: tokenFresco(),
        bearerAge: bearerTimestamp ? Math.floor((Date.now() - bearerTimestamp) / 1000) : null,
        bearerToken: bearerToken ? bearerToken.substring(0, 40) + '...' : null,
        tokenTTL: ttl,
        tokenSavedToDisk: !!saved,
        loginAt,
        serverIntegration: cnetIntegration.isStarted(),
        syncCount: serverSync.syncCount,
        ssoMorto: serverSync.isSSODead(),
        lances: lanceProcessor.stats(),
        url: webviewContents ? webviewContents.getURL() : null,
        apiLogCount: apiLog.length,
      }));
      return;
    }

    // GET /bearer
    if (url.pathname === '/bearer') {
      res.writeHead(200);
      res.end(JSON.stringify({
        bearer: bearerToken,
        fresh: tokenFresco(),
        age: bearerTimestamp ? Math.floor((Date.now() - bearerTimestamp) / 1000) : null,
      }));
      return;
    }

    // GET /api-log
    if (url.pathname === '/api-log') {
      res.writeHead(200);
      res.end(JSON.stringify(apiLog.slice(-100)));
      return;
    }

    // GET /logs — logs do Electron em tempo real
    if (url.pathname === '/logs') {
      res.writeHead(200);
      res.end(JSON.stringify(logBuffer.slice(-100)));
      return;
    }

    // POST /navigate  { url: "..." } — portal-agnóstico (qualquer URL)
    if (url.pathname === '/navigate' && req.method === 'POST') {
      const body = await readBody(req);
      const { url: navUrl } = JSON.parse(body);
      if (webviewContents) webviewContents.loadURL(navUrl);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, url: webviewContents ? webviewContents.getURL() : null }));
      return;
    }

    // POST /exec  { js: "document.title" }  — executa JS no webview
    if (url.pathname === '/exec' && req.method === 'POST') {
      const body = await readBody(req);
      const { js } = JSON.parse(body);
      if (!webviewContents) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Webview não disponível' }));
        return;
      }
      try {
        const result = await webviewContents.executeJavaScript(js);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, result }));
      } catch (e) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // POST /reload
    if (url.pathname === '/reload' && req.method === 'POST') {
      if (webviewContents) webviewContents.reload();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /check-update — verificar nova versão (electron-updater; download
    // dispara sozinho se houver versão nova, autoDownload=true)
    if (method === 'POST' && url === '/check-update') {
      const update = await appUpdater.check();
      res.writeHead(200, CT);
      res.end(JSON.stringify(update));
      return;
    }

    // POST /download-update — checkForUpdates já baixa (autoDownload=true)
    if (method === 'POST' && url === '/download-update') {
      try {
        const update = await appUpdater.check();
        res.writeHead(200, CT);
        res.end(JSON.stringify(update.available
          ? { ok: true, version: update.version, downloading: true }
          : { ok: false, message: 'Já está na versão mais recente' }));
      } catch (e) {
        res.writeHead(500, CT);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // POST /apply-update — força a instalação (baixa se preciso). Ignora salvaguarda.
    if (method === 'POST' && url === '/apply-update') {
      res.writeHead(200, CT);
      res.end(JSON.stringify({ ok: true, message: 'Aplicando update (baixa se necessário)...' }));
      appUpdater.applyNow().catch(e => log(`[Update] Erro ao aplicar: ${e.message}`));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// API local: tenta 9500 primeiro; se ocupada, faz fallback para porta
// efêmera (0). Em todo caso, nunca crasha o processo principal.
const API_PORT_PREFERRED = 9500;

function startApiServer() {
  apiServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`[API] Porta ${API_PORT_PREFERRED} ocupada — tentando porta efêmera`);
      apiServer.removeAllListeners('error');
      apiServer.on('error', (e2) => log(`[API] Erro no listen: ${e2.message}`));
      apiServer.listen(0, '127.0.0.1', () => {
        const addr = apiServer.address();
        log(`API local em http://127.0.0.1:${addr && addr.port}`);
      });
    } else {
      log(`[API] Erro no listen: ${err.message}`);
    }
  });
  apiServer.listen(API_PORT_PREFERRED, '127.0.0.1', () => {
    log(`API local em http://127.0.0.1:${API_PORT_PREFERRED}`);
    log('  GET  /status     — estado da sessão');
    log('  GET  /bearer     — token atual');
    log('  GET  /api-log    — últimas requisições');
    log('  POST /fetch      — executar fetch no contexto do browser');
    log('  POST /navigate   — navegar para URL');
    log('  POST /reload     — recarregar página');
  });
}

app.whenReady().then(() => {
  startApiServer();
});

// ─── Save Recording ──────────────────────────────────────────────────────────

function saveRecording() {
  if (apiLog.length === 0) return;
  // Recording é acessório (auditoria) — NUNCA pode crashar o app ao fechar.
  // Qualquer falha de I/O (ex: EPERM em dir read-only) é logada e ignorada.
  try {
    if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const file = path.join(RECORDINGS_DIR, `electron-${nameArg}-${timestamp}.json`);
    fs.writeFileSync(file, JSON.stringify({
      name: nameArg,
      startedAt: new Date(startTime).toISOString(),
      endedAt: new Date().toISOString(),
      totalApiCalls: apiLog.length,
      apiLog,
    }, null, 2));
    log(`Recording salvo: ${file}`);
  } catch (e) {
    log(`[Recording] Falha ao salvar (ignorado): ${e.message}`);
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanupAll() {
  saveRecording();
  sessionTimers.stop();
  serverSync.stop();
  lanceProcessor.stop();
  appUpdater.stopPeriodicCheck();
}

app.on('window-all-closed', () => {
  // Com tray ativo, "fechar" a janela já redireciona pra hide(); essa
  // emissão só acontece se a janela for de fato destruída (Quit explícito
  // pelo menu ou erro). Sem tray (fallback de OS sem suporte), comportamento
  // legado: app sai junto com a janela.
  if (trayIcon && !isQuitting) {
    log('[App] Janela destruída mas tray ativo — mantendo processo vivo.');
    return;
  }
  log('[App] Fechando aplicação...');
  cleanupAll();
  app.quit();
});

app.on('before-quit', () => { isQuitting = true; });

process.on('SIGINT', () => {
  isQuitting = true;
  cleanupAll();
  app.quit();
  process.exit(0);
});

process.on('SIGTERM', () => {
  isQuitting = true;
  cleanupAll();
  app.quit();
  process.exit(0);
});
