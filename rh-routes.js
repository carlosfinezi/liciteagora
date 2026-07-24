/**
 * rh-routes.js — RH básico: funcionários, ponto, férias, atestados.
 *
 * Modelo:
 *   funcionarios            — cadastro
 *   funcionarios_ponto      — registro diário (entrada/saída/almoço)
 *   funcionarios_ferias     — período aquisitivo + gozo
 *   funcionarios_atestados  — atestado médico ou outro
 *
 * Cálculos: horas trabalhadas = (saída - entrada) - (volta - saída almoço)
 */

const { logAction } = require('./audit-log');

const TIPOS_CONTRATO = ['CLT', 'PJ', 'MEI', 'autonomo', 'estagio', 'jovem-aprendiz'];
const STATUS_FERIAS = ['planejada', 'aprovada', 'em-curso', 'concluida', 'cancelada'];

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS funcionarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cpf TEXT UNIQUE,
      nome TEXT NOT NULL,
      dataNascimento TEXT,
      dataAdmissao TEXT NOT NULL,
      dataDemissao TEXT,
      cargo TEXT,
      departamento TEXT,
      salario REAL DEFAULT 0,
      tipoContrato TEXT NOT NULL DEFAULT 'CLT',
      jornadaSemanalHoras REAL DEFAULT 44,
      email TEXT,
      telefone TEXT,
      endereco TEXT,
      banco TEXT,
      agencia TEXT,
      conta TEXT,
      pix TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_func_ativo ON funcionarios(ativo, nome);

    CREATE TABLE IF NOT EXISTS funcionarios_ponto (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      funcionarioId INTEGER NOT NULL,
      data TEXT NOT NULL,
      horaEntrada TEXT,
      horaSaidaAlmoco TEXT,
      horaVoltaAlmoco TEXT,
      horaSaida TEXT,
      horasTrabalhadas REAL,
      observacoes TEXT,
      tipo TEXT NOT NULL DEFAULT 'normal',
      FOREIGN KEY (funcionarioId) REFERENCES funcionarios(id) ON DELETE CASCADE,
      UNIQUE(funcionarioId, data)
    );
    CREATE INDEX IF NOT EXISTS idx_ponto_func ON funcionarios_ponto(funcionarioId, data);

    CREATE TABLE IF NOT EXISTS funcionarios_ferias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      funcionarioId INTEGER NOT NULL,
      periodoAquisitivoIni TEXT NOT NULL,
      periodoAquisitivoFim TEXT NOT NULL,
      dataInicio TEXT,
      dataFim TEXT,
      dias INTEGER,
      status TEXT NOT NULL DEFAULT 'planejada',
      diasAbono INTEGER DEFAULT 0,
      observacoes TEXT,
      FOREIGN KEY (funcionarioId) REFERENCES funcionarios(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ferias_func ON funcionarios_ferias(funcionarioId, status);

    CREATE TABLE IF NOT EXISTS funcionarios_atestados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      funcionarioId INTEGER NOT NULL,
      dataInicio TEXT NOT NULL,
      dataFim TEXT NOT NULL,
      dias INTEGER,
      cid TEXT,
      profissionalSaude TEXT,
      crm TEXT,
      motivo TEXT,
      observacoes TEXT,
      dataRegistro TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (funcionarioId) REFERENCES funcionarios(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_atest_func ON funcionarios_atestados(funcionarioId, dataInicio);
  `);
}

function diffHoras(hi, hf) {
  if (!hi || !hf) return 0;
  const [h1, m1] = hi.split(':').map(Number);
  const [h2, m2] = hf.split(':').map(Number);
  return ((h2 * 60 + m2) - (h1 * 60 + m1)) / 60;
}

function calcularHorasTrabalhadas(p) {
  let h = diffHoras(p.horaEntrada, p.horaSaida);
  if (p.horaSaidaAlmoco && p.horaVoltaAlmoco) h -= diffHoras(p.horaSaidaAlmoco, p.horaVoltaAlmoco);
  return Math.max(0, h);
}

function diasEntreDatas(ini, fim) {
  if (!ini || !fim) return 0;
  return Math.round((new Date(fim) - new Date(ini)) / 86400000) + 1;
}

function registrarRotasRH(app, db) {
  migrarDB(db);

  // ==================== FUNCIONÁRIOS ====================

  app.get('/api/funcionarios', (req, res) => {
    try {
      const { q, ativo } = req.query;
      let sql = 'SELECT * FROM funcionarios WHERE 1=1';
      const params = [];
      if (ativo !== undefined) { sql += ' AND ativo = ?'; params.push(Number(ativo)); }
      else                     { sql += ' AND ativo = 1'; }
      if (q) { sql += ' AND (nome LIKE ? OR cpf LIKE ? OR cargo LIKE ?)'; const like=`%${q}%`; params.push(like, like, like); }
      sql += ' ORDER BY nome LIMIT 500';
      const funcionarios = db.prepare(sql).all(...params);
      const kpis = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN ativo = 1 THEN 1 ELSE 0 END) AS ativos,
          SUM(CASE WHEN ativo = 1 THEN salario ELSE 0 END) AS folhaTotal
        FROM funcionarios
      `).get();
      res.json({ success: true, funcionarios, kpis, tiposContrato: TIPOS_CONTRATO });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/funcionarios/:id', (req, res) => {
    try {
      const f = db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(req.params.id);
      if (!f) return res.status(404).json({ success: false, error: 'Funcionário não encontrado' });
      res.json({ success: true, funcionario: f });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/funcionarios', (req, res) => {
    try {
      const b = req.body;
      if (!b.nome || !b.dataAdmissao) return res.status(400).json({ success: false, error: 'nome e dataAdmissao obrigatórios' });
      if (b.tipoContrato && !TIPOS_CONTRATO.includes(b.tipoContrato)) return res.status(400).json({ success: false, error: 'tipoContrato inválido' });
      const r = db.prepare(`
        INSERT INTO funcionarios (cpf, nome, dataNascimento, dataAdmissao, cargo, departamento, salario, tipoContrato,
                                  jornadaSemanalHoras, email, telefone, endereco, banco, agencia, conta, pix, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(b.cpf || null, b.nome, b.dataNascimento || null, b.dataAdmissao,
              b.cargo || null, b.departamento || null, Number(b.salario) || 0, b.tipoContrato || 'CLT',
              Number(b.jornadaSemanalHoras) || 44, b.email || null, b.telefone || null, b.endereco || null,
              b.banco || null, b.agencia || null, b.conta || null, b.pix || null, b.observacoes || null);
      logAction(db, req, 'criar', 'funcionario', r.lastInsertRowid, { nome: b.nome, cargo: b.cargo });
      res.json({ success: true, funcionario: db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/funcionarios/:id', (req, res) => {
    try {
      const camposValidos = ['cpf','nome','dataNascimento','cargo','departamento','salario','tipoContrato',
                             'jornadaSemanalHoras','email','telefone','endereco','banco','agencia','conta','pix',
                             'ativo','observacoes','dataDemissao'];
      const sets = [], vals = [];
      for (const c of camposValidos) {
        if (req.body[c] !== undefined) {
          sets.push(`${c} = ?`);
          vals.push(c === 'ativo' ? (req.body[c] ? 1 : 0) : (req.body[c] === '' ? null : req.body[c]));
        }
      }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.id);
      db.prepare(`UPDATE funcionarios SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      logAction(db, req, 'editar', 'funcionario', req.params.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/funcionarios/:id', (req, res) => {
    try {
      const dataDemissao = req.body?.dataDemissao || new Date().toISOString().slice(0, 10);
      db.prepare('UPDATE funcionarios SET ativo = 0, dataDemissao = ? WHERE id = ?').run(dataDemissao, req.params.id);
      logAction(db, req, 'demitir', 'funcionario', req.params.id, { dataDemissao });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== PONTO ====================

  app.get('/api/funcionarios/:id/ponto', (req, res) => {
    try {
      const { mes } = req.query; // YYYY-MM
      let sql = 'SELECT * FROM funcionarios_ponto WHERE funcionarioId = ?';
      const params = [req.params.id];
      if (mes && /^\d{4}-\d{2}$/.test(mes)) { sql += " AND data LIKE ?"; params.push(mes + '-%'); }
      sql += ' ORDER BY data DESC LIMIT 200';
      const ponto = db.prepare(sql).all(...params);
      const totalHoras = ponto.reduce((s, p) => s + (Number(p.horasTrabalhadas) || 0), 0);
      res.json({ success: true, ponto, totalHoras });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/funcionarios/:id/ponto', (req, res) => {
    try {
      const b = req.body;
      if (!b.data) return res.status(400).json({ success: false, error: 'data obrigatória' });
      const horas = calcularHorasTrabalhadas(b);
      const r = db.prepare(`
        INSERT OR REPLACE INTO funcionarios_ponto (funcionarioId, data, horaEntrada, horaSaidaAlmoco, horaVoltaAlmoco, horaSaida, horasTrabalhadas, observacoes, tipo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.id, b.data, b.horaEntrada || null, b.horaSaidaAlmoco || null, b.horaVoltaAlmoco || null,
              b.horaSaida || null, horas, b.observacoes || null, b.tipo || 'normal');
      logAction(db, req, 'registrar-ponto', 'funcionario', req.params.id, { data: b.data, horas });
      res.json({ success: true, ponto: db.prepare('SELECT * FROM funcionarios_ponto WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/funcionarios/ponto/:pontoId', (req, res) => {
    try {
      db.prepare('DELETE FROM funcionarios_ponto WHERE id = ?').run(req.params.pontoId);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== FÉRIAS ====================

  app.get('/api/funcionarios/:id/ferias', (req, res) => {
    try {
      const ferias = db.prepare('SELECT * FROM funcionarios_ferias WHERE funcionarioId = ? ORDER BY periodoAquisitivoIni DESC').all(req.params.id);
      res.json({ success: true, ferias, status: STATUS_FERIAS });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/funcionarios/:id/ferias', (req, res) => {
    try {
      const b = req.body;
      if (!b.periodoAquisitivoIni || !b.periodoAquisitivoFim) {
        return res.status(400).json({ success: false, error: 'período aquisitivo obrigatório' });
      }
      const dias = b.dias || (b.dataInicio && b.dataFim ? diasEntreDatas(b.dataInicio, b.dataFim) : 30);
      const r = db.prepare(`
        INSERT INTO funcionarios_ferias (funcionarioId, periodoAquisitivoIni, periodoAquisitivoFim, dataInicio, dataFim, dias, status, diasAbono, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.id, b.periodoAquisitivoIni, b.periodoAquisitivoFim,
              b.dataInicio || null, b.dataFim || null, dias,
              b.status || 'planejada', Number(b.diasAbono) || 0, b.observacoes || null);
      logAction(db, req, 'criar-ferias', 'funcionario', req.params.id, { dias, periodo: b.periodoAquisitivoIni });
      res.json({ success: true, ferias: db.prepare('SELECT * FROM funcionarios_ferias WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/funcionarios/ferias/:feriasId', (req, res) => {
    try {
      const camposValidos = ['dataInicio','dataFim','dias','status','diasAbono','observacoes','periodoAquisitivoIni','periodoAquisitivoFim'];
      const sets = [], vals = [];
      for (const c of camposValidos) {
        if (req.body[c] !== undefined) {
          if (c === 'status' && !STATUS_FERIAS.includes(req.body[c])) return res.status(400).json({ success: false, error: 'status inválido' });
          sets.push(`${c} = ?`); vals.push(req.body[c] === '' ? null : req.body[c]);
        }
      }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.feriasId);
      db.prepare(`UPDATE funcionarios_ferias SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/funcionarios/ferias/:feriasId', (req, res) => {
    try {
      db.prepare('DELETE FROM funcionarios_ferias WHERE id = ?').run(req.params.feriasId);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ATESTADOS ====================

  app.get('/api/funcionarios/:id/atestados', (req, res) => {
    try {
      const atestados = db.prepare('SELECT * FROM funcionarios_atestados WHERE funcionarioId = ? ORDER BY dataInicio DESC').all(req.params.id);
      res.json({ success: true, atestados });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/funcionarios/:id/atestados', (req, res) => {
    try {
      const b = req.body;
      if (!b.dataInicio || !b.dataFim) return res.status(400).json({ success: false, error: 'dataInicio e dataFim obrigatórios' });
      const dias = diasEntreDatas(b.dataInicio, b.dataFim);
      const r = db.prepare(`
        INSERT INTO funcionarios_atestados (funcionarioId, dataInicio, dataFim, dias, cid, profissionalSaude, crm, motivo, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.id, b.dataInicio, b.dataFim, dias,
              b.cid || null, b.profissionalSaude || null, b.crm || null, b.motivo || null, b.observacoes || null);
      logAction(db, req, 'criar-atestado', 'funcionario', req.params.id, { dias, cid: b.cid });
      res.json({ success: true, atestado: db.prepare('SELECT * FROM funcionarios_atestados WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/funcionarios/atestados/:atestadoId', (req, res) => {
    try {
      db.prepare('DELETE FROM funcionarios_atestados WHERE id = ?').run(req.params.atestadoId);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasRH };
