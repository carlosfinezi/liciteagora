/**
 * op.js — ordem de produção (F1.5).
 *
 * O ciclo de vida da OP e os dois momentos em que ela toca o estoque core.
 *
 * ─── CICLO ──────────────────────────────────────────────────────────────────
 *   planejada ──liberar──> liberada ──iniciarProcesso──> em_processo
 *     └──────────────────────┴──cancelar──> cancelada
 *   em_processo ──liberarSaida──> liberada_saida ──concluir──> concluida
 *
 * `em_processo` É o estado de cura: a peça está na forma, o relógio corre. A
 * transição para `liberada_saida` é onde a trava da protensão age
 * (tecnologico.podeLiberarSaida).
 *
 * ─── OS DOIS TOQUES NO ESTOQUE ──────────────────────────────────────────────
 * 1. `iniciarProcesso` baixa os insumos:  movimentacoes_estoque tipo='saida',
 *    origem='prod_ordem', origemId=<opId>
 * 2. `concluir` dá entrada na peça:  tipo='entrada',
 *    origem='prod_ordem_producao', origemId=<opId>
 *
 * Nenhuma coluna nova no core: `origem`/`origemId` já são livres e indexados
 * (db-schema.js:1138).
 *
 * ─── POR QUE A FICHA É CONGELADA NA LIBERAÇÃO ───────────────────────────────
 * `liberar` copia a explosão da ficha para `prod_ordem_insumos`. A partir daí,
 * reajustar a ficha (ou o custo de um insumo) não muda mais uma OP em
 * andamento. Sem isso, o custo teórico de uma OP de segunda-feira mudaria na
 * quarta e a comparação orçado × realizado perderia sentido.
 */

const {
  num, agora, normalizarInstante, normalizarData, somarHoras, horasEntre, gerarNumero,
} = require('./prod-util');
const { explodirFicha, carregarFicha } = require('./ficha');
const { podeLiberarSaida } = require('./qualidade');

const STATUS = [
  'planejada', 'liberada', 'em_processo', 'liberada_saida', 'concluida', 'cancelada',
];
const ORIGENS = ['estoque', 'obra'];

// Status a partir dos quais a OP já consumiu material: cancelar exige estorno.
// 'concluida' fica de fora: cancelar já recusa OP concluída antes de chegar
// aqui, então incluí-la seria um ramo inalcançável.
const STATUS_COM_BAIXA = ['em_processo', 'liberada_saida'];

