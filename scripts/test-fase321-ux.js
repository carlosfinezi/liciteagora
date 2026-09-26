/**
 * Fase 3.2.1 — tooltip sem duplicata, cabeçalho do pedido e campos dependentes.
 *
 * A lógica de vínculo produto→campos é EXTRAÍDA do HTML e EXECUTADA sobre um DOM
 * simulado. Não é regex sobre o fonte: o relatório 24 mostrou que texto quebrado
 * casa com regex igual, e foi assim que um arquivo que nem parseava passou por
 * 14 testes verdes.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const PEDIDO = fs.readFileSync(path.join(PUB, 'comercial/pedido.html'), 'utf8');
const JS_SB = fs.readFileSync(path.join(PUB, 'js/sidebar.js'), 'utf8');
const CSS_SB = fs.readFileSync(path.join(PUB, 'css/sidebar.css'), 'utf8');
const CSS_APP = fs.readFileSync(path.join(PUB, 'css/app-modern.css'), 'utf8');

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- monta o menu de verdade ----------
function menuHTML(pagina) {
  const el = () => ({ setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {}, contains: () => false },
    appendChild() {}, addEventListener() {}, focus() {}, querySelector: () => null,
    querySelectorAll: () => [], children: [] });
  const doc = { documentElement: el(), body: el(), head: el(), createElement: el,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, readyState: 'complete' };
  const ctx = { document: doc, localStorage: { getItem: () => null, setItem() {} },
    location: { pathname: '/app.html', search: '', hash: '' },
    console: { log() {}, warn() {} }, fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    navigator: { userAgent: 't' }, matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900,
    history: { pushState() {}, replaceState() {} }, requestAnimationFrame: (f) => { f(0); return 0; },
    URL, URLSearchParams, JSON, Date, Math, RegExp, Object, Array, String, Number, Boolean,
    Error, Promise, Set, Map, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, isFinite };
  ctx.window = ctx; ctx.self = ctx; ctx.parent = ctx; ctx.globalThis = ctx; ctx.window.__liciteShell = true;
  vm.createContext(ctx);
  for (const f of ['js/theme-boot.js', 'js/menu-config.js', 'js/sidebar.js']) {
    new vm.Script(fs.readFileSync(path.join(PUB, f), 'utf8'), { filename: f }).runInContext(ctx);
  }
  return ctx.gerarMenuHTML(pagina);
}

const HTML = menuHTML('pedidos');
const itens = [...HTML.matchAll(/<a [^>]*class="menu-item"[^>]*>/g)].map((m) => m[0]);
const secoes = [...HTML.matchAll(/<div class="menu-section menu-section-toggle"[^>]*>/g)].map((m) => m[0]);

// ==================== A. TOOLTIP SEM DUPLICATA ====================

t('A. nenhum item da sidebar tem `title` (o nativo duplicava o nosso)', () => {
  const comTitle = itens.filter((i) => / title="/.test(i));
  assert(comTitle.length === 0,
    `${comTitle.length} item(ns) ainda emitem title — o navegador desenha o tooltip branco por cima: ${comTitle[0] || ''}`);
});

t('A2. nem os cabecalhos de grupo emitem title', () => {
  assert(secoes.filter((s) => / title="/.test(s)).length === 0, 'cabeçalho de grupo ainda tem title');
  // "Alterar Senha" e "Sair" saíram do menu lateral na Fase 3.3 — foram para o
  // menu de conta da topbar, que é um dropdown com rótulo escrito ao lado e não
  // depende de tooltip nenhum. Não há mais o que checar aqui.
  assert(!/data-tooltip="Sair"/.test(HTML), '"Sair" voltou ao menu lateral');
});

t('A3. o tooltip so aparece com a sidebar RECOLHIDA', () => {
  assert(/html:not\(\[data-sidebar="compacta"\]\) \.sb-tooltip \{[^}]*display: none/.test(CSS_SB),
    'o tooltip apareceria também na barra expandida, onde o nome já está escrito ao lado');
  assert(/if \(!sidebarCompacta\(\)\) return;/.test(JS_SB), 'mostrarTooltip não verifica o estado da barra');
});

// ==================== B/C. NOME REAL E RBAC ====================

t('B. o tooltip continua vindo do item real do menu (nada duplicado)', () => {
  const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));
  const nomes = new Set();
  for (const s of menuConfig.secoes) for (const i of s.itens) nomes.add(String(i.texto).trim());
  const acoes = new Set(['Alterar Senha', 'Sair']);   // ações locais, não páginas
  let doMenu = 0;
  for (const tag of itens) {
    const tip = (/data-tooltip="([^"]*)"/.exec(tag) || [])[1];
    assert(tip, 'item sem data-tooltip: ' + tag.slice(0, 70));
    const limpo = tip.replace(/&quot;/g, '"');
    assert(nomes.has(limpo) || acoes.has(limpo), `"${limpo}" não vem do menu-config`);
    if (nomes.has(limpo)) doMenu++;
  }
  assert(doMenu > 5, 'poucos itens de menu conferidos');
});

t('B2. a acessibilidade nao regrediu: aria-label em todos', () => {
  const sem = itens.filter((i) => !/aria-label="/.test(i));
  assert(sem.length === 0, `${sem.length} item(ns) sem aria-label — o title saiu e nada substituiria para leitor de tela`);
  assert(/role="button"/.test(secoes[0] || ''), 'cabeçalho de grupo perdeu role=button');
  assert(/aria-expanded=/.test(secoes[0] || ''), 'cabeçalho de grupo perdeu aria-expanded');
});

t('C. RBAC inalterado: mapa de API e itens de menu iguais', () => {
  const mapa = fs.readFileSync(path.join(RAIZ, 'perfis-api-map.js'), 'utf8');
  // 176 desde 2026-09-12: `/api/orcamento-publico` entrou em LIBERADOS, para o
  // link público do orçamento. Única rota pública nova; a interna
  // `/api/pedidos/*` continua exigindo sessão.
  // 178 desde 2026-09-26: `/api/roteiros` e `/api/visitas`, para as páginas
  // `visita` e `crm-funil` (roteiros de venda e visita em campo, de 18/09).
  // Aceitos pelo usuário ao fechar a frente da agenda e dos roteiros.
  assert((mapa.match(/^\s*'\/api\//gm) || []).length === 178, 'o mapa de API mudou');
  const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));
  // Piso, não igualdade: o total sobe quando uma tela legítima é acrescentada
  // (Categorias entrou na Fase 44). O risco coberto aqui é PERDER um item — a
  // chave do menu está gravada em `perfis_acesso.paginas` nos tenants.
  const nItens = menuConfig.secoes.reduce((a, s) => a + s.itens.length, 0);
  assert(nItens >= 190, `o menu perdeu itens: ${nItens} (piso 190)`);
  assert(/function desenharMenuComAcesso/.test(JS_SB), 'desenharMenuComAcesso sumiu');
});

// ==================== D/E. CABEÇALHO DO PEDIDO ====================

/**
 * A Fase 3.3 removeu a CAUSA que estes três testes vigiavam.
 *
 * O botão de tema era `position: fixed` sobre o conteúdo e caía sobre "Salvar"
 * e "Ações"; a correção da Fase 3.2.1 foi reservar 58px no `.ped-header`. Com o
 * botão dentro da topbar do shell — fora do iframe —, não há mais o que
 * reservar, e a reserva saiu. O que estes testes provam agora é que a causa não
 * voltou.
 */
t('D. nada flutua sobre o cabecalho do pedido, e a reserva saiu', () => {
  const btn = /#btnTema \{([^}]*)\}/.exec(CSS_SB);
  assert(btn, 'bloco do #btnTema sumiu');
  assert(!/position:\s*fixed/.test(btn[1]),
    'o botão de tema voltou a ser fixed — cobriria "Salvar" e "Ações" de novo');
  assert(!/\.ped-header \{ padding:\s*\d+px\s+5\dpx/.test(PEDIDO),
    'a reserva de 58px voltou ao .ped-header sem um botão flutuante para reservar');
});

t('E. o drawer de Acoes fica acima da pagina e abaixo dos modais', () => {
  // A comparação com o botão de tema saiu: ele está no documento PAI, e o
  // drawer dentro do iframe — contextos de empilhamento diferentes. O regex
  // antigo, aliás, escorregava para o z-index seguinte e media outra regra.
  const zDrawer = Number(/\.drawer-overlay \{[^}]*z-index:\s*(\d+)/.exec(PEDIDO)[1]);
  assert(zDrawer > 0, 'o drawer perdeu o z-index');
  assert(zDrawer < 10000, `drawer (${zDrawer}) acima dos modais`);
});

t('E2. o botao de tema continua existindo (nao foi escondido)', () => {
  assert(!/#btnTema[^{]*\{[^}]*display:\s*none/.test(CSS_SB.replace(/@media print[\s\S]*?\}\s*\}/g, '')),
    'o botão de tema foi escondido fora da impressão');
  assert(/function montarTopbar/.test(JS_SB), 'montarTopbar sumiu — o botão de tema mora nela');
});

// ==================== F–I. CAMPOS DO ITEM (lógica executada) ====================

/**
 * Extrai `desvincularProduto` do HTML e a executa contra campos simulados.
 * É o único jeito de provar o comportamento sem abrir o navegador.
 */
function montarCampos(valores) {
  const campos = {};
  for (const [id, v] of Object.entries(valores)) campos[id] = { value: v, textContent: '' };
  const doc = { getElementById: (id) => campos[id] || null };
  const fnSrc = /function desvincularProduto\(\)\{[\s\S]*?\n\}/.exec(PEDIDO);
  assert(fnSrc, 'desvincularProduto não encontrada em pedido.html');
  const ctx = { document: doc, _itemAuto: null, String };
  vm.createContext(ctx);
  new vm.Script(`${fnSrc[0]}; globalThis.__run = (auto) => { _itemAuto = auto; desvincularProduto(); };`)
    .runInContext(ctx);
  return { campos, run: (auto) => ctx.__run(auto) };
}

t('F. apos adicionar item, o foco volta para a busca de produto', () => {
  const add = /async function addItem\(\)\{[\s\S]*?\n\}/.exec(PEDIDO);
  assert(add, 'addItem não encontrada');
  assert(/getElementById\('itBusca'\)[\s\S]{0,200}\.focus\(/.test(add[0]),
    'addItem não devolve o foco ao campo de busca');
  assert(/preventScroll: true/.test(add[0]), 'o foco pode fazer a tela saltar — falta preventScroll');
});

t('F2. o foco NAO e roubado no carregamento da pagina', () => {
  // O card "Adicionar item" fica abaixo do cabeçalho e das abas: focá-lo no load
  // rolaria a tela sozinha. O foco deve acontecer só após adicionar.
  assert(!/DOMContentLoaded[\s\S]{0,300}itBusca[\s\S]{0,80}\.focus\(/.test(PEDIDO),
    'há foco automático no carregamento — rolaria a tela para baixo');
  assert(!/<input[^>]*id="itBusca"[^>]*\bautofocus\b/.test(PEDIDO), 'itBusca tem autofocus');
});

t('G. ao selecionar produto, descricao e preco sao preenchidos (como hoje)', () => {
  const sel = /async function selItemProd\([\s\S]*?\n\}/.exec(PEDIDO);
  assert(sel, 'selItemProd não encontrada');
  assert(/itProdId'\)\.value = id/.test(sel[0]), 'não grava o produtoId');
  // O corpo do `if (preencheuDesc)` virou bloco quando a descrição passou a ser
  // textarea (precisa reajustar a altura junto). O que importa continua sendo o
  // mesmo: dentro dessa condição, `itDesc` recebe `desc`.
  const ramo = /if \(preencheuDesc\)([\s\S]*?)\n  \}/.exec(sel[0]) || /if \(preencheuDesc\)([^\n]*)/.exec(sel[0]);
  assert(ramo && /itDesc'\)[\s\S]*\.value = desc|campo\.value = desc/.test(ramo[1]),
    'não preenche a descrição');
  assert(/resolverPrecoItem\(pv\)/.test(sel[0]), 'não resolve o preço');
  // A regra antiga — não sobrescrever descrição já digitada — foi preservada.
  assert(/const preencheuDesc = !val\('itDesc'\)/.test(sel[0]),
    'passou a sobrescrever descrição já digitada');
});

t('H. limpar o produto SEM editar limpa descricao e preco automaticos', () => {
  const { campos, run } = montarCampos({
    itProdId: '42', itDesc: 'CHOCOLATE GRANULADO - FD 20 UN 25G', itPu: '18.90',
    itQtd: '7', itPrecoFonte: '',
  });
  run({ busca: 'CHOC-01 — CHOCOLATE GRANULADO - FD 20 UN 25G',
        desc: 'CHOCOLATE GRANULADO - FD 20 UN 25G', pu: '18.90' });
  assert(campos.itProdId.value === '', 'o vínculo com o produto não foi desfeito');
  assert(campos.itDesc.value === '', 'a descrição automática continuou preenchida');
  assert(campos.itPu.value === '', 'o valor unitário automático continuou preenchido');
  assert(campos.itQtd.value === '7', 'a QUANTIDADE foi apagada — ela é do usuário, não do produto');
});

t('I. descricao EDITADA a mao e preservada (o item vira avulso)', () => {
  const { campos, run } = montarCampos({
    itProdId: '42', itDesc: 'CHOCOLATE GRANULADO - EMBALAGEM ESPECIAL', itPu: '18.90',
    itQtd: '3', itPrecoFonte: '',
  });
  run({ busca: 'CHOC-01 — CHOCOLATE GRANULADO - FD 20 UN 25G',
        desc: 'CHOCOLATE GRANULADO - FD 20 UN 25G', pu: '18.90' });
  assert(campos.itProdId.value === '', 'o vínculo não foi desfeito');
  assert(campos.itDesc.value === 'CHOCOLATE GRANULADO - EMBALAGEM ESPECIAL',
    'apagou texto que o usuário digitou — pior que o defeito original');
  assert(campos.itPu.value === '', 'o preço automático deveria sair (não foi editado)');
});

t('I2. preco EDITADO a mao tambem e preservado', () => {
  const { campos, run } = montarCampos({
    itProdId: '42', itDesc: 'CHOCOLATE GRANULADO - FD 20 UN 25G', itPu: '25.00',
    itQtd: '1', itPrecoFonte: '',
  });
  run({ busca: 'x', desc: 'CHOCOLATE GRANULADO - FD 20 UN 25G', pu: '18.90' });
  assert(campos.itDesc.value === '', 'descrição automática deveria sair');
  assert(campos.itPu.value === '25.00', 'apagou o preço que o usuário digitou');
});

t('I3. desvincular sem produto vinculado nao faz nada', () => {
  const { campos, run } = montarCampos({
    itProdId: '', itDesc: 'ITEM AVULSO DIGITADO', itPu: '9.90', itQtd: '2', itPrecoFonte: '',
  });
  run({ busca: '', desc: '', pu: '' });
  assert(campos.itDesc.value === 'ITEM AVULSO DIGITADO', 'mexeu num item avulso que ninguém vinculou');
  assert(campos.itPu.value === '9.90', 'apagou o preço de um item avulso');
});

t('H2. o vinculo se desfaz ao APAGAR ou ao EDITAR o campo de busca', () => {
  const ac = /async function acItemProd\(\)\{[\s\S]*?\n\}/.exec(PEDIDO);
  assert(ac, 'acItemProd não encontrada');
  assert(/val\('itBusca'\) !== _itemAuto\.busca/.test(ac[0]),
    'o vínculo só cairia se o campo ficasse vazio — editar o texto também o desfaz');
  assert(/desvincularProduto\(\)/.test(ac[0]), 'acItemProd não desvincula');
});

// ==================== J/K. NADA DE REGRA MUDOU ====================

t('J. a regra de preco continua no servidor', () => {
  const politicas = fs.readFileSync(path.join(RAIZ, 'pedido-politicas.js'), 'utf8');
  assert(/function precoDeItem/.test(politicas), 'precoDeItem sumiu');
  // A tela continua consultando o servidor para resolver preço.
  assert(/\/api\/precos\/resolver|resolverPrecoItem/.test(PEDIDO), 'a tela deixou de resolver preço pelo servidor');
});

t('K. o modelo de pedido nao mudou (item avulso continua permitido)', () => {
  const add = /async function addItem\(\)\{[\s\S]*?\n\}/.exec(PEDIDO)[0];
  assert(/produtoId: val\('itProdId'\) \? Number\(val\('itProdId'\)\) : null/.test(add),
    'o envio de produtoId mudou — item avulso depende desse null');
  assert(/descricao, quantidade: qtd, precoUnitario: pu/.test(add), 'o corpo enviado mudou');
});

// ==================== L. TEMAS ====================

t('L. tooltip, flyout e cabecalho do pedido usam tokens', () => {
  const bloco = CSS_SB.slice(CSS_SB.indexOf('FASE 3.2'));
  const fixas = [];
  for (const m of bloco.matchAll(/(?:^|[;{\s])(color|background(?:-color)?|border-color)\s*:\s*([^;}]+)/g)) {
    const v = m[2].trim();
    if (/var\(--|transparent|inherit|none|currentColor/i.test(v)) continue;
    if (/^rgba?\(0,\s*0,\s*0/.test(v)) continue;
    fixas.push(`${m[1]}: ${v}`);
  }
  assert(fixas.length === 0, 'cor fixa: ' + fixas.join(' · '));
  assert(/\.ped-header \{[^}]*var\(--border\)/.test(PEDIDO), 'o cabeçalho do pedido perdeu os tokens');
  // O tema custom legado continua vivo.
  assert(/function paletaCustom/.test(JS_SB), 'a paleta do tema custom foi removida');
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
