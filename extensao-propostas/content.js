// Propostas Comprasnet - Content Script v1.2
// Envia propostas automaticamente para licitacoes do Comprasnet
// Separado da extensao de monitoramento
// v1.2: Sistema de separação de abas - se aba ocupada, abre nova aba

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
const EXT_NAME = 'propostas';
const EXT_ATTR = 'data-pncp-ext-propostas';
const EXT_PRIORITY = 2; // lances=3, propostas=2, monitor=1, chrome=1
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

// Array para armazenar logs
const debugLogs = [];

function log(msg) {
  const timestamp = new Date().toLocaleTimeString();
  const fullMsg = '[' + timestamp + '] ' + msg;
  console.log('[Propostas Comprasnet] ' + msg);
  debugLogs.push(fullMsg);
}

  // ==================== CONTROLE DE PAUSE ====================
  let pausado = false;
  let pauseResolve = null;

  // Cria botão flutuante de pause/resume
  function criarBotaoPause() {
    if (document.getElementById('pncp-propostas-pause-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'pncp-propostas-pause-btn';
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
    const btn = document.getElementById('pncp-propostas-pause-btn');
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
  // NAO criar botao em paginas de login/captcha
  const urlAtual = window.location.href;
  const isPaginaSegura = urlAtual.includes('/seguro/') &&
                         !urlAtual.includes('/login') &&
                         !urlAtual.includes('/acesso') &&
                         !urlAtual.includes('govbr');

  if (isPaginaSegura) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', criarBotaoPause);
    } else {
      criarBotaoPause();
    }
    // Também tenta criar após um delay como fallback
    setTimeout(criarBotaoPause, 1000);
    setTimeout(criarBotaoPause, 3000);
  }


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

// Aguarda um tempo
async function aguardar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


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


// ==================== ENVIO DE PROPOSTA ====================

// Função auxiliar para aguardar elemento aparecer
async function aguardarElemento(seletor, timeout = 10000, contexto = document) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeout) {
    const elemento = contexto.querySelector(seletor);
    if (elemento) return elemento;
    await aguardar(500);
  }
  return null;
}

// Função auxiliar para clicar em elemento com retry
async function clicarElemento(seletor, descricao, timeout = 10000) {
  log(`Aguardando ${descricao}...`);
  const elemento = await aguardarElemento(seletor, timeout);
  if (elemento) {
    elemento.click();
    log(`Clicou em ${descricao}`);
    await aguardar(1000);
    return true;
  }
  log(`ERRO: ${descricao} não encontrado`);
  return false;
}

// ==================== VALIDAÇÃO DA PÁGINA ====================

async function validarPaginaCadastroProposta(compraIdEsperado) {
  const resultado = { valido: false, erro: '' };
  const MAX_TENTATIVAS = 10;
  const INTERVALO = 2000; // 2 segundos entre tentativas

  try {
    const urlAtual = window.location.href;

    // 1. Verifica se está na URL correta
    if (!urlAtual.includes('cadastro-propostas')) {
      resultado.erro = 'Não está na página de cadastro de propostas';
      return resultado;
    }

    // 2. Verifica se o compraId na URL corresponde ao esperado
    if (compraIdEsperado && !urlAtual.includes(compraIdEsperado)) {
      resultado.erro = `CompraId na URL não corresponde ao esperado (esperado: ${compraIdEsperado})`;
      return resultado;
    }

    // 3. Verifica se está em página de login (sessão expirada)
    if (urlAtual.includes('/login') || urlAtual.includes('/acesso') || urlAtual.includes('sso.acesso.gov.br')) {
      resultado.erro = 'Sessão expirada - redirecionado para página de login';
      return resultado;
    }

    // 4. Aguarda página carregar com retry - busca cards de itens
    log('Aguardando carregamento da lista de itens...');
    let cardsEncontrados = false;

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
      // Verifica se há erro na página
      const mensagensErro = document.querySelectorAll('.p-toast-message-error, .p-message-error, .alert-danger');
      for (const msg of mensagensErro) {
        const texto = (msg.innerText || '').toLowerCase();
        if (texto.includes('erro') || texto.includes('falha') || texto.includes('não encontrad') || texto.includes('expirad')) {
          resultado.erro = `Mensagem de erro detectada: ${msg.innerText.substring(0, 100)}`;
          return resultado;
        }
      }

      // Verifica se há modal de erro ou acesso negado
      const modais = document.querySelectorAll('.p-dialog, [role="dialog"], .modal');
      for (const modal of modais) {
        const textoModal = (modal.innerText || '').toLowerCase();
        if (textoModal.includes('acesso negado') || textoModal.includes('não autorizado') ||
            textoModal.includes('sessão expirada') || textoModal.includes('erro ao carregar')) {
          resultado.erro = `Modal de erro: ${modal.innerText.substring(0, 100)}`;
          return resultado;
        }
      }

      // Busca elementos da página
      const cardsItens = document.querySelectorAll('.cp-itens-card');
      const tabelaItens = document.querySelector('.p-datatable, table');
      const checkboxes = document.querySelectorAll('p-checkbox, input[type="checkbox"]');

      if (cardsItens.length > 0 || (tabelaItens && checkboxes.length > 0)) {
        cardsEncontrados = true;
        log(`Tentativa ${tentativa}/${MAX_TENTATIVAS}: Página carregada! (${cardsItens.length} cards ou tabela encontrada)`);
        break;
      }

      log(`Tentativa ${tentativa}/${MAX_TENTATIVAS}: Aguardando... (cards: ${cardsItens.length})`);
      await aguardar(INTERVALO);
    }

    if (!cardsEncontrados) {
      resultado.erro = `Página não carregou após ${MAX_TENTATIVAS} tentativas (${MAX_TENTATIVAS * INTERVALO / 1000}s) - verifique conexão ou sessão`;
      return resultado;
    }

    // 5. Verifica se há botões de ação
    const botoes = document.querySelectorAll('button, .br-button');
    if (botoes.length === 0) {
      log('AVISO: Nenhum botão encontrado na página');
    }

    // Tudo OK!
    resultado.valido = true;
    const totalCards = document.querySelectorAll('.cp-itens-card').length;
    log('✓ Validação completa - Itens encontrados: ' + totalCards);
    return resultado;

  } catch (e) {
    resultado.erro = 'Erro ao validar página: ' + e.message;
    return resultado;
  }
}

