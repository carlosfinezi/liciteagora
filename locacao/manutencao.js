/**
 * manutencao.js — manutenção por uso e indicadores da frota.
 *
 * ─── Manutenção por uso, não por calendário ─────────────────────────────────
 * Uma máquina alugada 200 horas em um mês precisa de revisão antes de outra
 * que ficou parada no pátio. Por isso o plano é medido em horímetro/km e só
 * cai para dias quando não há medidor.
 *
 * O acumulado sai de `locacao_medidor_leituras`, alimentada na entrega e na
 * devolução (apuracao.js). A leitura é digitada: telemetria automática está
 * fora do escopo da v1.
 *
 * Quando o plano vence, duas coisas acontecem juntas e por transação:
 *   1. abre uma OS de manutenção;
 *   2. grava um BLOQUEIO no período — e é isso que tira o ativo da
 *      disponibilidade sem nenhuma regra especial no cálculo da F2.
 *
 * ─── Ocupação ───────────────────────────────────────────────────────────────
 * taxa = dias-unidade ocupados ÷ (dias do período × unidades em estoque)
 *
 * O denominador usa o saldo FÍSICO: uma locadora com 3 betoneiras e 1 alugada
 * o mês inteiro está com 33% de ocupação, não 100%. É esse número que diz se
 * vale comprar a quarta.
 */

const { normalizarInstante, arredondar } = require('./tarifa');
const { gerarNumeroOS } = require('./vistoria');

const TIPOS_PLANO = ['horimetro', 'km', 'dias'];

/** Última leitura conhecida do medidor (por série, quando houver). */
function leituraAtual(db, produtoId, serialNumberId = null) {
  let sql = `SELECT valor, data FROM locacao_medidor_leituras
             WHERE produtoId = ?`;
  const params = [produtoId];
  if (serialNumberId) { sql += ' AND serialNumberId = ?'; params.push(serialNumberId); }
  sql += ' ORDER BY valor DESC, id DESC LIMIT 1';
  const r = db.prepare(sql).get(...params);
  return r ? Number(r.valor) : null;
}

/**
 * Situação de um plano: quanto falta para vencer.
 *
 * Plano por `dias` usa a data da última execução; os demais, a leitura do
 * medidor. `vencido` é o que interessa ao painel.
 */
function situacaoPlano(db, plano, hoje) {
  const ref = (normalizarInstante(hoje) || normalizarInstante(new Date()));

  if (plano.tipo === 'dias') {
    const base = plano.ultimaData || plano.dataCriacao;
    const dias = base
      ? Math.floor((new Date(ref.replace(' ', 'T')) - new Date(String(base).replace(' ', 'T'))) / 86400000)
      : 0;
    return {
      planoId: plano.id, tipo: 'dias',
      atual: dias, intervalo: plano.intervalo,
      restante: arredondar(plano.intervalo - dias),
      vencido: dias >= plano.intervalo,
      percentual: plano.intervalo > 0 ? arredondar((dias / plano.intervalo) * 100) : 0,
    };
  }

  const atual = leituraAtual(db, plano.produtoId, plano.serialNumberId);
  if (atual == null) {
    return {
      planoId: plano.id, tipo: plano.tipo, atual: null, intervalo: plano.intervalo,
      restante: null, vencido: false, percentual: 0, motivo: 'sem leitura de medidor',
    };
  }
  const desdeUltima = atual - Number(plano.ultimoValor || 0);
  return {
    planoId: plano.id, tipo: plano.tipo,
    atual, desdeUltima: arredondar(desdeUltima), intervalo: plano.intervalo,
    restante: arredondar(plano.intervalo - desdeUltima),
    vencido: desdeUltima >= plano.intervalo,
    percentual: plano.intervalo > 0 ? arredondar((desdeUltima / plano.intervalo) * 100) : 0,
  };
}

/** Planos ativos com sua situação, vencidos primeiro. */
function planosComSituacao(db, hoje, opts = {}) {
  let sql = `
    SELECT p.*, pr.descricao AS produto, pr.sku, sn.numero AS serie
    FROM locacao_manutencao_planos p
    JOIN produtos pr ON pr.id = p.produtoId
    LEFT JOIN serial_numbers sn ON sn.id = p.serialNumberId
    WHERE p.ativo = 1`;
  const params = [];
  if (opts.produtoId) { sql += ' AND p.produtoId = ?'; params.push(Number(opts.produtoId)); }
  sql += ' ORDER BY pr.descricao';

  const planos = db.prepare(sql).all(...params).map(p => ({ ...p, situacao: situacaoPlano(db, p, hoje) }));
  planos.sort((a, b) => {
    if (a.situacao.vencido !== b.situacao.vencido) return a.situacao.vencido ? -1 : 1;
    return (b.situacao.percentual || 0) - (a.situacao.percentual || 0);
  });
  return planos;
}

/**
 * Executa a manutenção: abre a OS e bloqueia o ativo no período.
 *
 * O bloqueio é o que faz a máquina sumir da disponibilidade — sem ele, o
 * balcão alugaria um ativo que está na oficina.
 */
function executarManutencao(db, planoId, dados = {}) {
  const plano = db.prepare('SELECT * FROM locacao_manutencao_planos WHERE id = ?').get(planoId);
  if (!plano) throw new Error('plano de manutenção não encontrado');

  const inicio = normalizarInstante(dados.inicio) || normalizarInstante(new Date());
  const fim = normalizarInstante(dados.fim);
  if (!fim) {
    const e = new Error('informe o fim previsto da manutenção (é ele que bloqueia a agenda)');
    e.status = 400;
    throw e;
  }
  if (!(inicio < fim)) {
    const e = new Error('fim da manutenção deve ser depois do início');
    e.status = 400;
    throw e;
  }

  // `os_ordens.clienteId` é NOT NULL e não há, no core, um registro canônico da
  // própria empresa para servir de contraparte em OS interna. Em vez de
  // inventar um vínculo (ou estourar a FK na cara do usuário), a exigência é
  // explícita: manutenção interna aponta a pessoa que representa a empresa.
  const clienteId = Number(dados.clienteId);
  if (!clienteId || !db.prepare('SELECT id FROM pessoas WHERE id = ?').get(clienteId)) {
    const e = new Error(
      'informe clienteId — a OS de manutenção precisa de uma contraparte; '
      + 'para manutenção interna, use a pessoa que representa a própria empresa'
    );
    e.status = 400;
    throw e;
  }

  let osId = null;
  let bloqueioId = null;

  const executar = db.transaction(() => {
    const produto = db.prepare('SELECT descricao FROM produtos WHERE id = ?').get(plano.produtoId);
    const ano = inicio.slice(0, 4);
    const numero = gerarNumeroOS(db, ano);
    const info = db.prepare(`
      INSERT INTO os_ordens (numero, clienteId, titulo, status, observacoes, usuarioCriacao)
      VALUES (?, ?, ?, 'aberta', ?, ?)
    `).run(numero, clienteId,
           `Manutenção preventiva — ${produto ? produto.descricao : 'ativo'} (${plano.descricao})`,
           `Aberta pelo módulo de Locação (plano #${plano.id}, a cada ${plano.intervalo} ${plano.tipo}).`,
           dados.usuario || null);
    osId = info.lastInsertRowid;

    const b = db.prepare(`
      INSERT INTO locacao_bloqueios
        (produtoId, serialNumberId, quantidade, dataInicio, dataFim, motivo, osId, usuario)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?)
    `).run(plano.produtoId, plano.serialNumberId, inicio, fim,
           `Manutenção preventiva: ${plano.descricao}`, osId, dados.usuario || null);
    bloqueioId = b.lastInsertRowid;

    // Zera o contador do plano: a próxima manutenção conta a partir daqui.
    const atual = plano.tipo === 'dias' ? 0 : (leituraAtual(db, plano.produtoId, plano.serialNumberId) || 0);
    db.prepare('UPDATE locacao_manutencao_planos SET ultimoValor = ?, ultimaData = ? WHERE id = ?')
      .run(atual, inicio, planoId);
  });
  executar();

  return {
    os: db.prepare('SELECT id, numero, status FROM os_ordens WHERE id = ?').get(osId),
    bloqueio: db.prepare('SELECT * FROM locacao_bloqueios WHERE id = ?').get(bloqueioId),
  };
}

