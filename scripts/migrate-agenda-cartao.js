#!/usr/bin/env node
// migrate-agenda-cartao.js — liga a agenda de recebiveis a conta a receber e
// guarda a CP da taxa. A agenda vivia em paralelo ao contas a receber: baixar
// um nao fechava o outro.
//
// listAll e nao listActive: applyRouteMigrations so roda na criacao do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarAgendaCartao } = require('../tesouraria-routes');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-agcartao] tenants: ${tenants.length}`);
let mudados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agenda_recebiveis_cartao'").get()) {
      console.log(`  ${t.slug}: sem tesouraria, pulando`); continue;
    }
    const antes = db.prepare('PRAGMA table_info(agenda_recebiveis_cartao)').all().map(c => c.name);
    migrarAgendaCartao(db);
    const novas = db.prepare('PRAGMA table_info(agenda_recebiveis_cartao)').all()
      .map(c => c.name).filter(c => !antes.includes(c));

    // A FK de pedido_parcelas apontava para 'pessoas' em bases antigas. Reporta
    // quem ainda esta assim — reconstruir a tabela e decisao a parte.
    const fk = (db.prepare("SELECT sql FROM sqlite_master WHERE name='pedido_parcelas'").get() || {}).sql || '';
    const fkRuim = /bandeiraId\)?\s*REFERENCES\s+pessoas/i.test(fk) || (/REFERENCES pessoas/.test(fk) && !/REFERENCES adquirentes_cartao/.test(fk));

    const partes = [];
    if (novas.length) partes.push(`${novas.length} coluna(s): ${novas.join(', ')}`);
    if (fkRuim) partes.push('ATENCAO: pedido_parcelas.bandeiraId ainda referencia pessoas');
    console.log(partes.length ? `  ${t.slug}: ${partes.join(' · ')}` : `  ${t.slug}: já estava aplicado`);
    if (novas.length) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}
console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
