/**
 * pedido-pdf.js — Gera PDF do Pedido (orçamento comercial, SEM VALOR FISCAL).
 * Uso: pedidoPdf.gerar(stream, pedido, emitente)
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

const TIPO_FRETE_LABEL = {
  '0':'Por conta do emitente (CIF)','1':'Por conta do destinatário (FOB)',
  '2':'Por conta de terceiros','3':'Transporte próprio (remetente)',
  '4':'Transporte próprio (destinatário)','9':'Sem frete'
};
const MEIO_PAGAMENTO_LABEL = {
  '01':'Dinheiro','02':'Cheque','03':'Cartão de Crédito','04':'Cartão de Débito',
  '05':'Crédito Loja','10':'Vale Alimentação','11':'Vale Refeição','12':'Vale Presente',
  '13':'Vale Combustível','14':'Duplicata Mercantil','15':'Boleto Bancário',
  '16':'Depósito Bancário','17':'PIX','18':'Transferência Bancária','19':'Carteira Digital',
  '90':'Sem pagamento','99':'Outros'
};
const STATUS_LABEL = {
  rascunho:'Rascunho', confirmado:'Confirmado', em_separacao:'Em Separação',
  entregue:'Entregue', faturado:'Faturado', cancelado:'Cancelado'
};

function box(doc, x, y, w, title, lines) {
  doc.save();
  doc.rect(x, y, w, 14).fill('#e8e8e8').stroke('#999');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#1971c2')
     .text(title, x + 5, y + 3, { width: w - 10 });
  doc.restore();
  y += 14;
  const nonEmpty = lines.filter(Boolean);
  const innerH = Math.max(18, nonEmpty.length * 12 + 8);
  doc.rect(x, y, w, innerH).stroke('#999');
  doc.font('Helvetica').fontSize(9).fillColor('#000');
  let ly = y + 4;
  for (const ln of nonEmpty) {
    doc.text(ln, x + 5, ly, { width: w - 10 });
    ly += 12;
  }
  return y + innerH;
}

function logoBuffer(logoStr) {
  if (!logoStr || typeof logoStr !== 'string') return null;
  const m = logoStr.match(/^data:image\/[a-zA-Z+.-]+;base64,(.+)$/);
  const b64 = m ? m[1] : logoStr;
  try { return Buffer.from(b64, 'base64'); } catch { return null; }
}

function gerar(stream, pedido, emitente) {
  emitente = emitente || {};
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);

  const pageW = doc.page.width - 80;
  let y = 40;

  // Logo (se houver)
  const logo = logoBuffer(emitente.logoBase64);
  const logoH = 48;
  const logoW = 120;
  let textoX = 40;
  let textoW = pageW;
  if (logo) {
    try {
      doc.image(logo, 40, y, { fit: [logoW, logoH] });
      textoX = 40 + logoW + 14;
      textoW = pageW - logoW - 14;
    } catch (e) {
      // logo inválido — segue sem
    }
  }

  // Cabeçalho
  const ehOrcamento = pedido.modoDocumento === 'orcamento';
  const tituloDoc = ehOrcamento ? 'ORÇAMENTO' : 'PEDIDO';
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#1971c2')
     .text(tituloDoc, textoX, y, { width: textoW, align: 'left' });
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#000')
     .text(pedido.numero, textoX, y, { width: textoW, align: 'right' });
  let yText = y + 24;

  const statusLbl = STATUS_LABEL[pedido.status] || pedido.status;
  doc.font('Helvetica').fontSize(9).fillColor('#666')
     .text(`Emissão: ${formatDate(pedido.dataPedido)}   ·   Status: ${statusLbl}${pedido.dataEntregaPrevista?`   ·   Entrega prevista: ${formatDate(pedido.dataEntregaPrevista)}`:''}`,
           textoX, yText, { width: textoW, align: 'right' });
  yText += 18;

  // Garantir que y continua abaixo tanto do logo quanto do texto
  y = Math.max(yText, 40 + (logo ? logoH : 0) + 8);

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
    pedido.clienteNome || '—',
    pedido.clienteCpfCnpj ? `CPF/CNPJ: ${formatDoc(pedido.clienteCpfCnpj)}` : '',
    [pedido.clienteEndereco, pedido.clienteNumero && 'nº ' + pedido.clienteNumero, pedido.clienteBairro].filter(Boolean).join(', ') || '',
    [pedido.clienteCidade, pedido.clienteUf, formatCep(pedido.clienteCep)].filter(Boolean).join(' / ') || '',
    [pedido.clienteTelefone && 'Tel: ' + pedido.clienteTelefone, pedido.clienteEmail && 'Email: ' + pedido.clienteEmail].filter(Boolean).join('   ·   ') || '',
  ]);
  y += 6;

  // ENDEREÇO DE ENTREGA (se override ou contato informado)
  const temEntregaOverride = pedido.enderecoEntrega || pedido.cidadeEntrega || pedido.contatoEntrega || pedido.telefoneEntrega;
  if (temEntregaOverride) {
    const usaEndEntrega = !!(pedido.enderecoEntrega || pedido.cidadeEntrega);
    y = box(doc, 40, y, pageW, 'ENTREGA', [
      pedido.contatoEntrega ? `Contato: ${pedido.contatoEntrega}` : '',
      pedido.telefoneEntrega ? `Tel: ${pedido.telefoneEntrega}` : '',
      usaEndEntrega ? [pedido.enderecoEntrega, pedido.numeroEntrega && 'nº ' + pedido.numeroEntrega, pedido.bairroEntrega].filter(Boolean).join(', ') : '',
      usaEndEntrega ? [pedido.cidadeEntrega, pedido.ufEntrega, formatCep(pedido.cepEntrega)].filter(Boolean).join(' / ') : '',
    ]);
    y += 10;
  }

  // TABELA DE ITENS
  const cols = [
    { label: '#',         w: 22,  align: 'center' },
    { label: 'SKU',       w: 60,  align: 'left' },
    { label: 'Descrição', w: 210, align: 'left' },
    { label: 'Un',        w: 28,  align: 'center' },
    { label: 'Qtd',       w: 50,  align: 'right' },
    { label: 'V.Unit',    w: 70,  align: 'right' },
    { label: 'Total',     w: 75,  align: 'right' },
  ];
  const tableW = cols.reduce((s, c) => s + c.w, 0);
  const x0 = 40;

  doc.rect(x0, y, tableW, 16).fill('#0f3460').stroke();
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);
  let cx = x0;
  for (const c of cols) {
    doc.text(c.label, cx + 3, y + 5, { width: c.w - 6, align: c.align });
    cx += c.w;
  }
  y += 16;

  doc.fillColor('#000').font('Helvetica').fontSize(8);
  const itens = pedido.itens || [];
  itens.forEach((it, i) => {
    const linhas = Math.max(1, Math.ceil((it.descricao || '').length / 50));
    const rowH = Math.max(14, linhas * 10);
    // Reserva ~80pt para totais + rodapé. Quebra página só quando realmente não cabe.
    if (y + rowH > doc.page.height - 80) { doc.addPage(); y = 40; }

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

  if (!itens.length) {
    doc.rect(x0, y, tableW, 22).stroke('#ccc');
    doc.fillColor('#888').fontSize(9).text('Nenhum item registrado neste pedido.', x0, y + 7, { width: tableW, align: 'center' });
    y += 22;
  }

  y += 8;

  // TOTAIS
  const totaisW = 200;
  const totaisX = x0 + tableW - totaisW;
  const valorBruto = itens.reduce((s, it) => s + Number(it.valorTotal || 0), 0);
  const valorFrete = Number(pedido.valorFrete) || 0;
  const total = valorBruto + valorFrete;

  doc.font('Helvetica').fontSize(9);
  doc.fillColor('#555').text('Subtotal:', totaisX, y, { width: totaisW - 90, align: 'right' });
  doc.fillColor('#000').text(formatMoney(valorBruto), totaisX + (totaisW - 85), y, { width: 85, align: 'right' });
  y += 14;
  if (valorFrete) {
    doc.fillColor('#555').text('Frete:', totaisX, y, { width: totaisW - 90, align: 'right' });
    doc.fillColor('#000').text(formatMoney(valorFrete), totaisX + (totaisW - 85), y, { width: 85, align: 'right' });
    y += 14;
  }
  doc.rect(totaisX, y, totaisW, 22).fill('#1971c2').stroke();
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(11);
  doc.text('TOTAL:', totaisX + 5, y + 6, { width: totaisW - 95, align: 'right' });
  doc.text(formatMoney(total), totaisX + (totaisW - 90), y + 6, { width: 85, align: 'right' });
  y += 32;

  doc.fillColor('#000').font('Helvetica').fontSize(9);

  // INFORMAÇÕES ADICIONAIS
  const infos = [];
  if (pedido.meioPagamento) infos.push(`Forma de pagamento: ${MEIO_PAGAMENTO_LABEL[pedido.meioPagamento] || pedido.meioPagamento}`);
  if (pedido.tipoFrete) infos.push(`Frete: ${TIPO_FRETE_LABEL[pedido.tipoFrete] || pedido.tipoFrete}`);
  if (pedido.transportadoraNome) infos.push(`Transportadora: ${pedido.transportadoraNome}`);
  if (pedido.codigoPedidoCliente) infos.push(`Pedido do cliente: ${pedido.codigoPedidoCliente}`);
  if (pedido.dataValidade) infos.push(`Validade da proposta: ${formatDate(pedido.dataValidade)}`);
  if (pedido.dataFaturamentoPrevista) infos.push(`Faturamento previsto: ${formatDate(pedido.dataFaturamentoPrevista)}`);
  if (pedido.faturaNumero) infos.push(`Faturado: ${pedido.faturaNumero}`);
  if (pedido.observacao) infos.push(`Obs: ${pedido.observacao}`);

  if (infos.length) {
    // Altura real do box: header 14 + linhas*12 + padding 8
    const infoH = 14 + Math.max(18, infos.length * 12 + 8);
    // Rodapé absoluto em page.height-50 (18pt). Reserva 60pt (box+espaço+rodapé).
    if (y + infoH > doc.page.height - 60) { doc.addPage(); y = 40; }
    y = box(doc, 40, y, pageW, 'INFORMAÇÕES', infos);
  }

  // Rodapé
  const footerY = doc.page.height - 50;
  doc.rect(40, footerY, pageW, 18).fill('#ffa94d').stroke();
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(10)
     .text(`${tituloDoc} — SEM VALOR FISCAL`, 40, footerY + 5, { width: pageW, align: 'center' });

  doc.end();
}

module.exports = { gerar };
