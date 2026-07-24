// Reconciliação local de uma fatura cancelada.
//
// Cancela a fatura no sistema, estorna as movimentações financeiras já
// lançadas, cancela as contas a receber, estorna o estoque e reabre o
// pedido (status 'rascunho', faturaId NULL).
//
// Compartilhado entre os dois caminhos de cancelamento para que cancelar a
// nota SEMPRE ajuste a fatura e o pedido:
//   - faturas-routes.js  → POST /api/faturas/:id/cancelar  (fatura completa)
//   - nfe-emit-routes.js → POST /api/faturas/:id/cancelar-nfe (cancelamento fiscal)
//
// `fatura` precisa conter: id, contaReceberId, numero, pedidoId.
function cancelarFaturaLocal(db, fatura, username) {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE faturas SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(fatura.id);

    const crsIds = db.prepare(`SELECT id FROM contas_a_receber WHERE faturaId = ?`).all(fatura.id).map(r => r.id);
    if (fatura.contaReceberId && !crsIds.includes(fatura.contaReceberId)) crsIds.push(fatura.contaReceberId);

    const placeholdersCr = crsIds.length ? crsIds.map(() => '?').join(',') : 'NULL';
    const movs = db.prepare(`
      SELECT * FROM movimentacoes_financeiras
      WHERE (origem = 'fatura_avista' AND origemId = ?)
         OR (origem = 'baixa_cr' AND origemId IN (${placeholdersCr}))
         OR (origem = 'boleto_mp' AND origemId IN (${placeholdersCr}))
    `).all(fatura.id, ...crsIds, ...crsIds);
    const hoje = new Date(Date.now() - 3*60*60*1000).toISOString().slice(0,10);
    for (const m of movs) {
      const tipoInverso = m.tipo === 'entrada' ? 'saida' : m.tipo === 'saida' ? 'entrada' : null;
      if (!tipoInverso) continue;
      db.prepare(`INSERT INTO movimentacoes_financeiras
        (contaId, tipo, valor, data, descricao, origem, origemId, categoria, usuario)
        VALUES (?, ?, ?, ?, ?, 'estorno_fatura', ?, ?, ?)`).run(
        m.contaId, tipoInverso, m.valor, hoje,
        `Estorno cancelamento fatura ${fatura.numero} (mov #${m.id})`,
        fatura.id, m.categoria || null, m.usuario || null
      );
    }

    if (crsIds.length) {
      const upd = db.prepare(`UPDATE contas_a_receber SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP
                              WHERE id = ? AND status != 'cancelada'`);
      for (const crId of crsIds) upd.run(crId);
    }

    const saidas = db.prepare(`SELECT * FROM movimentacoes_estoque WHERE origem = 'pedido' AND origemId = ? AND tipo = 'saida'`).all(fatura.pedidoId);
    for (const s of saidas) {
      db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data)
        VALUES (?, 'entrada', ?, ?, 'estorno_pedido', ?, ?, ?)`).run(
        s.produtoId, s.quantidade, s.custoUnitario || 0, fatura.pedidoId,
        `Estorno cancelamento fatura ${fatura.numero}`, hoje
      );
    }

    db.prepare(`UPDATE pedidos SET status = 'rascunho', faturaId = NULL, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(fatura.pedidoId);
    db.prepare(`INSERT INTO pedido_historico (pedidoId, statusAnterior, statusNovo, acao, motivo, usuario)
      VALUES (?, 'faturado', 'rascunho', 'reabertura_auto', ?, ?)`).run(
      fatura.pedidoId, `Fatura ${fatura.numero} cancelada`, username || null
    );
  });
  tx();
}

module.exports = { cancelarFaturaLocal };
