/**
 * peca.js — tipo de peça e ficha técnica (F1.1 e F1.2).
 *
 * Duas responsabilidades que andam juntas: o que a peça É (modo, cura, volume,
 * fck) e do que ela é FEITA (ficha com perda).
 *
 * ─── A REGRA CENTRAL DO MÓDULO ──────────────────────────────────────────────
 * `exigeIdentificacao` é DERIVADO, nunca informado. Vale 1 quando
 * modo='obra' OU cura='pista_protensao'. Ver `derivarExigeIdentificacao`.
 *
 * ─── EXPLOSÃO DE SUB-FICHA ──────────────────────────────────────────────────
 * O insumo pode ser, ele mesmo, uma peça com ficha (armação montada que entra
 * no pilar). A explosão desce nele, com guarda de profundidade e detecção de
 * ciclo — mesma solução do restaurante-ficha.js, e pelo mesmo motivo: uma
 * ficha que contém a si mesma trava o processo inteiro sem isso.
 */

const { num } = require('./prod-util');

/** Aceita 1, '1' e true — o corpo do PUT vem do formulário ou da API. */
function ehVerdadeiro(v) { return v === 1 || v === '1' || v === true; }

const MODOS = ['estoque', 'projeto'];
const GRUPOS_INSUMO = ['concreto', 'aco', 'forma', 'consumivel', 'outro'];

// Cinco níveis cobrem qualquer peça real (peça → armação → estribo → aço);
// além disso é erro de cadastro, não profundidade legítima.
const PROFUNDIDADE_MAX = 5;

/**
 * A regra que não é configurável. Ver o bloco no topo do prod-schema.js.
 *
 * Peça de obra e peça protendida precisam de identidade individual porque é
 * ela que amarra peça ↔ lote de concreto ↔ corpo de prova. Sem esse elo, o
 * ensaio não prova nada sobre a peça que foi para a obra.
 */
function derivarExigeIdentificacao({ modo, exigeEnsaioLiberacao }) {
  const ensaio = exigeEnsaioLiberacao === 1 || exigeEnsaioLiberacao === '1' || exigeEnsaioLiberacao === true;
  return (modo === 'projeto' || ensaio) ? 1 : 0;
}

/**
 * Valida o cabeçalho do tipo de peça. Devolve string com o erro, ou null.
 *
 * O fck de transferência é exigido na protensão porque é ele que libera o
 * corte da cordoalha: sem o número, `tecnologico.podeLiberar` não teria contra
 * o que comparar e a trava viraria enfeite.
 */
function validarPeca(dados) {
  if (!MODOS.includes(dados.modo)) return `modo inválido: use ${MODOS.join(' ou ')}`;
  if (num(dados.quantidadeBase, { min: 0 }) == null) return 'quantidadeBase deve ser >= 0';
  if (num(dados.pesoKg, { min: 0 }) == null) return 'pesoKg deve ser >= 0';
  if (num(dados.tempoProcessoHoras, { min: 0, max: 2000 }) == null) {
    return 'tempoProcessoHoras deve estar entre 0 e 2000';
  }
  if (num(dados.unidadesPorCiclo, { min: 0.0001 }) == null) return 'unidadesPorCiclo deve ser > 0';
  if (ehVerdadeiro(dados.exigeEnsaioLiberacao)) {
    const ft = num(dados.ensaioLimiteLiberacao, { min: 0.1 });
    if (ft == null) {
      return 'liberação por ensaio exige ensaioLimiteLiberacao: é o número contra o qual a medição é comparada';
    }
    const fp = num(dados.ensaioLimiteConformidade, { min: 0.1 });
    if (fp != null && ft > fp) {
      return 'ensaioLimiteLiberacao não pode ser maior que ensaioLimiteConformidade';
    }
  }
  return null;
}

/** Grava (insert ou update) o tipo de peça. `exigeIdentificacao` é sempre derivado. */
function salvarPeca(db, produtoId, dados) {
  const erro = validarPeca(dados);
  if (erro) return { erro };

  const prod = db.prepare('SELECT id FROM produtos WHERE id = ?').get(produtoId);
  if (!prod) return { erro: 'produto não encontrado' };

  // ─── A GUARDA QUE PROTEGE AS DUAS REGRAS DO MÓDULO ────────────────────────
  // `modo` e `cura` são lidos pelo ESTADO ATUAL da peça em dois pontos
  // decisivos: a trava da protensão (tecnologico.podeLiberarSaida) e a
  // criação das peças identificadas (op.concluir).
  //
  // Sem esta guarda, trocar o cadastro no meio de uma OP contorna as duas sem
  // deixar rastro: mudar `cura` para forma_fixa libera a desforma de uma peça
  // protendida sem ensaio nenhum — e o evento gravado na OP ainda afirmaria
  // "cura em forma fixa, sem trava de ensaio". Mudar `modo` para catálogo faz
  // a conclusão pular a identificação individual, e a peça vai para a obra sem
  // o elo peça ↔ lote ↔ corpo de prova.
  //
  // Os demais campos seguem editáveis: o que se protege é a classificação, não
  // o cadastro inteiro.
  //
  // `planejada` entra na guarda junto com as demais, e não é excesso de zelo:
  // uma OP de peça de obra nasce com `projetoId` obrigatório e, se o modo virar
  // `catalogo` antes da liberação, ela segue o ciclo inteiro e conclui SEM
  // criar as peças identificadas — o mesmo furo, uma etapa antes.
  const atual = db.prepare(
    'SELECT modo, exigeEnsaioLiberacao FROM prod_fichas WHERE produtoId = ?'
  ).get(produtoId);
  const ensaioNovo = ehVerdadeiro(dados.exigeEnsaioLiberacao) ? 1 : 0;
  if (atual && (atual.modo !== dados.modo || atual.exigeEnsaioLiberacao !== ensaioNovo)) {
    const emVoo = db.prepare(`
      SELECT numero, status FROM prod_ordens
       WHERE produtoId = ? AND status NOT IN ('concluida','cancelada')
       ORDER BY id LIMIT 5
    `).all(produtoId);
    if (emVoo.length) {
      return {
        erro: `há ${emVoo.length} ordem(ns) de produção em andamento com esta peça `
          + `(${emVoo.map(o => `${o.numero} em ${o.status}`).join(', ')}). `
          + 'Modo e liberação por ensaio decidem a trava e a identificação individual: '
          + 'conclua ou cancele as ordens antes de reclassificar.',
      };
    }
  }

  if (dados.recursoPadraoId != null && dados.recursoPadraoId !== '') {
    const f = db.prepare('SELECT id FROM prod_recursos WHERE id = ?').get(dados.recursoPadraoId);
    if (!f) return { erro: 'recursoPadraoId não existe' };
  }

  const exige = derivarExigeIdentificacao(dados);
  const campos = {
    produtoId,
    modo: dados.modo,
    exigeEnsaioLiberacao: ehVerdadeiro(dados.exigeEnsaioLiberacao) ? 1 : 0,
    ensaioTipoId: dados.ensaioTipoId || null,
    unidadeBase: String(dados.unidadeBase || 'UN').trim().toUpperCase().slice(0, 10),
    exigeIdentificacao: exige,
    quantidadeBase: Number(dados.quantidadeBase),
    pesoKg: Number(dados.pesoKg),
    comprimentoM: num(dados.comprimentoM, { min: 0 }),
    larguraM: num(dados.larguraM, { min: 0 }),
    alturaM: num(dados.alturaM, { min: 0 }),
    ensaioLimiteConformidade: num(dados.ensaioLimiteConformidade, { min: 0 }),
    ensaioLimiteLiberacao: num(dados.ensaioLimiteLiberacao, { min: 0 }),
    tempoProcessoHoras: Number(dados.tempoProcessoHoras),
    recursoPadraoId: dados.recursoPadraoId || null,
    unidadesPorCiclo: Number(dados.unidadesPorCiclo),
    codigoProjeto: dados.codigoProjeto || null,
    ativo: dados.ativo === 0 || dados.ativo === '0' ? 0 : 1,
    observacoes: dados.observacoes || null,
  };

  db.prepare(`
    INSERT INTO prod_fichas (
      produtoId, modo, exigeEnsaioLiberacao, ensaioTipoId, unidadeBase, exigeIdentificacao, quantidadeBase, pesoKg,
      comprimentoM, larguraM, alturaM, ensaioLimiteConformidade, ensaioLimiteLiberacao,
      tempoProcessoHoras, recursoPadraoId, unidadesPorCiclo, codigoProjeto, ativo,
      observacoes, dataAtualizacao
    ) VALUES (
      @produtoId, @modo, @exigeEnsaioLiberacao, @ensaioTipoId, @unidadeBase, @exigeIdentificacao, @quantidadeBase, @pesoKg,
      @comprimentoM, @larguraM, @alturaM, @ensaioLimiteConformidade, @ensaioLimiteLiberacao,
      @tempoProcessoHoras, @recursoPadraoId, @unidadesPorCiclo, @codigoProjeto, @ativo,
      @observacoes, CURRENT_TIMESTAMP
    )
    ON CONFLICT(produtoId) DO UPDATE SET
      modo = excluded.modo,
      exigeEnsaioLiberacao = excluded.exigeEnsaioLiberacao,
      ensaioTipoId = excluded.ensaioTipoId,
      unidadeBase = excluded.unidadeBase,
      exigeIdentificacao = excluded.exigeIdentificacao,
      quantidadeBase = excluded.quantidadeBase,
      pesoKg = excluded.pesoKg,
      comprimentoM = excluded.comprimentoM,
      larguraM = excluded.larguraM,
      alturaM = excluded.alturaM,
      ensaioLimiteConformidade = excluded.ensaioLimiteConformidade,
      ensaioLimiteLiberacao = excluded.ensaioLimiteLiberacao,
      tempoProcessoHoras = excluded.tempoProcessoHoras,
      recursoPadraoId = excluded.recursoPadraoId,
      unidadesPorCiclo = excluded.unidadesPorCiclo,
      codigoProjeto = excluded.codigoProjeto,
      ativo = excluded.ativo,
      observacoes = excluded.observacoes,
      dataAtualizacao = CURRENT_TIMESTAMP
  `).run(campos);

  return { ficha: carregarFicha(db, produtoId) };
}

function carregarFicha(db, produtoId) {
  return db.prepare(`
    SELECT p.*, pr.descricao AS produtoDescricao, pr.unidade AS produtoUnidade
      FROM prod_fichas p
      JOIN produtos pr ON pr.id = p.produtoId
     WHERE p.produtoId = ?
  `).get(produtoId) || null;
}

// ─── Ficha técnica ───────────────────────────────────────────────────────────

/**
 * Consumo real de um item de ficha: quantidade de projeto mais a perda.
 *
 * A perda é percentual ADITIVO, não divisor: 100 kg com 5% de perda consomem
 * 105 kg. (No restaurante o fator é divisor porque lá se parte do peso bruto
 * comprado; aqui se parte da quantidade de projeto.)
 */
function consumoComPerda(quantidade, perdaPercentual) {
  const q = Number(quantidade) || 0;
  const p = Number(perdaPercentual) || 0;
  return q * (1 + p / 100);
}

function validarItemFicha(db, fichaProdutoId, dados) {
  if (num(dados.quantidade, { min: 0.000001 }) == null) return 'quantidade deve ser > 0';
  if (num(dados.perdaPercentual, { min: 0, max: 100 }) == null) {
    return 'perdaPercentual deve estar entre 0 e 100';
  }
  if (dados.grupo && !GRUPOS_INSUMO.includes(dados.grupo)) {
    return `grupo inválido: use ${GRUPOS_INSUMO.join(', ')}`;
  }
  if (Number(dados.insumoProdutoId) === Number(fichaProdutoId)) {
    return 'a peça não pode ser insumo de si mesma';
  }
  const ins = db.prepare('SELECT id FROM produtos WHERE id = ?').get(dados.insumoProdutoId);
  if (!ins) return 'insumoProdutoId não existe';

  // Ciclo indireto: o insumo (ou a cadeia dele) já contém esta peça.
  if (contemNaCadeia(db, dados.insumoProdutoId, fichaProdutoId)) {
    return 'ciclo na ficha técnica: este insumo já contém a peça em sua própria cadeia';
  }
  return null;
}

/** Percorre a ficha do insumo procurando `alvoId`. Guarda contra ciclo pré-existente. */
function contemNaCadeia(db, produtoId, alvoId, visitados = new Set(), nivel = 0) {
  if (nivel > PROFUNDIDADE_MAX) return false;
  if (visitados.has(produtoId)) return false;
  visitados.add(produtoId);
  const filhos = db.prepare(
    'SELECT insumoProdutoId FROM prod_ficha_itens WHERE fichaProdutoId = ?'
  ).all(produtoId);
  for (const f of filhos) {
    if (Number(f.insumoProdutoId) === Number(alvoId)) return true;
    if (contemNaCadeia(db, f.insumoProdutoId, alvoId, visitados, nivel + 1)) return true;
  }
  return false;
}

function custoUnitarioInsumo(db, produtoId) {
  // Custo médio quando há movimentação; senão, o custo de cadastro. Produção
  // consome o que está no estoque, então o custo médio é a leitura correta —
  // precoCusto é a última compra, que pode ser de um ano atrás.
  try {
    const { calcularCustoMedio } = require('../estoque-routes');
    const medio = calcularCustoMedio(db, produtoId);
    if (medio && medio > 0) return medio;
  } catch (_) { /* estoque não carregado neste processo: cai no cadastro */ }
  const p = db.prepare('SELECT precoCusto FROM produtos WHERE id = ?').get(produtoId);
  return p ? Number(p.precoCusto || 0) : 0;
}

/**
 * Custo teórico de UMA peça, explodindo sub-fichas.
 *
 * Devolve { custoTotal, itens[], avisos[] }. Os avisos apontam o que impede o
 * número de ser confiável — insumo sem custo é o caso mais comum e faz a
 * margem parecer melhor do que é.
 */
function custoDaFicha(db, fichaProdutoId, { profundidade = 0, visitados = new Set() } = {}) {
  const avisos = [];
  const itens = [];

  if (profundidade > PROFUNDIDADE_MAX) {
    avisos.push(`profundidade máxima (${PROFUNDIDADE_MAX}) excedida no produto ${fichaProdutoId}`);
    return { custoTotal: 0, itens, avisos };
  }
  if (visitados.has(fichaProdutoId)) {
    avisos.push(`ciclo detectado no produto ${fichaProdutoId} — ficha ignorada neste ramo`);
    return { custoTotal: 0, itens, avisos };
  }
  visitados.add(fichaProdutoId);

  const linhas = db.prepare(`
    SELECT f.*, pr.descricao AS insumoDescricao, pr.unidade AS insumoUnidade
      FROM prod_ficha_itens f
      JOIN produtos pr ON pr.id = f.insumoProdutoId
     WHERE f.fichaProdutoId = ?
     ORDER BY f.ordem, f.id
  `).all(fichaProdutoId);

  let custoTotal = 0;
  for (const l of linhas) {
    const consumo = consumoComPerda(l.quantidade, l.perdaPercentual);

    // O insumo tem ficha própria? Então o custo dele é o custo da ficha dele.
    const temSubFicha = db.prepare(
      'SELECT 1 FROM prod_ficha_itens WHERE fichaProdutoId = ? LIMIT 1'
    ).get(l.insumoProdutoId);

    let unitario;
    if (temSubFicha) {
      const sub = custoDaFicha(db, l.insumoProdutoId, {
        profundidade: profundidade + 1,
        visitados: new Set(visitados),
      });
      unitario = sub.custoTotal;
      avisos.push(...sub.avisos);
    } else {
      unitario = custoUnitarioInsumo(db, l.insumoProdutoId);
      if (!unitario) {
        avisos.push(`insumo "${l.insumoDescricao}" (#${l.insumoProdutoId}) sem custo — `
          + 'o custo da peça está subestimado');
      }
    }

    const custo = consumo * unitario;
    custoTotal += custo;
    itens.push({
      id: l.id,
      insumoProdutoId: l.insumoProdutoId,
      insumoDescricao: l.insumoDescricao,
      quantidade: l.quantidade,
      perdaPercentual: l.perdaPercentual,
      consumo,
      unidade: l.unidade || l.insumoUnidade,
      grupo: l.grupo,
      custoUnitario: unitario,
      custoTotal: custo,
      subFicha: !!temSubFicha,
    });
  }

  return { custoTotal, itens, avisos };
}

/**
 * Explode a ficha para uma quantidade de peças. É o que a OP congela na
 * liberação — a partir daí a ficha pode mudar sem alterar a OP já aberta.
 */
function explodirFicha(db, fichaProdutoId, quantidadePecas) {
  const { itens, avisos, custoTotal } = custoDaFicha(db, fichaProdutoId);
  const q = Number(quantidadePecas) || 0;
  return {
    avisos,
    custoTotalUnitario: custoTotal,
    custoTotal: custoTotal * q,
    itens: itens.map(i => ({
      insumoProdutoId: i.insumoProdutoId,
      insumoDescricao: i.insumoDescricao,
      quantidadePrevista: i.consumo * q,
      unidade: i.unidade,
      grupo: i.grupo,
      custoUnitario: i.custoUnitario,
      custoTotal: i.custoTotal * q,
    })),
  };
}

module.exports = {
  MODOS, GRUPOS_INSUMO, PROFUNDIDADE_MAX,
  derivarExigeIdentificacao, validarPeca, salvarPeca, carregarFicha,
  consumoComPerda, validarItemFicha, contemNaCadeia,
  custoUnitarioInsumo, custoDaFicha, explodirFicha,
};
