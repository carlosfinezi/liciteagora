/**
 * Rateio de cotação: um item pode ser atendido por vários fornecedores.
 * Cobre a divisão manual, a sugerida, os limites (disponibilidade e
 * necessidade) e a geração de um pedido de compra por fornecedor.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasCotacoes, registrarRotasCotacaoPublica,
        sugerirRateio, normalizarDisponivel } = require('../cotacoes-routes');

const DB = '/tmp/vp-rateio.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-rateio-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
// audit_log não tem FK apontando para ela, então o stub genérico não a cria
// e o logAction enche a saída de aviso.
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT, acao TEXT, entidade TEXT, entidadeId INTEGER, detalhes TEXT, ip TEXT,
  dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);

const app = express();
registrarRotasCotacoes(app, db);
registrarRotasCotacaoPublica(app, db);
const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {}, session: {}, user: {} },
    { json: x => { out = x; return { json: y => { out = y; } }; },
      status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const perto = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ---------- seed ----------
db.prepare("INSERT INTO produtos (id, sku, descricao, unidade, ativo, precoCusto) VALUES (1,'SKU-A','Produto A','UN',1,10)").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, unidade, ativo, precoCusto) VALUES (2,'SKU-B','Produto B','UN',1,20)").run();
const insForn = db.prepare("INSERT INTO fornecedores (razaoSocial, cpfCnpj, ativo) VALUES (?,?,1)");
const F1 = insForn.run('Fornecedor Barato', '00000000000191').lastInsertRowid;
const F2 = insForn.run('Fornecedor Médio', '00000000000272').lastInsertRowid;
const F3 = insForn.run('Fornecedor Caro', '00000000000353').lastInsertRowid;

// Cotação: 100 un do produto A, 10 un do produto B
const nova = chamar('/api/cotacoes', 'post', { body: {
  descricao: 'Compra de teste',
  itens: [
    { produtoId: 1, descricao: 'Produto A', quantidade: 100, unidade: 'UN' },
    { produtoId: 2, descricao: 'Produto B', quantidade: 10, unidade: 'UN' },
  ],
  fornecedoresIds: [F1, F2, F3],
} });
assert(nova.out.success, 'seed da cotação: ' + nova.out.error);
const COT = nova.out.id;
chamar('/api/cotacoes/:id/enviar', 'post', { params: { id: String(COT) } });

const det = () => chamar('/api/cotacoes/:id', 'get', { params: { id: String(COT) } }).out;
const d0 = det();
const ITEM_A = d0.itens.find(i => i.produtoId === 1).id;
const ITEM_B = d0.itens.find(i => i.produtoId === 2).id;
const cfDe = (fid) => d0.fornecedores.find(f => f.fornecedorId === fid).id;
const CF1 = cfDe(F1), CF2 = cfDe(F2), CF3 = cfDe(F3);

// Respostas pelo portal público: o barato só tem 30 do item A.
const responder = (cfId, respostas) => {
  const tok = db.prepare('SELECT tokenPublico FROM cotacao_fornecedores WHERE id = ?').get(cfId).tokenPublico;
  return chamar('/api/cotacao-publica/:token', 'post', { params: { token: tok }, body: { respostas } });
};
responder(CF1, [
  { cotacaoItemId: ITEM_A, precoUnitario: 10, quantidadeDisponivel: 30, prazoEntregaDias: 5 },
  { cotacaoItemId: ITEM_B, precoUnitario: 100, quantidadeDisponivel: null },
]);
responder(CF2, [
  { cotacaoItemId: ITEM_A, precoUnitario: 12, quantidadeDisponivel: 50 },
]);
responder(CF3, [
  { cotacaoItemId: ITEM_A, precoUnitario: 15, quantidadeDisponivel: null },
  { cotacaoItemId: ITEM_B, precoUnitario: 90, quantidadeDisponivel: 4 },
]);

// ---------- disponibilidade ----------
t('portal grava quanto o fornecedor consegue entregar', () => {
  const r = db.prepare('SELECT quantidadeDisponivel q FROM cotacao_respostas WHERE cotacaoFornecedorId=? AND cotacaoItemId=?').get(CF1, ITEM_A);
  assert(r.q === 30, 'disponível gravado: ' + r.q);
});

t('em branco significa atende tudo, não zero', () => {
  const r = db.prepare('SELECT quantidadeDisponivel q FROM cotacao_respostas WHERE cotacaoFornecedorId=? AND cotacaoItemId=?').get(CF3, ITEM_A);
  assert(r.q === null, 'deveria ficar null: ' + r.q);
});

t('disponibilidade acima do pedido é aparada', () => {
  assert(normalizarDisponivel(500, 100) === 100, 'não aparou');
  assert(normalizarDisponivel('', 100) === null, 'branco vira null');
  assert(normalizarDisponivel(-5, 100) === null, 'negativo vira null');
  assert(normalizarDisponivel(0, 100) === 0, 'zero é resposta válida (não atende)');
});

// ---------- rateio manual ----------
t('um item pode ser dividido entre três fornecedores', () => {
  const r = chamar('/api/cotacoes/:id/rateio', 'post', { params: { id: String(COT) }, body: { rateios: [
    { cotacaoItemId: ITEM_A, cotacaoFornecedorId: CF1, quantidade: 30 },
    { cotacaoItemId: ITEM_A, cotacaoFornecedorId: CF2, quantidade: 50 },
    { cotacaoItemId: ITEM_A, cotacaoFornecedorId: CF3, quantidade: 20 },
  ] } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.gravados === 3, 'gravados: ' + r.out.gravados);
  assert(!r.out.parciais.length, 'item completo não é parcial');
});

t('o rateio sobrevive ao recarregar a página', () => {
  const d = det();
  assert(d.rateios.length === 3, 'rateios: ' + d.rateios.length);
  const cob = d.cobertura.find(c => c.cotacaoItemId === ITEM_A);
  assert(cob.alocado === 100 && cob.faltando === 0, JSON.stringify(cob));
});

t('não deixa alocar mais que a necessidade do item', () => {
  const r = chamar('/api/cotacoes/:id/rateio', 'post', { params: { id: String(COT) }, body: { rateios: [
    { cotacaoItemId: ITEM_A, cotacaoFornecedorId: CF3, quantidade: 101 },
  ] } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/necessidade de 100/.test(r.out.error), 'erro: ' + r.out.error);
});

t('não deixa comprar mais do que o fornecedor tem', () => {
  const r = chamar('/api/cotacoes/:id/rateio', 'post', { params: { id: String(COT) }, body: { rateios: [
    { cotacaoItemId: ITEM_A, cotacaoFornecedorId: CF1, quantidade: 40 },
  ] } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/só tem 30/.test(r.out.error), 'erro: ' + r.out.error);
});

t('recusa fornecedor que não cotou o item', () => {
  const r = chamar('/api/cotacoes/:id/rateio', 'post', { params: { id: String(COT) }, body: { rateios: [
    { cotacaoItemId: ITEM_B, cotacaoFornecedorId: CF2, quantidade: 1 },
  ] } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/não cotou/.test(r.out.error), 'erro: ' + r.out.error);
});

t('recusa o mesmo fornecedor duas vezes no mesmo item', () => {
  const r = chamar('/api/cotacoes/:id/rateio', 'post', { params: { id: String(COT) }, body: { rateios: [
    { cotacaoItemId: ITEM_A, cotacaoFornecedorId: CF2, quantidade: 10 },
    { cotacaoItemId: ITEM_A, cotacaoFornecedorId: CF2, quantidade: 10 },
  ] } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/duas vezes/.test(r.out.error), 'erro: ' + r.out.error);
});

t('rateio parcial é aceito, mas volta sinalizado', () => {
  const r = chamar('/api/cotacoes/:id/rateio', 'post', { params: { id: String(COT) }, body: { rateios: [
    { cotacaoItemId: ITEM_A, cotacaoFornecedorId: CF1, quantidade: 30 },
  ] } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.parciais.length === 1, 'parciais: ' + JSON.stringify(r.out.parciais));
  assert(r.out.parciais[0].faltando === 70, 'faltando: ' + r.out.parciais[0].faltando);
});

// ---------- sugestão ----------
t('sugestão preenche pelo menor preço respeitando o estoque de cada um', () => {
  const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(COT);
  const { rateios, descobertos } = sugerirRateio(db, cot);
  const doA = rateios.filter(r => r.cotacaoItemId === ITEM_A);
  assert(doA.length === 3, 'esperado 3 fornecedores no item A: ' + doA.length);
  // 30 do barato (só tem 30), 50 do médio (só tem 50), 20 do caro (ilimitado)
  assert(doA[0].cotacaoFornecedorId === CF1 && doA[0].quantidade === 30, JSON.stringify(doA[0]));
  assert(doA[1].cotacaoFornecedorId === CF2 && doA[1].quantidade === 50, JSON.stringify(doA[1]));
  assert(doA[2].cotacaoFornecedorId === CF3 && doA[2].quantidade === 20, JSON.stringify(doA[2]));
  assert(!descobertos.some(x => x.cotacaoItemId === ITEM_A), 'item A não deveria ficar descoberto');
});

t('sugestão avisa o que ninguém consegue cobrir', () => {
  const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(COT);
  const { rateios, descobertos } = sugerirRateio(db, cot);
  // Item B: o caro tem 4 a 90, o barato tem tudo a 100 → cobre 10, sem falta
  const doB = rateios.filter(r => r.cotacaoItemId === ITEM_B);
  assert(doB[0].cotacaoFornecedorId === CF3 && doB[0].quantidade === 4, JSON.stringify(doB[0]));
  assert(doB[1].cotacaoFornecedorId === CF1 && doB[1].quantidade === 6, JSON.stringify(doB[1]));
  assert(!descobertos.length, 'nada deveria faltar: ' + JSON.stringify(descobertos));
});

t('quando ninguém tem o bastante, a falta é reportada', () => {
  const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(COT);
  db.prepare('UPDATE cotacao_respostas SET quantidadeDisponivel = 2 WHERE cotacaoItemId = ? AND cotacaoFornecedorId = ?').run(ITEM_B, CF1);
  const { descobertos } = sugerirRateio(db, cot);
  const b = descobertos.find(x => x.cotacaoItemId === ITEM_B);
  assert(b && b.faltando === 4, 'faltando: ' + JSON.stringify(descobertos));
  db.prepare('UPDATE cotacao_respostas SET quantidadeDisponivel = NULL WHERE cotacaoItemId = ? AND cotacaoFornecedorId = ?').run(ITEM_B, CF1);
});

t('endpoint de sugestão responde', () => {
  const r = chamar('/api/cotacoes/:id/sugerir-rateio', 'get', { params: { id: String(COT) } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.rateios.length === 5, 'linhas sugeridas: ' + r.out.rateios.length);
});

// ---------- conclusão ----------
t('gera um pedido de compra por fornecedor, com a quantidade de cada um', () => {
  const rateios = [
    { cotacaoItemId: ITEM_A, cotacaoFornecedorId: CF1, quantidade: 30 },
    { cotacaoItemId: ITEM_A, cotacaoFornecedorId: CF2, quantidade: 50 },
    { cotacaoItemId: ITEM_A, cotacaoFornecedorId: CF3, quantidade: 20 },
    { cotacaoItemId: ITEM_B, cotacaoFornecedorId: CF3, quantidade: 4 },
    { cotacaoItemId: ITEM_B, cotacaoFornecedorId: CF1, quantidade: 6 },
  ];
  const r = chamar('/api/cotacoes/:id/concluir', 'post', { params: { id: String(COT) }, body: { rateios } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.pedidos.length === 3, 'pedidos: ' + r.out.pedidos.length);

  // Barato: 30 x 10 (A) + 6 x 100 (B) = 900
  const pBarato = r.out.pedidos.find(p => p.fornecedorId === F1);
  assert(perto(pBarato.valorTotal, 900), 'valor do barato: ' + pBarato.valorTotal);
  // Caro: 20 x 15 (A) + 4 x 90 (B) = 660
  const pCaro = r.out.pedidos.find(p => p.fornecedorId === F3);
  assert(perto(pCaro.valorTotal, 660), 'valor do caro: ' + pCaro.valorTotal);
  // Médio: 50 x 12 = 600
  const pMedio = r.out.pedidos.find(p => p.fornecedorId === F2);
  assert(perto(pMedio.valorTotal, 600), 'valor do médio: ' + pMedio.valorTotal);
});

t('as quantidades chegam certas nos itens do pedido de compra', () => {
  const linhas = db.prepare(`SELECT pc.fornecedorId, i.produtoId, i.quantidade, i.custoUnitario
    FROM pedido_compra_itens i JOIN pedidos_compra pc ON pc.id = i.pedidoCompraId
    ORDER BY pc.fornecedorId, i.produtoId`).all();
  assert(linhas.length === 5, 'linhas geradas: ' + linhas.length);
  const a1 = linhas.find(l => l.fornecedorId === F1 && l.produtoId === 1);
  assert(a1.quantidade === 30 && a1.custoUnitario === 10, JSON.stringify(a1));
  const b3 = linhas.find(l => l.fornecedorId === F3 && l.produtoId === 2);
  assert(b3.quantidade === 4 && b3.custoUnitario === 90, JSON.stringify(b3));
  // A soma por produto tem que fechar com a necessidade da cotação
  const somaA = linhas.filter(l => l.produtoId === 1).reduce((s, l) => s + l.quantidade, 0);
  assert(somaA === 100, 'soma do produto A: ' + somaA);
});

t('cotação concluída não aceita mais rateio', () => {
  const r = chamar('/api/cotacoes/:id/rateio', 'post', { params: { id: String(COT) }, body: { rateios: [
    { cotacaoItemId: ITEM_A, cotacaoFornecedorId: CF1, quantidade: 1 },
  ] } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/concluida/.test(r.out.error), 'erro: ' + r.out.error);
});

// ---------- compatibilidade com o formato antigo ----------
t('escolha sem quantidade continua levando o item inteiro', () => {
  const n = chamar('/api/cotacoes', 'post', { body: {
    descricao: 'Formato antigo',
    itens: [{ produtoId: 1, descricao: 'Produto A', quantidade: 7, unidade: 'UN' }],
    fornecedoresIds: [F3],
  } });
  const c2 = n.out.id;
  chamar('/api/cotacoes/:id/enviar', 'post', { params: { id: String(c2) } });
  const d2 = chamar('/api/cotacoes/:id', 'get', { params: { id: String(c2) } }).out;
  const it2 = d2.itens[0].id, cf2 = d2.fornecedores[0].id;
  const tok = db.prepare('SELECT tokenPublico FROM cotacao_fornecedores WHERE id = ?').get(cf2).tokenPublico;
  chamar('/api/cotacao-publica/:token', 'post', { params: { token: tok },
    body: { respostas: [{ cotacaoItemId: it2, precoUnitario: 3 }] } });

  const r = chamar('/api/cotacoes/:id/concluir', 'post', { params: { id: String(c2) },
    body: { escolhas: [{ cotacaoItemId: it2, cotacaoFornecedorId: cf2 }] } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(perto(r.out.pedidos[0].valorTotal, 21), 'valor: ' + r.out.pedidos[0].valorTotal);
});

t('concluir sem rateio nenhum é recusado com motivo', () => {
  const n = chamar('/api/cotacoes', 'post', { body: {
    itens: [{ produtoId: 1, descricao: 'Produto A', quantidade: 1 }], fornecedoresIds: [F1] } });
  chamar('/api/cotacoes/:id/enviar', 'post', { params: { id: String(n.out.id) } });
  const r = chamar('/api/cotacoes/:id/concluir', 'post', { params: { id: String(n.out.id) }, body: {} });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/Nenhum item rateado/.test(r.out.error), 'erro: ' + r.out.error);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
