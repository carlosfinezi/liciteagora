/**
 * obra.js — obra e medição (F2.1 e F2.3).
 *
 * A obra é o agregador do modo sob projeto: junta o que foi contratado, o que
 * foi produzido, o que foi entregue e o que foi faturado. É ela que responde a
 * pergunta que a fábrica não consegue responder hoje — "quanto sobrou nesta
 * obra?".
 *
 * ─── POR QUE FORNECIMENTO E MONTAGEM SÃO SEPARADOS DESDE O CADASTRO ─────────
 * Peça entregue no pátio do cliente é circulação de mercadoria: NF-e, ICMS.
 * Peça montada com guindaste é serviço da lista da LC 116 (item 7.02), com ISS
 * no município da obra.
 *
 * `prod_projeto_itens` guarda `valorUnitario` e `valorMontagemUnitario` em colunas
 * distintas, e `prod_medicao_itens.natureza` carrega a separação até a medição.
 * Somar tudo numa linha e separar depois é o erro que torna a segregação
 * impossível: uma vez emitido o documento com valor único, não há como provar
 * qual parte era serviço.
 *
 * Quando `comMontagem = 0` (o default — o prospect não sabe se monta), nada
 * disso aparece: a medição sai 100% fornecimento.
 */

const { num, normalizarData, gerarNumero, agora } = require('./prod-util');

const STATUS_OBRA = ['orcamento', 'contratada', 'produzindo', 'entregando', 'concluida', 'cancelada'];
const NATUREZAS = ['fornecimento', 'montagem'];

// De onde cada status pode vir. Fora daqui a transição é recusada — obra que
// volta de `concluida` para `orcamento` reabriria medição já faturada.
const TRANSICOES = {
  orcamento: ['contratada', 'cancelada'],
  contratada: ['produzindo', 'cancelada'],
  produzindo: ['entregando', 'concluida'],
  entregando: ['concluida'],
  concluida: [],
  cancelada: [],
};

function carregar(db, id) {
  const obra = db.prepare(`
    SELECT o.*, COALESCE(p.nomeFantasia, p.razaoSocial) AS clienteNome,
           p.razaoSocial AS clienteRazaoSocial, p.cpfCnpj AS clienteDoc
      FROM prod_projetos o
      LEFT JOIN pessoas p ON p.id = o.clienteId
     WHERE o.id = ?
  `).get(id);
  if (!obra) return null;

  obra.itens = db.prepare(`
    SELECT i.*, pr.descricao AS produtoDescricao, pr.unidade,
           pc.modo, pc.pesoKg, pc.quantidadeBase
      FROM prod_projeto_itens i
      JOIN produtos pr ON pr.id = i.produtoId
      LEFT JOIN prod_fichas pc ON pc.produtoId = i.produtoId
     WHERE i.projetoId = ? ORDER BY i.id
  `).all(id);

  obra.ops = db.prepare(`
    SELECT id, numero, produtoId, status, quantidadePlanejada, quantidadeProduzida,
           quantidadeRefugo, custoTotal
      FROM prod_ordens WHERE projetoId = ? ORDER BY id
  `).all(id);

  obra.medicoes = db.prepare(
    'SELECT * FROM prod_medicoes WHERE projetoId = ? ORDER BY numero'
  ).all(id);

  obra.romaneios = db.prepare(
    'SELECT * FROM prod_romaneios WHERE projetoId = ? ORDER BY id'
  ).all(id);

  return obra;
}

function validar(db, dados) {
  if (!String(dados.nome || '').trim()) return 'nome da obra é obrigatório';
  const cli = db.prepare('SELECT id FROM pessoas WHERE id = ?').get(dados.clienteId);
  if (!cli) return 'clienteId não existe';
  if (dados.status && !STATUS_OBRA.includes(dados.status)) {
    return `status inválido: use ${STATUS_OBRA.join(', ')}`;
  }
  return null;
}

function criar(db, dados, usuario, config = {}) {
  const erro = validar(db, dados);
  if (erro) return { erro };

  const prefixo = config.producao_prefixo_projeto || 'OBR';
  const numero = gerarNumero(db, 'prod_projetos', prefixo);

  const r = db.prepare(`
    INSERT INTO prod_projetos
      (numero, clienteId, nome, endereco, cidade, uf, comMontagem, status,
       pedidoId, dataContrato, dataPrevistaEntrega, responsavelCliente,
       observacoes, usuarioCriacao)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'orcamento', ?, ?, ?, ?, ?, ?)
  `).run(numero, dados.clienteId, String(dados.nome).trim(), dados.endereco || null,
    dados.cidade || null, dados.uf || null,
    dados.comMontagem === 1 || dados.comMontagem === '1' ? 1 : 0,
    dados.pedidoId || null, normalizarData(dados.dataContrato),
    normalizarData(dados.dataPrevistaEntrega), dados.responsavelCliente || null,
    dados.observacoes || null, usuario || null);

  return { obra: carregar(db, r.lastInsertRowid) };
}

function atualizar(db, id, dados) {
  const obra = db.prepare('SELECT * FROM prod_projetos WHERE id = ?').get(id);
  if (!obra) return { erro: 'obra não encontrada' };
  if (['concluida', 'cancelada'].includes(obra.status)) {
    return { erro: `obra ${obra.status}: não aceita alteração` };
  }
  const erro = validar(db, { ...obra, ...dados });
  if (erro) return { erro };

  db.prepare(`
    UPDATE prod_projetos
       SET clienteId = ?, nome = ?, endereco = ?, cidade = ?, uf = ?, comMontagem = ?,
           pedidoId = ?, dataContrato = ?, dataPrevistaEntrega = ?,
           responsavelCliente = ?, observacoes = ?, dataAtualizacao = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(dados.clienteId ?? obra.clienteId, String(dados.nome ?? obra.nome).trim(),
    dados.endereco ?? obra.endereco, dados.cidade ?? obra.cidade, dados.uf ?? obra.uf,
    dados.comMontagem != null ? (dados.comMontagem === 1 || dados.comMontagem === '1' ? 1 : 0) : obra.comMontagem,
    dados.pedidoId ?? obra.pedidoId,
    dados.dataContrato ? normalizarData(dados.dataContrato) : obra.dataContrato,
    dados.dataPrevistaEntrega ? normalizarData(dados.dataPrevistaEntrega) : obra.dataPrevistaEntrega,
    dados.responsavelCliente ?? obra.responsavelCliente,
    dados.observacoes ?? obra.observacoes, id);

  return { obra: carregar(db, id) };
}

function mudarStatus(db, id, novo, usuario) {
  const obra = db.prepare('SELECT * FROM prod_projetos WHERE id = ?').get(id);
  if (!obra) return { erro: 'obra não encontrada' };
  if (!STATUS_OBRA.includes(novo)) return { erro: `status inválido: use ${STATUS_OBRA.join(', ')}` };
  if (!TRANSICOES[obra.status].includes(novo)) {
    return { erro: `transição inválida: de "${obra.status}" só se vai para `
      + `${TRANSICOES[obra.status].join(', ') || '(nenhum — status final)'}` };
  }
  if (novo === 'cancelada') {
    const ops = db.prepare(`
      SELECT COUNT(*) n FROM prod_ordens
       WHERE projetoId = ? AND status NOT IN ('planejada','cancelada')
    `).get(id).n;
    if (ops > 0) {
      return { erro: `a obra tem ${ops} ordem(ns) de produção já iniciada(s): `
        + 'cancele-as antes (o material já saiu do estoque)' };
    }
    // Carga a caminho tem de ser resolvida antes: cancelar a obra com o
    // caminhão na estrada deixava a entrega chegar depois e creditar uma obra
    // que já não existe.
    const cargas = db.prepare(`
      SELECT COUNT(*) n FROM prod_romaneios
       WHERE projetoId = ? AND status IN ('montagem','carregado','transito')
    `).get(id).n;
    if (cargas > 0) {
      return { erro: `a obra tem ${cargas} romaneio(s) em aberto: `
        + 'entregue ou cancele a carga antes' };
    }
  }
  db.prepare('UPDATE prod_projetos SET status = ?, dataConclusao = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
    .run(novo, novo === 'concluida' ? agora() : obra.dataConclusao, id);

  return { obra: carregar(db, id) };
}

// ─── Itens ───────────────────────────────────────────────────────────────────

function salvarItem(db, projetoId, itemId, dados) {
  const obra = db.prepare('SELECT * FROM prod_projetos WHERE id = ?').get(projetoId);
  if (!obra) return { erro: 'obra não encontrada' };
  if (['concluida', 'cancelada'].includes(obra.status)) {
    return { erro: `obra ${obra.status}: itens congelados` };
  }

  const prod = db.prepare('SELECT id, descricao FROM produtos WHERE id = ?').get(dados.produtoId);
  if (!prod) return { erro: 'produtoId não existe' };

  const qtd = num(dados.quantidade, { min: 0.0001 });
  if (qtd == null) return { erro: 'quantidade deve ser > 0' };
  const vu = num(dados.valorUnitario, { min: 0 });
  if (vu == null) return { erro: 'valorUnitario deve ser >= 0' };

  const vm = num(dados.valorMontagemUnitario, { min: 0 }) ?? 0;
  // Cobrar montagem numa obra sem montagem é o começo de uma NFS-e que não
  // deveria existir. Barrar aqui é mais barato que descobrir na medição.
  if (vm > 0 && !obra.comMontagem) {
    return { erro: 'esta obra não é "com montagem": zere valorMontagemUnitario '
      + 'ou marque comMontagem na obra' };
  }

  if (itemId) {
    const it = db.prepare('SELECT * FROM prod_projeto_itens WHERE id = ? AND projetoId = ?').get(itemId, projetoId);
    if (!it) return { erro: 'item não encontrado nesta obra' };
    // O piso é o MAIOR entre produzido e entregue. `quantidadeEntregue` virou
    // coluna materializada (antes era recalculada dos romaneios), então sem
    // esta guarda dava para reduzir o contrato abaixo do que já saiu — e o
    // painel mostrava entrega de 500%.
    const piso = Math.max(it.quantidadeProduzida, it.quantidadeEntregue);
    if (qtd < piso) {
      return { erro: `já foram ${it.quantidadeProduzida} produzida(s) e `
        + `${it.quantidadeEntregue} entregue(s): a quantidade não pode ficar abaixo de ${piso}` };
    }
    db.prepare(`
      UPDATE prod_projeto_itens
         SET produtoId = ?, descricao = ?, quantidade = ?, valorUnitario = ?,
             valorTotal = ?, valorMontagemUnitario = ?, observacoes = ?
       WHERE id = ?
    `).run(dados.produtoId, dados.descricao || prod.descricao, qtd, vu, qtd * vu, vm,
      dados.observacoes || null, itemId);
  } else {
    db.prepare(`
      INSERT INTO prod_projeto_itens
        (projetoId, produtoId, descricao, quantidade, valorUnitario, valorTotal,
         valorMontagemUnitario, observacoes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(projetoId, dados.produtoId, dados.descricao || prod.descricao, qtd, vu,
      qtd * vu, vm, dados.observacoes || null);
  }

  recalcularTotais(db, projetoId);
  return { obra: carregar(db, projetoId) };
}

function removerItem(db, projetoId, itemId) {
  const it = db.prepare('SELECT * FROM prod_projeto_itens WHERE id = ? AND projetoId = ?').get(itemId, projetoId);
  if (!it) return { erro: 'item não encontrado nesta obra' };
  if (it.quantidadeProduzida > 0 || it.quantidadeEntregue > 0) {
    return { erro: `item com ${it.quantidadeProduzida} produzida(s) e `
      + `${it.quantidadeEntregue} entregue(s) não pode ser removido` };
  }
  db.prepare('DELETE FROM prod_projeto_itens WHERE id = ?').run(itemId);
  recalcularTotais(db, projetoId);
  return { obra: carregar(db, projetoId) };
}

/** Materializa o valor contratado. Inclui a montagem — ela é parte do contrato. */
function recalcularTotais(db, projetoId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(valorTotal), 0) AS fornecimento,
           COALESCE(SUM(valorMontagemUnitario * quantidade), 0) AS montagem
      FROM prod_projeto_itens WHERE projetoId = ?
  `).get(projetoId);
  const medido = db.prepare(`
    SELECT COALESCE(SUM(valorTotal), 0) AS v FROM prod_medicoes
     WHERE projetoId = ? AND status <> 'cancelada'
  `).get(projetoId).v;

  db.prepare('UPDATE prod_projetos SET valorContratado = ?, valorMedido = ? WHERE id = ?')
    .run(row.fornecimento + row.montagem, medido, projetoId);
}

// ─── Medição ─────────────────────────────────────────────────────────────────

/**
 * Prévia da medição: o que está entregue e ainda não foi medido.
 *
 * A base é o ROMANEIO ENTREGUE, não a peça produzida. Peça no pátio é estoque
 * da fábrica; peça entregue é receita. Medir produção seria antecipar
 * faturamento de algo que ainda pode quebrar na viagem.
 */
function previaMedicao(db, projetoId) {
  const obra = carregar(db, projetoId);
  if (!obra) return { erro: 'obra não encontrada' };

  // Agrupado por (romaneio, produto): cada linha da medição carrega o romaneio
  // que a originou.
  //
  // O que já foi medido é descontado POR QUANTIDADE, não por romaneio. Excluir
  // o romaneio inteiro quando qualquer linha dele foi medida era um caminho
  // sem volta: numa medição parcial (entrega maior que o saldo contratado no
  // momento), a sobra saía da fábrica, baixava estoque e nunca mais podia ser
  // faturada — nem depois de um aditivo elevar o contrato.
  // Agrupa também por `projetoItemId` da OP que produziu a peça: é o mesmo
  // vínculo que `expedicao.creditarEntrega` usa para creditar. Sem isso a
  // prévia precificava pelo FIFO enquanto o crédito ia para o item certo — a
  // peça produzida para o aditivo de R$ 1.500 era faturada a R$ 1.000.
  // Item de catálogo não passa por OP: `projetoItemId` fica NULL e cai no FIFO.
  const entregues = db.prepare(`
    SELECT ri.romaneioId, r.numero AS romaneioNumero, ri.produtoId,
           o.projetoItemId AS projetoItemVinculado,
           SUM(ri.quantidade) AS quantidade,
           COALESCE((
             SELECT SUM(mi.quantidade) FROM prod_medicao_itens mi
               JOIN prod_medicoes m ON m.id = mi.medicaoId
              WHERE mi.romaneioId = ri.romaneioId AND m.status <> 'cancelada'
                AND mi.natureza = 'fornecimento'
                AND mi.projetoItemId IN (
                  SELECT id FROM prod_projeto_itens WHERE projetoId = ? AND produtoId = ri.produtoId
                )
           ), 0) AS jaMedida
      FROM prod_romaneio_itens ri
      JOIN prod_romaneios r ON r.id = ri.romaneioId
      LEFT JOIN prod_unidades pp ON pp.id = ri.unidadeId
      LEFT JOIN prod_ordens o ON o.id = pp.opId
     WHERE r.projetoId = ? AND r.status = 'entregue'
     GROUP BY ri.romaneioId, ri.produtoId, o.projetoItemId
    HAVING quantidade > jaMedida
     ORDER BY ri.romaneioId, ri.produtoId
  `).all(projetoId, projetoId).map(e => ({ ...e, quantidade: e.quantidade - e.jaMedida }));

  // Quanto de cada item de obra já foi medido (medição cancelada não conta).
  // É o que impede a segunda medição de repreencher a mesma linha.
  const medidoPorItem = new Map(db.prepare(`
    SELECT mi.projetoItemId AS id, COALESCE(SUM(mi.quantidade), 0) AS q
      FROM prod_medicao_itens mi
      JOIN prod_medicoes m ON m.id = mi.medicaoId
     WHERE m.projetoId = ? AND m.status <> 'cancelada' AND mi.natureza = 'fornecimento'
       AND mi.projetoItemId IS NOT NULL
     GROUP BY mi.projetoItemId
  `).all(projetoId).map(r => [r.id, r.q]));

  // Saldo medível de cada item, na ordem de cadastro (a ordem em que foram
  // contratados). Um produto pode ter duas linhas — lote original e aditivo,
  // com preços diferentes —, e é por isso que não se pode usar `find`: a
  // primeira linha precificaria a entrega inteira pelo preço errado.
  const saldo = new Map();
  for (const i of obra.itens) {
    saldo.set(i.id, Math.max(0, i.quantidade - (medidoPorItem.get(i.id) || 0)));
  }

  const itens = [];
  const naoContratados = [];
  let fornecimento = 0, montagem = 0;

  for (const e of entregues) {
    // Vínculo explícito primeiro; FIFO só quando não há.
    const vinculado = e.projetoItemVinculado
      ? obra.itens.filter(i => i.id === e.projetoItemVinculado) : [];
    const candidatos = vinculado.length
      ? vinculado : obra.itens.filter(i => i.produtoId === e.produtoId);
    let restante = e.quantidade;

    for (const oi of candidatos) {
      if (restante <= 0) break;
      const cabe = saldo.get(oi.id) || 0;
      if (cabe <= 0) continue;
      const q = Math.min(cabe, restante);
      saldo.set(oi.id, cabe - q);
      restante -= q;

      const vf = q * oi.valorUnitario;
      fornecimento += vf;
      itens.push({
        projetoItemId: oi.id, romaneioId: e.romaneioId, romaneioNumero: e.romaneioNumero,
        produtoId: e.produtoId, descricao: oi.descricao,
        natureza: 'fornecimento', quantidade: q,
        valorUnitario: oi.valorUnitario, valorTotal: vf,
      });
      if (obra.comMontagem && oi.valorMontagemUnitario > 0) {
        const vm = q * oi.valorMontagemUnitario;
        montagem += vm;
        itens.push({
          projetoItemId: oi.id, romaneioId: e.romaneioId, romaneioNumero: e.romaneioNumero,
          produtoId: e.produtoId, descricao: `Montagem — ${oi.descricao}`,
          natureza: 'montagem', quantidade: q,
          valorUnitario: oi.valorMontagemUnitario, valorTotal: vm,
        });
      }
    }

    // Entregue sem item contratado com saldo: não se inventa preço.
    if (restante > 0) {
      naoContratados.push({
        produtoId: e.produtoId, quantidade: restante, romaneioNumero: e.romaneioNumero,
        motivo: candidatos.length ? 'entregue acima do contratado' : 'produto fora do contrato da obra',
      });
    }
  }

  return {
    projetoId, comMontagem: obra.comMontagem,
    romaneios: [...new Set(entregues.map(e => e.romaneioId))],
    romaneiosNumeros: [...new Set(entregues.map(e => e.romaneioNumero))],
    itens,
    naoContratados,
    valorFornecimento: fornecimento,
    valorMontagem: montagem,
    valorTotal: fornecimento + montagem,
    nota: obra.comMontagem
      ? 'Fornecimento sai em NF-e; montagem, em NFS-e (LC 116, item 7.02). A separação '
        + 'está nas linhas por `natureza`.'
      : 'Obra sem montagem: medição 100% fornecimento (NF-e).',
  };
}

/**
 * Gera a medição a partir da prévia. O UNIQUE parcial em
 * (projetoId, competencia) impede medir a mesma competência duas vezes.
 */
function gerarMedicao(db, projetoId, dados, usuario) {
  // `criarRomaneio` já recusa obra cancelada, mas nada revalidava aqui: era
  // possível faturar uma obra cancelada.
  const o = db.prepare('SELECT status FROM prod_projetos WHERE id = ?').get(projetoId);
  if (!o) return { erro: 'obra não encontrada' };
  if (o.status === 'cancelada') return { erro: 'obra cancelada não pode ser medida' };

  const previa = previaMedicao(db, projetoId);
  if (previa.erro) return previa;
  if (!previa.itens.length) {
    return { erro: 'nada a medir: não há romaneio entregue e ainda não medido nesta obra' };
  }

  const competencia = dados.competencia ? String(dados.competencia).trim() : null;
  if (competencia && !/^\d{4}-\d{2}$/.test(competencia)) {
    return { erro: 'competencia deve estar no formato YYYY-MM' };
  }
  if (competencia) {
    const dup = db.prepare(`
      SELECT id FROM prod_medicoes
       WHERE projetoId = ? AND competencia = ? AND status <> 'cancelada'
    `).get(projetoId, competencia);
    if (dup) return { erro: `a competência ${competencia} já foi medida nesta obra (medição #${dup.id})` };
  }

  const proximo = db.prepare(
    'SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM prod_medicoes WHERE projetoId = ?'
  ).get(projetoId).n;

  let medicaoId;
  const tx = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO prod_medicoes
        (projetoId, competencia, numero, dataInicio, dataFim, valorFornecimento,
         valorMontagem, valorTotal, status, observacoes, usuario)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'gerada', ?, ?)
    `).run(projetoId, competencia, proximo, normalizarData(dados.dataInicio),
      normalizarData(dados.dataFim), previa.valorFornecimento, previa.valorMontagem,
      previa.valorTotal, dados.observacoes || null, usuario || null);
    medicaoId = r.lastInsertRowid;

    const ins = db.prepare(`
      INSERT INTO prod_medicao_itens
        (medicaoId, projetoItemId, romaneioId, descricao, natureza, quantidade,
         valorUnitario, valorTotal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Cada linha já vem com o seu romaneio (a prévia agrupa por romaneio ×
    // produto): é esse carimbo que impede medir a mesma entrega outra vez.
    for (const it of previa.itens) {
      ins.run(medicaoId, it.projetoItemId, it.romaneioId, it.descricao, it.natureza,
        it.quantidade, it.valorUnitario, it.valorTotal);
    }
    recalcularTotais(db, projetoId);
  });
  tx();

  return { medicao: carregarMedicao(db, medicaoId) };
}

function carregarMedicao(db, id) {
  const m = db.prepare('SELECT * FROM prod_medicoes WHERE id = ?').get(id);
  if (!m) return null;
  m.itens = db.prepare('SELECT * FROM prod_medicao_itens WHERE medicaoId = ? ORDER BY id').all(id);
  return m;
}

function cancelarMedicao(db, id, motivo, usuario) {
  const m = db.prepare('SELECT * FROM prod_medicoes WHERE id = ?').get(id);
  if (!m) return { erro: 'medição não encontrada' };
  if (m.status === 'cancelada') return { erro: 'medição já cancelada' };
  if (m.nfeId || m.nfseId) {
    return { erro: 'medição com nota fiscal emitida: cancele a nota antes' };
  }
  if (!String(motivo || '').trim()) return { erro: 'motivo é obrigatório' };

  db.prepare(`
    UPDATE prod_medicoes
       SET status = 'cancelada',
           observacoes = COALESCE(observacoes || ' | ', '') || ?
     WHERE id = ?
  `).run(`Cancelada por ${usuario || 'sistema'}: ${motivo}`, id);

  recalcularTotais(db, m.projetoId);
  return { medicao: carregarMedicao(db, id) };
}

/**
 * Situação da obra: contratado × produzido × entregue × medido, item a item.
 * É o painel que responde "quanto falta" sem ninguém abrir planilha.
 */
function situacao(db, projetoId) {
  const obra = carregar(db, projetoId);
  if (!obra) return { erro: 'obra não encontrada' };

  // `quantidadeEntregue` vem da COLUNA, que `expedicao.creditarEntrega`
  // preenche item a item na entrega. Recalcular aqui somando os romaneios por
  // produto daria o número errado quando a obra tem duas linhas do mesmo
  // produto (lote original + aditivo): as 10 peças de um romaneio apareceriam
  // como 10 em cada linha.
  const itens = obra.itens.map(i => ({
    ...i,
    saldoAProduzir: Math.max(0, i.quantidade - i.quantidadeProduzida),
    saldoAEntregar: Math.max(0, i.quantidadeProduzida - i.quantidadeEntregue),
    percentualProduzido: i.quantidade > 0 ? (i.quantidadeProduzida / i.quantidade) * 100 : 0,
    percentualEntregue: i.quantidade > 0 ? (i.quantidadeEntregue / i.quantidade) * 100 : 0,
  }));

  const custo = db.prepare(`
    SELECT COALESCE(SUM(custoTotal), 0) AS c FROM prod_ordens
     WHERE projetoId = ? AND status = 'concluida'
  `).get(projetoId).c;

  return {
    obra: {
      id: obra.id, numero: obra.numero, nome: obra.nome, status: obra.status,
      cliente: obra.clienteNome, comMontagem: obra.comMontagem,
    },
    itens,
    valorContratado: obra.valorContratado,
    valorMedido: obra.valorMedido,
    saldoAMedir: obra.valorContratado - obra.valorMedido,
    custoProducao: custo,
    // Margem sobre o que já foi medido, não sobre o contrato: é o que
    // efetivamente virou receita.
    margemSobreMedido: obra.valorMedido > 0
      ? ((obra.valorMedido - custo) / obra.valorMedido) * 100 : null,
  };
}

module.exports = {
  STATUS_OBRA, NATUREZAS, TRANSICOES,
  carregar, criar, atualizar, mudarStatus, salvarItem, removerItem,
  recalcularTotais, previaMedicao, gerarMedicao, carregarMedicao,
  cancelarMedicao, situacao,
};