function registrarEvento(db, opId, tipo, descricao, statusAntes, statusDepois, usuario) {
  db.prepare(`
    INSERT INTO prod_ordem_eventos (opId, tipo, descricao, statusAntes, statusDepois, usuario)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(opId, tipo, descricao || null, statusAntes || null, statusDepois || null, usuario || null);
}

function carregar(db, id) {
  const op = db.prepare(`
    SELECT o.*, pr.descricao AS produtoDescricao, pr.unidade AS produtoUnidade,
           pc.modo, pc.exigeEnsaioLiberacao, pc.ensaioTipoId, pc.unidadeBase, pc.exigeIdentificacao, pc.quantidadeBase, pc.pesoKg,
           pc.tempoProcessoHoras, pc.ensaioLimiteConformidade, pc.ensaioLimiteLiberacao,
           f.codigo AS formaCodigo, f.descricao AS formaDescricao,
           l.codigo AS loteCodigo, l.situacao AS loteSituacao,
           ob.numero AS projetoNumero, ob.nome AS projetoNome
      FROM prod_ordens o
      JOIN produtos pr ON pr.id = o.produtoId
      LEFT JOIN prod_fichas pc ON pc.produtoId = o.produtoId
      LEFT JOIN prod_recursos f ON f.id = o.formaId
      LEFT JOIN prod_lotes l ON l.id = o.loteId
      LEFT JOIN prod_projetos ob ON ob.id = o.projetoId
     WHERE o.id = ?
  `).get(id);
  if (!op) return null;
  op.insumos = db.prepare(`
    SELECT i.*, pr.descricao AS insumoDescricao
      FROM prod_ordem_insumos i
      JOIN produtos pr ON pr.id = i.insumoProdutoId
     WHERE i.opId = ? ORDER BY i.id
  `).all(id);
  op.apontamentos = db.prepare(`
    SELECT a.*, e.nome AS equipeNome
      FROM prod_apontamentos a
      LEFT JOIN prod_equipes e ON e.id = a.equipeId
     WHERE a.opId = ? ORDER BY a.data, a.id
  `).all(id);
  op.pecasProduzidas = db.prepare(
    'SELECT * FROM prod_unidades WHERE opId = ? ORDER BY id'
  ).all(id);
  op.eventos = db.prepare(
    'SELECT * FROM prod_ordem_eventos WHERE opId = ? ORDER BY data, id'
  ).all(id);
  return op;
}

/**
 * Conflito de forma: OPs que ocupam a mesma forma em janela sobreposta.
 *
 * A janela de uma OP vai da data planejada/concretagem até a desforma prevista
 * — é o tempo em que a forma está fisicamente presa. Comparação lexicográfica
 * exige instantes normalizados; ver prod-util.normalizarInstante.
 */
function conflitosDeForma(db, formaId, inicio, fim, ignorarOpId = null) {
  if (!formaId || !inicio || !fim) return [];
  const ops = db.prepare(`
    SELECT o.id, o.numero, o.status, o.dataPlanejada, o.dataInicioProcesso,
           o.dataFimPrevisto, o.dataFim
      FROM prod_ordens o
     WHERE o.formaId = ?
       AND o.status IN ('planejada','liberada','em_processo','liberada_saida')
       AND (? IS NULL OR o.id <> ?)
  `).all(formaId, ignorarOpId, ignorarOpId);

  const conflitos = [];
  for (const o of ops) {
    const oIni = normalizarInstante(o.dataInicioProcesso || o.dataPlanejada);
    const oFim = normalizarInstante(o.dataFim || o.dataFimPrevisto) || oIni;
    if (!oIni || !oFim) continue;
    // Sobreposição de intervalos fechados: A começa antes de B terminar e
    // B começa antes de A terminar.
    if (inicio < oFim && oIni < fim) conflitos.push(o);
  }

  const bloqueios = db.prepare(`
    SELECT id, motivo, dataInicio, dataFim FROM prod_recurso_bloqueios
     WHERE formaId = ? AND status = 'ativo'
  `).all(formaId).filter(b => {
    const bIni = normalizarInstante(b.dataInicio);
    const bFim = normalizarInstante(b.dataFim);
    return bIni && bFim && inicio < bFim && bIni < fim;
  });

  return [...conflitos, ...bloqueios.map(b => ({ ...b, bloqueio: true }))];
}

function criar(db, dados, usuario, config = {}) {
  const peca = carregarFicha(db, dados.produtoId);
  if (!peca) return { erro: 'produto não é um tipo de peça pré-moldada (cadastre em /api/producao/pecas)' };
  if (!peca.ativo) return { erro: 'tipo de peça inativo' };

  const origem = dados.origem || 'estoque';
  if (!ORIGENS.includes(origem)) return { erro: `origem inválida: use ${ORIGENS.join(' ou ')}` };

  const qtd = num(dados.quantidadePlanejada, { min: 0.0001 });
  if (qtd == null) return { erro: 'quantidadePlanejada deve ser > 0' };

  // Ficha de projeto tem de dizer qual projeto. Sem isso a unidade vira estoque
  // fungível e some do controle do projeto que a encomendou.
  if (peca.modo === 'projeto' && !dados.projetoId) {
    return { erro: 'ficha de modo "projeto" exige projetoId' };
  }
  if (dados.projetoId) {
    const ob = db.prepare('SELECT id, status FROM prod_projetos WHERE id = ?').get(dados.projetoId);
    if (!ob) return { erro: 'projetoId não existe' };
    if (['cancelada', 'concluida'].includes(ob.status)) {
      return { erro: `projeto ${ob.status}: não aceita nova ordem de produção` };
    }
  }

  // `projetoItemId` é o alvo do crédito de produção em `concluir`. Aceitá-lo sem
  // conferir faria a produção desta OP abater o saldo de OUTRA obra (ou de
  // outro produto) — e o item contaminado ainda travaria a edição daquela
  // obra, porque salvarItem recusa reduzir quantidade abaixo do produzido.
  if (dados.projetoItemId) {
    const item = db.prepare('SELECT id, projetoId, produtoId FROM prod_projeto_itens WHERE id = ?')
      .get(dados.projetoItemId);
    if (!item) return { erro: 'projetoItemId não existe' };
    if (!dados.projetoId || Number(item.projetoId) !== Number(dados.projetoId)) {
      return { erro: `o item #${item.id} pertence à obra #${item.projetoId}, não à obra informada` };
    }
    if (Number(item.produtoId) !== Number(dados.produtoId)) {
      return { erro: 'o item da obra é de outro produto: a produção creditaria a peça errada' };
    }
  }

  const formaId = dados.formaId || peca.recursoPadraoId || null;
  if (formaId) {
    const f = db.prepare('SELECT id, ativo FROM prod_recursos WHERE id = ?').get(formaId);
    if (!f) return { erro: 'formaId não existe' };
    if (!f.ativo) return { erro: 'forma inativa' };
  }

  const dataPlanejada = normalizarInstante(dados.dataPlanejada) || agora();
  const prefixo = config.producao_prefixo_ordem || 'OP';
  const numero = gerarNumero(db, 'prod_ordens', prefixo);

  const r = db.prepare(`
    INSERT INTO prod_ordens
      (numero, produtoId, origem, projetoId, projetoItemId, formaId, quantidadePlanejada,
       status, dataPlanejada, dataFimPrevisto, observacoes, usuarioCriacao)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'planejada', ?, ?, ?, ?)
  `).run(
    numero, dados.produtoId, origem, dados.projetoId || null, dados.projetoItemId || null,
    formaId, qtd, dataPlanejada, somarHoras(dataPlanejada, peca.tempoProcessoHoras),
    dados.observacoes || null, usuario || null
  );

  registrarEvento(db, r.lastInsertRowid, 'criada', `OP ${numero} criada`, null, 'planejada', usuario);
  return { op: carregar(db, r.lastInsertRowid) };
}

/**
 * Libera para produção: congela a ficha em `prod_ordem_insumos` e trava a forma.
 *
 * Devolve `avisos` — insumo sem custo, saldo insuficiente. Eles NÃO impedem a
 * liberação (a fábrica muitas vezes libera sabendo que o cimento chega de
 * manhã), mas ficam visíveis em vez de silenciosos.
 */
function liberar(db, id, usuario, config = {}) {
  const op = carregar(db, id);
  if (!op) return { erro: 'OP não encontrada' };
  if (op.status !== 'planejada') return { erro: `OP em status "${op.status}": só "planejada" pode ser liberada` };

  const explosao = explodirFicha(db, op.produtoId, op.quantidadePlanejada);
  if (!explosao.itens.length) {
    return { erro: 'a peça não tem ficha técnica: sem ela não há o que baixar nem custo a comparar' };
  }

  const avisos = [...explosao.avisos];

  if (op.formaId) {
    const inicio = normalizarInstante(op.dataPlanejada);
    const fim = normalizarInstante(op.dataFimPrevisto) || inicio;
    const conf = conflitosDeForma(db, op.formaId, inicio, fim, op.id);
    if (conf.length) {
      const permite = String(config.producao_permitir_recurso_sobreposto || '0') === '1';
      const desc = conf.map(c => c.bloqueio ? `bloqueio: ${c.motivo}` : `OP ${c.numero}`).join(', ');
      if (!permite) {
        return { erro: `forma ocupada no período (${desc}). Ajuste a data, escolha outra forma `
          + 'ou ligue producao_permitir_recurso_sobreposto.' };
      }
      avisos.push(`forma ocupada no período (${desc}) — liberada assim mesmo por configuração`);
    }
  }

  const insertInsumo = db.prepare(`
    INSERT INTO prod_ordem_insumos
      (opId, insumoProdutoId, quantidadePrevista, unidade, grupo, custoUnitario, custoTotal)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM prod_ordem_insumos WHERE opId = ?').run(id);
    for (const i of explosao.itens) {
      insertInsumo.run(id, i.insumoProdutoId, i.quantidadePrevista, i.unidade || null,
        i.grupo || null, i.custoUnitario, i.custoTotal);
    }
    db.prepare(`
      UPDATE prod_ordens
         SET status = 'liberada', custoTeorico = ?, dataAtualizacao = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(explosao.custoTotal, id);
  });
  tx();

  // Saldo é conferido depois da transação: é aviso, não bloqueio, e uma
  // consulta a mais não justifica segurar a escrita.
  for (const i of explosao.itens) {
    const saldo = saldoDe(db, i.insumoProdutoId);
    if (saldo != null && saldo < i.quantidadePrevista) {
      avisos.push(`saldo insuficiente de "${i.insumoDescricao}": tem ${saldo}, `
        + `a OP precisa de ${i.quantidadePrevista.toFixed(4)}`);
    }
  }

  registrarEvento(db, id, 'liberada',
    `ficha congelada: ${explosao.itens.length} insumo(s), custo teórico ${explosao.custoTotal.toFixed(2)}`,
    'planejada', 'liberada', usuario);

  return { op: carregar(db, id), avisos };
}

function saldoDe(db, produtoId) {
  try {
    const { calcularSaldo } = require('../estoque-routes');
    return calcularSaldo(db, produtoId);
  } catch (_) {
    return null; // estoque não carregado neste processo: sem aviso de saldo
  }
}

/**
 * Registra uma movimentação de estoque no core, com custo médio e saldo
 * calculados pelo próprio estoque-routes quando disponível.
 *
 * ─── `data` É DATA PURA, E ISSO NÃO É DETALHE ───────────────────────────────
 * `estoque-routes.calcularCustoMedio` elege o custo médio vigente com
 * `ORDER BY data DESC, id DESC LIMIT 1` entre as linhas que têm
 * `custoMedioPosterior`. Todo o core grava `data` como 'YYYY-MM-DD'
 * (`dataBrasilia()`, estoque-routes.js:14). Uma linha com hora
 * ('2026-08-27 22:47:15') é lexicograficamente MAIOR que qualquer data-só do
 * mesmo dia — ela sequestraria a consulta e devolveria o custo médio de uma
 * movimentação anterior como se fosse o atual. Pior: o erro seria
 * materializado na movimentação seguinte e passaria a valer para o produto no
 * tenant inteiro (CMV, margem de pedido, valorização de inventário).
 *
 * Por isso aqui é `dataBrasilia()`, não `agora()`.
 */
function movimentar(db, { produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, usuario, depositoId }) {
  let ctx = { saldoPosterior: null, custoMedioAnterior: null, custoMedioPosterior: null };
  let deposito = depositoId ?? null;
  try {
    const estoque = require('../estoque-routes');
    ctx = estoque.calcularContextoMovimento(db, produtoId, tipo, quantidade, custoUnitario);
    // Sem depósito explícito a movimentação some do saldo POR depósito, ainda
    // que o total feche — o padrão do repo é resolver o depósito padrão.
    if (deposito == null) deposito = estoque.getDepositoPadraoId(db);
  } catch (_) { /* sem estoque-routes: grava a movimentação sem contexto */ }

  const r = db.prepare(`
    INSERT INTO movimentacoes_estoque
      (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data,
       custoMedioAnterior, custoMedioPosterior, saldoPosterior, usuario, depositoId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(produtoId, tipo, quantidade, custoUnitario ?? null, origem, origemId,
    observacao || null, dataBrasilia(), ctx.custoMedioAnterior, ctx.custoMedioPosterior,
    ctx.saldoPosterior, usuario || null, deposito);
  return r.lastInsertRowid;
}

/** Data pura no fuso de Brasília — cópia da de estoque-routes.js:14. */
function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

/**
 * Concretagem: baixa os insumos e inicia a cura.
 *
 * `quantidadeReal` por insumo é opcional — quando não informada, baixa o
 * previsto. Informar é o que permite ver a perda que ninguém mediu.
 */
function iniciarProcesso(db, id, dados, usuario) {
  const op = carregar(db, id);
  if (!op) return { erro: 'OP não encontrada' };
  if (op.status !== 'liberada') return { erro: `OP em status "${op.status}": só "liberada" pode ser em_processo` };

  const dataInicioProcesso = normalizarInstante(dados.dataInicioProcesso) || agora();

  let loteId = dados.loteId || null;
  if (loteId) {
    const lote = db.prepare('SELECT id FROM prod_lotes WHERE id = ?').get(loteId);
    if (!lote) return { erro: 'loteId não existe' };
  } else if (op.exigeEnsaioLiberacao) {
    // Sem lote não existe ensaio de transferência, e sem ensaio a peça nunca
    // sai da forma. Barrar aqui é mais honesto que barrar na desforma.
    return { erro: 'peça protendida exige loteId na concretagem: é o lote que carrega o ensaio de transferência' };
  }

  // Consumo real informado por insumo: { opInsumoId: quantidade }
  const reais = dados.consumoReal && typeof dados.consumoReal === 'object' ? dados.consumoReal : {};

  const tx = db.transaction(() => {
    let custoInsumo = 0;
    for (const ins of op.insumos) {
      const qReal = num(reais[ins.id], { min: 0 }) ?? ins.quantidadePrevista;
      const custo = qReal * ins.custoUnitario;
      const movId = movimentar(db, {
        produtoId: ins.insumoProdutoId,
        tipo: 'saida',
        quantidade: qReal,
        custoUnitario: ins.custoUnitario,
        origem: 'prod_ordem',
        origemId: id,
        observacao: `Consumo da OP ${op.numero}`,
        usuario,
      });
      db.prepare(`
        UPDATE prod_ordem_insumos
           SET quantidadeReal = ?, custoTotal = ?, movimentacaoId = ?
         WHERE id = ?
      `).run(qReal, custo, movId, ins.id);
      custoInsumo += custo;
    }

    db.prepare(`
      UPDATE prod_ordens
         SET status = 'em_processo', dataInicioProcesso = ?, dataFimPrevisto = ?,
             loteId = ?, ensaioLimiteExigido = ?,
             custoInsumo = ?, custoTotal = ? + custoMaoObra,
             dataAtualizacao = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(dataInicioProcesso, somarHoras(dataInicioProcesso, op.tempoProcessoHoras || 24),
      loteId, op.ensaioLimiteLiberacao ?? null, custoInsumo, custoInsumo, id);
  });
  tx();

  registrarEvento(db, id, 'em_processo',
    `concretagem registrada${loteId ? ` com lote #${loteId}` : ''}`,
    'liberada', 'em_processo', usuario);

  return { op: carregar(db, id) };
}

