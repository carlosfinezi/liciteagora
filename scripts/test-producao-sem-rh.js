#!/usr/bin/env node
/**
 * test-producao-sem-rh.js — o módulo em tenant SEM o módulo de RH.
 *
 * Por que existe: `funcionarios` e `funcionarios_ponto` são criadas pelo
 * migrarDB do rh-routes, que é no-op em multi-tenant para tenant já existente.
 * Levantado em 2026-08-27: `crsolucoes` e `pccontabilidade` não têm nenhuma das
 * duas. O painel de produtividade — a F1.9, a dor declarada do prospect — lê as
 * duas, e sem guarda devolvia 500 e derrubava a tela inteira.
 *
 * Aqui o banco descartável é montado e as tabelas são REMOVIDAS antes de
 * exercitar o módulo. O contrato testado é: degrada com aviso, nunca 500.
 *
 * Uso: node scripts/test-producao-sem-rh.js
 */

const u = require('./producao-teste-util');

let ok = 0, fail = 0;
const falhas = [];
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else {
    fail++; falhas.push(msg);
    console.error(`  ✗ ${msg}${extra !== undefined ? '\n      ' + JSON.stringify(extra).slice(0, 400) : ''}`);
  }
}
function secao(t) { console.log(`\n── ${t}`); }

(async () => {
  const { db, servidor, porta } = await u.montar();
  const ids = u.seed(db);
  u.ligarFlag(db);

  const req = async (m, r, b) => {
    const x = await fetch(`http://127.0.0.1:${porta}${r}`, {
      method: m, headers: { 'content-type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    return { status: x.status, body: await x.json() };
  };

  // Massa mínima e uma equipe ATIVA — é a equipe que faz o painel consultar o
  // ponto. Sem equipe o bug não aparecia.
  await req('PUT', `/api/producao/pecas/${ids.bloco}`, {
    modo: 'estoque', quantidadeBase: 0.01, pesoKg: 12,
    tempoProcessoHoras: 24, unidadesPorCiclo: 40,
  });
  await req('POST', `/api/producao/pecas/${ids.bloco}/ficha`,
    { insumoProdutoId: ids.cimento, quantidade: 1.5, unidade: 'KG', perdaPercentual: 4, grupo: 'concreto' });
  const eq = await req('POST', '/api/producao/equipes', { nome: 'Equipe sem RH' });
  const equipeId = eq.body.equipe.id;
  await req('PUT', `/api/producao/equipes/${equipeId}/membros`, { funcionarioIds: ids.funcionarios });

  const opId = (await req('POST', '/api/producao/ordens', {
    produtoId: ids.bloco, quantidadePlanejada: 40, dataPlanejada: '2026-08-20 07:00',
  })).body.op.id;
  await req('POST', `/api/producao/ordens/${opId}/liberar`);
  await req('POST', `/api/producao/ordens/${opId}/apontamentos`,
    { etapa: 'processo', data: '2026-08-20', equipeId, horas: 6 });

  // ─── A simulação: tenant sem o módulo de RH ────────────────────────────────
  secao('Tenant sem funcionarios / funcionarios_ponto');
  db.exec('DROP TABLE IF EXISTS funcionarios_ponto');
  db.exec('DROP TABLE IF EXISTS funcionarios');
  assert(!db.prepare("SELECT name FROM sqlite_master WHERE name = 'funcionarios'").get(),
    'as tabelas do RH foram removidas (simula crsolucoes / pccontabilidade)');

  {
    const r = await req('GET', '/api/producao/produtividade/resumo?de=2026-08-01&ate=2026-08-31');
    assert(r.status === 200, 'produtividade/resumo responde 200 (era 500)', r.body);
    assert((r.body.avisos || []).some(a => /RH não está instalado/.test(a)),
      'e avisa que o RH não está instalado, em vez de calar', r.body.avisos);
  }
  {
    const r = await req('GET', '/api/producao/produtividade/equipes?de=2026-08-01&ate=2026-08-31');
    assert(r.status === 200, 'produtividade/equipes responde 200', r.body);
    const linha = (r.body.equipes || []).find(e => e.equipeId === equipeId);
    assert(linha && linha.fonteHomemHora === 'apontamento_sem_rh',
      'a fonte do homem-hora é marcada como "apontamento_sem_rh"', linha);
    assert(linha && linha.homemHora > 0,
      'e o cálculo cai no apontamento em vez de zerar', linha && linha.homemHora);
  }
  {
    const r = await req('GET', '/api/producao/produtividade/individual?de=2026-08-01&ate=2026-08-31');
    assert(r.status === 200 && Array.isArray(r.body.linhas) && r.body.linhas.length === 0,
      'produtividade/individual devolve lista vazia, não 500', r.body);
  }
  {
    const r = await req('GET', `/api/producao/equipes/${equipeId}/membros`);
    assert(r.status === 200, 'listar membros responde 200', r.body);
    assert((r.body.membros || []).length === 4,
      'e devolve os vínculos, mesmo sem o nome do funcionário', r.body.membros && r.body.membros.length);
  }
  {
    const r = await req('POST', `/api/producao/ordens/${opId}/apontamentos`,
      { etapa: 'preparacao', data: '2026-08-21', funcionarioId: 1, horas: 4, quantidadeProduzida: 10 });
    assert(r.status === 400 && /módulo de RH/.test(r.body.error),
      'apontamento individual explica que precisa do RH, em vez de estourar 500', r.body);
  }
  {
    const r = await req('PUT', `/api/producao/equipes/${equipeId}/membros`, { funcionarioIds: [1, 2] });
    assert(r.status === 400 && /módulo de RH/.test(r.body.error),
      'montar equipe também explica a dependência', r.body);
  }
  {
    // O resto do módulo não depende de RH: tem de seguir funcionando inteiro.
    const r = await req('POST', `/api/producao/ordens/${opId}/iniciar-processo`,
      { dataInicioProcesso: '2026-08-20 08:00' });
    assert(r.status === 200, 'a produção segue funcionando sem RH: concretagem OK', r.body);
    const d = await req('POST', `/api/producao/ordens/${opId}/liberar-saida`, {});
    assert(d.status === 200, 'liberação de desforma OK');
    const f = await req('POST', `/api/producao/ordens/${opId}/concluir`, { quantidadeProduzida: 40 });
    assert(f.status === 200, 'conclusão OK — o custo de mão de obra apenas fica sem base');
  }
  {
    const r = await req('GET', `/api/producao/ordens/${opId}/custo`);
    assert(r.status === 200, 'o custo da OP responde 200 sem RH', r.body);
    assert(r.body.custoInsumo > 0, 'com o custo de insumo inteiro', r.body.custoInsumo);
  }
  {
    const r = await req('GET', '/api/producao/produtividade/formas?de=2026-08-01&ate=2026-08-31');
    assert(r.status === 200, 'o indicador de forma não depende de RH', r.body);
  }

  servidor.close();
  db.close();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Sem RH: ${ok} passaram, ${fail} falharam`);
  if (fail) { console.log('\nFalhas:'); falhas.forEach(f => console.log(`  - ${f}`)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO FATAL:', e.stack); process.exit(1); });
