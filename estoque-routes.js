/**
 * estoque-routes.js — Saldo, movimentações, lotes, serial, valorização e alertas.
 * Depende das tabelas criadas por produtos-routes.js (produtos, movimentacoes_estoque).
 *
 * Uso no server.js:
 *   const { registrarRotasEstoque } = require('./estoque-routes');
 *   registrarRotasEstoque(app, db);
 */

const { logAction } = require('./audit-log');

const TIPOS_VALIDOS = new Set(['entrada', 'saida', 'ajuste']);

function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna ja existe */ } }

function migrarEstoqueDB(db) {
  // Colunas adicionais em produtos
  for (const col of [
    'rastreiaLote INTEGER DEFAULT 0',
    'rastreiaSerial INTEGER DEFAULT 0',
    'leadTimeDias INTEGER DEFAULT 0',
    'pontoReposicao REAL DEFAULT 0',
    'estoqueMaximo REAL DEFAULT 0',
    'localizacao TEXT'
  ]) {
    alterSafe(db, `ALTER TABLE produtos ADD COLUMN ${col}`);
  }

  // Colunas adicionais em movimentacoes_estoque
  for (const col of [
    'loteId INTEGER',
    'serialId INTEGER',
    'custoMedioAnterior REAL',
    'custoMedioPosterior REAL',
    'saldoPosterior REAL',
    'estornada INTEGER DEFAULT 0',
    'movEstornoId INTEGER',
    'movOriginalId INTEGER',
    'motivo TEXT',
    'usuarioId INTEGER',
    'usuario TEXT'
  ]) {
    alterSafe(db, `ALTER TABLE movimentacoes_estoque ADD COLUMN ${col}`);
  }

  // Colunas de auditoria em produtos (inativação)
  for (const col of [
    'desativadoEm TEXT',
    'desativadoPor TEXT',
    'motivoDesativacao TEXT'
  ]) {
    alterSafe(db, `ALTER TABLE produtos ADD COLUMN ${col}`);
  }

  // Tabela lotes
  db.exec(`
    CREATE TABLE IF NOT EXISTS lotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      numero TEXT NOT NULL,
      dataFabricacao TEXT,
      dataValidade TEXT,
      quantidadeInicial REAL NOT NULL,
      saldoAtual REAL NOT NULL,
      custoUnitario REAL,
      nfeEntradaId INTEGER,
      fornecedorId INTEGER,
      observacoes TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_lotes_produto ON lotes(produtoId, ativo);
    CREATE INDEX IF NOT EXISTS idx_lotes_validade ON lotes(dataValidade);
    CREATE INDEX IF NOT EXISTS idx_lotes_numero ON lotes(produtoId, numero);
  `);

  // Tabela serial_numbers
  db.exec(`
    CREATE TABLE IF NOT EXISTS serial_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      loteId INTEGER,
      numero TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'disponivel',
      movEntradaId INTEGER,
      movSaidaId INTEGER,
      pedidoId INTEGER,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produtoId) REFERENCES produtos(id),
      FOREIGN KEY (loteId) REFERENCES lotes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_serial_produto_status ON serial_numbers(produtoId, status);
  `);

  // Número de série é globalmente único (padrão de automação comercial: 1 unidade ↔ 1 serial,
  // serial não se repete entre produtos). Tenta criar o índice global; se dados legados tiverem
  // duplicatas entre produtos, mantém o índice antigo (por produto) como fallback.
  try {
    db.exec(`DROP INDEX IF EXISTS idx_serial_produto_numero;`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_serial_numero_unico ON serial_numbers(numero);`);
  } catch (err) {
    console.warn('[estoque] Mantendo unicidade por produto em serial_numbers.numero (há duplicatas entre produtos):', err.message);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_serial_produto_numero ON serial_numbers(produtoId, numero);`);
  }

  // ==================== MULTI-DEPÓSITO ====================
  // Convenção ANTIGA: depositoId NULL = depósito padrão, e os módulos que
  // não conhecem depósito (pedidos, OS, devoluções...) gravavam NULL.
  // Funcionava com um depósito só; com dois, toda venda/OS/devolução era
  // debitada do padrão independente de onde a mercadoria estava, e o erro
  // era invisível porque o total continuava certo.
  //
  // Convenção ATUAL (2026-07-31): todo INSERT passa por resolverDeposito(),
  // que nunca devolve NULL havendo depósito cadastrado. O COALESCE nas
  // consultas continua, para não quebrar o histórico anterior à migração.
  db.exec(`
    CREATE TABLE IF NOT EXISTS depositos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      tipo TEXT NOT NULL DEFAULT 'interno',
      enderecoTexto TEXT,
      padrao INTEGER DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare(`INSERT INTO depositos (nome, tipo, padrao)
              SELECT 'Principal', 'interno', 1
              WHERE NOT EXISTS (SELECT 1 FROM depositos)`).run();

  // Multi-loja (Fase 4): a que estabelecimento o depósito pertence (NULL = matriz).
  // Base para o saldo por loja — cada depósito herda a identidade fiscal do seu estab.
  alterSafe(db, 'ALTER TABLE depositos ADD COLUMN estabelecimentoId INTEGER');

  alterSafe(db, 'ALTER TABLE movimentacoes_estoque ADD COLUMN depositoId INTEGER');
  alterSafe(db, 'ALTER TABLE reservas_estoque ADD COLUMN depositoId INTEGER');
  alterSafe(db, 'ALTER TABLE lotes ADD COLUMN depositoId INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mov_deposito ON movimentacoes_estoque(depositoId, produtoId)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS transferencias_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      depositoOrigemId INTEGER NOT NULL,
      depositoDestinoId INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'rascunho',
      dataEnvio TEXT,
      dataRecebimento TEXT,
      usuario TEXT,
      observacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (depositoOrigemId) REFERENCES depositos(id),
      FOREIGN KEY (depositoDestinoId) REFERENCES depositos(id)
    );
    CREATE TABLE IF NOT EXISTS transferencia_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transferenciaId INTEGER NOT NULL,
      produtoId INTEGER NOT NULL,
      loteId INTEGER,
      quantidade REAL NOT NULL,
      movSaidaId INTEGER,
      movEntradaId INTEGER,
      FOREIGN KEY (transferenciaId) REFERENCES transferencias_estoque(id),
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_transf_itens ON transferencia_itens(transferenciaId);
    CREATE INDEX IF NOT EXISTS idx_transf_status ON transferencias_estoque(status);
  `);
}

