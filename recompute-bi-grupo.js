// recompute-bi-grupo.js — one-off (2026-06-08): recomputa bi_grupo_item de TODOS
// os grupos de pesquisa de TODOS os tenants com o builder corrigido (exclusões
// aplicadas como `AND NOT @@ ws(excl)` em vez da expr combinada quebrada).
// Rodar: node recompute-bi-grupo.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { rebuildGrupo, closeRebuildPool } = require('./bi-grupo-membership');

(async () => {
  const tenantsDir = path.join(__dirname, 'data', 'tenants');
  const tenants = fs.readdirSync(tenantsDir)
    .filter(t => fs.existsSync(path.join(tenantsDir, t, 'pncp.db')));
  console.log(`Tenants: ${tenants.join(', ')}`);
  for (const tenant of tenants) {
    let tenantDb;
    try { tenantDb = new Database(path.join(tenantsDir, tenant, 'pncp.db'), { readonly: true }); }
    catch (e) { console.log(`[${tenant}] skip (open: ${e.message})`); continue; }
    let groups = [];
    try { groups = tenantDb.prepare("SELECT id, nome FROM grupos_palavras WHERE tipo='pesquisa' AND ativo=1 ORDER BY id").all(); }
    catch (e) { console.log(`[${tenant}] skip (no grupos_palavras: ${e.message})`); tenantDb.close(); continue; }
    for (const g of groups) {
      const t0 = Date.now();
      try {
        const r = await rebuildGrupo({ catalogPg: null, tenantDb, tenant, grupoId: g.id });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[${tenant}] g${g.id} ${g.nome}: ${r.ok ? r.qtd + ' itens' : 'FALHOU ' + r.reason} (${secs}s)`);
      } catch (e) {
        console.log(`[${tenant}] g${g.id} ${g.nome}: ERRO ${e.message}`);
      }
    }
    tenantDb.close();
  }
  await closeRebuildPool();
  console.log('=== recompute concluído ===');
  process.exit(0);
})();
