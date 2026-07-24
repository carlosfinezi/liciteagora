// Feature-gate por modulo. Resolve quais modulos um tenant pode acessar
// combinando: (a) a matriz do tier (Starter/Profissional/Avancado/Enterprise)
// definida em plan-modules.js + (b) overrides explicitos em
// tenant_module_overrides.
//
// Overrides existem por dois motivos:
//   1. Snapshot da migracao: preservar acesso de tenants antigos que ja tinham
//      features ligadas via flag legada antes da Fase 2.
//   2. Concessao caso-a-caso pelo super-admin (ex: dar `sniper` para um Starter
//      em troca de um upsell pendente).
//
// Granted=1 -> adiciona modulo ao set efetivo (mesmo que o tier nao inclua).
// Granted=0 -> remove modulo do set efetivo (override negativo).

const { getPlanModules, PLAN_TIERS } = require('./plan-modules');

// Mapeia chaves legadas (features-routes.js FEATURE_KEYS) para os novos slugs
// de modulo. Quando o tenant tinha `fiscal_enabled=1` antes da migracao, ele
// recebe override em todos os modulos da familia fiscal — conservador, pra
// nao tirar acesso de quem ja usava.
const LEGACY_FEATURE_TO_MODULES = {
  optica:      ['otica'],
  licitacoes:  ['licitacoes'],
  operacional: ['operacional_basico', 'sniper', 'monitor_chat'],
  comercial:   ['comercial'],
  os:          ['contratos_os'],
  produtos:    ['produtos_estoque_basico', 'produtos_estoque_completo', 'compras'],
  comunicacao: ['comunicacao'],
  rh:          ['rh'],
  varejo:      ['varejo'],
  fiscal:      ['fiscal_nfse_basico', 'fiscal_nfe_completo', 'fiscal_apuracao'],
  financeiro:  ['financeiro_basico', 'financeiro_conciliacao', 'cobranca_automatica'],
};

function ensureOverridesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_module_overrides (
      tenant_id    INTEGER NOT NULL,
      module_slug  TEXT NOT NULL,
      granted      INTEGER NOT NULL,
      source       TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, module_slug),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_module_overrides_tenant ON tenant_module_overrides(tenant_id)');
}

function setOverride(db, { tenantId, moduleSlug, granted, source = 'admin' }) {
  const stmt = db.prepare(`
    INSERT INTO tenant_module_overrides (tenant_id, module_slug, granted, source, created_at)
    VALUES (@tenantId, @moduleSlug, @granted, @source, @createdAt)
    ON CONFLICT(tenant_id, module_slug) DO UPDATE SET
      granted    = excluded.granted,
      source     = excluded.source,
      created_at = excluded.created_at
  `);
  stmt.run({
    tenantId,
    moduleSlug,
    granted: granted ? 1 : 0,
    source,
    createdAt: Date.now(),
  });
  _effCache.delete(tenantId);
}

function removeOverride(db, { tenantId, moduleSlug }) {
  db.prepare('DELETE FROM tenant_module_overrides WHERE tenant_id = ? AND module_slug = ?')
    .run(tenantId, moduleSlug);
  _effCache.delete(tenantId);
}

function listOverrides(db, tenantId) {
  return db.prepare(`
    SELECT module_slug, granted, source, created_at
      FROM tenant_module_overrides
     WHERE tenant_id = ?
     ORDER BY module_slug
  `).all(tenantId);
}

// Cache em memoria de getEffectiveModules por tenant_id. Evita 2 queries
// SQLite por request HTTP — critico em sistema com event loop sob pressao
// de schedulers sincronos (catalog sync, BNC, sniper, BI pre-warm).
// TTL curto (60s) cobre mudancas de override pelo super-admin sem
// invalidacao explicita. Pra invalidacao imediata, chame invalidateCache.
const _effCache = new Map(); // tenant_id -> { value, expiresAt }
const CACHE_TTL_MS = 60 * 1000;

function invalidateCache(tenantId) {
  if (tenantId == null) _effCache.clear();
  else _effCache.delete(tenantId);
}

