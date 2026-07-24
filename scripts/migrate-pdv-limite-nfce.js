const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const TENANTS = '/home/carlosfinezi/web/liciteagora.com.br/private/data/tenants';
for (const slug of fs.readdirSync(TENANTS)) {
  const dbp = path.join(TENANTS, slug, 'pncp.db');
  if (!fs.existsSync(dbp)) continue;
  const db = new Database(dbp);
  try { db.exec('ALTER TABLE nfce_config ADD COLUMN limiteNFCe REAL DEFAULT 10000'); console.log(`[${slug}] limiteNFCe adicionado`); }
  catch (e) { console.log(`[${slug}] já tinha limiteNFCe`); }
  db.close();
}
