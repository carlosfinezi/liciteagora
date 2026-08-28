/**
 * prod-util.js — utilidades compartilhadas do módulo Pré-moldados.
 *
 * Datas, leitura de config e numeração. Fica separado porque peca.js, op.js,
 * tecnologico.js e produtividade.js precisam das mesmas normalizações, e um
 * `require` cruzado entre eles criaria ciclo.
 */

/**
 * Instante no formato do CURRENT_TIMESTAMP do SQLite: 'YYYY-MM-DD HH:MM:SS'.
 *
 * Toda comparação de janela neste módulo é lexicográfica (agenda de forma,
 * cura, medição), então o formato TEM de ser uniforme. Data sem hora entra
 * como 00:00:00.
 */
function normalizarInstante(valor) {
  if (valor == null || valor === '') return null;
  const s = String(valor).trim();
  // 'YYYY-MM-DD' → meia-noite
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 00:00:00`;
  // 'YYYY-MM-DDTHH:MM' (input datetime-local) e variações com segundos
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/);
  if (m) return `${m[1]} ${m[2]}${m[3] || ':00'}`;
  return null;
}

/** Data pura 'YYYY-MM-DD'. */
function normalizarData(valor) {
  const inst = normalizarInstante(valor);
  return inst ? inst.slice(0, 10) : null;
}

/** Agora, no mesmo formato. Usa horário local do servidor (America/Sao_Paulo). */
function agora() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Soma horas a um instante e devolve no mesmo formato. */
function somarHoras(instante, horas) {
  const base = normalizarInstante(instante);
  if (!base || !Number.isFinite(Number(horas))) return null;
  const [d, t] = base.split(' ');
  const [Y, M, D] = d.split('-').map(Number);
  const [h, mi, s] = t.split(':').map(Number);
  const dt = new Date(Y, M - 1, D, h, mi, s);
  dt.setTime(dt.getTime() + Number(horas) * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} `
       + `${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

/** Diferença em horas entre dois instantes. Negativa quando fim < início. */
function horasEntre(inicio, fim) {
  const a = normalizarInstante(inicio);
  const b = normalizarInstante(fim);
  if (!a || !b) return null;
  const toDate = s => {
    const [d, t] = s.split(' ');
    const [Y, M, D] = d.split('-').map(Number);
    const [h, mi, sec] = t.split(':').map(Number);
    return new Date(Y, M - 1, D, h, mi, sec);
  };
  return (toDate(b).getTime() - toDate(a).getTime()) / 3600000;
}

/** Número inteiro >= 0, ou null. Rejeita NaN e negativo em vez de virar 0. */
function num(valor, { min = null, max = null } = {}) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  if (min != null && n < min) return null;
  if (max != null && n > max) return null;
  return n;
}

/**
 * Numeração sequencial por prefixo: PMO-000123.
 *
 * Lê o maior número já usado em vez de contar linhas — contar quebra quando
 * há cancelamento, e dois documentos ganhariam o mesmo número.
 *
 * `coluna` existe porque nem toda tabela do módulo chama isso de `numero`:
 * `prod_lotes` usa `codigo`. Assumir o nome dava "no such column".
 */
function gerarNumero(db, tabela, prefixo, coluna = 'numero') {
  const like = `${prefixo}-%`;
  const row = db.prepare(
    `SELECT ${coluna} AS valor FROM ${tabela} WHERE ${coluna} LIKE ? `
    + `ORDER BY LENGTH(${coluna}) DESC, ${coluna} DESC LIMIT 1`
  ).get(like);
  let proximo = 1;
  if (row && row.valor) {
    const m = String(row.valor).match(/(\d+)$/);
    if (m) proximo = parseInt(m[1], 10) + 1;
  }
  return `${prefixo}-${String(proximo).padStart(6, '0')}`;
}

/** Grava uma chave de config. */
function gravarConfig(db, chave, valor) {
  db.prepare(`
    INSERT INTO config (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
  `).run(chave, String(valor));
}

module.exports = {
  normalizarInstante, normalizarData, agora, somarHoras, horasEntre,
  num, gerarNumero, gravarConfig,
};
