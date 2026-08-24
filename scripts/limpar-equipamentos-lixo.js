#!/usr/bin/env node
// limpar-equipamentos-lixo.js — remove equipamentos criados pelo backfill
// que não descrevem um aparelho (ex.: "Suporte", que é tipo de serviço).
//
// Uso:
//   node scripts/limpar-equipamentos-lixo.js <tenant> "<descricao>" [--aplicar]
//
// Sem --aplicar é só relatório. Só remove equipamento SEM série, SEM
// patrimônio e sem nada além do vínculo com OS — os textos originais
// continuam em os_ordens, então re-rodar o backfill recria se for engano.

const Database = require('better-sqlite3');
const path = require('path');

const [, , slug, descricao] = process.argv;
const APLICAR = process.argv.includes('--aplicar');
if (!slug || !descricao) {
  console.error('uso: node scripts/limpar-equipamentos-lixo.js <tenant> "<descricao>" [--aplicar]');
  process.exit(2);
}

const dbPath = path.join(__dirname, '..', 'data', 'tenants', slug, 'pncp.db');
const db = new Database(dbPath);
const log = m => console.log('[limpar-equip] ' + m);

const alvos = db.prepare(`
  SELECT e.id, e.descricao, e.clienteId, e.numeroSerie, e.patrimonio,
         (SELECT COUNT(*) FROM os_ordens o WHERE o.equipamentoId = e.id) AS osVinculadas
  FROM equipamentos e
  WHERE LOWER(TRIM(e.descricao)) = LOWER(TRIM(?))
    AND (e.numeroSerie IS NULL OR e.numeroSerie = '')
    AND (e.patrimonio IS NULL OR e.patrimonio = '')`).all(descricao);

if (!alvos.length) { log(`nenhum equipamento "${descricao}" sem série/patrimônio em ${slug}`); process.exit(0); }

log(`${slug}: ${alvos.length} equipamento(s) "${descricao}"${APLICAR ? '' : ' (DRY-RUN)'}`);
for (const a of alvos) log(`  #${a.id} cliente=${a.clienteId ?? '—'} · ${a.osVinculadas} OS vinculada(s)`);

const totalOS = alvos.reduce((s, a) => s + a.osVinculadas, 0);
log(`${totalOS} OS voltam a ficar sem equipamentoId (o texto original em os_ordens.equipamento não é tocado)`);

if (!APLICAR) { log('nada gravado — rode com --aplicar para efetivar'); process.exit(0); }

const ids = alvos.map(a => a.id);
const marks = ids.map(() => '?').join(',');
db.transaction(() => {
  db.prepare(`UPDATE os_ordens SET equipamentoId = NULL WHERE equipamentoId IN (${marks})`).run(...ids);
  db.prepare(`DELETE FROM equipamento_eventos WHERE equipamentoId IN (${marks})`).run(...ids);
  db.prepare(`DELETE FROM equipamentos WHERE id IN (${marks})`).run(...ids);
})();

const sobrou = db.prepare(`SELECT COUNT(*) n FROM equipamentos WHERE id IN (${marks})`).get(...ids).n;
if (sobrou) { log(`ERRO: ${sobrou} equipamento(s) não removido(s)`); process.exit(1); }
log(`removidos ${ids.length} equipamento(s); ${totalOS} OS desvinculada(s)`);
db.close();
