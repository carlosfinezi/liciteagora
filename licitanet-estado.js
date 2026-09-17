// licitanet-estado.js
//
// Registro de tentativas do coletor de marca do Licitanet.
//
// ─── O BUG QUE ISTO CONSERTA (medido 08/09/2026) ────────────────────────────
//
// O coletor rodava 24h por dia e não produzia nada: **1.249 coletas sobre 19
// licitações distintas**, a campeã processada **323 vezes**, 1.227 delas
// gravando zero. 287 reinícios de serviço, um ciclo de 30 min cada.
//
// Duas causas somadas:
//
//  1. **Não havia registro de tentativa nenhum.** Nada excluía o que já tinha
//     sido coletado — ao contrário de BLL/BNC/PCP, que têm `marca_portal_backfill`.
//  2. **O predicado nunca ficava falso.** `/pendentes` selecionava por
//     `marca vazia OR modelo vazio`, e a ata do Licitanet quase nunca traz
//     MODELO. Então, mesmo depois de gravar a marca com sucesso, a licitação
//     continuava "pendente" e voltava para a fila no ciclo seguinte, para
//     sempre. Conferido no banco: 11040870000100/2026/51 tem 188 das 197 linhas
//     com marca e mesmo assim foi coletada 289 vezes.
//
// Corrigir só (2) não bastaria: sem (1), qualquer licitação cuja ata não tenha
// nada a acrescentar volta ao laço. O registro é o que garante progresso.

'use strict';

const catalogPg = require('./catalog-pg');

// Quantas vezes insistir quando a coleta FALHA (rede, 429, ata ilegível).
// Desfecho normal — gravou ou não havia o que gravar — não repete nunca.
const MAX_TENTATIVAS = 3;

async function migrar() {
  await catalogPg.execute(`
    CREATE TABLE IF NOT EXISTS marca_licitanet_backfill (
      cnpj            text    NOT NULL,
      ano             integer NOT NULL,
      sequencial      integer NOT NULL,
      status          text    NOT NULL,
      "itensGravados" integer DEFAULT 0,
      "itensAta"      integer DEFAULT 0,
      tentativas      integer DEFAULT 0,
      erro            text,
      "dataCache"     timestamptz DEFAULT now(),
      PRIMARY KEY (cnpj, ano, sequencial)
    )`);
}

/**
 * Grava o desfecho de uma tentativa.
 *
 * status:
 *   ok           — gravou pelo menos uma marca/modelo
 *   sem_novidade — a ata foi lida e não havia nada a acrescentar (já estava
 *                  preenchido, ou a ata não declara marca). NÃO é erro, e
 *                  reprocessar não muda nada.
 *   erro         — não deu para ler a ata; conta tentativa e volta à fila
 */
async function registrar(cnpj, ano, sequencial, { gravados = 0, itensAta = 0, erro = null } = {}) {
  await migrar();
  const status = erro ? 'erro' : (gravados > 0 ? 'ok' : 'sem_novidade');
  await catalogPg.execute(`
    INSERT INTO marca_licitanet_backfill
      (cnpj, ano, sequencial, status, "itensGravados", "itensAta", tentativas, erro, "dataCache")
    VALUES ($1,$2,$3,$4,$5,$6,1,$7,now())
    ON CONFLICT (cnpj, ano, sequencial) DO UPDATE SET
      status = EXCLUDED.status,
      "itensGravados" = marca_licitanet_backfill."itensGravados" + EXCLUDED."itensGravados",
      "itensAta" = EXCLUDED."itensAta",
      tentativas = marca_licitanet_backfill.tentativas + 1,
      erro = EXCLUDED.erro,
      "dataCache" = now()`,
    [String(cnpj), Number(ano), Number(sequencial), status, gravados, itensAta,
     erro ? String(erro).slice(0, 400) : null]);
  return status;
}

// Cláusula SQL que exclui o que já foi resolvido — usada por /pendentes.
// Começa com AND de propósito: é concatenada ao fim de uma lista de WHERE.
const SQL_NAO_PROCESSADA = `
  AND NOT EXISTS (
    SELECT 1 FROM marca_licitanet_backfill b
     WHERE b.cnpj = l."cnpj" AND b.ano = l."anoCompra" AND b.sequencial = l."sequencialCompra"
       AND (b.status IN ('ok','sem_novidade') OR b.tentativas >= ${MAX_TENTATIVAS})
  )`;

async function estatisticas() {
  await migrar();
  return await catalogPg.query(
    `SELECT status, count(*)::int licitacoes, sum("itensGravados")::int marcas,
            max("dataCache") ultima
       FROM marca_licitanet_backfill GROUP BY status ORDER BY 2 DESC`);
}

module.exports = { migrar, registrar, estatisticas, SQL_NAO_PROCESSADA, MAX_TENTATIVAS };

if (require.main === module) {
  (async () => { console.table(await estatisticas()); process.exit(0); })()
    .catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
