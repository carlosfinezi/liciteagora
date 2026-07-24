/**
 * serial-routes.js — CRUD e consulta de números de série.
 * Tabela `serial_numbers` criada por estoque-routes.migrarEstoqueDB.
 *
 * Uso:
 *   const { registrarRotasSerial } = require('./serial-routes');
 *   registrarRotasSerial(app, db);
 */

const STATUS_VALIDOS = new Set(['disponivel', 'reservado', 'baixado', 'estornado']);

function registrarRotasSerial(app, db) {
  // ==================== LISTAGEM ====================

  app.get('/api/serial', (req, res) => {
    try {
      const { produtoId, status, loteId, q, limit } = req.query;
      let sql = `SELECT s.*, p.sku, p.descricao,
                        l.numero AS loteNumero, l.dataValidade AS loteValidade
                 FROM serial_numbers s
                 JOIN produtos p ON p.id = s.produtoId
                 LEFT JOIN lotes l ON l.id = s.loteId
                 WHERE 1=1`;
      const params = [];
      if (produtoId) { sql += ' AND s.produtoId = ?'; params.push(produtoId); }
      if (status)    { sql += ' AND s.status = ?';    params.push(status); }
      if (loteId)    { sql += ' AND s.loteId = ?';    params.push(loteId); }
      if (q) {
        sql += ' AND s.numero LIKE ?';
        params.push(`%${q}%`);
      }
      sql += ' ORDER BY s.produtoId, s.numero LIMIT ?';
      params.push(Number(limit) || 500);
      const serial = db.prepare(sql).all(...params);
      res.json({ success: true, serial });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Histórico completo de um serial (entrada, reserva, baixa)
  app.get('/api/serial/historico/:numero', (req, res) => {
    try {
      const { produtoId } = req.query;
      const filtro = produtoId ? ' AND s.produtoId = ?' : '';
      const params = produtoId ? [req.params.numero, produtoId] : [req.params.numero];
      const serial = db.prepare(`
        SELECT s.*, p.sku, p.descricao,
               l.numero AS loteNumero
        FROM serial_numbers s
        JOIN produtos p ON p.id = s.produtoId
        LEFT JOIN lotes l ON l.id = s.loteId
        WHERE s.numero = ?${filtro}
      `).get(...params);
      if (!serial) return res.status(404).json({ success: false, error: 'Numero de serie nao encontrado' });

      const movimentacoes = [];
      if (serial.movEntradaId) {
        const m = db.prepare('SELECT * FROM movimentacoes_estoque WHERE id = ?').get(serial.movEntradaId);
        if (m) movimentacoes.push({ ...m, evento: 'entrada' });
      }
      if (serial.movSaidaId) {
        const m = db.prepare('SELECT * FROM movimentacoes_estoque WHERE id = ?').get(serial.movSaidaId);
        if (m) movimentacoes.push({ ...m, evento: 'saida' });
      }
      res.json({ success: true, serial, movimentacoes });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/serial/:id', (req, res) => {
    try {
      const serial = db.prepare(`
        SELECT s.*, p.sku, p.descricao,
               l.numero AS loteNumero
        FROM serial_numbers s
        JOIN produtos p ON p.id = s.produtoId
        LEFT JOIN lotes l ON l.id = s.loteId
        WHERE s.id = ?
      `).get(req.params.id);
      if (!serial) return res.status(404).json({ success: false, error: 'Nao encontrado' });
      res.json({ success: true, serial });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CRIAÇÃO (em lote) ====================

  app.post('/api/serial', (req, res) => {
    try {
      const { produtoId, loteId, numeros, observacoes } = req.body;

      if (!produtoId || !Array.isArray(numeros) || numeros.length === 0) {
        return res.status(400).json({ success: false, error: 'produtoId e numeros (array) obrigatorios' });
      }

      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(produtoId);
      if (!produto) return res.status(404).json({ success: false, error: 'Produto nao encontrado' });
      if (!produto.rastreiaSerial) {
        return res.status(400).json({
          success: false,
          error: `Produto '${produto.sku}' não está configurado para rastreamento por número de série. Ative "Rastreia número de série" no cadastro do produto.`
        });
      }

      const trx = db.transaction(() => {
        const criados = [];
        const stmt = db.prepare(`
          INSERT INTO serial_numbers (produtoId, loteId, numero, status, observacoes)
          VALUES (?, ?, ?, 'disponivel', ?)
        `);
        for (const numero of numeros) {
          const n = String(numero || '').trim();
          if (!n) continue;
          // Unicidade global: serial não pode existir em nenhum produto
          const existe = db.prepare(`
            SELECT s.id, s.produtoId, p.sku FROM serial_numbers s
            JOIN produtos p ON p.id = s.produtoId
            WHERE s.numero = ?
          `).get(n);
          if (existe) {
            throw new Error(
              existe.produtoId === Number(produtoId)
                ? `Número de série '${n}' já existe para este produto`
                : `Número de série '${n}' já está cadastrado no produto '${existe.sku}'`
            );
          }
          const r = stmt.run(produtoId, loteId || null, n, observacoes || null);
          criados.push(r.lastInsertRowid);
        }
        return criados;
      });
      const ids = trx();

      const criados = db.prepare(`SELECT * FROM serial_numbers WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      res.json({ success: true, serial: criados, total: criados.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== ATUALIZAR STATUS OU LOTE ====================

  app.put('/api/serial/:id', (req, res) => {
    try {
      const serial = db.prepare('SELECT * FROM serial_numbers WHERE id = ?').get(req.params.id);
      if (!serial) return res.status(404).json({ success: false, error: 'Nao encontrado' });

      const { status, loteId, observacoes } = req.body;
      if (status && !STATUS_VALIDOS.has(status)) {
        return res.status(400).json({ success: false, error: 'status invalido' });
      }

      db.prepare(`
        UPDATE serial_numbers SET
          status = COALESCE(?, status),
          loteId = ?,
          observacoes = ?
        WHERE id = ?
      `).run(
        status || null,
        loteId !== undefined ? loteId : serial.loteId,
        observacoes !== undefined ? observacoes : serial.observacoes,
        req.params.id
      );

      const atualizado = db.prepare('SELECT * FROM serial_numbers WHERE id = ?').get(req.params.id);
      res.json({ success: true, serial: atualizado });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== EXCLUIR (apenas disponiveis nao movimentados) ====================

  app.delete('/api/serial/:id', (req, res) => {
    try {
      const serial = db.prepare('SELECT * FROM serial_numbers WHERE id = ?').get(req.params.id);
      if (!serial) return res.status(404).json({ success: false, error: 'Nao encontrado' });
      if (serial.movEntradaId || serial.movSaidaId) {
        return res.status(400).json({ success: false, error: 'Serial ja movimentado — nao pode excluir' });
      }
      db.prepare('DELETE FROM serial_numbers WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasSerial };
