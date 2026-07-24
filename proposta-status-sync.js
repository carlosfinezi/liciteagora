// proposta-status-sync.js — Fix B (2026-05-20)
//
// Sincroniza com o Comprasnet o status de propostas enviadas direto pelo
// portal (sem passar pelo LiciteAgora). Pra cada compraId candidato,
// chama GET /comprasnet-fase-externa/v1/compras/{compraId}/participacao.
// Se a resposta vier com `itensParticipacao` populado (proposta criada),
// faz UPSERT em participacoes_comprasnet com propostaEnviadaEm setado.
//
// Universo de compraIds candidatos por tenant:
//   1. participacoes_comprasnet ATIVAS sem propostaEnviadaEm + dataSessao
//      futura (ou nula)
//   2. interesse_compra_id com compraId resolvido (não NAO_COMPRASNET:*)
//      cujo dataEncerramentoProposta é futuro
//
// Throttle: ITEM_DELAY_MS entre chamadas, sem captcha (rota /participacao
// é apenas Bearer). Se o Bearer não está disponível ou expirou, pula
// silenciosamente — próxima passada tenta de novo.
//
// Uso: chamado por _iniciarAgendamentoTenant em sniper-lance-routes.js,
// 1ª passada 2 min após o tenant subir + a cada 24h.

'use strict';

// Fase 3g (2026-05-23): SELECT licitacoes vai pra PG quando flag ativa
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

const ITEM_DELAY_MS = 800;       // 800ms entre compraIds — gentil com o Comprasnet
const MAX_COMPRAIDS_POR_RODADA = 100;  // hard limit pra não travar a thread

function _selecionarCandidatos(db) {
  // Mescla: (a) participações ativas sem envio + (b) interesses com compraId resolvido,
  // filtrando duplicatas. Limita a 100 por rodada.
  // Inclui faseCompra=4 ainda não homologada na janela de 30 dias, pra dar
  // chance de detectar proposta enviada em compras que ficaram travadas
  // (heurística do /qtdes pode marcar 4 num intervalo de suspensão).
  const fromParticipacoes = db.prepare(`
    SELECT compraId FROM participacoes_comprasnet
    WHERE ativo = 1
      AND (propostaEnviadaEm IS NULL OR propostaEnviadaEm = '')
      AND (situacao IS NULL OR situacao NOT IN ('EN','FR','2','EX'))
      AND (
        faseCompra IS NULL
        OR faseCompra NOT IN ('4', '99')
        OR (faseCompra = '4' AND homologada = 0 AND dataAtualizacao > datetime('now', '-30 days'))
      )
    LIMIT ?
  `).all(MAX_COMPRAIDS_POR_RODADA);

  const restante = Math.max(0, MAX_COMPRAIDS_POR_RODADA - fromParticipacoes.length);
  let fromInteresse = [];
  if (restante > 0) {
    fromInteresse = db.prepare(`
      SELECT DISTINCT ic.compraId
      FROM interesse_compra_id ic
      LEFT JOIN participacoes_comprasnet pc ON pc.compraId = ic.compraId
      LEFT JOIN licitacoes l ON l.cnpj = ic.cnpj AND l.anoCompra = ic.ano AND l.sequencialCompra = ic.sequencial
      WHERE ic.compraId IS NOT NULL
        AND ic.compraId NOT LIKE 'NAO_COMPRASNET:%'
        AND (pc.id IS NULL OR pc.propostaEnviadaEm IS NULL OR pc.propostaEnviadaEm = '')
        AND (l.dataEncerramentoProposta IS NULL
             OR l.dataEncerramentoProposta = ''
             OR l.dataEncerramentoProposta > datetime('now', '-1 hour'))
      LIMIT ?
    `).all(restante);
  }

  const seen = new Set();
  const out = [];
  for (const r of [...fromParticipacoes, ...fromInteresse]) {
    if (r.compraId && !seen.has(r.compraId)) {
      seen.add(r.compraId);
      out.push(r.compraId);
    }
  }
  return out;
}

function _propostaJaEnviada(participacaoResp) {
  // Heurística do retorno do GET /participacao do Comprasnet:
  //   - itensParticipacao array com pelo menos 1 item com valor > 0 → proposta cadastrada
  //   - situacaoCompraFaseExterna 'PE' (Proposta Enviada) → confirma
  // Não basta a participação existir (só com declarações); precisa ter item com valor.
  if (!participacaoResp || typeof participacaoResp !== 'object') return false;
  const sit = participacaoResp.situacaoCompraFaseExterna || '';
  if (sit === 'PE') return true;
  const itens = participacaoResp.itensParticipacao;
  if (Array.isArray(itens) && itens.some(i => Number(i.valor) > 0)) return true;
  return false;
}

