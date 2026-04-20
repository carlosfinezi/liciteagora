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
 * (analise-ia, admin, extensoes, govbr, extensao-chrome, chat-monitoramento,
 * etc.) — a migração é 1:1, mesmos nomes de identificador.
 *
 * Os prepared statements ficam escondidos na closure da factory; não há
 * mais estado solto no topo do server.js.
 *
 * O motor PNCP em pncp-sync-scheduler.js tem cópia interna própria
 * (não compartilhada) — é um módulo com DB independente no processo
 * master, e a onda 5C optou por duplicar as funções triviais em vez
 * de adicionar acoplamento.
 */

function createConfigHelpers(db) {
  const getConfig = db.prepare('SELECT valor FROM config WHERE chave = ?');
  const setConfig = db.prepare(
    'INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)'
  );

  function getConfigValue(chave) {
    const row = getConfig.get(chave);
    return row ? row.valor : null;
  }

  function setConfigValue(chave, valor) {
    setConfig.run(chave, valor);
  }

  /**
   * Retorna { gemini, anthropic } se pelo menos uma das chaves
   * estiver configurada; senão null. Usado pelas rotas HTTP de
   * análise IA (que rodam no worker). O master tem cópia interna.
   */
  function getIAKeys() {
    const gemini = getConfigValue('gemini_api_key');
    const anthropic = getConfigValue('anthropic_api_key');
    if (!gemini && !anthropic) return null;
    return { gemini: gemini || null, anthropic: anthropic || null };
  }

  return { getConfigValue, setConfigValue, getIAKeys };
}

module.exports = { createConfigHelpers };
