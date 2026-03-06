/**
 * danfse-pdf.js — Gera PDF da DANFSE a partir do XML da NFSe
 */

const PDFDocument = require('pdfkit');
const zlib = require('zlib');

/**
 * Extrai valor de uma tag XML (busca simples)
 */
function tag(xml, name) {
  const re = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

/**
 * Formata CPF/CNPJ
 */
function formatDoc(doc) {
  if (!doc) return '';
  doc = doc.replace(/\D/g, '');
  if (doc.length <= 11) return doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return doc.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

/**
 * Formata valor monetario
 */
function formatMoney(val) {
  const n = parseFloat(val) || 0;
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Formata data ISO para dd/mm/aaaa
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = dateStr.substring(0, 10);
  const parts = d.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return d;
}

/**
 * Gera PDF da DANFSE a partir do XML descompactado
 * @param {string} xml - XML da NFSe
 * @returns {Promise<Buffer>} PDF como Buffer
 */
function gerarDanfsePdf(xml) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width - 80; // margem 40 de cada lado

      // Dados do XML
      const nNFSe = tag(xml, 'nNFSe');
      const dhProc = tag(xml, 'dhProc');
      const xLocEmi = tag(xml, 'xLocEmi');
      const chaveAcesso = tag(xml, 'Id') || tag(xml, 'chNFSe');

      // Emitente
      const emit = tag(xml, 'emit');
      const emitCnpj = tag(emit, 'CNPJ');
      const emitIM = tag(emit, 'IM');
      const emitNome = tag(emit, 'xNome');
      const emitEnder = tag(emit, 'enderNac');
      const emitLgr = tag(emitEnder, 'xLgr');
      const emitNro = tag(emitEnder, 'nro');
      const emitCpl = tag(emitEnder, 'xCpl');
      const emitBairro = tag(emitEnder, 'xBairro');
      const emitCep = tag(emitEnder, 'CEP');

      // Tomador
      const toma = tag(xml, 'toma');
      const tomaCnpj = tag(toma, 'CNPJ') || tag(toma, 'CPF');
      const tomaNome = tag(toma, 'xNome');
      const tomaEnder = tag(toma, 'enderNac');
      const tomaLgr = tag(tomaEnder, 'xLgr');
      const tomaNro = tag(tomaEnder, 'nro');
      const tomaCpl = tag(tomaEnder, 'xCpl');
      const tomaBairro = tag(tomaEnder, 'xBairro');
      const tomaCep = tag(tomaEnder, 'CEP');
      const tomaEmail = tag(toma, 'email');

      // Servico
      const valores = tag(xml, 'valores');
      const vServ = tag(valores, 'vServ') || tag(valores, 'vServPrest');
      const vLiq = tag(valores, 'vLiq') || vServ;
      const vISS = tag(valores, 'vISS');
      const vBCISS = tag(valores, 'vBCISS') || tag(valores, 'vBC');
      const pAliq = tag(valores, 'pAliq');
      const xDescServ = tag(xml, 'xDescServ');
      const xTribNac = tag(xml, 'xTribNac');
      const xTribMun = tag(xml, 'xTribMun');
      const competencia = tag(xml, 'cmpNFSe') || dhProc.substring(0, 7);

      // =============== CABEÇALHO ===============
      doc.rect(40, 40, pageWidth, 60).stroke('#333');
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#1a1a2e')
        .text('DANFSE', 50, 52, { width: pageWidth - 20, align: 'center' });
      doc.fontSize(8).font('Helvetica').fillColor('#666')
        .text('Documento Auxiliar da Nota Fiscal de Servico Eletronica', 50, 72, { width: pageWidth - 20, align: 'center' });

      let y = 115;

      // =============== NÚMERO E DATA ===============
      doc.rect(40, y, pageWidth, 35).stroke('#ccc');
      doc.fontSize(8).font('Helvetica').fillColor('#666').text('Numero da NFSe', 50, y + 3);
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text(nNFSe, 50, y + 14);

      doc.fontSize(8).font('Helvetica').fillColor('#666').text('Data/Hora de Emissao', 200, y + 3);
      doc.fontSize(10).font('Helvetica').fillColor('#000').text(formatDate(dhProc) + ' ' + (dhProc.substring(11, 19) || ''), 200, y + 14);

      doc.fontSize(8).font('Helvetica').fillColor('#666').text('Competencia', 380, y + 3);
      doc.fontSize(10).font('Helvetica').fillColor('#000').text(competencia, 380, y + 14);

      y += 45;

      // =============== CHAVE DE ACESSO ===============
      if (chaveAcesso) {
        doc.rect(40, y, pageWidth, 28).stroke('#ccc');
        doc.fontSize(8).font('Helvetica').fillColor('#666').text('Chave de Acesso', 50, y + 3);
        doc.fontSize(8).font('Courier').fillColor('#000').text(chaveAcesso, 50, y + 14);
        y += 38;
      }

      // =============== PRESTADOR ===============
      doc.rect(40, y, pageWidth, 55).stroke('#ccc');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1a1a2e').text('PRESTADOR DE SERVICOS', 50, y + 3);
      doc.fontSize(9).font('Helvetica').fillColor('#000');
      doc.text(`${emitNome}`, 50, y + 15);
      doc.text(`CNPJ: ${formatDoc(emitCnpj)}    IM: ${emitIM}`, 50, y + 27);
      const emitEnd = [emitLgr, emitNro, emitCpl, emitBairro].filter(Boolean).join(', ');
      doc.text(`${emitEnd}${emitCep ? '  CEP: ' + emitCep : ''}  -  ${xLocEmi}`, 50, y + 39);
      y += 65;

      // =============== TOMADOR ===============
      doc.rect(40, y, pageWidth, 55).stroke('#ccc');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1a1a2e').text('TOMADOR DE SERVICOS', 50, y + 3);
      doc.fontSize(9).font('Helvetica').fillColor('#000');
      doc.text(`${tomaNome}`, 50, y + 15);
      doc.text(`${tomaCnpj.length <= 11 ? 'CPF' : 'CNPJ'}: ${formatDoc(tomaCnpj)}${tomaEmail ? '    Email: ' + tomaEmail : ''}`, 50, y + 27);
      const tomaEnd = [tomaLgr, tomaNro, tomaCpl, tomaBairro].filter(Boolean).join(', ');
      doc.text(`${tomaEnd}${tomaCep ? '  CEP: ' + tomaCep : ''}`, 50, y + 39);
      y += 65;

      // =============== DISCRIMINAÇÃO DO SERVICO ===============
      doc.rect(40, y, pageWidth, 80).stroke('#ccc');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1a1a2e').text('DISCRIMINACAO DO SERVICO', 50, y + 3);
      doc.fontSize(9).font('Helvetica').fillColor('#000');
      const desc = xDescServ || xTribNac || xTribMun || 'Servico';
      doc.text(desc, 50, y + 16, { width: pageWidth - 20, height: 58 });
      y += 90;

      // =============== TRIBULAÇÃO ===============
      doc.rect(40, y, pageWidth, 30).stroke('#ccc');
      doc.fontSize(8).font('Helvetica').fillColor('#666').text('Tributacao Nacional', 50, y + 3);
      doc.fontSize(8).font('Helvetica').fillColor('#000').text(xTribNac || '-', 50, y + 14, { width: pageWidth - 20 });
      y += 40;

      // =============== VALORES ===============
      const colW = pageWidth / 5;
      doc.rect(40, y, pageWidth, 40).stroke('#ccc');

      const valLabels = ['Valor dos Servicos', 'Base de Calculo', 'Aliquota ISS', 'Valor do ISS', 'Valor Liquido'];
      const valValues = [formatMoney(vServ), formatMoney(vBCISS), (pAliq ? pAliq + '%' : '-'), formatMoney(vISS), formatMoney(vLiq)];

      for (let i = 0; i < 5; i++) {
        const x = 40 + (i * colW);
        if (i > 0) doc.moveTo(x, y).lineTo(x, y + 40).stroke('#ccc');
        doc.fontSize(7).font('Helvetica').fillColor('#666').text(valLabels[i], x + 5, y + 3, { width: colW - 10 });
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text(valValues[i], x + 5, y + 17, { width: colW - 10 });
      }

      y += 55;

      // =============== RODAPÉ ===============
      doc.fontSize(7).font('Helvetica').fillColor('#999')
        .text('Documento gerado automaticamente pelo sistema. Valide em www.nfse.gov.br', 40, y, { width: pageWidth, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Gera PDF da DANFSE a partir do XML compactado em GZip+Base64 (formato SEFIN)
 */
async function gerarDanfseDeGzipB64(gzipB64) {
  const gzipBuf = Buffer.from(gzipB64, 'base64');
  const xml = zlib.gunzipSync(gzipBuf).toString('utf-8');
  return gerarDanfsePdf(xml);
}

module.exports = { gerarDanfsePdf, gerarDanfseDeGzipB64 };
