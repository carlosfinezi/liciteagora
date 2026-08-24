/**
 * precos-routes.js — Tabelas de preço (V1) e vendas perdidas (V2/V3).
 *
 * Resolução de preço (resolverPreco): tabela do cliente (vigente) →
 * tabelas vigentes por prioridade → produtos.precoVenda. Linhas com
 * qtdMinima selecionam a de maior qtdMinima <= quantidade pedida.
 * Endpoint GET /api/precos/resolver serve pedidos/PDV/propostas.
 *
 * V3 (vínculo com pedido de venda): a perda passa a poder apontar para
 * o item de um pedido/orçamento (pedidoId + pedidoItemId). O registro
 * continua autossuficiente — produto, qtd e preço são copiados na
 * gravação — e pedidoNumero guarda o rastro caso o pedido seja excluído
 * (as FKs são ON DELETE SET NULL). Índice único parcial em pedidoItemId
 * impede que cancelar→reabrir→cancelar duplique a mesma perda.
 */

const { logAction } = require('./audit-log');

function dataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna ja existe */ } }

// Motivos de perda — fonte única (backend valida, front monta os selects
// a partir de GET /api/vendas-perdidas/motivos).
const MOTIVOS_PERDA = [
  { valor: 'sem_estoque',  texto: 'Sem estoque',            icone: '📦' },
  { valor: 'preco',        texto: 'Preço',                  icone: '💰' },
  { valor: 'prazo',        texto: 'Prazo',                  icone: '⏱️' },
  { valor: 'concorrente',  texto: 'Perdido p/ concorrente', icone: '🏳️' },
  { valor: 'condicoes',    texto: 'Condições comerciais',   icone: '📋' },
  { valor: 'desistencia',  texto: 'Desistência do cliente', icone: '🚪' },
  { valor: 'outro',        texto: 'Outro',                  icone: '❓' },
];
const MOTIVOS_VALIDOS = MOTIVOS_PERDA.map(m => m.valor);

// Origens automáticas — só estas são estornadas ao reabrir um pedido.
const ORIGENS_AUTO = ['pedido_cancelado', 'orcamento_perdido'];

// Status em que o pedido já virou receita: vincular perda seria contar
// duas vezes o mesmo item.
const STATUS_BLOQUEIA_PERDA = ['entregue', 'faturado'];

function migrarPrecosDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tabelas_preco (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      prioridade INTEGER DEFAULT 0,
      vigenciaInicio TEXT,
      vigenciaFim TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS tabela_preco_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tabelaId INTEGER NOT NULL,
      produtoId INTEGER NOT NULL,
      preco REAL NOT NULL,
      qtdMinima REAL DEFAULT 0,
      FOREIGN KEY (tabelaId) REFERENCES tabelas_preco(id),
      FOREIGN KEY (produtoId) REFERENCES produtos(id),
      UNIQUE (tabelaId, produtoId, qtdMinima)
    );
    CREATE INDEX IF NOT EXISTS idx_tpi_produto ON tabela_preco_itens(produtoId);

    CREATE TABLE IF NOT EXISTS vendas_perdidas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      produtoId INTEGER,
      descricaoLivre TEXT,
      quantidade REAL NOT NULL,
      precoAlvo REAL,
      motivo TEXT NOT NULL DEFAULT 'outro',
      clienteId INTEGER,
      origem TEXT DEFAULT 'manual',
      observacao TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vp_produto ON vendas_perdidas(produtoId, data);
  `);
  alterSafe(db, 'ALTER TABLE pessoas ADD COLUMN tabelaPrecoId INTEGER');

  // V3 — vínculo com pedido de venda. ADD COLUMN com REFERENCES só é
  // aceito pelo SQLite com default NULL, que é o caso.
  alterSafe(db, 'ALTER TABLE vendas_perdidas ADD COLUMN pedidoId INTEGER REFERENCES pedidos(id) ON DELETE SET NULL');
  alterSafe(db, 'ALTER TABLE vendas_perdidas ADD COLUMN pedidoItemId INTEGER REFERENCES pedido_itens(id) ON DELETE SET NULL');
  alterSafe(db, 'ALTER TABLE vendas_perdidas ADD COLUMN pedidoNumero TEXT');
  alterSafe(db, 'ALTER TABLE vendas_perdidas ADD COLUMN concorrente TEXT');
  // Perda avulsa não tem pedido, logo não tinha a quem atribuir: ficava
  // fora da conversão por vendedor. Agora dá para informar direto.
  alterSafe(db, 'ALTER TABLE vendas_perdidas ADD COLUMN vendedorUserId INTEGER');
  alterSafe(db, 'CREATE INDEX IF NOT EXISTS idx_vp_vendedor ON vendas_perdidas(vendedorUserId, data)');
  alterSafe(db, 'CREATE INDEX IF NOT EXISTS idx_vp_pedido ON vendas_perdidas(pedidoId)');
  alterSafe(db, 'CREATE INDEX IF NOT EXISTS idx_vp_cliente ON vendas_perdidas(clienteId, data)');
  alterSafe(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_vp_item_unico
                 ON vendas_perdidas(pedidoItemId) WHERE pedidoItemId IS NOT NULL`);

  // alterSafe engole erro por design (idempotência). Aqui um ALTER que
  // falhou de verdade derruba todo o vínculo em silêncio — então confere.
  // cols vazio = proxy no-op do boot multi-tenant (server.js:85), onde as
  // migrações não rodam mesmo; quem migra o tenant é applyRouteMigrations.
  try {
    const cols = db.prepare('PRAGMA table_info(vendas_perdidas)').all().map(c => c.name);
    const faltando = cols.length
      ? ['pedidoId', 'pedidoItemId', 'pedidoNumero', 'concorrente'].filter(c => !cols.includes(c))
      : [];
    if (faltando.length) {
      console.error('[precos-routes] vendas_perdidas sem as colunas de vínculo:', faltando.join(', '));
    }
  } catch { /* tabela indisponivel */ }
}

function tabelaVigente(t, hoje) {
  if (!t.ativo) return false;
  if (t.vigenciaInicio && t.vigenciaInicio > hoje) return false;
  if (t.vigenciaFim && t.vigenciaFim < hoje) return false;
  return true;
}

/**
 * Resolve o preço de venda de um produto.
 * Retorna { preco, fonte: 'tabela_cliente'|'tabela'|'produto', tabelaId?, tabelaNome? }.
 */
function resolverPreco(db, produtoId, { pessoaId = null, quantidade = 1, tabelaId = null } = {}) {
  const hoje = dataBrasilia();
  const qtd = Number(quantidade) || 1;

  const buscarNaTabela = (tid) => db.prepare(`
    SELECT preco, qtdMinima FROM tabela_preco_itens
    WHERE tabelaId = ? AND produtoId = ? AND qtdMinima <= ?
    ORDER BY qtdMinima DESC LIMIT 1`).get(tid, produtoId, qtd);

  // 0) tabela forçada no pedido (override) — vence a do cliente e as gerais
  if (tabelaId) {
    const t = db.prepare('SELECT * FROM tabelas_preco WHERE id = ?').get(tabelaId);
    if (t && tabelaVigente(t, hoje)) {
      const item = buscarNaTabela(t.id);
      if (item) return { preco: item.preco, fonte: 'tabela_forcada', tabelaId: t.id, tabelaNome: t.nome };
    }
  }
  // 1) tabela vinculada ao cliente
  if (pessoaId) {
    const pessoa = db.prepare('SELECT tabelaPrecoId FROM pessoas WHERE id = ?').get(pessoaId);
    if (pessoa?.tabelaPrecoId) {
      const t = db.prepare('SELECT * FROM tabelas_preco WHERE id = ?').get(pessoa.tabelaPrecoId);
      if (t && tabelaVigente(t, hoje)) {
        const item = buscarNaTabela(t.id);
        if (item) return { preco: item.preco, fonte: 'tabela_cliente', tabelaId: t.id, tabelaNome: t.nome };
      }
    }
  }
  // 2) tabelas gerais vigentes por prioridade
  const tabelas = db.prepare('SELECT * FROM tabelas_preco WHERE ativo = 1 ORDER BY prioridade DESC, id').all()
    .filter(t => tabelaVigente(t, hoje));
  for (const t of tabelas) {
    const item = buscarNaTabela(t.id);
    if (item) return { preco: item.preco, fonte: 'tabela', tabelaId: t.id, tabelaNome: t.nome };
  }
  // 3) preço do cadastro
  const p = db.prepare('SELECT precoVenda FROM produtos WHERE id = ?').get(produtoId);
  return { preco: p ? (p.precoVenda || 0) : 0, fonte: 'produto' };
}

// ==================== VENDAS PERDIDAS × PEDIDO ====================

/**
 * Itens de um pedido/orçamento com a marcação de quais já viraram perda.
 * Serve tanto o modal do pedido quanto o de vendas perdidas.
 */
function itensElegiveisPerda(db, pedidoId) {
  const pedido = db.prepare(`SELECT p.*, pe.razaoSocial AS clienteNome
    FROM pedidos p LEFT JOIN pessoas pe ON pe.id = p.clienteId
    WHERE p.id = ?`).get(pedidoId);
  if (!pedido) return null;
  const itens = db.prepare(`
    SELECT i.id AS pedidoItemId, i.produtoId, i.descricao, i.quantidade, i.precoUnitario,
           pr.sku,
           vp.id AS vendaPerdidaId, vp.quantidade AS quantidadePerdida, vp.motivo AS motivoPerda
    FROM pedido_itens i
    LEFT JOIN produtos pr ON pr.id = i.produtoId
    LEFT JOIN vendas_perdidas vp ON vp.pedidoItemId = i.id
    WHERE i.pedidoId = ?
    ORDER BY i.id`).all(pedidoId);
  return { pedido, itens };
}

/**
 * Grava perdas a partir dos itens de um pedido. Não abre transação —
 * o chamador decide (o cancelamento precisa gravar junto com o estorno
 * de estoque). Itens já registrados são ignorados, não são erro:
 * cancelar → reabrir → cancelar não pode duplicar.
 *
 * @param itens [{ pedidoItemId, quantidade? }] — omitido = todos os
 *              elegíveis com a quantidade cheia do item.
 * @returns { geradas, ids, ignorados }
 */
function registrarPerdasDePedido(db, pedidoId, opts = {}) {
  const ctx = itensElegiveisPerda(db, pedidoId);
  if (!ctx) throw new Error('Pedido nao encontrado');
  const { pedido, itens } = ctx;

  if (STATUS_BLOQUEIA_PERDA.includes(pedido.status)) {
    throw new Error(`Pedido ${pedido.status} — a venda foi concretizada, nao pode virar venda perdida`);
  }

  const motivo = MOTIVOS_VALIDOS.includes(opts.motivo) ? opts.motivo : 'outro';
  const origem = opts.origem || 'pedido_item';
  const data = opts.data || dataBrasilia();
  const concorrente = (opts.concorrente || '').trim() || null;
  const observacao = (opts.observacao || '').trim() || null;

  // Mapa dos itens pedidos pelo chamador (com qtd parcial, se houver).
  const selecao = Array.isArray(opts.itens) && opts.itens.length
    ? new Map(opts.itens.map(i => [Number(i.pedidoItemId), i.quantidade]))
    : null;

  const ins = db.prepare(`INSERT INTO vendas_perdidas
    (data, produtoId, descricaoLivre, quantidade, precoAlvo, motivo, clienteId,
     origem, observacao, usuario, pedidoId, pedidoItemId, pedidoNumero, concorrente, vendedorUserId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Perda gerada do pedido carrega o vendedor dele.
  const vendedorPedido = pedido.vendedorId || null;

  const ids = [];
  const ignorados = [];
  for (const it of itens) {
    if (selecao && !selecao.has(it.pedidoItemId)) continue;
    if (it.vendaPerdidaId) { ignorados.push(it.pedidoItemId); continue; }

    const qtdBruta = selecao && selecao.get(it.pedidoItemId) != null
      ? Number(selecao.get(it.pedidoItemId))
      : Number(it.quantidade);
    // Perda parcial não pode exceder o que foi pedido.
    const qtd = Math.min(qtdBruta, Number(it.quantidade));
    if (!(qtd > 0)) { ignorados.push(it.pedidoItemId); continue; }

    const r = ins.run(
      data,
      it.produtoId || null,
      it.produtoId ? null : (it.descricao || 'Item sem descrição'),
      qtd,
      it.precoUnitario != null ? Number(it.precoUnitario) : null,
      motivo,
      pedido.clienteId || null,
      origem,
      observacao,
      opts.usuario || null,
      pedido.id,
      it.pedidoItemId,
      pedido.numero,
      concorrente,
      vendedorPedido);
    ids.push(r.lastInsertRowid);
  }
  return { geradas: ids.length, ids, ignorados };
}

/**
 * Remove as perdas geradas automaticamente para um pedido (reabertura,
 * conversão de orçamento). Perdas lançadas à mão ficam — foram decisão
 * do usuário, não efeito colateral do status.
 */
function estornarPerdasDePedido(db, pedidoId, origens = ORIGENS_AUTO) {
  const marks = origens.map(() => '?').join(',');
  const r = db.prepare(`DELETE FROM vendas_perdidas WHERE pedidoId = ? AND origem IN (${marks})`)
    .run(pedidoId, ...origens);
  return r.changes;
}

function registrarRotasPrecos(app, db) {
  migrarPrecosDB(db);

  // ==================== TABELAS DE PREÇO ====================

  app.get('/api/tabelas-preco', (req, res) => {
    try {
      const hoje = dataBrasilia();
      const tabelas = db.prepare(`SELECT t.*,
          (SELECT COUNT(*) FROM tabela_preco_itens WHERE tabelaId = t.id) AS qtdItens,
          (SELECT COUNT(*) FROM pessoas WHERE tabelaPrecoId = t.id) AS qtdClientes
        FROM tabelas_preco t ORDER BY t.prioridade DESC, t.id`).all()
        .map(t => ({ ...t, vigente: tabelaVigente(t, hoje) ? 1 : 0 }));
      res.json({ success: true, tabelas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/tabelas-preco', (req, res) => {
    try {
      const { nome, prioridade, vigenciaInicio, vigenciaFim } = req.body || {};
      if (!nome || !nome.trim()) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const r = db.prepare(`INSERT INTO tabelas_preco (nome, prioridade, vigenciaInicio, vigenciaFim)
        VALUES (?, ?, ?, ?)`).run(nome.trim(), Number(prioridade) || 0, vigenciaInicio || null, vigenciaFim || null);
      logAction(db, req, 'criar', 'tabela-preco', r.lastInsertRowid, { nome });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      const msg = /UNIQUE/.test(err.message) ? 'Já existe tabela com esse nome' : err.message;
      res.status(400).json({ success: false, error: msg });
    }
  });

  app.put('/api/tabelas-preco/:id', (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM tabelas_preco WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Tabela não encontrada' });
      const { nome, prioridade, vigenciaInicio, vigenciaFim, ativo } = req.body || {};
      db.prepare(`UPDATE tabelas_preco SET nome = COALESCE(?, nome), prioridade = COALESCE(?, prioridade),
        vigenciaInicio = ?, vigenciaFim = ?, ativo = COALESCE(?, ativo) WHERE id = ?`).run(
        nome != null ? nome.trim() : null,
        prioridade != null ? Number(prioridade) : null,
        vigenciaInicio !== undefined ? (vigenciaInicio || null) : t.vigenciaInicio,
        vigenciaFim !== undefined ? (vigenciaFim || null) : t.vigenciaFim,
        ativo != null ? (ativo ? 1 : 0) : null, t.id);
      logAction(db, req, 'editar', 'tabela-preco', t.id, req.body);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.get('/api/tabelas-preco/:id/itens', (req, res) => {
    try {
      const itens = db.prepare(`SELECT i.*, p.sku, p.descricao, p.unidade, p.precoVenda AS precoCadastro, p.precoCusto
        FROM tabela_preco_itens i JOIN produtos p ON p.id = i.produtoId
        WHERE i.tabelaId = ? ORDER BY p.descricao, i.qtdMinima`).all(req.params.id);
      res.json({ success: true, itens });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Upsert de item (produtoId + qtdMinima identificam a linha)
  app.post('/api/tabelas-preco/:id/itens', (req, res) => {
    try {
      const t = db.prepare('SELECT id FROM tabelas_preco WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Tabela não encontrada' });
      const { produtoId, preco, qtdMinima } = req.body || {};
      if (!produtoId || !(Number(preco) > 0)) {
        return res.status(400).json({ success: false, error: 'produtoId e preco > 0 obrigatórios' });
      }
      db.prepare(`INSERT INTO tabela_preco_itens (tabelaId, produtoId, preco, qtdMinima)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(tabelaId, produtoId, qtdMinima) DO UPDATE SET preco = excluded.preco`).run(
        t.id, Number(produtoId), Number(preco), Number(qtdMinima) || 0);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/tabelas-preco/:id/itens/:itemId', (req, res) => {
    try {
      const r = db.prepare('DELETE FROM tabela_preco_itens WHERE id = ? AND tabelaId = ?').run(req.params.itemId, req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Item não encontrado' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Reajuste em massa: percentual sobre a própria tabela, ou popular a partir
  // do precoVenda dos produtos (filtro por categoria opcional).
  app.post('/api/tabelas-preco/:id/reajustar', (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM tabelas_preco WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Tabela não encontrada' });
      const { percentual, popularDoCadastro, categoria } = req.body || {};
      let alterados = 0;
      if (popularDoCadastro) {
        const pct = Number(percentual) || 0;
        const prods = db.prepare(`SELECT id, precoVenda FROM produtos WHERE ativo = 1 AND precoVenda > 0
          ${categoria ? 'AND categoria = ?' : ''}`).all(...(categoria ? [categoria] : []));
        const up = db.prepare(`INSERT INTO tabela_preco_itens (tabelaId, produtoId, preco, qtdMinima)
          VALUES (?, ?, ?, 0)
          ON CONFLICT(tabelaId, produtoId, qtdMinima) DO UPDATE SET preco = excluded.preco`);
        const tx = db.transaction(() => {
          for (const p of prods) { up.run(t.id, p.id, Number((p.precoVenda * (1 + pct / 100)).toFixed(2))); alterados++; }
        });
        tx();
      } else {
        const pct = Number(percentual);
        if (!pct) return res.status(400).json({ success: false, error: 'percentual obrigatório' });
        const r = db.prepare(`UPDATE tabela_preco_itens SET preco = ROUND(preco * (1 + ? / 100.0), 2) WHERE tabelaId = ?`).run(pct, t.id);
        alterados = r.changes;
      }
      logAction(db, req, 'reajustar', 'tabela-preco', t.id, { percentual, popularDoCadastro, alterados });
      res.json({ success: true, alterados });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Resolvedor central — usado por pedidos/PDV/propostas
  app.get('/api/precos/resolver', (req, res) => {
    try {
      const { produtoId, pessoaId, quantidade, tabelaId } = req.query;
      if (!produtoId) return res.status(400).json({ success: false, error: 'produtoId obrigatório' });
      const resultado = resolverPreco(db, Number(produtoId), {
        pessoaId: pessoaId ? Number(pessoaId) : null,
        quantidade: quantidade ? Number(quantidade) : 1,
        tabelaId: tabelaId ? Number(tabelaId) : null
      });
      res.json({ success: true, ...resultado });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== VENDAS PERDIDAS ====================

  // Vocabulário de motivos — o front monta os selects a partir daqui.
  app.get('/api/vendas-perdidas/motivos', (req, res) => {
    res.json({ success: true, motivos: MOTIVOS_PERDA });
  });

  // Itens de um pedido/orçamento disponíveis para virar perda.
  app.get('/api/vendas-perdidas/pedido/:pedidoId/itens', (req, res) => {
    try {
      const ctx = itensElegiveisPerda(db, Number(req.params.pedidoId));
      if (!ctx) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      res.json({
        success: true,
        pedido: {
          id: ctx.pedido.id, numero: ctx.pedido.numero, status: ctx.pedido.status,
          modoDocumento: ctx.pedido.modoDocumento, clienteId: ctx.pedido.clienteId,
          clienteNome: ctx.pedido.clienteNome, vendedorId: ctx.pedido.vendedorId,
          bloqueado: STATUS_BLOQUEIA_PERDA.includes(ctx.pedido.status)
        },
        itens: ctx.itens
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Busca de pedidos/orçamentos para o seletor do modal.
  app.get('/api/vendas-perdidas/pedidos-busca', (req, res) => {
    try {
      const termo = (req.query.busca || '').trim();
      let sql = `SELECT p.id, p.numero, p.status, p.modoDocumento, p.dataPedido,
                        p.valorTotal, pe.razaoSocial AS clienteNome
        FROM pedidos p LEFT JOIN pessoas pe ON pe.id = p.clienteId
        WHERE p.status NOT IN ('entregue','faturado')`;
      const params = [];
      if (termo) {
        sql += ' AND (p.numero LIKE ? OR pe.razaoSocial LIKE ?)';
        params.push(`%${termo}%`, `%${termo}%`);
      }
      sql += ' ORDER BY p.dataPedido DESC, p.id DESC LIMIT 50';
      res.json({ success: true, pedidos: db.prepare(sql).all(...params) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/vendas-perdidas', (req, res) => {
    try {
      const { inicio, fim, produtoId, motivo, clienteId, pedidoId, origem, vendedorUserId } = req.query;
      let sql = `SELECT vp.*, p.sku, p.descricao AS produtoDescricao, pe.razaoSocial AS clienteNome,
                        pd.numero AS pedidoNumeroAtual, pd.status AS pedidoStatus,
                        pd.modoDocumento AS pedidoModo,
                        COALESCE(vp.vendedorUserId, pd.vendedorId) AS vendedorEfetivoId,
                        COALESCE(uv.nome, uv.username, up.nome, up.username) AS vendedorNome
        FROM vendas_perdidas vp
        LEFT JOIN produtos p ON p.id = vp.produtoId
        LEFT JOIN pessoas pe ON pe.id = vp.clienteId
        LEFT JOIN pedidos pd ON pd.id = vp.pedidoId
        LEFT JOIN users uv ON uv.id = vp.vendedorUserId
        LEFT JOIN users up ON up.id = pd.vendedorId WHERE 1=1`;
      // Um só conjunto de filtros para listagem e KPIs (antes o KPI só
      // aplicava data, e por interpolação de string — agora parametrizado).
      const filtros = [];
      if (inicio)    filtros.push(['data >= ?', inicio]);
      if (fim)       filtros.push(['data <= ?', fim]);
      if (produtoId) filtros.push(['produtoId = ?', Number(produtoId)]);
      if (motivo)    filtros.push(['motivo = ?', motivo]);
      if (clienteId) filtros.push(['clienteId = ?', Number(clienteId)]);
      if (pedidoId)  filtros.push(['pedidoId = ?', Number(pedidoId)]);
      if (origem)    filtros.push(['origem = ?', origem]);
      if (vendedorUserId) filtros.push(['vendedorUserId = ?', Number(vendedorUserId)]);

      const params = filtros.map(f => f[1]);
      sql += filtros.map(f => ' AND vp.' + f[0]).join('');
      sql += ' ORDER BY vp.data DESC, vp.id DESC LIMIT 300';
      const registros = db.prepare(sql).all(...params);

      const whereKpi = filtros.map(f => ' AND ' + f[0]).join('');
      const porMotivo = db.prepare(`SELECT motivo, COUNT(*) n,
          COALESCE(SUM(quantidade * COALESCE(precoAlvo,0)),0) valor
        FROM vendas_perdidas WHERE 1=1${whereKpi} GROUP BY motivo`).all(...params);
      const totais = db.prepare(`SELECT COUNT(*) n,
          COALESCE(SUM(quantidade * COALESCE(precoAlvo,0)),0) valor,
          COALESCE(SUM(CASE WHEN pedidoId IS NOT NULL THEN 1 ELSE 0 END),0) vinculadas
        FROM vendas_perdidas WHERE 1=1${whereKpi}`).get(...params);

      res.json({ success: true, registros, porMotivo, totais, motivos: MOTIVOS_PERDA });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/vendas-perdidas', (req, res) => {
    try {
      const b = req.body || {};
      let { data, produtoId, descricaoLivre, quantidade, precoAlvo, motivo, clienteId,
            origem, observacao, pedidoId, pedidoItemId, concorrente } = b;

      let pedidoNumero = null;
      // Vínculo com pedido: o item manda no conteúdo — produto, preço e
      // cliente vêm dele quando o usuário não sobrescreveu.
      if (pedidoItemId) {
        const item = db.prepare(`SELECT i.*, p.id AS pid, p.numero, p.status, p.clienteId AS pedidoClienteId
          FROM pedido_itens i JOIN pedidos p ON p.id = i.pedidoId WHERE i.id = ?`).get(Number(pedidoItemId));
        if (!item) return res.status(404).json({ success: false, error: 'Item de pedido nao encontrado' });
        if (pedidoId && Number(pedidoId) !== item.pid) {
          return res.status(400).json({ success: false, error: 'Item nao pertence ao pedido informado' });
        }
        if (STATUS_BLOQUEIA_PERDA.includes(item.status)) {
          return res.status(400).json({ success: false, error: `Pedido ${item.status} — a venda foi concretizada, nao pode virar venda perdida` });
        }
        const jaTem = db.prepare('SELECT id FROM vendas_perdidas WHERE pedidoItemId = ?').get(item.id);
        if (jaTem) {
          return res.status(409).json({ success: false, error: `Este item já tem perda registrada (#${jaTem.id})` });
        }
        pedidoId = item.pid;
        pedidoNumero = item.numero;
        if (produtoId == null) produtoId = item.produtoId;
        if (clienteId == null) clienteId = item.pedidoClienteId;
        if (precoAlvo == null) precoAlvo = item.precoUnitario;
        if (!(Number(quantidade) > 0)) quantidade = item.quantidade;
        if (!produtoId && !descricaoLivre) descricaoLivre = item.descricao;
        if (Number(quantidade) > Number(item.quantidade)) {
          return res.status(400).json({ success: false, error: `Quantidade perdida (${quantidade}) maior que a do item (${item.quantidade})` });
        }
        if (!origem) origem = 'pedido_item';
      } else if (pedidoId) {
        const ped = db.prepare('SELECT id, numero, status, clienteId FROM pedidos WHERE id = ?').get(Number(pedidoId));
        if (!ped) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
        if (STATUS_BLOQUEIA_PERDA.includes(ped.status)) {
          return res.status(400).json({ success: false, error: `Pedido ${ped.status} — a venda foi concretizada, nao pode virar venda perdida` });
        }
        pedidoNumero = ped.numero;
        if (clienteId == null) clienteId = ped.clienteId;
      }

      if (!produtoId && !descricaoLivre) {
        return res.status(400).json({ success: false, error: 'Informe produtoId ou descricaoLivre' });
      }
      if (!(Number(quantidade) > 0)) return res.status(400).json({ success: false, error: 'quantidade > 0 obrigatória' });

      // Perda vinculada a pedido herda o vendedor do pedido; avulsa aceita
      // o vendedor informado. Sem isso a perda avulsa não entrava na
      // conversão de ninguém.
      let vendedorFinal = b.vendedorUserId ? Number(b.vendedorUserId) : null;
      if (!vendedorFinal && pedidoId) {
        try {
          vendedorFinal = db.prepare('SELECT vendedorId FROM pedidos WHERE id = ?').get(pedidoId)?.vendedorId || null;
        } catch { /* tenant sem a coluna */ }
      }

      const r = db.prepare(`INSERT INTO vendas_perdidas
        (data, produtoId, descricaoLivre, quantidade, precoAlvo, motivo, clienteId, origem,
         observacao, usuario, pedidoId, pedidoItemId, pedidoNumero, concorrente, vendedorUserId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        data || dataBrasilia(), produtoId || null, descricaoLivre || null, Number(quantidade),
        precoAlvo != null ? Number(precoAlvo) : null,
        MOTIVOS_VALIDOS.includes(motivo) ? motivo : 'outro',
        clienteId || null, origem || 'manual', observacao || null,
        req.session?.username || null,
        pedidoId || null, pedidoItemId || null, pedidoNumero,
        (concorrente || '').trim() || null, vendedorFinal);
      logAction(db, req, 'criar', 'venda-perdida', r.lastInsertRowid, { produtoId, quantidade, pedidoId, pedidoItemId });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      if (String(err.message).includes('UNIQUE constraint failed')) {
        return res.status(409).json({ success: false, error: 'Este item de pedido já tem perda registrada' });
      }
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Lote a partir de um pedido/orçamento — usado pelo modal da tela do
  // pedido e pelo checkbox do cancelamento (esse via helper direto).
  app.post('/api/vendas-perdidas/pedido/:pedidoId', (req, res) => {
    try {
      const b = req.body || {};
      const pedidoId = Number(req.params.pedidoId);
      const out = db.transaction(() => registrarPerdasDePedido(db, pedidoId, {
        motivo: b.motivo,
        concorrente: b.concorrente,
        observacao: b.observacao,
        data: b.data,
        itens: b.itens,
        origem: b.origem || 'pedido_item',
        usuario: req.session?.username || null,
      }))();
      logAction(db, req, 'criar', 'venda-perdida-lote', pedidoId, { geradas: out.geradas, motivo: b.motivo });
      res.json({ success: true, ...out });
    } catch (err) {
      const st = /nao encontrado/.test(err.message) ? 404
        : /concretizada/.test(err.message) ? 400 : 500;
      res.status(st).json({ success: false, error: err.message });
    }
  });

  // Estorno manual das perdas automáticas de um pedido.
  app.delete('/api/vendas-perdidas/pedido/:pedidoId', (req, res) => {
    try {
      const removidas = estornarPerdasDePedido(db, Number(req.params.pedidoId));
      logAction(db, req, 'excluir', 'venda-perdida-lote', req.params.pedidoId, { removidas });
      res.json({ success: true, removidas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/vendas-perdidas/:id', (req, res) => {
    try {
      const r = db.prepare('DELETE FROM vendas_perdidas WHERE id = ?').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Registro não encontrado' });
      logAction(db, req, 'excluir', 'venda-perdida', req.params.id, {});
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = {
  registrarRotasPrecos, migrarPrecosDB, resolverPreco,
  registrarPerdasDePedido, estornarPerdasDePedido, itensElegiveisPerda,
  MOTIVOS_PERDA, MOTIVOS_VALIDOS, ORIGENS_AUTO,
};
