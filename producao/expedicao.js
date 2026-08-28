/**
 * expedicao.js — pátio e romaneio (F2.2).
 *
 * ─── A SEQUÊNCIA DE DESCARGA NÃO É DETALHE ──────────────────────────────────
 * Numa obra, a peça que monta primeiro tem de sair do caminhão primeiro — ou
 * seja, subiu por último. Errar a ordem significa descarregar tudo no chão da
 * obra e recarregar, com guindaste alugado por hora parado ao lado.
 *
 * `prod_romaneio_itens.sequenciaDescarga` menor = sai primeiro. A validação do
 * carregamento confere a sequência antes de fechar a carga.
 *
 * ─── PESO É LIMITE LEGAL, NÃO SUGESTÃO ──────────────────────────────────────
 * Prancha tem capacidade e a fiscalização pesa. Por isso `fecharCarga` recusa
 * ultrapassar `capacidadeKg` em vez de avisar: um aviso ignorado vira multa e
 * carga retida com o guindaste esperando na obra.
 *
 * ─── PEÇA IDENTIFICADA × QUANTIDADE ─────────────────────────────────────────
 * Peça de obra viaja identificada (unidadeId): é ela que sai do pátio e
 * some do estoque físico daquela obra. Peça de catálogo viaja por quantidade —
 * um caminhão de 400 blocos não tem 400 identificações, e fingir que tem só
 * gera dado falso.
 */

const { num, normalizarData, normalizarInstante, gerarNumero, agora } = require('./prod-util');

const STATUS_ROMANEIO = ['montagem', 'carregado', 'transito', 'entregue', 'cancelado'];
const STATUS_PECA = ['produzindo', 'patio', 'expedida', 'montada', 'refugo'];

// `transito → carregado` é a volta do caminhão: carga recusada na obra,
// veículo que quebrou, endereço errado. Sem ela a única saída de `transito`
// era `entregue`, que baixa estoque e credita a obra — o romaneio ficava preso
// e as peças, em `expedida`, fora do pátio e fora da obra.
const TRANSICOES = {
  montagem: ['carregado', 'cancelado'],
  carregado: ['transito', 'montagem', 'cancelado'],
  transito: ['entregue', 'carregado'],
  entregue: [],
  cancelado: [],
};

function carregarRomaneio(db, id) {
  const r = db.prepare(`
    SELECT r.*, o.numero AS projetoNumero, o.nome AS projetoNome, o.comMontagem
      FROM prod_romaneios r
      LEFT JOIN prod_projetos o ON o.id = r.projetoId
     WHERE r.id = ?
  `).get(id);
  if (!r) return null;
  r.itens = db.prepare(`
    SELECT i.*, pr.descricao AS produtoDescricao, pp.identificacao, pp.posicaoPatio
      FROM prod_romaneio_itens i
      JOIN produtos pr ON pr.id = i.produtoId
      LEFT JOIN prod_unidades pp ON pp.id = i.unidadeId
     WHERE i.romaneioId = ?
     ORDER BY i.sequenciaDescarga, i.id
  `).all(id);
  return r;
}

function criarRomaneio(db, dados, usuario, config = {}) {
  if (dados.projetoId) {
    const o = db.prepare('SELECT id, status FROM prod_projetos WHERE id = ?').get(dados.projetoId);
    if (!o) return { erro: 'projetoId não existe' };
    if (['cancelada', 'concluida'].includes(o.status)) {
      return { erro: `obra ${o.status}: não aceita novo romaneio` };
    }
  }
  const data = normalizarData(dados.data) || normalizarData(agora());
  const cap = num(dados.capacidadeKg, { min: 0 });

  const prefixo = config.producao_prefixo_romaneio || 'ROM';
  const numero = gerarNumero(db, 'prod_romaneios', prefixo);

  const r = db.prepare(`
    INSERT INTO prod_romaneios
      (numero, projetoId, data, veiculoPlaca, veiculoTipo, motorista, capacidadeKg,
       status, observacoes, usuarioCriacao)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'montagem', ?, ?)
  `).run(numero, dados.projetoId || null, data, dados.veiculoPlaca || null,
    dados.veiculoTipo || null, dados.motorista || null, cap,
    dados.observacoes || null, usuario || null);

  return { romaneio: carregarRomaneio(db, r.lastInsertRowid) };
}

/**
 * Acrescenta item à carga.
 *
 * Duas formas: `unidadeId` (peça identificada) ou `produtoId` +
 * `quantidade` (catálogo). A peça identificada tem de estar no pátio — peça
 * já expedida em outro romaneio não pode viajar duas vezes, e o índice único
 * parcial em `unidadeId` garante isso mesmo se a validação falhar.
 */
function adicionarItem(db, romaneioId, dados) {
  const rom = carregarRomaneio(db, romaneioId);
  if (!rom) return { erro: 'romaneio não encontrado' };
  if (rom.status !== 'montagem') {
    return { erro: `romaneio em status "${rom.status}": só "montagem" aceita itens` };
  }

  let produtoId, quantidade, pesoKg, unidadeId = null;

  if (dados.unidadeId) {
    const pp = db.prepare('SELECT * FROM prod_unidades WHERE id = ?').get(dados.unidadeId);
    if (!pp) return { erro: 'unidadeId não existe' };
    if (pp.status !== 'patio') {
      return { erro: `a peça ${pp.identificacao} está "${pp.status}": só peça no pátio pode ser carregada` };
    }
    if (pp.projetoId && pp.projetoId !== rom.projetoId) {
      // Inclui o caso do romaneio SEM obra: uma peça de obra embarcada nele
      // saía da fábrica, baixava estoque e nunca era creditada — a obra ficava
      // com entrega zero e a peça não era faturável.
      return { erro: rom.projetoId
        ? `a peça ${pp.identificacao} é da obra #${pp.projetoId}, e este romaneio é da obra #${rom.projetoId}`
        : `a peça ${pp.identificacao} é da obra #${pp.projetoId}: o romaneio precisa ser dessa obra, `
          + 'senão a entrega não é creditada a ninguém' };
    }
    produtoId = pp.produtoId;
    quantidade = 1;
    pesoKg = num(dados.pesoKg, { min: 0 }) ?? pp.pesoKg ?? pesoDoProduto(db, produtoId);
    unidadeId = pp.id;
  } else {
    const p = db.prepare('SELECT id FROM produtos WHERE id = ?').get(dados.produtoId);
    if (!p) return { erro: 'produtoId não existe' };
    const q = num(dados.quantidade, { min: 0.0001 });
    if (q == null) return { erro: 'quantidade deve ser > 0' };

    // Peça que exige identificação não pode viajar por quantidade: é
    // justamente a rastreabilidade que se perderia.
    const peca = db.prepare('SELECT exigeIdentificacao FROM prod_fichas WHERE produtoId = ?').get(dados.produtoId);
    if (peca && peca.exigeIdentificacao) {
      return { erro: 'esta peça exige identificação individual: informe unidadeId, não quantidade' };
    }
    produtoId = dados.produtoId;
    quantidade = q;
    pesoKg = (num(dados.pesoKg, { min: 0 }) ?? pesoDoProduto(db, produtoId)) * q;
  }

  const seq = num(dados.sequenciaDescarga, { min: 0 }) ?? proximaSequencia(db, romaneioId);

  const r = db.prepare(`
    INSERT INTO prod_romaneio_itens
      (romaneioId, unidadeId, produtoId, quantidade, pesoKg, sequenciaDescarga)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(romaneioId, unidadeId, produtoId, quantidade, pesoKg || 0, seq);

  recalcularCarga(db, romaneioId);
  return { romaneio: carregarRomaneio(db, romaneioId), itemId: r.lastInsertRowid };
}

function pesoDoProduto(db, produtoId) {
  const p = db.prepare('SELECT pesoKg FROM prod_fichas WHERE produtoId = ?').get(produtoId);
  return p ? Number(p.pesoKg || 0) : 0;
}

function proximaSequencia(db, romaneioId) {
  return db.prepare(
    'SELECT COALESCE(MAX(sequenciaDescarga), 0) + 1 AS n FROM prod_romaneio_itens WHERE romaneioId = ?'
  ).get(romaneioId).n;
}

function removerItem(db, romaneioId, itemId) {
  const rom = db.prepare('SELECT status FROM prod_romaneios WHERE id = ?').get(romaneioId);
  if (!rom) return { erro: 'romaneio não encontrado' };
  if (rom.status !== 'montagem') {
    return { erro: `romaneio em status "${rom.status}": só "montagem" aceita remoção` };
  }
  const it = db.prepare('SELECT id FROM prod_romaneio_itens WHERE id = ? AND romaneioId = ?')
    .get(itemId, romaneioId);
  if (!it) return { erro: 'item não encontrado neste romaneio' };

  db.prepare('DELETE FROM prod_romaneio_itens WHERE id = ?').run(itemId);
  recalcularCarga(db, romaneioId);
  return { romaneio: carregarRomaneio(db, romaneioId) };
}

/** Reordena a descarga. Recebe [{itemId, sequencia}]. */
function reordenar(db, romaneioId, ordem) {
  const rom = db.prepare('SELECT status FROM prod_romaneios WHERE id = ?').get(romaneioId);
  if (!rom) return { erro: 'romaneio não encontrado' };
  if (!['montagem', 'carregado'].includes(rom.status)) {
    return { erro: `romaneio em status "${rom.status}": a ordem de descarga já não pode mudar` };
  }
  if (!Array.isArray(ordem) || !ordem.length) return { erro: 'ordem deve ser uma lista não vazia' };

  const up = db.prepare(
    'UPDATE prod_romaneio_itens SET sequenciaDescarga = ? WHERE id = ? AND romaneioId = ?'
  );
  // `changes === 0` = itemId que não é deste romaneio. Aceitar em silêncio
  // devolvia 200 para uma reordenação que não aconteceu.
  let erro = null;
  const tx = db.transaction(() => {
    for (const o of ordem) {
      const r = up.run(Number(o.sequencia), Number(o.itemId), romaneioId);
      if (r.changes === 0) { erro = `item #${o.itemId} não pertence a este romaneio`; return; }
    }
  });
  tx();
  if (erro) return { erro };
  return { romaneio: carregarRomaneio(db, romaneioId) };
}

