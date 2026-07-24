// resultados-backfill.js — Plano 10 (2026-04-23)
//
// Backfill em background de `resultados_bi`. Recebe o catalogDb,
// roda um loop recursivo (setTimeout) no master process que a cada ciclo
// pega um lote de itens sem resultado cacheado e chama a PNCP API.
//
// Prioriza itens de licitações encerradas nos últimos 365 dias (o que
// interessa mais aos tenants). Quando esgotar, passa para o long-tail.
//
// Persiste cursor em `catalog.catalog_sync_state` com chaves:
//   - resultadosBackfillLastRun  (ISO timestamp da última rodada)
//   - resultadosBackfillCount    (total de itens processados — hit + 404)
//   - resultadosBackfillErrors   (total de erros de rede/servidor)
//
// Uso:
//   const backfill = require('./resultados-backfill');
//   backfill.init({ db: catalogDb });
//   backfill.iniciarBackfillEngine();
//
// Fase 3d (2026-05-23): dual-stack SQLite/Postgres via CATALOG_BACKEND_PG=1.

'use strict';

const axios = require('axios');
const catalogPg = require('./catalog-pg');

const PNCP_API = 'https://pncp.gov.br/api/pncp/v1';
// Throughput aumentado em 2026-04-23: com os valores antigos (10 itens/min,
// 150ms entre itens) o backfill levaria ~220 dias para cobrir os 3.2M itens
// encerrados. A API do PNCP (pública, nacional) aguenta muito mais. ETA
// com estes valores: ~14 dias para catálogo completo a partir do zero.
const CYCLE_MS = 10 * 1000;          // 10s entre ciclos
const ITEM_DELAY_MS = 30;            // 30 ms entre itens PNCP (teste A/B 2026-05-28: +14% vs 80ms, timeouts desprezíveis)
const LOTE_SIZE = 200;               // 200 itens por ciclo

let _db = null;
let _timer = null;
let _running = false;
let _loggedErrorThisCycle = false;

function init({ db }) {
  if (!db) throw new Error('resultados-backfill.init: db obrigatório');
  _db = db;
}

function _ensure() {
  if (!_db) throw new Error('resultados-backfill não inicializado');
}

function _usePg() { return process.env.CATALOG_BACKEND_PG === '1'; }

async function _getState(key, fallback) {
  if (_usePg()) {
    const r = await catalogPg.queryOne('SELECT "value" FROM catalog_sync_state WHERE "key"=$1', [key]);
    return r ? r.value : fallback;
  }
  const row = _db.prepare('SELECT value FROM catalog_sync_state WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

async function _setState(key, value) {
  if (_usePg()) {
    await catalogPg.execute(
      `INSERT INTO catalog_sync_state ("key","value","updated_at") VALUES ($1,$2,$3)
       ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value", "updated_at"=EXCLUDED."updated_at"`,
      [key, String(value), Date.now()]
    );
    return;
  }
  _db.prepare(`
    INSERT INTO catalog_sync_state (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
  `).run(key, String(value));
}

async function _incState(key, delta) {
  const atual = parseInt(await _getState(key, '0'), 10) || 0;
  await _setState(key, atual + delta);
}

// Lote priorizado:
//   - itens nunca consultados (rb.id IS NULL), OU
//   - itens marcados '__sem_resultado__' há mais de 7 dias cuja licitação
//     encerrou nos últimos 180 dias (PNCP pode ter publicado o vencedor
//     depois da nossa primeira consulta — ciclo edital→homologação dura
//     30-180 dias). Marcador "definitivo" só pra licitações > 180 dias.
// Em primeiro passe filtra últimos 365 dias por proximidade; fallback
// cobre histórico inteiro.
const SEM_RESULTADO_RETRY_DIAS = 7;
const SEM_RESULTADO_MAX_DIAS = 180;

async function _selecionarLote() {
  if (_usePg()) {
    // Postgres: now() substitui datetime('now'). LEFT JOIN igual; quoting
    // camelCase. Tenta com janela 365d primeiro; fallback sem janela.
    const sqlBaseTpl = (janela) => `
      SELECT l."cnpj" AS cnpj, l."anoCompra" AS ano, l."sequencialCompra" AS sequencial, i."numeroItem" AS "numeroItem"
        FROM itens i
        JOIN licitacoes l ON l."id" = i."licitacaoId"
   LEFT JOIN resultados_bi rb
          ON rb."cnpj" = l."cnpj" AND rb."ano" = l."anoCompra"
         AND rb."sequencial" = l."sequencialCompra" AND rb."numeroItem" = i."numeroItem"
       WHERE COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") < now()
         AND i."numeroItem" IS NOT NULL
         AND (
           rb."id" IS NULL
           OR (
             rb."niFornecedor" = '__sem_resultado__'
             AND rb."dataCache" < now() - interval '${SEM_RESULTADO_RETRY_DIAS} days'
             AND COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") > now() - interval '${SEM_RESULTADO_MAX_DIAS} days'
           )
         )
         ${janela}
    ORDER BY COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") DESC
       LIMIT $1
    `;
    let rows = await catalogPg.query(
      sqlBaseTpl(`AND COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") > now() - interval '365 days'`),
      [LOTE_SIZE]
    );
    if (rows.length === 0) rows = await catalogPg.query(sqlBaseTpl(''), [LOTE_SIZE]);
    return rows;
  }

  // SQLite fallback
  const sqlBase = `
    SELECT l.cnpj, l.anoCompra AS ano, l.sequencialCompra AS sequencial, i.numeroItem
    FROM itens i
    JOIN licitacoes l ON l.id = i.licitacaoId
    LEFT JOIN resultados_bi rb
           ON rb.cnpj = l.cnpj AND rb.ano = l.anoCompra
          AND rb.sequencial = l.sequencialCompra AND rb.numeroItem = i.numeroItem
    WHERE l.dataEncerramentoProposta < datetime('now')
      AND i.numeroItem IS NOT NULL
      AND (
        rb.id IS NULL
        OR (
          rb.niFornecedor = '__sem_resultado__'
          AND rb.dataCache < datetime('now', '-${SEM_RESULTADO_RETRY_DIAS} days')
          AND l.dataEncerramentoProposta > datetime('now', '-${SEM_RESULTADO_MAX_DIAS} days')
        )
      )
      %JANELA%
    ORDER BY l.dataEncerramentoProposta DESC
    LIMIT ?
  `;
  const comJanela = sqlBase.replace('%JANELA%', `AND l.dataEncerramentoProposta > datetime('now','-365 days')`);
  let rows = _db.prepare(comJanela).all(LOTE_SIZE);
  if (rows.length === 0) {
    const semJanela = sqlBase.replace('%JANELA%', '');
    rows = _db.prepare(semJanela).all(LOTE_SIZE);
  }
  return rows;
}

// UNIQUE PG é (cnpj, ano, sequencial, numeroItem, niFornecedor) — ON CONFLICT
// usa essa chave completa pra atualizar a linha correta (inclui marcador).
const PG_INSERT_RESULTADO = `
  INSERT INTO resultados_bi
    ("cnpj","ano","sequencial","numeroItem","niFornecedor","nomeRazaoSocialFornecedor",
     "valorUnitarioHomologado","valorTotalHomologado","marcaFabricante","modeloVersao",
     "dataResultado","dadosCompletos","dataCache")
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb, now())
  ON CONFLICT ("cnpj","ano","sequencial","numeroItem","niFornecedor") DO UPDATE SET
    "nomeRazaoSocialFornecedor" = EXCLUDED."nomeRazaoSocialFornecedor",
    "valorUnitarioHomologado"   = EXCLUDED."valorUnitarioHomologado",
    "valorTotalHomologado"      = EXCLUDED."valorTotalHomologado",
    "marcaFabricante"           = EXCLUDED."marcaFabricante",
    "modeloVersao"              = EXCLUDED."modeloVersao",
    "dataResultado"             = EXCLUDED."dataResultado",
    "dadosCompletos"            = EXCLUDED."dadosCompletos",
    "dataCache"                 = now()
`;

const PG_INSERT_SEM_RESULTADO = `
  INSERT INTO resultados_bi
    ("cnpj","ano","sequencial","numeroItem","niFornecedor","nomeRazaoSocialFornecedor","dataCache")
  VALUES ($1,$2,$3,$4,'__sem_resultado__','', now())
  ON CONFLICT ("cnpj","ano","sequencial","numeroItem","niFornecedor") DO UPDATE SET "dataCache" = now()
`;

async function _processarItem(item) {
  const url = `${PNCP_API}/orgaos/${item.cnpj}/compras/${item.ano}/${item.sequencial}/itens/${item.numeroItem}/resultados`;
  try {
    const resp = await axios.get(url, {
      headers: { 'Accept': 'application/json' },
      timeout: 10000,
    });
    const resData = resp.data || [];
    if (Array.isArray(resData) && resData.length > 0) {
      if (_usePg()) {
        for (const r of resData) {
          await catalogPg.execute(PG_INSERT_RESULTADO, [
            item.cnpj, item.ano, item.sequencial, item.numeroItem,
            r.niFornecedor || '', r.nomeRazaoSocialFornecedor || '',
            r.valorUnitarioHomologado || null, r.valorTotalHomologado || null,
            r.marcaFabricante || r.marca || '', r.modeloVersao || '',
            r.dataResultado || null, JSON.stringify(r),
          ]);
        }
      } else {
        const stmt = _db.prepare(`
          INSERT OR REPLACE INTO resultados_bi
            (cnpj, ano, sequencial, numeroItem, niFornecedor, nomeRazaoSocialFornecedor,
             valorUnitarioHomologado, valorTotalHomologado, marcaFabricante, modeloVersao,
             dataResultado, dadosCompletos)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of resData) {
          stmt.run(
            item.cnpj, item.ano, item.sequencial, item.numeroItem,
            r.niFornecedor || '', r.nomeRazaoSocialFornecedor || '',
            r.valorUnitarioHomologado || null, r.valorTotalHomologado || null,
            r.marcaFabricante || r.marca || '', r.modeloVersao || '',
            r.dataResultado || '', JSON.stringify(r)
          );
        }
      }
    } else {
      // INSERT OR REPLACE atualiza dataCache na re-tentativa, pra que o
      // _selecionarLote saiba reescolher esse item depois do SEM_RESULTADO_RETRY_DIAS.
      if (_usePg()) {
        await catalogPg.execute(PG_INSERT_SEM_RESULTADO, [item.cnpj, item.ano, item.sequencial, item.numeroItem]);
      } else {
        _db.prepare(`
          INSERT OR REPLACE INTO resultados_bi
            (cnpj, ano, sequencial, numeroItem, niFornecedor, nomeRazaoSocialFornecedor, dataCache)
          VALUES (?, ?, ?, ?, '__sem_resultado__', '', CURRENT_TIMESTAMP)
        `).run(item.cnpj, item.ano, item.sequencial, item.numeroItem);
      }
    }
    return { ok: true };
  } catch (err) {
    if (err.response?.status === 404) {
      if (_usePg()) {
        await catalogPg.execute(PG_INSERT_SEM_RESULTADO, [item.cnpj, item.ano, item.sequencial, item.numeroItem]);
      } else {
        _db.prepare(`
          INSERT OR REPLACE INTO resultados_bi
            (cnpj, ano, sequencial, numeroItem, niFornecedor, nomeRazaoSocialFornecedor, dataCache)
          VALUES (?, ?, ?, ?, '__sem_resultado__', '', CURRENT_TIMESTAMP)
        `).run(item.cnpj, item.ano, item.sequencial, item.numeroItem);
      }
      return { ok: true, status: 404 };
    }
    // Log primeiro erro de cada ciclo para diagnóstico. Não spama 50x.
    if (!_loggedErrorThisCycle) {
      _loggedErrorThisCycle = true;
      console.error(`[backfill] erro: ${err.message}`, err.response?.status ? `(HTTP ${err.response.status})` : '', err.code || '');
    }
    return { ok: false, error: err.message };
  }
}

async function _ciclo() {
  if (_running) return;
  _running = true;
  _loggedErrorThisCycle = false;
  const t0 = Date.now();
  try {
    const lote = await _selecionarLote();
    if (lote.length === 0) {
      await _setState('resultadosBackfillLastRun', new Date().toISOString());
      console.log('[backfill] lote vazio (catalog completo ou sem encerradas pendentes)');
      return;
    }
    let hits = 0, erros = 0;
    for (const item of lote) {
      const r = await _processarItem(item);
      if (r.ok) hits++; else erros++;
      await new Promise(res => setTimeout(res, ITEM_DELAY_MS));
    }
    await _incState('resultadosBackfillCount', hits);
    if (erros > 0) await _incState('resultadosBackfillErrors', erros);
    await _setState('resultadosBackfillLastRun', new Date().toISOString());
    const ms = Date.now() - t0;
    const totalAcumulado = parseInt(await _getState('resultadosBackfillCount', '0'), 10) || 0;
    console.log(`[backfill] ciclo +${hits} hits, ${erros} erros em ${ms}ms (total histórico: ${totalAcumulado})`);
  } catch (err) {
    console.error('[backfill] ciclo falhou:', err.message);
    await _incState('resultadosBackfillErrors', 1);
  } finally {
    _running = false;
  }
}

function iniciarBackfillEngine() {
  _ensure();
  // Primeiro ciclo em 30s (deixa o worker terminar boot)
  _timer = setTimeout(async function loop() {
    await _ciclo();
    _timer = setTimeout(loop, CYCLE_MS);
  }, 30000);
  console.log(`[backfill] engine de resultados_bi iniciado (${LOTE_SIZE} itens a cada ${CYCLE_MS/1000}s${_usePg() ? ' — PG' : ''})`);
}

function pararBackfillEngine() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

async function getBackfillStatus() {
  _ensure();
  let cacheados, cacheadosReais, totalItens, pendentes;
  if (_usePg()) {
    cacheados = Number((await catalogPg.queryOne(`SELECT COUNT(*) AS c FROM resultados_bi`))?.c || 0);
    cacheadosReais = Number((await catalogPg.queryOne(`SELECT COUNT(*) AS c FROM resultados_bi WHERE "niFornecedor" != '__sem_resultado__'`))?.c || 0);
    totalItens = Number((await catalogPg.queryOne(`
      SELECT COUNT(*) AS c FROM itens i
        JOIN licitacoes l ON l."id" = i."licitacaoId"
       WHERE COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") < now()
    `))?.c || 0);
    pendentes = Number((await catalogPg.queryOne(`
      SELECT COUNT(*) AS c FROM itens i
        JOIN licitacoes l ON l."id" = i."licitacaoId"
   LEFT JOIN resultados_bi rb
          ON rb."cnpj" = l."cnpj" AND rb."ano" = l."anoCompra"
         AND rb."sequencial" = l."sequencialCompra" AND rb."numeroItem" = i."numeroItem"
       WHERE rb."id" IS NULL
         AND COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") < now()
    `))?.c || 0);
  } else {
    cacheados = _db.prepare(`SELECT COUNT(*) c FROM resultados_bi`).get().c;
    cacheadosReais = _db.prepare(`SELECT COUNT(*) c FROM resultados_bi WHERE niFornecedor != '__sem_resultado__'`).get().c;
    totalItens = _db.prepare(`
      SELECT COUNT(*) c FROM itens i
      JOIN licitacoes l ON l.id = i.licitacaoId
      WHERE l.dataEncerramentoProposta < datetime('now')
    `).get().c;
    pendentes = _db.prepare(`
      SELECT COUNT(*) c FROM itens i
      JOIN licitacoes l ON l.id = i.licitacaoId
      LEFT JOIN resultados_bi rb
             ON rb.cnpj = l.cnpj AND rb.ano = l.anoCompra
            AND rb.sequencial = l.sequencialCompra AND rb.numeroItem = i.numeroItem
      WHERE rb.id IS NULL
        AND l.dataEncerramentoProposta < datetime('now')
    `).get().c;
  }
  return {
    cacheadosTotal: cacheados,
    cacheadosComResultado: cacheadosReais,
    totalItensEncerrados: totalItens,
    pendentes,
    progresso: totalItens > 0 ? cacheados / totalItens : 0,
    lastRun: await _getState('resultadosBackfillLastRun', null),
    contador: parseInt(await _getState('resultadosBackfillCount', '0'), 10) || 0,
    erros: parseInt(await _getState('resultadosBackfillErrors', '0'), 10) || 0,
  };
}

// ====================================================================
// RETRY DAS PARTICIPAÇÕES (2026-05-19)
//
// O backfill principal pega cada item exatamente uma vez. Quando o PNCP
// ainda não publicou o resultado, ele grava uma linha-marcador com
// `niFornecedor = '__sem_resultado__'`. Por causa do LEFT JOIN em
// `_selecionarLote`, esse item nunca mais é re-consultado — e
// participações homologadas DEPOIS do primeiro fetch ficam congeladas
// como "Pendente" para sempre.
//
// Esta função roda 1x por dia (chamada pelo scheduler) e re-consulta
// SÓ os itens das participações ATIVAS do tenant cujo cache atual é
// `__sem_resultado__`. Universo pequeno (centenas vs. 3M+ do catálogo
// histórico), então pode ser agressivo.
//
// Atualização: como a UNIQUE inclui niFornecedor, DELETE + INSERT.
// Fase 3d: tenantDb continua SQLite (per-tenant), catalog vai pra PG quando flag.
async function retentarSemResultadoParticipacoes(tenantDb, { tenantSlug } = {}) {
  _ensure();
  // Itens com cache "__sem_resultado__" pertencentes a participações ativas
  // do tenant. JOIN entre tabelas de DBs diferentes não é possível direto, então:
  //   1. lê (cnpj, ano, sequencial) das participações no tenantDb;
  //   2. para cada uma, pega itens com __sem_resultado__ no catálogo;
  //   3. re-consulta PNCP.
  const participacoes = tenantDb.prepare(`
    SELECT DISTINCT cnpj, ano, sequencial FROM participacoes_comprasnet WHERE ativo = 1
  `).all();
  if (participacoes.length === 0) return { participacoes: 0, items: 0, atualizados: 0, ainda_sem: 0, erros: 0 };

  const usePg = _usePg();
  // Prepared statements (somente em SQLite mode)
  const selItensSqlite = !usePg ? _db.prepare(`
    SELECT id, cnpj, ano, sequencial, numeroItem
    FROM resultados_bi
    WHERE cnpj = ? AND ano = ? AND sequencial = ? AND niFornecedor = '__sem_resultado__'
  `) : null;
  const delLinhaSqlite = !usePg ? _db.prepare(`
    DELETE FROM resultados_bi WHERE id = ?
  `) : null;

  let totalItems = 0;
  let atualizados = 0;
  let aindaSem = 0;
  let erros = 0;
  _loggedErrorThisCycle = false;

  for (const p of participacoes) {
    let itens;
    if (usePg) {
      itens = await catalogPg.query(
        `SELECT "id","cnpj","ano","sequencial","numeroItem"
           FROM resultados_bi
          WHERE "cnpj"=$1 AND "ano"=$2 AND "sequencial"=$3 AND "niFornecedor"='__sem_resultado__'`,
        [p.cnpj, p.ano, p.sequencial]
      );
    } else {
      itens = selItensSqlite.all(p.cnpj, p.ano, p.sequencial);
    }
    for (const it of itens) {
      totalItems++;
      try {
        const url = `${PNCP_API}/orgaos/${it.cnpj}/compras/${it.ano}/${it.sequencial}/itens/${it.numeroItem}/resultados`;
        const resp = await axios.get(url, {
          headers: { 'Accept': 'application/json' },
          timeout: 10000,
        });
        const resData = resp.data || [];
        if (Array.isArray(resData) && resData.length > 0) {
          // PNCP tem resultado agora — apaga o marcador e insere os reais.
          if (usePg) {
            await catalogPg.withTx(async (client) => {
              await client.query(`DELETE FROM resultados_bi WHERE "id"=$1`, [it.id]);
              for (const r of resData) {
                await client.query(PG_INSERT_RESULTADO, [
                  it.cnpj, it.ano, it.sequencial, it.numeroItem,
                  r.niFornecedor || '', r.nomeRazaoSocialFornecedor || '',
                  r.valorUnitarioHomologado || null, r.valorTotalHomologado || null,
                  r.marcaFabricante || r.marca || '', r.modeloVersao || '',
                  r.dataResultado || null, JSON.stringify(r),
                ]);
              }
            });
          } else {
            const trx = _db.transaction(() => {
              delLinhaSqlite.run(it.id);
              const stmt = _db.prepare(`
                INSERT OR REPLACE INTO resultados_bi
                  (cnpj, ano, sequencial, numeroItem, niFornecedor, nomeRazaoSocialFornecedor,
                   valorUnitarioHomologado, valorTotalHomologado, marcaFabricante, modeloVersao,
                   dataResultado, dadosCompletos)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `);
              for (const r of resData) {
                stmt.run(
                  it.cnpj, it.ano, it.sequencial, it.numeroItem,
                  r.niFornecedor || '', r.nomeRazaoSocialFornecedor || '',
                  r.valorUnitarioHomologado || null, r.valorTotalHomologado || null,
                  r.marcaFabricante || r.marca || '', r.modeloVersao || '',
                  r.dataResultado || '', JSON.stringify(r)
                );
              }
            });
            trx();
          }
          atualizados++;
        } else {
          // PNCP ainda vazio — toca o dataCache pra rastrear última tentativa,
          // mas mantém o marcador.
          if (usePg) {
            await catalogPg.execute(`UPDATE resultados_bi SET "dataCache"=now() WHERE "id"=$1`, [it.id]);
          } else {
            _db.prepare(`UPDATE resultados_bi SET dataCache = CURRENT_TIMESTAMP WHERE id = ?`).run(it.id);
          }
          aindaSem++;
        }
      } catch (err) {
        if (err.response?.status === 404) {
          if (usePg) {
            await catalogPg.execute(`UPDATE resultados_bi SET "dataCache"=now() WHERE "id"=$1`, [it.id]);
          } else {
            _db.prepare(`UPDATE resultados_bi SET dataCache = CURRENT_TIMESTAMP WHERE id = ?`).run(it.id);
          }
          aindaSem++;
        } else {
          erros++;
          if (!_loggedErrorThisCycle) {
            _loggedErrorThisCycle = true;
            console.error(`[backfill-retry][${tenantSlug||'?'}] erro ${it.cnpj}/${it.ano}/${it.sequencial}/${it.numeroItem}: ${err.message}`);
          }
        }
      }
      await new Promise(res => setTimeout(res, ITEM_DELAY_MS));
    }
  }
  return { participacoes: participacoes.length, items: totalItems, atualizados, ainda_sem: aindaSem, erros };
}

module.exports = {
  init, iniciarBackfillEngine, pararBackfillEngine, getBackfillStatus,
  retentarSemResultadoParticipacoes,
};
