/**
 * apuracao.js — o que acontece na entrega e, sobretudo, na devolução.
 *
 * A diferença entre `locacao_itens` e `locacao_acertos` é a espinha deste
 * arquivo: o item é o que foi COMBINADO, o acerto é o que ACONTECEU. Atraso,
 * avaria, medidor além da franquia e reposição nascem no retorno e não podem
 * reescrever o item — senão o documento deixa de provar o que foi contratado.
 *
 * A apuração é idempotente por tipo: reapurar não empilha duas multas de
 * atraso para a mesma devolução.
 */

const {
  calcularExcedenteMedidor, calcularMultaAtraso, calcularReposicao,
  normalizarInstante, arredondar,
} = require('./tarifa');
const { registrarEvento, recalcularTotais } = require('./contrato');

const TIPOS_ACERTO = ['atraso', 'avaria', 'medidor', 'reposicao', 'limpeza', 'entrega', 'desconto'];
const GRAVIDADES = ['leve', 'media', 'grave', 'perda'];

// Fim de reserva para item que não voltou: bloqueia a agenda por tempo
// indeterminado. Data alta e legível — o formato tem de continuar sendo
// 'YYYY-MM-DD HH:MM:SS' porque a sobreposição compara strings.
const HORIZONTE_ABERTO = '2099-12-31 23:59:59';

