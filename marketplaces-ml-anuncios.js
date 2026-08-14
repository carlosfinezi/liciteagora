/**
 * marketplaces-ml-anuncios.js — cria anúncios no Mercado Livre a partir do
 * catálogo do ERP, com a IA escrevendo título, descrição e atributos.
 *
 * Fluxo: produto → rascunho (IA) → revisão → publicação.
 *
 * O rascunho existe de propósito. Publicar no ML é ato público e caro de
 * desfazer: cria oferta com preço, compromete estoque e o anúncio passa a
 * aparecer para comprador. Texto de IA vai para revisão humana antes de virar
 * oferta — a automação está em gerar, não em publicar sem olhar.
 *
 * A categoria NÃO é adivinhada pela IA: vem do próprio preditor do ML
 * (domain_discovery), que conhece a árvore e é reavaliado a cada mudança. A IA
 * cuida do que ela faz bem — redação e preenchimento de atributos a partir dos
 * campos do produto.
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.mercadolibre.com';
const SITE = 'MLB';

// Limites do ML. Título acima disso é recusado no POST /items.
const MAX_TITULO = 60;
const MAX_DESCRICAO = 50000;

function migrarAnunciosDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ml_anuncios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'rascunho',
      titulo TEXT,
      categoriaId TEXT,
      categoriaNome TEXT,
      descricao TEXT,
      atributos TEXT,
      preco REAL,
      quantidade INTEGER,
      listingTypeId TEXT DEFAULT 'gold_special',
      condicao TEXT DEFAULT 'new',
      fotos TEXT,
      mlItemId TEXT,
      permalink TEXT,
      geradoPor TEXT,
      geradoEm TEXT,
      revisadoPor TEXT,
      publicadoEm TEXT,
      erro TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_mlanuncio_status ON ml_anuncios(status);
  `);
  // Anúncio de catálogo: o item se pendura num produto oficial do ML e herda
  // dele foto e ficha técnica. É a saída legítima para quem não tem foto
  // própria — copiar imagem de outro anúncio derruba a conta.
  try { db.exec('ALTER TABLE ml_anuncios ADD COLUMN catalogProductId TEXT'); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

const jsonOuVazio = (t, padrao) => { try { return t ? JSON.parse(t) : padrao; } catch { return padrao; } };

// ==================== API DO ML ====================

async function mlJson(url, opts = {}) {
  const r = await fetch(url, opts);
  let json = null;
  try { json = await r.json(); } catch { /* corpo não-JSON */ }
  return { ok: r.ok, status: r.status, json };
}

/**
 * Categoria sugerida pelo próprio ML a partir de um texto livre.
 * Preferir isto a pedir para a IA "chutar" um MLBxxxx: id inválido derruba a
 * publicação inteira, e a árvore de categorias muda sem aviso.
 */
async function preverCategoria(texto, { fetchJson = mlJson } = {}) {
  const q = encodeURIComponent(String(texto || '').slice(0, 200));
  const r = await fetchJson(`${API_BASE}/sites/${SITE}/domain_discovery/search?limit=1&q=${q}`);
  const primeiro = Array.isArray(r.json) ? r.json[0] : null;
  if (!r.ok || !primeiro?.category_id) return null;
  return { id: primeiro.category_id, nome: primeiro.category_name || null,
           dominio: primeiro.domain_name || null };
}

/** Atributos que a categoria exige (e os que ajudam), para guiar a IA. */
async function atributosCategoria(categoriaId, { fetchJson = mlJson } = {}) {
  const r = await fetchJson(`${API_BASE}/categories/${encodeURIComponent(categoriaId)}/attributes`);
  if (!r.ok || !Array.isArray(r.json)) return { obrigatorios: [], opcionais: [] };
  const tag = (a, t) => !!(a.tags && a.tags[t]);
  const util = a => ({
    id: a.id, nome: a.name, tipo: a.value_type,
    valores: (a.values || []).slice(0, 40).map(v => v.name).filter(Boolean),
  });
  return {
    obrigatorios: r.json.filter(a => tag(a, 'required')).map(util),
    // Além dos que ajudam a ranquear, entram os de lista fechada: é neles que
    // a IA mais erra, porque valor fora do domínio faz o ML recusar o item —
    // e ela só respeita a lista se a lista chegar no prompt.
    opcionais: r.json
      .filter(a => !tag(a, 'required'))
      .filter(a => tag(a, 'catalog_required') || tag(a, 'allow_variations') || (a.values || []).length)
      .slice(0, 20).map(util),
  };
}

// ==================== IA ====================

/**
 * Tenta os providers na mesma ordem de analise-ia.js, reusando aqueles
 * chamadores (que já tratam 429 e cooldown). Devolve { json, provider }.
 */
async function gerarJsonComIA(keys, prompt, { ia = null, log = () => {} } = {}) {
  const mod = ia || require('./analise-ia');
  const cadeia = [
    ['cerebras', mod.chamarCerebras], ['gemini', mod.chamarGemini],
    ['deepseek', mod.chamarDeepSeek], ['groq', mod.chamarGroq],
    ['anthropic', mod.chamarClaude],
  ];
  for (const [nome, fn] of cadeia) {
    if (!keys || !keys[nome] || typeof fn !== 'function') continue;
    try {
      const json = await fn(keys[nome], prompt);
      if (json && typeof json === 'object') return { json, provider: nome };
      log(`[ML-IA] ${nome} não retornou JSON — tentando o próximo`);
    } catch (e) {
      log(`[ML-IA] ${nome} falhou: ${(e.message || '').slice(0, 120)}`);
    }
  }
  return { json: null, provider: null };
}

function montarPrompt(produto, categoria, atributos) {
  const campos = [
    ['SKU', produto.sku], ['Descrição', produto.descricao], ['Marca', produto.marca],
    ['Modelo', produto.modelo], ['Cor', produto.cor], ['Material', produto.material],
    ['Gênero', produto.genero], ['Categoria interna', produto.categoria],
    ['GTIN/EAN', produto.codigoBarras], ['NCM', produto.ncm],
    ['Peso bruto (kg)', produto.pesoBruto],
    ['Dimensões (A x L x P cm)', [produto.altura, produto.largura, produto.profundidade].filter(Boolean).join(' x ')],
    ['Observações', produto.observacoes],
  ].filter(([, v]) => v != null && String(v).trim() !== '')
   .map(([k, v]) => `- ${k}: ${v}`).join('\n');

  const listaAttr = (arr) => arr.map(a => {
    const dom = a.valores?.length ? ` | valores aceitos: ${a.valores.join(', ')}` : '';
    return `- ${a.id} (${a.nome})${dom}`;
  }).join('\n') || '- (nenhum)';

  return `Você prepara anúncios para o Mercado Livre Brasil. Responda SOMENTE com JSON.

DADOS DO PRODUTO (do ERP do vendedor):
${campos || '- (cadastro quase vazio)'}

CATEGORIA JÁ DEFINIDA PELO MERCADO LIVRE: ${categoria.id}${categoria.nome ? ` (${categoria.nome})` : ''}
Não troque a categoria.

ATRIBUTOS OBRIGATÓRIOS DESSA CATEGORIA:
${listaAttr(atributos.obrigatorios)}

ATRIBUTOS QUE AJUDAM NA BUSCA (opcionais):
${listaAttr(atributos.opcionais)}

REGRAS:
1. "titulo": no máximo ${MAX_TITULO} caracteres. Comece pelo produto, depois marca e modelo, depois o diferencial. Sem CAPS LOCK, sem emoji, sem "frete grátis", sem "promoção", sem nome de loja.
2. "descricao": texto corrido, 3 a 6 parágrafos curtos, em português do Brasil. Sem link, sem telefone, sem e-mail, sem preço — o Mercado Livre recusa isso.
3. "atributos": preencha SÓ o que os dados sustentam. Quando houver "valores aceitos", use exatamente um deles. NÃO INVENTE marca, modelo, voltagem, medida ou compatibilidade: informação errada em atributo gera reclamação e cancelamento.
4. Todo atributo obrigatório que você não conseguir preencher com segurança deve entrar em "faltando", não ser chutado.

FORMATO:
{
  "titulo": "...",
  "descricao": "...",
  "atributos": [{"id": "BRAND", "value_name": "..."}],
  "faltando": [{"id": "MODEL", "motivo": "cadastro não informa o modelo"}],
  "confianca": 0.0
}`;
}

// ==================== CATÁLOGO DO ML ====================

/** GTIN só vale consulta se tiver o comprimento de um código real. */
function gtinValido(v) {
  const d = String(v || '').replace(/\D/g, '');
  return [8, 12, 13, 14].includes(d.length) ? d : null;
}

/**
 * Dígito verificador GS1 (vale para EAN-8, UPC-12, EAN-13 e GTIN-14). O
 * `gtinValido` acima só confere o tamanho — aqui a conta tem que fechar,
 * porque é o que separa um código real de um número plausível inventado.
 */
function digitoGtinOk(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return false;
  const corpo = d.slice(0, -1), verificador = Number(d.slice(-1));
  let soma = 0;
  // Da direita para a esquerda, pesos 3 e 1 alternados.
  for (let i = corpo.length - 1, peso = 3; i >= 0; i--, peso = peso === 3 ? 1 : 3) {
    soma += Number(corpo[i]) * peso;
  }
  return ((10 - (soma % 10)) % 10) === verificador;
}

const soLetrasNum = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * GTIN vindo da nota de entrada do fornecedor. É a melhor fonte que existe
 * aqui: não é palpite, é o que veio no XML de quem vendeu o produto.
 */
function gtinDasNotas(db, produtoId) {
  try {
    return db.prepare(`
      SELECT i.ean, i.descricao, n.numero, n.dataEmissao, n.emitenteRazaoSocial
      FROM nfe_entrada_itens i
      JOIN nfe_entrada n ON n.id = i.nfeId
      WHERE i.produtoId = ?
        AND TRIM(COALESCE(i.ean,'')) NOT IN ('', 'SEM GTIN')
        AND COALESCE(n.excluida, 0) = 0
      GROUP BY i.ean
      ORDER BY n.dataEmissao DESC`).all(produtoId);
  } catch { return []; }   // instalação sem o módulo de entrada
}

/**
 * Código de barras a partir das fontes que existem, na ordem em que merecem
 * confiança: a nota de entrada do fornecedor primeiro, o palpite da IA depois.
 *
 * Um GTIN inventado é pior que campo vazio: ele casa com o produto de outra
 * empresa, e o anúncio sai errado com aparência de certo. Por isso todo
 * candidato — de qualquer fonte — passa por dois filtros que ninguém aqui
 * controla: o dígito verificador (aritmética) e o catálogo do ML (fonte
 * independente). Só é "confirmado" o código cujo produto no ML tem a MESMA
 * marca e o MESMO modelo do cadastro.
 */
async function procurarGtin(db, produtoId, opts = {}) {
  const { keys = {}, token = null, ia = null, log = () => {}, fetchJson = mlJson,
          usarIA = true } = opts;
  const produto = produtoDe(db, produtoId);
  if (!produto) throw new Error('Produto não encontrado');

  const brutos = gtinDasNotas(db, produtoId).map(n => ({
    gtin: n.ean, fonte: 'nota-de-entrada',
    detalhe: `NF ${n.numero || '?'} de ${n.emitenteRazaoSocial || 'fornecedor'}`
      + (n.dataEmissao ? ` (${String(n.dataEmissao).slice(0, 10)})` : ''),
  }));

  let provider = null;
  if (usarIA && Object.values(keys).some(Boolean)) {
    const r = await perguntarGtinIA(produto, { keys, ia, log });
    provider = r.provider;
    brutos.push(...r.candidatos.map(c => ({ gtin: c.gtin, fonte: 'ia',
      detalhe: c.origem ? String(c.origem).slice(0, 80) : null })));
  } else if (usarIA && !brutos.length) {
    throw new Error('Nenhuma chave de IA configurada e nenhuma nota de entrada com código de barras para este produto');
  }

  const marcaCad = soLetrasNum(produto.marca), modeloCad = soLetrasNum(produto.modelo || produto.sku);
  const avaliados = [];
  const vistos = new Set();
  for (const c of brutos) {
    const cod = gtinValido(c.gtin);
    if (!cod) { avaliados.push({ ...c, gtin: String(c.gtin || ''), status: 'descartado', motivo: 'não tem formato de GTIN' }); continue; }
    if (vistos.has(cod)) continue;
    vistos.add(cod);
    if (!digitoGtinOk(cod)) {
      avaliados.push({ ...c, gtin: cod, status: 'descartado',
        motivo: c.fonte === 'nota-de-entrada'
          ? 'dígito verificador não fecha — o fornecedor informou um código errado na nota'
          : 'dígito verificador não fecha — código inexistente' });
      continue;
    }
    const cat = await buscarNoCatalogoML(cod, { fetchJson, token });
    if (!cat) {
      avaliados.push({ ...c, gtin: cod,
        status: c.fonte === 'nota-de-entrada' ? 'da-nota' : 'nao-confirmado',
        motivo: c.fonte === 'nota-de-entrada'
          ? 'veio da nota do fornecedor; o Mercado Livre não tem este código catalogado, o que é comum e não invalida'
          : 'o dígito fecha, mas o Mercado Livre não tem produto com este código — pode ser válido e não catalogado, ou pode não existir' });
      continue;
    }
    const marcaML = soLetrasNum(attrDoCatalogo(cat, 'BRAND'));
    const modeloML = soLetrasNum(attrDoCatalogo(cat, 'MODEL'));
    const casaMarca = !!marcaCad && !!marcaML && marcaML === marcaCad;
    const casaModelo = !!modeloCad && !!modeloML && (modeloML === modeloCad
      || modeloML.includes(modeloCad) || modeloCad.includes(modeloML));
    const ficha = { id: cat.id, nome: cat.nome, marca: attrDoCatalogo(cat, 'BRAND'), modelo: attrDoCatalogo(cat, 'MODEL') };
    if (casaMarca && casaModelo) {
      avaliados.push({ ...c, gtin: cod, status: 'confirmado', catalogo: ficha,
        motivo: 'o Mercado Livre tem este código, com a mesma marca e o mesmo modelo do cadastro' });
    } else {
      avaliados.push({ ...c, gtin: cod, status: 'conflito', catalogo: ficha,
        motivo: `este código existe no ML, mas é de ${ficha.marca || '?'} ${ficha.modelo || ''} — não é o seu produto` });
    }
  }

  // Ordem de preferência: confirmado no ML, depois nota do fornecedor. Palpite
  // de IA sem confirmação nunca é recomendado.
  const recomendado = avaliados.find(x => x.status === 'confirmado')
    || avaliados.find(x => x.status === 'da-nota') || null;
  log(`[ML-gtin] ${produto.sku}: ${avaliados.length} candidato(s) `
    + `(${avaliados.filter(x => x.fonte === 'nota-de-entrada').length} de nota), `
    + `recomendado: ${recomendado ? recomendado.gtin : 'nenhum'}`);
  return { provider, candidatos: avaliados, recomendado: recomendado ? recomendado.gtin : null,
           marca: produto.marca, modelo: produto.modelo || produto.sku };
}

async function perguntarGtinIA(produto, { keys, ia, log }) {
  const prompt = `Você identifica códigos de barras (GTIN/EAN) de produtos. Responda SOMENTE com JSON.

PRODUTO:
- Descrição: ${produto.descricao || ''}
- Marca: ${produto.marca || '?'}
- Modelo / part number: ${produto.modelo || produto.sku || '?'}
- Categoria interna: ${produto.categoria || '?'}

Liste os códigos GTIN/EAN-13 que você conhece para ESTE produto exato.
Não invente: se você não tem certeza do código deste part number, devolva a
lista vazia. Um código errado é pior que nenhum. Prefira poucos e certos.

JSON: {"candidatos":[{"gtin":"7891234567895","confianca":0.8,"origem":"onde você viu isso"}]}`;

  const { json, provider } = await gerarJsonComIA(keys, prompt, { ia, log });
  const candidatos = (Array.isArray(json?.candidatos) ? json.candidatos : [])
    .slice(0, 5)
    .filter(c => c && c.gtin)
    .map(c => ({ gtin: String(c.gtin), confianca: Number(c.confianca) || null, origem: c.origem || null }));
  return { provider, candidatos };
}

/**
 * Procura o produto no catálogo do Mercado Livre pelo código de barras.
 * Achando, vêm ficha técnica e fotos OFICIAIS — que é o caminho correto para
 * quem não tem foto própria. Pegar imagem de outro anúncio ou do site do
 * fabricante é o que faz o ML derrubar o anúncio.
 */
async function buscarNoCatalogoML(gtin, { fetchJson = mlJson, token = null } = {}) {
  const cod = gtinValido(gtin);
  if (!cod) return null;
  const h = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
  const busca = await fetchJson(`${API_BASE}/products/search?status=active&site_id=${SITE}&q=${cod}`, h);
  const achado = busca.ok && Array.isArray(busca.json?.results) ? busca.json.results[0] : null;
  if (!achado?.id) return null;

  const p = await fetchJson(`${API_BASE}/products/${achado.id}`, h);
  if (!p.ok || !p.json?.id) return null;
  return {
    id: p.json.id,
    nome: p.json.name || achado.name || null,
    dominio: p.json.domain_id || null,
    atributos: (p.json.attributes || [])
      .filter(a => a.id && a.value_name)
      .map(a => ({ id: a.id, nome: a.name, value_name: a.value_name })),
    fotos: (p.json.pictures || []).map(x => x.url || x.secure_url).filter(Boolean),
  };
}

const attrDoCatalogo = (cat, id) => cat?.atributos?.find(a => a.id === id)?.value_name || null;

/**
 * Preço de venda a partir do custo e do markup do cadastro. Conta, não
 * palpite: quando os dois existem, sugerir outra coisa seria pior.
 */
function precoPorMarkup(produto) {
  const custo = Number(produto.precoCusto) || 0;
  const markup = Number(produto.markupVenda) || 0;
  if (!(custo > 0) || !(markup > 0)) return null;
  return { valor: Number((custo * (1 + markup / 100)).toFixed(2)),
           observacao: `custo R$ ${custo.toFixed(2)} + markup ${markup}%` };
}

const CAMPOS_SUGERIVEIS = ['marca', 'modelo', 'cor', 'material', 'ncm', 'pesoBruto',
                           'altura', 'largura', 'profundidade', 'precoVenda', 'descricao'];
// Peso e medida viram frete: errar aqui come a margem em toda venda. Por isso
// estimativa de IA nesses campos vem sempre com o aviso junto.
const CAMPOS_DE_FRETE = new Set(['pesoBruto', 'altura', 'largura', 'profundidade']);

function promptEnriquecimento(produto, catalogo) {
  const conhecido = Object.entries({
    SKU: produto.sku, Descrição: produto.descricao, Marca: produto.marca,
    Modelo: produto.modelo, Cor: produto.cor, 'GTIN/EAN': produto.codigoBarras,
    NCM: produto.ncm, 'Categoria interna': produto.categoria,
  }).filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- (quase nada)';

  const doCatalogo = catalogo
    ? `\nFICHA OFICIAL DO MERCADO LIVRE PARA ESTE CÓDIGO DE BARRAS:\n- Nome: ${catalogo.nome}\n`
      + catalogo.atributos.slice(0, 25).map(a => `- ${a.nome}: ${a.value_name}`).join('\n')
      + '\nEsses dados são confiáveis: use-os e não os contradiga.\n'
    : '';

  return `Você completa cadastro de produto para venda online. Responda SOMENTE com JSON.

O QUE O CADASTRO JÁ TEM:
${conhecido}
${doCatalogo}
CAMPOS QUE PODEM SER SUGERIDOS: ${CAMPOS_SUGERIVEIS.join(', ')}

REGRAS:
1. Sugira apenas o que os dados acima sustentam. Faltando base, não sugira o campo — omitir é melhor que errar.
2. "peso" e medidas viram cálculo de frete. Só sugira se souber o produto de verdade, e marque confianca baixa quando for ordem de grandeza.
3. "descricao": nome comercial claro do produto, sem marketing e sem preço.
4. NÃO invente GTIN, NCM nem número de modelo.
5. Para cada sugestão diga de onde tirou em "base".

FORMATO:
{
  "sugestoes": [
    {"campo": "marca", "valor": "Hikvision", "confianca": 0.9, "base": "consta no nome do produto"}
  ]
}`;
}

/**
 * Reúne sugestões para os buracos do cadastro: catálogo do ML (confiável),
 * conta de markup (determinística) e IA (estimativa). Não grava nada — quem
 * decide o que entra no cadastro é o usuário.
 */
async function sugerirDadosProduto(db, produtoId, opts = {}) {
  const { keys = {}, token = null, log = () => {}, fetchJson = mlJson, ia = null } = opts;
  const produto = produtoDe(db, produtoId);
  if (!produto) throw new Error(`Produto ${produtoId} não encontrado`);

  const vazio = (c) => {
    const v = produto[c];
    return v == null || String(v).trim() === '' || (CAMPOS_DE_FRETE.has(c) && !(Number(v) > 0))
        || (c === 'precoVenda' && !(Number(v) > 0));
  };

  const catalogo = await buscarNoCatalogoML(produto.codigoBarras, { fetchJson, token });
  const sugestoes = [];

  // 1) Catálogo do ML — a fonte mais confiável que existe aqui.
  if (catalogo) {
    const doCat = { marca: attrDoCatalogo(catalogo, 'BRAND'), modelo: attrDoCatalogo(catalogo, 'MODEL'),
                    cor: attrDoCatalogo(catalogo, 'COLOR'), descricao: catalogo.nome };
    for (const [campo, valor] of Object.entries(doCat)) {
      if (valor && vazio(campo)) {
        sugestoes.push({ campo, valor, fonte: 'catalogo-ml', confianca: 0.95,
                         base: `ficha oficial do ML (${catalogo.id})` });
      }
    }
  }

  // 2) Preço por markup — conta fechada, não precisa de IA.
  if (vazio('precoVenda')) {
    const p = precoPorMarkup(produto);
    if (p) sugestoes.push({ campo: 'precoVenda', valor: p.valor, fonte: 'markup', confianca: 1, base: p.observacao });
  }

  // 3) IA para o que sobrou.
  const jaSugerido = new Set(sugestoes.map(s => s.campo));
  const faltam = CAMPOS_SUGERIVEIS.filter(c => vazio(c) && !jaSugerido.has(c));
  if (faltam.length && Object.values(keys).some(Boolean)) {
    const { json, provider } = await gerarJsonComIA(keys, promptEnriquecimento(produto, catalogo), { ia, log });
    for (const s of (json?.sugestoes || [])) {
      if (!s || !s.campo || s.valor == null || s.valor === '') continue;
      if (!faltam.includes(s.campo)) continue;   // não sobrescreve o que já existe
      sugestoes.push({
        campo: s.campo, valor: s.valor, fonte: `ia:${provider}`,
        confianca: Number(s.confianca) || 0.5, base: s.base || null,
        aviso: CAMPOS_DE_FRETE.has(s.campo)
          ? 'Estimativa — o frete é calculado sobre este valor; confira antes de anunciar.' : null,
      });
    }
  }

  return {
    produtoId, sku: produto.sku, catalogo,
    // Com produto de catálogo, a foto deixa de ser problema: o anúncio herda
    // as imagens oficiais e não precisa de imagem própria.
    fotoResolvidaPeloCatalogo: !!(catalogo && catalogo.fotos.length),
    sugestoes,
    pendentesSemSugestao: CAMPOS_SUGERIVEIS.filter(c => vazio(c) && !sugestoes.some(s => s.campo === c)),
  };
}

/** Grava as sugestões que o usuário aceitou. Só campos conhecidos. */
function aplicarSugestoes(db, produtoId, campos = {}, { usuario = null } = {}) {
  const produto = produtoDe(db, produtoId);
  if (!produto) throw new Error('Produto não encontrado');
  const sets = [], vals = [];
  for (const [campo, valor] of Object.entries(campos)) {
    if (!CAMPOS_SUGERIVEIS.includes(campo)) continue;
    const num = ['pesoBruto', 'altura', 'largura', 'profundidade', 'precoVenda'].includes(campo);
    sets.push(`${campo} = ?`);
    vals.push(num ? (Number(valor) || null) : String(valor).trim() || null);
  }
  if (!sets.length) throw new Error('Nenhum campo válido para aplicar');
  vals.push(produtoId);
  db.prepare(`UPDATE produtos SET ${sets.join(', ')}, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals);
  return { aplicados: sets.length };
}

// ==================== RASCUNHO ====================

function produtoDe(db, produtoId) {
  return db.prepare('SELECT * FROM produtos WHERE id = ?').get(produtoId);
}

function saldoDe(db, produtoId) {
  try {
    return db.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
        WHEN tipo='saida' THEN -quantidade ELSE quantidade END), 0) s
      FROM movimentacoes_estoque WHERE produtoId = ?`).get(produtoId).s;
  } catch { return 0; }
}

