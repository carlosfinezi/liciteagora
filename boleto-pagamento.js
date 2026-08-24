/**
 * boleto-pagamento.js — leitura e validação de boleto A PAGAR.
 *
 * Não confundir com boleto-provedores/*, que EMITE cobrança para o cliente.
 * Aqui é o outro lado: o boleto que a empresa recebe do fornecedor, da
 * concessionária ou pelo DDA, e precisa entrar num lote de pagamento.
 *
 * Dois formatos convivem num mesmo lote de contas a pagar:
 *   - Cobrança (banco): linha de 47 dígitos, código de barras de 44.
 *     Traz banco, moeda, valor e vencimento.
 *   - Arrecadação (concessionária/tributo): linha de 48 dígitos, barras de 44.
 *     É o boleto de energia, água e imposto — e a regra de dígito verificador
 *     é OUTRA (módulo 10 ou 11 conforme o 3º dígito). Tratar os dois como se
 *     fossem iguais rejeita metade dos boletos que a empresa paga.
 */

const so = (v) => String(v || '').replace(/\D/g, '');

// ==================== dígitos verificadores ====================

function modulo10(bloco) {
  let soma = 0, peso = 2;
  for (let i = bloco.length - 1; i >= 0; i--) {
    let p = Number(bloco[i]) * peso;
    if (p > 9) p -= 9;
    soma += p;
    peso = peso === 2 ? 1 : 2;
  }
  const resto = soma % 10;
  return resto === 0 ? 0 : 10 - resto;
}

/** @param {number[]} pesos ciclo de pesos, do dígito mais à direita para a esquerda */
function modulo11(bloco, { pesos = [2, 3, 4, 5, 6, 7, 8, 9], regraBanco = true } = {}) {
  let soma = 0, i = 0;
  for (let p = bloco.length - 1; p >= 0; p--) {
    soma += Number(bloco[p]) * pesos[i % pesos.length];
    i++;
  }
  const resto = soma % 11;
  if (regraBanco) {
    // Código de barras bancário: resto 0, 1 ou 10 => DV 1.
    const dv = 11 - resto;
    return (dv === 0 || dv === 10 || dv === 11) ? 1 : dv;
  }
  const dv = 11 - resto;
  return dv >= 10 ? 0 : dv;
}

// ==================== vencimento ====================

// Fator de vencimento: dias desde 07/10/1997. Em 22/02/2025 a FEBRABAN
// reiniciou o contador (9999 -> 1000), então o mesmo fator pode significar
// duas datas. Sem tratar o reinício, boleto novo é lido com data de 2000.
const BASE_ANTIGA = Date.UTC(1997, 9, 7);
const DIA = 86400000;
const REINICIO = Date.UTC(2025, 1, 22);          // fator 1000 do ciclo novo
const BASE_NOVA = REINICIO - 1000 * DIA;

function fatorParaData(fator, referencia = new Date()) {
  const f = Number(fator);
  if (!Number.isFinite(f) || f <= 0) return null;   // 0000 = sem vencimento
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const antiga = BASE_ANTIGA + f * DIA;
  const nova = BASE_NOVA + f * DIA;
  const ref = Date.UTC(referencia.getUTCFullYear(), referencia.getUTCMonth(), referencia.getUTCDate());

  // Boleto a pagar é documento recente: no máximo alguns anos vencido, no
  // máximo alguns anos à frente. A leitura que cai nessa janela é a certa.
  const plausivel = (ms) => ms >= ref - 1500 * DIA && ms <= ref + 2000 * DIA;
  if (plausivel(nova)) return iso(nova);
  if (plausivel(antiga)) return iso(antiga);
  return iso(nova >= antiga ? nova : antiga);
}

// ==================== cobrança (47 dígitos) ====================

/** Linha digitável de cobrança -> código de barras (44). */
function linhaCobrancaParaBarras(linha) {
  const d = so(linha);
  if (d.length !== 47) return null;
  const campo1 = d.slice(0, 9);    // sem o DV (posição 9)
  const campo2 = d.slice(10, 20);
  const campo3 = d.slice(21, 31);
  const dvGeral = d[32];
  const campo5 = d.slice(33);      // fator (4) + valor (10)
  return campo1.slice(0, 4) + dvGeral + campo5
    + campo1.slice(4) + campo2 + campo3;
}

function validarCobranca(linha) {
  const d = so(linha);
  const erros = [];
  if (d.length !== 47) return { valido: false, erros: [`Linha de cobrança tem 47 dígitos, veio ${d.length}`] };

  // DV de cada um dos três campos (módulo 10).
  const campos = [[d.slice(0, 9), d[9]], [d.slice(10, 20), d[20]], [d.slice(21, 31), d[31]]];
  campos.forEach(([bloco, dv], i) => {
    const esperado = modulo10(bloco);
    if (Number(dv) !== esperado) erros.push(`Dígito do campo ${i + 1} não confere (esperado ${esperado}, veio ${dv})`);
  });

  const barras = linhaCobrancaParaBarras(d);
  const semDv = barras.slice(0, 4) + barras.slice(5);
  const dvEsperado = modulo11(semDv);
  if (Number(barras[4]) !== dvEsperado) {
    erros.push(`Dígito verificador geral não confere (esperado ${dvEsperado}, veio ${barras[4]})`);
  }
  return { valido: !erros.length, erros, barras };
}

