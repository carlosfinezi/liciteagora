// licitacoes-persistence.js
//
// Persistência de licitacoes e itens do PNCP. Extraído de server.js em
// NFSE-M06 onda 5C para desacoplar o motor PNCP (que vai para
// pncp-sync-scheduler.js) das rotas HTTP e do verificador de lacunas,
// evitando duplicação e dependência circular.
//
// Uso:
//   const { createPersistence } = require('./licitacoes-persistence');
//   const { salvarLicitacao, salvarItens } = createPersistence(db);
//
// Multi-tenant (2026-04-22): os statements passaram a ser preparados
// lazily via stmt-cache — o `db` recebido pode ser um Proxy que resolve
// para bancos diferentes por request. Single-tenant continua idêntico:
// primeira chamada prepara, chamadas seguintes reusam via WeakMap.

const { createStmtCache } = require('./stmt-cache');
// Fase 3c (2026-05-23): adapter Postgres pro catalog
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

const SQL_INSERT_LICITACAO = `
  INSERT OR REPLACE INTO licitacoes (
    numeroControlePNCP, cnpj, razaoSocial, ufSigla, municipioNome, nomeUnidade, codigoUnidade,
    anoCompra, sequencialCompra, numeroCompra, processo, modalidadeId, modalidadeNome,
    objetoCompra, informacaoComplementar, valorTotalEstimado, dataPublicacaoPncp,
    dataAberturaProposta, dataEncerramentoProposta, situacaoCompraNome, linkSistemaOrigem,
    usuarioNome, srp, dadosCompletos, dataAtualizacao
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`;

const SQL_INSERT_ITEM = `
  INSERT OR REPLACE INTO itens (
    licitacaoId, numeroControlePNCP, numeroItem, descricao, quantidade,
    unidadeMedida, valorUnitarioEstimado, valorTotal, dadosCompletos
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SQL_GET_LICITACAO_ID = 'SELECT id FROM licitacoes WHERE numeroControlePNCP = ?';
const SQL_DELETE_ITENS = 'DELETE FROM itens WHERE numeroControlePNCP = ?';

// ===== Postgres versions (Fase 3c — 2026-05-23) =====
// SQL Postgres equivalente. INSERT OR REPLACE → ON CONFLICT ... DO UPDATE.
// `numeroControlePNCP` é UNIQUE — usamos como chave de upsert.

const PG_SQL_INSERT_LICITACAO = `
  INSERT INTO licitacoes (
    "numeroControlePNCP", "cnpj", "razaoSocial", "ufSigla", "municipioNome", "nomeUnidade", "codigoUnidade",
    "anoCompra", "sequencialCompra", "numeroCompra", "processo", "modalidadeId", "modalidadeNome",
    "objetoCompra", "informacaoComplementar", "valorTotalEstimado", "dataPublicacaoPncp",
    "dataAberturaProposta", "dataEncerramentoProposta", "situacaoCompraNome", "linkSistemaOrigem",
    "usuarioNome", "srp", "dadosCompletos", "dataAtualizacao"
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb, now())
  ON CONFLICT ("numeroControlePNCP") DO UPDATE SET
    "cnpj"=EXCLUDED."cnpj", "razaoSocial"=EXCLUDED."razaoSocial",
    "ufSigla"=EXCLUDED."ufSigla", "municipioNome"=EXCLUDED."municipioNome",
    "nomeUnidade"=EXCLUDED."nomeUnidade", "codigoUnidade"=EXCLUDED."codigoUnidade",
    "anoCompra"=EXCLUDED."anoCompra", "sequencialCompra"=EXCLUDED."sequencialCompra",
    "numeroCompra"=EXCLUDED."numeroCompra", "processo"=EXCLUDED."processo",
    "modalidadeId"=EXCLUDED."modalidadeId", "modalidadeNome"=EXCLUDED."modalidadeNome",
    "objetoCompra"=EXCLUDED."objetoCompra", "informacaoComplementar"=EXCLUDED."informacaoComplementar",
    "valorTotalEstimado"=EXCLUDED."valorTotalEstimado", "dataPublicacaoPncp"=EXCLUDED."dataPublicacaoPncp",
    "dataAberturaProposta"=EXCLUDED."dataAberturaProposta", "dataEncerramentoProposta"=EXCLUDED."dataEncerramentoProposta",
    "situacaoCompraNome"=EXCLUDED."situacaoCompraNome", "linkSistemaOrigem"=EXCLUDED."linkSistemaOrigem",
    "usuarioNome"=EXCLUDED."usuarioNome", "srp"=EXCLUDED."srp",
    "dadosCompletos"=EXCLUDED."dadosCompletos", "dataAtualizacao"=now()
