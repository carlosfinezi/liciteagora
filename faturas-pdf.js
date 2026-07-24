/**
 * faturas-pdf.js — Gera PDF de fatura comercial (SEM VALOR FISCAL).
 * Uso: faturasPdf.gerar(stream, fatura, emitente)
 */

const PDFDocument = require('pdfkit');

function formatDoc(doc) {
  if (!doc) return '';
  const d = doc.replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return doc;
}
function formatCep(c) {
  if (!c) return '';
  const d = c.replace(/\D/g, '');
  return d.length === 8 ? d.replace(/(\d{5})(\d{3})/, '$1-$2') : c;
}
function formatMoney(v) {
  const n = parseFloat(v) || 0;
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatQtd(v) {
  const n = parseFloat(v) || 0;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}
function formatDate(s) {
  if (!s) return '';
  const d = s.substring(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : s;
}

const MEIO_PAGAMENTO_LABEL = {
  '01':'Dinheiro','02':'Cheque','03':'Cartão de Crédito','04':'Cartão de Débito',
  '05':'Crédito Loja','10':'Vale Alimentação','11':'Vale Refeição','12':'Vale Presente',
  '13':'Vale Combustível','14':'Duplicata Mercantil','15':'Boleto Bancário',
  '16':'Depósito Bancário','17':'PIX','18':'Transferência Bancária','19':'Carteira Digital',
  '90':'Sem pagamento','99':'Outros'
};

function gerar(stream, fatura, emitente) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);

  const pageW = doc.page.width - 80; // área útil
  let y = 40;

  // CABEÇALHO
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#1971c2')
     .text('FATURA COMERCIAL', 40, y, { width: pageW, align: 'left' });
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#000')
     .text(fatura.numero, 40, y, { width: pageW, align: 'right' });
  y += 24;
  doc.font('Helvetica').fontSize(9).fillColor('#666')
     .text(`Emissão: ${formatDate(fatura.dataEmissao)}   ·   Vencimento: ${formatDate(fatura.dataVencimento)}`, 40, y, { width: pageW, align: 'right' });
  y += 18;

  // Linha separadora
  doc.moveTo(40, y).lineTo(40 + pageW, y).lineWidth(1).stroke('#1971c2');
  y += 10;

  // EMITENTE
  y = box(doc, 40, y, pageW, 'EMITENTE', [
    emitente.razaoSocial || '—',
    `CNPJ: ${formatDoc(emitente.cnpj)}${emitente.inscricaoEstadual ? ' · IE: ' + emitente.inscricaoEstadual : ''}`,
    [emitente.endereco, emitente.numero && 'nº ' + emitente.numero, emitente.bairro].filter(Boolean).join(', ') || '—',
    [emitente.cidade, emitente.uf, formatCep(emitente.cep)].filter(Boolean).join(' / ') || '—',
    [emitente.telefone && 'Tel: ' + emitente.telefone, emitente.email && 'Email: ' + emitente.email].filter(Boolean).join('   ·   ') || '',
  ]);
  y += 6;

  // CLIENTE
  y = box(doc, 40, y, pageW, 'CLIENTE', [
    fatura.clienteNome || '—',
    `CPF/CNPJ: ${formatDoc(fatura.clienteCpfCnpj)}`,
    [fatura.clienteEndereco, fatura.clienteNumero && 'nº ' + fatura.clienteNumero, fatura.clienteBairro].filter(Boolean).join(', ') || '—',
    [fatura.clienteCidade, fatura.clienteUf, formatCep(fatura.clienteCep)].filter(Boolean).join(' / ') || '—',
    [fatura.clienteTelefone && 'Tel: ' + fatura.clienteTelefone, fatura.clienteEmail && 'Email: ' + fatura.clienteEmail].filter(Boolean).join('   ·   ') || '',
  ]);
  y += 10;

  // TABELA DE ITENS
  // Colunas: # | SKU | Descrição | Un | Qtd | V.Unit | Total
  const cols = [
    { label: '#',         w: 22,  align: 'center' },
    { label: 'SKU',       w: 60,  align: 'left' },
    { label: 'Descrição', w: 200, align: 'left' },
    { label: 'Un',        w: 28,  align: 'center' },
    { label: 'Qtd',       w: 50,  align: 'right' },
    { label: 'V.Unit',    w: 70,  align: 'right' },
    { label: 'Total',     w: 85,  align: 'right' },
  ];
  const tableW = cols.reduce((s, c) => s + c.w, 0);
  const x0 = 40;

  // Header
  doc.rect(x0, y, tableW, 16).fill('#0f3460').stroke();
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);
  let cx = x0;
  for (const c of cols) {
    doc.text(c.label, cx + 3, y + 5, { width: c.w - 6, align: c.align });
    cx += c.w;
  }
  y += 16;

  doc.fillColor('#000').font('Helvetica').fontSize(8);
  fatura.itens.forEach((it, i) => {
    const linhas = Math.max(1, Math.ceil((it.descricao || '').length / 50));
    const rowH = Math.max(14, linhas * 10);

    if (y + rowH > doc.page.height - 120) {
      doc.addPage();
      y = 40;
    }

    if (i % 2 === 1) doc.rect(x0, y, tableW, rowH).fill('#f4f6fb').stroke('#ccc');
    doc.fillColor('#000');

    cx = x0;
    const vals = [
      String(i + 1),
      it.sku || '—',
      it.descricao || '',
      it.unidade || '—',
      formatQtd(it.quantidade),
      formatMoney(it.precoUnitario),
      formatMoney(it.valorTotal),
    ];
    cols.forEach((c, idx) => {
      doc.text(vals[idx], cx + 3, y + 3, { width: c.w - 6, align: c.align });
      cx += c.w;
    });
    doc.rect(x0, y, tableW, rowH).stroke('#ccc');
    y += rowH;
  });

  y += 8;

  // TOTAIS
  const totaisW = 200;
  const totaisX = x0 + tableW - totaisW;
  const pares = [
    ['Subtotal', formatMoney(fatura.valorBruto)],
    ...(fatura.valorFrete ? [['Frete', formatMoney(fatura.valorFrete)]] : []),
    ...(fatura.valorDesconto ? [['Desconto', '- ' + formatMoney(fatura.valorDesconto)]] : []),
  ];
  doc.font('Helvetica').fontSize(9);
  for (const [l, v] of pares) {
    doc.fillColor('#555').text(l + ':', totaisX, y, { width: totaisW - 90, align: 'right' });
    doc.fillColor('#000').text(v, totaisX + (totaisW - 85), y, { width: 85, align: 'right' });
    y += 14;
  }
  doc.rect(totaisX, y, totaisW, 22).fill('#1971c2').stroke();
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(11);
  doc.text('TOTAL:', totaisX + 5, y + 6, { width: totaisW - 95, align: 'right' });
  doc.text(formatMoney(fatura.valorTotal), totaisX + (totaisW - 90), y + 6, { width: 85, align: 'right' });
  y += 32;

  doc.fillColor('#000').font('Helvetica').fontSize(9);

  // Pagamento e referência
  if (y > doc.page.height - 180) { doc.addPage(); y = 40; }
  y = box(doc, 40, y, pageW, 'PAGAMENTO', [
    `Forma: ${MEIO_PAGAMENTO_LABEL[fatura.meioPagamento] || fatura.meioPagamento || '—'}`,
    `Vencimento: ${formatDate(fatura.dataVencimento)}`,
    ...(emitente.banco ? [`Banco: ${emitente.banco}${emitente.agencia ? '  Ag: ' + emitente.agencia : ''}${emitente.conta ? '  Conta: ' + emitente.conta : ''}`] : []),
  ]);
  y += 6;

  // Referência / Observações
  const infos = [`Pedido: ${fatura.pedidoNumero || '—'}`];
  if (fatura.observacao) infos.push(`Obs: ${fatura.observacao}`);
  y = box(doc, 40, y, pageW, 'INFORMAÇÕES ADICIONAIS', infos);

  // Rodapé "SEM VALOR FISCAL"
  const footerY = doc.page.height - 50;
  doc.rect(40, footerY, pageW, 18).fill('#ffa94d').stroke();
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(10)
     .text('DOCUMENTO SEM VALOR FISCAL', 40, footerY + 5, { width: pageW, align: 'center' });

  doc.end();
}

function box(doc, x, y, w, title, lines) {
  doc.save();
  doc.rect(x, y, w, 14).fill('#e8e8e8').stroke('#999');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#1971c2')
     .text(title, x + 5, y + 3, { width: w - 10 });
  doc.restore();
  y += 14;

  const innerH = lines.filter(Boolean).length * 12 + 8;
  doc.rect(x, y, w, innerH).stroke('#999');
  doc.font('Helvetica').fontSize(9).fillColor('#000');
  let ly = y + 4;
  for (const ln of lines) {
    if (!ln) continue;
    doc.text(ln, x + 5, ly, { width: w - 10 });
    ly += 12;
  }
  return y + innerH;
}

module.exports = { gerar };
