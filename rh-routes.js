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
const clt = require('./rh-clt');

// Erro bloqueia a gravação; aviso vai junto na resposta para a tela mostrar.
// Separar os dois evita o vício de barrar o que a convenção coletiva permite.
function separar(problemas) {
  return {
    erros: problemas.filter((p) => p.nivel === 'erro'),
    avisos: problemas.filter((p) => p.nivel === 'aviso'),
  };
}

// O piso muda todo ano e varia por categoria: fica em config, e sem ele a
// regra de salário simplesmente não roda.
function salarioMinimoConfigurado(db) {
  try {
    const r = db.prepare("SELECT value FROM config WHERE key = 'rh_salario_minimo'").get();
    return r && Number(r.value) > 0 ? Number(r.value) : 0;
  } catch { return 0; }
}

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

// Delegado ao motor CLT, que trata virada de meia-noite: a conta antiga dava
// ZERO hora para quem entrava às 22h e saía às 6h, sem avisar nada.
const calcularHorasTrabalhadas = (p) => clt.calcularHoras(p);

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

      // O passivo de férias é o número que muda decisão; folha bruta sozinha
      // não diz se a empresa está acumulando dias em dobro.
      let alertas = null;
      try { alertas = clt.alertasRH(db); } catch (e) { console.warn('[RH] alertas:', e.message); }
      if (alertas) {
        kpis.feriasVencidas = alertas.feriasVencidas.length;
        kpis.passivoFeriasEstimado = alertas.passivoFeriasEstimado;
      }

      res.json({ success: true, funcionarios, kpis, alertas, tiposContrato: TIPOS_CONTRATO });
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

      const { erros, avisos } = separar(
        clt.validarFuncionario(db, b, { salarioMinimo: salarioMinimoConfigurado(db) }));
      if (erros.length) return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });

      const r = db.prepare(`
        INSERT INTO funcionarios (cpf, nome, dataNascimento, dataAdmissao, cargo, departamento, salario, tipoContrato,
                                  jornadaSemanalHoras, email, telefone, endereco, banco, agencia, conta, pix, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(b.cpf || null, b.nome, b.dataNascimento || null, b.dataAdmissao,
              b.cargo || null, b.departamento || null, Number(b.salario) || 0, b.tipoContrato || 'CLT',
              Number(b.jornadaSemanalHoras) || 44, b.email || null, b.telefone || null, b.endereco || null,
              b.banco || null, b.agencia || null, b.conta || null, b.pix || null, b.observacoes || null);
      logAction(db, req, 'criar', 'funcionario', r.lastInsertRowid, { nome: b.nome, cargo: b.cargo });
      res.json({ success: true, avisos,
        funcionario: db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/funcionarios/:id', (req, res) => {
    try {
      // dataAdmissao faltava na lista: uma admissão digitada errada era
      // impossível de corrigir pela tela, e ela é a base do cálculo de férias.
      const camposValidos = ['cpf','nome','dataNascimento','dataAdmissao','cargo','departamento','salario','tipoContrato',
                             'jornadaSemanalHoras','email','telefone','endereco','banco','agencia','conta','pix',
                             'ativo','observacoes','dataDemissao'];

      const atual = db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Funcionário não encontrado' });

      // Valida o estado final, não o pedaço enviado: quem muda só a jornada
      // ainda assim tem que resultar num cadastro coerente.
      const final = { ...atual, ...req.body };
      const { erros, avisos } = separar(
        clt.validarFuncionario(db, final, { id: Number(req.params.id), salarioMinimo: salarioMinimoConfigurado(db) }));
      if (erros.length) return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });

      // Data de demissão preenchida com o funcionário marcado como ativo era um
      // estado que a tela mostrava como "trabalhando" e a folha não pagava.
      if (final.dataDemissao && Number(final.ativo) === 1 && req.body.ativo === undefined) {
        avisos.push({ nivel: 'aviso', codigo: 'demitido_ainda_ativo',
          mensagem: 'Data de demissão preenchida mas o funcionário continua ativo — use a ação de desligamento' });
      }

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
      res.json({ success: true, avisos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/funcionarios/:id', (req, res) => {
    try {
      const dataDemissao = req.body?.dataDemissao || new Date().toISOString().slice(0, 10);
      const f = db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(req.params.id);
      if (!f) return res.status(404).json({ success: false, error: 'Funcionário não encontrado' });
      if (dataDemissao < f.dataAdmissao) {
        return res.status(400).json({ success: false, error: 'Data de demissão anterior à admissão' });
      }

      // Desligar sem saber o que é devido é como a empresa descobre o passivo
      // na audiência. Férias não gozadas são indenizadas na rescisão, e as
      // vencidas saem em dobro (CLT art. 137 e 146).
      const situacao = clt.situacaoFerias(db, Number(req.params.id), { hoje: dataDemissao });
      const rescisao = situacao ? {
        diasFeriasAIndenizar: situacao.saldoTotal,
        diasEmDobro: situacao.diasEmDobro,
        custoDobroEstimado: situacao.custoDobroEstimado,
      } : null;

      db.prepare('UPDATE funcionarios SET ativo = 0, dataDemissao = ? WHERE id = ?').run(dataDemissao, req.params.id);
      logAction(db, req, 'demitir', 'funcionario', req.params.id, { dataDemissao, rescisao });
      res.json({ success: true, rescisao });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== INTELIGÊNCIA ====================

  // Situação de férias calculada da admissão: períodos aquisitivos, saldo,
  // vencimento e o que já virou passivo em dobro.
  app.get('/api/funcionarios/:id/ferias/situacao', (req, res) => {
    try {
      const s = clt.situacaoFerias(db, Number(req.params.id));
      if (!s) return res.status(404).json({ success: false, error: 'Funcionário não encontrado' });
      res.json({ success: true, situacao: s });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Simula sem gravar — a tela pode avisar antes de o usuário clicar em salvar.
  app.post('/api/funcionarios/:id/ferias/validar', (req, res) => {
    try {
      const problemas = clt.validarFerias(db, Number(req.params.id), req.body || {});
      res.json({ success: true, ...separar(problemas) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/rh/alertas', (req, res) => {
    try {
      res.json({ success: true, alertas: clt.alertasRH(db) });
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

      const { erros, avisos } = separar(clt.validarPonto(db, Number(req.params.id), b));
      if (erros.length && !b.forcar) {
        return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });
      }

      const horas = calcularHorasTrabalhadas(b);
      const r = db.prepare(`
        INSERT OR REPLACE INTO funcionarios_ponto (funcionarioId, data, horaEntrada, horaSaidaAlmoco, horaVoltaAlmoco, horaSaida, horasTrabalhadas, observacoes, tipo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.id, b.data, b.horaEntrada || null, b.horaSaidaAlmoco || null, b.horaVoltaAlmoco || null,
              b.horaSaida || null, horas, b.observacoes || null, b.tipo || 'normal');
      logAction(db, req, 'registrar-ponto', 'funcionario', req.params.id, { data: b.data, horas });
      res.json({ success: true, avisos,
        ponto: db.prepare('SELECT * FROM funcionarios_ponto WHERE id = ?').get(r.lastInsertRowid) });
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

      const { erros, avisos } = separar(
        clt.validarFerias(db, Number(req.params.id), { ...b, dias }));
      if (erros.length) return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });

      const r = db.prepare(`
        INSERT INTO funcionarios_ferias (funcionarioId, periodoAquisitivoIni, periodoAquisitivoFim, dataInicio, dataFim, dias, status, diasAbono, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.id, b.periodoAquisitivoIni, b.periodoAquisitivoFim,
              b.dataInicio || null, b.dataFim || null, dias,
              b.status || 'planejada', Number(b.diasAbono) || 0, b.observacoes || null);
      logAction(db, req, 'criar-ferias', 'funcionario', req.params.id, { dias, periodo: b.periodoAquisitivoIni });
      res.json({ success: true, avisos,
        ferias: db.prepare('SELECT * FROM funcionarios_ferias WHERE id = ?').get(r.lastInsertRowid) });
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

      const { erros, avisos } = separar(clt.validarAtestado(db, Number(req.params.id), b));
      if (erros.length) return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });
      const dias = diasEntreDatas(b.dataInicio, b.dataFim);
      const r = db.prepare(`
        INSERT INTO funcionarios_atestados (funcionarioId, dataInicio, dataFim, dias, cid, profissionalSaude, crm, motivo, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.id, b.dataInicio, b.dataFim, dias,
              b.cid || null, b.profissionalSaude || null, b.crm || null, b.motivo || null, b.observacoes || null);
      logAction(db, req, 'criar-atestado', 'funcionario', req.params.id, { dias, cid: b.cid });
      res.json({ success: true, avisos,
        atestado: db.prepare('SELECT * FROM funcionarios_atestados WHERE id = ?').get(r.lastInsertRowid) });
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
