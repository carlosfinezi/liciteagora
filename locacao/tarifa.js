/**
 * tarifa.js — precificação de locação por faixa de tempo.
 *
 * Funções puras: recebem tarifas já lidas do banco e devolvem números. Sem
 * `db` escondido, para o cálculo poder ser testado isolado — é a parte do
 * módulo que o cliente confere na calculadora dele.
 *
 * ─── A regra que define o negócio ───────────────────────────────────────────
 * O preço de um período é a COMBINAÇÃO MAIS BARATA das faixas cadastradas,
 * não a multiplicação da diária. Com diária 100 e semana 500, 6 dias custam
 * 500 — porque o cliente que sabe fazer conta alugaria 7 dias e devolveria
 * antes. Cobrar 600 é perder o cliente ou perder a discussão.
 *
 * Isso é resolvido por programação dinâmica sobre a duração (custo mínimo de
 * cobrir N horas com as faixas disponíveis), e não por decomposição gulosa —
 * a gulosa erra justamente nos casos de borda que geram reclamação.
 *
 * ─── Arredondamento ─────────────────────────────────────────────────────────
 * Hora iniciada é hora cheia: 2h10 de uso são 3 horas faturáveis. Depois disso,
 * o piso da locação é `minimoFaturavel` da MENOR faixa ativa — uma locadora que
 * só cadastra diária cobra 1 diária mesmo para 20 minutos de uso.
 */

const HORAS_POR_FAIXA = {
  hora: 1,
  dia: 24,
  semana: 168,     // 7 dias
  quinzena: 360,   // 15 dias
  mes: 720,        // 30 dias
};

const FAIXAS_VALIDAS = Object.keys(HORAS_POR_FAIXA);

const TIPOS_EXTRA = [
  'hora_extra', 'km_extra', 'entrega', 'retirada', 'limpeza', 'reposicao',
];

/**
 * Normaliza para 'YYYY-MM-DD HH:MM:SS' — o formato do CURRENT_TIMESTAMP do
 * SQLite. A comparação de sobreposição de janelas é lexicográfica, então
 * formato misto ('2026-09-01' vs '2026-09-01T08:00') faria a disponibilidade
 * responder errado sem nenhum erro visível.
 *
 * Aceita Date, 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM[:SS]' e 'YYYY-MM-DD HH:MM[:SS]'.
 * Data sem hora vira 00:00:00.
 */
function normalizarInstante(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} `
         + `${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  const s = String(v).trim().replace('T', ' ');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} 00:00:00`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`;
  return null;
}

/** Instante normalizado -> epoch ms. Trata a string como hora local. */
function paraMs(instante) {
  const s = normalizarInstante(instante);
  if (!s) return NaN;
  const [d, h] = s.split(' ');
  const [ano, mes, dia] = d.split('-').map(Number);
  const [hh, mm, ss] = h.split(':').map(Number);
  return new Date(ano, mes - 1, dia, hh, mm, ss).getTime();
}

/** Soma horas a um instante e devolve normalizado. Usado pelo turnaround. */
function somarHoras(instante, horas) {
  const ms = paraMs(instante);
  if (Number.isNaN(ms)) return null;
  return normalizarInstante(new Date(ms + horas * 3600 * 1000));
}

/**
 * Duração em horas entre dois instantes, com hora iniciada contando cheia.
 * Devolve 0 quando fim <= inicio (o chamador decide se isso é erro).
 */
function duracaoHoras(inicio, fim) {
  const a = paraMs(inicio), b = paraMs(fim);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  const horas = (b - a) / 3600000;
  if (horas <= 0) return 0;
  // Tolerância de 1 segundo: evita que 24h exatas virem 25 por erro de ponto
  // flutuante em datas com fuso/DST.
  return Math.ceil(horas - 1e-9);
}

// Teto da DP em horas (5 anos). Acima disso o excedente é coberto por
// múltiplos da faixa de melhor custo/hora e só o resto entra na DP.
const HORAS_MAX_DP = 5 * 365 * 24;

