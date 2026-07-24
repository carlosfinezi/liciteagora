/**
 * retencoes-routes.js — Retenções tributárias em serviços tomados (INSS, IRRF, ISS, CSRF).
 *
 * Adiciona colunas em contas_a_pagar para rastrear valores retidos em NFSe tomadas.
 * Gera relatório mensal consolidado por tributo.
 *
 * Endpoints:
 *   GET  /api/fiscal/retencoes?competencia=YYYY-MM
 *   GET  /api/fiscal/retencoes/cp/:id
 *   PUT  /api/fiscal/retencoes/cp/:id — salva retenções em uma CP
 *   GET  /api/fiscal/retencoes/contas?competencia=YYYY-MM&somenteComRetencao=1
 */

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* já existe */ } }

function migrar(db) {
  alterSafe(db, "ALTER TABLE contas_a_pagar ADD COLUMN valorInss REAL");
  alterSafe(db, "ALTER TABLE contas_a_pagar ADD COLUMN valorIrrf REAL");
  alterSafe(db, "ALTER TABLE contas_a_pagar ADD COLUMN valorIss REAL");
  alterSafe(db, "ALTER TABLE contas_a_pagar ADD COLUMN valorCsrf REAL");
  alterSafe(db, "ALTER TABLE contas_a_pagar ADD COLUMN valorLiquido REAL");
}

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

function competenciaValida(comp) {
  return /^\d{4}-\d{2}$/.test(String(comp || ''));
}

function ultimoDiaMes(comp) {
  const [y, m] = comp.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function registrarRotas(app, db) {
  migrar(db);

  app.get('/api/fiscal/retencoes/cp/:id', (req, res) => {
    try {
      const r = db.prepare(`SELECT id, descricao, valor, valorInss, valorIrrf, valorIss, valorCsrf, valorLiquido,
        dataEmissao, dataVencimento, dataPagamento, status, fornecedorId
        FROM contas_a_pagar WHERE id = ?`).get(req.params.id);
      if (!r) return res.status(404).json({ success: false, error: 'CP não encontrada' });
      res.json({ success: true, conta: r });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/fiscal/retencoes/cp/:id', (req, res) => {
    try {
      const r = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);
      if (!r) return res.status(404).json({ success: false, error: 'CP não encontrada' });
      const b = req.body || {};
      const inss = round2(b.valorInss);
      const irrf = round2(b.valorIrrf);
      const iss = round2(b.valorIss);
      const csrf = round2(b.valorCsrf);
      const totalRet = inss + irrf + iss + csrf;
      const liquido = round2((Number(r.valor) || 0) - totalRet);
      db.prepare(`UPDATE contas_a_pagar SET
        valorInss = ?, valorIrrf = ?, valorIss = ?, valorCsrf = ?, valorLiquido = ?,
        dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`).run(inss, irrf, iss, csrf, liquido, req.params.id);
      const atualizada = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);
      res.json({ success: true, conta: atualizada, totalRetido: totalRet });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/fiscal/retencoes', (req, res) => {
    try {
      const comp = req.query.competencia || new Date().toISOString().slice(0, 7);
      if (!competenciaValida(comp)) return res.status(400).json({ success: false, error: 'Competência inválida (YYYY-MM)' });
      const inicio = comp + '-01';
      const fim = ultimoDiaMes(comp);

      const base = req.query.base === 'pagamento' ? 'dataPagamento' : 'dataVencimento';
      const rows = db.prepare(`
        SELECT id, descricao, valor, valorInss, valorIrrf, valorIss, valorCsrf, valorLiquido,
               dataEmissao, dataVencimento, dataPagamento, status, fornecedorId
        FROM contas_a_pagar
        WHERE ${base} BETWEEN ? AND ?
          AND (COALESCE(valorInss,0) + COALESCE(valorIrrf,0) + COALESCE(valorIss,0) + COALESCE(valorCsrf,0)) > 0
      `).all(inicio, fim);

      const totais = { inss: 0, irrf: 0, iss: 0, csrf: 0, bruto: 0, liquido: 0 };
      for (const r of rows) {
        totais.inss += Number(r.valorInss) || 0;
        totais.irrf += Number(r.valorIrrf) || 0;
        totais.iss += Number(r.valorIss) || 0;
        totais.csrf += Number(r.valorCsrf) || 0;
        totais.bruto += Number(r.valor) || 0;
        totais.liquido += Number(r.valorLiquido) || 0;
      }
      for (const k of Object.keys(totais)) totais[k] = round2(totais[k]);

      res.json({
        success: true,
        competencia: comp,
        base,
        periodo: { inicio, fim },
        contas: rows,
        totais,
        totalRetido: round2(totais.inss + totais.irrf + totais.iss + totais.csrf)
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/fiscal/retencoes/contas', (req, res) => {
    try {
      const comp = req.query.competencia || new Date().toISOString().slice(0, 7);
      if (!competenciaValida(comp)) return res.status(400).json({ success: false, error: 'Competência inválida' });
      const somenteComRet = req.query.somenteComRetencao === '1' || req.query.somenteComRetencao === 'true';
      const inicio = comp + '-01';
      const fim = ultimoDiaMes(comp);
      const base = req.query.base === 'pagamento' ? 'dataPagamento' : 'dataVencimento';

      let sql = `
        SELECT cp.id, cp.descricao, cp.valor, cp.valorInss, cp.valorIrrf, cp.valorIss, cp.valorCsrf, cp.valorLiquido,
               cp.dataEmissao, cp.dataVencimento, cp.dataPagamento, cp.status, cp.fornecedorId,
               p.razaoSocial AS fornecedorNome, p.cpfCnpj AS fornecedorCnpj
        FROM contas_a_pagar cp
        LEFT JOIN pessoas p ON p.id = cp.fornecedorId
        WHERE cp.${base} BETWEEN ? AND ?
      `;
      const params = [inicio, fim];
      if (somenteComRet) {
        sql += ` AND (COALESCE(cp.valorInss,0) + COALESCE(cp.valorIrrf,0) + COALESCE(cp.valorIss,0) + COALESCE(cp.valorCsrf,0)) > 0`;
      }
      sql += ` ORDER BY cp.${base} ASC, cp.id ASC`;
      const rows = db.prepare(sql).all(...params);
      res.json({ success: true, competencia: comp, base, contas: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[retencoes] Rotas registradas');
}

module.exports = { registrarRotasRetencoes: registrarRotas };
