/**
 * tipos-operacao-routes.js — Entidade "Tipo de Operação" (2026-04-23).
 *
 * Substitui o conceito raso de CFOP-com-flags: o Tipo de Operação é o cabeçalho
 * gerencial do pedido/devolução/fatura que define:
 *   - se a operação gera financeiro (contas_a_receber)
 *   - se movimenta estoque
 *   - se emite NF-e
 *   - se entra no DRE (gerencial)
 *   - qual finalidade NF-e (1=normal, 2=complementar, 3=ajuste, 4=devolução)
 *   - CFOP default por destino (interno / interestadual / exterior)
 *   - texto padrão para o natOp da NF-e
 *
 * Mudanças relacionadas:
 *   - pedidos.tipoOperacaoId       — FK NOT NULL (default 1 = VDA-NORMAL)
 *   - devolucoes.tipoOperacaoId    — FK (default 5 = DEV-DEFEITO)
 *   - pedidos.naoEmitirNFe         — DEPRECADO (migra pra tipoOperacao.emiteNFe=0)
 *   - cfops.{geraFinanceiro,movimentaEstoque,finalidadeNFe,categoriaOperacao}
 *     continuam no schema mas ficam LEGACY — consumidores passam a ler do tipo.
 *   - cfops_regras — tabela obsoleta (motor ignora).
 *
 * Motor `sugerirCFOP` (2ª geração):
 *   sugerirCFOP(db, { tipoOperacaoId, produtoId, clienteId, ufEntrega })
 *     1. Carrega tipo → pega cfop default conforme destino (interno/interestadual/exterior)
 *     2. Refina: consumidor final interestadual em venda → usa variante não-contribuinte
 *     3. Override: produto.cfopPadrao se casar com destino+tipoOperacao
 */

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* ok */ } }

