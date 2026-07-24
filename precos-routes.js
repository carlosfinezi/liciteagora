/**
 * precos-routes.js — Tabelas de preço (V1) e vendas perdidas (V2).
 *
 * Resolução de preço (resolverPreco): tabela do cliente (vigente) →
 * tabelas vigentes por prioridade → produtos.precoVenda. Linhas com
 * qtdMinima selecionam a de maior qtdMinima <= quantidade pedida.
 * Endpoint GET /api/precos/resolver serve pedidos/PDV/propostas.
 */

const { logAction } = require('./audit-log');

function dataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna ja existe */ } }

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

  app.get('/api/vendas-perdidas', (req, res) => {
    try {
      const { inicio, fim, produtoId, motivo } = req.query;
      let sql = `SELECT vp.*, p.sku, p.descricao AS produtoDescricao, pe.razaoSocial AS clienteNome
        FROM vendas_perdidas vp
        LEFT JOIN produtos p ON p.id = vp.produtoId
        LEFT JOIN pessoas pe ON pe.id = vp.clienteId WHERE 1=1`;
      const params = [];
      if (inicio)    { sql += ' AND vp.data >= ?'; params.push(inicio); }
      if (fim)       { sql += ' AND vp.data <= ?'; params.push(fim); }
      if (produtoId) { sql += ' AND vp.produtoId = ?'; params.push(Number(produtoId)); }
      if (motivo)    { sql += ' AND vp.motivo = ?'; params.push(motivo); }
      sql += ' ORDER BY vp.data DESC, vp.id DESC LIMIT 300';
      const registros = db.prepare(sql).all(...params);
      const porMotivo = db.prepare(`SELECT motivo, COUNT(*) n, COALESCE(SUM(quantidade * COALESCE(precoAlvo,0)),0) valor
        FROM vendas_perdidas ${inicio || fim ? 'WHERE 1=1' + (inicio ? " AND data >= '" + inicio + "'" : '') + (fim ? " AND data <= '" + fim + "'" : '') : ''}
        GROUP BY motivo`).all();
      res.json({ success: true, registros, porMotivo });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/vendas-perdidas', (req, res) => {
    try {
      const { data, produtoId, descricaoLivre, quantidade, precoAlvo, motivo, clienteId, origem, observacao } = req.body || {};
      if (!produtoId && !descricaoLivre) {
        return res.status(400).json({ success: false, error: 'Informe produtoId ou descricaoLivre' });
      }
      if (!(Number(quantidade) > 0)) return res.status(400).json({ success: false, error: 'quantidade > 0 obrigatória' });
      const motivos = ['sem_estoque', 'preco', 'prazo', 'outro'];
      const r = db.prepare(`INSERT INTO vendas_perdidas
        (data, produtoId, descricaoLivre, quantidade, precoAlvo, motivo, clienteId, origem, observacao, usuario)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        data || dataBrasilia(), produtoId || null, descricaoLivre || null, Number(quantidade),
        precoAlvo != null ? Number(precoAlvo) : null,
        motivos.includes(motivo) ? motivo : 'outro',
        clienteId || null, origem || 'manual', observacao || null,
        req.session?.username || null);
      logAction(db, req, 'criar', 'venda-perdida', r.lastInsertRowid, { produtoId, quantidade });
      res.json({ success: true, id: r.lastInsertRowid });
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

module.exports = { registrarRotasPrecos, migrarPrecosDB, resolverPreco };
