/**
 * planejamento-routes.js — Item 3.4:
 *  - Provisões: lançamentos previstos manuais que entram no fluxo de caixa projetado;
 *  - Orçamento: previsto × realizado por conta do plano gerencial;
 *  - Metas de vendas: por vendedor × competência, com atingimento.
 */

const { logAction } = require('./audit-log');

function migrarPlanejamentoDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provisoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      descricao TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'saida',
      valor REAL NOT NULL,
      dataPrevista TEXT NOT NULL,
      planoContaId INTEGER,
      status TEXT NOT NULL DEFAULT 'ativa',
      observacao TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_prov_data ON provisoes(status, dataPrevista);

    CREATE TABLE IF NOT EXISTS orcamento_plano_contas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      planoContaId INTEGER NOT NULL,
      competencia TEXT NOT NULL,
      valorPrevisto REAL NOT NULL,
      UNIQUE (planoContaId, competencia)
    );

    CREATE TABLE IF NOT EXISTS metas_vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendedorUserId INTEGER NOT NULL,
      competencia TEXT NOT NULL,
      valorMeta REAL NOT NULL,
      UNIQUE (vendedorUserId, competencia)
    );
  `);
}

function registrarRotasPlanejamento(app, db) {
  migrarPlanejamentoDB(db);

  // ==================== PROVISÕES ====================

  app.get('/api/provisoes', (req, res) => {
    try {
      const { status, inicio, fim } = req.query;
      let sql = `SELECT p.*, pc.nome AS planoContaNome FROM provisoes p
        LEFT JOIN plano_contas pc ON pc.id = p.planoContaId WHERE 1=1`;
      const params = [];
      if (status) { sql += ' AND p.status = ?'; params.push(status); }
      if (inicio) { sql += ' AND p.dataPrevista >= ?'; params.push(inicio); }
      if (fim)    { sql += ' AND p.dataPrevista <= ?'; params.push(fim); }
      sql += ' ORDER BY p.dataPrevista, p.id LIMIT 300';
      res.json({ success: true, provisoes: db.prepare(sql).all(...params) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/provisoes', (req, res) => {
    try {
      const { descricao, tipo, valor, dataPrevista, planoContaId, observacao, repetirMeses } = req.body || {};
      if (!descricao || !(Number(valor) > 0) || !dataPrevista) {
        return res.status(400).json({ success: false, error: 'descricao, valor > 0 e dataPrevista obrigatórios' });
      }
      const t = tipo === 'entrada' ? 'entrada' : 'saida';
      const n = Math.min(Math.max(Number(repetirMeses) || 1, 1), 60);
      const usuario = req.session?.username || null;
      const ids = [];
      const tx = db.transaction(() => {
        for (let i = 0; i < n; i++) {
          const d = new Date(dataPrevista + 'T12:00:00');
          d.setMonth(d.getMonth() + i);
          const r = db.prepare(`INSERT INTO provisoes (descricao, tipo, valor, dataPrevista, planoContaId, observacao, usuario)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            descricao.trim(), t, Number(valor), d.toISOString().slice(0, 10),
            planoContaId || null, observacao || null, usuario);
          ids.push(r.lastInsertRowid);
        }
      });
      tx();
      logAction(db, req, 'criar', 'provisao', ids[0], { parcelas: n });
      res.json({ success: true, ids });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/provisoes/:id', (req, res) => {
    try {
      const { status, valor, dataPrevista } = req.body || {};
      if (status && !['ativa', 'realizada', 'cancelada'].includes(status)) {
        return res.status(400).json({ success: false, error: 'status: ativa|realizada|cancelada' });
      }
      const r = db.prepare(`UPDATE provisoes SET status = COALESCE(?, status),
        valor = COALESCE(?, valor), dataPrevista = COALESCE(?, dataPrevista) WHERE id = ?`).run(
        status || null, valor != null ? Number(valor) : null, dataPrevista || null, req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Provisão não encontrada' });
      logAction(db, req, 'editar', 'provisao', req.params.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ORÇAMENTO (previsto × realizado) ====================

  app.post('/api/orcamento', (req, res) => {
    try {
      const { planoContaId, competencia, valorPrevisto } = req.body || {};
      if (!planoContaId || !/^\d{4}-\d{2}$/.test(competencia || '') || valorPrevisto == null) {
        return res.status(400).json({ success: false, error: 'planoContaId, competencia (YYYY-MM) e valorPrevisto obrigatórios' });
      }
      db.prepare(`INSERT INTO orcamento_plano_contas (planoContaId, competencia, valorPrevisto)
        VALUES (?, ?, ?)
        ON CONFLICT(planoContaId, competencia) DO UPDATE SET valorPrevisto = excluded.valorPrevisto`)
        .run(Number(planoContaId), competencia, Number(valorPrevisto));
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Previsto × realizado do ano: realizado = pagamentos efetivos (CR entra, CP sai)
  // agregados pela conta do plano gerencial do título, competência = mês do pagamento.
  app.get('/api/orcamento/previsto-realizado', (req, res) => {
    try {
      const ano = String(req.query.ano || new Date().getFullYear());
      if (!/^\d{4}$/.test(ano)) return res.status(400).json({ success: false, error: 'ano YYYY' });

      const previsto = db.prepare(`SELECT o.planoContaId, o.competencia, o.valorPrevisto,
          pc.codigo, pc.nome, pc.tipo
        FROM orcamento_plano_contas o JOIN plano_contas pc ON pc.id = o.planoContaId
        WHERE o.competencia LIKE ?`).all(ano + '-%');

      const realizadoCR = db.prepare(`SELECT c.planoContaId, substr(p.dataPagamento,1,7) AS competencia,
          SUM(p.valorPago) AS valor
        FROM contas_receber_pagamentos p JOIN contas_a_receber c ON c.id = p.contaReceberId
        WHERE p.estornado = 0 AND c.planoContaId IS NOT NULL AND p.dataPagamento LIKE ?
        GROUP BY c.planoContaId, competencia`).all(ano + '-%');
      const realizadoCP = db.prepare(`SELECT c.planoContaId, substr(p.dataPagamento,1,7) AS competencia,
          SUM(p.valorPago) AS valor
        FROM contas_pagar_pagamentos p JOIN contas_a_pagar c ON c.id = p.contaPagarId
        WHERE p.estornado = 0 AND c.planoContaId IS NOT NULL AND p.dataPagamento LIKE ?
        GROUP BY c.planoContaId, competencia`).all(ano + '-%');

      const chave = (pcId, comp) => pcId + ':' + comp;
      const mapa = new Map();
      for (const p of previsto) {
        mapa.set(chave(p.planoContaId, p.competencia), {
          planoContaId: p.planoContaId, codigo: p.codigo, nome: p.nome, tipo: p.tipo,
          competencia: p.competencia, previsto: p.valorPrevisto, realizado: 0
        });
      }
      const acumula = (rows) => {
        for (const r of rows) {
          const k = chave(r.planoContaId, r.competencia);
          if (!mapa.has(k)) {
            const pc = db.prepare('SELECT codigo, nome, tipo FROM plano_contas WHERE id = ?').get(r.planoContaId) || {};
            mapa.set(k, { planoContaId: r.planoContaId, codigo: pc.codigo, nome: pc.nome, tipo: pc.tipo,
              competencia: r.competencia, previsto: 0, realizado: 0 });
          }
          mapa.get(k).realizado += r.valor;
        }
      };
      acumula(realizadoCR); acumula(realizadoCP);
      const linhas = [...mapa.values()].map(l => ({
        ...l, realizado: Number(l.realizado.toFixed(2)),
        desvio: Number((l.realizado - l.previsto).toFixed(2))
      })).sort((a, b) => (a.codigo || '').localeCompare(b.codigo || '') || a.competencia.localeCompare(b.competencia));
      res.json({ success: true, ano, linhas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== METAS DE VENDAS ====================

  app.post('/api/metas', (req, res) => {
    try {
      const { vendedorUserId, competencia, valorMeta } = req.body || {};
      if (!vendedorUserId || !/^\d{4}-\d{2}$/.test(competencia || '') || !(Number(valorMeta) >= 0)) {
        return res.status(400).json({ success: false, error: 'vendedorUserId, competencia (YYYY-MM) e valorMeta obrigatórios' });
      }
      db.prepare(`INSERT INTO metas_vendas (vendedorUserId, competencia, valorMeta)
        VALUES (?, ?, ?)
        ON CONFLICT(vendedorUserId, competencia) DO UPDATE SET valorMeta = excluded.valorMeta`)
        .run(Number(vendedorUserId), competencia, Number(valorMeta));
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Atingimento: realizado = pedidos do vendedor na competência (fora rascunho/cancelado)
  app.get('/api/metas/atingimento', (req, res) => {
    try {
      const comp = req.query.competencia;
      if (!/^\d{4}-\d{2}$/.test(comp || '')) return res.status(400).json({ success: false, error: 'competencia YYYY-MM' });
      const vendedores = db.prepare(`SELECT id, username, nome FROM users WHERE ativo = 1`).all();
      const metas = new Map(db.prepare('SELECT * FROM metas_vendas WHERE competencia = ?').all(comp)
        .map(m => [m.vendedorUserId, m.valorMeta]));
      const vendas = new Map(db.prepare(`SELECT vendedorId, SUM(valorTotal) v FROM pedidos
        WHERE vendedorId IS NOT NULL AND substr(dataPedido,1,7) = ?
          AND status NOT IN ('rascunho','cancelado')
        GROUP BY vendedorId`).all(comp).map(r => [r.vendedorId, r.v]));
      const linhas = vendedores
        .map(v => {
          const meta = metas.get(v.id) || 0;
          const realizado = Number((vendas.get(v.id) || 0).toFixed(2));
          return { vendedorUserId: v.id, vendedor: v.nome || v.username, competencia: comp,
            meta, realizado, atingimento: meta > 0 ? Number((realizado / meta * 100).toFixed(1)) : null };
        })
        .filter(l => l.meta > 0 || l.realizado > 0);
      res.json({ success: true, competencia: comp, linhas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasPlanejamento, migrarPlanejamentoDB };
