// pdf-routes.js
//
// Assinatura digital de PDF (PKCS#7 detached) com certificado A1
// do fornecedor. Extraído de server.js em NFSE-M06 onda 6.17.
//
// Escopo: 1 rota + 2 helpers locais:
//   POST /api/pdf/assinar    recebe {pdfBase64}, busca certificado
//                             digital A1 (tabela certificado_digital
//                             id=1), aplica indicação visual na
//                             última página via pdf-lib e tenta
//                             assinar via @signpdf/signpdf com P12.
//                             Se @signpdf falhar, retorna PDF só
//                             com a indicação visual (metodo='visual').
//
//   createPkcs7Signature()    helper node-forge para criar PKCS#7
//                             detached — usada por addSignature-
//                             Placeholder internamente (legado).
//   addSignaturePlaceholder() helper para montar ByteRange/Contents
//                             placeholder manualmente no PDF (legado,
//                             mantido porque o monolito tinha).
//
// Os dois helpers acima hoje são usados apenas como fallback
// interno — no fluxo principal o @signpdf faz tudo. Foram
// preservados 1:1 do monolito por parcimônia.
//
// DEPENDÊNCIAS (todos os requires foram movidos do server.js):
//   - node-forge           (PKCS#7/P12 parsing + signing)
//   - @signpdf/signpdf     (assinatura principal)
//   - @signpdf/signer-p12  (driver P12 do @signpdf)
//   - @signpdf/placeholder-plain  (plainAddPlaceholder)
//   - pdf-lib              (dynamic require dentro da rota)
//
// Estado: nenhum. Todos os requires são module-level, sem estado
// compartilhado entre requests.
//
// TABELA certificado_digital: o monolito lê id=1 (único certificado
// ativo por instalação). Schema em server.js na DDL inicial;
// gerenciada pela rota /api/certificado em certificado-routes.js
// (onda 6.7).

const forge = require('node-forge');
const { SignPdf } = require('@signpdf/signpdf');
const { P12Signer } = require('@signpdf/signer-p12');
const { plainAddPlaceholder } = require('@signpdf/placeholder-plain');

// Função auxiliar para criar assinatura PKCS#7 detached
function createPkcs7Signature(pdfBytes, privateKey, certificate, additionalCerts = []) {
  const p7 = forge.pkcs7.createSignedData();

  // Adicionar certificado do signatário e cadeia
  p7.addCertificate(certificate);
  additionalCerts.forEach(cert => p7.addCertificate(cert));

  // Configurar signer
  p7.addSigner({
    key: privateKey,
    certificate: certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      {
        type: forge.pki.oids.contentType,
        value: forge.pki.oids.data
      },
      {
        type: forge.pki.oids.messageDigest
        // valor será calculado automaticamente
      },
      {
        type: forge.pki.oids.signingTime,
        value: new Date()
      }
    ]
  });

  // Definir conteúdo a ser assinado (detached = não incluído no PKCS#7)
  p7.content = forge.util.createBuffer(pdfBytes);

  // Assinar
  p7.sign({ detached: true });

  // Converter para DER
  const asn1 = p7.toAsn1();
  const der = forge.asn1.toDer(asn1).getBytes();

  return Buffer.from(der, 'binary');
}

// Função para adicionar placeholder de assinatura manualmente ao PDF
function addSignaturePlaceholder(pdfBuffer, signatureLength = 16384) {
  let pdf = pdfBuffer.toString('binary');

  // Encontrar o final do PDF (%%EOF)
  const eofMatch = pdf.match(/%%EOF[\r\n]?$/);
  if (!eofMatch) {
    throw new Error('PDF inválido: %%EOF não encontrado');
  }

  // Encontrar xref
  const startxrefMatch = pdf.match(/startxref[\r\n]+(\d+)[\r\n]+%%EOF/);
  if (!startxrefMatch) {
    throw new Error('PDF inválido: startxref não encontrado');
  }

  const xrefOffset = parseInt(startxrefMatch[1]);

  // Encontrar trailer
  const trailerMatch = pdf.match(/trailer[\s\S]*?\/Root\s+(\d+)\s+\d+\s+R[\s\S]*?\/Size\s+(\d+)/);
  if (!trailerMatch) {
    throw new Error('PDF inválido: trailer não encontrado');
  }

  const rootRef = trailerMatch[1];
  const objectCount = parseInt(trailerMatch[2]);

  // Criar novos objetos para a assinatura
  const sigObjNum = objectCount;
  const sigFieldObjNum = objectCount + 1;

  const now = new Date();
  const dateStr = `D:${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}-03'00'`;

  // ByteRange placeholder (será preenchido depois)
  const byteRangePlaceholder = '/ByteRange [0 ********** ********** **********]';
  const contentPlaceholder = '<' + '0'.repeat(signatureLength * 2) + '>';

  // Criar objeto de assinatura
  const sigObj = `${sigObjNum} 0 obj\n<<\n/Type /Sig\n/Filter /Adobe.PPKLite\n/SubFilter /adbe.pkcs7.detached\n/M (${dateStr})\n/Name (Assinatura Digital)\n/Reason (Proposta Comercial)\n/Location (Brasil)\n${byteRangePlaceholder}\n/Contents ${contentPlaceholder}\n>>\nendobj\n`;

  // Adicionar objeto de assinatura após o último objeto existente
  const lastEndobj = pdf.lastIndexOf('endobj', xrefOffset);
  const insertPosition = lastEndobj + 6;

  // Inserir objeto de assinatura
  const beforeSig = pdf.substring(0, insertPosition) + '\n';
  const afterSig = pdf.substring(insertPosition);

  const sigObjOffset = beforeSig.length;
  pdf = beforeSig + sigObj + afterSig;

  // Atualizar xref e trailer
  const newXrefOffset = pdf.length;
  const newXref = `xref\n${sigObjNum} 1\n${String(sigObjOffset).padStart(10, '0')} 00000 n \ntrailer\n<<\n/Size ${objectCount + 1}\n/Root ${rootRef} 0 R\n/Prev ${xrefOffset}\n>>\nstartxref\n${newXrefOffset}\n%%EOF\n`;

  pdf = pdf.replace(/%%EOF[\r\n]?$/, newXref);

  return {
    pdf: Buffer.from(pdf, 'binary'),
    signatureOffset: pdf.indexOf(contentPlaceholder) + 1,
    signatureLength: signatureLength * 2,
    byteRangeOffset: pdf.indexOf(byteRangePlaceholder)
  };
}