function fotosDe(produto, baseUrl, db = null) {
  // O ML baixa a imagem da URL que mandamos: caminho local não serve.
  const absoluta = (p) => {
    const t = String(p);
    if (/^https?:\/\//i.test(t)) return t;
    if (!baseUrl) return null;
    return baseUrl.replace(/\/$/, '') + (t.startsWith('/') ? t : '/' + t);
  };

  // Galeria primeiro: anúncio com várias fotos converte melhor, e o ML aceita
  // até 12. imagemPath sozinho só carrega a capa.
  if (db && produto.id) {
    try {
      const galeria = db.prepare('SELECT caminho FROM produto_imagens WHERE produtoId = ? ORDER BY ordem LIMIT 12')
        .all(produto.id).map(x => absoluta(x.caminho)).filter(Boolean);
      if (galeria.length) return galeria;
    } catch { /* instalação sem a tabela de imagens */ }
  }
  if (!produto.imagemPath) return [];
  const u = absoluta(produto.imagemPath);
  return u ? [u] : [];
}

/**
 * Tudo que impede este rascunho de virar anúncio. Devolver a lista inteira,
 * não o primeiro problema: quem vai corrigir precisa ver o serviço todo.
 */
function validarRascunho(rascunho, produto, saldo) {
  const erros = [];
  const titulo = (rascunho.titulo || '').trim();
  if (!titulo) erros.push('Sem título');
  else if (titulo.length > MAX_TITULO) erros.push(`Título com ${titulo.length} caracteres (máximo ${MAX_TITULO})`);
  if (!rascunho.categoriaId) erros.push('Sem categoria do Mercado Livre');
  if (!(Number(rascunho.preco) > 0)) erros.push('Produto sem preço de venda');
  if (!(Number(rascunho.quantidade) > 0)) erros.push('Sem saldo em estoque para anunciar');

  // Anúncio de catálogo herda foto e ficha do produto oficial do ML, então
  // nem imagem própria nem atributo obrigatório se aplicam a ele.
  if (rascunho.catalogProductId) return erros;

  const fotos = jsonOuVazio(rascunho.fotos, []);
  // Anúncio sem foto é recusado pelo ML — melhor barrar aqui do que descobrir
  // no meio de uma publicação em lote.
  if (!fotos.length) {
    erros.push('Produto sem imagem (o Mercado Livre exige ao menos uma, ou vincule ao catálogo pelo código de barras)');
  }

  const attrs = jsonOuVazio(rascunho.atributos, []);
  const obrig = jsonOuVazio(rascunho.atributosObrigatorios, []);
  const preenchidos = new Set(attrs.filter(a => a.value_name || a.value_id).map(a => a.id));
  const faltando = obrig.filter(a => !preenchidos.has(a.id));
  for (const a of faltando) erros.push(`Atributo obrigatório sem valor: ${a.nome || a.id}`);

  return erros;
}

/** Gera (ou regenera) o rascunho de um produto. Não publica nada. */
async function gerarRascunho(db, produtoId, opts = {}) {
  const { keys = {}, token = null, baseUrl = null, log = () => {},
          fetchJson = mlJson, ia = null } = opts;
  const produto = produtoDe(db, produtoId);
  if (!produto) throw new Error(`Produto ${produtoId} não encontrado`);
  if (!produto.ativo) throw new Error(`Produto ${produto.sku} está inativo`);

  // Catálogo primeiro: casando por GTIN, o anúncio herda foto e ficha oficiais
  // e deixa de depender de imagem própria — que é o gargalo real do cadastro.
  const catalogo = await buscarNoCatalogoML(produto.codigoBarras, { fetchJson, token });

  const textoBusca = [catalogo?.nome, produto.descricao, produto.marca, produto.modelo]
    .filter(Boolean).join(' ');
  const categoria = await preverCategoria(textoBusca, { fetchJson });
  if (!categoria) throw new Error('Mercado Livre não sugeriu categoria para este produto — revise a descrição');

  const attrs = await atributosCategoria(categoria.id, { fetchJson });
  const { json, provider } = await gerarJsonComIA(keys, montarPrompt(produto, categoria, attrs), { ia, log });
  if (!json) throw new Error('Nenhum provedor de IA respondeu — confira as chaves em Configurações');

  // A IA sugere; os limites do ML são conferidos aqui. Título estourado é o
  // erro mais comum e derruba a publicação inteira.
  let titulo = String(json.titulo || produto.descricao || '').trim().replace(/\s+/g, ' ');
  if (titulo.length > MAX_TITULO) titulo = titulo.slice(0, MAX_TITULO).trim();

  const idsValidos = new Set([...attrs.obrigatorios, ...attrs.opcionais].map(a => a.id));
  const atributos = (Array.isArray(json.atributos) ? json.atributos : [])
    // Atributo que não existe na categoria faz o ML recusar o item inteiro.
    .filter(a => a && a.id && idsValidos.has(a.id) && String(a.value_name || '').trim())
    .map(a => ({ id: a.id, value_name: String(a.value_name).trim() }));

  // Foto do catálogo do ML é oficial e autorizada; a do produto local só
  // serve se estiver publicada numa URL que o ML consiga baixar.
  const fotos = catalogo?.fotos?.length ? catalogo.fotos : fotosDe(produto, baseUrl, db);
  const saldo = saldoDe(db, produtoId);
  const registro = {
    produtoId,
    titulo,
    categoriaId: categoria.id,
    categoriaNome: categoria.nome,
    descricao: String(json.descricao || '').slice(0, MAX_DESCRICAO),
    atributos: JSON.stringify(atributos),
    atributosObrigatorios: JSON.stringify(attrs.obrigatorios),
    preco: Number(produto.precoVenda) || 0,
    quantidade: Math.max(0, Math.floor(saldo)),
    fotos: JSON.stringify(fotos),
    geradoPor: provider,
    faltando: JSON.stringify(Array.isArray(json.faltando) ? json.faltando : []),
    confianca: Number(json.confianca) || null,
  };

  db.prepare(`INSERT INTO ml_anuncios
      (produtoId, status, titulo, categoriaId, categoriaNome, descricao, atributos,
       preco, quantidade, fotos, catalogProductId, geradoPor, geradoEm, erro, dataAtualizacao)
    VALUES (?, 'rascunho', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(produtoId) DO UPDATE SET
      titulo=excluded.titulo, categoriaId=excluded.categoriaId, categoriaNome=excluded.categoriaNome,
      descricao=excluded.descricao, atributos=excluded.atributos, preco=excluded.preco,
      quantidade=excluded.quantidade, fotos=excluded.fotos, catalogProductId=excluded.catalogProductId,
      geradoPor=excluded.geradoPor, geradoEm=CURRENT_TIMESTAMP, erro=NULL,
      dataAtualizacao=CURRENT_TIMESTAMP,
      status=CASE WHEN ml_anuncios.status='publicado' THEN 'publicado' ELSE 'rascunho' END`)
    .run(produtoId, registro.titulo, registro.categoriaId, registro.categoriaNome,
         registro.descricao, registro.atributos, registro.preco, registro.quantidade,
         registro.fotos, catalogo?.id || null, registro.geradoPor);

  const salvo = db.prepare('SELECT * FROM ml_anuncios WHERE produtoId = ?').get(produtoId);
  const bloqueios = validarRascunho({ ...salvo, atributosObrigatorios: registro.atributosObrigatorios }, produto, saldo);
  log(`[ML-anúncio] ${produto.sku}: rascunho por ${provider}`
    + (catalogo ? ` (catálogo ${catalogo.id})` : '')
    + (bloqueios.length ? ` — ${bloqueios.length} pendência(s)` : ''));
  return { ...salvo, bloqueios, faltandoIA: jsonOuVazio(registro.faltando, []),
           confianca: registro.confianca, atributosObrigatorios: attrs.obrigatorios,
           catalogo: catalogo ? { id: catalogo.id, nome: catalogo.nome, fotos: catalogo.fotos.length } : null };
}

// ==================== PREÇO DE MERCADO ====================
// Competitividade é dado, não palpite: os valores vêm de ofertas ativas do
// próprio ML. A via é o CATÁLOGO, não a busca de anúncios: `/sites/MLB/search`
// responde 403 mesmo com token de usuário válido (confirmado 2026-08-13), e
// `/products/search` responde 200. O catálogo ainda é melhor fonte — o ML já
// agrupou as ofertas por produto, então não chega acessório nem kit no meio.

const percentil = (ordenados, p) => {
  if (!ordenados.length) return null;
  const i = (ordenados.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return Number((ordenados[lo] + (ordenados[hi] - ordenados[lo]) * (i - lo)).toFixed(2));
};

/** Produtos de catálogo que casam com o texto. Não traz preço — só identidade. */
async function catalogosParecidos(termo, { token = null, fetchJson = mlJson, limite = 10 } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const q = encodeURIComponent(String(termo || '').slice(0, 120));
  const r = await fetchJson(
    `${API_BASE}/products/search?status=active&site_id=${SITE}&limit=${limite}&q=${q}`, { headers });
  if (!r.ok) {
    throw new Error(r.status === 401 || r.status === 403
      ? 'O Mercado Livre recusou a consulta de preços (HTTP ' + r.status + '). '
        + 'Se a integração está conectada, é a permissão do app: o endpoint de catálogo exige o escopo de leitura liberado para o seu ML_APP_ID'
      : `Consulta ao catálogo do Mercado Livre falhou (HTTP ${r.status})`);
  }
  return (r.json?.results || [])
    .map(p => ({ id: p.id, nome: p.name || '', permalink: p.permalink || null }))
    .filter(p => p.id);
}

/**
 * Ofertas ativas de cada produto de catálogo. O item vem sem título e sem
 * permalink próprios — quem nomeia a oferta é o produto de catálogo.
 */
async function ofertasDeCatalogos(catalogos, { token = null, fetchJson = mlJson } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const lotes = await Promise.all(catalogos.map(async (c) => {
    try {
      const r = await fetchJson(
        `${API_BASE}/products/${encodeURIComponent(c.id)}/items?limit=20`, { headers });
      return (r.json?.results || [])
        .filter(x => Number(x.price) > 0 && (x.condition || 'new') === 'new')
        .map(x => ({
          id: x.item_id || x.id, catalogoId: c.id, titulo: c.nome,
          preco: Number(x.price),
          freteGratis: !!(x.shipping && x.shipping.free_shipping),
          permalink: c.permalink || `https://www.mercadolivre.com.br/p/${c.id}`,
        }));
    } catch { return []; }  // um catálogo sem oferta não invalida os outros
  }));
  return lotes.flat();
}

/**
 * Fotos oficiais dos produtos de catálogo que casam com um texto. É a saída
 * para quem não tem código de barras — mas casar por descrição erra, então
 * quem escolhe é o usuário, olhando a foto. O sistema não decide sozinho.
 */
async function fotosDeCatalogos(catalogos, { token = null, fetchJson = mlJson } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const fichas = await Promise.all(catalogos.map(async (c) => {
    try {
      const r = await fetchJson(`${API_BASE}/products/${encodeURIComponent(c.id)}`, { headers });
      const p = r.json || {};
      const fotos = (p.pictures || []).map(x => x.secure_url || x.url).filter(Boolean);
      if (!fotos.length) return null;
      const attr = (id) => (p.attributes || []).find(a => a.id === id)?.value_name || null;
      return {
        id: c.id, nome: p.name || c.nome, fotos,
        marca: attr('BRAND'), modelo: attr('MODEL'),
        permalink: p.permalink || `https://www.mercadolivre.com.br/p/${c.id}`,
      };
    } catch { return null; }
  }));
  return fichas.filter(Boolean);
}

function promptRelevancia(produto, titulo, catalogos) {
  return `Você compara produtos de marketplace. Responda SOMENTE com JSON.

PRODUTO QUE VOU ANUNCIAR:
- Título: ${titulo}
- Descrição do cadastro: ${produto.descricao || ''}
- Marca: ${produto.marca || '?'} | Modelo: ${produto.modelo || '?'}

PRODUTOS DO CATÁLOGO DO MERCADO LIVRE (índice: nome):
${catalogos.map((c, i) => `${i}: ${c.nome}`).join('\n')}

Diga quais índices são o MESMO produto (mesma capacidade, mesmo tipo, mesma
quantidade por embalagem). Descarte acessório, peça avulsa, kit com quantidade
diferente e capacidade diferente. Marca diferente pode entrar se for
equivalente direto — é concorrência real.

JSON: {"relevantes":[0,3,7],"descartados_porque":"frase curta"}`;
}

/**
 * Faixa de preço praticada e uma sugestão que respeita o custo. Sugerir preço
 * de mercado sem olhar o custo é como vender no prejuízo com método.
 */
async function sugerirPrecoMercado(db, anuncioId, opts = {}) {
  const { token = null, keys = {}, ia = null, log = () => {}, fetchJson = mlJson } = opts;
  const a = db.prepare('SELECT * FROM ml_anuncios WHERE id = ?').get(anuncioId);
  if (!a) throw new Error('Rascunho não encontrado');
  const produto = produtoDe(db, a.produtoId);
  if (!produto) throw new Error('Produto do rascunho não encontrado');

  const termo = a.titulo || [produto.marca, produto.modelo, produto.descricao].filter(Boolean).join(' ');
  const avisos = [];
  let origem, catalogos, filtradoPor = null, descartadosPorque = null;

  if (a.catalogProductId) {
    // Rascunho já casado por GTIN: as ofertas são do produto exato.
    origem = 'catalogo';
    catalogos = [{ id: a.catalogProductId, nome: a.titulo || termo, permalink: null }];
  } else {
    origem = 'busca-catalogo';
    catalogos = await catalogosParecidos(termo, { token, fetchJson });
    if (!catalogos.length) {
      return { encontrados: 0, avisos: ['Nenhum produto equivalente no catálogo do Mercado Livre — revise o título do rascunho'] };
    }
    // Filtrar antes de buscar ofertas economiza uma chamada por produto
    // descartado, e a IA julga sobre nomes, não sobre preços.
    const total = catalogos.length;
    if (Object.values(keys).some(Boolean)) {
      const { json, provider } = await gerarJsonComIA(keys,
        promptRelevancia(produto, termo, catalogos), { ia, log });
      const idx = Array.isArray(json?.relevantes) ? json.relevantes : null;
      const escolhidos = idx ? idx.map(i => catalogos[i]).filter(Boolean) : [];
      if (escolhidos.length) {
        catalogos = escolhidos;
        filtradoPor = provider;
        descartadosPorque = json.descartados_porque || null;
      } else {
        avisos.push('A IA não conseguiu separar os produtos equivalentes — a faixa abaixo usa todos os resultados do catálogo e pode misturar modelos diferentes');
      }
    } else {
      avisos.push('Sem chave de IA configurada: a faixa usa todos os resultados do catálogo, sem descartar capacidade ou modelo diferente');
    }
    // Teto de chamadas: cada catálogo custa um GET de ofertas. Cortar é
    // legítimo, calar sobre o corte não — quem lê a faixa tem que saber.
    if (catalogos.length > 8) {
      avisos.push(`Consultei os 8 produtos mais relevantes de ${catalogos.length} equivalentes encontrados`);
      catalogos = catalogos.slice(0, 8);
    }
    log(`[ML-preço] ${produto.sku}: ${catalogos.length} de ${total} produto(s) de catálogo consultados`);
  }

  const ofertas = await ofertasDeCatalogos(catalogos, { token, fetchJson });
  if (!ofertas.length) {
    return { encontrados: 0, origem, avisos: avisos.concat(
      'Os produtos equivalentes do catálogo estão sem oferta ativa — sem preço para comparar') };
  }

  // Percentil sobre duas ofertas é aritmética honesta em cima de amostra que
  // não sustenta conclusão. Dizer isso é parte do resultado.
  if (ofertas.length < 4) {
    avisos.push(`Apenas ${ofertas.length} oferta(s) ativa(s) para comparar — a faixa abaixo é frágil, confira os anúncios usados antes de decidir`);
  }
  const precos = ofertas.map(x => x.preco).sort((x, y) => x - y);
  const faixa = { n: precos.length, min: precos[0], max: precos[precos.length - 1],
                  p25: percentil(precos, 0.25), mediana: percentil(precos, 0.5),
                  p75: percentil(precos, 0.75) };

  // Piso: abaixo dele o anúncio dá prejuízo depois da comissão do ML.
  const custo = Number(produto.precoCusto) || 0;
  let comissaoPct = null, piso = null;
  try {
    const r = await fetchJson(`${API_BASE}/sites/${SITE}/listing_prices?price=${faixa.mediana}`
      + `&category_id=${encodeURIComponent(a.categoriaId || '')}`
      + `&listing_type_id=${encodeURIComponent(a.listingTypeId || 'gold_special')}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    const taxa = Number(r.json?.sale_fee_amount);
    if (taxa > 0 && faixa.mediana > 0) comissaoPct = (taxa / faixa.mediana) * 100;
  } catch { /* sem comissão a sugestão ainda vale, só não confere margem */ }
  // O piso é o maior entre três limites, e cada um tem um nome: break-even,
  // markup mínimo e preço mínimo, todos já cadastrados no produto.
  let motivoPiso = null;
  const limite = (valor, nome) => {
    if (!(valor > 0)) return;
    if (piso == null || valor > piso) { piso = Number(valor.toFixed(2)); motivoPiso = nome; }
  };
  if (custo > 0 && comissaoPct != null) {
    const liquido = 1 - comissaoPct / 100;
    limite(custo / liquido, 'cobrir custo e comissão do ML');
    if (Number(produto.markupMinimo) > 0) {
      limite(custo * (1 + Number(produto.markupMinimo) / 100) / liquido,
             `garantir o markup mínimo de ${produto.markupMinimo}% do cadastro`);
    }
  }
  if (Number(produto.precoMinimoVenda) > 0) {
    limite(Number(produto.precoMinimoVenda), 'respeitar o preço mínimo de venda do cadastro');
  }
  if (custo <= 0) avisos.push('Produto sem preço de custo no cadastro — não dá para conferir se o preço sugerido tem margem');
  if (comissaoPct == null) avisos.push('Não foi possível consultar a comissão do Mercado Livre para esta categoria');

  // Alvo: o p25 posiciona abaixo da maioria sem ser o mais barato da praça.
  let sugerido = faixa.p25, motivo = 'p25 do mercado — abaixo da maioria, sem ser o mais barato';
  if (piso != null && sugerido < piso) {
    sugerido = piso;
    motivo = `acima do p25 para ${motivoPiso}`;
    if (piso > faixa.p75) avisos.push('O custo deste produto não compete: o preço mínimo viável fica acima de 75% dos concorrentes');
  }
  const margem = (custo > 0 && comissaoPct != null)
    ? Number((sugerido * (1 - comissaoPct / 100) - custo).toFixed(2)) : null;
  if (margem != null && margem <= 0.01) {
    avisos.push('No preço sugerido não sobra margem: ele apenas cobre o custo e a comissão do ML — e frete e imposto ainda vêm por cima');
  }

  log(`[ML-preço] ${produto.sku}: ${faixa.n} concorrente(s), mediana R$ ${faixa.mediana}, sugerido R$ ${sugerido}`);
  return {
    encontrados: ofertas.length, origem, catalogosUsados: catalogos.length,
    filtradoPor, descartadosPorque,
    faixa, sugerido, motivo, custo, comissaoPct: comissaoPct != null ? Number(comissaoPct.toFixed(2)) : null,
    piso, margem, precoAtual: Number(a.preco) || 0, avisos,
    concorrentes: ofertas.slice().sort((x, y) => x.preco - y.preco).slice(0, 12),
  };
}

// ==================== PUBLICAÇÃO ====================

/**
 * A recusa útil está em `cause`, não em `message`: o `message` é o código
 * genérico ("body.required_fields") e o `cause` diz o que falta ("[GTIN] are
 * required"). Só os de tipo error impedem — warning o ML resolve sozinho
 * (frete grátis obrigatório, por exemplo).
 */
function descreverCausas(json, { somenteErros = true } = {}) {
  const causas = Array.isArray(json?.cause) ? json.cause : [];
  const uteis = somenteErros ? causas.filter(c => c.type === 'error') : causas;
  const frases = uteis.map(c => traduzirCausa(c.message || c.code || ''));
  if (frases.length) return [...new Set(frases)].join('; ');
  return json?.message ? String(json.message) : '';
}

// As mensagens do ML vêm em inglês e apontam o campo interno. Traduzir as
// recorrentes é o que transforma "recusado" em "cadastre o código de barras".
function traduzirCausa(msg) {
  const m = String(msg);
  const gtin = m.match(/attributes \[([^\]]*GTIN[^\]]*)\] are required for category \[([^\]]+)\]/i);
  if (gtin) {
    return `a categoria ${gtin[2]} exige código de barras (GTIN) — cadastre o código de barras do produto`;
  }
  const attr = m.match(/attributes \[([^\]]+)\] are required for category \[([^\]]+)\]/i);
  if (attr) return `a categoria ${attr[2]} exige o(s) atributo(s) ${attr[1]}`;
  if (/properties \[family_name\]/i.test(m)) {
    return 'esta categoria publica por família de produto, não por título livre';
  }
  if (/fields \[title\] are invalid/i.test(m)) {
    return 'esta categoria não aceita título livre — o Mercado Livre monta o título pelos atributos';
  }
  const kit = m.match(/"([^"]+)":\s*Preencha este campo/i);
  if (kit) return `preencha o atributo "${kit[1]}"`;
  return m;
}

/**
 * Sobe as fotos para o Mercado Livre e devolve os ids das imagens.
 *
 * Mandar `{source: url}` e deixar o ML baixar depende de o nosso servidor
 * estar público, aberto ao robô deles e rápido — e quando falha o anúncio
 * nasce pausado em picture_download_pending, sem erro nenhum na publicação.
 * Enviando o arquivo, a imagem já volta processada no CDN deles.
 */
async function subirFotos(fotos, { token, raizPublica = null, log = () => {} } = {}) {
  const ids = [], falhas = [];
  for (const url of fotos) {
    try {
      let corpo = null;
      // Arquivo nosso: manda os bytes. URL de terceiro: deixa o ML buscar.
      const local = raizPublica && /\/uploads\//.test(url)
        ? path.join(raizPublica, url.slice(url.indexOf('/uploads/')).replace(/^\//, ''))
        : null;
      if (local && fs.existsSync(local)) {
        const fd = new FormData();
        fd.append('file', new Blob([fs.readFileSync(local)]), path.basename(local));
        corpo = fd;
      }
      if (!corpo) { ids.push({ source: url }); continue; }
      const r = await fetch(`${API_BASE}/pictures/items/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: corpo,
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.id) ids.push({ id: j.id });
      else { falhas.push({ url, erro: j?.message || `HTTP ${r.status}` }); ids.push({ source: url }); }
    } catch (e) { falhas.push({ url, erro: e.message }); ids.push({ source: url }); }
  }
  if (falhas.length) log(`[ML-foto] ${falhas.length} upload(s) falharam: ${falhas.map(f => f.erro).join('; ')}`);
  return { pictures: ids, falhas };
}

/** Corpo do item conforme o modelo da categoria (título livre ou família). */
function corpoDoItem(a, produto, { comTitulo = true, pictures = null } = {}) {
  const corpo = {
    price: Number(a.preco),
    currency_id: 'BRL',
    available_quantity: Number(a.quantidade),
    buying_mode: 'buy_it_now',
    listing_type_id: a.listingTypeId || 'gold_special',
    condition: a.condicao || 'new',
    attributes: jsonOuVazio(a.atributos, []).slice(),
  };
  if (a.catalogProductId) {
    // Anúncio de catálogo: título, ficha e fotos vêm do produto oficial do ML.
    // Mandar título ou foto próprios aqui faz o ML recusar — mas `category_id`
    // é obrigatório mesmo assim, e sem ele o ML devolve body.required_fields.
    corpo.catalog_product_id = a.catalogProductId;
    corpo.catalog_listing = true;
    corpo.category_id = a.categoriaId;
    if (produto?.sku) corpo.attributes.push({ id: 'SELLER_SKU', value_name: String(produto.sku) });
    return corpo;
  }
  corpo.category_id = a.categoriaId;
  corpo.pictures = pictures || jsonOuVazio(a.fotos, []).map(source => ({ source }));
  if (comTitulo) corpo.title = a.titulo;
  else corpo.family_name = a.titulo;   // categoria de PDP obrigatória

  const tem = (id) => corpo.attributes.some(x => x.id === id);
  // SKU do ERP vai no anúncio: é o que casa o pedido importado com o produto
  // e o que o sync de estoque usa depois.
  if (produto?.sku && !tem('SELLER_SKU')) {
    corpo.attributes.push({ id: 'SELLER_SKU', value_name: String(produto.sku) });
  }
  // O código de barras do cadastro é o GTIN do anúncio — sem mandá-lo, a
  // categoria que o exige recusa mesmo com o produto tendo código.
  if (produto?.codigoBarras && gtinValido(produto.codigoBarras) && !tem('GTIN')) {
    corpo.attributes.push({ id: 'GTIN', value_name: String(produto.codigoBarras).trim() });
  }
  // Vendendo por unidade, o ML pede quantas unidades vão na embalagem.
  const formato = corpo.attributes.find(x => x.id === 'SALE_FORMAT');
  if (formato && /unidade/i.test(formato.value_name || '') && !tem('UNITS_PER_PACK')) {
    corpo.attributes.push({ id: 'UNITS_PER_PACK', value_name: '1' });
  }
  return corpo;
}

/**
 * Monta o corpo e o submete ao validador do ML, que aponta o problema sem
 * criar anúncio nenhum. Se a categoria recusar título livre, refaz por família
 * — quem sabe qual modelo a categoria usa é o ML, não a gente.
 */
async function prepararCorpo(a, produto, { token, fetchJson = mlJson,
                                            raizPublica = null, subirImagens = false, log = () => {} } = {}) {
  // As imagens sobem uma vez só, antes das tentativas de validação.
  let pictures = null;
  if (subirImagens && !a.catalogProductId) {
    const fotos = jsonOuVazio(a.fotos, []);
    if (fotos.length) ({ pictures } = await subirFotos(fotos, { token, raizPublica, log }));
  }
  const validar = async (corpo) => {
    const r = await fetchJson(`${API_BASE}/items/validate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const causas = Array.isArray(r.json?.cause) ? r.json.cause : [];
    return {
      status: r.status,
      erros: causas.filter(c => c.type === 'error'),
      avisos: causas.filter(c => c.type && c.type !== 'error').map(c => c.message),
      json: r.json,
    };
  };

  let corpo = corpoDoItem(a, produto, { comTitulo: true, pictures });
  let v = await validar(corpo);
  const pedeFamilia = (v.json?.cause || []).some(c => /properties \[family_name\]/i.test(c.message || ''))
    || /family_name/i.test(v.json?.message || '');
  if (pedeFamilia && !a.catalogProductId) {
    corpo = corpoDoItem(a, produto, { comTitulo: false, pictures });
    v = await validar(corpo);
  }
  return {
    corpo,
    porFamilia: !corpo.title && !a.catalogProductId,
    erros: v.erros.map(c => traduzirCausa(c.message || c.code || '')),
    avisos: v.avisos,
  };
}

/**
 * Publica um rascunho já revisado. Cria oferta pública no ML — por isso exige
 * chamada explícita e recusa qualquer rascunho com pendência.
 */
async function publicarRascunho(db, anuncioId, opts = {}) {
  const { token, log = () => {}, fetchJson = mlJson, usuario = null } = opts;
  const a = db.prepare('SELECT * FROM ml_anuncios WHERE id = ?').get(anuncioId);
  if (!a) throw new Error('Rascunho não encontrado');
  if (a.status === 'publicado') throw new Error(`Já publicado como ${a.mlItemId}`);
  if (!token) throw new Error('Sem token do Mercado Livre — reconecte a integração');

  const produto = produtoDe(db, a.produtoId);
  const obrig = await atributosCategoria(a.categoriaId, { fetchJson });
  const bloqueios = validarRascunho(
    { ...a, atributosObrigatorios: JSON.stringify(obrig.obrigatorios) }, produto, a.quantidade);
  if (bloqueios.length) throw new Error(`Rascunho com pendência: ${bloqueios.join('; ')}`);

  // Valida antes de criar. O ML devolve o motivo real em `cause`; publicar
  // direto e ler só `message` foi o que produziu "body.required_fields" na
  // tela, uma frase que não diz nada a quem precisa corrigir.
  const prova = await prepararCorpo(a, produto, { token, fetchJson, log,
                                                  raizPublica: opts.raizPublica, subirImagens: true });
  if (prova.erros.length) {
    const motivo = prova.erros.join('; ');
    db.prepare("UPDATE ml_anuncios SET status='erro', erro=?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?")
      .run(motivo.slice(0, 500), a.id);
    throw new Error(`Mercado Livre recusou: ${motivo}`);
  }
  const corpo = prova.corpo;

  const r = await fetchJson(`${API_BASE}/items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });

  if (!r.ok || !r.json?.id) {
    const motivo = descreverCausas(r.json) || `HTTP ${r.status}`;
    db.prepare("UPDATE ml_anuncios SET status='erro', erro=?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?")
      .run(String(motivo).slice(0, 500), a.id);
    throw new Error(`Mercado Livre recusou: ${motivo}`);
  }

  const mlItemId = r.json.id;
  // A descrição vai em chamada separada; se ela falhar o anúncio já existe, e
  // fingir que não deu certo criaria um anúncio órfão.
  let avisoDescricao = null;
  if (a.descricao && !a.catalogProductId) {
    const d = await fetchJson(`${API_BASE}/items/${mlItemId}/description`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plain_text: a.descricao }),
    });
    if (!d.ok) avisoDescricao = 'Anúncio publicado, mas a descrição não subiu — reenvie pela tela.';
  }

  db.prepare(`UPDATE ml_anuncios SET status='publicado', mlItemId=?, permalink=?,
      publicadoEm=CURRENT_TIMESTAMP, revisadoPor=?, erro=?, dataAtualizacao=CURRENT_TIMESTAMP
    WHERE id=?`).run(mlItemId, r.json.permalink || null, usuario, avisoDescricao, a.id);

  // Mantém o mapa que o sync de estoque e a importação de pedido já usam.
  try {
    db.prepare(`INSERT INTO ml_item_map (mlItemId, produtoId, sku, titulo, qtdML, atualizadoEm)
      VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(mlItemId) DO UPDATE SET produtoId=excluded.produtoId, sku=excluded.sku,
        titulo=excluded.titulo, qtdML=excluded.qtdML, atualizadoEm=CURRENT_TIMESTAMP`)
      .run(mlItemId, a.produtoId, produto?.sku || null, a.titulo, Number(a.quantidade));
  } catch (e) { log(`[ML-anúncio] mapa não atualizado: ${e.message}`); }

  log(`[ML-anúncio] ${produto?.sku}: publicado como ${mlItemId}`);
  return { mlItemId, permalink: r.json.permalink || null, aviso: avisoDescricao };
}

