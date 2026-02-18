// Monitor Comprasnet - Content Script v5.7
// Captura mensagens automaticamente de TODAS as licitações
// Versão atualizada em: 19/01/2026
// - Multi-status: processa todos os status (Propostas, Disputa, Seleção, etc.)
// - Licitações: processa na ordem natural (mais recentes primeiro no topo)
// - Mensagens: captura da ÚLTIMA página para PRIMEIRA (mais recentes primeiro)
// - Captura incremental: após captura completa, só verifica novas mensagens
// - Keep-alive em segundo plano via background worker
// - v5.7: Sistema de separação de abas - se aba ocupada, abre nova aba

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
const EXT_NAME = 'monitor';
const EXT_ATTR = 'data-pncp-ext-monitor';
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

// Compat: marcarAbaAtiva maps to reivindicarAba for existing code
function marcarAbaAtiva(operacao = '') {
  reivindicarAba(operacao);
}
// ==================== FIM SISTEMA DE COORDENAÇÃO ====================

// Lista de licitações já capturadas completamente (carregada do servidor)
let licitacoesJaCapturadas = new Set();

// Intervalo para salvar sessão no servidor (a cada 30 segundos)
let salvarSessaoInterval = null;

// Configuração de keep-alive (mantém sessão ativa)
const KEEP_ALIVE_INTERVAL = 3 * 60 * 1000; // 3 minutos
let keepAliveTimer = null;

// Contadores de licitações puladas (por motivo)
let licitacoesPuladasMotivos = {
  jaCapturada: 0,
  acessoNegado: 0,
  urlPublica: 0,
  naoNavegou: 0,
  erro: 0
};

function resetContadoresPuladas() {
  licitacoesPuladasMotivos = { jaCapturada: 0, acessoNegado: 0, urlPublica: 0, naoNavegou: 0, erro: 0 };
}

function getTotalPuladas() {
  return Object.values(licitacoesPuladasMotivos).reduce((a, b) => a + b, 0);
}

function getResumoPuladas() {
  const motivos = [];
  if (licitacoesPuladasMotivos.jaCapturada > 0) motivos.push(licitacoesPuladasMotivos.jaCapturada + ' já capturadas');
  if (licitacoesPuladasMotivos.acessoNegado > 0) motivos.push(licitacoesPuladasMotivos.acessoNegado + ' acesso negado');
  if (licitacoesPuladasMotivos.urlPublica > 0) motivos.push(licitacoesPuladasMotivos.urlPublica + ' URL pública');
  if (licitacoesPuladasMotivos.naoNavegou > 0) motivos.push(licitacoesPuladasMotivos.naoNavegou + ' não navegou');
  if (licitacoesPuladasMotivos.erro > 0) motivos.push(licitacoesPuladasMotivos.erro + ' erros');
  return motivos.join(', ') || 'nenhuma';
}

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

// ==================== SINCRONIZAÇÃO COM SERVIDOR ====================

// Registra automaticamente a licitação acessada no servidor para monitoramento
async function registrarLicitacaoAcessada() {
  const info = extrairInfoLicitacao();
  if (!info) return;

  try {
    const response = await serverFetch(`${SERVER_URL}/api/chat/monitoramento/registrar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cnpj: info.cnpjOrgao,
        ano: parseInt(info.ano),
        sequencial: parseInt(info.sequencial),
        compraId: info.compraId,
        url: window.location.href
      })
    });

    if (response.ok) {
      const data = await response.json();
      if (data.novo) {
        log(`[Auto-Monitor] Licitação ${info.compraId} registrada para monitoramento`);
      }
    }
  } catch (e) {
    // Silencioso - não bloqueia o fluxo se falhar
  }
}

// Carrega lista de licitações já capturadas do servidor
async function carregarLicitacoesCapturadas() {
  try {
    const res = await serverFetch(`${SERVER_URL}/api/chat/captura/completas`);
    const data = await res.json();
    if (data.success && data.data) {
      licitacoesJaCapturadas = new Set(data.data);
      log(`[Servidor] Carregadas ${licitacoesJaCapturadas.size} licitações já capturadas`);
    }
  } catch (e) {
    log('[Servidor] Erro ao carregar licitações capturadas: ' + e.message);
  }
}

// Verifica se uma licitação específica já foi capturada
function licitacaoJaCapturada(compraId) {
  return licitacoesJaCapturadas.has(compraId);
}

// Marca licitação como capturada localmente
function marcarLicitacaoCapturada(compraId) {
  licitacoesJaCapturadas.add(compraId);
}

// Salva progresso da sessão no servidor
async function salvarSessaoNoServidor() {
  try {
    const dados = await chrome.storage.local.get([
      'monitoramentoAtivo', 'statusAtualNome', 'paginaAtual',
      'licitacoesProcessadas', 'totalLicitacoes'
    ]);

    if (!dados.monitoramentoAtivo) return;

    await serverFetch(`${SERVER_URL}/api/chat/monitoramento/sessao`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statusAtual: dados.statusAtualNome || 'Em andamento',
        paginaAtual: dados.paginaAtual || 1,
        indiceLicitacao: dados.licitacoesProcessadas || 0,
        totalLicitacoes: dados.totalLicitacoes || 0,
        licitacoesProcessadas: Array.from(licitacoesJaCapturadas)
      })
    });
    log('[Servidor] Sessão salva');
  } catch (e) {
    // Silencioso para não poluir logs
  }
}

// Carrega sessão anterior do servidor
async function carregarSessaoDoServidor() {
  try {
    const res = await serverFetch(`${SERVER_URL}/api/chat/monitoramento/sessao`);
    const data = await res.json();
    if (data.success && data.data) {
      log('[Servidor] Sessão anterior encontrada: ' + data.data.statusAtual + ', lic ' + data.data.indiceLicitacao + '/' + data.data.totalLicitacoes);
      return data.data;
    }
  } catch (e) {
    log('[Servidor] Erro ao carregar sessão: ' + e.message);
  }
  return null;
}

// Limpa sessão no servidor
async function limparSessaoNoServidor() {
  try {
    await serverFetch(`${SERVER_URL}/api/chat/monitoramento/sessao`, { method: 'DELETE' });
    log('[Servidor] Sessão encerrada');
  } catch (e) {
    // Silencioso
  }
}

// Inicia salvamento periódico da sessão
function iniciarSalvamentoPeriodicoSessao() {
  if (salvarSessaoInterval) clearInterval(salvarSessaoInterval);
  salvarSessaoInterval = setInterval(salvarSessaoNoServidor, 30000); // A cada 30 segundos
}

// Para salvamento periódico
function pararSalvamentoPeriodicoSessao() {
  if (salvarSessaoInterval) {
    clearInterval(salvarSessaoInterval);
    salvarSessaoInterval = null;
  }
}

  // ==================== CONTROLE DE PAUSE ====================
  let pausado = false;
  let pauseResolve = null;

  // Cria botão flutuante de pause/resume
  function criarBotaoPause() {
    if (document.getElementById('pncp-monitor-pause-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'pncp-monitor-pause-btn';
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
    const btn = document.getElementById('pncp-monitor-pause-btn');
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

  // Split apenas em "Mensagem do" para manter "Enviada em" junto com a mensagem anterior
  const blocos = textoCompleto.split(/(?=Mensagem do )/g);

  blocos.forEach((bloco, index) => {
    const texto = bloco.trim();
    if (texto.length > 20 && texto.startsWith('Mensagem do')) {
      const ignorar = ['Visualize aqui', 'Não há mensagens', 'Captcha', 'Tente mais tarde', 'Fechar', 'Sessão Pública'];
      if (!ignorar.some(i => texto.includes(i))) {
        // Extrair data/hora real da mensagem do Comprasnet
        // Formato: "Enviada em 27/03/2024 às 08:32:09h" - pode estar neste bloco ou no próximo
        let dataHora = new Date().toISOString();

        // Primeiro tenta encontrar no próprio bloco
        let matchData = texto.match(/Enviada em (\d{2})\/(\d{2})\/(\d{4}) às (\d{2}):(\d{2}):(\d{2})h?/);

        // Se não encontrou, olha no próximo bloco (caso "Enviada em" tenha ficado separado)
        if (!matchData && blocos[index + 1]) {
          const proximoBloco = blocos[index + 1];
          if (proximoBloco.trim().startsWith('Enviada em')) {
            matchData = proximoBloco.match(/Enviada em (\d{2})\/(\d{2})\/(\d{4}) às (\d{2}):(\d{2}):(\d{2})h?/);
          }
        }

        if (matchData) {
          const [, dia, mes, ano, hora, minuto, segundo] = matchData;
          const dataMsg = new Date(ano, mes - 1, dia, hora, minuto, segundo);
          if (!isNaN(dataMsg.getTime())) {
            dataHora = dataMsg.toISOString();
          }
        }

        // Remove "Enviada em..." do texto se estiver no final
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
// IMPORTANTE: Processa da ÚLTIMA página para a PRIMEIRA (mensagens mais recentes primeiro)
async function capturarTodasPaginasMensagens() {
  const todasMensagens = [];
  let mensagensEnviadasTotal = 0;

  // Extrai info da licitação para usar como ID
  const info = extrairInfoLicitacao();
  const compraId = info?.compraId;

  // Consulta progresso anterior
  let progressoAnterior = null;

  if (compraId) {
    progressoAnterior = await consultarProgresso(compraId);
    if (progressoAnterior && progressoAnterior.capturaCompleta) {
      log(`Licitação ${compraId} já foi capturada completamente (${progressoAnterior.totalMensagens} msgs)`);
      // Para captura incremental, só verifica a primeira página (mais recentes)
      const mensagensPagina = extrairMensagensDoChat();
      if (info && mensagensPagina.length > 0) {
        const resultEnvio = await enviarMensagens(mensagensPagina, info);
        if (resultEnvio.inseridas > 0) {
          log(`Captura incremental: ${resultEnvio.inseridas} novas mensagens`);
        }
      }
      return mensagensPagina;
    }
  }

  // Detecta total de páginas
  let totalPaginas = 1;
  const ultimaPaginaBtn = document.querySelector('.p-paginator-last');
  if (ultimaPaginaBtn && !ultimaPaginaBtn.classList.contains('p-disabled')) {
    const texto = ultimaPaginaBtn.getAttribute('aria-label') || '';
    const match = texto.match(/(\d+)/);
    if (match) totalPaginas = parseInt(match[1]);
  }
  // Ou pelo último número visível
  const todosBotoesPag = document.querySelectorAll('.p-paginator-page');
  if (todosBotoesPag.length > 0) {
    const ultimoNum = parseInt(todosBotoesPag[todosBotoesPag.length - 1].innerText);
    if (ultimoNum > totalPaginas) totalPaginas = ultimoNum;
  }

  log(`Total de páginas detectado: ${totalPaginas}`);

  // ORDEM REVERSA: Vai para a ÚLTIMA página primeiro
  let paginaAtual = 1; // Começa na página 1, será atualizado após navegação

  if (totalPaginas > 1) {
    log(`Navegando para última página (${totalPaginas})...`);

    // Tenta clicar no botão "última página" (>>)
    if (ultimaPaginaBtn && !ultimaPaginaBtn.classList.contains('p-disabled')) {
      ultimaPaginaBtn.click();
      await aguardar(2000); // Mais tempo para carregar
    } else {
      // Navega página por página até a última
      for (let p = 1; p < totalPaginas; p++) {
        const btnProximo = document.querySelector('.p-paginator-next:not(.p-disabled)');
        if (btnProximo) {
          btnProximo.click();
          await aguardar(800);
        } else {
          log('Navegação interrompida - botão próximo não disponível');
          break;
        }
      }
    }

    // VERIFICA em qual página realmente estamos após navegação
    await aguardar(1000);
    const paginaAtiva = document.querySelector('.p-paginator-page.p-highlight, .p-paginator-page[aria-current="page"]');
    if (paginaAtiva) {
      paginaAtual = parseInt(paginaAtiva.innerText) || totalPaginas;
      log(`Navegação: agora na página ${paginaAtual}`);
    } else {
      // Fallback: assume que navegou para a última
      paginaAtual = totalPaginas;
      log(`Navegação: assumindo página ${paginaAtual} (fallback)`);
    }
  }

  // Guarda a página inicial para verificar no final
  const paginaInicial = paginaAtual;
  let totalMensagensCapturadas = 0;

  // Processa da última para a primeira página
  while (paginaAtual >= 1) {
    // Verifica se o monitoramento foi cancelado
    const estadoAtual = await chrome.storage.local.get(['monitoramentoAtivo']);
    if (!estadoAtual.monitoramentoAtivo) {
      log('Captura interrompida - monitoramento cancelado');
      break;
    }

    // Captura mensagens da página atual
    const mensagensPagina = extrairMensagensDoChat();
    log(`Página ${paginaAtual}/${totalPaginas}: ${mensagensPagina.length} mensagens`);

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
      await atualizarProgresso(compraId, info, paginaAtual, totalPaginas, totalMensagensCapturadas, false);
    }

    // Se já estamos na primeira página, termina
    if (paginaAtual <= 1) {
      break;
    }

    // Navega para a página ANTERIOR (ordem reversa)
    const btnAnterior = document.querySelector('.p-paginator-prev:not(.p-disabled)');
    if (btnAnterior) {
      btnAnterior.click();
      await aguardar(800);
      paginaAtual--;
    } else {
      // Tenta clicar no número da página anterior
      const botoesPaginacao = document.querySelectorAll('.p-paginator-page');
      let navegou = false;
      for (const btn of botoesPaginacao) {
        const numPagina = parseInt(btn.innerText);
        if (numPagina === paginaAtual - 1) {
          btn.click();
          await aguardar(800);
          paginaAtual--;
          navegou = true;
          break;
        }
      }
      if (!navegou) {
        break; // Não conseguiu navegar
      }
    }
  }

  // Verifica se capturou todas as páginas - se chegou na página 1, está completa
  const capturouTodas = (paginaAtual <= 1);
  // Calcula total real de páginas baseado na página inicial (que era a última)
  const totalPaginasReal = Math.max(totalPaginas, paginaInicial);

  if (compraId) {
    if (capturouTodas) {
      await atualizarProgresso(compraId, info, totalPaginasReal, totalPaginasReal, totalMensagensCapturadas, true);
      log(`✓ Captura COMPLETA! ${totalPaginasReal} páginas, ${totalMensagensCapturadas} mensagens`);
    } else {
      // Captura incompleta - NÃO marca como completa
      await atualizarProgresso(compraId, info, paginaAtual, totalPaginasReal, totalMensagensCapturadas, false);
      log(`⚠ Captura INCOMPLETA: páginas ${paginaAtual}-${paginaInicial} de ${totalPaginasReal}`);
    }
  }

  log(`Total capturado: ${todasMensagens.length} mensagens de ${totalPaginasReal} páginas (ordem reversa)`);
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

// Seleciona um status no dropdown (com retry)
async function selecionarStatus(statusDesejado) {
  log(`Selecionando status: ${statusDesejado}`);

  for (let tentativa = 0; tentativa < 3; tentativa++) {
    // Fecha qualquer dropdown aberto
    const painelAberto = document.querySelector('.p-dropdown-panel');
    if (painelAberto) {
      document.body.click();
      await aguardar(300);
    }

    // Re-query dropdown fresco (pode ter sido recriado pelo Angular)
    const dropdown = document.querySelector('.p-dropdown, [role="combobox"]');
    if (!dropdown) {
      log(`Dropdown não encontrado (tentativa ${tentativa + 1}/3)`);
      await aguardar(1000);
      continue;
    }

    // Clica no dropdown para abrir
    dropdown.click();
    await aguardar(800);

    // Verifica se o painel de opções apareceu
    const painel = document.querySelector('.p-dropdown-panel');
    if (!painel) {
      log(`Painel do dropdown não abriu (tentativa ${tentativa + 1}/3)`);
      document.body.click();
      await aguardar(500);
      continue;
    }

    // Procura a opção desejada
    const opcoes = painel.querySelectorAll('.p-dropdown-item, [role="option"]');
    const opcoesTexto = Array.from(opcoes).map(o => o.innerText?.trim());
    log(`[Dropdown] Opções encontradas: ${opcoesTexto.join(', ')}`);

    for (const opt of opcoes) {
      const texto = opt.innerText?.trim().toLowerCase();
      if (texto === statusDesejado.toLowerCase() || texto.includes(statusDesejado.toLowerCase())) {
        // Dispara eventos completos para o PrimeNG/Angular detectar
        opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        opt.click();
        // Força change no dropdown original
        const dropdownEl = document.querySelector('.p-dropdown, [role="combobox"]');
        if (dropdownEl) {
          dropdownEl.dispatchEvent(new Event('change', { bubbles: true }));
          dropdownEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        log(`Status "${statusDesejado}" selecionado`);
        await aguardar(2000);

        // Verifica se a label do dropdown realmente mudou
        const label = document.querySelector('.p-dropdown-label');
        if (label) {
          log(`[Dropdown] Label atual: "${label.innerText?.trim()}"`);
        }
        return true;
      }
    }

    // Não encontrou a opção, fecha e tenta novamente
    document.body.click();
    await aguardar(500);
    log(`Status "${statusDesejado}" não encontrado nas opções (tentativa ${tentativa + 1}/3)`);
  }

  log(`Status "${statusDesejado}" não encontrado após 3 tentativas`);
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

// ==================== MAPEAMENTO RÁPIDO DE COMPRA IDs ====================
// Extrai compraIds de todas as participações usando múltiplas estratégias:
// 1. Extração direta via script injetado (Angular data / network interception)
// 2. Fallback: clica botões, lê URL, volta (com reload automático se history.back() falhar)
// Após mapear, o polling em background faz a captura de mensagens.

// Injeta script no mundo da página para:
// - Extrair compraIds dos componentes Angular (__ngContext__)
// - Interceptar fetch/XHR para capturar dados da API
function injectExtractor() {
  if (document.documentElement.getAttribute('data-pncp-injector') === 'active') return;

  const script = document.createElement('script');
  script.textContent = `
    (function() {
      // === Extração de compraIds dos cards Angular ===
      function extractFromCards() {
        const results = [];

        // Método 1: __ngContext__ nos cards
        document.querySelectorAll('app-card-compra-pesquisa').forEach(function(card) {
          try {
            var ctx = card.__ngContext__;
            if (ctx && Array.isArray(ctx)) {
              for (var i = 0; i < ctx.length; i++) {
                var item = ctx[i];
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                  searchObj(item, 0, results);
                }
              }
            }
          } catch(e) {}
        });

        // Método 2: __ngContext__ em elementos pai
        var dataview = document.querySelector('p-dataview, [class*="dataview"]');
        if (dataview) {
          try {
            var ctx = dataview.__ngContext__;
            if (ctx && Array.isArray(ctx)) {
              for (var i = 0; i < ctx.length; i++) {
                var item = ctx[i];
                if (item && typeof item === 'object') searchObj(item, 0, results);
              }
            }
          } catch(e) {}
        }

        // Método 3: <a> tags com href contendo compra=
        document.querySelectorAll('a[href]').forEach(function(a) {
          var match = a.href.match(/compra=(\\d{14,20})/);
          if (match) results.push(match[1]);
        });

        // Método 4: data attributes
        document.querySelectorAll('[data-compra-id], [data-codigo-compra], [data-compra]').forEach(function(el) {
          var id = el.getAttribute('data-compra-id') || el.getAttribute('data-codigo-compra') || el.getAttribute('data-compra');
          if (id && /^\\d{14,20}$/.test(id)) results.push(id);
        });

        return results.filter(function(v, i, a) { return a.indexOf(v) === i; });
      }

      function searchObj(obj, depth, results) {
        if (depth > 4 || !obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          for (var i = 0; i < obj.length; i++) searchObj(obj[i], depth + 1, results);
          return;
        }
        var keys = Object.keys(obj);
        for (var ki = 0; ki < keys.length; ki++) {
          var key = keys[ki];
          var value = obj[key];
          var k = key.toLowerCase();
          if ((k === 'codigocompra' || k === 'compraid' || k === 'codigodacompra' || k === 'compra' || k === 'codigo') &&
              typeof value === 'string' && /^\\d{14,20}$/.test(value)) {
            results.push(value);
          }
          if ((k === 'codigocompra' || k === 'compraid' || k === 'codigodacompra') &&
              typeof value === 'number' && value > 10000000000000) {
            results.push(String(value));
          }
          if (typeof value === 'object' && value !== null) {
            searchObj(value, depth + 1, results);
          }
        }
      }

      // === Interceptação de fetch/XHR ===
      var capturedIds = [];

      var origFetch = window.fetch;
      window.fetch = function() {
        var args = arguments;
        var result = origFetch.apply(this, args);
        result.then(function(response) {
          try {
            var clone = response.clone();
            clone.text().then(function(text) {
              try {
                var json = JSON.parse(text);
                var found = [];
                searchObj(json, 0, found);
                if (found.length > 0) {
                  for (var i = 0; i < found.length; i++) {
                    if (capturedIds.indexOf(found[i]) === -1) capturedIds.push(found[i]);
                  }
                  document.documentElement.setAttribute('data-pncp-api-ids', JSON.stringify(capturedIds));
                }
              } catch(e) {}
            });
          } catch(e) {}
          return response;
        });
        return result;
      };

      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this._pncpUrl = url;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        var xhr = this;
        xhr.addEventListener('load', function() {
          try {
            var json = JSON.parse(xhr.responseText);
            var found = [];
            searchObj(json, 0, found);
            if (found.length > 0) {
              for (var i = 0; i < found.length; i++) {
                if (capturedIds.indexOf(found[i]) === -1) capturedIds.push(found[i]);
              }
              document.documentElement.setAttribute('data-pncp-api-ids', JSON.stringify(capturedIds));
            }
          } catch(e) {}
        });
        return origSend.apply(this, arguments);
      };

      // Listener para extração sob demanda
      document.addEventListener('pncp-extract-cards', function() {
        var ids = extractFromCards();
        document.documentElement.setAttribute('data-pncp-card-ids', JSON.stringify(ids));
      });

      // Listener para reset dos IDs capturados via rede
      document.addEventListener('pncp-clear-network', function() {
        capturedIds = [];
        document.documentElement.removeAttribute('data-pncp-api-ids');
      });

      document.documentElement.setAttribute('data-pncp-injector', 'active');
    })();
  `;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

// Extrai compraIds dos cards visíveis via script injetado
function extractCompraIdsFromCards() {
  document.documentElement.removeAttribute('data-pncp-card-ids');
  document.dispatchEvent(new CustomEvent('pncp-extract-cards'));
  const result = document.documentElement.getAttribute('data-pncp-card-ids');
  if (result) {
    try { return JSON.parse(result); } catch { return []; }
  }
  return [];
}

// Lê compraIds capturados via interceptação de rede
function getNetworkCompraIds() {
  const result = document.documentElement.getAttribute('data-pncp-api-ids');
  if (result) {
    try { return JSON.parse(result); } catch { return []; }
  }
  return [];
}

// Limpa compraIds da rede
function clearNetworkCompraIds() {
  document.dispatchEvent(new CustomEvent('pncp-clear-network'));
}

// Salva estado do mapeamento para retomar após reload
async function salvarEstadoMapeamento(statusIdx, paginaAtual, botaoIdx, compraIdsVistos, statusLista) {
  await chrome.storage.local.set({
    mapeamentoEmAndamento: true,
    mapStatusIdx: statusIdx,
    mapPaginaAtual: paginaAtual,
    mapBotaoIdx: botaoIdx,
    mapCompraIdsVistos: [...compraIdsVistos],
    mapStatusLista: statusLista
  });
  log(`[Mapeamento] Estado salvo: status=${statusIdx} p=${paginaAtual} btn=${botaoIdx} total=${compraIdsVistos.size}`);
}

// Registra um compraId no servidor (fire-and-forget)
function registrarCompraId(compraId, url) {
  // Parseia cnpj/ano/sequencial do compraId para popular dados no servidor
  let cnpj = '', ano = 0, sequencial = 0;
  if (compraId && compraId.length >= 10) {
    cnpj = compraId.substring(0, Math.min(14, compraId.length - 9));
    const resto = compraId.substring(cnpj.length);
    sequencial = parseInt(resto.substring(0, resto.length - 4)) || 0;
    ano = parseInt(resto.substring(resto.length - 4)) || 0;
  }
  // Constrói URL correta para acompanhamento-compra (única com sidebar de mensagens)
  const urlCorreta = url && url.includes('acompanhamento-compra') ? url :
    `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/acompanhamento-compra?compra=${compraId}`;
  serverFetch(`${SERVER_URL}/api/chat/monitoramento/registrar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ compraId, cnpj, ano, sequencial, url: urlCorreta })
  }).catch(() => {});
}

