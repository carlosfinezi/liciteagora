/**
 * produtividade.js — os indicadores (F1.9).
 *
 * Este arquivo existe por causa de uma frase do dono da fábrica: "queria
 * mensurar o quanto o funcionário consegue produzir". O que ele pediu, do
 * jeito que pediu, produz número errado — e o desenho abaixo é a resposta
 * honesta a esse pedido, não a recusa dele.
 *
 * ─── POR QUE O INDICADOR É DA EQUIPE ────────────────────────────────────────
 * A maior parte da manufatura é trabalho simultâneo: uma concretagem envolve
 * armador, montador de forma e vibrador ao mesmo tempo; uma injetora envolve
 * operador e auxiliar. Atribuir a unidade a uma pessoa é ficção, e um ranking
 * individual construído sobre ela premiaria e demitiria com base em número
 * inventado. Individual só aparece nas etapas que o cadastro marca como
 * `individual` (prod_etapas) — tipicamente as de tarefa solo, como armação por
 * kg ou acabamento.
 *
 * ─── O DENOMINADOR VEM DO PONTO, NÃO DO APONTAMENTO ─────────────────────────
 * Homem-hora é `funcionarios_ponto.horasTrabalhadas` dos membros da equipe no
 * período — não `horas × pessoas` digitado no apontamento. A diferença é o
 * ponto: se a equipe esteve 8h presente e apontou 5h de trabalho, as 3h de
 * espera SÃO parte do custo e têm de aparecer no denominador. Um indicador que
 * divide só pelo tempo apontado mede velocidade de execução, não produtividade.
 *
 * Quando não há ponto no período, cai para `horas × pessoas` e DIZ que caiu
 * (`fonteHomemHora`). Um número cuja origem o painel esconde vira decisão de
 * prêmio tomada às cegas.
 *
 * ─── O REFUGO É PARTE DO INDICADOR, NÃO UM RELATÓRIO À PARTE ────────────────
 * Produzir muito e quebrar não é produtividade. Por isso `basePorHomemHora` vem
 * sempre acompanhado de `refugoPercentual` na mesma linha: separá-los deixaria
 * o ranking premiar a equipe que corre e quebra.
 */

const { normalizarData } = require('./prod-util');
const { etapasQueContam, etapasIndividuais, etapasAtivas } = require('./apontamento');

/** Janela padrão: últimos 30 dias. */
function janela({ de, ate } = {}) {
  const fim = normalizarData(ate) || new Date().toISOString().slice(0, 10);
  let ini = normalizarData(de);
  if (!ini) {
    const d = new Date(`${fim}T00:00:00`);
    d.setDate(d.getDate() - 30);
    ini = d.toISOString().slice(0, 10);
  }
  return { de: ini, ate: fim };
}

/**
 * Homem-hora de uma equipe no período, pelo PONTO.
 *
 * Conta o ponto dos membros ATIVOS da equipe. Um funcionário que troca de
 * equipe no meio do período aparece nas duas — é o preço de não ter alocação
 * diária, e está declarado como gap no plano do módulo.
 */
function homemHoraPeloPonto(db, equipeId, de, ate) {
  // `funcionarios_ponto` vem do rh-routes, cujo migrarDB é no-op em
  // multi-tenant: há tenants em produção sem a tabela. Um painel que devolve
  // 500 por causa disso derruba a F1 inteira — sem ponto, o cálculo cai no
  // apontamento e o painel avisa (ver avisosDeQualidade).
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(p.horasTrabalhadas), 0) AS h, COUNT(DISTINCT p.funcionarioId) AS pessoas
        FROM funcionarios_ponto p
        JOIN prod_equipe_membros m ON m.funcionarioId = p.funcionarioId AND m.ativo = 1
       WHERE m.equipeId = ? AND p.data BETWEEN ? AND ?
         AND p.horasTrabalhadas IS NOT NULL
    `).get(equipeId, de, ate);
    return { horas: row.h || 0, pessoas: row.pessoas || 0, semRh: false };
  } catch (e) {
    if (/no such table/i.test(e.message)) return { horas: 0, pessoas: 0, semRh: true };
    throw e;
  }
}

/** Fallback: horas-relógio × pessoas declaradas no apontamento. */
function homemHoraPeloApontamento(db, equipeId, de, ate) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(horas * COALESCE(pessoas, 1)), 0) AS h
      FROM prod_apontamentos
     WHERE equipeId = ? AND data BETWEEN ? AND ?
  `).get(equipeId, de, ate);
  return row.h || 0;
}

/**
 * O indicador principal: quantidade base por homem-hora, por equipe.
 *
 * A unidade da "quantidade base" é da FICHA (m³, kg, m², milheiro), não do
 * código — ver prod_fichas.unidadeBase. Uma equipe que trabalhou em fichas de
 * unidades diferentes tem `basePorHomemHora` nulo, porque somar m³ com kg não
 * produz número nenhum.
 *
 * Produção conta só nas etapas marcadas com `contaProducao` no cadastro. As
 * mesmas 10 unidades passando por três etapas não são 30: são 10 que ficaram
 * prontas uma vez. O refugo, ao contrário, soma de TODAS as etapas — uma
 * unidade pode ser perdida na preparação e outra na inspeção.
 */
function porEquipe(db, filtro = {}) {
  const { de, ate } = janela(filtro);

  const equipes = db.prepare(
    'SELECT id, nome, especialidade FROM prod_equipes WHERE ativo = 1 ORDER BY nome'
  ).all();

  // As etapas que marcam produção vêm do cadastro (prod_etapas.contaProducao).
  // Sem nenhuma, não há o que somar — e o painel diz isso em vez de mostrar
  // zero como se fosse desempenho ruim.
  const contam = etapasQueContam(db);
  const marcadoresContam = contam.length ? contam.map(() => '?').join(',') : "''";

  const linhas = equipes.map(eq => {
    const prod = db.prepare(`
      SELECT COALESCE(SUM(a.quantidadeProduzida), 0) AS pecas,
             COALESCE(SUM(a.quantidadeProduzida * COALESCE(pc.quantidadeBase, 0)), 0) AS base,
             COUNT(DISTINCT COALESCE(pc.unidadeBase, 'UN')) AS unidadesDistintas,
             MIN(COALESCE(pc.unidadeBase, 'UN')) AS unidade
        FROM prod_apontamentos a
        JOIN prod_ordens o ON o.id = a.opId
        LEFT JOIN prod_fichas pc ON pc.produtoId = o.produtoId
       WHERE a.equipeId = ? AND a.data BETWEEN ? AND ? AND a.etapa IN (${marcadoresContam})
    `).get(eq.id, de, ate, ...contam);

    const ref = db.prepare(`
      SELECT COALESCE(SUM(a.quantidadeRefugo), 0) AS pecas,
             COALESCE(SUM(a.quantidadeRefugo * COALESCE(pc.quantidadeBase, 0)), 0) AS base
        FROM prod_apontamentos a
        JOIN prod_ordens o ON o.id = a.opId
        LEFT JOIN prod_fichas pc ON pc.produtoId = o.produtoId
       WHERE a.equipeId = ? AND a.data BETWEEN ? AND ?
    `).get(eq.id, de, ate);

    const ponto = homemHoraPeloPonto(db, eq.id, de, ate);
    let homemHora = ponto.horas;
    let fonte = 'ponto';
    if (!homemHora) {
      homemHora = homemHoraPeloApontamento(db, eq.id, de, ate);
      fonte = ponto.semRh ? 'apontamento_sem_rh' : 'apontamento';
    }

    const totalPecas = prod.pecas + ref.pecas;
    return {
      equipeId: eq.id,
      equipe: eq.nome,
      especialidade: eq.especialidade,
      unidadesBoas: prod.pecas,
      unidadesRefugo: ref.pecas,
      baseProduzida: prod.base,
      baseRefugo: ref.base,
      // Uma equipe que trabalhou em fichas de unidades diferentes tem o mesmo
      // problema do resumo: a soma não significa nada. Aqui fica explícito na
      // linha, para a tela poder mostrar "—" em vez de um número falso.
      unidadeBase: prod.unidadesDistintas === 1 ? prod.unidade : null,
      unidadesMisturadas: prod.unidadesDistintas > 1,
      homemHora,
      fonteHomemHora: fonte,
      pessoasComPonto: ponto.pessoas,
      basePorHomemHora: (homemHora > 0 && prod.unidadesDistintas === 1) ? prod.base / homemHora : null,
      unidadesPorHomemHora: homemHora > 0 ? prod.pecas / homemHora : null,
      // Refugo sobre o total produzido, não sobre o bom: quebrar 1 em 10
      // tentativas é 10%, não 11,1%.
      refugoPercentual: totalPecas > 0 ? (ref.pecas / totalPecas) * 100 : 0,
    };
  });

  return { periodo: { de, ate }, equipes: linhas, avisos: avisosDeQualidade(linhas) };
}

/**
 * O que impede o número de ser confiável. Sai junto com o indicador, não num
 * relatório separado que ninguém abre.
 */
function avisosDeQualidade(linhas) {
  const avisos = [];
  if (linhas.some(l => l.fonteHomemHora === 'apontamento_sem_rh')) {
    avisos.push('o módulo de RH não está instalado neste tenant: sem `funcionarios_ponto` '
      + 'o homem-hora vem do apontamento e ignora o tempo de espera. Ative o RH para o '
      + 'indicador ficar real');
  }
  const semPonto = linhas.filter(l => l.fonteHomemHora.startsWith('apontamento') && l.homemHora > 0);
  if (semPonto.length) {
    avisos.push(`${semPonto.length} equipe(s) sem ponto no período: o homem-hora veio do `
      + 'apontamento e ignora o tempo de espera — o número sai otimista');
  }
  const semBase = linhas.filter(l => l.unidadesBoas > 0 && l.baseProduzida === 0);
  if (semBase.length) {
    avisos.push(`${semBase.length} equipe(s) produziram sem quantidade base cadastrada: `
      + 'o indicador por homem-hora fica zerado. Preencha quantidadeBase e unidadeBase na ficha');
  }
  return avisos;
}

/**
 * Ciclo de forma: quantas vezes cada forma girou e quanto tempo ficou parada.
 *
 * É a fila real da fábrica. Uma forma com 3 ciclos em 30 dias, num tipo de peça
 * que cura em 24h, esteve ociosa 27 dias — e nenhuma contratação resolve isso.
 */
function porForma(db, filtro = {}) {
  const { de, ate } = janela(filtro);
  const formas = db.prepare(
    'SELECT id, codigo, descricao, tipo, capacidadePecas FROM prod_recursos WHERE ativo = 1 ORDER BY codigo'
  ).all();

  const diasPeriodo = Math.max(1,
    (new Date(`${ate}T00:00:00`) - new Date(`${de}T00:00:00`)) / 86400000 + 1);

  return {
    periodo: { de, ate },
    formas: formas.map(f => {
      const row = db.prepare(`
        SELECT COUNT(*) AS ciclos,
               COALESCE(SUM(quantidadeProduzida), 0) AS pecas,
               COALESCE(SUM(quantidadeRefugo), 0) AS refugo,
               COALESCE(AVG(julianday(COALESCE(dataFim, dataConclusao))
                            - julianday(dataInicioProcesso)), 0) AS diasMediosOcupada
          FROM prod_ordens
         WHERE formaId = ? AND status = 'concluida'
           AND date(dataInicioProcesso) BETWEEN ? AND ?
      `).get(f.id, de, ate);

      const diasOcupada = (row.ciclos || 0) * (row.diasMediosOcupada || 0);
      return {
        formaId: f.id,
        forma: f.codigo,
        descricao: f.descricao,
        tipo: f.tipo,
        ciclos: row.ciclos || 0,
        pecas: row.pecas || 0,
        refugo: row.refugo || 0,
        unidadesPorCiclo: row.ciclos > 0 ? row.pecas / row.ciclos : 0,
        capacidadePecas: f.capacidadePecas,
        // Quanto da capacidade da forma foi usada por ciclo. Abaixo de 100%
        // significa concretar forma pela metade — custo de ciclo inteiro.
        ocupacaoPorCicloPercentual: (row.ciclos > 0 && f.capacidadePecas > 0)
          ? ((row.pecas / row.ciclos) / f.capacidadePecas) * 100 : null,
        diasMediosOcupada: row.diasMediosOcupada || 0,
        // Fração do período em que a forma esteve efetivamente presa.
        utilizacaoPercentual: (diasOcupada / diasPeriodo) * 100,
      };
    }),
  };
}

/**
 * Aderência ao ciclo de cura: OPs desmoldadas ANTES da hora prevista.
 *
 * É o atalho que aparece na planilha como produtividade e volta 28 dias depois
 * como corpo de prova reprovado. Listar por equipe é o que torna o padrão
 * visível — uma OP adiantada é exceção; vinte, é método.
 */
function aderenciaCura(db, filtro = {}) {
  const { de, ate } = janela(filtro);
  const linhas = db.prepare(`
    SELECT o.id, o.numero, o.dataInicioProcesso, o.dataFimPrevisto, o.dataFim,
           pr.descricao AS produto, pc.exigeEnsaioLiberacao,
           (julianday(o.dataFimPrevisto) - julianday(o.dataFim)) * 24 AS horasAdiantada
      FROM prod_ordens o
      JOIN produtos pr ON pr.id = o.produtoId
      LEFT JOIN prod_fichas pc ON pc.produtoId = o.produtoId
     WHERE o.status = 'concluida' AND o.dataFim IS NOT NULL
       AND o.dataFimPrevisto IS NOT NULL
       AND date(o.dataInicioProcesso) BETWEEN ? AND ?
     ORDER BY horasAdiantada DESC
  `).all(de, ate);

  const adiantadas = linhas.filter(l => l.horasAdiantada > 0.5);
  const forcadas = db.prepare(`
    SELECT COUNT(*) n FROM prod_ordem_eventos
     WHERE tipo = 'liberacao_forcada' AND date(data) BETWEEN ? AND ?
  `).get(de, ate).n;

  return {
    periodo: { de, ate },
    total: linhas.length,
    adiantadas: adiantadas.length,
    liberacoesForcadas: forcadas,
    aderenciaPercentual: linhas.length ? ((linhas.length - adiantadas.length) / linhas.length) * 100 : null,
    piores: adiantadas.slice(0, 10),
  };
}

/**
 * Indicador individual — só nas etapas que são individuais de fato.
 *
 * Aqui a produção É atribuível: quem montou a armação montou sozinho. A
 * unidade não é m³ (o volume é da peça, não da armação), é quantidade apontada
 * por hora.
 */
function individual(db, filtro = {}) {
  const { de, ate } = janela(filtro);
  const individuais = etapasIndividuais(db);
  if (!individuais.length) {
    return {
      periodo: { de, ate }, etapas: [], linhas: [],
      nota: 'Nenhuma etapa está marcada como individual. Concretagem, montagem e '
        + 'demais trabalhos simultâneos são de equipe: ver /api/producao/produtividade/equipes.',
    };
  }
  const marcadores = individuais.map(() => '?').join(',');
  let linhas;
  try {
    linhas = db.prepare(`
      SELECT a.funcionarioId, f.nome AS funcionario, f.cargo, a.etapa,
             COALESCE(SUM(a.quantidadeProduzida), 0) AS quantidade,
             COALESCE(SUM(a.quantidadeRefugo), 0) AS refugo,
             COALESCE(SUM(a.horas), 0) AS horas
        FROM prod_apontamentos a
        JOIN funcionarios f ON f.id = a.funcionarioId
       WHERE a.funcionarioId IS NOT NULL AND a.data BETWEEN ? AND ?
         AND a.etapa IN (${marcadores})
       GROUP BY a.funcionarioId, a.etapa
       ORDER BY f.nome, a.etapa
    `).all(de, ate, ...individuais);
  } catch (e) {
    // Tenant sem o módulo de RH: sem `funcionarios` não há apontamento
    // individual para listar. Lista vazia, não 500.
    if (!/no such table/i.test(e.message)) throw e;
    linhas = [];
  }

  return {
    periodo: { de, ate },
    etapas: individuais,
    linhas: linhas.map(l => ({
      ...l,
      porHora: l.horas > 0 ? l.quantidade / l.horas : null,
      refugoPercentual: (l.quantidade + l.refugo) > 0
        ? (l.refugo / (l.quantidade + l.refugo)) * 100 : 0,
    })),
    nota: 'Só as etapas individuais aparecem aqui. Concretagem, forma e desforma são '
      + 'trabalho de equipe: ver /api/producao/produtividade/equipes.',
  };
}

