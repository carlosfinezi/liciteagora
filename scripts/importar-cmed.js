#!/usr/bin/env node
/**
 * importar-cmed.js — importa a Lista de Preços de Medicamentos da CMED/ANVISA
 * para um tenant.
 *
 * A planilha é pública e sai mensalmente em
 *   https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos
 * no link "PMC - XLS" (xls_conformidade_site_AAAAMMDD_*.xlsx).
 *
 * Uso:
 *   node scripts/importar-cmed.js <tenant> <arquivo.xlsx> [--coluna 19] [--uf PA] [--competencia 2026-08]
 *   node scripts/importar-cmed.js labfiscal /tmp/cmed-pmc.xlsx
 *
 * A coluna de PMC e a UF, quando omitidas, vêm da config do tenant
 * (farmacia_coluna_pmc / farmacia_uf).
 */
const fs = require('fs');
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const { initFarmaciaSchema } = require(BASE + '/farmacia/farmacia-schema');
const { lerConfig } = require(BASE + '/farmacia/farmacia-routes');
const { importarCmed } = require(BASE + '/farmacia/cmed-import');

const args = process.argv.slice(2);
const flag = (nome) => {
  const i = args.indexOf('--' + nome);
  return i >= 0 ? args[i + 1] : null;
};
const posicionais = args.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

const [tenant, arquivo] = posicionais;
if (!tenant || !arquivo) {
  console.error('uso: node scripts/importar-cmed.js <tenant> <arquivo.xlsx> [--coluna 19] [--uf PA] [--competencia AAAA-MM]');
  process.exit(2);
}
const caminhoDb = `${BASE}/data/tenants/${tenant}/pncp.db`;
if (!fs.existsSync(caminhoDb)) { console.error('tenant não encontrado: ' + caminhoDb); process.exit(2); }
if (!fs.existsSync(arquivo)) { console.error('arquivo não encontrado: ' + arquivo); process.exit(2); }

const db = new Database(caminhoDb);
initFarmaciaSchema(db);
const cfg = lerConfig(db);

const t0 = Date.now();
const r = importarCmed(db, arquivo, {
  colunaPmc: flag('coluna') || cfg.farmacia_coluna_pmc,
  uf: flag('uf') || cfg.farmacia_uf,
  competencia: flag('competencia') || undefined,
  arquivoNome: arquivo.split('/').pop(),
  usuario: 'cli',
});

console.log(`competência ${r.competencia} · PMC ${r.colunaPmc}% · UF ${r.uf}`);
console.log(`  linhas lidas .... ${r.lidas}`);
console.log(`  casadas ......... ${r.casadas}`);
console.log(`  não casadas ..... ${r.naoCasadas}  (fila de conferência)`);
console.log(`  sem PMC nesta UF  ${r.semPmc}`);
console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
