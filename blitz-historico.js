/**
 * blitz-historico.js — Persistência permanente do ciclo de vida das blitzes.
 *
 * A tabela `blitz_agendadas` (sniper-lance-routes.js) é só queue ativa —
 * linhas são deletadas quando a blitz dispara ou é cancelada. Este módulo
 * mantém `blitz_historico` paralelo com o registro completo, para auditoria
 * e exibição de histórico no UI.
 *
 * Ciclo:
 *  1. registrarAgendada()    — quando blitz é criada (INSERT status='agendada')
 *  2. finalizarStatus()      — quando blitz dispara/cancela/expira
 *  3. atualizarLances()      — após contagem real dos lances enviados
 *
 * Todas as funções são best-effort: erros não propagam (apenas log), porque
 * histórico de auditoria não deve quebrar o fluxo principal de lance.
 */

/**
 * Registra uma blitz recém-agendada.
 * @returns {number|null} id da linha em blitz_historico, ou null em erro.
 */
function registrarAgendada(db, row) {
  try {
    const r = db.prepare(`
      INSERT INTO blitz_historico
        (blitzKey, compraId, itemNumero, horarioAlvo, alvoMs, maxLances, modoBlitz, status, agendadoEm)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'agendada', ?)
    `).run(
      row.blitzKey, row.compraId, row.itemNumero,
      row.horario || row.horarioAlvo || '', row.alvoMs,
      row.maxLances || 50, row.modoBlitz || 'cobrir',
      row.agendadoEm || new Date().toISOString()
    );
    return Number(r.lastInsertRowid);
  } catch (e) {
    console.warn('[BLITZ-HIST] registrarAgendada falhou:', e.message);
    return null;
  }
}

/**
 * Marca a blitz com status final. Procura o registro 'agendada' mais recente
 * pelo blitzKey e atualiza. Se não encontrar (raro — blitz que disparou sem
 * ter sido registrada como agendada), cria uma linha sintética.
 *
 * @param {string} status - 'executada' | 'cancelada' | 'expirada'
 * @param {object} opts   - { lancesEnviados, observacao, compraId, itemNumero,
 *                            horarioAlvo, alvoMs }
 *                          Os 4 últimos só são usados se precisar criar registro sintético.
 * @returns {number|null} id da linha atualizada/criada, ou null em erro.
 */
function finalizarStatus(db, blitzKey, status, opts = {}) {
  try {
    const existente = db.prepare(`
      SELECT id FROM blitz_historico
       WHERE blitzKey = ? AND status = 'agendada'
       ORDER BY id DESC LIMIT 1
    `).get(blitzKey);

    const ts = opts.timestamp || new Date().toISOString();
    const col = status === 'cancelada' ? 'canceladoEm' : 'executadoEm';

    if (existente) {
      db.prepare(`
        UPDATE blitz_historico
           SET status = ?, ${col} = ?,
               lancesEnviados = COALESCE(?, lancesEnviados),
               observacao = COALESCE(?, observacao)
         WHERE id = ?
      `).run(status, ts, opts.lancesEnviados ?? null, opts.observacao ?? null, existente.id);
      return existente.id;
    }

    // Sintético — blitz sem registro de agendamento (não deveria acontecer
    // no fluxo normal, mas evita perda de auditoria).
    const r = db.prepare(`
      INSERT INTO blitz_historico
        (blitzKey, compraId, itemNumero, horarioAlvo, alvoMs, status, ${col}, lancesEnviados, observacao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      blitzKey, opts.compraId || '?', opts.itemNumero || 0,
      opts.horarioAlvo || '', opts.alvoMs || 0,
      status, ts, opts.lancesEnviados || 0,
      opts.observacao || '[sem registro de agendamento prévio]'
    );
    return Number(r.lastInsertRowid);
  } catch (e) {
    console.warn(`[BLITZ-HIST] finalizarStatus(${status}) falhou:`, e.message);
    return null;
  }
}

/**
 * Atualiza apenas a contagem de lances enviados de um registro existente.
 * Usado quando a contagem só é conhecida APÓS o loop de envio (e finalizarStatus
 * já foi chamado para evitar gap de timing).
 */
function atualizarLances(db, historicoId, lancesEnviados, observacao) {
  if (!historicoId) return;
  try {
    db.prepare(`
      UPDATE blitz_historico
         SET lancesEnviados = ?,
             observacao = COALESCE(?, observacao)
       WHERE id = ?
    `).run(lancesEnviados, observacao ?? null, historicoId);
  } catch (e) {
    console.warn('[BLITZ-HIST] atualizarLances falhou:', e.message);
  }
}

module.exports = { registrarAgendada, finalizarStatus, atualizarLances };
