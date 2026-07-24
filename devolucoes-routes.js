/**
 * devolucoes-routes.js — Devolução/RMA de venda.
 *
 * Fluxo:
 *   Aberta → (edita itens) → Efetivada (gera entrada de estoque + CR negativo / crédito)
 *   Aberta → Cancelada (sem efeito)
 *
 * Crédito ao cliente: contas_a_receber com `valor < 0` e `descricao` referenciando a devolução.
 * NF-e de devolução não é emitida automaticamente nesta versão — emitir manualmente em fiscal.
 */

const { logAction } = require('./audit-log');

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* idempotente */ } }

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devolucoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      pedidoId INTEGER,
      clienteId INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'aberta',
      motivo TEXT,
      observacoes TEXT,
      valorTotal REAL DEFAULT 0,
      dataAbertura TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      dataEfetivacao TEXT,
      dataCancelamento TEXT,
      crNegativoId INTEGER,
      usuarioCriacao TEXT,
      usuarioEfetivacao TEXT,
      FOREIGN KEY (pedidoId) REFERENCES pedidos(id),
      FOREIGN KEY (clienteId) REFERENCES pessoas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_dev_cliente ON devolucoes(clienteId);
    CREATE INDEX IF NOT EXISTS idx_dev_pedido ON devolucoes(pedidoId);
    CREATE INDEX IF NOT EXISTS idx_dev_status ON devolucoes(status, dataAbertura);

    CREATE TABLE IF NOT EXISTS devolucao_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      devolucaoId INTEGER NOT NULL,
      pedidoItemId INTEGER,
      produtoId INTEGER NOT NULL,
      descricao TEXT NOT NULL,
      quantidade REAL NOT NULL,
      valorUnitario REAL NOT NULL,
      valorTotal REAL NOT NULL,
      loteId INTEGER,
      serialIds TEXT,
      motivo TEXT,
      movEntradaId INTEGER,
      FOREIGN KEY (devolucaoId) REFERENCES devolucoes(id) ON DELETE CASCADE,
      FOREIGN KEY (produtoId) REFERENCES produtos(id),
      FOREIGN KEY (pedidoItemId) REFERENCES pedido_itens(id),
      FOREIGN KEY (loteId) REFERENCES lotes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_dev_itens_dev ON devolucao_itens(devolucaoId);
    CREATE INDEX IF NOT EXISTS idx_dev_itens_pedido_item ON devolucao_itens(pedidoItemId);
  `);
}

function gerarNumero(db) {
  const ano = new Date().getFullYear();
  const prefixo = `DV-${ano}-`;
  const ultimo = db.prepare(`SELECT numero FROM devolucoes WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(prefixo + '%');
  let proximo = 1;
  if (ultimo) {
    const m = ultimo.numero.match(/-(\d+)$/);
    if (m) proximo = parseInt(m[1], 10) + 1;
  }
  return prefixo + String(proximo).padStart(4, '0');
}

function recalcTotal(db, devolucaoId) {
  const total = db.prepare('SELECT COALESCE(SUM(valorTotal),0) AS t FROM devolucao_itens WHERE devolucaoId = ?').get(devolucaoId).t;
  db.prepare('UPDATE devolucoes SET valorTotal = ? WHERE id = ?').run(total, devolucaoId);
  return total;
}

