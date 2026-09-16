/**
 * sngpc-eventos.js — Fila de fatos escrituráveis no SNGPC.
 *
 * O evento nasce no momento do fato (venda, entrada, perda) e só depois é
 * agrupado num XML. Essa separação existe por dois motivos concretos:
 *
 *   1. Transmissão rejeitada não pode perder histórico. Se o XML fosse montado
 *      direto do estoque, uma rejeição obrigaria a recalcular o passado — e o
 *      passado muda (devolução, ajuste de inventário).
 *   2. O dado que a ANVISA quer (prescritor, comprador, paciente, lote) só
 *      existe no instante da dispensação. Depois, não dá para reconstruir.
 *
 * Escriturável = medicamento das listas da Portaria 344/98 ou antimicrobiano
 * da RDC 20/2011. É a mesma regra que decide se a venda exige receita, então
 * ela mora em um lugar só: receita.tiposAceitosPara.
 */

const { tiposAceitosPara } = require('./receita');

function ehEscriturável(db, produtoId) {
  if (!produtoId) return false;
  const spec = db.prepare('SELECT * FROM farmacia_medicamento_specs WHERE produtoId = ?').get(produtoId);
  return !!tiposAceitosPara(spec);
}

/**
 * Enfileira as saídas de uma venda. Chamar na transação da nota, depois de
 * autorizada — nota rejeitada não escritura nada.
 */
function registrarVenda(db, { nfceId, numero, dataEmissao, itens, lotesDaVenda, receitaId }) {
  const ins = db.prepare(`INSERT INTO farmacia_sngpc_eventos
    (tipoMovimento, data, produtoId, loteId, quantidade, receitaId,
     documentoTipo, documentoNumero, origem, origemId, status)
    VALUES ('venda', ?, ?, ?, ?, ?, 'nfce', ?, 'nfce', ?, 'pendente')`);

  let n = 0;
  itens.forEach((it, i) => {
    if (!ehEscriturável(db, it.produtoId)) return;
    const alocacoes = lotesDaVenda?.[i]?.alocacoes || [];
    if (!alocacoes.length) {
      ins.run(dataEmissao, it.produtoId, null, Number(it.quantidade), receitaId || null, String(numero), nfceId);
      n++;
      return;
    }
    // Um evento por lote: a ANVISA escritura por lote, não por item de nota.
    for (const a of alocacoes) {
      ins.run(dataEmissao, it.produtoId, a.loteId, Number(a.quantidade), receitaId || null, String(numero), nfceId);
      n++;
    }
  });
  return n;
}

/**
 * Enfileira uma entrada (compra/transferência recebida).
 */
function registrarEntrada(db, { data, produtoId, loteId, quantidade, notaNumero, cnpjOrigem, origem, origemId }) {
  if (!ehEscriturável(db, produtoId)) return 0;
  db.prepare(`INSERT INTO farmacia_sngpc_eventos
    (tipoMovimento, data, produtoId, loteId, quantidade, documentoTipo, documentoNumero, origem, origemId, status)
    VALUES ('entrada', ?, ?, ?, ?, ?, ?, ?, ?, 'pendente')`)
    .run(data, produtoId, loteId || null, Number(quantidade), cnpjOrigem || null,
      notaNumero != null ? String(notaNumero) : null, origem || 'manual', origemId || null);
  return 1;
}

/**
 * Enfileira uma perda. `motivo` usa o domínio st_TipoMotivoPerda do SNGPC
 * (3 = vencimento, o caso mais comum na farmácia).
 */
function registrarPerda(db, { data, produtoId, loteId, quantidade, motivo = 3, origem, origemId }) {
  if (!ehEscriturável(db, produtoId)) return 0;
  db.prepare(`INSERT INTO farmacia_sngpc_eventos
    (tipoMovimento, data, produtoId, loteId, quantidade, documentoTipo, origem, origemId, status)
    VALUES ('perda', ?, ?, ?, ?, ?, ?, ?, 'pendente')`)
    .run(data, produtoId, loteId || null, Number(quantidade), String(motivo), origem || 'manual', origemId || null);
  return 1;
}

/** Eventos ainda não transmitidos, no período. */
function pendentes(db, { dataInicio, dataFim } = {}) {
  let sql = `SELECT e.*, p.descricao, p.unidade,
                    s.registroAnvisa, s.antimicrobiano, s.listaPortaria344, s.tarja,
                    l.numero AS loteNumero
             FROM farmacia_sngpc_eventos e
             LEFT JOIN produtos p ON p.id = e.produtoId
             LEFT JOIN farmacia_medicamento_specs s ON s.produtoId = e.produtoId
             LEFT JOIN lotes l ON l.id = e.loteId
             WHERE e.status = 'pendente'`;
  const params = [];
  if (dataInicio) { sql += ' AND date(e.data) >= date(?)'; params.push(dataInicio); }
  if (dataFim) { sql += ' AND date(e.data) <= date(?)'; params.push(dataFim); }
  sql += ' ORDER BY e.data ASC, e.id ASC';
  return db.prepare(sql).all(...params);
}

/** Marca os eventos como enviados, amarrando-os à transmissão. */
function marcarTransmitidos(db, ids, transmissaoId) {
  if (!ids.length) return;
  const upd = db.prepare("UPDATE farmacia_sngpc_eventos SET status = 'transmitido', transmissaoId = ? WHERE id = ?");
  for (const id of ids) upd.run(transmissaoId, id);
}

/** Devolve os eventos à fila quando a ANVISA rejeita o arquivo. */
function devolverAFila(db, transmissaoId) {
  db.prepare("UPDATE farmacia_sngpc_eventos SET status = 'pendente', transmissaoId = NULL WHERE transmissaoId = ?")
    .run(transmissaoId);
}

module.exports = {
  ehEscriturável,
  registrarVenda,
  registrarEntrada,
  registrarPerda,
  pendentes,
  marcarTransmitidos,
  devolverAFila,
};
