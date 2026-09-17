/**
 * Fase 49 — integração Catálogo Online → experiência pública (/loja/).
 *
 * A causa raiz do relato ("Nenhum produto encontrado" com 64 publicados) NÃO era
 * código: era estado. O lojista configurou identidade às 13h55 e só publicou os
 * produtos às 14h47 — no meio, o endpoint devolvia lista vazia e o nome caía no
 * fallback literal 'Catálogo'. Os dois sintomas relatados batem com essa janela.
 *
 * O que ERA defeito de integração, e o que estes testes guardam:
 *   - a página não usava o banner, que o endpoint já devolvia;
 *   - havia botão "Entrar" e uma chamada a /loja/api/eu que respondia 401;
 *   - catálogo vazio e busca sem resultado diziam a MESMA frase — foi isso que
 *     fez o diagnóstico apontar para o lugar errado.
 *
 * Bloco A: servidor (dois tenants de verdade, rotas reais).
 * Bloco B: a página no Chrome, sem login e sem chave nenhuma.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const puppeteer = require('puppeteer-core');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const CHROME = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
  .find((p) => fs.existsSync(p));

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };
const FILTRO = process.argv[2] || null;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pub49-'));
const abertos = [];

// ============================================================================
// Tenants de verdade
// ============================================================================

function montarTenant(nome, { ativa = 1, produtos = [], ordemCategorias = [], config = {} } = {}) {
  const db = new Database(path.join(tmp, nome + '.db'));
  db.pragma('foreign_keys = OFF');
  require('../db-schema').initSchema(db);
  db.pragma('foreign_keys = ON');
  require('../loja-routes').migrarLojaDB(db);
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, produtoId INTEGER NOT NULL, caminho TEXT NOT NULL,
    urlOrigem TEXT, origem TEXT NOT NULL DEFAULT 'outra', autorizadoPor TEXT, autorizadoEm TEXT,
    largura INTEGER, altura INTEGER, bytes INTEGER, ordem INTEGER DEFAULT 0,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);
  abertos.push(db);

  db.prepare(`UPDATE loja_config SET ativa=?, nome=?, descricao=?, logoPath=?, bannerPath=?,
              mostrarPreco=1, mostrarEstoque=1, whatsapp=? WHERE id=1`)
    .run(ativa, config.nome ?? null, config.descricao ?? null,
         config.logo ?? null, config.banner ?? null, config.whatsapp ?? null);

  const ins = db.prepare(`INSERT INTO produtos (sku, descricao, categoria, unidade, precoVenda,
      precoCusto, markupVenda, ativo, publicadoNaLoja, destaqueNaLoja, ordemVitrine)
    VALUES (?,?,?,'UN',?,?,?,1,?,?,?)`);
  for (const p of produtos) {
    ins.run(p.sku, p.descricao, p.categoria ?? null, p.preco ?? 10,
            p.custo ?? 3.33, p.markup ?? 1.5, p.publicado ? 1 : 0,
            p.destaque ? 1 : 0, p.ordem ?? 0);
  }
  for (const [i, c] of ordemCategorias.entries()) {
    db.prepare('INSERT OR REPLACE INTO loja_categoria_ordem (categoria, ordem) VALUES (?,?)').run(c, i + 1);
  }
  return db;
}

/** Servidor com as rotas PÚBLICAS reais + os estáticos de /loja. */
function subir(tenants) {
  const app = express();
  app.use(express.json());
  let atual = tenants[0];
  app.use((req, res, next) => {
    const slug = req.headers['x-tenant-teste'];
    if (slug) atual = tenants.find((x) => x.slug === slug) || atual;
    req.tenantAtual = atual;
    next();
  });
  // Proxy mínimo de db: resolve o tenant da requisição em curso. É o que garante
  // que o teste de isolamento meça algo — com um db fixo, não haveria o que vazar.
  const proxy = new Proxy({}, {
    get: (_, prop) => {
      const alvo = atual.db;
      const v = alvo[prop];
      return typeof v === 'function' ? v.bind(alvo) : v;
    },
  });
  require('../loja-routes').registrarRotasLojaPublica(app, proxy);
  app.use('/loja', express.static(path.join(PUB, 'loja')));
  return new Promise((r) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => r(srv));
  });
}

function pegar(porta, rota, slug) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: rota, method: 'GET',
      headers: slug ? { 'x-tenant-teste': slug } : {} }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, body: j, cru: b }); });
    });
    req.on('error', reject);
    req.end();
  });
}

const PRODUTOS_A = [
  { sku: 'A1', descricao: 'ARROZ BRANCO', categoria: 'ALIMENTOS', preco: 10, ordem: 2, publicado: 1 },
  { sku: 'A2', descricao: 'CAFE FORTE', categoria: 'ALIMENTOS', preco: 20, ordem: 1, publicado: 1, destaque: 1 },
  { sku: 'A3', descricao: 'BOLO DE FUBA', categoria: 'DOCES', preco: 30, publicado: 1 },
  { sku: 'A4', descricao: 'SEGREDO INDUSTRIAL', categoria: 'DOCES', preco: 99, publicado: 0 },
];

const CFG_A = { nome: 'LOJA DO TESTE A', descricao: 'Bom gosto', logo: '/uploads/loja/logo-a.png',
                banner: '/uploads/loja/banner-a.png', whatsapp: '44999990000' };

// ============================================================================
// A. Servidor
// ============================================================================

t('A1. catálogo NAO publicado devolve 404 nos dois endpoints', async () => {
  const A = { slug: 'a', db: montarTenant('naoPub', { ativa: 0, produtos: PRODUTOS_A, config: CFG_A }) };
  const srv = await subir([A]);
  try {
    const cfg = await pegar(srv.address().port, '/loja/api/config');
    const prod = await pegar(srv.address().port, '/loja/api/produtos');
    assert(cfg.status === 404, `config devolveu ${cfg.status} com a loja despublicada`);
    assert(prod.status === 404, `produtos devolveu ${prod.status} com a loja despublicada`);
    assert(!/LOJA DO TESTE A/.test(cfg.cru), 'vazou o nome da loja despublicada');
  } finally { srv.close(); }
});

t('A2. publicado com ZERO produtos publicados -> lista vazia, sem erro', async () => {
  const A = { slug: 'a', db: montarTenant('vazio', {
    ativa: 1, config: CFG_A,
    produtos: [{ sku: 'X', descricao: 'OCULTO', categoria: 'ALIMENTOS', publicado: 0 }] }) };
  const srv = await subir([A]);
  try {
    const r = await pegar(srv.address().port, '/loja/api/produtos');
    assert(r.status === 200 && r.body.success, 'devia responder 200: ' + r.status);
    assert(r.body.produtos.length === 0, 'devolveu produto que não está publicado');
    assert(r.body.categorias.length === 0, 'devolveu categoria sem produto publicado');
  } finally { srv.close(); }
});

t('A3/A4. publicado com produtos -> só os PUBLICADOS aparecem', async () => {
  const A = { slug: 'a', db: montarTenant('cheio', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A }) };
  const srv = await subir([A]);
  try {
    const r = await pegar(srv.address().port, '/loja/api/produtos');
    const skus = r.body.produtos.map((p) => p.sku);
    assert(r.body.total === 3, `esperava 3 publicados, veio ${r.body.total}`);
    assert(!skus.includes('A4'), 'o produto NAO publicado apareceu no catálogo público');
    assert(!/SEGREDO INDUSTRIAL/.test(r.cru), 'o nome do produto não publicado vazou no payload');
  } finally { srv.close(); }
});

t('A5/A6. ordem das categorias e dos produtos vem do Catálogo Online', async () => {
  const A = { slug: 'a', db: montarTenant('ordem', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A,
    ordemCategorias: ['DOCES', 'ALIMENTOS'] }) };   // invertendo a alfabética
  const srv = await subir([A]);
  try {
    const r = await pegar(srv.address().port, '/loja/api/produtos');
    assert(r.body.categorias[0] === 'DOCES',
      'a ordem das categorias do admin foi ignorada: ' + JSON.stringify(r.body.categorias));
    const ali = r.body.produtos.filter((p) => p.categoria === 'ALIMENTOS').map((p) => p.sku);
    assert(ali[0] === 'A2', 'a ordem dos produtos (ordemVitrine) foi ignorada: ' + ali.join(','));
  } finally { srv.close(); }
});

