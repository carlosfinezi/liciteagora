/**
 * Ordem alfabética em português dentro do SQL.
 *
 * O ORDER BY do SQLite compara byte a byte: "Água" e "Óleo" vão para depois
 * do "Z", porque "Á" e "Ó" ficam acima de "z" na tabela. Esta expressão
 * compara o nome sem acento e em minúsculas, e é SQL puro de propósito: uma
 * função registrada na conexão (db.function) falharia com "no such function"
 * em quem abre o banco por fora, como as suítes de teste e os scripts.
 *
 *   const { ordemPt } = require('./ordem-pt');
 *   sql += ` ORDER BY ${ordemPt('p.descricao')}, p.descricao`;
 *
 * O segundo critério, o nome original, desempata "Pão" e "Pao" sempre na
 * mesma ordem.
 */
const TROCAS = [['áàâãä', 'a'], ['éèêë', 'e'], ['íìîï', 'i'], ['óòôõö', 'o'], ['úùûü', 'u'], ['ç', 'c'], ['ñ', 'n']];

function ordemPt(coluna) {
  let e = coluna;
  for (const [letras, base] of TROCAS) {
    for (const l of letras) {
      e = `replace(${e}, '${l}', '${base}')`;
      e = `replace(${e}, '${l.toUpperCase()}', '${base}')`;
    }
  }
  // lower() do SQLite só conhece ASCII; os acentos já saíram acima.
  return `lower(${e})`;
}

module.exports = { ordemPt };
