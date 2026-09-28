#!/usr/bin/env node
// Cria um tenant pelo mesmo caminho do painel admin (criarTenant, do
// control-plane-routes.js): schema, migrações de todos os módulos, admin com
// senha temporária e api_key. Depois liga as features pedidas e roda o
// provisionamento de vhost e certificado (a mesma cópia root que o painel usa).
//
//   sudo -u carlosfinezi DISABLE_SCHEDULERS=1 node scripts/criar-tenant.js \
//     --slug floricultura --nome "Floricultura" --plano-id 4 \
//     --features produtos,varejo,fiscal,comercial,financeiro,comunicacao
//
// TUDO AQUI É SÍNCRONO, de propósito. As migrações registram as rotas de
// todos os módulos num app descartável, e alguns deles armam temporizadores ao
// registrar. No servidor isso é inofensivo; num segundo processo seria uma
// segunda produção rodando tarefas automáticas contra os mesmos bancos. Sem
// devolver o controle ao event loop até o process.exit, nenhum temporizador
// chega a disparar. Por isso o vhost roda com spawnSync, e não com o
// spawnProvisionVhost da rota.
//
// Rode como carlosfinezi: é o dono de data/ e o único que o sudo libera para
// o provisionamento.

const { spawnSync } = require('child_process');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { criarTenant, ligarFeature, PROVISION_SCRIPT } = require('../control-plane-routes');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args.slug || !args.nome) {
  console.error('uso: criar-tenant.js --slug X --nome "Nome" [--plano-id N] [--features a,b,c]');
  process.exit(2);
}
if (process.getuid && process.getuid() === 0) {
  console.error('recusado: rode como carlosfinezi (sudo -u carlosfinezi ...), senão data/ fica com arquivo de root');
  process.exit(2);
}

const manager = createTenantManager({ initSchema });
const r = criarTenant(manager, {
  slug: args.slug, name: args.nome, planoId: args['plano-id'] ? Number(args['plano-id']) : undefined,
  trialDays: 0, actor: 'scripts/criar-tenant.js',
});
if (r.erro) { console.error('recusado:', r.erro); process.exit(1); }

for (const key of (args.features || '').split(',').filter(Boolean)) {
  const f = ligarFeature(manager, args.slug, key.trim(), true, 'scripts/criar-tenant.js');
  if (f.erro) { console.error(`feature ${key}: ${f.erro}`); process.exit(1); }
}

// Mesmo significado dos códigos que o spawnProvisionVhost trata: 0 e 20
// prontos, 10 esperando DNS (repita mais tarde com o mesmo script root).
manager.setProvisionStatus({ slug: args.slug, status: 'PROVISIONING', message: 'scripts/criar-tenant.js' });
const p = spawnSync('sudo', ['-n', PROVISION_SCRIPT, args.slug], {
  encoding: 'utf8', timeout: 10 * 60 * 1000,
  env: { ...process.env, PATH: '/usr/local/hestia/bin:' + (process.env.PATH || '') },
});
const msg = ((p.stdout || '') + (p.stderr || '')).split('\n').slice(-6).join('\n').trim();
const estado = (p.status === 0 || p.status === 20) ? 'READY' : p.status === 10 ? 'WAITING_DNS' : 'FAILED';
manager.setProvisionStatus({ slug: args.slug, status: estado, message: `exit=${p.status}\n${msg}` });

console.log(JSON.stringify({
  slug: args.slug,
  status: r.tenant.status,
  endereco: `https://${args.slug}.liciteagora.app/`,
  admin: { usuario: 'admin', senhaTemporaria: r.tempPassword },
  features: (args.features || '').split(',').filter(Boolean),
  vhost: { estado, exit: p.status, saida: msg },
}, null, 2));
process.exit(estado === 'FAILED' ? 1 : 0);
