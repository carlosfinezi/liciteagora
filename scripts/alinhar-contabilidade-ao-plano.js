// Script de correcao (one-shot): alinha a flag `contabilidade_enabled` de cada
// tenant ao que o plano dele efetivamente concede.
//
// Contexto: a migracao anterior (migrar-feature-contabilidade.js) preservou o
// que cada tenant ENXERGAVA, ligando contabilidade onde havia financeiro. Isso
// deixou tenants de tier basico/trial com a Contabilidade no menu, embora a
// matriz de planos so conceda `contabilidade` a Avancado/Enterprise.
//
// Fonte da verdade: module-gate.getEffectiveModules (tier + overrides), o mesmo
// resolvedor que o feature-gate usaria. NAO uma lista de tiers no braco: assim
// um override manual de super-admin (upsell, cortesia) e respeitado.
//
// Politica: DESLIGA onde o plano nao concede. NAO liga onde concede mas a flag
// esta ausente — ligar modulo que o tenant nunca viu e decisao comercial, nao
// consequencia automatica desta correcao (o script lista esses casos).
//
// Idempotente. Modo --dry-run lista sem escrever.
//
// Uso:
//   node scripts/alinhar-contabilidade-ao-plano.js --dry-run
//   node scripts/alinhar-contabilidade-ao-plano.js

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { getEffectiveModules } = require('../module-gate');

const dryRun = process.argv.includes('--dry-run');
const RAIZ = path.join(__dirname, '..');
const CONTROL_DB = path.join(RAIZ, 'data', 'control.db');
const TENANTS_DIR = path.join(RAIZ, 'data', 'tenants');

const control = new Database(CONTROL_DB, { readonly: true });
const tenants = control.prepare('SELECT id, slug, plan FROM tenants ORDER BY slug').all();

console.log(`${dryRun ? '[DRY-RUN] ' : ''}Alinhando contabilidade_enabled ao plano — ${tenants.length} tenant(s)\n`);

let desligados = 0, mantidos = 0, semDireitoJaOff = 0;
const podemLigar = [];

for (const t of tenants) {
  const dbPath = path.join(TENANTS_DIR, t.slug, 'pncp.db');
  if (!fs.existsSync(dbPath)) continue;

  const temDireito = getEffectiveModules(control, t).modules.has('contabilidade');
  const db = new Database(dbPath);
  try {
    const row = db.prepare("SELECT valor FROM config WHERE chave = 'contabilidade_enabled'").get();
    const ligada = !!(row && row.valor === '1');
    const tier = String(t.plan || '-');

    if (temDireito && ligada) {
      console.log(`  ${t.slug.padEnd(22)} ${tier.padEnd(12)} plano concede, flag ligada — mantido`);
      mantidos++;
    } else if (temDireito && !ligada) {
      console.log(`  ${t.slug.padEnd(22)} ${tier.padEnd(12)} plano CONCEDE mas flag desligada — nao mexido`);
      podemLigar.push(t.slug);
    } else if (!temDireito && ligada) {
      if (!dryRun) {
        db.prepare('INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)')
          .run('contabilidade_enabled', '0');
      }
      console.log(`  ${t.slug.padEnd(22)} ${tier.padEnd(12)} plano NAO concede — DESLIGANDO`);
      desligados++;
    } else {
      console.log(`  ${t.slug.padEnd(22)} ${tier.padEnd(12)} sem direito, ja desligada — intacto`);
      semDireitoJaOff++;
    }
  } finally {
    db.close();
  }
}

console.log(`\n${dryRun ? '[DRY-RUN] ' : ''}desligados: ${desligados} | mantidos: ${mantidos} | ja off: ${semDireitoJaOff}`);
if (podemLigar.length) {
  console.log(`\nTem direito pelo plano mas esta desligado (ligue no admin se quiser): ${podemLigar.join(', ')}`);
}
if (dryRun) console.log('\nNada foi escrito. Rode sem --dry-run para aplicar.');
