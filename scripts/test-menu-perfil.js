/**
 * test-menu-perfil.js — o menu lateral só mostra o que o perfil alcança?
 *
 * Uso:  node scripts/test-menu-perfil.js
 *
 * Carrega o `public/js/sidebar.js` de verdade num contexto com DOM/localStorage
 * falsos e chama `gerarMenuHTML()`. Testar uma cópia da regra não provaria nada:
 * o que interessa é o arquivo que o navegador baixa.
 *
 * O loop principal é uma página por vez: com um perfil que só tem a página X, o
 * menu tem de conter X e mais nada. 140 páginas, 140 casos.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, '..', 'public');
const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));
const { FEATURE_KEYS } = require(path.join(__dirname, '..', 'features-routes.js'));

/**
 * `TODAS` = páginas que o menu DESENHA. Não é o mesmo que "páginas
 * registradas".
 *
 * Desde 2026-09-12 um item pode ter `oculto: true`: continua registrado para o
 * RBAC (e é isso que faz `podeVerPath` exigir a permissão pelo nome), mas não
 * aparece na barra. Este arquivo mede a relação perfil → ITENS DESENHADOS, então
 * a lista de referência tem de seguir o desenho — senão todo caso de borda
 * ("perfil irrestrito", "sem cache") acusaria falha por cobrar um item que a
 * barra não deve mais mostrar.
 *
 * Quem cobre a outra metade — a página oculta continuar protegida — é
 * `test-menu-oculto-rbac.js`.
 */
const TODAS = [];
const OCULTAS = [];
const FEATURES_DO_MENU = new Set();
for (const s of menuConfig.secoes) {
  if (s.feature) FEATURES_DO_MENU.add(s.feature);
  for (const i of s.itens) {
    if (i.oculto) OCULTAS.push(i.page); else TODAS.push(i.page);
    if (i.feature) FEATURES_DO_MENU.add(i.feature);
  }
}

// O menu pede features que a API não devolve — nesses casos o item fica invisível
// para todo mundo, independente de perfil. Não é o que este teste mede, mas é o
// tipo de coisa que faria o loop acusar falha pelo motivo errado.
const ORFAS = [...FEATURES_DO_MENU].filter((f) => !FEATURE_KEYS.includes(f));

