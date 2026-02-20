/**
 * LiciteAgora Token Relay + Data Sync — Background Service Worker (MV3)
 * v3.0 — Captura tokens E busca dados do Comprasnet direto do browser
 * 
 * Fluxo:
 *   1. Intercepta Bearer + hCaptcha tokens das requisições
 *   2. Envia tokens ao servidor LiciteAgora
 *   3. Periodicamente busca participações e mensagens da API Comprasnet
 *      (usando o IP do browser — captcha é IP-bound)
 *   4. Envia resultados ao servidor para armazenamento
 */

const SERVER_URL = 'http://217.216.85.37:8080';
const COMPRASNET = 'https://cnetmobile.estaleiro.serpro.gov.br';
const SYNC_INTERVAL_MIN = 3; // sync a cada 3 minutos
let syncAgendado = false;

console.log('[LiciteAgora] Service worker v3.0 carregado!');

// ==================== STORAGE ====================

async function load() {
  return new Promise(r => chrome.storage.local.get(null, d => r(d || {})));
}
async function save(obj) {
  return new Promise(r => chrome.storage.local.set(obj, r));
}

// ==================== INTERCEPTAÇÃO DE TOKENS ====================

try {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      let bearer = null;
      let captcha = null;

      if (details.requestHeaders) {
        for (const h of details.requestHeaders) {
          if (h.name.toLowerCase() === 'authorization' && h.value && h.value.startsWith('Bearer ')) {
            bearer = h.value;
            break;
          }
        }
      }

      try {
        const url = new URL(details.url);
        const c = url.searchParams.get('captcha');
        if (c && c.startsWith('P1_')) captcha = c;
      } catch (e) {}

      if (bearer || captcha) {
        onTokensCapturados(bearer, captcha);
      }
    },
    { urls: [COMPRASNET + '/*'] },
    ['requestHeaders', 'extraHeaders']
  );
  console.log('[LiciteAgora] Listener registrado OK');
} catch (e) {
  // Fallback sem extraHeaders
  try {
    chrome.webRequest.onSendHeaders.addListener(
      (details) => {
        let bearer = null, captcha = null;
        if (details.requestHeaders) {
          for (const h of details.requestHeaders) {
            if (h.name.toLowerCase() === 'authorization' && h.value && h.value.startsWith('Bearer ')) {
              bearer = h.value; break;
            }
          }
        }
        try {
          const url = new URL(details.url);
          const c = url.searchParams.get('captcha');
          if (c && c.startsWith('P1_')) captcha = c;
        } catch (e) {}
        if (bearer || captcha) onTokensCapturados(bearer, captcha);
      },
      { urls: [COMPRASNET + '/*'] },
      ['requestHeaders']
    );
  } catch (e2) {
    console.error('[LiciteAgora] FALHA total listener:', e2);
  }
}

async function onTokensCapturados(bearer, captcha) {
  const data = await load();
  const agora = Date.now();
  const stats = data.stats || { capturados: 0, enviados: 0, erros: 0, syncs: 0 };
  let mudou = false;

  if (bearer && bearer !== data.bearer) {
    stats.capturados++;
    await save({ bearer, stats });
    console.log('[LiciteAgora] Novo Bearer:', bearer.substring(0, 30) + '...');
    mudou = true;
  }

  if (captcha && captcha !== data.captcha) {
    await save({ captcha, captchaEm: agora });
    console.log('[LiciteAgora] Novo Captcha:', captcha.substring(0, 25) + '...');
    mudou = true;
  }

  // Enviar tokens ao servidor
  if (mudou || agora - (data.ultimoEnvio || 0) > 60000) {
    const atual = await load();
    await enviarTokens(atual.bearer || bearer, atual.captcha || captcha, atual.stats || stats);
  }

  // Sync imediato somente uma vez por sessão do service worker
  if (bearer && !syncAgendado) {
    syncAgendado = true;
    console.log('[LiciteAgora] Bearer capturado → sync em 3s');
    setTimeout(() => executarSync(), 3000);
  }
}

async function enviarTokens(bearer, captcha, stats) {
  if (!bearer) return;
  try {
    const body = { token: bearer, source: 'extension', timestamp: new Date().toISOString() };
    if (captcha) body.captchaToken = captcha;

    const resp = await fetch(SERVER_URL + '/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      stats.enviados++;
      await save({ stats, ultimoEnvio: Date.now(), ultimoErro: null });
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
    } else {
      stats.erros++;
      const text = await resp.text().catch(() => '');
      await save({ stats, ultimoErro: 'HTTP ' + resp.status });
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
    }
  } catch (e) {
    stats.erros++;
    await save({ stats, ultimoErro: e.message });
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
  }
}

// ==================== DATA SYNC (via tab injection — same cookies) ====================

/**
 * Encontra uma aba aberta no Comprasnet.
 */
async function findComprasnetTab() {
  const tabs = await chrome.tabs.query({ url: 'https://cnetmobile.estaleiro.serpro.gov.br/*' });
  return tabs.length > 0 ? tabs[0] : null;
}

/**
 * Executa fetch DENTRO da aba do Comprasnet (usa cookies da sessão).
 * Gera captcha FRESCO via hcaptcha.execute() a cada chamada.
 */
async function comprasnetFetch(tabId, path, bearer) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (apiPath, authHeader, baseUrl) => {
      try {
        // 1. Gerar captcha fresco
        var captchaToken = '';
        try {
          if (typeof hcaptcha !== 'undefined') {
            var result = await hcaptcha.execute({ async: true });
            captchaToken = result.response || '';
          }
        } catch (e) {
          // Se hcaptcha não estiver na página, tenta sem
          console.log('[LiciteAgora] hcaptcha indisponível:', e.message);
        }

        // 2. Montar URL
        var sep = apiPath.includes('?') ? '&' : '?';
        var url = baseUrl + apiPath + (captchaToken ? sep + 'captcha=' + captchaToken : '');

        // 3. Fazer fetch
        var resp = await fetch(url, {
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Authorization': authHeader,
            'x-device-platform': 'web',
            'x-version-number': '5.5.2',
            'Cache-Control': 'no-cache',
          },
        });

        var text = await resp.text();
        var data = null;
        try { data = JSON.parse(text); } catch (e) {}
        return { status: resp.status, data: data, hasCaptcha: !!captchaToken };
      } catch (e) {
        return { status: 0, error: e.message };
      }
    },
    args: [path, bearer, COMPRASNET],
  });

  return results[0]?.result || { status: 0, error: 'No result' };
}

/**
 * Envia dados ao servidor LiciteAgora.
 */
async function serverPost(path, body) {
  try {
    const resp = await fetch(SERVER_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.ok ? await resp.json() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Sync completo: participações + mensagens.
 */
async function executarSync() {
  const data = await load();
  if (!data.bearer) {
    console.log('[LiciteAgora] Sync pulado — falta bearer');
    return;
  }

  const tab = await findComprasnetTab();
  if (!tab) {
    console.log('[LiciteAgora] Sync pulado — nenhuma aba do Comprasnet aberta');
    return;
  }

  const stats = data.stats || { capturados: 0, enviados: 0, erros: 0, syncs: 0 };
  console.log('[LiciteAgora] ═══ Início sync (tab ' + tab.id + ') ═══');

  try {
    // 1. Buscar participações
    const participacoes = await syncParticipacoes(tab.id, data.bearer);

    // 2. Buscar mensagens das participações
    if (participacoes.length > 0) {
      await syncMensagens(tab.id, participacoes, data.bearer);
    }

    stats.syncs = (stats.syncs || 0) + 1;
    await save({ stats, ultimoSync: Date.now() });
    console.log('[LiciteAgora] ═══ Sync completo ═══');
  } catch (e) {
    console.error('[LiciteAgora] Erro no sync:', e.message);
    await save({ ultimoErro: 'Sync: ' + e.message });
  }
}

async function syncParticipacoes(tabId, bearer) {
  console.log('[LiciteAgora] Buscando participações...');
  let todas = [];
  let pagina = 0;

  while (true) {
    try {
      const result = await comprasnetFetch(tabId,
        '/comprasnet-fase-externa/v1/compras/participacoes?filtro=5&tamanhoPagina=50&pagina=' + pagina,
        bearer
      );

      if (result.status !== 200 && result.status !== 206) {
        console.log('[LiciteAgora] Participações pág ' + pagina + ': HTTP ' + result.status + (result.hasCaptcha ? ' (com captcha)' : ' (SEM captcha!)'));
        break;
      }
      if (!result.data || !Array.isArray(result.data) || result.data.length === 0) break;

      todas = todas.concat(result.data);
      pagina++;
      if (result.data.length < 50) break;
    } catch (e) {
      console.error('[LiciteAgora] Erro participações:', e.message);
      break;
    }
  }

  if (todas.length > 0) {
    // Debug: mostrar estrutura do primeiro item
    console.log('[LiciteAgora] Estrutura participação[0]:', JSON.stringify(todas[0]).substring(0, 500));
    console.log('[LiciteAgora] ' + todas.length + ' participações encontradas, enviando ao servidor...');
    const resp = await serverPost('/api/sync/participacoes', { participacoes: todas });
    if (resp) {
      console.log('[LiciteAgora] Servidor: ' + (resp.inseridas || 0) + ' novas, ' + (resp.atualizadas || 0) + ' atualizadas');
    }
  } else {
    console.log('[LiciteAgora] Nenhuma participação retornada');
  }

  return todas;
}

async function syncMensagens(tabId, participacoes, bearer) {
  const compraIds = [];
  for (const p of participacoes) {
    const compra = p.compra || p;
    const id = compra.compraId;
    if (id && !compraIds.includes(id)) compraIds.push(id);
  }

  console.log('[LiciteAgora] Buscando mensagens de ' + compraIds.length + ' licitações...');
  let totalNovas = 0;

  for (const compraId of compraIds) {
    try {
      const result = await comprasnetFetch(tabId,
        '/comprasnet-mensagem/v2/chat/' + compraId + '?size=20&page=0&legadoAsp=false',
        bearer
      );

      if ((result.status === 200 || result.status === 206) && Array.isArray(result.data) && result.data.length > 0) {
        const resp = await serverPost('/api/sync/mensagens', {
          compraId,
          mensagens: result.data,
        });
        if (resp && resp.novas > 0) {
          totalNovas += resp.novas;
          console.log('[LiciteAgora] ' + compraId + ': ' + resp.novas + ' novas');
        }
      }
    } catch (e) {
      // Skip silently
    }
  }

  if (totalNovas > 0) {
    console.log('[LiciteAgora] Total: ' + totalNovas + ' novas mensagens');
  }
}

// ==================== PERIODIC SYNC via chrome.alarms ====================

chrome.alarms.create('sync', { periodInMinutes: SYNC_INTERVAL_MIN });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') {
    executarSync();
  }
});

// ==================== POPUP MESSAGES ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(e => {
    sendResponse({ ok: false, error: e.message });
  });
  return true;
});

async function handleMessage(msg) {
  const data = await load();

  switch (msg.type) {
    case 'getStatus':
      return {
        serverUrl: SERVER_URL,
        bearer: data.bearer ? data.bearer.substring(0, 40) + '...' : null,
        captcha: data.captcha ? data.captcha.substring(0, 25) + '...' : null,
        captchaIdade: data.captchaEm ? Math.floor((Date.now() - data.captchaEm) / 1000) + 's' : null,
        ultimoEnvio: data.ultimoEnvio ? new Date(data.ultimoEnvio).toLocaleTimeString() : null,
        ultimoSync: data.ultimoSync ? new Date(data.ultimoSync).toLocaleTimeString() : null,
        ultimoErro: data.ultimoErro || null,
        stats: data.stats || { capturados: 0, enviados: 0, erros: 0, syncs: 0 },
      };

    case 'forceSync':
      executarSync();
      return { ok: true, message: 'Sync iniciado' };

    case 'resetStats':
      await save({ stats: { capturados: 0, enviados: 0, erros: 0, syncs: 0 }, ultimoErro: null });
      return { ok: true };

    default:
      return { ok: false, error: 'Tipo desconhecido' };
  }
}
