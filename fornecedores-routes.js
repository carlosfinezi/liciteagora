/**
 * fornecedores-routes.js — CRUD de fornecedores (cadastro de empresas/pessoas
 * que fornecem produtos para a empresa). Extraído de produtos-routes.js
 * (refatoração 2026-04-30: separação Catálogo / Estoque / Compras).
 *
 * NÃO confundir com `fornecedor-routes.js` (singular) — aquele é o cadastro
 * da empresa DONA do sistema (tenant), usado em emissão fiscal.
 *
 * Uso no server.js:
 *   const { registrarRotasFornecedores } = require('./fornecedores-routes');
 *   registrarRotasFornecedores(app, db);
 */

const CAMPOS_FORN = [
  'cpfCnpj','tipo','razaoSocial','nomeFantasia','inscricaoEstadual','inscricaoMunicipal',
  'endereco','numero','complemento','bairro','codigoMunicipio','cidade','uf','cep',
  'telefone','email','contato','observacoes'
];

function registrarRotasFornecedores(app, db) {
  app.get('/api/fornecedores', (req, res) => {
    try {
      const { q, ativo } = req.query;
      let sql = 'SELECT * FROM fornecedores WHERE 1=1';
      const params = [];
      if (ativo !== undefined) { sql += ' AND ativo = ?'; params.push(Number(ativo)); }
      else { sql += ' AND ativo = 1'; }
      if (q) {
        sql += ' AND (cpfCnpj LIKE ? OR razaoSocial LIKE ? OR nomeFantasia LIKE ?)';
        const like = `%${q}%`;
        params.push(like, like, like);
      }
      sql += ' ORDER BY razaoSocial ASC';
      const fornecedores = db.prepare(sql).all(...params);
      res.json({ success: true, fornecedores });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/fornecedores/autocomplete', (req, res) => {
    try {
      const q = req.query.q || '';
      if (q.length < 2) return res.json({ success: true, fornecedores: [] });
      const like = `%${q}%`;
      const fornecedores = db.prepare(
        `SELECT id, cpfCnpj, razaoSocial, nomeFantasia FROM fornecedores
         WHERE ativo = 1 AND (cpfCnpj LIKE ? OR razaoSocial LIKE ? OR nomeFantasia LIKE ?)
         ORDER BY razaoSocial ASC LIMIT 15`
      ).all(like, like, like);
      res.json({ success: true, fornecedores });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/fornecedores/:id', (req, res) => {
    try {
      const f = db.prepare('SELECT * FROM fornecedores WHERE id = ?').get(req.params.id);
      if (!f) return res.status(404).json({ success: false, error: 'Fornecedor nao encontrado' });
      res.json({ success: true, fornecedor: f });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/fornecedores', (req, res) => {
    try {
      const b = req.body;
      if (!b.cpfCnpj || !b.razaoSocial) {
        return res.status(400).json({ success: false, error: 'cpfCnpj e razaoSocial sao obrigatorios' });
      }
      const cpfLimpo = b.cpfCnpj.replace(/\D/g, '');
      const tipo = b.tipo || (cpfLimpo.length <= 11 ? 'PF' : 'PJ');
      const existente = db.prepare('SELECT * FROM fornecedores WHERE cpfCnpj = ?').get(cpfLimpo);
      if (existente) {
        if (!existente.ativo) {
          db.prepare('UPDATE fornecedores SET ativo = 1, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(existente.id);
          return res.json({ success: true, fornecedor: db.prepare('SELECT * FROM fornecedores WHERE id = ?').get(existente.id), reativada: true });
        }
        return res.status(409).json({ success: false, error: 'Fornecedor ja cadastrado', fornecedor: existente });
      }
      const vals = CAMPOS_FORN.map(c => {
        if (c === 'cpfCnpj') return cpfLimpo;
        if (c === 'tipo') return tipo;
        const v = b[c];
        return v === undefined || v === '' ? null : v;
      });
      const placeholders = CAMPOS_FORN.map(() => '?').join(',');
      const result = db.prepare(`INSERT INTO fornecedores (${CAMPOS_FORN.join(',')}) VALUES (${placeholders})`).run(...vals);
      const fornecedor = db.prepare('SELECT * FROM fornecedores WHERE id = ?').get(result.lastInsertRowid);
      res.json({ success: true, fornecedor });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/fornecedores/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT * FROM fornecedores WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, error: 'Fornecedor nao encontrado' });
      const b = req.body;
      const sets = [];
      const vals = [];
      for (const c of CAMPOS_FORN) {
        if (c === 'cpfCnpj') continue;
        if (b[c] === undefined) continue;
        sets.push(`${c} = ?`);
        vals.push(b[c] === '' ? null : b[c]);
      }
      if (sets.length) {
        sets.push('dataAtualizacao = CURRENT_TIMESTAMP');
        vals.push(req.params.id);
        db.prepare(`UPDATE fornecedores SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      const fornecedor = db.prepare('SELECT * FROM fornecedores WHERE id = ?').get(req.params.id);
      res.json({ success: true, fornecedor });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/fornecedores/:id', (req, res) => {
    try {
      const result = db.prepare('UPDATE fornecedores SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ? AND ativo = 1').run(req.params.id);
      if (result.changes === 0) return res.status(404).json({ success: false, error: 'Fornecedor nao encontrado' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasFornecedores, CAMPOS_FORN };
