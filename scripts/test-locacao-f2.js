#!/usr/bin/env node
/**
 * test-locacao-f2.js — Fase 2: disponibilidade por período.
 *
 * É o teste mais importante do módulo. A sobreposição de janelas é o que
 * decide se duas locações podem coexistir, e errar aqui significa alugar duas
 * vezes a mesma máquina para o mesmo dia — o erro que o cliente descobre no
 * canteiro de obra, não no sistema.
 *
 * Casos cobertos: encaixe exato (com e sem turnaround), sobreposição parcial
 * nas duas pontas, contenção, janela adjacente, série específica vs genérica,
 * bloqueio de manutenção, e a interação com a reserva de VENDA
 * (reservas_estoque), que é a outra fonte de ocupação.
 *
 * Uso: node scripts/test-locacao-f2.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const express = require(BASE + '/node_modules/express');

const { initLocacaoSchema } = require(BASE + '/locacao/locacao-schema');
const { protegerConfig } = require('./locacao-teste-util');
const { registrarRotasLocacao } = require(BASE + '/locacao/locacao-routes');
const D = require(BASE + '/locacao/disponibilidade');

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
function secao(t) { console.log(`\n── ${t}`); }

// ─── Cenário ──────────────────────────────────────────────────────────────────
// Um produto com 3 unidades em estoque, sem série; outro com série.
const SKU_A = 'TESTE-LOC-F2-A';
const SKU_B = 'TESTE-LOC-F2-B';

function limpar() {
  const ids = db.prepare('SELECT id FROM produtos WHERE sku IN (?, ?)').all(SKU_A, SKU_B).map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM locacao_reservas WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_bloqueios WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_item_specs WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_tarifas WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM movimentacoes_estoque WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM serial_numbers WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM reservas_estoque WHERE produtoId = ?').run(id);
  }
  db.prepare('DELETE FROM produtos WHERE sku IN (?, ?)').run(SKU_A, SKU_B);
}
limpar();

const prodA = db.prepare(`
  INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo, rastreiaSerial)
  VALUES (?, 'Andaime (teste F2)', 'UN', 0, 1, 0)
`).run(SKU_A).lastInsertRowid;

const prodB = db.prepare(`
  INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo, rastreiaSerial)
  VALUES (?, 'Compactador (teste F2)', 'UN', 0, 1, 1)
`).run(SKU_B).lastInsertRowid;

// Estoque: 3 unidades de A, 2 de B.
const colsMov = db.prepare('PRAGMA table_info(movimentacoes_estoque)').all().map(c => c.name);
const temData = colsMov.includes('data');
function entrada(produtoId, qtd) {
  const campos = ['produtoId', 'tipo', 'quantidade'];
  const valores = [produtoId, 'entrada', qtd];
  if (temData) { campos.push('data'); valores.push('2026-01-01 00:00:00'); }
  db.prepare(`INSERT INTO movimentacoes_estoque (${campos.join(',')})
              VALUES (${campos.map(() => '?').join(',')})`).run(...valores);
}
entrada(prodA, 3);
entrada(prodB, 2);

const serie1 = db.prepare("INSERT INTO serial_numbers (produtoId, numero, status) VALUES (?, 'SN-F2-001', 'disponivel')").run(prodB).lastInsertRowid;
const serie2 = db.prepare("INSERT INTO serial_numbers (produtoId, numero, status) VALUES (?, 'SN-F2-002', 'disponivel')").run(prodB).lastInsertRowid;

// Spec: A sem série e sem preparo; B com série e 4h de preparo.
db.prepare(`INSERT INTO locacao_item_specs (produtoId, alugavel, exigeSerie, horasPreparo)
            VALUES (?, 1, 0, 0)`).run(prodA);
db.prepare(`INSERT INTO locacao_item_specs (produtoId, alugavel, exigeSerie, horasPreparo)
            VALUES (?, 1, 1, 4)`).run(prodB);

// ─── Disponibilidade limpa ────────────────────────────────────────────────────
secao('Disponibilidade sem nenhuma reserva');
let d = D.disponibilidade(db, prodA, '2026-09-10 08:00', '2026-09-15 08:00');
assert(d.ok, 'consulta responde ok', JSON.stringify(d));
eq(d.saldoFisico, 3, 'saldo físico é 3');
eq(d.ocupadoLocacao, 0, 'nada ocupado');
eq(d.disponivel, 3, 'disponível = 3');

d = D.disponibilidade(db, prodA, '2026-09-15 08:00', '2026-09-10 08:00');
assert(!d.ok && /depois do início/.test(d.erro), 'período invertido é recusado', JSON.stringify(d));

d = D.disponibilidade(db, 99999999, '2026-09-10 08:00', '2026-09-15 08:00');
assert(!d.ok && /não é alugável/.test(d.erro), 'produto sem spec não é alugável', JSON.stringify(d));

// ─── Sobreposição ─────────────────────────────────────────────────────────────
secao('Sobreposição de janelas (o cálculo que define o módulo)');

// Reserva base: 10/09 08:00 → 15/09 08:00, 1 unidade.
D.criarReserva(db, {
  produtoId: prodA, quantidade: 1,
  inicio: '2026-09-10 08:00', fim: '2026-09-15 08:00',
  documentoTipo: 'locacao', documentoId: 1001,
});

const casos = [
  // [inicio, fim, ocupadoEsperado, descrição]
  ['2026-09-10 08:00', '2026-09-15 08:00', 1, 'janela idêntica conflita'],
  ['2026-09-12 08:00', '2026-09-13 08:00', 1, 'janela contida conflita'],
  ['2026-09-08 08:00', '2026-09-20 08:00', 1, 'janela que contém a reserva conflita'],
  ['2026-09-08 08:00', '2026-09-11 08:00', 1, 'sobreposição pela esquerda conflita'],
  ['2026-09-14 08:00', '2026-09-18 08:00', 1, 'sobreposição pela direita conflita'],
  ['2026-09-05 08:00', '2026-09-10 08:00', 0, 'janela que TERMINA quando a reserva começa NÃO conflita'],
  ['2026-09-15 08:00', '2026-09-20 08:00', 0, 'janela que COMEÇA quando a reserva termina NÃO conflita'],
  ['2026-09-01 08:00', '2026-09-05 08:00', 0, 'janela totalmente antes não conflita'],
  ['2026-09-20 08:00', '2026-09-25 08:00', 0, 'janela totalmente depois não conflita'],
  ['2026-09-14 23:59', '2026-09-15 00:00', 1, 'último minuto da reserva ainda conflita'],
];
for (const [i, f, esperado, msg] of casos) {
  eq(D.ocupadoPorLocacao(db, prodA, i, f), esperado, msg);
}

secao('Disponibilidade com reserva ativa');
d = D.disponibilidade(db, prodA, '2026-09-12 08:00', '2026-09-13 08:00');
eq(d.disponivel, 2, '1 das 3 unidades ocupada → sobram 2');

// A própria locação não se vê como ocupada.
d = D.disponibilidade(db, prodA, '2026-09-12 08:00', '2026-09-13 08:00', { excetoContratoId: 1001 });
eq(d.disponivel, 3, 'excetoContratoId ignora a própria reserva');

// Esgotar o saldo
D.criarReserva(db, { produtoId: prodA, quantidade: 2, inicio: '2026-09-11 08:00', fim: '2026-09-14 08:00',
                     documentoTipo: 'locacao', documentoId: 1002 });
d = D.disponibilidade(db, prodA, '2026-09-12 08:00', '2026-09-13 08:00');
eq(d.disponivel, 0, '3 unidades ocupadas → disponível 0');

let erro = null;
try {
  D.criarReserva(db, { produtoId: prodA, quantidade: 1, inicio: '2026-09-12 08:00', fim: '2026-09-13 08:00',
                       documentoTipo: 'locacao', documentoId: 1003 });
} catch (e) { erro = e.message; }
assert(erro && /indisponível/.test(erro), 'reserva acima do disponível é recusada', erro);
assert(erro && /Ocupado por/.test(erro), 'a recusa diz QUEM está ocupando', erro);

// Overbooking explícito passa.
const rOver = D.criarReserva(db,
  { produtoId: prodA, quantidade: 1, inicio: '2026-09-12 08:00', fim: '2026-09-13 08:00',
    documentoTipo: 'locacao', documentoId: 1004 },
  { permitirOverbooking: true });
assert(!!rOver.id, 'overbooking explícito é permitido quando o tenant liga a opção');
db.prepare('DELETE FROM locacao_reservas WHERE id = ?').run(rOver.id);

// Cancelar libera.
D.cancelarReservasDoDocumento(db, 'locacao', 1002);
d = D.disponibilidade(db, prodA, '2026-09-12 08:00', '2026-09-13 08:00');
eq(d.disponivel, 2, 'cancelar a reserva de 2 unidades devolve o saldo');

// Status 'consumida' (já saiu fisicamente) continua ocupando.
db.prepare("UPDATE locacao_reservas SET status='consumida' WHERE documentoId = 1001").run();
d = D.disponibilidade(db, prodA, '2026-09-12 08:00', '2026-09-13 08:00');
eq(d.ocupadoLocacao, 1, "reserva 'consumida' (item na rua) continua ocupando");
db.prepare("UPDATE locacao_reservas SET status='ativa' WHERE documentoId = 1001").run();

// ─── Turnaround (horasPreparo) ────────────────────────────────────────────────
secao('Turnaround: o encaixe exato só é recusado quando há preparo');

D.criarReserva(db, {
  produtoId: prodB, serialNumberId: serie1, quantidade: 1,
  inicio: '2026-10-01 08:00', fim: '2026-10-05 10:00',
  documentoTipo: 'locacao', documentoId: 2001,
});
const reservaB = db.prepare('SELECT * FROM locacao_reservas WHERE documentoId = 2001').get();
eq(reservaB.dataFim, '2026-10-05 14:00:00', 'dataFim gravado inclui as 4h de preparo');

eq(D.ocupadoPorLocacao(db, prodB, '2026-10-05 10:00', '2026-10-06 08:00', { serialNumberId: serie1 }), 1,
  'sair às 10h logo após a devolução das 10h conflita (ainda está em preparo)');
eq(D.ocupadoPorLocacao(db, prodB, '2026-10-05 14:00', '2026-10-06 08:00', { serialNumberId: serie1 }), 0,
  'sair às 14h, terminado o preparo, não conflita');

// ─── Série específica vs genérica ─────────────────────────────────────────────
secao('Série: a unidade reservada é a unidade bloqueada');
eq(D.ocupadoPorLocacao(db, prodB, '2026-10-02 08:00', '2026-10-03 08:00', { serialNumberId: serie1 }), 1,
  'a série 001 está ocupada');
eq(D.ocupadoPorLocacao(db, prodB, '2026-10-02 08:00', '2026-10-03 08:00', { serialNumberId: serie2 }), 0,
  'a série 002 continua livre');

let livres = D.seriaisDisponiveis(db, prodB, '2026-10-02 08:00', '2026-10-03 08:00');
eq(livres.length, 1, 'só uma série livre no período');
eq(livres[0].id, Number(serie2), 'a série livre é a 002');

livres = D.seriaisDisponiveis(db, prodB, '2026-11-01 08:00', '2026-11-02 08:00');
eq(livres.length, 2, 'fora do período as duas séries estão livres');

erro = null;
try {
  D.criarReserva(db, { produtoId: prodB, quantidade: 1, inicio: '2026-11-01 08:00', fim: '2026-11-02 08:00',
                       documentoTipo: 'locacao', documentoId: 2002 });
} catch (e) { erro = e.message; }
assert(erro && /exige número de série/.test(erro), 'produto com exigeSerie recusa reserva sem série', erro);

// REGRESSÃO (bug encontrado na validação): o limite para item com série era
// `1` FIXO, ignorando a ocupação daquela série. Como a quantidade é sempre 1,
// `1 > 1` era falso e a MESMA máquina era alugada duas vezes para os mesmos
// dias. A leitura (seriaisDisponiveis) respondia certo; só a escrita não
// validava.
erro = null;
try {
  D.criarReserva(db, { produtoId: prodB, serialNumberId: serie1, quantidade: 1,
                       inicio: '2026-10-02 08:00', fim: '2026-10-03 08:00',
                       documentoTipo: 'locacao', documentoId: 2003 });
} catch (e) { erro = e.message; }
assert(erro && /indispon/.test(erro),
  'a MESMA série não pode ser reservada duas vezes no mesmo período', erro || '*** ACEITOU ***');
eq(db.prepare("SELECT COUNT(*) n FROM locacao_reservas WHERE serialNumberId = ? AND status = 'ativa'").get(serie1).n, 1,
  'continua havendo só uma reserva ativa dessa série');

// A outra série, livre, continua reservável — a trava é da unidade, não do produto.
const rSerie2 = D.criarReserva(db, { produtoId: prodB, serialNumberId: serie2, quantidade: 1,
  inicio: '2026-10-02 08:00', fim: '2026-10-03 08:00', documentoTipo: 'locacao', documentoId: 2004 });
assert(!!rSerie2.id, 'a série livre continua podendo ser reservada no mesmo período');
db.prepare('DELETE FROM locacao_reservas WHERE id = ?').run(rSerie2.id);

secao('Overbooking dentro do MESMO documento');
// REGRESSÃO (bug encontrado na validação): `criarReserva` recebia
// `excetoContratoId = documentoId`, o que excluía do cálculo TODAS as
// reservas do documento — inclusive as que o laço de `confirmar` acabara de
// gravar para os itens anteriores. Um contrato com dois itens de 2 unidades
// passava com 3 em estoque.
db.prepare("DELETE FROM locacao_reservas WHERE documentoId IN (1001,1002,1004)").run();
D.criarReserva(db, { produtoId: prodA, quantidade: 2, inicio: '2027-03-01 08:00', fim: '2027-03-05 08:00',
                     documentoTipo: 'locacao', documentoId: 3001, locacaoItemId: 1 });
erro = null;
try {
  D.criarReserva(db, { produtoId: prodA, quantidade: 2, inicio: '2027-03-01 08:00', fim: '2027-03-05 08:00',
                       documentoTipo: 'locacao', documentoId: 3001, locacaoItemId: 2 });
} catch (e) { erro = e.message; }
assert(erro && /indispon/.test(erro),
  'segundo item do MESMO contrato não fura o saldo (estoque 3, pedido 2+2)', erro || '*** ACEITOU ***');
eq(db.prepare("SELECT COALESCE(SUM(quantidade),0) q FROM locacao_reservas WHERE produtoId = ? AND status='ativa'").get(prodA).q, 2,
  'total reservado não passa do estoque');
db.prepare("DELETE FROM locacao_reservas WHERE documentoId = 3001").run();
// Repõe o cenário das seções seguintes.
D.criarReserva(db, { produtoId: prodA, quantidade: 1, inicio: '2026-09-10 08:00', fim: '2026-09-15 08:00',
                     documentoTipo: 'locacao', documentoId: 1001 });

// ─── Bloqueio de manutenção ───────────────────────────────────────────────────
secao('Bloqueio (manutenção) sai da disponibilidade');
db.prepare(`INSERT INTO locacao_bloqueios (produtoId, quantidade, dataInicio, dataFim, motivo)
            VALUES (?, 1, '2026-12-01 00:00:00', '2026-12-10 00:00:00', 'manutenção preventiva')`).run(prodA);
d = D.disponibilidade(db, prodA, '2026-12-05 08:00', '2026-12-06 08:00');
eq(d.bloqueado, 1, 'bloqueio conta como ocupação');
eq(d.disponivel, 2, '3 unidades − 1 em manutenção = 2');

d = D.disponibilidade(db, prodA, '2026-12-20 08:00', '2026-12-21 08:00');
eq(d.bloqueado, 0, 'fora da janela do bloqueio nada é descontado');

// ─── Interação com a reserva de VENDA ─────────────────────────────────────────
secao('A outra fonte de ocupação: reservas_estoque (venda)');
// Uma reserva de venda não tem data — ocupa sempre. Precisa de pedido real:
// reservas_estoque tem FK para pedidos(id).
const pedidoId = db.prepare(`
  INSERT INTO pedidos (numero, dataPedido) VALUES ('TESTE-LOC-F2', '2026-09-01')
`).run().lastInsertRowid;
db.prepare(`INSERT INTO reservas_estoque (produtoId, quantidade, pedidoId, status)
            VALUES (?, 1, ?, 'ativa')`).run(prodA, pedidoId);
d = D.disponibilidade(db, prodA, '2026-09-25 08:00', '2026-09-26 08:00');
eq(d.reservadoVenda, 1, 'reserva de venda é enxergada pela locação');
eq(d.disponivel, 2, 'venda reservou 1 → sobram 2 para locação');
db.prepare('DELETE FROM reservas_estoque WHERE pedidoId = ?').run(pedidoId);
db.prepare('DELETE FROM pedidos WHERE id = ?').run(pedidoId);

// E o contrário: a locação NÃO pode ter contaminado reservas_estoque.
const colsCore = db.prepare('PRAGMA table_info(reservas_estoque)').all().map(c => c.name);
assert(!colsCore.includes('dataInicio'), 'reservas_estoque continua sem janela de datas');

// ─── Calendário ───────────────────────────────────────────────────────────────
secao('Calendário');
const grade = D.calendario(db, '2026-09-09', '2026-09-16', { produtoId: prodA });
assert(grade.ok, 'calendário responde ok');
eq(grade.dias.length, 7, 'grade de 7 dias');
const linhaA = grade.linhas.find(l => l.produtoId === Number(prodA));
assert(!!linhaA, 'produto aparece na grade');
const dia09 = linhaA.dias.find(x => x.dia === '2026-09-09');
const dia12 = linhaA.dias.find(x => x.dia === '2026-09-12');
eq(dia09.ocupado, 0, '09/09 (antes da reserva) está livre');
eq(dia12.ocupado, 1, '12/09 (dentro da reserva) está ocupado');

const gradeRuim = D.calendario(db, '2026-09-16', '2026-09-09');
assert(!gradeRuim.ok, 'calendário com período invertido é recusado');

// ─── Rotas ────────────────────────────────────────────────────────────────────
secao('Rotas da fase 2');
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

const flagOriginal = db.prepare("SELECT valor FROM config WHERE chave = 'locacao_enabled'").get();
db.prepare(`INSERT INTO config (chave, valor) VALUES ('locacao_enabled','1')
            ON CONFLICT(chave) DO UPDATE SET valor='1'`).run();

let r = chamar('/api/locacao/disponibilidade', 'get', {
  query: { produtoId: prodA, inicio: '2026-09-12 08:00', fim: '2026-09-13 08:00' },
});
assert(r.st === 200 && r.out.disponibilidade.disponivel === 2,
  'GET disponibilidade devolve 2', JSON.stringify(r.out.disponibilidade));
assert(Array.isArray(r.out.conflitos) && r.out.conflitos.length === 1,
  'GET disponibilidade lista o conflito', JSON.stringify(r.out.conflitos));

r = chamar('/api/locacao/disponibilidade', 'get', { query: { produtoId: prodA } });
assert(r.st === 400, 'faltando inicio/fim devolve 400');

r = chamar('/api/locacao/seriais', 'get', {
  query: { produtoId: prodB, inicio: '2026-10-02 08:00', fim: '2026-10-03 08:00' },
});
assert(r.st === 200 && r.out.seriais.length === 1, 'GET seriais devolve só a livre', JSON.stringify(r.out));

r = chamar('/api/locacao/calendario', 'get', { query: { de: '2026-09-09', ate: '2026-09-16', produtoId: prodA } });
assert(r.st === 200 && r.out.linhas.length === 1, 'GET calendario responde a grade');

r = chamar('/api/locacao/bloqueios', 'post', {
  body: { produtoId: prodA, inicio: '2027-01-01', fim: '2027-01-05', motivo: 'revisão' },
});
assert(r.st === 200 && r.out.bloqueio.id, 'POST bloqueio cria', JSON.stringify(r.out));
const bloqId = r.out.bloqueio.id;

r = chamar('/api/locacao/bloqueios', 'post', { body: { produtoId: prodA, inicio: '2027-01-05', fim: '2027-01-01', motivo: 'x' } });
assert(r.st === 400, 'bloqueio com período invertido é recusado');

r = chamar('/api/locacao/bloqueios', 'post', { body: { produtoId: prodA, inicio: '2027-01-01', fim: '2027-01-05' } });
assert(r.st === 400, 'bloqueio sem motivo é recusado');

r = chamar('/api/locacao/bloqueios/:id', 'delete', { params: { id: bloqId } });
assert(r.st === 200, 'DELETE bloqueio encerra');
r = chamar('/api/locacao/bloqueios/:id', 'delete', { params: { id: bloqId } });
assert(r.st === 404, 'encerrar duas vezes devolve 404');

r = chamar('/api/locacao/reservas', 'get', { query: { produtoId: prodA } });
assert(r.st === 200 && r.out.reservas.length >= 1, 'GET reservas lista');

// ─── Limpeza ──────────────────────────────────────────────────────────────────
limpar();
if (flagOriginal) {
  db.prepare("UPDATE config SET valor = ? WHERE chave = 'locacao_enabled'").run(flagOriginal.valor);
} else {
  db.prepare("DELETE FROM config WHERE chave = 'locacao_enabled'").run();
}

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
