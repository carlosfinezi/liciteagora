/**
 * patrimonio-contabil.js — o imobilizado vira lançamento contábil.
 *
 * Até aqui o módulo calculava depreciação para mostrar na tela e parava por
 * aí: o próprio cabeçalho dizia "não emite contabilização — fica na camada
 * gerencial". Na prática, o balanço não sabia que existia imobilizado, e a
 * despesa de depreciação — que é dedutível — nunca chegava ao resultado.
 *
 * O que passa a ser contabilizado:
 *   aquisição   D imobilizado            C contrapartida (fornecedor/caixa)
 *   depreciação D despesa de depreciação C depreciação acumulada (retificadora)
 *   baixa       D depreciação acumulada  } pelo que já foi depreciado
 *               D resultado na baixa     } pelo valor contábil que sobrou
 *                                        C imobilizado (valor de aquisição)
 *
 * Duas invariantes que o código sustenta:
 *
 *  1. Idempotência por competência. `patrimonio_depreciacoes` tem UNIQUE por
 *     (bemId, competencia): rodar o fechamento do mês duas vezes não dobra a
 *     despesa. Sem isso, apurar de novo seria irreversível na prática.
 *  2. O acumulado contábil é a SOMA das competências lançadas, nunca um
 *     recálculo. Se alguém estornar março, o acumulado cai — e a baixa usa o
 *     que está no razão, não o que a fórmula diria.
 */

const { gravarLancamento } = require('./contabilidade-routes');

// CFOPs de entrada que trazem bem do ativo imobilizado.
// 1556/2556 (uso e consumo) fica DE FORA de propósito: é despesa, não bem.
const CFOPS_IMOBILIZADO = ['1551', '2551', '1552', '2552'];

const erro = (codigo, mensagem, extra = {}) => ({ nivel: 'erro', codigo, mensagem, ...extra });
const aviso = (codigo, mensagem, extra = {}) => ({ nivel: 'aviso', codigo, mensagem, ...extra });

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* idempotente */ } }

function migrarDB(db) {
  db.exec(`
    -- Para qual conta contábil cada categoria de bem vai. Linha com categoria
    -- NULL é o padrão: sem ela, nada é contabilizado e o motivo é dito.
    CREATE TABLE IF NOT EXISTS patrimonio_contas_padrao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      categoria TEXT,
      contaImobilizadoId INTEGER NOT NULL,
      contaDepreciacaoAcumuladaId INTEGER NOT NULL,
      contaDespesaDepreciacaoId INTEGER NOT NULL,
      contaResultadoBaixaId INTEGER,
      taxaAnualPadrao REAL,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contaImobilizadoId) REFERENCES contas_contabeis(id),
      FOREIGN KEY (contaDepreciacaoAcumuladaId) REFERENCES contas_contabeis(id),
      FOREIGN KEY (contaDespesaDepreciacaoId) REFERENCES contas_contabeis(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pat_contas_categoria
      ON patrimonio_contas_padrao(COALESCE(categoria, ''));

    -- Uma linha por bem por competência apurada. O UNIQUE é a trava de
    -- idempotência do fechamento mensal.
    CREATE TABLE IF NOT EXISTS patrimonio_depreciacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bemId INTEGER NOT NULL,
      competencia TEXT NOT NULL,
      valor REAL NOT NULL,
      lancamentoId INTEGER,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bemId) REFERENCES patrimonio_bens(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pat_depr_bem_comp
      ON patrimonio_depreciacoes(bemId, competencia);
    CREATE INDEX IF NOT EXISTS idx_pat_depr_comp ON patrimonio_depreciacoes(competencia);
  `);

  // Origem e rastro contábil do bem.
  alterSafe(db, 'ALTER TABLE patrimonio_bens ADD COLUMN nfeEntradaItemId INTEGER');
  alterSafe(db, 'ALTER TABLE patrimonio_bens ADD COLUMN lancamentoAquisicaoId INTEGER');
  alterSafe(db, 'ALTER TABLE patrimonio_bens ADD COLUMN lancamentoBaixaId INTEGER');
  // Um item de nota vira N bens (5 notebooks = 5 bens), então o índice não
  // pode ser único por item — a sequência distingue.
  alterSafe(db, 'ALTER TABLE patrimonio_bens ADD COLUMN sequenciaNoItem INTEGER');
  alterSafe(db, 'CREATE INDEX IF NOT EXISTS idx_pat_nfe_item ON patrimonio_bens(nfeEntradaItemId)');
}

// ==================== DATAS ====================

const comp = (data) => String(data).slice(0, 7);
const primeiroDia = (competencia) => `${competencia}-01`;
const ultimoDia = (competencia) => {
  const [y, m] = competencia.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const mesesEntre = (de, ate) => {
  const [y1, m1] = comp(de).split('-').map(Number);
  const [y2, m2] = comp(ate).split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
};

// ==================== CONTAS ====================

/**
 * Contas contábeis do bem: mapeamento da categoria, com queda para o padrão.
 * Devolve os problemas em vez de lançar — quem chama decide se bloqueia.
 */
function contasDoBem(db, bem) {
  const buscar = (cat) => db.prepare(
    `SELECT * FROM patrimonio_contas_padrao WHERE COALESCE(categoria,'') = ?`).get(cat || '');
  const mapa = (bem.categoria && buscar(bem.categoria)) || buscar(null);

  if (!mapa) {
    return { contas: null, problemas: [erro('sem_mapeamento',
      'Nenhum mapeamento de contas contábeis para o patrimônio. '
      + 'Configure ao menos o padrão (imobilizado, depreciação acumulada e despesa de depreciação).')] };
  }

  const problemas = [];
  const ler = (id, rotulo) => {
    if (!id) return null;
    const c = db.prepare('SELECT * FROM contas_contabeis WHERE id = ?').get(id);
    if (!c) { problemas.push(erro('conta_inexistente', `Conta de ${rotulo} não existe mais (id ${id})`)); return null; }
    if (!c.ativo) { problemas.push(erro('conta_inativa', `Conta ${c.codigo} (${rotulo}) está inativa`)); return null; }
    // gravarLancamento recusa sintética; melhor avisar aqui, com o nome do papel.
    if (c.tipoConta !== 'analitica') {
      problemas.push(erro('conta_sintetica', `Conta ${c.codigo} (${rotulo}) é sintética — aponte para uma analítica`));
      return null;
    }
    return c;
  };

  const contas = {
    imobilizado: ler(mapa.contaImobilizadoId, 'imobilizado'),
    acumulada: ler(mapa.contaDepreciacaoAcumuladaId, 'depreciação acumulada'),
    despesa: ler(mapa.contaDespesaDepreciacaoId, 'despesa de depreciação'),
    resultadoBaixa: ler(mapa.contaResultadoBaixaId, 'resultado na baixa'),
    origem: mapa.categoria ? `categoria ${mapa.categoria}` : 'padrão',
  };
  return { contas, problemas };
}

// ==================== DEPRECIAÇÃO ====================

/**
 * Quota de depreciação do bem numa competência.
 *
 * Começa no mês da aquisição e para quando o acumulado atinge o depreciável
 * (valor de aquisição − residual). A última parcela é ajustada para fechar
 * exatamente: quota fixa arredondada deixaria centavos de resíduo eterno no
 * balanço, e o bem nunca terminaria de depreciar.
 *
 * @param {number} jaAcumulado  o que já FOI LANÇADO no razão, não o que a
 *   fórmula diria — assim um estorno de mês anterior é respeitado.
 */
function quotaDoMes(bem, competencia, jaAcumulado = 0) {
  if (!bem.dataAquisicao) return { valor: 0, motivo: 'bem sem data de aquisição' };
  if (!(Number(bem.vidaUtilMeses) > 0)) return { valor: 0, motivo: 'vida útil não informada' };

  const compAquisicao = comp(bem.dataAquisicao);
  if (competencia < compAquisicao) return { valor: 0, motivo: 'competência anterior à aquisição' };

  // Bem baixado só deprecia até o mês da baixa.
  if (bem.status !== 'ativo') {
    if (!bem.dataBaixa) return { valor: 0, motivo: `bem ${bem.status}` };
    if (competencia > comp(bem.dataBaixa)) return { valor: 0, motivo: 'competência posterior à baixa' };
  }

  const depreciavel = (Number(bem.valorAquisicao) || 0) - (Number(bem.valorResidual) || 0);
  if (depreciavel <= 0) return { valor: 0, motivo: 'valor residual cobre o valor de aquisição' };

  const restante = depreciavel - jaAcumulado;
  if (restante <= 0.005) return { valor: 0, motivo: 'bem totalmente depreciado' };

  const mesesDecorridos = mesesEntre(compAquisicao, competencia);
  if (mesesDecorridos >= Number(bem.vidaUtilMeses)) {
    // Passou da vida útil e ainda sobrou saldo (por estorno ou aquisição
    // retroativa): fecha o que falta em vez de deixar resíduo pendurado.
    return { valor: Number(restante.toFixed(2)), ajusteFinal: true };
  }

  const quota = depreciavel / Number(bem.vidaUtilMeses);
  const ultimoMes = mesesDecorridos === Number(bem.vidaUtilMeses) - 1;

  // No último mês da vida útil a parcela absorve o arredondamento das
  // anteriores: 1000 em 3 meses são 333,33 + 333,33 + 333,34, senão sobra um
  // centavo pendurado no balanço e o bem nunca termina de depreciar.
  //
  // Só o arredondamento, porém: se faltar mais que uma quota (mês estornado e
  // não reapurado), a diferença NÃO é escondida numa parcela gorda — ela fica
  // visível e é varrida depois da vida útil, onde o relatório a mostra.
  const absorveResto = ultimoMes && restante <= quota + 0.05;
  const valor = absorveResto ? restante : Math.min(quota, restante);

  return { valor: Number(valor.toFixed(2)), ajusteFinal: absorveResto || valor < quota - 0.005 };
}

/** Depreciação já lançada no razão para o bem. */
function acumuladoContabil(db, bemId, ateCompetencia) {
  let sql = 'SELECT COALESCE(SUM(valor), 0) AS total FROM patrimonio_depreciacoes WHERE bemId = ?';
  const params = [bemId];
  if (ateCompetencia) { sql += ' AND competencia <= ?'; params.push(ateCompetencia); }
  return Number(db.prepare(sql).get(...params).total) || 0;
}

/**
 * Fechamento de depreciação da competência.
 *
 * Um lançamento só, com as partidas agrupadas por par de contas — o razão fica
 * legível (uma linha "Depreciação 2026-07" em vez de trezentas) e o detalhe por
 * bem fica em patrimonio_depreciacoes.
 *
 * @param {boolean} opts.simular  calcula e devolve sem gravar nada.
 */
function apurarDepreciacao(db, competencia, opts = {}) {
  if (!/^\d{4}-\d{2}$/.test(competencia || '')) {
    throw new Error('competência no formato YYYY-MM obrigatória');
  }
  const data = opts.data || ultimoDia(competencia);
  const simular = !!opts.simular;

  const bens = db.prepare(`SELECT * FROM patrimonio_bens
    WHERE dataAquisicao <= ? AND (status = 'ativo' OR dataBaixa >= ?)`)
    .all(ultimoDia(competencia), primeiroDia(competencia));

  const jaApurados = new Set(db.prepare(
    'SELECT bemId FROM patrimonio_depreciacoes WHERE competencia = ?').all(competencia).map((r) => r.bemId));

  const linhas = [];
  const pulados = [];
  const bloqueios = [];

  for (const bem of bens) {
    if (jaApurados.has(bem.id)) {
      pulados.push({ bemId: bem.id, codigo: bem.codigo, motivo: 'competência já apurada para este bem' });
      continue;
    }
    const { contas, problemas } = contasDoBem(db, bem);
    if (!contas || !contas.despesa || !contas.acumulada) {
      bloqueios.push({ bemId: bem.id, codigo: bem.codigo,
        motivo: (problemas[0] && problemas[0].mensagem) || 'contas contábeis não configuradas' });
      continue;
    }
    const q = quotaDoMes(bem, competencia, acumuladoContabil(db, bem.id, competencia));
    if (!(q.valor > 0)) {
      pulados.push({ bemId: bem.id, codigo: bem.codigo, motivo: q.motivo || 'quota zero' });
      continue;
    }
    linhas.push({ bem, contas, valor: q.valor, ajusteFinal: !!q.ajusteFinal });
  }

  const total = Number(linhas.reduce((s, l) => s + l.valor, 0).toFixed(2));
  const resultado = {
    competencia, data, simulacao: simular,
    bens: linhas.length, total,
    detalhe: linhas.map((l) => ({
      bemId: l.bem.id, codigo: l.bem.codigo, descricao: l.bem.descricao,
      categoria: l.bem.categoria, valor: l.valor, ajusteFinal: l.ajusteFinal,
      contaDespesa: l.contas.despesa.codigo, contaAcumulada: l.contas.acumulada.codigo,
    })),
    pulados, bloqueios,
    lancamentoId: null,
  };

  if (simular || !linhas.length) return resultado;

  // Agrupa por par de contas: um par vira duas partidas (D despesa, C acumulada).
  const porPar = new Map();
  for (const l of linhas) {
    const chave = `${l.contas.despesa.id}|${l.contas.acumulada.id}`;
    const atual = porPar.get(chave) || { despesa: l.contas.despesa, acumulada: l.contas.acumulada, valor: 0, bens: 0 };
    atual.valor = Number((atual.valor + l.valor).toFixed(2));
    atual.bens++;
    porPar.set(chave, atual);
  }

  const partidas = [];
  for (const g of porPar.values()) {
    partidas.push({ contaContabilId: g.despesa.id, dc: 'D', valor: g.valor,
      historicoComplemento: `Depreciação de ${g.bens} bem(ns)` });
    partidas.push({ contaContabilId: g.acumulada.id, dc: 'C', valor: g.valor,
      historicoComplemento: `Depreciação acumulada de ${g.bens} bem(ns)` });
  }

  const tx = db.transaction(() => {
    const lancamentoId = gravarLancamento(db, {
      data,
      historico: `Depreciação do imobilizado — competência ${competencia}`,
      origem: 'patrimonio_depreciacao',
      origemRef: competencia,
      usuario: opts.usuario || null,
      partidas,
    });
    const ins = db.prepare(`INSERT INTO patrimonio_depreciacoes (bemId, competencia, valor, lancamentoId)
      VALUES (?, ?, ?, ?)`);
    for (const l of linhas) ins.run(l.bem.id, competencia, l.valor, lancamentoId);
    return lancamentoId;
  });

  resultado.lancamentoId = tx();
  return resultado;
}

/**
 * Desfaz a depreciação de uma competência.
 * Estorna pelo mecanismo da contabilidade (contra-lançamento) e libera a
 * competência para nova apuração — senão o UNIQUE impediria corrigir um erro.
 */
function estornarDepreciacao(db, competencia, opts = {}) {
  const linhas = db.prepare('SELECT * FROM patrimonio_depreciacoes WHERE competencia = ?').all(competencia);
  if (!linhas.length) return { estornadas: 0, lancamentoEstornoId: null };

  const lancamentoId = linhas.find((l) => l.lancamentoId) ? linhas.find((l) => l.lancamentoId).lancamentoId : null;
  let estornoId = null;

  const tx = db.transaction(() => {
    if (lancamentoId) {
      const orig = db.prepare('SELECT * FROM lancamentos_contabeis WHERE id = ?').get(lancamentoId);
      if (orig && !orig.estornado) {
        const partidas = db.prepare('SELECT * FROM lancamento_partidas WHERE lancamentoId = ?').all(lancamentoId)
          .map((p) => ({ contaContabilId: p.contaContabilId, dc: p.dc === 'D' ? 'C' : 'D', valor: p.valor,
                         centroCustoId: p.centroCustoId, historicoComplemento: 'Estorno' }));
        estornoId = gravarLancamento(db, {
          data: opts.data || orig.data,
          historico: `Estorno — ${orig.historico}`,
          tipo: 'estorno',
          origem: 'patrimonio_depreciacao_estorno',
          origemRef: competencia,
          usuario: opts.usuario || null,
          lancamentoOriginalId: lancamentoId,
          partidas,
        });
        db.prepare('UPDATE lancamentos_contabeis SET estornado = 1, lancamentoEstornoId = ? WHERE id = ?')
          .run(estornoId, lancamentoId);
      }
    }
    db.prepare('DELETE FROM patrimonio_depreciacoes WHERE competencia = ?').run(competencia);
  });
  tx();

  return { estornadas: linhas.length, lancamentoEstornoId: estornoId, lancamentoOriginalId: lancamentoId };
}

// ==================== AQUISIÇÃO E BAIXA ====================

/**
 * D imobilizado / C contrapartida.
 *
 * A contrapartida é obrigatória e não tem palpite: comprar à vista credita
 * caixa, a prazo credita fornecedores, e adivinhar errado bagunça o balanço.
 */
function contabilizarAquisicao(db, bemId, opts = {}) {
  const bem = db.prepare('SELECT * FROM patrimonio_bens WHERE id = ?').get(bemId);
  if (!bem) throw new Error('Bem não encontrado');
  if (bem.lancamentoAquisicaoId) {
    return { jaContabilizado: true, lancamentoId: bem.lancamentoAquisicaoId };
  }
  const { contas, problemas } = contasDoBem(db, bem);
  if (!contas || !contas.imobilizado) {
    throw new Error((problemas[0] && problemas[0].mensagem) || 'Conta de imobilizado não configurada');
  }
  if (!opts.contaContrapartidaId) {
    throw new Error('Informe a conta de contrapartida (fornecedores, caixa ou banco) — '
      + 'a aquisição debita o imobilizado e precisa saber o que creditar');
  }
  const valor = Number(bem.valorAquisicao) || 0;
  if (!(valor > 0)) throw new Error('Bem sem valor de aquisição');

  const lancamentoId = gravarLancamento(db, {
    data: opts.data || bem.dataAquisicao,
    historico: `Aquisição de imobilizado — ${bem.codigo} ${bem.descricao}`.slice(0, 200),
    origem: 'patrimonio_aquisicao',
    origemRef: String(bem.id),
    usuario: opts.usuario || null,
    partidas: [
      { contaContabilId: contas.imobilizado.id, dc: 'D', valor, centroCustoId: bem.centroCustoId || null },
      { contaContabilId: Number(opts.contaContrapartidaId), dc: 'C', valor },
    ],
  });
  db.prepare('UPDATE patrimonio_bens SET lancamentoAquisicaoId = ? WHERE id = ?').run(lancamentoId, bemId);
  return { lancamentoId, valor };
}

/**
 * Baixa contábil.
 *
 * Tira o bem do ativo pelo valor de aquisição, tira a depreciação acumulada
 * que estava lá, e o que sobra é resultado — perda, ou ganho se houve venda
 * acima do contábil. O acumulado vem do razão, não da fórmula: se março foi
 * estornado, a baixa reflete isso.
 */
function contabilizarBaixa(db, bemId, opts = {}) {
  const bem = db.prepare('SELECT * FROM patrimonio_bens WHERE id = ?').get(bemId);
  if (!bem) throw new Error('Bem não encontrado');
  if (bem.status === 'ativo') throw new Error('Bem ainda está ativo — dê baixa antes de contabilizar');
  if (bem.lancamentoBaixaId) return { jaContabilizado: true, lancamentoId: bem.lancamentoBaixaId };

  const { contas, problemas } = contasDoBem(db, bem);
  if (!contas || !contas.imobilizado || !contas.acumulada) {
    throw new Error((problemas[0] && problemas[0].mensagem) || 'Contas de imobilizado não configuradas');
  }
  const contaResultado = opts.contaResultadoId
    ? db.prepare('SELECT * FROM contas_contabeis WHERE id = ?').get(opts.contaResultadoId)
    : contas.resultadoBaixa;

  const aquisicao = Number(bem.valorAquisicao) || 0;
  const acumulada = acumuladoContabil(db, bem.id);
  const residual = Number((aquisicao - acumulada).toFixed(2));

  const partidas = [];
  if (acumulada > 0.005) {
    partidas.push({ contaContabilId: contas.acumulada.id, dc: 'D', valor: acumulada,
      historicoComplemento: 'Baixa da depreciação acumulada' });
  }
  if (residual > 0.005) {
    if (!contaResultado) {
      throw new Error(`Bem tem ${residual.toFixed(2)} de valor contábil a baixar e não há conta de `
        + 'resultado na baixa configurada — informe contaResultadoId ou configure o mapeamento');
    }
    if (contaResultado.tipoConta !== 'analitica') {
      throw new Error(`Conta ${contaResultado.codigo} é sintética — aponte para uma analítica`);
    }
    partidas.push({ contaContabilId: contaResultado.id, dc: 'D', valor: residual,
      centroCustoId: bem.centroCustoId || null,
      historicoComplemento: `Valor contábil residual na baixa (${bem.motivoBaixa || 'sem motivo informado'})` });
  }
  partidas.push({ contaContabilId: contas.imobilizado.id, dc: 'C', valor: aquisicao,
    historicoComplemento: 'Baixa do custo de aquisição' });

  const lancamentoId = gravarLancamento(db, {
    data: opts.data || bem.dataBaixa,
    historico: `Baixa de imobilizado — ${bem.codigo} ${bem.descricao}`.slice(0, 200),
    origem: 'patrimonio_baixa',
    origemRef: String(bem.id),
    usuario: opts.usuario || null,
    partidas,
  });
  db.prepare('UPDATE patrimonio_bens SET lancamentoBaixaId = ? WHERE id = ?').run(lancamentoId, bemId);
  return { lancamentoId, aquisicao, acumulada, residual };
}

// ==================== NF-e DE ENTRADA ====================

/**
 * Itens de nota de entrada que são bem do ativo e ainda não viraram patrimônio.
 *
 * O critério é o CFOP: 1551/2551 é "compra de bem para o ativo imobilizado" e
 * é exatamente essa a informação que o fiscal já digitou. Sem isso, cadastrar
 * patrimônio era redigitar a nota inteira à mão.
 */
function candidatosDaNfe(db, opts = {}) {
  const cfops = opts.cfops || CFOPS_IMOBILIZADO;
  const ph = cfops.map(() => '?').join(',');
  const params = [...cfops];

  let sql = `
    SELECT i.id AS itemId, i.nfeId, i.descricao, i.cfop, i.ncm, i.quantidade, i.unidade,
           i.valorUnitario, i.valorTotal, i.valorIpi, i.valorFrete, i.valorDesconto,
           i.produtoId,
           n.numero AS nfeNumero, n.serie AS nfeSerie, n.chaveAcesso, n.dataEmissao,
           n.fornecedorId, COALESCE(f.razaoSocial, n.emitenteRazaoSocial) AS fornecedorNome,
           (SELECT COUNT(*) FROM patrimonio_bens b WHERE b.nfeEntradaItemId = i.id) AS bensCriados
    FROM nfe_entrada_itens i
    JOIN nfe_entrada n ON n.id = i.nfeId
    LEFT JOIN pessoas f ON f.id = n.fornecedorId
    WHERE i.cfop IN (${ph})
      AND COALESCE(n.excluida, 0) = 0
      AND COALESCE(i.ignorado, 0) = 0
  `;
  if (opts.dataInicio) { sql += ' AND n.dataEmissao >= ?'; params.push(opts.dataInicio); }
  if (opts.dataFim) { sql += ' AND n.dataEmissao <= ?'; params.push(opts.dataFim + 'T23:59:59'); }
  sql += ' ORDER BY n.dataEmissao DESC, i.id';

  const itens = db.prepare(sql).all(...params).map((i) => ({
    ...i,
    custoSugerido: custoDoItem(i),
    pendente: i.bensCriados < Math.max(1, Math.round(Number(i.quantidade) || 1)),
  }));

  return opts.incluirJaCriados ? itens : itens.filter((i) => i.pendente);
}

/**
 * Custo de aquisição do item para fins de imobilizado.
 *
 * IPI e frete entram no custo (CPC 27: tudo que é necessário para colocar o bem
 * em condição de uso). ICMS fica dentro também — recuperá-lo depende do CIAP,
 * que este módulo não faz; separar aqui daria um número que ninguém consegue
 * conciliar com a nota.
 */
function custoDoItem(item) {
  const v = (x) => Number(x) || 0;
  return Number((v(item.valorTotal) + v(item.valorIpi) + v(item.valorFrete) - v(item.valorDesconto)).toFixed(2));
}

/**
 * Cria bens a partir de um item de nota.
 *
 * Quantidade 5 vira 5 bens, cada um com código próprio: patrimônio se controla
 * por unidade — é o bem que é transferido, depreciado e baixado, não a linha da
 * nota. O custo é rateado igualmente, com a sobra de centavos no primeiro.
 */
function criarBensDaNfe(db, itemId, opts = {}) {
  const item = db.prepare(`
    SELECT i.*, n.dataEmissao, n.fornecedorId, n.numero AS nfeNumero, n.id AS nfeId
    FROM nfe_entrada_itens i JOIN nfe_entrada n ON n.id = i.nfeId
    WHERE i.id = ?`).get(itemId);
  if (!item) throw new Error('Item de nota não encontrado');

  const jaCriados = db.prepare('SELECT COUNT(*) n FROM patrimonio_bens WHERE nfeEntradaItemId = ?').get(itemId).n;
  const quantidade = Math.max(1, Math.round(Number(item.quantidade) || 1));
  if (jaCriados >= quantidade) {
    return { criados: [], jaExistiam: jaCriados,
      aviso: `Este item já gerou ${jaCriados} bem(ns) — nada a criar` };
  }

  const aCriar = quantidade - jaCriados;
  const custoTotal = custoDoItem(item);
  const porUnidade = Number((custoTotal / quantidade).toFixed(2));
  // A sobra do arredondamento vai no primeiro, senão a soma dos bens não bate
  // com o valor da nota.
  const sobra = Number((custoTotal - porUnidade * quantidade).toFixed(2));

  const dataAquisicao = String(item.dataEmissao || '').slice(0, 10);
  const vidaUtil = Number(opts.vidaUtilMeses) > 0 ? Number(opts.vidaUtilMeses) : 60;
  const categoria = opts.categoria || null;
  const residualUnit = Number(opts.valorResidual) || 0;

  const criados = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < aCriar; i++) {
      const seq = jaCriados + i + 1;
      const valor = Number((porUnidade + (seq === 1 ? sobra : 0)).toFixed(2));
      const codigo = proximoCodigo(db);
      const descricao = quantidade > 1
        ? `${item.descricao} (${seq}/${quantidade})`
        : item.descricao;
      const r = db.prepare(`INSERT INTO patrimonio_bens
        (codigo, descricao, categoria, valorAquisicao, valorResidual, vidaUtilMeses, dataAquisicao,
         fornecedorId, nfeEntradaId, nfeEntradaItemId, sequenciaNoItem, localizacao, responsavel,
         centroCustoId, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        codigo, String(descricao).slice(0, 200), categoria, valor, residualUnit, vidaUtil, dataAquisicao,
        item.fornecedorId || null, item.nfeId, item.id, seq,
        opts.localizacao || null, opts.responsavel || null, opts.centroCustoId || null,
        `Originado da NF-e ${item.nfeNumero || ''} item ${item.numero || ''}`.trim());
      criados.push({ id: r.lastInsertRowid, codigo, descricao, valorAquisicao: valor });
    }
  });
  tx();

  return { criados, jaExistiam: jaCriados, custoTotal, quantidade };
}

function proximoCodigo(db) {
  const ano = new Date().getFullYear();
  const prefix = `BEM-${ano}-`;
  const u = db.prepare('SELECT codigo FROM patrimonio_bens WHERE codigo LIKE ? ORDER BY id DESC LIMIT 1').get(prefix + '%');
  let n = 1;
  if (u) { const m = u.codigo.match(/-(\d+)$/); if (m) n = parseInt(m[1], 10) + 1; }
  return prefix + String(n).padStart(4, '0');
}

// ==================== CONFERÊNCIA ====================

/**
 * O razão bate com o cadastro de bens?
 *
 * Relatório gerencial e balanço divergindo em silêncio é o pior resultado
 * possível: os dois parecem certos isoladamente.
 */
function conferencia(db, ateCompetencia) {
  const ate = ateCompetencia || comp(new Date().toISOString());
  const bens = db.prepare('SELECT * FROM patrimonio_bens').all();

  const porConta = new Map();
  const divergentes = [];
  let semContabilizar = 0;

  for (const bem of bens) {
    const { contas } = contasDoBem(db, bem);
    const acumulada = acumuladoContabil(db, bem.id, ate);
    if (bem.status === 'ativo' && !bem.lancamentoAquisicaoId) semContabilizar++;

    if (contas && contas.imobilizado) {
      const k = contas.imobilizado.codigo;
      const atual = porConta.get(k) || { conta: k, nome: contas.imobilizado.nome, bens: 0, aquisicao: 0, depreciado: 0 };
      if (bem.status === 'ativo') {
        atual.bens++;
        atual.aquisicao += Number(bem.valorAquisicao) || 0;
        atual.depreciado += acumulada;
      }
      porConta.set(k, atual);
    }

    // Depreciação lançada acima do depreciável seria erro grave: significa que
    // um bem depreciou mais do que vale.
    const depreciavel = (Number(bem.valorAquisicao) || 0) - (Number(bem.valorResidual) || 0);
    if (acumulada > depreciavel + 0.01) {
      divergentes.push({ bemId: bem.id, codigo: bem.codigo, acumuladoContabil: acumulada, depreciavel });
    }
  }

  return {
    ateCompetencia: ate,
    porConta: Array.from(porConta.values()).map((c) => ({
      ...c,
      aquisicao: Number(c.aquisicao.toFixed(2)),
      depreciado: Number(c.depreciado.toFixed(2)),
      contabil: Number((c.aquisicao - c.depreciado).toFixed(2)),
    })),
    bensAtivosSemAquisicaoContabilizada: semContabilizar,
    depreciacaoAcimaDoDepreciavel: divergentes,
  };
}

module.exports = {
  CFOPS_IMOBILIZADO,
  migrarDB,
  contasDoBem,
  quotaDoMes, acumuladoContabil,
  apurarDepreciacao, estornarDepreciacao,
  contabilizarAquisicao, contabilizarBaixa,
  candidatosDaNfe, custoDoItem, criarBensDaNfe,
  conferencia,
};