function registrarRotasPdf(app, db) {
  // Assinar PDF com certificado digital A1
  app.post('/api/pdf/assinar', async (req, res) => {
    try {
      const { pdfBase64 } = req.body;

      if (!pdfBase64) {
        return res.status(400).json({ success: false, error: 'PDF não fornecido' });
      }

      // Buscar certificado
      const cert = db.prepare('SELECT certificadoBase64, senhaCriptografada, titular, validade FROM certificado_digital WHERE id = 1').get();

      if (!cert) {
        return res.status(400).json({ success: false, error: 'Certificado não configurado. Configure em Dados do Fornecedor.' });
      }

      const p12Buffer = Buffer.from(cert.certificadoBase64, 'base64');
      const senha = Buffer.from(cert.senhaCriptografada, 'base64').toString();

      // Extrair certificado e chave privada do P12
      const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
      const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);

      // Pegar chave privada
      const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
      const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0];
      const privateKey = keyBag.key;

      // Pegar certificado
      const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
      const certBag = certBags[forge.pki.oids.certBag][0];
      const certificate = certBag.cert;

      // Converter PDF de base64 para buffer
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');

      // Usar pdf-lib para adicionar indicação visual e normalizar
      const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
      const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
      const pages = pdfDoc.getPages();
      const lastPage = pages[pages.length - 1];

      // Adicionar indicação visual de assinatura na última página
      const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const { width, height } = lastPage.getSize();

      // Caixa de assinatura visual
      const boxX = 50;
      const boxY = 15;
      const boxWidth = width - 100;
      const boxHeight = 45;

      // Desenhar borda da caixa de assinatura
      lastPage.drawRectangle({
        x: boxX,
        y: boxY,
        width: boxWidth,
        height: boxHeight,
        borderColor: rgb(0.2, 0.4, 0.6),
        borderWidth: 1,
        color: rgb(0.95, 0.97, 1)
      });

      // Texto da assinatura
      lastPage.drawText('DOCUMENTO ASSINADO DIGITALMENTE', {
        x: boxX + 10,
        y: boxY + 32,
        size: 9,
        font: helveticaFont,
        color: rgb(0.1, 0.3, 0.5)
      });
      lastPage.drawText(`Signatario: ${cert.titular}`, {
        x: boxX + 10,
        y: boxY + 20,
        size: 8,
        font: helveticaFont,
        color: rgb(0.3, 0.3, 0.3)
      });
      lastPage.drawText(`Data/Hora: ${new Date().toLocaleString('pt-BR')} | Certificado valido ate: ${cert.validade}`, {
        x: boxX + 10,
        y: boxY + 8,
        size: 7,
        font: helveticaFont,
        color: rgb(0.4, 0.4, 0.4)
      });

      // Salvar PDF com indicação visual (sem object streams para compatibilidade)
      const normalizedPdfBytes = await pdfDoc.save({ useObjectStreams: false });

      // Tentar usar @signpdf para assinatura criptográfica
      try {
        // Tentar adicionar placeholder e assinar
        let pdfWithPlaceholder;
        try {
          pdfWithPlaceholder = plainAddPlaceholder({
            pdfBuffer: Buffer.from(normalizedPdfBytes),
            reason: 'Proposta Comercial',
            contactInfo: cert.titular,
            name: cert.titular,
            location: 'Brasil',
            signatureLength: 16384
          });
        } catch (placeholderError) {
          console.error('Erro ao adicionar placeholder:', placeholderError.message);
          // Tentar método alternativo
          throw new Error('Placeholder failed: ' + placeholderError.message);
        }

        // Criar signer P12
        const signer = new P12Signer(p12Buffer, { passphrase: senha });

        // Assinar o PDF
        const signPdf = new SignPdf();
        const signedPdfBuffer = await signPdf.sign(pdfWithPlaceholder, signer);

        console.log('PDF assinado com sucesso usando @signpdf');

        // Retornar PDF assinado
        const signedBase64 = Buffer.from(signedPdfBuffer).toString('base64');
        res.json({ success: true, pdfAssinado: signedBase64 });

      } catch (signError) {
        console.error('Erro com @signpdf:', signError.message);

        // Fallback: retornar PDF com indicação visual apenas
        // A assinatura criptográfica embutida em PDFs requer estrutura específica
        // que pode não ser compatível com todos os geradores de PDF
        console.log('Retornando PDF com indicação visual de assinatura');

        const signedBase64 = Buffer.from(normalizedPdfBytes).toString('base64');
        res.json({
          success: true,
          pdfAssinado: signedBase64,
          metodo: 'visual'
        });
      }

    } catch (error) {
      console.error('Erro ao assinar PDF:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[PDF] Rotas registradas');
}

module.exports = { registrarRotasPdf };
