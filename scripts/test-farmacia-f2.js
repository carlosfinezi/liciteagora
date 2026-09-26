#!/usr/bin/env node
/**
 * test-farmacia-f2.js — Fase 2: lote obrigatório e FEFO na venda.
 *
 * A emissão em si depende de certificado + SEFAZ e não cabe em teste. O que
 * cabe — e é o que muda aqui — é a parte determinística: a escolha do lote
 * (validade mais curta primeiro, não o mais antigo), o bloqueio do vencido, o
 * rateio quando a quantidade atravessa dois lotes, e os efeitos gravados
 * (movimentação por lote + baixa de saldo). `aplicarEfeitosDaNatureza` é
 * exportada por nfce-routes justamente para isto.
 *
 * Roda contra `labfiscal`, cria a própria massa e limpa no fim.
 * Uso: node scripts/test-farmacia-f2.js
 */
const BASE = require('path').join(__dirname, '..');
const Database = require(BASE + '/node_modules/better-sqlite3');
const { copiaDoTenant } = require('./banco-de-teste');
const express = require(BASE + '/node_modules/express');

const { initFarmaciaSchema } = require(BASE + '/farmacia/farmacia-schema');
const { registrarRotasFarmacia } = require(BASE + '/farmacia/farmacia-routes');
const {
  selecionarLotesFEFO, resolverLotesDaVenda, conferirLoteManual, baixarAlocacoes, hojeBrasilia,
} = require(BASE + '/farmacia/fefo');
const { aplicarEfeitosDaNatureza } = require(BASE + '/nfce-routes');

const db = new Database(copiaDoTenant('labfiscal'));

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

initFarmaciaSchema(db);

const PREFIXO = 'TESTE-FARM-F2-';
function limpar() {
  const ids = db.prepare('SELECT id FROM produtos WHERE sku LIKE ?').all(PREFIXO + '%').map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM movimentacoes_estoque WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM lotes WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM farmacia_medicamento_specs WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM nfce_itens WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
  }
}
limpar();

const flagOriginal = db.prepare("SELECT valor FROM config WHERE chave = 'farmacia_enabled'").get();
function setFlag(v) {
  db.prepare(`INSERT INTO config (chave, valor) VALUES ('farmacia_enabled', ?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(String(v));
}
setFlag(1);

const hoje = hojeBrasilia();
const dia = (n) => new Date(Date.parse(hoje + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// ─── Massa: um medicamento com 3 lotes de validades embaralhadas ─────────────
secao('FEFO: quem vence primeiro sai primeiro');

const idMed = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, ativo, rastreiaLote)
  VALUES (?, 'DIPIRONA TESTE 500MG', 'UN', 10, '30049099', 1, 1)`).run(PREFIXO + 'MED').lastInsertRowid;

// Inseridos FORA da ordem de validade de propósito: se a implementação fosse
// FIFO (por id/entrada), o lote errado sairia primeiro e o teste pegaria.
const loteA = db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, ativo)
  VALUES (?, 'LOTE-LONGE', ?, ?, 10, 10, 1)`).run(idMed, dia(-200), dia(365)).lastInsertRowid;
const loteB = db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, ativo)
  VALUES (?, 'LOTE-PERTO', ?, ?, 3, 3, 1)`).run(idMed, dia(-30), dia(20)).lastInsertRowid;
const loteC = db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, ativo)
  VALUES (?, 'LOTE-MEIO', ?, ?, 5, 5, 1)`).run(idMed, dia(-100), dia(90)).lastInsertRowid;

let r = selecionarLotesFEFO(db, idMed, 1);
assert(r.alocacoes.length === 1 && r.alocacoes[0].loteId === loteB,
  'saída de 1 unidade pega o lote de validade MAIS CURTA (não o mais antigo de entrada)',
  JSON.stringify(r.alocacoes.map(a => a.numero)));

r = selecionarLotesFEFO(db, idMed, 5);
assert(r.alocacoes.length === 2 && r.alocacoes[0].loteId === loteB && r.alocacoes[1].loteId === loteC,
  'quantidade que atravessa lotes é rateada na ordem de validade',
  JSON.stringify(r.alocacoes.map(a => `${a.numero}:${a.quantidade}`)));
assert(r.alocacoes[0].quantidade === 3 && r.alocacoes[1].quantidade === 2,
  'rateio esgota o lote mais curto antes de tocar no próximo',
  JSON.stringify(r.alocacoes.map(a => a.quantidade)));
assert(r.faltante === 0, 'sem faltante quando há saldo suficiente');

r = selecionarLotesFEFO(db, idMed, 100);
assert(r.faltante === 82, 'faltante é a diferença entre pedido e saldo elegível', `faltante=${r.faltante}`);

// ─── Vencido ─────────────────────────────────────────────────────────────────
secao('Bloqueio de lote vencido');

const loteVencido = db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, ativo)
  VALUES (?, 'LOTE-VENCIDO', ?, ?, 50, 50, 1)`).run(idMed, dia(-400), dia(-1)).lastInsertRowid;

r = selecionarLotesFEFO(db, idMed, 1);
assert(r.alocacoes[0].loteId === loteB,
  'lote vencido NÃO entra na fila, mesmo sendo o de validade mais curta',
  JSON.stringify(r.alocacoes.map(a => a.numero)));

r = selecionarLotesFEFO(db, idMed, 1, { permitirVencido: true });
assert(r.alocacoes[0].loteId === loteVencido,
  'com permitirVencido o lote vencido volta para a fila (usado em inventário/ajuste)');

const erroManual = conferirLoteManual(db, idMed, loteVencido, 1);
assert(typeof erroManual === 'string' && /venceu/.test(erroManual),
  'escolher o lote vencido à mão é recusado com o motivo', String(erroManual));

assert(conferirLoteManual(db, idMed, loteB, 1) === null, 'lote válido escolhido à mão é aceito');
assert(/saldo/.test(String(conferirLoteManual(db, idMed, loteB, 999))),
  'lote sem saldo suficiente é recusado');

// Outro produto: lote de um não serve para o outro.
const idOutro = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo, rastreiaLote)
  VALUES (?, 'OUTRO TESTE', 'UN', 5, 1, 1)`).run(PREFIXO + 'OUT').lastInsertRowid;
assert(/outro produto/.test(String(conferirLoteManual(db, idOutro, loteB, 1))),
  'lote de outro produto é recusado');

// ─── Resolução da venda inteira ──────────────────────────────────────────────
secao('Resolução dos lotes da venda');

const idSimples = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo, rastreiaLote)
  VALUES (?, 'ITEM SEM LOTE', 'UN', 7, 1, 0)`).run(PREFIXO + 'SEM').lastInsertRowid;

let resolvido = resolverLotesDaVenda(db, [
  { produtoId: idMed, quantidade: 2 },
  { produtoId: idSimples, quantidade: 1 },
]);
assert(resolvido[0].alocacoes.length === 1 && resolvido[0].alocacoes[0].loteId === loteB,
  'item que rastreia lote recebe alocação FEFO');
assert(resolvido[1].alocacoes.length === 0,
  'produto que NÃO rastreia lote passa sem alocação (comportamento histórico)');

let erro = null;
try { resolverLotesDaVenda(db, [{ produtoId: idMed, quantidade: 999 }]); }
catch (e) { erro = e.message; }
assert(erro && /faltam/.test(erro), 'venda sem saldo válido falha com mensagem clara', String(erro));

// O caso que o balcão precisa entender: tem estoque, mas é todo vencido.
const idSoVencido = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo, rastreiaLote)
  VALUES (?, 'SO VENCIDO', 'UN', 9, 1, 1)`).run(PREFIXO + 'VENC').lastInsertRowid;
db.prepare(`INSERT INTO lotes (produtoId, numero, dataValidade, quantidadeInicial, saldoAtual, ativo)
  VALUES (?, 'V1', ?, 30, 30, 1)`).run(idSoVencido, dia(-5));
erro = null;
try { resolverLotesDaVenda(db, [{ produtoId: idSoVencido, quantidade: 1 }]); }
catch (e) { erro = e.message; }
assert(erro && /vencido/.test(erro),
  'produto com saldo só em lote vencido dá mensagem específica, não "sem estoque"', String(erro));

erro = null;
try { resolverLotesDaVenda(db, [{ produtoId: idMed, quantidade: 1, loteId: loteVencido }]); }
catch (e) { erro = e.message; }
assert(erro && /venceu/.test(erro), 'lote vencido forçado à mão na venda é barrado', String(erro));

// ─── Efeitos: movimentação por lote e baixa de saldo ─────────────────────────
secao('Efeitos da venda (movimentação por lote + baixa)');

const natureza = db.prepare(`SELECT * FROM tipos_operacao
  WHERE ativo = 1 AND movimentaEstoque = 1 ORDER BY id LIMIT 1`).get();
if (!natureza) { console.error('Sem tipo de operação com movimentaEstoque no labfiscal'); process.exit(1); }

const saldoBantes = db.prepare('SELECT saldoAtual FROM lotes WHERE id = ?').get(loteB).saldoAtual;
const saldoCantes = db.prepare('SELECT saldoAtual FROM lotes WHERE id = ?').get(loteC).saldoAtual;

const NFCE_ID = 999777; // id sintético: o teste não emite nota de verdade
db.prepare('DELETE FROM movimentacoes_estoque WHERE origem = ? AND origemId = ?').run('nfce', NFCE_ID);

const itensVenda = [{ produtoId: idMed, quantidade: 5, precoUnitario: 10, descricao: 'DIPIRONA TESTE 500MG' }];
const lotesDaVenda = resolverLotesDaVenda(db, itensVenda);

aplicarEfeitosDaNatureza(db, {
  nfceId: NFCE_ID, numero: 1, natureza,
  politica: null, pessoaId: null,
  itens: itensVenda, valorTotal: 50, dataEmissao: hoje, tPag: '01',
  lotesDaVenda,
});

const movs = db.prepare(`SELECT * FROM movimentacoes_estoque
  WHERE origem = 'nfce' AND origemId = ? ORDER BY id`).all(NFCE_ID);
assert(movs.length === 2, 'venda que atravessa 2 lotes gera 2 movimentações', `n=${movs.length}`);
assert(movs.every(m => m.loteId), 'toda movimentação carrega o loteId');
assert(movs[0].loteId === loteB && movs[0].quantidade === 3, 'primeira movimentação é do lote de validade mais curta');
assert(movs[1].loteId === loteC && movs[1].quantidade === 2, 'segunda movimentação completa no lote seguinte');
assert(movs.reduce((s, m) => s + m.quantidade, 0) === 5, 'soma das movimentações bate com a quantidade vendida');
assert(movs.every(m => /lote/.test(m.observacao || '')), 'observação da movimentação cita o lote');

const saldoBdepois = db.prepare('SELECT saldoAtual FROM lotes WHERE id = ?').get(loteB).saldoAtual;
const saldoCdepois = db.prepare('SELECT saldoAtual FROM lotes WHERE id = ?').get(loteC).saldoAtual;
assert(saldoBdepois === saldoBantes - 3, 'saldo do lote curto foi baixado', `${saldoBantes} → ${saldoBdepois}`);
assert(saldoCdepois === saldoCantes - 2, 'saldo do lote seguinte foi baixado', `${saldoCantes} → ${saldoCdepois}`);

// Produto sem rastreio continua como sempre: uma movimentação, sem lote.
db.prepare('DELETE FROM movimentacoes_estoque WHERE origem = ? AND origemId = ?').run('nfce', NFCE_ID + 1);
const itensSimples = [{ produtoId: idSimples, quantidade: 2, precoUnitario: 7, descricao: 'ITEM SEM LOTE' }];
aplicarEfeitosDaNatureza(db, {
  nfceId: NFCE_ID + 1, numero: 2, natureza, politica: null, pessoaId: null,
  itens: itensSimples, valorTotal: 14, dataEmissao: hoje, tPag: '01',
  lotesDaVenda: resolverLotesDaVenda(db, itensSimples),
});
const movsSimples = db.prepare(`SELECT * FROM movimentacoes_estoque WHERE origem='nfce' AND origemId = ?`).all(NFCE_ID + 1);
assert(movsSimples.length === 1 && movsSimples[0].loteId === null,
  'produto sem rastreio de lote gera uma movimentação sem loteId');

// Módulo desligado: nada de lote, comportamento idêntico ao de antes.
setFlag(0);
db.prepare('DELETE FROM movimentacoes_estoque WHERE origem = ? AND origemId = ?').run('nfce', NFCE_ID + 2);
aplicarEfeitosDaNatureza(db, {
  nfceId: NFCE_ID + 2, numero: 3, natureza, politica: null, pessoaId: null,
  itens: [{ produtoId: idMed, quantidade: 1, precoUnitario: 10, descricao: 'X' }],
  valorTotal: 10, dataEmissao: hoje, tPag: '01',
  lotesDaVenda: null,
});
const movsOff = db.prepare(`SELECT * FROM movimentacoes_estoque WHERE origem='nfce' AND origemId = ?`).all(NFCE_ID + 2);
assert(movsOff.length === 1 && movsOff[0].loteId === null,
  'com o módulo desligado o PDV se comporta como antes (sem lote)');
setFlag(1);

// ─── Rota do balcão ──────────────────────────────────────────────────────────
secao('Rota /api/farmacia/fefo');

const app = express();
app.use(express.json());
registrarRotasFarmacia(app, db);
function chamar(p, m, o = {}) {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  let out = null, st = 200;
  const res = { json: x => { out = x; return res; }, status: c => { st = c; return res; } };
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, user: o.user, headers: {} };
  let i = 0; const stack = l.route.stack;
  const next = () => { const h = stack[i++]; if (h) h.handle(req, res, next); };
  next();
  return { out, st };
}

// A expectativa é calculada, não fixa: os blocos acima já consumiram saldo, e
// o lote FEFO do momento é o de menor validade que ainda tem saldo.
const esperadoFefo = db.prepare(`SELECT id FROM lotes
  WHERE produtoId = ? AND ativo = 1 AND saldoAtual > 0 AND date(dataValidade) >= date(?)
  ORDER BY date(dataValidade) ASC, id ASC LIMIT 1`).get(idMed, hoje).id;

let x = chamar('/api/farmacia/fefo/:produtoId', 'get', { params: { produtoId: idMed }, query: { quantidade: '1' } });
assert(x.st === 200 && x.out.rastreiaLote === true, 'rota informa que o produto rastreia lote');
assert(x.out.alocacoes[0].loteId === esperadoFefo,
  'rota sugere o lote FEFO do momento (lote esgotado sai da fila)',
  `sugeriu ${x.out.alocacoes[0].loteId}, esperado ${esperadoFefo}`);
assert(x.out.disponiveis.length >= 2 && !x.out.disponiveis.some(l => l.id === loteVencido),
  'lista de troca manual traz os lotes válidos e omite o vencido');

x = chamar('/api/farmacia/fefo/:produtoId', 'get', { params: { produtoId: idSimples } });
assert(x.out.rastreiaLote === false && x.out.alocacoes.length === 0,
  'produto sem rastreio responde rastreiaLote:false');

x = chamar('/api/farmacia/fefo/:produtoId', 'get', { params: { produtoId: 999999 } });
assert(x.st === 404, 'produto inexistente devolve 404');

// ─── Limpeza ─────────────────────────────────────────────────────────────────
for (const nid of [NFCE_ID, NFCE_ID + 1, NFCE_ID + 2]) {
  db.prepare('DELETE FROM movimentacoes_estoque WHERE origem = ? AND origemId = ?').run('nfce', nid);
}
limpar();
if (flagOriginal) setFlag(flagOriginal.valor);
else db.prepare("DELETE FROM config WHERE chave = 'farmacia_enabled'").run();

const sobrou = db.prepare('SELECT COUNT(*) n FROM produtos WHERE sku LIKE ?').get(PREFIXO + '%').n;
assert(sobrou === 0, 'massa de teste removida do tenant');

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