// Extrai compraIds via chrome.scripting.executeScript (MAIN world, bypassa CSP)
async function extractCompraIdsViaBackground() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'extractCompraIds' }, response => {
      if (chrome.runtime.lastError || !response) {
        log(`[Mapeamento] Erro extractCompraIds: ${chrome.runtime.lastError?.message || 'sem resposta'}`);
        resolve([]);
        return;
      }
      resolve(response.compraIds || []);
    });
  });
}

async function mapearCompraIds(resumeState) {
  log('=== MAPEAMENTO RÁPIDO: Extraindo compraIds ===');

  if (resumeState) {
    log(`[Mapeamento] Retomando: status=${resumeState.mapStatusIdx}, ` +
        `página=${resumeState.mapPaginaAtual}, botão=${resumeState.mapBotaoIdx}, ` +
        `já mapeados=${(resumeState.mapCompraIdsVistos || []).length}`);
    await aguardar(5000); // Espera extra para página carregar completamente após reload
  } else {
    await aguardar(2000);
  }

  // Determina lista de status
  let listaFinal;
  if (resumeState && resumeState.mapStatusLista) {
    listaFinal = resumeState.mapStatusLista;
  } else {
    const statusDisponiveis = await obterStatusDisponiveis();
    const statusParaProcessar = STATUS_PARA_MONITORAR.filter(s =>
      statusDisponiveis.some(d => d.toLowerCase().includes(s.toLowerCase()))
    );
    listaFinal = statusParaProcessar.length > 0 ? statusParaProcessar : statusDisponiveis;
  }

  log(`[Mapeamento] Status: ${listaFinal.join(', ')}`);

  // Carrega compraIds já vistos
  const compraIdsVistos = new Set();
  if (resumeState && resumeState.mapCompraIdsVistos) {
    resumeState.mapCompraIdsVistos.forEach(id => compraIdsVistos.add(id));
  }
  let totalMapeadas = 0;

  const startStatusIdx = resumeState ? resumeState.mapStatusIdx : 0;

  for (let statusIdx = startStatusIdx; statusIdx < listaFinal.length; statusIdx++) {
    const status = listaFinal[statusIdx];

    // Garante estado limpo entre status
    if (statusIdx > startStatusIdx || (statusIdx === startStatusIdx && !resumeState)) {
      if (window.location.href.match(/compra=\d+/)) {
        log(`[Mapeamento] Preso em página de licitação, voltando...`);
        history.back();
        await aguardar(2000);
      }
      window.scrollTo(0, 0);
      await aguardar(1000);
    }

    if (!await selecionarStatus(status)) continue;
    await aguardar(2000);

    const totalDoStatus = contarLicitacoesDoStatus();
    log(`[Mapeamento] ${status}: ${totalDoStatus} licitações`);
    if (totalDoStatus === 0) continue;

    // Determina página e botão iniciais (para resume)
    let paginaInicial = 1;
    let botaoInicial = 0;
    if (resumeState && statusIdx === startStatusIdx) {
      paginaInicial = resumeState.mapPaginaAtual || 1;
      botaoInicial = resumeState.mapBotaoIdx || 0;

      // Navega até a página correta
      if (paginaInicial > 1) {
        log(`[Mapeamento] Navegando até página ${paginaInicial}...`);
        for (let p = 2; p <= paginaInicial; p++) {
          const btnProx = document.querySelector('.p-paginator-next:not(.p-disabled)');
          if (btnProx) {
            btnProx.click();
            await aguardar(1500);
          } else break;
        }
        await aguardar(1000);
      }
      resumeState = null; // Limpa para próximos status rodarem normal
    }

    let paginaAtual = paginaInicial;
    let temProximaPagina = true;
    let duplicatasConsecutivas = 0;
    const MAX_DUPLICATAS_CONSECUTIVAS = 15;

    while (temProximaPagina) {
      // ===== TENTATIVA 1: Extração direta via chrome.scripting (MAIN world) =====
      let idsExtraidos = await extractCompraIdsViaBackground();

      if (idsExtraidos.length > 0) {
        log(`[Mapeamento] Extração direta: ${idsExtraidos.length} compraIds (${status} p${paginaAtual})`);
        for (const id of idsExtraidos) {
          if (!compraIdsVistos.has(id)) {
            compraIdsVistos.add(id);
            registrarCompraId(id, '');
            log(`[Mapeamento] ${compraIdsVistos.size}: compraId=${id} (direto)`);
            duplicatasConsecutivas = 0;
          } else {
            duplicatasConsecutivas++;
          }
        }
        botaoInicial = 0;
      } else {
        // ===== TENTATIVA 2: Click nos botões (fallback) =====
        const startBtn = (paginaAtual === paginaInicial) ? botaoInicial : 0;
        const botoes = document.querySelectorAll('button[aria-label="Participar/acompanhar compra"]');
        log(`[Mapeamento] Click fallback: ${status} p${paginaAtual}: ${botoes.length} botões (inicio: ${startBtn})`);

        if (botoes.length === 0) break;

        for (let i = startBtn; i < botoes.length; i++) {
          const botoesAtuais = document.querySelectorAll('button[aria-label="Participar/acompanhar compra"]');
          if (i >= botoesAtuais.length) {
            // Botões sumiram - salva estado e recarrega
            log(`[Mapeamento] Botão ${i} sumiu, salvando estado e recarregando...`);
            await salvarEstadoMapeamento(statusIdx, paginaAtual, i, compraIdsVistos, listaFinal);
            window.location.href = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras';
            return;
          }

          const urlAntes = window.location.href;
          botoesAtuais[i].click();

          // Espera URL mudar (polling rápido)
          let compraIdExtraido = null;
          for (let t = 0; t < 30; t++) {
            await aguardar(100);
            const urlAtual = window.location.href;
            if (urlAtual !== urlAntes && urlAtual.match(/compra=\d+/)) {
              const match = urlAtual.match(/compra=(\d+)/);
              if (match) compraIdExtraido = match[1];
              break;
            }
          }

          if (compraIdExtraido) {
            if (!compraIdsVistos.has(compraIdExtraido)) {
              compraIdsVistos.add(compraIdExtraido);
              registrarCompraId(compraIdExtraido, window.location.href);
              log(`[Mapeamento] ${compraIdsVistos.size}: compraId=${compraIdExtraido}`);
              duplicatasConsecutivas = 0;
            } else {
              duplicatasConsecutivas++;
            }
          }

          // Volta à listagem
          history.back();
          for (let t = 0; t < 30; t++) {
            await aguardar(100);
            if (!window.location.href.match(/compra=\d+/)) break;
          }

          // Espera botões reaparecerem
          let recovered = false;
          for (let t = 0; t < 25; t++) {
            await aguardar(200);
            if (document.querySelectorAll('button[aria-label="Participar/acompanhar compra"]').length > 0) {
              recovered = true;
              break;
            }
          }

          if (!recovered) {
            // history.back() falhou - salva estado e recarrega
            log(`[Mapeamento] history.back() falhou na p${paginaAtual} btn${i}, recarregando...`);
            await salvarEstadoMapeamento(statusIdx, paginaAtual, i + 1, compraIdsVistos, listaFinal);
            window.location.href = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras';
            return;
          }

          // Verifica se está na página correta
          if (paginaAtual > 1) {
            const paginaAtiva = document.querySelector('.p-paginator-page.p-highlight');
            const paginaNum = paginaAtiva ? parseInt(paginaAtiva.textContent) : 1;
            if (paginaNum !== paginaAtual) {
              const botoesPagina = document.querySelectorAll('.p-paginator-page');
              for (const btn of botoesPagina) {
                if (parseInt(btn.textContent) === paginaAtual) {
                  btn.click();
                  await aguardar(1500);
                  break;
                }
              }
            }
          }

          if (duplicatasConsecutivas >= MAX_DUPLICATAS_CONSECUTIVAS) {
            log(`[Mapeamento] ${status}: ${duplicatasConsecutivas} duplicatas consecutivas, pulando restante`);
            break;
          }
        }
        botaoInicial = 0;
      }

      if (duplicatasConsecutivas >= MAX_DUPLICATAS_CONSECUTIVAS) break;

      // Salva progresso periodicamente
      await chrome.storage.local.set({ mapCompraIdsVistos: [...compraIdsVistos] });

      // Próxima página
      const btnProxima = document.querySelector('.p-paginator-next:not(.p-disabled)');
      if (btnProxima) {
        btnProxima.click();
        paginaAtual++;
        let botoesCarregados = false;
        for (let t = 0; t < 30; t++) {
          await aguardar(200);
          if (document.querySelectorAll('button[aria-label="Participar/acompanhar compra"]').length > 0) {
            botoesCarregados = true;
            break;
          }
        }
        if (!botoesCarregados) {
          log(`[Mapeamento] Botões não carregaram na página ${paginaAtual}`);
          temProximaPagina = false;
        }
        await aguardar(1000); // Espera API retornar dados
      } else {
        temProximaPagina = false;
      }
    }
  }

  // Limpeza
  await chrome.storage.local.remove([
    'mapeamentoEmAndamento', 'mapStatusIdx', 'mapPaginaAtual',
    'mapBotaoIdx', 'mapCompraIdsVistos', 'mapStatusLista'
  ]);

  log(`=== MAPEAMENTO CONCLUÍDO: ${compraIdsVistos.size} compraIds registrados ===`);
  mostrarNotificacao(`${compraIdsVistos.size} licitações mapeadas para polling automático!`, 'success');

  // Reseta flag para permitir futuros mapeamentos
  await chrome.storage.local.set({ mapeamentoIniciado: false });

  // Dispara primeiro polling imediatamente
  chrome.runtime.sendMessage({ action: 'iniciarPollingImediato' });
}

// Modo automático - navega automaticamente pelas licitações de TODOS os status
// config: { statusInicial, paginaInicial, indiceInicial } ou null para iniciar do começo
async function processarPaginaParticipacoes(config = null) {
  // RESETA FLAG DE PARADA
  PARAR_MONITORAMENTO = false;

  log('=== INICIANDO MONITORAMENTO AUTOMÁTICO (MULTI-STATUS) ===');
  resetContadoresPuladas();

  // Carrega licitações já capturadas do servidor
  await carregarLicitacoesCapturadas();

  // Verifica se há sessão anterior para retomar
  const sessaoAnterior = await carregarSessaoDoServidor();
  if (sessaoAnterior && sessaoAnterior.indiceLicitacao > 0) {
    const retomar = confirm(`Sessão anterior encontrada:\n\nStatus: ${sessaoAnterior.statusAtual}\nProgresso: ${sessaoAnterior.indiceLicitacao}/${sessaoAnterior.totalLicitacoes}\n\nDeseja retomar de onde parou?`);
    if (retomar) {
      // Encontra o índice do status
      const statusIndex = statusParaProcessar.findIndex(s =>
        s.status.toLowerCase().includes(sessaoAnterior.statusAtual.toLowerCase()) ||
        sessaoAnterior.statusAtual.toLowerCase().includes(s.status.toLowerCase())
      );
      if (statusIndex >= 0) {
        statusInicialIndex = statusIndex;
        paginaInicial = sessaoAnterior.paginaAtual || 1;
        // Calcula índice dentro da página
        const licitacoesPorPagina = 10;
        const licitacoesAntesDaPagina = (paginaInicial - 1) * licitacoesPorPagina;
        indiceInicial = Math.max(0, sessaoAnterior.indiceLicitacao - licitacoesAntesDaPagina) % licitacoesPorPagina;
        log(`[Retomando] Status: ${statusParaProcessar[statusIndex].status}, Página: ${paginaInicial}, Índice: ${indiceInicial}`);
      }
    } else {
      // Usuário escolheu não retomar, limpa sessão
      await limparSessaoNoServidor();
    }
  }

  // Inicia salvamento periódico
  iniciarSalvamentoPeriodicoSessao();

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

// Extrai compraId de uma linha da tabela
function extrairCompraIdDaLinha(botao) {
  try {
    // Tenta encontrar o compraId na linha da tabela
    const row = botao.closest('tr') || botao.closest('[role="row"]');
    if (!row) return null;

    // Procura por um link ou texto que contenha o padrão do compraId
    const texto = row.innerText;
    const match = texto.match(/(\d{8,14})/);
    if (match) return match[1];

    // Tenta extrair da URL se houver um link
    const link = row.querySelector('a[href*="compra="]');
    if (link) {
      const urlMatch = link.href.match(/compra=([\d]+)/);
      if (urlMatch) return urlMatch[1];
    }
  } catch (e) {
    // Silencioso
  }
  return null;
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

  // PROCESSAMENTO NA ORDEM NATURAL (de cima para baixo)
  // As licitações mais recentes aparecem primeiro na lista do Comprasnet
  // indiceLicitacaoAtual guarda quantas já foram processadas nesta página

  let jaProcessadasNaPagina = dados.indiceLicitacaoAtual || 0;

  // Se já processou todos desta página, vai para próxima
  if (jaProcessadasNaPagina >= totalBotoes) {
    log('Todos desta página já processados, indo para próxima...');
    await chrome.storage.local.set({ indiceLicitacaoAtual: 0 });
    await verificarProximaPagina();
    return;
  }

  // Processa na ordem natural (do primeiro ao último - mais recentes primeiro)
  for (let contador = jaProcessadasNaPagina; contador < totalBotoes; contador++) {
    // Índice direto no array (ordem natural da página)
    const i = contador;

    const dadosAtuais = await chrome.storage.local.get(['monitoramentoAtivo', 'licitacoesProcessadas']);
    if (!dadosAtuais.monitoramentoAtivo) {
      log('Monitoramento cancelado');
      break;
    }

    const processadas = dadosAtuais.licitacoesProcessadas || 0;

    log(`\n--- Licitação ${processadas + 1}/${dados.totalLicitacoes} (posição ${i + 1} da página) ---`);
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

      // Verifica se caiu em URL pública ou acesso negado
      if (urlAtual.includes('/public/') || urlAtual.includes('acesso-nao-autorizado')) {
        log('⚠ URL pública ou acesso negado detectado - pulando licitação');
        if (urlAtual.includes('/public/')) {
          licitacoesPuladasMotivos.urlPublica++;
        } else {
          licitacoesPuladasMotivos.acessoNegado++;
        }
        await chrome.storage.local.set({ licitacoesProcessadas: processadas + 1 });
        // Volta para a lista
        window.location.href = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras';
        return;
      }

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
        licitacoesPuladasMotivos.naoNavegou++;
    }
  }

  // Se chegou aqui, terminou todos os botões desta página
  await chrome.storage.local.set({ indiceLicitacaoAtual: 0 });
  await verificarProximaPagina();

  } catch (error) {
    if (error.message === 'MONITORAMENTO_PARADO') {
      log('=== Monitoramento interrompido pelo usuário ===');
      // Limpa o painel
      const painel = document.getElementById('monitor-progresso');
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
      const puladas = dados.totalLicitacoes - dados.licitacoesProcessadas;
      log(`Todos os status processados. ${dados.licitacoesProcessadas}/${dados.totalLicitacoes} licitações.`);
      log(`Puladas: ${puladas} (${getResumoPuladas()})`);
      atualizarPainelProgresso(dados.licitacoesProcessadas, dados.totalLicitacoes, `Parcial - ${puladas} puladas`);
      await chrome.storage.local.set({ monitoramentoAtivo: false });
      alert(`Monitoramento finalizado!\n\nProcessadas: ${dados.licitacoesProcessadas}/${dados.totalLicitacoes}\nPuladas: ${puladas}\n\nMotivos: ${getResumoPuladas()}`);
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
  const painelExistente = document.getElementById('monitor-progresso');
  if (painelExistente) painelExistente.remove();

  const painel = document.createElement('div');
  painel.id = 'monitor-progresso';
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
  let puladasEl = document.getElementById('progresso-puladas');
  const puladas = typeof getTotalPuladas === 'function' ? getTotalPuladas() : 0;

  if (texto) texto.textContent = `Processando ${atual}/${total}`;
  if (statusEl) statusEl.textContent = status;
  if (barra) barra.style.width = `${(atual/total)*100}%`;

  // Mostra contador de puladas se houver
  if (puladas > 0 && !puladasEl) {
    const painel = document.getElementById('monitor-progresso');
    if (painel) {
      puladasEl = document.createElement('div');
      puladasEl.id = 'progresso-puladas';
      puladasEl.style.cssText = 'font-size: 11px; color: #ff9800; margin-top: 8px;';
      const btnParar = document.getElementById('btn-parar-monitor');
      if (btnParar) {
        painel.insertBefore(puladasEl, btnParar);
      } else {
        painel.appendChild(puladasEl);
      }
    }
  }
  if (puladasEl && puladas > 0) {
    const resumo = typeof getResumoPuladas === 'function' ? getResumoPuladas() : '';
    puladasEl.textContent = `⚠ ${puladas} puladas${resumo ? ' (' + resumo + ')' : ''}`;
  }
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



// ==================== POLLING DE MENSAGENS ====================

// Executa polling de mensagens para uma lista de licitações
async function executarPollingMensagens(licitacoes) {
  log(`[Polling] Iniciando verificação de ${licitacoes.length} licitações`);

  // Verifica se a aba está livre antes de iniciar polling com navegação
  if (!abaLivre()) {
    const atual = getExtensaoAtual();
    log(`[Polling] Aba ocupada por ${atual.nome} (${atual.operacao}) - adiando polling`);
    return;
  }
  reivindicarAba('polling mensagens');

  mostrarNotificacao(`Verificando ${licitacoes.length} licitações...`, 'warning');

  let novasMensagens = 0;

  for (const lic of licitacoes) {
    try {
      // Monta o ID da compra (formato do Comprasnet)
      const compraId = `${lic.cnpj}${String(lic.sequencial).padStart(5, '0')}${lic.ano}`;
      const urlLicitacao = `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/acompanhamento-compra?compra=${compraId}`;

      log(`[Polling] Verificando licitação ${lic.cnpj}/${lic.sequencial}/${lic.ano}`);

      // Navega para a licitação
      window.location.href = urlLicitacao;

      // Aguarda a página carregar
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Tenta abrir o chat de mensagens
      const botaoMensagens = document.querySelector('button[aria-label*="mensagens"], button[aria-label*="Mensagens"], .mensagens-btn, [data-testid="mensagens"]');
      if (botaoMensagens) {
        botaoMensagens.click();
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Captura mensagens
        const mensagens = extrairMensagensDoChat();
        if (mensagens.length > 0) {
          const info = { cnpjOrgao: lic.cnpj, sequencial: lic.sequencial, ano: lic.ano, compraId };
          const result = await enviarMensagens(mensagens, info);
          if (result && result.inseridas > 0) {
            novasMensagens += result.inseridas;
            log(`[Polling] ${result.inseridas} novas mensagens em ${lic.cnpj}/${lic.sequencial}/${lic.ano}`);
          }
        }

        // Fecha o sidebar
        const botaoFechar = document.querySelector('.p-sidebar-close, button[aria-label="Fechar"]');
        if (botaoFechar) botaoFechar.click();
      }

      // Pequena pausa entre licitações
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (e) {
      log(`[Polling] Erro em ${lic.cnpj}/${lic.sequencial}/${lic.ano}: ${e.message}`);
    }
  }

  if (novasMensagens > 0) {
    mostrarNotificacao(`${novasMensagens} novas mensagens capturadas!`, 'success');
  } else {
    log('[Polling] Nenhuma nova mensagem encontrada');
  }

  // Volta para a página de participações
  window.location.href = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras';
}

// ==================== CAPTURA PARA POLLING (NOVA ABORDAGEM) ====================

async function capturarMensagensParaPolling(licitacao, options = {}) {
  // Abas abertas pelo background polling são dedicadas - não precisam de coordenação
  if (!options.fromBackgroundPolling && !abaLivre()) {
    const atual = getExtensaoAtual();
    log(`[Polling] Aba ocupada por ${atual.nome} - pulando captura`);
    return { success: false, error: 'Aba ocupada por ' + atual.nome };
  }

  // Marca esta aba como polling para evitar que o AUTO-START interfira
  window.__pncp_polling_tab = true;

  // Extrai info da licitação a partir da URL (mais confiável que os dados do background)
  const infoUrl = extrairInfoLicitacao();
  const infoFinal = {
    cnpjOrgao: (infoUrl && infoUrl.cnpjOrgao) || licitacao.cnpj || '',
    sequencial: (infoUrl && infoUrl.sequencial) || licitacao.sequencial || 0,
    ano: (infoUrl && infoUrl.ano) || licitacao.ano || 0,
    compraId: (infoUrl && infoUrl.compraId) || licitacao.compraId || ''
  };

  log(`[Polling] Iniciando captura: compraId=${infoFinal.compraId} cnpj=${infoFinal.cnpjOrgao} seq=${infoFinal.sequencial} ano=${infoFinal.ano}`);

  try {
    // Aguarda a página estar pronta
    await aguardar(3000);

    // Verifica se está na página correta
    const url = window.location.href;
    if (url.includes('acesso-nao-autorizado') || url.includes('login')) {
      log('[Polling] Página de login/erro - sessão expirada');
      return { success: false, error: 'Sessão expirada' };
    }

    if (!url.includes('compra=')) {
      log('[Polling] Página sem compra= na URL');
      return { success: false, error: 'Página incorreta' };
    }

    // Loga todos os botões visíveis para diagnóstico
    const todosBotoes = document.querySelectorAll('button, .p-button, [role="button"]');
    const botoesTexto = [];
    todosBotoes.forEach(btn => {
      const txt = (btn.innerText || btn.textContent || '').trim().substring(0, 50);
      const label = btn.getAttribute('aria-label') || '';
      if (txt || label) botoesTexto.push(`[${btn.tagName}] "${txt}" aria="${label}"`);
    });
    log(`[Polling] ${todosBotoes.length} botões na página: ${botoesTexto.slice(0, 10).join(' | ')}`);

    // Tenta encontrar e clicar no botão de mensagens (múltiplas estratégias)
    let botaoMensagens = null;

    // Estratégia 1: Seletores CSS
    const seletoresBotaoMsg = [
      'button[aria-label*="ensag"]',
      'button[aria-label*="chat"]',
      'button[aria-label*="Chat"]',
      '[aria-label*="ensag"]',
      '.mensagens-btn',
      '[data-testid="mensagens"]',
      '.p-button[aria-label*="chat"]'
    ];

    for (const seletor of seletoresBotaoMsg) {
      try {
        botaoMensagens = document.querySelector(seletor);
        if (botaoMensagens) {
          log(`[Polling] Botão encontrado por seletor: ${seletor}`);
          break;
        }
      } catch (e) {}
    }

    // Estratégia 2: Busca por texto em todos os elementos clicáveis
    if (!botaoMensagens) {
      const clicaveis = document.querySelectorAll('button, .p-button, a, [role="button"], [role="tab"]');
      for (const el of clicaveis) {
        const texto = (el.innerText || el.textContent || '').toLowerCase().trim();
        if (texto.includes('mensag') || texto.includes('chat') || texto === 'mensagens') {
          botaoMensagens = el;
          log(`[Polling] Botão encontrado por texto: "${texto}"`);
          break;
        }
      }
    }

    // Estratégia 3: Procura ícone de chat (balão de mensagem)
    if (!botaoMensagens) {
      const icones = document.querySelectorAll('button i, button span, .p-button i, .p-button span');
      for (const ico of icones) {
        const classes = ico.className || '';
        if (classes.includes('comment') || classes.includes('chat') || classes.includes('message')) {
          botaoMensagens = ico.closest('button') || ico.closest('.p-button');
          if (botaoMensagens) {
            log(`[Polling] Botão encontrado por ícone: ${classes}`);
            break;
          }
        }
      }
    }

    if (botaoMensagens) {
      log('[Polling] Clicando botão de mensagens...');
      botaoMensagens.click();

      // Aguarda o sidebar abrir (verifica DOM periodicamente)
      let sidebarAberto = false;
      for (let t = 0; t < 15; t++) {
        await aguardar(500);
        if (document.querySelector('.p-sidebar-content, .p-sidebar, .p-dialog')) {
          sidebarAberto = true;
          log('[Polling] Sidebar de mensagens aberto');
          break;
        }
      }

      if (!sidebarAberto) {
        log('[Polling] Sidebar não abriu após clique no botão');
      }
    } else {
      log('[Polling] AVISO: Nenhum botão de mensagens encontrado na página');
    }

    // Espera mais um pouco para mensagens carregarem
    await aguardar(2000);

    // Extrai mensagens do chat
    const mensagens = extrairMensagensDoChat();
    log(`[Polling] ${mensagens.length} mensagens extraídas do chat`);

    // Se não encontrou mensagens pelo sidebar, tenta extrair da página inteira
    if (mensagens.length === 0) {
      log('[Polling] Tentando extrair mensagens diretamente da página...');
      const msgsDaPagina = extrairMensagensDaPagina();
      if (msgsDaPagina.length > 0) {
        log(`[Polling] ${msgsDaPagina.length} mensagens encontradas na página`);
        mensagens.push(...msgsDaPagina);
      }
    }

    if (mensagens.length === 0) {
      // Tenta fechar o sidebar se abriu
      const btnFechar = document.querySelector('.p-sidebar-close, button[aria-label="Fechar"], .p-dialog-header-close');
      if (btnFechar) btnFechar.click();

      return {
        success: true,
        mensagens: 0,
        novas: 0,
        message: 'Nenhuma mensagem encontrada'
      };
    }

    // Envia para o servidor com dados corretos
    const resultado = await enviarMensagens(mensagens, infoFinal);

    // Fecha o sidebar
    const btnFechar = document.querySelector('.p-sidebar-close, button[aria-label="Fechar"], .p-dialog-header-close');
    if (btnFechar) btnFechar.click();

    const novas = resultado && resultado.inseridas ? resultado.inseridas : 0;
    log(`[Polling] Resultado: ${mensagens.length} total, ${novas} novas`);

    return {
      success: true,
      mensagens: mensagens.length,
      novas: novas,
      message: `${novas} novas mensagens`
    };

  } catch (error) {
    log(`[Polling] Erro na captura: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

// Extrai mensagens diretamente da página (sem sidebar)
function extrairMensagensDaPagina() {
  const mensagens = [];
  // Procura textos que pareçam mensagens de chat no body
  const textoBody = document.body.innerText || '';
  const blocos = textoBody.split(/(?=Mensagem do )/g);

  blocos.forEach(bloco => {
    const texto = bloco.trim();
    if (texto.length > 20 && texto.startsWith('Mensagem do')) {
      const ignorar = ['Visualize aqui', 'Não há mensagens', 'Captcha', 'Tente mais tarde', 'Fechar', 'Sessão Pública'];
      if (!ignorar.some(i => texto.includes(i))) {
        let dataHora = new Date().toISOString();
        const matchData = texto.match(/Enviada em (\d{2})\/(\d{2})\/(\d{4}) às (\d{2}):(\d{2}):(\d{2})h?/);
        if (matchData) {
          const [, dia, mes, ano, hora, minuto, segundo] = matchData;
          const dataMsg = new Date(ano, mes - 1, dia, hora, minuto, segundo);
          if (!isNaN(dataMsg.getTime())) dataHora = dataMsg.toISOString();
        }
        const textoLimpo = texto.replace(/\n?Enviada em \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}:\d{2}h?.*$/s, '').trim();
        if (textoLimpo.length > 10 && !mensagens.some(m => m.texto === textoLimpo)) {
          mensagens.push({
            texto: textoLimpo,
            remetente: texto.includes('Participante') ? 'Participante' : 'Sistema',
            dataHora
          });
        }
      }
    }
  });
  return mensagens;
}

// ==================== SINCRONIZAÇÃO DE PARTICIPAÇÕES ====================

async function sincronizarParticipacoes() {
  // Sync é operação passiva (lê DOM + POST) - não precisa de controle exclusivo da aba
  log('[Sync] Iniciando sincronização de participações...');
  mostrarNotificacao('Sincronizando participações...', 'warning');

  try {
    // Obtém status disponíveis no dropdown
    const statusDisponiveis = await obterStatusDisponiveis();

    // Filtra os que queremos monitorar
    const statusParaProcessar = STATUS_PARA_MONITORAR.filter(s =>
      statusDisponiveis.some(d => d.toLowerCase().includes(s.toLowerCase()))
    );
    const listaFinal = statusParaProcessar.length > 0 ? statusParaProcessar : statusDisponiveis;
    log(`[Sync] Status para sincronizar: ${listaFinal.join(', ')}`);

    let todasParticipacoes = [];

    for (const status of listaFinal) {
      if (await selecionarStatus(status)) {
        await aguardar(2000);
        const participacoes = extrairParticipacoesDoComprasnet();
        if (participacoes.length > 0) {
          // Adiciona o status a cada participação
          participacoes.forEach(p => { if (!p.situacao) p.situacao = status; });
          todasParticipacoes.push(...participacoes);
          log(`[Sync] ${status}: ${participacoes.length} participações extraídas`);
        } else {
          log(`[Sync] ${status}: nenhuma participação extraída`);
        }
      }
    }

    // Remove duplicatas pelo compraId
    const uniqueMap = new Map();
    todasParticipacoes.forEach(p => {
      const key = p.compraId || `${p.codigoUnidade}_${p.numero}_${p.ano}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, p);
      }
    });
    todasParticipacoes = Array.from(uniqueMap.values());

    if (todasParticipacoes.length === 0) {
      log('[Sync] Nenhuma participação encontrada em nenhum status');
      mostrarNotificacao('Nenhuma participação encontrada', 'warning');
      return;
    }

    log(`[Sync] ${todasParticipacoes.length} participações únicas encontradas, enviando para servidor...`);

    // Envia para o servidor
    const response = await serverFetch(`${SERVER_URL}/api/chat/participacoes/sincronizar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participacoes: todasParticipacoes })
    });

    if (response.ok) {
      const result = await response.json();
      log(`[Sync] Sincronização concluída: ${result.inseridas} novas, ${result.atualizadas} atualizadas`);
      mostrarNotificacao(`${todasParticipacoes.length} participações sincronizadas!`, 'success');
    } else {
      log(`[Sync] Erro na resposta: ${response.status}`);
      mostrarNotificacao('Erro ao sincronizar', 'error');
    }
  } catch (error) {
    log(`[Sync] Erro: ${error.message}`);
    mostrarNotificacao('Erro ao sincronizar participações', 'error');
  }
}

function extrairParticipacoesDoComprasnet() {
  const participacoes = [];

  // Tenta injetar script no contexto da página para extrair dados dos componentes Angular
  // Os compraIds não estão no HTML estático - estão nos objetos dos componentes Angular
  try {
    const eventName = '_pncp_extract_' + Date.now();
    let dadosAngular = null;

    // Listener para receber dados do script injetado
    const handler = (e) => { dadosAngular = e.detail; };
    document.addEventListener(eventName, handler, { once: true });

    const script = document.createElement('script');
    script.textContent = `
      (function() {
        try {
          var cards = document.querySelectorAll('app-card-compra-pesquisa');
          var dados = [];
          cards.forEach(function(card) {
            try {
              // Angular Ivy: __ngContext__ aponta para o LView index
              var ctx = card.__ngContext__;
              if (typeof ctx === 'number') {
                // Percorre parents para encontrar o LView
                var parent = card.parentNode;
                while (parent) {
                  var lv = parent.__ngContext__;
                  if (Array.isArray(lv)) {
                    // Busca o objeto da compra no LView
                    for (var i = 0; i < lv.length; i++) {
                      var item = lv[i];
                      if (item && typeof item === 'object' && item.compraId) {
                        dados.push({
                          compraId: String(item.compraId || ''),
                          cnpj: String(item.cnpjOrgao || item.cnpj || ''),
                          sequencial: item.sequencial || item.numero || 0,
                          ano: item.ano || 0,
                          tipo: item.tipo || item.modalidade || '',
                          numero: item.numero || item.sequencial || '',
                          orgao: item.nomeOrgao || item.orgao || '',
                          objeto: item.objeto || item.objetoCompra || '',
                          etapa: item.etapa || '',
                          situacao: item.situacao || item.status || ''
                        });
                        break;
                      }
                    }
                    break;
                  }
                  parent = parent.parentNode;
                }
              }
              // Fallback: tenta ng.getComponent (modo dev)
              if (dados.length === 0 && typeof ng !== 'undefined' && ng.getComponent) {
                var comp = ng.getComponent(card);
                if (comp && comp.compra) {
                  var c = comp.compra;
                  dados.push({
                    compraId: String(c.compraId || c.id || ''),
                    cnpj: String(c.cnpjOrgao || c.cnpj || ''),
                    sequencial: c.sequencial || c.numero || 0,
                    ano: c.ano || 0,
                    tipo: c.tipo || c.modalidade || '',
                    numero: c.numero || c.sequencial || '',
                    orgao: c.nomeOrgao || c.orgao || '',
                    objeto: c.objeto || '',
                    etapa: c.etapa || '',
                    situacao: c.situacao || c.status || ''
                  });
                }
              }
            } catch(e) {}
          });
          document.dispatchEvent(new CustomEvent('${eventName}', { detail: dados }));
        } catch(e) {
          document.dispatchEvent(new CustomEvent('${eventName}', { detail: [] }));
        }
      })();
    `;
    document.head.appendChild(script);
    script.remove();

    // O script roda sincronamente, então dadosAngular já deve estar preenchido
    if (dadosAngular && dadosAngular.length > 0) {
      log(`[Sync] Dados extraídos via Angular: ${dadosAngular.length} participações`);
      dadosAngular.forEach(d => {
        if (d.compraId) {
          const compraId = d.compraId;
          // Decompõe o compraId para extrair cnpj/sequencial/ano
          // Formato: CNPJ + SEQUENCIAL + ANO (últimos 4 dígitos = ano)
          const ano = d.ano || parseInt(compraId.slice(-4)) || 0;
          const urlCompra = `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/acompanhamento-compra?compra=${compraId}`;
          participacoes.push({
            compraId,
            cnpj: d.cnpj || '',
            codigoUnidade: '',
            ano,
            sequencial: d.sequencial || 0,
            tipo: d.tipo || '',
            numero: String(d.numero || d.sequencial || ''),
            orgao: d.orgao || '',
            objeto: d.objeto || '',
            etapa: d.etapa || '',
            situacao: d.situacao || '',
            urlCompra,
            dataSessao: ''
          });
        }
      });

      if (participacoes.length > 0) {
        return participacoes;
      }
    }

    log('[Sync] Extração via Angular não retornou dados, usando fallback por texto');
  } catch (e) {
    log(`[Sync] Erro na extração via Angular: ${e.message}, usando fallback`);
  }

  // FALLBACK: Extração por texto do DOM (sem compraId - limitado)
  const botoes = document.querySelectorAll('button[aria-label="Participar/acompanhar compra"]');
  log(`[Sync] Fallback: ${botoes.length} botões encontrados`);

  botoes.forEach((botao, index) => {
    try {
      // Sobe até encontrar o card da licitação (app-card-compra-pesquisa ou container com texto)
      let container = botao.closest('app-card-compra-pesquisa') ||
                      botao.closest('tr') ||
                      botao.closest('.p-datatable-row') ||
                      botao.closest('[role="row"]');

      if (!container) {
        let el = botao.parentElement;
        for (let nivel = 0; nivel < 8 && el; nivel++) {
          if (el.innerText && el.innerText.length > 50) {
            container = el;
            break;
          }
          el = el.parentElement;
        }
      }

      if (!container) {
        log(`[Sync] Container não encontrado para botão ${index}`);
        return;
      }

      const texto = container.innerText || '';

      let tipo = '', numero = '', ano = '', orgao = '', etapa = '', situacao = '';
      let dataSessao = '', compraId = '', codigoUnidade = '', cnpj = '';

      // Extrai Pregão/Dispensa + número/ano
      // Formatos: "Dispensa Eletrônica N° 1/2022", "Pregão Eletrônico Nº 5/2025"
      const matchTipo = texto.match(/(Pregão|Dispensa|Concorrência|Tomada de Preços|Leilão|Convite)[\w\sÀ-ú°º]*?(\d+)\/(\d{4})/i);
      if (matchTipo) {
        tipo = matchTipo[1];
        numero = matchTipo[2];
        ano = matchTipo[3];
      }

      // Extrai órgão
      const linhas = texto.split('\n').map(l => l.trim()).filter(l => l);
      for (const linha of linhas) {
        if (linha.length > 20 && !linha.match(/Pregão|Dispensa|Concorrência|Etapa|Encerrado|Aberto|Tomada/i)) {
          orgao = linha.substring(0, 100);
          break;
        }
      }

      // Extrai etapa
      const matchEtapa = texto.match(/Etapa:\s*([^\n]+)/i);
      if (matchEtapa) etapa = matchEtapa[1].trim();

      // Extrai situação
      if (texto.includes('Encerrado')) situacao = 'Encerrado';
      else if (texto.includes('Em andamento')) situacao = 'Em andamento';
      else if (texto.includes('Aberto')) situacao = 'Aberto';
      else if (texto.includes('Suspenso')) situacao = 'Suspenso';

      // Extrai data da sessão
      const matchData = texto.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/);
      if (matchData) dataSessao = `${matchData[1]} ${matchData[2]}`;

      // Extrai compraId do HTML se disponível
      const containerHtml = container.outerHTML || '';
      const matchCompraId = containerHtml.match(/compra=(\d+)/);
      if (matchCompraId) compraId = matchCompraId[1];

      // Extrai CNPJ
      const matchCnpj = texto.match(/(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/);
      if (matchCnpj) cnpj = matchCnpj[1].replace(/\D/g, '');

      // Extrai UASG (6 dígitos após ME/EPP, AMPLA, SRP ou isolado antes de " - ")
      if (!codigoUnidade) {
        const matchUasg = texto.match(/(?:ME\/EPP|AMPLA|SRP)\s+(\d{6})\s*-/);
        if (matchUasg) codigoUnidade = matchUasg[1];
      }

      if (numero && ano) {
        participacoes.push({
          compraId,
          cnpj: cnpj || codigoUnidade,
          codigoUnidade,
          ano: parseInt(ano),
          sequencial: parseInt(numero),
          tipo, numero, orgao, objeto: '',
          etapa, situacao,
          urlCompra: compraId ? `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/acompanhamento-compra?compra=${compraId}` : '',
          dataSessao
        });
      } else {
        log(`[Sync] Botão ${index}: não extraiu numero/ano do texto: "${texto.substring(0, 100)}..."`);
      }

    } catch (e) {
      log(`[Sync] Erro ao extrair participação ${index}: ${e.message}`);
    }
  });

  // Remove duplicatas pelo compraId
  const uniqueMap = new Map();
  participacoes.forEach(p => {
    const key = p.compraId || `${p.codigoUnidade}_${p.numero}_${p.ano}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, p);
    }
  });

  return Array.from(uniqueMap.values());
}

// ==================== MESSAGE LISTENER ====================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Captura mensagens para polling do background (nova abordagem)
  if (request.action === 'capturarMensagensPolling') {
    log('[Polling] Comando de captura recebido');
    capturarMensagensParaPolling(request.licitacao, { fromBackgroundPolling: true })
      .then(resultado => sendResponse(resultado))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Indica resposta assíncrona
  }

  // Polling de mensagens (chamado pelo background) - método antigo, mantido por compatibilidade
  if (request.action === 'pollingMensagens') {
    log('[Polling] Comando de polling recebido');
    executarPollingMensagens(request.licitacoes);
    sendResponse({ success: true, message: 'Polling iniciado' });
    return;
  }

  // Keep-alive do background
  if (request.action === 'keepAlive') {
    log('Keep-alive recebido do background');
    sendResponse({ alive: true });
    return;
  }

  if (request.action === 'obterStatus') {
    obterStatusDisponiveis().then(statusList => {
      log('DEBUG: Status encontrados: ' + statusList.join(', '));
      sendResponse({ success: true, statusList: statusList });
    }).catch(err => {
      log('DEBUG: Erro ao obter status: ' + err.message);
      sendResponse({ success: false, statusList: STATUS_PARA_MONITORAR });
    });
    return true;
  }

  if (request.action === 'iniciarAutomatico') {
    log('DEBUG: Acao iniciarAutomatico recebida');
    const config = request.config || null;
    const url = window.location.href;
    const isPaginaParticipacoes = url.includes('/fornecedor/compras') ||
                                   url.includes('/fornecedor/participacoes') ||
                                   url.includes('comprasnet-web/seguro');

    if (isPaginaParticipacoes) {
      if (config) {
        chrome.storage.local.set({ configCustomizada: config }).then(() => {
          processarPaginaParticipacoes(config);
        });
      } else {
        processarPaginaParticipacoes(null);
      }
      sendResponse({ success: true });
    } else if (url.includes('cnetmobile.estaleiro.serpro.gov.br')) {
      const urlParticipacoes = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras';
      chrome.storage.local.set({ iniciarAposNavegar: true, configCustomizada: config });
      if (!abaLivre()) {
        chrome.runtime.sendMessage({ action: 'abrirPagina', url: urlParticipacoes });
      } else {
        window.location.href = urlParticipacoes;
      }
      sendResponse({ success: true, message: 'Navegando para participacoes...' });
    } else {
      sendResponse({ success: false, message: 'Abra o site do Comprasnet primeiro' });
    }
  } else if (request.action === 'pararAutomatico') {
    log('=== MONITORAMENTO PARADO PELO USUARIO ===');
    PARAR_MONITORAMENTO = true;
    chrome.storage.local.set({
      emProcessamento: false,
      monitoramentoAtivo: false,
      iniciarAposNavegar: false,
      configCustomizada: null
    });
    const painel = document.getElementById('monitor-progresso');
    if (painel) {
      painel.innerHTML = '<div style="padding: 20px; text-align: center; color: #f44336; font-weight: bold;">PARADO!</div>';
      setTimeout(() => painel.remove(), 2000);
    }
    mostrarNotificacao('Monitoramento PARADO!', 'warning');
    sendResponse({ success: true });
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

// ==================== API DISCOVERY RELAY ====================
// Observa mudanças no atributo data-pncp-api-discovery (escrito pelo interceptor injetado no MAIN world)
// e relay para o background.js via chrome.runtime.sendMessage

function iniciarApiDiscoveryListener() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.attributeName === 'data-pncp-api-discovery') {
        const value = document.documentElement.getAttribute('data-pncp-api-discovery');
        if (!value) return;

        try {
          const discovery = JSON.parse(value);
          log(`[API Discovery] Relay: URL=${discovery.url}, match=${discovery.matchType}`);
          chrome.runtime.sendMessage({
            action: 'apiDiscovered',
            discovery: discovery
          }, (response) => {
            if (chrome.runtime.lastError) {
              log(`[API Discovery] Erro no relay: ${chrome.runtime.lastError.message}`);
            } else if (response && response.success) {
              log('[API Discovery] Background confirmou recebimento');
            }
          });
        } catch (e) {
          log(`[API Discovery] Erro ao parsear discovery: ${e.message}`);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-pncp-api-discovery']
  });

  log('[API Discovery] Listener iniciado');
}

// Observa navegacao
function observarNavegacao() {
  const urlAtual = window.location.href;
  log('NAVEGACAO: ' + urlAtual);
  serverFetch(SERVER_URL + '/api/chat/navegacao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo: 'navegacao', url: urlAtual, titulo: document.title, timestamp: new Date().toISOString() })
  }).catch(() => {});
}

// Inicializacao
(async () => {
  const url = window.location.href;
  if (!url.includes('cnetmobile.estaleiro.serpro.gov.br')) return;

  // Ignora páginas de login/erro
  if (url.includes('acesso-nao-autorizado') || url.includes('login') || url.includes('captcha')) {
    log('Página de login/erro detectada - extensão não ativada');
    return;
  }

  // Inicia listener de API discovery em QUALQUER aba Comprasnet (antes do isPollingTab check)
  // Para que funcione tanto em abas normais quanto de polling
  iniciarApiDiscoveryListener();

  // AUTO-REGISTRO: Se está em uma página de licitação, registra para monitoramento automático
  if (url.includes('compra=')) {
    registrarLicitacaoAcessada();
  }

  // Detecta aba de polling (aberta pelo background para captura automática de mensagens)
  // Essas abas NÃO devem executar auto-processing (monitoramento, mapeamento, etc.)
  const isPollingTab = url.includes('#pncp-polling');
  if (isPollingTab) {
    window.__pncp_polling_tab = true;
    log('=== EXTENSAO MONITOR (ABA POLLING) ===');
    log('URL: ' + url);
    // Apenas registra presença e aguarda comando do background
    registrarPresenca('polling');
    iniciarHeartbeat();
    return; // Pula toda a lógica de auto-start
  }

  log('=== EXTENSAO MONITOR INICIADA ===');
  log('URL: ' + url);

  // Registra presença passiva e inicia heartbeat
  registrarPresenca('aguardando');
  iniciarHeartbeat();

  observarNavegacao();
  iniciarKeepAlive();

  // Verifica se ha monitoramento ativo para retomar
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
    marcarAbaAtiva('retomando monitoramento');

    log('Retomando monitoramento ativo...');
    const isPaginaLista = url.includes('/fornecedor/compras') &&
                          !url.includes('acompanhamento-compra') &&
                          !url.includes('disputa?compra') &&
                          !url.match(/compra=\d+/);

    if (isPaginaLista) {
      await aguardar(5000);
      mostrarPainelProgresso(monitorData.licitacoesProcessadas, monitorData.totalLicitacoes);
      const statusAtual = monitorData.statusAtualNome;
      if (statusAtual) {
        const statusSelecionado = await selecionarStatus(statusAtual);
        await aguardar(3000);
      }
      const paginaAtual = monitorData.paginaAtual || 1;
      if (paginaAtual > 1) {
        await navegarParaPagina(paginaAtual);
        await aguardar(3000);
      }
      await processarLicitacoesDaPagina();
      return;
    }

    if (url.includes('acompanhamento-compra') || url.includes('disputa?compra') || url.match(/compra=\d+/)) {
      await aguardar(3000);
      await processarPaginaLicitacaoAtual(monitorData);
      return;
    }
  }

  // Verifica se deve iniciar apos navegar
  const initData = await chrome.storage.local.get(['iniciarAposNavegar', 'configCustomizada', 'autoMonitoramento']);
  if (initData.iniciarAposNavegar) {
    const isPaginaValida = url.includes('/fornecedor/compras') || url.includes('/fornecedor/participacoes') || url.includes('comprasnet-web/seguro');
    if (isPaginaValida) {
      // Verifica se a aba está livre
      if (!abaLivre()) {
        const atual = getExtensaoAtual();
        log(`[Aba] Ocupada por ${atual.nome} - abrindo nova aba para iniciar monitoramento`);
        chrome.runtime.sendMessage({ action: 'abrirPagina', url: url });
        return;
      }
      marcarAbaAtiva('iniciando monitoramento');

      const config = initData.configCustomizada || null;
      await chrome.storage.local.set({ iniciarAposNavegar: false, configCustomizada: null });
      await aguardar(3000);
      processarPaginaParticipacoes(config);
      return;
    }
  }

  // Verifica processamento automatico
  const data = await chrome.storage.local.get(['emProcessamento', 'indiceAtual', 'totalLinks']);
  if (data.emProcessamento && url.includes('compra=')) {
    // Verifica se a aba está livre
    if (!abaLivre()) {
      const atual = getExtensaoAtual();
      log(`[Aba] Ocupada por ${atual.nome} - abrindo nova aba para continuar processamento`);
      chrome.runtime.sendMessage({ action: 'abrirPagina', url: url });
      return;
    }
    marcarAbaAtiva('processando licitação');

    await processarLicitacaoAtual();
  }

  // AUTO-START: Inicia monitoramento automaticamente na página de participações
  const isPaginaParticipacoes = url.includes('/fornecedor/compras') &&
                                 !url.includes('acompanhamento-compra') &&
                                 !url.includes('disputa?compra') &&
                                 !url.match(/compra=\d+/);

  if (isPaginaParticipacoes) {
    log('=== AUTO-START: Página de participações detectada ===');

    // Aguarda a página carregar completamente
    await aguardar(5000);

    // Verifica se o usuário está logado (verifica se há botões de licitação)
    const botoesLicitacao = document.querySelectorAll('button[aria-label="Participar/acompanhar compra"]');
    const textoExibindo = document.body.innerText.match(/Exibindo \d+ de (\d+) registro/);

    if (botoesLicitacao.length > 0 || textoExibindo) {
      log('AUTO-START: Usuário logado');

      // Verifica se há mapeamento interrompido para retomar
      const resumeData = await chrome.storage.local.get([
        'mapeamentoEmAndamento', 'mapStatusIdx', 'mapPaginaAtual',
        'mapBotaoIdx', 'mapCompraIdsVistos', 'mapStatusLista'
      ]);

      if (resumeData.mapeamentoEmAndamento) {
        log('AUTO-START: Retomando mapeamento interrompido...');
        mapearCompraIds(resumeData);
        return;
      }

      // MAPEAMENTO RÁPIDO: Extrai compraIds via extração direta ou cliques
      log('AUTO-START: Iniciando mapeamento de compraIds...');
      mapearCompraIds();
      return;
    } else {
      log('AUTO-START: Aguardando login ou carregamento da página...');
    }
  }

  // Se está em qualquer página do Comprasnet mas NÃO na listagem de participações,
  // abre a listagem em background para mapear compraIds (UMA VEZ só)
  // MAS: não faz isso se for uma aba de licitação específica (polling ou acesso manual)
  const isDetalhe = url.includes('compra=') || url.includes('acompanhamento-compra') || url.includes('cadastro-propostas') || url.includes('disputa?');
  if (!isPaginaParticipacoes && !isDetalhe && url.includes('cnetmobile.estaleiro.serpro.gov.br')) {
    const { mapeamentoIniciado } = await chrome.storage.local.get('mapeamentoIniciado');
    if (!mapeamentoIniciado) {
      await chrome.storage.local.set({ mapeamentoIniciado: true });
      log('AUTO-START: Abrindo página de participações para mapeamento...');
      chrome.runtime.sendMessage({
        action: 'abrirPagina',
        url: 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras'
      });
    }
  }

  monitorarAberturaManual();
  log('DEBUG: Monitoramento manual ativado');
})();
