/* grid.js — largura de coluna ajustável em tabelas de listagem.
 *
 * Uso (nada de JS na página):
 *   <script src="/js/grid.js"></script>
 *   <div class="tbl-wrap" data-grid="produtos"> <table>…</table> </div>
 *
 * O nome em data-grid é a chave da preferência no localStorage; use um por
 * tela. Duas telas com o mesmo nome dividem as mesmas larguras.
 *
 * Por que instrumentar em vez de reescrever a tabela: Pessoas e Pedidos
 * declaram as colunas em JS e montam o <thead> na mão, mas as outras telas
 * têm <th> estáticos no HTML. Aqui o header continua sendo da página — este
 * script só mede, injeta o handle e guarda a largura.
 *
 * A coluna é identificada pelo TEXTO do cabeçalho, não pela posição: as telas
 * com seletor de colunas reordenam e escondem <th>, e por índice a largura
 * salva iria parar na coluna errada.
 */
(function () {
  'use strict';

  var PREFIX = 'grid:';
  var MIN = 60;

  // CSS junto do script: assim uma página nova precisa só do <script>.
  function injetarCss() {
    if (document.getElementById('grid-js-css')) return;
    var st = document.createElement('style');
    st.id = 'grid-js-css';
    st.textContent = [
      '.grid-on { table-layout: fixed; }',
      '.grid-on th { position: relative; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.grid-on td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      // Célula com menu suspenso não pode recortar: o menu é filho dela e
      // sumiria atrás da borda da coluna.
      '.grid-on td:has(.dropdown) { overflow: visible; }',
      '.grid-resizer { position: absolute; right: 0; top: 0; bottom: 0; width: 6px;',
      '  cursor: col-resize; user-select: none; border-right: 1px solid var(--border-strong); }',
      '.grid-resizer:hover, .grid-resizer.resizing { background: var(--accent); opacity: 0.4; }',
      // Coluna do lápis: o padding padrão do td (14px de cada lado) não deixa
      // largura para o botão e ele sairia cortado.
      'th.col-editar, td.col-editar { width: 40px; padding-left: 3px; padding-right: 3px;',
      '  text-align: center; overflow: visible; }',
      // Idem para o checkbox de seleção: nos 14px de padding padrão ele não
      // cabe, e o text-overflow desenha um "…" ao lado dele.
      'th.col-sel, td.col-sel { width: 34px; padding-left: 3px; padding-right: 3px;',
      '  text-align: center; overflow: visible; text-overflow: clip; }',
      'td.col-editar .btn { padding: 4px 6px; }',
      'td.col-editar .btn svg { margin-right: 0; }',
    ].join('\n');
    document.head.appendChild(st);
  }

  // Piso real da coluna: o min-width que a página declarou no CSS para aquele
  // <th>. Sem isto, largura salva antiga (ou o encaixe final, que desconta da
  // última coluna) encolhia a coluna abaixo do que o conteúdo precisa e o
  // texto voltava a ser cortado — a página pedia 200px e recebia 92.
  // Sem min-width declarado, vale o MIN histórico.
  function minDaColuna(th) {
    var v = parseFloat(window.getComputedStyle(th).minWidth);
    return (isFinite(v) && v > 0) ? Math.round(v) : MIN;
  }

  function chaveColuna(th, i) {
    // Sem as setas de ordenação, que mudam conforme o estado do header.
    var txt = (th.textContent || '').replace(/[▲▼↕]/g, '').trim().toLowerCase();
    return txt ? txt.slice(0, 40) : 'col' + i;
  }

  function initGrid(nome, tabela) {
    var table = tabela || document.querySelector('.tbl-wrap table');
    if (!table || !table.tHead || !table.tHead.rows.length) return null;

    var storeKey = PREFIX + nome;
    var larguras = {};
    try { larguras = JSON.parse(localStorage.getItem(storeKey)) || {}; } catch (e) { larguras = {}; }
    var salvar = function () {
      try { localStorage.setItem(storeKey, JSON.stringify(larguras)); } catch (e) { /* quota/privado */ }
    };

    var medido = false;
    // Largura medida do conteúdo, por coluna. Guardada para que re-render de
    // header (ordenação, filtro) reaproveite em vez de remedir e dar pulos.
    var medidas = {};

    // Tabela em aba fechada mede zero. Medir aí congelaria todas as colunas no
    // valor de reserva, e o usuário abriria a aba com o grid já errado.
    function visivel() { return !!table.offsetParent && table.getBoundingClientRect().width > 0; }

    function aplicar() {
      var linha = table.tHead.rows[0];
      var ths = [].slice.call(linha.cells);
      if (!ths.length) return;
      if (!visivel() && !Object.keys(larguras).length) return;

      var chaves = ths.map(chaveColuna);
      // Coluna cuja largura ainda não se conhece: nem ajustada pelo usuário,
      // nem medida antes. Só por ela vale pagar uma medição.
      var novas = chaves.filter(function (k) { return !larguras[k] && !medidas[k]; });

      if (novas.length) {
        // Medir exige layout natural. Ordenar re-renderiza o <thead> inteiro, e
        // medir com o fixed ligado devolveria a divisão igual que ele impõe a
        // <th> sem largura — foi assim que ordenar achatava todas as colunas no
        // mesmo tamanho.
        table.classList.remove('grid-on');
        ths.forEach(function (th) { th.style.width = ''; });
        table.style.width = '';
        ths.forEach(function (th, i) {
          medidas[chaves[i]] = Math.round(th.getBoundingClientRect().width) || 120;
        });
      }

      // O clamp NÃO reescreve larguras[]: a preferência do usuário fica como
      // ele deixou; só não é aplicada abaixo do piso que a página declarou.
      var atual = chaves.map(function (k, i) {
        return Math.max(larguras[k] || medidas[k] || 120, minDaColuna(ths[i]));
      });

      table.classList.add('grid-on');
      var total = 0;
      ths.forEach(function (th, i) {
        th.dataset.gridKey = chaveColuna(th, i);
        th.style.width = atual[i] + 'px';
        total += atual[i];
        // Coluna de largura fixa (lápis, seleção) não ganha handle: não há o
        // que ajustar e o arraste só atrapalharia.
        if (th.classList.contains('col-editar') || th.classList.contains('col-sel')) return;
        if (!th.querySelector('.grid-resizer')) {
          var r = document.createElement('span');
          r.className = 'grid-resizer';
          r.addEventListener('mousedown', function (ev) { iniciarResize(ev, th); });
          th.appendChild(r);
        }
      });
      ajustarLargura(total);
    }

    // A tabela recebe a soma das colunas. Se sobrar espaço no wrapper, a sobra
    // vai para a ÚLTIMA coluna — sem isso o table-layout:fixed reparte esse
    // excedente entre todas e o arraste do usuário vira só uma proporção.
    // A sobra não é gravada: é resultado da janela, não escolha de ninguém.
    function ajustarLargura(total) {
      var wrap = table.parentElement;
      var disp = wrap ? wrap.clientWidth : 0;
      var ths = [].slice.call(table.tHead.rows[0].cells);
      var ultima = ths[ths.length - 1];
      var sobra = disp - total;
      if (sobra > 0 && ultima) {
        var kUlt = ultima.dataset.gridKey;
        var base = Math.max(larguras[kUlt] || parseInt(ultima.style.width, 10) || MIN, minDaColuna(ultima));
        ultima.style.width = (base + sobra) + 'px';
        table.style.width = disp + 'px';
      } else {
        table.style.width = total + 'px';
      }

      // Encaixe final. As medidas são arredondadas para pixel inteiro e o
      // wrapper tem borda, então sobra um fio de estouro que basta para o
      // navegador desenhar a barra de rolagem horizontal numa tabela que
      // caberia inteira. Devolve o excedente tirando da última coluna.
      if (wrap && wrap.scrollWidth > wrap.clientWidth && ultima) {
        var excesso = wrap.scrollWidth - wrap.clientWidth;
        var atualUlt = parseInt(ultima.style.width, 10) || 0;
        if (atualUlt - excesso >= minDaColuna(ultima)) {
          ultima.style.width = (atualUlt - excesso) + 'px';
          table.style.width = (parseInt(table.style.width, 10) - excesso) + 'px';
        }
      }
    }

    function iniciarResize(ev, th) {
      ev.preventDefault();
      ev.stopPropagation();
      var alvo = ev.currentTarget;
      var key = th.dataset.gridKey;
      var startX = ev.clientX;
      var startW = parseInt(th.style.width, 10) || Math.round(th.getBoundingClientRect().width);
      alvo.classList.add('resizing');

      function onMove(e) {
        var novo = Math.max(minDaColuna(th), startW + (e.clientX - startX));
        th.style.width = novo + 'px';
        larguras[key] = novo;
        var total = 0;
        [].slice.call(table.tHead.rows[0].cells).forEach(function (c) {
          total += parseInt(c.style.width, 10) || 0;
        });
        table.style.width = total + 'px';
      }
      function onUp() {
        alvo.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        salvar();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    aplicar();

    // A página monta o corpo (e às vezes o próprio header) depois, por fetch.
    // Enquanto a tabela está vazia a medida natural não vale nada, então a
    // primeira remontagem com linhas remede — uma vez só, e nunca por cima de
    // largura que o usuário já ajustou.
    var obs = new MutationObserver(function () {
      // O próprio aplicar() mexe no thead (injeta o handle) e reentraria aqui:
      // desliga, descarta a fila que ele acabou de gerar e religa.
      obs.disconnect();
      var temLinhas = table.tBodies[0] && table.tBodies[0].rows.length;
      if (!medido && temLinhas && visivel()) {
        medido = true;
        // Zera o que foi medido com a tabela vazia — larguras de cabeçalho sem
        // conteúdo embaixo não representam nada.
        medidas = {};
        table.classList.remove('grid-on');
        [].slice.call(table.tHead.rows[0].cells).forEach(function (th) { th.style.width = ''; });
        table.style.width = '';
      }
      aplicar();
      obs.takeRecords();
      observar();
    });
    function observar() {
      obs.observe(table.tHead, { childList: true });
      if (table.tBodies[0]) obs.observe(table.tBodies[0], { childList: true });
    }
    observar();

    // Aba que abre não muda o DOM da tabela — nada dispararia o observer acima.
    // O ResizeObserver pega justamente a passagem de largura zero para real.
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () {
        if (medido || !visivel()) return;
        if (!(table.tBodies[0] && table.tBodies[0].rows.length)) return;
        medido = true;
        medidas = {};
        table.classList.remove('grid-on');
        [].slice.call(table.tHead.rows[0].cells).forEach(function (th) { th.style.width = ''; });
        table.style.width = '';
        aplicar();
      });
      ro.observe(table);
    }

    var tResize = null;
    window.addEventListener('resize', function () {
      var total = 0;
      [].slice.call(table.tHead.rows[0].cells).forEach(function (c) {
        var k = c.dataset.gridKey;
        total += larguras[k] || parseInt(c.style.width, 10) || 0;
      });
      ajustarLargura(total);

      // Encolher a janela deixava a tabela na largura medida na abertura, e ela
      // passava a rolar na horizontal para sempre. Quando o que está aplicado
      // não cabe mais, remede do zero — como se a página tivesse sido aberta
      // já nesta largura. A remedição respeita min-width e não toca em
      // larguras[], então piso declarado e arraste do usuário sobrevivem.
      clearTimeout(tResize);
      tResize = setTimeout(function () {
        var wrap = table.parentElement;
        if (!wrap || !visivel()) return;
        if (wrap.scrollWidth <= wrap.clientWidth + 1) return;
        medidas = {};
        table.classList.remove('grid-on');
        [].slice.call(table.tHead.rows[0].cells).forEach(function (th) { th.style.width = ''; });
        table.style.width = '';
        aplicar();
      }, 180);
    });

    return { aplicar: aplicar };
  }

  function autoInit() {
    injetarCss();
    [].slice.call(document.querySelectorAll('[data-grid]')).forEach(function (el) {
      if (el.dataset.gridPronto) return;
      var table = el.tagName === 'TABLE' ? el : el.querySelector('table');
      if (!table) return;
      el.dataset.gridPronto = '1';
      initGrid(el.dataset.grid, table);
    });
  }

  // Algumas telas montam a tabela inteira em string depois de um filtro — o
  // data-grid delas nem existe no carregamento. Uma varredura curta, agendada
  // no ocioso, recolhe esses casos sem custo perceptível.
  function vigiarNovosGrids() {
    var pendente = false;
    new MutationObserver(function () {
      if (pendente) return;
      pendente = true;
      (window.requestIdleCallback || window.setTimeout)(function () {
        pendente = false;
        autoInit();
      }, { timeout: 500 });
    }).observe(document.body, { childList: true, subtree: true });
  }

  function iniciar() { autoInit(); vigiarNovosGrids(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();

  window.initGrid = initGrid;
})();
