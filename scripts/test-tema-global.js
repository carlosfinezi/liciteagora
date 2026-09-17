/**
 * Tema claro/escuro — coerência dos tokens, contraste e resolução da preferência.
 *
 * Não é teste de navegador: é teste do que dá para verificar sem um. Três coisas:
 *
 *   1. os dois temas definem EXATAMENTE os mesmos tokens (se o claro esquecer
 *      um, aquele componente fica com a cor do escuro e ninguém percebe até
 *      alguém abrir a tela);
 *   2. o contraste de cada par texto/fundo atende a WCAG AA;
 *   3. `theme-boot.js` e `sidebar.js` resolvem a preferência do MESMO jeito —
 *      se discordarem, a página nasce num tema e pula para o outro.
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(RAIZ, 'public/css/app-modern.css'), 'utf8');

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

/** Tokens de um bloco CSS (`:root { … }` ou `[data-theme="claro"] { … }`). */
function tokens(seletor) {
  const i = CSS.indexOf(seletor);
  if (i < 0) throw new Error('seletor não encontrado: ' + seletor);
  const ini = CSS.indexOf('{', i), fim = CSS.indexOf('}', ini);
  const corpo = CSS.slice(ini + 1, fim);
  const out = {};
  for (const m of corpo.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  return out;
}

const ESCURO = tokens(':root');
const CLARO = tokens('[data-theme="claro"]');

// ---------- contraste (WCAG) ----------
function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lum(hex) {
  const c = rgb(hex);
  if (!c) return null;
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function contraste(a, b) {
  const la = lum(a), lb = lum(b);
  if (la == null || lb == null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ==================== A. COBERTURA DOS TOKENS ====================

/**
 * Quais tokens PRECISAM existir nos dois temas.
 *
 * Só os de COR — e "cor" aqui é o valor, não o nome: um token é de cor quando o
 * `:root` lhe dá um literal (`#hex`, `rgb(...)`). Três famílias ficam de fora, e
 * cada uma por um motivo diferente:
 *
 *   - **espaçamento, tipografia, raio, peso** (`--space-*`, `--text-*`, `--r-*`,
 *     `--lh-*`, `--peso-*`): não mudam entre claro e escuro. 12px são 12px.
 *   - **apelidos** (`--primary`, `--superficie-*`, `--muted`): o valor é
 *     `var(--outro-token)`. Eles resolvem sozinhos para o token de cor de cada
 *     tema — redefini-los no claro seria duplicar a mesma informação em dois
 *     lugares, que é justamente o que os apelidos vieram evitar.
 *   - **sombra e foco**: já são tratados em regra própria, e a sombra é
 *     deliberadamente diferente entre os temas (§ tema claro).
 *
 * A regra anterior era "todo token declarado no escuro tem par no claro", e ela
 * valia enquanto TODO token era cor. A fundação da Fase 3.1 trouxe tokens que não
 * são, e a premissa precisou ficar explícita.
 */
const ehCor = (valor) => /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(String(valor).trim());
const tokensDeCor = (o) => Object.keys(o).filter((k) => ehCor(o[k])).sort();

t('A1. o tema claro define os MESMOS tokens de COR do escuro', () => {
  const faltando = tokensDeCor(ESCURO).filter((k) => !(k in CLARO));
  assert(faltando.length === 0, 'o tema claro não define: ' + faltando.join(', '));
});

t('A2. nenhum token de cor do claro sobra sem par no escuro', () => {
  const sobra = tokensDeCor(CLARO).filter((k) => !(k in ESCURO));
  assert(sobra.length === 0, 'só no claro: ' + sobra.join(', '));
});

t('A1b. os apelidos da fundacao apontam para tokens que EXISTEM', () => {
  // Um `var(--nao-existe)` renderiza transparente e passaria despercebido.
  const declarados = new Set([...Object.keys(ESCURO), ...Object.keys(CLARO)]);
  const ruins = [];
  for (const [k, v] of Object.entries(ESCURO)) {
    for (const m of String(v).matchAll(/var\((--[a-z0-9-]+)/gi)) {
      if (!declarados.has(m[1])) ruins.push(`${k} → ${m[1]}`);
    }
  }
  assert(ruins.length === 0, 'apelido apontando para token inexistente: ' + ruins.join(', '));
});

t('A3. os 23 tokens que o tema custom legado sobrescreve existem nos dois', () => {
  const legado = ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-hover', '--bg-input',
    '--border', '--border-strong', '--text-0', '--text-1', '--text-2', '--text-3',
    '--accent', '--accent-strong', '--accent-soft', '--success', '--success-soft',
    '--warn', '--warn-soft', '--danger', '--danger-soft', '--purple', '--purple-soft'];
  for (const k of legado) {
    assert(ESCURO[k], 'escuro sem ' + k);
    assert(CLARO[k], 'claro sem ' + k);
  }
});

// ==================== B. CONTRASTE ====================
const PARES = [
  ['--text-0', '--bg-0', 4.5], ['--text-0', '--bg-1', 4.5], ['--text-0', '--bg-2', 4.5],
  ['--text-1', '--bg-0', 4.5], ['--text-1', '--bg-1', 4.5],
  ['--text-2', '--bg-0', 4.5], ['--text-2', '--bg-1', 4.5],
  // --text-3 é decorativo (placeholder, legenda): AA large / UI = 3:1
  ['--text-3', '--bg-1', 3.0],
  ['--accent', '--bg-0', 3.0], ['--accent', '--bg-1', 3.0],
];

for (const [nome, tema] of [['ESCURO', ESCURO], ['CLARO', CLARO]]) {
  t(`B. contraste AA no tema ${nome}`, () => {
    const ruins = [];
    for (const [fg, bg, min] of PARES) {
      const r = contraste(tema[fg], tema[bg]);
      if (r == null) continue;                     // valor com alfa: fora do cálculo
      if (r < min) ruins.push(`${fg} sobre ${bg} = ${r.toFixed(2)}:1 (mínimo ${min})`);
    }
    assert(ruins.length === 0, ruins.join(' · '));
  });
}

t('B3. texto de estado legivel sobre o proprio fundo suave (tema claro)', () => {
  const ruins = [];
  for (const c of ['success', 'warn', 'danger', 'purple', 'accent']) {
    const r = contraste(CLARO['--' + c], CLARO['--' + c + '-soft']);
    if (r != null && r < 4.5) ruins.push(`${c} = ${r.toFixed(2)}:1`);
  }
  assert(ruins.length === 0, 'badges ilegíveis: ' + ruins.join(', '));
});

// ==================== A4. FUNDAÇÃO DA FASE 3.1 ====================

t('A4. a escala tipografica esta declarada e e coerente', () => {
  const escala = ['--text-xs', '--text-sm', '--text-base', '--text-md', '--text-lg', '--text-xl', '--text-2xl'];
  const valores = escala.map((k) => {
    assert(ESCURO[k], 'falta ' + k);
    const m = /^([\d.]+)rem$/.exec(ESCURO[k].trim());
    assert(m, `${k} deveria ser rem (respeita o zoom do navegador), veio "${ESCURO[k]}"`);
    return Number(m[1]);
  });
  for (let i = 1; i < valores.length; i++) {
    assert(valores[i] > valores[i - 1],
      `a escala não é crescente: ${escala[i - 1]}=${valores[i - 1]} ≥ ${escala[i]}=${valores[i]}`);
  }
  assert(valores[2] === 0.875, '--text-base deveria ser 0.875rem (14px), o corpo que o ERP já usa');
});

t('A5. espacamento, raio, borda, foco e superficies declarados', () => {
  for (const k of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7',
                   '--raio-sm', '--raio-md', '--raio-lg', '--raio-pill',
                   '--borda', '--borda-forte', '--foco', '--foco-offset',
                   '--superficie-app', '--superficie', '--superficie-alta', '--superficie-apoio',
                   '--primary', '--muted', '--info']) {
    assert(ESCURO[k], 'falta ' + k);
  }
  // A escala de espaçamento é múltipla de 4: valores que não encaixam produzem
  // desalinhamento de 1-2px que ninguém consegue explicar depois.
  for (const k of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7']) {
    const n = Number(/^(\d+)px$/.exec(ESCURO[k].trim())?.[1]);
    assert(Number.isInteger(n) && n % 4 === 0, `${k} = ${ESCURO[k]} não é múltiplo de 4px`);
  }
});

t('A6. a fundacao NAO mudou o tamanho dos componentes existentes', () => {
  // A Fase 3.1 cria a escala mas não a aplica em botão, badge, label ou input —
  // fazê-lo mudaria o tamanho de 1.847 botões em 213 telas sem validação visual.
  // Se alguém aplicar sem medir, este teste avisa.
  //
  // As `@media` são removidas antes da busca, e isso não é afrouxar a regra: o
  // que ela protege é o tamanho no DESKTOP, onde a mudança seria invisível até
  // alguém reclamar. Dentro de um breakpoint de celular, mudar o alvo de toque
  // de um botão é o objetivo — foi o que a responsividade global fez em
  // 2026-09-12, com medição em 320/360/390/430px.
  const semMedia = CSS.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const bloco = semMedia.slice(semMedia.indexOf('FASE 3.1 — FOCO ACESSÍVEL'));
  for (const sel of ['.btn ', '.btn-sm', '.badge', '.label', '.kpi']) {
    const re = new RegExp(`\\n\\s*${sel.trim().replace('.', '\\.')}[^{]*\\{[^}]*font-size`);
    assert(!re.test(bloco),
      `o bloco da Fase 3.1 mudou o font-size de "${sel.trim()}" — meça o delta antes (ver relatório 27)`);
  }
});

t('B4. o tema claro nao usa branco puro como fundo da aplicacao', () => {
  assert(CLARO['--bg-0'].toLowerCase() !== '#ffffff',
    'fundo branco puro apaga a hierarquia — card branco sobre fundo branco');
  assert(CLARO['--bg-1'].toLowerCase() === '#ffffff', 'as superfícies deveriam ser brancas');
});

t('B5. o tema escuro nao usa preto absoluto', () => {
  for (const k of ['--bg-0', '--bg-1', '--bg-2']) {
    assert(!/^#000000?$/i.test(ESCURO[k]), `${k} é preto absoluto`);
  }
});

// ==================== C. RESOLUÇÃO DA PREFERÊNCIA ====================
/**
 * As funções `ehClaro` e `resolver` do `theme-boot.js`, extraídas do fonte e
 * executadas de verdade.
 *
 * Extrai as DUAS funções em vez de rodar o IIFE inteiro: o corpo do IIFE mexe em
 * `document` e `localStorage` e teria de ser todo simulado — e o que se quer
 * testar é a decisão, não o efeito colateral.
 */
function resolverDoBoot() {
  const src = fs.readFileSync(path.join(RAIZ, 'public/js/theme-boot.js'), 'utf8');
  const ehClaro = /function ehClaro\(hex\) \{[\s\S]*?\n  \}/.exec(src);
  const resolver = /function resolver\(valor\) \{[\s\S]*?\n  \}/.exec(src);
  assert(ehClaro && resolver, 'não achei ehClaro/resolver em theme-boot.js');
  return new Function(`${ehClaro[0]}\n${resolver[0]}\nreturn resolver;`)();
}

t('C1. theme-boot resolve cada valor de tema corretamente', () => {
  const r = resolverDoBoot();
  const casos = [
    ['claro', 'claro'], ['escuro', 'escuro'], ['padrao', 'escuro'], ['', 'escuro'],
    [null, 'escuro'], ['valor-estranho', 'escuro'],
    ['custom:#ffffff:#1f6dea', 'claro'],     // usuário real: william
    ['custom:#f5f7f9:#021a40', 'claro'],     // usuário real: 1bit/admin
    ['custom:#fcfcfc:#1a1acb', 'claro'],     // usuário real: josecarlos/admin
    ['custom:#fcfcfd:#0c4bb0', 'claro'],     // usuário real: caio
    ['custom:#030202:#114283', 'escuro'],    // usuário real: produtosbomgosto/admin
  ];
  for (const [entrada, esperado] of casos) {
    assert(r(entrada) === esperado, `${JSON.stringify(entrada)} → ${r(entrada)}, esperado ${esperado}`);
  }
});

t('C2. sidebar.js (baseDoTema) concorda com theme-boot em TODOS os casos', () => {
  // Se discordarem, a página nasce num tema e pula para o outro — o flash que
  // o theme-boot existe para evitar.
  const src = fs.readFileSync(path.join(RAIZ, 'public/js/sidebar.js'), 'utf8');
  const corpo = /function baseDoTema\(tema\) \{([\s\S]*?)\n\}/.exec(src);
  assert(corpo, 'baseDoTema não encontrada em sidebar.js');
  const lumSrc = /function lumHex\(hex\) \{([\s\S]*?)\n\}/.exec(src);
  const base = new Function('CUSTOM_TEMA_RE', `
    function lumHex(hex) {${lumSrc[1]}}
    return function baseDoTema(tema) {${corpo[1]}};
  `)(/^custom:(#[0-9a-fA-F]{6}):(#[0-9a-fA-F]{6})$/);

  const boot = resolverDoBoot();
  const entradas = ['claro', 'escuro', 'padrao', '', 'xpto',
    'custom:#ffffff:#1f6dea', 'custom:#f5f7f9:#021a40', 'custom:#030202:#114283',
    'custom:#808080:#111111', 'custom:#7f7f7f:#111111'];
  for (const e of entradas) {
    assert(base(e) === boot(e), `divergem em ${JSON.stringify(e)}: sidebar=${base(e)} boot=${boot(e)}`);
  }
});

// ==================== D. INTEGRAÇÃO ====================
t('D1. todas as telas com sidebar.js carregam o theme-boot ANTES do CSS', () => {
  const falhas = [];
  const varrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (e.name.endsWith('.html')) {
        const s = fs.readFileSync(p, 'utf8');
        if (!s.includes('/js/sidebar.js')) continue;
        const tb = s.indexOf('/js/theme-boot.js');
        const css = s.indexOf('<link rel="stylesheet"');
        if (tb < 0) falhas.push(path.relative(RAIZ, p) + ' (sem theme-boot)');
        else if (css >= 0 && tb > css) falhas.push(path.relative(RAIZ, p) + ' (depois do CSS)');
      }
    }
  };
  varrer(path.join(RAIZ, 'public'));
  assert(falhas.length === 0, falhas.slice(0, 5).join(' · '));
});

t('D2. Senha e Sair existem em UM lugar so: o menu de conta da topbar', () => {
  const s = fs.readFileSync(path.join(RAIZ, 'public/js/sidebar.js'), 'utf8');
  // Fase 3.3: o grupo Conta saiu do menu lateral. Se voltar, a mesma ação passa
  // a ter dois caminhos — um deles escondido num grupo recolhível.
  assert(!/id="grp-conta"/.test(s), 'o grupo Conta voltou ao menu lateral');
  const menuConta = /function montarMenuConta\(\)[\s\S]*?\n}/.exec(s);
  assert(menuConta, 'montarMenuConta não encontrada');
  assert(/Alterar Senha/.test(menuConta[0]), 'Alterar Senha sumiu do menu de conta');
  assert(/>Sair</.test(menuConta[0]), 'Sair sumiu do menu de conta');
  // As ações continuam sendo as mesmas funções de sempre, não cópias novas.
  assert(/abrirModalSenha\(\)/.test(menuConta[0]) && /fazerLogout\(\)/.test(menuConta[0]),
    'o menu de conta deixou de chamar abrirModalSenha/fazerLogout');
  assert(!/>\s*Cor do Sistema/.test(menuConta[0]), '"Cor do Sistema" voltou como item');
});

t('D3. o caminho legado do tema custom continua existindo (dados preservados)', () => {
  const s = fs.readFileSync(path.join(RAIZ, 'public/js/sidebar.js'), 'utf8');
  for (const fn of ['abrirModalTema', 'salvarTemaCustom', 'paletaCustom', 'restaurarTemaPadrao']) {
    assert(s.includes('function ' + fn), fn + ' foi removida — usuários com tema custom ficariam presos');
  }
});

const CSS_SB = fs.readFileSync(path.join(RAIZ, 'public/css/sidebar.css'), 'utf8');
const CSS_PDV = fs.readFileSync(path.join(RAIZ, 'public/comercial/pedidos-pdv.html'), 'utf8');
const CSS_PED = fs.readFileSync(path.join(RAIZ, 'public/comercial/pedido.html'), 'utf8');

/**
 * A DÍVIDA QUE ESTA VERIFICAÇÃO SUBSTITUI.
 *
 * Até a Fase 3.2 o botão de tema era `position: fixed` sobre o conteúdo. Como
 * não empurrava nada, cada cabeçalho precisava reservar espaço por conta
 * própria — e quem não reservasse era coberto. Aconteceu duas vezes: o Pedidos
 * PDV (relatório 25) e o Pedido (relatório 29), ambos porque têm cabeçalho
 * próprio e a reserva global do `.page-header` não os alcançava. A terceira
 * tela com cabeçalho próprio teria o mesmo defeito, e ninguém saberia até
 * alguém olhar.
 *
 * A Fase 3.3 tirou o botão de cima do conteúdo: ele foi para a topbar, que
 * OCUPA espaço (o iframe começa abaixo dela). Os testes abaixo não medem mais
 * reserva nenhuma — medem que a causa não voltou.
 */
t('D5. nada flutua mais sobre o conteudo: o botao de tema nao e fixed', () => {
  const bloco = /#btnTema \{([\s\S]*?)\}/.exec(CSS_SB);
  assert(bloco, 'bloco do #btnTema não encontrado');
  assert(!/position:\s*fixed/.test(bloco[1]),
    'o #btnTema voltou a ser fixed — passaria a cobrir os botões de ação das telas');
  assert(!/z-index/.test(bloco[1]),
    'o #btnTema ganhou z-index próprio: sinal de que voltou a disputar plano com o conteúdo');
  // Ele agora vive dentro da topbar, que é quem se posiciona.
  assert(/\.topbar \{[\s\S]*?position:\s*fixed/.test(CSS_SB), 'a .topbar deixou de ser fixed');
  assert(/\.topbar \{[\s\S]*?height:\s*var\(--topbar-h\)/.test(CSS_SB), '.topbar sem altura de token');
});

t('D6. as tres reservas de canto foram removidas e nao voltaram', () => {
  assert(!/\.page-header \{ padding-right:/.test(CSS),
    'a reserva do .page-header voltou — não há mais botão flutuante para reservar');
  assert(!/\.pdv-topo \{[\s\S]{0,200}?padding:\s*\d+px\s+5\dpx/.test(CSS_PDV),
    'a reserva do .pdv-topo voltou');
  assert(!/\.ped-header \{ padding:\s*\d+px\s+5\dpx/.test(CSS_PED),
    'a reserva do .ped-header voltou');
});

t('D7. a gaveta do PDV continua abaixo dos modais e acima do proprio fundo', () => {
  // A comparação com o botão de tema saiu de cena: a topbar está no documento
  // PAI e o PDV dentro do iframe — contextos de empilhamento diferentes, e a
  // topbar não alcança o conteúdo do iframe de qualquer jeito. O que ainda
  // precisa valer é a ordem INTERNA da gaveta.
  const gaveta = Number(/\.pdv-pedido \{\s*position: fixed;[\s\S]*?z-index:\s*(\d+)/.exec(CSS_PDV)[1]);
  const fundo = Number(/\.gaveta-bg \{[^}]*z-index:\s*(\d+)/.exec(CSS_PDV)[1]);
  assert(fundo < gaveta, `fundo (${fundo}) acima da própria gaveta (${gaveta})`);
  assert(gaveta < 10000, `gaveta (${gaveta}) acima dos modais`);
});

t('D4. nenhum arquivo de tela ficou com byte NUL (quebra grep/diff)', () => {
  const ruins = [];
  const varrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (/\.(html|js|css)$/.test(e.name)) {
        if (fs.readFileSync(p).includes(0)) ruins.push(path.relative(RAIZ, p));
      }
    }
  };
  varrer(path.join(RAIZ, 'public'));
  assert(ruins.length === 0, 'com NUL: ' + ruins.join(', '));
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
