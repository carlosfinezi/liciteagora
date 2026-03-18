// lance-processor.js — Processamento de filas: lances, queries e tarefas
'use strict';

const cnet = require('./comprasnet-api');
const { serverRequest, serverLog } = require('./server-sync');

// ─── State ──────────────────────────────────────────────────────────────────

let pollTimer = null;
let pollInterval = 5000; // default, server pode ajustar
let processing = false;
let _getBearer = null;
let _getBearerTimestamp = null;
let _log = console.log;
let _onNeedKeepalive = null;

const TOKEN_MAX_AGE_MS = 540000;

// Stats
let lancesProcessados = 0;
let lancesErros = 0;
let queriesProcessadas = 0;
let tarefasProcessadas = 0;

// ─── Init ───────────────────────────────────────────────────────────────────

function init(opts) {
  _getBearer = opts.getBearer;
  _getBearerTimestamp = opts.getBearerTimestamp;
  _log = opts.log || console.log;
  _onNeedKeepalive = opts.onNeedKeepalive || (() => {});
}

function start() {
  _log('[Lances] Polling de filas iniciado (5s)');
  pollTimer = setInterval(poll, pollInterval);
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function updateInterval(ms) {
  if (ms === pollInterval) return;
  pollInterval = ms;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, pollInterval);
  }
  _log(`[Lances] Poll interval → ${ms}ms`);
}

// ─── Poll principal ─────────────────────────────────────────────────────────

async function poll() {
  if (processing) return;

  const bearer = _getBearer();
  if (!bearer) return;

  // Token fresco?
  const ts = _getBearerTimestamp();
  if (ts && (Date.now() - ts) > TOKEN_MAX_AGE_MS) {
    _onNeedKeepalive();
    return;
  }

  processing = true;
  try {
    await processarFilaLances();
    await processarFilaQueries();
    await processarFilaTarefas();
  } catch (e) {
    _log(`[Lances] Erro poll: ${e.message}`);
  } finally {
    processing = false;
  }
}

// ─── Fila de Lances ─────────────────────────────────────────────────────────

async function processarFilaLances() {
  const r = await serverRequest('GET', '/api/sniper/fila-lances');
  if (!r.ok) return;

  const { lances, pollIntervalMs, proximaBlitz } = r.data || {};

  // Ajustar poll interval
  if (pollIntervalMs) updateInterval(pollIntervalMs);
  if (proximaBlitz?.diffMs && proximaBlitz.diffMs < 30000) {
    updateInterval(1000);
  }

  if (!Array.isArray(lances) || lances.length === 0) return;

  _log(`[Lances] ${lances.length} lance(s) na fila`);

  const resultados = [];
  const itensAbortados = new Set(); // item que falhou → skip restantes

  for (const lance of lances) {
    const { id, compraId, itemNumero, valor, faseItem, batchIndex, batchTotal } = lance;
    const itemKey = `${compraId}-${itemNumero}`;

    // Skip se item já abortou
    if (itensAbortados.has(itemKey)) {
      resultados.push({
        id, compraId, itemNumero, valor,
        status: 'skipped',
        sucesso: false,
        resposta: 'Item abortado por erro anterior',
        tempoMs: 0,
      });
      continue;
    }

    const inicio = Date.now();
    try {
      _log(`[Lance] ${compraId} item ${itemNumero} = R$ ${valor} (${faseItem || 'LA'})${batchIndex ? ` [${batchIndex}/${batchTotal}]` : ''}`);

      const resp = await cnet.enviarLance(compraId, itemNumero, valor, faseItem || 'LA');
      const tempoMs = Date.now() - inicio;

      if (resp.ok) {
        lancesProcessados++;
        _log(`[Lance] OK em ${tempoMs}ms`);

        resultados.push({
          id, compraId, itemNumero, valor,
          status: 'ok',
          sucesso: true,
          resposta: resp.data,
          tempoMs,
        });

        // Merge dados de grupo se presentes
        if (resp.data?.itens) {
          await serverRequest('POST', '/api/sync/disputas', {
            merge: true,
            disputas: [{ compraId, itens: resp.data.itens }],
          });
        }

        // Contínuo: se ganhando, parar batch para essa compra
        if (resp.data?.melhorLance?.cpfCnpj && resp.data?.valorInformado) {
          // Simplificação: se nosso valor <= melhor lance, estamos ganhando
          // (a lógica completa dependeria de saber nosso CNPJ)
        }

      } else {
        lancesErros++;
        _log(`[Lance] ERRO ${resp.status} em ${tempoMs}ms: ${JSON.stringify(resp.data || resp.error).substring(0, 200)}`);

        resultados.push({
          id, compraId, itemNumero, valor,
          status: `erro-${resp.status}`,
          sucesso: false,
          resposta: resp.data || resp.error,
          tempoMs,
        });

        // Abort item em falhas non-retryable
        if (resp.status !== 429) {
          itensAbortados.add(itemKey);
        }

        // 401 → parar tudo, keepalive
        if (resp.status === 401) {
          _log('[Lance] 401 — parando batch, forçando keepalive');
          _onNeedKeepalive();
          break;
        }
      }

    } catch (e) {
      const tempoMs = Date.now() - inicio;
      lancesErros++;
      resultados.push({
        id, compraId, itemNumero, valor,
        status: 'exception',
        sucesso: false,
        resposta: e.message,
        tempoMs,
      });
      itensAbortados.add(itemKey);
    }
  }

  // Enviar resultados em batch
  if (resultados.length > 0) {
    const rr = await serverRequest('POST', '/api/sniper/resultado-lances-batch', { resultados });
    if (!rr.ok) {
      // Fallback: enviar um a um
      for (const res of resultados) {
        await serverRequest('POST', '/api/sniper/resultado-lance', res);
      }
    }
  }

  // Re-poll imediato se houve lances
  if (lances.length > 0) {
    setTimeout(() => poll(), 150);
  }
}

