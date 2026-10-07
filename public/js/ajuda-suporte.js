/*
 * ajuda-suporte.js — o modal que o botão Suporte da topbar abre.
 *
 * É a PORTA de entrada do suporte, e não o suporte em si: ele oferece os
 * caminhos e sai da frente. Quem fecha volta exatamente para a tela em que
 * estava, com o trabalho intacto — é por isso que é modal e não página.
 *
 * ── Três blocos, nesta ordem ───────────────────────────────────────────────
 *
 *   1. Suporte          abrir chamado · meus chamados   (existe hoje)
 *   2. Central de ajuda artigos e busca                 (próxima fase)
 *   3. Comunidade       canais oficiais                 (quando houver)
 *
 * A ordem é deliberada: quem clicou em "Suporte" quer falar com gente. Pôr o
 * autoatendimento primeiro para desviar volume é tentador e irrita quem já
 * tentou resolver sozinho.
 *
 * ── O que NÃO está aqui, e por quê ─────────────────────────────────────────
 *
 * Os blocos 2 e 3 aparecem como "em breve", com o botão desabilitado. Não há
 * link para página que não existe, nem canal inventado: um WhatsApp fictício
 * no modal de suporte é pior que bloco nenhum, porque alguém vai tentar.
 * Quando a Central de Ajuda existir, o bloco 2 ganha o link; quando houver
 * canais configurados, o 3 lê a configuração e se desenha.
 *
 * ── Carregamento ───────────────────────────────────────────────────────────
 *
 * O `sidebar.js` traz este arquivo no PRIMEIRO clique, não no boot — ver a
 * nota em `abrirAjudaESuporte`. Por isso tudo aqui é autocontido: cria o
 * próprio CSS, não depende de ordem de script e não exige nada da tela.
 */
