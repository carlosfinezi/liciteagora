/**
 * faturamento.js — o dinheiro da locação.
 *
 * ─── Por que locação e serviço nunca somam numa linha só ────────────────────
 * Súmula Vinculante 31: ISS não incide sobre locação de bem móvel. Mas o STF
 * afasta a súmula quando, num contrato complexo, a locação NÃO está claramente
 * segmentada da prestação de serviço — nem no objeto nem no valor. Por isso o
 * faturamento gera SEMPRE dois blocos de valor a partir de `natureza`:
 *
 *   natureza='locacao' → fatura/recibo + NF-e de remessa/retorno (sem ISS)
 *   natureza='servico' → NFS-e (com ISS)
 *
 * Este arquivo NÃO emite documento fiscal: ele separa, gera o título a receber
 * e deixa os ganchos (`nfseId`, `nfeId`) para o fiscal preencher. A emissão
 * depende dos CFOPs de remessa/retorno, que ainda não foram conferidos com o
 * contador — ver docs/modulo-locacao-plano-2026-08-27.md.
 *
 * ─── A caução não é receita ─────────────────────────────────────────────────
 * É dinheiro que entra e pode voltar inteiro. Se entrar como CR comum,
 * contamina o DRE do mês. Por isso ela tem título próprio, com
 * `origemTipo='locacao_caucao'`, e três desfechos possíveis: devolvida,
 * abatida do acerto, ou retida.
 */

const { arredondar, normalizarInstante } = require('./tarifa');
const { registrarEvento, recalcularTotais } = require('./contrato');

const STATUS_CAUCAO = ['nao_aplicavel', 'pendente', 'retido', 'devolvido', 'abatido'];

const EVENTOS_NOTIFICACAO = [
  'retorno_amanha',
  'retorno_atrasado',
  'contrato_vencendo',
  'caucao_a_devolver',
];

/** Vencimento a partir do dia configurado, a contar da data base. */
function calcularVencimento(dataBase, diaVencimento) {
  const base = normalizarInstante(dataBase) || normalizarInstante(new Date());
  const [ano, mes, dia] = base.slice(0, 10).split('-').map(Number);
  const alvo = Number(diaVencimento);
  if (!Number.isFinite(alvo) || alvo < 1 || alvo > 28) return base.slice(0, 10);
  // Se o dia já passou no mês corrente, vai para o mês seguinte.
  const mesAlvo = dia <= alvo ? mes : mes + 1;
  const d = new Date(ano, mesAlvo - 1, alvo);
  return normalizarInstante(d).slice(0, 10);
}

/**
 * Fatura uma locação.
 *
 * @param opts { competencia, dataVencimento, gerarCR }
 * @returns { faturamentoId, valorLocacao, valorServicos, valorExtras, valorTotal, contaReceberId }
 */
