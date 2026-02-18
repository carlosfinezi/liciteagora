// Popup da extensão de lances

let tabAtiva = null;
let statusAtual = null;

async function buscarStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url.includes('cnetmobile.estaleiro.serpro.gov.br')) {
      document.getElementById('avisoConexao').textContent = 'Abra o Comprasnet para usar';
      document.getElementById('avisoConexao').className = 'aviso';
      return;
    }

    tabAtiva = tab;

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });

    if (response) {
      statusAtual = response;
      atualizarInterface(response);
    }

  } catch (e) {
    document.getElementById('avisoConexao').textContent = 'Extensão não conectada. Recarregue a página.';
    document.getElementById('avisoConexao').className = 'aviso';
  }
}

function atualizarInterface(status) {
  const aviso = document.getElementById('avisoConexao');
  const statusTexto = document.getElementById('statusTexto');
  const itensCount = document.getElementById('itensCount');
  const modoTexto = document.getElementById('modoTexto');
  const btnAuto = document.getElementById('btnAuto');

  if (status.ativo) {
    aviso.textContent = 'Conectado à página de disputa';
    aviso.className = 'aviso conectado';
    statusTexto.textContent = 'Em Disputa';
    statusTexto.className = 'status-value verde';
  } else {
    aviso.textContent = 'Aguardando disputa iniciar...';
    aviso.className = 'aviso';
    statusTexto.textContent = 'Aguardando';
    statusTexto.className = 'status-value amarelo';
  }

  itensCount.textContent = status.itens || 0;

  if (status.automatico) {
    modoTexto.textContent = 'Automático';
    modoTexto.className = 'status-value verde';
    btnAuto.textContent = 'Desativar Automático';
    btnAuto.classList.add('ativo');
  } else {
    modoTexto.textContent = 'Manual';
    modoTexto.className = 'status-value amarelo';
    btnAuto.textContent = 'Ativar Automático';
    btnAuto.classList.remove('ativo');
  }
}

async function toggleAutomatico() {
  if (!tabAtiva) {
    alert('Abra o Comprasnet primeiro');
    return;
  }

  // Envia configuração antes de ativar
  await enviarConfiguracao();

  try {
    const response = await chrome.tabs.sendMessage(tabAtiva.id, { action: 'toggleAutomatico' });

    if (response && response.success) {
      buscarStatus();
    }
  } catch (e) {
    alert('Erro ao comunicar com a página');
  }
}

async function enviarConfiguracao() {
  if (!tabAtiva) return;

  const config = {
    modo: document.getElementById('modoCobertura').value,
    cobertura: parseFloat(document.getElementById('valorCobertura').value) || 0.01,
    minimo: parseFloat(document.getElementById('valorMinimo').value) || null
  };

  try {
    await chrome.tabs.sendMessage(tabAtiva.id, { action: 'setConfig', config });

    // Salva localmente
    chrome.storage.local.set({ lanceConfig: config });

  } catch (e) {
    console.error('Erro ao enviar configuração:', e);
  }
}

function abrirPagina() {
  chrome.tabs.create({ url: '__SERVER_URL__/lances.html' });
}

// Carrega configuração salva
async function carregarConfiguracao() {
  const result = await chrome.storage.local.get(['lanceConfig']);

  if (result.lanceConfig) {
    document.getElementById('modoCobertura').value = result.lanceConfig.modo || 'valor';
    document.getElementById('valorCobertura').value = result.lanceConfig.cobertura || 0.01;
    if (result.lanceConfig.minimo) {
      document.getElementById('valorMinimo').value = result.lanceConfig.minimo;
    }
  }
}

// Event listeners
document.getElementById('modoCobertura').addEventListener('change', enviarConfiguracao);
document.getElementById('valorCobertura').addEventListener('change', enviarConfiguracao);
document.getElementById('valorMinimo').addEventListener('change', enviarConfiguracao);

// Inicialização
document.addEventListener('DOMContentLoaded', async () => {
  await carregarConfiguracao();
  await buscarStatus();

  // Atualiza a cada 3 segundos
  setInterval(buscarStatus, 3000);
});
