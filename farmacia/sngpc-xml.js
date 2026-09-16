/**
 * sngpc-xml.js — Geração do XML do SNGPC (ANVISA), versão 2.0.
 *
 * FONTE DO LAYOUT
 * "Guia de Geração do XML – SNGPC Versão 2" (ANVISA), baixado de
 *   https://www.gov.br/anvisa/pt-br/assuntos/fiscalizacao-e-monitoramento/sngpc/informes/GuiaSNGPC.pdf
 * Os nomes de elemento e os tipos enumerados abaixo saíram de lá, dos exemplos
 * oficiais e da seção "6. TIPOS ENUMERADOS NOVOS".
 *
 * LIMITE CONHECIDO — LEIA ANTES DE IR A PRODUÇÃO
 * Os XSDs oficiais (sngpc.xsd, sngpcSimpleTypes.xsd, sngpccomplexTypes.xsd)
 * ficam em http://sngpc.anvisa.gov.br/schema/ e esse host está atrás de um
 * Cloudflare que recusa download automatizado. Ou seja: este XML foi montado
 * conforme o guia oficial, mas NÃO foi validado contra o schema. A validação
 * de verdade é o ambiente de homologação da ANVISA, que depende do RT
 * credenciado. Enquanto isso não acontecer, trate a saída daqui como
 * "conforme o guia", não como "aprovada".
 *
 * Também não consta no guia v2 a enumeração de `tipoDocumento` do comprador
 * (é tipo antigo, listado num anexo que o guia só referencia). O default
 * adotado é 1 e o campo é configurável na receita.
 *
 * O encoding é iso-8859-1 porque é o que o guia usa no exemplo.
 */

// ─── Domínios oficiais (guia v2, seção 6) ────────────────────────────────────

// st_classeTerapeutica
const CLASSE_ANTIMICROBIANO = 1;
const CLASSE_CONTROLE_ESPECIAL = 2;

// st_TipoReceituario
const TIPO_RECEITUARIO = {
  controle_especial: 1, // Receita de Controle Especial em 2 vias (branca)
  notificacao_b: 2,     // Notificação de Receita B (azul)
  notificacao_especial: 3, // Notificação de Receita Especial (branca)
  notificacao_a: 4,     // Notificação de Receita A (amarela)
  antimicrobiano: 5,    // Receita Antimicrobiano em 2 vias
};

// st_TipoUsoMedicamento
const USO_HUMANO = 1;

// st_TipoOperacaoNotaFiscal
const OPERACAO_NF = { compra: 1, transferencia: 2, venda: 3 };

// st_TipoMotivoPerda
const MOTIVO_PERDA = {
  1: 'Furto / Roubo', 2: 'Avaria', 3: 'Vencimento',
  4: 'Apreensão / Recolhimento pela Visa', 5: 'Perda no processo',
  6: 'Coleta para controle de qualidade', 7: 'Perda de exclusão da portaria 344',
  8: 'Por desvio de qualidade', 9: 'Recolhimento do Fabricante',
};

// st_UnidadeMedidaMedicamento — o domínio tem só dois valores.
const UNIDADE_CAIXAS = 1;
const UNIDADE_FRASCOS = 2;

// st_ConselhoProfissional
const CONSELHOS_SNGPC = ['COREN', 'CRM', 'CRMV', 'CRO', 'CRF', 'RMS'];

function escaparXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function so(digitos) {
  return String(digitos == null ? '' : digitos).replace(/\D/g, '');
}

function exigirData(d, campo) {
  const s = String(d || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`SNGPC: ${campo} inválida ("${d}")`);
  return s;
}

/**
 * A unidade do SNGPC só tem "caixas" e "frascos". A unidade do catálogo é
 * livre, então o mapeamento é por heurística — e é explícito de propósito:
 * quem conferir o XML precisa entender de onde saiu o número.
 */
function unidadeMedida(unidade) {
  const u = String(unidade || '').trim().toUpperCase();
  if (['FR', 'FRASCO', 'FRASCOS', 'ML', 'L'].includes(u)) return UNIDADE_FRASCOS;
  return UNIDADE_CAIXAS;
}

function classeTerapeutica(spec) {
  return Number(spec && spec.antimicrobiano) ? CLASSE_ANTIMICROBIANO : CLASSE_CONTROLE_ESPECIAL;
}

function registroMS(ev) {
  const reg = so(ev.registroAnvisa);
  if (!reg) throw new Error(`SNGPC: ${ev.descricao || 'produto ' + ev.produtoId} sem registro ANVISA`);
  return reg;
}

function loteDe(ev) {
  const l = String(ev.loteNumero || '').trim();
  if (!l) throw new Error(`SNGPC: ${ev.descricao || 'produto ' + ev.produtoId} sem lote na movimentação`);
  return l;
}

function cabecalho(tag, { cnpjEmissor, cpfTransmissor }, datas) {
  const cnpj = so(cnpjEmissor);
  if (cnpj.length !== 14) throw new Error('SNGPC: CNPJ do emissor inválido');
  const cpf = so(cpfTransmissor);
  if (cpf.length !== 11) throw new Error('SNGPC: CPF do transmissor (RT) inválido');
  return `<cabecalho><cnpjEmissor>${cnpj}</cnpjEmissor>`
    + `<cpfTransmissor>${cpf}</cpfTransmissor>${datas}</cabecalho>`;
}

// ─── Inventário ──────────────────────────────────────────────────────────────

/**
 * Inventário: a fotografia do estoque de controlados. É pré-requisito da
 * primeira transmissão — sem ele a ANVISA não aceita movimentação.
 *
 * `itens`: [{ registroAnvisa, loteNumero, quantidade, unidade, antimicrobiano }]
 */
function montarInventario({ cnpjEmissor, cpfTransmissor, data, itens }) {
  const d = exigirData(data, 'data do inventário');
  if (!itens || !itens.length) throw new Error('SNGPC: inventário sem itens');

  const medicamentos = itens.map(it => {
    const reg = so(it.registroAnvisa);
    if (!reg) throw new Error(`SNGPC: item de inventário sem registro ANVISA (${it.descricao || '?'})`);
    const lote = String(it.loteNumero || '').trim();
    if (!lote) throw new Error(`SNGPC: item de inventário sem lote (${it.descricao || '?'})`);
    return '<entradaMedicamentos><medicamentoEntrada>'
      + `<classeTerapeutica>${classeTerapeutica(it)}</classeTerapeutica>`
      + `<registroMSMedicamento>${escaparXml(reg)}</registroMSMedicamento>`
      + `<numeroLoteMedicamento>${escaparXml(lote)}</numeroLoteMedicamento>`
      + `<quantidadeMedicamento>${Math.round(Number(it.quantidade))}</quantidadeMedicamento>`
      + `<unidadeMedidaMedicamento>${unidadeMedida(it.unidade)}</unidadeMedidaMedicamento>`
      + '</medicamentoEntrada></entradaMedicamentos>';
  }).join('');

  return '<?xml version="1.0" encoding="iso-8859-1" ?>'
    + '<mensagemSNGPCInventario xmlns="urn:sngpc-schema">'
    + cabecalho('inventario', { cnpjEmissor, cpfTransmissor }, `<data>${d}</data>`)
    + `<corpo><medicamentos>${medicamentos}</medicamentos></corpo>`
    + '</mensagemSNGPCInventario>';
}

// ─── Movimentação ────────────────────────────────────────────────────────────

function blocoEntrada(eventos) {
  // Entradas do mesmo documento fiscal viajam juntas — é assim que o guia
  // modela: uma nota, vários medicamentos.
  const porNota = new Map();
  for (const ev of eventos) {
    const chave = `${ev.documentoNumero || '0'}|${ev.data}|${so(ev.documentoTipo)}`;
    if (!porNota.has(chave)) porNota.set(chave, []);
    porNota.get(chave).push(ev);
  }

  let out = '';
  for (const [chave, evs] of porNota) {
    const [numero, data, cnpjOrigem] = chave.split('|');
    const meds = evs.map(ev =>
      '<medicamentoEntrada>'
      + `<classeTerapeutica>${classeTerapeutica(ev)}</classeTerapeutica>`
      + `<registroMSMedicamento>${escaparXml(registroMS(ev))}</registroMSMedicamento>`
      + `<numeroLoteMedicamento>${escaparXml(loteDe(ev))}</numeroLoteMedicamento>`
      + `<quantidadeMedicamento>${Math.round(Number(ev.quantidade))}</quantidadeMedicamento>`
      + `<unidadeMedidaMedicamento>${unidadeMedida(ev.unidade)}</unidadeMedidaMedicamento>`
      + '</medicamentoEntrada>').join('');

    out += '<entradaMedicamentos>'
      + '<notaFiscalEntradaMedicamento>'
      + `<numeroNotaFiscal>${escaparXml(numero || '0')}</numeroNotaFiscal>`
      + `<tipoOperacaoNotaFiscal>${OPERACAO_NF.compra}</tipoOperacaoNotaFiscal>`
      + `<dataNotaFiscal>${exigirData(data, 'data da nota de entrada')}</dataNotaFiscal>`
      + `<cnpjOrigem>${escaparXml(cnpjOrigem || '')}</cnpjOrigem>`
      + '</notaFiscalEntradaMedicamento>'
      + meds
      + `<dataRecebimentoMedicamento>${exigirData(data, 'data de recebimento')}</dataRecebimentoMedicamento>`
      + '</entradaMedicamentos>';
  }
  return out;
}

function blocoVenda(eventos, receitasPorId) {
  // Uma dispensação = uma receita + os medicamentos que saíram por ela.
  const porReceita = new Map();
  for (const ev of eventos) {
    const chave = `${ev.receitaId || 'sem'}|${ev.documentoNumero || ''}|${ev.data}`;
    if (!porReceita.has(chave)) porReceita.set(chave, []);
    porReceita.get(chave).push(ev);
  }

  let out = '';
  for (const [chave, evs] of porReceita) {
    const receitaId = chave.split('|')[0];
    const r = receitasPorId.get(Number(receitaId));
    if (!r) {
      throw new Error(`SNGPC: venda de controlado sem receita vinculada (nota ${evs[0].documentoNumero || '?'})`);
    }
    const tipoRec = TIPO_RECEITUARIO[r.tipo];
    if (!tipoRec) throw new Error(`SNGPC: tipo de receita sem correspondência no domínio da ANVISA: ${r.tipo}`);

    const conselho = String(r.prescritorConselho || '').toUpperCase();
    if (!CONSELHOS_SNGPC.includes(conselho)) {
      throw new Error(`SNGPC: conselho do prescritor fora do domínio da ANVISA: ${conselho || '(vazio)'}`);
    }

    const meds = evs.map(ev =>
      '<medicamentoVenda>'
      + '<usoProlongado>N</usoProlongado>'
      + `<registroMSMedicamento>${escaparXml(registroMS(ev))}</registroMSMedicamento>`
      + `<numeroLoteMedicamento>${escaparXml(loteDe(ev))}</numeroLoteMedicamento>`
      + `<quantidadeMedicamento>${Math.round(Number(ev.quantidade))}</quantidadeMedicamento>`
      + `<unidadeMedidaMedicamento>${unidadeMedida(ev.unidade)}</unidadeMedidaMedicamento>`
      + '</medicamentoVenda>').join('');

    out += '<saidaMedicamentoVendaAoConsumidor>'
      + `<tipoReceituarioMedicamento>${tipoRec}</tipoReceituarioMedicamento>`
      + `<numeroNotificacaoMedicamento>${escaparXml(r.numero || '0')}</numeroNotificacaoMedicamento>`
      + `<dataPrescricaoMedicamento>${exigirData(r.dataEmissao, 'data da prescrição')}</dataPrescricaoMedicamento>`
      + '<prescritorMedicamento>'
      + `<nomePrescritor>${escaparXml(r.prescritorNome)}</nomePrescritor>`
      + `<numeroRegistroProfissional>${escaparXml(r.prescritorNumero)}</numeroRegistroProfissional>`
      + `<conselhoProfissional>${conselho}</conselhoProfissional>`
      + `<UFConselho>${escaparXml(String(r.prescritorConselhoUf || '').toUpperCase())}</UFConselho>`
      + '</prescritorMedicamento>'
      + `<usoMedicamento>${USO_HUMANO}</usoMedicamento>`
      + '<compradorMedicamento>'
      + `<nomeComprador>${escaparXml(r.compradorNome)}</nomeComprador>`
      + '<tipoDocumento>1</tipoDocumento>'
      + `<numeroDocumento>${escaparXml(r.compradorDocumento)}</numeroDocumento>`
      + '</compradorMedicamento>'
      + '<pacienteMedicamento>'
      + `<nome>${escaparXml(r.pacienteNome)}</nome>`
      + '</pacienteMedicamento>'
      + meds
      + `<dataVendaMedicamento>${exigirData(evs[0].data, 'data da venda')}</dataVendaMedicamento>`
      + '</saidaMedicamentoVendaAoConsumidor>';
  }
  return out;
}

function blocoPerda(eventos) {
  // Uma perda por motivo: o motivo é do lote perdido, não do arquivo.
  return eventos.map(ev => {
    const motivo = Number(ev.documentoTipo) || 3; // 3 = vencimento
    if (!MOTIVO_PERDA[motivo]) throw new Error(`SNGPC: motivo de perda fora do domínio: ${motivo}`);
    return '<saidaMedicamentoPerda>'
      + `<motivoPerdaMedicamento>${motivo}</motivoPerdaMedicamento>`
      + '<medicamentoPerda>'
      + `<registroMSMedicamento>${escaparXml(registroMS(ev))}</registroMSMedicamento>`
      + `<numeroLoteMedicamento>${escaparXml(loteDe(ev))}</numeroLoteMedicamento>`
      + `<quantidadeMedicamento>${Math.round(Number(ev.quantidade))}</quantidadeMedicamento>`
      + `<unidadeMedidaMedicamento>${unidadeMedida(ev.unidade)}</unidadeMedidaMedicamento>`
      + '</medicamentoPerda>'
      + `<dataPerdaMedicamento>${exigirData(ev.data, 'data da perda')}</dataPerdaMedicamento>`
      + '</saidaMedicamentoPerda>';
  }).join('');
}

/**
 * Movimentação do período. `eventos` vem de sngpc-eventos.pendentes().
 * `receitasPorId` é um Map(id → linha de farmacia_receitas).
 */
function montarMovimentacao({ cnpjEmissor, cpfTransmissor, dataInicio, dataFim, eventos, receitasPorId }) {
  const di = exigirData(dataInicio, 'data de início');
  const df = exigirData(dataFim, 'data de fim');
  if (di > df) throw new Error('SNGPC: período invertido');
  if (!eventos || !eventos.length) throw new Error('SNGPC: período sem movimentação a escriturar');

  const entradas = eventos.filter(e => e.tipoMovimento === 'entrada');
  const vendas = eventos.filter(e => e.tipoMovimento === 'venda');
  const perdas = eventos.filter(e => e.tipoMovimento === 'perda');

  const corpo = blocoEntrada(entradas)
    + blocoVenda(vendas, receitasPorId || new Map())
    + blocoPerda(perdas);

  return '<?xml version="1.0" encoding="iso-8859-1" ?>'
    + '<mensagemSNGPC xmlns="urn:sngpc-schema">'
    + cabecalho('movimentacao', { cnpjEmissor, cpfTransmissor },
      `<dataInicio>${di}</dataInicio><dataFim>${df}</dataFim>`)
    + `<corpo><medicamentos>${corpo}</medicamentos></corpo>`
    + '</mensagemSNGPC>';
}

module.exports = {
  montarInventario,
  montarMovimentacao,
  unidadeMedida,
  classeTerapeutica,
  TIPO_RECEITUARIO,
  MOTIVO_PERDA,
  CONSELHOS_SNGPC,
  OPERACAO_NF,
  CLASSE_ANTIMICROBIANO,
  CLASSE_CONTROLE_ESPECIAL,
};
