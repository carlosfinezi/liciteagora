/**
 * Rotas ANÔNIMAS da loja: erro interno não vira mapa do banco.
 *
 * Quem chama estas rotas não fez login nenhum. Até 2026-09-20 elas devolviam
 * `e.message` cru, então uma exceção de SQLite entregava nome de tabela, nome
 * de coluna e trecho de SQL a qualquer visitante.
 *
 * O caso mede COMPORTAMENTO, não o texto do arquivo: a falha é injetada por
 * fora, num `db` que lança de verdade, e o que se confere é o que sai pela
 * resposta e o que sai pelo log. Procurar `e.message` no fonte provaria apenas
 * que alguém escreveu certo hoje.
 *
 * A fronteira que este arquivo guarda tem dois lados, e o segundo importa
 * tanto quanto o primeiro: recusa de negócio CONTINUA específica. Esconder
 * "Loja não publicada" atrás de uma frase genérica trocaria um vazamento por
 * uma loja que não sabe dizer por que não vendeu.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };
const FILTRO = process.argv[2] || null;
let ok = 0, fail = 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loja-erros-'));
const abertos = [];
const SCHEMA = require('./schema-de-tenant').schemaDeTenant();

/** As cinco rotas SEM middleware de autenticação, conferidas uma a uma. */
const ANONIMAS = [
  ['GET', '/loja/api/config', null],
  ['GET', '/loja/api/produtos', null],
  ['GET', '/loja/api/produtos/:id', { __params: { id: '1' } }],
  ['POST', '/loja/api/carrinho/calcular', { itens: [{ produtoId: 1, quantidade: 1 }] }],
  ['GET', '/loja/api/sugestoes', null],
];

/* Três erros de naturezas diferentes. O terceiro existe porque nem todo
   vazamento é SQL: caminho de arquivo entrega a árvore do servidor e o slug do
   tenant vizinho. */
const ERROS = [
  ['SQL inesperado', 'SQLITE_ERROR: near "SELEC": syntax error'],
  ['nome de tabela e coluna', 'no such column: produtos.custoInterno'],
  ['detalhe interno arbitrário',
   "ENOENT: no such file or directory, open '/home/carlosfinezi/web/liciteagora.com.br/private/data/tenants/outro/pncp.db'"],
];

function montar(nome, { ativa = 1 } = {}) {
  const db = new Database(path.join(tmp, nome + '.db'));
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA);
  require('../db-schema').initSchema(db);
  require('../loja-routes').migrarLojaDB(db);
  db.pragma('foreign_keys = ON');
  abertos.push(db);
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL, caminho TEXT, urlOrigem TEXT, origem TEXT DEFAULT 'outra',
    autorizadoPor TEXT, autorizadoEm TEXT, largura INTEGER, altura INTEGER, bytes INTEGER,
    ordem INTEGER DEFAULT 0, dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.prepare(`INSERT INTO produtos (sku, descricao, categoria, ativo, publicadoNaLoja, precoVenda)
    VALUES ('S1','CESTA','CESTAS',1,1,100)`).run();
  db.exec("INSERT INTO movimentacoes_estoque (produtoId,tipo,quantidade,data) VALUES (1,'entrada',20,date('now'))");
  db.prepare(`UPDATE loja_config SET ativa=?, nome='LOJA PROVA', whatsapp='44999990000',
    mostrarPreco=1 WHERE id=1`).run(ativa);
  return db;
}

/**
 * `db` que estoura na primeira consulta, como um banco corrompido faria.
 * Injetar por fora é o que torna o caso honesto: o código de produção não sabe
 * que está sendo testado, e o caminho exercitado é o `catch` de verdade.
 */
function dbQueLanca(real, mensagem) {
  return new Proxy(real, {
    get(alvo, prop) {
      if (prop === 'prepare') return () => { throw new Error(mensagem); };
      const v = alvo[prop];
      return typeof v === 'function' ? v.bind(alvo) : v;
    },
  });
}

