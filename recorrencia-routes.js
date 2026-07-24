/**
 * recorrencia-routes.js — CRUD recorrencias NFSe + SMTP config + execucao manual
 */

const { executarRecorrencias, executarUmaRecorrencia } = require('./recorrencia-scheduler');
const { loadSmtpConfig, enviarEmailTeste, enviarEmailNfse } = require('./email-client');
const { carregarCertificado, dataBrasilia } = require('./nfse-routes');
const { NfseClient } = require('./nfse-client');

function migrarRecorrencias(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfse_recorrencias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pessoaId INTEGER NOT NULL,
      ativo INTEGER DEFAULT 1,
      gerarBoleto INTEGER DEFAULT 0,
      enviarEmail INTEGER DEFAULT 0,
      diaVencimentoBoleto INTEGER DEFAULT 10,
      codigoTributacaoNacional TEXT NOT NULL,
      codigoListaServico TEXT,
      descricao TEXT NOT NULL,
      valorServico REAL NOT NULL,
      valorDeducoes REAL,
      aliquota REAL,
      codigoMunicipioPrestacao TEXT,
      opSimpNac INTEGER DEFAULT 3,
      regEspTrib INTEGER DEFAULT 0,
      pTotTribSN REAL,
      incluirIM INTEGER DEFAULT 1,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pessoaId) REFERENCES pessoas(id)
    );

    CREATE TABLE IF NOT EXISTS nfse_recorrencias_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorrenciaId INTEGER NOT NULL,
      competencia TEXT NOT NULL,
      nfseId INTEGER,
      contaReceberId INTEGER,
      boletoId INTEGER,
      emailEnviado TEXT DEFAULT 'nao',
      status TEXT DEFAULT 'processando',
      erro TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (recorrenciaId) REFERENCES nfse_recorrencias(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_recorrencia_competencia
      ON nfse_recorrencias_log(recorrenciaId, competencia);

    CREATE TABLE IF NOT EXISTS smtp_config (key TEXT PRIMARY KEY, value TEXT);
  `);

  // Defaults SMTP
  const ins = db.prepare('INSERT OR IGNORE INTO smtp_config (key, value) VALUES (?, ?)');
  ins.run('host', '');
  ins.run('port', '587');
  ins.run('secure', '0');
  ins.run('user', '');
  ins.run('pass', '');
  ins.run('fromName', '');
  ins.run('fromEmail', '');

  console.log('[Recorrencia] Tabelas verificadas/criadas');
}

function registrarRotasRecorrencia(app, db) {
  migrarRecorrencias(db);

  // ==================== ROTAS LITERAIS PRIMEIRO (antes de :id) ====================

  // GET /api/recorrencias — lista com JOIN pessoa + ultima emissao
  app.get('/api/recorrencias', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT r.*, p.razaoSocial as pessoaNome, p.cpfCnpj as pessoaCpfCnpj, p.email as pessoaEmail,
          (SELECT competencia FROM nfse_recorrencias_log WHERE recorrenciaId = r.id AND status = 'sucesso' ORDER BY competencia DESC LIMIT 1) as ultimaEmissao,
          (SELECT status FROM nfse_recorrencias_log WHERE recorrenciaId = r.id ORDER BY id DESC LIMIT 1) as ultimoStatus
        FROM nfse_recorrencias r
        JOIN pessoas p ON p.id = r.pessoaId
        ORDER BY r.ativo DESC, p.razaoSocial
      `).all();
      res.json({ success: true, recorrencias: rows });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/recorrencias/log — log global recente (ANTES de /:id!)
  app.get('/api/recorrencias/log', (req, res) => {
    try {
      const { competencia, status, limite } = req.query;
      const lim = Math.min(parseInt(limite) || 50, 200);

      let sql = `
        SELECT l.*, r.descricao as recDescricao, r.valorServico as recValor,
          p.razaoSocial as pessoaNome, p.cpfCnpj as pessoaCpfCnpj,
          n.nNFSe, n.chaveAcesso
        FROM nfse_recorrencias_log l
        JOIN nfse_recorrencias r ON r.id = l.recorrenciaId
        JOIN pessoas p ON p.id = r.pessoaId
        LEFT JOIN nfse n ON n.id = l.nfseId
        WHERE 1=1
      `;
      const params = [];

      if (competencia) {
        sql += ' AND l.competencia = ?';
        params.push(competencia);
      }
      if (status) {
        sql += ' AND l.status = ?';
        params.push(status);
      }

      sql += ' ORDER BY l.id DESC LIMIT ?';
      params.push(lim);

      const logs = db.prepare(sql).all(...params);
      res.json({ success: true, logs });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/recorrencias/executar — executar todas do mes atual
  app.post('/api/recorrencias/executar', async (req, res) => {
    try {
      await executarRecorrencias(db);
      res.json({ success: true, message: 'Execucao concluida' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/recorrencias/log/:id/reenviar-email
  app.post('/api/recorrencias/log/:id/reenviar-email', async (req, res) => {
    try {
      const log = db.prepare(`
        SELECT l.*, r.descricao, r.valorServico, r.enviarEmail,
          p.email, p.emailsAdicionais, n.nNFSe, n.chaveAcesso, n.tpAmb
        FROM nfse_recorrencias_log l
        JOIN nfse_recorrencias r ON r.id = l.recorrenciaId
        JOIN pessoas p ON p.id = r.pessoaId
        LEFT JOIN nfse n ON n.id = l.nfseId
        WHERE l.id = ?
      `).get(req.params.id);

      if (!log) return res.status(404).json({ success: false, error: 'Log nao encontrado' });
      if (!log.email) return res.status(400).json({ success: false, error: 'Pessoa sem email cadastrado' });
      if (!log.nfseId) return res.status(400).json({ success: false, error: 'Log sem NFSe associada' });

      let pdfBuffer = null;
      if (log.chaveAcesso) {
        try {
          const { p12Buffer, senha } = carregarCertificado(db);
          const client = new NfseClient(p12Buffer, senha, log.tpAmb);
          pdfBuffer = await client.downloadDanfse(log.chaveAcesso);
        } catch (pdfErr) {
          console.error('[Recorrencia] Erro DANFSE reenvio:', pdfErr.message);
        }
      }

      let boletoWritableLine = null;
      let boletoUrl = null;
      if (log.boletoId) {
        const boleto = db.prepare('SELECT writableLine, externalUrl FROM boletos WHERE id = ?').get(log.boletoId);
        boletoWritableLine = boleto?.writableLine || null;
        boletoUrl = boleto?.externalUrl || null;
      }

      const ccList = log.emailsAdicionais
        ? log.emailsAdicionais.split(',').map(e => e.trim()).filter(Boolean)
        : [];

      await enviarEmailNfse(db, {
        to: log.email,
        cc: ccList.length ? ccList.join(', ') : undefined,
        nfseNumero: log.nNFSe || '',
        descricao: log.descricao,
        valor: log.valorServico,
        competencia: log.competencia,
        pdfBuffer,
        boletoWritableLine,
        boletoUrl,
      });

      db.prepare('UPDATE nfse_recorrencias_log SET emailEnviado = ? WHERE id = ?')
        .run(pdfBuffer ? 'sim' : 'pdf_indisponivel', log.id);

      res.json({ success: true, message: 'Email reenviado' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== ROTAS COM :id ====================

  // POST /api/recorrencias — criar
  app.post('/api/recorrencias', (req, res) => {
    try {
      const b = req.body;
      if (!b.pessoaId || !b.codigoTributacaoNacional || !b.descricao || !b.valorServico) {
        return res.status(400).json({ success: false, error: 'Campos obrigatorios: pessoaId, codigoTributacaoNacional, descricao, valorServico' });
      }

      const pessoa = db.prepare('SELECT id FROM pessoas WHERE id = ? AND ativo = 1').get(b.pessoaId);
      if (!pessoa) return res.status(400).json({ success: false, error: 'Pessoa nao encontrada ou inativa' });

      const id = db.prepare(`
        INSERT INTO nfse_recorrencias (pessoaId, ativo, gerarBoleto, enviarEmail, diaVencimentoBoleto,
          codigoTributacaoNacional, codigoListaServico, descricao, valorServico, valorDeducoes,
          aliquota, codigoMunicipioPrestacao, opSimpNac, regEspTrib, pTotTribSN, incluirIM, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        b.pessoaId,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : 1,
        b.gerarBoleto ? 1 : 0,
        b.enviarEmail ? 1 : 0,
        b.diaVencimentoBoleto || 10,
        b.codigoTributacaoNacional,
        b.codigoListaServico || null,
        b.descricao,
        b.valorServico,
        b.valorDeducoes || null,
        b.aliquota || null,
        b.codigoMunicipioPrestacao || null,
        b.opSimpNac || 3,
        b.regEspTrib || 0,
        b.pTotTribSN ?? 6.00,
        b.incluirIM !== undefined ? (b.incluirIM ? 1 : 0) : 1,
        b.observacoes || null
      ).lastInsertRowid;

      res.json({ success: true, id, message: 'Recorrencia criada' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/recorrencias/:id — detalhe + log
  app.get('/api/recorrencias/:id', (req, res) => {
    try {
      const rec = db.prepare(`
        SELECT r.*, p.razaoSocial as pessoaNome, p.cpfCnpj as pessoaCpfCnpj, p.email as pessoaEmail
        FROM nfse_recorrencias r
        JOIN pessoas p ON p.id = r.pessoaId
        WHERE r.id = ?
      `).get(req.params.id);

      if (!rec) return res.status(404).json({ success: false, error: 'Recorrencia nao encontrada' });

      const logs = db.prepare(`
        SELECT l.*, n.nNFSe, n.chaveAcesso, n.status as nfseStatus
        FROM nfse_recorrencias_log l
        LEFT JOIN nfse n ON n.id = l.nfseId
        WHERE l.recorrenciaId = ?
        ORDER BY l.competencia DESC
        LIMIT 24
      `).all(req.params.id);

      // Integração (4): retorna contrato vinculado (se houver) para o
      // front mostrar "vinculada ao contrato #X" e link cruzado.
      let contrato = null;
      try {
        contrato = db.prepare(
          'SELECT id, numero, status, valorMensal, dataInicio, dataFim FROM contratos WHERE recorrenciaNfseId = ? LIMIT 1'
        ).get(req.params.id) || null;
      } catch (_) { /* tabela contratos pode não existir em instalações antigas */ }

      res.json({ success: true, recorrencia: rec, logs, contrato });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // PUT /api/recorrencias/:id — atualizar
  app.put('/api/recorrencias/:id', (req, res) => {
    try {
      const exists = db.prepare('SELECT id FROM nfse_recorrencias WHERE id = ?').get(req.params.id);
      if (!exists) return res.status(404).json({ success: false, error: 'Recorrencia nao encontrada' });

      const b = req.body;
      db.prepare(`
        UPDATE nfse_recorrencias SET
          pessoaId = COALESCE(?, pessoaId),
          ativo = COALESCE(?, ativo),
          gerarBoleto = COALESCE(?, gerarBoleto),
          enviarEmail = COALESCE(?, enviarEmail),
          diaVencimentoBoleto = COALESCE(?, diaVencimentoBoleto),
          codigoTributacaoNacional = COALESCE(?, codigoTributacaoNacional),
          codigoListaServico = COALESCE(?, codigoListaServico),
          descricao = COALESCE(?, descricao),
          valorServico = COALESCE(?, valorServico),
          valorDeducoes = COALESCE(?, valorDeducoes),
          aliquota = COALESCE(?, aliquota),
          codigoMunicipioPrestacao = COALESCE(?, codigoMunicipioPrestacao),
          opSimpNac = COALESCE(?, opSimpNac),
          regEspTrib = COALESCE(?, regEspTrib),
          pTotTribSN = COALESCE(?, pTotTribSN),
          incluirIM = COALESCE(?, incluirIM),
          observacoes = COALESCE(?, observacoes),
          dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        b.pessoaId || null,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : null,
        b.gerarBoleto !== undefined ? (b.gerarBoleto ? 1 : 0) : null,
        b.enviarEmail !== undefined ? (b.enviarEmail ? 1 : 0) : null,
        b.diaVencimentoBoleto || null,
        b.codigoTributacaoNacional || null,
        b.codigoListaServico !== undefined ? (b.codigoListaServico || null) : null,
        b.descricao || null,
        b.valorServico || null,
        b.valorDeducoes !== undefined ? (b.valorDeducoes || null) : null,
        b.aliquota !== undefined ? (b.aliquota || null) : null,
        b.codigoMunicipioPrestacao !== undefined ? (b.codigoMunicipioPrestacao || null) : null,
        b.opSimpNac || null,
        b.regEspTrib !== undefined ? (b.regEspTrib ?? null) : null,
        b.pTotTribSN !== undefined ? (b.pTotTribSN || null) : null,
        b.incluirIM !== undefined ? (b.incluirIM ? 1 : 0) : null,
        b.observacoes !== undefined ? (b.observacoes || null) : null,
        req.params.id
      );

      res.json({ success: true, message: 'Recorrencia atualizada' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // DELETE /api/recorrencias/:id — desativar (soft delete)
  app.delete('/api/recorrencias/:id', (req, res) => {
    try {
      const result = db.prepare('UPDATE nfse_recorrencias SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
        .run(req.params.id);
      if (!result.changes) return res.status(404).json({ success: false, error: 'Recorrencia nao encontrada' });
      res.json({ success: true, message: 'Recorrencia desativada' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/recorrencias/:id/executar — executar uma especifica
  app.post('/api/recorrencias/:id/executar', async (req, res) => {
    try {
      const competencia = req.body.competencia || dataBrasilia().substring(0, 7);

      const rec = db.prepare(`
        SELECT r.*, p.cpfCnpj, p.razaoSocial, p.inscricaoMunicipal, p.email,
          p.endereco, p.numero, p.complemento, p.bairro, p.codigoMunicipio, p.uf, p.cep
        FROM nfse_recorrencias r
        JOIN pessoas p ON p.id = r.pessoaId
        WHERE r.id = ?
      `).get(req.params.id);

      if (!rec) return res.status(404).json({ success: false, error: 'Recorrencia nao encontrada' });

      const resultado = await executarUmaRecorrencia(db, rec, competencia);
      res.json({ success: true, message: 'Execucao concluida', resultado });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== SMTP CONFIG ====================

  app.get('/api/smtp/config', (req, res) => {
    try {
      const rows = db.prepare('SELECT key, value FROM smtp_config').all();
      const cfg = {};
      for (const r of rows) {
        cfg[r.key] = r.key === 'pass' ? (r.value ? '********' : '') : r.value;
      }
      res.json({ success: true, config: cfg });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/smtp/config', (req, res) => {
    try {
      const b = req.body;
      const upsert = db.prepare('INSERT OR REPLACE INTO smtp_config (key, value) VALUES (?, ?)');

      if (b.host !== undefined) upsert.run('host', b.host);
      if (b.port !== undefined) upsert.run('port', String(b.port));
      if (b.secure !== undefined) upsert.run('secure', b.secure ? '1' : '0');
      if (b.user !== undefined) upsert.run('user', b.user);
      if (b.pass !== undefined && b.pass !== '********') upsert.run('pass', b.pass);
      if (b.fromName !== undefined) upsert.run('fromName', b.fromName);
      if (b.fromEmail !== undefined) upsert.run('fromEmail', b.fromEmail);

      res.json({ success: true, message: 'Configuracao SMTP salva' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/smtp/testar', async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ success: false, error: 'Email obrigatorio' });

      await enviarEmailTeste(db, email);
      res.json({ success: true, message: `Email teste enviado para ${email}` });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== LOG DE EMAILS ====================

  app.get('/api/emails/log', (req, res) => {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS email_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT NOT NULL DEFAULT 'nfse',
        destinatario TEXT NOT NULL,
        assunto TEXT,
        nfseNumero TEXT,
        descricao TEXT,
        valor REAL,
        competencia TEXT,
        temPdf INTEGER DEFAULT 0,
        temBoleto INTEGER DEFAULT 0,
        messageId TEXT,
        status TEXT NOT NULL DEFAULT 'enviado',
        erro TEXT,
        dataEnvio TEXT DEFAULT (datetime('now'))
      )`);

      const limit = parseInt(req.query.limit) || 100;
      const { busca, tipo, status, dataInicio, dataFim } = req.query;
      const where = [];
      const params = [];
      if (busca) {
        where.push('(destinatario LIKE ? OR nfseNumero LIKE ? OR descricao LIKE ? OR assunto LIKE ?)');
        const term = `%${busca}%`;
        params.push(term, term, term, term);
      }
      if (tipo) { where.push('tipo = ?'); params.push(tipo); }
      if (status) { where.push('status = ?'); params.push(status); }
      if (dataInicio) { where.push('dataEnvio >= ?'); params.push(dataInicio + ' 00:00:00'); }
      if (dataFim) { where.push('dataEnvio <= ?'); params.push(dataFim + ' 23:59:59'); }
      const sql = `SELECT * FROM email_log${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY dataEnvio DESC LIMIT ?`;
      params.push(limit);
      const logs = db.prepare(sql).all(...params);
      res.json({ success: true, logs });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[Recorrencia] Rotas registradas');
}

module.exports = { registrarRotasRecorrencia };
