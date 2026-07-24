/**
 * defis-routes.js — Declaração anual DEFIS (Simples Nacional).
 *
 * Consolida as 12 apurações do ano + sócios + informações complementares
 * em payload pronto para o contador transcrever ao PGDAS-D.
 *
 * Endpoints:
 *   Sócios:
 *     GET  /api/fiscal/socios
 *     POST /api/fiscal/socios
 *     PUT  /api/fiscal/socios/:id
 *     DELETE /api/fiscal/socios/:id
 *
 *   DEFIS:
 *     GET  /api/fiscal/defis/:ano
 *     PUT  /api/fiscal/defis/:ano — salva/atualiza dados complementares
 */

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* já existe */ } }

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS socios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      cpf TEXT,
      percentualCapital REAL DEFAULT 0,
      tipoSocio TEXT DEFAULT 'socio',
      dataEntrada TEXT,
      dataSaida TEXT,
      ativo INTEGER DEFAULT 1,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS defis_anual (
      ano INTEGER PRIMARY KEY,
      ganhosCapital REAL DEFAULT 0,
      rendimentosIsentosSocios REAL DEFAULT 0,
      rendimentosTributaveisSocios REAL DEFAULT 0,
      empregadosInicio INTEGER DEFAULT 0,
      empregadosFim INTEGER DEFAULT 0,
      saldoCaixa3112 REAL DEFAULT 0,
      saldoBanco3112 REAL DEFAULT 0,
      estoqueInicial REAL DEFAULT 0,
      estoqueFinal REAL DEFAULT 0,
      despesasTotal REAL DEFAULT 0,
      observacoes TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

function buscarEmitente(db) {
  try {
    return db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();
  } catch {
    return null;
  }
}

function consolidarApuracoesAno(db, ano) {
  const meses = Array.from({ length: 12 }, (_, i) => `${ano}-${String(i+1).padStart(2, '0')}`);
  const rows = db.prepare(`
    SELECT competencia, rbt12, folha12m, fatorR, anexoVMigradoIII,
           receitaAnexoI, receitaAnexoII, receitaAnexoIII, receitaAnexoIV, receitaAnexoV,
           dasTotal, dasPorTributo, status, dataPagamento
    FROM apuracoes_sn WHERE substr(competencia,1,4) = ?
    ORDER BY competencia ASC
  `).all(String(ano));

  const byMes = {};
  for (const ym of meses) byMes[ym] = null;
  for (const r of rows) byMes[r.competencia] = r;

  const totais = {
    receitaBrutaAno: 0,
    receitaPorAnexo: { I: 0, II: 0, III: 0, IV: 0, V: 0 },
    dasTotalAno: 0,
    dasPorTributo: { IRPJ: 0, CSLL: 0, COFINS: 0, PIS: 0, CPP: 0, ICMS: 0, IPI: 0, ISS: 0 },
    mesesFechados: 0, mesesPagos: 0, mesesAbertos: 0
  };

  for (const r of rows) {
    const rec = (Number(r.receitaAnexoI)||0) + (Number(r.receitaAnexoII)||0) + (Number(r.receitaAnexoIII)||0) +
                (Number(r.receitaAnexoIV)||0) + (Number(r.receitaAnexoV)||0);
    totais.receitaBrutaAno += rec;
    totais.receitaPorAnexo.I += Number(r.receitaAnexoI) || 0;
    totais.receitaPorAnexo.II += Number(r.receitaAnexoII) || 0;
    totais.receitaPorAnexo.III += Number(r.receitaAnexoIII) || 0;
    totais.receitaPorAnexo.IV += Number(r.receitaAnexoIV) || 0;
    totais.receitaPorAnexo.V += Number(r.receitaAnexoV) || 0;
    totais.dasTotalAno += Number(r.dasTotal) || 0;
    try {
      const tribs = JSON.parse(r.dasPorTributo || '{}');
      for (const [t, v] of Object.entries(tribs)) {
        totais.dasPorTributo[t] = (totais.dasPorTributo[t] || 0) + (Number(v) || 0);
      }
    } catch {}
    if (r.status === 'paga') totais.mesesPagos++;
    else if (r.status === 'fechada') totais.mesesFechados++;
    else totais.mesesAbertos++;
  }

  totais.receitaBrutaAno = round2(totais.receitaBrutaAno);
  for (const k of Object.keys(totais.receitaPorAnexo)) totais.receitaPorAnexo[k] = round2(totais.receitaPorAnexo[k]);
  totais.dasTotalAno = round2(totais.dasTotalAno);
  for (const k of Object.keys(totais.dasPorTributo)) totais.dasPorTributo[k] = round2(totais.dasPorTributo[k]);

  const mesesArr = meses.map(ym => {
    const a = byMes[ym];
    return a ? {
      competencia: ym,
      status: a.status,
      rbt12: a.rbt12,
      receita: round2((Number(a.receitaAnexoI)||0)+(Number(a.receitaAnexoII)||0)+(Number(a.receitaAnexoIII)||0)+(Number(a.receitaAnexoIV)||0)+(Number(a.receitaAnexoV)||0)),
      das: a.dasTotal,
      dataPagamento: a.dataPagamento
    } : { competencia: ym, status: 'nao_gerada', rbt12: null, receita: 0, das: 0, dataPagamento: null };
  });

  return { meses: mesesArr, totais };
}

function registrarRotas(app, db) {
  migrar(db);

  // Sócios
  app.get('/api/fiscal/socios', (req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM socios WHERE ativo = 1 ORDER BY nome ASC').all();
      res.json({ success: true, socios: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/fiscal/socios', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const r = db.prepare(`INSERT INTO socios (nome, cpf, percentualCapital, tipoSocio, dataEntrada, observacoes)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        b.nome, b.cpf || null, Number(b.percentualCapital) || 0,
        b.tipoSocio || 'socio', b.dataEntrada || null, b.observacoes || null
      );
      const socio = db.prepare('SELECT * FROM socios WHERE id = ?').get(r.lastInsertRowid);
      res.json({ success: true, socio });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/fiscal/socios/:id', (req, res) => {
    try {
      const s = db.prepare('SELECT * FROM socios WHERE id = ?').get(req.params.id);
      if (!s) return res.status(404).json({ success: false, error: 'Sócio não encontrado' });
      const b = req.body || {};
      db.prepare(`UPDATE socios SET
        nome = ?, cpf = ?, percentualCapital = ?, tipoSocio = ?,
        dataEntrada = ?, dataSaida = ?, observacoes = ?, ativo = ?,
        dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(
        b.nome ?? s.nome, b.cpf ?? s.cpf,
        b.percentualCapital != null ? Number(b.percentualCapital) : s.percentualCapital,
        b.tipoSocio ?? s.tipoSocio, b.dataEntrada ?? s.dataEntrada, b.dataSaida ?? s.dataSaida,
        b.observacoes ?? s.observacoes,
        b.ativo != null ? (b.ativo ? 1 : 0) : s.ativo,
        req.params.id
      );
      const atual = db.prepare('SELECT * FROM socios WHERE id = ?').get(req.params.id);
      res.json({ success: true, socio: atual });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/fiscal/socios/:id', (req, res) => {
    try {
      const r = db.prepare('UPDATE socios SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Sócio não encontrado' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // DEFIS
  app.get('/api/fiscal/defis/:ano', (req, res) => {
    try {
      const ano = Number(req.params.ano);
      if (!ano || ano < 2000 || ano > 2100) return res.status(400).json({ success: false, error: 'Ano inválido' });
      const dados = consolidarApuracoesAno(db, ano);
      const socios = db.prepare('SELECT * FROM socios WHERE ativo = 1 ORDER BY nome ASC').all();
      const complementar = db.prepare('SELECT * FROM defis_anual WHERE ano = ?').get(ano) || {};
      const emitente = buscarEmitente(db);
      res.json({
        success: true,
        ano,
        emitente: emitente ? {
          razaoSocial: emitente.razaoSocial, cnpj: emitente.cnpj,
          inscricaoEstadual: emitente.inscricaoEstadual, inscricaoMunicipal: emitente.inscricaoMunicipal,
          cidade: emitente.cidade, uf: emitente.uf
        } : null,
        ...dados,
        socios,
        complementar
      });
    } catch (err) {
      console.error('[defis]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/fiscal/defis/:ano', (req, res) => {
    try {
      const ano = Number(req.params.ano);
      if (!ano) return res.status(400).json({ success: false, error: 'Ano inválido' });
      const b = req.body || {};
      const campos = [
        'ganhosCapital', 'rendimentosIsentosSocios', 'rendimentosTributaveisSocios',
        'empregadosInicio', 'empregadosFim', 'saldoCaixa3112', 'saldoBanco3112',
        'estoqueInicial', 'estoqueFinal', 'despesasTotal', 'observacoes'
      ];
      const existing = db.prepare('SELECT * FROM defis_anual WHERE ano = ?').get(ano);
      if (existing) {
        db.prepare(`UPDATE defis_anual SET
          ganhosCapital = ?, rendimentosIsentosSocios = ?, rendimentosTributaveisSocios = ?,
          empregadosInicio = ?, empregadosFim = ?, saldoCaixa3112 = ?, saldoBanco3112 = ?,
          estoqueInicial = ?, estoqueFinal = ?, despesasTotal = ?, observacoes = ?,
          dataAtualizacao = CURRENT_TIMESTAMP WHERE ano = ?`).run(
          Number(b.ganhosCapital) || 0,
          Number(b.rendimentosIsentosSocios) || 0,
          Number(b.rendimentosTributaveisSocios) || 0,
          Number(b.empregadosInicio) || 0,
          Number(b.empregadosFim) || 0,
          Number(b.saldoCaixa3112) || 0,
          Number(b.saldoBanco3112) || 0,
          Number(b.estoqueInicial) || 0,
          Number(b.estoqueFinal) || 0,
          Number(b.despesasTotal) || 0,
          b.observacoes || null,
          ano
        );
      } else {
        db.prepare(`INSERT INTO defis_anual
          (ano, ganhosCapital, rendimentosIsentosSocios, rendimentosTributaveisSocios,
           empregadosInicio, empregadosFim, saldoCaixa3112, saldoBanco3112,
           estoqueInicial, estoqueFinal, despesasTotal, observacoes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          ano,
          Number(b.ganhosCapital) || 0,
          Number(b.rendimentosIsentosSocios) || 0,
          Number(b.rendimentosTributaveisSocios) || 0,
          Number(b.empregadosInicio) || 0,
          Number(b.empregadosFim) || 0,
          Number(b.saldoCaixa3112) || 0,
          Number(b.saldoBanco3112) || 0,
          Number(b.estoqueInicial) || 0,
          Number(b.estoqueFinal) || 0,
          Number(b.despesasTotal) || 0,
          b.observacoes || null
        );
      }
      const complementar = db.prepare('SELECT * FROM defis_anual WHERE ano = ?').get(ano);
      res.json({ success: true, complementar });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[defis] Rotas registradas');
}

module.exports = { registrarRotasDefis: registrarRotas };
