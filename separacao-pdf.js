/**
 * separacao-pdf.js — Lista de separação e conferência de mercadoria.
 *
 * NÃO é documento fiscal, e é por isso que ele existe. O DANFE tem 14 colunas
 * porque a SEFAZ exige as 14; quem separa a mercadoria no estoque precisa de
 * cinco: item, código, descrição, unidade e quantidade — mais um quadrado para
 * marcar o que já pegou.
 *
 * ── O que fica DE FORA, deliberadamente ─────────────────────────────────────
 *
 * Sem imposto, NCM, CFOP, CST, base de cálculo, preço unitário, total ou
 * qualquer valor em dinheiro. Duas razões: eles não ajudam a conferir uma
 * caixa, e esta folha circula pelo estoque e pelo balcão, onde preço de custo
 * e margem não deveriam passear. O teste `test-separacao.js` reprova se algum
 * deles aparecer.
 *
 * ── Escolhas de layout, e o que as motivou ──────────────────────────────────
 *
 * Fonte 10 (contra 8 do DANFE), linha de 22pt no mínimo e uma régua horizontal
 * cheia entre produtos. A folha é lida em pé, com a mercadoria na mão e muitas
 * vezes com a luz do depósito — o que se ganha em papel se perde em erro de
 * conferência.
 *
 * A quantidade é o maior elemento da linha (fonte 13, negrito, fundo cinza):
 * é o número que decide se a separação está certa.
 */

const PDFDocument = require('pdfkit');

const MARGEM = 36;
const FONTE = 10;
const ALTURA_MIN = 22;      // altura mínima de uma linha de produto
const RESERVA_RODAPE = 96;  // assinaturas + aviso

function fmtQtd(v) {
  const n = parseFloat(v) || 0;
  // Sem casas decimais quando é inteiro: "24" lê-se melhor que "24,000" a três
  // metros de distância, e a maioria das separações é em unidade inteira.
  return Number.isInteger(n)
    ? String(n)
    : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

function fmtData(s) {
  if (!s) return '';
  const d = String(s).substring(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : s;
}

function agora() {
  const d = new Date(Date.now() - 3 * 3600 * 1000); // -03
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * @param {WritableStream} stream  destino do PDF
 * @param {object} pedido          { numero, clienteNome, dataPedido, itens[], notaNumero? }
 * @param {object} emitente        { razaoSocial }
 */
function gerar(stream, pedido, emitente) {
  emitente = emitente || {};
  const doc = new PDFDocument({ size: 'A4', margin: MARGEM, bufferPages: true });
  doc.pipe(stream);

  const larguraUtil = doc.page.width - MARGEM * 2;
  const itens = pedido.itens || [];

  // Colunas: só o que serve para separar. A soma tem de dar `larguraUtil`.
  const cols = [
    { k: 'n',    label: '#',           w: 26 },
    { k: 'sku',  label: 'CÓDIGO',      w: 78 },
    { k: 'desc', label: 'DESCRIÇÃO DO PRODUTO', w: larguraUtil - 26 - 78 - 42 - 66 - 44 },
    { k: 'un',   label: 'UN',          w: 42 },
    { k: 'qtd',  label: 'QTD',         w: 66 },
    { k: 'ok',   label: 'OK',          w: 44 },
  ];
  const xDe = (i) => MARGEM + cols.slice(0, i).reduce((s, c) => s + c.w, 0);

  function cabecalhoDoc() {
    let y = MARGEM;
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#000')
       .text('LISTA DE SEPARAÇÃO', MARGEM, y, { width: larguraUtil, align: 'left' });
    doc.font('Helvetica').fontSize(9).fillColor('#444')
       .text(emitente.razaoSocial || '', MARGEM, y + 2, { width: larguraUtil, align: 'right' });
    y += 24;

    doc.moveTo(MARGEM, y).lineTo(MARGEM + larguraUtil, y).lineWidth(1.2).stroke('#000');
    y += 10;

    // Identificação: pedido, nota (quando houver), cliente e data.
    const campos = [
      ['Pedido', pedido.numero || '—'],
      ['Nota fiscal', pedido.notaNumero ? String(pedido.notaNumero) : '— não emitida —'],
      ['Data', fmtData(pedido.dataPedido)],
    ];
    doc.fontSize(9);
    let cx = MARGEM;
    for (const [rot, val] of campos) {
      doc.font('Helvetica').fillColor('#666').text(rot, cx, y);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(val, cx, y + 11);
      doc.fontSize(9);
      cx += larguraUtil / 3;
    }
    y += 30;
    doc.font('Helvetica').fontSize(9).fillColor('#666').text('Cliente', MARGEM, y);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000')
       .text(pedido.clienteNome || '—', MARGEM, y + 11, { width: larguraUtil, ellipsis: true });
    y += 34;
    return y;
  }

  function cabecalhoTabela(y) {
    doc.rect(MARGEM, y, larguraUtil, 20).fill('#1f2937');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.5);
    cols.forEach((c, i) => {
      const al = ['qtd', 'ok', 'n', 'un'].includes(c.k) ? 'center' : 'left';
      doc.text(c.label, xDe(i) + 4, y + 6, { width: c.w - 8, align: al });
    });
    doc.fillColor('#000');
    return y + 20;
  }

  let y = cabecalhoDoc();
  y = cabecalhoTabela(y);

  doc.font('Helvetica').fontSize(FONTE);
  const limite = doc.page.height - MARGEM - RESERVA_RODAPE;

  itens.forEach((it, i) => {
    const colDesc = cols[2];
    // Altura medida, não estimada — mesma lição do relatório 39: contar
    // caracteres erra, e o texto acaba escrevendo sobre a linha seguinte.
    const hDesc = doc.heightOfString(String(it.descricao || ''), { width: colDesc.w - 8 });
    const rowH = Math.max(ALTURA_MIN, Math.ceil(hDesc) + 12);

    // Produto não se divide entre páginas: se não cabe inteiro, vai todo para
    // a próxima.
    if (y + rowH > limite) {
      doc.addPage();
      y = cabecalhoTabela(MARGEM);
      doc.font('Helvetica').fontSize(FONTE);
    }

    // Zebra bem clara. É apoio: quem separa a folha em impressora monocromática
    // continua tendo as réguas horizontais, que são pretas.
    if (i % 2 === 1) doc.rect(MARGEM, y, larguraUtil, rowH).fill('#f4f6f8');

    doc.fillColor('#000').font('Helvetica').fontSize(FONTE);
    const yTexto = y + (rowH - Math.max(hDesc, FONTE)) / 2;

    doc.fontSize(9).fillColor('#666')
       .text(String(i + 1), xDe(0) + 2, y + (rowH - 9) / 2, { width: cols[0].w - 4, align: 'center' });
    doc.fontSize(9).fillColor('#000')
       .text(String(it.sku || '—'), xDe(1) + 4, y + (rowH - 9) / 2, { width: cols[1].w - 8, ellipsis: true });
    doc.fontSize(FONTE).font('Helvetica')
       .text(String(it.descricao || ''), xDe(2) + 4, yTexto, { width: colDesc.w - 8 });
    doc.fontSize(9)
       .text(String(it.unidade || '—'), xDe(3) + 2, y + (rowH - 9) / 2, { width: cols[3].w - 4, align: 'center' });

    // QUANTIDADE — o maior elemento da linha, com fundo próprio.
    doc.rect(xDe(4) + 3, y + 3, cols[4].w - 6, rowH - 6).fill('#e8edf3');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(13)
       .text(fmtQtd(it.quantidade), xDe(4) + 3, y + (rowH - 13) / 2 + 1, { width: cols[4].w - 6, align: 'center' });

    // Caixa para marcar o item separado.
    const lado = 13;
    doc.rect(xDe(5) + (cols[5].w - lado) / 2, y + (rowH - lado) / 2, lado, lado)
       .lineWidth(1).stroke('#333');

    // Régua entre produtos — preta, sobrevive a impressora monocromática.
    doc.moveTo(MARGEM, y + rowH).lineTo(MARGEM + larguraUtil, y + rowH)
       .lineWidth(0.5).stroke('#555');

    y += rowH;
    doc.font('Helvetica').fontSize(FONTE).fillColor('#000');
  });

  // Moldura da tabela, fechando o bloco.
  doc.rect(MARGEM, y, larguraUtil, 0).stroke('#000');

  // ---- Totais ----
  y += 14;
  const totalItens = itens.length;
  const totalUnidades = itens.reduce((s, i) => s + (parseFloat(i.quantidade) || 0), 0);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000');
  doc.text(`${totalItens} produto${totalItens === 1 ? '' : 's'} diferente${totalItens === 1 ? '' : 's'}`,
           MARGEM, y, { width: larguraUtil / 2 });
  doc.text(`Total de unidades: ${fmtQtd(totalUnidades)}`,
           MARGEM + larguraUtil / 2, y, { width: larguraUtil / 2, align: 'right' });
  y += 22;

  // ---- Observações ----
  doc.font('Helvetica').fontSize(9).fillColor('#666').text('OBSERVAÇÕES', MARGEM, y);
  y += 12;
  doc.rect(MARGEM, y, larguraUtil, 46).lineWidth(0.8).stroke('#999');
  // Pauta interna: escrever à mão sobre linha sai mais reto.
  for (let i = 1; i <= 2; i++) {
    doc.moveTo(MARGEM + 8, y + i * 15).lineTo(MARGEM + larguraUtil - 8, y + i * 15)
       .lineWidth(0.3).stroke('#ddd');
  }

  /**
   * Assinaturas e carimbo, em TODAS as páginas.
   *
   * Em todas porque a folha pode ser separada por mais de uma pessoa, e cada
   * página precisa poder ser assinada por quem a executou.
   */
  const faixa = doc.bufferedPageRange();
  for (let p = faixa.start; p < faixa.start + faixa.count; p++) {
    doc.switchToPage(p);
    const yAss = doc.page.height - MARGEM - 70;
    const larg = (larguraUtil - 24) / 3;
    const campos = ['Separado por', 'Conferido por', 'Data e hora da conferência'];
    campos.forEach((rot, i) => {
      const x = MARGEM + i * (larg + 12);
      doc.moveTo(x, yAss + 22).lineTo(x + larg, yAss + 22).lineWidth(0.8).stroke('#333');
      doc.font('Helvetica').fontSize(8).fillColor('#666')
         .text(rot, x, yAss + 26, { width: larg });
    });

    // O aviso divide a linha com "Emitido em" e "Página", em vez de ficar
    // acima: uma linha própria a 12pt do rodapé caía sobre o rótulo "Conferido
    // por", que está logo acima. Os três na mesma linha, em três colunas, não
    // se encontram.
    const yRod = doc.page.height - MARGEM - 14;
    doc.font('Helvetica').fontSize(7.5).fillColor('#666');
    doc.text(`Emitido em ${agora()}`, MARGEM, yRod, { width: larguraUtil / 3 });
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#9a3412')
       .text('USO INTERNO — SEM VALOR FISCAL',
             MARGEM + larguraUtil / 3, yRod, { width: larguraUtil / 3, align: 'center' });
    doc.font('Helvetica').fontSize(7.5).fillColor('#666')
       .text(`Página ${p - faixa.start + 1} de ${faixa.count}`,
             MARGEM + (larguraUtil * 2) / 3, yRod, { width: larguraUtil / 3, align: 'right' });
  }

  doc.end();
}

module.exports = { gerar };
