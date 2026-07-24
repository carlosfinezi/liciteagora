/**
 * optica-pdf.js — PDF da Ordem de Montagem (laboratório).
 * Layout enxuto: dados do cliente + receita por olho + lente/armação + obs.
 * NÃO inclui dados fiscais — é um documento operacional para o lab.
 */

const PDFDocument = require('pdfkit');

function fmtData(s) {
  if (!s) return '—';
  const p = String(s).slice(0, 10).split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(s);
}

function fmtDoc(d) {
  if (!d) return '—';
  d = String(d).replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}

function fmtN(v, opts = {}) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  const fixed = opts.int ? String(Math.round(n)) : n.toFixed(2);
  return sign + fixed + (opts.suffix || '');
}

function logoBuffer(b64) {
  if (!b64 || typeof b64 !== 'string') return null;
  const m = b64.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
  const payload = m ? m[2] : b64;
  try { return Buffer.from(payload, 'base64'); } catch { return null; }
}

function gerarOrdemMontagemPdf({ om, fornecedor }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 36 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width - 72; // largura útil
      let y = 36;

      // ===== CABEÇALHO =====
      const logo = logoBuffer(fornecedor && fornecedor.logoBase64);
      const headerH = 60;
      doc.rect(36, y, W, headerH).stroke('#000');
      if (logo) {
        try { doc.image(logo, 40, y + 6, { fit: [110, headerH - 12], align: 'left', valign: 'center' }); }
        catch { /* ignore */ }
      }
      const nomeEmpresa = fornecedor && (fornecedor.razaoSocial || fornecedor.nomeFantasia) || 'ÓTICA';
      doc.fontSize(15).font('Helvetica-Bold').fillColor('#000')
        .text('ORDEM DE MONTAGEM', 36, y + 10, { width: W, align: 'center' });
      doc.fontSize(9).font('Helvetica').fillColor('#444')
        .text(String(nomeEmpresa).toUpperCase(), 36, y + 30, { width: W, align: 'center' });
      doc.fontSize(8).fillColor('#666')
        .text(`Documento operacional para o laboratório · não substitui receita médica`, 36, y + 44, { width: W, align: 'center' });
      y += headerH + 8;

      // ===== IDENTIFICAÇÃO =====
      const idH = 32;
      doc.rect(36, y, W, idH).stroke('#999');
      doc.fontSize(8).font('Helvetica').fillColor('#666')
        .text('Nº da OM', 42, y + 4)
        .text('Data de abertura', 42 + W/3, y + 4)
        .text('Pedido vinculado', 42 + 2*W/3, y + 4);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000')
        .text(om.numero || '—', 42, y + 14, { width: W/3 - 8 })
        .text(fmtData(om.dataAbertura), 42 + W/3, y + 14, { width: W/3 - 8 })
        .text(om.pedidoNumero || '—', 42 + 2*W/3, y + 14, { width: W/3 - 8 });
      y += idH + 6;

      // ===== STATUS / LABORATÓRIO / DATAS =====
      const stH = 38;
      doc.rect(36, y, W, stH).stroke('#999');
      const cw = W / 4;
      const STATUS_LABEL = {
        aguardando: 'Aguardando envio', laboratorio: 'No laboratório',
        pronto: 'Pronto', entregue: 'Entregue', cancelada: 'Cancelada'
      };
      doc.fontSize(8).font('Helvetica').fillColor('#666')
        .text('Status', 42, y + 4)
        .text('Laboratório', 42 + cw, y + 4)
        .text('Envio ao lab', 42 + 2*cw, y + 4)
        .text('Previsão entrega', 42 + 3*cw, y + 4);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000')
        .text(STATUS_LABEL[om.status] || om.status || '—', 42, y + 16, { width: cw - 8 })
        .text(om.laboratorio || '—', 42 + cw, y + 16, { width: cw - 8 })
        .text(fmtData(om.dataEnvioLab), 42 + 2*cw, y + 16, { width: cw - 8 })
        .text(fmtData(om.dataPrevisaoEntrega), 42 + 3*cw, y + 16, { width: cw - 8 });
      y += stH + 6;

      // ===== CLIENTE =====
      doc.rect(36, y, W, 14).fill('#e8e8e8').stroke('#000');
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text('CLIENTE', 42, y + 3);
      y += 14;
      const cliH = 36;
      doc.rect(36, y, W, cliH).stroke('#999');
      doc.fontSize(8).font('Helvetica').fillColor('#666')
        .text('Nome', 42, y + 3)
        .text('CPF/CNPJ', 42 + W/2, y + 3)
        .text('Telefone', 42, y + 18)
        .text('E-mail', 42 + W/2, y + 18);
      doc.fontSize(10).font('Helvetica').fillColor('#000')
        .text(om.clienteNome || '—', 42 + 38, y + 3, { width: W/2 - 50 })
        .text(fmtDoc(om.clienteCpfCnpj), 42 + W/2 + 56, y + 3, { width: W/2 - 70 })
        .text(om.clienteTelefone || '—', 42 + 50, y + 18, { width: W/2 - 60 })
        .text(om.clienteEmail || '—', 42 + W/2 + 36, y + 18, { width: W/2 - 50 });
      y += cliH + 8;

      // ===== ITENS (lentes + armações) =====
      const lentes = (om.itens || []).filter(i => i.categoria === 'lente');
      const armacoes = (om.itens || []).filter(i => i.categoria === 'armacao');

      if (lentes.length) {
        doc.rect(36, y, W, 14).fill('#e8e8e8').stroke('#000');
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text('LENTES E RECEITA', 42, y + 3);
        y += 14;
        for (const it of lentes) {
          y = renderLente(doc, 36, y, W, it);
          y += 6;
        }
      }

      if (armacoes.length) {
        if (y > doc.page.height - 200) { doc.addPage(); y = 36; }
        doc.rect(36, y, W, 14).fill('#e8e8e8').stroke('#000');
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text('ARMAÇÃO', 42, y + 3);
        y += 14;
        for (const it of armacoes) {
          y = renderArmacao(doc, 36, y, W, it);
          y += 6;
        }
      }

      // ===== OBSERVAÇÕES =====
      if (om.observacoes) {
        if (y > doc.page.height - 120) { doc.addPage(); y = 36; }
        doc.rect(36, y, W, 14).fill('#e8e8e8').stroke('#000');
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text('OBSERVAÇÕES', 42, y + 3);
        y += 14;
        const obsH = Math.max(40, Math.min(120, 20 + om.observacoes.length / 4));
        doc.rect(36, y, W, obsH).stroke('#999');
        doc.fontSize(10).font('Helvetica').fillColor('#000')
          .text(om.observacoes, 42, y + 4, { width: W - 12 });
        y += obsH + 8;
      }

      // ===== ASSINATURAS =====
      if (y > doc.page.height - 90) { doc.addPage(); y = 36; }
      y = doc.page.height - 90;
      doc.fontSize(9).font('Helvetica').fillColor('#000');
      const colW = (W - 20) / 2;
      doc.moveTo(36, y).lineTo(36 + colW, y).stroke('#000');
      doc.text('Conferido pelo laboratório', 36, y + 4, { width: colW, align: 'center' });
      doc.moveTo(36 + colW + 20, y).lineTo(36 + W, y).stroke('#000');
      doc.text('Conferido pela ótica', 36 + colW + 20, y + 4, { width: colW, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function renderLente(doc, x, y, w, it) {
  const trats = (it.tratamentos || '').split(',').filter(Boolean).join(', ') || '—';
  const olhoLabel = { OD: 'Olho Direito (OD)', OE: 'Olho Esquerdo (OE)', '': 'Par (OD + OE)', null: 'Par (OD + OE)' };
  const olho = olhoLabel[it.olho || ''] || it.olho || 'Par';
  // Bloco descritivo
  const descH = 38;
  doc.rect(x, y, w, descH).stroke('#999');
  doc.fontSize(8).font('Helvetica').fillColor('#666')
    .text('Lente', x + 6, y + 3)
    .text('Tipo', x + w * 0.42, y + 3)
    .text('Material', x + w * 0.6, y + 3)
    .text('Índice', x + w * 0.78, y + 3)
    .text('Olho', x + w * 0.92, y + 3);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#000')
    .text(it.descricao || '—', x + 6, y + 14, { width: w * 0.40, height: descH - 16 })
    .text(it.lenteTipo || '—', x + w * 0.42, y + 14, { width: w * 0.16 })
    .text(it.lenteMaterial || '—', x + w * 0.6, y + 14, { width: w * 0.16 })
    .text(it.indiceRefracao || '—', x + w * 0.78, y + 14, { width: w * 0.12 })
    .text(it.olho || 'Par', x + w * 0.92, y + 14, { width: w * 0.07 });
  doc.fontSize(8).font('Helvetica').fillColor('#444')
    .text('Tratamentos: ' + trats, x + 6, y + 26, { width: w - 12 });
  y += descH;

  // Receita (só se anexada)
  if (it.receitaId) {
    const recH = 56;
    doc.rect(x, y, w, recH).stroke('#999');
    doc.fontSize(8).font('Helvetica').fillColor('#666')
      .text(`Receita de ${fmtData(it.dataReceita)}${it.medico ? ' · ' + it.medico : ''}${it.crm ? ' (' + it.crm + ')' : ''} · ${olho}`,
        x + 6, y + 3, { width: w - 12 });
    // Cabeçalhos
    const cols = ['', 'Esférico', 'Cilíndrico', 'Eixo', 'Adição', 'DNP', 'Altura'];
    const cw = (w - 30) / 6;
    doc.fontSize(7).font('Helvetica').fillColor('#666');
    cols.forEach((label, i) => {
      doc.text(label, x + 30 + (i - 1) * cw, y + 16, { width: cw - 4, align: i === 0 ? 'right' : 'center' });
    });
    // Linhas OD / OE
    function linha(label, esf, cil, eixo, add, dnp, alt, yy) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#000').text(label, x + 6, yy, { width: 22 });
      doc.fontSize(9).font('Helvetica').fillColor('#000');
      [fmtN(esf), fmtN(cil), fmtN(eixo, { int: true, suffix: '°' }), fmtN(add), fmtN(dnp), fmtN(alt)].forEach((v, i) => {
        doc.text(v, x + 30 + i * cw, yy, { width: cw - 4, align: 'center' });
      });
    }
    linha('OD', it.od_esferico, it.od_cilindrico, it.od_eixo, it.od_adicao, it.dnp_od, it.alturaOptica, y + 28);
    linha('OE', it.oe_esferico, it.oe_cilindrico, it.oe_eixo, it.oe_adicao, it.dnp_oe, it.alturaOptica, y + 42);
    y += recH;
    if (it.receitaObservacoes || it.itemObservacoes) {
      const obs = [it.receitaObservacoes, it.itemObservacoes].filter(Boolean).join(' · ');
      const oh = Math.max(20, Math.min(60, 16 + obs.length / 3));
      doc.rect(x, y, w, oh).stroke('#999');
      doc.fontSize(7).font('Helvetica').fillColor('#666').text('Observações da receita', x + 6, y + 3);
      doc.fontSize(9).font('Helvetica').fillColor('#000').text(obs, x + 6, y + 13, { width: w - 12, height: oh - 16 });
      y += oh;
    }
  } else {
    const aH = 22;
    doc.rect(x, y, w, aH).stroke('#999');
    doc.fontSize(9).font('Helvetica-Oblique').fillColor('#a00')
      .text('⚠ Nenhuma receita anexada a esta lente. Anexar antes de enviar ao laboratório.', x + 6, y + 6, { width: w - 12 });
    y += aH;
  }
  return y;
}

function renderArmacao(doc, x, y, w, it) {
  const h = 32;
  doc.rect(x, y, w, h).stroke('#999');
  doc.fontSize(8).font('Helvetica').fillColor('#666')
    .text('Descrição', x + 6, y + 3)
    .text('Marca', x + w * 0.40, y + 3)
    .text('Modelo', x + w * 0.55, y + 3)
    .text('Cor / Material', x + w * 0.72, y + 3)
    .text('Medidas', x + w * 0.88, y + 3);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#000')
    .text(it.descricao || '—', x + 6, y + 14, { width: w * 0.38 });
  doc.fontSize(9).font('Helvetica').fillColor('#000')
    .text(it.armacaoMarca || '—', x + w * 0.40, y + 14, { width: w * 0.13 })
    .text(it.armacaoModelo || '—', x + w * 0.55, y + 14, { width: w * 0.16 })
    .text((it.armacaoCor || '—') + (it.armacaoMaterial ? ' / ' + it.armacaoMaterial : ''), x + w * 0.72, y + 14, { width: w * 0.15 });
  const med = [it.aroMm, it.ponteMm, it.hasteMm].some(Boolean) ? `${it.aroMm||'?'}□${it.ponteMm||'?'} ${it.hasteMm||'?'}` : '—';
  doc.fontSize(9).font('Helvetica').fillColor('#000')
    .text(med, x + w * 0.88, y + 14, { width: w * 0.11 });
  return y + h;
}

module.exports = { gerarOrdemMontagemPdf };
