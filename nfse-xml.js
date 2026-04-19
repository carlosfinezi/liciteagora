/**
 * nfse-xml.js — XML builder + assinatura XMLDSIG para NFS-e Nacional
 *
 * Gera o XML da DPS (Declaração de Prestação de Serviço) conforme layout
 * do Emissor Nacional e assina com certificado A1 usando XMLDSIG (RSA-SHA256).
 *
 * Referência: XSD oficial — DPS_v1.00.xsd, tiposComplexos_v1.00.xsd, tiposSimples_v1.00.xsd
 *
 * Uso no nfse-routes.js:
 *   const { construirDPS, assinarDPS, extrairChavesCertificado, gerarIdDps } = require('./nfse-xml');
 */

const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');

const NFSE_NS = 'http://www.sped.fazenda.gov.br/nfse';

// verAplic dinâmico (NFSE-H05). XSD exige pattern [A-Za-z0-9._-]{1,20}.
// Fallback para '1.0.0' se package.json não for legível.
let VER_APLIC;
try {
  const pkg = require('./package.json');
  const ver = String(pkg.version || '1.0.0').replace(/[^A-Za-z0-9._-]/g, '');
  VER_APLIC = ('LiciteAgora' + ver).slice(0, 20);
} catch (e) {
  VER_APLIC = 'LiciteAgora1.0';
}

/**
 * Gera o ID da DPS (45 caracteres, pattern: DPS[0-9]{42})
 *
 * Formato conforme XSD TSIdDPS:
 *   "DPS" + CodMun(7) + TipoInscrFederal(1) + InscrFederal(14) + SérieDPS(5) + NúmDPS(15)
 *
 * TipoInscrFederal: 1=CPF, 2=CNPJ
 * SérieDPS: numérico no ID (hash da série alfanumérica)
 * NúmDPS: zero-padded a 15 dígitos
 *
 * @param {string} codigoIBGE - Código IBGE do município (7 dígitos)
 * @param {string} cnpj - CNPJ do prestador
 * @param {string} serie - Série do DPS
 * @param {number} numero - Número do DPS
 * @returns {string} ID com 45 caracteres
 */
function gerarIdDps(codigoIBGE, cnpj, serie, numero) {
  const cnpjLimpo = cnpj.replace(/\D/g, '').padStart(14, '0');
  const tipoInscr = cnpjLimpo.length > 11 ? '2' : '1'; // 2=CNPJ, 1=CPF

  // Série no ID deve ser numérica (5 dígitos). Se alfanumérica, converter para hash numérico.
  let serieNum;
  if (/^\d+$/.test(serie)) {
    serieNum = String(serie).padStart(5, '0');
  } else {
    // Converter série alfanumérica para 5 dígitos determinísticos
    let hash = 0;
    for (let i = 0; i < serie.length; i++) {
      hash = ((hash * 31) + serie.charCodeAt(i)) % 100000;
    }
    serieNum = String(hash).padStart(5, '0');
  }

  const numeroPad = String(numero).padStart(15, '0');

  const id = `DPS${codigoIBGE}${tipoInscr}${cnpjLimpo}${serieNum}${numeroPad}`;

  // Validar: deve ter 45 chars e match DPS[0-9]{42}
  if (id.length !== 45 || !/^DPS\d{42}$/.test(id)) {
    throw new Error(`ID DPS inválido: "${id}" (len=${id.length}). Deve ter 45 chars e pattern DPS[0-9]{42}`);
  }

  return id;
}

/**
 * Escapa caracteres XML especiais
 */
function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Formata data para ISO com offset Brasília (-03:00) (NFSE-H02)
 *
 * Usa Intl.DateTimeFormat com timeZone explícito para funcionar em qualquer
 * fuso do servidor (container UTC, Brasília, ou outro). A implementação
 * anterior só produzia resultado correto se o servidor rodava em UTC ou BRT.
 */
