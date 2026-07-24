// Aplica ALTER TABLE de Phase 1 nos DBs de tenants existentes.
// Idempotente (cada ALTER em try/catch).
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const TENANTS_DIR = '/home/carlosfinezi/web/liciteagora.com.br/private/data/tenants';

const alters = [
  `ALTER TABLE os_ordens ADD COLUMN formaPagamento TEXT`,
  `ALTER TABLE os_ordens ADD COLUMN dataVencimento TEXT`,
  `ALTER TABLE os_ordens ADD COLUMN numeroParcelas INTEGER DEFAULT 1`,
  `ALTER TABLE os_ordens ADD COLUMN naoEmitirNFe INTEGER DEFAULT 0`,
  `ALTER TABLE os_ordens ADD COLUMN statusFiscal TEXT`,
  `ALTER TABLE contas_a_receber ADD COLUMN osId INTEGER`,
  `ALTER TABLE contas_a_receber ADD COLUMN pedidoId INTEGER`,
  `ALTER TABLE contas_a_receber ADD COLUMN origemTipo TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_cr_os ON contas_a_receber(osId)`,
  `CREATE INDEX IF NOT EXISTS idx_cr_pedido ON contas_a_receber(pedidoId)`,
  `ALTER TABLE nfse ADD COLUMN osId INTEGER`,
  `ALTER TABLE faturas ADD COLUMN osId INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_nfse_os ON nfse(osId)`,
  `CREATE INDEX IF NOT EXISTS idx_faturas_os ON faturas(osId)`,
];

const tenants = fs.readdirSync(TENANTS_DIR);
for (const slug of tenants) {
  const dbPath = path.join(TENANTS_DIR, slug, 'pncp.db');
  if (!fs.existsSync(dbPath)) continue;
  const db = new Database(dbPath);
  let applied = 0, skipped = 0;
  for (const sql of alters) {
    try { db.exec(sql); applied++; }
    catch (e) { skipped++; /* já existe */ }
  }
  console.log(`[${slug}] applied=${applied} skipped=${skipped}`);
  db.close();
}