// ─── Fila de Queries ────────────────────────────────────────────────────────

async function processarFilaQueries() {
  const r = await serverRequest('GET', '/api/sniper/fila-queries');
  if (!r.ok || !Array.isArray(r.data?.queries) || r.data.queries.length === 0) return;

  _log(`[Queries] ${r.data.queries.length} query(s) na fila`);

  for (const query of r.data.queries) {
    const { compraId } = query;
    try {
      const { itens, fase, stub } = await cnet.fetchItensCompra(compraId);
      await serverRequest('POST', '/api/sync/disputas', {
        merge: true,
        disputas: [{
          compraId,
          itens: itens.map(i => ({
            numero: i.numero,
            tipo: i.tipo,
            descricao: i.descricao || '',
            fase: i.fase || fase,
            situacao: i.situacao || '',
            melhorValor: i.melhorLance?.valor ?? i.melhorValor ?? null,
            nossoValor: i.valorInformado ?? i.nossoValor ?? null,
            valorEstimado: i.valorEstimado ?? null,
            podeEnviar: i.podeEnviar ?? false,
            estaPerdendo: i.estaPerdendo ?? false,
            emEncAleatoria: i.emEncAleatoria ?? false,
            nosDoisMinFinais: i.nosDoisMinFinais ?? false,
          })),
          stub,
        }],
      });
      queriesProcessadas++;
      _log(`[Query] ${compraId}: ${itens.length} itens`);
    } catch (e) {
      _log(`[Query] Erro ${compraId}: ${e.message}`);
    }
  }
}

// ─── Fila de Tarefas ────────────────────────────────────────────────────────

async function processarFilaTarefas() {
  const r = await serverRequest('GET', '/api/tarefas/pendentes');
  if (!r.ok || !Array.isArray(r.data?.tarefas) || r.data.tarefas.length === 0) return;

  _log(`[Tarefas] ${r.data.tarefas.length} tarefa(s) pendente(s)`);

  for (const tarefa of r.data.tarefas) {
    const { id, tipo, dados } = tarefa;
    const inicio = Date.now();

    try {
      let resultado;

      switch (tipo) {
        case 'testar-conexao': {
          const ka = await cnet.datahorabrasilia();
          resultado = { status: ka.status, ok: ka.ok, data: ka.data };
          break;
        }

        case 'testar-participacao': {
          const p = await cnet.fetchParticipacao(dados.compraId);
          resultado = { status: p.status, ok: p.ok, data: p.data };
          break;
        }

        case 'enviar-proposta': {
          const { compraId, itens } = dados;

          // 1. Enviar declaração
          const decl = await cnet.enviarDeclaracao(compraId);
          if (!decl.ok) {
            resultado = { ok: false, error: `Declaração falhou: ${decl.status}`, data: decl.data };
            break;
          }

          // 2. Enviar propostas por item
          const resultadosItens = [];
          for (const item of itens) {
            const prop = await cnet.enviarProposta(compraId, item.numero, item.valorUnitario, item.quantidade);
            resultadosItens.push({
              numero: item.numero,
              ok: prop.ok,
              status: prop.status,
              data: prop.data,
            });
          }
          resultado = { ok: true, itens: resultadosItens };
          break;
        }

        default:
          resultado = { ok: false, error: `Tipo desconhecido: ${tipo}` };
      }

      const tempoMs = Date.now() - inicio;
      await serverRequest('POST', '/api/tarefas/resultado', {
        id,
        sucesso: resultado.ok !== false,
        resultado,
        tempoMs,
      });
      tarefasProcessadas++;
      _log(`[Tarefa] ${tipo} #${id}: ${resultado.ok !== false ? 'OK' : 'ERRO'} (${tempoMs}ms)`);

    } catch (e) {
      const tempoMs = Date.now() - inicio;
      await serverRequest('POST', '/api/tarefas/resultado', {
        id,
        sucesso: false,
        erro: e.message,
        tempoMs,
      });
      _log(`[Tarefa] ${tipo} #${id}: EXCEPTION ${e.message}`);
    }
  }
}

// ─── Stats ──────────────────────────────────────────────────────────────────

function stats() {
  return {
    lancesProcessados,
    lancesErros,
    queriesProcessadas,
    tarefasProcessadas,
    pollInterval,
    processing,
  };
}

module.exports = {
  init,
  start,
  stop,
  poll,
  stats,
};
