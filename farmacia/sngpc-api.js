/**
 * sngpc-api.js — Transmissão do arquivo ao webservice do SNGPC (ANVISA).
 *
 * FONTE
 * "Conexão ao Webservice do SNGPC — Manual do Desenvolvedor, versão 2.0.1"
 * (ANVISA). O envelope é o descrito lá:
 *
 *   XML  →  zip  →  base64  →  MD5 do base64  →  EnviaArquivoSNGPC
 *
 * Endpoints (SOAP .asmx, do manual):
 *   homologação: http://homologacao.anvisa.gov.br/sngpc/webservice/sngpc.asmx
 *   produção:    http://sngpc.anvisa.gov.br/webservice/sngpc.asmx
 *
 * Métodos usados:
 *   ValidarUsuario(Email, Senha)                     — credenciais do RT Transmissor
 *   EnviaArquivoSNGPC(Email, Senha, Arq, Hashindenficacacao)
 *                                                     (o nome do 4º parâmetro
 *                                                      está grafado assim no
 *                                                      manual — mantido igual)
 *
 * O manual diz que o MD5 divergente NÃO impede a recepção, mas serve de
 * identificador para consultar a situação do arquivo depois. Por isso ele é
 * gravado em farmacia_sngpc_transmissoes.md5.
 *
 * ⚠ NÃO TESTADO CONTRA A ANVISA. O acesso ao ambiente de homologação depende
 * do RT credenciado (e-mail e senha do RT Transmissor), que não existe para o
 * tenant de laboratório. O que está coberto por teste é o envelope — zip,
 * base64, MD5 e a montagem do envelope SOAP. A chamada de rede em si só pode
 * ser exercitada quando houver credencial.
 *
 * Existe também uma API REST nova da ANVISA, que deve substituir este
 * webservice (o próprio site marca o legado como "a ser desativado"). A
 * documentação dela está atrás de bloqueio a acesso automatizado; migrar é
 * trabalho para quando houver credencial e acesso ao Swagger.
 */

const crypto = require('crypto');
const AdmZip = require('adm-zip');
const axios = require('axios');

const ENDPOINTS = {
  homologacao: 'http://homologacao.anvisa.gov.br/sngpc/webservice/sngpc.asmx',
  producao: 'http://sngpc.anvisa.gov.br/webservice/sngpc.asmx',
};

/**
 * XML → zip → base64. O nome do arquivo dentro do zip não é especificado pelo
 * manual; usamos o padrão do próprio sistema.
 */
function compactarEBase64(xml, nomeArquivo = 'sngpc.xml') {
  const zip = new AdmZip();
  // iso-8859-1 porque é o encoding declarado no XML do guia da ANVISA.
  zip.addFile(nomeArquivo, Buffer.from(xml, 'latin1'));
  return zip.toBuffer().toString('base64');
}

/** MD5 sobre o valor em base64, como o manual descreve. */
function hashIdentificacao(base64) {
  return crypto.createHash('md5').update(base64, 'utf8').digest('hex');
}

function escaparXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function envelopeSoap(metodo, parametros) {
  const corpo = Object.entries(parametros)
    .map(([k, v]) => `<${k}>${escaparXml(v)}</${k}>`).join('');
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
    + ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
    + ' xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
    + `<soap:Body><${metodo} xmlns="http://tempuri.org/">${corpo}</${metodo}></soap:Body>`
    + '</soap:Envelope>';
}

function extrairResultado(respostaXml, metodo) {
  const m = new RegExp(`<${metodo}Result[^>]*>([\\s\\S]*?)</${metodo}Result>`).exec(respostaXml || '');
  return m ? m[1].trim() : null;
}

async function chamar(ambiente, metodo, parametros, { timeoutMs = 120000 } = {}) {
  const url = ENDPOINTS[ambiente];
  if (!url) throw new Error(`SNGPC: ambiente inválido "${ambiente}"`);
  const r = await axios.post(url, envelopeSoap(metodo, parametros), {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `http://tempuri.org/${metodo}`,
    },
    timeout: timeoutMs,
    // A resposta é texto; deixar o axios adivinhar JSON só atrapalha.
    responseType: 'text',
    transformResponse: [(d) => d],
  });
  return { bruto: r.data, resultado: extrairResultado(r.data, metodo) };
}

async function validarUsuario(ambiente, { email, senha }) {
  return chamar(ambiente, 'ValidarUsuario', { Email: email, Senha: senha });
}

/**
 * Envia o XML já pronto. Devolve o que a ANVISA respondeu mais o que foi
 * calculado localmente, para gravação.
 */
async function enviarArquivo(ambiente, { email, senha, xml, nomeArquivo }) {
  const base64 = compactarEBase64(xml, nomeArquivo);
  const md5 = hashIdentificacao(base64);
  const { bruto, resultado } = await chamar(ambiente, 'EnviaArquivoSNGPC', {
    Email: email, Senha: senha, Arq: base64, Hashindenficacacao: md5,
  });
  // O manual define o texto de sucesso: "Arquivo recebido com sucesso, em ...".
  const aceito = !!resultado && /recebido com sucesso/i.test(resultado);
  return { aceito, resposta: resultado, bruto, md5, tamanhoBase64: base64.length };
}

module.exports = {
  ENDPOINTS,
  compactarEBase64,
  hashIdentificacao,
  envelopeSoap,
  extrairResultado,
  validarUsuario,
  enviarArquivo,
};
