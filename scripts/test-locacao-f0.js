#!/usr/bin/env node
/**
 * test-locacao-f0.js — Fase 0 do módulo Locação: fundação.
 *
 * Verifica o que a fase 0 promete: schema criado no tenant, flag por-tenant
 * fechando as rotas, config com defaults e validação, e a fiação nos pontos de
 * registro (plano, features, module-gate, menu, ícone, control-plane).
 *
 * Roda contra o tenant `labfiscal`. O schema é aplicado pelo próprio teste —
 * em produção quem aplica é o db-schema.js no boot.
 *
 * Uso: node scripts/test-locacao-f0.js
 */
const fs = require('fs');
const BASE = require('path').join(__dirname, '..');
const Database = require(BASE + '/node_modules/better-sqlite3');
const { copiaDoTenant } = require('./banco-de-teste');
const express = require(BASE + '/node_modules/express');

const { initLocacaoSchema } = require(BASE + '/locacao/locacao-schema');
const { protegerConfig } = require('./locacao-teste-util');
const { registrarRotasLocacao, lerConfig, getFlag } = require(BASE + '/locacao/locacao-routes');

const db = new Database(copiaDoTenant('labfiscal'));

// Devolve toda chave `locacao_*` ao estado original na saída do processo —
// inclusive se este teste estourar no meio. Ver locacao-teste-util.js.
protegerConfig(db);

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

// ─── Schema ───────────────────────────────────────────────────────────────────
secao('Schema');
initLocacaoSchema(db);
initLocacaoSchema(db); // idempotência: rodar duas vezes não pode estourar

// REGRESSÃO (teste complacente encontrado na validação): aqui havia um
// `assert(true, ...)` — tautológico, provava só que a linha anterior não
// estourou, e não cobria o único caso de idempotência que importa: banco com
// as tabelas numa versão ANTERIOR do módulo. Naquele caso o
// `CREATE INDEX ... (alugavel, categoria)` lançava `no such column` e, como o
// db-schema.js chama sem try, DERRUBAVA O BOOT DO TENANT.
{
  const tmp = new Database(':memory:');
  tmp.exec('CREATE TABLE produtos (id INTEGER PRIMARY KEY, sku TEXT, descricao TEXT)');
  tmp.exec('CREATE TABLE pessoas (id INTEGER PRIMARY KEY, razaoSocial TEXT, cpfCnpj TEXT)');
  // Versão "antiga": tabela sem as colunas que vieram depois.
  tmp.exec('CREATE TABLE locacao_item_specs (produtoId INTEGER PRIMARY KEY, alugavel INTEGER)');
  tmp.exec(`CREATE TABLE locacao_faturamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, contratoId INTEGER, competencia TEXT,
    status TEXT DEFAULT 'gerado')`);
  // Duplicata que faria o UNIQUE de competência falhar.
  tmp.prepare("INSERT INTO locacao_faturamentos (contratoId, competencia) VALUES (1,'2026-01')").run();
  tmp.prepare("INSERT INTO locacao_faturamentos (contratoId, competencia) VALUES (1,'2026-01')").run();

  let estourou = null;
  try { initLocacaoSchema(tmp); } catch (e) { estourou = e.message; }
  assert(!estourou, 'schema sobre estrutura ANTIGA não estoura (senão o tenant não sobe)', estourou);

  const cols = tmp.prepare('PRAGMA table_info(locacao_item_specs)').all().map(c => c.name);
  for (const c of ['horasPreparo', 'medidorTipo', 'exigeSerie', 'caucaoPadrao']) {
    assert(cols.includes(c), `coluna ${c} é acrescentada por ALTER na tabela preexistente`);
  }
  // A categoria do módulo foi eliminada: a do cadastro do produto é a única.
  // Um banco antigo com a coluna (e sem dado) tem de perdê-la aqui.
  const colsPos = tmp.prepare('PRAGMA table_info(locacao_item_specs)').all().map(c => c.name);
  assert(!colsPos.includes('categoria'),
    'coluna categoria (sem dado) é removida — a categoria é a de produtos.categoria',
    colsPos.join(','));
  tmp.close();
}

