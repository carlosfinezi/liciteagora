#!/usr/bin/env node
// Senha do certificado A1 cifrada (cert-senha.js). Banco em memória, pfx
// gerado aqui mesmo: nada de data/, nada de SEFAZ.
//
// O que se guarda, e por que cada checagem reprovaria se o defeito voltasse:
//  - o banco sozinho não abre o pfx: base64 do valor gravado não é a senha;
//  - sem a chave, ler a senha cifrada FALHA (não devolve vazio nem lixo);
//  - senha copiada para a linha de outro certificado não decifra;
//  - gravar sem chave é recusado: nunca mais nasce senha em base64;
//  - a migração cifra as antigas, e o carregarCert da NF-e lê o que ela gravou.

const assert = require('assert');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const forge = require('node-forge');

let falhas = 0;
const ok = (nome, fn) => {
  try { fn(); console.log('  ok  ' + nome); } catch (e) { falhas++; console.log('FALHA ' + nome + ': ' + e.message); }
};

function gerarPfx(senha, cn) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86400e3 * 365);
  const attrs = [{ name: 'commonName', value: cn }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
}
const abre = (pfx, senha) => {
  try { forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(Buffer.from(pfx, 'base64').toString('binary')), senha); return true; }
  catch { return false; }
};

const CHAVE = crypto.randomBytes(32).toString('hex');
const semChave = (fn) => { const k = process.env.LICITEAGORA_CHAVE_CERT; delete process.env.LICITEAGORA_CHAVE_CERT; try { return fn(); } finally { if (k !== undefined) process.env.LICITEAGORA_CHAVE_CERT = k; } };
process.env.LICITEAGORA_CHAVE_CERT = CHAVE;

const cs = require('../cert-senha');
const SENHA = 'Flor@2026 ção';
const pfxA = gerarPfx(SENHA, 'EMPRESA A');
const pfxB = gerarPfx('outra', 'EMPRESA B');

console.log('Cifra');
ok('cifra e decifra a mesma senha, com acento', () => {
  const v = cs.cifrarSenha(SENHA, pfxA);
  assert.ok(v.startsWith('v1.'));
  assert.strictEqual(cs.decifrarSenha(v, pfxA), SENHA);
});
ok('duas cifras da mesma senha são diferentes (iv aleatório)', () => {
  assert.notStrictEqual(cs.cifrarSenha(SENHA, pfxA), cs.cifrarSenha(SENHA, pfxA));
});
ok('o banco sozinho não abre o pfx', () => {
  const v = cs.cifrarSenha(SENHA, pfxA);
  assert.ok(!v.includes(SENHA));
  assert.strictEqual(abre(pfxA, Buffer.from(v, 'base64').toString('utf8')), false);
  assert.strictEqual(abre(pfxA, v), false);
  assert.strictEqual(abre(pfxA, SENHA), true, 'controle: a senha certa abre');
});
ok('sem a chave, ler a senha cifrada falha com erro', () => {
  const v = cs.cifrarSenha(SENHA, pfxA);
  semChave(() => assert.throws(() => cs.decifrarSenha(v, pfxA), /LICITEAGORA_CHAVE_CERT/));
});
ok('chave errada não decifra', () => {
  const v = cs.cifrarSenha(SENHA, pfxA);
  const k = process.env.LICITEAGORA_CHAVE_CERT;
  process.env.LICITEAGORA_CHAVE_CERT = crypto.randomBytes(32).toString('hex');
  try { assert.throws(() => cs.decifrarSenha(v, pfxA)); } finally { process.env.LICITEAGORA_CHAVE_CERT = k; }
});
ok('senha copiada para outro certificado não decifra', () => {
  const v = cs.cifrarSenha(SENHA, pfxA);
  assert.throws(() => cs.decifrarSenha(v, pfxB));
});
ok('gravar sem chave é recusado', () => {
  semChave(() => assert.throws(() => cs.cifrarSenha(SENHA, pfxA), /LICITEAGORA_CHAVE_CERT/));
});
ok('formato antigo (base64) continua legível até migrar', () => {
  assert.strictEqual(cs.decifrarSenha(Buffer.from(SENHA).toString('base64'), pfxA), SENHA);
});

