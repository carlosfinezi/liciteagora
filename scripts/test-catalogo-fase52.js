/**
 * Fase 52 — vitrine organizada, painel Informações e preparação do delivery.
 *
 * O que estes casos guardam, em três frases:
 *
 *   A ABA E O CONTEÚDO NÃO PODEM DIVERGIR. O bug que abriu a fase era esse:
 *   CONFEITOS aceso e A GRANEL na tela. A correção foi trocar rolagem por
 *   filtro, e é isso que os casos de categoria verificam — não o scroll.
 *
 *   ORDENAR NÃO PODE MUDAR MAIS NADA. Arrastar um produto mexe em
 *   `ordemVitrine` e em nada mais: preço, estoque, publicação e destaque ficam
 *   como estavam.
 *
 *   O QUE É PRIVADO NÃO VAZA. Endereço só sai com opt-in, bairro de um tenant
 *   não aparece no outro, e serviço desligado não é oferecido.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f52-'));
const abertos = [];
fs.mkdirSync(path.join(tmp, 'uploads', 'loja'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'uploads', 'loja', 'logo.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'));

const loja = require('../loja-routes');
const padrao = (cfg, chave, valor) => (chave in cfg ? cfg[chave] : valor);
const COMERCIAL = { 1: [['08:00', '18:00']], 2: [['08:00', '18:00']], 3: [['08:00', '18:00']],
                    4: [['08:00', '18:00']], 5: [['08:00', '18:00']], 6: [['08:00', '12:00']] };

/** Três categorias, ordem invertida em relação à alfabética, para o filtro ter o que provar. */
const CATS = [
  ['ALIMENTOS', [['A1', 'ARROZ', 10, 2], ['A2', 'CAFE', 20, 1], ['A3', 'ACUCAR', 15, 3]]],
  ['BEBIDAS', [['B1', 'SUCO', 8, 1], ['B2', 'AGUA', 4, 2]]],
  ['DOCES', [['D1', 'BOLO', 30, 1]]],
];

function montar(nome, cfg = {}) {
  const db = new Database(path.join(tmp, nome + '.db'));
  db.pragma('foreign_keys = OFF');
  require('../db-schema').initSchema(db);
  db.pragma('foreign_keys = ON');
  loja.migrarLojaDB(db);
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL, caminho TEXT NOT NULL, urlOrigem TEXT, origem TEXT DEFAULT 'outra',
    autorizadoPor TEXT, autorizadoEm TEXT, largura INTEGER, altura INTEGER, bytes INTEGER,
    ordem INTEGER DEFAULT 0, dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);
  abertos.push(db);

  db.prepare(`UPDATE loja_config SET ativa=1, nome=?, descricao=?, logoPath='/uploads/loja/logo.png',
      whatsapp='44999990000', email='oi@loja.com', endereco=?, mostrarEndereco=?, horarios=?,
      servicoRetirada=?, servicoDelivery=?, freteModo=?, freteValor=?, aceitaForaCobertura=?,
      instagram=?, bannerPath=?, logoFoco=?, bannerFoco=?,
      mostrarPreco=1, mostrarEstoque=1 WHERE id=1`)
    .run(padrao(cfg, 'nome', 'LOJA TESTE'), padrao(cfg, 'descricao', 'Sabor em cada detalhe'),
         padrao(cfg, 'endereco', null), cfg.mostrarEndereco ? 1 : 0,
         cfg.horarios ? JSON.stringify(cfg.horarios) : null,
         padrao(cfg, 'retirada', 1), padrao(cfg, 'delivery', 0),
         padrao(cfg, 'freteModo', 'gratis'), padrao(cfg, 'freteValor', 0),
         cfg.aceitaFora ? 1 : 0, padrao(cfg, 'instagram', null),
         padrao(cfg, 'banner', '/uploads/loja/logo.png'),
         cfg.logoFoco ? JSON.stringify(cfg.logoFoco) : null,
         cfg.bannerFoco ? JSON.stringify(cfg.bannerFoco) : null);

  const ins = db.prepare(`INSERT INTO produtos (sku, descricao, categoria, unidade, precoVenda,
    precoCusto, ativo, publicadoNaLoja, destaqueNaLoja, ordemVitrine)
    VALUES (?,?,?,'UN',?,?,1,1,?,?)`);
  for (const [cat, itens] of CATS) {
    for (const [sku, desc, preco, ordem] of itens) {
      ins.run(sku, desc, cat, preco, preco / 3, sku === 'A2' ? 1 : 0, ordem);
    }
  }
  // Ordem das categorias invertendo a alfabética: DOCES, BEBIDAS, ALIMENTOS.
  for (const [i, c] of ['DOCES', 'BEBIDAS', 'ALIMENTOS'].entries()) {
    db.prepare('INSERT OR REPLACE INTO loja_categoria_ordem (categoria, ordem) VALUES (?,?)').run(c, i + 1);
  }
  for (const b of (cfg.bairros || [])) {
    db.prepare('INSERT INTO rest_bairros_taxa (nome, taxa, tempoEstimadoMin, ativo) VALUES (?,?,30,?)')
      .run(b.nome, b.taxa, b.ativo === false ? 0 : 1);
  }
  try {
    db.prepare(`INSERT INTO fornecedor (razaoSocial, telefone, endereco, numero, bairro, cidade, uf)
      VALUES ('EMPRESA TESTE LTDA','4433221100','RUA DA EMPRESA','10','CENTRO','MARINGA','PR')`).run();
  } catch (_) { /* sem fornecedor */ }
  return db;
}

function subir(tenants, opcoes = {}) {
  const app = express();
  app.use(express.json());
  let atual = tenants[0];
  app.use((req, res, next) => {
    const slug = req.headers['x-tenant-teste'];
    if (slug) atual = tenants.find((x) => x.slug === slug) || atual;
    next();
  });
  const proxy = new Proxy({}, { get: (_, prop) => {
    const alvo = atual.db; const v = alvo[prop];
    return typeof v === 'function' ? v.bind(alvo) : v;
  } });
  loja.registrarRotasLojaPublica(app, proxy);
  loja.registrarRotasLojaAdmin(app, proxy);
  app.use('/loja', express.static(path.join(PUB, 'loja')));
  app.use('/uploads', express.static(path.join(tmp, 'uploads')));
  if (opcoes.comPainel) {
    // Os estáticos do ERP e um shell mínimo, igual ao `app.html`.
    app.use(express.static(PUB));
    app.get('/__shell', (req, res) => {
      res.type('html').send(`<!doctype html><meta charset="utf-8">
        <link rel="stylesheet" href="/css/sidebar.css">
        <style>html,body{margin:0;height:100%;overflow:hidden}
          iframe{border:0;position:fixed;top:var(--topbar-h,52px);left:0;right:0;
                 width:100%;height:calc(100% - var(--topbar-h,52px));display:block}</style>
        <script>window.__liciteShell = true; window.__shellPageChanged = function(){};</script>
        <iframe id="conteudo" src="/catalogo/catalogo-online.html"></iframe>`);
    });
  }
  return new Promise((r) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => r(s)); });
}

function pedir(porta, rota, { metodo = 'GET', corpo = null, slug = null } = {}) {
  return new Promise((resolve, reject) => {
    const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const req = http.request({ host: '127.0.0.1', port: porta, path: rota, method: metodo,
      headers: Object.assign({}, dados ? { 'Content-Type': 'application/json',
        'Content-Length': dados.length } : {}, slug ? { 'x-tenant-teste': slug } : {}) }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, body: j, cru: b }); });
    });
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

// ============================================================================
// A. Ordenação — servidor
// ============================================================================

t('A1. ordem das categorias persiste e o público respeita', async () => {
  const A = { slug: 'a', db: montar('a1') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const antes = await pedir(porta, '/loja/api/produtos');
    assert(antes.body.categorias[0] === 'DOCES',
      'a ordem configurada não valeu: ' + JSON.stringify(antes.body.categorias));

    await pedir(porta, '/api/loja/ordem-categorias', { metodo: 'PUT',
      corpo: { categorias: ['BEBIDAS', 'ALIMENTOS', 'DOCES'] } });

    const depois = await pedir(porta, '/loja/api/produtos');
    assert(depois.body.categorias.join() === 'BEBIDAS,ALIMENTOS,DOCES',
      'a nova ordem não chegou ao público: ' + JSON.stringify(depois.body.categorias));
    // E a gravação é a que persiste — não um estado de tela.
    const banco = A.db.prepare('SELECT categoria FROM loja_categoria_ordem ORDER BY ordem').all()
      .map((r) => r.categoria);
    assert(banco.join() === 'BEBIDAS,ALIMENTOS,DOCES', 'o banco não guardou: ' + banco.join());
  } finally { srv.close(); }
});

t('A2. ordem dos produtos persiste e NÃO altera preço, estoque, publicação ou destaque', async () => {
  const A = { slug: 'a', db: montar('a2') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const foto = () => A.db.prepare(`SELECT sku, precoVenda, precoCusto, publicadoNaLoja,
      destaqueNaLoja, categoria FROM produtos ORDER BY sku`).all();
    const antes = foto();

    /* A ordem de destino precisa DIFERIR da atual, senão remover a gravação não
       muda nada e o caso passa sobre código quebrado — foi o que a sabotagem de
       15/09 mostrou. Parte-se da ordem vigente e trocam-se os dois primeiros. */
    const ids = A.db.prepare(`SELECT id FROM produtos WHERE categoria='ALIMENTOS'
      ORDER BY ordemVitrine, descricao`).all().map((r) => r.id);
    const invertido = [ids[1], ids[0], ...ids.slice(2)];
    assert(invertido.join() !== ids.join(), 'a ordem de destino é igual à atual — o caso não provaria nada');
    const r = await pedir(porta, '/api/loja/ordem-produtos', { metodo: 'PUT', corpo: { ids: invertido } });
    assert(r.status === 200, 'a gravação falhou: ' + r.status);

    const depois = foto();
    assert(JSON.stringify(antes) === JSON.stringify(depois),
      'reordenar mexeu em algo além da ordem:\\n' + JSON.stringify(antes) + '\\n' + JSON.stringify(depois));

    const pub = await pedir(porta, '/loja/api/produtos');
    const ali = pub.body.produtos.filter((p) => p.categoria === 'ALIMENTOS').map((p) => p.sku);
    const esperado = invertido.map((id) => A.db.prepare('SELECT sku FROM produtos WHERE id=?').get(id).sku);
    assert(ali.join() === esperado.join(),
      `o público ignorou a ordem: veio ${ali.join()}, esperava ${esperado.join()}`);
  } finally { srv.close(); }
});

t('A3. ordem não cruza tenant', async () => {
  const A = { slug: 'a', db: montar('a3a') };
  const B = { slug: 'b', db: montar('a3b') };
  const srv = await subir([A, B]);
  const porta = srv.address().port;
  try {
    await pedir(porta, '/api/loja/ordem-categorias', { slug: 'a',
      corpo: { categorias: ['BEBIDAS', 'ALIMENTOS', 'DOCES'] }, metodo: 'PUT' });
    const rb = await pedir(porta, '/loja/api/produtos', { slug: 'b' });
    assert(rb.body.categorias[0] === 'DOCES',
      'a ordem do tenant A vazou para o B: ' + JSON.stringify(rb.body.categorias));
  } finally { srv.close(); }
});

// ============================================================================
// B. Entrega e cobertura
// ============================================================================

t('B1. frete grátis, fixo e por bairro chegam corretos ao público', async () => {
  for (const [modo, valor, esperado] of [['gratis', 0, null], ['fixo', 8.5, 8.5]]) {
    const A = { slug: 'a', db: montar('b1' + modo, { delivery: 1, freteModo: modo, freteValor: valor }) };
    const srv = await subir([A]);
    try {
      const r = await pedir(srv.address().port, '/loja/api/config');
      const e = r.body.loja.entrega;
      assert(e.freteModo === modo, `modo errado: ${e.freteModo}`);
      assert(e.freteValor === esperado, `valor errado no modo ${modo}: ${e.freteValor}`);
    } finally { srv.close(); }
  }

  const C = { slug: 'a', db: montar('b1bairro', { delivery: 1, freteModo: 'bairro',
    bairros: [{ nome: 'CENTRO', taxa: 6 }, { nome: 'JARDIM', taxa: 9 }] }) };
  const srv = await subir([C]);
  try {
    const e = (await pedir(srv.address().port, '/loja/api/config')).body.loja.entrega;
    assert(e.bairros.length === 2, 'bairros não vieram: ' + JSON.stringify(e.bairros));
    assert(e.bairros.find((b) => b.nome === 'JARDIM').taxa === 9, 'taxa errada');
  } finally { srv.close(); }
});

t('B2. bairro INATIVO não aparece no público, mas continua na tela do lojista', async () => {
  const A = { slug: 'a', db: montar('b2', { delivery: 1, freteModo: 'bairro',
    bairros: [{ nome: 'CENTRO', taxa: 6 }, { nome: 'DESLIGADO', taxa: 9, ativo: false }] }) };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const pub = await pedir(porta, '/loja/api/config');
    assert(!/DESLIGADO/.test(pub.cru), 'bairro inativo foi ao ar');
    const adm = await pedir(porta, '/api/loja/entrega');
    assert(adm.body.bairros.length === 2, 'a tela do lojista perdeu o inativo');
    assert(adm.body.bairros.find((b) => b.nome === 'DESLIGADO').ativo === false, 'estado errado');
  } finally { srv.close(); }
});

t('B3. serviço DESABILITADO não é oferecido', async () => {
  const A = { slug: 'a', db: montar('b3', { retirada: 1, delivery: 0, freteModo: 'bairro',
    bairros: [{ nome: 'CENTRO', taxa: 6 }] }) };
  const srv = await subir([A]);
  try {
    const e = (await pedir(srv.address().port, '/loja/api/config')).body.loja.entrega;
    assert(e.retirada === true && e.delivery === false, 'serviços errados: ' + JSON.stringify(e));
    // Sem delivery, a cobertura inteira some — anunciar bairro de serviço que
    // não existe só gera pergunta.
    assert(e.bairros.length === 0, 'bairros apareceram sem delivery habilitado');
    assert(e.freteModo === null, 'anunciou modo de frete sem delivery');
  } finally { srv.close(); }
});

t('B4. taxa negativa é recusada, no PUT e no cadastro de bairro', async () => {
  const A = { slug: 'a', db: montar('b4') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const r1 = await pedir(porta, '/api/loja/entrega', { metodo: 'PUT',
      corpo: { retirada: true, delivery: true, freteModo: 'fixo', freteValor: -5 } });
    assert(r1.status === 422, 'aceitou frete fixo negativo: ' + r1.status);

    const r2 = await pedir(porta, '/api/loja/bairros', { metodo: 'POST',
      corpo: { nome: 'CENTRO', taxa: -3 } });
    assert(r2.status === 422, 'aceitou bairro com taxa negativa: ' + r2.status);
    assert(A.db.prepare('SELECT COUNT(*) n FROM rest_bairros_taxa').get().n === 0, 'gravou mesmo recusando');
  } finally { srv.close(); }
});

t('B5. desligar os DOIS serviços é recusado', async () => {
  const A = { slug: 'a', db: montar('b5') };
  const srv = await subir([A]);
  try {
    const r = await pedir(srv.address().port, '/api/loja/entrega', { metodo: 'PUT',
      corpo: { retirada: false, delivery: false, freteModo: 'gratis' } });
    assert(r.status === 422, 'aceitou catálogo sem serviço nenhum: ' + r.status);
    assert(/ao menos um/i.test(r.body.error), 'mensagem não orienta: ' + r.body.error);
  } finally { srv.close(); }
});

t('B6. bairros não cruzam tenant', async () => {
  const A = { slug: 'a', db: montar('b6a', { delivery: 1, freteModo: 'bairro',
    bairros: [{ nome: 'BAIRRO DO A', taxa: 5 }] }) };
  const B = { slug: 'b', db: montar('b6b', { delivery: 1, freteModo: 'bairro',
    bairros: [{ nome: 'BAIRRO DO B', taxa: 7 }] }) };
  const srv = await subir([A, B]);
  const porta = srv.address().port;
  try {
    const ra = await pedir(porta, '/loja/api/config', { slug: 'a' });
    const rb = await pedir(porta, '/loja/api/config', { slug: 'b' });
    assert(!/BAIRRO DO B/.test(ra.cru), 'bairro do B vazou para o A');
    assert(!/BAIRRO DO A/.test(rb.cru), 'bairro do A vazou para o B');
    const adm = await pedir(porta, '/api/loja/entrega', { slug: 'a' });
    assert(adm.body.bairros.length === 1 && adm.body.bairros[0].nome === 'BAIRRO DO A',
      'a tela do A listou bairro alheio');
  } finally { srv.close(); }
});

t('B7. CRUD de bairro: cria, edita, desativa, exclui', async () => {
  const A = { slug: 'a', db: montar('b7') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const c = await pedir(porta, '/api/loja/bairros', { metodo: 'POST', corpo: { nome: 'CENTRO', taxa: 6 } });
    assert(c.status === 200 && c.body.id, 'não criou: ' + JSON.stringify(c.body));
    const id = c.body.id;

    // Nome repetido é recusado — duas linhas do mesmo bairro é erro de digitação.
    const dup = await pedir(porta, '/api/loja/bairros', { metodo: 'POST', corpo: { nome: 'centro', taxa: 9 } });
    assert(dup.status === 422, 'aceitou bairro duplicado');

    await pedir(porta, `/api/loja/bairros/${id}`, { metodo: 'PUT', corpo: { taxa: 7.5 } });
    assert(loja.bairrosCobertura(A.db)[0].taxa === 7.5, 'não editou a taxa');

    await pedir(porta, `/api/loja/bairros/${id}`, { metodo: 'PUT', corpo: { ativo: false } });
    assert(loja.bairrosCobertura(A.db).length === 0, 'desativar não tirou do público');
    assert(loja.bairrosCobertura(A.db, { somenteAtivos: false }).length === 1, 'desativar apagou o registro');

    const d = await pedir(porta, `/api/loja/bairros/${id}`, { metodo: 'DELETE' });
    assert(d.status === 200, 'não excluiu');
    assert(A.db.prepare('SELECT COUNT(*) n FROM rest_bairros_taxa').get().n === 0, 'sobrou registro');
  } finally { srv.close(); }
});

t('B8. o catálogo NÃO toca em rest_comandas', async () => {
  // A fase reutiliza `rest_bairros_taxa`, que é definição. O acoplamento
  // proibido é com a comanda — e é isso que este caso vigia.
  const fonte = fs.readFileSync(path.join(RAIZ, 'loja-routes.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const proibido of ['rest_comandas', 'rest_comanda_itens', 'rest_entregas']) {
    assert(!fonte.includes(proibido), `loja-routes.js passou a usar ${proibido}`);
  }
});

// ============================================================================
// C. Privacidade do endereço
// ============================================================================

t('C1. endereço privado não vaza; autorizado aparece', async () => {
  const oculto = { slug: 'a', db: montar('c1a', { endereco: 'RUA SECRETA, 1', mostrarEndereco: false }) };
  let srv = await subir([oculto]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/config');
    assert(r.body.loja.endereco === null && !/SECRETA/.test(r.cru), 'endereço privado vazou');
  } finally { srv.close(); }

  const visivel = { slug: 'a', db: montar('c1b', { endereco: 'RUA ABERTA, 2', mostrarEndereco: true }) };
  srv = await subir([visivel]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/config');
    assert(r.body.loja.endereco === 'RUA ABERTA, 2', 'endereço autorizado não apareceu');
  } finally { srv.close(); }
});

// ============================================================================
// D. Navegador — painel administrativo (dentro do shell do ERP)
// ============================================================================

/**
 * Sobe o painel como ele roda de verdade: dentro do `app.html`.
 *
 * `window.__liciteShell = true` no PAI é o que `sidebar.js` testa; sem isso a
 * tela se julga avulsa e desenha a própria topbar sobre os 52px de cima, e um
 * clique por coordenada acerta a barra em vez do botão.
 */
async function comPainel(tenants, largura, fn) {
  const srv = await subir(tenants, { comPainel: true });
  const porta = srv.address().port;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: largura, height: 900, isMobile: largura < 700, hasTouch: largura < 700 });
  const erros = [];
  page.on('pageerror', (e) => erros.push(e.name + ': ' + e.message));
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await page.goto(`http://127.0.0.1:${porta}/__shell`, { waitUntil: 'networkidle2', timeout: 30000 });
    await espera(2600);
    const h = await page.$('#conteudo');
    const f = h ? await h.contentFrame() : null;
    if (!f) throw new Error('o painel nao carregou no shell');
    // Espera os DADOS, não só o DOM.
    for (let i = 0; i < 25; i++) {
      const pronto = await f.evaluate(() => typeof DADOS !== 'undefined' && DADOS !== null).catch(() => false);
      if (pronto) break;
      await espera(400);
    }
    return await fn(f, page, { erros, espera });
  } finally { await browser.close(); srv.close(); }
}

t('D1. clicar numa categoria mostra EXATAMENTE aquela categoria', async () => {
  const A = { slug: 'a', db: montar('d1') };
  await comPainel([A], 1400, async (f, page, ctx) => {
    const r = await f.evaluate(async () => {
      const out = [];
      /* As CHAVES, não os nós: `pintarNav()` reescreve a barra a cada clique,
         e uma referência guardada antes vira nó órfão. */
      const chaves = [...document.querySelectorAll('#navCats button[data-ir]')]
        .filter((b) => b.dataset.ir !== 'todas' && b.dataset.ir !== 'destaques')
        .map((b) => b.dataset.ir);
      const acha = (k) => document.querySelector(`#navCats [data-ir="${CSS.escape(k)}"]`);
      for (const chave of chaves) {
        const bt = acha(chave);
        const nome = bt.textContent.trim();
        bt.click();
        await new Promise((x) => setTimeout(x, 300));
        out.push({
          clicou: nome,
          ativa: [...document.querySelectorAll('#navCats button.ativo')].map((x) => x.textContent.trim()),
          blocos: [...document.querySelectorAll('#lista .bc-nome')].map((x) => x.textContent.trim()),
        });
        const volta = acha(chave);
        if (volta) volta.click();
        await new Promise((x) => setTimeout(x, 200));
      }
      document.querySelector('[data-ir="todas"]').click();
      await new Promise((x) => setTimeout(x, 300));
      out.push({ clicou: '__todas', blocos: [...document.querySelectorAll('#lista .bc-nome')]
        .map((x) => x.textContent.trim()) });
      return out;
    });

    for (const linha of r.filter((x) => x.clicou !== '__todas')) {
      assert(linha.ativa.join() === linha.clicou,
        `aba ativa divergiu: clicou ${linha.clicou}, ativa ${linha.ativa.join()}`);
      assert(linha.blocos.length === 1 && linha.blocos[0] === linha.clicou,
        `conteúdo divergiu da aba: clicou ${linha.clicou}, mostrou ${JSON.stringify(linha.blocos)}`);
    }
    const todas = r.find((x) => x.clicou === '__todas');
    /* 4 blocos, não 3: "★ Destaques" é uma seção à parte e aparece na visão
       geral junto das três categorias. Produto em destaque sai duas vezes por
       desenho — ele continua na categoria dele. */
    assert(todas.blocos.length === 4, '"Todas" não voltou à visão geral: ' + JSON.stringify(todas.blocos));
    assert(todas.blocos[0] === '★ Destaques', 'Destaques deixou de vir primeiro');
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('D2. as abas seguem a ordem configurada das categorias', async () => {
  const A = { slug: 'a', db: montar('d2') };
  await comPainel([A], 1400, async (f) => {
    const abas = await f.evaluate(() => [...document.querySelectorAll('#navCats button[data-ir]')]
      .filter((b) => !['todas', 'destaques'].includes(b.dataset.ir))
      .map((b) => b.textContent.trim()));
    // A ordem gravada é DOCES, BEBIDAS, ALIMENTOS — não a alfabética.
    assert(abas.join() === 'DOCES,BEBIDAS,ALIMENTOS', 'abas fora da ordem: ' + abas.join());
  });
});

t('D3. o nome e a descrição NÃO invadem o banner', async () => {
  for (const nome of ['LOJA X', 'NOME EXTREMAMENTE LONGO DE UMA EMPRESA QUE NAO CABE NA LINHA NENHUMA']) {
    const A = { slug: 'a', db: montar('d3' + nome.length, { nome }) };
    await comPainel([A], 1400, async (f) => {
      const g = await f.evaluate(() => {
        const cx = (s) => { const e = document.querySelector(s); if (!e) return null;
          const r = e.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
        return { banner: cx('.cap-banner'), nome: cx('#capNome'), sub: cx('#capSub'), logo: cx('.cap-logo-bt') };
      });
      // O NOME começa abaixo do fim do banner. O LOGO pode subir — é o desenho.
      assert(g.nome.top >= g.banner.bottom - 2,
        `o nome invade a capa: nome.top=${g.nome.top}, banner.bottom=${g.banner.bottom}`);
      assert(g.sub.top >= g.banner.bottom - 2, 'a descrição invade a capa');
      assert(g.logo.top < g.banner.bottom, 'o logo deixou de sobrepor a capa (era o desenho)');
      assert(g.nome.h > 8, 'o nome sumiu');
    });
  }
});

t('D4. arrastar produto grava a ordem e não mexe em mais nada', async () => {
  const A = { slug: 'a', db: montar('d4') };
  const foto = () => A.db.prepare(`SELECT sku, precoVenda, precoCusto, publicadoNaLoja,
    destaqueNaLoja, categoria FROM produtos ORDER BY sku`).all();
  const antes = foto();
  await comPainel([A], 1400, async (f, page, ctx) => {
    const r = await f.evaluate(async () => {
      // Abre ALIMENTOS pelo filtro e expande o bloco.
      const cat = [...document.querySelectorAll('#navCats button')]
        .find((b) => b.textContent.trim() === 'ALIMENTOS');
      cat.click();
      await new Promise((x) => setTimeout(x, 400));
      document.querySelector('#lista .bc-toggle').click();
      await new Promise((x) => setTimeout(x, 400));
      const linhas = [...document.querySelectorAll('#lista .lp[data-id]')];
      if (linhas.length < 2) return { erro: 'menos de 2 produtos na lista' };
      return { antes: linhas.map((l) => l.dataset.id), puxadores: linhas.filter((l) => l.querySelector('.puxador')).length };
    });
    assert(!r.erro, r.erro);
    assert(r.puxadores === r.antes.length, 'nem toda linha tem puxador');

    // Arrasta a 2ª linha para cima da 1ª, com Pointer Events reais.
    const alvo = await f.evaluate(() => {
      const linhas = [...document.querySelectorAll('#lista .lp[data-id]')];
      const p = linhas[1].querySelector('.puxador').getBoundingClientRect();
      const destino = linhas[0].getBoundingClientRect();
      return { x: p.left + p.width / 2, y: p.top + p.height / 2, destinoY: destino.top + 4 };
    });
    const off = await page.evaluate(() => {
      const r2 = document.getElementById('conteudo').getBoundingClientRect();
      return { x: r2.left, y: r2.top };
    });
    await page.mouse.move(alvo.x + off.x, alvo.y + off.y);
    await page.mouse.down();
    await page.mouse.move(alvo.x + off.x, alvo.y + off.y - 20, { steps: 5 });
    await page.mouse.move(alvo.x + off.x, alvo.destinoY + off.y, { steps: 10 });
    await page.mouse.up();
    await ctx.espera(2000);

    const depois = foto();
    assert(JSON.stringify(antes) === JSON.stringify(depois),
      'arrastar mexeu em preço/estoque/publicação/destaque');
    const ordens = A.db.prepare("SELECT sku, ordemVitrine FROM produtos WHERE categoria='ALIMENTOS' ORDER BY ordemVitrine").all();
    assert(ordens.every((o) => o.ordemVitrine > 0), 'a ordem não foi gravada: ' + JSON.stringify(ordens));
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('D5. o puxador é alcançável por teclado (alternativa ao arrasto)', async () => {
  const A = { slug: 'a', db: montar('d5') };
  await comPainel([A], 1400, async (f, page, ctx) => {
    const r = await f.evaluate(async () => {
      const cat = [...document.querySelectorAll('#navCats button')]
        .find((b) => b.textContent.trim() === 'ALIMENTOS');
      cat.click();
      await new Promise((x) => setTimeout(x, 400));
      document.querySelector('#lista .bc-toggle').click();
      await new Promise((x) => setTimeout(x, 400));
      const p = document.querySelector('#lista .lp[data-id] .puxador');
      return { focavel: p.getAttribute('tabindex') === '0', papel: p.getAttribute('role'),
               rotulo: !!p.getAttribute('aria-label') };
    });
    assert(r.focavel, 'o puxador não é alcançável por teclado');
    assert(r.papel === 'button', 'o puxador não se anuncia como controle');
    assert(r.rotulo, 'o puxador não tem rótulo acessível');
    assert(ctx.erros.length === 0, 'erro: ' + ctx.erros.join(' | '));
  });
});

// ============================================================================
// E. Navegador — catálogo público
// ============================================================================

async function comLoja(tenants, largura, fn) {
  const srv = await subir(tenants);
  const porta = srv.address().port;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: largura, height: 900, isMobile: largura < 700, hasTouch: largura < 700 });
  const erros = [], respostas = [];
  page.on('pageerror', (e) => erros.push(e.name + ': ' + e.message));
  page.on('response', (r) => respostas.push({ u: r.url().replace(/^http:\/\/[^/]+/, ''), s: r.status() }));
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await page.goto(`http://127.0.0.1:${porta}/loja/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await espera(1600);
    return await fn(page, { erros, espera, respostas });
  } finally { await browser.close(); srv.close(); }
}

t('E1. sacola: tipo de serviço vem ANTES de "Complete seu pedido"', async () => {
  const A = { slug: 'a', db: montar('e1', { retirada: 1, delivery: 1, freteModo: 'fixo', freteValor: 7 }) };
  await comLoja([A], 1280, async (page, ctx) => {
    const r = await page.evaluate(async () => {
      await adicionar({ produtoId: 1, quantidade: 1, opcoes: [], textos: {}, comentario: null });
      location.hash = '#/sacola';
      await new Promise((x) => setTimeout(x, 1400));
      /* Posição no DOM, não `indexOf` no HTML: o comentário acima do bloco
         contém a frase "tipo de serviço", e medir a string casava com ele em
         vez do elemento — a sabotagem de 15/09 passou exatamente por isso. */
      const secao = document.querySelector('.servico');
      const sug = [...document.querySelectorAll('.secao h2')]
        .find((h) => /Complete seu pedido/.test(h.textContent));
      const antes = secao && sug
        // DOCUMENT_POSITION_FOLLOWING = 4: o serviço vem ANTES da sugestão.
        ? !!(secao.compareDocumentPosition(sug.closest('.secao')) & 4) : null;
      return { servicoAntes: antes, temServico: !!secao, temSug: !!sug,
        servicos: [...document.querySelectorAll('.servico-bt')].map((b) => b.textContent),
        temSacola: document.querySelectorAll('.item-sacola').length };
    });
    assert(r.temSacola === 1, 'a sacola perdeu o item');
    assert(r.temServico && r.temSug, 'faltou um dos blocos');
    assert(r.servicoAntes === true, 'serviço ainda aparece DEPOIS das sugestões');
    assert(r.servicos.join() === 'Retirada,Delivery', 'serviços errados: ' + r.servicos.join());
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('E2. serviço desabilitado NÃO vira botão na sacola', async () => {
  const A = { slug: 'a', db: montar('e2', { retirada: 1, delivery: 0 }) };
  await comLoja([A], 1280, async (page) => {
    const r = await page.evaluate(async () => {
      await adicionar({ produtoId: 1, quantidade: 1, opcoes: [], textos: {}, comentario: null });
      location.hash = '#/sacola';
      await new Promise((x) => setTimeout(x, 1400));
      return [...document.querySelectorAll('.servico-bt')].map((b) => b.textContent);
    });
    assert(r.join() === 'Retirada', 'ofereceu delivery desabilitado: ' + r.join());
  });
});

t('E3. painel Informações abre, fecha e mostra só o que existe', async () => {
  const A = { slug: 'a', db: montar('e3', { horarios: COMERCIAL, instagram: 'lojateste',
    endereco: 'RUA ABERTA, 10', mostrarEndereco: true, retirada: 1, delivery: 1,
    freteModo: 'bairro', bairros: [{ nome: 'CENTRO', taxa: 6 }, { nome: 'OCULTO', taxa: 9, ativo: false }],
    aceitaFora: true }) };
  await comLoja([A], 1280, async (page, ctx) => {
    const fechado = await page.evaluate(() => document.getElementById('infoBg').hidden);
    assert(fechado, 'o painel nasce aberto');

    const r = await page.evaluate(async () => {
      document.getElementById('btInfo').click();
      await new Promise((x) => setTimeout(x, 400));
      const corpo = document.getElementById('infoCorpo');
      return {
        aberto: !document.getElementById('infoBg').hidden,
        texto: corpo.innerText,
        secoes: [...corpo.querySelectorAll('.info-sec h3')].map((h) => h.textContent),
        redes: corpo.querySelectorAll('.rede').length,
        tags: [...corpo.querySelectorAll('.info-tag')].map((x) => x.textContent),
        dias: corpo.querySelectorAll('.info-horarios dt').length,
      };
    });
    assert(r.aberto, 'o painel não abriu');
    assert(/Aberto|Fechado/.test(r.texto), 'faltou o status: ' + r.texto.slice(0, 80));
    assert(r.secoes.includes('Endereço'), 'faltou o endereço autorizado');
    assert(/RUA ABERTA, 10/.test(r.texto), 'o endereço não apareceu');
    assert(r.secoes.includes('Tipos de serviço'), 'faltaram os tipos de serviço');
    assert(r.secoes.includes('Abrangência da entrega'), 'faltou a abrangência');
    assert(r.tags.some((x) => /CENTRO/.test(x)), 'faltou o bairro ativo');
    assert(!r.tags.some((x) => /OCULTO/.test(x)), 'apareceu bairro inativo');
    assert(/fora da área de cobertura/i.test(r.texto), 'faltou o aviso de fora da cobertura');
    assert(r.dias === 7, 'os 7 dias não saíram: ' + r.dias);
    assert(r.redes === 2, 'redes erradas (whatsapp + instagram): ' + r.redes);

    const fechou = await page.evaluate(async () => {
      document.getElementById('btInfoFechar').click();
      await new Promise((x) => setTimeout(x, 300));
      return document.getElementById('infoBg').hidden;
    });
    assert(fechou, 'o painel não fechou');
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('E4. Informações NÃO mostra endereço privado nem rede inexistente', async () => {
  const A = { slug: 'a', db: montar('e4', { endereco: 'RUA SECRETA, 99', mostrarEndereco: false,
    instagram: null, horarios: null, retirada: 1, delivery: 0 }) };
  await comLoja([A], 1280, async (page) => {
    const r = await page.evaluate(async () => {
      document.getElementById('btInfo').click();
      await new Promise((x) => setTimeout(x, 400));
      const corpo = document.getElementById('infoCorpo');
      return { texto: corpo.innerText,
        secoes: [...corpo.querySelectorAll('.info-sec h3')].map((h) => h.textContent),
        redes: [...corpo.querySelectorAll('.rede')].map((a) => a.getAttribute('title')),
        tags: [...corpo.querySelectorAll('.info-tag')].map((x) => x.textContent) };
    });
    assert(!/SECRETA/.test(r.texto), 'o endereço privado apareceu no painel');
    assert(!r.secoes.includes('Endereço'), 'desenhou a seção de endereço sem endereço público');
    assert(!r.redes.includes('Instagram'), 'mostrou rede não configurada: ' + r.redes.join());
    assert(!r.secoes.includes('Horário de funcionamento'), 'inventou horário sem configuração');
    assert(r.tags.join() === 'Retirada', 'ofereceu serviço desabilitado: ' + r.tags.join());
  });
});

for (const largura of [320, 375, 390, 430]) {
  t(`E5-${largura}. painel Informações utilizável em ${largura}px`, async () => {
    const A = { slug: 'a', db: montar('e5' + largura, { horarios: COMERCIAL, delivery: 1,
      freteModo: 'bairro', bairros: [{ nome: 'CENTRO', taxa: 6 }] }) };
    await comLoja([A], largura, async (page, ctx) => {
      const r = await page.evaluate(async () => {
        document.getElementById('btInfo').click();
        await new Promise((x) => setTimeout(x, 400));
        const p = document.getElementById('infoPainel') || document.querySelector('.info-painel');
        const b = p.getBoundingClientRect();
        const bt = document.getElementById('btInfo').getBoundingClientRect();
        return {
          dentro: b.left >= -1 && b.right <= window.innerWidth + 1,
          altura: Math.round(b.height), largura: Math.round(b.width),
          alvoBt: { w: Math.round(bt.width), h: Math.round(bt.height) },
          rolaH: document.documentElement.scrollWidth > window.innerWidth + 1,
          fecharAlvo: (() => { const f = document.getElementById('btInfoFechar').getBoundingClientRect();
            return { w: Math.round(f.width), h: Math.round(f.height) }; })(),
        };
      });
      assert(r.dentro, 'o painel vaza da tela');
      assert(r.altura > 200, `painel com ${r.altura}px de altura`);
      assert(r.alvoBt.w >= 44 && r.alvoBt.h >= 44, `botão ⓘ mede ${r.alvoBt.w}x${r.alvoBt.h}`);
      assert(r.fecharAlvo.w >= 44 && r.fecharAlvo.h >= 44, 'o "fechar" é pequeno demais');
      assert(!r.rolaH, 'a página rola na horizontal com o painel aberto');
      assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
    });
  });
}

t('E6. o carrinho continua funcionando depois das mudanças', async () => {
  const A = { slug: 'a', db: montar('e6') };
  await comLoja([A], 1280, async (page, ctx) => {
    const r = await page.evaluate(async () => {
      await adicionar({ produtoId: 1, quantidade: 2, opcoes: [], textos: {}, comentario: null });
      await new Promise((x) => setTimeout(x, 600));
      return { barra: !document.getElementById('barra').hidden,
               total: document.getElementById('barraTotal').textContent };
    });
    assert(r.barra && /20,00/.test(r.total), 'o carrinho quebrou: ' + r.total);
    const ruins = ctx.respostas.filter((x) => x.s === 401 || x.s === 403);
    assert(ruins.length === 0, '401/403: ' + JSON.stringify(ruins));
  });
});

t('D6. a linha da categoria tem puxador VISÍVEL e clicável, ao lado da seta', async () => {
  const A = { slug: 'a', db: montar('d6') };
  await comPainel([A], 1400, async (f, page, ctx) => {
    const r = await f.evaluate(() => {
      const blocos = [...document.querySelectorAll('.bloco-cat[data-id]')];
      if (!blocos.length) return { erro: 'nenhum bloco arrastável' };
      const b0 = blocos[0];
      const p = b0.querySelector('.puxador-cat');
      if (!p) return { erro: 'sem puxador na categoria' };
      const r2 = p.getBoundingClientRect(), cs = getComputedStyle(p);
      const noPonto = document.elementFromPoint(r2.left + r2.width / 2, r2.top + r2.height / 2);
      return {
        blocos: blocos.length,
        visivel: cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0,
        tam: { w: Math.round(r2.width), h: Math.round(r2.height) },
        recebeClique: noPonto === p || p.contains(noPonto),
        temSeta: !!b0.querySelector('.bc-seta'),
        // `⠿ ▶ NOME`: puxador antes da seta, que vem antes do nome.
        ordemVisual: b0.querySelector('.bc-cab').innerText.replace(/\s+/g, ' ').trim(),
        focavel: p.getAttribute('tabindex') === '0',
      };
    });
    assert(!r.erro, r.erro);
    assert(r.visivel, 'o puxador da categoria não é visível');
    assert(r.tam.h >= 44, `alvo de toque do puxador: ${r.tam.w}x${r.tam.h}px`);
    assert(r.recebeClique, 'o puxador da categoria não recebe o clique');
    assert(r.temSeta, 'sumiu a seta de abrir/fechar');
    assert(/^⠿\s*▶/.test(r.ordemVisual), 'a linha não é "⠿ ▶ NOME": ' + r.ordemVisual);
    assert(r.focavel, 'o puxador da categoria não é alcançável por teclado');
    assert(ctx.erros.length === 0, 'erro: ' + ctx.erros.join(' | '));
  });
});

// ============================================================================
// F. Enquadramento e logo redonda (A e B do pedido)
// ============================================================================

t('F1. o foco é saneado: x/y presos a 0–100 e zoom a 1–4', () => {
  const casos = [
    [{ x: 999, y: -50, zoom: 99 }, { x: 100, y: 0, zoom: 4 }],
    [{ x: 30, y: 70, zoom: 1.5 }, { x: 30, y: 70, zoom: 1.5 }],
    [{ x: 'abc', y: null, zoom: 0.1 }, { x: 50, y: 50, zoom: 1 }],
  ];
  for (const [entrada, esperado] of casos) {
    const r = loja.lerFoco(entrada);
    assert(JSON.stringify(r) === JSON.stringify(esperado),
      `${JSON.stringify(entrada)} virou ${JSON.stringify(r)}, esperava ${JSON.stringify(esperado)}`);
  }
  assert(loja.lerFoco(null) === null, 'inventou foco a partir de nada');
  assert(loja.lerFoco('lixo{{') === null, 'quebrou com JSON inválido');
});

t('F2. o enquadramento persiste e chega ao público', async () => {
  const A = { slug: 'a', db: montar('f2') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const r = await pedir(porta, '/api/loja/enquadramento', { metodo: 'PUT',
      corpo: { qual: 'logo', foco: { x: 20, y: 80, zoom: 2 } } });
    assert(r.status === 200, 'o PUT falhou: ' + JSON.stringify(r.body));

    const pub = await pedir(porta, '/loja/api/config');
    const f = pub.body.loja.logoFoco;
    assert(f && f.x === 20 && f.y === 80 && f.zoom === 2,
      'o foco não chegou ao público: ' + JSON.stringify(f));
    assert(pub.body.loja.bannerFoco === null, 'inventou foco de banner não configurado');
  } finally { srv.close(); }
});

t('F3. "qual" inválido e foco inválido são recusados', async () => {
  const A = { slug: 'a', db: montar('f3') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const r1 = await pedir(porta, '/api/loja/enquadramento', { metodo: 'PUT',
      corpo: { qual: 'produto', foco: { x: 1, y: 1, zoom: 1 } } });
    assert(r1.status === 422, 'aceitou "qual" fora de logo/banner: ' + r1.status);
    const r2 = await pedir(porta, '/api/loja/enquadramento', { metodo: 'PUT',
      corpo: { qual: 'logo', foco: null } });
    assert(r2.status === 422, 'aceitou foco nulo: ' + r2.status);
  } finally { srv.close(); }
});

t('F4. trocar a imagem ZERA o enquadramento da imagem antiga', async () => {
  /* Verifica a ROTA, não uma simulação.
   *
   * A primeira versão deste caso escrevia `logoFoco=NULL` direto no banco e
   * conferia o resultado — ou seja, testava a própria simulação. Sabotar a rota
   * de upload não o reprovava, e a sabotagem de 15/09 mostrou isso.
   *
   * Agora se lê o UPDATE que as rotas de upload executam: é ele que precisa
   * zerar o foco, porque o ajuste pertencia à imagem anterior e aplicá-lo à
   * nova recortaria um pedaço que ninguém escolheu. */
  const fonte = fs.readFileSync(path.join(RAIZ, 'loja-routes.js'), 'utf8');
  for (const [qual, col] of [['logo', 'logoFoco'], ['banner', 'bannerFoco']]) {
    const i = fonte.indexOf(`app.post('/api/loja/${qual}'`);
    assert(i > 0, `rota de upload de ${qual} não encontrada`);
    const bloco = fonte.slice(i, i + 2200);
    const update = bloco.match(new RegExp(`UPDATE loja_config SET ${qual}Path=[^']*`));
    assert(update, `não achei o UPDATE do ${qual}`);
    assert(update[0].includes(`${col}=NULL`),
      `o upload de ${qual} não zera ${col}: ${update[0]}`);
  }

  // E o comportamento: sem foco gravado, o público não inventa um.
  const A = { slug: 'a', db: montar('f4') };
  const srv = await subir([A]);
  try {
    const pub = await pedir(srv.address().port, '/loja/api/config');
    assert(pub.body.loja.logoFoco === null, 'inventou foco onde não há');
  } finally { srv.close(); }
});

t('F5. o ORIGINAL não é re-encodado: o endpoint de foco não recebe imagem', () => {
  const fonte = fs.readFileSync(path.join(RAIZ, 'loja-routes.js'), 'utf8');
  const bloco = fonte.slice(fonte.indexOf("app.put('/api/loja/enquadramento'"),
                            fonte.indexOf("app.delete('/api/loja/logo'"));
  // Nada de multer, buffer ou escrita de arquivo no caminho do enquadramento:
  // é isso que garante que reajustar mil vezes não degrada a imagem.
  for (const proibido of ['multer', 'writeFileSync', 'req.file', 'toBuffer']) {
    assert(!bloco.includes(proibido), `o enquadramento mexe em arquivo ("${proibido}")`);
  }
});

t('F6. a logo é REDONDA e 1:1 no painel e nos três pontos do público', () => {
  const painel = fs.readFileSync(path.join(PUB, 'catalogo/catalogo-online.html'), 'utf8');
  assert(/\.cap-logo \{[^}]*border-radius: 50%/.test(painel), 'a logo do painel não é circular');
  assert(/\.cap-logo \{[^}]*aspect-ratio: 1/.test(painel), 'a logo do painel não é 1:1');
  assert(/\.cap-logo \{[^}]*object-fit: cover/.test(painel), 'a logo do painel pode deformar');

  const loja2 = fs.readFileSync(path.join(PUB, 'loja/index.html'), 'utf8');
  // Cabeçalho, painel Informações e rodapé.
  const circulares = (loja2.match(/border-radius: 50%; aspect-ratio: 1/g) || []).length;
  assert(circulares >= 3, `só ${circulares} lugares com logo circular no público`);
});

/* Os casos acima LEEM o código. Isso não basta: o editor foi ao ar chamando
 * `$()` e `abrir()`, helpers que existem em outras telas do ERP mas não nesta
 * — e como o JS é inline num .html, nem o `node --check` nem a leitura de
 * fonte reprovaram. O botão simplesmente não abria nada. Daqui em diante o
 * caso CLICA o botão de verdade e exige o modal aberto sem erro de página. */
t('D7. o botão "Ajustar" ABRE o editor de verdade, sem erro de JS', async () => {
  const A = { slug: 'a', db: montar('d7enq', { banner: '/uploads/loja/banner.png' }) };
  await comPainel([A], 1400, async (f, page, ctx) => {
    for (const qual of ['logo', 'banner']) {
      const bt = qual === 'logo' ? 'btAjustarLogo' : 'btAjustarCapa';
      const r = await f.evaluate(async (id) => {
        const b = document.getElementById(id);
        if (!b) return { achou: false };
        if (b.hidden) return { achou: true, oculto: true };
        b.click();
        await new Promise((x) => setTimeout(x, 400));
        const m = document.getElementById('modalEnq');
        return { achou: true, oculto: false, aberto: m.classList.contains('open'),
                 visivel: getComputedStyle(m).display !== 'none',
                 mascaraRaio: getComputedStyle(document.getElementById('enqMascara')).borderRadius,
                 titulo: document.getElementById('enqTitulo').textContent };
      }, bt);
      assert(r.achou, `o botão ${bt} não existe`);
      assert(!r.oculto, `o botão ${bt} está oculto mesmo havendo imagem`);
      assert(r.aberto && r.visivel, `clicar em ${bt} não abriu o editor`);
      // Preview circular é exigência da logo; o banner usa moldura retangular.
      if (qual === 'logo') assert(/50%/.test(r.mascaraRaio), 'o preview da logo não é circular');
      await f.evaluate(() => fecharEnq());
      await ctx.espera(200);
    }
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

/* Guarda de idioma: a tela não tem `$` nem `abrir`/`fechar`. Se alguém os
 * reintroduzir por hábito de outra tela, o caso acima só pega quando o Chrome
 * está disponível — este pega sempre. */
t('D8. o painel não chama helpers que não existem nele', () => {
  const src = fs.readFileSync(path.join(PUB, 'catalogo/catalogo-online.html'), 'utf8');
  const js = src.slice(src.indexOf('<script>', src.indexOf('initSidebar')));
  for (const [chamada, re] of [['$(', /(^|[^\w.$])\$\(/m],
                               ['abrir(', /(^|[^\w.])abrir\(/m],
                               ['fechar(', /(^|[^\w.])fechar\(/m]]) {
    const usa = re.test(js);
    const define = new RegExp('(function|const|let|var)\\s+' + chamada.replace('(', '') .replace('$', '\\$') + '\\b').test(js);
    assert(!usa || define, `a tela chama ${chamada} sem definir`);
  }
});

t('D9. mover por teclado NÃO perde o foco: dá para mover várias posições', async () => {
  /* A gravação repinta a lista, e o nó que tinha o foco deixa de existir. Sem
   * devolver o foco ao mesmo puxador, ↑ ↓ serve para mover UMA posição e
   * depois exige voltar com Tab — medido em produção em 16/09, antes da
   * correção. Este caso aperta duas vezes seguidas, sem tocar no foco entre
   * elas: se o refoco sumir, a segunda tecla não grava nada. */
  const A = { slug: 'a', db: montar('d9foco') };
  await comPainel([A], 1400, async (f, page, ctx) => {
    const gravacoes = [];
    page.on('response', (r) => { const u = r.url().replace(/^https?:\/\/[^/]+/, '');
      if (u.includes('/api/loja/ordem-categorias')) gravacoes.push(r.status()); });

    const ordem = () => f.evaluate(() => DADOS.categorias.map((c) => c.categoria));
    const antes = await ordem();
    assert(antes.length >= 3, 'o tenant de teste precisa de 3+ categorias');

    const alvo = await f.evaluate(() => {
      const p = document.querySelector('.bloco-cat[data-id] .puxador-cat');
      if (!p) return null;
      p.focus();
      return { cat: p.dataset.moverCat, focou: document.activeElement === p };
    });
    assert(alvo && alvo.focou, 'não consegui focar o puxador da categoria');

    await page.keyboard.press('ArrowDown');
    await ctx.espera(1500);
    const meio = await ordem();
    assert(meio.join() !== antes.join(), 'a primeira seta não moveu nada');
    assert(gravacoes.length === 1, `uma tecla gerou ${gravacoes.length} gravações`);

    const seguiuFocado = await f.evaluate(() => {
      const a = document.activeElement;
      return !!(a && a.classList && a.classList.contains('puxador-cat') && a.dataset.moverCat);
    });
    assert(seguiuFocado, 'o foco saiu do puxador depois de gravar');

    // Segunda tecla, sem refocar à mão.
    await page.keyboard.press('ArrowDown');
    await ctx.espera(1500);
    const fim = await ordem();
    assert(fim.join() !== meio.join(),
      `a segunda seta não moveu: ${meio.join()} -> ${fim.join()}`);
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('D10. ativar o arrasto de novo no mesmo container não empilha ouvintes', () => {
  /* Cada `carregar()` do catálogo ativa o arrasto 15+ vezes, e três ouvintes
   * de cada ativação vão em `document` — onde não morrem junto com os nós da
   * lista. Sem desligar a ativação anterior, eles crescem sem limite enquanto
   * a tela viver. */
  const src = fs.readFileSync(path.join(PUB, 'js/arrastar-ordenar.js'), 'utf8');
  /* A CHAMADA, não o nome: guardar a função de desligar e nunca invocá-la
     deixa o arquivo cheio de `__desligarArrasto` e o vazamento intacto — foi
     assim que a sabotagem de 16/09 passou por este caso. */
  assert(/__desligarArrasto\s*\(\s*\)/.test(src),
    'o módulo guarda a função de desligar mas nunca a chama');
  assert(/container\.__desligarArrasto\s*=/.test(src), 'o módulo não registra o desligamento');
  const corpo = src.slice(src.indexOf('function ativarArrasto'));
  const soltos = [...corpo.matchAll(/(document|container)\.addEventListener\(/g)];
  /* Os dois permitidos são os temporários do "talvez" no arrasto com mouse:
     eles se removem sozinhos no primeiro pointerup. */
  assert(soltos.length <= 2,
    `${soltos.length} ouvintes registrados fora do controle de desligamento`);
});

(async () => {
  if (!CHROME) console.log('  Chrome ausente — blocos D/E serao pulados');
  for (const [nome, fn] of fila.filter(([n]) => !FILTRO || n.startsWith(FILTRO))) {
    if (!CHROME && /^[DE]/.test(nome)) { console.log('PULA  ' + nome); continue; }
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  for (const db of abertos) { try { db.close(); } catch (_) {} }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
