'use strict';

/**
 * electron-browser.js — Browser CEF-like para Comprasnet
 *
 * Funciona como o Lancer do concorrente:
 *   - Electron = CEF (Chromium Embedded Framework) para Node.js
 *   - Sem navigator.webdriver, sem CDP markers, sem flags de automação
 *   - hCaptcha invisible auto-resolve (fingerprint limpo)
 *   - Captura Bearer tokens via interceptação de requests
 *   - Keepalive automático
 *   - Controle total via IPC do Node.js
 *
 * Uso:
 *   DISPLAY=:1 XAUTHORITY=/run/user/0/gdm/Xauthority npx electron electron-browser.js
 *
 * Flags:
 *   --headless        Rodar sem janela (para servidor)
 *   --url URL         URL inicial (default: Comprasnet)
 *   --name NOME       Nome da sessão para logs
 */

const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { saveBearer, tryRetoken, keepaliveAPI, keepaliveLegacy,
        isTokenValid, isTokenExpiringSoon, tokenTTL, loadToken, clearToken, parseJWT } = require('./token-manager');
const { saveToken } = require('./store');

// ─── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const headless = args.includes('--headless');
const urlArg = args.find((_, i, a) => a[i - 1] === '--url') || 'https://comprasnet.gov.br/seguro/loginPortal.asp';
const nameArg = args.find((_, i, a) => a[i - 1] === '--name') || 'comprasnet';

const USER_DATA_DIR = path.join(__dirname, '.electron-profile');
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const TOKEN_MAX_AGE_MS = 540000; // 9 min
const KEEPALIVE_INTERVAL_MS = 60000; // 60s
const API_BASE = 'https://cnetmobile.estaleiro.serpro.gov.br';

// ─── State ───────────────────────────────────────────────────────────────────

let mainWindow = null;
let webviewContents = null;
let bearerToken = null;
let bearerTimestamp = null;
let keepaliveTimer = null;
let state = 'idle'; // idle | connected | logged_in | error
let loginAt = null;
const apiLog = [];
const startTime = Date.now();

function ts() { return Date.now() - startTime; }

