#!/usr/bin/env node
// parse-aborts-from-logs.cjs
//
// Vasculha logs do master + journalctl dos 3 VPSs procurando "[abort-dia] YYYY-MM-DD mod N: ..."
// e popula catalog.bi_aborts com os dias pulados pra retry posterior.
//
// Idempotente — INSERT OR IGNORE via UNIQUE(dia, modalidade). Re-rodar não duplica.

const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const catalog = new Database('/home/carlosfinezi/web/liciteagora.com.br/private/data/catalog.db');
catalog.pragma('busy_timeout = 30000');

const stmtInsert = catalog.prepare(`
  INSERT OR IGNORE INTO bi_aborts (dia, modalidade, servidor, motivo)
  VALUES (?, ?, ?, ?)
`);

// Regex: [abort-dia] 2024-11-30 mod 1: 3 páginas seguidas...
const REGEX = /\[abort-dia\]\s+(\d{4}-\d{2}-\d{2})\s+mod\s+(\d+):\s*(.+?)(?=$|\n)/g;

function processLog(text, servidor) {
  let inserted = 0;
  let matches = 0;
  let m;
  while ((m = REGEX.exec(text)) !== null) {
    matches++;
    const dia = m[1];
    const mod = parseInt(m[2], 10);
    const motivo = m[3].substring(0, 100);
    try {
      const r = stmtInsert.run(dia, mod, servidor, motivo);
      if (r.changes > 0) inserted++;
    } catch (e) { /* ignore */ }
  }
  return { matches, inserted };
}

// 1) Logs do master (principal)
console.log('=== Servidor principal (server.log) ===');
try {
  const log = execSync('tail -500000 /home/carlosfinezi/web/liciteagora.com.br/private/server.log', { encoding: 'utf-8', maxBuffer: 500*1024*1024 });
  const r = processLog(log, 'principal');
  console.log(`  ${r.matches} matches, ${r.inserted} novos inseridos`);
} catch (e) { console.error('  erro:', e.message); }

// 2) journalctl dos 3 VPSs via SSH
const VPSS = [
  { nome: 'hostinger', ssh: 'carlosfinezi@62.146.227.189', key: '/tmp/uploads-1bit/id_homologacao' },
  { nome: 'contabo1',  ssh: 'cloud-user@147.93.147.40',   key: '/tmp/uploads-1bit/contabo_ssh' },
  { nome: 'contabo2',  ssh: 'cloud-user@147.93.147.183',  key: '/tmp/uploads-1bit/contabo_ssh' },
];

for (const vps of VPSS) {
  console.log(`=== ${vps.nome} (${vps.ssh}) ===`);
  try {
    const log = execSync(
      `ssh -i ${vps.key} -o StrictHostKeyChecking=no -o BatchMode=yes ${vps.ssh} 'sudo journalctl -u vps-pncp-sync.service --no-pager --since "24 hours ago"'`,
      { encoding: 'utf-8', maxBuffer: 200*1024*1024, timeout: 60000 }
    );
    const r = processLog(log, vps.nome);
    console.log(`  ${r.matches} matches, ${r.inserted} novos inseridos`);
  } catch (e) { console.error('  erro:', e.message); }
}

// Estatísticas finais
const stats = catalog.prepare(`
  SELECT servidor, COUNT(*) AS total,
         SUM(CASE WHEN resolvidoEm IS NULL THEN 1 ELSE 0 END) AS pendentes,
         MIN(dia) AS dia_mais_antigo, MAX(dia) AS dia_mais_recente
    FROM bi_aborts GROUP BY servidor
`).all();
console.log('\n=== Resumo bi_aborts ===');
stats.forEach(s => console.log(`  ${s.servidor}: ${s.total} total (${s.pendentes} pendentes) — ${s.dia_mais_antigo} → ${s.dia_mais_recente}`));

const tot = catalog.prepare('SELECT COUNT(*) c FROM bi_aborts').get();
console.log(`\nTOTAL: ${tot.c} (dia, modalidade) abortos registrados`);
