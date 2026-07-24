// Adiciona colunas de configuração do PDV em nfce_config (idempotente).
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const TENANTS = '/home/carlosfinezi/web/liciteagora.com.br/private/data/tenants';

const alters = [
  `ALTER TABLE nfce_config ADD COLUMN pdvModeloPadrao TEXT DEFAULT ''`,
  `ALTER TABLE nfce_config ADD COLUMN pdvFormaPagamentoPadrao TEXT DEFAULT '01'`,
  `ALTER TABLE nfce_config ADD COLUMN pdvExigirCpfSempre INTEGER DEFAULT 0`,
  `ALTER TABLE nfce_config ADD COLUMN pdvExigirClienteCadastrado INTEGER DEFAULT 0`,
];

for (const slug of fs.readdirSync(TENANTS)) {
  const dbp = path.join(TENANTS, slug, 'pncp.db');
  if (!fs.existsSync(dbp)) continue;
  const db = new Database(dbp);
  let ok = 0, skip = 0;
  for (const sql of alters) {
    try { db.exec(sql); ok++; } catch (_) { skip++; }
  }
  console.log(`[${slug}] ok=${ok} skip=${skip}`);
  db.close();
}
