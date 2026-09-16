/**
 * contrato.js — o documento de locação e sua máquina de estados.
 *
 *   orcamento ──confirmar──> reservado ──entregar──> emAndamento
 *                                                        │
 *                                                    devolver
 *                                                        ▼
 *                                    encerrado <──faturar── devolvido
 *
 *   cancelado sai de `orcamento` ou `reservado`. Depois que o bem saiu
 *   fisicamente (emAndamento) não existe cancelar — existe devolver.
 *
 * A transição é o único lugar que mexe em reserva: confirmar grava, cancelar
 * libera. Item que muda de período depois de confirmado passa pela validação
 * de disponibilidade de novo, senão o documento e a agenda divergem em
 * silêncio.
 */

const {
  calcularTarifa, calcularCaucao, normalizarInstante, arredondar,
} = require('./tarifa');
const {
  criarReserva, cancelarReservasDoDocumento, disponibilidade,
} = require('./disponibilidade');

const STATUS = ['orcamento', 'reservado', 'emAndamento', 'devolvido', 'encerrado', 'cancelado'];

// De onde para onde se pode ir. Qualquer par fora daqui é 409.
const TRANSICOES = {
  orcamento:   ['reservado', 'cancelado'],
  reservado:   ['emAndamento', 'cancelado', 'orcamento'],
  emAndamento: ['devolvido'],
  devolvido:   ['encerrado'],
  encerrado:   [],
  cancelado:   [],
};

const TIPOS = ['avulsa', 'aberta'];
const NATUREZAS = ['locacao', 'servico'];

function podeTransicionar(de, para) {
  return !!(TRANSICOES[de] && TRANSICOES[de].includes(para));
}

/**
 * Número sequencial por ano: LOC-2026-0001.
 *
 * O sequencial sai do maior número JÁ GRAVADO do mesmo prefixo/ano, não de um
 * COUNT: contar linhas repetiria número depois de qualquer exclusão.
 */
