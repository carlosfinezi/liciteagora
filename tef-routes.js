/**
 * tef-routes.js — TEF/SAT (estrutura MVP).
 *
 * Modelo:
 *   tef_terminais     — pinpads/terminais cadastrados
 *   tef_transacoes    — registro de transações de cartão (autorização, NSU, parcelas)
 *
 * Esta versão NÃO se conecta a hardware (pinpad físico) nem a SDKs nativos como
 * SiTef ou GerTef. Permite registro manual da transação para fechar o ciclo
 * de cartão no PDV. Integração real é evolução.
 */

const { logAction } = require('./audit-log');

const BANDEIRAS = ['Visa','Mastercard','Elo','American Express','Hipercard','Diners','Cabal','Outras'];
const TIPOS = ['credito','debito','voucher','pix','outros'];
const STATUS = ['aprovada','negada','cancelada','estornada'];

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tef_terminais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      adquirenteCartaoId INTEGER,
      identificador TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tef_transacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminalId INTEGER,
      pedidoId INTEGER,
      faturaId INTEGER,
      tipo TEXT NOT NULL DEFAULT 'credito',
      bandeira TEXT,
      parcelas INTEGER DEFAULT 1,
      valor REAL NOT NULL,
      autorizacao TEXT,
      nsu TEXT,
      status TEXT NOT NULL DEFAULT 'aprovada',
      dataTransacao TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      dataEstorno TEXT,
      motivoEstorno TEXT,
      observacoes TEXT,
      usuarioCriacao TEXT,
      FOREIGN KEY (terminalId) REFERENCES tef_terminais(id),
      FOREIGN KEY (pedidoId) REFERENCES pedidos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tef_pedido ON tef_transacoes(pedidoId);
    CREATE INDEX IF NOT EXISTS idx_tef_data ON tef_transacoes(dataTransacao);
    CREATE INDEX IF NOT EXISTS idx_tef_status ON tef_transacoes(status);
  `);
}

function registrarRotasTEF(app, db) {
  migrarDB(db);

  // ---- TERMINAIS ----

  app.get('/api/tef/terminais', (req, res) => {
    try {
      const lista = db.prepare(`
        SELECT t.*, a.nome AS adquirenteNome
        FROM tef_terminais t
        LEFT JOIN adquirentes_cartao a ON a.id = t.adquirenteCartaoId
        WHERE t.ativo = 1 ORDER BY t.nome
      `).all();
      res.json({ success: true, terminais: lista });
    } catch (err) {
      // Tabela adquirentes_cartao pode não existir — fallback
      try {
        const lista = db.prepare('SELECT * FROM tef_terminais WHERE ativo = 1 ORDER BY nome').all();
        res.json({ success: true, terminais: lista });
      } catch (e2) { res.status(500).json({ success: false, error: err.message }); }
    }
  });

  app.post('/api/tef/terminais', (req, res) => {
    try {
      const { nome, adquirenteCartaoId, identificador, observacoes } = req.body;
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const r = db.prepare('INSERT INTO tef_terminais (nome, adquirenteCartaoId, identificador, observacoes) VALUES (?, ?, ?, ?)')
        .run(nome, adquirenteCartaoId || null, identificador || null, observacoes || null);
      logAction(db, req, 'criar', 'tef-terminal', r.lastInsertRowid, { nome });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/tef/terminais/:id', (req, res) => {
    try {
      db.prepare('UPDATE tef_terminais SET ativo = 0 WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ---- TRANSAÇÕES ----

  app.get('/api/tef/transacoes', (req, res) => {
    try {
      const { status, tipo, dataIni, dataFim, q } = req.query;
      let sql = 'SELECT t.*, term.nome AS terminalNome, p.numero AS pedidoNumero FROM tef_transacoes t LEFT JOIN tef_terminais term ON term.id = t.terminalId LEFT JOIN pedidos p ON p.id = t.pedidoId WHERE 1=1';
      const params = [];
      if (status)  { sql += ' AND t.status = ?'; params.push(status); }
      if (tipo)    { sql += ' AND t.tipo = ?';   params.push(tipo); }
      if (dataIni) { sql += ' AND t.dataTransacao >= ?'; params.push(dataIni); }
      if (dataFim) { sql += ' AND t.dataTransacao <= ?'; params.push(dataFim + ' 23:59:59'); }
      if (q)       { sql += ' AND (t.autorizacao LIKE ? OR t.nsu LIKE ?)'; const like=`%${q}%`; params.push(like, like); }
      sql += ' ORDER BY t.id DESC LIMIT 500';
      const transacoes = db.prepare(sql).all(...params);
      const kpis = db.prepare(`
        SELECT
          SUM(CASE WHEN status='aprovada' THEN valor ELSE 0 END) AS aprovadoMes,
          COUNT(CASE WHEN status='aprovada' THEN 1 END) AS qtdAprovadas,
          COUNT(CASE WHEN status='estornada' THEN 1 END) AS qtdEstornadas
        FROM tef_transacoes
        WHERE strftime('%Y-%m', dataTransacao) = strftime('%Y-%m', 'now')
      `).get();
      res.json({ success: true, transacoes, kpis, bandeiras: BANDEIRAS, tipos: TIPOS, status: STATUS });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/tef/transacoes', (req, res) => {
    try {
      const b = req.body;
      if (!b.valor || b.valor <= 0) return res.status(400).json({ success: false, error: 'valor obrigatório' });
      if (b.tipo && !TIPOS.includes(b.tipo)) return res.status(400).json({ success: false, error: 'tipo inválido' });
      if (b.status && !STATUS.includes(b.status)) return res.status(400).json({ success: false, error: 'status inválido' });
      const r = db.prepare(`
        INSERT INTO tef_transacoes (terminalId, pedidoId, faturaId, tipo, bandeira, parcelas, valor, autorizacao, nsu, status, observacoes, usuarioCriacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(b.terminalId || null, b.pedidoId || null, b.faturaId || null,
              b.tipo || 'credito', b.bandeira || null, Number(b.parcelas) || 1, Number(b.valor),
              b.autorizacao || null, b.nsu || null, b.status || 'aprovada', b.observacoes || null,
              req.user?.username || null);
      logAction(db, req, 'criar', 'tef-transacao', r.lastInsertRowid, { valor: b.valor, tipo: b.tipo, bandeira: b.bandeira });
      res.json({ success: true, transacao: db.prepare('SELECT * FROM tef_transacoes WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.post('/api/tef/transacoes/:id/estornar', (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM tef_transacoes WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (t.status !== 'aprovada') return res.status(400).json({ success: false, error: 'Só transações aprovadas podem ser estornadas' });
      const motivo = (req.body?.motivo || '').trim();
      if (motivo.length < 5) return res.status(400).json({ success: false, error: 'Motivo obrigatório (mín 5 chars)' });
      db.prepare(`UPDATE tef_transacoes SET status = 'estornada', dataEstorno = CURRENT_TIMESTAMP, motivoEstorno = ? WHERE id = ?`).run(motivo, t.id);
      logAction(db, req, 'estornar', 'tef-transacao', t.id, { motivo });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasTEF };
