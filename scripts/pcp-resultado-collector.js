#!/usr/bin/env node
// Coletor de resultado de origem — Portal de Compras Públicas (PCP).
// Fonte: API pública compras.api.portaldecompraspublicas.com.br (sem auth).
// Hoje extrai por item: situacao (Homologado/Fracassado/Deserto/...), melhorLance
// (preço vencedor), valorReferencia. CNPJ do vencedor + marca NÃO vêm na API
// pública (ata PDF / endpoint logado) — deferido.
//
// Matching: numeroItem (PNCP) == codigo (PCP); pagina = ceil(numeroItem/12).
// licitacaoId PCP = último segmento numérico de licitacoes.linkSistemaOrigem.
//
// Modo validação (dry-run, NÃO grava no banco):
//   CATALOG_BACKEND_PG=1 node scripts/pcp-resultado-collector.js --validar grupo_14
const ax = require('axios');

const API = 'https://compras.api.portaldecompraspublicas.com.br';
const PAGE_SIZE = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Extrai o codigoLicitacao do PCP a partir do linkSistemaOrigem do PNCP.
// Ex.: .../RPE-005-2025-2025-365703 -> 365703
function parseLicitacaoId(linkSistemaOrigem) {
  if (!linkSistemaOrigem) return null;
  const m = String(linkSistemaOrigem).match(/-(\d+)\/?$/) || String(linkSistemaOrigem).match(/(\d+)\/?$/);
  return m ? m[1] : null;
}

// Busca o resultado de um item específico. Retorna null se não encontrar.
async function fetchResultadoItem(licId, numeroItem) {
  const pagina = Math.ceil(numeroItem / PAGE_SIZE);
  const url = `${API}/v2/licitacao/${licId}/itens?pagina=${pagina}`;
  const resp = await ax.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
  const result = resp.data && resp.data.itens && resp.data.itens.result;
  if (!Array.isArray(result)) return null;
  const it = result.find((r) => r.codigo === numeroItem);
  if (!it) return null;
  return {
    situacao: it.situacao && it.situacao.descricao,
    melhorLance: it.melhorLance,
    valorReferencia: it.valorReferencia,
    descricao: it.descricao,
  };
}

// ---- modo validação ----
async function validar(escopo) {
  const catalogPg = require('../catalog-pg');
  const rows = await catalogPg.query(`
    WITH aprovados AS (SELECT "itemId" FROM bi_item_classificacao_ia WHERE escopo=$1 AND "ehAprovado"=1)
    SELECT l."anoCompra" AS ano, l."sequencialCompra" AS seq, i."numeroItem" AS num,
           l."linkSistemaOrigem" AS link, left(i.descricao,60) AS desc_pncp
    FROM aprovados a JOIN itens i ON i.id=a."itemId" JOIN licitacoes l ON l.id=i."licitacaoId"
    JOIN resultados_bi rb ON rb.cnpj=l.cnpj AND rb.ano=l."anoCompra" AND rb.sequencial=l."sequencialCompra" AND rb."numeroItem"=i."numeroItem"
    WHERE rb."niFornecedor"='__sem_resultado__' AND l."linkSistemaOrigem" ILIKE '%portaldecompraspublicas%'
    ORDER BY l."anoCompra" DESC, l."sequencialCompra"`, [escopo]);

  console.log(`[pcp-validar] ${escopo}: ${rows.length} itens órfãos PCP\n`);
  const tally = {};
  let comPreco = 0;
  for (const r of rows) {
    const licId = parseLicitacaoId(r.link);
    let out;
    try {
      const res = licId ? await fetchResultadoItem(licId, r.num) : null;
      if (!res) { out = 'NAO_ENCONTRADO'; }
      else {
        out = res.situacao || '(sem situacao)';
        if (res.melhorLance != null) comPreco++;
        console.log(`  lic ${licId} item ${r.num}: ${out}` +
          (res.melhorLance != null ? ` | R$ ${res.melhorLance}` : '') +
          ` | ref R$ ${res.valorReferencia} | ${r.desc_pncp}`);
      }
    } catch (e) {
      out = `ERRO(${e.response ? e.response.status : e.code || e.message})`;
    }
    tally[out] = (tally[out] || 0) + 1;
    await sleep(120);
  }
  console.log(`\n[pcp-validar] situações:`, JSON.stringify(tally));
  console.log(`[pcp-validar] itens com preço vencedor capturado: ${comPreco}/${rows.length}`);
  process.exit(0);
}

// Classificação de status do PCP em finalidade.
const FINAL_COM_PRECO = new Set(['homologado', 'adjudicado']);
const FINAL_SEM_VENCEDOR = new Set(['fracassado', 'deserto', 'anulada', 'anulado', 'revogada', 'revogado', 'cancelado', 'cancelada']);
function classificar(situacao) {
  const s = String(situacao || '').trim().toLowerCase();
  if (FINAL_COM_PRECO.has(s)) return 'final_com_preco';
  if (FINAL_SEM_VENCEDOR.has(s)) return 'final_sem_vencedor';
  return 'em_andamento'; // Análise de documentos, Fechado, Fornecedor Habilitado, etc → não congelar
}

// ---- modo aplicar (grava em resultados_bi) ----
// Atualiza a linha marcador (__sem_resultado__) do item com os dados do PCP.
// Só persiste status FINAIS; em-andamento é pulado (será rechecado pelo ciclo).
async function aplicar(escopo) {
  const catalogPg = require('../catalog-pg');
  const rows = await catalogPg.query(`
    WITH aprovados AS (SELECT "itemId" FROM bi_item_classificacao_ia WHERE escopo=$1 AND "ehAprovado"=1)
    SELECT l.cnpj, l."anoCompra" AS ano, l."sequencialCompra" AS seq, i."numeroItem" AS num, l."linkSistemaOrigem" AS link
    FROM aprovados a JOIN itens i ON i.id=a."itemId" JOIN licitacoes l ON l.id=i."licitacaoId"
    JOIN resultados_bi rb ON rb.cnpj=l.cnpj AND rb.ano=l."anoCompra" AND rb.sequencial=l."sequencialCompra" AND rb."numeroItem"=i."numeroItem"
    WHERE rb."niFornecedor"='__sem_resultado__' AND l."linkSistemaOrigem" ILIKE '%portaldecompraspublicas%'`, [escopo]);

  console.log(`[pcp-aplicar] ${escopo}: ${rows.length} órfãos PCP\n`);
  const tally = {};
  for (const r of rows) {
    const licId = parseLicitacaoId(r.link);
    try {
      const res = licId ? await fetchResultadoItem(licId, r.num) : null;
      if (!res) { tally.nao_encontrado = (tally.nao_encontrado || 0) + 1; await sleep(120); continue; }
      const cls = classificar(res.situacao);
      if (cls === 'em_andamento') { tally['pulado_em_andamento'] = (tally['pulado_em_andamento'] || 0) + 1; await sleep(120); continue; }
      const preco = cls === 'final_com_preco' ? (res.melhorLance != null ? res.melhorLance : null) : null;
      await catalogPg.execute(`
        UPDATE resultados_bi
           SET "fonte"='PCP', "situacaoOrigem"=$5, "valorUnitarioHomologado"=$6, "dataCache"=now()
         WHERE cnpj=$1 AND ano=$2 AND sequencial=$3 AND "numeroItem"=$4 AND "niFornecedor"='__sem_resultado__'`,
        [r.cnpj, r.ano, r.seq, r.num, res.situacao, preco]);
      tally[res.situacao] = (tally[res.situacao] || 0) + 1;
    } catch (e) {
      tally[`erro`] = (tally['erro'] || 0) + 1;
    }
    await sleep(120);
  }
  console.log('[pcp-aplicar] gravados por status:', JSON.stringify(tally));
  process.exit(0);
}

module.exports = { parseLicitacaoId, fetchResultadoItem, classificar };

if (require.main === module) {
  const [flag, escopo] = process.argv.slice(2);
  if (flag === '--validar') validar(escopo || 'grupo_14');
  else if (flag === '--aplicar') aplicar(escopo || 'grupo_14');
  else { console.error('uso: node scripts/pcp-resultado-collector.js --validar|--aplicar <escopo>'); process.exit(1); }
}
