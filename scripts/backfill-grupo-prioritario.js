#!/usr/bin/env node
// One-off: consulta resultados PNCP só para itens aprovados pela IA de um grupo
// que ainda estão "não consultado" (sem linha em resultados_bi) e já encerrados.
// Replica fielmente fetch+insert de resultados-backfill.js. Não toca no motor.
//   Uso:  CATALOG_BACKEND_PG=1 node scripts/backfill-grupo-prioritario.js grupo_14
const ax = require('axios');
const catalogPg = require('../catalog-pg');

const PNCP_API = 'https://pncp.gov.br/api/pncp/v1';
const ITEM_DELAY_MS = 80;
const escopo = process.argv[2] || 'grupo_14';

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

const SELECT_ALVO = `
  SELECT l."cnpj" AS cnpj, l."anoCompra" AS ano, l."sequencialCompra" AS sequencial, i."numeroItem" AS "numeroItem"
    FROM bi_item_classificacao_ia c
    JOIN itens i ON i."id" = c."itemId"
    JOIN licitacoes l ON l."id" = i."licitacaoId"
   WHERE c."escopo" = $1 AND c."ehAprovado" = 1
     AND l."dataEncerramentoProposta" < now()
     AND NOT EXISTS (
       SELECT 1 FROM resultados_bi rb
        WHERE rb."cnpj" = l."cnpj" AND rb."ano" = l."anoCompra"
          AND rb."sequencial" = l."sequencialCompra" AND rb."numeroItem" = i."numeroItem"
     )
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function processar(item) {
  const url = `${PNCP_API}/orgaos/${item.cnpj}/compras/${item.ano}/${item.sequencial}/itens/${item.numeroItem}/resultados`;
  try {
    const resp = await ax.get(url, { headers: { Accept: 'application/json' }, timeout: 10000 });
    const resData = resp.data || [];
    if (Array.isArray(resData) && resData.length > 0) {
      for (const r of resData) {
        await catalogPg.execute(PG_INSERT_RESULTADO, [
          item.cnpj, item.ano, item.sequencial, item.numeroItem,
          r.niFornecedor || '', r.nomeRazaoSocialFornecedor || '',
          r.valorUnitarioHomologado || null, r.valorTotalHomologado || null,
          r.marcaFabricante || r.marca || '', r.modeloVersao || '',
          r.dataResultado || null, JSON.stringify(r),
        ]);
      }
      return 'homologado';
    }
    await catalogPg.execute(PG_INSERT_SEM_RESULTADO, [item.cnpj, item.ano, item.sequencial, item.numeroItem]);
    return 'sem_resultado';
  } catch (err) {
    if (err.response?.status === 404) {
      await catalogPg.execute(PG_INSERT_SEM_RESULTADO, [item.cnpj, item.ano, item.sequencial, item.numeroItem]);
      return 'sem_resultado(404)';
    }
    console.error(`  erro ${item.cnpj}/${item.ano}/${item.sequencial}/${item.numeroItem}: ${err.message}`);
    return 'erro';
  }
}

(async () => {
  const itens = await catalogPg.query(SELECT_ALVO, [escopo]);
  console.log(`[prio] ${escopo}: ${itens.length} itens aprovados+não-consultados+encerrados`);
  const tally = {};
  for (let n = 0; n < itens.length; n++) {
    const r = await processar(itens[n]);
    tally[r] = (tally[r] || 0) + 1;
    await sleep(ITEM_DELAY_MS);
  }
  console.log('[prio] concluído:', JSON.stringify(tally));
  process.exit(0);
})();
