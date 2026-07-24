/**
 * reservas-routes.js — Reserva virtual de estoque vinculada a pedidos.
 *
 * Fluxo:
 *   pedido.confirmado → criarReservasPedido() cria reservas (status=ativa)
 *   pedido → rascunho/cancelado (pré-entrega) → cancelarReservasPedido()
 *   pedido.entregue → consumirReservasPedido() converte em saídas reais
 *
 * Status reserva: ativa | consumida | cancelada
 *
 * Uso:
 *   const { registrarRotasReservas, migrarReservasDB,
 *           criarReservasPedido, cancelarReservasPedido, consumirReservasPedido } = require('./reservas-routes');
 *   migrarReservasDB(db);
 *   registrarRotasReservas(app, db);
 */

function migrarReservasDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reservas_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      loteId INTEGER,
      quantidade REAL NOT NULL,
      pedidoId INTEGER NOT NULL,
      pedidoItemId INTEGER,
      status TEXT NOT NULL DEFAULT 'ativa',
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataConsumo TEXT,
      movimentacaoConsumoId INTEGER,
      observacoes TEXT,
      FOREIGN KEY (produtoId) REFERENCES produtos(id),
      FOREIGN KEY (pedidoId) REFERENCES pedidos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_reservas_produto_status ON reservas_estoque(produtoId, status);
    CREATE INDEX IF NOT EXISTS idx_reservas_pedido ON reservas_estoque(pedidoId);
  `);
}

/**
 * Soma reservas ativas de um produto (e opcionalmente lote).
 */
function saldoReservado(db, produtoId, loteId = null) {
  const sql = loteId
    ? `SELECT COALESCE(SUM(quantidade),0) AS q FROM reservas_estoque WHERE produtoId = ? AND loteId = ? AND status = 'ativa'`
    : `SELECT COALESCE(SUM(quantidade),0) AS q FROM reservas_estoque WHERE produtoId = ? AND status = 'ativa'`;
  const params = loteId ? [produtoId, loteId] : [produtoId];
  return db.prepare(sql).get(...params).q || 0;
}

/**
 * Escolhe lote FIFO por validade (mais próximo primeiro) com saldo disponível (saldo - reservado).
 * Retorna array de {loteId, quantidadeLote} somando quantidade.
 */
function alocarLotesFIFO(db, produtoId, quantidade) {
  const lotes = db.prepare(`
    SELECT id, saldoAtual, dataValidade FROM lotes
    WHERE produtoId = ? AND ativo = 1 AND saldoAtual > 0
    ORDER BY CASE WHEN dataValidade IS NULL THEN 1 ELSE 0 END, dataValidade ASC, id ASC
  `).all(produtoId);

  const resultado = [];
  let pendente = Number(quantidade);

  for (const l of lotes) {
    if (pendente <= 0) break;
    const reservado = saldoReservado(db, produtoId, l.id);
    const disponivelLote = l.saldoAtual - reservado;
    if (disponivelLote <= 0) continue;
    const usar = Math.min(disponivelLote, pendente);
    resultado.push({ loteId: l.id, quantidade: usar });
    pendente -= usar;
  }

  // Sobrou quantidade sem lote — sinaliza (produto pode não rastrear lote)
  if (pendente > 0.0001) {
    resultado.push({ loteId: null, quantidade: pendente, insuficiente: true });
  }
  return resultado;
}

/**
 * Pedido movimenta estoque? Falso quando o tipo_operacao tem movimentaEstoque=0
 * (ex.: "VENDA SEM MOVIMENTO", remessa simbólica). Pedidos sem tipoOperacaoId
 * caem no comportamento legado (movimenta).
 */
function pedidoMovimentaEstoque(db, pedidoId) {
  const ped = db.prepare('SELECT tipoOperacaoId FROM pedidos WHERE id = ?').get(pedidoId);
  if (!ped || !ped.tipoOperacaoId) return true;
  const tipoOp = db.prepare('SELECT movimentaEstoque FROM tipos_operacao WHERE id = ?').get(ped.tipoOperacaoId);
  return tipoOp ? !!tipoOp.movimentaEstoque : true;
}

/**
 * Cria reservas para todos os itens do pedido (chamado ao confirmar).
 * Retorna { reservasCriadas, insuficiencias[] }.
 */
function criarReservasPedido(db, pedidoId) {
  // Gate: tipos de operação sem movimento de estoque (ex.: VENDA SEM MOVIMENTO)
  // não devem reservar nem baixar saldo. Sem reserva, consumirReservasPedido
  // também vira no-op naturalmente.
  if (!pedidoMovimentaEstoque(db, pedidoId)) {
    return { reservasCriadas: [], insuficiencias: [] };
  }
  const itensPedido = db.prepare('SELECT * FROM pedido_itens WHERE pedidoId = ?').all(pedidoId);
  const reservasCriadas = [];
  const insuficiencias = [];

  // Explosão de kit: item de pedido apontando para produto tipoProduto='kit'
  // vira N linhas de reserva dos componentes (kit não tem saldo próprio).
  // pedidoItemId das reservas continua o do item original — cancelamento e
  // consumo por pedido/item funcionam sem mudança.
  const itens = [];
  for (const it of itensPedido) {
    if (!it.produtoId) { itens.push(it); continue; }
    const prod = db.prepare('SELECT id, tipoProduto FROM produtos WHERE id = ?').get(it.produtoId);
    if (prod && prod.tipoProduto === 'kit') {
      const componentes = db.prepare('SELECT produtoFilhoId, quantidade FROM produto_kit_itens WHERE produtoPaiId = ?').all(prod.id);
      for (const c of componentes) {
        itens.push({ ...it, produtoId: c.produtoFilhoId, quantidade: Number(it.quantidade) * Number(c.quantidade) });
      }
    } else {
      itens.push(it);
    }
  }

  for (const it of itens) {
    if (!it.produtoId) continue;
    const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(it.produtoId);
    if (!produto) continue;
    const qtd = Number(it.quantidade);
    if (!(qtd > 0)) continue;

    if (produto.rastreiaLote) {
      // Dividir reserva por lote FIFO
      const alocacoes = alocarLotesFIFO(db, it.produtoId, qtd);
      for (const a of alocacoes) {
        if (a.insuficiente) {
          insuficiencias.push({ produtoId: it.produtoId, sku: produto.sku, faltando: a.quantidade });
          continue;
        }
        const r = db.prepare(`
          INSERT INTO reservas_estoque (produtoId, loteId, quantidade, pedidoId, pedidoItemId, status)
          VALUES (?, ?, ?, ?, ?, 'ativa')
        `).run(it.produtoId, a.loteId, a.quantidade, pedidoId, it.id);
        reservasCriadas.push(r.lastInsertRowid);
      }
    } else {
      // Reserva simples, sem lote
      const saldoFisico = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
                                 WHEN tipo='saida' THEN -quantidade
                                 ELSE quantidade END),0) AS s
        FROM movimentacoes_estoque WHERE produtoId = ?
      `).get(it.produtoId).s;
      const reservado = saldoReservado(db, it.produtoId);
      const disponivel = saldoFisico - reservado;
      if (disponivel < qtd) {
        insuficiencias.push({
          produtoId: it.produtoId,
          sku: produto.sku,
          descricao: produto.descricao,
          saldo: saldoFisico,
          reservado,
          disponivel,
          pedido: qtd,
          faltando: qtd - disponivel
        });
      }
      // Cria reserva mesmo com insuficiência (responsabilidade do usuário confirmar)
      const r = db.prepare(`
        INSERT INTO reservas_estoque (produtoId, loteId, quantidade, pedidoId, pedidoItemId, status)
        VALUES (?, NULL, ?, ?, ?, 'ativa')
      `).run(it.produtoId, qtd, pedidoId, it.id);
      reservasCriadas.push(r.lastInsertRowid);
    }
  }

  return { reservasCriadas, insuficiencias };
}