function recalcularCarga(db, romaneioId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(pesoKg), 0) AS peso FROM prod_romaneio_itens WHERE romaneioId = ?
  `).get(romaneioId);
  const maior = db.prepare(`
    SELECT MAX(COALESCE(pc.comprimentoM, 0)) AS c
      FROM prod_romaneio_itens i
      LEFT JOIN prod_fichas pc ON pc.produtoId = i.produtoId
     WHERE i.romaneioId = ?
  `).get(romaneioId).c;

  db.prepare('UPDATE prod_romaneios SET pesoTotalKg = ?, comprimentoMaiorM = ? WHERE id = ?')
    .run(row.peso, maior || null, romaneioId);
}

/**
 * Fecha a carga: valida peso e sequência, e move as peças para `expedida`.
 *
 * O excesso de peso é ERRO, não aviso — ver o cabeçalho. Sequência duplicada
 * também barra: duas peças com o mesmo número de descarga significa que
 * ninguém decidiu qual sai primeiro, e quem decide na obra é o guindasteiro
 * com pressa.
 */
// A autoria do fechamento não é gravada aqui: a rota chama logAction, e o
// audit_log é onde o repo guarda "quem fez o quê" para ação sem entidade
// própria de evento.
function fecharCarga(db, romaneioId) {
  const rom = carregarRomaneio(db, romaneioId);
  if (!rom) return { erro: 'romaneio não encontrado' };
  if (rom.status !== 'montagem') {
    return { erro: `romaneio em status "${rom.status}": só "montagem" pode ser carregado` };
  }
  if (!rom.itens.length) return { erro: 'romaneio sem itens' };

  if (rom.capacidadeKg && rom.pesoTotalKg > rom.capacidadeKg) {
    return { erro: `excesso de peso: a carga tem ${rom.pesoTotalKg.toFixed(0)} kg e o `
      + `veículo comporta ${rom.capacidadeKg.toFixed(0)} kg. Retire peça(s) ou use outro veículo.` };
  }

  const seqs = rom.itens.map(i => i.sequenciaDescarga);
  const duplicadas = seqs.filter((s, idx) => seqs.indexOf(s) !== idx);
  if (duplicadas.length) {
    return { erro: `sequência de descarga repetida (${[...new Set(duplicadas)].join(', ')}): `
      + 'defina a ordem — é ela que evita descarregar o caminhão inteiro na obra' };
  }

  const tx = db.transaction(() => {
    for (const it of rom.itens) {
      if (it.unidadeId) {
        db.prepare(`
          UPDATE prod_unidades SET status = 'expedida', romaneioId = ? WHERE id = ?
        `).run(romaneioId, it.unidadeId);
      }
    }
    db.prepare(`
      UPDATE prod_romaneios SET status = 'carregado' WHERE id = ?
    `).run(romaneioId);
  });
  tx();

  return { romaneio: carregarRomaneio(db, romaneioId) };
}

function mudarStatus(db, romaneioId, novo, dados, usuario) {
  const rom = carregarRomaneio(db, romaneioId);
  if (!rom) return { erro: 'romaneio não encontrado' };
  if (!STATUS_ROMANEIO.includes(novo)) {
    return { erro: `status inválido: use ${STATUS_ROMANEIO.join(', ')}` };
  }
  if (!TRANSICOES[rom.status].includes(novo)) {
    return { erro: `transição inválida: de "${rom.status}" só se vai para `
      + `${TRANSICOES[rom.status].join(', ') || '(nenhum — status final)'}` };
  }

  const tx = db.transaction(() => {
    if (novo === 'transito') {
      db.prepare('UPDATE prod_romaneios SET status = ?, dataSaida = ? WHERE id = ?')
        .run(novo, normalizarInstante(dados && dados.dataSaida) || agora(), romaneioId);
    } else if (novo === 'entregue') {
      const dataEntrega = normalizarInstante(dados && dados.dataEntrega) || agora();
      db.prepare('UPDATE prod_romaneios SET status = ?, dataEntrega = ? WHERE id = ?')
        .run(novo, dataEntrega, romaneioId);
      // A peça entregue vira `montada` quando a obra tem montagem contratada;
      // sem montagem, o ciclo dela acaba na entrega.
      const statusPeca = rom.comMontagem ? 'montada' : 'expedida';
      for (const it of rom.itens) {
        if (it.unidadeId) {
          db.prepare('UPDATE prod_unidades SET status = ? WHERE id = ?')
            .run(statusPeca, it.unidadeId);
        }
      }
      // A SAÍDA DE ESTOQUE DA PEÇA ACABADA.
      //
      // `op.concluir` dá a ENTRADA (origem 'prod_ordem_producao'). Sem esta saída
      // o saldo do produto acabado só cresce: a fábrica veria no pátio peças
      // que já estão na obra do cliente. A baixa acontece na ENTREGA, não na
      // expedição — peça em trânsito ainda é da fábrica.
      //
      // Quando a emissão de NF-e da medição existir (gap declarado no plano),
      // a baixa migra para lá e este bloco sai: hoje é aqui ou em lugar nenhum.
      const { movimentar } = require('./ordem');
      for (const it of rom.itens) {
        movimentar(db, {
          produtoId: it.produtoId,
          tipo: 'saida',
          quantidade: it.quantidade,
          custoUnitario: custoMedio(db, it.produtoId),
          origem: 'prod_romaneio',
          origemId: romaneioId,
          observacao: `Entrega do romaneio ${rom.numero}`,
          usuario,
        });
      }
      // Abate o entregue nos itens da obra, um a um.
      if (rom.projetoId) {
        for (const it of rom.itens) {
          creditarEntrega(db, rom.projetoId, it.produtoId, it.quantidade,
            itemDaObraDaPeca(db, it.unidadeId));
        }
      }
    } else if (novo === 'montagem' || novo === 'cancelado') {
      // Devolve as peças ao pátio: a carga foi desfeita.
      for (const it of rom.itens) {
        if (it.unidadeId) {
          db.prepare(`
            UPDATE prod_unidades SET status = 'patio', romaneioId = NULL WHERE id = ?
          `).run(it.unidadeId);
        }
      }
      db.prepare('UPDATE prod_romaneios SET status = ? WHERE id = ?').run(novo, romaneioId);
    } else {
      db.prepare('UPDATE prod_romaneios SET status = ? WHERE id = ?').run(novo, romaneioId);
    }
  });
  tx();

  return { romaneio: carregarRomaneio(db, romaneioId) };
}

function custoMedio(db, produtoId) {
  try {
    const { calcularCustoMedio } = require('../estoque-routes');
    return calcularCustoMedio(db, produtoId) || null;
  } catch (_) { return null; }
}

/**
 * O item de obra ao qual a peça foi produzida, quando ela veio de uma OP
 * amarrada a um item.
 *
 * Peça de OBRA sabe exatamente qual linha do contrato ela atende
 * (`prod_ordens.projetoItemId`, validado em `op.criar`). Creditá-la por FIFO em vez
 * de usar esse vínculo faturava a linha errada: uma peça produzida para o
 * aditivo de R$ 1.500 era medida pelo lote original de R$ 1.000, e o painel
 * ainda dizia que faltava entregar aquela peça — para sempre.
 */
function itemDaObraDaPeca(db, unidadeId) {
  if (!unidadeId) return null;
  const r = db.prepare(`
    SELECT o.projetoItemId FROM prod_unidades pp
      JOIN prod_ordens o ON o.id = pp.opId
     WHERE pp.id = ?
  `).get(unidadeId);
  return r ? r.projetoItemId : null;
}

/**
 * Credita a entrega nos itens da obra.
 *
 * Quando a peça diz a qual item pertence (`projetoItemIdAlvo`), é nele que o
 * crédito cai — é o vínculo real, não uma heurística.
 *
 * Sem esse vínculo (peça de catálogo, que não passa por item de obra), cai no
 * FIFO por ordem de cadastro. Não existe UNIQUE(projetoId, produtoId) em
 * `prod_projeto_itens`, e é de propósito: o mesmo produto aparece duas vezes
 * quando há aditivo com preço diferente do lote original. Um UPDATE por
 * (projetoId, produtoId) creditaria a quantidade INTEIRA em cada linha.
 *
 * O que exceder o contratado é creditado na ÚLTIMA linha, e não descartado: a
 * coluna tem de refletir o que saiu de verdade. `percentualEntregue` acima de
 * 100% é informação correta — entregou-se mais do que se contratou — e a
 * prévia de medição trata o excedente em `naoContratados`, sem inventar preço.
 */
function creditarEntrega(db, projetoId, produtoId, quantidade, projetoItemIdAlvo = null) {
  const up = db.prepare('UPDATE prod_projeto_itens SET quantidadeEntregue = quantidadeEntregue + ? WHERE id = ?');

  if (projetoItemIdAlvo) {
    const alvo = db.prepare('SELECT id FROM prod_projeto_itens WHERE id = ? AND projetoId = ?')
      .get(projetoItemIdAlvo, projetoId);
    if (alvo) { up.run(Number(quantidade) || 0, alvo.id); return 0; }
    // Item apagado depois da produção: cai no FIFO abaixo.
  }

  const itens = db.prepare(`
    SELECT id, quantidade, quantidadeEntregue FROM prod_projeto_itens
     WHERE projetoId = ? AND produtoId = ? ORDER BY id
  `).all(projetoId, produtoId);
  if (!itens.length) return Number(quantidade) || 0;

  let restante = Number(quantidade) || 0;
  for (const it of itens) {
    if (restante <= 0) break;
    const cabe = Math.max(0, it.quantidade - it.quantidadeEntregue);
    if (cabe <= 0) continue;
    const credita = Math.min(cabe, restante);
    up.run(credita, it.id);
    restante -= credita;
  }
  // O excedente vai para a última linha: descartá-lo faria a coluna divergir
  // dos romaneios em silêncio, que é o pior dos dois mundos.
  if (restante > 0) up.run(restante, itens[itens.length - 1].id);
  return 0;
}

// ─── Pátio ───────────────────────────────────────────────────────────────────

/**
 * O que está no pátio, com idade. A idade importa: peça parada é capital
 * imobilizado ocupando área, e é o número que ninguém olha até acabar o espaço.
 */
function patio(db, filtro = {}) {
  const cond = ["pp.status = 'patio'"];
  const params = [];
  if (filtro.projetoId) { cond.push('pp.projetoId = ?'); params.push(filtro.projetoId); }
  if (filtro.produtoId) { cond.push('pp.produtoId = ?'); params.push(filtro.produtoId); }

  const pecas = db.prepare(`
    SELECT pp.*, pr.descricao AS produtoDescricao, o.numero AS projetoNumero, o.nome AS projetoNome,
           l.codigo AS loteCodigo, l.situacao AS loteSituacao,
           CAST(julianday('now') - julianday(pp.dataFim) AS INTEGER) AS diasNoPatio
      FROM prod_unidades pp
      JOIN produtos pr ON pr.id = pp.produtoId
      LEFT JOIN prod_projetos o ON o.id = pp.projetoId
      LEFT JOIN prod_lotes l ON l.id = pp.loteId
     WHERE ${cond.join(' AND ')}
     ORDER BY pp.dataFim
  `).all(...params);

  // Peça de catálogo não tem linha em prod_unidades: o pátio dela é o
  // saldo de estoque. Somar as duas fontes numa lista só faria parecer que
  // existem 400 blocos identificados.
  const catalogo = db.prepare(`
    SELECT p.produtoId, pr.descricao,
           COALESCE(SUM(CASE WHEN m.tipo = 'entrada' THEN m.quantidade
                             WHEN m.tipo = 'saida' THEN -m.quantidade
                             ELSE m.quantidade END), 0) AS saldo
      FROM prod_fichas p
      JOIN produtos pr ON pr.id = p.produtoId
      LEFT JOIN movimentacoes_estoque m ON m.produtoId = p.produtoId
     WHERE p.exigeIdentificacao = 0 AND p.ativo = 1
     GROUP BY p.produtoId
     HAVING saldo <> 0
  `).all();

  return {
    identificadas: pecas,
    catalogo,
    totais: {
      pecasIdentificadas: pecas.length,
      pesoTotalKg: pecas.reduce((s, p) => s + (p.pesoKg || 0), 0),
      maisAntigaDias: pecas.length ? Math.max(...pecas.map(p => p.diasNoPatio || 0)) : 0,
    },
  };
}

function moverPeca(db, pecaId, dados) {
  const pp = db.prepare('SELECT * FROM prod_unidades WHERE id = ?').get(pecaId);
  if (!pp) return { erro: 'peça não encontrada' };
  if (pp.status !== 'patio') {
    return { erro: `peça em status "${pp.status}": só peça no pátio muda de posição` };
  }
  db.prepare('UPDATE prod_unidades SET posicaoPatio = ? WHERE id = ?')
    .run(String(dados.posicaoPatio || '').trim() || null, pecaId);
  return { unidade: db.prepare('SELECT * FROM prod_unidades WHERE id = ?').get(pecaId) };
}

module.exports = {
  STATUS_ROMANEIO, STATUS_PECA, TRANSICOES,
  carregarRomaneio, criarRomaneio, adicionarItem, removerItem, reordenar,
  recalcularCarga, fecharCarga, mudarStatus, patio, moverPeca, creditarEntrega,
};
