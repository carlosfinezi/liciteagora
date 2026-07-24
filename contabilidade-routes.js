/**
 * contabilidade-routes.js — CTB-A: núcleo contábil em partida dobrada.
 * Plano de contas (sintética/analítica), lançamentos multi-partida com
 * D=C obrigatório, períodos com trava, diário/razão/balancete e
 * implantação de saldos (migração de ERP legado).
 *
 * Regras:
 *  - partida só em conta ANALÍTICA ativa;
 *  - soma débitos = soma créditos (tolerância 0.005);
 *  - competência (YYYY-MM da data) fechada rejeita lançamento e estorno;
 *  - lançamento nunca é apagado — estorno cria o inverso vinculado.
 *
 * Módulo de gate: 'contabilidade' (Avançado+).
 */

const { logAction } = require('./audit-log');

function dataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna ja existe */ } }

function migrarContabilidadeDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contas_contabeis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      nome TEXT NOT NULL,
      tipoConta TEXT NOT NULL DEFAULT 'analitica',
      natureza TEXT NOT NULL DEFAULT 'D',
      parentId INTEGER,
      nivel INTEGER NOT NULL DEFAULT 1,
      contaReferencialRFB TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parentId) REFERENCES contas_contabeis(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ctb_contas_parent ON contas_contabeis(parentId);

    CREATE TABLE IF NOT EXISTS periodos_contabeis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competencia TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'aberto',
      dataFechamento TEXT,
      usuario TEXT
    );

    CREATE TABLE IF NOT EXISTS lancamentos_contabeis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      historico TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'normal',
      origem TEXT DEFAULT 'manual',
      origemRef TEXT,
      estornado INTEGER DEFAULT 0,
      lancamentoEstornoId INTEGER,
      lancamentoOriginalId INTEGER,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ctb_lanc_data ON lancamentos_contabeis(data);
    CREATE INDEX IF NOT EXISTS idx_ctb_lanc_origem ON lancamentos_contabeis(origem, origemRef);

    CREATE TABLE IF NOT EXISTS lancamento_partidas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lancamentoId INTEGER NOT NULL,
      contaContabilId INTEGER NOT NULL,
      dc TEXT NOT NULL,
      valor REAL NOT NULL,
      centroCustoId INTEGER,
      historicoComplemento TEXT,
      FOREIGN KEY (lancamentoId) REFERENCES lancamentos_contabeis(id),
      FOREIGN KEY (contaContabilId) REFERENCES contas_contabeis(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ctb_part_lanc ON lancamento_partidas(lancamentoId);
    CREATE INDEX IF NOT EXISTS idx_ctb_part_conta ON lancamento_partidas(contaContabilId);
  `);
  // Ponte plano gerencial → conta contábil (preparação p/ CTB-B)
  alterSafe(db, 'ALTER TABLE plano_contas ADD COLUMN contaContabilId INTEGER');

  // Seed mínimo (só em tenant sem plano): estrutura nível 1 padrão BR.
  // Migração de cliente legado substitui/expande via importar.
  const tem = db.prepare('SELECT COUNT(*) n FROM contas_contabeis').get().n;
  if (tem === 0) {
    const ins = db.prepare(`INSERT INTO contas_contabeis (codigo, nome, tipoConta, natureza, nivel) VALUES (?, ?, 'sintetica', ?, 1)`);
    ins.run('1', 'ATIVO', 'D');
    ins.run('2', 'PASSIVO E PATRIMÔNIO LÍQUIDO', 'C');
    ins.run('3', 'RECEITAS', 'C');
    ins.run('4', 'CUSTOS E DESPESAS', 'D');
  }
}

function competenciaDe(data) { return String(data).slice(0, 7); }

function competenciaFechada(db, data) {
  const p = db.prepare('SELECT status FROM periodos_contabeis WHERE competencia = ?').get(competenciaDe(data));
  return p && p.status === 'fechado';
}

/**
 * Valida e grava um lançamento em partida dobrada. Lança Error em violação.
 * partidas: [{contaContabilId|codigo, dc:'D'|'C', valor, centroCustoId?, historicoComplemento?}]
 */
function gravarLancamento(db, { data, historico, tipo = 'normal', origem = 'manual', origemRef = null, partidas, usuario = null, lancamentoOriginalId = null }) {
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('data (YYYY-MM-DD) obrigatória');
  if (!historico || !historico.trim()) throw new Error('historico obrigatório');
  if (!Array.isArray(partidas) || partidas.length < 2) throw new Error('lançamento exige ao menos 2 partidas');
  if (competenciaFechada(db, data)) throw new Error(`Competência ${competenciaDe(data)} está fechada`);

  let somaD = 0, somaC = 0;
  const resolvidas = partidas.map(p => {
    const conta = p.contaContabilId
      ? db.prepare('SELECT * FROM contas_contabeis WHERE id = ?').get(p.contaContabilId)
      : db.prepare('SELECT * FROM contas_contabeis WHERE codigo = ?').get(p.codigo);
    if (!conta) throw new Error(`Conta contábil não encontrada (${p.contaContabilId || p.codigo})`);
    if (!conta.ativo) throw new Error(`Conta ${conta.codigo} inativa`);
    if (conta.tipoConta !== 'analitica') throw new Error(`Conta ${conta.codigo} é sintética — lance na analítica`);
    if (!['D', 'C'].includes(p.dc)) throw new Error("dc deve ser 'D' ou 'C'");
    const v = Number(p.valor);
    if (!(v > 0)) throw new Error('valor de partida deve ser > 0');
    if (p.dc === 'D') somaD += v; else somaC += v;
    return { conta, dc: p.dc, valor: v, centroCustoId: p.centroCustoId || null, historicoComplemento: p.historicoComplemento || null };
  });
  if (Math.abs(somaD - somaC) > 0.005) {
    throw new Error(`Débitos (${somaD.toFixed(2)}) ≠ Créditos (${somaC.toFixed(2)})`);
  }

  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO lancamentos_contabeis (data, historico, tipo, origem, origemRef, usuario, lancamentoOriginalId)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(data, historico.trim(), tipo, origem, origemRef, usuario, lancamentoOriginalId);
    const lid = r.lastInsertRowid;
    const insP = db.prepare(`INSERT INTO lancamento_partidas (lancamentoId, contaContabilId, dc, valor, centroCustoId, historicoComplemento)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const p of resolvidas) insP.run(lid, p.conta.id, p.dc, p.valor, p.centroCustoId, p.historicoComplemento);
    return lid;
  });
  return tx();
}

// Saldo de conta analítica até uma data (D aumenta natureza D, C aumenta natureza C)
function movimentoConta(db, contaId, inicio, fim) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN p.dc='D' THEN p.valor ELSE 0 END),0) AS deb,
           COALESCE(SUM(CASE WHEN p.dc='C' THEN p.valor ELSE 0 END),0) AS cred
    FROM lancamento_partidas p
    JOIN lancamentos_contabeis l ON l.id = p.lancamentoId
    WHERE p.contaContabilId = ? AND l.data >= ? AND l.data <= ?`).get(contaId, inicio, fim);
  return { debitos: row.deb, creditos: row.cred };
}

function registrarRotasContabilidade(app, db) {
  migrarContabilidadeDB(db);

  // ==================== PLANO DE CONTAS ====================

  app.get('/api/contabilidade/contas', (req, res) => {
    try {
      const contas = db.prepare('SELECT * FROM contas_contabeis ORDER BY codigo').all();
      res.json({ success: true, contas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contabilidade/contas', (req, res) => {
    try {
      const { codigo, nome, tipoConta, natureza, parentId, contaReferencialRFB } = req.body || {};
      if (!codigo || !nome) return res.status(400).json({ success: false, error: 'codigo e nome obrigatórios' });
      if (tipoConta && !['sintetica', 'analitica'].includes(tipoConta)) {
        return res.status(400).json({ success: false, error: "tipoConta: 'sintetica'|'analitica'" });
      }
      if (natureza && !['D', 'C'].includes(natureza)) {
        return res.status(400).json({ success: false, error: "natureza: 'D'|'C'" });
      }
      let nivel = 1, natHerdada = natureza;
      if (parentId) {
        const pai = db.prepare('SELECT * FROM contas_contabeis WHERE id = ?').get(parentId);
        if (!pai) return res.status(404).json({ success: false, error: 'Conta pai não encontrada' });
        if (pai.tipoConta !== 'sintetica') return res.status(400).json({ success: false, error: 'Conta pai deve ser sintética' });
        nivel = pai.nivel + 1;
        if (!natHerdada) natHerdada = pai.natureza;
      }
      const r = db.prepare(`INSERT INTO contas_contabeis (codigo, nome, tipoConta, natureza, parentId, nivel, contaReferencialRFB)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        String(codigo).trim(), String(nome).trim(), tipoConta || 'analitica',
        natHerdada || 'D', parentId || null, nivel, contaReferencialRFB || null);
      logAction(db, req, 'criar', 'conta-contabil', r.lastInsertRowid, { codigo, nome });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      const msg = /UNIQUE/.test(err.message) ? 'Já existe conta com esse código' : err.message;
      res.status(400).json({ success: false, error: msg });
    }
  });

  app.put('/api/contabilidade/contas/:id', (req, res) => {
    try {
      const conta = db.prepare('SELECT * FROM contas_contabeis WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      const { nome, ativo, contaReferencialRFB } = req.body || {};
      if (ativo === 0 || ativo === false) {
        const tem = db.prepare('SELECT 1 FROM lancamento_partidas WHERE contaContabilId = ? LIMIT 1').get(conta.id);
        if (tem) {
          // com movimento só inativa (não some dos relatórios históricos)
        }
      }
      db.prepare(`UPDATE contas_contabeis SET nome = COALESCE(?, nome),
        ativo = COALESCE(?, ativo), contaReferencialRFB = COALESCE(?, contaReferencialRFB)
        WHERE id = ?`).run(
        nome != null ? String(nome).trim() : null,
        ativo != null ? (ativo ? 1 : 0) : null,
        contaReferencialRFB !== undefined ? contaReferencialRFB : null,
        conta.id);
      logAction(db, req, 'editar', 'conta-contabil', conta.id, req.body);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Bulk p/ migração: upsert por codigo. Resolve parent por código-pai (prefixo até o último separador).
  app.post('/api/contabilidade/contas/importar', (req, res) => {
    try {
      const { contas } = req.body || {};
      if (!Array.isArray(contas) || !contas.length) return res.status(400).json({ success: false, error: 'contas obrigatórias' });
      let inseridas = 0, atualizadas = 0;
      const tx = db.transaction(() => {
        // ordena por código pra pais entrarem antes dos filhos
        const ordenadas = [...contas].sort((a, b) => String(a.codigo).localeCompare(String(b.codigo)));
        for (const c of ordenadas) {
          if (!c.codigo || !c.nome) throw new Error(`Conta sem codigo/nome: ${JSON.stringify(c).slice(0, 80)}`);
          const codigo = String(c.codigo).trim();
          const existente = db.prepare('SELECT id FROM contas_contabeis WHERE codigo = ?').get(codigo);
          // pai = maior prefixo existente terminando antes de um separador
          let parentId = null, nivel = 1;
          const seps = [...codigo.matchAll(/[.\-]/g)].map(m => m.index);
          for (let i = seps.length - 1; i >= 0; i--) {
            const pai = db.prepare('SELECT id, nivel FROM contas_contabeis WHERE codigo = ?').get(codigo.slice(0, seps[i]));
            if (pai) { parentId = pai.id; nivel = pai.nivel + 1; break; }
          }
          if (existente) {
            db.prepare(`UPDATE contas_contabeis SET nome = ?, tipoConta = COALESCE(?, tipoConta),
              natureza = COALESCE(?, natureza), parentId = ?, nivel = ?, contaReferencialRFB = COALESCE(?, contaReferencialRFB)
              WHERE id = ?`).run(String(c.nome).trim(), c.tipoConta || null, c.natureza || null,
              parentId, nivel, c.contaReferencialRFB || null, existente.id);
            atualizadas++;
          } else {
            db.prepare(`INSERT INTO contas_contabeis (codigo, nome, tipoConta, natureza, parentId, nivel, contaReferencialRFB)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(codigo, String(c.nome).trim(),
              c.tipoConta || 'analitica', c.natureza || 'D', parentId, nivel, c.contaReferencialRFB || null);
            inseridas++;
          }
        }
      });
      tx();
      logAction(db, req, 'importar', 'plano-contabil', null, { inseridas, atualizadas });
      res.json({ success: true, inseridas, atualizadas });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ==================== PERÍODOS ====================

  app.get('/api/contabilidade/periodos', (req, res) => {
    try {
      res.json({ success: true, periodos: db.prepare('SELECT * FROM periodos_contabeis ORDER BY competencia DESC LIMIT 36').all() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contabilidade/periodos/:competencia/fechar', (req, res) => {
    try {
      const comp = req.params.competencia;
      if (!/^\d{4}-\d{2}$/.test(comp)) return res.status(400).json({ success: false, error: 'competencia YYYY-MM' });
      const usuario = req.session?.username || null;
      db.prepare(`INSERT INTO periodos_contabeis (competencia, status, dataFechamento, usuario)
        VALUES (?, 'fechado', DATE('now','-3 hours'), ?)
        ON CONFLICT(competencia) DO UPDATE SET status='fechado', dataFechamento=DATE('now','-3 hours'), usuario=excluded.usuario`)
        .run(comp, usuario);
      logAction(db, req, 'fechar-periodo', 'contabilidade', null, { competencia: comp });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contabilidade/periodos/:competencia/reabrir', (req, res) => {
    try {
      const r = db.prepare(`UPDATE periodos_contabeis SET status='aberto', dataFechamento=NULL WHERE competencia = ?`)
        .run(req.params.competencia);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Competência não encontrada' });
      logAction(db, req, 'reabrir-periodo', 'contabilidade', null, { competencia: req.params.competencia });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== LANÇAMENTOS ====================

  app.get('/api/contabilidade/lancamentos', (req, res) => {
    try {
      const { inicio, fim, origem, limit } = req.query;
      let sql = `SELECT l.*,
          (SELECT COALESCE(SUM(valor),0) FROM lancamento_partidas WHERE lancamentoId = l.id AND dc='D') AS valorTotal
        FROM lancamentos_contabeis l WHERE 1=1`;
      const params = [];
      if (inicio) { sql += ' AND l.data >= ?'; params.push(inicio); }
      if (fim)    { sql += ' AND l.data <= ?'; params.push(fim); }
      if (origem) { sql += ' AND l.origem = ?'; params.push(origem); }
      sql += ' ORDER BY l.data DESC, l.id DESC LIMIT ?';
      params.push(Number(limit) || 200);
      const lancamentos = db.prepare(sql).all(...params);
      const partStmt = db.prepare(`SELECT p.*, c.codigo, c.nome AS contaNome
        FROM lancamento_partidas p JOIN contas_contabeis c ON c.id = p.contaContabilId
        WHERE p.lancamentoId = ?`);
      for (const l of lancamentos) l.partidas = partStmt.all(l.id);
      res.json({ success: true, lancamentos });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contabilidade/lancamentos', (req, res) => {
    try {
      const lid = gravarLancamento(db, {
        ...req.body,
        origem: 'manual',
        usuario: req.session?.username || null
      });
      logAction(db, req, 'criar', 'lancamento-contabil', lid, { historico: req.body?.historico });
      res.json({ success: true, id: lid });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Bulk p/ migração: cada item {data, historico, tipo?, origemRef?, partidas:[...]}
  app.post('/api/contabilidade/lancamentos/importar', (req, res) => {
    try {
      const { lancamentos } = req.body || {};
      if (!Array.isArray(lancamentos) || !lancamentos.length) {
        return res.status(400).json({ success: false, error: 'lancamentos obrigatórios' });
      }
      const usuario = req.session?.username || null;
      let importados = 0;
      const erros = [];
      const tx = db.transaction(() => {
        for (let i = 0; i < lancamentos.length; i++) {
          try {
            gravarLancamento(db, { ...lancamentos[i], origem: 'migracao', usuario });
            importados++;
          } catch (e) {
            erros.push({ indice: i, erro: e.message });
            if (erros.length > 50) throw new Error(`Abortado: mais de 50 erros. Primeiro: [${erros[0].indice}] ${erros[0].erro}`);
          }
        }
        if (erros.length && importados === 0) throw new Error(`Nenhum lançamento válido. Primeiro erro: [${erros[0].indice}] ${erros[0].erro}`);
      });
      tx();
      logAction(db, req, 'importar', 'lancamentos-contabeis', null, { importados, erros: erros.length });
      res.json({ success: true, importados, erros });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contabilidade/lancamentos/:id/estornar', (req, res) => {
    try {
      const l = db.prepare('SELECT * FROM lancamentos_contabeis WHERE id = ?').get(req.params.id);
      if (!l) return res.status(404).json({ success: false, error: 'Lançamento não encontrado' });
      if (l.estornado) return res.status(400).json({ success: false, error: 'Já estornado' });
      if (l.origem === 'estorno' || l.lancamentoOriginalId) {
        return res.status(400).json({ success: false, error: 'Não é possível estornar um estorno' });
      }
      const partidas = db.prepare('SELECT * FROM lancamento_partidas WHERE lancamentoId = ?').all(l.id);
      const hoje = dataBrasilia();
      const eid = gravarLancamento(db, {
        data: hoje,
        historico: `Estorno do lançamento #${l.id}: ${l.historico}`.slice(0, 300),
        tipo: l.tipo, origem: 'estorno', origemRef: String(l.id),
        usuario: req.session?.username || null,
        lancamentoOriginalId: l.id,
        partidas: partidas.map(p => ({
          contaContabilId: p.contaContabilId,
          dc: p.dc === 'D' ? 'C' : 'D',
          valor: p.valor,
          centroCustoId: p.centroCustoId
        }))
      });
      db.prepare('UPDATE lancamentos_contabeis SET estornado = 1, lancamentoEstornoId = ? WHERE id = ?').run(eid, l.id);
      logAction(db, req, 'estornar', 'lancamento-contabil', l.id, { estornoId: eid });
      res.json({ success: true, estornoId: eid });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ==================== RAZÃO / BALANCETE ====================

  app.get('/api/contabilidade/razao', (req, res) => {
    try {
      const { contaId, inicio, fim } = req.query;
      if (!contaId || !inicio || !fim) return res.status(400).json({ success: false, error: 'contaId, inicio e fim obrigatórios' });
      const conta = db.prepare('SELECT * FROM contas_contabeis WHERE id = ?').get(contaId);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta não encontrada' });

      const ant = movimentoConta(db, conta.id, '0000-01-01', new Date(new Date(inicio + 'T12:00:00').getTime() - 86400000).toISOString().slice(0, 10));
      const sinal = conta.natureza === 'D' ? 1 : -1;
      let saldo = (ant.debitos - ant.creditos) * sinal;
      const linhas = db.prepare(`
        SELECT l.id AS lancamentoId, l.data, l.historico, p.dc, p.valor, p.historicoComplemento
        FROM lancamento_partidas p
        JOIN lancamentos_contabeis l ON l.id = p.lancamentoId
        WHERE p.contaContabilId = ? AND l.data >= ? AND l.data <= ?
        ORDER BY l.data, l.id`).all(conta.id, inicio, fim)
        .map(x => {
          saldo += (x.dc === 'D' ? x.valor : -x.valor) * sinal;
          return { ...x, saldoCorrente: Number(saldo.toFixed(2)) };
        });
      res.json({
        success: true, conta,
        saldoAnterior: Number(((ant.debitos - ant.creditos) * sinal).toFixed(2)),
        linhas, saldoFinal: Number(saldo.toFixed(2))
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/contabilidade/balancete', (req, res) => {
    try {
      const comp = req.query.competencia;
      if (!comp || !/^\d{4}-\d{2}$/.test(comp)) return res.status(400).json({ success: false, error: 'competencia YYYY-MM obrigatória' });
      const inicio = comp + '-01';
      const fim = comp + '-31';
      const diaAntes = new Date(new Date(inicio + 'T12:00:00').getTime() - 86400000).toISOString().slice(0, 10);

      const contas = db.prepare('SELECT * FROM contas_contabeis ORDER BY codigo').all();
      const porId = new Map(contas.map(c => [c.id, { ...c, saldoAnterior: 0, debitos: 0, creditos: 0, saldoFinal: 0 }]));

      // movimentos das analíticas em 2 queries agregadas
      const antRows = db.prepare(`
        SELECT p.contaContabilId AS id,
          COALESCE(SUM(CASE WHEN p.dc='D' THEN p.valor ELSE -p.valor END),0) AS liquido
        FROM lancamento_partidas p JOIN lancamentos_contabeis l ON l.id = p.lancamentoId
        WHERE l.data <= ? GROUP BY p.contaContabilId`).all(diaAntes);
      const movRows = db.prepare(`
        SELECT p.contaContabilId AS id,
          COALESCE(SUM(CASE WHEN p.dc='D' THEN p.valor ELSE 0 END),0) AS deb,
          COALESCE(SUM(CASE WHEN p.dc='C' THEN p.valor ELSE 0 END),0) AS cred
        FROM lancamento_partidas p JOIN lancamentos_contabeis l ON l.id = p.lancamentoId
        WHERE l.data >= ? AND l.data <= ? GROUP BY p.contaContabilId`).all(inicio, fim);

      for (const r of antRows) {
        const c = porId.get(r.id); if (!c) continue;
        c.saldoAnterior = r.liquido * (c.natureza === 'D' ? 1 : -1);
      }
      for (const r of movRows) {
        const c = porId.get(r.id); if (!c) continue;
        c.debitos = r.deb; c.creditos = r.cred;
      }
      // roll-up: soma analíticas nas sintéticas pela cadeia de parentId
      for (const c of porId.values()) {
        if (c.tipoConta !== 'analitica') continue;
        c.saldoFinal = c.saldoAnterior + (c.debitos - c.creditos) * (c.natureza === 'D' ? 1 : -1);
        let pid = c.parentId;
        while (pid) {
          const pai = porId.get(pid); if (!pai) break;
          pai.saldoAnterior += c.saldoAnterior;
          pai.debitos += c.debitos;
          pai.creditos += c.creditos;
          pid = pai.parentId;
        }
      }
      for (const c of porId.values()) {
        if (c.tipoConta === 'sintetica') {
          c.saldoFinal = c.saldoAnterior + (c.debitos - c.creditos) * (c.natureza === 'D' ? 1 : -1);
        }
      }
      const linhas = [...porId.values()].filter(c => c.saldoAnterior || c.debitos || c.creditos)
        .map(c => ({ id: c.id, codigo: c.codigo, nome: c.nome, tipoConta: c.tipoConta, natureza: c.natureza, nivel: c.nivel,
          saldoAnterior: Number(c.saldoAnterior.toFixed(2)), debitos: Number(c.debitos.toFixed(2)),
          creditos: Number(c.creditos.toFixed(2)), saldoFinal: Number(c.saldoFinal.toFixed(2)) }));
      const totais = linhas.filter(l => l.tipoConta === 'analitica').reduce((t, l) => {
        t.debitos += l.debitos; t.creditos += l.creditos; return t;
      }, { debitos: 0, creditos: 0 });
      const periodo = db.prepare('SELECT status FROM periodos_contabeis WHERE competencia = ?').get(comp);
      res.json({
        success: true, competencia: comp, statusPeriodo: periodo?.status || 'aberto',
        linhas, totais: { debitos: Number(totais.debitos.toFixed(2)), creditos: Number(totais.creditos.toFixed(2)) }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasContabilidade, migrarContabilidadeDB, gravarLancamento };
