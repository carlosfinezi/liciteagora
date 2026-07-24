/**
 * nfe-proc.js — Envelopamento <nfeProc> da NF-e/NFC-e autorizada.
 *
 * O XML pós-autorização precisa de UM único root <nfeProc> que contenha
 * <NFe> + <protNFe>. Concatenar NFe e protNFe lado a lado gera "multiple
 * root elements" e é rejeitado pelo validador SEFAZ.
 */

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const NFE_VERSAO = '4.00';

function extrairXmlDecl(xml) {
  const t = (xml || '').trim();
  if (t.startsWith('<?xml')) {
    const fim = t.indexOf('?>') + 2;
    return { decl: t.substring(0, fim), corpo: t.substring(fim).trim() };
  }
  return { decl: '<?xml version="1.0" encoding="UTF-8"?>', corpo: t };
}

function montarNFeProc(xmlAssinado, respSefaz) {
  if (!xmlAssinado) return xmlAssinado;
  const protMatch = (respSefaz || '').match(/<protNFe[\s\S]*?<\/protNFe>/);
  if (!protMatch) return xmlAssinado;

  const { decl, corpo } = extrairXmlDecl(xmlAssinado);
  if (corpo.includes('<nfeProc')) return xmlAssinado;

  return `${decl}<nfeProc versao="${NFE_VERSAO}" xmlns="${NFE_NS}">${corpo}${protMatch[0]}</nfeProc>`;
}

function reenveloparExistente(xmlBruto) {
  if (!xmlBruto) return null;
  const { decl, corpo } = extrairXmlDecl(xmlBruto);
  if (corpo.includes('<nfeProc')) return xmlBruto;

  const nfeMatch = corpo.match(/<NFe[\s\S]*?<\/NFe>/);
  const protMatch = corpo.match(/<protNFe[\s\S]*?<\/protNFe>/);
  if (!nfeMatch || !protMatch) return null;

  return `${decl}<nfeProc versao="${NFE_VERSAO}" xmlns="${NFE_NS}">${nfeMatch[0]}${protMatch[0]}</nfeProc>`;
}

module.exports = { montarNFeProc, reenveloparExistente };
