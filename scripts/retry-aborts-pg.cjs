#!/usr/bin/env node
// retry-aborts-pg.cjs (2026-05-29)
//
// Versão PostgreSQL do retry-aborts.cjs. O original escrevia no catalog.db
// SQLite, que está MORTO desde a migração pro PG (liciteagora_catalog).
// Este lê/escreve bi_aborts + licitacoes + itens no Postgres.
//
// Re-tenta dias abortados (bi_aborts.resolvidoEm IS NULL) via PNCP API:
//   1) buscarLicitacoesDoDia(dia, modalidade)
//   2) sucesso → salvarLicitacaoPg + salvarItensPg + marca resolvidoEm
//   3) falha → incrementa tentativasRetry (até 10)
//
// Uso:
//   CATALOG_BACKEND_PG=1 node scripts/retry-aborts-pg.cjs [maxBatch] [pageDelayMs]

'use strict';

process.env.CATALOG_BACKEND_PG = '1';

const axios = require('axios');
const https = require('https');
const catalogPg = require('../catalog-pg');
const { salvarLicitacaoPg, salvarItensPg } = require('../licitacoes-persistence');

const PNCP_API_BASE = 'https://pncp.gov.br/api/consulta/v1';
const PNCP_API_ITENS = 'https://pncp.gov.br/api/pncp/v1';
const MAX_BATCH = parseInt(process.argv[2], 10) || 200;
const PAGE_DELAY_MS = parseInt(process.argv[3], 10) || 100;
const MAX_TENTATIVAS = 10;
const MAX_RETRIES_PAGINA = 5;

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const http = axios.create({ httpsAgent, timeout: 8000, headers: { Accept: 'application/json' } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Réplica de buscarLicitacoesDoDia (lógica idêntica ao sync principal), com
// guard anti-WAF: se a resposta não for o shape esperado, trata como erro.
async function buscarLicitacoesDoDia(dia, modalidade) {
  const resultados = [];
  let pagina = 1;
  const diaAPI = dia.replace(/-/g, '');
  while (pagina <= 200) {
    let sucesso = false, ultimoErro = null, parou = false;
    for (let t = 1; t <= MAX_RETRIES_PAGINA; t++) {
      try {
        const r = await http.get(`${PNCP_API_BASE}/contratacoes/publicacao`, {
          params: { dataInicial: diaAPI, dataFinal: diaAPI, codigoModalidadeContratacao: modalidade, pagina, tamanhoPagina: 50 },
        });
        // WAF do PNCP devolve HTML com 200 → r.data é string, não objeto.
        if (typeof r.data !== 'object' || r.data === null) {
          throw new Error('resposta não-JSON (provável bloqueio WAF)');
        }
        if (Array.isArray(r.data.data) && r.data.data.length > 0) {
          resultados.push(...r.data.data);
          sucesso = true;
        } else {
          parou = true; sucesso = true;
        }
        break;
      } catch (e) {
        if (e.response?.status === 400 || e.response?.status === 422) { parou = true; sucesso = true; break; }
        ultimoErro = e;
        await sleep(1000 * t);
      }
    }
    if (!sucesso) throw new Error(`pag ${pagina} ${MAX_RETRIES_PAGINA} retries: ${ultimoErro?.message}`);
    pagina++;
    if (parou) break;
    await sleep(PAGE_DELAY_MS);
  }
  return resultados;
}

async function buscarItens(cnpj, ano, seq) {
  const todos = [];
  let pagina = 1;
  while (true) {
    try {
      const r = await http.get(`${PNCP_API_ITENS}/orgaos/${cnpj}/compras/${ano}/${seq}/itens`,
        { params: { pagina, tamanhoPagina: 100 }, timeout: 15000 });
      const itens = r.data;
      if (!Array.isArray(itens)) break;      // guard anti-WAF (não dar push em string)
      if (itens.length === 0) break;
      todos.push(...itens);
      if (itens.length < 100) break;
      pagina++;
      await sleep(100);
    } catch (e) { break; }
  }
  return todos;
}

(async () => {
  const t0 = Date.now();
  const totalPend = Number((await catalogPg.queryOne(
    `SELECT COUNT(*) AS c FROM bi_aborts WHERE "resolvidoEm" IS NULL`))?.c || 0);
  const pendentes = await catalogPg.query(
    `SELECT id, dia, modalidade, "tentativasRetry"
       FROM bi_aborts
      WHERE "resolvidoEm" IS NULL AND "tentativasRetry" < $1
      ORDER BY "tentativasRetry" ASC, "primeiraAbortEm" ASC
      LIMIT $2`,
    [MAX_TENTATIVAS, MAX_BATCH]);
  console.log(`[retry-aborts-pg] processando ${pendentes.length} (dia, modalidade) pendentes (de ${totalPend} total)`);

  let resolvidos = 0, falharam = 0, licInseridas = 0, itensInseridos = 0;
  for (const p of pendentes) {
    try {
      const licitacoes = await buscarLicitacoesDoDia(p.dia, p.modalidade);
      for (const lic of licitacoes) { await salvarLicitacaoPg(lic); licInseridas++; }
      // itens das licitações que ainda não têm itens
      for (const lic of licitacoes) {
        const ncp = lic.numeroControlePNCP;
        const ja = Number((await catalogPg.queryOne(
          `SELECT COUNT(*) AS c FROM itens i JOIN licitacoes l ON l.id=i."licitacaoId" WHERE l."numeroControlePNCP"=$1`,
          [ncp]))?.c || 0);
        if (ja === 0) {
          const itens = await buscarItens(lic.orgaoEntidade?.cnpj, lic.anoCompra, lic.sequencialCompra);
          if (itens.length > 0) { await salvarItensPg(ncp, itens); itensInseridos += itens.length; }
        }
      }
      await catalogPg.execute(
        `UPDATE bi_aborts SET "resolvidoEm"=now(), "ultimaTentativaEm"=now() WHERE id=$1`, [p.id]);
      resolvidos++;
    } catch (e) {
      await catalogPg.execute(
        `UPDATE bi_aborts SET "tentativasRetry"="tentativasRetry"+1, "ultimaTentativaEm"=now(), motivo=$1 WHERE id=$2`,
        [`retry ${p.tentativasRetry + 1}: ${(e.message || '').substring(0, 80)}`, p.id]);
      falharam++;
    }
  }
  const restantes = Number((await catalogPg.queryOne(
    `SELECT COUNT(*) AS c FROM bi_aborts WHERE "resolvidoEm" IS NULL`))?.c || 0);
  console.log(`[retry-aborts-pg] ${resolvidos} resolvidos, ${falharam} falharam | +${licInseridas} licitações, +${itensInseridos} itens em ${((Date.now()-t0)/1000).toFixed(0)}s | ${restantes} pendentes restantes`);
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
