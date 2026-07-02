'use strict';

/**
 * portals/comprasnet/fetch.js — Fetch helper que executa no CONTEXTO do
 * webview (preserva cookies SSO da sessão Chromium) injetando JS via
 * executeJavaScript. Usa o Bearer atual + headers SERPRO esperados.
 *
 * Extraído de electron-browser.js (lines ~601-640 originais).
 *
 * Por que não fazer fetch direto via Node.js https?
 *   - Comprasnet exige cookies de sessão (ASPSESSIONID*) que vivem no
 *     jar do Chromium do webview, não no Node.
 *   - Bearer sozinho não basta — algumas rotas exigem cookie de sessão.
 *   - Replicar o jar inteiro no Node é frágil. Mais simples deixar o
 *     browser fazer o fetch dele mesmo.
 *
 * Uso:
 *   const fetch = require('./fetch').create({ ctx });
 *   const r = await fetch('/comprasnet-fase-externa/v1/...', 'GET');
 *
 * `ctx` precisa expor: getWebview(), getBearer()
 *
 * IMPORTANTE: o body é interpolado via `${bodyStr.replace(/'/g, "\\'")}`
 * — escape ingênuo de aspas simples. Mantive como estava no original.
 * Pra payloads complexos com aspas/backticks/template literals em strings
 * pode quebrar; é aceitável pro uso atual (payloads pequenos JSON).
 */

const CNET_BASE = 'https://cnetmobile.estaleiro.serpro.gov.br';

function create({ ctx }) {
  return async function comprasnetFetch(apiPath, method = 'GET', body = null) {
    const wv = ctx.getWebview();
    if (!wv) throw new Error('Webview não disponível');

    const bearer = ctx.getBearer();
    const bodyStr = body ? JSON.stringify(body) : 'null';

    const result = await wv.executeJavaScript(`
      (async () => {
        try {
          const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'x-device-platform': 'web',
            'x-version-number': '6.0.0',
          };
          ${bearer ? `headers['Authorization'] = '${bearer}';` : ''}

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
  };
}

module.exports = {
  create,
  CNET_BASE,
};
