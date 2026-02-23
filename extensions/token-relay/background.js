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
let syncAgendado = false;
let syncEmExecucao = false;

console.log('[LiciteAgora] Service worker v3.3.1 carregado!');

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

// ==================== SYNC DISPUTAS (itens em disputa) ====================

/**
 * Consulta itens das participações em andamento PELO BROWSER (captcha IP OK).
 * Envia resultado ao servidor para que GET /api/sniper/disputas-ativas funcione.
 */
async function syncDisputas(tabId, participacoesEmAndamento, bearer) {
  if (!participacoesEmAndamento || participacoesEmAndamento.length === 0) return;

  console.log('[LiciteAgora] 🔥 Verificando disputas em ' + participacoesEmAndamento.length + ' participações...');
  var disputas = [];
  var debugItemLogged = false;

  for (var p of participacoesEmAndamento) {
    var compraId = p.codigoCompra || p.compraId;
    
    // Debug: log primeira participação para descobrir campos
    if (disputas.length === 0 && !compraId) {
      var compra = p.compra || {};
      console.log('[LiciteAgora] 📋 DEBUG participação keys:', JSON.stringify(Object.keys(p).sort()));
      console.log('[LiciteAgora] 📋 DEBUG p.compra keys:', JSON.stringify(Object.keys(compra).sort()));
      // Tentar extrair compraId de p.compra
      var altId = compra.codigoCompra || compra.id || compra.identificador || '';
      console.log('[LiciteAgora] 📋 DEBUG compraId tentativas: p.codigoCompra=' + p.codigoCompra + ' p.compraId=' + p.compraId + ' compra.codigoCompra=' + compra.codigoCompra + ' compra.id=' + compra.id);
    }
    
    // Fallback: tentar extrair de p.compra ou reconstruir
    if (!compraId) {
      var compra = p.compra || {};
      compraId = compra.codigoCompra || compra.id || compra.identificador || '';
      if (!compraId) {
        // Reconstruir como no sync de participações
        var uasg = String(compra.numeroUasg || p.numeroUasg || 0).padStart(6, '0');
        var mod = String(compra.modalidade || p.modalidade || 0).padStart(2, '0');
        var num = String(compra.numero || p.numero || 0).padStart(5, '0');
        var ano = String(compra.ano || p.ano || '');
        if (ano) compraId = uasg + mod + num + ano;
      }
    }
    if (!compraId) continue;

    // Tentar endpoints em ordem de riqueza de dados:
    // 1. classificacao (tem melhorValorGeral + melhorValorFornecedor)
    // 2. melhor-lance (resumo de melhores lances por item)
    // 3. fase-externa em-selecao (dados de seleção — sem preços de lance)
    // 4. disputa itens (básico, sem preços)
    var endpoints = [
      '/comprasnet-disputa/v1/compras/' + compraId + '/itens/classificacao',
      '/comprasnet-disputa/v1/compras/' + compraId + '/itens/melhor-lance',
      '/comprasnet-fase-externa/v1/compras/' + compraId + '/itens/em-selecao-fornecedores',
      '/comprasnet-disputa/v1/compras/' + compraId + '/itens',
    ];

    var itens = null;
    var endpointUsado = '';
    var epResultados = [];
    for (var ep of endpoints) {
      try {
        var result = await comprasnetFetch(tabId, ep, bearer);
        var epNome = ep.split('/v1/')[1] || ep;
        epResultados.push(epNome + '→' + result.status);
        if (result.status === 200 || result.status === 206) {
          var dados = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);
          if (dados.length > 0) {
            itens = dados;
            endpointUsado = epNome;
            break;
          }
        }
      } catch (e) {
        epResultados.push((ep.split('/v1/')[1] || ep) + '→ERR:' + e.message);
      }
    }
    // Log resultado dos endpoints (apenas primeiras 5 disputas)
    if (disputas.length < 5) {
      console.log('[LiciteAgora] ' + compraId + ': ' + epResultados.join(' | ') + (itens ? ' ✅ ' + itens.length + ' itens' : ' ❌ stub'));
    }

    // Se pegou itens de endpoint sem preços, tentar enriquecer com classificacao
    if (itens && itens.length > 0 && endpointUsado.indexOf('classificacao') === -1) {
      try {
        var classResult = await comprasnetFetch(tabId,
          '/comprasnet-disputa/v1/compras/' + compraId + '/itens/classificacao', bearer);
        if (classResult.status === 200 || classResult.status === 206) {
          var classItens = Array.isArray(classResult.data) ? classResult.data : [];
          if (classItens.length > 0) {
            // Criar mapa por numero para merge
            var classMap = {};
            classItens.forEach(function(ci) { classMap[ci.numero || ci.identificador] = ci; });
            itens.forEach(function(it) {
              var ci = classMap[it.numero || it.identificador];
              if (ci) {
                if (!it.melhorValorGeral && ci.melhorValorGeral) it.melhorValorGeral = ci.melhorValorGeral;
                if (!it.melhorValorFornecedor && ci.melhorValorFornecedor) it.melhorValorFornecedor = ci.melhorValorFornecedor;
                if (it.podeEnviarLances === undefined) it.podeEnviarLances = ci.podeEnviarLances;
              }
            });
          }
        }
      } catch (e) {}
    }

    // Se ambos endpoints de itens falharam (comum em Dispensas),
    // criar entrada stub a partir dos dados da participação
    if (!itens || itens.length === 0) {
      // Verificar se participação parece ativa (faseCompra == 3 ou emDisputa, ou simplesmente em andamento)
      var faseCompra = p.faseCompra || p.fase || '';
      var emDisputa = p.emDisputa || (String(faseCompra) === '3');
      // filtro=5 já indica "em andamento" — criar stub para qualquer uma cujos itens falharam
      var isEmAndamento = p._filtro === 5 || emDisputa;
      
      if (isEmAndamento) {
        // Criar stub com dados da participação (sem detalhes de itens)
        var qtdItens = p.quantidadeItens || p.quantidadeDeItens || p.quantidadeItensCompra || p.totalItens || p.qtdItens || p.numeroItens || 1;
        // Log campos da participação para debug (apenas primeira vez)
        if (disputas.length === 0) {
          var campos = Object.keys(p).filter(function(k) { return typeof p[k] !== 'object' || p[k] === null; });
          console.log('[LiciteAgora] 📋 Campos da participação:', JSON.stringify(campos));
          // Log campos numéricos que podem ser qtd de itens
          var nums = {};
          Object.keys(p).forEach(function(k) { if (typeof p[k] === 'number') nums[k] = p[k]; });
          console.log('[LiciteAgora] 📋 Campos numéricos:', JSON.stringify(nums));
        }
        var stubItens = [];
        for (var si = 1; si <= Math.min(qtdItens, 10); si++) {
          stubItens.push({
            numero: si,
            descricao: (qtdItens === 1 ? (p.objeto || p.objetoCompra || 'Item ' + si) : 'Item ' + si + ' — ' + (p.objeto || p.objetoCompra || '')).substring(0, 120),
            fase: emDisputa ? 'LA' : '',
            situacao: '',
            melhorValor: null,
            nossoValor: null,
            podeEnviar: emDisputa,
            fimContagem: p.dataHoraFimSessaoPublica || p.dataFimLance || null,
            valorEstimado: null,
            quantidadeSolicitada: null,
            stub: true,
          });
        }
        disputas.push({
          compraId: compraId,
          orgao: p.nomeUasg || p.orgao || '',
          objeto: p.objeto || p.objetoCompra || '',
          dataSessao: p.dataHoraInicioSessaoPublica || p.dataSessao || '',
          totalItens: qtdItens,
          itensAtivos: emDisputa ? qtdItens : 0,
          stub: true,
          itens: stubItens,
        });
        console.log('[LiciteAgora] 📋 Disputa stub para ' + compraId + ' (' + qtdItens + ' itens, emDisputa=' + emDisputa + ')');
      }
      continue;
    }

    // Debug: log detalhado do primeiro item para identificar campos de preço
    if (itens.length > 0 && !debugItemLogged) {
      debugItemLogged = true;
      var primeiro = itens[0];
      // Log campos que têm valores numéricos ou objetos (potenciais preços)
      var camposRelevantes = {};
      Object.keys(primeiro).forEach(function(k) {
        var v = primeiro[k];
        if (typeof v === 'number' || (typeof v === 'object' && v !== null)) {
          camposRelevantes[k] = v;
        }
      });
      console.log('[LiciteAgora] 📋 Item[0] endpoint=' + endpointUsado + ' camposRelevantes=' + JSON.stringify(camposRelevantes));
      console.log('[LiciteAgora] 📋 Item[0] ALL keys=' + JSON.stringify(Object.keys(primeiro).sort()));
      if (primeiro.propostaItem) console.log('[LiciteAgora] 📋 propostaItem=' + JSON.stringify(primeiro.propostaItem));
    }

    // Filtrar itens em fase de lance
    var itensAtivos = itens.filter(function(item) {
      var fase = item.fase || item.faseItem || '';
      return fase === 'LA' || fase === 'D1' || fase === 'D2' || item.podeEnviarLances === true;
    });

    // Extrair melhor valor — tenta vários nomes de campo
    function extrairMelhorValor(item) {
      // Campos do endpoint /classificacao
      var mv = item.melhorValorGeral || item.melhorLanceGeral || item.classificacaoGeral;
      if (mv && mv.valorInformado != null) return mv.valorInformado;
      if (mv && mv.valor != null) return mv.valor;
      // Campos do endpoint /melhor-lance
      if (item.valorMelhorLance != null) return item.valorMelhorLance;
      if (item.melhorValor != null) return item.melhorValor;
      if (item.valorUnitario != null) return item.valorUnitario;
      if (item.valor != null && typeof item.valor === 'number') return item.valor;
      return null;
    }
    function extrairNossoValor(item) {
      // Campos do endpoint /classificacao
      var nv = item.melhorValorFornecedor || item.melhorLanceFornecedor || item.classificacaoFornecedor;
      if (nv && nv.valorInformado != null) return nv.valorInformado;
      if (nv && nv.valor != null) return nv.valor;
      if (item.valorNossoLance != null) return item.valorNossoLance;
      if (item.nossoValor != null) return item.nossoValor;
      // propostaItem do /em-selecao-fornecedores pode ter nosso lance
      if (item.propostaItem) {
        var pi = item.propostaItem;
        if (pi.valorUnitario != null) return pi.valorUnitario;
        if (pi.valor != null) return pi.valor;
        if (pi.valorInformado != null) return pi.valorInformado;
      }
      return null;
    }

    disputas.push({
      compraId: compraId,
      orgao: p.nomeUasg || p.orgao || '',
      objeto: p.objeto || '',
      dataSessao: p.dataHoraInicioSessaoPublica || p.dataSessao || '',
      totalItens: itens.length,
      itensAtivos: itensAtivos.length,
      itens: itens.map(function(i) {
        return {
          numero: i.numero || i.identificador,
          descricao: (i.descricao || i.objetoItem || '').substring(0, 120),
          fase: i.fase || i.faseItem || '',
          situacao: i.situacao || '',
          melhorValor: extrairMelhorValor(i),
          nossoValor: extrairNossoValor(i),
          podeEnviar: i.podeEnviarLances || false,
          fimContagem: i.dataHoraFimContagem || null,
          valorEstimado: i.valorEstimado || null,
          quantidadeSolicitada: i.quantidadeSolicitada || null,
        };
      }),
    });
  }

  // Enviar ao servidor
  try {
    await serverPost('/api/sync/disputas', { disputas: disputas });
    console.log('[LiciteAgora] 🔥 ' + disputas.length + ' disputas enviadas ao servidor (' +
      disputas.filter(function(d) { return d.itensAtivos > 0; }).length + ' com itens ativos)');
  } catch (e) {
    console.error('[LiciteAgora] Erro enviando disputas:', e.message);
  }
}

