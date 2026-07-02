'use strict';

/**
 * portals/comprasnet/api-handlers.js — Endpoints HTTP do API server local
 * (porta 9500) que são Comprasnet-específicos.
 *
 * Extraído de electron-browser.js (lines ~715-844 originais). Comportamento
 * idêntico ao código inline anterior.
 *
 * Endpoints cobertos:
 *   GET  /popups          lista popups abertos (id, url, title)
 *   POST /exec-popup      { id, js } → executeJavaScript no popup
 *   POST /fetch           { path, method, body } → comprasnetFetch
 *   POST /reload-popup    { id } → reload de popup específico
 *   POST /reload-all      reload de webview + todos popups
 *   POST /login           { cpf, senha } → autoLoginModule.autoLogin (background)
 *
 * Não cobertos (portal-agnósticos, ficam em electron-browser.js):
 *   /status /bearer /api-log /logs /navigate /exec /reload /check-update
 *   /download-update /apply-update
 *
 * Padrão de uso (router-style):
 *   const handlers = require('./api-handlers').create({
 *     ctx, autoLoginModule, comprasnetFetch, readBody
 *   });
 *   const handled = await handlers.tryHandle(req, res, url);
 *   if (handled) return;
 *   // ...resto dos handlers no electron-browser.js
 *
 * `ctx` precisa expor: getWebview(), log
 */

function create({ ctx, autoLoginModule, comprasnetFetch, readBody }) {
  const { log } = ctx;

  function popupsMap() {
    return global.__popupWindows || new Map();
  }

  async function handlePopupsList(req, res) {
    const popups = popupsMap();
    const list = [];
    for (const [id, nwc] of popups) {
      try {
        list.push({ id, url: nwc.getURL(), title: nwc.getTitle() });
      } catch (e) {
        list.push({ id, error: e.message });
      }
    }
    res.writeHead(200);
    res.end(JSON.stringify(list));
  }

  async function handleExecPopup(req, res) {
    const body = await readBody(req);
    const { id, js } = JSON.parse(body);
    const popups = popupsMap();
    const nwc = popups.get(id);
    if (!nwc) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Popup não encontrado', available: [...popups.keys()] }));
      return;
    }
    try {
      const result = await nwc.executeJavaScript(js);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  async function handleFetch(req, res) {
    const body = await readBody(req);
    const { path: apiPath, method, body: reqBody } = JSON.parse(body);
    const result = await comprasnetFetch(apiPath, method || 'GET', reqBody);
    res.writeHead(200);
    res.end(JSON.stringify(result));
  }

  async function handleReloadPopup(req, res) {
    const body = await readBody(req);
    const { id } = JSON.parse(body);
    const popups = popupsMap();
    const nwc = popups.get(id);
    if (!nwc) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Popup não encontrado', available: [...popups.keys()] }));
      return;
    }
    nwc.reload();
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, id, url: nwc.getURL() }));
  }

  async function handleReloadAll(req, res) {
    const popups = popupsMap();
    const reloaded = [];
    for (const [id, nwc] of popups) {
      try { nwc.reload(); reloaded.push({ id, url: nwc.getURL() }); } catch {}
    }
    const wv = ctx.getWebview();
    if (wv) { wv.reload(); reloaded.push({ id: 'webview', url: wv.getURL() }); }
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, reloaded }));
  }

  async function handleLogin(req, res) {
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
    autoLoginModule.autoLogin(cpf, senha).catch(e => log(`Login erro: ${e.message}`));
  }

  // Dispatcher: retorna true se um handler casou e respondeu o request.
  async function tryHandle(req, res, url) {
    const p = url.pathname;
    if (p === '/popups' && req.method === 'GET') { await handlePopupsList(req, res); return true; }
    if (p === '/exec-popup' && req.method === 'POST') { await handleExecPopup(req, res); return true; }
    if (p === '/fetch' && req.method === 'POST') { await handleFetch(req, res); return true; }
    if (p === '/reload-popup' && req.method === 'POST') { await handleReloadPopup(req, res); return true; }
    if (p === '/reload-all' && req.method === 'POST') { await handleReloadAll(req, res); return true; }
    if (p === '/login' && req.method === 'POST') { await handleLogin(req, res); return true; }
    return false;
  }

  return { tryHandle };
}

module.exports = { create };
