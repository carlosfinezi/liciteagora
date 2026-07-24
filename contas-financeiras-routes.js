/**
 * contas-financeiras-routes.js — Contas Financeiras (caixa/banco) + movimentações + extrato.
 *
 * Expõe também helpers:
 *   - lancarMovimentacao(db, { contaId, tipo, valor, data, descricao, origem, origemId, categoria, usuario })
 *   - getContaPadrao(db, tipoPadrao)  // 'caixa' | 'banco'
 *   - getContaMercadoPago(db)         // conta específica ou bancoPadrao
 *
 * Uso:
 *   const { registrarRotasContasFinanceiras } = require('./contas-financeiras-routes');
 *   registrarRotasContasFinanceiras(app, db);
 */

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* ja existe */ } }

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contas_financeiras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL,
      banco TEXT,
      agencia TEXT,
      conta TEXT,
      saldoInicial REAL DEFAULT 0,
      ehCaixaPadrao INTEGER DEFAULT 0,
      ehBancoPadrao INTEGER DEFAULT 0,
      observacoes TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS movimentacoes_financeiras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contaId INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      valor REAL NOT NULL,
      data TEXT NOT NULL,
      descricao TEXT NOT NULL,
      origem TEXT,
      origemId INTEGER,
      contraContaId INTEGER,
      categoria TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contaId) REFERENCES contas_financeiras(id)
    );
    CREATE INDEX IF NOT EXISTS idx_movf_conta ON movimentacoes_financeiras(contaId);
    CREATE INDEX IF NOT EXISTS idx_movf_data ON movimentacoes_financeiras(data);
    CREATE INDEX IF NOT EXISTS idx_movf_origem ON movimentacoes_financeiras(origem, origemId);
  `);
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN contaFinanceiraId INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN origem TEXT');
  // Multi-loja (Fase 4): dimensão de estabelecimento (NULL = consolidado/matriz).
  alterSafe(db, 'ALTER TABLE contas_financeiras ADD COLUMN estabelecimentoId INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN estabelecimentoId INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_pagar ADD COLUMN estabelecimentoId INTEGER');
}

function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function saldoConta(db, contaId) {
  const c = db.prepare('SELECT saldoInicial FROM contas_financeiras WHERE id = ?').get(contaId);
  if (!c) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN tipo IN ('entrada','transferencia_entrada') THEN valor
      WHEN tipo IN ('saida','transferencia_saida') THEN -valor
      ELSE 0 END), 0) AS delta
    FROM movimentacoes_financeiras WHERE contaId = ?`).get(contaId);
  return (c.saldoInicial || 0) + (row.delta || 0);
}

// ==================== HELPERS PÚBLICOS (exportados para outros módulos) ====================