console.log('Migração');
const novoBanco = () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE certificado_digital (id INTEGER PRIMARY KEY AUTOINCREMENT, certificadoBase64 TEXT,
    senhaCriptografada TEXT, titular TEXT, validade TEXT, dataAtualizacao TEXT, estabelecimentoId INTEGER)`);
  db.prepare('INSERT INTO certificado_digital (id, certificadoBase64, senhaCriptografada) VALUES (1, ?, ?)')
    .run(pfxA, Buffer.from(SENHA).toString('base64'));
  db.prepare('INSERT INTO certificado_digital (id, certificadoBase64, senhaCriptografada, estabelecimentoId) VALUES (2, ?, ?, 7)')
    .run(pfxB, Buffer.from('outra').toString('base64'));
  return db;
};
ok('sem chave a migração não toca nada e conta as pendentes', () => {
  const db = novoBanco();
  const r = semChave(() => cs.migrarSenhas(db));
  assert.deepStrictEqual(r, { migradas: 0, pendentes: 2 });
  assert.ok(!db.prepare('SELECT senhaCriptografada s FROM certificado_digital WHERE id = 1').get().s.startsWith('v1.'));
});
ok('com chave cifra todas, e a segunda rodada não refaz', () => {
  const db = novoBanco();
  assert.deepStrictEqual(cs.migrarSenhas(db), { migradas: 2, pendentes: 0 });
  assert.deepStrictEqual(cs.migrarSenhas(db), { migradas: 0, pendentes: 0 });
  for (const r of db.prepare('SELECT * FROM certificado_digital').all()) {
    assert.ok(r.senhaCriptografada.startsWith('v1.'));
    assert.strictEqual(abre(r.certificadoBase64, Buffer.from(r.senhaCriptografada, 'base64').toString('utf8')), false);
    assert.strictEqual(abre(r.certificadoBase64, cs.decifrarSenha(r.senhaCriptografada, r.certificadoBase64)), true);
  }
});
ok('carregarCert da NF-e lê a senha migrada, matriz e filial', () => {
  const db = novoBanco();
  cs.migrarSenhas(db);
  const nfe = require('../nfe-emit-routes');
  assert.strictEqual(nfe.carregarCert(db).senha, SENHA);
  assert.strictEqual(nfe.carregarCert(db, { id: 7, matriz: 0 }).senha, 'outra');
});

console.log('Gravação pela rota');
ok('POST /api/certificado grava cifrado e responde o titular', () => {
  const db = novoBanco();
  db.exec('CREATE TABLE estabelecimentos (id INTEGER PRIMARY KEY, matriz INTEGER, nomeFantasia TEXT, razaoSocial TEXT, ativo INTEGER DEFAULT 1)');
  const rotas = {};
  const app = { get: (p, h) => { rotas['GET ' + p] = h; }, post: (p, h) => { rotas['POST ' + p] = h; }, delete: (p, h) => { rotas['DELETE ' + p] = h; } };
  require('../certificado-routes').registrarRotasCertificado(app, db);
  let resposta;
  const res = { status() { return this; }, json(j) { resposta = j; } };
  rotas['POST /api/certificado']({ body: { certificado: pfxA, senha: SENHA }, session: {}, headers: {} }, res);
  assert.strictEqual(resposta.success, true, JSON.stringify(resposta));
  const s = db.prepare('SELECT senhaCriptografada s FROM certificado_digital WHERE id = 1').get().s;
  assert.ok(s.startsWith('v1.'), 'gravou fora do formato cifrado: ' + s.slice(0, 10));
  assert.strictEqual(cs.decifrarSenha(s, pfxA), SENHA);
});

// ─── Certificado em memória (cert-memoria.js) ─────────────────────────────
// O pacote `pem`, que a node-sped-nfe usa, gravava o pfx, a senha e a chave
// aberta em /tmp (0644) a cada consulta à SEFAZ. Estes casos reprovam se a
// leitura voltar a tocar em disco ou a abrir processo.
console.log('Certificado em memória');
const cm = require('../cert-memoria');
const nodeCrypto = require('crypto');
function pfxComCadeia(senha) {
  const ca = forge.pki.rsa.generateKeyPair(1024), fim = forge.pki.rsa.generateKeyPair(1024);
  const mk = (pub, serial, cn) => { const c = forge.pki.createCertificate(); c.publicKey = pub; c.serialNumber = serial;
    c.validity.notBefore = new Date(); c.validity.notAfter = new Date(Date.now() + 864e5 * 30);
    c.setSubject([{ name: 'commonName', value: cn }]); return c; };
  const cCa = mk(ca.publicKey, '0a', 'AC TESTE'); cCa.setIssuer(cCa.subject.attributes); cCa.sign(ca.privateKey);
  const cFim = mk(fim.publicKey, '0b', 'EMPRESA C'); cFim.setIssuer(cCa.subject.attributes); cFim.sign(ca.privateKey);
  // A cadeia vem ANTES do titular de propósito: a leitura precisa achá-lo pela chave, não pela posição.
  const p12 = forge.pkcs12.toPkcs12Asn1(fim.privateKey, [cCa, cFim], senha, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}
ok('a chave e o certificado lidos em memória batem, e o TLS os aceita', () => {
  const r = cm.lerPkcs12EmMemoria(Buffer.from(pfxA, 'base64'), SENHA);
  assert.ok(/BEGIN RSA PRIVATE KEY/.test(r.key), 'chave fora do formato PKCS#1 que o pem entregava');
  assert.ok(new nodeCrypto.X509Certificate(r.cert).checkPrivateKey(nodeCrypto.createPrivateKey(r.key)), 'chave não corresponde ao certificado');
  require('tls').createSecureContext({ key: r.key, cert: r.cert });
});
ok('com cadeia, o titular é achado pela chave e o resto vira ca', () => {
  const r = cm.lerPkcs12EmMemoria(pfxComCadeia('x1'), 'x1');
  assert.ok(new nodeCrypto.X509Certificate(r.cert).subject.includes('EMPRESA C'), 'pegou o certificado errado como titular');
  assert.strictEqual(r.ca.length, 1);
});
ok('senha errada falha', () => {
  assert.throws(() => cm.lerPkcs12EmMemoria(Buffer.from(pfxA, 'base64'), 'errada'));
});

const assincronos = [];
const okAsync = (nome, fn) => assincronos.push([nome, fn]);
okAsync('pem.readPkcs12 instalado não grava arquivo nem abre processo', async () => {
  cm.instalar();
  const fs = require('fs'), cp = require('child_process');
  const orig = { w: fs.writeFileSync, wa: fs.writeFile, s: cp.spawn, e: cp.execFile };
  const toques = [];
  fs.writeFileSync = (...a) => { toques.push('writeFileSync ' + a[0]); return orig.w.apply(fs, a); };
  fs.writeFile = (...a) => { toques.push('writeFile ' + a[0]); return orig.wa.apply(fs, a); };
  cp.spawn = (...a) => { toques.push('spawn ' + a[0]); return orig.s.apply(cp, a); };
  cp.execFile = (...a) => { toques.push('execFile ' + a[0]); return orig.e.apply(cp, a); };
  try {
    const r = await new Promise((res, rej) => require('pem').readPkcs12(Buffer.from(pfxA, 'base64'), { p12Password: SENHA },
      (e, v) => (e ? rej(e) : res(v))));
    assert.ok(r.key && r.cert, 'não devolveu chave e certificado');
    const errada = await new Promise((res) => require('pem').readPkcs12(Buffer.from(pfxA, 'base64'), { p12Password: 'x' }, (e) => res(e)));
    assert.ok(errada, 'senha errada não devolveu erro');
  } finally { fs.writeFileSync = orig.w; fs.writeFile = orig.wa; cp.spawn = orig.s; cp.execFile = orig.e; }
  assert.deepStrictEqual(toques, [], 'tocou em disco ou abriu processo: ' + toques.join(', '));
});
okAsync('status do PA em produção vai à SVRS com o cUF 15 e o certificado em memória', async () => {
  const db = novoBanco();
  db.exec(`CREATE TABLE nfe_config (id INTEGER PRIMARY KEY, tpAmb INTEGER);
    INSERT INTO nfe_config VALUES (1, 1);
    CREATE TABLE fornecedor (id INTEGER PRIMARY KEY, cnpj TEXT, uf TEXT, inscricaoEstadual TEXT);
    INSERT INTO fornecedor VALUES (1, '11222333000181', 'PA', '150000000')`);
  cs.migrarSenhas(db);
  const https = require('https');
  const orig = https.request;
  let visto = null;
  https.request = (url, opts, cb) => {
    visto = { url, opts, corpo: '' };
    const { EventEmitter } = require('events');
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.end = (b) => { visto.corpo = String(b); const res = new EventEmitter(); cb(res);
      res.emit('data', '<retConsStatServ><cStat>107</cStat><cUF>15</cUF></retConsStatServ>'); res.emit('end'); };
    return req;
  };
  try {
    const r = await require('../nfe-emit-routes').consultarStatusSefaz(db);
    assert.ok(/<cStat>107/.test(r));
  } finally { https.request = orig; }
  assert.strictEqual(visto.url, 'https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx');
  assert.ok(/<cUF>15<\/cUF>/.test(visto.corpo), 'cUF do PA ausente: ' + visto.corpo);
  assert.ok(/<tpAmb>1<\/tpAmb>/.test(visto.corpo));
  assert.ok(visto.opts.key && visto.opts.cert && !visto.opts.pfx, 'certificado não foi em memória');
});

(async () => {
  for (const [nome, fn] of assincronos) {
    try { await fn(); console.log('  ok  ' + nome); } catch (e) { falhas++; console.log('FALHA ' + nome + ': ' + e.message); }
  }
  console.log(falhas ? `\nFALHOU: ${falhas}` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})();
