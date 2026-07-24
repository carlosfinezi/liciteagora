// bnc-cookie-sync.js — captura cookies de bnccompras.com da Electron session
// e envia ao servidor liciteagora via POST /api/electron/bnc/cookies.
//
// Estratégia:
//   - Hook em ses.cookies.on('changed') filtrando domain=bnccompras.com pra
//     detectar mudanças relevantes (login, refresh de sessão)
//   - Debounce 5s antes de coletar TODOS os cookies do host e enviar
//   - Skip se nenhum cookie de sessão real (precisa ter mais que o reCAPTCHA do Google)
//
// Cookies enviados como string "name1=value1; name2=value2; ..." (formato
// compatível com Cookie header HTTP).

'use strict';

const SYNC_DEBOUNCE_MS = 5000;
const MIN_AGE_BETWEEN_SYNCS_MS = 30 * 1000; // não spammar servidor

function start({ session, serverBridge, log, getCurrentUserEmail }) {
  let debounceTimer = null;
  let lastSyncAt = 0;
  let lastCookieFingerprint = null;

  async function coletarEEnviar() {
    debounceTimer = null;
    try {
      // Coleta cookies do domínio bnccompras (e subdomínios .bnccompras.com)
      const all = await session.cookies.get({ domain: 'bnccompras.com' });
      const dot = await session.cookies.get({ domain: '.bnccompras.com' });
      // Mescla, dedupe por (name+path+domain)
      const seen = new Set();
      const merged = [];
      for (const c of [...all, ...dot]) {
        const k = `${c.name}|${c.path}|${c.domain}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(c);
      }
      // Filtra cookies ASP.NET/sessão. Heurística: nome contém ASP, AspNet, session, .auth, etc.
      // Mas pra robustez, envia TODOS exceto os obviamente irrelevantes (google analytics).
      const relevantes = merged.filter(c => {
        const n = c.name.toLowerCase();
        if (n.startsWith('_ga') || n.startsWith('_gid') || n.startsWith('_gat')) return false;
        if (n.startsWith('_fbp') || n === 'gads') return false;
        return true;
      });

      if (relevantes.length === 0) {
        log('[cookie-sync] sem cookies relevantes ainda — pulando');
        return;
      }

      const cookieStr = relevantes.map(c => `${c.name}=${c.value}`).join('; ');
      const fingerprint = cookieStr; // simples; muda se algum valor mudar

      if (fingerprint === lastCookieFingerprint && Date.now() - lastSyncAt < MIN_AGE_BETWEEN_SYNCS_MS) {
        log('[cookie-sync] fingerprint inalterado e sync recente — skip');
        return;
      }

      const email = typeof getCurrentUserEmail === 'function' ? getCurrentUserEmail() : null;
      await serverBridge.sendCookies({ cookie: cookieStr, usuario: email });
      lastSyncAt = Date.now();
      lastCookieFingerprint = fingerprint;
      log(`[cookie-sync] enviou ${relevantes.length} cookies pro servidor (user=${email || '?'})`);
    } catch (e) {
      log(`[cookie-sync] erro: ${e.message}`);
    }
  }

  function agendarSync(motivo) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(coletarEEnviar, SYNC_DEBOUNCE_MS);
    log(`[cookie-sync] agendado (${motivo}) em ${SYNC_DEBOUNCE_MS}ms`);
  }

  // Hook de mudança de cookie. cause = 'explicit' | 'overwrite' | 'expired' | 'evicted' | 'expired-overwrite'
  session.cookies.on('changed', (event, cookie, cause, removed) => {
    // Só nos importa bnccompras
    const dom = (cookie.domain || '').toLowerCase();
    if (!dom.includes('bnccompras.com')) return;
    if (removed) {
      log(`[cookie-sync] cookie removido: ${cookie.name} (${cause})`);
      return;
    }
    agendarSync(`change:${cookie.name}/${cause}`);
  });

  // Sync inicial passado 10s (após carregamento da página)
  setTimeout(() => agendarSync('start'), 10000);

  return {
    forceSync: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      return coletarEEnviar();
    },
  };
}

module.exports = { start };
