/**
 * Normaliza o meio de pagamento para o código tPag SEFAZ.
 *
 * No banco o valor de meio/forma de pagamento é uma MISTURA: às vezes já é o código
 * tPag ('01','15','17'), às vezes é um literal ('boleto','pix','outros','dinheiro').
 * Este helper unifica para o código tPag SEFAZ, usado tanto no grupo <pag> da NF-e
 * quanto no gatilho de auto-boleto ao faturar.
 *
 * Retorna null se vazio (→ obriga o chamador a tratar "meio ausente"); '99' (Outros)
 * se não-vazio e desconhecido.
 */
const MAPA = {
  dinheiro: '01', especie: '01', 'espécie': '01', cash: '01',
  cheque: '02',
  'cartao de credito': '03', 'cartão de crédito': '03', credito: '03', 'crédito': '03',
  cartao: '03', 'cartão': '03', cartaocredito: '03',
  'cartao de debito': '04', 'cartão de débito': '04', debito: '04', 'débito': '04', cartaodebito: '04',
  boleto: '15', 'boleto bancario': '15', 'boleto bancário': '15',
  deposito: '16', 'depósito': '16',
  pix: '17',
  transferencia: '18', 'transferência': '18', ted: '18', doc: '18',
  'carteira digital': '19',
  outros: '99', outro: '99',
};

function tPagFromForma(forma) {
  const f = String(forma == null ? '' : forma).trim().toLowerCase();
  if (!f) return null;
  if (/^\d{2}$/.test(f)) return f; // já é código tPag
  return MAPA[f] || '99';
}

module.exports = { tPagFromForma };
