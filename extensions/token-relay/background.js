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
let SERVER_API_KEY = ''; // carregado do storage
const COMPRASNET = 'https://cnetmobile.estaleiro.serpro.gov.br';
const SYNC_INTERVAL_MIN = 2; // sync a cada 2 minutos
const KEEPALIVE_INTERVAL_MIN = 2; // keepalive a cada 2 minutos
const TOKEN_MAX_AGE_MS = 540000; // 9 min (margem de segurança; Comprasnet expira em 10)
let syncAgendado = false;
let syncEmExecucao = false;
let aguardandoNovoBearer = false; // flag: reload feito, esperando novo token
let ssoMorto = false; // flag: SSO confirmado como morto, parar de tentar até novo bearer

console.log('[LiciteAgora] Service worker v3.16.0 carregado!');

// Carregar API key do storage ao iniciar
chrome.storage.local.get('serverApiKey', (d) => {
  if (d.serverApiKey) SERVER_API_KEY = d.serverApiKey;
});

function serverHeaders(extra) {
  const h = { 'Content-Type': 'application/json' };
  if (SERVER_API_KEY) h['X-Api-Key'] = SERVER_API_KEY;
  return Object.assign(h, extra || {});
}

// ==================== STORAGE ====================

async function load() {
  return new Promise(r => chrome.storage.local.get(null, d => r(d || {})));
}
async function save(obj) {
  return new Promise(r => chrome.storage.local.set(obj, r));
}

// ==================== HELPERS DE TOKEN ====================

/**
 * Verifica se o bearer token está velho demais (> 9 min).
 * Retorna true se o token é válido e fresco.
 */
async function tokenEstaFresco() {
  const data = await load();
  if (!data.bearer || !data.ultimoEnvio) return false;
  return (Date.now() - data.ultimoEnvio) < TOKEN_MAX_AGE_MS;
}

/**
 * Verifica se a sessão SSO do Comprasnet ainda está ativa.
 * Usa HEAD com redirect:manual — se redirecionar para login, sessão morreu.
 */
async function verificarSessaoSSO() {
  try {
    const response = await fetch(
      COMPRASNET + '/comprasnet-web/seguro/fornecedor/compras',
      { method: 'HEAD', credentials: 'include', redirect: 'manual' }
    );
    // opaqueredirect = redirecionou para SSO login
    if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) {
      console.log('[LiciteAgora] Sessão SSO expirada (status=' + response.status + ', type=' + response.type + ')');
      return false;
    }
    return true;
  } catch (e) {
    console.log('[LiciteAgora] Erro verificando SSO:', e.message);
    // Em caso de erro de rede, assume ativa para não travar
    return true;
  }
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
    await save({ bearer, stats, bearerTimestamp: agora });
    // Salvar compras-id da aba ativa para renovacao futura
    try {
      var tabs = await chrome.tabs.query({ url: "https://cnetmobile.estaleiro.serpro.gov.br/*" });
      if (tabs.length > 0) {
        var m = tabs[0].url && tabs[0].url.match(/compras-id=([a-f0-9-]{36})/i);
        if (m) { await save({ comprasId: m[1] }); console.log("[LiciteAgora] compras-id salvo: " + m[1].substring(0,8) + "..."); }
      }
    } catch(e3) {}
    console.log('[LiciteAgora] Novo Bearer:', bearer.substring(0, 30) + '...');
    mudou = true;
    // Limpar flag SSO morto — novo bearer significa sessão renovada
    if (ssoMorto) {
      ssoMorto = false;
      chrome.action.setBadgeText({ text: '' });
      console.log('[LiciteAgora] ✅ SSO recuperado — novo bearer recebido');
    }
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

  // Pós-reload: novo bearer chegou, enviar imediatamente e fazer sync
  if (bearer && aguardandoNovoBearer) {
    aguardandoNovoBearer = false;
    console.log('[LiciteAgora] ✅ Novo bearer recebido pós-reload → sync imediato');
    const atual = await load();
    await enviarTokens(atual.bearer || bearer, atual.captcha || captcha, atual.stats || stats);
    setTimeout(() => executarSync(), 2000);
    return;
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
      headers: serverHeaders(),
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

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Executa fetch DENTRO da aba do Comprasnet (usa cookies da sessão).
 * Gera captcha FRESCO via hcaptcha.execute() a cada chamada.
 */
async function comprasnetFetch(tabId, path, bearer) {
  try {
    if (!await tabExists(tabId)) {
      return { status: 0, error: 'Tab closed' };
    }
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout 30s')), 30000));
    const exec = chrome.scripting.executeScript({
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
            'x-version-number': '6.0.0',
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

    const results = await Promise.race([exec, timeout]);
    return results[0]?.result || { status: 0, error: 'No result from tab' };
  } catch (e) {
    console.error('[LiciteAgora] comprasnetFetch ERRO:', path.substring(0, 60), e.message);
    // Aba aberta antes da extensão — recarregar para ganhar permissão
    if (e.message && e.message.indexOf('Cannot access') >= 0) {
      console.log('[LiciteAgora] ⚠️ Sem permissão na aba — recarregando para corrigir...');
      try { await chrome.tabs.reload(tabId); } catch (e2) {}
    }
    return { status: 0, error: e.message };
  }
}

/**
 * POST autenticado no Comprasnet VIA BROWSER (mesmo IP = token válido).
 * Usado para enviar lances.
 */
async function comprasnetPost(tabId, path, bearer, body) {
  try {
    if (!await tabExists(tabId)) {
      return { status: 0, error: 'Tab closed' };
    }
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout 15s')), 15000));
    const exec = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (apiPath, authHeader, baseUrl, postBody) => {
        try {
          var resp = await fetch(baseUrl + apiPath, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'Authorization': authHeader,
              'Content-Type': 'application/json',
              'x-device-platform': 'web',
              'x-version-number': '6.0.0',
            },
            body: JSON.stringify(postBody),
          });
          var text = await resp.text();
          var data = null;
          try { data = JSON.parse(text); } catch (e) {}
          return { status: resp.status, data: data, text: text.substring(0, 500) };
        } catch (e) {
          return { status: 0, error: e.message };
        }
      },
      args: [path, bearer, COMPRASNET, body],
    });

    const results = await Promise.race([exec, timeout]);
    return results[0]?.result || { status: 0, error: 'No result from tab' };
  } catch (e) {
    console.error('[LiciteAgora] comprasnetPost ERRO:', path.substring(0, 60), e.message);
    return { status: 0, error: e.message };
  }
}

/**
 * PUT retoken no Comprasnet VIA BROWSER — renova o JWT sem recarregar a aba.
 * Endpoint: PUT /comprasnet-usuario/v2/sessao/fornecedor/retoken
 * Retorna novo accessToken se a sessão SSO ainda estiver válida.
 */
async function comprasnetRetoken(tabId, bearer) {
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout 10s")), 10000));
    const exec = chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (accessToken, baseUrl) => {
        try {
          // O SPA envia o refreshToken (nao o accessToken) no header do retoken
          var refreshToken = sessionStorage.getItem("refreshToken");
          var authHeader = refreshToken ? ("Bearer " + refreshToken) : accessToken;
          var resp = await fetch(baseUrl + "/comprasnet-usuario/v2/sessao/fornecedor/retoken", {
            method: "PUT",
            credentials: "include",
            headers: {
              "Accept": "application/json, text/plain, */*",
              "Authorization": authHeader,
              "x-device-platform": "web",
              "x-version-number": "6.0.0",
            },
          });
          var text = await resp.text();
          var data = null;
          try { data = JSON.parse(text); } catch (e) {}
          return { status: resp.status, data: data, usouRefreshToken: !!refreshToken };
        } catch (e) {
          return { status: 0, error: e.message };
        }
      },
      args: [bearer, COMPRASNET],
    });
    const results = await Promise.race([exec, timeout]);
    var r = results[0]?.result || { status: 0, error: "No result from tab" };
    if (r.usouRefreshToken) console.log("[LiciteAgora] comprasnetRetoken usou refreshToken do sessionStorage");
    return r;
  } catch (e) {
    console.error("[LiciteAgora] comprasnetRetoken ERRO:", e.message);
    return { status: 0, error: e.message };
  }
}

/**
 * Envia dados ao servidor LiciteAgora.
 */
