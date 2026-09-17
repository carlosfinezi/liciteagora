// Natureza de operação e política de prazo do PDV, mais o rastro da NFC-e no
// financeiro (idempotente). Espelho de nfce-routes.migrar / db-schema.js — ver
// scripts/migrate-pdv-config.js, mesmo padrão.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const TENANTS = '/home/carlosfinezi/web/liciteagora.com.br/private/data/tenants';

const alters = [
  `ALTER TABLE nfce_config ADD COLUMN pdvTipoOperacaoId INTEGER`,
  `ALTER TABLE nfce_config ADD COLUMN pdvPoliticaPrazoId INTEGER`,
  `ALTER TABLE nfce ADD COLUMN tipoOperacaoId INTEGER`,
  `ALTER TABLE contas_a_receber ADD COLUMN nfceId INTEGER`,
];

// Padrão do balcão: venda normal. Só toca em quem está NULL — quem já escolheu
// outra natureza em PDV · Config não é revisitado. Espelho do db-schema.js.
const BACKFILL = `UPDATE nfce_config
     SET pdvTipoOperacaoId = (
           SELECT id FROM tipos_operacao
            WHERE ativo = 1 AND emiteNFe = 1 AND categoriaOperacao = 'venda'
            ORDER BY CASE WHEN codigo = 'VDA-NORMAL' THEN 0 ELSE 1 END, id
            LIMIT 1)
   WHERE pdvTipoOperacaoId IS NULL`;

for (const slug of fs.readdirSync(TENANTS)) {
  const dbp = path.join(TENANTS, slug, 'pncp.db');
  if (!fs.existsSync(dbp)) continue;
  const db = new Database(dbp);
  let ok = 0, skip = 0;
  for (const sql of alters) {
    try { db.exec(sql); ok++; } catch (_) { skip++; }
  }
  let natureza = '—';
  try {
    db.exec(BACKFILL);
    const n = db.prepare(`SELECT t.codigo, t.descricao FROM nfce_config c
      JOIN tipos_operacao t ON t.id = c.pdvTipoOperacaoId WHERE c.id = 1`).get();
    natureza = n ? `${n.codigo} · ${n.descricao}` : 'nenhuma venda ativa para usar de padrão';
  } catch (e) { natureza = 'falhou: ' + e.message; }
  console.log(`[${slug}] ok=${ok} skip=${skip} · natureza: ${natureza}`);
  db.close();
}
