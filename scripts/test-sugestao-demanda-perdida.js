/**
 * Teste da sugestão de compra alimentada por demanda perdida.
 * Chama o handler real da rota com req/res falsos, contra um SQLite
 * temporário com o schema de produção.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasCompras } = require('../compras-routes');

const DB = '/tmp/vp-sugestao.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(fs.readFileSync('/tmp/vp-schema2.sql', 'utf8'));
// Tabelas referenciadas por FK que o teste não usa.
db.exec(`CREATE TABLE IF NOT EXISTS pedidos (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT);
         CREATE TABLE IF NOT EXISTS pedido_itens (id INTEGER PRIMARY KEY AUTOINCREMENT, pedidoId INTEGER);
         CREATE TABLE IF NOT EXISTS pessoas (id INTEGER PRIMARY KEY AUTOINCREMENT, razaoSocial TEXT);`);

const app = express();
registrarRotasCompras(app, db);
const rota = ((app.router || app._router).stack || [])
  .find(l => l.route && l.route.path === '/api/compras/sugestao' && l.route.methods.get);
if (!rota) { console.log('FALHA: rota /api/compras/sugestao nao registrada'); process.exit(1); }
const handler = rota.route.stack[rota.route.stack.length - 1].handle;

function chamar(query = {}) {
  let saida = null;
  const res = {
    json: o => { saida = o; return res; },
    status: c => { res._status = c; return res; },
  };
  handler({ query, session: {} }, res);
  if (!saida) throw new Error('handler nao respondeu');
  if (!saida.success) throw new Error('endpoint: ' + saida.error);
  return saida;
}

let ok = 0, fail = 0;
function t(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }
const item = (d, sku) => d.itens.find(i => i.sku === sku);

// ---------- seed ----------
db.prepare("INSERT INTO fornecedores (id, cpfCnpj, razaoSocial) VALUES (1,'00000000000191','Fornecedor A')").run();

// A: parametrizado, abaixo do ponto, SEM perda
db.prepare(`INSERT INTO produtos (id, sku, descricao, ativo, precoCusto, estoqueMinimo, pontoReposicao, estoqueMaximo, fornecedorId)
  VALUES (1,'A','Param sem perda',1,10,5,10,50,1)`).run();
// B: parametrizado, abaixo do ponto, COM perda por falta de estoque
db.prepare(`INSERT INTO produtos (id, sku, descricao, ativo, precoCusto, estoqueMinimo, pontoReposicao, estoqueMaximo, fornecedorId)
  VALUES (2,'B','Param com perda',1,10,5,10,50,1)`).run();
// C: SEM parametrização, com perda por falta de estoque
db.prepare(`INSERT INTO produtos (id, sku, descricao, ativo, precoCusto, estoqueMinimo, pontoReposicao, estoqueMaximo)
  VALUES (3,'C','Sem param com perda',1,10,0,0,0)`).run();
// D: SEM parametrização, perda por PREÇO (não é falha de reposição)
db.prepare(`INSERT INTO produtos (id, sku, descricao, ativo, precoCusto, estoqueMinimo, pontoReposicao, estoqueMaximo)
  VALUES (4,'D','Perda por preco',1,10,0,0,0)`).run();
// E: parametrizado e COM estoque suficiente
db.prepare(`INSERT INTO produtos (id, sku, descricao, ativo, precoCusto, estoqueMinimo, pontoReposicao, estoqueMaximo)
  VALUES (5,'E','Estoque ok',1,10,5,10,50)`).run();

const mov = db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, data)
  VALUES (?, ?, ?, date('now','-10 days'))`);
mov.run(1, 'entrada', 2);   // A: disponivel 2
mov.run(2, 'entrada', 2);   // B: disponivel 2
mov.run(3, 'entrada', 1);   // C: disponivel 1
mov.run(4, 'entrada', 1);   // D: disponivel 1
mov.run(5, 'entrada', 100); // E: disponivel 100

const perda = db.prepare(`INSERT INTO vendas_perdidas (data, produtoId, quantidade, precoAlvo, motivo, origem)
  VALUES (date('now', ?), ?, ?, ?, ?, 'pedido_cancelado')`);
perda.run('-10 days', 2, 20, 30, 'sem_estoque');  // B: 20 un, R$ 600
perda.run('-20 days', 3, 12, 50, 'sem_estoque');  // C: 12 un, R$ 600
perda.run('-5 days',  4, 99, 10, 'preco');        // D: não deve contar
perda.run('-200 days', 2, 500, 10, 'sem_estoque'); // B: fora da janela de 90d
db.prepare(`INSERT INTO vendas_perdidas (data, produtoId, descricaoLivre, quantidade, precoAlvo, motivo, origem)
  VALUES (date('now','-3 days'), NULL, 'Produto nao cadastrado', 7, 20, 'sem_estoque', 'manual')`).run();

// ---------- testes ----------
t('produto parametrizado sem perda mantém o cálculo antigo', () => {
  const d = chamar();
  const a = item(d, 'A');
  assert(a, 'A sumiu da sugestão');
  assert(a.perdaQtd90d === 0, 'perda deveria ser 0');
  assert(a.quantidadeSugerida === 48, 'esperava 50-2=48, veio ' + a.quantidadeSugerida);
  assert(a.quantidadeSugerida === a.quantidadeSugeridaBase, 'base divergiu sem perda');
  assert(a.origemSugestao === 'parametro', 'origem: ' + a.origemSugestao);
});

t('perda por falta de estoque soma ao alvo', () => {
  const d = chamar();
  const b = item(d, 'B');
  assert(b, 'B sumiu');
  assert(b.perdaQtd90d === 20, 'perda 90d: ' + b.perdaQtd90d);
  assert(b.perdaValor90d === 600, 'valor perdido: ' + b.perdaValor90d);
  assert(b.quantidadeSugeridaBase === 48, 'base: ' + b.quantidadeSugeridaBase);
  assert(b.quantidadeSugerida === 68, 'esperava 50+20-2=68, veio ' + b.quantidadeSugerida);
  assert(b.quantidadePorDemandaPerdida === 20, 'delta: ' + b.quantidadePorDemandaPerdida);
  assert(b.origemSugestao === 'ambos', 'origem: ' + b.origemSugestao);
});

t('janela de 90 dias descarta perda antiga', () => {
  const b = item(chamar(), 'B');
  assert(b.perdaQtd90d === 20, 'perda de 200 dias atrás vazou: ' + b.perdaQtd90d);
  assert(b.perdaRegistros90d === 1, 'registros: ' + b.perdaRegistros90d);
});

t('produto sem parametrização entra por demanda perdida', () => {
  const c = item(chamar(), 'C');
  assert(c, 'C não entrou na sugestão');
  assert(c.origemSugestao === 'demanda_perdida', 'origem: ' + c.origemSugestao);
  assert(c.quantidadeSugeridaBase === 0, 'base deveria ser 0, veio ' + c.quantidadeSugeridaBase);
  assert(c.quantidadeSugerida === 11, 'esperava 12-1=11, veio ' + c.quantidadeSugerida);
  assert(c.limite === 0, 'limite: ' + c.limite);
});

t('perda por preço NÃO vira sugestão de compra', () => {
  assert(!item(chamar(), 'D'), 'D entrou — perda por preço não é falha de reposição');
});

t('produto com estoque suficiente continua fora', () => {
  assert(!item(chamar(), 'E'), 'E entrou indevidamente');
});

t('consumo diário ajustado soma saídas + demanda perdida', () => {
  const b = item(chamar(), 'B');
  assert(Math.abs(b.consumoDiarioMedio - 0) < 1e-9, 'consumo base: ' + b.consumoDiarioMedio);
  assert(Math.abs(b.consumoDiarioAjustado - 20 / 90) < 1e-9, 'ajustado: ' + b.consumoDiarioAjustado);
});

t('incluirPerdas=0 volta ao comportamento anterior', () => {
  const d = chamar({ incluirPerdas: '0' });
  assert(d.resumo.incluiDemandaPerdida === false, 'flag do resumo');
  assert(!item(d, 'C'), 'C não deveria aparecer sem perdas');
  const b = item(d, 'B');
  assert(b.quantidadeSugerida === 48, 'B voltou pra 48? veio ' + b.quantidadeSugerida);
  assert(b.perdaQtd90d === 0, 'perda deveria estar zerada');
});

t('perda sem produto cadastrado é reportada à parte', () => {
  const d = chamar();
  const sp = d.resumo.perdasSemProduto;
  assert(sp.registros === 1, 'registros: ' + sp.registros);
  assert(sp.quantidade === 7, 'quantidade: ' + sp.quantidade);
  assert(sp.valor === 140, 'valor: ' + sp.valor);
});

t('resumo agrega demanda perdida e contagem por origem', () => {
  const rs = chamar().resumo;
  assert(rs.incluiDemandaPerdida === true, 'flag');
  assert(rs.janelaDias === 90, 'janela: ' + rs.janelaDias);
  assert(rs.demandaPerdidaQtd === 32, 'qtd total (20+12): ' + rs.demandaPerdidaQtd);
  assert(rs.demandaPerdidaValor === 1200, 'valor total: ' + rs.demandaPerdidaValor);
  assert(rs.itensPorDemandaPerdida === 2, 'itens B e C: ' + rs.itensPorDemandaPerdida);
});

t('sem a tabela vendas_perdidas o endpoint não quebra', () => {
  const P2 = '/tmp/vp-sugestao2.db';
  try { fs.unlinkSync(P2); } catch {}
  const db2 = new Database(P2);
  // Carrega o schema inteiro e derruba a tabela — o DROP leva os índices
  // junto, o que remover só o CREATE TABLE não faria.
  db2.exec(fs.readFileSync('/tmp/vp-schema2.sql', 'utf8'));
  db2.exec('DROP TABLE vendas_perdidas');

  const app2 = express();
  registrarRotasCompras(app2, db2);
  const r2 = ((app2.router || app2._router).stack || [])
    .find(l => l.route && l.route.path === '/api/compras/sugestao' && l.route.methods.get);
  let saida = null;
  r2.route.stack[r2.route.stack.length - 1].handle(
    { query: {}, session: {} }, { json: o => { saida = o; }, status: () => ({ json: o => { saida = o; } }) });
  assert(saida && saida.success, 'quebrou sem a tabela: ' + (saida && saida.error));
  assert(saida.resumo.incluiDemandaPerdida === false, 'deveria degradar para sem perdas');
  db2.close();
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
