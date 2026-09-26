/**
 * banco-de-teste.js — cópia descartável do banco de um tenant, para suíte.
 *
 *   const { copiaDoTenant } = require('./banco-de-teste');
 *   const db = new Database(copiaDoTenant('labfiscal'));
 *
 * Até 2026-09-25, 35 suítes do verify abriam para ESCRITA o banco de produção
 * de um tenant interno (labfiscal, jaagricola, sandbox, sandbox5), e cada
 * rodada deixava lá o que não conseguia apagar: 17 pedidos no sandbox5 em duas
 * semanas, e a etapa 93 reprovando porque os CNPJs de teste tinham acabado.
 * Agora cada suíte recebe um arquivo próprio em /tmp, que some quando o
 * processo termina.
 *
 * A cópia é `VACUUM INTO` a partir de uma conexão SOMENTE LEITURA: o SQLite
 * entrega um retrato consistente, com o que ainda está no -wal, sem escrever
 * nada na origem. `cp` de banco vivo em WAL daria um arquivo corrompido.
 *
 * Síncrono de propósito: as suítes abrem o banco no topo do arquivo, antes de
 * qualquer `await`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const criados = [];

process.on('exit', () => {
  for (const d of criados) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* já saiu */ }
  }
});

/**
 * @param {string} slug  tenant de origem, em data/tenants/<slug>/pncp.db
 * @returns {string} caminho de um pncp.db temporário com o conteúdo atual dele
 */
function copiaDoTenant(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`banco-de-teste: slug inválido "${slug}"`);
  const origem = path.join(RAIZ, 'data', 'tenants', slug, 'pncp.db');
  if (!fs.existsSync(origem)) throw new Error(`banco-de-teste: ${origem} não existe`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `banco-teste-${slug}-`));
  criados.push(dir);
  const destino = path.join(dir, 'pncp.db');

  const src = new Database(origem, { readonly: true, fileMustExist: true });
  try {
    src.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  return destino;
}

module.exports = { copiaDoTenant };
