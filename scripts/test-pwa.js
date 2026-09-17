/**
 * Fase 3.7 — PWA instalável.
 *
 * ── O que este arquivo vigia ────────────────────────────────────────────────
 *
 * Um service worker roda FORA da sessão e vê todas as requisições do ERP. O
 * modo de falha aqui não é uma tela quebrada: é resposta autenticada gravada no
 * disco do aparelho, ou servida a outro usuário depois. Nada disso aparece em
 * teste de sintaxe, e nada disso dá erro no console.
 *
 * Por isso o bloco C não lê o arquivo procurando a palavra "api": ele EXECUTA o
 * `fetch` do service worker contra URLs reais e verifica se ele chamou
 * `respondWith` — que é o único momento em que o SW assume a resposta.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const AUTH = path.join(PUB, 'auth');

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

const semComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(AUTH, 'manifest.webmanifest'), 'utf8'));
const SW = fs.readFileSync(path.join(AUTH, 'sw.js'), 'utf8');
const PWAJS = fs.readFileSync(path.join(AUTH, 'pwa.js'), 'utf8');
const LOGIN = fs.readFileSync(path.join(AUTH, 'login.html'), 'utf8');
const APP = fs.readFileSync(path.join(PUB, 'app.html'), 'utf8');

// ============================================================================
// A. Manifest
// ============================================================================

t('A1. manifest tem os campos que tornam o app instalavel', () => {
  for (const campo of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons']) {
    assert(MANIFEST[campo], `manifest sem ${campo}`);
  }
  assert(MANIFEST.display === 'standalone', `display é "${MANIFEST.display}" (esperado standalone)`);
  assert(MANIFEST.name === 'Licite Agora ERP', 'o nome do app mudou');
  assert(MANIFEST.short_name === 'Licite Agora', 'o short_name mudou');
  // A marca é uma só: o app não se chama "Venda rápida".
  assert(!/venda r[áa]pida/i.test(MANIFEST.name + MANIFEST.short_name),
    'a Venda rápida virou nome de app — ela é função interna do Licite Agora');
});

t('A2. start_url passa pelo login (nao pula autenticacao)', () => {
  // `/` responde 302 para /login.html sem sessão. Apontar para uma tela interna
  // faria o app instalado abrir numa URL que só funciona autenticado.
  assert(MANIFEST.start_url === '/', `start_url é "${MANIFEST.start_url}" (esperado "/")`);
  assert(MANIFEST.scope === '/', 'o escopo precisa cobrir o ERP inteiro');
});

t('A3. icones 192 e 512 existem, nos dois propositos', () => {
  const porTamanho = (px, purpose) => MANIFEST.icons.find(
    (i) => i.sizes === `${px}x${px}` && (i.purpose || 'any').includes(purpose));
  for (const px of [192, 512]) {
    assert(porTamanho(px, 'any'), `falta ícone ${px} purpose=any`);
    assert(porTamanho(px, 'maskable'), `falta ícone ${px} purpose=maskable`);
  }
});

t('A4. todo icone do manifest existe no disco, com o tamanho declarado', () => {
  for (const ic of MANIFEST.icons) {
    const arq = path.join(AUTH, ic.src.replace(/^\//, ''));
    assert(fs.existsSync(arq), `${ic.src} declarado e inexistente`);
    if (ic.type !== 'image/png') continue;
    const buf = fs.readFileSync(arq);
    assert(buf.slice(1, 4).toString() === 'PNG', `${ic.src} não é PNG`);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    const [dw, dh] = ic.sizes.split('x').map(Number);
    assert(w === dw && h === dh, `${ic.src}: arquivo é ${w}x${h}, manifest diz ${ic.sizes}`);
  }
});

t('A5. cores: theme_color e a da marca, background e a do app', () => {
  assert(MANIFEST.theme_color === '#2563EB', 'theme_color deixou de ser o azul da marca');
  // O fundo da splash NÃO pode ser o mesmo azul do ícone — o ícone sumiria nele.
  assert(MANIFEST.background_color !== MANIFEST.theme_color,
    'background_color igual ao theme_color: o ícone desapareceria na splash');
  const css = fs.readFileSync(path.join(PUB, 'css/app-modern.css'), 'utf8');
  const bg0 = /:root \{[\s\S]*?--bg-0:\s*(#[0-9a-fA-F]{3,6})/.exec(css);
  assert(bg0 && MANIFEST.background_color.toLowerCase() === bg0[1].toLowerCase(),
    `background_color (${MANIFEST.background_color}) não é o --bg-0 do app (${bg0 && bg0[1]})`);
});

t('A6. orientacao NAO travada', () => {
  assert(!MANIFEST.orientation,
    `orientation foi travada em "${MANIFEST.orientation}" — o balcão usa retrato e paisagem`);
});

// ============================================================================
// B. Shortcut da Venda rápida
// ============================================================================

t('B1. o shortcut aponta para a tela real, sem rota paralela', () => {
  const s = (MANIFEST.shortcuts || [])[0];
  assert(s, 'o shortcut da Venda rápida sumiu');
  assert(s.url === '/comercial/pedidos-pdv.html',
    `o shortcut aponta para "${s.url}" — tem de ser a própria tela`);
  assert(!/venda-rapida|\/api\//.test(s.url), 'o shortcut virou rota nova');
});

t('B2. o shortcut NAO contorna login nem RBAC', () => {
  // Ele é um link. Quem protege é o servidor, e continua protegendo:
  //  - sem sessão  → requireAuth manda para /login.html
  //  - sem a permissão → podeVerPath barra (a página é registrada no menu)
  const menu = fs.readFileSync(path.join(PUB, 'js/menu-config.js'), 'utf8');
  const item = /\{ page: 'pedidos-pdv'[^}]*\}/.exec(menu);
  assert(item, 'pedidos-pdv saiu do menu-config — o shortcut abriria por herança de diretório');
  assert(/link: '\/comercial\/pedidos-pdv\.html'/.test(item[0]),
    'o link do menu e o do shortcut divergiram');

  // E o caminho não está na lista de diretórios abertos do RBAC.
  const acesso = fs.readFileSync(path.join(RAIZ, 'perfis-acesso.js'), 'utf8');
  const abertos = /const DIRS_ABERTOS = new Set\(\[([^\]]*)\]/.exec(acesso);
  assert(abertos && !/comercial/.test(abertos[1]),
    '/comercial/ entrou em DIRS_ABERTOS — o shortcut abriria sem permissão');
});

// ============================================================================
// C. Service worker — a parte que pode vazar dado
// ============================================================================

/** Executa o sw.js num escopo simulado e devolve os listeners registrados. */
function carregarSW() {
  const listeners = {};
  const cacheFake = {
    _put: [],
    open: () => Promise.resolve({
      add: () => Promise.resolve(),
      put: (req, resp) => { cacheFake._put.push(req.url || req); return Promise.resolve(); },
    }),
    match: () => Promise.resolve(null),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  };
  const escopo = {
    location: { origin: 'https://1bit.liciteagora.app' },
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    caches: cacheFake,
    fetch: () => Promise.resolve({ status: 200, type: 'basic', headers: { get: () => null }, clone: () => ({}) }),
    URL, Promise, console: { warn() {}, log() {} },
  };
  escopo.self = escopo;
  escopo.globalThis = escopo;
  vm.createContext(escopo);
  new vm.Script(SW, { filename: 'sw.js' }).runInContext(escopo);
  return { listeners, cacheFake };
}