function faturar(db, contratoId, opts = {}) {
  const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
  if (!c) throw new Error('locação não encontrada');

  // Avulsa só fatura depois de devolvida: antes disso o acerto (atraso,
  // avaria, medidor) ainda não existe, e faturar agora seria refaturar depois.
  if (c.tipo === 'avulsa' && !['devolvido', 'encerrado'].includes(c.status)) {
    const e = new Error(
      `locação avulsa só é faturada depois da devolução (status atual: "${c.status}")`
    );
    e.status = 409;
    throw e;
  }
  // Aberta fatura por ciclo, enquanto o bem estiver na rua.
  if (c.tipo === 'aberta' && !['emAndamento', 'devolvido', 'encerrado'].includes(c.status)) {
    const e = new Error(`locação aberta só fatura a partir da entrega (status atual: "${c.status}")`);
    e.status = 409;
    throw e;
  }

  const competencia = opts.competencia || null;
  if (competencia && !/^\d{4}-\d{2}$/.test(competencia)) {
    const e = new Error("competência deve ser 'YYYY-MM'");
    e.status = 400;
    throw e;
  }
  // Trava de duplicidade. Vivia dentro do `if (competencia)`, e por isso a
  // locação AVULSA — que não tem competência — não tinha trava nenhuma: dois
  // cliques no botão "Faturar" geravam dois títulos de valor cheio. Agora
  // qualquer faturamento repetido é recusado, e refaturar exige dizer que é
  // isso mesmo que se quer.
  if (!opts.permitirRefaturar) {
    const jaTem = competencia
      ? db.prepare(`SELECT id FROM locacao_faturamentos
                    WHERE contratoId = ? AND competencia = ? AND status <> 'cancelado'`)
          .get(contratoId, competencia)
      : db.prepare(`SELECT id FROM locacao_faturamentos
                    WHERE contratoId = ? AND status <> 'cancelado'`)
          .get(contratoId);
    if (jaTem) {
      const e = new Error(
        competencia
          ? `competência ${competencia} já foi faturada (faturamento #${jaTem.id})`
          : `esta locação já foi faturada (faturamento #${jaTem.id}) — cancele-o ou use permitirRefaturar`
      );
      e.status = 409;
      throw e;
    }
  }

  recalcularTotais(db, contratoId);
  const atual = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);

  const valorLocacao = arredondar(atual.valorLocacao);
  const valorServicos = arredondar(atual.valorServicos);
  const valorExtras = arredondar(atual.valorExtras);
  const valorTotal = arredondar(valorLocacao + valorServicos + valorExtras);

  if (!(valorTotal > 0)) {
    const e = new Error('não há valor a faturar');
    e.status = 400;
    throw e;
  }

  const vencimento = opts.dataVencimento
    || calcularVencimento(atual.dataRetornoReal || atual.dataRetornoPrevisto || new Date(), atual.diaVencimento);
  const emissao = normalizarInstante(new Date()).slice(0, 10);

  let faturamentoId = null;
  let contaReceberId = null;

  const executar = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO locacao_faturamentos
        (contratoId, competencia, dataInicio, dataFim, valorLocacao, valorServicos,
         valorExtras, valorTotal, status, observacoes, usuario)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'gerado', ?, ?)
    `).run(contratoId, competencia,
           atual.dataSaidaReal || atual.dataSaidaPrevista,
           atual.dataRetornoReal || atual.dataRetornoPrevisto,
           valorLocacao, valorServicos, valorExtras, valorTotal,
           opts.observacoes || null, opts.usuario || null);
    faturamentoId = info.lastInsertRowid;

    if (opts.gerarCR !== false) {
      const desc = `Locação ${atual.numero}`
        + (competencia ? ` — competência ${competencia}` : '')
        + (valorServicos > 0 ? ` (locação ${valorLocacao.toFixed(2)} + serviços ${valorServicos.toFixed(2)})` : '');
      // Status 'aberta', não 'pendente'. O vocabulário real de
      // contas_a_receber neste repo é aberta | parcial | paga | cancelada |
      // incobravel (é o DEFAULT do schema e o que existe nos tenants).
      // 'pendente' fazia o título ser recusado na baixa
      // (contas-receber-routes.js) e sumir do aging, do total a receber, do
      // DRE e da cobrança automática — receita de locação que não chegava a
      // lugar nenhum.
      const cr = db.prepare(`
        INSERT INTO contas_a_receber
          (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, origem, origemTipo, observacoes)
        VALUES (?, ?, ?, ?, ?, 'aberta', 'locacao', 'locacao', ?)
      `).run(atual.clienteId, desc, valorTotal, emissao, vencimento,
             `Faturamento #${faturamentoId} da locação ${atual.numero}`);
      contaReceberId = cr.lastInsertRowid;
      db.prepare('UPDATE locacao_faturamentos SET contaReceberId = ? WHERE id = ?')
        .run(contaReceberId, faturamentoId);
    }

    registrarEvento(db, contratoId, 'faturar', {
      descricao: `Faturamento #${faturamentoId}` + (competencia ? ` (${competencia})` : ''),
      valorDepois: valorTotal, usuario: opts.usuario,
    });
  });
  executar();

  return {
    faturamentoId, contaReceberId,
    valorLocacao, valorServicos, valorExtras, valorTotal,
    dataVencimento: vencimento,
    // O que cada bloco vira no fiscal. Nenhum documento é emitido aqui.
    destinoFiscal: {
      locacao: valorLocacao + valorExtras > 0 ? 'fatura/NF-e de remessa (sem ISS — SV 31)' : null,
      servico: valorServicos > 0 ? 'NFS-e (com ISS)' : null,
    },
  };
}

/** Encerra a locação: só depois de faturada. */
function encerrar(db, contratoId, opts = {}) {
  const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
  if (!c) throw new Error('locação não encontrada');
  if (c.status !== 'devolvido') {
    const e = new Error(`só dá para encerrar uma locação devolvida (status atual: "${c.status}")`);
    e.status = 409;
    throw e;
  }
  const temFatura = db.prepare(
    "SELECT id FROM locacao_faturamentos WHERE contratoId = ? AND status <> 'cancelado'"
  ).get(contratoId);
  if (!temFatura && !opts.semFaturar) {
    const e = new Error('fature a locação antes de encerrar (ou passe semFaturar:true)');
    e.status = 409;
    throw e;
  }
  // Caução pendente de destino é a pendência que mais gera reclamação depois.
  if (c.caucaoStatus === 'retido' || c.caucaoStatus === 'pendente') {
    if (Number(c.caucaoValor) > 0 && !opts.ignorarCaucao) {
      const e = new Error(
        `a caução de ${Number(c.caucaoValor).toFixed(2)} ainda está "${c.caucaoStatus}" — devolva ou abata antes de encerrar`
      );
      e.status = 409;
      throw e;
    }
  }

  db.prepare(`UPDATE locacao_contratos SET status = 'encerrado', dataAtualizacao = CURRENT_TIMESTAMP
              WHERE id = ?`).run(contratoId);
  registrarEvento(db, contratoId, 'encerrar', {
    statusAntes: c.status, statusDepois: 'encerrado', usuario: opts.usuario,
  });
  return db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
}

// ─── Caução ────────────────────────────────────────────────────────────────

/** Registra o recebimento da caução — título próprio, fora da receita. */
function receberCaucao(db, contratoId, opts = {}) {
  const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
  if (!c) throw new Error('locação não encontrada');
  if (!(Number(c.caucaoValor) > 0)) {
    const e = new Error('esta locação não tem caução definida');
    e.status = 400;
    throw e;
  }
  if (c.caucaoStatus === 'retido') {
    const e = new Error('caução já registrada como recebida');
    e.status = 409;
    throw e;
  }

  const emissao = normalizarInstante(new Date()).slice(0, 10);

  // A caução é obrigação de devolver, não receita — mas o DRE
  // (gerencial-routes.js:308) soma TODO contas_a_receber com status
  // aberta/paga/parcial, agrupando por plano de contas. Sem um plano
  // patrimonial apontado, a garantia entra no resultado do mês.
  //
  // Antes isso "funcionava" por acidente: o título nascia com um status
  // inválido ('pendente'), que o DRE ignorava — e que também impedia a baixa.
  // Agora a exclusão é uma decisão explícita do tenant: aponte a conta em
  // `locacao_caucao_plano_conta_id` e a caução vai para ela.
  let planoContaId = null;
  let avisoPlano = null;
  try {
    const row = db.prepare("SELECT valor FROM config WHERE chave = 'locacao_caucao_plano_conta_id'").get();
    if (row && Number(row.valor) > 0) planoContaId = Number(row.valor);
  } catch (_) { /* sem config */ }
  if (!planoContaId) {
    avisoPlano = 'caução sem plano de contas próprio: configure '
      + '`locacao_caucao_plano_conta_id` (conta patrimonial), senão ela entra no DRE como receita';
  }

  const cr = db.prepare(`
    INSERT INTO contas_a_receber
      (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, origem, origemTipo,
       planoContaId, observacoes)
    VALUES (?, ?, ?, ?, ?, ?, 'locacao', 'locacao_caucao', ?, ?)
  `).run(c.clienteId, `Caução da locação ${c.numero}`, arredondar(c.caucaoValor),
         emissao, opts.dataVencimento || emissao,
         opts.recebida === false ? 'aberta' : 'paga',
         planoContaId,
         `Caução da locação ${c.numero}. GARANTIA — NÃO é receita: devolvida `
         + 'ou abatida no encerramento. Não deve entrar em apuração de resultado.');

  db.prepare(`UPDATE locacao_contratos SET caucaoStatus = 'retido', caucaoContaReceberId = ?,
              dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(cr.lastInsertRowid, contratoId);
  registrarEvento(db, contratoId, 'caucao_recebida', {
    valorDepois: c.caucaoValor, usuario: opts.usuario,
  });

  return {
    contaReceberId: cr.lastInsertRowid,
    valor: arredondar(c.caucaoValor),
    planoContaId,
    aviso: avisoPlano,
  };
}

/**
 * Dá destino à caução: devolver, abater do acerto, ou reter.
 * Abater cria um acerto NEGATIVO — é o valor que deixa de ser cobrado.
 */
function destinarCaucao(db, contratoId, destino, opts = {}) {
  const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
  if (!c) throw new Error('locação não encontrada');
  if (!['devolvido', 'abatido', 'retido'].includes(destino)) {
    const e = new Error(`destino inválido: ${destino}`);
    e.status = 400;
    throw e;
  }
  if (c.caucaoStatus !== 'retido') {
    const e = new Error(`a caução não está retida (status atual: "${c.caucaoStatus}")`);
    e.status = 409;
    throw e;
  }

  const valor = arredondar(c.caucaoValor);
  const executar = db.transaction(() => {
    if (destino === 'abatido') {
      const valorAbatido = Number(opts.valor) > 0 ? Math.min(arredondar(opts.valor), valor) : valor;
      db.prepare(`
        INSERT INTO locacao_acertos
          (contratoId, tipo, descricao, quantidade, valorUnitario, valorTotal, natureza, usuario)
        VALUES (?, 'desconto', ?, 1, ?, ?, 'locacao', ?)
      `).run(contratoId, `Abatimento da caução da locação ${c.numero}`,
             valorAbatido, -valorAbatido, opts.usuario || null);
      recalcularTotais(db, contratoId);
    }
    db.prepare(`UPDATE locacao_contratos SET caucaoStatus = ?, dataAtualizacao = CURRENT_TIMESTAMP
                WHERE id = ?`).run(destino, contratoId);
    registrarEvento(db, contratoId, `caucao_${destino}`, {
      valorAntes: valor, descricao: opts.motivo || null, usuario: opts.usuario,
    });
  });
  executar();

  return db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
}

// ─── Contrato aberto: ponte com `contratos` core ────────────────────────────

/**
 * Cria (ou religa) o contrato core de uma locação aberta.
 *
 * O core cuida do que já sabe fazer: renovação automática, reajuste por índice
 * e o vínculo com nfse_recorrencias. O valor vem da locação — `contratos_itens`
 * é informativo por decisão de projeto (contratos-routes.js:81), então quem
 * calcula aqui é este módulo, e o resultado é escrito em `valorMensal`.
 */
function ligarContratoCore(db, contratoId, opts = {}) {
  const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(contratoId);
  if (!c) throw new Error('locação não encontrada');
  if (c.tipo !== 'aberta') {
    const e = new Error('só locação do tipo "aberta" tem contrato de recorrência');
    e.status = 400;
    throw e;
  }
  if (c.contratoCoreId) {
    const existente = db.prepare('SELECT * FROM contratos WHERE id = ?').get(c.contratoCoreId);
    if (existente) return existente;
  }

  const valorPeriodo = arredondar(Number(c.valorLocacao) + Number(c.valorServicos));
  if (!(valorPeriodo > 0)) {
    const e = new Error('a locação não tem valor — acrescente itens antes de gerar o contrato');
    e.status = 400;
    throw e;
  }

  const numero = `LOC-${c.numero}`;
  const jaExiste = db.prepare('SELECT id FROM contratos WHERE numero = ?').get(numero);
  if (jaExiste) {
    db.prepare('UPDATE locacao_contratos SET contratoCoreId = ? WHERE id = ?').run(jaExiste.id, contratoId);
    return db.prepare('SELECT * FROM contratos WHERE id = ?').get(jaExiste.id);
  }

  const info = db.prepare(`
    INSERT INTO contratos
      (numero, clienteId, descricao, valorMensal, diaVencimento, dataInicio, dataFim,
       renovacaoAutomatica, indiceReajuste, status, observacoes, periodicidade)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'ativo', ?, 'mensal')
  `).run(numero, c.clienteId, `Locação ${c.numero}`, valorPeriodo,
         c.diaVencimento || 10, (c.dataSaidaReal || c.dataSaidaPrevista).slice(0, 10),
         opts.renovacaoAutomatica === false ? 0 : 1,
         opts.indiceReajuste || null,
         `Gerado pelo módulo de Locação a partir de ${c.numero}.`);

  db.prepare('UPDATE locacao_contratos SET contratoCoreId = ? WHERE id = ?')
    .run(info.lastInsertRowid, contratoId);
  registrarEvento(db, contratoId, 'contrato_core', {
    descricao: `Contrato de recorrência ${numero} criado`, valorDepois: valorPeriodo,
    usuario: opts.usuario,
  });

  return db.prepare('SELECT * FROM contratos WHERE id = ?').get(info.lastInsertRowid);
}

// ─── Notificações ──────────────────────────────────────────────────────────

/** Semeia a config de notificação por evento×canal. Idempotente. */
function garantirNotificacoesConfig(db) {
  const stmt = db.prepare(`
    INSERT INTO locacao_notificacoes_config (evento, canal, template, ativo)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(evento, canal) DO NOTHING
  `);
  const templates = {
    retorno_amanha: 'A devolução da locação {numero} está prevista para amanhã ({dataRetorno}).',
    retorno_atrasado: 'A locação {numero} está com devolução atrasada desde {dataRetorno}.',
    contrato_vencendo: 'O contrato de locação {numero} vence em {dataRetorno}.',
    caucao_a_devolver: 'A caução de {caucao} da locação {numero} está pendente de devolução.',
  };
  for (const evento of EVENTOS_NOTIFICACAO) {
    for (const canal of ['telegram', 'email', 'whatsapp']) {
      stmt.run(evento, canal, templates[evento] || null);
    }
  }
}

/**
 * Locações que disparariam cada evento hoje. Não envia nada — só apura.
 * O envio fica para quem tiver a fiação de canal (notificacoes-dispatcher).
 */
function apurarNotificacoes(db, hoje) {
  const ref = (normalizarInstante(hoje) || normalizarInstante(new Date())).slice(0, 10);
  const amanha = new Date(new Date(ref + 'T00:00:00').getTime() + 86400000).toISOString().slice(0, 10);

  return {
    referencia: ref,
    retorno_amanha: db.prepare(`
      SELECT id, numero, clienteId, dataRetornoPrevisto FROM locacao_contratos
      WHERE status = 'emAndamento' AND substr(dataRetornoPrevisto, 1, 10) = ?
    `).all(amanha),
    retorno_atrasado: db.prepare(`
      SELECT id, numero, clienteId, dataRetornoPrevisto FROM locacao_contratos
      WHERE status = 'emAndamento' AND dataRetornoPrevisto IS NOT NULL
        AND substr(dataRetornoPrevisto, 1, 10) < ?
    `).all(ref),
    caucao_a_devolver: db.prepare(`
      SELECT id, numero, clienteId, caucaoValor FROM locacao_contratos
      WHERE caucaoStatus = 'retido' AND status IN ('devolvido','encerrado')
    `).all(),
    // Estava na lista de eventos e na tabela de config, mas nunca era apurado:
    // o tenant podia ligar o aviso e não receber nada. Contrato aberto que se
    // aproxima do fim previsto (7 dias), ou contrato core com dataFim chegando.
    contrato_vencendo: db.prepare(`
      SELECT lc.id, lc.numero, lc.clienteId, lc.dataRetornoPrevisto, c.dataFim AS fimContratoCore
      FROM locacao_contratos lc
      LEFT JOIN contratos c ON c.id = lc.contratoCoreId
      WHERE lc.status IN ('reservado','emAndamento')
        AND (
          (lc.dataRetornoPrevisto IS NOT NULL
             AND substr(lc.dataRetornoPrevisto, 1, 10) > ?
             AND substr(lc.dataRetornoPrevisto, 1, 10) <= date(?, '+7 day'))
          OR (c.dataFim IS NOT NULL
             AND substr(c.dataFim, 1, 10) > ?
             AND substr(c.dataFim, 1, 10) <= date(?, '+7 day'))
        )
    `).all(ref, ref, ref, ref),
  };
}

module.exports = {
  STATUS_CAUCAO,
  EVENTOS_NOTIFICACAO,
  calcularVencimento,
  faturar,
  encerrar,
  receberCaucao,
  destinarCaucao,
  ligarContratoCore,
  garantirNotificacoesConfig,
  apurarNotificacoes,
};