async function _upsertPropostaEnviada(db, compraId, situacaoComprasnet) {
  // Idem ao Fix A do enviar-api: tenta UPDATE primeiro, INSERT se não houver linha.
  const upd = db.prepare(`UPDATE participacoes_comprasnet
    SET situacao = COALESCE(?, situacao),
        propostaEnviadaEm = COALESCE(propostaEnviadaEm, CURRENT_TIMESTAMP),
        dataAtualizacao = CURRENT_TIMESTAMP
    WHERE compraId = ?`).run(situacaoComprasnet || null, compraId);
  if (upd.changes > 0) return { acao: 'update' };

  // Sem linha — busca cnpj/ano/sequencial pelo interesse_compra_id e enriquece via licitacoes
  const ic = db.prepare(`SELECT cnpj, ano, sequencial FROM interesse_compra_id WHERE compraId = ? LIMIT 1`).get(compraId);
  if (!ic) return { acao: 'skip', motivo: 'sem mapping cnpj/ano/sequencial' };

  let lic = null;
  try {
    if (USE_PG) {
      lic = await catalogPg.queryOne(
        `SELECT "numeroCompra" AS "numeroCompra", "modalidadeNome" AS "modalidadeNome",
                "razaoSocial" AS orgao, "objetoCompra" AS "objetoCompra",
                "linkSistemaOrigem" AS "linkSistemaOrigem",
                COALESCE("dataEncerramentoPortal", "dataEncerramentoProposta") AS "dataEncerramentoProposta",
                "codigoUnidade" AS "codigoUnidade"
           FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3 LIMIT 1`,
        [ic.cnpj, ic.ano, ic.sequencial]
      );
    } else {
      lic = db.prepare(`SELECT numeroCompra, modalidadeNome, razaoSocial AS orgao, objetoCompra,
                               linkSistemaOrigem, dataEncerramentoProposta, codigoUnidade
          FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ? LIMIT 1`)
        .get(ic.cnpj, ic.ano, ic.sequencial);
    }
  } catch (_) {}

  db.prepare(`INSERT INTO participacoes_comprasnet
    (compraId, cnpj, codigoUnidade, ano, sequencial, tipo, numero, orgao, objeto,
     etapa, situacao, urlCompra, dataSessao, propostaEnviadaEm, ativo, dataAtualizacao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`)
    .run(
      compraId, ic.cnpj, lic?.codigoUnidade || '',
      ic.ano, ic.sequencial,
      lic?.modalidadeNome || '', lic?.numeroCompra || '',
      lic?.orgao || '', lic?.objetoCompra || '',
      situacaoComprasnet || 'PE',
      lic?.linkSistemaOrigem || '',
      lic?.dataEncerramentoProposta || ''
    );

  // Também marca kanban_status como enviada (pra agenda.html refletir)
  try {
    db.prepare(`INSERT OR IGNORE INTO kanban_status (cnpj, ano, sequencial, status, dataAtualizacao)
                VALUES (?, ?, ?, 'enviada', CURRENT_TIMESTAMP)`)
      .run(ic.cnpj, ic.ano, ic.sequencial);
    db.prepare(`UPDATE kanban_status SET status = 'enviada',
                observacao = 'Detectado via sync de status (Comprasnet)',
                dataAtualizacao = CURRENT_TIMESTAMP
                WHERE cnpj = ? AND ano = ? AND sequencial = ?`)
      .run(ic.cnpj, ic.ano, ic.sequencial);
  } catch (_) {}

  return { acao: 'insert' };
}

/**
 * Executa 1 ciclo de sync. Sniper deve estar inicializado (com Bearer).
 * @param {object} sniper - instância SniperLance do tenant
 * @param {Database} db - tenant DB
 * @param {object} opts - { tenantSlug, log }
 */
async function rodarSync(sniper, db, { tenantSlug = '?', log = console.log } = {}) {
  if (!sniper || typeof sniper.apiGet !== 'function') {
    return { skipped: true, motivo: 'sniper sem apiGet' };
  }
  if (!sniper.temToken || !sniper.temToken()) {
    return { skipped: true, motivo: 'sem Bearer token' };
  }
  if (sniper.tokenExpirado && sniper.tokenExpirado()) {
    return { skipped: true, motivo: 'Bearer expirado' };
  }

  const candidatos = _selecionarCandidatos(db);
  if (candidatos.length === 0) return { skipped: true, motivo: 'sem candidatos' };

  let confirmadas = 0, semProposta = 0, erros = 0;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  for (const compraId of candidatos) {
    try {
      const path = `/comprasnet-fase-externa/v1/compras/${compraId}/participacao`;
      const resp = await sniper.apiGet(path);
      if (resp.status === 200 && _propostaJaEnviada(resp.data)) {
        const r = await _upsertPropostaEnviada(db, compraId, resp.data.situacaoCompraFaseExterna);
        if (r.acao !== 'skip') {
          confirmadas++;
          log(`[proposta-sync ${tenantSlug}] ${compraId}: proposta detectada (${r.acao})`);
        }
      } else if (resp.status === 200) {
        semProposta++;
      } else if (resp.status === 401 || resp.status === 403) {
        // Bearer caducou no meio do ciclo — para e tenta de novo na próxima rodada
        log(`[proposta-sync ${tenantSlug}] interrompido em ${compraId}: HTTP ${resp.status}`);
        break;
      } else if (resp.status === 404) {
        // compraId desconhecido — ignora silenciosamente
        semProposta++;
      } else {
        erros++;
      }
    } catch (e) {
      erros++;
      log(`[proposta-sync ${tenantSlug}] erro em ${compraId}: ${e.message}`);
    }
    await delay(ITEM_DELAY_MS);
  }

  return { candidatos: candidatos.length, confirmadas, semProposta, erros };
}

module.exports = { rodarSync };