async function serverPost(path, body) {
  try {
    const resp = await fetch(SERVER_URL + path, {
      method: 'POST',
      headers: serverHeaders(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('[LiciteAgora] serverPost ' + path + ' → HTTP ' + resp.status + ': ' + text.substring(0, 100));
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error('[LiciteAgora] serverPost ' + path + ' FALHOU:', e.message);
    return null;
  }
}

/**
 * Sync completo: participações + mensagens.
 */
async function executarSync() {
  if (syncEmExecucao) {
    console.log('[LiciteAgora] Sync já em execução, pulando');
    return;
  }
  syncEmExecucao = true;

  if (ssoMorto) {
    console.log('[LiciteAgora] Sync pulado — SSO morto, aguardando login manual');
    syncEmExecucao = false;
    return;
  }

  const data = await load();
  if (!data.bearer) {
    console.log('[LiciteAgora] Sync pulado — falta bearer');
    syncEmExecucao = false;
    return;
  }

  // Verificar idade do token antes de gastar requests
  if (!await tokenEstaFresco()) {
    console.log('[LiciteAgora] Sync pulado — token velho (>' + (TOKEN_MAX_AGE_MS/60000) + 'min), aguardando renovação');
    // Forçar keepalive para tentar renovar
    executarKeepalive();
    syncEmExecucao = false;
    return;
  }

  // Pular sync se há lances contínuos na fila (não gastar bearer com sync)
  try {
    var filaResp = await fetch(SERVER_URL + '/api/sniper/fila-lances', { headers: serverHeaders() });
    if (filaResp.ok) {
      var filaCheck = await filaResp.json();
      if (filaCheck.success && filaCheck.lances && filaCheck.lances.some(function(l) { return l.fonte === 'auto-continuo'; })) {
        console.log('[LiciteAgora] Sync adiado — lances contínuos na fila (' + filaCheck.lances.length + ' pendentes)');
        syncEmExecucao = false;
        return;
      }
    }
  } catch (e) {}

  const tab = await findComprasnetTab();
  if (!tab) {
    console.log('[LiciteAgora] Sync pulado — nenhuma aba do Comprasnet aberta');
    syncEmExecucao = false;
    return;
  }

  const stats = data.stats || { capturados: 0, enviados: 0, erros: 0, syncs: 0 };
  console.log('[LiciteAgora] ═══ Início sync (tab ' + tab.id + ') ═══');

  try {
    // 1. Buscar participações
    const participacoes = await syncParticipacoes(tab.id, data.bearer);

    // 2. Participações em andamento (filtro=5) e em disputa (filtro=4)
    const emAndamento = participacoes.filter(function(p) {
      return p._filtro === 5;
    });
    const emDisputa = participacoes.filter(function(p) {
      return p._filtro === 4;
    });
    // Unir sem duplicar (IDs já vistos no sync são únicos)
    const idsVistos = new Set();
    const paraSyncDisputas = [];
    for (var pp of emAndamento.concat(emDisputa)) {
      var compraP = pp.compra || pp;
      var cidP = compraP.compraId || pp.compraId || (
        String(compraP.numeroUasg || 0).padStart(6, '0') +
        String(compraP.modalidade || 0).padStart(2, '0') +
        String(compraP.numero || 0).padStart(5, '0') +
        String(compraP.ano || '')
      );
      if (cidP && !idsVistos.has(cidP)) {
        idsVistos.add(cidP);
        paraSyncDisputas.push(pp);
      }
    }

    // 2.5. Extrair IDs em andamento e detectar encerradas
    var idsEmAndamento = [];
    for (var ea of emAndamento) {
      var compra = ea.compra || ea;
      var uasgEA = String(compra.numeroUasg || ea.numeroUasg || 0).padStart(6, '0');
      var modEA = String(compra.modalidade || ea.modalidade || 0).padStart(2, '0');
      var numEA = String(compra.numero || ea.numero || 0).padStart(5, '0');
      var anoEA = String(compra.ano || ea.ano || '');
      var cidEA = compra.compraId || ea.compraId || (uasgEA + modEA + numEA + anoEA);
      if (cidEA) idsEmAndamento.push(cidEA);
    }
    await detectarEncerradas(idsEmAndamento);

    if (paraSyncDisputas.length > 0) {
      console.log('[LiciteAgora] ' + emAndamento.length + ' em andamento + ' + emDisputa.length + ' em disputa (de ' + participacoes.length + ' total) — buscando mensagens...');
      await syncMensagens(tab.id, emAndamento, data.bearer);
      // Verificar disputas ativas (itens em fase de lance) — inclui filtro=4
      await syncDisputas(tab.id, paraSyncDisputas, data.bearer);
    } else {
      console.log('[LiciteAgora] Nenhuma participação em andamento para mensagens');
    }

    stats.syncs = (stats.syncs || 0) + 1;
    await save({ stats, ultimoSync: Date.now() });
    console.log('[LiciteAgora] ═══ Sync completo ═══');
  } catch (e) {
    console.error('[LiciteAgora] Erro no sync:', e.message);
    await save({ ultimoErro: 'Sync: ' + e.message });
  } finally {
    syncEmExecucao = false;
  }
}

async function syncParticipacoes(tabId, bearer) {
  const data = await load();
  const syncCount = (data.stats || {}).syncs || 0;
  const syncCompleto = syncCount % 5 === 0; // sync completo a cada 5 ciclos

  if (syncCompleto) {
    console.log('[LiciteAgora] Sync COMPLETO (todos os filtros)...');
    return await syncParticipacoesFiltros(tabId, bearer, [5, 4, 3, 2, 6]);
  } else {
    console.log('[LiciteAgora] Sync rápido (em andamento + em disputa + propostas)...');
    return await syncParticipacoesFiltros(tabId, bearer, [5, 4, 3]);
  }
}

async function syncParticipacoesFiltros(tabId, bearer, filtros) {
  let todas = [];
  const idsVistos = new Set();

  for (const filtro of filtros) {
    let pagina = 0;
    let countFiltro = 0;
    console.log('[LiciteAgora] Tentando filtro=' + filtro + '...');

    while (true) {
      try {
        const result = await comprasnetFetch(tabId,
          '/comprasnet-fase-externa/v1/compras/participacoes?filtro=' + filtro + '&tamanhoPagina=50&pagina=' + pagina,
          bearer
        );

        if (result.status !== 200 && result.status !== 206) {
          console.log('[LiciteAgora] filtro=' + filtro + ' pág ' + pagina + ': HTTP ' + result.status + ' ' + (result.error || ''));
          break;
        }
        if (!result.data || !Array.isArray(result.data) || result.data.length === 0) break;

        for (const item of result.data) {
          const compra = item.compra || item;
          var uasg = String(compra.numeroUasg || 0).padStart(6, '0');
          var mod = String(compra.modalidade || 0).padStart(2, '0');
          var num = String(compra.numero || 0).padStart(5, '0');
          var ano = String(compra.ano || '');
          var cid = uasg + mod + num + ano;

          if (!idsVistos.has(cid)) {
            idsVistos.add(cid);
            item._filtro = filtro; // marcar qual filtro trouxe
            todas.push(item);
            countFiltro++;
          }
        }

        pagina++;
        if (result.data.length < 50) break;
      } catch (e) {
        break;
      }
    }

    if (countFiltro > 0) {
      console.log('[LiciteAgora] filtro=' + filtro + ': ' + countFiltro + ' participações');
    }
  }

  if (todas.length > 0) {
    console.log('[LiciteAgora] ' + todas.length + ' participações encontradas, enviando ao servidor...');
    const resp = await serverPost('/api/sync/participacoes', { participacoes: todas });
    if (resp) {
      console.log('[LiciteAgora] Servidor: ' + (resp.inseridas || 0) + ' novas, ' + (resp.atualizadas || 0) + ' atualizadas');
    } else {
      console.error('[LiciteAgora] Servidor NÃO respondeu ao sync de participações!');
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
    // Construir compraId: {uasg:06}{modalidade:02}{numero:05}{ano:04}
    var id = compra.compraId;
    if (!id && compra.numeroUasg) {
      var uasg = String(compra.numeroUasg).padStart(6, '0');
      var mod = String(compra.modalidade || 0).padStart(2, '0');
      var num = String(compra.numero || 0).padStart(5, '0');
      var ano = String(compra.ano || '');
      id = uasg + mod + num + ano;
    }
    if (id && !compraIds.includes(id)) compraIds.push(id);
  }

  console.log('[LiciteAgora] Buscando mensagens de ' + compraIds.length + ' licitações...');
  let totalNovas = 0;
  let ok200 = 0, empty = 0, erros = 0, semDados = 0;

  for (const compraId of compraIds) {
    try {
      // Paginar para pegar TODAS as mensagens (não só as 20 primeiras)
      let page = 0;
      let msgCompra = [];

      while (true) {
        const result = await comprasnetFetch(tabId,
          '/comprasnet-mensagem/v2/chat/' + compraId + '?size=50&page=' + page + '&legadoAsp=false',
          bearer
        );

        if ((result.status === 200 || result.status === 206) && Array.isArray(result.data) && result.data.length > 0) {
          msgCompra = msgCompra.concat(result.data);
          page++;
          if (result.data.length < 50) break; // última página
        } else {
          if (page === 0 && result.status !== 200 && result.status !== 206) {
            erros++;
            if (erros <= 3) console.log('[LiciteAgora] Msg ' + compraId + ': HTTP ' + result.status + ' ' + (result.error || ''));
          } else if (page === 0) {
            empty++;
          }
          break;
        }
      }

      if (msgCompra.length > 0) {
        ok200++;
        const resp = await serverPost('/api/sync/mensagens', {
          compraId,
          mensagens: msgCompra,
        });
        if (resp && resp.novas > 0) {
          totalNovas += resp.novas;
        }
      }
    } catch (e) {
      erros++;
    }
  }

  console.log('[LiciteAgora] Mensagens: ' + ok200 + ' com dados, ' + empty + ' vazias, ' + erros + ' erros. ' + totalNovas + ' novas salvas.');
}

// ==================== HELPERS: BUSCA INTELIGENTE DE ITENS ====================

/**
 * Busca itens de uma compra usando estratégia inteligente de endpoints.
 * 1. /itens/qtdes para detectar fase
 * 2. Endpoint específico da fase (retorna preços reais)
 * 3. Fallbacks: /classificacao, /em-selecao-fornecedores
 */
async function buscarItensCompra(tabId, compraId, bearer, fetchFiltros) {
  // Passo 1: detectar fase via /qtdes (1 chamada leve)
  var qtdes = null;
  try {
    var qtdesResult = await comprasnetFetch(tabId,
      '/comprasnet-disputa/v1/compras/' + compraId + '/itens/qtdes', bearer);
    if (qtdesResult.status === 200 || qtdesResult.status === 206) qtdes = qtdesResult.data;
  } catch (e) {}

  // Passo 2: montar lista de endpoints por prioridade baseada na fase
  var endpoints = [];
  if (qtdes) {
    if (qtdes.qtdeItensEmDisputa > 0)
      endpoints.push('/comprasnet-disputa/v1/compras/' + compraId + '/itens/em-disputa?tamanhoPagina=50&pagina=0&filtro=1');
    if (qtdes.qtdeItensComDisputaEncerrada > 0)
      endpoints.push('/comprasnet-disputa/v1/compras/' + compraId + '/itens/disputa-encerrada?tamanhoPagina=50&pagina=0&filtro=1');
  }
  // Fallbacks (sempre incluir)
  endpoints.push('/comprasnet-disputa/v1/compras/' + compraId + '/itens/classificacao');
  endpoints.push('/comprasnet-fase-externa/v1/compras/' + compraId + '/itens/em-selecao-fornecedores');

  // Passo 3: tentar endpoints em ordem
  var itens = null;
  var endpointUsado = '';
  for (var ep of endpoints) {
    try {
      var result = await comprasnetFetch(tabId, ep, bearer);
      if (result.status === 200 || result.status === 206) {
        var dados = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);
        if (dados.length > 0) {
          itens = dados;
          endpointUsado = ep.includes('?') ? ep.split('?')[0].split('/v1/')[1] : (ep.split('/v1/')[1] || ep);
          break;
        }
      }
    } catch (e) {}
  }

  // Passo 3.5: detectar grupos e buscar sub-itens com dados de disputa
  if (itens && itens.length > 0) {
    var temGrupo = itens.some(function(it) { return it.tipo === 'G'; });
    console.log('[LiciteAgora] ' + compraId + ': ' + itens.length + ' itens, temGrupo=' + temGrupo + ' tipos=' + itens.map(function(it){return it.numero+':'+it.tipo;}).join(','));
    if (temGrupo) {
      // /em-disputa só retorna o grupo (-1) — buscar sub-itens
      // Prioridade: disputa endpoints (dados live), depois fase-externa (definições)
      var subEndpoints = [
        '/comprasnet-disputa/v1/compras/' + compraId + '/itens',
        '/comprasnet-fase-externa/v1/compras/' + compraId + '/itens',
        '/comprasnet-fase-externa/v1/compras/' + compraId + '/itens/em-selecao-fornecedores',
      ];
      for (var sep of subEndpoints) {
        try {
          var subResult = await comprasnetFetch(tabId, sep, bearer);
          console.log('[LiciteAgora] Sub-itens ' + sep.split('/v1/')[1] + ': HTTP ' + subResult.status +
            ' isArray=' + Array.isArray(subResult.data) + ' len=' + (Array.isArray(subResult.data) ? subResult.data.length : 0));
          if ((subResult.status === 200 || subResult.status === 206) && Array.isArray(subResult.data) && subResult.data.length > 0) {
            var numeros = {};
            itens.forEach(function(it) { numeros[it.numero || it.identificador] = true; });
            var adicionados = 0;
            subResult.data.forEach(function(si) {
              var num = si.numero || si.identificador || si.numeroItem;
              if (num != null && !numeros[num]) {
                if (!si.tipo) si.tipo = 'S';
                if (!si.numero && si.numeroItem) si.numero = si.numeroItem;
                itens.push(si);
                numeros[num] = true;
                adicionados++;
              }
            });
            if (adicionados > 0) {
              console.log('[LiciteAgora] Grupo em ' + compraId + ': +' + adicionados + ' sub-itens via ' + sep.split('/v1/')[1]);
              break;
            }
          }
        } catch (e) {
          console.log('[LiciteAgora] Sub-itens ' + sep.split('/v1/')[1] + ': ERRO ' + e.message);
        }
      }
    }
  }

  // Passo 4: buscar filtros extras (3=perdendo, 4=enc.aleatória, 5=2min) se solicitado
  var filterMeta = {};
  if (fetchFiltros && itens && itens.length > 0 && qtdes && qtdes.qtdeItensEmDisputa > 0) {
    var filtrosExtras = [
      { filtro: 3, campo: 'perdendo' },
      { filtro: 4, campo: 'encAleat' },
      { filtro: 5, campo: 'doisMin' },
    ];
    var filtroNomes = { 3: 'perdendo', 4: 'enc.aleat', 5: '2min' };
    for (var fe of filtrosExtras) {
      try {
        var fResult = await comprasnetFetch(tabId,
          '/comprasnet-disputa/v1/compras/' + compraId + '/itens/em-disputa?tamanhoPagina=50&pagina=0&filtro=' + fe.filtro, bearer);
        if ((fResult.status === 200 || fResult.status === 206) && Array.isArray(fResult.data)) {
          // LOG: detalhes de cada filtro
          var fItens = fResult.data.map(function(fi) {
            return {
              num: fi.numero || fi.identificador,
              fase: fi.fase,
              sit: fi.situacaoParticipanteDisputa,
              fimContagem: fi.dataHoraFimContagem,
              sitAposContagem: fi.situacaoAposContagem,
              melhor: fi.melhorValorGeral ? fi.melhorValorGeral.valorInformado : null,
              nosso: fi.melhorValorFornecedor ? fi.melhorValorFornecedor.valorInformado : null,
            };
          });
          console.log('[LiciteAgora] FILTRO=' + fe.filtro + ' (' + filtroNomes[fe.filtro] + ') ' + compraId +
            ': ' + fResult.data.length + ' itens — ' + JSON.stringify(fItens));
          // Enviar log ao servidor para visibilidade centralizada
          try {
            await serverPost('/api/sniper/log-filtro', {
              compraId: compraId,
              filtro: fe.filtro,
              nome: filtroNomes[fe.filtro],
              qtde: fResult.data.length,
              itens: fItens,
            });
          } catch (e2) {}

          for (var fi of fResult.data) {
            var fNum = fi.numero || fi.identificador;
            if (fNum != null) {
              if (!filterMeta[fNum]) filterMeta[fNum] = {};
              filterMeta[fNum][fe.campo] = true;
            }
          }
        } else {
          console.log('[LiciteAgora] FILTRO=' + fe.filtro + ' (' + filtroNomes[fe.filtro] + ') ' + compraId +
            ': HTTP ' + (fResult.status || '?') + ' (sem dados ou não-array)');
        }
      } catch (e) {
        console.log('[LiciteAgora] FILTRO=' + fe.filtro + ' (' + filtroNomes[fe.filtro] + ') ' + compraId +
          ': ERRO ' + e.message);
      }
    }
  }

  return { itens: itens, endpoint: endpointUsado, qtdes: qtdes, filterMeta: filterMeta };
}

/**
 * Extrai melhor valor (lance global) de um item.
 */
function extrairMelhorValor(item) {
  var mv = item.melhorValorGeral || item.melhorLanceGeral;
  if (mv && mv.valorInformado != null) return mv.valorInformado;
  if (mv && mv.valor != null) return mv.valor;
  if (mv && mv.valorCalculado != null) {
    if (typeof mv.valorCalculado === 'number') return mv.valorCalculado;
    if (mv.valorCalculado.valorUnitario != null) return mv.valorCalculado.valorUnitario;
  }
  if (item.valorMelhorLance != null) return item.valorMelhorLance;
  return null;
}

/**
 * Extrai nosso valor (lance do fornecedor) de um item.
 */
function extrairNossoValor(item) {
  var nv = item.melhorValorFornecedor || item.melhorLanceFornecedor;
  if (nv && nv.valorInformado != null) return nv.valorInformado;
  if (nv && nv.valor != null) return nv.valor;
  if (nv && nv.valorCalculado != null) {
    if (typeof nv.valorCalculado === 'number') return nv.valorCalculado;
    if (nv.valorCalculado.valorUnitario != null) return nv.valorCalculado.valorUnitario;
  }
  // Fallback: propostaItem.valores (de /em-selecao-fornecedores)
  if (item.propostaItem && item.propostaItem.valores) {
    var v = item.propostaItem.valores;
    var lance = v.valorPropostaInicialOuLances || v.valorPropostaInicial;
    if (lance) {
      if (lance.valorInformado != null) return lance.valorInformado;
      if (lance.valorCalculado && lance.valorCalculado.valorUnitario != null) return lance.valorCalculado.valorUnitario;
    }
  }
  return null;
}

/**
 * Checa se estamos ganhando após um lance, usando dados da resposta do Comprasnet.
 * Analisa o item grupo (numero=-1) se existir, senão usa o itemNumero do lance.
 * Retorna true se nossoValor <= melhorGeral (estamos na frente).
 */
function checarGanhandoNaResposta(responseData, compraId, itemNumero) {
  if (!Array.isArray(responseData) || responseData.length === 0) return false;
  // Preferir item grupo (numero === -1) para visão consolidada
  var alvo = responseData.find(function(it) { return it.numero === -1; });
  if (!alvo) alvo = responseData.find(function(it) { return it.numero === itemNumero; });
  if (!alvo) return false;
  var melhor = extrairMelhorValor(alvo);
  var nosso = extrairNossoValor(alvo);
  if (nosso == null || melhor == null) return false;
  return nosso <= melhor;
}

/**
 * Mapeia item da API para formato padronizado enviado ao servidor.
 */
function mapearItem(i, filterMeta) {
  var num = i.numero || i.identificador;
  var fm = (filterMeta && num != null && filterMeta[num]) ? filterMeta[num] : {};
  return {
    numero: num,
    tipo: i.tipo || null, // G=grupo, S=sub-item, null=item normal
    descricao: (i.descricao || i.objetoItem || '').substring(0, 120),
    fase: i.fase || i.faseItem || '',
    situacao: i.situacao || '',
    melhorValor: extrairMelhorValor(i),
    nossoValor: extrairNossoValor(i),
    valorEstimado: i.valorEstimadoUnitario || i.valorEstimado || null,
    situacaoParticipante: i.situacaoParticipanteDisputa || null,
    variacaoMinima: i.variacaoMinimaEntreLances != null ? i.variacaoMinimaEntreLances : null,
    podeEnviar: i.podeEnviarLances || false,
    fimContagem: i.dataHoraFimContagem || null,
    quantidadeSolicitada: i.quantidadeSolicitada || null,
    disputaPorValorUnitario: !!i.disputaPorValorUnitario,
    estaPerdendo: !!fm.perdendo,
    emEncAleatoria: !!fm.encAleat,
    nosDoisMinFinais: !!fm.doisMin,
  };
}

// ==================== SYNC DISPUTAS (itens em disputa) ====================

/**
 * Consulta itens das participações em andamento PELO BROWSER (captcha IP OK).
 * Usa estratégia inteligente: /qtdes → endpoint da fase → preços reais.
 */
async function syncDisputas(tabId, participacoesEmAndamento, bearer) {
  if (!participacoesEmAndamento || participacoesEmAndamento.length === 0) return;

  console.log('[LiciteAgora] Verificando disputas em ' + participacoesEmAndamento.length + ' participações...');
  var disputas = [];

  // Consultar quais compras têm auto-lance configurado (para buscar filtros extras)
  var autoCompras = {};
  try {
    var autoResp = await fetch(SERVER_URL + '/api/sniper/auto-compras', { headers: serverHeaders() });
    if (autoResp.ok) {
      var autoData = await autoResp.json();
      if (autoData.success && Array.isArray(autoData.compraIds)) {
        autoData.compraIds.forEach(function(cid) { autoCompras[cid] = true; });
      }
    }
  } catch (e) {
    console.log('[LiciteAgora] auto-compras indisponível, filtros extras desabilitados');
  }

  for (var p of participacoesEmAndamento) {
    // Verificar se tab ainda existe antes de cada compra
    if (!await tabExists(tabId)) {
      console.log('[LiciteAgora] Tab fechada durante syncDisputas, abortando');
      break;
    }

    // Dados reais ficam dentro de p.compra (estrutura da API: { compra: {...}, possuiDiligencia... })
    var compra = p.compra || {};
    var compraId = p.codigoCompra || p.compraId;

    // Reconstruir compraId: {uasg:06}{modalidade:02}{numero:05}{ano:04}
    if (!compraId) {
      compraId = compra.codigoCompra || compra.id || compra.identificador || '';
      if (!compraId) {
        var uasg = String(compra.numeroUasg || p.numeroUasg || 0).padStart(6, '0');
        var mod = String(compra.modalidade || p.modalidade || 0).padStart(2, '0');
        var num = String(compra.numero || p.numero || 0).padStart(5, '0');
        var ano = String(compra.ano || p.ano || '');
        if (ano) compraId = uasg + mod + num + ano;
      }
    }
    if (!compraId) continue;

    // Extrair metadados da compra (campos estão em compra.*, não em p.*)
    var orgao = compra.nomeUasg || compra.nomeOrgao || p.nomeUasg || '';
    var objeto = compra.objetoCompra || p.objeto || '';
    var dataSessao = compra.dataHoraAbertura || p.dataHoraInicioSessaoPublica || '';
    var fimDisputa = compra.dataHoraFimDisputa || p.dataHoraFimSessaoPublica || null;
    var faseCompra = compra.faseCompraFaseExterna || p.faseCompra || p.fase || '';

    // Buscar detalhes da participação (/participacao) para auto-lance e fase proposta/disputa
    var precisaDetalhes = autoCompras[compraId] || faseCompra === '1' || faseCompra === '3' || faseCompra === 1 || faseCompra === 3;
    if (precisaDetalhes) {
      try {
        var partResult = await comprasnetFetch(tabId,
          '/comprasnet-fase-externa/v1/compras/' + compraId + '/participacao', bearer);
        if ((partResult.status === 200 || partResult.status === 206) && partResult.data) {
          var pd = partResult.data;
          // Enviar ao servidor para salvar no banco
          try {
            await serverPost('/api/sync/participacao-detalhes', {
              compraId: compraId,
              modoDisputa: pd.modoDisputa || null,
              criterioJulgamento: pd.criterioJulgamento || null,
              dataHoraInicioDisputa: pd.dataHoraInicioDisputa || null,
              dataHoraFimDisputa: pd.dataHoraFimDisputa || null,
              dataHoraAbertura: pd.dataHoraAbertura || null,
              chaveCompraPncp: pd.chaveCompraPncp || null,
              linkPncp: pd.linkPncp || null,
              exclusivaMeEpp: pd.participacaoExclusivaMeEppOuEquiparadas ? 1 : 0,
              fundamentoLegal: pd.fundamentoLegal || null,
              situacaoCompra: pd.situacaoCompraFaseExterna || null,
              faseCompra: pd.faseCompraFaseExterna || null,
              objeto: pd.objeto || null,
              orgao: pd.nomeUasg || null,
            });
          } catch (e) {}
          // Usar fimDisputa da API se não temos
          if (!fimDisputa && pd.dataHoraFimDisputa) fimDisputa = pd.dataHoraFimDisputa;
          if (!faseCompra && pd.faseCompraFaseExterna) faseCompra = pd.faseCompraFaseExterna;
        }
      } catch (e) {
        console.log('[LiciteAgora] /participacao falhou para ' + compraId + ': ' + e.message);
      }
    }

    // Buscar itens via estratégia inteligente (/qtdes → fase → endpoint correto)
    var usarFiltros = !!autoCompras[compraId];
    var resultado = await buscarItensCompra(tabId, compraId, bearer, usarFiltros);
    var itens = resultado.itens;
    var filterMeta = resultado.filterMeta || {};

    // Se endpoints falharam, criar stub
    if (!itens || itens.length === 0) {
      var emDisputa = String(faseCompra) === '3';
      var isEmAndamento = p._filtro === 5 || emDisputa;
      if (isEmAndamento) {
        var stubItens = [{
          numero: 1,
          descricao: (objeto || 'Item 1').substring(0, 120),
          fase: emDisputa ? 'LA' : '', situacao: '',
          melhorValor: null, nossoValor: null,
          situacaoParticipante: null, variacaoMinima: null,
          podeEnviar: emDisputa, fimContagem: fimDisputa,
          valorEstimado: null, quantidadeSolicitada: null, stub: true,
        }];
        disputas.push({
          compraId: compraId, orgao: orgao, objeto: objeto,
          dataSessao: dataSessao,
          totalItens: 1, itensAtivos: emDisputa ? 1 : 0, stub: true, itens: stubItens,
        });
      }
      continue;
    }

    // Filtrar itens em fase de lance
    var itensAtivos = itens.filter(function(item) {
      var fase = item.fase || item.faseItem || '';
      return fase === 'LA' || fase === 'D1' || fase === 'D2' || item.podeEnviarLances === true;
    });

    disputas.push({
      compraId: compraId,
      orgao: orgao,
      objeto: objeto,
      dataSessao: dataSessao,
      totalItens: itens.length,
      itensAtivos: itensAtivos.length,
      itens: itens.map(function(item) { return mapearItem(item, filterMeta); }),
    });
  }

  // Enviar ao servidor
  try {
    await serverPost('/api/sync/disputas', { disputas: disputas });
    console.log('[LiciteAgora] ' + disputas.length + ' disputas enviadas ao servidor (' +
      disputas.filter(function(d) { return d.itensAtivos > 0; }).length + ' com itens ativos)');
  } catch (e) {
    console.error('[LiciteAgora] Erro enviando disputas:', e.message);
  }
}

// ==================== KEEPALIVE (mantém sessão SSO + token Bearer) ====================

/**
 * Navega a aba do Comprasnet para a URL de entrada e aguarda novo Bearer.
 *
 * Problema anterior: chrome.tabs.reload() numa aba que já perdeu a sessão
 * vai parar em "acesso-nao-autorizado" e o token no storage é o velho.
 *
 * Solução: navegar para /comprasnet-web/seguro/fornecedor/compras (entry point).
 * Se o SSO está vivo, a autenticação SSO acontece automaticamente e o SPA
 * inicializa com token novo. onSendHeaders captura o bearer fresco.
 */
async function reloadEAguardarBearer(tabId, motivoLog) {
  aguardandoNovoBearer = true;
  chrome.action.setBadgeText({ text: '⏳' });
  chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });

  // Limpar tokens velhos do storage da aba ANTES de navegar
  // (evita que injeção posterior encontre token expirado e o confunda com novo)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: function() {
        try { var rt = sessionStorage.getItem("refreshToken"); sessionStorage.clear(); if (rt) sessionStorage.setItem("refreshToken", rt); } catch(e) {}
      },
    });
    console.log('[LiciteAgora] Storage da aba limpo antes de navegar');
  } catch (e) {
    // Pode falhar se a aba está num estado estranho — não é crítico
  }

  // Navegar para entry point (NÃO reload) — força SSO re-auth
  var entryUrl = COMPRASNET + '/comprasnet-web/seguro/fornecedor/compras';
  console.log('[LiciteAgora] Navegando para entry point: ' + entryUrl + ' (' + motivoLog + ')');

  try {
    await chrome.tabs.update(tabId, { url: entryUrl });
  } catch (e) {
    console.error('[LiciteAgora] Erro navegando aba:', e.message);
    aguardandoNovoBearer = false;
    return false;
  }

  // Esperar a aba terminar de carregar (pode haver redirect SSO → SPA)
  var loadDetected = false;
  var finalUrl = '';
  function onTabUpdated(updatedTabId, changeInfo, tab) {
    if (updatedTabId === tabId && changeInfo.status === 'complete') {
      loadDetected = true;
      finalUrl = tab ? tab.url : '';
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
    }
  }
  chrome.tabs.onUpdated.addListener(onTabUpdated);

  // Aguardar até 20s pela aba carregar (SSO redirect pode demorar)
  for (var waitStep = 0; waitStep < 40 && !loadDetected; waitStep++) {
    await new Promise(function(r) { setTimeout(r, 500); });
  }
  chrome.tabs.onUpdated.removeListener(onTabUpdated);

  if (!loadDetected) {
    console.log('[LiciteAgora] ⚠️ Tab não completou load em 20s');
  } else {
    console.log('[LiciteAgora] Tab carregou: ' + (finalUrl || '?').substring(0, 120));
  }

  // Verificar se caiu na página de login (SSO morto)
  if (finalUrl && (finalUrl.indexOf('sso.serpro') >= 0 || finalUrl.indexOf('/login') >= 0 || finalUrl.indexOf('acesso-nao-autorizado') >= 0)) {
    // Verificar se Bearer fresco chegou durante a navegacao antes de declarar SSO morto
    if (!aguardandoNovoBearer) {
      console.log('[LiciteAgora] ✅ Aba foi para login mas Bearer fresco chegou durante navegacao — SSO OK');
      chrome.action.setBadgeText({ text: '' });
      return true;
    }
    var dataAtual = await load();
    var idadeAtual = Date.now() - (dataAtual.bearerTimestamp || dataAtual.ultimoEnvio || 0);
    if (idadeAtual < 120000) {
      console.log('[LiciteAgora] ✅ Bearer renovado recentemente (' + Math.floor(idadeAtual/1000) + 's) — ignorando redirect SSO');
      aguardandoNovoBearer = false;
      chrome.action.setBadgeText({ text: '' });
      return true;
    }
    console.log('[LiciteAgora] ⚠️ Aba redirecionou para login — SSO morto, precisa login manual');
    aguardandoNovoBearer = false;
    chrome.action.setBadgeText({ text: 'SSO' });
    chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
    await save({ ultimoErro: 'Sessão SSO expirada — faça login no Comprasnet' });
    return false;
  }

  // Se bearer já chegou via onSendHeaders durante a navegação
  if (!aguardandoNovoBearer) {
    console.log('[LiciteAgora] ✅ Bearer capturado durante navegação');
    chrome.action.setBadgeText({ text: '' });
    return true;
  }

  // Aba carregou no SPA mas bearer não chegou — aguardar SPA inicializar
  // O SPA Angular/React pode demorar alguns segundos após o DOM load
  console.log('[LiciteAgora] Aba carregou no SPA, bearer não chegou — aguardando SPA inicializar...');

  // Aguardar até 15s pelo bearer chegar via onSendHeaders (SPA faz chamadas ao inicializar)
  for (var waitInit = 0; waitInit < 30 && aguardandoNovoBearer; waitInit++) {
    await new Promise(function(r) { setTimeout(r, 500); });
  }

  if (!aguardandoNovoBearer) {
    console.log('[LiciteAgora] ✅ Bearer capturado após SPA inicializar');
    chrome.action.setBadgeText({ text: '' });
    return true;
  }

  // SPA não fez chamada autenticada sozinho — forçar via injeção
  console.log('[LiciteAgora] SPA não emitiu bearer — forçando fetch autenticado...');

  for (var tentativa = 1; tentativa <= 2 && aguardandoNovoBearer; tentativa++) {
    if (tentativa > 1) {
      await new Promise(function(r) { setTimeout(r, 5000); });
      if (!aguardandoNovoBearer) break;
    }

    try {
      var injectResult = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: function(baseUrl) {
          var info = { url: location.href.substring(0, 120), tokenFound: false, sessionEndpoint: false };

          // 1. Tentar pegar token novo do storage (SPA pode ter gravado após init)
          var token = null;
          try {
            var storages = [sessionStorage, localStorage];
            for (var s = 0; s < storages.length && !token; s++) {
              for (var i = 0; i < storages[s].length && !token; i++) {
                var val = storages[s].getItem(storages[s].key(i));
                if (val && val.indexOf('eyJ') >= 0) {
                  try {
                    var parsed = JSON.parse(val);
                    var t = parsed.accessToken || parsed.access_token || parsed.token ||
                            (parsed.auth && parsed.auth.accessToken) ||
                            (parsed.session && parsed.session.accessToken);
                    if (t) { token = t; break; }
                  } catch (e) {
                    if (val.startsWith('eyJ') && val.length > 100) { token = val; break; }
                  }
                }
              }
            }
          } catch (e) {}

          if (token) {
            info.tokenFound = true;
            // Fazer fetch com o token (provoca onSendHeaders)
            fetch(baseUrl + '/comprasnet-disputa/v1/datahorabrasilia', {
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
                'Authorization': 'Bearer ' + token,
                'x-device-platform': 'web',
                'x-version-number': '6.0.0',
              },
            }).catch(function() {});
          }

          // 2. Tentar endpoint de sessão via cookies (independente de ter token)
          fetch(baseUrl + '/comprasnet-usuario/v2/sessao/fornecedor', {
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'x-device-platform': 'web', 'x-version-number': '6.0.0' },
          }).then(function(r) {
            info.sessionEndpoint = true;
            return r.json();
          }).then(function(d) {
            if (d && d.accessToken) {
              fetch(baseUrl + '/comprasnet-disputa/v1/datahorabrasilia', {
                credentials: 'include',
                headers: {
                  'Accept': 'application/json',
                  'Authorization': 'Bearer ' + d.accessToken,
                  'x-device-platform': 'web',
                  'x-version-number': '6.0.0',
                },
              }).catch(function() {});
            }
          }).catch(function() {});

          return info;
        },
        args: [COMPRASNET],
      });

      var ir = injectResult[0]?.result || {};
      console.log('[LiciteAgora] Injeção #' + tentativa + ': tokenFound=' + ir.tokenFound + ' url=' + (ir.url || '?'));
    } catch (e) {
      console.log('[LiciteAgora] ⚠️ Erro injeção #' + tentativa + ':', e.message);
    }

    // Aguardar até 10s pelo bearer chegar via onSendHeaders
    for (var waitStep2 = 0; waitStep2 < 20 && aguardandoNovoBearer; waitStep2++) {
      await new Promise(function(r) { setTimeout(r, 500); });
    }

    if (!aguardandoNovoBearer) {
      console.log('[LiciteAgora] ✅ Bearer capturado na tentativa #' + tentativa);
      chrome.action.setBadgeText({ text: '' });
      return true;
    }
  }

  // Falhou completamente
  aguardandoNovoBearer = false;
  console.log('[LiciteAgora] ⚠️ Timeout: bearer não chegou após navegação + injeções (' + motivoLog + ')');
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
  return false;
}