function gerarNumero(db, prefixo, ano) {
  const p = `${prefixo || 'LOC'}-${ano}-`;
  const ultimo = db.prepare(`
    SELECT numero FROM locacao_contratos
    WHERE numero LIKE ? ORDER BY LENGTH(numero) DESC, numero DESC LIMIT 1
  `).get(p + '%');
  let n = 1;
  if (ultimo) {
    const m = String(ultimo.numero).match(/-(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return p + String(n).padStart(4, '0');
}

function registrarEvento(db, contratoId, tipo, dados = {}) {
  db.prepare(`
    INSERT INTO locacao_eventos
      (contratoId, tipo, descricao, statusAntes, statusDepois, valorAntes, valorDepois, usuario)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(contratoId, tipo, dados.descricao || null, dados.statusAntes || null,
         dados.statusDepois || null, dados.valorAntes ?? null, dados.valorDepois ?? null,
         dados.usuario || null);
}

/**
 * Recalcula os somatórios do contrato a partir dos itens e dos acertos.
 *
 * Locação e serviço somam separados porque têm destino fiscal diferente
 * (SV 31) — o total é só a soma dos dois mais os acertos.
 */
function recalcularTotais(db, contratoId) {
  const itens = db.prepare('SELECT natureza, valorTotal FROM locacao_itens WHERE contratoId = ?')
    .all(contratoId);
  let locacao = 0, servicos = 0, itensLocacao = 0;
  for (const i of itens) {
    if (i.natureza === 'servico') servicos += Number(i.valorTotal) || 0;
    else { locacao += Number(i.valorTotal) || 0; itensLocacao++; }
  }

  // ─── Valor mínimo de locação ───────────────────────────────────────────────
  //
  // É piso DO CONTRATO, não de cada item nem de cada unidade: uma locação de
  // 12 andaimes a R$ 20 vale R$ 240 e não sobe para R$ 960. O mínimo só age
  // quando o contrato inteiro fica abaixo dele.
  //
  // Por isso mora aqui e não em `calcularTarifa`: lá o cálculo é por item, e
  // não há como saber o total do contrato.
  //
  // Só incide sobre a LOCAÇÃO (o rótulo é "Valor Mínimo Locação") e só quando
  // já existe algum item — senão um contrato recém-criado, ainda vazio,
  // nasceria valendo o mínimo.
  const locacaoBruta = arredondar(locacao);
  let minimo = 0;
  try {
    const row = db.prepare("SELECT valor FROM config WHERE chave = 'locacao_valor_minimo'").get();
    minimo = Number(row && row.valor) || 0;
  } catch (_) { minimo = 0; }
  const aplicaMinimo = itensLocacao > 0 && minimo > 0 && locacaoBruta < minimo;
  if (aplicaMinimo) locacao = minimo;

  const acertos = db.prepare('SELECT natureza, valorTotal FROM locacao_acertos WHERE contratoId = ?')
    .all(contratoId);
  let extras = 0;
  for (const a of acertos) extras += Number(a.valorTotal) || 0;

  const total = arredondar(locacao + servicos + extras);
  db.prepare(`
    UPDATE locacao_contratos
    SET valorLocacao = ?, valorServicos = ?, valorExtras = ?, valorTotal = ?,
        dataAtualizacao = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(arredondar(locacao), arredondar(servicos), arredondar(extras), total, contratoId);

  return {
    valorLocacao: arredondar(locacao),
    valorServicos: arredondar(servicos),
    valorExtras: arredondar(extras),
    valorTotal: total,
    // Para a tela e o PDF explicarem o número: sem isto, o operador soma os
    // itens à mão e não bate com o total.
    valorLocacaoItens: locacaoBruta,
    minimoAplicado: aplicaMinimo,
    valorMinimo: minimo,
  };
}

/**
 * Preenche o preço de um item de locação a partir do tarifário.
 * Item de serviço tem preço digitado — não há faixa de tempo a aplicar.
 */
function precificarItem(db, item, cfg = {}) {
  if (item.natureza === 'servico') {
    const valorUnitario = Number(item.valorUnitario) || 0;
    const quantidade = Number(item.quantidade) > 0 ? Number(item.quantidade) : 1;
    return {
      ok: true,
      tarifaFaixa: null, tarifaValor: null, unidades: null,
      valorUnitario: arredondar(valorUnitario),
      valorTotal: arredondar(valorUnitario * quantidade),
    };
  }

  const tarifas = db.prepare('SELECT * FROM locacao_tarifas WHERE produtoId = ?').all(item.produtoId);
  // As regras do contrato de referência entram aqui: hora de corte da diária
  // e piso em reais. Ambas vêm da config do tenant e são opcionais.
  // O valor mínimo NÃO entra aqui: é piso do contrato, aplicado em
  // recalcularTotais depois de somar todos os itens.
  const calc = calcularTarifa(tarifas, item.dataInicio, item.dataFim, {
    quantidade: item.quantidade,
    horaCorte: cfg.locacao_hora_corte || null,
  });
  if (!calc.ok) return { ok: false, erro: calc.erro };

  return {
    ok: true,
    tarifaFaixa: calc.faixaPrincipal,
    tarifaValor: calc.valorUnitario,
    unidades: calc.horasFaturaveis,
    valorUnitario: calc.valorUnitario,
    valorTotal: calc.valorTotal,
    composicao: calc.composicao,
    diarias: calc.diarias,
  };
}

/**
 * Confirma o orçamento: valida a disponibilidade de cada item e grava as
 * reservas. Tudo numa transação — meia confirmação deixaria itens reservados
 * num documento que continua orçamento.
 */
function confirmar(db, contratoId, opts = {}) {
  const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
  if (!c) throw new Error('locação não encontrada');
  if (!podeTransicionar(c.status, 'reservado')) {
    const e = new Error(`não dá para confirmar uma locação com status "${c.status}"`);
    e.status = 409;
    throw e;
  }

  const itens = db.prepare(
    "SELECT * FROM locacao_itens WHERE contratoId = ? AND natureza = 'locacao'"
  ).all(contratoId);
  if (!itens.length) {
    const e = new Error('locação sem nenhum item de locação — não há o que reservar');
    e.status = 400;
    throw e;
  }

  const executar = db.transaction(() => {
    cancelarReservasDoDocumento(db, 'locacao', contratoId);
    for (const it of itens) {
      if (!it.produtoId) {
        const e = new Error(`item "${it.descricao}" não aponta produto — sem produto não há disponibilidade`);
        e.status = 400;
        throw e;
      }
      criarReserva(db, {
        produtoId: it.produtoId,
        serialNumberId: it.serialNumberId,
        quantidade: it.quantidade,
        inicio: it.dataInicio || c.dataSaidaPrevista,
        fim: it.dataFim || c.dataRetornoPrevisto,
        documentoTipo: 'locacao',
        documentoId: contratoId,
        locacaoItemId: it.id,
      }, { permitirOverbooking: !!opts.permitirOverbooking });
    }
    db.prepare(`UPDATE locacao_contratos SET status = 'reservado', dataAtualizacao = CURRENT_TIMESTAMP
                WHERE id = ?`).run(contratoId);
    registrarEvento(db, contratoId, 'confirmar', {
      statusAntes: c.status, statusDepois: 'reservado',
      descricao: `${itens.length} item(ns) reservado(s)`, usuario: opts.usuario,
    });
  });
  executar();

  return db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
}

function cancelar(db, contratoId, opts = {}) {
  const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
  if (!c) throw new Error('locação não encontrada');
  if (!podeTransicionar(c.status, 'cancelado')) {
    const e = new Error(
      c.status === 'emAndamento'
        ? 'o bem já saiu — registre a devolução em vez de cancelar'
        : `não dá para cancelar uma locação com status "${c.status}"`
    );
    e.status = 409;
    throw e;
  }

  const executar = db.transaction(() => {
    cancelarReservasDoDocumento(db, 'locacao', contratoId);
    db.prepare(`UPDATE locacao_contratos SET status = 'cancelado', dataAtualizacao = CURRENT_TIMESTAMP
                WHERE id = ?`).run(contratoId);
    registrarEvento(db, contratoId, 'cancelar', {
      statusAntes: c.status, statusDepois: 'cancelado',
      descricao: opts.motivo || null, usuario: opts.usuario,
    });
  });
  executar();

  return db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
}

/** Volta de reservado para orçamento — libera as reservas e permite reeditar. */
function reabrir(db, contratoId, opts = {}) {
  const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
  if (!c) throw new Error('locação não encontrada');
  if (!podeTransicionar(c.status, 'orcamento')) {
    const e = new Error(`não dá para reabrir uma locação com status "${c.status}"`);
    e.status = 409;
    throw e;
  }
  const executar = db.transaction(() => {
    cancelarReservasDoDocumento(db, 'locacao', contratoId);
    db.prepare(`UPDATE locacao_contratos SET status = 'orcamento', dataAtualizacao = CURRENT_TIMESTAMP
                WHERE id = ?`).run(contratoId);
    registrarEvento(db, contratoId, 'reabrir', {
      statusAntes: c.status, statusDepois: 'orcamento', usuario: opts.usuario,
    });
  });
  executar();
  return db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
}

/** Carrega o documento inteiro: itens, acertos, avarias, eventos e reservas. */
function carregar(db, contratoId) {
  const contrato = db.prepare(`
    SELECT c.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteDocumento
    FROM locacao_contratos c
    LEFT JOIN pessoas p ON p.id = c.clienteId
    WHERE c.id = ?
  `).get(contratoId);
  if (!contrato) return null;

  const itens = db.prepare(`
    SELECT i.*, pr.descricao AS produtoDescricao, pr.sku, sn.numero AS serie
    FROM locacao_itens i
    LEFT JOIN produtos pr ON pr.id = i.produtoId
    LEFT JOIN serial_numbers sn ON sn.id = i.serialNumberId
    WHERE i.contratoId = ? ORDER BY i.id
  `).all(contratoId);

  // Caução sugerida pelos itens. Até aqui o `caucaoPadrao` do cadastro não
  // alimentava nada — existia no item e o contrato só aceitava o valor
  // digitado à mão. Agora ele soma (fixo ou percentual, por item) e vira uma
  // sugestão; aplicar continua sendo decisão de quem monta o documento.
  let caucaoSugerida = 0;
  const caucaoDetalhe = [];
  for (const i of itens) {
    if (i.natureza === 'servico' || !i.produtoId) continue;
    const spec = db.prepare('SELECT * FROM locacao_item_specs WHERE produtoId = ?').get(i.produtoId);
    if (!spec) continue;
    const produto = db.prepare('SELECT precoVenda, precoCusto FROM produtos WHERE id = ?').get(i.produtoId);
    const c = calcularCaucao(spec, {
      valorLocacao: i.valorTotal, produto, quantidade: i.quantidade,
    });
    if (c.valor > 0 || c.aviso) {
      caucaoSugerida += c.valor;
      caucaoDetalhe.push({ itemId: i.id, descricao: i.descricao, ...c });
    }
  }

  // Recalcula sem gravar, só para a tela poder explicar o total quando o piso
  // do contrato entra: sem isto, somar os itens à mão não bate com o valor.
  const itensLoc = itens.filter(i => i.natureza !== 'servico');
  const somaItens = arredondar(itensLoc.reduce((a, i) => a + (Number(i.valorTotal) || 0), 0));
  let valorMinimo = 0;
  try {
    const row = db.prepare("SELECT valor FROM config WHERE chave = 'locacao_valor_minimo'").get();
    valorMinimo = Number(row && row.valor) || 0;
  } catch (_) { valorMinimo = 0; }

  return {
    contrato,
    itens,
    minimo: {
      valor: valorMinimo,
      somaItens,
      aplicado: itensLoc.length > 0 && valorMinimo > 0 && somaItens < valorMinimo,
    },
    caucaoSugerida: arredondar(caucaoSugerida),
    caucaoDetalhe,
    acertos: db.prepare('SELECT * FROM locacao_acertos WHERE contratoId = ? ORDER BY id').all(contratoId),
    avarias: db.prepare('SELECT * FROM locacao_avarias WHERE contratoId = ? ORDER BY id').all(contratoId),
    eventos: db.prepare('SELECT * FROM locacao_eventos WHERE contratoId = ? ORDER BY id DESC').all(contratoId),
    reservas: db.prepare(`
      SELECT * FROM locacao_reservas
      WHERE documentoTipo = 'locacao' AND documentoId = ? ORDER BY id
    `).all(contratoId),
    faturamentos: db.prepare('SELECT * FROM locacao_faturamentos WHERE contratoId = ? ORDER BY id').all(contratoId),
    avalistas: db.prepare('SELECT * FROM locacao_avalistas WHERE contratoId = ? ORDER BY ordem, id').all(contratoId),
  };
}

module.exports = {
  STATUS,
  TRANSICOES,
  TIPOS,
  NATUREZAS,
  podeTransicionar,
  gerarNumero,
  registrarEvento,
  recalcularTotais,
  precificarItem,
  confirmar,
  cancelar,
  reabrir,
  carregar,
  normalizarInstante,
  disponibilidade,
};
