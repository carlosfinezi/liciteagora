/**
 * pessoa-sem-documento.js — identificação de cliente sem CPF/CNPJ.
 *
 * Criado na Fase 1 (2026-09-11) como módulo preparado, e hoje já em uso em
 * dois pontos: `documentoFiscalDe` no nfe-emit-routes.js e
 * `exigirDocumentoFiscal` no boleto-orchestrator.js. A geração do
 * identificador e a marcação de `semDocumento` é que seguem sem rota que as
 * acione — nada cria um cadastro sem documento ainda.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 *
 * O catálogo público precisa vender para quem não quer informar documento, e a
 * regra "todo pedido tem cliente cadastrado" continua valendo. Mas
 * `pessoas.cpfCnpj` é NOT NULL com índice UNIQUE, e torná-la nullable **não é
 * operação aditiva**: o SQLite não tem `ALTER COLUMN`, e remover o NOT NULL
 * exige recriar `pessoas` — tabela referenciada por 32 outras (auditado no
 * relatório 13).
 *
 * A saída: a coluna continua NOT NULL, recebendo um identificador INTERNO, e
 * `pessoas.semDocumento = 1` marca o estado de forma explícita e consultável.
 *
 * Não é padrão novo. O ERP já grava chaves não-fiscais nessa coluna hoje —
 * 'EX-NICSRS', 'EX-CONTABO', 'TARIFA-asaas' em produção, e o 'UASG-<código>' de
 * `resolverClienteDeParticipacao` quando a licitação não traz CNPJ. O que
 * faltava era a explicitude: sem a coluna, saber se um cadastro tem documento
 * exigia adivinhar pelo prefixo.
 *
 * ── O identificador ─────────────────────────────────────────────────────────
 *
 *   SD-<32 hex>        ex.: SD-9f2c4e1a7b8d4c3e9a1b2c3d4e5f6071
 *
 * Três propriedades, todas necessárias:
 *
 *   1. **Obviamente não fiscal.** CPF tem 11 dígitos e CNPJ 14, ambos só
 *      dígitos. Qualquer coisa com letra é rejeitada por qualquer validador —
 *      inclusive os do próprio ERP.
 *   2. **Colisão desprezível.** `crypto.randomUUID()` (128 bits), não
 *      `Math.random()`. O UNIQUE do banco é a rede de segurança, não a
 *      estratégia.
 *   3. **Nunca é documento fiscal.** `documentoFiscalDe()` devolve `null` para
 *      esses cadastros — e é essa função que a emissão deve consultar, jamais
 *      `pessoa.cpfCnpj` cru.
 */

const crypto = require('crypto');

const PREFIXO = 'SD-';

// Comprimentos que, depois de `replace(/\D/g,'')`, seriam lidos como documento.
const COMPRIMENTOS_DE_DOCUMENTO = new Set([11, 14]);

/**
 * Identificador interno novo, para cadastro sem documento.
 *
 * ⚠️ A regeneração abaixo **não é paranoia** — é correção de um defeito medido.
 *
 * Os emissores fiscais limpam o documento com `(cpfCnpj || '').replace(/\D/g,'')`
 * (`nfe-emit-routes.js:521`, `nfse-routes.js:332`, `nfce-routes.js:294`). Aplicado
 * a `SD-<uuid hex>`, isso apaga o prefixo e as letras a–f, e **sobram só os
 * dígitos do UUID**. Se sobrarem exatamente 11 ou 14, a NF-e monta
 * `destTag.CPF`/`destTag.CNPJ` com um número inventado.
 *
 * Medido em 200.000 gerações (2026-09-11): **1,14% caíam nesse caso** — 0,06%
 * com 11 dígitos e 1,08% com 14. Um em cada 88 cadastros sem documento
 * carregaria um CNPJ falso para dentro de uma nota fiscal.
 *
 * Regerar enquanto o resultado limpo tiver comprimento de documento custa ~1%
 * de tentativas e fecha o buraco na origem — em vez de depender de todo emissor
 * lembrar de checar. Isso NÃO substitui `documentoFiscalDe()`: é a segunda
 * camada, para o caso de algum caminho ler `cpfCnpj` cru.
 */
function gerarIdentificadorSemDocumento() {
  for (let tentativa = 0; tentativa < 20; tentativa++) {
    const id = PREFIXO + crypto.randomUUID().replace(/-/g, '');
    if (!COMPRIMENTOS_DE_DOCUMENTO.has(id.replace(/\D/g, '').length)) return id;
  }
  // 20 falhas seguidas têm probabilidade ~1e-38. Se acontecer, é bug, não azar.
  throw new Error('pessoa-sem-documento: não foi possível gerar identificador seguro');
}

/** O valor gravado em `cpfCnpj` é identificador interno (e não documento)? */
function ehIdentificadorInterno(cpfCnpj) {
  return typeof cpfCnpj === 'string' && cpfCnpj.startsWith(PREFIXO);
}

/**
 * O documento fiscal desta pessoa — ou `null` quando ela não tem.
 *
 * É a ÚNICA porta que a emissão fiscal deve usar. Ler `pessoa.cpfCnpj` direto
 * mandaria `SD-…` para dentro de uma NF-e, que é exatamente o que não pode
 * acontecer.
 *
 * Devolve null em dois casos, e os dois de propósito:
 *   - `semDocumento = 1` — o estado declarado;
 *   - `cpfCnpj` com o prefixo interno — cinto e suspensório, para o caso de a
 *     coluna não ter sido preenchida (tenant sem a migration da Fase 1).
 */
