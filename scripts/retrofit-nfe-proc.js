/**
 * retrofit-nfe-proc.js — Reenvelopa xmlAssinado de faturas (NF-e 55) e nfce (NFC-e 65)
 * que foram gravados com NFe + protNFe como roots irmãos (formato inválido SEFAZ).
 *
 * Uso:
 *   node scripts/retrofit-nfe-proc.js          # dry-run, mostra contagem
 *   node scripts/retrofit-nfe-proc.js --apply  # aplica UPDATE em todos tenants
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { reenveloparExistente } = require('../nfe-proc');

const TENANTS = '/home/carlosfinezi/web/liciteagora.com.br/private/data/tenants';
const APPLY = process.argv.includes('--apply');

function tabelaExiste(db, nome) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nome);
}

function processarTabela(db, tabela, slug) {
  if (!tabelaExiste(db, tabela)) return { lidos: 0, corrigidos: 0, jaOk: 0, semProt: 0 };

  const rows = db.prepare(`SELECT id, xmlAssinado FROM ${tabela} WHERE xmlAssinado IS NOT NULL AND xmlAssinado != ''`).all();
  const stmt = db.prepare(`UPDATE ${tabela} SET xmlAssinado = ? WHERE id = ?`);

  let corrigidos = 0, jaOk = 0, semProt = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const xml = String(r.xmlAssinado);
      if (xml.includes('<nfeProc')) { jaOk++; continue; }
      if (!xml.includes('<protNFe')) { semProt++; continue; }
      const novo = reenveloparExistente(xml);
      if (!novo) { semProt++; continue; }
      if (APPLY) stmt.run(novo, r.id);
      corrigidos++;
    }
  });
  tx();
  return { lidos: rows.length, corrigidos, jaOk, semProt };
}

const tenants = fs.readdirSync(TENANTS).filter(s => fs.existsSync(path.join(TENANTS, s, 'pncp.db')));
console.log(`Modo: ${APPLY ? 'APPLY' : 'DRY-RUN'} · ${tenants.length} tenant(s)\n`);

const totais = { faturas: { lidos: 0, corrigidos: 0, jaOk: 0, semProt: 0 }, nfce: { lidos: 0, corrigidos: 0, jaOk: 0, semProt: 0 } };
for (const slug of tenants) {
  const dbp = path.join(TENANTS, slug, 'pncp.db');
  const db = new Database(dbp);
  try {
    const f = processarTabela(db, 'faturas', slug);
    const n = processarTabela(db, 'nfce', slug);
    if (f.lidos || n.lidos) {
      console.log(`[${slug}] faturas: ${f.corrigidos}/${f.lidos} corrigidos · jaOk=${f.jaOk} · semProt=${f.semProt}`);
      console.log(`[${slug}] nfce:    ${n.corrigidos}/${n.lidos} corrigidos · jaOk=${n.jaOk} · semProt=${n.semProt}`);
    }
    for (const k of ['lidos', 'corrigidos', 'jaOk', 'semProt']) {
      totais.faturas[k] += f[k];
      totais.nfce[k] += n[k];
    }
  } finally {
    db.close();
  }
}

console.log('\n=== TOTAL ===');
console.log(`faturas: ${totais.faturas.corrigidos}/${totais.faturas.lidos} corrigidos · jaOk=${totais.faturas.jaOk} · semProt=${totais.faturas.semProt}`);
console.log(`nfce:    ${totais.nfce.corrigidos}/${totais.nfce.lidos} corrigidos · jaOk=${totais.nfce.jaOk} · semProt=${totais.nfce.semProt}`);
if (!APPLY) console.log('\n(dry-run · rode com --apply para gravar)');
