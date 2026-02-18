// Monitor Comprasnet - Background Service Worker v5.0
// Funciona em segundo plano para manter sessão ativa
// v5.0: Polling direto via API + API Discovery + Telegram alerts

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

// ==================== API DISCOVERY: Interceptor de Mensagens ====================

// Injeta interceptor no contexto MAIN da página para capturar chamadas de API
async function injetarInterceptorMensagens(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        // Evita injetar duas vezes
        if (document.documentElement.getAttribute('data-pncp-msg-interceptor') === 'active') return;

        const apiLog = [];
        const MAX_LOG = 20;

        function addLog(entry) {
          apiLog.push(entry);
          if (apiLog.length > MAX_LOG) apiLog.shift();
          document.documentElement.setAttribute('data-pncp-api-log', JSON.stringify(apiLog));
        }

        function checkForMessages(url, bodyText) {
          const urlLower = (url || '').toLowerCase();
          const bodyLower = (bodyText || '').substring(0, 5000).toLowerCase();

          // Heurísticas para detectar API de mensagens do chat
          const urlMatch = urlLower.includes('mensag') || urlLower.includes('chat') ||
                           urlLower.includes('comunicado') || urlLower.includes('message');
          const bodyMatch = bodyLower.includes('mensagem do') || bodyLower.includes('enviada em') ||
                            bodyLower.includes('remetente') || bodyLower.includes('mensagens da compra');

          if (urlMatch || bodyMatch) {
            const discovery = {
              url: url,
              bodyPreview: bodyText.substring(0, 500),
              timestamp: Date.now(),
              matchType: urlMatch ? 'url' : 'body'
            };
            document.documentElement.setAttribute('data-pncp-api-discovery', JSON.stringify(discovery));
          }
        }

        // Monkey-patch fetch
        const origFetch = window.fetch;
        window.fetch = function() {
          const fetchUrl = (typeof arguments[0] === 'string') ? arguments[0] :
                           (arguments[0] && arguments[0].url) ? arguments[0].url : '';
          const result = origFetch.apply(this, arguments);

          result.then(function(response) {
            try {
              // Só intercepta respostas do domínio Comprasnet
              const respUrl = response.url || fetchUrl;
              if (!respUrl.includes('estaleiro.serpro.gov.br') && !respUrl.includes('comprasnet.gov.br')) return;

              addLog({ type: 'fetch', url: respUrl, status: response.status, ts: Date.now() });

              const clone = response.clone();
              clone.text().then(function(text) {
                if (text && text.length > 10) {
                  checkForMessages(respUrl, text);
                }
              }).catch(function() {});
            } catch(e) {}
          }).catch(function() {});

          return result;
        };

        // Monkey-patch XMLHttpRequest
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url) {
          this._pncpUrl = url;
          this._pncpMethod = method;
          return origOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function() {
          const xhr = this;
          xhr.addEventListener('load', function() {
            try {
              const url = xhr._pncpUrl || '';
              if (!url.includes('estaleiro.serpro.gov.br') && !url.includes('comprasnet.gov.br')) return;

              addLog({ type: 'xhr', url: url, status: xhr.status, ts: Date.now() });

              if (xhr.responseText && xhr.responseText.length > 10) {
                checkForMessages(url, xhr.responseText);
              }
            } catch(e) {}
          });
          return origSend.apply(this, arguments);
        };

        document.documentElement.setAttribute('data-pncp-msg-interceptor', 'active');
      }
    });
    console.log(`[API Discovery] Interceptor injetado na aba ${tabId}`);
  } catch (err) {
    console.log(`[API Discovery] Erro ao injetar interceptor: ${err.message}`);
  }
}

// Auto-injeta interceptor quando abas Comprasnet carregam (se API ainda não descoberta)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || (!tab.url.includes('estaleiro.serpro.gov.br') && !tab.url.includes('comprasnet.gov.br'))) return;

  const { chatApiPattern } = await chrome.storage.local.get('chatApiPattern');
  if (!chatApiPattern) {
    console.log(`[API Discovery] Aba Comprasnet carregada sem API descoberta, injetando interceptor...`);
    await injetarInterceptorMensagens(tabId);
  }
});

// Timer para discovery forçada (5 minutos após inicialização)
let discoveryTimer = null;

function agendarDiscoveryForcada() {
  if (discoveryTimer) clearTimeout(discoveryTimer);
  discoveryTimer = setTimeout(async () => {
    const { chatApiPattern } = await chrome.storage.local.get('chatApiPattern');
    if (!chatApiPattern) {
      console.log('[API Discovery] 5 minutos sem descoberta, forçando...');
      await forcarDiscoveryAPI();
    }
  }, 5 * 60 * 1000);
}

// Força discovery abrindo uma aba, clicando em Mensagens, e capturando a API
async function forcarDiscoveryAPI() {
  console.log('[API Discovery] Forçando discovery via aba...');

  try {
    // Busca uma licitação do servidor para usar
    const response = await fetch(`${SERVER_URL}/api/chat/monitoramentos`);
    if (!response.ok) return;
    const data = await response.json();
    if (!data.success || !data.data || data.data.length === 0) return;

    const lic = data.data[0];
    const compraId = lic.compraId || `${lic.cnpj}${lic.sequencial}${lic.ano}`;
    const url = `${COMPRASNET_URL}/comprasnet-web/seguro/fornecedor/acompanhamento-compra?compra=${compraId}#pncp-polling`;

    const tab = await abrirAbaBackground(url);
    await aguardar(5000);

    // Injeta interceptor
    await injetarInterceptorMensagens(tab.id);
    await aguardar(1000);

    // Manda clicar no botão de mensagens via content script
    await enviarComandoParaAba(tab.id, {
      action: 'capturarMensagensPolling',
      licitacao: { cnpj: lic.cnpj, sequencial: lic.sequencial, ano: lic.ano, compraId }
    }, 25000);

    // Aguarda um pouco para o interceptor capturar
    await aguardar(5000);

    // Fecha a aba
    try { await chrome.tabs.remove(tab.id); } catch(e) {}

    const { chatApiPattern: found } = await chrome.storage.local.get('chatApiPattern');
    if (found) {
      console.log(`[API Discovery] Forçada com sucesso: ${found}`);
    } else {
      console.log('[API Discovery] Forçada falhou - API não encontrada');
    }
  } catch (err) {
    console.log(`[API Discovery] Erro na discovery forçada: ${err.message}`);
  }
}

// ==================== VERIFICAÇÃO DE SESSÃO COMPRASNET ====================

async function verificarSessaoComprasnet() {
  try {
    const response = await fetch(`${COMPRASNET_URL}/comprasnet-web/seguro/fornecedor/compras`, {
      method: 'HEAD',
      credentials: 'include',
      redirect: 'manual'
    });

    // redirect: manual retorna 0 para redirecionamentos opacos em service workers
    // Se status é 401, 403, ou 0 (redirect para login), sessão expirada
    if (response.status === 401 || response.status === 403 || response.type === 'opaqueredirect') {
      console.log(`[Sessão] Expirada (status: ${response.status}, type: ${response.type})`);
      estatisticas.sessaoAtiva = false;
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
      return false;
    }

    estatisticas.sessaoAtiva = true;
    return true;
  } catch (error) {
    console.log(`[Sessão] Erro ao verificar: ${error.message}`);
    // no-cors opaque response - assume active se não deu exceção
    return true;
  }
}

// ==================== VERIFICAÇÃO TELEGRAM ====================

async function verificarTelegramConfigurado() {
  try {
    const response = await fetch(`${SERVER_URL}/api/telegram/status`);
    if (!response.ok) return;
    const data = await response.json();

    if (!data.configurado) {
      console.log('[Telegram] Não configurado - mostrando badge');
      chrome.action.setBadgeText({ text: 'TG' });
      chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });

      // Notifica uma vez
      const { telegramAvisado } = await chrome.storage.local.get('telegramAvisado');
      if (!telegramAvisado) {
        chrome.notifications.create('telegram-config', {
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Telegram não configurado',
          message: 'Configure o Telegram para receber alertas de novas mensagens no chat.'
        });
        await chrome.storage.local.set({ telegramAvisado: true });
      }
    } else {
      console.log(`[Telegram] Configurado, ativo: ${data.ativo}`);
    }
  } catch (err) {
    console.log(`[Telegram] Erro ao verificar: ${err.message}`);
  }
}

// ==================== POLLING DIRETO VIA API ====================

const POLLING_DIRETO_BATCH = 10; // Licitações em paralelo por batch
const POLLING_DIRETO_DELAY = 1000; // Delay entre batches (ms)