// ==================== KEEPALIVE (mantém token Bearer ativo) ====================

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

  console.log('[LiciteAgora] 🔄 Keepalive: chamando datahorabrasilia...');
  var result = await comprasnetFetch(tab.id, '/comprasnet-disputa/v1/datahorabrasilia', data.bearer);

  if (result.status === 401 || result.status === 403) {
    console.log('[LiciteAgora] ⚠️ Keepalive: token expirado (HTTP ' + result.status + ') — recarregando aba');
    try {
      await chrome.tabs.reload(tab.id);
    } catch (e) {
      console.error('[LiciteAgora] Erro recarregando aba:', e.message);
    }
  } else if (result.status === 200) {
    console.log('[LiciteAgora] ✅ Keepalive OK');
    // Reenviar token ao servidor para manter timestamp atualizado
    await enviarTokens(data.bearer, data.captcha, data.stats || { capturados: 0, enviados: 0, erros: 0, syncs: 0 });
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
chrome.alarms.create('keepalive', { delayInMinutes: 1, periodInMinutes: 4 });

// Lance polling via setInterval (alarms have 1 min minimum)
setInterval(function() {
  processarFilaLances();
  processarFilaQueries();
}, 5000);

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
    if (!resp.ok) { lancesEmProcessamento = false; return; }
    var fila = await resp.json();
    if (!fila.success || !fila.lances || fila.lances.length === 0) {
      lancesEmProcessamento = false;
      return;
    }

    // 2. Verificar prerequisites
    var data = await load();
    if (!data.bearer) {
      console.log('[LiciteAgora] Fila de lances: sem bearer');
      lancesEmProcessamento = false;
      return;
    }
    var tab = await findComprasnetTab();
    if (!tab) {
      console.log('[LiciteAgora] Fila de lances: sem aba Comprasnet');
      lancesEmProcessamento = false;
      return;
    }

    // 3. Processar cada lance pendente
    for (var lance of fila.lances) {
      console.log('[LiciteAgora] 🎯 Enviando lance: compra=' + lance.compraId + ' item=' + lance.itemNumero + ' R$' + lance.valor);

      var path = '/comprasnet-disputa/v1/compras/' + lance.compraId + '/itens/' + lance.itemNumero + '/lances';
      var body = { valorInformado: lance.valor, faseItem: lance.faseItem || 'LA' };

      var inicio = Date.now();
      var result = await comprasnetPost(tab.id, path, data.bearer, body);
      var tempoMs = Date.now() - inicio;

      var sucesso = result.status === 200 || result.status === 201;
      console.log('[LiciteAgora] 🎯 Lance resultado: HTTP ' + result.status + ' (' + tempoMs + 'ms)' + (sucesso ? ' ✅' : ' ❌'));

      // 4. Reportar resultado ao servidor
      try {
        await serverPost('/api/sniper/resultado-lance', {
          id: lance.id,
          compraId: lance.compraId,
          itemNumero: lance.itemNumero,
          valor: lance.valor,
          status: result.status,
          sucesso: sucesso,
          resposta: JSON.stringify(result.data || result.text || result.error).substring(0, 500),
          tempoMs: tempoMs,
        });
      } catch (e) {
        console.error('[LiciteAgora] Erro reportando lance:', e.message);
      }
    }
  } catch (e) {
    // Silently skip if server not reachable
  } finally {
    lancesEmProcessamento = false;
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
      console.log('[LiciteAgora] 🔍 Consultando itens (fila): ' + compraId);

      var endpoints = [
        '/comprasnet-disputa/v1/compras/' + compraId + '/itens/classificacao',
        '/comprasnet-fase-externa/v1/compras/' + compraId + '/itens/em-selecao-fornecedores',
        '/comprasnet-disputa/v1/compras/' + compraId + '/itens',
      ];

      var itens = null;
      var qEndpoint = '';
      for (var ep of endpoints) {
        try {
          var result = await comprasnetFetch(tab.id, ep, data.bearer);
          if (result.status === 200 || result.status === 206) {
            var dados = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);
            if (dados.length > 0) {
              itens = dados;
              qEndpoint = ep.split('/v1/')[1] || ep;
              console.log('[LiciteAgora] ✅ ' + itens.length + ' itens encontrados para ' + compraId + ' (' + qEndpoint + ')');
              break;
            }
          }
        } catch (e) {}
      }

      // Enriquecer com classificacao se necessário
      if (itens && itens.length > 0 && qEndpoint.indexOf('classificacao') === -1) {
        try {
          var cr = await comprasnetFetch(tab.id, '/comprasnet-disputa/v1/compras/' + compraId + '/itens/classificacao', data.bearer);
          if (cr.status === 200 || cr.status === 206) {
            var ci = Array.isArray(cr.data) ? cr.data : [];
            var cm = {}; ci.forEach(function(c) { cm[c.numero || c.identificador] = c; });
            itens.forEach(function(it) {
              var c = cm[it.numero || it.identificador];
              if (c) {
                if (!it.melhorValorGeral && c.melhorValorGeral) it.melhorValorGeral = c.melhorValorGeral;
                if (!it.melhorValorFornecedor && c.melhorValorFornecedor) it.melhorValorFornecedor = c.melhorValorFornecedor;
              }
            });
          }
        } catch (e) {}
      }

      if (itens && itens.length > 0) {
        // Helper extrair preços (mesma lógica do syncDisputas)
        function qMelhor(item) {
          var mv = item.melhorValorGeral || item.melhorLanceGeral || item.classificacaoGeral;
          if (mv && mv.valorInformado != null) return mv.valorInformado;
          if (mv && mv.valor != null) return mv.valor;
          if (item.valorMelhorLance != null) return item.valorMelhorLance;
          return null;
        }
        function qNosso(item) {
          var nv = item.melhorValorFornecedor || item.melhorLanceFornecedor || item.classificacaoFornecedor;
          if (nv && nv.valorInformado != null) return nv.valorInformado;
          if (nv && nv.valor != null) return nv.valor;
          return null;
        }
        await serverPost('/api/sync/disputas', { merge: true, disputas: [{ compraId: compraId,
          totalItens: itens.length,
          itensAtivos: itens.filter(function(i) { var f = i.fase||i.faseItem||''; return f==='LA'||f==='D1'||f==='D2'||i.podeEnviarLances; }).length,
          itens: itens.map(function(i) {
            return {
              numero: i.numero || i.identificador,
              descricao: (i.descricao || i.objetoItem || '').substring(0, 120),
              fase: i.fase || i.faseItem || '',
              situacao: i.situacao || '',
              melhorValor: qMelhor(i),
              nossoValor: qNosso(i),
              podeEnviar: i.podeEnviarLances || false,
              fimContagem: i.dataHoraFimContagem || null,
              valorEstimado: i.valorEstimado || null,
              quantidadeSolicitada: i.quantidadeSolicitada || null,
            };
          }),
        }] });
      } else {
        // Endpoints de itens falharam (comum em Dispensas) — reportar stub
        console.log('[LiciteAgora] 📋 Query stub para ' + compraId + ' (endpoints de itens falharam)');
        await serverPost('/api/sync/disputas', { merge: true, disputas: [{ compraId: compraId,
          totalItens: 1,
          itensAtivos: 1,
          stub: true,
          itens: [{
            numero: 1,
            descricao: 'Item 1 (dados da API de itens indisponíveis)',
            fase: 'LA',
            situacao: '',
            melhorValor: null,
            nossoValor: null,
            podeEnviar: true,
            fimContagem: null,
            valorEstimado: null,
            quantidadeSolicitada: null,
            stub: true,
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
      // Consulta itens de uma compra específica
      const tabQ = await findComprasnetTab();
      const dataQ = await load();
      if (!tabQ) return { ok: false, error: 'Nenhuma aba Comprasnet aberta' };
      if (!dataQ.bearer) return { ok: false, error: 'Sem Bearer token' };
      const compId = msg.compraId;
      if (!compId) return { ok: false, error: 'compraId obrigatório' };

      var qiEndpoints = [
        '/comprasnet-disputa/v1/compras/' + compId + '/itens/classificacao',
        '/comprasnet-fase-externa/v1/compras/' + compId + '/itens/em-selecao-fornecedores',
        '/comprasnet-disputa/v1/compras/' + compId + '/itens',
      ];
      var qiItens = null;
      var qiEp = '';
      for (var ep of qiEndpoints) {
        try {
          var result = await comprasnetFetch(tabQ.id, ep, dataQ.bearer);
          if (result.status === 200 || result.status === 206) {
            var arr = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);
            if (arr.length > 0) { qiItens = arr; qiEp = ep; break; }
          }
        } catch (e) {}
      }
      if (!qiItens) return { ok: false, error: 'Não foi possível consultar itens' };

      // Enriquecer com classificacao se não veio dela
      if (qiEp.indexOf('classificacao') === -1) {
        try {
          var cr = await comprasnetFetch(tabQ.id, '/comprasnet-disputa/v1/compras/' + compId + '/itens/classificacao', dataQ.bearer);
          if (cr.status === 200 || cr.status === 206) {
            var ci = Array.isArray(cr.data) ? cr.data : [];
            var cm = {}; ci.forEach(function(c) { cm[c.numero || c.identificador] = c; });
            qiItens.forEach(function(it) {
              var c = cm[it.numero || it.identificador];
              if (c) {
                if (!it.melhorValorGeral && c.melhorValorGeral) it.melhorValorGeral = c.melhorValorGeral;
                if (!it.melhorValorFornecedor && c.melhorValorFornecedor) it.melhorValorFornecedor = c.melhorValorFornecedor;
              }
            });
          }
        } catch (e) {}
      }

      // Helpers de preço
      function qiMelhor(i) {
        var mv = i.melhorValorGeral || i.melhorLanceGeral;
        if (mv && mv.valorInformado != null) return mv.valorInformado;
        if (i.valorMelhorLance != null) return i.valorMelhorLance;
        return null;
      }
      function qiNosso(i) {
        var nv = i.melhorValorFornecedor || i.melhorLanceFornecedor;
        if (nv && nv.valorInformado != null) return nv.valorInformado;
        return null;
      }

      await serverPost('/api/sync/disputas', { merge: true, disputas: [{
        compraId: compId,
        totalItens: qiItens.length,
        itensAtivos: qiItens.filter(function(i) { var f = i.fase||i.faseItem||''; return f==='LA'||f==='D1'||f==='D2'||i.podeEnviarLances; }).length,
        itens: qiItens.map(function(i) {
          return {
            numero: i.numero || i.identificador,
            descricao: (i.descricao || '').substring(0, 120),
            fase: i.fase || i.faseItem || '',
            melhorValor: qiMelhor(i),
            nossoValor: qiNosso(i),
            podeEnviar: i.podeEnviarLances || false,
            fimContagem: i.dataHoraFimContagem || null,
          };
        }),
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
