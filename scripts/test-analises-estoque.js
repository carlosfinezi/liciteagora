/**
 * Análises de estoque: escopo por depósito, coerência entre o card de
 * valorização e a curva de evolução, e as anomalias que antes sumiam
 * (saldo negativo, produto inativo com saldo, entrada com custo zero).
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasEstoque } = require('../estoque-routes');

const DB = '/tmp/vp-analises.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-analises-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}

const app = express();
registrarRotasEstoque(app, db);
const achar = (p) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods.get);
  if (!l) throw new Error(`rota ausente: GET ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, query = {}) {
  let out = null, st = 200;
  achar(p)({ params: {}, query, body: {}, session: {}, user: {} },
    { json: x => { out = x; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  if (out && out.success === false && st === 500) throw new Error(`${p}: ${out.error}`);
  return out;
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const perto = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ---------- seed ----------
db.prepare("INSERT OR IGNORE INTO depositos (id, nome, tipo, padrao, ativo) VALUES (1,'Principal','interno',1,1)").run();
db.prepare("INSERT OR IGNORE INTO depositos (id, nome, tipo, padrao, ativo) VALUES (2,'Filial','interno',0,1)").run();

const hoje = new Date();
const dia = n => new Date(hoje.getTime() - n * 86400000).toISOString().slice(0, 10);

const novoProduto = (sku, precoCusto, ativo = 1) =>
  db.prepare('INSERT INTO produtos (sku, descricao, unidade, precoCusto, ativo) VALUES (?,?,?,?,?)')
    .run(sku, 'Produto ' + sku, 'UN', precoCusto, ativo).lastInsertRowid;

const mov = (produtoId, tipo, qtd, o = {}) =>
  db.prepare(`INSERT INTO movimentacoes_estoque
    (produtoId, tipo, quantidade, custoUnitario, custoMedioPosterior, origem, data, depositoId)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(produtoId, tipo, qtd, o.custoUnitario ?? null, o.custoMedioPosterior ?? null,
         o.origem || 'ajuste_manual', o.data || dia(5), o.depositoId ?? 1).lastInsertRowid;

// P1: 10 un no Principal a 100 = 1.000
const P1 = novoProduto('P1', 100);
mov(P1, 'entrada', 10, { custoUnitario: 100, custoMedioPosterior: 100 });
// P2: 4 un na Filial a 50 = 200
const P2 = novoProduto('P2', 50);
mov(P2, 'entrada', 4, { custoUnitario: 50, custoMedioPosterior: 50, depositoId: 2 });
// P3: saldo negativo (-2) — erro de estoque
const P3 = novoProduto('P3', 500);
mov(P3, 'saida', 2, { custoUnitario: 500, data: dia(4) });
// P4: inativo, mas com 3 un a 20 = 60 paradas no depósito
const P4 = novoProduto('P4', 20, 0);
mov(P4, 'entrada', 3, { custoUnitario: 20, custoMedioPosterior: 20 });
// P5: entrada com custo ZERO e sem precoCusto — o caso que apagava valor
const P5 = novoProduto('P5', 0);
mov(P5, 'entrada', 5, { custoUnitario: 0 });

// ---------- valorização ----------
t('valor total soma só saldo positivo de produto ativo', () => {
  const v = chamar('/api/estoque/valorizacao');
  // P1 (1.000) + P2 (200); P3 negativo e P4 inativo ficam fora, P5 vale 0
  assert(perto(v.valorTotal, 1200), 'valorTotal: ' + v.valorTotal);
  assert(v.produtosComSaldo === 3, 'comSaldo: ' + v.produtosComSaldo);
});

t('saldo negativo não abate o valor do estoque, vira anomalia', () => {
  const v = chamar('/api/estoque/valorizacao');
  assert(v.saldoNegativo.itens === 1, 'negativos: ' + v.saldoNegativo.itens);
  assert(v.saldoNegativo.lista[0].sku === 'P3', 'sku: ' + v.saldoNegativo.lista[0].sku);
  // Somando tudo daria 1200 - 1000 = 200: o produto com erro engolia o estoque.
  assert(perto(v.valorTotal, 1200), 'o negativo voltou a abater: ' + v.valorTotal);
});

t('produto inativo com saldo aparece em vez de sumir', () => {
  const v = chamar('/api/estoque/valorizacao');
  assert(v.inativosComSaldo.itens === 1, 'inativos: ' + v.inativosComSaldo.itens);
  assert(perto(v.inativosComSaldo.valor, 60), 'valor: ' + v.inativosComSaldo.valor);
  assert(!v.top10.some(i => i.sku === 'P4'), 'inativo não pode entrar no top10');
});

t('saldo sem custo é sinalizado, não escondido', () => {
  const v = chamar('/api/estoque/valorizacao');
  assert(v.semCusto.itens === 1, 'semCusto: ' + JSON.stringify(v.semCusto));
  assert(v.semCusto.saldo === 5, 'saldo sem custo: ' + v.semCusto.saldo);
});

t('valorização por depósito separa Principal de Filial', () => {
  const p = chamar('/api/estoque/valorizacao', { depositoId: '1' });
  const f = chamar('/api/estoque/valorizacao', { depositoId: '2' });
  assert(perto(p.valorTotal, 1000), 'Principal: ' + p.valorTotal);
  assert(perto(f.valorTotal, 200), 'Filial: ' + f.valorTotal);
  assert(perto(p.valorTotal + f.valorTotal, 1200), 'a soma tem que fechar com o total');
});

// ---------- custo: uma expressão só ----------
t('entrada com custo zero não apaga o custo do cadastro', () => {
  const P6 = novoProduto('P6', 7);          // precoCusto 7
  mov(P6, 'entrada', 2, { custoUnitario: 0 }); // entrada zerada
  const v = chamar('/api/estoque/valorizacao');
  const i = v.top10.find(x => x.sku === 'P6');
  assert(i, 'P6 não apareceu');
  assert(perto(i.custoMedio, 7), 'custo caiu para ' + i.custoMedio + ' por causa da entrada zerada');
  db.prepare('DELETE FROM movimentacoes_estoque WHERE produtoId = ?').run(P6);
  db.prepare('DELETE FROM produtos WHERE id = ?').run(P6);
});

t('valorização e giro usam o mesmo custo', () => {
  const v = chamar('/api/estoque/valorizacao');
  const g = chamar('/api/estoque/giro', { meses: '12' });
  for (const i of v.top10) {
    const j = g.itens.find(x => x.id === i.id);
    assert(perto(i.custoMedio, j.custoMedio), `${i.sku}: valorização ${i.custoMedio} x giro ${j.custoMedio}`);
  }
});

// ---------- evolução ----------
t('a série não repete nem pula meses', () => {
  const e = chamar('/api/estoque/evolucao-valor', { meses: '6' });
  const meses = e.pontos.map(p => p.mes);
  assert(meses.length === 6, 'pontos: ' + meses.length);
  assert(new Set(meses).size === 6, 'meses repetidos: ' + meses.join(','));
  const ordenado = [...meses].sort();
  assert(JSON.stringify(meses) === JSON.stringify(ordenado), 'fora de ordem: ' + meses.join(','));
});

t('o último ponto da curva bate com o card de valorização', () => {
  const v = chamar('/api/estoque/valorizacao');
  const e = chamar('/api/estoque/evolucao-valor', { meses: '3' });
  assert(perto(e.pontos.at(-1).valor, v.valorTotal),
    `curva ${e.pontos.at(-1).valor} x card ${v.valorTotal}`);
});

t('a curva não depende de saldoPosterior estar preenchido', () => {
  // Nenhuma movimentação do seed tem saldoPosterior; antes a série zerava.
  const n = db.prepare('SELECT COUNT(*) n FROM movimentacoes_estoque WHERE saldoPosterior IS NOT NULL').get().n;
  assert(n === 0, 'o seed deveria ter saldoPosterior nulo em tudo');
  const e = chamar('/api/estoque/evolucao-valor', { meses: '2' });
  assert(e.pontos.at(-1).valor > 0, 'série zerada: ' + e.pontos.at(-1).valor);
});

t('a variação entre meses é calculada', () => {
  const e = chamar('/api/estoque/evolucao-valor', { meses: '3' });
  assert(e.pontos[0].variacao === null, 'o primeiro ponto não tem anterior');
  const p = e.pontos.at(-1), a = e.pontos.at(-2);
  assert(perto(p.variacao, p.valor - a.valor), 'variação: ' + p.variacao);
});

t('evolução por depósito', () => {
  const f = chamar('/api/estoque/evolucao-valor', { meses: '2', depositoId: '2' });
  assert(perto(f.pontos.at(-1).valor, 200), 'Filial: ' + f.pontos.at(-1).valor);
});

// ---------- ABC, giro e CMV por depósito ----------
t('ABC, giro e CMV aceitam depósito', () => {
  const inicio = dia(30), fim = dia(0);
  for (const [rota, q] of [
    ['/api/estoque/abc', { meses: '12' }],
    ['/api/estoque/giro', { meses: '12' }],
    ['/api/estoque/cmv', { inicio, fim }],
  ]) {
    const t1 = JSON.stringify(chamar(rota, q));
    const t2 = JSON.stringify(chamar(rota, { ...q, depositoId: '999' }));
    assert(t1 !== t2, rota + ' ignora depositoId');
    assert(chamar(rota, { ...q, depositoId: '999' }).depositoId === 999, rota + ' não devolve o escopo');
  }
});

t('saída na Filial não aparece no CMV do Principal', () => {
  const PX = novoProduto('PX', 10);
  mov(PX, 'entrada', 20, { custoUnitario: 10, depositoId: 2, data: dia(10) });
  mov(PX, 'saida', 6, { custoUnitario: 10, depositoId: 2, data: dia(3) });
  const inicio = dia(30), fim = dia(0);
  const filial = chamar('/api/estoque/cmv', { inicio, fim, depositoId: '2' });
  const principal = chamar('/api/estoque/cmv', { inicio, fim, depositoId: '1' });
  assert(filial.porProduto.some(p => p.sku === 'PX'), 'a saída sumiu do CMV da Filial');
  assert(!principal.porProduto.some(p => p.sku === 'PX'), 'a saída da Filial vazou para o Principal');
});

t('giro por depósito enxerga o saldo do armazém, não o da empresa', () => {
  const g1 = chamar('/api/estoque/giro', { meses: '12', depositoId: '1' });
  const g2 = chamar('/api/estoque/giro', { meses: '12', depositoId: '2' });
  const p1 = g1.itens.find(i => i.sku === 'P2');
  const p2 = g2.itens.find(i => i.sku === 'P2');
  assert(p1.saldoAtual === 0, 'P2 não está no Principal, mas apareceu com ' + p1.saldoAtual);
  assert(p2.saldoAtual === 4, 'P2 na Filial: ' + p2.saldoAtual);
});

t('giro conta os itens com saldo e sem custo', () => {
  const g = chamar('/api/estoque/giro', { meses: '12' });
  assert(g.resumo.semCusto === 1, 'semCusto: ' + g.resumo.semCusto);
});

// ---------- degradação ----------
t('sem tabela de depósitos as análises continuam respondendo', () => {
  const P2DB = '/tmp/vp-analises2.db';
  try { fs.unlinkSync(P2DB); } catch {}
  const db2 = new Database(P2DB);
  db2.exec(schema);
  db2.exec('DROP TABLE depositos');
  const app2 = express();
  registrarRotasEstoque(app2, db2);
  const l = ((app2.router || app2._router).stack || [])
    .find(x => x.route && x.route.path === '/api/estoque/valorizacao');
  let out = null;
  l.route.stack.at(-1).handle({ query: {}, params: {}, body: {}, session: {}, user: {} },
    { json: x => { out = x; }, status: () => ({ json: x => { out = x; } }) });
  assert(out && out.success, 'quebrou sem depositos: ' + (out && out.error));
  db2.close();
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
