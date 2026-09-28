// lucro-produtos.js
//
// Vendido × custo × lucro, por produto e por período, juntando os três jeitos
// de vender: pedido do ERP, pedido da loja (o mesmo `pedidos`, com
// tipo='catalogo') e o balcão (NFC-e).
//
// O CUSTO de cada linha vendida sai das saídas de estoque daquele documento, e
// não do custo de hoje: é o que a venda realmente tirou do estoque, pelo custo
// da data (custoMedioAnterior, ver estoque-routes.contextoDeSaida).
//
//   - Pedido e loja: a reserva consumida carrega o item (`pedidoItemId`), então
//     o custo do item já inclui os componentes do kit e os insumos das opções
//     escolhidas (embalagem, fita, cartão).
//   - NFC-e: as saídas são da nota, sem item. O custo unitário de cada produto
//     é o daquela nota; o kit soma os componentes pela composição.
//   - Sem saída nenhuma (pedido faturado e ainda não entregue, natureza que não
//     movimenta estoque): custo atual do produto, e a linha sai marcada como
//     `estimado`. Esconder isso faria o lucro parecer maior do que é.
//
// Entram pedidos `faturado` ou `entregue` e NFC-e `autorizada`. NFC-e emitida a
// partir de pedido (nfce.pedidoId) fica de fora: a venda já foi contada no
// pedido. A receita é o valor do item (frete fora).

const { custoAtualDe } = require('./estoque-routes');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const CUSTO_MOV = 'COALESCE(m.custoMedioAnterior, m.custoUnitario, 0)';

function relatorioLucro(db, { inicio, fim }) {
  const linhas = new Map();   // produtoId -> acumulado
  const acumular = (produto, canal, qtd, receita, custo, estimado) => {
    let l = linhas.get(produto.id);
    if (!l) {
      l = { produtoId: produto.id, sku: produto.sku, descricao: produto.descricao, kit: produto.tipoProduto === 'kit',
            quantidade: 0, receita: 0, custo: 0, estimado: false, canais: {} };
      linhas.set(produto.id, l);
    }
    l.quantidade += qtd; l.receita += receita; l.custo += custo; l.estimado = l.estimado || estimado;
    const c = l.canais[canal] || (l.canais[canal] = { quantidade: 0, receita: 0, custo: 0 });
    c.quantidade += qtd; c.receita += receita; c.custo += custo;
  };
  const produto = db.prepare('SELECT id, sku, descricao, tipoProduto FROM produtos WHERE id = ?');
  const composicao = db.prepare('SELECT produtoFilhoId, quantidade FROM produto_kit_itens WHERE produtoPaiId = ?');

  // ── pedidos (ERP e loja) ──────────────────────────────────────────────
  const itensPedido = db.prepare(`
    SELECT i.id, i.pedidoId, i.produtoId, i.quantidade, i.valorTotal, p.tipo
      FROM pedido_itens i JOIN pedidos p ON p.id = i.pedidoId
     WHERE p.status IN ('faturado', 'entregue') AND i.produtoId IS NOT NULL
       AND date(p.dataPedido) BETWEEN ? AND ?`).all(inicio, fim);
  const custoPorReserva = db.prepare(`
    SELECT COUNT(*) n, COALESCE(SUM(m.quantidade * ${CUSTO_MOV}), 0) custo
      FROM reservas_estoque r JOIN movimentacoes_estoque m ON m.id = r.movimentacaoConsumoId
     WHERE r.pedidoItemId = ? AND r.status = 'consumida'`);
  // Pedido antigo, entregue sem reserva: a saída é do pedido, por produto.
  const custoSemReserva = db.prepare(`
    SELECT COALESCE(SUM(m.quantidade * ${CUSTO_MOV}), 0) custo, COALESCE(SUM(m.quantidade), 0) q
      FROM movimentacoes_estoque m
     WHERE m.tipo = 'saida' AND m.origem = 'pedido' AND m.origemId = ? AND m.produtoId = ?
       AND m.observacao LIKE '%(sem reserva)%'`);
  for (const it of itensPedido) {
    const p = produto.get(it.produtoId);
    if (!p) continue;
    const qtd = Number(it.quantidade) || 0;
    let custo, estimado = false;
    const r = custoPorReserva.get(it.id);
    if (r.n > 0) custo = Number(r.custo);
    else {
      const s = custoSemReserva.get(it.pedidoId, it.produtoId);
      if (Number(s.q) > 0) custo = Number(s.custo) * Math.min(1, qtd / Number(s.q));
      else { custo = custoTeorico(db, p, qtd, composicao); estimado = true; }
    }
    acumular(p, it.tipo === 'catalogo' ? 'loja' : 'pedido', qtd, Number(it.valorTotal) || 0, custo, estimado);
  }

  // ── balcão (NFC-e) ────────────────────────────────────────────────────
  let itensNfce = [];
  try {
    itensNfce = db.prepare(`
      SELECT i.nfceId, i.produtoId, i.quantidade, i.valorTotal
        FROM nfce_itens i JOIN nfce n ON n.id = i.nfceId
       WHERE n.statusSefaz = 'autorizada' AND n.pedidoId IS NULL AND i.produtoId IS NOT NULL
         AND date(n.dataEmissao) BETWEEN ? AND ?`).all(inicio, fim);
  } catch { /* tenant sem NFC-e */ }
  const unitNaNota = db.prepare(`
    SELECT COALESCE(SUM(m.quantidade * ${CUSTO_MOV}), 0) custo, COALESCE(SUM(m.quantidade), 0) q
      FROM movimentacoes_estoque m
     WHERE m.tipo = 'saida' AND m.origem = 'nfce' AND m.origemId = ? AND m.produtoId = ?`);
  const unitario = (nfceId, produtoId) => {
    const u = unitNaNota.get(nfceId, produtoId);
    return Number(u.q) > 0 ? { valor: Number(u.custo) / Number(u.q), estimado: false }
      : { valor: custoAtualDe(db, produtoId), estimado: true };
  };
  for (const it of itensNfce) {
    const p = produto.get(it.produtoId);
    if (!p) continue;
    const qtd = Number(it.quantidade) || 0;
    let custo = 0, estimado = false;
    if (p.tipoProduto === 'kit') {
      for (const c of composicao.all(p.id)) {
        const u = unitario(it.nfceId, c.produtoFilhoId);
        custo += u.valor * qtd * Number(c.quantidade);
        estimado = estimado || u.estimado;
      }
    } else {
      const u = unitario(it.nfceId, p.id);
      custo = u.valor * qtd; estimado = u.estimado;
    }
    acumular(p, 'balcao', qtd, Number(it.valorTotal) || 0, custo, estimado);
  }

  const fechar = (o) => ({ ...o, receita: r2(o.receita), custo: r2(o.custo), lucro: r2(o.receita - o.custo),
    margem: o.receita > 0 ? Math.round(((o.receita - o.custo) / o.receita) * 1000) / 10 : null });
  const produtos = [...linhas.values()].map(l => {
    const canais = {};
    for (const [k, c] of Object.entries(l.canais)) canais[k] = fechar(c);
    return { ...fechar(l), canais };
  }).sort((a, b) => b.lucro - a.lucro);
  const tot = produtos.reduce((a, l) => ({ receita: a.receita + l.receita, custo: a.custo + l.custo }), { receita: 0, custo: 0 });
  const canais = {};
  for (const l of produtos) {
    for (const [k, c] of Object.entries(l.canais)) {
      const t = canais[k] || (canais[k] = { receita: 0, custo: 0, quantidade: 0 });
      t.receita += c.receita; t.custo += c.custo; t.quantidade += c.quantidade;
    }
  }
  for (const k of Object.keys(canais)) canais[k] = fechar(canais[k]);
  return { inicio, fim, totais: fechar(tot), canais, produtos,
           estimados: produtos.filter(p => p.estimado).length };
}

/** Custo de hoje para a quantidade vendida; kit pela composição atual. */
function custoTeorico(db, p, qtd, composicao) {
  if (p.tipoProduto !== 'kit') return custoAtualDe(db, p.id) * qtd;
  return composicao.all(p.id).reduce((a, c) => a + custoAtualDe(db, c.produtoFilhoId) * qtd * Number(c.quantidade), 0);
}

module.exports = { relatorioLucro };
