/**
 * LiciteAgora Token Relay — Background Service Worker
 * 
 * Intercepta requisições ao Comprasnet, captura o Bearer token
 * e envia ao servidor LiciteAgora automaticamente.
 */

const COMPRASNET_PATTERNS = [
  'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-*'
];

// Estado
let ultimoToken = null;
let ultimoEnvio = 0;
let serverUrl = '';
let stats = { capturados: 0, enviados: 0, erros: 0 };

// Carregar config salva
chrome.storage.local.get(['serverUrl', 'stats'], (data) => {
  if (data.serverUrl) serverUrl = data.serverUrl;
  if (data.stats) stats = data.stats;
});

// ==================== INTERCEPTAÇÃO ====================

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Procurar header Authorization
    const authHeader = details.requestHeaders?.find(
      h => h.name.toLowerCase() === 'authorization'
    );

    if (authHeader && authHeader.value?.startsWith('Bearer ')) {
      const token = authHeader.value; // "Bearer xxx..."
      
      if (token !== ultimoToken) {
        ultimoToken = token;
        stats.capturados++;
        chrome.storage.local.set({ stats });
        
        console.log('[TokenRelay] Novo Bearer capturado:', token.substring(0, 30) + '...');
        
        // Enviar pro servidor
        enviarToken(token);
        
        // Atualizar ícone
        chrome.action.setBadgeText({ text: '✓' });
        chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
      } else {
        // Mesmo token, reenviar se passou mais de 60s
        const agora = Date.now();
        if (agora - ultimoEnvio > 60000) {
          enviarToken(token);
        }
      }
    }
  },
  { urls: COMPRASNET_PATTERNS },
  ['requestHeaders']
);

// ==================== ENVIO AO SERVIDOR ====================

async function enviarToken(token) {
  if (!serverUrl) {
    console.log('[TokenRelay] Servidor não configurado');
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
      ultimoEnvio = Date.now();
      stats.enviados++;
      chrome.storage.local.set({ stats, ultimoEnvio });
      
      console.log('[TokenRelay] Token enviado ao servidor ✅');
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
    } else {
      stats.erros++;
      chrome.storage.local.set({ stats });
      console.error('[TokenRelay] Servidor rejeitou:', response.status);
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
    }
  } catch (e) {
    stats.erros++;
    chrome.storage.local.set({ stats });
    console.error('[TokenRelay] Erro ao enviar:', e.message);
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
  }
}

// ==================== MENSAGENS DO POPUP ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    sendResponse({
      serverUrl,
      ultimoToken: ultimoToken ? ultimoToken.substring(0, 30) + '...' : null,
      ultimoEnvio: ultimoEnvio ? new Date(ultimoEnvio).toLocaleTimeString() : null,
      stats,
    });
  }
  
  if (msg.type === 'setServer') {
    serverUrl = msg.url.replace(/\/+$/, ''); // remove trailing slash
    chrome.storage.local.set({ serverUrl });
    sendResponse({ ok: true });
    
    // Se já tem token, enviar agora
    if (ultimoToken) enviarToken(ultimoToken);
  }

  if (msg.type === 'forceSync') {
    if (ultimoToken) {
      enviarToken(ultimoToken);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'Nenhum token capturado. Abra o Comprasnet primeiro.' });
    }
  }

  if (msg.type === 'resetStats') {
    stats = { capturados: 0, enviados: 0, erros: 0 };
    chrome.storage.local.set({ stats });
    sendResponse({ ok: true });
  }

  return true; // Keep message channel open for async
});
