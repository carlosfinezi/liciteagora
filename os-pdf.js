// os-pdf.js — Gera PDF de Ordem de Serviço (Plano 9.5)
//
// Layout: cabeçalho + dados cliente/equipamento + defeito + diagnóstico +
// solução + tabela peças + tabela serviços + totais + checklist executado +
// assinaturas (cliente/técnico) + rodapé com garantia + forma de pagamento.
//
// Baseado em pedido-pdf.js — mesmo estilo visual, mesmo uso de PDFKit.

'use strict';

const PDFDocument = require('pdfkit');

function fmtBRL(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtData(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-');
  return (d && m && y) ? `${d}/${m}/${y}` : s;
}

function gerar(stream, os, emitente, pecas = [], servicos = [], checklist = [], anexos = []) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);

  // ==================== CABEÇALHO ====================
  doc.fontSize(18).fillColor('#111').font('Helvetica-Bold').text('ORDEM DE SERVIÇO', { align: 'left' });
  doc.font('Helvetica').fontSize(11).fillColor('#444')
     .text(os.numero, { align: 'left' });

  // Emitente à direita
  doc.fontSize(9).fillColor('#333').font('Helvetica-Bold');
  const right = 415, top = 40;
  doc.text(emitente?.razaoSocial || '—', right, top, { width: 155 });
  doc.font('Helvetica').fontSize(8);
  if (emitente?.cnpj)      doc.text(`CNPJ: ${emitente.cnpj}`,        right, doc.y, { width: 155 });
  if (emitente?.telefone)  doc.text(`Tel:  ${emitente.telefone}`,    right, doc.y, { width: 155 });
  if (emitente?.email)     doc.text(emitente.email,                  right, doc.y, { width: 155 });

  // Linha separadora
  doc.moveTo(40, 110).lineTo(555, 110).strokeColor('#ccc').lineWidth(1).stroke();
  doc.y = 120;

  // ==================== DADOS DA OS ====================
  function row(label, val, opts = {}) {
    const lblW = opts.lblW || 110;
    doc.font('Helvetica').fontSize(9).fillColor('#666').text(label, 40, doc.y, { width: lblW, continued: false });
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#111')
       .text(String(val ?? '—'), 150, doc.y - 12, { width: 405 });
    doc.moveDown(0.2);
  }

  row('Cliente', os.clienteNome || '—');
  if (os.clienteCpfCnpj)      row('CPF/CNPJ', os.clienteCpfCnpj);
  if (os.clienteTelefone)     row('Telefone', os.clienteTelefone);
  row('Abertura', fmtData(os.dataAbertura));
  if (os.dataPromessa)        row('Prazo prometido', fmtData(os.dataPromessa));
  if (os.dataConclusao)       row('Conclusão', fmtData(os.dataConclusao));
  row('Status', (os.status || '').toUpperCase(), { bold: true });

  if (os.equipamento || os.marca || os.modelo) {
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#2563eb').text('Equipamento', 40, doc.y);
    doc.moveDown(0.2);
    row('Descrição', [os.equipamento, os.marca, os.modelo].filter(Boolean).join(' '));
    if (os.numeroSerieEquipamento) row('Nº série', os.numeroSerieEquipamento);
    if (os.garantiaDias)           row('Garantia', `${os.garantiaDias} dia(s)`);
  }

  function blockText(title, text) {
    if (!text) return;
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#2563eb').text(title, 40, doc.y);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).fillColor('#222').text(String(text), 40, doc.y, { width: 515, align: 'left' });
  }
  blockText('Defeito relatado', os.defeitoRelatado);
  blockText('Diagnóstico', os.diagnostico);
  blockText('Solução', os.solucao);

  // ==================== TABELA DE PEÇAS ====================
  if (pecas.length > 0) {
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('Peças utilizadas', 40, doc.y);
    doc.moveDown(0.3);
    const yHead = doc.y;
    doc.rect(40, yHead, 515, 18).fillColor('#f3f4f6').fill();
    doc.fillColor('#374151').font('Helvetica-Bold').fontSize(8);
    doc.text('SKU',        45,  yHead + 5, { width: 60 });
    doc.text('Descrição',  110, yHead + 5, { width: 230 });
    doc.text('Qtd',        345, yHead + 5, { width: 40, align: 'right' });
    doc.text('Valor un.',  390, yHead + 5, { width: 70, align: 'right' });
    doc.text('Total',      465, yHead + 5, { width: 85, align: 'right' });
    doc.y = yHead + 20;

    doc.font('Helvetica').fontSize(9).fillColor('#111');
    for (const p of pecas) {
      const y = doc.y;
      doc.text(p.sku || '—',         45,  y, { width: 60 });
      doc.text(p.descricao,          110, y, { width: 230 });
      doc.text(String(p.quantidade), 345, y, { width: 40, align: 'right' });
      doc.text(fmtBRL(p.valorUnitario), 390, y, { width: 70, align: 'right' });
      doc.text(fmtBRL(p.valorTotal),    465, y, { width: 85, align: 'right' });
      doc.moveDown(0.3);
    }
  }

  // ==================== TABELA DE SERVIÇOS ====================
  if (servicos.length > 0) {
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('Serviços prestados', 40, doc.y);
    doc.moveDown(0.3);
    const yHead = doc.y;
    doc.rect(40, yHead, 515, 18).fillColor('#f3f4f6').fill();
    doc.fillColor('#374151').font('Helvetica-Bold').fontSize(8);
    doc.text('Descrição',  45,  yHead + 5, { width: 295 });
    doc.text('Horas',      345, yHead + 5, { width: 40, align: 'right' });
    doc.text('R$/hora',    390, yHead + 5, { width: 70, align: 'right' });
    doc.text('Total',      465, yHead + 5, { width: 85, align: 'right' });
    doc.y = yHead + 20;

    doc.font('Helvetica').fontSize(9).fillColor('#111');
    for (const s of servicos) {
      const y = doc.y;
      doc.text(s.descricao,                         45,  y, { width: 295 });
      doc.text(s.horas != null ? String(s.horas) : '—', 345, y, { width: 40, align: 'right' });
      doc.text(s.valorHora != null ? fmtBRL(s.valorHora) : '—', 390, y, { width: 70, align: 'right' });
      doc.text(fmtBRL(s.valorTotal),                465, y, { width: 85, align: 'right' });
      doc.moveDown(0.3);
    }
  }

  // ==================== TOTAIS ====================
  doc.moveDown(0.6);
  const totY = doc.y;
  doc.rect(300, totY, 255, 70).fillColor('#eff6ff').fill();
  doc.fillColor('#1e40af').font('Helvetica').fontSize(9);
  doc.text('Peças',    310, totY + 8,  { width: 150 });
  doc.text(fmtBRL(os.valorPecas),    455, totY + 8,  { width: 90, align: 'right' });
  doc.text('Serviços', 310, totY + 25, { width: 150 });
  doc.text(fmtBRL(os.valorServicos), 455, totY + 25, { width: 90, align: 'right' });
  doc.moveTo(310, totY + 42).lineTo(545, totY + 42).strokeColor('#93c5fd').lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1e3a8a');
  doc.text('TOTAL', 310, totY + 48, { width: 150 });
  doc.text(fmtBRL(os.valorTotal),    455, totY + 48, { width: 90, align: 'right' });
  doc.y = totY + 78;

  // ==================== CHECKLIST EXECUTADO ====================
  if (checklist.length > 0) {
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text('Procedimentos executados', 40, doc.y);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9);
    for (const c of checklist) {
      const mark = c.concluido ? '☑' : '☐';
      const line = `${mark}  ${c.descricao}${c.obrigatorio ? ' *' : ''}${c.responsavel ? ` — ${c.responsavel}` : ''}`;
      doc.fillColor(c.concluido ? '#059669' : '#9ca3af').text(line, 40, doc.y, { width: 515 });
      doc.moveDown(0.15);
    }
  }

  // ==================== ASSINATURAS ====================
  doc.moveDown(1);
  if (doc.y > 680) doc.addPage();
  const yAss = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#444');
  doc.text('Cliente', 60, yAss, { width: 200, align: 'center' });
  doc.text('Técnico', 335, yAss, { width: 200, align: 'center' });

  // Renderiza assinatura se existir (dataURL PNG)
  function drawSig(dataUrl, x, y, w, h) {
    try {
      if (!dataUrl || !dataUrl.startsWith('data:image/')) return false;
      const b64 = dataUrl.split(',')[1];
      const buf = Buffer.from(b64, 'base64');
      doc.image(buf, x, y, { fit: [w, h] });
      return true;
    } catch (_) { return false; }
  }
  const sigY = yAss + 12;
  const drewCli = drawSig(os.assinaturaClienteDataUrl, 60,  sigY, 200, 50);
  const drewTec = drawSig(os.assinaturaTecnicoDataUrl, 335, sigY, 200, 50);

  doc.moveTo(60,  sigY + 60).lineTo(260, sigY + 60).strokeColor('#aaa').lineWidth(0.5).stroke();
  doc.moveTo(335, sigY + 60).lineTo(535, sigY + 60).strokeColor('#aaa').lineWidth(0.5).stroke();
  doc.font('Helvetica').fontSize(8).fillColor('#666');
  doc.text(os.clienteNome || '—', 60,  sigY + 62, { width: 200, align: 'center' });
  doc.text((os.tecnicoNomeExibicao || os.tecnicoNome || '—'), 335, sigY + 62, { width: 200, align: 'center' });
  if (drewCli && os.assinaturaClienteData) doc.fontSize(7).fillColor('#059669').text(`Assinado em ${fmtData(os.assinaturaClienteData)}`, 60, sigY + 72, { width: 200, align: 'center' });
  if (drewTec && os.assinaturaTecnicoData) doc.fontSize(7).fillColor('#059669').text(`Assinado em ${fmtData(os.assinaturaTecnicoData)}`, 335, sigY + 72, { width: 200, align: 'center' });

  // ==================== RODAPÉ ====================
  doc.fontSize(7).fillColor('#9ca3af');
  const rod = `Garantia: ${os.garantiaDias || 0} dia(s) a contar do faturamento. ` +
              `Forma de pagamento: ${os.formaPagamento || '—'}. ` +
              `Emitido em ${new Date().toLocaleString('pt-BR')}`;
  doc.text(rod, 40, 800, { width: 515, align: 'center' });

  doc.end();
}

module.exports = { gerar };
