/**
 * tecnologico.js — controle tecnológico do concreto (F1.4).
 *
 * Lote de betonada, corpo de prova, ruptura e — o ponto do arquivo — a
 * LIBERAÇÃO DA PROTENSÃO.
 *
 * ─── POR QUE ISTO NÃO É "QUALIDADE PARA DEPOIS" ─────────────────────────────
 * Em forma fixa o ensaio é conferência: concreta, espera, desmolda, e o corpo
 * de prova aos 28 dias confirma o que já saiu.
 *
 * Em pista de protensão o ensaio é OPERACIONAL e BLOQUEANTE: a cordoalha só
 * pode ser cortada quando o concreto atinge o fck de transferência (tipicamente
 * 21 a 24 MPa, contra 35 de projeto). Cortar antes arranca a peça.
 *
 * Por isso `podeLiberarSaida` é chamada por op.js antes da transição
 * `curando → liberada_saida`, e por isso o bypass grava evento nominal em
 * vez de simplesmente deixar passar.
 */

const { num, normalizarData, gerarNumero, agora } = require('./prod-util');

const FINALIDADES = ['transferencia', 'controle', 'projeto'];
const SITUACOES_LOTE = ['pendente', 'aprovado', 'reprovado'];

// Idade de ruptura conforme a finalidade, quando a tela não informa.
// Transferência é 1 dia porque é o giro da pista; projeto é 28 por norma.
const IDADE_PADRAO = { transferencia: 1, controle: 7, projeto: 28 };

function criarLote(db, dados, usuario) {
  const data = normalizarData(dados.data);
  if (!data) return { erro: 'data inválida' };
  if (num(dados.volumeM3, { min: 0 }) == null) return { erro: 'volumeM3 deve ser >= 0' };

  const codigo = dados.codigo && String(dados.codigo).trim()
    ? String(dados.codigo).trim()
    : gerarNumero(db, 'prod_lotes', 'LOTE', 'codigo');

  const jaExiste = db.prepare('SELECT id FROM prod_lotes WHERE codigo = ?').get(codigo);
  if (jaExiste) return { erro: `já existe lote com o código ${codigo}` };

  const r = db.prepare(`
    INSERT INTO prod_lotes
      (codigo, data, traco, volumeM3, ensaioLimiteConformidade, slumpMm, temperaturaC,
       cimentoTipo, situacao, usuario, observacoes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)
  `).run(
    codigo, data, dados.traco || null, Number(dados.volumeM3 || 0),
    num(dados.ensaioLimiteConformidade, { min: 0 }), num(dados.slumpMm, { min: 0 }),
    num(dados.temperaturaC, { min: -50, max: 100 }), dados.cimentoTipo || null,
    usuario || null, dados.observacoes || null
  );
  return { lote: db.prepare('SELECT * FROM prod_lotes WHERE id = ?').get(r.lastInsertRowid) };
}

function criarCorpoProva(db, loteId, dados, usuario) {
  const lote = db.prepare('SELECT * FROM prod_lotes WHERE id = ?').get(loteId);
  if (!lote) return { erro: 'lote não encontrado' };

  const finalidade = dados.finalidade || 'projeto';
  if (!FINALIDADES.includes(finalidade)) {
    return { erro: `finalidade inválida: use ${FINALIDADES.join(', ')}` };
  }
  const dataMoldagem = normalizarData(dados.dataMoldagem) || lote.data;

  // Ausente = usa o padrão da finalidade. PRESENTE e inválido = erro: cair no
  // default silenciosamente esconderia um "500 dias" digitado por engano.
  let idade = IDADE_PADRAO[finalidade];
  if (dados.idadeDias != null && dados.idadeDias !== '') {
    idade = num(dados.idadeDias, { min: 0, max: 400 });
    if (idade == null) return { erro: 'idadeDias deve ser um número entre 0 e 400' };
  }

  const ident = String(dados.identificacao || '').trim();
  if (!ident) return { erro: 'identificacao é obrigatória' };

  const dup = db.prepare(
    'SELECT id FROM prod_ensaios WHERE loteId = ? AND identificacao = ?'
  ).get(loteId, ident);
  if (dup) return { erro: `já existe corpo de prova "${ident}" neste lote` };

  const r = db.prepare(`
    INSERT INTO prod_ensaios
      (loteId, identificacao, dataMoldagem, idadeDias, finalidade, usuario, observacoes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(loteId, ident, dataMoldagem, idade, finalidade, usuario || null,
    dados.observacoes || null);

  return { corpoProva: db.prepare('SELECT * FROM prod_ensaios WHERE id = ?').get(r.lastInsertRowid) };
}

/**
 * Registra a ruptura. O `aprovado` NÃO vem da tela: é decidido aqui,
 * comparando a resistência medida com o fck exigido pela finalidade.
 *
 * - transferencia → compara com prod_fichas.ensaioLimiteLiberacao das peças do lote
 * - controle/projeto → compara com o fck de projeto do lote
 *
 * Quando não há fck de referência, `aprovado` fica NULL (não 1): um ensaio sem
 * parâmetro não aprova nada, e marcar 1 liberaria a protensão por omissão.
 */
function registrarRuptura(db, corpoProvaId, dados, usuario) {
  const cp = db.prepare('SELECT * FROM prod_ensaios WHERE id = ?').get(corpoProvaId);
  if (!cp) return { erro: 'corpo de prova não encontrado' };
  if (cp.dataRuptura) return { erro: 'este corpo de prova já foi rompido' };

  const resistencia = num(dados.resistenciaMpa, { min: 0 });
  if (resistencia == null) return { erro: 'resistenciaMpa deve ser >= 0' };
  // `agora()` é hora LOCAL. `new Date().toISOString()` é UTC — entre 21h e
  // meia-noite de Brasília isso datava a ruptura no dia seguinte.
  const dataRuptura = normalizarData(dados.dataRuptura) || normalizarData(agora());

  const referencia = fckDeReferencia(db, cp);
  const aprovado = referencia == null ? null : (resistencia >= referencia ? 1 : 0);

  db.prepare(`
    UPDATE prod_ensaios
       SET resistenciaMpa = ?, dataRuptura = ?, aprovado = ?, usuario = COALESCE(?, usuario)
     WHERE id = ?
  `).run(resistencia, dataRuptura, aprovado, usuario || null, corpoProvaId);

  atualizarSituacaoLote(db, cp.loteId);

  return {
    corpoProva: db.prepare('SELECT * FROM prod_ensaios WHERE id = ?').get(corpoProvaId),
    referenciaMpa: referencia,
    avisoSemReferencia: referencia == null
      ? 'sem fck de referência: o ensaio ficou registrado mas não aprova nem reprova. '
        + 'Cadastre o fck da peça (ou do lote) para que a liberação funcione.'
      : null,
  };
}

/**
 * O fck contra o qual este corpo de prova é julgado.
 *
 * Na transferência, o parâmetro é da PEÇA (cada peça protendida tem o seu), e
 * o lote pode servir peças diferentes — por isso vale o MAIOR fck de
 * transferência entre as peças que consumiram o lote. Liberar pelo menor
 * deixaria passar a peça mais exigente.
 */
function fckDeReferencia(db, cp) {
  if (cp.finalidade === 'transferencia') {
    const row = db.prepare(`
      SELECT MAX(pc.ensaioLimiteLiberacao) AS fck
        FROM prod_ordens o
        JOIN prod_fichas pc ON pc.produtoId = o.produtoId
       WHERE o.loteId = ? AND pc.ensaioLimiteLiberacao IS NOT NULL
    `).get(cp.loteId);
    if (row && row.fck != null) return Number(row.fck);
    return null;
  }
  const lote = db.prepare('SELECT ensaioLimiteConformidade FROM prod_lotes WHERE id = ?').get(cp.loteId);
  if (lote && lote.ensaioLimiteConformidade != null) return Number(lote.ensaioLimiteConformidade);

  // Lote sem fck declarado: cai no fck de projeto das peças que ele serviu.
  const row = db.prepare(`
    SELECT MAX(pc.ensaioLimiteConformidade) AS fck
      FROM prod_ordens o
      JOIN prod_fichas pc ON pc.produtoId = o.produtoId
     WHERE o.loteId = ? AND pc.ensaioLimiteConformidade IS NOT NULL
  `).get(cp.loteId);
  return row && row.fck != null ? Number(row.fck) : null;
}

/**
 * Situação do lote: reprovado se QUALQUER ensaio de projeto reprovou;
 * aprovado quando há ao menos um de projeto aprovado e nenhum reprovado;
 * pendente enquanto não houver ensaio de projeto rompido.
 *
 * Ensaio de transferência não define a situação do lote — ele libera a pista,
 * não atesta o concreto.
 */
function atualizarSituacaoLote(db, loteId) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN finalidade <> 'transferencia' AND aprovado = 0 THEN 1 ELSE 0 END) AS reprovados,
      SUM(CASE WHEN finalidade <> 'transferencia' AND aprovado = 1 THEN 1 ELSE 0 END) AS aprovados
    FROM prod_ensaios WHERE loteId = ?
  `).get(loteId);

  let situacao = 'pendente';
  if (row && row.reprovados > 0) situacao = 'reprovado';
  else if (row && row.aprovados > 0) situacao = 'aprovado';

  db.prepare('UPDATE prod_lotes SET situacao = ? WHERE id = ?').run(situacao, loteId);
  return situacao;
}

/**
 * A trava. Responde se a OP pode passar de `curando` para `liberada_saida`.
 *
 * Em forma fixa: sempre pode (o tempo de cura já é controlado pela OP).
 * Em pista de protensão: só com corpo de prova de transferência APROVADO no
 * lote da OP.
 *
 * Devolve { pode, motivo, exigeEnsaio }.
 */
function podeLiberarSaida(db, op) {
  const peca = db.prepare('SELECT exigeEnsaioLiberacao, ensaioLimiteLiberacao FROM prod_fichas WHERE produtoId = ?')
    .get(op.produtoId);

  if (!peca || !peca.exigeEnsaioLiberacao) {
    return { pode: true, exigeEnsaio: false, motivo: null };
  }
  if (!op.loteId) {
    return {
      pode: false, exigeEnsaio: true,
      motivo: 'peça protendida sem lote de concreto vinculado: não há ensaio que possa liberar a protensão',
    };
  }
  // A comparação é feita AQUI, contra o fck DESTA peça — não se confia no
  // `aprovado` gravado na ruptura.
  //
  // O motivo: um lote serve várias OPs, e a associação OP↔lote acontece na
  // concretagem, que pode ser posterior ao ensaio. Um CP rompido a 22 MPa foi
  // aprovado quando o lote só servia uma peça de 21; se depois uma OP de peça
  // que exige 30 usar o mesmo lote, o flag continua 1 e liberaria a desforma
  // de uma peça que o concreto ainda não aguenta.
  // O exigido é o CONGELADO na concretagem, não o do cadastro atual: editar a
  // peça depois de ela estar na pista rebaixaria a exigência de uma peça já
  // em_processo, e um ensaio insuficiente passaria a "aprovar". Só cai no
  // cadastro em OP antiga, anterior à coluna.
  const exigido = Number(op.ensaioLimiteExigido ?? peca.ensaioLimiteLiberacao);
  if (!Number.isFinite(exigido) || exigido <= 0) {
    return {
      pode: false, exigeEnsaio: true,
      motivo: 'a peça não tem fck de transferência cadastrado: não há contra o que comparar o ensaio',
    };
  }

  const cp = db.prepare(`
    SELECT * FROM prod_ensaios
     WHERE loteId = ? AND finalidade = 'transferencia'
       AND dataRuptura IS NOT NULL AND resistenciaMpa >= ?
     ORDER BY resistenciaMpa DESC, dataRuptura DESC LIMIT 1
  `).get(op.loteId, exigido);

  if (!cp) {
    const melhor = db.prepare(`
      SELECT MAX(resistenciaMpa) AS r, COUNT(*) AS n FROM prod_ensaios
       WHERE loteId = ? AND finalidade = 'transferencia' AND dataRuptura IS NOT NULL
    `).get(op.loteId);
    return {
      pode: false, exigeEnsaio: true, exigidoMpa: exigido,
      obtidoMpa: melhor && melhor.n ? melhor.r : null,
      motivo: melhor && melhor.n > 0
        ? `o ensaio de transferência deste lote chegou a ${melhor.r} MPa e esta peça exige ${exigido} MPa `
          + '— cortar a cordoalha agora arranca a peça'
        : 'sem ensaio de transferência rompido neste lote: a protensão não pode ser liberada',
    };
  }
  return {
    pode: true, exigeEnsaio: true, motivo: null,
    corpoProvaId: cp.id, resistenciaMpa: cp.resistenciaMpa, exigidoMpa: exigido,
  };
}

/** Corpos de prova de um lote, com o fck de referência já resolvido. */
function corposDoLote(db, loteId) {
  const linhas = db.prepare(
    'SELECT * FROM prod_ensaios WHERE loteId = ? ORDER BY dataMoldagem, id'
  ).all(loteId);
  return linhas.map(cp => ({ ...cp, referenciaMpa: fckDeReferencia(db, cp) }));
}

module.exports = {
  FINALIDADES, SITUACOES_LOTE, IDADE_PADRAO,
  criarLote, criarCorpoProva, registrarRuptura, fckDeReferencia,
  atualizarSituacaoLote, podeLiberarSaida, corposDoLote,
};
