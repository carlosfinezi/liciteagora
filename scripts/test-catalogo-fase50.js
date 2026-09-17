/**
 * Fase 50 — catálogo público, página de produto e carrinho.
 *
 * O que estes testes guardam, em uma frase: **o navegador não sabe quanto as
 * coisas custam**. O carrinho anônimo vive no localStorage, então todo valor
 * exibido volta de `POST /loja/api/carrinho/calcular`, que recalcula do banco e
 * recusa opção que não pertence ao produto. Metade dos casos aqui existe para
 * provar que adulterar o que está no navegador não muda um centavo.
 *
 * A outra metade é a experiência: categorias horizontais na ordem do lojista,
 * Destaques antes do resto, personalização obrigatória barrando o "+", barra
 * fixa, sugestões e alvos de toque de 44px.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f50-'));
const abertos = [];

/* PNG 1x1 real, para logo e capa: a validação é do navegador (que só precisa de
   bytes de imagem válidos), e o objetivo aqui é não gerar 404. */
fs.mkdirSync(path.join(tmp, 'uploads', 'loja'), { recursive: true });
{
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  for (const n of ['logo.png', 'capa.png']) fs.writeFileSync(path.join(tmp, 'uploads', 'loja', n), png1x1);
}

// ============================================================================
// Tenant de teste
// ============================================================================

function montar(nome, { ativa = 1, nomeLoja = 'LOJA TESTE', comPersonalizacao = true } = {}) {
  const db = new Database(path.join(tmp, nome + '.db'));
  db.pragma('foreign_keys = OFF');
  require('../db-schema').initSchema(db);
  db.pragma('foreign_keys = ON');
  require('../loja-routes').migrarLojaDB(db);
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL, caminho TEXT NOT NULL, urlOrigem TEXT, origem TEXT DEFAULT 'outra',
    autorizadoPor TEXT, autorizadoEm TEXT, largura INTEGER, altura INTEGER, bytes INTEGER,
    ordem INTEGER DEFAULT 0, dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);
  abertos.push(db);

  /* Os dois serviços vão ligados de propósito. Quando esta suíte nasceu,
     "Retirada" e "Delivery" eram botões fixos na sacola; desde a Fase 52 eles
     seguem o que o lojista habilitou, e uma loja recém-criada nasce só com
     retirada. Ligar aqui mantém a suíte medindo o que ela sempre mediu — a
     sacola — em vez de virar um teste de configuração de entrega. */
  db.prepare(`UPDATE loja_config SET ativa=?, nome=?, descricao='Bom gosto', mostrarPreco=1,
    mostrarEstoque=1, whatsapp='44999990000', instagram='@lojateste', facebook='lojateste',
    servicoRetirada=1, servicoDelivery=1,
    bannerPath='/uploads/loja/capa.png', logoPath='/uploads/loja/logo.png' WHERE id=1`)
    .run(ativa, nomeLoja);

  const ins = db.prepare(`INSERT INTO produtos (sku, descricao, categoria, unidade, precoVenda,
      precoCusto, markupVenda, observacoes, marca, ativo, publicadoNaLoja, destaqueNaLoja, ordemVitrine)
    VALUES (?,?,?,'UN',?,?,?,?,?,1,?,?,?)`);
  // 1 CESTA SIMPLES  · destaque · marca lixo "(todas)"
  ins.run('S1', 'CESTA SIMPLES', 'CESTAS', 100, 30, 1.5, 'Uma cesta simples.', '(todas)', 1, 1, 2);
  // 2 CESTA COM RECADO · personalização obrigatória
  ins.run('S2', 'CESTA COM RECADO', 'CESTAS', 150, 40, 1.5,
    'Descrição bem longa. '.repeat(30), 'BOM GOSTO', 1, 0, 1);
  // 3 CAFE ESPECIAL · outra categoria
  ins.run('S3', 'CAFE ESPECIAL', 'BEBIDAS', 40, 12, 1.5, null, null, 1, 0, 0);
  // 4 OCULTO · NÃO publicado
  ins.run('S4', 'SEGREDO INDUSTRIAL', 'CESTAS', 999, 500, 2, null, null, 0, 0, 0);
  // 5 CARTAO PERSONALIZADO · texto OBRIGATÓRIO (produto próprio, para não
  //   transformar o produto 1 — o "simples" de vários casos — em personalizável)
  ins.run('S5', 'CARTAO PERSONALIZADO', 'BEBIDAS', 20, 5, 1.5, null, null, 1, 0, 0);

  // Ordem invertendo a alfabética, para provar que a configuração manda.
  db.prepare('INSERT INTO loja_categoria_ordem (categoria, ordem) VALUES (?,?)').run('CESTAS', 1);
  db.prepare('INSERT INTO loja_categoria_ordem (categoria, ordem) VALUES (?,?)').run('BEBIDAS', 2);

  if (comPersonalizacao) {
    const g = db.prepare(`INSERT INTO rest_grupos_opcao (nome, descricao, minEscolhas, maxEscolhas,
      ordem, ativo, tipo) VALUES ('Recadinho', 'Deseja incluir um recadinho?', 1, 1, 1, 1, 'escolha')`)
      .run().lastInsertRowid;
    db.prepare('INSERT INTO rest_opcoes (grupoId, nome, precoAdicional, ordem, ativo) VALUES (?,?,?,?,1)')
      .run(g, 'Desejo incluir um recadinho', 5, 1);
    db.prepare('INSERT INTO rest_opcoes (grupoId, nome, precoAdicional, ordem, ativo) VALUES (?,?,?,?,1)')
      .run(g, 'Prefiro que seja anônimo', 0, 2);
    db.prepare('INSERT INTO rest_produto_grupos (produtoId, grupoId, ordem) VALUES (2, ?, 1)').run(g);

    // Grupo OPCIONAL de texto, no produto 3.
    const gt = db.prepare(`INSERT INTO rest_grupos_opcao (nome, descricao, minEscolhas, maxEscolhas,
      ordem, ativo, tipo) VALUES ('Nome no rótulo', 'Quer um rótulo personalizado?', 0, 1, 1, 1, 'texto')`)
      .run().lastInsertRowid;
    db.prepare('INSERT INTO rest_produto_grupos (produtoId, grupoId, ordem) VALUES (3, ?, 1)').run(gt);

    // Texto OBRIGATÓRIO, no produto 1. Sem um caso assim, remover a exigência
    // de texto não reprovava nada — foi o que a sabotagem mostrou.
    const gto = db.prepare(`INSERT INTO rest_grupos_opcao (nome, descricao, minEscolhas, maxEscolhas,
      ordem, ativo, tipo) VALUES ('Mensagem do cartão', 'O que escrevemos?', 1, 1, 2, 1, 'texto')`)
      .run().lastInsertRowid;
    db.prepare('INSERT INTO rest_produto_grupos (produtoId, grupoId, ordem) VALUES (5, ?, 1)').run(gto);

    // Opção de OUTRO produto, para o teste de pertencimento.
    const gx = db.prepare(`INSERT INTO rest_grupos_opcao (nome, minEscolhas, maxEscolhas, ordem, ativo)
      VALUES ('Grupo alheio', 0, 1, 1, 1)`).run().lastInsertRowid;
    db.prepare('INSERT INTO rest_opcoes (grupoId, nome, precoAdicional, ordem, ativo) VALUES (?,?,?,?,1)')
      .run(gx, 'Opção de outro produto', 999, 1);
  }
  return db;
}

