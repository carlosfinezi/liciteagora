/**
 * aviso-mensagem.js — o pop-up de mensagem nova DENTRO do ERP.
 *
 * Carregado só pelo shell (`app.html`), que é a única coisa que continua
 * montada enquanto a pessoa troca de tela. Numa tela, o aviso morreria na
 * primeira navegação — que é justamente quando ele precisaria aparecer.
 *
 * ── Quem dispara ───────────────────────────────────────────────────────────
 *
 * O service worker. Ele recebe o sinal do push, busca nome e trecho em
 * `/api/push/pendentes` e, se encontrar uma aba VISÍVEL, manda o recado para cá
 * em vez de abrir a notificação do sistema — com o ERP na frente da pessoa, o
 * balão do sistema operacional é ruído em cima de uma tela que já avisa.
 *
 * Não há polling aqui. O aviso chega por push ou não chega; uma consulta a cada
 * 30 segundos multiplicada por cada pessoa logada em cada tenant seria um custo
 * permanente para um evento que é raro no dia.
 *
 * ── O que ele deliberadamente não faz ──────────────────────────────────────
 *
 * Não toca som: som é decisão da tela de Conversas, que tem o interruptor
 * próprio. Dois avisos sonoros para o mesmo evento é o caminho para a pessoa
 * desligar os dois.
 */
(function avisoDeMensagem() {
  if (!('serviceWorker' in navigator)) return;

  var CAIXA = null;
  var TEMPO = null;

  function estilo() {
    if (document.getElementById('aviso-msg-estilo')) return;
    var s = document.createElement('style');
    s.id = 'aviso-msg-estilo';
    s.textContent =
      '#aviso-msg{position:fixed;right:16px;bottom:16px;z-index:9999;max-width:340px;'
      + 'background:var(--bg-1,#fff);border:1px solid var(--border,#dbe2ea);'
      + 'border-left:3px solid var(--success,#16a34a);border-radius:8px;'
      + 'box-shadow:0 12px 32px -12px rgba(0,0,0,.35);padding:12px 14px;cursor:pointer;'
      + 'font-size:14px;line-height:1.4;color:var(--text-1,#334155);'
      + 'transform:translateY(8px);opacity:0;transition:opacity .18s ease,transform .18s ease}'
      + '#aviso-msg.vendo{opacity:1;transform:translateY(0)}'
      + '#aviso-msg strong{display:block;color:var(--text-0,#0f172a);margin-bottom:2px}'
      + '#aviso-msg .mais{display:block;margin-top:6px;font-size:11px;color:var(--text-3,#64748b);'
      + 'text-transform:uppercase;letter-spacing:.06em}';
    document.head.appendChild(s);
  }

  function mostrar(itens) {
    if (!itens || !itens.length) return;
    estilo();
    var primeiro = itens[0];
    if (!CAIXA) {
      CAIXA = document.createElement('div');
      CAIXA.id = 'aviso-msg';
      CAIXA.setAttribute('role', 'status');
      CAIXA.addEventListener('click', function () {
        abrirConversas(primeiro.conversaId);
        esconder();
      });
      document.body.appendChild(CAIXA);
    }
    // `textContent` por partes, nunca innerHTML: o texto vem de fora, escrito
    // por quem quiser, e uma mensagem com `<img onerror>` não pode virar HTML.
    CAIXA.textContent = '';
    var quem = document.createElement('strong');
    quem.textContent = primeiro.quem || 'Mensagem nova';
    var texto = document.createElement('span');
    texto.textContent = primeiro.trecho || 'mandou uma mensagem';
    CAIXA.appendChild(quem);
    CAIXA.appendChild(texto);
    if (itens.length > 1) {
      var mais = document.createElement('span');
      mais.className = 'mais';
      mais.textContent = 'e mais ' + (itens.length - 1) + ' conversa(s)';
      CAIXA.appendChild(mais);
    }
    requestAnimationFrame(function () { CAIXA.classList.add('vendo'); });
    clearTimeout(TEMPO);
    TEMPO = setTimeout(esconder, 9000);
  }

  function esconder() {
    if (!CAIXA) return;
    CAIXA.classList.remove('vendo');
    clearTimeout(TEMPO);
  }

  function abrirConversas() {
    // O shell navega por hash; a tela de Conversas se vira com a lista a partir
    // daí. Abrir a conversa exata exigiria um parâmetro que a inbox ainda não lê,
    // e prometer isso no clique sem entregar seria pior que levar até a lista.
    try { location.hash = '#/comunicacao/conversas.html'; } catch (e) { /* segue */ }
  }

  navigator.serviceWorker.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.tipo === 'mensagem-nova') mostrar(d.itens);
    if (d.tipo === 'abrir-conversas') abrirConversas();
  });
})();
