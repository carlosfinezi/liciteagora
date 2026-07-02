'use strict';

/**
 * portals/bll/index.js — Orquestrador do portal BLL (bllcompras.com).
 *
 * Objetivo: CAPTURA DE COOKIE de sessão BLL + AUTO-LOGIN.
 *   - serverBridge (HTTP client pra /api/electron/bll/*)
 *   - cookie-sync na session do webview (persist:bll) → POST cookies
 *   - auto-login trigger no did-finish-load /Home/Login
 *   - botão "Forçar login" via IPC trigger-login-bll
 *
 * A BLL roda a MESMA plataforma do BNC: login em /Home/Login com teclado
 * virtual `soma()` + reCAPTCHA invisible + `doLogin()` (DOM reconhecido in-vivo
 * 2026-06-29). Por isso o auto-login.js é porta direta do BNC e preenche a
 * sessão sozinho com as credenciais do tenant.
 *
 * Requisitos do electron-browser.js: init() depois do webview attached, com a
 * session correta (persist:bll) e o portalCtx compartilhado.
 */

const serverBridge = require('./server-bridge');
const cookieSync = require('./cookie-sync');
const autoLogin = require('./auto-login');
const captchaRelay = require('./captcha-relay');

const BLL_LOGIN_URL = 'https://bllcompras.com/Home/Login';

let started = false;
let cookieSyncHandle = null;
let autoLoginHandle = null;
let captchaRelayHandle = null;
let currentUserEmail = null;

function init({ ses, ctx, ipcMain }) {
  if (started) return;
  if (!ses) throw new Error('portals/bll: session obrigatório (use persist:bll)');
  started = true;

  const log = ctx.log;
  log('[BLL] Inicializando portal BLL');

  // 1) Server bridge — HTTP client pro tenant
  serverBridge.init({
    serverUrl: ctx.getServerUrl(),
    apiKey: ctx.getApiKey(),
    log,
  });

  // 2) Cookie sync — captura cookies bllcompras.com da session e POSTa
  cookieSyncHandle = cookieSync.start({
    session: ses,
    serverBridge,
    log,
    getCurrentUserEmail: () => currentUserEmail,
  });

  // 3) Auto-login orchestrator (snippet builder + trigger)
  autoLoginHandle = autoLogin.create({
    ctx,
    serverBridge,
    getCookieSync: () => cookieSyncHandle,
  });

  // 4) Descobre o usuário (pra taggear o cookie POST). Best-effort.
  if (ctx.getApiKey()) {
    serverBridge.fetchCredentials()
      .then((creds) => { currentUserEmail = creds.usuario || null; log(`[BLL] Credenciais carregadas (user=${currentUserEmail || '?'})`); })
      .catch((e) => log(`[BLL] Sem credenciais BLL ainda: ${e.message}`));
  }

  // 5) Hook no did-finish-load: se chegou em /Home/Login E temos creds, dispara
  // auto-login; ao sair da página de login, força um ciclo de cookie-sync.
  const wv = ctx.getWebview();
  if (!wv) throw new Error('portals/bll: webview não disponível em init()');
  wv.on('did-finish-load', () => {
    const url = wv.getURL();
    log(`[BLL] did-finish-load: ${url}`);
    if (/\/Home\/Login/i.test(url)) {
      if (ctx.getApiKey()) {
        // ProcessUserSession demora ~2s pra completar (sorteia teclado virtual)
        setTimeout(() => autoLoginHandle.trigger({ manual: false }), 2500);
      }
    } else if (!/\/Login/i.test(url)) {
      setTimeout(() => cookieSyncHandle && cookieSyncHandle.forceSync(), 1500);
    }
  });

  // 6) IPC: botão "Forçar login" do nav HTML pode disparar trigger-login-bll
  if (ipcMain) {
    ipcMain.on('trigger-login-bll', () => {
      autoLoginHandle.trigger({ manual: true });
    });
  }

  // 7) Captcha relay — polla o servidor por pedidos de token reCAPTCHA v3 e
  // executa grecaptcha.execute no webview da sala, devolvendo o token. Usado
  // pelo bll-dispute-engine server-side pra obter tokens action=performBid.
  captchaRelayHandle = captchaRelay.start({ serverBridge, ctx });

  log('[BLL] Portal BLL ativo (auto-login + cookie + captcha-relay)');
}

function getStatus() {
  return {
    started,
    autoLoginInProgress: autoLoginHandle ? autoLoginHandle.isInProgress() : false,
    currentUser: (autoLoginHandle && autoLoginHandle.getCurrentUserEmail()) || currentUserEmail,
  };
}

function forceCookieSync() {
  if (cookieSyncHandle) return cookieSyncHandle.forceSync();
}

function triggerLogin({ manual = true } = {}) {
  if (autoLoginHandle) return autoLoginHandle.trigger({ manual });
}

module.exports = {
  name: 'bll',
  init,
  getStatus,
  forceCookieSync,
  triggerLogin,
  BLL_LOGIN_URL,
};
