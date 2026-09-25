#!/usr/bin/env node
/**
 * Preenche o ramo dos membros de lista a partir dos destinatários da campanha.
 *
 *   node scripts/backfill-ramo-listas.js <tenant> [--aplicar]
 *
 * ── Por que isto existe ────────────────────────────────────────────────────
 *
 * As listas do `1bit` nasceram em 14/08 de uma cópia das campanhas legado, e a
 * cópia levou telefone e nome, mas não o ramo. Sem ramo não há segmento, e a
 * dor por segmento só funcionava para quem estava na campanha — os mesmos
 * contatos, do outro lado do sistema, ficavam de fora.
 *
 * O ramo continua lá, em `wa_campanha_dest.extras`. Isto casa por telefone e
 * traz de volta.
 *
 * ── Sem `--aplicar`, não escreve nada ──────────────────────────────────────
 *
 * A execução padrão só conta o que mudaria. Rodar um backfill de 27 mil linhas
 * às cegas no banco de um cliente não é coisa que se faça sem ver o número
 * antes.
 *
 * Só preenche quem está SEM ramo: quem já tem veio da importação ou de edição
 * de alguém, e não é a cópia velha que decide por cima.
 */
const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules/better-sqlite3'));
const { chaveDoRamo, SEGMENTOS_PADRAO } = require(path.join(__dirname, '..', 'wa-m1-utils'));

const soDigitos = (s) => String(s || '').replace(/\D/g, '');

function backfill(tenant, aplicar) {
  const arq = path.join(__dirname, '..', 'data', 'tenants', tenant, 'pncp.db');
  const db = new Database(arq, { readonly: !aplicar });

  const temColuna = db.prepare(
    "SELECT COUNT(*) n FROM pragma_table_info('comm_lista_membros') WHERE name='ramo'").get().n;
  if (!temColuna) {
    console.error(`Tenant ${tenant}: a coluna "ramo" ainda não existe. `
      + 'Ela é criada na migration, no boot do consulta-licitacoes.service.');
    process.exit(1);
  }

  // O ramo de cada telefone, pelos destinatários. Os últimos oito dígitos são a
  // chave: a base tem número com e sem o 9, e com e sem o 55.
  const porTelefone = new Map();
  for (const d of db.prepare('SELECT telefone, extras FROM wa_campanha_dest').all()) {
    let ramo = null;
    try { ramo = JSON.parse(d.extras || '{}')?.ramo || null; } catch { ramo = null; }
    if (!ramo) continue;
    const k = soDigitos(d.telefone).slice(-8);
    if (k.length === 8 && !porTelefone.has(k)) porTelefone.set(k, ramo);
  }

  const semRamo = db.prepare(`SELECT id, destinoManual, pessoaId FROM comm_lista_membros
    WHERE TRIM(COALESCE(ramo,'')) = ''`).all();

  const achados = [];
  for (const m of semRamo) {
    const k = soDigitos(m.destinoManual).slice(-8);
    const ramo = k.length === 8 ? porTelefone.get(k) : null;
    if (ramo) achados.push({ id: m.id, ramo });
  }

  const cheias = Object.fromEntries([...SEGMENTOS_PADRAO.map(s => s.chave), 'generico'].map(k => [k, ['.']]));
  const porSegmento = {};
  for (const a of achados) {
    const seg = chaveDoRamo(a.ramo, cheias);
    porSegmento[seg] = (porSegmento[seg] || 0) + 1;
  }

  console.log(`Tenant ${tenant}`);
  console.log(`  membros sem ramo:        ${semRamo.length}`);
  console.log(`  telefones com ramo:      ${porTelefone.size}`);
  console.log(`  seriam preenchidos:      ${achados.length}`);
  console.log(`  ficariam sem ramo:       ${semRamo.length - achados.length}`);
  console.log('  distribuição por segmento:');
  for (const [seg, n] of Object.entries(porSegmento).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(6)}  ${seg}`);
  }

  if (!aplicar) {
    console.log('\n  Nada foi gravado. Rode de novo com --aplicar para valer.');
    return;
  }
  const up = db.prepare('UPDATE comm_lista_membros SET ramo = ? WHERE id = ?');
  const gravar = db.transaction((lista) => { for (const a of lista) up.run(a.ramo, a.id); });
  gravar(achados);
  console.log(`\n  ${achados.length} membro(s) atualizado(s).`);
}

if (require.main === module) {
  const tenant = process.argv[2];
  if (!tenant) { console.error('Uso: node scripts/backfill-ramo-listas.js <tenant> [--aplicar]'); process.exit(1); }
  backfill(tenant, process.argv.includes('--aplicar'));
}

module.exports = { backfill };
