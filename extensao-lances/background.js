// Service Worker da extensão de lances

// Listener para mensagens
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'notificar') {
    // Cria notificação do Chrome
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon128.png',
      title: message.titulo || 'Lances Comprasnet',
      message: message.mensagem || '',
      priority: 2
    });
  }

  if (message.action === 'abrirPagina') {
    chrome.tabs.create({ url: message.url });
  }

  return true;
});

// Quando a extensão é instalada
chrome.runtime.onInstalled.addListener(() => {
  console.log('Extensão Lances Comprasnet instalada');

  // Inicializa configuração padrão
  chrome.storage.local.get(['lanceConfig'], (result) => {
    if (!result.lanceConfig) {
      chrome.storage.local.set({
        lanceConfig: {
          modo: 'valor',
          cobertura: 0.01,
          minimo: null
        }
      });
    }
  });
});

// ==================== PROXY FETCH PARA CONTENT SCRIPTS ====================
// Evita bloqueio de Mixed Content quando content script roda em página HTTPS
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'serverFetch') {
    fetch(request.url, request.options || {})
      .then(async (res) => {
        const body = await res.text();
        sendResponse({ ok: res.ok, status: res.status, statusText: res.statusText, body });
      })
      .catch((err) => {
        sendResponse({ ok: false, status: 0, statusText: err.message, body: '' });
      });
    return true;
  }
});

// Listener para quando uma aba é atualizada
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    if (tab.url.includes('cnetmobile.estaleiro.serpro.gov.br')) {
      // Injeta badge indicando que está na página correta
      chrome.action.setBadgeText({ text: 'ON', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#4caf50', tabId });
    } else {
      chrome.action.setBadgeText({ text: '', tabId });
    }
  }
});
