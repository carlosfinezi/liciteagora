// regen-sugestoes-terramaster.cjs — limpa e regenera as sugestões TerraMaster
// do grupo 14 (1bit) com o motor novo (specs reais + validação). One-off.
// Reusa as MESMAS funções do endpoint (terramaster-catalog) — sem duplicar prompt.
// Uso: CATALOG_BACKEND_PG=1 node regen-sugestoes-terramaster.cjs
const path = require('path');
const Database = require('better-sqlite3');
const catalogPg = require('./catalog-pg');
const { chamarDeepSeek } = require('./analise-ia');
const { createConfigHelpers } = require('./config-helpers');
const { montarPromptSugestao, validarSugestoes, TERRAMASTER_SEED } = require('./terramaster-catalog');

const TENANT = '1bit', GRUPO = 14, MARCA = 'TerraMaster', BATCH = 8, MAX_TOKENS = 2200;

(async () => {
  const db = new Database(path.join(__dirname, 'data', 'tenants', TENANT, 'pncp.db'), { readonly: true, fileMustExist: true });
  const keys = createConfigHelpers(db).getIAKeys();
  if (!keys || !keys.deepseek) { console.error('sem chave DeepSeek'); process.exit(1); }

  // 1) limpa TODAS as sugestões TerraMaster (só existem p/ o grupo NAS do 1bit)
  const del = await catalogPg.execute(`DELETE FROM bi_item_sugestao_produto WHERE lower(marca)='terramaster'`);
  console.log(`[regen] limpas ${del.rowCount} sugestões antigas`);

  // 2) universo: itens IA-aprovados no grupo 14, na membership, encerrados, sem sugestão
  const itens = await catalogPg.query(`
    SELECT i."id" AS "itemId", i."descricao" AS descricao
      FROM itens i
      JOIN licitacoes l ON i."licitacaoId"=l."id"
      JOIN bi_item_classificacao_ia c ON c."itemId"=i."id" AND c."escopo"=$1 AND c."ehAprovado"=1
     WHERE i."id" IN (SELECT "itemId" FROM bi_grupo_item WHERE tenant=$2 AND "grupoId"=$3)
       AND l."dataEncerramentoProposta" < now()
     ORDER BY l."dataPublicacaoPncp" DESC
  `, [`grupo_${GRUPO}`, TENANT, GRUPO]);
  console.log(`[regen] ${itens.length} itens a regenerar (${Math.ceil(itens.length/BATCH)} lotes)`);

  let proc = 0, comMatch = 0, semMatch = 0, descartados = 0, erros = 0;
  for (let i = 0; i < itens.length; i += BATCH) {
    const batch = itens.slice(i, i + BATCH);
    let sugestoes;
    try {
      const prompt = montarPromptSugestao(batch, TERRAMASTER_SEED);
      const resp = await chamarDeepSeek(keys.deepseek, prompt, 1, { max_tokens: MAX_TOKENS });
      sugestoes = (resp && Array.isArray(resp.sugestoes)) ? validarSugestoes(resp.sugestoes, TERRAMASTER_SEED) : null;
    } catch (e) { console.error(`  lote ${i/BATCH|0} erro:`, e.message); erros++; continue; }
    if (!sugestoes) { erros++; continue; }

    await catalogPg.withTx(async (client) => {
      for (const s of sugestoes) {
        const idx = (s.indice || 0) - 1;
        if (idx < 0 || idx >= batch.length) continue;
        const modelo = String(s.modelo_sugerido || 'nenhum').substring(0, 60);
        const score = parseInt(s.score, 10) || 0;
        if (/\[código fora do catálogo/.test(String(s.motivo || ''))) descartados++;
        await client.query(
          `INSERT INTO bi_item_sugestao_produto ("itemId","marca","modelo_sugerido","score","requisitos","motivo","modelo_ia","classificadoEm")
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,'deepseek-chat',now())
           ON CONFLICT ("itemId","marca") DO UPDATE SET
             "modelo_sugerido"=EXCLUDED."modelo_sugerido","score"=EXCLUDED."score",
             "requisitos"=EXCLUDED."requisitos","motivo"=EXCLUDED."motivo","classificadoEm"=now()`,
          [batch[idx].itemId, MARCA, modelo, score, JSON.stringify(String(s.requisitos || '').substring(0, 300)), String(s.motivo || '').substring(0, 400)]
        );
        if (modelo.toLowerCase() !== 'nenhum' && score >= 50) comMatch++; else semMatch++;
        proc++;
      }
    });
    if ((i / BATCH) % 5 === 0) console.log(`[regen] ${proc}/${itens.length}…`);
  }

  console.log(`[regen] CONCLUÍDO: ${proc} processados | ${comMatch} com match | ${semMatch} nenhum/baixo | ${descartados} códigos descartados pela validação | ${erros} lotes c/ erro`);
  db.close();
  await catalogPg.close();
})().catch(e => { console.error('[regen] fatal:', e); process.exit(1); });
