// Monitor Comprasnet - Content Script v5.4
// Captura mensagens automaticamente de TODAS as licitações
// Versão atualizada em: 26/12/2024
// - Multi-status: processa todos os status (Propostas, Disputa, Seleção, etc.)
// - Ordem reversa: processa das mais recentes para as mais antigas
// - Paginação melhorada: navega entre páginas em cada status
// - Keep-alive em segundo plano via background worker
// - CORREÇÃO v5.1: Restaura status e página corretos ao retomar após voltar da licitação
// - NOVO v5.2: Permite escolher ponto de início (status, página, posição)
// - CORREÇÃO v5.3: Botão parar funciona corretamente, busca de status melhorada
// - CORREÇÃO v5.4: Parada IMEDIATA usando flag global e exceção

const SERVER_URL = '__SERVER_URL__';

// Proxy fetch via background service worker (evita Mixed Content em páginas HTTPS)
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
          statusText: response.statusText || '',
          json: () => { try { return Promise.resolve(JSON.parse(response.body)); } catch(e) { return Promise.resolve({}); } },
          text: () => Promise.resolve(response.body || '')
        });
      }
    );
  });
}

// ==================== SISTEMA DE COORDENAÇÃO VIA DOM ====================
// Usa atributos no <html> para coordenar entre extensões (DOM é compartilhado)
const EXT_NAME = 'chrome';
const EXT_ATTR = 'data-pncp-ext-chrome';
const EXT_PRIORITY = 1; // lances=3, propostas=2, monitor=1, chrome=1
const EXT_STALE_MS = 15000;
const EXT_HEARTBEAT_MS = 5000;

const ALL_EXT_ATTRS = [
  { attr: 'data-pncp-ext-lances', name: 'lances', priority: 3 },
  { attr: 'data-pncp-ext-propostas', name: 'propostas', priority: 2 },
  { attr: 'data-pncp-ext-monitor', name: 'monitor', priority: 1 },
  { attr: 'data-pncp-ext-chrome', name: 'chrome', priority: 1 }
];

let _heartbeatTimer = null;

function _lerEstadoExt(attr) {
  try {
    const val = document.documentElement.getAttribute(attr);
    if (!val) return null;
    return JSON.parse(val);
  } catch { return null; }
}

function _limparExtStale() {
  const agora = Date.now();
  for (const ext of ALL_EXT_ATTRS) {
    if (ext.name === EXT_NAME) continue;
    const estado = _lerEstadoExt(ext.attr);
    if (estado && (agora - estado.timestamp) > EXT_STALE_MS) {
      document.documentElement.removeAttribute(ext.attr);
    }
  }
}

function registrarPresenca(operacao = '') {
  const estado = { active: true, operation: operacao, timestamp: Date.now(), tabClaimed: false };
  document.documentElement.setAttribute(EXT_ATTR, JSON.stringify(estado));
}

function reivindicarAba(operacao = '') {
  const estado = { active: true, operation: operacao, timestamp: Date.now(), tabClaimed: true };
  document.documentElement.setAttribute(EXT_ATTR, JSON.stringify(estado));
  log(`[Aba] Reivindicada: ${operacao || 'operação geral'}`);
}

function liberarAba() {
  const estado = _lerEstadoExt(EXT_ATTR);
  if (estado && estado.tabClaimed) {
    estado.tabClaimed = false;
    estado.timestamp = Date.now();
    document.documentElement.setAttribute(EXT_ATTR, JSON.stringify(estado));
    log('[Aba] Liberada');
  }
}

function abaLivre() {
  _limparExtStale();
  for (const ext of ALL_EXT_ATTRS) {
    if (ext.name === EXT_NAME) continue;
    const estado = _lerEstadoExt(ext.attr);
    if (estado && estado.tabClaimed) return false;
  }
  return true;
}

function extensoesComControle() {
  _limparExtStale();
  const resultado = [];
  for (const ext of ALL_EXT_ATTRS) {
    if (ext.name === EXT_NAME) continue;
    const estado = _lerEstadoExt(ext.attr);
    if (estado && estado.tabClaimed) {
      resultado.push({ name: ext.name, priority: ext.priority, operation: estado.operation });
    }
  }
  return resultado;
}

async function tentarReivindicar(operacao = '') {
  _limparExtStale();
  const ocupantes = extensoesComControle();
  if (ocupantes.length > 0) {
    const maiorPrioridade = Math.max(...ocupantes.map(o => o.priority));
    if (maiorPrioridade >= EXT_PRIORITY) return false;
  }
  reivindicarAba(operacao);
  await new Promise(r => setTimeout(r, 200));
  const novasOcupantes = extensoesComControle();
  if (novasOcupantes.some(o => o.priority > EXT_PRIORITY)) {
    liberarAba();
    return false;
  }
  return true;
}

function iniciarHeartbeat() {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = setInterval(() => {
    const estado = _lerEstadoExt(EXT_ATTR);
    if (estado) {
      estado.timestamp = Date.now();
      document.documentElement.setAttribute(EXT_ATTR, JSON.stringify(estado));
    }
  }, EXT_HEARTBEAT_MS);
}

function pararHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
  document.documentElement.removeAttribute(EXT_ATTR);
}

window.addEventListener('beforeunload', () => {
  document.documentElement.removeAttribute(EXT_ATTR);
});

function getExtensaoAtual() {
  const ocupantes = extensoesComControle();
  if (ocupantes.length > 0) return { nome: ocupantes[0].name, operacao: ocupantes[0].operation };
  return { nome: null, operacao: null };
}
// ==================== FIM SISTEMA DE COORDENAÇÃO ====================

// Configuração de keep-alive (mantém sessão ativa)
const KEEP_ALIVE_INTERVAL = 3 * 60 * 1000; // 3 minutos
let keepAliveTimer = null;

// Array para armazenar logs
const debugLogs = [];

function log(msg) {
  const timestamp = new Date().toLocaleTimeString();
  const fullMsg = `[${timestamp}] ${msg}`;
  console.log(`[Monitor Comprasnet] ${msg}`);
  debugLogs.push(fullMsg);

  // Envia logs para o servidor a cada 5 mensagens
  if (debugLogs.length % 5 === 0) {
    enviarLogsParaServidor();
  }
}

  // ==================== CONTROLE DE PAUSE ====================
  let pausado = false;
  let pauseResolve = null;

  // Cria botão flutuante de pause/resume
  function criarBotaoPause() {
    if (document.getElementById('pncp-chrome-pause-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'pncp-chrome-pause-btn';
    btn.innerHTML = '⏸ PAUSAR';
    btn.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      z-index: 999999;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: bold;
      background: #ff9800;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      display: block;
    `;

    btn.onclick = () => {
      if (pausado) {
        // Resume
        pausado = false;
        btn.innerHTML = '⏸ PAUSAR';
        btn.style.background = '#ff9800';
        log('▶ RESUMIDO pelo usuário');
        if (pauseResolve) {
          pauseResolve();
          pauseResolve = null;
        }
      } else {
        // Pause
        pausado = true;
        btn.innerHTML = '▶ CONTINUAR';
        btn.style.background = '#4caf50';
        log('⏸ PAUSADO pelo usuário');
      }
    };

    document.body.appendChild(btn);
  }

  // Mostra/esconde botão
  function mostrarBotaoPause(mostrar) {
    const btn = document.getElementById('pncp-chrome-pause-btn');
    if (btn) {
      btn.style.display = mostrar ? 'block' : 'none';
    }
  }

  // Verifica se está pausado e aguarda se necessário
  async function verificarPause(etapa) {
    if (pausado) {
      log('⏸ Pausado na etapa: ' + etapa);
      await new Promise(resolve => {
        pauseResolve = resolve;
      });
    }
  }

  // Inicializa botão quando DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', criarBotaoPause);
  } else {
    criarBotaoPause();
  }
  // Também tenta criar após um delay como fallback
  setTimeout(criarBotaoPause, 1000);
  setTimeout(criarBotaoPause, 3000);



async function enviarLogsParaServidor() {
  try {
    await serverFetch(`${SERVER_URL}/api/chat/debug-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        logs: debugLogs.slice(-20), // Últimos 20 logs
        url: window.location.href,
        timestamp: new Date().toISOString()
      })
    });
  } catch (e) {
    // Ignora erros de envio
  }
}

// Flag global para parada imediata
let PARAR_MONITORAMENTO = false;

// Aguarda com verificação de parada
async function aguardar(ms) {
  // Divide em intervalos menores para verificar parada frequentemente
  const intervalo = 500; // Verifica a cada 500ms
  let tempoRestante = ms;

  while (tempoRestante > 0) {
    // Verifica se deve parar
    if (PARAR_MONITORAMENTO) {
      throw new Error('MONITORAMENTO_PARADO');
    }

    const espera = Math.min(intervalo, tempoRestante);
    await new Promise(resolve => setTimeout(resolve, espera));
    tempoRestante -= espera;
  }
}

// ==================== KEEP-ALIVE (MANTER SESSÃO ATIVA) ====================

// Verifica se a sessão ainda está ativa
function verificarSessaoAtiva() {
  const url = window.location.href;
  // Se foi redirecionado para página de acesso não autorizado, sessão expirou
  if (url.includes('acesso-nao-autorizado') || url.includes('login') || url.includes('sso.acesso.gov.br')) {
    return false;
  }
  return true;
}

// Faz uma requisição leve para manter a sessão ativa
async function manterSessaoAtiva() {
  if (!verificarSessaoAtiva()) {
    log('⚠️ Sessão expirada! Faça login novamente.');
    pararKeepAlive();

    // Notifica o usuário
    mostrarNotificacao('Sessão expirada! Faça login novamente.', 'warning');

    // Notifica o servidor
    serverFetch(`${SERVER_URL}/api/chat/navegacao`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo: 'sessao_expirada',
        url: window.location.href,
        timestamp: new Date().toISOString()
      })
    }).catch(() => {});

    return false;
  }

  try {
    // Faz uma requisição simples para manter a sessão ativa
    // Usa o endpoint de participações que já está acessível
    const response = await fetch('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras', {
      method: 'HEAD',
      credentials: 'include'
    });

    if (response.ok || response.status === 200) {
      log('🔄 Keep-alive: sessão mantida ativa');
      return true;
    } else if (response.status === 401 || response.status === 403) {
      log('⚠️ Keep-alive: sessão expirada (401/403)');
      mostrarNotificacao('Sessão expirada! Faça login novamente.', 'warning');
      pararKeepAlive();
      return false;
    }
  } catch (error) {
    log(`Keep-alive erro: ${error.message}`);
  }

  return true;
}

// Inicia o timer de keep-alive
function iniciarKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
  }

  log(`🔄 Keep-alive iniciado (a cada ${KEEP_ALIVE_INTERVAL / 60000} minutos)`);

  // Primeira verificação após 1 minuto
  setTimeout(() => {
    manterSessaoAtiva();
  }, 60000);

  // Depois a cada KEEP_ALIVE_INTERVAL
  keepAliveTimer = setInterval(() => {
    manterSessaoAtiva();
  }, KEEP_ALIVE_INTERVAL);
}

// Para o timer de keep-alive
function pararKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    log('Keep-alive parado');
  }
}

function extrairInfoLicitacao() {
  const url = window.location.href;
  const matchCompra = url.match(/compra=(\d+)/);
  if (matchCompra) {
    const compra = matchCompra[1];
    if (compra.length >= 10) {
      const cnpjOrgao = compra.substring(0, Math.min(14, compra.length - 9));
      const resto = compra.substring(cnpjOrgao.length);
      const sequencial = resto.substring(0, resto.length - 4);
      const ano = resto.substring(resto.length - 4);
      return { cnpjOrgao, sequencial, ano, compraId: compra };
    }
  }
  return null;
}

function extrairMensagensDoChat() {
  const mensagens = [];
  const sidebar = document.querySelector('.p-sidebar-content');
  if (!sidebar) return mensagens;

  const textoCompleto = sidebar.innerText || '';
  const blocos = textoCompleto.split(/(?=Mensagem do |Enviada em )/g);

  blocos.forEach(bloco => {
    const texto = bloco.trim();
    if (texto.length > 20) {
      const ignorar = ['Visualize aqui', 'Não há mensagens', 'Captcha', 'Tente mais tarde', 'Fechar', 'Sessão Pública'];
      if (!ignorar.some(i => texto.includes(i)) && !mensagens.some(m => m.texto === texto)) {
        mensagens.push({
          texto: texto,
          remetente: texto.includes('Participante') ? 'Participante' : 'Sistema',
          dataHora: new Date().toISOString()
        });
      }
    }
  });

  return mensagens;
}

// Consulta progresso de captura de uma licitação
async function consultarProgresso(compraId) {
  try {
    const response = await serverFetch(`${SERVER_URL}/api/chat/progresso/${compraId}`);
    if (response.ok) {
      const data = await response.json();
      return data.progresso;
    }
  } catch (e) {
    log(`Erro ao consultar progresso: ${e.message}`);
  }
  return null;
}

// Atualiza progresso de captura no servidor
async function atualizarProgresso(compraId, info, paginaAtual, totalPaginas, totalMensagens, capturaCompleta) {
  try {
    await serverFetch(`${SERVER_URL}/api/chat/progresso`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compraId,
        cnpjOrgao: info?.cnpjOrgao,
        ano: info?.ano,
        sequencial: info?.sequencial,
        ultimaPagina: paginaAtual,
        totalPaginas: totalPaginas,
        totalMensagens: totalMensagens,
        capturaCompleta: capturaCompleta
      })
    });
  } catch (e) {
    log(`Erro ao salvar progresso: ${e.message}`);
  }
}

// Captura todas as páginas de mensagens automaticamente (com checkpoint)
// IMPORTANTE: Esta função agora envia mensagens ao servidor durante a captura
async function capturarTodasPaginasMensagens() {
  const todasMensagens = [];
  let temMaisPaginas = true;
  let mensagensEnviadasTotal = 0;

  // Extrai info da licitação para usar como ID
  const info = extrairInfoLicitacao();
  const compraId = info?.compraId;

  // Consulta progresso anterior
  let paginaInicial = 1;
  let progressoAnterior = null;

  if (compraId) {
    progressoAnterior = await consultarProgresso(compraId);
    if (progressoAnterior) {
      if (progressoAnterior.capturaCompleta) {
        log(`Licitação ${compraId} já foi capturada completamente (${progressoAnterior.totalMensagens} msgs)`);
        // Verifica se há novas mensagens - vai para última página conhecida
        paginaInicial = Math.max(1, progressoAnterior.ultimaPagina);
        log(`Verificando novas mensagens a partir da página ${paginaInicial}...`);
      } else {
        // Continua de onde parou
        paginaInicial = progressoAnterior.ultimaPagina + 1;
        log(`Retomando captura da página ${paginaInicial} (parou na ${progressoAnterior.ultimaPagina})`);
      }
    }
  }

  // Navega para a página inicial se não for 1
  let paginaAtual = 1;
  if (paginaInicial > 1) {
    log(`Navegando para página ${paginaInicial}...`);

    // Tenta clicar direto no número da página
    const botoesPagina = document.querySelectorAll('.p-paginator-page');
    let navegou = false;

    for (const btn of botoesPagina) {
      const num = parseInt(btn.innerText);
      if (num === paginaInicial) {
        btn.click();
        await aguardar(1000);
        paginaAtual = paginaInicial;
        navegou = true;
        break;
      }
    }

    // Se não encontrou o botão direto, navega página por página
    if (!navegou) {
      for (let p = 1; p < paginaInicial; p++) {
        const btnProximo = document.querySelector('.p-paginator-next:not(.p-disabled)');
        if (btnProximo) {
          btnProximo.click();
          await aguardar(600);
          paginaAtual = p + 1;
        } else {
          break;
        }
      }
    }
  }

  log(`Iniciando captura a partir da página ${paginaAtual}...`);

  // Detecta total de páginas
  let totalPaginasDetectado = 1;
  const ultimaPaginaBtn = document.querySelector('.p-paginator-last');
  if (ultimaPaginaBtn) {
    const texto = ultimaPaginaBtn.getAttribute('aria-label') || '';
    const match = texto.match(/(\d+)/);
    if (match) totalPaginasDetectado = parseInt(match[1]);
  }
  // Ou pelo último número visível
  const todosBotoesPag = document.querySelectorAll('.p-paginator-page');
  if (todosBotoesPag.length > 0) {
    const ultimoNum = parseInt(todosBotoesPag[todosBotoesPag.length - 1].innerText);
    if (ultimoNum > totalPaginasDetectado) totalPaginasDetectado = ultimoNum;
  }

  let totalMensagensCapturadas = progressoAnterior?.totalMensagens || 0;

  while (temMaisPaginas && paginaAtual <= 100) { // Limite de 100 páginas
    // Verifica se o monitoramento foi cancelado
    const estadoAtual = await chrome.storage.local.get(['monitoramentoAtivo']);
    if (!estadoAtual.monitoramentoAtivo) {
      log('Captura interrompida - monitoramento cancelado');
      break;
    }

    // Captura mensagens da página atual
    const mensagensPagina = extrairMensagensDoChat();
    log(`Página ${paginaAtual}: ${mensagensPagina.length} mensagens`);

    // Filtra mensagens não duplicadas
    const mensagensNovas = [];
    mensagensPagina.forEach(msg => {
      if (!todasMensagens.some(m => m.texto === msg.texto)) {
        todasMensagens.push(msg);
        mensagensNovas.push(msg);
      }
    });

    totalMensagensCapturadas += mensagensNovas.length;

    // ENVIA MENSAGENS AO SERVIDOR IMEDIATAMENTE (a cada página)
    if (info && mensagensNovas.length > 0) {
      const resultEnvio = await enviarMensagens(mensagensNovas, info);
      mensagensEnviadasTotal += resultEnvio.inseridas || 0;
      log(`Página ${paginaAtual}: enviadas ${resultEnvio.inseridas || 0} ao servidor`);
    }

    // Atualiza progresso no servidor a cada página
    if (compraId) {
      await atualizarProgresso(compraId, info, paginaAtual, totalPaginasDetectado, totalMensagensCapturadas, false);
    }

    // Procura botão da próxima página
    const botoesPaginacao = document.querySelectorAll('.p-paginator-page');
    let encontrouProxima = false;

    for (const btn of botoesPaginacao) {
      const numPagina = parseInt(btn.innerText);
      if (numPagina === paginaAtual + 1) {
        btn.click();
        await aguardar(800); // Espera carregar
        paginaAtual++;
        encontrouProxima = true;
        break;
      }
    }

    if (!encontrouProxima) {
      // Tenta botão "próximo" (>)
      const btnProximo = document.querySelector('.p-paginator-next:not(.p-disabled)');
      if (btnProximo) {
        btnProximo.click();
        await aguardar(800);
        paginaAtual++;
      } else {
        temMaisPaginas = false;
      }
    }
  }

  // Marca como captura completa
  if (compraId) {
    await atualizarProgresso(compraId, info, paginaAtual, paginaAtual, totalMensagensCapturadas, true);
    log(`Captura completa! Progresso salvo.`);
  }

  log(`Total capturado: ${todasMensagens.length} mensagens de ${paginaAtual} páginas`);
  log(`Total enviado ao servidor: ${mensagensEnviadasTotal} mensagens`);
  return todasMensagens;
}

async function enviarMensagens(mensagens, infoLicitacao) {
  if (!mensagens || mensagens.length === 0) return { inseridas: 0 };

  try {
    const response = await serverFetch(`${SERVER_URL}/api/chat/mensagens/extensao`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        licitacao: infoLicitacao,
        mensagens: mensagens,
        url: window.location.href,
        timestamp: new Date().toISOString()
      })
    });

    if (response.ok) {
      const result = await response.json();
      log(`Enviadas ${result.inseridas} novas, ${result.duplicadas} duplicadas`);
      return result;
    }
  } catch (error) {
    log(`Erro ao enviar: ${error.message}`);
  }
  return { inseridas: 0 };
}

async function clicarBotaoMensagens() {
  // Procura o botão de mensagens
  const botoes = document.querySelectorAll('button');
  for (const btn of botoes) {
    const ariaLabel = btn.getAttribute('aria-label') || '';
    if (ariaLabel.includes('Mensagens') || btn.querySelector('.fa-envelope')) {
      btn.click();
      return true;
    }
  }

  const icone = document.querySelector('.fa-envelope');
  if (icone) {
    const btn = icone.closest('button');
    if (btn) {
      btn.click();
      return true;
    }
  }
  return false;
}

async function capturarMensagensDaPagina() {
  const info = extrairInfoLicitacao();
  if (!info) {
    log('Não está em uma página de licitação');
    return { success: false };
  }

  log(`Capturando licitação ${info.sequencial}/${info.ano}...`);

  // Clica no botão de mensagens
  const clicou = await clicarBotaoMensagens();
  if (!clicou) {
    log('Botão de mensagens não encontrado');
    return { success: false, message: 'Botão não encontrado' };
  }

  await aguardar(2500);

  const mensagens = extrairMensagensDoChat();
  log(`Encontradas ${mensagens.length} mensagens`);

  if (mensagens.length > 0) {
    const result = await enviarMensagens(mensagens, info);

    // Fecha o sidebar
    const btnFechar = document.querySelector('.p-sidebar-close, [aria-label="Close"]');
    if (btnFechar) btnFechar.click();

    return { success: true, ...result };
  }

  return { success: true, inseridas: 0 };
}

// Coleta links das licitações na página de participações
function coletarLinksLicitacoes() {
  const links = [];

  // Debug: mostra estrutura da página
  log('DEBUG: Analisando estrutura da página...');

  // Estratégia 1: Links diretos com "compra=" na URL
  document.querySelectorAll('a[href*="compra="]').forEach(a => {
    const href = a.href || a.getAttribute('href');
    if (href && !links.includes(href)) {
      links.push(href);
      log(`DEBUG: Link encontrado (direto): ${href.substring(0, 80)}...`);
    }
  });

  // Estratégia 2: Links com "acompanhamento-compra"
  document.querySelectorAll('a[href*="acompanhamento-compra"]').forEach(a => {
    const href = a.href || a.getAttribute('href');
    if (href && !links.includes(href)) {
      links.push(href);
      log(`DEBUG: Link encontrado (acompanhamento): ${href.substring(0, 80)}...`);
    }
  });

  // Estratégia 3: Links dentro de tabelas PrimeNG
  document.querySelectorAll('.p-datatable a, p-table a, [class*="datatable"] a').forEach(a => {
    const href = a.href || a.getAttribute('href');
    if (href && href.includes('compra') && !links.includes(href)) {
      links.push(href);
      log(`DEBUG: Link encontrado (datatable): ${href.substring(0, 80)}...`);
    }
  });

  // Estratégia 4: Qualquer link que pareça ser de licitação
  document.querySelectorAll('a').forEach(a => {
    const href = a.href || a.getAttribute('href') || '';
    const texto = a.innerText || '';
    if ((href.includes('compra') || href.includes('licitacao') || href.includes('pregao')) && !links.includes(href)) {
      if (href.startsWith('http')) {
        links.push(href);
        log(`DEBUG: Link encontrado (genérico): ${href.substring(0, 80)}...`);
      }
    }
  });

  // Estratégia 5: Busca por elementos clicáveis com routerLink (Angular)
  document.querySelectorAll('[routerlink*="compra"], [ng-reflect-router-link*="compra"]').forEach(el => {
    const routerLink = el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link') || '';
    if (routerLink) {
      const fullUrl = new URL(routerLink, window.location.origin).href;
      if (!links.includes(fullUrl)) {
        links.push(fullUrl);
        log(`DEBUG: Link encontrado (routerLink): ${fullUrl.substring(0, 80)}...`);
      }
    }
  });

  // Debug: mostra elementos da página para diagnóstico
  if (links.length === 0) {
    log('DEBUG: Nenhum link encontrado. Analisando página...');

    // Mostra tabelas encontradas
    const tabelas = document.querySelectorAll('table, .p-datatable, p-table, [class*="table"]');
    log(`DEBUG: Tabelas encontradas: ${tabelas.length}`);

    // Mostra todos os links da página
    const todosLinks = document.querySelectorAll('a');
    log(`DEBUG: Total de links na página: ${todosLinks.length}`);

    // Mostra os primeiros 5 links para debug
    let count = 0;
    todosLinks.forEach(a => {
      if (count < 10) {
        const href = a.href || '';
        if (href && !href.includes('javascript:')) {
          log(`DEBUG: Link ${count + 1}: ${href.substring(0, 100)}`);
          count++;
        }
      }
    });

    // Mostra texto de cards/itens que podem conter licitações
    const cards = document.querySelectorAll('.card, .p-card, [class*="card"], [class*="item"], [class*="row"]');
    log(`DEBUG: Cards/itens encontrados: ${cards.length}`);
  }

  return links;
}

// Lista de status para monitorar (ordem de prioridade)
const STATUS_PARA_MONITORAR = [
  'Em andamento',
  'Propostas',
  'Disputa',
  'Seleção de fornecedores',
  'Homologado',
  'Encerrado',
  'Adjudicado',
  'Suspenso',
  'Revogado',
  'Anulado',
  'Fracassado',
  'Deserto'
];

// Obtém os status disponíveis no dropdown
async function obterStatusDisponiveis() {
  const statusList = [];

  // Clica no dropdown para abrir
  const dropdown = document.querySelector('.p-dropdown, [role="combobox"]');
  if (!dropdown) {
    log('Dropdown de status não encontrado');
    return statusList;
  }

  dropdown.click();
  await aguardar(500);

  // Pega as opções do dropdown
  const opcoes = document.querySelectorAll('.p-dropdown-item, [role="option"]');
  opcoes.forEach(opt => {
    const texto = opt.innerText?.trim();
    if (texto && texto.length > 0) {
      statusList.push(texto);
    }
  });

  // Fecha o dropdown clicando fora
  document.body.click();
  await aguardar(300);

  log(`Status disponíveis: ${statusList.join(', ')}`);
  return statusList;
}

// Seleciona um status no dropdown
async function selecionarStatus(statusDesejado) {
  log(`Selecionando status: ${statusDesejado}`);

  // Clica no dropdown para abrir
  const dropdown = document.querySelector('.p-dropdown, [role="combobox"]');
  if (!dropdown) {
    log('Dropdown não encontrado');
    return false;
  }

  dropdown.click();
  await aguardar(500);

  // Procura a opção desejada
  const opcoes = document.querySelectorAll('.p-dropdown-item, [role="option"]');
  for (const opt of opcoes) {
    const texto = opt.innerText?.trim().toLowerCase();
    if (texto === statusDesejado.toLowerCase() || texto.includes(statusDesejado.toLowerCase())) {
      opt.click();
      log(`Status "${statusDesejado}" selecionado`);
      await aguardar(2000); // Aguarda a lista atualizar
      return true;
    }
  }

  // Fecha o dropdown
  document.body.click();
  await aguardar(300);

  log(`Status "${statusDesejado}" não encontrado`);
  return false;
}

// Conta licitações do status atual
function contarLicitacoesDoStatus() {
  const textoTotal = document.body.innerText.match(/Exibindo \d+ de (\d+) registro/);
  if (textoTotal) {
    return parseInt(textoTotal[1]);
  }
  const botoes = document.querySelectorAll('button[aria-label="Participar/acompanhar compra"]');
  return botoes.length;
}