// ---------- DOM mínimo ----------
function criarContexto() {
  const armazem = new Map();
  const store = {
    getItem: (k) => (armazem.has(k) ? armazem.get(k) : null),
    setItem: (k, v) => armazem.set(k, String(v)),
    removeItem: (k) => armazem.delete(k),
  };
  const elemento = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, appendChild() {}, querySelector: () => null,
    querySelectorAll: () => [], insertAdjacentHTML() {}, remove() {}, addEventListener() {},
    textContent: '', innerHTML: '',
  });
  const document = {
    head: elemento(), body: elemento(), documentElement: { style: { setProperty() {}, removeProperty() {} } },
    createElement: elemento, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, getElementsByTagName: () => [elemento()], addEventListener() {},
  };
  const janela = {
    document, localStorage: store, sessionStorage: { getItem: () => null, setItem() {} },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
    location: { pathname: '/', search: '', hash: '', replace() {}, reload() {} },
    addEventListener() {}, setTimeout, setInterval: () => 0, clearInterval() {},
    console: { log() {}, error() {}, warn() {} },
    Intl, JSON, Math, Date, Promise, URL,
  };
  janela.window = janela;
  janela.self = janela;
  janela.top = janela;          // não é iframe → não entra no ramo do shell
  janela.parent = janela;
  const ctx = vm.createContext(janela);
  vm.runInContext(fs.readFileSync(path.join(PUB, 'js/menu-config.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(PUB, 'js/sidebar.js'), 'utf8'), ctx);
  return ctx;
}

// Um contexto por caso: o sidebar guarda estado em variáveis de módulo.
function menuPara(acesso, features) {
  const ctx = criarContexto();
  const f = {};
  for (const k of [...FEATURE_KEYS, ...FEATURES_DO_MENU]) f[k] = features ? features[k] !== false : true;
  ctx.localStorage.setItem('featuresCache', JSON.stringify(f));
  if (acesso) ctx.localStorage.setItem('acessoCache', JSON.stringify(acesso));
  const html = vm.runInContext('gerarMenuHTML(null)', ctx);
  return {
    itens: [...html.matchAll(/data-page="([^"]+)"/g)].map((m) => m[1]),
    secoes: [...html.matchAll(/<span class="menu-section-title">.*?<\/span>([^<]*)/g)].length,
    html,
  };
}

let ok = 0; let falha = 0;
const erros = [];
function conferir(nome, real, esperado) {
  const r = [...real].sort().join(',');
  const e = [...esperado].sort().join(',');
  if (r === e) { ok++; return; }
  falha++;
  erros.push(`${nome}\n     esperado: ${e || '(nenhum)'}\n     recebido: ${r || '(nenhum)'}`);
}

// ---------- 1. uma página por vez ----------
for (const page of TODAS) {
  conferir(`perfil só com "${page}"`, menuPara({ irrestrito: false, paginas: [page] }).itens, [page]);
}

// ---------- 2. casos de borda ----------
conferir('perfil sem página nenhuma', menuPara({ irrestrito: false, paginas: [] }).itens, []);
conferir('perfil irrestrito', menuPara({ irrestrito: true, paginas: TODAS }).itens, TODAS);
conferir('sem cache de acesso (ainda não respondeu)', menuPara(null).itens, TODAS);

const PERFIL = ['nfse', 'faturas', 'notas-fiscais', 'contas-a-receber', 'contas-financeiras',
  'pedidos', 'pessoas', 'meu-perfil'];
conferir('perfil de 8 páginas', menuPara({ irrestrito: false, paginas: PERFIL }).itens, PERFIL);

// Página que não existe no menu não inventa item.
conferir('perfil com página inexistente', menuPara({ irrestrito: false, paginas: ['nao-existe'] }).itens, []);

// ---------- 2b. página `oculto: true` não é desenhada nem com permissão ----------
// O outro lado da moeda (ela continuar BLOQUEADA para quem não tem a permissão)
// é medido em `test-menu-oculto-rbac.js`, com o `podeVerPath` de verdade.
for (const page of OCULTAS) {
  conferir(`oculta "${page}" nao aparece nem tendo a permissao`,
    menuPara({ irrestrito: false, paginas: [page] }).itens, []);
  conferir(`oculta "${page}" nao aparece nem para o irrestrito`,
    menuPara({ irrestrito: true, paginas: [...TODAS, page] }).itens, TODAS);
}

// ---------- 3. seção sem nenhum item permitido some inteira ----------
const secaoVarejo = menuConfig.secoes.find((s) => s.titulo === 'Varejo');
const semVarejo = menuPara({ irrestrito: false, paginas: PERFIL });
if (semVarejo.html.includes('>Varejo<') || semVarejo.html.includes('Varejo</span>')) {
  falha++; erros.push('seção "Varejo" apareceu num perfil que não tem nenhuma página dela');
} else ok++;
const soVarejo = menuPara({ irrestrito: false, paginas: [secaoVarejo.itens[0].page] });
if (!soVarejo.html.includes('Varejo')) { falha++; erros.push('seção "Varejo" sumiu tendo item permitido'); }
else ok++;

// ---------- 4. feature flag continua valendo (não regredir) ----------
conferir('feature varejo desligada + acesso irrestrito',
  menuPara({ irrestrito: true, paginas: TODAS }, { varejo: false }).itens,
  TODAS.filter((p) => !secaoVarejo.itens.some((i) => i.page === p)));

// ---------- 5. o bloco "Conta" nunca some ----------
const contaSempre = menuPara({ irrestrito: false, paginas: [] }).html;
if (contaSempre.includes('Alterar Senha') && contaSempre.includes('fazerLogout')) ok++;
else { falha++; erros.push('bloco Conta (senha/sair) sumiu para perfil sem páginas'); }

console.log(`casos: ${ok + falha}   conforme: ${ok}   divergentes: ${falha}`);
if (ORFAS.length) {
  console.log(`\nAVISO (anterior ao RBAC, não é falha deste teste): o menu pede a(s) feature(s) `
    + `${ORFAS.join(', ')}, que /api/features/status não devolve — FEATURE_KEYS em `
    + `features-routes.js não as lista. Os itens dessas seções ficam ocultos para `
    + `todo usuário, com ou sem perfil.`);
}
if (falha) {
  console.log('\n--- divergências ---');
  erros.forEach((e) => console.log('  ' + e));
  process.exit(1);
}