function subir(tenants) {
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
  require('../loja-routes').registrarRotasLojaPublica(app, proxy);
  app.use('/loja', express.static(path.join(PUB, 'loja')));
  /* `/uploads` sai de um diretório TEMPORÁRIO, não de `public/uploads`.
     O harness configura logo e capa no banco; sem servi-los, o navegador pede
     os dois e leva 404 — que o teste B10 leria como erro da loja. Servir a
     partir de /tmp mantém `public/uploads` intocado. */
  app.use('/uploads', express.static(path.join(tmp, 'uploads')));
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

const opcaoDe = (db, nome) => db.prepare('SELECT id FROM rest_opcoes WHERE nome = ?').get(nome).id;

// ============================================================================
// A. Servidor — preço, opções, isolamento
// ============================================================================

t('A1. o payload traz destaque, marca limpa e flag de personalização', async () => {
  const A = { slug: 'a', db: montar('a1') };
  const srv = await subir([A]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/produtos');
    const s1 = r.body.produtos.find((p) => p.sku === 'S1');
    const s2 = r.body.produtos.find((p) => p.sku === 'S2');
    assert(s1.destaque === true, 'o destaque não veio');
    assert(s1.marca === null, 'a marca "(todas)" foi ao ar: ' + s1.marca);
    assert(s2.temPersonalizacao === true, 'o produto com grupo obrigatório não avisa que tem personalização');
    assert(s1.temPersonalizacao === false, 'produto sem grupo apareceu como personalizável');
  } finally { srv.close(); }
});

t('A2. categorias e produtos saem na ordem configurada no Catálogo Online', async () => {
  const A = { slug: 'a', db: montar('a2') };
  const srv = await subir([A]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/produtos');
    assert(r.body.categorias[0] === 'CESTAS',
      'ordem das categorias ignorada: ' + JSON.stringify(r.body.categorias));
    const cestas = r.body.produtos.filter((p) => p.categoria === 'CESTAS').map((p) => p.sku);
    // ordemVitrine: S2 = 1, S1 = 2
    assert(cestas[0] === 'S2', 'ordem dos produtos ignorada: ' + cestas.join(','));
  } finally { srv.close(); }
});

t('A3. produto NÃO publicado não aparece em lista, detalhe, busca nem sugestão', async () => {
  const A = { slug: 'a', db: montar('a3') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const lista = await pedir(porta, '/loja/api/produtos');
    assert(!/SEGREDO/.test(lista.cru), 'o não publicado apareceu na lista');
    const det = await pedir(porta, '/loja/api/produtos/4');
    assert(det.status === 404, 'o detalhe do não publicado respondeu ' + det.status);
    const busca = await pedir(porta, '/loja/api/produtos?q=SEGREDO');
    assert(busca.body.produtos.length === 0, 'a busca revelou o não publicado');
    const sug = await pedir(porta, '/loja/api/sugestoes');
    assert(!/SEGREDO/.test(sug.cru), 'a sugestão ofereceu o não publicado');
  } finally { srv.close(); }
});

t('A4. o detalhe traz as personalizações do produto', async () => {
  const A = { slug: 'a', db: montar('a4') };
  const srv = await subir([A]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/produtos/2');
    const g = r.body.produto.personalizacoes;
    assert(g.length === 1, 'esperava 1 grupo, veio ' + g.length);
    assert(g[0].obrigatorio === true, 'o grupo obrigatório não veio marcado');
    assert(g[0].opcoes.length === 2, 'faltaram opções');
    assert(g[0].opcoes[0].precoAdicional === 5, 'o adicional não veio');
    assert(g[0].descricao === 'Deseja incluir um recadinho?', 'a pergunta do grupo não veio');
  } finally { srv.close(); }
});

t('A5. o cálculo soma adicional × quantidade, e o SERVIDOR é quem diz o preço', async () => {
  const A = { slug: 'a', db: montar('a5') };
  const srv = await subir([A]);
  try {
    const recado = opcaoDe(A.db, 'Desejo incluir um recadinho');
    const r = await pedir(srv.address().port, '/loja/api/carrinho/calcular', { metodo: 'POST',
      corpo: { itens: [{ produtoId: 2, quantidade: 3, opcoes: [recado] }] } });
    const i = r.body.itens[0];
    assert(i.precoBase === 150, 'preço base errado: ' + i.precoBase);
    assert(i.adicional === 5, 'adicional errado: ' + i.adicional);
    assert(i.precoUnitario === 155, 'unitário errado: ' + i.precoUnitario);
    assert(i.total === 465, 'total errado (155 x 3): ' + i.total);
    assert(r.body.total === 465 && r.body.quantidadeItens === 3, 'resumo errado: ' + JSON.stringify(r.body));
  } finally { srv.close(); }
});

t('A6. preço e adicional mandados pelo cliente são IGNORADOS', async () => {
  const A = { slug: 'a', db: montar('a6') };
  const srv = await subir([A]);
  try {
    const recado = opcaoDe(A.db, 'Desejo incluir um recadinho');
    const r = await pedir(srv.address().port, '/loja/api/carrinho/calcular', { metodo: 'POST',
      corpo: { itens: [{ produtoId: 2, quantidade: 1, opcoes: [recado],
        preco: 0.01, precoUnitario: 0.01, total: 0.01, adicional: -100 }] } });
    const i = r.body.itens[0];
    assert(i.precoUnitario === 155 && i.total === 155,
      'o preço do navegador venceu o do servidor: ' + JSON.stringify(i));
    assert(r.body.total === 155, 'o total veio do cliente: ' + r.body.total);
  } finally { srv.close(); }
});

t('A7. opção que não pertence ao produto é RECUSADA', async () => {
  const A = { slug: 'a', db: montar('a7') };
  const srv = await subir([A]);
  try {
    const alheia = opcaoDe(A.db, 'Opção de outro produto');   // adicional de 999
    const r = await pedir(srv.address().port, '/loja/api/carrinho/calcular', { metodo: 'POST',
      corpo: { itens: [{ produtoId: 2, quantidade: 1, opcoes: [alheia] }] } });
    assert(r.status === 422, 'aceitou opção de outro produto: ' + r.status);
    assert(/inválida/i.test(r.body.error), 'recusou pela razão errada: ' + r.body.error);
  } finally { srv.close(); }
});

t('A8. grupo obrigatório sem escolha é recusado; opcional passa', async () => {
  const A = { slug: 'a', db: montar('a8') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const semEscolha = await pedir(porta, '/loja/api/carrinho/calcular', { metodo: 'POST',
      corpo: { itens: [{ produtoId: 2, quantidade: 1, opcoes: [] }] } });
    assert(semEscolha.status === 422, 'aceitou item sem o grupo obrigatório: ' + semEscolha.status);
    assert(/Recadinho/.test(semEscolha.body.error), 'a mensagem não diz qual grupo: ' + semEscolha.body.error);

    // O produto 3 tem grupo de TEXTO opcional: passa sem preencher.
    const opcional = await pedir(porta, '/loja/api/carrinho/calcular', { metodo: 'POST',
      corpo: { itens: [{ produtoId: 3, quantidade: 1, opcoes: [] }] } });
    assert(opcional.status === 200 && opcional.body.itens.length === 1,
      'o grupo opcional barrou o item: ' + JSON.stringify(opcional.body));
  } finally { srv.close(); }
});

t('A8b. grupo de TEXTO obrigatório sem preenchimento é recusado', async () => {
  const A = { slug: 'a', db: montar('a8b') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const vazio = await pedir(porta, '/loja/api/carrinho/calcular', { metodo: 'POST',
      corpo: { itens: [{ produtoId: 5, quantidade: 1, opcoes: [], textos: {} }] } });
    assert(vazio.status === 422, 'aceitou item sem o texto obrigatório: ' + vazio.status);
    assert(/Mensagem do cartão/.test(vazio.body.error), 'não disse qual campo falta: ' + vazio.body.error);

    // Só espaços não contam como preenchido.
    const g = A.db.prepare("SELECT id FROM rest_grupos_opcao WHERE nome='Mensagem do cartão'").get().id;
    const brancos = await pedir(porta, '/loja/api/carrinho/calcular', { metodo: 'POST',
      corpo: { itens: [{ produtoId: 5, quantidade: 1, opcoes: [], textos: { [g]: '   ' } }] } });
    assert(brancos.status === 422, 'espaços em branco passaram como texto preenchido');

    const ok2 = await pedir(porta, '/loja/api/carrinho/calcular', { metodo: 'POST',
      corpo: { itens: [{ produtoId: 5, quantidade: 1, opcoes: [], textos: { [g]: 'Feliz aniversário' } }] } });
    assert(ok2.status === 200 && ok2.body.itens[0].textos[g] === 'Feliz aniversário',
      'o texto preenchido não passou: ' + JSON.stringify(ok2.body));
  } finally { srv.close(); }
});

t('A9. texto livre e comentário voltam saneados e limitados', async () => {
  const A = { slug: 'a', db: montar('a9') };
  const srv = await subir([A]);
  try {
    const grupoTexto = A.db.prepare("SELECT id FROM rest_grupos_opcao WHERE tipo='texto'").get().id;
    const r = await pedir(srv.address().port, '/loja/api/carrinho/calcular', { metodo: 'POST',
      corpo: { itens: [{ produtoId: 3, quantidade: 1, opcoes: [],
        textos: { [grupoTexto]: '  Para a Maria  ' }, comentario: 'x'.repeat(500) }] } });
    const i = r.body.itens[0];
    assert(i.textos[grupoTexto] === 'Para a Maria', 'o texto não foi aparado: ' + JSON.stringify(i.textos));
    assert(i.comentario.length === 300, 'o comentário não foi limitado: ' + i.comentario.length);
  } finally { srv.close(); }
});

t('A10. item de produto despublicado some da sacola sem derrubar o resto', async () => {
  const A = { slug: 'a', db: montar('a10') };
  const srv = await subir([A]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/carrinho/calcular', { metodo: 'POST',
      corpo: { itens: [{ produtoId: 4, quantidade: 1 }, { produtoId: 1, quantidade: 2 }] } });
    assert(r.status === 200, 'a sacola inteira caiu por causa de um item: ' + r.status);
    assert(r.body.itens.length === 1 && r.body.itens[0].produtoId === 1,
      'o item despublicado não foi descartado: ' + JSON.stringify(r.body.itens.map((i) => i.produtoId)));
    assert(r.body.total === 200, 'o total não recalculou sem o descartado: ' + r.body.total);
  } finally { srv.close(); }
});

