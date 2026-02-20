var $ = function(id) { return document.getElementById(id); };

function atualizar() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, function(res) {
    if (chrome.runtime.lastError || !res) return;

    $('sBearer').textContent = res.bearer || '❌ aguardando';
    $('sBearer').className = 'v ' + (res.bearer ? 'verde' : 'vermelho');

    $('sCaptcha').textContent = res.captcha ? res.captcha + ' (' + (res.captchaIdade || '?') + ')' : '❌ aguardando';
    $('sCaptcha').className = 'v ' + (res.captcha ? 'verde' : 'vermelho');

    $('sSync').textContent = res.ultimoSync || '--';
    $('sEnvio').textContent = res.ultimoEnvio || '--';
    $('sSyncs').textContent = res.stats ? res.stats.syncs || 0 : 0;
    $('sEnv').textContent = res.stats ? res.stats.enviados || 0 : 0;
    $('sErr').textContent = res.stats ? res.stats.erros || 0 : 0;

    if (res.ultimoErro) {
      $('rowErro').style.display = 'flex';
      $('sUltErro').textContent = res.ultimoErro;
    } else {
      $('rowErro').style.display = 'none';
    }
  });
}

function showMsg(text, ok) {
  $('msgArea').innerHTML = '<div class="msg ' + (ok ? 'msg-ok' : 'msg-erro') + '">' + text + '</div>';
  if (ok) setTimeout(function() { $('msgArea').innerHTML = ''; }, 3000);
}

$('btnSync').addEventListener('click', function() {
  chrome.runtime.sendMessage({ type: 'forceSync' }, function(res) {
    if (chrome.runtime.lastError) {
      showMsg('Erro: ' + chrome.runtime.lastError.message, false);
      return;
    }
    if (res && res.ok) showMsg('✅ Sync iniciado!', true);
    else showMsg(res ? res.error : 'Erro', false);
  });
});

atualizar();
setInterval(atualizar, 3000);
