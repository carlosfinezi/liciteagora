'use strict';

/**
 * portals/comprasnet/index.js — Stub.
 *
 * Por enquanto não faz nada. O fluxo Comprasnet real continua inline em
 * ../../electron-browser.js durante as Fases 0/1. A partir da Fase 2A,
 * sub-módulos (auto-login, bearer-interceptor, popup-mgr) serão expostos
 * via init(ctx) e este index.js vira o entrypoint do portal.
 */

module.exports = {
  name: 'comprasnet',
  init(ctx) {
    // no-op — implementação inline em electron-browser.js
  },
};
