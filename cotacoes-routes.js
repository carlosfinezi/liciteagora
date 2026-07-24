/**
 * cotacoes-routes.js — Cotação de compras: solicita preços a N fornecedores,
 * compara respostas e gera pedido(s) de compra do(s) vencedor(es).
 *
 * Fluxo: rascunho → (enviar: gera tokenPublico por fornecedor) enviada
 *        → (fornecedores respondem pelo link público) em_resposta
 *        → (concluir: escolhe vencedor por item → pedidos_compra) concluida
 *        | cancelada
 *
 * Rotas públicas (link do fornecedor, sem login) ficam em
 * registrarRotasCotacaoPublica — registrado no pre-auth-routes.
 * Página pública: /portal/cotacao.html?t=<token>
 */

const crypto = require('crypto');
const { logAction } = require('./audit-log');

function dataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function migrarCotacoesDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cotacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      descricao TEXT,
      status TEXT NOT NULL DEFAULT 'rascunho',
      dataLimite TEXT,
      licitacaoRef TEXT,
      observacao TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cotacoes_status ON cotacoes(status);

    CREATE TABLE IF NOT EXISTS cotacao_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cotacaoId INTEGER NOT NULL,
      produtoId INTEGER,
      descricao TEXT NOT NULL,
      quantidade REAL NOT NULL,
      unidade TEXT DEFAULT 'UN',
      FOREIGN KEY (cotacaoId) REFERENCES cotacoes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cotitens_cot ON cotacao_itens(cotacaoId);

    CREATE TABLE IF NOT EXISTS cotacao_fornecedores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cotacaoId INTEGER NOT NULL,
      fornecedorId INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      tokenPublico TEXT UNIQUE,
      dataEnvio TEXT,
      dataResposta TEXT,
      observacaoFornecedor TEXT,
      FOREIGN KEY (cotacaoId) REFERENCES cotacoes(id),
      FOREIGN KEY (fornecedorId) REFERENCES fornecedores(id),
      UNIQUE (cotacaoId, fornecedorId)
    );
    CREATE INDEX IF NOT EXISTS idx_cotforn_token ON cotacao_fornecedores(tokenPublico);

    CREATE TABLE IF NOT EXISTS cotacao_respostas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cotacaoFornecedorId INTEGER NOT NULL,
      cotacaoItemId INTEGER NOT NULL,
      precoUnitario REAL,
      prazoEntregaDias INTEGER,
      marcaOferecida TEXT,
      observacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cotacaoFornecedorId) REFERENCES cotacao_fornecedores(id),
      FOREIGN KEY (cotacaoItemId) REFERENCES cotacao_itens(id),
      UNIQUE (cotacaoFornecedorId, cotacaoItemId)
    );
  `);
}

function proximoNumeroCotacao(db) {
  const ano = new Date().getFullYear();
  const prefixo = `COT-${ano}-`;
  const ult = db.prepare('SELECT numero FROM cotacoes WHERE numero LIKE ? ORDER BY id DESC LIMIT 1').get(prefixo + '%');
  const seq = ult ? parseInt(ult.numero.slice(prefixo.length), 10) + 1 : 1;
  return prefixo + String(seq).padStart(4, '0');
}

function detalheCotacao(db, id) {
  const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(id);
  if (!cot) return null;
  const itens = db.prepare(`SELECT ci.*, p.sku FROM cotacao_itens ci
    LEFT JOIN produtos p ON p.id = ci.produtoId WHERE ci.cotacaoId = ? ORDER BY ci.id`).all(id);
  const fornecedores = db.prepare(`SELECT cf.*, f.razaoSocial, f.email, f.telefone
    FROM cotacao_fornecedores cf JOIN fornecedores f ON f.id = cf.fornecedorId
    WHERE cf.cotacaoId = ? ORDER BY cf.id`).all(id);
  const respostas = db.prepare(`SELECT r.* FROM cotacao_respostas r
    JOIN cotacao_fornecedores cf ON cf.id = r.cotacaoFornecedorId
    WHERE cf.cotacaoId = ?`).all(id);
  return { cotacao: cot, itens, fornecedores, respostas };
}

function registrarRotasCotacoes(app, db) {
  migrarCotacoesDB(db);

  app.get('/api/cotacoes', (req, res) => {
    try {
      const { status } = req.query;
      let sql = `SELECT c.*,
          (SELECT COUNT(*) FROM cotacao_itens WHERE cotacaoId = c.id) AS qtdItens,
          (SELECT COUNT(*) FROM cotacao_fornecedores WHERE cotacaoId = c.id) AS qtdFornecedores,
          (SELECT COUNT(*) FROM cotacao_fornecedores WHERE cotacaoId = c.id AND status = 'respondida') AS qtdRespostas
        FROM cotacoes c`;
      const params = [];
      if (status) { sql += ' WHERE c.status = ?'; params.push(status); }
      sql += ' ORDER BY c.id DESC LIMIT 200';
      res.json({ success: true, cotacoes: db.prepare(sql).all(...params) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/cotacoes/:id', (req, res) => {
    try {
      const det = detalheCotacao(db, req.params.id);
      if (!det) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      res.json({ success: true, ...det });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/cotacoes', (req, res) => {
    try {
      const { descricao, dataLimite, itens, fornecedoresIds, observacao, licitacaoRef } = req.body || {};
      if (!Array.isArray(itens) || !itens.length) {
        return res.status(400).json({ success: false, error: 'Informe ao menos 1 item' });
      }
      if (!Array.isArray(fornecedoresIds) || !fornecedoresIds.length) {
        return res.status(400).json({ success: false, error: 'Informe ao menos 1 fornecedor' });
      }
      for (const it of itens) {
        if (!it.descricao || !(Number(it.quantidade) > 0)) {
          return res.status(400).json({ success: false, error: 'Cada item exige descricao e quantidade > 0' });
        }
      }
      for (const fid of fornecedoresIds) {
        const f = db.prepare('SELECT id FROM fornecedores WHERE id = ?').get(fid);
        if (!f) return res.status(400).json({ success: false, error: `Fornecedor ${fid} não encontrado` });
      }

      const usuario = req.session?.username || null;
      let cotId;
      const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO cotacoes (numero, descricao, dataLimite, observacao, licitacaoRef, usuario)
          VALUES (?, ?, ?, ?, ?, ?)`).run(
          proximoNumeroCotacao(db), descricao || null, dataLimite || null,
          observacao || null, licitacaoRef || null, usuario);
        cotId = r.lastInsertRowid;
        const insItem = db.prepare(`INSERT INTO cotacao_itens (cotacaoId, produtoId, descricao, quantidade, unidade)
          VALUES (?, ?, ?, ?, ?)`);
        for (const it of itens) {
          insItem.run(cotId, it.produtoId || null, it.descricao, Number(it.quantidade), it.unidade || 'UN');
        }
        const insForn = db.prepare('INSERT INTO cotacao_fornecedores (cotacaoId, fornecedorId) VALUES (?, ?)');
        for (const fid of fornecedoresIds) insForn.run(cotId, Number(fid));
      });
      tx();
      logAction(db, req, 'criar', 'cotacao', cotId, { itens: itens.length, fornecedores: fornecedoresIds.length });
      res.json({ success: true, id: cotId });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Gera token público por fornecedor e libera as respostas.
  app.post('/api/cotacoes/:id/enviar', (req, res) => {
    try {
      const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(req.params.id);
      if (!cot) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      if (cot.status !== 'rascunho') return res.status(400).json({ success: false, error: `Status atual: ${cot.status}` });

      const hoje = dataBrasilia();
      const tx = db.transaction(() => {
        for (const cf of db.prepare('SELECT * FROM cotacao_fornecedores WHERE cotacaoId = ?').all(cot.id)) {
          if (!cf.tokenPublico) {
            db.prepare('UPDATE cotacao_fornecedores SET tokenPublico = ?, dataEnvio = ? WHERE id = ?')
              .run(crypto.randomBytes(24).toString('hex'), hoje, cf.id);
          }
        }
        db.prepare("UPDATE cotacoes SET status = 'enviada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(cot.id);
      });
      tx();
      const links = db.prepare(`SELECT cf.tokenPublico, f.razaoSocial, f.email
        FROM cotacao_fornecedores cf JOIN fornecedores f ON f.id = cf.fornecedorId
        WHERE cf.cotacaoId = ?`).all(cot.id)
        .map(x => ({ fornecedor: x.razaoSocial, email: x.email, url: `/portal/cotacao.html?t=${x.tokenPublico}` }));
      logAction(db, req, 'enviar', 'cotacao', cot.id, { fornecedores: links.length });
      res.json({ success: true, links });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Conclui: escolhas = [{cotacaoItemId, cotacaoFornecedorId}] → 1 pedido de
  // compra por fornecedor vencedor com os itens/preços da resposta dele.
  app.post('/api/cotacoes/:id/concluir', (req, res) => {
    try {
      const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(req.params.id);
      if (!cot) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      if (!['enviada', 'em_resposta'].includes(cot.status)) {
        return res.status(400).json({ success: false, error: `Status atual: ${cot.status}` });
      }
      const { escolhas } = req.body || {};
      if (!Array.isArray(escolhas) || !escolhas.length) {
        return res.status(400).json({ success: false, error: 'escolhas obrigatórias [{cotacaoItemId, cotacaoFornecedorId}]' });
      }

      // Valida e agrupa por fornecedor
      const porFornecedor = new Map(); // cotacaoFornecedorId -> [{item, resposta}]
      const semProduto = [];
      for (const e of escolhas) {
        const item = db.prepare('SELECT * FROM cotacao_itens WHERE id = ? AND cotacaoId = ?').get(e.cotacaoItemId, cot.id);
        if (!item) return res.status(400).json({ success: false, error: `Item ${e.cotacaoItemId} não é desta cotação` });
        const cf = db.prepare('SELECT * FROM cotacao_fornecedores WHERE id = ? AND cotacaoId = ?').get(e.cotacaoFornecedorId, cot.id);
        if (!cf) return res.status(400).json({ success: false, error: `Fornecedor ${e.cotacaoFornecedorId} não é desta cotação` });
        const resp = db.prepare(`SELECT * FROM cotacao_respostas WHERE cotacaoFornecedorId = ? AND cotacaoItemId = ?`)
          .get(cf.id, item.id);
        if (!resp || !(resp.precoUnitario > 0)) {
          return res.status(400).json({ success: false, error: `Fornecedor não cotou o item "${item.descricao}"` });
        }
        if (!item.produtoId) { semProduto.push(item.descricao); continue; }
        if (!porFornecedor.has(cf.id)) porFornecedor.set(cf.id, { fornecedorId: cf.fornecedorId, itens: [] });
        porFornecedor.get(cf.id).itens.push({ item, resposta: resp });
      }
      if (!porFornecedor.size) {
        return res.status(400).json({ success: false, error: 'Nenhuma escolha com produto vinculado — vincule produtos aos itens para gerar pedido' });
      }

      const usuario = req.session?.username || null;
      const pedidosGerados = [];
      const tx = db.transaction(() => {
        for (const [, grupo] of porFornecedor) {
          // Mesma numeração/estrutura do compras-routes
          const ano = new Date().getFullYear();
          const prefixo = `PC-${ano}-`;
          const ult = db.prepare('SELECT numero FROM pedidos_compra WHERE numero LIKE ? ORDER BY id DESC LIMIT 1').get(prefixo + '%');
          const seq = ult ? parseInt((ult.numero.match(/-(\d+)$/) || [])[1] || '0', 10) + 1 : 1;
          const numero = prefixo + String(seq).padStart(4, '0');

          const valorTotal = grupo.itens.reduce((s, x) => s + x.item.quantidade * x.resposta.precoUnitario, 0);
          const r = db.prepare(`INSERT INTO pedidos_compra (numero, fornecedorId, status, valorTotal, observacoes, usuarioCriador)
            VALUES (?, ?, 'rascunho', ?, ?, ?)`).run(
            numero, grupo.fornecedorId, Number(valorTotal.toFixed(2)),
            `Gerado pela cotação ${cot.numero}`, usuario);
          const pcId = r.lastInsertRowid;
          const insItem = db.prepare(`INSERT INTO pedido_compra_itens (pedidoCompraId, produtoId, quantidade, custoUnitario)
            VALUES (?, ?, ?, ?)`);
          for (const x of grupo.itens) {
            insItem.run(pcId, x.item.produtoId, x.item.quantidade, x.resposta.precoUnitario);
          }
          pedidosGerados.push({ id: pcId, numero, fornecedorId: grupo.fornecedorId, valorTotal: Number(valorTotal.toFixed(2)) });
        }
        db.prepare("UPDATE cotacoes SET status = 'concluida', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(cot.id);
      });
      tx();
      logAction(db, req, 'concluir', 'cotacao', cot.id, { pedidos: pedidosGerados.length });
      res.json({ success: true, pedidos: pedidosGerados, itensSemProduto: semProduto });
    } catch (err) {
      console.error('[cotacao concluir]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/cotacoes/:id/cancelar', (req, res) => {
    try {
      const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(req.params.id);
      if (!cot) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      if (cot.status === 'concluida') return res.status(400).json({ success: false, error: 'Cotação concluída não pode ser cancelada' });
      db.prepare("UPDATE cotacoes SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(cot.id);
      logAction(db, req, 'cancelar', 'cotacao', cot.id, {});
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

// ==================== ROTAS PÚBLICAS (link do fornecedor) ====================
// Registradas ANTES da barreira de auth (pre-auth-routes). O token de 48 hex
// chars é a credencial; só expõe a cotação daquele fornecedor.

function registrarRotasCotacaoPublica(app, db) {
  const acharPorToken = (token) => {
    if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
    return db.prepare(`SELECT cf.*, c.numero, c.descricao AS cotDescricao, c.dataLimite, c.status AS cotStatus,
        f.razaoSocial AS fornecedorNome
      FROM cotacao_fornecedores cf
      JOIN cotacoes c ON c.id = cf.cotacaoId
      JOIN fornecedores f ON f.id = cf.fornecedorId
      WHERE cf.tokenPublico = ?`).get(token);
  };

  app.get('/api/cotacao-publica/:token', (req, res) => {
    try {
      const cf = acharPorToken(req.params.token);
      if (!cf) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      if (!['enviada', 'em_resposta'].includes(cf.cotStatus)) {
        return res.status(410).json({ success: false, error: 'Esta cotação foi encerrada' });
      }
      if (cf.dataLimite && cf.dataLimite < dataBrasilia()) {
        return res.status(410).json({ success: false, error: `Prazo encerrado em ${cf.dataLimite}` });
      }
      const itens = db.prepare('SELECT id, descricao, quantidade, unidade FROM cotacao_itens WHERE cotacaoId = ?').all(cf.cotacaoId);
      const respostas = db.prepare('SELECT cotacaoItemId, precoUnitario, prazoEntregaDias, marcaOferecida, observacao FROM cotacao_respostas WHERE cotacaoFornecedorId = ?').all(cf.id);
      res.json({
        success: true,
        cotacao: { numero: cf.numero, descricao: cf.cotDescricao, dataLimite: cf.dataLimite },
        fornecedor: cf.fornecedorNome,
        jaRespondeu: cf.status === 'respondida',
        itens, respostas
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/cotacao-publica/:token', (req, res) => {
    try {
      const cf = acharPorToken(req.params.token);
      if (!cf) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      if (!['enviada', 'em_resposta'].includes(cf.cotStatus)) {
        return res.status(410).json({ success: false, error: 'Esta cotação foi encerrada' });
      }
      if (cf.dataLimite && cf.dataLimite < dataBrasilia()) {
        return res.status(410).json({ success: false, error: `Prazo encerrado em ${cf.dataLimite}` });
      }

      const { respostas, declinar, observacao } = req.body || {};
      const hoje = dataBrasilia();
      if (declinar) {
        db.prepare(`UPDATE cotacao_fornecedores SET status = 'declinada', dataResposta = ?, observacaoFornecedor = ? WHERE id = ?`)
          .run(hoje, (observacao || '').slice(0, 500), cf.id);
        return res.json({ success: true, declinada: true });
      }
      if (!Array.isArray(respostas) || !respostas.length) {
        return res.status(400).json({ success: false, error: 'Informe as respostas ou decline' });
      }
      const itensValidos = new Set(db.prepare('SELECT id FROM cotacao_itens WHERE cotacaoId = ?').all(cf.cotacaoId).map(x => x.id));
      let gravadas = 0;
      const tx = db.transaction(() => {
        const up = db.prepare(`INSERT INTO cotacao_respostas
            (cotacaoFornecedorId, cotacaoItemId, precoUnitario, prazoEntregaDias, marcaOferecida, observacao)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(cotacaoFornecedorId, cotacaoItemId) DO UPDATE SET
            precoUnitario = excluded.precoUnitario,
            prazoEntregaDias = excluded.prazoEntregaDias,
            marcaOferecida = excluded.marcaOferecida,
            observacao = excluded.observacao`);
        for (const r of respostas) {
          if (!itensValidos.has(Number(r.cotacaoItemId))) continue;
          const preco = Number(r.precoUnitario);
          if (!(preco > 0)) continue;
          up.run(cf.id, Number(r.cotacaoItemId), preco,
            r.prazoEntregaDias != null ? Number(r.prazoEntregaDias) : null,
            (r.marcaOferecida || '').slice(0, 120) || null,
            (r.observacao || '').slice(0, 500) || null);
          gravadas++;
        }
        if (gravadas > 0) {
          db.prepare(`UPDATE cotacao_fornecedores SET status = 'respondida', dataResposta = ?, observacaoFornecedor = ? WHERE id = ?`)
            .run(hoje, (observacao || '').slice(0, 500) || null, cf.id);
          db.prepare(`UPDATE cotacoes SET status = 'em_resposta', dataAtualizacao = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'enviada'`).run(cf.cotacaoId);
        }
      });
      tx();
      if (!gravadas) return res.status(400).json({ success: false, error: 'Nenhuma resposta válida (preço > 0)' });
      res.json({ success: true, gravadas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasCotacoes, registrarRotasCotacaoPublica, migrarCotacoesDB };
