'use strict';

/**
 * portals/bll/captcha-relay.js — Polla o servidor por pedidos de token
 * reCAPTCHA v3 e executa grecaptcha.execute(sitekey, {action}) no webview da
 * sala BLL, devolvendo o resultado pro servidor. Porta de portals/bnc/captcha-relay.js.
 *
 * Quando o motor de disputa server-side (bll-dispute-engine) precisa enviar
 * um PerformBid, ele chama bll-captcha-bridge.requestToken({action}). Esse
 * pedido entra numa fila no servidor. Esse relay aqui:
 *
 *   1) GET /api/electron/bll/captcha-pending a cada 1s
 *   2) Se vem { id, action, sitekey }: executa grecaptcha.execute no webview
 *   3) POST /api/electron/bll/captcha-token com { id, token } (ou { id, error })
 *
 * Requisitos:
 *   - webview deve estar com bllcompras.com carregado (sala /BatchList já tem
 *     grecaptcha v3 carregado — sitekey 6LdpKvsm…, action performBid)
 *   - usuário logado (cookie de sessão BLL presente)
 *
 * Uso:
 *   const handle = require('./captcha-relay').start({ serverBridge, ctx });
 *   handle.stop();
 */

const POLL_INTERVAL_MS = 1000;
const EXECUTE_TIMEOUT_MS = 15000;

function start({ serverBridge, ctx }) {
  if (!serverBridge) throw new Error('serverBridge obrigatório');
  if (!ctx) throw new Error('ctx obrigatório');

  const log = ctx.log;
  let stopped = false;
  let timer = null;
  let inFlight = false;

  log('[bll captcha-relay] iniciando (poll a cada 1s)');

  function schedule() {
    if (stopped) return;
    timer = setTimeout(loop, POLL_INTERVAL_MS);
  }

  async function loop() {
    if (stopped || inFlight) { schedule(); return; }
    inFlight = true;
    try {
      const r = await request('GET', '/api/electron/bll/captcha-pending');
      if (!r || !r.id) { return; }  // sem pedido pendente
      const { id, action, sitekey } = r;
      log(`[bll captcha-relay] pedido id=${id.slice(0, 8)} action=${action} ageMs=${r.ageMs || 0}`);

      const wv = ctx.getWebview();
      if (!wv) {
        await postResult(id, null, 'webview indisponível');
        return;
      }

      try {
        const token = await executeRecaptcha(wv, sitekey, action);
        log(`[bll captcha-relay] token len=${(token || '').length} action=${action}`);
        await postResult(id, token, null);
      } catch (e) {
        log(`[bll captcha-relay] erro grecaptcha: ${e.message}`);
        await postResult(id, null, e.message || String(e));
      }
    } catch (e) {
      log(`[bll captcha-relay] poll erro: ${e.message}`);
    } finally {
      inFlight = false;
      schedule();
    }
  }

  async function request(method, path, body) {
    if (typeof serverBridge.requestRaw === 'function') {
      const r = await serverBridge.requestRaw(method, path, body);
      if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
      return r.body;
    }
    throw new Error('serverBridge.requestRaw não disponível');
  }

  async function postResult(id, token, error) {
    try {
      await request('POST', '/api/electron/bll/captcha-token', { id, token, error });
    } catch (e) {
      log(`[bll captcha-relay] postResult falhou id=${id.slice(0, 8)}: ${e.message}`);
    }
  }

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      log('[bll captcha-relay] parado');
    },
  };
}

// Executa grecaptcha.execute no webview e retorna o token.
//
// ⚠️ A página BLL substitui o `Promise` global por Bluebird. O executeJavaScript
// do Electron só AGUARDA promises NATIVAS — uma promise Bluebird volta serializada
// como {_bitField:0} (não o token). Por isso NÃO retornamos promise daqui: o
// snippet dispara o mint e guarda o resultado em window.__bllCaptchaResult, e a
// gente POLLA esse valor (objeto simples, serializa OK). Mesmo padrão do auto-login.
async function executeRecaptcha(webContents, sitekey, action) {
  const kick = `(function () {
    window.__bllCaptchaResult = null;
    if (typeof grecaptcha === 'undefined') {
      window.__bllCaptchaResult = { error: 'grecaptcha undefined — webview não está em bllcompras.com ou script não carregou' };
      return 'no-grecaptcha';
    }
    try {
      grecaptcha.ready(function () {
        try {
          grecaptcha.execute(${JSON.stringify(sitekey)}, { action: ${JSON.stringify(action)} })
            .then(function (t) { window.__bllCaptchaResult = t ? { token: t } : { error: 'token vazio' }; })
            .catch(function (e) { window.__bllCaptchaResult = { error: 'execute: ' + (e && e.message || e) }; });
        } catch (e) { window.__bllCaptchaResult = { error: 'throw-ready: ' + (e && e.message || e) }; }
      });
    } catch (e) { window.__bllCaptchaResult = { error: 'throw: ' + (e && e.message || e) }; }
    return 'kicked';
  })();`;
  await webContents.executeJavaScript(kick, true);

  const deadline = Date.now() + EXECUTE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    let res;
    try { res = await webContents.executeJavaScript('window.__bllCaptchaResult', true); }
    catch (e) { continue; }
    if (res) {
      if (res.error) throw new Error(res.error);
      if (res.token) return res.token;
    }
  }
  throw new Error(`grecaptcha timeout ${EXECUTE_TIMEOUT_MS}ms (polling)`);
}

module.exports = { start };
