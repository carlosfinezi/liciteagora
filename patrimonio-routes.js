/**
 * patrimonio-routes.js — Patrimônio (ativo imobilizado).
 *
 * Modelo:
 *   patrimonio_bens       — bens individuais (com vida útil + valor residual)
 *   patrimonio_movimentos — aquisição | baixa | transferência | revalorização
 *
 * Depreciação: método linear simples.
 *   depreciacaoMensal = (valorAquisicao - valorResidual) / (vidaUtilMeses)
 *   acumulada(hoje) = depreciacaoMensal × min(meses_em_uso, vidaUtilMeses)
 *   vr_contabil = max(valorAquisicao - acumulada, valorResidual)
 *
 * Contabilização em patrimonio-contabil.js: aquisição, depreciação mensal e
 * baixa viram lançamento de partida dobrada. A depreciação é idempotente por
 * competência, e o acumulado usado na baixa vem do razão — não da fórmula.
 *
 * CIAP (crédito de ICMS sobre o imobilizado em 48 parcelas) continua fora: o
 * custo aqui inclui o ICMS, e separá-lo sem o controle do CIAP daria um número
 * que não concilia com a nota.
 */

const { logAction } = require('./audit-log');
const ctb = require('./patrimonio-contabil');

const TIPOS_MOV = ['aquisicao', 'baixa', 'transferencia', 'revalorizacao', 'manutencao'];

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS patrimonio_bens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE NOT NULL,
      descricao TEXT NOT NULL,
      categoria TEXT,
      marca TEXT,
      modelo TEXT,
      numeroSerie TEXT,
      valorAquisicao REAL NOT NULL,
      valorResidual REAL DEFAULT 0,
      vidaUtilMeses INTEGER NOT NULL DEFAULT 60,
      dataAquisicao TEXT NOT NULL,
      fornecedorId INTEGER,
      nfeEntradaId INTEGER,
      localizacao TEXT,
      responsavel TEXT,
      centroCustoId INTEGER,
      status TEXT NOT NULL DEFAULT 'ativo',
      dataBaixa TEXT,
      motivoBaixa TEXT,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fornecedorId) REFERENCES pessoas(id),
      FOREIGN KEY (centroCustoId) REFERENCES centros_custo(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pat_status ON patrimonio_bens(status);
    CREATE INDEX IF NOT EXISTS idx_pat_categoria ON patrimonio_bens(categoria);

    CREATE TABLE IF NOT EXISTS patrimonio_movimentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bemId INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      data TEXT NOT NULL,
      valor REAL,
      descricao TEXT,
      localizacaoAntes TEXT,
      localizacaoDepois TEXT,
      responsavelAntes TEXT,
      responsavelDepois TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bemId) REFERENCES patrimonio_bens(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mov_bem ON patrimonio_movimentos(bemId, data);
  `);
}

function gerarCodigo(db) {
  const ano = new Date().getFullYear();
  const prefix = `BEM-${ano}-`;
  const u = db.prepare(`SELECT codigo FROM patrimonio_bens WHERE codigo LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix+'%');
  let n = 1;
  if (u) { const m = u.codigo.match(/-(\d+)$/); if (m) n = parseInt(m[1],10) + 1; }
  return prefix + String(n).padStart(4, '0');
}

function calcularDepreciacao(bem, dataReferencia) {
  if (!bem.dataAquisicao) {
    return { mesesUso: 0, depreciacaoMensal: 0, depreciacaoAcumulada: 0, valorContabil: bem.valorAquisicao || 0 };
  }
  // Bem baixado congela na data da baixa — não volta a valer o preço de compra.
  //
  // Antes, qualquer status diferente de 'ativo' devolvia depreciação ZERO e
  // valor contábil igual ao de aquisição: um notebook de R$ 6.000 comprado em
  // 2024 e vendido aparecia na lista "Baixados" como 0% depreciado e R$ 6.000
  // de valor contábil. O patrimônio dado como baixa inflava a lista inteira.
  const ref = bem.status !== 'ativo' && bem.dataBaixa
    ? new Date(bem.dataBaixa)
    : (dataReferencia ? new Date(dataReferencia) : new Date());
  const aq = new Date(bem.dataAquisicao);
  const mesesUso = Math.max(0, (ref.getFullYear() - aq.getFullYear()) * 12 + (ref.getMonth() - aq.getMonth()));
  const base = (bem.valorAquisicao || 0) - (bem.valorResidual || 0);
  const dm = bem.vidaUtilMeses > 0 ? base / bem.vidaUtilMeses : 0;
  const meses = Math.min(mesesUso, bem.vidaUtilMeses || 0);
  const acum = Math.max(0, dm * meses);
  const vc = Math.max((bem.valorAquisicao || 0) - acum, bem.valorResidual || 0);
  return {
    mesesUso, depreciacaoMensal: dm, depreciacaoAcumulada: acum, valorContabil: vc,
    percentualDepreciado: bem.vidaUtilMeses ? Math.min(100, meses * 100 / bem.vidaUtilMeses) : 0
  };
}

function registrarRotasPatrimonio(app, db) {
  migrarDB(db);
  ctb.migrarDB(db);

  // ==================== CONTABILIZAÇÃO ====================

  // Mapeamento categoria -> contas contábeis. Sem ele nada é contabilizado, e
  // as rotas dizem isso em vez de lançar em conta arbitrária.
  app.get('/api/patrimonio/contas', (req, res) => {
    try {
      const mapas = db.prepare(`
        SELECT m.*, ci.codigo AS imobilizadoCodigo, ci.nome AS imobilizadoNome,
               ca.codigo AS acumuladaCodigo, ca.nome AS acumuladaNome,
               cd.codigo AS despesaCodigo, cd.nome AS despesaNome,
               cr.codigo AS resultadoCodigo, cr.nome AS resultadoNome
        FROM patrimonio_contas_padrao m
        LEFT JOIN contas_contabeis ci ON ci.id = m.contaImobilizadoId
        LEFT JOIN contas_contabeis ca ON ca.id = m.contaDepreciacaoAcumuladaId
        LEFT JOIN contas_contabeis cd ON cd.id = m.contaDespesaDepreciacaoId
        LEFT JOIN contas_contabeis cr ON cr.id = m.contaResultadoBaixaId
        ORDER BY COALESCE(m.categoria, '')`).all();
      const analiticas = db.prepare(
        "SELECT id, codigo, nome, natureza FROM contas_contabeis WHERE ativo = 1 AND tipoConta = 'analitica' ORDER BY codigo").all();
      res.json({ success: true, mapas, contasAnaliticas: analiticas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/patrimonio/contas', (req, res) => {
    try {
      const b = req.body || {};
      const obrigatorias = ['contaImobilizadoId', 'contaDepreciacaoAcumuladaId', 'contaDespesaDepreciacaoId'];
      for (const c of obrigatorias) {
        if (!b[c]) return res.status(400).json({ success: false, error: `${c} obrigatória` });
      }
      db.prepare(`INSERT INTO patrimonio_contas_padrao
        (categoria, contaImobilizadoId, contaDepreciacaoAcumuladaId, contaDespesaDepreciacaoId, contaResultadoBaixaId, taxaAnualPadrao)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(COALESCE(categoria, '')) DO UPDATE SET
          contaImobilizadoId = excluded.contaImobilizadoId,
          contaDepreciacaoAcumuladaId = excluded.contaDepreciacaoAcumuladaId,
          contaDespesaDepreciacaoId = excluded.contaDespesaDepreciacaoId,
          contaResultadoBaixaId = excluded.contaResultadoBaixaId,
          taxaAnualPadrao = excluded.taxaAnualPadrao,
          dataAtualizacao = CURRENT_TIMESTAMP`).run(
        (b.categoria || '').trim() || null,
        Number(b.contaImobilizadoId), Number(b.contaDepreciacaoAcumuladaId),
        Number(b.contaDespesaDepreciacaoId),
        b.contaResultadoBaixaId ? Number(b.contaResultadoBaixaId) : null,
        b.taxaAnualPadrao != null && b.taxaAnualPadrao !== '' ? Number(b.taxaAnualPadrao) : null);
      logAction(db, req, 'configurar-contas', 'patrimonio', null, { categoria: b.categoria || '(padrão)' });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Fechamento mensal. `simular=1` calcula sem gravar — depreciação é despesa
  // dedutível, e conferir antes de lançar é o mínimo.
  app.post('/api/patrimonio/depreciacao/apurar', (req, res) => {
    try {
      const competencia = req.body?.competencia || req.query.competencia;
      const simular = req.body?.simular === true || req.query.simular === '1';
      const r = ctb.apurarDepreciacao(db, competencia, { simular, usuario: req.user?.username || null });
      if (!simular && r.lancamentoId) {
        logAction(db, req, 'apurar-depreciacao', 'patrimonio', r.lancamentoId,
          { competencia, bens: r.bens, total: r.total });
      }
      res.json({ success: true, ...r });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.post('/api/patrimonio/depreciacao/:competencia/estornar', (req, res) => {
    try {
      const r = ctb.estornarDepreciacao(db, req.params.competencia, { usuario: req.user?.username || null });
      if (!r.estornadas) return res.status(400).json({ success: false, error: 'Competência não tem depreciação apurada' });
      logAction(db, req, 'estornar-depreciacao', 'patrimonio', r.lancamentoOriginalId, r);
      res.json({ success: true, ...r });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.get('/api/patrimonio/depreciacao', (req, res) => {
    try {
      const { competencia, bemId } = req.query;
      let sql = `SELECT d.*, b.codigo, b.descricao, b.categoria
        FROM patrimonio_depreciacoes d JOIN patrimonio_bens b ON b.id = d.bemId WHERE 1=1`;
      const p = [];
      if (competencia) { sql += ' AND d.competencia = ?'; p.push(competencia); }
      if (bemId) { sql += ' AND d.bemId = ?'; p.push(Number(bemId)); }
      sql += ' ORDER BY d.competencia DESC, b.codigo LIMIT 2000';
      const linhas = db.prepare(sql).all(...p);
      res.json({ success: true, linhas,
        total: Number(linhas.reduce((s, l) => s + l.valor, 0).toFixed(2)) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/patrimonio/bens/:id/contabilizar-aquisicao', (req, res) => {
    try {
      const r = ctb.contabilizarAquisicao(db, Number(req.params.id),
        { ...req.body, usuario: req.user?.username || null });
      logAction(db, req, 'contabilizar-aquisicao', 'patrimonio', req.params.id, r);
      res.json({ success: true, ...r });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.post('/api/patrimonio/bens/:id/contabilizar-baixa', (req, res) => {
    try {
      const r = ctb.contabilizarBaixa(db, Number(req.params.id),
        { ...req.body, usuario: req.user?.username || null });
      logAction(db, req, 'contabilizar-baixa', 'patrimonio', req.params.id, r);
      res.json({ success: true, ...r });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Razão x cadastro. Os dois divergirem em silêncio é o pior resultado:
  // isoladamente, cada um parece certo.
  app.get('/api/patrimonio/conferencia', (req, res) => {
    try {
      res.json({ success: true, conferencia: ctb.conferencia(db, req.query.ateCompetencia) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== NF-e DE ENTRADA ====================

  // Itens de nota com CFOP de imobilizado que ainda não viraram bem. O fiscal
  // já digitou a nota; redigitar o bem à mão era trabalho duplicado e fonte de
  // divergência entre o que entrou e o que está no patrimônio.
  app.get('/api/patrimonio/nfe-entrada/candidatos', (req, res) => {
    try {
      const itens = ctb.candidatosDaNfe(db, {
        dataInicio: req.query.dataInicio, dataFim: req.query.dataFim,
        incluirJaCriados: req.query.todos === '1',
      });
      res.json({ success: true, itens, cfopsConsiderados: ctb.CFOPS_IMOBILIZADO });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/patrimonio/nfe-entrada/:itemId/gerar-bens', (req, res) => {
    try {
      const r = ctb.criarBensDaNfe(db, Number(req.params.itemId), req.body || {});
      logAction(db, req, 'gerar-bens-da-nfe', 'patrimonio', req.params.itemId,
        { criados: r.criados.length, jaExistiam: r.jaExistiam });
      res.json({ success: true, ...r });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.get('/api/patrimonio/bens', (req, res) => {
    try {
      const { q, status, categoria, centroCustoId } = req.query;
      let sql = `
        SELECT b.*, f.razaoSocial AS fornecedorNome, c.nome AS centroCustoNome
        FROM patrimonio_bens b
        LEFT JOIN pessoas f ON f.id = b.fornecedorId
        LEFT JOIN centros_custo c ON c.id = b.centroCustoId
        WHERE 1=1
      `;
      const params = [];
      if (status)        { sql += ' AND b.status = ?';          params.push(status); }
      if (categoria)     { sql += ' AND b.categoria = ?';       params.push(categoria); }
      if (centroCustoId) { sql += ' AND b.centroCustoId = ?';   params.push(Number(centroCustoId)); }
      if (q) { sql += ' AND (b.codigo LIKE ? OR b.descricao LIKE ? OR b.numeroSerie LIKE ?)'; const like=`%${q}%`; params.push(like, like, like); }
      sql += ' ORDER BY b.codigo LIMIT 1000';
      const bens = db.prepare(sql).all(...params).map(b => ({ ...b, ...calcularDepreciacao(b) }));
      const kpis = {
        total: bens.length,
        ativos: bens.filter(b => b.status === 'ativo').length,
        valorAquisicaoTotal: bens.filter(b => b.status === 'ativo').reduce((s, b) => s + (b.valorAquisicao || 0), 0),
        valorContabilTotal:  bens.filter(b => b.status === 'ativo').reduce((s, b) => s + (b.valorContabil || 0), 0),
        depreciacaoAcumuladaTotal: bens.filter(b => b.status === 'ativo').reduce((s, b) => s + (b.depreciacaoAcumulada || 0), 0)
      };
      res.json({ success: true, bens, kpis });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/patrimonio/bens/:id', (req, res) => {
    try {
      const b = db.prepare(`
        SELECT b.*, f.razaoSocial AS fornecedorNome, c.nome AS centroCustoNome
        FROM patrimonio_bens b
        LEFT JOIN pessoas f ON f.id = b.fornecedorId
        LEFT JOIN centros_custo c ON c.id = b.centroCustoId
        WHERE b.id = ?
      `).get(req.params.id);
      if (!b) return res.status(404).json({ success: false, error: 'Bem não encontrado' });
      const movimentos = db.prepare('SELECT * FROM patrimonio_movimentos WHERE bemId = ? ORDER BY data DESC, id DESC').all(b.id);
      res.json({ success: true, bem: { ...b, ...calcularDepreciacao(b) }, movimentos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/patrimonio/bens', (req, res) => {
    try {
      const b = req.body;
      if (!b.descricao || !b.valorAquisicao || !b.dataAquisicao) {
        return res.status(400).json({ success: false, error: 'descricao, valorAquisicao e dataAquisicao obrigatórios' });
      }
      const codigo = b.codigo || gerarCodigo(db);
      const trx = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO patrimonio_bens
            (codigo, descricao, categoria, marca, modelo, numeroSerie,
             valorAquisicao, valorResidual, vidaUtilMeses, dataAquisicao,
             fornecedorId, nfeEntradaId, localizacao, responsavel, centroCustoId, observacoes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(codigo, b.descricao, b.categoria || null, b.marca || null, b.modelo || null, b.numeroSerie || null,
                Number(b.valorAquisicao), Number(b.valorResidual) || 0, Number(b.vidaUtilMeses) || 60, b.dataAquisicao,
                b.fornecedorId || null, b.nfeEntradaId || null, b.localizacao || null, b.responsavel || null,
                b.centroCustoId || null, b.observacoes || null);
        const id = r.lastInsertRowid;
        db.prepare(`
          INSERT INTO patrimonio_movimentos (bemId, tipo, data, valor, descricao, localizacaoDepois, responsavelDepois, usuario)
          VALUES (?, 'aquisicao', ?, ?, ?, ?, ?, ?)
        `).run(id, b.dataAquisicao, Number(b.valorAquisicao), `Aquisição: ${b.descricao}`,
                b.localizacao || null, b.responsavel || null, req.user?.username || null);
        return id;
      });
      const id = trx();
      logAction(db, req, 'criar', 'patrimonio-bem', id, { codigo, valor: b.valorAquisicao });
      res.json({ success: true, bem: db.prepare('SELECT * FROM patrimonio_bens WHERE id = ?').get(id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/patrimonio/bens/:id', (req, res) => {
    try {
      const camposValidos = ['descricao','categoria','marca','modelo','numeroSerie','valorResidual','vidaUtilMeses',
                             'localizacao','responsavel','centroCustoId','observacoes'];
      const sets = [], vals = [];
      for (const c of camposValidos) {
        if (req.body[c] !== undefined) { sets.push(`${c} = ?`); vals.push(req.body[c] === '' ? null : req.body[c]); }
      }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.id);
      db.prepare(`UPDATE patrimonio_bens SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      logAction(db, req, 'editar', 'patrimonio-bem', req.params.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Movimento: transferência (muda localização/responsável)
  app.post('/api/patrimonio/bens/:id/transferir', (req, res) => {
    try {
      const b = db.prepare('SELECT * FROM patrimonio_bens WHERE id = ?').get(req.params.id);
      if (!b) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (b.status !== 'ativo') return res.status(400).json({ success: false, error: 'Bem não está ativo' });
      const { localizacao, responsavel, descricao } = req.body || {};
      const trx = db.transaction(() => {
        db.prepare('UPDATE patrimonio_bens SET localizacao = COALESCE(?, localizacao), responsavel = COALESCE(?, responsavel) WHERE id = ?')
          .run(localizacao || null, responsavel || null, b.id);
        db.prepare(`
          INSERT INTO patrimonio_movimentos (bemId, tipo, data, descricao,
            localizacaoAntes, localizacaoDepois, responsavelAntes, responsavelDepois, usuario)
          VALUES (?, 'transferencia', date('now'), ?, ?, ?, ?, ?, ?)
        `).run(b.id, descricao || 'Transferência', b.localizacao, localizacao || b.localizacao,
                b.responsavel, responsavel || b.responsavel, req.user?.username || null);
      });
      trx();
      logAction(db, req, 'transferir', 'patrimonio-bem', b.id, { localizacao, responsavel });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Baixa
  app.post('/api/patrimonio/bens/:id/baixar', (req, res) => {
    try {
      const b = db.prepare('SELECT * FROM patrimonio_bens WHERE id = ?').get(req.params.id);
      if (!b) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (b.status !== 'ativo') return res.status(400).json({ success: false, error: 'Bem já baixado' });
      const motivo = (req.body?.motivo || '').trim();
      if (motivo.length < 5) return res.status(400).json({ success: false, error: 'Motivo obrigatório (mín. 5 caracteres)' });
      const valorVenda = req.body?.valorVenda != null ? Number(req.body.valorVenda) : null;
      const trx = db.transaction(() => {
        db.prepare(`UPDATE patrimonio_bens SET status = 'baixado', dataBaixa = date('now'), motivoBaixa = ? WHERE id = ?`).run(motivo, b.id);
        db.prepare(`
          INSERT INTO patrimonio_movimentos (bemId, tipo, data, valor, descricao, usuario)
          VALUES (?, 'baixa', date('now'), ?, ?, ?)
        `).run(b.id, valorVenda, motivo, req.user?.username || null);
      });
      trx();
      logAction(db, req, 'baixar', 'patrimonio-bem', b.id, { motivo, valorVenda });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Manutenção (registro)
  app.post('/api/patrimonio/bens/:id/manutencao', (req, res) => {
    try {
      const { descricao, valor, data } = req.body || {};
      if (!descricao) return res.status(400).json({ success: false, error: 'descricao obrigatória' });
      db.prepare(`
        INSERT INTO patrimonio_movimentos (bemId, tipo, data, valor, descricao, usuario)
        VALUES (?, 'manutencao', ?, ?, ?, ?)
      `).run(req.params.id, data || new Date().toISOString().slice(0,10), valor != null ? Number(valor) : null,
              descricao, req.user?.username || null);
      logAction(db, req, 'manutencao', 'patrimonio-bem', req.params.id, { descricao, valor });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasPatrimonio };
