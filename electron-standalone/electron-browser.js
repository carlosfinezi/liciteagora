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

const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { saveBearer, isTokenValid, tokenTTL, loadToken, clearToken, parseJWT } = require('./token-manager');
const { saveToken } = require('./store');
const cnet = require('./comprasnet-api');
const serverSync = require('./server-sync');
const lanceProcessor = require('./lance-processor');

// ─── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const headless = args.includes('--headless');
const urlArg = args.find((_, i, a) => a[i - 1] === '--url') || 'https://comprasnet.gov.br/seguro/loginPortal.asp';
const nameArg = args.find((_, i, a) => a[i - 1] === '--name') || 'comprasnet';
let apiKeyArg = args.find((_, i, a) => a[i - 1] === '--api-key') || process.env.LICITEAGORA_API_KEY || null;

// userData ao lado do exe (portátil, fora do asar)
const IS_PACKAGED = app.isPackaged;
const USER_DATA_DIR = IS_PACKAGED
  ? path.join(path.dirname(process.execPath), '.electron-profile')
  : path.join(__dirname, '.electron-profile');
const RECORDINGS_DIR = path.join(USER_DATA_DIR, 'recordings');
const TOKEN_MAX_AGE_MS = 540000; // 9 min

// ─── State ───────────────────────────────────────────────────────────────────

let mainWindow = null;
let webviewContents = null;
let bearerToken = null;
let bearerTimestamp = null;
let state = 'idle'; // idle | connected | logged_in | error
let loginAt = null;
const apiLog = [];
const startTime = Date.now();

function ts() { return Date.now() - startTime; }

const logBuffer = [];
const LOG_BUFFER_MAX = 200;
const LOG_FLUSH_INTERVAL = 5000; // enviar logs ao servidor a cada 5s

function log(msg) {
  const t = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  const line = `[${t}] ${msg}`;
  console.log(line);
  logBuffer.push({ time: new Date().toISOString(), msg });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}

// Enviar logs ao servidor periodicamente
function startLogSync() {
  setInterval(() => {
    if (logBuffer.length === 0 || !apiKeyArg) return;
    const entries = logBuffer.splice(0, logBuffer.length);
    const body = JSON.stringify({ logs: entries, state, bearerAge: bearerTimestamp ? Math.floor((Date.now() - bearerTimestamp) / 1000) : null });
    const url = new URL('/api/electron/logs', SERVER_URL);
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKeyArg } }, () => {});
    req.on('error', () => {}); // silenciar erros de rede
    req.end(body);
  }, LOG_FLUSH_INTERVAL);
}

function tokenFresco() {
  return bearerToken && bearerTimestamp && (Date.now() - bearerTimestamp) < TOKEN_MAX_AGE_MS;
}

// ─── Electron App ────────────────────────────────────────────────────────────

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

// Ignorar erros de certificado ICP-Brasil (SERPRO)
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (url.includes('comprasnet.gov.br') || url.includes('serpro.gov.br') || url.includes('acesso.gov.br')) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

app.whenReady().then(async () => {
  log(`Electron ${process.versions.electron} / Chrome ${process.versions.chrome}`);
  log(`Modo: ${headless ? 'headless' : 'headed'}`);

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

  const ses = session.defaultSession;

  // Gravar chamadas de API (não assets)
  const IGNORE = ['.png', '.jpg', '.css', '.woff', '.svg', '.ico', '.js', '.map',
    'fonts.googleapis.com', 'google-analytics.com', 'googletagmanager.com'];

  ses.webRequest.onCompleted(
    { urls: ['https://cnetmobile.estaleiro.serpro.gov.br/*', 'https://www.comprasnet.gov.br/*'] },
    (details) => {
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
    }
  );

  // ─── Criar janela com barra de navegação (webview architecture) ─────

  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    show: !headless,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });

  // Carregar a página com navbar + webview
  await mainWindow.loadFile(path.join(__dirname, 'electron-nav.html'));

  // ─── Interceptor de headers: limpar UA + capturar Bearer ────────────
  // Registrado como função para aplicar em TODAS as sessions (default + webview guest + popups)
  const registeredSessions = new Set();

  function registerBearerInterceptor(targetSession, label) {
    if (registeredSessions.has(targetSession)) return;
    registeredSessions.add(targetSession);
    log(`[Interceptor] Registrado em session: ${label}`);

    targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.requestHeaders['User-Agent']) {
        details.requestHeaders['User-Agent'] = details.requestHeaders['User-Agent']
          .replace(/Electron\/[\d.]+\s?/g, '')
          .replace(/\s{2,}/g, ' ');
      }
      // Capturar Bearer de QUALQUER janela/popup
      const auth = details.requestHeaders['Authorization'] || details.requestHeaders['authorization'];
      if (auth && auth.startsWith('Bearer ') && details.url.includes('cnetmobile.estaleiro.serpro.gov.br')) {
        const agora = Date.now();
        serverSync.resetAguardando();
        if (auth !== bearerToken || !bearerTimestamp || (agora - bearerTimestamp) > 30000) {
          bearerToken = auth;
          bearerTimestamp = agora;

          const tokenData = saveBearer(auth);
          const claims = parseJWT(auth);
          const ttl = tokenTTL(tokenData);
          log(`Bearer capturado: ${auth.substring(0, 40)}... (TTL: ${ttl}s, sub: ${claims?.sub || '?'})`);

          if (state !== 'logged_in') {
            state = 'logged_in';
            loginAt = new Date().toISOString();
            log('Estado → logged_in');
            startServerIntegration();
          }

          serverSync.reviverSSO();
          serverSync.enviarBearer().catch(() => {});
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    });

  }

  // Registrar na session default (main window)
  registerBearerInterceptor(ses, 'default');

  // Enviar URL inicial ao webview
  mainWindow.webContents.send('set-url', urlArg);
  state = 'connected';
  log(`Navegando para ${urlArg}...`);

  // Receber notificações de navegação do webview
  ipcMain.on('webview-navigated', (event, url) => {
    log(`Navegação: ${url}`);
    if (url.includes('cnetmobile') && !url.includes('acesso-nao-autorizado') && state !== 'logged_in' && bearerToken) {
      state = 'logged_in';
      loginAt = new Date().toISOString();
      log('Login detectado! Estado → logged_in');
    }
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

  // Pegar referência ao webContents do webview quando estiver pronto
  mainWindow.webContents.on('did-attach-webview', async (event, wvContents) => {
    webviewContents = wvContents;
    log('Webview attached (id: ' + wvContents.id + ')');

    // Limpar UA do webview também
    const ua = wvContents.getUserAgent()
      .replace(/Electron\/[\d.]+\s?/g, '')
      .replace(/\s{2,}/g, ' ');
    wvContents.setUserAgent(ua);

    // ─── Registrar interceptor na session do webview (guest session) ────
    registerBearerInterceptor(wvContents.session, 'webview-guest');

    // ─── Permitir popups e monitorar Bearer em TODAS as janelas ──────
    wvContents.setWindowOpenHandler(({ url }) => {
      log(`Nova janela: ${url.substring(0, 80)}`);
      return { action: 'allow' };
    });

    // Quando popup for criado, registrar interceptor e guardar referência
    const popupWindows = new Map(); // id → webContents
    wvContents.on('did-create-window', (newWindow) => {
      const nwc = newWindow.webContents;
      log(`Popup aberto (id: ${nwc.id})`);
      popupWindows.set(nwc.id, nwc);
      registerBearerInterceptor(nwc.session, `popup-${nwc.id}`);
      nwc.on('did-navigate', (event, url) => {
        log(`Popup navegou: ${url.substring(0, 80)}`);
      });
      nwc.on('destroyed', () => {
        popupWindows.delete(nwc.id);
      });
    });

    // Expor popupWindows para o API server
    global.__popupWindows = popupWindows;

    // Monitorar navegação do webview principal
    wvContents.on('did-navigate', (event, url) => {
      log(`Webview navegou: ${url.substring(0, 80)}`);
    });

    // Buscar API key do servidor para envio de logs
    if (!apiKeyArg) {
      readCredentialsFromServer().then(creds => {
        if (apiKeyArg) {
          startLogSync();
          log('[Logs] Envio de logs ao servidor ativo');
        }
      }).catch(() => {});
    } else {
      startLogSync();
    }

    // Se já tem sessão válida, iniciar keepalive direto. Senão, auto-login.
    if (state === 'logged_in') {
      log('Sessão anterior válida — iniciando server integration...');
      startServerIntegration();
      wvContents.loadURL('https://comprasnet.gov.br/seguro/loginPortal.asp');
    } else {
      autoLoginFromDB();
    }
  });

  // Window fechou
  mainWindow.on('closed', () => {
    mainWindow = null;
    webviewContents = null;
    saveRecording();
    log('Janela fechada');
  });

  log('');
  log('╔══════════════════════════════════════════════════╗');
  log('║  ELECTRON BROWSER — CEF-like para Comprasnet    ║');
  log('║  Navegue normalmente. hCaptcha auto-resolve.    ║');
  log('║  Bearer capturado automaticamente.              ║');
  log('║  Feche a janela ou Ctrl+C para sair.            ║');
  log('╚══════════════════════════════════════════════════╝');
  log('');
});

// ─── Integração com Servidor LiciteAgora ────────────────────────────────────

let serverIntegrationStarted = false;

function startServerIntegration() {
  if (serverIntegrationStarted) return;
  if (!webviewContents) { log('[Integração] Webview não pronto, adiando...'); return; }
  serverIntegrationStarted = true;

  // Inicializar módulo comprasnet-api (Node.js https, sem session)
  cnet.init(webviewContents, () => bearerToken);

  // Inicializar server-sync
  serverSync.init({
    apiKey: apiKeyArg,
    getBearer: () => bearerToken,
    getBearerTimestamp: () => bearerTimestamp,
    log,
    onSSODead: () => {
      state = 'connected';
      if (mainWindow) mainWindow.webContents.send('token-expired');
    },
    onNewBearer: (newToken) => {
      bearerToken = newToken.startsWith('Bearer ') ? newToken : `Bearer ${newToken}`;
      bearerTimestamp = Date.now();
      saveBearer(bearerToken);
      log(`Bearer renovado via servidor: ${bearerToken.substring(0, 40)}...`);
    },
    onNeedReload: () => {
      log('[Reload] Disparando fetch no popup para renovar bearer...');
      const popups = global.__popupWindows || new Map();
      let targetWC = null;
      for (const [id, nwc] of popups) {
        const url = nwc.getURL();
        if (url.includes('cnetmobile')) { targetWC = nwc; break; }
      }
      if (!targetWC && webviewContents) targetWC = webviewContents;
      if (!targetWC) { log('[Reload] Nenhum contexto disponivel para renovar bearer'); return; }

      log('[Reload] Recarregando popup cnetmobile para renovar Bearer...');
      targetWC.reload();
      setTimeout(() => serverSync.resetAguardando(), 10000);
    },
  });

  // Inicializar lance-processor
  lanceProcessor.init({
    getBearer: () => bearerToken,
    getBearerTimestamp: () => bearerTimestamp,
    log,
    onNeedKeepalive: () => serverSync.executarKeepalive(),
  });

  // Iniciar tudo
  serverSync.start();
  lanceProcessor.start();
  log('[Integração] Server sync + Lance processor ATIVOS');
  if (apiKeyArg) {
    log(`[Integração] API Key: ${apiKeyArg.substring(0, 8)}...`);
  } else {
    log('[Integração] AVISO: Sem API Key (--api-key ou LICITEAGORA_API_KEY). Sync pode falhar com auth.');
  }
}

// ─── Fetch no contexto da página (para uso externo via IPC) ──────────────────
const CNET_BASE = 'https://cnetmobile.estaleiro.serpro.gov.br';

