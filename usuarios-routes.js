/**
 * usuarios-routes.js — CRUD de usuários, perfil próprio, troca de senha.
 *
 * Tabela `users` é criada/migrada em auth.js (criarUsuarioInicial).
 *
 * Uso:
 *   const { registrarRotasUsuarios } = require('./usuarios-routes');
 *   registrarRotasUsuarios(app, db);
 */

const bcrypt = require('bcryptjs');
const { requireRole, ROLES } = require('./auth');
const { logAction } = require('./audit-log');
const { perfisDisponiveis } = require('./perfis-acesso');

// Perfil aceito = um dos cinco nativos OU um perfil de acesso cadastrado e
// ativo (perfis_acesso). Antes só os cinco nativos passavam, o que tornava
// impossível atribuir um perfil recém-criado.
function slugsDePerfil(db) {
  return perfisDisponiveis(db).map((p) => p.slug);
}

const SELECT_USER = `id, username, nome, email, role, ativo, ultimoLogin, createdAt,
  ehVendedor, vendedorTipo, cpfCnpj, comissaoPercentual, metaMensal, telefoneVendedor, estabelecimentoId`;

// Tipos de vendedor aceitos. NULL é permitido (compat: vendedor sem tipo definido).
const VENDEDOR_TIPOS = ['interno', 'externo', 'representante'];

function registrarRotasUsuarios(app, db) {
  // ---------- /me ----------

  // Dados do próprio usuário (qualquer logado)
  app.get('/api/usuarios/me', (req, res) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Não autenticado' });
    res.json({ success: true, usuario: req.user, roles: ROLES, perfis: perfisDisponiveis(db) });
  });

  // Trocar a própria senha
  app.put('/api/usuarios/me/senha', (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ success: false, error: 'Não autenticado' });
      const { senhaAtual, senhaNova } = req.body;
      if (!senhaAtual || !senhaNova) return res.status(400).json({ success: false, error: 'Informe senha atual e nova' });
      if (senhaNova.length < 6) return res.status(400).json({ success: false, error: 'Nova senha deve ter ao menos 6 caracteres' });
      const u = db.prepare('SELECT passwordHash FROM users WHERE id = ?').get(req.user.id);
      if (!u || !bcrypt.compareSync(senhaAtual, u.passwordHash)) {
        return res.status(400).json({ success: false, error: 'Senha atual incorreta' });
      }
      const hash = bcrypt.hashSync(senhaNova, 10);
      db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(hash, req.user.id);
      logAction(db, req, 'trocar-senha', 'usuario', req.user.id, null);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Atualizar dados próprios (nome, email)
  app.put('/api/usuarios/me', (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ success: false, error: 'Não autenticado' });
      const { nome, email } = req.body;
      db.prepare('UPDATE users SET nome = COALESCE(?, nome), email = COALESCE(?, email) WHERE id = ?')
        .run(nome ?? null, email ?? null, req.user.id);
      const usuario = db.prepare(`SELECT ${SELECT_USER} FROM users WHERE id = ?`).get(req.user.id);
      res.json({ success: true, usuario });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---------- ADMIN: CRUD ----------

  // GET /api/usuarios — admin lista todos (inclusive inativos). Demais roles
  // podem ler a lista SOMENTE quando filtrando por ?vendedor=1 (necessário
  // para selects de vendedor em CRM/pedidos/OS — não vaza credenciais).
  app.get('/api/usuarios', (req, res) => {
    try {
      const apenasVendedores = req.query.vendedor === '1' || req.query.vendedor === 'true';
      if (!apenasVendedores && req.user?.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Acesso negado' });
      }
      const where = apenasVendedores ? 'WHERE ativo = 1 AND ehVendedor = 1' : '';
      const sql = `SELECT ${SELECT_USER} FROM users ${where} ORDER BY ativo DESC, username ASC`;
      const usuarios = db.prepare(sql).all();
      res.json({ success: true, usuarios, roles: ROLES, perfis: perfisDisponiveis(db) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/usuarios/:id', requireRole(['admin']), (req, res) => {
    try {
      const usuario = db.prepare(`SELECT ${SELECT_USER} FROM users WHERE id = ?`).get(req.params.id);
      if (!usuario) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
      res.json({ success: true, usuario });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/usuarios', requireRole(['admin']), (req, res) => {
    try {
      const {
        username, nome, email, role, senha, estabelecimentoId,
        ehVendedor, vendedorTipo, cpfCnpj, comissaoPercentual, metaMensal, telefoneVendedor,
      } = req.body;
      if (!username || !senha || !role) {
        return res.status(400).json({ success: false, error: 'username, senha e perfil são obrigatórios' });
      }
      const perfisOk = slugsDePerfil(db);
      if (!perfisOk.includes(role)) {
        return res.status(400).json({ success: false, error: `Perfil inválido. Use: ${perfisOk.join(', ')}` });
      }
      if (senha.length < 6) {
        return res.status(400).json({ success: false, error: 'Senha deve ter ao menos 6 caracteres' });
      }
      if (vendedorTipo && !VENDEDOR_TIPOS.includes(vendedorTipo)) {
        return res.status(400).json({ success: false, error: `vendedorTipo inválido. Use: ${VENDEDOR_TIPOS.join(', ')}` });
      }
      const existente = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existente) return res.status(409).json({ success: false, error: 'username já cadastrado' });

      const ehV = (ehVendedor === 1 || ehVendedor === '1' || ehVendedor === true || ehVendedor === 'true') ? 1 : 0;
      const hash = bcrypt.hashSync(senha, 10);
      const r = db.prepare(`
        INSERT INTO users (
          username, passwordHash, nome, email, role, ativo,
          ehVendedor, vendedorTipo, cpfCnpj, comissaoPercentual, metaMensal, telefoneVendedor, estabelecimentoId
        )
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        username, hash, nome || null, email || null, role,
        ehV, ehV ? (vendedorTipo || null) : null, cpfCnpj || null,
        comissaoPercentual != null && comissaoPercentual !== '' ? Number(comissaoPercentual) : null,
        metaMensal != null && metaMensal !== '' ? Number(metaMensal) : null,
        telefoneVendedor || null,
        estabelecimentoId || null
      );

      logAction(db, req, 'criar', 'usuario', r.lastInsertRowid, { username, role, ehVendedor: ehV });
      const usuario = db.prepare(`SELECT ${SELECT_USER} FROM users WHERE id = ?`).get(r.lastInsertRowid);
      res.json({ success: true, usuario });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/usuarios/:id', requireRole(['admin']), (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });

      const {
        nome, email, role, ativo, senha, estabelecimentoId,
        ehVendedor, vendedorTipo, cpfCnpj, comissaoPercentual, metaMensal, telefoneVendedor,
      } = req.body;
      if (role) {
        const perfisOk = slugsDePerfil(db);
        if (!perfisOk.includes(role)) {
          return res.status(400).json({ success: false, error: `Perfil inválido. Use: ${perfisOk.join(', ')}` });
        }
      }
      if (vendedorTipo !== undefined && vendedorTipo !== null && vendedorTipo !== '' && !VENDEDOR_TIPOS.includes(vendedorTipo)) {
        return res.status(400).json({ success: false, error: `vendedorTipo inválido. Use: ${VENDEDOR_TIPOS.join(', ')}` });
      }
      // Não permitir auto-rebaixar (admin tirando seu próprio admin) ou auto-desativar
      if (req.user && req.user.id === id) {
        if (role && role !== existing.role) {
          return res.status(400).json({ success: false, error: 'Não é possível alterar o próprio perfil' });
        }
        if (ativo === 0 || ativo === false) {
          return res.status(400).json({ success: false, error: 'Não é possível desativar o próprio usuário' });
        }
      }

      const sets = [];
      const vals = [];
      const changed = {};
      if (nome !== undefined)  { sets.push('nome = ?');  vals.push(nome || null);  changed.nome = nome; }
      if (email !== undefined) { sets.push('email = ?'); vals.push(email || null); changed.email = email; }
      if (role !== undefined)  { sets.push('role = ?');  vals.push(role);          changed.role = role; }
      if (ativo !== undefined) { sets.push('ativo = ?'); vals.push(ativo ? 1 : 0); changed.ativo = ativo ? 1 : 0; }
      if (senha) {
        if (senha.length < 6) return res.status(400).json({ success: false, error: 'Senha deve ter ao menos 6 caracteres' });
        sets.push('passwordHash = ?');
        vals.push(bcrypt.hashSync(senha, 10));
        changed.senha = '***';
      }
      if (ehVendedor !== undefined) {
        const flag = (ehVendedor === 1 || ehVendedor === '1' || ehVendedor === true || ehVendedor === 'true') ? 1 : 0;
        sets.push('ehVendedor = ?'); vals.push(flag); changed.ehVendedor = flag;
        // Limpar campos de vendedor quando desligar a flag (mantém o histórico nas FKs).
        if (!flag) {
          sets.push('vendedorTipo = NULL', 'cpfCnpj = NULL', 'metaMensal = NULL', 'telefoneVendedor = NULL');
        }
      }
      if (vendedorTipo !== undefined) { sets.push('vendedorTipo = ?'); vals.push(vendedorTipo || null); changed.vendedorTipo = vendedorTipo; }
      if (cpfCnpj !== undefined)      { sets.push('cpfCnpj = ?');      vals.push(cpfCnpj || null);      changed.cpfCnpj = cpfCnpj; }
      if (comissaoPercentual !== undefined) {
        const v = comissaoPercentual === '' || comissaoPercentual == null ? null : Number(comissaoPercentual);
        sets.push('comissaoPercentual = ?'); vals.push(v); changed.comissaoPercentual = v;
      }
      if (metaMensal !== undefined) {
        const v = metaMensal === '' || metaMensal == null ? null : Number(metaMensal);
        sets.push('metaMensal = ?'); vals.push(v); changed.metaMensal = v;
      }
      if (telefoneVendedor !== undefined) { sets.push('telefoneVendedor = ?'); vals.push(telefoneVendedor || null); changed.telefoneVendedor = telefoneVendedor; }
      if (estabelecimentoId !== undefined) { sets.push('estabelecimentoId = ?'); vals.push(estabelecimentoId || null); changed.estabelecimentoId = estabelecimentoId || null; }
      if (sets.length) {
        vals.push(id);
        db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        logAction(db, req, 'editar', 'usuario', id, changed);
      }
      const usuario = db.prepare(`SELECT ${SELECT_USER} FROM users WHERE id = ?`).get(id);
      res.json({ success: true, usuario });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Soft-delete (ativo=0). Não há hard-delete para preservar integridade do audit_log.
  app.delete('/api/usuarios/:id', requireRole(['admin']), (req, res) => {
    try {
      const id = Number(req.params.id);
      if (req.user && req.user.id === id) {
        return res.status(400).json({ success: false, error: 'Não é possível desativar o próprio usuário' });
      }
      const r = db.prepare('UPDATE users SET ativo = 0 WHERE id = ? AND ativo = 1').run(id);
      if (r.changes === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado ou já inativo' });
      logAction(db, req, 'desativar', 'usuario', id, null);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasUsuarios };
