/**
 * Catálogo Online administrativo — fundação (Fase 46).
 *
 * ── A garantia que sustenta a fase inteira ──────────────────────────────────
 *
 * NÃO EXISTE "produto do catálogo". Existe o produto do ERP, e a central edita
 * esse mesmo registro. Se um dia alguém criar uma tabela espelho para
 * "simplificar", o catálogo passa a divergir do estoque e do preço sem que nada
 * dê erro — e é isso que o bloco D reprova.
 *
 * O bloco E cobre a segunda: destaque é uma COLUNA, não uma categoria chamada
 * "Destaques". Se virasse categoria, o produto sairia da categoria real dele.
 *
 * Banco descartável com o DDL real de um tenant. Nada de produção é tocado.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const TMP = '/tmp/test-catalogo-online';
fs.mkdirSync(TMP, { recursive: true });

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

const ORIGEM = path.join(RAIZ, 'data/tenants/1bit/pncp.db');
const SCHEMA = path.join(TMP, 'schema.sql');
if (!fs.existsSync(SCHEMA)) {
  if (!fs.existsSync(ORIGEM)) { console.error('tenant 1bit ausente'); process.exit(2); }
  fs.writeFileSync(SCHEMA, execFileSync('sqlite3', [`file:${ORIGEM}?mode=ro`, '.schema']).toString());
}

// Recorte do schema real: o completo tem 799 statements e leva 11 s por banco.
const TABELAS = ['produtos', 'produto_lookup', 'produto_imagens', 'loja_config', 'loja_carrinho',
                 'movimentacoes_estoque', 'reservas_estoque', 'pessoas', 'users',
                 'pedidos', 'pedido_itens', 'tabelas_preco', 'tabela_preco_itens', 'config',
                 'fornecedor'];   // emitente: origem do recuo de identidade
const DDL = (() => {
  const fora = [];
  for (const st of fs.readFileSync(SCHEMA, 'utf8').split(/;\s*\n/)) {
    const m = /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)[^(]*?["'`]?(\w+)["'`]?\s*(?:\(|ON\s+["'`]?(\w+))/i.exec(st);
    if (!m) continue;
    const alvo = m[1].toUpperCase() === 'TABLE' ? m[2] : m[3];
    if (TABELAS.includes(alvo)) fora.push(st);
  }
  return fora.join(';\n') + ';';
})();

function montar(nome) {
  const arq = path.join(TMP, nome + '.db');
  try { fs.unlinkSync(arq); } catch (_) {}
  const db = new Database(arq);
  db.exec(DDL);
  const loja = require('../loja-routes');
  loja.migrarLojaDB(db);                       // cria loja_config e as colunas
  /* O que o BOOT faz e o `migrarLojaDB` não faz.
   *
   * Este harness monta um banco parcial a partir do DDL recortado do
   * db-schema.js, e o recorte só pega `CREATE TABLE/INDEX` — os `ALTER` das
   * colunas de vitrine ficam de fora. Em produção quem as garante é o
   * `initSchema`, que roda por tenant no primeiro open (tenant-manager.js:507).
   *
   * Sem estas duas linhas o harness fica MENOS completo que produção, e um
   * teste reprova por falta de coluna que todo tenant real tem — foi o que
   * aconteceu quando `ordemVitrine` entrou no SELECT do catálogo (Fase 48). */
  for (const sql of ['ALTER TABLE produtos ADD COLUMN ordemVitrine INTEGER DEFAULT 0',
                     'CREATE TABLE IF NOT EXISTS loja_categoria_ordem (categoria TEXT PRIMARY KEY, '
                       + 'ordem INTEGER NOT NULL DEFAULT 0, dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP)']) {
    try { db.exec(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  const app = express();
  loja.registrarRotasLojaAdmin(app, db);
  require('../produtos-routes').registrarRotasProdutos(app, db);
  require('../produto-lookup-routes').registrarRotasProdutoLookup(app, db);

  const achar = (p, m) => {
    const l = ((app.router || app._router).stack || [])
      .find((x) => x.route && x.route.path === p && x.route.methods[m]);
    if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
    return l.route.stack.at(-1).handle;
  };
  const chamar = (p, m, o = {}) => {
    let corpo = null, st = 200;
    const res = { json: (x) => { corpo = x; return res; }, status: (c) => { st = c; return res; },
                  setHeader: () => res, send: (x) => { corpo = x; return res; } };
    achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                  session: { userId: 1 }, user: { id: 1, role: 'admin' },
                  protocol: 'https', get: () => 'empresa.liciteagora.app', headers: {} }, res);
    return { corpo, st };
  };
  return { db, chamar };
}

function seed(db, { sku, descricao, categoria = null, preco = 10, ativo = 1 }) {
  return db.prepare(`INSERT INTO produtos (sku, descricao, categoria, precoVenda, ativo)
                     VALUES (?,?,?,?,?)`).run(sku, descricao, categoria, preco, ativo).lastInsertRowid;
}

// ============================================================================
// A–C. Navegação, rota e RBAC
// ============================================================================

t('A. Catalogo Online esta em CATALOGO, logo depois de Categorias', () => {
  const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));
  const secao = menuConfig.secoes.find((s) => s.titulo === 'Catálogo');
  assert(secao, 'a seção Catálogo sumiu');
  const chaves = secao.itens.map((i) => i.page);
  const iCat = chaves.indexOf('cadastro-categorias');
  const iLoja = chaves.indexOf('loja');
  assert(iLoja >= 0, 'Catálogo Online não está na seção Catálogo');
  assert(iLoja === iCat + 1, `posição errada: ${chaves.slice(0, 6).join(' > ')}`);

  const item = secao.itens[iLoja];
  assert(item.texto === 'Catálogo Online', `rótulo é "${item.texto}"`);
  assert(item.link === '/catalogo/catalogo-online.html', 'link errado: ' + item.link);

  // A CHAVE não pode mudar: está gravada em perfis_acesso.paginas nos tenants.
  assert(item.page === 'loja', 'a chave de RBAC mudou — tiraria o acesso de quem já o tem');

  // E não pode ter sobrado item em Varejo: seriam dois caminhos para o mesmo.
  const varejo = menuConfig.secoes.find((s) => s.titulo === 'Varejo');
  assert(!varejo.itens.some((i) => i.page === 'loja'), 'ficou item duplicado em Varejo');
});

t('B. a tela antiga continua registrada, e OCULTA', () => {
  // Sem item no menu, o RBAC cairia na herança do diretório `/varejo/` e quem
  // tem PDV passaria a abrir a configuração da loja.
  const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));
  const todos = menuConfig.secoes.flatMap((s) => s.itens);
  const antiga = todos.find((i) => i.link === '/varejo/loja.html');
  assert(antiga, 'a tela antiga saiu do menu — viraria página órfã, sem proteção nominal');
  assert(antiga.oculto === true, 'a tela antiga aparece no menu — seriam dois itens para a mesma coisa');
  assert(fs.existsSync(path.join(PUB, 'varejo/loja.html')), 'o arquivo antigo foi apagado');
});

t('C. RBAC fail-closed: as paginas novas podem chamar as APIs que usam', () => {
  const mapa = fs.readFileSync(path.join(RAIZ, 'perfis-api-map.js'), 'utf8');
  const lista = (pref) => {
    const m = new RegExp(`'${pref}':\\s*\\[([^\\]]*)\\]`).exec(mapa);
    return m ? m[1] : '';
  };
  assert(lista('/api/loja').includes("'loja'"), 'a central não pode chamar /api/loja');
  assert(lista('/api/loja').includes("'loja-config'"), 'a tela antiga não pode chamar /api/loja');
  assert(lista('/api/produtos').includes("'loja'"), 'a central não pode chamar /api/produtos');

  // Nada de ampliar acesso alheio de carona (o gerador do mapa já fez isso uma
  // vez — ver relatório 44 §11).
  assert((mapa.match(/^\s*'\/api\//gm) || []).length === 176, 'o total de prefixos do mapa mudou');
  assert((mapa.match(/pedidos-pdv/g) || []).length === 3, 'pedidos-pdv ganhou acesso a mais APIs');
  assert(mapa.includes('/api/orcamento-publico'), 'o link público do orçamento saiu dos liberados');
});

// ============================================================================
// D. Um produto só — a garantia central
// ============================================================================

t('D1. a central NAO cria tabela nem produto paralelo', () => {
  const { db, chamar } = montar('d1');
  const id = seed(db, { sku: 'A1', descricao: 'PRODUTO A', categoria: 'CESTAS' });
  const antes = db.prepare('SELECT COUNT(*) n FROM produtos').get().n;

  chamar('/api/loja/catalogo', 'get');
  chamar('/api/loja/produtos/publicar', 'post', { body: { ids: [id], publicado: true } });
  chamar('/api/loja/produtos/destacar', 'post', { body: { ids: [id], destaque: true } });

  assert(db.prepare('SELECT COUNT(*) n FROM produtos').get().n === antes,
    'apareceu produto novo — a central deve editar o existente');
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const proibida of ['catalogo_produtos', 'loja_produtos', 'catalogo_itens', 'vitrine_produtos']) {
    assert(!tabelas.includes(proibida), `foi criada a tabela paralela ${proibida}`);
  }
});

t('D2. editar pela central altera o produto REAL', () => {
  const { db, chamar } = montar('d2');
  const id = seed(db, { sku: 'A1', descricao: 'NOME ANTIGO', preco: 10 });
  const r = chamar('/api/produtos/:id', 'put',
    { params: { id: String(id) }, body: { descricao: 'NOME NOVO', precoVenda: 25.5 } });
  assert(r.corpo && r.corpo.success, 'não salvou: ' + JSON.stringify(r.corpo));
  const p = db.prepare('SELECT descricao, precoVenda FROM produtos WHERE id = ?').get(id);
  assert(p.descricao === 'NOME NOVO', 'o nome não mudou no produto real');
  assert(Number(p.precoVenda) === 25.5, 'o preço não mudou no produto real');
});

t('D3. a tela usa o endpoint do PRODUTO para editar produto', () => {
  // Se a central tivesse um endpoint próprio de escrita, ele não teria a
  // whitelist de campos nem a validação de preço mínimo do servidor.
  const tela = fs.readFileSync(path.join(PUB, 'catalogo/catalogo-online.html'), 'utf8');
  assert(/\/api\/produtos\/'\s*\+\s*editando/.test(tela) || /api\('\/api\/produtos\/'/.test(tela),
    'a central não salva pelo endpoint de produtos');
  const rotas = fs.readFileSync(path.join(RAIZ, 'loja-routes.js'), 'utf8');
  assert(!/app\.(put|patch)\('\/api\/loja\/produto/.test(rotas),
    'apareceu endpoint de escrita de produto dentro da loja — duplicaria a validação');
});

// ============================================================================
// E. Destaques
// ============================================================================

t('E1. destaque e COLUNA, nao categoria', () => {
  const { db, chamar } = montar('e1');
  const id = seed(db, { sku: 'A1', descricao: 'CESTA CAFÉ', categoria: 'CESTAS' });
  chamar('/api/loja/produtos/destacar', 'post', { body: { ids: [id], destaque: true } });

  const p = db.prepare('SELECT categoria, destaqueNaLoja FROM produtos WHERE id = ?').get(id);
  assert(p.destaqueNaLoja === 1, 'não marcou o destaque');
  // O produto continua NA CATEGORIA DELE — é o ponto todo.
  assert(p.categoria === 'CESTAS', `a categoria virou "${p.categoria}"`);
  const lk = db.prepare("SELECT COUNT(*) n FROM produto_lookup WHERE tipo='categoria' AND valor LIKE '%estaque%'").get().n;
  assert(lk === 0, 'foi criada uma categoria "Destaques" no lookup');
});

t('E2. o produto em destaque aparece nos DOIS lugares', () => {
  const { db, chamar } = montar('e2');
  const id = seed(db, { sku: 'A1', descricao: 'CESTA CAFÉ', categoria: 'CESTAS' });
  chamar('/api/loja/produtos/destacar', 'post', { body: { ids: [id], destaque: true } });
  const d = chamar('/api/loja/catalogo', 'get').corpo;

  assert(d.destaques.some((p) => p.id === id), 'não está na faixa de destaques');
  const cesta = d.categorias.find((c) => c.categoria === 'CESTAS');
  assert(cesta && cesta.produtos.some((p) => p.id === id),
    'sumiu da categoria dele ao virar destaque');
  assert(d.resumo.destaques === 1, 'o contador de destaques não bateu');
});

// ============================================================================
// F–G. Categorias e agrupamento
// ============================================================================

t('F. categorias vem do lookup UNIDAS as em uso', () => {
  const { db, chamar } = montar('f');
  db.prepare("INSERT INTO produto_lookup (tipo, valor) VALUES ('categoria','VAZIA')").run();
  db.prepare("INSERT INTO produto_lookup (tipo, valor) VALUES ('categoria','CESTAS')").run();
  seed(db, { sku: 'A1', descricao: 'P1', categoria: 'CESTAS' });
  seed(db, { sku: 'A2', descricao: 'P2', categoria: 'FORA_DO_LOOKUP' });
  seed(db, { sku: 'A3', descricao: 'P3', categoria: null });

  const d = chamar('/api/loja/catalogo', 'get').corpo;
  const nomes = d.categorias.map((c) => c.categoria);
  // A cadastrada sem produto aparece: é como se enxerga a categoria nova.
  assert(nomes.includes('VAZIA'), 'categoria cadastrada sem produto sumiu');
  // A que está no produto mas fora do lookup também: senão o produto some.
  assert(nomes.includes('FORA_DO_LOOKUP'), 'produto com categoria fora do lookup ficaria invisível');
  // Sem categoria vira grupo com `categoria: null`, nunca a string.
  assert(nomes.includes(null), 'os produtos sem categoria sumiram');
  assert(!nomes.includes('Sem categoria'), 'criou uma categoria de texto "Sem categoria"');
  assert(nomes[nomes.length - 1] === null, '"Sem categoria" deveria vir por último');
});

t('G. o produto aparece na categoria certa, com a contagem certa', () => {
  const { db, chamar } = montar('g');
  const a = seed(db, { sku: 'A1', descricao: 'P1', categoria: 'CESTAS' });
  seed(db, { sku: 'A2', descricao: 'P2', categoria: 'CESTAS' });
  seed(db, { sku: 'A3', descricao: 'P3', categoria: 'DOCES' });
  chamar('/api/loja/produtos/publicar', 'post', { body: { ids: [a], publicado: true } });

  const d = chamar('/api/loja/catalogo', 'get').corpo;
  const cestas = d.categorias.find((c) => c.categoria === 'CESTAS');
  assert(cestas.total === 2, `CESTAS com ${cestas.total} produtos`);
  assert(cestas.publicados === 1, `CESTAS com ${cestas.publicados} publicados`);
  assert(d.categorias.find((c) => c.categoria === 'DOCES').total === 1, 'DOCES errado');
  assert(!cestas.produtos.some((p) => p.descricao === 'P3'), 'produto na categoria errada');
});

// ============================================================================
// H. Visibilidade
// ============================================================================

t('H. publicadoNaLoja controla a vitrine, e nao ha campo concorrente', () => {
  const { db, chamar } = montar('h');
  const id = seed(db, { sku: 'A1', descricao: 'P1' });
  assert(db.prepare('SELECT publicadoNaLoja p FROM produtos WHERE id=?').get(id).p === 0,
    'produto nasce publicado — vazaria catálogo por omissão');

  chamar('/api/loja/produtos/publicar', 'post', { body: { ids: [id], publicado: true } });
  assert(db.prepare('SELECT publicadoNaLoja p FROM produtos WHERE id=?').get(id).p === 1, 'não publicou');
  chamar('/api/loja/produtos/publicar', 'post', { body: { ids: [id], publicado: false } });
  assert(db.prepare('SELECT publicadoNaLoja p FROM produtos WHERE id=?').get(id).p === 0, 'não ocultou');

  const cols = db.prepare("SELECT name FROM pragma_table_info('produtos')").all().map((c) => c.name);
  for (const dup of ['visivelNaLoja', 'ativoNaLoja', 'publicoNaLoja', 'visivelCatalogo']) {
    assert(!cols.includes(dup), `apareceu campo concorrente de visibilidade: ${dup}`);
  }
  assert(cols.includes('destaqueNaLoja'), 'a coluna de destaque não foi criada');
});

// ============================================================================
// I. Resumo e link público
// ============================================================================

t('I1. os contadores vem dos produtos reais', () => {
  const { db, chamar } = montar('i1');
  const a = seed(db, { sku: 'A1', descricao: 'P1' });
  seed(db, { sku: 'A2', descricao: 'P2' });
  seed(db, { sku: 'A3', descricao: 'P3', ativo: 0 });        // inativo não conta
  chamar('/api/loja/produtos/publicar', 'post', { body: { ids: [a], publicado: true } });

  const r = chamar('/api/loja/catalogo', 'get').corpo.resumo;
  assert(r.total === 2, `total ${r.total} — produto inativo não deveria entrar`);
  assert(r.publicados === 1 && r.ocultos === 1, `publicados=${r.publicados} ocultos=${r.ocultos}`);
  assert(r.semFoto === 2, `semFoto=${r.semFoto}`);
});

t('I1b. identidade recua para a EMPRESA quando loja_config esta vazia', () => {
  // `loja_config` nasce vazia — o tenant só a preenche ao decidir publicar. Sem
  // recuo, a central abre com "Catálogo" e um traço no lugar do logo, e parece
  // que não carregou (foi o relato de 13/09).
  const { db, chamar } = montar('i1b');
  db.prepare("INSERT INTO fornecedor (razaoSocial, logoBase64) VALUES ('EMPRESA TESTE LTDA','data:img')").run();
  seed(db, { sku: 'A1', descricao: 'P1' });

  const l = chamar('/api/loja/catalogo', 'get').corpo.loja;
  assert(l.nome === 'EMPRESA TESTE LTDA', `sem recuo do nome da empresa: ${l.nome}`);
  assert(l.logo === 'data:img', 'sem recuo do logo da empresa');
  // A tela precisa saber que é recuo, para convidar a configurar.
  assert(l.nomeProprio === false, 'nomeProprio deveria ser false quando o nome vem da empresa');
  assert(l.logoProprio === false, 'logoProprio deveria ser false quando o logo vem da empresa');

  // E o nome próprio, quando existe, VENCE o da empresa.
  chamar('/api/loja/config', 'put', { body: { nome: 'MINHA LOJA' } });
  const l2 = chamar('/api/loja/catalogo', 'get').corpo.loja;
  assert(l2.nome === 'MINHA LOJA', `o nome próprio não venceu: ${l2.nome}`);
  assert(l2.nomeProprio === true, 'nomeProprio deveria ser true com nome configurado');
});

t('I1c. os destaques trazem os MESMOS campos da linha de categoria', () => {
  // A linha é a mesma nos dois lugares; faltando `sku`/`unidade`, o destaque
  // aparecia como "sem SKU".
  const { db, chamar } = montar('i1c');
  const id = seed(db, { sku: 'A1', descricao: 'P1', categoria: 'C' });
  chamar('/api/loja/produtos/destacar', 'post', { body: { ids: [id], destaque: true } });
  const d = chamar('/api/loja/catalogo', 'get').corpo;
  const dest = d.destaques[0];
  const naCat = d.categorias.find((c) => c.categoria === 'C').produtos[0];
  for (const campo of ['id', 'sku', 'descricao', 'unidade', 'preco', 'foto', 'publicado', 'disponivel']) {
    assert(campo in dest, `o destaque não traz "${campo}" — a linha sairia incompleta`);
  }
  assert(dest.sku === naCat.sku, 'o SKU do destaque diverge do da categoria');
});

t('I2. o link publico sai do host, sem slug inventado', () => {
  const { chamar } = montar('i2');
  const l = chamar('/api/loja/catalogo', 'get').corpo.loja;
  assert(l.url === 'https://empresa.liciteagora.app/loja/', 'URL inesperada: ' + l.url);
  const tela = fs.readFileSync(path.join(PUB, 'catalogo/catalogo-online.html'), 'utf8');
  const semCom = tela.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const p of ['produtosbomgosto', '1bit', 'tenantId', 'organizationId', '?empresa=']) {
    assert(!semCom.includes(p), `a tela carrega "${p}"`);
  }
});

// ============================================================================
// J–L. Não regredir o que já existe
// ============================================================================

t('J. a loja publica antiga continua intacta', () => {
  const rotas = fs.readFileSync(path.join(RAIZ, 'loja-routes.js'), 'utf8');
  for (const r of ["'/loja/api/config'", "'/loja/api/produtos'", "'/loja/api/carrinho'", "'/loja/api/pedido'"]) {
    assert(rotas.includes(r), `a rota pública ${r} sumiu`);
  }
  // O checkout é a Fase 4: nada aqui podia mexer no login do comprador.
  assert(/const compradorAuth = requirePortalAuth\(db\)/.test(rotas),
    'o login do comprador foi alterado — isso é da Fase 4');
  const pre = fs.readFileSync(path.join(RAIZ, 'pre-auth-routes.js'), 'utf8');
  assert(/registrarRotasLojaPublica/.test(pre), 'a loja pública saiu do pre-auth');
});

t('K. o pedido continua nascendo em pedidos/pedido_itens', () => {
  const rotas = fs.readFileSync(path.join(RAIZ, 'loja-routes.js'), 'utf8');
  const fn = /app\.post\('\/loja\/api\/pedido'[\s\S]*?\n  \}\);/.exec(rotas);
  assert(fn, 'a rota de pedido sumiu');
  assert(/INSERT INTO pedidos/.test(fn[0]), 'o pedido deixou de nascer em `pedidos`');
  assert(/INSERT INTO pedido_itens/.test(fn[0]), 'os itens deixaram de nascer em `pedido_itens`');
  assert(!/rest_comanda/.test(fn[0]), 'o pedido da loja passou a escrever em comanda');
});

t('L. NADA nesta fase escreve em rest_comandas', () => {
  for (const arq of ['loja-routes.js', 'produto-lookup-routes.js']) {
    const s = fs.readFileSync(path.join(RAIZ, arq), 'utf8');
    assert(!/(INSERT|UPDATE|DELETE)[\s\S]{0,40}rest_comanda/i.test(s),
      `${arq} escreve em rest_comandas`);
  }
  const tela = fs.readFileSync(path.join(PUB, 'catalogo/catalogo-online.html'), 'utf8');
  assert(!/rest_|comanda|garcom|mesa|cozinha|KDS|gorjeta/i.test(tela.replace(/<!--[\s\S]*?-->/g, '')),
    'a central levou vocabulário de restaurante');
});

// ============================================================================
// M. Migration
// ============================================================================

t('M0. a coluna nova esta onde alcanca TENANT QUE JA EXISTE', () => {
  // ── O defeito que os 18 testes verdes não pegaram ─────────────────────────
  //
  // `destaqueNaLoja` foi criada só em `migrarLojaDB`. O harness chama essa
  // função explicitamente, então o teste passava; a PRODUÇÃO não a chama — o
  // `migrar()` dos *-routes.js é no-op em multi-tenant, porque no registro das
  // rotas o `db` ainda é o proxy sem contexto de tenant. Resultado: a coluna
  // não existia em nenhum dos 19 tenants e a central quebrava em
  // "no such column: p.destaqueNaLoja".
  //
  // Quem alcança tenant existente é `initSchema` (db-schema.js), que roda por
  // tenant no boot. É lá que a coluna precisa estar.
  const schema = fs.readFileSync(path.join(RAIZ, 'db-schema.js'), 'utf8');
  // Recorta de trás para a frente: o `for (const col of [` mais PRÓXIMO do
  // `ALTER TABLE produtos`. Buscar do início pegava o bloco de `pedidos` e
  // arrastava 4.487 caracteres junto.
  const fim = schema.indexOf(']) alterSafe(db, `ALTER TABLE produtos ADD COLUMN');
  assert(fim > 0, 'o bloco de colunas de `produtos` sumiu do db-schema');
  const ini = schema.lastIndexOf('for (const col of [', fim);
  // Sem comentários: este bloco EXPLICA o defeito citando o nome das colunas, e
  // a busca casaria com a própria explicação em vez de com a lista.
  const bloco = schema.slice(ini, fim)
    .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const col of ['destaqueNaLoja', 'publicadoNaLoja']) {
    assert(bloco.includes(col),
      `${col} não está na lista do db-schema — não chegaria a tenant que já existe`);
  }
});

