/**
 * roteirizacao-routes.js — Romaneio de entregas e ordem de paradas.
 *
 * Modelo:
 *   romaneios          — uma viagem (data, motorista, veículo, status)
 *   romaneio_paradas   — pontos do roteiro (sequência ordenada, com pedido vinculado opcional)
 *
 * Status romaneio: rascunho | em-rota | concluido | cancelado
 * Status parada:   pendente | entregue | nao-entregue | cancelada
 *
 * Não integra com mapas — sequência é definida manualmente pelo operador.
 */

const { logAction } = require('./audit-log');

const STATUS_ROMANEIO = ['rascunho','em-rota','concluido','cancelado'];
const STATUS_PARADA   = ['pendente','entregue','nao-entregue','cancelada'];

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS romaneios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL,
      motoristaId INTEGER,
      motoristaNome TEXT,
      placa TEXT,
      ufOrigem TEXT,
      ufDestino TEXT,
      kmInicial REAL,
      kmFinal REAL,
      observacoes TEXT,
      status TEXT NOT NULL DEFAULT 'rascunho',
      dataInicio TEXT,
      dataFim TEXT,
      usuarioCriacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (motoristaId) REFERENCES funcionarios(id)
    );
    CREATE INDEX IF NOT EXISTS idx_rom_status ON romaneios(status, data);

    CREATE TABLE IF NOT EXISTS romaneio_paradas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      romaneioId INTEGER NOT NULL,
      sequencia INTEGER NOT NULL,
      pedidoId INTEGER,
      clienteId INTEGER,
      enderecoCompleto TEXT,
      cidade TEXT,
      uf TEXT,
      cep TEXT,
      contato TEXT,
      telefone TEXT,
      horaPrevista TEXT,
      horaChegada TEXT,
      horaSaida TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      assinante TEXT,
      observacoes TEXT,
      motivoNaoEntrega TEXT,
      FOREIGN KEY (romaneioId) REFERENCES romaneios(id) ON DELETE CASCADE,
      FOREIGN KEY (pedidoId) REFERENCES pedidos(id),
      FOREIGN KEY (clienteId) REFERENCES pessoas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_par_rom ON romaneio_paradas(romaneioId, sequencia);
  `);
}

function gerarNumero(db) {
  const ano = new Date().getFullYear();
  const prefix = `RM-${ano}-`;
  const u = db.prepare(`SELECT numero FROM romaneios WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix+'%');
  let n = 1; if (u) { const m = u.numero.match(/-(\d+)$/); if (m) n = parseInt(m[1],10) + 1; }
  return prefix + String(n).padStart(4, '0');
}

function registrarRotasRoteirizacao(app, db) {
  migrarDB(db);

  app.get('/api/romaneios', (req, res) => {
    try {
      const { status, q, dataIni, dataFim } = req.query;
      let sql = 'SELECT r.*, f.nome AS motoristaNomeFunc FROM romaneios r LEFT JOIN funcionarios f ON f.id = r.motoristaId WHERE 1=1';
      const params = [];
      if (status) { sql += ' AND r.status = ?'; params.push(status); }
      if (dataIni) { sql += ' AND r.data >= ?'; params.push(dataIni); }
      if (dataFim) { sql += ' AND r.data <= ?'; params.push(dataFim); }
      if (q) { sql += ' AND (r.numero LIKE ? OR r.placa LIKE ? OR r.motoristaNome LIKE ?)'; const like=`%${q}%`; params.push(like, like, like); }
      sql += ' ORDER BY r.id DESC LIMIT 200';
      const romaneios = db.prepare(sql).all(...params);
      // adiciona contagens
      const stmtCnt = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status='entregue' THEN 1 ELSE 0 END) AS entregues,
               SUM(CASE WHEN status='nao-entregue' THEN 1 ELSE 0 END) AS naoEntregues,
               SUM(CASE WHEN status='pendente' THEN 1 ELSE 0 END) AS pendentes
        FROM romaneio_paradas WHERE romaneioId = ?
      `);
      for (const r of romaneios) r.paradas = stmtCnt.get(r.id);
      res.json({ success: true, romaneios });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/romaneios/:id', (req, res) => {
    try {
      const r = db.prepare('SELECT r.*, f.nome AS motoristaNomeFunc FROM romaneios r LEFT JOIN funcionarios f ON f.id = r.motoristaId WHERE r.id = ?').get(req.params.id);
      if (!r) return res.status(404).json({ success: false, error: 'Romaneio não encontrado' });
      const paradas = db.prepare(`
        SELECT p.*, pe.numero AS pedidoNumero, c.razaoSocial AS clienteNome
        FROM romaneio_paradas p
        LEFT JOIN pedidos pe ON pe.id = p.pedidoId
        LEFT JOIN pessoas c ON c.id = p.clienteId
        WHERE p.romaneioId = ? ORDER BY p.sequencia
      `).all(r.id);
      res.json({ success: true, romaneio: r, paradas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/romaneios', (req, res) => {
    try {
      const b = req.body;
      if (!b.data) return res.status(400).json({ success: false, error: 'data obrigatória' });
      const numero = gerarNumero(db);
      const r = db.prepare(`
        INSERT INTO romaneios (numero, data, motoristaId, motoristaNome, placa, ufOrigem, ufDestino, kmInicial, observacoes, usuarioCriacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(numero, b.data, b.motoristaId || null, b.motoristaNome || null, b.placa || null,
              b.ufOrigem || null, b.ufDestino || null, b.kmInicial || null, b.observacoes || null,
              req.user?.username || null);
      logAction(db, req, 'criar', 'romaneio', r.lastInsertRowid, { numero });
      res.json({ success: true, romaneio: db.prepare('SELECT * FROM romaneios WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/romaneios/:id', (req, res) => {
    try {
      const camposValidos = ['data','motoristaId','motoristaNome','placa','ufOrigem','ufDestino','kmInicial','kmFinal','observacoes'];
      const sets = [], vals = [];
      for (const c of camposValidos) {
        if (req.body[c] !== undefined) { sets.push(`${c} = ?`); vals.push(req.body[c] === '' ? null : req.body[c]); }
      }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.id);
      db.prepare(`UPDATE romaneios SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/romaneios/:id/iniciar', (req, res) => {
    try {
      db.prepare(`UPDATE romaneios SET status = 'em-rota', dataInicio = CURRENT_TIMESTAMP WHERE id = ? AND status = 'rascunho'`).run(req.params.id);
      logAction(db, req, 'iniciar', 'romaneio', req.params.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/romaneios/:id/concluir', (req, res) => {
    try {
      const { kmFinal } = req.body || {};
      db.prepare(`UPDATE romaneios SET status = 'concluido', dataFim = CURRENT_TIMESTAMP, kmFinal = COALESCE(?, kmFinal) WHERE id = ?`).run(kmFinal != null ? Number(kmFinal) : null, req.params.id);
      logAction(db, req, 'concluir', 'romaneio', req.params.id, { kmFinal });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/romaneios/:id/cancelar', (req, res) => {
    try {
      db.prepare(`UPDATE romaneios SET status = 'cancelado' WHERE id = ?`).run(req.params.id);
      logAction(db, req, 'cancelar', 'romaneio', req.params.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ========== PARADAS ==========

  app.post('/api/romaneios/:id/paradas', (req, res) => {
    try {
      const b = req.body;
      let pedidoCtx = {};
      if (b.pedidoId) {
        const p = db.prepare(`
          SELECT p.id, p.clienteId, p.enderecoEntrega, p.numeroEntrega, p.complementoEntrega, p.bairroEntrega, p.cidadeEntrega, p.ufEntrega, p.cepEntrega, p.contatoEntrega, p.telefoneEntrega,
                 pe.razaoSocial, pe.endereco, pe.cidade, pe.uf, pe.cep, pe.telefone
          FROM pedidos p LEFT JOIN pessoas pe ON pe.id = p.clienteId WHERE p.id = ?
        `).get(b.pedidoId);
        if (p) {
          const endParts = [p.enderecoEntrega || p.endereco, p.numeroEntrega, p.complementoEntrega, p.bairroEntrega].filter(Boolean);
          pedidoCtx = {
            clienteId: p.clienteId,
            enderecoCompleto: endParts.join(', ') || null,
            cidade: p.cidadeEntrega || p.cidade || null,
            uf: p.ufEntrega || p.uf || null,
            cep: p.cepEntrega || p.cep || null,
            contato: p.contatoEntrega || null,
            telefone: p.telefoneEntrega || p.telefone || null
          };
        }
      }
      // próxima sequência
      const ultSeq = db.prepare('SELECT COALESCE(MAX(sequencia),0) AS m FROM romaneio_paradas WHERE romaneioId = ?').get(req.params.id).m;
      const r = db.prepare(`
        INSERT INTO romaneio_paradas (romaneioId, sequencia, pedidoId, clienteId, enderecoCompleto, cidade, uf, cep, contato, telefone, horaPrevista, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.id, b.sequencia || ultSeq + 1, b.pedidoId || null,
              b.clienteId || pedidoCtx.clienteId || null,
              b.enderecoCompleto || pedidoCtx.enderecoCompleto || null,
              b.cidade || pedidoCtx.cidade || null, b.uf || pedidoCtx.uf || null, b.cep || pedidoCtx.cep || null,
              b.contato || pedidoCtx.contato || null, b.telefone || pedidoCtx.telefone || null,
              b.horaPrevista || null, b.observacoes || null);
      logAction(db, req, 'add-parada', 'romaneio', req.params.id, { paradaId: r.lastInsertRowid });
      res.json({ success: true, parada: db.prepare('SELECT * FROM romaneio_paradas WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/romaneios/paradas/:paradaId/sequencia', (req, res) => {
    try {
      const { sequencia } = req.body;
      db.prepare('UPDATE romaneio_paradas SET sequencia = ? WHERE id = ?').run(Number(sequencia), req.params.paradaId);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/romaneios/paradas/:paradaId/entregar', (req, res) => {
    try {
      const { assinante, observacoes } = req.body || {};
      db.prepare(`UPDATE romaneio_paradas SET status = 'entregue', horaChegada = COALESCE(horaChegada, time('now')), horaSaida = time('now'), assinante = ?, observacoes = COALESCE(?, observacoes) WHERE id = ?`)
        .run(assinante || null, observacoes || null, req.params.paradaId);
      logAction(db, req, 'entregar', 'romaneio-parada', req.params.paradaId, { assinante });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/romaneios/paradas/:paradaId/nao-entregar', (req, res) => {
    try {
      const motivo = (req.body?.motivo || '').trim();
      if (motivo.length < 3) return res.status(400).json({ success: false, error: 'motivo obrigatório' });
      db.prepare(`UPDATE romaneio_paradas SET status = 'nao-entregue', motivoNaoEntrega = ? WHERE id = ?`).run(motivo, req.params.paradaId);
      logAction(db, req, 'nao-entregar', 'romaneio-parada', req.params.paradaId, { motivo });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/romaneios/paradas/:paradaId', (req, res) => {
    try {
      db.prepare('DELETE FROM romaneio_paradas WHERE id = ?').run(req.params.paradaId);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasRoteirizacao };
