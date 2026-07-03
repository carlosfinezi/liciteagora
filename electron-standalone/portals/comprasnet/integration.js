'use strict';

/**
 * portals/comprasnet/integration.js — Bootstrap dos módulos do portal
 * Comprasnet contra o servidor LiciteAgora (server-sync, lance-processor,
 * session-timers, comprasnet-api).
 *
 * Extraído de electron-browser.js (function startServerIntegration,
 * lines ~591-762 originais). Comportamento idêntico ao código inline.
 *
 * Idempotente: a primeira chamada a start(...) faz tudo, chamadas
 * subsequentes são no-op (proteção via flag local started).
 *
 * Uso:
 *   const integration = require('./integration');
 *   integration.start({ ctx, autoLoginModule });
 *
 * `ctx` precisa expor:
 *   log, getWebview(), getMainWindow(),
 *   getBearer(), getBearerTimestamp(), setBearer(auth, ts),
 *   getApiKey(), getServerUrl(),
 *   setState(s),
 *   tokenManager.saveBearer(token),
 *   serverSync (módulo) — passado via ctx pra mesmo singleton ser usado
 *                          tanto aqui quanto em bearer-interceptor
 *
 * Nota: cnet/lanceProcessor/sessionTimers são importados aqui diretamente
 * (são módulos Comprasnet-only, fazem sentido viver dentro do portal).
 */

const cnet = require('../../comprasnet-api');
const lanceProcessor = require('../../lance-processor');
const sessionTimers = require('../../session-timers');
const reauth = require('./reauth');

let started = false;

function start({ ctx, autoLoginModule }) {
  if (started) return;
  const wv = ctx.getWebview();
  if (!wv) { ctx.log('[Integração] Webview não pronto, adiando...'); return; }
  started = true;

  const { log, serverSync } = ctx;

  // Inicializar módulo comprasnet-api (Node.js https, sem session)
  cnet.init(wv, () => ctx.getBearer());

  // Construir callback de re-auth (fluxo SSO 3-passos do Lancer)
  const onNeedReload = reauth.createOnNeedReload({ ctx, autoLoginModule });

  // ─── Recuperação em SSO morto: re-login CIRÚRGICO (v5.2.19) ──────────────
  // A versão anterior fazia clearStorageData(cookies) + escalava pra wipe TOTAL +
  // relaunch. Isso apagava o device-trust do acesso.gov.br → o hCaptcha voltava →
  // clear→falha→clear em loop (124 giveups numa noite). REMOVIDO.
  // Agora só reabilita o SSO e dispara attemptAutoRelogin, que limpa apenas os
  // cookies do comprasnet.gov.br (limparSessaoComprasnet — preserva o trust) e tem
  // cooldown próprio de 2min. Se travar mesmo assim, é caso de UM login manual.
  function tentarRecuperacaoPerfilLimpo() {
    try { serverSync.reviverSSO(); } catch {}
    try { autoLoginModule.attemptAutoRelogin(); } catch (e) { log(`[Recuperação] Falhou: ${e.message}`); }
  }

  // Inicializar server-sync
  serverSync.init({
    apiKey: ctx.getApiKey(),
    serverUrl: ctx.getServerUrl(),
    getBearer: () => ctx.getBearer(),
    getBearerTimestamp: () => ctx.getBearerTimestamp(),
    portal: 'comprasnet',
    versao: ctx.version || require('../../package.json').version,
    log,
    onSSODead: () => {
      ctx.setState('connected');
      const mw = ctx.getMainWindow();
      if (mw) mw.webContents.send('token-expired');
      // Recuperação automática: limpa perfil flagrado + re-loga limpo (com guard).
      tentarRecuperacaoPerfilLimpo();
    },
    onNewBearer: (newToken) => {
      const auth = newToken.startsWith('Bearer ') ? newToken : `Bearer ${newToken}`;
      ctx.setBearer(auth, Date.now());
      ctx.tokenManager.saveBearer(auth);
      log(`Bearer renovado via servidor: ${auth.substring(0, 40)}...`);
    },
    onNeedReload,
  });

  // Inicializar lance-processor
  lanceProcessor.init({
    getBearer: () => ctx.getBearer(),
    getBearerTimestamp: () => ctx.getBearerTimestamp(),
    log,
    onNeedKeepalive: () => serverSync.executarKeepalive(),
  });

  // Inicializar session-timers
  sessionTimers.init({
    webviewContents: wv,
    getBearer: () => ctx.getBearer(),
    getBearerTimestamp: () => ctx.getBearerTimestamp(),
    getActiveCompraIds: () => serverSync.getActiveCompraIds(),
    isLanceProcessing: () => lanceProcessor.stats().processing,
    log,
    onSessionExpired: () => {
      log('[Timers] Sessão expirada — tentando re-login');
      autoLoginModule.attemptAutoRelogin();
    },
    onNeedRelogin: () => {
      log('[Timers] Token próximo de expirar — re-login proativo');
      autoLoginModule.attemptAutoRelogin();
    },
    onChatAlert: (mensagens) => {
      const mw = ctx.getMainWindow();
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('chat-alert', mensagens);
      }
    },
  });

  // Iniciar tudo
  serverSync.start();
  lanceProcessor.start();
  sessionTimers.start();
  log('[Integração] Server sync + Lance processor + Session timers ATIVOS');
  const apiKey = ctx.getApiKey();
  if (apiKey) {
    log(`[Integração] API Key: ${apiKey.substring(0, 8)}...`);
  } else {
    log('[Integração] AVISO: Sem API Key (--api-key ou LICITEAGORA_API_KEY). Sync pode falhar com auth.');
  }
}

function isStarted() {
  return started;
}

module.exports = {
  start,
  isStarted,
};
