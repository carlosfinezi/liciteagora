/**
 * listar-documentos-invalidos.js — as fichas com CPF/CNPJ de dígito errado.
 *
 * SOMENTE LEITURA: abre cada banco com `readonly` e não escreve nada.
 *
 * Existe porque a conferência do documento passou a valer em 30/09/2026 no
 * cadastro NOVO, e as fichas antigas com dígito errado não travam — elas ficam
 * aqui, para correção à mão. Medido naquele dia: 8 fichas em 28.096 documentos.
 *
 * O identificador interno do sistema NÃO entra nesta lista: `SD-` (lead sem
 * CNPJ), `EX-` (fornecedor de fora), `UASG-` (órgão) e `TARIFA-` são padrões
 * deliberados, e são 9.783 fichas. Quem decide isso é o `erroDeDocumento`.
 *
 *   node scripts/listar-documentos-invalidos.js
 *   node scripts/listar-documentos-invalidos.js --tenant 1bit
 */
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const Database = require(path.join(RAIZ, 'node_modules', 'better-sqlite3'));
const { erroDeDocumento } = require(path.join(RAIZ, 'pessoa-sem-documento'));

const args = process.argv.slice(2);
for (const a of args) {
  if (a !== '--tenant' && !args[args.indexOf('--tenant') + 1] === a) {
    if (a.startsWith('--') && a !== '--tenant') {
      console.error(`argumento desconhecido: ${a}`);
      process.exit(2);
    }
  }
}
const soTenant = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : null;

const BASE = path.join(RAIZ, 'data', 'tenants');
let totDocs = 0, totInvalidos = 0, totInternos = 0;
const achados = [];

for (const slug of fs.readdirSync(BASE).sort()) {
  if (soTenant && slug !== soTenant) continue;
  const arq = path.join(BASE, slug, 'pncp.db');
  if (!fs.existsSync(arq)) continue;
  let db;
  try {
    db = new Database(arq, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.error(`${slug}: não abriu (${e.message})`);
    continue;
  }
  try {
    const temTabela = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pessoas'"
    ).get();
    if (!temTabela) { db.close(); continue; }
    const linhas = db.prepare(
      'SELECT id, cpfCnpj, razaoSocial, ativo FROM pessoas '
      + 'WHERE cpfCnpj IS NOT NULL AND LENGTH(TRIM(cpfCnpj)) > 0'
    ).all();
    for (const l of linhas) {
      totDocs++;
      if (/[a-zA-Z]/.test(String(l.cpfCnpj))) { totInternos++; continue; }
      if (erroDeDocumento(l.cpfCnpj)) {
        totInvalidos++;
        achados.push({ slug, ...l, porque: erroDeDocumento(l.cpfCnpj) });
      }
    }
  } catch (e) {
    console.error(`${slug}: ${e.message}`);
  }
  db.close();
}

if (achados.length) {
  console.log('FICHAS COM DOCUMENTO DE DÍGITO ERRADO — corrigir à mão no cadastro\n');
  console.log(`${'tenant'.padEnd(22)}${'id'.padStart(7)}  ${'documento'.padEnd(20)}${'ativo'.padEnd(7)}razão social`);
  for (const a of achados) {
    console.log(
      `${a.slug.padEnd(22)}${String(a.id).padStart(7)}  ${String(a.cpfCnpj).padEnd(20)}`
      + `${(Number(a.ativo) === 1 ? 'sim' : 'não').padEnd(7)}${String(a.razaoSocial || '').slice(0, 40)}`
    );
  }
  console.log('');
}

console.log(`documentos gravados:            ${totDocs}`);
console.log(`identificador interno do sistema: ${totInternos}  (SD-, EX-, UASG-, TARIFA- — não são erro)`);
console.log(`com dígito errado:              ${totInvalidos}`);
if (!totInvalidos) console.log('\nNenhuma ficha para corrigir.');