function lancarMovimentacao(db, mov) {
  if (!mov.contaId || !mov.tipo || !mov.valor || !mov.descricao) {
    throw new Error('contaId, tipo, valor, descricao obrigatorios');
  }
  const r = db.prepare(`INSERT INTO movimentacoes_financeiras
    (contaId, tipo, valor, data, descricao, origem, origemId, contraContaId, categoria, usuario)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    mov.contaId, mov.tipo, Number(mov.valor),
    mov.data || dataBrasilia(), mov.descricao,
    mov.origem || null, mov.origemId || null,
    mov.contraContaId || null, mov.categoria || null, mov.usuario || null
  );
  return r.lastInsertRowid;
}

function getContaPadrao(db, tipoPadrao) {
  const col = tipoPadrao === 'caixa' ? 'ehCaixaPadrao' : 'ehBancoPadrao';
  return db.prepare(`SELECT * FROM contas_financeiras WHERE ${col} = 1 AND ativo = 1 LIMIT 1`).get();
}

function getContaMercadoPago(db) {
  const mp = db.prepare(`SELECT * FROM contas_financeiras WHERE ativo = 1 AND LOWER(nome) LIKE '%mercadopago%' LIMIT 1`).get();
  return mp || getContaPadrao(db, 'banco');
}

// ==================== ROTAS ====================

function registrarRotas(app, db) {
  migrar(db);

  app.get('/api/contas-financeiras', (req, res) => {
    try {
      const { ativo, tipo } = req.query;
      let sql = 'SELECT * FROM contas_financeiras WHERE 1=1';
      const params = [];
      if (ativo !== undefined) { sql += ' AND ativo = ?'; params.push(Number(ativo)); }
      else { sql += ' AND ativo = 1'; }
      if (tipo) { sql += ' AND tipo = ?'; params.push(tipo); }
      sql += ' ORDER BY tipo ASC, nome ASC';
      const contas = db.prepare(sql).all(...params).map(c => ({ ...c, saldo: saldoConta(db, c.id) }));
      res.json({ success: true, contas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/contas-financeiras/resumo', (req, res) => {
    try {
      const contas = db.prepare('SELECT * FROM contas_financeiras WHERE ativo = 1').all();
      let totalCaixa = 0, totalBanco = 0;
      for (const c of contas) {
        const s = saldoConta(db, c.id);
        if (c.tipo === 'caixa') totalCaixa += s; else totalBanco += s;
      }
      const mes = new Date().toISOString().slice(0,7);
      const fluxo = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN tipo IN ('entrada','transferencia_entrada') THEN valor END),0) AS entradas,
          COALESCE(SUM(CASE WHEN tipo IN ('saida','transferencia_saida') THEN valor END),0) AS saidas
        FROM movimentacoes_financeiras
        WHERE substr(data,1,7) = ?
      `).get(mes);
      res.json({ success: true, resumo: {
        totalCaixa, totalBanco, total: totalCaixa + totalBanco,
        entradasMes: fluxo.entradas || 0, saidasMes: fluxo.saidas || 0
      }});
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/contas-financeiras/:id', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      res.json({ success: true, conta: { ...c, saldo: saldoConta(db, c.id) } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-financeiras', (req, res) => {
    try {
      const b = req.body;
      if (!b.nome || !b.tipo) return res.status(400).json({ success: false, error: 'nome e tipo obrigatorios' });
      if (!['caixa','banco'].includes(b.tipo)) return res.status(400).json({ success: false, error: 'tipo invalido' });

      const tx = db.transaction(() => {
        if (b.ehCaixaPadrao) db.prepare('UPDATE contas_financeiras SET ehCaixaPadrao = 0').run();
        if (b.ehBancoPadrao) db.prepare('UPDATE contas_financeiras SET ehBancoPadrao = 0').run();

        const r = db.prepare(`INSERT INTO contas_financeiras
          (nome, tipo, banco, agencia, conta, saldoInicial, ehCaixaPadrao, ehBancoPadrao, observacoes, estabelecimentoId)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          b.nome, b.tipo, b.banco||null, b.agencia||null, b.conta||null,
          Number(b.saldoInicial)||0,
          b.tipo==='caixa' && b.ehCaixaPadrao ? 1 : 0,
          b.tipo==='banco' && b.ehBancoPadrao ? 1 : 0,
          b.observacoes||null, b.estabelecimentoId||null);
        return r.lastInsertRowid;
      });
      const id = tx();
      const conta = db.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(id);
      res.json({ success: true, conta: { ...conta, saldo: saldoConta(db, id) } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/contas-financeiras/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      const b = req.body;

      const tx = db.transaction(() => {
        if (b.ehCaixaPadrao && existing.tipo === 'caixa') db.prepare('UPDATE contas_financeiras SET ehCaixaPadrao = 0 WHERE id != ?').run(req.params.id);
        if (b.ehBancoPadrao && existing.tipo === 'banco') db.prepare('UPDATE contas_financeiras SET ehBancoPadrao = 0 WHERE id != ?').run(req.params.id);

        db.prepare(`UPDATE contas_financeiras SET
          nome = ?, banco = ?, agencia = ?, conta = ?, saldoInicial = ?,
          ehCaixaPadrao = ?, ehBancoPadrao = ?, observacoes = ?, estabelecimentoId = ?, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?`).run(
          b.nome ?? existing.nome,
          b.banco ?? existing.banco,
          b.agencia ?? existing.agencia,
          b.conta ?? existing.conta,
          b.saldoInicial != null ? Number(b.saldoInicial) : existing.saldoInicial,
          existing.tipo === 'caixa' ? (b.ehCaixaPadrao ? 1 : 0) : 0,
          existing.tipo === 'banco' ? (b.ehBancoPadrao ? 1 : 0) : 0,
          b.observacoes ?? existing.observacoes,
          b.estabelecimentoId !== undefined ? (b.estabelecimentoId || null) : existing.estabelecimentoId,
          req.params.id
        );
      });
      tx();
      const conta = db.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(req.params.id);
      res.json({ success: true, conta: { ...conta, saldo: saldoConta(db, conta.id) } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/contas-financeiras/:id', (req, res) => {
    try {
      const result = db.prepare('UPDATE contas_financeiras SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ? AND ativo = 1').run(req.params.id);
      if (result.changes === 0) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/contas-financeiras/:id/extrato', (req, res) => {
    try {
      const conta = db.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      const { dataInicio, dataFim, limit } = req.query;
      let sql = 'SELECT * FROM movimentacoes_financeiras WHERE contaId = ?';
      const params = [req.params.id];
      if (dataInicio) { sql += ' AND data >= ?'; params.push(dataInicio); }
      if (dataFim) { sql += ' AND data <= ?'; params.push(dataFim); }
      sql += ' ORDER BY data ASC, id ASC';
      if (limit) { sql += ' LIMIT ?'; params.push(Number(limit)); }
      const movs = db.prepare(sql).all(...params);

      // Saldo acumulado (considerando saldo inicial + movs anteriores ao período)
      let saldoBase = conta.saldoInicial || 0;
      if (dataInicio) {
        const anterior = db.prepare(`
          SELECT COALESCE(SUM(CASE WHEN tipo IN ('entrada','transferencia_entrada') THEN valor
                                   WHEN tipo IN ('saida','transferencia_saida') THEN -valor ELSE 0 END), 0) AS delta
          FROM movimentacoes_financeiras WHERE contaId = ? AND data < ?`).get(req.params.id, dataInicio);
        saldoBase += anterior.delta || 0;
      }
      let saldo = saldoBase;
      const extrato = movs.map(m => {
        const delta = ['entrada','transferencia_entrada'].includes(m.tipo) ? m.valor : -m.valor;
        saldo += delta;
        return { ...m, delta, saldoAcumulado: saldo };
      });
      res.json({ success: true, conta: { ...conta, saldo: saldoConta(db, conta.id) }, extrato, saldoInicialPeriodo: saldoBase });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-financeiras/:id/movimentar', (req, res) => {
    try {
      const conta = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      const b = req.body;
      if (!['entrada','saida'].includes(b.tipo)) return res.status(400).json({ success: false, error: 'tipo invalido (entrada|saida)' });
      const valor = Number(b.valor);
      if (!(valor > 0)) return res.status(400).json({ success: false, error: 'valor > 0 obrigatorio' });
      if (!b.descricao) return res.status(400).json({ success: false, error: 'descricao obrigatoria' });

      const id = lancarMovimentacao(db, {
        contaId: conta.id, tipo: b.tipo, valor, data: b.data || dataBrasilia(),
        descricao: b.descricao, origem: 'manual',
        categoria: b.categoria || null,
        usuario: req.session?.username || null
      });
      const mov = db.prepare('SELECT * FROM movimentacoes_financeiras WHERE id = ?').get(id);
      res.json({ success: true, movimentacao: mov, saldoAtual: saldoConta(db, conta.id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-financeiras/transferir', (req, res) => {
    try {
      const { origemId, destinoId, valor, data, descricao } = req.body;
      if (!origemId || !destinoId) return res.status(400).json({ success: false, error: 'origemId e destinoId obrigatorios' });
      if (origemId === destinoId) return res.status(400).json({ success: false, error: 'Contas origem e destino devem ser diferentes' });
      const v = Number(valor);
      if (!(v > 0)) return res.status(400).json({ success: false, error: 'valor > 0 obrigatorio' });

      const origem = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(origemId);
      const destino = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(destinoId);
      if (!origem || !destino) return res.status(404).json({ success: false, error: 'Conta origem/destino nao encontrada' });

      const desc = descricao || `Transferência ${origem.nome} → ${destino.nome}`;
      const usuario = req.session?.username || null;
      const dt = data || dataBrasilia();

      const tx = db.transaction(() => {
        const saidaId = lancarMovimentacao(db, {
          contaId: origemId, tipo: 'transferencia_saida', valor: v, data: dt,
          descricao: desc, origem: 'transferencia', contraContaId: destinoId, usuario
        });
        lancarMovimentacao(db, {
          contaId: destinoId, tipo: 'transferencia_entrada', valor: v, data: dt,
          descricao: desc, origem: 'transferencia', contraContaId: origemId, origemId: saidaId, usuario
        });
      });
      tx();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = {
  registrarRotasContasFinanceiras: registrarRotas,
  lancarMovimentacao,
  getContaPadrao,
  getContaMercadoPago,
};