/**
 * Verifica e mantém a sessão SSO via uma chamada de API real dentro da aba.
 *
 * NOTA: HEAD para /comprasnet-web/seguro/* NÃO funciona como check de SSO!
 * O servidor retorna 200 (shell do SPA) independente de autenticação.
 * Em vez disso, chamamos /comprasnet-usuario/v2/sessao/fornecedor que retorna
 * dados do usuário se autenticado, ou 401 se não.
 */
async function manterSessaoSSO(tabId) {
  try {
    var result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (baseUrl) => {
        try {
          // 1. Chamar API de sessão (verifica SSO + cookies de sessão reais)
          var resp = await fetch(baseUrl + '/comprasnet-usuario/v2/sessao/fornecedor', {
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'x-device-platform': 'web', 'x-version-number': '6.0.0' },
          });
          var data = null;
          try { data = await resp.json(); } catch (e) {}
          return {
            status: resp.status,
            ok: resp.ok,
            temToken: !!(data && data.accessToken),
            accessToken: data && data.accessToken ? data.accessToken : null,
            temNome: !!(data && (data.nome || data.nomeUsuario)),
          };
        } catch (e) {
          return { status: 0, error: e.message };
        }
      },
      args: [COMPRASNET],
    });
    var r = result[0]?.result || { status: 0 };
    if (r.ok && (r.temToken || r.temNome)) {
      console.log('[LiciteAgora] 🔒 SSO session OK (HTTP ' + r.status + ', token=' + r.temToken + ')');
      // Se o endpoint retornou um accessToken, capturar como bearer fresco!
      if (r.accessToken) {
        var newBearer = 'Bearer ' + r.accessToken;
        var data = await load();
        var stats = data.stats || { capturados: 0, enviados: 0, erros: 0, syncs: 0 };
        await save({ bearer: newBearer, bearerTimestamp: Date.now(), ultimoEnvio: Date.now() });
        console.log('[LiciteAgora] 🔑 Bearer renovado via /sessao/fornecedor (proativo)');
        await enviarTokens(newBearer, data.captcha, stats);
        try { await serverPost('/api/sniper/log', { tipo: 'sso-retoken', msg: 'Bearer renovado via /sessao/fornecedor (proativo)' }); } catch(e2){}
      }
      return { ok: true, bearerRenovado: !!r.accessToken };
    } else if (r.status === 401 || r.status === 403) {
      console.log('[LiciteAgora] ⚠️ SSO morto: HTTP ' + r.status);
      return { ok: false };
    } else {
      console.log('[LiciteAgora] ⚠️ SSO check: HTTP ' + r.status + ' token=' + r.temToken + ' ' + (r.error || ''));
      // Status desconhecido (404, 500, etc) — NÃO assumir SSO morto, pode ser endpoint indisponível
      // Só 401/403 confirma SSO morto
      return { ok: true, bearerRenovado: false };
    }
  } catch (e) {
    console.log('[LiciteAgora] ⚠️ SSO check erro:', e.message);
    return { ok: false };
  }
}


