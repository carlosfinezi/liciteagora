/**
 * propostas-match-routes.js — Cruzamento entre itens de licitação
 * (PNCP) e catálogo de produtos da empresa. Usado pela página de
 * propostas para indicar qual produto cadastrado atende cada item,
 * com custo/preço/marca/modelo já preenchidos.
 *
 * Match score:
 *  - codigoCatmat / codigoCatser exato     → +100 (gold)
 *  - marca_referencia da IA = produto.marca → +50
 *  - palavra >=4 chars do item bate descricao → +10 cada
 *
 * Threshold mínimo: 10 (1 palavra ou marca). Retorna top 3 por item.
 *
 * Entrada stateless: o frontend passa os itens já materializados.
 * Não toca PNCP nem catálogo, só o produtos do tenant.
 */

function registrarRotasPropostasMatch(app, db) {
  app.post('/api/propostas/match-produtos', (req, res) => {
    try {
      const { itens } = req.body;
      if (!Array.isArray(itens)) {
        return res.status(400).json({ success: false, error: 'itens deve ser array' });
      }

      const produtos = db.prepare(`
        SELECT id, sku, descricao, marca, modelo,
               precoCusto, precoVenda, codigoCatmat, codigoCatser, unidade
          FROM produtos
         WHERE ativo = 1
      `).all();

      const matches = itens.map((it, idx) => {
        const scored = produtos
          .map(p => ({ ...p, score: scoreMatch(it, p) }))
          .filter(p => p.score >= 10)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        return { indice: idx, numeroItem: it.numero || it.numeroItem || idx + 1, produtos: scored };
      });

      res.json({ success: true, matches, totalProdutos: produtos.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Cadastro rápido de produto a partir de item da licitação.
  // Aceita campos livres (não precisa do itemId, diferente do
  // /api/produtos/importar-item-licitacao já existente que exige
  // FK em catalog.itens).
  app.post('/api/propostas/cadastrar-produto', (req, res) => {
    try {
      const { sku, descricao, unidade, marca, modelo, precoCusto, precoVenda,
              observacoes, codigoCatmat, codigoCatser } = req.body;
      if (!sku || !descricao) {
        return res.status(400).json({ success: false, error: 'sku e descricao obrigatórios' });
      }
      const existente = db.prepare('SELECT id FROM produtos WHERE sku = ?').get(sku);
      if (existente) {
        return res.status(409).json({ success: false, error: 'SKU já cadastrado', produtoId: existente.id });
      }
      const result = db.prepare(`
        INSERT INTO produtos
          (sku, descricao, unidade, marca, modelo, precoCusto, precoVenda,
           observacoes, codigoCatmat, codigoCatser, ativo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        sku, descricao, unidade || 'UN', marca || null, modelo || null,
        Number(precoCusto) || 0, Number(precoVenda) || 0,
        observacoes || null, codigoCatmat || null, codigoCatser || null
      );
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(result.lastInsertRowid);
      res.json({ success: true, produto });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

// Stopwords PT-BR: palavras genéricas que não devem contar como sinal.
// Aparecem em quase qualquer descrição e geravam falsos positivos
// (ex: "para" casando microfone karaoke com certificado SSL).
const STOPWORDS = new Set([
  'para', 'pelo', 'pela', 'pelos', 'pelas', 'com', 'sem', 'por', 'que', 'dos', 'das',
  'uma', 'uns', 'umas', 'ele', 'ela', 'eles', 'elas', 'esse', 'esta', 'este',
  'tipo', 'modo', 'modelo', 'marca', 'produto', 'item', 'unidade', 'codigo', 'codigo',
  'digital', 'eletronico', 'eletronica', 'eletrônico', 'eletrônica',
  'completo', 'completa', 'simples', 'novo', 'nova', 'usado', 'usada',
  'preto', 'branco', 'cinza', 'azul', 'vermelho', 'amarelo', 'verde',
  'metros', 'metro', 'cabo', 'cabos',
  'aquisicao', 'aquisição', 'contratacao', 'contratação', 'fornecimento', 'prestacao', 'prestação',
  'servico', 'servicos', 'serviço', 'serviços', 'empresa', 'especializada',
  'sistema', 'sistemas', 'equipamento', 'equipamentos', 'material', 'materiais',
]);

function scoreMatch(item, produto) {
  let score = 0;
  const lc = s => (s || '').toString().toLowerCase().trim();

  const itemDesc = lc(item.descricao);
  const itemEspecs = lc(item.especificacoes_tecnicas);
  const itemMarca = lc(item.marca_referencia);
  const prodDesc = lc(produto.descricao);
  const prodMarca = lc(produto.marca);
  const prodModelo = lc(produto.modelo);

  if (item.codigoCatmat && produto.codigoCatmat && String(item.codigoCatmat) === String(produto.codigoCatmat)) {
    score += 100;
  }
  if (item.codigoCatser && produto.codigoCatser && String(item.codigoCatser) === String(produto.codigoCatser)) {
    score += 100;
  }

  if (itemMarca && prodMarca) {
    if (itemMarca === prodMarca) score += 50;
    else if (itemMarca.includes(prodMarca) || prodMarca.includes(itemMarca)) score += 30;
  }

  if (prodModelo && (matchPalavraOuSubstring(itemDesc, prodModelo) || matchPalavraOuSubstring(itemEspecs, prodModelo))) {
    score += 25;
  }

  const haystack = itemDesc + ' ' + itemEspecs;
  if (haystack && prodDesc) {
    const tokens = prodDesc.split(/[^a-zà-úà-ÿ0-9]+/i)
      .filter(t => t.length >= 4 && !STOPWORDS.has(t));
    const seen = new Set();
    let palavrasCasadas = 0;
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (haystack.includes(t)) {
        score += 10;
        palavrasCasadas++;
      }
    }
    // Bônus de coerência: 2+ palavras casadas indicam afinidade real
    if (palavrasCasadas >= 2) score += 15;
    if (palavrasCasadas >= 3) score += 15;
  }

  return score;
}

// Para siglas curtas (<=3 chars como DV/OV/EV/IP/NVR), exige word boundary
// pra não casar "ev" em "elevador". Strings longas continuam com substring.
function matchPalavraOuSubstring(haystack, needle) {
  if (!haystack || !needle) return false;
  if (needle.length <= 3) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^a-zà-ÿ0-9])${escaped}(?:[^a-zà-ÿ0-9]|$)`, 'i');
    return re.test(haystack);
  }
  return haystack.includes(needle);
}

module.exports = { registrarRotasPropostasMatch };
