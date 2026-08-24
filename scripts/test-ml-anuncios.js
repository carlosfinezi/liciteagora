/**
 * Criação de anúncio no ML a partir do catálogo, com IA escrevendo o texto.
 * A API do ML e os provedores de IA são injetados — o teste não sai para a
 * rede, e é justamente por isso que dá para testar o caminho do erro.
 */
const fs = require('fs');
const Database = require('better-sqlite3');
const A = require('../marketplaces-ml-anuncios');

const DB = '/tmp/vp-mlanuncio.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-mlanuncio-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec(`CREATE TABLE IF NOT EXISTS ml_item_map (mlItemId TEXT PRIMARY KEY, produtoId INTEGER,
  sku TEXT, titulo TEXT, qtdML INTEGER, ultimoPushEm TEXT, atualizadoEm TEXT)`);
A.migrarAnunciosDB(db);

let ok = 0, fail = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- dublês ----------
const CATEGORIA = { category_id: 'MLB1051', category_name: 'Celulares e Smartphones', domain_name: 'Celulares' };
const CATALOGO = {
  id: 'MLB19999888', name: 'Smartphone Marca X Modelo Y 128 GB Preto', domain_id: 'MLB-CELLPHONES',
  attributes: [{ id: 'BRAND', name: 'Marca', value_name: 'Marca X' },
               { id: 'MODEL', name: 'Modelo', value_name: 'Modelo Y' },
               { id: 'COLOR', name: 'Cor', value_name: 'Preto' }],
  pictures: [{ url: 'https://http2.mlstatic.com/foto-oficial.jpg' }],
};
const ATRIBUTOS = [
  { id: 'BRAND', name: 'Marca', value_type: 'string', tags: { required: true } },
  { id: 'MODEL', name: 'Modelo', value_type: 'string', tags: { required: true } },
  { id: 'COLOR', name: 'Cor', value_type: 'list', tags: {}, values: [{ name: 'Preto' }, { name: 'Azul' }] },
];

function fakeML(cfg = {}) {
  const chamadas = [];
  return {
    chamadas,
    fetchJson: async (url, opts = {}) => {
      chamadas.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      if (url.includes('domain_discovery')) {
        return cfg.semCategoria ? { ok: true, status: 200, json: [] }
                                : { ok: true, status: 200, json: [CATEGORIA] };
      }
      if (url.includes('/attributes')) return { ok: true, status: 200, json: ATRIBUTOS };
      if (url.includes('/products/search')) {
        return cfg.semCatalogo || !CATALOGO
          ? { ok: true, status: 200, json: { results: [] } }
          : { ok: true, status: 200, json: { results: [{ id: CATALOGO.id, name: CATALOGO.name }] } };
      }
      if (/\/products\/MLB/.test(url)) return { ok: true, status: 200, json: CATALOGO };
      if (url.endsWith('/items')) {
        return cfg.erroPost
          ? { ok: false, status: 400, json: { message: null, cause: [{ message: 'Item attributes.BRAND is required' }] } }
          : { ok: true, status: 201, json: { id: 'MLB999888', permalink: 'https://ml.com/MLB999888' } };
      }
      if (url.includes('/description')) return { ok: !cfg.erroDescricao, status: cfg.erroDescricao ? 500 : 200, json: {} };
      return { ok: false, status: 404, json: null };
    },
  };
}

// IA dublê: devolve o que o prompt pediria, e registra o prompt recebido.
function fakeIA(resposta, capturado = {}) {
  return {
    chamarCerebras: async (_k, prompt) => { capturado.prompt = prompt; return resposta; },
    chamarGemini: async () => null, chamarDeepSeek: async () => null,
    chamarGroq: async () => null, chamarClaude: async () => null,
  };
}

const RESPOSTA_BOA = {
  titulo: 'Smartphone Marca X Modelo Y 128GB Preto',
  descricao: 'Aparelho novo, lacrado.\n\nGarantia de 12 meses.',
  atributos: [{ id: 'BRAND', value_name: 'Marca X' }, { id: 'MODEL', value_name: 'Modelo Y' },
              { id: 'COLOR', value_name: 'Preto' }],
  faltando: [], confianca: 0.9,
};

// ---------- seed ----------
// codigoBarras vazio por padrão: sem GTIN não há consulta ao catálogo, e os
// testes de anúncio comum seguem exercitando o caminho sem catálogo.
const novoProduto = (sku, o = {}) => db.prepare(`INSERT INTO produtos
  (sku, descricao, unidade, ativo, precoVenda, precoCusto, markupVenda, marca, modelo, cor, codigoBarras, imagemPath)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(sku, o.descricao || 'Smartphone teste', 'UN',
    o.ativo === 0 ? 0 : 1, o.precoVenda ?? 1500, o.precoCusto ?? 0, o.markupVenda ?? 0,
    o.marca === null ? null : (o.marca ?? 'Marca X'), o.modelo === null ? null : (o.modelo ?? 'Modelo Y'),
    'Preto', o.codigoBarras ?? null,
    o.imagemPath === null ? null : (o.imagemPath ?? '/uploads/p1.jpg')).lastInsertRowid;

