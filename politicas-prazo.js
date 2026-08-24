/**
 * politicas-prazo.js — leitura da política de prazo vinculada a uma pessoa.
 *
 * Uma política é a regra de pagamento como cadastro reutilizável: prazo das
 * parcelas, meios de recebimento aceitos, valor mínimo por parcela e as travas
 * de crédito. Antes de 2026-08-21 essa regra vivia em campos soltos de
 * `pessoas` (condicaoPagamentoPadrao, meiosPagamentoPermitidos) — um cliente por
 * vez, sem reaproveitamento.
 *
 * Este módulo é só a resolução. Quem consome não muda: `prazo-pagamento.js` e
 * `meios-pagamento.js` continuam sendo a porta de entrada de pedidos, OS,
 * faturas, PDV e contas a receber — eles é que passam a perguntar aqui primeiro.
 *
 * Fallback para os campos legados da pessoa é proposital: os cadastros que
 * ainda não foram convertidos continuam funcionando, e um tenant cujo banco
 * ainda não tem a tabela (primeiro boot) não derruba faturamento.
 */

/**
 * Vínculo da pessoa com a política: `{ temVinculo, politica }`.
 *
 * `temVinculo` é o que decide se os campos legados da ficha ainda valem. Uma
 * pessoa já convertida tem a política como única fonte — inclusive quando a
 * política não vale para a operação em curso (uma política só de venda tem de
 * calar numa compra, não deixar o campo legado responder no lugar dela).
 * `politica` só vem preenchida se a política estiver ativa.
 *
 * Nunca lança: tenant cujo banco ainda não tem a tabela cai em "sem vínculo",
 * que é o comportamento de antes de existirem políticas.
 */
function vinculoDaPessoa(db, pessoaId) {
  const vazio = { temVinculo: false, politica: null };
  if (!pessoaId) return vazio;
  try {
    const row = db.prepare('SELECT politicaPrazoId FROM pessoas WHERE id = ?').get(Number(pessoaId));
    if (!row || !row.politicaPrazoId) return vazio;
    const pol = db.prepare('SELECT * FROM politicas_prazo WHERE id = ? AND ativo = 1').get(row.politicaPrazoId);
    return { temVinculo: true, politica: pol || null };
  } catch {
    return vazio;   // tabela/coluna ainda não existe neste tenant
  }
}

/** Política ativa da pessoa, ou null. */
function politicaDaPessoa(db, pessoaId) {
  return vinculoDaPessoa(db, pessoaId).politica;
}

/** Mesma coisa pelo CPF/CNPJ — no PDV é só isso que se tem em mãos. */
function politicaPorCpfCnpj(db, cpfCnpj) {
  const digits = String(cpfCnpj || '').replace(/\D/g, '');
  if (!digits) return null;
  try {
    const p = db.prepare('SELECT id FROM pessoas WHERE cpfCnpj = ?').get(digits);
    return p ? politicaDaPessoa(db, p.id) : null;
  } catch {
    return null;
  }
}

/**
 * A política vale para esta operação? Uma política de venda não deve reger a
 * geração de contas a pagar de uma compra, e vice-versa.
 * `onde`: 'vendas' | 'compras' | 'pdv'.
 */
function valePara(politica, onde) {
  if (!politica) return false;
  if (onde === 'compras') return !!politica.aplicaCompras;
  if (onde === 'pdv') return !!politica.aplicaPdv;
  return !!politica.aplicaVendas;
}

module.exports = { vinculoDaPessoa, politicaDaPessoa, politicaPorCpfCnpj, valePara };