/**
 * Liberação da desforma. Duas condições: tempo de cura cumprido e — só em
 * protensão — ensaio de transferência aprovado.
 *
 * O bypass (`forcar`) existe porque a fábrica real tem exceção, mas grava
 * evento nominal com justificativa. Nunca é silencioso.
 */
function liberarSaida(db, id, dados, usuario, config = {}) {
  const op = carregar(db, id);
  if (!op) return { erro: 'OP não encontrada' };
  if (op.status !== 'em_processo') {
    return { erro: `OP em status "${op.status}": só "em_processo" pode liberar desforma` };
  }

  const avisos = [];
  const restante = op.dataFimPrevisto
    ? horasEntre(agora(), op.dataFimPrevisto)
    : null;
  if (restante != null && restante > 0) {
    avisos.push(`faltam ${restante.toFixed(1)}h para a desforma prevista`);
  }

  const check = podeLiberarSaida(db, op);
  if (!check.pode) {
    const permite = String(config.producao_permitir_liberacao_sem_ensaio || '0') === '1';
    const forcar = dados && (dados.forcar === true || dados.forcar === 1 || dados.forcar === '1');
    if (!permite || !forcar) {
      return { erro: check.motivo, exigeEnsaio: true };
    }
    const justificativa = String(dados.justificativa || '').trim();
    if (!justificativa) {
      return { erro: 'liberação forçada exige justificativa' };
    }
    registrarEvento(db, id, 'liberacao_forcada',
      `SEM ENSAIO APROVADO — ${check.motivo}. Justificativa: ${justificativa}`,
      'em_processo', 'liberada_saida', usuario);
    avisos.push('liberada SEM ensaio aprovado — evento registrado com justificativa e usuário');
  }

  db.prepare(`
    UPDATE prod_ordens SET status = 'liberada_saida', dataAtualizacao = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(id);

  if (check.pode) {
    registrarEvento(db, id, 'saida_liberada',
      check.exigeEnsaio
        ? `ensaio de transferência aprovado (${check.resistenciaMpa} MPa, CP #${check.corpoProvaId})`
        : 'sem liberação por ensaio nesta ficha',
      'em_processo', 'liberada_saida', usuario);
  }

  return { op: carregar(db, id), avisos };
}

/**
 * Conclusão: dá entrada da peça acabada no estoque e cria as peças
 * identificadas quando o tipo exige.
 *
 * O custo unitário da entrada é (insumo + mão de obra) ÷ peças BOAS. O refugo
 * não some do custo: ele encarece as peças que ficaram — que é exatamente o
 * que acontece na fábrica.
 */
function concluir(db, id, dados, usuario) {
  const op = carregar(db, id);
  if (!op) return { erro: 'OP não encontrada' };
  if (op.status !== 'liberada_saida') {
    return { erro: `OP em status "${op.status}": só "liberada_saida" pode ser concluída` };
  }

  // Default vem do que já foi apontado: o operador não deve ter de somar à mão
  // o que digitou peça a peça durante a semana.
  const { totaisApontados } = require('./apontamento');
  const apontado = totaisApontados(db, id);
  const produzida = num(dados.quantidadeProduzida, { min: 0 }) ?? apontado.quantidadeProduzida;
  const refugo = num(dados.quantidadeRefugo, { min: 0 }) ?? apontado.quantidadeRefugo;

  if (produzida <= 0) {
    return { erro: 'quantidadeProduzida deve ser > 0 (use cancelar se nada foi aproveitado)' };
  }
  if (refugo > 0 && !String(dados.motivoRefugo || '').trim() && !op.apontamentos.some(a => a.motivoRefugo)) {
    return { erro: 'refugo exige motivo — refugo sem motivo é número que não muda comportamento nenhum' };
  }

  // Peça identificada: ou vieram as identificações, ou o sistema as gera.
  const identificacoes = Array.isArray(dados.identificacoes)
    ? dados.identificacoes.map(s => String(s).trim()).filter(Boolean) : [];
  if (op.exigeIdentificacao) {
    // Peça identificada é contada uma a uma: fração não tem como virar peça.
    if (!Number.isInteger(produzida)) {
      return { erro: 'esta peça sai numerada: a quantidade produzida tem de ser inteira' };
    }
    if (identificacoes.length && identificacoes.length !== produzida) {
      return { erro: `esta peça exige identificação individual: informe ${produzida} `
        + `identificações (vieram ${identificacoes.length}) ou nenhuma para gerar automaticamente` };
    }
    // O UNIQUE de prod_unidades.identificacao estouraria dentro da
    // transação e sairia como 500. Recusar aqui devolve 400 com o motivo.
    const repetidas = identificacoes.filter((v, i) => identificacoes.indexOf(v) !== i);
    if (repetidas.length) {
      return { erro: `identificação repetida na lista: ${[...new Set(repetidas)].join(', ')}` };
    }
    if (identificacoes.length) {
      const jaUsadas = db.prepare(
        `SELECT identificacao FROM prod_unidades
          WHERE identificacao IN (${identificacoes.map(() => '?').join(',')})`
      ).all(...identificacoes).map(r => r.identificacao);
      if (jaUsadas.length) {
        return { erro: `identificação já usada em outra peça: ${jaUsadas.join(', ')}` };
      }
    }
  }

  const custoMaoObra = custoMaoObraDaOp(db, id);
  const custoTotal = op.custoInsumo + custoMaoObra;
  const custoUnitario = custoTotal / produzida;
  const dataConclusao = normalizarInstante(dados.dataConclusao) || agora();

  const tx = db.transaction(() => {
    movimentar(db, {
      produtoId: op.produtoId,
      tipo: 'entrada',
      quantidade: produzida,
      custoUnitario,
      origem: 'prod_ordem_producao',
      origemId: id,
      observacao: `Produção da OP ${op.numero}`,
      usuario,
    });

    if (op.exigeIdentificacao) {
      const insert = db.prepare(`
        INSERT INTO prod_unidades
          (opId, produtoId, identificacao, loteId, projetoId, dataInicioProcesso,
           dataFim, status, pesoKg)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'patio', ?)
      `);
      const total = Math.round(produzida);
      for (let i = 0; i < total; i++) {
        const ident = identificacoes[i] && String(identificacoes[i]).trim()
          ? String(identificacoes[i]).trim()
          : `${op.numero}-${String(i + 1).padStart(3, '0')}`;
        insert.run(id, op.produtoId, ident, op.loteId, op.projetoId,
          op.dataInicioProcesso, dataConclusao, op.pesoKg || null);
      }
    }

    db.prepare(`
      UPDATE prod_ordens
         SET status = 'concluida', quantidadeProduzida = ?, quantidadeRefugo = ?,
             dataFim = ?, dataConclusao = ?, custoMaoObra = ?, custoTotal = ?,
             dataAtualizacao = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(produzida, refugo, dataConclusao, dataConclusao, custoMaoObra, custoTotal, id);

    // Obra: a peça produzida abate o saldo a produzir do item.
    if (op.projetoItemId) {
      db.prepare(`
        UPDATE prod_projeto_itens SET quantidadeProduzida = quantidadeProduzida + ?
         WHERE id = ?
      `).run(produzida, op.projetoItemId);
    }
  });
  tx();

  registrarEvento(db, id, 'concluida',
    `${produzida} peça(s) boa(s), ${refugo} refugo(s); custo unitário ${custoUnitario.toFixed(2)}`,
    'liberada_saida', 'concluida', usuario);

  return { op: carregar(db, id), custoUnitario };
}

/**
 * Mão de obra apontada na OP: horas × pessoas × custo-hora.
 *
 * O custo-hora é UM só, da config `producao_custo_hora_padrao` — não o salário
 * individual. É deliberado: o apontamento é de equipe, e ratear o salário de
 * cada membro daria falsa precisão a um número cuja composição da equipe já é
 * uma aproximação. Com a config em 0 a mão de obra fica fora do custo, e o
 * painel avisa (ver a rota /ops/:id/custo) em vez de fingir precisão.
 */
function custoMaoObraDaOp(db, opId) {
  let total = 0;
  const apts = db.prepare(
    'SELECT id, equipeId, funcionarioId, horas, pessoas FROM prod_apontamentos WHERE opId = ?'
  ).all(opId);
  const custoPadrao = lerCustoHoraPadrao(db);

  for (const a of apts) {
    const pessoas = a.funcionarioId ? 1 : (a.pessoas || tamanhoEquipe(db, a.equipeId) || 0);
    total += (a.horas || 0) * pessoas * custoPadrao;
  }
  return total;
}

function lerCustoHoraPadrao(db) {
  try {
    const r = db.prepare("SELECT valor FROM config WHERE chave = 'producao_custo_hora_padrao'").get();
    const v = r ? Number(r.valor) : 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch (_) { return 0; }
}

function tamanhoEquipe(db, equipeId) {
  if (!equipeId) return 0;
  try {
    return db.prepare(
      'SELECT COUNT(*) n FROM prod_equipe_membros WHERE equipeId = ? AND ativo = 1'
    ).get(equipeId).n;
  } catch (_) { return 0; }
}

/**
 * Cancelamento. Depois da concretagem, estorna as baixas — o material já saiu
 * do estoque e sumir com ele em silêncio é a forma mais rápida de o saldo
 * deixar de bater.
 */
function cancelar(db, id, motivo, usuario) {
  const op = carregar(db, id);
  if (!op) return { erro: 'OP não encontrada' };
  if (op.status === 'cancelada') return { erro: 'OP já cancelada' };
  if (op.status === 'concluida') {
    return { erro: 'OP concluída não pode ser cancelada: a peça já entrou no estoque' };
  }
  if (!String(motivo || '').trim()) return { erro: 'motivo do cancelamento é obrigatório' };

  const tx = db.transaction(() => {
    if (STATUS_COM_BAIXA.includes(op.status)) {
      for (const ins of op.insumos) {
        if (ins.movimentacaoId && ins.quantidadeReal != null) {
          const movId = movimentar(db, {
            produtoId: ins.insumoProdutoId,
            tipo: 'entrada',
            quantidade: ins.quantidadeReal,
            custoUnitario: ins.custoUnitario,
            origem: 'prod_ordem_estorno',
            origemId: id,
            observacao: `Estorno do cancelamento da OP ${op.numero}`,
            usuario,
          });
          db.prepare('UPDATE movimentacoes_estoque SET estornada = 1, movEstornoId = ? WHERE id = ?')
            .run(movId, ins.movimentacaoId);
        }
      }
    }
    db.prepare(`
      UPDATE prod_ordens SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?
    `).run(id);
  });
  tx();

  registrarEvento(db, id, 'cancelada', motivo, op.status, 'cancelada', usuario);
  return { op: carregar(db, id) };
}

module.exports = {
  STATUS, ORIGENS, STATUS_COM_BAIXA,
  registrarEvento, carregar, conflitosDeForma, criar, liberar, iniciarProcesso,
  liberarSaida, concluir, cancelar, custoMaoObraDaOp, movimentar,
  lerCustoHoraPadrao, tamanhoEquipe,
};
