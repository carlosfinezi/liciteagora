// Script de migracao (one-shot): lê features legadas ligadas em cada tenant
// e grava como overrides `granted=1` em tenant_module_overrides, preservando
// acesso de quem ja usava as features antes da Fase 2 do feature-gate.
//
// Comportamento:
//   - Conservador: se feature legada esta '1' no tenant, TODOS os slugs novos
//     mapeados por LEGACY_FEATURE_TO_MODULES viram override granted=1.
//   - So adiciona overrides que AINDA NAO existem na matriz do tier do tenant
//     (evita poluir a tabela com overrides redundantes).
//   - Idempotente (UPSERT por tenant_id + module_slug, source='snapshot_migration').
//   - Modo --dry-run: lista o que faria sem escrever.
//
// Uso:
//   node snapshot-modules-migration.js [--dry-run]

const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const { PLAN_MATRIX, PLAN_TIERS, ensurePlanModulesSchema } = require('./plan-modules');
const { LEGACY_FEATURE_TO_MODULES, ensureOverridesSchema, setOverride, listOverrides } = require('./module-gate');

const dryRun = process.argv.includes('--dry-run');
const CONTROL_DB = path.join(__dirname, 'data', 'control.db');
const TENANTS_DIR = path.join(__dirname, 'data', 'tenants');

const control = new Database(CONTROL_DB);
control.pragma('journal_mode = WAL');
ensurePlanModulesSchema(control);
ensureOverridesSchema(control);

const tenants = control.prepare(`
  SELECT id, slug, name, status, plan, db_path
    FROM tenants
   WHERE status IN ('TRIAL', 'ACTIVE', 'OVERDUE')
   ORDER BY slug
`).all();

console.log(`[snapshot] ${tenants.length} tenants candidatos (TRIAL/ACTIVE/OVERDUE)`);
console.log(`[snapshot] modo: ${dryRun ? 'DRY-RUN (sem escrever)' : 'GRAVANDO'}`);
console.log('');

let totalGrants = 0;
let totalSkipped = 0;
const summary = [];

for (const t of tenants) {
  const tier = t.plan ? String(t.plan).toLowerCase() : null;
  const baseModules = tier && PLAN_TIERS.includes(tier)
    ? new Set(PLAN_MATRIX[tier].modules)
    : new Set();

  const dbPath = t.db_path || path.join(TENANTS_DIR, t.slug, 'pncp.db');
  if (!fs.existsSync(dbPath)) {
    console.log(`[skip] tenant=${t.slug}: db nao existe em ${dbPath}`);
    summary.push({ slug: t.slug, status: 'no-db', granted: 0 });
    continue;
  }

  let tenantDb;
  try {
    tenantDb = new Database(dbPath, { readonly: true });
  } catch (e) {
    console.log(`[skip] tenant=${t.slug}: erro abrindo db: ${e.message}`);
    summary.push({ slug: t.slug, status: 'open-error', granted: 0 });
    continue;
  }

  const grantsForThisTenant = [];
  try {
    for (const [legacyKey, modules] of Object.entries(LEGACY_FEATURE_TO_MODULES)) {
      let row;
      try {
        row = tenantDb.prepare('SELECT valor FROM config WHERE chave = ?').get(legacyKey + '_enabled');
      } catch { row = null; }
      const enabled = !!(row && row.valor === '1');
      if (!enabled) continue;

      for (const m of modules) {
        // So cria override pra modulo que NAO esta na matriz do tier
        // (overrides redundantes nao agregam — base ja libera).
        if (baseModules.has(m)) continue;
        grantsForThisTenant.push({ legacy: legacyKey, module: m });
      }
    }
  } finally {
    tenantDb.close();
  }

  if (grantsForThisTenant.length === 0) {
    console.log(`[ok] tenant=${t.slug} tier=${tier || 'sem tier'}: nada a override (matriz ja cobre)`);
    summary.push({ slug: t.slug, status: 'no-overrides-needed', granted: 0 });
    totalSkipped++;
    continue;
  }

  console.log(`[gravar] tenant=${t.slug} tier=${tier || 'sem tier'}: ${grantsForThisTenant.length} override(s)`);
  for (const g of grantsForThisTenant) {
    console.log(`         - ${g.module} (era ${g.legacy}_enabled=1)`);
  }

  if (!dryRun) {
    const tx = control.transaction(() => {
      for (const g of grantsForThisTenant) {
        setOverride(control, {
          tenantId: t.id,
          moduleSlug: g.module,
          granted: 1,
          source: 'snapshot_migration',
        });
      }
    });
    tx();
  }

  totalGrants += grantsForThisTenant.length;
  summary.push({ slug: t.slug, status: dryRun ? 'would-grant' : 'granted', granted: grantsForThisTenant.length });
}

console.log('');
console.log('=== RESUMO ===');
console.log(`Tenants processados: ${tenants.length}`);
console.log(`Tenants sem overrides necessarios: ${totalSkipped}`);
console.log(`Total de overrides ${dryRun ? '(seriam) gravados' : 'gravados'}: ${totalGrants}`);
if (dryRun) {
  console.log('');
  console.log('Rode SEM --dry-run para aplicar.');
}

control.close();
