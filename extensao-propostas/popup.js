// Popup para extensao de propostas
const SERVER_URL = '__SERVER_URL__';

document.addEventListener('DOMContentLoaded', async () => {
  await verificarStatus();

  document.getElementById('btnAbrir').addEventListener('click', () => {
    chrome.tabs.create({ url: SERVER_URL + '/propostas' });
  });

  document.getElementById('btnRefresh').addEventListener('click', verificarStatus);
});

async function verificarStatus() {
  // Verifica servidor
  try {
    const response = await fetch(SERVER_URL + '/api/health');
    if (response.ok) {
      document.getElementById('serverIndicator').className = 'status-indicator online';
      document.getElementById('serverStatus').textContent = 'Online';
    } else {
      throw new Error('Servidor offline');
    }
  } catch (e) {
    document.getElementById('serverIndicator').className = 'status-indicator offline';
    document.getElementById('serverStatus').textContent = 'Offline';
  }

  // Verifica login no Comprasnet
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('cnetmobile.estaleiro.serpro.gov.br')) {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'status' });
      if (response && response.logado) {
        document.getElementById('loginIndicator').className = 'status-indicator online';
        document.getElementById('loginStatus').textContent = 'Logado';
      } else {
        document.getElementById('loginIndicator').className = 'status-indicator offline';
        document.getElementById('loginStatus').textContent = 'Nao logado';
      }
    } else {
      document.getElementById('loginIndicator').className = 'status-indicator offline';
      document.getElementById('loginStatus').textContent = 'Abra o Comprasnet';
    }
  } catch (e) {
    document.getElementById('loginIndicator').className = 'status-indicator offline';
    document.getElementById('loginStatus').textContent = 'Verificar';
  }

  // Verifica propostas pendentes
  try {
    const response = await fetch(SERVER_URL + '/api/comprasnet/propostas-pendentes');
    if (response.ok) {
      const propostas = await response.json();
      document.getElementById('pendingCount').textContent = propostas.length || 0;
    }
  } catch (e) {
    document.getElementById('pendingCount').textContent = '-';
  }
}
