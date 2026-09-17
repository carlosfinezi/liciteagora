/**
 * Shell do ERP — o boot tem de acontecer, em qualquer estado de preferência.
 *
 * ── Por que este teste existe ───────────────────────────────────────────────
 *
 * Em 2026-09-11 o ERP inteiro abriu numa tela vazia: sem sidebar, sem logo, sem
 * menu, sem iframe. A causa foi uma CRASE dentro de um comentário HTML que vive
 * dentro de uma template literal, em `sidebar.js` — a crase fechou a string e o
 * arquivo parou de parsear. Nada do shell rodava.
 *
 * Nenhum teste pegou, e o motivo é específico: `npm run verify` roda
 * `find . scripts -maxdepth 1`, ou seja, **só os .js da raiz e de scripts/**.
 * `public/js/` nunca foi checado. O teste do tema (relatório 24) lia `sidebar.js`
 * como TEXTO, com regex — texto quebrado casa com regex do mesmo jeito.
 *
 * Este arquivo fecha as duas lacunas:
 *   A) todo .js de public/ tem de parsear de verdade (`new vm.Script`);
 *   B) o shell tem de montar sidebar, logo, menu e iframe — em DOM simulado,
 *      com cada estado de preferência de tema que existe em produção.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ==================== A. SINTAXE REAL DE public/ ====================

t('A1. todo .js de public/ parseia (a lacuna que deixou o shell branco)', () => {
  const ruins = [];
  const varrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (e.name.endsWith('.js')) {
        try { new vm.Script(fs.readFileSync(p, 'utf8'), { filename: p }); }
        catch (x) { ruins.push(`${path.relative(RAIZ, p)}: ${x.message}`); }
      }
    }
  };
  varrer(PUB);
  assert(ruins.length === 0, ruins.join(' · '));
});

t('A2. nenhuma crase dentro de comentario HTML em public/js/', () => {
  // A armadilha exata de 2026-09-11: dentro de uma template literal, a crase de
  // um comentário HTML fecha a string e quebra o arquivo inteiro.
  const ruins = [];
  for (const f of fs.readdirSync(path.join(PUB, 'js'))) {
    if (!f.endsWith('.js')) continue;
    const s = fs.readFileSync(path.join(PUB, 'js', f), 'utf8');
    for (const m of s.matchAll(/<!--[\s\S]*?-->/g)) {
      if (m[0].includes('`')) ruins.push(`${f}: ${m[0].slice(0, 50).replace(/\n/g, ' ')}`);
    }
  }
  assert(ruins.length === 0, ruins.join(' · '));
});

t('A3. o JS inline das telas parseia', () => {
  const ruins = [];
  const varrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (e.name.endsWith('.html')) {
        const h = fs.readFileSync(p, 'utf8');
        if (!h.includes('/js/sidebar.js')) continue;      // só as telas do ERP
        [...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].forEach((m, i) => {
          try { new vm.Script(m[1]); }
          catch (x) { ruins.push(`${path.relative(RAIZ, p)} bloco ${i + 1}: ${x.message}`); }
        });
      }
    }
  };
  varrer(PUB);
  assert(ruins.length === 0, ruins.slice(0, 3).join(' · '));
});

// ==================== B. BOOT DO SHELL EM DOM SIMULADO ====================

/**
 * DOM mínimo — o suficiente para `sidebar.js` montar o menu e o shell.
 *
 * Não é jsdom (dependência nova num projeto que não a tem). É um objeto que
 * responde ao que o código realmente chama; se ele chamar algo que não existe,
 * o teste falha — que é exatamente o que se quer detectar.
 */
function criarDom() {
  const criados = [];
  const novoEl = (tag) => {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      id: '', className: '', innerHTML: '', textContent: '', title: '', type: '',
      style: { setProperty() {}, removeProperty() {}, display: '' },
      dataset: {}, children: [], attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.children.push(c); criados.push(c); return c; },
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      focus() {}, click() {}, closest() { return null; }, insertAdjacentHTML() {},
    };
    return el;
  };

  const porId = {};
  const doc = {
    documentElement: novoEl('html'),
    body: novoEl('body'),
    head: novoEl('head'),
    readyState: 'loading',
    createElement: novoEl,
    getElementById(id) { return porId[id] || null; },
    querySelector(sel) {
      if (sel === 'meta[name="theme-color"]') return porId['__meta_theme'] || null;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(ev, fn) { (doc.__ouvintes[ev] = doc.__ouvintes[ev] || []).push(fn); },
    removeEventListener() {},
    __ouvintes: {},
    __registrar(id, el) { porId[id] = el; },
    __criados: criados,
  };
  doc.body.appendChild = function (c) { this.children.push(c); criados.push(c); if (c.id) porId[c.id] = c; return c; };
  return doc;
}