t('A11. o payload NUNCA traz custo, markup ou preço mínimo', async () => {
  const A = { slug: 'a', db: montar('a11') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const rotas = ['/loja/api/produtos', '/loja/api/produtos/1', '/loja/api/sugestoes'];
    for (const rota of rotas) {
      const r = await pedir(porta, rota);
      for (const proibido of ['precoCusto', 'markupVenda', 'precoMinimoVenda', 'markupMinimo']) {
        assert(!new RegExp(proibido).test(r.cru), `${rota} expõe ${proibido}`);
      }
    }
    const calc = await pedir(porta, '/loja/api/carrinho/calcular', { metodo: 'POST',
      corpo: { itens: [{ produtoId: 1, quantidade: 1 }] } });
    for (const proibido of ['precoCusto', 'markupVenda', 'markupMinimo']) {
      assert(!new RegExp(proibido).test(calc.cru), 'o cálculo expõe ' + proibido);
    }
  } finally { srv.close(); }
});

t('A12. tenant A não recebe nada do tenant B, nem por id direto', async () => {
  const A = { slug: 'a', db: montar('a12a', { nomeLoja: 'LOJA A' }) };
  const B = { slug: 'b', db: montar('a12b', { nomeLoja: 'LOJA B' }) };
  B.db.prepare("UPDATE produtos SET descricao = 'EXCLUSIVO DO B' WHERE id = 1").run();
  const srv = await subir([A, B]);
  const porta = srv.address().port;
  try {
    const ra = await pedir(porta, '/loja/api/produtos', { slug: 'a' });
    assert(!/EXCLUSIVO DO B/.test(ra.cru), 'o tenant A recebeu produto do B');
    const det = await pedir(porta, '/loja/api/produtos/1', { slug: 'a' });
    assert(!/EXCLUSIVO DO B/.test(det.cru), 'leitura cruzada por id vazou do B para o A');
    const calc = await pedir(porta, '/loja/api/carrinho/calcular', { metodo: 'POST', slug: 'a',
      corpo: { itens: [{ produtoId: 1, quantidade: 1 }] } });
    assert(!/EXCLUSIVO DO B/.test(calc.cru), 'o cálculo do A trouxe produto do B');
    const ca = await pedir(porta, '/loja/api/config', { slug: 'a' });
    const cb = await pedir(porta, '/loja/api/config', { slug: 'b' });
    assert(ca.body.loja.nome === 'LOJA A' && cb.body.loja.nome === 'LOJA B', 'identidade cruzada');
  } finally { srv.close(); }
});

t('A13. catálogo despublicado recusa TODAS as rotas públicas', async () => {
  const A = { slug: 'a', db: montar('a13', { ativa: 0 }) };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    for (const [rota, opt] of [['/loja/api/config', {}], ['/loja/api/produtos', {}],
      ['/loja/api/produtos/1', {}], ['/loja/api/sugestoes', {}],
      ['/loja/api/carrinho/calcular', { metodo: 'POST', corpo: { itens: [] } }]]) {
      const r = await pedir(porta, rota, opt);
      assert(r.status === 404, `${rota} respondeu ${r.status} com a loja despublicada`);
    }
  } finally { srv.close(); }
});

t('A14. sugestões não repetem o que já está na sacola e priorizam destaque', async () => {
  const A = { slug: 'a', db: montar('a14') };
  const srv = await subir([A]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/sugestoes?excluir=2&categorias=CESTAS');
    const ids = r.body.produtos.map((p) => p.id);
    assert(!ids.includes(2), 'sugeriu o que já está na sacola');
    assert(!ids.includes(4), 'sugeriu produto não publicado');
    assert(ids[0] === 1, 'o destaque não veio primeiro: ' + ids.join(','));
  } finally { srv.close(); }
});

t('A15. nenhuma rota pública exige login', async () => {
  const A = { slug: 'a', db: montar('a15') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    for (const [rota, opt] of [['/loja/api/config', {}], ['/loja/api/produtos', {}],
      ['/loja/api/produtos/1', {}], ['/loja/api/sugestoes', {}],
      ['/loja/api/carrinho/calcular', { metodo: 'POST', corpo: { itens: [{ produtoId: 1, quantidade: 1 }] } }]]) {
      const r = await pedir(porta, rota, opt);
      assert(r.status === 200, `${rota} respondeu ${r.status} para visitante anônimo`);
    }
  } finally { srv.close(); }
});

t('A16. a página não reintroduz login nem envia credencial', async () => {
  const html = fs.readFileSync(path.join(PUB, 'loja/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(PUB, 'loja/catalogo.js'), 'utf8');
  const junto = (html + js).replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const proibido of ['btnEntrar', 'modalLogin', '/portal/api/login', '/loja/api/eu',
                          'X-Api-Key', 'Authorization']) {
    assert(!junto.includes(proibido), `a loja pública voltou a ter "${proibido}"`);
  }
});

// ============================================================================
// B. Navegador
// ============================================================================

async function comNavegador(tenants, largura, fn) {
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
    await espera(1500);
    return await fn(page, { erros, respostas, espera });
  } finally { await browser.close(); srv.close(); }
}

t('B1. home: categorias horizontais roláveis, Destaques primeiro', async () => {
  const A = { slug: 'a', db: montar('b1') };
  await comNavegador([A], 1280, async (page, ctx) => {
    const r = await page.evaluate(() => {
      const nav = document.getElementById('navCats');
      const cs = getComputedStyle(nav);
      return {
        botoes: [...nav.querySelectorAll('button')].map((b) => b.textContent),
        rolavel: cs.overflowX === 'auto' || cs.overflowX === 'scroll',
        ehSelect: !!document.querySelector('#cabecalhoBusca select'),
        secoes: [...document.querySelectorAll('.secao h2')].map((h) => h.textContent),
        alturaBotao: Math.round(nav.querySelector('button').getBoundingClientRect().height),
      };
    });
    assert(r.botoes[0] === 'Destaques', 'Destaques não é o primeiro: ' + r.botoes.join(','));
    assert(r.botoes[1] === 'CESTAS', 'a ordem do lojista não valeu: ' + r.botoes.join(','));
    assert(r.rolavel, 'a faixa de categorias não é rolável');
    assert(!r.ehSelect, 'as categorias voltaram a ser um <select>');
    assert(r.secoes[0] === 'Destaques', 'a seção Destaques não vem primeiro: ' + r.secoes.join(','));
    assert(r.alturaBotao >= 44, `botão de categoria com ${r.alturaBotao}px — abaixo de 44`);
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('B2. sem destaque, a seção Destaques não existe', async () => {
  const A = { slug: 'a', db: montar('b2') };
  A.db.prepare('UPDATE produtos SET destaqueNaLoja = 0').run();
  await comNavegador([A], 1280, async (page) => {
    const r = await page.evaluate(() => ({
      botoes: [...document.querySelectorAll('#navCats button')].map((b) => b.textContent),
      secoes: [...document.querySelectorAll('.secao h2')].map((h) => h.textContent),
    }));
    assert(!r.botoes.includes('Destaques'), 'sobrou o botão Destaques sem destaque nenhum');
    assert(!r.secoes.includes('Destaques'), 'sobrou a seção Destaques vazia');
  });
});

t('B3. o "+" adiciona direto; com personalização obrigatória, abre o produto', async () => {
  const A = { slug: 'a', db: montar('b3') };
  await comNavegador([A], 1280, async (page, ctx) => {
    // S1 não tem personalização: some direto para a sacola.
    await page.evaluate(() => document.querySelector('[data-mais="1"]').click());
    await ctx.espera(1200);
    const barra = await page.evaluate(() => ({
      visivel: !document.getElementById('barra').hidden,
      qtd: document.getElementById('barraQtd').textContent,
      total: document.getElementById('barraTotal').textContent,
      hash: location.hash,
    }));
    assert(barra.visivel, 'a barra fixa não apareceu');
    assert(/1 produto/.test(barra.qtd), 'contagem errada: ' + barra.qtd);
    assert(/100,00/.test(barra.total), 'total errado: ' + barra.total);
    assert(barra.hash !== '#/p/1', 'abriu o produto sem precisar');

    // S2 tem grupo obrigatório: o "+" tem de levar ao produto.
    await page.evaluate(() => document.querySelector('[data-mais="2"]').click());
    await ctx.espera(1200);
    assert(await page.evaluate(() => location.hash) === '#/p/2',
      'o "+" adicionou sem perguntar a personalização obrigatória');
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('B4. produto: quantidade, adicional e botão refletem a escolha', async () => {
  const A = { slug: 'a', db: montar('b4') };
  await comNavegador([A], 1280, async (page, ctx) => {
    await page.evaluate(() => { location.hash = '#/p/2'; });
    await ctx.espera(1200);
    const inicial = await page.evaluate(() => document.getElementById('btAdicionar').textContent);
    assert(/150,00/.test(inicial), 'botão inicial errado: ' + inicial);

    await page.evaluate(() => {
      const i = document.querySelector('.opcao input');
      i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert(/155,00/.test(await page.evaluate(() => document.getElementById('btAdicionar').textContent)),
      'o adicional de R$ 5 não entrou no botão');

    await page.evaluate(() => document.querySelector('[data-q="1"]').click());
    const doisItens = await page.evaluate(() => ({
      qtd: document.getElementById('qtd').textContent,
      bt: document.getElementById('btAdicionar').textContent }));
    assert(doisItens.qtd === '2', 'quantidade não subiu: ' + doisItens.qtd);
    assert(/310,00/.test(doisItens.bt), '(150+5) x 2 não deu 310: ' + doisItens.bt);
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('B5. adicionar sem o obrigatório mostra o motivo e NÃO entra na sacola', async () => {
  const A = { slug: 'a', db: montar('b5') };
  await comNavegador([A], 1280, async (page, ctx) => {
    await page.evaluate(() => { location.hash = '#/p/2'; });
    await ctx.espera(1200);
    await page.evaluate(() => document.getElementById('btAdicionar').click());
    await ctx.espera(1200);
    const r = await page.evaluate(() => ({
      erro: (() => { const e = document.getElementById('erroProduto'); return e && !e.hidden ? e.textContent : null; })(),
      barra: !document.getElementById('barra').hidden,
      guardado: localStorage.getItem('loja-carrinho-v2'),
    }));
    assert(r.erro && /Recadinho/.test(r.erro), 'não explicou o que falta: ' + r.erro);
    assert(!r.barra, 'a barra apareceu mesmo com o item recusado');
    assert(!r.guardado || JSON.parse(r.guardado).length === 0, 'o item recusado foi guardado');
  });
});

t('B6. sacola: item, opção, quantidade, remoção e sugestões', async () => {
  const A = { slug: 'a', db: montar('b6') };
  await comNavegador([A], 1280, async (page, ctx) => {
    await page.evaluate(() => document.querySelector('[data-mais="1"]').click());
    await ctx.espera(1200);
    await page.evaluate(() => document.getElementById('barraVer').click());
    await ctx.espera(1500);

    let s = await page.evaluate(() => ({
      titulo: (document.querySelector('.sacola-topo h1') || {}).textContent,
      total: (document.querySelector('.sacola-topo strong') || {}).textContent,
      itens: document.querySelectorAll('.item-sacola').length,
      sugestoes: document.querySelectorAll('.sug').length,
      servicos: [...document.querySelectorAll('.servico-bt')].map((b) => b.textContent),
      barraEscondida: document.getElementById('barra').hidden,
    }));
    assert(s.titulo === 'Sua sacola', 'título errado: ' + s.titulo);
    assert(s.itens === 1 && /100,00/.test(s.total), 'sacola errada: ' + JSON.stringify(s));
    assert(s.sugestoes > 0, 'nenhuma sugestão em "Complete seu pedido"');
    assert(s.servicos.join(',') === 'Retirada,Delivery', 'faltam os botões de serviço: ' + s.servicos);
    assert(s.barraEscondida, 'a barra fixa ficou sobre a própria sacola');

    await page.evaluate(() => document.querySelector('[data-mais-item="0"]').click());
    await ctx.espera(1400);
    s = await page.evaluate(() => ({ total: document.querySelector('.sacola-topo strong').textContent }));
    assert(/200,00/.test(s.total), 'aumentar a quantidade não recalculou: ' + s.total);

    await page.evaluate(() => document.querySelector('[data-remover="0"]').click());
    await ctx.espera(1400);
    const vazia = await page.evaluate(() => document.getElementById('conteudo').innerText);
    assert(/vazia/i.test(vazia), 'remover não esvaziou a sacola: ' + vazia.slice(0, 120));
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('B7. o preço adulterado no localStorage não vira dinheiro', async () => {
  const A = { slug: 'a', db: montar('b7') };
  await comNavegador([A], 1280, async (page, ctx) => {
    await page.evaluate(() => {
      localStorage.setItem('loja-carrinho-v2', JSON.stringify([
        { produtoId: 1, quantidade: 1, preco: 0.01, total: 0.01, opcoes: [], textos: {}, comentario: null },
      ]));
    });
    await page.reload({ waitUntil: 'networkidle2' });
    await ctx.espera(1800);
    const r = await page.evaluate(() => ({
      total: document.getElementById('barraTotal').textContent,
    }));
    assert(/100,00/.test(r.total), 'o preço do navegador venceu: ' + r.total);
  });
});

t('B8. adicional adulterado no localStorage não é aceito', async () => {
  const A = { slug: 'a', db: montar('b8') };
  const idAlheia = opcaoDe(A.db, 'Opção de outro produto');
  await comNavegador([A], 1280, async (page, ctx) => {
    await page.evaluate((op) => {
      localStorage.setItem('loja-carrinho-v2', JSON.stringify([
        { produtoId: 2, quantidade: 1, opcoes: [op], textos: {}, comentario: null },
      ]));
    }, idAlheia);
    await page.reload({ waitUntil: 'networkidle2' });
    await ctx.espera(1800);
    // O servidor recusa o item inteiro (422): a sacola não pode exibir R$ 999 a mais.
    const total = await page.evaluate(() => document.getElementById('barraTotal').textContent);
    assert(!/999/.test(total), 'o adicional de outro produto entrou na conta: ' + total);
  });
});

for (const largura of [320, 375, 390, 430, 768]) {
  t(`B9-${largura}. responsivo em ${largura}px: alvos, fontes e barra`, async () => {
    const A = { slug: 'a', db: montar('b9' + largura) };
    await comNavegador([A], largura, async (page, ctx) => {
      await page.evaluate(() => document.querySelector('[data-mais="1"]').click());
      await ctx.espera(1300);
      const r = await page.evaluate(() => {
        const cx = (s) => { const e = document.querySelector(s); if (!e) return null;
          const b = e.getBoundingClientRect();
          return { w: Math.round(b.width), h: Math.round(b.height),
                   dentro: b.left >= -1 && b.right <= window.innerWidth + 1 }; };
        const busca = document.getElementById('busca');
        const imgs = [...document.querySelectorAll('.card-foto img')].map((i) => {
          const s = getComputedStyle(i); return s.objectFit;
        });
        return {
          busca: cx('#busca'), fonteBusca: getComputedStyle(busca).fontSize,
          catBt: cx('#navCats button'), mais: cx('.mais'),
          barra: cx('.barra'), ver: cx('#barraVer'),
          objectFit: [...new Set(imgs)],
          rolaHorizontal: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      assert(parseFloat(r.fonteBusca) >= 16, `campo de busca com ${r.fonteBusca} — o iOS daria zoom`);
      assert(r.catBt.h >= 44, `categoria com ${r.catBt.h}px de altura`);
      assert(r.mais.w >= 44 && r.mais.h >= 44, `o "+" mede ${r.mais.w}x${r.mais.h}px`);
      assert(r.ver.h >= 44, `"Ver meu pedido" com ${r.ver.h}px`);
      assert(r.barra.dentro, 'a barra fixa vaza da tela');
      assert(!r.rolaHorizontal, 'a página rola na horizontal — algo estourou a largura');
      assert(r.objectFit.every((f) => f === 'contain' || f === 'cover'),
        'imagem sem object-fit: distorce: ' + r.objectFit.join(','));
      assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
    });
  });
}

t('B10. navegação inteira sem login e sem 401/403', async () => {
  const A = { slug: 'a', db: montar('b10') };
  await comNavegador([A], 390, async (page, ctx) => {
    await page.evaluate(() => document.querySelector('[data-mais="1"]').click());
    await ctx.espera(1000);
    await page.evaluate(() => { location.hash = '#/p/3'; });
    await ctx.espera(1000);
    await page.evaluate(() => { location.hash = '#/sacola'; });
    await ctx.espera(1400);
    const ruins = ctx.respostas.filter((r) => r.s === 401 || r.s === 403);
    assert(ruins.length === 0, 'requests 401/403: ' + JSON.stringify(ruins));
    const quatroQuatro = ctx.respostas.filter((r) => r.s === 404);
    assert(quatroQuatro.length === 0, '404 inesperado: ' + JSON.stringify(quatroQuatro));
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('B11. "Ler mais" aparece só em descrição longa e abre o texto', async () => {
  const A = { slug: 'a', db: montar('b11') };
  await comNavegador([A], 1280, async (page, ctx) => {
    await page.evaluate(() => { location.hash = '#/p/2'; });   // descrição longa
    await ctx.espera(1200);
    const longa = await page.evaluate(() => {
      const b = document.getElementById('btLer');
      if (!b) return null;
      const antes = document.getElementById('desc').classList.contains('cortada');
      b.click();
      return { existe: true, antes, depois: document.getElementById('desc').classList.contains('cortada') };
    });
    assert(longa && longa.existe, 'faltou "Ler mais" numa descrição longa');
    assert(longa.antes && !longa.depois, '"Ler mais" não expandiu o texto');

    await page.evaluate(() => { location.hash = '#/p/1'; });   // descrição curta
    await ctx.espera(1200);
    assert(await page.evaluate(() => !document.getElementById('btLer')),
      '"Ler mais" apareceu numa descrição curta');
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
