#!/usr/bin/env node
/**
 * test-locacao-f6.js — Fase 6: manutenção por uso e indicadores.
 *
 * Provas que importam:
 *  1. o plano vence por USO acumulado (horímetro/km), não por calendário;
 *  2. executar a manutenção TIRA o ativo da disponibilidade — o bloqueio é o
 *     mecanismo, e a F2 o enxerga sem regra especial;
 *  3. a taxa de ocupação usa o saldo físico como denominador (3 máquinas com
 *     1 alugada = 33%, não 100%) e recorta locações que atravessam a janela.
 *
 * Uso: node scripts/test-locacao-f6.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const express = require(BASE + '/node_modules/express');

const { initLocacaoSchema } = require(BASE + '/locacao/locacao-schema');
const { protegerConfig } = require('./locacao-teste-util');
const { registrarRotasLocacao } = require(BASE + '/locacao/locacao-routes');
const D = require(BASE + '/locacao/disponibilidade');
const M = require(BASE + '/locacao/manutencao');

const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

// Devolve toda chave `locacao_*` ao estado original na saída do processo —
// inclusive se este teste estourar no meio. Ver locacao-teste-util.js.
protegerConfig(db);
initLocacaoSchema(db);

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function eq(a, b, msg) { assert(a === b, msg, `esperado ${b}, veio ${a}`); }
function perto(a, b, msg, tol = 0.5) {
  assert(Math.abs(a - b) <= tol, msg, `esperado ~${b}, veio ${a}`);
}
function secao(t) { console.log(`\n── ${t}`); }

// ─── Cenário ──────────────────────────────────────────────────────────────────
const SKU = 'TESTE-LOC-F6';
const PREFIXO_NUM = 'TSTF6';

function limpar() {
  const contratos = db.prepare('SELECT id, numero FROM locacao_contratos WHERE numero LIKE ?').all(PREFIXO_NUM + '%');
  for (const c of contratos) {
    db.prepare('DELETE FROM contas_a_receber WHERE observacoes LIKE ?').run(`%${c.numero}%`);
    db.prepare("DELETE FROM locacao_reservas WHERE documentoTipo='locacao' AND documentoId = ?").run(c.id);
    db.prepare('DELETE FROM locacao_faturamentos WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_acertos WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_itens WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_eventos WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_contratos WHERE id = ?').run(c.id);
  }
  const ids = db.prepare('SELECT id FROM produtos WHERE sku LIKE ?').all(SKU + '%').map(r => r.id);
  for (const id of ids) {
    const bloqs = db.prepare('SELECT osId FROM locacao_bloqueios WHERE produtoId = ? AND osId IS NOT NULL').all(id);
    for (const b of bloqs) db.prepare('DELETE FROM os_ordens WHERE id = ?').run(b.osId);
    db.prepare('DELETE FROM locacao_bloqueios WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_manutencao_planos WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_medidor_leituras WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_reservas WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_item_specs WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_tarifas WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM movimentacoes_estoque WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
  }
}
limpar();

function criarProduto(sufixo, descricao, qtd, medidorTipo) {
  const id = db.prepare(`
    INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo) VALUES (?, ?, 'UN', 0, 1)
  `).run(SKU + sufixo, descricao).lastInsertRowid;
  const cols = db.prepare('PRAGMA table_info(movimentacoes_estoque)').all().map(c => c.name);
  const campos = ['produtoId', 'tipo', 'quantidade'].concat(cols.includes('data') ? ['data'] : []);
  const vals = [id, 'entrada', qtd].concat(cols.includes('data') ? ['2026-01-01 00:00:00'] : []);
  db.prepare(`INSERT INTO movimentacoes_estoque (${campos.join(',')})
              VALUES (${campos.map(() => '?').join(',')})`).run(...vals);
  db.prepare(`INSERT INTO locacao_item_specs (produtoId, alugavel, exigeSerie, medidorTipo, franquiaPorDia)
              VALUES (?, 1, 0, ?, NULL)`).run(id, medidorTipo);
  db.prepare("INSERT INTO locacao_tarifas (produtoId, faixa, valor, minimoFaturavel) VALUES (?, 'dia', 100, 1)").run(id);
  return id;
}

const prodMaq = criarProduto('-M', 'Rolo compactador (teste F6)', 3, 'horimetro');
const prodSimples = criarProduto('-S', 'Mesa (teste F6)', 4, 'nenhum');

const cliente = db.prepare('SELECT id FROM pessoas LIMIT 1').get();

const app = express();
app.use(express.json());
registrarRotasLocacao(app, db);

function chamar(p, m, o = {}) {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  let out = null, st = 200;
  const res = { json: x => { out = x; return res; }, status: c => { st = c; return res; } };
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, headers: {}, user: o.user };
  let i = 0;
  const next = () => { const h = l.route.stack[i++]; if (h) h.handle(req, res, next); };
  next();
  return { out, st };
}

const cfgOriginal = {};
for (const k of ['locacao_enabled', 'locacao_prefixo_numero', 'locacao_exigir_vistoria']) {
  cfgOriginal[k] = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k);
}
const setCfg = (k, v) => db.prepare(`INSERT INTO config (chave, valor) VALUES (?, ?)
  ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(k, String(v));
setCfg('locacao_enabled', '1');
setCfg('locacao_prefixo_numero', PREFIXO_NUM);
setCfg('locacao_exigir_vistoria', '0');

// ─── Planos ───────────────────────────────────────────────────────────────────
secao('Cadastro de planos de manutenção');

let r = chamar('/api/locacao/manutencao/planos', 'post', {
  body: { produtoId: prodMaq, descricao: 'Troca de óleo', tipo: 'horimetro', intervalo: 250 },
});
assert(r.st === 200 && r.out.plano.id, 'plano por horímetro criado', JSON.stringify(r.out.error));
const planoId = r.out.plano.id;

r = chamar('/api/locacao/manutencao/planos', 'post', {
  body: { produtoId: prodSimples, descricao: 'Revisão', tipo: 'horimetro', intervalo: 100 },
});
assert(r.st === 400 && /medidor/.test(r.out.error || ''),
  'plano por horímetro em produto sem medidor é recusado', JSON.stringify(r.out));

r = chamar('/api/locacao/manutencao/planos', 'post', {
  body: { produtoId: prodSimples, descricao: 'Verniz anual', tipo: 'dias', intervalo: 365 },
});
assert(r.st === 200, 'plano por dias funciona em produto sem medidor');
const planoDias = r.out.plano.id;

r = chamar('/api/locacao/manutencao/planos', 'post', {
  body: { produtoId: prodMaq, descricao: 'x', tipo: 'lua_cheia', intervalo: 1 },
});
assert(r.st === 400, 'tipo de plano inválido é recusado');

r = chamar('/api/locacao/manutencao/planos', 'post', {
  body: { produtoId: prodMaq, descricao: 'x', tipo: 'horimetro', intervalo: 0 },
});
assert(r.st === 400, 'intervalo zero é recusado');

r = chamar('/api/locacao/manutencao/planos', 'post', {
  body: { produtoId: prodMaq, tipo: 'horimetro', intervalo: 100 },
});
assert(r.st === 400, 'plano sem descrição é recusado');

// ─── Leituras e vencimento por uso ────────────────────────────────────────────
secao('O plano vence por uso acumulado, não por calendário');

r = chamar('/api/locacao/manutencao/planos', 'get');
let plano = r.out.planos.find(p => p.id === planoId);
assert(plano.situacao.vencido === false, 'sem leitura, o plano não está vencido');
assert(/sem leitura/.test(plano.situacao.motivo || ''), 'e diz por quê', JSON.stringify(plano.situacao));

r = chamar('/api/locacao/manutencao/leitura', 'post', {
  body: { produtoId: prodMaq, valor: 100, tipo: 'horimetro' },
});
assert(r.st === 200 && r.out.atual === 100, 'leitura registrada');

r = chamar('/api/locacao/manutencao/leitura', 'post', {
  body: { produtoId: prodMaq, valor: 50, tipo: 'horimetro' },
});
assert(r.st === 400 && /não retrocede/.test(r.out.error || ''),
  'leitura menor que a anterior é recusada', JSON.stringify(r.out));

r = chamar('/api/locacao/manutencao/planos', 'get');
plano = r.out.planos.find(p => p.id === planoId);
eq(plano.situacao.atual, 100, 'situação usa a última leitura');
eq(plano.situacao.restante, 150, 'faltam 150h para os 250h do intervalo');
assert(plano.situacao.vencido === false, '100h de 250h ainda não vence');
perto(plano.situacao.percentual, 40, 'percentual de 40%');

r = chamar('/api/locacao/manutencao/leitura', 'post', { body: { produtoId: prodMaq, valor: 260 } });
r = chamar('/api/locacao/manutencao/planos', 'get');
plano = r.out.planos.find(p => p.id === planoId);
assert(plano.situacao.vencido === true, '260h passa dos 250h → vencido');
assert(r.out.planos[0].id === planoId, 'vencidos aparecem primeiro na lista');

// ─── Executar manutenção bloqueia a agenda ────────────────────────────────────
secao('Executar a manutenção tira o ativo da disponibilidade');

let d = D.disponibilidade(db, prodMaq, '2026-09-10 08:00', '2026-09-12 08:00');
eq(d.disponivel, 3, 'antes da manutenção, 3 unidades livres');

r = chamar('/api/locacao/manutencao/planos/:id/executar', 'post', {
  params: { id: planoId }, body: { inicio: '2026-09-10 08:00' },
});
assert(r.st === 400 && /fim previsto/.test(r.out.error || ''),
  'executar sem fim previsto é recusado (é ele que bloqueia)', JSON.stringify(r.out));

r = chamar('/api/locacao/manutencao/planos/:id/executar', 'post', {
  params: { id: planoId }, body: { inicio: '2026-09-10 08:00', fim: '2026-09-12 18:00' },
});
assert(r.st === 400 && /clienteId/.test(r.out.error || ''),
  'executar sem clienteId é recusado com explicação (os_ordens.clienteId é NOT NULL)',
  JSON.stringify(r.out));

r = chamar('/api/locacao/manutencao/planos/:id/executar', 'post', {
  params: { id: planoId },
  body: { inicio: '2026-09-10 08:00', fim: '2026-09-12 18:00', clienteId: 99999999 },
});
assert(r.st === 400, 'clienteId inexistente é recusado antes de tocar na FK');

r = chamar('/api/locacao/manutencao/planos/:id/executar', 'post', {
  params: { id: planoId },
  body: { inicio: '2026-09-10 08:00', fim: '2026-09-12 18:00', clienteId: cliente.id },
});
assert(r.st === 200 && r.out.os.id, 'manutenção abre OS', JSON.stringify(r.out.error));
assert(/^OS-2026-/.test(r.out.os.numero), 'OS usa a numeração do módulo de OS', r.out.os.numero);
assert(!!r.out.bloqueio.id, 'e grava o bloqueio');
eq(r.out.bloqueio.dataFim, '2026-09-12 18:00:00', 'bloqueio cobre o período informado');

d = D.disponibilidade(db, prodMaq, '2026-09-11 08:00', '2026-09-12 08:00');
eq(d.bloqueado, 1, 'a F2 enxerga o bloqueio sem regra especial');
eq(d.disponivel, 2, 'sobram 2 das 3 unidades durante a manutenção');

d = D.disponibilidade(db, prodMaq, '2026-09-20 08:00', '2026-09-21 08:00');
eq(d.disponivel, 3, 'fora do período da manutenção, as 3 voltam');

// O contador zerou
r = chamar('/api/locacao/manutencao/planos', 'get');
plano = r.out.planos.find(p => p.id === planoId);
eq(plano.ultimoValor, 260, 'contador do plano reiniciou na leitura atual');
assert(plano.situacao.vencido === false, 'depois da manutenção, o plano não está mais vencido');
eq(plano.situacao.desdeUltima, 0, 'zero horas desde a última manutenção');

// Mais 250h → vence de novo
chamar('/api/locacao/manutencao/leitura', 'post', { body: { produtoId: prodMaq, valor: 520 } });
r = chamar('/api/locacao/manutencao/planos', 'get');
plano = r.out.planos.find(p => p.id === planoId);
assert(plano.situacao.vencido === true, 'depois de mais 260h, vence de novo');

// Plano por dias
r = chamar('/api/locacao/manutencao/planos', 'get', { query: { hoje: '2028-01-01' } });
const pd = r.out.planos.find(p => p.id === planoDias);
assert(pd.situacao.vencido === true, 'plano por dias vence pelo calendário');
eq(pd.situacao.tipo, 'dias', 'situação identifica o tipo dias');

// Desativar
r = chamar('/api/locacao/manutencao/planos/:id', 'delete', { params: { id: planoDias } });
assert(r.st === 200, 'plano desativado');
r = chamar('/api/locacao/manutencao/planos/:id', 'delete', { params: { id: planoDias } });
assert(r.st === 404, 'desativar duas vezes é 404');
r = chamar('/api/locacao/manutencao/planos', 'get');
assert(!r.out.planos.some(p => p.id === planoDias), 'plano inativo some da lista');

// ─── Ocupação ─────────────────────────────────────────────────────────────────
secao('Taxa de ocupação usa o saldo físico como denominador');

// Uma locação de 10 dias de 1 unidade, num produto com 3 unidades.
function novaLocacaoConfirmada(saida, retorno, produtoId, qtd) {
  const rr = chamar('/api/locacao/locacoes', 'post', {
    body: { clienteId: cliente.id, dataSaidaPrevista: saida, dataRetornoPrevisto: retorno },
  });
  const id = rr.out.contrato.id;
  chamar('/api/locacao/locacoes/:id/itens', 'post', {
    params: { id }, body: { produtoId, quantidade: qtd },
  });
  chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id } });
  return id;
}

// Período de análise: 01/10 a 31/10 (30 dias). Capacidade = 30 × 3 = 90 dias-unidade.
novaLocacaoConfirmada('2026-10-01 00:00', '2026-10-11 00:00', prodMaq, 1); // 10 dias-unidade

let oc = M.ocupacao(db, '2026-10-01', '2026-10-31');
let linha = oc.linhas.find(l => l.produtoId === Number(prodMaq));
eq(linha.unidades, 3, 'denominador usa as 3 unidades em estoque');
perto(linha.diasOcupados, 10, '10 dias-unidade ocupados');
perto(linha.capacidadeDiasUnidade, 90, 'capacidade de 90 dias-unidade');
perto(linha.taxaOcupacao, 11.1, 'taxa ~11% (não 33%, e muito menos 100%)');

// Mais uma locação, agora de 2 unidades por 15 dias = 30 dias-unidade
novaLocacaoConfirmada('2026-10-05 00:00', '2026-10-20 00:00', prodMaq, 2);
oc = M.ocupacao(db, '2026-10-01', '2026-10-31');
linha = oc.linhas.find(l => l.produtoId === Number(prodMaq));
perto(linha.diasOcupados, 40, '10 + 30 = 40 dias-unidade');
perto(linha.taxaOcupacao, 44.4, 'taxa sobe para ~44%');

// Locação que ATRAVESSA a janela só conta o pedaço de dentro.
novaLocacaoConfirmada('2026-09-20 00:00', '2026-10-06 00:00', prodSimples, 1);
oc = M.ocupacao(db, '2026-10-01', '2026-10-31');
const linhaS = oc.linhas.find(l => l.produtoId === Number(prodSimples));
perto(linhaS.diasOcupados, 5, 'só os 5 dias dentro de outubro contam (não os 16 totais)');

// Ociosos
assert(oc.resumo.ativos >= 2, 'resumo conta os ativos');
assert(typeof oc.resumo.taxaMedia === 'number', 'resumo traz a taxa média');

secao('REGRESSÃO: receita por ativo não pode ser inflada pelo JOIN');
// O cálculo antigo fazia JOIN com locacao_itens: uma linha por item
// multiplicava o faturamento, e o valor atribuído era o valorLocacao INTEIRO
// do contrato. Um contrato com 2 itens do mesmo produto dobrava a receita; um
// com dois produtos diferentes dava o total cheio a CADA um, e o resumo
// somava o dobro do que foi faturado. Agora a receita é rateada pelo peso do
// ativo no contrato.
const locR = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-08-01 08:00', dataRetornoPrevisto: '2026-08-05 08:00' },
}).out.contrato.id;
// Dois itens do MESMO produto (4 diárias × 100 cada = 400 + 400 = 800)
chamar('/api/locacao/locacoes/:id/itens', 'post', { params: { id: locR }, body: { produtoId: prodMaq, quantidade: 1 } });
chamar('/api/locacao/locacoes/:id/itens', 'post', { params: { id: locR }, body: { produtoId: prodMaq, quantidade: 1 } });
chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: locR } });
chamar('/api/locacao/locacoes/:id/entregar', 'post', { params: { id: locR }, body: { dataSaidaReal: '2026-08-01 08:00' } });
chamar('/api/locacao/locacoes/:id/devolver', 'post', { params: { id: locR }, body: { dataRetornoReal: '2026-08-05 08:00' } });
const fatR = chamar('/api/locacao/locacoes/:id/faturar', 'post', { params: { id: locR } });
const totalFaturado = fatR.out.faturamento.valorTotal;

const ocR = M.ocupacao(db, '2026-08-01', '2026-08-31');
const linhaR = ocR.linhas.find(l => l.produtoId === Number(prodMaq));
perto(linhaR.receita, totalFaturado,
  `receita do ativo == o que foi faturado (${totalFaturado}), não o dobro`, 0.02);
perto(ocR.resumo.receitaTotal, totalFaturado,
  'e o resumo do painel também bate com o faturado', 0.02);

// Dois produtos diferentes no mesmo contrato: cada um leva a SUA fração.
const locR2 = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-07-01 08:00', dataRetornoPrevisto: '2026-07-03 08:00' },
}).out.contrato.id;
chamar('/api/locacao/locacoes/:id/itens', 'post', { params: { id: locR2 }, body: { produtoId: prodMaq, quantidade: 1 } });
chamar('/api/locacao/locacoes/:id/itens', 'post', { params: { id: locR2 }, body: { produtoId: prodSimples, quantidade: 1 } });
chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: locR2 } });
chamar('/api/locacao/locacoes/:id/entregar', 'post', { params: { id: locR2 }, body: { dataSaidaReal: '2026-07-01 08:00' } });
chamar('/api/locacao/locacoes/:id/devolver', 'post', { params: { id: locR2 }, body: { dataRetornoReal: '2026-07-03 08:00' } });
const fatR2 = chamar('/api/locacao/locacoes/:id/faturar', 'post', { params: { id: locR2 } });

const ocR2 = M.ocupacao(db, '2026-07-01', '2026-07-31');
perto(ocR2.resumo.receitaTotal, fatR2.out.faturamento.valorTotal,
  'com dois produtos, a soma do painel continua igual ao faturado', 0.02);
const lM = ocR2.linhas.find(l => l.produtoId === Number(prodMaq));
const lS = ocR2.linhas.find(l => l.produtoId === Number(prodSimples));
assert(lM.receita > 0 && lS.receita > 0, 'cada ativo recebe uma fatia');
assert(lM.receita !== fatR2.out.faturamento.valorTotal,
  'e nenhum deles leva o total inteiro', `${lM.receita} vs ${fatR2.out.faturamento.valorTotal}`);

secao('REGRESSÃO: sobrecarga e ausência de estoque não se confundem com ociosidade');
assert('custoManutencao' in linhaR, 'a linha traz custo de manutenção (prometido na F6)');
assert('resultado' in linhaR, 'e o resultado (receita − custo)');
assert(linhaR.semEstoque === false, 'ativo com estoque não é marcado como sem estoque');
assert(typeof ocR.resumo.semEstoque === 'number', 'o resumo separa os sem estoque dos ociosos');

const ocVazia = M.ocupacao(db, '2027-06-01', '2027-06-30');
const linhaVazia = ocVazia.linhas.find(l => l.produtoId === Number(prodMaq));
eq(linhaVazia.taxaOcupacao, 0, 'período sem locação nenhuma dá 0%');
assert(ocVazia.resumo.ociosos >= 2, 'e os ativos aparecem como ociosos');

const ocRuim = M.ocupacao(db, '2026-10-31', '2026-10-01');
assert(!ocRuim.ok, 'período invertido é recusado');

// ─── Rotas do painel ──────────────────────────────────────────────────────────
secao('Rotas do painel');
r = chamar('/api/locacao/painel/ocupacao', 'get', { query: { de: '2026-10-01', ate: '2026-10-31' } });
assert(r.st === 200 && r.out.linhas.length >= 2, 'GET ocupação responde', JSON.stringify(r.out.error));
assert(!!r.out.resumo, 'traz o resumo');

r = chamar('/api/locacao/painel/ocupacao', 'get', { query: { de: '2026-10-01' } });
assert(r.st === 400, 'faltando "ate" devolve 400');

r = chamar('/api/locacao/painel/ranking', 'get', { query: { de: '2026-10-01', ate: '2026-10-31' } });
assert(r.st === 200 && Array.isArray(r.out.melhores), 'GET ranking responde');
assert(Array.isArray(r.out.piores), 'ranking separa os ociosos');

r = chamar('/api/locacao/painel/ocupacao', 'get', {
  query: { de: '2026-10-01', ate: '2026-10-31', produtoId: prodMaq },
});
eq(r.out.linhas.length, 1, 'filtro por produto funciona');

// ─── Limpeza ──────────────────────────────────────────────────────────────────
limpar();
for (const [k, v] of Object.entries(cfgOriginal)) {
  if (v) db.prepare('UPDATE config SET valor = ? WHERE chave = ?').run(v.valor, k);
  else db.prepare('DELETE FROM config WHERE chave = ?').run(k);
}

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