async function comprasnetFetch(apiPath, method = 'GET', body = null) {
  if (!webviewContents) throw new Error('Webview não disponível');

  const bodyStr = body ? JSON.stringify(body) : 'null';

  const result = await webviewContents.executeJavaScript(`
    (async () => {
      try {
        const headers = {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'x-device-platform': 'web',
          'x-version-number': '6.0.0',
        };
        ${bearerToken ? `headers['Authorization'] = '${bearerToken}';` : ''}

        const opts = {
          method: '${method}',
          credentials: 'include',
          headers,
        };
        ${body ? `opts.body = '${bodyStr.replace(/'/g, "\\'")}';` : ''}

        const resp = await fetch('${CNET_BASE}${apiPath}', opts);
        const ct = resp.headers.get('content-type') || '';
        let data;
        if (ct.includes('json')) {
          data = await resp.json();
        } else {
          data = await resp.text();
        }
        return { ok: resp.ok, status: resp.status, data };
      } catch (e) {
        return { ok: false, status: 0, error: e.message };
      }
    })()
  `);

  return result;
}

// ─── Login Automático ─────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getWV() {
  if (!webviewContents) throw new Error('Webview não disponível');
  return webviewContents;
}

async function waitForURL(wv, pattern, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = wv.getURL();
    if (url.includes(pattern)) return url;
    await sleep(500);
  }
  throw new Error(`Timeout esperando URL com "${pattern}" (atual: ${wv.getURL()})`);
}

async function waitForSelector(wv, selector, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await wv.executeJavaScript(`!!document.querySelector('${selector}')`).catch(() => false);
    if (found) return true;
    await sleep(300);
  }
  throw new Error(`Timeout esperando selector "${selector}"`);
}

// ─── Warmup de perfil (popular cookies/histórico antes do 1o login) ──────────

async function warmupProfile(wv) {
  const profileDefault = path.join(USER_DATA_DIR, 'Default');
  const isNewProfile = !fs.existsSync(profileDefault);
  if (!isNewProfile) {
    log('Perfil existente — skip warmup');
    return;
  }

  log('Perfil novo detectado — warmup de navegação...');
  const sites = [
    { url: 'https://www.google.com.br', name: 'Google', wait: 2000 },
    { url: 'https://www.gov.br', name: 'Gov.br', wait: 2000 },
    { url: 'https://www.comprasnet.gov.br', name: 'Comprasnet', wait: 2000 },
  ];

  for (const site of sites) {
    try {
      log(`  Warmup: ${site.name}...`);
      wv.loadURL(site.url);
      await sleep(site.wait);
    } catch (e) {
      log(`  Warmup ${site.name} erro: ${e.message}`);
    }
  }
  log('Warmup concluído');
}

// ─── Human-like interaction helpers ──────────────────────────────────────────

function humanDelay(minMs = 800, maxMs = 2000) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

// Digita texto caractere a caractere com delays aleatórios (simula humano)
async function humanType(wv, selector, text) {
  await wv.executeJavaScript(`
    (function() {
      const input = document.querySelector('${selector}');
      if (!input) throw new Error('Campo não encontrado: ${selector}');
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      return true;
    })()
  `);

  // Digitar caractere a caractere
  for (const char of text) {
    await wv.executeJavaScript(`
      (function() {
        const input = document.querySelector('${selector}');
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, input.value + '${char}');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: '${char}', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: '${char}', bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: '${char}', bubbles: true }));
      })()
    `);
    await sleep(50 + Math.random() * 100); // 50-150ms por tecla
  }

  // Disparar change ao final
  await wv.executeJavaScript(`
    (function() {
      const input = document.querySelector('${selector}');
      if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
}

// Simula mouse move para coords do elemento antes de clicar
async function humanClick(wv, selector) {
  await wv.executeJavaScript(`
    (function() {
      const el = document.querySelector('${selector}');
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
      const y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
      // Simular mousemove → mousedown → mouseup → click
      el.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseover', { clientX: x, clientY: y, bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
      el.click();
      return true;
    })()
  `);
}

async function autoLogin(cpf, senha) {
  const wv = getWV();
  state = 'logging_in';
  log('═══ LOGIN AUTOMÁTICO (human-like) ═══');
  log(`CPF: ${cpf.substring(0, 3)}...`);

  try {
    // 0. Warmup se perfil novo
    await warmupProfile(wv);

    // 1. Navegar ao loginPortal.asp (ponto de entrada real)
    log('Passo 1: Navegando ao loginPortal.asp...');
    wv.loadURL('https://comprasnet.gov.br/seguro/loginPortal.asp');
    await humanDelay(3000, 4000);

    // Verificar se já está logado (sessão anterior válida)
    const currentUrl = wv.getURL();
    if (currentUrl.includes('cnetmobile') && !currentUrl.includes('acesso-nao-autorizado')) {
      log('Já está logado! (sessão anterior válida)');
      state = 'logged_in';
      loginAt = new Date().toISOString();
      return { success: true, message: 'Sessão anterior válida' };
    }

    // 2. Expandir card "Fornecedor" e clicar em "Entrar com Gov.br"
    log('Passo 2: Expandindo card Fornecedor...');
    await humanDelay(1500, 2500);

    // Expandir o card de fornecedor (mudaPerfilBotao(1))
    await wv.executeJavaScript(`
      (function() {
        if (typeof mudaPerfilBotao === 'function') {
          mudaPerfilBotao(1);
          return 'mudaPerfilBotao(1)';
        }
        const btn = document.querySelector('button.fornecedor, button.expand.fornecedor');
        if (btn) { btn.click(); return 'button.fornecedor'; }
        return null;
      })()
    `).catch(e => null);
    log('Card Fornecedor expandido');
    await humanDelay(1500, 2500);

    // Agora clicar em "Entrar com Gov.br"
    log('Clicando em Entrar com Gov.br...');
    const clicked = await wv.executeJavaScript(`
      (function() {
        const els = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
        const govBtn = els.find(el => {
          const text = (el.textContent || el.value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          return (text.includes('entrar') && text.includes('gov')) || text === 'entrar';
        });
        if (govBtn) {
          govBtn.click();
          return (govBtn.textContent || govBtn.value || '').trim().substring(0, 80);
        }
        const ssoLink = document.querySelector('a[href*="acesso.gov.br"], a[href*="loginPortalFornecedor"]');
        if (ssoLink) {
          ssoLink.click();
          return 'href: ' + ssoLink.href.substring(0, 80);
        }
        const card = document.querySelector('.fornecedor-card, .card.fornecedor, [class*="fornecedor"]');
        if (card) {
          const btn = card.querySelector('a, button');
          if (btn) { btn.click(); return 'card btn: ' + (btn.textContent || btn.href || '').substring(0, 80); }
        }
        return null;
      })()
    `).catch(e => null);

    if (clicked) {
      log('Clicou em: ' + clicked);
    } else {
      log('Botão Entrar não encontrado após expandir — erro');
      state = 'error';
      return { success: false, message: 'Botão Entrar com Gov.br não encontrado' };
    }

    // 3. Aguardar chegada ao SSO gov.br
    log('Passo 3: Aguardando SSO gov.br...');
    await waitForURL(wv, 'acesso.gov.br', 30000);
    log('Página SSO carregada: ' + wv.getURL());

    // Esperar 6-8s para hCaptcha invisible carregar e resolver
    const hcaptchaWait = 6000 + Math.random() * 2000;
    log(`Aguardando ${Math.round(hcaptchaWait / 1000)}s para hCaptcha carregar...`);
    await sleep(hcaptchaWait);

    // 4. Preencher CPF caractere a caractere (human-like)
    log('Passo 4: Digitando CPF (human-like)...');
    const cpfSelector = 'input[name="accountId"], input#accountId, input[inputmode="numeric"], input[type="text"]';
    await waitForSelector(wv, cpfSelector, 15000);

    // Resolver selector para o primeiro que existir
    const resolvedCpfSelector = await wv.executeJavaScript(`
      (function() {
        const selectors = ['input[name="accountId"]', 'input#accountId', 'input[inputmode="numeric"]', 'input[type="text"]'];
        for (const s of selectors) {
          if (document.querySelector(s)) return s;
        }
        return null;
      })()
    `);

    if (!resolvedCpfSelector) {
      state = 'error';
      return { success: false, message: 'Campo CPF não encontrado' };
    }

    // Mouse move para o campo antes de clicar
    await humanClick(wv, resolvedCpfSelector);
    await humanDelay(300, 600);

    // Digitar CPF caractere a caractere
    await humanType(wv, resolvedCpfSelector, cpf);
    log('CPF digitado');
    await humanDelay(800, 1500);

    // 5. Clicar Continuar (com mouse simulation)
    log('Passo 5: Clicando Continuar...');
    const continuarClicked = await wv.executeJavaScript(`
      (function() {
        const btn = document.querySelector('button[type="submit"]')
          || document.querySelector('input[type="submit"]')
          || document.querySelector('.btn-primary')
          || Array.from(document.querySelectorAll('button')).find(b => {
            const t = (b.textContent || '').toLowerCase();
            return t.includes('continuar') || t.includes('avançar') || t.includes('entrar');
          });
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        btn.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseover', { clientX: x, clientY: y, bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
        btn.click();
        return (btn.textContent || btn.value || 'submit').trim().substring(0, 40);
      })()
    `);
    log(`Continuar clicado: ${continuarClicked || '?'}`);

    // 6. Aguardar tela de senha
    log('Passo 6: Aguardando campo de senha...');
    let senhaEncontrada = false;
    for (let i = 0; i < 40; i++) {
      const pageState = await wv.executeJavaScript(`
        (function() {
          return {
            temSenha: !!document.querySelector('input[type="password"]'),
            url: window.location.href,
            erro: (document.querySelector('.msg-erro, .alert-danger, [class*="error"], [class*="erro"]') || {}).textContent || null,
          };
        })()
      `).catch(() => ({ temSenha: false }));

      if (pageState.temSenha) {
        senhaEncontrada = true;
        log('Campo de senha encontrado!');
        break;
      }

      // Já redirecionou ao Comprasnet (sessão SSO válida)
      if (pageState.url && pageState.url.includes('cnetmobile') && !pageState.url.includes('acesso-nao-autorizado')) {
        log('Redirecionou direto ao Comprasnet (SSO válido)!');
        state = 'logged_in';
        loginAt = new Date().toISOString();
        return { success: true, message: 'SSO válido, login automático' };
      }

      if (pageState.erro && i % 5 === 0) {
        log(`Info página: ${(pageState.erro || '').substring(0, 100)}`);
      }

      await sleep(1000);
    }

    if (!senhaEncontrada) {
      const url = wv.getURL();
      log(`Campo de senha não apareceu após 40s. URL: ${url}`);
      state = 'connected';
      return { success: false, message: 'Campo de senha não apareceu', url };
    }

    // 7. Preencher senha (human-like, caractere a caractere)
    log('Passo 7: Digitando senha (human-like)...');
    await humanClick(wv, 'input[type="password"]');
    await humanDelay(300, 600);
    await humanType(wv, 'input[type="password"]', senha);
    log('Senha digitada');
    await humanDelay(800, 1500);

    // 8. Clicar Entrar (com simulação de mouse)
    log('Passo 8: Clicando Entrar...');
    await wv.executeJavaScript(`
      (function() {
        const btn = document.querySelector('button[type="submit"]')
          || document.querySelector('input[type="submit"]')
          || Array.from(document.querySelectorAll('button')).find(b => {
            const t = (b.textContent || '').toLowerCase();
            return t.includes('entrar') || t.includes('acessar') || t.includes('login');
          });
        if (!btn) throw new Error('Botão Entrar não encontrado');
        const rect = btn.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        btn.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
        btn.click();
        return true;
      })()
    `);
    log('Entrar clicado');

    // 9. Aguardar redirecionamento ao intro.htm (ou cnetmobile direto)
    log('Passo 9: Aguardando redirecionamento pós-login...');
    {
      const redirectStart = Date.now();
      const REDIRECT_TIMEOUT = 60000;

      while (Date.now() - redirectStart < REDIRECT_TIMEOUT) {
        const url = wv.getURL();

        // Sucesso: chegou ao intro.htm ou qualquer página do comprasnet pós-login
        if (url.includes('comprasnet.gov.br/intro') || url.includes('comprasnet.gov.br/main') ||
            (url.includes('comprasnet.gov.br/seguro/') && !url.includes('loginPortal') && !url.includes('landing_sso'))) {
          log(`Login OK — chegou em: ${url.substring(0, 80)}`);
          break;
        }

        // Sucesso direto no cnetmobile
        if (url.includes('cnetmobile') && !url.includes('acesso-nao-autorizado')) {
          log('Redirecionado direto ao cnetmobile!');
          break;
        }

        await sleep(500);
      }
    }

    // 10. Navegar ao dispensa_eletronica.asp (link real do menu "Licitação e Dispensa novo")
    // Essa página faz o handshake de auth e redireciona ao cnetmobile
    log('Passo 10: Abrindo Licitação e Dispensa via portal...');
    await sleep(3000); // Esperar popup.asp?ambiente=3

    // Navegar pela mesma rota que o menu usa: /assinadas/dispensa_eletronica.asp
    // Usa o frame principal (frames[1]) que é onde o conteúdo carrega
    await wv.executeJavaScript(`
      try {
        frames[1].location.href = '/assinadas/dispensa_eletronica.asp';
      } catch(e) {
        window.open('https://comprasnet.gov.br/assinadas/dispensa_eletronica.asp', '_blank');
      }
    `).catch(() => null);
    log('dispensa_eletronica.asp aberto');

    // 11. Aguardar Bearer ser capturado (vem do popup via session interceptor)
    log('Passo 11: Aguardando Bearer do popup cnetmobile...');
    for (let i = 0; i < 30; i++) {
      if (state === 'logged_in') {
        log('══ LOGIN CONCLUÍDO COM SUCESSO! ══');
        return { success: true, message: 'Login OK', bearerAge: 0 };
      }
      await sleep(1000);
    }

    // Se o Bearer não foi capturado no state mas pode ter sido capturado no interceptor
    if (bearerToken) {
      state = 'logged_in';
      loginAt = new Date().toISOString();
      log('══ LOGIN CONCLUÍDO COM SUCESSO! (Bearer detectado) ══');
      startServerIntegration();
      return { success: true, message: 'Login OK' };
    }

    state = 'connected';
    log('Login aparenta OK mas Bearer não capturado. Navegue ao cnetmobile manualmente.');
    return { success: false, message: 'Bearer não capturado' };

  } catch (e) {
    log(`Erro no login automático: ${e.message}`);
    state = 'error';
    return { success: false, message: e.message };
  }
}

// ─── Auto-login na inicialização (lê credenciais do banco) ────────────────────

const DB_PATH = args.find((_, i, a) => a[i - 1] === '--db')
  || process.env.LICITEAGORA_DB
  || path.join(__dirname, '..', 'pncp.db');

const SERVER_URL = 'http://217.216.85.37:8080';

function readCredentialsFromDB() {
  try {
    const { execSync } = require('child_process');
    const cpf = execSync(`sqlite3 "${DB_PATH}" "SELECT valor FROM config WHERE chave = 'comprasnet_usuario'"`, { encoding: 'utf8' }).trim();
    const senha = execSync(`sqlite3 "${DB_PATH}" "SELECT valor FROM config WHERE chave = 'comprasnet_senha'"`, { encoding: 'utf8' }).trim();
    if (cpf && senha) return { cpf, senha };
    const cpf2 = execSync(`sqlite3 "${DB_PATH}" "SELECT valor FROM config WHERE chave = 'govbr_cpf'"`, { encoding: 'utf8' }).trim();
    const senha2 = execSync(`sqlite3 "${DB_PATH}" "SELECT valor FROM config WHERE chave = 'govbr_senha'"`, { encoding: 'utf8' }).trim();
    if (cpf2 && senha2) return { cpf: cpf2, senha: senha2 };
    return null;
  } catch (e) {
    return null; // DB local não existe (Windows standalone)
  }
}

// Buscar credenciais e API key do servidor LiciteAgora
function fetchFromServer(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `${SERVER_URL}${endpoint}`;
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function readCredentialsFromServer() {
  try {
    // Primeiro tentar buscar com API key se já temos
    const headers = {};
    if (apiKeyArg) headers['X-Api-Key'] = apiKeyArg;

    const data = await new Promise((resolve, reject) => {
      const url = `${SERVER_URL}/api/electron/credentials`;
      const mod = url.startsWith('https') ? require('https') : require('http');
      const req = mod.get(url, { timeout: 10000, headers }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });

    if (data && data.cpf && data.senha) {
      log(`Credenciais obtidas do servidor (CPF: ${data.cpf.substring(0, 3)}...)`);
      if (data.apiKey) {
        apiKeyArg = data.apiKey;
        log(`API Key do servidor: ${apiKeyArg.substring(0, 8)}...`);
      }
      return { cpf: data.cpf, senha: data.senha };
    }
    return null;
  } catch (e) {
    log(`Servidor não respondeu credenciais: ${e.message}`);
    return null;
  }
}

async function autoLoginFromDB() {
  // Se já está logado (sessão anterior válida), não precisa login
  if (state === 'logged_in') return;

  // Ler API key do banco se não foi passada como argumento
  if (!apiKeyArg) {
    try {
      const { execSync } = require('child_process');
      const key = execSync(`sqlite3 "${DB_PATH}" "SELECT valor FROM config WHERE chave = 'api_key'"`, { encoding: 'utf8' }).trim();
      if (key) { apiKeyArg = key; log(`API Key lida do banco: ${key.substring(0, 8)}...`); }
    } catch {}
  }

  // 1. Tentar DB local
  let creds = readCredentialsFromDB();

  // 2. Fallback: buscar do servidor LiciteAgora
  if (!creds) {
    log('DB local não encontrado — buscando credenciais do servidor...');
    creds = await readCredentialsFromServer();
  }

  // Iniciar envio de logs ao servidor (agora temos API key)
  if (apiKeyArg) startLogSync();

  if (!creds) {
    log('Credenciais não encontradas (nem local, nem servidor). Faça login manual pela janela.');
    return;
  }

  log(`Credenciais encontradas no banco (CPF: ${creds.cpf.substring(0, 3)}...). Iniciando auto-login em 5s...`);
  await sleep(5000);

  const result = await autoLogin(creds.cpf, creds.senha);
  if (result.success) {
    log('Auto-login do banco: SUCESSO');
  } else {
    log(`Auto-login do banco: FALHA — ${result.message}`);
    // Retry após 60s
    log('Tentando novamente em 60s...');
    await sleep(60000);
    if (state !== 'logged_in') {
      const retry = await autoLogin(creds.cpf, creds.senha);
      if (retry.success) {
        log('Auto-login retry: SUCESSO');
      } else {
        log(`Auto-login retry: FALHA — ${retry.message}. Aguardando login manual.`);
      }
    }
  }
}

// ─── Auto Re-login ───────────────────────────────────────────────────────────

let reloginInProgress = false;
let lastReloginAt = 0;
const RELOGIN_COOLDOWN_MS = 120000; // 2 min entre tentativas

async function attemptAutoRelogin() {
  if (reloginInProgress) return;
  if (state === 'logged_in' && tokenFresco()) return;
  if (Date.now() - lastReloginAt < RELOGIN_COOLDOWN_MS) {
    log('Relogin: cooldown ativo, aguardando...');
    return;
  }

  reloginInProgress = true;
  lastReloginAt = Date.now();

  try {
    let creds = readCredentialsFromDB();
    if (!creds) creds = await readCredentialsFromServer();
    if (!creds) {
      log('Relogin: sem credenciais. Aguardando login manual.');
      return;
    }

    log('═══ RE-LOGIN AUTOMÁTICO ═══');
    await sleep(3000);

    const result = await autoLogin(creds.cpf, creds.senha);
    if (result.success) {
      log('Re-login: SUCESSO — sessão restaurada');
      serverSync.reviverSSO();
    } else {
      log(`Re-login: FALHA — ${result.message}`);
      serverSync.marcarSSOmorto();
    }
  } catch (e) {
    log(`Re-login erro: ${e.message}`);
    serverSync.marcarSSOmorto();
  } finally {
    reloginInProgress = false;
  }
}

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
        serverIntegration: serverIntegrationStarted,
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

    // GET /popups — lista popups abertos
    if (url.pathname === '/popups') {
      const popups = global.__popupWindows || new Map();
      const list = [];
      for (const [id, nwc] of popups) {
        try {
          list.push({ id, url: nwc.getURL(), title: nwc.getTitle() });
        } catch (e) {
          list.push({ id, error: e.message });
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify(list));
      return;
    }

    // POST /exec-popup  { id: 3, js: "document.title" }
    if (url.pathname === '/exec-popup' && req.method === 'POST') {
      const body = await readBody(req);
      const { id, js } = JSON.parse(body);
      const popups = global.__popupWindows || new Map();
      const nwc = popups.get(id);
      if (!nwc) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Popup não encontrado', available: [...popups.keys()] }));
        return;
      }
      try {
        const result = await nwc.executeJavaScript(js);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, result }));
      } catch (e) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // POST /navigate  { url: "..." }
    if (url.pathname === '/navigate' && req.method === 'POST') {
      const body = await readBody(req);
      const { url: navUrl } = JSON.parse(body);
      if (webviewContents) webviewContents.loadURL(navUrl);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, url: webviewContents ? webviewContents.getURL() : null }));
      return;
    }

    // POST /fetch  { path: "/api/...", method: "GET", body: null }
    if (url.pathname === '/fetch' && req.method === 'POST') {
      const body = await readBody(req);
      const { path: apiPath, method, body: reqBody } = JSON.parse(body);
      const result = await comprasnetFetch(apiPath, method || 'GET', reqBody);
      res.writeHead(200);
      res.end(JSON.stringify(result));
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

    // POST /reload-popup  { id: 4 }  — F5 em popup específico
    if (url.pathname === '/reload-popup' && req.method === 'POST') {
      const body = await readBody(req);
      const { id } = JSON.parse(body);
      const popups = global.__popupWindows || new Map();
      const nwc = popups.get(id);
      if (!nwc) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Popup não encontrado', available: [...popups.keys()] }));
        return;
      }
      nwc.reload();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, id, url: nwc.getURL() }));
      return;
    }

    // POST /reload-all  — F5 em todas as janelas abertas
    if (url.pathname === '/reload-all' && req.method === 'POST') {
      const popups = global.__popupWindows || new Map();
      const reloaded = [];
      for (const [id, nwc] of popups) {
        try { nwc.reload(); reloaded.push({ id, url: nwc.getURL() }); } catch {}
      }
      if (webviewContents) { webviewContents.reload(); reloaded.push({ id: 'webview', url: webviewContents.getURL() }); }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, reloaded }));
      return;
    }

    // POST /login  { cpf: "00602500206", senha: "..." }
    if (url.pathname === '/login' && req.method === 'POST') {
      const body = await readBody(req);
      const { cpf, senha } = JSON.parse(body);
      if (!cpf || !senha) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'cpf e senha obrigatórios' }));
        return;
      }
      // Executar login em background, responder imediatamente
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: 'Login iniciado...' }));
      autoLogin(cpf, senha).catch(e => log(`Login erro: ${e.message}`));
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

const API_PORT = 9500;

app.whenReady().then(() => {
  apiServer.listen(API_PORT, '127.0.0.1', () => {
    log(`API local em http://127.0.0.1:${API_PORT}`);
    log('  GET  /status     — estado da sessão');
    log('  GET  /bearer     — token atual');
    log('  GET  /api-log    — últimas requisições');
    log('  POST /fetch      — executar fetch no contexto do browser');
    log('  POST /navigate   — navegar para URL');
    log('  POST /reload     — recarregar página');
  });
});

// ─── Save Recording ──────────────────────────────────────────────────────────

function saveRecording() {
  if (apiLog.length === 0) return;
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
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanupAll() {
  saveRecording();
  serverSync.stop();
  lanceProcessor.stop();
}

app.on('window-all-closed', () => {
  log('[App] Fechando aplicação...');
  cleanupAll();
  app.quit();
});

process.on('SIGINT', () => {
  cleanupAll();
  app.quit();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanupAll();
  app.quit();
  process.exit(0);
});
