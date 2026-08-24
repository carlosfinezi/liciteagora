/**
 * comissoes-calculo.js — as decisões de comissão em um lugar só.
 *
 * O que estava errado e este módulo resolve:
 *
 *  1. Pedido `faturado` — a venda mais completa que existe, com nota emitida —
 *     não entrava na apuração. O critério era `status='confirmado' OR
 *     statusPagamento='pago'`, e ao avançar de confirmado para faturado a
 *     comissão simplesmente sumia.
 *  2. Pedido `cancelado` com pagamento registrado entrava. Venda desfeita
 *     comissionada.
 *  3. Empate de especificidade entre duas regras era resolvido pela ordem que o
 *     SQLite devolvesse. O mesmo item podia comissionar diferente entre duas
 *     apurações sem nada ter mudado.
 *  4. `percentual_lucro` usava o custo médio de HOJE, não o da data da venda:
 *     reapurar um mês fechado dava outro número. E sem custo nenhum o lucro
 *     virava a venda inteira — comissão inflada, em silêncio.
 *
 * O que não existia e passou a existir: gatilho e acelerador por meta, que é
 * como plano de comissão de verdade funciona.
 */

const TIPOS_REGRA = ['percentual_venda', 'percentual_lucro', 'fixo_por_unidade'];

// Bases de apuração, da mais frouxa para a mais conservadora.
const BASES = {
  // Pedido fechado com o cliente. Comissiona antes de faturar e antes de receber.
  confirmado: ['confirmado', 'faturado'],
  // Só depois da nota emitida.
  faturado: ['faturado'],
  // Só o que entrou em caixa — o filtro de statusPagamento entra por fora.
  recebido: ['confirmado', 'faturado'],
};

const erro = (codigo, mensagem, extra = {}) => ({ nivel: 'erro', codigo, mensagem, ...extra });
const aviso = (codigo, mensagem, extra = {}) => ({ nivel: 'aviso', codigo, mensagem, ...extra });

// ==================== ELEGIBILIDADE ====================

/**
 * Pedidos que entram na apuração.
 *
 * `cancelado` nunca entra, com ou sem pagamento: a venda foi desfeita. Antes,
 * um pedido cancelado que tivesse sido pago passava pelo `OR statusPagamento`
 * e gerava comissão.
 */
function sqlPedidosElegiveis(base) {
  const status = BASES[base] || BASES.confirmado;
  const lista = status.map((s) => `'${s}'`).join(', ');
  let sql = `
    SELECT p.*, c.razaoSocial AS clienteNome
    FROM pedidos p
    LEFT JOIN pessoas c ON c.id = p.clienteId
    WHERE p.dataPedido >= ? AND p.dataPedido <= ?
      AND p.vendedorId IS NOT NULL
      AND p.status IN (${lista})
  `;
  if (base === 'recebido') sql += " AND p.statusPagamento = 'pago'";
  return sql;
}

// ==================== ESCOLHA DA REGRA ====================

/**
 * Especificidade da regra. Escopos mais estreitos ganham de mais largos.
 * O desempate por id existe para a apuração ser reprodutível: sem ele, duas
 * regras igualmente específicas sorteavam a vencedora a cada rodada.
 */
function especificidade(r) {
  let s = 0;
  if (r.vendedorId) s += 8;
  if (r.produtoId) s += 4;
  if (r.categoriaProduto) s += 2;
  if (r.clienteId) s += 1;
  return s;
}

function regraAplicavel(r, item, pedido, produto) {
  if (!r.ativo) return false;
  const dataPedido = (pedido.dataPedido || '').slice(0, 10);
  if (r.dataInicio && dataPedido && dataPedido < r.dataInicio) return false;
  if (r.dataFim && dataPedido && dataPedido > r.dataFim) return false;
  if (r.vendedorId && r.vendedorId !== pedido.vendedorId) return false;
  if (r.produtoId && r.produtoId !== item.produtoId) return false;
  if (r.clienteId && r.clienteId !== pedido.clienteId) return false;
  if (r.categoriaProduto && r.categoriaProduto !== (produto && produto.categoria)) return false;
  return true;
}

/**
 * Regra implícita do cadastro do vendedor.
 *
 * `users.comissaoPercentual` sempre existiu e o motor nunca olhou para ele:
 * quem preenchia o percentual na ficha do vendedor achava que estava
 * configurado, e a apuração devolvia "sem regra" para todos os itens dele.
 *
 * Entra como último recurso, depois de qualquer regra escrita — e vem marcada
 * para o relatório poder dizer de onde saiu.
 */
