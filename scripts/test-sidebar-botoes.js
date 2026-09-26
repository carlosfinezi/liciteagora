/**
 * Fase 3.2 — sidebar moderna, tooltip, flyout e botões.
 *
 * O menu é MONTADO de verdade (vm + DOM simulado) e o HTML resultante é
 * inspecionado. Não é regex sobre o fonte: o relatório 24 provou que texto
 * quebrado casa com regex igual, e foi assim que um `sidebar.js` que nem
 * parseava passou por 14 testes verdes.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const CSS_SB = fs.readFileSync(path.join(PUB, 'css/sidebar.css'), 'utf8');
const CSS_APP = fs.readFileSync(path.join(PUB, 'css/app-modern.css'), 'utf8');
const JS_SB = fs.readFileSync(path.join(PUB, 'js/sidebar.js'), 'utf8');

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- monta o menu de verdade ----------
function bootar(tema, compacta) {
  const criados = [];
  const novoEl = (tag) => ({
    tagName: String(tag || 'div').toUpperCase(), id: '', className: '', innerHTML: '',
    textContent: '', title: '', type: '', style: { setProperty() {}, removeProperty() {}, display: '' },
    dataset: {}, children: [], attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); criados.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    getBoundingClientRect: () => ({ top: 100, right: 64, bottom: 130, left: 0, width: 64, height: 30 }),
  });
  const raiz = novoEl('html');
  if (compacta) raiz.setAttribute('data-sidebar', 'compacta');
  const doc = {
    documentElement: raiz, body: novoEl('body'), head: novoEl('head'), readyState: 'complete',
    createElement: novoEl, getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, __criados: criados,
  };
  const ctx = {
    document: doc,
    localStorage: { getItem: (k) => (k === 'appTheme' ? tema : null), setItem() {}, removeItem() {} },
    location: { pathname: '/app.html', search: '', hash: '' },
    console: { log() {}, warn() {}, error() {} },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    navigator: { userAgent: 'test' }, matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900,
    history: { pushState() {}, replaceState() {} }, requestAnimationFrame: (f) => { f(0); return 0; },
    URL, URLSearchParams, JSON, Date, Math, RegExp, Object, Array, String, Number, Boolean,
    Error, Promise, Set, Map, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, isFinite,
  };
  ctx.window = ctx; ctx.self = ctx; ctx.parent = ctx; ctx.globalThis = ctx;
  ctx.window.__liciteShell = true;
  vm.createContext(ctx);
  for (const f of ['js/theme-boot.js', 'js/menu-config.js', 'js/sidebar.js']) {
    new vm.Script(fs.readFileSync(path.join(PUB, f), 'utf8'), { filename: f }).runInContext(ctx);
  }
  return ctx;
}

const CTX = bootar('escuro', false);
const HTML = CTX.gerarMenuHTML('pedidos-pdv');
const itens = [...HTML.matchAll(/<a [^>]*class="menu-item"[^>]*>/g)].map((m) => m[0]);
const attr = (tag, nome) => (new RegExp(`${nome}="([^"]*)"`).exec(tag) || [])[1];

// ==================== A/B. SIDEBAR CONTINUA FUNCIONANDO ====================

t('A. sidebar expandida monta com secoes, itens e busca', () => {
  assert(HTML.length > 800, 'HTML curto demais');
  assert(/class="sidebar-menu"/.test(HTML), 'sem .sidebar-menu');
  assert(/class="menu-busca"/.test(HTML), 'a busca de rotina sumiu');
  assert(itens.length > 0, 'nenhum item renderizado');
  // Fase 3.3: o grupo Conta saiu daqui para o menu de conta da topbar, para que
  // "Sair" não existisse em dois lugares. Quem cobre Senha e Sair agora é
  // `test-fase33-topbar.js` (C1, C2).
  assert(!/grp-conta/.test(HTML), 'o grupo Conta voltou ao menu lateral');
});

t('B. sidebar recolhida: monta igual, so a largura muda', () => {
  const ctxC = bootar('escuro', true);
  const htmlC = ctxC.gerarMenuHTML('pedidos-pdv');
  const itensC = [...htmlC.matchAll(/<a [^>]*class="menu-item"[^>]*>/g)];
  assert(itensC.length === itens.length,
    `recolhida tem ${itensC.length} itens e expandida ${itens.length} — deveriam ser os mesmos`);
  assert(/--sidebar-w: 64px/.test(CSS_SB), 'a largura compacta sumiu do CSS');
});

// ==================== C/D/E. TOOLTIP ====================

t('C. todo item tem rotulo acessivel (aria-label) e NENHUM title', () => {
  // A Fase 3.2 pedia `title` como fallback. A revisão visual mostrou que ele
  // desenhava o tooltip NATIVO do navegador por cima do nosso — dois textos ao
  // mesmo tempo (relatório 29). O `title` saiu; quem responde por acessibilidade
  // é o `aria-label`, e o fallback não fazia falta: quem desenha estes itens é o
  // mesmo `sidebar.js` que desenha o tooltip.
  const semLabel = itens.filter((i) => !attr(i, 'aria-label'));
  assert(semLabel.length === 0, `${semLabel.length} item(ns) sem aria-label: ${semLabel[0] || ''}`);
  const comTitle = itens.filter((i) => / title="/.test(i));
  assert(comTitle.length === 0, `${comTitle.length} item(ns) voltaram a emitir title: ${comTitle[0] || ''}`);
});

t('D. o tooltip usa o NOME REAL do item, vindo do menu-config', () => {
  const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));
  const nomesReais = new Set();
  for (const s of menuConfig.secoes) for (const i of s.itens) nomesReais.add(String(i.texto).trim());
  // "Alterar Senha" e "Sair" são AÇÕES, não páginas: não existem no menu-config
  // e têm o rótulo escrito no template. São a única exceção legítima.
  const acoesLocais = new Set(['Alterar Senha', 'Sair']);
  let conferidos = 0;
  for (const tag of itens) {
    const tip = attr(tag, 'data-tooltip');
    assert(tip, 'item sem data-tooltip: ' + tag.slice(0, 80));
    // O `&quot;` é escape do próprio atributo; desfaz antes de comparar.
    const limpo = tip.replace(/&quot;/g, '"');
    assert(nomesReais.has(limpo) || acoesLocais.has(limpo),
      `"${limpo}" não é um texto do menu-config nem uma ação conhecida`);
    if (nomesReais.has(limpo)) conferidos++;
  }
  assert(conferidos > 5, 'poucos itens de menu conferidos: ' + conferidos);
});

t('E. nenhum rotulo de menu foi duplicado dentro do sidebar.js', () => {
  // Se alguém escrever os nomes à mão aqui, eles divergem do menu no primeiro
  // rename. Os textos têm de vir SEMPRE de item.texto / secao.titulo.
  const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));
  // Comentários são removidos antes da busca: citar um item ao EXPLICAR um
  // defeito não é duplicar o rótulo. Sem isto, o teste reprovava a própria
  // documentação — aconteceu com "Tabelas de Preço", citada no comentário que
  // explica por que o `title` saiu.
  const codigo = JS_SB
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '');
  const amostra = ['Clientes & Fornecedores', 'CRM · Funil', 'Tabelas de Preço', 'Pedidos PDV'];
  for (const nome of amostra) {
    const noConfig = menuConfig.secoes.some((s) => s.itens.some((i) => i.texto === nome));
    if (!noConfig) continue;
    assert(!codigo.includes(`'${nome}'`) && !codigo.includes(`"${nome}"`),
      `"${nome}" está escrito à mão em sidebar.js — deve vir do menu-config`);
  }
  assert(/data-tooltip="\$\{nome/.test(JS_SB) || /data-tooltip="\$\{nomeSecao/.test(JS_SB),
    'o tooltip não é preenchido a partir da estrutura do menu');
});

t('D2. o tooltip vive fora da sidebar (nao e cortado pelo overflow)', () => {
  assert(/\.sb-tooltip \{[\s\S]*?position: fixed/.test(CSS_SB), 'tooltip não é fixed');
  assert(/function elTooltip/.test(JS_SB) && /document\.body\.appendChild\(_tipEl\)/.test(JS_SB),
    'o tooltip não é anexado ao body — seria cortado por .sidebar-menu{overflow:auto}');
  assert(/pointer-events: none/.test(CSS_SB), 'tooltip sem pointer-events:none rouba o hover do ícone');
});

t('D3. o tooltip nao sai da viewport e some ao sair/rolar', () => {
  assert(/Math\.max\(8, Math\.min\(topo, window\.innerHeight/.test(JS_SB), 'sem contenção vertical');
  assert(/mouseout[\s\S]{0,120}esconderTooltip/.test(JS_SB), 'não some ao tirar o mouse');
  assert(/'scroll'[\s\S]{0,120}esconderTooltip/.test(JS_SB), 'não some ao rolar');
});

// ==================== F/G/H. FLYOUT ====================

t('F. grupo recolhido abre flyout por CLIQUE (nao por hover instavel)', () => {
  assert(/function abrirFlyout/.test(JS_SB), 'abrirFlyout não existe');
  assert(/menu-section-toggle'\);\s*\n\s*if \(cab && sidebarCompacta\(\)\)/.test(JS_SB)
      || /closest\('\.sidebar \.menu-section-toggle'\)/.test(JS_SB), 'flyout não é ligado ao clique no grupo');
  assert(/data-grupo-nome=/.test(HTML), 'o cabeçalho de grupo não expõe o nome para o flyout');
});

t('G. o flyout herda o RBAC: clona os itens JA renderizados', () => {
  // Buscar em menuConfig traria itens que o perfil não pode ver. Clonar do DOM
  // usa exatamente o que `desenharMenuComAcesso` liberou.
  const fn = /function abrirFlyout[\s\S]*?\n\}/.exec(JS_SB)[0];
  assert(/grupo\.querySelectorAll\('\.menu-item'\)/.test(fn),
    'o flyout não clona os itens do DOM — poderia mostrar item sem permissão');
  assert(!/menuConfig/.test(fn), 'o flyout lê o menuConfig direto, contornando o filtro de acesso');
});

t('H. o flyout fecha: clique fora, item, Escape, scroll, resize e ao expandir', () => {
  assert(/if \(e\.key === 'Escape'\)[\s\S]{0,80}fecharFlyout/.test(JS_SB), 'Escape não fecha');
  assert(/closest\('\.sb-flyout-item'\)[\s\S]{0,80}fecharFlyout/.test(JS_SB), 'clicar num item não fecha');
  assert(/if \(!e\.target\.closest\('\.sb-flyout'\)\) fecharFlyout/.test(JS_SB), 'clique fora não fecha');
  assert(/'scroll'[\s\S]{0,120}fecharFlyout/.test(JS_SB), 'scroll não fecha');
  assert(/'resize'[\s\S]{0,120}fecharFlyout/.test(JS_SB), 'resize não fecha');
  assert(/alternarSidebarCompacta[\s\S]{0,200}fecharFlyout/.test(JS_SB), 'expandir a barra não fecha o flyout');
});

t('H2. o flyout se reposiciona quando nao cabe ate o rodape', () => {
  assert(/topo \+ alt > window\.innerHeight/.test(JS_SB), 'sem reposicionamento vertical');
  assert(/\.sb-flyout \{[\s\S]*?z-index: 1100/.test(CSS_SB), 'z-index do flyout não declarado');
  const zSidebar = Number(/\.sidebar \{[\s\S]*?z-index:\s*(\d+)/.exec(CSS_SB)[1]);
  assert(1100 > zSidebar, `flyout (1100) precisa ficar acima da sidebar (${zSidebar})`);
});

// ==================== acessibilidade ====================

t('C2. grupo recolhido e operavel por teclado (role, tabindex, aria-expanded)', () => {
  const cab = /<div class="menu-section menu-section-toggle"[^>]*>/.exec(HTML);
  assert(cab, 'cabeçalho de grupo não encontrado');
  assert(/role="button"/.test(cab[0]), 'sem role=button');
  assert(/tabindex="0"/.test(cab[0]), 'não alcançável por Tab');
  assert(/aria-expanded="(true|false)"/.test(cab[0]), 'sem aria-expanded');
});

t('C3. o tooltip aparece tambem no FOCO por teclado', () => {
  assert(/'focusin'[\s\S]{0,200}mostrarTooltip/.test(JS_SB),
    'quem navega por Tab não recebe a informação que o mouse recebe');
});

t('C4. o foco-visivel da Fase 3.1 continua valendo', () => {
  assert(/\.menu-item:focus-visible/.test(CSS_APP), 'o anel de foco do menu sumiu');
  assert(/--foco:/.test(CSS_APP), 'o token de foco sumiu');
});

// ==================== I. ITEM ATIVO ====================

t('I. o item atual continua destacado, e sem barra lateral em cada item', () => {
  assert(/\.sidebar \.menu-item\.active \{[\s\S]*?background: var\(--accent-soft\)/.test(CSS_SB),
    'o item ativo perdeu o destaque');
  assert(/\.sidebar \.menu-item \{[\s\S]*?border-left: 0/.test(CSS_SB),
    'a barra vertical de 2px em cada item continua — é ela que faz "vários botões empilhados"');
  assert(/\.sb-flyout-item\.ativo/.test(CSS_SB), 'o flyout não destaca o item atual');
});

// ==================== J/K/L. TEMAS ====================

t('J/K. sidebar, tooltip e flyout usam tokens (funcionam nos dois temas)', () => {
  const bloco = CSS_SB.slice(CSS_SB.indexOf('FASE 3.2'));
  const fixas = [];
  for (const m of bloco.matchAll(/(?:^|[;{\s])(color|background(?:-color)?|border-color)\s*:\s*([^;}]+)/g)) {
    const v = m[2].trim();
    if (/var\(--|transparent|inherit|none|currentColor/i.test(v)) continue;
    if (/^rgba?\(0,\s*0,\s*0/.test(v)) continue;      // sombra
    fixas.push(`${m[1]}: ${v}`);
  }
  assert(fixas.length === 0, 'cor fixa no CSS da Fase 3.2: ' + fixas.join(' · '));
});

t('L. o tema custom legado continua funcionando', () => {
  for (const valor of ['custom:#f5f7f9:#021a40', 'custom:#030202:#114283']) {
    const c = bootar(valor, false);
    const h = c.gerarMenuHTML('pedidos');
    assert(h.length > 800, 'o menu não montou com tema custom ' + valor);
    const base = c.document.documentElement.getAttribute('data-theme');
    assert(base === 'claro' || base === 'escuro', 'tema custom não resolveu base: ' + base);
  }
  assert(/function paletaCustom/.test(JS_SB), 'a paleta custom foi removida');
});

// ==================== M. BOTÕES ====================

t('M. botoes preservam TAMANHO e ganham estados', () => {
  const semMediaCss = CSS_APP.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  // `@media` fora: o tamanho protegido é o do DESKTOP. Dentro de um breakpoint
  // de celular, aumentar o alvo de toque é o objetivo (responsividade global,
  // 2026-09-12).
  const bloco = semMediaCss.slice(semMediaCss.indexOf('FASE 3.2 — BOTÕES'));
  // O font-size não pode ter sido tocado — foi o achado da Fase 3.1.
  assert(!/\.btn\s*\{[^}]*font-size/.test(bloco), 'a Fase 3.2 mudou o font-size do .btn');
  assert(!/\.btn-sm\s*\{[^}]*font-size/.test(bloco), 'a Fase 3.2 mudou o font-size do .btn-sm');
  for (const estado of [':hover', ':active', ':disabled', 'min-height']) {
    assert(bloco.includes(estado), 'botão sem ' + estado);
  }
  assert(/pointer-events: none/.test(bloco), 'botão desabilitado ainda aceita clique');
});

t('M2. os fundos de botao solido tem contraste AA nos DOIS temas', () => {
  const rgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const lum = (h) => { const c = rgb(h); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ct = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

  const tok = {};
  for (const m of CSS_APP.matchAll(/(--btn-[a-z-]+):\s*(#[0-9a-f]{6})/gi)) tok[m[1]] = m[2];
  assert(Object.keys(tok).length >= 3, 'tokens de botão não declarados: ' + JSON.stringify(tok));

  const ruins = [];
  for (const k of ['--btn-primary-bg', '--btn-danger-bg', '--btn-success-bg']) {
    const bg = tok[k];
    assert(bg, 'falta ' + k);
    const texto = ct('#ffffff', bg);
    const noEscuro = ct(bg, '#0b1120');   // --bg-0 escuro
    const noClaro = ct(bg, '#f1f4f8');    // --bg-0 claro
    if (texto < 4.5) ruins.push(`${k}: texto branco ${texto.toFixed(2)}:1 (<4.5)`);
    if (noEscuro < 3) ruins.push(`${k}: vs fundo escuro ${noEscuro.toFixed(2)}:1 (<3)`);
    if (noClaro < 3) ruins.push(`${k}: vs fundo claro ${noClaro.toFixed(2)}:1 (<3)`);
  }
  assert(ruins.length === 0, ruins.join(' · '));
});

t('M3. .btn-danger e .btn-success deixaram de usar cor fixa', () => {
  const bloco = CSS_APP.slice(CSS_APP.indexOf('FASE 3.2 — BOTÕES'));
  for (const v of ['.btn-danger', '.btn-success', '.btn-primary']) {
    const re = new RegExp(`\\${v} \\{[^}]*background:\\s*([^;]+)`);
    const m = re.exec(bloco);
    assert(m, 'sem regra de fundo para ' + v);
    assert(/var\(--btn-/.test(m[1]), `${v} ainda usa cor literal: ${m[1].trim()}`);
  }
});

// ==================== N/O. NADA DE PERMISSÃO MUDOU ====================

t('N. nenhuma API nova foi liberada', () => {
  const mapa = fs.readFileSync(path.join(RAIZ, 'perfis-api-map.js'), 'utf8');
  const prefixos = (mapa.match(/^\s*'\/api\//gm) || []).length;
  // 176 desde 2026-09-12: `/api/orcamento-publico` entrou em LIBERADOS para o
  // link público do orçamento. É a ÚNICA rota pública nova, e ela não abre o
  // painel — devolve um recorte de UM orçamento, identificado por token de 64
  // hex. A rota interna `/api/pedidos/*` segue exigindo sessão.
  // 178 desde 2026-09-26: `/api/roteiros` e `/api/visitas`, para as páginas
  // `visita` e `crm-funil` (roteiros de venda e visita em campo, de 18/09).
  // Aceitos pelo usuário ao fechar a frente da agenda e dos roteiros.
  assert(prefixos === 178, `o mapa de API mudou: ${prefixos} prefixos (eram 178)`);
});

t('O. nenhuma pagina nova ganhou acesso', () => {
  const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));
  const paginas = menuConfig.secoes.reduce((a, s) => a + s.itens.length, 0);
  // Piso, não igualdade: o total sobe quando uma tela legítima é acrescentada
  // (Categorias entrou na Fase 44). O risco que este teste cobre é PERDER um
  // item — a chave do menu está gravada em `perfis_acesso.paginas` nos tenants,
  // e removê-la tira o acesso de quem já a tinha.
  assert(paginas >= 190, `o menu perdeu itens: ${paginas} (piso 190) — a Fase 3.2 é visual`);
  // O filtro de acesso continua sendo o mesmo caminho.
  assert(/function desenharMenuComAcesso/.test(JS_SB), 'desenharMenuComAcesso sumiu');
  assert(/acessoDoUsuario|meu-acesso/.test(JS_SB), 'o menu deixou de consultar o acesso do usuário');
});

// ==================== mobile ====================

t('P. no mobile o compacto nao se aplica e a gaveta continua', () => {
  assert(/@media \(max-width: 768px\) \{\s*\[data-sidebar="compacta"\] \{ --sidebar-w: 250px/.test(CSS_SB),
    'a sidebar compacta valeria no celular, deixando a gaveta com 64px');
  assert(/\.sidebar \{\s*transform: translateX\(-100%\)/.test(CSS_SB.slice(CSS_SB.indexOf('@media (max-width: 768px)'))),
    'a gaveta mobile sumiu');
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
