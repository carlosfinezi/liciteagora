/**
 * Fase 3.3 — topbar global e preparação da identidade.
 *
 * ── O que este arquivo prova, e por que assim ───────────────────────────────
 *
 * A topbar É CONSTRUÍDA de verdade, num DOM simulado, e depois inspecionada.
 * Não é regex sobre o fonte. A precaução vem do relatório 24, onde 14 testes
 * passaram verdes sobre um `sidebar.js` que nem parseava: texto quebrado casa
 * com regex do mesmo jeito que texto bom.
 *
 * Onde o alvo É o arquivo — quantas chamadas de API existem, se um token foi
 * trocado por cor literal, se uma reserva de CSS voltou — a leitura é do fonte
 * mesmo, mas sempre com os COMENTÁRIOS removidos antes. Três vezes seguidas
 * (relatórios 24, 28, 29) um teste meu casou com o próprio comentário que
 * explicava a mudança e reprovou sozinho.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');

let ok = 0, fail = 0;

// A fila existe por causa dos testes `async`: numa versão anterior deste arquivo
// o `t` era síncrono, imprimia OK e só depois a promessa rejeitava — D1 dava
// verde e derrubava o processo no fim, com o assert reprovando fora do try.
// Teste que anuncia o resultado antes de ter o resultado não é teste.
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

const JS_SB = fs.readFileSync(path.join(PUB, 'js/sidebar.js'), 'utf8');
const CSS_SB = fs.readFileSync(path.join(PUB, 'css/sidebar.css'), 'utf8');
const CSS_APP = fs.readFileSync(path.join(PUB, 'css/app-modern.css'), 'utf8');
const APP_HTML = fs.readFileSync(path.join(PUB, 'app.html'), 'utf8');
const PDV = fs.readFileSync(path.join(PUB, 'comercial/pedidos-pdv.html'), 'utf8');
const PEDIDO = fs.readFileSync(path.join(PUB, 'comercial/pedido.html'), 'utf8');

/** Tira comentários de bloco e de linha — ver o cabeçalho. */
const semComentarios = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/<!--[\s\S]*?-->/g, '');

const JS_LIMPO = semComentarios(JS_SB);
const CSS_SB_LIMPO = semComentarios(CSS_SB);

// ============================================================================
// DOM simulado — o bastante para montar a topbar e mexer nela
// ============================================================================
//
// Mais capaz que o de `test-shell-boot.js` de propósito: aqui é preciso ABRIR o
// menu de conta, checar `classList`, disparar clique e tecla. innerHTML vira uma
// árvore de verdade, senão `querySelector('[data-acao="sair"]')` não acharia
// nada e o teste passaria sem ter testado.

function criarEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', _class: '', _html: '', textContent: '', title: '',
    type: '', onclick: null, attrs: {}, children: [], parent: null,
    style: { setProperty() {}, removeProperty() {}, display: '' },
    dataset: {},
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === 'class') this.className = String(v);
    },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {},
    focus() { el.__focado = true; },
    click() { if (this.onclick) this.onclick({ stopPropagation() {} }); },
    // `closest` sobe pelos pais comparando classe/id — o handler de "clique
    // fora" depende dele, e um stub que devolve null o tornaria intestável.
    closest(sel) {
      const bate = (n) => (sel.startsWith('.') ? (n._class || '').split(/\s+/).includes(sel.slice(1))
                                               : sel.startsWith('#') ? n.id === sel.slice(1) : false);
      let n = this;
      while (n) { if (bate(n)) return n; n = n.parent; }
      return null;
    },
    querySelector(sel) { return buscar(this, sel)[0] || null; },
    querySelectorAll(sel) { return buscar(this, sel); },
  };
  Object.defineProperty(el, 'className', {
    get() { return el._class; },
    set(v) { el._class = String(v); el.attrs.class = String(v); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = String(v); el.children = parseHTML(String(v), el); },
  });
  el.classList = {
    add: (c) => { const s = new Set(el._class.split(/\s+/).filter(Boolean)); s.add(c); el.className = [...s].join(' '); },
    remove: (c) => { const s = new Set(el._class.split(/\s+/).filter(Boolean)); s.delete(c); el.className = [...s].join(' '); },
    contains: (c) => el._class.split(/\s+/).includes(c),
    toggle: (c, f) => { const tem = el.classList.contains(c); const alvo = f === undefined ? !tem : !!f;
      if (alvo) el.classList.add(c); else el.classList.remove(c); return alvo; },
  };
  return el;
}

/** Parser bem pequeno de HTML: tags de abertura, atributos e texto. Só o que a topbar emite. */
function parseHTML(html, pai) {
  const out = [];
  const pilha = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [, fecha, tag, attrs, autoFecha, texto] = m;
    const atual = pilha[pilha.length - 1] || null;
    if (texto !== undefined) {
      const limpo = texto.replace(/&#9662;/g, '▾').trim();
      if (limpo && atual) atual.textContent += limpo;
      continue;
    }
    if (fecha) { pilha.pop(); continue; }
    const el = criarEl(tag);
    for (const a of attrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      if (!a[1]) continue;
      const v = a[2] === undefined ? '' : a[2];
      el.setAttribute(a[1], v);
      if (a[1] === 'id') el.id = v;
      if (a[1] === 'class') el.className = v;
      if (a[1].startsWith('data-')) el.dataset[a[1].slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    }
    if (atual) { el.parent = atual; atual.children.push(el); } else { el.parent = pai; out.push(el); }
    if (!autoFecha && !/^(br|img|input|hr|meta|link|path|circle|line|polyline)$/i.test(tag)) pilha.push(el);
  }
  return out;
}

function buscar(raiz, sel) {
  const achados = [];
  const bate = (n) => {
    if (sel.startsWith('.')) return (n._class || '').split(/\s+/).includes(sel.slice(1));
    if (sel.startsWith('#')) return n.id === sel.slice(1);
    const at = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
    if (at) return n.getAttribute(at[1]) === at[2];
    return n.tagName === sel.toUpperCase();
  };
  const anda = (n) => { for (const c of n.children || []) { if (bate(c)) achados.push(c); anda(c); } };
  anda(raiz);
  return achados;
}

/**
 * Carrega o sidebar.js real num contexto isolado.
 *
 * `respostas` mapeia rota → corpo JSON, e cada chamada é registrada em
 * `ctx.__chamadas`. É assim que o teste G conta as requisições sem confiar em
 * grep e o teste E simula a API caindo.
 */
function bootar({ tema = 'escuro', respostas = {}, emIframe = false } = {}) {
  const porId = {};
  const chamadas = [];
  const ouvintesDoc = {};

  const doc = {
    documentElement: criarEl('html'),
    head: criarEl('head'),
    body: criarEl('body'),
    readyState: 'loading',
    createElement: criarEl,
    getElementById: (id) => porId[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(ev, fn) { (ouvintesDoc[ev] = ouvintesDoc[ev] || []).push(fn); },
    removeEventListener() {},
    __ouvintes: ouvintesDoc,
  };
  // Registrar por id ao anexar, e RECURSIVAMENTE: a topbar é um único
  // appendChild cujos filhos (#btnTema, #tbMenu, …) nascem do innerHTML.
  const indexar = (el) => { if (el.id) porId[el.id] = el; (el.children || []).forEach(indexar); };
  doc.body.appendChild = function (c) { c.parent = this; this.children.push(c); indexar(c); return c; };

  const armazem = { appTheme: tema };
  const avisos = [];
  const ctx = {
    document: doc,
    localStorage: {
      getItem: (k) => (k in armazem ? armazem[k] : null),
      setItem: (k, v) => { armazem[k] = String(v); },
      removeItem: (k) => { delete armazem[k]; },
    },
    location: { pathname: '/app.html', search: '', hash: '', href: '', replace() {}, reload() {} },
    console: { log() {}, warn: (...a) => avisos.push(a.join(' ')), error: (...a) => avisos.push(a.join(' ')) },
    fetch: (url) => {
      chamadas.push(url);
      const corpo = respostas[url];
      if (corpo === undefined) return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
      if (corpo === 'erro') return Promise.reject(new Error('rede caiu'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(corpo) });
    },
    setTimeout: (fn) => { try { fn(); } catch (_) {} return 0; },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    navigator: { userAgent: 'test' },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    frameElement: null,
    history: { pushState() {}, replaceState() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => { try { fn(0); } catch (_) {} return 0; },
    alert() {}, confirm: () => true, prompt: () => null,
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    URL, URLSearchParams, JSON, Date, Math, RegExp, Object, Array, String, Number,
    Boolean, Error, Promise, Set, Map, Symbol,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, isFinite,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  if (emIframe) {
    // Dentro do iframe: `self !== top` e o pai é o shell.
    ctx.top = { __liciteShell: true };
    ctx.parent = { __liciteShell: true, __shellPageChanged() {} };
  } else {
    ctx.top = ctx;
    ctx.parent = ctx;
    ctx.__liciteShell = true;
  }
  ctx.__chamadas = chamadas;
  ctx.__avisos = avisos;
  ctx.__porId = porId;
  vm.createContext(ctx);

  for (const f of ['js/theme-boot.js', 'js/menu-config.js', 'js/sidebar.js']) {
    new vm.Script(fs.readFileSync(path.join(PUB, f), 'utf8'), { filename: f }).runInContext(ctx);
  }
  return { ctx, doc, armazem, avisos, chamadas, porId };
}

/** Espera as promessas de `carregarIdentidade` assentarem. */
const assentar = () => new Promise((r) => setImmediate(() => setImmediate(r)));

const USUARIO_OK = { '/api/usuarios/me': { success: true, usuario: { id: 1, nome: 'Carlos Finezi', username: 'carlos' } } };

// ============================================================================
// A. A topbar existe, e está no lugar certo
// ============================================================================

t('A1. a topbar e montada no shell, com role de landmark', async () => {
  const { ctx, porId } = bootar();
  ctx.montarTopbar();
  const bar = porId.topbar;
  assert(bar, 'a topbar não foi criada');
  assert(bar.tagName === 'HEADER', 'a topbar não é <header> — perde o landmark nativo');
  assert(bar.getAttribute('role') === 'banner', 'a topbar perdeu role="banner"');
  assert(bar.className.includes('topbar'), 'a topbar perdeu a classe .topbar');
});

t('A2. DENTRO do iframe a topbar NAO e montada (nada de duas barras)', () => {
  const { ctx, porId } = bootar({ emIframe: true });
  ctx.montarTopbar();
  assert(!porId.topbar, 'a topbar foi injetada dentro do iframe — apareceriam duas na tela');
});

t('A3. montar duas vezes nao duplica a barra', () => {
  const { ctx, doc } = bootar();
  ctx.montarTopbar();
  ctx.montarTopbar();
  const barras = doc.body.children.filter((c) => c.id === 'topbar');
  assert(barras.length === 1, `${barras.length} topbars no body`);
});

t('A4. falha ao montar NAO derruba o boot', () => {
  const { ctx, doc, porId, avisos } = bootar();
  // A topbar já nasceu no boot; sem apagá-la do índice, `montarTopbar` pararia
  // na guarda de idempotência e o teste passaria sem ter testado nada.
  delete porId.topbar;
  doc.body.appendChild = () => { throw new Error('DOM indisponível'); };
  let lancou = false;
  try { ctx.montarTopbar(); } catch { lancou = true; }
  assert(!lancou, 'montarTopbar propagou a exceção — o ERP inteiro não abriria');
  assert(avisos.some((a) => a.includes('[topbar]')), 'a falha passou sem aviso no console');
});

t('A5. o boot normal monta a topbar INTEIRA, sem cair no catch', () => {
  // O teste que faltava. `montarTopbar` roda no IIFE `initTema`, no meio do
  // arquivo, e uma chamada a `renderIcon` ali em cima esbarrava no
  // `EMOJI_TO_LUCIDE` ainda não inicializado. O `try` segurava o shell de pé e
  // engolia o erro: a barra aparecia, o menu de conta nascia vazio, e o único
  // sinal era uma linha no console. A4 prova que o catch protege; este prova
  // que ele NÃO está sendo usado no caminho normal.
  const { porId, avisos } = bootar({ respostas: USUARIO_OK });
  assert(!avisos.some((a) => a.includes('[topbar]')),
    'a montagem caiu no catch: ' + avisos.join(' · '));
  for (const id of ['topbar', 'btnTema', 'btnConta', 'tbMenu', 'tbEmpresa', 'tbUsuario', 'tbAvatar']) {
    assert(porId[id], `#${id} não foi criado — a montagem parou no meio`);
  }
});

// ============================================================================
// B. O botão de tema mudou de casa, não de função
// ============================================================================

t('B1. o botao de tema vive DENTRO da topbar e ainda alterna', () => {
  const { ctx, porId } = bootar({ tema: 'escuro' });
  ctx.montarTopbar();
  const btn = porId.btnTema;
  assert(btn, '#btnTema não existe mais');
  assert(btn.closest('.topbar'), 'o #btnTema está fora da topbar — voltou a flutuar');
  assert(btn.textContent.length > 0, 'o botão ficou sem ícone');
  const antes = ctx.document.documentElement.getAttribute('data-theme');
  btn.onclick();
  const depois = ctx.document.documentElement.getAttribute('data-theme');
  assert(antes !== depois, `o clique não trocou o tema (${antes} → ${depois})`);
});

t('B2. o botao de tema nao e mais fixed nem tem z-index proprio', () => {
  const bloco = /#btnTema \{([^}]*)\}/.exec(CSS_SB_LIMPO);
  assert(bloco, 'bloco do #btnTema sumiu');
  assert(!/position:\s*fixed/.test(bloco[1]), 'o #btnTema voltou a ser fixed');
  assert(!/z-index/.test(bloco[1]), 'o #btnTema voltou a ter z-index próprio');
});

// ============================================================================
// C. Menu de conta — as mesmas duas ações, num lugar só
// ============================================================================

t('C1. abrir o menu traz Alterar Senha e Sair, chamando as funcoes reais', () => {
  const { ctx, porId } = bootar();
  const menu = porId.tbMenu;
  assert(menu, '#tbMenu não existe');

  // Antes de abrir, o menu é vazio de propósito (montagem tardia — ver a nota
  // em `montarMenuConta`). O que não pode é continuar vazio DEPOIS de abrir:
  // foi assim que a zona morta temporal do `EMOJI_TO_LUCIDE` quase entrou em
  // produção, deixando a pessoa sem "Sair" e sem aviso nenhum na tela.
  ctx.alternarMenuConta();
  const itens = menu.querySelectorAll('.tb-menu-item');
  assert(itens.length === 2, `${itens.length} ações no menu de conta depois de abrir (esperado 2)`);

  let senha = 0, saiu = 0;
  ctx.abrirModalSenha = () => { senha++; };
  ctx.fazerLogout = () => { saiu++; };
  ctx.montarMenuConta();                    // remonta para os handlers apanharem os stubs
  porId.tbMenu.querySelector('[data-acao="senha"]').onclick();
  porId.tbMenu.querySelector('[data-acao="sair"]').onclick();
  assert(senha === 1, 'Alterar Senha não chamou abrirModalSenha');
  assert(saiu === 1, 'Sair não chamou fazerLogout');
});

t('C2. "Sair" existe em UM lugar so (o grupo Conta saiu do menu lateral)', () => {
  const { ctx } = bootar();
  const html = ctx.gerarMenuHTML(null);
  assert(!/grp-conta/.test(html), 'o grupo Conta voltou ao menu lateral');
  assert(!/class="menu-item"[^>]*>[\s\S]{0,160}>Sair</.test(html), '"Sair" voltou ao menu lateral');
  assert(!/class="menu-item"[^>]*>[\s\S]{0,160}Alterar Senha/.test(html), '"Alterar Senha" voltou ao menu lateral');
});

t('C3. as funcoes de senha e logout continuam existindo (nao foram recriadas)', () => {
  const { ctx } = bootar();
  for (const fn of ['abrirModalSenha', 'fazerLogout', 'abrirModalTema', 'paletaCustom']) {
    assert(typeof ctx[fn] === 'function', fn + ' sumiu');
  }
});

t('C4. abrir e fechar mexe no aria-expanded e na classe', () => {
  const { ctx, porId } = bootar();
  ctx.montarTopbar();
  const btn = porId.btnConta, menu = porId.tbMenu;
  assert(btn.getAttribute('aria-expanded') === 'false', 'nasce com aria-expanded errado');
  assert(btn.getAttribute('aria-haspopup') === 'menu', 'sem aria-haspopup');
  assert(menu.getAttribute('role') === 'menu', 'o menu perdeu role="menu"');

  ctx.alternarMenuConta();
  assert(menu.classList.contains('aberto'), 'o menu não abriu');
  assert(btn.getAttribute('aria-expanded') === 'true', 'aria-expanded não virou true');

  ctx.fecharMenuConta();
  assert(!menu.classList.contains('aberto'), 'o menu não fechou');
  assert(btn.getAttribute('aria-expanded') === 'false', 'aria-expanded não voltou a false');
});

t('C5. Escape fecha o menu e devolve o foco ao botao', () => {
  const { ctx, doc, porId } = bootar();
  ctx.montarTopbar();
  ctx.alternarMenuConta();
  const teclas = doc.__ouvintes.keydown || [];
  assert(teclas.length > 0, 'nenhum listener de teclado foi registrado');
  teclas.forEach((fn) => fn({ key: 'Escape' }));
  assert(!porId.tbMenu.classList.contains('aberto'), 'Escape não fechou o menu');
  assert(porId.btnConta.__focado, 'Escape fechou mas não devolveu o foco ao botão');
});

t('C6. clique fora fecha; clique dentro nao', () => {
  const { ctx, doc, porId } = bootar();
  ctx.montarTopbar();
  const cliques = doc.__ouvintes.click || [];
  assert(cliques.length > 0, 'nenhum listener de clique foi registrado');

  ctx.alternarMenuConta();
  cliques.forEach((fn) => fn({ target: porId.tbMenu }));       // dentro de .tb-conta
  assert(porId.tbMenu.classList.contains('aberto'), 'clique DENTRO do menu fechou o menu');

  cliques.forEach((fn) => fn({ target: doc.body }));           // fora
  assert(!porId.tbMenu.classList.contains('aberto'), 'clique fora não fechou o menu');
});

// ============================================================================
// D. Identidade — só dado real
// ============================================================================

t('D1. o nome do usuario aparece, e o avatar leva a inicial', async () => {
  const { ctx, porId } = bootar({ respostas: USUARIO_OK });
  ctx.montarTopbar();
  await assentar();
  assert(porId.tbUsuario.textContent === 'Carlos Finezi', 'nome errado: ' + porId.tbUsuario.textContent);
  assert(porId.tbAvatar.textContent === 'C', 'inicial errada: ' + porId.tbAvatar.textContent);
  assert(/Carlos Finezi/.test(porId.btnConta.getAttribute('aria-label') || ''),
    'o aria-label do botão não nomeia o usuário');
});

t('D2. usuario sem "nome" cai para o username (caso real medido: 1 de 33)', async () => {
  const { ctx, porId } = bootar({
    respostas: { '/api/usuarios/me': { success: true, usuario: { id: 2, nome: null, username: 'admin' } } },
  });
  ctx.montarTopbar();
  await assentar();
  assert(porId.tbUsuario.textContent === 'admin', 'não caiu para o username: ' + porId.tbUsuario.textContent);
});

t('D3. API do usuario caindo NAO quebra a barra', async () => {
  const { ctx, porId, avisos } = bootar({ respostas: { '/api/usuarios/me': 'erro' } });
  ctx.montarTopbar();
  await assentar();
  assert(porId.topbar, 'a topbar sumiu quando a API falhou');
  assert(porId.tbUsuario.textContent === '', 'inventou nome com a API fora do ar');
  assert(!avisos.some((a) => a.includes('[topbar]')), 'a falha de rede virou aviso de montagem');
});

t('D4. empresa com nome aparece; sem nome fica VAZIA (nada de "Empresa" generico)', () => {
  const { ctx, porId } = bootar();
  ctx.montarTopbar();

  ctx.publicarEmpresaNaTopbar('MC Consultoria');
  assert(porId.tbEmpresa.textContent === 'MC Consultoria', 'não publicou o nome real');
  assert(porId.tbEmpresa.title === 'MC Consultoria', 'sem title para a razão social truncada');

  const b = bootar();
  b.ctx.montarTopbar();
  for (const vazio of [null, undefined, '', '   ']) {
    b.ctx.publicarEmpresaNaTopbar(vazio);
    assert(b.porId.tbEmpresa.textContent === '',
      `inventou identidade a partir de ${JSON.stringify(vazio)}: "${b.porId.tbEmpresa.textContent}"`);
  }
});

t('D5. o nome da empresa NAO custa requisicao nova', () => {
  // Ele é publicado por `carregarEstabSwitcher`, que já consulta
  // /api/estabelecimentos em todo carregamento do menu.
  const fn = /async function carregarEstabSwitcher\(\)[\s\S]*?\n}/.exec(JS_LIMPO);
  assert(fn, 'carregarEstabSwitcher não encontrada');
  assert(/publicarEmpresaNaTopbar/.test(fn[0]),
    'carregarEstabSwitcher deixou de publicar a empresa — voltaria a fazer falta uma chamada própria');
  const pub = /function publicarEmpresaNaTopbar\([\s\S]*?\n}/.exec(JS_LIMPO);
  assert(pub && !/fetch\(/.test(pub[0]), 'publicarEmpresaNaTopbar passou a fazer fetch');
});

// ============================================================================
// E. Custo: uma requisição nova, nenhum laço novo
// ============================================================================

t('E1. a topbar custa UMA requisicao, a uma rota que ja existe', async () => {
  const { chamadas } = bootar({ respostas: USUARIO_OK });
  await assentar();
  // `/api/user/prefs` é do boot do tema e já existia antes desta fase; o que a
  // topbar acrescentou tem de ser exatamente uma rota, e não uma rota nova.
  const novas = chamadas.filter((u) => u !== '/api/user/prefs').sort();
  // DUAS desde 2026-09-12, e a segunda entrou por um motivo de segurança
  // operacional: em 9 dos 13 tenants o nome do estabelecimento não está
  // cadastrado, e a topbar ficava SEM identificação nenhuma — ninguém sabia de
  // qual empresa era a sessão aberta (relatório 41). `/api/tenant-atual` dá o
  // nome do tenant nesse caso.
  //
  // O limite continua sendo o mesmo em espírito: rotas que JÁ existem, uma
  // chamada cada, na montagem, sem polling. O teste E3 garante a ausência de
  // laço; o E4, que os listeners não acumulam.
  assert(novas.length === 2, 'a topbar acrescentou ' + novas.length + ' chamadas: ' + JSON.stringify(novas));
  assert(novas[0] === '/api/tenant-atual', 'rota inesperada: ' + novas[0]);
  assert(novas[1] === '/api/usuarios/me', 'rota inesperada: ' + novas[1]);

  // Cada uma chamada UMA vez, e o nome do estabelecimento continua sem custo:
  // vem de `carregarEstabSwitcher`, que o menu já fazia.
  const fn = /function carregarIdentidade\(\)[\s\S]*?\n}/.exec(JS_LIMPO);
  assert((fn[0].match(/fetch\(/g) || []).length === 2,
    'carregarIdentidade mudou o número de chamadas');
});

t('E2. a rota usada passa para QUALQUER perfil (RBAC de API)', () => {
  const mapa = fs.readFileSync(path.join(RAIZ, 'perfis-api-map.js'), 'utf8');
  const lib = /const LIBERADOS = \[([\s\S]*?)\]/.exec(mapa);
  assert(lib, 'lista LIBERADOS não encontrada');
  assert(/'\/api\/usuarios'/.test(lib[1]),
    '/api/usuarios saiu de LIBERADOS — a topbar tomaria 403 em perfis restritos');
});

t('E3. nenhum polling, timer ou observer novo', () => {
  const novas = ['montarTopbar', 'montarMenuConta', 'carregarIdentidade',
                 'publicarEmpresaNaTopbar', 'ligarFechamentoDoMenuConta',
                 'alternarMenuConta', 'fecharMenuConta'];
  for (const nome of novas) {
    const re = new RegExp('function ' + nome + '\\([\\s\\S]*?\\n}');
    const corpo = re.exec(JS_LIMPO);
    assert(corpo, nome + ' não encontrada');
    for (const proibido of ['setInterval', 'MutationObserver', 'requestAnimationFrame']) {
      assert(!corpo[0].includes(proibido), `${nome} usa ${proibido} — a topbar tem de ser estática`);
    }
  }
});

t('E4. os listeners do menu sao registrados UMA vez', () => {
  // A contagem absoluta não serve: `ligarTooltipEFlyout` já registra os seus no
  // mesmo documento. O que importa é que remontar não ACUMULE.
  const { ctx, doc } = bootar();
  const antes = [(doc.__ouvintes.click || []).length, (doc.__ouvintes.keydown || []).length];
  ctx.montarTopbar();
  ctx.montarTopbar();
  const depois = [(doc.__ouvintes.click || []).length, (doc.__ouvintes.keydown || []).length];
  assert(antes[0] === depois[0] && antes[1] === depois[1],
    `listeners acumulando: clique ${antes[0]}→${depois[0]}, teclado ${antes[1]}→${depois[1]}`);
});

// ============================================================================
// F. Layout — a topbar ocupa espaço em vez de flutuar
// ============================================================================

t('F1. o shell reserva a altura da topbar no iframe', () => {
  assert(/top:\s*var\(--topbar-h\)/.test(APP_HTML), '#conteudo não começa abaixo da topbar');
  assert(/height:\s*calc\(100% - var\(--topbar-h\)\)/.test(APP_HTML),
    'a altura do iframe não desconta a topbar — sobraria barra de rolagem');
});

t('F2. --topbar-h e declarada e usada por token, nunca em pixel solto', () => {
  assert(/--topbar-h:\s*\d+px/.test(CSS_SB_LIMPO), '--topbar-h não declarada');
  const bloco = /\.topbar \{([^}]*)\}/.exec(CSS_SB_LIMPO);
  assert(bloco, 'bloco .topbar não encontrado');
  assert(/height:\s*var\(--topbar-h\)/.test(bloco[1]), '.topbar com altura fora do token');
});

t('F3. a topbar comeca depois da sidebar e acompanha o recolhimento', () => {
  const bloco = /\.topbar \{([^}]*)\}/.exec(CSS_SB_LIMPO)[1];
  assert(/left:\s*var\(--sidebar-w\)/.test(bloco),
    'a topbar deixou de acompanhar a sidebar — sobreporia a barra ou deixaria vão');
  assert(/transition:[^;]*left/.test(bloco), 'sem transição no left: pularia ao recolher a sidebar');
});

t('F4. z-index da topbar: nao cobre tooltip/flyout nem modal', () => {
  const topbar = Number(/\.topbar \{[^}]*z-index:\s*(\d+)/.exec(CSS_SB_LIMPO)[1]);
  const tooltip = Number(/\.sb-tooltip[^{]*\{[^}]*z-index:\s*(\d+)/.exec(CSS_SB_LIMPO)[1]);
  assert(topbar <= tooltip, `topbar (${topbar}) acima do tooltip (${tooltip})`);
  assert(topbar < 10000, `topbar (${topbar}) acima dos modais (10000)`);
});

t('F5. as tres reservas de canto sumiram', () => {
  assert(!/\.page-header \{ padding-right:/.test(semComentarios(CSS_APP)), 'reserva do .page-header voltou');
  assert(!/\.pdv-topo \{[\s\S]{0,160}?padding:\s*\d+px\s+5\dpx/.test(semComentarios(PDV)), 'reserva do .pdv-topo voltou');
  assert(!/\.ped-header \{ padding:\s*\d+px\s+5\dpx/.test(semComentarios(PEDIDO)), 'reserva do .ped-header voltou');
});

t('F6. mobile: a barra ocupa a largura toda e abre espaco para o hamburguer', () => {
  const mq = /@media \(max-width: 768px\) \{\s*\.topbar \{([^}]*)\}([\s\S]*?)\n}/.exec(CSS_SB_LIMPO);
  assert(mq, 'media query da topbar não encontrada');
  assert(/left:\s*0/.test(mq[1]), 'no mobile a topbar não vai até a esquerda');

  // O `.menu-toggle` é fixed e fica POR CIMA da barra: o padding tem de cobri-lo.
  // Ancorado em início de linha: sem isso o regex pega `body.embedded
  // .menu-toggle { display: none }`, que vem antes e não tem medida nenhuma.
  const tog = /^\.menu-toggle \{([^}]*)\}/m.exec(CSS_SB_LIMPO)[1];
  const left = Number(/left:\s*(\d+)px/.exec(tog)[1]);
  const padH = Number(/padding:\s*\d+px\s+(\d+)px/.exec(tog)[1]);
  const pad = Number(/padding-left:\s*(\d+)px/.exec(mq[1])[1]);
  const ocupa = left + padH * 2 + 18;        // 18px ≈ o glifo ☰ a 1.1em
  assert(pad >= ocupa, `padding-left ${pad}px < hambúrguer ocupa ~${ocupa}px — ficariam sobrepostos`);
  assert(Number(/z-index:\s*(\d+)/.exec(tog)[1]) > Number(/\.topbar \{[^}]*z-index:\s*(\d+)/.exec(CSS_SB_LIMPO)[1]),
    'o hambúrguer ficaria ATRÁS da topbar e não daria para tocar');
});

t('F7. mobile: a area da conta nao escorrega para a esquerda', () => {
  // `.tb-esq` some no mobile; com `space-between` e um filho só, a `.tb-dir`
  // iria para a esquerda, em cima do hambúrguer. `margin-left: auto` a segura.
  const dir = /\.tb-dir \{([^}]*)\}/.exec(CSS_SB_LIMPO)[1];
  assert(/margin-left:\s*auto/.test(dir), '.tb-dir sem margin-left:auto');
});

// ============================================================================
// G. Temas e acessibilidade
// ============================================================================

t('G1. o CSS da topbar usa tokens, sem cor literal', () => {
  const ini = CSS_SB_LIMPO.indexOf(':root { --topbar-h');
  const fim = CSS_SB_LIMPO.indexOf('Sidebar compacta', ini);
  const bloco = CSS_SB_LIMPO.slice(ini, fim > ini ? fim : ini + 5000);
  const literais = [...bloco.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g)].map((m) => m[0]);
  // `#fff` no avatar é o par de contraste de `--accent`, verificado em G2.
  const inesperados = literais.filter((l) => l.toLowerCase() !== '#fff');
  assert(inesperados.length === 0, 'cor literal no bloco da topbar: ' + inesperados.join(', '));
});

t('G2. o texto do avatar tem contraste AA sobre o fundo que ele realmente usa', () => {
  const lum = (hex) => {
    const c = hex.replace('#', '');
    const v = c.length === 3 ? [...c].map((x) => x + x) : c.match(/../g);
    const [r, g, b] = v.map((h) => {
      const s = parseInt(h, 16) / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const razao = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  // Lê do CSS qual token é o fundo do avatar, em vez de presumir: a primeira
  // versão usava `--accent`, que no tema escuro é `#60a5fa` e dá 2,54:1 com
  // branco. Se alguém trocar o token de novo, esta verificação acompanha.
  const av = /\.tb-avatar \{([^}]*)\}/.exec(CSS_SB_LIMPO);
  assert(av, 'bloco .tb-avatar não encontrado');
  const tokenFundo = /background:\s*var\((--[\w-]+)\)/.exec(av[1]);
  const corTexto = /color:\s*(#[0-9a-fA-F]{3,6})/.exec(av[1]);
  assert(tokenFundo && corTexto, '.tb-avatar sem fundo por token ou sem cor de texto literal');

  // `--btn-primary-bg` e companhia vivem num `:root` único (não variam por
  // tema); os de paleta têm uma definição por tema. Verifica TODAS.
  const valores = [...CSS_APP.matchAll(new RegExp(tokenFundo[1] + ':\\s*(#[0-9a-fA-F]{3,6})', 'g'))].map((m) => m[1]);
  assert(valores.length > 0, tokenFundo[1] + ' não está definida em app-modern.css');
  for (const bg of valores) {
    const r = razao(corTexto[1], bg);
    // A inicial é texto pequeno, ainda que em negrito: o piso AA é 4,5:1.
    assert(r >= 4.5, `avatar: ${r.toFixed(2)}:1 de ${corTexto[1]} sobre ${bg} (${tokenFundo[1]}) — abaixo de 4,5:1`);
  }
});

t('G3. os controles da topbar tem nome acessivel e foco visivel', () => {
  const { ctx, porId } = bootar();
  ctx.montarTopbar();
  assert(porId.btnTema.getAttribute('aria-label'), '#btnTema sem aria-label');
  assert(porId.btnConta.getAttribute('aria-label') || porId.btnConta.textContent,
    '#btnConta sem nome acessível');
  assert(porId.tbAvatar.getAttribute('aria-hidden') === 'true',
    'a inicial do avatar é decorativa e seria lida duas vezes pelo leitor de tela');
  for (const sel of ['.tb-btn:focus-visible', '.tb-menu-item:focus-visible']) {
    assert(CSS_SB_LIMPO.includes(sel), 'sem foco visível em ' + sel);
  }
});

t('G4. a topbar nao aparece na impressao', () => {
  assert(/@media print \{ \.topbar \{ display: none/.test(CSS_SB_LIMPO), 'a topbar sairia no papel');
});

// ============================================================================
// H. Preparação da identidade — inventário, sem criar asset
// ============================================================================

/**
 * A preparação virou implementação em 2026-09-11 (Fase 3.4).
 *
 * Estes testes vigiavam um estado que era deliberadamente provisório: UM asset
 * de marca, referenciado num lugar só, com o slot do monograma apenas marcado.
 * A identidade nova chegou, o slot foi preenchido, e o que eles vigiam agora é
 * a fronteira entre as duas fases — a topbar continua sem marca, e a sidebar
 * continua sendo dona dela.
 *
 * O inventário e a fidelidade dos assets são cobertos por
 * `test-fase34-identidade.js`.
 */
t('H1. a marca da sidebar existe, e a topbar nao a repete', () => {
  const { ctx, porId } = bootar();
  ctx.montarTopbar();
  assert(!/logo|<img|<svg/i.test(porId.topbar.innerHTML),
    'a topbar ganhou marca — ficariam duas na mesma tela, que é o que a Fase 3.3 decidiu evitar');
  assert(/MARCA_HORIZONTAL/.test(JS_SB) && /MARCA_MONOGRAMA/.test(JS_SB),
    'a sidebar perdeu a marca');
});

t('H2. a decisao de arquitetura da topbar segue de pe', () => {
  // `left: var(--sidebar-w)` é o que mantém a marca só na sidebar: se a topbar
  // passasse a atravessar a tela, o canto superior esquerdo ficaria vazio e a
  // pressão seria por repetir a logo lá.
  const bloco = /\.topbar \{([^}]*)\}/.exec(CSS_SB_LIMPO)[1];
  assert(/left:\s*var\(--sidebar-w\)/.test(bloco),
    'a topbar deixou de começar depois da sidebar');
});

t('H3. o slot de identidade foi PREENCHIDO, nao apagado', () => {
  // A regra da logo compacta continua existindo — ela serve à logo CUSTOM do
  // tenant, que não é a marca do produto e não ganhou versão monograma.
  assert(/\[data-sidebar="compacta"\] \.sidebar-logo-img/.test(CSS_SB),
    'a regra da logo custom do tenant sumiu junto com a troca da marca');
  assert(/\.marca-monograma/.test(CSS_SB_LIMPO),
    'a alternância para o monograma não existe — a barra recolhida voltaria a espremer a horizontal');
});

t('H4. o PNG antigo foi preservado como fallback', () => {
  assert(fs.existsSync(path.join(PUB, 'img/logo-sistema.png')),
    'logo-sistema.png foi apagado — era para ficar como fallback');
});

// ============================================================================
// I. O resto do shell continua de pé
// ============================================================================

t('I1. o menu ainda monta, e nenhuma pagina foi levada junto com o grupo Conta', () => {
  const { ctx } = bootar();
  const html = ctx.gerarMenuHTML(null);
  assert(html.length > 500, 'HTML do menu vazio ou curto');
  assert(/sidebar-menu/.test(html) && /sidebar-logo/.test(html), 'o menu perdeu estrutura');

  // O HTML de uma vez só não serve de medida: no modo 'modulos' (o padrão) ele
  // traz apenas o módulo ativo. A contagem é na FONTE do menu, que é o que não
  // pode ter encolhido — Senha e Sair nunca estiveram lá, eram escritos à mão.
  const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));
  const paginas = menuConfig.secoes.reduce((a, s) => a + s.itens.length, 0);
  // Piso, não igualdade: o total sobe quando uma tela legítima é acrescentada
  // (Categorias entrou na Fase 44). O risco que este teste cobre é PERDER um
  // item — a chave do menu está gravada em `perfis_acesso.paginas` nos tenants,
  // e removê-la tira o acesso de quem já a tinha.
  assert(paginas >= 190, `o menu perdeu itens: ${paginas} (piso 190) — esta fase não mexe em acesso`);
});

t('I2. o RBAC do menu nao foi tocado', () => {
  assert(/desenharMenuComAcesso/.test(JS_LIMPO), 'desenharMenuComAcesso sumiu');
  assert(/meu-acesso/.test(JS_LIMPO), 'o menu deixou de consultar o acesso do usuário');
});

t('I3. shellRedirect intacto — e por isso a topbar alcanca todas as telas', () => {
  const fn = /function shellRedirect\(\)[\s\S]*?\n\s*\}\)\(\);/.exec(JS_SB);
  assert(fn, 'shellRedirect não encontrada');
  assert(/location\.replace\('\/app\.html#'/.test(fn[0]),
    'o redirect para o shell mudou — telas fora do shell ficariam sem topbar');
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
