/**
 * depositos-routes.js — Multi-depósito: CRUD de depósitos, saldos por depósito
 * e transferências entre depósitos.
 *
 * Convenção: depositoId NULL em movimentacoes_estoque = depósito padrão.
 * Schema (depositos, transferencias_estoque, transferencia_itens) é criado
 * por migrarEstoqueDB em estoque-routes.js.
 *
 * Transferência: rascunho → em_transito (enviar: gera saídas na origem)
 *                → concluida (receber: gera entradas no destino)
 *                | cancelada (de rascunho direto; de em_transito devolve à origem)
 */

const { logAction } = require('./audit-log');
const { calcularSaldo, calcularCustoMedio, calcularContextoMovimento, getDepositoPadraoId } = require('./estoque-routes');

function dataBrasilia() {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function proximoNumeroTransferencia(db) {
  const ano = new Date().getFullYear();
  const prefixo = `TRF-${ano}-`;
  const ult = db.prepare(
    "SELECT numero FROM transferencias_estoque WHERE numero LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(prefixo + '%');
  const seq = ult ? parseInt(ult.numero.slice(prefixo.length), 10) + 1 : 1;
  return prefixo + String(seq).padStart(4, '0');
}

function registrarRotasDepositos(app, db) {
  // ==================== DEPÓSITOS ====================

  app.get('/api/depositos', (req, res) => {
    try {
      const incluirInativos = req.query.todos === '1';
      const depPadrao = getDepositoPadraoId(db);
      const rows = db.prepare(
        `SELECT * FROM depositos ${incluirInativos ? '' : 'WHERE ativo = 1'} ORDER BY padrao DESC, nome`
      ).all();
      let depositos = rows;
      if (req.query.comSaldos === '1') {
        const stmt = db.prepare(`
          SELECT COUNT(DISTINCT m.produtoId) AS produtos,
                 COALESCE(SUM(CASE WHEN m.tipo='entrada' THEN m.quantidade
                                   WHEN m.tipo='saida' THEN -m.quantidade
                                   ELSE m.quantidade END), 0) AS qtdTotal
          FROM movimentacoes_estoque m WHERE COALESCE(m.depositoId, ?) = ?`);
        depositos = rows.map(d => ({ ...d, ...stmt.get(depPadrao, d.id) }));
      }
      res.json({ success: true, depositos, depositoPadraoId: depPadrao });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/depositos', (req, res) => {
    try {
      const { nome, tipo, enderecoTexto, estabelecimentoId } = req.body || {};
      if (!nome || !nome.trim()) return res.status(400).json({ success: false, error: 'nome obrigatorio' });
      const r = db.prepare(
        "INSERT INTO depositos (nome, tipo, enderecoTexto, estabelecimentoId) VALUES (?, ?, ?, ?)"
      ).run(nome.trim(), tipo === 'terceiro' ? 'terceiro' : 'interno', enderecoTexto || null, estabelecimentoId || null);
      logAction(db, req, 'criar', 'deposito', r.lastInsertRowid, { nome });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      const msg = /UNIQUE/.test(err.message) ? 'Já existe depósito com esse nome' : err.message;
      res.status(400).json({ success: false, error: msg });
    }
  });

  app.put('/api/depositos/:id', (req, res) => {
    try {
      const dep = db.prepare('SELECT * FROM depositos WHERE id = ?').get(req.params.id);
      if (!dep) return res.status(404).json({ success: false, error: 'Deposito nao encontrado' });
      const { nome, tipo, enderecoTexto, ativo, padrao, estabelecimentoId } = req.body || {};

      if (ativo === 0 || ativo === false) {
        if (dep.padrao) return res.status(400).json({ success: false, error: 'Não é possível desativar o depósito padrão' });
        const pendente = db.prepare(
          "SELECT COUNT(*) AS n FROM transferencias_estoque WHERE status IN ('rascunho','em_transito') AND (depositoOrigemId = ? OR depositoDestinoId = ?)"
        ).get(dep.id, dep.id);
        if (pendente.n > 0) return res.status(400).json({ success: false, error: 'Há transferências pendentes neste depósito' });
      }

      const trx = db.transaction(() => {
        db.prepare(`UPDATE depositos SET
            nome = COALESCE(?, nome), tipo = COALESCE(?, tipo),
            enderecoTexto = COALESCE(?, enderecoTexto),
            ativo = COALESCE(?, ativo)
          WHERE id = ?`
        ).run(
          nome != null ? nome.trim() : null,
          tipo || null,
          enderecoTexto !== undefined ? enderecoTexto : null,
          ativo != null ? (ativo ? 1 : 0) : null,
          dep.id
        );
        // estabelecimentoId aceita NULL explícito (voltar à matriz), então não usa COALESCE.
        if (estabelecimentoId !== undefined) {
          db.prepare('UPDATE depositos SET estabelecimentoId = ? WHERE id = ?').run(estabelecimentoId || null, dep.id);
        }
        if (padrao) {
          db.prepare('UPDATE depositos SET padrao = 0').run();
          db.prepare('UPDATE depositos SET padrao = 1, ativo = 1 WHERE id = ?').run(dep.id);
        }
      });
      trx();
      logAction(db, req, 'editar', 'deposito', dep.id, req.body);
      res.json({ success: true });
    } catch (err) {
      const msg = /UNIQUE/.test(err.message) ? 'Já existe depósito com esse nome' : err.message;
      res.status(400).json({ success: false, error: msg });
    }
  });

  // Saldo por produto dentro de um depósito
  app.get('/api/depositos/:id/saldos', (req, res) => {
    try {
      const dep = db.prepare('SELECT * FROM depositos WHERE id = ?').get(req.params.id);
      if (!dep) return res.status(404).json({ success: false, error: 'Deposito nao encontrado' });
      const depPadrao = getDepositoPadraoId(db);
      const rows = db.prepare(`
        SELECT p.id, p.sku, p.descricao, p.unidade,
          COALESCE(SUM(CASE WHEN m.tipo='entrada' THEN m.quantidade
                            WHEN m.tipo='saida' THEN -m.quantidade
                            ELSE m.quantidade END), 0) AS saldo
        FROM movimentacoes_estoque m
        JOIN produtos p ON p.id = m.produtoId
        WHERE COALESCE(m.depositoId, ?) = ?
        GROUP BY p.id HAVING saldo != 0
        ORDER BY p.descricao`
      ).all(depPadrao, dep.id);
      res.json({ success: true, deposito: dep, saldos: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== TRANSFERÊNCIAS ====================

  app.get('/api/transferencias', (req, res) => {
    try {
      const { status } = req.query;
      let sql = `SELECT t.*, o.nome AS origemNome, d.nome AS destinoNome,
                   (SELECT COUNT(*) FROM transferencia_itens ti WHERE ti.transferenciaId = t.id) AS qtdItens
                 FROM transferencias_estoque t
                 JOIN depositos o ON o.id = t.depositoOrigemId
                 JOIN depositos d ON d.id = t.depositoDestinoId`;
      const params = [];
      if (status) { sql += ' WHERE t.status = ?'; params.push(status); }
      sql += ' ORDER BY t.id DESC LIMIT 200';
      res.json({ success: true, transferencias: db.prepare(sql).all(...params) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/transferencias/:id', (req, res) => {
    try {
      const t = db.prepare(`
        SELECT t.*, o.nome AS origemNome, d.nome AS destinoNome
        FROM transferencias_estoque t
        JOIN depositos o ON o.id = t.depositoOrigemId
        JOIN depositos d ON d.id = t.depositoDestinoId
        WHERE t.id = ?`).get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Transferencia nao encontrada' });
      const itens = db.prepare(`
        SELECT ti.*, p.sku, p.descricao, p.unidade, l.numero AS loteNumero
        FROM transferencia_itens ti
        JOIN produtos p ON p.id = ti.produtoId
        LEFT JOIN lotes l ON l.id = ti.loteId
        WHERE ti.transferenciaId = ?`).all(t.id);
      res.json({ success: true, transferencia: t, itens });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Cria transferência. itens: [{produtoId, quantidade, loteId?}]
  app.post('/api/transferencias', (req, res) => {
    try {
      const { depositoOrigemId, depositoDestinoId, itens, observacao } = req.body || {};
      if (!depositoOrigemId || !depositoDestinoId) {
        return res.status(400).json({ success: false, error: 'depositoOrigemId e depositoDestinoId obrigatorios' });
      }
      if (Number(depositoOrigemId) === Number(depositoDestinoId)) {
        return res.status(400).json({ success: false, error: 'Origem e destino devem ser diferentes' });
      }
      for (const id of [depositoOrigemId, depositoDestinoId]) {
        const dep = db.prepare('SELECT id FROM depositos WHERE id = ? AND ativo = 1').get(id);
        if (!dep) return res.status(400).json({ success: false, error: `Deposito ${id} inexistente ou inativo` });
      }
      if (!Array.isArray(itens) || !itens.length) {
        return res.status(400).json({ success: false, error: 'Informe ao menos 1 item' });
      }
      for (const it of itens) {
        if (!it.produtoId || !(Number(it.quantidade) > 0)) {
          return res.status(400).json({ success: false, error: 'Cada item exige produtoId e quantidade > 0' });
        }
      }

      const usuario = req.session?.username || null;
      const trx = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO transferencias_estoque (numero, depositoOrigemId, depositoDestinoId, observacao, usuario)
          VALUES (?, ?, ?, ?, ?)`
        ).run(proximoNumeroTransferencia(db), Number(depositoOrigemId), Number(depositoDestinoId), observacao || null, usuario);
        const tid = r.lastInsertRowid;
        const ins = db.prepare(
          'INSERT INTO transferencia_itens (transferenciaId, produtoId, loteId, quantidade) VALUES (?, ?, ?, ?)'
        );
        for (const it of itens) ins.run(tid, it.produtoId, it.loteId || null, Number(it.quantidade));
        return tid;
      });
      const tid = trx();
      logAction(db, req, 'criar', 'transferencia-estoque', tid, { depositoOrigemId, depositoDestinoId, itens: itens.length });
      res.json({ success: true, id: tid });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Enviar: valida saldo na origem e gera as saídas (estoque "em trânsito")
  app.post('/api/transferencias/:id/enviar', (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM transferencias_estoque WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Transferencia nao encontrada' });
      if (t.status !== 'rascunho') return res.status(400).json({ success: false, error: `Status atual: ${t.status}` });
      const itens = db.prepare('SELECT * FROM transferencia_itens WHERE transferenciaId = ?').all(t.id);
      if (!itens.length) return res.status(400).json({ success: false, error: 'Transferencia sem itens' });

      for (const it of itens) {
        const saldoDep = calcularSaldo(db, it.produtoId, t.depositoOrigemId);
        if (saldoDep < it.quantidade) {
          const p = db.prepare('SELECT sku FROM produtos WHERE id = ?').get(it.produtoId);
          return res.status(400).json({ success: false, error: `Saldo insuficiente na origem para ${p?.sku || it.produtoId} (${saldoDep})` });
        }
      }

      const hoje = dataBrasilia();
      const trx = db.transaction(() => {
        for (const it of itens) {
          const ctx = calcularContextoMovimento(db, it.produtoId, 'saida', it.quantidade, null);
          const r = db.prepare(`
            INSERT INTO movimentacoes_estoque
              (produtoId, tipo, quantidade, origem, origemId, observacao, data, loteId, depositoId,
               custoMedioAnterior, custoMedioPosterior, saldoPosterior)
            VALUES (?, 'saida', ?, 'transferencia', ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            it.produtoId, it.quantidade, t.id, `Transferência ${t.numero} (envio)`, hoje,
            it.loteId, t.depositoOrigemId,
            ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior
          );
          db.prepare('UPDATE transferencia_itens SET movSaidaId = ? WHERE id = ?').run(r.lastInsertRowid, it.id);
        }
        db.prepare("UPDATE transferencias_estoque SET status = 'em_transito', dataEnvio = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?")
          .run(hoje, t.id);
      });
      trx();
      logAction(db, req, 'enviar', 'transferencia-estoque', t.id, { numero: t.numero });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Receber: gera as entradas no destino com custo médio atual (não altera o custo médio)
  app.post('/api/transferencias/:id/receber', (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM transferencias_estoque WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Transferencia nao encontrada' });
      if (t.status !== 'em_transito') return res.status(400).json({ success: false, error: `Status atual: ${t.status}` });
      const itens = db.prepare('SELECT * FROM transferencia_itens WHERE transferenciaId = ?').all(t.id);

      const hoje = dataBrasilia();
      const trx = db.transaction(() => {
        for (const it of itens) {
          const custoMedio = calcularCustoMedio(db, it.produtoId) || null;
          const ctx = calcularContextoMovimento(db, it.produtoId, 'entrada', it.quantidade, custoMedio);
          const r = db.prepare(`
            INSERT INTO movimentacoes_estoque
              (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, loteId, depositoId,
               custoMedioAnterior, custoMedioPosterior, saldoPosterior)
            VALUES (?, 'entrada', ?, ?, 'transferencia', ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            it.produtoId, it.quantidade, custoMedio, t.id, `Transferência ${t.numero} (recebimento)`, hoje,
            it.loteId, t.depositoDestinoId,
            ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior
          );
          db.prepare('UPDATE transferencia_itens SET movEntradaId = ? WHERE id = ?').run(r.lastInsertRowid, it.id);
        }
        db.prepare("UPDATE transferencias_estoque SET status = 'concluida', dataRecebimento = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?")
          .run(hoje, t.id);
      });
      trx();
      logAction(db, req, 'receber', 'transferencia-estoque', t.id, { numero: t.numero });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Cancelar: rascunho apenas marca; em trânsito devolve o saldo à origem
  app.post('/api/transferencias/:id/cancelar', (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM transferencias_estoque WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Transferencia nao encontrada' });
      if (!['rascunho', 'em_transito'].includes(t.status)) {
        return res.status(400).json({ success: false, error: `Status atual: ${t.status}` });
      }

      const hoje = dataBrasilia();
      const trx = db.transaction(() => {
        if (t.status === 'em_transito') {
          const itens = db.prepare('SELECT * FROM transferencia_itens WHERE transferenciaId = ? AND movSaidaId IS NOT NULL').all(t.id);
          for (const it of itens) {
            const ctx = calcularContextoMovimento(db, it.produtoId, 'entrada', it.quantidade, null);
            db.prepare(`
              INSERT INTO movimentacoes_estoque
                (produtoId, tipo, quantidade, origem, origemId, observacao, data, loteId, depositoId,
                 custoMedioAnterior, custoMedioPosterior, saldoPosterior)
              VALUES (?, 'entrada', ?, 'transferencia_cancelada', ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              it.produtoId, it.quantidade, t.id, `Transferência ${t.numero} cancelada — retorno à origem`, hoje,
              it.loteId, t.depositoOrigemId,
              ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior
            );
          }
        }
        db.prepare("UPDATE transferencias_estoque SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(t.id);
      });
      trx();
      logAction(db, req, 'cancelar', 'transferencia-estoque', t.id, { numero: t.numero, statusAnterior: t.status });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasDepositos };
