/**
 * governanca-routes.js — Alçadas e aprovações (item 2.6).
 *
 * regras_alcada: acima de limiteValor, o evento exige aprovação de um papel.
 * verificarAlcada() é o hook usado pelos fluxos (baixa de CP, envio de pedido
 * de compra): se houver regra e o valor estourar, cria/consulta a aprovação
 * e bloqueia até um aprovador decidir. Aprovação 'aprovada' libera UMA
 * execução do evento (consumida ao usar).
 *
 * Módulo de gate: 'governanca' (Enterprise).
 */

const { logAction } = require('./audit-log');

const TIPOS_EVENTO = new Set(['pagamento_cp', 'pedido_compra']);

function migrarGovernancaDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS regras_alcada (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipoEvento TEXT NOT NULL,
      limiteValor REAL NOT NULL,
      papelAprovador TEXT NOT NULL DEFAULT 'admin',
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS aprovacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipoEvento TEXT NOT NULL,
      referenciaId INTEGER NOT NULL,
      valorReferencia REAL,
      solicitante TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      aprovador TEXT,
      motivo TEXT,
      dataDecisao TEXT,
      consumida INTEGER DEFAULT 0,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_aprov_ref ON aprovacoes(tipoEvento, referenciaId, status);
  `);
}

/**
 * Hook dos fluxos. Retorna:
 *   { liberado: true }                      — sem regra ou abaixo do limite ou aprovação consumível
 *   { liberado: false, status, aprovacaoId} — bloqueado (pendente criada/reaproveitada ou reprovada)
 * Quando libera via aprovação, marca consumida=1 (uma aprovação → uma execução).
 */
function verificarAlcada(db, { tipoEvento, referenciaId, valor, usuario = null }) {
  const regra = db.prepare(`SELECT * FROM regras_alcada
    WHERE tipoEvento = ? AND ativo = 1 ORDER BY limiteValor ASC LIMIT 1`).get(tipoEvento);
  if (!regra || !(Number(valor) > regra.limiteValor)) return { liberado: true };

  const existente = db.prepare(`SELECT * FROM aprovacoes
    WHERE tipoEvento = ? AND referenciaId = ? AND consumida = 0
    ORDER BY id DESC LIMIT 1`).get(tipoEvento, referenciaId);

  if (existente && existente.status === 'aprovada') {
    db.prepare('UPDATE aprovacoes SET consumida = 1 WHERE id = ?').run(existente.id);
    return { liberado: true, aprovacaoId: existente.id };
  }
  if (existente && existente.status === 'pendente') {
    return { liberado: false, status: 'pendente', aprovacaoId: existente.id, regra };
  }
  if (existente && existente.status === 'reprovada') {
    return { liberado: false, status: 'reprovada', aprovacaoId: existente.id, regra };
  }
  const r = db.prepare(`INSERT INTO aprovacoes (tipoEvento, referenciaId, valorReferencia, solicitante)
    VALUES (?, ?, ?, ?)`).run(tipoEvento, referenciaId, Number(valor) || null, usuario);
  return { liberado: false, status: 'pendente', aprovacaoId: r.lastInsertRowid, regra };
}

function registrarRotasGovernanca(app, db) {
  migrarGovernancaDB(db);

  // ===== regras =====
  app.get('/api/alcadas/regras', (req, res) => {
    try {
      res.json({ success: true, regras: db.prepare('SELECT * FROM regras_alcada ORDER BY tipoEvento, limiteValor').all() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/alcadas/regras', (req, res) => {
    try {
      const { tipoEvento, limiteValor, papelAprovador } = req.body || {};
      if (!TIPOS_EVENTO.has(tipoEvento)) {
        return res.status(400).json({ success: false, error: `tipoEvento: ${[...TIPOS_EVENTO].join('|')}` });
      }
      if (!(Number(limiteValor) >= 0)) return res.status(400).json({ success: false, error: 'limiteValor >= 0 obrigatório' });
      const r = db.prepare(`INSERT INTO regras_alcada (tipoEvento, limiteValor, papelAprovador)
        VALUES (?, ?, ?)`).run(tipoEvento, Number(limiteValor), papelAprovador || 'admin');
      logAction(db, req, 'criar', 'regra-alcada', r.lastInsertRowid, req.body);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/alcadas/regras/:id', (req, res) => {
    try {
      const { limiteValor, papelAprovador, ativo } = req.body || {};
      const r = db.prepare(`UPDATE regras_alcada SET
        limiteValor = COALESCE(?, limiteValor), papelAprovador = COALESCE(?, papelAprovador),
        ativo = COALESCE(?, ativo) WHERE id = ?`).run(
        limiteValor != null ? Number(limiteValor) : null,
        papelAprovador || null,
        ativo != null ? (ativo ? 1 : 0) : null, req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Regra não encontrada' });
      logAction(db, req, 'editar', 'regra-alcada', req.params.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ===== fila de aprovações =====
  app.get('/api/alcadas/aprovacoes', (req, res) => {
    try {
      const { status } = req.query;
      let sql = `SELECT a.*,
          CASE a.tipoEvento
            WHEN 'pagamento_cp' THEN (SELECT descricao FROM contas_a_pagar WHERE id = a.referenciaId)
            WHEN 'pedido_compra' THEN (SELECT numero FROM pedidos_compra WHERE id = a.referenciaId)
          END AS referenciaDescricao
        FROM aprovacoes a WHERE 1=1`;
      const params = [];
      if (status) { sql += ' AND a.status = ?'; params.push(status); }
      sql += ' ORDER BY a.id DESC LIMIT 200';
      res.json({ success: true, aprovacoes: db.prepare(sql).all(...params) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  const decidir = (novoStatus) => (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM aprovacoes WHERE id = ?').get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'Aprovação não encontrada' });
      if (a.status !== 'pendente') return res.status(400).json({ success: false, error: `Status atual: ${a.status}` });

      // papel do aprovador: regra vigente do tipo, default admin
      const regra = db.prepare(`SELECT papelAprovador FROM regras_alcada WHERE tipoEvento = ? AND ativo = 1 LIMIT 1`).get(a.tipoEvento);
      const papel = regra?.papelAprovador || 'admin';
      const eu = db.prepare('SELECT username, role FROM users WHERE id = ?').get(req.session?.userId || -1);
      if (!eu || (eu.role !== 'admin' && eu.role !== papel)) {
        return res.status(403).json({ success: false, error: `Apenas o papel "${papel}" (ou admin) pode decidir` });
      }
      if (eu.username === a.solicitante && novoStatus === 'aprovada') {
        return res.status(403).json({ success: false, error: 'Solicitante não pode aprovar a própria solicitação' });
      }
      const motivo = (req.body?.motivo || '').trim() || null;
      if (novoStatus === 'reprovada' && !motivo) {
        return res.status(400).json({ success: false, error: 'Motivo obrigatório para reprovar' });
      }
      db.prepare(`UPDATE aprovacoes SET status = ?, aprovador = ?, motivo = ?, dataDecisao = DATETIME('now','-3 hours') WHERE id = ?`)
        .run(novoStatus, eu.username, motivo, a.id);
      logAction(db, req, novoStatus === 'aprovada' ? 'aprovar' : 'reprovar', 'aprovacao', a.id, { tipoEvento: a.tipoEvento, referenciaId: a.referenciaId });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  };
  app.post('/api/alcadas/aprovacoes/:id/aprovar', decidir('aprovada'));
  app.post('/api/alcadas/aprovacoes/:id/reprovar', decidir('reprovada'));
}

module.exports = { registrarRotasGovernanca, migrarGovernancaDB, verificarAlcada };