function montarApp(db) {
  const rotas = new Map();
  const reg = (m) => (url, ...fns) => rotas.set(m + ' ' + url, fns[fns.length - 1]);
  const app = {
    get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), use() {},
    chamar(m, url, body) {
      const fn = rotas.get(m + ' ' + url);
      if (!fn) throw new Error('rota não registrada: ' + m + ' ' + url);
      let saida = null, status = 200;
      const res = { json: (d) => { saida = d; return res; },
                    status: (s) => { status = s; return res; },
                    setHeader() { return res; }, end() { return res; } };
      fn({ body: body || {}, query: {}, params: (body && body.__params) || {},
           session: {}, protocol: 'https', get: () => 'loja.local' }, res);
      return { status, body: saida };
    },
  };
  require('../loja-routes').registrarRotasLojaPublica(app, db);
  return app;
}

/** Roda `fn` capturando o que o servidor registrou. */
function comLogCapturado(fn) {
  const original = console.error;
  const linhas = [];
  console.error = (...a) => linhas.push(a.map(String).join(' '));
  try { return { valor: fn(), log: linhas.join('\n') }; }
  finally { console.error = original; }
}

// ============================================================================
// A. Erro interno inesperado
// ============================================================================

for (const [nomeErro, detalhe] of ERROS) {
  t(`A. ${nomeErro}: o visitante não recebe o detalhe, e o servidor registra`, () => {
    const real = montar('a' + nomeErro.replace(/\W/g, '').slice(0, 10));
    const app = montarApp(dbQueLanca(real, detalhe));

    for (const [metodo, rota, corpo] of ANONIMAS) {
      const { valor: r, log } = comLogCapturado(() => app.chamar(metodo, rota, corpo));

      assert(r.status === 500, `${rota}: status ${r.status} em vez de 500`);

      const resposta = JSON.stringify(r.body);
      /* Palavra a palavra, e não só o texto inteiro: um vazamento parcial
         ("no such column: produtos") já entrega o schema. */
      for (const pedaco of detalhe.split(/[\s,:'"]+/).filter((p) => p.length > 5)) {
        assert(!resposta.includes(pedaco),
          `${rota}: a resposta pública contém "${pedaco}" -> ${resposta}`);
      }
      for (const proibido of ['SQLITE', 'no such', 'syntax error', 'ENOENT',
                              '/home/', 'pncp.db', 'produtos.custoInterno', 'SELECT', 'at Object']) {
        assert(!resposta.includes(proibido),
          `${rota}: a resposta pública contém "${proibido}" -> ${resposta}`);
      }
      assert(r.body && r.body.success === false, `${rota}: não sinalizou falha`);
      assert(typeof r.body.error === 'string' && r.body.error.length > 10,
        `${rota}: ficou sem mensagem nenhuma`);

      // O detalhe não some do mundo: ele muda de lado.
      assert(log.includes(detalhe),
        `${rota}: o servidor NÃO registrou o erro real. log: ${log || '(vazio)'}`);
      assert(log.includes(rota), `${rota}: o log não diz qual rota falhou: ${log}`);
    }
  });
}

t('A4. a mensagem genérica é a mesma nas cinco rotas', () => {
  const app = montarApp(dbQueLanca(montar('a4'), 'no such table: loja_config'));
  const ditas = new Set();
  for (const [metodo, rota, corpo] of ANONIMAS) {
    const r = comLogCapturado(() => app.chamar(metodo, rota, corpo)).valor;
    ditas.add(r.body.error);
  }
  /* Uma frase só. Duas frases para a mesma situação viram dois vocabulários
     para a mesma coisa, e o visitante conclui que são problemas diferentes. */
  assert(ditas.size === 1, 'mensagens diferentes para o mesmo caso: ' + [...ditas].join(' | '));
});

// ============================================================================
// B. Recusa de negócio CONTINUA específica
// ============================================================================

t('B1. loja despublicada continua dizendo que está despublicada', () => {
  const app = montarApp(montar('b1', { ativa: 0 }));
  for (const [metodo, rota, corpo] of ANONIMAS) {
    const r = app.chamar(metodo, rota, corpo);
    assert(r.status === 404, `${rota}: status ${r.status} em vez de 404`);
    assert(/não publicada/i.test(r.body.error),
      `${rota}: a recusa virou genérica -> ${r.body.error}`);
  }
});

t('B2. produto inexistente continua dizendo que não existe', () => {
  const app = montarApp(montar('b2'));
  const r = app.chamar('GET', '/loja/api/produtos/:id', { __params: { id: '9999' } });
  assert(r.status === 404, `status ${r.status}`);
  assert(/não encontrado/i.test(r.body.error), `virou genérica: ${r.body.error}`);
});

t('B3. recusa de negócio no cálculo continua específica', () => {
  const app = montarApp(montar('b3'));
  const demais = Array.from({ length: 300 }, () => ({ produtoId: 1, quantidade: 1 }));
  const r = app.chamar('POST', '/loja/api/carrinho/calcular', { itens: demais });
  assert(r.status === 422, `status ${r.status} em vez de 422`);
  assert(/grande demais/i.test(r.body.error), `virou genérica: ${r.body.error}`);
  assert(!/Não foi possível carregar/.test(r.body.error),
    `a recusa de negócio foi engolida pela frase de erro interno: ${r.body.error}`);
});

/* Produto fora da vitrine NÃO é recusa: o item some da sacola e o cálculo
   segue. Está aqui porque a primeira versão deste arquivo esperava 4xx e
   reprovou — o comportamento é deliberado (`continue`, com o comentário
   "despublicado entre visitas"), e um teste que exigisse erro estaria pedindo
   para mudar o desenho por engano. */
t('B3b. produto fora da vitrine some da sacola, sem erro', () => {
  const app = montarApp(montar('b3b'));
  const r = app.chamar('POST', '/loja/api/carrinho/calcular',
    { itens: [{ produtoId: 1, quantidade: 1 }, { produtoId: 9999, quantidade: 1 }] });
  assert(r.status === 200, `status ${r.status}`);
  assert(r.body.itens.length === 1, `itens devolvidos: ${r.body.itens.length}`);
  assert(r.body.itens[0].produtoId === 1, 'sobrou o item errado');
});

t('B4. o caminho feliz continua respondendo 200', () => {
  const app = montarApp(montar('b4'));
  for (const [metodo, rota, corpo] of ANONIMAS) {
    const r = app.chamar(metodo, rota, corpo);
    assert(r.status === 200, `${rota}: status ${r.status} no caminho feliz -> ${JSON.stringify(r.body)}`);
  }
});

// ============================================================================
// C. A fronteira: só as anônimas mudaram
// ============================================================================

t('C1. as rotas com autenticação própria não foram alcançadas', () => {
  /* A Loja virtual antiga exige sessão de comprador e está fora desta mudança.
     O caso existe para que "arrumar as outras cinco de carona" apareça como
     falha, e não como melhoria silenciosa. */
  const src = fs.readFileSync(path.join(RAIZ, 'loja-routes.js'), 'utf8');
  for (const rota of ['/loja/api/carrinho', '/loja/api/pedido',
                      '/loja/api/meus-pedidos', '/loja/api/pedido/:id/cobranca']) {
    const i = src.indexOf(`'${rota}'`);
    assert(i > 0, `rota sumiu do arquivo: ${rota}`);
    assert(/compradorAuth/.test(src.slice(i, i + 120)),
      `${rota} perdeu o compradorAuth — isso é outra mudança, não esta`);
  }
});

(async () => {
  for (const [nome, fn] of fila.filter(([n]) => !FILTRO || n.startsWith(FILTRO))) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  for (const db of abertos) { try { db.close(); } catch (_) {} }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
