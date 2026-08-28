#!/usr/bin/env node
/**
 * test-producao-f0.js — a FIAÇÃO do módulo nos pontos de registro do core.
 *
 * POR QUE ESTE TESTE EXISTE, e por que ele veio depois dos outros:
 *
 * um vertical só aparece para o usuário quando OITO arquivos diferentes do
 * core o citam. As suítes F1/F2 exercitam o comportamento do módulo com as
 * rotas registradas na mão pelo harness — elas passam 100% mesmo que o módulo
 * esteja invisível em produção.
 *
 * Foi exatamente o que aconteceu em 2026-08-27: 344 asserções verdes e o
 * módulo ausente do painel do super-admin, porque `control-plane-routes.js`
 * tem um catálogo PRÓPRIO de features (`FEATURES`) que ninguém mais consulta.
 * `scripts/test-locacao-f0.js` já cobria isso para a locação; faltava o
 * equivalente aqui.
 *
 * Este teste é de código-fonte, não de runtime: lê os arquivos e confere que
 * cada ponto cita o módulo. Não precisa de banco.
 *
 * Uso: node scripts/test-producao-f0.js
 */

const fs = require('fs');
const path = require('path');
const BASE = path.resolve(__dirname, '..');

let ok = 0, fail = 0;
const falhas = [];
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else {
    fail++; falhas.push(msg);
    console.error(`  ✗ ${msg}${extra !== undefined ? '\n      ' + String(extra).slice(0, 300) : ''}`);
  }
}
function secao(t) { console.log(`\n── ${t}`); }

const ler = f => fs.readFileSync(path.join(BASE, f), 'utf8');

// ─── 1. Plano ────────────────────────────────────────────────────────────────
secao('plan-modules.js — o slug e os tiers');
{
  const { MODULE_SLUGS, PLAN_MATRIX } = require(BASE + '/plan-modules');
  assert(MODULE_SLUGS.includes('producao'), "slug 'producao' em MODULE_SLUGS");
  assert(PLAN_MATRIX.enterprise.modules.includes('producao'), 'enterprise inclui producao');
  assert(!PLAN_MATRIX.starter.modules.includes('producao'), 'starter NÃO inclui producao');
  for (const tier of Object.keys(PLAN_MATRIX)) {
    const invalidos = PLAN_MATRIX[tier].modules.filter(m => !MODULE_SLUGS.includes(m));
    assert(invalidos.length === 0, `tier ${tier} só cita slugs válidos`, invalidos.join(', '));
  }
}

// ─── 2. Feature flags ────────────────────────────────────────────────────────
secao('features-routes.js — a chave da sidebar');
{
  const { FEATURE_KEYS } = require(BASE + '/features-routes');
  assert(FEATURE_KEYS.includes('producao'), "chave 'producao' em FEATURE_KEYS");
}

// ─── 3. Gate de módulo ───────────────────────────────────────────────────────
secao('module-gate.js — o prefixo protegido');
{
  const src = ler('module-gate.js');
  assert(/producao:\s*\['producao'\]/.test(src),
    'module-gate mapeia a feature legada producao');
  assert(/prefix:\s*'\/api\/producao\/',\s*module:\s*'producao'/.test(src),
    'module-gate protege o prefixo /api/producao/');
}

// ─── 4. Registro de rotas ────────────────────────────────────────────────────
secao('route-registry.js — as rotas sobem com o servidor');
{
  const src = ler('route-registry.js');
  assert(/require\('\.\/producao\/producao-routes'\)/.test(src), 'route-registry requer o módulo');
  assert(/registrarRotasProducao\(app, db\)/.test(src), 'route-registry chama registrarRotasProducao');
}

// ─── 5. Schema em tenant existente ───────────────────────────────────────────
secao('db-schema.js — o schema alcança tenant existente');
{
  const src = ler('db-schema.js');
  assert(/producao\/prod-schema'\)\.initProducaoSchema\(db\)/.test(src),
    'db-schema.js aplica o schema (o migrar() das rotas é no-op em multi-tenant)');
}

// ─── 6. Menu ─────────────────────────────────────────────────────────────────
secao('menu-config.js — o grupo na sidebar');
{
  const src = ler('public/js/menu-config.js');
  assert(/feature:\s*'producao'/.test(src), 'menu-config tem grupo com feature producao');

  // Toda página citada no menu tem de existir: item de menu que dá 404 é o
  // tipo de erro que só aparece quando o cliente clica.
  const paginas = [...src.matchAll(/link:\s*'\/producao\/([^']+)'/g)].map(m => m[1]);
  assert(paginas.length === 10, 'o grupo tem os 10 itens', paginas.length);
  for (const p of paginas) {
    assert(fs.existsSync(path.join(BASE, 'public/producao', p)),
      `a página ${p} existe`);
  }

  // O emoji do menu é traduzido para Lucide pelo sidebar.js. Emoji fora do
  // mapa renderiza sem ícone nenhum, em silêncio.
  const sidebarSrc = ler('public/js/sidebar.js');
  const grupo = src.slice(src.indexOf("feature: 'producao'"));
  const emojis = [...grupo.slice(0, 2000).matchAll(/icone:\s*'([^']+)'/g)].map(m => m[1]);
  assert(emojis.length > 0, 'o grupo declara ícones', emojis.length);
  for (const e of new Set(emojis)) {
    assert(sidebarSrc.includes(`'${e}'`), `o mapa de ícones do sidebar conhece ${e}`);
  }
}

// ─── 7. Perfis de acesso ─────────────────────────────────────────────────────
secao('perfis-api-map.js — o mapa de permissão');
{
  const src = ler('perfis-api-map.js');
  assert(/'\/api\/producao':/.test(src), 'perfis-api-map cobre /api/producao');
}

// ─── 8. Control plane ────────────────────────────────────────────────────────
secao('control-plane-routes.js — o super-admin consegue LIGAR o módulo');
{
  // Este é o ponto que faltou em 2026-08-27: o painel em admin.liciteagora.app
  // lista `FEATURES` daqui, e não o MODULE_SLUGS do plano. Sem a entrada, o
  // módulo existe, responde e está no menu — mas ninguém consegue ativá-lo.
  const src = ler('control-plane-routes.js');
  assert(/key:\s*'producao'/.test(src),
    'control-plane lista a feature para o super-admin ligar por tenant');

  const { FEATURE_KEYS } = require(BASE + '/features-routes');
  const chavesCp = [...src.matchAll(/\{\s*key:\s*'([a-z_]+)',\s*label:/g)].map(m => m[1]);
  const orfas = chavesCp.filter(k => !FEATURE_KEYS.includes(k));
  assert(orfas.length === 0,
    'toda feature do control-plane existe em FEATURE_KEYS', orfas.join(', '));
}

// ─── 9. Arquivos do módulo ───────────────────────────────────────────────────
secao('Arquivos');
{
  for (const f of ['prod-schema.js', 'prod-util.js', 'ficha.js', 'ordem.js', 'apontamento.js',
    'qualidade.js', 'produtividade.js', 'projeto.js', 'expedicao.js', 'perfis.js', 'producao-routes.js']) {
    assert(fs.existsSync(path.join(BASE, 'producao', f)), `producao/${f}`);
  }
  assert(fs.existsSync(path.join(BASE, 'docs/modulo-producao-plano-2026-08-28.md')),
    'o plano do módulo está documentado');
}

// ─── 10. A flag nasce desligada ──────────────────────────────────────────────
secao('A flag nasce desligada');
{
  const { getFlag, CONFIG_DEFAULTS } = require(BASE + '/producao/producao-routes');
  // Banco falso: sem a chave `producao_enabled`, getFlag tem de devolver false.
  const dbFalso = { prepare: () => ({ get: () => undefined }) };
  assert(getFlag(dbFalso) === false, 'sem a chave gravada, o módulo está DESLIGADO');
  assert(CONFIG_DEFAULTS.producao_permitir_liberacao_sem_ensaio === '0',
    'o bypass da liberação por ensaio nasce desligado');
  assert(CONFIG_DEFAULTS.producao_permitir_recurso_sobreposto === '0',
    'a sobreposição de recurso nasce desligada');
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`F0 (fiação): ${ok} passaram, ${fail} falharam`);
if (fail) { console.log('\nFalhas:'); falhas.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