/** Pergunta ao SW: você assume esta requisição? */
function interceptou(url, method = 'GET') {
  const { listeners } = carregarSW();
  let assumiu = false;
  listeners.fetch({
    request: { url, method },
    respondWith: () => { assumiu = true; },
  });
  return assumiu;
}

t('C1. o SW NUNCA intercepta /api/ — nenhuma rota, nenhum metodo', () => {
  const sensiveis = [
    '/api/pedidos', '/api/pedidos/12', '/api/pessoas', '/api/pessoas/autocomplete',
    '/api/produtos', '/api/usuarios/me', '/api/login', '/api/logout',
    '/api/contas-a-receber', '/api/faturas/3', '/api/perfis/meu-acesso',
    '/api/user/prefs', '/api/nfce/emitir', '/api/tef/transacoes',
  ];
  for (const p of sensiveis) {
    const u = 'https://1bit.liciteagora.app' + p;
    assert(!interceptou(u), `o SW assumiu ${p} — resposta autenticada entraria no cache`);
    assert(!interceptou(u, 'POST'), `o SW assumiu POST ${p}`);
  }
});

t('C2. o SW NAO intercepta telas nem assets autenticados', () => {
  // Tudo isto exige sessão. Se entrasse no cache, a tela de um usuário poderia
  // ser servida a outro no mesmo aparelho.
  const autenticados = [
    '/', '/app.html', '/index.html',
    '/comercial/pedidos.html', '/comercial/pedidos-pdv.html', '/comercial/pedido.html',
    '/js/sidebar.js', '/js/menu-config.js', '/css/app-modern.css', '/css/sidebar.css',
    '/img/marca-horizontal.svg', '/fiscal/notas-fiscais.html',
  ];
  for (const p of autenticados) {
    assert(!interceptou('https://1bit.liciteagora.app' + p),
      `o SW assumiu ${p} — conteúdo autenticado não pode ser cacheado`);
  }
});

