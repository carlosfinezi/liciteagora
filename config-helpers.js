/**
 * config-helpers.js
 * ------------------------------------------------------------------
 * Extraído do server.js (NFSE-M06 onda 6.32).
 *
 * Leitura/escrita da tabela `config` (chave-valor) usada para:
 *   - credenciais externas (Gemini, Anthropic, Comprasnet, etc.)
 *   - flags operacionais (lastSyncDate, server-url, etc.)
 *   - configurações de UI e robôs
 *
 * Factory createConfigHelpers(db) retorna o trio
 *   { getConfigValue, setConfigValue, getIAKeys }
 * que é destructurado em server.js e propagado para ~8 registrarRotasX
 * (analise-ia, admin, extensoes, govbr, chat-monitoramento, etc.) —
 * a migração é 1:1, mesmos nomes de identificador.
 *
 * Os prepared statements ficam escondidos na closure da factory; não há
 * mais estado solto no topo do server.js.
 *
 * O motor PNCP em pncp-sync-scheduler.js tem cópia interna própria
 * (não compartilhada) — é um módulo com DB independente no processo
 * master, e a onda 5C optou por duplicar as funções triviais em vez
 * de adicionar acoplamento.
 */

const { createStmtCache } = require('./stmt-cache');

// Multi-tenant (2026-04-22): `db` pode ser um Proxy que resolve para
// bancos diferentes por request. Em vez de preparar statements na
// factory e prendê-los a UM db, usamos stmt-cache para preparar
// lazily por db real. O comportamento em single-tenant é idêntico.
function createConfigHelpers(db) {
  const stmt = createStmtCache();
  const SQL_GET = 'SELECT valor FROM config WHERE chave = ?';
  const SQL_SET = 'INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)';

  function getConfigValue(chave) {
    const row = stmt(db, SQL_GET).get(chave);
    return row ? row.valor : null;
  }

  function setConfigValue(chave, valor) {
    stmt(db, SQL_SET).run(chave, valor);
  }

  /**
   * Retorna { gemini, anthropic } se pelo menos uma das chaves
   * estiver configurada; senão null. Usado pelas rotas HTTP de
   * análise IA (que rodam no worker). O master tem cópia interna.
   */
  function getIAKeys() {
    const cerebras = getConfigValue('cerebras_api_key');
    const gemini = getConfigValue('gemini_api_key');
    const deepseek = getConfigValue('deepseek_api_key');
    const groq = getConfigValue('groq_api_key');
    const anthropic = getConfigValue('anthropic_api_key');
    if (!cerebras && !gemini && !deepseek && !groq && !anthropic) return null;
    return {
      cerebras: cerebras || null,
      gemini: gemini || null,
      deepseek: deepseek || null,
      groq: groq || null,
      anthropic: anthropic || null,
    };
  }

  return { getConfigValue, setConfigValue, getIAKeys };
}

module.exports = { createConfigHelpers };
