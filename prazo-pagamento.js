/**
 * prazo-pagamento.js — prazo de pagamento padrão do cliente.
 *
 * `pessoas.condicaoPagamentoPadrao` guarda o prazo em dias a partir da emissão:
 * um número ("30") ou uma sequência ("30/60/90"), um item por parcela. A coluna
 * é a mesma de antes — o campo era texto livre decorativo e passou a ser
 * validado e aplicado, então o "30/60/90" já digitado continua valendo.
 *
 * Vazio = sem prazo definido; quem chama cai no default que já usava.
 */

const MAX_PARCELAS = 24;
const MAX_DIAS = 3650;

/**
 * Interpreta o prazo. Devolve array de dias em ordem crescente, ou null quando
 * não há prazo. Lança em formato inválido — o cadastro recusa antes de gravar.
 */
function parsePrazo(texto) {
  const v = String(texto == null ? '' : texto).trim();
  if (!v) return null;
  const partes = v.split(/[/,;+]/).map(p => p.trim()).filter(p => p !== '');
  if (!partes.length) return null;
  if (partes.length > MAX_PARCELAS) {
    throw new Error(`Prazo de pagamento: no máximo ${MAX_PARCELAS} parcelas`);
  }
  const dias = partes.map(p => {
    if (!/^\d{1,4}$/.test(p)) {
      throw new Error(`Prazo de pagamento inválido: "${texto}". Use dias separados por barra (ex.: 30 ou 30/60/90).`);
    }
    const n = Number(p);
    if (n > MAX_DIAS) throw new Error(`Prazo de pagamento: ${n} dias é acima do limite de ${MAX_DIAS}`);
    return n;
  });
  for (let i = 1; i < dias.length; i++) {
    if (dias[i] <= dias[i - 1]) {
      throw new Error(`Prazo de pagamento "${texto}": os dias devem ser crescentes (ex.: 30/60/90).`);
    }
  }
  return dias;
}

/** Forma canônica para gravar ("30/60/90"), ou null. Lança em formato inválido. */
function normalizarPrazo(texto) {
  const dias = parsePrazo(texto);
  return dias ? dias.join('/') : null;
}

/**
 * Prazo do cliente, já interpretado. null = sem prazo (ou texto legado inválido).
 *
 * A política de prazo vinculada manda; sem política, cai no campo legado da
 * pessoa. `onde` ('vendas' | 'compras' | 'pdv') existe porque uma política de
 * venda não deve reger a geração de contas a pagar de uma compra.
 */
function prazoDaPessoa(db, pessoaId, onde = 'vendas') {
  if (!pessoaId) return null;
  const { vinculoDaPessoa, valePara } = require('./politicas-prazo');
  const { temVinculo, politica } = vinculoDaPessoa(db, pessoaId);
  if (temVinculo) {
    // Com política vinculada o campo legado não é consultado: se ela não vale
    // aqui, o cliente não tem prazo definido para esta operação.
    if (!valePara(politica, onde)) return null;
    if (politica.tipo === 'vista') return [0];
    try { return parsePrazo(politica.prazoDias); } catch { return null; }
  }
  const row = db.prepare('SELECT condicaoPagamentoPadrao FROM pessoas WHERE id = ?').get(Number(pessoaId));
  if (!row) return null;
  // Cadastro antigo pode ter texto que não é prazo ("À vista", "Boleto 30d").
  // Ignorar é melhor do que derrubar um faturamento por causa disso.
  try { return parsePrazo(row.condicaoPagamentoPadrao); } catch { return null; }
}

function addDias(iso, n) {
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  d.setDate(d.getDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}

/** Vencimentos do prazo a partir de uma data de emissão. */
function vencimentosDoPrazo(dataEmissao, dias) {
  return (dias || []).map(d => addDias(dataEmissao, d));
}

/** Divide um total em n parcelas; a última absorve a diferença de centavos. */
function dividirValor(total, n) {
  const base = Math.floor((Number(total) * 100) / n) / 100;
  const valores = [];
  let acumulado = 0;
  for (let i = 0; i < n; i++) {
    const v = (i === n - 1) ? Number((Number(total) - acumulado).toFixed(2)) : base;
    acumulado = Number((acumulado + v).toFixed(2));
    valores.push(v);
  }
  return valores;
}

module.exports = {
  MAX_PARCELAS, MAX_DIAS,
  parsePrazo, normalizarPrazo, prazoDaPessoa,
  vencimentosDoPrazo, dividirValor, addDias,
};