// Resolve o conjunto efetivo de modulos para um tenant.
// Retorna { tier, modules: Set<string>, source: { tier: [...], grants: [...], denies: [...] } }
// `source` e util para debug/auditoria; o middleware so usa `modules`.
function getEffectiveModules(db, tenant) {
  const cacheKey = tenant && tenant.id != null ? tenant.id : null;
  const now = Date.now();
  if (cacheKey != null) {
    const hit = _effCache.get(cacheKey);
    if (hit && hit.expiresAt > now) return hit.value;
  }
  const value = _getEffectiveModulesUncached(db, tenant);
  if (cacheKey != null) _effCache.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

function _getEffectiveModulesUncached(db, tenant) {
  const tier = tenant && tenant.plan ? String(tenant.plan).toLowerCase() : null;
  const baseDef = tier && PLAN_TIERS.includes(tier) ? getPlanModules(db, tier) : null;
  const base = baseDef ? new Set(baseDef.modules) : new Set();

  const grants = [];
  const denies = [];
  if (tenant && tenant.id != null) {
    const overrides = listOverrides(db, tenant.id);
    for (const o of overrides) {
      if (o.granted) { base.add(o.module_slug); grants.push(o.module_slug); }
      else           { base.delete(o.module_slug); denies.push(o.module_slug); }
    }
  }

  return {
    tier,
    modules: base,
    limites: baseDef ? baseDef.limites : null,
    source: {
      tier: baseDef ? baseDef.modules : [],
      grants,
      denies,
    },
  };
}

function tenantHasModule(db, tenant, moduleSlug) {
  return getEffectiveModules(db, tenant).modules.has(moduleSlug);
}

// Mapeamento rota -> modulo. Avaliado em ordem; primeira regra que bate ganha.
// Rotas que NAO batem em nenhuma regra passam livre (default-allow).
// Pra adicionar gate em mais modulos: adicione regras aqui.
//
// Modulos atualmente gated (Fase 2B inicial):
//   sniper, varejo, fiscal_nfe_completo, bi_ia
const ROUTE_MODULE_MAP = [
  // sniper (robo de lances automaticos em pregoes)
  { prefix: '/api/lance/',                 module: 'sniper' },

  // varejo (PDV, NFC-e, TEF, marketplaces)
  { prefix: '/api/nfce/',                  module: 'varejo' },
  { prefix: '/api/pdv/',                   module: 'varejo' },
  { prefix: '/api/tef/',                   module: 'varejo' },
  { prefix: '/api/marketplaces/',          module: 'varejo' },

  // fiscal_nfe_completo (NF-e, MDF-e, CT-e — NAO inclui NFS-e nem NFC-e)
  { prefix: '/api/nfe/',                   module: 'fiscal_nfe_completo' },
  { prefix: '/api/mdfe/',                  module: 'fiscal_nfe_completo' },
  { prefix: '/api/cte/',                   module: 'fiscal_nfe_completo' },
  { regex:  /^\/api\/faturas\/[^/]+\/(emitir|cancelar)-nfe$/, module: 'fiscal_nfe_completo' },

  // bi_ia (analise por IA — BYOAI, tenant configura chave propria)
  { exact:  '/api/bi/analise-precos',      module: 'bi_ia' },
  { prefix: '/api/bi/classificar-ia',      module: 'bi_ia' },
  { prefix: '/api/analise/',               module: 'bi_ia' },
  // sugestão de produto por marca (config self-serve + motor + overlay)
  { exact:  '/api/bi/sugestao-config',     module: 'bi_ia' },
  { prefix: '/api/bi/sugerir-produto',     module: 'bi_ia' },
  { prefix: '/api/bi/sugestoes-mapa',      module: 'bi_ia' },
  { prefix: '/api/compras/sugestao-mercado', module: 'bi_ia' },

  // fiscal_classificacao (add-on NCM/CEST + sugestao por IA)
  { prefix: '/api/fiscal/ncm',             module: 'fiscal_classificacao' },
  { prefix: '/api/fiscal/cest',            module: 'fiscal_classificacao' },
  { prefix: '/api/fiscal/classificacao/', module: 'fiscal_classificacao' },
  { prefix: '/api/fiscal/relatorio',       module: 'fiscal_classificacao' },
];

function matchRouteToModule(reqPath) {
  for (const rule of ROUTE_MODULE_MAP) {
    if (rule.exact && reqPath === rule.exact) return rule.module;
    if (rule.prefix && reqPath.startsWith(rule.prefix)) return rule.module;
    if (rule.regex && rule.regex.test(reqPath)) return rule.module;
  }
  return null;
}

// Fabrica do middleware Express. Aplicado APOS o tenant-middleware
// (precisa de req.tenant resolvido).
function createModuleGate(manager) {
  const controlDb = manager.controlDb;
  return function moduleGateMiddleware(req, res, next) {
    if (req.method === 'OPTIONS') return next();              // CORS preflight
    if (!req.tenant) return next();                            // apex/admin/landing
    const required = matchRouteToModule(req.path);
    if (!required) return next();                              // rota nao gated

    const eff = getEffectiveModules(controlDb, req.tenant);
    if (eff.modules.has(required)) return next();

    return res.status(403).json({
      error: 'module_blocked',
      module: required,
      tier_atual: eff.tier,
      mensagem: `Seu plano (${eff.tier || 'sem tier'}) nao inclui o modulo "${required}".`,
      upgrade_url: '/planos.html',
    });
  };
}

module.exports = {
  LEGACY_FEATURE_TO_MODULES,
  ROUTE_MODULE_MAP,
  ensureOverridesSchema,
  setOverride,
  removeOverride,
  listOverrides,
  getEffectiveModules,
  invalidateCache,
  tenantHasModule,
  matchRouteToModule,
  createModuleGate,
};