/**
 * Custo unitário corrente de um produto, na mesma ordem em toda análise.
 * Antes cada consulta montava a sua: a valorização caía no precoCusto e a
 * evolução no custoUnitario da última entrada, então a mesma tela mostrava
 * dois "valor do estoque" diferentes. O `> 0` é proposital — havia entrada
 * gravada com custo zero, e um zero passando por "custo conhecido" apagava
 * o valor do saldo em silêncio.
 *
 * @param {string} p alias da tabela produtos
 * @param {string} ate `null` para custo atual, ou 'date(?)' para uma data de corte
 * @returns {{sql: string, params: number}} SQL e quantos '?' consome
 */
function sqlCustoAtual(p = 'p', ate = null) {
  const corte = ate ? ` AND date(x.data) <= ${ate}` : '';
  return {
    sql: `COALESCE(
      (SELECT x.custoMedioPosterior FROM movimentacoes_estoque x
        WHERE x.produtoId = ${p}.id AND x.custoMedioPosterior > 0${corte}
        ORDER BY date(x.data) DESC, x.id DESC LIMIT 1),
      (SELECT x.custoUnitario FROM movimentacoes_estoque x
        WHERE x.produtoId = ${p}.id AND x.tipo = 'entrada' AND x.custoUnitario > 0${corte}
        ORDER BY date(x.data) DESC, x.id DESC LIMIT 1),
      CASE WHEN ${p}.precoCusto > 0 THEN ${p}.precoCusto END,
      0)`,
    params: ate ? 2 : 0,
  };
}

function getDepositoPadraoId(db) {
  // Tolera tenant sem a tabela (boot parcial, banco de teste): devolver
  // null mantém o comportamento antigo — NULL = padrão pelo COALESCE — em
  // vez de derrubar toda movimentação de estoque.
  try {
    const row = db.prepare('SELECT id FROM depositos WHERE padrao = 1 AND ativo = 1 LIMIT 1').get()
      || db.prepare('SELECT id FROM depositos WHERE ativo = 1 ORDER BY id LIMIT 1').get();
    return row ? row.id : null;
  } catch { return null; }
}

/**
 * Decide o depósito de uma movimentação.
 *
 * Existe porque 13 dos 21 pontos que inserem em movimentacoes_estoque
 * gravavam NULL. O saldo por depósito usa COALESCE(depositoId, padrão),
 * então tudo caía no Principal e o multi-depósito virava ficção — sem
 * ninguém perceber, porque o total continuava certo.
 *
 * Ordem: valor explícito → depósito da movimentação de origem (estorno) →
 * depósito de onde a mercadoria saiu (devolução) → reserva → padrão.
 *
 * Nunca devolve NULL havendo depósito cadastrado: gravar o padrão
 * explicitamente torna o dado auditável — "saiu do Principal" passa a ser
 * uma afirmação, não uma inferência do COALESCE.
 */
function resolverDeposito(db, { depositoId, movOriginalId, pedidoId, osId, produtoId } = {}) {
  if (depositoId) return Number(depositoId);
  try {
    if (movOriginalId) {
      const m = db.prepare('SELECT depositoId FROM movimentacoes_estoque WHERE id = ?').get(movOriginalId);
      if (m && m.depositoId) return m.depositoId;
    }
    if (pedidoId && produtoId) {
      const s = db.prepare(`SELECT depositoId FROM movimentacoes_estoque
        WHERE origem = 'pedido' AND origemId = ? AND produtoId = ? AND tipo = 'saida'
          AND depositoId IS NOT NULL ORDER BY id DESC LIMIT 1`).get(pedidoId, produtoId);
      if (s && s.depositoId) return s.depositoId;
      const r = db.prepare(`SELECT depositoId FROM reservas_estoque
        WHERE pedidoId = ? AND produtoId = ? AND depositoId IS NOT NULL LIMIT 1`).get(pedidoId, produtoId);
      if (r && r.depositoId) return r.depositoId;
    }
    if (osId && produtoId) {
      const s = db.prepare(`SELECT depositoId FROM movimentacoes_estoque
        WHERE origem = 'os' AND origemId = ? AND produtoId = ? AND tipo = 'saida'
          AND depositoId IS NOT NULL ORDER BY id DESC LIMIT 1`).get(osId, produtoId);
      if (s && s.depositoId) return s.depositoId;
    }
  } catch { /* tabela ausente no tenant — cai no padrão */ }
  return getDepositoPadraoId(db);
}

// ==================== HELPERS ====================

/**
 * Calcula saldo atual de um produto (soma de entradas - saídas + ajustes).
 * Ajuste funciona como delta absoluto (positivo ou negativo).
 * Com depositoId: saldo apenas daquele depósito (NULL nas movimentações = depósito padrão).
 */
function calcularSaldo(db, produtoId, depositoId = null) {
  let sql = `
    SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
                             WHEN tipo='saida' THEN -quantidade
                             ELSE quantidade END), 0) AS saldo
    FROM movimentacoes_estoque WHERE produtoId = ?`;
  const params = [produtoId];
  if (depositoId != null) {
    sql += ' AND COALESCE(depositoId, ?) = ?';
    params.push(getDepositoPadraoId(db), Number(depositoId));
  }
  const row = db.prepare(sql).get(...params);
  return row.saldo || 0;
}

/**
 * Saldo de um produto quebrado POR ESTABELECIMENTO (loja). Multi-loja Fase 4.
 * Agrega as movimentações pelo estabelecimento do depósito (depósito sem estab
 * ou movimentação sem depósito → matriz). Devolve { lojas: [{estabelecimentoId,
 * nome, saldo}], total }. Catálogo é único do tenant; só o SALDO é por loja.
 */
function saldoPorEstabelecimento(db, produtoId) {
  const depPadrao = getDepositoPadraoId(db);
  const rows = db.prepare(`
    SELECT d.estabelecimentoId AS estabId,
           COALESCE(SUM(CASE WHEN m.tipo='entrada' THEN m.quantidade
                             WHEN m.tipo='saida' THEN -m.quantidade
                             ELSE m.quantidade END), 0) AS saldo
    FROM movimentacoes_estoque m
    LEFT JOIN depositos d ON d.id = COALESCE(m.depositoId, ?)
    WHERE m.produtoId = ?
    GROUP BY d.estabelecimentoId
  `).all(depPadrao, produtoId);

  const nomeEstab = (id) => {
    if (!id) return 'Matriz';
    const e = db.prepare('SELECT nomeFantasia, razaoSocial FROM estabelecimentos WHERE id = ?').get(id);
    return e ? (e.nomeFantasia || e.razaoSocial || `Estabelecimento ${id}`) : `Estabelecimento ${id}`;
  };

  // Consolida linhas de estabId NULL (matriz) numa só.
  const map = new Map();
  for (const r of rows) {
    const key = r.estabId || 0; // 0 = matriz
    map.set(key, (map.get(key) || 0) + Number(r.saldo));
  }
  const lojas = [...map.entries()]
    .map(([k, saldo]) => ({ estabelecimentoId: k || null, nome: nomeEstab(k || null), saldo }))
    .sort((a, b) => (a.estabelecimentoId || 0) - (b.estabelecimentoId || 0));
  const total = lojas.reduce((s, l) => s + l.saldo, 0);
  return { lojas, total };
}

/**
 * Calcula custo médio ponderado atual usando apenas entradas (weighted average).
 * Usa custoMedioPosterior da última movimentação (após backfill) como fonte de verdade
 * para performance; fallback para recálculo on-the-fly.
 */
function calcularCustoMedio(db, produtoId) {
  // Tenta ler do último registro com saldoPosterior preenchido
  const latest = db.prepare(`
    SELECT custoMedioPosterior FROM movimentacoes_estoque
    WHERE produtoId = ? AND custoMedioPosterior IS NOT NULL
    ORDER BY data DESC, id DESC LIMIT 1
  `).get(produtoId);
  if (latest && latest.custoMedioPosterior != null) return latest.custoMedioPosterior;

  // Fallback: weighted avg das entradas
  const row = db.prepare(`
    SELECT SUM(quantidade * COALESCE(custoUnitario, 0)) AS valorTotal,
           SUM(quantidade) AS qtdTotal
    FROM movimentacoes_estoque
    WHERE produtoId = ? AND tipo = 'entrada' AND custoUnitario IS NOT NULL
  `).get(produtoId);
  if (!row || !row.qtdTotal) return 0;
  return row.valorTotal / row.qtdTotal;
}

/**
 * Aplica lógica de custo médio + saldo retroativamente a partir dos valores atuais.
 * Retorna { saldoPosterior, custoMedioAnterior, custoMedioPosterior }.
 */
function calcularContextoMovimento(db, produtoId, tipo, quantidade, custoUnitario) {
  const saldoAntes = calcularSaldo(db, produtoId);
  const custoMedioAntes = calcularCustoMedio(db, produtoId);

  let saldoDepois = saldoAntes;
  let custoMedioDepois = custoMedioAntes;
  const qtd = Number(quantidade);

  if (tipo === 'entrada') {
    saldoDepois = saldoAntes + qtd;
    if (custoUnitario != null && saldoDepois > 0) {
      if (saldoAntes <= 0 || custoMedioAntes <= 0) {
        custoMedioDepois = Number(custoUnitario);
      } else {
        custoMedioDepois = (saldoAntes * custoMedioAntes + qtd * Number(custoUnitario)) / saldoDepois;
      }
    }
  } else if (tipo === 'saida') {
    saldoDepois = saldoAntes - qtd;
    // saídas não mudam custo médio (princípio weighted avg)
  } else if (tipo === 'ajuste') {
    saldoDepois = saldoAntes + qtd; // ajuste é delta (positivo ou negativo)
    // Ajuste não altera custo médio por padrão
  }

  return {
    saldoPosterior: saldoDepois,
    custoMedioAnterior: custoMedioAntes || null,
    custoMedioPosterior: custoMedioDepois || null
  };
}

/**
 * Atualiza saldoAtual de um lote após movimentação.
 */
function atualizarSaldoLote(db, loteId, delta) {
  if (!loteId) return;
  db.prepare('UPDATE lotes SET saldoAtual = saldoAtual + ? WHERE id = ?').run(Number(delta), loteId);
}

