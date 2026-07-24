/**
 * contratos-routes.js — Contratos com clientes (vigência, renovação, reajuste).
 *
 * Modelo:
 *   contratos        — cabeçalho (cliente, valor mensal, vigência, renovação, reajuste, status)
 *   contratos_eventos — histórico (criação/renovação/reajuste/suspensão/encerramento/aditivo)
 *
 * Status: ativo | suspenso | encerrado | em-renovacao
 */

const { logAction } = require('./audit-log');

const STATUS = ['ativo', 'suspenso', 'encerrado', 'em-renovacao'];
const TIPOS_EVENTO = ['criacao', 'renovacao', 'reajuste', 'suspensao', 'reativacao', 'encerramento', 'aditivo'];

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contratos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      clienteId INTEGER NOT NULL,
      descricao TEXT NOT NULL,
      valorMensal REAL NOT NULL,
      diaVencimento INTEGER DEFAULT 10,
      dataInicio TEXT NOT NULL,
      dataFim TEXT,
      renovacaoAutomatica INTEGER DEFAULT 1,
      prazoRenovacaoMeses INTEGER DEFAULT 12,
      indiceReajuste TEXT,
      percentualReajuste REAL,
      dataProximoReajuste TEXT,
      recorrenciaNfseId INTEGER,
      status TEXT NOT NULL DEFAULT 'ativo',
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (clienteId) REFERENCES pessoas(id),
      FOREIGN KEY (recorrenciaNfseId) REFERENCES nfse_recorrencias(id)
    );
    CREATE INDEX IF NOT EXISTS idx_contratos_cliente ON contratos(clienteId);
    CREATE INDEX IF NOT EXISTS idx_contratos_status ON contratos(status, dataFim);

    CREATE TABLE IF NOT EXISTS contratos_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contratoId INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      descricao TEXT,
      valorAntes REAL,
      valorDepois REAL,
      dataFimAntes TEXT,
      dataFimDepois TEXT,
      usuario TEXT,
      FOREIGN KEY (contratoId) REFERENCES contratos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_eventos_contrato ON contratos_eventos(contratoId, data);
  `);
}

function gerarNumero(db) {
  const ano = new Date().getFullYear();
  const prefixo = `CT-${ano}-`;
  const ultimo = db.prepare(`SELECT numero FROM contratos WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(prefixo + '%');
  let n = 1;
  if (ultimo) {
    const m = ultimo.numero.match(/-(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return prefixo + String(n).padStart(4, '0');
}

function addMeses(dataIso, meses) {
  if (!dataIso) return null;
  const [y, m, d] = dataIso.split('-').map(Number);
  const novaData = new Date(y, m - 1 + meses, d);
  return novaData.toISOString().slice(0, 10);
}

function registrarRotasContratos(app, db) {
  migrarDB(db);

  // ==================== LISTAGEM ====================

  app.get('/api/contratos', (req, res) => {
    try {
      const { clienteId, status, q, limit } = req.query;
      let sql = `
        SELECT c.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj
        FROM contratos c
        JOIN pessoas p ON p.id = c.clienteId
        WHERE 1=1
      `;
      const params = [];
      if (clienteId) { sql += ' AND c.clienteId = ?'; params.push(Number(clienteId)); }
      if (status)    { sql += ' AND c.status = ?';    params.push(status); }
      if (q) { sql += ' AND (c.numero LIKE ? OR c.descricao LIKE ? OR p.razaoSocial LIKE ?)'; const like = `%${q}%`; params.push(like, like, like); }
      sql += ' ORDER BY c.id DESC LIMIT ?';
      params.push(Number(limit) || 200);
      const contratos = db.prepare(sql).all(...params);
      // KPIs
      const totais = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='ativo' THEN 1 ELSE 0 END) AS ativos,
          SUM(CASE WHEN status='ativo' THEN valorMensal ELSE 0 END) AS receitaMensalRecorrente,
          SUM(CASE WHEN status='ativo' AND dataFim IS NOT NULL AND date(dataFim) <= date('now', '+30 days') THEN 1 ELSE 0 END) AS vencendo30d
        FROM contratos
      `).get();
      res.json({ success: true, contratos, kpis: totais, status: STATUS });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Detalhe + eventos
  app.get('/api/contratos/:id', (req, res) => {
    try {
      const c = db.prepare(`
        SELECT c.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj
        FROM contratos c
        JOIN pessoas p ON p.id = c.clienteId
        WHERE c.id = ?
      `).get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Contrato não encontrado' });
      const eventos = db.prepare('SELECT * FROM contratos_eventos WHERE contratoId = ? ORDER BY data DESC, id DESC').all(c.id);
      // Integração (4): retorna a recorrência vinculada para o front
      // mostrar bloco "Faturamento" sem fazer 2ª chamada.
      let recorrencia = null;
      if (c.recorrenciaNfseId) {
        try {
          recorrencia = db.prepare(`
            SELECT r.*,
              (SELECT MAX(dataEmissao) FROM nfse_recorrencias_log WHERE recorrenciaId = r.id) AS ultimaEmissao,
              (SELECT COUNT(*) FROM nfse_recorrencias_log WHERE recorrenciaId = r.id AND status = 'emitida') AS totalEmissoes
            FROM nfse_recorrencias r WHERE r.id = ?
          `).get(c.recorrenciaNfseId);
        } catch (_) { /* log table pode não existir ainda */ }
      }
      res.json({ success: true, contrato: c, eventos, recorrencia });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Vencendo (alerta)
  app.get('/api/contratos/alerta/vencendo', (req, res) => {
    try {
      const dias = Number(req.query.dias) || 30;
      const lista = db.prepare(`
        SELECT c.*, p.razaoSocial AS clienteNome
        FROM contratos c
        JOIN pessoas p ON p.id = c.clienteId
        WHERE c.status = 'ativo' AND c.dataFim IS NOT NULL
          AND date(c.dataFim) <= date('now', '+' || ? || ' days')
        ORDER BY c.dataFim
      `).all(dias);
      res.json({ success: true, contratos: lista });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CRIAR ====================

  app.post('/api/contratos', (req, res) => {
    try {
      const { clienteId, descricao, valorMensal, diaVencimento,
              dataInicio, dataFim, renovacaoAutomatica, prazoRenovacaoMeses,
              indiceReajuste, percentualReajuste, dataProximoReajuste,
              recorrenciaNfseId, observacoes,
              // Integração recorrência (2026-04-22): quando criarRecorrencia=true,
              // o backend gera um row em nfse_recorrencias vinculado ao contrato.
              // Os campos dentro de recorrencia são opcionais — defaults razoáveis.
              criarRecorrencia, recorrencia } = req.body;
      if (!clienteId || !descricao || valorMensal == null || !dataInicio) {
        return res.status(400).json({ success: false, error: 'clienteId, descricao, valorMensal e dataInicio obrigatórios' });
      }
      if (criarRecorrencia && recorrenciaNfseId) {
        return res.status(400).json({ success: false, error: 'Passe criarRecorrencia OU recorrenciaNfseId, não ambos' });
      }
      const numero = gerarNumero(db);
      const trx = db.transaction(() => {
        let recIdFinal = recorrenciaNfseId || null;

        // 1) Se pediu para criar recorrência junto, cria primeiro (precisa do ID
        //    para referenciar em contratos.recorrenciaNfseId).
        if (criarRecorrencia) {
          const rec = recorrencia || {};
          if (!rec.codigoTributacaoNacional) {
            throw new Error('recorrencia.codigoTributacaoNacional é obrigatório para criar recorrência');
          }
          const insRec = db.prepare(`
            INSERT INTO nfse_recorrencias
              (pessoaId, ativo, gerarBoleto, enviarEmail, diaVencimentoBoleto,
               codigoTributacaoNacional, codigoListaServico, descricao, valorServico,
               valorDeducoes, aliquota, codigoMunicipioPrestacao, opSimpNac, regEspTrib,
               pTotTribSN, incluirIM, observacoes)
            VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            clienteId,
            rec.gerarBoleto ? 1 : 0,
            rec.enviarEmail ? 1 : 0,
            Number(rec.diaVencimentoBoleto || diaVencimento) || 10,
            rec.codigoTributacaoNacional,
            rec.codigoListaServico || null,
            rec.descricao || descricao,
            Number(rec.valorServico != null ? rec.valorServico : valorMensal),
            rec.valorDeducoes != null ? Number(rec.valorDeducoes) : null,
            rec.aliquota != null ? Number(rec.aliquota) : null,
            rec.codigoMunicipioPrestacao || null,
            Number(rec.opSimpNac != null ? rec.opSimpNac : 3),
            Number(rec.regEspTrib || 0),
            rec.pTotTribSN != null ? Number(rec.pTotTribSN) : null,
            rec.incluirIM != null ? (rec.incluirIM ? 1 : 0) : 1,
            rec.observacoes || null,
          );
          recIdFinal = insRec.lastInsertRowid;
        }

        const r = db.prepare(`
          INSERT INTO contratos
            (numero, clienteId, descricao, valorMensal, diaVencimento,
             dataInicio, dataFim, renovacaoAutomatica, prazoRenovacaoMeses,
             indiceReajuste, percentualReajuste, dataProximoReajuste,
             recorrenciaNfseId, observacoes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          numero, clienteId, descricao, Number(valorMensal), Number(diaVencimento) || 10,
          dataInicio, dataFim || null,
          renovacaoAutomatica ? 1 : 0, Number(prazoRenovacaoMeses) || 12,
          indiceReajuste || null, percentualReajuste != null ? Number(percentualReajuste) : null,
          dataProximoReajuste || null,
          recIdFinal, observacoes || null
        );
        const id = r.lastInsertRowid;
        db.prepare(`
          INSERT INTO contratos_eventos (contratoId, tipo, descricao, valorDepois, dataFimDepois, usuario)
          VALUES (?, 'criacao', ?, ?, ?, ?)
        `).run(id, `Contrato ${numero} criado${recIdFinal ? ` (recorrência #${recIdFinal} vinculada)` : ''}`,
               Number(valorMensal), dataFim || null, req.user?.username || null);
        return id;
      });
      const id = trx();
      logAction(db, req, 'criar', 'contrato', id, { numero, clienteId, valorMensal });
      res.json({ success: true, contrato: db.prepare('SELECT * FROM contratos WHERE id = ?').get(id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Editar dados básicos (não muda valor — use reajuste)
  app.put('/api/contratos/:id', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });

      const camposValidos = ['descricao','diaVencimento','dataFim','renovacaoAutomatica','prazoRenovacaoMeses',
                             'indiceReajuste','percentualReajuste','dataProximoReajuste','recorrenciaNfseId','observacoes'];
      const sets = [], vals = [];
      for (const k of camposValidos) {
        if (req.body[k] !== undefined) {
          sets.push(`${k} = ?`);
          vals.push(k === 'renovacaoAutomatica' ? (req.body[k] ? 1 : 0) : (req.body[k] === '' ? null : req.body[k]));
        }
      }
      if (sets.length) {
        sets.push('dataAtualizacao = CURRENT_TIMESTAMP');
        vals.push(c.id);
        db.prepare(`UPDATE contratos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        logAction(db, req, 'editar', 'contrato', c.id, req.body);
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== AÇÕES DE CICLO DE VIDA ====================

  app.post('/api/contratos/:id/renovar', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const meses = Number(req.body?.meses) || c.prazoRenovacaoMeses || 12;
      const baseFim = c.dataFim || c.dataInicio;
      const novaFim = addMeses(baseFim, meses);
      const trx = db.transaction(() => {
        db.prepare(`UPDATE contratos SET dataFim = ?, status = 'ativo', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(novaFim, c.id);
        db.prepare(`
          INSERT INTO contratos_eventos (contratoId, tipo, descricao, dataFimAntes, dataFimDepois, usuario)
          VALUES (?, 'renovacao', ?, ?, ?, ?)
        `).run(c.id, `Renovação por ${meses} meses`, c.dataFim, novaFim, req.user?.username || null);
      });
      trx();
      logAction(db, req, 'renovar', 'contrato', c.id, { meses, dataFim: novaFim });
      res.json({ success: true, dataFim: novaFim });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contratos/:id/reajustar', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const { percentual, novoValor, dataProximoReajuste, descricao } = req.body || {};
      if (percentual == null && novoValor == null) {
        return res.status(400).json({ success: false, error: 'Informe percentual ou novoValor' });
      }
      const valorAntes = c.valorMensal;
      const valorDepois = novoValor != null ? Number(novoValor) : valorAntes * (1 + Number(percentual) / 100);
      const trx = db.transaction(() => {
        db.prepare(`UPDATE contratos SET valorMensal = ?, dataProximoReajuste = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(valorDepois, dataProximoReajuste || null, c.id);
        db.prepare(`
          INSERT INTO contratos_eventos (contratoId, tipo, descricao, valorAntes, valorDepois, usuario)
          VALUES (?, 'reajuste', ?, ?, ?, ?)
        `).run(c.id, descricao || (percentual != null ? `Reajuste de ${percentual}%` : `Reajuste para R$ ${valorDepois.toFixed(2)}`),
                valorAntes, valorDepois, req.user?.username || null);
        // Integração (2): propaga valor para a recorrência vinculada.
        if (c.recorrenciaNfseId) {
          db.prepare(`UPDATE nfse_recorrencias SET valorServico = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(valorDepois, c.recorrenciaNfseId);
        }
      });
      trx();
      logAction(db, req, 'reajustar', 'contrato', c.id, { de: valorAntes, para: valorDepois, percentual, recorrenciaNfseId: c.recorrenciaNfseId });
      res.json({ success: true, valorAnterior: valorAntes, valorNovo: valorDepois, recorrenciaAtualizada: !!c.recorrenciaNfseId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contratos/:id/suspender', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (c.status !== 'ativo') return res.status(400).json({ success: false, error: 'Só contratos ativos podem ser suspensos' });
      const motivo = (req.body?.motivo || '').trim();
      const trx = db.transaction(() => {
        db.prepare(`UPDATE contratos SET status = 'suspenso', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
        db.prepare(`INSERT INTO contratos_eventos (contratoId, tipo, descricao, usuario) VALUES (?, 'suspensao', ?, ?)`)
          .run(c.id, motivo || 'Contrato suspenso', req.user?.username || null);
        // Integração (3): cascateia para a recorrência — para de emitir NFSe.
        if (c.recorrenciaNfseId) {
          db.prepare(`UPDATE nfse_recorrencias SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(c.recorrenciaNfseId);
        }
      });
      trx();
      logAction(db, req, 'suspender', 'contrato', c.id, { motivo, recorrenciaNfseId: c.recorrenciaNfseId });
      res.json({ success: true, recorrenciaDesativada: !!c.recorrenciaNfseId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contratos/:id/reativar', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (c.status === 'encerrado') return res.status(400).json({ success: false, error: 'Contrato encerrado — crie um novo' });
      const trx = db.transaction(() => {
        db.prepare(`UPDATE contratos SET status = 'ativo', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
        db.prepare(`INSERT INTO contratos_eventos (contratoId, tipo, descricao, usuario) VALUES (?, 'reativacao', ?, ?)`)
          .run(c.id, 'Contrato reativado', req.user?.username || null);
        // Integração (3): cascateia para a recorrência — volta a emitir NFSe.
        if (c.recorrenciaNfseId) {
          db.prepare(`UPDATE nfse_recorrencias SET ativo = 1, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(c.recorrenciaNfseId);
        }
      });
      trx();
      logAction(db, req, 'reativar', 'contrato', c.id, { recorrenciaNfseId: c.recorrenciaNfseId });
      res.json({ success: true, recorrenciaReativada: !!c.recorrenciaNfseId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contratos/:id/encerrar', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const motivo = (req.body?.motivo || '').trim();
      if (motivo.length < 5) return res.status(400).json({ success: false, error: 'Motivo obrigatório (mín. 5 caracteres)' });
      const trx = db.transaction(() => {
        db.prepare(`UPDATE contratos SET status = 'encerrado', dataFim = COALESCE(dataFim, date('now')), dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
        db.prepare(`INSERT INTO contratos_eventos (contratoId, tipo, descricao, usuario) VALUES (?, 'encerramento', ?, ?)`)
          .run(c.id, motivo, req.user?.username || null);
        // Integração (3): cascateia para a recorrência — para definitivamente.
        if (c.recorrenciaNfseId) {
          db.prepare(`UPDATE nfse_recorrencias SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(c.recorrenciaNfseId);
        }
      });
      trx();
      logAction(db, req, 'encerrar', 'contrato', c.id, { motivo, recorrenciaNfseId: c.recorrenciaNfseId });
      res.json({ success: true, recorrenciaDesativada: !!c.recorrenciaNfseId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contratos/:id/aditivo', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const { descricao } = req.body || {};
      if (!descricao || descricao.length < 5) return res.status(400).json({ success: false, error: 'Descrição do aditivo obrigatória' });
      db.prepare(`INSERT INTO contratos_eventos (contratoId, tipo, descricao, usuario) VALUES (?, 'aditivo', ?, ?)`)
        .run(c.id, descricao, req.user?.username || null);
      logAction(db, req, 'aditivo', 'contrato', c.id, { descricao });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasContratos };
