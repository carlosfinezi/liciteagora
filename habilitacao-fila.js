/**
 * habilitacao-fila.js — fila global de emissão de certidões.
 *
 * Cada emissão abre um Chrome pesado (e alguns compartilham o SOCKS residencial
 * e o perfil .crf-profile). Em vez de recusar quando já há uma em andamento
 * (guard antigo `emEmissao`), enfileiramos: os pedidos concorrentes esperam a
 * vez e rodam em ordem, com concorrência limitada (default 1 = um por vez no
 * processo).
 *
 * Vive no processo do web service (consulta-licitacoes). A renovação diária
 * roda em processo separado e já é sequencial, então não depende desta fila.
 *
 * Env: HABILITACAO_CONCORRENCIA (default 1)
 */

const CONCORRENCIA = Math.max(1, parseInt(process.env.HABILITACAO_CONCORRENCIA || '1', 10));

let ativos = 0;
const espera = []; // { resolve, label }

function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}] [habilitacao-fila]`, ...a); }

/**
 * Enfileira uma função assíncrona. Resolve/rejeita com o resultado dela.
 * @param {() => Promise<any>} fn
 * @param {{label?: string}} [opts]
 */
async function enfileirar(fn, opts = {}) {
  const label = opts.label || '';
  if (ativos >= CONCORRENCIA) {
    log(`aguardando vaga (${espera.length + 1} na fila)${label ? ' — ' + label : ''}`);
    await new Promise((resolve) => espera.push(resolve));
  }
  ativos++;
  try {
    return await fn();
  } finally {
    ativos--;
    const next = espera.shift();
    if (next) next();
  }
}

module.exports = { enfileirar, tamanho: () => espera.length, ativos: () => ativos, concorrencia: CONCORRENCIA };