// Modo automático - navega automaticamente pelas licitações de TODOS os status
// config: { statusInicial, paginaInicial, indiceInicial } ou null para iniciar do começo
async function processarPaginaParticipacoes(config = null) {
  // RESETA FLAG DE PARADA
  PARAR_MONITORAMENTO = false;

  log('=== INICIANDO MONITORAMENTO AUTOMÁTICO (MULTI-STATUS) ===');

  if (config) {
    log(`CONFIG: Iniciar de "${config.statusInicial}", página ${config.paginaInicial}, índice ${config.indiceInicial}`);
  }

  // Aguarda a página carregar
  await aguardar(3000);

  // Obtém lista de status disponíveis
  const statusDisponiveis = await obterStatusDisponiveis();

  if (statusDisponiveis.length === 0) {
    log('Nenhum status encontrado no dropdown');
    // Tenta processar a página atual mesmo assim
  }

  // Filtra apenas os status que queremos monitorar e que estão disponíveis
  const statusParaProcessar = STATUS_PARA_MONITORAR.filter(s =>
    statusDisponiveis.some(d => d.toLowerCase().includes(s.toLowerCase()))
  );

  // Se não encontrou nenhum status específico, tenta com todos disponíveis
  const listaFinal = statusParaProcessar.length > 0 ? statusParaProcessar : statusDisponiveis;

  log(`Status a processar: ${listaFinal.join(', ')}`);

  // Calcula total de licitações de todos os status
  let totalGeral = 0;
  const statusComTotal = [];

  for (const status of listaFinal) {
    if (await selecionarStatus(status)) {
      await aguardar(1500);
      const total = contarLicitacoesDoStatus();
      if (total > 0) {
        statusComTotal.push({ status, total });
        totalGeral += total;
        log(`${status}: ${total} licitações`);
      }
    }
  }

  if (statusComTotal.length === 0) {
    // Tenta processar o status atual se não conseguiu listar
    const totalAtual = contarLicitacoesDoStatus();
    if (totalAtual > 0) {
      statusComTotal.push({ status: 'Atual', total: totalAtual });
      totalGeral = totalAtual;
    }
  }

  log(`Total geral: ${totalGeral} licitações em ${statusComTotal.length} status`);

  if (totalGeral === 0) {
    log('Nenhuma licitação encontrada');
    alert('Nenhuma licitação encontrada. Verifique se você está na aba "Minhas participações".');
    return;
  }

  // Determina o ponto de início baseado na configuração
  let statusInicialIndex = 0;
  let paginaInicial = 1;
  let indiceInicial = 0;

  if (config && config.statusInicial) {
    log(`CONFIG RECEBIDA: statusInicial="${config.statusInicial}", paginaInicial=${config.paginaInicial}, indiceInicial=${config.indiceInicial}`);

    // Lista os status disponíveis para debug
    log(`STATUS DISPONÍVEIS: ${statusComTotal.map(s => s.status).join(' | ')}`);

    // Encontra o índice do status inicial - busca mais flexível
    const statusBuscado = config.statusInicial.toLowerCase().trim();
    let indexEncontrado = -1;

    for (let i = 0; i < statusComTotal.length; i++) {
      const statusAtual = statusComTotal[i].status.toLowerCase().trim();
      log(`  Comparando: "${statusBuscado}" vs "${statusAtual}"`);

      // Verifica se é exatamente igual ou se contém
      if (statusAtual === statusBuscado ||
          statusAtual.includes(statusBuscado) ||
          statusBuscado.includes(statusAtual) ||
          // Comparação sem acentos
          statusAtual.normalize('NFD').replace(/[\u0300-\u036f]/g, '') ===
          statusBuscado.normalize('NFD').replace(/[\u0300-\u036f]/g, '')) {
        indexEncontrado = i;
        log(`  MATCH! Índice ${i}`);
        break;
      }
    }

    if (indexEncontrado >= 0) {
      statusInicialIndex = indexEncontrado;
      log(`Status inicial encontrado: "${statusComTotal[indexEncontrado].status}" (índice ${statusInicialIndex})`);
    } else {
      log(`AVISO: Status "${config.statusInicial}" NÃO encontrado nos ${statusComTotal.length} status disponíveis`);
      log(`Iniciando do primeiro status: "${statusComTotal[0]?.status}"`);
    }

    paginaInicial = config.paginaInicial || 1;
    // O índice vem como 1-based do usuário, convertemos para 0-based
    indiceInicial = (config.indiceInicial || 1) - 1;
  }

  // Calcula quantas licitações serão puladas
  let licitacoesPuladas = 0;
  for (let i = 0; i < statusInicialIndex; i++) {
    licitacoesPuladas += statusComTotal[i].total;
  }
  // Estima licitações puladas pela página (10 por página normalmente)
  const LICITACOES_POR_PAGINA = 10;
  licitacoesPuladas += (paginaInicial - 1) * LICITACOES_POR_PAGINA;
  licitacoesPuladas += indiceInicial;

  log(`Licitações que serão puladas: ${licitacoesPuladas}`);

  // Salva estado inicial
  await chrome.storage.local.set({
    monitoramentoAtivo: true,
    totalLicitacoes: totalGeral,
    licitacoesProcessadas: licitacoesPuladas, // Considera as puladas como já processadas
    paginaAtual: paginaInicial,
    indiceLicitacaoAtual: indiceInicial,
    statusParaProcessar: statusComTotal,
    statusAtualIndex: statusInicialIndex,
    statusAtualNome: statusComTotal[statusInicialIndex]?.status || null
  });

  // Mostra painel de progresso
  mostrarPainelProgresso(licitacoesPuladas, totalGeral);

  // Seleciona o status inicial
  const statusParaSelecionar = statusComTotal[statusInicialIndex];
  if (statusParaSelecionar) {
    log(`Selecionando status inicial: ${statusParaSelecionar.status}`);
    atualizarPainelProgresso(licitacoesPuladas, totalGeral, `Status: ${statusParaSelecionar.status}...`);
    await selecionarStatus(statusParaSelecionar.status);
    await aguardar(3000);

    // Navega para a página inicial se não for a primeira
    if (paginaInicial > 1) {
      log(`Navegando para página ${paginaInicial}...`);
      atualizarPainelProgresso(licitacoesPuladas, totalGeral, `Página ${paginaInicial}...`);
      await navegarParaPagina(paginaInicial);
      await aguardar(3000);
    }
  }

  // Inicia processamento
  await processarLicitacoesDaPagina();
}

// Processa todas as licitações da página atual
async function processarLicitacoesDaPagina() {
  try {
    // Verifica flag de parada imediata
    if (PARAR_MONITORAMENTO) {
      log('Monitoramento já foi parado');
      return;
    }

    const dados = await chrome.storage.local.get(['monitoramentoAtivo', 'licitacoesProcessadas', 'totalLicitacoes', 'indiceLicitacaoAtual']);

    if (!dados.monitoramentoAtivo) {
      log('Monitoramento cancelado pelo usuário');
      return;
    }

  // Aguarda a página carregar com retry
  let botoesLicitacao = document.querySelectorAll('button[aria-label="Participar/acompanhar compra"]');
  let tentativas = 0;

  while (botoesLicitacao.length === 0 && tentativas < 5) {
    tentativas++;
    log(`Aguardando página carregar... (tentativa ${tentativas}/5)`);
    await aguardar(3000);
    botoesLicitacao = document.querySelectorAll('button[aria-label="Participar/acompanhar compra"]');
  }

  const totalBotoes = botoesLicitacao.length;

  log(`Página tem ${totalBotoes} licitações`);

  if (totalBotoes === 0) {
    log('Nenhum botão de licitação encontrado após aguardar');
    // Verifica se a página está mesmo carregada
    const textoExibindo = document.body.innerText.match(/Exibindo \d+ de (\d+) registro/);
    if (textoExibindo) {
      log('Texto "Exibindo" encontrado mas sem botões - aguardando mais...');
      await aguardar(5000);
      botoesLicitacao = document.querySelectorAll('button[aria-label="Participar/acompanhar compra"]');
      if (botoesLicitacao.length === 0) {
        log('Ainda sem botões - indo para próxima página');
        await verificarProximaPagina();
        return;
      }
    } else {
      await verificarProximaPagina();
      return;
    }
  }

  // PROCESSAMENTO EM ORDEM REVERSA (mais recentes primeiro)
  // O índice agora vai do último para o primeiro (totalBotoes-1 até 0)
  // indiceLicitacaoAtual guarda quantas já foram processadas nesta página

  let jaProcessadasNaPagina = dados.indiceLicitacaoAtual || 0;

  // Se já processou todos desta página, vai para próxima
  if (jaProcessadasNaPagina >= totalBotoes) {
    log('Todos desta página já processados, indo para próxima...');
    await chrome.storage.local.set({ indiceLicitacaoAtual: 0 });
    await verificarProximaPagina();
    return;
  }

  // Processa do último para o primeiro (mais recentes primeiro)
  for (let contador = jaProcessadasNaPagina; contador < totalBotoes; contador++) {
    // Índice real no array (reverso): último - contador
    const i = totalBotoes - 1 - contador;

    const dadosAtuais = await chrome.storage.local.get(['monitoramentoAtivo', 'licitacoesProcessadas']);
    if (!dadosAtuais.monitoramentoAtivo) {
      log('Monitoramento cancelado');
      break;
    }

    const processadas = dadosAtuais.licitacoesProcessadas || 0;

    log(`\n--- Licitação ${processadas + 1}/${dados.totalLicitacoes} (posição ${i + 1} da página, mais recente primeiro) ---`);
    atualizarPainelProgresso(processadas + 1, dados.totalLicitacoes, 'Preparando...');

    // Salva quantas já foram processadas nesta página
    await chrome.storage.local.set({ indiceLicitacaoAtual: contador + 1 });

    // Delay antes de clicar (4-6 segundos)
    const delayAntes = 4000 + Math.random() * 2000;
    log(`Aguardando ${Math.round(delayAntes/1000)}s...`);
    atualizarPainelProgresso(processadas + 1, dados.totalLicitacoes, `Aguardando ${Math.round(delayAntes/1000)}s...`);
    await aguardar(delayAntes);

    // Verifica novamente se foi cancelado após o delay
    const verificaParada = await chrome.storage.local.get(['monitoramentoAtivo']);
    if (!verificaParada.monitoramentoAtivo) {
      log('Monitoramento cancelado durante o delay');
      return; // Sai completamente da função
    }

    // Re-obtém os botões (podem ter mudado após delay)
    const botoesAtuais = document.querySelectorAll('button[aria-label="Participar/acompanhar compra"]');
    if (i >= botoesAtuais.length || i < 0) {
      log('Botão não encontrado após delay');
      continue;
    }

    // Clica no botão para abrir a licitação
    log('Clicando no botão da licitação...');
    botoesAtuais[i].click();

    // Aguarda o modal aparecer
    await aguardar(2000);

    // Verifica se abriu um modal
    const modal = document.querySelector('.modal.show, .modal.fade.show, modal-container');
    if (modal) {
      log('Modal detectado! Procurando botão de navegação...');

      // Loga o conteúdo do modal para debug
      const textoModal = modal.innerText?.substring(0, 500);
      log(`Conteúdo do modal: ${textoModal}`);

      // Procura botões/links dentro do modal que possam levar à licitação
      const botoesModal = modal.querySelectorAll('button, a');
      log(`Encontrados ${botoesModal.length} botões/links no modal`);

      for (const btn of botoesModal) {
        const texto = btn.innerText?.toLowerCase() || '';
        const aria = btn.getAttribute('aria-label')?.toLowerCase() || '';
        log(`  - ${btn.tagName}: "${btn.innerText?.substring(0, 30)}" aria="${aria}"`);

        // Procura por botões de acompanhamento/acesso
        if (texto.includes('acompanhar') || texto.includes('acessar') ||
            texto.includes('entrar') || texto.includes('ir para') ||
            aria.includes('acompanhar') || aria.includes('acessar')) {
          log('Clicando no botão de acompanhamento do modal...');
          btn.click();
          await aguardar(3000);
          break;
        }
      }

      // Fecha o modal se ainda estiver aberto e não navegou
      if (!window.location.href.includes('acompanhamento-compra')) {
        const btnFecharModal = modal.querySelector('.close, [data-dismiss="modal"], button.btn-close');
        if (btnFecharModal) {
          log('Fechando modal...');
          btnFecharModal.click();
          await aguardar(1000);
        }
      }
    }

    // Aguarda possível navegação
    await aguardar(2000);

    // Verifica se navegou para a página da licitação (pode ser disputa ou acompanhamento)
    const urlAtual = window.location.href;
    if (urlAtual.includes('acompanhamento-compra') || urlAtual.includes('disputa?compra') || urlAtual.includes('compra=')) {
      // Navegou para a página da licitação
      log('Navegou para: ' + urlAtual);
      atualizarPainelProgresso(processadas + 1, dados.totalLicitacoes, 'Na página da licitação...');

      // Fecha qualquer popup/modal que esteja aberto
      await aguardar(2000);
      const modaisAbertos = document.querySelectorAll('.modal.show, .p-dialog, [role="dialog"]');
      for (const modal of modaisAbertos) {
        const btnFechar = modal.querySelector('.close, .p-dialog-header-close, [data-dismiss="modal"], button[aria-label="Close"]');
        if (btnFechar) {
          log('Fechando popup na página da licitação...');
          btnFechar.click();
          await aguardar(1000);
        }
      }

      // Procura o botão de mensagens
      await aguardar(2000);
      let btnMensagens = document.querySelector('button[aria-label="Mensagens da compra"]');

      // Se não encontrou, tenta outros seletores
      if (!btnMensagens) {
        btnMensagens = document.querySelector('button[aria-label*="Mensagens"], button[aria-label*="mensagens"]');
      }
      if (!btnMensagens) {
        // Procura por ícone de envelope
        const iconeEnvelope = document.querySelector('.fa-envelope, .fas.fa-envelope');
        if (iconeEnvelope) {
          btnMensagens = iconeEnvelope.closest('button');
        }
      }

      if (btnMensagens) {
        log('Abrindo mensagens...');
        atualizarPainelProgresso(processadas + 1, dados.totalLicitacoes, 'Abrindo mensagens...');

        await aguardar(2000 + Math.random() * 2000);
        btnMensagens.click();

        // Aguarda sidebar abrir
        await aguardar(3000);

        // Captura mensagens
        const info = extrairInfoLicitacao();
        if (info) {
          atualizarPainelProgresso(processadas + 1, dados.totalLicitacoes, 'Capturando mensagens...');
          const mensagens = await capturarTodasPaginasMensagens();

          if (mensagens.length > 0) {
            await enviarMensagens(mensagens, info);
            log(`Capturadas ${mensagens.length} mensagens`);
            mostrarNotificacao(`${mensagens.length} mensagens capturadas!`);
          } else {
            log('Nenhuma mensagem encontrada');
          }

          // Fecha o sidebar
          await aguardar(1000);
          const btnFechar = document.querySelector('.p-sidebar-close, button[aria-label="Close"]');
          if (btnFechar) btnFechar.click();
        }
      } else {
        log('Botão de mensagens não encontrado nesta licitação');
      }

      // Atualiza contador
      await chrome.storage.local.set({
        licitacoesProcessadas: processadas + 1
      });

      // Volta para a lista
      await aguardar(2000);
      log('Voltando para lista de participações...');
      window.location.href = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras';
      return; // O processamento continua quando a página recarregar
    } else {
      log('Não navegou para a página da licitação');
    }
  }

  // Se chegou aqui, terminou todos os botões desta página
  await chrome.storage.local.set({ indiceLicitacaoAtual: 0 });
  await verificarProximaPagina();

  } catch (error) {
    if (error.message === 'MONITORAMENTO_PARADO') {
      log('=== Monitoramento interrompido pelo usuário ===');
      // Limpa o painel
      const painel = document.getElementById('pncp-chrome-progresso');
      if (painel) painel.remove();
    } else {
      log(`ERRO no processamento: ${error.message}`);
      throw error; // Re-lança outros erros
    }
  }
}

// Verifica e navega para próxima página de licitações ou próximo status
async function verificarProximaPagina() {
  // Verifica parada imediata
  if (PARAR_MONITORAMENTO) {
    log('Parada detectada em verificarProximaPagina');
    return;
  }

  const dados = await chrome.storage.local.get([
    'monitoramentoAtivo', 'licitacoesProcessadas', 'totalLicitacoes',
    'paginaAtual', 'statusParaProcessar', 'statusAtualIndex'
  ]);

  if (!dados.monitoramentoAtivo || PARAR_MONITORAMENTO) return;

  // Verifica se completou TODAS as licitações de TODOS os status
  if (dados.licitacoesProcessadas >= dados.totalLicitacoes) {
    log('=== MONITORAMENTO COMPLETO! ===');
    atualizarPainelProgresso(dados.totalLicitacoes, dados.totalLicitacoes, 'COMPLETO!');
    await chrome.storage.local.set({ monitoramentoAtivo: false });
    alert(`Monitoramento concluído!\n\n${dados.totalLicitacoes} licitações processadas.`);
    return;
  }

  log('Procurando botão de próxima página...');

  // Verifica se há mais páginas no status atual
  let btnProxima = document.querySelector('.p-paginator-next:not(.p-disabled)');

  if (!btnProxima) {
    btnProxima = document.querySelector('button.p-paginator-next:not([disabled])');
  }
  if (!btnProxima) {
    const iconeProximo = document.querySelector('.p-paginator-next .pi-angle-right, .p-paginator-next .fa-chevron-right');
    if (iconeProximo) {
      btnProxima = iconeProximo.closest('button');
      if (btnProxima && btnProxima.disabled) btnProxima = null;
    }
  }
  if (!btnProxima) {
    const paginaAtual = dados.paginaAtual || 1;
    const botoesPagina = document.querySelectorAll('.p-paginator-page, button[class*="paginator"]');
    log(`Encontrados ${botoesPagina.length} botões de paginação`);

    for (const btn of botoesPagina) {
      const num = parseInt(btn.innerText);
      if (num === paginaAtual + 1 && !btn.disabled && !btn.classList.contains('p-disabled')) {
        btnProxima = btn;
        log(`Selecionado botão da página ${num}`);
        break;
      }
    }
  }

  if (btnProxima) {
    // Há mais páginas neste status - navega para próxima
    const novaPagina = (dados.paginaAtual || 1) + 1;
    log(`Indo para página ${novaPagina} do status atual...`);
    atualizarPainelProgresso(dados.licitacoesProcessadas, dados.totalLicitacoes, `Página ${novaPagina}...`);

    await aguardar(2000);
    btnProxima.click();

    await chrome.storage.local.set({
      paginaAtual: novaPagina,
      indiceLicitacaoAtual: 0
    });

    await aguardar(4000);
    await processarLicitacoesDaPagina();
  } else {
    // Não há mais páginas - tenta ir para o próximo status
    log('Sem mais páginas neste status. Verificando próximo status...');
    await irParaProximoStatus();
  }
}

// Navega para o próximo status da lista
async function irParaProximoStatus() {
  // Verifica parada imediata
  if (PARAR_MONITORAMENTO) {
    log('Parada detectada em irParaProximoStatus');
    return;
  }

  const dados = await chrome.storage.local.get([
    'monitoramentoAtivo', 'licitacoesProcessadas', 'totalLicitacoes',
    'statusParaProcessar', 'statusAtualIndex'
  ]);

  if (!dados.monitoramentoAtivo || PARAR_MONITORAMENTO) return;

  const statusList = dados.statusParaProcessar || [];
  const indexAtual = dados.statusAtualIndex || 0;
  const proximoIndex = indexAtual + 1;

  if (proximoIndex >= statusList.length) {
    // Não há mais status - verifica se completou tudo
    if (dados.licitacoesProcessadas >= dados.totalLicitacoes) {
      log('=== MONITORAMENTO COMPLETO! ===');
      atualizarPainelProgresso(dados.totalLicitacoes, dados.totalLicitacoes, 'COMPLETO!');
      await chrome.storage.local.set({ monitoramentoAtivo: false });
      alert(`Monitoramento concluído!\n\n${dados.totalLicitacoes} licitações processadas.`);
    } else {
      log(`Todos os status processados. ${dados.licitacoesProcessadas}/${dados.totalLicitacoes} licitações.`);
      atualizarPainelProgresso(dados.licitacoesProcessadas, dados.totalLicitacoes, 'Finalizado');
      await chrome.storage.local.set({ monitoramentoAtivo: false });
    }
    return;
  }

  // Navega para o próximo status
  const proximoStatus = statusList[proximoIndex];
  log(`=== MUDANDO PARA STATUS: ${proximoStatus.status} (${proximoStatus.total} licitações) ===`);
  atualizarPainelProgresso(dados.licitacoesProcessadas, dados.totalLicitacoes, `Status: ${proximoStatus.status}...`);

  // Atualiza o índice do status e o nome
  await chrome.storage.local.set({
    statusAtualIndex: proximoIndex,
    statusAtualNome: proximoStatus.status,
    paginaAtual: 1,
    indiceLicitacaoAtual: 0
  });

  // Seleciona o status no dropdown
  if (await selecionarStatus(proximoStatus.status)) {
    await aguardar(3000);
    await processarLicitacoesDaPagina();
  } else {
    log(`Erro ao selecionar status ${proximoStatus.status}. Tentando próximo...`);
    await irParaProximoStatus();
  }
}

// Navega para uma página específica da lista
async function navegarParaPagina(paginaDestino) {
  log(`Navegando para página ${paginaDestino} da lista...`);

  // Se já estamos na página 1, não precisa navegar
  if (paginaDestino <= 1) return true;

  // Tenta clicar diretamente no número da página
  const botoesPagina = document.querySelectorAll('.p-paginator-page, button[class*="paginator"]');
  for (const btn of botoesPagina) {
    const num = parseInt(btn.innerText);
    if (num === paginaDestino) {
      log(`Clicando no botão da página ${paginaDestino}`);
      btn.click();
      await aguardar(4000);
      return true;
    }
  }

  // Se não encontrou o número direto, navega página por página
  for (let p = 1; p < paginaDestino; p++) {
    let btnProxima = document.querySelector('.p-paginator-next:not(.p-disabled)');
    if (!btnProxima) {
      btnProxima = document.querySelector('button.p-paginator-next:not([disabled])');
    }

    if (btnProxima) {
      log(`Avançando para página ${p + 1}...`);
      btnProxima.click();
      await aguardar(3000);
    } else {
      log(`Não foi possível avançar para página ${p + 1}`);
      return false;
    }
  }

  return true;
}

// Processa a página de licitação atual (quando retoma navegação)
async function processarPaginaLicitacaoAtual(dados) {
  const processadas = dados.licitacoesProcessadas || 0;

  log('Processando página de licitação atual...');
  mostrarPainelProgresso(processadas, dados.totalLicitacoes);
  atualizarPainelProgresso(processadas + 1, dados.totalLicitacoes, 'Processando licitação...');

  // Fecha qualquer popup/modal que esteja aberto
  await aguardar(2000);
  const modaisAbertos = document.querySelectorAll('.modal.show, .p-dialog, [role="dialog"]');
  for (const modal of modaisAbertos) {
    const btnFechar = modal.querySelector('.close, .p-dialog-header-close, [data-dismiss="modal"], button[aria-label="Close"]');
    if (btnFechar) {
      log('Fechando popup...');
      btnFechar.click();
      await aguardar(1000);
    }
  }

  // Procura o botão de mensagens
  await aguardar(2000);
  let btnMensagens = document.querySelector('button[aria-label="Mensagens da compra"]');

  if (!btnMensagens) {
    btnMensagens = document.querySelector('button[aria-label*="Mensagens"], button[aria-label*="mensagens"]');
  }
  if (!btnMensagens) {
    const iconeEnvelope = document.querySelector('.fa-envelope, .fas.fa-envelope');
    if (iconeEnvelope) {
      btnMensagens = iconeEnvelope.closest('button');
    }
  }

  if (btnMensagens) {
    log('Abrindo mensagens...');
    atualizarPainelProgresso(processadas + 1, dados.totalLicitacoes, 'Abrindo mensagens...');

    await aguardar(2000);
    btnMensagens.click();
    await aguardar(3000);

    const info = extrairInfoLicitacao();
    if (info) {
      atualizarPainelProgresso(processadas + 1, dados.totalLicitacoes, 'Capturando mensagens...');
      const mensagens = await capturarTodasPaginasMensagens();

      if (mensagens.length > 0) {
        await enviarMensagens(mensagens, info);
        log(`Capturadas ${mensagens.length} mensagens`);
        mostrarNotificacao(`${mensagens.length} mensagens capturadas!`);
      }

      // Fecha o sidebar
      await aguardar(1000);
      const btnFechar = document.querySelector('.p-sidebar-close, button[aria-label="Close"]');
      if (btnFechar) btnFechar.click();
    }
  } else {
    log('Botão de mensagens não encontrado');
  }

  // Atualiza contador
  await chrome.storage.local.set({
    licitacoesProcessadas: processadas + 1
  });

  // Volta para a lista
  await aguardar(2000);
  log('Voltando para lista de participações...');
  window.location.href = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras';
}

