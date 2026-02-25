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
const SYNC_INTERVAL_MIN = 2; // sync a cada 2 minutos
const KEEPALIVE_INTERVAL_MIN = 2; // keepalive a cada 2 minutos
const TOKEN_MAX_AGE_MS = 540000; // 9 min (margem de segurança; Comprasnet expira em 10)
let syncAgendado = false;
let syncEmExecucao = false;
let aguardandoNovoBearer = false; // flag: reload feito, esperando novo token

console.log('[LiciteAgora] Service worker v3.5.0 carregado!');

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
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout 20s')), 20000));
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

    const results = await Promise.race([exec, timeout]);
    return results[0]?.result || { status: 0, error: 'No result from tab' };
  } catch (e) {
    console.error('[LiciteAgora] comprasnetFetch ERRO:', path.substring(0, 60), e.message);
    return { status: 0, error: e.message };
  }
}

/**
 * POST autenticado no Comprasnet VIA BROWSER (mesmo IP = token válido).
 * Usado para enviar lances.
 */
async function comprasnetPost(tabId, path, bearer, body) {
  try {
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
              'x-version-number': '5.5.2',
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
 * Envia dados ao servidor LiciteAgora.
 */
async function serverPost(path, body) {
  try {
    const resp = await fetch(SERVER_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    // 2. Buscar mensagens apenas das participações EM ANDAMENTO (filtro=5)
    const emAndamento = participacoes.filter(function(p) {
      return p._filtro === 5;
    });

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

    if (emAndamento.length > 0) {
      console.log('[LiciteAgora] ' + emAndamento.length + ' em andamento (de ' + participacoes.length + ' total) — buscando mensagens...');
      await syncMensagens(tab.id, emAndamento, data.bearer);
      // Verificar disputas ativas (itens em fase de lance)
      await syncDisputas(tab.id, emAndamento, data.bearer);
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
    return await syncParticipacoesFiltros(tabId, bearer, [5, 2, 6]);
  } else {
    console.log('[LiciteAgora] Sync rápido (em andamento)...');
    return await syncParticipacoesFiltros(tabId, bearer, [5]);
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
async function buscarItensCompra(tabId, compraId, bearer) {
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

  return { itens: itens, endpoint: endpointUsado, qtdes: qtdes };
}

/**
 * Extrai melhor valor (lance global) de um item.
 */
function extrairMelhorValor(item) {
  var mv = item.melhorValorGeral || item.melhorLanceGeral;
  if (mv && mv.valorInformado != null) return mv.valorInformado;
  if (mv && mv.valor != null) return mv.valor;
  if (mv && mv.valorCalculado) {
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
 * Mapeia item da API para formato padronizado enviado ao servidor.
 */
function mapearItem(i) {
  return {
    numero: i.numero || i.identificador,
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

  for (var p of participacoesEmAndamento) {
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

    // Buscar itens via estratégia inteligente (/qtdes → fase → endpoint correto)
    var resultado = await buscarItensCompra(tabId, compraId, bearer);
    var itens = resultado.itens;

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
      itens: itens.map(mapearItem),
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
 * Pinga uma página do comprasnet-web DENTRO da aba para renovar cookies da sessão SSO.
 * Sem isso, a sessão SSO expira mesmo que o Bearer ainda funcione.
 */
async function manterSessaoSSO(tabId) {
  try {
    var result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (baseUrl) => {
        try {
          var resp = await fetch(baseUrl + '/comprasnet-web/seguro/fornecedor/compras', {
            method: 'HEAD',
            credentials: 'include',
          });
          return { status: resp.status, type: resp.type, ok: resp.ok };
        } catch (e) {
          return { status: 0, error: e.message };
        }
      },
      args: [COMPRASNET],
    });
    var r = result[0]?.result || { status: 0 };
    if (r.status === 200 || r.ok) {
      console.log('[LiciteAgora] 🔒 SSO session refreshed (HTTP ' + r.status + ')');
      return true;
    } else {
      console.log('[LiciteAgora] ⚠️ SSO refresh: HTTP ' + r.status + ' type=' + (r.type || '') + ' ' + (r.error || ''));
      return r.status !== 401 && r.status !== 403 && r.type !== 'opaqueredirect';
    }
  } catch (e) {
    console.log('[LiciteAgora] ⚠️ SSO refresh erro:', e.message);
    return false;
  }
}

async function executarKeepalive() {
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

  var idadeMs = Date.now() - (data.ultimoEnvio || 0);
  console.log('[LiciteAgora] 🔄 Keepalive: token com ' + Math.floor(idadeMs/1000) + 's');

  // ---- PASSO 1: Manter sessão SSO (cookies do comprasnet-web) ----
  var ssoOk = await manterSessaoSSO(tab.id);

  if (!ssoOk) {
    // Pode ser falta de permissão (aba aberta antes da extensão) ou SSO morto.
    // Tentar recarregar a aba para ganhar acesso e renovar sessão.
    console.log('[LiciteAgora] ⚠️ SSO falhou — recarregando aba para recuperar acesso...');
    aguardandoNovoBearer = true;
    chrome.action.setBadgeText({ text: '⏳' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });

    try {
      await chrome.tabs.reload(tab.id);
    } catch (e) {
      console.error('[LiciteAgora] Erro recarregando aba:', e.message);
      aguardandoNovoBearer = false;
    }

    // Timeout de segurança
    setTimeout(async () => {
      if (aguardandoNovoBearer) {
        aguardandoNovoBearer = false;
        console.log('[LiciteAgora] ⚠️ Timeout: novo bearer não chegou após reload');
        // Verificar se é problema de SSO ou apenas permissão
        var ssoRecuperavel = await verificarSessaoSSO();
        if (!ssoRecuperavel) {
          chrome.action.setBadgeText({ text: 'SSO' });
          chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
          await save({ ultimoErro: 'Sessão SSO expirada — faça login no Comprasnet' });
        } else {
          chrome.action.setBadgeText({ text: '!' });
          chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
          await save({ ultimoErro: 'Bearer não renovado após reload (timeout 30s)' });
        }
      }
    }, 30000);
    return;
  }

  // ---- PASSO 2: Manter token Bearer (API comprasnet-disputa) ----
  var result = await comprasnetFetch(tab.id, '/comprasnet-disputa/v1/datahorabrasilia', data.bearer);

  if (result.status === 401 || result.status === 403) {
    console.log('[LiciteAgora] ⚠️ Bearer expirado (HTTP ' + result.status + ') — recarregando aba...');
    aguardandoNovoBearer = true;
    chrome.action.setBadgeText({ text: '⏳' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });

    try {
      await chrome.tabs.reload(tab.id);
    } catch (e) {
      console.error('[LiciteAgora] Erro recarregando aba:', e.message);
      aguardandoNovoBearer = false;
    }

    setTimeout(async () => {
      if (aguardandoNovoBearer) {
        aguardandoNovoBearer = false;
        console.log('[LiciteAgora] ⚠️ Timeout: novo bearer não chegou após reload');
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
        await save({ ultimoErro: 'Bearer não renovado após reload (timeout 30s)' });
      }
    }, 30000);

  } else if (result.status === 200) {
    console.log('[LiciteAgora] ✅ Keepalive OK (SSO + Bearer)');
    await enviarTokens(data.bearer, data.captcha, data.stats || { capturados: 0, enviados: 0, erros: 0, syncs: 0 });

  } else if (result.status === 0 && result.error && result.error.includes('Cannot access')) {
    // Sem permissão para injetar na aba — recarregar resolve
    console.log('[LiciteAgora] ⚠️ Sem acesso à aba — recarregando para obter permissão...');
    aguardandoNovoBearer = true;
    chrome.action.setBadgeText({ text: '⏳' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });

    try {
      await chrome.tabs.reload(tab.id);
    } catch (e) {
      console.error('[LiciteAgora] Erro recarregando aba:', e.message);
      aguardandoNovoBearer = false;
    }

    setTimeout(async () => {
      if (aguardandoNovoBearer) {
        aguardandoNovoBearer = false;
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
        await save({ ultimoErro: 'Sem acesso à aba após reload — recarregue manualmente' });
      }
    }, 30000);

  } else {
    console.log('[LiciteAgora] ⚠️ Keepalive: HTTP ' + result.status + ' ' + (result.error || ''));
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

  // IDs confirmados como encerrados (2+ ciclos consecutivos fora do filtro=5)
  var encerrados = [];
  for (var cid in novosDesaparecidos) {
    if (novosDesaparecidos[cid] >= 2) {
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
  }, lancesPollInterval);
}

// Start initial poll loop
agendarProximoPoll();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') {
    executarSync();
  } else if (alarm.name === 'keepalive') {
    executarKeepalive();
  }
});

// ==================== FILA DE LANCES (via browser) ====================

var lancesEmProcessamento = false;

async function processarFilaLances() {
  if (lancesEmProcessamento) return;
  lancesEmProcessamento = true;

  try {
    // 1. Buscar fila do servidor
    var resp = await fetch(SERVER_URL + '/api/sniper/fila-lances');
    if (!resp.ok) { lancesEmProcessamento = false; agendarProximoPoll(); return; }
    var fila = await resp.json();

    // B1: Adaptive polling — adjust interval based on server signal
    if (fila.pollIntervalMs && fila.pollIntervalMs !== lancesPollInterval) {
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
        (lance.fonte === 'blitz' ? ' [BLITZ ' + (lance.batchIndex+1) + '/' + lance.batchTotal + ']' : ''));

      var path = '/comprasnet-disputa/v1/compras/' + lance.compraId + '/itens/' + lance.itemNumero + '/lances';
      var body = { valorInformado: lance.valor, faseItem: lance.faseItem || 'LA' };

      var inicio = Date.now();
      var result = await comprasnetPost(tab.id, path, data.bearer, body);
      var tempoMs = Date.now() - inicio;

      var sucesso = result.status === 200 || result.status === 201;
      lancesProcessados++;
      console.log('[LiciteAgora] 🎯 Lance resultado: HTTP ' + result.status + ' (' + tempoMs + 'ms)' + (sucesso ? ' ✅' : ' ❌'));

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

      // B3: Mark item as failed to skip remaining lances in batch
      if (!sucesso) {
        failedItems[itemKey] = true;
      }
    }

    // B4: Report results — try batch endpoint first, fallback to individual
    if (batchResultados.length > 0) {
      try {
        var batchResp = await fetch(SERVER_URL + '/api/sniper/resultado-lances-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

    // B2: Re-poll immediately if processed 3+ lances (might be more waiting)
    if (lancesProcessados >= 3) {
      console.log('[LiciteAgora] Re-poll imediato (batch ' + lancesProcessados + ' lances)');
      setTimeout(function() { processarFilaLances(); }, 200);
    }
  } catch (e) {
    // Silently skip if server not reachable
  } finally {
    lancesEmProcessamento = false;
    agendarProximoPoll();
  }
}

// ==================== FILA DE QUERIES (consultar itens via browser) ====================

async function processarFilaQueries() {
  try {
    var resp = await fetch(SERVER_URL + '/api/sniper/fila-queries');
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

    default:
      return { ok: false, error: 'Tipo desconhecido' };
  }
}
