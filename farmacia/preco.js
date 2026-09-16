/**
 * preco.js — Teto de venda do medicamento (PMC da CMED).
 *
 * O PMC não é sugestão: é o preço máximo que a farmácia pode cobrar do
 * consumidor, e vale por UF (a coluna da lista muda com a alíquota de ICMS do
 * estado). Vender acima é infração sanitária e de relação de consumo.
 *
 * Duas ressalvas que mudam o resultado e por isso estão no código:
 *
 *   1. Só vale para medicamento de REGIME REGULADO. A própria CMED marca ~10%
 *      da lista como "Liberado" — nesses, o PF é livre e não há teto de PMC a
 *      cobrar aqui.
 *   2. Medicamento sem PMC na coluna da UF (são milhares na lista, quase todos
 *      de restrição hospitalar) não tem teto a comparar. Bloquear seria
 *      inventar uma regra que não existe.
 */

// Centavo de tolerância: arredondamento de tela não pode virar bloqueio.
const TOLERANCIA = 0.005;

/**
 * Confere os itens contra o PMC. Devolve { avisos, erros }.
 * Com `travar` falso, tudo vira aviso — a tela mostra, mas não impede.
 */
function conferirPmc(db, itens, { travar = true } = {}) {
  const erros = [];
  const avisos = [];

  for (const it of itens) {
    if (!it.produtoId) continue;
    const spec = db.prepare('SELECT pmc, regimePreco FROM farmacia_medicamento_specs WHERE produtoId = ?')
      .get(it.produtoId);
    if (!spec || spec.pmc == null) continue;
    if (spec.regimePreco && spec.regimePreco !== 'regulado') continue;

    // O preço a comparar é o EFETIVAMENTE COBRADO, não o unitário digitado.
    // A emissão monta o vProd do XML a partir de `valorTotal` quando ele vem
    // preenchido (nfce-routes), sem exigir que bata com quantidade ×
    // precoUnitario. Olhar só o unitário deixava passar item com unitário
    // dentro do teto e total inflado — o teto viraria decoração.
    const qtd = Number(it.quantidade);
    const total = Number(it.valorTotal);
    const unitario = Number(it.precoUnitario);
    let preco = unitario;
    if (Number.isFinite(total) && Number.isFinite(qtd) && qtd > 0) {
      preco = total / qtd;
    }
    if (!Number.isFinite(preco)) continue;
    if (preco <= Number(spec.pmc) + TOLERANCIA) continue;

    const p = db.prepare('SELECT descricao FROM produtos WHERE id = ?').get(it.produtoId);
    // Quando o total não bate com o unitário, dizer os dois: o balconista
    // precisa entender por que foi barrado se a tela mostra o unitário certo.
    const divergente = Number.isFinite(total) && Number.isFinite(unitario)
      && Number.isFinite(qtd) && qtd > 0
      && Math.abs(total - unitario * qtd) > 0.01;
    const msg = `${(p && p.descricao) || 'produto ' + it.produtoId}: `
      + `preço ${preco.toFixed(2)} acima do PMC ${Number(spec.pmc).toFixed(2)}`
      + (divergente ? ` (unitário informado ${unitario.toFixed(2)}, mas o total cobrado é ${total.toFixed(2)} para ${qtd})` : '');
    (travar ? erros : avisos).push(msg);
  }

  return { erros, avisos };
}

module.exports = { conferirPmc, TOLERANCIA };
