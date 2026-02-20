/**
 * LiciteAgora Token Relay — Background Service Worker (MV3)
 * v2.1 — Captura Bearer token + hCaptcha token automaticamente
 * 
 * O Comprasnet usa 2 tokens:
 *   1. Bearer token (header Authorization) → para APIs /comprasnet-disputa/
 *   2. hCaptcha token (query param ?captcha=) → para APIs /mensagem/, /fase-externa/
 * 
 * Ambos são interceptados das requisições do Comprasnet e enviados ao servidor.
 */

const SERVER_URL = 'http://217.216.85.37:8080';

console.log('[TokenRelay] Service worker v2.1 carregado! Servidor:', SERVER_URL);

// ==================== STORAGE ====================

async function loadStorage() {
  return new Promise(resolve => {
    chrome.storage.local.get(null, data => resolve(data || {}));
  });
}

async function save(obj) {
  return new Promise(resolve => {
    chrome.storage.local.set(obj, resolve);
  });
}

// ==================== INTERCEPTAÇÃO ====================

try {
  chrome.webRequest.onSendHeaders.addListener(
    async (details) => {
      try {
        if (!details.requestHeaders) return;

        let bearer = null;
        let captcha = null;

        // 1. Capturar Bearer do header Authorization
        for (const h of details.requestHeaders) {
          if (h.name.toLowerCase() === 'authorization' && h.value && h.value.startsWith('Bearer ')) {
            bearer = h.value;
            break;
          }
        }

        // 2. Capturar captcha token da URL
        try {
          const url = new URL(details.url);
          const captchaParam = url.searchParams.get('captcha');
          if (captchaParam && captchaParam.startsWith('P1_')) {
            captcha = captchaParam;
          }
        } catch (e) {}

        // Processar o que encontrou
        if (bearer || captcha) {
          await onTokensCapturados(bearer, captcha);
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
  console.error('[TokenRelay] FALHA com extraHeaders, tentando fallback:', e);
  try {
    chrome.webRequest.onSendHeaders.addListener(
      async (details) => {
        try {
          if (!details.requestHeaders) return;
          let bearer = null;
          let captcha = null;
          for (const h of details.requestHeaders) {
            if (h.name.toLowerCase() === 'authorization' && h.value && h.value.startsWith('Bearer ')) {
              bearer = h.value;
              break;
            }
          }
          try {
            const url = new URL(details.url);
            const captchaParam = url.searchParams.get('captcha');
            if (captchaParam && captchaParam.startsWith('P1_')) captcha = captchaParam;
          } catch (e) {}
          if (bearer || captcha) await onTokensCapturados(bearer, captcha);
        } catch (e) {
          console.error('[TokenRelay] Erro no listener:', e);
        }
      },
      { urls: ['https://cnetmobile.estaleiro.serpro.gov.br/*'] },
      ['requestHeaders']
    );
    console.log('[TokenRelay] Listener registrado SEM extraHeaders (fallback)');
  } catch (e2) {
    console.error('[TokenRelay] FALHA total:', e2);
  }
}

// ==================== PROCESSAMENTO ====================

async function onTokensCapturados(bearer, captcha) {
  const data = await loadStorage();
  const agora = Date.now();
  const stats = data.stats || { capturados: 0, enviados: 0, erros: 0 };
  let mudou = false;

  // Atualizar Bearer
  if (bearer && bearer !== data.ultimoToken) {
    stats.capturados++;
    await save({ ultimoToken: bearer, stats });
    console.log('[TokenRelay] NOVO Bearer capturado:', bearer.substring(0, 30) + '...');
    mudou = true;
  }

  // Atualizar Captcha
  if (captcha && captcha !== data.ultimoCaptcha) {
    await save({ ultimoCaptcha: captcha, captchaEm: agora });
    console.log('[TokenRelay] NOVO Captcha capturado:', captcha.substring(0, 30) + '...');
    mudou = true;
  }

  // Enviar se mudou algo OU se passou >60s desde último envio
  if (mudou || agora - (data.ultimoEnvio || 0) > 60000) {
    // Reler storage com dados atualizados
    const atual = await loadStorage();
    const statsAtual = atual.stats || stats;
    await enviarParaServidor(
      atual.ultimoToken || bearer,
      atual.ultimoCaptcha || captcha,
      statsAtual
    );
  }
}

// ==================== ENVIO ====================

async function enviarParaServidor(bearer, captcha, stats) {
  if (!bearer) {
    console.log('[TokenRelay] Sem Bearer, não envia');
    return false;
  }

  const url = SERVER_URL + '/api/auth/token';

  try {
    const body = {
      token: bearer,
      timestamp: new Date().toISOString(),
      source: 'extension',
    };

    // Incluir captcha se disponível
    if (captcha) {
      body.captchaToken = captcha;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      stats.enviados++;
      await save({ stats, ultimoEnvio: Date.now(), ultimoErro: null });
      console.log('[TokenRelay] ✅ Tokens enviados (bearer' + (captcha ? '+captcha' : '') + ')');
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
      return true;
    } else {
      const text = await resp.text().catch(() => '');
      stats.erros++;
      await save({ stats, ultimoErro: 'HTTP ' + resp.status + ': ' + text.substring(0, 100) });
      console.error('[TokenRelay] ❌ Servidor:', resp.status, text.substring(0, 100));
      chrome.action.setBadgeText({ text: String(resp.status) });
      chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
      return false;
    }
  } catch (e) {
    stats.erros++;
    await save({ stats, ultimoErro: e.message });
    console.error('[TokenRelay] ❌ Rede:', e.message);
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
    return false;
  }
}

// ==================== MENSAGENS DO POPUP ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(e => {
    sendResponse({ ok: false, error: e.message });
  });
  return true;
});

async function handleMessage(msg) {
  const data = await loadStorage();

  switch (msg.type) {
    case 'getStatus':
      return {
        serverUrl: SERVER_URL,
        ultimoToken: data.ultimoToken ? data.ultimoToken.substring(0, 40) + '...' : null,
        ultimoCaptcha: data.ultimoCaptcha ? data.ultimoCaptcha.substring(0, 30) + '...' : null,
        captchaIdade: data.captchaEm ? Math.floor((Date.now() - data.captchaEm) / 1000) + 's' : null,
        ultimoEnvio: data.ultimoEnvio ? new Date(data.ultimoEnvio).toLocaleTimeString() : null,
        ultimoErro: data.ultimoErro || null,
        stats: data.stats || { capturados: 0, enviados: 0, erros: 0 },
      };

    case 'resetStats':
      await save({ stats: { capturados: 0, enviados: 0, erros: 0 }, ultimoErro: null });
      return { ok: true };

    default:
      return { ok: false, error: 'Tipo desconhecido: ' + msg.type };
  }
}
