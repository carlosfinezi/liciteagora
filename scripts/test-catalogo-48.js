/**
 * Fase 48 — cabeçalho editável, ordenação exclusiva da vitrine e menu de
 * configurações do Catálogo Online.
 *
 * Três blocos, e a ordem deles é a das lições caras:
 *
 *   A. MIGRATION pelo caminho REAL. Chama `initSchema` e SÓ ele — nunca
 *      `migrarLojaDB`. Foi exatamente o contrário disso que deixou a Fase 46
 *      com 18 testes verdes e `destaqueNaLoja` em 0 dos 19 tenants: o harness
 *      chamava a migration das rotas, que em produção é no-op.
 *   B. ORDEM no servidor, contra SQLite de verdade: grava, relê, confere.
 *   C. UX no Chrome: clicar, digitar, arrastar posição. Elemento existir no DOM
 *      não prova que funciona (relatório 42).
 *
 * E o bloco D vigia o que o pedido PROIBIU: a ordem da vitrine não pode vazar
 * para o resto do ERP.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat48-'));
const bancos = [];
/* Roda a migration como o boot roda: FK desligada durante o initSchema.
   É o que `tenant-manager.js` faz no primeiro open de cada tenant — há seeds
   que inserem antes das FKs existirem, e com FK ligada o initSchema aborta. */
function migrar(db) {
  db.pragma('foreign_keys = OFF');
  require('../db-schema').initSchema(db);
  db.pragma('foreign_keys = ON');
}

function bancoNovo(nome) {
  const db = new Database(path.join(tmp, nome + '.db'));
  migrar(db);
  bancos.push(db);
  return db;
}

// ============================================================================
// A. Migration — pelo caminho que alcança tenant que já existe
// ============================================================================

t('A1. initSchema sozinho cria bannerPath, ordemVitrine e loja_categoria_ordem', async () => {
  const db = bancoNovo('a1');
  const tem = (tab, col) =>
    db.prepare(`SELECT COUNT(*) n FROM pragma_table_info(?) WHERE name = ?`).get(tab, col).n === 1;

  assert(tem('produtos', 'ordemVitrine'), 'produtos.ordemVitrine não foi criada por initSchema');
  assert(db.prepare(`SELECT COUNT(*) n FROM sqlite_master
    WHERE type='table' AND name='loja_categoria_ordem'`).get().n === 1,
    'loja_categoria_ordem não foi criada por initSchema');

  /* `loja_config` NÃO nasce no db-schema — nasce em `migrarLojaDB`. Este teste
     reproduz o tenant que já a tem (18 dos 19) e exige que o ALTER a alcance. */
  assert(!tem('loja_config', 'bannerPath'),
    'loja_config existe no db-schema? a premissa do par de ALTERs mudou — reveja');
});

t('A2. tenant que JÁ TEM loja_config recebe bannerPath no boot seguinte', async () => {
  const db = bancoNovo('a2');
  // O estado real dos 18 tenants: a tabela existe, sem a coluna nova.
  db.exec(`CREATE TABLE IF NOT EXISTS loja_config (
    id INTEGER PRIMARY KEY CHECK (id = 1), ativa INTEGER NOT NULL DEFAULT 0,
    nome TEXT, descricao TEXT, logoPath TEXT, tema TEXT);`);
  db.prepare('INSERT OR IGNORE INTO loja_config (id, ativa) VALUES (1, 0)').run();
  assert(db.prepare("SELECT COUNT(*) n FROM pragma_table_info('loja_config') WHERE name='bannerPath'").get().n === 0,
    'a coluna já existia antes do boot — teste inválido');

  migrar(db);                                    // o boot seguinte, e só ele

  assert(db.prepare("SELECT COUNT(*) n FROM pragma_table_info('loja_config') WHERE name='bannerPath'").get().n === 1,
    'bannerPath NÃO chegou ao tenant existente — é o defeito da Fase 46 de novo');
  // Aditiva: a linha que já existia continua lá, intacta.
  assert(db.prepare('SELECT COUNT(*) n FROM loja_config').get().n === 1, 'a migration perdeu a configuração existente');
});

t('A3. tenant SEM loja_config é alcançado por migrarLojaDB (o caso crsolucoes)', async () => {
  const db = bancoNovo('a3');
  assert(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='loja_config'").get().n === 0,
    'loja_config não deveria existir aqui');
  require('../loja-routes').migrarLojaDB(db);
  assert(db.prepare("SELECT COUNT(*) n FROM pragma_table_info('loja_config') WHERE name='bannerPath'").get().n === 1,
    'a tabela nasceu sem bannerPath — o par do ALTER em migrarLojaDB está faltando');
});

t('A4. idempotente: rodar initSchema três vezes não duplica nem apaga', async () => {
  const db = bancoNovo('a4');
  db.prepare("INSERT INTO produtos (sku, descricao, ativo, ordemVitrine) VALUES ('SX', 'X', 1, 7)").run();
  db.prepare("INSERT INTO loja_categoria_ordem (categoria, ordem) VALUES ('CESTAS', 3)").run();
  migrar(db);
  migrar(db);
  assert(db.prepare('SELECT ordemVitrine o FROM produtos WHERE descricao = ?').get('X').o === 7,
    'a ordem do produto foi zerada por uma segunda passada da migration');
  assert(db.prepare('SELECT ordem o FROM loja_categoria_ordem WHERE categoria = ?').get('CESTAS').o === 3,
    'a ordem da categoria foi perdida por uma segunda passada da migration');
});

// ============================================================================
// B. Ordem no servidor — grava, relê, confere
// ============================================================================

/* Monta o app admin de verdade sobre um banco de verdade. Sem express: o que
   interessa é o corpo dos handlers, e um coletor de rotas os alcança sem subir
   servidor nem autenticação. */
function appFalso() {
  const rotas = new Map();
  const reg = (m) => (url, ...fns) => rotas.set(m + ' ' + url, fns[fns.length - 1]);
  return {
    get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'),
    use() {},
    chamar(m, url, body) {
      const fn = rotas.get(m + ' ' + url);
      if (!fn) throw new Error('rota não registrada: ' + m + ' ' + url);
      let saida = null, status = 200;
      const res = {
        json: (d) => { saida = d; return res; },
        status: (s) => { status = s; return res; },
        setHeader() { return res; }, end() { return res; },
      };
      fn({ body: body || {}, query: {}, params: {}, session: {},
           protocol: 'https', get: () => 'teste.local' }, res);
      return { status, body: saida };
    },
  };
}

function baseComProdutos() {
  const db = bancoNovo('b' + bancos.length);
  require('../loja-routes').migrarLojaDB(db);
  /* `produto_imagens` não nasce no db-schema — veio por script de migração em
     2026-08 e existe em todos os tenants. O catálogo a consulta; sem ela aqui,
     o teste reprovaria por falta do harness, não por defeito do código.
     Cópia fiel do schema que está nos tenants. */
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL,
    caminho TEXT NOT NULL,
    urlOrigem TEXT, origem TEXT NOT NULL DEFAULT 'outra',
    autorizadoPor TEXT, autorizadoEm TEXT,
    largura INTEGER, altura INTEGER, bytes INTEGER,
    ordem INTEGER DEFAULT 0,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE);`);
  const ins = db.prepare('INSERT INTO produtos (sku, descricao, categoria, ativo, publicadoNaLoja) VALUES (?,?,?,1,1)');
  for (const [d, c] of [['ARROZ', 'ALIMENTOS'], ['BOLO', 'DOCES'], ['CAFE', 'ALIMENTOS'],
                        ['DOCE DE LEITE', 'DOCES'], ['ERVA', 'TEMPEROS']]) ins.run('SKU-' + d.slice(0, 3), d, c);
  const app = appFalso();
  require('../loja-routes').registrarRotasLojaAdmin(app, db);
  return { db, app };
}

t('B1. ordem de categorias persiste e sai na ordem pedida', async () => {
  const { db, app } = baseComProdutos();
  const r = app.chamar('PUT', '/api/loja/ordem-categorias', { categorias: ['TEMPEROS', 'DOCES', 'ALIMENTOS'] });
  assert(r.body && r.body.success, 'a gravação falhou: ' + JSON.stringify(r.body));

  const linhas = db.prepare('SELECT categoria, ordem FROM loja_categoria_ordem ORDER BY ordem').all();
  assert(linhas.map((l) => l.categoria).join(',') === 'TEMPEROS,DOCES,ALIMENTOS',
    'gravou fora de ordem: ' + JSON.stringify(linhas));
  // Começa em 1: `0` é o valor de quem nunca foi ordenado e não pode se
  // confundir com a primeira posição.
  assert(linhas[0].ordem === 1, 'a primeira posição não é 1: ' + linhas[0].ordem);

  const cat = app.chamar('GET', '/api/loja/catalogo').body;
  const nomes = cat.categorias.map((c) => c.categoria);
  assert(nomes[0] === 'TEMPEROS' && nomes[1] === 'DOCES' && nomes[2] === 'ALIMENTOS',
    'o catálogo não respeitou a ordem: ' + JSON.stringify(nomes));
});

t('B2. categoria nunca ordenada vai para o FIM, sem embaralhar as ordenadas', async () => {
  const { db, app } = baseComProdutos();
  app.chamar('PUT', '/api/loja/ordem-categorias', { categorias: ['TEMPEROS', 'DOCES'] });
  db.prepare("INSERT INTO produtos (sku, descricao, categoria, ativo) VALUES ('SKU-ZIN', 'ZINCO', 'ZOOLOGIA', 1)").run();

  const nomes = app.chamar('GET', '/api/loja/catalogo').body.categorias.map((c) => c.categoria);
  assert(nomes[0] === 'TEMPEROS' && nomes[1] === 'DOCES',
    'a categoria nova embaralhou as ordenadas: ' + JSON.stringify(nomes));
  const ali = nomes.indexOf('ALIMENTOS'), zoo = nomes.indexOf('ZOOLOGIA');
  assert(ali > 1 && zoo > 1, 'não ordenadas deveriam vir depois: ' + JSON.stringify(nomes));
  assert(ali < zoo, 'entre as não ordenadas o desempate é alfabético: ' + JSON.stringify(nomes));
});

t('B3. "Sem categoria" continua por último mesmo com ordem definida', async () => {
  const { db, app } = baseComProdutos();
  db.prepare("INSERT INTO produtos (sku, descricao, ativo) VALUES ('SKU-AVU', 'AVULSO', 1)").run();
  app.chamar('PUT', '/api/loja/ordem-categorias', { categorias: ['TEMPEROS', 'DOCES', 'ALIMENTOS'] });
  const nomes = app.chamar('GET', '/api/loja/catalogo').body.categorias.map((c) => c.categoria);
  assert(nomes[nomes.length - 1] === null, 'Sem categoria saiu do fim: ' + JSON.stringify(nomes));
});

t('B4. ordem de produtos persiste DENTRO da categoria', async () => {
  const { db, app } = baseComProdutos();
  const ids = db.prepare("SELECT id, descricao FROM produtos WHERE categoria='ALIMENTOS' ORDER BY descricao").all();
  const invertido = [ids[1].id, ids[0].id];                 // CAFE antes de ARROZ
  const r = app.chamar('PUT', '/api/loja/ordem-produtos', { ids: invertido });
  assert(r.body && r.body.success, 'gravação falhou: ' + JSON.stringify(r.body));

  const cat = app.chamar('GET', '/api/loja/catalogo').body.categorias.find((c) => c.categoria === 'ALIMENTOS');
  assert(cat.produtos[0].descricao === 'CAFE',
    'o produto movido não subiu: ' + cat.produtos.map((p) => p.descricao).join(','));
  // A outra categoria não foi tocada.
  const doces = app.chamar('GET', '/api/loja/catalogo').body.categorias.find((c) => c.categoria === 'DOCES');
  assert(doces.produtos[0].descricao === 'BOLO',
    'ordenar ALIMENTOS mexeu em DOCES: ' + doces.produtos.map((p) => p.descricao).join(','));
});

t('B5. produto sem ordem fica depois dos ordenados, em ordem alfabética', async () => {
  const { db, app } = baseComProdutos();
  const doces = db.prepare("SELECT id, descricao FROM produtos WHERE categoria='DOCES' ORDER BY descricao").all();
  // Só o segundo recebe posição; o primeiro segue com ordemVitrine = 0.
  app.chamar('PUT', '/api/loja/ordem-produtos', { ids: [doces[1].id] });
  const lista = app.chamar('GET', '/api/loja/catalogo').body
    .categorias.find((c) => c.categoria === 'DOCES').produtos.map((p) => p.descricao);
  assert(lista[0] === 'DOCE DE LEITE',
    'ordemVitrine = 0 subiu ao topo — falta o CASE que separa "nunca ordenado": ' + lista.join(','));
});

t('B6. a vitrine PÚBLICA obedece à mesma ordem da central', async () => {
  const { db, app: admin } = baseComProdutos();
  const ids = db.prepare("SELECT id FROM produtos WHERE categoria='ALIMENTOS' ORDER BY descricao").all();
  admin.chamar('PUT', '/api/loja/ordem-produtos', { ids: [ids[1].id, ids[0].id] });
  admin.chamar('PUT', '/api/loja/ordem-categorias', { categorias: ['TEMPEROS', 'DOCES', 'ALIMENTOS'] });
  db.prepare('UPDATE loja_config SET ativa = 1 WHERE id = 1').run();

  const pub = appFalso();
  require('../loja-routes').registrarRotasLojaPublica(pub, db);
  const r = pub.chamar('GET', '/loja/api/produtos').body;
  assert(r && r.success, 'a vitrine pública não respondeu: ' + JSON.stringify(r));
  assert(r.categorias[0] === 'TEMPEROS',
    'a vitrine pública ignorou a ordem das categorias: ' + JSON.stringify(r.categorias));
  const ali = r.produtos.filter((p) => p.categoria === 'ALIMENTOS').map((p) => p.descricao);
  assert(ali[0] === 'CAFE', 'a vitrine pública ignorou a ordem dos produtos: ' + ali.join(','));
});

t('B7. lista vazia ou inválida é recusada, não grava nada', async () => {
  const { db, app } = baseComProdutos();
  for (const corpo of [{}, { categorias: [] }, { categorias: ['', '  '] }]) {
    const r = app.chamar('PUT', '/api/loja/ordem-categorias', corpo);
    assert(r.status === 400, 'aceitou corpo inválido: ' + JSON.stringify(corpo));
  }
  assert(db.prepare('SELECT COUNT(*) n FROM loja_categoria_ordem').get().n === 0,
    'gravou alguma coisa a partir de corpo inválido');
  for (const corpo of [{}, { ids: [] }, { ids: ['abc'] }]) {
    assert(app.chamar('PUT', '/api/loja/ordem-produtos', corpo).status === 400,
      'aceitou ids inválidos: ' + JSON.stringify(corpo));
  }
});

t('B8. nome e publicação não apagam o resto da configuração', async () => {
  const { db, app } = baseComProdutos();
  db.prepare(`UPDATE loja_config SET nome='ANTIGO', whatsapp='44999990000',
    email='a@b.c', descricao='texto', mostrarPreco=1 WHERE id=1`).run();

  app.chamar('PUT', '/api/loja/nome', { nome: 'FEIRA DA ESQUINA' });
  app.chamar('POST', '/api/loja/publicar', { ativa: true });

  const c = db.prepare('SELECT * FROM loja_config WHERE id = 1').get();
  assert(c.nome === 'FEIRA DA ESQUINA', 'nome não gravou: ' + c.nome);
  assert(c.ativa === 1, 'publicação não gravou');
  // O ponto do teste: o efeito colateral que uma rota de campo único evita.
  assert(c.whatsapp === '44999990000' && c.email === 'a@b.c' && c.descricao === 'texto' && c.mostrarPreco === 1,
    'gravar o nome apagou contato/descrição: ' + JSON.stringify(c));

  app.chamar('PUT', '/api/loja/nome', { nome: '   ' });
  assert(db.prepare('SELECT nome FROM loja_config WHERE id=1').get().nome === null,
    'nome em branco virou string vazia — deveria ser NULL, para recuar ao nome da empresa');
});

t('B9. banner: some do catálogo quando removido, e nunca recua para o logo', async () => {
  const { db, app } = baseComProdutos();
  db.prepare("UPDATE loja_config SET bannerPath='/uploads/loja/banner-1.png', logoPath='/uploads/loja/logo-1.png' WHERE id=1").run();
  assert(app.chamar('GET', '/api/loja/catalogo').body.loja.banner === '/uploads/loja/banner-1.png',
    'o banner não chegou ao catálogo');
  app.chamar('DELETE', '/api/loja/banner');
  const l = app.chamar('GET', '/api/loja/catalogo').body.loja;
  assert(l.banner === null, 'o banner removido continua aparecendo: ' + l.banner);
  assert(l.logo === '/uploads/loja/logo-1.png', 'remover o banner apagou o logo');
});

// ============================================================================
// E. PUT /api/loja/config não destrói o que não recebe
//
// Esta rota grava a linha inteira de `loja_config`. Até 19/09, campo ausente
// no corpo virava `null` (texto) ou `0` (liga/desliga) — então salvar uma
// configuração apagava outra. Os sintomas eram reais: o modal de aparência não
// mandava e-mail nem telefone, e apagava os dois; uma tela que mandasse só o
// preço tiraria o catálogo do ar, porque `ativa` ausente virava 0.
//
// A regra agora é uma só, e estes casos a guardam campo por campo: AUSENTE
// preserva, ENVIADO aplica — inclusive enviar vazio, que continua limpando.
// ============================================================================

function lojaComDados() {
  const db = bancoNovo('e' + Math.random().toString(36).slice(2, 7));
  /* `migrarLojaDB` porque `loja_config` nasce por ela, e não pelo `initSchema`
     que o `bancoNovo` roda — mesmo par que o `baseComProdutos` acima usa. */
  require('../loja-routes').migrarLojaDB(db);
  /* E `produto_imagens` porque o GET conta fotos: sem a tabela ele devolve 500
     e o caso reprovaria por falta do harness, não por defeito do código. */
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL, caminho TEXT NOT NULL, urlOrigem TEXT,
    origem TEXT NOT NULL DEFAULT 'outra', autorizadoPor TEXT, autorizadoEm TEXT,
    largura INTEGER, altura INTEGER, bytes INTEGER, ordem INTEGER DEFAULT 0,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);
  const app = appFalso();
  require('../loja-routes').registrarRotasLojaAdmin(app, db);
  // Estado inicial com TUDO preenchido: só assim se vê o que some.
  app.chamar('PUT', '/api/loja/config', {
    ativa: 1, nome: 'LOJA TESTE', descricao: 'apresentação da loja',
    whatsapp: '44999990000', email: 'contato@loja.com', telefone: '4433221100',
    mostrarPreco: 1, mostrarEstoque: 1,
    tema: { corPrimaria: '#123456', fundo: 'escuro', fonte: 'tecnica', raio: 16 },
    pagamentoModo: 'pix', pagamentoVencimentoDias: 7,
  });
  return { db, app, ler: () => app.chamar('GET', '/api/loja/config').body.config };
}

t('E1. salvar SÓ o tema não apaga e-mail nem telefone', () => {
  const { app, ler } = lojaComDados();
  const antes = ler();
  assert(antes.email === 'contato@loja.com' && antes.telefone === '4433221100',
    'o estado inicial não gravou contato: ' + JSON.stringify(antes));

  // É exatamente o que o modal "Aparência do catálogo" manda.
  const r = app.chamar('PUT', '/api/loja/config', {
    tema: { corPrimaria: '#aabbcc', fundo: 'claro', fonte: 'neutra', raio: 4 },
  });
  assert(r.body && r.body.success, 'o PUT falhou: ' + JSON.stringify(r.body));

  const d = ler();
  assert(d.email === 'contato@loja.com', `o e-mail virou ${JSON.stringify(d.email)}`);
  assert(d.telefone === '4433221100', `o telefone virou ${JSON.stringify(d.telefone)}`);
  assert(d.nome === 'LOJA TESTE', `o nome virou ${JSON.stringify(d.nome)}`);
  assert(d.descricao === 'apresentação da loja', `a apresentação virou ${JSON.stringify(d.descricao)}`);
  assert(d.whatsapp === '44999990000', `o whatsapp virou ${JSON.stringify(d.whatsapp)}`);
  // E o que ele veio mudar, mudou.
  assert(d.tema.corPrimaria === '#aabbcc', 'a cor não foi salva');
});

t('E2. salvar SÓ o tema não despublica e não mexe em preço', () => {
  const { app, ler } = lojaComDados();
  app.chamar('PUT', '/api/loja/config', { tema: { corPrimaria: '#aabbcc' } });
  const d = ler();
  /* `ativa` ausente virava 0: salvar a aparência tirava a loja do ar. */
  assert(d.ativa === 1, 'salvar o tema DESPUBLICOU o catálogo');
  assert(d.mostrarPreco === 1, 'salvar o tema desligou "mostrar preço"');
  assert(d.mostrarEstoque === 1, 'salvar o tema desligou "mostrar disponibilidade"');
  assert(d.pagamentoModo === 'pix', 'salvar o tema trocou a forma de cobrança');
  assert(d.pagamentoVencimentoDias === 7, 'salvar o tema trocou o vencimento');
});

t('E3. salvar SÓ preço e pagamento não mexe em tema nem em contato', () => {
  const { app, ler } = lojaComDados();
  // É exatamente o que a tela "Preço e pagamento" manda.
  app.chamar('PUT', '/api/loja/config', {
    mostrarPreco: false, mostrarEstoque: false,
    pagamentoModo: 'boleto', pagamentoVencimentoDias: 15,
  });
  const d = ler();
  assert(d.mostrarPreco === 0 && d.mostrarEstoque === 0, 'os dois "mostrar" não foram salvos');
  assert(d.pagamentoModo === 'boleto' && d.pagamentoVencimentoDias === 15,
    'a cobrança não foi salva');
  // Nada mais pode ter se mexido.
  assert(d.tema.corPrimaria === '#123456' && d.tema.fundo === 'escuro'
      && d.tema.fonte === 'tecnica' && d.tema.raio === 16,
    'preço e pagamento alterou o TEMA: ' + JSON.stringify(d.tema));
  assert(d.email === 'contato@loja.com' && d.telefone === '4433221100'
      && d.nome === 'LOJA TESTE', 'preço e pagamento alterou o contato');
  assert(d.ativa === 1, 'preço e pagamento DESPUBLICOU o catálogo');
});

t('E4. campo enviado VAZIO continua limpando — preservar não é ignorar', () => {
  const { app, ler } = lojaComDados();
  app.chamar('PUT', '/api/loja/config', { email: '', telefone: null, mostrarPreco: false });
  const d = ler();
  assert(d.email === null, `enviar vazio devia limpar o e-mail, veio ${JSON.stringify(d.email)}`);
  assert(d.telefone === null, `enviar null devia limpar o telefone, veio ${JSON.stringify(d.telefone)}`);
  assert(d.mostrarPreco === 0, 'enviar false devia desligar "mostrar preço"');
  // O que não foi enviado segue intacto.
  assert(d.nome === 'LOJA TESTE' && d.ativa === 1, 'o resto foi levado junto');
});

t('E5. os QUATRO tokens do tema sobrevivem à ida e volta', () => {
  const { app, ler } = lojaComDados();
  /* O catálogo público lê os quatro em `public/loja/tema.js`. Antes de 19/09
     só a cor tinha editor no Catálogo Online; fundo, tipografia e cantos só
     existiam na Loja virtual antiga. */
  app.chamar('PUT', '/api/loja/config', {
    tema: { corPrimaria: '#B4531A', fundo: 'escuro', fonte: 'editorial', raio: 24 },
  });
  const t1 = ler().tema;
  assert(t1.corPrimaria === '#B4531A', 'cor não persistiu: ' + t1.corPrimaria);
  assert(t1.fundo === 'escuro', 'fundo não persistiu: ' + t1.fundo);
  assert(t1.fonte === 'editorial', 'tipografia não persistiu: ' + t1.fonte);
  assert(t1.raio === 24, 'cantos não persistiram: ' + t1.raio);

  /* E é ESTE o valor que chega ao público: `GET /loja/api/config` devolve
     `tema: c.tema`, a mesma coluna lida aqui. Não há conversão no meio nem
     cópia em outro lugar. */
  const fonte = require('fs').readFileSync(require('path').join(RAIZ, 'loja-routes.js'), 'utf8');
  assert(/tema: c\.tema/.test(fonte),
    'a rota pública deixou de servir `loja_config.tema` direto');
});

t('E6. só existe UMA estrutura de tema, e é `loja_config.tema`', () => {
  const db = bancoNovo('e6');
  require('../loja-routes').migrarLojaDB(db);
  const colunas = db.prepare("SELECT name FROM pragma_table_info('loja_config')").all().map((c) => c.name);
  assert(colunas.includes('tema'), 'sumiu a coluna `tema`');
  /* Nenhuma coluna paralela de aparência: se alguém criar `tema2`, `aparencia`
     ou `corPrimaria` solta, passam a existir duas fontes para a mesma
     configuração e o público lê uma delas por acaso. */
  const paralelas = colunas.filter((c) => /^(tema|aparencia|visual)/i.test(c) && c !== 'tema');
  assert(paralelas.length === 0, 'estrutura paralela de tema: ' + paralelas.join(', '));
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map((x) => x.name).filter((n) => /tema|aparencia/i.test(n));
  assert(tabelas.length === 0, 'tabela paralela de tema: ' + tabelas.join(', '));
});

// ============================================================================
// C. UX no Chrome
// ============================================================================

const ESTADO = { nome: null, publicou: null, ordemCat: null, ordemProd: null, bannerRemovido: false };

function catalogo() {
  const p = (id, desc) => ({ id, sku: 'S' + id, descricao: desc, unidade: 'UN', preco: 10 + id,
    foto: null, nFotos: 0, publicado: true, destaque: false, ordemVitrine: 0, disponivel: 5 });
  return {
    success: true,
    loja: { ativa: false, nome: 'EMPRESA TESTE LTDA', nomeProprio: false, descricao: null,
      logo: null, logoProprio: false, banner: null, whatsapp: null,
      tema: { corPrimaria: '#0E6B63' }, mostrarPreco: true, mostrarEstoque: true,
      pagamento: 'nenhum', url: 'https://empresa.liciteagora.app/loja/' },
    resumo: { total: 5, publicados: 5, ocultos: 0, destaques: 0, semFoto: 5, categorias: 3 },
    destaques: [],
    categorias: [
      { categoria: 'ALIMENTOS', produtos: [p(1, 'ARROZ'), p(3, 'CAFE')], total: 2, publicados: 2, ordem: 0 },
      { categoria: 'DOCES', produtos: [p(2, 'BOLO'), p(4, 'DOCE DE LEITE')], total: 2, publicados: 2, ordem: 0 },
      { categoria: 'TEMPEROS', produtos: [p(5, 'ERVA')], total: 1, publicados: 1, ordem: 0 },
      { categoria: null, produtos: [], total: 0, publicados: 0, ordem: 0 },
    ],
  };
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function subirServidor() {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const ler = (cb) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => cb(b)); };
    const json = (d) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(d)); };
    const guardar = (chave) => ler((b) => { try { ESTADO[chave] = JSON.parse(b); } catch (_) {} json({ success: true }); });

    if (url === '/api/loja/catalogo') return json(catalogo());
    if (url === '/api/loja/nome') return guardar('nome');
    if (url === '/api/loja/publicar') return guardar('publicou');
    if (url === '/api/loja/ordem-categorias') return guardar('ordemCat');
    if (url === '/api/loja/ordem-produtos') return guardar('ordemProd');
    if (url === '/api/loja/banner' && req.method === 'DELETE') { ESTADO.bannerRemovido = true; return json({ success: true }); }
    if (url.startsWith('/api/')) return json({ success: true, produtos: [], itens: [] });
    if (url === '/__e') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      /* O shell REAL, e não um iframe qualquer.
       *
       * Duas coisas precisam ser verdade, e as duas faltavam:
       *
       * 1. `window.__liciteShell = true` no PAI. É o que `IN_SHELL` testa em
       *    `sidebar.js:10`. Sem isso a tela se julga avulsa e desenha a própria
       *    topbar fixa por cima do conteúdo — em produção a topbar é do shell, e
       *    a tela não tem nenhuma.
       * 2. O iframe começa em `top: var(--topbar-h)`, como no `app.html`.
       *
       * Sem os dois, os 52px de cima da tela ficam sob uma barra que só existe
       * no teste, e um clique no cabeçalho acerta a barra em vez do botão. O
       * harness precisa medir a tela que o usuário tem. */
      return res.end(`<!doctype html><meta charset="utf-8">
        <link rel="stylesheet" href="/css/sidebar.css">
        <style>
          html,body{margin:0;height:100%;overflow:hidden}
          iframe{border:0;position:fixed;top:var(--topbar-h,52px);left:0;right:0;
                 width:100%;height:calc(100% - var(--topbar-h,52px));display:block}
        </style>
        <script>
          window.__liciteShell = true;
          window.__shellPageChanged = function () {};
        </script>
        <iframe id="tela" src="/catalogo/catalogo-online.html"></iframe>`);
    }
    const arq = path.join(PUB, url.replace(/^\//, ''));
    if (!arq.startsWith(PUB) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) {
      res.statusCode = 404; return res.end('x');
    }
    res.setHeader('Content-Type', TIPOS[path.extname(arq)] || 'application/octet-stream');
    res.end(fs.readFileSync(arq));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

let browser, srv, base;

async function abrir(largura = 1280) {
  const page = await browser.newPage();
  const erros = [];
  page.on('pageerror', (e) => erros.push(`${e.name}: ${e.message}`));
  await page.setViewport({ width: largura, height: 900, isMobile: largura < 700, hasTouch: largura < 700 });
  await page.goto(base + '/__e', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await new Promise((r) => setTimeout(r, 2300));
  const frame = await (await page.$('#tela')).contentFrame();
  if (!frame) throw new Error('a tela não carregou');
  return { page, frame, erros };
}

t('C1. o link público fica SOBRE o banner, visível e dentro dele', async () => {
  const { page, frame, erros } = await abrir();
  try {
    const r = await frame.evaluate(() => {
      const b = document.getElementById('capBanner').getBoundingClientRect();
      const l = document.querySelector('.cap-link');
      const lr = l.getBoundingClientRect();
      return { url: document.getElementById('capUrl').textContent.trim(),
        larg: Math.round(lr.width), alt: Math.round(lr.height),
        dentro: lr.top >= b.top - 1 && lr.bottom <= b.bottom + 1 && lr.left >= b.left - 1,
        rodape: document.querySelectorAll('.cap-rodape').length };
    });
    assert(r.url.includes('/loja/'), 'o link público não aparece: ' + r.url);
    assert(r.larg > 60 && r.alt > 12, `a faixa do link mede ${r.larg}x${r.alt}px — invisível na prática`);
    assert(r.dentro, 'a faixa do link não está sobre o banner');
    assert(r.rodape === 0, 'o link continua duplicado no rodapé da capa');
    assert(erros.length === 0, 'exceção: ' + erros.join(' | '));
  } finally { await page.close(); }
});

t('C2. editar o nome no lugar grava; Esc desiste sem gravar', async () => {
  const { page, frame, erros } = await abrir();
  try {
    ESTADO.nome = null;
    const h = await frame.$('#capNome');
    await h.click();
    await frame.evaluate(() => {
      const e = document.getElementById('capNome');
      const s = window.getSelection(), r = document.createRange();
      r.selectNodeContents(e); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.type('FEIRA DA ESQUINA');
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 600));
    assert(ESTADO.nome && ESTADO.nome.nome === 'FEIRA DA ESQUINA',
      'o nome digitado não foi gravado: ' + JSON.stringify(ESTADO.nome));

    // Esc: repõe e NÃO grava.
    ESTADO.nome = null;
    await (await frame.$('#capNome')).click();
    await page.keyboard.type('LIXO');
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 500));
    assert(ESTADO.nome === null, 'Esc gravou o texto que se quis descartar: ' + JSON.stringify(ESTADO.nome));
    const texto = await frame.evaluate(() => document.getElementById('capNome').textContent.trim());
    assert(!texto.includes('LIXO'), 'Esc não repôs o nome anterior: ' + texto);
    assert(erros.length === 0, 'exceção: ' + erros.join(' | '));
  } finally { await page.close(); }
});

t('C3. o selo de status publica e despublica num clique', async () => {
  const { page, frame, erros } = await abrir();
  try {
    ESTADO.publicou = null;
    const antes = await frame.evaluate(() => document.getElementById('capStatus').textContent.trim());
    assert(antes === 'Não publicado', 'estado inicial inesperado: ' + antes);
    await frame.click('#capStatus');
    await new Promise((r) => setTimeout(r, 700));
    assert(ESTADO.publicou && ESTADO.publicou.ativa === true,
      'o clique não pediu publicação: ' + JSON.stringify(ESTADO.publicou));
    assert(erros.length === 0, 'exceção: ' + erros.join(' | '));
  } finally { await page.close(); }
});

t('C4. menu de configurações abre, lista as opções e fecha ao clicar fora', async () => {
  const { page, frame, erros } = await abrir();
  try {
    const visivel = () => frame.evaluate(() => {
      const m = document.getElementById('menuCfg');
      return !m.hidden && m.getBoundingClientRect().height > 20;
    });
    assert(!(await visivel()), 'o menu já nasce aberto');
    await frame.click('#btCfg');
    await new Promise((r) => setTimeout(r, 300));
    assert(await visivel(), 'o menu não abriu');
    const itens = await frame.evaluate(() =>
      [...document.querySelectorAll('#menuCfg button')].map((b) => b.textContent.trim()));
    assert(itens.length >= 4, 'o menu tem só ' + itens.length + ' opções: ' + itens.join(' | '));
    assert(itens.some((i) => /apar[êe]ncia/i.test(i)), 'falta Aparência: ' + itens.join(' | '));
    assert(itens.some((i) => /categoria/i.test(i)), 'falta gerenciar categorias: ' + itens.join(' | '));
    await frame.click('#busca');
    await new Promise((r) => setTimeout(r, 300));
    assert(!(await visivel()), 'o menu não fechou ao clicar fora');
    assert(erros.length === 0, 'exceção: ' + erros.join(' | '));
  } finally { await page.close(); }
});

/* ── C5 a C9: o puxador ⠿ no lugar das setas ▲▼ ───────────────────────────
 *
 * A Fase 52 trocou os botões ▲▼ por um puxador arrastável, porque mover um
 * produto seis posições eram seis cliques e seis idas ao servidor. O que estes
 * casos garantem NÃO mudou — lista inteira na gravação, "Sem categoria" fora
 * da ordenação, extremos que não se movem, nada de reordenar sobre um recorte
 * de busca, e a linha que não quebra — só mudou o controle que os aciona.
 *
 * O acionamento aqui é o TECLADO (↑ ↓ sobre o puxador focado), e não o
 * arrasto: é o mesmo caminho de código a partir do handler da tela, roda sem
 * depender de coordenadas de ponteiro, e de quebra prova que quem navega por
 * teclado continua conseguindo reordenar — o que as setas garantiam de graça
 * e um gesto, sozinho, não garante. O arrasto propriamente dito é provado por
 * ponteiro na suíte da Fase 52.
 */

/** Foca o puxador indicado e dispara uma seta; devolve false se não achou. */
async function setaNoPuxador(frame, seletor, tecla) {
  return frame.evaluate((sel, key) => {
    const p = document.querySelector(sel);
    if (!p) return false;
    p.focus();
    p.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    return true;
  }, seletor, tecla);
}

t('C5. o puxador da categoria manda a LISTA INTEIRA na ordem nova', async () => {
  const { page, frame, erros } = await abrir();
  try {
    ESTADO.ordemCat = null;
    await frame.click('[data-abrircats]');
    await new Promise((r) => setTimeout(r, 400));
    // TEMPEROS é a terceira; subir uma posição a põe no meio.
    const achou = await setaNoPuxador(frame, '#pnCatsCorpo [data-mover-cat="TEMPEROS"]', 'ArrowUp');
    assert(achou, 'não há puxador para TEMPEROS no painel de categorias');
    await new Promise((r) => setTimeout(r, 700));
    assert(ESTADO.ordemCat, 'a seta não gravou ordem nenhuma');
    assert(ESTADO.ordemCat.categorias.join(',') === 'ALIMENTOS,TEMPEROS,DOCES',
      'ordem enviada errada: ' + JSON.stringify(ESTADO.ordemCat.categorias));
    // "Sem categoria" não pode entrar na lista — ela não é categoria.
    assert(!ESTADO.ordemCat.categorias.includes(null) && ESTADO.ordemCat.categorias.length === 3,
      '"Sem categoria" entrou na ordenação: ' + JSON.stringify(ESTADO.ordemCat.categorias));
    assert(erros.length === 0, 'exceção: ' + erros.join(' | '));
  } finally { await page.close(); }
});

t('C6. extremos não se movem, e "Sem categoria" não tem puxador', async () => {
  const { page, frame } = await abrir();
  try {
    await frame.click('[data-abrircats]');
    await new Promise((r) => setTimeout(r, 400));

    /* Com botões, "não pode mover" era `disabled` e se lia no DOM. Com o
       puxador, o controle é o mesmo nas duas pontas: o que prova o limite é
       NÃO ter gravação quando a seta empurra para fora da lista. */
    for (const [cat, tecla, onde] of [['ALIMENTOS', 'ArrowUp', 'primeira'],
                                      ['TEMPEROS', 'ArrowDown', 'última']]) {
      ESTADO.ordemCat = null;
      const achou = await setaNoPuxador(frame, `#pnCatsCorpo [data-mover-cat="${cat}"]`, tecla);
      assert(achou, `não há puxador para ${cat}`);
      await new Promise((r) => setTimeout(r, 600));
      assert(!ESTADO.ordemCat, `a ${onde} categoria saiu do lugar — gravou ${JSON.stringify(ESTADO.ordemCat)}`);
    }

    // E a primeira ainda desce: o bloqueio é do extremo, não do controle.
    ESTADO.ordemCat = null;
    await setaNoPuxador(frame, '#pnCatsCorpo [data-mover-cat="ALIMENTOS"]', 'ArrowDown');
    await new Promise((r) => setTimeout(r, 700));
    assert(ESTADO.ordemCat, 'a primeira categoria não consegue descer');

    const semCat = await frame.evaluate(() =>
      document.querySelectorAll('#pnCatsCorpo [data-mover-cat=""]').length);
    assert(semCat === 0, '"Sem categoria" ganhou puxador de ordenação');
  } finally { await page.close(); }
});

t('C7. o puxador do produto manda os ids da categoria certa, na ordem nova', async () => {
  const { page, frame, erros } = await abrir();
  try {
    ESTADO.ordemProd = null;
    await frame.evaluate(() => { document.querySelector('[data-toggle="c:ALIMENTOS"]').click(); });
    await new Promise((r) => setTimeout(r, 400));
    const achou = await setaNoPuxador(frame, '[data-mover-prod="3"]', 'ArrowUp');   // CAFE, o segundo
    assert(achou, 'não há puxador na linha do produto');
    await new Promise((r) => setTimeout(r, 700));
    assert(ESTADO.ordemProd, 'a seta não gravou ordem nenhuma');
    assert(ESTADO.ordemProd.ids.join(',') === '3,1',
      'ids enviados errados: ' + JSON.stringify(ESTADO.ordemProd.ids));
    assert(erros.length === 0, 'exceção: ' + erros.join(' | '));
  } finally { await page.close(); }
});

t('C8. com busca ativa o puxador some — recorte não se reordena', async () => {
  const { page, frame } = await abrir();
  try {
    const contar = () => frame.evaluate(() =>
      document.querySelectorAll('#lista [data-mover-prod]').length);
    const naCategoria = () => frame.evaluate(() =>
      document.querySelectorAll('[data-bloco="c:ALIMENTOS"] .lp').length);

    await frame.evaluate(() => { document.querySelector('[data-toggle="c:ALIMENTOS"]').click(); });
    await new Promise((r) => setTimeout(r, 350));
    assert((await contar()) > 0, 'sem busca já não havia puxador');

    /* A busca precisa DEIXAR mais de um produto na categoria. Buscando "CAFE"
       sobrava um só, e aí o puxador sumia pela contagem (`produtos.length > 1`)
       antes de a guarda da busca ser consultada — o caso passava sem exercitar
       nada, e a sabotagem de 16/09 mostrou isso. "AR" mantém ARROZ e CAFE. */
    await frame.evaluate(() => {
      const b = document.getElementById('busca');
      b.value = 'A'; b.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 350));
    const restaram = await naCategoria();
    assert(restaram > 1, `a busca deixou ${restaram} produto(s) — o caso não testaria a guarda certa`);
    assert((await contar()) === 0, 'o puxador continua durante a busca — ordenaria sobre o recorte');
  } finally { await page.close(); }
});