(function () {
  'use strict';
  if (window.AjudaSuporte) return;             // já carregado

  var ID = 'ajuda-suporte-modal';
  var ultimoFoco = null;

  function css() {
    if (document.getElementById('ajuda-suporte-css')) return;
    var st = document.createElement('style');
    st.id = 'ajuda-suporte-css';
    st.textContent = [
      /* O fundo escurece a tela sem apagá-la: a pessoa continua vendo onde
         estava, que é a diferença entre um modal e uma navegação. */
      // .58 e nao .72: a tela de tras precisa continuar RECONHECIVEL. Escurecer
      // demais faz o modal parecer uma pagina nova, que e exatamente o que ele
      // nao e — quem fecha volta para onde estava, e ve isso o tempo todo.
      '.as-fundo{position:fixed;inset:0;background:rgba(3,7,18,.58);z-index:4000;',
      '  display:flex;align-items:center;justify-content:center;padding:24px;',
      '  opacity:0;transition:opacity .16s ease}',
      '.as-fundo.aberto{opacity:1}',
      '.as-caixa{background:var(--bg-2,#141b2d);border:1px solid var(--border,#263149);',
      '  border-radius:var(--r-lg,16px);width:100%;max-width:520px;max-height:88vh;',
      '  display:flex;flex-direction:column;overflow:hidden;',
      '  box-shadow:0 30px 70px rgba(0,0,0,.55);',
      '  transform:translateY(8px) scale(.99);transition:transform .16s ease}',
      '.as-fundo.aberto .as-caixa{transform:none}',
      /* Cabeçalho com a cor da marca, como no resto do ERP. */
      '.as-topo{display:flex;align-items:center;justify-content:space-between;gap:12px;',
      '  padding:18px 20px;border-bottom:1px solid var(--border,#263149);',
      '  background:var(--bg-3,#1b2338)}',
      '.as-topo h2{margin:0;font-size:1.06rem;font-weight:700;color:var(--text-0,#e8eefc)}',
      '.as-fechar{background:none;border:0;color:var(--text-2,#9fb3d6);cursor:pointer;',
      '  font-size:26px;line-height:1;width:36px;height:36px;border-radius:8px;flex:none}',
      '.as-fechar:hover{background:var(--bg-hover,#223049);color:var(--text-0,#fff)}',
      '.as-fechar:focus-visible{outline:2px solid var(--accent,#2563EB);outline-offset:2px}',
      '.as-corpo{overflow-y:auto;padding:4px 0}',
      /* Um bloco por assunto, separados por filete — a leitura é de cima para
         baixo e cada um se basta. */
      '.as-bloco{display:flex;gap:14px;padding:18px 20px;border-bottom:1px solid var(--border,#263149)}',
      '.as-bloco:last-child{border-bottom:0}',
      '.as-ic{width:42px;height:42px;border-radius:12px;flex:none;display:flex;',
      '  align-items:center;justify-content:center;font-size:20px}',
      '.as-ic.suporte{background:rgba(34,197,94,.16)}',
      '.as-ic.ajuda{background:rgba(59,130,246,.16)}',
      '.as-ic.comunidade{background:rgba(168,85,247,.16)}',
      '.as-txt{flex:1;min-width:0}',
      '.as-txt h3{margin:0 0 4px;font-size:.98rem;font-weight:700;color:var(--text-0,#e8eefc)}',
      '.as-txt p{margin:0 0 12px;font-size:.87rem;line-height:1.45;color:var(--text-2,#9fb3d6)}',
      '.as-acoes{display:flex;gap:8px;flex-wrap:wrap}',
      '.as-bt{display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:8px;',
      '  font-size:.87rem;font-weight:600;text-decoration:none;cursor:pointer;border:1px solid transparent}',
      '.as-bt.primario{background:var(--accent,#2563EB);color:#fff}',
      '.as-bt.primario:hover{filter:brightness(1.08)}',
      '.as-bt.secundario{background:transparent;border-color:var(--border-strong,#33425f);',
      '  color:var(--text-1,#cfdcf2)}',
      '.as-bt.secundario:hover{background:var(--bg-hover,#223049)}',
      '.as-bt:focus-visible{outline:2px solid var(--accent,#2563EB);outline-offset:2px}',
      '.as-bt[disabled]{opacity:.45;cursor:default;pointer-events:none}',
      '.as-embreve{display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.06em;',
      '  text-transform:uppercase;padding:3px 9px;border-radius:999px;',
      '  background:var(--bg-hover,#223049);color:var(--text-3,#7f9ac4);margin-left:8px;vertical-align:middle}',
      /* Celular: o modal vira uma folha que sobe e ocupa a largura toda, e os
         botões passam a linha inteira. Encolher o desktop deixaria dois
         botões de 90px disputando 330px e o fechar no canto inalcançável. */
      '@media (max-width:640px){',
      '  .as-fundo{padding:0;align-items:flex-end}',
      '  .as-caixa{max-width:100%;max-height:92vh;border-radius:16px 16px 0 0}',
      '  .as-topo{padding:16px}',
      '  .as-bloco{padding:16px;gap:12px}',
      '  .as-acoes{flex-direction:column}',
      '  .as-bt{width:100%;justify-content:center;padding:12px 16px}',
      '  .as-fechar{width:42px;height:42px}',
      '}',
    ].join('');
    document.head.appendChild(st);
  }

  function bloco(o) {
    var d = document.createElement('div');
    d.className = 'as-bloco';

    var ic = document.createElement('div');
    ic.className = 'as-ic ' + o.tipo;
    ic.textContent = o.icone;

    var tx = document.createElement('div');
    tx.className = 'as-txt';

    var h = document.createElement('h3');
    h.textContent = o.titulo;
    if (o.emBreve) {
      var tag = document.createElement('span');
      tag.className = 'as-embreve';
      tag.textContent = 'Em breve';
      h.appendChild(tag);
    }
    var p = document.createElement('p');
    p.textContent = o.texto;

    var acoes = document.createElement('div');
    acoes.className = 'as-acoes';
    (o.acoes || []).forEach(function (a) {
      var el;
      if (a.href) {
        el = document.createElement('a');
        el.href = a.href;
      } else {
        el = document.createElement('button');
        el.type = 'button';
        el.disabled = true;
      }
      el.className = 'as-bt ' + (a.estilo || 'secundario');
      el.textContent = a.texto;
      acoes.appendChild(el);
    });

    tx.appendChild(h);
    tx.appendChild(p);
    if (acoes.childNodes.length) tx.appendChild(acoes);
    d.appendChild(ic);
    d.appendChild(tx);
    return d;
  }

  function montar() {
    css();
    var fundo = document.createElement('div');
    fundo.className = 'as-fundo';
    fundo.id = ID;
    fundo.setAttribute('role', 'dialog');
    fundo.setAttribute('aria-modal', 'true');
    fundo.setAttribute('aria-labelledby', 'as-titulo');

    var caixa = document.createElement('div');
    caixa.className = 'as-caixa';

    var topo = document.createElement('div');
    topo.className = 'as-topo';
    var h2 = document.createElement('h2');
    h2.id = 'as-titulo';
    h2.textContent = 'Ajuda e Suporte';
    var bt = document.createElement('button');
    bt.className = 'as-fechar';
    bt.type = 'button';
    bt.setAttribute('aria-label', 'Fechar');
    bt.innerHTML = '&times;';
    bt.onclick = fechar;
    topo.appendChild(h2);
    topo.appendChild(bt);

    var corpo = document.createElement('div');
    corpo.className = 'as-corpo';

    corpo.appendChild(bloco({
      tipo: 'suporte', icone: '🎧', titulo: 'Suporte',
      texto: 'Fale com a equipe do Licite Agora. Abra um chamado e acompanhe a resposta por aqui mesmo.',
      acoes: [
        { texto: 'Abrir chamado', href: '/suporte/novo.html', estilo: 'primario' },
        { texto: 'Meus chamados', href: '/suporte/chamados.html', estilo: 'secundario' },
      ],
    }));

    corpo.appendChild(bloco({
      tipo: 'ajuda', icone: '📘', titulo: 'Central de ajuda', emBreve: true,
      texto: 'Encontre informações detalhadas sobre as funcionalidades do Licite Agora, por assunto e com busca.',
      acoes: [{ texto: 'Abrir ajuda' }],     // sem href: nada de página falsa
    }));

    corpo.appendChild(bloco({
      tipo: 'comunidade', icone: '💬', titulo: 'Comunidade e canais', emBreve: true,
      texto: 'Nossos canais oficiais de novidades e troca de experiências entre quem usa o sistema.',
    }));

    caixa.appendChild(topo);
    caixa.appendChild(corpo);
    fundo.appendChild(caixa);

    // Clique no fundo fecha; clique na caixa, não.
    fundo.addEventListener('mousedown', function (e) { if (e.target === fundo) fechar(); });
    document.body.appendChild(fundo);
    return fundo;
  }

  function aoTeclar(e) {
    if (e.key === 'Escape') { fechar(); return; }
    if (e.key !== 'Tab') return;
    /* O foco fica preso no modal enquanto ele está aberto: sem isso, o Tab
       passeia pela tela de trás, que está visualmente inativa. */
    var m = document.getElementById(ID);
    if (!m) return;
    var focaveis = m.querySelectorAll('a[href], button:not([disabled])');
    if (!focaveis.length) return;
    var primeiro = focaveis[0];
    var ultimo = focaveis[focaveis.length - 1];
    if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
    else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
  }

  function abrir() {
    var m = document.getElementById(ID) || montar();
    ultimoFoco = document.activeElement;
    m.style.display = 'flex';
    // Em dois tempos para a transição acontecer, e não saltar direto ao fim.
    requestAnimationFrame(function () { m.classList.add('aberto'); });
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', aoTeclar);
    var bt = document.getElementById('btnSuporte');
    if (bt) bt.setAttribute('aria-expanded', 'true');
    var primeiro = m.querySelector('a[href], button:not([disabled])');
    if (primeiro) primeiro.focus();
  }

  function fechar() {
    var m = document.getElementById(ID);
    if (!m) return;
    m.classList.remove('aberto');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', aoTeclar);
    var bt = document.getElementById('btnSuporte');
    if (bt) bt.setAttribute('aria-expanded', 'false');
    setTimeout(function () { m.style.display = 'none'; }, 160);
    // Devolve o foco a quem abriu: quem usa teclado não recomeça do topo.
    if (ultimoFoco && typeof ultimoFoco.focus === 'function') ultimoFoco.focus();
  }

  window.AjudaSuporte = { abrir: abrir, fechar: fechar };
})();
