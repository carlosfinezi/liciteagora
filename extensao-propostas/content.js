// Propostas Comprasnet - Content Script v2.0
// Envio de propostas via API REST (sem manipulação DOM)
// Substitui v1.2 (1582 linhas DOM) por chamadas diretas à API do Comprasnet

const SERVER_URL = '__SERVER_URL__';
const COMPRASNET_API = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-fase-externa/v1';
const POLLING_INTERVAL = 10000; // 10 segundos
const HEADERS_API = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'x-device-platform': 'web',
  'x-version-number': '5.5.2'
};

// ==================== LOGGING ====================
const debugLogs = [];
function log(msg) {
  const timestamp = new Date().toLocaleTimeString();
  const fullMsg = `[${timestamp}] ${msg}`;
  console.log(`[Propostas API] ${msg}`);
  debugLogs.push(fullMsg);
  if (debugLogs.length > 100) debugLogs.shift();
}

// ==================== SERVER COMMUNICATION ====================
// Proxy via background service worker (evita Mixed Content HTTPS → HTTP)
function serverFetch(url, options = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'serverFetch', url, options },
      (response) => {
        if (chrome.runtime.lastError || !response) {
          resolve({ ok: false, status: 0, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
          return;
        }
        resolve({
          ok: response.ok,
          status: response.status,
          json: () => { try { return Promise.resolve(JSON.parse(response.body)); } catch { return Promise.resolve({}); } },
          text: () => Promise.resolve(response.body || '')
        });
      }
    );
  });
}

// ==================== COMPRASNET API (same-origin, cookies automáticos) ====================

/**
 * Envia declarações e confirma participação na compra
 */
async function enviarDeclaracoes(compraId, opcoes = {}) {
  const body = {
    declaracaoMeEpp: opcoes.meEpp !== undefined ? opcoes.meEpp : true,
    declaracaoProgramasIntegridade: opcoes.programaIntegridade !== undefined ? opcoes.programaIntegridade : false,
    declaracaoEquidadeGenero: opcoes.equidadeGenero !== undefined ? opcoes.equidadeGenero : null
  };

  log(`Enviando declarações para compra ${compraId}: ${JSON.stringify(body)}`);

  const resp = await fetch(`${COMPRASNET_API}/compras/${compraId}/participacao`, {
    method: 'POST',
    headers: HEADERS_API,
    credentials: 'include',
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Declarações HTTP ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  log(`✓ Declarações enviadas. Participante: ${data.participante?.nome || 'OK'}, isFornecedorParticipante: ${data.isFornecedorParticipante}`);
  return data;
}

/**
 * Consulta detalhamento de um item da compra
 */
async function consultarItem(compraId, numeroItem) {
  const resp = await fetch(`${COMPRASNET_API}/compras/${compraId}/itens/${numeroItem}/detalhamento`, {
    method: 'GET',
    headers: { ...HEADERS_API, 'habilitar-cache': 'true' },
    credentials: 'include'
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Detalhamento item ${numeroItem} HTTP ${resp.status}: ${text}`);
  }

  return await resp.json();
}

/**
 * Envia proposta para um item específico
 */
async function enviarPropostaItem(compraId, item) {
  const numero = item.numero || item.item || item.numeroItem;
  const valor = parseFloat(item.valor || item.valorUnitario || 0);

  if (!numero || valor <= 0) {
    throw new Error(`Item inválido: numero=${numero}, valor=${valor}`);
  }

  // Consultar detalhamento para obter quantidadeSolicitada
  let quantidadeOfertada = item.quantidade || item.quantidadeOfertada || null;
  if (!quantidadeOfertada) {
    try {
      const detalhe = await consultarItem(compraId, numero);
      quantidadeOfertada = detalhe.quantidadeSolicitada || 1;
      log(`  Item ${numero}: qtd=${quantidadeOfertada}, estimado=${detalhe.valorEstimadoUnitario}`);
    } catch (e) {
      log(`  AVISO: Não conseguiu consultar detalhamento item ${numero}: ${e.message}`);
      quantidadeOfertada = 1;
    }
  }

  const body = {
    quantidadeOfertada: quantidadeOfertada,
    valor: valor,
    marcaFabricante: item.marcaFabricante || item.marca || null,
    modeloVersao: item.modeloVersao || item.modelo || null,
    propostaTrabalhoMre: null,
    codigoPaisOrigemItem: null,
    declaracoesMargemPreferencia: null,
    declaracaoConteudoNacional: false,
    modificado: true
  };

  log(`  Enviando proposta item ${numero}: valor=${valor}, qtd=${quantidadeOfertada}`);

  const resp = await fetch(`${COMPRASNET_API}/compras/${compraId}/itens/${numero}/participacao`, {
    method: 'POST',
    headers: HEADERS_API,
    credentials: 'include',
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Proposta item ${numero} HTTP ${resp.status}: ${text}`);
  }

  const data = await resp.json();

  // Validar resposta — deve conter propostaItem com valores
  const itemResp = Array.isArray(data) ? data[0] : data;
  const proposta = itemResp?.propostaItem;
  if (proposta) {
    const valorConfirmado = proposta.valores?.valorPropostaInicial?.valorInformado;
    log(`  ✓ Item ${numero}: proposta salva (id=${proposta.id}, valorConfirmado=${valorConfirmado})`);
    return { success: true, numero, propostaId: proposta.id, valorConfirmado };
  } else {
    log(`  ✓ Item ${numero}: resposta OK mas sem propostaItem (pode ser atualização)`);
    return { success: true, numero, data: itemResp };
  }
}

// ==================== ORQUESTRADOR PRINCIPAL ====================

/**
 * Envia proposta completa: declarações + todos os itens via API
 */
async function enviarPropostaViaAPI(dados) {
  const { compraId, itens, uasg, numeroCompra } = dados;
  const inicio = Date.now();

  log(`=== ENVIO DE PROPOSTA VIA API ===`);
  log(`CompraId: ${compraId}, Itens: ${itens.length}`);

  const resultados = { itensSalvos: 0, itensComErro: [], detalhes: [] };

  try {
    // Passo 1: Enviar declarações
    log('Passo 1: Declarações...');
    try {
      const participacao = await enviarDeclaracoes(compraId, dados.declaracoes || {});
      log(`✓ Declarações OK. Objeto: ${(participacao.objeto || '').substring(0, 80)}...`);
    } catch (e) {
      // Se der erro, declarações já foram enviadas — continuar
      log(`⚠ Declarações: ${e.message} — continuando...`);
    }

    // Passo 2: Enviar proposta para cada item
    log(`Passo 2: Enviando ${itens.length} item(ns)...`);
    for (const item of itens) {
      const numero = item.numero || item.item || item.numeroItem;
      try {
        const resultado = await enviarPropostaItem(compraId, item);
        resultados.itensSalvos++;
        resultados.detalhes.push(resultado);
      } catch (e) {
        log(`  ✗ Item ${numero}: ${e.message}`);
        resultados.itensComErro.push({ numero, erro: e.message });
      }
    }

    const tempoTotal = ((Date.now() - inicio) / 1000).toFixed(1);
    const sucesso = resultados.itensComErro.length === 0 && resultados.itensSalvos > 0;

    if (sucesso) {
      log(`=== ✓ PROPOSTA ENVIADA: ${resultados.itensSalvos} itens em ${tempoTotal}s ===`);
    } else if (resultados.itensSalvos > 0) {
      log(`=== ⚠ PARCIAL: ${resultados.itensSalvos} OK, ${resultados.itensComErro.length} erros em ${tempoTotal}s ===`);
    } else {
      log(`=== ✗ FALHA: nenhum item salvo em ${tempoTotal}s ===`);
    }

    // Reportar ao servidor
    await serverFetch(`${SERVER_URL}/api/proposta/resultado`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: sucesso,
        compraId,
        uasg,
        numeroCompra,
        itensSalvos: resultados.itensSalvos,
        itensComErro: resultados.itensComErro,
        itens,
        timestamp: new Date().toISOString()
      })
    }).catch(e => log(`Erro ao reportar resultado: ${e.message}`));

    return { success: sucesso, ...resultados };

  } catch (error) {
    log(`=== ✗ ERRO FATAL: ${error.message} ===`);

    // Reportar erro ao servidor
    await serverFetch(`${SERVER_URL}/api/proposta/resultado`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        compraId,
        uasg,
        numeroCompra,
        error: error.message,
        itensSalvos: resultados.itensSalvos,
        itensComErro: resultados.itensComErro,
        timestamp: new Date().toISOString()
      })
    }).catch(() => {});

    return { success: false, error: error.message, ...resultados };
  }
}

