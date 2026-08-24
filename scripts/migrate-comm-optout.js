#!/usr/bin/env node
// migrate-comm-optout.js — opt-out unificado por canal e consentimento ligado.
//
// Cria comm_optout e traz para lá os registros de wa_optout. Esses registros
// são pessoas que pediram para parar de receber: perdê-los na unificação seria
// voltar a mandar mensagem para quem disse não.
//
// Também mostra quantas pessoas têm marketing recusado no cadastro — número que
// o motor de campanhas ignorava e agora respeita.
//
// listAll e não listActive: applyRouteMigrations só roda na criação do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const dest = require('../comm-destinos');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-comm-optout] tenants: ${tenants.length}`);
let mudados = 0;

for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comm_campanhas'").get()) {
      console.log(`  ${t.slug}: sem o módulo de comunicação, pulando`);
      continue;
    }
    const tinha = !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='comm_optout'").get();
    const antes = tinha ? db.prepare('SELECT COUNT(*) n FROM comm_optout').get().n : 0;

    dest.migrarDB(db);

    const depois = db.prepare('SELECT COUNT(*) n FROM comm_optout').get().n;
    const porCanal = db.prepare('SELECT canal, COUNT(*) n FROM comm_optout GROUP BY canal')
      .all().map((r) => `${r.n} ${r.canal}`).join(', ');

    // Quem marcou recusa no cadastro e recebia assim mesmo.
    const recusas = (() => {
      try {
        const r = db.prepare(`SELECT
            SUM(CASE WHEN aceitaEmailMarketing = 0 THEN 1 ELSE 0 END) AS email,
            SUM(CASE WHEN aceitaWhatsappMarketing = 0 THEN 1 ELSE 0 END) AS wa
          FROM pessoas`).get();
        return { email: r.email || 0, wa: r.wa || 0 };
      } catch { return null; }
    })();

    const partes = [tinha ? 'tabela já existia' : 'opt-out unificado criado'];
    if (depois > antes) partes.push(`${depois - antes} opt-out(s) migrado(s) de wa_optout`);
    if (depois) partes.push(`total: ${porCanal}`);
    if (recusas && (recusas.email || recusas.wa)) {
      partes.push(`consentimento recusado no cadastro: ${recusas.email} e-mail / ${recusas.wa} whatsapp `
        + '— agora respeitado em campanha de marketing');
    }
    console.log(`  ${t.slug}: ${partes.join(' · ')}`);
    if (!tinha || depois > antes) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}

console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
