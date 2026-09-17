// Script de migracao (one-shot): separa a Contabilidade do Financeiro.
//
// Ate 2026-08-25 a secao Contabilidade do menu era gated por `financeiro`, e
// nao existia a flag `contabilidade_enabled`. A escrituracao passou a ser
// modulo proprio (FEATURES em control-plane-routes.js), acompanhando o que a
// matriz de planos ja fazia: `contabilidade` e slug separado em plan-modules
// e NAO esta na familia `financeiro` do module-gate.
//
// Politica escolhida: preservar o que cada tenant enxerga hoje. Todo tenant
// com `financeiro_enabled=1` recebe `contabilidade_enabled=1`. Quem nao tinha
// Financeiro nao ganha nada.
//
// Idempotente: so grava onde a chave ainda nao existe.
//
// Uso:
//   node scripts/migrar-feature-contabilidade.js --dry-run
//   node scripts/migrar-feature-contabilidade.js

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dryRun = process.argv.includes('--dry-run');
const RAIZ = path.join(__dirname, '..');
const TENANTS_DIR = path.join(RAIZ, 'data', 'tenants');

const slugs = fs.readdirSync(TENANTS_DIR).filter((s) =>
  fs.existsSync(path.join(TENANTS_DIR, s, 'pncp.db')));

console.log(`${dryRun ? '[DRY-RUN] ' : ''}Separando contabilidade de financeiro em ${slugs.length} tenant(s)\n`);

let ligados = 0, pulados = 0, jaTinham = 0;

for (const slug of slugs) {
  const db = new Database(path.join(TENANTS_DIR, slug, 'pncp.db'));
  try {
    const ler = (chave) => {
      const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
      return row ? row.valor : null;
    };
    const financeiro = ler('financeiro_enabled');
    const atual = ler('contabilidade_enabled');

    if (atual !== null) {
      console.log(`  ${slug.padEnd(22)} ja tem contabilidade_enabled=${atual} — intacto`);
      jaTinham++;
      continue;
    }
    if (financeiro !== '1') {
      console.log(`  ${slug.padEnd(22)} sem financeiro — fica desligado`);
      pulados++;
      continue;
    }
    if (!dryRun) {
      db.prepare('INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)')
        .run('contabilidade_enabled', '1');
    }
    console.log(`  ${slug.padEnd(22)} financeiro=1 -> contabilidade_enabled=1`);
    ligados++;
  } finally {
    db.close();
  }
}

console.log(`\n${dryRun ? '[DRY-RUN] ' : ''}ligados: ${ligados} | ja tinham: ${jaTinham} | desligados: ${pulados}`);
if (dryRun) console.log('Nada foi escrito. Rode sem --dry-run para aplicar.');