t('C9. a linha do produto não quebra ao ganhar a coluna do puxador', async () => {
  const { page, frame } = await abrir();
  try {
    await frame.evaluate(() => { document.querySelector('[data-toggle="c:ALIMENTOS"]').click(); });
    await new Promise((r) => setTimeout(r, 400));
    const r = await frame.evaluate(() => {
      const lp = document.querySelector('#lista .lp.com-ord');
      if (!lp) return null;
      const cx = lp.getBoundingClientRect();
      const foto = lp.querySelector('.lp-foto').getBoundingClientRect();
      const preco = lp.querySelector('.lp-preco').getBoundingClientRect();
      const pux = lp.querySelector('.puxador');
      const p = pux ? pux.getBoundingClientRect() : null;
      return { alturaLinha: Math.round(cx.height), foto: Math.round(foto.height),
        // Uma linha só: foto e preço com o mesmo centro vertical.
        mesmaLinha: Math.abs((foto.top + foto.height / 2) - (preco.top + preco.height / 2)) < 6,
        temPuxador: !!pux,
        alvo: p ? { w: Math.round(p.width), h: Math.round(p.height) } : null,
        focavel: pux ? pux.getAttribute('tabindex') === '0' : false,
        papel: pux ? pux.getAttribute('role') : null,
        rotulo: pux ? (pux.getAttribute('aria-label') || '') : '',
        dica: pux ? (pux.dataset.dica || '') : '',
        usaTitle: pux ? pux.hasAttribute('title') : false };
    });
    assert(r, 'nenhuma linha ordenável foi renderizada');
    assert(r.foto >= 40, `a foto colapsou para ${r.foto}px — a grade quebrou (lição do relatório 42)`);
    assert(r.alturaLinha >= 55, `a linha mede ${r.alturaLinha}px — achatada`);
    assert(r.mesmaLinha, 'a coluna nova empurrou o preço para uma segunda linha');
    assert(r.temPuxador, 'a linha ordenável ficou sem puxador');
    /* 44px é o alvo de toque mínimo. As setas antigas passavam com 14px porque
       eram dois botões empilhados; o puxador é um só e precisa do alvo inteiro,
       ainda mais por ser o único jeito de reordenar com o dedo. */
    assert(r.alvo.h >= 44 && r.alvo.w >= 24,
      `puxador mede ${r.alvo.w}x${r.alvo.h}px — pequeno demais para o dedo`);
    assert(r.focavel && r.papel === 'button',
      'o puxador não é alcançável por teclado (tabindex/role)');
    assert(/seta|teclado/i.test(r.rotulo),
      'o rótulo não diz como reordenar sem arrastar: ' + r.rotulo);
    /* A explicação visível vai no tooltip PRÓPRIO da tela. `title` está
       proibido aqui desde a Fase 3.2.1: o balão nativo do navegador aparece
       por cima do nosso, branco e atrasado. */
    assert(r.dica, 'o puxador não explica o que faz ao passar o mouse');
    assert(!r.usaTitle, 'o puxador voltou a usar title=');
  } finally { await page.close(); }
});

t('C10. sem banner, o cabeçalho mostra a cor do tema e esconde "Remover"', async () => {
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(() => {
      const b = document.getElementById('capBanner');
      return { img: b.querySelectorAll('img').length,
        altura: Math.round(b.getBoundingClientRect().height),
        remover: !document.getElementById('btBannerRem').hidden,
        trocar: !!b.querySelector('.cap-banner-acoes button') };
    });
    assert(r.img === 0, 'apareceu imagem de banner onde não há banner');
    assert(r.altura >= 90, `capa com ${r.altura}px — sem presença`);
    assert(!r.remover, '"Remover" aparece sem haver banner para remover');
    assert(r.trocar, 'não há como escolher a capa');
  } finally { await page.close(); }
});

t('C11. mobile: os controles da capa continuam alcançáveis', async () => {
  const { page, frame, erros } = await abrir(390);
  try {
    const r = await frame.evaluate(() => {
      const v = (s) => { const e = document.querySelector(s); if (!e) return null;
        const c = e.getBoundingClientRect();
        return { w: Math.round(c.width), h: Math.round(c.height),
                 dentro: c.left >= -1 && c.right <= window.innerWidth + 1 }; };
      return { link: v('.cap-link'), trocar: v('.cap-banner-acoes button'),
               status: v('#capStatus'), cfg: v('#btCfg') };
    });
    for (const [nome, c] of Object.entries(r)) {
      assert(c, `${nome} não existe no mobile`);
      assert(c.w > 20 && c.h > 14, `${nome} mede ${c.w}x${c.h}px no celular`);
      assert(c.dentro, `${nome} vaza para fora da tela no celular`);
    }
    assert(erros.length === 0, 'exceção: ' + erros.join(' | '));
  } finally { await page.close(); }
});

// ============================================================================
// D. O que o pedido PROIBIU
// ============================================================================

t('D1. a ordem da vitrine não vaza para produto_lookup', async () => {
  const db = bancoNovo('d1');
  const cols = db.prepare("SELECT name FROM pragma_table_info('produto_lookup')").all().map((c) => c.name);
  assert(!cols.includes('ordem'), 'produto_lookup ganhou coluna `ordem` — a ordenação vazaria para o ERP inteiro');
});

t('D2. nenhuma tela do ERP fora da vitrine ordena por ordemVitrine', async () => {
  const alvos = ['produtos-routes.js', 'pedidos-routes.js', 'estoque-routes.js', 'produto-lookup-routes.js'];
  for (const a of alvos) {
    const p = path.join(RAIZ, a);
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert(!/ordemVitrine/.test(txt), `${a} passou a usar ordemVitrine — a ordem da loja vazou para o ERP`);
  }
  const pdv = fs.readFileSync(path.join(PUB, 'comercial/pedidos-pdv.html'), 'utf8');
  assert(!/ordemVitrine/.test(pdv), 'a Venda rápida passou a usar ordemVitrine');
});

t('D3. só a vitrine lê a tabela de ordem das categorias', async () => {
  const usos = fs.readdirSync(RAIZ)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /loja_categoria_ordem/.test(fs.readFileSync(path.join(RAIZ, f), 'utf8')));
  const esperados = ['loja-routes.js', 'db-schema.js'];
  const extras = usos.filter((u) => !esperados.includes(u));
  assert(extras.length === 0, 'loja_categoria_ordem lida fora da vitrine: ' + extras.join(', '));
});