async function renovarTokenViaSessao(tabId, tabUrl) {
  try {
    var match = tabUrl && tabUrl.match(/compras-id=([a-f0-9-]{36})/i);
    var uuid = match ? match[1] : null;
    if (!uuid) {
      var storedData = await load();
      if (storedData.comprasId) {
        uuid = storedData.comprasId;
        console.log("[LiciteAgora] UUID do storage da extensao: " + uuid.substring(0,8) + "...");
      }
    }
    if (!uuid) {
      try {
        var sr = await chrome.scripting.executeScript({
          target: { tabId: tabId }, world: "MAIN",
          func: () => {
            var all = Object.keys(sessionStorage).concat(Object.keys(localStorage));
            for (var k of all) {
              try {
                var v = sessionStorage.getItem(k) || localStorage.getItem(k);
                var m = v && v.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
                if (m) return m[0];
              } catch(e) {}
            }
            var links = document.querySelectorAll("a[href*=compras-id]");
            if (links.length > 0) { var lm = links[0].href.match(/compras-id=([a-f0-9-]{36})/i); if (lm) return lm[1]; }
            return null;
          }
        });
        uuid = sr && sr[0] && sr[0].result;
      } catch(e2) {}
    }
    if (!uuid) {
      console.log("[LiciteAgora] renovarTokenViaSessao: UUID nao encontrado em nenhuma fonte");
      return false;
    }
    console.log("[LiciteAgora] Renovando token via /sessao/token/" + uuid.substring(0,8) + "...");
    var result = await chrome.scripting.executeScript({
      target: { tabId: tabId }, world: "MAIN",
      func: async (baseUrl, uuid) => {
        try {
          var resp = await fetch(baseUrl + "/comprasnet-usuario/v2/sessao/fornecedor/usuario/token/" + uuid, {
            credentials: "include",
            headers: { "Accept": "application/json", "x-device-platform": "web", "x-version-number": "6.0.0" }
          });
          var data = null;
          try { data = await resp.json(); } catch(e) {}
          return { status: resp.status, accessToken: data && data.accessToken ? data.accessToken : null };
        } catch(e) { return { status: 0, error: e.message }; }
      },
      args: [COMPRASNET, uuid]
    });
    var r = result && result[0] && result[0].result;
    if (r && r.status === 200 && r.accessToken) {
      var newBearer = "Bearer " + r.accessToken;
      var data = await load();
      var stats = data.stats || { capturados: 0, enviados: 0, erros: 0, syncs: 0 };
      await save({ bearer: newBearer, bearerTimestamp: Date.now(), ultimoEnvio: Date.now() });
      aguardandoNovoBearer = false;
      console.log("[LiciteAgora] Bearer renovado via /sessao/token OK");
      await enviarTokens(newBearer, data.captcha, stats);
      return true;
    }
    console.log("[LiciteAgora] renovarTokenViaSessao: HTTP " + (r && r.status) + " — sem accessToken");
    return false;
  } catch(e) {
    console.log("[LiciteAgora] renovarTokenViaSessao erro: " + e.message);
    return false;
  }
}

