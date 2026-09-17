/**
 * arrastar-ordenar.js — reordenação por arrastar, com mouse E dedo.
 *
 * ── Por que não HTML5 Drag and Drop ─────────────────────────────────────────
 *
 * O ERP já tem arrasto em `kanban.js` e no funil do CRM, e os dois usam
 * `draggable=true` + `ondragstart`. Isso funciona no desktop e **não funciona
 * no celular**: a API HTML5 de arrasto nunca foi implementada em navegador
 * móvel. Como esta fase exige toque, o caminho é Pointer Events — um só código
 * para mouse, dedo e caneta.
 *
 * ── Por que não uma biblioteca ──────────────────────────────────────────────
 *
 * Nenhuma está instalada, e a que resolveria (SortableJS) traz ~40 kB para um
 * problema de lista vertical curta. O que segue são ~150 linhas sem dependência.
 *
 * ── Como usar ───────────────────────────────────────────────────────────────
 *
 *   ativarArrasto(containerEl, {
 *     item: '.linha',            // seletor dos itens arrastáveis
 *     handle: '.arrastar',       // (opcional) só este pedaço inicia o arrasto
 *     aoSoltar: (ordemIds) => …  // ids na ordem nova, quando o usuário solta
 *   });
 *
 * Cada item precisa de `data-id`. O `aoSoltar` só é chamado quando a ordem
 * MUDOU — soltar no mesmo lugar não gera gravação.
 */

