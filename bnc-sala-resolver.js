// bnc-sala-resolver.js
//
// Resolvedor automático de salas BNC (bnccompras.com) — cadastra a sala de
// disputa SOZINHO, sem link colado, para todo processo onde o tenant JÁ ENVIOU
// proposta. O token [gkz] do processo já está em bnc_propostas.processId
// (extraído do hidden na hora do envio), então basta montar a URL /BatchList e
// chamar bncSalas.cadastrarSala — que faz o GET autenticado reusando a sessão
// server-side viva (bnc-session-service.js) e descobre uid/lotes/batchTokenGkz.
//
// Substitui o antigo auto-cadastro que dependia do Electron navegar até a
// página /BatchList (POST /api/electron/bnc/sala-auto-cadastrar) — hoje morto,
// pois não há mais Electron: tudo server-side.
//
// Chamado por:
//   - job periódico no scheduler.js (master), por-tenant — agendarResolverSalas()
//   - rota POST /api/bnc/salas/resolver (trigger manual / validação)
//
// Idempotente: pula processos que já têm sala ATIVA (não martela o BNC).

'use strict';

const bncSalas = require('./bnc-salas');
const bncScheduler = require('./bnc-dispute-scheduler');

const BNC_BATCHLIST = 'https://bnccompras.com/BatchList';

// Monta a URL da sala a partir do token [gkz] do processo. Usa URL/searchParams
// p/ encodar corretamente os chars especiais do token (base64: + / =).
function _montarUrlSala(processId) {
  const u = new URL(BNC_BATCHLIST);
  u.searchParams.set('param1', processId);
  u.searchParams.set('param2', '7');
  return u.toString();
}

/**
 * Cadastra automaticamente as salas dos processos BNC com proposta enviada.
 * @param {import('better-sqlite3').Database} db  handle sqlite do tenant
 * @param {{ tenantSlug?: string, refresh?: boolean }} [opts]
 * @returns {Promise<{ cadastradas: Array, jaAtivas: number, erros: Array, pendentes: number }>}
 */
async function resolverSalasTenant(db, opts = {}) {
  const { tenantSlug = null, refresh = true } = opts;

  // Tenant pode não ter o schema BNC (bootstrap antigo) — no-op silencioso.
  const temTabela = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='bnc_propostas'"
  ).get();
  if (!temTabela) return { cadastradas: [], jaAtivas: 0, erros: [], pendentes: 0 };

  // Processos com proposta REALMENTE enviada (POST OK, não prévia/dryRun).
  const propostas = db.prepare(
    `SELECT processId, compraId FROM bnc_propostas WHERE enviada = 1 AND processId IS NOT NULL`
  ).all();

  const cadastradas = [];
  const erros = [];
  let jaAtivas = 0;

  for (const p of propostas) {
    // Pula se já existe sala ATIVA pra esse processo (evita re-hit no BNC).
    const salaExistente = p.compraId ? bncSalas.getSala(db, p.compraId) : null;
    if (salaExistente && salaExistente.ativo) { jaAtivas++; continue; }

    try {
      const url = _montarUrlSala(p.processId);
      const r = await bncSalas.cadastrarSala(db, { url, notas: 'Auto-resolver (proposta enviada)' });
      cadastradas.push({ compraId: r.sala.compraId, salaId: r.sala.id, lotes: r.lotesTotal });
    } catch (e) {
      // Sessão morta, ou processo ainda não em disputa (sem uid/FastBid na
      // página), ou processo já encerrado/cancelado. Fica pro próximo ciclo.
      erros.push({ processId: p.processId, compraId: p.compraId, erro: e.message });
    }
  }

  // Sobe as engines das salas novas de uma vez.
  if (refresh && tenantSlug && cadastradas.length) {
    try { bncScheduler.refreshTenant(tenantSlug); } catch { /* swallow */ }
  }

  return { cadastradas, jaAtivas, erros, pendentes: propostas.length };
}

/**
 * Agenda o resolver no scheduler (master): 1ª rodada 2min após boot, depois
 * a cada 30min. Tenants sem BNC caem no no-op (sem tabela / sem propostas).
 * @param {import('better-sqlite3').Database} db
 * @param {{ slug?: string }} tenant
 */
function agendarResolverSalas(db, tenant) {
  const tenantSlug = tenant?.slug || null;
  const run = () => resolverSalasTenant(db, { tenantSlug })
    .then((r) => {
      if (r.cadastradas.length || r.erros.length) {
        console.log(`[BNC-resolver ${tenantSlug}] +${r.cadastradas.length} sala(s) ativada(s), ${r.jaAtivas} já ativas, ${r.erros.length} erro(s) de ${r.pendentes} proposta(s)`);
      }
    })
    .catch((e) => console.error(`[BNC-resolver ${tenantSlug}]`, e.message));
  setTimeout(run, 2 * 60 * 1000);
  setInterval(run, 30 * 60 * 1000);
}

module.exports = { resolverSalasTenant, agendarResolverSalas };