// Mas se houver dado, a coluna FICA: apagar classificação de alguém para
// limpar schema seria pior do que conviver com a coluna.
{
  const tmp2 = new Database(':memory:');
  tmp2.exec('CREATE TABLE produtos (id INTEGER PRIMARY KEY, sku TEXT, descricao TEXT, categoria TEXT)');
  tmp2.exec('CREATE TABLE pessoas (id INTEGER PRIMARY KEY, razaoSocial TEXT, cpfCnpj TEXT)');
  tmp2.exec('CREATE TABLE locacao_item_specs (produtoId INTEGER PRIMARY KEY, alugavel INTEGER, categoria TEXT)');
  tmp2.prepare("INSERT INTO locacao_item_specs (produtoId, alugavel, categoria) VALUES (1,1,'maquinas')").run();
  initLocacaoSchema(tmp2);
  const c2 = tmp2.prepare('PRAGMA table_info(locacao_item_specs)').all().map(c => c.name);
  assert(c2.includes('categoria'), 'coluna categoria COM dado é preservada (não apaga classificação alheia)');
  tmp2.close();
}
assert(true, 'initLocacaoSchema roda duas vezes sem erro (idempotente)');

const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'locacao_%'")
  .all().map(r => r.name);
for (const t of ['locacao_item_specs', 'locacao_tarifas', 'locacao_tarifa_extras',
                 'locacao_reservas', 'locacao_bloqueios',
                 'locacao_contratos', 'locacao_itens', 'locacao_eventos',
                 'locacao_avarias', 'locacao_acertos',
                 'locacao_faturamentos', 'locacao_notificacoes_config', 'locacao_notificacoes_log',
                 'locacao_medidor_leituras', 'locacao_manutencao_planos']) {
  assert(tabelas.includes(t), `tabela ${t} existe`);
}

const colsSpecs = db.prepare('PRAGMA table_info(locacao_item_specs)').all().map(c => c.name);
for (const c of ['produtoId', 'alugavel', 'exigeSerie', 'caucaoPadrao', 'horasPreparo',
                 'medidorTipo', 'franquiaPorDia', 'valorReposicao']) {
  assert(colsSpecs.includes(c), `locacao_item_specs.${c}`);
}

const colsRes = db.prepare('PRAGMA table_info(locacao_reservas)').all().map(c => c.name);
for (const c of ['produtoId', 'serialNumberId', 'quantidade', 'dataInicio', 'dataFim', 'status']) {
  assert(colsRes.includes(c), `locacao_reservas.${c}`);
}

const colsItens = db.prepare('PRAGMA table_info(locacao_itens)').all().map(c => c.name);
assert(colsItens.includes('natureza'),
  'locacao_itens.natureza (SV 31: locação e serviço separados desde o schema)');
assert(colsItens.includes('tipoOperacaoId'), 'locacao_itens.tipoOperacaoId');

// Nenhuma tabela core pode ter ganhado coluna de locação.
const colsReservasCore = db.prepare('PRAGMA table_info(reservas_estoque)').all().map(c => c.name);
assert(!colsReservasCore.includes('dataInicio') && !colsReservasCore.includes('dataFim'),
  'reservas_estoque NÃO ganhou janela de datas (quebraria pedidos e OS)');

// Índice de sobreposição: sem ele a disponibilidade varre a tabela inteira.
const idxRes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='locacao_reservas'")
  .all().map(r => r.name);
assert(idxRes.includes('idx_loc_res_janela'), 'índice de janela em locacao_reservas existe');

// ─── Rotas + flag ─────────────────────────────────────────────────────────────
secao('Rotas e feature flag');

const app = express();
app.use(express.json());
registrarRotasLocacao(app, db);

