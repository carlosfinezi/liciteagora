#!/usr/bin/env node
// limpar-funil-orfao.js — remove o funil próprio que a central de Conversas
// teve por algumas horas em 2026-08-14, antes de passar a usar o CRM.
//
// Estruturas removidas:
//   - tabela conv_funil_etapas
//   - colunas conv_conversas.etapaId / .valor / .etapaEm
//
// Guarda de segurança: se ALGUMA conversa tiver dado nessas colunas, o tenant
// é pulado — dado órfão ainda é dado, e apagar sem olhar é como se perde
// informação de produção. Rode o backup antes (scripts/backup-tenants.sh).
//
// Uso:
//   node scripts/limpar-funil-orfao.js           (simula, não altera nada)
//   node scripts/limpar-funil-orfao.js --aplicar (executa)

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const APLICAR = process.argv.includes('--aplicar');
const COLUNAS = ['etapaId', 'valor', 'etapaEm'];

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[limpar-funil] ${tenants.length} tenant(s) · modo: ${APLICAR ? 'APLICAR' : 'simulação'}`);

let alterados = 0, pulados = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const temTabela = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conv_funil_etapas'").get();
    const cols = db.prepare('PRAGMA table_info(conv_conversas)').all().map(c => c.name);
    const aRemover = COLUNAS.filter(c => cols.includes(c));
    if (!temTabela && !aRemover.length) { console.log(`  ${t.slug}: nada a fazer`); continue; }

    // Guarda: alguma conversa usa as colunas?
    let emUso = 0;
    if (aRemover.length) {
      const cond = aRemover.map(c => `${c} IS NOT NULL`).join(' OR ');
      emUso = db.prepare(`SELECT COUNT(*) n FROM conv_conversas WHERE ${cond}`).get().n;
    }
    if (emUso) {
      console.log(`  ${t.slug}: PULADO — ${emUso} conversa(s) com dado nessas colunas`);
      pulados++;
      continue;
    }

    const feito = [];
    if (APLICAR) {
      db.exec('PRAGMA foreign_keys = OFF');
      if (temTabela) { db.exec('DROP TABLE conv_funil_etapas'); feito.push('conv_funil_etapas'); }
      for (const c of aRemover) {
        db.exec(`ALTER TABLE conv_conversas DROP COLUMN ${c}`);
        feito.push('conv_conversas.' + c);
      }
      db.exec('PRAGMA foreign_keys = ON');
    } else {
      if (temTabela) feito.push('conv_funil_etapas');
      feito.push(...aRemover.map(c => 'conv_conversas.' + c));
    }
    alterados++;
    console.log(`  ${t.slug}: ${APLICAR ? 'removido' : 'removeria'} ${feito.join(', ')}`);
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
  } finally {
    db.close();
  }
}
console.log(`[limpar-funil] ${alterados} tenant(s) ${APLICAR ? 'limpos' : 'a limpar'}${pulados ? ` · ${pulados} pulado(s)` : ''}`);
if (!APLICAR) console.log('[limpar-funil] simulação — rode com --aplicar para executar');