t('A7/A8. busca acha o publicado e NUNCA revela o não publicado', async () => {
  const A = { slug: 'a', db: montarTenant('busca', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A }) };
  const srv = await subir([A]);
  try {
    const achou = await pegar(srv.address().port, '/loja/api/produtos?q=CAFE');
    assert(achou.body.produtos.some((p) => p.sku === 'A2'), 'a busca não achou o produto publicado');
    const oculto = await pegar(srv.address().port, '/loja/api/produtos?q=SEGREDO');
    assert(oculto.body.produtos.length === 0,
      'a busca revelou produto NAO publicado: ' + JSON.stringify(oculto.body.produtos));
  } finally { srv.close(); }
});

t('A9/A10/A11. nome, logo e banner vêm da configuração do Catálogo Online', async () => {
  const A = { slug: 'a', db: montarTenant('ident', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A }) };
  const srv = await subir([A]);
  try {
    const r = await pegar(srv.address().port, '/loja/api/config');
    assert(r.body.loja.nome === 'LOJA DO TESTE A', 'nome errado: ' + r.body.loja.nome);
    assert(r.body.loja.logo === '/uploads/loja/logo-a.png', 'logo errado: ' + r.body.loja.logo);
    assert(r.body.loja.banner === '/uploads/loja/banner-a.png', 'banner ausente: ' + r.body.loja.banner);
  } finally { srv.close(); }
});

t('A12/A13. preço vem do servidor e o payload NAO traz custo nem markup', async () => {
  const A = { slug: 'a', db: montarTenant('preco', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A }) };
  const srv = await subir([A]);
  try {
    const r = await pegar(srv.address().port, '/loja/api/produtos');
    const cafe = r.body.produtos.find((p) => p.sku === 'A2');
    assert(cafe.preco === 20, 'preço não veio resolvido do servidor: ' + cafe.preco);
    // O custo existe no banco (3.33) e NÃO pode aparecer no payload público.
    for (const proibido of ['precoCusto', 'custo', 'markup', 'markupVenda', 'precoMinimoVenda']) {
      assert(!(proibido in cafe), `o payload público expõe "${proibido}"`);
    }
    assert(!/3\.33|3,33/.test(r.cru), 'o valor de custo vazou no corpo da resposta');
    assert(!/markup/i.test(r.cru), 'a palavra markup aparece no payload público');
  } finally { srv.close(); }
});

t('A14. tenant A nunca recebe produto ou identidade do tenant B', async () => {
  const A = { slug: 'a', db: montarTenant('tA', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A }) };
  const B = { slug: 'b', db: montarTenant('tB', { ativa: 1, config: { nome: 'LOJA DO TESTE B' },
    produtos: [{ sku: 'B1', descricao: 'PRODUTO EXCLUSIVO DO B', categoria: 'OUTROS', preco: 5, publicado: 1 }] }) };
  const srv = await subir([A, B]);
  const porta = srv.address().port;
  try {
    const ra = await pegar(porta, '/loja/api/produtos', 'a');
    const rb = await pegar(porta, '/loja/api/produtos', 'b');
    assert(!/PRODUTO EXCLUSIVO DO B/.test(ra.cru), 'o tenant A recebeu produto do tenant B');
    assert(!/ARROZ BRANCO/.test(rb.cru), 'o tenant B recebeu produto do tenant A');

    const ca = await pegar(porta, '/loja/api/config', 'a');
    const cb = await pegar(porta, '/loja/api/config', 'b');
    assert(ca.body.loja.nome === 'LOJA DO TESTE A' && cb.body.loja.nome === 'LOJA DO TESTE B',
      `identidade cruzada: A=${ca.body.loja.nome} B=${cb.body.loja.nome}`);

    // ID do tenant B pedido no contexto do A não pode devolver nada.
    const idB = B.db.prepare("SELECT id FROM produtos WHERE sku='B1'").get().id;
    const cruzado = await pegar(porta, '/loja/api/produtos/' + idB, 'a');
    assert(!/PRODUTO EXCLUSIVO DO B/.test(cruzado.cru),
      'leitura cruzada por ID devolveu produto do outro tenant');
  } finally { srv.close(); }
});

t('A15. nenhuma rota pública exige login para ver o catálogo', async () => {
  const A = { slug: 'a', db: montarTenant('semlogin', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A }) };
  const srv = await subir([A]);
  try {
    // Sem cookie, sem header, sem nada.
    for (const rota of ['/loja/api/config', '/loja/api/produtos', '/loja/api/produtos?q=CAFE']) {
      const r = await pegar(srv.address().port, rota);
      assert(r.status === 200, `${rota} respondeu ${r.status} para visitante anônimo`);
    }
  } finally { srv.close(); }
});

t('A18. /loja/ continua servindo a página (link antigo não quebrou)', async () => {
  const A = { slug: 'a', db: montarTenant('estatico', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A }) };
  const srv = await subir([A]);
  try {
    const r = await pegar(srv.address().port, '/loja/');
    assert(r.status === 200, '/loja/ respondeu ' + r.status);
    assert(/<title>/.test(r.cru) && /grade/.test(r.cru), '/loja/ não serviu a página da loja');
  } finally { srv.close(); }
});

t('A17b. a página não contém mais o fluxo de login do portal', async () => {
  /* A Fase 50 tirou o JavaScript do inline: o comportamento que este caso guarda
     passou a viver em `catalogo.js`. Ler os DOIS arquivos mantém a intenção
     original — nada aqui afrouxou, só deixou de olhar um lugar só. */
  const fontes = ['loja/index.html', 'loja/catalogo.js', 'loja/tema.js']
    .map((f) => { try { return fs.readFileSync(path.join(PUB, f), 'utf8'); } catch { return ''; } })
    .join('\n');
  const limpo = fontes.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const proibido of ['btnEntrar', 'modalLogin', '/portal/api/login', '/loja/api/eu', 'verificarSessao']) {
    assert(!limpo.includes(proibido), `a página pública ainda tem "${proibido}"`);
  }
  assert(/LOJA\.banner/.test(limpo), 'a página não usa o banner configurado');
  // O estado "catálogo vazio" precisa ser distinto de "busca sem resultado".
  assert(/ainda não tem produtos publicados/.test(limpo), 'falta o estado de catálogo vazio');
  assert(/Nenhum produto encontrado para esta busca/.test(limpo),
    'a busca sem resultado voltou a usar a frase genérica');
});

// ============================================================================
// B. A página no Chrome, sem login
// ============================================================================

async function comNavegador(tenants, fn) {
  const srv = await subir(tenants);
  const porta = srv.address().port;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const erros = [], rede = [];
  page.on('pageerror', (e) => erros.push(e.message));
  page.on('request', (r) => {
    const h = r.headers();
    rede.push({ url: r.url().replace(/^http:\/\/[^/]+/, ''), headers: h });
  });
  const respostas = [];
  page.on('response', (r) => respostas.push({ url: r.url().replace(/^http:\/\/[^/]+/, ''), status: r.status() }));
  try {
    await page.goto(`http://127.0.0.1:${porta}/loja/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1800));
    return await fn(page, { erros, rede, respostas, porta });
  } finally { await browser.close(); srv.close(); }
}

t('B15/B16/B17. a página abre sem login, sem API key e sem "Entrar"', async () => {
  const A = { slug: 'a', db: montarTenant('nav1', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A }) };
  await comNavegador([A], async (page, ctx) => {
    const est = await page.evaluate(async () => {
      // Na Fase 50 o carrinho deixou de ser um botão sempre visível e virou a
      // BARRA FIXA, que só aparece com item dentro. A intenção do caso não muda:
      // dá para montar pedido sem login. O que muda é onde isso se verifica.
      const antes = !document.getElementById('barra').hidden;
      await adicionar({ produtoId: PRODUTOS[0].id, quantidade: 1, opcoes: [], textos: {}, comentario: null });
      await new Promise((r) => setTimeout(r, 400));
      return {
        titulo: document.title,
        nome: document.getElementById('nomeLoja').textContent.trim(),
        temEntrar: !!document.getElementById('btnEntrar'),
        barraAntes: antes,
        temCarrinho: !document.getElementById('barra').hidden
          && !!document.getElementById('barraVer'),
        cards: document.querySelectorAll('.card').length,
        texto: document.body.innerText,
      };
    });
    assert(!est.temEntrar, 'o botão "Entrar" ainda aparece no catálogo público');
    assert(!/\bEntrar\b/.test(est.texto), 'a palavra "Entrar" continua na tela: ' + est.texto.slice(0, 200));
    assert(!est.barraAntes, 'a barra do carrinho aparece antes de haver item');
    assert(est.temCarrinho, 'o carrinho não está acessível sem login');
    assert(est.cards === 4, `esperava 4 cards (3 publicados + o destaque repetido), vieram ${est.cards}`);
    assert(est.nome === 'LOJA DO TESTE A', 'nome público errado: ' + est.nome);

    // Nenhum 401/403, e nenhuma chave viajando.
    const ruins = ctx.respostas.filter((r) => r.status === 401 || r.status === 403);
    assert(ruins.length === 0, 'requests 401/403 no catálogo público: ' + JSON.stringify(ruins));
    const comChave = ctx.rede.filter((r) => Object.keys(r.headers)
      .some((h) => /api[-_]?key|authorization/i.test(h)));
    assert(comChave.length === 0, 'o navegador enviou credencial: ' + JSON.stringify(comChave.map((r) => r.url)));
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('B-ident. capa, logo e nome aparecem de fato na tela', async () => {
  const A = { slug: 'a', db: montarTenant('nav2', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A }) };
  await comNavegador([A], async (page) => {
    const v = await page.evaluate(() => {
      const capa = document.getElementById('capa');
      const img = capa.querySelector('img');
      const r = capa.getBoundingClientRect();
      const logo = document.getElementById('logo');
      return { capaVisivel: !capa.hidden && r.height > 60,
        capaAltura: Math.round(r.height),
        srcCapa: img ? img.getAttribute('src') : null,
        logoVisivel: !logo.hidden, srcLogo: logo.getAttribute('src') };
    });
    assert(v.capaVisivel, `a capa não aparece (altura ${v.capaAltura}px)`);
    assert(v.srcCapa === '/uploads/loja/banner-a.png', 'a capa não é a configurada: ' + v.srcCapa);
    assert(v.logoVisivel && v.srcLogo === '/uploads/loja/logo-a.png', 'o logo configurado não aparece');
  });
});

t('B-vazio. catálogo publicado e vazio mostra mensagem PRÓPRIA', async () => {
  const A = { slug: 'a', db: montarTenant('nav3', { ativa: 1, config: CFG_A,
    produtos: [{ sku: 'X', descricao: 'OCULTO', categoria: 'A', publicado: 0 }] }) };
  await comNavegador([A], async (page) => {
    const txt = await page.evaluate(() => document.getElementById('conteudo').innerText);
    assert(/ainda não tem produtos publicados/.test(txt), 'estado de catálogo vazio errado: ' + txt);
    assert(!/para esta busca/.test(txt), 'mostrou a frase de busca num catálogo vazio');
  });
});

t('B-naopub. catálogo despublicado avisa que não está publicado', async () => {
  const A = { slug: 'a', db: montarTenant('nav4', { ativa: 0, produtos: PRODUTOS_A, config: CFG_A }) };
  await comNavegador([A], async (page) => {
    const txt = await page.evaluate(() => document.body.innerText);
    assert(/não está publicado/i.test(txt), 'não avisou que o catálogo está fora do ar: ' + txt.slice(0, 200));
    assert(!/LOJA DO TESTE A/.test(txt), 'vazou a identidade de um catálogo despublicado');
  });
});

t('B-busca. a busca filtra na tela e não revela o não publicado', async () => {
  const A = { slug: 'a', db: montarTenant('nav5', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A }) };
  await comNavegador([A], async (page) => {
    const busca = async (q) => page.evaluate((termo) => {
      const i = document.getElementById('busca');
      i.value = termo; i.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise((r) => setTimeout(() => r({
        cards: document.querySelectorAll('.card').length,
        // Produto em DESTAQUE aparece duas vezes por desenho — na seção
        // Destaques e na categoria dele. Contar cards mediria a repetição;
        // o que importa aqui é quantos produtos distintos a busca revelou.
        distintos: new Set([...document.querySelectorAll('.card')]
          .map((c) => c.dataset.abrir)).size,
        texto: document.getElementById('conteudo').innerText }), 250));
    }, q);
    const cafe = await busca('CAFE');
    assert(cafe.distintos === 1, `busca por CAFE devolveu ${cafe.distintos} produtos distintos`);
    const segredo = await busca('SEGREDO');
    assert(segredo.distintos === 0, 'a busca revelou o produto não publicado');
    assert(/para esta busca/.test(segredo.texto), 'busca vazia não usou a mensagem de busca');
  });
});

t('B-carrinho. dá para montar carrinho sem login nenhum', async () => {
  const A = { slug: 'a', db: montarTenant('nav6', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A }) };
  await comNavegador([A], async (page, ctx) => {
    /* `addCarrinho`/`abrirCarrinho` do modal viraram `adicionar()` mais a tela
       de sacola (#/sacola) na Fase 50. A garantia é a mesma: sem login nenhum,
       o item entra, o total bate e o estado persiste no navegador. */
    const r = await page.evaluate(async () => {
      const p = PRODUTOS.find((x) => x.sku === 'A2');
      await adicionar({ produtoId: p.id, quantidade: 2, opcoes: [], textos: {}, comentario: null });
      location.hash = '#/sacola';
      await new Promise((x) => setTimeout(x, 900));
      return { qtd: document.getElementById('barraQtd').textContent,
        total: document.getElementById('barraTotal').textContent,
        corpo: document.getElementById('conteudo').innerText,
        guardado: localStorage.getItem('loja-carrinho-v2') };
    });
    assert(/2 produtos/.test(r.qtd), 'o contador do carrinho não mudou: ' + r.qtd);
    assert(/CAFE FORTE/.test(r.corpo), 'o produto não entrou no carrinho: ' + r.corpo);
    assert(/40,00/.test(r.total), 'o total (2 x 20) não bateu: ' + r.total);
    assert(/Retirada/i.test(r.corpo) || /Delivery/i.test(r.corpo),
      'não há como seguir com o pedido sem login: ' + r.corpo.slice(0, 160));
    assert(JSON.parse(r.guardado).length === 1, 'o carrinho não persistiu no navegador');
    // Continua sem exigir sessão.
    const ruins = ctx.respostas.filter((x) => x.status === 401 || x.status === 403);
    assert(ruins.length === 0, 'montar carrinho disparou 401/403: ' + JSON.stringify(ruins));
  });
});

t('B-preco. o preço exibido é o do servidor, não o do navegador', async () => {
  const A = { slug: 'a', db: montarTenant('nav7', { ativa: 1, produtos: PRODUTOS_A, config: CFG_A }) };
  await comNavegador([A], async (page) => {
    const r = await page.evaluate(async () => {
      const p = PRODUTOS.find((x) => x.sku === 'A2');
      // Adultera o localStorage como um visitante mal-intencionado faria.
      localStorage.setItem('loja-carrinho-v2',
        JSON.stringify([{ produtoId: p.id, quantidade: 1, preco: 0.01, total: 0.01 }]));
      // `recarregarCarrinho` virou `recalcular()`, e agora é assíncrona: quem
      // devolve os valores é o servidor, não uma conta feita no navegador.
      await recalcular();
      return { total: SACOLA.total, preco: SACOLA.itens[0].precoUnitario };
    });
    assert(r.preco === 20 && r.total === 20,
      'o preço adulterado no navegador venceu o do servidor: ' + JSON.stringify(r));
  });
});

(async () => {
  if (!CHROME) console.log('  Chrome ausente — bloco B sera pulado');
  for (const [nome, fn] of fila.filter(([n]) => !FILTRO || n.startsWith(FILTRO))) {
    if (!CHROME && /^B/.test(nome)) { console.log('PULA  ' + nome); continue; }
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  for (const db of abertos) { try { db.close(); } catch (_) {} }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