/**
 * Custo mínimo de cobrir `horas` com as faixas dadas.
 *
 * DP clássica de troco, com uma diferença que importa: a última faixa pode
 * sobrar. Cobrir 1 hora com uma tarifa de mês custa o mês inteiro — e ainda
 * assim pode ser o mais barato se não houver diária cadastrada.
 *
 * O passo é SEMPRE de 1 hora. Já foi de 1 dia acima de 60 dias, "porque o
 * resultado não muda em locações longas" — e mudava: com passo de 24h,
 * `Math.round(1/24)` mapeava a faixa `hora` para um passo inteiro, e a tarifa
 * horária passava a cobrir um dia pelo preço de uma hora. Com diária 100,
 * semana 500, mês 1500 e hora 15, 61 dias custavam R$ 915 contra R$ 3.000 dos
 * 60 dias — alugar por mais tempo ficava mais barato. A DP de 1h para um ano
 * são ~44 mil operações: não é caro o bastante para justificar a aproximação.
 */
function custoMinimo(horas, faixas) {
  if (horas <= 0 || !faixas.length) return { valor: 0, composicao: [] };

  const contagem = new Map();
  let valorBase = 0;
  let restanteHoras = horas;

  // Períodos absurdos (> 5 anos): cobre o excedente com a faixa de melhor
  // custo por hora e deixa só o resto para a DP. É aproximação, e por isso
  // fica restrita a um caso que não existe na prática.
  if (restanteHoras > HORAS_MAX_DP) {
    const melhor = faixas.reduce((a, b) => (a.valor / a.horas <= b.valor / b.horas ? a : b));
    const excedente = restanteHoras - HORAS_MAX_DP;
    const n = Math.floor(excedente / melhor.horas);
    if (n > 0) {
      // Chave é o OBJETO da faixa, igual à reconstrução da DP abaixo.
      contagem.set(melhor, n);
      valorBase = melhor.valor * n;
      restanteHoras -= n * melhor.horas;
    }
  }

  const n = Math.ceil(restanteHoras);

  // custo[i] = menor valor para cobrir i horas; de[i] = faixa usada por último
  const custo = new Array(n + 1).fill(Infinity);
  const de = new Array(n + 1).fill(null);
  custo[0] = 0;

  for (let i = 1; i <= n; i++) {
    for (const f of faixas) {
      // Sobra permitida: cobrir 3 horas com uma faixa de 168h é legítimo.
      const restante = Math.max(0, i - f.horas);
      if (custo[restante] + f.valor < custo[i]) {
        custo[i] = custo[restante] + f.valor;
        de[i] = f;
      }
    }
  }

  // Reconstrói a composição contando pelo OBJETO de faixa que a DP escolheu,
  // não pelo nome. Se o chamador passar duas linhas da mesma faixa com preços
  // diferentes (o banco tem UNIQUE, mas esta função é pura e documentada como
  // tal), agrupar por nome faria a composição usar o preço errado e somar
  // diferente do total cobrado.
  let i = n;
  let guarda = 0;
  while (i > 0 && de[i] && guarda++ < n + 5) {
    const f = de[i];
    contagem.set(f, (contagem.get(f) || 0) + 1);
    i = Math.max(0, i - f.horas);
  }

  const composicao = [];
  for (const [f, q] of contagem) {
    if (!q) continue;
    composicao.push({
      faixa: f.faixa,
      quantidade: q,
      valorUnitario: arredondar(f.valor),
      valorTotal: arredondar(f.valor * q),
    });
  }
  // Maior faixa primeiro: é como o documento lê melhor.
  composicao.sort((a, b) => HORAS_POR_FAIXA[b.faixa] - HORAS_POR_FAIXA[a.faixa]);

  return { valor: arredondar(valorBase + custo[n]), composicao };
}

function arredondar(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

/**
 * Diárias contadas por HORA DE CORTE.
 *
 * Regra do contrato de referência (cláusula 1): "a contagem tem início na
 * retirada do equipamento e finalização às 17:30 do mesmo dia". Ou seja, a
 * diária não dura 24h a partir da retirada — ela morre no horário de corte,
 * e o que passar disso já é a diária seguinte.
 *
 *   retirou 09:00, devolveu 17:00  → 1 diária (não cruzou o corte)
 *   retirou 09:00, devolveu 18:00  → 2 diárias (cruzou o corte das 17:30)
 *   retirou 09:00, devolveu 17:00 do dia seguinte → 2 diárias
 *
 * Conta quantos instantes de corte existem DENTRO do intervalo, e soma 1 —
 * porque a primeira diária começa a valer na retirada.
 */
function diariasPorCorte(inicio, fim, horaCorte) {
  const ini = paraMs(inicio);
  const f = paraMs(fim);
  if (Number.isNaN(ini) || Number.isNaN(f) || f <= ini) return 0;

  const m = String(horaCorte || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  const [hh, mm] = [Number(m[1]), Number(m[2])];
  if (hh > 23 || mm > 59) return 0;

  // Primeiro corte estritamente depois do início.
  const d = new Date(ini);
  let corte = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0).getTime();
  if (corte <= ini) corte += 86400000;

  let cruzados = 0;
  // Teto de segurança: 20 anos de diárias. Sem ele, uma data absurda
  // (digitação errada em contrato aberto) travaria o processo no laço.
  let guarda = 0;
  while (corte < f && guarda++ < 7500) {
    cruzados++;
    corte += 86400000;
  }
  return 1 + cruzados;
}

/**
 * Preço de uma locação.
 *
 * @param tarifas  linhas de locacao_tarifas do produto ({faixa, valor, minimoFaturavel, ativo})
 * @param inicio   instante de saída
 * @param fim      instante de retorno previsto
 * @param opts     { quantidade, horaCorte }
 * @returns { ok, erro?, horas, horasFaturaveis, dias, valorUnitario, valorTotal,
 *            composicao, faixaPrincipal, diarias? }
 *
 * NÃO aplica valor mínimo: o piso é do CONTRATO inteiro, não do item, e por
 * isso vive em contrato.recalcularTotais. Aplicar aqui multiplicaria o
 * mínimo pela quantidade — 12 andaimes com piso de R$ 80 virariam R$ 960.
 */
function calcularTarifa(tarifas, inicio, fim, opts = {}) {
  const quantidade = Number(opts.quantidade) > 0 ? Number(opts.quantidade) : 1;

  const ativas = (tarifas || [])
    .filter(t => t && t.ativo !== 0 && Number(t.valor) > 0 && HORAS_POR_FAIXA[t.faixa])
    .map(t => ({
      faixa: t.faixa,
      valor: Number(t.valor),
      horas: HORAS_POR_FAIXA[t.faixa],
      minimoFaturavel: Number(t.minimoFaturavel) > 0 ? Number(t.minimoFaturavel) : 1,
    }));

  if (!ativas.length) {
    return { ok: false, erro: 'produto sem tarifa cadastrada', valorTotal: 0, composicao: [] };
  }

  const horas = duracaoHoras(inicio, fim);
  if (Number.isNaN(horas)) {
    return { ok: false, erro: 'período inválido', valorTotal: 0, composicao: [] };
  }
  if (horas <= 0) {
    return { ok: false, erro: 'retorno deve ser depois da saída', valorTotal: 0, composicao: [] };
  }

  // Piso: minimoFaturavel da menor faixa ativa.
  const menor = ativas.reduce((a, b) => (a.horas <= b.horas ? a : b));
  const horasMinimas = menor.horas * menor.minimoFaturavel;
  let horasFaturaveis = Math.max(horas, horasMinimas);

  // Hora de corte: converte a duração em diárias inteiras e devolve à DP como
  // horas equivalentes, para a progressividade (semana/mês) continuar valendo.
  //
  // Só se aplica quando NÃO há tarifa por hora: se a locadora cobra por hora,
  // o corte da diária não faz sentido — a unidade de cobrança já é menor que
  // o dia.
  const temTarifaHora = ativas.some(t => t.faixa === 'hora');
  let diarias = null;
  if (opts.horaCorte && !temTarifaHora) {
    diarias = diariasPorCorte(inicio, fim, opts.horaCorte);
    if (diarias > 0) horasFaturaveis = Math.max(diarias * 24, horasMinimas);
  }

  const { valor, composicao } = custoMinimo(horasFaturaveis, ativas);
  const valorUnitario = arredondar(valor);

  return {
    ok: true,
    horas,
    horasFaturaveis,
    dias: Math.ceil(horas / 24),
    diarias,
    composicao,
    faixaPrincipal: composicao.length ? composicao[0].faixa : menor.faixa,
    valorUnitario,
    valorTotal: arredondar(valorUnitario * quantidade),
  };
}

/**
 * Excedente de medidor (horímetro ou km) além da franquia contratada.
 *
 * A franquia é POR DIA de locação: 8 horas/dia numa locação de 5 dias dá 40
 * horas inclusas. Sem franquia cadastrada não há excedente — não se cobra por
 * algo que não foi combinado.
 */
function calcularExcedenteMedidor(spec, extras, dados) {
  const { medidorSaida, medidorRetorno, dias, quantidade } = dados || {};
  const tipo = spec && spec.medidorTipo;
  if (!tipo || tipo === 'nenhum') return { aplicavel: false, excedente: 0, valorTotal: 0 };

  const saida = Number(medidorSaida), retorno = Number(medidorRetorno);
  if (!Number.isFinite(saida) || !Number.isFinite(retorno)) {
    return { aplicavel: false, excedente: 0, valorTotal: 0, motivo: 'leitura ausente' };
  }
  if (retorno < saida) {
    return { aplicavel: false, excedente: 0, valorTotal: 0, erro: 'leitura de retorno menor que a de saída' };
  }

  const franquiaDia = Number(spec.franquiaPorDia);
  if (!Number.isFinite(franquiaDia) || franquiaDia <= 0) {
    return { aplicavel: false, excedente: 0, valorTotal: 0, motivo: 'sem franquia cadastrada' };
  }

  const usado = retorno - saida;
  const franquiaTotal = franquiaDia * Math.max(1, Number(dias) || 1);
  const excedente = Math.max(0, usado - franquiaTotal);

  const tipoExtra = tipo === 'km' ? 'km_extra' : 'hora_extra';
  const extra = (extras || []).find(e => e.tipo === tipoExtra && e.ativo !== 0);
  const valorUnitario = extra ? Number(extra.valor) : 0;

  return {
    aplicavel: excedente > 0 && valorUnitario > 0,
    tipo: tipoExtra,
    usado: arredondar(usado),
    franquiaTotal: arredondar(franquiaTotal),
    excedente: arredondar(excedente),
    valorUnitario: arredondar(valorUnitario),
    valorTotal: arredondar(excedente * valorUnitario * (Number(quantidade) > 0 ? Number(quantidade) : 1)),
  };
}

/**
 * Multa por devolução em atraso.
 *
 * Carência em horas antes de qualquer cobrança; depois dela, cada dia iniciado
 * de atraso custa `percentual`% do valor de uma diária. Sem tarifa de diária
 * cadastrada, usa o valor diário equivalente da locação.
 */
function calcularMultaAtraso(config, valorDiaria, previsto, real) {
  const carencia = Number(config && config.locacao_carencia_atraso_horas);
  const percentual = Number(config && config.locacao_multa_atraso_percentual);
  const horasCarencia = Number.isFinite(carencia) ? carencia : 0;
  const pct = Number.isFinite(percentual) ? percentual : 0;

  const a = paraMs(previsto), b = paraMs(real);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return { aplicavel: false, horasAtraso: 0, diasCobrados: 0, valorTotal: 0 };
  }

  const horasAtraso = Math.max(0, (b - a) / 3600000);
  if (horasAtraso <= horasCarencia || pct <= 0 || !(Number(valorDiaria) > 0)) {
    return {
      aplicavel: false,
      horasAtraso: arredondar(horasAtraso),
      dentroDaCarencia: horasAtraso > 0 && horasAtraso <= horasCarencia,
      diasCobrados: 0,
      valorTotal: 0,
    };
  }

  // Conta o atraso inteiro, não o que passa da carência: a carência é
  // tolerância para não multar, não desconto de quem atrasou dois dias.
  const diasCobrados = Math.ceil(horasAtraso / 24 - 1e-9);
  const valorDia = Number(valorDiaria) * (pct / 100);

  return {
    aplicavel: true,
    horasAtraso: arredondar(horasAtraso),
    diasCobrados,
    valorDia: arredondar(valorDia),
    percentual: pct,
    valorTotal: arredondar(diasCobrados * valorDia),
  };
}

// ─── Caução e reposição: valor fixo ou percentual ──────────────────────────
//
// Os dois aceitam as duas formas, e o PERCENTUAL TEM PRECEDÊNCIA quando está
// preenchido (> 0). O fixo continua valendo como valor único ou como fallback
// de quando a base do percentual não existe.
//
// A base de cada um é diferente porque a pergunta é outra:
//   caução    → garantia. Pode ser % do ALUGUEL ("30% do contrato") ou % do
//               BEM ("caução de 10% do valor do equipamento"). As duas
//               leituras são comuns, então a base é escolhida no cadastro em
//               vez de adivinhada.
//   reposição → quanto cobrar se o bem não voltar. Só faz sentido sobre o
//               valor do BEM: repor um percentual do aluguel não repõe nada.

const BASES_CAUCAO = ['locacao', 'bem'];

/**
 * Valor do bem para servir de base a percentual.
 *
 * `precoVenda` primeiro; se for zero (comum em produto que entrou por NF-e e
 * nunca foi precificado para venda — no tenant 1bit isso é a maioria), cai no
 * `precoCusto`. Sem nenhum dos dois não há base, e quem chama precisa saber
 * disso em vez de receber zero calado.
 */
function valorDoBem(produto) {
  if (!produto) return 0;
  const venda = Number(produto.precoVenda) || 0;
  if (venda > 0) return venda;
  return Number(produto.precoCusto) || 0;
}