function registrarRotasEstoque(app, db) {
  migrarEstoqueDB(db);

  // Saldo de um produto quebrado por estabelecimento (loja) + total consolidado.
  app.get('/api/estoque/:produtoId/saldo-lojas', (req, res) => {
    try {
      res.json({ success: true, ...saldoPorEstabelecimento(db, Number(req.params.produtoId)) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== LISTAGEM COM SALDO + CUSTO MÉDIO + VALORIZAÇÃO ====================

  app.get('/api/estoque', (req, res) => {
    try {
      const { q, rastreiaLote, rastreiaSerial, depositoId } = req.query;
      const depPadrao = getDepositoPadraoId(db);
      const filtroDep = depositoId ? ` AND COALESCE(depositoId, ${Number(depPadrao)}) = ${Number(depositoId)}` : '';
      let sql = `SELECT p.id, p.sku, p.descricao, p.unidade, p.precoCusto, p.precoVenda,
        p.estoqueMinimo, p.pontoReposicao, p.estoqueMaximo, p.leadTimeDias, p.localizacao,
        p.rastreiaLote, p.rastreiaSerial,
        COALESCE((SELECT SUM(CASE WHEN tipo='entrada' THEN quantidade
                                  WHEN tipo='saida' THEN -quantidade
                                  ELSE quantidade END)
                  FROM movimentacoes_estoque WHERE produtoId = p.id${filtroDep}), 0) AS saldo,
        COALESCE((SELECT SUM(quantidade) FROM reservas_estoque
                  WHERE produtoId = p.id AND status = 'ativa'${filtroDep}), 0) AS reservado,
        COALESCE((SELECT custoMedioPosterior FROM movimentacoes_estoque
                  WHERE produtoId = p.id AND custoMedioPosterior IS NOT NULL
                  ORDER BY data DESC, id DESC LIMIT 1), p.precoCusto) AS custoMedio
        FROM produtos p WHERE p.ativo = 1`;
      const params = [];
      if (q) {
        sql += ' AND (p.sku LIKE ? OR p.descricao LIKE ?)';
        const like = `%${q}%`;
        params.push(like, like);
      }
      if (rastreiaLote === '1') sql += ' AND p.rastreiaLote = 1';
      if (rastreiaSerial === '1') sql += ' AND p.rastreiaSerial = 1';
      sql += ' ORDER BY p.descricao ASC';
      const itens = db.prepare(sql).all(...params).map(i => ({
        ...i,
        disponivel: (i.saldo || 0) - (i.reservado || 0),
        valorEstoque: (i.saldo || 0) * (i.custoMedio || 0)
      }));
      const total = {
        valorTotal: itens.reduce((s, i) => s + i.valorEstoque, 0),
        qtdProdutos: itens.length,
        produtosComSaldo: itens.filter(i => i.saldo > 0).length,
        totalReservado: itens.reduce((s, i) => s + (i.reservado || 0), 0),
        comReservaAtiva: itens.filter(i => i.reservado > 0).length
      };
      res.json({ success: true, itens, total });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/estoque/alertas', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT p.id, p.sku, p.descricao, p.unidade, p.estoqueMinimo, p.pontoReposicao,
          COALESCE((SELECT SUM(CASE WHEN tipo='entrada' THEN quantidade
                                    WHEN tipo='saida' THEN -quantidade
                                    ELSE quantidade END)
                    FROM movimentacoes_estoque WHERE produtoId = p.id), 0) AS saldo,
          COALESCE((SELECT SUM(quantidade) FROM reservas_estoque
                    WHERE produtoId = p.id AND status = 'ativa'), 0) AS reservado
        FROM produtos p WHERE p.ativo = 1 AND (p.estoqueMinimo > 0 OR p.pontoReposicao > 0)
      `).all();
      const alertas = rows.map(r => ({ ...r, disponivel: r.saldo - r.reservado }))
                          .filter(r => {
                            const lim = r.pontoReposicao > 0 ? r.pontoReposicao : r.estoqueMinimo;
                            return r.disponivel < lim;
                          });
      res.json({ success: true, alertas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== VALORIZAÇÃO ====================

  app.get('/api/estoque/valorizacao', (req, res) => {
    try {
      // Depósito: as análises agregavam tudo, então com dois depósitos o
      // "valor do estoque" misturava os dois sem dizer.
      const dep = req.query.depositoId ? Number(req.query.depositoId) : null;
      const padrao = getDepositoPadraoId(db);
      const filtroDep = dep ? ' AND COALESCE(depositoId, ?) = ?' : '';
      const pDep = dep ? [padrao, dep] : [];

      const montar = (ativo) => db.prepare(`
        SELECT p.id, p.sku, p.descricao, p.unidade, p.precoCusto, p.ativo,
          COALESCE((SELECT SUM(CASE WHEN tipo='entrada' THEN quantidade
                                    WHEN tipo='saida' THEN -quantidade
                                    ELSE quantidade END)
                    FROM movimentacoes_estoque WHERE produtoId = p.id${filtroDep}), 0) AS saldo,
          ${sqlCustoAtual('p').sql} AS custoMedio
        FROM produtos p WHERE p.ativo = ?
      `).all(...pDep, ativo).map(i => ({ ...i, valor: (i.saldo || 0) * (i.custoMedio || 0) }));

      const itens = montar(1);
      // Produto inativado COM saldo é valor real que sumia do relatório
      // sem aviso — some do total e ninguém procura o que não aparece.
      const inativosComSaldo = montar(0).filter(i => i.saldo > 0)
        .sort((a, b) => b.valor - a.valor);

      // Só saldo positivo entra no valor. Somando tudo, um produto com saldo
      // negativo (que é erro de estoque, não crédito) abatia o total: aqui o
      // SKU-003 com -1 subtraía R$ 1.000 e o card não batia com o gráfico.
      const comSaldo = itens.filter(i => i.saldo > 0);
      const negativos = itens.filter(i => i.saldo < 0).sort((a, b) => a.saldo - b.saldo);
      const valorTotal = comSaldo.reduce((s, i) => s + i.valor, 0);
      const top10 = [...comSaldo].sort((a, b) => b.valor - a.valor).slice(0, 10);
      const semCusto = comSaldo.filter(i => !(i.custoMedio > 0));
      res.json({
        success: true,
        valorTotal,
        qtdProdutos: itens.length,
        produtosComSaldo: comSaldo.length,
        top10,
        // Saldo negativo é impossível fisicamente: ou faltou dar entrada, ou
        // uma saída saiu dobrada. Precisa aparecer para alguém acertar.
        saldoNegativo: { itens: negativos.length, lista: negativos.slice(0, 20) },
        depositoId: dep,
        // Valorização a custo zero infla nada e esconde tudo: melhor dizer.
        semCusto: { itens: semCusto.length, saldo: semCusto.reduce((s, i) => s + i.saldo, 0) },
        inativosComSaldo: {
          itens: inativosComSaldo.length,
          valor: Number(inativosComSaldo.reduce((s, i) => s + i.valor, 0).toFixed(2)),
          lista: inativosComSaldo.slice(0, 20),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CURVA ABC ====================

  app.get('/api/estoque/abc', (req, res) => {
    try {
      const meses = Math.max(1, Math.min(60, Number(req.query.meses) || 12));
      const dataInicio = new Date(Date.now() - meses * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);

      // Valor das saídas por produto no período
      // Usa custoMedioAnterior se disponível (preciso), senão custoUnitario, senão precoCusto do produto
      const dep = req.query.depositoId ? Number(req.query.depositoId) : null;
      const padrao = getDepositoPadraoId(db);
      const filtroDep = dep ? ' AND COALESCE(m.depositoId, ?) = ?' : '';
      const pDep = dep ? [padrao, dep] : [];

      const rows = db.prepare(`
        SELECT p.id, p.sku, p.descricao, p.unidade, p.precoCusto,
          COALESCE(SUM(m.quantidade), 0) AS qtdSaida,
          COALESCE(SUM(m.quantidade * COALESCE(m.custoMedioAnterior, m.custoUnitario, p.precoCusto, 0)), 0) AS valorSaida,
          COUNT(m.id) AS movimentos
        FROM produtos p
        LEFT JOIN movimentacoes_estoque m
          ON m.produtoId = p.id AND m.tipo = 'saida' AND m.data >= ?${filtroDep}
        WHERE p.ativo = 1
        GROUP BY p.id
        HAVING valorSaida > 0
        ORDER BY valorSaida DESC
      `).all(dataInicio, ...pDep);

      const valorTotal = rows.reduce((s, r) => s + r.valorSaida, 0);
      let acumulado = 0;
      const itens = rows.map(r => {
        acumulado += r.valorSaida;
        const pct = valorTotal > 0 ? (r.valorSaida / valorTotal) * 100 : 0;
        const pctAcum = valorTotal > 0 ? (acumulado / valorTotal) * 100 : 0;
        const classe = pctAcum <= 80 ? 'A' : (pctAcum <= 95 ? 'B' : 'C');
        return { ...r, percentual: pct, percentualAcumulado: pctAcum, classe };
      });

      const resumo = {
        A: { itens: itens.filter(i => i.classe === 'A').length, valor: itens.filter(i => i.classe === 'A').reduce((s,i)=>s+i.valorSaida,0) },
        B: { itens: itens.filter(i => i.classe === 'B').length, valor: itens.filter(i => i.classe === 'B').reduce((s,i)=>s+i.valorSaida,0) },
        C: { itens: itens.filter(i => i.classe === 'C').length, valor: itens.filter(i => i.classe === 'C').reduce((s,i)=>s+i.valorSaida,0) }
      };

      res.json({ success: true, periodoMeses: meses, dataInicio, depositoId: dep, valorTotal, totalItens: itens.length, resumo, itens });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== GIRO / COBERTURA ====================

  app.get('/api/estoque/giro', (req, res) => {
    try {
      const meses = Math.max(1, Math.min(60, Number(req.query.meses) || 12));
      const dataInicio = new Date(Date.now() - meses * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
      const diasPeriodo = meses * 30;

      const dep = req.query.depositoId ? Number(req.query.depositoId) : null;
      const padrao = getDepositoPadraoId(db);
      // O custo médio é da empresa, não do depósito — só o saldo e as saídas
      // é que mudam quando se olha um armazém de cada vez.
      const fd = dep ? ' AND COALESCE(depositoId, ?) = ?' : '';
      const pDep = dep ? [padrao, dep] : [];

      const rows = db.prepare(`
        SELECT p.id, p.sku, p.descricao, p.unidade, p.precoCusto,
          COALESCE((SELECT SUM(CASE WHEN tipo='entrada' THEN quantidade
                                    WHEN tipo='saida' THEN -quantidade
                                    ELSE quantidade END)
                    FROM movimentacoes_estoque WHERE produtoId = p.id${fd}), 0) AS saldoAtual,
          ${sqlCustoAtual('p').sql} AS custoMedio,
          COALESCE((SELECT SUM(quantidade) FROM movimentacoes_estoque
                    WHERE produtoId = p.id AND tipo = 'saida' AND data >= ?${fd}), 0) AS qtdSaidaPeriodo,
          (SELECT MAX(data) FROM movimentacoes_estoque
            WHERE produtoId = p.id AND tipo = 'saida'${fd}) AS ultimaSaida
        FROM produtos p WHERE p.ativo = 1
      `).all(...pDep, dataInicio, ...pDep, ...pDep);

      const itens = rows.map(r => {
        const saidaDiaria = diasPeriodo > 0 ? r.qtdSaidaPeriodo / diasPeriodo : 0;
        const cobertura = saidaDiaria > 0 ? r.saldoAtual / saidaDiaria : null;
        // Giro = saídas no período / saldo médio (aprox: saldo atual como proxy)
        const giro = r.saldoAtual > 0 ? r.qtdSaidaPeriodo / r.saldoAtual : (r.qtdSaidaPeriodo > 0 ? Infinity : 0);
        const diasSemSaida = r.ultimaSaida
          ? Math.floor((Date.now() - new Date(r.ultimaSaida + 'T12:00:00').getTime()) / (1000*60*60*24))
          : null;
        const parado = r.saldoAtual > 0 && (diasSemSaida == null || diasSemSaida > 90);
        const valorEstoque = r.saldoAtual * (r.custoMedio || 0);
        return {
          ...r,
          saidaDiaria,
          coberturaDias: cobertura,
          giro: isFinite(giro) ? giro : null,
          diasSemSaida,
          parado,
          valorEstoque
        };
      });

      // Ordena: parados primeiro, depois cobertura ASC (menor cobertura é mais crítico)
      itens.sort((a, b) => {
        if (a.parado !== b.parado) return b.parado - a.parado;
        const ca = a.coberturaDias == null ? Infinity : a.coberturaDias;
        const cb = b.coberturaDias == null ? Infinity : b.coberturaDias;
        return ca - cb;
      });

      const resumo = {
        totalAtivos: itens.length,
        comSaldo: itens.filter(i => i.saldoAtual > 0).length,
        parados: itens.filter(i => i.parado).length,
        cobertura30dias: itens.filter(i => i.coberturaDias != null && i.coberturaDias <= 30).length,
        semCobertura: itens.filter(i => i.saldoAtual <= 0 && i.qtdSaidaPeriodo > 0).length,
        valorParado: itens.filter(i => i.parado).reduce((s, i) => s + i.valorEstoque, 0),
        // Estoque sem custo entra no giro valendo zero: o "valor parado" mente
        // para baixo se ninguém avisar.
        semCusto: itens.filter(i => i.saldoAtual > 0 && !(i.custoMedio > 0)).length
      };

      res.json({ success: true, periodoMeses: meses, dataInicio, depositoId: dep, resumo, itens });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CMV (Custo Mercadoria Vendida) ====================

  app.get('/api/estoque/cmv', (req, res) => {
    try {
      const inicio = req.query.inicio;
      const fim = req.query.fim;
      if (!inicio || !fim) return res.status(400).json({ success: false, error: 'inicio e fim (YYYY-MM-DD) obrigatorios' });

      const dep = req.query.depositoId ? Number(req.query.depositoId) : null;
      const padrao = getDepositoPadraoId(db);
      const filtroDep = dep ? ' AND COALESCE(m.depositoId, ?) = ?' : '';
      const pDep = dep ? [padrao, dep] : [];

      const porProduto = db.prepare(`
        SELECT p.id, p.sku, p.descricao, p.unidade,
          COALESCE(SUM(m.quantidade), 0) AS qtdSaida,
          COALESCE(SUM(m.quantidade * COALESCE(m.custoMedioAnterior, m.custoUnitario, p.precoCusto, 0)), 0) AS cmv
        FROM movimentacoes_estoque m
        JOIN produtos p ON p.id = m.produtoId
        WHERE m.tipo = 'saida' AND m.data BETWEEN ? AND ?${filtroDep}
        GROUP BY p.id
        HAVING cmv > 0
        ORDER BY cmv DESC
      `).all(inicio, fim, ...pDep);

      const porMes = db.prepare(`
        SELECT substr(m.data, 1, 7) AS mes,
          SUM(m.quantidade) AS qtd,
          SUM(m.quantidade * COALESCE(m.custoMedioAnterior, m.custoUnitario, p.precoCusto, 0)) AS cmv
        FROM movimentacoes_estoque m
        JOIN produtos p ON p.id = m.produtoId
        WHERE m.tipo = 'saida' AND m.data BETWEEN ? AND ?${filtroDep}
        GROUP BY substr(m.data, 1, 7)
        ORDER BY mes ASC
      `).all(inicio, fim, ...pDep);

      const cmvTotal = porProduto.reduce((s, r) => s + r.cmv, 0);
      const qtdTotal = porProduto.reduce((s, r) => s + r.qtdSaida, 0);

      res.json({
        success: true,
        inicio, fim, depositoId: dep,
        cmvTotal, qtdTotal,
        produtos: porProduto.length,
        porProduto,
        porMes
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== EVOLUÇÃO DO VALOR DO ESTOQUE ====================

  app.get('/api/estoque/evolucao-valor', (req, res) => {
    try {
      const meses = Math.max(1, Math.min(36, Number(req.query.meses) || 12));
      const dep = req.query.depositoId ? Number(req.query.depositoId) : null;
      const padrao = getDepositoPadraoId(db);

      // Fins de mês calculados por ano/mês, não com setMonth() sobre a data de
      // hoje: rodando num dia 31 o setMonth transbordava para o mês seguinte e
      // a série saía com meses repetidos e outros faltando.
      const hoje = new Date();
      const fimDoMes = (ano, mes) => {  // mes 0-11, pode extrapolar
        const d = new Date(Date.UTC(ano, mes + 1, 0));
        return d.toISOString().slice(0, 10);
      };

      // O saldo é recomposto somando as movimentações até a data. Depender de
      // saldoPosterior deixava a série zerada: esse campo só é preenchido pelas
      // rotinas que passam por calcularContextoMovimento, e as demais (estorno
      // de compra, importações) gravam NULL — a última movimentação do produto
      // valia zero e o gráfico virava uma linha reta no chão.
      const filtroDep = dep ? ' AND COALESCE(m.depositoId, ?) = ?' : '';
      const stmt = db.prepare(`
        SELECT m.produtoId,
          SUM(CASE WHEN m.tipo='entrada' THEN m.quantidade
                   WHEN m.tipo='saida' THEN -m.quantidade
                   ELSE m.quantidade END) AS saldo,
          ${sqlCustoAtual('p', 'date(?)').sql} AS custo
        FROM movimentacoes_estoque m
        JOIN produtos p ON p.id = m.produtoId
        WHERE date(m.data) <= date(?) AND p.ativo = 1${filtroDep}
        GROUP BY m.produtoId
      `);

      const pontos = [];
      for (let i = 0; i < meses; i++) {
        const alvo = hoje.getMonth() - (meses - 1 - i);
        const fimMes = fimDoMes(hoje.getFullYear(), alvo);
        const rows = dep ? stmt.all(fimMes, fimMes, fimMes, padrao, dep) : stmt.all(fimMes, fimMes, fimMes);
        const comSaldo = rows.filter(r => (r.saldo || 0) > 0);
        const valor = comSaldo.reduce((s, r) => s + (r.saldo * (r.custo || 0)), 0);
        const anterior = pontos.length ? pontos[pontos.length - 1].valor : null;
        pontos.push({
          mes: fimMes.slice(0, 7),
          dataFim: fimMes,
          valor,
          qtdProdutos: comSaldo.length,
          // Sem a variação a linha só mostra a forma; o número é que decide.
          variacao: anterior == null ? null : valor - anterior,
          variacaoPct: anterior ? ((valor - anterior) / anterior) * 100 : null,
          // Saldo sem custo entra valendo zero e derruba a curva sem explicação.
          semCusto: comSaldo.filter(r => !(r.custo > 0)).length,
        });
      }

      res.json({
        success: true, periodoMeses: meses, depositoId: dep,
        dataInicio: pontos.length ? pontos[0].dataFim : null, pontos,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== MOVIMENTAÇÕES ====================

  app.get('/api/estoque/movimentacoes', (req, res) => {
    try {
      const { produtoId, origem, loteId, limit, depositoId, de, ate, q, tipo } = req.query;
      let sql = `SELECT m.*, p.sku, p.descricao, p.unidade,
                        l.numero AS loteNumero, l.dataValidade AS loteValidade,
                        dep.nome AS depositoNome
                 FROM movimentacoes_estoque m
                 JOIN produtos p ON p.id = m.produtoId
                 LEFT JOIN lotes l ON l.id = m.loteId
                 LEFT JOIN depositos dep ON dep.id = m.depositoId
                 WHERE 1=1`;
      const params = [];
      if (produtoId) { sql += ' AND m.produtoId = ?'; params.push(produtoId); }
      if (origem)    { sql += ' AND m.origem = ?';    params.push(origem); }
      if (loteId)    { sql += ' AND m.loteId = ?';    params.push(loteId); }
      if (tipo)      { sql += ' AND m.tipo = ?';      params.push(tipo); }
      // Período: sem isto o histórico ficava inutilizável e o LIMIT cortava
      // silenciosamente as mais antigas.
      if (de)  { sql += ' AND date(m.data) >= ?'; params.push(de); }
      if (ate) { sql += ' AND date(m.data) <= ?'; params.push(ate); }
      // Busca por SKU/descrição — antes só dava para filtrar pelo id interno
      // do produto, que ninguém sabe de cabeça.
      if (q) {
        sql += ' AND (p.sku LIKE ? OR p.descricao LIKE ?)';
        params.push(`%${q}%`, `%${q}%`);
      }
      if (depositoId) {
        sql += ' AND COALESCE(m.depositoId, ?) = ?';
        params.push(getDepositoPadraoId(db), Number(depositoId));
      }

      // Totais sobre o filtro inteiro, não só sobre a página devolvida.
      const where = sql.slice(sql.indexOf('WHERE 1=1'));
      const totais = db.prepare(`SELECT
          COUNT(*) AS registros,
          COALESCE(SUM(CASE WHEN m.tipo='entrada' THEN m.quantidade ELSE 0 END),0) AS qtdEntrada,
          COALESCE(SUM(CASE WHEN m.tipo='saida'   THEN m.quantidade ELSE 0 END),0) AS qtdSaida,
          COALESCE(SUM(CASE WHEN m.tipo='ajuste'  THEN m.quantidade ELSE 0 END),0) AS qtdAjuste,
          COALESCE(SUM(CASE WHEN m.tipo='entrada' THEN m.quantidade * COALESCE(m.custoUnitario,0) ELSE 0 END),0) AS valorEntrada,
          COALESCE(SUM(CASE WHEN m.tipo='saida'   THEN m.quantidade * COALESCE(m.custoUnitario,0) ELSE 0 END),0) AS valorSaida,
          COALESCE(SUM(CASE WHEN m.estornada=1 THEN 1 ELSE 0 END),0) AS estornadas
        FROM movimentacoes_estoque m JOIN produtos p ON p.id = m.produtoId ${where}`).get(...params);

      const max = Math.min(Number(limit) || 200, 2000);
      sql += ' ORDER BY m.data DESC, m.id DESC LIMIT ?';
      params.push(max);
      const movimentacoes = db.prepare(sql).all(...params);
      // Truncou? Antes o resto simplesmente sumia sem aviso.
      res.json({
        success: true, movimentacoes, totais, limite: max,
        truncado: totais.registros > movimentacoes.length,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Origens que existem de fato nos dados — a tela listava opções fixas no
  // HTML, com 2 que nunca aparecem e faltando 5 reais.
  app.get('/api/estoque/movimentacoes/origens', (req, res) => {
    try {
      const rows = db.prepare(`SELECT origem, COUNT(*) n FROM movimentacoes_estoque
        WHERE origem IS NOT NULL AND origem <> '' GROUP BY origem ORDER BY n DESC`).all();
      res.json({ success: true, origens: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/estoque/movimentacoes', (req, res) => {
    try {
      const { produtoId, tipo, quantidade, custoUnitario, origem, origemId,
              observacao, data, loteId, serialIds, depositoId } = req.body;

      if (!produtoId || !tipo || !quantidade) {
        return res.status(400).json({ success: false, error: 'produtoId, tipo e quantidade sao obrigatorios' });
      }
      if (!TIPOS_VALIDOS.has(tipo)) {
        return res.status(400).json({ success: false, error: 'tipo invalido (entrada|saida|ajuste)' });
      }
      const qtd = Number(quantidade);
      if (!(qtd > 0) && tipo !== 'ajuste') {
        return res.status(400).json({ success: false, error: 'quantidade deve ser > 0' });
      }

      const produto = db.prepare('SELECT * FROM produtos WHERE id = ? AND ativo = 1').get(produtoId);
      if (!produto) return res.status(404).json({ success: false, error: 'Produto nao encontrado' });
      if (produto.tipoProduto === 'kit') {
        return res.status(400).json({ success: false, error: 'Kit não tem saldo próprio — movimente os componentes' });
      }

      // Depósito: explícito ou padrão; saída não pode deixar o depósito negativo
      const depId = depositoId ? Number(depositoId) : getDepositoPadraoId(db);
      if (depositoId) {
        const dep = db.prepare('SELECT id FROM depositos WHERE id = ? AND ativo = 1').get(depId);
        if (!dep) return res.status(404).json({ success: false, error: 'Deposito nao encontrado ou inativo' });
      }
      if (tipo === 'saida' && depId != null) {
        const saldoDep = calcularSaldo(db, produtoId, depId);
        if (saldoDep < qtd) {
          return res.status(400).json({ success: false, error: `Saldo insuficiente no deposito (${saldoDep})` });
        }
      }

      // Validação de rastreabilidade
      if (produto.rastreiaLote && !loteId && tipo !== 'ajuste') {
        return res.status(400).json({ success: false, error: 'Este produto rastreia lote — loteId obrigatorio' });
      }
      if (produto.rastreiaSerial && tipo !== 'ajuste') {
        if (!Array.isArray(serialIds) || serialIds.length !== qtd) {
          return res.status(400).json({ success: false, error: `Informe ${qtd} numero(s) de serie` });
        }
      }

      // Validação de lote (se informado)
      let lote = null;
      if (loteId) {
        lote = db.prepare('SELECT * FROM lotes WHERE id = ? AND ativo = 1').get(loteId);
        if (!lote) return res.status(404).json({ success: false, error: 'Lote nao encontrado' });
        if (lote.produtoId !== produtoId) {
          return res.status(400).json({ success: false, error: 'Lote pertence a outro produto' });
        }
        if (tipo === 'saida' && lote.saldoAtual < qtd) {
          return res.status(400).json({ success: false, error: `Saldo do lote insuficiente (${lote.saldoAtual})` });
        }
      }

      // Calcular contexto (saldo + custo médio anterior/posterior)
      const ctx = calcularContextoMovimento(db, produtoId, tipo, qtd, custoUnitario);

      const trx = db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO movimentacoes_estoque
            (produtoId, tipo, quantidade, custoUnitario, origem, origemId,
             observacao, data, loteId, depositoId,
             custoMedioAnterior, custoMedioPosterior, saldoPosterior)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          produtoId, tipo, qtd, custoUnitario != null ? Number(custoUnitario) : null,
          origem || 'ajuste_manual', origemId || null, observacao || null,
          data || dataBrasilia(), loteId || null, depId,
          ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior
        );
        const movId = result.lastInsertRowid;

        // Atualizar saldo do lote
        if (loteId) {
          const delta = tipo === 'entrada' ? qtd : (tipo === 'saida' ? -qtd : qtd);
          atualizarSaldoLote(db, loteId, delta);
        }

        // Atualizar status dos seriais
        if (Array.isArray(serialIds) && serialIds.length) {
          for (const sid of serialIds) {
            const novoStatus = tipo === 'entrada' ? 'disponivel' : 'baixado';
            const campo = tipo === 'entrada' ? 'movEntradaId' : 'movSaidaId';
            db.prepare(`UPDATE serial_numbers SET status = ?, ${campo} = ?, loteId = COALESCE(?, loteId) WHERE id = ?`)
              .run(novoStatus, movId, loteId || null, sid);
          }
        }

        return movId;
      });

      const movId = trx();
      const mov = db.prepare('SELECT * FROM movimentacoes_estoque WHERE id = ?').get(movId);
      logAction(db, req, tipo, 'estoque-movimentacao', movId, {
        produtoId, sku: produto.sku, quantidade: qtd, custoUnitario, loteId, origem: origem || 'ajuste_manual'
      });
      res.json({ success: true, movimentacao: mov });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Estorno lógico: nunca apaga movimentação — cria contrapartida e marca original como estornada.
  // Exige motivo. Bloqueia se saldo do produto/lote ficaria negativo, se serial já foi reutilizado,
  // ou se a movimentação veio de pedido (estorne pelo pedido).
  app.post('/api/estoque/movimentacoes/:id/estornar', (req, res) => {
    try {
      const { motivo } = req.body || {};
      const motivoTrim = (motivo || '').toString().trim();
      if (motivoTrim.length < 5) {
        return res.status(400).json({ success: false, error: 'Motivo obrigatório (mín. 5 caracteres)' });
      }

      const mov = db.prepare('SELECT * FROM movimentacoes_estoque WHERE id = ?').get(req.params.id);
      if (!mov) return res.status(404).json({ success: false, error: 'Movimentacao nao encontrada' });
      if (mov.estornada) {
        return res.status(400).json({ success: false, error: 'Movimentação já estornada' });
      }
      if (mov.origem === 'pedido') {
        return res.status(400).json({ success: false, error: 'Movimentacao originada de pedido — estorne pelo pedido' });
      }
      if (mov.origem === 'estorno') {
        return res.status(400).json({ success: false, error: 'Não é possível estornar um estorno' });
      }
      if (mov.origem === 'transferencia') {
        return res.status(400).json({ success: false, error: 'Movimentacao de transferência — cancele pela transferência' });
      }

      // Efeito original no saldo do produto
      const efeitoOriginalProduto =
        mov.tipo === 'entrada' ? +mov.quantidade :
        mov.tipo === 'saida'   ? -mov.quantidade :
                                 +mov.quantidade; // ajuste (pode ser negativo)
      const saldoAtualProduto = calcularSaldo(db, mov.produtoId);
      const saldoAposEstorno = saldoAtualProduto - efeitoOriginalProduto;
      if (saldoAposEstorno < 0) {
        return res.status(400).json({
          success: false,
          error: `Saldo ficaria negativo (${saldoAposEstorno}). Movimentações posteriores consumiram este estoque — estorne-as primeiro.`
        });
      }
      // Mesma checagem no depósito da movimentação (NULL = padrão)
      const depMov = mov.depositoId || getDepositoPadraoId(db);
      if (depMov != null) {
        const saldoDepAposEstorno = calcularSaldo(db, mov.produtoId, depMov) - efeitoOriginalProduto;
        if (saldoDepAposEstorno < 0) {
          return res.status(400).json({
            success: false,
            error: `Saldo do depósito ficaria negativo (${saldoDepAposEstorno}).`
          });
        }
      }

      // Efeito no lote (se aplicável)
      if (mov.loteId) {
        const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(mov.loteId);
        if (lote) {
          const efeitoOriginalLote =
            mov.tipo === 'entrada' ? +mov.quantidade :
            mov.tipo === 'saida'   ? -mov.quantidade :
                                     +mov.quantidade;
          const saldoLoteAposEstorno = lote.saldoAtual - efeitoOriginalLote;
          if (saldoLoteAposEstorno < 0) {
            return res.status(400).json({
              success: false,
              error: `Saldo do lote ${lote.numero} ficaria negativo (${saldoLoteAposEstorno}).`
            });
          }
        }
      }

      // Validação de seriais
      if (mov.tipo === 'entrada') {
        const seriaisUsados = db.prepare(
          `SELECT id, numero, status FROM serial_numbers WHERE movEntradaId = ? AND status != 'disponivel'`
        ).all(mov.id);
        if (seriaisUsados.length) {
          return res.status(400).json({
            success: false,
            error: `Seriais já utilizados após esta entrada: ${seriaisUsados.map(s => s.numero).join(', ')}`
          });
        }
      }

      // Tipo e quantidade da contrapartida
      let tipoContra, qtdContra;
      if (mov.tipo === 'entrada')      { tipoContra = 'saida';   qtdContra = mov.quantidade; }
      else if (mov.tipo === 'saida')   { tipoContra = 'entrada'; qtdContra = mov.quantidade; }
      else /* ajuste */                { tipoContra = 'ajuste';  qtdContra = -mov.quantidade; }

      const ctx = calcularContextoMovimento(db, mov.produtoId, tipoContra, qtdContra, mov.custoUnitario);
      const usuario = req.session?.username || null;
      const usuarioId = req.session?.userId || null;

      const trx = db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO movimentacoes_estoque
            (produtoId, tipo, quantidade, custoUnitario, origem, origemId,
             observacao, data, loteId, depositoId,
             custoMedioAnterior, custoMedioPosterior, saldoPosterior,
             movOriginalId, motivo, usuarioId, usuario)
          VALUES (?, ?, ?, ?, 'estorno', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          mov.produtoId, tipoContra, qtdContra,
          mov.custoUnitario,
          mov.id,
          `Estorno da mov #${mov.id}: ${motivoTrim}`,
          dataBrasilia(),
          mov.loteId, mov.depositoId,
          ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior,
          mov.id, motivoTrim, usuarioId, usuario
        );
        const estornoId = result.lastInsertRowid;

        // Marca original como estornada
        db.prepare(`UPDATE movimentacoes_estoque SET estornada = 1, movEstornoId = ? WHERE id = ?`)
          .run(estornoId, mov.id);

        // Ajusta saldo do lote
        if (mov.loteId) {
          const delta = tipoContra === 'entrada' ? qtdContra : (tipoContra === 'saida' ? -qtdContra : qtdContra);
          atualizarSaldoLote(db, mov.loteId, delta);
        }

        // Reverte seriais
        if (mov.tipo === 'entrada') {
          // seriais da entrada voltam pro estado pré-entrada (removidos da base ou marcados)
          db.prepare(`UPDATE serial_numbers SET status = 'estornado', movEntradaId = NULL WHERE movEntradaId = ?`)
            .run(mov.id);
        } else if (mov.tipo === 'saida') {
          // seriais da saída voltam pra 'disponivel' se ainda estiverem linkados a esta saída
          db.prepare(`UPDATE serial_numbers SET status = 'disponivel', movSaidaId = NULL WHERE movSaidaId = ?`)
            .run(mov.id);
        }

        return estornoId;
      });

      const estornoId = trx();
      const estorno = db.prepare('SELECT * FROM movimentacoes_estoque WHERE id = ?').get(estornoId);
      res.json({ success: true, estorno });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = {
  sqlCustoAtual, registrarRotasEstoque, migrarEstoqueDB, calcularSaldo, saldoPorEstabelecimento, calcularCustoMedio, calcularContextoMovimento, getDepositoPadraoId, resolverDeposito };
