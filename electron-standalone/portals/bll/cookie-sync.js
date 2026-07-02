'use strict';

/**
 * portals/bll/cookie-sync.js — Captura cookies de bllcompras.com da Electron
 * session e envia ao servidor LiciteAgora via POST /api/electron/bll/cookies
 * (servidor armazena na config do tenant pra que bll-client.js consuma em
 * fetches autenticados server-side: carregarItens/enviarProposta).
 *
 * Clone de portals/bnc/cookie-sync.js — só muda o host (bllcompras.com) e o
 * prefixo de log. Mesma estratégia:
 *   - Hook em ses.cookies.on('changed') filtrando bllcompras.com
 *   - Debounce 5s antes de coletar TODOS os cookies do host e enviar
 *   - Skip se nenhum cookie de sessão real
 *   - Skip se fingerprint inalterado E sync recente (< 30s)
 *
 * Cookies enviados como string "name1=value1; name2=value2; ..." (formato
 * compatível com header Cookie HTTP).
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
      const all = await session.cookies.get({ domain: 'bllcompras.com' });
      const dot = await session.cookies.get({ domain: '.bllcompras.com' });
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
        log('[cookie-sync BLL] sem cookies relevantes ainda — pulando');
        return;
      }

      const cookieStr = relevantes.map(c => `${c.name}=${c.value}`).join('; ');
      const fingerprint = cookieStr;

      if (fingerprint === lastCookieFingerprint && Date.now() - lastSyncAt < MIN_AGE_BETWEEN_SYNCS_MS) {
        log('[cookie-sync BLL] fingerprint inalterado e sync recente — skip');
        return;
      }

      const email = typeof getCurrentUserEmail === 'function' ? getCurrentUserEmail() : null;
      await serverBridge.sendCookies({ cookie: cookieStr, usuario: email });
      lastSyncAt = Date.now();
      lastCookieFingerprint = fingerprint;
      log(`[cookie-sync BLL] enviou ${relevantes.length} cookies pro servidor (user=${email || '?'})`);
    } catch (e) {
      log(`[cookie-sync BLL] erro: ${e.message}`);
    }
  }

  function agendarSync(motivo) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(coletarEEnviar, SYNC_DEBOUNCE_MS);
    log(`[cookie-sync BLL] agendado (${motivo}) em ${SYNC_DEBOUNCE_MS}ms`);
  }

  session.cookies.on('changed', (event, cookie, cause, removed) => {
    const dom = (cookie.domain || '').toLowerCase();
    if (!dom.includes('bllcompras.com')) return;
    if (removed) {
      log(`[cookie-sync BLL] cookie removido: ${cookie.name} (${cause})`);
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