// Mostra painel de progresso flutuante
function mostrarPainelProgresso(atual, total) {
  // Remove painel existente
  const painelExistente = document.getElementById('pncp-chrome-progresso');
  if (painelExistente) painelExistente.remove();

  const painel = document.createElement('div');
  painel.id = 'pncp-chrome-progresso';
  painel.innerHTML = `
    <div style="font-weight: bold; margin-bottom: 10px;">Monitor Comprasnet</div>
    <div id="progresso-texto">Processando ${atual}/${total}</div>
    <div id="progresso-status" style="font-size: 12px; color: #666; margin-top: 5px;">Iniciando...</div>
    <div style="background: #ddd; height: 8px; border-radius: 4px; margin-top: 10px;">
      <div id="progresso-barra" style="background: #4CAF50; height: 100%; border-radius: 4px; width: ${(atual/total)*100}%; transition: width 0.5s;"></div>
    </div>
    <button id="btn-parar-monitor" style="margin-top: 10px; padding: 5px 15px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer;">Parar</button>
  `;
  painel.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: white;
    padding: 20px;
    border-radius: 10px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    z-index: 999999;
    min-width: 250px;
    font-family: Arial, sans-serif;
  `;

  document.body.appendChild(painel);

  // Botão parar
  document.getElementById('btn-parar-monitor').onclick = async () => {
    await chrome.storage.local.set({ monitoramentoAtivo: false });
    painel.remove();
    log('Monitoramento parado pelo usuário');
  };
}

// Atualiza painel de progresso
function atualizarPainelProgresso(atual, total, status) {
  const texto = document.getElementById('progresso-texto');
  const statusEl = document.getElementById('progresso-status');
  const barra = document.getElementById('progresso-barra');

  if (texto) texto.textContent = `Processando ${atual}/${total}`;
  if (statusEl) statusEl.textContent = status;
  if (barra) barra.style.width = `${(atual/total)*100}%`;
}

// Processa a licitação atual e vai para a próxima
async function processarLicitacaoAtual() {
  const data = await chrome.storage.local.get(['linksParaProcessar', 'indiceAtual', 'totalLinks', 'emProcessamento']);

  if (!data.emProcessamento) return;

  const indice = data.indiceAtual || 0;
  const total = data.totalLinks || 0;
  const links = data.linksParaProcessar || [];

  log(`Processando licitação ${indice + 1}/${total}`);
  log(`URL da licitação: ${window.location.href}`);

  // Captura as mensagens desta licitação
  await aguardar(2000);
  const resultado = await capturarMensagensDaPagina();
  log(`Resultado da captura: ${JSON.stringify(resultado)}`);
  await enviarLogsParaServidor();

  // Vai para a próxima
  const proximoIndice = indice + 1;

  if (proximoIndice < links.length) {
    await chrome.storage.local.set({
      linksParaProcessar: links,
      indiceAtual: proximoIndice,
      totalLinks: total,
      emProcessamento: true
    });

    log(`Indo para licitação ${proximoIndice + 1}/${total}`);
    await aguardar(1500);
    window.location.href = links[proximoIndice];
  } else {
    // Terminou!
    log('=== MONITORAMENTO COMPLETO! ===');
    log(`Total processado: ${total} licitações`);
    await enviarLogsParaServidor(); // Envia logs finais
    await chrome.storage.local.set({ emProcessamento: false });

    chrome.runtime.sendMessage({
      type: 'MONITORAMENTO_COMPLETO',
      total: total
    });
  }
}

// Monitora quando o usuário abre mensagens manualmente
let capturaEmAndamento = false;

function monitorarAberturaManual() {
  const observer = new MutationObserver(async (mutations) => {
    // Verifica se um sidebar de mensagens foi aberto
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1 && node.classList) {
          const classe = node.className || '';
          if (classe.includes('p-sidebar') && classe.includes('p-sidebar-active')) {
            // Sidebar aberto - verifica se é de mensagens
            await aguardar(1000);

            const sidebar = document.querySelector('.p-sidebar-active');
            if (sidebar && sidebar.innerText.includes('Mensagens') && !capturaEmAndamento) {
              capturaEmAndamento = true;
              log('=== SIDEBAR DE MENSAGENS DETECTADO ===');

              const info = extrairInfoLicitacao();
              if (info) {
                log(`Licitação: ${info.sequencial}/${info.ano}`);

                // Captura TODAS as páginas automaticamente
                const mensagens = await capturarTodasPaginasMensagens();

                if (mensagens.length > 0) {
                  const result = await enviarMensagens(mensagens, info);
                  log(`Enviadas ${result.inseridas} mensagens novas!`);

                  // Notifica o usuário
                  if (result.inseridas > 0) {
                    mostrarNotificacao(`${result.inseridas} mensagens capturadas!`);
                  }
                } else {
                  log('Nenhuma mensagem encontrada');
                }
              }

              capturaEmAndamento = false;
            }
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// Mostra notificação na página
function mostrarNotificacao(texto, tipo = 'success') {
  const div = document.createElement('div');

  const cores = {
    success: { bg: '#4CAF50', icon: '✓' },
    warning: { bg: '#FF9800', icon: '⚠️' },
    error: { bg: '#f44336', icon: '✗' }
  };

  const config = cores[tipo] || cores.success;

  div.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${config.bg};
    color: white;
    padding: 15px 25px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: bold;
    z-index: 999999;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    animation: fadeIn 0.3s;
  `;
  div.textContent = `${config.icon} ${texto}`;
  document.body.appendChild(div);

  const duracao = tipo === 'warning' ? 8000 : 4000;
  setTimeout(() => div.remove(), duracao);
}

// ==================== PROPOSTAS REMOVIDAS ====================
// Funcionalidade de propostas agora é exclusiva da extensao-propostas
// Funções removidas: enviarPropostaComprasnet, continuarEnvioProposta,
// iniciarPollingPropostas, verificarPropostasPendentes, pararPollingPropostas,
// aguardarElemento, clicarElemento
// ==================== FIM PROPOSTAS REMOVIDAS ====================

// (Compatibilidade: funções stub para mensagens recebidas que ainda referenciam propostas)
async function enviarPropostaComprasnet() {
  log('[Chrome] Propostas agora são gerenciadas exclusivamente pela extensao-propostas');
  return { success: false, error: 'Use extensao-propostas para enviar propostas' };
}
async function continuarEnvioProposta() {}
function iniciarPollingPropostas() {}
function pararPollingPropostas() {}

// REMOVIDO: ~900 linhas de código duplicado de propostas
// As funções originais (enviarPropostaComprasnet, continuarEnvioProposta,
// iniciarPollingPropostas, verificarPropostasPendentes, pararPollingPropostas)
// agora existem apenas em extensao-propostas/content.js


// Escuta mensagens do popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Keep-alive do background service worker
  if (request.action === 'keepAlive') {
    log('🔄 Keep-alive recebido do background');

    // Verifica se a sessão ainda está ativa
    if (verificarSessaoAtiva()) {
      // Faz uma requisição para manter a sessão
      manterSessaoAtiva().then(ativa => {
        // Notifica o background sobre o status
        chrome.runtime.sendMessage({
          type: ativa ? 'SESSAO_ATIVA' : 'SESSAO_EXPIRADA'
        });
        sendResponse({ success: ativa });
      });
    } else {
      chrome.runtime.sendMessage({ type: 'SESSAO_EXPIRADA' });
      sendResponse({ success: false, message: 'Sessão expirada' });
    }
    return true; // Indica resposta assíncrona
  }

  // Retorna lista de status disponíveis no dropdown
  if (request.action === 'obterStatusDisponiveis') {
    log('DEBUG: Obtendo status disponíveis...');
    obterStatusDisponiveis().then(statusList => {
      log(`DEBUG: Status encontrados: ${statusList.join(', ')}`);
      sendResponse({ success: true, statusList: statusList });
    }).catch(err => {
      log(`DEBUG: Erro ao obter status: ${err.message}`);
      sendResponse({ success: false, statusList: STATUS_PARA_MONITORAR });
    });
    return true; // Indica resposta assíncrona
  }

  if (request.action === 'iniciarAutomatico') {
    log('DEBUG: Ação iniciarAutomatico recebida');
    log('DEBUG: URL atual: ' + window.location.href);

    // Verifica se há configuração customizada
    const config = request.config || null;
    if (config) {
      log(`DEBUG: Config customizada - Status: ${config.statusInicial}, Página: ${config.paginaInicial}, Índice: ${config.indiceInicial}`);
    }

    // Verifica se está em uma página válida do Comprasnet
    const url = window.location.href;
    const isPaginaParticipacoes = url.includes('/fornecedor/compras') ||
                                   url.includes('/fornecedor/participacoes') ||
                                   url.includes('/minhas-compras') ||
                                   url.includes('comprasnet-web/seguro');

    log('DEBUG: É página de participações? ' + isPaginaParticipacoes);

    if (isPaginaParticipacoes) {
      // Salva configuração customizada se houver
      if (config) {
        chrome.storage.local.set({
          configCustomizada: config
        }).then(() => {
          processarPaginaParticipacoes(config);
        });
      } else {
        processarPaginaParticipacoes(null);
      }
      sendResponse({ success: true });
    } else if (url.includes('cnetmobile.estaleiro.serpro.gov.br')) {
      // Está no Comprasnet mas não na página certa - navega
      log('DEBUG: Navegando para página de participações...');
      const urlParticipacoes = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras';
      chrome.storage.local.set({
        iniciarAposNavegar: true,
        configCustomizada: config
      });
      if (!abaLivre()) {
        chrome.runtime.sendMessage({ action: 'abrirPagina', url: urlParticipacoes });
      } else {
        window.location.href = urlParticipacoes;
      }
      sendResponse({ success: true, message: 'Navegando para participações...' });
    } else {
      // Não está no Comprasnet
      log('ERRO: Não está no site do Comprasnet!');
      sendResponse({ success: false, message: 'Abra o site do Comprasnet primeiro' });
    }
  } else if (request.action === 'pararAutomatico') {
    log('=== MONITORAMENTO PARADO PELO USUÁRIO ===');

    // DEFINE FLAG GLOBAL PARA PARADA IMEDIATA
    PARAR_MONITORAMENTO = true;

    // Limpa todas as flags de monitoramento
    chrome.storage.local.set({
      emProcessamento: false,
      monitoramentoAtivo: false,
      iniciarAposNavegar: false,
      configCustomizada: null
    });

    // Remove painel de progresso
    const painel = document.getElementById('pncp-chrome-progresso');
    if (painel) {
      painel.innerHTML = '<div style="padding: 20px; text-align: center; color: #f44336; font-weight: bold;">PARADO!</div>';
      setTimeout(() => painel.remove(), 2000);
    }

    // Mostra notificação
    mostrarNotificacao('Monitoramento PARADO!', 'warning');

    sendResponse({ success: true });
  } else if (request.action === 'enviarProposta') {
    log('=== AÇÃO ENVIAR PROPOSTA RECEBIDA ===');
    log(`Dados: ${JSON.stringify(request.dados)}`);

    enviarPropostaComprasnet(request.dados).then(result => {
      log(`Resultado envio: ${JSON.stringify(result)}`);
      sendResponse(result);
    }).catch(err => {
      log(`Erro no envio: ${err.message}`);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  } else if (request.action === 'capturarAgora') {
    capturarMensagensDaPagina().then(result => sendResponse(result));
    return true;
  } else if (request.action === 'status') {
    chrome.storage.local.get(['emProcessamento', 'monitoramentoAtivo']).then(data => {
      sendResponse({
        monitorando: data.emProcessamento || data.monitoramentoAtivo || false,
        url: window.location.href,
        logado: !window.location.href.includes('acesso-nao-autorizado')
      });
    });
    return true;
  }
  return true;
});

