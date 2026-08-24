/**
 * Teste das correções 1, 2 e 3 do módulo de devoluções:
 *   1) custo de retorno ao estoque
 *   2) validação de quantidade devolvível
 *   3) estorno de devolução efetivada
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasDevolucoes } = require('../devolucoes-routes');
const { calcularCustoMedio, calcularSaldo } = require('../estoque-routes');

const DB = '/tmp/vp-devfix.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-devfix-schema.sql', 'utf8');
db.exec(schema);
db.exec(`CREATE TABLE IF NOT EXISTS tipos_operacao (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, descricao TEXT);`);
// O dump traz só as tabelas do fluxo, mas elas têm FK para outras. Com
// foreign_keys=ON o alvo precisa existir, então cria stub para cada um.
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec('CREATE TABLE IF NOT EXISTS participacoes_comprasnet (id INTEGER PRIMARY KEY AUTOINCREMENT)');

const app = express();
registrarRotasDevolucoes(app, db);
const achar = (path, metodo) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === path && x.route.methods[metodo]);
  if (!l) throw new Error(`rota nao registrada: ${metodo.toUpperCase()} ${path}`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const hPost = achar('/api/devolucoes', 'post');
const hPut = achar('/api/devolucoes/:id', 'put');
const hEfet = achar('/api/devolucoes/:id/efetivar', 'post');
const hEst = achar('/api/devolucoes/:id/estornar', 'post');
const hDisp = achar('/api/devolucoes/pedido/:pedidoId/disponivel', 'get');
const hDel = achar('/api/devolucoes/:id', 'delete');

function chamar(handler, { params = {}, body = {}, query = {} } = {}) {
  let out = null, st = 200;
  const res = { json: o => { out = o; return res; }, status: c => { st = c; return res; } };
  handler({ params, body, query, session: { username: 'teste' }, user: { username: 'teste' } }, res);
  if (!out) throw new Error('sem resposta');
  return { out, st };
}

let ok = 0, fail = 0;
function t(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

// ---------- seed ----------
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (1,'00000000000191','Cliente','cliente',1)").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, ativo, precoCusto) VALUES (1,'P1','Produto 1',1,0)").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, ativo, precoCusto) VALUES (2,'P2','Fora do pedido',1,0)").run();

// Compra 10 un a R$ 100 → custo médio 100
db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, origem, data,
  custoMedioAnterior, custoMedioPosterior, saldoPosterior)
  VALUES (1,'entrada',10,100,'nfe_entrada','2026-07-01',0,100,10)`).run();

// Vende 4 un a R$ 300 (markup 3x) — a saída registra o custo médio vigente
db.prepare(`INSERT INTO pedidos (id, numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal)
  VALUES (1,'PED-1','manual','pedido',1,'faturado','2026-07-10',1200)`).run();
db.prepare(`INSERT INTO pedido_itens (id, pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
  VALUES (1,1,1,'Produto 1',4,300,1200)`).run();
db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, origem, origemId, data,
  custoMedioAnterior, custoMedioPosterior, saldoPosterior, estornada)
  VALUES (1,'saida',4,'pedido',1,'2026-07-10',100,100,6,0)`).run();

const CUSTO_ANTES = calcularCustoMedio(db, 1);
const SALDO_ANTES = calcularSaldo(db, 1);

// ---------- 2) validação de quantidade ----------
t('POST recusa quantidade acima do vendido', () => {
  const r = chamar(hPost, { body: { pedidoId: 1, clienteId: 1,
    itens: [{ pedidoItemId: 1, produtoId: 1, descricao: 'P1', quantidade: 99, valorUnitario: 300 }] } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/excede o devolvível/.test(r.out.error), 'erro: ' + r.out.error);
  assert(db.prepare('SELECT COUNT(*) n FROM devolucoes').get().n === 0, 'gravou mesmo recusando');
});

t('POST recusa produto que não estava no pedido', () => {
  const r = chamar(hPost, { body: { pedidoId: 1, clienteId: 1,
    itens: [{ produtoId: 2, descricao: 'P2', quantidade: 1, valorUnitario: 50 }] } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/não faz parte do pedido/.test(r.out.error), 'erro: ' + r.out.error);
});

t('POST soma lançamentos repetidos do mesmo item', () => {
  const r = chamar(hPost, { body: { pedidoId: 1, clienteId: 1,
    itens: [
      { pedidoItemId: 1, produtoId: 1, descricao: 'P1', quantidade: 3, valorUnitario: 300 },
      { pedidoItemId: 1, produtoId: 1, descricao: 'P1', quantidade: 3, valorUnitario: 300 },
    ] } });
  assert(r.st === 400, '3+3=6 > 4 deveria recusar; status ' + r.st);
});

let DEV1;
t('POST aceita quantidade dentro do saldo', () => {
  const r = chamar(hPost, { body: { pedidoId: 1, clienteId: 1, motivo: 'defeito',
    itens: [{ pedidoItemId: 1, produtoId: 1, descricao: 'P1', quantidade: 2, valorUnitario: 300 }] } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  DEV1 = r.out.devolucao.id;
});

t('devolução aberta já reserva saldo (não nascem duas somando demais)', () => {
  const r = chamar(hPost, { body: { pedidoId: 1, clienteId: 1,
    itens: [{ pedidoItemId: 1, produtoId: 1, descricao: 'P1', quantidade: 3, valorUnitario: 300 }] } });
  assert(r.st === 400, '2 abertas + 3 = 5 > 4 deveria recusar; status ' + r.st);
});

t('/disponivel desconta o que está em aberto', () => {
  const r = chamar(hDisp, { params: { pedidoId: '1' } });
  const i = r.out.itens[0];
  assert(i.qtdEmAberto === 2, 'em aberto: ' + i.qtdEmAberto);
  assert(i.qtdDisponivel === 2, 'disponível: ' + i.qtdDisponivel);
});

t('PUT ignora a própria devolução ao validar', () => {
  const r = chamar(hPut, { params: { id: String(DEV1) },
    body: { itens: [{ pedidoItemId: 1, produtoId: 1, descricao: 'P1', quantidade: 4, valorUnitario: 300 }] } });
  assert(r.out.success, 'deveria aceitar os 4 (só ela reserva): ' + r.out.error);
  chamar(hPut, { params: { id: String(DEV1) },
    body: { itens: [{ pedidoItemId: 1, produtoId: 1, descricao: 'P1', quantidade: 2, valorUnitario: 300 }] } });
});

t('PUT recusa acima do saldo', () => {
  const r = chamar(hPut, { params: { id: String(DEV1) },
    body: { itens: [{ pedidoItemId: 1, produtoId: 1, descricao: 'P1', quantidade: 5, valorUnitario: 300 }] } });
  assert(r.st === 400, 'status: ' + r.st);
});

// ---------- 1) custo de retorno ----------
t('efetivar devolve ao estoque pelo CUSTO, não pelo preço de venda', () => {
  const r = chamar(hEfet, { params: { id: String(DEV1) } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  const mov = db.prepare("SELECT * FROM movimentacoes_estoque WHERE origem='devolucao' AND origemId=?").get(DEV1);
  assert(mov, 'não gerou movimentação');
  assert(mov.custoUnitario === 100, `custoUnitario deveria ser 100 (custo), veio ${mov.custoUnitario}`);
  assert(mov.custoUnitario !== 300, 'gravou o preço de venda como custo');
});

t('custo médio do produto não se move com a devolução', () => {
  const depois = calcularCustoMedio(db, 1);
  assert(Math.abs(depois - CUSTO_ANTES) < 1e-9, `custo médio foi de ${CUSTO_ANTES} para ${depois}`);
  assert(depois === 100, 'custo médio: ' + depois);
});

t('entrada preenche contexto de custo e saldo', () => {
  const mov = db.prepare("SELECT * FROM movimentacoes_estoque WHERE origem='devolucao' AND origemId=?").get(DEV1);
  assert(mov.custoMedioAnterior === 100, 'custoMedioAnterior: ' + mov.custoMedioAnterior);
  assert(mov.custoMedioPosterior === 100, 'custoMedioPosterior: ' + mov.custoMedioPosterior);
  assert(mov.saldoPosterior === SALDO_ANTES + 2, 'saldoPosterior: ' + mov.saldoPosterior);
});

t('saldo em estoque sobe com a devolução', () => {
  assert(calcularSaldo(db, 1) === SALDO_ANTES + 2, 'saldo: ' + calcularSaldo(db, 1));
});

t('efetivar gera crédito negativo ao cliente', () => {
  const cr = db.prepare("SELECT * FROM contas_a_receber WHERE origem='devolucao'").get();
  assert(cr && cr.valor === -600, 'CR: ' + JSON.stringify(cr));
});

t('efetivada não pode ser cancelada por DELETE', () => {
  const r = chamar(hDel, { params: { id: String(DEV1) } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/Estornar/.test(r.out.error), 'mensagem deveria apontar o estorno: ' + r.out.error);
});

// ---------- 3) estorno ----------
t('estorno exige motivo', () => {
  const r = chamar(hEst, { params: { id: String(DEV1) }, body: {} });
  assert(r.st === 400, 'status: ' + r.st);
});

t('estorno reverte estoque, crédito e status', () => {
  const r = chamar(hEst, { params: { id: String(DEV1) }, body: { motivo: 'lançamento errado' } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  assert(r.out.movimentacoesEstornadas === 1, 'movimentações: ' + r.out.movimentacoesEstornadas);
  assert(r.out.creditoCancelado === true, 'crédito não cancelado');
  const dev = db.prepare('SELECT * FROM devolucoes WHERE id = ?').get(DEV1);
  assert(dev.status === 'estornada', 'status: ' + dev.status);
  const cr = db.prepare("SELECT * FROM contas_a_receber WHERE origem='devolucao'").get();
  assert(cr.status === 'cancelada', 'CR: ' + cr.status);
});

t('estorno devolve o saldo de estoque ao ponto original', () => {
  assert(calcularSaldo(db, 1) === SALDO_ANTES, 'saldo: ' + calcularSaldo(db, 1) + ' esperado ' + SALDO_ANTES);
  assert(calcularCustoMedio(db, 1) === 100, 'custo médio após estorno: ' + calcularCustoMedio(db, 1));
});

t('estorno preserva o histórico (marca, não apaga)', () => {
  const orig = db.prepare("SELECT * FROM movimentacoes_estoque WHERE origem='devolucao' AND origemId=?").get(DEV1);
  assert(orig, 'movimentação original foi apagada');
  assert(orig.estornada === 1, 'não marcou estornada');
  assert(orig.movEstornoId, 'não apontou o estorno');
  const comp = db.prepare("SELECT * FROM movimentacoes_estoque WHERE origem='estorno_devolucao'").get();
  assert(comp && comp.movOriginalId === orig.id, 'compensatória não aponta a original');
  assert(comp.custoUnitario === orig.custoUnitario, 'estorno deveria sair pelo mesmo custo');
});

t('saldo devolvível volta a ficar livre após o estorno', () => {
  const r = chamar(hDisp, { params: { pedidoId: '1' } });
  assert(r.out.itens[0].qtdDisponivel === 4, 'disponível: ' + r.out.itens[0].qtdDisponivel);
  const nova = chamar(hPost, { body: { pedidoId: 1, clienteId: 1,
    itens: [{ pedidoItemId: 1, produtoId: 1, descricao: 'P1', quantidade: 4, valorUnitario: 300 }] } });
  assert(nova.out.success, 'não deixou relançar: ' + nova.out.error);
});

t('estorno só vale para efetivada', () => {
  const r = chamar(hEst, { params: { id: String(DEV1) }, body: { motivo: 'de novo' } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/efetivada/.test(r.out.error), 'erro: ' + r.out.error);
});

t('devolução avulsa (sem pedido) segue permitida', () => {
  const r = chamar(hPost, { body: { clienteId: 1,
    itens: [{ produtoId: 2, descricao: 'Avulso', quantidade: 1, valorUnitario: 10 }] } });
  assert(r.out.success, 'avulsa deveria passar: ' + r.out.error);
});

t('sem custo conhecido, entrada não inventa número', () => {
  const dev = chamar(hPost, { body: { clienteId: 1,
    itens: [{ produtoId: 2, descricao: 'Sem custo', quantidade: 1, valorUnitario: 999 }] } }).out.devolucao;
  const r = chamar(hEfet, { params: { id: String(dev.id) } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  const mov = db.prepare("SELECT * FROM movimentacoes_estoque WHERE origem='devolucao' AND origemId=?").get(dev.id);
  assert(mov.custoUnitario == null, 'deveria ficar nulo, veio ' + mov.custoUnitario);
  assert(mov.custoUnitario !== 999, 'usou o preço de venda como custo');
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
