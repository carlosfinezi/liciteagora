/**
 * scan-direct.js — Roda análise IA dos grupos pendentes via processo
 * separado do consulta-licitacoes.service. Sobrevive a restarts do
 * servidor porque é nohup standalone.
 *
 * Usa as mesmas funções do scheduler (executarScanGrupo) e o mesmo
 * tenant DB com attachCatalog. SQLite WAL aguenta um writer (este
 * script) + leitores do server.js sem conflito significativo.
 *
 * Uso: node scan-direct.js /caminho/pncp.db [grupoId1 grupoId2 ...]
 *      (sem args = roda todos os grupos com ativo=1)
 */

const path = require('path');
process.chdir(__dirname);

const Database = require('better-sqlite3');
const { attachCatalog } = require('./catalog-manager.js');
const { executarScanGrupo, carregarGrupoCompleto } = require('./analise-ia-scheduler.js');

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Uso: node scan-direct.js <pncp.db> [grupoIds...]');
  process.exit(1);
}

const filterGrupos = process.argv.slice(3).map(Number).filter(Boolean);

function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

const db = new Database(dbPath);
attachCatalog(db);

// Carrega chaves IA do mesmo config do tenant
function getIAKeys() {
  const row = (chave) => {
    const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
    return r && r.valor ? r.valor : null;
  };
  return {
    cerebras: row('cerebras_api_key'),
    gemini: row('gemini_api_key'),
    deepseek: row('deepseek_api_key'),
    groq: row('groq_api_key'),
    anthropic: row('anthropic_api_key'),
  };
}

async function main() {
  const keys = getIAKeys();
  const providers = Object.entries(keys).filter(([_, v]) => v).map(([k]) => k);
  log(`Providers configurados: ${providers.join(', ')}`);

  // Lista grupos a processar (ativos + interrompidos/sem status)
  let grupos = db.prepare(`
    SELECT a.* FROM analise_ia_agendamento a
      JOIN grupos_palavras g ON g.id=a.grupoId AND g.ativo=1
     WHERE a.ativo=1
       AND (a.ultimo_scan_status IS NULL
            OR a.ultimo_scan_status IN ('interrompido','erro','parcial'))
     ORDER BY a.ultimo_scan_total ASC
  `).all();

  if (filterGrupos.length > 0) {
    grupos = grupos.filter(g => filterGrupos.includes(g.grupoId));
  }

  log(`Grupos a processar: ${grupos.map(g => g.grupoId).join(', ')}`);

  for (const config of grupos) {
    const grupo = carregarGrupoCompleto(db, config.grupoId);
    if (!grupo) {
      log(`  grupo ${config.grupoId}: inativo, pulando`);
      continue;
    }
    log(`━━━ Grupo ${grupo.id} "${grupo.nome}" — iniciando ━━━`);
    try {
      const r = await executarScanGrupo(db, grupo, config, keys);
      log(`  resultado: ${r.analisadas}/${r.total} analisadas, ${r.erros} erros, status=${r.status}`);
    } catch (e) {
      log(`  ERRO no scan grupo ${grupo.id}: ${e.message}`);
    }
  }

  log('━━━ FIM ━━━');
  db.close();
}

process.on('SIGINT', () => { log('SIGINT recebido — saindo'); db.close(); process.exit(130); });
process.on('SIGTERM', () => { log('SIGTERM recebido — saindo'); db.close(); process.exit(143); });

main().catch(e => {
  log('CRASH:', e.stack || e.message);
  process.exit(1);
});