/** Cabeçalho do painel: os números que abrem a tela. */
function resumo(db, filtro = {}) {
  const { de, ate } = janela(filtro);

  const prod = db.prepare(`
    SELECT COALESCE(SUM(o.quantidadeProduzida), 0) AS pecas,
           COALESCE(SUM(o.quantidadeRefugo), 0) AS refugo,
           COALESCE(SUM(o.quantidadeProduzida * COALESCE(pc.quantidadeBase, 0)), 0) AS base,
           COALESCE(SUM(o.custoTotal), 0) AS custo,
           COALESCE(SUM(o.custoTeorico), 0) AS custoTeorico,
           COUNT(*) AS ops
      FROM prod_ordens o
      LEFT JOIN prod_fichas pc ON pc.produtoId = o.produtoId
     WHERE o.status = 'concluida' AND date(o.dataConclusao) BETWEEN ? AND ?
  `).get(de, ate);

  const abertas = db.prepare(`
    SELECT status, COUNT(*) n FROM prod_ordens
     WHERE status NOT IN ('concluida','cancelada') GROUP BY status
  `).all();

  const equipes = porEquipe(db, { de, ate });
  const homemHoraTotal = equipes.equipes.reduce((s, e) => s + e.homemHora, 0);

  // ─── A soma só vale dentro de UMA unidade ────────────────────────────────
  // Quando o módulo era só de concreto, tudo era m³ e somar era seguro. Numa
  // fábrica que produz peça em m³ e perfil em kg, somar os dois dá um número
  // sem significado nenhum. Aqui se descobre quais unidades apareceram no
  // período: uma só, o total vale; mais de uma, o total sai NULO e o painel
  // mostra a quebra por unidade — em vez de exibir um número inventado.
  const porUnidade = db.prepare(`
    SELECT COALESCE(pc.unidadeBase, 'UN') AS unidade,
           COALESCE(SUM(o.quantidadeProduzida * COALESCE(pc.quantidadeBase, 0)), 0) AS base,
           COALESCE(SUM(o.quantidadeProduzida), 0) AS unidades
      FROM prod_ordens o
      LEFT JOIN prod_fichas pc ON pc.produtoId = o.produtoId
     WHERE o.status = 'concluida' AND date(o.dataConclusao) BETWEEN ? AND ?
     GROUP BY COALESCE(pc.unidadeBase, 'UN')
     HAVING base > 0
     ORDER BY base DESC
  `).all(de, ate);

  const unidadeUnica = porUnidade.length === 1 ? porUnidade[0].unidade : null;
  const avisos = [...equipes.avisos];
  if (porUnidade.length > 1) {
    avisos.push(`o período tem produção em ${porUnidade.length} unidades diferentes `
      + `(${porUnidade.map(u => u.unidade).join(', ')}): o total por homem-hora não é somável `
      + '— use a quebra por unidade');
  }

  const totalUnidades = prod.pecas + prod.refugo;
  return {
    periodo: { de, ate },
    ops: prod.ops,
    unidadesBoas: prod.pecas,
    unidadesRefugo: prod.refugo,
    refugoPercentual: totalUnidades > 0 ? (prod.refugo / totalUnidades) * 100 : 0,
    unidadeBase: unidadeUnica,
    porUnidade,
    baseProduzida: unidadeUnica ? prod.base : null,
    homemHora: homemHoraTotal,
    basePorHomemHora: (unidadeUnica && homemHoraTotal > 0) ? prod.base / homemHoraTotal : null,
    // Este sempre vale, misturando unidades ou não: peça é peça.
    unidadesPorHomemHora: homemHoraTotal > 0 ? prod.pecas / homemHoraTotal : null,
    custoRealizado: prod.custo,
    custoTeorico: prod.custoTeorico,
    // Positivo = gastou mais que a ficha previa.
    desvioCustoPercentual: prod.custoTeorico > 0
      ? ((prod.custo - prod.custoTeorico) / prod.custoTeorico) * 100 : null,
    opsAbertas: abertas,
    avisos,
  };
}

module.exports = {
  janela, homemHoraPeloPonto, homemHoraPeloApontamento,
  porEquipe, porForma, aderenciaCura, individual, resumo,
};
