'use strict';

/**
 * portals/comprasnet/bearer-interceptor.js — Captura Bearer token do
 * Comprasnet/SERPRO via webRequest.onBeforeSendHeaders.
 *
 * Extraído de electron-browser.js (lines 426-469). Comportamento idêntico
 * ao código inline anterior.
 *
 * Filtra Authorization: Bearer apenas em requests pra
 * cnetmobile.estaleiro.serpro.gov.br — outros domínios passam intactos.
 *
 * Também limpa "Electron/<ver>" do User-Agent (mascaramento). Esse cleanup
 * vale pra todos os requests (não só Comprasnet) — necessário pro hCaptcha
 * não detectar Electron.
 *
 * Uso:
 *   const bearer = require('./bearer-interceptor');
 *   const register = bearer.createRegister(ctx);
 *   register(ses, 'default');         // session principal
 *   register(wvSession, 'webview');   // session do webview guest
 *   register(popupSession, 'popup');  // sessions de popups
 *
 * `ctx` precisa expor:
 *   log(msg)
 *   getBearer() / setBearer(authString, ts)
 *   getBearerTimestamp()
 *   getState() / setLoggedIn() — chamados quando token novo é capturado
 *   serverSync — passado por referência (resetAguardando, reviverSSO, enviarBearer)
 *   onLoggedInTransition() — callback quando state vira logged_in (chama startServerIntegration)
 *   tokenManager: { saveBearer, parseJWT, tokenTTL }
 */

const COMPRASNET_BEARER_HOST = 'cnetmobile.estaleiro.serpro.gov.br';

function createRegister(ctx) {
  const registeredSessions = new WeakSet();

  return function registerBearerInterceptor(targetSession, label) {
    if (registeredSessions.has(targetSession)) return;
    registeredSessions.add(targetSession);
    ctx.log(`[Interceptor] Registrado em session: ${label}`);

    targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
      // Limpeza de UA Electron/<ver> — vale pra todos os domínios
      if (details.requestHeaders['User-Agent']) {
        details.requestHeaders['User-Agent'] = details.requestHeaders['User-Agent']
          .replace(/Electron\/[\d.]+\s?/g, '')
          .replace(/\s{2,}/g, ' ');
      }

      // Captura Bearer apenas pra cnetmobile (qualquer janela/popup)
      const auth = details.requestHeaders['Authorization'] || details.requestHeaders['authorization'];
      if (auth && auth.startsWith('Bearer ') && details.url.includes(COMPRASNET_BEARER_HOST)) {
        const agora = Date.now();
        ctx.serverSync.resetAguardando();

        const currentBearer = ctx.getBearer();
        const currentTs = ctx.getBearerTimestamp();
        const isNew = auth !== currentBearer || !currentTs || (agora - currentTs) > 30000;

        if (isNew) {
          ctx.setBearer(auth, agora);

          const tokenData = ctx.tokenManager.saveBearer(auth);
          const claims = ctx.tokenManager.parseJWT(auth);
          const ttl = ctx.tokenManager.tokenTTL(tokenData);
          ctx.log(`Bearer capturado: ${auth.substring(0, 40)}... (TTL: ${ttl}s, sub: ${claims?.sub || '?'})`);

          if (ctx.getState() !== 'logged_in') {
            ctx.setLoggedIn();
            ctx.log('Estado → logged_in');
            if (typeof ctx.onLoggedInTransition === 'function') ctx.onLoggedInTransition();
          }

          ctx.serverSync.reviverSSO();
          ctx.serverSync.enviarBearer().catch(() => {});
        }

        // Captura captcha hCaptcha quando aparece na query string (?captcha=P1_...).
        // Comprasnet usa em endpoints fase-externa/mensagens. Sem isso, server
        // não consegue chamar /itens/aguardando-abertura-sessao-publica.
        const captchaMatch = details.url.match(/[?&]captcha=([^&]+)/);
        if (captchaMatch && captchaMatch[1] && typeof ctx.serverSync.enviarCaptcha === 'function') {
          const captchaToken = decodeURIComponent(captchaMatch[1]);
          ctx.serverSync.enviarCaptcha(captchaToken).catch(() => {});
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    });
  };
}

module.exports = {
  createRegister,
  COMPRASNET_BEARER_HOST,
};
