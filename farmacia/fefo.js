/**
 * fefo.js — Seleção de lote na saída: FEFO (First Expire, First Out).
 *
 * Farmácia não é FIFO: o que sai primeiro é o que vence primeiro, não o que
 * entrou primeiro. Um lote comprado depois, mas com validade mais curta, tem
 * de sair na frente — senão vira perda no vencimento.
 *
 * A base de lote já existia no ERP e é reaproveitada inteira:
 *   - `produtos.rastreiaLote`          (estoque-routes)
 *   - `lotes` com dataFabricacao/dataValidade/saldoAtual
 *   - `movimentacoes_estoque.loteId`
 * O que faltava era a escolha automática e o bloqueio do vencido.
 *
 * Este módulo NÃO grava nada por conta própria: `selecionarLotesFEFO` só
 * calcula. Quem grava é a venda, dentro da mesma transação em que a nota é
 * persistida — nota rejeitada não pode baixar lote.
 */

// Data do balcão em BRT (o servidor roda em UTC).
function hojeBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Lotes elegíveis para saída, já na ordem FEFO.
 *
 * Ordem: validade mais próxima primeiro; lote sem validade por último (não dá
 * para afirmar que vence antes de um que tem data), e o id como desempate para
 * a ordem ser estável.
 */
function lotesDisponiveis(db, produtoId, { permitirVencido = false, hoje = hojeBrasilia() } = {}) {
  let sql = `SELECT id, numero, dataFabricacao, dataValidade, saldoAtual
             FROM lotes
             WHERE produtoId = ? AND ativo = 1 AND saldoAtual > 0`;
  const params = [produtoId];
  if (!permitirVencido) {
    sql += ` AND (dataValidade IS NULL OR date(dataValidade) >= date(?))`;
    params.push(hoje);
  }
  sql += ` ORDER BY CASE WHEN dataValidade IS NULL THEN 1 ELSE 0 END,
                    date(dataValidade) ASC, id ASC`;
  return db.prepare(sql).all(...params);
}

/**
 * Distribui `quantidade` entre os lotes disponíveis, em ordem FEFO.
 *
 * Devolve { alocacoes, faltante }. Não lança: quem chama decide se a falta é
 * erro (venda) ou aviso (simulação de tela).
 */
function selecionarLotesFEFO(db, produtoId, quantidade, opts = {}) {
  const qtd = Number(quantidade);
  if (!Number.isFinite(qtd) || qtd <= 0) {
    return { alocacoes: [], faltante: 0 };
  }
  const lotes = lotesDisponiveis(db, produtoId, opts);
  const alocacoes = [];
  let restante = qtd;
  for (const l of lotes) {
    if (restante <= 0) break;
    const usar = Math.min(restante, Number(l.saldoAtual));
    if (usar <= 0) continue;
    alocacoes.push({
      loteId: l.id,
      numero: l.numero,
      dataFabricacao: l.dataFabricacao,
      dataValidade: l.dataValidade,
      quantidade: usar,
    });
    restante = +(restante - usar).toFixed(6);
  }
  return { alocacoes, faltante: restante > 0 ? restante : 0 };
}

/**
 * Confere um lote escolhido à mão (devolução, recall, lote reservado).
 * Devolve string com o motivo da recusa, ou null quando o lote serve.
 */
function conferirLoteManual(db, produtoId, loteId, quantidade, { bloquearVencido = true, hoje = hojeBrasilia() } = {}) {
  const l = db.prepare('SELECT * FROM lotes WHERE id = ?').get(loteId);
  if (!l) return 'lote não encontrado';
  if (Number(l.produtoId) !== Number(produtoId)) return 'lote pertence a outro produto';
  if (!Number(l.ativo)) return 'lote inativo';
  if (bloquearVencido && l.dataValidade && l.dataValidade < hoje) {
    return `lote ${l.numero} venceu em ${l.dataValidade}`;
  }
  if (Number(l.saldoAtual) < Number(quantidade)) {
    return `lote ${l.numero} tem apenas ${l.saldoAtual} em saldo`;
  }
  return null;
}

/**
 * Resolve os lotes de todos os itens de uma venda.
 *
 * Roda ANTES de a nota ganhar número e de o XML ser montado: o grupo <rastro>
 * precisa do lote, e falta de lote não pode queimar numeração.
 *
 * Item pode trazer `loteId` (escolha manual no balcão) ou nada (FEFO decide).
 * Produto que não rastreia lote passa direto, sem alocação.
 */
function resolverLotesDaVenda(db, itens, { bloquearVencido = true, hoje = hojeBrasilia() } = {}) {
  const out = [];
  for (const it of itens) {
    if (!it.produtoId) { out.push({ produtoId: null, alocacoes: [] }); continue; }

    const p = db.prepare('SELECT id, descricao, rastreiaLote FROM produtos WHERE id = ?').get(it.produtoId);
    if (!p || !Number(p.rastreiaLote)) { out.push({ produtoId: it.produtoId, alocacoes: [] }); continue; }

    if (it.loteId) {
      const erro = conferirLoteManual(db, it.produtoId, it.loteId, it.quantidade, { bloquearVencido, hoje });
      if (erro) throw new Error(`${p.descricao}: ${erro}`);
      const l = db.prepare('SELECT id, numero, dataFabricacao, dataValidade FROM lotes WHERE id = ?').get(it.loteId);
      out.push({
        produtoId: it.produtoId,
        alocacoes: [{
          loteId: l.id, numero: l.numero, dataFabricacao: l.dataFabricacao,
          dataValidade: l.dataValidade, quantidade: Number(it.quantidade),
        }],
      });
      continue;
    }

    const { alocacoes, faltante } = selecionarLotesFEFO(db, it.produtoId, it.quantidade,
      { permitirVencido: !bloquearVencido, hoje });
    if (faltante > 0) {
      // Mensagem separa os dois casos: não ter estoque é diferente de ter só
      // estoque vencido — a segunda é a que o balcão precisa entender rápido.
      const comVencido = selecionarLotesFEFO(db, it.produtoId, it.quantidade, { permitirVencido: true, hoje });
      const msg = comVencido.faltante === 0
        ? `${p.descricao}: só há saldo em lote vencido — venda bloqueada`
        : `${p.descricao}: faltam ${faltante} em lote com validade boa`;
      throw new Error(msg);
    }
    out.push({ produtoId: it.produtoId, alocacoes });
  }
  return out;
}

/**
 * Baixa o saldo dos lotes alocados. Chamar dentro da transação da venda.
 */
function baixarAlocacoes(db, alocacoes) {
  const upd = db.prepare('UPDATE lotes SET saldoAtual = saldoAtual - ? WHERE id = ?');
  for (const a of alocacoes) upd.run(Number(a.quantidade), a.loteId);
}

module.exports = {
  hojeBrasilia,
  lotesDisponiveis,
  selecionarLotesFEFO,
  conferirLoteManual,
  resolverLotesDaVenda,
  baixarAlocacoes,
};
