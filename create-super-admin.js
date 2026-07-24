#!/usr/bin/env node
// create-super-admin.js
//
// Script CLI para criar o primeiro super-admin do control plane.
// Rodar uma vez via: node create-super-admin.js <email> <senha> [nome]
//
// Atualizações de senha ou novos super-admins depois devem ser feitas
// com este mesmo script — o UI não expõe gestão de super-admins (baixo
// volume, melhor forçar acesso ao shell do servidor).

const bcrypt = require('bcryptjs');
const { createTenantManager } = require('./tenant-manager');
const { initSchema } = require('./db-schema');

const [, , email, password, name] = process.argv;
if (!email || !password) {
  console.error('Uso: node create-super-admin.js <email> <senha> [nome]');
  process.exit(1);
}

const mgr = createTenantManager({ initSchema });
const controlDb = mgr.controlDb;

const existing = controlDb.prepare('SELECT id FROM super_admins WHERE email = ?').get(email.toLowerCase().trim());
const hash = bcrypt.hashSync(password, 10);

if (existing) {
  controlDb.prepare('UPDATE super_admins SET password_hash = ?, name = COALESCE(?, name) WHERE id = ?')
    .run(hash, name || null, existing.id);
  console.log(`[ok] senha atualizada para ${email} (id=${existing.id})`);
} else {
  const info = controlDb.prepare(
    'INSERT INTO super_admins (email, password_hash, name, created_at) VALUES (?, ?, ?, ?)'
  ).run(email.toLowerCase().trim(), hash, name || null, Date.now());
  console.log(`[ok] super-admin criado: ${email} (id=${info.lastInsertRowid})`);
}

mgr.closeAll();
