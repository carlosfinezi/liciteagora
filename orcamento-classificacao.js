/**
 * orcamento-classificacao.js — liga os títulos de contas a pagar/receber ao
 * plano de contas gerencial, que é o que faz o orçamento ter realizado.
 *
 * O problema que isto resolve: o previsto × realizado só soma título que tem
 * planoContaId. Sem classificação, o relatório mostra "realizado R$ 0" para
 * quem movimentou dezenas de milhares — e não avisa que está omitindo.
 *
 * A herança é feita por TRIGGER, não por código em cada rota. Título nasce em
 * muitos lugares (faturamento, OS, devolução, importação de NF-e, cadastro
 * manual, recorrência); replicar a regra em cada INSERT garante que um deles
 * vai ficar de fora. A regra é um invariante do dado, então mora no banco.
 */

const LADOS = {
  receber: { titulos: 'contas_a_receber', categorias: 'categorias_cr',
             pagamentos: 'contas_receber_pagamentos', fk: 'contaReceberId', sinal: 'entrada' },
  pagar:   { titulos: 'contas_a_pagar', categorias: 'categorias_cp',
             pagamentos: 'contas_pagar_pagamentos', fk: 'contaPagarId', sinal: 'saida' },
};

function migrarClassificacaoDB(db) {
  for (const [lado, L] of Object.entries(LADOS)) {
    try {
      // O trigger só age quando o título não trouxe classificação própria:
      // escolha explícita do usuário nunca é sobrescrita.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_${lado}_plano_da_categoria
        AFTER INSERT ON ${L.titulos}
        WHEN NEW.planoContaId IS NULL AND NEW.categoriaId IS NOT NULL
        BEGIN
          UPDATE ${L.titulos}
             SET planoContaId = (SELECT planoContaId FROM ${L.categorias} WHERE id = NEW.categoriaId)
           WHERE id = NEW.id;
        END;`);
      // Mudar a conta da categoria não pode deixar o histórico órfão, mas
      // também não deve reescrever título já classificado à mão.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_${lado}_categoria_atualizada
        AFTER UPDATE OF planoContaId ON ${L.categorias}
        WHEN NEW.planoContaId IS NOT NULL
        BEGIN
          UPDATE ${L.titulos}
             SET planoContaId = NEW.planoContaId
           WHERE categoriaId = NEW.id AND planoContaId IS NULL;
        END;`);
    } catch (e) {
      if (!/no such table/i.test(e.message)) throw e;
    }
  }
}

/** Aplica a herança no que já existe. Idempotente. */
function classificarPendentes(db) {
  const out = {};
  for (const [lado, L] of Object.entries(LADOS)) {
    try {
      const r = db.prepare(`UPDATE ${L.titulos}
        SET planoContaId = (SELECT planoContaId FROM ${L.categorias} WHERE id = ${L.titulos}.categoriaId)
        WHERE planoContaId IS NULL AND categoriaId IS NOT NULL
          AND (SELECT planoContaId FROM ${L.categorias} WHERE id = ${L.titulos}.categoriaId) IS NOT NULL`).run();
      out[lado] = r.changes;
    } catch { out[lado] = 0; }
  }
  return out;
}

/**
 * O dinheiro que o previsto × realizado está deixando de fora.
 * Sem este número o relatório mente por omissão: mostra realizado zerado e o
 * usuário conclui que não houve movimento.
 */
function semClassificacao(db, ano) {
  const out = {};
  for (const [lado, L] of Object.entries(LADOS)) {
    try {
      const pago = db.prepare(`SELECT COALESCE(SUM(p.valorPago),0) valor, COUNT(DISTINCT c.id) titulos
        FROM ${L.pagamentos} p JOIN ${L.titulos} c ON c.id = p.${L.fk}
        WHERE p.estornado = 0 AND c.planoContaId IS NULL AND p.dataPagamento LIKE ?`).get(ano + '-%');
      // Quem tem categoria mas a categoria não tem conta: resolve-se num lugar
      // só (a categoria), não título a título.
      const porCategoria = db.prepare(`SELECT cat.id, cat.nome, COUNT(*) titulos,
          COALESCE(SUM(c.valor),0) valor
        FROM ${L.titulos} c JOIN ${L.categorias} cat ON cat.id = c.categoriaId
        WHERE c.planoContaId IS NULL AND cat.planoContaId IS NULL
        GROUP BY cat.id ORDER BY valor DESC LIMIT 20`).all();
      const semCategoria = db.prepare(`SELECT COUNT(*) titulos, COALESCE(SUM(valor),0) valor
        FROM ${L.titulos} WHERE planoContaId IS NULL AND categoriaId IS NULL`).get();
      out[lado] = {
        valorPago: Number((pago.valor || 0).toFixed(2)),
        titulosPagos: pago.titulos || 0,
        categoriasSemConta: porCategoria,
        semCategoria: { titulos: semCategoria.titulos || 0, valor: Number((semCategoria.valor || 0).toFixed(2)) },
      };
    } catch {
      out[lado] = { valorPago: 0, titulosPagos: 0, categoriasSemConta: [], semCategoria: { titulos: 0, valor: 0 } };
    }
  }
  return out;
}

/**
 * Títulos abertos no período: já comprometido, ainda não pago.
 * Orçamento que só olha o pago descobre o estouro depois que ele aconteceu.
 */
function aRealizar(db, ano) {
  const linhas = [];
  for (const [lado, L] of Object.entries(LADOS)) {
    try {
      const rows = db.prepare(`SELECT c.planoContaId, substr(c.dataVencimento,1,7) competencia,
          COALESCE(SUM(c.valor - COALESCE(c.valorPago,0)),0) valor, COUNT(*) titulos
        FROM ${L.titulos} c
        WHERE c.status IN ('aberta','parcial') AND c.planoContaId IS NOT NULL
          AND c.dataVencimento LIKE ?
        GROUP BY c.planoContaId, competencia`).all(ano + '-%');
      for (const r of rows) linhas.push({ ...r, lado, sinal: L.sinal });
    } catch { /* tenant sem a tabela */ }
  }
  return linhas;
}

module.exports = { LADOS, migrarClassificacaoDB, classificarPendentes, semClassificacao, aRealizar };
