/**
 * theme-boot.js — aplica o tema ANTES de a página pintar.
 *
 * ── Por que este arquivo existe ─────────────────────────────────────────────
 *
 * `sidebar.js` carrega no FIM do <body>, depois de todo o CSS e de todo o HTML.
 * Como `:root` é o tema escuro, quem usa tema claro via a página inteira escura
 * e só então ela clareava — o "flash" clássico. Não dava para resolver movendo
 * `sidebar.js` para o <head>: ele monta o menu e precisa do DOM.
 *
 * A solução é este script, que é a menor coisa possível que resolve: síncrono,
 * sem dependência nenhuma, carregado no <head> ANTES das folhas de estilo. Ele
 * só escreve um atributo em <html>; quando o CSS chega, o seletor
 * `[data-theme="claro"]` já está valendo e o primeiro paint já sai certo.
 *
 * Precisa ser SÍNCRONO (sem `defer`/`async`): o navegador tem de executá-lo
 * antes de continuar montando a página. É por isso que ele é minúsculo.
 *
 * ── Tema custom legado ──────────────────────────────────────────────────────
 *
 * Antes de 2026-09-11 o tema era um par de cores livres (`custom:#bg:#accent`),
 * e 5 usuários reais têm um salvo — quatro deles com fundo CLARO. Aqui não se
 * recalcula a paleta deles (isso é trabalho do `sidebar.js`, que tem a função de
 * mistura); o que se faz é decidir, pela luminância do fundo escolhido, se a
 * base é clara ou escura. Com isso o fundo já nasce certo e o flash some para
 * eles também — as cores exatas entram logo em seguida.
 */
(function () {
  var LS = 'appTheme';

  /** Claro quando a cor é clara. Fórmula de luminância relativa (WCAG). */
  function ehClaro(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return false;
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    // 0.5 separa bem: #f5f7f9 dá ~0.96, #030202 dá ~0.01.
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
  }

  function resolver(valor) {
    var v = String(valor || '').trim();
    if (v === 'claro') return 'claro';
    if (v === 'escuro' || v === 'padrao' || v === '') return 'escuro';
    var c = /^custom:(#[0-9a-fA-F]{6}):/.exec(v);
    if (c) return ehClaro(c[1]) ? 'claro' : 'escuro';
    return 'escuro';                       // valor desconhecido: o padrão histórico
  }

  var base = 'escuro';
  try {
    base = resolver(localStorage.getItem(LS));
  } catch (e) {
    // localStorage bloqueado (modo privado, iframe de terceiro): fica no escuro,
    // que é o comportamento de sempre. Nunca deixar a página sem tema.
  }
  document.documentElement.setAttribute('data-theme', base);

  /**
   * Barra do navegador no celular (`theme-color`).
   *
   * Sem isto, a barra fica escura numa tela clara — a moldura do sistema
   * desmente o tema da página. O <meta> pode não existir; quando não existe, é
   * criado. Roda aqui, e não no `sidebar.js`, para já sair certo no primeiro
   * paint, junto com o resto.
   */
  try {
    var m = document.querySelector('meta[name="theme-color"]');
    if (!m) {
      m = document.createElement('meta');
      m.setAttribute('name', 'theme-color');
      (document.head || document.documentElement).appendChild(m);
    }
    m.setAttribute('content', base === 'claro' ? '#f1f4f8' : '#0b1120');
  } catch (e) { /* sem <head> ainda: a barra fica no padrão, e é só cosmético */ }
})();