/**
 * Cancela todas reservas ativas de um pedido (chamado ao voltar para rascunho ou cancelar pré-entrega).
 */
function cancelarReservasPedido(db, pedidoId, motivo = null) {
  const result = db.prepare(`
    UPDATE reservas_estoque
    SET status = 'cancelada', observacoes = COALESCE(?, observacoes)
    WHERE pedidoId = ? AND status = 'ativa'
  `).run(motivo, pedidoId);
  return result.changes;
}

/**
 * Converte reservas ativas em saídas reais (chamado ao entregar).
 * Para cada reserva ativa, cria movimentacao_estoque tipo=saida e marca reserva como consumida.
 * Retorna array de ids de movimentações criadas.
 */
function consumirReservasPedido(db, pedidoId, dataConsumo) {
  // Gate consistente com criarReservasPedido. Defensivo: mesmo que reservas
  // existam por outro motivo, não baixa estoque para pedido sem movimento.
  if (!pedidoMovimentaEstoque(db, pedidoId)) {
    return [];
  }
  const { calcularContextoMovimento } = require('./estoque-routes');
  const reservas = db.prepare(`
    SELECT r.*, p.numero AS pedidoNumero
    FROM reservas_estoque r
    JOIN pedidos p ON p.id = r.pedidoId
    WHERE r.pedidoId = ? AND r.status = 'ativa'
  `).all(pedidoId);

  const movIds = [];
  for (const r of reservas) {
    const ctx = calcularContextoMovimento(db, r.produtoId, 'saida', r.quantidade, null);
    const result = db.prepare(`
      INSERT INTO movimentacoes_estoque
        (produtoId, tipo, quantidade, origem, origemId, observacao, data,
         loteId, custoMedioAnterior, custoMedioPosterior, saldoPosterior)
      VALUES (?, 'saida', ?, 'pedido', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.produtoId, r.quantidade, pedidoId,
      `Saída pelo pedido ${r.pedidoNumero} (reserva #${r.id})`,
      dataConsumo, r.loteId,
      ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior
    );
    const movId = result.lastInsertRowid;
    movIds.push(movId);

    // Atualizar saldoAtual do lote
    if (r.loteId) {
      db.prepare('UPDATE lotes SET saldoAtual = saldoAtual - ? WHERE id = ?').run(r.quantidade, r.loteId);
    }

    db.prepare(`
      UPDATE reservas_estoque
      SET status = 'consumida', dataConsumo = ?, movimentacaoConsumoId = ?
      WHERE id = ?
    `).run(dataConsumo, movId, r.id);
  }
  return movIds;
}

/**
 * Ordem de Serviço — Plano 9.1 (2026-04-22).
 * Funções gêmeas das do pedido, mas operando sobre os_itens_pecas via osId.
 */
function criarReservasOS(db, osId) {
  const itens = db.prepare('SELECT * FROM os_itens_pecas WHERE osId = ?').all(osId);
  const reservasCriadas = [];
  const insuficiencias = [];

  for (const it of itens) {
    if (!it.produtoId) continue;
    if (it.compradoTerceiro) continue; // terceiros têm fluxo próprio (entrada+saída direta)
    const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(it.produtoId);
    if (!produto) continue;
    const qtd = Number(it.quantidade);
    if (!(qtd > 0)) continue;

    if (produto.rastreiaLote) {
      const alocacoes = alocarLotesFIFO(db, it.produtoId, qtd);
      for (const a of alocacoes) {
        if (a.insuficiente) {
          insuficiencias.push({ produtoId: it.produtoId, sku: produto.sku, faltando: a.quantidade });
          continue;
        }
        const r = db.prepare(`
          INSERT INTO reservas_estoque (produtoId, loteId, quantidade, osId, osItemPecaId, status)
          VALUES (?, ?, ?, ?, ?, 'ativa')
        `).run(it.produtoId, a.loteId, a.quantidade, osId, it.id);
        reservasCriadas.push(r.lastInsertRowid);
      }
    } else {
      const saldoFisico = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
                                 WHEN tipo='saida' THEN -quantidade
                                 ELSE quantidade END),0) AS s
        FROM movimentacoes_estoque WHERE produtoId = ?
      `).get(it.produtoId).s;
      const reservado = saldoReservado(db, it.produtoId);
      const disponivel = saldoFisico - reservado;
      if (disponivel < qtd) {
        insuficiencias.push({
          produtoId: it.produtoId, sku: produto.sku, descricao: produto.descricao,
          saldo: saldoFisico, reservado, disponivel, pedido: qtd, faltando: qtd - disponivel
        });
      }
      const r = db.prepare(`
        INSERT INTO reservas_estoque (produtoId, loteId, quantidade, osId, osItemPecaId, status)
        VALUES (?, NULL, ?, ?, ?, 'ativa')
      `).run(it.produtoId, qtd, osId, it.id);
      reservasCriadas.push(r.lastInsertRowid);
    }
  }

  return { reservasCriadas, insuficiencias };
}

function cancelarReservasOS(db, osId, motivo = null) {
  const result = db.prepare(`
    UPDATE reservas_estoque
    SET status = 'cancelada', observacoes = COALESCE(?, observacoes)
    WHERE osId = ? AND status = 'ativa'
  `).run(motivo, osId);
  return result.changes;
}

function consumirReservasOS(db, osId, dataConsumo) {
  const { calcularContextoMovimento } = require('./estoque-routes');
  const reservas = db.prepare(`
    SELECT r.*, o.numero AS osNumero
    FROM reservas_estoque r
    JOIN os_ordens o ON o.id = r.osId
    WHERE r.osId = ? AND r.status = 'ativa'
  `).all(osId);

  const movIds = [];
  for (const r of reservas) {
    const ctx = calcularContextoMovimento(db, r.produtoId, 'saida', r.quantidade, null);
    const result = db.prepare(`
      INSERT INTO movimentacoes_estoque
        (produtoId, tipo, quantidade, origem, origemId, observacao, data,
         loteId, custoMedioAnterior, custoMedioPosterior, saldoPosterior)
      VALUES (?, 'saida', ?, 'os', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.produtoId, r.quantidade, osId,
      `Saída pela OS ${r.osNumero} (reserva #${r.id})`,
      dataConsumo, r.loteId,
      ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior
    );
    const movId = result.lastInsertRowid;
    movIds.push(movId);

    if (r.loteId) {
      db.prepare('UPDATE lotes SET saldoAtual = saldoAtual - ? WHERE id = ?').run(r.quantidade, r.loteId);
    }

    db.prepare(`
      UPDATE reservas_estoque
      SET status = 'consumida', dataConsumo = ?, movimentacaoConsumoId = ?
      WHERE id = ?
    `).run(dataConsumo, movId, r.id);

    // Marca o os_item_peca com o movSaidaId para bloquear remoção subsequente
    if (r.osItemPecaId) {
      db.prepare('UPDATE os_itens_pecas SET movSaidaId = ? WHERE id = ?').run(movId, r.osItemPecaId);
    }
  }
  return movIds;
}

function registrarRotasReservas(app, db) {
  migrarReservasDB(db);

  // ==================== LISTAGEM ====================

  app.get('/api/reservas', (req, res) => {
    try {
      const { status, produtoId, pedidoId, limit } = req.query;
      let sql = `SELECT r.*, p.sku, p.descricao, p.unidade,
                        l.numero AS loteNumero, l.dataValidade AS loteValidade,
                        ped.numero AS pedidoNumero, ped.status AS pedidoStatus,
                        ped.clienteId, cli.razaoSocial AS clienteNome
                 FROM reservas_estoque r
                 JOIN produtos p ON p.id = r.produtoId
                 LEFT JOIN lotes l ON l.id = r.loteId
                 LEFT JOIN pedidos ped ON ped.id = r.pedidoId
                 LEFT JOIN pessoas cli ON cli.id = ped.clienteId
                 WHERE 1=1`;
      const params = [];
      if (status) { sql += ' AND r.status = ?'; params.push(status); }
      else { sql += " AND r.status = 'ativa'"; }
      if (produtoId) { sql += ' AND r.produtoId = ?'; params.push(produtoId); }
      if (pedidoId) { sql += ' AND r.pedidoId = ?'; params.push(pedidoId); }
      sql += ' ORDER BY r.dataCriacao DESC LIMIT ?';
      params.push(Number(limit) || 200);
      const reservas = db.prepare(sql).all(...params);
      res.json({ success: true, reservas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== VERIFICAR DISPONIBILIDADE ====================

  app.post('/api/estoque/verificar-disponibilidade', (req, res) => {
    try {
      const { itens } = req.body;
      if (!Array.isArray(itens)) return res.status(400).json({ success: false, error: 'itens (array) obrigatorio' });

      const resultado = itens.map(it => {
        const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(it.produtoId);
        if (!produto) return { ...it, erro: 'produto nao encontrado' };
        const saldo = db.prepare(`
          SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
                                   WHEN tipo='saida' THEN -quantidade
                                   ELSE quantidade END),0) AS s
          FROM movimentacoes_estoque WHERE produtoId = ?
        `).get(it.produtoId).s;
        const reservado = saldoReservado(db, it.produtoId);
        const disponivel = saldo - reservado;
        return {
          produtoId: it.produtoId,
          sku: produto.sku,
          descricao: produto.descricao,
          quantidadePedida: it.quantidade,
          saldo, reservado, disponivel,
          suficiente: disponivel >= it.quantidade,
          faltando: Math.max(0, it.quantidade - disponivel)
        };
      });

      const insuficientes = resultado.filter(r => !r.suficiente);
      res.json({
        success: true,
        tudoDisponivel: insuficientes.length === 0,
        itens: resultado,
        insuficientes
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CANCELAR RESERVA INDIVIDUAL ====================

  app.post('/api/reservas/:id/cancelar', (req, res) => {
    try {
      const reserva = db.prepare('SELECT * FROM reservas_estoque WHERE id = ?').get(req.params.id);
      if (!reserva) return res.status(404).json({ success: false, error: 'Reserva nao encontrada' });
      if (reserva.status !== 'ativa') return res.status(400).json({ success: false, error: 'Reserva nao esta ativa' });
      db.prepare(`
        UPDATE reservas_estoque SET status='cancelada', observacoes=? WHERE id=?
      `).run(req.body?.motivo || 'cancelamento manual', req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = {
  registrarRotasReservas,
  migrarReservasDB,
  saldoReservado,
  alocarLotesFIFO,
  criarReservasPedido,
  cancelarReservasPedido,
  consumirReservasPedido,
  criarReservasOS,
  cancelarReservasOS,
  consumirReservasOS,
};
