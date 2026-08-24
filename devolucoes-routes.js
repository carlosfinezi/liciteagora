/**
 * devolucoes-routes.js — Devolução/RMA de venda.
 *
 * Fluxo:
 *   Aberta → (edita itens) → Efetivada (gera entrada de estoque + CR negativo / crédito)
 *   Aberta → Cancelada (sem efeito)
 *   Efetivada → Estornada (desfaz o estoque e cancela o crédito)
 *
 * Crédito ao cliente: contas_a_receber com `valor < 0` e `descricao` referenciando a devolução.
 * NF-e de devolução não é emitida automaticamente nesta versão — emitir manualmente em fiscal.
 *
 * Correções 2026-07-31:
 *  - Custo de retorno: a entrada gravava `valorUnitario` (preço de VENDA) na
 *    coluna custoUnitario, o que inflava o custo médio ponderado do produto —
 *    e por tabela a margem nas metas e o custo sugerido nas compras. Agora usa
 *    o custo da saída original e preenche custo/saldo via
 *    calcularContextoMovimento(), como os demais módulos de estoque.
 *  - Quantidade: /disponivel existia mas nenhum endpoint o consultava. POST,
 *    PUT e efetivar passam a validar o saldo devolvível.
 *  - Estorno: devolução efetivada era irreversível e travava o saldo devolvível
 *    do item para sempre. Ganhou POST /:id/estornar.
 */

const { logAction } = require('./audit-log');
const { calcularContextoMovimento, calcularCustoMedio, resolverDeposito } = require('./estoque-routes');

/**
 * Data e hora de Brasília. O relógio do SQLite (CURRENT_TIMESTAMP) e o
 * toISOString() do Node são UTC: depois das 21h a devolução era carimbada com
 * o dia seguinte, e no último dia do mês ela caía na competência seguinte —
 * sumia da meta do mês em que aconteceu.
 */
function agoraBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
function hojeBrasilia() {
  return agoraBrasilia().slice(0, 10);
}

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
  // A coluna é usada pelo INSERT deste módulo mas era criada só por
  // tipos-operacao-routes.js — a ordem de carga entre os dois virava
  // dependência implícita. ALTER idempotente aqui torna o módulo
  // autossuficiente; o ALTER de lá continua e não conflita.
  alterSafe(db, 'ALTER TABLE devolucoes ADD COLUMN tipoOperacaoId INTEGER');
}

// Devolução só faz sentido para pedido que de fato saiu. Rascunho e
// orçamento nunca baixaram estoque; devolver deles criaria entrada sem
// saída correspondente.
const STATUS_PEDIDO_DEVOLVIVEL = ['entregue', 'faturado'];

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

/**
 * Custo com que a unidade devolvida volta ao estoque.
 *
 * Ordem: custo médio registrado na saída original daquele pedido+produto →
 * custo unitário da mesma saída → custo médio atual do produto.
 * NUNCA o preço de venda: um item vendido com markup entraria como se
 * tivesse custado o preço de venda e inflaria o custo médio ponderado.
 * Devolve null quando não há nenhuma fonte — melhor não mexer no custo
 * médio do que mexer com um número inventado.
 */
function custoRetorno(db, { pedidoId, produtoId }) {
  if (pedidoId) {
    const saida = db.prepare(`
      SELECT custoMedioPosterior, custoUnitario FROM movimentacoes_estoque
      WHERE origem = 'pedido' AND origemId = ? AND produtoId = ?
        AND tipo = 'saida' AND estornada = 0
      ORDER BY id DESC LIMIT 1`).get(pedidoId, produtoId);
    if (saida) {
      if (saida.custoMedioPosterior != null && saida.custoMedioPosterior > 0) {
        return { custo: saida.custoMedioPosterior, fonte: 'saida_original' };
      }
      if (saida.custoUnitario != null && saida.custoUnitario > 0) {
        return { custo: saida.custoUnitario, fonte: 'saida_original_unitario' };
      }
    }
  }
  const atual = calcularCustoMedio(db, produtoId);
  if (atual > 0) return { custo: atual, fonte: 'custo_medio_atual' };
  return { custo: null, fonte: 'desconhecido' };
}

/**
 * Saldo devolvível de um item do pedido.
 *
 * `efetivada` é o que de fato saiu do saldo. As `aberta` também entram no
 * cálculo (menos a própria devolução em edição) para não nascerem duas
 * devoluções abertas que, somadas, devolvem mais do que se vendeu.
 * `estornada` e `cancelada` ficam de fora — devolveram o saldo.
 */
function saldoDevolvivel(db, { pedidoItemId, ignorarDevolucaoId = null, apenasEfetivadas = false }) {
  const item = db.prepare('SELECT quantidade FROM pedido_itens WHERE id = ?').get(pedidoItemId);
  if (!item) return null;
  const statuses = apenasEfetivadas ? ['efetivada'] : ['efetivada', 'aberta'];
  const usado = db.prepare(`
    SELECT COALESCE(SUM(di.quantidade),0) AS q
    FROM devolucao_itens di
    JOIN devolucoes d ON d.id = di.devolucaoId
    WHERE di.pedidoItemId = ?
      AND d.status IN (${statuses.map(() => '?').join(',')})
      AND (? IS NULL OR d.id <> ?)`)
    .get(pedidoItemId, ...statuses, ignorarDevolucaoId, ignorarDevolucaoId).q;
  return { vendida: Number(item.quantidade), usado: Number(usado), saldo: Number(item.quantidade) - Number(usado) };
}

/**
 * Valida a lista de itens contra o que o pedido comporta. Lança na primeira
 * violação — a devolução inteira é recusada, não gravada pela metade.
 */
function validarQuantidades(db, { pedidoId, itens, ignorarDevolucaoId = null, apenasEfetivadas = false }) {
  // Devolução avulsa (sem pedido de origem) não tem contra o que validar.
  if (!pedidoId) return;

  const pedido = db.prepare('SELECT numero, status, modoDocumento FROM pedidos WHERE id = ?').get(pedidoId);
  if (!pedido) throw new Error('Pedido de origem não encontrado');
  if (pedido.modoDocumento === 'orcamento') {
    throw new Error(`${pedido.numero} é um orçamento — não houve venda para devolver`);
  }
  if (!STATUS_PEDIDO_DEVOLVIVEL.includes(pedido.status)) {
    throw new Error(`Pedido ${pedido.numero} está "${pedido.status}" — só é possível devolver pedido entregue ou faturado`);
  }

  // Agrega por item do pedido: dois lançamentos do mesmo item na mesma
  // devolução somam, e a soma é que precisa caber no saldo.
  const porItem = new Map();
  const porProduto = new Map();
  for (const it of itens) {
    const qtd = Number(it.quantidade) || 0;
    if (it.pedidoItemId) porItem.set(Number(it.pedidoItemId), (porItem.get(Number(it.pedidoItemId)) || 0) + qtd);
    else porProduto.set(Number(it.produtoId), (porProduto.get(Number(it.produtoId)) || 0) + qtd);
  }

  for (const [pedidoItemId, qtd] of porItem) {
    const s = saldoDevolvivel(db, { pedidoItemId, ignorarDevolucaoId, apenasEfetivadas });
    if (!s) throw new Error(`Item de pedido ${pedidoItemId} não encontrado`);
    if (qtd > s.saldo + 1e-9) {
      throw new Error(`Quantidade ${qtd} excede o devolvível do item (vendido ${s.vendida}, já devolvido ${s.usado}, saldo ${s.saldo})`);
    }
  }

  // Item solto (adicionado à mão) numa devolução COM pedido: só passa se o
  // produto foi vendido naquele pedido, e dentro do saldo agregado dele.
  for (const [produtoId, qtd] of porProduto) {
    const linhas = db.prepare('SELECT id FROM pedido_itens WHERE pedidoId = ? AND produtoId = ?').all(pedidoId, produtoId);
    if (!linhas.length) {
      const p = db.prepare('SELECT sku, descricao FROM produtos WHERE id = ?').get(produtoId);
      throw new Error(`Produto ${p?.sku || produtoId} não faz parte do pedido de origem — não pode ser devolvido nele`);
    }
    const saldoTotal = linhas.reduce((s, l) => {
      const d = saldoDevolvivel(db, { pedidoItemId: l.id, ignorarDevolucaoId, apenasEfetivadas });
      return s + (d ? d.saldo : 0);
    }, 0);
    if (qtd > saldoTotal + 1e-9) {
      const p = db.prepare('SELECT sku FROM produtos WHERE id = ?').get(produtoId);
      throw new Error(`Quantidade ${qtd} de ${p?.sku || produtoId} excede o devolvível do pedido (saldo ${saldoTotal})`);
    }
  }
}

