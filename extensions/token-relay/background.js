/**
 * LiciteAgora Token Relay — Background Service Worker (MV3)
 * v1.2 — Simplificado e defensivo
 */

console.log('[TokenRelay] Service worker carregado!');

// ==================== STORAGE ====================

async function loadStorage() {
  return new Promise(resolve => {
    chrome.storage.local.get(null, data => {
      resolve(data || {});
    });
  });
}

async function save(obj) {
  return new Promise(resolve => {
    chrome.storage.local.set(obj, resolve);
  });
}

// ==================== INTERCEPTAÇÃO ====================

try {
  // onSendHeaders — lê headers DEPOIS de enviados (read-only, mais confiável)
  chrome.webRequest.onSendHeaders.addListener(
    async (details) => {
      try {
        if (!details.requestHeaders) return;

        for (const h of details.requestHeaders) {
          if (h.name.toLowerCase() === 'authorization' && h.value && h.value.startsWith('Bearer ')) {
            await onTokenCapturado(h.value);
            break;
          }
        }
      } catch (e) {
        console.error('[TokenRelay] Erro no listener:', e);
      }
    },
    { urls: ['https://cnetmobile.estaleiro.serpro.gov.br/*'] },
    ['requestHeaders', 'extraHeaders']
  );
  console.log('[TokenRelay] Listener webRequest registrado OK');
} catch (e) {
  console.error('[TokenRelay] FALHA ao registrar listener:', e);
  // Tentar sem extraHeaders como fallback
  try {
    chrome.webRequest.onSendHeaders.addListener(
      async (details) => {
        try {
          if (!details.requestHeaders) return;
          for (const h of details.requestHeaders) {
            if (h.name.toLowerCase() === 'authorization' && h.value && h.value.startsWith('Bearer ')) {
              await onTokenCapturado(h.value);
              break;
            }
          }
        } catch (e) {
          console.error('[TokenRelay] Erro no listener:', e);
        }
      },
      { urls: ['https://cnetmobile.estaleiro.serpro.gov.br/*'] },
      ['requestHeaders']
    );
    console.log('[TokenRelay] Listener registrado SEM extraHeaders (fallback)');
  } catch (e2) {
    console.error('[TokenRelay] FALHA total no listener:', e2);
  }
}

async function onTokenCapturado(token) {
  const data = await loadStorage();
  const agora = Date.now();
  const stats = data.stats || { capturados: 0, enviados: 0, erros: 0 };

  if (token !== data.ultimoToken) {
    stats.capturados++;
    await save({ ultimoToken: token, stats });
    console.log('[TokenRelay] NOVO token capturado:', token.substring(0, 30) + '...');

    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });

    if (data.serverUrl) {
      await enviarParaServidor(token, data.serverUrl, stats);
    }
  } else if (data.serverUrl && agora - (data.ultimoEnvio || 0) > 60000) {
    // Mesmo token mas >60s — reenviar
    await enviarParaServidor(token, data.serverUrl, stats);
  }
}

// ==================== ENVIO ====================

async function enviarParaServidor(token, serverUrl, stats) {
  if (!serverUrl) {
    console.log('[TokenRelay] Sem servidor configurado');
    return false;
  }

  const url = serverUrl.replace(/\/+$/, '') + '/api/auth/token';
  console.log('[TokenRelay] Enviando token para:', url);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: token,
        timestamp: new Date().toISOString(),
        source: 'extension',
      }),
    });

    if (resp.ok) {
      stats.enviados++;
      await save({ stats, ultimoEnvio: Date.now() });
      console.log('[TokenRelay] ✅ Token enviado com sucesso');
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
      return true;
    } else {
      const body = await resp.text().catch(() => '');
      stats.erros++;
      await save({ stats, ultimoErro: `HTTP ${resp.status}: ${body.substring(0, 100)}` });
      console.error('[TokenRelay] ❌ Servidor respondeu:', resp.status, body.substring(0, 100));
      chrome.action.setBadgeText({ text: String(resp.status) });
      chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
      return false;
    }
  } catch (e) {
    stats.erros++;
    await save({ stats, ultimoErro: e.message });
    console.error('[TokenRelay] ❌ Erro de rede:', e.message);
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
    return false;
  }
}

// ==================== MENSAGENS DO POPUP ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[TokenRelay] Mensagem recebida:', msg.type);

  handleMessage(msg).then(sendResponse).catch(e => {
    console.error('[TokenRelay] Erro handler:', e);
    sendResponse({ ok: false, error: e.message });
  });

  return true; // manter canal aberto
});

async function handleMessage(msg) {
  const data = await loadStorage();

  switch (msg.type) {
    case 'getStatus':
      return {
        serverUrl: data.serverUrl || '',
        ultimoToken: data.ultimoToken ? data.ultimoToken.substring(0, 40) + '...' : null,
        ultimoEnvio: data.ultimoEnvio ? new Date(data.ultimoEnvio).toLocaleTimeString() : null,
        ultimoErro: data.ultimoErro || null,
        stats: data.stats || { capturados: 0, enviados: 0, erros: 0 },
      };

    case 'setServer': {
      const url = (msg.url || '').trim().replace(/\/+$/, '');
      await save({ serverUrl: url });
      console.log('[TokenRelay] Servidor salvo:', url);

      // Enviar token existente
      if (data.ultimoToken && url) {
        const stats = data.stats || { capturados: 0, enviados: 0, erros: 0 };
        const ok = await enviarParaServidor(data.ultimoToken, url, stats);
        return { ok: true, enviou: ok };
      }
      return { ok: true, enviou: false };
    }

    case 'forceSync': {
      if (!data.ultimoToken) {
        return { ok: false, error: 'Nenhum token capturado. Navegue no Comprasnet primeiro.' };
      }
      if (!data.serverUrl) {
        return { ok: false, error: 'Servidor não configurado.' };
      }
      const stats = data.stats || { capturados: 0, enviados: 0, erros: 0 };
      const ok = await enviarParaServidor(data.ultimoToken, data.serverUrl, stats);
      return { ok };
    }

    case 'resetStats':
      await save({ stats: { capturados: 0, enviados: 0, erros: 0 }, ultimoErro: null });
      return { ok: true };

    default:
      return { ok: false, error: 'Tipo desconhecido: ' + msg.type };
  }
}