// Função principal de envio de proposta
async function enviarPropostaComprasnet(dados) {
  // Tenta reivindicar a aba para envio de proposta
  const conseguiu = await tentarReivindicar('enviar proposta');
  if (!conseguiu) {
    const atual = getExtensaoAtual();
    log(`[Aba] Ocupada por ${atual.nome} (${atual.operacao}) - abrindo nova aba`);

    // Abre nova aba para enviar proposta via background
    const urlProposta = `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/cadastro-propostas?compra=${dados.compraId}`;
    chrome.runtime.sendMessage({ action: 'abrirPagina', url: urlProposta });

    // Salva dados para a nova aba continuar
    await chrome.storage.local.set({
      envioPropostaEmAndamento: true,
      dadosPropostaAtual: dados
    });

    return { success: true, status: 'nova_aba', message: 'Abrindo nova aba para enviar proposta' };
  }

  const { uasg, numeroCompra, itens, compraId } = dados;

  log('=== INICIANDO ENVIO DE PROPOSTA ===');
  log(`UASG: ${uasg}, Número: ${numeroCompra}, CompraId: ${compraId}`);
  log(`Itens: ${JSON.stringify(itens)}`);

  try {
    // Passo 1: Verifica se está na página correta ou navega
    const urlAtual = window.location.href;
    const urlCadastroProposta = `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/cadastro-propostas?compra=${compraId}`;

    if (!urlAtual.includes('cadastro-propostas')) {
      log('Navegando para página de cadastro de propostas...');
      window.location.href = urlCadastroProposta;

      // Salva estado para continuar após navegação
      await chrome.storage.local.set({
        envioPropostaEmAndamento: true,
        dadosPropostaAtual: dados
      });

      return { success: true, status: 'navegando', message: 'Navegando para página de propostas...' };
    }

    // Passo 2: Aguarda página carregar
    log('Aguardando página carregar...');
    await aguardar(3000);

    // ========== VALIDAÇÃO DA PÁGINA ==========
    log('Passo 2.5: Validando se está na página correta...');

    const validacao = await validarPaginaCadastroProposta(compraId);
    if (!validacao.valido) {
      log('✗✗✗ ERRO: Página inválida - ' + validacao.erro);
      mostrarNotificacao('ERRO: ' + validacao.erro, 'error');

      // Limpa estado
      await chrome.storage.local.set({
        envioPropostaEmAndamento: false,
        dadosPropostaAtual: null
      });

      // Notifica servidor do erro
      await serverFetch(`${SERVER_URL}/api/proposta/resultado`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          erro: validacao.erro,
          compraId,
          uasg,
          numeroCompra,
          timestamp: new Date().toISOString()
        })
      }).catch(() => {});

      return { success: false, error: validacao.erro };
    }

    log('✓ Página validada com sucesso!');
    // ==========================================

    // Passo 3: Marca o primeiro checkbox (aceite inicial)
    log('Passo 3: Marcando checkbox de aceite inicial...');
    const checkboxAceite = await aguardarElemento('p-checkbox input[type="checkbox"], .p-checkbox-box, input[type="checkbox"]', 10000);
    if (checkboxAceite) {
      // Se é um p-checkbox do PrimeNG, clica no label/box
      const pCheckboxBox = checkboxAceite.closest('p-checkbox')?.querySelector('.p-checkbox-box') || checkboxAceite;
      if (!pCheckboxBox.classList.contains('p-checkbox-checked') && !checkboxAceite.checked) {
        pCheckboxBox.click();
        log('Checkbox de aceite marcado');
        await aguardar(1500);
      } else {
        log('Checkbox de aceite já estava marcado');
      }
    } else {
      log('AVISO: Checkbox de aceite não encontrado, continuando...');
    }

    // Passo 4: Aguarda popup de declarações e marca o primeiro checkbox
    log('Passo 4: Verificando popup de declarações...');
    await aguardar(2000);

    const dialog = await aguardarElemento('.p-dialog, [role="dialog"], .modal.show', 5000);
    if (dialog) {
      log('Popup de declarações encontrado');

      // Marca apenas o primeiro checkbox do popup (aceite das declarações)
      const primeiroCheckbox = dialog.querySelector('.p-checkbox-box');
      if (primeiroCheckbox && !primeiroCheckbox.classList.contains('p-highlight')) {
        primeiroCheckbox.click();
        log('Checkbox de declarações marcado');
        await aguardar(500);
      } else if (primeiroCheckbox) {
        log('Checkbox de declarações já estava marcado');
      } else {
        log('AVISO: Checkbox de declarações não encontrado');
      }

      // Passo 5: Clica em Confirmar
      log('Passo 5: Clicando em Confirmar...');
      await aguardar(1000);

      // Busca botão por texto "Confirmar"
      let btnConfirmar = null;
      const botoes = dialog.querySelectorAll('button');
      for (const btn of botoes) {
        if (btn.innerText?.toLowerCase().includes('confirmar')) {
          btnConfirmar = btn;
          break;
        }
      }

      // Fallback para seletores comuns
      if (!btnConfirmar) {
        btnConfirmar = dialog.querySelector('button.br-button.is-primary, button[type="submit"]');
      }

      if (btnConfirmar) {
        btnConfirmar.click();
        log('Clicou em Confirmar');
        await aguardar(2000);
      } else {
        log('AVISO: Botão Confirmar não encontrado');
      }
    } else {
      log('Popup de declarações não apareceu, continuando...');
    }

    // Passo 6: Seleciona radio button EPP (não excedeu faturamento)
    log('Passo 6: Selecionando opção EPP...');
    await aguardar(1500);

    // Procura por radio buttons relacionados a ME/EPP
    const radioButtons = document.querySelectorAll('p-radiobutton, input[type="radio"]');
    for (const radio of radioButtons) {
      const label = radio.closest('label, div')?.innerText?.toLowerCase() || '';
      const parentText = radio.parentElement?.innerText?.toLowerCase() || '';

      // Procura por opção que indica NÃO excedeu o limite (geralmente a segunda opção)
      if (label.includes('não') || label.includes('nao') || parentText.includes('não excedeu') || parentText.includes('nao excedeu')) {
        const radioBox = radio.querySelector('.p-radiobutton-box') || radio;
        if (!radioBox.classList.contains('p-radiobutton-checked')) {
          radioBox.click();
          log('Selecionou opção EPP (não excedeu limite)');
          await aguardar(1000);
        }
        break;
      }
    }

    // Passo 6.5: Verifica declarações extras (programa de integridade, ME/EPP, etc)
    log('Passo 6.5: Verificando declarações extras...');
    await aguardar(500);

    // IMPORTANTE: Marcar "Sim" para declaração ME/EPP (declara que É ME/EPP e cumpre requisitos)
    const btnSimMeEpp = document.querySelector('[data-test="btn-declarar-sim-meepp"]');
    if (btnSimMeEpp) {
      const radioBox = btnSimMeEpp.querySelector('.p-radiobutton-box');
      if (radioBox && !radioBox.classList.contains('p-highlight') && !radioBox.classList.contains('p-radiobutton-checked')) {
        radioBox.click();
        log('Clicou em "Sim" para declaração ME/EPP');
        await aguardar(500);
      } else {
        log('Declaração ME/EPP já está marcada como "Sim"');
      }
    }

    // Procura pelo radio button "Não" de programa de integridade
    const btnNaoIntegridade = document.querySelector('[data-test="btn-declarar-nao-programaintegridade"]');
    if (btnNaoIntegridade) {
      const radioBox = btnNaoIntegridade.querySelector('.p-radiobutton-box');
      if (radioBox && !radioBox.classList.contains('p-highlight') && !radioBox.classList.contains('p-radiobutton-checked')) {
        radioBox.click();
        log('Clicou em "Não" para declaração de programa de integridade');
        await aguardar(500);
      }
    }

    // Verifica se há outras declarações com opção "Não" que precisam ser marcadas
    // EXCETO ME/EPP que já foi marcado como "Sim"
    const declaracoesNao = document.querySelectorAll('[data-test*="btn-declarar-nao"]');
    for (const declaracao of declaracoesNao) {
      const dataTest = declaracao.getAttribute('data-test');
      // Pular ME/EPP - já foi marcado como "Sim"
      if (dataTest && dataTest.includes('meepp')) {
        log('Pulando ' + dataTest + ' - ME/EPP deve ser "Sim"');
        continue;
      }
      const radioBox = declaracao.querySelector('.p-radiobutton-box');
      if (radioBox && !radioBox.classList.contains('p-highlight') && !radioBox.classList.contains('p-radiobutton-checked')) {
        radioBox.click();
        log('Clicou em "Não" para declaração: ' + dataTest);
        await aguardar(300);
      }
    }

    // Passo 7: Processa cada item
    log('Passo 7: Processando itens...');
    mostrarBotaoPause(true);
    await aguardar(1500);


    // Função auxiliar para tratar modais de confirmação
    const tratarModalConfirmacao = async () => {
      await aguardar(500);

      // Procura por modais/dialogs de confirmação
      const modais = document.querySelectorAll('.p-dialog, .p-confirm-dialog, [role="dialog"], .modal, .p-dialog-content');

      for (const modal of modais) {
        const textoModal = modal.innerText || '';

        // Verifica se é um modal de confirmação de salvamento
        if (textoModal.includes('salvar as alterações') ||
            textoModal.includes('Deseja salvar') ||
            textoModal.includes('foi modificada')) {

          log('Modal de confirmação detectado: ' + textoModal.substring(0, 100));

          // Procura botão "Sim" no modal
          const botoesModal = modal.querySelectorAll('button, .p-button');
          for (const btn of botoesModal) {
            const textoBtn = (btn.innerText || '').toLowerCase().trim();
            if (textoBtn === 'sim' || textoBtn.includes('sim')) {
              btn.click();
              log('Clicou em "Sim" no modal de confirmação');
              await aguardar(2000);
              return true;
            }
          }

          // Tenta também pelo seletor de botão de aceitar do PrimeNG
          const btnAceitar = modal.querySelector('.p-confirm-dialog-accept, .p-button-success, button[class*="accept"]');
          if (btnAceitar) {
            btnAceitar.click();
            log('Clicou no botão de aceitar do modal');
            await aguardar(2000);
            return true;
          }
        }
      }

      // Também verifica fora do modal (botões soltos)
      const btnSimGlobal = document.querySelector('.p-confirm-dialog-accept, button[data-test*="sim"]');
      if (btnSimGlobal && btnSimGlobal.offsetParent !== null) {
        btnSimGlobal.click();
        log('Clicou em botão Sim global');
        await aguardar(2000);
        return true;
      }

      return false;
    };

    // Contadores de sucesso/erro
    let itensSalvos = 0;
    let itensComErro = [];

    for (const item of itens) {
      const numeroItem = item.numero || item.item;
      log(`Processando item ${numeroItem}`);
      await verificarPause('Antes de processar item ' + numeroItem);

      // Função auxiliar para encontrar item na página atual
      // Estrutura do Comprasnet: div.cp-itens-card contém o card do item
      // O número do item está em div.dots.cp-item-bold
      // O botão de expandir é button[data-test="btn-expandir-proposta"]
      const encontrarItemNaPagina = () => {
        log('DEBUG: Buscando item ' + numeroItem + ' na pagina...');

        const cardsItens = document.querySelectorAll('.cp-itens-card');
        log('DEBUG: Total de cards .cp-itens-card: ' + cardsItens.length);

        // ABORDAGEM PRINCIPAL: Busca pelo elemento .dots.cp-item-bold que contém APENAS o número do item
        // Esse elemento tem formato "4 Placa Sinalizadora" onde 4 é o número do item
        // Isso evita confusão com "Quantidade solicitada 10" em outros lugares do card
        const elementosNumero = document.querySelectorAll('.dots.cp-item-bold');
        log('DEBUG: Elementos .dots.cp-item-bold: ' + elementosNumero.length);

        for (const elem of elementosNumero) {
          const texto = (elem.innerText || '').trim();
          // O número do item deve estar no INÍCIO do texto (ex: "10 Notebook" ou " 10 Notebook")
          // Regex: início opcional de espaços, número exato, espaço obrigatório
          const regexNumeroInicio = new RegExp(`^\\s*${numeroItem}\\s`, 'i');
          if (regexNumeroInicio.test(texto)) {
            log('DEBUG: MATCH em .dots.cp-item-bold: "' + texto.substring(0, 50) + '"');
            const card = elem.closest('.cp-itens-card');
            if (card) {
              log('DEBUG: Card pai encontrado via .dots.cp-item-bold');
              return card;
            }
          }
        }

        // FALLBACK 1: Busca em elementos .dots ou .cp-item-bold separados
        const elementosNumeroAlt = document.querySelectorAll('.dots, .cp-item-bold, [class*="item-bold"]');
        log('DEBUG: Fallback - Elementos .dots/.cp-item-bold: ' + elementosNumeroAlt.length);

        for (const elem of elementosNumeroAlt) {
          const texto = (elem.innerText || '').trim();
          // Número deve estar no início
          const regexNumeroInicio = new RegExp(`^\\s*${numeroItem}\\s`, 'i');
          if (regexNumeroInicio.test(texto)) {
            log('DEBUG: Fallback MATCH em .dots: "' + texto.substring(0, 50) + '"');
            const card = elem.closest('.cp-itens-card');
            if (card) {
              log('DEBUG: Card pai encontrado via fallback');
              return card;
            }
          }
        }

        // FALLBACK 2: Busca por texto direto em divs (último recurso)
        const todosElementos = document.querySelectorAll('div');
        for (const elem of todosElementos) {
          const textoDirecto = Array.from(elem.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent.trim())
            .join(' ')
            .trim();

          // Número deve estar no INÍCIO do texto direto
          if (textoDirecto.match(new RegExp(`^\\s*${numeroItem}\\s`))) {
            log('DEBUG: Fallback2 MATCH: "' + textoDirecto.substring(0, 30) + '"');
            const card = elem.closest('.cp-itens-card') || elem.closest('[class*="card"]');
            if (card) return card;
          }
        }

        log('DEBUG: Item ' + numeroItem + ' NAO encontrado');
        return null;
      };

      let linhaItem = encontrarItemNaPagina();

      // Se não encontrou, navega pelas páginas
      if (!linhaItem) {
        log(`Item ${numeroItem} não está na página atual, navegando...`);

        // Verifica se há paginador
        const paginador = document.querySelector('.p-paginator, [class*="paginator"]');
        if (paginador) {
          // Primeiro, volta para a primeira página
          const btnPrimeira = document.querySelector('.p-paginator-first:not(.p-disabled)');
          if (btnPrimeira) {
            btnPrimeira.click();
            await aguardar(2000);
            linhaItem = encontrarItemNaPagina();
          }

          // Navega pelas páginas até encontrar o item
          let tentativas = 0;
          const maxTentativas = 20; // máximo de 20 páginas

          while (!linhaItem && tentativas < maxTentativas) {
            const btnProxima = document.querySelector('.p-paginator-next:not(.p-disabled)');
            if (!btnProxima) {
              log('Não há mais páginas para navegar');
              break;
            }

            btnProxima.click();
            await aguardar(2000);
            tentativas++;

            linhaItem = encontrarItemNaPagina();
            if (linhaItem) {
              log(`Item ${numeroItem} encontrado na página ${tentativas + 1}`);
            }
          }
        }
      }

      if (!linhaItem) {
        log(`ERRO: Item ${numeroItem} não encontrado em nenhuma página!`);
        continue; // Pula para o próximo item
      }

      log(`Encontrou card do item ${numeroItem}`);

      // Expande o item clicando no botão de expandir
      // No Comprasnet o botão é: button[data-test="btn-expandir-proposta"]
      let btnExpandir = linhaItem.querySelector('button[data-test="btn-expandir-proposta"]');

      if (!btnExpandir) {
        // Fallback: busca por ícone chevron
        btnExpandir = linhaItem.querySelector('.fa-chevron-down, .fa-chevron-up');
        if (btnExpandir) {
          // Se encontrou o ícone, pega o botão pai
          btnExpandir = btnExpandir.closest('button') || btnExpandir;
        }
      }

      if (!btnExpandir) {
        log('DEBUG: Botao expandir nao encontrado no card');
        // Tenta buscar qualquer botão dentro do card
        btnExpandir = linhaItem.querySelector('button.br-button');
      }

      if (btnExpandir) {
        log('DEBUG: Botao expandir encontrado: ' + (btnExpandir.getAttribute('data-test') || btnExpandir.className.substring(0, 30)));
      } else {
        log('DEBUG: ERRO - Nenhum botao de expandir encontrado!');
      }

      // Área expandida do item (será preenchida após clicar no botão)
      let areaExpandida = null;

      if (btnExpandir) {
        // Rola até o card antes de clicar
        linhaItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await aguardar(500);

        btnExpandir.click();
        log(`Clicou para expandir item ${numeroItem}`);

        // Aguarda e verifica se expandiu (campo de valor apareceu)
        await aguardar(2000);

        // Verifica se o campo de valor apareceu DENTRO DO CARD - se não, tenta clicar novamente
        let campoValorVisivel = linhaItem.querySelector('input[data-test="input-valor-proposta"]');
        if (!campoValorVisivel) {
          log('DEBUG: Campo de valor nao apareceu no card, tentando clicar novamente...');
          btnExpandir.click();
          await aguardar(2000);
          campoValorVisivel = linhaItem.querySelector('input[data-test="input-valor-proposta"]');
          log('DEBUG: Campo apos segundo clique: ' + (campoValorVisivel ? 'SIM' : 'NAO'));
        }

        log(`Expandiu item ${numeroItem}`);
        await verificarPause('Apos expandir item ' + numeroItem);
        await aguardar(1500);

        // Encontra a área expandida do item específico
        // A área expandida geralmente aparece logo após a linha do item na tabela

        // Método 1: Busca pelo próximo TR que seja uma expansão
        if (linhaItem) {
          let proximo = linhaItem.nextElementSibling;
          while (proximo) {
            // Verifica se é uma linha de expansão
            if (proximo.classList.contains('p-datatable-row-expansion') ||
                proximo.querySelector('.cp-texto-item') ||
                proximo.querySelector('.cp-valor-item')) {
              areaExpandida = proximo;
              log('Área expandida encontrada como próximo irmão');
              break;
            }
            // Se encontrou outra linha de dados, para
            if (proximo.classList.contains('p-datatable-row') || proximo.querySelector('[class*="chevron"]')) {
              break;
            }
            proximo = proximo.nextElementSibling;
          }
        }

        // Método 2: Busca pela última área de expansão visível
        if (!areaExpandida) {
          const areasExpansao = document.querySelectorAll('tr.p-datatable-row-expansion, [class*="row-expansion"], [class*="expanded"]');
          log(`Encontradas ${areasExpansao.length} áreas de expansão na página`);
          if (areasExpansao.length > 0) {
            areaExpandida = areasExpansao[areasExpansao.length - 1];
            log('Usando última área de expansão encontrada');
          }
        }

        // Método 3: Busca container que tenha .cp-texto-item com "Valor estimado" para o item correto
        if (!areaExpandida) {
          // Procura todos os containers com valor estimado
          const todosLabels = document.querySelectorAll('.cp-texto-item');
          for (const label of todosLabels) {
            const texto = (label.innerText || '').toLowerCase();
            if (texto.includes('valor estimado')) {
              // Verifica se esse label pertence ao item correto
              const container = label.closest('tr, div[class*="row"], div[class*="item"]');
              if (container) {
                areaExpandida = container.parentElement || container;
                log('Área expandida encontrada via label de valor estimado');
                break;
              }
            }
          }
        }

        log(`Área expandida encontrada: ${areaExpandida ? 'sim' : 'não'}`);
      } else {
        log('AVISO: Chevron não encontrado');
      }

      // USA SEMPRE O VALOR PASSADO PELO SERVIDOR
      // O servidor busca o valor correto do item no banco de dados do PNCP
      // Não confiar no valor da página pois pode pegar de outro item
      const valorServidor = item.valor;
      const valorNum = parseFloat(valorServidor || 0);
      const valorFinal = valorNum.toFixed(2).replace('.', ',');

      log(`>>> VALOR DO SERVIDOR: ${valorServidor} -> VALOR FINAL: ${valorFinal} <<<`);

      // Aguarda mais um pouco para garantir que a área expandiu
      await aguardar(1500);

      // Preenche o valor - busca o campo DENTRO DO CARD ESPECÍFICO
      log('DEBUG: Buscando campo de valor dentro do card...');

      // Primeiro busca dentro do card do item (linhaItem)
      let inputValor = linhaItem.querySelector('input[data-test="input-valor-proposta"]');

      if (inputValor) {
        log('DEBUG: Campo encontrado dentro do card');
      } else {
        // Se não encontrou no card, aguarda e tenta novamente
        log('DEBUG: Campo nao encontrado no card, aguardando...');
        await aguardar(2000);
        inputValor = linhaItem.querySelector('input[data-test="input-valor-proposta"]');
      }

      // Se ainda não encontrou, busca globalmente (fallback)
      if (!inputValor) {
        log('DEBUG: Tentando busca global...');
        inputValor = document.querySelector('input[data-test="input-valor-proposta"]');
      }

      // Verifica se o campo encontrado está visível
      if (inputValor) {
        const rect = inputValor.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          log('DEBUG: Campo encontrado mas nao visivel!');
          inputValor = null;
        }
      }

      log('DEBUG: Campo de valor encontrado: ' + (inputValor ? 'SIM' : 'NAO'));
      if (inputValor) {
        const valorStr = String(valorFinal);
        log('Valor a inserir: ' + valorStr);

        // A máscara do Comprasnet tem 4 casas decimais FIXAS (sempre ,0000)
        // Então devemos digitar apenas a parte INTEIRA do valor
        // Valor "32861,33" -> digitar: 32861 (máscara vai formatar como 32.861,0000)
        const parteInteira = valorStr.split(',')[0].replace(/\./g, '');
        log('Digitos a digitar (parte inteira): ' + parteInteira);

        // Função para simular digitação - aceita dígitos E vírgula
        const digitarLento = async (input, caracteres) => {
          input.focus();
          input.click();
          await aguardar(300);

          // Seleciona tudo e apaga com Backspace
          input.select();
          await aguardar(100);
          for (let i = 0; i < 15; i++) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', keyCode: 8, bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', keyCode: 8, bubbles: true }));
          }
          await aguardar(300);

          // Digita cada caracter (dígitos e vírgula)
          for (let i = 0; i < caracteres.length; i++) {
            const char = caracteres[i];
            let key, code, keyCode;

            if (char === ',') {
              // Vírgula - separador decimal
              key = ',';
              code = 'Comma';
              keyCode = 188;
            } else {
              // Dígito
              key = char;
              code = 'Digit' + char;
              keyCode = 48 + parseInt(char);
            }

            // Eventos de teclado completos
            input.dispatchEvent(new KeyboardEvent('keydown', {
              key: key, code: code, keyCode: keyCode, which: keyCode,
              bubbles: true, cancelable: true
            }));

            input.dispatchEvent(new KeyboardEvent('keypress', {
              key: key, code: code, keyCode: keyCode, charCode: keyCode, which: keyCode,
              bubbles: true, cancelable: true
            }));

            // beforeinput - importante para máscaras Angular
            input.dispatchEvent(new InputEvent('beforeinput', {
              data: char,
              inputType: 'insertText',
              bubbles: true,
              cancelable: true
            }));

            // input event
            input.dispatchEvent(new InputEvent('input', {
              data: char,
              inputType: 'insertText',
              bubbles: true
            }));

            input.dispatchEvent(new KeyboardEvent('keyup', {
              key: key, code: code, keyCode: keyCode, which: keyCode,
              bubbles: true
            }));

            await aguardar(200);
            log('Digitou: ' + char + ' -> Campo: ' + input.value);
          }

          // Tab para sair do campo (como usuário faria)
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, bubbles: true }));
          input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await aguardar(500);

          return input.value;
        };

        // Tenta o método de digitação lenta
        log('Tentando digitacao lenta...');
        let resultado = await digitarLento(inputValor, parteInteira);
        log('Resultado digitacao: "' + resultado + '"');

        // Se não funcionou, tenta com execCommand
        if (!resultado || resultado === '0,00' || parseFloat(resultado.replace(/[^\d,]/g,'').replace(',','.')) < 1) {
          log('Digitacao falhou, tentando execCommand...');

          inputValor.focus();
          inputValor.click();
          await aguardar(200);
          inputValor.select();
          document.execCommand('delete');
          await aguardar(200);

          for (const d of parteInteira) {
            document.execCommand('insertText', false, d);
            await aguardar(150);
          }

          inputValor.dispatchEvent(new Event('change', { bubbles: true }));
          inputValor.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          await aguardar(500);

          resultado = inputValor.value;
          log('Resultado execCommand: "' + resultado + '"');
        }

        // Se ainda não funcionou, tenta setter nativo
        if (!resultado || resultado === '0,00' || parseFloat(resultado.replace(/[^\d,]/g,'').replace(',','.')) < 1) {
          log('execCommand falhou, tentando setter nativo...');

          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

          inputValor.focus();
          await aguardar(100);

          // Tenta com valor formatado
          setter.call(inputValor, valorStr);
          inputValor.dispatchEvent(new Event('input', { bubbles: true }));
          inputValor.dispatchEvent(new Event('change', { bubbles: true }));
          inputValor.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          await aguardar(500);

          resultado = inputValor.value;
          log('Resultado setter: "' + resultado + '"');
        }

        await verificarPause('Apos preencher valor item ' + numeroItem);
        log('>>> VALOR FINAL: "' + resultado + '" <<<');

        await aguardar(500);
      } else {
        log('ERRO: Campo de valor nao encontrado');
      }

      // Preenche campos Marca/Fabricante e Modelo/Versão se estiverem habilitados (para produtos)
      const inputMarca = document.querySelector('input[data-test="input-marca-fabricante"]');
      if (inputMarca && !inputMarca.disabled) {
        inputMarca.focus();
        inputMarca.value = 'Conforme Edital';
        inputMarca.dispatchEvent(new Event('input', { bubbles: true }));
        inputMarca.dispatchEvent(new Event('change', { bubbles: true }));
        inputMarca.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        log('Campo Marca/Fabricante preenchido com "Conforme Edital"');
        await aguardar(300);
      }

      const inputModelo = document.querySelector('input[data-test="input-modelo-versao"]');
      if (inputModelo && !inputModelo.disabled) {
        inputModelo.focus();
        inputModelo.value = 'Conforme Edital';
        inputModelo.dispatchEvent(new Event('input', { bubbles: true }));
        inputModelo.dispatchEvent(new Event('change', { bubbles: true }));
        inputModelo.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        log('Campo Modelo/Versão preenchido com "Conforme Edital"');
        await aguardar(300);
      }

      // Verificação simplificada: só verifica se o campo ficou zerado
      log('Verificando se valor foi preenchido...');
      await aguardar(500);

      const inputVerifica = linhaItem.querySelector('input[data-test="input-valor-proposta"]');
      if (inputVerifica) {
        const valorNoInput = inputVerifica.value || '';
        const valorNumerico = parseFloat(valorNoInput.replace(/\./g, '').replace(',', '.')) || 0;

        if (valorNumerico < 1) {
          log('AVISO: Valor parece zerado (' + valorNoInput + '), tentando preencher novamente...');
          // Tenta preencher novamente
          const digitosRetry = parteInteira;
          inputVerifica.focus();
          inputVerifica.select();
          document.execCommand('delete', false);
          await aguardar(200);
          for (const dig of digitosRetry) {
            document.execCommand('insertText', false, dig);
            await aguardar(100);
          }
          inputVerifica.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          await aguardar(500);
        } else {
          log('Valor preenchido: ' + valorNoInput + ' - OK');
        }
      }

      await verificarPause('Pronto para salvar item ' + numeroItem);

      // Passo 8: Clica em Salvar
      await verificarPause('Antes de salvar item ' + numeroItem);
      log('Passo 8: Clicando em Salvar...');
      await aguardar(500);

      let btnSalvar = null;
      const botoes = document.querySelectorAll('button.br-button, button');
      for (const btn of botoes) {
        if (btn.innerText && btn.innerText.toLowerCase().includes('salvar')) {
          btnSalvar = btn;
          break;
        }
      }
      // Fallback para seletores
      if (!btnSalvar) {
        btnSalvar = document.querySelector('button.mini.br-button, button[class*="salvar"], button[aria-label*="Salvar"]');
      }

      if (btnSalvar) {
        btnSalvar.click();
        log('Clicou em Salvar');
        await aguardar(2000);

        // Trata modal de confirmação se aparecer
        await tratarModalConfirmacao();
        await aguardar(2000);

        // VERIFICAÇÃO: Confirma sucesso por toast de sucesso OU lixeira
        let propostaSalva = false;
        let tentativasVerificacao = 0;
        const maxTentativasVerificacao = 5;

        while (!propostaSalva && tentativasVerificacao < maxTentativasVerificacao) {
          tentativasVerificacao++;
          log(`Verificacao ${tentativasVerificacao}/${maxTentativasVerificacao}: Procurando confirmacao de salvamento...`);

          // MÉTODO 1: Verifica toast de sucesso "Operação realizada com sucesso!"
          const toastsSucesso = document.querySelectorAll('.p-toast-summary, .p-toast-message-success, .p-toast-detail');
          for (const toast of toastsSucesso) {
            const textoToast = (toast.innerText || '').toLowerCase();
            if (textoToast.includes('sucesso') || textoToast.includes('realizada')) {
              propostaSalva = true;
              log(`✓ Item ${numeroItem}: TOAST DE SUCESSO ENCONTRADO - PROPOSTA SALVA!`);
              break;
            }
          }

          // MÉTODO 2: Busca o icone de lixeira EXATO: i.fa-trash-alt.far
          if (!propostaSalva && linhaItem) {
            const lixeiraNoCard = linhaItem.querySelector('i.fa-trash-alt.far');
            if (lixeiraNoCard) {
              const rect = lixeiraNoCard.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                propostaSalva = true;
                log(`✓ Item ${numeroItem}: LIXEIRA ENCONTRADA NO CARD - PROPOSTA SALVA!`);
              }
            }
          }

          // MÉTODO 3: Busca lixeira na pagina toda
          if (!propostaSalva) {
            const todasLixeiras = document.querySelectorAll('i.fa-trash-alt.far');
            for (const lixeira of todasLixeiras) {
              const rect = lixeira.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                const container = lixeira.closest('.cp-itens-card, tr, [class*="item"], [class*="row"]');
                if (container) {
                  const textoContainer = container.innerText || '';
                  const regexItem = new RegExp(`(^|\\s)${numeroItem}\\s`, 'im');
                  if (regexItem.test(textoContainer)) {
                    propostaSalva = true;
                    log(`✓ Item ${numeroItem}: LIXEIRA ENCONTRADA - PROPOSTA SALVA!`);
                    break;
                  }
                }
              }
            }
          }

          if (!propostaSalva) {
            log(`Confirmacao nao encontrada ainda, aguardando... (tentativa ${tentativasVerificacao})`);
            await aguardar(1500);
          }
        }

        // Verifica mensagens de erro explicitas
        const mensagensErro = document.querySelectorAll('.p-toast-message-error, .p-message-error, .alert-danger, .p-toast-message-warn');
        for (const msg of mensagensErro) {
          const textoErro = msg.innerText || '';
          if (textoErro.length > 0) {
            log(`Mensagem do sistema: ${textoErro}`);
            if (textoErro.includes('obrigatório') || textoErro.includes('inválido') || textoErro.includes('erro')) {
              log(`✗ Item ${numeroItem}: ERRO - ${textoErro}`);
              if (!itensComErro.find(i => i.numero === numeroItem)) {
                itensComErro.push({ numero: numeroItem, erro: textoErro });
              }
              propostaSalva = false;
              break;
            }
          }
        }

        // RESULTADO FINAL DO ITEM
        if (propostaSalva) {
          itensSalvos++;
          log(`✓✓✓ Item ${numeroItem}: CONFIRMADO SALVO (lixeira visivel) ✓✓✓`);

          // Colapsa o item após salvar para evitar confusão visual
          const chevronUp = linhaItem.querySelector('.fas.fa-chevron-up, .fa-chevron-up, [class*="chevron-up"]');
          if (chevronUp) {
            chevronUp.click();
            log('Colapsou item ' + numeroItem + ' apos salvar');
            await aguardar(300);
          }
        } else {
          // NAO SALVOU - lixeira nao apareceu
          log(`✗✗✗ Item ${numeroItem}: NAO CONFIRMADO - LIXEIRA NAO APARECEU ✗✗✗`);
          if (!itensComErro.find(i => i.numero === numeroItem)) {
            itensComErro.push({ numero: numeroItem, erro: 'Proposta NAO salva - lixeira nao apareceu apos ' + maxTentativasVerificacao + ' tentativas' });
          }
        }
      } else {
        log('AVISO: Botão Salvar não encontrado');
        itensComErro.push({ numero: numeroItem, erro: 'Botão salvar não encontrado' });
      }
    }

    // Limpa estado
    await chrome.storage.local.set({
      envioPropostaEmAndamento: false,
      dadosPropostaAtual: null
    });

    // Resultado final baseado em erros encontrados
    // SO mostra sucesso se TODOS os itens foram salvos (lixeira confirmada)
    let resultadoFinal = { success: false, message: '' };

    if (itensComErro.length === 0 && itensSalvos > 0) {
      // SUCESSO TOTAL - todos os itens foram salvos e confirmados
      log(`=== ✓✓✓ PROPOSTA ENVIADA COM SUCESSO (${itensSalvos} itens confirmados) ✓✓✓ ===`);
      mostrarNotificacao(`Proposta enviada! ${itensSalvos} itens salvos.`, 'success');
      resultadoFinal = { success: true, message: `${itensSalvos} itens salvos com sucesso` };
    } else if (itensSalvos > 0 && itensComErro.length > 0) {
      // SUCESSO PARCIAL - alguns salvos, alguns com erro
      log(`=== ⚠ PROPOSTA PARCIAL: ${itensSalvos} salvos, ${itensComErro.length} com erro ⚠ ===`);
      for (const item of itensComErro) {
        log(`  ✗ Item ${item.numero}: ${item.erro}`);
      }
      mostrarNotificacao(`ATENÇÃO: ${itensSalvos} salvos, ${itensComErro.length} NÃO salvos!`, 'warning');
      resultadoFinal = { success: false, message: `Parcial: ${itensSalvos} salvos, ${itensComErro.length} com erro`, itensComErro };
    } else {
      // FALHA TOTAL - nenhum item foi salvo
      log('=== ✗✗✗ ERRO: NENHUM ITEM FOI SALVO ✗✗✗ ===');
      for (const item of itensComErro) {
        log(`  ✗ Item ${item.numero}: ${item.erro}`);
      }
      mostrarNotificacao('ERRO: Nenhum item foi salvo! Verifique manualmente.', 'error');
      resultadoFinal = { success: false, message: 'Nenhum item foi salvo', itensComErro };
    }

    // Notifica o servidor com o resultado REAL
    await serverFetch(`${SERVER_URL}/api/proposta/resultado`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: resultadoFinal.success,
        itensSalvos,
        itensComErro,
        compraId,
        uasg,
        numeroCompra,
        itens,
        timestamp: new Date().toISOString()
      })
    }).catch(() => {});

    return resultadoFinal;

  } catch (error) {
    log(`ERRO ao enviar proposta: ${error.message}`);
    mostrarNotificacao(`Erro: ${error.message}`, 'error');

    // Limpa estado
    await chrome.storage.local.set({
      envioPropostaEmAndamento: false,
      dadosPropostaAtual: null
    });

    return { success: false, error: error.message };
  } finally {
    liberarAba();
  }
}

// (Funções de polling e continuarEnvioProposta estão no final do arquivo)

// Escuta mensagens do popup

// ==================== MESSAGE LISTENER ====================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Keep-alive do background
  if (request.action === 'keepAlive') {
    log('Keep-alive recebido do background');
    sendResponse({ alive: true });
    return;
  }

  if (request.action === 'enviarProposta') {
    log('=== ACAO ENVIAR PROPOSTA RECEBIDA ===');
    log('Dados: ' + JSON.stringify(request.dados));

    enviarPropostaComprasnet(request.dados).then(result => {
      log('Resultado envio: ' + JSON.stringify(result));
      sendResponse(result);
    }).catch(err => {
      log('Erro no envio: ' + err.message);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  } else if (request.action === 'status') {
    sendResponse({
      url: window.location.href,
      logado: !window.location.href.includes('acesso-nao-autorizado')
    });
    return true;
  }
  return true;
});

// Keep-alive para manter sessao ativa
const KEEP_ALIVE_INTERVAL = 3 * 60 * 1000;
let keepAliveTimer = null;

function iniciarKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    serverFetch(SERVER_URL + '/api/chat/keep-alive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp: new Date().toISOString() })
    }).catch(() => {});
    log('Keep-alive: sessao mantida ativa');
  }, KEEP_ALIVE_INTERVAL);
}

// Polling de propostas pendentes
let pollingPropostasTimer = null;
let processandoPropostaAtual = false; // Flag para evitar loop

function iniciarPollingPropostas() {
  if (pollingPropostasTimer) clearInterval(pollingPropostasTimer);

  // Verifica imediatamente ao iniciar (mas só se não estiver processando)
  if (!processandoPropostaAtual) {
    verificarPropostaPendente();
  }

  // Depois verifica a cada 10 segundos
  pollingPropostasTimer = setInterval(() => {
    if (!processandoPropostaAtual) {
      verificarPropostaPendente();
    }
  }, 10000);
}

async function verificarPropostaPendente() {
  // IMPORTANTE: Não processar se já está processando
  if (processandoPropostaAtual) {
    log('Ja esta processando uma proposta, ignorando polling...');
    return;
  }

  try {
    const response = await serverFetch(SERVER_URL + '/api/proposta/fila');
    if (response.ok) {
      const data = await response.json();
      if (data.success && data.hasPendente && data.data) {
        const proposta = data.data;

        // Verifica se já processamos esta proposta recentemente (evita loop)
        // Só ignora se foi processada nos últimos 2 minutos
        const storage = await chrome.storage.local.get(['ultimaPropostaProcessada', 'ultimaPropostaTimestamp']);
        if (storage.ultimaPropostaProcessada === proposta.compraId && storage.ultimaPropostaTimestamp) {
          const tempoDecorrido = Date.now() - storage.ultimaPropostaTimestamp;
          const doisMinutos = 2 * 60 * 1000;
          if (tempoDecorrido < doisMinutos) {
            log('Proposta ' + proposta.compraId + ' ja foi processada ha ' + Math.round(tempoDecorrido/1000) + 's, ignorando...');
            return;
          } else {
            log('Proposta ' + proposta.compraId + ' foi processada ha mais de 2min, permitindo reprocessar...');
          }
        }

        log('Proposta pendente na fila: compraId=' + proposta.compraId);

        const url = window.location.href;

        // Se estamos na pagina de cadastro-propostas com a compra correta
        if (url.includes('cadastro-propostas') && url.includes(proposta.compraId)) {
          log('Ja estamos na pagina correta - iniciando envio...');

          // Marca que esta processando ANTES de iniciar
          processandoPropostaAtual = true;

          // Salva no storage com timestamp
          await chrome.storage.local.set({
            envioPropostaEmAndamento: true,
            dadosPropostaAtual: proposta,
            ultimaPropostaProcessada: proposta.compraId,
            ultimaPropostaTimestamp: Date.now()
          });

          try {
            await enviarPropostaComprasnet(proposta);
          } finally {
            // Libera o flag apos processar (sucesso ou erro)
            processandoPropostaAtual = false;
          }
        }
        // Se estamos logados no Comprasnet mas em outra pagina
        else if (url.includes('comprasnet-web/seguro')) {
          // Verifica se a aba está livre antes de navegar
          const linkCadastro = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/cadastro-propostas?compra=' + proposta.compraId;

          if (!abaLivre()) {
            const atual = getExtensaoAtual();
            log(`[Aba] Ocupada por ${atual.nome} (${atual.operacao}) - abrindo nova aba para proposta`);
            chrome.runtime.sendMessage({ action: 'abrirPagina', url: linkCadastro });

            await chrome.storage.local.set({
              envioPropostaEmAndamento: true,
              dadosPropostaAtual: proposta,
              ultimaPropostaProcessada: proposta.compraId,
              ultimaPropostaTimestamp: Date.now()
            });
            return;
          }

          log('Redirecionando para pagina de cadastro de proposta...');

          // Marca que esta processando
          processandoPropostaAtual = true;

          // Salva no storage antes de navegar com timestamp
          await chrome.storage.local.set({
            envioPropostaEmAndamento: true,
            dadosPropostaAtual: proposta,
            ultimaPropostaProcessada: proposta.compraId,
            ultimaPropostaTimestamp: Date.now()
          });

          // Navega para a pagina de cadastro
          window.location.href = linkCadastro;
        }
      }
    }
  } catch (e) {
    // Ignora erros de polling
  }
}

