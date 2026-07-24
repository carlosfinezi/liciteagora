/**
 * sc-sniper.js — Motor de auto-lance para o portal SC.
 *
 * MVP (Phase 3 entrega 1):
 *   - Modo único: "sniper" (dispara um lance só, T-antecedenciaMs antes do fim).
 *   - Valor fixo configurado pelo usuário (não calcula a partir do mercado).
 *   - Idempotência: após primeiro disparo, sc_sniper_config.disparadoEm é gravado
 *     e o item é ignorado em ticks subsequentes.
 *   - Histórico completo em sc_sniper_historico (status, httpStatus, drift de tempo).
 *
 * Próximas iterações (não implementadas):
 *   - Modo "continuo" (cobre cada vez que perde a posição durante a disputa).
 *   - Cálculo dinâmico do valor (decremento sobre melhorLance).
 *   - Anti-flap (limite de N lances/min por usuário).
 *   - Retry em caso de erro de rede dentro da janela.
 */

const JANELA_AGENDAMENTO_MS = 5_000; // só agenda fires que cairão nos próximos 5s
const TOLERANCIA_PASSADO_MS = 1_500; // se já passou >1.5s do alvo, marca como missed e pula

// Timers in-flight (cotacaoId+loteOuItemId -> Timeout). Evita agendar 2x o mesmo fire
// quando o tick de avaliação do scheduler vê a config várias vezes antes do disparo.
const _pendingFires = new Map();

function _key(cotacaoId, loteOuItemId) {
  return cotacaoId + ':' + loteOuItemId;
}

/**
 * Avalia todas as configs ativas do tenant atual e agenda fires que cairão na
 * próxima janela. Idempotente — se já há setTimeout in-flight, não duplica.
 */
function avaliarSniper(client, db) {
  let configs;
  try {
    configs = db.prepare(`
      SELECT c.cotacaoId, c.loteOuItemId, c.valor, c.antecedenciaMs, c.disparadoEm,
             p.dataFimLances, p.cotacaoPorItem
      FROM sc_sniper_config c
      JOIN sc_participacoes p ON p.cotacaoId = c.cotacaoId
      WHERE c.ativo = 1 AND c.disparadoEm IS NULL AND p.ativo = 1
    `).all();
  } catch (_) {
    return;
  }

  const now = Date.now();
  for (const cfg of configs) {
    if (!cfg.dataFimLances) continue;
    // dataFimLances vem sem timezone; o servidor SC opera em BRT (UTC-3).
    const fimMs = new Date(cfg.dataFimLances + '-03:00').getTime();
    if (!Number.isFinite(fimMs)) continue;

    const fireAt = fimMs - (cfg.antecedenciaMs || 1500);
    const msAteFire = fireAt - now;

    // Já passou tempo demais — desiste e marca como missed.
    if (msAteFire < -TOLERANCIA_PASSADO_MS) {
      try {
        const segPassados = Math.round(-msAteFire / 1000);
        db.prepare(`
          UPDATE sc_sniper_config
          SET disparadoEm = CURRENT_TIMESTAMP,
              observacao = COALESCE(observacao || ' ', '') || '[missed: alvo ' || ? || 's no passado]',
              atualizadoEm = CURRENT_TIMESTAMP
          WHERE cotacaoId = ? AND loteOuItemId = ?
        `).run(segPassados, cfg.cotacaoId, cfg.loteOuItemId);
      } catch (e) {
        console.error(`[SC-sniper] missed-mark falhou: ${e.message}`);
      }
      continue;
    }

    // Muito longe — próximo tick reavaliará.
    if (msAteFire > JANELA_AGENDAMENTO_MS) continue;

    const k = _key(cfg.cotacaoId, cfg.loteOuItemId);
    if (_pendingFires.has(k)) continue; // já agendado neste tick

    const delay = Math.max(0, msAteFire);
    const timer = setTimeout(() => {
      _pendingFires.delete(k);
      _executarFire(client, db, cfg, fireAt).catch((e) => {
        console.error(`[SC-sniper] fire error ${k}: ${e.message}`);
      });
    }, delay);
    if (timer.unref) timer.unref();
    _pendingFires.set(k, timer);
  }
}

async function _executarFire(client, db, cfg, fireAtMs) {
  // Re-check no momento do disparo (config pode ter sido desativada nesta janela).
  const reCfg = db.prepare(`
    SELECT disparadoEm, ativo FROM sc_sniper_config
    WHERE cotacaoId = ? AND loteOuItemId = ?
  `).get(cfg.cotacaoId, cfg.loteOuItemId);
  if (!reCfg || reCfg.disparadoEm || !reCfg.ativo) return;

  // Marca como disparado ANTES do POST. Se o POST falhar, a marca permanece e
  // o histórico registra o erro — assim NUNCA disparamos 2x para a mesma config.
  // Para retry o usuário precisa zerar disparadoEm via rota DELETE/PUT.
  db.prepare(`
    UPDATE sc_sniper_config SET disparadoEm = CURRENT_TIMESTAMP WHERE cotacaoId = ? AND loteOuItemId = ?
  `).run(cfg.cotacaoId, cfg.loteOuItemId);

  const path = cfg.cotacaoPorItem
    ? `/api/dispensas-licitacao/${cfg.cotacaoId}/itens/${cfg.loteOuItemId}/lances`
    : `/api/dispensas-licitacao/${cfg.cotacaoId}/lotes/${cfg.loteOuItemId}/lances`;

  const t0 = Date.now();
  let resp;
  let networkError = null;
  try {
    resp = await client.apiPost(path, { valor: cfg.valor });
  } catch (e) {
    networkError = e.message || String(e);
  }
  const dt = Date.now() - t0;

  let status = 'erro';
  let httpStatus = null;
  let respostaTxt = null;
  if (networkError) {
    status = 'rede';
    respostaTxt = networkError;
  } else if (resp) {
    httpStatus = resp.status;
    respostaTxt = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || '');
    status = resp.status >= 200 && resp.status < 300 ? 'sucesso' : 'erro';
  }

  try {
    db.prepare(`
      INSERT INTO sc_sniper_historico (
        cotacaoId, loteOuItemId, valor, fonte, status, httpStatus, resposta, tempoMs, agendadoPara
      ) VALUES (?, ?, ?, 'sniper-auto', ?, ?, ?, ?, ?)
    `).run(
      cfg.cotacaoId, cfg.loteOuItemId, cfg.valor, status, httpStatus,
      respostaTxt && respostaTxt.length > 2000 ? respostaTxt.substring(0, 2000) : respostaTxt,
      dt, new Date(fireAtMs).toISOString()
    );
  } catch (e) {
    console.error(`[SC-sniper] histórico falhou: ${e.message}`);
  }

  console.log(`[SC-sniper] cot=${cfg.cotacaoId} ${cfg.cotacaoPorItem ? 'item' : 'lote'}=${cfg.loteOuItemId} valor=${cfg.valor} → ${status} http=${httpStatus} dt=${dt}ms`);
}

/**
 * Disparo manual (rota /api/sc/sniper/disparar). Não respeita disparadoEm.
 * Sempre grava em histórico. Pode ser usado para overrides emergenciais.
 */
async function dispararManual(client, db, cotacaoId, loteOuItemId, valor) {
  const part = db.prepare('SELECT cotacaoPorItem FROM sc_participacoes WHERE cotacaoId = ?').get(cotacaoId);
  const cotacaoPorItem = part ? !!part.cotacaoPorItem : false;
  const path = cotacaoPorItem
    ? `/api/dispensas-licitacao/${cotacaoId}/itens/${loteOuItemId}/lances`
    : `/api/dispensas-licitacao/${cotacaoId}/lotes/${loteOuItemId}/lances`;

  const t0 = Date.now();
  let resp;
  let networkError = null;
  try {
    resp = await client.apiPost(path, { valor });
  } catch (e) {
    networkError = e.message || String(e);
  }
  const dt = Date.now() - t0;

  let status = 'erro';
  let httpStatus = null;
  let respostaTxt = null;
  if (networkError) { status = 'rede'; respostaTxt = networkError; }
  else if (resp) {
    httpStatus = resp.status;
    respostaTxt = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || '');
    status = resp.status >= 200 && resp.status < 300 ? 'sucesso' : 'erro';
  }

  db.prepare(`
    INSERT INTO sc_sniper_historico (
      cotacaoId, loteOuItemId, valor, fonte, status, httpStatus, resposta, tempoMs, agendadoPara
    ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, NULL)
  `).run(cotacaoId, loteOuItemId, valor, status,
         httpStatus, respostaTxt && respostaTxt.length > 2000 ? respostaTxt.substring(0, 2000) : respostaTxt, dt);

  return { status, httpStatus, tempoMs: dt, resposta: respostaTxt };
}

module.exports = { avaliarSniper, dispararManual };