function log(msg) {
  const t = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  console.log(`[${t}] ${msg}`);
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

// Forçar WebGL via software (llvmpipe/mesa) — necessário para hCaptcha invisible
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

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

  // ─── Criar janela com barra de navegação ─────────────────────────────

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

  // Limpar User-Agent do webview (remover "Electron")
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.requestHeaders['User-Agent']) {
      details.requestHeaders['User-Agent'] = details.requestHeaders['User-Agent']
        .replace(/Electron\/[\d.]+\s?/g, '')
        .replace(/\s{2,}/g, ' ');
    }
    // Capturar Bearer (mover lógica para cá pois webview usa mesma session)
    const auth = details.requestHeaders['Authorization'] || details.requestHeaders['authorization'];
    if (auth && auth.startsWith('Bearer ') && details.url.includes('cnetmobile.estaleiro.serpro.gov.br')) {
      const agora = Date.now();
      if (auth !== bearerToken || !bearerTimestamp || (agora - bearerTimestamp) > 30000) {
        bearerToken = auth;
        bearerTimestamp = agora;

        // Salvar em disco para persistir entre reinícios
        const tokenData = saveBearer(auth);
        const claims = parseJWT(auth);
        const ttl = tokenTTL(tokenData);
        log(`Bearer capturado: ${auth.substring(0, 40)}... (TTL: ${ttl}s, sub: ${claims?.sub || '?'})`);

        if (state === 'connected' || state === 'logging_in') {
          state = 'logged_in';
          loginAt = new Date().toISOString();
          log('Estado → logged_in');
          startKeepalive();
        }
      }
    }
    callback({ requestHeaders: details.requestHeaders });
  });

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
      startKeepalive();
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
  mainWindow.webContents.on('did-attach-webview', (event, wvContents) => {
    webviewContents = wvContents;
    log('Webview attached (id: ' + wvContents.id + ')');

    // Limpar UA do webview também
    const ua = wvContents.getUserAgent()
      .replace(/Electron\/[\d.]+\s?/g, '')
      .replace(/\s{2,}/g, ' ');
    wvContents.setUserAgent(ua);

    // Se já tem sessão válida, iniciar keepalive direto. Senão, auto-login.
    if (state === 'logged_in') {
      log('Sessão anterior válida — iniciando keepalive...');
      startKeepalive();
      // Navegar ao Comprasnet direto (pular login)
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

// ─── Keepalive ───────────────────────────────────────────────────────────────

let keepaliveCount = 0;
let lastRetokenAt = 0;

function startKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveCount = 0;
  keepaliveTimer = setInterval(keepaliveStep, KEEPALIVE_INTERVAL_MS);
  log(`Keepalive ativo (cada ${KEEPALIVE_INTERVAL_MS / 1000}s)`);
}

async function keepaliveStep() {
  if (!webviewContents || state !== 'logged_in') return;
  keepaliveCount++;
  const wv = webviewContents;

  try {
    // 1. Keepalive API (datahorabrasilia)
    const result = await keepaliveAPI(wv, bearerToken);

    if (result.ok) {
      if (keepaliveCount % 5 === 0) {
        const ttl = tokenTTL(loadToken());
        log(`Keepalive #${keepaliveCount} OK — TTL: ${ttl}s — ${result.body || ''}`);
      }
    } else if (result.status === 401 || result.status === 403) {
      log(`Keepalive: sessão expirada (${result.status}) — tentando retoken...`);
      const retokenOk = await tryRetoken(wv, bearerToken);
      if (!retokenOk) {
        log('Retoken falhou. Sessão perdida.');
        state = 'connected';
        if (mainWindow) mainWindow.webContents.send('token-expired');
      }
    } else {
      log(`Keepalive: status ${result.status} — ${result.error || ''}`);
    }

    // 2. Keepalive legado (main.asp) — a cada 2 ciclos (~2 min)
    if (keepaliveCount % 2 === 0) {
      await keepaliveLegacy(wv);
    }

    // 3. Retoken preventivo — quando token está perto de expirar
    const savedToken = loadToken();
    if (savedToken && isTokenExpiringSoon(savedToken)) {
      const timeSinceLastRetoken = Date.now() - lastRetokenAt;
      if (timeSinceLastRetoken > 300000) { // Máx 1 a cada 5 min
        const ttl = tokenTTL(savedToken);
        log(`Token expira em ${ttl}s — retoken preventivo...`);
        const ok = await tryRetoken(wv, bearerToken);
        if (ok) lastRetokenAt = Date.now();
      }
    }

    // 4. Notificar renderer sobre estado do token
    if (mainWindow && savedToken) {
      const ttl = tokenTTL(savedToken);
      if (ttl < 600 && ttl > 0) { // < 10 min
        mainWindow.webContents.send('token-expiring-soon', { minutesLeft: Math.floor(ttl / 60) });
      }
    }

  } catch (e) {
    log(`Keepalive erro: ${e.message}`);
  }
}

// ─── Fetch no contexto da página (para uso externo via IPC) ──────────────────

async function comprasnetFetch(apiPath, method = 'GET', body = null) {
  if (!mainWindow) throw new Error('Janela não disponível');

  const bodyStr = body ? JSON.stringify(body) : 'null';
  const bearerStr = bearerToken || '';

  const result = await mainWindow.webContents.executeJavaScript(`
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

        const resp = await fetch('${API_BASE}${apiPath}', opts);
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

async function autoLogin(cpf, senha) {
  const wv = getWV();
  state = 'logging_in';
  log('═══ LOGIN AUTOMÁTICO ═══');
  log(`CPF: ${cpf.substring(0, 3)}...`);

  try {
    // 1. Navegar ao loginPortal.asp (ponto de entrada real)
    log('Passo 1: Navegando ao loginPortal.asp...');
    wv.loadURL('https://comprasnet.gov.br/seguro/loginPortal.asp');
    await sleep(3000);

    // Verificar se já está logado (sessão anterior válida)
    const currentUrl = wv.getURL();
    if (currentUrl.includes('cnetmobile') && !currentUrl.includes('acesso-nao-autorizado')) {
      log('Já está logado! (sessão anterior válida)');
      state = 'logged_in';
      loginAt = new Date().toISOString();
      startKeepalive();
      return { success: true, message: 'Sessão anterior válida' };
    }

    // 2. Expandir card "Fornecedor" e clicar em "Entrar com Gov.br"
    log('Passo 2: Expandindo card Fornecedor...');
    await sleep(2000);

    // Expandir o card de fornecedor (mudaPerfilBotao(1))
    await wv.executeJavaScript(`
      (function() {
        // Tentar a função direta
        if (typeof mudaPerfilBotao === 'function') {
          mudaPerfilBotao(1);
          return 'mudaPerfilBotao(1)';
        }
        // Fallback: clicar no botão com classe fornecedor
        const btn = document.querySelector('button.fornecedor, button.expand.fornecedor');
        if (btn) { btn.click(); return 'button.fornecedor'; }
        return null;
      })()
    `).catch(e => null);
    log('Card Fornecedor expandido');
    await sleep(2000);

    // Agora clicar em "Entrar com Gov.br"
    log('Clicando em Entrar com Gov.br...');
    const clicked = await wv.executeJavaScript(`
      (function() {
        // Procurar botão/link "Entrar com Gov.br" que aparece após expandir
        const els = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
        const govBtn = els.find(el => {
          const text = (el.textContent || el.value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          return (text.includes('entrar') && text.includes('gov')) || text === 'entrar';
        });
        if (govBtn) {
          govBtn.click();
          return (govBtn.textContent || govBtn.value || '').trim().substring(0, 80);
        }
        // Fallback: link com href para acesso.gov.br
        const ssoLink = document.querySelector('a[href*="acesso.gov.br"], a[href*="loginPortalFornecedor"]');
        if (ssoLink) {
          ssoLink.click();
          return 'href: ' + ssoLink.href.substring(0, 80);
        }
        // Fallback 2: qualquer botão visível no card expandido
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
    await sleep(4000); // Esperar hCaptcha, TSPD, etc carregarem

    // 4. Preencher CPF
    log('Passo 4: Preenchendo CPF...');
    await waitForSelector(wv, 'input[name="accountId"], input#accountId, input[type="text"]', 15000);

    await wv.executeJavaScript(`
      (function() {
        const input = document.querySelector('input[name="accountId"]')
          || document.querySelector('input#accountId')
          || document.querySelector('input[inputmode="numeric"]')
          || document.querySelector('input[type="text"]');
        if (!input) throw new Error('Campo CPF não encontrado');
        input.focus();
        input.value = '';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '${cpf}');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    log('CPF preenchido');
    await sleep(1500);

    // 5. Clicar Continuar
    log('Passo 5: Clicando Continuar...');
    await wv.executeJavaScript(`
      (function() {
        const btn = document.querySelector('button[type="submit"]')
          || document.querySelector('input[type="submit"]')
          || document.querySelector('.btn-primary')
          || Array.from(document.querySelectorAll('button')).find(b => {
            const t = (b.textContent || '').toLowerCase();
            return t.includes('continuar') || t.includes('avançar') || t.includes('entrar');
          });
        if (!btn) throw new Error('Botão Continuar não encontrado');
        btn.click();
        return true;
      })()
    `);
    log('Continuar clicado');

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
        startKeepalive();
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
      // Pode ser que hCaptcha bloqueou — estado fica connected para retry
      state = 'connected';
      return { success: false, message: 'Campo de senha não apareceu', url };
    }

    // 7. Preencher senha
    log('Passo 7: Preenchendo senha...');
    // Escapar caracteres especiais da senha para injeção segura
    const senhaEscapada = senha.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    await wv.executeJavaScript(`
      (function() {
        const input = document.querySelector('input[type="password"]');
        if (!input) throw new Error('Campo senha não encontrado');
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '${senhaEscapada}');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    log('Senha preenchida');
    await sleep(800);

    // 8. Clicar Entrar
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
        btn.click();
        return true;
      })()
    `);
    log('Entrar clicado');

    // 9. Aguardar redirecionamento ao Comprasnet
    log('Passo 9: Aguardando redirecionamento ao Comprasnet...');
    try {
      await waitForURL(wv, 'cnetmobile', 60000);
      log('Redirecionado ao Comprasnet!');
    } catch (e) {
      // Checar se ficou no SSO com erro
      const url = wv.getURL();
      log(`Timeout no redirecionamento. URL: ${url}`);
      state = 'connected';
      return { success: false, message: 'Timeout no redirecionamento', url };
    }

    // 10. Aguardar Bearer ser capturado
    log('Passo 10: Aguardando captura do Bearer...');
    for (let i = 0; i < 20; i++) {
      if (bearerToken) {
        state = 'logged_in';
        loginAt = new Date().toISOString();
        log('══ LOGIN CONCLUÍDO COM SUCESSO! ══');
        startKeepalive();
        return { success: true, message: 'Login OK', bearerAge: 0 };
      }
      await sleep(500);
    }

    // Bearer não capturado — tentar forçar uma chamada API
    log('Bearer não capturado automaticamente — forçando chamada...');
    await wv.executeJavaScript(`fetch('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-disputa/v1/datahorabrasilia', { credentials: 'include' }).catch(() => {})`);
    await sleep(3000);

    if (bearerToken) {
      state = 'logged_in';
      loginAt = new Date().toISOString();
      log('══ LOGIN CONCLUÍDO COM SUCESSO! (Bearer capturado via força) ══');
      startKeepalive();
      return { success: true, message: 'Login OK (forçado)' };
    }

    state = 'connected';
    log('Login aparenta OK mas Bearer não capturado');
    return { success: false, message: 'Bearer não capturado' };

  } catch (e) {
    log(`Erro no login automático: ${e.message}`);
    state = 'error';
    return { success: false, message: e.message };
  }
}

// ─── Auto-login na inicialização (lê credenciais do banco) ────────────────────

async function autoLoginFromDB() {
  try {
    // Ler credenciais do banco via sqlite3 CLI (evita incompatibilidade native module)
    const { execSync } = require('child_process');
    const dbPath = path.join(__dirname, 'pncp.db');

    const cpf = execSync(`sqlite3 "${dbPath}" "SELECT valor FROM config WHERE chave='govbr_cpf'"`, { encoding: 'utf8' }).trim();
    const senha = execSync(`sqlite3 "${dbPath}" "SELECT valor FROM config WHERE chave='govbr_senha'"`, { encoding: 'utf8' }).trim();

    if (!cpf || !senha) {
      log('Credenciais gov.br não configuradas no banco. Use POST /login ou configure em fornecedor.html');
      return;
    }

    log('Credenciais encontradas no banco — iniciando login automático...');
    await sleep(3000); // Esperar webview estar pronto
    await autoLogin(cpf, senha);
  } catch (e) {
    log(`Erro ao ler credenciais do banco: ${e.message}`);
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
        keepaliveCount,
        url: mainWindow ? mainWindow.webContents.getURL() : null,
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

    // POST /navigate  { url: "..." }
    if (url.pathname === '/navigate' && req.method === 'POST') {
      const body = await readBody(req);
      const { url: navUrl } = JSON.parse(body);
      if (mainWindow) await mainWindow.loadURL(navUrl);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, url: mainWindow?.webContents.getURL() }));
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
      if (mainWindow) mainWindow.webContents.reload();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
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

app.on('window-all-closed', () => {
  saveRecording();
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  app.quit();
});

process.on('SIGINT', () => {
  saveRecording();
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  app.quit();
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveRecording();
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  app.quit();
  process.exit(0);
});