t('D4. sem byte NUL literal e sem crase solta dentro de template SQL', async () => {
  // Montado por código: escrever o byte aqui seria plantar o defeito no
  // próprio teste que o procura. Já aconteceu três vezes nesta série.
  const NUL = String.fromCharCode(0);
  for (const f of ['loja-routes.js', 'db-schema.js']) {
    const txt = fs.readFileSync(path.join(RAIZ, f), 'utf8');
    assert(!txt.includes(NUL), `${f} tem byte NUL literal`);
  }
  const html = fs.readFileSync(path.join(PUB, 'catalogo/catalogo-online.html'), 'utf8');
  assert(!html.includes(NUL), 'a tela tem byte NUL literal');
  // O JS inline não passa pelo `npm run verify` — se quebrar, a tela some.
  const blocos = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert(blocos.length >= 1, 'nenhum script inline encontrado — o casamento mudou');
  for (const [i, b] of blocos.entries()) {
    try { new (require('vm').Script)(b, { filename: 'inline' + i }); }
    catch (e) { throw new Error(`o script inline ${i} não parseia: ${e.message}`); }
  }
});

(async () => {
  if (!CHROME) console.log('  Chrome ausente — os testes de UX (bloco C) serão pulados');
  if (CHROME) {
    srv = await subirServidor();
    base = `http://127.0.0.1:${srv.address().port}`;
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
    });
  }
  for (const [nome, fn] of fila) {
    if (!CHROME && /^C\d/.test(nome)) { console.log('PULA  ' + nome); continue; }
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  if (browser) await browser.close();
  if (srv) srv.close();
  for (const db of bancos) { try { db.close(); } catch (_) {} }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
