/**
 * necessidades-compra-routes.js — o elo que faltava entre a venda sem saldo e
 * a compra.
 *
 * Até aqui, produto sem saldo era beco sem saída no pedido de venda: confirmar
 * com saldo negativo (`forcar: true`) ou registrar venda perdida. As peças de
 * compra já existiam inteiras (pedido de compra, cotação, sugestão por ponto de
 * reposição); o que não existia era o caminho de uma ponta à outra, e o vínculo
 * que faz o recebimento voltar e liberar quem estava esperando.
 *
 * É o mesmo desenho que os ERPs chamam de reposição sob demanda (Odoo:
 * "replenish on order"; SAP: purchase requisition com pegging; TOTVS: "gerar
 * solicitação de compras a partir do pedido"): a linha de compra carrega a
 * ORIGEM — qual pedido de venda a pediu.
 *
 * DUAS CONTAS DE FALTA, de propósito diferentes:
 *
 *   por pedido (calcularFaltaPedido, em reservas-routes.js)
 *     "quanto deste item não tenho lastro para entregar NESTE pedido"
 *     saldo − reservado por OUTROS pedidos.
 *
 *   consolidada (aqui, GET /api/necessidades-compra)
 *     "quanto preciso comprar no total"
 *     demanda firme − saldo − o que já está a caminho.
 *
 * Somar a primeira entre pedidos daria número errado: dois pedidos disputando o
 * mesmo saldo contariam o mesmo estoque duas vezes. A consolidação só fecha no
 * nível do produto — por isso a tela agrega por produto e não por pedido.
 *
 * Uso:
 *   const { registrarRotasNecessidadesCompra } = require('./necessidades-compra-routes');
 *   registrarRotasNecessidadesCompra(app, db);   // depois de compras e pedidos
 */

const { logAction } = require('./audit-log');
const {
  calcularFaltaPedido, explodirItensPedido, pedidoMovimentaEstoque,
  saldoFisico, emTransitoCompra,
} = require('./reservas-routes');
const { proximoNumero } = require('./compras-routes');
const { proximoNumeroCotacao } = require('./cotacoes-routes');

// Pedidos que já baixaram estoque (entregue/faturado) não geram necessidade —
// a saída deles já está no saldo. Cancelado tampouco.
const STATUS_DEMANDA = ['confirmado', 'em_separacao'];

const DESTINOS = ['pedido_compra', 'cotacao'];

function custoDeReposicao(db, produtoId, precoCusto) {
  const m = db.prepare(`
    SELECT custoMedioPosterior FROM movimentacoes_estoque
    WHERE produtoId = ? AND custoMedioPosterior IS NOT NULL
    ORDER BY data DESC, id DESC LIMIT 1`).get(produtoId);
  return (m && m.custoMedioPosterior) || precoCusto || 0;
}

/**
 * Compras (PC e cotação) geradas a partir de um pedido de venda, com o que
 * ainda falta chegar. É o que a tela do pedido mostra como "compras vinculadas".
 */
function comprasVinculadas(db, pedidoId) {
  const pedidos = db.prepare(`
    SELECT pc.id, pc.numero, pc.status, pc.dataPrevistaEntrega,
           f.razaoSocial AS fornecedorNome,
           COUNT(pci.id) AS qtdItens,
           COALESCE(SUM(pci.quantidade), 0) AS quantidade,
           COALESCE(SUM(pci.quantidadeRecebida), 0) AS quantidadeRecebida
    FROM pedido_compra_itens pci
    JOIN pedidos_compra pc ON pc.id = pci.pedidoCompraId
    LEFT JOIN pessoas f ON f.id = pc.fornecedorId
    WHERE pci.origemTipo = 'pedido_venda' AND pci.origemId = ?
    GROUP BY pc.id ORDER BY pc.id DESC`).all(pedidoId)
    .map(r => ({ ...r, tipo: 'pedido_compra' }));

  const cotacoes = db.prepare(`
    SELECT c.id, c.numero, c.status, COUNT(ci.id) AS qtdItens,
           COALESCE(SUM(ci.quantidade), 0) AS quantidade
    FROM cotacao_itens ci
    JOIN cotacoes c ON c.id = ci.cotacaoId
    WHERE ci.origemTipo = 'pedido_venda' AND ci.origemId = ?
    GROUP BY c.id ORDER BY c.id DESC`).all(pedidoId)
    .map(r => ({ ...r, tipo: 'cotacao' }));

  return [...pedidos, ...cotacoes];
}

