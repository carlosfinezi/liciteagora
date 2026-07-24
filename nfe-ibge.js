/**
 * nfe-ibge.js — Tabelas de apoio para NF-e
 */

// Código IBGE por UF (primeiros 2 dígitos do código do município)
const UF_IBGE = {
  RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17,
  MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29,
  MG: 31, ES: 32, RJ: 33, SP: 35,
  PR: 41, SC: 42, RS: 43,
  MS: 50, MT: 51, GO: 52, DF: 53
};

function codigoUF(uf) {
  return UF_IBGE[(uf || '').toUpperCase()] || null;
}

// Mapeamento tipoFrete do pedido → modFrete SEFAZ (idênticos para NF-e)
function modFrete(tipoFretePedido) {
  if (tipoFretePedido == null || tipoFretePedido === '') return '9';
  const n = String(tipoFretePedido);
  if (['0','1','2','3','4','9'].includes(n)) return n;
  return '9';
}

// Calcula DV (dígito verificador) da chave NF-e — módulo 11
function calcularDV(chave43) {
  const pesos = [2,3,4,5,6,7,8,9];
  let soma = 0;
  for (let i = 0; i < 43; i++) {
    soma += parseInt(chave43[42 - i], 10) * pesos[i % 8];
  }
  const resto = soma % 11;
  const dv = (resto < 2) ? 0 : 11 - resto;
  return String(dv);
}

// Gera cNF aleatório de 8 dígitos (não pode ser igual ao nNF nem múltiplo de 111111111)
function gerarCNF() {
  return String(Math.floor(10000000 + Math.random() * 89999999));
}

module.exports = { UF_IBGE, codigoUF, modFrete, calcularDV, gerarCNF };
