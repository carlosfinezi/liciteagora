/**
 * audit-log.js — Log de auditoria de ações sensíveis.
 *
 * A tabela `audit_log` é criada por `auth.js` (criarUsuarioInicial).
 *
 * Uso:
 *   const { logAction, registrarRotasAuditoria } = require('./audit-log');
 *   logAction(db, req, 'criar', 'usuario', userId, { username });
 *   registrarRotasAuditoria(app, db);
 */

const { requireRole } = require('./auth');

/**
 * Registra uma ação. Falhas no log NÃO devem quebrar a operação principal.
 * Não loga quando req.user não existe (ex.: chamadas via X-Api-Key da extensão).
 */
function logAction(db, req, action, entity, entityId, payload) {
  try {
    if (!req || !req.user) return;
    db.prepare(`
      INSERT INTO audit_log (userId, username, action, entity, entityId, payload, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      req.user.username,
      String(action),
      String(entity),
      entityId != null ? String(entityId) : null,
      payload ? JSON.stringify(payload) : null,
      req.ip || (req.headers && req.headers['x-forwarded-for']) || null
    );
  } catch (err) {
    console.error('[audit-log] falha ao gravar:', err.message);
  }
}

function registrarRotasAuditoria(app, db) {
  // GET /api/audit-log — admin only. Filtros: userId, entity, action, dataIni, dataFim, q (busca em payload), limit
  app.get('/api/audit-log', requireRole(['admin']), (req, res) => {
    try {
      const { userId, entity, action, dataIni, dataFim, q, limit } = req.query;
      let sql = 'SELECT * FROM audit_log WHERE 1=1';
      const params = [];
      if (userId)  { sql += ' AND userId = ?';  params.push(Number(userId)); }
      if (entity)  { sql += ' AND entity = ?';  params.push(entity); }
      if (action)  { sql += ' AND action = ?';  params.push(action); }
      if (dataIni) { sql += ' AND createdAt >= ?'; params.push(dataIni); }
      if (dataFim) { sql += ' AND createdAt <= ?'; params.push(dataFim + ' 23:59:59'); }
      if (q)       { sql += ' AND (payload LIKE ? OR username LIKE ?)'; const like = `%${q}%`; params.push(like, like); }
      sql += ' ORDER BY id DESC LIMIT ?';
      params.push(Number(limit) || 200);
      const logs = db.prepare(sql).all(...params);
      res.json({ success: true, logs });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/audit-log/entities — distintos para popular filtros
  app.get('/api/audit-log/entities', requireRole(['admin']), (req, res) => {
    try {
      const entities = db.prepare('SELECT DISTINCT entity FROM audit_log ORDER BY entity').all().map(r => r.entity);
      const actions  = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map(r => r.action);
      res.json({ success: true, entities, actions });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { logAction, registrarRotasAuditoria };
