/**
 * meios-pagamento.js — quais meios de recebimento cada cliente aceita.
 *
 * `pessoas.meiosPagamentoPermitidos` guarda um JSON array de códigos SEFAZ
 * (tPag). Vazio ou NULL = sem restrição (comportamento histórico). Um único
 * código = meio fixado para aquele cliente. Vários = whitelist.
 *
 * O vocabulário não é único no sistema: pedidos, OS e PDV usam o código SEFAZ
 * ('15', '17', ...), enquanto contas a receber usa slug ('boleto', 'pix', ...).
 * `codigosDoMeio` traduz os dois para a mesma base antes de comparar.
 */

const MEIOS = {
  '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de crédito', '04': 'Cartão de débito',
  '05': 'Crédito loja', '10': 'Vale alimentação', '11': 'Vale refeição',
  '12': 'Vale presente', '13': 'Vale combustível', '14': 'Duplicata mercantil',
  '15': 'Boleto bancário', '16': 'Depósito bancário', '17': 'PIX',
  '18': 'Transferência bancária', '19': 'Carteira digital',
  '90': 'Sem pagamento', '99': 'Outros',
};

// Slugs usados nas telas de contas a receber. 'cartao' não distingue crédito de
// débito, então casa com os dois códigos.
const SLUGS = {
  dinheiro: ['01'], cheque: ['02'], cartao: ['03', '04'],
  boleto: ['15'], pix: ['17'], transferencia: ['18'], deposito: ['16'],
};

function rotuloMeio(meio) {
  const cods = codigosDoMeio(meio);
  if (!cods.length) return String(meio || '—');
  return cods.map(c => MEIOS[c] || c).join(' / ');
}

/**
 * Traduz um meio (código SEFAZ ou slug) para a lista de códigos equivalentes.
 * Devolve [] para vazio ou para valor que não pertence a nenhum dos dois
 * vocabulários — nesse caso a validação deixa passar, porque não há como
 * afirmar que o meio é proibido.
 */
function codigosDoMeio(meio) {
  const v = String(meio == null ? '' : meio).trim();
  if (!v) return [];
  if (/^\d{1,2}$/.test(v)) {
    const cod = v.padStart(2, '0');
    return MEIOS[cod] ? [cod] : [];
  }
  const slug = v.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
  return SLUGS[slug] || [];
}

/** Normaliza um JSON array de tPag para lista de códigos; null = sem restrição. */
function normalizarLista(json) {
  if (!json) return null;
  let lista;
  try { lista = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(lista)) return null;
  const cods = lista.map(c => String(c).trim().padStart(2, '0')).filter(c => MEIOS[c]);
  return cods.length ? cods : null;
}

/**
 * Códigos permitidos para a pessoa, ou null quando não há restrição.
 * A política de prazo vinculada manda; sem política, vale o campo legado.
 */
function permitidosDaPessoa(db, pessoaId, onde = 'vendas') {
  if (!pessoaId) return null;
  const { vinculoDaPessoa, valePara } = require('./politicas-prazo');
  const { temVinculo, politica } = vinculoDaPessoa(db, pessoaId);
  if (temVinculo) {
    // Com política vinculada o campo legado não é consultado: se ela não vale
    // aqui, não há restrição de meio para esta operação.
    return valePara(politica, onde) ? normalizarLista(politica.meiosPermitidos) : null;
  }
  const row = db.prepare('SELECT meiosPagamentoPermitidos FROM pessoas WHERE id = ?').get(Number(pessoaId));
  return row ? normalizarLista(row.meiosPagamentoPermitidos) : null;
}

/** Mesma coisa, mas achando a pessoa pelo CPF/CNPJ (usado pelo PDV). */
function permitidosPorCpfCnpj(db, cpfCnpj, onde = 'vendas') {
  const digits = String(cpfCnpj || '').replace(/\D/g, '');
  if (!digits) return null;
  const p = db.prepare('SELECT id FROM pessoas WHERE cpfCnpj = ?').get(digits);
  return p ? permitidosDaPessoa(db, p.id, onde) : null;
}

function meioPermitido(db, pessoaId, meio) {
  const permitidos = permitidosDaPessoa(db, pessoaId);
  if (!permitidos) return true;
  const cods = codigosDoMeio(meio);
  if (!cods.length) return true;
  return cods.some(c => permitidos.includes(c));
}

function mensagemBloqueio(permitidos, meio, prefixo = '') {
  const aceitos = permitidos.map(c => MEIOS[c] || c).join(', ');
  return `${prefixo}${rotuloMeio(meio)} não é aceito por este cliente. Meios permitidos: ${aceitos}.`;
}

function checar(permitidos, meio, prefixo) {
  if (!permitidos) return null;
  const cods = codigosDoMeio(meio);
  if (!cods.length) return null;
  if (cods.some(c => permitidos.includes(c))) return null;
  return mensagemBloqueio(permitidos, meio, prefixo);
}

/** Mensagem de recusa, ou null quando o meio é aceito. Para rotas que respondem 400. */
function erroMeioPermitido(db, pessoaId, meio, prefixo = '', onde = 'vendas') {
  return checar(permitidosDaPessoa(db, pessoaId, onde), meio, prefixo);
}

/** Idem, achando o cliente pelo CPF/CNPJ — no PDV é só isso que se tem. */
function erroMeioPorCpfCnpj(db, cpfCnpj, meio, prefixo = '', onde = 'vendas') {
  return checar(permitidosPorCpfCnpj(db, cpfCnpj, onde), meio, prefixo);
}

/** Lança se o meio não for aceito pelo cliente. `prefixo` contextualiza a mensagem. */
function assertMeioPermitido(db, pessoaId, meio, prefixo = '', onde = 'vendas') {
  const erro = erroMeioPermitido(db, pessoaId, meio, prefixo, onde);
  if (erro) throw new Error(erro);
}

module.exports = {
  MEIOS, SLUGS,
  rotuloMeio, codigosDoMeio,
  permitidosDaPessoa, permitidosPorCpfCnpj,
  meioPermitido, erroMeioPermitido, erroMeioPorCpfCnpj,
  assertMeioPermitido, mensagemBloqueio,
};
