/**
 * locacao-teste-util.js — snapshot/restauração de config para os testes do
 * módulo Locação.
 *
 * Por que existe: os testes rodam contra o banco REAL do tenant `labfiscal` e
 * mexem em `config`. Restaurar no fim do script não basta — quando o teste
 * estoura no meio, a limpeza nunca roda, e a execução seguinte lê o estado
 * sujo como se fosse o original, petrificando o resíduo. Foi exatamente o que
 * aconteceu: `locacao_prefixo_numero` ficou valendo 'TSTF6' em produção.
 *
 * A restauração aqui é registrada em `process.on('exit')`, então vale também
 * para exceção não tratada e para `process.exit()`.
 *
 * Uso:
 *   const { protegerConfig } = require('./locacao-teste-util');
 *   protegerConfig(db);   // no topo, antes de qualquer setCfg
 */

/**
 * Fotografa todas as chaves `locacao_*` e devolve o banco a esse exato estado
 * na saída do processo — inclusive apagando chaves que o teste tenha criado.
 */
function protegerConfig(db, prefixo = 'locacao_') {
  const snapshot = db.prepare('SELECT chave, valor FROM config WHERE chave LIKE ?')
    .all(prefixo + '%');
  const antes = new Map(snapshot.map(r => [r.chave, r.valor]));

  let restaurado = false;
  const restaurar = () => {
    if (restaurado) return;
    restaurado = true;
    try {
      const agora = db.prepare('SELECT chave FROM config WHERE chave LIKE ?').all(prefixo + '%');
      for (const { chave } of agora) {
        if (!antes.has(chave)) {
          db.prepare('DELETE FROM config WHERE chave = ?').run(chave);
        }
      }
      for (const [chave, valor] of antes) {
        db.prepare(`INSERT INTO config (chave, valor) VALUES (?, ?)
                    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(chave, valor);
      }
    } catch (err) {
      console.error('[teste] falha ao restaurar config:', err.message);
    }
  };

  process.on('exit', restaurar);
  // SIGINT não dispara 'exit' sozinho: sem isto, Ctrl+C deixa resíduo.
  process.on('SIGINT', () => { restaurar(); process.exit(130); });

  return { antes, restaurar };
}

/** Grava uma chave de config (helper comum aos testes). */
function setCfg(db, chave, valor) {
  db.prepare(`INSERT INTO config (chave, valor) VALUES (?, ?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(chave, String(valor));
}

module.exports = { protegerConfig, setCfg };
