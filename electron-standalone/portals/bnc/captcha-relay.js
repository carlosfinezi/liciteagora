'use strict';

/**
 * portals/bnc/captcha-relay.js — Polla o servidor por pedidos de token
 * reCAPTCHA v3 e executa grecaptcha.execute(sitekey, {action}) no webview da
 * sala BNC, devolvendo o resultado pro servidor.
 *
 * Quando o motor de disputa server-side (bnc-dispute-engine) precisa enviar
 * um PerformBid, ele chama bnc-captcha-bridge.requestToken({action}). Esse
 * pedido entra numa fila no servidor. Esse relay aqui:
 *
 *   1) GET /api/electron/bnc/captcha-pending a cada 1s
 *   2) Se vem { id, action, sitekey }: executa grecaptcha.execute no webview
 *   3) POST /api/electron/bnc/captcha-token com { id, token } (ou { id, error })
 *
 * Requisitos:
 *   - webview deve estar com bnccompras.com carregado (qualquer página com
 *     reCAPTCHA inicializado — sala /BatchList já tem grecaptcha v3 carregado)
 *   - usuário deve estar logado (cookie de sessão BNC presente)
 *
 * Falhas comuns:
 *   - grecaptcha indefinido → webview não está em bnccompras.com OU
 *     scripts ainda não carregaram. Reportamos erro pro servidor que rejeita
 *     a Promise da engine — engine pode retentar.
 *   - timeout no execute → Google indisponível ou IP bloqueado.
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

  log('[captcha-relay] iniciando (poll a cada 1s)');

  function schedule() {
    if (stopped) return;
    timer = setTimeout(loop, POLL_INTERVAL_MS);
  }

  async function loop() {
    if (stopped || inFlight) { schedule(); return; }
    inFlight = true;
    try {
      const r = await request('GET', '/api/electron/bnc/captcha-pending');
      if (!r || !r.id) { return; }  // sem pedido pendente
      const { id, action, sitekey } = r;
      log(`[captcha-relay] pedido id=${id.slice(0, 8)} action=${action} ageMs=${r.ageMs || 0}`);

      const wv = ctx.getWebview();
      if (!wv) {
        await postResult(id, null, 'webview indisponível');
        return;
      }

      try {
        const token = await executeRecaptcha(wv, sitekey, action);
        log(`[captcha-relay] token len=${(token || '').length} action=${action}`);
        await postResult(id, token, null);
      } catch (e) {
        log(`[captcha-relay] erro grecaptcha: ${e.message}`);
        await postResult(id, null, e.message || String(e));
      }
    } catch (e) {
      log(`[captcha-relay] poll erro: ${e.message}`);
    } finally {
      inFlight = false;
      schedule();
    }
  }

  // serverBridge.request é o helper baixo nível em portals/bnc/server-bridge.js
  // — não tem método pronto pra cada endpoint do bridge, vamos invocar via
  // o request genérico exposto.
  async function request(method, path, body) {
    // serverBridge não expõe `request()` diretamente — vamos chamar via uma
    // façade construída em init(). Aqui assumimos que serverBridge.requestRaw
    // existe (vamos adicionar).
    if (typeof serverBridge.requestRaw === 'function') {
      const r = await serverBridge.requestRaw(method, path, body);
      if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
      return r.body;
    }
    throw new Error('serverBridge.requestRaw não disponível');
  }

  async function postResult(id, token, error) {
    try {
      await request('POST', '/api/electron/bnc/captcha-token', { id, token, error });
    } catch (e) {
      log(`[captcha-relay] postResult falhou id=${id.slice(0, 8)}: ${e.message}`);
    }
  }

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      log('[captcha-relay] parado');
    },
  };
}

// Executa grecaptcha.execute no webview e retorna o token.
async function executeRecaptcha(webContents, sitekey, action) {
  const js = `(function () {
    return new Promise((resolve, reject) => {
      if (typeof grecaptcha === 'undefined') {
        return reject(new Error('grecaptcha undefined — webview não está em bnccompras.com ou script ainda não carregou'));
      }
      const start = Date.now();
      try {
        grecaptcha.ready(function () {
          grecaptcha.execute(${JSON.stringify(sitekey)}, { action: ${JSON.stringify(action)} })
            .then(function (t) {
              if (!t) return reject(new Error('token vazio'));
              resolve(t);
            })
            .catch(function (e) { reject(new Error('execute: ' + (e && e.message || e))); });
        });
        setTimeout(() => reject(new Error('grecaptcha timeout ${EXECUTE_TIMEOUT_MS}ms')), ${EXECUTE_TIMEOUT_MS});
      } catch (e) {
        reject(new Error('throw: ' + (e && e.message || e)));
      }
    });
  })();`;
  return await webContents.executeJavaScript(js, true);
}

module.exports = { start };