function registrarRotasDevolucoes(app, db) {
  migrarDB(db);

  // ==================== LISTAGEM ====================

  app.get('/api/devolucoes', (req, res) => {
    try {
      const { clienteId, status, dataIni, dataFim, q, limit } = req.query;
      let sql = `SELECT d.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
                        pe.numero AS pedidoNumero
                 FROM devolucoes d
                 JOIN pessoas p ON p.id = d.clienteId
                 LEFT JOIN pedidos pe ON pe.id = d.pedidoId
                 WHERE 1=1`;
      const params = [];
      if (clienteId) { sql += ' AND d.clienteId = ?'; params.push(Number(clienteId)); }
      if (status)    { sql += ' AND d.status = ?';    params.push(status); }
      if (dataIni)   { sql += ' AND d.dataAbertura >= ?'; params.push(dataIni); }
      if (dataFim)   { sql += ' AND d.dataAbertura <= ?'; params.push(dataFim + ' 23:59:59'); }
      if (q)         { sql += ' AND (d.numero LIKE ? OR p.razaoSocial LIKE ?)'; const like = `%${q}%`; params.push(like, like); }
      sql += ' ORDER BY d.id DESC LIMIT ?';
      params.push(Number(limit) || 200);
      const devolucoes = db.prepare(sql).all(...params);
      res.json({ success: true, devolucoes });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Detalhe (cabeçalho + itens)
  app.get('/api/devolucoes/:id', (req, res) => {
    try {
      const dev = db.prepare(`
        SELECT d.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
               pe.numero AS pedidoNumero
        FROM devolucoes d
        JOIN pessoas p ON p.id = d.clienteId
        LEFT JOIN pedidos pe ON pe.id = d.pedidoId
        WHERE d.id = ?
      `).get(req.params.id);
      if (!dev) return res.status(404).json({ success: false, error: 'Devolução não encontrada' });
      const itens = db.prepare(`
        SELECT di.*, p.sku, p.descricao AS produtoDescricao, p.unidade,
               p.rastreiaLote, p.rastreiaSerial,
               l.numero AS loteNumero
        FROM devolucao_itens di
        JOIN produtos p ON p.id = di.produtoId
        LEFT JOIN lotes l ON l.id = di.loteId
        WHERE di.devolucaoId = ?
        ORDER BY di.id
      `).all(req.params.id);
      res.json({ success: true, devolucao: dev, itens });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Itens disponíveis para devolução de um pedido (qtd vendida menos já devolvida)
  app.get('/api/devolucoes/pedido/:pedidoId/disponivel', (req, res) => {
    try {
      const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.pedidoId);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido não encontrado' });
      const itens = db.prepare(`
        SELECT pi.id AS pedidoItemId, pi.produtoId, pi.descricao, pi.quantidade AS qtdVendida,
               pi.precoUnitario, pi.valorTotal,
               p.sku, p.unidade, p.rastreiaLote, p.rastreiaSerial,
               COALESCE((SELECT SUM(di.quantidade) FROM devolucao_itens di
                         JOIN devolucoes d ON d.id = di.devolucaoId
                         WHERE di.pedidoItemId = pi.id AND d.status = 'efetivada'), 0) AS qtdDevolvida
        FROM pedido_itens pi
        JOIN produtos p ON p.id = pi.produtoId
        WHERE pi.pedidoId = ?
        ORDER BY pi.id
      `).all(req.params.pedidoId);
      const itensComSaldo = itens.map(i => ({
        ...i,
        qtdDisponivel: Number(i.qtdVendida) - Number(i.qtdDevolvida)
      }));
      res.json({ success: true, pedido, itens: itensComSaldo });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CRIAR ====================

  app.post('/api/devolucoes', (req, res) => {
    try {
      const { pedidoId, clienteId, motivo, observacoes, itens, tipoOperacaoId } = req.body;
      if (!clienteId) return res.status(400).json({ success: false, error: 'clienteId obrigatório' });
      if (!Array.isArray(itens) || itens.length === 0) {
        return res.status(400).json({ success: false, error: 'Informe ao menos um item' });
      }

      // tipoOperacaoId vem do seletor do modal — se ausente, usa DEV-DEFEITO (default).
      let tipoOpFinal = tipoOperacaoId || null;
      if (!tipoOpFinal) {
        const def = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = 'DEV-DEFEITO'`).get();
        tipoOpFinal = def?.id || null;
      }

      const trx = db.transaction(() => {
        const numero = gerarNumero(db);
        const r = db.prepare(`
          INSERT INTO devolucoes (numero, pedidoId, clienteId, motivo, observacoes, tipoOperacaoId, usuarioCriacao)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(numero, pedidoId || null, clienteId, motivo || null, observacoes || null, tipoOpFinal, req.user?.username || null);
        const devId = r.lastInsertRowid;

        const stmtItem = db.prepare(`
          INSERT INTO devolucao_itens
            (devolucaoId, pedidoItemId, produtoId, descricao, quantidade, valorUnitario, valorTotal, loteId, serialIds, motivo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const it of itens) {
          if (!it.produtoId || !it.quantidade || it.valorUnitario == null) {
            throw new Error(`Item inválido: produtoId, quantidade e valorUnitario são obrigatórios`);
          }
          const qtd = Number(it.quantidade);
          const valor = Number(it.valorUnitario);
          stmtItem.run(
            devId, it.pedidoItemId || null, it.produtoId,
            it.descricao || '', qtd, valor, qtd * valor,
            it.loteId || null,
            Array.isArray(it.serialIds) && it.serialIds.length ? JSON.stringify(it.serialIds) : null,
            it.motivo || null
          );
        }
        recalcTotal(db, devId);
        return devId;
      });
      const devId = trx();
      logAction(db, req, 'criar', 'devolucao', devId, { clienteId, pedidoId, itens: itens.length });
      const dev = db.prepare('SELECT * FROM devolucoes WHERE id = ?').get(devId);
      res.json({ success: true, devolucao: dev });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ==================== EDITAR (apenas aberta) ====================

  app.put('/api/devolucoes/:id', (req, res) => {
    try {
      const dev = db.prepare('SELECT * FROM devolucoes WHERE id = ?').get(req.params.id);
      if (!dev) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (dev.status !== 'aberta') return res.status(400).json({ success: false, error: 'Só é possível editar devolução aberta' });

      const { motivo, observacoes, itens } = req.body;

      const trx = db.transaction(() => {
        if (motivo !== undefined || observacoes !== undefined) {
          db.prepare('UPDATE devolucoes SET motivo = COALESCE(?, motivo), observacoes = COALESCE(?, observacoes) WHERE id = ?')
            .run(motivo ?? null, observacoes ?? null, dev.id);
        }
        if (Array.isArray(itens)) {
          db.prepare('DELETE FROM devolucao_itens WHERE devolucaoId = ?').run(dev.id);
          const stmtItem = db.prepare(`
            INSERT INTO devolucao_itens
              (devolucaoId, pedidoItemId, produtoId, descricao, quantidade, valorUnitario, valorTotal, loteId, serialIds, motivo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const it of itens) {
            const qtd = Number(it.quantidade);
            const valor = Number(it.valorUnitario);
            stmtItem.run(
              dev.id, it.pedidoItemId || null, it.produtoId,
              it.descricao || '', qtd, valor, qtd * valor,
              it.loteId || null,
              Array.isArray(it.serialIds) && it.serialIds.length ? JSON.stringify(it.serialIds) : null,
              it.motivo || null
            );
          }
          recalcTotal(db, dev.id);
        }
      });
      trx();
      logAction(db, req, 'editar', 'devolucao', dev.id, null);
      const atualizado = db.prepare('SELECT * FROM devolucoes WHERE id = ?').get(dev.id);
      res.json({ success: true, devolucao: atualizado });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ==================== EFETIVAR ====================
  // Retorna estoque (entrada por item) + cria CR com valor negativo (crédito ao cliente).

  app.post('/api/devolucoes/:id/efetivar', (req, res) => {
    try {
      const dev = db.prepare('SELECT * FROM devolucoes WHERE id = ?').get(req.params.id);
      if (!dev) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (dev.status !== 'aberta') return res.status(400).json({ success: false, error: 'Devolução não está aberta' });

      const itens = db.prepare(`
        SELECT di.*, p.sku, p.rastreiaLote, p.rastreiaSerial
        FROM devolucao_itens di
        JOIN produtos p ON p.id = di.produtoId
        WHERE di.devolucaoId = ?
      `).all(dev.id);
      if (!itens.length) return res.status(400).json({ success: false, error: 'Devolução sem itens' });

      // Validações de rastreabilidade antes de iniciar a transação
      for (const it of itens) {
        if (it.rastreiaLote && !it.loteId) {
          return res.status(400).json({ success: false, error: `Item ${it.sku} rastreia lote — informe o lote` });
        }
        if (it.rastreiaSerial) {
          const serials = it.serialIds ? JSON.parse(it.serialIds) : [];
          if (serials.length !== Number(it.quantidade)) {
            return res.status(400).json({ success: false, error: `Item ${it.sku} rastreia série — informe ${it.quantidade} série(s)` });
          }
        }
      }

      const dataHoje = new Date().toISOString().slice(0, 10);

      const trx = db.transaction(() => {
        // 1. Cria CR negativo (crédito ao cliente)
        let crId = null;
        if (Number(dev.valorTotal) > 0) {
          const r = db.prepare(`
            INSERT INTO contas_a_receber
              (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, origem)
            VALUES (?, ?, ?, ?, ?, 'aberta', ?)
          `).run(
            dev.clienteId,
            `Crédito por devolução ${dev.numero}`,
            -Number(dev.valorTotal),
            dataHoje,
            dataHoje,
            'devolucao'
          );
          crId = r.lastInsertRowid;
        }

        // 2. Para cada item: registra entrada no estoque + atualiza serial
        const stmtMov = db.prepare(`
          INSERT INTO movimentacoes_estoque
            (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, loteId, motivo, usuario)
          VALUES (?, 'entrada', ?, ?, 'devolucao', ?, ?, ?, ?, ?, ?)
        `);
        for (const it of itens) {
          const movResult = stmtMov.run(
            it.produtoId, Number(it.quantidade), Number(it.valorUnitario),
            dev.id,
            `Devolução ${dev.numero}`,
            dataHoje, it.loteId || null,
            it.motivo || dev.motivo || null,
            req.user?.username || null
          );
          const movId = movResult.lastInsertRowid;
          db.prepare('UPDATE devolucao_itens SET movEntradaId = ? WHERE id = ?').run(movId, it.id);

          // Atualiza saldo do lote (entrada)
          if (it.loteId) {
            db.prepare('UPDATE lotes SET saldoAtual = saldoAtual + ? WHERE id = ?').run(Number(it.quantidade), it.loteId);
          }

          // Atualiza seriais devolvidos: voltam para disponível
          if (it.serialIds) {
            const serials = JSON.parse(it.serialIds);
            for (const sid of serials) {
              db.prepare(`UPDATE serial_numbers SET status='disponivel', movEntradaId = ?, movSaidaId = NULL WHERE id = ?`)
                .run(movId, sid);
            }
          }
        }

        // 3. Marca devolução como efetivada
        db.prepare(`
          UPDATE devolucoes
             SET status = 'efetivada',
                 dataEfetivacao = CURRENT_TIMESTAMP,
                 crNegativoId = ?,
                 usuarioEfetivacao = ?
           WHERE id = ?
        `).run(crId, req.user?.username || null, dev.id);
      });
      trx();
      logAction(db, req, 'efetivar', 'devolucao', dev.id, { valorTotal: dev.valorTotal, itens: itens.length });
      const atualizado = db.prepare('SELECT * FROM devolucoes WHERE id = ?').get(dev.id);
      res.json({ success: true, devolucao: atualizado });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ==================== EMITIR NF-e DE DEVOLUÇÃO ====================
  // Cria uma fatura "virtual" marcada como isDevolucao=1, copia os itens
  // da devolução e dispara a emissão SEFAZ via pipeline padrão em
  // nfe-emit-routes.js. CFOP de devolução derivado por UF (mesma UF = 1202,
  // outra UF = 2202). Se a devolução referenciar pedido com NF-e original,
  // a chave original é passada via refNFe (grupo refFatura).
  app.post('/api/devolucoes/:id/emitir-nfe', async (req, res) => {
    try {
      const dev = db.prepare('SELECT * FROM devolucoes WHERE id = ?').get(req.params.id);
      if (!dev) return res.status(404).json({ success: false, error: 'Devolução não encontrada' });
      if (dev.status !== 'efetivada') {
        return res.status(400).json({ success: false, error: 'Devolução precisa estar efetivada antes de emitir NF-e' });
      }

      // Já emitida?
      const faturaJa = db.prepare('SELECT id, statusSefaz, chaveAcesso FROM faturas WHERE devolucaoId = ? ORDER BY id DESC LIMIT 1').get(dev.id);
      if (faturaJa && faturaJa.statusSefaz === 'autorizada') {
        return res.status(400).json({ success: false, error: 'NF-e já autorizada — chave: ' + faturaJa.chaveAcesso, faturaId: faturaJa.id });
      }

      const itens = db.prepare(`
        SELECT di.*, p.sku, p.descricao AS prodDescricao, p.ncm, p.cfopPadrao, p.origem,
               p.unidade AS prodUnidade
        FROM devolucao_itens di
        JOIN produtos p ON p.id = di.produtoId
        WHERE di.devolucaoId = ?
      `).all(dev.id);
      if (!itens.length) return res.status(400).json({ success: false, error: 'Devolução sem itens' });

      // CFOP por item resolvido via motor de Tipo de Operação.
      // O tipo da devolução (DEV-DEFEITO / DEV-ARREP / DEV-TROCA) define o CFOP default
      // por destino; motor refina por cliente/UF.
      const { sugerirCFOP } = require('./tipos-operacao-routes');
      const cfopPorItem = new Map();
      for (const it of itens) {
        const sug = sugerirCFOP(db, {
          tipoOperacaoId: dev.tipoOperacaoId,
          clienteId: dev.clienteId,
          produtoId: it.produtoId
        });
        cfopPorItem.set(it.id, sug?.cfop || '1202');
      }

      // NF-e de referência: se o pedido original tem fatura autorizada, usa a chave
      let refNFeOriginal = null;
      if (dev.pedidoId) {
        const faturaOriginal = db.prepare(`
          SELECT chaveAcesso FROM faturas
          WHERE pedidoId = ? AND statusSefaz = 'autorizada'
            AND (isDevolucao IS NULL OR isDevolucao = 0)
          ORDER BY id DESC LIMIT 1
        `).get(dev.pedidoId);
        if (faturaOriginal?.chaveAcesso) refNFeOriginal = faturaOriginal.chaveAcesso;
      }

      // Fatura exige pedidoId NOT NULL no schema — devolução avulsa sem pedido
      // original não consegue emitir NF-e pela via atual.
      if (!dev.pedidoId) {
        return res.status(400).json({
          success: false,
          error: 'Devolução sem pedido de origem não pode emitir NF-e pela via automática — use Fiscal → NF-e manual'
        });
      }

      // Cria fatura virtual
      const dataEmissao = new Date().toISOString().slice(0, 10);
      const numeroFatura = `FT-DEV-${dev.numero}`;
      const valorTotal = Number(dev.valorTotal) || 0;

      const faturaId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO faturas (numero, pedidoId, clienteId, dataEmissao, dataVencimento,
            valorBruto, valorTotal, status, observacao,
            isDevolucao, devolucaoId, refNFeOriginal, tipoOperacaoId)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'emitida', ?, 1, ?, ?, ?)
        `).run(
          numeroFatura, dev.pedidoId, dev.clienteId, dataEmissao, dataEmissao,
          valorTotal, valorTotal,
          `NF-e de devolução da venda ${dev.numero}${dev.motivo ? ' · ' + dev.motivo : ''}`,
          dev.id, refNFeOriginal, dev.tipoOperacaoId || null
        );
        const fid = r.lastInsertRowid;

        const stmtItem = db.prepare(`
          INSERT INTO fatura_itens (faturaId, produtoId, sku, descricao, unidade,
            quantidade, precoUnitario, valorTotal, ncm, cfop, origem)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const it of itens) {
          stmtItem.run(
            fid, it.produtoId, it.sku || '', it.descricao || it.prodDescricao || '',
            it.prodUnidade || 'UN',
            Number(it.quantidade), Number(it.valorUnitario), Number(it.valorTotal),
            it.ncm || '00000000',
            cfopPorItem.get(it.id),
            it.origem || '0'
          );
        }
        return fid;
      })();

      // Dispara emissão via pipeline normal
      const { emitirNFe } = require('./nfe-emit-routes');
      try {
        const resultado = await emitirNFe(db, faturaId);
        const fatura = db.prepare('SELECT statusSefaz, chaveAcesso, rejeicaoMotivo FROM faturas WHERE id = ?').get(faturaId);
        res.json({
          success: true,
          faturaId,
          statusSefaz: fatura.statusSefaz,
          chaveAcesso: fatura.chaveAcesso,
          motivo: fatura.rejeicaoMotivo,
          resultado,
        });
      } catch (emitErr) {
        res.status(500).json({ success: false, error: 'Falha na emissão: ' + emitErr.message, faturaId });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CANCELAR ====================

  app.delete('/api/devolucoes/:id', (req, res) => {
    try {
      const dev = db.prepare('SELECT * FROM devolucoes WHERE id = ?').get(req.params.id);
      if (!dev) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (dev.status === 'efetivada') {
        return res.status(400).json({ success: false, error: 'Devolução efetivada — estorne pelo módulo de estoque/CR' });
      }
      db.prepare(`UPDATE devolucoes SET status = 'cancelada', dataCancelamento = CURRENT_TIMESTAMP WHERE id = ?`).run(dev.id);
      logAction(db, req, 'cancelar', 'devolucao', dev.id, null);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasDevolucoes };
