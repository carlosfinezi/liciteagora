/**
 * financeiro-avancado-routes.js — Adiantamentos, renegociação de títulos e
 * baixa de incobráveis (módulo financeiro_avancado, planos Avançado+).
 *
 * Convenções seguidas do financeiro existente:
 *  - status de CR/CP: whitelists 'aberta'/'parcial' — os status novos
 *    ('renegociada', 'incobravel') ficam FORA de todo cálculo de "em aberto".
 *  - Dinheiro só toca o caixa via lancarMovimentacao (contas-financeiras-routes).
 *  - Utilização de adiantamento NÃO gera movimentação (o caixa moveu quando o
 *    adiantamento foi criado); entra como pagamento formaPagamento='adiantamento'.
 */

const { logAction } = require('./audit-log');
const { lancarMovimentacao } = require('./contas-financeiras-routes');
const { escopoSql, escopoSqlHerdado, guardEscopo } = require('./estabelecimentos-routes');
const { E_FORNECEDOR } = require('./pessoas-fornecedor');

function dataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna ja existe */ } }

function migrarFinanceiroAvancado(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adiantamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      pessoaId INTEGER,
      fornecedorId INTEGER,
      valor REAL NOT NULL,
      saldo REAL NOT NULL,
      data TEXT NOT NULL,
      contaFinanceiraId INTEGER,
      movimentacaoFinanceiraId INTEGER,
      origem TEXT DEFAULT 'manual',
      observacao TEXT,
      status TEXT NOT NULL DEFAULT 'ativo',
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_adiant_pessoa ON adiantamentos(pessoaId, status);
    CREATE INDEX IF NOT EXISTS idx_adiant_fornecedor ON adiantamentos(fornecedorId, status);

    CREATE TABLE IF NOT EXISTS adiantamento_utilizacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adiantamentoId INTEGER NOT NULL,
      contaReceberId INTEGER,
      contaPagarId INTEGER,
      pagamentoId INTEGER,
      valor REAL NOT NULL,
      data TEXT NOT NULL,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (adiantamentoId) REFERENCES adiantamentos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_adiant_util ON adiantamento_utilizacoes(adiantamentoId);

    CREATE TABLE IF NOT EXISTS renegociacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      escopo TEXT NOT NULL,
      pessoaId INTEGER,
      fornecedorId INTEGER,
      dataAcordo TEXT NOT NULL,
      valorOriginal REAL NOT NULL,
      juros REAL DEFAULT 0,
      desconto REAL DEFAULT 0,
      valorAcordado REAL NOT NULL,
      observacao TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN renegociacaoId INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN dataPerda TEXT');
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN motivoPerda TEXT');
  alterSafe(db, 'ALTER TABLE contas_a_pagar ADD COLUMN renegociacaoId INTEGER');
}

// Soma de valorBase não estornado — mesma regra do registrarBaixaCR
/**
 * Alinha contas_pagar_pagamentos com contas_receber_pagamentos.
 *
 * Duas assimetrias impediam qualquer quitação sem caixa do lado do
 * fornecedor — abatimento por adiantamento, compensação de crédito, encontro
 * de contas:
 *   1. faltava a coluna `origem` (o INSERT é o mesmo dos dois lados);
 *   2. `contaFinanceiraId` era NOT NULL, mas quitação por adiantamento não
 *      tem conta financeira: o dinheiro se moveu quando o adiantamento nasceu.
 *
 * Tirar um NOT NULL no SQLite exige reconstruir a tabela. Feito dentro de
 * transação, com os dados copiados e o índice recriado.
 */
function migrarPagamentosCP(db) {
  let cols;
  try { cols = db.prepare('PRAGMA table_info(contas_pagar_pagamentos)').all(); }
  catch { return; }
  if (!cols.length) return;

  if (!cols.some(c => c.name === 'origem')) {
    db.exec('ALTER TABLE contas_pagar_pagamentos ADD COLUMN origem TEXT');
  }
  const contaFin = db.prepare('PRAGMA table_info(contas_pagar_pagamentos)').all()
    .find(c => c.name === 'contaFinanceiraId');
  if (!contaFin || contaFin.notnull === 0) return;   // já aceita nulo

  const fkAntes = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE contas_pagar_pagamentos_novo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contaPagarId INTEGER NOT NULL,
        dataPagamento TEXT NOT NULL,
        valorPago REAL NOT NULL,
        valorBase REAL NOT NULL,
        juros REAL DEFAULT 0,
        multa REAL DEFAULT 0,
        desconto REAL DEFAULT 0,
        formaPagamento TEXT,
        contaFinanceiraId INTEGER,
        movimentacaoFinanceiraId INTEGER,
        observacoes TEXT,
        estornado INTEGER DEFAULT 0,
        estornadoEm TEXT,
        origem TEXT,
        usuario TEXT,
        dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contaPagarId) REFERENCES contas_a_pagar(id),
        FOREIGN KEY (contaFinanceiraId) REFERENCES contas_financeiras(id)
      );
      INSERT INTO contas_pagar_pagamentos_novo
        (id, contaPagarId, dataPagamento, valorPago, valorBase, juros, multa, desconto,
         formaPagamento, contaFinanceiraId, movimentacaoFinanceiraId, observacoes,
         estornado, estornadoEm, origem, usuario, dataCriacao)
      SELECT id, contaPagarId, dataPagamento, valorPago, valorBase, juros, multa, desconto,
             formaPagamento, contaFinanceiraId, movimentacaoFinanceiraId, observacoes,
             estornado, estornadoEm, origem, usuario, dataCriacao
        FROM contas_pagar_pagamentos;
      DROP TABLE contas_pagar_pagamentos;
      ALTER TABLE contas_pagar_pagamentos_novo RENAME TO contas_pagar_pagamentos;
      CREATE INDEX IF NOT EXISTS idx_cpp_conta ON contas_pagar_pagamentos(contaPagarId);
      COMMIT;`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { }
    throw e;
  } finally {
    db.pragma(`foreign_keys = ${fkAntes ? 'ON' : 'OFF'}`);
  }
}

function saldoAbertoConta(db, tabela, tabelaPag, fkCol, contaId) {
  const conta = db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(contaId);
  if (!conta) return { conta: null };
  const pago = Number(db.prepare(`SELECT COALESCE(SUM(valorBase),0) AS t
    FROM ${tabelaPag} WHERE ${fkCol} = ? AND estornado = 0`).get(contaId).t) || 0;
  return { conta, pago, saldo: Number((conta.valor - pago).toFixed(2)) };
}

function atualizarStatusConta(db, tabela, contaId, valorConta, totalPago) {
  const novoStatus = totalPago <= 0 ? 'aberta' : (totalPago < valorConta - 0.01 ? 'parcial' : 'paga');
  db.prepare(`UPDATE ${tabela} SET status = ?, valorPago = ?,
    dataPagamento = CASE WHEN ? = 'paga' THEN COALESCE(dataPagamento, DATE('now','-3 hours')) ELSE dataPagamento END,
    dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(novoStatus, totalPago, novoStatus, contaId);
  return novoStatus;
}

/**
 * Saldo de adiantamento disponível de um cliente ou fornecedor.
 * Existia só o caminho de ida (da tela de adiantamentos, escolhendo o título).
 * Quem está com o título na mão precisa da pergunta inversa: "esta pessoa tem
 * crédito comigo?" — sem isso o saldo fica parado porque ninguém lembra dele.
 */
function saldoAdiantamentos(db, { pessoaId = null, fornecedorId = null } = {}) {
  const ehCliente = !!pessoaId;
  const col = ehCliente ? 'pessoaId' : 'fornecedorId';
  const id = ehCliente ? pessoaId : fornecedorId;
  if (!id) return { disponivel: 0, adiantamentos: [] };
  let linhas = [];
  try {
    linhas = db.prepare(`SELECT * FROM adiantamentos
      WHERE ${col} = ? AND status = 'ativo' AND saldo > 0
      ORDER BY data ASC, id ASC`).all(Number(id));
  } catch { return { disponivel: 0, adiantamentos: [] }; }
  return {
    disponivel: Number(linhas.reduce((t, a) => t + a.saldo, 0).toFixed(2)),
    adiantamentos: linhas,
  };
}

/**
 * Abate um título usando o saldo de adiantamento do dono dele.
 * Consome do mais antigo para o mais novo — adiantamento velho parado é o que
 * gera dúvida na conciliação. Não move caixa: o dinheiro entrou/saiu quando o
 * adiantamento foi criado.
 */
function abaterComAdiantamento(db, { tipo, contaId, valor = null, usuario = null }) {
  const ehCR = tipo === 'receber';
  const tabela = ehCR ? 'contas_a_receber' : 'contas_a_pagar';
  const tabelaPag = ehCR ? 'contas_receber_pagamentos' : 'contas_pagar_pagamentos';
  const fkCol = ehCR ? 'contaReceberId' : 'contaPagarId';

  const { conta, pago, saldo } = saldoAbertoConta(db, tabela, tabelaPag, fkCol, Number(contaId));
  if (!conta) throw new Error('Título não encontrado');
  if (!['aberta', 'parcial'].includes(conta.status)) throw new Error(`Título com status ${conta.status}`);
  if (!(saldo > 0)) throw new Error('Título já está quitado');

  const dono = ehCR ? conta.pessoaId : conta.fornecedorId;
  if (!dono) throw new Error(ehCR ? 'Título sem cliente vinculado' : 'Título sem fornecedor vinculado');
  const { disponivel, adiantamentos } = saldoAdiantamentos(db,
    ehCR ? { pessoaId: dono } : { fornecedorId: dono });
  if (!adiantamentos.length) throw new Error('Este cliente/fornecedor não tem saldo de adiantamento');

  // Sem valor explícito, abate o que der: o menor entre o saldo do título e o
  // crédito disponível.
  let aAbater = valor != null ? Number(valor) : Math.min(saldo, disponivel);
  if (!(aAbater > 0)) throw new Error('valor deve ser > 0');
  if (aAbater > saldo + 0.01) throw new Error(`Valor maior que o saldo aberto do título (${saldo.toFixed(2)})`);
  if (aAbater > disponivel + 0.01) throw new Error(`Saldo de adiantamento insuficiente (${disponivel.toFixed(2)})`);

  const dt = dataBrasilia();
  const usados = [];
  const tx = db.transaction(() => {
    let restante = aAbater;
    for (const a of adiantamentos) {
      if (restante <= 0.001) break;
      const v = Number(Math.min(a.saldo, restante).toFixed(2));

      const rp = db.prepare(`INSERT INTO ${tabelaPag}
        (${fkCol}, dataPagamento, valorPago, valorBase, juros, multa, desconto,
         formaPagamento, contaFinanceiraId, origem, observacoes, usuario)
        VALUES (?, ?, ?, ?, 0, 0, 0, 'adiantamento', NULL, 'adiantamento', ?, ?)`)
        .run(conta.id, dt, v, v, `Utilização adiantamento #${a.id}`, usuario);

      const novoSaldo = Number((a.saldo - v).toFixed(2));
      db.prepare(`UPDATE adiantamentos SET saldo = ?, status = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(novoSaldo, novoSaldo <= 0 ? 'consumido' : 'ativo', a.id);
      db.prepare(`INSERT INTO adiantamento_utilizacoes
        (adiantamentoId, contaReceberId, contaPagarId, pagamentoId, valor, data, usuario)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(a.id, ehCR ? conta.id : null, ehCR ? null : conta.id, rp.lastInsertRowid, v, dt, usuario);

      usados.push({ adiantamentoId: a.id, valor: v, saldoRestante: novoSaldo });
      restante = Number((restante - v).toFixed(2));
    }
    atualizarStatusConta(db, tabela, conta.id, conta.valor, Number((pago + aAbater).toFixed(2)));
  });
  tx();

  const novoStatus = db.prepare(`SELECT status FROM ${tabela} WHERE id = ?`).get(conta.id).status;
  return { abatido: aAbater, statusTitulo: novoStatus, adiantamentosUsados: usados,
           saldoRestanteTitulo: Number((saldo - aAbater).toFixed(2)) };
}

function registrarRotasFinanceiroAvancado(app, db) {
  // RBAC: o adiantamento herda a unidade da conta financeira que o pagou/recebeu.
  app.use('/api/adiantamentos/:id', guardEscopo(db, 'adiantamentos', { fk: 'contaFinanceiraId', pai: 'contas_financeiras' }));

  migrarFinanceiroAvancado(db);
  migrarPagamentosCP(db);

  // Saldo disponível — a pergunta que a tela do título precisa fazer.
  app.get('/api/adiantamentos/saldo', (req, res) => {
    try {
      const { pessoaId, fornecedorId } = req.query;
      if (!pessoaId && !fornecedorId) {
        return res.status(400).json({ success: false, error: 'Informe pessoaId ou fornecedorId' });
      }
      res.json({ success: true, ...saldoAdiantamentos(db, { pessoaId, fornecedorId }) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Abater a partir do título (contas a receber e contas a pagar).
  for (const [rota, tipo] of [['contas-a-receber', 'receber'], ['contas-a-pagar', 'pagar']]) {
    app.post(`/api/${rota}/:id/abater-adiantamento`, (req, res) => {
      try {
        const r = abaterComAdiantamento(db, {
          tipo, contaId: Number(req.params.id),
          valor: req.body?.valor != null ? Number(req.body.valor) : null,
          usuario: req.session?.username || null,
        });
        logAction(db, req, 'abater-adiantamento', rota, Number(req.params.id), r);
        res.json({ success: true, ...r });
      } catch (e) { res.status(400).json({ success: false, error: e.message }); }
    });
  }

  // ==================== ADIANTAMENTOS ====================

  app.get('/api/adiantamentos', (req, res) => {
    try {
      const { status, tipo, pessoaId, fornecedorId } = req.query;
      let sql = `SELECT a.*,
          p.razaoSocial AS pessoaNome, f.razaoSocial AS fornecedorNome
        FROM adiantamentos a
        LEFT JOIN pessoas p ON p.id = a.pessoaId
        LEFT JOIN pessoas f ON f.id = a.fornecedorId
        WHERE 1=1`;
      const params = [];
      const rbac = escopoSqlHerdado(req, 'a.contaFinanceiraId', 'contas_financeiras');
      sql += rbac.sql; params.push(...rbac.params);
      if (status)       { sql += ' AND a.status = ?';       params.push(status); }
      if (tipo)         { sql += ' AND a.tipo = ?';         params.push(tipo); }
      if (pessoaId)     { sql += ' AND a.pessoaId = ?';     params.push(Number(pessoaId)); }
      if (fornecedorId) { sql += ' AND a.fornecedorId = ?'; params.push(Number(fornecedorId)); }
      sql += ' ORDER BY a.id DESC LIMIT 300';
      res.json({ success: true, adiantamentos: db.prepare(sql).all(...params) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/adiantamentos/:id', (req, res) => {
    try {
      const a = db.prepare(`SELECT a.*, p.razaoSocial AS pessoaNome, f.razaoSocial AS fornecedorNome
        FROM adiantamentos a
        LEFT JOIN pessoas p ON p.id = a.pessoaId
        LEFT JOIN pessoas f ON f.id = a.fornecedorId
        WHERE a.id = ?`).get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'Adiantamento não encontrado' });
      const utilizacoes = db.prepare(`
        SELECT u.*, cr.descricao AS crDescricao, cp.descricao AS cpDescricao
        FROM adiantamento_utilizacoes u
        LEFT JOIN contas_a_receber cr ON cr.id = u.contaReceberId
        LEFT JOIN contas_a_pagar cp ON cp.id = u.contaPagarId
        WHERE u.adiantamentoId = ? ORDER BY u.id`).all(a.id);
      res.json({ success: true, adiantamento: a, utilizacoes });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/adiantamentos', (req, res) => {
    try {
      const { tipo, pessoaId, fornecedorId, valor, contaFinanceiraId, data, observacao } = req.body || {};
      if (!['cliente', 'fornecedor'].includes(tipo)) {
        return res.status(400).json({ success: false, error: "tipo deve ser 'cliente' ou 'fornecedor'" });
      }
      const v = Number(valor);
      if (!(v > 0)) return res.status(400).json({ success: false, error: 'valor deve ser > 0' });
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório' });
      const contaFin = db.prepare('SELECT id FROM contas_financeiras WHERE id = ? AND ativo = 1').get(contaFinanceiraId);
      if (!contaFin) return res.status(404).json({ success: false, error: 'Conta financeira não encontrada' });

      let quem;
      if (tipo === 'cliente') {
        if (!pessoaId) return res.status(400).json({ success: false, error: 'pessoaId obrigatório para adiantamento de cliente' });
        quem = db.prepare('SELECT id, razaoSocial FROM pessoas WHERE id = ?').get(pessoaId);
      } else {
        if (!fornecedorId) return res.status(400).json({ success: false, error: 'fornecedorId obrigatório para adiantamento a fornecedor' });
        quem = db.prepare(`SELECT id, razaoSocial FROM pessoas WHERE id = ? AND ${E_FORNECEDOR}`).get(fornecedorId);
      }
      if (!quem) return res.status(404).json({ success: false, error: 'Cliente/fornecedor não encontrado' });

      const dt = data || dataBrasilia();
      const usuario = req.session?.username || null;
      let adiantamentoId;
      const tx = db.transaction(() => {
        // Cliente adianta = dinheiro ENTRA; adiantamos ao fornecedor = dinheiro SAI
        const movId = lancarMovimentacao(db, {
          contaId: Number(contaFinanceiraId),
          tipo: tipo === 'cliente' ? 'entrada' : 'saida',
          valor: v, data: dt,
          descricao: `Adiantamento ${tipo === 'cliente' ? 'de' : 'a'} ${quem.razaoSocial}`,
          origem: 'adiantamento', origemId: null, usuario
        });
        const r = db.prepare(`INSERT INTO adiantamentos
          (tipo, pessoaId, fornecedorId, valor, saldo, data, contaFinanceiraId, movimentacaoFinanceiraId, observacao, usuario)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          tipo, tipo === 'cliente' ? Number(pessoaId) : null,
          tipo === 'fornecedor' ? Number(fornecedorId) : null,
          v, v, dt, Number(contaFinanceiraId), movId, observacao || null, usuario);
        adiantamentoId = r.lastInsertRowid;
        db.prepare('UPDATE movimentacoes_financeiras SET origemId = ? WHERE id = ?').run(adiantamentoId, movId);
      });
      tx();
      logAction(db, req, 'criar', 'adiantamento', adiantamentoId, { tipo, valor: v });
      res.json({ success: true, id: adiantamentoId });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Abate um título (CR p/ cliente, CP p/ fornecedor) usando saldo do adiantamento.
  app.post('/api/adiantamentos/:id/utilizar', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM adiantamentos WHERE id = ?').get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'Adiantamento não encontrado' });
      if (a.status !== 'ativo' || a.saldo <= 0) {
        return res.status(400).json({ success: false, error: `Adiantamento sem saldo (status ${a.status})` });
      }
      const { contaReceberId, contaPagarId, valor } = req.body || {};
      const ehCR = a.tipo === 'cliente';
      const contaId = ehCR ? contaReceberId : contaPagarId;
      if (!contaId) {
        return res.status(400).json({ success: false, error: ehCR ? 'contaReceberId obrigatório' : 'contaPagarId obrigatório' });
      }

      const tabela = ehCR ? 'contas_a_receber' : 'contas_a_pagar';
      const tabelaPag = ehCR ? 'contas_receber_pagamentos' : 'contas_pagar_pagamentos';
      const fkCol = ehCR ? 'contaReceberId' : 'contaPagarId';
      const { conta, pago, saldo } = saldoAbertoConta(db, tabela, tabelaPag, fkCol, Number(contaId));
      if (!conta) return res.status(404).json({ success: false, error: 'Título não encontrado' });
      if (!['aberta', 'parcial'].includes(conta.status)) {
        return res.status(400).json({ success: false, error: `Título com status ${conta.status}` });
      }
      const donoConta = ehCR ? conta.pessoaId : conta.fornecedorId;
      const donoAdiant = ehCR ? a.pessoaId : a.fornecedorId;
      if (Number(donoConta) !== Number(donoAdiant)) {
        return res.status(400).json({ success: false, error: 'Título pertence a outro cliente/fornecedor' });
      }

      const v = valor != null ? Number(valor) : Math.min(a.saldo, saldo);
      if (!(v > 0)) return res.status(400).json({ success: false, error: 'valor deve ser > 0' });
      if (v > a.saldo + 0.01) return res.status(400).json({ success: false, error: `Saldo do adiantamento insuficiente (${a.saldo.toFixed(2)})` });
      if (v > saldo + 0.01) return res.status(400).json({ success: false, error: `Valor maior que o saldo aberto do título (${saldo.toFixed(2)})` });

      const dt = dataBrasilia();
      const usuario = req.session?.username || null;
      const tx = db.transaction(() => {
        // Pagamento sem conta financeira e SEM movimentação: o caixa já
        // recebeu/pagou quando o adiantamento foi criado.
        const rp = db.prepare(`INSERT INTO ${tabelaPag}
          (${fkCol}, dataPagamento, valorPago, valorBase, juros, multa, desconto,
           formaPagamento, contaFinanceiraId, origem, observacoes, usuario)
          VALUES (?, ?, ?, ?, 0, 0, 0, 'adiantamento', NULL, 'adiantamento', ?, ?)`).run(
          conta.id, dt, v, v, `Utilização adiantamento #${a.id}`, usuario);
        atualizarStatusConta(db, tabela, conta.id, conta.valor, Number((pago + v).toFixed(2)));

        const novoSaldo = Number((a.saldo - v).toFixed(2));
        db.prepare(`UPDATE adiantamentos SET saldo = ?, status = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(novoSaldo, novoSaldo <= 0 ? 'consumido' : 'ativo', a.id);
        db.prepare(`INSERT INTO adiantamento_utilizacoes
          (adiantamentoId, contaReceberId, contaPagarId, pagamentoId, valor, data, usuario)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          a.id, ehCR ? conta.id : null, ehCR ? null : conta.id, rp.lastInsertRowid, v, dt, usuario);
      });
      tx();
      logAction(db, req, 'utilizar', 'adiantamento', a.id, { contaId, valor: v });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Devolve saldo remanescente (dinheiro volta pelo caixa, movimento inverso).
  app.post('/api/adiantamentos/:id/devolver', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM adiantamentos WHERE id = ?').get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'Adiantamento não encontrado' });
      if (a.status !== 'ativo' || a.saldo <= 0) {
        return res.status(400).json({ success: false, error: 'Sem saldo a devolver' });
      }
      const { contaFinanceiraId, valor } = req.body || {};
      const contaFinId = Number(contaFinanceiraId || a.contaFinanceiraId);
      const contaFin = db.prepare('SELECT id FROM contas_financeiras WHERE id = ? AND ativo = 1').get(contaFinId);
      if (!contaFin) return res.status(404).json({ success: false, error: 'Conta financeira não encontrada' });
      const v = valor != null ? Number(valor) : a.saldo;
      if (!(v > 0) || v > a.saldo + 0.01) {
        return res.status(400).json({ success: false, error: `valor inválido (saldo ${a.saldo.toFixed(2)})` });
      }

      const usuario = req.session?.username || null;
      const tx = db.transaction(() => {
        lancarMovimentacao(db, {
          contaId: contaFinId,
          tipo: a.tipo === 'cliente' ? 'saida' : 'entrada',
          valor: v, data: dataBrasilia(),
          descricao: `Devolução adiantamento #${a.id}`,
          origem: 'adiantamento_devolucao', origemId: a.id, usuario
        });
        const novoSaldo = Number((a.saldo - v).toFixed(2));
        db.prepare(`UPDATE adiantamentos SET saldo = ?, status = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(novoSaldo, novoSaldo <= 0 ? 'devolvido' : 'ativo', a.id);
      });
      tx();
      logAction(db, req, 'devolver', 'adiantamento', a.id, { valor: v });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== RENEGOCIAÇÃO ====================

  app.get('/api/renegociacoes', (req, res) => {
    try {
      const { escopo } = req.query;
      let sql = `SELECT r.*, p.razaoSocial AS pessoaNome, f.razaoSocial AS fornecedorNome,
          (SELECT COUNT(*) FROM contas_a_receber WHERE renegociacaoId = r.id AND status = 'renegociada') +
          (SELECT COUNT(*) FROM contas_a_pagar WHERE renegociacaoId = r.id AND status = 'renegociada') AS titulosOriginais,
          (SELECT COUNT(*) FROM contas_a_receber WHERE renegociacaoId = r.id AND status != 'renegociada') +
          (SELECT COUNT(*) FROM contas_a_pagar WHERE renegociacaoId = r.id AND status != 'renegociada') AS novasParcelas
        FROM renegociacoes r
        LEFT JOIN pessoas p ON p.id = r.pessoaId
        LEFT JOIN pessoas f ON f.id = r.fornecedorId
        WHERE 1=1`;
      const params = [];
      if (escopo) { sql += ' AND r.escopo = ?'; params.push(escopo); }
      sql += ' ORDER BY r.id DESC LIMIT 200';
      res.json({ success: true, renegociacoes: db.prepare(sql).all(...params) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/renegociacoes/:id', (req, res) => {
    try {
      const r = db.prepare(`SELECT r.*, p.razaoSocial AS pessoaNome, f.razaoSocial AS fornecedorNome
        FROM renegociacoes r
        LEFT JOIN pessoas p ON p.id = r.pessoaId
        LEFT JOIN pessoas f ON f.id = r.fornecedorId
        WHERE r.id = ?`).get(req.params.id);
      if (!r) return res.status(404).json({ success: false, error: 'Renegociação não encontrada' });
      const tabela = r.escopo === 'receber' ? 'contas_a_receber' : 'contas_a_pagar';
      const titulos = db.prepare(`SELECT * FROM ${tabela} WHERE renegociacaoId = ? ORDER BY id`).all(r.id);
      res.json({
        success: true, renegociacao: r,
        originais: titulos.filter(t => t.status === 'renegociada'),
        parcelas: titulos.filter(t => t.status !== 'renegociada')
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Cria acordo: títulos originais viram 'renegociada' (imutáveis) e nascem
  // novas parcelas somando valorAcordado = saldoAberto + juros - desconto.
  app.post('/api/renegociacoes', (req, res) => {
    try {
      const { escopo, titulosIds, juros, desconto, parcelas, observacao } = req.body || {};
      if (!['receber', 'pagar'].includes(escopo)) {
        return res.status(400).json({ success: false, error: "escopo deve ser 'receber' ou 'pagar'" });
      }
      if (!Array.isArray(titulosIds) || !titulosIds.length) {
        return res.status(400).json({ success: false, error: 'titulosIds obrigatório' });
      }
      if (!Array.isArray(parcelas) || !parcelas.length) {
        return res.status(400).json({ success: false, error: 'parcelas obrigatórias [{valor, dataVencimento}]' });
      }
      for (const p of parcelas) {
        if (!(Number(p.valor) > 0) || !p.dataVencimento) {
          return res.status(400).json({ success: false, error: 'Cada parcela exige valor > 0 e dataVencimento' });
        }
      }

      const ehCR = escopo === 'receber';
      const tabela = ehCR ? 'contas_a_receber' : 'contas_a_pagar';
      const tabelaPag = ehCR ? 'contas_receber_pagamentos' : 'contas_pagar_pagamentos';
      const fkCol = ehCR ? 'contaReceberId' : 'contaPagarId';
      const donoCol = ehCR ? 'pessoaId' : 'fornecedorId';

      // Valida títulos: abertos/parciais e todos da mesma pessoa
      const titulos = [];
      let dono = null;
      let valorOriginal = 0;
      for (const id of titulosIds) {
        const info = saldoAbertoConta(db, tabela, tabelaPag, fkCol, Number(id));
        if (!info.conta) return res.status(404).json({ success: false, error: `Título ${id} não encontrado` });
        if (!['aberta', 'parcial'].includes(info.conta.status)) {
          return res.status(400).json({ success: false, error: `Título ${id} com status ${info.conta.status}` });
        }
        const d = info.conta[donoCol];
        if (dono == null) dono = d;
        else if (Number(d) !== Number(dono)) {
          return res.status(400).json({ success: false, error: 'Todos os títulos devem ser do mesmo cliente/fornecedor' });
        }
        titulos.push(info);
        valorOriginal += info.saldo;
      }
      valorOriginal = Number(valorOriginal.toFixed(2));
      const j = Number(juros) || 0;
      const dsc = Number(desconto) || 0;
      const valorAcordado = Number((valorOriginal + j - dsc).toFixed(2));
      const somaParcelas = Number(parcelas.reduce((s, p) => s + Number(p.valor), 0).toFixed(2));
      if (Math.abs(somaParcelas - valorAcordado) > 0.01) {
        return res.status(400).json({
          success: false,
          error: `Soma das parcelas (${somaParcelas.toFixed(2)}) difere do valor acordado (${valorAcordado.toFixed(2)} = ${valorOriginal.toFixed(2)} + juros ${j.toFixed(2)} - desconto ${dsc.toFixed(2)})`
        });
      }

      const hoje = dataBrasilia();
      const usuario = req.session?.username || null;
      const primeiro = titulos[0].conta;
      let renegId;
      const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO renegociacoes
          (escopo, pessoaId, fornecedorId, dataAcordo, valorOriginal, juros, desconto, valorAcordado, observacao, usuario)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          escopo, ehCR ? dono : null, ehCR ? null : dono,
          hoje, valorOriginal, j, dsc, valorAcordado, observacao || null, usuario);
        renegId = r.lastInsertRowid;

        for (const t of titulos) {
          db.prepare(`UPDATE ${tabela} SET status = 'renegociada', renegociacaoId = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(renegId, t.conta.id);
          if (ehCR) {
            db.prepare(`UPDATE boletos SET status = 'cancelado', dataAtualizacao = CURRENT_TIMESTAMP
              WHERE contaReceberId = ? AND status IN ('pendente','registrado')`).run(t.conta.id);
          }
        }

        const insCR = ehCR
          ? db.prepare(`INSERT INTO contas_a_receber
              (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, origem,
               categoriaId, parcelaNumero, totalParcelas, renegociacaoId, observacoes)
              VALUES (?, ?, ?, ?, ?, 'aberta', 'renegociacao', ?, ?, ?, ?, ?)`)
          : db.prepare(`INSERT INTO contas_a_pagar
              (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem,
               parcelaNumero, totalParcelas, renegociacaoId, observacoes)
              VALUES (?, ?, ?, ?, ?, 'aberta', 'renegociacao', ?, ?, ?, ?)`);
        parcelas.forEach((p, i) => {
          const desc = `Renegociação #${renegId} — parcela ${i + 1}/${parcelas.length}`;
          if (ehCR) {
            insCR.run(dono, desc, Number(p.valor), hoje, p.dataVencimento,
              primeiro.categoriaId || null, i + 1, parcelas.length, renegId,
              `Títulos originais: ${titulosIds.join(', ')}`);
          } else {
            insCR.run(dono, desc, Number(p.valor), hoje, p.dataVencimento,
              i + 1, parcelas.length, renegId,
              `Títulos originais: ${titulosIds.join(', ')}`);
          }
        });
      });
      tx();
      logAction(db, req, 'criar', 'renegociacao', renegId, { escopo, titulos: titulosIds.length, valorAcordado });
      res.json({ success: true, id: renegId, valorOriginal, valorAcordado });
    } catch (err) {
      console.error('[renegociacao]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== INCOBRÁVEIS ====================

  app.post('/api/contas-a-receber/:id/baixar-perda', (req, res) => {
    try {
      const motivo = (req.body?.motivo || '').toString().trim();
      if (motivo.length < 5) return res.status(400).json({ success: false, error: 'Motivo obrigatório (mín. 5 caracteres)' });
      const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      if (!['aberta', 'parcial'].includes(conta.status)) {
        return res.status(400).json({ success: false, error: `Conta com status ${conta.status}` });
      }
      const tx = db.transaction(() => {
        db.prepare(`UPDATE contas_a_receber SET status = 'incobravel', dataPerda = DATE('now','-3 hours'),
          motivoPerda = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(motivo, conta.id);
        db.prepare(`UPDATE boletos SET status = 'cancelado', dataAtualizacao = CURRENT_TIMESTAMP
          WHERE contaReceberId = ? AND status IN ('pendente','registrado')`).run(conta.id);
      });
      tx();
      logAction(db, req, 'baixar-perda', 'contas-a-receber', conta.id, { motivo });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Cliente pagou depois: título volta ao estado aberto/parcial para baixa normal
  // (a baixa registra a recuperação da perda).
  app.post('/api/contas-a-receber/:id/reativar-perda', (req, res) => {
    try {
      const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      if (conta.status !== 'incobravel') return res.status(400).json({ success: false, error: 'Conta não está baixada como perda' });
      const pago = Number(db.prepare(`SELECT COALESCE(SUM(valorBase),0) AS t
        FROM contas_receber_pagamentos WHERE contaReceberId = ? AND estornado = 0`).get(conta.id).t) || 0;
      db.prepare(`UPDATE contas_a_receber SET status = ?, dataPerda = NULL, motivoPerda = NULL,
        dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(pago > 0 ? 'parcial' : 'aberta', conta.id);
      logAction(db, req, 'reativar-perda', 'contas-a-receber', conta.id, {});
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/relatorios/perdas', (req, res) => {
    try {
      const { inicio, fim } = req.query;
      let sql = `SELECT c.*, p.razaoSocial AS pessoaNome,
          (c.valor - COALESCE(c.valorPago, 0)) AS valorPerdido
        FROM contas_a_receber c
        LEFT JOIN pessoas p ON p.id = c.pessoaId
        WHERE c.status = 'incobravel'`;
      const params = [];
      const rbac = escopoSql(req, 'c.estabelecimentoId');
      sql += rbac.sql; params.push(...rbac.params);
      if (inicio) { sql += ' AND c.dataPerda >= ?'; params.push(inicio); }
      if (fim)    { sql += ' AND c.dataPerda <= ?'; params.push(fim); }
      sql += ' ORDER BY c.dataPerda DESC';
      const perdas = db.prepare(sql).all(...params);
      res.json({
        success: true, perdas,
        total: Number(perdas.reduce((s, x) => s + x.valorPerdido, 0).toFixed(2)),
        quantidade: perdas.length
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasFinanceiroAvancado, saldoAdiantamentos, abaterComAdiantamento,
  migrarFinanceiroAvancado, migrarPagamentosCP };
