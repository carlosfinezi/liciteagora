/**
 * produto-match-routes.js — Endpoint pra casar descrição de item (livre ou
 * vinda de licitação) contra o cadastro de produtos da tenant.
 *
 * Usado por:
 *  - lances.html → sugerir custo na coluna "Custo" de cada item.
 *  - (Futuro) analises-ia.html / interesse → marcar produto vinculado.
 */

const { matchProdutos } = require('./produto-match');

function registrarRotasProdutoMatch(app, db) {
  /**
   * POST /api/produto-match/bulk
   * Body: { itens: [{ key, descricao, marcaHint? }] }
   * Resp: { success, matches: { <key>: [ { id, sku, descricao, marca, precoCusto, score } ] } }
   *
   * `key` é livre — pode ser o numeroItem, item.id, etc. Cliente decide.
   */
  app.post('/api/produto-match/bulk', (req, res) => {
    try {
      const { itens } = req.body || {};
      if (!Array.isArray(itens)) {
        return res.status(400).json({ success: false, error: 'body.itens deve ser array' });
      }
      const limite = Math.max(1, Math.min(5, Number(req.body.limite) || 3));
      const scoreMin = req.body.scoreMin != null ? Number(req.body.scoreMin) : 0.3;

      const matches = {};
      for (const it of itens.slice(0, 500)) {
        const key = it.key != null ? String(it.key) : null;
        if (key == null) continue;
        matches[key] = matchProdutos(db, it.descricao || '', {
          marcaHint: it.marcaHint,
          limite,
          scoreMin,
        });
      }
      res.json({ success: true, matches });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/produto-match?descricao=...&marcaHint=...&scoreMin=0.3
   * Conveniência pra match único (não usar em loop — prefira bulk).
   */
  app.get('/api/produto-match', (req, res) => {
    try {
      const descricao = String(req.query.descricao || '').trim();
      if (!descricao) return res.status(400).json({ success: false, error: 'descricao obrigatório' });
      const limite = Math.max(1, Math.min(5, Number(req.query.limite) || 3));
      const scoreMin = req.query.scoreMin != null ? Number(req.query.scoreMin) : 0.3;
      const matches = matchProdutos(db, descricao, {
        marcaHint: req.query.marcaHint,
        limite,
        scoreMin,
      });
      res.json({ success: true, matches });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

module.exports = { registrarRotasProdutoMatch };