const rotas = ((app.router || app._router).stack || [])
  .filter(x => x.route).map(x => Object.keys(x.route.methods)[0].toUpperCase() + ' ' + x.route.path);
assert(rotas.includes('GET /api/locacao/status'), 'GET /api/locacao/status registrada');
assert(rotas.includes('GET /api/locacao/config'), 'GET /api/locacao/config registrada');
assert(rotas.includes('PUT /api/locacao/config'), 'PUT /api/locacao/config registrada');

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
const flagOriginal = db.prepare("SELECT valor FROM config WHERE chave = 'locacao_enabled'").get();

function setFlag(v) {
  db.prepare(`INSERT INTO config (chave, valor) VALUES ('locacao_enabled', ?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(String(v));
}

setFlag(0);
assert(getFlag(db) === false, 'getFlag = false com locacao_enabled=0');
let r = chamar('/api/locacao/status', 'get');
assert(r.out && r.out.success === true && r.out.enabled === false,
  'status responde sem gate e diz enabled:false', JSON.stringify(r.out));
r = chamar('/api/locacao/config', 'get');
assert(r.st === 403 && r.out && r.out.error === 'locacao_disabled',
  'config com flag off devolve 403 locacao_disabled', `st=${r.st} ${JSON.stringify(r.out)}`);

setFlag(1);
assert(getFlag(db) === true, 'getFlag = true com locacao_enabled=1');
r = chamar('/api/locacao/status', 'get');
assert(r.out.enabled === true, 'status reflete a flag ligada');

r = chamar('/api/locacao/config', 'get');
assert(r.st === 200 && r.out.success, 'config com flag on responde 200');
assert(r.out.config.locacao_prefixo_numero === 'LOC', 'default do prefixo é LOC', JSON.stringify(r.out.config));
assert(r.out.config.locacao_carencia_atraso_horas === '3', 'default da carência é 3h');
assert(r.out.config.locacao_multa_atraso_percentual === '100', 'default da multa é 100% da diária');
assert(r.out.config.locacao_exigir_vistoria === '1', 'vistoria exigida por padrão');
assert(r.out.config.locacao_permitir_overbooking === '0', 'overbooking desligado por padrão');

// ─── Validação da config ──────────────────────────────────────────────────────
secao('Validação da config');

r = chamar('/api/locacao/config', 'put', { body: { locacao_dia_vencimento_padrao: '31' } });
assert(r.st === 400, 'dia de vencimento 31 é recusado (não existe em fevereiro)', `st=${r.st}`);

r = chamar('/api/locacao/config', 'put', { body: { locacao_carencia_atraso_horas: '999' } });
assert(r.st === 400, 'carência fora da faixa 0..72 é recusada', `st=${r.st}`);

r = chamar('/api/locacao/config', 'put', { body: { locacao_exigir_vistoria: 'talvez' } });
assert(r.st === 400, 'booleana fora de 0/1 é recusada', `st=${r.st}`);

r = chamar('/api/locacao/config', 'put', { body: { locacao_prefixo_numero: 'loc ção!' } });
assert(r.st === 400, 'prefixo com caractere inválido é recusado', `st=${r.st}`);

r = chamar('/api/locacao/config', 'put', { body: { chave_que_nao_existe: '1' } });
assert(r.st === 400, 'chave desconhecida é recusada (não grava lixo em config)', `st=${r.st}`);

r = chamar('/api/locacao/config', 'put', { body: {} });
assert(r.st === 400, 'PUT vazio é recusado', `st=${r.st}`);

const cfgAntes = lerConfig(db);
r = chamar('/api/locacao/config', 'put', {
  body: { locacao_prefixo_numero: 'ALG', locacao_multa_atraso_percentual: '150' },
});
assert(r.st === 200 && r.out.config.locacao_prefixo_numero === 'ALG'
  && r.out.config.locacao_multa_atraso_percentual === '150',
  'config válida é gravada e devolvida', JSON.stringify(r.out));
// devolve ao que era
chamar('/api/locacao/config', 'put', {
  body: {
    locacao_prefixo_numero: cfgAntes.locacao_prefixo_numero,
    locacao_multa_atraso_percentual: cfgAntes.locacao_multa_atraso_percentual,
  },
});
assert(lerConfig(db).locacao_prefixo_numero === cfgAntes.locacao_prefixo_numero,
  'config restaurada ao estado anterior');

// ─── Fiação nos pontos de registro ────────────────────────────────────────────
secao('Fiação (plano, features, gate, menu, ícone, control-plane)');

const { MODULE_SLUGS, PLAN_MATRIX } = require(BASE + '/plan-modules');
assert(MODULE_SLUGS.includes('locacao'), "slug 'locacao' em plan-modules.MODULE_SLUGS");
assert(PLAN_MATRIX.enterprise.modules.includes('locacao'), 'enterprise inclui locacao');
assert(!PLAN_MATRIX.starter.modules.includes('locacao'), 'starter NÃO inclui locacao');
for (const tier of Object.keys(PLAN_MATRIX)) {
  const invalidos = PLAN_MATRIX[tier].modules.filter(m => !MODULE_SLUGS.includes(m));
  assert(invalidos.length === 0, `tier ${tier} só cita slugs válidos`, invalidos.join(', '));
}

const { FEATURE_KEYS } = require(BASE + '/features-routes');
assert(FEATURE_KEYS.includes('locacao'), "chave 'locacao' em features-routes.FEATURE_KEYS");

const gateSrc = fs.readFileSync(BASE + '/module-gate.js', 'utf8');
assert(/locacao:\s*\['locacao'\]/.test(gateSrc), 'module-gate mapeia a feature legada locacao');
assert(/prefix:\s*'\/api\/locacao\/',\s*module:\s*'locacao'/.test(gateSrc),
  'module-gate protege o prefixo /api/locacao/');

const registrySrc = fs.readFileSync(BASE + '/route-registry.js', 'utf8');
assert(/require\('\.\/locacao\/locacao-routes'\)/.test(registrySrc), 'route-registry requer o módulo');
assert(/registrarRotasLocacao\(app, db\)/.test(registrySrc), 'route-registry chama registrarRotasLocacao');

const schemaSrc = fs.readFileSync(BASE + '/db-schema.js', 'utf8');
assert(/locacao\/locacao-schema'\)\.initLocacaoSchema\(db\)/.test(schemaSrc),
  'db-schema.js aplica o schema em tenant existente');

const menuSrc = fs.readFileSync(BASE + '/public/js/menu-config.js', 'utf8');
assert(/feature:\s*'locacao'/.test(menuSrc), 'menu-config tem seção com feature locacao');
assert(/locacao\/config\.html/.test(menuSrc), 'menu aponta para a tela de configuração');

// Ícone: o menu usa emoji no config e Lucide na renderização. Emoji fora do
// mapa renderiza sem ícone nenhum.
const sidebarSrc = fs.readFileSync(BASE + '/public/js/sidebar.js', 'utf8');
const emojisMenu = ['🔑', '📋', '📅', '📦', '💲', '🔧', '📉', '⚙️'];
for (const e of emojisMenu) {
  assert(sidebarSrc.includes(`'${e}'`), `mapa de ícones do sidebar conhece ${e}`);
}

const cpSrc = fs.readFileSync(BASE + '/control-plane-routes.js', 'utf8');
assert(/key:\s*'locacao'/.test(cpSrc), 'control-plane lista a feature para o super-admin ligar');

assert(fs.existsSync(BASE + '/public/locacao/config.html'), 'tela public/locacao/config.html existe');

// ─── Restaura a flag como estava ──────────────────────────────────────────────
if (flagOriginal) setFlag(flagOriginal.valor);
else db.prepare("DELETE FROM config WHERE chave = 'locacao_enabled'").run();

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
