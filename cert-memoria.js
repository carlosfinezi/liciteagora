// cert-memoria.js
//
// O certificado A1 aberto EM MEMÓRIA para a node-sped-nfe, sem arquivo.
//
// A biblioteca abre o pfx com `pem.readPkcs12`, e o pacote `pem` faz isso
// rodando o `openssl`: grava o pfx, a senha e, num segundo passo, a chave
// privada JÁ ABERTA em arquivos no diretório temporário do sistema (/tmp,
// porque as units não têm PrivateTmp), com permissão 644, e só os apaga no
// callback. Se o processo morre ou sai antes do callback, os arquivos ficam:
// em 27/09/2026 sobraram quatro em /tmp, legíveis por qualquer usuário, com o
// pfx e a senha de dois tenants.
//
// Aqui o `readPkcs12` do `pem` é trocado por uma leitura com o node-forge (o
// mesmo que valida o upload em certificado-routes.js). Devolve o mesmo pacote
// que a biblioteca espera, `{ key, cert, ca }`, com a chave em PEM PKCS#1
// ("RSA PRIVATE KEY"), o formato em que o pem a entregava. Nada vai a disco e
// nenhum processo `openssl` é aberto.
//
// A troca vale para o processo inteiro, porque a biblioteca importa a mesma
// instância do `pem` (cache de módulos do Node) e procura `readPkcs12` na hora
// da chamada. Quem cria `Tools` chama `instalar()` antes: nfe-emit-routes.js e
// nfce-routes.js o fazem ao carregar.

const forge = require('node-forge');

let original = null;

function lerPkcs12EmMemoria(pfx, senha) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(Buffer.from(pfx).toString('binary')), senha);
  const chaves = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ].map((b) => b.key).filter(Boolean);
  if (!chaves.length) throw new Error('O certificado não contém chave privada');
  const chave = chaves[0];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [])
    .map((b) => b.cert).filter(Boolean);
  // O certificado do titular é o que casa com a chave; o resto é a cadeia.
  const doTitular = certs.find((c) => c.publicKey && c.publicKey.n && c.publicKey.n.equals(chave.n));
  if (!doTitular) throw new Error('Nenhum certificado do pfx corresponde à chave privada');
  return {
    key: forge.pki.privateKeyToPem(chave),
    cert: forge.pki.certificateToPem(doTitular),
    ca: certs.filter((c) => c !== doTitular).map((c) => forge.pki.certificateToPem(c)),
  };
}

function instalar() {
  const pem = require('pem');
  if (pem.readPkcs12 && pem.readPkcs12.__emMemoria) return;
  original = pem.readPkcs12;
  const substituto = function readPkcs12(bufferOrPath, options, callback) {
    if (!callback && typeof options === 'function') { callback = options; options = {}; }
    // Caminho de arquivo nunca é o nosso caso; fica com o comportamento antigo.
    if (!Buffer.isBuffer(bufferOrPath)) return original.call(this, bufferOrPath, options, callback);
    let r, erro = null;
    try { r = lerPkcs12EmMemoria(bufferOrPath, (options && options.p12Password) || ''); }
    catch (e) { erro = e; }
    process.nextTick(() => callback(erro, erro ? undefined : r));
  };
  substituto.__emMemoria = true;
  pem.readPkcs12 = substituto;
}

module.exports = { instalar, lerPkcs12EmMemoria };
