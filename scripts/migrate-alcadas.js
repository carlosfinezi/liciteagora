#!/usr/bin/env node
// migrate-alcadas.js — faixas de alçada, valor travado na aprovação e prazo.
//
// Colunas novas:
//   regras_alcada.validadeDias  — sem ela a aprovação valia para sempre
//   aprovacoes.regraId/papelExigido — quem pode decidir vem da própria
//     aprovação; antes vinha de "uma regra do tipo" e podia ser de outra faixa
//   aprovacoes.valorAprovado/expiraEm — a aprovação passa a valer para um
//     valor e um prazo
//
// Aprovações antigas ficam sem `expiraEm` (nunca vencem) e sem `valorAprovado`
// — nesse caso o consumo cai em `valorReferencia`, que já existia. Preencher
// prazo retroativo invalidaria aprovações que alguém deu de boa-fé.
//
// listAll e não listActive: applyRouteMigrations só roda na criação do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const alc = require('../governanca-alcadas');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-alcadas] tenants: ${tenants.length}`);
let mudados = 0;

for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='regras_alcada'").get()) {
      console.log(`  ${t.slug}: sem o módulo de governança, pulando`);
      continue;
    }
    const antes = db.prepare('PRAGMA table_info(aprovacoes)').all().map((c) => c.name);
    alc.migrarDB(db);
    const novas = db.prepare('PRAGMA table_info(aprovacoes)').all()
      .map((c) => c.name).filter((c) => !antes.includes(c));

    const regras = db.prepare('SELECT COUNT(*) n FROM regras_alcada WHERE ativo = 1').get().n;
    const pendentes = db.prepare("SELECT COUNT(*) n FROM aprovacoes WHERE status = 'pendente'").get().n;
    const abertas = db.prepare("SELECT COUNT(*) n FROM aprovacoes WHERE status = 'aprovada' AND consumida = 0").get().n;

    const partes = [novas.length ? `${novas.length} coluna(s): ${novas.join(', ')}` : 'já estava aplicado'];
    if (regras) {
      partes.push(`${regras} faixa(s) ativa(s)`);
      // A regra aplicada passou a ser a de MAIOR limite ultrapassado. Quem tem
      // mais de uma faixa vai ver o comportamento mudar — para o certo.
      const porEvento = db.prepare(`SELECT tipoEvento, COUNT(*) n FROM regras_alcada
        WHERE ativo = 1 GROUP BY tipoEvento HAVING n > 1`).all();
      if (porEvento.length) {
        partes.push('ATENÇÃO: ' + porEvento.map((x) => `${x.tipoEvento} tem ${x.n} faixas`).join(', ')
          + ' — antes só a de menor limite valia; agora cada valor cai na faixa certa');
      }
    }
    if (pendentes) partes.push(`${pendentes} aprovação(ões) pendente(s)`);
    if (abertas) partes.push(`${abertas} aprovada(s) sem uso — seguem válidas, sem prazo retroativo`);

    console.log(`  ${t.slug}: ${partes.join(' · ')}`);
    if (novas.length) mudados++;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}

console.log(`\n${mudados} tenant(s) alterado(s) de ${tenants.length}.`);
