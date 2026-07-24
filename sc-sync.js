/**
 * sc-sync.js — Funções de sincronização com o portal SC.
 *
 * Três jobs independentes:
 *   - syncParticipacoes(client, db)        Phase 2a — descobre cotações onde sou participante
 *   - syncDisputa(client, db, cotacaoId)   Phase 2b — cache de lotes + meus lances
 *   - syncChat(client, db, cotacaoId, telegramFn)  Phase 2c — mensagens com dedup + Telegram
 *
 * Não tem scheduler aqui — o caller decide a cadência. Em Phase 2.5 o boot per-tenant
 * vai amarrar setInterval em torno desses jobs (similar ao SniperRefresh do Comprasnet).
 */

// Situações aceitas pelo enum do filtro `situacoes` no /api/dispensas-licitacao.
// Probadas em 2026-04-30: apenas EM_DISPUTA e EM_NEGOCIACAO são válidas — outras
// situações (RECEBENDO_PROPOSTAS, EM_ANDAMENTO, etc.) retornam HTTP 400 com
// `valor inválido para o campo: situacoes`. Outras fases provavelmente vivem
// num endpoint separado (não capturado ainda — a fase pre-disputa fica fora
// do escopo do robô atual, que atua durante a disputa de lances).
const SITUACOES_ATIVAS = 'EM_DISPUTA,EM_NEGOCIACAO';

/**
 * Pagina /api/dispensas-licitacao filtrando situações ativas.
 */
async function _listarTodasAtivas(client) {
  const tudo = [];
  let page = 0;
  const size = 50;
  for (;;) {
    const r = await client.apiGet('/api/dispensas-licitacao', {
      params: { page, size, situacoes: SITUACOES_ATIVAS },
    });
    if (r.status !== 200) {
      throw new Error(`/api/dispensas-licitacao status=${r.status}`);
    }
    const content = r.data?.content;
    if (!Array.isArray(content)) break;
    tudo.push(...content);
    if (r.data.last || content.length === 0) break;
    page++;
    if (page > 30) break;
  }
  return tudo;
}

/**
 * Phase 2a — descobre quais cotações ativas tenho participação.
 * Estratégia: paginar listagem geral e bater /{id}/participante para checar `apelido`.
 * Cotações que sumiram da listagem por 2 ciclos consecutivos viram ativo=0.
 */
