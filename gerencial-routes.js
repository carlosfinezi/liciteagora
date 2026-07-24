/**
 * gerencial-routes.js — Centros de custo, plano de contas gerencial e DRE.
 *
 * Modelo:
 *   centros_custo            — departamentos/projetos (transversal)
 *   plano_contas             — hierárquico (codigo, parentId, nivel), com tipo: receita|despesa|...
 *   categorias_cp/cr.planoContaId  — vincula categoria → folha do plano
 *   contas_a_pagar/receber.centroCustoId  — classifica lançamento por centro
 *
 * DRE: agrupa CR/CP pagos no período por nó-pai do plano (raiz).
 */

const { logAction } = require('./audit-log');

const TIPOS_PLANO = ['receita', 'deducao', 'custo', 'despesa', 'financeiro_receita', 'financeiro_despesa', 'investimento', 'transferencia'];

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* idempotente */ } }

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS centros_custo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      nome TEXT NOT NULL UNIQUE,
      descricao TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS plano_contas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL,
      parentId INTEGER,
      nivel INTEGER NOT NULL DEFAULT 1,
      ordem INTEGER DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      FOREIGN KEY (parentId) REFERENCES plano_contas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_plano_parent ON plano_contas(parentId);
    CREATE INDEX IF NOT EXISTS idx_plano_tipo ON plano_contas(tipo, ativo);
  `);

  // Adicionar colunas em CR/CP e categorias (idempotente)
  for (const stmt of [
    'ALTER TABLE contas_a_receber ADD COLUMN centroCustoId INTEGER',
    'ALTER TABLE contas_a_pagar ADD COLUMN centroCustoId INTEGER',
    'ALTER TABLE categorias_cr ADD COLUMN planoContaId INTEGER',
    'ALTER TABLE categorias_cp ADD COLUMN planoContaId INTEGER'
  ]) {
    alterSafe(db, stmt);
  }

  // Seed plano de contas básico se vazio
  const tem = db.prepare('SELECT id FROM plano_contas LIMIT 1').get();
  if (!tem) {
    const insert = db.prepare('INSERT INTO plano_contas (codigo, nome, tipo, parentId, nivel, ordem) VALUES (?, ?, ?, ?, ?, ?)');
    function add(codigo, nome, tipo, parentId, nivel, ordem) {
      const r = insert.run(codigo, nome, tipo, parentId, nivel, ordem);
      return r.lastInsertRowid;
    }
    const r1 = add('1',     'RECEITA OPERACIONAL',         'receita',    null, 1, 10);
      add('1.1',   'Receita de Vendas',                    'receita',    r1, 2, 11);
      add('1.2',   'Outras Receitas Operacionais',         'receita',    r1, 2, 12);
    const r2 = add('2',     'DEDUÇÕES DA RECEITA',         'deducao',    null, 1, 20);
      add('2.1',   'Impostos sobre Vendas (Simples)',     'deducao',    r2, 2, 21);
      add('2.2',   'Devoluções e Cancelamentos',          'deducao',    r2, 2, 22);
    const r3 = add('3',     'CUSTO DAS MERCADORIAS/SERVIÇOS', 'custo',  null, 1, 30);
      add('3.1',   'CMV — Custo de Mercadorias',          'custo',      r3, 2, 31);
      add('3.2',   'Custo dos Serviços Prestados',         'custo',      r3, 2, 32);
    const r4 = add('4',     'DESPESAS OPERACIONAIS',       'despesa',    null, 1, 40);
      add('4.1',   'Pessoal (Salários, Encargos)',        'despesa',    r4, 2, 41);
      add('4.2',   'Administrativas (Aluguel, Energia)',  'despesa',    r4, 2, 42);
      add('4.3',   'Comerciais (Marketing, Comissão)',    'despesa',    r4, 2, 43);
      add('4.4',   'Tecnologia',                           'despesa',    r4, 2, 44);
      add('4.5',   'Outras Despesas',                      'despesa',    r4, 2, 45);
    const r5 = add('5',     'RESULTADO FINANCEIRO',        'financeiro_receita', null, 1, 50);
      add('5.1',   'Receitas Financeiras (Juros recebidos)','financeiro_receita', r5, 2, 51);
      add('5.2',   'Despesas Financeiras (Juros, taxas)',  'financeiro_despesa', r5, 2, 52);
    const r6 = add('6',     'INVESTIMENTOS',               'investimento', null, 1, 60);
      add('6.1',   'Aquisição de Imobilizado',             'investimento', r6, 2, 61);
    const r9 = add('9',     'TRANSFERÊNCIAS',              'transferencia', null, 1, 90);
      add('9.1',   'Transferência entre contas',          'transferencia', r9, 2, 91);
  }
}

function registrarRotasGerencial(app, db) {
  migrarDB(db);

  // ==================== CENTROS DE CUSTO ====================

  app.get('/api/centros-custo', (req, res) => {
    try {
      const lista = db.prepare('SELECT * FROM centros_custo WHERE ativo = 1 ORDER BY codigo, nome').all();
      res.json({ success: true, centros: lista });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/centros-custo', (req, res) => {
    try {
      const { codigo, nome, descricao } = req.body;
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const r = db.prepare('INSERT INTO centros_custo (codigo, nome, descricao) VALUES (?, ?, ?)').run(codigo || null, nome, descricao || null);
      logAction(db, req, 'criar', 'centro-custo', r.lastInsertRowid, { codigo, nome });
      res.json({ success: true, centro: db.prepare('SELECT * FROM centros_custo WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/centros-custo/:id', (req, res) => {
    try {
      const { codigo, nome, descricao, ativo } = req.body;
      const sets = [], vals = [];
      if (codigo !== undefined)    { sets.push('codigo = ?');    vals.push(codigo); }
      if (nome !== undefined)      { sets.push('nome = ?');      vals.push(nome); }
      if (descricao !== undefined) { sets.push('descricao = ?'); vals.push(descricao); }
      if (ativo !== undefined)     { sets.push('ativo = ?');     vals.push(ativo ? 1 : 0); }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.id);
      db.prepare(`UPDATE centros_custo SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      logAction(db, req, 'editar', 'centro-custo', req.params.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/centros-custo/:id', (req, res) => {
    try {
      db.prepare('UPDATE centros_custo SET ativo = 0 WHERE id = ?').run(req.params.id);
      logAction(db, req, 'desativar', 'centro-custo', req.params.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== PLANO DE CONTAS ====================

  app.get('/api/plano-contas', (req, res) => {
    try {
      const lista = db.prepare(`SELECT * FROM plano_contas WHERE ativo = 1 ORDER BY ordem, codigo`).all();
      // Monta árvore para conveniência do front
      const map = new Map(lista.map(n => [n.id, { ...n, children: [] }]));
      const roots = [];
      for (const n of map.values()) {
        if (n.parentId && map.has(n.parentId)) map.get(n.parentId).children.push(n);
        else roots.push(n);
      }
      res.json({ success: true, plano: lista, arvore: roots, tipos: TIPOS_PLANO });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/plano-contas', (req, res) => {
    try {
      const { codigo, nome, tipo, parentId, ordem } = req.body;
      if (!codigo || !nome || !tipo) return res.status(400).json({ success: false, error: 'codigo, nome e tipo obrigatórios' });
      if (!TIPOS_PLANO.includes(tipo)) return res.status(400).json({ success: false, error: `tipo inválido. Use: ${TIPOS_PLANO.join(', ')}` });
      let nivel = 1;
      if (parentId) {
        const p = db.prepare('SELECT nivel FROM plano_contas WHERE id = ?').get(parentId);
        if (!p) return res.status(404).json({ success: false, error: 'parentId não encontrado' });
        nivel = p.nivel + 1;
      }
      const r = db.prepare('INSERT INTO plano_contas (codigo, nome, tipo, parentId, nivel, ordem) VALUES (?, ?, ?, ?, ?, ?)')
        .run(codigo, nome, tipo, parentId || null, nivel, ordem || 0);
      logAction(db, req, 'criar', 'plano-contas', r.lastInsertRowid, { codigo, nome, tipo });
      res.json({ success: true, conta: db.prepare('SELECT * FROM plano_contas WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/plano-contas/:id', (req, res) => {
    try {
      const { codigo, nome, tipo, ordem, ativo } = req.body;
      const sets = [], vals = [];
      if (codigo !== undefined) { sets.push('codigo = ?'); vals.push(codigo); }
      if (nome !== undefined)   { sets.push('nome = ?');   vals.push(nome); }
      if (tipo !== undefined)   {
        if (!TIPOS_PLANO.includes(tipo)) return res.status(400).json({ success: false, error: 'tipo inválido' });
        sets.push('tipo = ?'); vals.push(tipo);
      }
      if (ordem !== undefined) { sets.push('ordem = ?'); vals.push(ordem); }
      if (ativo !== undefined) { sets.push('ativo = ?'); vals.push(ativo ? 1 : 0); }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.id);
      db.prepare(`UPDATE plano_contas SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      logAction(db, req, 'editar', 'plano-contas', req.params.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/plano-contas/:id', (req, res) => {
    try {
      const filhos = db.prepare('SELECT id FROM plano_contas WHERE parentId = ? AND ativo = 1').get(req.params.id);
      if (filhos) return res.status(400).json({ success: false, error: 'Conta tem filhos ativos — desative-os primeiro' });
      db.prepare('UPDATE plano_contas SET ativo = 0 WHERE id = ?').run(req.params.id);
      logAction(db, req, 'desativar', 'plano-contas', req.params.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== DRE ====================
  // Critério: regime de caixa (data de pagamento). Para regime de competência, usar dataEmissao.
  // Filtros: dataIni, dataFim (obrigatórios), centroCustoId, regime ('caixa'|'competencia')

  app.get('/api/dre', (req, res) => {
    try {
      const { dataIni, dataFim, centroCustoId, regime } = req.query;
      if (!dataIni || !dataFim) return res.status(400).json({ success: false, error: 'dataIni e dataFim obrigatórios' });
      const campoData = (regime === 'competencia') ? 'dataEmissao' : 'dataPagamento';
      const filtroCentro = centroCustoId ? ' AND centroCustoId = ?' : '';
      const params = [dataIni, dataFim];
      if (centroCustoId) params.push(Number(centroCustoId));

      // Receitas (CR pagas no período, ou emitidas se competência).
      // Plano 12: resolve plano via coluna direta `cr.planoContaId` (preferido)
      // com fallback para a categoria mapeada (compat. com dados antigos).
      const receitas = db.prepare(`
        SELECT pc.id AS planoId, pc.codigo, pc.nome, pc.tipo, pc.parentId, pc.nivel,
               COALESCE(SUM(cr.valor), 0) AS total
        FROM contas_a_receber cr
        LEFT JOIN categorias_cr cat ON cat.id = cr.categoriaId
        LEFT JOIN plano_contas pc ON pc.id = COALESCE(cr.planoContaId, cat.planoContaId)
        WHERE cr.${campoData} >= ? AND cr.${campoData} <= ?
          AND cr.status ${regime === 'competencia' ? "IN ('aberta','paga','parcial')" : "= 'paga'"}
          ${filtroCentro}
        GROUP BY pc.id, pc.codigo, pc.nome, pc.tipo, pc.parentId, pc.nivel
      `).all(...params);

      // Despesas (CP pagas no período)
      const despesas = db.prepare(`
        SELECT pc.id AS planoId, pc.codigo, pc.nome, pc.tipo, pc.parentId, pc.nivel,
               COALESCE(SUM(cp.valor), 0) AS total
        FROM contas_a_pagar cp
        LEFT JOIN categorias_cp cat ON cat.id = cp.categoriaId
        LEFT JOIN plano_contas pc ON pc.id = COALESCE(cp.planoContaId, cat.planoContaId)
        WHERE cp.${campoData} >= ? AND cp.${campoData} <= ?
          AND cp.status ${regime === 'competencia' ? "IN ('aberta','paga','parcial')" : "= 'paga'"}
          ${filtroCentro}
        GROUP BY pc.id, pc.codigo, pc.nome, pc.tipo, pc.parentId, pc.nivel
      `).all(...params);

      // Sem categoria/sem plano → vai para "Sem classificação"
      const semClassificacaoR = receitas.find(r => !r.planoId);
      const semClassificacaoD = despesas.find(d => !d.planoId);
      const movs = [...receitas, ...despesas].filter(x => x.planoId);

      // Carrega árvore completa do plano para totalizar pais
      const todasContas = db.prepare('SELECT * FROM plano_contas WHERE ativo = 1 ORDER BY ordem, codigo').all();
      const map = new Map(todasContas.map(n => [n.id, { ...n, total: 0, children: [] }]));
      // soma direta
      for (const m of movs) {
        const node = map.get(m.planoId);
        if (node) node.total += Number(m.total) || 0;
      }
      // monta árvore
      const roots = [];
      for (const n of map.values()) {
        if (n.parentId && map.has(n.parentId)) map.get(n.parentId).children.push(n);
        else roots.push(n);
      }
      // soma recursiva
      function soma(n) {
        for (const c of n.children) soma(c);
        n.totalConsolidado = n.total + n.children.reduce((s, c) => s + c.totalConsolidado, 0);
      }
      roots.forEach(soma);

      // Cálculos finais
      const totalReceitas = roots.filter(n => n.tipo === 'receita').reduce((s,n)=>s+n.totalConsolidado, 0);
      const totalDeducoes = roots.filter(n => n.tipo === 'deducao').reduce((s,n)=>s+n.totalConsolidado, 0);
      const receitaLiquida = totalReceitas - totalDeducoes;
      const totalCustos   = roots.filter(n => n.tipo === 'custo').reduce((s,n)=>s+n.totalConsolidado, 0);
      const lucroBruto    = receitaLiquida - totalCustos;
      const totalDespesas = roots.filter(n => n.tipo === 'despesa').reduce((s,n)=>s+n.totalConsolidado, 0);
      const ebitda        = lucroBruto - totalDespesas;
      const finReceita    = roots.filter(n => n.tipo === 'financeiro_receita').reduce((s,n)=>s+n.totalConsolidado, 0);
      const finDespesa    = roots.filter(n => n.tipo === 'financeiro_despesa').reduce((s,n)=>s+n.totalConsolidado, 0);
      const resultado     = ebitda + finReceita - finDespesa;

      res.json({
        success: true,
        periodo: { dataIni, dataFim, regime: regime || 'caixa' },
        arvore: roots,
        sumario: {
          totalReceitas, totalDeducoes, receitaLiquida,
          totalCustos, lucroBruto,
          totalDespesas, ebitda,
          finReceita, finDespesa, resultado
        },
        semClassificacao: {
          receitas: Number(semClassificacaoR?.total || 0),
          despesas: Number(semClassificacaoD?.total || 0)
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasGerencial };
