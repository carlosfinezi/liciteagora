// Lances Comprasnet - Content Script v1.2
// Automacao de lances no Comprasnet
// v1.2: Sistema de separacao de abas - se aba ocupada, abre nova aba

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
// Cada extensão escreve data-pncp-ext-{nome} com JSON de estado
const EXT_NAME = 'lances';
const EXT_ATTR = 'data-pncp-ext-lances';
const EXT_PRIORITY = 3; // lances=3, propostas=2, monitor=1, chrome=1
const EXT_STALE_MS = 15000; // 15s sem heartbeat = extensão morta
const EXT_HEARTBEAT_MS = 5000; // heartbeat a cada 5s

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
    // Verifica prioridade - se algum ocupante tem prioridade >= a nossa, cedemos
    const maiorPrioridade = Math.max(...ocupantes.map(o => o.priority));
    if (maiorPrioridade >= EXT_PRIORITY) {
      return false; // Não conseguimos reivindicar
    }
    // Nossa prioridade é maior - reivindicamos
  }
  reivindicarAba(operacao);
  // Aguarda 200ms para detectar race condition
  await new Promise(r => setTimeout(r, 200));
  // Verifica se outra extensão também reivindicou
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

// Compat: getExtensaoAtual retorna info sobre quem controla a aba
function getExtensaoAtual() {
  const ocupantes = extensoesComControle();
  if (ocupantes.length > 0) return { nome: ocupantes[0].name, operacao: ocupantes[0].operation };
  return { nome: null, operacao: null };
}
// ==================== FIM SISTEMA DE COORDENAÇÃO ====================

// Estado
let estadoDisputa = {
  ativo: false,
  compraId: null,
  itens: [],
  modoAutomatico: false,
  tempoRestante: null, // tempo restante em segundos
  limitesPorItem: {}, // { itemNumero: valorMinimo }
  config: {
    modo: 'valor', // 'valor' ou 'percentual'
    cobertura: 0.01,
    minimo: null,
    intervalo: 3000
  }
};

let pollingTimer = null;
let painelInjetado = false;
let tempoAnterior = null; // Para detectar reset do tempo (novo lance de concorrente)

// ==================== FUNÇÕES AUXILIARES ====================

function log(msg) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[Lances Comprasnet] [${timestamp}] ${msg}`);

  // Envia log para o servidor
  serverFetch(`${SERVER_URL}/api/lance/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mensagem: msg, timestamp: new Date().toISOString() })
  }).catch(() => {});
}

function aguardar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatarMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(valor);
}

function parseMoeda(texto) {
  if (!texto) return null;
  // Remove "R$", pontos de milhar e troca vírgula por ponto
  const limpo = texto.replace(/R\$\s*/g, '').replace(/\./g, '').replace(',', '.').trim();
  const valor = parseFloat(limpo);
  return isNaN(valor) ? null : valor;
}

// ==================== DETECÇÃO DE PÁGINA ====================

function detectarPaginaDisputa() {
  const url = window.location.href;

  // Verifica se está na página de disputa/compras
  if (!url.includes('comprasnet-web/seguro')) {
    return false;
  }

  // Verifica se existe o texto "Disputa" na página
  const textoDisputa = document.body.innerText;
  if (textoDisputa.includes('Etapa:') && textoDisputa.includes('Disputa')) {
    log('Página de DISPUTA detectada!');
    return true;
  }

  // Verifica elementos específicos da página de disputa
  const elementosDisputa = document.querySelectorAll('[class*="disputa"], [class*="lance"], [data-test*="lance"]');
  if (elementosDisputa.length > 0) {
    log('Elementos de disputa encontrados');
    return true;
  }

  return false;
}

function extrairCompraId() {
  const url = window.location.href;

  // Tenta extrair do parâmetro compra= na URL
  const match = url.match(/compra=(\d+)/);
  if (match) {
    return match[1];
  }

  // Tenta extrair de outros padrões na URL
  const match2 = url.match(/\/(\d{14,20})(?:\/|$|\?)/);
  if (match2) {
    return match2[1];
  }

  return null;
}

// ==================== EXTRAÇÃO DE DADOS ====================

function extrairTempoRestante() {
  const tempoElem = document.querySelector('[data-test="tempo-restante"], .cp-item-bold');

  if (tempoElem) {
    const texto = tempoElem.innerText.trim();
    // Formato esperado: mm:ss ou hh:mm:ss
    const partes = texto.split(':').map(p => parseInt(p) || 0);

    let segundos = 0;
    if (partes.length === 2) {
      // mm:ss
      segundos = partes[0] * 60 + partes[1];
    } else if (partes.length === 3) {
      // hh:mm:ss
      segundos = partes[0] * 3600 + partes[1] * 60 + partes[2];
    }

    // Detecta se o tempo resetou (aumentou significativamente = novo lance de concorrente)
    if (tempoAnterior !== null && segundos > tempoAnterior + 10) {
      log(`⚠️ Tempo resetou! ${tempoAnterior}s -> ${segundos}s (possível novo lance de concorrente)`);
      notificarServidor('tempo_resetou', {
        tempoAnterior,
        tempoNovo: segundos,
        motivo: 'Possível lance de concorrente'
      });
    }

    tempoAnterior = segundos;
    estadoDisputa.tempoRestante = segundos;
    return segundos;
  }

  return null;
}

function extrairItensDisputa() {
  const itens = [];

  // Busca cards de itens - tenta múltiplos seletores
  let cards = document.querySelectorAll('.cp-itens-card');

  // Se não encontrou, tenta seletores alternativos da página de disputa
  if (cards.length === 0) {
    cards = document.querySelectorAll('[class*="item-card"], [class*="card-item"], .card-disputa');
  }
  if (cards.length === 0) {
    cards = document.querySelectorAll('[data-test*="item"], [data-test*="lance"]');
  }
  if (cards.length === 0) {
    // Tenta encontrar pela estrutura de inputs de lance
    const inputs = document.querySelectorAll('input[data-test="lance"], input[currencymask]');
    if (inputs.length > 0) {
      log(`Encontrados ${inputs.length} inputs de lance, buscando cards pais...`);
      const cardsSet = new Set();
      inputs.forEach(input => {
        // Sobe na hierarquia para encontrar o card pai
        let parent = input.parentElement;
        for (let i = 0; i < 10 && parent; i++) {
          if (parent.classList && (
            parent.classList.contains('row') ||
            parent.classList.contains('card') ||
            parent.className.includes('item')
          )) {
            cardsSet.add(parent);
            break;
          }
          parent = parent.parentElement;
        }
      });
      cards = Array.from(cardsSet);
    }
  }

  log(`Encontrados ${cards.length} cards de itens`);

  cards.forEach((card, index) => {
    try {
      const item = {
        numero: null,
        descricao: '',
        menorLance: null,
        meuLance: null,
        posicao: null,
        melhorClassificado: false,
        cardElement: card
      };

      // Extrai número do item
      const numeroElem = card.querySelector('.cp-item-bold, .dots, [class*="numero"]');
      if (numeroElem) {
        const textoNumero = numeroElem.innerText.trim();
        const matchNumero = textoNumero.match(/^\s*(\d+)/);
        if (matchNumero) {
          item.numero = parseInt(matchNumero[1]);
        }
      }

      // Extrai descrição
      const descElem = card.querySelector('.cp-texto-item, [class*="descricao"]');
      if (descElem) {
        item.descricao = descElem.innerText.trim().substring(0, 100);
      }

      // Busca o melhor valor (valor-geral)
      const melhorValorElem = card.querySelector('[data-test="valor-geral"]');
      if (melhorValorElem) {
        item.menorLance = parseMoeda(melhorValorElem.innerText);
      }

      // Busca meu valor (valor-fornec)
      const meuValorElem = card.querySelector('[data-test="valor-fornec"]');
      if (meuValorElem) {
        item.meuLance = parseMoeda(meuValorElem.innerText);
        // Classe cp-valor-item-vermelho indica que está perdendo
        item.perdendo = meuValorElem.classList.contains('cp-valor-item-vermelho');
      }

      // Verifica se está em primeiro lugar (meu lance = menor lance)
      if (item.menorLance && item.meuLance) {
        if (item.meuLance <= item.menorLance) {
          item.melhorClassificado = true;
          item.posicao = 1;
        } else {
          item.melhorClassificado = false;
          item.perdendo = true;
        }
      }

      // Também verifica pela classe verde (se existir)
      const textoCard = card.innerText.toLowerCase();
      if (textoCard.includes('1º') || textoCard.includes('primeiro') || textoCard.includes('melhor classificado')) {
        item.melhorClassificado = true;
        item.posicao = 1;
      }

      // Busca campo de input de lance (data-test="lance" ou classe cp-input-valor)
      const inputLance = card.querySelector('input[data-test="lance"], input.cp-input-valor, input[currencymask]');
      if (inputLance) {
        item.inputElement = inputLance;
        // O ID do input é o número do item
        if (inputLance.id && !item.numero) {
          item.numero = parseInt(inputLance.id);
        }
      }

      // Busca botão de enviar lance (elemento <u> com texto "Enviar lance")
      const elementosU = card.querySelectorAll('u');
      for (const u of elementosU) {
        if (u.innerText.trim().toLowerCase() === 'enviar lance') {
          item.btnElement = u.closest('button') || u.parentElement || u;
          break;
        }
      }

      // Se não encontrou, busca botão genérico
      if (!item.btnElement) {
        const btnLance = card.querySelector('button');
        if (btnLance && btnLance.innerText.toLowerCase().includes('lance')) {
          item.btnElement = btnLance;
        }
      }

      if (item.numero !== null) {
        itens.push(item);
      }

    } catch (e) {
      log(`Erro ao extrair item ${index}: ${e.message}`);
    }
  });

  return itens;
}