/**
 * Caução de um item.
 *
 * @param spec     linha de locacao_item_specs
 * @param dados    { valorLocacao, produto, quantidade }
 * @returns { valor, modo, percentual, base, baseValor, aviso }
 */
function calcularCaucao(spec, dados = {}) {
  const quantidade = Number(dados.quantidade) > 0 ? Number(dados.quantidade) : 1;
  const fixo = arredondar((Number(spec && spec.caucaoPadrao) || 0) * quantidade);
  const pct = Number(spec && spec.caucaoPercentual) || 0;

  if (!(pct > 0)) {
    return { valor: fixo, modo: 'fixo', percentual: 0, base: null, baseValor: null };
  }

  const base = BASES_CAUCAO.includes(spec.caucaoPercentualBase) ? spec.caucaoPercentualBase : 'locacao';
  const baseValor = base === 'bem'
    ? arredondar(valorDoBem(dados.produto) * quantidade)
    : arredondar(Number(dados.valorLocacao) || 0);

  if (!(baseValor > 0)) {
    return {
      valor: fixo,
      modo: fixo > 0 ? 'fixo' : 'indefinido',
      percentual: pct,
      base,
      baseValor: 0,
      aviso: base === 'bem'
        ? 'produto sem preço de venda nem de custo — o percentual não tem base; usando o valor fixo'
        : 'item ainda sem valor de locação — o percentual não tem base; usando o valor fixo',
    };
  }

  return {
    valor: arredondar(baseValor * (pct / 100)),
    modo: 'percentual',
    percentual: pct,
    base,
    baseValor,
  };
}

/**
 * Valor de reposição de um item (o que se cobra quando ele não volta).
 * Percentual sempre sobre o valor do bem.
 */
function calcularReposicao(spec, dados = {}) {
  const quantidade = Number(dados.quantidade) > 0 ? Number(dados.quantidade) : 1;
  const fixoUnit = Number(spec && spec.valorReposicao) || 0;
  const pct = Number(spec && spec.reposicaoPercentual) || 0;

  if (!(pct > 0)) {
    return {
      valorUnitario: arredondar(fixoUnit),
      valor: arredondar(fixoUnit * quantidade),
      modo: fixoUnit > 0 ? 'fixo' : 'indefinido',
      percentual: 0,
    };
  }

  const bem = valorDoBem(dados.produto);
  if (!(bem > 0)) {
    return {
      valorUnitario: arredondar(fixoUnit),
      valor: arredondar(fixoUnit * quantidade),
      modo: fixoUnit > 0 ? 'fixo' : 'indefinido',
      percentual: pct,
      baseValor: 0,
      aviso: 'produto sem preço de venda nem de custo — o percentual não tem base; usando o valor fixo',
    };
  }

  const unit = arredondar(bem * (pct / 100));
  return {
    valorUnitario: unit,
    valor: arredondar(unit * quantidade),
    modo: 'percentual',
    percentual: pct,
    baseValor: arredondar(bem),
  };
}