const darEstoque = (produtoId, qtd) => db.prepare(`INSERT INTO movimentacoes_estoque
  (produtoId, tipo, quantidade, custoUnitario, origem, data) VALUES (?,'entrada',?,10,'ajuste_manual',date('now'))`)
  .run(produtoId, qtd);

const P_OK = novoProduto('SKU-OK'); darEstoque(P_OK, 10);
const P_SEM_FOTO = novoProduto('SKU-SEMFOTO', { imagemPath: null }); darEstoque(P_SEM_FOTO, 5);
const P_SEM_PRECO = novoProduto('SKU-SEMPRECO', { precoVenda: 0 }); darEstoque(P_SEM_PRECO, 5);
const P_SEM_ESTOQUE = novoProduto('SKU-SEMEST');
const P_INATIVO = novoProduto('SKU-OFF', { ativo: 0 });

const OPTS = (cfg = {}, ia = RESPOSTA_BOA, cap = {}) => {
  const ml = fakeML(cfg);
  return { ml, opts: { keys: { cerebras: 'k' }, baseUrl: 'https://loja.exemplo.com',
                       fetchJson: ml.fetchJson, ia: fakeIA(ia, cap) } };
};

(async () => {

// ---------- categoria vem do ML, não da IA ----------
await t('a categoria é a que o Mercado Livre sugere', async () => {
  const { ml, opts } = OPTS();
  const r = await A.gerarRascunho(db, P_OK, opts);
  assert(r.categoriaId === 'MLB1051', 'categoria: ' + r.categoriaId);
  assert(ml.chamadas[0].url.includes('domain_discovery'), 'não consultou o preditor do ML');
});

await t('sem categoria sugerida, o rascunho não é inventado', async () => {
  const { opts } = OPTS({ semCategoria: true });
  let erro = null;
  try { await A.gerarRascunho(db, P_OK, opts); } catch (e) { erro = e.message; }
  assert(/não sugeriu categoria/.test(erro || ''), 'erro: ' + erro);
});

// ---------- prompt ----------
await t('o prompt leva os atributos obrigatórios e proíbe inventar', async () => {
  const cap = {};
  const { opts } = OPTS({}, RESPOSTA_BOA, cap);
  await A.gerarRascunho(db, P_OK, opts);
  assert(/BRAND \(Marca\)/.test(cap.prompt), 'atributo obrigatório ausente do prompt');
  assert(/valores aceitos: Preto, Azul/.test(cap.prompt), 'domínio de valores ausente');
  assert(/NÃO INVENTE/.test(cap.prompt), 'prompt não proíbe inventar atributo');
  assert(/MLB1051/.test(cap.prompt), 'categoria não foi fixada no prompt');
});

// ---------- limites do ML ----------
await t('título acima de 60 caracteres é cortado, não recusado pelo ML depois', async () => {
  const longo = { ...RESPOSTA_BOA, titulo: 'A'.repeat(120) };
  const { opts } = OPTS({}, longo);
  const r = await A.gerarRascunho(db, P_OK, opts);
  assert(r.titulo.length <= A.MAX_TITULO, 'ficou com ' + r.titulo.length);
});

await t('atributo que não existe na categoria é descartado', async () => {
  const comLixo = { ...RESPOSTA_BOA, atributos: [
    { id: 'BRAND', value_name: 'Marca X' }, { id: 'MODEL', value_name: 'Modelo Y' },
    { id: 'INVENTADO', value_name: 'xxx' }] };
  const { opts } = OPTS({}, comLixo);
  const r = await A.gerarRascunho(db, P_OK, opts);
  const ids = JSON.parse(r.atributos).map(a => a.id);
  assert(!ids.includes('INVENTADO'), 'atributo inexistente vazou: ' + ids.join(','));
  assert(ids.includes('BRAND'), 'perdeu o atributo válido');
});

await t('atributo sem valor não conta como preenchido', async () => {
  const vazio = { ...RESPOSTA_BOA, atributos: [{ id: 'BRAND', value_name: '  ' }, { id: 'MODEL', value_name: 'M' }] };
  const { opts } = OPTS({}, vazio);
  const r = await A.gerarRascunho(db, P_OK, opts);
  assert(r.bloqueios.some(b => /BRAND|Marca/.test(b)), 'bloqueios: ' + JSON.stringify(r.bloqueios));
});

// ---------- validação ----------
await t('produto sem imagem é barrado antes de tentar publicar', async () => {
  const { opts } = OPTS();
  const r = await A.gerarRascunho(db, P_SEM_FOTO, opts);
  assert(r.bloqueios.some(b => /imagem/i.test(b)), 'bloqueios: ' + JSON.stringify(r.bloqueios));
});

await t('produto sem preço e sem estoque acumula os dois bloqueios', async () => {
  const { opts } = OPTS();
  const semPreco = await A.gerarRascunho(db, P_SEM_PRECO, opts);
  assert(semPreco.bloqueios.some(b => /preço/i.test(b)), JSON.stringify(semPreco.bloqueios));
  const semEst = await A.gerarRascunho(db, P_SEM_ESTOQUE, opts);
  assert(semEst.bloqueios.some(b => /saldo/i.test(b)), JSON.stringify(semEst.bloqueios));
});

await t('produto inativo não vira anúncio', async () => {
  const { opts } = OPTS();
  let erro = null;
  try { await A.gerarRascunho(db, P_INATIVO, opts); } catch (e) { erro = e.message; }
  assert(/inativo/.test(erro || ''), 'erro: ' + erro);
});

await t('rascunho bom não tem bloqueio', async () => {
  const { opts } = OPTS();
  const r = await A.gerarRascunho(db, P_OK, opts);
  assert(r.bloqueios.length === 0, 'bloqueios: ' + JSON.stringify(r.bloqueios));
  assert(r.quantidade === 10, 'quantidade veio do saldo: ' + r.quantidade);
  assert(r.preco === 1500, 'preço: ' + r.preco);
  assert(JSON.parse(r.fotos)[0] === 'https://loja.exemplo.com/uploads/p1.jpg', 'foto: ' + r.fotos);
});

await t('sem nenhuma chave de IA, diz o que fazer', async () => {
  const ml = fakeML();
  let erro = null;
  try {
    await A.gerarRascunho(db, P_OK, { keys: {}, baseUrl: 'https://x.com', fetchJson: ml.fetchJson, ia: fakeIA(RESPOSTA_BOA) });
  } catch (e) { erro = e.message; }
  assert(/chaves em Configurações/.test(erro || ''), 'erro: ' + erro);
});

await t('provedor que falha cai para o próximo', async () => {
  const ml = fakeML();
  const ia = {
    chamarCerebras: async () => { throw new Error('429'); },
    chamarGemini: async () => null,
    chamarDeepSeek: async () => RESPOSTA_BOA,
    chamarGroq: async () => null, chamarClaude: async () => null,
  };
  const r = await A.gerarRascunho(db, P_OK, { keys: { cerebras: 'a', gemini: 'b', deepseek: 'c' },
    baseUrl: 'https://x.com', fetchJson: ml.fetchJson, ia });
  assert(r.geradoPor === 'deepseek', 'provider: ' + r.geradoPor);
});

// ---------- publicação ----------
await t('publicar monta o corpo que o ML espera e grava o SKU', async () => {
  const { ml, opts } = OPTS();
  await A.gerarRascunho(db, P_OK, opts);
  const a = db.prepare('SELECT id FROM ml_anuncios WHERE produtoId=?').get(P_OK);
  const r = await A.publicarRascunho(db, a.id, { token: 'TOK', fetchJson: ml.fetchJson });
  assert(r.mlItemId === 'MLB999888', 'id: ' + r.mlItemId);

  const post = ml.chamadas.find(c => c.method === 'POST' && c.url.endsWith('/items'));
  assert(post.body.category_id === 'MLB1051', 'categoria no corpo');
  assert(post.body.currency_id === 'BRL' && post.body.condition === 'new', JSON.stringify(post.body));
  assert(post.body.available_quantity === 10, 'quantidade: ' + post.body.available_quantity);
  assert(post.body.pictures.length === 1 && post.body.pictures[0].source, 'fotos no formato errado');
  // Sem SELLER_SKU o pedido importado não casa com o produto nem sincroniza estoque.
  assert(post.body.attributes.some(x => x.id === 'SELLER_SKU' && x.value_name === 'SKU-OK'), 'SELLER_SKU ausente');
});

await t('publicar alimenta o mapa que o sync de estoque usa', async () => {
  const m = db.prepare('SELECT * FROM ml_item_map WHERE mlItemId=?').get('MLB999888');
  assert(m && m.produtoId === P_OK && m.sku === 'SKU-OK', 'mapa: ' + JSON.stringify(m));
});

await t('anúncio já publicado não é publicado de novo', async () => {
  const { ml } = OPTS();
  const a = db.prepare('SELECT id FROM ml_anuncios WHERE produtoId=?').get(P_OK);
  let erro = null;
  try { await A.publicarRascunho(db, a.id, { token: 'TOK', fetchJson: ml.fetchJson }); } catch (e) { erro = e.message; }
  assert(/Já publicado/.test(erro || ''), 'erro: ' + erro);
});

await t('rascunho com pendência não é publicado', async () => {
  const { ml, opts } = OPTS();
  await A.gerarRascunho(db, P_SEM_FOTO, opts);
  const a = db.prepare('SELECT id FROM ml_anuncios WHERE produtoId=?').get(P_SEM_FOTO);
  let erro = null;
  try { await A.publicarRascunho(db, a.id, { token: 'TOK', fetchJson: ml.fetchJson }); } catch (e) { erro = e.message; }
  assert(/pendência/.test(erro || ''), 'erro: ' + erro);
  assert(!ml.chamadas.some(c => c.method === 'POST' && c.url.endsWith('/items')), 'chegou a chamar o ML mesmo assim');
});

await t('sem token, não tenta publicar', async () => {
  const { ml, opts } = OPTS();
  const pid = novoProduto('SKU-TOK'); darEstoque(pid, 3);
  await A.gerarRascunho(db, pid, opts);
  const a = db.prepare('SELECT id FROM ml_anuncios WHERE produtoId=?').get(pid);
  let erro = null;
  try { await A.publicarRascunho(db, a.id, { token: null, fetchJson: ml.fetchJson }); } catch (e) { erro = e.message; }
  assert(/reconecte/.test(erro || ''), 'erro: ' + erro);
});

await t('recusa do ML é guardada com o motivo dele', async () => {
  const { ml, opts } = OPTS({ erroPost: true });
  const pid = novoProduto('SKU-ERRO'); darEstoque(pid, 4);
  await A.gerarRascunho(db, pid, opts);
  const a = db.prepare('SELECT id FROM ml_anuncios WHERE produtoId=?').get(pid);
  let erro = null;
  try { await A.publicarRascunho(db, a.id, { token: 'TOK', fetchJson: ml.fetchJson }); } catch (e) { erro = e.message; }
  assert(/BRAND is required/.test(erro || ''), 'erro: ' + erro);
  const salvo = db.prepare('SELECT status, erro FROM ml_anuncios WHERE id=?').get(a.id);
  assert(salvo.status === 'erro' && /BRAND/.test(salvo.erro), 'não guardou o motivo: ' + JSON.stringify(salvo));
});

await t('descrição que falha não some — o anúncio existe e o aviso fica', async () => {
  const { ml, opts } = OPTS({ erroDescricao: true });
  const pid = novoProduto('SKU-DESC'); darEstoque(pid, 2);
  await A.gerarRascunho(db, pid, opts);
  const a = db.prepare('SELECT id FROM ml_anuncios WHERE produtoId=?').get(pid);
  const r = await A.publicarRascunho(db, a.id, { token: 'TOK', fetchJson: ml.fetchJson });
  assert(r.mlItemId, 'deveria ter publicado mesmo assim');
  assert(/descrição não subiu/.test(r.aviso || ''), 'aviso: ' + r.aviso);
  const salvo = db.prepare('SELECT status, erro FROM ml_anuncios WHERE id=?').get(a.id);
  assert(salvo.status === 'publicado', 'status: ' + salvo.status);
});

// ---------- candidatos ----------
await t('lista de candidatos aponta o que falta em cada produto', async () => {
  const lista = A.candidatos(db);
  const semFoto = lista.find(p => p.sku === 'SKU-SEMFOTO');
  assert(semFoto.pendencias.includes('sem imagem'), JSON.stringify(semFoto.pendencias));
  const semEst = lista.find(p => p.sku === 'SKU-SEMEST');
  assert(semEst.pendencias.includes('sem saldo em estoque'), JSON.stringify(semEst.pendencias));
  const bom = lista.find(p => p.sku === 'SKU-OK');
  assert(bom.pronto && bom.anuncioStatus === 'publicado', JSON.stringify(bom));
  assert(!lista.some(p => p.sku === 'SKU-OFF'), 'produto inativo não deveria aparecer');
});


// ==================== CATÁLOGO DO ML E SUGESTÕES ====================

await t('GTIN inválido não vira consulta ao catálogo', async () => {
  assert(A.gtinValido('123') === null, 'curto demais passou');
  assert(A.gtinValido('789.1234-567890') === '7891234567890', 'não normalizou');
  assert(A.gtinValido(null) === null, 'nulo passou');
});

await t('produto com GTIN casa no catálogo e herda a foto oficial', async () => {
  const pid = novoProduto('SKU-CAT', { codigoBarras: '7891234567890', imagemPath: null });
  darEstoque(pid, 7);
  const { opts } = OPTS();
  const r = await A.gerarRascunho(db, pid, opts);
  assert(r.catalogProductId === 'MLB19999888', 'catalogo: ' + r.catalogProductId);
  // Sem foto propria, mas o catalogo resolve — nao pode virar bloqueio.
  assert(!r.bloqueios.some(b => /imagem/i.test(b)), 'bloqueios: ' + JSON.stringify(r.bloqueios));
  assert(JSON.parse(r.fotos)[0].includes('mlstatic'), 'nao usou a foto oficial: ' + r.fotos);
});

await t('anúncio de catálogo publica sem título e sem foto próprios', async () => {
  const { ml, opts } = OPTS();
  const pid = novoProduto('SKU-CAT2', { codigoBarras: '7891234567890', imagemPath: null });
  darEstoque(pid, 3);
  await A.gerarRascunho(db, pid, opts);
  const a = db.prepare('SELECT id FROM ml_anuncios WHERE produtoId=?').get(pid);
  await A.publicarRascunho(db, a.id, { token: 'TOK', fetchJson: ml.fetchJson });
  const post = ml.chamadas.find(c => c.method === 'POST' && c.url.endsWith('/items'));
  assert(post.body.catalog_product_id === 'MLB19999888', 'sem catalog_product_id');
  assert(post.body.catalog_listing === true, 'nao marcou catalog_listing');
  // Mandar titulo/foto em anuncio de catalogo faz o ML recusar.
  assert(!post.body.title && !post.body.pictures, 'mandou titulo ou foto junto');
});

await t('sem GTIN não consulta catálogo e segue o caminho normal', async () => {
  const { ml, opts } = OPTS();
  const pid = novoProduto('SKU-SEMGTIN'); darEstoque(pid, 2);
  const r = await A.gerarRascunho(db, pid, opts);
  assert(!r.catalogProductId, 'nao deveria ter catalogo');
  assert(!ml.chamadas.some(c => c.url.includes('/products/search')), 'consultou o catalogo a toa');
});

await t('preço sai do markup, sem precisar de IA', async () => {
  const p = A.precoPorMarkup({ precoCusto: 1000, markupVenda: 30 });
  assert(p.valor === 1300, 'valor: ' + p.valor);
  assert(/markup 30%/.test(p.observacao), 'observacao: ' + p.observacao);
  assert(A.precoPorMarkup({ precoCusto: 0, markupVenda: 30 }) === null, 'sem custo deveria devolver null');
  assert(A.precoPorMarkup({ precoCusto: 100, markupVenda: 0 }) === null, 'sem markup deveria devolver null');
});

await t('sugestão vem do catálogo, do markup e da IA, cada uma marcada', async () => {
  const pid = novoProduto('SKU-SUG', { codigoBarras: '7891234567890', marca: null, modelo: null,
    precoVenda: 0, precoCusto: 200, markupVenda: 50 });
  const ml = fakeML();
  const ia = { chamarCerebras: async () => ({ sugestoes: [
      { campo: 'pesoBruto', valor: 0.35, confianca: 0.6, base: 'porte tipico de smartphone' },
      { campo: 'ncm', valor: '85171231', confianca: 0.8, base: 'aparelho celular' }] }),
    chamarGemini: async () => null, chamarDeepSeek: async () => null,
    chamarGroq: async () => null, chamarClaude: async () => null };
  const r = await A.sugerirDadosProduto(db, pid, { keys: { cerebras: 'k' }, fetchJson: ml.fetchJson, ia });

  const por = (c) => r.sugestoes.find(s => s.campo === c);
  assert(por('marca') && por('marca').fonte === 'catalogo-ml', 'marca deveria vir do catalogo');
  assert(por('marca').valor === 'Marca X', 'marca: ' + por('marca').valor);
  assert(por('precoVenda') && por('precoVenda').fonte === 'markup' && por('precoVenda').valor === 300,
    JSON.stringify(por('precoVenda')));
  assert(por('pesoBruto') && String(por('pesoBruto').fonte).startsWith('ia:'), 'peso deveria vir da IA');
  assert(r.fotoResolvidaPeloCatalogo === true, 'catalogo tem foto e deveria resolver');
});

await t('estimativa de peso vem com aviso de frete', async () => {
  const pid = novoProduto('SKU-PESO', { marca: null });
  const ml = fakeML({ semCatalogo: true });
  const ia = { chamarCerebras: async () => ({ sugestoes: [
      { campo: 'pesoBruto', valor: 1.2, confianca: 0.4, base: 'estimativa' },
      { campo: 'material', valor: 'Plastico', confianca: 0.7, base: 'comum na categoria' }] }),
    chamarGemini: async () => null, chamarDeepSeek: async () => null,
    chamarGroq: async () => null, chamarClaude: async () => null };
  const r = await A.sugerirDadosProduto(db, pid, { keys: { cerebras: 'k' }, fetchJson: ml.fetchJson, ia });
  const peso = r.sugestoes.find(s => s.campo === 'pesoBruto');
  assert(/frete/i.test(peso.aviso || ''), 'peso sem aviso de frete: ' + JSON.stringify(peso));
  const mat = r.sugestoes.find(s => s.campo === 'material');
  assert(!mat.aviso, 'material nao precisa de aviso de frete');
});

await t('sugestão não sobrescreve campo já preenchido', async () => {
  const pid = novoProduto('SKU-CHEIO', { marca: 'Marca Real' });
  const ml = fakeML({ semCatalogo: true });
  const ia = { chamarCerebras: async () => ({ sugestoes: [{ campo: 'marca', valor: 'Outra', confianca: 0.9 }] }),
    chamarGemini: async () => null, chamarDeepSeek: async () => null,
    chamarGroq: async () => null, chamarClaude: async () => null };
  const r = await A.sugerirDadosProduto(db, pid, { keys: { cerebras: 'k' }, fetchJson: ml.fetchJson, ia });
  assert(!r.sugestoes.some(s => s.campo === 'marca'), 'sugeriu por cima do que ja existia');
});

await t('aplicar grava só os campos escolhidos e recusa campo desconhecido', async () => {
  const pid = novoProduto('SKU-APLICA', { marca: null, precoVenda: 0 });
  A.aplicarSugestoes(db, pid, { marca: 'Aplicada', pesoBruto: '0.5', ativo: 0, qualquerCoisa: 'x' });
  const p = db.prepare('SELECT marca, pesoBruto, ativo FROM produtos WHERE id=?').get(pid);
  assert(p.marca === 'Aplicada' && p.pesoBruto === 0.5, JSON.stringify(p));
  assert(p.ativo === 1, 'campo fora da lista foi gravado');
  let erro = null;
  try { A.aplicarSugestoes(db, pid, { naoExiste: 1 }); } catch (e) { erro = e.message; }
  assert(/Nenhum campo/.test(erro || ''), 'erro: ' + erro);
});

await t('sem chave de IA, ainda sugere o que catálogo e markup dão', async () => {
  const pid = novoProduto('SKU-SEMIA', { codigoBarras: '7891234567890', marca: null,
    precoVenda: 0, precoCusto: 100, markupVenda: 20 });
  const ml = fakeML();
  const r = await A.sugerirDadosProduto(db, pid, { keys: {}, fetchJson: ml.fetchJson });
  assert(r.sugestoes.some(s => s.fonte === 'catalogo-ml'), 'perdeu o catalogo');
  assert(r.sugestoes.some(s => s.fonte === 'markup' && s.valor === 120), 'perdeu o markup');
  assert(!r.sugestoes.some(s => String(s.fonte).startsWith('ia:')), 'inventou IA sem chave');
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
})();
