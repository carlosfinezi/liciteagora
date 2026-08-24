/**
 * Teste do vínculo depósito × movimentação: cada documento diz de qual
 * depósito a mercadoria sai, e a movimentação nasce com esse depósito.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasEstoque, resolverDeposito, calcularSaldo } = require('../estoque-routes');
const { criarReservasPedido, consumirReservasPedido } = require('../reservas-routes');

const DB = '/tmp/vp-deposito.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-deposito-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec('CREATE TABLE IF NOT EXISTS tipos_operacao (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, movimentaEstoque INTEGER DEFAULT 1)');

const app = express();
registrarRotasEstoque(app, db);
const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(h, o = {}) {
  let out = null, st = 200;
  h({ params: o.params || {}, query: o.query || {}, body: o.body || {}, session: {}, user: {} },
    { json: x => { out = x; return { json: y => { out = y; } }; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- seed ----------
// registrarRotasEstoque já roda migrarEstoqueDB, que semeia o 'Principal'.
db.prepare("INSERT OR IGNORE INTO depositos (id, nome, tipo, padrao, ativo) VALUES (1,'Principal','interno',1,1)").run();
db.prepare("INSERT OR IGNORE INTO depositos (id, nome, tipo, padrao, ativo) VALUES (2,'Filial','interno',0,1)").run();
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (1,'00000000000191','Cliente','cliente',1)").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, ativo, precoCusto) VALUES (1,'P1','Produto',1,10)").run();
// Estoque em cada depósito
const entrada = db.prepare(`INSERT INTO movimentacoes_estoque
  (produtoId, tipo, quantidade, custoUnitario, origem, data, depositoId) VALUES (1,'entrada',?,10,'nfe_entrada',date('now'),?)`);
entrada.run(100, 1); entrada.run(50, 2);

t('resolverDeposito respeita o valor explícito', () => {
  assert(resolverDeposito(db, { depositoId: 2 }) === 2, 'não respeitou explícito');
});

t('resolverDeposito cai no padrão sem nenhuma pista', () => {
  assert(resolverDeposito(db, {}) === 1, 'padrão errado');
});

t('resolverDeposito herda da movimentação original (estorno)', () => {
  const m = db.prepare("SELECT id FROM movimentacoes_estoque WHERE depositoId = 2 LIMIT 1").get();
  assert(resolverDeposito(db, { movOriginalId: m.id }) === 2, 'estorno não herdou o depósito');
});

t('saldo é por depósito', () => {
  assert(calcularSaldo(db, 1) === 150, 'saldo total: ' + calcularSaldo(db, 1));
  assert(calcularSaldo(db, 1, 1) === 100, 'Principal: ' + calcularSaldo(db, 1, 1));
  assert(calcularSaldo(db, 1, 2) === 50, 'Filial: ' + calcularSaldo(db, 1, 2));
});

// ---------- venda saindo da Filial ----------
let PED;
t('pedido guarda o depósito escolhido', () => {
  PED = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal, depositoId)
    VALUES ('PED-1','manual','pedido',1,'confirmado',date('now'),100,2)`).run().lastInsertRowid;
  db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
    VALUES (?,1,'Produto',10,10,100)`).run(PED);
  const p = db.prepare('SELECT depositoId FROM pedidos WHERE id = ?').get(PED);
  assert(p.depositoId === 2, 'depósito do pedido: ' + p.depositoId);
});

t('reserva nasce com o depósito do pedido', () => {
  const r = criarReservasPedido(db, PED);
  assert(r.reservasCriadas.length === 1, 'reservas: ' + r.reservasCriadas.length);
  const res = db.prepare('SELECT depositoId FROM reservas_estoque WHERE pedidoId = ?').get(PED);
  assert(res.depositoId === 2, 'reserva ficou no depósito ' + res.depositoId);
});

t('consumo da reserva gera saída na Filial, não no padrão', () => {
  consumirReservasPedido(db, PED, new Date().toISOString().slice(0, 10));
  const mov = db.prepare("SELECT * FROM movimentacoes_estoque WHERE origem='pedido' AND origemId=?").get(PED);
  assert(mov, 'não gerou movimentação');
  assert(mov.depositoId === 2, `saída foi para o depósito ${mov.depositoId}, esperado 2`);
});

t('o saldo saiu do depósito certo', () => {
  assert(calcularSaldo(db, 1, 2) === 40, 'Filial deveria cair para 40: ' + calcularSaldo(db, 1, 2));
  assert(calcularSaldo(db, 1, 1) === 100, 'Principal não podia mudar: ' + calcularSaldo(db, 1, 1));
});

// ---------- listagem e filtros ----------
t('listagem devolve totais e o nome do depósito', () => {
  const r = chamar(achar('/api/estoque/movimentacoes', 'get'), {});
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.totais.registros === 3, 'registros: ' + r.out.totais.registros);
  assert(r.out.totais.qtdEntrada === 150 && r.out.totais.qtdSaida === 10, JSON.stringify(r.out.totais));
  assert(r.out.movimentacoes.some(m => m.depositoNome === 'Filial'), 'nome do depósito ausente');
});

t('filtro por depósito separa de verdade', () => {
  const f = chamar(achar('/api/estoque/movimentacoes', 'get'), { query: { depositoId: '2' } });
  assert(f.out.movimentacoes.length === 2, 'Filial: ' + f.out.movimentacoes.length);
  const p = chamar(achar('/api/estoque/movimentacoes', 'get'), { query: { depositoId: '1' } });
  assert(p.out.movimentacoes.length === 1, 'Principal: ' + p.out.movimentacoes.length);
});

t('filtros de período, tipo e busca', () => {
  assert(chamar(achar('/api/estoque/movimentacoes', 'get'), { query: { de: '2099-01-01' } }).out.movimentacoes.length === 0, 'período futuro deveria zerar');
  assert(chamar(achar('/api/estoque/movimentacoes', 'get'), { query: { tipo: 'saida' } }).out.movimentacoes.length === 1, 'filtro de tipo');
  assert(chamar(achar('/api/estoque/movimentacoes', 'get'), { query: { q: 'P1' } }).out.movimentacoes.length === 3, 'busca por SKU');
  assert(chamar(achar('/api/estoque/movimentacoes', 'get'), { query: { q: 'inexistente' } }).out.movimentacoes.length === 0, 'busca sem resultado');
});

t('truncamento é sinalizado', () => {
  const r = chamar(achar('/api/estoque/movimentacoes', 'get'), { query: { limit: '1' } });
  assert(r.out.truncado === true, 'não sinalizou truncamento');
  assert(r.out.totais.registros === 3 && r.out.movimentacoes.length === 1, 'totais devem ser do filtro todo');
});

t('origens vêm do banco', () => {
  const r = chamar(achar('/api/estoque/movimentacoes/origens', 'get'), {});
  const vals = r.out.origens.map(o => o.origem);
  assert(vals.includes('nfe_entrada') && vals.includes('pedido'), 'origens: ' + vals.join(','));
  assert(!vals.includes('compra'), 'origem inexistente vazou');
});

t('sem tabela depositos o estoque não quebra', () => {
  const P2 = '/tmp/vp-deposito2.db';
  try { fs.unlinkSync(P2); } catch {}
  const db2 = new Database(P2);
  db2.exec(schema);
  db2.exec('DROP TABLE depositos');
  // Antes isso estourava "no such table: depositos" em toda movimentação.
  assert(resolverDeposito(db2, {}) === null, 'deveria degradar para null');
  db2.close();
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
