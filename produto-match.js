/**
 * produto-match.js — Fuzzy match entre descrição livre (item de licitação)
 * e produtos cadastrados na tenant. Tudo server-side, sem chamar IA.
 *
 * Estratégia:
 *  1) Normaliza descrição (lowercase, remove acentos, tira stopwords/medidas).
 *  2) Tokeniza descrição do item + descricao+sku+marca+modelo+categoria de
 *     cada produto.
 *  3) Score por sobreposição ponderada:
 *       - token igual em sku/marca/modelo: peso alto
 *       - token igual em descricao do produto: peso médio
 *       - token compartilhado total / tamanho da menor: Jaccard direto
 *  4) Retorna top N com score normalizado (0-1).
 *
 * Não consome tokens de IA — é só JS + SQL. Pode rodar in-line na análise
 * (analise-ia.js) ou via endpoint dedicado (sniper/lances).
 */

const STOPWORDS = new Set([
  'de','da','do','das','dos','para','com','sem','e','ou','a','o','as','os',
  'em','no','na','nos','nas','um','uma','uns','umas','por','se','que','não',
  'tipo','marca','modelo','ref','referencia','referência','und','un','unidade',
  'unid','kg','g','mg','ml','l','m','cm','mm','pol','polegada','polegadas',
  'cor','tamanho','formato','material','aplicação','aplicacao','sistema',
  'equipamento','item','peça','peças','peca','pecas','produto','contendo',
  'pacote','caixa','cx','pct','par','pares','jogo','conjunto',
]);

function normalize(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove diacríticos combinantes
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s) {
  const out = new Set();
  for (const t of normalize(s).split(' ')) {
    if (!t || t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    // Tokens puramente numéricos curtos costumam ser ruído (quantidade etc.)
    if (/^\d+$/.test(t) && t.length < 3) continue;
    out.add(t);
  }
  return out;
}

/**
 * Score um produto contra uma descrição de item.
 *
 * Pesos:
 *   - match em sku/marca/modelo (campos específicos) → +0.4 por token único
 *   - tokens compartilhados na descricao do produto → contribui pro Jaccard
 *
 * Retorna score 0-1 (clamped).
 */
function scoreProduto(itemTokens, produto) {
  if (itemTokens.size === 0) return 0;

  const descTokens = tokenize(produto.descricao || '');
  const skuTokens = tokenize(produto.sku || '');
  const marcaTokens = tokenize(produto.marca || '');
  const modeloTokens = tokenize(produto.modelo || '');
  const especificos = new Set([...skuTokens, ...marcaTokens, ...modeloTokens]);

  // Jaccard base entre tokens do item e tokens da descrição do produto
  let intersec = 0;
  for (const t of itemTokens) if (descTokens.has(t)) intersec++;
  const union = new Set([...itemTokens, ...descTokens]).size;
  const jaccard = union > 0 ? intersec / union : 0;

  // Bônus por match em campos específicos (sku/marca/modelo)
  let bonus = 0;
  for (const t of itemTokens) {
    if (especificos.has(t)) bonus += 0.2;
  }

  const score = Math.min(1, jaccard + bonus);
  return score;
}

/**
 * Busca matches pra uma descrição.
 *
 * @param {Database} db - tenant DB (better-sqlite3)
 * @param {string} descricao - descrição livre do item
 * @param {object} opts
 *   - marcaHint: string (ex.: itens.marcaExtraida) — dá prioridade
 *   - limite: int (default 3)
 *   - scoreMin: float (default 0.3)
 * @returns {Array<{ id, sku, descricao, marca, precoCusto, score }>}
 *          ordenado por score desc. Vazio se nenhum produto passa scoreMin.
 */
function matchProdutos(db, descricao, opts = {}) {
  const limite = Math.max(1, Math.min(10, opts.limite || 3));
  const scoreMin = opts.scoreMin != null ? opts.scoreMin : 0.3;
  const itemTokens = tokenize(descricao);

  // Adiciona marcaHint aos tokens (vinda de itens.marcaExtraida)
  if (opts.marcaHint) {
    for (const t of tokenize(opts.marcaHint)) itemTokens.add(t);
  }
  if (itemTokens.size === 0) return [];

  // Pré-filtro SQL: pega só produtos com pelo menos 1 token em comum
  // (LIKE em qualquer um dos tokens longos). Isso descarta 99% do catálogo
  // antes do scoring em JS.
  const tokensLongos = [...itemTokens].filter(t => t.length >= 4).slice(0, 8);
  let candidatos;
  if (tokensLongos.length > 0) {
    const likes = tokensLongos.map(() => '(LOWER(descricao) LIKE ? OR LOWER(sku) LIKE ? OR LOWER(marca) LIKE ?)').join(' OR ');
    const params = [];
    for (const t of tokensLongos) {
      const p = `%${t}%`;
      params.push(p, p, p);
    }
    candidatos = db.prepare(`
      SELECT id, sku, descricao, marca, modelo, precoCusto, precoVenda
        FROM produtos
       WHERE ativo = 1 AND (${likes})
       LIMIT 500
    `).all(...params);
  } else {
    // Sem tokens longos = descrição muito vaga; não tentar varrer tudo
    return [];
  }

  // Score em memória
  const ranked = candidatos
    .map(p => ({ ...p, score: scoreProduto(itemTokens, p) }))
    .filter(p => p.score >= scoreMin)
    .sort((a, b) => b.score - a.score)
    .slice(0, limite);

  return ranked.map(p => ({
    id: p.id,
    sku: p.sku,
    descricao: p.descricao,
    marca: p.marca,
    precoCusto: p.precoCusto || 0,
    precoVenda: p.precoVenda || 0,
    score: Math.round(p.score * 100) / 100,
  }));
}

/**
 * Versão em lote — uma chamada, várias descrições.
 * Retorna mapa { numeroOrIdent: [matches...] }.
 */
function matchProdutosBulk(db, itens, opts = {}) {
  const out = {};
  for (const it of itens) {
    const key = it.key != null ? it.key : it.numero;
    if (key == null) continue;
    out[key] = matchProdutos(db, it.descricao || '', {
      ...opts,
      marcaHint: it.marcaHint,
    });
  }
  return out;
}

module.exports = { matchProdutos, matchProdutosBulk, normalize, tokenize };
