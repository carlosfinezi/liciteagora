/**
 * teste-nfe-status.mjs — Testa conexão SEFAZ em homologação
 * Usa certificado e UF do banco (fornecedor + certificado_digital).
 * Run: node teste-nfe-status.mjs
 */
import Database from 'better-sqlite3';
import { Tools } from 'node-sped-nfe';

const db = new Database('pncp.db', { readonly: true });
const cert = db.prepare('SELECT certificadoBase64, senhaCriptografada, titular, validade FROM certificado_digital WHERE id = 1').get();
if (!cert) { console.error('Sem certificado cadastrado'); process.exit(1); }

const fornec = db.prepare('SELECT razaoSocial, cnpj, uf FROM fornecedor ORDER BY id DESC LIMIT 1').get();
if (!fornec || !fornec.uf) { console.error('Fornecedor sem UF cadastrada'); process.exit(1); }

const pfxBuffer = Buffer.from(cert.certificadoBase64, 'base64');
const senha = Buffer.from(cert.senhaCriptografada, 'base64').toString('utf-8');

console.log('=== Teste SEFAZ NF-e (homologação) ===');
console.log('Emitente :', fornec.razaoSocial, '|', fornec.cnpj);
console.log('UF       :', fornec.uf);
console.log('Titular  :', cert.titular);
console.log('Validade :', cert.validade);
console.log('Cert pfx :', pfxBuffer.length, 'bytes');
console.log('');

const tools = new Tools(
  { mod: '55', tpAmb: 2, UF: fornec.uf, versao: '4.00' },
  { pfx: pfxBuffer, senha }
);

try {
  console.log('Consultando status SEFAZ…');
  const res = await tools.sefazStatus();
  console.log('--- RESPOSTA ---');
  console.log(JSON.stringify(res, null, 2));
} catch (err) {
  console.error('ERRO:', err.message);
  console.error(err.stack);
  process.exit(2);
}
