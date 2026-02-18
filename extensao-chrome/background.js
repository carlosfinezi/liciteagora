// Monitor Comprasnet - Background Service Worker v4.7
// Funciona em segundo plano para manter sessão ativa

const SERVER_URL = '__SERVER_URL__';
const COMPRASNET_URL = 'https://cnetmobile.estaleiro.serpro.gov.br';
const KEEP_ALIVE_ALARM = 'keep-alive-comprasnet';
const KEEP_ALIVE_MINUTES = 3; // A cada 3 minutos

let estatisticas = {
  mensagensCapturadas: 0,
  licitacoesMonitoradas: new Set(),
  ultimaCaptura: null,
  sessaoAtiva: false,
  ultimoKeepAlive: null
};

// ==================== KEEP-ALIVE EM SEGUNDO PLANO ====================

// Configura o alarme de keep-alive
async function configurarKeepAlive() {
  // Remove alarme existente
  await chrome.alarms.clear(KEEP_ALIVE_ALARM);

  // Cria novo alarme que dispara a cada X minutos
  chrome.alarms.create(KEEP_ALIVE_ALARM, {
    delayInMinutes: 1, // Primeira execução em 1 minuto
    periodInMinutes: KEEP_ALIVE_MINUTES
  });

  console.log(`[Keep-Alive] Configurado para executar a cada ${KEEP_ALIVE_MINUTES} minutos`);

  // Salva estado
  await chrome.storage.local.set({ keepAliveAtivo: true });
}

// Para o keep-alive
async function pararKeepAlive() {
  await chrome.alarms.clear(KEEP_ALIVE_ALARM);
  await chrome.storage.local.set({ keepAliveAtivo: false });
  console.log('[Keep-Alive] Parado');
}

// Executa o keep-alive - faz ping no Comprasnet para manter sessão
async function executarKeepAlive() {
  console.log('[Keep-Alive] Executando...');

  try {
    // Tenta fazer uma requisição para o Comprasnet
    const response = await fetch(`${COMPRASNET_URL}/comprasnet-web/seguro/fornecedor/compras`, {
      method: 'HEAD',
      credentials: 'include',
      mode: 'no-cors' // Evita problemas de CORS
    });

    estatisticas.ultimoKeepAlive = new Date().toISOString();
    estatisticas.sessaoAtiva = true;

    // Atualiza badge para indicar que está ativo
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });

    console.log('[Keep-Alive] Sessão mantida ativa');

    // Notifica o servidor local
    await fetch(`${SERVER_URL}/api/chat/navegacao`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo: 'keep_alive',
        timestamp: new Date().toISOString(),
        status: 'ativo'
      })
    }).catch(() => {});

    return true;
  } catch (error) {
    console.log('[Keep-Alive] Erro:', error.message);

    // Pode ser que a sessão expirou
    estatisticas.sessaoAtiva = false;

    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });

    return false;
  }
}

// Verifica se há uma aba do Comprasnet aberta e injeta script de keep-alive
async function verificarAbaComprasnet() {
  try {
    const tabs = await chrome.tabs.query({ url: `${COMPRASNET_URL}/*` });

    if (tabs.length > 0) {
      // Há uma aba do Comprasnet aberta - envia mensagem para content script
      for (const tab of tabs) {
        try {
          await chrome.tabs.sendMessage(tab.id, { action: 'keepAlive' });
        } catch (e) {
          // Tab pode não ter o content script
        }
      }
      return true;
    }
    return false;
  } catch (error) {
    console.log('[Keep-Alive] Erro ao verificar abas:', error.message);
    return false;
  }
}

// Listener para o alarme
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === KEEP_ALIVE_ALARM) {
    // Primeiro tenta via aba existente (mais confiável)
    const temAba = await verificarAbaComprasnet();

    if (temAba) {
      console.log('[Keep-Alive] Usando aba existente do Comprasnet');
    } else {
      // Se não tem aba, tenta fazer fetch direto (pode não funcionar devido a cookies)
      await executarKeepAlive();
    }
  }
});

// ==================== MENSAGENS DO CONTENT SCRIPT ====================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Abre nova aba quando content script precisa (coordenação entre extensões)
  if (request.action === 'abrirPagina') {
    chrome.tabs.create({ url: request.url });
    return;
  }

  if (request.type === 'MENSAGENS_ENVIADAS') {
    estatisticas.mensagensCapturadas += request.count;
    estatisticas.ultimaCaptura = new Date().toISOString();
    if (request.licitacao) {
      estatisticas.licitacoesMonitoradas.add(request.licitacao.compraId);
    }

    chrome.action.setBadgeText({ text: String(estatisticas.mensagensCapturadas) });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Mensagens Capturadas',
      message: `${request.count} mensagem(ns) enviada(s) para o servidor`
    });

  } else if (request.type === 'MONITORAMENTO_INICIADO') {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#2196F3' });

  } else if (request.type === 'SESSAO_ATIVA') {
    // Content script confirmou que a sessão está ativa
    estatisticas.sessaoAtiva = true;
    estatisticas.ultimoKeepAlive = new Date().toISOString();

  } else if (request.type === 'SESSAO_EXPIRADA') {
    estatisticas.sessaoAtiva = false;
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f44336' });

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Sessão Expirada',
      message: 'Faça login novamente no Comprasnet'
    });

  } else if (request.type === 'GET_STATS') {
    sendResponse({
      mensagensCapturadas: estatisticas.mensagensCapturadas,
      licitacoesMonitoradas: estatisticas.licitacoesMonitoradas.size,
      ultimaCaptura: estatisticas.ultimaCaptura,
      sessaoAtiva: estatisticas.sessaoAtiva,
      ultimoKeepAlive: estatisticas.ultimoKeepAlive
    });
  }

  return true;
});

// ==================== VERIFICAÇÃO DO SERVIDOR ====================

async function verificarServidor() {
  try {
    const response = await fetch(`${SERVER_URL}/api/chat/status`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function atualizarStatusServidor() {
  const online = await verificarServidor();
  if (!online) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
  }
}

// ==================== INICIALIZAÇÃO ====================

// Quando a extensão é instalada ou atualizada
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Monitor Comprasnet] Extensão instalada/atualizada');
  await configurarKeepAlive();
});

// Quando o service worker inicia
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Monitor Comprasnet] Chrome iniciado');
  await configurarKeepAlive();
});

// Verifica o servidor periodicamente
setInterval(atualizarStatusServidor, 60000);

// Configura keep-alive na inicialização
configurarKeepAlive();

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

console.log('[Monitor Comprasnet] Background service worker v4.7 iniciado');