function regraDoCadastro(db, vendedorId) {
  try {
    const u = db.prepare('SELECT id, nome, comissaoPercentual FROM users WHERE id = ?').get(vendedorId);
    const pct = Number(u && u.comissaoPercentual) || 0;
    if (!(pct > 0)) return null;
    return {
      id: null, origem: 'cadastro_vendedor',
      nome: `Percentual do cadastro de ${u.nome || 'vendedor #' + vendedorId}`,
      vendedorId, tipo: 'percentual_venda', valor: pct, ativo: 1,
    };
  } catch { return null; }
}

function escolherRegra(regras, item, pedido, produto) {
  const aplicaveis = regras.filter((r) => regraAplicavel(r, item, pedido, produto));
  if (!aplicaveis.length) return { regra: null, empatadas: [] };

  aplicaveis.sort((a, b) => (especificidade(b) - especificidade(a)) || (a.id - b.id));
  const topo = especificidade(aplicaveis[0]);
  // Empate importa: são duas regras que o usuário escreveu achando que cada
  // uma valia. Escolher a mais antiga é arbitrário, mas ao menos é estável —
  // e o diagnóstico avisa que existe ambiguidade a resolver.
  const empatadas = aplicaveis.filter((r) => especificidade(r) === topo);
  return { regra: aplicaveis[0], empatadas: empatadas.length > 1 ? empatadas : [] };
}

// ==================== CUSTO ====================

/**
 * Custo médio do produto na data da venda.
 *
 * Antes era a última movimentação de estoque existente, sem recorte de data:
 * reapurar março em julho usava o custo de julho. Comissão sobre lucro que muda
 * sozinha é comissão que ninguém consegue conferir.
 */
function custoNaData(db, produtoId, data) {
  if (!produtoId) return { custo: 0, encontrado: false };
  try {
    const r = db.prepare(`
      SELECT custoMedioPosterior FROM movimentacoes_estoque
      WHERE produtoId = ? AND custoMedioPosterior IS NOT NULL AND data <= ?
      ORDER BY data DESC, id DESC LIMIT 1`).get(produtoId, data);
    if (r && r.custoMedioPosterior != null) return { custo: Number(r.custoMedioPosterior), encontrado: true };
  } catch { /* tenant sem movimentação de estoque */ }

  // Sem histórico até a data: cai no cadastro do produto antes de assumir zero.
  try {
    const p = db.prepare('SELECT custoMedio, precoCusto FROM produtos WHERE id = ?').get(produtoId);
    const c = Number((p && (p.custoMedio || p.precoCusto)) || 0);
    if (c > 0) return { custo: c, encontrado: true, origem: 'cadastro' };
  } catch { /* coluna ausente */ }

  return { custo: 0, encontrado: false };
}

// ==================== META ====================

/**
 * Quanto o vendedor vendeu no período, para medir contra a meta.
 * Usa a mesma base da apuração — comparar venda faturada com meta apurada sobre
 * pedido confirmado daria um percentual que não significa nada.
 */
function realizadoDoVendedor(db, vendedorId, periodo, base) {
  const ini = `${periodo}-01`;
  const [y, m] = periodo.split('-').map(Number);
  const fim = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const status = (BASES[base] || BASES.confirmado).map((s) => `'${s}'`).join(', ');
  let sql = `SELECT COALESCE(SUM(valorTotal), 0) AS total, COUNT(*) AS pedidos
    FROM pedidos WHERE vendedorId = ? AND dataPedido >= ? AND dataPedido <= ?
      AND status IN (${status})`;
  if (base === 'recebido') sql += " AND statusPagamento = 'pago'";
  return db.prepare(sql).get(vendedorId, ini, fim);
}

/**
 * Situação da meta do vendedor no período. Sem meta cadastrada devolve null —
 * e aí gatilho e acelerador não se aplicam, em vez de assumir meta zero (que
 * daria "meta batida" para todo mundo).
 */
function situacaoMeta(db, vendedorId, periodo, base) {
  let meta = null;
  try {
    meta = db.prepare('SELECT * FROM metas_vendas WHERE vendedorUserId = ? AND competencia = ?')
      .get(vendedorId, periodo);
  } catch { return null; }
  if (!meta || !(Number(meta.valorMeta) > 0)) return null;

  const r = realizadoDoVendedor(db, vendedorId, periodo, base);
  const realizado = Number(r.total) || 0;
  const valorMeta = Number(meta.valorMeta);
  return {
    valorMeta,
    realizado,
    pedidos: r.pedidos,
    percentual: (realizado / valorMeta) * 100,
    atingida: realizado >= valorMeta,
  };
}

// ==================== CÁLCULO ====================

/**
 * Comissão de um item.
 *
 * @param {object} meta  situação da meta do vendedor (null = sem meta cadastrada)
 * @returns {object} { base, percentual, valor, motivo }  motivo != null = não comissionou
 */