(function (global) {
  'use strict';

  /** Distância mínima antes de considerar arrasto, em px. */
  const LIMIAR = 6;
  /** No toque, segurar este tempo inicia o arrasto sem precisar deslizar. */
  const ESPERA_TOQUE = 180;

  function ativarArrasto(container, opcoes) {
    if (!container) return;

    /* As telas chamam isto a cada repinte, e o container costuma ser o MESMO
       nó (só o innerHTML muda). Sem desligar a ativação anterior, cada repinte
       empilha mais um jogo de ouvintes — e os três de `document` não morrem
       junto com os nós, então crescem sem limite enquanto a tela viver: no
       catálogo são 22 ativações por `carregar()`, ou 66 ouvintes novos a cada
       recarga da lista. Medido em 16/09. */
    if (container.__desligarArrasto) container.__desligarArrasto();
    const ouvintes = [];
    const ouvir = (alvo, tipo, fn, opts) => {
      alvo.addEventListener(tipo, fn, opts);
      ouvintes.push([alvo, tipo, fn, opts]);
    };
    container.__desligarArrasto = () => {
      for (const [alvo, tipo, fn, opts] of ouvintes) alvo.removeEventListener(tipo, fn, opts);
      ouvintes.length = 0;
      delete container.__desligarArrasto;
    };

    const seletorItem = opcoes.item;
    const seletorHandle = opcoes.handle || null;
    const aoSoltar = opcoes.aoSoltar || (() => {});

    let arrastando = null;      // elemento sendo movido
    let fantasma = null;        // marcador da posição de destino
    let ordemInicial = null;
    let inicio = null;          // {x, y}
    let ativo = false;
    let timerToque = null;

    const idsAtuais = () => [...container.querySelectorAll(seletorItem)]
      .map((el) => el.dataset.id).filter(Boolean);

    function comecar(alvo, ev) {
      arrastando = alvo;
      ordemInicial = idsAtuais().join(',');
      ativo = true;
      alvo.classList.add('arrastando');
      /* O fantasma é um espaço vazio do tamanho exato do item: sem ele, a lista
         "pula" quando o item sai do fluxo e o usuário perde a referência de
         onde vai soltar. */
      fantasma = document.createElement('div');
      fantasma.className = 'arrasto-fantasma';
      fantasma.style.height = alvo.getBoundingClientRect().height + 'px';
      alvo.parentNode.insertBefore(fantasma, alvo.nextSibling);
      alvo.style.position = 'relative';
      alvo.style.zIndex = '20';
      alvo.style.pointerEvents = 'none';
      mover(ev);
    }

    function mover(ev) {
      if (!ativo || !arrastando) return;
      const dy = ev.clientY - inicio.y;
      arrastando.style.transform = `translateY(${dy}px)`;

      /* Onde soltar: o item cujo MEIO está acima do ponteiro é o que fica
         antes. Comparar pelo meio, e não pela borda, é o que evita a lista
         tremer quando o cursor passa exatamente na divisa. */
      const irmaos = [...container.querySelectorAll(seletorItem)]
        .filter((el) => el !== arrastando);
      let antesDe = null;
      for (const el of irmaos) {
        const r = el.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { antesDe = el; break; }
      }
      if (antesDe) container.insertBefore(fantasma, antesDe);
      else container.appendChild(fantasma);
    }

    function soltar() {
      clearTimeout(timerToque);
      if (!ativo || !arrastando) { limpar(); return; }
      // O item assume o lugar do fantasma.
      fantasma.parentNode.insertBefore(arrastando, fantasma);
      const nova = idsAtuais();
      const mudou = nova.join(',') !== ordemInicial;
      limpar();
      if (mudou) aoSoltar(nova);
    }

    function limpar() {
      clearTimeout(timerToque);
      if (arrastando) {
        arrastando.classList.remove('arrastando');
        arrastando.style.transform = '';
        arrastando.style.position = '';
        arrastando.style.zIndex = '';
        arrastando.style.pointerEvents = '';
      }
      if (fantasma && fantasma.parentNode) fantasma.parentNode.removeChild(fantasma);
      arrastando = null; fantasma = null; ativo = false; inicio = null;
      document.body.classList.remove('arrastando-lista');
    }

    ouvir(container, 'pointerdown', (ev) => {
      // Só botão principal; e nunca a partir de um controle de verdade.
      if (ev.button !== 0) return;
      if (ev.target.closest('button, a, input, select, textarea') && !ev.target.closest(seletorHandle || '\0')) return;
      const alvo = ev.target.closest(seletorItem);
      if (!alvo || !container.contains(alvo)) return;
      if (seletorHandle && !ev.target.closest(seletorHandle)) return;

      inicio = { x: ev.clientX, y: ev.clientY };
      const partir = () => {
        if (!inicio) return;
        document.body.classList.add('arrastando-lista');
        comecar(alvo, ev);
      };

      if (ev.pointerType === 'touch') {
        /* No toque, esperar um instante antes de agarrar deixa a ROLAGEM
           funcionar: sem isso, deslizar a lista viraria arrasto e o usuário não
           conseguiria mais rolar a página com o dedo sobre um item. */
        timerToque = setTimeout(partir, ESPERA_TOQUE);
      } else {
        // No mouse, espera um movimento mínimo — assim um clique continua clique.
        const talvez = (e2) => {
          if (!inicio) return;
          if (Math.abs(e2.clientY - inicio.y) > LIMIAR || Math.abs(e2.clientX - inicio.x) > LIMIAR) {
            document.removeEventListener('pointermove', talvez);
            partir();
          }
        };
        document.addEventListener('pointermove', talvez);
        document.addEventListener('pointerup', function so() {
          document.removeEventListener('pointermove', talvez);
          document.removeEventListener('pointerup', so);
        });
      }
    });

    ouvir(document, 'pointermove', (ev) => {
      if (!ativo) {
        // Dedo deslizou antes do tempo: era rolagem, não arrasto.
        if (timerToque && inicio && Math.abs(ev.clientY - inicio.y) > LIMIAR * 2) {
          clearTimeout(timerToque); timerToque = null; inicio = null;
        }
        return;
      }
      ev.preventDefault();
      mover(ev);
    }, { passive: false });

    ouvir(document, 'pointerup', () => { if (inicio || ativo) soltar(); });
    ouvir(document, 'pointercancel', limpar);
  }

  global.ativarArrasto = ativarArrasto;
})(window);