// Continua envio de proposta se houver em andamento
async function continuarEnvioProposta() {
  const storage = await chrome.storage.local.get(['envioPropostaEmAndamento', 'dadosPropostaAtual']);
  if (storage.envioPropostaEmAndamento && storage.dadosPropostaAtual) {
    log('Continuando envio de proposta apos navegacao...');
    await enviarPropostaComprasnet(storage.dadosPropostaAtual);
  }
}

// Inicializacao
(async () => {
  const url = window.location.href;
  if (!url.includes('cnetmobile.estaleiro.serpro.gov.br')) return;

  // NAO EXECUTAR em paginas de login/captcha para nao interferir
  if (url.includes('/login') ||
      url.includes('/acesso') ||
      url.includes('govbr') ||
      url.includes('sso.acesso.gov.br') ||
      !url.includes('/seguro/')) {
    console.log('[Propostas] Pagina de login/captcha detectada - extensao DESATIVADA');
    return;
  }

  log('=== EXTENSAO PROPOSTAS INICIADA ===');
  log('URL: ' + url);

  // Registra presença passiva e inicia heartbeat
  registrarPresenca('aguardando');
  iniciarHeartbeat();

  // Verifica se ha envio de proposta em andamento
  if (url.includes('cadastro-propostas')) {
    log('Pagina de cadastro de propostas detectada');
    await continuarEnvioProposta();
  }

  // Inicia keep-alive e polling
  iniciarKeepAlive();
  iniciarPollingPropostas();
})();