function calcularComissao(regra, item, opts = {}) {
  const qtd = Number(item.quantidade) || 0;
  const total = Number(item.valorTotal) || 0;
  const meta = opts.meta || null;

  // ---- gatilho de meta ----
  // Plano com gatilho: abaixo de X% da meta não há comissão nenhuma. Sem meta
  // cadastrada o gatilho é ignorado — senão o vendedor sem meta nunca receberia.
  const gatilho = Number(regra.metaMinimaPercentual) || 0;
  if (gatilho > 0) {
    if (!meta) {
      return { base: 0, percentual: null, valor: 0,
        motivo: `regra exige ${gatilho}% da meta, mas não há meta cadastrada para o vendedor no período` };
    }
    if (meta.percentual < gatilho - 0.0001) {
      return { base: 0, percentual: null, valor: 0,
        motivo: `${meta.percentual.toFixed(1)}% da meta atingida, abaixo do gatilho de ${gatilho}%` };
    }
  }

  // ---- acelerador ----
  // Percentual maior quando a meta foi batida. Só faz sentido nos tipos
  // percentuais; em valor fixo por unidade o acelerador substitui o valor.
  const acelerado = Number(regra.valorAcelerado) || 0;
  const usaAcelerador = acelerado > 0 && meta && meta.atingida;
  const taxa = usaAcelerador ? acelerado : Number(regra.valor);

  if (regra.tipo === 'percentual_venda') {
    return { base: total, percentual: taxa, valor: total * taxa / 100, acelerado: usaAcelerador };
  }

  if (regra.tipo === 'percentual_lucro') {
    const custoUnit = Number(opts.custoUnitario) || 0;
    const custo = custoUnit * qtd;
    // Sem custo conhecido o "lucro" seria a venda inteira. Comissionar isso é
    // pagar percentual de lucro sobre faturamento sem ninguém perceber.
    if (!opts.custoEncontrado) {
      return { base: 0, percentual: taxa, valor: 0,
        motivo: 'sem custo conhecido do produto até a data da venda — lucro não pode ser apurado' };
    }
    const lucro = total - custo;
    if (lucro <= 0) {
      return { base: lucro, percentual: taxa, valor: 0,
        motivo: `venda sem lucro (custo ${custo.toFixed(2)} >= venda ${total.toFixed(2)})` };
    }
    return { base: lucro, percentual: taxa, valor: lucro * taxa / 100, acelerado: usaAcelerador };
  }

  if (regra.tipo === 'fixo_por_unidade') {
    return { base: qtd, percentual: null, valor: qtd * taxa, acelerado: usaAcelerador };
  }

  return { base: 0, percentual: null, valor: 0, motivo: `tipo de regra desconhecido: ${regra.tipo}` };
}

// ==================== VALIDAÇÃO DE REGRA ====================

function validarRegra(db, dados, opts = {}) {
  const p = [];

  if (!dados.nome || !String(dados.nome).trim()) p.push(erro('nome_obrigatorio', 'Nome da regra obrigatório'));
  if (!TIPOS_REGRA.includes(dados.tipo)) {
    p.push(erro('tipo_invalido', `tipo deve ser um de: ${TIPOS_REGRA.join(', ')}`));
  }

  const valor = Number(dados.valor);
  if (!(valor > 0)) {
    p.push(erro('valor_invalido', 'Valor da regra deve ser maior que zero'));
  } else if (dados.tipo !== 'fixo_por_unidade' && valor > 100) {
    // 15 digitado como 1500 é o erro clássico e sai caro.
    p.push(erro('percentual_acima_de_100', `Percentual de ${valor}% — confira: percentual vai de 0 a 100`));
  } else if (dados.tipo !== 'fixo_por_unidade' && valor > 50) {
    p.push(aviso('percentual_alto', `Percentual de ${valor}% é incomum — confirme antes de gravar`));
  }

  const acelerado = Number(dados.valorAcelerado) || 0;
  if (acelerado > 0) {
    if (dados.tipo !== 'fixo_por_unidade' && acelerado > 100) {
      p.push(erro('acelerado_acima_de_100', `Percentual acelerado de ${acelerado}% — vai de 0 a 100`));
    }
    if (acelerado < valor) {
      p.push(aviso('acelerador_menor',
        `O valor acelerado (${acelerado}) é menor que o normal (${valor}) — bater a meta reduziria a comissão`));
    }
  }

  const gatilho = Number(dados.metaMinimaPercentual) || 0;
  if (gatilho < 0 || gatilho > 300) {
    p.push(erro('gatilho_invalido', 'Gatilho de meta deve ficar entre 0 e 300%'));
  }

  if (dados.dataInicio && dados.dataFim && dados.dataFim < dados.dataInicio) {
    p.push(erro('vigencia_invertida', 'Data final da vigência anterior à inicial'));
  }

  // ---- sombreamento ----
  // Duas regras com o mesmo escopo e vigência sobreposta: uma delas nunca vai
  // ser usada, e quem escreveu não sabe qual.
  if (opts.checarSombra !== false) {
    try {
      const iguais = db.prepare(`SELECT * FROM comissoes_regras
        WHERE ativo = 1 AND id <> ?
          AND COALESCE(vendedorId,0) = COALESCE(?,0)
          AND COALESCE(produtoId,0) = COALESCE(?,0)
          AND COALESCE(clienteId,0) = COALESCE(?,0)
          AND COALESCE(categoriaProduto,'') = COALESCE(?,'')`)
        .all(opts.id || -1, dados.vendedorId || null, dados.produtoId || null,
             dados.clienteId || null, dados.categoriaProduto || null);

      const sobrepoe = iguais.filter((r) => {
        const aIni = dados.dataInicio || '0000-01-01', aFim = dados.dataFim || '9999-12-31';
        const bIni = r.dataInicio || '0000-01-01', bFim = r.dataFim || '9999-12-31';
        return aIni <= bFim && aFim >= bIni;
      });
      if (sobrepoe.length) {
        p.push(aviso('regra_sombreada',
          `Mesmo escopo e vigência de "${sobrepoe[0].nome}" (#${sobrepoe[0].id}). `
          + 'A mais antiga vence e a outra nunca será aplicada — restrinja o escopo ou a vigência',
          { conflitaCom: sobrepoe.map((r) => r.id) }));
      }
    } catch { /* tabela ainda não migrada */ }
  }

  return p;
}

// ==================== DIAGNÓSTICO ====================

/**
 * O que a apuração não conseguiu resolver. `ignoradasSemRegra` era só um número
 * — dizia que havia problema sem dizer onde.
 */
function diagnosticoRegras(db, periodo, opts = {}) {
  const base = opts.base || 'confirmado';
  const ini = `${periodo}-01`;
  const [y, m] = periodo.split('-').map(Number);
  const fim = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

  const regras = db.prepare('SELECT * FROM comissoes_regras WHERE ativo = 1').all();
  const pedidos = db.prepare(sqlPedidosElegiveis(base)).all(ini, fim);

  const stmtItens = db.prepare(`
    SELECT pi.*, pr.categoria FROM pedido_itens pi
    LEFT JOIN produtos pr ON pr.id = pi.produtoId WHERE pi.pedidoId = ?`);

  const semRegra = [];
  const ambiguos = [];
  const usadas = new Set();

  for (const ped of pedidos) {
    for (const it of stmtItens.all(ped.id)) {
      const { regra, empatadas } = escolherRegra(regras, it, ped, { categoria: it.categoria });
      if (!regra) {
        semRegra.push({ pedidoId: ped.id, pedidoNumero: ped.numero, itemId: it.id,
                        descricao: it.descricao, valor: Number(it.valorTotal) || 0,
                        vendedorId: ped.vendedorId });
        continue;
      }
      usadas.add(regra.id);
      if (empatadas.length) {
        ambiguos.push({ pedidoId: ped.id, itemId: it.id, descricao: it.descricao,
                        aplicada: regra.id, empatadas: empatadas.map((r) => ({ id: r.id, nome: r.nome })) });
      }
    }
  }

  // Regra ativa que não casou com nada no período: ou o escopo está errado, ou
  // ela está sombreada por outra.
  const mortas = regras.filter((r) => !usadas.has(r.id))
    .map((r) => ({ id: r.id, nome: r.nome, tipo: r.tipo, valor: r.valor }));

  const pedidosVistos = new Set(pedidos.map((p) => p.id));
  const foraDaBase = db.prepare(`
    SELECT p.id, p.numero, p.status, p.statusPagamento, p.valorTotal
    FROM pedidos p
    WHERE p.dataPedido >= ? AND p.dataPedido <= ? AND p.vendedorId IS NOT NULL
      AND p.status <> 'cancelado'`).all(ini, fim)
    .filter((p) => !pedidosVistos.has(p.id));

  return {
    periodo,
    base,
    pedidosNaBase: pedidos.length,
    itensSemRegra: semRegra,
    valorSemRegra: semRegra.reduce((s, x) => s + x.valor, 0),
    itensAmbiguos: ambiguos,
    regrasSemUso: mortas,
    // Pedido com vendedor que ficou de fora só por causa da base escolhida:
    // quem apura por 'recebido' precisa saber quanto está esperando entrar.
    pedidosForaDaBase: foraDaBase,
    valorForaDaBase: foraDaBase.reduce((s, p) => s + (Number(p.valorTotal) || 0), 0),
  };
}

module.exports = {
  TIPOS_REGRA, BASES,
  sqlPedidosElegiveis,
  especificidade, regraAplicavel, escolherRegra, regraDoCadastro,
  custoNaData,
  realizadoDoVendedor, situacaoMeta,
  calcularComissao,
  validarRegra,
  diagnosticoRegras,
};
