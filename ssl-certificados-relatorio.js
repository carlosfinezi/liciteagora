/**
 * ssl-certificados-relatorio.js — a carteira de certificados SSL em .xlsx e .pdf.
 *
 * Segue o molde dos outros relatórios do sistema: o .pdf espelha o de contas a
 * receber (A4 paisagem, faixa de cabeçalho, linha de filtros, tabela paginada)
 * e o .xlsx usa a mesma lib `xlsx` de /api/bi/exportar-xlsx.
 *
 * ── Três decisões que valem explicação ──────────────────────────────────────
 *
 * 1. O .xlsx leva TODAS as colunas, inclusive as 12 que o grid esconde por
 *    padrão. Quem exporta está conferindo com o painel da NicSRS ou com o
 *    financeiro do lado, e conferência com coluna faltando obriga a voltar à
 *    tela e remarcar o menu. O .pdf leva o subconjunto que cabe em paisagem
 *    sem encolher a fonte a ponto de não se ler impresso.
 *
 * 2. Data vai como DATA no Excel, não como o texto que a tela mostra. Na tela,
 *    "2027-09-09 360d" é uma célula só porque ali se lê, não se ordena; aqui
 *    isso viraria texto e quebraria ordenação, filtro de período e qualquer
 *    fórmula. A contagem de dias vira coluna própria, numérica, negativa quando
 *    já venceu.
 *
 * 3. Os KPIs são do CONJUNTO FILTRADO, e não da carteira inteira como na tela.
 *    Um relatório que imprime "34 emitidos" no topo e lista 6 linhas embaixo é
 *    um relatório que vai ser lido errado. Sem filtro nenhum os números batem
 *    com os da tela; com filtro, o cabeçalho diz qual filtro foi aplicado.
 */

const PDFDocument = require('pdfkit');

/** Hoje em Brasília — as datas da tabela são dia, sem hora; UTC erraria por 3h. */
function dataBrasilia() {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

/**
 * Rótulos legíveis. O banco guarda o status em kebab-case e a tela imprime o
 * valor cru dentro de um badge colorido; no papel, sem cor e sem contexto,
 * "aguardando-dados" não diz a ninguém o que falta fazer.
 *
 * São mais curtos que os do <select> da tela ("Comprado — falta enviar dados")
 * porque aqui eles vivem numa coluna de largura fixa: o rótulo longo saía
 * truncado como "Comprado…", que informa menos que o kebab-case original.
 */
const STATUS_LABEL = {
  'rascunho':             'Rascunho',
  'aguardando-aprovacao': 'Aguard. compra',
  'aguardando-dados':     'Falta enviar dados',
  'comprado':             'Validando',
  'em-validacao':         'Em validação',
  'emitido':              'Emitido',
  'reemitindo':           'Reemitindo',
  'substituido':          'Substituído',
  'expirado':             'Expirado',
  'cancelado':            'Cancelado',
};

/**
 * Data ISO -> serial do Excel (dias desde 30/12/1899), como NÚMERO INTEIRO.
 *
 * Não entregar um `Date` à lib `xlsx` é deliberado, e custou um bug para
 * descobrir: ao converter Date->serial ela compensa o fuso comparando o offset
 * de hoje com o de 30/12/1899, e em `America/Sao_Paulo` aquela data ainda está
 * em LMT. Sobra um resíduo de 28 segundos, o serial sai como 46638,99967 em vez
 * de 46639, e o Excel TRUNCA — 09/09/2027 aparecia na célula como 08/09/2027.
 * Um dia a menos, calado, em toda data do relatório.
 *
 * O cálculo em UTC puro não tem fuso nenhum para errar. 25569 é o serial de
 * 01/01/1970, a origem do epoch.
 *
 * Devolve null no que não parseia, para a célula sair vazia em vez de virar um
 * NaN que o Excel escreve como erro.
 */
function dataExcel(iso) {
  if (!iso) return null;
  const [a, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!a || !m || !d) return null;
  const ms = Date.UTC(a, m - 1, d);
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 86400000) + 25569;
}

/** Dias entre hoje e a data — negativo quando já passou. */
function diasAte(iso, hoje) {
  if (!iso) return null;
  const alvo = Date.parse(String(iso).slice(0, 10) + 'T12:00:00Z');
  const base = Date.parse(hoje + 'T12:00:00Z');
  if (Number.isNaN(alvo)) return null;
  return Math.round((alvo - base) / 86400000);
}

function fmtDataBr(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : s;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Colunas do .xlsx, na ordem em que saem. `tipo` decide a formatação da célula
 * — sem ele o Excel receberia tudo como texto e nada ordenaria.
 */
const COLUNAS_XLSX = [
  { label: 'ID',                 largura:  6,  tipo: 'num',   valor: (c) => c.id },
  { label: 'Domínio',            largura: 34,  tipo: 'texto', valor: (c) => c.commonName },
  { label: 'Cliente',            largura: 30,  tipo: 'texto', valor: (c) => c.clienteNome },
  { label: 'Contrato',           largura: 14,  tipo: 'texto', valor: (c) => c.contratoNumero },
  { label: 'Produto',            largura: 34,  tipo: 'texto', valor: (c) => c.productName || c.productCode },
  { label: 'Marca',              largura: 12,  tipo: 'texto', valor: (c) => c.vendor },
  { label: 'Status',             largura: 26,  tipo: 'texto', valor: (c) => STATUS_LABEL[c.status] || c.status },
  { label: 'Arquivo até',        largura: 12,  tipo: 'data',  valor: (c) => dataExcel(c.endDate) },
  { label: 'Dias p/ arquivo',    largura: 13,  tipo: 'num',   valor: (c, h) => diasAte(c.endDate, h) },
  { label: 'Assinatura até',     largura: 13,  tipo: 'data',  valor: (c) => dataExcel(c.cobertoAte) },
  { label: 'Dias p/ assinatura', largura: 15,  tipo: 'num',   valor: (c, h) => diasAte(c.cobertoAte, h) },
  { label: 'Reissues',           largura:  9,  tipo: 'num',   valor: (c) => c.reissuesFeitos || 0 },
  { label: 'DCV',                largura: 18,  tipo: 'texto', valor: (c) => c.dcvMethod },
  { label: 'Servidor',           largura: 10,  tipo: 'texto', valor: (c) => c.servidor },
  { label: 'Anos',               largura:  6,  tipo: 'num',   valor: (c) => num(c.anos) },
  { label: 'Custo US$',          largura: 11,  tipo: 'moeda', valor: (c) => num(c.custoUsd) },
  { label: 'Custo R$',           largura: 11,  tipo: 'moeda', valor: (c) => num(c.custoBrl) },
  { label: 'Compra',             largura: 11,  tipo: 'data',  valor: (c) => dataExcel(c.dataCompra) },
  { label: 'Pedido NicSRS',      largura: 20,  tipo: 'texto', valor: (c) => c.orderNum },
  { label: 'Application ID',     largura: 28,  tipo: 'texto', valor: (c) => c.certId },
  { label: 'Pedido de compra',   largura: 16,  tipo: 'texto', valor: (c) => c.pedidoCompraNumero },
];

/**
 * KPIs sobre as linhas já carregadas.
 *
 * Calculado em JS, e não em SQL como na rota do grid, porque o relatório carrega
 * o conjunto inteiro sem LIMIT: contar aqui é exato e evita manter uma segunda
 * cópia do WHERE (com os dois JOINs de pedido de compra) só para o agregado.
 * As definições abaixo espelham as do SQL em /api/ssl/certificados.
 */
function calcularKpis(linhas, hoje) {
  const k = {
    total: linhas.length,
    emitidos: 0, aguardandoAprovacao: 0, aguardandoDados: 0, emAndamento: 0,
    arquivoVencendo30d: 0, assinaturaVencendo90d: 0,
    custoUsd: 0, custoBrl: 0,
  };
  for (const c of linhas) {
    if (c.status === 'emitido') k.emitidos++;
    if (c.status === 'aguardando-aprovacao') k.aguardandoAprovacao++;
    if (c.status === 'aguardando-dados') k.aguardandoDados++;
    if (['comprado', 'reemitindo', 'em-validacao'].includes(c.status)) k.emAndamento++;

    const dArq = diasAte(c.endDate, hoje);
    if (c.status === 'emitido' && dArq != null && dArq <= 30) k.arquivoVencendo30d++;

    const dAss = diasAte(c.cobertoAte, hoje);
    if (dAss != null && dAss <= 90 && !['cancelado', 'expirado'].includes(c.status)) k.assinaturaVencendo90d++;

    k.custoUsd += num(c.custoUsd) || 0;
    k.custoBrl += num(c.custoBrl) || 0;
  }
  k.custoUsd = Math.round(k.custoUsd * 100) / 100;
  k.custoBrl = Math.round(k.custoBrl * 100) / 100;
  return k;
}

/** Descrição dos filtros aplicados — vai no cabeçalho do PDF e na aba Resumo. */
function descreverFiltros(filtros = {}) {
  const d = [];
  if (filtros.status) d.push(`status = ${STATUS_LABEL[filtros.status] || filtros.status}`);
  if (filtros.q) d.push(`busca = "${filtros.q}"`);
  if (filtros.clienteId) d.push(`cliente #${filtros.clienteId}`);
  if (filtros.contratoId) d.push(`contrato #${filtros.contratoId}`);
  return d;
}

// ==================== XLSX ====================

function gerarXlsx(linhas, filtros = {}) {
  const XLSX = require('xlsx');
  const hoje = dataBrasilia();
  const kpis = calcularKpis(linhas, hoje);

  // Aba 1 — os dados. Primeira de propósito: quem exporta para Excel vai
  // filtrar e ordenar, e é nesta aba que ele quer cair ao abrir o arquivo.
  const cabecalho = COLUNAS_XLSX.map((c) => c.label);
  const corpo = linhas.map((c) => COLUNAS_XLSX.map((col) => {
    const v = col.valor(c, hoje);
    return v == null || v === '' ? null : v;
  }));
  const ws = XLSX.utils.aoa_to_sheet([cabecalho, ...corpo]);
  ws['!cols'] = COLUNAS_XLSX.map((c) => ({ wch: c.largura }));
  // Autofiltro no cabeçalho — a planilha nasce pronta para filtrar por status
  // ou por cliente, que é o motivo de alguém exportar em vez de imprimir.
  // (Congelar a primeira linha não entra: `!freeze` é aceito pela API da lib
  // mas não chega a ser gravado no arquivo — conferido no sheet1.xml.)
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: COLUNAS_XLSX.length - 1, r: Math.max(1, linhas.length) } }) };

  // Formato por coluna. `aoa_to_sheet` acerta o TIPO da célula (data vira
  // serial, número vira número), mas o formato de exibição sai no padrão
  // americano — daí o `z` explícito, senão 09/12 aparece como dezembro.
  for (let col = 0; col < COLUNAS_XLSX.length; col++) {
    const tipo = COLUNAS_XLSX[col].tipo;
    if (tipo !== 'data' && tipo !== 'moeda') continue;
    for (let lin = 1; lin <= linhas.length; lin++) {
      const cel = ws[XLSX.utils.encode_cell({ c: col, r: lin })];
      if (!cel) continue;
      cel.z = tipo === 'data' ? 'dd/mm/yyyy' : '#,##0.00';
    }
  }

  // Aba 2 — o resumo, com os filtros escritos junto. Sem eles, uma planilha
  // com 6 linhas parece a carteira inteira daqui a duas semanas.
  const filtrosDesc = descreverFiltros(filtros);
  const resumo = [
    ['Relatório de certificados SSL'],
    ['Emitido em', fmtDataBr(hoje)],
    ['Filtros aplicados', filtrosDesc.length ? filtrosDesc.join(' · ') : 'nenhum — carteira completa'],
    [],
    ['Indicador', 'Quantidade'],
    ['Total no relatório', kpis.total],
    ['Emitidos', kpis.emitidos],
    ['Aguardando compra', kpis.aguardandoAprovacao],
    ['Falta enviar dados', kpis.aguardandoDados],
    ['Em validação', kpis.emAndamento],
    ['Arquivo vence em 30 dias', kpis.arquivoVencendo30d],
    ['Assinatura vence em 90 dias', kpis.assinaturaVencendo90d],
    [],
    ['Custo total US$', kpis.custoUsd],
    ['Custo total R$', kpis.custoBrl],
  ];
  const wsResumo = XLSX.utils.aoa_to_sheet(resumo);
  wsResumo['!cols'] = [{ wch: 30 }, { wch: 46 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Certificados');
  XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ==================== PDF ====================

const MARGEM = 30;
const LARGURA_UTIL = 842 - MARGEM * 2;   // A4 paisagem

/**
 * Colunas do PDF. As larguras somam 764pt; com os 7 vãos de 2pt dá 778, contra
 * 782 de área útil. Mexer numa largura exige refazer a conta — o teste
 * `test-ssl-relatorio` reprova se a soma estourar.
 *
 * A repartição não é estética, é de uso. Três colunas não podem truncar de
 * jeito nenhum, e por isso têm largura folgada: o número do pedido NicSRS e o
 * do pedido de compra são IDENTIFICADORES — servem para achar a mesma compra no
 * painel da NicSRS e no financeiro, e meio identificador não acha nada. O
 * status idem: "Validando…" não diria em que ponto a compra está.
 *
 * O que pode truncar sem prejuízo é nome longo de cliente e de produto, onde o
 * começo já identifica ("Certum Commercial Wildcard…").
 */
const COLUNAS_PDF = [
  { label: 'Domínio',            largura: 146, inteiro: true,  valor: (c) => c.commonName || '—' },
  { label: 'Cliente / Contrato', largura: 114, inteiro: false, valor: (c) => [c.clienteNome, c.contratoNumero].filter(Boolean).join(' · ') || '—' },
  { label: 'Produto',            largura: 140, inteiro: false, valor: (c) => c.productName || c.productCode || '—' },
  { label: 'Arquivo até',        largura:  58, inteiro: true,  valor: (c) => fmtDataBr(c.endDate) },
  { label: 'Assinatura até',     largura:  62, inteiro: true,  valor: (c) => fmtDataBr(c.cobertoAte) },
  { label: 'Status',             largura: 100, inteiro: true,  valor: (c) => STATUS_LABEL[c.status] || c.status || '—' },
  { label: 'Pedido NicSRS',      largura:  80, inteiro: true,  valor: (c) => c.orderNum || '—' },
  { label: 'Pedido compra',      largura:  64, inteiro: true,  valor: (c) => c.pedidoCompraNumero || '—' },
];

const FONTE_LINHA = 7.5;
const FONTE_MINIMA = 5.5;

/**
 * Escreve uma célula. Nas colunas marcadas `inteiro`, encolhe a fonte até o
 * texto caber em vez de cortá-lo.
 *
 * O que motivou: `*.subdominio-bem-longo.exemplo.gov.br` estourava os 146pt da
 * coluna e saía como `*.subdominio-bem-longo.exemp…`. Domínio e número de
 * pedido são a IDENTIDADE da linha — dois wildcards que só diferem no fim
 * viravam a mesma coisa no papel, e meio número de pedido não acha a compra no
 * painel da NicSRS.
 *
 * O piso de 5,5pt não é decoração: abaixo disso não se lê impresso, e aí
 * truncar passa a ser mais honesto que fingir que coube. Nome de cliente e de
 * produto ficam de fora de propósito — o começo deles já identifica, e encolher
 * a fonte de uma coluna que quase sempre estoura deixaria a folha ilegível.
 */
function celula(doc, texto, x, y, largura, inteiro) {
  const disponivel = largura - 4;
  let fonte = FONTE_LINHA;
  if (inteiro) {
    doc.fontSize(fonte);
    while (fonte > FONTE_MINIMA && doc.widthOfString(texto) > disponivel) {
      fonte -= 0.25;
      doc.fontSize(fonte);
    }
  }
  // height + ellipsis sempre: mesmo encolhido, um texto absurdo precisa parar
  // na própria linha em vez de escrever por cima da seguinte.
  doc.text(texto, x + 2, y, { width: disponivel, height: 10, ellipsis: true });
  if (fonte !== FONTE_LINHA) doc.fontSize(FONTE_LINHA);
}

function gerarPdf(stream, linhas, filtros = {}, emitente = {}) {
  const hoje = dataBrasilia();
  const kpis = calcularKpis(linhas, hoje);

  // bufferPages para poder escrever "Página X de Y": o total só se sabe depois
  // de desenhar a última linha.
  const doc = new PDFDocument({ size: 'A4', margin: MARGEM, layout: 'landscape', bufferPages: true });
  doc.pipe(stream);

  const fmtNum = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── Cabeçalho ──
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#000')
     .text(emitente.razaoSocial || 'Certificados SSL', MARGEM, MARGEM);
  if (emitente.cnpj) {
    doc.fontSize(9).font('Helvetica').fillColor('#444').text(`CNPJ: ${emitente.cnpj}`, MARGEM, doc.y);
  }
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#000')
     .text('Relatório — Certificados SSL', MARGEM, doc.y + 4);
  doc.fontSize(8).font('Helvetica').fillColor('#666')
     .text(`Emitido em ${fmtDataBr(hoje)} · ${linhas.length} certificado(s)`, MARGEM, doc.y);

  const filtrosDesc = descreverFiltros(filtros);
  doc.fontSize(8).font('Helvetica-Oblique').fillColor('#000')
     .text(filtrosDesc.length ? `Filtros: ${filtrosDesc.join(' · ')}` : 'Sem filtro — carteira completa', MARGEM, doc.y + 2);

  // ── Faixa de indicadores ──
  //
  // Os mesmos 7 da tela, na mesma ordem, para que quem imprime reconheça o que
  // estava vendo. Os dois de vencimento saem destacados: são os únicos que
  // pedem ação.
  const KPI_CELULAS = [
    ['Total', kpis.total, false],
    ['Emitidos', kpis.emitidos, false],
    ['Aguard. compra', kpis.aguardandoAprovacao, false],
    ['Falta enviar dados', kpis.aguardandoDados, false],
    ['Em validação', kpis.emAndamento, false],
    ['Arquivo vence 30d', kpis.arquivoVencendo30d, true],
    ['Assinatura vence 90d', kpis.assinaturaVencendo90d, true],
  ];
  let yKpi = doc.y + 8;
  const largKpi = LARGURA_UTIL / KPI_CELULAS.length;
  doc.rect(MARGEM, yKpi, LARGURA_UTIL, 30).fillAndStroke('#f4f4f6', '#ccc');
  KPI_CELULAS.forEach(([rot, val, alerta], i) => {
    const x = MARGEM + i * largKpi;
    if (i > 0) doc.moveTo(x, yKpi).lineTo(x, yKpi + 30).lineWidth(0.5).stroke('#ddd');
    doc.font('Helvetica').fontSize(6.5).fillColor('#666')
       .text(rot, x + 4, yKpi + 4, { width: largKpi - 8, height: 9, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(13).fillColor(alerta && val > 0 ? '#b45309' : '#111')
       .text(String(val), x + 4, yKpi + 13, { width: largKpi - 8, lineBreak: false });
  });

  // ── Tabela ──
  const desenharHeader = (yHead) => {
    doc.rect(MARGEM, yHead, LARGURA_UTIL, 14).fillAndStroke('#eee', '#ccc');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(7.5);
    let x = MARGEM;
    for (const col of COLUNAS_PDF) {
      doc.text(col.label, x + 2, yHead + 4, { width: col.largura - 4, height: 9, ellipsis: true });
      x += col.largura + 2;
    }
    return yHead + 16;
  };

  let y = desenharHeader(yKpi + 38);

  if (!linhas.length) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666')
       .text('Nenhum certificado para os filtros aplicados.', MARGEM, y + 6, { width: LARGURA_UTIL });
  }

  for (const c of linhas) {
    // A4 paisagem tem 595pt de altura; com margem 30 a última linha precisa
    // caber antes de 545 — abaixo disso ela escreveria sobre o rodapé.
    if (y > 545) { doc.addPage(); y = desenharHeader(MARGEM + 6); }

    // Vermelho quando o arquivo já venceu, âmbar quando vence em 30 dias: é a
    // informação que faz alguém agir, e num relatório impresso a cor é o único
    // recurso que sobra (o badge da tela não existe aqui).
    const dArq = diasAte(c.endDate, hoje);
    const finalizado = ['cancelado', 'expirado', 'substituido'].includes(c.status);
    let cor = '#000';
    if (finalizado) cor = '#888';
    else if (dArq != null && dArq < 0) cor = '#b91c1c';
    else if (dArq != null && dArq <= 30) cor = '#b45309';

    doc.font('Helvetica').fontSize(FONTE_LINHA).fillColor(cor);
    let x = MARGEM;
    for (const col of COLUNAS_PDF) {
      celula(doc, String(col.valor(c)), x, y, col.largura, col.inteiro);
      x += col.largura + 2;
    }
    y += 12;
  }

  // ── Totais ──
  if (linhas.length) {
    if (y > 515) { doc.addPage(); y = MARGEM + 10; }
    y += 6;
    doc.rect(MARGEM, y, LARGURA_UTIL, 14).fillAndStroke('#eef', '#99c');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(7.5);
    doc.text(`TOTAIS — ${linhas.length} certificado(s)`, MARGEM + 2, y + 4, { width: 300 });
    doc.text(`Custo US$ ${fmtNum(kpis.custoUsd)}   ·   Custo R$ ${fmtNum(kpis.custoBrl)}`,
             MARGEM + LARGURA_UTIL - 302, y + 4, { width: 300, align: 'right' });
  }

  // ── Rodapé em todas as páginas ──
  const faixa = doc.bufferedPageRange();
  for (let p = faixa.start; p < faixa.start + faixa.count; p++) {
    doc.switchToPage(p);
    doc.font('Helvetica').fontSize(7).fillColor('#666')
       .text(`Certificados SSL · emitido em ${fmtDataBr(hoje)}`,
             MARGEM, doc.page.height - MARGEM + 4, { width: LARGURA_UTIL / 2, lineBreak: false });
    doc.text(`Página ${p - faixa.start + 1} de ${faixa.count}`,
             MARGEM + LARGURA_UTIL / 2, doc.page.height - MARGEM + 4,
             { width: LARGURA_UTIL / 2, align: 'right', lineBreak: false });
  }

  doc.end();
}

module.exports = { gerarXlsx, gerarPdf, calcularKpis, descreverFiltros, COLUNAS_XLSX, COLUNAS_PDF, STATUS_LABEL };
