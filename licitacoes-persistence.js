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
// Factory prepara os statements uma única vez por processo; chame no
// bootstrap após abrir o DB.

function createPersistence(db) {
  const insertLicitacao = db.prepare(`
    INSERT OR REPLACE INTO licitacoes (
      numeroControlePNCP, cnpj, razaoSocial, ufSigla, municipioNome, nomeUnidade, codigoUnidade,
      anoCompra, sequencialCompra, numeroCompra, processo, modalidadeId, modalidadeNome,
      objetoCompra, informacaoComplementar, valorTotalEstimado, dataPublicacaoPncp,
      dataAberturaProposta, dataEncerramentoProposta, situacaoCompraNome, linkSistemaOrigem,
      usuarioNome, srp, dadosCompletos, dataAtualizacao
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const insertItem = db.prepare(`
    INSERT OR REPLACE INTO itens (
      licitacaoId, numeroControlePNCP, numeroItem, descricao, quantidade,
      unidadeMedida, valorUnitarioEstimado, valorTotal, dadosCompletos
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getLicitacaoId = db.prepare(`SELECT id FROM licitacoes WHERE numeroControlePNCP = ?`);
  const deleteItens = db.prepare(`DELETE FROM itens WHERE numeroControlePNCP = ?`);

  function salvarLicitacao(licitacao) {
    try {
      insertLicitacao.run(
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
      const licitacaoRow = getLicitacaoId.get(numeroControlePNCP);
      if (!licitacaoRow) return false;

      deleteItens.run(numeroControlePNCP);

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

module.exports = { createPersistence };
