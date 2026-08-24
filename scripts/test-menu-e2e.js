/**
 * test-menu-e2e.js — o menu que o navegador monta bate com o perfil do usuário?
 *
 * Uso:  node scripts/test-menu-e2e.js <usuario> <senha> [tenant] [porta]
 *
 * Diferença para o test-menu-perfil.js: lá o acesso é injetado à mão no
 * localStorage; aqui o `sidebar.js` real busca `/api/perfis/meu-acesso` no
 * servidor rodando, com a sessão de um login de verdade. Cobre o caminho
 * inteiro — login, fetch, cache, montagem do menu — sem depender do navegador.
 *
 * O que ele NÃO cobre: CSS, clique e a navegação do shell. Para isso é preciso
 * abrir a tela.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const [usuario, senha, tenant = '1bit', porta = 3000] = process.argv.slice(2);
if (!usuario || !senha) {
  console.error('uso: node scripts/test-menu-e2e.js <usuario> <senha> [tenant] [porta]');
  process.exit(2);
}
const HOST = `${tenant}.liciteagora.app`;
const PUB = path.join(__dirname, '..', 'public');

function pedir(metodo, caminho, { cookie, corpo } = {}) {
  return new Promise((resolve, reject) => {
    const dados = corpo ? JSON.stringify(corpo) : null;
    const req = http.request({
      host: 'localhost', port: Number(porta), method: metodo, path: caminho,
      headers: {
        Host: HOST,
        // O nginx põe isto; sem ele o Express não emite o cookie de sessão
        // (NODE_ENV=production ⇒ cookie.secure).
        'X-Forwarded-Proto': 'https',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(dados ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } : {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

// ---------- DOM mínimo, guardando o que for inserido ----------
function criarContexto(cookie) {
  const armazem = new Map();
  const store = {
    getItem: (k) => (armazem.has(k) ? armazem.get(k) : null),
    setItem: (k, v) => armazem.set(k, String(v)),
    removeItem: (k) => armazem.delete(k),
  };
  const elemento = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
    insertAdjacentHTML() {}, remove() {}, addEventListener() {}, textContent: '', innerHTML: '',
  });
  const body = elemento();
  const inseridos = [];
  body.insertAdjacentHTML = (_pos, html) => inseridos.push(html);
  const document = {
    head: elemento(), body, documentElement: { style: { setProperty() {}, removeProperty() {} } },
    createElement: elemento, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, getElementsByTagName: () => [elemento()], addEventListener() {},
  };
  const janela = {
    document, localStorage: store, sessionStorage: { getItem: () => null, setItem() {} },
    location: { pathname: '/', search: '', hash: '', replace() {}, reload() {} },
    addEventListener() {}, setTimeout, setInterval: () => 0, clearInterval() {},
    console, Intl, JSON, Math, Date, Promise, URL,
    // fetch de verdade contra o servidor, com a sessão do login.
    fetch: (url) => pedir('GET', url, { cookie }).then((r) => ({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => Promise.resolve(JSON.parse(r.body)),
    })),
  };
  janela.window = janela; janela.self = janela; janela.top = janela; janela.parent = janela;
  const ctx = vm.createContext(janela);
  vm.runInContext(fs.readFileSync(path.join(PUB, 'js/menu-config.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(PUB, 'js/sidebar.js'), 'utf8'), ctx);
  ctx.__inseridos = inseridos;
  return ctx;
}

(async () => {
  const login = await pedir('POST', '/api/login', { corpo: { username: usuario, password: senha } });
  const setCookie = (login.headers['set-cookie'] || []).join(';');
  const cookie = (setCookie.match(/liciteagora\.sid=[^;]+/) || [])[0];
  if (!cookie) { console.error(`login de ${usuario} falhou: ${login.body.slice(0, 120)}`); process.exit(1); }

  const acesso = JSON.parse((await pedir('GET', '/api/perfis/meu-acesso', { cookie })).body);

  // O menu tem dois filtros: a feature do TENANT e o perfil do USUÁRIO. Só o
  // segundo é o que este teste mede, então as páginas de seção desligada saem
  // do esperado — senão Ótica (optica_enabled=0) apareceria como falha.
  const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));
  const features = JSON.parse((await pedir('GET', '/api/features/status', { cookie })).body).features || {};
  const ligada = (f) => !f || features[f] === true;
  const visiveisNoTenant = new Set();
  const ocultasPorFeature = [];
  for (const s of menuConfig.secoes) {
    for (const i of s.itens) {
      if (ligada(s.feature) && ligada(i.feature)) visiveisNoTenant.add(i.page);
      else ocultasPorFeature.push(`${i.page} (feature ${i.feature || s.feature})`);
    }
  }

  const esperado = acesso.irrestrito
    ? null
    : acesso.paginas.filter((p) => visiveisNoTenant.has(p)).sort();
  const sufocadas = acesso.irrestrito
    ? [] : acesso.paginas.filter((p) => !visiveisNoTenant.has(p));

  const ctx = criarContexto(cookie);
  // Sem cache no localStorage: é o primeiro acesso deste "browser", o caso em
  // que o menu era desenhado completo e só depois encolhia.
  await vm.runInContext('desenharMenuComAcesso(null)', ctx);
  await new Promise((r) => setTimeout(r, 300));   // deixa o refresh em background terminar

  const html = ctx.__inseridos.join('\n');
  const itens = [...html.matchAll(/data-page="([^"]+)"/g)].map((m) => m[1]).sort();
  const secoes = [...html.matchAll(/class="menu-section[^"]*"[^>]*>([\s\S]*?)<span class="menu-chevron"/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, '').trim()).filter(Boolean);

  console.log(`usuário ........ ${usuario} (perfil ${acesso.perfil}${acesso.irrestrito ? ', irrestrito' : ''})`);
  console.log(`vezes que o menu foi montado: ${ctx.__inseridos.length}`);
  console.log(`itens no menu .. ${itens.length}${esperado ? ` (esperado ${esperado.length})` : ''}`);
  console.log(`seções ......... ${secoes.join(' · ')}`);

  if (!esperado) {
    console.log('\nperfil irrestrito: nada a esconder.');
    process.exit(0);
  }
  const sobrando = itens.filter((p) => !esperado.includes(p));
  const faltando = esperado.filter((p) => !itens.includes(p));
  console.log(`\nitens exibidos: ${itens.join(', ') || '(nenhum)'}`);
  if (sufocadas.length) {
    console.log(`no perfil mas escondidas pela feature do tenant: ${sufocadas.join(', ')}`);
  }
  if (sobrando.length) console.log(`VAZANDO (no menu sem acesso): ${sobrando.join(', ')}`);
  if (faltando.length) console.log(`FALTANDO (tem acesso e não aparece): ${faltando.join(', ')}`);
  if (!sobrando.length && !faltando.length) console.log('\nmenu bate exatamente com o perfil.');
  process.exit(sobrando.length || faltando.length ? 1 : 0);
})().catch((e) => { console.error('erro:', e.message); process.exit(1); });
