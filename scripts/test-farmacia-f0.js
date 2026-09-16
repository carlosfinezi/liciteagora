#!/usr/bin/env node
/**
 * test-farmacia-f0.js — Fase 0 do módulo Farmácia: fundação.
 *
 * Verifica o que a fase 0 promete: schema criado no tenant, flag por-tenant
 * fechando as rotas, config com defaults e validação, e a fiação nos pontos
 * de registro (plano, features, module-gate, menu, ícone).
 *
 * Roda contra o tenant `labfiscal`. O schema é aplicado pelo próprio teste —
 * em produção quem aplica é o db-schema.js no boot.
 *
 * Uso: node scripts/test-farmacia-f0.js
 */
const fs = require('fs');
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const express = require(BASE + '/node_modules/express');

const { initFarmaciaSchema } = require(BASE + '/farmacia/farmacia-schema');
const { registrarRotasFarmacia, lerConfig, getFlag } = require(BASE + '/farmacia/farmacia-routes');

const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

// ─── Schema ───────────────────────────────────────────────────────────────────
secao('Schema');
initFarmaciaSchema(db);
initFarmaciaSchema(db); // idempotência: rodar duas vezes não pode estourar
assert(true, 'initFarmaciaSchema roda duas vezes sem erro (idempotente)');

const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'farmacia_%'")
  .all().map(r => r.name);
for (const t of ['farmacia_cmed_versoes', 'farmacia_medicamento_specs', 'farmacia_cmed_naocasados',
                 'farmacia_receitas', 'farmacia_receita_itens', 'farmacia_venda_receita',
                 'farmacia_sngpc_transmissoes', 'farmacia_sngpc_eventos']) {
  assert(tabelas.includes(t), `tabela ${t} existe`);
}

const colsSpecs = db.prepare('PRAGMA table_info(farmacia_medicamento_specs)').all().map(c => c.name);
for (const c of ['registroAnvisa', 'isentoRegistro', 'motivoIsencao', 'ean', 'substancia',
                 'tarja', 'listaCmed', 'regimePreco', 'pf', 'pmc', 'listaPortaria344', 'antimicrobiano']) {
  assert(colsSpecs.includes(c), `farmacia_medicamento_specs.${c}`);
}

// A única alteração em tabela core do módulo.
const colsNfceItens = db.prepare('PRAGMA table_info(nfce_itens)').all().map(c => c.name);
assert(colsNfceItens.includes('loteId'), 'nfce_itens.loteId (rastro do XML precisa reconstruir o lote)');

// ─── Rotas + flag ─────────────────────────────────────────────────────────────
secao('Rotas e feature flag');

const app = express();
app.use(express.json());
registrarRotasFarmacia(app, db);

const rotas = ((app.router || app._router).stack || [])
  .filter(x => x.route).map(x => Object.keys(x.route.methods)[0].toUpperCase() + ' ' + x.route.path);
assert(rotas.includes('GET /api/farmacia/status'), 'GET /api/farmacia/status registrada');
assert(rotas.includes('GET /api/farmacia/config'), 'GET /api/farmacia/config registrada');
assert(rotas.includes('PUT /api/farmacia/config'), 'PUT /api/farmacia/config registrada');

function achar(p, m) {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack; // pode ter gateFlag antes do handler
}
// Executa a cadeia (gate + handler) como o Express faria.
function chamar(p, m, o = {}) {
  const stack = achar(p, m);
  let out = null, st = 200;
  const res = {
    json: x => { out = x; return res; },
    status: c => { st = c; return res; },
  };
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {},
                session: o.session || {}, user: o.user, headers: {} };
  let i = 0;
  const next = () => { const h = stack[i++]; if (h) h.handle(req, res, next); };
  next();
  return { out, st };
}

// Estado original da flag — o teste restaura no fim.
const flagOriginal = db.prepare("SELECT valor FROM config WHERE chave = 'farmacia_enabled'").get();

function setFlag(v) {
  db.prepare(`INSERT INTO config (chave, valor) VALUES ('farmacia_enabled', ?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(String(v));
}

setFlag(0);
assert(getFlag(db) === false, 'getFlag = false com farmacia_enabled=0');
let r = chamar('/api/farmacia/status', 'get');
assert(r.out && r.out.success === true && r.out.enabled === false,
  'status responde sem gate e diz enabled:false', JSON.stringify(r.out));
r = chamar('/api/farmacia/config', 'get');
assert(r.st === 403 && r.out && r.out.error === 'farmacia_disabled',
  'config com flag off devolve 403 farmacia_disabled', `st=${r.st} ${JSON.stringify(r.out)}`);

setFlag(1);
assert(getFlag(db) === true, 'getFlag = true com farmacia_enabled=1');
r = chamar('/api/farmacia/status', 'get');
assert(r.out.enabled === true, 'status reflete a flag ligada');

r = chamar('/api/farmacia/config', 'get');
assert(r.st === 200 && r.out.success, 'config com flag on responde 200');
assert(r.out.config.farmacia_coluna_pmc === '19', 'default da coluna de PMC é 19 (Pará)',
  JSON.stringify(r.out.config));
assert(r.out.config.farmacia_uf === 'PA', 'default da UF é PA');
assert(Array.isArray(r.out.colunasPmc) && r.out.colunasPmc.includes('19'),
  'lista de colunas de PMC inclui 19');

// ─── Validação da config ──────────────────────────────────────────────────────
secao('Validação da config');

r = chamar('/api/farmacia/config', 'put', { body: { farmacia_coluna_pmc: '13' } });
assert(r.st === 400, 'coluna de PMC inexistente na CMED é recusada', `st=${r.st}`);

r = chamar('/api/farmacia/config', 'put', { body: { farmacia_sngpc_ambiente: 'qualquer' } });
assert(r.st === 400, 'ambiente SNGPC inválido é recusado', `st=${r.st}`);

r = chamar('/api/farmacia/config', 'put', { body: { farmacia_uf: 'Pará' } });
assert(r.st === 400, 'UF fora do formato de 2 letras é recusada', `st=${r.st}`);

const cfgAntes = lerConfig(db);
r = chamar('/api/farmacia/config', 'put', { body: { farmacia_coluna_pmc: '18', farmacia_uf: 'SP' } });
assert(r.st === 200 && r.out.config.farmacia_coluna_pmc === '18' && r.out.config.farmacia_uf === 'SP',
  'config válida é gravada e devolvida', JSON.stringify(r.out));
// devolve ao que era
chamar('/api/farmacia/config', 'put', {
  body: { farmacia_coluna_pmc: cfgAntes.farmacia_coluna_pmc, farmacia_uf: cfgAntes.farmacia_uf },
});
assert(lerConfig(db).farmacia_coluna_pmc === cfgAntes.farmacia_coluna_pmc, 'config restaurada ao estado anterior');

// ─── Fiação nos pontos de registro ────────────────────────────────────────────
secao('Fiação (plano, features, gate, menu, ícone)');

// PLAN_MATRIX é a fonte de verdade; ensurePlanModulesSchema faz upsert dela em
// plan_modules no boot, então basta o slug estar aqui para chegar ao control.db.
const { MODULE_SLUGS, PLAN_MATRIX } = require(BASE + '/plan-modules');
assert(MODULE_SLUGS.includes('farmacia'), "slug 'farmacia' em plan-modules.MODULE_SLUGS");
assert(PLAN_MATRIX.enterprise.modules.includes('farmacia'), 'enterprise inclui farmacia');
assert(!PLAN_MATRIX.starter.modules.includes('farmacia'), 'starter NÃO inclui farmacia');
// O sanity check do ensurePlanModulesSchema estoura se algum tier citar slug
// que não existe em MODULE_SLUGS — vale conferir aqui, sem tocar no control.db.
for (const tier of Object.keys(PLAN_MATRIX)) {
  const invalidos = PLAN_MATRIX[tier].modules.filter(m => !MODULE_SLUGS.includes(m));
  assert(invalidos.length === 0, `tier ${tier} só cita slugs válidos`, invalidos.join(', '));
}

const { FEATURE_KEYS } = require(BASE + '/features-routes');
assert(FEATURE_KEYS.includes('farmacia'), "chave 'farmacia' em features-routes.FEATURE_KEYS");

const gateSrc = fs.readFileSync(BASE + '/module-gate.js', 'utf8');
assert(/farmacia:\s*\['farmacia'\]/.test(gateSrc), 'module-gate mapeia a feature legada farmacia');
assert(/prefix:\s*'\/api\/farmacia\/',\s*module:\s*'farmacia'/.test(gateSrc),
  'module-gate protege o prefixo /api/farmacia/');

const registrySrc = fs.readFileSync(BASE + '/route-registry.js', 'utf8');
assert(/require\('\.\/farmacia\/farmacia-routes'\)/.test(registrySrc), 'route-registry requer o módulo');
assert(/registrarRotasFarmacia\(app, db\)/.test(registrySrc), 'route-registry chama registrarRotasFarmacia');

const schemaSrc = fs.readFileSync(BASE + '/db-schema.js', 'utf8');
assert(/farmacia\/farmacia-schema'\)\.initFarmaciaSchema\(db\)/.test(schemaSrc),
  'db-schema.js aplica o schema em tenant existente');

const menuSrc = fs.readFileSync(BASE + '/public/js/menu-config.js', 'utf8');
assert(/feature:\s*'farmacia'/.test(menuSrc), 'menu-config tem seção com feature farmacia');
assert(/farmacia\/config\.html/.test(menuSrc), 'menu aponta para a tela de configuração');

const sidebarSrc = fs.readFileSync(BASE + '/public/js/sidebar.js', 'utf8');
assert(/'💊':\s*'pill'/.test(sidebarSrc), "mapa de ícones tem 💊 → pill (senão o menu renderiza sem ícone)");

const cpSrc = fs.readFileSync(BASE + '/control-plane-routes.js', 'utf8');
assert(/key:\s*'farmacia'/.test(cpSrc), 'control-plane lista a feature para o super-admin ligar');

assert(fs.existsSync(BASE + '/public/farmacia/config.html'), 'tela public/farmacia/config.html existe');

// ─── Restaura a flag como estava ──────────────────────────────────────────────
if (flagOriginal) setFlag(flagOriginal.valor);
else db.prepare("DELETE FROM config WHERE chave = 'farmacia_enabled'").run();

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
