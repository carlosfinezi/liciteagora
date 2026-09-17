/**
 * Fase 3.6 — página registrada para RBAC, oculta da barra lateral.
 *
 * ── O que está em jogo ──────────────────────────────────────────────────────
 *
 * `oculto: true` separa duas perguntas que antes andavam coladas:
 *
 *     "esta página existe para o controle de acesso?"  → SIM
 *     "esta página aparece na barra lateral?"          → NÃO
 *
 * O risco da mudança é justamente confundir as duas: alguém, achando que está
 * "limpando o menu", apaga a linha do `menu-config.js` — e a página cai no
 * fallback por diretório de `podeVerPath`, ficando aberta para qualquer perfil
 * com uma página de /comercial/.
 *
 * O teste E é o que impede isso. Ele não lê o arquivo procurando a palavra
 * `oculto`: ele RODA o `podeVerPath` real contra um perfil que tem `pedidos` e
 * não tem `pedidos-pdv`, e exige bloqueio. Se a linha sumir, ele reprova.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));
const PAGINA = '/comercial/pedidos-pdv.html';
const CHAVE = 'pedidos-pdv';

// ============================================================================
// Banco descartável — nunca um tenant real
// ============================================================================
const DB = new Database(':memory:');
DB.exec(`CREATE TABLE perfis_acesso (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, nome TEXT,
  paginas TEXT, ativo INTEGER DEFAULT 1);`);
const criarPerfil = (slug, paginas) =>
  DB.prepare('INSERT OR REPLACE INTO perfis_acesso (slug, nome, paginas, ativo) VALUES (?,?,?,1)')
    .run(slug, slug, JSON.stringify(paginas));

criarPerfil('zz-com-pdv', ['pedidos', CHAVE]);
criarPerfil('zz-sem-pdv', ['pedidos']);
criarPerfil('zz-so-produtos', ['produtos']);

const { acessoDoUsuario, podeVerPath } = require(path.join(RAIZ, 'perfis-acesso.js'));
const acessoDe = (slug) => acessoDoUsuario(DB, { role: slug });

// ============================================================================
// A. Continua registrada para o RBAC
// ============================================================================

t('A1. a pagina segue no menu-config (e o que sustenta a protecao)', () => {
  const item = menuConfig.secoes
    .flatMap((s) => s.itens)
    .find((i) => i.page === CHAVE);
  assert(item, `${CHAVE} saiu do menu-config — a página cairia no fallback por diretório`);
  assert(item.link === PAGINA, 'o link mudou');
  assert(item.oculto === true, 'o item perdeu `oculto: true` — voltaria a aparecer na barra');
});

t('A2. o servidor indexa a pagina, oculta ou nao', () => {
  // `perfis-acesso.js` monta POR_LINK a partir dos itens, sem olhar `oculto`.
  // Se olhasse, a checagem nominal se perderia — é o coração desta fase.
  const a = acessoDe('zz-com-pdv');
  assert(podeVerPath(a, PAGINA), 'quem TEM a permissão não consegue abrir — a página sumiu do índice');
});

t('A3. a pagina continua atribuivel na tela de perfis', () => {
  // Sem isto, o admin não teria como CONCEDER `pedidos-pdv` a ninguém —
  // a permissão existiria e seria inalcançável.
  const { catalogo } = require(path.join(RAIZ, 'perfis-acesso.js'));
  const todas = catalogo().flatMap((s) => s.paginas.map((p) => p.page));
  assert(todas.includes(CHAVE), `${CHAVE} sumiu do catálogo de permissões`);
});

// ============================================================================
// B. Não aparece na barra lateral
// ============================================================================

/** Carrega o sidebar.js real com um acesso simulado e devolve o HTML do menu. */
function menuHTML(paginas, { irrestrito = false } = {}) {
  const ctx = {
    localStorage: {
      // Todas as features ligadas: `isFeatureEnabled` exige `=== true`, e um
      // cache vazio esconderia a seção Comercial inteira — o teste mediria a
      // feature flag, não o `oculto`.
      // `menuModo: 'lista'` porque o padrão ('modulos') desenha só o módulo
      // ativo, e aí a ausência de um item não prova nada.
      _d: {
        acessoCache: JSON.stringify({ irrestrito, paginas }),
        featuresCache: JSON.stringify(Object.fromEntries(
          [...new Set(menuConfig.secoes.map((x) => x.feature).filter(Boolean))].map((f) => [f, true]))),
        menuModo: 'lista',
      },
      getItem(k) { return this._d[k] ?? null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
    document: (() => {
      // `injectFavicons` roda no carregamento do arquivo e procura o <head>;
      // sem estes dois métodos o sidebar.js nem chega a definir gerarMenuHTML.
      const noh = () => ({
        style: {}, setAttribute() {}, removeAttribute() {}, appendChild() {},
        querySelector: () => null, querySelectorAll: () => [],
        classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      });
      const head = noh();
      return {
        documentElement: { getAttribute: () => 'escuro', setAttribute() {}, style: { setProperty() {} } },
        body: null, head, readyState: 'loading',
        createElement: noh,
        getElementsByTagName: (t) => (t === 'head' ? [head] : []),
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {},
      };
    })(),
    location: { pathname: '/app.html', search: '', hash: '', href: '', replace() {} },
    console: { log() {}, warn() {}, error() {} },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1440, navigator: { userAgent: 'test' },
    requestAnimationFrame: (f) => { try { f(0); } catch (_) {} return 0; },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    JSON, Date, Math, RegExp, Object, Array, String, Number, Boolean, Error, Promise, Set, Map,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, isFinite, URL, URLSearchParams,
  };
  ctx.window = ctx; ctx.self = ctx; ctx.top = ctx; ctx.parent = ctx; ctx.globalThis = ctx;
  ctx.window.__liciteShell = true;
  vm.createContext(ctx);
  for (const f of ['js/menu-config.js', 'js/sidebar.js']) {
    new vm.Script(fs.readFileSync(path.join(PUB, f), 'utf8'), { filename: f }).runInContext(ctx);
  }
  return { html: ctx.gerarMenuHTML(null), ctx };
}

t('B1. a barra NAO mostra "Venda rapida", nem para quem tem a permissao', () => {
  const { html } = menuHTML(['pedidos', CHAVE]);
  assert(!new RegExp(`data-page="${CHAVE}"`).test(html),
    'o item continua desenhado na barra');
  assert(!/Venda rápida/.test(html), 'o rótulo "Venda rápida" ainda aparece na barra');
});

t('B2. a barra tambem nao mostra para o admin (irrestrito)', () => {
  const { html } = menuHTML([], { irrestrito: true });
  assert(!new RegExp(`data-page="${CHAVE}"`).test(html), 'aparece para o irrestrito');
});

t('B3. o resto do menu Comercial continua inteiro', () => {
  const { html } = menuHTML([], { irrestrito: true });
  for (const p of ['pedidos', 'pessoas', 'crm-funil', 'comercial-tabelas-preco']) {
    assert(new RegExp(`data-page="${p}"`).test(html), `o item ${p} sumiu junto`);
  }
});

t('B4. a BUSCA de rotina ainda acha (quem tem permissao nao perde o atalho)', () => {
  const { ctx } = menuHTML(['pedidos', CHAVE]);
  const achados = ctx.buscarRotinas('venda rapida');
  assert(achados.some((a) => a.link === PAGINA),
    'a busca deixou de achar a Venda rápida — escondê-la ali tira um caminho legítimo');
});

t('B5. a busca NAO acha para quem nao tem a permissao', () => {
  const { ctx } = menuHTML(['pedidos']);
  const achados = ctx.buscarRotinas('venda rapida');
  assert(!achados.some((a) => a.link === PAGINA),
    'a busca ofereceu a Venda rápida a quem não pode abri-la');
});

// ============================================================================
// C/D. Acesso por URL direta
// ============================================================================

t('C1. perfil com "pedidos" e SEM "pedidos-pdv" NAO abre a URL direta', () => {
  const a = acessoDe('zz-sem-pdv');
  assert(podeVerPath(a, '/comercial/pedidos.html'), 'não vê a própria página de Pedidos');
  assert(!podeVerPath(a, PAGINA),
    'FAIL-OPEN: ocultar do menu liberou a URL direta para quem não tem a permissão');
});

t('D1. perfil COM "pedidos-pdv" abre a URL direta', () => {
  assert(podeVerPath(acessoDe('zz-com-pdv'), PAGINA), 'bloqueou quem tem a permissão');
});

// ============================================================================
// E. O fail-open por diretório NÃO voltou — o teste central
// ============================================================================

t('E1. ocultar NAO ativou o fallback por diretorio', () => {
  // A intenção do `test-pdv-rbac.js` B3, preservada. Três perfis, nenhum deles
  // com `pedidos-pdv`, todos barrados — inclusive o que tem outra página do
  // MESMO diretório /comercial/.
  for (const slug of ['zz-sem-pdv', 'zz-so-produtos']) {
    assert(!podeVerPath(acessoDe(slug), PAGINA), `${slug} entrou sem ter a permissão`);
  }
  const a = acessoDe('zz-sem-pdv');
  assert(podeVerPath(a, '/comercial/pedidos.html') && !podeVerPath(a, PAGINA),
    'ter /comercial/pedidos.html liberou /comercial/pedidos-pdv.html — o fail-open voltou');
});

t('E2. a checagem e NOMINAL, nao por diretorio (prova pelo vizinho)', () => {
  // `pedido.html` (detalhe, fora do menu) DEVE abrir por herança de diretório.
  // `pedidos-pdv.html` (registrada) NÃO deve. As duas regras convivendo é o que
  // prova que `oculto` não mexeu no mecanismo de acesso.
  const a = acessoDe('zz-sem-pdv');
  assert(podeVerPath(a, '/comercial/pedido.html'),
    'a tela de detalhe parou de herdar o diretório — isso não era para mudar');
  assert(!podeVerPath(a, PAGINA), 'a página registrada passou a herdar o diretório');
});

// ============================================================================
// F. Sidebar expandida e compacta
// ============================================================================

t('F1. compacta monta igual a expandida (so a largura muda)', () => {
  const { html } = menuHTML([], { irrestrito: true });
  const itens = (html.match(/class="menu-item"/g) || []).length;
  assert(itens > 0, 'o menu não desenhou item nenhum');
  // O modo compacto é CSS sobre o mesmo HTML — o que importa é o HTML não ter
  // ganhado o item oculto de volta por outro caminho.
  assert(!new RegExp(`data-page="${CHAVE}"`).test(html), 'o item oculto voltou');
  const css = fs.readFileSync(path.join(PUB, 'css/sidebar.css'), 'utf8');
  assert(/\[data-sidebar="compacta"\]/.test(css), 'o modo compacto sumiu do CSS');
});

t('F2. a Venda rapida ainda pede o modo compacto ao abrir', () => {
  const sb = fs.readFileSync(path.join(PUB, 'js/sidebar.js'), 'utf8');
  assert(new RegExp(`PAGINAS_COMPACTAS = \\['${CHAVE}'\\]`).test(sb),
    'a Venda rápida deixou de recolher a barra — comportamento da Fase 2.1');
});

// ============================================================================
// G. O mecanismo é genérico, não um remendo
// ============================================================================

t('G1. so o DESENHO filtra ocultos; busca e deep link enxergam', () => {
  const sb = fs.readFileSync(path.join(PUB, 'js/sidebar.js'), 'utf8');
  const chamadas = [...sb.matchAll(/secoesVisiveisDoMenu\(([^)]*)\)/g)].map((m) => m[1].trim());
  const comFiltro = chamadas.filter((c) => /paraDesenho:\s*true/.test(c));
  assert(comFiltro.length === 1,
    `${comFiltro.length} chamadas pedem paraDesenho:true (esperado 1: só montarMenu)`);
  assert(chamadas.length >= 3, 'sumiram chamadas de secoesVisiveisDoMenu');
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  DB.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
