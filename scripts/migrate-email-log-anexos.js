#!/usr/bin/env node
// migrate-email-log-anexos.js — o log de e-mail passa a guardar QUAL anexo foi
// enviado e de qual documento o e-mail saiu.
//
// `temPdf`/`temBoleto` são booleanos: dizem que havia anexo, não qual. Sem
// nome, tamanho e origem não há como conferir o que o cliente recebeu — que é
// exatamente o que se precisa quando o cliente diz "não veio nada".
//
// Os registros antigos ficam com anexos NULL: o arquivo nunca foi guardado e
// inventar um nome seria pior que admitir a ausência.
//
// listAll e não listActive: applyRouteMigrations só roda na criação do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const COLUNAS = ['anexos TEXT', 'origemTipo TEXT', 'origemId INTEGER', 'reenviadoDeId INTEGER'];

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-email-log] tenants: ${tenants.length}`);
let mudados = 0;

for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_log'").get()) {
      console.log(`  ${t.slug}: sem log de e-mail, pulando`);
      continue;
    }
    const existentes = db.prepare('PRAGMA table_info(email_log)').all().map((c) => c.name);
    const criadas = [];
    for (const def of COLUNAS) {
      const nome = def.split(' ')[0];
      if (existentes.includes(nome)) continue;
      db.exec(`ALTER TABLE email_log ADD COLUMN ${def}`);
      criadas.push(nome);
    }
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_email_log_status ON email_log(status, dataEnvio)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_email_log_origem ON email_log(origemTipo, origemId)');
    } catch { /* índice já existe */ }

    // 'falha' e 'erro' conviviam; o filtro da tela só conhece 'erro', então o
    // que foi gravado como 'falha' era invisível para quem procurava problemas.
    const uniformizados = db.prepare("UPDATE email_log SET status = 'erro' WHERE status = 'falha'").run().changes;

    const st = db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'erro' THEN 1 ELSE 0 END) AS erros,
        SUM(CASE WHEN temPdf = 1 OR temBoleto = 1 THEN 1 ELSE 0 END) AS comAnexo
      FROM email_log`).get();

    const partes = [criadas.length ? `${criadas.length} coluna(s): ${criadas.join(', ')}` : 'já estava aplicado'];
    if (uniformizados) partes.push(`${uniformizados} status 'falha' -> 'erro'`);
    if (st.total) {
      partes.push(`${st.total} registro(s), ${st.erros || 0} com erro, ${st.comAnexo || 0} com anexo`);
      if (st.erros) partes.push('ATENÇÃO: os erros nunca foram reenviados — confira em Comunicação > E-mails Enviados');
    }
    console.log(`  ${t.slug}: ${partes.join(' · ')}`);
    if (criadas.length || uniformizados) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}

console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