// ─── Indicadores ───────────────────────────────────────────────────────────

/**
 * Ocupação por ativo no período.
 *
 * Conta dias-unidade ocupados por reservas que cruzam a janela, recortando o
 * que fica fora dela — uma locação de 40 dias que só entra 5 no período
 * conta 5, não 40.
 */
function ocupacao(db, de, ate, opts = {}) {
  const ini = normalizarInstante(de);
  const fim = normalizarInstante(ate);
  if (!ini || !fim || !(ini < fim)) return { ok: false, erro: 'período inválido', linhas: [] };

  const msIni = new Date(ini.replace(' ', 'T')).getTime();
  const msFim = new Date(fim.replace(' ', 'T')).getTime();
  const diasPeriodo = Math.max(1, (msFim - msIni) / 86400000);

  let sql = `
    SELECT s.produtoId, p.descricao, p.sku, p.categoria
    FROM locacao_item_specs s
    JOIN produtos p ON p.id = s.produtoId
    WHERE s.alugavel = 1`;
  const params = [];
  if (opts.produtoId) { sql += ' AND s.produtoId = ?'; params.push(Number(opts.produtoId)); }
  if (opts.categoria) { sql += ' AND p.categoria = ?'; params.push(opts.categoria); }
  const produtos = db.prepare(sql).all(...params);

  const { calcularSaldo } = require('../estoque-routes');

  const linhas = produtos.map(p => {
    const reservas = db.prepare(`
      SELECT quantidade, dataInicio, dataFim FROM locacao_reservas
      WHERE produtoId = ? AND status IN ('ativa','consumida','devolvida')
        AND dataInicio < ? AND ? < dataFim
    `).all(p.produtoId, fim, ini);

    let diasUnidade = 0;
    for (const r of reservas) {
      const a = Math.max(msIni, new Date(String(r.dataInicio).replace(' ', 'T')).getTime());
      const b = Math.min(msFim, new Date(String(r.dataFim).replace(' ', 'T')).getTime());
      if (b > a) diasUnidade += ((b - a) / 86400000) * (Number(r.quantidade) || 1);
    }

    const saldo = calcularSaldo(db, p.produtoId);
    const capacidade = diasPeriodo * (saldo > 0 ? saldo : 0);

    // Receita do período, RATEADA pelo peso do ativo no contrato.
    //
    // Antes isto era um JOIN com locacao_itens, e dava dois erros somados:
    // uma linha por item multiplicava o faturamento (contrato com 2 itens do
    // mesmo produto dobrava a receita), e o valor atribuído era o
    // `valorLocacao` INTEIRO do contrato — então num contrato com produtos A
    // e B cada um levava o total, e a soma do painel dava o dobro do que foi
    // realmente faturado. "Receita por ativo" e "ROI" ficavam inutilizáveis.
    //
    // Agora: para cada faturamento que cruza a janela, o ativo leva a fração
    // (valor dos itens dele ÷ valor de todos os itens de locação do contrato).
    const receita = db.prepare(`
      SELECT COALESCE(SUM(
        (f.valorLocacao + f.valorExtras) * (
          COALESCE((SELECT SUM(i.valorTotal) FROM locacao_itens i
                    WHERE i.contratoId = c.id AND i.produtoId = ?
                      AND i.natureza = 'locacao'), 0)
          / NULLIF((SELECT SUM(i2.valorTotal) FROM locacao_itens i2
                    WHERE i2.contratoId = c.id AND i2.natureza = 'locacao'), 0)
        )
      ), 0) AS v
      FROM locacao_faturamentos f
      JOIN locacao_contratos c ON c.id = f.contratoId
      WHERE f.status <> 'cancelado'
        AND EXISTS (SELECT 1 FROM locacao_itens i3
                    WHERE i3.contratoId = c.id AND i3.produtoId = ?)
        AND COALESCE(f.dataInicio, c.dataSaidaPrevista) < ?
        AND ? < COALESCE(f.dataFim, c.dataRetornoPrevisto, f.dataInicio)
    `).get(p.produtoId, p.produtoId, fim, ini).v;

    // Custo de manutenção do período: OS abertas pelos bloqueios deste ativo.
    // Estava prometido na F6 do plano e não existia.
    const custoManutencao = db.prepare(`
      SELECT COALESCE(SUM(o.valorTotal), 0) AS v
      FROM locacao_bloqueios b
      JOIN os_ordens o ON o.id = b.osId
      WHERE b.produtoId = ? AND b.osId IS NOT NULL
        AND b.dataInicio < ? AND ? < b.dataFim
    `).get(p.produtoId, fim, ini).v;

    return {
      produtoId: p.produtoId,
      descricao: p.descricao,
      sku: p.sku,
      categoria: p.categoria,
      unidades: saldo,
      diasPeriodo: arredondar(diasPeriodo),
      diasOcupados: arredondar(diasUnidade),
      capacidadeDiasUnidade: arredondar(capacidade),
      taxaOcupacao: capacidade > 0 ? arredondar((diasUnidade / capacidade) * 100) : 0,
      // Taxa acima de 100% é real e significa overbooking (mais unidades
      // alugadas do que existem em estoque) — não é erro de cálculo, e por
      // isso o número não é truncado; fica sinalizado.
      sobrecarga: capacidade > 0 && diasUnidade > capacidade,
      // Ocupação com estoque zerado não é 0% de ociosidade: é ausência de
      // base de cálculo. Sem esta marca, um ativo sem saldo aparecia no
      // painel como "ocioso", ao lado de quem realmente não alugou.
      semEstoque: !(saldo > 0),
      receita: arredondar(receita),
      receitaPorDiaUnidade: capacidade > 0 ? arredondar(receita / capacidade) : 0,
      custoManutencao: arredondar(custoManutencao),
      resultado: arredondar(receita - custoManutencao),
    };
  });

  linhas.sort((a, b) => b.taxaOcupacao - a.taxaOcupacao);

  const totalDias = linhas.reduce((s, l) => s + l.diasOcupados, 0);
  const totalCap = linhas.reduce((s, l) => s + l.capacidadeDiasUnidade, 0);

  return {
    ok: true, de: ini, ate: fim, linhas,
    resumo: {
      ativos: linhas.length,
      taxaMedia: totalCap > 0 ? arredondar((totalDias / totalCap) * 100) : 0,
      receitaTotal: arredondar(linhas.reduce((s, l) => s + l.receita, 0)),
      custoManutencaoTotal: arredondar(linhas.reduce((s, l) => s + l.custoManutencao, 0)),
      // Ocioso é quem tinha estoque e não alugou. Quem está sem estoque é
      // contado à parte — não é o mesmo problema de negócio.
      ociosos: linhas.filter(l => l.taxaOcupacao === 0 && !l.semEstoque).length,
      semEstoque: linhas.filter(l => l.semEstoque).length,
    },
  };
}

/** Ranking simples: quem deu mais e menos receita no período. */
function ranking(db, de, ate, opts = {}) {
  const base = ocupacao(db, de, ate, opts);
  if (!base.ok) return base;
  const porReceita = [...base.linhas].sort((a, b) => b.receita - a.receita);
  return {
    ok: true,
    melhores: porReceita.slice(0, 10),
    piores: porReceita.filter(l => l.receita === 0).slice(0, 10),
    resumo: base.resumo,
  };
}

module.exports = {
  TIPOS_PLANO,
  leituraAtual,
  situacaoPlano,
  planosComSituacao,
  executarManutencao,
  ocupacao,
  ranking,
};
