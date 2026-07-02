'use strict';

/**
 * portals/bnc/index.js — Orquestrador do portal BNC.
 *
 * Substitui o stub. Implementa init(opts) que wires up:
 *   - serverBridge (HTTP client pra /api/electron/bnc/*)
 *   - cookie-sync na session do webview (persist:bnc)
 *   - auto-login trigger no did-finish-load /Home/Login
 *   - botão "Forçar login" via IPC trigger-login
 *
 * NÃO toca em nada do Comprasnet — registerBearerInterceptor não é chamado,
 * popup-mgr nem importado, integração com server-sync (Bearer) skip.
 *
 * Requisitos do `electron-browser.js`:
 *   - chamar init() DEPOIS que webviewContents estiver disponível
 *   - passar a session correta (persist:bnc) que o webview usa
 *   - portalCtx é o mesmo objeto compartilhado de buildPortalCtx (com
 *     getWebview/getMainWindow/log/getApiKey/getServerUrl)
 */

const serverBridge = require('./server-bridge');
const cookieSync = require('./cookie-sync');
const autoLogin = require('./auto-login');
const captchaRelay = require('./captcha-relay');

const BNC_LOGIN_URL = 'https://bnccompras.com/Home/Login';

let started = false;
let cookieSyncHandle = null;
let autoLoginHandle = null;
let captchaRelayHandle = null;

function init({ ses, ctx, ipcMain }) {
  if (started) return;
  if (!ses) throw new Error('portals/bnc: session obrigatório (use persist:bnc)');
  started = true;

  const log = ctx.log;
  log('[BNC] Inicializando portal BNC');

  // 1) Server bridge — HTTP client pro tenant
  serverBridge.init({
    serverUrl: ctx.getServerUrl(),
    apiKey: ctx.getApiKey(),
    log,
  });

  // 2) Cookie sync — captura cookies bnccompras.com da session e POSTa
  cookieSyncHandle = cookieSync.start({
    session: ses,
    serverBridge,
    log,
    getCurrentUserEmail: () => autoLoginHandle && autoLoginHandle.getCurrentUserEmail(),
  });

  // 3) Auto-login orchestrator (snippet builder + trigger)
  autoLoginHandle = autoLogin.create({
    ctx,
    serverBridge,
    getCookieSync: () => cookieSyncHandle,
  });

  // 4) Hook no did-finish-load: se chegou em /Home/Login E temos creds, dispara
  const wv = ctx.getWebview();
  if (!wv) throw new Error('portals/bnc: webview não disponível em init()');

  wv.on('did-finish-load', async () => {
    const url = wv.getURL();
    log(`[BNC] did-finish-load: ${url}`);
    if (/\/Home\/Login/i.test(url) && ctx.getApiKey()) {
      // ProcessUserSession demora ~2s pra completar (sorteia teclado virtual)
      setTimeout(() => autoLoginHandle.trigger({ manual: false }), 2500);
    }
  });

  // Auto-cadastro de sala — quando o user navega pra /BatchList?param1=[gkz]...
  // o servidor recebe a URL e faz upsert em bnc_salas. Idempotente, dedup
  // local 30s pra não martelar em navigations internas (in-page).
  const RE_BATCHLIST = /\/BatchList\?[^#]*param1=(\[gkz\][^&]+)/i;
  const lastAutoCadastro = new Map(); // processId -> ts
  const tentarAutoCadastro = async (url) => {
    if (!url || !ctx.getApiKey()) return;
    const m = RE_BATCHLIST.exec(url);
    if (!m) return;
    const processId = decodeURIComponent(m[1]);
    const last = lastAutoCadastro.get(processId) || 0;
    if (Date.now() - last < 30000) return;
    lastAutoCadastro.set(processId, Date.now());
    try {
      const r = await serverBridge.requestRaw('POST', '/api/electron/bnc/sala-auto-cadastrar', { url });
      if (r.status === 200 && r.body && r.body.ok) {
        log(`[BNC] Sala auto-cadastrada: ${r.body.compraId} (lotesInseridos=${r.body.lotesInseridos})`);
      } else {
        log(`[BNC] Auto-cadastro falhou HTTP ${r.status}: ${JSON.stringify(r.body)}`);
      }
    } catch (e) {
      log(`[BNC] Auto-cadastro erro: ${e.message}`);
    }
  };
  wv.on('did-navigate', (_e, url) => tentarAutoCadastro(url));
  wv.on('did-navigate-in-page', (_e, url) => tentarAutoCadastro(url));

  // 5) IPC: botão "Forçar login" do nav HTML pode disparar trigger-login
  if (ipcMain) {
    ipcMain.on('trigger-login', () => {
      autoLoginHandle.trigger({ manual: true });
    });
  }

  // 6) Captcha relay — polla servidor por pedidos de token reCAPTCHA v3 e
  // executa grecaptcha.execute no webview, devolvendo o token. Usado pelo
  // motor de disputa server-side pra obter tokens action=performBid.
  captchaRelayHandle = captchaRelay.start({ serverBridge, ctx });

  log('[BNC] Portal BNC ativo');
}

function getStatus() {
  return {
    started,
    autoLoginInProgress: autoLoginHandle ? autoLoginHandle.isInProgress() : false,
    currentUser: autoLoginHandle ? autoLoginHandle.getCurrentUserEmail() : null,
  };
}

function forceCookieSync() {
  if (cookieSyncHandle) return cookieSyncHandle.forceSync();
}

function triggerLogin({ manual = true } = {}) {
  if (autoLoginHandle) return autoLoginHandle.trigger({ manual });
}

module.exports = {
  name: 'bnc',
  init,
  getStatus,
  forceCookieSync,
  triggerLogin,
  BNC_LOGIN_URL,
};
