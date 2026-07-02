'use strict';

/**
 * portals/comprasnet/reauth.js — Re-auth SSO estilo Lancer (3 passos).
 *
 * Extraído de electron-browser.js (callback onNeedReload do serverSync.init,
 * lines ~616-718 originais). Comportamento idêntico ao código inline anterior.
 *
 * Por que existe: o reload() simples re-acionava hCaptcha. Em vez disso, a
 * gente segue o caminho que o usuário humano faria:
 *   Passo 1 (0s):    SSO /authorize → cadeia de redirects automática
 *   Passo 2 (10s):   navegar a /assinadas/dispensa_eletronica.asp pra pegar
 *                    `compras-id`, e em seguida abrir cnetmobile seguro
 *   Passo 3 (23s):   voltar ao loginPortal.asp (ComprasNet legado)
 *
 * Se em qualquer ponto o webview cair em acesso.gov.br/login (cookie SSO
 * morto), aborta e dispara attemptAutoRelogin() — re-login completo.
 *
 * Uso:
 *   const reauth = require('./reauth');
 *   const onNeedReload = reauth.createOnNeedReload({ ctx, autoLoginModule });
 *   serverSync.init({ ..., onNeedReload });
 *
 * `ctx` precisa expor:
 *   log, getWebview(), serverSync (resetAguardando)
 */

const SSO_AUTHORIZE_URL =
  'https://sso.acesso.gov.br/authorize'
  + '?response_type=code'
  + '&client_id=comprasnet.gov.br'
  + '&scope=openid+profile+email+phone+govbr_confiabilidades'
  + '&state=F'
  + '&redirect_uri=https://www.comprasnet.gov.br/seguro/landing_sso.asp';

const DISPENSA_URL = 'https://www.comprasnet.gov.br/assinadas/dispensa_eletronica.asp';
const LOGIN_PORTAL_URL = 'https://www.comprasnet.gov.br/seguro/loginPortal.asp';

function createOnNeedReload({ ctx, autoLoginModule }) {
  const { log, serverSync } = ctx;

  return function onNeedReload() {
    const webviewContents = ctx.getWebview();
    if (!webviewContents) return;
    log('[ReAuth] Iniciando re-auth SSO estilo Lancer...');

    let aborted = false;
    let capturedComprasId = null;

    const onNav = (event, url) => {
      log(`[ReAuth] nav: ${url.substring(0, 100)}`);
      if (url.includes('acesso.gov.br/login') || url.includes('acesso-nao-autorizado')) {
        log('[ReAuth] SSO cookie expirou — re-login completo necessário');
        aborted = true;
        cleanup();
        serverSync.resetAguardando();
        autoLoginModule.attemptAutoRelogin();
      }
    };

    const redirectFilter = { urls: ['*://comprasnet.gov.br/*', '*://www.comprasnet.gov.br/*'] };
    const onRedirect = (details) => {
      const rUrl = details.redirectURL || details.url || '';
      if (rUrl.includes('compras-id=')) {
        const match = rUrl.match(/compras-id=([0-9a-f-]+)/i);
        if (match) {
          capturedComprasId = match[1];
          log(`[ReAuth] compras-id capturado: ${capturedComprasId}`);
        }
      }
    };

    webviewContents.on('did-navigate', onNav);
    webviewContents.session.webRequest.onBeforeRedirect(redirectFilter, onRedirect);

    function cleanup() {
      try {
        webviewContents.removeListener('did-navigate', onNav);
        webviewContents.session.webRequest.onBeforeRedirect(redirectFilter, null);
      } catch (e) {}
    }

    // Passo 1: SSO /authorize → cadeia de redirects automática
    log('[ReAuth] Passo 1/3: SSO /authorize...');
    webviewContents.loadURL(SSO_AUTHORIZE_URL);

    // Passo 2: após 10s, navegar a dispensa_eletronica pra obter compras-id
    setTimeout(() => {
      cleanup();
      const wv = ctx.getWebview();
      if (aborted || !wv || wv.isDestroyed()) return;

      const currentUrl = wv.getURL();
      log(`[ReAuth] Passo 2/3: URL=${currentUrl.substring(0, 80)}, compras-id=${capturedComprasId || 'N/A'}`);

      if (currentUrl.includes('acesso.gov.br')) {
        log('[ReAuth] Ainda no SSO — sessão expirou');
        serverSync.resetAguardando();
        autoLoginModule.attemptAutoRelogin();
        return;
      }

      log('[ReAuth] Passo 2/3: Navegando a dispensa_eletronica.asp...');
      wv.loadURL(DISPENSA_URL);

      // Após 3s, extrair compras-id e navegar ao cnetmobile seguro
      setTimeout(async () => {
        const wv2 = ctx.getWebview();
        if (!wv2 || wv2.isDestroyed()) return;
        try {
          const cnetId = await wv2.executeJavaScript(`
            (function() {
              var el = document.getElementById('compras-id');
              if (el) return el.value;
              var input = document.querySelector('input[name="compras-id"]');
              if (input) return input.value;
              return null;
            })()
          `);
          if (cnetId) {
            const secureUrl = `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras?compras-id=${cnetId}&compra=`;
            log(`[ReAuth] compras-id=${cnetId} — navegando ao cnetmobile seguro`);
            wv2.loadURL(secureUrl);
          } else {
            log('[ReAuth] compras-id não encontrado na página');
          }
        } catch (err) {
          log(`[ReAuth] Erro ao extrair compras-id: ${err.message}`);
        }

        // Passo 3: após 10s, voltar ao ComprasNet legado
        setTimeout(() => {
          const wv3 = ctx.getWebview();
          if (!wv3 || wv3.isDestroyed()) return;
          log('[ReAuth] Passo 3/3: Voltando ao ComprasNet legado');
          wv3.loadURL(LOGIN_PORTAL_URL);
        }, 10000);
      }, 3000);
    }, 10000);
  };
}

module.exports = {
  createOnNeedReload,
  SSO_AUTHORIZE_URL,
  DISPENSA_URL,
  LOGIN_PORTAL_URL,
};
