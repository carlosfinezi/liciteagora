const $ = id => document.getElementById(id);

function atualizarStatus() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
    if (chrome.runtime.lastError) return;
    if (!res) return;

    $('sToken').textContent = res.ultimoToken || '-- aguardando';
    $('sToken').className = 'v ' + (res.ultimoToken ? 'verde' : 'vermelho');

    $('sCaptcha').textContent = res.ultimoCaptcha ? res.ultimoCaptcha + ' (' + (res.captchaIdade || '?') + ')' : '-- aguardando';
    $('sCaptcha').className = 'v ' + (res.ultimoCaptcha ? 'verde' : 'vermelho');

    $('sServer').textContent = res.serverUrl || '--';
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
  });
}

atualizarStatus();
setInterval(atualizarStatus, 3000);
