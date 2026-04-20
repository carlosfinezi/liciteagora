/**
 * danfse-pdf.js — Gera PDF da DANFSE no layout oficial SEFIN
 */

const PDFDocument = require('pdfkit');
const zlib = require('zlib');

/**
 * NFSE-M04: extrator tolerante a namespaces, atributos, whitespace,
 * CDATA e tags auto-fechadas. Sem nova dependência — regex melhorada,
 * escape de nome e detecção de self-close.
 *
 * Cobre: <name>x</name>, <ns:name>x</ns:name>, <name attr="v">x</name>,
 *        <name/>, <ns:name/>, <![CDATA[x]]>.
 */
function tag(xml, name) {
  if (!xml || !name) return '';
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const np = '(?:[A-Za-z_][\\w.-]*:)?' + esc; // prefixo de namespace opcional
  // Self-closed: <ns:name ... /> → vazio
  const selfCloseRe = new RegExp('<' + np + '(?:\\s[^>]*)?/>');
  if (selfCloseRe.test(xml)) return '';
  // Par aberto/fechado, tolerando atributos e whitespace interno
  const re = new RegExp('<' + np + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + np + '>');
  const m = xml.match(re);
  if (!m) return '';
  let inner = m[1];
  // Desempacota CDATA se presente
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) inner = cdata[1];
  return inner.trim();
}

function formatDoc(doc) {
  if (!doc) return '';
  doc = doc.replace(/\D/g, '');
  if (doc.length <= 11) return doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return doc.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

function formatCep(cep) {
  if (!cep) return '';
  cep = cep.replace(/\D/g, '');
  if (cep.length === 8) return cep.replace(/(\d{5})(\d{3})/, '$1-$2');
  return cep;
}

function formatMoney(val) {
  const n = parseFloat(val) || 0;
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = dateStr.substring(0, 10);
  const parts = d.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return d;
}

function formatDateTime(dateStr) {
  if (!dateStr) return '';
  return formatDate(dateStr) + ' ' + (dateStr.substring(11, 19) || '');
}

// Helpers de desenho
function sectionHeader(doc, x, y, w, label) {
  doc.save();
  doc.rect(x, y, w, 14).fill('#e8e8e8').stroke('#000');
  doc.fontSize(7).font('Helvetica-Bold').fillColor('#000').text(label, x + 3, y + 3, { width: w - 6 });
  doc.restore();
  return y + 14;
}

function cell(doc, x, y, w, h, label, value, opts = {}) {
  doc.save();
  doc.rect(x, y, w, h).stroke('#999');
  if (label) {
    doc.fontSize(5.5).font('Helvetica').fillColor('#666').text(label, x + 2, y + 1.5, { width: w - 4 });
  }
  if (value) {
    const valY = label ? y + 8 : y + 2;
    const fontSize = opts.fontSize || 7;
    const font = opts.bold ? 'Helvetica-Bold' : 'Helvetica';
    doc.fontSize(fontSize).font(font).fillColor('#000').text(value || '-', x + 2, valY, { width: w - 4, height: h - valY + y - 2 });
  }
  doc.restore();
}

function gerarDanfsePdf(xml) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 25 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const M = 25; // margem
      const W = doc.page.width - M * 2; // largura útil
      let y = M;

      // ===== Extrair dados do XML =====
      const nNFSe = tag(xml, 'nNFSe');
      const nDPS = tag(xml, 'nDPS');
      const serDPS = tag(xml, 'serDPS') || tag(xml, 'serie');
      const dhProc = tag(xml, 'dhProc');
      const dhEmi = tag(xml, 'dhEmi') || dhProc;
      const chaveAcesso = tag(xml, 'Id') || tag(xml, 'chNFSe');
      const competencia = tag(xml, 'cmpNFSe') || (dhProc ? dhProc.substring(0, 7) : '');
      const xLocEmi = tag(xml, 'xLocEmi');

      // Emitente
      const emit = tag(xml, 'emit');
      const emitCnpj = tag(emit, 'CNPJ');
      const emitIM = tag(emit, 'IM');
      const emitFone = tag(emit, 'fone');
      const emitNome = tag(emit, 'xNome');
      const emitEmail = tag(emit, 'email');
      const emitEnder = tag(emit, 'enderNac');
      const emitLgr = tag(emitEnder, 'xLgr');
      const emitNro = tag(emitEnder, 'nro');
      const emitCpl = tag(emitEnder, 'xCpl');
      const emitBairro = tag(emitEnder, 'xBairro');
      const emitCep = tag(emitEnder, 'CEP');
      const emitMun = tag(emitEnder, 'xMun') || xLocEmi;
      const emitUF = tag(emitEnder, 'UF');
      const simplesNac = tag(xml, 'opSN') || tag(emit, 'opSN');
      const regApTrib = tag(xml, 'regApTrib') || tag(emit, 'regApTrib');

      // Tomador
      const toma = tag(xml, 'toma');
      const tomaCnpj = tag(toma, 'CNPJ') || tag(toma, 'CPF');
      const tomaIM = tag(toma, 'IM');
      const tomaFone = tag(toma, 'fone');
      const tomaNome = tag(toma, 'xNome');
      const tomaEmail = tag(toma, 'email');
      const tomaEnder = tag(toma, 'enderNac');
      const tomaLgr = tag(tomaEnder, 'xLgr');
      const tomaNro = tag(tomaEnder, 'nro');
      const tomaCpl = tag(tomaEnder, 'xCpl');
      const tomaBairro = tag(tomaEnder, 'xBairro');
      const tomaCep = tag(tomaEnder, 'CEP');
      const tomaMun = tag(tomaEnder, 'xMun');
      const tomaUF = tag(tomaEnder, 'UF');

      // Serviço
      const xDescServ = tag(xml, 'xDescServ');
      const xTribNac = tag(xml, 'xTribNac');
      const cTribNac = tag(xml, 'cTribNac');
      const xTribMun = tag(xml, 'xTribMun');
      const cTribMun = tag(xml, 'cTribMun');
      const xLocPrest = tag(xml, 'xLocPrest') || xLocEmi;
      const xPaisPrest = tag(xml, 'xPaisPrest') || '';

      // Valores
      const valores = tag(xml, 'valores');
      const vServ = tag(valores, 'vServ') || tag(valores, 'vServPrest') || '0';
      const vLiq = tag(valores, 'vLiq') || vServ;
      const vISS = tag(valores, 'vISS') || '0';
      const vBCISS = tag(valores, 'vBCISS') || tag(valores, 'vBC') || '0';
      const pAliq = tag(valores, 'pAliq') || '';
      const vDescIncond = tag(valores, 'vDescIncond') || '';
      const vDescCond = tag(valores, 'vDescCond') || '';
      const vDedRed = tag(valores, 'vDedRed') || '';
      const vCalcBM = tag(valores, 'vCalcBM') || '';
      const retISSQN = tag(valores, 'retISSQN') || tag(xml, 'retISSQN') || '';

      // Tributação
      const tpTrib = tag(xml, 'tpTrib') || '';
      const munInc = tag(xml, 'xMunInc') || xLocEmi;
      const regEspTrib = tag(xml, 'regEspTrib') || '';
      const tpImunidade = tag(xml, 'tpImunidade') || '';
      const tpSusp = tag(xml, 'tpSusp') || '';
      const nProcesso = tag(xml, 'nProcesso') || '';
      const benMun = tag(xml, 'benMun') || '';

      // Tributação federal
      const vIRRF = tag(valores, 'trib') ? tag(tag(valores, 'trib'), 'vIRRF') : '';
      const vContPrev = tag(valores, 'trib') ? tag(tag(valores, 'trib'), 'vCSLL') : '';
      const vContSoc = tag(valores, 'trib') ? tag(tag(valores, 'trib'), 'vCOFINS') : '';
      const vPIS = tag(valores, 'trib') ? tag(tag(valores, 'trib'), 'vPIS') : '';

      // Tributos aproximados
      const tribFed = tag(xml, 'totTribFed') || '';
      const tribEst = tag(xml, 'totTribEst') || '';
      const tribMun = tag(xml, 'totTribMun') || '';

      // Info complementar
      const infCpl = tag(xml, 'xInfCpl') || '';

      const simplesLabels = { '1': 'Simples Nacional na Data de Competência', '2': 'Não optante', '3': 'MEI' };
      const regApLabels = { '1': 'Regime de apuração dos tributos federais e municipal pelo Simples Nacional', '2': 'Regime fixo', '3': 'Regime normal' };
      const tribLabels = { '1': 'ISSQN', '2': 'ISSQN fixo', '3': 'Imune', '4': 'Isenta', '5': 'Não tributável', '6': 'Exportação' };
      const retLabels = { '1': 'Não Retido', '2': 'Retido pelo Tomador', '3': 'Retido pelo Intermediário' };
      const regEspLabels = { '0': 'Nenhum', '1': 'Cooperativa', '2': 'Estimativa', '3': 'Sociedade de Profissionais', '4': 'Micro Empreendedor Individual' };

      // ===== CABEÇALHO =====
      const headerH = 50;
      doc.rect(M, y, W, headerH).stroke('#000');
      // Logo NFSe (texto)
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#006633').text('NFSe', M + 5, y + 8);
      doc.fontSize(5).font('Helvetica').fillColor('#666').text('Nota Fiscal de\nServiço eletrônica', M + 5, y + 26);
      // Centro
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('DANFSe v1.0', M + 120, y + 10, { width: W - 240, align: 'center' });
      doc.fontSize(8).font('Helvetica').fillColor('#000').text('Documento Auxiliar da NFS-e', M + 120, y + 26, { width: W - 240, align: 'center' });
      // Direita - prefeitura
      const prefX = M + W - 170;
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#000').text('PREFEITURA MUNICIPAL DE', prefX, y + 5, { width: 165, align: 'right' });
      const munNome = (emitMun || '').toUpperCase();
      doc.fontSize(8).font('Helvetica-Bold').text(munNome, prefX, y + 14, { width: 165, align: 'right' });
      doc.fontSize(5.5).font('Helvetica').fillColor('#666').text('Secretaria Municipal de Gestão Fazendária', prefX, y + 26, { width: 165, align: 'right' });
      y += headerH;

      // ===== CHAVE DE ACESSO =====
      cell(doc, M, y, W, 17, 'Chave de Acesso da NFS-e', chaveAcesso, { fontSize: 6.5 });
      y += 17;

      // ===== NÚMERO, COMPETÊNCIA, DATA =====
      const row1W = [W * 0.2, W * 0.25, W * 0.55];
      cell(doc, M, y, row1W[0], 22, 'Número da NFS-e', nNFSe, { bold: true });
      cell(doc, M + row1W[0], y, row1W[1], 22, 'Competência da NFS-e', formatDate(competencia + '-01') || competencia);
      cell(doc, M + row1W[0] + row1W[1], y, row1W[2], 22, 'Data e Hora da emissão da NFS-e', formatDateTime(dhProc));
      y += 22;

      // Número DPS, Série, Data DPS
      cell(doc, M, y, row1W[0], 22, 'Número da DPS', nDPS);
      cell(doc, M + row1W[0], y, row1W[1], 22, 'Série da DPS', serDPS);
      cell(doc, M + row1W[0] + row1W[1], y, row1W[2], 22, 'Data e Hora da emissão da DPS', formatDateTime(dhEmi));
      y += 22;

      // ===== EMITENTE =====
      y = sectionHeader(doc, M, y, W, 'EMITENTE DA NFS-e');
      const emitCol = [W * 0.30, W * 0.25, W * 0.25, W * 0.20];
      cell(doc, M, y, emitCol[0], 22, 'Prestador do Serviço', '');
      cell(doc, M + emitCol[0], y, emitCol[1], 22, 'CNPJ / CPF / NIF', formatDoc(emitCnpj));
      cell(doc, M + emitCol[0] + emitCol[1], y, emitCol[2], 22, 'Inscrição Municipal', emitIM || '-');
      cell(doc, M + emitCol[0] + emitCol[1] + emitCol[2], y, emitCol[3], 22, 'Telefone', emitFone ? '(' + emitFone.substring(0, 2) + ') ' + emitFone.substring(2) : '-');
      y += 22;

      cell(doc, M, y, W * 0.55, 20, 'Nome / Nome Empresarial', emitNome);
      cell(doc, M + W * 0.55, y, W * 0.45, 20, 'E-mail', emitEmail || '-');
      y += 20;

      const emitEndStr = [emitLgr, emitNro, emitCpl, emitBairro].filter(Boolean).join(', ');
      cell(doc, M, y, W * 0.55, 20, 'Endereço', emitEndStr);
      cell(doc, M + W * 0.55, y, W * 0.30, 20, 'Município', (emitMun || '') + (emitUF ? ' - ' + emitUF : ''));
      cell(doc, M + W * 0.85, y, W * 0.15, 20, 'CEP', formatCep(emitCep));
      y += 20;

      const simplesLabel = simplesNac ? (simplesLabels[simplesNac] || 'Optante código ' + simplesNac) : '-';
      cell(doc, M, y, W * 0.45, 20, 'Simples Nacional na Data de Competência', simplesLabel, { fontSize: 6 });
      const regLabel = regApTrib ? (regApLabels[regApTrib] || 'Código ' + regApTrib) : '-';
      cell(doc, M + W * 0.45, y, W * 0.55, 20, 'Regime de Apuração Tributária pelo SN', regLabel, { fontSize: 6 });
      y += 20;

      // ===== TOMADOR =====
      y = sectionHeader(doc, M, y, W, 'TOMADOR DO SERVIÇO');
      cell(doc, M, y, W * 0.30, 22, 'Tomador do Serviço', '');
      cell(doc, M + W * 0.30, y, W * 0.25, 22, 'CNPJ / CPF / NIF', formatDoc(tomaCnpj));
      cell(doc, M + W * 0.55, y, W * 0.25, 22, 'Inscrição Municipal', tomaIM || '-');
      cell(doc, M + W * 0.80, y, W * 0.20, 22, 'Telefone', tomaFone || '-');
      y += 22;

      cell(doc, M, y, W * 0.55, 20, 'Nome Empresarial', tomaNome);
      cell(doc, M + W * 0.55, y, W * 0.45, 20, 'E-mail', tomaEmail || '-');
      y += 20;

      const tomaEndStr = [tomaLgr, tomaNro, tomaCpl, tomaBairro].filter(Boolean).join(', ');
      cell(doc, M, y, W * 0.55, 20, 'Endereço', tomaEndStr || '-');
      cell(doc, M + W * 0.55, y, W * 0.30, 20, 'Município', (tomaMun || '') + (tomaUF ? ' - ' + tomaUF : ''));
      cell(doc, M + W * 0.85, y, W * 0.15, 20, 'CEP', formatCep(tomaCep));
      y += 20;

      // Intermediário
      doc.rect(M, y, W, 12).stroke('#999');
      doc.fontSize(5.5).font('Helvetica').fillColor('#666').text('INTERMEDIÁRIO DO SERVIÇO NÃO IDENTIFICADO NA NFS-e', M + 3, y + 3, { width: W - 6, align: 'center' });
      y += 12;

      // ===== SERVIÇO PRESTADO =====
      y = sectionHeader(doc, M, y, W, 'SERVIÇO PRESTADO');
      const tribNacLabel = cTribNac ? cTribNac + ' - ' + (xTribNac || '') : (xTribNac || '-');
      const tribMunLabel = cTribMun ? cTribMun + ' - ' + (xTribMun || '') : (xTribMun || '-');
      cell(doc, M, y, W * 0.30, 28, 'Código de Tributação Nacional', tribNacLabel, { fontSize: 6 });
      cell(doc, M + W * 0.30, y, W * 0.30, 28, 'Código de Tributação Municipal', tribMunLabel, { fontSize: 6 });
      cell(doc, M + W * 0.60, y, W * 0.25, 28, 'Local da Prestação', xLocPrest || '-', { fontSize: 6 });
      cell(doc, M + W * 0.85, y, W * 0.15, 28, 'País da Prestação', xPaisPrest || '-', { fontSize: 6 });
      y += 28;

      // Descrição do serviço
      const descH = Math.max(25, Math.min(60, 15 + (xDescServ || '').length / 4));
      cell(doc, M, y, W, descH, 'Descrição do Serviço', xDescServ || '-', { fontSize: 7 });
      y += descH;

      // ===== TRIBUTAÇÃO MUNICIPAL =====
      y = sectionHeader(doc, M, y, W, 'TRIBUTAÇÃO MUNICIPAL');
      const tribLabel = tpTrib ? (tribLabels[tpTrib] || tpTrib) : '-';
      cell(doc, M, y, W * 0.25, 22, 'Tributação do ISSQN\nOperação Tributável', tribLabel + '\n-', { fontSize: 6 });
      cell(doc, M + W * 0.25, y, W * 0.25, 22, 'País Resultado da Prestação do Serviço', '-', { fontSize: 6 });
      cell(doc, M + W * 0.50, y, W * 0.25, 22, 'Município de Incidência do ISSQN', munInc, { fontSize: 6 });
      cell(doc, M + W * 0.75, y, W * 0.25, 22, 'Regime Especial de Tributação', regEspLabels[regEspTrib] || regEspTrib || 'Nenhum', { fontSize: 6 });
      y += 22;

      cell(doc, M, y, W * 0.25, 20, 'Tipo de Imunidade', tpImunidade || '-');
      cell(doc, M + W * 0.25, y, W * 0.25, 20, 'Suspensão da Exigibilidade do ISSQN', tpSusp || 'Não');
      cell(doc, M + W * 0.50, y, W * 0.25, 20, 'Número Processo Suspensão', nProcesso || '-');
      cell(doc, M + W * 0.75, y, W * 0.25, 20, 'Benefício Municipal', benMun || '-');
      y += 20;

      cell(doc, M, y, W * 0.25, 20, 'Valor do Serviço', formatMoney(vServ), { bold: true });
      cell(doc, M + W * 0.25, y, W * 0.25, 20, 'Desconto Incondicionado', vDescIncond ? formatMoney(vDescIncond) : '-');
      cell(doc, M + W * 0.50, y, W * 0.25, 20, 'Total Deduções/Reduções', vDedRed ? formatMoney(vDedRed) : '-');
      cell(doc, M + W * 0.75, y, W * 0.25, 20, 'Cálculo do BM', vCalcBM ? formatMoney(vCalcBM) : '-');
      y += 20;

      const retLabel = retISSQN ? (retLabels[retISSQN] || retISSQN) : 'Não Retido';
      cell(doc, M, y, W * 0.25, 20, 'BC ISSQN', formatMoney(vBCISS));
      cell(doc, M + W * 0.25, y, W * 0.25, 20, 'Alíquota Aplicada', pAliq ? pAliq + '%' : '-');
      cell(doc, M + W * 0.50, y, W * 0.25, 20, 'Retenção do ISSQN', retLabel);
      cell(doc, M + W * 0.75, y, W * 0.25, 20, 'ISSQN Apurado', formatMoney(vISS));
      y += 20;

      // ===== TRIBUTAÇÃO FEDERAL =====
      y = sectionHeader(doc, M, y, W, 'TRIBUTAÇÃO FEDERAL');
      cell(doc, M, y, W * 0.25, 20, 'IRRF', vIRRF ? formatMoney(vIRRF) : '-');
      cell(doc, M + W * 0.25, y, W * 0.25, 20, 'Contribuição Previdenciária - Retida', vContPrev ? formatMoney(vContPrev) : '-');
      cell(doc, M + W * 0.50, y, W * 0.25, 20, 'Contribuições Sociais - Retidas', vContSoc ? formatMoney(vContSoc) : '-');
      cell(doc, M + W * 0.75, y, W * 0.25, 20, 'Descrição Contrib. Sociais - Retidas', '-');
      y += 20;

      cell(doc, M, y, W * 0.25, 20, 'PIS - Débito Apuração Própria', vPIS ? formatMoney(vPIS) : '-');
      cell(doc, M + W * 0.25, y, W * 0.25, 20, 'COFINS - Débito Apuração Própria', '-');
      cell(doc, M + W * 0.50, y, W * 0.50, 20, '', '');
      y += 20;

      // ===== VALOR TOTAL =====
      y = sectionHeader(doc, M, y, W, 'VALOR TOTAL DA NFS-E');
      cell(doc, M, y, W * 0.25, 20, 'Valor do Serviço', formatMoney(vServ), { bold: true });
      cell(doc, M + W * 0.25, y, W * 0.25, 20, 'Desconto Condicionado', vDescCond ? formatMoney(vDescCond) : '-');
      cell(doc, M + W * 0.50, y, W * 0.25, 20, 'Desconto Incondicionado', vDescIncond ? formatMoney(vDescIncond) : '-');
      cell(doc, M + W * 0.75, y, W * 0.25, 20, 'ISSQN Retido', retISSQN === '2' || retISSQN === '3' ? formatMoney(vISS) : '-');
      y += 20;

      cell(doc, M, y, W * 0.25, 20, 'Total das Retenções Federais', '-');
      cell(doc, M + W * 0.25, y, W * 0.25, 20, 'PIS/COFINS - Débito Apur. Própria', '-');
      cell(doc, M + W * 0.50, y, W * 0.50, 20, 'Valor Líquido da NFS-e', formatMoney(vLiq), { bold: true, fontSize: 9 });
      y += 20;

      // ===== TOTAIS APROXIMADOS =====
      y = sectionHeader(doc, M, y, W, 'TOTAIS APROXIMADOS DOS TRIBUTOS');
      cell(doc, M, y, W / 3, 20, 'Federais', tribFed ? formatMoney(tribFed) : '-');
      cell(doc, M + W / 3, y, W / 3, 20, 'Estaduais', tribEst ? formatMoney(tribEst) : '-');
      cell(doc, M + 2 * W / 3, y, W / 3, 20, 'Municipais', tribMun ? formatMoney(tribMun) : '-');
      y += 20;

      // ===== INFORMAÇÕES COMPLEMENTARES =====
      y = sectionHeader(doc, M, y, W, 'INFORMAÇÕES COMPLEMENTARES');
      const infH = Math.max(30, Math.min(80, 15 + (infCpl || '').length / 3));
      cell(doc, M, y, W, infH, '', infCpl || '', { fontSize: 7 });
      y += infH;

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
