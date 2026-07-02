'use strict';

/**
 * portals/comprasnet/popup-mgr.js — Gerenciamento dos popups que o
 * Comprasnet abre durante login (auth, dispensa_eletronica, cnetmobile).
 *
 * Extraído de electron-browser.js (lines 532-650). Comportamento idêntico.
 *
 * Por que existe: hCaptcha invisible detecta acúmulo de janelas e desafia.
 * Solução: abrir popups OCULTOS (offscreen + skipTaskbar), limite de 3
 * simultâneos, auto-fechar após 5s. Os popups só servem pra capturar
 * Bearer via session interceptor — não precisam ser visíveis.
 *
 * Expõe global.__popupWindows como Proxy compatível com a API legada
 * (consumida pelos endpoints HTTP /popups, /exec-popup, /reload-popup,
 * /reload-all em electron-browser.js).
 *
 * Uso:
 *   require('./popup-mgr').install({ wvContents, ctx, registerBearerInterceptor });
 *
 * `ctx` precisa expor: log
 * `registerBearerInterceptor(session, label)` é o callback retornado por
 * bearer-interceptor.createRegister(...).
 */

const MAX_POPUPS = 3;

function install({ wvContents, ctx, registerBearerInterceptor }) {
  const log = ctx.log;
  const popupWindows = new Map(); // id → { webContents, window, url, openedAt }

  function cleanupExcessPopups() {
    if (popupWindows.size <= MAX_POPUPS) return;
    const sorted = [...popupWindows.entries()].sort((a, b) => a[1].openedAt - b[1].openedAt);
    const toClose = sorted.slice(0, popupWindows.size - MAX_POPUPS);
    for (const [id, info] of toClose) {
      try {
        log(`[Popups] Fechando popup antigo (id: ${id})`);
        if (info.window && !info.window.isDestroyed()) info.window.destroy();
        popupWindows.delete(id);
      } catch (e) { popupWindows.delete(id); }
    }
  }

  function closePopupsByUrl(pattern) {
    for (const [id, info] of popupWindows) {
      try {
        const currentUrl = info.webContents.getURL();
        if (currentUrl.includes(pattern)) {
          log(`[Popups] Fechando popup duplicado: ${pattern} (id: ${id})`);
          if (info.window && !info.window.isDestroyed()) info.window.destroy();
          popupWindows.delete(id);
        }
      } catch (e) { popupWindows.delete(id); }
    }
  }

  function gcPopups() {
    for (const [id, info] of popupWindows) {
      try {
        if (info.webContents.isDestroyed()) popupWindows.delete(id);
      } catch (e) { popupWindows.delete(id); }
    }
  }
  setInterval(gcPopups, 30000);

  wvContents.setWindowOpenHandler(({ url }) => {
    log(`[Popups] Requisição abrir: ${url.substring(0, 80)} (abertas: ${popupWindows.size}/${MAX_POPUPS})`);

    // Fechar popups anteriores do mesmo tipo pra evitar duplicados
    if (url.includes('dispensa_eletronica')) closePopupsByUrl('dispensa_eletronica');
    if (url.includes('cnetmobile')) closePopupsByUrl('cnetmobile');

    cleanupExcessPopups();

    // Permitir popup mas forçar OCULTO — nunca aparece na tela
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        show: false,
        skipTaskbar: true,
        x: -9999,
        y: -9999,
        width: 800,
        height: 600,
      },
    };
  });

  wvContents.on('did-create-window', (newWindow) => {
    const nwc = newWindow.webContents;
    const popupUrl = nwc.getURL() || 'about:blank';
    log(`[Popups] Popup criado OCULTO (id: ${nwc.id}, total: ${popupWindows.size + 1})`);

    newWindow.hide();
    newWindow.setSkipTaskbar(true);

    popupWindows.set(nwc.id, {
      webContents: nwc,
      window: newWindow,
      url: popupUrl,
      openedAt: Date.now(),
    });
    registerBearerInterceptor(nwc.session, `popup-${nwc.id}`);

    nwc.on('did-navigate', (event, url) => {
      log(`[Popups] Popup ${nwc.id} navegou: ${url.substring(0, 80)}`);
      const info = popupWindows.get(nwc.id);
      if (info) info.url = url;

      // Auto-fechar após 5s — popups só existem pra capturar Bearer
      setTimeout(() => {
        try {
          if (newWindow && !newWindow.isDestroyed()) {
            log(`[Popups] Auto-fechando popup ${nwc.id} (timeout 5s)`);
            newWindow.destroy();
          }
        } catch {}
      }, 5000);
    });

    nwc.on('destroyed', () => {
      popupWindows.delete(nwc.id);
      log(`[Popups] Popup ${nwc.id} destruído (restam: ${popupWindows.size})`);
    });

    cleanupExcessPopups();
  });

  // Expor pra API server (compat: Map de id → webContents)
  global.__popupWindows = new Proxy(popupWindows, {
    get(target, prop) {
      if (prop === 'get') return (id) => { const info = target.get(id); return info ? info.webContents : undefined; };
      if (prop === 'size') return target.size;
      if (prop === Symbol.iterator || prop === 'entries') {
        return function* () { for (const [id, info] of target) yield [id, info.webContents]; };
      }
      if (prop === 'keys') return target.keys.bind(target);
      return Reflect.get(target, prop);
    },
  });

  return { popupWindows, cleanupExcessPopups, closePopupsByUrl };
}

module.exports = {
  install,
  MAX_POPUPS,
};