t('C3. o SW intercepta EXATAMENTE os estaticos publicos da lista', () => {
  const publicos = ['/favicon.svg', '/apple-touch-icon.png', '/icone-192.png',
    '/icone-512.png', '/icone-maskable-192.png', '/icone-maskable-512.png', '/manifest.webmanifest'];
  for (const p of publicos) {
    assert(interceptou('https://1bit.liciteagora.app' + p), `o SW deixou passar ${p}`);
  }
});

t('C4. a decisao e por ALLOWLIST, nao por exclusao', () => {
  // Caminho que não existe hoje: um desenho por exclusão ("não cacheie /api/")
  // o cachearia. Este teste é o que impede a política de inverter no futuro.
  for (const p of ['/relatorios/export.csv', '/backup/tudo.zip', '/novo-modulo/tela.html',
                   '/download/cliente-123.pdf']) {
    assert(!interceptou('https://1bit.liciteagora.app' + p),
      `o SW assumiu ${p}, que não está na lista — a política virou exclusão`);
  }
});

t('C5. outra origem passa direto', () => {
  assert(!interceptou('https://fonts.googleapis.com/css2?family=Inter'),
    'o SW assumiu requisição de outra origem');
  // E nem um caminho da allowlist em outro domínio.
  assert(!interceptou('https://malicioso.example.com/favicon.svg'),
    'o SW casou o caminho ignorando a origem');
});

t('C6. so grava resposta 200, basic e sem Set-Cookie', () => {
  const limpo = semComentarios(SW);
  assert(/resp\.status !== 200/.test(limpo), 'o SW grava resposta que não é 200');
  assert(/resp\.type !== 'basic'/.test(limpo), 'o SW grava resposta opaque/CORS');
  assert(/Set-Cookie/.test(limpo), 'o SW não verifica Set-Cookie antes de gravar');
});

t('C7. o SW nao tenta offline de dados nesta fase', () => {
  const limpo = semComentarios(SW);
  for (const proibido of ['indexedDB', 'IDBDatabase', 'BackgroundSync', 'sync', 'postMessage', 'push']) {
    assert(!new RegExp('\\b' + proibido + '\\b').test(limpo),
      `o SW usa ${proibido} — fila offline e push ficaram para outra fase`);
  }
});

// ============================================================================
// D. Registro
// ============================================================================

t('D1. as duas portas de entrada registram o SW e declaram o manifest', () => {
  for (const [nome, html] of [['login', LOGIN], ['shell', APP]]) {
    assert(/<link rel="manifest" href="\/manifest\.webmanifest">/.test(html),
      `${nome} não declara o manifest`);
    assert(/<script src="\/pwa\.js"/.test(html), `${nome} não registra o service worker`);
  }
});

t('D2. o registro nao derruba a pagina se falhar', () => {
  assert(/\.catch\(/.test(PWAJS), 'o register() não trata falha');
  assert(/'serviceWorker' in navigator/.test(PWAJS), 'não verifica suporte do navegador');
  assert(/isSecureContext|https:/.test(PWAJS), 'não verifica contexto seguro');
});

t('D3. nenhum banner de instalacao proprio nesta fase', () => {
  assert(!/beforeinstallprompt/.test(semComentarios(PWAJS)),
    'apareceu prompt de instalação custom — o navegador já oferece');
});

// ============================================================================
// E. Mobile / standalone
// ============================================================================

t('E1. o shell permite safe-area (viewport-fit=cover)', () => {
  assert(/viewport-fit=cover/.test(APP),
    'o shell não permite env(safe-area-inset-*) — sobraria faixa no iPhone com notch');
});

t('E2. a Venda rapida ja trata safe-area e toque', () => {
  const pdv = fs.readFileSync(path.join(PUB, 'comercial/pedidos-pdv.html'), 'utf8');
  assert(/viewport-fit=cover/.test(pdv), 'a Venda rápida perdeu viewport-fit');
  assert(/env\(safe-area-inset-bottom\)/.test(pdv), 'a barra do carrinho ignora a safe area');
  assert(/@media \(pointer: coarse\)/.test(pdv), 'a Venda rápida perdeu o ajuste de toque');
});

t('E3. theme-color dinamico continua vencendo o do manifest', () => {
  // O manifest pinta a splash; a meta tag pinta a barra depois que a página
  // carrega, e segue o tema do usuário. As duas coisas convivem de propósito.
  const tb = fs.readFileSync(path.join(PUB, 'js/theme-boot.js'), 'utf8');
  assert(/meta\[name="theme-color"\]/.test(tb), 'theme-boot parou de ajustar a barra do navegador');
});

// ============================================================================
// F. Nada paralelo foi criado
// ============================================================================

t('F1. nenhuma rota, tabela ou autenticacao nova', () => {
  const reg = fs.readFileSync(path.join(RAIZ, 'route-registry.js'), 'utf8');
  for (const termo of ['pwa', 'manifest', 'service-worker']) {
    assert(!new RegExp(termo, 'i').test(reg), `${termo} virou rota no servidor`);
  }
  assert(!/fetch\(/.test(semComentarios(PWAJS)), 'o registro do PWA faz chamada de API');
  assert(!/token|senha|password|Authorization/i.test(semComentarios(SW)),
    'o service worker menciona credencial');
});

t('F2. os arquivos PWA sao publicos (servidos antes do auth)', () => {
  // Se estivessem em public/js ou public/css, o navegador receberia 302 ao
  // buscá-los sem sessão e a instalação nunca seria oferecida.
  for (const f of ['manifest.webmanifest', 'sw.js', 'pwa.js',
                   'icone-192.png', 'icone-512.png', 'icone-maskable-192.png', 'icone-maskable-512.png']) {
    assert(fs.existsSync(path.join(AUTH, f)), `${f} não está em public/auth/ (público)`);
  }
  const mid = fs.readFileSync(path.join(RAIZ, 'base-middleware.js'), 'utf8');
  assert(/express\.static\(path\.join\(__dirname, 'public', 'auth'\)\)/.test(mid),
    'public/auth/ deixou de ser servido na raiz — os arquivos PWA ficariam inacessíveis');
});

t('F3. o escopo do SW cobre o ERP, e o arquivo esta na raiz', () => {
  assert(/register\('\/sw\.js', \{ scope: '\/' \}\)/.test(PWAJS),
    'o escopo do service worker não é a raiz');
  // Um SW em /js/sw.js teria escopo /js/ e não controlaria o resto do site.
  assert(fs.existsSync(path.join(AUTH, 'sw.js')), 'sw.js precisa ser servido em /sw.js');
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
