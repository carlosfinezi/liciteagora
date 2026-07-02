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
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

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

  // ─── Recuperação automática: limpar perfil quando o login trava ──────────
  // SSO morto (reload-timeout sem capturar Bearer) = login não conseguiu
  // re-logar — quase sempre o perfil Comprasnet ficou FLAGRADO pelo hCaptcha
  // (que então vira desafio visível, e o auto-login não resolve). Em vez de só
  // desistir, limpamos a sessão (cookies/storage) — perfil "limpo" geralmente
  // recebe hCaptcha invisível — e re-logamos. Guard contra loop: máx 2/hora,
  // senão desiste e alerta (evita clear→falha→clear infinito).
  let _clearTentativas = 0;
  let _clearUltimaEm = 0;
  const CLEAR_MAX = 2;
  const CLEAR_JANELA_MS = 3600000;   // 1h
  const CLEAR_COOLDOWN_MS = 150000;  // 2.5min entre tentativas
  async function tentarRecuperacaoPerfilLimpo() {
    const agora = Date.now();
    if (agora - _clearUltimaEm > CLEAR_JANELA_MS) _clearTentativas = 0;  // reset janela
    if (agora - _clearUltimaEm < CLEAR_COOLDOWN_MS) return;              // cooldown
    if (_clearTentativas >= CLEAR_MAX) {
      // clearStorageData (limpeza parcial) não zerou o hCaptcha → ESCALAR p/ wipe TOTAL do
      // perfil + relaunch (v5.2.16). Máquina desassistida: nunca desistir de vez.
      // Rate limit: no máx 1 wipe-relaunch a cada 15 min (persistido em arquivo).
      const UDIR = app.getPath('userData');
      const lastWipeFile = path.join(UDIR, 'last-profile-wipe');
      let lastWipe = 0;
      try { lastWipe = parseInt(fs.readFileSync(lastWipeFile, 'utf8'), 10) || 0; } catch {}
      if (agora - lastWipe < 900000) {
        log('[Recuperação] Wipe de perfil recente (<15min) — aguardando antes de novo relaunch.');
        try { await serverSync.serverLog('profile-wipe-ratelimited', {}); } catch {}
        return;
      }
      try {
        fs.writeFileSync(path.join(UDIR, 'wipe-profile-on-start'), '1');
        fs.writeFileSync(lastWipeFile, String(agora));
      } catch (e) { log(`[Recuperação] falha ao marcar wipe: ${e.message}`); }
      log('[Recuperação] clearStorageData não resolveu → WIPE TOTAL do perfil + relaunch (fresh).');
      try { await serverSync.serverLog('profile-wipe-relaunch', { tentativas: _clearTentativas }); } catch {}
      app.relaunch();
      app.exit(0);
      return;
    }
    _clearTentativas++;
    _clearUltimaEm = agora;
    const wvc = ctx.getWebview();
    if (!wvc) return;
    try {
      log(`[Recuperação] SSO morto → limpando perfil Comprasnet (tentativa ${_clearTentativas}/${CLEAR_MAX}) e re-logando limpo...`);
      try { await serverSync.serverLog('profile-clear-recovery', { tentativa: _clearTentativas }); } catch {}
      // 1. Limpa cookies/storage da sessão Comprasnet (remove o estado flagrado)
      await wvc.session.clearStorageData({ storages: ['cookies', 'localstorage', 'caches', 'serviceworkers', 'indexdb', 'websql', 'shadercache'] });
      // 2. Reabilita o SSO (ssoMorto=false) pra permitir novo login
      serverSync.reviverSSO();
      // 3. Reload + auto-login limpo
      await wvc.loadURL('https://comprasnet.gov.br/seguro/loginPortal.asp');
      autoLoginModule.autoLoginFromDB();
    } catch (e) {
      log(`[Recuperação] Falhou: ${e.message}`);
    }
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
