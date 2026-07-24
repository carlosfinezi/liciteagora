import Database from 'better-sqlite3';
import { Tools } from 'node-sped-nfe';
const db = new Database('pncp.db', { readonly: true });
const cert = db.prepare('SELECT * FROM certificado_digital WHERE id = 1').get();
const fornec = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get();
const pfxBuffer = Buffer.from(cert.certificadoBase64, 'base64');
const senha = Buffer.from(cert.senhaCriptografada, 'base64').toString('utf-8');
const tools = new Tools({ mod:'55', tpAmb:2, UF: fornec.uf, versao:'4.00' }, { pfx: pfxBuffer, senha });
try {
  const res = await tools.sefazStatus();
  console.log('STATUS:', JSON.stringify(res, null, 2));
} catch (err) {
  console.log('CATCH err type:', typeof err, 'value:', err);
  console.log('Keys:', err ? Object.keys(err) : 'null');
  if (err && err.stack) console.log('Stack:', err.stack);
}
