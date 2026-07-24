/**
 * lotes-routes.js — CRUD de lotes de produtos (rastreabilidade).
 * Tabela `lotes` criada por estoque-routes.migrarEstoqueDB.
 *
 * Uso:
 *   const { registrarRotasLotes } = require('./lotes-routes');
 *   registrarRotasLotes(app, db);
 */

function registrarRotasLotes(app, db) {
  // ==================== LISTAGEM ====================

  app.get('/api/lotes', (req, res) => {
    try {
      const { produtoId, ativo, vencendoDias, comSaldo } = req.query;
      let sql = `SELECT l.*, p.sku, p.descricao, p.unidade,
                        f.razaoSocial AS fornecedorNome
                 FROM lotes l
                 JOIN produtos p ON p.id = l.produtoId
                 LEFT JOIN fornecedores f ON f.id = l.fornecedorId
                 WHERE 1=1`;
      const params = [];
      if (produtoId) { sql += ' AND l.produtoId = ?'; params.push(produtoId); }
      if (ativo !== undefined) { sql += ' AND l.ativo = ?'; params.push(Number(ativo)); }
      else { sql += ' AND l.ativo = 1'; }
      if (comSaldo === '1') { sql += ' AND l.saldoAtual > 0'; }

      if (vencendoDias) {
        sql += ` AND l.dataValidade IS NOT NULL
                 AND date(l.dataValidade) <= date('now', '+' || ? || ' days')
                 AND date(l.dataValidade) >= date('now', '-1 day')`;
        params.push(Number(vencendoDias));
      }

      sql += ' ORDER BY CASE WHEN l.dataValidade IS NULL THEN 1 ELSE 0 END, l.dataValidade ASC, l.id DESC';
      const lotes = db.prepare(sql).all(...params);
      res.json({ success: true, lotes });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/lotes/vencendo', (req, res) => {
    try {
      const dias = Number(req.query.dias) || 30;
      const lotes = db.prepare(`
        SELECT l.*, p.sku, p.descricao, p.unidade
        FROM lotes l
        JOIN produtos p ON p.id = l.produtoId
        WHERE l.ativo = 1 AND l.saldoAtual > 0
          AND l.dataValidade IS NOT NULL
          AND date(l.dataValidade) <= date('now', '+' || ? || ' days')
        ORDER BY l.dataValidade ASC
      `).all(dias);
      res.json({ success: true, lotes, diasJanela: dias });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/lotes/:id', (req, res) => {
    try {
      const lote = db.prepare(`
        SELECT l.*, p.sku, p.descricao, p.unidade,
               f.razaoSocial AS fornecedorNome
        FROM lotes l
        JOIN produtos p ON p.id = l.produtoId
        LEFT JOIN fornecedores f ON f.id = l.fornecedorId
        WHERE l.id = ?
      `).get(req.params.id);
      if (!lote) return res.status(404).json({ success: false, error: 'Lote nao encontrado' });

      const movimentacoes = db.prepare(`
        SELECT m.*, p.sku FROM movimentacoes_estoque m
        JOIN produtos p ON p.id = m.produtoId
        WHERE m.loteId = ? ORDER BY m.data DESC, m.id DESC
      `).all(req.params.id);

      const serial = db.prepare(`
        SELECT * FROM serial_numbers WHERE loteId = ? ORDER BY numero
      `).all(req.params.id);

      res.json({ success: true, lote, movimentacoes, serial });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CRIAÇÃO ====================

  app.post('/api/lotes', (req, res) => {
    try {
      const { produtoId, numero, dataFabricacao, dataValidade,
              quantidadeInicial, custoUnitario, nfeEntradaId,
              fornecedorId, observacoes } = req.body;

      if (!produtoId || !numero) {
        return res.status(400).json({ success: false, error: 'produtoId e numero sao obrigatorios' });
      }
      const qtd = Number(quantidadeInicial) || 0;
      if (qtd < 0) return res.status(400).json({ success: false, error: 'quantidadeInicial nao pode ser negativa' });

      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(produtoId);
      if (!produto) return res.status(404).json({ success: false, error: 'Produto nao encontrado' });

      // Verificar duplicidade de numero no mesmo produto
      const existente = db.prepare('SELECT id FROM lotes WHERE produtoId = ? AND numero = ? AND ativo = 1').get(produtoId, numero);
      if (existente) return res.status(409).json({ success: false, error: 'Ja existe lote com este numero para este produto' });

      const result = db.prepare(`
        INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade,
                          quantidadeInicial, saldoAtual, custoUnitario,
                          nfeEntradaId, fornecedorId, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        produtoId, numero, dataFabricacao || null, dataValidade || null,
        qtd, qtd, custoUnitario != null ? Number(custoUnitario) : null,
        nfeEntradaId || null, fornecedorId || null, observacoes || null
      );

      const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(result.lastInsertRowid);
      res.json({ success: true, lote });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== EDIÇÃO ====================

  app.put('/api/lotes/:id', (req, res) => {
    try {
      const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
      if (!lote) return res.status(404).json({ success: false, error: 'Lote nao encontrado' });

      const { numero, dataFabricacao, dataValidade, custoUnitario,
              fornecedorId, observacoes } = req.body;

      db.prepare(`
        UPDATE lotes SET
          numero = COALESCE(?, numero),
          dataFabricacao = ?,
          dataValidade = ?,
          custoUnitario = ?,
          fornecedorId = ?,
          observacoes = ?
        WHERE id = ?
      `).run(
        numero || null,
        dataFabricacao !== undefined ? dataFabricacao : lote.dataFabricacao,
        dataValidade !== undefined ? dataValidade : lote.dataValidade,
        custoUnitario !== undefined ? (custoUnitario != null ? Number(custoUnitario) : null) : lote.custoUnitario,
        fornecedorId !== undefined ? fornecedorId : lote.fornecedorId,
        observacoes !== undefined ? observacoes : lote.observacoes,
        req.params.id
      );

      const atualizado = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
      res.json({ success: true, lote: atualizado });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== DESATIVAR ====================

  app.delete('/api/lotes/:id', (req, res) => {
    try {
      const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
      if (!lote) return res.status(404).json({ success: false, error: 'Lote nao encontrado' });
      if (lote.saldoAtual > 0) {
        return res.status(400).json({ success: false, error: 'Lote ainda tem saldo — zere com ajuste/saida antes de desativar' });
      }
      db.prepare('UPDATE lotes SET ativo = 0 WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasLotes };
