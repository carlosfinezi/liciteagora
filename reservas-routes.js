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

// Depósito da reserva: resolve uma vez por documento.
const { resolverDeposito } = require('./estoque-routes');

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
 *
 * `excetoPedidoId` desconta as reservas do próprio pedido: quem pergunta
 * "quanto sobra para MIM" não pode ver a própria reserva como indisponível —
 * senão o pedido já confirmado se declara em falta e manda comprar em dobro.
 */
function saldoReservado(db, produtoId, loteId = null, excetoPedidoId = null) {
  let sql = `SELECT COALESCE(SUM(quantidade),0) AS q FROM reservas_estoque
             WHERE produtoId = ? AND status = 'ativa'`;
  const params = [produtoId];
  if (loteId) { sql += ' AND loteId = ?'; params.push(loteId); }
  if (excetoPedidoId) { sql += ' AND (pedidoId IS NULL OR pedidoId != ?)'; params.push(excetoPedidoId); }
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
 * Itens do pedido com kit explodido: item apontando para produto tipoProduto='kit'
 * vira N linhas dos componentes (kit não tem saldo próprio). O `id` de cada linha
 * continua sendo o do item original — cancelamento, consumo e vínculo por
 * pedido/item funcionam sem mudança.
 *
 * Quem pergunta por saldo (reserva ou falta de compra) precisa da MESMA explosão:
 * sem ela todo kit apareceria em falta pela quantidade inteira.
 */
function explodirItensPedido(db, pedidoId) {
  const itensPedido = db.prepare('SELECT * FROM pedido_itens WHERE pedidoId = ?').all(pedidoId);
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
  return itens;
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
  // Depósito de onde a mercadoria sai — a reserva carrega isso até o
  // consumo, que é quem gera a saída.
  const depositoDoc = resolverDeposito(db, {
    depositoId: (db.prepare('SELECT depositoId FROM pedidos WHERE id = ?').get(pedidoId) || {}).depositoId,
  });
  const reservasCriadas = [];
  const insuficiencias = [];
  const itens = explodirItensPedido(db, pedidoId);

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
          INSERT INTO reservas_estoque (produtoId, loteId, quantidade, pedidoId, pedidoItemId, status, depositoId)
          VALUES (?, ?, ?, ?, ?, 'ativa', ?)
        `).run(it.produtoId, a.loteId, a.quantidade, pedidoId, it.id, depositoDoc);
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
        INSERT INTO reservas_estoque (produtoId, loteId, quantidade, pedidoId, pedidoItemId, status, depositoId)
        VALUES (?, NULL, ?, ?, ?, 'ativa', ?)
      `).run(it.produtoId, qtd, pedidoId, it.id, depositoDoc);
      reservasCriadas.push(r.lastInsertRowid);
    }
  }

  return { reservasCriadas, insuficiencias };
}

/**
 * Saldo físico global do produto (mesma conta que criarReservasPedido usa —
 * soma das movimentações, sem recorte de depósito).
 */
function saldoFisico(db, produtoId) {
  return db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
                             WHEN tipo='saida' THEN -quantidade
                             ELSE quantidade END),0) AS s
    FROM movimentacoes_estoque WHERE produtoId = ?
  `).get(produtoId).s || 0;
}

/**
 * Quantidade já comprada e ainda não recebida (pedidos de compra em aberto).
 * É o que impede recomprar o que está a caminho.
 */
function emTransitoCompra(db, produtoId) {
  try {
    return db.prepare(`
      SELECT COALESCE(SUM(pci.quantidade - pci.quantidadeRecebida), 0) AS q
      FROM pedido_compra_itens pci
      JOIN pedidos_compra pc ON pc.id = pci.pedidoCompraId
      WHERE pci.produtoId = ?
        AND pc.status IN ('enviado', 'enviado_parcial', 'recebido_parcial')
        AND pci.quantidade > pci.quantidadeRecebida
    `).get(produtoId).q || 0;
  } catch {
    // pedidos_compra ainda não migrado neste tenant — nada a caminho.
    return 0;
  }
}

/**
 * O que falta para ESTE pedido, item a item (kit explodido).
 *
 * A conta exclui as reservas do próprio pedido do total reservado, então vale
 * igual em rascunho (sem reserva) e em confirmado (com reserva): o número
 * responde "quanto deste item eu não tenho lastro para entregar".
 *
 * NÃO confundir com a necessidade consolidada da tela de compras: somar estas
 * faltas entre pedidos conta o mesmo saldo duas vezes. Ver
 * necessidades-compra-routes.js.
 *
 * Retorna [] para pedido cujo tipo de operação não movimenta estoque.
 */
function calcularFaltaPedido(db, pedidoId) {
  if (!pedidoMovimentaEstoque(db, pedidoId)) return [];

  // Kit explodido gera N linhas do mesmo produto quando dois itens compartilham
  // componente; agregamos por produto para não pedir compra fatiada.
  const porProduto = new Map();
  for (const it of explodirItensPedido(db, pedidoId)) {
    if (!it.produtoId) continue;
    const qtd = Number(it.quantidade);
    if (!(qtd > 0)) continue;
    const atual = porProduto.get(it.produtoId);
    if (atual) { atual.quantidade += qtd; continue; }
    porProduto.set(it.produtoId, { produtoId: it.produtoId, quantidade: qtd, pedidoItemId: it.id });
  }

  const linhas = [];
  for (const linha of porProduto.values()) {
    const produto = db.prepare(`
      SELECT p.id, p.sku, p.descricao, p.unidade, p.precoCusto, p.fornecedorId,
             f.razaoSocial AS fornecedorNome
      FROM produtos p LEFT JOIN pessoas f ON f.id = p.fornecedorId
      WHERE p.id = ?`).get(linha.produtoId);
    if (!produto) continue;

    const saldo = saldoFisico(db, linha.produtoId);
    const reservadoOutros = saldoReservado(db, linha.produtoId, null, pedidoId);
    const disponivel = saldo - reservadoOutros;
    const faltando = Math.max(0, linha.quantidade - disponivel);
    const custoMedio = db.prepare(`
      SELECT custoMedioPosterior FROM movimentacoes_estoque
      WHERE produtoId = ? AND custoMedioPosterior IS NOT NULL
      ORDER BY data DESC, id DESC LIMIT 1`).get(linha.produtoId);

    linhas.push({
      produtoId: produto.id,
      pedidoItemId: linha.pedidoItemId,
      sku: produto.sku,
      descricao: produto.descricao,
      unidade: produto.unidade,
      quantidade: linha.quantidade,
      saldo,
      reservadoOutros,
      disponivel,
      faltando,
      emTransito: faltando > 0 ? emTransitoCompra(db, linha.produtoId) : 0,
      fornecedorId: produto.fornecedorId || null,
      fornecedorNome: produto.fornecedorNome || null,
      custoUnitario: (custoMedio && custoMedio.custoMedioPosterior) || produto.precoCusto || 0,
    });
  }
  return linhas;
}

/**
 * Cria as reservas que faltaram — chamado quando entra mercadoria de um pedido
 * de compra vinculado a este pedido de venda.
 *
 * Só tem efeito em produto com rastreiaLote: sem lote, criarReservasPedido já
 * reservou a quantidade cheia mesmo sem saldo (a insuficiência ali é aviso, não
 * ausência de reserva), então a chegada só torna o saldo positivo.
 *
 * Retorna { reservasCriadas: [], produtos: [] }.
 */
function completarReservasPedido(db, pedidoId) {
  const vazio = { reservasCriadas: [], produtos: [] };
  const ped = db.prepare('SELECT id, status, depositoId FROM pedidos WHERE id = ?').get(pedidoId);
  if (!ped) return vazio;
  if (!['confirmado', 'em_separacao'].includes(ped.status)) return vazio;
  if (!pedidoMovimentaEstoque(db, pedidoId)) return vazio;

  const depositoDoc = resolverDeposito(db, { depositoId: ped.depositoId });
  const reservasCriadas = [];
  const produtos = [];

  for (const it of explodirItensPedido(db, pedidoId)) {
    if (!it.produtoId) continue;
    const produto = db.prepare('SELECT id, sku, rastreiaLote FROM produtos WHERE id = ?').get(it.produtoId);
    if (!produto || !produto.rastreiaLote) continue;

    const qtd = Number(it.quantidade);
    const jaReservado = db.prepare(`
      SELECT COALESCE(SUM(quantidade),0) AS q FROM reservas_estoque
      WHERE pedidoId = ? AND pedidoItemId = ? AND produtoId = ? AND status = 'ativa'
    `).get(pedidoId, it.id, it.produtoId).q || 0;
    const pendente = qtd - jaReservado;
    if (!(pendente > 0.0001)) continue;

    let criouAlgo = false;
    for (const a of alocarLotesFIFO(db, it.produtoId, pendente)) {
      if (a.insuficiente) continue;
      const r = db.prepare(`
        INSERT INTO reservas_estoque (produtoId, loteId, quantidade, pedidoId, pedidoItemId, status, depositoId)
        VALUES (?, ?, ?, ?, ?, 'ativa', ?)
      `).run(it.produtoId, a.loteId, a.quantidade, pedidoId, it.id, depositoDoc);
      reservasCriadas.push(r.lastInsertRowid);
      criouAlgo = true;
    }
    if (criouAlgo) produtos.push(produto.sku);
  }
  return { reservasCriadas, produtos };
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
  const { calcularContextoMovimento, resolverDeposito } = require('./estoque-routes');
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
         loteId, custoMedioAnterior, custoMedioPosterior, saldoPosterior, depositoId)
      VALUES (?, 'saida', ?, 'pedido', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.produtoId, r.quantidade, pedidoId,
      `Saída pelo pedido ${r.pedidoNumero} (reserva #${r.id})`,
      dataConsumo, r.loteId,
      ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior,
      // A reserva é quem sabe de qual depósito a mercadoria foi separada.
      resolverDeposito(db, { depositoId: r.depositoId, pedidoId, produtoId: r.produtoId })
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
  // Depósito de onde a peça sai — a reserva carrega isso até o consumo.
  const depositoDoc = resolverDeposito(db, {
    depositoId: (db.prepare('SELECT depositoId FROM os_ordens WHERE id = ?').get(osId) || {}).depositoId,
  });
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
          INSERT INTO reservas_estoque (produtoId, loteId, quantidade, osId, osItemPecaId, status, depositoId)
          VALUES (?, ?, ?, ?, ?, 'ativa', ?)
        `).run(it.produtoId, a.loteId, a.quantidade, osId, it.id, depositoDoc);
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
        INSERT INTO reservas_estoque (produtoId, loteId, quantidade, osId, osItemPecaId, status, depositoId)
        VALUES (?, NULL, ?, ?, ?, 'ativa', ?)
      `).run(it.produtoId, qtd, osId, it.id, depositoDoc);
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
  const { calcularContextoMovimento, resolverDeposito } = require('./estoque-routes');
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
         loteId, custoMedioAnterior, custoMedioPosterior, saldoPosterior, depositoId)
      VALUES (?, 'saida', ?, 'os', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.produtoId, r.quantidade, osId,
      `Saída pela OS ${r.osNumero} (reserva #${r.id})`,
      dataConsumo, r.loteId,
      ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior,
      resolverDeposito(db, { depositoId: r.depositoId, osId, produtoId: r.produtoId })
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
      const { status, produtoId, pedidoId, limit, q } = req.query;
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
      // Busca por SKU, produto, número do pedido ou cliente — antes só
      // aceitava os ids internos.
      if (q) {
        sql += ` AND (p.sku LIKE ? OR p.descricao LIKE ? OR ped.numero LIKE ? OR cli.razaoSocial LIKE ?)`;
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }

      // Totais sobre o filtro inteiro: os KPIs da tela eram calculados
      // sobre a página, então erravam a partir do limite.
      const where = sql.slice(sql.indexOf('WHERE 1=1'));
      const totais = db.prepare(`SELECT COUNT(*) registros,
          COALESCE(SUM(r.quantidade),0) quantidade,
          COUNT(DISTINCT r.pedidoId) pedidos,
          COUNT(DISTINCT r.produtoId) produtos
        FROM reservas_estoque r
        JOIN produtos p ON p.id = r.produtoId
        LEFT JOIN lotes l ON l.id = r.loteId
        LEFT JOIN pedidos ped ON ped.id = r.pedidoId
        LEFT JOIN pessoas cli ON cli.id = ped.clienteId ${where}`).get(...params);

      const max = Math.min(Number(limit) || 200, 2000);
      sql += ' ORDER BY r.dataCriacao DESC LIMIT ?';
      params.push(max);
      const reservas = db.prepare(sql).all(...params);
      res.json({ success: true, reservas, totais, truncado: totais.registros > reservas.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Pedidos confirmados/em separação SEM reserva ativa.
   *
   * É o buraco que a tela não mostrava: um pedido nessa situação
   * simplesmente não aparecia na lista de reservas, então dava para ter
   * venda confirmada sem estoque comprometido e ninguém notar.
   */
  app.get('/api/reservas/pedidos-sem-reserva', (req, res) => {
    try {
      const linhas = db.prepare(`
        SELECT p.id, p.numero, p.status, p.tipo, p.dataPedido, p.valorTotal,
               cli.razaoSocial AS clienteNome,
               (SELECT COUNT(*) FROM pedido_itens i WHERE i.pedidoId = p.id) AS itens,
               (SELECT COUNT(*) FROM pedido_itens i WHERE i.pedidoId = p.id AND i.produtoId IS NULL) AS itensSemProduto,
               (SELECT COUNT(*) FROM reservas_estoque r WHERE r.pedidoId = p.id AND r.status = 'ativa') AS reservasAtivas
        FROM pedidos p
        LEFT JOIN pessoas cli ON cli.id = p.clienteId
        WHERE p.modoDocumento = 'pedido'
          AND p.status IN ('confirmado','em_separacao')
        ORDER BY p.dataPedido DESC, p.id DESC`).all()
        .filter(l => l.reservasAtivas === 0)
        .map(l => ({
          ...l,
          // Item sem produto vinculado não tem o que reservar — é o caso
          // clássico de pedido de marketplace com SKU que não casou.
          motivo: l.itensSemProduto === l.itens ? 'itens sem produto vinculado'
                : l.itensSemProduto > 0 ? 'parte dos itens sem produto vinculado'
                : 'confirmado sem reserva (pedido anterior ao recurso ou criado fora do fluxo)',
        }));
      res.json({ success: true, pedidos: linhas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /** Recria as reservas de um pedido que ficou sem. */
  app.post('/api/reservas/pedidos/:pedidoId/reservar', (req, res) => {
    try {
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.pedidoId);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido não encontrado' });
      if (!['confirmado', 'em_separacao'].includes(ped.status)) {
        return res.status(400).json({ success: false, error: `Pedido ${ped.status} não comporta reserva` });
      }
      const ativas = db.prepare(
        `SELECT COUNT(*) n FROM reservas_estoque WHERE pedidoId = ? AND status = 'ativa'`).get(ped.id).n;
      if (ativas) return res.status(400).json({ success: false, error: 'Pedido já tem reserva ativa' });

      const r = criarReservasPedido(db, ped.id);
      if (!r.reservasCriadas.length) {
        return res.status(400).json({ success: false,
          error: 'Nenhum item com produto vinculado — vincule o produto nos itens antes de reservar' });
      }
      res.json({ success: true, reservasCriadas: r.reservasCriadas.length, insuficiencias: r.insuficiencias });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
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
  calcularFaltaPedido,
  completarReservasPedido,
  emTransitoCompra,
  explodirItensPedido,
  pedidoMovimentaEstoque,
  saldoFisico,
  criarReservasOS,
  cancelarReservasOS,
  consumirReservasOS,
};