// Observa navegação e cliques para aprender padrões
function observarNavegacao() {
  // Registra a URL atual
  const urlAtual = window.location.href;
  log(`NAVEGAÇÃO: ${urlAtual}`);

  // Envia para o servidor
  serverFetch(`${SERVER_URL}/api/chat/navegacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tipo: 'navegacao',
      url: urlAtual,
      titulo: document.title,
      timestamp: new Date().toISOString()
    })
  }).catch(() => {});

  // Observa cliques em links e botões
  document.addEventListener('click', (e) => {
    const elemento = e.target.closest('a, button, [role="button"]');
    if (elemento) {
      const info = {
        tipo: 'clique',
        tag: elemento.tagName,
        texto: elemento.innerText?.substring(0, 50),
        href: elemento.href || elemento.getAttribute('href'),
        classe: elemento.className?.substring(0, 100),
        ariaLabel: elemento.getAttribute('aria-label'),
        url: window.location.href,
        timestamp: new Date().toISOString()
      };

      log(`CLIQUE: ${info.tag} - ${info.texto || info.ariaLabel || 'sem texto'}`);

      serverFetch(`${SERVER_URL}/api/chat/navegacao`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(info)
      }).catch(() => {});
    }
  }, true);

  // Observa mudanças na página (para detectar sidebars/modais)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) { // Element node
            const classe = node.className || '';
            if (classe.includes('sidebar') || classe.includes('modal') || classe.includes('dialog')) {
              log(`ELEMENTO ADICIONADO: ${node.tagName} - ${classe.substring(0, 50)}`);

              serverFetch(`${SERVER_URL}/api/chat/navegacao`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  tipo: 'elemento',
                  tag: node.tagName,
                  classe: classe.substring(0, 100),
                  texto: node.innerText?.substring(0, 200),
                  url: window.location.href,
                  timestamp: new Date().toISOString()
                })
              }).catch(() => {});
            }
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// Inicialização
(async () => {
  const url = window.location.href;

  // Só executa em páginas do Comprasnet
  if (!url.includes('cnetmobile.estaleiro.serpro.gov.br')) {
    return;
  }

  log('=== EXTENSÃO INICIADA ===');
  log('URL: ' + url);

  // Registra presença passiva e inicia heartbeat
  registrarPresenca('aguardando');
  iniciarHeartbeat();

  // Inicia observação de navegação
  observarNavegacao();

  // Inicia keep-alive para manter sessão ativa
  iniciarKeepAlive();

  // Propostas são gerenciadas exclusivamente pela extensao-propostas
  // (removido: continuarEnvioProposta e iniciarPollingPropostas)

  // Verifica se há monitoramento ativo para retomar
  const monitorData = await chrome.storage.local.get([
    'monitoramentoAtivo', 'licitacoesProcessadas', 'totalLicitacoes',
    'indiceLicitacaoAtual', 'paginaAtual', 'statusAtualNome', 'statusAtualIndex'
  ]);
  if (monitorData.monitoramentoAtivo && monitorData.totalLicitacoes > 0) {
    // Verifica se a aba está livre antes de retomar monitoramento
    if (!abaLivre()) {
      const atual = getExtensaoAtual();
      log(`[Aba] Ocupada por ${atual.nome} (${atual.operacao}) - abrindo nova aba para retomar monitoramento`);
      chrome.runtime.sendMessage({ action: 'abrirPagina', url: url });
      return;
    }
    reivindicarAba('retomando monitoramento');

    log('Retomando monitoramento ativo...');
    log(`Progresso: ${monitorData.licitacoesProcessadas}/${monitorData.totalLicitacoes}`);
    log(`Status atual: ${monitorData.statusAtualNome || 'não definido'}, Página: ${monitorData.paginaAtual || 1}`);

    // Se está na página de participações (lista), continua o processamento
    const isPaginaLista = url.includes('/fornecedor/compras') &&
                          !url.includes('acompanhamento-compra') &&
                          !url.includes('disputa?compra') &&
                          !url.match(/compra=\d+/);

    if (isPaginaLista) {
      log('Aguardando página carregar antes de retomar...');
      await aguardar(5000); // Mais tempo para Angular carregar
      mostrarPainelProgresso(monitorData.licitacoesProcessadas, monitorData.totalLicitacoes);

      // IMPORTANTE: Primeiro restaura o status correto no dropdown
      const statusAtual = monitorData.statusAtualNome;
      if (statusAtual) {
        log(`Restaurando status: ${statusAtual}`);
        atualizarPainelProgresso(monitorData.licitacoesProcessadas, monitorData.totalLicitacoes, `Restaurando status: ${statusAtual}...`);

        const statusSelecionado = await selecionarStatus(statusAtual);
        if (!statusSelecionado) {
          log(`ERRO: Não foi possível selecionar o status ${statusAtual}`);
        }
        await aguardar(3000); // Aguarda a lista atualizar após mudar status
      }

      // Depois navega para a página correta
      const paginaAtual = monitorData.paginaAtual || 1;
      if (paginaAtual > 1) {
        log(`Navegando para página ${paginaAtual} da lista...`);
        atualizarPainelProgresso(monitorData.licitacoesProcessadas, monitorData.totalLicitacoes, `Página ${paginaAtual}...`);

        const navegou = await navegarParaPagina(paginaAtual);
        if (!navegou) {
          log('Erro ao navegar para página - tentando continuar...');
        }
        await aguardar(3000);
      }

      atualizarPainelProgresso(monitorData.licitacoesProcessadas, monitorData.totalLicitacoes, 'Retomando...');
      await processarLicitacoesDaPagina();
      return;
    }

    // Se está em uma página de licitação específica, processa ela
    if (url.includes('acompanhamento-compra') || url.includes('disputa?compra') || url.match(/compra=\d+/)) {
      log('Está em página de licitação - processando...');
      await aguardar(3000);
      await processarPaginaLicitacaoAtual(monitorData);
      return;
    }
  } else if (monitorData.monitoramentoAtivo) {
    // Estado inválido - limpa
    log('Limpando estado de monitoramento inválido...');
    await chrome.storage.local.set({ monitoramentoAtivo: false });
  }

  // Verifica se deve iniciar após navegar
  const initData = await chrome.storage.local.get(['iniciarAposNavegar', 'configCustomizada']);
  if (initData.iniciarAposNavegar) {
    log('DEBUG: Flag iniciarAposNavegar detectada');
    // Aceita várias páginas como válidas para iniciar
    const isPaginaValida = url.includes('/fornecedor/compras') ||
                           url.includes('/fornecedor/participacoes') ||
                           url.includes('comprasnet-web/seguro');

    if (isPaginaValida) {
      // Verifica se a aba está livre
      if (!abaLivre()) {
        const atual = getExtensaoAtual();
        log(`[Aba] Ocupada por ${atual.nome} - abrindo nova aba para iniciar monitoramento`);
        chrome.runtime.sendMessage({ action: 'abrirPagina', url: url });
        return;
      }
      reivindicarAba('iniciando monitoramento');

      log('DEBUG: Iniciando monitoramento automático após navegação...');

      // Limpa flags e obtém configuração customizada
      const config = initData.configCustomizada || null;
      await chrome.storage.local.set({ iniciarAposNavegar: false, configCustomizada: null });

      if (config) {
        log(`DEBUG: Usando config customizada: ${JSON.stringify(config)}`);
      }

      await aguardar(3000); // Aguarda mais tempo para a página carregar
      processarPaginaParticipacoes(config);
      return;
    }
  }

  // Verifica se está em processamento automático
  const data = await chrome.storage.local.get(['emProcessamento', 'indiceAtual', 'totalLinks']);
  if (data.emProcessamento) {
    log(`DEBUG: Em processamento - ${(data.indiceAtual || 0) + 1}/${data.totalLinks || '?'}`);

    // Está em uma página de licitação específica durante o processamento automático
    if (url.includes('compra=')) {
      // Verifica se a aba está livre
      if (!abaLivre()) {
        const atual = getExtensaoAtual();
        log(`[Aba] Ocupada por ${atual.nome} - abrindo nova aba para continuar processamento`);
        chrome.runtime.sendMessage({ action: 'abrirPagina', url: url });
        return;
      }
      reivindicarAba('processando licitação');

      log('DEBUG: Processando licitação atual...');
      await processarLicitacaoAtual();
    } else {
      log('DEBUG: Aguardando página de licitação...');
    }
  }

  // Sempre monitora abertura manual de mensagens
  monitorarAberturaManual();
  log('DEBUG: Monitoramento manual de mensagens ativado');
})();
