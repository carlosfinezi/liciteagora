'use strict';

/**
 * portals/bnc/cookie-sync.js — Captura cookies de bnccompras.com da
 * Electron session e envia ao servidor LiciteAgora via
 * POST /api/electron/bnc/cookies (servidor armazena na config do tenant
 * pra que bnc-client.js consuma em fetches autenticados server-side).
 *
 * Portado de electron-bnc/bnc-cookie-sync.js. Comportamento idêntico.
 *
 * Estratégia:
 *   - Hook em ses.cookies.on('changed') filtrando bnccompras.com pra
 *     detectar login/refresh
 *   - Debounce 5s antes de coletar TODOS os cookies do host e enviar
 *   - Skip se nenhum cookie de sessão real
 *   - Skip se fingerprint inalterado E sync recente (< 30s)
 *
 * Cookies enviados como string "name1=value1; name2=value2; ..." (formato
 * compatível com header Cookie HTTP).
 *
 * Uso:
 *   const handle = require('./cookie-sync').start({
 *     session, serverBridge, log, getCurrentUserEmail
 *   });
 *   handle.forceSync();  // força ciclo imediato (pós-login bem-sucedido)
 */

const SYNC_DEBOUNCE_MS = 5000;
const MIN_AGE_BETWEEN_SYNCS_MS = 30 * 1000;

function start({ session, serverBridge, log, getCurrentUserEmail }) {
  let debounceTimer = null;
  let lastSyncAt = 0;
  let lastCookieFingerprint = null;

  async function coletarEEnviar() {
    debounceTimer = null;
    try {
      const all = await session.cookies.get({ domain: 'bnccompras.com' });
      const dot = await session.cookies.get({ domain: '.bnccompras.com' });
      const seen = new Set();
      const merged = [];
      for (const c of [...all, ...dot]) {
        const k = `${c.name}|${c.path}|${c.domain}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(c);
      }
      const relevantes = merged.filter(c => {
        const n = c.name.toLowerCase();
        if (n.startsWith('_ga') || n.startsWith('_gid') || n.startsWith('_gat')) return false;
        if (n.startsWith('_fbp') || n === 'gads') return false;
        return true;
      });

      if (relevantes.length === 0) {
        log('[cookie-sync BNC] sem cookies relevantes ainda — pulando');
        return;
      }

      const cookieStr = relevantes.map(c => `${c.name}=${c.value}`).join('; ');
      const fingerprint = cookieStr;

      if (fingerprint === lastCookieFingerprint && Date.now() - lastSyncAt < MIN_AGE_BETWEEN_SYNCS_MS) {
        log('[cookie-sync BNC] fingerprint inalterado e sync recente — skip');
        return;
      }

      const email = typeof getCurrentUserEmail === 'function' ? getCurrentUserEmail() : null;
      await serverBridge.sendCookies({ cookie: cookieStr, usuario: email });
      lastSyncAt = Date.now();
      lastCookieFingerprint = fingerprint;
      log(`[cookie-sync BNC] enviou ${relevantes.length} cookies pro servidor (user=${email || '?'})`);
    } catch (e) {
      log(`[cookie-sync BNC] erro: ${e.message}`);
    }
  }

  function agendarSync(motivo) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(coletarEEnviar, SYNC_DEBOUNCE_MS);
    log(`[cookie-sync BNC] agendado (${motivo}) em ${SYNC_DEBOUNCE_MS}ms`);
  }

  // Hook de mudança de cookie. cause = 'explicit' | 'overwrite' | 'expired' | 'evicted' | ...
  session.cookies.on('changed', (event, cookie, cause, removed) => {
    const dom = (cookie.domain || '').toLowerCase();
    if (!dom.includes('bnccompras.com')) return;
    if (removed) {
      log(`[cookie-sync BNC] cookie removido: ${cookie.name} (${cause})`);
      return;
    }
    agendarSync(`change:${cookie.name}/${cause}`);
  });

  // Sync inicial passados 10s (após carregamento da página)
  setTimeout(() => agendarSync('start'), 10000);

  return {
    forceSync: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      return coletarEEnviar();
    },
  };
}

module.exports = { start };