// ==================== POLLING DE FILA ====================

let pollingTimer = null;
let processando = false;

async function verificarFila() {
  if (processando) return;

  try {
    const response = await serverFetch(`${SERVER_URL}/api/proposta/fila`);
    if (!response.ok) return;

    const data = await response.json();
    if (!data.success || !data.hasPendente || !data.data) return;

    const proposta = data.data;

    // Evitar reprocessamento em menos de 2 minutos
    const storage = await chrome.storage.local.get(['ultimaPropostaProcessada', 'ultimaPropostaTimestamp']);
    if (storage.ultimaPropostaProcessada === proposta.compraId && storage.ultimaPropostaTimestamp) {
      if (Date.now() - storage.ultimaPropostaTimestamp < 120000) return;
    }

    log(`📋 Proposta pendente: compraId=${proposta.compraId}, ${proposta.itens?.length || 0} itens`);

    processando = true;
    await chrome.storage.local.set({
      ultimaPropostaProcessada: proposta.compraId,
      ultimaPropostaTimestamp: Date.now()
    });

    try {
      await enviarPropostaViaAPI(proposta);
    } finally {
      processando = false;
    }
  } catch (e) {
    // Silencioso — polling normal
  }
}

function iniciarPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  verificarFila(); // Imediato
  pollingTimer = setInterval(verificarFila, POLLING_INTERVAL);
  log(`Polling iniciado (${POLLING_INTERVAL / 1000}s)`);
}

// ==================== MESSAGE LISTENER ====================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'keepAlive') {
    sendResponse({ alive: true });
    return;
  }

  if (request.action === 'enviarProposta') {
    log('Ação enviarProposta recebida');
    enviarPropostaViaAPI(request.dados).then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // async
  }

  if (request.action === 'status') {
    sendResponse({
      url: window.location.href,
      logado: !window.location.href.includes('acesso-nao-autorizado'),
      versao: '2.0-api',
      processando,
      logs: debugLogs.slice(-10)
    });
    return true;
  }

  if (request.action === 'getLogs') {
    sendResponse({ logs: debugLogs });
    return true;
  }

  return true;
});

// ==================== KEEP-ALIVE ====================

const KEEP_ALIVE_INTERVAL = 3 * 60 * 1000;
let keepAliveTimer = null;

function iniciarKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    serverFetch(`${SERVER_URL}/api/chat/keep-alive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp: new Date().toISOString() })
    }).catch(() => {});
  }, KEEP_ALIVE_INTERVAL);
}

// ==================== INICIALIZAÇÃO ====================

(async () => {
  const url = window.location.href;
  if (!url.includes('cnetmobile.estaleiro.serpro.gov.br')) return;

  // Não executar em páginas de login
  if (url.includes('/login') || url.includes('/acesso') || url.includes('govbr') ||
      url.includes('sso.acesso.gov.br') || !url.includes('/seguro/')) {
    console.log('[Propostas API] Página de login — desativado');
    return;
  }

  log('=== EXTENSÃO PROPOSTAS v2.0 (API) INICIADA ===');
  log(`URL: ${url}`);

  iniciarKeepAlive();
  iniciarPolling();
})();