async function executarPollingDireto() {
  console.log('[Polling Direto] ========== INICIANDO ==========');

  const { chatApiPattern, chatApiDiscovery } = await chrome.storage.local.get(['chatApiPattern', 'chatApiDiscovery']);
  if (!chatApiPattern) {
    console.log('[Polling Direto] Sem API pattern, abortando');
    return;
  }

  // Verifica sessão antes de começar
  const sessaoOk = await verificarSessaoComprasnet();
  if (!sessaoOk) {
    console.log('[Polling Direto] Sessão expirada, abortando');
    return;
  }

  try {
    // Busca todas as licitações monitoradas
    const response = await fetch(`${SERVER_URL}/api/chat/monitoramentos`);
    if (!response.ok) {
      console.log('[Polling Direto] Servidor offline');
      return;
    }

    const data = await response.json();
    if (!data.success || !data.data || data.data.length === 0) {
      console.log('[Polling Direto] Nenhuma licitação para monitorar');
      return;
    }

    const licitacoes = data.data;
    console.log(`[Polling Direto] ${licitacoes.length} licitações para verificar`);

    let totalNovas = 0;
    let totalErros = 0;
    let totalProcessadas = 0;

    // Processa em batches
    for (let i = 0; i < licitacoes.length; i += POLLING_DIRETO_BATCH) {
      const batch = licitacoes.slice(i, i + POLLING_DIRETO_BATCH);

      const results = await Promise.allSettled(
        batch.map(lic => verificarMensagensViaAPI(lic, chatApiPattern))
      );

      for (const result of results) {
        totalProcessadas++;
        if (result.status === 'fulfilled' && result.value) {
          if (result.value.novas > 0) totalNovas += result.value.novas;
          if (result.value.error) totalErros++;
        } else if (result.status === 'rejected') {
          totalErros++;
        }
      }

      // Delay entre batches (exceto o último)
      if (i + POLLING_DIRETO_BATCH < licitacoes.length) {
        await aguardar(POLLING_DIRETO_DELAY);
      }
    }

    console.log(`[Polling Direto] ========== CONCLUÍDO ==========`);
    console.log(`[Polling Direto] ${totalProcessadas} processadas, ${totalNovas} novas msgs, ${totalErros} erros`);

    if (totalNovas > 0) {
      estatisticas.mensagensCapturadas += totalNovas;
      chrome.action.setBadgeText({ text: String(totalNovas) });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });

      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Novas Mensagens no Comprasnet',
        message: `${totalNovas} nova(s) mensagem(ns) detectada(s) via API direta`
      });
    }

  } catch (error) {
    console.log('[Polling Direto] Erro geral:', error.message);
  }
}

// Verifica mensagens de uma licitação via API direta
async function verificarMensagensViaAPI(lic, apiPattern) {
  const compraId = lic.compraId || `${lic.cnpj}${lic.sequencial}${lic.ano}`;

  try {
    // Substitui placeholder na URL da API
    const apiUrl = apiPattern.replace('{compraId}', compraId);

    const response = await fetch(apiUrl, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*'
      }
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        console.log(`[Polling Direto] Sessão expirada para ${compraId}`);
        return { error: true };
      }
      return { novas: 0 };
    }

    const text = await response.text();
    if (!text || text.length < 10) return { novas: 0 };

    // Tenta parsear como JSON e extrair mensagens
    let mensagens = [];
    try {
      const json = JSON.parse(text);
      mensagens = extrairMensagensDeJSON(json, compraId);
    } catch(e) {
      // Se não é JSON, tenta extrair de HTML
      mensagens = extrairMensagensDeTexto(text, compraId);
    }

    if (mensagens.length === 0) return { novas: 0 };

    // Envia para o servidor (que faz deduplicação e dispara Telegram)
    const info = {
      cnpjOrgao: lic.cnpj || '',
      sequencial: lic.sequencial || 0,
      ano: lic.ano || 0,
      compraId
    };

    const envioResponse = await fetch(`${SERVER_URL}/api/chat/mensagens/extensao`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        licitacao: info,
        mensagens: mensagens,
        url: `${COMPRASNET_URL}/comprasnet-web/seguro/fornecedor/acompanhamento-compra?compra=${compraId}`,
        timestamp: new Date().toISOString(),
        fonte: 'api-direta'
      })
    });

    if (envioResponse.ok) {
      const result = await envioResponse.json();
      if (result.inseridas > 0) {
        console.log(`[Polling Direto] ${compraId}: ${result.inseridas} novas mensagens`);
      }
      return { novas: result.inseridas || 0 };
    }

    return { novas: 0 };

  } catch (error) {
    console.log(`[Polling Direto] Erro em ${compraId}: ${error.message}`);
    return { error: true };
  }
}

// Extrai mensagens de resposta JSON da API
function extrairMensagensDeJSON(json, compraId) {
  const mensagens = [];

  // Trata vários formatos possíveis de resposta
  const items = Array.isArray(json) ? json :
                json.data ? (Array.isArray(json.data) ? json.data : [json.data]) :
                json.mensagens ? json.mensagens :
                json.content ? (Array.isArray(json.content) ? json.content : [json.content]) :
                json.result ? (Array.isArray(json.result) ? json.result : [json.result]) :
                [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    // Tenta extrair campos de mensagem
    const texto = item.mensagem || item.texto || item.message || item.descricao || item.conteudo || '';
    const remetente = item.remetente || item.autor || item.sender || item.nome || item.usuario || 'Sistema';
    const dataStr = item.dataHora || item.data || item.dataCriacao || item.createdAt || item.timestamp || '';

    if (texto && texto.length > 5) {
      let dataHora = new Date().toISOString();
      if (dataStr) {
        // Tenta parsear data
        const d = new Date(dataStr);
        if (!isNaN(d.getTime())) dataHora = d.toISOString();
      }

      // Reconstrói texto no formato esperado pelo servidor
      const textoFormatado = remetente !== 'Sistema'
        ? `Mensagem do ${remetente}\n${texto}`
        : `Mensagem do Sistema\n${texto}`;

      mensagens.push({
        texto: textoFormatado,
        remetente: remetente,
        dataHora: dataHora
      });
    }
  }

  return mensagens;
}

// Extrai mensagens de texto/HTML (fallback)
function extrairMensagensDeTexto(text, compraId) {
  const mensagens = [];
  const blocos = text.split(/(?=Mensagem do )/g);

  for (const bloco of blocos) {
    const texto = bloco.trim();
    if (texto.length > 20 && texto.startsWith('Mensagem do')) {
      const ignorar = ['Visualize aqui', 'Não há mensagens', 'Captcha', 'Tente mais tarde'];
      if (ignorar.some(i => texto.includes(i))) continue;

      let dataHora = new Date().toISOString();
      const matchData = texto.match(/Enviada em (\d{2})\/(\d{2})\/(\d{4}) às (\d{2}):(\d{2}):(\d{2})h?/);
      if (matchData) {
        const [, dia, mes, ano, hora, minuto, segundo] = matchData;
        const dataMsg = new Date(ano, mes - 1, dia, hora, minuto, segundo);
        if (!isNaN(dataMsg.getTime())) dataHora = dataMsg.toISOString();
      }

      const textoLimpo = texto.replace(/\n?Enviada em \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}:\d{2}h?.*$/s, '').trim();
      if (!mensagens.some(m => m.texto === textoLimpo)) {
        mensagens.push({
          texto: textoLimpo,
          remetente: texto.includes('Participante') ? 'Participante' : 'Sistema',
          dataHora: dataHora
        });
      }
    }
  }

  return mensagens;
}

// ==================== MENSAGENS DO CONTENT SCRIPT ====================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Abre nova aba quando content script precisa (coordenação entre extensões)
  if (request.action === 'abrirPagina') {
    chrome.tabs.create({ url: request.url });
    return;
  }

  // Dispara polling imediatamente (chamado pelo content script após sincronizar participações)
  if (request.action === 'iniciarPollingImediato') {
    // Decide qual tipo de polling usar
    chrome.storage.local.get('chatApiPattern').then(({ chatApiPattern }) => {
      if (chatApiPattern) {
        executarPollingDireto();
      } else {
        executarPolling();
      }
    });
    sendResponse({ success: true });
    return;
  }

  // API Discovery: content script relays discovered API info
  if (request.action === 'apiDiscovered') {
    const discovery = request.discovery;
    if (!discovery || !discovery.url) {
      console.log('[API Discovery] Discovery inválida recebida');
      sendResponse({ success: false });
      return;
    }

    console.log(`[API Discovery] URL encontrada: ${discovery.url}`);

    // Tenta extrair o compraId da URL para criar o pattern
    let pattern = discovery.url;
    const compraMatch = pattern.match(/compra[=/](\d{14,20})/i);
    if (compraMatch) {
      pattern = pattern.replace(compraMatch[1], '{compraId}');
      console.log(`[API Discovery] Pattern com placeholder: ${pattern}`);
    }

    // Salva em storage
    chrome.storage.local.set({
      chatApiPattern: pattern,
      chatApiDiscovery: {
        originalUrl: discovery.url,
        bodyPreview: discovery.bodyPreview || '',
        matchType: discovery.matchType || 'unknown',
        discoveredAt: Date.now()
      },
      chatApiDiscoveredAt: Date.now()
    });

    console.log('[API Discovery] Salva com sucesso!');

    // Cancela timer de discovery forçada
    if (discoveryTimer) {
      clearTimeout(discoveryTimer);
      discoveryTimer = null;
    }

    sendResponse({ success: true });
    return;
  }

  // Extrai compraIds do DOM Angular via chrome.scripting (world: MAIN, bypassa CSP)
  if (request.action === 'extractCompraIds') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ compraIds: [], error: 'No tab ID' });
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const results = [];
        function searchObj(obj, depth) {
          if (depth > 4 || !obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) {
            for (let i = 0; i < Math.min(obj.length, 200); i++) searchObj(obj[i], depth + 1);
            return;
          }
          const keys = Object.keys(obj);
          for (const key of keys) {
            const value = obj[key];
            const k = key.toLowerCase();
            if ((k === 'codigocompra' || k === 'compraid' || k === 'codigodacompra' || k === 'compra' || k === 'codigo') &&
                typeof value === 'string' && /^\d{14,20}$/.test(value)) {
              if (!results.includes(value)) results.push(value);
            }
            if ((k === 'codigocompra' || k === 'compraid' || k === 'codigodacompra') &&
                typeof value === 'number' && value > 10000000000000) {
              const s = String(value);
              if (!results.includes(s)) results.push(s);
            }
            if (typeof value === 'object' && value !== null) searchObj(value, depth + 1);
          }
        }
        // Método 1: __ngContext__ nos cards Angular
        document.querySelectorAll('app-card-compra-pesquisa').forEach(card => {
          try {
            const ctx = card.__ngContext__;
            if (ctx && Array.isArray(ctx)) {
              for (let i = 0; i < ctx.length; i++) {
                if (ctx[i] && typeof ctx[i] === 'object' && !Array.isArray(ctx[i])) searchObj(ctx[i], 0);
              }
            }
          } catch (e) {}
        });
        // Método 2: __ngContext__ no dataview pai
        const dv = document.querySelector('p-dataview, [class*="dataview"]');
        if (dv) {
          try {
            const ctx = dv.__ngContext__;
            if (ctx && Array.isArray(ctx)) {
              for (let i = 0; i < ctx.length; i++) {
                if (ctx[i] && typeof ctx[i] === 'object') searchObj(ctx[i], 0);
              }
            }
          } catch (e) {}
        }
        // Método 3: href com compra=
        document.querySelectorAll('a[href*="compra="]').forEach(a => {
          const m = a.href.match(/compra=(\d{14,20})/);
          if (m && !results.includes(m[1])) results.push(m[1]);
        });
        // Método 4: data attributes
        document.querySelectorAll('[data-compra-id], [data-codigo-compra], [data-compra]').forEach(el => {
          const id = el.getAttribute('data-compra-id') || el.getAttribute('data-codigo-compra') || el.getAttribute('data-compra');
          if (id && /^\d{14,20}$/.test(id) && !results.includes(id)) results.push(id);
        });
        return results;
      }
    }).then(injectionResults => {
      const compraIds = injectionResults?.[0]?.result || [];
      console.log(`[ExtractCompraIds] Extraídos ${compraIds.length} compraIds via scripting API`);
      sendResponse({ compraIds });
    }).catch(err => {
      console.log(`[ExtractCompraIds] Erro: ${err.message}`);
      sendResponse({ compraIds: [], error: err.message });
    });
    return true; // async response
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
    chrome.storage.local.get(['chatApiPattern', 'chatApiDiscoveredAt']).then(apiData => {
      sendResponse({
        mensagensCapturadas: estatisticas.mensagensCapturadas,
        licitacoesMonitoradas: estatisticas.licitacoesMonitoradas.size,
        ultimaCaptura: estatisticas.ultimaCaptura,
        sessaoAtiva: estatisticas.sessaoAtiva,
        ultimoKeepAlive: estatisticas.ultimoKeepAlive,
        chatApiPattern: apiData.chatApiPattern || null,
        chatApiDiscoveredAt: apiData.chatApiDiscoveredAt || null
      });
    });
    return true;
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

