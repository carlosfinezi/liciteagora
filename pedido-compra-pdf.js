/**
 * pedido-compra-pdf.js — PDF do Pedido de COMPRA (documento enviado ao
 * fornecedor). Uso: pedidoCompraPdf.gerar(stream, pedido, itens, emitente)
 *
 * Baseado em pedido-pdf.js — mesmo estilo visual, mesmo uso de PDFKit — mas os
 * papéis se invertem: aqui a nossa empresa é quem COMPRA, e o fornecedor é o
 * destinatário do documento. Por isso não há dados de venda (frete ao cliente,
 * meio de pagamento recebido, vendedor); há prazo de entrega e condição de
 * pagamento acordados com o fornecedor.
 *
 * Sem valor fiscal: quem documenta a operação é a NF-e de entrada.
 */

const PDFDocument = require('pdfkit');

function formatDoc(doc) {
  if (!doc) return '';
  const d = String(doc).replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return doc;
}
function formatCep(c) {
  if (!c) return '';
  const d = String(c).replace(/\D/g, '');
  return d.length === 8 ? d.replace(/(\d{5})(\d{3})/, '$1-$2') : c;
}
function formatMoney(v) {
  const n = parseFloat(v) || 0;
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatQtd(v) {
  const n = parseFloat(v) || 0;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}
function formatDate(s) {
  if (!s) return '';
  const d = String(s).substring(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : s;
}

const STATUS_LABEL = {
  rascunho: 'Rascunho',
  enviado: 'Enviado ao fornecedor',
  enviado_parcial: 'Enviado parcialmente',
  recebido_parcial: 'Recebido parcialmente',
  recebido: 'Recebido',
  cancelado: 'Cancelado',
};

function box(doc, x, y, w, title, lines) {
  doc.save();
  doc.rect(x, y, w, 14).fill('#e8e8e8').stroke('#999');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#1971c2')
     .text(title, x + 5, y + 3, { width: w - 10 });
  doc.restore();
  y += 14;
  const nonEmpty = lines.filter(Boolean);
  doc.font('Helvetica').fontSize(9).fillColor('#000');
  // Altura real de cada linha: endereço longo quebra em duas e passaria por
  // cima da linha seguinte se o avanço fosse fixo.
  const alturas = nonEmpty.map((ln) => Math.max(12, doc.heightOfString(ln, { width: w - 10 })));
  const innerH = Math.max(18, alturas.reduce((s, h) => s + h, 0) + 8);
  doc.rect(x, y, w, innerH).stroke('#999');
  let ly = y + 4;
  nonEmpty.forEach((ln, i) => {
    doc.text(ln, x + 5, ly, { width: w - 10 });
    ly += alturas[i];
  });
  return y + innerH;
}

function logoBuffer(logoStr) {
  if (!logoStr || typeof logoStr !== 'string') return null;
  const m = logoStr.match(/^data:image\/[a-zA-Z+.-]+;base64,(.+)$/);
  const b64 = m ? m[1] : logoStr;
  try { return Buffer.from(b64, 'base64'); } catch { return null; }
}

function enderecoDe(o) {
  if (!o) return '';
  const rua = [o.endereco, o.numero, o.complemento].filter(Boolean).join(', ');
  const cidade = [o.bairro, o.cidade, o.uf].filter(Boolean).join(' - ');
  return [rua, cidade, o.cep ? 'CEP ' + formatCep(o.cep) : null].filter(Boolean).join('  ·  ');
}

function gerar(stream, pedido, itens, emitente) {
  emitente = emitente || {};
  itens = itens || [];
  // bufferPages: sem isso o switchToPage do rodapé lança — as páginas já teriam
  // sido despachadas para o stream.
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  doc.pipe(stream);

  const pageW = doc.page.width - 80;
  let y = 40;

  const logo = logoBuffer(emitente.logoBase64);
  const logoH = 48, logoW = 120;
  let textoX = 40, textoW = pageW;
  if (logo) {
    try {
      doc.image(logo, 40, y, { fit: [logoW, logoH] });
      textoX = 40 + logoW + 14;
      textoW = pageW - logoW - 14;
    } catch (_) { /* logo inválido: segue sem */ }
  }

  doc.font('Helvetica-Bold').fontSize(18).fillColor('#1971c2')
     .text('PEDIDO DE COMPRA', textoX, y, { width: textoW, align: 'left' });
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#000')
     .text(pedido.numero || '', textoX, y, { width: textoW, align: 'right' });
  let yText = y + 24;

  const statusLbl = STATUS_LABEL[pedido.status] || pedido.status || '';
  doc.font('Helvetica').fontSize(9).fillColor('#666')
     .text(`Emissão: ${formatDate(pedido.dataEmissao)}   ·   Status: ${statusLbl}`
           + (pedido.dataPrevistaEntrega ? `   ·   Entrega prevista: ${formatDate(pedido.dataPrevistaEntrega)}` : ''),
           textoX, yText, { width: textoW, align: 'right' });
  yText += 18;

  y = Math.max(yText, 40 + (logo ? logoH : 0) + 8);
  doc.moveTo(40, y).lineTo(40 + pageW, y).lineWidth(1).stroke('#1971c2');
  y += 10;

  // Duas colunas: quem compra (nós) e quem fornece.
  const colW = (pageW - 10) / 2;
  const yTopo = y;
  const yA = box(doc, 40, yTopo, colW, 'COMPRADOR', [
    emitente.razaoSocial || emitente.nomeFantasia || '',
    emitente.cnpj ? 'CNPJ: ' + formatDoc(emitente.cnpj) : '',
    enderecoDe(emitente),
    [emitente.telefone, emitente.email].filter(Boolean).join('  ·  '),
  ]);
  const yB = box(doc, 40 + colW + 10, yTopo, colW, 'FORNECEDOR', [
    pedido.fornecedorNome || '',
    pedido.fornecedorCnpj ? 'CNPJ/CPF: ' + formatDoc(pedido.fornecedorCnpj) : '',
    enderecoDe(pedido.fornecedorEndereco ? pedido.fornecedorEndereco : {
      endereco: pedido.fornecedorLogradouro, numero: pedido.fornecedorNumero,
      bairro: pedido.fornecedorBairro, cidade: pedido.fornecedorCidade,
      uf: pedido.fornecedorUf, cep: pedido.fornecedorCep,
    }),
    [pedido.fornecedorTelefone, pedido.fornecedorEmail].filter(Boolean).join('  ·  '),
  ]);
  y = Math.max(yA, yB) + 12;

  // ---- Itens
  const colX = [40, 110, 330, 400, 470];      // SKU | Descrição | Qtd | Unit. | Total
  const colFim = 40 + pageW;

  function cabecalhoItens(yy) {
    doc.save();
    doc.rect(40, yy, pageW, 16).fill('#e8e8e8').stroke('#999');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#1971c2');
    doc.text('CÓDIGO', colX[0] + 4, yy + 4, { width: colX[1] - colX[0] - 8 });
    doc.text('DESCRIÇÃO', colX[1] + 4, yy + 4, { width: colX[2] - colX[1] - 8 });
    doc.text('QTD', colX[2] + 4, yy + 4, { width: colX[3] - colX[2] - 8, align: 'right' });
    doc.text('UNITÁRIO', colX[3] + 4, yy + 4, { width: colX[4] - colX[3] - 8, align: 'right' });
    doc.text('TOTAL', colX[4] + 4, yy + 4, { width: colFim - colX[4] - 8, align: 'right' });
    doc.restore();
    return yy + 16;
  }

  y = cabecalhoItens(y);
  doc.font('Helvetica').fontSize(8).fillColor('#000');

  let total = 0;
  for (const it of itens) {
    const qtd = parseFloat(it.quantidade) || 0;
    const unit = parseFloat(it.custoUnitario) || 0;
    const sub = qtd * unit;
    total += sub;

    const descricao = it.descricao || ('produto #' + it.produtoId);
    // SKU também quebra em mais de uma linha (coluna estreita) — a altura da
    // linha tem de acomodar a maior das duas colunas de texto livre.
    const alturaTexto = Math.max(
      doc.heightOfString(descricao, { width: colX[2] - colX[1] - 8 }),
      doc.heightOfString(it.sku || '', { width: colX[1] - colX[0] - 8 })
    );
    const linhaH = Math.max(14, alturaTexto + 6);

    // Quebra de página: repete o cabeçalho da tabela na página seguinte.
    if (y + linhaH > doc.page.height - 90) {
      doc.addPage();
      y = 40;
      y = cabecalhoItens(y);
      doc.font('Helvetica').fontSize(8).fillColor('#000');
    }

    doc.rect(40, y, pageW, linhaH).stroke('#ccc');
    doc.text(it.sku || '', colX[0] + 4, y + 4, { width: colX[1] - colX[0] - 8 });
    doc.text(descricao, colX[1] + 4, y + 4, { width: colX[2] - colX[1] - 8 });
    doc.text(formatQtd(qtd) + (it.unidade ? ' ' + it.unidade : ''), colX[2] + 4, y + 4,
             { width: colX[3] - colX[2] - 8, align: 'right' });
    doc.text(formatMoney(unit), colX[3] + 4, y + 4, { width: colX[4] - colX[3] - 8, align: 'right' });
    doc.text(formatMoney(sub), colX[4] + 4, y + 4, { width: colFim - colX[4] - 8, align: 'right' });
    y += linhaH;
  }

  if (!itens.length) {
    doc.rect(40, y, pageW, 18).stroke('#ccc');
    doc.fillColor('#666').text('Pedido sem itens', 44, y + 5, { width: pageW - 8 });
    y += 18;
  }

  // ---- Total
  y += 8;
  doc.save();
  doc.rect(40 + pageW - 200, y, 200, 20).fill('#1971c2');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff')
     .text('TOTAL: ' + formatMoney(pedido.valorTotal != null ? pedido.valorTotal : total),
           40 + pageW - 196, y + 5, { width: 192, align: 'right' });
  doc.restore();
  y += 30;

  if (pedido.observacoes) {
    y = box(doc, 40, y, pageW, 'OBSERVAÇÕES', String(pedido.observacoes).split('\n')) + 10;
  }

  // Rodapé em todas as páginas: o documento não é fiscal, e isso precisa
  // estar visível para quem receber.
  const paginas = doc.bufferedPageRange();
  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(paginas.start + i);
    doc.font('Helvetica').fontSize(7).fillColor('#999')
       .text('Documento sem valor fiscal — emitido por Licite Agora ERP',
             40, doc.page.height - 50, { width: pageW, align: 'center' });
  }

  doc.end();
}

/**
 * Mesmo PDF, em memória — para anexar num e-mail em vez de servir por HTTP.
 */
function gerarBuffer(pedido, itens, emitente) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    const stream = new (require('stream').Writable)({
      write(chunk, _enc, cb) { pedacos.push(chunk); cb(); },
    });
    stream.on('finish', () => resolve(Buffer.concat(pedacos)));
    stream.on('error', reject);
    try {
      gerar(stream, pedido, itens, emitente);
    } catch (err) { reject(err); }
  });
}

module.exports = { gerar, gerarBuffer };
