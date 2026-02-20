/**
 * LiciteAgora Token Relay — Background Service Worker (MV3)
 * 
 * Intercepta requisições ao Comprasnet, captura o Bearer token
 * e envia ao servidor LiciteAgora automaticamente.
 * 
 * NOTA MV3: Service worker pode ser encerrado a qualquer momento.
 * Todo estado deve ser persistido em chrome.storage.local.
 */

const COMPRASNET_PATTERNS = [
  'https://cnetmobile.estaleiro.serpro.gov.br/*'
];

// ==================== STORAGE HELPERS ====================

async function getState() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      ['serverUrl', 'ultimoToken', 'ultimoEnvio', 'stats'],
      (data) => resolve({
        serverUrl: data.serverUrl || '',
        ultimoToken: data.ultimoToken || null,
        ultimoEnvio: data.ultimoEnvio || 0,
        stats: data.stats || { capturados: 0, enviados: 0, erros: 0 },
      })
    );
  });
}

async function saveState(partial) {
  return new Promise(resolve => {
    chrome.storage.local.set(partial, resolve);
  });
}

// ==================== INTERCEPTAÇÃO ====================

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const authHeader = details.requestHeaders?.find(
      h => h.name.toLowerCase() === 'authorization'
    );

    if (authHeader && authHeader.value?.startsWith('Bearer ')) {
      const token = authHeader.value;
      handleToken(token);
    }
  },
  { urls: COMPRASNET_PATTERNS },
  ['requestHeaders', 'extraHeaders']  // extraHeaders é OBRIGATÓRIO no MV3 para ver Authorization
);

async function handleToken(token) {
  const state = await getState();

  if (token !== state.ultimoToken) {
    // Novo token
    state.stats.capturados++;
    await saveState({
      ultimoToken: token,
      stats: state.stats,
    });
    console.log('[TokenRelay] Novo Bearer capturado:', token.substring(0, 30) + '...');
    
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });

    await enviarToken(token, state.serverUrl, state.stats);
  } else {
    // Mesmo token — reenviar se passou mais de 60s
    if (Date.now() - state.ultimoEnvio > 60000) {
      await enviarToken(token, state.serverUrl, state.stats);
    }
  }
}

// ==================== ENVIO AO SERVIDOR ====================

async function enviarToken(token, serverUrl, stats) {
  if (!serverUrl) {
    console.log('[TokenRelay] Servidor não configurado — token armazenado localmente');
    chrome.action.setBadgeText({ text: '⚙' });
    chrome.action.setBadgeBackgroundColor({ color: '#ff9800' });
    return;
  }

  try {
    const response = await fetch(`${serverUrl}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: token,
        timestamp: new Date().toISOString(),
        source: 'extension',
      }),
    });

    if (response.ok) {
      stats.enviados++;
      await saveState({ stats, ultimoEnvio: Date.now() });
      console.log('[TokenRelay] Token enviado ao servidor ✅');
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
    } else {
      const text = await response.text().catch(() => '');
      stats.erros++;
      await saveState({ stats });
      console.error('[TokenRelay] Servidor rejeitou:', response.status, text.substring(0, 100));
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
    }
  } catch (e) {
    stats.erros++;
    await saveState({ stats });
    console.error('[TokenRelay] Erro ao enviar:', e.message);
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
  }
}

// ==================== MENSAGENS DO POPUP ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Tudo async — retorna true pra manter canal aberto
  (async () => {
    try {
      if (msg.type === 'getStatus') {
        const state = await getState();
        sendResponse({
          serverUrl: state.serverUrl,
          ultimoToken: state.ultimoToken ? state.ultimoToken.substring(0, 40) + '...' : null,
          ultimoEnvio: state.ultimoEnvio ? new Date(state.ultimoEnvio).toLocaleTimeString() : null,
          stats: state.stats,
        });
      }

      else if (msg.type === 'setServer') {
        const url = (msg.url || '').replace(/\/+$/, '');
        await saveState({ serverUrl: url });
        console.log('[TokenRelay] Servidor configurado:', url);
        sendResponse({ ok: true });

        // Se já tem token, enviar agora
        const state = await getState();
        if (state.ultimoToken && url) {
          await enviarToken(state.ultimoToken, url, state.stats);
        }
      }

      else if (msg.type === 'forceSync') {
        const state = await getState();
        if (state.ultimoToken) {
          await enviarToken(state.ultimoToken, state.serverUrl, state.stats);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Nenhum token capturado. Navegue no Comprasnet primeiro.' });
        }
      }

      else if (msg.type === 'resetStats') {
        await saveState({ stats: { capturados: 0, enviados: 0, erros: 0 } });
        sendResponse({ ok: true });
      }

      else {
        sendResponse({ ok: false, error: 'Tipo desconhecido: ' + msg.type });
      }
    } catch (e) {
      console.error('[TokenRelay] Erro no handler:', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true; // Mantém canal aberto para async
});
