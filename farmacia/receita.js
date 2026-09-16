/**
 * receita.js — Receita, Portaria SVS/MS 344/1998 e RDC 20/2011 no balcão.
 *
 * Os dados capturados aqui não são zelo de cadastro: são exatamente os campos
 * que o SNGPC exige no XML de cada saída de controlado (prescritor com
 * conselho/UF/número, paciente, comprador, receita e lote). Capturar na venda
 * é a única hora em que essa informação existe.
 *
 * O que exige receita REGISTRADA (com retenção do dado):
 *   - medicamento das listas da Portaria 344/98 (tarja preta e controlados);
 *   - antimicrobiano (RDC 20/2011).
 * Tarja vermelha simples exige apresentação da receita, mas não retenção — o
 * balcão confere e devolve o papel. Bloquear a venda nesse caso seria mais
 * rígido do que a norma, então aqui só bloqueia o que tem retenção.
 */

const { hojeBrasilia } = require('./fefo');

/**
 * Tipos de receita e a validade de cada um, contada da emissão.
 *
 *   notificacao_a      Notificação de Receita A (amarela) — entorpecentes A1/A2/A3
 *   notificacao_b      Notificação de Receita B (azul) — psicotrópicos B1/B2
 *   controle_especial  Receituário de Controle Especial em 2 vias — listas C
 *   antimicrobiano     Receita de antimicrobiano (RDC 20/2011)
 *   comum              Receita simples, sem retenção
 */
const TIPOS_RECEITA = {
  notificacao_a: { rotulo: 'Notificação de Receita A', validadeDias: 30, retem: true, exigeMesmaUf: false },
  notificacao_b: { rotulo: 'Notificação de Receita B', validadeDias: 30, retem: true, exigeMesmaUf: true },
  controle_especial: { rotulo: 'Receituário de Controle Especial', validadeDias: 30, retem: true, exigeMesmaUf: false },
  antimicrobiano: { rotulo: 'Receita de antimicrobiano', validadeDias: 10, retem: true, exigeMesmaUf: false },
  comum: { rotulo: 'Receita comum', validadeDias: null, retem: false, exigeMesmaUf: false },
};

// Conselhos aceitos como prescritor. COREN entrou por atualização da ANVISA:
// enfermeiro pode prescrever antimicrobiano e o SNGPC já aceita o registro.
const CONSELHOS = ['CRM', 'CRO', 'CRMV', 'COREN'];

/**
 * Que tipo de receita aquele medicamento exige. `null` = não exige registro.
 * Devolve a lista de tipos aceitos (o primeiro é o esperado).
 */
function tiposAceitosPara(spec) {
  if (!spec) return null;

  const lista = String(spec.listaPortaria344 || '').toUpperCase();
  if (/^A[123]$/.test(lista)) return ['notificacao_a'];
  if (/^B[12]$/.test(lista)) return ['notificacao_b'];
  if (/^C[12345]$/.test(lista)) return ['controle_especial'];
  if (/^D[12]$/.test(lista)) return ['controle_especial'];

  // Antimicrobiano é receituário de controle especial em 2 vias; os dois tipos
  // descrevem o mesmo papel, então ambos servem.
  if (Number(spec.antimicrobiano)) return ['antimicrobiano', 'controle_especial'];

  // Tarja preta sem lista preenchida: a lista é curadoria e pode faltar, mas
  // tarja preta nunca é venda livre — melhor exigir do que deixar passar.
  if (spec.tarja === 'preta') return ['notificacao_b', 'notificacao_a', 'controle_especial'];

  return null;
}

function ehValida(receita, hoje = hojeBrasilia()) {
  const regra = TIPOS_RECEITA[receita.tipo];
  if (!regra) return `tipo de receita desconhecido: ${receita.tipo}`;
  if (!regra.validadeDias) return null;

  const emissao = String(receita.dataEmissao || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(emissao)) return 'data de emissão da receita inválida';
  if (emissao > hoje) return 'receita com data de emissão no futuro';

  const limite = new Date(Date.parse(emissao + 'T00:00:00Z') + regra.validadeDias * 86400000)
    .toISOString().slice(0, 10);
  if (hoje > limite) {
    return `${regra.rotulo} venceu em ${limite} (validade de ${regra.validadeDias} dias)`;
  }
  return null;
}

/** Campos que o SNGPC vai cobrar depois. Faltar aqui é falhar lá. */
function camposObrigatorios(receita) {
  const faltando = [];
  const regra = TIPOS_RECEITA[receita.tipo];
  if (!regra) return ['tipo de receita'];
  if (!regra.retem) return [];

  if (!String(receita.prescritorNome || '').trim()) faltando.push('nome do prescritor');
  if (!CONSELHOS.includes(String(receita.prescritorConselho || '').toUpperCase())) {
    faltando.push('conselho do prescritor (' + CONSELHOS.join('/') + ')');
  }
  if (!/^[A-Z]{2}$/.test(String(receita.prescritorConselhoUf || '').toUpperCase())) faltando.push('UF do conselho');
  if (!String(receita.prescritorNumero || '').trim()) faltando.push('número do conselho');
  if (!String(receita.pacienteNome || '').trim()) faltando.push('nome do paciente');
  if (!String(receita.compradorNome || '').trim()) faltando.push('nome do comprador');
  if (!String(receita.compradorDocumento || '').trim()) faltando.push('documento do comprador');
  return faltando;
}

/**
 * Quanto de um produto ainda cabe naquela receita.
 * Uma receita não é passe livre: vale pela quantidade prescrita, somando o que
 * já saiu em vendas anteriores.
 */
function saldoDaReceita(db, receitaId, produtoId) {
  const item = db.prepare(
    'SELECT quantidade FROM farmacia_receita_itens WHERE receitaId = ? AND produtoId = ?'
  ).get(receitaId, produtoId);
  if (!item) return { prescrito: 0, usado: 0, saldo: 0, temItem: false };

  // Reserva conta como usado: é ela que impede a segunda venda simultânea da
  // mesma receita de passar na conferência.
  const usado = db.prepare(
    `SELECT COALESCE(SUM(quantidade), 0) AS q FROM farmacia_venda_receita
     WHERE receitaId = ? AND produtoId = ? AND COALESCE(status, 'confirmado') IN ('reservado', 'confirmado')`
  ).get(receitaId, produtoId).q;

  return {
    prescrito: Number(item.quantidade),
    usado: Number(usado),
    saldo: +(Number(item.quantidade) - Number(usado)).toFixed(6),
    temItem: true,
  };
}

/**
 * Valida a venda inteira contra a receita informada.
 * Devolve { exigidos: [...], erros: [...] }. Sem erros = pode dispensar.
 *
 * `receitaId` pode ser null: aí qualquer item que exija receita vira erro.
 */
function validarDispensacao(db, itens, receitaId, { hoje = hojeBrasilia() } = {}) {
  const erros = [];
  const exigidos = [];

  const receita = receitaId
    ? db.prepare('SELECT * FROM farmacia_receitas WHERE id = ?').get(receitaId)
    : null;
  if (receitaId && !receita) {
    return { exigidos, erros: ['receita não encontrada'] };
  }

  for (const it of itens) {
    if (!it.produtoId) continue;
    const spec = db.prepare('SELECT * FROM farmacia_medicamento_specs WHERE produtoId = ?').get(it.produtoId);
    const tipos = tiposAceitosPara(spec);
    if (!tipos) continue;

    const p = db.prepare('SELECT descricao FROM produtos WHERE id = ?').get(it.produtoId);
    const nome = (p && p.descricao) || `produto ${it.produtoId}`;
    exigidos.push({ produtoId: it.produtoId, descricao: nome, tiposAceitos: tipos });

    if (!receita) {
      erros.push(`${nome} exige ${TIPOS_RECEITA[tipos[0]].rotulo} — informe a receita`);
      continue;
    }
    if (!tipos.includes(receita.tipo)) {
      erros.push(`${nome} exige ${TIPOS_RECEITA[tipos[0]].rotulo}, e a receita informada é ${TIPOS_RECEITA[receita.tipo]?.rotulo || receita.tipo}`);
      continue;
    }

    const s = saldoDaReceita(db, receita.id, it.produtoId);
    if (!s.temItem) {
      erros.push(`${nome} não consta na receita informada`);
      continue;
    }
    if (Number(it.quantidade) > s.saldo) {
      erros.push(`${nome}: receita permite mais ${s.saldo} (prescrito ${s.prescrito}, já dispensado ${s.usado})`);
    }
  }

  if (receita && exigidos.length) {
    const venc = ehValida(receita, hoje);
    if (venc) erros.push(venc);
    const faltando = camposObrigatorios(receita);
    if (faltando.length) erros.push('receita incompleta: falta ' + faltando.join(', '));
    if (TIPOS_RECEITA[receita.tipo]?.exigeMesmaUf && receita.uf && receita.prescritorConselhoUf
        && String(receita.uf).toUpperCase() !== String(receita.prescritorConselhoUf).toUpperCase()) {
      erros.push(`${TIPOS_RECEITA[receita.tipo].rotulo} só vale na UF de emissão (${receita.uf})`);
    }
  }

  return { exigidos, erros };
}

/**
 * Grava o consumo da receita pela venda.
 *
 * `status` diz em que ponto do fluxo isto está:
 *   'reservado'  — antes de ir à SEFAZ, para segurar o saldo
 *   'confirmado' — nota autorizada
 */
function registrarConsumo(db, { receitaId, nfceId, itens, lotesDaVenda, status = 'confirmado' }) {
  if (!receitaId) return [];
  const ins = db.prepare(`INSERT INTO farmacia_venda_receita
    (receitaId, nfceId, produtoId, loteId, quantidade, status) VALUES (?, ?, ?, ?, ?, ?)`);
  const ids = [];
  itens.forEach((it, i) => {
    if (!it.produtoId) return;
    const spec = db.prepare('SELECT * FROM farmacia_medicamento_specs WHERE produtoId = ?').get(it.produtoId);
    if (!tiposAceitosPara(spec)) return;
    const alocacoes = lotesDaVenda?.[i]?.alocacoes || [];
    if (!alocacoes.length) {
      ids.push(ins.run(receitaId, nfceId, it.produtoId, null, Number(it.quantidade), status).lastInsertRowid);
      return;
    }
    for (const a of alocacoes) {
      ids.push(ins.run(receitaId, nfceId, it.produtoId, a.loteId, Number(a.quantidade), status).lastInsertRowid);
    }
  });
  return ids;
}

/**
 * Valida e RESERVA o saldo da receita numa única transação síncrona.
 *
 * É isto que fecha a corrida: entre a conferência e a gravação do consumo há
 * dois `await` de rede (assinar o XML e enviar à SEFAZ), e nesse intervalo o
 * Node atende outra requisição. Duas vendas simultâneas da mesma receita
 * passavam as duas na conferência e o saldo ficava negativo — dispensação de
 * controlado acima do prescrito, que é falha de controle sanitário, não
 * detalhe de contabilidade.
 *
 * better-sqlite3 é síncrono e o Node é single-thread: nada intercala dentro de
 * um db.transaction(). Conferir e reservar juntos aqui é atômico de verdade.
 *
 * Devolve os ids reservados, para confirmar ou liberar depois.
 */
function reservarDispensacao(db, { receitaId, itens, lotesDaVenda, hoje = hojeBrasilia() }) {
  return db.transaction(() => {
    const { erros } = validarDispensacao(db, itens, receitaId, { hoje });
    if (erros.length) {
      const e = new Error('Dispensação bloqueada:\n· ' + erros.join('\n· '));
      e.detalhes = erros;
      throw e;
    }
    if (!receitaId) return [];
    return registrarConsumo(db, { receitaId, nfceId: null, itens, lotesDaVenda, status: 'reservado' });
  })();
}

/** Nota autorizada: a reserva vira consumo e ganha o número da nota. */
function confirmarDispensacao(db, ids, nfceId) {
  if (!ids || !ids.length) return;
  const upd = db.prepare("UPDATE farmacia_venda_receita SET status = 'confirmado', nfceId = ? WHERE id = ?");
  for (const id of ids) upd.run(nfceId, id);
}

/** Nota rejeitada ou erro no caminho: devolve o saldo à receita. */
function liberarDispensacao(db, ids) {
  if (!ids || !ids.length) return;
  const del = db.prepare("DELETE FROM farmacia_venda_receita WHERE id = ? AND status = 'reservado'");
  for (const id of ids) del.run(id);
}

module.exports = {
  TIPOS_RECEITA,
  CONSELHOS,
  tiposAceitosPara,
  ehValida,
  camposObrigatorios,
  saldoDaReceita,
  validarDispensacao,
  registrarConsumo,
  reservarDispensacao,
  confirmarDispensacao,
  liberarDispensacao,
};