t('M0b. a central le apenas colunas que o db-schema garante', () => {
  // Generaliza a lição: toda coluna de `produtos` que a central consulta tem de
  // existir no CREATE TABLE ou na lista de ALTERs do db-schema.
  const schema = fs.readFileSync(path.join(RAIZ, 'db-schema.js'), 'utf8');
  const rotas = fs.readFileSync(path.join(RAIZ, 'loja-routes.js'), 'utf8');
  const sql = /app\.get\('\/api\/loja\/catalogo'[\s\S]*?\.all\(\)/.exec(rotas);
  assert(sql, 'a consulta da central sumiu');
  const colunas = [...sql[0].matchAll(/\bp\.(\w+)/g)].map((m) => m[1]);
  assert(colunas.length >= 6, 'não encontrei as colunas da consulta');
  for (const c of new Set(colunas)) {
    assert(new RegExp(`\\b${c}\\b`).test(schema),
      `a central lê produtos.${c}, que o db-schema não garante em tenant existente`);
  }
});

t('M. a unica mudanca de schema e aditiva, com default', () => {
  const rotas = fs.readFileSync(path.join(RAIZ, 'loja-routes.js'), 'utf8');
  assert(/ALTER TABLE produtos ADD COLUMN destaqueNaLoja INTEGER DEFAULT 0/.test(rotas),
    'a migration do destaque mudou de forma');
  // Aditiva de verdade: nada de DROP, RENAME ou NOT NULL sem default.
  const alters = rotas.match(/ALTER TABLE[^;'`]*/g) || [];
  for (const a of alters) {
    assert(/ADD COLUMN/.test(a), `ALTER que não é ADD COLUMN: ${a}`);
    assert(!/NOT NULL/.test(a) || /DEFAULT/.test(a), `coluna NOT NULL sem default: ${a}`);
  }
  assert(!/DROP TABLE|DROP COLUMN|RENAME TO/.test(rotas), 'apareceu DDL destrutivo');
});

// ============================================================================
// N. Isolamento entre tenants
// ============================================================================

t('N. publicar num tenant nao alcanca o outro', () => {
  const a = montar('n_a'), b = montar('n_b');
  const ida = seed(a.db, { sku: 'X', descricao: 'P', categoria: 'C' });
  const idb = seed(b.db, { sku: 'X', descricao: 'P', categoria: 'C' });
  a.chamar('/api/loja/produtos/publicar', 'post', { body: { ids: [ida], publicado: true } });
  a.chamar('/api/loja/produtos/destacar', 'post', { body: { ids: [ida], destaque: true } });

  assert(a.db.prepare('SELECT publicadoNaLoja p FROM produtos WHERE id=?').get(ida).p === 1, 'não publicou em A');
  assert(b.db.prepare('SELECT publicadoNaLoja p FROM produtos WHERE id=?').get(idb).p === 0,
    'o tenant B foi publicado junto');
  assert(b.db.prepare('SELECT destaqueNaLoja d FROM produtos WHERE id=?').get(idb).d === 0,
    'o destaque atravessou para o tenant B');
  assert(b.chamar('/api/loja/catalogo', 'get').corpo.resumo.publicados === 0,
    'a central de B enxerga publicação de A');
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