/**
 * Estorna a comissão proporcional aos itens devolvidos.
 *
 * comissoes_apuracao tem UNIQUE(periodo, pedidoItemId), então não cabe uma
 * linha compensatória negativa como no estoque — a redução é feita na
 * própria linha. Para poder desfazer, grava na observação um marcador
 * `[dev:<id>:<valor>:<base>]` com o quanto foi tirado.
 *
 * Comissão já PAGA não é reduzida: o dinheiro saiu, e mexer na linha
 * esconderia isso. Ela é contada e devolvida como aviso, para o acerto
 * ser feito conscientemente.
 */
const MARCADOR_DEV = /\[dev:(\d+):(-?[\d.]+):(-?[\d.]+)\]/g;

function estornarComissoes(db, dev, itens) {
  let linhas = 0, pagasNaoEstornadas = 0, valorEstornado = 0;
  try {
    for (const it of itens) {
      if (!it.pedidoItemId) continue;
      const item = db.prepare('SELECT quantidade FROM pedido_itens WHERE id = ?').get(it.pedidoItemId);
      if (!item || !(Number(item.quantidade) > 0)) continue;
      const proporcao = Math.min(1, Number(it.quantidade) / Number(item.quantidade));

      const apuracoes = db.prepare('SELECT * FROM comissoes_apuracao WHERE pedidoItemId = ?').all(it.pedidoItemId);
      for (const a of apuracoes) {
        if (a.status !== 'pendente') { pagasNaoEstornadas++; continue; }
        const deduzValor = Number((a.valorComissao * proporcao).toFixed(2));
        const deduzBase = Number((a.baseCalculo * proporcao).toFixed(2));
        if (!(deduzValor > 0)) continue;
        db.prepare(`UPDATE comissoes_apuracao
             SET valorComissao = ROUND(valorComissao - ?, 2),
                 baseCalculo = ROUND(baseCalculo - ?, 2),
                 observacao = COALESCE(observacao || ' | ', '') || ?
           WHERE id = ?`)
          .run(deduzValor, deduzBase,
               `Estorno devolução ${dev.numero} [dev:${dev.id}:${deduzValor}:${deduzBase}]`, a.id);
        linhas++;
        valorEstornado += deduzValor;
      }
    }
  } catch { return { linhas: 0, pagasNaoEstornadas: 0, valorEstornado: 0 }; }  // tenant sem comissões
  return { linhas, pagasNaoEstornadas, valorEstornado: Number(valorEstornado.toFixed(2)) };
}

/** Devolve à apuração o que aquela devolução tirou, lendo o marcador. */
function desfazerEstornoComissoes(db, devolucaoId) {
  let linhas = 0;
  try {
    const alvos = db.prepare('SELECT * FROM comissoes_apuracao WHERE observacao LIKE ?')
      .all(`%[dev:${devolucaoId}:%`);
    for (const a of alvos) {
      let somaValor = 0, somaBase = 0;
      const restante = String(a.observacao).replace(MARCADOR_DEV, (tudo, id, valor, base) => {
        if (Number(id) !== Number(devolucaoId)) return tudo;   // marcador de outra devolução
        somaValor += Number(valor); somaBase += Number(base);
        return '';
      });
      if (!(somaValor > 0 || somaBase > 0)) continue;
      db.prepare(`UPDATE comissoes_apuracao
           SET valorComissao = ROUND(valorComissao + ?, 2),
               baseCalculo = ROUND(baseCalculo + ?, 2),
               observacao = ?
         WHERE id = ?`)
        .run(somaValor, somaBase,
             restante.replace(/Estorno devolução \S+\s*/g, '').replace(/\s*\|\s*$/, '').trim() || null, a.id);
      linhas++;
    }
  } catch { return 0; }
  return linhas;
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
                         WHERE di.pedidoItemId = pi.id AND d.status = 'efetivada'), 0) AS qtdDevolvida,
               COALESCE((SELECT SUM(di.quantidade) FROM devolucao_itens di
                         JOIN devolucoes d ON d.id = di.devolucaoId
                         WHERE di.pedidoItemId = pi.id AND d.status = 'aberta'), 0) AS qtdEmAberto
        FROM pedido_itens pi
        JOIN produtos p ON p.id = pi.produtoId
        WHERE pi.pedidoId = ?
        ORDER BY pi.id
      `).all(req.params.pedidoId);
      // Desconta também o que está reservado em devolução aberta — senão a
      // tela sugeriria uma quantidade que o POST recusaria em seguida.
      const itensComSaldo = itens.map(i => ({
        ...i,
        qtdDisponivel: Number(i.qtdVendida) - Number(i.qtdDevolvida) - Number(i.qtdEmAberto)
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

      // Barra quantidade acima do devolvível ANTES de gravar qualquer coisa.
      // /disponivel já calculava esse saldo, mas nenhum endpoint o consultava.
      validarQuantidades(db, { pedidoId, itens });

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

      // Mesma validação do POST, ignorando a própria devolução — senão os
      // itens que ela já reserva contariam contra ela mesma.
      if (Array.isArray(itens)) {
        validarQuantidades(db, { pedidoId: dev.pedidoId, itens, ignorarDevolucaoId: dev.id });
      }

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

      // Revalida na efetivação contando só o que já foi efetivado: entre a
      // abertura e agora, outra devolução do mesmo item pode ter sido
      // efetivada e comido o saldo.
      try {
        validarQuantidades(db, {
          pedidoId: dev.pedidoId, itens, ignorarDevolucaoId: dev.id, apenasEfetivadas: true,
        });
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
      }

      const dataHoje = hojeBrasilia();
      let comissoes = { linhas: 0, pagasNaoEstornadas: 0, valorEstornado: 0 };

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
        //
        // custoUnitario recebe o CUSTO da saída original, não o preço de
        // venda. Gravar o preço aqui inflava o custo médio ponderado do
        // produto (estoque-routes:254 faz média das entradas por
        // custoUnitario) e contaminava margem e sugestão de compra.
        const stmtMov = db.prepare(`
          INSERT INTO movimentacoes_estoque
            (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, loteId, motivo, usuario,
             custoMedioAnterior, custoMedioPosterior, saldoPosterior, depositoId)
          VALUES (?, 'entrada', ?, ?, 'devolucao', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const it of itens) {
          const { custo, fonte } = custoRetorno(db, { pedidoId: dev.pedidoId, produtoId: it.produtoId });
          // Contexto calculado ANTES do INSERT — calcularContextoMovimento lê
          // o saldo/custo vigentes, então precisa rodar com o estado anterior.
          const ctx = calcularContextoMovimento(db, it.produtoId, 'entrada', Number(it.quantidade), custo);
          const movResult = stmtMov.run(
            it.produtoId, Number(it.quantidade), custo,
            dev.id,
            `Devolução ${dev.numero} (custo: ${fonte})`,
            dataHoje, it.loteId || null,
            it.motivo || dev.motivo || null,
            req.user?.username || null,
            ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior,
            // Mercadoria devolvida volta para o depósito de onde saiu.
            resolverDeposito(db, { pedidoId: dev.pedidoId, produtoId: it.produtoId })
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

        // 3. Estorna a comissão proporcional — venda desfeita não gera
        //    comissão, e antes a apuração seguia intocada.
        comissoes = estornarComissoes(db, dev, itens);

        // 4. Marca devolução como efetivada
        db.prepare(`
          UPDATE devolucoes
             SET status = 'efetivada',
                 dataEfetivacao = ?,
                 crNegativoId = ?,
                 usuarioEfetivacao = ?
           WHERE id = ?
        `).run(agoraBrasilia(), crId, req.user?.username || null, dev.id);
      });
      trx();
      logAction(db, req, 'efetivar', 'devolucao', dev.id,
        { valorTotal: dev.valorTotal, itens: itens.length, comissoes });
      const atualizado = db.prepare('SELECT * FROM devolucoes WHERE id = ?').get(dev.id);
      res.json({
        success: true, devolucao: atualizado,
        comissoesEstornadas: comissoes.linhas,
        valorComissaoEstornado: comissoes.valorEstornado,
        // Comissão já paga não pode ser reduzida na linha — vira acerto manual.
        avisoComissaoPaga: comissoes.pagasNaoEstornadas
          ? `${comissoes.pagasNaoEstornadas} linha(s) de comissão já paga(s) NÃO foram estornadas — acerte no próximo pagamento.`
          : null,
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ==================== ESTORNAR (desfaz uma efetivação) ====================
  //
  // Antes não existia: DELETE recusava devolução efetivada mandando "estorne
  // pelo módulo de estoque/CR", ou seja, à mão e em dois lugares. Pior, o
  // saldo devolvível do item ficava consumido para sempre, então um erro de
  // digitação impedia a devolução correta de ser lançada depois.
  //
  // Espelha estornarEstoque() de pedidos-routes: não apaga a movimentação
  // original, cria a contrária e marca as duas — o histórico de estoque
  // continua auditável.
  app.post('/api/devolucoes/:id/estornar', (req, res) => {
    try {
      const dev = db.prepare('SELECT * FROM devolucoes WHERE id = ?').get(req.params.id);
      if (!dev) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (dev.status !== 'efetivada') {
        return res.status(400).json({ success: false, error: `Só devolução efetivada pode ser estornada (status atual: ${dev.status})` });
      }
      const motivo = (req.body?.motivo || '').trim();
      if (!motivo) return res.status(400).json({ success: false, error: 'motivo obrigatório' });

      // NF-e de devolução autorizada é documento fiscal: desfazer o estoque
      // sem cancelar a nota deixaria os dois em desacordo.
      let fatura = null;
      try {
        fatura = db.prepare(`SELECT id, numero, statusSefaz FROM faturas
          WHERE devolucaoId = ? AND statusSefaz = 'autorizada' ORDER BY id DESC LIMIT 1`).get(dev.id);
      } catch { /* tenant sem coluna devolucaoId */ }
      if (fatura) {
        return res.status(400).json({ success: false,
          error: `NF-e de devolução ${fatura.numero} está autorizada na SEFAZ. Cancele a nota primeiro.` });
      }

      const itens = db.prepare('SELECT * FROM devolucao_itens WHERE devolucaoId = ?').all(dev.id);
      const dataHoje = hojeBrasilia();
      const estornadas = [];
      let crCancelado = false;
      let comissoesRestauradas = 0;

      const trx = db.transaction(() => {
        for (const it of itens) {
          const mov = it.movEntradaId
            ? db.prepare('SELECT * FROM movimentacoes_estoque WHERE id = ?').get(it.movEntradaId)
            : null;
          if (mov && !mov.estornada) {
            // Saída compensatória pelo MESMO custo da entrada, senão o
            // estorno mexeria no custo médio em vez de neutralizá-lo.
            const ctx = calcularContextoMovimento(db, mov.produtoId, 'saida', mov.quantidade, mov.custoUnitario);
            const r = db.prepare(`INSERT INTO movimentacoes_estoque
                (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, loteId,
                 motivo, usuario, movOriginalId, custoMedioAnterior, custoMedioPosterior, saldoPosterior, depositoId)
              VALUES (?, 'saida', ?, ?, 'estorno_devolucao', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(mov.produtoId, mov.quantidade, mov.custoUnitario, dev.id,
                   `Estorno da devolução ${dev.numero} — ${motivo}`, dataHoje, mov.loteId || null,
                   motivo, req.session?.username || req.user?.username || null, mov.id,
                   ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior,
                   resolverDeposito(db, { movOriginalId: mov.id }));
            db.prepare('UPDATE movimentacoes_estoque SET estornada = 1, movEstornoId = ? WHERE id = ?')
              .run(r.lastInsertRowid, mov.id);
            estornadas.push({ movOriginalId: mov.id, movEstornoId: r.lastInsertRowid, produtoId: mov.produtoId });
          }

          if (it.loteId) {
            db.prepare('UPDATE lotes SET saldoAtual = saldoAtual - ? WHERE id = ?').run(Number(it.quantidade), it.loteId);
          }
          // Seriais voltam a "baixado" (o status que estoque-routes:731 dá a
          // uma série que saiu): a devolução deixou de existir, então a peça
          // está de novo com o cliente.
          if (it.serialIds) {
            for (const sid of JSON.parse(it.serialIds)) {
              db.prepare(`UPDATE serial_numbers SET status = 'baixado', movEntradaId = NULL WHERE id = ?`).run(sid);
            }
          }
          db.prepare('UPDATE devolucao_itens SET movEntradaId = NULL WHERE id = ?').run(it.id);
        }

        // Cancela o crédito ao cliente, se ainda não foi usado. 'parcial'
        // significa que já foi compensado contra algum título — desfazer
        // aqui mexeria num título já quitado.
        if (dev.crNegativoId) {
          const cr = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(dev.crNegativoId);
          if (cr && cr.status === 'aberta') {
            db.prepare(`UPDATE contas_a_receber SET status = 'cancelada' WHERE id = ?`).run(dev.crNegativoId);
            crCancelado = true;
          }
        }

        // A venda voltou a valer, então a comissão volta também.
        comissoesRestauradas = desfazerEstornoComissoes(db, dev.id);

        db.prepare(`UPDATE devolucoes
             SET status = 'estornada', dataCancelamento = ?,
                 observacoes = COALESCE(observacoes || ' | ', '') || ?
           WHERE id = ?`)
          .run(agoraBrasilia(), `Estornada em ${dataHoje}: ${motivo}`, dev.id);
      });
      trx();

      logAction(db, req, 'estornar', 'devolucao', dev.id,
        { motivo, movimentacoes: estornadas.length, crCancelado, comissoesRestauradas });
      res.json({
        success: true,
        movimentacoesEstornadas: estornadas.length,
        creditoCancelado: crCancelado,
        comissoesRestauradas,
        // Quando o crédito já foi usado, o dinheiro precisa ser resolvido
        // à mão — melhor dizer do que deixar passar em silêncio.
        avisoCredito: dev.crNegativoId && !crCancelado
          ? 'O crédito ao cliente já teve baixa/pagamento e NÃO foi cancelado — resolva no contas a receber.'
          : null,
        devolucao: db.prepare('SELECT * FROM devolucoes WHERE id = ?').get(dev.id),
      });
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
        return res.status(400).json({ success: false, error: 'Devolução efetivada — use "Estornar" (POST /api/devolucoes/:id/estornar)' });
      }
      db.prepare(`UPDATE devolucoes SET status = 'cancelada', dataCancelamento = ? WHERE id = ?`).run(agoraBrasilia(), dev.id);
      logAction(db, req, 'cancelar', 'devolucao', dev.id, null);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasDevolucoes };
