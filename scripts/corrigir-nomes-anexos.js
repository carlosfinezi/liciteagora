/**
 * corrigir-nomes-anexos.js — conserta o nome de anexos gravados em latin1.
 *
 * O busboy (dentro do multer) decodifica o nome do arquivo como latin1 quando
 * o multipart não declara charset, que é o caso de todo navegador. Até
 * 2026-08-20 esse nome ia direto para o banco: "Autorização.pdf" virava
 * "AutorizaÃ§Ã£o.pdf" na tela e no download. O upload já grava certo — este
 * script cuida do que entrou antes.
 *
 * Uso:
 *   node scripts/corrigir-nomes-anexos.js                     # simula, todos
 *   node scripts/corrigir-nomes-anexos.js --aplicar           # grava, todos
 *   node scripts/corrigir-nomes-anexos.js --tenant=1bit ...   # limita a um
 *
 * Só mexe em linha cuja reinterpretação produz UTF-8 válido: nome já correto
 * ou ASCII puro fica intacto. Idempotente — rodar de novo não muda nada.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { nomeOriginalUtf8 } = require('../upload-anexos');

const ROOT = path.join(__dirname, '..');
const TENANTS = path.join(ROOT, 'data', 'tenants');
const aplicar = process.argv.includes('--aplicar');
// Escrita em banco de produção: dá para limitar a um tenant, para aplicar só
// onde foi autorizado.
const argTenant = process.argv.find(a => a.startsWith('--tenant='));
const somenteTenant = argTenant ? argTenant.slice('--tenant='.length) : null;

// tabela -> coluna que guarda o nome exibido
const ALVOS = [
  ['contratos_anexos', 'nomeOriginal'],
  ['contas_pagar_anexos', 'nomeOriginal'],
  ['contas_receber_anexos', 'nomeOriginal'],
  ['os_anexos', 'nomeOriginal'],
  ['pessoas_anexos', 'nome'],
];

let total = 0;

for (const slug of fs.readdirSync(TENANTS).sort()) {
  if (somenteTenant && slug !== somenteTenant) continue;
  const dbPath = path.join(TENANTS, slug, 'pncp.db');
  if (!fs.existsSync(dbPath)) continue;
  const db = new Database(dbPath);

  for (const [tabela, coluna] of ALVOS) {
    let linhas;
    try {
      linhas = db.prepare(`SELECT id, ${coluna} AS nome FROM ${tabela}`).all();
    } catch (_) {
      continue;   // tenant sem a tabela
    }
    const upd = db.prepare(`UPDATE ${tabela} SET ${coluna} = ? WHERE id = ?`);
    for (const l of linhas) {
      const novo = nomeOriginalUtf8(l.nome);
      if (novo === l.nome) continue;
      console.log(`${slug}/${tabela}#${l.id}`);
      console.log(`   de: ${l.nome}`);
      console.log(`  por: ${novo}`);
      if (aplicar) upd.run(novo, l.id);
      total++;
    }
  }
  db.close();
}

console.log(`\n${aplicar ? 'CORRIGIDOS' : 'a corrigir (simulação)'}: ${total} nome(s)`);
if (!aplicar && total) console.log('nada foi gravado — rode com --aplicar para valer');