// ==================== POLLING POR ABA (FALLBACK) ====================

const POLLING_ALARM = 'polling-mensagens';
const POLLING_MINUTES = 2; // Verifica novas mensagens a cada 2 minutos

let pollingEmAndamento = false;
let pollingIndex = 0; // Posição atual no round-robin
const MAX_POR_CICLO = 5; // Máximo de licitações por ciclo de polling (subiu de 3 para 5)

// ID da aba de polling reutilizável
let pollingTabId = null;

// Configura alarme de polling
async function configurarPolling() {
  await chrome.alarms.clear(POLLING_ALARM);
  chrome.alarms.create(POLLING_ALARM, {
    delayInMinutes: 0.5, // Primeira execução em 30 segundos
    periodInMinutes: POLLING_MINUTES
  });
  console.log(`[Polling] Configurado para executar a cada ${POLLING_MINUTES} minutos`);
}

// Aguarda um tempo
function aguardar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Obtém ou cria a aba de polling reutilizável
async function obterAbaPollling(url) {
  // Verifica se a aba existente ainda é válida
  if (pollingTabId) {
    try {
      const tab = await chrome.tabs.get(pollingTabId);
      // Aba existe - reutiliza navegando para nova URL
      await chrome.tabs.update(pollingTabId, { url, active: false });
      // Aguarda carregamento
      await new Promise((resolve) => {
        const listener = (tabId, changeInfo) => {
          if (tabId === pollingTabId && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 30000);
      });
      return tab;
    } catch (e) {
      // Aba não existe mais
      pollingTabId = null;
    }
  }

  // Cria nova aba
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      pollingTabId = tab.id;

      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);

      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }, 30000);
    });
  });
}

// Abre uma aba em segundo plano e aguarda carregar (legacy - para discovery forçada)
async function abrirAbaBackground(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      // Aguarda a aba carregar completamente
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);

      // Timeout de 30 segundos
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab); // Resolve mesmo assim para tentar capturar
      }, 30000);
    });
  });
}

// Envia comando para aba e aguarda resposta
async function enviarComandoParaAba(tabId, comando, timeout = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ success: false, error: 'Timeout' });
    }, timeout);

    chrome.tabs.sendMessage(tabId, comando, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false, error: 'Sem resposta' });
      }
    });
  });
}

// Processa uma licitação via aba reutilizável
async function processarLicitacaoBackground(lic) {
  const compraId = lic.compraId || `${lic.cnpj}${lic.sequencial}${lic.ano}`;
  const urlLicitacao = `${COMPRASNET_URL}/comprasnet-web/seguro/fornecedor/acompanhamento-compra?compra=${compraId}#pncp-polling`;

  console.log(`[Polling] Navegando aba para compraId=${compraId}`);

  try {
    const tab = await obterAbaPollling(urlLicitacao);
    console.log(`[Polling] Aba ${tab.id} pronta, aguardando carregamento...`);

    await aguardar(5000);

    const resultado = await enviarComandoParaAba(tab.id, {
      action: 'capturarMensagensPolling',
      licitacao: {
        cnpj: lic.cnpj,
        sequencial: lic.sequencial,
        ano: lic.ano,
        compraId
      }
    }, 20000);

    if (resultado.success) {
      console.log(`[Polling] Licitação ${compraId}: ${resultado.mensagens || 0} mensagens, ${resultado.novas || 0} novas`);
      return { success: true, novas: resultado.novas || 0 };
    } else {
      console.log(`[Polling] Erro em ${compraId}: ${resultado.error}`);
      return { success: false, error: resultado.error };
    }

  } catch (error) {
    console.log(`[Polling] Erro ao processar ${compraId}: ${error.message}`);
    return { success: false, error: error.message };
  }
  // Nota: NÃO fecha a aba - ela é reutilizada no próximo ciclo
}

// Executa polling de mensagens via abas (fallback quando API não descoberta)
async function executarPolling() {
  if (pollingEmAndamento) {
    console.log('[Polling] Já em andamento, ignorando...');
    return;
  }

  pollingEmAndamento = true;
  console.log('[Polling] ========== INICIANDO VERIFICAÇÃO (aba) ==========');

  try {
    const response = await fetch(`${SERVER_URL}/api/chat/monitoramentos`);
    if (!response.ok) {
      console.log('[Polling] Servidor offline');
      return;
    }

    const data = await response.json();
    if (!data.success || !data.data || data.data.length === 0) {
      console.log('[Polling] Nenhuma licitação para monitorar');
      return;
    }

    const licitacoes = data.data;
    console.log(`[Polling] ${licitacoes.length} licitações no total, índice atual: ${pollingIndex}`);

    // Round-robin: seleciona fatia
    if (pollingIndex >= licitacoes.length) {
      pollingIndex = 0;
    }
    const fatia = licitacoes.slice(pollingIndex, pollingIndex + MAX_POR_CICLO);
    const proximoIndex = pollingIndex + fatia.length;
    pollingIndex = proximoIndex >= licitacoes.length ? 0 : proximoIndex;

    console.log(`[Polling] Processando ${fatia.length} de ${licitacoes.length} (round-robin)`);

    let totalNovas = 0;
    let processadas = 0;
    let erros = 0;

    for (const lic of fatia) {
      try {
        const resultado = await processarLicitacaoBackground(lic);
        processadas++;

        if (resultado.success && resultado.novas > 0) {
          totalNovas += resultado.novas;
        } else if (!resultado.success) {
          erros++;
        }

        await aguardar(2000);
      } catch (e) {
        console.log(`[Polling] Erro inesperado: ${e.message}`);
        erros++;
      }
    }

    console.log(`[Polling] ========== CONCLUÍDO ==========`);
    console.log(`[Polling] Processadas: ${processadas}/${licitacoes.length}, Novas: ${totalNovas}, Erros: ${erros}, Próximo: ${pollingIndex}`);

    if (totalNovas > 0) {
      estatisticas.mensagensCapturadas += totalNovas;
      chrome.action.setBadgeText({ text: String(totalNovas) });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });

      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Novas Mensagens no Comprasnet',
        message: `${totalNovas} nova(s) mensagem(ns) capturada(s)`
      });
    }

  } catch (error) {
    console.log('[Polling] Erro geral:', error.message);
  } finally {
    pollingEmAndamento = false;
  }
}

// Listener para alarmes
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === KEEP_ALIVE_ALARM) {
    const temAba = await verificarAbaComprasnet();
    if (temAba) {
      console.log('[Keep-Alive] Usando aba existente do Comprasnet');
    } else {
      await executarKeepAlive();
    }
  } else if (alarm.name === POLLING_ALARM) {
    // Decisão automática: polling direto (API) vs polling por aba (fallback)
    const { chatApiPattern } = await chrome.storage.local.get('chatApiPattern');
    if (chatApiPattern) {
      if (!pollingEmAndamento) {
        pollingEmAndamento = true;
        try {
          await executarPollingDireto();
        } finally {
          pollingEmAndamento = false;
        }
      }
    } else {
      await executarPolling();
    }
  }
});

// ==================== INICIALIZAÇÃO ====================

// Quando a extensão é instalada ou atualizada
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Monitor Comprasnet] Extensão instalada/atualizada');
  await configurarKeepAlive();
  await configurarPolling();
  await verificarTelegramConfigurado();
  agendarDiscoveryForcada();
});

// Quando o service worker inicia
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Monitor Comprasnet] Chrome iniciado');
  await configurarKeepAlive();
  await configurarPolling();
  await verificarTelegramConfigurado();
  agendarDiscoveryForcada();
});

// Verifica o servidor periodicamente
setInterval(atualizarStatusServidor, 60000);

// Configura keep-alive e polling na inicialização
configurarKeepAlive();
configurarPolling();
verificarTelegramConfigurado();
agendarDiscoveryForcada();

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

console.log('[Monitor Comprasnet] Background service worker v5.0 iniciado (API direta + aba fallback)');
