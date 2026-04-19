/**
 * comissoes-routes.js — Comissões de vendedores.
 *
 * Modelo:
 *   pedidos.vendedorId (FK users) — quem vendeu
 *   comissoes_regras   — regras: vendedor + escopo (produto/categoria/cliente) + tipo + valor
 *   comissoes_apuracao — linhas geradas ao apurar um período (1 linha por item de pedido)
 *
 * Tipos de regra:
 *   percentual_venda  — valor% × item.valorTotal
 *   percentual_lucro  — valor% × (item.valorTotal − item.custo)
 *   fixo_por_unidade  — valor × item.quantidade
 *
 * Critério de elegibilidade do pedido: status = 'confirmado' ou statusPagamento = 'pago'.
 *
 * Match de regra (mais específica vence):
 *   1. vendedor+produto      (specificity 4)
 *   2. vendedor+categoria    (3)
 *   3. vendedor+cliente      (3)
 *   4. vendedor (qualquer)   (2)
 *   5. produto/categoria/cliente sem vendedor (1)
 *   6. regra geral (todos null) (0)
 */

const { logAction } = require('./audit-log');
const { lancarMovimentacao } = require('./contas-financeiras-routes');

const TIPOS_REGRA = ['percentual_venda', 'percentual_lucro', 'fixo_por_unidade'];

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* idempotente */ } }

function migrarDB(db) {
  alterSafe(db, 'ALTER TABLE pedidos ADD COLUMN vendedorId INTEGER');

  db.exec(`
    CREATE TABLE IF NOT EXISTS comissoes_regras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      vendedorId INTEGER,
      produtoId INTEGER,
      categoriaProduto TEXT,
      clienteId INTEGER,
      tipo TEXT NOT NULL,
      valor REAL NOT NULL,
      dataInicio TEXT,
      dataFim TEXT,
      ativo INTEGER DEFAULT 1,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendedorId) REFERENCES users(id),
      FOREIGN KEY (produtoId) REFERENCES produtos(id),
      FOREIGN KEY (clienteId) REFERENCES pessoas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_regras_ativo ON comissoes_regras(ativo, vendedorId);

    CREATE TABLE IF NOT EXISTS comissoes_apuracao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      periodo TEXT NOT NULL,
      vendedorId INTEGER NOT NULL,
      pedidoId INTEGER NOT NULL,
      pedidoItemId INTEGER NOT NULL,
      regraId INTEGER,
      tipo TEXT,
      baseCalculo REAL NOT NULL,
      percentual REAL,
      valorComissao REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      dataPagamento TEXT,
      observacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendedorId) REFERENCES users(id),
      FOREIGN KEY (pedidoId) REFERENCES pedidos(id),
      FOREIGN KEY (pedidoItemId) REFERENCES pedido_itens(id),
      FOREIGN KEY (regraId) REFERENCES comissoes_regras(id)
    );
    CREATE INDEX IF NOT EXISTS idx_apur_periodo_vendedor ON comissoes_apuracao(periodo, vendedorId);
    CREATE INDEX IF NOT EXISTS idx_apur_status ON comissoes_apuracao(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_apur_pedido_item ON comissoes_apuracao(periodo, pedidoItemId);
  `);
}

function escolheRegra(regras, item, pedido, produto) {
  // Filtra por validade temporal e escopo aplicável
  const dataPedido = (pedido.dataPedido || '').slice(0, 10);
  const aplicaveis = regras.filter(r => {
    if (!r.ativo) return false;
    if (r.dataInicio && dataPedido && dataPedido < r.dataInicio) return false;
    if (r.dataFim    && dataPedido && dataPedido > r.dataFim)    return false;
    if (r.vendedorId && r.vendedorId !== pedido.vendedorId) return false;
    if (r.produtoId  && r.produtoId !== item.produtoId)     return false;
    if (r.clienteId  && r.clienteId !== pedido.clienteId)   return false;
    if (r.categoriaProduto && r.categoriaProduto !== (produto?.categoria || null)) return false;
    return true;
  });
  if (!aplicaveis.length) return null;
  // Ordena por especificidade (mais específica primeiro)
  function score(r) {
    let s = 0;
    if (r.vendedorId) s += 2;
    if (r.produtoId)  s += 2;
    if (r.categoriaProduto) s += 1;
    if (r.clienteId)  s += 1;
    return s;
  }
  aplicaveis.sort((a, b) => score(b) - score(a));
  return aplicaveis[0];
}

function calcularComissao(regra, item, custoMedio) {
  const qtd  = Number(item.quantidade);
  const total = Number(item.valorTotal);
  if (regra.tipo === 'percentual_venda') {
    return { base: total, percentual: regra.valor, valor: total * regra.valor / 100 };
  }
  if (regra.tipo === 'percentual_lucro') {
    const custo = Number(custoMedio || 0) * qtd;
    const lucro = total - custo;
    return { base: lucro, percentual: regra.valor, valor: lucro > 0 ? lucro * regra.valor / 100 : 0 };
  }
  if (regra.tipo === 'fixo_por_unidade') {
    return { base: qtd, percentual: null, valor: qtd * regra.valor };
  }
  return { base: 0, percentual: null, valor: 0 };
}

function registrarRotasComissoes(app, db) {
  migrarDB(db);

  // ==================== REGRAS CRUD ====================

  app.get('/api/comissoes/regras', (req, res) => {
    try {
      const regras = db.prepare(`
        SELECT r.*, u.username AS vendedorNome, p.sku AS produtoSku, p.descricao AS produtoDescricao,
               cli.razaoSocial AS clienteNome
        FROM comissoes_regras r
        LEFT JOIN users u ON u.id = r.vendedorId
        LEFT JOIN produtos p ON p.id = r.produtoId
        LEFT JOIN pessoas cli ON cli.id = r.clienteId
        ORDER BY r.ativo DESC, r.id DESC
      `).all();
      res.json({ success: true, regras, tipos: TIPOS_REGRA });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/comissoes/regras', (req, res) => {
    try {
      const { nome, vendedorId, produtoId, categoriaProduto, clienteId, tipo, valor, dataInicio, dataFim, observacoes } = req.body;
      if (!nome || !tipo || valor == null) return res.status(400).json({ success: false, error: 'nome, tipo e valor obrigatórios' });
      if (!TIPOS_REGRA.includes(tipo)) return res.status(400).json({ success: false, error: `tipo inválido. Use: ${TIPOS_REGRA.join(', ')}` });
      const r = db.prepare(`
        INSERT INTO comissoes_regras (nome, vendedorId, produtoId, categoriaProduto, clienteId, tipo, valor, dataInicio, dataFim, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nome, vendedorId || null, produtoId || null, categoriaProduto || null, clienteId || null,
              tipo, Number(valor), dataInicio || null, dataFim || null, observacoes || null);
      logAction(db, req, 'criar', 'comissao-regra', r.lastInsertRowid, { nome, tipo, valor });
      res.json({ success: true, regra: db.prepare('SELECT * FROM comissoes_regras WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/comissoes/regras/:id', (req, res) => {
    try {
      const camposValidos = ['nome','vendedorId','produtoId','categoriaProduto','clienteId','tipo','valor','dataInicio','dataFim','ativo','observacoes'];
      const sets = [], vals = [];
      for (const c of camposValidos) {
        if (req.body[c] !== undefined) {
          sets.push(`${c} = ?`);
          vals.push(c === 'ativo' ? (req.body[c] ? 1 : 0) : (req.body[c] === '' ? null : req.body[c]));
        }
      }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.id);
      db.prepare(`UPDATE comissoes_regras SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      logAction(db, req, 'editar', 'comissao-regra', req.params.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/comissoes/regras/:id', (req, res) => {
    try {
      db.prepare('UPDATE comissoes_regras SET ativo = 0 WHERE id = ?').run(req.params.id);
      logAction(db, req, 'desativar', 'comissao-regra', req.params.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== APURAÇÃO ====================
  // POST /api/comissoes/apurar?periodo=YYYY-MM[&vendedorId=]
  // Reapura: apaga linhas pendentes do período e regenera (linhas pagas são preservadas)

  app.post('/api/comissoes/apurar', (req, res) => {
    try {
      const periodo = req.query.periodo || req.body?.periodo;
      const vendedorFiltro = req.query.vendedorId || req.body?.vendedorId;
      if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
        return res.status(400).json({ success: false, error: 'periodo no formato YYYY-MM obrigatório' });
      }
      const ini = `${periodo}-01`;
      // último dia do mês
      const [y, m] = periodo.split('-').map(Number);
      const fim = new Date(y, m, 0).toISOString().slice(0, 10);

      // Pega todas as regras ativas (filtragem em memória)
      const regras = db.prepare('SELECT * FROM comissoes_regras WHERE ativo = 1').all();

      // Pedidos elegíveis: confirmados ou pagos no período (por dataPedido) com vendedor
      let pedidosSql = `
        SELECT p.*, c.razaoSocial AS clienteNome
        FROM pedidos p
        LEFT JOIN pessoas c ON c.id = p.clienteId
        WHERE p.dataPedido >= ? AND p.dataPedido <= ?
          AND p.vendedorId IS NOT NULL
          AND (p.status = 'confirmado' OR p.statusPagamento = 'pago')
      `;
      const params = [ini, fim];
      if (vendedorFiltro) { pedidosSql += ' AND p.vendedorId = ?'; params.push(Number(vendedorFiltro)); }
      const pedidos = db.prepare(pedidosSql).all(...params);

      // Apaga apurações pendentes do período (não toca em pagas)
      const delSql = `DELETE FROM comissoes_apuracao WHERE periodo = ? AND status = 'pendente'${vendedorFiltro?' AND vendedorId = ?':''}`;
      const delParams = vendedorFiltro ? [periodo, Number(vendedorFiltro)] : [periodo];
      db.prepare(delSql).run(...delParams);

      const stmtItens = db.prepare(`
        SELECT pi.*, pr.categoria, pr.descricao AS produtoDescricao
        FROM pedido_itens pi
        LEFT JOIN produtos pr ON pr.id = pi.produtoId
        WHERE pi.pedidoId = ?
      `);

      // Custo médio: tenta da última movimentação posterior, fallback simples
      const stmtCusto = db.prepare(`
        SELECT custoMedioPosterior FROM movimentacoes_estoque
        WHERE produtoId = ? AND custoMedioPosterior IS NOT NULL
        ORDER BY data DESC, id DESC LIMIT 1
      `);

      const stmtJaPago = db.prepare(`SELECT id FROM comissoes_apuracao WHERE periodo = ? AND pedidoItemId = ? AND status = 'paga'`);
      const stmtInsert = db.prepare(`
        INSERT INTO comissoes_apuracao (periodo, vendedorId, pedidoId, pedidoItemId, regraId, tipo, baseCalculo, percentual, valorComissao, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente')
      `);

      let geradas = 0, ignoradasSemRegra = 0;
      const trx = db.transaction(() => {
        for (const ped of pedidos) {
          const itens = stmtItens.all(ped.id);
          for (const it of itens) {
            // Pula se já foi pago (preserva)
            if (stmtJaPago.get(periodo, it.id)) continue;
            const produto = it.produtoId ? { categoria: it.categoria } : null;
            const regra = escolheRegra(regras, it, ped, produto);
            if (!regra) { ignoradasSemRegra++; continue; }
            const custoMedio = it.produtoId ? (stmtCusto.get(it.produtoId)?.custoMedioPosterior || 0) : 0;
            const calc = calcularComissao(regra, it, custoMedio);
            if (calc.valor <= 0) continue;
            stmtInsert.run(periodo, ped.vendedorId, ped.id, it.id, regra.id, regra.tipo, calc.base, calc.percentual, calc.valor);
            geradas++;
          }
        }
      });
      trx();
      logAction(db, req, 'apurar', 'comissao', null, { periodo, geradas, ignoradasSemRegra, pedidos: pedidos.length });
      res.json({ success: true, periodo, pedidos: pedidos.length, geradas, ignoradasSemRegra });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Lista apurações (filtros)
  app.get('/api/comissoes/apuracao', (req, res) => {
    try {
      const { periodo, vendedorId, status } = req.query;
      let sql = `
        SELECT a.*, u.username AS vendedorNome, u.nome AS vendedorNomeExibicao,
               p.numero AS pedidoNumero, p.dataPedido,
               cli.razaoSocial AS clienteNome,
               pi.descricao AS itemDescricao, pi.quantidade AS itemQuantidade
        FROM comissoes_apuracao a
        JOIN users u ON u.id = a.vendedorId
        JOIN pedidos p ON p.id = a.pedidoId
        LEFT JOIN pessoas cli ON cli.id = p.clienteId
        JOIN pedido_itens pi ON pi.id = a.pedidoItemId
        WHERE 1=1
      `;
      const params = [];
      if (periodo)    { sql += ' AND a.periodo = ?';    params.push(periodo); }
      if (vendedorId) { sql += ' AND a.vendedorId = ?'; params.push(Number(vendedorId)); }
      if (status)     { sql += ' AND a.status = ?';     params.push(status); }
      sql += ' ORDER BY a.vendedorId, a.id DESC LIMIT 2000';
      const apuracoes = db.prepare(sql).all(...params);

      // Agrega totais por vendedor
      const totaisMap = new Map();
      for (const a of apuracoes) {
        const cur = totaisMap.get(a.vendedorId) || { vendedorId: a.vendedorId, vendedorNome: a.vendedorNomeExibicao || a.vendedorNome, pendente: 0, paga: 0, qtdLinhas: 0 };
        if (a.status === 'pendente') cur.pendente += a.valorComissao;
        if (a.status === 'paga')     cur.paga     += a.valorComissao;
        cur.qtdLinhas++;
        totaisMap.set(a.vendedorId, cur);
      }
      res.json({ success: true, apuracoes, totais: Array.from(totaisMap.values()) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Marcar como paga (lote ou individual) — COM-01 (2026-04-18): além de mudar
  // status, agora gera uma conta_a_pagar + baixa + movimentação financeira para
  // que o pagamento efetivamente reflita no caixa/banco. Antes era puro update
  // de status e vendedor recebia comissão "fora do sistema" sem rastreio.
  app.post('/api/comissoes/apuracao/pagar', (req, res) => {
    try {
      const { ids, dataPagamento, observacao, contaFinanceiraId, fornecedorId } = req.body;
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'ids obrigatórios' });
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório — qual conta paga a comissão?' });
      const data = dataPagamento || new Date().toISOString().slice(0, 10);

      const contaFin = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(contaFinanceiraId);
      if (!contaFin) return res.status(404).json({ success: false, error: 'Conta financeira não encontrada ou inativa' });

      // Agrega por vendedor e valida cada apuração
      const placeholders = ids.map(() => '?').join(',');
      const apuracoes = db.prepare(`SELECT a.*, u.nome as vendedorNome
        FROM comissoes_apuracao a
        LEFT JOIN users u ON u.id = a.vendedorId
        WHERE a.id IN (${placeholders}) AND a.status = 'pendente'`).all(...ids);
      if (!apuracoes.length) return res.status(400).json({ success: false, error: 'Nenhuma apuração pendente encontrada para os ids' });

      const porVendedor = new Map();
      for (const a of apuracoes) {
        const key = a.vendedorId || 0;
        if (!porVendedor.has(key)) porVendedor.set(key, { vendedorId: a.vendedorId, vendedorNome: a.vendedorNome, ids: [], total: 0, periodo: a.periodo });
        const agg = porVendedor.get(key);
        agg.ids.push(a.id);
        agg.total += Number(a.valor) || 0;
      }

      const resultados = [];
      const tx = db.transaction(() => {
        for (const agg of porVendedor.values()) {
          const vPago = Number(agg.total.toFixed(2));
          if (vPago <= 0) continue;
          // 1) cria conta_a_pagar (documento do passivo)
          const cp = db.prepare(`INSERT INTO contas_a_pagar
            (fornecedorId, descricao, valor, dataEmissao, dataVencimento, dataPagamento,
             status, valorPago, contaFinanceiraId, formaPagamento, observacoes)
            VALUES (?, ?, ?, ?, ?, ?, 'paga', ?, ?, 'comissao', ?)`).run(
            fornecedorId || null,
            `Comissão ${agg.periodo || ''} — ${agg.vendedorNome || 'vendedor id ' + agg.vendedorId}`,
            vPago, data, data, data, vPago, contaFinanceiraId,
            observacao || `apuracoes: ${agg.ids.join(',')}`
          );
          // 2) lança saída na conta financeira
          const movId = lancarMovimentacao(db, {
            contaId: contaFinanceiraId,
            tipo: 'saida', valor: vPago, data,
            descricao: `Comissão vendedor #${agg.vendedorId || '?'} (apuracoes ${agg.ids.join(',')})`,
            origem: 'comissao_pagamento', origemId: cp.lastInsertRowid,
            categoria: 'comissoes',
            usuario: req.user?.username || null
          });
          // 3) marca apurações como pagas (status + link)
          const ph = agg.ids.map(() => '?').join(',');
          db.prepare(`UPDATE comissoes_apuracao
             SET status = 'paga', dataPagamento = ?, observacao = COALESCE(?, observacao)
             WHERE id IN (${ph})`)
            .run(data, observacao || `cp_id=${cp.lastInsertRowid} mov_id=${movId}`, ...agg.ids);
          resultados.push({ vendedorId: agg.vendedorId, apuracoes: agg.ids, contaPagarId: cp.lastInsertRowid, movimentacaoId: movId, valor: vPago });
        }
      });
      tx();

      logAction(db, req, 'pagar', 'comissao', null, { ids, dataPagamento: data, resultados });
      res.json({ success: true, marcadas: apuracoes.length, pagamentos: resultados });
    } catch (err) {
      console.error('[pagar comissao]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/comissoes/apuracao/:id/estornar', (req, res) => {
    try {
      const r = db.prepare(`UPDATE comissoes_apuracao SET status='pendente', dataPagamento=NULL WHERE id = ? AND status='paga'`).run(req.params.id);
      if (!r.changes) return res.status(400).json({ success: false, error: 'Apuração não está paga' });
      logAction(db, req, 'estornar-pagamento', 'comissao', req.params.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasComissoes };
