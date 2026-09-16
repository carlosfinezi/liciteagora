/**
 * disponibilidade.js — "este item está livre entre tal e tal dia?"
 *
 * É o núcleo do módulo, e a única resposta correta sobre disponibilidade de
 * locação. Ver o bloco "DUAS VERDADES" no topo de locacao-schema.js: existem
 * DOIS lugares que ocupam um produto — `reservas_estoque` (venda, quantidade
 * sem intervalo) e `locacao_reservas` (locação, com janela). Consultar só um
 * deles responde errado.
 *
 * disponivel = saldo físico
 *            − reservado para venda (reservas_estoque, sem data)
 *            − ocupado por locação sobreposta ao período
 *            − bloqueado (manutenção/quarentena) sobreposto ao período
 *
 * ─── Como a sobreposição é definida ─────────────────────────────────────────
 * Intervalos são SEMIABERTOS: [inicio, fim). Duas janelas conflitam quando
 *   inicio_a < fim_b  E  inicio_b < fim_a
 * Ou seja, uma reserva que termina às 10h e outra que começa às 10h NÃO
 * conflitam. É por isso que `horasPreparo` existe e já vem embutido no
 * `dataFim` gravado: se o item precisa de 4h de limpeza, quem grava a reserva
 * estende o fim, e o encaixe exato passa a ser recusado sozinho — sem nenhuma
 * regra especial no cálculo.
 */

const { normalizarInstante, somarHoras } = require('./tarifa');
const { calcularSaldo } = require('../estoque-routes');
const { saldoReservado } = require('../reservas-routes');

const STATUS_RESERVA_ATIVOS = ['ativa', 'consumida'];

/**
 * Quantidade ocupada por locações que se sobrepõem à janela.
 *
 * `status IN ('ativa','consumida')`: a consumida é a que já saiu fisicamente —
 * continua ocupando o período até a devolução. Só 'cancelada' e 'devolvida'
 * liberam.
 */
function ocupadoPorLocacao(db, produtoId, inicio, fim, opts = {}) {
  const ini = normalizarInstante(inicio);
  const f = normalizarInstante(fim);
  if (!ini || !f) return 0;

  let sql = `
    SELECT COALESCE(SUM(quantidade), 0) AS q
    FROM locacao_reservas
    WHERE produtoId = ?
      AND status IN ('ativa','consumida')
      AND dataInicio < ?
      AND ? < dataFim`;
  const params = [produtoId, f, ini];

  // Quem pergunta "quanto sobra para MIM" não pode ver a própria reserva como
  // indisponível — mesma razão do excetoPedidoId em reservas-routes.js.
  if (opts.excetoContratoId) {
    sql += " AND NOT (documentoTipo = 'locacao' AND documentoId = ?)";
    params.push(Number(opts.excetoContratoId));
  }
  if (opts.excetoReservaId) {
    sql += ' AND id != ?';
    params.push(Number(opts.excetoReservaId));
  }
  if (opts.serialNumberId) {
    sql += ' AND serialNumberId = ?';
    params.push(Number(opts.serialNumberId));
  }
  return db.prepare(sql).get(...params).q || 0;
}

/** Mesma sobreposição, para manutenção/quarentena. */
function bloqueadoNoPeriodo(db, produtoId, inicio, fim, opts = {}) {
  const ini = normalizarInstante(inicio);
  const f = normalizarInstante(fim);
  if (!ini || !f) return 0;

  let sql = `
    SELECT COALESCE(SUM(quantidade), 0) AS q
    FROM locacao_bloqueios
    WHERE produtoId = ?
      AND status = 'ativo'
      AND dataInicio < ?
      AND ? < dataFim`;
  const params = [produtoId, f, ini];
  if (opts.serialNumberId) {
    sql += ' AND serialNumberId = ?';
    params.push(Number(opts.serialNumberId));
  }
  return db.prepare(sql).get(...params).q || 0;
}

/**
 * Disponibilidade de um produto num período.
 *
 * @returns { produtoId, inicio, fim, saldoFisico, reservadoVenda,
 *            ocupadoLocacao, bloqueado, disponivel, conflitos }
 */
function disponibilidade(db, produtoId, inicio, fim, opts = {}) {
  const ini = normalizarInstante(inicio);
  const f = normalizarInstante(fim);
  if (!ini || !f) {
    return { ok: false, erro: 'período inválido', disponivel: 0 };
  }
  if (!(ini < f)) {
    return { ok: false, erro: 'fim deve ser depois do início', disponivel: 0 };
  }

  const spec = db.prepare('SELECT * FROM locacao_item_specs WHERE produtoId = ?').get(produtoId);
  if (!spec) {
    return { ok: false, erro: 'produto não é alugável (sem cadastro de locação)', disponivel: 0 };
  }
  if (!spec.alugavel) {
    return { ok: false, erro: 'produto está marcado como não alugável', disponivel: 0 };
  }

  // O fim considerado inclui o preparo: o item só volta a ficar livre depois
  // da limpeza/revisão.
  const fimComPreparo = spec.horasPreparo > 0 ? somarHoras(f, spec.horasPreparo) : f;

  const saldoFisico = calcularSaldo(db, produtoId);
  let reservadoVenda = 0;
  try { reservadoVenda = saldoReservado(db, produtoId); } catch (_) { reservadoVenda = 0; }
  const ocupadoLocacao = ocupadoPorLocacao(db, produtoId, ini, fimComPreparo, opts);
  const bloqueado = bloqueadoNoPeriodo(db, produtoId, ini, fimComPreparo, opts);

  const disponivel = saldoFisico - reservadoVenda - ocupadoLocacao - bloqueado;

  return {
    ok: true,
    produtoId,
    inicio: ini,
    fim: f,
    fimComPreparo,
    horasPreparo: spec.horasPreparo,
    exigeSerie: !!spec.exigeSerie,
    saldoFisico,
    reservadoVenda,
    ocupadoLocacao,
    bloqueado,
    disponivel: Math.max(0, disponivel),
    negativo: disponivel < 0,
  };
}

/**
 * Locações que ocupam o produto na janela — o "quem está com ele".
 * Sem isto a recusa vira "indisponível" e o balcão não sabe o que dizer.
 */
function conflitos(db, produtoId, inicio, fim, opts = {}) {
  const ini = normalizarInstante(inicio);
  const f = normalizarInstante(fim);
  if (!ini || !f) return [];

  let sql = `
    SELECT r.id AS reservaId, r.quantidade, r.dataInicio, r.dataFim, r.serialNumberId,
           r.documentoTipo, r.documentoId,
           c.numero, c.status,
           p.razaoSocial AS cliente
    FROM locacao_reservas r
    LEFT JOIN locacao_contratos c ON c.id = r.documentoId AND r.documentoTipo = 'locacao'
    LEFT JOIN pessoas p ON p.id = c.clienteId
    WHERE r.produtoId = ?
      AND r.status IN ('ativa','consumida')
      AND r.dataInicio < ?
      AND ? < r.dataFim`;
  const params = [produtoId, f, ini];
  if (opts.excetoContratoId) {
    sql += " AND NOT (r.documentoTipo = 'locacao' AND r.documentoId = ?)";
    params.push(Number(opts.excetoContratoId));
  }
  sql += ' ORDER BY r.dataInicio LIMIT 50';
  return db.prepare(sql).all(...params);
}

/**
 * Unidades (números de série) livres no período.
 *
 * Só faz sentido para produto com exigeSerie. Uma série está livre quando
 * nenhuma reserva/bloqueio dela cruza a janela — série reservada sem
 * serialNumberId definido (reserva genérica) não bloqueia série específica,
 * porque a escolha de qual unidade sai ainda não foi feita.
 */
function seriaisDisponiveis(db, produtoId, inicio, fim, opts = {}) {
  const ini = normalizarInstante(inicio);
  const f = normalizarInstante(fim);
  if (!ini || !f) return [];

  const spec = db.prepare('SELECT horasPreparo FROM locacao_item_specs WHERE produtoId = ?').get(produtoId);
  const fimComPreparo = spec && spec.horasPreparo > 0 ? somarHoras(f, spec.horasPreparo) : f;

  // Status válidos de serial_numbers são os de serial-routes.js:10 —
  // disponivel | reservado | baixado | estornado. Havia um 'locado' aqui que
  // NÃO existe no repo e nunca é gravado por ninguém; filtrar por ele não
  // quebrava nada porque 'disponivel' cobria o caso, mas era uma promessa
  // falsa. O módulo de locação NÃO altera serial_numbers.status: a agenda
  // (locacao_reservas) é a fonte da verdade sobre a unidade estar na rua.
  const seriais = db.prepare(`
    SELECT id, numero, status FROM serial_numbers
    WHERE produtoId = ? AND status IN ('disponivel','reservado')
    ORDER BY numero
  `).all(produtoId);

  return seriais.filter(s =>
    ocupadoPorLocacao(db, produtoId, ini, fimComPreparo, { ...opts, serialNumberId: s.id }) === 0
    && bloqueadoNoPeriodo(db, produtoId, ini, fimComPreparo, { serialNumberId: s.id }) === 0
  );
}

/**
 * Grava a reserva. Valida disponibilidade antes, salvo overbooking ligado.
 *
 * O `dataFim` gravado JÁ INCLUI horasPreparo — é isso que faz o encaixe exato
 * ser recusado sem regra especial no cálculo.
 */
function criarReserva(db, dados, opts = {}) {
  const {
    produtoId, serialNumberId, quantidade, inicio, fim,
    documentoTipo, documentoId, locacaoItemId, observacoes,
  } = dados;

  const ini = normalizarInstante(inicio);
  const f = normalizarInstante(fim);
  if (!ini || !f) throw new Error('período inválido');
  if (!(ini < f)) throw new Error('fim deve ser depois do início');

  const qtd = Number(quantidade) > 0 ? Number(quantidade) : 1;
  const spec = db.prepare('SELECT * FROM locacao_item_specs WHERE produtoId = ?').get(produtoId);
  if (!spec) throw new Error('produto não é alugável (sem cadastro de locação)');
  if (spec.exigeSerie && !serialNumberId) {
    throw new Error('este item exige número de série — informe qual unidade sai');
  }

  if (!opts.permitirOverbooking) {
    // NÃO passa `excetoContratoId` aqui, e isso é deliberado.
    //
    // Passava, e o efeito era overbooking silencioso: `confirmar` grava as
    // reservas do documento num laço, e excluir "as reservas deste contrato"
    // fazia cada item ignorar o que os itens anteriores do MESMO contrato
    // acabaram de reservar. Um contrato com dois itens de 2 unidades passava
    // com 3 em estoque. Quem precisa reservar de novo (reabrir/reconfirmar)
    // cancela as anteriores antes — `confirmar` faz exatamente isso — então
    // não há conflito falso a evitar.
    const d = disponibilidade(db, produtoId, ini, f, {
      serialNumberId: serialNumberId || null,
    });
    if (!d.ok) throw new Error(d.erro);
    // Com série, a unidade é uma só: o limite é 1 MENOS o que já ocupa
    // aquela série no período. Era `1` fixo, o que deixava a mesma máquina
    // ser alugada duas vezes para os mesmos dias.
    const limite = serialNumberId
      ? Math.max(0, 1 - d.ocupadoLocacao - d.bloqueado)
      : d.disponivel;
    if (qtd > limite) {
      const c = conflitos(db, produtoId, ini, f, {});
      const quem = c.length
        ? ` Ocupado por: ${c.slice(0, 3).map(x => `${x.numero || 'reserva #' + x.reservaId} (${x.dataInicio} → ${x.dataFim})`).join('; ')}`
        : '';
      throw new Error(`indisponível no período: pedido ${qtd}, disponível ${limite}.${quem}`);
    }
  }

  const fimGravado = spec.horasPreparo > 0 ? somarHoras(f, spec.horasPreparo) : f;

  const info = db.prepare(`
    INSERT INTO locacao_reservas
      (produtoId, serialNumberId, quantidade, dataInicio, dataFim, status,
       documentoTipo, documentoId, locacaoItemId, observacoes)
    VALUES (?, ?, ?, ?, ?, 'ativa', ?, ?, ?, ?)
  `).run(produtoId, serialNumberId || null, qtd, ini, fimGravado,
         documentoTipo || null, documentoId || null, locacaoItemId || null, observacoes || null);

  return db.prepare('SELECT * FROM locacao_reservas WHERE id = ?').get(info.lastInsertRowid);
}

function cancelarReservasDoDocumento(db, documentoTipo, documentoId) {
  return db.prepare(`
    UPDATE locacao_reservas SET status = 'cancelada'
    WHERE documentoTipo = ? AND documentoId = ? AND status = 'ativa'
  `).run(documentoTipo, documentoId).changes;
}

/**
 * Grade de ocupação por dia — o que a tela de calendário desenha.
 * Devolve uma linha por produto com um vetor de dias.
 */
function calendario(db, de, ate, opts = {}) {
  const ini = normalizarInstante(de);
  const fim = normalizarInstante(ate);
  if (!ini || !fim || !(ini < fim)) return { ok: false, erro: 'período inválido', linhas: [] };

  let sqlProdutos = `
    SELECT s.produtoId, p.descricao, p.sku, p.categoria, s.exigeSerie, s.horasPreparo
    FROM locacao_item_specs s
    JOIN produtos p ON p.id = s.produtoId
    WHERE s.alugavel = 1`;
  const params = [];
  if (opts.produtoId) { sqlProdutos += ' AND s.produtoId = ?'; params.push(Number(opts.produtoId)); }
  if (opts.categoria) { sqlProdutos += ' AND p.categoria = ?'; params.push(opts.categoria); }
  sqlProdutos += ' ORDER BY p.descricao';
  const produtos = db.prepare(sqlProdutos).all(...params);

  const dias = [];
  const umDia = 24 * 3600 * 1000;
  const msIni = new Date(ini.replace(' ', 'T')).getTime();
  const msFim = new Date(fim.replace(' ', 'T')).getTime();
  // Teto de 180 dias: além disso a grade não cabe na tela e a consulta cresce
  // sem servir a ninguém.
  for (let t = msIni, n = 0; t < msFim && n < 180; t += umDia, n++) {
    dias.push(normalizarInstante(new Date(t)).slice(0, 10));
  }

  const linhas = produtos.map(p => {
    const celulas = dias.map(d => {
      const dIni = `${d} 00:00:00`;
      const dFim = `${d} 23:59:59`;
      const ocupado = ocupadoPorLocacao(db, p.produtoId, dIni, dFim);
      const bloq = bloqueadoNoPeriodo(db, p.produtoId, dIni, dFim);
      return { dia: d, ocupado, bloqueado: bloq };
    });
    return { ...p, saldoFisico: calcularSaldo(db, p.produtoId), dias: celulas };
  });

  return { ok: true, de: ini, ate: fim, dias, linhas };
}

module.exports = {
  STATUS_RESERVA_ATIVOS,
  disponibilidade,
  ocupadoPorLocacao,
  bloqueadoNoPeriodo,
  conflitos,
  seriaisDisponiveis,
  criarReserva,
  cancelarReservasDoDocumento,
  calendario,
};
