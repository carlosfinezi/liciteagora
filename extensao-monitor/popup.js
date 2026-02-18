// Monitor Comprasnet - Popup Script v5.4
// Com suporte a configuracao avancada (escolher status e pagina inicial)

const SERVER_URL = '__SERVER_URL__';

// Elementos principais
const serverIndicator = document.getElementById('serverIndicator');
const serverStatus = document.getElementById('serverStatus');
const loginIndicator = document.getElementById('loginIndicator');
const loginStatus = document.getElementById('loginStatus');
const monitorIndicator = document.getElementById('monitorIndicator');
const monitorStatus = document.getElementById('monitorStatus');
const avisoLogin = document.getElementById('avisoLogin');
const msgCount = document.getElementById('msgCount');
const licCount = document.getElementById('licCount');
const btnIniciar = document.getElementById('btnIniciar');
const btnIniciarCustom = document.getElementById('btnIniciarCustom');
const btnParar = document.getElementById('btnParar');
const btnAbrir = document.getElementById('btnAbrir');
const resultado = document.getElementById('resultado');

// Elementos de configuracao
const toggleConfig = document.getElementById('toggleConfig');
const toggleIcon = document.getElementById('toggleIcon');
const configPanel = document.getElementById('configPanel');
const selectStatus = document.getElementById('selectStatus');
const inputPagina = document.getElementById('inputPagina');
const inputIndice = document.getElementById('inputIndice');
const btnCarregarStatus = document.getElementById('btnCarregarStatus');
const statusPreview = document.getElementById('statusPreview');
const previewStatus = document.getElementById('previewStatus');
const previewPagina = document.getElementById('previewPagina');
const previewIndice = document.getElementById('previewIndice');

let estaLogado = false;
let estaMonitorando = false;
let configAberta = false;
let statusDisponiveis = [];

// Lista padrao de status (usada se nao conseguir carregar da pagina)
const STATUS_PADRAO = [
  'Em andamento',
  'Propostas',
  'Disputa',
  'Selecao de fornecedores',
  'Homologado',
  'Encerrado',
  'Adjudicado',
  'Suspenso',
  'Revogado',
  'Anulado',
  'Fracassado',
  'Deserto'
];

// Toggle configuracao avancada
toggleConfig.addEventListener('click', () => {
  configAberta = !configAberta;
  configPanel.classList.toggle('hidden', !configAberta);
  toggleIcon.classList.toggle('open', configAberta);
  btnIniciarCustom.classList.toggle('hidden', !configAberta);

  if (configAberta && selectStatus.options.length <= 1) {
    carregarStatusDisponiveis();
  }
});

// Atualiza preview quando muda configuracao
selectStatus.addEventListener('change', atualizarPreview);
inputPagina.addEventListener('change', atualizarPreview);
inputIndice.addEventListener('change', atualizarPreview);

function atualizarPreview() {
  const status = selectStatus.value || selectStatus.options[selectStatus.selectedIndex]?.text || '-';
  previewStatus.textContent = status;
  previewPagina.textContent = inputPagina.value || '1';
  previewIndice.textContent = inputIndice.value || '1';
  statusPreview.classList.remove('hidden');
}

// Carrega lista de status disponiveis do content script
async function carregarStatusDisponiveis() {
  selectStatus.innerHTML = '<option value="">Carregando...</option>';

  try {
    const response = await enviarMensagemParaAba({ action: 'obterStatusDisponiveis' });

    if (response && response.success && response.statusList && response.statusList.length > 0) {
      statusDisponiveis = response.statusList;
    } else {
      // Usa lista padrao se nao conseguir carregar
      statusDisponiveis = STATUS_PADRAO;
    }

    // Popula o select
    selectStatus.innerHTML = '';
    statusDisponiveis.forEach((status, index) => {
      const option = document.createElement('option');
      option.value = status;
      option.textContent = status;
      selectStatus.appendChild(option);
    });

    atualizarPreview();

  } catch (e) {
    console.error('Erro ao carregar status:', e);
    // Usa lista padrao em caso de erro
    selectStatus.innerHTML = '';
    STATUS_PADRAO.forEach(status => {
      const option = document.createElement('option');
      option.value = status;
      option.textContent = status;
      selectStatus.appendChild(option);
    });
    atualizarPreview();
  }
}

// Botao para recarregar status
btnCarregarStatus.addEventListener('click', carregarStatusDisponiveis);

// Envia mensagem para a aba ativa
function enviarMensagemParaAba(message) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && (tabs[0].url.includes('cnetmobile') || tabs[0].url.includes('comprasnet'))) {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { success: false });
          }
        });
      } else {
        resolve({ success: false, error: 'Pagina incorreta' });
      }
    });
  });
}

// Verifica servidor
async function verificarServidor() {
  try {
    const response = await fetch(`${SERVER_URL}/api/chat/status`);
    if (response.ok) {
      serverIndicator.className = 'status-indicator online';
      serverStatus.textContent = 'Online';
      return true;
    }
  } catch (e) {}
  serverIndicator.className = 'status-indicator offline';
  serverStatus.textContent = 'Offline';
  return false;
}

// Obtem estatisticas do servidor
async function obterEstatisticas() {
  try {
    const response = await fetch(`${SERVER_URL}/api/chat/mensagens/stats`);
    if (response.ok) {
      const data = await response.json();
      if (data.success) {
        msgCount.textContent = data.data.total || 0;
      }
    }

    const response2 = await fetch(`${SERVER_URL}/api/chat/mensagens/licitacoes`);
    if (response2.ok) {
      const data2 = await response2.json();
      if (data2.success) {
        licCount.textContent = data2.data.length || 0;
      }
    }
  } catch (e) {}
}

// Verifica status da aba
async function verificarStatusAba() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && (tabs[0].url.includes('cnetmobile') || tabs[0].url.includes('comprasnet'))) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'status' }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ logado: false, monitorando: false });
          } else {
            resolve(response || { logado: false, monitorando: false });
          }
        });
      } else {
        resolve({ logado: false, monitorando: false, paginaErrada: true });
      }
    });
  });
}

// Atualiza interface
async function atualizarInterface() {
  const servidorOnline = await verificarServidor();

  if (servidorOnline) {
    await obterEstatisticas();
  }

  const statusAba = await verificarStatusAba();

  if (statusAba.paginaErrada) {
    loginIndicator.className = 'status-indicator offline';
    loginStatus.textContent = 'Abra o Comprasnet';
    avisoLogin.classList.remove('hidden');
    btnIniciar.disabled = true;
    btnIniciarCustom.disabled = true;
    estaLogado = false;
  } else if (statusAba.logado) {
    loginIndicator.className = 'status-indicator online';
    loginStatus.textContent = 'Logado';
    avisoLogin.classList.add('hidden');
    btnIniciar.disabled = false;
    btnIniciarCustom.disabled = false;
    estaLogado = true;
  } else {
    loginIndicator.className = 'status-indicator offline';
    loginStatus.textContent = 'Nao logado';
    avisoLogin.classList.remove('hidden');
    btnIniciar.disabled = true;
    btnIniciarCustom.disabled = true;
    estaLogado = false;
  }

  if (statusAba.monitorando) {
    monitorIndicator.className = 'status-indicator monitoring';
    monitorStatus.textContent = 'Ativo';
    btnIniciar.classList.add('hidden');
    btnIniciarCustom.classList.add('hidden');
    btnParar.classList.remove('hidden');
    estaMonitorando = true;
  } else {
    monitorIndicator.className = 'status-indicator offline';
    monitorStatus.textContent = 'Inativo';
    btnIniciar.classList.remove('hidden');
    if (configAberta) btnIniciarCustom.classList.remove('hidden');
    btnParar.classList.add('hidden');
    estaMonitorando = false;
  }
}

// Mostra resultado
function mostrarResultado(sucesso, mensagem) {
  resultado.textContent = mensagem;
  resultado.className = sucesso ? 'success' : 'error';
  resultado.classList.remove('hidden');
  setTimeout(() => resultado.classList.add('hidden'), 4000);
}

// Iniciar monitoramento do inicio
btnIniciar.addEventListener('click', () => {
  iniciarMonitoramento(null); // null = do inicio
});

// Iniciar monitoramento personalizado
btnIniciarCustom.addEventListener('click', () => {
  const config = {
    statusInicial: selectStatus.value,
    paginaInicial: parseInt(inputPagina.value) || 1,
    indiceInicial: parseInt(inputIndice.value) || 1
  };

  iniciarMonitoramento(config);
});

// Funcao para iniciar monitoramento
function iniciarMonitoramento(config) {
  const btn = config ? btnIniciarCustom : btnIniciar;
  const textoOriginal = btn.textContent;

  btn.disabled = true;
  btn.textContent = 'Iniciando...';

  const message = {
    action: 'iniciarAutomatico',
    config: config // null para iniciar do comeco, ou objeto com configuracao
  };

  const URL_PARTICIPACOES = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras';

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      const urlAtual = tabs[0].url || '';

      // Se não está no Comprasnet, navega automaticamente
      if (!urlAtual.includes('cnetmobile.estaleiro.serpro.gov.br') && !urlAtual.includes('comprasnet.gov.br')) {
        mostrarResultado(true, 'Navegando para Comprasnet...');

        // Salva configuração para iniciar após navegação
        chrome.storage.local.set({
          iniciarAposNavegar: true,
          configCustomizada: config
        });

        // Navega para a página de participações
        chrome.tabs.update(tabs[0].id, { url: URL_PARTICIPACOES });

        btn.disabled = false;
        btn.textContent = textoOriginal;
        return;
      }

      // Se está no Comprasnet mas não na página de participações, navega
      if (!urlAtual.includes('/fornecedor/compras')) {
        mostrarResultado(true, 'Navegando para participações...');

        chrome.storage.local.set({
          iniciarAposNavegar: true,
          configCustomizada: config
        });

        chrome.tabs.update(tabs[0].id, { url: URL_PARTICIPACOES });

        btn.disabled = false;
        btn.textContent = textoOriginal;
        return;
      }

      // Está na página correta, envia mensagem para iniciar
      chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
        btn.disabled = false;
        btn.textContent = textoOriginal;

        if (chrome.runtime.lastError) {
          mostrarResultado(false, 'Erro: Recarregue a pagina do Comprasnet');
        } else if (response && response.success) {
          const msg = config
            ? `Iniciando de "${config.statusInicial}" pag.${config.paginaInicial}`
            : 'Monitoramento iniciado!';
          mostrarResultado(true, msg);
          atualizarInterface();
        } else {
          mostrarResultado(false, response?.message || 'Erro ao iniciar');
        }
      });
    }
  });
}

// Parar monitoramento
btnParar.addEventListener('click', () => {
  // Limpa o storage diretamente para garantir que pare
  chrome.storage.local.set({
    monitoramentoAtivo: false,
    emProcessamento: false
  });

  // Tenta enviar mensagem para todas as abas do Comprasnet
  chrome.tabs.query({ url: '*://cnetmobile.estaleiro.serpro.gov.br/*' }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'pararAutomatico' }, () => {
        // Ignora erros
        if (chrome.runtime.lastError) {}
      });
    });
  });

  // Também tenta na aba ativa
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'pararAutomatico' }, () => {
        if (chrome.runtime.lastError) {}
      });
    }
  });

  mostrarResultado(true, 'Monitoramento parado');
  setTimeout(() => atualizarInterface(), 500);
});

// Abrir painel
btnAbrir.addEventListener('click', () => {
  chrome.tabs.create({ url: `${SERVER_URL}/monitoramento-chat.html` });
});

// Inicializacao
atualizarInterface();
setInterval(atualizarInterface, 5000);
