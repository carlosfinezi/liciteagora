// locacao-pdf.js — Contrato de Locação de Bens Móveis + Nota Promissória.
//
// Layout copiado do modelo em uso pela REIMAC/Mestre da Obra (gerado pelo
// Empsis), na ordem em que o locador está acostumado a conferir:
//
//   cabeçalho com nº do contrato
//   Contratantes .... locadora (estabelecimento) e locatário (pessoas)
//   endereços ....... obra (com contato próprio) e cobrança
//   Objeto .......... itens, com a coluna "Valor Unitário Indenização"
//   totais .......... outras despesas (+), desconto (−), valor total
//   Prazo ........... início e previsão de término
//   Modalidade ...... a faixa aplicada e o valor mínimo
//   Cláusulas ....... texto copiado no contrato, não referenciado
//   assinaturas ..... locadora, locatário e "recebido por"
//   Avalistas ....... 0..N
//   Promissória ..... valor de REPOSIÇÃO, com valor por extenso
//   rodapé .......... dados da locadora, quem imprimiu e quando
//
// Mesmo uso de PDFKit dos outros geradores do repo (os-pdf.js, pedido-pdf.js).

'use strict';

const PDFDocument = require('pdfkit');
const { valorPorExtenso } = require('./tarifa');

function fmtBRL(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtData(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-');
  return (d && m && y) ? `${d}/${m}/${y}` : s;
}
function fmtDataHora(iso) {
  if (!iso) return '—';
  const s = String(iso).replace('T', ' ');
  const data = fmtData(s);
  const hora = s.slice(11, 16);
  return hora ? `${data} - ${hora}` : data;
}
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function dataPorExtenso(iso) {
  const s = String(iso || '').slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${d} de ${MESES[m - 1]} de ${y}`;
}
function linhaEndereco(p) {
  if (!p) return '';
  const partes = [p.endereco, p.numero, p.complemento].filter(Boolean).join(', ');
  return partes;
}

const ROTULO_FAIXA = {
  hora: 'POR HORA', dia: 'DIÁRIA', semana: 'SEMANAL',
  quinzena: 'QUINZENAL', mes: 'MENSAL',
};

/**
 * @param stream    destino (res)
 * @param dados     { contrato, itens, acertos, avalistas, cliente, locadora,
 *                    config, usuario }
 */
function gerar(stream, dados) {
  const { contrato: c, itens = [], acertos = [], avalistas = [],
          cliente = {}, locadora = {}, config = {}, usuario } = dados;

  // bufferPages é obrigatório para o rodapé: sem ele `switchToPage` estoura
  // ao voltar às páginas já emitidas.
  const doc = new PDFDocument({ size: 'A4', margin: 32, bufferPages: true });
  doc.pipe(stream);

  const L = 32;              // margem esquerda
  const R = 563;             // limite direito
  const W = R - L;

  function regua(y) {
    doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor('#999').stroke();
  }
  function secao(titulo) {
    doc.moveDown(0.4);
    const y = doc.y;
    doc.rect(L, y, W, 14).fillColor('#eef1f4').fill();
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(9)
       .text(titulo, L + 4, y + 3.5, { width: W - 8 });
    doc.y = y + 17;
  }
  function par(rotulo, valor, x, largura) {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#444')
       .text(rotulo, x, doc.y, { continued: true, width: largura });
    doc.font('Helvetica').fillColor('#111').text(' ' + (valor || '—'));
  }

  // ==================== CABEÇALHO ====================
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#111')
     .text(`Contrato de Locação de Bens Móveis Nº: ${c.numero}`, L, 34, { width: W, align: 'right' });
  doc.moveDown(0.3);

  // ==================== CONTRATANTES ====================
  secao('Contratantes');
  doc.fontSize(7.5);

  const meio = L + W / 2;
  let y0 = doc.y;
  doc.font('Helvetica-Bold').fillColor('#444').text('Locadora: ', L, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(locadora.nomeFantasia || locadora.razaoSocial || '—');
  doc.font('Helvetica-Bold').fillColor('#444').text('Email: ', meio, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(locadora.email || '—');
  doc.x = L;

  y0 = doc.y;
  doc.font('Helvetica-Bold').fillColor('#444').text('Endereço: ', L, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(linhaEndereco(locadora) || '—');
  doc.font('Helvetica-Bold').fillColor('#444').text('Bairro: ', meio, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(locadora.bairro || '—');
  doc.x = L;

  y0 = doc.y;
  doc.font('Helvetica-Bold').fillColor('#444').text('CEP: ', L, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(
    `${locadora.cep || '—'}   Cidade: ${locadora.cidade || '—'}   Estado: ${locadora.uf || '—'}`);
  doc.font('Helvetica-Bold').fillColor('#444').text('Telefone: ', meio, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(locadora.telefone || '—');
  doc.x = L;

  y0 = doc.y;
  doc.font('Helvetica-Bold').fillColor('#444').text('CNPJ: ', L, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(locadora.cnpj || '—');
  doc.font('Helvetica-Bold').fillColor('#444').text('Inscrição Estadual: ', meio, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(locadora.inscricaoEstadual || '—');
  doc.x = L;

  regua(doc.y + 2);
  doc.moveDown(0.3);

  y0 = doc.y;
  doc.font('Helvetica-Bold').fillColor('#444').text('Locatário: ', L, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(
    `${cliente.id ? cliente.id + ' - ' : ''}${cliente.razaoSocial || cliente.nomeFantasia || '—'}`);
  doc.x = L;

  y0 = doc.y;
  doc.font('Helvetica-Bold').fillColor('#444').text('Endereço: ', L, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(linhaEndereco(cliente) || '—');
  doc.font('Helvetica-Bold').fillColor('#444').text('Bairro: ', meio, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(cliente.bairro || '—');
  doc.x = L;

  y0 = doc.y;
  doc.font('Helvetica-Bold').fillColor('#444').text('CEP: ', L, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(
    `${cliente.cep || '—'}   Cidade: ${cliente.cidade || '—'}   Estado: ${cliente.uf || '—'}`);
  doc.font('Helvetica-Bold').fillColor('#444').text('Telefone: ', meio, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(cliente.telefone || '—');
  doc.x = L;

  y0 = doc.y;
  doc.font('Helvetica-Bold').fillColor('#444').text('CPF/CNPJ: ', L, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(cliente.cpfCnpj || '—');
  doc.font('Helvetica-Bold').fillColor('#444').text('Inscrição Estadual: ', meio, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(cliente.inscricaoEstadual || '—');
  doc.x = L;

  doc.moveDown(0.2);
  par('Endereço da obra:', c.enderecoEntrega, L, W);
  if (c.contatoObra || c.telefoneObra) {
    y0 = doc.y;
    doc.font('Helvetica-Bold').fillColor('#444').text('Contato: ', L, y0, { continued: true });
    doc.font('Helvetica').fillColor('#111').text(c.contatoObra || '—');
    doc.font('Helvetica-Bold').fillColor('#444').text('Telefone: ', meio, y0, { continued: true });
    doc.font('Helvetica').fillColor('#111').text(c.telefoneObra || '—');
    doc.x = L;
  }
  par('Endereço de Cobrança:', c.enderecoCobranca || c.enderecoEntrega, L, W);

  // ==================== OBJETO DO CONTRATO ====================
  secao('Objeto do Contrato');

  const COLS = [
    { t: 'Item', x: L, w: 26, a: 'left' },
    { t: 'Produto', x: L + 26, w: 232, a: 'left' },
    { t: 'Valor Unit. Indenização', x: L + 258, w: 86, a: 'right' },
    { t: 'Quantidade', x: L + 344, w: 55, a: 'right' },
    { t: 'Valor Unitário', x: L + 399, w: 62, a: 'right' },
    { t: 'Valor Total', x: L + 461, w: 70, a: 'right' },
  ];
  doc.font('Helvetica-Bold').fontSize(6.8).fillColor('#333');
  let yh = doc.y;
  for (const col of COLS) doc.text(col.t, col.x, yh, { width: col.w, align: col.a });
  doc.y = yh + 10;
  regua(doc.y - 2);

  doc.font('Helvetica').fontSize(7.5).fillColor('#111');
  itens.filter(i => i.natureza !== 'servico').forEach((i, idx) => {
    const yl = doc.y;
    doc.text(String(idx + 1), COLS[0].x, yl, { width: COLS[0].w });
    doc.text(i.descricao || '', COLS[1].x, yl, { width: COLS[1].w });
    doc.text(i.valorIndenizacao != null ? fmtBRL(i.valorIndenizacao) : '—',
             COLS[2].x, yl, { width: COLS[2].w, align: 'right' });
    doc.text(String(i.quantidade), COLS[3].x, yl, { width: COLS[3].w, align: 'right' });
    doc.text(fmtBRL(i.valorUnitario), COLS[4].x, yl, { width: COLS[4].w, align: 'right' });
    doc.text(fmtBRL(i.valorTotal), COLS[5].x, yl, { width: COLS[5].w, align: 'right' });
    doc.y = Math.max(doc.y, yl + 11);
  });

  // Serviços entram em bloco próprio — a SV 31 exige que locação e serviço
  // estejam separados no objeto E no valor, senão o município cobra ISS
  // sobre o todo.
  const servicos = itens.filter(i => i.natureza === 'servico');
  if (servicos.length) {
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#444')
       .text('Serviços contratados (tributados à parte da locação)', L, doc.y, { width: W });
    doc.font('Helvetica').fontSize(7.5).fillColor('#111');
    servicos.forEach((i, idx) => {
      const yl = doc.y;
      doc.text(String(idx + 1), COLS[0].x, yl, { width: COLS[0].w });
      doc.text(i.descricao || '', COLS[1].x, yl, { width: COLS[1].w });
      doc.text(String(i.quantidade), COLS[3].x, yl, { width: COLS[3].w, align: 'right' });
      doc.text(fmtBRL(i.valorUnitario), COLS[4].x, yl, { width: COLS[4].w, align: 'right' });
      doc.text(fmtBRL(i.valorTotal), COLS[5].x, yl, { width: COLS[5].w, align: 'right' });
      doc.y = Math.max(doc.y, yl + 11);
    });
  }

  regua(doc.y + 1);
  doc.moveDown(0.3);

  // Totais: acerto negativo é desconto; positivo, outras despesas.
  const despesas = acertos.filter(a => Number(a.valorTotal) > 0)
    .reduce((s, a) => s + Number(a.valorTotal), 0);
  const descontos = acertos.filter(a => Number(a.valorTotal) < 0)
    .reduce((s, a) => s + Math.abs(Number(a.valorTotal)), 0);

  doc.fontSize(7.5);
  y0 = doc.y;
  doc.font('Helvetica-Bold').fillColor('#444').text('Tipo Frete: ', L, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(c.tipoFrete || 'SEM FRETE');
  doc.font('Helvetica-Bold').fillColor('#444')
     .text('OUTRAS DESPESAS (+) (R$):', L + 330, y0, { width: 140, align: 'right' });
  doc.font('Helvetica').fillColor('#111')
     .text(fmtBRL(despesas), L + 470, y0, { width: 61, align: 'right' });
  doc.x = L;

  y0 = doc.y;
  doc.font('Helvetica-Bold').fillColor('#444').text('Documento Auxiliar/OC: ', L, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(c.documentoAuxiliar || '');
  doc.font('Helvetica-Bold').fillColor('#444')
     .text('Desconto (-):', L + 330, y0, { width: 140, align: 'right' });
  doc.font('Helvetica').fillColor('#111')
     .text(fmtBRL(descontos), L + 470, y0, { width: 61, align: 'right' });
  doc.x = L;

  y0 = doc.y;
  doc.font('Helvetica-Bold').fillColor('#444').text('Prazo de Locação - Início: ', L, y0, { continued: true });
  doc.font('Helvetica').fillColor('#111').text(
    `${fmtDataHora(c.dataSaidaReal || c.dataSaidaPrevista)}      `
    + `Previsão Término: ${fmtDataHora(c.dataRetornoPrevisto)}`);
  doc.font('Helvetica-Bold').fillColor('#111')
     .text('Valor Total:', L + 330, y0, { width: 140, align: 'right' });
  doc.font('Helvetica-Bold').fillColor('#111')
     .text(fmtBRL(c.valorTotal), L + 470, y0, { width: 61, align: 'right' });
  doc.x = L;

  // ==================== MODALIDADE ====================
  secao('Modalidade de Locação');
  const faixa = (itens.find(i => i.tarifaFaixa) || {}).tarifaFaixa;
  y0 = doc.y;
  doc.font('Helvetica').fontSize(7.5).fillColor('#111')
     .text(`O valor acima citado refere-se a locação na modalidade: `
       + `${ROTULO_FAIXA[faixa] || '—'}`, L, y0, { width: 340 });
  if (Number(config.locacao_valor_minimo) > 0) {
    doc.font('Helvetica-Bold').fillColor('#111')
       .text(`*Valor Mínimo Locação: R$ ${fmtBRL(config.locacao_valor_minimo)}`,
             L + 350, y0, { width: 181, align: 'right' });
  }
  doc.x = L;

  // ==================== CLÁUSULAS ====================
  if (c.clausulas && String(c.clausulas).trim()) {
    secao('Cláusulas e Condições');
    doc.font('Helvetica').fontSize(6.6).fillColor('#111')
       .text(String(c.clausulas).trim(), L, doc.y, { width: W, align: 'justify', lineGap: 0.5 });
  }

  // ==================== ASSINATURAS ====================
  doc.moveDown(1);
  const cidadeAss = locadora.cidade || '';
  doc.font('Helvetica').fontSize(8).fillColor('#111')
     .text(`${cidadeAss ? cidadeAss.toUpperCase() + ', ' : ''}`
       + `${dataPorExtenso(c.dataCriacao || new Date().toISOString())}`, L, doc.y, { width: W });

  doc.moveDown(2.2);
  const yAss = doc.y;
  const larguraAss = W / 3 - 10;
  doc.fontSize(7.5).fillColor('#111');
  for (let i = 0; i < 3; i++) {
    const x = L + i * (W / 3);
    doc.moveTo(x, yAss).lineTo(x + larguraAss, yAss).strokeColor('#333').lineWidth(0.5).stroke();
  }
  doc.text(locadora.nomeFantasia || locadora.razaoSocial || '', L, yAss + 3,
    { width: larguraAss, align: 'center' });
  doc.text(cliente.razaoSocial || cliente.nomeFantasia || '', L + W / 3, yAss + 3,
    { width: larguraAss, align: 'center' });
  doc.font('Helvetica-Bold').text('Recebido por:', L + 2 * (W / 3), yAss + 3, { width: larguraAss });
  doc.font('Helvetica').text('CPF:', L + 2 * (W / 3), doc.y, { width: larguraAss });

  // ==================== AVALISTAS ====================
  if (avalistas.length) {
    secao('Avalistas');
    doc.fontSize(7.5).fillColor('#111');
    for (const a of avalistas) {
      doc.font('Helvetica-Bold').text('Nome: ', L, doc.y, { continued: true });
      doc.font('Helvetica').text(`${a.nome || '_'.repeat(45)}`);
      doc.font('Helvetica-Bold').text('CPF/CNPJ: ', L, doc.y, { continued: true });
      doc.font('Helvetica').text(`${a.cpfCnpj || '_'.repeat(30)}`);
      doc.font('Helvetica-Bold').text('Endereço: ', L, doc.y, { continued: true });
      doc.font('Helvetica').text(`${a.endereco || '_'.repeat(55)}`);
      doc.moveDown(0.6);
    }
  }

  // ==================== NOTA PROMISSÓRIA ====================
  if (c.promissoriaEmitir) {
    if (doc.y > 640) doc.addPage();
    secao('Nota Promissória');
    const valor = Number(c.promissoriaValor) || 0;
    const venc = c.promissoriaVencimento;
    doc.fontSize(7.5).fillColor('#111');

    y0 = doc.y;
    doc.font('Helvetica-Bold').text(`Nº ${c.promissoriaNumero || c.numero}`, L, y0, { width: 150 });
    doc.font('Helvetica-Bold').text(`Vencimento ${dataPorExtenso(venc)}`, L + 160, y0, { width: 240 });
    doc.font('Helvetica-Bold').fontSize(9)
       .text(`R$ ${fmtBRL(valor)}`, L + 400, y0, { width: 131, align: 'right' });
    doc.x = L;
    doc.moveDown(0.5);

    doc.font('Helvetica').fontSize(7.5).text(
      `Ao(s) ${dataPorExtenso(venc)} pagarei por esta única via de NOTA PROMISSÓRIA a `
      + `${locadora.razaoSocial || ''}${locadora.cnpj ? ' - ' + locadora.cnpj : ''}, `
      + `ou à sua ordem, a quantia de:`, L, doc.y, { width: W, align: 'justify' });
    doc.font('Helvetica-Bold').fontSize(8)
       .text(`--- ${valorPorExtenso(valor).toUpperCase()} ---`, L, doc.y + 2, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(7.5).text(
      `em moeda corrente deste país, pagável em: `
      + `${c.promissoriaPraca || [locadora.cidade, locadora.uf].filter(Boolean).join('/')}`,
      L, doc.y + 2, { width: W });
    doc.text(`Emitente: ${cliente.razaoSocial || ''} — Data de Emissão `
      + `${fmtData(c.dataSaidaReal || c.dataSaidaPrevista)}`, L, doc.y, { width: W });
    doc.text(`CPF/CNPJ: ${cliente.cpfCnpj || ''} — Endereço: `
      + `${linhaEndereco(cliente)}${cliente.cidade ? ', ' + cliente.cidade : ''}`
      + `${cliente.uf ? ' - ' + cliente.uf : ''}`, L, doc.y, { width: W });

    doc.moveDown(2);
    const yP = doc.y;
    doc.moveTo(L + W / 3, yP).lineTo(L + 2 * (W / 3), yP).strokeColor('#333').stroke();
    doc.fontSize(7).text('Assinatura do Emitente', L + W / 3, yP + 3,
      { width: W / 3, align: 'center' });
  }

  // ==================== RODAPÉ ====================
  const rodape = () => {
    const yr = 800;
    doc.font('Helvetica').fontSize(6).fillColor('#555');
    doc.text(`${locadora.razaoSocial || ''}`
      + `${locadora.cnpj ? ' - CNPJ: ' + locadora.cnpj : ''}`
      + `${locadora.inscricaoEstadual ? ' - IE: ' + locadora.inscricaoEstadual : ''}`,
      L, yr, { width: W, align: 'center' });
    doc.text(`${linhaEndereco(locadora)}`
      + `${locadora.bairro ? ' - ' + locadora.bairro : ''}`
      + `${locadora.cep ? ' - CEP: ' + locadora.cep : ''}`
      + `${locadora.cidade ? ' - ' + locadora.cidade : ''}`
      + `${locadora.uf ? '/' + locadora.uf : ''}`, L, doc.y, { width: W, align: 'center' });
    doc.text(`${locadora.telefone || ''}${locadora.email ? ' - ' + locadora.email : ''}`,
      L, doc.y, { width: W, align: 'center' });
    if (usuario) {
      doc.fillColor('#888').text(
        `Impresso por ${usuario} em ${new Date().toLocaleString('pt-BR')}`,
        L, doc.y, { width: W, align: 'center' });
    }
  };
  const total = doc.bufferedPageRange().count;
  for (let i = 0; i < total; i++) { doc.switchToPage(i); rodape(); }

  doc.end();
}

module.exports = { gerar, valorPorExtenso, dataPorExtenso };