function formatarDataBrasilia(date) {
  if (!date) date = new Date();
  if (typeof date === 'string') date = new Date(date);

  // Extrai partes em America/Sao_Paulo independente do TZ do SO
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});

  // `hour` vira "24" em algumas libs quando é meia-noite; normalizar
  const hour = parts.hour === '24' ? '00' : parts.hour;

  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}-03:00`;
}

/**
 * Formata data simples YYYY-MM-DD
 */
function formatarData(date) {
  if (!date) date = new Date();
  if (typeof date === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    date = new Date(date);
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Constrói o XML da DPS (Declaração de Prestação de Serviço)
 * Conforme XSD: TCDPS → TCInfDPS
 *
 * Sequência obrigatória do infDPS:
 *   tpAmb, dhEmi, verAplic, serie, nDPS, dCompet, tpEmit, cLocEmi,
 *   [subst], prest, [toma], [interm], serv, valores
 *
 * @param {Object} dados
 * @param {string} dados.idDps - ID da DPS (45 chars, gerado por gerarIdDps)
 * @param {number} dados.tpAmb - 1=Produção, 2=Homologação
 * @param {string} dados.serie - Série do DPS (max 5 chars)
 * @param {number} dados.nDPS - Número sequencial do DPS
 * @param {string} dados.competencia - Data de competência (YYYY-MM-DD)
 * @param {Object} dados.prestador
 * @param {string} dados.prestador.cnpj
 * @param {string} [dados.prestador.inscricaoMunicipal]
 * @param {string} dados.prestador.codigoMunicipio - Código IBGE (7 dígitos)
 * @param {number} [dados.prestador.opSimpNac] - 1=Não Optante, 2=MEI, 3=ME/EPP (default: 1)
 * @param {number} [dados.prestador.regEspTrib] - 0=Nenhum (default: 0)
 * @param {Object} dados.tomador
 * @param {string} dados.tomador.cpfCnpj
 * @param {string} dados.tomador.razaoSocial
 * @param {Object} [dados.tomador.endereco]
 * @param {Object} dados.servico
 * @param {string} dados.servico.codigoTributacaoNacional - cTribNac (6 dígitos)
 * @param {string} dados.servico.descricao
 * @param {number} dados.servico.valorServico
 * @param {number} [dados.servico.aliquota] - Alíquota ISS (percentual)
 * @param {number} [dados.servico.tribISSQN] - 1=Tributável, 2=Exportação, 3=Não incidência, 4=Imunidade (default: 1)
 * @returns {string} XML da DPS (sem assinatura)
 */
function construirDPS(dados) {
  const {
    idDps, tpAmb, serie, nDPS, competencia,
    prestador, tomador, servico
  } = dados;

  const dhEmi = formatarDataBrasilia(new Date());
  const comp = formatarData(competencia);

  const cpfCnpjTomador = tomador.cpfCnpj.replace(/\D/g, '');
  const isCpf = cpfCnpjTomador.length <= 11;

  // nDPS: pattern [1-9]{1}[0-9]{0,14} — não pode começar com zero
  const nDPSStr = String(nDPS);

  let xml = `<?xml version="1.0" encoding="UTF-8"?>`;
  xml += `<DPS versao="1.00" xmlns="${NFSE_NS}">`;
  xml += `<infDPS Id="${escapeXml(idDps)}">`;

  // === Identificação (ordem obrigatória conforme XSD) ===
  xml += `<tpAmb>${tpAmb}</tpAmb>`;
  xml += `<dhEmi>${dhEmi}</dhEmi>`;
  xml += `<verAplic>${VER_APLIC}</verAplic>`;
  xml += `<serie>${escapeXml(serie)}</serie>`;
  xml += `<nDPS>${nDPSStr}</nDPS>`;
  xml += `<dCompet>${comp}</dCompet>`;
  xml += `<tpEmit>1</tpEmit>`; // 1=Prestador
  xml += `<cLocEmi>${prestador.codigoMunicipio}</cLocEmi>`;

  // === Prestador (TCInfoPrestador) ===
  xml += `<prest>`;
  xml += `<CNPJ>${prestador.cnpj.replace(/\D/g, '')}</CNPJ>`;
  if (prestador.inscricaoMunicipal) {
    xml += `<IM>${escapeXml(prestador.inscricaoMunicipal)}</IM>`;
  }
  // regTrib é obrigatório no prestador
  xml += `<regTrib>`;
  xml += `<opSimpNac>${prestador.opSimpNac || 1}</opSimpNac>`;
  // regApTribSN obrigatório para optantes SN (opSimpNac=3)
  if ((prestador.opSimpNac || 1) == 3 || (prestador.opSimpNac || 1) == 2) {
    xml += `<regApTribSN>${prestador.regApTribSN || 1}</regApTribSN>`;
  }
  xml += `<regEspTrib>${prestador.regEspTrib || 0}</regEspTrib>`;
  xml += `</regTrib>`;
  xml += `</prest>`;

  // === Tomador (TCInfoPessoa, opcional mas recomendado) ===
  xml += `<toma>`;
  if (isCpf) {
    xml += `<CPF>${cpfCnpjTomador.padStart(11, '0')}</CPF>`;
  } else {
    xml += `<CNPJ>${cpfCnpjTomador.padStart(14, '0')}</CNPJ>`;
  }
  if (tomador.razaoSocial) {
    xml += `<xNome>${escapeXml(tomador.razaoSocial)}</xNome>`;
  }
  if (tomador.endereco) {
    const end = tomador.endereco;
    xml += `<end>`;
    // endNac (obrigatório em v1.01: choice endNac|endExt antes de xLgr)
    if (end.codigoMunicipio || end.cep) {
      xml += `<endNac>`;
      if (end.codigoMunicipio) xml += `<cMun>${end.codigoMunicipio}</cMun>`;
      if (end.cep) xml += `<CEP>${end.cep.replace(/\D/g, '')}</CEP>`;
      xml += `</endNac>`;
    }
    if (end.logradouro) xml += `<xLgr>${escapeXml(end.logradouro)}</xLgr>`;
    if (end.numero) xml += `<nro>${escapeXml(end.numero)}</nro>`;
    if (end.complemento) xml += `<xCpl>${escapeXml(end.complemento)}</xCpl>`;
    if (end.bairro) xml += `<xBairro>${escapeXml(end.bairro)}</xBairro>`;
    xml += `</end>`;
  }
  if (tomador.email) {
    xml += `<email>${escapeXml(tomador.email)}</email>`;
  }
  xml += `</toma>`;

  // === Serviço (TCServ) ===
  xml += `<serv>`;
  xml += `<locPrest>`;
  xml += `<cLocPrestacao>${servico.codigoMunicipioPrestacao || prestador.codigoMunicipio}</cLocPrestacao>`;
  xml += `</locPrest>`;
  xml += `<cServ>`;
  xml += `<cTribNac>${escapeXml(servico.codigoTributacaoNacional)}</cTribNac>`;
  xml += `<cTribMun>${escapeXml(servico.codigoListaServico || '001')}</cTribMun>`;
  xml += `<xDescServ>${escapeXml(servico.descricao)}</xDescServ>`;
  xml += `</cServ>`;
  xml += `</serv>`;

  // === Valores (TCInfoValores) ===
  xml += `<valores>`;

  // vServPrest (obrigatório)
  xml += `<vServPrest>`;
  xml += `<vServ>${Number(servico.valorServico).toFixed(2)}</vServ>`;
  xml += `</vServPrest>`;

  // trib (obrigatório: tribMun + totTrib)
  xml += `<trib>`;

  // tribMun (obrigatório: tribISSQN + tpRetISSQN)
  xml += `<tribMun>`;
  xml += `<tribISSQN>${servico.tribISSQN || 1}</tribISSQN>`; // 1=Operação tributável
  xml += `<tpRetISSQN>${servico.tpRetISSQN || 1}</tpRetISSQN>`; // 1=Não retido
  xml += `</tribMun>`;

  // tribFed (PIS/COFINS para Simples Nacional)
  if ((prestador.opSimpNac || 1) >= 2) {
    xml += `<tribFed><piscofins><CST>00</CST></piscofins></tribFed>`;
  }

  // totTrib (obrigatório)
  xml += `<totTrib>`;
  if ((prestador.opSimpNac || 1) >= 2) {
    // Optante SN: informar alíquota SN (indTotTrib não permitido para ME/EPP)
    xml += `<pTotTribSN>${Number(dados.pTotTribSN || 6.00).toFixed(2)}</pTotTribSN>`;
  } else {
    xml += `<indTotTrib>0</indTotTrib>`; // 0 = Não informar valor estimado
  }
  xml += `</totTrib>`;

  xml += `</trib>`;
  xml += `</valores>`;

  xml += `</infDPS>`;
  xml += `</DPS>`;

  return xml;
}

/**
 * Assina o XML da DPS com XMLDSIG (RSA-SHA256, enveloped, C14N)
 *
 * @param {string} dpsXml - XML da DPS a ser assinado
 * @param {string} privateKeyPem - Chave privada em PEM
 * @param {string} certDerBase64 - Certificado DER em base64
 * @returns {string} XML assinado com Signature dentro de <DPS>
 */
function assinarDPS(dpsXml, privateKeyPem, certDerBase64) {
  const idMatch = dpsXml.match(/Id="([^"]+)"/);
  if (!idMatch) {
    throw new Error('ID do infDPS não encontrado no XML');
  }
  const refId = idMatch[1];

  // Converter certDerBase64 para formato PEM para xml-crypto
  const certPem = `-----BEGIN CERTIFICATE-----\n${certDerBase64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;

  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certPem,
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  });

  sig.addReference({
    xpath: `//*[@Id='${refId}']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });

  sig.computeSignature(dpsXml, {
    location: { reference: '//*[local-name()="DPS"]', action: 'append' },
  });

  return sig.getSignedXml();
}

/**
 * Extrai chave privada (PEM) e certificado (DER base64) de um arquivo PKCS#12
 */
function extrairChavesCertificado(p12Buffer, senha) {
  const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag];
  if (!keyBag || keyBag.length === 0) {
    throw new Error('Chave privada não encontrada no certificado');
  }
  const privateKeyPem = forge.pki.privateKeyToPem(keyBag[0].key);

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = certBags[forge.pki.oids.certBag];
  if (!certBag || certBag.length === 0) {
    throw new Error('Certificado não encontrado no arquivo P12');
  }
  const certificate = certBag[0].cert;

  const certAsn1 = forge.pki.certificateToAsn1(certificate);
  const certDer = forge.asn1.toDer(certAsn1).getBytes();
  const certDerBase64 = forge.util.encode64(certDer);

  const titular = certificate.subject.getField('CN')?.value || 'Desconhecido';
  const validade = certificate.validity.notAfter;

  return { privateKeyPem, certDerBase64, titular, validade };
}

module.exports = {
  gerarIdDps,
  construirDPS,
  assinarDPS,
  extrairChavesCertificado,
  formatarDataBrasilia,
  formatarData,
};