// ─── Valor por extenso ─────────────────────────────────────────────────────
//
// Exigência da nota promissória: sem o valor escrito, o título não vale como
// título de crédito. Não há função dessas no repo — foi preciso escrever.

const UNIDADES = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove',
  'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZENAS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CENTENAS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos',
  'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

function trioPorExtenso(n) {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const partes = [];
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c) partes.push(CENTENAS[c]);
  if (resto) {
    if (resto < 20) partes.push(UNIDADES[resto]);
    else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      partes.push(u ? `${DEZENAS[d]} e ${UNIDADES[u]}` : DEZENAS[d]);
    }
  }
  return partes.join(' e ');
}

const ESCALAS = [
  { div: 1e9, sing: 'bilhão', plur: 'bilhões' },
  { div: 1e6, sing: 'milhão', plur: 'milhões' },
  { div: 1e3, sing: 'mil', plur: 'mil' },
];

function inteiroPorExtenso(n) {
  if (n === 0) return 'zero';
  const partes = [];
  let resto = n;
  for (const e of ESCALAS) {
    const q = Math.floor(resto / e.div);
    if (q > 0) {
      // "mil" não leva "um" na frente: 1000 é "mil", não "um mil".
      const prefixo = (e.div === 1e3 && q === 1) ? '' : trioPorExtenso(q) + ' ';
      partes.push(prefixo + (q === 1 ? e.sing : e.plur));
      resto %= e.div;
    }
  }
  if (resto > 0) partes.push(trioPorExtenso(resto));

  // "e" antes da última parte quando ela é menor que cem ou múltiplo redondo
  // de cem — a regra que faz "mil e duzentos" e "mil duzentos e trinta".
  if (partes.length > 1) {
    const ultima = resto;
    const ligar = ultima > 0 && (ultima < 100 || ultima % 100 === 0);
    return partes.slice(0, -1).join(', ') + (ligar ? ' e ' : ', ') + partes[partes.length - 1];
  }
  return partes[0];
}

/** Ex.: 2388.18 -> "dois mil, trezentos e oitenta e oito reais e dezoito centavos" */
function valorPorExtenso(v) {
  const total = Math.round((Number(v) || 0) * 100);
  const reais = Math.floor(total / 100);
  const centavos = total % 100;

  let parteReais = '';
  if (reais > 0) {
    const ext = inteiroPorExtenso(reais);
    // "dois milhões DE reais", mas "dois milhões e quinhentos mil reais".
    // A preposição só entra quando a escala é a última palavra.
    const terminaEmEscala = /\b(milh(ão|ões)|bilh(ão|ões))$/.test(ext);
    const moeda = reais === 1 ? 'real' : 'reais';
    parteReais = terminaEmEscala ? `${ext} de ${moeda}` : `${ext} ${moeda}`;
  }
  const parteCent = centavos === 0 ? ''
    : `${inteiroPorExtenso(centavos)} ${centavos === 1 ? 'centavo' : 'centavos'}`;

  if (!parteReais && !parteCent) return 'zero reais';
  if (!parteCent) return parteReais;
  if (!parteReais) return parteCent;
  return `${parteReais} e ${parteCent}`;
}

module.exports = {
  HORAS_POR_FAIXA,
  FAIXAS_VALIDAS,
  TIPOS_EXTRA,
  BASES_CAUCAO,
  diariasPorCorte,
  valorPorExtenso,
  valorDoBem,
  calcularCaucao,
  calcularReposicao,
  normalizarInstante,
  paraMs,
  somarHoras,
  duracaoHoras,
  calcularTarifa,
  calcularExcedenteMedidor,
  calcularMultaAtraso,
  arredondar,
};
