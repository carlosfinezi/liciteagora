#!/usr/bin/env node
/**
 * test-producao-f1.js — Fase 1: peça, ficha, forma, OP, apontamento,
 * controle tecnológico e produtividade.
 *
 * Roda contra banco DESCARTÁVEL em /tmp (ver scripts/producao-teste-util.js).
 * Não toca em data/, não precisa de limpeza, não deixa resíduo.
 *
 * Uso: node scripts/test-producao-f1.js
 */

const u = require('./producao-teste-util');
const ficha = require(u.BASE + '/producao/ficha');
const util = require(u.BASE + '/producao/prod-util');
const produtividade = require(u.BASE + '/producao/produtividade');

let ok = 0, fail = 0;
const falhas = [];
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else {
    fail++; falhas.push(msg);
    console.error(`  ✗ ${msg}${extra !== undefined ? '\n      ' + JSON.stringify(extra) : ''}`);
  }
}
function secao(t) { console.log(`\n── ${t}`); }

(async () => {
  const { db, servidor, porta, caminho } = await u.montar();
  const ids = u.seed(db);

  const req = async (metodo, rota, corpo) => {
    const r = await fetch(`http://127.0.0.1:${porta}${rota}`, {
      method: metodo,
      headers: { 'content-type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };

  // ═══ Flag de módulo ════════════════════════════════════════════════════════
  secao('Feature flag');
  {
    const s = await req('GET', '/api/producao/status');
    assert(s.status === 200 && s.body.enabled === false,
      'flag nasce DESLIGADA (nenhum tenant recebe o módulo por acidente)', s.body);

    const bloqueado = await req('GET', '/api/producao/ordens');
    assert(bloqueado.status === 403 && bloqueado.body.error === 'producao_disabled',
      'com a flag off, /api/producao/* devolve 403 producao_disabled', bloqueado.body);

    u.ligarFlag(db);
    const liberado = await req('GET', '/api/producao/ordens');
    assert(liberado.status === 200, 'com a flag on, o módulo responde', liberado.body);
  }


  // ═══ Perfis de indústria ═══════════════════════════════════════════════════
  secao('Perfil de indústria: o núcleo é genérico, o vocabulário é semente');
  {
    const v = await req('GET', '/api/producao/vocabulario');
    assert(v.status === 200 && v.body.vocabulario.perfil === 'generico',
      'tenant novo nasce no perfil genérico', v.body.vocabulario && v.body.vocabulario.perfil);
    assert(v.body.vocabulario.recurso === 'Recurso',
      'e o vocabulário genérico não fala de concreto', v.body.vocabulario.recurso);

    const et = await req('GET', '/api/producao/etapas');
    const contamAntes = et.body.etapas.filter(e => e.ativo && e.contaProducao);
    assert(contamAntes.length === 1 && contamAntes[0].codigo === 'inspecao',
      'exatamente UMA etapa conta produção no genérico', contamAntes.map(e => e.codigo));

    const ap = await req('POST', '/api/producao/perfis/premoldados');
    assert(ap.status === 200 && ap.body.perfil === 'premoldados', 'perfil trocado', ap.body);
    assert(ap.body.vocabulario.recurso === 'Forma / Pista' && ap.body.vocabulario.lote === 'Betonada',
      'o vocabulário passa a falar a língua da fábrica', ap.body.vocabulario);

    const ativas = ap.body.etapas.filter(e => e.ativo);
    assert(ativas.some(e => e.codigo === 'concretagem') && ativas.some(e => e.codigo === 'desforma'),
      'as etapas do perfil entram', ativas.map(e => e.codigo));

    // O bug que a troca de perfil expôs: sem desativar as do perfil anterior,
    // ficavam DUAS etapas contando produção e a unidade era contada 2x.
    const contam = ativas.filter(e => e.contaProducao);
    assert(contam.length === 1 && contam[0].codigo === 'desforma',
      'e continua UMA só contando produção — sem contagem dupla', contam.map(e => e.codigo));
    assert(ap.body.etapas.some(e => !e.ativo && e.codigo === 'inspecao'),
      'a etapa do perfil anterior, sem apontamento, é desativada');

    const volta = await req('POST', '/api/producao/perfis/generico');
    const contamVolta = volta.body.etapas.filter(e => e.ativo && e.contaProducao);
    assert(contamVolta.length === 1 && contamVolta[0].codigo === 'inspecao',
      'voltar ao genérico devolve a contagem para a etapa dele', contamVolta.map(e => e.codigo));

    const ruim = await req('POST', '/api/producao/perfis/inexistente');
    assert(ruim.status === 400, 'perfil desconhecido é recusado');

    const unica = volta.body.etapas.find(e => e.ativo && e.contaProducao);
    const tentativa = await req('PUT', '/api/producao/etapas/' + unica.id,
      { nome: unica.nome, contaProducao: 0 });
    assert(tentativa.status === 400 && /única etapa/.test(tentativa.body.error),
      'desmarcar a única etapa que conta produção é recusado', tentativa.body);
  }

  // ═══ prod-util ══════════════════════════════════════════════════════════════
  secao('Normalização de data e hora');
  {
    assert(util.normalizarInstante('2026-08-27') === '2026-08-27 00:00:00',
      'data pura vira meia-noite');
    assert(util.normalizarInstante('2026-08-27T14:30') === '2026-08-27 14:30:00',
      'datetime-local do navegador entra com segundos');
    assert(util.normalizarInstante('2026-08-27 14:30:59') === '2026-08-27 14:30:59',
      'formato do CURRENT_TIMESTAMP passa intacto');
    assert(util.normalizarInstante('27/08/2026') === null,
      'data brasileira é recusada (o formato TEM de ser uniforme: a comparação é lexicográfica)');
    assert(util.somarHoras('2026-08-27 20:00:00', 24) === '2026-08-28 20:00:00',
      'somar 24h atravessa o dia');
    // 2026-10-18 é a virada do horário de verão em alguns anos; aqui o que
    // importa é a aritmética não estourar no fim do mês.
    assert(util.somarHoras('2026-08-31 23:00:00', 2) === '2026-09-01 01:00:00',
      'somar horas atravessa a virada do mês');
    assert(Math.abs(util.horasEntre('2026-08-27 07:00:00', '2026-08-27 17:30:00') - 10.5) < 1e-9,
      'horasEntre devolve fração de hora');
    assert(util.horasEntre('2026-08-27 17:00:00', '2026-08-27 07:00:00') === -10,
      'horasEntre negativa quando o fim vem antes');
    assert(util.num('abc') === null && util.num(-1, { min: 0 }) === null && util.num('5') === 5,
      'num() recusa NaN e fora de faixa em vez de virar 0');
  }

  // ═══ A regra central: exigeIdentificacao é derivado ════════════════════════
  secao('exigeIdentificacao é derivado, não configurável');
  {
    assert(ficha.derivarExigeIdentificacao({ modo: 'estoque' }) === 0,
      'catálogo em forma fixa NÃO exige identificação individual (bloco vai por quantidade)');
    assert(ficha.derivarExigeIdentificacao({ modo: 'projeto' }) === 1,
      'peça de obra exige identificação');
    assert(ficha.derivarExigeIdentificacao({ modo: 'estoque', exigeEnsaioLiberacao: 1 }) === 1,
      'peça protendida exige identificação mesmo sendo de catálogo');

    // O ponto do teste: a API não deve deixar a tela desligar isso.
    const r = await req('PUT', `/api/producao/pecas/${ids.pilar}`, {
      modo: 'projeto', quantidadeBase: 0.9, pesoKg: 2250,
      tempoProcessoHoras: 20, unidadesPorCiclo: 1, ensaioLimiteConformidade: 35,
      exigeIdentificacao: 0,   // <- tentativa de burlar
    });
    assert(r.status === 200 && r.body.ficha.exigeIdentificacao === 1,
      'a API IGNORA exigeIdentificacao=0 vindo do corpo e mantém o valor derivado', r.body.peca);
  }

  // ═══ Validação do tipo de peça ═════════════════════════════════════════════
  secao('Validação do tipo de peça');
  {
    const semFck = await req('PUT', `/api/producao/pecas/${ids.viga}`, {
      modo: 'projeto', exigeEnsaioLiberacao: 1, quantidadeBase: 1.2, pesoKg: 3000,
      tempoProcessoHoras: 18, unidadesPorCiclo: 1, ensaioLimiteConformidade: 40,
    });
    assert(semFck.status === 400 && /ensaioLimiteLiberacao/.test(semFck.body.error),
      'protensão sem fck de transferência é recusada (é ele que libera o corte da cordoalha)',
      semFck.body);

    const invertido = await req('PUT', `/api/producao/pecas/${ids.viga}`, {
      modo: 'projeto', exigeEnsaioLiberacao: 1, quantidadeBase: 1.2, pesoKg: 3000,
      tempoProcessoHoras: 18, unidadesPorCiclo: 1, ensaioLimiteConformidade: 20, ensaioLimiteLiberacao: 30,
    });
    assert(invertido.status === 400 && /não pode ser maior/.test(invertido.body.error),
      'fck de transferência maior que o de projeto é recusado', invertido.body);

    const bom = await req('PUT', `/api/producao/pecas/${ids.viga}`, {
      modo: 'projeto', exigeEnsaioLiberacao: 1, quantidadeBase: 1.2, pesoKg: 3000,
      comprimentoM: 12, tempoProcessoHoras: 18, unidadesPorCiclo: 1,
      ensaioLimiteConformidade: 40, ensaioLimiteLiberacao: 24,
    });
    assert(bom.status === 200 && bom.body.ficha.exigeIdentificacao === 1,
      'viga protendida cadastrada, com identificação individual imposta');

    const bloco = await req('PUT', `/api/producao/pecas/${ids.bloco}`, {
      modo: 'estoque', quantidadeBase: 0.01, pesoKg: 12,
      tempoProcessoHoras: 24, unidadesPorCiclo: 40, ensaioLimiteConformidade: 25,
    });
    assert(bloco.status === 200 && bloco.body.ficha.exigeIdentificacao === 0,
      'bloco de catálogo cadastrado, sem identificação individual');

    const zero = await req('PUT', `/api/producao/pecas/${ids.bloco}`, {
      modo: 'estoque', quantidadeBase: 0.01, pesoKg: 12,
      tempoProcessoHoras: 24, unidadesPorCiclo: 0,
    });
    assert(zero.status === 400, 'unidadesPorCiclo = 0 é recusado (viraria divisão por zero no indicador)');
  }

  // ═══ Ficha técnica ═════════════════════════════════════════════════════════
  secao('Ficha técnica: perda, ciclo e custo');
  {
    assert(Math.abs(ficha.consumoComPerda(100, 5) - 105) < 1e-9,
      'perda é ADITIVA: 100 kg com 5% consomem 105 kg (no restaurante seria divisor)');
    assert(ficha.consumoComPerda(100, 0) === 100, 'sem perda, consumo é a quantidade de projeto');

    // Ficha do bloco: cimento, areia, brita.
    const add = (pecaId, insumo, qtd, unidade, perda, grupo) =>
      req('POST', `/api/producao/pecas/${pecaId}/ficha`,
        { insumoProdutoId: insumo, quantidade: qtd, unidade, perdaPercentual: perda, grupo });

    const c1 = await add(ids.bloco, ids.cimento, 1.5, 'KG', 4, 'concreto');
    assert(c1.status === 201, 'insumo cimento adicionado à ficha do bloco', c1.body);
    await add(ids.bloco, ids.areia, 0.004, 'M3', 3, 'concreto');
    await add(ids.bloco, ids.brita, 0.005, 'M3', 3, 'concreto');

    // 1,5 kg + 4% = 1,56 kg × R$0,60 = 0,936
    // 0,004 m³ + 3% = 0,00412 × 90     = 0,3708
    // 0,005 m³ + 3% = 0,00515 × 110    = 0,5665
    const esperado = 1.5 * 1.04 * 0.60 + 0.004 * 1.03 * 90 + 0.005 * 1.03 * 110;
    const f = await req('GET', `/api/producao/pecas/${ids.bloco}/ficha`);
    assert(Math.abs(f.body.custoUnitario - esperado) < 1e-6,
      `custo do bloco confere com a conta à mão (R$ ${esperado.toFixed(4)})`,
      { obtido: f.body.custoUnitario, esperado });
    assert(f.body.avisos.length === 0, 'sem avisos: todos os insumos têm custo');

    // O custo vem do CUSTO MÉDIO (movimentação), não do precoCusto do cadastro.
    const linhaCimento = f.body.itens.find(i => i.insumoProdutoId === ids.cimento);
    assert(Math.abs(linhaCimento.custoUnitario - 0.60) < 1e-9,
      'custo unitário do insumo vem do custo médio das entradas de estoque');

    // Insumo sem custo tem de AVISAR, não silenciar.
    await add(ids.bloco, ids.semCusto, 0.01, 'L', 0, 'consumivel');
    const f2 = await req('GET', `/api/producao/pecas/${ids.bloco}/ficha`);
    assert(f2.body.avisos.some(a => /sem custo/.test(a)),
      'insumo sem custo gera aviso (senão a margem parece melhor do que é)', f2.body.avisos);

    // Ciclo direto.
    const ciclo = await add(ids.bloco, ids.bloco, 1, 'UN', 0, 'outro');
    assert(ciclo.status === 400 && /si mesma/.test(ciclo.body.error),
      'a peça não pode ser insumo de si mesma', ciclo.body);

    // Ciclo indireto: armação contém viga; tentar pôr armação na viga fecha o laço.
    await req('PUT', `/api/producao/pecas/${ids.armacao}`, {
      modo: 'estoque', quantidadeBase: 0, pesoKg: 180,
      tempoProcessoHoras: 0, unidadesPorCiclo: 1,
    });
    await add(ids.armacao, ids.viga, 1, 'UN', 0, 'outro');       // armação contém viga
    const cicloIndireto = await add(ids.viga, ids.armacao, 1, 'UN', 0, 'aco');
    assert(cicloIndireto.status === 400 && /ciclo/.test(cicloIndireto.body.error),
      'ciclo INDIRETO (viga → armação → viga) é detectado', cicloIndireto.body);

    // Desfaz o laço e monta a sub-ficha de verdade.
    const itensArmacao = await req('GET', `/api/producao/pecas/${ids.armacao}/ficha`);
    for (const it of itensArmacao.body.itens) {
      await req('DELETE', `/api/producao/ficha/${it.id}`);
    }
    await add(ids.armacao, ids.aco, 24, 'KG', 8, 'aco');    // 24 kg + 8% = 25,92 × 7,50 = 194,40
    await add(ids.viga, ids.armacao, 1, 'UN', 0, 'aco');
    await add(ids.viga, ids.cimento, 420, 'KG', 3, 'concreto');

    const fv = await req('GET', `/api/producao/pecas/${ids.viga}/ficha`);
    const linhaArmacao = fv.body.itens.find(i => i.insumoProdutoId === ids.armacao);
    assert(linhaArmacao && linhaArmacao.subFicha === true,
      'insumo com ficha própria é marcado como sub-ficha');
    assert(Math.abs(linhaArmacao.custoUnitario - 24 * 1.08 * 7.50) < 1e-6,
      'o custo da sub-ficha desce recursivamente (armação = aço + perda)',
      { obtido: linhaArmacao.custoUnitario, esperado: 24 * 1.08 * 7.50 });

    const perdaAlta = await add(ids.bloco, ids.aditivo, 1, 'L', 150, 'concreto');
    assert(perdaAlta.status === 400, 'perda acima de 100% é recusada');
  }

  // ═══ Formas ════════════════════════════════════════════════════════════════
  secao('Formas e pistas');
  let formaBloco, pistaViga;
  {
    const f1 = await req('POST', '/api/producao/formas',
      { codigo: 'FOR-01', descricao: 'Forma de bloco', tipo: 'forma', capacidadePecas: 40 });
    assert(f1.status === 201, 'forma criada', f1.body);
    formaBloco = f1.body.forma.id;

    const f2 = await req('POST', '/api/producao/formas',
      { codigo: 'PIS-01', descricao: 'Pista de protensão 60m', tipo: 'pista', comprimentoUtilM: 60, capacidadePecas: 4 });
    pistaViga = f2.body.forma.id;
    assert(f2.status === 201 && f2.body.forma.tipo === 'pista', 'pista criada');

    const dup = await req('POST', '/api/producao/formas',
      { codigo: 'FOR-01', descricao: 'Duplicada' });
    assert(dup.status === 400, 'código de forma duplicado é recusado', dup.body);
  }

  // ═══ Ordem de produção: ciclo do catálogo ══════════════════════════════════
  secao('OP de catálogo: ciclo completo e estoque');
  let opBloco;
  {
    const semFicha = await req('POST', '/api/producao/ordens',
      { produtoId: ids.aditivo, quantidadePlanejada: 1 });
    assert(semFicha.status === 400 && /tipo de peça/.test(semFicha.body.error),
      'produto que não é tipo de peça não abre OP', semFicha.body);

    const c = await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 40, formaId: formaBloco,
      dataPlanejada: '2026-08-20 07:00',
    });
    assert(c.status === 201 && c.body.op.status === 'planejada', 'OP criada em planejada', c.body);
    assert(/^OP-\d{6}$/.test(c.body.op.numero), 'número sequencial com prefixo', c.body.op.numero);
    opBloco = c.body.op.id;

    // Desforma prevista = planejada + tempo de cura (24h)
    assert(c.body.op.dataFimPrevisto === '2026-08-21 07:00:00',
      'desforma prevista sai do tempo de cura do tipo de peça', c.body.op.dataFimPrevisto);

    const saldoCimentoAntes = u.saldo(db, ids.cimento);

    const lib = await req('POST', `/api/producao/ordens/${opBloco}/liberar`);
    assert(lib.status === 200 && lib.body.op.status === 'liberada', 'OP liberada', lib.body);
    assert(lib.body.op.insumos.length === 4, 'ficha congelada em prod_ordem_insumos (4 insumos)',
      lib.body.op.insumos.length);
    assert(Math.abs(lib.body.op.custoTeorico - lib.body.op.insumos.reduce((s, i) => s + i.custoTotal, 0)) < 1e-6,
      'custo teórico da OP = soma dos insumos congelados');
    assert(lib.body.avisos.some(a => /sem custo/.test(a)),
      'aviso de insumo sem custo é repassado na liberação', lib.body.avisos);
    assert(u.saldo(db, ids.cimento) === saldoCimentoAntes,
      'liberar NÃO baixa estoque (a baixa é na concretagem)');

    // A ficha muda depois da liberação: a OP não pode mudar junto.
    const fichaAtual = await req('GET', `/api/producao/pecas/${ids.bloco}/ficha`);
    const itemCimento = fichaAtual.body.itens.find(i => i.insumoProdutoId === ids.cimento);
    await req('PUT', `/api/producao/ficha/${itemCimento.id}`,
      { insumoProdutoId: ids.cimento, quantidade: 99, unidade: 'KG', perdaPercentual: 4, grupo: 'concreto' });
    const opDepois = await req('GET', `/api/producao/ordens/${opBloco}`);
    const insumoCongelado = opDepois.body.op.insumos.find(i => i.insumoProdutoId === ids.cimento);
    assert(Math.abs(insumoCongelado.quantidadePrevista - 1.5 * 1.04 * 40) < 1e-6,
      'mudar a ficha DEPOIS da liberação não altera a OP em andamento',
      insumoCongelado.quantidadePrevista);
    // Devolve a ficha ao valor original para não contaminar os testes seguintes.
    await req('PUT', `/api/producao/ficha/${itemCimento.id}`,
      { insumoProdutoId: ids.cimento, quantidade: 1.5, unidade: 'KG', perdaPercentual: 4, grupo: 'concreto' });

    const conc = await req('POST', `/api/producao/ordens/${opBloco}/iniciar-processo`,
      { dataInicioProcesso: '2026-08-20 08:00' });
    assert(conc.status === 200 && conc.body.op.status === 'em_processo', 'OP em_processo', conc.body);

    const consumidoCimento = 1.5 * 1.04 * 40;
    assert(Math.abs(u.saldo(db, ids.cimento) - (saldoCimentoAntes - consumidoCimento)) < 1e-6,
      'concretar baixa o insumo do estoque core', {
        antes: saldoCimentoAntes, depois: u.saldo(db, ids.cimento), esperado: consumidoCimento,
      });

    const movs = db.prepare(
      "SELECT * FROM movimentacoes_estoque WHERE origem = 'prod_ordem' AND origemId = ?"
    ).all(opBloco);
    assert(movs.length === 4, 'uma movimentação por insumo, com origem prod_ordem', movs.length);
    assert(movs.every(m => m.saldoPosterior != null),
      'a movimentação grava saldoPosterior (o contexto do estoque-routes foi usado)');

    // Forma fixa não tem trava de ensaio.
    const ld = await req('POST', `/api/producao/ordens/${opBloco}/liberar-saida`, {});
    assert(ld.status === 200 && ld.body.op.status === 'liberada_saida',
      'forma fixa libera desforma sem ensaio', ld.body);

    const saldoBlocoAntes = u.saldo(db, ids.bloco);
    const semMotivo = await req('POST', `/api/producao/ordens/${opBloco}/concluir`,
      { quantidadeProduzida: 38, quantidadeRefugo: 2 });
    assert(semMotivo.status === 400 && /motivo/.test(semMotivo.body.error),
      'refugo sem motivo é recusado na conclusão', semMotivo.body);

    const fim = await req('POST', `/api/producao/ordens/${opBloco}/concluir`,
      { quantidadeProduzida: 38, quantidadeRefugo: 2, motivoRefugo: 'quebra na desforma' });
    assert(fim.status === 200 && fim.body.op.status === 'concluida', 'OP concluída', fim.body);
    assert(u.saldo(db, ids.bloco) === saldoBlocoAntes + 38,
      'conclusão dá entrada das peças BOAS no estoque', u.saldo(db, ids.bloco));
    assert(fim.body.op.pecasProduzidas.length === 0,
      'peça de catálogo NÃO gera linhas identificadas (400 blocos não têm 400 números)');

    // O refugo encarece a peça boa: custo ÷ 38, não ÷ 40.
    const custo = await req('GET', `/api/producao/ordens/${opBloco}/custo`);
    assert(Math.abs(custo.body.custoUnitario - custo.body.custoRealizado / 38) < 1e-9,
      'custo unitário divide pelas peças BOAS: o refugo encarece o que sobrou',
      custo.body);
    assert(custo.body.avisoCustoHora !== null,
      'com producao_custo_hora_padrao em 0, o custo avisa que a mão de obra ficou de fora');
  }

  // ═══ A trava da protensão ══════════════════════════════════════════════════
  secao('Protensão: a trava do ensaio de transferência');
  let opViga, loteId;
  {
    // Peça de obra exige projetoId — testado aqui porque a viga é modo=obra.
    const semObra = await req('POST', '/api/producao/ordens',
      { produtoId: ids.viga, quantidadePlanejada: 2, formaId: pistaViga });
    assert(semObra.status === 400 && /projetoId/.test(semObra.body.error),
      'peça de modo "obra" não abre OP sem obra', semObra.body);

    const obra = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Galpão Industrial Teste' });
    const projetoId = obra.body.obra.id;
    await req('POST', `/api/producao/obras/${projetoId}/status`, { status: 'contratada' });

    const c = await req('POST', '/api/producao/ordens', {
      produtoId: ids.viga, quantidadePlanejada: 2, formaId: pistaViga, projetoId,
      dataPlanejada: '2026-08-22 06:00',
    });
    assert(c.status === 201, 'OP de viga protendida criada', c.body);
    opViga = c.body.op.id;
    await req('POST', `/api/producao/ordens/${opViga}/liberar`);

    // Sem lote de concreto a protensão nem começa.
    const semLote = await req('POST', `/api/producao/ordens/${opViga}/iniciar-processo`,
      { dataInicioProcesso: '2026-08-22 07:00' });
    assert(semLote.status === 400 && /loteId/.test(semLote.body.error),
      'peça protendida não concreta sem lote (é o lote que carrega o ensaio)', semLote.body);

    const lote = await req('POST', '/api/producao/lotes',
      { data: '2026-08-22', traco: '1:1,8:2,3 a/c 0,42', volumeM3: 3.5, ensaioLimiteConformidade: 40, slumpMm: 90 });
    assert(lote.status === 201 && lote.body.lote.situacao === 'pendente',
      'lote de concreto nasce pendente', lote.body);
    loteId = lote.body.lote.id;

    const conc = await req('POST', `/api/producao/ordens/${opViga}/iniciar-processo`,
      { dataInicioProcesso: '2026-08-22 07:00', loteId: loteId });
    assert(conc.status === 200, 'concretagem com lote vinculado', conc.body);

    // A TRAVA.
    const semEnsaio = await req('POST', `/api/producao/ordens/${opViga}/liberar-saida`, {});
    assert(semEnsaio.status === 400 && semEnsaio.body.exigeEnsaio === true,
      'protensão SEM ensaio: liberação recusada', semEnsaio.body);
    assert(/sem ensaio de transferência/.test(semEnsaio.body.error),
      'a mensagem diz exatamente o que falta', semEnsaio.body.error);

    // Corpo de prova reprovado não libera.
    const cp1 = await req('POST', `/api/producao/lotes/${loteId}/corpos-prova`,
      { identificacao: 'CP-01', finalidade: 'transferencia', dataMoldagem: '2026-08-22' });
    assert(cp1.status === 201 && cp1.body.corpoProva.idadeDias === 1,
      'corpo de prova de transferência nasce com idade 1 dia', cp1.body);

    const rup1 = await req('POST', `/api/producao/corpos-prova/${cp1.body.corpoProva.id}/ruptura`,
      { resistenciaMpa: 18, dataRuptura: '2026-08-23' });
    assert(rup1.body.referenciaMpa === 24,
      'o fck de referência da transferência vem da PEÇA que consumiu o lote', rup1.body);
    assert(rup1.body.corpoProva.aprovado === 0,
      '18 MPa contra 24 exigidos: reprovado — e quem decide é o backend, não a tela');

    const aindaNao = await req('POST', `/api/producao/ordens/${opViga}/liberar-saida`, {});
    assert(aindaNao.status === 400 && /chegou a 18 MPa e esta peça exige 24 MPa/.test(aindaNao.body.error),
      'ensaio insuficiente NÃO libera, e a mensagem diz os dois números', aindaNao.body);

    // Bypass: precisa de config + forcar + justificativa. Nenhum sozinho basta.
    const forcaSemConfig = await req('POST', `/api/producao/ordens/${opViga}/liberar-saida`,
      { forcar: true, justificativa: 'urgência' });
    assert(forcaSemConfig.status === 400,
      'forcar sem a config producao_permitir_liberacao_sem_ensaio não passa', forcaSemConfig.body);

    u.setCfg(db, 'producao_permitir_liberacao_sem_ensaio', '1');
    const semJustificativa = await req('POST', `/api/producao/ordens/${opViga}/liberar-saida`,
      { forcar: true });
    assert(semJustificativa.status === 400 && /justificativa/.test(semJustificativa.body.error),
      'bypass sem justificativa é recusado', semJustificativa.body);
    u.setCfg(db, 'producao_permitir_liberacao_sem_ensaio', '0');

    // O caminho correto: novo ensaio, aprovado.
    const cp2 = await req('POST', `/api/producao/lotes/${loteId}/corpos-prova`,
      { identificacao: 'CP-02', finalidade: 'transferencia', dataMoldagem: '2026-08-22' });
    const rup2 = await req('POST', `/api/producao/corpos-prova/${cp2.body.corpoProva.id}/ruptura`,
      { resistenciaMpa: 26, dataRuptura: '2026-08-23' });
    assert(rup2.body.corpoProva.aprovado === 1, '26 MPa contra 24: aprovado');

    const liberou = await req('POST', `/api/producao/ordens/${opViga}/liberar-saida`, {});
    assert(liberou.status === 200 && liberou.body.op.status === 'liberada_saida',
      'com ensaio de transferência aprovado, a protensão é liberada', liberou.body);

    const ev = db.prepare(
      "SELECT * FROM prod_ordem_eventos WHERE opId = ? AND tipo = 'saida_liberada'"
    ).get(opViga);
    assert(ev && /26 MPa/.test(ev.descricao),
      'o evento registra a resistência e o corpo de prova que liberou', ev && ev.descricao);

    // Dupla ruptura no mesmo CP é recusada.
    const reRuptura = await req('POST', `/api/producao/corpos-prova/${cp2.body.corpoProva.id}/ruptura`,
      { resistenciaMpa: 30 });
    assert(reRuptura.status === 400, 'corpo de prova já rompido não aceita segunda ruptura');
  }

  // ═══ Regressões da auditoria ═══════════════════════════════════════════════
  secao('Regressão: reclassificar a peça não pode contornar a trava');
  {
    // Achado crítico: trocar `cura` para forma_fixa com a OP em_processo
    // liberava a desforma sem ensaio nenhum — e o evento da OP ainda diria
    // "cura em forma fixa, sem trava de ensaio".
    const c = await req('POST', '/api/producao/ordens', {
      produtoId: ids.viga, quantidadePlanejada: 1, projetoId: null,
      dataPlanejada: '2026-09-15 07:00',
    });
    // (viga é modo=obra: precisa de obra)
    const obra = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Obra da regressão' });
    await req('POST', `/api/producao/obras/${obra.body.obra.id}/status`, { status: 'contratada' });
    const c2 = await req('POST', '/api/producao/ordens', {
      produtoId: ids.viga, quantidadePlanejada: 1, projetoId: obra.body.obra.id,
      dataPlanejada: '2026-09-15 07:00',
    });
    const opId = c2.body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);

    const lote = await req('POST', '/api/producao/lotes',
      { data: '2026-09-15', volumeM3: 2, ensaioLimiteConformidade: 40 });
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`,
      { dataInicioProcesso: '2026-09-15 08:00', loteId: lote.body.lote.id });

    const travado = await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    assert(travado.status === 400, 'a OP está travada pela falta de ensaio', travado.body);

    const reclassificar = await req('PUT', `/api/producao/pecas/${ids.viga}`, {
      modo: 'projeto', quantidadeBase: 1.2, pesoKg: 3000,
      tempoProcessoHoras: 18, unidadesPorCiclo: 1, ensaioLimiteConformidade: 40,
    });
    assert(reclassificar.status === 400 && /ordem\(ns\) de produção em andamento/.test(reclassificar.body.error),
      'trocar a CURA com OP em andamento é recusado — era o caminho que contornava a trava',
      reclassificar.body);

    const trocarModo = await req('PUT', `/api/producao/pecas/${ids.viga}`, {
      modo: 'estoque', exigeEnsaioLiberacao: 1, quantidadeBase: 1.2, pesoKg: 3000,
      tempoProcessoHoras: 18, unidadesPorCiclo: 1, ensaioLimiteConformidade: 40, ensaioLimiteLiberacao: 24,
    });
    assert(trocarModo.status === 400,
      'trocar o MODO com OP em andamento também é recusado (a peça sairia sem identificação)',
      trocarModo.body);

    const soOutrosCampos = await req('PUT', `/api/producao/pecas/${ids.viga}`, {
      modo: 'projeto', exigeEnsaioLiberacao: 1, quantidadeBase: 1.25, pesoKg: 3050,
      tempoProcessoHoras: 18, unidadesPorCiclo: 1, ensaioLimiteConformidade: 40, ensaioLimiteLiberacao: 24,
    });
    assert(soOutrosCampos.status === 200,
      'os demais campos seguem editáveis: o que se protege é a classificação');

    // Guarda para o resto do teste: cancela a OP aberta.
    await req('POST', `/api/producao/ordens/${opId}/cancelar`, { motivo: 'fim da regressão' });

    // A guarda vale desde `planejada`: uma OP de obra que ainda não liberou,
    // se a peça virar catálogo antes, conclui sem criar peça identificada.
    const planejada = await req('POST', '/api/producao/ordens', {
      produtoId: ids.viga, quantidadePlanejada: 1, projetoId: obra.body.obra.id,
      dataPlanejada: '2026-09-16 07:00',
    });
    const trocaCedo = await req('PUT', `/api/producao/pecas/${ids.viga}`, {
      modo: 'estoque', exigeEnsaioLiberacao: 1, quantidadeBase: 1.25, pesoKg: 3050,
      tempoProcessoHoras: 18, unidadesPorCiclo: 1, ensaioLimiteConformidade: 40, ensaioLimiteLiberacao: 24,
    });
    assert(trocaCedo.status === 400 && /em andamento/.test(trocaCedo.body.error),
      'a guarda vale desde "planejada" — trocar antes de liberar é o mesmo furo uma etapa antes',
      trocaCedo.body);

    await req('POST', `/api/producao/ordens/${planejada.body.op.id}/cancelar`,
      { motivo: 'fim da regressão' });
    const depoisDeCancelar = await req('PUT', `/api/producao/pecas/${ids.viga}`, {
      modo: 'projeto', exigeEnsaioLiberacao: 1, quantidadeBase: 1.2, pesoKg: 3000,
      tempoProcessoHoras: 18, unidadesPorCiclo: 1, ensaioLimiteConformidade: 40, ensaioLimiteLiberacao: 24,
    });
    assert(depoisDeCancelar.status === 200,
      'sem OP aberta, a reclassificação volta a ser permitida', depoisDeCancelar.body);
  }

  secao('Regressão: um lote, duas peças com fck diferente');
  {
    // Achado crítico: `podeLiberarSaida` confiava no flag `aprovado`
    // gravado na ruptura. Um CP aprovado para a peça de 21 MPa liberava a de
    // 30 MPa quando as duas dividiam o lote.
    await req('PUT', `/api/producao/pecas/${ids.pilar}`, {
      modo: 'estoque', exigeEnsaioLiberacao: 1, quantidadeBase: 0.9, pesoKg: 2250,
      tempoProcessoHoras: 20, unidadesPorCiclo: 1, ensaioLimiteConformidade: 40, ensaioLimiteLiberacao: 30,
    });
    // Sem ficha a OP não libera — e o teste passaria por engano, com a OP
    // parada em `planejada` em vez de barrada pela trava do ensaio.
    await req('POST', `/api/producao/pecas/${ids.pilar}/ficha`,
      { insumoProdutoId: ids.cimento, quantidade: 350, unidade: 'KG', perdaPercentual: 3, grupo: 'concreto' });

    const lote = await req('POST', '/api/producao/lotes',
      { data: '2026-09-18', volumeM3: 5, ensaioLimiteConformidade: 40 });
    const loteId = lote.body.lote.id;

    // OP da viga (exige 24) e OP do pilar (exige 30), MESMO lote.
    const obra = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Obra do lote compartilhado' });
    await req('POST', `/api/producao/obras/${obra.body.obra.id}/status`, { status: 'contratada' });

    const opV = (await req('POST', '/api/producao/ordens', {
      produtoId: ids.viga, quantidadePlanejada: 1, projetoId: obra.body.obra.id,
      dataPlanejada: '2026-09-18 07:00',
    })).body.op.id;
    await req('POST', `/api/producao/ordens/${opV}/liberar`);
    await req('POST', `/api/producao/ordens/${opV}/iniciar-processo`,
      { dataInicioProcesso: '2026-09-18 08:00', loteId: loteId });

    const cp = await req('POST', `/api/producao/lotes/${loteId}/corpos-prova`,
      { identificacao: 'CP-COMP', finalidade: 'transferencia', dataMoldagem: '2026-09-18' });
    const rup = await req('POST', `/api/producao/corpos-prova/${cp.body.corpoProva.id}/ruptura`,
      { resistenciaMpa: 26, dataRuptura: '2026-09-19' });
    assert(rup.body.corpoProva.aprovado === 1, '26 MPa aprova para a viga (exige 24)');

    const liberouViga = await req('POST', `/api/producao/ordens/${opV}/liberar-saida`, {});
    assert(liberouViga.status === 200, 'a viga libera com esse ensaio', liberouViga.body);

    // Agora o pilar, que exige 30, entra no MESMO lote.
    const opP = (await req('POST', '/api/producao/ordens', {
      produtoId: ids.pilar, quantidadePlanejada: 1, dataPlanejada: '2026-09-18 07:00',
    })).body.op.id;
    await req('POST', `/api/producao/ordens/${opP}/liberar`);
    await req('POST', `/api/producao/ordens/${opP}/iniciar-processo`,
      { dataInicioProcesso: '2026-09-18 09:00', loteId: loteId });

    const pilarTravado = await req('POST', `/api/producao/ordens/${opP}/liberar-saida`, {});
    assert(pilarTravado.status === 400 && /26 MPa e esta peça exige 30 MPa/.test(pilarTravado.body.error),
      'o MESMO ensaio de 26 MPa NÃO libera a peça que exige 30 — a comparação é por peça, '
      + 'não pelo flag gravado', pilarTravado.body);
  }

  secao('Regressão: rebaixar o fck não contorna a trava');
  {
    // Achado da 2ª auditoria: a guarda cobria modo/cura, mas
    // `ensaioLimiteLiberacao` seguia editável — e era exatamente o número contra
    // o qual a trava passou a comparar. Baixar de 30 para 21 fazia um ensaio
    // de 22 MPa "aprovar", e o evento registrava como liberação legítima.
    await req('PUT', `/api/producao/pecas/${ids.pilar}`, {
      modo: 'estoque', exigeEnsaioLiberacao: 1, quantidadeBase: 0.9, pesoKg: 2250,
      tempoProcessoHoras: 20, unidadesPorCiclo: 1, ensaioLimiteConformidade: 40, ensaioLimiteLiberacao: 30,
    });

    const lote = await req('POST', '/api/producao/lotes',
      { data: '2026-09-28', volumeM3: 3, ensaioLimiteConformidade: 40 });
    const loteId = lote.body.lote.id;

    const opId = (await req('POST', '/api/producao/ordens', {
      produtoId: ids.pilar, quantidadePlanejada: 1, dataPlanejada: '2026-09-28 07:00',
    })).body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`,
      { dataInicioProcesso: '2026-09-28 08:00', loteId: loteId });

    const opDepois = await req('GET', `/api/producao/ordens/${opId}`);
    assert(opDepois.body.op.ensaioLimiteExigido === 30,
      'a concretagem CONGELA o fck exigido na OP', opDepois.body.op.ensaioLimiteExigido);

    const cp = await req('POST', `/api/producao/lotes/${loteId}/corpos-prova`,
      { identificacao: 'CP-FCK', finalidade: 'transferencia', dataMoldagem: '2026-09-28' });
    await req('POST', `/api/producao/corpos-prova/${cp.body.corpoProva.id}/ruptura`,
      { resistenciaMpa: 22, dataRuptura: '2026-09-29' });

    const travado = await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    assert(travado.status === 400, '22 MPa não libera peça de 30', travado.body);

    // A tentativa de fraude: rebaixar o fck da peça (a guarda de modo/cura não
    // impedia, porque nem modo nem cura mudam).
    const rebaixar = await req('PUT', `/api/producao/pecas/${ids.pilar}`, {
      modo: 'estoque', exigeEnsaioLiberacao: 1, quantidadeBase: 0.9, pesoKg: 2250,
      tempoProcessoHoras: 20, unidadesPorCiclo: 1, ensaioLimiteConformidade: 40, ensaioLimiteLiberacao: 21,
    });
    assert(rebaixar.status === 200,
      'rebaixar o fck no cadastro é permitido (afeta as PRÓXIMAS OPs)', rebaixar.body);

    const aindaTravado = await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    assert(aindaTravado.status === 400 && /exige 30 MPa/.test(aindaTravado.body.error),
      'mas a OP já em_processo segue exigindo os 30 MPa congelados — o cadastro não a alcança',
      aindaTravado.body);

    // Restaura para não afetar as seções seguintes.
    await req('POST', `/api/producao/ordens/${opId}/cancelar`, { motivo: 'fim da regressão do fck' });
    await req('PUT', `/api/producao/pecas/${ids.pilar}`, {
      modo: 'estoque', exigeEnsaioLiberacao: 1, quantidadeBase: 0.9, pesoKg: 2250,
      tempoProcessoHoras: 20, unidadesPorCiclo: 1, ensaioLimiteConformidade: 40, ensaioLimiteLiberacao: 30,
    });
  }

  secao('Regressão: o bypass, quando usado de verdade');
  {
    // O caminho feliz do bypass nunca era exercido: só as duas recusas.
    const opId = db.prepare(
      "SELECT id FROM prod_ordens WHERE status = 'em_processo' ORDER BY id DESC LIMIT 1"
    ).get().id;

    u.setCfg(db, 'producao_permitir_liberacao_sem_ensaio', '1');
    const forcado = await req('POST', `/api/producao/ordens/${opId}/liberar-saida`,
      { forcar: true, justificativa: 'peça de reposição, ensaio da betonada irmã aprovado' });
    assert(forcado.status === 200 && forcado.body.op.status === 'liberada_saida',
      'com config + forcar + justificativa, a liberação passa', forcado.body);
    assert((forcado.body.avisos || []).some(a => /SEM ensaio/i.test(a)),
      'e devolve aviso explícito de que passou sem ensaio', forcado.body.avisos);

    const ev = db.prepare(
      "SELECT * FROM prod_ordem_eventos WHERE opId = ? AND tipo = 'liberacao_forcada'"
    ).get(opId);
    assert(!!ev, 'o evento liberacao_forcada é gravado');
    assert(/ensaio da betonada irmã/.test(ev.descricao),
      'com a justificativa dentro', ev && ev.descricao);
    assert(ev.usuario === 'teste', 'e com o usuário que forçou', ev && ev.usuario);

    // O evento é gravado com CURRENT_TIMESTAMP (data real), não com a data
    // fictícia da OP — por isso a janela aqui é o ano inteiro.
    const painel = produtividade.aderenciaCura(db, { de: '2026-01-01', ate: '2026-12-31' });
    assert(painel.liberacoesForcadas >= 1,
      'e a liberação forçada aparece no painel de aderência', painel.liberacoesForcadas);
    u.setCfg(db, 'producao_permitir_liberacao_sem_ensaio', '0');
  }

  secao('Regressão: a baixa da OP não pode envenenar o custo médio do ERP');
  {
    // Achado crítico: `movimentar` gravava `data` com hora. O core grava
    // data-só, e calcularCustoMedio ordena por `data DESC` — a linha com hora
    // vencia a mais recente e devolvia um custo médio antigo, que a
    // movimentação seguinte materializava para o produto no tenant inteiro.
    const { calcularCustoMedio } = require(u.BASE + '/estoque-routes');

    const movs = db.prepare(
      "SELECT data FROM movimentacoes_estoque WHERE origem IN ('prod_ordem','prod_ordem_producao','prod_ordem_estorno')"
    ).all();
    assert(movs.length > 0 && movs.every(m => /^\d{4}-\d{2}-\d{2}$/.test(m.data)),
      'toda movimentação do módulo grava `data` como data pura, igual ao core',
      movs.slice(0, 3));

    const comDeposito = db.prepare(
      "SELECT COUNT(*) n FROM movimentacoes_estoque WHERE origem = 'prod_ordem' AND depositoId IS NOT NULL"
    ).get().n;
    assert(comDeposito > 0,
      'e resolve o depósito, senão o saldo POR depósito não fecha', comDeposito);

    // O teste que prova o bug: entrada do core depois da baixa do módulo.
    const antes = calcularCustoMedio(db, ids.cimento);
    const ctx = require(u.BASE + '/estoque-routes')
      .calcularContextoMovimento(db, ids.cimento, 'entrada', 1000, 2.40);
    db.prepare(`
      INSERT INTO movimentacoes_estoque
        (produtoId, tipo, quantidade, custoUnitario, origem, observacao, data,
         custoMedioAnterior, custoMedioPosterior, saldoPosterior)
      VALUES (?, 'entrada', 1000, 2.40, 'teste-core', 'entrada cara do core',
              date('now'), ?, ?, ?)
    `).run(ids.cimento, ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior);

    const depois = calcularCustoMedio(db, ids.cimento);
    assert(depois > antes,
      'a entrada cara do core sobe o custo médio — a linha do módulo não sequestra a consulta',
      { antes, depois });
    assert(Math.abs(depois - ctx.custoMedioPosterior) < 1e-9,
      'e o custo médio lido é exatamente o que a última entrada gravou',
      { lido: depois, gravado: ctx.custoMedioPosterior });
  }

  secao('Regressão: identificações duplicadas e quantidade fracionária');
  {
    const obra = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Obra das identificações' });
    await req('POST', `/api/producao/obras/${obra.body.obra.id}/status`, { status: 'contratada' });
    const opId = (await req('POST', '/api/producao/ordens', {
      produtoId: ids.viga, quantidadePlanejada: 2, projetoId: obra.body.obra.id,
      dataPlanejada: '2026-09-25 07:00',
    })).body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);
    const lote = await req('POST', '/api/producao/lotes',
      { data: '2026-09-25', volumeM3: 3, ensaioLimiteConformidade: 40 });
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`,
      { dataInicioProcesso: '2026-09-25 08:00', loteId: lote.body.lote.id });
    const cp = await req('POST', `/api/producao/lotes/${lote.body.lote.id}/corpos-prova`,
      { identificacao: 'CP-ID', finalidade: 'transferencia' });
    await req('POST', `/api/producao/corpos-prova/${cp.body.corpoProva.id}/ruptura`,
      { resistenciaMpa: 28 });
    await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});

    const fracao = await req('POST', `/api/producao/ordens/${opId}/concluir`,
      { quantidadeProduzida: 2.5 });
    assert(fracao.status === 400 && /inteira/.test(fracao.body.error),
      'peça numerada com quantidade fracionária é recusada (viraria 3 peças e 2,5 no estoque)',
      fracao.body);

    const repetida = await req('POST', `/api/producao/ordens/${opId}/concluir`,
      { quantidadeProduzida: 2, identificacoes: ['V-900', 'V-900'] });
    assert(repetida.status === 400 && /repetida/.test(repetida.body.error),
      'identificação repetida na lista devolve 400, não 500 do UNIQUE', repetida.body);

    // `dataConclusao` explícita: sem ela a conclusão usa a data de HOJE e
    // entraria na janela de agosto que as seções de produtividade medem.
    const ok = await req('POST', `/api/producao/ordens/${opId}/concluir`,
      { quantidadeProduzida: 2, identificacoes: ['V-900', 'V-901'], dataConclusao: '2026-09-26 10:00' });
    assert(ok.status === 200, 'identificações distintas passam', ok.body);

    // Agora tentar reusar uma identificação já gravada.
    const opId2 = (await req('POST', '/api/producao/ordens', {
      produtoId: ids.viga, quantidadePlanejada: 1, projetoId: obra.body.obra.id,
      dataPlanejada: '2026-09-26 07:00',
    })).body.op.id;
    await req('POST', `/api/producao/ordens/${opId2}/liberar`);
    await req('POST', `/api/producao/ordens/${opId2}/iniciar-processo`,
      { dataInicioProcesso: '2026-09-26 08:00', loteId: lote.body.lote.id });
    await req('POST', `/api/producao/ordens/${opId2}/liberar-saida`, {});
    const reuso = await req('POST', `/api/producao/ordens/${opId2}/concluir`,
      { quantidadeProduzida: 1, identificacoes: ['V-900'], dataConclusao: '2026-09-27 10:00' });
    assert(reuso.status === 400 && /já usada/.test(reuso.body.error),
      'identificação já usada em outra peça também devolve 400', reuso.body);
  }

  // ═══ Peça identificada ═════════════════════════════════════════════════════
  secao('Peça identificada: geração e amarração ao lote');
  {
    const parcial = await req('POST', `/api/producao/ordens/${opViga}/concluir`,
      { quantidadeProduzida: 2, identificacoes: ['V-001'] });
    assert(parcial.status === 400 && /identificações/.test(parcial.body.error),
      'identificações em número diferente da produção é recusado', parcial.body);

    const fim = await req('POST', `/api/producao/ordens/${opViga}/concluir`,
      { quantidadeProduzida: 2, dataConclusao: '2026-08-23 10:00' });
    assert(fim.status === 200, 'OP de viga concluída', fim.body);
    assert(fim.body.op.pecasProduzidas.length === 2,
      'peça de obra gera UMA linha identificada por unidade', fim.body.op.pecasProduzidas.length);

    const pp = fim.body.op.pecasProduzidas[0];
    assert(pp.loteId === loteId,
      'a peça carrega o lote de concreto — é esse elo que dá lastro ao ensaio');
    assert(pp.status === 'patio', 'peça nasce no pátio');
    assert(/-001$/.test(fim.body.op.pecasProduzidas[0].identificacao),
      'identificação gerada segue o número da OP', pp.identificacao);

    // Rastreabilidade de ponta a ponta: da peça ao corpo de prova.
    const rastro = db.prepare(`
      SELECT pp.identificacao, l.codigo AS lote, cp.identificacao AS corpoProva, cp.resistenciaMpa
        FROM prod_unidades pp
        JOIN prod_lotes l ON l.id = pp.loteId
        JOIN prod_ensaios cp ON cp.loteId = l.id AND cp.aprovado = 1
       WHERE pp.id = ?
    `).get(pp.id);
    assert(rastro && rastro.resistenciaMpa === 26,
      'peça → lote → corpo de prova aprovado: a cadeia da NBR 9062 fecha', rastro);
  }

  // ═══ Apontamento ═══════════════════════════════════════════════════════════
  secao('Apontamento: equipe é o normal, indivíduo é a exceção');
  let equipeId;
  {
    const e = await req('POST', '/api/producao/equipes',
      { nome: 'Equipe Pista A', especialidade: 'processo' });
    assert(e.status === 201, 'equipe criada', e.body);
    equipeId = e.body.equipe.id;

    const m = await req('PUT', `/api/producao/equipes/${equipeId}/membros`,
      { funcionarioIds: ids.funcionarios });
    assert(m.status === 200 && m.body.membros.length === 4, 'quatro membros na equipe', m.body);

    // Abre uma OP nova para apontar (as anteriores estão concluídas).
    const c = await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 40, formaId: formaBloco,
      dataPlanejada: '2026-08-25 07:00',
    });
    const opId = c.body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);

    const individual = await req('POST', `/api/producao/ordens/${opId}/apontamentos`, {
      etapa: 'processo', data: '2026-08-25', funcionarioId: ids.funcionarios[0],
      horas: 4, quantidadeProduzida: 10, quantidadeRefugo: 0,
    });
    assert(individual.status === 400 && /coletiva/.test(individual.body.error),
      'concretagem com funcionarioId é recusada: é trabalho de equipe, não de pessoa',
      individual.body);

    const refugoSemMotivo = await req('POST', `/api/producao/ordens/${opId}/apontamentos`, {
      etapa: 'processo', data: '2026-08-25', equipeId, horas: 4,
      quantidadeProduzida: 10, quantidadeRefugo: 3,
    });
    assert(refugoSemMotivo.status === 400 && /motivoRefugo/.test(refugoSemMotivo.body.error),
      'refugo sem motivo é recusado no apontamento', refugoSemMotivo.body);

    const longo = await req('POST', `/api/producao/ordens/${opId}/apontamentos`, {
      etapa: 'processo', data: '2026-08-25', equipeId, horas: 30, quantidadeProduzida: 1,
    });
    assert(longo.status === 400, 'apontamento acima de 24h é recusado');

    const bom = await req('POST', `/api/producao/ordens/${opId}/apontamentos`, {
      etapa: 'processo', data: '2026-08-25', equipeId,
      horaInicio: '07:00', horaFim: '11:30', quantidadeProduzida: 0, quantidadeRefugo: 0,
    });
    assert(bom.status === 201 && Math.abs(bom.body.apontamento.horas - 4.5) < 1e-9,
      'horaInicio/horaFim viram horas automaticamente', bom.body);
    assert(bom.body.apontamento.pessoas === 4,
      'o tamanho da equipe é congelado no apontamento (a composição muda com o tempo)');

    // Armação É individual: aqui o funcionarioId é aceito.
    const arm = await req('POST', `/api/producao/ordens/${opId}/apontamentos`, {
      etapa: 'preparacao', data: '2026-08-25', funcionarioId: ids.funcionarios[0],
      horas: 6, quantidadeProduzida: 120,
    });
    assert(arm.status === 201 && arm.body.apontamento.pessoas === 1,
      'armação aceita apontamento individual (a tarefa é individual de fato)', arm.body);

    // Desforma é o que conta produção.
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`, { dataInicioProcesso: '2026-08-25 12:00' });
    await req('POST', `/api/producao/ordens/${opId}/apontamentos`, {
      etapa: 'inspecao', data: '2026-08-26', equipeId, horas: 3,
      quantidadeProduzida: 36, quantidadeRefugo: 4, motivoRefugo: 'trinca na aresta',
    });

    const detalhe = await req('GET', `/api/producao/ordens/${opId}`);
    assert(detalhe.body.totaisApontados.quantidadeProduzida === 36,
      'só a etapa "desforma" conta produção (armação + concretagem não somam as mesmas peças)',
      detalhe.body.totaisApontados);
    assert(detalhe.body.totaisApontados.quantidadeRefugo === 4,
      'refugo soma de TODAS as etapas');

    // Conclusão usa o apontado como default.
    await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    const fim = await req('POST', `/api/producao/ordens/${opId}/concluir`, {});
    assert(fim.status === 200 && fim.body.op.quantidadeProduzida === 36,
      'concluir sem informar quantidade usa o que já foi apontado', fim.body.op);

    const depois = await req('POST', `/api/producao/ordens/${opId}/apontamentos`, {
      etapa: 'acabamento', data: '2026-08-27', equipeId, horas: 1, quantidadeProduzida: 1,
    });
    assert(depois.status === 400, 'OP concluída não aceita novo apontamento', depois.body);
  }

  // ═══ Produtividade ═════════════════════════════════════════════════════════
  secao('Produtividade: o indicador que o dono pediu');
  {
    // Sem ponto lançado, o homem-hora cai no apontamento — e tem de DIZER isso.
    const semPonto = produtividade.porEquipe(db, { de: '2026-08-01', ate: '2026-08-31' });
    const linha = semPonto.equipes.find(e => e.equipeId === equipeId);
    assert(linha.fonteHomemHora === 'apontamento',
      'sem ponto no período, o homem-hora vem do apontamento');
    assert(semPonto.avisos.some(a => /sem ponto/.test(a)),
      'e o painel AVISA que o número está otimista', semPonto.avisos);

    // Com ponto: 4 pessoas × 8h × 2 dias = 64 homem-hora.
    u.lancarPonto(db, ids.funcionarios, '2026-08-25', 8);
    u.lancarPonto(db, ids.funcionarios, '2026-08-26', 8);

    const comPonto = produtividade.porEquipe(db, { de: '2026-08-01', ate: '2026-08-31' });
    const l2 = comPonto.equipes.find(e => e.equipeId === equipeId);
    assert(l2.fonteHomemHora === 'ponto', 'com ponto lançado, o denominador vem do PONTO');
    assert(l2.homemHora === 64, '4 pessoas × 8h × 2 dias = 64 homem-hora', l2.homemHora);
    assert(l2.unidadesBoas === 36, 'produção da equipe = o apontado na etapa que conta produção', l2.unidadesBoas);

    // 36 blocos × 0,01 m³ = 0,36 m³ ÷ 64 hh
    assert(Math.abs(l2.baseProduzida - 0.36) < 1e-9, 'base = unidades × quantidadeBase da ficha', l2.baseProduzida);
    assert(Math.abs(l2.basePorHomemHora - 0.36 / 64) < 1e-9,
      'base por homem-hora confere com a conta à mão', l2.basePorHomemHora);

    // Refugo sobre o TOTAL, não sobre o bom: 4 / (36+4) = 10%.
    assert(Math.abs(l2.refugoPercentual - 10) < 1e-9,
      'refugo é 4 em 40 tentativas = 10% (não 11,1% sobre as boas)', l2.refugoPercentual);

    // O tempo de espera entra no denominador: apontou 8,5h de trabalho mas
    // esteve 64 hh presente. É essa diferença que o indicador tem de mostrar.
    const apontadas = db.prepare(
      'SELECT SUM(horas * COALESCE(pessoas,1)) h FROM prod_apontamentos WHERE equipeId = ?'
    ).get(equipeId).h;
    assert(l2.homemHora > apontadas,
      'o homem-hora do ponto é MAIOR que o apontado: a espera é custo e aparece',
      { ponto: l2.homemHora, apontado: apontadas });

    const individual = produtividade.individual(db, { de: '2026-08-01', ate: '2026-08-31' });
    assert(individual.linhas.length === 1 && individual.linhas[0].etapa === 'preparacao',
      'o ranking individual só traz etapas marcadas como individuais no cadastro', individual.linhas);
    assert(Math.abs(individual.linhas[0].porHora - 20) < 1e-9,
      '120 unidades em 6h = 20/h', individual.linhas[0].porHora);

    const formas = produtividade.porForma(db, { de: '2026-08-01', ate: '2026-08-31' });
    const fb = formas.formas.find(f => f.formaId === formaBloco);
    assert(fb.ciclos === 2, 'a forma de bloco girou 2 vezes no período', fb.ciclos);
    assert(fb.ocupacaoPorCicloPercentual != null && fb.ocupacaoPorCicloPercentual < 100,
      'ocupação por ciclo abaixo de 100%: concretou forma pela metade', fb.ocupacaoPorCicloPercentual);

    const resumo = produtividade.resumo(db, { de: '2026-08-01', ate: '2026-08-31' });
    assert(resumo.ops === 3, 'três OPs concluídas no período', resumo.ops);
    assert(resumo.custoTeorico > 0 && resumo.custoRealizado > 0, 'resumo traz orçado e realizado');
    assert(resumo.desvioCustoPercentual != null, 'e o desvio entre os dois', resumo.desvioCustoPercentual);
  }

  // ═══ Aderência à cura ══════════════════════════════════════════════════════
  secao('Aderência ao ciclo de cura');
  {
    const antes = produtividade.aderenciaCura(db, { de: '2026-08-01', ate: '2026-08-31' });
    assert(typeof antes.aderenciaPercentual === 'number', 'aderência calculada', antes);
    assert(antes.total >= 3, 'considera as OPs concluídas com desforma registrada', antes.total);
    assert(antes.adiantadas === 0,
      'até aqui nenhuma OP foi desmoldada antes da hora', antes);

    // O atalho que o indicador existe para expor: concretar às 07h de um dia
    // com 24h de cura e desmoldar às 15h do MESMO dia — 16h antes da previsão.
    const c = await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 40, dataPlanejada: '2026-08-29 07:00',
    });
    const opId = c.body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`, { dataInicioProcesso: '2026-08-29 07:00' });
    await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    const fim = await req('POST', `/api/producao/ordens/${opId}/concluir`,
      { quantidadeProduzida: 40, dataConclusao: '2026-08-29 15:00' });
    assert(fim.status === 200, 'OP desmoldada no mesmo dia da concretagem', fim.body);

    const depois = produtividade.aderenciaCura(db, { de: '2026-08-01', ate: '2026-08-31' });
    assert(depois.adiantadas === 1, 'desforma antes da hora prevista é detectada', depois);
    assert(Math.abs(depois.piores[0].horasAdiantada - 16) < 1e-6,
      'e o indicador diz QUANTAS horas foi adiantada (16h)', depois.piores[0]);
    assert(depois.aderenciaPercentual < 100,
      'a aderência cai quando alguém corta a cura', depois.aderenciaPercentual);

    // A liberação forçada também é contada — mesmo padrão, outra porta.
    assert(typeof depois.liberacoesForcadas === 'number',
      'liberações forçadas do período entram no mesmo painel', depois.liberacoesForcadas);
  }

  // ═══ Cancelamento e estorno ════════════════════════════════════════════════
  secao('Cancelamento com estorno');
  {
    const c = await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 10, dataPlanejada: '2026-08-28 07:00',
    });
    const opId = c.body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);

    const saldoAntes = u.saldo(db, ids.cimento);
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`, { dataInicioProcesso: '2026-08-28 08:00' });
    assert(u.saldo(db, ids.cimento) < saldoAntes, 'concretagem baixou o insumo');

    const semMotivo = await req('POST', `/api/producao/ordens/${opId}/cancelar`, {});
    assert(semMotivo.status === 400, 'cancelamento sem motivo é recusado');

    const canc = await req('POST', `/api/producao/ordens/${opId}/cancelar`,
      { motivo: 'betonada perdida por chuva' });
    assert(canc.status === 200 && canc.body.op.status === 'cancelada', 'OP cancelada', canc.body);
    assert(Math.abs(u.saldo(db, ids.cimento) - saldoAntes) < 1e-6,
      'cancelar DEPOIS da concretagem estorna a baixa: o saldo volta ao que era',
      { antes: saldoAntes, depois: u.saldo(db, ids.cimento) });

    const original = db.prepare(
      "SELECT * FROM movimentacoes_estoque WHERE origem = 'prod_ordem' AND origemId = ? AND produtoId = ?"
    ).get(opId, ids.cimento);
    assert(original.estornada === 1 && original.movEstornoId != null,
      'a movimentação original fica marcada como estornada, apontando para o estorno', original);

    const naoCancela = await req('POST', `/api/producao/ordens/${opBloco}/cancelar`,
      { motivo: 'tentativa' });
    assert(naoCancela.status === 400 && /concluída/.test(naoCancela.body.error),
      'OP concluída não pode ser cancelada (a peça já entrou no estoque)', naoCancela.body);
  }

  // ═══ Conflito de forma ═════════════════════════════════════════════════════
  secao('Agenda de forma: o recurso que satura');
  {
    const a = await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 40, formaId: formaBloco,
      dataPlanejada: '2026-09-10 07:00',
    });
    await req('POST', `/api/producao/ordens/${a.body.op.id}/liberar`);

    const b = await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 40, formaId: formaBloco,
      dataPlanejada: '2026-09-10 15:00',   // dentro das 24h de cura da anterior
    });
    const conflito = await req('POST', `/api/producao/ordens/${b.body.op.id}/liberar`);
    assert(conflito.status === 400 && /forma ocupada/.test(conflito.body.error),
      'duas OPs na mesma forma em janela sobreposta: a segunda é barrada', conflito.body);

    u.setCfg(db, 'producao_permitir_recurso_sobreposto', '1');
    const forcado = await req('POST', `/api/producao/ordens/${b.body.op.id}/liberar`);
    assert(forcado.status === 200 && forcado.body.avisos.some(a2 => /ocupada/.test(a2)),
      'com a config ligada passa, mas o aviso fica registrado', forcado.body.avisos);
    u.setCfg(db, 'producao_permitir_recurso_sobreposto', '0');

    const bloq = await req('POST', `/api/producao/formas/${formaBloco}/bloqueios`,
      { dataInicio: '2026-10-01', dataFim: '2026-10-05', motivo: 'troca de molde' });
    assert(bloq.status === 201, 'bloqueio de forma criado', bloq.body);

    const c = await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 40, formaId: formaBloco,
      dataPlanejada: '2026-10-02 07:00',
    });
    const barrado = await req('POST', `/api/producao/ordens/${c.body.op.id}/liberar`);
    assert(barrado.status === 400 && /bloqueio/.test(barrado.body.error),
      'bloqueio de manutenção também ocupa a forma', barrado.body);
  }

  // ═══ Config ════════════════════════════════════════════════════════════════
  secao('Configuração do módulo');
  {
    const ruim = await req('PUT', '/api/producao/config', { producao_custo_hora_padrao: 'abc' });
    assert(ruim.status === 400, 'config não-numérica é recusada');

    const fora = await req('PUT', '/api/producao/config', { producao_dias_alerta_patio: 99999 });
    assert(fora.status === 400, 'config fora da faixa é recusada');

    const desconhecida = await req('PUT', '/api/producao/config', { pmo_inventada: '1' });
    assert(desconhecida.status === 400, 'chave desconhecida é recusada');

    const boa = await req('PUT', '/api/producao/config', { producao_custo_hora_padrao: '18.50' });
    assert(boa.status === 200 && boa.body.config.producao_custo_hora_padrao === '18.50',
      'config válida é gravada', boa.body.config);
  }

  // ═══ Custo com mão de obra ═════════════════════════════════════════════════
  secao('Custo de mão de obra entra depois de configurado o custo-hora');
  {
    const c = await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 40, dataPlanejada: '2026-09-20 07:00',
    });
    const opId = c.body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);
    await req('POST', `/api/producao/ordens/${opId}/apontamentos`, {
      etapa: 'processo', data: '2026-09-20', equipeId, horas: 5, quantidadeProduzida: 0,
    });
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`, { dataInicioProcesso: '2026-09-20 08:00' });
    await req('POST', `/api/producao/ordens/${opId}/apontamentos`, {
      etapa: 'inspecao', data: '2026-09-21', equipeId, horas: 2, quantidadeProduzida: 40,
    });
    await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    await req('POST', `/api/producao/ordens/${opId}/concluir`, {});

    const custo = await req('GET', `/api/producao/ordens/${opId}/custo`);
    // (5h + 2h) × 4 pessoas × R$18,50 = 518
    assert(Math.abs(custo.body.custoMaoObra - (5 + 2) * 4 * 18.50) < 1e-6,
      'mão de obra = horas × pessoas × custo-hora', custo.body.custoMaoObra);
    assert(custo.body.avisoCustoHora === null,
      'com o custo-hora configurado, o aviso some');
    assert(custo.body.custoRealizado > custo.body.custoInsumo,
      'o custo realizado agora inclui mão de obra');
  }

  servidor.close();
  db.close();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`F1: ${ok} passaram, ${fail} falharam`);
  if (fail) {
    console.log('\nFalhas:');
    falhas.forEach(f => console.log(`  - ${f}`));
  }
  console.log(`banco descartável: ${caminho}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO FATAL:', e.stack); process.exit(1); });
