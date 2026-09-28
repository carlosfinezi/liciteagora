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

console.log(falhas ? `\nFALHOU: ${falhas}` : '\nTudo certo');
process.exit(falhas ? 1 : 0);