function gravarAcerto(db, contratoId, acerto) {
  // Idempotência: um acerto automático por (contrato, tipo, item). O manual
  // (avaria, desconto) pode repetir — cada avaria é uma linha.
  if (acerto.substituiAnterior) {
    db.prepare('DELETE FROM locacao_acertos WHERE contratoId = ? AND tipo = ? AND COALESCE(itemId,0) = ?')
      .run(contratoId, acerto.tipo, acerto.itemId || 0);
  }
  const info = db.prepare(`
    INSERT INTO locacao_acertos
      (contratoId, itemId, tipo, descricao, quantidade, valorUnitario, valorTotal, natureza, usuario)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(contratoId, acerto.itemId || null, acerto.tipo, acerto.descricao,
         Number(acerto.quantidade) || 1, arredondar(acerto.valorUnitario || 0),
         arredondar(acerto.valorTotal || 0), acerto.natureza || 'locacao', acerto.usuario || null);
  return info.lastInsertRowid;
}

/**
 * Valor de uma diária do item, para servir de base à multa de atraso.
 * Preferência: tarifa de diária cadastrada. Sem ela, o valor da locação
 * dividido pelos dias contratados — aproximação declarada, não invenção.
 */
function valorDiariaDoItem(db, item) {
  const t = db.prepare("SELECT valor FROM locacao_tarifas WHERE produtoId = ? AND faixa = 'dia' AND ativo = 1")
    .get(item.produtoId);
  if (t && Number(t.valor) > 0) return Number(t.valor) * (Number(item.quantidade) || 1);

  const ini = normalizarInstante(item.dataInicio);
  const fim = normalizarInstante(item.dataFim);
  if (!ini || !fim) return 0;
  const dias = Math.max(1, Math.ceil((new Date(fim.replace(' ', 'T')) - new Date(ini.replace(' ', 'T'))) / 86400000));
  return arredondar((Number(item.valorTotal) || 0) / dias);
}

/**
 * Registra a saída física: o bem foi entregue.
 *
 * As reservas passam a 'consumida' — continuam ocupando a agenda (o item está
 * na rua), mas agora dizem que a saída aconteceu. É essa distinção que faz o
 * painel separar "reservado para amanhã" de "está com o cliente".
 */
function entregar(db, contratoId, dados = {}) {
  const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
  if (!c) throw new Error('locação não encontrada');
  if (c.status !== 'reservado') {
    const e = new Error(
      c.status === 'orcamento'
        ? 'confirme a locação antes de entregar — sem reserva não há agenda'
        : `não dá para entregar uma locação com status "${c.status}"`
    );
    e.status = 409;
    throw e;
  }

  const dataSaida = normalizarInstante(dados.dataSaidaReal) || normalizarInstante(new Date());

  const executar = db.transaction(() => {
    // Leituras de medidor na saída, por item.
    for (const leitura of (dados.medidores || [])) {
      const item = db.prepare('SELECT * FROM locacao_itens WHERE id = ? AND contratoId = ?')
        .get(Number(leitura.itemId), contratoId);
      if (!item) continue;
      db.prepare('UPDATE locacao_itens SET medidorSaida = ? WHERE id = ?')
        .run(Number(leitura.valor), item.id);
      db.prepare(`INSERT INTO locacao_medidor_leituras
                    (produtoId, serialNumberId, contratoId, tipo, valor, origem, usuario)
                  VALUES (?, ?, ?, ?, ?, 'saida', ?)`)
        .run(item.produtoId, item.serialNumberId, contratoId,
             leitura.tipo || 'horimetro', Number(leitura.valor), dados.usuario || null);
    }

    db.prepare(`UPDATE locacao_reservas SET status = 'consumida'
                WHERE documentoTipo = 'locacao' AND documentoId = ? AND status = 'ativa'`)
      .run(contratoId);

    db.prepare(`UPDATE locacao_contratos
                SET status = 'emAndamento', dataSaidaReal = ?, osEntregaId = COALESCE(?, osEntregaId),
                    dataAtualizacao = CURRENT_TIMESTAMP
                WHERE id = ?`)
      .run(dataSaida, dados.osEntregaId || null, contratoId);

    registrarEvento(db, contratoId, 'entregar', {
      statusAntes: c.status, statusDepois: 'emAndamento',
      descricao: `Saída registrada em ${dataSaida}`, usuario: dados.usuario,
    });
  });
  executar();

  return db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
}

/**
 * Registra a devolução e apura o acerto.
 *
 * Ordem: grava as leituras → libera a agenda → calcula atraso, excedente de
 * medidor e reposição de item não devolvido → soma as avarias já registradas.
 *
 * @returns { contrato, acertos, resumo }
 */
function devolver(db, contratoId, dados = {}) {
  const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
  if (!c) throw new Error('locação não encontrada');
  if (c.status !== 'emAndamento') {
    const e = new Error(`só dá para devolver uma locação em andamento (status atual: "${c.status}")`);
    e.status = 409;
    throw e;
  }

  const cfg = dados.config || {};
  const dataRetorno = normalizarInstante(dados.dataRetornoReal) || normalizarInstante(new Date());
  const itens = db.prepare("SELECT * FROM locacao_itens WHERE contratoId = ? AND natureza = 'locacao'")
    .all(contratoId);

  const resumo = { atraso: null, medidores: [], naoDevolvidos: [], avarias: 0, limpeza: null };

  const executar = db.transaction(() => {
    // ── Leituras de retorno ──
    for (const leitura of (dados.medidores || [])) {
      const item = itens.find(i => i.id === Number(leitura.itemId));
      if (!item) continue;
      db.prepare('UPDATE locacao_itens SET medidorRetorno = ? WHERE id = ?')
        .run(Number(leitura.valor), item.id);
      item.medidorRetorno = Number(leitura.valor);
      db.prepare(`INSERT INTO locacao_medidor_leituras
                    (produtoId, serialNumberId, contratoId, tipo, valor, origem, usuario)
                  VALUES (?, ?, ?, ?, ?, 'retorno', ?)`)
        .run(item.produtoId, item.serialNumberId, contratoId,
             leitura.tipo || 'horimetro', Number(leitura.valor), dados.usuario || null);
    }

    // ── Itens não devolvidos ──
    // Lista explícita do que voltou; ausência significa que ficou com o cliente.
    const devolvidosIds = Array.isArray(dados.itensDevolvidos)
      ? dados.itensDevolvidos.map(Number)
      : itens.map(i => i.id); // sem lista, assume que voltou tudo

    for (const item of itens) {
      const voltou = devolvidosIds.includes(item.id);
      db.prepare('UPDATE locacao_itens SET devolvido = ?, dataDevolucao = ? WHERE id = ?')
        .run(voltou ? 1 : 0, voltou ? dataRetorno : null, item.id);

      if (!voltou) {
        // A reposição aceita valor fixo OU percentual do valor do bem; o
        // percentual vence quando preenchido, e cai no fixo se o produto não
        // tiver preço nenhum para servir de base.
        const spec = db.prepare('SELECT * FROM locacao_item_specs WHERE produtoId = ?')
          .get(item.produtoId);
        const produto = db.prepare('SELECT precoVenda, precoCusto FROM produtos WHERE id = ?')
          .get(item.produtoId);
        const rep = calcularReposicao(spec, { produto, quantidade: item.quantidade });

        resumo.naoDevolvidos.push({
          itemId: item.id, descricao: item.descricao,
          valorUnitario: rep.valorUnitario, modo: rep.modo,
          percentual: rep.percentual, aviso: rep.aviso,
        });

        if (rep.valor > 0) {
          const comoFoi = rep.modo === 'percentual'
            ? ` (${rep.percentual}% de ${rep.baseValor})`
            : '';
          gravarAcerto(db, contratoId, {
            itemId: item.id, tipo: 'reposicao', substituiAnterior: true,
            descricao: `Reposição — item não devolvido: ${item.descricao}${comoFoi}`,
            quantidade: item.quantidade, valorUnitario: rep.valorUnitario,
            valorTotal: rep.valor,
            usuario: dados.usuario,
          });
        }
      }
    }

    // ── Libera a agenda ──
    // Só o que voltou libera. O que ficou com o cliente continua ocupando —
    // não dá para alugar de novo o que não está no pátio.
    //
    // Manter o status não bastava: a reserva do item não devolvido continuava
    // com o `dataFim` CONTRATADO, então bastava a data prevista passar para a
    // máquina que está na rua (e já foi cobrada como reposição) reaparecer
    // livre no calendário. O fim é empurrado para um horizonte aberto, e só
    // uma devolução posterior o encerra.
    for (const item of itens) {
      const voltou = devolvidosIds.includes(item.id);
      if (voltou) {
        db.prepare(`UPDATE locacao_reservas SET status = 'devolvida'
                    WHERE documentoTipo = 'locacao' AND documentoId = ? AND locacaoItemId = ?
                      AND status IN ('ativa','consumida')`)
          .run(contratoId, item.id);
      } else {
        db.prepare(`UPDATE locacao_reservas
                    SET dataFim = ?, status = 'consumida',
                        observacoes = COALESCE(observacoes || ' | ', '') || 'item não devolvido em ' || ?
                    WHERE documentoTipo = 'locacao' AND documentoId = ? AND locacaoItemId = ?
                      AND status IN ('ativa','consumida')`)
          .run(HORIZONTE_ABERTO, dataRetorno, contratoId, item.id);
      }
    }

    // ── Atraso ──
    if (c.dataRetornoPrevisto) {
      const baseDiaria = itens.reduce((s, i) => s + valorDiariaDoItem(db, i), 0);
      const multa = calcularMultaAtraso(cfg, baseDiaria, c.dataRetornoPrevisto, dataRetorno);
      resumo.atraso = multa;
      // Substitui sempre: reapurar não empilha multa.
      db.prepare("DELETE FROM locacao_acertos WHERE contratoId = ? AND tipo = 'atraso'").run(contratoId);
      if (multa.aplicavel && multa.valorTotal > 0) {
        gravarAcerto(db, contratoId, {
          tipo: 'atraso',
          descricao: `Multa por devolução em atraso — ${multa.diasCobrados} dia(s) a ${multa.percentual}% da diária`,
          quantidade: multa.diasCobrados, valorUnitario: multa.valorDia,
          valorTotal: multa.valorTotal, usuario: dados.usuario,
        });
      }
    }

    // ── Excedente de medidor ──
    db.prepare("DELETE FROM locacao_acertos WHERE contratoId = ? AND tipo = 'medidor'").run(contratoId);
    for (const item of itens) {
      const spec = db.prepare('SELECT * FROM locacao_item_specs WHERE produtoId = ?').get(item.produtoId);
      if (!spec) continue;
      const extras = db.prepare(
        'SELECT * FROM locacao_tarifa_extras WHERE (produtoId = ? OR produtoId IS NULL) AND ativo = 1 ORDER BY produtoId DESC'
      ).all(item.produtoId);
      const dias = Math.max(1, Math.ceil(
        (new Date(String(item.dataFim || c.dataRetornoPrevisto || dataRetorno).replace(' ', 'T'))
         - new Date(String(item.dataInicio || c.dataSaidaPrevista).replace(' ', 'T'))) / 86400000
      ));
      const exc = calcularExcedenteMedidor(spec, extras, {
        medidorSaida: item.medidorSaida, medidorRetorno: item.medidorRetorno,
        dias, quantidade: item.quantidade,
      });
      if (exc.aplicavel) {
        resumo.medidores.push({ itemId: item.id, ...exc });
        gravarAcerto(db, contratoId, {
          itemId: item.id, tipo: 'medidor',
          descricao: `Excedente de ${exc.tipo === 'km_extra' ? 'km' : 'horas'} — ${exc.excedente} além da franquia de ${exc.franquiaTotal}`,
          quantidade: exc.excedente, valorUnitario: exc.valorUnitario,
          valorTotal: exc.valorTotal, usuario: dados.usuario,
        });
      }
    }

    // ── Limpeza como percentual do aluguel ──
    // Cláusula 6 do contrato de referência: "taxa de 40% sobre o valor total
    // da locação em caso de necessidade de limpeza". O valor fixo por item
    // continua existindo em Preços → Cobranças avulsas; este é o percentual,
    // e só entra quando quem devolve marca que precisa de limpeza.
    db.prepare("DELETE FROM locacao_acertos WHERE contratoId = ? AND tipo = 'limpeza'").run(contratoId);
    const pctLimpeza = Number(cfg.locacao_limpeza_percentual) || 0;
    if (dados.exigiuLimpeza && pctLimpeza > 0) {
      const baseLimpeza = Number(c.valorLocacao) || 0;
      const valorLimpeza = arredondar(baseLimpeza * (pctLimpeza / 100));
      if (valorLimpeza > 0) {
        gravarAcerto(db, contratoId, {
          tipo: 'limpeza',
          descricao: `Limpeza — ${pctLimpeza}% sobre a locação de ${baseLimpeza.toFixed(2)}`,
          quantidade: 1, valorUnitario: valorLimpeza, valorTotal: valorLimpeza,
          usuario: dados.usuario,
        });
        resumo.limpeza = { percentual: pctLimpeza, base: baseLimpeza, valorTotal: valorLimpeza };
      }
    }

    // ── Avarias já registradas viram acerto ──
    const avarias = db.prepare(
      'SELECT * FROM locacao_avarias WHERE contratoId = ? AND cobrada = 0 AND valorCobrado > 0'
    ).all(contratoId);
    for (const a of avarias) {
      gravarAcerto(db, contratoId, {
        itemId: a.itemId, tipo: 'avaria',
        descricao: `Avaria (${a.gravidade}): ${a.descricao}`,
        quantidade: 1, valorUnitario: a.valorCobrado, valorTotal: a.valorCobrado,
        usuario: dados.usuario,
      });
      db.prepare('UPDATE locacao_avarias SET cobrada = 1 WHERE id = ?').run(a.id);
      resumo.avarias += Number(a.valorCobrado) || 0;
    }

    db.prepare(`UPDATE locacao_contratos
                SET status = 'devolvido', dataRetornoReal = ?,
                    osDevolucaoId = COALESCE(?, osDevolucaoId), dataAtualizacao = CURRENT_TIMESTAMP
                WHERE id = ?`)
      .run(dataRetorno, dados.osDevolucaoId || null, contratoId);

    recalcularTotais(db, contratoId);

    registrarEvento(db, contratoId, 'devolver', {
      statusAntes: c.status, statusDepois: 'devolvido',
      descricao: `Retorno registrado em ${dataRetorno}`, usuario: dados.usuario,
    });
  });
  executar();

  return {
    contrato: db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId),
    acertos: db.prepare('SELECT * FROM locacao_acertos WHERE contratoId = ? ORDER BY id').all(contratoId),
    resumo,
  };
}

module.exports = {
  TIPOS_ACERTO,
  GRAVIDADES,
  entregar,
  devolver,
  gravarAcerto,
  valorDiariaDoItem,
};