// ==================== arrecadação (48 dígitos) ====================

/**
 * Concessionária/tributo. O 3º dígito diz como o valor é representado e qual
 * módulo valida: 6 e 7 usam módulo 10, 8 e 9 usam módulo 11.
 */
function validarArrecadacao(linha) {
  const d = so(linha);
  const erros = [];
  if (d.length !== 48) return { valido: false, erros: [`Linha de arrecadação tem 48 dígitos, veio ${d.length}`] };
  if (d[0] !== '8') erros.push('Linha de arrecadação começa com 8');

  const idValor = d[2];
  const mod = ['6', '7'].includes(idValor) ? 10 : 11;
  // A linha é dividida em 4 blocos de 12: 11 dígitos + DV.
  for (let i = 0; i < 4; i++) {
    const bloco = d.slice(i * 12, i * 12 + 11);
    const dv = d[i * 12 + 11];
    const esperado = mod === 10 ? modulo10(bloco) : modulo11(bloco, { regraBanco: false });
    if (Number(dv) !== esperado) erros.push(`Dígito do bloco ${i + 1} não confere (esperado ${esperado}, veio ${dv})`);
  }

  // Barras = os 44 dígitos, tirando o DV de cada bloco.
  const barras = [0, 1, 2, 3].map(i => d.slice(i * 12, i * 12 + 11)).join('');
  const semDv = barras.slice(0, 3) + barras.slice(4);
  const dvEsperado = mod === 10 ? modulo10(semDv) : modulo11(semDv, { regraBanco: false });
  if (Number(barras[3]) !== dvEsperado) {
    erros.push(`Dígito verificador geral não confere (esperado ${dvEsperado}, veio ${barras[3]})`);
  }
  return { valido: !erros.length, erros, barras, modulo: mod };
}

// ==================== leitura ====================

/**
 * Lê linha digitável ou código de barras e devolve o que dá para pagar.
 * Sempre informa `valido` e os erros — um dígito trocado na digitação vira
 * pagamento para o boleto errado, e isso não se desfaz.
 */
function lerBoleto(entrada, { referencia = new Date() } = {}) {
  const d = so(entrada);
  if (!d) return { valido: false, erros: ['Informe a linha digitável ou o código de barras'] };

  if (d.length === 48 || (d.length === 44 && d[0] === '8')) {
    const linha = d.length === 48 ? d : null;
    const v = linha ? validarArrecadacao(linha) : { valido: true, erros: [], barras: d };
    const barras = v.barras || d;
    const idValor = barras[2];
    // Nos identificadores 6 e 8 o valor é efetivo; em 7 e 9 é referência (sem
    // valor). Tratar referência como valor gera pagamento com valor errado.
    const temValor = ['6', '8'].includes(idValor);
    const valor = temValor ? Number(barras.slice(4, 15)) / 100 : null;
    return {
      valido: v.valido, erros: v.erros, tipo: 'arrecadacao',
      codigoBarras: barras, linhaDigitavel: linha,
      valor, valorEmAberto: !temValor,
      vencimento: null,   // arrecadação não traz vencimento no código
      segmento: barras[1],
    };
  }

  if (d.length === 47 || d.length === 44) {
    const linha = d.length === 47 ? d : null;
    const v = linha ? validarCobranca(linha) : { valido: true, erros: [], barras: d };
    const barras = v.barras || d;
    const fator = barras.slice(5, 9);
    const valor = Number(barras.slice(9, 19)) / 100;
    return {
      valido: v.valido, erros: v.erros, tipo: 'cobranca',
      codigoBarras: barras, linhaDigitavel: linha,
      banco: barras.slice(0, 3), moeda: barras[3],
      valor: valor > 0 ? valor : null,
      valorEmAberto: !(valor > 0),
      vencimento: fatorParaData(fator, referencia),
      fatorVencimento: Number(fator),
    };
  }

  return { valido: false, erros: [`Tamanho inválido: ${d.length} dígitos (esperado 44, 47 ou 48)`] };
}

// Bancos mais comuns em boleto de fornecedor — só para a tela mostrar algo
// reconhecível em vez de um número.
const BANCOS = {
  '001': 'Banco do Brasil', '033': 'Santander', '041': 'Banrisul', '070': 'BRB',
  '077': 'Inter', '104': 'Caixa', '136': 'Unicred', '208': 'BTG', '212': 'Original',
  '237': 'Bradesco', '260': 'Nubank', '318': 'BMG', '336': 'C6', '341': 'Itaú',
  '380': 'PicPay', '422': 'Safra', '655': 'Votorantim', '748': 'Sicredi', '756': 'Sicoob',
};
const nomeBanco = (c) => BANCOS[c] || null;

module.exports = {
  so, modulo10, modulo11, fatorParaData,
  linhaCobrancaParaBarras, validarCobranca, validarArrecadacao,
  lerBoleto, nomeBanco, BANCOS,
};