/** Produtos que ainda não viraram anúncio, com o que falta em cada um. */
function candidatos(db, { limit = 200 } = {}) {
  const linhas = db.prepare(`
    SELECT p.id, p.sku, p.descricao, p.marca, p.modelo, p.categoria, p.codigoBarras,
           p.precoVenda, p.imagemPath,
           a.id AS anuncioId, a.status AS anuncioStatus, a.mlItemId,
           (SELECT mlItemId FROM ml_item_map m WHERE m.produtoId = p.id LIMIT 1) AS jaNoML
    FROM produtos p
    LEFT JOIN ml_anuncios a ON a.produtoId = p.id
    WHERE p.ativo = 1
    ORDER BY p.descricao LIMIT ?`).all(limit);

  return linhas.map(l => {
    const saldo = saldoDe(db, l.id);
    const pendencias = [];
    if (!(Number(l.precoVenda) > 0)) pendencias.push('sem preço de venda');
    if (!(saldo > 0)) pendencias.push('sem saldo em estoque');
    if (!l.imagemPath) pendencias.push('sem imagem');
    return { ...l, saldo, pendencias, pronto: pendencias.length === 0 };
  });
}

module.exports = {
  migrarAnunciosDB, preverCategoria, atributosCategoria, gerarJsonComIA,
  montarPrompt, gerarRascunho, validarRascunho, publicarRascunho, candidatos,
  corpoDoItem, prepararCorpo, descreverCausas, traduzirCausa, subirFotos,
  fotosDe, MAX_TITULO,
  catalogosParecidos, ofertasDeCatalogos, fotosDeCatalogos, sugerirPrecoMercado,
  buscarNoCatalogoML, gtinValido, digitoGtinOk, procurarGtin, gtinDasNotas,
  precoPorMarkup, sugerirDadosProduto,
  aplicarSugestoes, CAMPOS_SUGERIVEIS,
};
