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

  // Se captcha novo, triggar sync imediato
  if (captcha && captcha !== data.captcha) {
    console.log('[LiciteAgora] Captcha novo → sync imediato');
    setTimeout(() => executarSync(), 2000);
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

// ==================== DATA SYNC (browser → Comprasnet API → server) ====================

/**
 * Faz GET autenticado ao Comprasnet direto do browser.
 * Vantagem: mesmo IP = captcha válido.
 */
async function comprasnetGet(path, bearer, captcha) {
  const sep = path.includes('?') ? '&' : '?';
  const url = COMPRASNET + path + (captcha ? sep + 'captcha=' + captcha : '');

  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Authorization': bearer,
      'x-device-platform': 'web',
      'x-version-number': '5.5.2',
      'Cache-Control': 'no-cache',
    },
  });

  return { status: resp.status, data: resp.status === 200 || resp.status === 206 ? await resp.json() : null };
}

/**
 * Envia dados ao servidor LiciteAgora.
 */
async function serverPost(path, body) {
  const resp = await fetch(SERVER_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.ok ? await resp.json() : null;
}

/**
 * Sync completo: participações + mensagens.
 */
async function executarSync() {
  const data = await load();
  if (!data.bearer || !data.captcha) {
    console.log('[LiciteAgora] Sync pulado — falta bearer ou captcha');
    return;
  }

  const stats = data.stats || { capturados: 0, enviados: 0, erros: 0, syncs: 0 };
  console.log('[LiciteAgora] ═══ Início sync ═══');

  try {
    // 1. Buscar participações
    const participacoes = await syncParticipacoes(data.bearer, data.captcha);

    // 2. Buscar mensagens das participações ativas
    if (participacoes.length > 0) {
      await syncMensagens(participacoes, data.bearer, data.captcha);
    }

    stats.syncs = (stats.syncs || 0) + 1;
    await save({ stats, ultimoSync: Date.now() });

    console.log('[LiciteAgora] ═══ Sync completo ═══');
  } catch (e) {
    console.error('[LiciteAgora] Erro no sync:', e.message);
    await save({ ultimoErro: 'Sync: ' + e.message });
  }
}

async function syncParticipacoes(bearer, captcha) {
  console.log('[LiciteAgora] Buscando participações...');
  let todas = [];
  let pagina = 0;

  while (true) {
    try {
      const { status, data } = await comprasnetGet(
        `/comprasnet-fase-externa/v1/compras/participacoes?filtro=5&tamanhoPagina=50&pagina=${pagina}`,
        bearer, captcha
      );

      if (status !== 200 && status !== 206) {
        console.log('[LiciteAgora] Participações pág ' + pagina + ': HTTP ' + status);
        break;
      }
      if (!data || !Array.isArray(data) || data.length === 0) break;

      todas = todas.concat(data);
      pagina++;
      if (data.length < 50) break;
    } catch (e) {
      console.error('[LiciteAgora] Erro participações:', e.message);
      break;
    }
  }

  if (todas.length > 0) {
    console.log('[LiciteAgora] ' + todas.length + ' participações encontradas, enviando ao servidor...');
    await serverPost('/api/sync/participacoes', { participacoes: todas });
  } else {
    console.log('[LiciteAgora] Nenhuma participação retornada');
  }

  return todas;
}

async function syncMensagens(participacoes, bearer, captcha) {
  // Extrair compraIds únicos
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
      const { status, data } = await comprasnetGet(
        `/comprasnet-mensagem/v2/chat/${compraId}?size=20&page=0&legadoAsp=false`,
        bearer, captcha
      );

      if ((status === 200 || status === 206) && Array.isArray(data) && data.length > 0) {
        const result = await serverPost('/api/sync/mensagens', {
          compraId,
          mensagens: data,
        });
        if (result && result.novas > 0) {
          totalNovas += result.novas;
          console.log('[LiciteAgora] ' + compraId + ': ' + result.novas + ' novas');
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