`;

const PG_SQL_GET_LICITACAO_ID = 'SELECT "id" FROM licitacoes WHERE "numeroControlePNCP" = $1';
const PG_SQL_DELETE_ITENS = 'DELETE FROM itens WHERE "numeroControlePNCP" = $1';
const PG_SQL_INSERT_ITEM = `
  INSERT INTO itens (
    "licitacaoId", "numeroControlePNCP", "numeroItem", "descricao", "quantidade",
    "unidadeMedida", "valorUnitarioEstimado", "valorTotal", "dadosCompletos"
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
`;

// Fix TZ (2026-05-25): datas do PNCP vêm sem timezone (ex: "2026-05-29T14:00:00")
// e representam horário de Brasília. Sem este normalize, o PG/Node interpretam
// como hora LOCAL do servidor (CEST +02), gerando offset de 4-5h. Aqui forçamos
// "-03:00" pra timestamptz armazenar UTC corretamente.
function _normalizarDataBR(s) {
  if (!s || typeof s !== 'string') return s;
  // Já tem timezone? mantém. Senão adiciona Brasília.
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) return s;
  return s + '-03:00';
}

async function salvarLicitacaoPg(licitacao) {
  try {
    await catalogPg.execute(PG_SQL_INSERT_LICITACAO, [
      licitacao.numeroControlePNCP,
      licitacao.orgaoEntidade?.cnpj,
      licitacao.orgaoEntidade?.razaoSocial,
      licitacao.unidadeOrgao?.ufSigla,
      licitacao.unidadeOrgao?.municipioNome,
      licitacao.unidadeOrgao?.nomeUnidade,
      licitacao.unidadeOrgao?.codigoUnidade,
      licitacao.anoCompra,
      licitacao.sequencialCompra,
      licitacao.numeroCompra,
      licitacao.processo,
      licitacao.modalidadeId,
      licitacao.modalidadeNome,
      licitacao.objetoCompra,
      licitacao.informacaoComplementar,
      licitacao.valorTotalEstimado,
      _normalizarDataBR(licitacao.dataPublicacaoPncp),
      _normalizarDataBR(licitacao.dataAberturaProposta),
      _normalizarDataBR(licitacao.dataEncerramentoProposta),
      licitacao.situacaoCompraNome,
      licitacao.linkSistemaOrigem,
      licitacao.usuarioNome,
      licitacao.srp ? 1 : 0,
      JSON.stringify(licitacao),
    ]);
    return true;
  } catch (err) {
    console.error('[PG] Erro ao salvar licitação:', err.message);
    return false;
  }
}

async function salvarItensPg(numeroControlePNCP, itens) {
  try {
    const row = await catalogPg.queryOne(PG_SQL_GET_LICITACAO_ID, [numeroControlePNCP]);
    if (!row) return false;
    const licitacaoId = row.id;

    // Transação: delete + N inserts atômicos
    await catalogPg.withTx(async (client) => {
      await client.query(PG_SQL_DELETE_ITENS, [numeroControlePNCP]);
      for (const item of itens) {
        await client.query(PG_SQL_INSERT_ITEM, [
          licitacaoId,
          numeroControlePNCP,
          item.numeroItem,
          item.descricao,
          item.quantidade,
          item.unidadeMedida,
          item.valorUnitarioEstimado,
          item.valorTotal,
          JSON.stringify(item),
        ]);
      }
    });
    return true;
  } catch (err) {
    console.error('[PG] Erro ao salvar itens:', err.message);
    return false;
  }
}

function createPersistence(db) {
  const stmt = createStmtCache();

  function salvarLicitacao(licitacao) {
    try {
      stmt(db, SQL_INSERT_LICITACAO).run(
        licitacao.numeroControlePNCP,
        licitacao.orgaoEntidade?.cnpj,
        licitacao.orgaoEntidade?.razaoSocial,
        licitacao.unidadeOrgao?.ufSigla,
        licitacao.unidadeOrgao?.municipioNome,
        licitacao.unidadeOrgao?.nomeUnidade,
        licitacao.unidadeOrgao?.codigoUnidade,
        licitacao.anoCompra,
        licitacao.sequencialCompra,
        licitacao.numeroCompra,
        licitacao.processo,
        licitacao.modalidadeId,
        licitacao.modalidadeNome,
        licitacao.objetoCompra,
        licitacao.informacaoComplementar,
        licitacao.valorTotalEstimado,
        licitacao.dataPublicacaoPncp,
        licitacao.dataAberturaProposta,
        licitacao.dataEncerramentoProposta,
        licitacao.situacaoCompraNome,
        licitacao.linkSistemaOrigem,
        licitacao.usuarioNome,
        licitacao.srp ? 1 : 0,
        JSON.stringify(licitacao)
      );
      return true;
    } catch (err) {
      console.error('Erro ao salvar licitação:', err.message);
      return false;
    }
  }

  function salvarItens(numeroControlePNCP, itens) {
    try {
      const licitacaoRow = stmt(db, SQL_GET_LICITACAO_ID).get(numeroControlePNCP);
      if (!licitacaoRow) return false;

      stmt(db, SQL_DELETE_ITENS).run(numeroControlePNCP);

      const insertItem = stmt(db, SQL_INSERT_ITEM);
      for (const item of itens) {
        insertItem.run(
          licitacaoRow.id,
          numeroControlePNCP,
          item.numeroItem,
          item.descricao,
          item.quantidade,
          item.unidadeMedida,
          item.valorUnitarioEstimado,
          item.valorTotal,
          JSON.stringify(item)
        );
      }
      return true;
    } catch (err) {
      console.error('Erro ao salvar itens:', err.message);
      return false;
    }
  }

  return { salvarLicitacao, salvarItens };
}

module.exports = { createPersistence, salvarLicitacaoPg, salvarItensPg, USE_PG };
