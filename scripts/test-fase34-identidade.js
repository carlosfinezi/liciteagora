/**
 * Fase 3.4 — identidade visual nova.
 *
 * ── O que este arquivo vigia ────────────────────────────────────────────────
 *
 * Marca não é código: ninguém "usa" a logo e descobre que ela quebrou. Um
 * desenho errado fica no ar até alguém olhar — e olhar a sidebar de uma tela
 * qualquer não mostra o favicon em 16px, nem a versão monocromática, nem o que
 * acontece quando os dois SVG convivem na mesma página.
 *
 * Daí o foco aqui ser nos modos de falha que NÃO aparecem a olho nu:
 *
 *   - **colisão de IDs** entre os SVG embutidos (o defeito mais provável);
 *   - **distorção** por largura e altura fixadas ao mesmo tempo;
 *   - a barra recolhida voltar a usar a marca horizontal;
 *   - a marca deixar de acompanhar o tema (`currentColor` trocado por cor fixa);
 *   - o PNG antigo ser apagado;
 *   - os assets divergirem entre `public/img/` e a cópia embutida.
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

const ler = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const JS_SB = ler('js/sidebar.js');
const CSS_SB = semComentarios(ler('css/sidebar.css'));
const LOGIN = ler('auth/login.html');
// Quinta vez que um teste meu casa com o próprio comentário que explica a
// mudança: a nota dos tokens, no login, LISTA as cores que foram removidas.
// Toda busca por conteúdo usa a versão sem comentários — sem exceção.
const LOGIN_LIMPO = semComentarios(LOGIN);
const SVG_H = ler('img/marca-horizontal.svg');
const SVG_M = ler('img/marca-monograma.svg');
const SVG_MC = ler('img/marca-monocromatica.svg');
const SVG_FAV = ler('auth/favicon.svg');

const AZUL = '#2563EB';
const VERDE = '#22C55E';

// ============================================================================
// A. Os arquivos existem, e o antigo foi preservado
// ============================================================================

t('A1. os seis assets da identidade existem', () => {
  const esperados = [
    'img/marca-horizontal.svg',
    'img/marca-monograma.svg',
    'img/marca-monocromatica.svg',
    'auth/favicon.svg',
    'auth/favicon.ico',
    'auth/apple-touch-icon.png',
  ];
  for (const f of esperados) {
    assert(fs.existsSync(path.join(PUB, f)), f + ' não existe');
    assert(fs.statSync(path.join(PUB, f)).size > 200, f + ' está vazio ou truncado');
  }
});

t('A2. o PNG antigo continua no lugar, como fallback', () => {
  const p = path.join(PUB, 'img/logo-sistema.png');
  assert(fs.existsSync(p), 'logo-sistema.png foi apagado — era para ficar');
  assert(fs.statSync(p).size === 46707, 'logo-sistema.png foi alterado; deveria estar intacto');
});

t('A3. os favicons estao onde sao SERVIDOS, nao onde parecem', () => {
  // `base-middleware.js` monta `public/auth/` na RAIZ da URL, antes do auth.
  // Um favicon em `public/favicon.svg` nunca seria entregue: o de auth/ vence.
  const mid = fs.readFileSync(path.join(RAIZ, 'base-middleware.js'), 'utf8');
  assert(/express\.static\(path\.join\(__dirname, 'public', 'auth'\)\)/.test(mid),
    'a montagem de public/auth/ na raiz mudou — reveja onde os favicons devem morar');
  assert(!fs.existsSync(path.join(PUB, 'favicon.svg')),
    'existe um public/favicon.svg que NÃO é servido (auth/ vence) — dois arquivos, um morto');
});

// ============================================================================
// B. Colisão de IDs — o defeito mais provável, e invisível no código
// ============================================================================

t('B1. os SVG embutidos na mesma pagina nao compartilham nenhum id', () => {
  // `mask`, `clipPath` e `linearGradient` resolvem por id no DOCUMENTO inteiro,
  // não dentro do <svg>. Dois SVG com `id="az"` na mesma página fazem o segundo
  // usar o gradiente do primeiro — e, pior, a MÁSCARA do primeiro: o desenho
  // sai recortado no lugar errado, sem erro nenhum no console.
  const ids = (s) => [...s.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const naSidebar = ids(JS_SB.slice(JS_SB.indexOf('const MARCA_HORIZONTAL'), JS_SB.indexOf('function gerarMenuHTML')));
  const repetidos = naSidebar.filter((x, i) => naSidebar.indexOf(x) !== i);
  assert(repetidos.length === 0, 'id repetido entre as duas marcas da sidebar: ' + repetidos.join(', '));
  assert(naSidebar.length >= 6, 'esperava ao menos 6 ids (gradiente, clip e mask de cada marca), achei ' + naSidebar.length);
});

t('B2. o login nao colide com a sidebar (prefixo proprio)', () => {
  const idsLogin = [...LOGIN_LIMPO.matchAll(/\bid="([a-zA-Z][\w-]*)"/g)].map((m) => m[1]);
  assert(idsLogin.length >= 3, 'o SVG do login perdeu os ids de gradiente/clip/mask');
  for (const id of idsLogin) {
    assert(!JS_SB.includes('id="' + id + '"'),
      `o id "${id}" existe no login E na sidebar; se as duas telas se encontrarem, uma usa a máscara da outra`);
  }
});

t('B3. cada arquivo SVG tem ids unicos internamente', () => {
  for (const [nome, s] of [['horizontal', SVG_H], ['monograma', SVG_M], ['monocromatica', SVG_MC], ['favicon', SVG_FAV]]) {
    const ids = [...s.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    assert(dup.length === 0, `${nome}: id duplicado — ${dup.join(', ')}`);
  }
});

// ============================================================================
// C. Sem distorção — a razão de a marca ter virado dois desenhos
// ============================================================================

t('C1. a barra RECOLHIDA usa o monograma, nao a horizontal espremida', () => {
  assert(/\[data-sidebar="compacta"\] \.marca-horizontal \{ display: none/.test(CSS_SB),
    'a marca horizontal continua visível na barra recolhida — era o defeito a corrigir');
  assert(/\[data-sidebar="compacta"\] \.marca-monograma\s*\{ display: block/.test(CSS_SB),
    'o monograma não aparece na barra recolhida');
  assert(/\.marca-monograma\s*\{ display: none/.test(CSS_SB),
    'o monograma aparece também na barra ABERTA — ficariam as duas marcas juntas');
});

t('C2. nenhuma marca tem largura E altura fixas ao mesmo tempo', () => {
  // É assim que se distorce um SVG: fixar as duas e deixar o viewBox esticar.
  // `height: auto` faz a proporção vir do viewBox, e aí distorcer é impossível.
  const regras = CSS_SB.match(/\.marca[^{]*\{[^}]*\}/g) || [];
  assert(regras.length >= 3, 'as regras .marca sumiram do CSS');
  for (const r of regras) {
    const temW = /(^|[^-])width:\s*(?!auto)/.test(r);
    const temH = /(^|[^-])height:\s*(?!auto)/.test(r);
    assert(!(temW && temH), 'largura e altura fixas juntas distorcem o desenho: ' + r.replace(/\s+/g, ' '));
  }
  assert(/\.marca \{[^}]*height:\s*auto/.test(CSS_SB), '.marca perdeu height:auto');
});

t('C3. os viewBox batem com a proporcao do simbolo original', () => {
  // O símbolo da prancha mede 204x131 (1,557). O viewBox do monograma tem de
  // ficar perto disso, senão o desenho nasce achatado ou esticado.
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(SVG_M);
  assert(vb, 'monograma sem viewBox');
  const razao = Number(vb[1]) / Number(vb[2]);
  assert(razao > 1.4 && razao < 1.7, `monograma com proporção ${razao.toFixed(2)} (esperado ~1,56)`);
});

t('C4. a marca CABE na faixa util do cabecalho (conta refeita do CSS)', () => {
  // Esta conta já errou três vezes nesta série de fases — a reserva do botão de
  // tema nasceu 4px curta (relatório 20) e duas telas foram cobertas por não
  // terem reserva nenhuma (25 e 29). Todas descobertas por sobreposição
  // visível, depois do fato. Aqui ela é refeita a partir do CSS:
  //
  //   faixa útil = largura da barra − padding − botão de recolher − gap
  //
  // Se alguém aumentar a marca, engordar o botão ou o padding sem refazer a
  // conta, o teste reprova antes de a marca encostar no botão.
  const num = (re, onde, oque) => {
    const m = re.exec(onde);
    assert(m, 'não achei ' + oque);
    return Number(m[1]);
  };
  // A largura vem do token, não de um literal em `.sidebar` — ler o token é o
  // que mantém a conta certa se a barra for redimensionada um dia.
  const barra = num(/:root \{ --sidebar-w:\s*(\d+)px/, CSS_SB, 'o token --sidebar-w');
  const padHeader = /\.sidebar \.sidebar-header \{[^}]*padding:\s*(\d+)px\s+(\d+)px\s+(\d+)px\s+(\d+)px/.exec(CSS_SB);
  assert(padHeader, 'não achei o padding do cabeçalho');
  const padLat = Number(padHeader[2]) + Number(padHeader[4]);   // direita + esquerda
  const botao = num(/\.sidebar-toggle \{[^}]*width:\s*(\d+)px/, CSS_SB, 'a largura do botão de recolher');
  const gap = num(/\.sidebar-header \{ display: flex;[^}]*gap:\s*(\d+)px/, CSS_SB, 'o gap do cabeçalho');
  const marca = num(/\.marca-horizontal \{[^}]*max-width:\s*(\d+)px/, CSS_SB, 'a largura da marca');

  const util = barra - padLat - botao - gap;
  assert(marca <= util,
    `a marca (${marca}px) não cabe na faixa útil (${util}px) — ficaria por cima do botão de recolher`);
  assert(util - marca <= 12,
    `sobram ${util - marca}px de folga: ou a marca encolheu sem querer, ou há espaço desperdiçado`);

  // Recolhida: o monograma tem de caber nos 64px, com padding simétrico para
  // ficar centrado de verdade.
  const padComp = /\[data-sidebar="compacta"\] \.sidebar \.sidebar-header \{ padding:\s*(\d+)px\s+(\d+)px/.exec(CSS_SB);
  assert(padComp, 'o padding do cabeçalho recolhido perdeu a especificidade que o fazia valer');
  const mono = num(/\.marca-monograma\s*\{[^}]*width:\s*(\d+)px/, CSS_SB, 'a largura do monograma');
  const barraComp = num(/\[data-sidebar="compacta"\] \{ --sidebar-w:\s*(\d+)px/, CSS_SB, '--sidebar-w do compacto');
  const utilComp = barraComp - Number(padComp[2]) * 2;
  assert(mono <= utilComp, `o monograma (${mono}px) não cabe nos ${utilComp}px da barra recolhida`);
});

// ============================================================================
// D. Tema — um desenho, dois fundos
// ============================================================================

t('D1. o texto da marca segue o tema por currentColor', () => {
  for (const [nome, s] of [['arquivo', SVG_H], ['sidebar', JS_SB], ['login', LOGIN_LIMPO]]) {
    assert(/<tspan fill="currentColor">Licite<\/tspan>/.test(s),
      `${nome}: "Licite" deixou de ser currentColor — ficaria invisível em um dos temas`);
  }
  assert(/\.sidebar-logo \{ color: var\(--text-0\); \}/.test(CSS_SB),
    'a sidebar-logo não define a cor que a marca herda');
});

t('D2. o vao da seta e recorte de verdade, nao um traco da cor do fundo', () => {
  // Pintar o vão com a cor do fundo funcionaria em UM tema só. A máscara
  // recorta: o vão fica transparente e mostra o que estiver atrás.
  for (const [nome, s] of [['horizontal', SVG_H], ['monograma', SVG_M]]) {
    assert(/<mask id="/.test(s), `${nome}: perdeu a máscara do vão`);
    assert(/mask="url\(#/.test(s), `${nome}: a máscara não está aplicada`);
    assert(!/stroke="#0b1120"|stroke="#fff" stroke-width="9"/.test(s),
      `${nome}: o vão virou traço de cor fixa — quebraria em um dos temas`);
  }
});

t('D3. as cores da marca sao FIXAS, e sao as aprovadas', () => {
  for (const [nome, s] of [['horizontal', SVG_H], ['monograma', SVG_M], ['sidebar', JS_SB], ['login', LOGIN_LIMPO]]) {
    assert(s.includes(AZUL), `${nome}: o azul principal ${AZUL} sumiu`);
    assert(s.includes(VERDE), `${nome}: o verde ${VERDE} sumiu`);
  }
  // Marca não é token: não pode variar com o tema do usuário.
  assert(!/var\(--accent\)|var\(--success\)/.test(SVG_H + SVG_M),
    'a marca passou a usar token de tema — mudaria de cor conforme a preferência do usuário');
});

t('D4. o azul principal e o mesmo do design system', () => {
  const css = fs.readFileSync(path.join(PUB, 'css/app-modern.css'), 'utf8');
  assert(new RegExp('--btn-primary-bg:\\s*' + AZUL, 'i').test(css),
    `${AZUL} deixou de ser o --btn-primary-bg; a marca e o sistema divergiriam`);
});

// ============================================================================
// E. A seta verde — o elemento que o pedido manda preservar
// ============================================================================

t('E1. a seta existe em todas as versoes, com haste e cabeca', () => {
  const versoes = [['horizontal', SVG_H], ['monograma', SVG_M], ['monocromatica', SVG_MC],
                   ['favicon', SVG_FAV], ['sidebar', JS_SB], ['login', LOGIN_LIMPO]];
  for (const [nome, s] of versoes) {
    assert(/M43 46 L55\.5 31\.5/.test(s), `${nome}: a haste da seta sumiu`);
    assert(/M64 20\.5 L48\.5 27 L60\.5 38\.5 Z/.test(s), `${nome}: a cabeça da seta sumiu`);
  }
});

t('E2. a seta e visivel: tem area propria, nao um fio', () => {
  const larg = /M43 46 L55\.5 31\.5" stroke="[^"]+" stroke-width="([\d.]+)"/.exec(SVG_M);
  assert(larg, 'não achei a espessura da haste no monograma');
  assert(Number(larg[1]) >= 4.5, `haste com ${larg[1]} de espessura — fina demais para "bem visível"`);
});

t('E3. o monograma preserva o "LA": um traco so, em ziguezague', () => {
  // Quatro segmentos: desce (L), base, sobe (perna esquerda do A), desce
  // (perna direita). Menos que isso deixa de ser o LA ligado da identidade.
  const d = /d="(M23 0[^"]+)"/.exec(SVG_M);
  assert(d, 'o traço principal do monograma sumiu');
  assert((d[1].match(/[LQ]/g) || []).length >= 4, 'o traço perdeu segmentos — não é mais o LA ligado');
  assert(/stroke-linejoin="round"/.test(SVG_M), 'as dobras deixaram de ser arredondadas');
});

// ============================================================================
// F. Favicon — legibilidade em tamanho pequeno
// ============================================================================

t('F1. o favicon e quadrado e simplificado para 16px', () => {
  assert(/viewBox="0 0 64 64"/.test(SVG_FAV), 'favicon deixou de ser quadrado');
  assert(new RegExp('<rect width="64" height="64" rx="\\d+" fill="' + AZUL + '"', 'i').test(SVG_FAV),
    'o favicon perdeu o fundo azul sólido — símbolo colorido some em aba escura');
  assert(!/<linearGradient/.test(SVG_FAV),
    'voltou o gradiente ao favicon: em 16px ele não é percebido e só suja o antialiasing');
});

t('F2. o ICO tem as tres resolucoes', () => {
  const buf = fs.readFileSync(path.join(PUB, 'auth/favicon.ico'));
  assert(buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1, 'não é um ICO válido');
  const n = buf.readUInt16LE(4);
  assert(n === 3, `o ICO tem ${n} resoluções (esperado 3: 16, 32 e 48)`);
  const tamanhos = [];
  for (let i = 0; i < n; i++) {
    const b = 6 + i * 16;
    tamanhos.push(buf[b] === 0 ? 256 : buf[b]);
  }
  for (const px of [16, 32, 48]) assert(tamanhos.includes(px), `o ICO não tem a resolução ${px}px`);
});

t('F3. o app icon e 180x180 e OPACO', () => {
  const buf = fs.readFileSync(path.join(PUB, 'auth/apple-touch-icon.png'));
  assert(buf.slice(1, 4).toString() === 'PNG', 'apple-touch-icon não é PNG');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  assert(w === 180 && h === 180, `app icon é ${w}x${h} (iOS espera 180x180)`);
  // iOS ignora transparência e preenche com preto: o fundo tem de ser chapado.
  assert(buf.readUInt8(25) !== 6, 'app icon tem canal alfa — o iOS preencheria o vazio com preto');
});

// ============================================================================
// G. Login
// ============================================================================

t('G1. o login usa a marca, nao um <h1> de texto', () => {
  assert(/class="login-marca"/.test(LOGIN_LIMPO), 'o login não tem a marca');
  assert(!/<h1>Licite Agora<\/h1>/.test(LOGIN_LIMPO), 'o título em texto continua lá, duplicando a marca');
});

t('G2. as cores hardcoded sairam, e os tokens espelhados batem com o original', () => {
  const antigas = ['#1a1a2e', '#16213e', '#4dabf7', '#0f1a30', '#2a3a5c', '#888', '#aaa'];
  const presentes = antigas.filter((c) => LOGIN_LIMPO.toLowerCase().includes(c.toLowerCase()));
  assert(presentes.length === 0, 'cores hardcoded ainda no login: ' + presentes.join(', '));

  // Espelhados, não importados: o login é público e /css/app-modern.css exige
  // sessão. Então os valores TÊM de bater com o original, ou as duas telas
  // divergem sem ninguém notar.
  const css = fs.readFileSync(path.join(PUB, 'css/app-modern.css'), 'utf8');
  const raiz = /^:root \{([\s\S]*?)^\}/m.exec(css)[1];
  for (const token of ['--bg-0', '--bg-1', '--bg-2', '--border', '--border-strong', '--text-0', '--text-1', '--text-2', '--accent', '--danger']) {
    const noErp = new RegExp(token + ':\\s*([^;]+);').exec(raiz);
    const noLogin = new RegExp(token + ':\\s*([^;]+);').exec(LOGIN_LIMPO);
    assert(noLogin, `o login não declara ${token}`);
    assert(noErp[1].trim().toLowerCase() === noLogin[1].trim().toLowerCase(),
      `${token} divergiu: ERP tem ${noErp[1].trim()}, login tem ${noLogin[1].trim()}`);
  }
});

t('G3. o login declara o favicon novo', () => {
  assert(/rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/.test(LOGIN_LIMPO), 'o login não aponta o favicon');
  assert(/rel="apple-touch-icon"/.test(LOGIN_LIMPO), 'o login não aponta o apple-touch-icon');
});

t('G4. o login nao perdeu nenhuma funcionalidade', () => {
  for (const t of ['/api/login', 'autocomplete="username"', 'autocomplete="current-password"',
                   'window.top !== window.self', "id=\"btnLogin\"", 'Usuário ou senha incorretos']) {
    assert(LOGIN_LIMPO.includes(t), 'o login perdeu: ' + t);
  }
});

// ============================================================================
// H. A cópia embutida não pode divergir do arquivo
// ============================================================================

t('H1. o desenho embutido e o mesmo dos arquivos em public/img', () => {
  // Os paths são a identidade em si. Se um mudar sem o outro, a sidebar e o
  // arquivo de referência passam a mostrar marcas diferentes.
  const traco = 'M23 0 L10.5 36 Q9.5 43 17 43 L29 43 L53 7 L76 54';
  for (const [nome, s] of [['arquivo horizontal', SVG_H], ['arquivo monograma', SVG_M],
                           ['sidebar', JS_SB], ['login', LOGIN_LIMPO]]) {
    assert(s.includes(traco), `${nome}: o traço principal divergiu do original`);
  }
});

t('H2. a marca embutida nao virou <img> (perderia tema e fonte)', () => {
  const bloco = JS_SB.slice(JS_SB.indexOf('const MARCA_HORIZONTAL'), JS_SB.indexOf('function gerarMenuHTML'));
  assert(!/<img/.test(bloco), 'a marca voltou a ser <img> — currentColor e a fonte Inter parariam de valer');
  assert(/font-family="Inter/.test(bloco), 'a marca perdeu a tipografia do manual');
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
