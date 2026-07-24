#!/usr/bin/env node
// One-off: cria tenant interno "jaagricola" (lab de migração ERP Solution).
// Replica POST /api/admin/tenants sem o provisionamento de vhost/SSL.
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const crypto = require('crypto');
const bcrypt = require(BASE + '/node_modules/bcryptjs');
const { createTenantManager } = require(BASE + '/tenant-manager');
const { initSchema } = require(BASE + '/db-schema');
const { applyRouteMigrations } = require(BASE + '/tenant-provision');

const SLUG = 'jaagricola';

const mgr = createTenantManager({ initSchema });
if (mgr.getTenantBySlug(SLUG)) {
  console.error(`tenant "${SLUG}" já existe — abortando`);
  process.exit(1);
}

const tenant = mgr.createTenant({
  slug: SLUG,
  name: 'JA Agrícola (Lab Migração Solution)',
  ownerEmail: 'atendimento@1bit.net.br',
  plan: 'enterprise',
  status: 'ACTIVE',
  planoId: 4, // Vitalício/Interno
  actor: 'claude-migracao-solution',
});
console.log('tenant criado:', tenant.slug, '->', tenant.db_path);

const db = mgr.getDb(SLUG);
applyRouteMigrations(db, tenant);
console.log('route migrations aplicadas');

const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
db.prepare(
  "INSERT OR REPLACE INTO users (username, passwordHash, nome, role, ativo) VALUES (?, ?, ?, 'admin', 1)"
).run('admin', bcrypt.hashSync(tempPassword, 10), 'Administrador');

let apiKeyRow = db.prepare("SELECT valor FROM config WHERE chave = 'api_key'").get();
if (!apiKeyRow) {
  const apiKey = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)").run('api_key', apiKey);
  apiKeyRow = { valor: apiKey };
}

console.log('admin password:', tempPassword);
console.log('api_key:', apiKeyRow.valor);
console.log('OK');
// applyRouteMigrations registra rotas que iniciam timers — sem isso o processo não encerra
process.exit(0);