async function executarKeepalive() {
  if (syncEmExecucao) {
    // Sync em execucao — apenas renovar Bearer se necessario, pular o resto
    var dataKp = await load();
    var idadeKp = Date.now() - (dataKp.bearerTimestamp || dataKp.ultimoEnvio || 0);
    if (idadeKp > 120000 && dataKp.comprasId) {
      var tabsKp = await chrome.tabs.query({ url: "https://cnetmobile.estaleiro.serpro.gov.br/*" });
      if (tabsKp.length > 0) {
        console.log("[LiciteAgora] Renovando Bearer durante sync via /sessao/token...");
        await renovarTokenViaSessao(tabsKp[0].id, tabsKp[0].url || ("?compras-id=" + dataKp.comprasId));
      }
    }
    if (!tabsKp || !tabsKp.length) return;
    // Fallback: retoken com refreshToken do sessionStorage
    var retokenDuringSync = await comprasnetRetoken(tabsKp[0].id, dataKp.bearer);
    if (retokenDuringSync.status === 200 && retokenDuringSync.data && retokenDuringSync.data.accessToken) {
      var nb = "Bearer " + retokenDuringSync.data.accessToken;
      await save({ bearer: nb, bearerTimestamp: Date.now(), ultimoEnvio: Date.now() });
      console.log("[LiciteAgora] Bearer renovado durante sync via retoken (refreshToken)");
      await enviarTokens(nb, dataKp.captcha, dataKp.stats || {});
    } else {
      console.log("[LiciteAgora] Retoken durante sync: HTTP " + retokenDuringSync.status);
    }
    return;
  }

  // Se SSO foi confirmado como morto, não tentar mais (aguardar login manual)
  if (ssoMorto) {
    console.log('[LiciteAgora] Keepalive pulado — SSO morto, aguardando login manual');
    return;
  }

  var data = await load();
  if (!data.bearer) {
    console.log('[LiciteAgora] Keepalive pulado — sem bearer');
    return;
  }

  var tab = await findComprasnetTab();
  if (!tab) {
    console.log('[LiciteAgora] Keepalive pulado — sem aba Comprasnet');
    return;
  }

  var idadeBearerMs = Date.now() - (data.bearerTimestamp || data.ultimoEnvio || 0);
  console.log('[LiciteAgora] 🔄 Keepalive: bearer com ' + Math.floor(idadeBearerMs/1000) + 's');
  console.log("[LiciteAgora] Keepalive tab.url: " + (tab.url || "?").substring(0, 120));

  // ---- PASSO 1: Manter sessão SSO (cookies do comprasnet-web) ----
  // manterSessaoSSO agora retorna { ok, bearerRenovado } e já salva o bearer se obteve accessToken
  var ssoResult = await manterSessaoSSO(tab.id);

  if (!ssoResult.ok) {
    // SSO morto — tentar uma vez navegar para entry point
    console.log('[LiciteAgora] ⚠️ SSO falhou — tentando recuperar via navegação...');

    var reloadOk = await reloadEAguardarBearer(tab.id, 'SSO falhou');
    if (!reloadOk) {
      // Confirmar: SSO morto. Marcar flag para parar de tentar.
      ssoMorto = true;
      chrome.action.setBadgeText({ text: 'SSO' });
      chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
      await save({ ultimoErro: 'Sessão SSO expirada — faça login no Comprasnet' });
      console.log('[LiciteAgora] 🛑 SSO confirmado morto — aguardando login manual. Keepalive/sync pausados.');
    }
    return;
  }

  // Se o SSO já renovou o bearer proativamente, pular o teste de bearer
  if (ssoResult.bearerRenovado) {
    console.log('[LiciteAgora] ✅ Keepalive OK (bearer renovado proativamente via SSO)');
    return;
  }

  // ---- PASSO 1.5: Anti-idle — dismiss timeout dialog + simular atividade ----
  try {
    var antiIdleResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        var info = { dialogFound: false, dialogText: null, clicked: null, url: location.href.substring(0, 120) };
        // 1. Procurar e clicar dialogs de ociosidade / modais
        var btns = document.querySelectorAll('button, .btn, [role="button"], input[type="button"], .swal2-confirm, .modal .btn-primary');
        for (var b of btns) {
          var txt = (b.textContent || b.value || '').trim();
          var upper = txt.toUpperCase();
          if (upper === 'OK' || upper === 'CONTINUAR' || upper === 'PERMANECER CONECTADO' || upper === 'SIM') {
            // Verificar se está visível
            var rect = b.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              info.dialogFound = true;
              info.dialogText = txt;
              b.click();
              info.clicked = txt;
              break;
            }
          }
        }
        // 2. Checar se há overlay/modal visível (mesmo sem botão reconhecido)
        var modals = document.querySelectorAll('.modal.show, .swal2-container, [role="dialog"], .modal-dialog');
        if (modals.length > 0 && !info.dialogFound) {
          var modal = modals[0];
          info.dialogFound = true;
          info.dialogText = (modal.textContent || '').substring(0, 200).trim();
        }
        // 3. Simular atividade para resetar timer de ociosidade
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
        document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }));
        return info;
      },
    });
    var idle = antiIdleResult[0]?.result;
    if (idle && idle.dialogFound) {
      console.log('[LiciteAgora] ⚠️ Dialog de ociosidade detectado! clicked=' + idle.clicked + ' text="' + (idle.dialogText || '').substring(0, 80) + '"');
      // Enviar ao servidor para registro
      try {
        await serverPost('/api/sniper/log', {
          tipo: 'idle-dialog',
          msg: 'Dialog de ociosidade: ' + (idle.clicked ? 'auto-click "' + idle.clicked + '"' : 'detectado mas não clicado'),
          detalhes: idle,
        });
      } catch (e2) {}
    }
  } catch (e) {
    console.log('[LiciteAgora] Anti-idle erro:', e.message);
  }

  // ---- PASSO 2: Manter token Bearer (chamar API para manter vivo no servidor) ----
  // Recarregar data pois manterSessaoSSO pode ter atualizado o bearer
  data = await load();
  var idadeToken = Date.now() - (data.bearerTimestamp || data.ultimoEnvio || 0);
  var stats = data.stats || { capturados: 0, enviados: 0, erros: 0, syncs: 0 };

  // Retoken proativo: se bearer tem mais de 5 min, renovar ANTES que expire
  // ---- PASSO 1.8: Renovar token via /sessao/fornecedor/usuario/token/{uuid} ----
  // Essa e a forma mais confiavel — usa o UUID da URL da aba, sem precisar de Bearer valido
  // Renovar Bearer a cada keepalive via retoken (refreshToken) — sem reload
  if (idadeToken > 60000) { // 1 min — renovar proativamente
    console.log("[LiciteAgora] Retoken proativo (bearer com " + Math.floor(idadeToken/1000) + "s)...");
    var retokenProativo = await comprasnetRetoken(tab.id, data.bearer);
    if (retokenProativo.status === 200 && retokenProativo.data && retokenProativo.data.accessToken) {
      var nb = "Bearer " + retokenProativo.data.accessToken;
      await save({ bearer: nb, bearerTimestamp: Date.now(), ultimoEnvio: Date.now() });
      console.log("[LiciteAgora] Keepalive OK — Bearer renovado via retoken proativo (refreshToken)");
      await enviarTokens(nb, data.captcha, stats);
      return;
    }
    console.log("[LiciteAgora] Retoken proativo falhou (HTTP " + retokenProativo.status + ") — tentando reload...");
    var reloadOk = await reloadEAguardarBearer(tab.id, "keepalive-proativo");
    if (reloadOk) {
      console.log("[LiciteAgora] Keepalive OK — Bearer renovado via reload proativo");
      return;
    }
    console.log("[LiciteAgora] Reload proativo também falhou — continuando...");
  }

  if (idadeToken > 180000) { // 3 min
    console.log('[LiciteAgora] 🔄 Bearer com ' + Math.floor(idadeToken/1000) + 's — retoken proativo');
    var proactiveRetoken = await comprasnetRetoken(tab.id, data.bearer);
    if (proactiveRetoken.status === 200 && proactiveRetoken.data && proactiveRetoken.data.accessToken) {
      var newBearer = 'Bearer ' + proactiveRetoken.data.accessToken;
      await save({ bearer: newBearer, bearerTimestamp: Date.now(), ultimoEnvio: Date.now() });
      console.log('[LiciteAgora] ✅ Retoken proativo OK! Bearer renovado');
      await enviarTokens(newBearer, data.captcha, stats);
      try { await serverPost('/api/sniper/log', { tipo: 'retoken-proativo', msg: 'Retoken proativo OK — bearer renovado com ' + Math.floor(idadeToken/1000) + 's' }); } catch(e3){}
      return;
    } else {
      console.log('[LiciteAgora] ⚠️ Retoken proativo falhou (HTTP ' + proactiveRetoken.status + ') — continuando com bearer atual');
    }
  }

  // Chamamos /datahorabrasilia com o bearer para manter a sessão ativa.
  // Só reagimos se o servidor recusar (401/403 = bearer morto).
  var result = await comprasnetFetch(tab.id, '/comprasnet-disputa/v1/datahorabrasilia', data.bearer);

  if (result.status === 200) {
    console.log('[LiciteAgora] ✅ Keepalive OK (SSO + Bearer ' + Math.floor(idadeToken/1000) + 's)');
    await enviarTokens(data.bearer, data.captcha, stats);
  } else if (result.status === 401 || result.status === 403) {
    // Bearer morto — tentar retoken antes de reload
    console.log('[LiciteAgora] ⚠️ Bearer expirado (HTTP ' + result.status + ', ' + Math.floor(idadeToken/1000) + 's) — tentando retoken...');
    var retokenResult = await comprasnetRetoken(tab.id, data.bearer);

    if (retokenResult.status === 200 && retokenResult.data && retokenResult.data.accessToken) {
      var newBearer = 'Bearer ' + retokenResult.data.accessToken;
      console.log('[LiciteAgora] ✅ Retoken OK! Bearer renovado');
      await save({ bearer: newBearer, bearerTimestamp: Date.now(), ultimoEnvio: Date.now() });
      await enviarTokens(newBearer, data.captcha, stats);
      try { await serverPost('/api/sniper/log', { tipo: 'retoken', msg: 'Retoken OK — bearer renovado com ' + Math.floor(idadeToken/1000) + 's' }); } catch(e3){}
    } else {
      // Retoken também falhou — reload aba como último recurso
      console.log('[LiciteAgora] ⚠️ Retoken falhou (HTTP ' + retokenResult.status + ') — reload aba');
      try { await serverPost('/api/sniper/log', { tipo: 'retoken-falha', msg: 'Retoken FALHOU HTTP ' + retokenResult.status + ' — bearer ' + Math.floor(idadeToken/1000) + 's — reload' }); } catch(e3){}

      var reloadOk = await reloadEAguardarBearer(tab.id, 'retoken falhou HTTP ' + retokenResult.status);
      if (!reloadOk) {
        ssoMorto = true;
        console.log('[LiciteAgora] 🛑 ssoMorto=true (retoken falhou + reload falhou)');
        chrome.action.setBadgeText({ text: 'SSO' });
        chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
        await save({ ultimoErro: 'Bearer não renovado — SSO morto, precisa login manual' });
        try { await serverPost('/api/sniper/log', { tipo: 'sso-morto', msg: 'SSO morto: retoken falhou + reload falhou — aguardando login manual' }); } catch(e4){}
      }
    }
  } else {
    console.log('[LiciteAgora] ⚠️ Keepalive: HTTP ' + result.status + ' ' + (result.error || ''));
    // Não é 401/403, pode ser timeout ou erro de rede — apenas enviar tokens
    await enviarTokens(data.bearer, data.captcha, stats);
  }
}