/** Carrega theme-boot.js + sidebar.js num contexto isolado, com o tema dado. */
function bootar(temaSalvo) {
  const doc = criarDom();
  const armazem = { appTheme: temaSalvo };
  const avisos = [];

  const ctx = {
    document: doc,
    window: null,
    localStorage: {
      getItem: (k) => (k in armazem ? armazem[k] : null),
      setItem: (k, v) => { armazem[k] = String(v); },
      removeItem: (k) => { delete armazem[k]; },
    },
    location: { pathname: '/app.html', search: '', hash: '#/comercial/pedidos-pdv.html', href: '' },
    console: { log() {}, warn: (...a) => avisos.push(a.join(' ')), error: (...a) => avisos.push(a.join(' ')) },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    navigator: { userAgent: 'test' },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    parent: null, top: null, self: null, frameElement: null,
    history: { pushState() {}, replaceState() {}, back() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => { try { fn(0); } catch (_) {} return 0; },
    alert() {}, confirm: () => true, prompt: () => null,
    URL, URLSearchParams, JSON, Date, Math, RegExp, Object, Array, String, Number, Boolean, Error, Promise, Set, Map,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, parseInt, parseFloat, isNaN, isFinite,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.parent = ctx;      // no shell, `parent === self` (não está em iframe)
  ctx.top = ctx;
  ctx.globalThis = ctx;
  ctx.window.__liciteShell = true;          // é o shell (app.html)
  vm.createContext(ctx);

  for (const f of ['js/theme-boot.js', 'js/menu-config.js', 'js/sidebar.js']) {
    const src = fs.readFileSync(path.join(PUB, f), 'utf8');
    new vm.Script(src, { filename: f }).runInContext(ctx);
  }
  return { ctx, doc, armazem, avisos };
}

t('B1. theme-boot + menu-config + sidebar carregam sem lancar', () => {
  const { ctx } = bootar('escuro');
  assert(typeof ctx.initShell === 'function', 'initShell não existe — o shell não teria como montar');
  assert(typeof ctx.initSidebar === 'function', 'initSidebar não existe');
  assert(typeof ctx.gerarMenuHTML === 'function', 'gerarMenuHTML não existe — o menu não teria como ser montado');
  assert(typeof ctx.montarMenu === 'function', 'montarMenu não existe');
});

t('B2. o HTML da sidebar sai com logo e menu, e SEM o grupo Conta', () => {
  const { ctx } = bootar('escuro');
  const html = ctx.gerarMenuHTML('pedidos-pdv');
  assert(typeof html === 'string' && html.length > 500, 'HTML da sidebar vazio ou curto');
  assert(/sidebar-menu/.test(html), 'sem .sidebar-menu');
  assert(/logo|Licite/i.test(html), 'sem marca/logo no topo da sidebar');

  // Fase 3.3: Senha e Sair mudaram para o menu de conta da TOPBAR. Se voltarem
  // ao menu lateral, passam a existir DOIS caminhos para a mesma ação — que é o
  // que esta fase desfez. A verificação é no HTML de MENU, não no arquivo
  // inteiro: `montarMenuConta()` escreve os mesmos rótulos, e legitimamente.
  assert(!/grp-conta/.test(html), 'o grupo Conta voltou ao menu lateral');
  assert(!/class="menu-item"[^>]*>[\s\S]{0,160}Alterar Senha/.test(html),
    '"Alterar Senha" voltou como item do menu lateral — ficaria em dois lugares');
  assert(!/class="menu-item"[^>]*>[\s\S]{0,160}>Sair</.test(html),
    '"Sair" voltou como item do menu lateral — ficaria em dois lugares');

  assert(/#modalTema|id="modalTema"/.test(html),
    'o modal legado sumiu — quem tem tema custom ficaria sem como sair dele');
});

// ==================== C. TODOS OS ESTADOS DE PREFERÊNCIA ====================

const ESTADOS = [
  ['sem appTheme', null],
  ['padrao', 'padrao'],
  ['claro', 'claro'],
  ['escuro', 'escuro'],
  ['string vazia', ''],
  ['valor invalido', 'xpto-invalido'],
  ['custom valido', 'custom:#ffffff:#1f6dea'],
  ['custom legado real (1bit)', 'custom:#f5f7f9:#021a40'],
  ['custom legado real (pbg)', 'custom:#030202:#114283'],
  ['custom malformado', 'custom:#zzz'],
  ['custom sem accent', 'custom:#ffffff'],
  ['custom com lixo', 'custom:::::'],
];

for (const [rotulo, valor] of ESTADOS) {
  t(`C. o shell monta com tema "${rotulo}"`, () => {
    const { ctx, doc } = bootar(valor);
    
    const html = ctx.gerarMenuHTML('pedidos-pdv');
    assert(html && html.length > 500, 'sidebar não montou');
    assert(/sidebar-menu/.test(html), 'menu ausente');
    // O tema sempre resolve para uma das duas bases — nunca fica sem.
    const base = doc.documentElement.getAttribute('data-theme');
    assert(base === 'claro' || base === 'escuro', `data-theme inválido: ${base}`);
  });
}

t('C13. preferencia invalida cai no padrao, sem lancar', () => {
  const { doc, avisos } = bootar('custom:::::');
  assert(doc.documentElement.getAttribute('data-theme') === 'escuro', 'não caiu no escuro');
  assert(!avisos.some((a) => /Unexpected|SyntaxError/.test(a)), 'houve erro de parsing: ' + avisos.join(' | '));
});

// ==================== D. O TEMA NÃO PODE MATAR O SHELL ====================

t('D1. falha ao criar a topbar NAO interrompe o boot', () => {
  const { ctx, doc } = bootar('claro');
  // Simula um body hostil: appendChild que explode.
  doc.body.appendChild = () => { throw new Error('DOM indisponível'); };
  let lancou = false;
  try { ctx.montarTopbar(); } catch { lancou = true; }
  assert(!lancou, 'montarTopbar propagou a exceção e derrubaria o boot');
});

t('D2. aplicarTema com valor absurdo nao lanca', () => {
  const { ctx } = bootar('escuro');
  for (const v of [null, undefined, 0, {}, [], 'custom:#zz:#yy', 'custom:' + 'x'.repeat(500)]) {
    let lancou = false;
    try { ctx.aplicarTema(v); } catch { lancou = true; }
    assert(!lancou, 'aplicarTema lançou com ' + JSON.stringify(v));
  }
});

t('D3. a topbar NAO e injetada dentro do iframe', () => {
  // IN_SHELL protege contra duas barras: a da janela de fora já existe.
  const { ctx } = bootar('claro');
  assert(typeof ctx.montarTopbar === 'function', 'montarTopbar sumiu');
  const fonte = ctx.montarTopbar.toString();
  assert(/IN_SHELL/.test(fonte), 'montarTopbar perdeu a guarda IN_SHELL');
});

// ==================== E. O SHELL EM SI ====================

t('E1. app.html tem iframe, flag do shell e a ordem de scripts correta', () => {
  const h = fs.readFileSync(path.join(PUB, 'app.html'), 'utf8');
  assert(/<iframe[^>]+id="conteudo"/.test(h), 'iframe #conteudo ausente');
  const flag = h.indexOf('__liciteShell');
  const sb = h.indexOf('/js/sidebar.js');
  const init = h.indexOf('initShell()');
  assert(flag > 0 && sb > flag, 'a flag __liciteShell precisa vir ANTES de sidebar.js');
  assert(init > sb, 'initShell() precisa vir DEPOIS de sidebar.js');
  const tb = h.indexOf('/js/theme-boot.js');
  const css = h.indexOf('<link rel="stylesheet"');
  assert(tb > 0 && tb < css, 'theme-boot precisa vir antes do CSS');
  assert(tb < flag, 'theme-boot é do <head>, antes do corpo do shell');
});

t('E2. theme-boot nao depende de nada do sidebar.js', () => {
  // Ele roda sozinho no <head>: qualquer função de sidebar.js seria undefined.
  const src = fs.readFileSync(path.join(PUB, 'js/theme-boot.js'), 'utf8');
  for (const fn of ['aplicarTema', 'baseDoTema', 'lumHex', 'paletaCustom', 'initSidebar',
                    'renderIcon', 'montarBotaoTema', 'escolherTema']) {
    assert(!new RegExp('\\b' + fn + '\\s*\\(').test(src), `theme-boot chama ${fn}() de sidebar.js`);
  }
});

t('E3. theme-boot nao toca no body nem em elemento que ainda nao existe', () => {
  const src = fs.readFileSync(path.join(PUB, 'js/theme-boot.js'), 'utf8');
  assert(!/document\.body/.test(src), 'usa document.body — que não existe no <head>');
  assert(!/getElementById/.test(src), 'busca elemento por id antes de o DOM existir');
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
