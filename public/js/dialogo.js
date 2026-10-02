/**
 * dialogo.js — o modal que já existe passa a se anunciar como diálogo.
 *
 * ── O que estava errado ─────────────────────────────────────────────────────
 *
 * Medido em 01/10/2026: **100 telas do ERP têm `.modal-header` e só uma
 * declarava `role="dialog"`/`aria-modal`**. Para quem usa leitor de tela esses
 * modais são uma `div` qualquer: não avisam que abriram, não dizem o próprio
 * título, não prendem o foco, e o Tab continua passeando pelo formulário de
 * trás — que está debaixo de um véu e não se vê.
 *
 * O padrão que resolve já existia aqui, e é bom: o `Aviso.confirmar` do
 * `js/aviso-sistema.js` põe `aria-modal`, foca o botão de recusar, devolve o
 * foco de onde ele veio e cicla o Tab dentro da caixa. Faltava generalizar.
 *
 * ── Por que uma peça, e não 100 edições ─────────────────────────────────────
 *
 * As telas abrem o modal de cinco jeitos diferentes, medidos:
 * `classList.add('open')` (199 vezes), `style.display = 'block'` (130),
 * `'flex'` (31), `classList.add('active')` (19) e `classList.toggle` (12). Não
 * existe uma função única para interceptar. O que existe em comum é o
 * RESULTADO: uma caixa `.modal` que estava invisível passa a estar visível.
 *
 * Esta peça observa isso e trata a caixa que está no ar. Nenhuma tela precisa
 * declarar nada, e tela nova entra sozinha.
 *
 * ── Onde ela é PRUDENTE, e por quê ──────────────────────────────────────────
 *
 * Isto roda em 100 telas de produção, e foco de teclado é das coisas que, mal
 * feitas, deixam a pessoa presa:
 *
 *  - **Não rouba o foco de quem já escolheu.** Se a tela já focou um campo
 *    dentro da caixa (várias fazem), a peça não mexe. Ela só move o foco
 *    quando ele está FORA da caixa, que é o caso em que o Tab seguinte cairia
 *    no formulário de trás.
 *  - **Não prende o foco numa caixa sem saída.** A armadilha só é legítima
 *    quando há como sair pelo teclado (WCAG 2.1.2); sem nenhum controle
 *    focável dentro, a peça anuncia o diálogo e não prende nada.
 *  - **Não fecha o modal por conta própria.** O Escape aciona o botão de
 *    fechar DA TELA, quando existe um reconhecível — assim quem fecha continua
 *    sendo o código da tela, com o que ele faz de limpeza. Não achando botão,
 *    o Escape não faz nada: adivinhar qual função chamar em 100 telas poria em
 *    risco formulário meio preenchido.
 *  - **Não mexe em `aria-hidden` do resto da página.** `aria-modal="true"` já
 *    é o que diz ao leitor de tela para ignorar o fundo, e marcar os irmãos
 *    teria de ser desfeito sem falha nenhuma, sempre.
 */
(function dialogo() {
  'use strict';

  /* A caixa, e não o véu: o véu é `.modal-bg`/`.modal-overlay` e ocupa a tela
     inteira; quem é o diálogo é a caixa de dentro. As quatro classes são as
     que existem no sistema, medidas.

     `[data-dialogo]` é a porta para quem está fora da convenção: a ajuda de
     `operacional/lances.html` é um `.help-modal-card`, e levantada a conta
     inteira ela era o único caso. Um atributo serve a qualquer classe futura;
     pendurar "help-modal-card" no seletor seria embutir o nome de uma tela
     numa peça que vale para 124. */
  const CAIXA = '.modal, .modal-card, .modal-box, .modal-content, [data-dialogo]';

  const FOCAVEL = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[tabindex]', '[contenteditable="true"]',
  ].join(',');

  /* O que fecha, na ordem em que o sistema escreve. O `data-fechar-modal` é
     para a tela que quiser dizer qual é, sem depender do reconhecimento. */
  const FECHA = [
    '[data-fechar-modal]',
    '.modal-close',
    '.modal-header [aria-label*="echar" i]',
    '.modal-header button',
    '.modal-header .close',
  ];
  const TEXTO_FECHA = /^\s*(?:[✕×✖xX]|&times;|fechar|cancelar)\s*$/i;

  let ativo = null;          // a caixa no ar
  let devolverPara = null;   // quem tinha o foco antes dela abrir
  let proximoId = 0;

  function visivel(el) {
    if (!el || !el.isConnected) return false;
    /* `checkVisibility` é o que compõe display, visibility e opacity de toda a
       linhagem de uma vez. O `.modal-overlay` esconde por `visibility` com
       `opacity: 0`, e aí o retângulo NÃO é zero: medir só o retângulo daria
       "visível" com a caixa invisível. */
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function focaveis(caixa) {
    return [...caixa.querySelectorAll(FOCAVEL)].filter((el) => {
      if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
      if (el.getAttribute('tabindex') === '-1') return false;
      if (el.type === 'hidden') return false;
      return visivel(el);
    });
  }

  function botaoDeFechar(caixa) {
    for (const sel of FECHA) {
      for (const el of caixa.querySelectorAll(sel)) {
        if (!visivel(el)) continue;
        if (sel === '.modal-header button' && !TEXTO_FECHA.test(el.textContent)) continue;
        return el;
      }
    }
    /* Último recurso: o "Cancelar"/"Fechar" da barra de ações. */
    for (const el of caixa.querySelectorAll('.modal-actions button, .modal-footer button')) {
      if (visivel(el) && TEXTO_FECHA.test(el.textContent)) return el;
    }
    return null;
  }

  /**
   * O título da caixa, para o leitor de tela dizer qual diálogo abriu.
   *
   * Prefere o primeiro título COM TEXTO: várias telas têm um `<h3>` vazio que
   * o JavaScript preenche na abertura, e apontar para ele daria um diálogo com
   * nome em branco. Não havendo nenhum com texto, aponta o primeiro mesmo —
   * é o que será preenchido.
   */
  const TITULOS = '.modal-title, .modal-header h1, .modal-header h2, .modal-header h3, .modal-header h4, h1, h2, h3, h4';
  function rotular(caixa) {
    if (caixa.getAttribute('aria-label')) return;
    const todos = [...caixa.querySelectorAll(TITULOS)];
    if (!todos.length) return;
    const tit = todos.find((t) => t.textContent.trim().length > 1) || todos[0];
    if (!tit.id) tit.id = 'dlg-tit-' + (++proximoId);
    /* Reavalia a cada abertura: o rótulo bom pode ter aparecido depois. */
    caixa.setAttribute('aria-labelledby', tit.id);
  }

  function montar(caixa) {
    ativo = caixa;
    if (!caixa.getAttribute('role')) caixa.setAttribute('role', 'dialog');
    caixa.setAttribute('aria-modal', 'true');
    if (!caixa.hasAttribute('tabindex')) caixa.setAttribute('tabindex', '-1');
    rotular(caixa);

    const antes = document.activeElement;
    // O foco só se mexe quando está FORA da caixa (ver a prudência, acima).
    if (!antes || !caixa.contains(antes)) {
      devolverPara = (antes && antes !== document.body) ? antes : null;
      const lista = focaveis(caixa);
      const fechar = botaoDeFechar(caixa);
      /* O primeiro que não é o botão de fechar: abrir um diálogo com o foco no
         ✕ convida a fechá-lo sem ler. Só havendo o ✕, é ele mesmo. */
      const alvo = lista.find((el) => el !== fechar) || lista[0] || caixa;
      try { alvo.focus({ preventScroll: true }); } catch (e) { /* elemento sumiu */ }
    }
  }

  function desmontar(caixa) {
    caixa.removeAttribute('aria-modal');
    ativo = null;
    const volta = devolverPara;
    devolverPara = null;
    if (volta && volta.isConnected && visivel(volta)) {
      try { volta.focus({ preventScroll: true }); } catch (e) { /* elemento sumiu */ }
    }
  }

  /**
   * A caixa visível mais "de cima": a última do DOM, que é a que foi aberta.
   *
   * **Quem já se anuncia não é tratado aqui**, e isso não é escrúpulo: o
   * `Aviso.confirmar` do `js/aviso-sistema.js` monta `div.modal-bg.open` com
   * `role="dialog"` e `aria-modal` NO VÉU, e dentro um `div.modal`. Sem esta
   * guarda, a peça marcaria a caixa de dentro também — diálogo dentro de
   * diálogo para o leitor de tela — e as DUAS armadilhas de Tab disputariam a
   * mesma tecla, cada uma chamando `focus()` e `preventDefault()`.
   */
  function caixaNoAr() {
    const todas = [...document.querySelectorAll(CAIXA)].filter((el) => {
      // Caixa dentro de caixa (`.modal > .modal-content`) conta uma vez só, a de fora.
      if (el.parentElement && el.parentElement.closest(CAIXA)) return false;
      if (el.parentElement && el.parentElement.closest('[aria-modal="true"]')) return false;
      return visivel(el);
    });
    return todas.length ? todas[todas.length - 1] : null;
  }

  let agendado = false;
  function reavaliar() {
    if (agendado) return;
    agendado = true;
    requestAnimationFrame(() => {
      agendado = false;
      const agora = caixaNoAr();
      if (agora === ativo) return;
      if (ativo) desmontar(ativo);
      if (agora) montar(agora);
    });
  }

  /* Observa o que muda a visibilidade: a classe (`open`, `active`), o `style`
     inline (`display: block`), o `hidden`, e a caixa que a tela cria na hora. */
  if (typeof MutationObserver === 'function') {
    new MutationObserver(reavaliar).observe(document.documentElement, {
      attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'],
      childList: true, subtree: true,
    });
  }

  /* O Tab cicla dentro da caixa. Em CAPTURA, porque a tela pode tratar o Tab
     depois; e só no salto da ponta, para não atrapalhar o Tab do meio. */
  document.addEventListener('keydown', (e) => {
    if (!ativo || !ativo.isConnected) return;
    if (e.key === 'Escape') {
      const fechar = botaoDeFechar(ativo);
      if (fechar) { e.preventDefault(); fechar.click(); }
      return;
    }
    if (e.key !== 'Tab') return;
    const lista = focaveis(ativo);
    if (!lista.length) return;            // sem saída pelo teclado: não prende
    const primeiro = lista[0];
    const ultimo = lista[lista.length - 1];
    const foco = document.activeElement;
    if (!ativo.contains(foco)) {          // o foco escapou: traz de volta
      e.preventDefault();
      (e.shiftKey ? ultimo : primeiro).focus({ preventScroll: true });
      return;
    }
    if (!e.shiftKey && foco === ultimo) { e.preventDefault(); primeiro.focus({ preventScroll: true }); }
    else if (e.shiftKey && foco === primeiro) { e.preventDefault(); ultimo.focus({ preventScroll: true }); }
  }, true);

  /* A varredura inicial: modal que já nasce aberto na tela (raro, mas existe). */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reavaliar);
  } else {
    reavaliar();
  }

  window.Dialogo = {
    /** A caixa que está no ar, para quem precisar saber (e para a prova). */
    noAr: () => ativo,
    focaveis,
    botaoDeFechar,
    reavaliar,
  };
})();