function registrarRotasNecessidadesCompra(app, db) {

  // ==================== FALTA DE UM PEDIDO ====================

  // GET /api/pedidos/:id/falta — o que falta para este pedido + as compras que
  // já foram abertas por causa dele.
  app.get('/api/pedidos/:id/falta', (req, res) => {
    try {
      const ped = db.prepare('SELECT id, numero, status FROM pedidos WHERE id = ?').get(req.params.id);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      const itens = calcularFaltaPedido(db, Number(ped.id));
      res.json({
        success: true,
        pedido: { id: ped.id, numero: ped.numero, status: ped.status },
        itens,
        faltantes: itens.filter(i => i.faltando > 0),
        compras: comprasVinculadas(db, Number(ped.id)),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== NECESSIDADE CONSOLIDADA ====================

  // GET /api/necessidades-compra?incluirRascunhos=1
  //
  // Demanda firme (o que já foi vendido e ainda não saiu) contra o saldo e o
  // que está a caminho. Irmã da sugestão de compra, não substituta: aquela
  // repõe por parâmetro e histórico, esta cobre venda que já existe.
  app.get('/api/necessidades-compra', (req, res) => {
    try {
      const incluirRascunhos = req.query.incluirRascunhos === '1';
      const status = incluirRascunhos ? [...STATUS_DEMANDA, 'rascunho'] : STATUS_DEMANDA;

      const pedidos = db.prepare(`
        SELECT p.id, p.numero, p.status, p.dataEntregaPrevista, c.razaoSocial AS clienteNome
        FROM pedidos p LEFT JOIN pessoas c ON c.id = p.clienteId
        WHERE p.status IN (${status.map(() => '?').join(',')})
        ORDER BY p.id`).all(...status);

      // Agrega a demanda por produto. Kit explodido: o componente é que se
      // compra. Tipo de operação sem movimento de estoque não gera demanda.
      const porProduto = new Map();
      for (const ped of pedidos) {
        if (!pedidoMovimentaEstoque(db, ped.id)) continue;
        for (const it of explodirItensPedido(db, ped.id)) {
          if (!it.produtoId) continue;
          const qtd = Number(it.quantidade);
          if (!(qtd > 0)) continue;
          if (!porProduto.has(it.produtoId)) porProduto.set(it.produtoId, { demanda: 0, origens: [] });
          const acc = porProduto.get(it.produtoId);
          acc.demanda += qtd;
          acc.origens.push({
            pedidoId: ped.id, pedidoNumero: ped.numero, pedidoStatus: ped.status,
            clienteNome: ped.clienteNome, pedidoItemId: it.id, quantidade: qtd,
            dataEntregaPrevista: ped.dataEntregaPrevista || null,
          });
        }
      }

      const itens = [];
      for (const [produtoId, acc] of porProduto) {
        const p = db.prepare(`
          SELECT p.id, p.sku, p.descricao, p.unidade, p.precoCusto, p.leadTimeDias,
                 p.fornecedorId, f.razaoSocial AS fornecedorNome
          FROM produtos p LEFT JOIN pessoas f ON f.id = p.fornecedorId
          WHERE p.id = ?`).get(produtoId);
        if (!p) continue;

        const saldo = saldoFisico(db, produtoId);
        const emTransito = emTransitoCompra(db, produtoId);
        const falta = Math.max(0, acc.demanda - saldo - emTransito);
        if (!(falta > 0)) continue;

        const custoUnitario = custoDeReposicao(db, produtoId, p.precoCusto);
        itens.push({
          produtoId, sku: p.sku, descricao: p.descricao, unidade: p.unidade,
          demandaFirme: acc.demanda, saldo, emTransito, falta,
          leadTimeDias: p.leadTimeDias || null,
          fornecedorId: p.fornecedorId || null,
          fornecedorNome: p.fornecedorNome || null,
          custoUnitario,
          custoEstimado: falta * custoUnitario,
          origens: acc.origens,
        });
      }
      itens.sort((a, b) => b.custoEstimado - a.custoEstimado);

      res.json({
        success: true,
        itens,
        resumo: {
          totalItens: itens.length,
          custoTotalEstimado: itens.reduce((s, i) => s + i.custoEstimado, 0),
          fornecedoresDistintos: new Set(itens.map(i => i.fornecedorId).filter(Boolean)).size,
          semFornecedor: itens.filter(i => !i.fornecedorId).length,
          pedidosConsiderados: pedidos.length,
          incluiRascunhos: incluirRascunhos,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== GERAR COMPRA A PARTIR DA NECESSIDADE ====================

  // POST /api/compras/gerar-de-necessidade
  //   { destino: 'pedido_compra' | 'cotacao',
  //     itens: [{ produtoId, quantidade, origemTipo?, origemId?, origemItemId? }],
  //     observacao?, descricao? }
  //
  // Uma linha por origem, mesmo repetindo o produto: é o vínculo que faz o
  // recebimento saber quem destravar. Agrupar por produto pouparia uma linha e
  // perderia o pegging.
  app.post('/api/compras/gerar-de-necessidade', (req, res) => {
    try {
      const { destino, itens, observacao, descricao } = req.body || {};
      if (!DESTINOS.includes(destino)) {
        return res.status(400).json({ success: false, error: `destino deve ser ${DESTINOS.join(' ou ')}` });
      }
      if (!Array.isArray(itens) || !itens.length) {
        return res.status(400).json({ success: false, error: 'Informe ao menos 1 item' });
      }

      const linhas = [];
      for (const it of itens) {
        const qtd = Number(it.quantidade);
        if (!it.produtoId || !(qtd > 0)) {
          return res.status(400).json({ success: false, error: 'Cada item exige produtoId e quantidade > 0' });
        }
        const p = db.prepare(`
          SELECT p.id, p.sku, p.descricao, p.unidade, p.precoCusto, p.tipoProduto, p.fornecedorId
          FROM produtos p WHERE p.id = ? AND p.ativo = 1`).get(it.produtoId);
        if (!p) return res.status(400).json({ success: false, error: `Produto ${it.produtoId} inexistente/inativo` });
        // Kit não se compra — compram-se os componentes. A falta já vem
        // explodida, então um kit aqui é chamada malformada.
        if (p.tipoProduto === 'kit') {
          return res.status(400).json({ success: false, error: `${p.sku} é kit — gere a compra dos componentes` });
        }
        if (it.origemTipo && it.origemTipo !== 'pedido_venda') {
          return res.status(400).json({ success: false, error: `origemTipo '${it.origemTipo}' não suportado` });
        }
        linhas.push({
          produto: p,
          quantidade: qtd,
          custoUnitario: Number(it.custoUnitario) > 0
            ? Number(it.custoUnitario)
            : custoDeReposicao(db, p.id, p.precoCusto),
          origemTipo: it.origemTipo || null,
          origemId: it.origemId ? Number(it.origemId) : null,
          origemItemId: it.origemItemId ? Number(it.origemItemId) : null,
        });
      }

      const usuario = req.session?.username || null;
      const pedidosOrigem = [...new Set(linhas.filter(l => l.origemId).map(l => l.origemId))];

      const insHistorico = db.prepare(`INSERT INTO pedido_historico
          (pedidoId, statusAnterior, statusNovo, acao, motivo, usuario, dadosExtras)
        VALUES (?, NULL, NULL, ?, ?, ?, ?)`);

      if (destino === 'cotacao') {
        let cotId;
        const numero = proximoNumeroCotacao(db);
        const tx = db.transaction(() => {
          // Rascunho sem fornecedor: quem cota escolhe na tela de cotações. É
          // por isso que não se reusa POST /api/cotacoes, que os exige.
          const r = db.prepare(`INSERT INTO cotacoes (numero, descricao, observacao, usuario)
            VALUES (?, ?, ?, ?)`).run(
            numero,
            descricao || (pedidosOrigem.length ? `Falta de saldo — pedido(s) de venda` : 'Necessidade de compra'),
            observacao || null, usuario);
          cotId = r.lastInsertRowid;
          const ins = db.prepare(`INSERT INTO cotacao_itens
              (cotacaoId, produtoId, descricao, quantidade, unidade, origemTipo, origemId, origemItemId)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const l of linhas) {
            ins.run(cotId, l.produto.id, l.produto.descricao, l.quantidade,
              l.produto.unidade || 'UN', l.origemTipo, l.origemId, l.origemItemId);
          }
          for (const pedidoId of pedidosOrigem) {
            insHistorico.run(pedidoId, 'cotacao-gerada', `Cotação ${numero} aberta pela falta de saldo`,
              usuario, JSON.stringify({ cotacaoId: cotId, numero }));
          }
        });
        tx();
        logAction(db, req, 'criar', 'cotacao', cotId, { origem: 'necessidade', itens: linhas.length });
        return res.json({ success: true, destino, cotacao: { id: cotId, numero, itens: linhas.length } });
      }

      // destino === 'pedido_compra': um PC por fornecedor. Produto sem
      // fornecedor padrão cai num PC de fornecedor a definir (fornecedorId
      // nulo) — o comprador preenche antes de enviar.
      const grupos = new Map();
      for (const l of linhas) {
        const chave = l.produto.fornecedorId || 0;
        if (!grupos.has(chave)) grupos.set(chave, []);
        grupos.get(chave).push(l);
      }

      const pedidosGerados = [];
      const tx = db.transaction(() => {
        for (const [fornecedorId, doGrupo] of grupos) {
          const numero = proximoNumero(db);
          const valorTotal = doGrupo.reduce((s, l) => s + l.quantidade * l.custoUnitario, 0);
          const r = db.prepare(`INSERT INTO pedidos_compra
              (numero, fornecedorId, status, valorTotal, observacoes, usuarioCriador)
            VALUES (?, ?, 'rascunho', ?, ?, ?)`).run(
            numero, fornecedorId || null, Number(valorTotal.toFixed(2)),
            observacao || 'Gerado pela falta de saldo em pedido de venda', usuario);
          const pcId = r.lastInsertRowid;
          const ins = db.prepare(`INSERT INTO pedido_compra_itens
              (pedidoCompraId, produtoId, quantidade, custoUnitario, origemTipo, origemId, origemItemId)
            VALUES (?, ?, ?, ?, ?, ?, ?)`);
          for (const l of doGrupo) {
            ins.run(pcId, l.produto.id, l.quantidade, l.custoUnitario,
              l.origemTipo, l.origemId, l.origemItemId);
          }
          pedidosGerados.push({
            id: pcId, numero, fornecedorId: fornecedorId || null,
            itens: doGrupo.length, valorTotal: Number(valorTotal.toFixed(2)),
            semFornecedor: !fornecedorId,
          });
        }
        for (const pedidoId of pedidosOrigem) {
          const nums = pedidosGerados.map(p => p.numero).join(', ');
          insHistorico.run(pedidoId, 'compra-gerada', `Pedido(s) de compra ${nums} abertos pela falta de saldo`,
            usuario, JSON.stringify({ pedidosCompra: pedidosGerados.map(p => ({ id: p.id, numero: p.numero })) }));
        }
      });
      tx();
      for (const p of pedidosGerados) {
        logAction(db, req, 'criar', 'pedido_compra', p.id, { origem: 'necessidade', itens: p.itens });
      }
      res.json({ success: true, destino, pedidos: pedidosGerados });
    } catch (err) {
      console.error('[necessidades-compra]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasNecessidadesCompra, comprasVinculadas };