function documentoFiscalDe(pessoa) {
  if (!pessoa) return null;
  if (Number(pessoa.semDocumento) === 1) return null;
  if (ehIdentificadorInterno(pessoa.cpfCnpj)) return null;
  const bruto = String(pessoa.cpfCnpj || '');
  // Qualquer LETRA desqualifica o valor como documento, independente de quantos
  // dígitos sobrem depois. É o que protege os identificadores legados que o ERP
  // já grava nesta coluna há tempos — 'UASG-<código>' (de
  // `resolverClienteDeParticipacao`), 'EX-NICSRS', 'EX-CONTABO',
  // 'TARIFA-asaas'. Sem esta linha, um 'UASG-12345678901' viraria CPF ao passar
  // pelo `replace(/\D/g,'')` dos emissores (relatório 15 §B4).
  if (/[a-zA-Z]/.test(bruto)) return null;
  const doc = bruto.replace(/\D/g, '');
  return doc.length === 11 || doc.length === 14 ? doc : null;
}

/**
 * Porta única para quem PRECISA do documento e não pode seguir sem ele.
 *
 * Devolve `{ documento }` ou `{ erro }` com mensagem para o usuário final — em
 * vez de cada emissor inventar a própria frase e o próprio critério.
 *
 * @param {object} pessoa   linha de `pessoas`
 * @param {string} paraQue  o que se ia emitir, para a mensagem ficar concreta
 */
function exigirDocumentoFiscal(pessoa, paraQue = 'este documento') {
  const doc = documentoFiscalDe(pessoa);
  if (doc) return { documento: doc };
  const nome = (pessoa && pessoa.razaoSocial) ? ` (${pessoa.razaoSocial})` : '';
  return { erro: `Este cliente${nome} foi cadastrado sem CPF/CNPJ. `
    + `Informe um documento válido no cadastro antes de emitir ${paraQue}.` };
}

/** Rótulo para tela — nunca mostra o identificador interno como documento. */
function rotuloDocumento(pessoa) {
  return documentoFiscalDe(pessoa) ? String(pessoa.cpfCnpj) : 'sem documento';
}

/* ===================== os dígitos verificadores =====================
   Até 30/09/2026 nada no sistema conferia isto, e `cpfCnpj` é a chave única de
   `pessoas`: um "1" entrava como PF. Medido nos 20 tenants naquele dia, das
   28.096 linhas gravadas, 8 tinham dígito errado — pouco, e é justamente por
   ser pouco que dá para passar a recusar sem período de transição.

   Quem valida é `erroDeDocumento`, e a regra de fora dela é a mesma do
   `documentoFiscalDe` logo acima: LETRA no valor significa identificador
   interno, não documento. É o que deixa passar o `SD-` dos leads, o `EX-` de
   fornecedor de fora, o `TARIFA-` e o `UASG-<código>`.
   ==================================================================== */

function cpfValido(d) {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const [ate, pos] of [[9, 10], [10, 11]]) {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (pos - i);
    if ((soma * 10) % 11 % 10 !== Number(d[ate])) return false;
  }
  return true;
}

function cnpjValido(d) {
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const conta = (ate) => {
    const pesos = ate === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * pesos[i];
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return conta(12) === Number(d[12]) && conta(13) === Number(d[13]);
}

/**
 * O que há de errado com este valor de `cpfCnpj`, ou `null` se pode gravar.
 *
 * @param {string} valor      o que veio do formulário
 * @param {object} [opcoes]
 * @param {'cpf'|'cnpj'|'qualquer'} [opcoes.exige] recusa o outro tipo quando o
 *        campo é de um só (o destinatário de NFС-e é sempre CPF, por exemplo)
 * @returns {string|null} mensagem pronta para o usuário, ou null
 */
function erroDeDocumento(valor, { exige = 'qualquer' } = {}) {
  const bruto = String(valor == null ? '' : valor).trim();
  if (!bruto) return 'Informe o CPF ou o CNPJ.';
  // Identificador interno do próprio sistema: não é documento e não se valida.
  if (/[a-zA-Z]/.test(bruto)) return null;

  const d = bruto.replace(/\D/g, '');
  if (exige === 'cpf') {
    if (d.length !== 11) return 'O CPF tem 11 números.';
    return cpfValido(d) ? null : 'CPF inválido. Confira os números.';
  }
  if (exige === 'cnpj') {
    if (d.length !== 14) return 'O CNPJ tem 14 números.';
    return cnpjValido(d) ? null : 'CNPJ inválido. Confira os números.';
  }
  if (d.length !== 11 && d.length !== 14) {
    return 'O CPF tem 11 números e o CNPJ tem 14.';
  }
  if (d.length === 11) return cpfValido(d) ? null : 'CPF inválido. Confira os números.';
  return cnpjValido(d) ? null : 'CNPJ inválido. Confira os números.';
}

module.exports = {
  PREFIXO,
  gerarIdentificadorSemDocumento,
  ehIdentificadorInterno,
  documentoFiscalDe,
  exigirDocumentoFiscal,
  rotuloDocumento,
  cpfValido,
  cnpjValido,
  erroDeDocumento,
};
