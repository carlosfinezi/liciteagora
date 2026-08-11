#!/usr/bin/env node
// migrate-desligar-jornal.js — desliga o Jornal de Licitações antes de a tela
// sair do ar.
//
// O Jornal varria os grupos de palavras-chave e mandava um resumo diário por
// Telegram às 08:00. A descoberta por IA faz a mesma varredura, pelos mesmos
// grupos, com qualificação por score e pelos mesmos canais — a função ficou
// duplicada, e o jornal é o mecanismo antigo, sem filtro.
//
// Remover só a página deixaria o envio saindo todo dia sem nenhuma tela para
// desligar. Aqui o envio é desligado primeiro.
//
// As tabelas e o histórico NÃO são apagados: são registro de mensagem já
// enviada a clientes, e isso não se joga fora.
//
// listAll e não listActive: um tenant suspenso que voltar não pode ressuscitar
// o envio.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const DRY = process.argv.includes('--dry-run');
const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[desligar-jornal] tenants: ${tenants.length}${DRY ? ' (DRY-RUN)' : ''}`);
let desligados = 0;

for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jornal_config'").get()) {
      console.log(`  ${t.slug}: sem jornal, pulando`);
      continue;
    }
    const cfg = db.prepare('SELECT * FROM jornal_config WHERE id = 1').get();
    const envios = db.prepare('SELECT COUNT(*) n FROM jornal_historico').get().n;
    const ultimo = db.prepare('SELECT MAX(dataEnvio) d FROM jornal_historico').get().d;

    if (!cfg || Number(cfg.ativo) !== 1) {
      console.log(`  ${t.slug}: já estava desligado · ${envios} envio(s) no histórico (preservado)`);
      continue;
    }
    if (DRY) {
      console.log(`  ${t.slug}: DESLIGARIA · ${envios} envio(s), último em ${ultimo}`);
      continue;
    }

    db.prepare('UPDATE jornal_config SET ativo = 0 WHERE id = 1').run();
    console.log(`  ${t.slug}: DESLIGADO · ${envios} envio(s) no histórico (preservado), último em ${ultimo}`);
    desligados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}

console.log(`\n${desligados} tenant(s) com o envio desligado.`);
console.log('Tabelas jornal_config, jornal_grupos e jornal_historico mantidas.');
