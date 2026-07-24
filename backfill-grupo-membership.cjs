// backfill-grupo-membership.cjs — popula bi_grupo_item para os grupos de
// pesquisa de um tenant. One-off / reutilizável (scheduler pode chamar igual).
// Uso: node backfill-grupo-membership.cjs <tenantSlug> [pathPncpDb]
const path = require('path');
const Database = require('better-sqlite3');
const catalogPg = require('./catalog-pg');
const membership = require('./bi-grupo-membership');

(async () => {
  const tenant = process.argv[2] || '1bit';
  const dbPath = process.argv[3] || path.join(__dirname, 'data', 'tenants', tenant, 'pncp.db');
  const tenantDb = new Database(dbPath, { readonly: true, fileMustExist: true });

  await membership.ensureSchema(catalogPg);

  const grupos = tenantDb.prepare(
    `SELECT id, nome FROM grupos_palavras WHERE tipo = 'pesquisa' OR tipo IS NULL ORDER BY id`
  ).all();
  console.log(`[backfill] tenant=${tenant} grupos de pesquisa: ${grupos.length}`);

  for (const g of grupos) {
    const t0 = Date.now();
    const r = await membership.rebuildGrupo({ catalogPg, tenantDb, tenant, grupoId: g.id });
    console.log(`[backfill] grupo ${g.id} "${g.nome}": ${r.qtd} itens (${((Date.now()-t0)/1000).toFixed(1)}s)`);
  }

  tenantDb.close();
  await membership.closeRebuildPool();
  await catalogPg.close();
  console.log('[backfill] concluído');
})().catch(e => { console.error('[backfill] erro:', e); process.exit(1); });