// ==================== DETECÇÃO DE DISPUTAS ENCERRADAS ====================

async function detectarEncerradas(idsEmAndamentoAtual) {
  var data = await load();
  var idsAnterior = data.idsEmAndamento || [];
  var idsDesaparecidos = data.idsDesaparecidos || {}; // { compraId: contadorCiclos }

  // IDs que sumiram: estavam no ciclo anterior mas não no atual
  var setAtual = new Set(idsEmAndamentoAtual);
  var novosDesaparecidos = {};

  for (var id of idsAnterior) {
    if (!setAtual.has(id)) {
      // Incrementar contador de ciclos desaparecido
      novosDesaparecidos[id] = (idsDesaparecidos[id] || 0) + 1;
    }
  }

  // IDs confirmados como encerrados (4+ ciclos consecutivos fora do filtro=5)
  var encerrados = [];
  for (var cid in novosDesaparecidos) {
    if (novosDesaparecidos[cid] >= 4) {
      encerrados.push(cid);
      delete novosDesaparecidos[cid]; // Já reportado, não precisa rastrear mais
    }
  }

  // Salvar estado para próximo ciclo
  await save({
    idsEmAndamento: idsEmAndamentoAtual,
    idsDesaparecidos: novosDesaparecidos,
  });

  // Enviar encerrados ao servidor
  if (encerrados.length > 0) {
    console.log('[LiciteAgora] 🛑 ' + encerrados.length + ' disputas encerradas detectadas: ' + encerrados.join(', '));
    await serverPost('/api/sync/participacoes-encerradas', { compraIds: encerrados });
  }

  return encerrados;
}

// ==================== PERIODIC SYNC via chrome.alarms ====================

chrome.alarms.create('sync', { periodInMinutes: SYNC_INTERVAL_MIN });
chrome.alarms.create('keepalive', { delayInMinutes: 0.5, periodInMinutes: KEEPALIVE_INTERVAL_MIN });

// B1: Adaptive lance polling (variable interval based on server signal)
var lancesPollInterval = 5000;  // default 5s, server can signal 1s
var lancesPollTimer = null;

function agendarProximoPoll() {
  if (lancesPollTimer) clearTimeout(lancesPollTimer);
  lancesPollTimer = setTimeout(function() {
    processarFilaLances();
    processarFilaQueries();
    processarFilaTarefas();
  }, lancesPollInterval);
}

// Start initial poll loop
agendarProximoPoll();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') {
    executarSync();
  } else if (alarm.name === 'keepalive') {
    executarKeepalive();
  } else if (alarm.name === 'blitz-wake') {
    // Blitz agendada está para disparar — poll imediato com intervalo rápido
    console.log('[LiciteAgora] ⏰ Alarm blitz-wake — poll imediato');
    lancesPollInterval = 1000;
    processarFilaLances();
  }
});

// ==================== FILA DE LANCES (via browser) ====================

var lancesEmProcessamento = false;

async function processarFilaLances() {
  if (lancesEmProcessamento) return;
  if (ssoMorto) return; // Não processar lances com SSO morto
  lancesEmProcessamento = true;

  try {
    // 1. Buscar fila do servidor
    var resp = await fetch(SERVER_URL + '/api/sniper/fila-lances', { headers: serverHeaders() });
    if (!resp.ok) { lancesEmProcessamento = false; agendarProximoPoll(); return; }
    var fila = await resp.json();

    // Se há blitz agendada no servidor, criar alarm para acordar a tempo
    var blitzIminente = false;
    if (fila.proximaBlitz && fila.proximaBlitz.diffMs > 0) {
      var diffSec = Math.round(fila.proximaBlitz.diffMs / 1000);
      var alarmDelay = Math.max(0.02, (fila.proximaBlitz.diffMs - 2000) / 60000);
      chrome.alarms.create('blitz-wake', { delayInMinutes: alarmDelay });
      if (fila.proximaBlitz.diffMs < 30000) {
        blitzIminente = true;
        lancesPollInterval = 1000;
        console.log('[LiciteAgora] ⏰ Blitz em ' + diffSec + 's — poll a cada 1s');
      } else {
        console.log('[LiciteAgora] ⏰ Blitz agendada em ' + diffSec + 's — alarm criado');
      }
    }

    // B1: Adaptive polling — adjust interval based on server signal (skip if blitz imminent)
    if (!blitzIminente && fila.pollIntervalMs && fila.pollIntervalMs !== lancesPollInterval) {
      var oldInterval = lancesPollInterval;
      lancesPollInterval = fila.pollIntervalMs;
      if (oldInterval !== lancesPollInterval) {
        console.log('[LiciteAgora] Poll interval: ' + oldInterval + 'ms → ' + lancesPollInterval + 'ms');
      }
    }

    if (!fila.success || !fila.lances || fila.lances.length === 0) {
      lancesEmProcessamento = false;
      agendarProximoPoll();
      return;
    }

    // 2. Verificar prerequisites
    var data = await load();
    if (!data.bearer) {
      console.log('[LiciteAgora] Fila de lances: sem bearer');
      lancesEmProcessamento = false;
      agendarProximoPoll();
      return;
    }
    if (!await tokenEstaFresco()) {
      console.log('[LiciteAgora] Fila de lances: token velho, forçando keepalive');
      executarKeepalive();
      lancesEmProcessamento = false;
      agendarProximoPoll();
      return;
    }
    var tab = await findComprasnetTab();
    if (!tab) {
      console.log('[LiciteAgora] Fila de lances: sem aba Comprasnet');
      lancesEmProcessamento = false;
      agendarProximoPoll();
      return;
    }

    // 3. Processar lances — B3: abort on failure per item, B4: collect batch results
    var batchResultados = [];
    var lancesProcessados = 0;
    var failedItems = {};  // { 'compraId-itemNumero': true } — skip remaining lances for failed items
    for (var lance of fila.lances) {
      // B3: Skip remaining lances for items that already failed
      var itemKey = lance.compraId + '-' + lance.itemNumero;
      if (failedItems[itemKey]) {
        console.log('[LiciteAgora] ⏭️ Pulando lance (item falhou): ' + itemKey + ' R$' + lance.valor);
        batchResultados.push({
          id: lance.id,
          compraId: lance.compraId,
          itemNumero: lance.itemNumero,
          valor: lance.valor,
          status: 0,
          sucesso: false,
          resposta: 'Skipped: previous lance for this item failed',
          tempoMs: 0,
        });
        continue;
      }

      console.log('[LiciteAgora] 🎯 Enviando lance: compra=' + lance.compraId + ' item=' + lance.itemNumero + ' R$' + lance.valor +
        (lance.fonte === 'blitz' ? ' [BLITZ ' + (lance.batchIndex+1) + '/' + lance.batchTotal + ']' :
         lance.fonte === 'auto-continuo' ? ' [CONTÍNUO]' : ''));

      var path = '/comprasnet-disputa/v1/compras/' + lance.compraId + '/itens/' + lance.itemNumero + '/lances';
      var body = { valorInformado: lance.valor, faseItem: lance.faseItem || 'LA' };

      var inicio = Date.now();
      var result = await comprasnetPost(tab.id, path, data.bearer, body);
      var tempoMs = Date.now() - inicio;

      // Retry on 429 (rate limit) — wait and retry up to 3 times with increasing backoff
      if (result.status === 429) {
        var retryDelays = [2000, 4000, 8000]; // 2s, 4s, 8s
        for (var retryAttempt = 0; retryAttempt < retryDelays.length; retryAttempt++) {
          console.log('[LiciteAgora] ⏳ Rate limit 429 — aguardando ' + (retryDelays[retryAttempt]/1000) + 's antes de retry ' + (retryAttempt+1) + '/3');
          await new Promise(function(r) { setTimeout(r, retryDelays[retryAttempt]); });
          result = await comprasnetPost(tab.id, path, data.bearer, body);
          tempoMs = Date.now() - inicio;
          if (result.status !== 429) break;
        }
      }

      var sucesso = result.status === 200 || result.status === 201;
      lancesProcessados++;
      console.log('[LiciteAgora] 🎯 Lance resultado: HTTP ' + result.status + ' (' + tempoMs + 'ms)' + (sucesso ? ' ✅' : ' ❌'));

      // Grupo: lance response returns sub-item data — merge into server cache
      if (sucesso && Array.isArray(result.data) && result.data.length > 0) {
        try {
          var itensResp = result.data.filter(function(it) { return it.numero != null; });
          if (itensResp.length > 0) {
            var disputaUpdate = {
              compraId: lance.compraId,
              itens: itensResp.map(function(it) { return mapearItem(it, {}); }),
              itensAtivos: itensResp.filter(function(it) { return it.podeEnviarLances; }).length,
              totalItens: itensResp.length,
            };
            fetch(SERVER_URL + '/api/sync/disputas', {
              method: 'POST',
              headers: serverHeaders(),
              body: JSON.stringify({ disputas: [disputaUpdate], merge: true }),
            }).catch(function() {});
            console.log('[LiciteAgora] Grupo cache update: ' + itensResp.length + ' itens merged for ' + lance.compraId);
          }
        } catch (e2) {}
      }

      // Mid-batch abort: se ganhando após lance contínuo, parar imediatamente
      if (sucesso && lance.fonte === 'auto-continuo' && Array.isArray(result.data)) {
        if (checarGanhandoNaResposta(result.data, lance.compraId, lance.itemNumero)) {
          console.log('[LiciteAgora] ✅ GANHANDO após R$' + lance.valor + ' — parando batch');
          // Marcar TODOS os itens desta compra como skip (grupo inteiro ganhou)
          for (var fl of fila.lances) {
            if (fl.compraId === lance.compraId) {
              failedItems[fl.compraId + '-' + fl.itemNumero] = true;
            }
          }
        }
      }

      var resultadoLance = {
        id: lance.id,
        compraId: lance.compraId,
        itemNumero: lance.itemNumero,
        valor: lance.valor,
        status: result.status,
        sucesso: sucesso,
        resposta: JSON.stringify(result.data || result.text || result.error).substring(0, 500),
        tempoMs: tempoMs,
      };
      batchResultados.push(resultadoLance);

      // B3: Handle failures
      if (!sucesso) {
        var isContinuo = lance.fonte === 'auto-continuo';
        var is422 = result.status === 422;
        var is401 = result.status === 401;

        if (isContinuo && is401) {
          // 401 during contínuo batch: bearer expired — stop batch immediately,
          // remaining lances will be re-queued by server after keepalive
          console.log('[LiciteAgora] ⚠️ 401 durante batch contínuo — parando para keepalive');
          executarKeepalive();
          break; // don't process remaining lances, report what we have
        }

        if (isContinuo && is422) {
          // 422 for contínuo: value rejected, skip remaining for this item only
          failedItems[itemKey] = true;
        } else if (!isContinuo) {
          failedItems[itemKey] = true;
        }
      }
    }

    // B4: Report results — try batch endpoint first, fallback to individual
    if (batchResultados.length > 0) {
      try {
        var batchResp = await fetch(SERVER_URL + '/api/sniper/resultado-lances-batch', {
          method: 'POST',
          headers: serverHeaders(),
          body: JSON.stringify({ resultados: batchResultados }),
        });
        if (batchResp.ok) {
          console.log('[LiciteAgora] Batch resultado enviado: ' + batchResultados.length + ' lances');
        } else {
          // Fallback: send individually
          throw new Error('Batch endpoint returned HTTP ' + batchResp.status);
        }
      } catch (e) {
        // Fallback: send results individually
        console.log('[LiciteAgora] Batch fallback → individual (' + e.message + ')');
        for (var r of batchResultados) {
          try { await serverPost('/api/sniper/resultado-lance', r); } catch (e2) {}
        }
      }
    }

    // B2: Re-poll immediately after processing lances (tight loop for contínuo)
    // After reporting results, server enqueues next lance instantly —
    // don't wait for poll timer, fetch the queue right away.
    if (lancesProcessados > 0) {
      lancesEmProcessamento = false;
      setTimeout(function() { processarFilaLances(); }, 150);
      return;
    }
  } catch (e) {
    // Silently skip if server not reachable
  }
  lancesEmProcessamento = false;
  agendarProximoPoll();
}

