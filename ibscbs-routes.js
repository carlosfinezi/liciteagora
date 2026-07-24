/**
 * ibscbs-routes.js — Item 3.1: reforma tributária (transição).
 *  - Config das alíquotas IBS/CBS e ativação do grupo na NF-e (nfe_config);
 *  - Apuração assistida do período: débitos estimados (faturas autorizadas ×
 *    alíquotas vigentes) − créditos registrados manualmente (compras).
 *
 * As alíquotas default são as do ano-teste 2026 (IBS UF 0,1% + CBS 0,9%).
 * Ajustar conforme o cronograma da LC 214/2025 e NTs da SEFAZ.
 */

const { logAction } = require('./audit-log');

function migrarIbsCbsDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ibscbs_creditos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competencia TEXT NOT NULL,
      descricao TEXT NOT NULL,
      documento TEXT,
      valorIBS REAL DEFAULT 0,
      valorCBS REAL DEFAULT 0,
      observacao TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ibscbs_cred ON ibscbs_creditos(competencia);
  `);
}

function registrarRotasIbsCbs(app, db) {
  migrarIbsCbsDB(db);

  app.get('/api/fiscal/ibscbs/config', (req, res) => {
    try {
      const cfg = db.prepare('SELECT ibsCbsAtivo, pIBSUF, pIBSMun, pCBS, tpAmb FROM nfe_config WHERE id = 1').get();
      res.json({ success: true, config: cfg || {} });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/fiscal/ibscbs/config', (req, res) => {
    try {
      const { ibsCbsAtivo, pIBSUF, pIBSMun, pCBS } = req.body || {};
      db.prepare(`UPDATE nfe_config SET
        ibsCbsAtivo = COALESCE(?, ibsCbsAtivo),
        pIBSUF = COALESCE(?, pIBSUF), pIBSMun = COALESCE(?, pIBSMun), pCBS = COALESCE(?, pCBS)
        WHERE id = 1`).run(
        ibsCbsAtivo != null ? (ibsCbsAtivo ? 1 : 0) : null,
        pIBSUF != null ? Number(pIBSUF) : null,
        pIBSMun != null ? Number(pIBSMun) : null,
        pCBS != null ? Number(pCBS) : null);
      logAction(db, req, 'configurar', 'ibscbs', null, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Apuração assistida da competência: débitos estimados × créditos manuais
  app.get('/api/fiscal/ibscbs/apuracao', (req, res) => {
    try {
      const comp = req.query.competencia;
      if (!/^\d{4}-\d{2}$/.test(comp || '')) return res.status(400).json({ success: false, error: 'competencia YYYY-MM' });
      const cfg = db.prepare('SELECT pIBSUF, pIBSMun, pCBS FROM nfe_config WHERE id = 1').get() || {};
      const pIBS = (Number(cfg.pIBSUF) || 0) + (Number(cfg.pIBSMun) || 0);
      const pCBS = Number(cfg.pCBS) || 0;

      const faturas = db.prepare(`SELECT id, numero, numeroNFe, valorTotal, dataEmissao
        FROM faturas WHERE statusSefaz = 'autorizada' AND COALESCE(excluida,0) = 0
          AND substr(dataEmissao,1,7) = ?`).all(comp);
      const baseTotal = Number(faturas.reduce((s, f) => s + (f.valorTotal || 0), 0).toFixed(2));
      const debitoIBS = Number((baseTotal * pIBS / 100).toFixed(2));
      const debitoCBS = Number((baseTotal * pCBS / 100).toFixed(2));

      const creditos = db.prepare('SELECT * FROM ibscbs_creditos WHERE competencia = ? ORDER BY id').all(comp);
      const creditoIBS = Number(creditos.reduce((s, c) => s + (c.valorIBS || 0), 0).toFixed(2));
      const creditoCBS = Number(creditos.reduce((s, c) => s + (c.valorCBS || 0), 0).toFixed(2));

      res.json({
        success: true, competencia: comp,
        aliquotas: { pIBS, pCBS },
        base: { faturas: faturas.length, valorTotal: baseTotal },
        debitos: { ibs: debitoIBS, cbs: debitoCBS },
        creditos: { ibs: creditoIBS, cbs: creditoCBS, lista: creditos },
        saldo: {
          ibs: Number((debitoIBS - creditoIBS).toFixed(2)),
          cbs: Number((debitoCBS - creditoCBS).toFixed(2)),
          total: Number((debitoIBS - creditoIBS + debitoCBS - creditoCBS).toFixed(2))
        }
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/fiscal/ibscbs/creditos', (req, res) => {
    try {
      const { competencia, descricao, documento, valorIBS, valorCBS, observacao } = req.body || {};
      if (!/^\d{4}-\d{2}$/.test(competencia || '') || !descricao) {
        return res.status(400).json({ success: false, error: 'competencia (YYYY-MM) e descricao obrigatórias' });
      }
      if (!(Number(valorIBS) > 0) && !(Number(valorCBS) > 0)) {
        return res.status(400).json({ success: false, error: 'Informe valorIBS e/ou valorCBS > 0' });
      }
      const r = db.prepare(`INSERT INTO ibscbs_creditos (competencia, descricao, documento, valorIBS, valorCBS, observacao, usuario)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        competencia, descricao.trim(), documento || null,
        Number(valorIBS) || 0, Number(valorCBS) || 0, observacao || null,
        req.session?.username || null);
      logAction(db, req, 'criar', 'ibscbs-credito', r.lastInsertRowid, { competencia });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/fiscal/ibscbs/creditos/:id', (req, res) => {
    try {
      const r = db.prepare('DELETE FROM ibscbs_creditos WHERE id = ?').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Crédito não encontrado' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasIbsCbs, migrarIbsCbsDB };