const SEED_TIPOS = [
  {
    codigo: 'VDA-NORMAL', descricao: 'Venda normal',
    categoriaOperacao: 'venda',
    finalidadeNFe: 1, geraFinanceiro: 1, movimentaEstoque: 1, gerencial: 1, emiteNFe: 1,
    cfopInterno: '5102', cfopInterestadual: '6102', cfopExterior: '7102',
    textoPadraoNFe: 'VENDA DE MERCADORIA',
    observacaoFiscalPadrao: null
  },
  {
    codigo: 'VDA-ORDEM', descricao: 'Venda à ordem (entrega por conta e ordem)',
    categoriaOperacao: 'venda',
    finalidadeNFe: 1, geraFinanceiro: 1, movimentaEstoque: 1, gerencial: 1, emiteNFe: 1,
    cfopInterno: '5120', cfopInterestadual: '6120', cfopExterior: null,
    textoPadraoNFe: 'VENDA À ORDEM',
    observacaoFiscalPadrao: 'Mercadoria entregue ao destinatário por conta e ordem do adquirente originário'
  },
  {
    codigo: 'VDA-BONIF', descricao: 'Bonificação / brinde / doação',
    categoriaOperacao: 'bonificacao',
    finalidadeNFe: 1, geraFinanceiro: 0, movimentaEstoque: 1, gerencial: 0, emiteNFe: 1,
    cfopInterno: '5910', cfopInterestadual: '6910', cfopExterior: null,
    textoPadraoNFe: 'REMESSA EM BONIFICACAO, DOACAO OU BRINDE',
    observacaoFiscalPadrao: 'Operacao sem valor de cobranca — art. regulamento ICMS'
  },
  {
    codigo: 'VDA-NAOFISCAL', descricao: 'Venda sem NF-e (documento interno)',
    categoriaOperacao: 'venda',
    finalidadeNFe: 1, geraFinanceiro: 1, movimentaEstoque: 1, gerencial: 1, emiteNFe: 0,
    cfopInterno: null, cfopInterestadual: null, cfopExterior: null,
    textoPadraoNFe: null,
    observacaoFiscalPadrao: null
  },
  {
    codigo: 'REM-SIMPLES', descricao: 'Simples remessa',
    categoriaOperacao: 'remessa',
    finalidadeNFe: 1, geraFinanceiro: 0, movimentaEstoque: 0, gerencial: 0, emiteNFe: 1,
    cfopInterno: '5949', cfopInterestadual: '6949', cfopExterior: null,
    textoPadraoNFe: 'SIMPLES REMESSA',
    observacaoFiscalPadrao: null
  },
  {
    codigo: 'DEV-DEFEITO', descricao: 'Devolução de venda — defeito',
    categoriaOperacao: 'devolucao_venda',
    finalidadeNFe: 4, geraFinanceiro: 1, movimentaEstoque: 1, gerencial: 1, emiteNFe: 1,
    cfopInterno: '1202', cfopInterestadual: '2202', cfopExterior: '3202',
    textoPadraoNFe: 'DEVOLUCAO DE VENDA — MERCADORIA DEFEITUOSA',
    observacaoFiscalPadrao: 'Devolucao por defeito de fabricacao'
  },
  {
    codigo: 'DEV-ARREP', descricao: 'Devolução de venda — arrependimento',
    categoriaOperacao: 'devolucao_venda',
    finalidadeNFe: 4, geraFinanceiro: 1, movimentaEstoque: 1, gerencial: 1, emiteNFe: 1,
    cfopInterno: '1202', cfopInterestadual: '2202', cfopExterior: '3202',
    textoPadraoNFe: 'DEVOLUCAO DE VENDA — ARREPENDIMENTO (CDC ART 49)',
    observacaoFiscalPadrao: 'Direito de arrependimento — art. 49 CDC'
  },
  {
    codigo: 'DEV-TROCA', descricao: 'Devolução de venda — troca',
    categoriaOperacao: 'devolucao_venda',
    finalidadeNFe: 4, geraFinanceiro: 1, movimentaEstoque: 1, gerencial: 1, emiteNFe: 1,
    cfopInterno: '1202', cfopInterestadual: '2202', cfopExterior: '3202',
    textoPadraoNFe: 'DEVOLUCAO DE VENDA — TROCA',
    observacaoFiscalPadrao: 'Operacao vinculada a troca comercial'
  },
  {
    codigo: 'TRANSF', descricao: 'Transferência entre filiais',
    categoriaOperacao: 'transferencia',
    finalidadeNFe: 1, geraFinanceiro: 0, movimentaEstoque: 1, gerencial: 0, emiteNFe: 1,
    cfopInterno: '5152', cfopInterestadual: '6152', cfopExterior: null,
    textoPadraoNFe: 'TRANSFERENCIA ENTRE FILIAIS',
    observacaoFiscalPadrao: null
  },
  // Tipos para Ordens de Serviço (NFS-e / serviços). CFOPs não se aplicam (NFS-e usa código
  // municipal de serviço), mas as flags gerenciais são as mesmas.
  {
    codigo: 'OS-NORMAL', descricao: 'OS normal (NFS-e + cobrança)',
    categoriaOperacao: 'servico',
    finalidadeNFe: 1, geraFinanceiro: 1, movimentaEstoque: 1, gerencial: 1, emiteNFe: 1,
    cfopInterno: null, cfopInterestadual: null, cfopExterior: null,
    textoPadraoNFe: 'PRESTACAO DE SERVICO',
    observacaoFiscalPadrao: null
  },
  {
    codigo: 'OS-INTERNA', descricao: 'OS interna (sem NFS-e, com cobrança)',
    categoriaOperacao: 'servico',
    finalidadeNFe: 1, geraFinanceiro: 1, movimentaEstoque: 1, gerencial: 1, emiteNFe: 0,
    cfopInterno: null, cfopInterestadual: null, cfopExterior: null,
    textoPadraoNFe: null,
    observacaoFiscalPadrao: null
  },
  {
    codigo: 'OS-GARANTIA', descricao: 'OS em garantia (sem NFS-e, sem cobrança)',
    categoriaOperacao: 'servico',
    finalidadeNFe: 1, geraFinanceiro: 0, movimentaEstoque: 1, gerencial: 0, emiteNFe: 0,
    cfopInterno: null, cfopInterestadual: null, cfopExterior: null,
    textoPadraoNFe: null,
    observacaoFiscalPadrao: 'Servico em garantia — sem onus ao cliente'
  }
];

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tipos_operacao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      descricao TEXT NOT NULL,
      categoriaOperacao TEXT,
      finalidadeNFe INTEGER DEFAULT 1,
      geraFinanceiro INTEGER DEFAULT 1,
      movimentaEstoque INTEGER DEFAULT 1,
      gerencial INTEGER DEFAULT 1,
      emiteNFe INTEGER DEFAULT 1,
      cfopInterno TEXT,
      cfopInterestadual TEXT,
      cfopExterior TEXT,
      textoPadraoNFe TEXT,
      observacaoFiscalPadrao TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tipos_op_ativo ON tipos_operacao(ativo);
    CREATE INDEX IF NOT EXISTS idx_tipos_op_categoria ON tipos_operacao(categoriaOperacao);
  `);

  // Colunas novas em tabelas que usam tipo de operação.
  alterSafe(db, 'ALTER TABLE pedidos ADD COLUMN tipoOperacaoId INTEGER');
  alterSafe(db, 'ALTER TABLE devolucoes ADD COLUMN tipoOperacaoId INTEGER');
  alterSafe(db, 'ALTER TABLE faturas ADD COLUMN tipoOperacaoId INTEGER');
  alterSafe(db, 'ALTER TABLE os_ordens ADD COLUMN tipoOperacaoId INTEGER');
  // Default por tipo de OS (Conserto, Instalação, etc.) — aponta para tipoOperacao usado ao criar.
  alterSafe(db, 'ALTER TABLE os_tipos ADD COLUMN tipoOperacaoPadraoId INTEGER');

  // Seed idempotente — UPSERT por código.
  const insTipo = db.prepare(`INSERT OR IGNORE INTO tipos_operacao
    (codigo, descricao, categoriaOperacao, finalidadeNFe, geraFinanceiro, movimentaEstoque,
     gerencial, emiteNFe, cfopInterno, cfopInterestadual, cfopExterior, textoPadraoNFe, observacaoFiscalPadrao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const txSeed = db.transaction(() => {
    for (const t of SEED_TIPOS) {
      insTipo.run(t.codigo, t.descricao, t.categoriaOperacao, t.finalidadeNFe,
        t.geraFinanceiro, t.movimentaEstoque, t.gerencial, t.emiteNFe,
        t.cfopInterno, t.cfopInterestadual, t.cfopExterior,
        t.textoPadraoNFe, t.observacaoFiscalPadrao);
    }
  });
  txSeed();

  // Migração de dados legados:
  //   - pedidos.naoEmitirNFe=1 → tipoOperacaoId = id de VDA-NAOFISCAL
  //   - pedidos sem tipo → VDA-NORMAL
  const tipoNormal = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = 'VDA-NORMAL'`).get();
  const tipoNaoFiscal = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = 'VDA-NAOFISCAL'`).get();
  const tipoDevDefeito = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = 'DEV-DEFEITO'`).get();

  if (tipoNormal) {
    db.prepare(`UPDATE pedidos SET tipoOperacaoId = ? WHERE tipoOperacaoId IS NULL AND (naoEmitirNFe IS NULL OR naoEmitirNFe = 0)`)
      .run(tipoNormal.id);
  }
  if (tipoNaoFiscal) {
    db.prepare(`UPDATE pedidos SET tipoOperacaoId = ? WHERE tipoOperacaoId IS NULL AND naoEmitirNFe = 1`)
      .run(tipoNaoFiscal.id);
  }
  if (tipoDevDefeito) {
    // Guard: devolucoes é criada por devolucoes-routes, que registra DEPOIS
    // deste módulo — em tenant novo a tabela ainda não existe na 1ª passada.
    // Sem o try, o throw aborta o registro de TODOS os módulos seguintes.
    try {
      db.prepare(`UPDATE devolucoes SET tipoOperacaoId = ? WHERE tipoOperacaoId IS NULL`)
        .run(tipoDevDefeito.id);
    } catch { /* tabela ainda não existe — backfill roda na próxima migração */ }
  }

  // Backfill de faturas: copia tipoOperacaoId do pedido de origem (ou devolução).
  db.prepare(`UPDATE faturas SET tipoOperacaoId = (
    SELECT p.tipoOperacaoId FROM pedidos p WHERE p.id = faturas.pedidoId
  ) WHERE tipoOperacaoId IS NULL AND pedidoId IS NOT NULL
    AND (isDevolucao IS NULL OR isDevolucao = 0)`).run();
  try {
    db.prepare(`UPDATE faturas SET tipoOperacaoId = (
      SELECT d.tipoOperacaoId FROM devolucoes d WHERE d.id = faturas.devolucaoId
    ) WHERE tipoOperacaoId IS NULL AND devolucaoId IS NOT NULL AND isDevolucao = 1`).run();
  } catch { /* idem: depende de devolucoes */ }

  // Backfill de OS: derivado de emGarantia > (naoEmitirNFe || ambienteFiscal='interno') > normal.
  const tipoOsNormal   = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = 'OS-NORMAL'`).get();
  const tipoOsInterna  = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = 'OS-INTERNA'`).get();
  const tipoOsGarantia = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = 'OS-GARANTIA'`).get();
  // Guard: os_ordens é criada por os-routes, que registra DEPOIS deste módulo
  // (mesmo caso do guard de devolucoes acima) — em tenant sem a tabela, o
  // throw abortaria o registro de todos os módulos seguintes.
  try {
    if (tipoOsGarantia) {
      db.prepare(`UPDATE os_ordens SET tipoOperacaoId = ?
        WHERE tipoOperacaoId IS NULL AND emGarantia = 1`).run(tipoOsGarantia.id);
    }
    if (tipoOsInterna) {
      db.prepare(`UPDATE os_ordens SET tipoOperacaoId = ?
        WHERE tipoOperacaoId IS NULL
          AND (naoEmitirNFe = 1 OR ambienteFiscal = 'interno' OR ambienteFiscal = 'nenhum')`).run(tipoOsInterna.id);
    }
    if (tipoOsNormal) {
      db.prepare(`UPDATE os_ordens SET tipoOperacaoId = ?
        WHERE tipoOperacaoId IS NULL`).run(tipoOsNormal.id);
    }
  } catch { /* tabela ainda não existe — backfill roda na próxima migração */ }
}

function determinarDestino(ufEmitente, ufDestino) {
  if (!ufDestino) return 'interno';
  const e = (ufEmitente || '').toUpperCase();
  const d = (ufDestino || '').toUpperCase();
  if (d === 'EX' || d === 'EXTERIOR') return 'exterior';
  return e === d ? 'interno' : 'interestadual';
}

/**
 * Motor de sugestão de CFOP baseado em Tipo de Operação.
 *
 * @param {Database} db
 * @param {object} params
 * @param {number} params.tipoOperacaoId  — obrigatório (default = VDA-NORMAL se ausente)
 * @param {number} [params.produtoId]     — para aplicar override de cfopPadrao
 * @param {number} [params.clienteId]     — para detectar contribuinte ICMS
 * @param {string} [params.ufEntrega]     — para definir destino
 * @returns {{ cfop, cfopDescricao, contexto, tipo }}
 */
function sugerirCFOP(db, params) {
  const { produtoId, clienteId, ufEntrega } = params;
  let tipoOperacaoId = params.tipoOperacaoId;

  // Carrega tipo; se não informado, usa VDA-NORMAL.
  let tipo = tipoOperacaoId
    ? db.prepare('SELECT * FROM tipos_operacao WHERE id = ? AND ativo = 1').get(tipoOperacaoId)
    : null;
  if (!tipo) {
    tipo = db.prepare(`SELECT * FROM tipos_operacao WHERE codigo = 'VDA-NORMAL' AND ativo = 1`).get();
  }
  if (!tipo) throw new Error('Nenhum tipo de operação cadastrado. Seed não executado?');

  // Tipo "venda sem NF-e" não tem CFOP (não emite doc fiscal).
  if (!tipo.emiteNFe) {
    return {
      cfop: null,
      cfopDescricao: null,
      contexto: { tipoOperacao: tipo.codigo, emiteNFe: false },
      tipo
    };
  }

  const emitente = db.prepare('SELECT uf FROM fornecedor WHERE id = 1').get();
  const cliente = clienteId ? db.prepare('SELECT id, uf, contribuinteIcms FROM pessoas WHERE id = ?').get(clienteId) : null;
  const produto = produtoId ? db.prepare('SELECT id, cfopPadrao FROM produtos WHERE id = ?').get(produtoId) : null;

  const ufDest = ufEntrega || cliente?.uf || emitente?.uf;
  const destino = determinarDestino(emitente?.uf, ufDest);
  const clienteEhContribuinte = cliente ? (cliente.contribuinteIcms ? 1 : 0) : null;

  // 1) CFOP default do tipo pelo destino.
  let cfopFinal = null;
  if (destino === 'interno') cfopFinal = tipo.cfopInterno;
  else if (destino === 'interestadual') cfopFinal = tipo.cfopInterestadual;
  else cfopFinal = tipo.cfopExterior;

  // 2) Refino: venda interestadual a não-contribuinte → 6108/6107 em vez de 6102/6101.
  //    Só para tipos categoria=venda e destino=interestadual.
  if (tipo.categoriaOperacao === 'venda' && destino === 'interestadual' && clienteEhContribuinte === 0) {
    if (cfopFinal === '6102') cfopFinal = '6108';
    else if (cfopFinal === '6101') cfopFinal = '6107';
  }

  // 3) Override por produto — se produto.cfopPadrao existe e casa com destino+tipoOperacao do CFOP alvo,
  //    respeita. Só para categoria=venda (em devolução/remessa/bonificação o tipo manda).
  if (tipo.categoriaOperacao === 'venda' && produto?.cfopPadrao) {
    const cfopProd = db.prepare('SELECT codigo, destino, tipoOperacao, descricao, ativo FROM cfops WHERE codigo = ?').get(produto.cfopPadrao);
    if (cfopProd?.ativo && cfopProd.destino === destino && cfopProd.tipoOperacao === 'saida') {
      cfopFinal = cfopProd.codigo;
    }
  }

  if (!cfopFinal) {
    throw new Error(`Tipo "${tipo.codigo}" não tem CFOP cadastrado para destino "${destino}"`);
  }

  const cfopMeta = db.prepare('SELECT codigo, descricao FROM cfops WHERE codigo = ?').get(cfopFinal);
  return {
    cfop: cfopFinal,
    cfopDescricao: cfopMeta?.descricao || null,
    contexto: {
      destino, ufEmitente: emitente?.uf, ufDestino: ufDest,
      clienteEhContribuinte,
      tipoOperacao: tipo.codigo, tipoOperacaoDescricao: tipo.descricao
    },
    tipo
  };
}

function registrarRotas(app, db) {
  migrar(db);

  app.get('/api/tipos-operacao', (req, res) => {
    try {
      const { ativo, categoria } = req.query;
      let sql = 'SELECT * FROM tipos_operacao WHERE 1=1';
      const p = [];
      if (ativo !== undefined) { sql += ' AND ativo = ?'; p.push(Number(ativo)); }
      else { sql += ' AND ativo = 1'; }
      if (categoria) { sql += ' AND categoriaOperacao = ?'; p.push(categoria); }
      sql += ' ORDER BY descricao ASC';
      res.json({ success: true, tipos: db.prepare(sql).all(...p) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/tipos-operacao/:id', (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM tipos_operacao WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Tipo não encontrado' });
      res.json({ success: true, tipo: t });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/tipos-operacao', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.codigo || !b.descricao) return res.status(400).json({ success: false, error: 'codigo e descricao obrigatórios' });
      const r = db.prepare(`INSERT INTO tipos_operacao
        (codigo, descricao, categoriaOperacao, finalidadeNFe, geraFinanceiro, movimentaEstoque,
         gerencial, emiteNFe, cfopInterno, cfopInterestadual, cfopExterior,
         textoPadraoNFe, observacaoFiscalPadrao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        b.codigo.trim(), b.descricao.trim(), b.categoriaOperacao || null,
        b.finalidadeNFe != null ? Number(b.finalidadeNFe) : 1,
        b.geraFinanceiro != null ? (b.geraFinanceiro ? 1 : 0) : 1,
        b.movimentaEstoque != null ? (b.movimentaEstoque ? 1 : 0) : 1,
        b.gerencial != null ? (b.gerencial ? 1 : 0) : 1,
        b.emiteNFe != null ? (b.emiteNFe ? 1 : 0) : 1,
        b.cfopInterno || null, b.cfopInterestadual || null, b.cfopExterior || null,
        b.textoPadraoNFe || null, b.observacaoFiscalPadrao || null
      );
      res.json({ success: true, tipo: db.prepare('SELECT * FROM tipos_operacao WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/tipos-operacao/:id', (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM tipos_operacao WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Tipo não encontrado' });
      const b = req.body || {};
      db.prepare(`UPDATE tipos_operacao SET
        codigo = ?, descricao = ?, categoriaOperacao = ?, finalidadeNFe = ?,
        geraFinanceiro = ?, movimentaEstoque = ?, gerencial = ?, emiteNFe = ?,
        cfopInterno = ?, cfopInterestadual = ?, cfopExterior = ?,
        textoPadraoNFe = ?, observacaoFiscalPadrao = ?, ativo = ?,
        dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(
        b.codigo ?? atual.codigo,
        b.descricao ?? atual.descricao,
        b.categoriaOperacao ?? atual.categoriaOperacao,
        b.finalidadeNFe != null ? Number(b.finalidadeNFe) : atual.finalidadeNFe,
        b.geraFinanceiro != null ? (b.geraFinanceiro ? 1 : 0) : atual.geraFinanceiro,
        b.movimentaEstoque != null ? (b.movimentaEstoque ? 1 : 0) : atual.movimentaEstoque,
        b.gerencial != null ? (b.gerencial ? 1 : 0) : atual.gerencial,
        b.emiteNFe != null ? (b.emiteNFe ? 1 : 0) : atual.emiteNFe,
        b.cfopInterno ?? atual.cfopInterno,
        b.cfopInterestadual ?? atual.cfopInterestadual,
        b.cfopExterior ?? atual.cfopExterior,
        b.textoPadraoNFe ?? atual.textoPadraoNFe,
        b.observacaoFiscalPadrao ?? atual.observacaoFiscalPadrao,
        b.ativo != null ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id
      );
      res.json({ success: true, tipo: db.prepare('SELECT * FROM tipos_operacao WHERE id = ?').get(req.params.id) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/tipos-operacao/:id', (req, res) => {
    try {
      const r = db.prepare('UPDATE tipos_operacao SET ativo = 0 WHERE id = ? AND ativo = 1').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Tipo não encontrado ou já inativo' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Sugestão de CFOP — endpoint dedicado para o testador (cadastro-cfops.html aba Testar).
  app.get('/api/tipos-operacao/sugerir-cfop', (req, res) => {
    try {
      const r = sugerirCFOP(db, {
        tipoOperacaoId: req.query.tipoOperacaoId ? Number(req.query.tipoOperacaoId) : null,
        clienteId: req.query.clienteId ? Number(req.query.clienteId) : null,
        produtoId: req.query.produtoId ? Number(req.query.produtoId) : null,
        ufEntrega: req.query.ufEntrega || null
      });
      res.json({ success: true, ...r });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[tipos-operacao] Rotas registradas');
}

module.exports = {
  registrarRotasTiposOperacao: registrarRotas,
  sugerirCFOP,
  migrar
};
