/**
 * requisicoes-routes.js — Requisições internas de estoque (almoxarifado):
 * setor/pessoa solicita itens; o atendimento gera saída de estoque no
 * depósito escolhido (origem 'requisicao'), com atendimento parcial.
 *
 * Fluxo: aberta → atendida_parcial → atendida | cancelada.
 * Aprovação por alçada entra no item 2.6 (governança).
 */

const { logAction } = require('./audit-log');
const { calcularSaldo, calcularContextoMovimento, getDepositoPadraoId } = require('./estoque-routes');

function dataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function migrarRequisicoesDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requisicoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      setorTexto TEXT,
      depositoId INTEGER,
      status TEXT NOT NULL DEFAULT 'aberta',
      dataNecessidade TEXT,
      observacao TEXT,
      solicitante TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_req_status ON requisicoes(status);

    CREATE TABLE IF NOT EXISTS requisicao_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requisicaoId INTEGER NOT NULL,
      produtoId INTEGER NOT NULL,
      quantidadeSolicitada REAL NOT NULL,
      quantidadeAtendida REAL DEFAULT 0,
      FOREIGN KEY (requisicaoId) REFERENCES requisicoes(id),
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_reqitens_req ON requisicao_itens(requisicaoId);
  `);
}

function proximoNumeroReq(db) {
  const ano = new Date().getFullYear();
  const prefixo = `REQ-${ano}-`;
  const ult = db.prepare('SELECT numero FROM requisicoes WHERE numero LIKE ? ORDER BY id DESC LIMIT 1').get(prefixo + '%');
  const seq = ult ? parseInt(ult.numero.slice(prefixo.length), 10) + 1 : 1;
  return prefixo + String(seq).padStart(4, '0');
}

function registrarRotasRequisicoes(app, db) {
  migrarRequisicoesDB(db);

  app.get('/api/requisicoes', (req, res) => {
    try {
      const { status } = req.query;
      let sql = `SELECT r.*, d.nome AS depositoNome,
          (SELECT COUNT(*) FROM requisicao_itens WHERE requisicaoId = r.id) AS qtdItens,
          (SELECT COALESCE(SUM(quantidadeSolicitada),0) FROM requisicao_itens WHERE requisicaoId = r.id) AS totalSolicitado,
          (SELECT COALESCE(SUM(quantidadeAtendida),0) FROM requisicao_itens WHERE requisicaoId = r.id) AS totalAtendido
        FROM requisicoes r LEFT JOIN depositos d ON d.id = r.depositoId`;
      const params = [];
      if (status) { sql += ' WHERE r.status = ?'; params.push(status); }
      sql += ' ORDER BY r.id DESC LIMIT 200';
      res.json({ success: true, requisicoes: db.prepare(sql).all(...params) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/requisicoes/:id', (req, res) => {
    try {
      const r = db.prepare(`SELECT r.*, d.nome AS depositoNome FROM requisicoes r
        LEFT JOIN depositos d ON d.id = r.depositoId WHERE r.id = ?`).get(req.params.id);
      if (!r) return res.status(404).json({ success: false, error: 'Requisição não encontrada' });
      const depId = r.depositoId || getDepositoPadraoId(db);
      const itens = db.prepare(`SELECT ri.*, p.sku, p.descricao, p.unidade
        FROM requisicao_itens ri JOIN produtos p ON p.id = ri.produtoId
        WHERE ri.requisicaoId = ?`).all(r.id)
        .map(it => ({ ...it, saldoDeposito: calcularSaldo(db, it.produtoId, depId) }));
      res.json({ success: true, requisicao: r, itens });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/requisicoes', (req, res) => {
    try {
      const { setorTexto, depositoId, dataNecessidade, observacao, itens } = req.body || {};
      if (!Array.isArray(itens) || !itens.length) {
        return res.status(400).json({ success: false, error: 'Informe ao menos 1 item' });
      }
      for (const it of itens) {
        if (!it.produtoId || !(Number(it.quantidade) > 0)) {
          return res.status(400).json({ success: false, error: 'Cada item exige produtoId e quantidade > 0' });
        }
        const p = db.prepare("SELECT id, tipoProduto FROM produtos WHERE id = ? AND ativo = 1").get(it.produtoId);
        if (!p) return res.status(400).json({ success: false, error: `Produto ${it.produtoId} inexistente/inativo` });
        if (p.tipoProduto === 'kit') return res.status(400).json({ success: false, error: 'Kit não pode ser requisitado — requisite os componentes' });
      }
      if (depositoId) {
        const dep = db.prepare('SELECT id FROM depositos WHERE id = ? AND ativo = 1').get(depositoId);
        if (!dep) return res.status(400).json({ success: false, error: 'Depósito inexistente/inativo' });
      }
      const usuario = req.session?.username || null;
      let reqId;
      const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO requisicoes (numero, setorTexto, depositoId, dataNecessidade, observacao, solicitante)
          VALUES (?, ?, ?, ?, ?, ?)`).run(
          proximoNumeroReq(db), setorTexto || null, depositoId || null,
          dataNecessidade || null, observacao || null, usuario);
        reqId = r.lastInsertRowid;
        const insI = db.prepare('INSERT INTO requisicao_itens (requisicaoId, produtoId, quantidadeSolicitada) VALUES (?, ?, ?)');
        for (const it of itens) insI.run(reqId, it.produtoId, Number(it.quantidade));
      });
      tx();
      logAction(db, req, 'criar', 'requisicao', reqId, { itens: itens.length });
      res.json({ success: true, id: reqId });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Atende itens (parcial ou total): gera saída de estoque no depósito da requisição.
  // itens: [{requisicaoItemId, quantidade}]
  app.post('/api/requisicoes/:id/atender', (req, res) => {
    try {
      const r = db.prepare('SELECT * FROM requisicoes WHERE id = ?').get(req.params.id);
      if (!r) return res.status(404).json({ success: false, error: 'Requisição não encontrada' });
      if (!['aberta', 'atendida_parcial'].includes(r.status)) {
        return res.status(400).json({ success: false, error: `Status atual: ${r.status}` });
      }
      const { itens } = req.body || {};
      if (!Array.isArray(itens) || !itens.length) {
        return res.status(400).json({ success: false, error: 'itens obrigatórios [{requisicaoItemId, quantidade}]' });
      }
      const depId = r.depositoId || getDepositoPadraoId(db);
      const hoje = dataBrasilia();
      const usuario = req.session?.username || null;

      // valida tudo antes de tocar o estoque
      const aAtender = [];
      for (const e of itens) {
        const it = db.prepare('SELECT * FROM requisicao_itens WHERE id = ? AND requisicaoId = ?').get(e.requisicaoItemId, r.id);
        if (!it) return res.status(400).json({ success: false, error: `Item ${e.requisicaoItemId} não é desta requisição` });
        const q = Number(e.quantidade);
        if (!(q > 0)) continue;
        const pendente = it.quantidadeSolicitada - it.quantidadeAtendida;
        if (q > pendente + 0.001) {
          return res.status(400).json({ success: false, error: `Item ${e.requisicaoItemId}: quantidade (${q}) maior que o pendente (${pendente})` });
        }
        const saldoDep = calcularSaldo(db, it.produtoId, depId);
        if (saldoDep < q) {
          const p = db.prepare('SELECT sku FROM produtos WHERE id = ?').get(it.produtoId);
          return res.status(400).json({ success: false, error: `Saldo insuficiente de ${p?.sku || it.produtoId} no depósito (${saldoDep})` });
        }
        aAtender.push({ it, q });
      }
      if (!aAtender.length) return res.status(400).json({ success: false, error: 'Nada a atender' });

      const tx = db.transaction(() => {
        for (const { it, q } of aAtender) {
          const ctx = calcularContextoMovimento(db, it.produtoId, 'saida', q, null);
          const mv = db.prepare(`INSERT INTO movimentacoes_estoque
              (produtoId, tipo, quantidade, origem, origemId, observacao, data, depositoId,
               custoMedioAnterior, custoMedioPosterior, saldoPosterior, usuario)
            VALUES (?, 'saida', ?, 'requisicao', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            it.produtoId, q, r.id, `Requisição ${r.numero}${r.setorTexto ? ' · ' + r.setorTexto : ''}`,
            hoje, depId, ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior, usuario);
          db.prepare('UPDATE requisicao_itens SET quantidadeAtendida = quantidadeAtendida + ? WHERE id = ?').run(q, it.id);
          void mv;
        }
        const pend = db.prepare(`SELECT COALESCE(SUM(quantidadeSolicitada - quantidadeAtendida),0) p
          FROM requisicao_itens WHERE requisicaoId = ?`).get(r.id).p;
        db.prepare(`UPDATE requisicoes SET status = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(pend > 0.001 ? 'atendida_parcial' : 'atendida', r.id);
      });
      tx();
      logAction(db, req, 'atender', 'requisicao', r.id, { itens: aAtender.length });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/requisicoes/:id/cancelar', (req, res) => {
    try {
      const r = db.prepare('SELECT * FROM requisicoes WHERE id = ?').get(req.params.id);
      if (!r) return res.status(404).json({ success: false, error: 'Requisição não encontrada' });
      if (!['aberta', 'atendida_parcial'].includes(r.status)) {
        return res.status(400).json({ success: false, error: `Status atual: ${r.status}` });
      }
      db.prepare("UPDATE requisicoes SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(r.id);
      logAction(db, req, 'cancelar', 'requisicao', r.id, {});
      res.json({ success: true, aviso: r.status === 'atendida_parcial' ? 'Saídas já atendidas permanecem — estorne pelas movimentações se necessário' : undefined });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasRequisicoes, migrarRequisicoesDB };
