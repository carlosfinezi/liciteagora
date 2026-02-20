const $ = id => document.getElementById(id);

function atualizarStatus() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
    if (chrome.runtime.lastError) {
      showMsg('Service worker: ' + chrome.runtime.lastError.message, false);
      return;
    }
    if (!res) return;

    $('sToken').textContent = res.ultimoToken || '❌ Nenhum';
    $('sToken').className = 'v ' + (res.ultimoToken ? 'verde' : 'vermelho');

    $('sServer').textContent = res.serverUrl || '❌ Não configurado';
    $('sServer').className = 'v ' + (res.serverUrl ? 'azul' : 'vermelho');

    $('sEnvio').textContent = res.ultimoEnvio || '--';
    $('sCap').textContent = res.stats?.capturados || 0;
    $('sEnv').textContent = res.stats?.enviados || 0;
    $('sErr').textContent = res.stats?.erros || 0;

    if (res.ultimoErro) {
      $('rowErro').style.display = 'flex';
      $('sUltErro').textContent = res.ultimoErro;
    } else {
      $('rowErro').style.display = 'none';
    }

    if (res.serverUrl) {
      $('inputServer').value = res.serverUrl;
    }
  });
}

function showMsg(text, ok) {
  $('msgArea').innerHTML = '<div class="msg ' + (ok ? 'msg-ok' : 'msg-erro') + '">' + text + '</div>';
  if (ok) setTimeout(function() { $('msgArea').innerHTML = ''; }, 4000);
}

$('btnSalvar').addEventListener('click', function() {
  var url = $('inputServer').value.trim();
  if (!url) return showMsg('Digite a URL do servidor', false);
  if (url.indexOf('http') !== 0) return showMsg('URL deve começar com http:// ou https://', false);

  showMsg('Salvando...', true);

  chrome.runtime.sendMessage({ type: 'setServer', url: url }, function(res) {
    if (chrome.runtime.lastError) {
      showMsg('Erro: ' + chrome.runtime.lastError.message, false);
      return;
    }
    if (res && res.ok) {
      var extra = res.enviou ? ' Token enviado!' : ' (navegue no Comprasnet para capturar token)';
      showMsg('✅ Servidor salvo!' + extra, true);
    } else {
      showMsg('Erro: ' + (res?.error || 'desconhecido'), false);
    }
    setTimeout(atualizarStatus, 500);
  });
});

$('btnSync').addEventListener('click', function() {
  showMsg('Enviando...', true);

  chrome.runtime.sendMessage({ type: 'forceSync' }, function(res) {
    if (chrome.runtime.lastError) {
      showMsg('Erro: ' + chrome.runtime.lastError.message, false);
      return;
    }
    if (res && res.ok) showMsg('✅ Token enviado ao servidor!', true);
    else showMsg(res?.error || 'Falha ao enviar', false);
    setTimeout(atualizarStatus, 500);
  });
});

atualizarStatus();
setInterval(atualizarStatus, 3000);