// ==================== FILA DE QUERIES (consultar itens via browser) ====================

async function processarFilaQueries() {
  try {
    var resp = await fetch(SERVER_URL + '/api/sniper/fila-queries', { headers: serverHeaders() });
    if (!resp.ok) return;
    var fila = await resp.json();
    if (!fila.success || !fila.queries || fila.queries.length === 0) return;

    var data = await load();
    if (!data.bearer) return;
    var tab = await findComprasnetTab();
    if (!tab) return;

    for (var query of fila.queries) {
      var compraId = query.compraId;
      console.log('[LiciteAgora] Consultando itens (fila): ' + compraId);

      var resultado = await buscarItensCompra(tab.id, compraId, data.bearer);
      var itens = resultado.itens;

      if (itens && itens.length > 0) {
        await serverPost('/api/sync/disputas', { merge: true, disputas: [{
          compraId: compraId,
          totalItens: itens.length,
          itensAtivos: itens.filter(function(i) { var f = i.fase||i.faseItem||''; return f==='LA'||f==='D1'||f==='D2'||i.podeEnviarLances; }).length,
          itens: itens.map(mapearItem),
        }] });
      } else {
        await serverPost('/api/sync/disputas', { merge: true, disputas: [{
          compraId: compraId,
          totalItens: 1, itensAtivos: 1, stub: true,
          itens: [{
            numero: 1,
            descricao: 'Item 1 (dados da API de itens indisponíveis)',
            fase: 'LA', situacao: '',
            melhorValor: null, nossoValor: null,
            situacaoParticipante: null, variacaoMinima: null,
            podeEnviar: true, fimContagem: null,
            valorEstimado: null, quantidadeSolicitada: null, stub: true,
          }],
        }] });
      }
    }
  } catch (e) {
    // Silently skip
  }
}

// ==================== FILA DE TAREFAS GENÉRICA (testar conexão, participação, proposta) ====================

var tarefasEmProcessamento = false;

async function processarFilaTarefas() {
  if (tarefasEmProcessamento) return;
  tarefasEmProcessamento = true;

  try {
    var resp = await fetch(SERVER_URL + '/api/tarefas/pendentes', { headers: serverHeaders() });
    if (!resp.ok) { tarefasEmProcessamento = false; return; }
    var fila = await resp.json();
    if (!fila.success || !fila.tarefas || fila.tarefas.length === 0) { tarefasEmProcessamento = false; return; }

    var data = await load();
    if (!data.bearer) {
      // Reportar erro para todas as tarefas
      for (var t of fila.tarefas) {
        await serverPost('/api/tarefas/resultado', { id: t.id, sucesso: false, erro: 'Sem Bearer token na extensão' });
      }
      tarefasEmProcessamento = false;
      return;
    }

    var tab = await findComprasnetTab();
    if (!tab) {
      for (var t of fila.tarefas) {
        await serverPost('/api/tarefas/resultado', { id: t.id, sucesso: false, erro: 'Nenhuma aba do Comprasnet encontrada' });
      }
      tarefasEmProcessamento = false;
      return;
    }

    for (var tarefa of fila.tarefas) {
      console.log('[LiciteAgora] Processando tarefa #' + tarefa.id + ' tipo=' + tarefa.tipo);
      var inicio = Date.now();

      try {
        if (tarefa.tipo === 'testar-conexao') {
          var result = await comprasnetFetch(tab.id, '/comprasnet-disputa/v1/datahorabrasilia', data.bearer);
          var tempoMs = Date.now() - inicio;
          var sucesso = result.status === 200;
          await serverPost('/api/tarefas/resultado', {
            id: tarefa.id,
            sucesso: sucesso,
            resultado: { status: result.status, data: result.data, hasCaptcha: result.hasCaptcha },
            erro: sucesso ? null : ('HTTP ' + result.status + (result.error ? ': ' + result.error : '')),
            tempoMs: tempoMs,
          });

        } else if (tarefa.tipo === 'testar-participacao') {
          var compraId = tarefa.dados.compraId;
          if (!compraId) {
            await serverPost('/api/tarefas/resultado', { id: tarefa.id, sucesso: false, erro: 'compraId não informado' });
            continue;
          }
          var result = await comprasnetFetch(tab.id, '/comprasnet-fase-externa/v1/compras/' + compraId + '/participacao', data.bearer);
          var tempoMs = Date.now() - inicio;
          var sucesso = result.status === 200;
          var resumo = null;
          if (sucesso && result.data) {
            resumo = {
              situacao: result.data.situacaoCompraFaseExterna,
              fase: result.data.faseCompraFaseExterna,
              itens: result.data.itensParticipacao ? result.data.itensParticipacao.length : null,
            };
          }
          await serverPost('/api/tarefas/resultado', {
            id: tarefa.id,
            sucesso: sucesso,
            resultado: { status: result.status, resumo: resumo, data: sucesso ? undefined : result.data },
            erro: sucesso ? null : ('HTTP ' + result.status + (result.error ? ': ' + result.error : '')),
            tempoMs: tempoMs,
          });

        } else if (tarefa.tipo === 'enviar-proposta') {
          var compraId = tarefa.dados.compraId;
          var itens = tarefa.dados.itens; // [{ numero, valor, quantidade }]
          if (!compraId || !itens || itens.length === 0) {
            await serverPost('/api/tarefas/resultado', { id: tarefa.id, sucesso: false, erro: 'compraId e itens obrigatórios' });
            continue;
          }

          var resultados = [];
          var todosSucesso = true;

          // Step 1: Declarações (equidade de gênero, etc.) — POST participação
          try {
            var declPath = '/comprasnet-fase-externa/v1/compras/' + compraId + '/participacao';
            var declBody = { declaracaoEquidadeGenero: null };
            var declResult = await comprasnetPost(tab.id, declPath, data.bearer, declBody);
            resultados.push({ etapa: 'declaracao', status: declResult.status, sucesso: declResult.status === 200 || declResult.status === 201 });
            if (declResult.status !== 200 && declResult.status !== 201) {
              // Pode ser que já existe participação — tentar PUT
              var declResult2 = await comprasnetFetch(tab.id, declPath, data.bearer);
              if (declResult2.status !== 200) {
                todosSucesso = false;
              }
            }
          } catch (e) {
            resultados.push({ etapa: 'declaracao', erro: e.message, sucesso: false });
            todosSucesso = false;
          }

          // Step 2: Enviar proposta para cada item
          for (var item of itens) {
            try {
              var itemPath = '/comprasnet-fase-externa/v1/compras/' + compraId + '/itens/' + item.numero + '/proposta';
              var itemBody = {
                valorUnitario: item.valor,
                quantidade: item.quantidade || 1,
              };
              var itemResult = await comprasnetPost(tab.id, itemPath, data.bearer, itemBody);
              var itemSucesso = itemResult.status === 200 || itemResult.status === 201;
              resultados.push({
                etapa: 'proposta-item-' + item.numero,
                status: itemResult.status,
                sucesso: itemSucesso,
                resposta: itemResult.data,
              });
              if (!itemSucesso) todosSucesso = false;
            } catch (e) {
              resultados.push({ etapa: 'proposta-item-' + item.numero, erro: e.message, sucesso: false });
              todosSucesso = false;
            }
          }

          var tempoMs = Date.now() - inicio;
          await serverPost('/api/tarefas/resultado', {
            id: tarefa.id,
            sucesso: todosSucesso,
            resultado: { resultados: resultados, sucessos: resultados.filter(function(r) { return r.sucesso; }).length, total: resultados.length },
            erro: todosSucesso ? null : 'Uma ou mais etapas falharam',
            tempoMs: tempoMs,
          });

        } else {
          await serverPost('/api/tarefas/resultado', { id: tarefa.id, sucesso: false, erro: 'Tipo desconhecido: ' + tarefa.tipo });
        }
      } catch (e) {
        console.error('[LiciteAgora] Erro na tarefa #' + tarefa.id + ':', e.message);
        await serverPost('/api/tarefas/resultado', { id: tarefa.id, sucesso: false, erro: e.message, tempoMs: Date.now() - inicio });
      }
    }
  } catch (e) {
    // Silently skip if server not reachable
  }
  tarefasEmProcessamento = false;
}

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

    case 'forceSyncDisputas': {
      // Força sync de disputas agora
      const tabD = await findComprasnetTab();
      const dataD = await load();
      if (!tabD) return { ok: false, error: 'Nenhuma aba Comprasnet aberta' };
      if (!dataD.bearer) return { ok: false, error: 'Sem Bearer token' };
      const parts = await syncParticipacoesFiltros(tabD.id, dataD.bearer, [5]);
      await syncDisputas(tabD.id, parts, dataD.bearer);
      return { ok: true, message: 'Disputas verificadas' };
    }

    case 'queryItens': {
      // Consulta itens de uma compra específica via estratégia inteligente
      const tabQ = await findComprasnetTab();
      const dataQ = await load();
      if (!tabQ) return { ok: false, error: 'Nenhuma aba Comprasnet aberta' };
      if (!dataQ.bearer) return { ok: false, error: 'Sem Bearer token' };
      const compId = msg.compraId;
      if (!compId) return { ok: false, error: 'compraId obrigatório' };

      var resultado = await buscarItensCompra(tabQ.id, compId, dataQ.bearer);
      var qiItens = resultado.itens;
      if (!qiItens) return { ok: false, error: 'Não foi possível consultar itens' };

      await serverPost('/api/sync/disputas', { merge: true, disputas: [{
        compraId: compId,
        totalItens: qiItens.length,
        itensAtivos: qiItens.filter(function(i) { var f = i.fase||i.faseItem||''; return f==='LA'||f==='D1'||f==='D2'||i.podeEnviarLances; }).length,
        itens: qiItens.map(mapearItem),
      }] });
      return { ok: true, itens: qiItens };
    }

    case 'resetStats':
      await save({ stats: { capturados: 0, enviados: 0, erros: 0, syncs: 0 }, ultimoErro: null });
      return { ok: true };

    case 'updateApiKey':
      SERVER_API_KEY = msg.key || '';
      return { ok: true };

    default:
      return { ok: false, error: 'Tipo desconhecido' };
  }
}
