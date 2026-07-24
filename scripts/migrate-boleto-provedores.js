// Cria schema de provedores de boleto em todos os pncp.db dos tenants.
// Idempotente (CREATE TABLE IF NOT EXISTS + try/catch nos ALTERs).
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const TENANTS = '/home/carlosfinezi/web/liciteagora.com.br/private/data/tenants';

const stmts = [
  `CREATE TABLE IF NOT EXISTS contas_financeiras_boleto (
    contaFinanceiraId INTEGER PRIMARY KEY,
    provedor TEXT NOT NULL,
    ambiente TEXT DEFAULT 'homologacao',
    ativo INTEGER DEFAULT 0,
    configJson TEXT,
    certificadoBase64 TEXT,
    certificadoSenhaCripto TEXT,
    proximoNossoNumero INTEGER DEFAULT 1,
    ehPadrao INTEGER DEFAULT 0,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contaFinanceiraId) REFERENCES contas_financeiras(id) ON DELETE CASCADE
  )`,
  `ALTER TABLE contas_financeiras_boleto ADD COLUMN ehPadrao INTEGER DEFAULT 0`, // caso a tabela já exista sem a coluna
  `ALTER TABLE boletos ADD COLUMN provedor TEXT`,
  `ALTER TABLE boletos ADD COLUMN contaFinanceiraId INTEGER`,
  `ALTER TABLE boletos ADD COLUMN nossoNumero TEXT`,
  `ALTER TABLE boletos ADD COLUMN linhaDigitavel TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_boletos_provedor ON boletos(provedor)`,
  `CREATE INDEX IF NOT EXISTS idx_boletos_nosso_numero ON boletos(nossoNumero)`,
];

for (const slug of fs.readdirSync(TENANTS)) {
  const dbp = path.join(TENANTS, slug, 'pncp.db');
  if (!fs.existsSync(dbp)) continue;
  const db = new Database(dbp);
  let ok = 0, skip = 0;
  for (const sql of stmts) {
    try { db.exec(sql); ok++; } catch (_) { skip++; }
  }
  console.log(`[${slug}] ok=${ok} skip=${skip}`);
  db.close();
}