// ==================== ENVIO DE LANCE ====================

async function enviarLance(itemNumero, valor) {
  log(`Tentando enviar lance de ${formatarMoeda(valor)} no item ${itemNumero}`);

  const item = estadoDisputa.itens.find(i => i.numero === itemNumero);
  if (!item) {
    log(`Item ${itemNumero} não encontrado`);
    return { success: false, error: 'Item não encontrado' };
  }

  // Verifica se tem campo de input
  if (!item.inputElement) {
    // Tenta encontrar pelo ID do item (id="1", id="2", etc)
    item.inputElement = document.querySelector(`input[data-test="lance"][id="${itemNumero}"]`);

    if (!item.inputElement) {
      // Tenta encontrar por classe
      item.inputElement = document.querySelector(`input.cp-input-valor[id="${itemNumero}"]`);
    }

    if (!item.inputElement) {
      // Busca nos cards
      const cards = document.querySelectorAll('.cp-itens-card');
      for (const card of cards) {
        const inputNoCard = card.querySelector(`input[data-test="lance"], input.cp-input-valor`);
        if (inputNoCard && inputNoCard.id === String(itemNumero)) {
          item.inputElement = inputNoCard;
          item.cardElement = card;
          break;
        }
      }
    }
  }

  if (!item.inputElement) {
    log(`Campo de lance não encontrado para item ${itemNumero}`);
    return { success: false, error: 'Campo de lance não encontrado' };
  }

  try {
    // Foca no campo
    item.inputElement.focus();
    await aguardar(100);

    // Limpa o campo
    item.inputElement.select();
    document.execCommand('delete');
    await aguardar(100);

    // Formata o valor (sem R$, com vírgula decimal)
    const valorFormatado = valor.toFixed(2).replace('.', ',');

    // Digita o valor
    for (const char of valorFormatado) {
      item.inputElement.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      document.execCommand('insertText', false, char);
      item.inputElement.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await aguardar(50);
    }

    // Dispara eventos
    item.inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    item.inputElement.dispatchEvent(new Event('change', { bubbles: true }));
    item.inputElement.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    await aguardar(300);

    log(`Valor ${valorFormatado} digitado no campo`);

    // Busca e clica no botão de enviar
    let btnEnviar = item.btnElement;

    if (!btnEnviar) {
      // Busca o elemento <u> com texto "Enviar lance" (padrão Comprasnet)
      const elementosU = document.querySelectorAll('u');
      for (const u of elementosU) {
        if (u.innerText.trim().toLowerCase() === 'enviar lance') {
          // O clicável pode ser o próprio <u> ou seu pai
          btnEnviar = u.closest('button') || u.parentElement || u;
          break;
        }
      }
    }

    if (!btnEnviar) {
      // Busca botão dentro do card
      const botoes = item.cardElement?.querySelectorAll('button, [role="button"]') || [];
      for (const btn of botoes) {
        const texto = btn.innerText.toLowerCase();
        if (texto.includes('enviar') || texto.includes('lance')) {
          btnEnviar = btn;
          break;
        }
      }
    }

    if (!btnEnviar) {
      // Busca botão globalmente
      const todosBtn = document.querySelectorAll('button, [role="button"]');
      for (const btn of todosBtn) {
        const texto = btn.innerText.toLowerCase();
        if (texto.includes('enviar lance')) {
          btnEnviar = btn;
          break;
        }
      }
    }

    if (btnEnviar && !btnEnviar.disabled) {
      btnEnviar.click();
      log(`Botão de lance clicado`);
      await aguardar(1000);

      // Verifica se houve erro
      const erros = document.querySelectorAll('.p-toast-message-error, .p-message-error, .alert-danger');
      for (const erro of erros) {
        if (erro.innerText.trim()) {
          log(`Erro detectado: ${erro.innerText}`);
          return { success: false, error: erro.innerText };
        }
      }

      // Verifica sucesso
      const sucessos = document.querySelectorAll('.p-toast-message-success, .p-toast-summary');
      for (const sucesso of sucessos) {
        if (sucesso.innerText.toLowerCase().includes('sucesso')) {
          log(`Lance enviado com sucesso!`);

          // Notifica servidor
          await notificarServidor('lance_enviado', {
            item: itemNumero,
            valor: valor,
            sucesso: true
          });

          return { success: true };
        }
      }

      // Se não encontrou erro nem sucesso, assume sucesso
      await notificarServidor('lance_enviado', {
        item: itemNumero,
        valor: valor,
        sucesso: true
      });

      return { success: true };

    } else {
      log(`Botão de enviar não encontrado ou desabilitado`);
      return { success: false, error: 'Botão de enviar não encontrado' };
    }

  } catch (e) {
    log(`Erro ao enviar lance: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ==================== COBERTURA AUTOMÁTICA ====================

async function cobrirLance(itemNumero) {
  const item = estadoDisputa.itens.find(i => i.numero === itemNumero);
  if (!item || !item.menorLance) {
    log(`Item ${itemNumero} sem lance para cobrir`);
    return { success: false, error: 'Sem lance para cobrir' };
  }

  // Verifica se já está em primeiro (ganhando)
  if (item.melhorClassificado && !item.perdendo) {
    log(`Item ${itemNumero} já está em primeiro lugar (${formatarMoeda(item.meuLance)})`);
    return { success: false, error: 'Já em primeiro lugar' };
  }

  // Se meu lance é igual ou menor que o melhor, não precisa cobrir
  if (item.meuLance && item.meuLance <= item.menorLance) {
    log(`Item ${itemNumero} já tem o melhor lance`);
    return { success: false, error: 'Já tem o melhor lance' };
  }

  const config = estadoDisputa.config;
  let novoLance;

  if (config.modo === 'valor') {
    novoLance = item.menorLance - config.cobertura;
  } else {
    novoLance = item.menorLance * (1 - config.cobertura / 100);
  }

  // Arredonda para 2 casas decimais
  novoLance = Math.round(novoLance * 100) / 100;

  // Verifica limite específico do item
  const limiteItem = estadoDisputa.limitesPorItem[itemNumero];
  if (limiteItem && novoLance < limiteItem) {
    log(`Item ${itemNumero}: Lance ${formatarMoeda(novoLance)} abaixo do limite ${formatarMoeda(limiteItem)} - NÃO COBRINDO`);
    notificarServidor('limite_atingido', {
      item: itemNumero,
      lanceCalculado: novoLance,
      limite: limiteItem,
      melhorLance: item.menorLance
    });
    return { success: false, error: `Abaixo do limite (${formatarMoeda(limiteItem)})` };
  }

  // Verifica limite global (fallback)
  if (config.minimo && novoLance < config.minimo) {
    log(`Item ${itemNumero}: Lance ${formatarMoeda(novoLance)} abaixo do mínimo global`);
    return { success: false, error: 'Abaixo do mínimo global' };
  }

  return await enviarLance(itemNumero, novoLance);
}

// ==================== MODO AUTOMÁTICO ====================

async function processarLancesAutomaticos() {
  if (!estadoDisputa.modoAutomatico) return;

  log('Processando lances automáticos...');

  // Atualiza lista de itens
  estadoDisputa.itens = extrairItensDisputa();

  for (const item of estadoDisputa.itens) {
    if (!estadoDisputa.modoAutomatico) break; // Verifica se ainda está ativo

    // Pula itens que já estão em primeiro
    if (item.melhorClassificado || item.posicao === 1) continue;

    // Pula itens sem lance para cobrir
    if (!item.menorLance) continue;

    // Tenta cobrir
    const resultado = await cobrirLance(item.numero);

    if (resultado.success) {
      // Aguarda intervalo entre lances
      await aguardar(estadoDisputa.config.intervalo);
    }
  }
}

// ==================== COMUNICAÇÃO COM SERVIDOR ====================

async function notificarServidor(tipo, dados) {
  try {
    await serverFetch(`${SERVER_URL}/api/lance/evento`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo,
        dados,
        compraId: estadoDisputa.compraId,
        timestamp: new Date().toISOString()
      })
    });
  } catch (e) {
    // Ignora erros de comunicação
  }
}

async function buscarConfiguracao() {
  try {
    const response = await serverFetch(`${SERVER_URL}/api/lance/config`);
    if (response.ok) {
      const result = await response.json();
      if (result.success && result.data) {
        const { modo, cobertura, minimo, automatico } = result.data;
        if (modo) estadoDisputa.config.modo = modo;
        if (cobertura) estadoDisputa.config.cobertura = cobertura;
        if (minimo !== undefined) estadoDisputa.config.minimo = minimo;
        if (automatico !== undefined) estadoDisputa.modoAutomatico = automatico;
        log(`Configuração carregada: modo=${estadoDisputa.config.modo}, cobertura=${estadoDisputa.config.cobertura}, auto=${estadoDisputa.modoAutomatico}`);
      }
    }
  } catch (e) {
    // Ignora erros
  }
}

async function enviarStatusParaServidor() {
  try {
    await serverFetch(`${SERVER_URL}/api/lance/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compraId: estadoDisputa.compraId,
        itens: estadoDisputa.itens.map(i => ({
          numero: i.numero,
          descricao: i.descricao,
          menorLance: i.menorLance,
          meuLance: i.meuLance,
          posicao: i.posicao,
          melhorClassificado: i.melhorClassificado
        })),
        ativo: estadoDisputa.ativo,
        automatico: estadoDisputa.modoAutomatico,
        timestamp: new Date().toISOString()
      })
    });
  } catch (e) {
    // Ignora erros
  }
}

// ==================== PAINEL FLUTUANTE ====================

function injetarPainel() {
  if (painelInjetado) return;

  const painel = document.createElement('div');
  painel.id = 'pncp-lances-painel';
  painel.innerHTML = `
    <style>
      #pncp-lances-painel {
        position: fixed;
        top: 10px;
        right: 10px;
        width: 320px;
        background: #16213e;
        border: 2px solid #4dabf7;
        border-radius: 12px;
        z-index: 999999;
        font-family: 'Segoe UI', sans-serif;
        color: #eee;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      }
      #pncp-lances-header {
        background: #0f3460;
        padding: 12px 15px;
        border-radius: 10px 10px 0 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: move;
      }
      #pncp-lances-header h3 {
        margin: 0;
        color: #4dabf7;
        font-size: 14px;
      }
      #pncp-lances-body {
        padding: 15px;
        max-height: 400px;
        overflow-y: auto;
      }
      .pncp-status {
        display: flex;
        justify-content: space-between;
        padding: 8px 0;
        border-bottom: 1px solid #0f3460;
      }
      .pncp-status:last-child { border-bottom: none; }
      .pncp-label { color: #888; font-size: 12px; }
      .pncp-value { font-weight: 600; }
      .pncp-value.verde { color: #4caf50; }
      .pncp-value.amarelo { color: #ff9800; }
      .pncp-value.vermelho { color: #f44336; }
      .pncp-btn {
        width: 100%;
        padding: 10px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 600;
        margin-top: 10px;
        transition: all 0.2s;
      }
      .pncp-btn-auto {
        background: #ff9800;
        color: #000;
      }
      .pncp-btn-auto.ativo {
        background: #4caf50;
        color: #fff;
      }
      .pncp-btn-minimizar {
        background: none;
        border: none;
        color: #888;
        cursor: pointer;
        font-size: 18px;
      }
      #pncp-lances-painel.minimizado #pncp-lances-body {
        display: none;
      }
      .pncp-itens-lista {
        max-height: 150px;
        overflow-y: auto;
        margin-top: 10px;
        background: #1a1a2e;
        border-radius: 6px;
        padding: 8px;
      }
      .pncp-item-linha {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 0;
        font-size: 11px;
        border-bottom: 1px solid #0f3460;
        gap: 5px;
      }
      .pncp-item-linha:last-child { border-bottom: none; }
      .pncp-item-info {
        flex: 1;
        display: flex;
        justify-content: space-between;
      }
      .pncp-limite-input {
        width: 70px;
        padding: 3px 5px;
        background: #0f3460;
        border: 1px solid #1a5f7a;
        border-radius: 3px;
        color: #fff;
        font-size: 10px;
        text-align: right;
      }
      .pncp-limite-input:focus {
        outline: none;
        border-color: #4dabf7;
      }
      .pncp-limite-input::placeholder {
        color: #666;
      }
    </style>
    <div id="pncp-lances-header">
      <h3>🎯 Lances PNCP</h3>
      <button class="pncp-btn-minimizar" onclick="document.getElementById('pncp-lances-painel').classList.toggle('minimizado')">_</button>
    </div>
    <div id="pncp-lances-body">
      <div class="pncp-status">
        <span class="pncp-label">Status</span>
        <span class="pncp-value" id="pncp-status-texto">Detectando...</span>
      </div>
      <div class="pncp-status">
        <span class="pncp-label">Tempo</span>
        <span class="pncp-value" id="pncp-tempo-restante">--:--</span>
      </div>
      <div class="pncp-status">
        <span class="pncp-label">Itens</span>
        <span class="pncp-value" id="pncp-itens-count">0</span>
      </div>
      <div class="pncp-status">
        <span class="pncp-label">Modo</span>
        <span class="pncp-value" id="pncp-modo-texto">Manual</span>
      </div>
      <div class="pncp-itens-lista" id="pncp-itens-lista">
        <!-- Itens serão inseridos aqui -->
      </div>
      <button class="pncp-btn pncp-btn-auto" id="pncp-btn-auto" onclick="window.toggleModoAutomatico()">
        Ativar Automático
      </button>
    </div>
  `;

  document.body.appendChild(painel);
  painelInjetado = true;

  // Torna o painel arrastável
  tornarArrastavel(painel);

  log('Painel de lances injetado');
}

function tornarArrastavel(elemento) {
  const header = elemento.querySelector('#pncp-lances-header');
  let isDragging = false;
  let offsetX, offsetY;

  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    offsetX = e.clientX - elemento.offsetLeft;
    offsetY = e.clientY - elemento.offsetTop;
  });

  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      elemento.style.left = (e.clientX - offsetX) + 'px';
      elemento.style.top = (e.clientY - offsetY) + 'px';
      elemento.style.right = 'auto';
    }
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });
}

function formatarTempo(segundos) {
  if (!segundos && segundos !== 0) return '--:--';
  const min = Math.floor(segundos / 60);
  const sec = segundos % 60;
  return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

function atualizarPainel() {
  const statusTexto = document.getElementById('pncp-status-texto');
  const tempoRestante = document.getElementById('pncp-tempo-restante');
  const itensCount = document.getElementById('pncp-itens-count');
  const modoTexto = document.getElementById('pncp-modo-texto');
  const itensLista = document.getElementById('pncp-itens-lista');
  const btnAuto = document.getElementById('pncp-btn-auto');

  if (!statusTexto) return;

  // Status
  if (estadoDisputa.ativo) {
    statusTexto.textContent = 'Em Disputa';
    statusTexto.className = 'pncp-value verde';
  } else {
    statusTexto.textContent = 'Aguardando';
    statusTexto.className = 'pncp-value amarelo';
  }

  // Tempo restante
  if (tempoRestante) {
    tempoRestante.textContent = formatarTempo(estadoDisputa.tempoRestante);
    // Cor baseada no tempo
    if (estadoDisputa.tempoRestante !== null) {
      if (estadoDisputa.tempoRestante <= 30) {
        tempoRestante.className = 'pncp-value vermelho';
      } else if (estadoDisputa.tempoRestante <= 60) {
        tempoRestante.className = 'pncp-value amarelo';
      } else {
        tempoRestante.className = 'pncp-value verde';
      }
    }
  }

  // Contagem de itens
  itensCount.textContent = estadoDisputa.itens.length;

  // Modo
  if (estadoDisputa.modoAutomatico) {
    modoTexto.textContent = 'Automático';
    modoTexto.className = 'pncp-value verde';
    btnAuto.textContent = 'Desativar Automático';
    btnAuto.classList.add('ativo');
  } else {
    modoTexto.textContent = 'Manual';
    modoTexto.className = 'pncp-value amarelo';
    btnAuto.textContent = 'Ativar Automático';
    btnAuto.classList.remove('ativo');
  }

  // Lista de itens
  let html = '';
  let ganhando = 0;
  let perdendo = 0;

  estadoDisputa.itens.forEach(item => {
    let statusIcon = '⚪';
    let valorClass = 'amarelo';

    if (item.melhorClassificado) {
      statusIcon = '✅';
      valorClass = 'verde';
      ganhando++;
    } else if (item.perdendo) {
      statusIcon = '❌';
      valorClass = 'vermelho';
      perdendo++;
    }

    const limiteAtual = estadoDisputa.limitesPorItem[item.numero] || '';

    html += `
      <div class="pncp-item-linha">
        <div class="pncp-item-info">
          <span>${statusIcon} ${item.numero}</span>
          <span class="${valorClass}">${item.menorLance ? formatarMoeda(item.menorLance) : '-'}</span>
        </div>
        <input type="text"
               class="pncp-limite-input"
               placeholder="Mín"
               value="${limiteAtual}"
               data-item="${item.numero}"
               onchange="window.definirLimiteItem(${item.numero}, this.value)"
               onclick="event.stopPropagation()"
               title="Limite mínimo para item ${item.numero}">
      </div>
    `;
  });

  // Resumo no topo da lista
  if (estadoDisputa.itens.length > 0) {
    const resumo = `<div style="text-align:center;padding:5px;border-bottom:1px solid #0f3460;margin-bottom:5px;">
      <span class="verde">✅ ${ganhando}</span> | <span class="vermelho">❌ ${perdendo}</span> | <span style="color:#888;">Mín:</span>
    </div>`;
    html = resumo + html;
  }

  itensLista.innerHTML = html || '<div style="color:#888;text-align:center;padding:10px;">Nenhum item</div>';
}

// Função global para toggle do modo automático
window.toggleModoAutomatico = function() {
  estadoDisputa.modoAutomatico = !estadoDisputa.modoAutomatico;
  log(`Modo automático: ${estadoDisputa.modoAutomatico ? 'ATIVADO' : 'DESATIVADO'}`);
  atualizarPainel();

  // Notifica servidor
  notificarServidor('modo_automatico', { ativo: estadoDisputa.modoAutomatico });

  // Se ativou, inicia processamento
  if (estadoDisputa.modoAutomatico) {
    processarLancesAutomaticos();
  }
};

// Função global para definir limite mínimo por item
window.definirLimiteItem = function(itemNumero, valor) {
  const valorNumerico = parseMoeda(valor) || parseFloat(valor.replace(',', '.'));

  if (valorNumerico && valorNumerico > 0) {
    estadoDisputa.limitesPorItem[itemNumero] = valorNumerico;
    log(`Limite do item ${itemNumero} definido: ${formatarMoeda(valorNumerico)}`);

    // Ativa modo automático automaticamente quando um limite é definido
    if (!estadoDisputa.modoAutomatico) {
      estadoDisputa.modoAutomatico = true;
      log(`✅ Modo automático ATIVADO (limite definido para item ${itemNumero})`);
      notificarServidor('modo_automatico', { ativo: true, motivo: 'limite_definido', item: itemNumero });
      atualizarPainel();
    }
  } else if (!valor || valor.trim() === '') {
    delete estadoDisputa.limitesPorItem[itemNumero];
    log(`Limite do item ${itemNumero} removido`);
  }

  // Salva no storage local para persistir
  salvarLimites();

  // Também salva no servidor para sincronizar com o sistema
  salvarLimitesServidor();
};

// Salva limites no storage local
function salvarLimites() {
  const chave = `limites_${estadoDisputa.compraId || 'default'}`;
  chrome.storage.local.set({ [chave]: estadoDisputa.limitesPorItem });
}

// Salva limites no servidor
async function salvarLimitesServidor() {
  if (!estadoDisputa.compraId) return;

  try {
    await serverFetch(`${SERVER_URL}/api/lance/limites/${estadoDisputa.compraId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limites: estadoDisputa.limitesPorItem })
    });
    log('Limites salvos no servidor');
  } catch (e) {
    // Ignora erros - o limite local já está salvo
  }
}

// Carrega limites do storage local
async function carregarLimitesLocal() {
  const chave = `limites_${estadoDisputa.compraId || 'default'}`;
  const result = await chrome.storage.local.get([chave]);
  if (result[chave]) {
    estadoDisputa.limitesPorItem = result[chave];
    log(`Limites locais carregados: ${Object.keys(estadoDisputa.limitesPorItem).length} itens`);
  }
}

// Carrega limites do servidor (propostas salvas)
async function carregarLimitesServidor() {
  if (!estadoDisputa.compraId) return;

  try {
    const response = await serverFetch(`${SERVER_URL}/api/lance/limites/${estadoDisputa.compraId}`);
    if (response.ok) {
      const result = await response.json();
      if (result.success && result.data && result.data.limites) {
        const limitesServidor = result.data.limites;
        const qtd = Object.keys(limitesServidor).length;

        if (qtd > 0) {
          // Mescla com limites locais (local tem prioridade se já existir)
          for (const [item, valor] of Object.entries(limitesServidor)) {
            if (!estadoDisputa.limitesPorItem[item]) {
              estadoDisputa.limitesPorItem[item] = valor;
            }
          }
          log(`Limites do servidor carregados: ${qtd} itens (das propostas salvas)`);

          // Salva localmente para cache
          salvarLimites();
        }
      }
    }
  } catch (e) {
    log(`Erro ao buscar limites do servidor: ${e.message}`);
  }
}

// Carrega limites (local + servidor)
async function carregarLimites() {
  // Primeiro carrega do storage local (cache)
  await carregarLimitesLocal();

  // Depois busca do servidor (propostas salvas) e mescla
  await carregarLimitesServidor();
}

// ==================== POLLING ====================

async function polling() {
  if (!estadoDisputa.ativo) return;

  // Busca configuração do servidor
  await buscarConfiguracao();

  // Extrai tempo restante
  extrairTempoRestante();

  // Extrai dados da página
  estadoDisputa.itens = extrairItensDisputa();

  // Atualiza painel
  atualizarPainel();

  // Envia status para servidor
  await enviarStatusParaServidor();

  // Processa lances automáticos se ativado
  if (estadoDisputa.modoAutomatico) {
    await processarLancesAutomaticos();
  }
}

function iniciarPolling() {
  if (pollingTimer) clearInterval(pollingTimer);

  // Polling a cada 3 segundos
  pollingTimer = setInterval(polling, 3000);
  log('Polling iniciado (3s)');
}

function pararPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  log('Polling parado');
}

// ==================== LISTENER DE MENSAGENS ====================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getStatus') {
    sendResponse({
      ativo: estadoDisputa.ativo,
      compraId: estadoDisputa.compraId,
      itens: estadoDisputa.itens.length,
      automatico: estadoDisputa.modoAutomatico
    });
    return true;
  }

  if (request.action === 'setConfig') {
    estadoDisputa.config = { ...estadoDisputa.config, ...request.config };
    log(`Configuração atualizada: ${JSON.stringify(request.config)}`);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'toggleAutomatico') {
    window.toggleModoAutomatico();
    sendResponse({ success: true, automatico: estadoDisputa.modoAutomatico });
    return true;
  }

  if (request.action === 'enviarLance') {
    enviarLance(request.item, request.valor).then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (request.action === 'cobrirLance') {
    cobrirLance(request.item).then(result => {
      sendResponse(result);
    });
    return true;
  }

  return true;
});

// ==================== INICIALIZAÇÃO ====================

async function inicializar() {
  const url = window.location.href;

  // Só executa no Comprasnet
  if (!url.includes('cnetmobile.estaleiro.serpro.gov.br')) return;

  // Não executa em páginas de login
  if (url.includes('/login') || url.includes('/acesso') || !url.includes('/seguro/')) {
    console.log('[Lances] Página de login detectada - extensão não ativada');
    return;
  }

  log('=== EXTENSÃO DE LANCES INICIADA ===');
  log('URL: ' + url);

  // Aguarda página carregar
  await aguardar(2000);

  // Registra presença passiva e inicia heartbeat
  registrarPresenca('aguardando');
  iniciarHeartbeat();

  // Detecta se é página de disputa
  if (detectarPaginaDisputa()) {
    // Tenta reivindicar a aba para disputa
    const conseguiu = await tentarReivindicar('disputa ativa');
    if (!conseguiu) {
      const atual = getExtensaoAtual();
      log(`[Aba] Ocupada por ${atual.nome} (${atual.operacao}) - abrindo nova aba para disputa`);

      // Abre nova aba com a mesma URL via background
      chrome.runtime.sendMessage({ action: 'abrirPagina', url: url });

      // Não continua nesta aba
      return;
    }

    // Aba reivindicada com sucesso

    estadoDisputa.ativo = true;
    estadoDisputa.compraId = extrairCompraId();

    log(`Disputa detectada! CompraId: ${estadoDisputa.compraId}`);

    // Extrai itens
    estadoDisputa.itens = extrairItensDisputa();
    log(`${estadoDisputa.itens.length} itens encontrados`);

    // Injeta painel
    injetarPainel();

    // Busca configuração
    await buscarConfiguracao();

    // Carrega limites salvos
    await carregarLimites();

    // IMPORTANTE: Ativa modo automático se existirem limites configurados
    const qtdLimites = Object.keys(estadoDisputa.limitesPorItem).length;
    if (qtdLimites > 0 && !estadoDisputa.modoAutomatico) {
      estadoDisputa.modoAutomatico = true;
      log(`✅ Modo automático ATIVADO automaticamente (${qtdLimites} limites configurados)`);
      notificarServidor('modo_automatico', { ativo: true, motivo: 'limites_configurados', qtd: qtdLimites });
    }

    // Inicia polling
    iniciarPolling();

    // Notifica servidor
    await notificarServidor('disputa_iniciada', {
      compraId: estadoDisputa.compraId,
      itens: estadoDisputa.itens.length
    });

  } else {
    log('Página não é de disputa, monitorando...');

    // Monitora se a página muda para disputa
    const observer = new MutationObserver(() => {
      if (detectarPaginaDisputa() && !estadoDisputa.ativo) {
        log('Disputa detectada via observer!');
        inicializar();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }
}

// Inicia quando DOM estiver pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', inicializar);
} else {
  inicializar();
}

// Também tenta após um delay (para páginas SPA)
setTimeout(inicializar, 3000);