async function syncParticipacoes(client, db) {
  await client.ensureToken();

  const listagem = await _listarTodasAtivas(client);
  const minhas = [];

  for (const c of listagem) {
    try {
      const part = await client.apiGet(`/api/dispensas-licitacao/${c.id}/participante`);
      if (part.status === 200 && part.data && part.data.apelido) {
        minhas.push({ ...c, apelido: part.data.apelido });
      }
    } catch (_) {
      // ignora erro pontual; tenta próxima
    }
    await new Promise((r) => setTimeout(r, 50)); // pacing leve
  }

  const upsert = db.prepare(`
    INSERT INTO sc_participacoes (
      cotacaoId, apelido, numeroEdital, anoEdital, orgaoSigla, orgaoDescricao,
      unidadeSigla, unidadeDescricao, objeto, cotacao, cotacaoPorItem, situacao,
      dataInicioLances, dataFimLances, dataPublicacao, ativo, ciclosAusente, ultimaSync
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(cotacaoId) DO UPDATE SET
      apelido = excluded.apelido,
      numeroEdital = excluded.numeroEdital,
      anoEdital = excluded.anoEdital,
      orgaoSigla = excluded.orgaoSigla,
      orgaoDescricao = excluded.orgaoDescricao,
      unidadeSigla = excluded.unidadeSigla,
      unidadeDescricao = excluded.unidadeDescricao,
      objeto = excluded.objeto,
      cotacao = excluded.cotacao,
      cotacaoPorItem = excluded.cotacaoPorItem,
      situacao = excluded.situacao,
      dataInicioLances = excluded.dataInicioLances,
      dataFimLances = excluded.dataFimLances,
      dataPublicacao = excluded.dataPublicacao,
      ativo = 1,
      ciclosAusente = 0,
      ultimaSync = CURRENT_TIMESTAMP
  `);

  const tx = db.transaction((rows) => {
    for (const c of rows) {
      // O campo `cotacao` na listagem é uma string ("Por Item" | "Por Lote" | "Por Preço Global").
      // Convertemos para boolean para ser usado por syncDisputa ao escolher /itens vs /lotes.
      const porItem = c.cotacao === 'Por Item' ? 1 : 0;
      upsert.run(
        c.id, c.apelido, c.numeroEdital, c.anoEdital, c.orgaoSigla, c.orgaoDescricao,
        c.unidadeSigla, c.unidadeDescricao, c.objeto, c.cotacao, porItem, c.situacao,
        c.dataInicioLances, c.dataFimLances, c.dataPublicacao
      );
    }
  });
  tx(minhas);

  // Marcar inativas: ativas no banco que não vieram na listagem desta vez.
  const idsAtivos = new Set(minhas.map((c) => c.id));
  const candidatas = db.prepare(`SELECT cotacaoId, ciclosAusente FROM sc_participacoes WHERE ativo = 1`).all();
  const incrementar = db.prepare(`UPDATE sc_participacoes SET ciclosAusente = ciclosAusente + 1 WHERE cotacaoId = ?`);
  const inativar = db.prepare(`UPDATE sc_participacoes SET ativo = 0, ciclosAusente = ciclosAusente + 1 WHERE cotacaoId = ?`);
  let inativadas = 0;
  for (const row of candidatas) {
    if (!idsAtivos.has(row.cotacaoId)) {
      if (row.ciclosAusente >= 1) {
        inativar.run(row.cotacaoId);
        inativadas++;
      } else {
        incrementar.run(row.cotacaoId);
      }
    }
  }

  _registrarSyncState(db, 'participacoes', 'ok', null, {
    listagem: listagem.length,
    minhas: minhas.length,
    inativadas,
  });

  return { listagem: listagem.length, minhas: minhas.length, inativadas };
}

/**
 * Phase 2b — cache do estado de uma cotação em disputa.
 *
 * Cotações "Por Lote" usam o endpoint `/lotes`. Cotações "Por Item" usam `/itens`.
 * O id retornado em `/meus-melhores-lances` é o mesmo (`idLoteItem`) — então a
 * tabela `sc_lotes_cache` é compartilhada entre os dois tipos. O caller pode
 * passar `cotacaoPorItem` explicitamente; se não, tentamos descobrir pela tabela
 * sc_participacoes; senão fazemos um GET /{id} para pegar o flag.
 */
async function syncDisputa(client, db, cotacaoId, opts = {}) {
  await client.ensureToken();

  let cotacaoPorItem = opts.cotacaoPorItem;
  if (cotacaoPorItem === undefined || cotacaoPorItem === null) {
    const cached = db.prepare('SELECT cotacaoPorItem FROM sc_participacoes WHERE cotacaoId = ?').get(cotacaoId);
    if (cached && cached.cotacaoPorItem !== null) {
      cotacaoPorItem = !!cached.cotacaoPorItem;
    } else {
      const det = await client.apiGet(`/api/dispensas-licitacao/${cotacaoId}`);
      cotacaoPorItem = !!det.data?.cotacaoPorItem;
    }
  }
  const path = cotacaoPorItem ? 'itens' : 'lotes';

  const [lotesResp, meusResp] = await Promise.all([
    client.apiGet(`/api/dispensas-licitacao/${cotacaoId}/${path}`),
    client.apiGet(`/api/dispensas-licitacao/${cotacaoId}/meus-melhores-lances`),
  ]);

  if (lotesResp.status !== 200 || !Array.isArray(lotesResp.data)) {
    throw new Error(`/${cotacaoId}/${path} status=${lotesResp.status}`);
  }

  const meusPorLote = new Map();
  if (meusResp.status === 200 && Array.isArray(meusResp.data)) {
    for (const m of meusResp.data) meusPorLote.set(m.idLoteItem, m.valorMeuMelhorLance);
  }

  const upsert = db.prepare(`
    INSERT INTO sc_lotes_cache (
      cotacaoId, loteId, numero, descricao, situacao,
      melhorLance, melhorColocado, ajustePrecosAprovado, meuMelhorLance, ultimaSync
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(cotacaoId, loteId) DO UPDATE SET
      numero = excluded.numero,
      descricao = excluded.descricao,
      situacao = excluded.situacao,
      melhorLance = excluded.melhorLance,
      melhorColocado = excluded.melhorColocado,
      ajustePrecosAprovado = excluded.ajustePrecosAprovado,
      meuMelhorLance = excluded.meuMelhorLance,
      ultimaSync = CURRENT_TIMESTAMP
  `);

  const tx = db.transaction((lotes) => {
    for (const l of lotes) {
      upsert.run(
        cotacaoId, l.id, l.numero, l.descricao, l.situacao,
        l.melhorLance, l.melhorColocado,
        l.ajustePrecosAprovado ? 1 : 0,
        meusPorLote.has(l.id) ? meusPorLote.get(l.id) : null
      );
    }
  });
  tx(lotesResp.data);

  return { cotacaoId, lotes: lotesResp.data.length };
}

/**
 * Phase 2c — mensagens do chat com dedup por id incremental do servidor.
 * Mensagens novas com tipoRemetente !== 'SISTEMA' disparam Telegram (se telegramFn fornecida).
 */
async function syncChat(client, db, cotacaoId, telegramFn) {
  await client.ensureToken();

  const r = await client.apiGet(`/api/dispensas-licitacao/${cotacaoId}/chat`);
  if (r.status !== 200 || !Array.isArray(r.data)) {
    throw new Error(`/${cotacaoId}/chat status=${r.status}`);
  }

  const insertNew = db.prepare(`
    INSERT INTO sc_chat_mensagens (id, cotacaoId, remetente, tipoRemetente, mensagem, dataCriacao, chatBloqueado, notificadoTelegram)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO NOTHING
  `);
  const marcarNotif = db.prepare(`UPDATE sc_chat_mensagens SET notificadoTelegram = 1 WHERE id = ?`);
  const lerCotacao = db.prepare(`SELECT numeroEdital, anoEdital, orgaoSigla FROM sc_participacoes WHERE cotacaoId = ?`);

  let novas = 0;
  let notificadas = 0;
  for (const m of r.data) {
    const result = insertNew.run(
      m.id, cotacaoId, m.remetente, m.tipoRemetente, m.mensagem, m.dataCriacao,
      m.chatBloqueado ? 1 : 0
    );
    if (result.changes > 0) {
      novas++;
      if (telegramFn && m.tipoRemetente && m.tipoRemetente !== 'SISTEMA') {
        try {
          const part = lerCotacao.get(cotacaoId);
          const tag = part
            ? `[SC] Edital ${part.numeroEdital}/${part.anoEdital} (${part.orgaoSigla}) — cotação ${cotacaoId}`
            : `[SC] Cotação ${cotacaoId}`;
          await telegramFn(`${tag}\n${m.tipoRemetente} (${m.remetente || '?'}):\n${m.mensagem}`);
          marcarNotif.run(m.id);
          notificadas++;
        } catch (e) {
          console.error(`[SC-chat] Telegram falhou (msg ${m.id}): ${e.message}`);
        }
      }
    }
  }

  return { cotacaoId, total: r.data.length, novas, notificadas };
}

function _registrarSyncState(db, job, status, erro, detalhes) {
  try {
    db.prepare(`
      INSERT INTO sc_sync_state (job, ultimaExecucao, ultimoStatus, ultimoErro, detalhes)
      VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?)
      ON CONFLICT(job) DO UPDATE SET
        ultimaExecucao = CURRENT_TIMESTAMP,
        ultimoStatus = excluded.ultimoStatus,
        ultimoErro = excluded.ultimoErro,
        detalhes = excluded.detalhes
    `).run(job, status, erro, detalhes ? JSON.stringify(detalhes) : null);
  } catch (e) {
    console.error(`[SC-sync] Erro ao gravar state ${job}: ${e.message}`);
  }
}

module.exports = { syncParticipacoes, syncDisputa, syncChat, SITUACOES_ATIVAS };
