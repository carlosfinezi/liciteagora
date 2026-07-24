/**
 * inventario-routes.js — Inventário/contagem física de estoque.
 *
 * Fluxo:
 *   1. POST /api/inventarios → cria inventário em status 'aberto', tira snapshot do saldo atual em inventario_itens
 *   2. PUT /api/inventarios/:id/itens/:itemId/contar → grava saldoContado e calcula diferença
 *   3. POST /api/inventarios/:id/finalizar → gera movimentacoes_estoque tipo=ajuste para cada item divergente
 *
 * Uso:
 *   const { registrarRotasInventario } = require('./inventario-routes');
 *   registrarRotasInventario(app, db);
 */

function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function migrarInventarioDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL,
      descricao TEXT,
      status TEXT NOT NULL DEFAULT 'aberto',
      dataAbertura TEXT DEFAULT CURRENT_TIMESTAMP,
      dataFinalizacao TEXT,
      usuarioResponsavel TEXT,
      observacoes TEXT,
      totalProdutos INTEGER DEFAULT 0,
      totalDivergencias INTEGER DEFAULT 0,
      valorDivergencia REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_inventarios_status ON inventarios(status);

    CREATE TABLE IF NOT EXISTS inventario_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventarioId INTEGER NOT NULL,
      produtoId INTEGER NOT NULL,
      loteId INTEGER,
      saldoSistema REAL NOT NULL,
      saldoContado REAL,
      diferenca REAL,
      custoUnitario REAL,
      valorDiferenca REAL,
      ajusteMovimentacaoId INTEGER,
      observacoes TEXT,
      dataContagem TEXT,
      FOREIGN KEY (inventarioId) REFERENCES inventarios(id),
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_invitens_inventario ON inventario_itens(inventarioId);
    CREATE INDEX IF NOT EXISTS idx_invitens_produto ON inventario_itens(produtoId);
  `);
}

function proximoCodigo(db) {
  const ano = new Date().getFullYear();
  const prefixo = `INV-${ano}-`;
  const ult = db.prepare(`
    SELECT codigo FROM inventarios
    WHERE codigo LIKE ? ORDER BY id DESC LIMIT 1
  `).get(prefixo + '%');
  let n = 1;
  if (ult) {
    const m = ult.codigo.match(/-(\d+)$/);
    if (m) n = parseInt(m[1]) + 1;
  }
  return prefixo + String(n).padStart(4, '0');
}

function registrarRotasInventario(app, db) {
  migrarInventarioDB(db);

  // ==================== LISTAGEM ====================

  app.get('/api/inventarios', (req, res) => {
    try {
      const { status } = req.query;
      let sql = `SELECT i.*,
                  (SELECT COUNT(*) FROM inventario_itens WHERE inventarioId = i.id) AS totalItens,
                  (SELECT COUNT(*) FROM inventario_itens WHERE inventarioId = i.id AND saldoContado IS NOT NULL) AS itensContados
                 FROM inventarios i WHERE 1=1`;
      const params = [];
      if (status) { sql += ' AND i.status = ?'; params.push(status); }
      sql += ' ORDER BY i.dataAbertura DESC, i.id DESC';
      const inventarios = db.prepare(sql).all(...params);
      res.json({ success: true, inventarios });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/inventarios/:id', (req, res) => {
    try {
      const inv = db.prepare('SELECT * FROM inventarios WHERE id = ?').get(req.params.id);
      if (!inv) return res.status(404).json({ success: false, error: 'Inventario nao encontrado' });

      const itens = db.prepare(`
        SELECT ii.*, p.sku, p.descricao, p.unidade, p.rastreiaLote,
               l.numero AS loteNumero, l.dataValidade AS loteValidade
        FROM inventario_itens ii
        JOIN produtos p ON p.id = ii.produtoId
        LEFT JOIN lotes l ON l.id = ii.loteId
        WHERE ii.inventarioId = ?
        ORDER BY p.descricao ASC, ii.id ASC
      `).all(req.params.id);

      const estatisticas = {
        total: itens.length,
        contados: itens.filter(i => i.saldoContado != null).length,
        pendentes: itens.filter(i => i.saldoContado == null).length,
        comDivergencia: itens.filter(i => i.diferenca != null && Math.abs(i.diferenca) > 0.001).length,
        valorDivergencia: itens.reduce((s, i) => s + (i.valorDiferenca || 0), 0)
      };

      res.json({ success: true, inventario: inv, itens, estatisticas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== ABERTURA (snapshot) ====================

  app.post('/api/inventarios', (req, res) => {
    try {
      const { descricao, observacoes, usuarioResponsavel, filtro } = req.body;
      // filtro: 'todos' | 'comSaldo' | 'porCategoria:<cat>' | 'rastreiaLote' | 'rastreiaSerial'
      const modo = filtro || 'comSaldo';

      const codigo = proximoCodigo(db);

      let whereProdutos = 'p.ativo = 1';
      if (modo === 'rastreiaLote') whereProdutos += ' AND p.rastreiaLote = 1';
      else if (modo === 'rastreiaSerial') whereProdutos += ' AND p.rastreiaSerial = 1';

      const trx = db.transaction(() => {
        const invResult = db.prepare(`
          INSERT INTO inventarios (codigo, descricao, status, usuarioResponsavel, observacoes)
          VALUES (?, ?, 'aberto', ?, ?)
        `).run(codigo, descricao || null, usuarioResponsavel || null, observacoes || null);
        const inventarioId = invResult.lastInsertRowid;

        // Para produtos SEM rastreio de lote: 1 linha por produto (saldo agregado)
        // Para produtos COM rastreio: 1 linha por lote ativo com saldo + 1 linha do produto
        //   (para identificar inconsistências entre soma-lotes e saldo-total)
        const produtos = db.prepare(`
          SELECT p.id, p.sku, p.descricao, p.rastreiaLote,
            COALESCE((SELECT SUM(CASE WHEN tipo='entrada' THEN quantidade
                                      WHEN tipo='saida' THEN -quantidade
                                      ELSE quantidade END)
                      FROM movimentacoes_estoque WHERE produtoId = p.id), 0) AS saldo,
            COALESCE((SELECT custoMedioPosterior FROM movimentacoes_estoque
                      WHERE produtoId = p.id AND custoMedioPosterior IS NOT NULL
                      ORDER BY data DESC, id DESC LIMIT 1), p.precoCusto) AS custoMedio
          FROM produtos p WHERE ${whereProdutos}
          ORDER BY p.descricao ASC
        `).all();

        const insertItem = db.prepare(`
          INSERT INTO inventario_itens (inventarioId, produtoId, loteId, saldoSistema, custoUnitario)
          VALUES (?, ?, ?, ?, ?)
        `);

        let totalItens = 0;
        for (const p of produtos) {
          if (modo === 'comSaldo' && p.saldo <= 0) continue;

          if (p.rastreiaLote) {
            // Itens por lote
            const lotes = db.prepare(`
              SELECT id, saldoAtual, custoUnitario FROM lotes
              WHERE produtoId = ? AND ativo = 1 AND (saldoAtual > 0 OR ? = 'todos')
            `).all(p.id, modo);
            for (const l of lotes) {
              insertItem.run(inventarioId, p.id, l.id, l.saldoAtual, l.custoUnitario || p.custoMedio || null);
              totalItens++;
            }
            // Se não encontrou nenhum lote mas existe saldo global, adiciona uma linha sem lote
            if (!lotes.length && p.saldo > 0) {
              insertItem.run(inventarioId, p.id, null, p.saldo, p.custoMedio || null);
              totalItens++;
            }
          } else {
            insertItem.run(inventarioId, p.id, null, p.saldo, p.custoMedio || null);
            totalItens++;
          }
        }

        db.prepare('UPDATE inventarios SET totalProdutos = ? WHERE id = ?')
          .run(totalItens, inventarioId);

        return inventarioId;
      });

      const id = trx();
      const inventario = db.prepare('SELECT * FROM inventarios WHERE id = ?').get(id);
      res.json({ success: true, inventario });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CONTAGEM DE UM ITEM ====================

  app.put('/api/inventarios/:id/itens/:itemId/contar', (req, res) => {
    try {
      const inv = db.prepare('SELECT * FROM inventarios WHERE id = ?').get(req.params.id);
      if (!inv) return res.status(404).json({ success: false, error: 'Inventario nao encontrado' });
      if (!['aberto', 'em_contagem'].includes(inv.status)) {
        return res.status(400).json({ success: false, error: 'Inventario nao esta em contagem' });
      }

      const item = db.prepare('SELECT * FROM inventario_itens WHERE id = ? AND inventarioId = ?')
        .get(req.params.itemId, req.params.id);
      if (!item) return res.status(404).json({ success: false, error: 'Item nao encontrado' });

      const { saldoContado, observacoes } = req.body;
      if (saldoContado == null || isNaN(Number(saldoContado))) {
        return res.status(400).json({ success: false, error: 'saldoContado numerico obrigatorio' });
      }

      const contado = Number(saldoContado);
      const diferenca = contado - item.saldoSistema;
      const valorDiferenca = diferenca * (item.custoUnitario || 0);

      db.prepare(`
        UPDATE inventario_itens
        SET saldoContado = ?, diferenca = ?, valorDiferenca = ?,
            observacoes = COALESCE(?, observacoes),
            dataContagem = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(contado, diferenca, valorDiferenca, observacoes || null, req.params.itemId);

      // Atualizar status do inventário pra em_contagem se era aberto
      if (inv.status === 'aberto') {
        db.prepare("UPDATE inventarios SET status = 'em_contagem' WHERE id = ?").run(req.params.id);
      }

      const atualizado = db.prepare('SELECT * FROM inventario_itens WHERE id = ?').get(req.params.itemId);
      res.json({ success: true, item: atualizado });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== FINALIZAR (gera ajustes) ====================

  app.post('/api/inventarios/:id/finalizar', (req, res) => {
    try {
      const inv = db.prepare('SELECT * FROM inventarios WHERE id = ?').get(req.params.id);
      if (!inv) return res.status(404).json({ success: false, error: 'Inventario nao encontrado' });
      if (inv.status === 'finalizado') {
        return res.status(400).json({ success: false, error: 'Inventario ja finalizado' });
      }
      if (inv.status === 'cancelado') {
        return res.status(400).json({ success: false, error: 'Inventario cancelado — reabra ou crie novo' });
      }

      const { calcularContextoMovimento } = require('./estoque-routes');
      const { ignorarNaoContados } = req.body || {};

      const itens = db.prepare(`
        SELECT ii.*, p.sku FROM inventario_itens ii
        JOIN produtos p ON p.id = ii.produtoId
        WHERE ii.inventarioId = ?
      `).all(req.params.id);

      const naoContados = itens.filter(i => i.saldoContado == null);
      if (naoContados.length && !ignorarNaoContados) {
        return res.status(400).json({
          success: false,
          error: `${naoContados.length} item(ns) nao foram contados. Envie { ignorarNaoContados: true } para finalizar mesmo assim.`,
          naoContados: naoContados.map(i => ({ id: i.id, sku: i.sku }))
        });
      }

      const dataAjuste = dataBrasilia();
      const ajustesGerados = [];
      let totalDivergencias = 0;
      let valorDivergencia = 0;

      const tx = db.transaction(() => {
        for (const item of itens) {
          if (item.saldoContado == null) continue;
          const dif = Number(item.diferenca || 0);
          if (Math.abs(dif) < 0.001) continue;  // sem divergência significativa

          // Gerar ajuste no estoque (tipo=ajuste, quantidade = diferenca [pode ser negativa])
          const ctx = calcularContextoMovimento(db, item.produtoId, 'ajuste', dif, null);

          const result = db.prepare(`
            INSERT INTO movimentacoes_estoque
              (produtoId, tipo, quantidade, origem, origemId, observacao, data,
               loteId, custoMedioAnterior, custoMedioPosterior, saldoPosterior)
            VALUES (?, 'ajuste', ?, 'inventario', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            item.produtoId, dif, req.params.id,
            `Ajuste de inventário ${inv.codigo}: sistema=${item.saldoSistema} contado=${item.saldoContado}`,
            dataAjuste, item.loteId,
            ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior
          );
          const movId = result.lastInsertRowid;

          // Atualizar saldoAtual do lote
          if (item.loteId) {
            db.prepare('UPDATE lotes SET saldoAtual = saldoAtual + ? WHERE id = ?').run(dif, item.loteId);
          }

          db.prepare('UPDATE inventario_itens SET ajusteMovimentacaoId = ? WHERE id = ?')
            .run(movId, item.id);

          ajustesGerados.push({ itemId: item.id, movimentacaoId: movId, diferenca: dif });
          totalDivergencias++;
          valorDivergencia += Math.abs(item.valorDiferenca || 0);
        }

        db.prepare(`
          UPDATE inventarios
          SET status = 'finalizado',
              dataFinalizacao = CURRENT_TIMESTAMP,
              totalDivergencias = ?,
              valorDivergencia = ?
          WHERE id = ?
        `).run(totalDivergencias, valorDivergencia, req.params.id);
      });
      tx();

      res.json({ success: true, ajustesGerados, totalDivergencias, valorDivergencia });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CANCELAR ====================

  app.post('/api/inventarios/:id/cancelar', (req, res) => {
    try {
      const inv = db.prepare('SELECT * FROM inventarios WHERE id = ?').get(req.params.id);
      if (!inv) return res.status(404).json({ success: false, error: 'Inventario nao encontrado' });
      if (inv.status === 'finalizado') {
        return res.status(400).json({ success: false, error: 'Inventario ja finalizado' });
      }
      db.prepare(`UPDATE inventarios SET status = 'cancelado', dataFinalizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasInventario, migrarInventarioDB };
