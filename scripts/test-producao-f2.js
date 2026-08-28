#!/usr/bin/env node
/**
 * test-producao-f2.js — Fase 2: obra, pátio, romaneio e medição.
 *
 * Roda contra banco DESCARTÁVEL em /tmp. Ver scripts/producao-teste-util.js.
 *
 * Uso: node scripts/test-producao-f2.js
 */

const u = require('./producao-teste-util');

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
  u.ligarFlag(db);

  const req = async (metodo, rota, corpo) => {
    const r = await fetch(`http://127.0.0.1:${porta}${rota}`, {
      method: metodo,
      headers: { 'content-type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };

  // ─── Preparo: tipos de peça e ficha mínima ─────────────────────────────────
  await req('PUT', `/api/producao/pecas/${ids.pilar}`, {
    modo: 'projeto', quantidadeBase: 0.9, pesoKg: 2250,
    comprimentoM: 6, tempoProcessoHoras: 20, unidadesPorCiclo: 1, ensaioLimiteConformidade: 35,
  });
  await req('POST', `/api/producao/pecas/${ids.pilar}/ficha`,
    { insumoProdutoId: ids.cimento, quantidade: 350, unidade: 'KG', perdaPercentual: 3, grupo: 'concreto' });
  await req('POST', `/api/producao/pecas/${ids.pilar}/ficha`,
    { insumoProdutoId: ids.aco, quantidade: 90, unidade: 'KG', perdaPercentual: 8, grupo: 'aco' });

  await req('PUT', `/api/producao/pecas/${ids.bloco}`, {
    modo: 'estoque', quantidadeBase: 0.01, pesoKg: 12,
    tempoProcessoHoras: 24, unidadesPorCiclo: 40, ensaioLimiteConformidade: 25,
  });
  await req('POST', `/api/producao/pecas/${ids.bloco}/ficha`,
    { insumoProdutoId: ids.cimento, quantidade: 1.5, unidade: 'KG', perdaPercentual: 4, grupo: 'concreto' });

  // ═══ Obra ══════════════════════════════════════════════════════════════════
  secao('Obra: cadastro e ciclo de status');
  let projetoId, obraMontagemId;
  {
    const semCliente = await req('POST', '/api/producao/obras', { nome: 'Sem cliente' });
    assert(semCliente.status === 400, 'obra sem cliente é recusada', semCliente.body);

    const o = await req('POST', '/api/producao/obras', {
      clienteId: ids.cliente, nome: 'Galpão Logístico BR-101',
      cidade: 'Vitória', uf: 'ES', dataPrevistaEntrega: '2026-11-30',
    });
    assert(o.status === 201 && o.body.obra.status === 'orcamento', 'obra nasce em orçamento', o.body);
    assert(/^OBR-\d{6}$/.test(o.body.obra.numero), 'numeração da obra', o.body.obra.numero);
    assert(o.body.obra.comMontagem === 0,
      'comMontagem nasce DESLIGADA (o prospect não sabe se monta)');
    assert(o.body.obra.clienteNome === 'Construtora Teste',
      'o nome do cliente vem de pessoas (nomeFantasia, com razaoSocial de reserva)',
      o.body.obra.clienteNome);
    projetoId = o.body.obra.id;

    const pulo = await req('POST', `/api/producao/obras/${projetoId}/status`, { status: 'concluida' });
    assert(pulo.status === 400 && /transição inválida/.test(pulo.body.error),
      'não se pula de orçamento direto para concluída', pulo.body);

    const contratada = await req('POST', `/api/producao/obras/${projetoId}/status`, { status: 'contratada' });
    assert(contratada.status === 200, 'orçamento → contratada é válido');

    const om = await req('POST', '/api/producao/obras', {
      clienteId: ids.cliente, nome: 'Ponte Rolante com Montagem', comMontagem: 1,
    });
    obraMontagemId = om.body.obra.id;
    assert(om.body.obra.comMontagem === 1, 'obra com montagem contratada');
    await req('POST', `/api/producao/obras/${obraMontagemId}/status`, { status: 'contratada' });
  }

  // ═══ Itens da obra ═════════════════════════════════════════════════════════
  secao('Itens da obra: fornecimento e montagem separados desde o cadastro');
  let itemPilarId;
  {
    const montagemIndevida = await req('POST', `/api/producao/obras/${projetoId}/itens`, {
      produtoId: ids.pilar, quantidade: 10, valorUnitario: 2100, valorMontagemUnitario: 300,
    });
    assert(montagemIndevida.status === 400 && /não é "com montagem"/.test(montagemIndevida.body.error),
      'cobrar montagem em obra sem montagem é barrado no cadastro, não na medição',
      montagemIndevida.body);

    const it = await req('POST', `/api/producao/obras/${projetoId}/itens`, {
      produtoId: ids.pilar, quantidade: 10, valorUnitario: 2100,
    });
    assert(it.status === 201, 'item de fornecimento adicionado', it.body);
    itemPilarId = it.body.obra.itens[0].id;
    assert(it.body.obra.valorContratado === 21000, 'valor contratado materializado', it.body.obra.valorContratado);

    const comMontagem = await req('POST', `/api/producao/obras/${obraMontagemId}/itens`, {
      produtoId: ids.pilar, quantidade: 4, valorUnitario: 2100, valorMontagemUnitario: 350,
    });
    assert(comMontagem.status === 201, 'na obra com montagem, o valor de montagem é aceito');
    assert(comMontagem.body.obra.valorContratado === 4 * 2100 + 4 * 350,
      'contratado soma fornecimento + montagem', comMontagem.body.obra.valorContratado);

    const semPreco = await req('POST', `/api/producao/obras/${projetoId}/itens`, {
      produtoId: ids.bloco, quantidade: 0,
    });
    assert(semPreco.status === 400, 'quantidade zero é recusada');
  }

  // ═══ OP puxada pela obra ═══════════════════════════════════════════════════
  secao('Produção puxada pela obra');
  let pecasPilar = [];
  {
    const c = await req('POST', '/api/producao/ordens', {
      produtoId: ids.pilar, quantidadePlanejada: 4, projetoId, projetoItemId: itemPilarId,
      dataPlanejada: '2026-09-01 07:00',
    });
    assert(c.status === 201, 'OP da obra criada', c.body);
    const opId = c.body.op.id;

    await req('POST', `/api/producao/ordens/${opId}/liberar`);
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`, { dataInicioProcesso: '2026-09-01 08:00' });
    await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    const fim = await req('POST', `/api/producao/ordens/${opId}/concluir`, {
      quantidadeProduzida: 4, dataConclusao: '2026-09-02 09:00',
      identificacoes: ['P-101', 'P-102', 'P-103', 'P-104'],
    });
    assert(fim.status === 200, 'OP concluída com identificações informadas', fim.body);
    pecasPilar = fim.body.op.pecasProduzidas;
    assert(pecasPilar.map(p => p.identificacao).join(',') === 'P-101,P-102,P-103,P-104',
      'as identificações informadas são respeitadas', pecasPilar.map(p => p.identificacao));
    assert(pecasPilar.every(p => p.projetoId === projetoId),
      'a peça nasce carimbada com a obra que a encomendou');

    const situacao = await req('GET', `/api/producao/obras/${projetoId}/situacao`);
    const item = situacao.body.itens[0];
    assert(item.quantidadeProduzida === 4, 'a produção abate o saldo a produzir do item da obra', item);
    assert(item.saldoAProduzir === 6, 'restam 6 pilares a produzir', item);
    assert(item.quantidadeEntregue === 0, 'nada entregue ainda');
    assert(situacao.body.custoProducao > 0, 'a obra acumula o custo das OPs concluídas');

    const reduzir = await req('PUT', `/api/producao/obras/${projetoId}/itens/${itemPilarId}`, {
      produtoId: ids.pilar, quantidade: 2, valorUnitario: 2100,
    });
    assert(reduzir.status === 400 && /não pode ficar abaixo de 4/.test(reduzir.body.error),
      'não dá para reduzir a quantidade abaixo do que já foi produzido', reduzir.body);

    const remover = await req('DELETE', `/api/producao/obras/${projetoId}/itens/${itemPilarId}`);
    assert(remover.status === 400, 'item com produção não pode ser removido', remover.body);
  }

  // ═══ Pátio ═════════════════════════════════════════════════════════════════
  secao('Pátio');
  {
    const p = await req('GET', '/api/producao/patio');
    assert(p.status === 200 && p.body.identificadas.length === 4,
      'as 4 peças identificadas estão no pátio', p.body.totais);
    assert(Math.abs(p.body.totais.pesoTotalKg - 4 * 2250) < 1e-6,
      'peso total do pátio', p.body.totais.pesoTotalKg);
    assert(p.body.catalogo !== undefined,
      'peça de catálogo aparece como SALDO, não como lista de peças identificadas');

    const mover = await req('PUT', `/api/producao/pecas-produzidas/${pecasPilar[0].id}/posicao`,
      { posicaoPatio: 'Rua B - Quadra 3' });
    assert(mover.status === 200 && mover.body.unidade.posicaoPatio === 'Rua B - Quadra 3',
      'posição no pátio é texto livre (endereçamento vira tabela quando ele confirmar)');
  }

  // ═══ Romaneio ══════════════════════════════════════════════════════════════
  secao('Romaneio: peso, sequência e identificação');
  let romId;
  {
    const r = await req('POST', '/api/producao/romaneios', {
      projetoId, data: '2026-09-05', veiculoPlaca: 'ABC1D23',
      veiculoTipo: 'Prancha 3 eixos', motorista: 'João', capacidadeKg: 5000,
    });
    assert(r.status === 201 && r.body.romaneio.status === 'montagem', 'romaneio criado em montagem', r.body);
    romId = r.body.romaneio.id;

    const porQuantidade = await req('POST', `/api/producao/romaneios/${romId}/itens`,
      { produtoId: ids.pilar, quantidade: 2 });
    assert(porQuantidade.status === 400 && /identificação individual/.test(porQuantidade.body.error),
      'peça que exige identificação NÃO viaja por quantidade', porQuantidade.body);

    const i1 = await req('POST', `/api/producao/romaneios/${romId}/itens`,
      { unidadeId: pecasPilar[0].id });
    assert(i1.status === 201, 'peça identificada adicionada à carga', i1.body);
    assert(i1.body.romaneio.pesoTotalKg === 2250, 'peso da carga acumulado do cadastro da peça');
    assert(i1.body.romaneio.comprimentoMaiorM === 6, 'comprimento da maior peça registrado');

    await req('POST', `/api/producao/romaneios/${romId}/itens`, { unidadeId: pecasPilar[1].id });

    const excesso = await req('POST', `/api/producao/romaneios/${romId}/itens`,
      { unidadeId: pecasPilar[2].id });
    assert(excesso.status === 201, 'terceira peça entra na carga (o limite só é conferido ao fechar)');

    const fecharPesado = await req('POST', `/api/producao/romaneios/${romId}/fechar`);
    assert(fecharPesado.status === 400 && /excesso de peso/.test(fecharPesado.body.error),
      '3 × 2250 = 6750 kg contra 5000 de capacidade: fechar é ERRO, não aviso',
      fecharPesado.body);

    const itens = (await req('GET', `/api/producao/romaneios/${romId}`)).body.romaneio.itens;
    const terceiro = itens.find(i => i.unidadeId === pecasPilar[2].id);
    await req('DELETE', `/api/producao/romaneios/${romId}/itens/${terceiro.id}`);

    // Sequência duplicada barra o fechamento.
    const doisItens = (await req('GET', `/api/producao/romaneios/${romId}`)).body.romaneio.itens;
    await req('PUT', `/api/producao/romaneios/${romId}/ordem`, {
      ordem: doisItens.map(i => ({ itemId: i.id, sequencia: 1 })),
    });
    const fecharDup = await req('POST', `/api/producao/romaneios/${romId}/fechar`);
    assert(fecharDup.status === 400 && /sequência de descarga repetida/.test(fecharDup.body.error),
      'duas peças com a mesma sequência: ninguém decidiu qual sai primeiro', fecharDup.body);

    // A ordem que importa: a peça que monta primeiro sai primeiro.
    await req('PUT', `/api/producao/romaneios/${romId}/ordem`, {
      ordem: [{ itemId: doisItens[0].id, sequencia: 2 }, { itemId: doisItens[1].id, sequencia: 1 }],
    });
    const ordenado = await req('GET', `/api/producao/romaneios/${romId}`);
    assert(ordenado.body.romaneio.itens[0].unidadeId === pecasPilar[1].id,
      'a listagem sai na ordem de descarga (menor sequência primeiro)',
      ordenado.body.romaneio.itens.map(i => i.sequenciaDescarga));

    const fechado = await req('POST', `/api/producao/romaneios/${romId}/fechar`);
    assert(fechado.status === 200 && fechado.body.romaneio.status === 'carregado',
      'carga fechada dentro do peso e com ordem definida', fechado.body);

    const patioDepois = await req('GET', '/api/producao/patio');
    assert(patioDepois.body.identificadas.length === 2,
      'as peças carregadas saíram do pátio', patioDepois.body.identificadas.length);

    const jaExpedida = await req('POST', '/api/producao/romaneios', { projetoId, data: '2026-09-05' });
    const rom2 = jaExpedida.body.romaneio.id;
    const duasVezes = await req('POST', `/api/producao/romaneios/${rom2}/itens`,
      { unidadeId: pecasPilar[0].id });
    assert(duasVezes.status === 400 && /só peça no pátio/.test(duasVezes.body.error),
      'peça já expedida não viaja duas vezes', duasVezes.body);
  }

  // ═══ Entrega ═══════════════════════════════════════════════════════════════
  secao('Entrega e retorno ao pátio');
  {
    const pulo = await req('POST', `/api/producao/romaneios/${romId}/status`, { status: 'entregue' });
    assert(pulo.status === 400, 'carregado não vai direto para entregue (falta o trânsito)', pulo.body);

    const t = await req('POST', `/api/producao/romaneios/${romId}/status`,
      { status: 'transito', dataSaida: '2026-09-05 06:00' });
    // Os segundos entram na normalização: o formato tem de ser uniforme porque
    // toda comparação de janela do módulo é lexicográfica.
    assert(t.status === 200 && t.body.romaneio.dataSaida === '2026-09-05 06:00:00',
      'saída registrada, com o instante normalizado', t.body.romaneio.dataSaida);

    const e = await req('POST', `/api/producao/romaneios/${romId}/status`,
      { status: 'entregue', dataEntrega: '2026-09-05 11:00' });
    assert(e.status === 200, 'entrega registrada', e.body);

    const situacao = await req('GET', `/api/producao/obras/${projetoId}/situacao`);
    assert(situacao.body.itens[0].quantidadeEntregue === 2,
      'a entrega abate o saldo a entregar da obra', situacao.body.itens[0]);
    assert(situacao.body.itens[0].saldoAEntregar === 2,
      'restam 2 peças produzidas ainda no pátio', situacao.body.itens[0]);

    const peca = db.prepare('SELECT status FROM prod_unidades WHERE id = ?').get(pecasPilar[0].id);
    assert(peca.status === 'expedida',
      'obra SEM montagem: o ciclo da peça acaba em expedida', peca);

    // Desfazer uma carga devolve a peça ao pátio.
    const r3 = await req('POST', '/api/producao/romaneios', { projetoId, data: '2026-09-08' });
    const rom3 = r3.body.romaneio.id;
    await req('POST', `/api/producao/romaneios/${rom3}/itens`, { unidadeId: pecasPilar[2].id });
    await req('POST', `/api/producao/romaneios/${rom3}/fechar`);
    const desfeito = await req('POST', `/api/producao/romaneios/${rom3}/status`, { status: 'montagem' });
    assert(desfeito.status === 200, 'carga desfeita volta para montagem');
    const voltou = db.prepare('SELECT status, romaneioId FROM prod_unidades WHERE id = ?')
      .get(pecasPilar[2].id);
    assert(voltou.status === 'patio' && voltou.romaneioId === null,
      'e a peça volta ao pátio, solta do romaneio', voltou);
  }

  // ═══ Medição ═══════════════════════════════════════════════════════════════
  secao('Medição: só o que foi entregue');
  let medicaoId;
  {
    const previa = await req('GET', `/api/producao/obras/${projetoId}/medicao-previa`);
    assert(previa.status === 200 && previa.body.itens.length === 1,
      'a prévia traz só o romaneio ENTREGUE (peça no pátio não é receita)', previa.body.itens);
    assert(previa.body.itens[0].quantidade === 2, 'duas peças entregues', previa.body.itens[0]);
    assert(previa.body.valorTotal === 2 * 2100, 'valor pelo preço contratado do item', previa.body.valorTotal);
    assert(previa.body.valorMontagem === 0 && /sem montagem/.test(previa.body.nota),
      'obra sem montagem: medição 100% fornecimento', previa.body.nota);

    const competenciaRuim = await req('POST', `/api/producao/obras/${projetoId}/medicoes`,
      { competencia: '09/2026' });
    assert(competenciaRuim.status === 400, 'competência fora do formato YYYY-MM é recusada');

    const m = await req('POST', `/api/producao/obras/${projetoId}/medicoes`,
      { competencia: '2026-09', dataInicio: '2026-09-01', dataFim: '2026-09-30' });
    assert(m.status === 201 && m.body.medicao.numero === 1, 'primeira medição da obra', m.body.medicao);
    assert(m.body.medicao.valorTotal === 4200, 'valor da medição', m.body.medicao.valorTotal);
    assert(m.body.medicao.itens.every(i => i.romaneioId != null),
      'cada linha carrega o romaneio que a originou — é esse carimbo que evita medir duas vezes');
    medicaoId = m.body.medicao.id;

    const denovo = await req('GET', `/api/producao/obras/${projetoId}/medicao-previa`);
    assert(denovo.body.itens.length === 0,
      'o mesmo romaneio não aparece numa segunda prévia', denovo.body);

    const duplicada = await req('POST', `/api/producao/obras/${projetoId}/medicoes`,
      { competencia: '2026-10' });
    assert(duplicada.status === 400 && /nada a medir/.test(duplicada.body.error),
      'sem entrega nova, não há o que medir', duplicada.body);

    const obraAtual = await req('GET', `/api/producao/obras/${projetoId}`);
    assert(obraAtual.body.obra.valorMedido === 4200, 'o medido é materializado na obra');

    const sit = await req('GET', `/api/producao/obras/${projetoId}/situacao`);
    assert(sit.body.saldoAMedir === 21000 - 4200, 'saldo a medir', sit.body.saldoAMedir);
    assert(sit.body.margemSobreMedido != null,
      'margem calculada sobre o MEDIDO, não sobre o contrato', sit.body.margemSobreMedido);
  }

  // ═══ Medição com montagem ══════════════════════════════════════════════════
  secao('Medição com montagem: fornecimento e serviço em linhas distintas');
  {
    const c = await req('POST', '/api/producao/ordens', {
      produtoId: ids.pilar, quantidadePlanejada: 2, projetoId: obraMontagemId,
      dataPlanejada: '2026-09-10 07:00',
    });
    const opId = c.body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`, { dataInicioProcesso: '2026-09-10 08:00' });
    await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    const fim = await req('POST', `/api/producao/ordens/${opId}/concluir`,
      { quantidadeProduzida: 2, dataConclusao: '2026-09-11 09:00', identificacoes: ['M-01', 'M-02'] });
    const pecas = fim.body.op.pecasProduzidas;

    const r = await req('POST', '/api/producao/romaneios',
      { projetoId: obraMontagemId, data: '2026-09-12', capacidadeKg: 10000 });
    const rom = r.body.romaneio.id;
    for (const p of pecas) {
      await req('POST', `/api/producao/romaneios/${rom}/itens`, { unidadeId: p.id });
    }
    await req('POST', `/api/producao/romaneios/${rom}/fechar`);
    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'transito' });
    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'entregue' });

    const montada = db.prepare('SELECT status FROM prod_unidades WHERE id = ?').get(pecas[0].id);
    assert(montada.status === 'montada',
      'obra COM montagem: a peça entregue vira montada, não expedida', montada);

    const previa = await req('GET', `/api/producao/obras/${obraMontagemId}/medicao-previa`);
    assert(previa.body.itens.length === 2,
      'duas linhas: uma de fornecimento e uma de montagem', previa.body.itens.map(i => i.natureza));
    assert(previa.body.valorFornecimento === 2 * 2100 && previa.body.valorMontagem === 2 * 350,
      'os dois valores saem separados', {
        fornecimento: previa.body.valorFornecimento, montagem: previa.body.valorMontagem,
      });
    assert(/NFS-e/.test(previa.body.nota) && /7\.02/.test(previa.body.nota),
      'a nota explica o destino fiscal de cada natureza', previa.body.nota);

    const m = await req('POST', `/api/producao/obras/${obraMontagemId}/medicoes`, { competencia: '2026-09' });
    assert(m.status === 201, 'medição com montagem gerada', m.body);
    const naturezas = m.body.medicao.itens.map(i => i.natureza).sort();
    assert(naturezas.join(',') === 'fornecimento,montagem',
      'a separação sobrevive na medição gravada — é ela que prova o que era serviço', naturezas);
  }

  // ═══ Cancelamento de medição ═══════════════════════════════════════════════
  secao('Cancelamento de medição');
  {
    const semMotivo = await req('POST', `/api/producao/medicoes/${medicaoId}/cancelar`, {});
    assert(semMotivo.status === 400, 'cancelamento sem motivo é recusado');

    db.prepare('UPDATE prod_medicoes SET nfeId = 999 WHERE id = ?').run(medicaoId);
    const comNota = await req('POST', `/api/producao/medicoes/${medicaoId}/cancelar`,
      { motivo: 'erro de valor' });
    assert(comNota.status === 400 && /nota fiscal/.test(comNota.body.error),
      'medição com nota emitida não é cancelada sem cancelar a nota antes', comNota.body);

    db.prepare('UPDATE prod_medicoes SET nfeId = NULL WHERE id = ?').run(medicaoId);
    const canc = await req('POST', `/api/producao/medicoes/${medicaoId}/cancelar`,
      { motivo: 'erro de valor' });
    assert(canc.status === 200 && canc.body.medicao.status === 'cancelada', 'medição cancelada', canc.body);

    const obraDepois = await req('GET', `/api/producao/obras/${projetoId}`);
    assert(obraDepois.body.obra.valorMedido === 0,
      'cancelar a medição devolve o valor medido da obra', obraDepois.body.obra.valorMedido);

    const previa = await req('GET', `/api/producao/obras/${projetoId}/medicao-previa`);
    assert(previa.body.itens.length === 1,
      'e o romaneio volta a ser medível (a medição cancelada não o bloqueia mais)', previa.body.itens);
  }

  // ═══ Cancelamento de obra ══════════════════════════════════════════════════
  secao('Cancelamento de obra com produção em andamento');
  {
    const naoCancela = await req('POST', `/api/producao/obras/${projetoId}/status`, { status: 'cancelada' });
    assert(naoCancela.status === 400 && /ordem/.test(naoCancela.body.error),
      'obra com OP já iniciada não é cancelada: o material saiu do estoque', naoCancela.body);

    const limpa = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Obra que não vingou' });
    const cancelada = await req('POST', `/api/producao/obras/${limpa.body.obra.id}/status`,
      { status: 'cancelada' });
    assert(cancelada.status === 200, 'obra sem produção pode ser cancelada');

    const item = await req('POST', `/api/producao/obras/${limpa.body.obra.id}/itens`,
      { produtoId: ids.pilar, quantidade: 1, valorUnitario: 100 });
    assert(item.status === 400 && /cancelada/.test(item.body.error),
      'obra cancelada tem os itens congelados', item.body);

    const opEmObraCancelada = await req('POST', '/api/producao/ordens', {
      produtoId: ids.pilar, quantidadePlanejada: 1, projetoId: limpa.body.obra.id,
    });
    assert(opEmObraCancelada.status === 400,
      'e não aceita nova ordem de produção', opEmObraCancelada.body);
  }

  // ═══ Regressões da auditoria ═══════════════════════════════════════════════
  secao('Regressão: projetoItemId cruzado');
  {
    // Achado: `projetoItemId` entrava sem validação, e o crédito de produção caía
    // no item de OUTRA obra — que depois ficava travado para edição.
    const outra = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Obra alheia' });
    await req('POST', `/api/producao/obras/${outra.body.obra.id}/status`, { status: 'contratada' });
    const itemAlheio = await req('POST', `/api/producao/obras/${outra.body.obra.id}/itens`,
      { produtoId: ids.bloco, quantidade: 100, valorUnitario: 5 });
    const itemAlheioId = itemAlheio.body.obra.itens[0].id;

    const cruzada = await req('POST', '/api/producao/ordens', {
      produtoId: ids.pilar, quantidadePlanejada: 1, projetoId, projetoItemId: itemAlheioId,
    });
    assert(cruzada.status === 400 && /pertence à obra/.test(cruzada.body.error),
      'item de outra obra é recusado: a produção creditaria a obra errada', cruzada.body);

    const outroProduto = await req('POST', '/api/producao/obras/' + outra.body.obra.id + '/itens',
      { produtoId: ids.pilar, quantidade: 2, valorUnitario: 2100 });
    const itemPilarOutra = outroProduto.body.obra.itens.find(i => i.produtoId === ids.pilar).id;
    const produtoErrado = await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 1,
      projetoId: outra.body.obra.id, projetoItemId: itemPilarOutra,
    });
    assert(produtoErrado.status === 400 && /outro produto/.test(produtoErrado.body.error),
      'item de outro produto na mesma obra também é recusado', produtoErrado.body);

    const inexistente = await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 1, projetoId: outra.body.obra.id, projetoItemId: 999999,
    });
    assert(inexistente.status === 400, 'projetoItemId inexistente é recusado');
  }

  secao('Regressão: dois itens do mesmo produto na obra');
  {
    // Achado: o UPDATE por (projetoId, produtoId) creditava a quantidade INTEIRA
    // em cada linha, e a prévia de medição precificava tudo pela primeira.
    const o = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Obra com aditivo' });
    const oid = o.body.obra.id;
    await req('POST', `/api/producao/obras/${oid}/status`, { status: 'contratada' });

    // Lote original a R$ 5, aditivo a R$ 7 — o caso real que impede um
    // UNIQUE(projetoId, produtoId).
    await req('POST', `/api/producao/obras/${oid}/itens`,
      { produtoId: ids.bloco, quantidade: 6, valorUnitario: 5 });
    await req('POST', `/api/producao/obras/${oid}/itens`,
      { produtoId: ids.bloco, quantidade: 10, valorUnitario: 7 });

    // Produz e entrega 10 blocos: 6 devem casar com o lote de R$ 5 e 4 com o
    // aditivo de R$ 7.
    const opId = (await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 10, dataPlanejada: '2026-09-20 07:00',
    })).body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`, { dataInicioProcesso: '2026-09-20 08:00' });
    await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    await req('POST', `/api/producao/ordens/${opId}/concluir`,
      { quantidadeProduzida: 10, dataConclusao: '2026-09-21 09:00' });

    const rom = (await req('POST', '/api/producao/romaneios',
      { projetoId: oid, data: '2026-09-22', capacidadeKg: 5000 })).body.romaneio.id;
    await req('POST', `/api/producao/romaneios/${rom}/itens`,
      { produtoId: ids.bloco, quantidade: 10 });
    await req('POST', `/api/producao/romaneios/${rom}/fechar`);
    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'transito' });
    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'entregue' });

    const sit = await req('GET', `/api/producao/obras/${oid}/situacao`);
    const entregues = sit.body.itens.map(i => i.quantidadeEntregue);
    assert(entregues[0] === 6 && entregues[1] === 4,
      '10 peças entregues preenchem 6 do primeiro item e 4 do segundo — não 10 em cada',
      entregues);

    const previa = await req('GET', `/api/producao/obras/${oid}/medicao-previa`);
    const fornec = previa.body.itens.filter(i => i.natureza === 'fornecimento');
    assert(fornec.length === 2, 'a prévia gera uma linha por item de obra atingido', fornec);
    assert(previa.body.valorTotal === 6 * 5 + 4 * 7,
      'e cada parte é precificada pelo SEU preço (6×5 + 4×7 = 58), não tudo pelo primeiro',
      { obtido: previa.body.valorTotal, esperado: 6 * 5 + 4 * 7 });

    // Mede as 10 primeiras: sobra saldo de 6 no contrato (16 contratados).
    const m1 = await req('POST', `/api/producao/obras/${oid}/medicoes`, { competencia: '2026-09' });
    assert(m1.status === 201 && m1.body.medicao.valorTotal === 58, 'medição das 10 primeiras', m1.body.medicao);

    // Agora entrega 8, mas só 6 cabem no que foi contratado.
    const rom2 = (await req('POST', '/api/producao/romaneios',
      { projetoId: oid, data: '2026-09-23', capacidadeKg: 5000 })).body.romaneio.id;
    await req('POST', `/api/producao/romaneios/${rom2}/itens`,
      { produtoId: ids.bloco, quantidade: 8 });
    await req('POST', `/api/producao/romaneios/${rom2}/fechar`);
    await req('POST', `/api/producao/romaneios/${rom2}/status`, { status: 'transito' });
    await req('POST', `/api/producao/romaneios/${rom2}/status`, { status: 'entregue' });

    const previa2 = await req('GET', `/api/producao/obras/${oid}/medicao-previa`);
    const medivel = previa2.body.itens.filter(i => i.natureza === 'fornecimento')
      .reduce((s, i) => s + i.quantidade, 0);
    assert(medivel === 6, 'das 8 entregues, só 6 cabem no saldo contratado', medivel);
    assert((previa2.body.naoContratados || []).some(x => x.quantidade === 2),
      'as 2 excedentes aparecem em naoContratados em vez de virar receita inventada',
      previa2.body.naoContratados);
    assert(previa2.body.naoContratados[0].motivo === 'entregue acima do contratado',
      'com o motivo explícito', previa2.body.naoContratados);
  }

  secao('Regressão: a peça acabada sai do estoque na entrega');
  {
    // Achado: `concluir` dava entrada e nada dava saída — o saldo do produto
    // acabado só crescia, e o pátio mostrava peças já entregues.
    const saldoAntes = u.saldo(db, ids.bloco);

    const o = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Obra da baixa de estoque' });
    const oid = o.body.obra.id;
    await req('POST', `/api/producao/obras/${oid}/status`, { status: 'contratada' });
    await req('POST', `/api/producao/obras/${oid}/itens`,
      { produtoId: ids.bloco, quantidade: 20, valorUnitario: 5 });

    const opId = (await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 20, dataPlanejada: '2026-10-01 07:00',
    })).body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`, { dataInicioProcesso: '2026-10-01 08:00' });
    await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    await req('POST', `/api/producao/ordens/${opId}/concluir`,
      { quantidadeProduzida: 20, dataConclusao: '2026-10-02 09:00' });

    assert(u.saldo(db, ids.bloco) === saldoAntes + 20,
      'a conclusão dá entrada das 20 peças', u.saldo(db, ids.bloco));

    const rom = (await req('POST', '/api/producao/romaneios',
      { projetoId: oid, data: '2026-10-03', capacidadeKg: 5000 })).body.romaneio.id;
    await req('POST', `/api/producao/romaneios/${rom}/itens`,
      { produtoId: ids.bloco, quantidade: 20 });
    await req('POST', `/api/producao/romaneios/${rom}/fechar`);
    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'transito' });

    assert(u.saldo(db, ids.bloco) === saldoAntes + 20,
      'carga em trânsito ainda é da fábrica: o estoque não muda', u.saldo(db, ids.bloco));

    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'entregue' });
    assert(u.saldo(db, ids.bloco) === saldoAntes,
      'a ENTREGA dá a saída: o saldo volta ao que era antes de produzir',
      { antes: saldoAntes, depois: u.saldo(db, ids.bloco) });

    const mov = db.prepare(
      "SELECT * FROM movimentacoes_estoque WHERE origem = 'prod_romaneio' AND origemId = ?"
    ).get(rom);
    assert(mov && mov.tipo === 'saida' && mov.quantidade === 20,
      'com origem prod_romaneio, rastreável até a carga', mov);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(mov.data),
      'e com `data` pura, igual ao core', mov && mov.data);
  }

  secao('Regressão: o crédito segue o item da OP, não o FIFO');
  {
    // Achado da 2ª auditoria: a peça sabe a qual item de obra pertence
    // (prod_ordens.projetoItemId), mas o crédito ia por FIFO — a peça produzida para
    // o aditivo de R$1.500 era medida pelo lote original de R$1.000, e o
    // painel dizia que ela ainda faltava entregar. Para sempre.
    const o = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Obra do vínculo por item' });
    const oid = o.body.obra.id;
    await req('POST', `/api/producao/obras/${oid}/status`, { status: 'contratada' });

    const i1 = await req('POST', `/api/producao/obras/${oid}/itens`,
      { produtoId: ids.pilar, quantidade: 2, valorUnitario: 1000 });
    const item1 = i1.body.obra.itens[0].id;
    const i2 = await req('POST', `/api/producao/obras/${oid}/itens`,
      { produtoId: ids.pilar, quantidade: 2, valorUnitario: 1500 });
    const item2 = i2.body.obra.itens[1].id;

    // OP amarrada ao SEGUNDO item (o aditivo).
    const opId = (await req('POST', '/api/producao/ordens', {
      produtoId: ids.pilar, quantidadePlanejada: 2, projetoId: oid, projetoItemId: item2,
      dataPlanejada: '2026-10-10 07:00',
    })).body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`, { dataInicioProcesso: '2026-10-10 08:00' });
    await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    const fim = await req('POST', `/api/producao/ordens/${opId}/concluir`,
      { quantidadeProduzida: 2, dataConclusao: '2026-10-11 09:00', identificacoes: ['A-01', 'A-02'] });
    const pecas = fim.body.op.pecasProduzidas;

    const rom = (await req('POST', '/api/producao/romaneios',
      { projetoId: oid, data: '2026-10-12', capacidadeKg: 10000 })).body.romaneio.id;
    for (const p of pecas) {
      await req('POST', `/api/producao/romaneios/${rom}/itens`, { unidadeId: p.id });
    }
    await req('POST', `/api/producao/romaneios/${rom}/fechar`);
    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'transito' });
    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'entregue' });

    const sit = await req('GET', `/api/producao/obras/${oid}/situacao`);
    const l1 = sit.body.itens.find(i => i.id === item1);
    const l2 = sit.body.itens.find(i => i.id === item2);
    assert(l1.quantidadeEntregue === 0 && l2.quantidadeEntregue === 2,
      'o crédito cai no item ao qual a OP foi amarrada, não no primeiro da lista',
      { item1: l1.quantidadeEntregue, item2: l2.quantidadeEntregue });
    assert(l2.saldoAEntregar === 0,
      'e o item do aditivo não fica eternamente "a entregar"', l2.saldoAEntregar);

    const previa = await req('GET', `/api/producao/obras/${oid}/medicao-previa`);
    assert(previa.body.valorTotal === 2 * 1500,
      'a medição usa o preço do aditivo (R$ 3.000), não o do lote original',
      previa.body.valorTotal);
  }

  secao('Regressão: medição parcial não queima o resto do romaneio');
  {
    // Achado da 2ª auditoria: o NOT EXISTS excluía o romaneio inteiro se
    // QUALQUER linha dele fosse medida. Numa medição parcial, a sobra saía da
    // fábrica e nunca mais podia ser faturada — nem após aditivo.
    const o = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Obra da medição parcial' });
    const oid = o.body.obra.id;
    await req('POST', `/api/producao/obras/${oid}/status`, { status: 'contratada' });
    const it = await req('POST', `/api/producao/obras/${oid}/itens`,
      { produtoId: ids.bloco, quantidade: 6, valorUnitario: 5 });
    const itemId = it.body.obra.itens[0].id;

    const opId = (await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 10, dataPlanejada: '2026-10-15 07:00',
    })).body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`, { dataInicioProcesso: '2026-10-15 08:00' });
    await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    await req('POST', `/api/producao/ordens/${opId}/concluir`,
      { quantidadeProduzida: 10, dataConclusao: '2026-10-16 09:00' });

    const rom = (await req('POST', '/api/producao/romaneios',
      { projetoId: oid, data: '2026-10-17', capacidadeKg: 5000 })).body.romaneio.id;
    await req('POST', `/api/producao/romaneios/${rom}/itens`,
      { produtoId: ids.bloco, quantidade: 10 });
    await req('POST', `/api/producao/romaneios/${rom}/fechar`);
    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'transito' });
    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'entregue' });

    const m1 = await req('POST', `/api/producao/obras/${oid}/medicoes`, { competencia: '2026-10' });
    assert(m1.status === 201 && m1.body.medicao.valorTotal === 30,
      'a primeira medição fatura só as 6 contratadas', m1.body.medicao.valorTotal);

    // Aditivo: o contrato sobe para 10.
    await req('PUT', `/api/producao/obras/${oid}/itens/${itemId}`,
      { produtoId: ids.bloco, quantidade: 10, valorUnitario: 5 });

    const previa = await req('GET', `/api/producao/obras/${oid}/medicao-previa`);
    assert(previa.body.itens.length > 0,
      'depois do aditivo, as 4 restantes do MESMO romaneio voltam a ser medíveis',
      previa.body);
    assert(previa.body.valorTotal === 4 * 5,
      'e valem exatamente as 4 que sobraram', previa.body.valorTotal);
  }

  secao('Regressão: obra cancelada não recebe entrega nem medição');
  {
    const o = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Obra a cancelar' });
    const oid = o.body.obra.id;
    await req('POST', `/api/producao/obras/${oid}/status`, { status: 'contratada' });

    const rom = (await req('POST', '/api/producao/romaneios',
      { projetoId: oid, data: '2026-10-20', capacidadeKg: 5000 })).body.romaneio.id;
    await req('POST', `/api/producao/romaneios/${rom}/itens`,
      { produtoId: ids.bloco, quantidade: 2 });
    await req('POST', `/api/producao/romaneios/${rom}/fechar`);
    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'transito' });

    const cancelar = await req('POST', `/api/producao/obras/${oid}/status`, { status: 'cancelada' });
    assert(cancelar.status === 400 && /romaneio\(s\) em aberto/.test(cancelar.body.error),
      'cancelar a obra com carga na estrada é recusado — a entrega chegaria a uma obra morta',
      cancelar.body);
  }

  secao('Regressão: peça de obra não embarca em romaneio sem obra');
  {
    const o = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Obra da peça órfã' });
    const oid = o.body.obra.id;
    await req('POST', `/api/producao/obras/${oid}/status`, { status: 'contratada' });
    await req('POST', `/api/producao/obras/${oid}/itens`,
      { produtoId: ids.pilar, quantidade: 1, valorUnitario: 2100 });

    const opId = (await req('POST', '/api/producao/ordens', {
      produtoId: ids.pilar, quantidadePlanejada: 1, projetoId: oid, dataPlanejada: '2026-10-25 07:00',
    })).body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`, { dataInicioProcesso: '2026-10-25 08:00' });
    await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    const fim = await req('POST', `/api/producao/ordens/${opId}/concluir`,
      { quantidadeProduzida: 1, dataConclusao: '2026-10-26 09:00', identificacoes: ['ORF-01'] });
    const peca = fim.body.op.pecasProduzidas[0];

    const semObra = (await req('POST', '/api/producao/romaneios',
      { data: '2026-10-27', capacidadeKg: 5000 })).body.romaneio.id;
    const r = await req('POST', `/api/producao/romaneios/${semObra}/itens`,
      { unidadeId: peca.id });
    assert(r.status === 400 && /precisa ser dessa obra/.test(r.body.error),
      'peça de obra em romaneio sem obra é recusada: a entrega não seria creditada a ninguém',
      r.body);
  }

  secao('Regressão: itens da obra e carga em trânsito');
  {
    const o = await req('POST', '/api/producao/obras',
      { clienteId: ids.cliente, nome: 'Obra das guardas de item' });
    const oid = o.body.obra.id;
    await req('POST', `/api/producao/obras/${oid}/status`, { status: 'contratada' });
    const it = await req('POST', `/api/producao/obras/${oid}/itens`,
      { produtoId: ids.bloco, quantidade: 10, valorUnitario: 5 });
    const itemId = it.body.obra.itens[0].id;

    const opId = (await req('POST', '/api/producao/ordens', {
      produtoId: ids.bloco, quantidadePlanejada: 10, dataPlanejada: '2026-11-01 07:00',
    })).body.op.id;
    await req('POST', `/api/producao/ordens/${opId}/liberar`);
    await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`, { dataInicioProcesso: '2026-11-01 08:00' });
    await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    await req('POST', `/api/producao/ordens/${opId}/concluir`,
      { quantidadeProduzida: 10, dataConclusao: '2026-11-02 09:00' });

    const rom = (await req('POST', '/api/producao/romaneios',
      { projetoId: oid, data: '2026-11-03', capacidadeKg: 5000 })).body.romaneio.id;
    await req('POST', `/api/producao/romaneios/${rom}/itens`,
      { produtoId: ids.bloco, quantidade: 10 });
    await req('POST', `/api/producao/romaneios/${rom}/fechar`);
    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'transito' });

    // A volta do caminhão: carga recusada na obra.
    const voltou = await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'carregado' });
    assert(voltou.status === 200,
      'trânsito volta para carregado — carga recusada na obra tem caminho de volta', voltou.body);

    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'transito' });
    await req('POST', `/api/producao/romaneios/${rom}/status`, { status: 'entregue' });

    const reduzir = await req('PUT', `/api/producao/obras/${oid}/itens/${itemId}`,
      { produtoId: ids.bloco, quantidade: 2, valorUnitario: 5 });
    assert(reduzir.status === 400 && /entregue\(s\)/.test(reduzir.body.error),
      'reduzir o contrato abaixo do que já foi ENTREGUE é recusado (dava 500% na tela)',
      reduzir.body);

    const remover = await req('DELETE', `/api/producao/obras/${oid}/itens/${itemId}`);
    assert(remover.status === 400 && /entregue\(s\)/.test(remover.body.error),
      'e remover o item com entrega registrada também', remover.body);
  }

  secao('Regressão: reordenar com item de outro romaneio');
  {
    const rom = (await req('POST', '/api/producao/romaneios',
      { data: '2026-11-10', capacidadeKg: 5000 })).body.romaneio.id;
    await req('POST', `/api/producao/romaneios/${rom}/itens`,
      { produtoId: ids.bloco, quantidade: 1 });
    const r = await req('PUT', `/api/producao/romaneios/${rom}/ordem`,
      { ordem: [{ itemId: 999999, sequencia: 1 }] });
    assert(r.status === 400 && /não pertence a este romaneio/.test(r.body.error),
      'reordenar com itemId de outro romaneio devolve erro em vez de 200 silencioso', r.body);
  }

  servidor.close();
  db.close();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`F2: ${ok} passaram, ${fail} falharam`);
  if (fail) {
    console.log('\nFalhas:');
    falhas.forEach(f => console.log(`  - ${f}`));
  }
  console.log(`banco descartável: ${caminho}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO FATAL:', e.stack); process.exit(1); });
