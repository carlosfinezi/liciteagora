#!/usr/bin/env node
// retry-aborts.cjs
//
// Re-tenta dias abortados (bi_aborts.resolvidoEm IS NULL) via PNCP API.
// Pra cada (dia, modalidade) pendente:
//   1) chama buscarLicitacoesDoDia
//   2) se OK: persiste licitações + marca resolvidoEm
//   3) se falhar: incrementa tentativasRetry (até 10 antes de desistir)
//
// Roda no master (mesmo IP do principal — sem rate-limit /24 dos Contabos).
// Default: processa MAX_BATCH=200 por execução pra não inundar PNCP.
// Cron sugerido: 04:00 da manhã (baixa concorrência).
//
// Uso:
//   node scripts/retry-aborts.cjs [maxBatch] [pageDelayMs]

const path = require('path');
const Database = require('better-sqlite3');
const axios = require('axios');
const https = require('https');

const CATALOG = '/home/carlosfinezi/web/liciteagora.com.br/private/data/catalog.db';
const PNCP_API_BASE = 'https://pncp.gov.br/api/consulta/v1';
const PNCP_API_ITENS = 'https://pncp.gov.br/api/pncp/v1';
const MAX_BATCH = parseInt(process.argv[2], 10) || 200;
const PAGE_DELAY_MS = parseInt(process.argv[3], 10) || 100;
const MAX_TENTATIVAS = 10;

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const http = axios.create({ httpsAgent, timeout: 8000, headers: { 'Accept': 'application/json' } });

const db = new Database(CATALOG);
db.pragma('busy_timeout = 60000');

const stmtPick = db.prepare(`
  SELECT id, dia, modalidade, tentativasRetry
    FROM bi_aborts
   WHERE resolvidoEm IS NULL AND tentativasRetry < ?
   ORDER BY tentativasRetry ASC, primeiraAbortEm ASC
   LIMIT ?
`);
const stmtMarcarResolvido = db.prepare(`
  UPDATE bi_aborts SET resolvidoEm = CURRENT_TIMESTAMP, ultimaTentativaEm = CURRENT_TIMESTAMP WHERE id = ?
`);
const stmtIncrementar = db.prepare(`
  UPDATE bi_aborts SET tentativasRetry = tentativasRetry + 1, ultimaTentativaEm = CURRENT_TIMESTAMP, motivo = ? WHERE id = ?
`);

const stmtInsertLic = db.prepare(`
  INSERT OR REPLACE INTO licitacoes (
    numeroControlePNCP, cnpj, razaoSocial, ufSigla, municipioNome, nomeUnidade, codigoUnidade,
    anoCompra, sequencialCompra, numeroCompra, processo, modalidadeId, modalidadeNome,
    objetoCompra, informacaoComplementar, valorTotalEstimado, dataPublicacaoPncp,
    dataAberturaProposta, dataEncerramentoProposta, situacaoCompraNome, linkSistemaOrigem,
    usuarioNome, srp, dadosCompletos, dataAtualizacao
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`);
const stmtGetLicId = db.prepare('SELECT id FROM licitacoes WHERE numeroControlePNCP = ?');
const stmtDeleteItens = db.prepare('DELETE FROM itens WHERE numeroControlePNCP = ?');
const stmtInsertItem = db.prepare(`
  INSERT OR REPLACE INTO itens (licitacaoId, numeroControlePNCP, numeroItem, descricao, quantidade, unidadeMedida, valorUnitarioEstimado, valorTotal, dadosCompletos)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function salvarLicitacao(lic) {
  stmtInsertLic.run(
    lic.numeroControlePNCP, lic.orgaoEntidade?.cnpj, lic.orgaoEntidade?.razaoSocial,
    lic.unidadeOrgao?.ufSigla, lic.unidadeOrgao?.municipioNome, lic.unidadeOrgao?.nomeUnidade,
    lic.unidadeOrgao?.codigoUnidade, lic.anoCompra, lic.sequencialCompra, lic.numeroCompra,
    lic.processo, lic.modalidadeId, lic.modalidadeNome, lic.objetoCompra,
    lic.informacaoComplementar, lic.valorTotalEstimado, lic.dataPublicacaoPncp,
    lic.dataAberturaProposta, lic.dataEncerramentoProposta, lic.situacaoCompraNome,
    lic.linkSistemaOrigem, lic.usuarioNome, lic.srp ? 1 : 0, JSON.stringify(lic)
  );
}
function salvarItens(ncp, itens) {
  const row = stmtGetLicId.get(ncp);
  if (!row) return;
  stmtDeleteItens.run(ncp);
  for (const it of itens) {
    stmtInsertItem.run(row.id, ncp, it.numeroItem, it.descricao, it.quantidade,
      it.unidadeMedida, it.valorUnitarioEstimado, it.valorTotal, JSON.stringify(it));
  }
}

// Retry-per-page (cópia da lógica do sync principal): cada página tenta até 5x
// antes de desistir, espaçado por 1s. Tolera 429s/timeouts intermitentes.
const MAX_RETRIES_PAGINA = 5;
async function buscarLicitacoesDoDia(dia, modalidade) {
  const resultados = [];
  let pagina = 1;
  const diaAPI = dia.replace(/-/g, '');
  while (pagina <= 200) {
    let sucesso = false, ultimoErro = null, parou = false;
    for (let t = 1; t <= MAX_RETRIES_PAGINA; t++) {
      try {
        const r = await http.get(`${PNCP_API_BASE}/contratacoes/publicacao`, {
          params: { dataInicial: diaAPI, dataFinal: diaAPI, codigoModalidadeContratacao: modalidade, pagina, tamanhoPagina: 50 }
        });
        if (r?.data?.data?.length > 0) {
          resultados.push(...r.data.data);
          sucesso = true;
        } else {
          parou = true; sucesso = true;
        }
        break;
      } catch (e) {
        if (e.response?.status === 400 || e.response?.status === 422) {
          parou = true; sucesso = true; break;
        }
        ultimoErro = e;
        await new Promise(r => setTimeout(r, 1000 * t));  // backoff: 1s, 2s, 3s, 4s, 5s
      }
    }
    if (!sucesso) throw new Error(`pag ${pagina} ${MAX_RETRIES_PAGINA} retries: ${ultimoErro?.message}`);
    pagina++;
    if (parou) break;
    await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
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
      const itens = r.data || [];
      if (itens.length === 0) break;
      todos.push(...itens);
      if (itens.length < 100) break;
      pagina++;
      await new Promise(r => setTimeout(r, 100));
    } catch (e) { break; }
  }
  return todos;
}

(async () => {
  const t0 = Date.now();
  const pendentes = stmtPick.all(MAX_TENTATIVAS, MAX_BATCH);
  console.log(`[retry-aborts] processando ${pendentes.length} (dia, modalidade) pendentes (de ${db.prepare("SELECT COUNT(*) c FROM bi_aborts WHERE resolvidoEm IS NULL").get().c} total)`);

  let resolvidos = 0, falharam = 0, licInseridas = 0, itensInseridos = 0;
  for (const p of pendentes) {
    try {
      const licitacoes = await buscarLicitacoesDoDia(p.dia, p.modalidade);
      // Sucesso: persiste e marca resolvido
      const tx = db.transaction(() => {
        for (const lic of licitacoes) { salvarLicitacao(lic); licInseridas++; }
      });
      tx();
      // Itens das licitações que ainda não têm itens
      for (const lic of licitacoes) {
        const ja = db.prepare('SELECT COUNT(*) c FROM itens WHERE numeroControlePNCP = ?').get(lic.numeroControlePNCP);
        if (ja.c === 0) {
          const itens = await buscarItens(lic.orgaoEntidade?.cnpj, lic.anoCompra, lic.sequencialCompra);
          if (itens.length > 0) { salvarItens(lic.numeroControlePNCP, itens); itensInseridos += itens.length; }
        }
      }
      stmtMarcarResolvido.run(p.id);
      resolvidos++;
    } catch (e) {
      stmtIncrementar.run(`retry ${p.tentativasRetry + 1}: ${e.message?.substring(0, 80)}`, p.id);
      falharam++;
    }
  }
  const restantes = db.prepare("SELECT COUNT(*) c FROM bi_aborts WHERE resolvidoEm IS NULL").get().c;
  console.log(`[retry-aborts] ${resolvidos} resolvidos, ${falharam} falharam | +${licInseridas} licitações, +${itensInseridos} itens em ${((Date.now()-t0)/1000).toFixed(0)}s | ${restantes} pendentes restantes`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
