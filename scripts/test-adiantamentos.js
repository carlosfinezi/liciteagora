/**
 * Abatimento de título com saldo de adiantamento, pelos dois lados:
 * cliente → contas a receber e fornecedor → contas a pagar.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const F = require('../financeiro-avancado-routes');

const DB = '/tmp/vp-adiant.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-adiant-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT, acao TEXT, entidade TEXT, entidadeId INTEGER, detalhes TEXT, ip TEXT,
  dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);

const app = express();
F.registrarRotasFinanceiroAvancado(app, db);
const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                session: { username: 'tester' }, user: { username: 'tester' } },
    { json: x => { out = x; return { json: y => { out = y; } }; },
      status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const perto = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

// ---------- seed ----------
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (1,'00000000000191','Cliente A','cliente',1)").run();
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (2,'00000000000272','Cliente B','cliente',1)").run();
db.prepare("INSERT INTO fornecedores (id, razaoSocial, cpfCnpj, ativo) VALUES (1,'Fornecedor X','00000000000353',1)").run();
db.prepare("INSERT INTO fornecedores (id, razaoSocial, cpfCnpj, ativo) VALUES (2,'Fornecedor Y','00000000000434',1)").run();

const novoAdiant = (tipo, donoId, valor, data = hoje) => db.prepare(`INSERT INTO adiantamentos
  (tipo, pessoaId, fornecedorId, valor, saldo, data, status) VALUES (?,?,?,?,?,?, 'ativo')`)
  .run(tipo, tipo === 'cliente' ? donoId : null, tipo === 'fornecedor' ? donoId : null,
       valor, valor, data).lastInsertRowid;

const novoCR = (pessoaId, valor) => db.prepare(`INSERT INTO contas_a_receber
  (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, origem)
  VALUES (?,?,?,?,?, 'aberta', 'manual')`).run(pessoaId, 'Título CR', valor, hoje, hoje).lastInsertRowid;

const novoCP = (fornecedorId, valor) => db.prepare(`INSERT INTO contas_a_pagar
  (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem)
  VALUES (?,?,?,?,?, 'aberta', 'manual')`).run(fornecedorId, 'Título CP', valor, hoje, hoje).lastInsertRowid;

// ---------- saldo disponível ----------
t('saldo responde a pergunta "este cliente tem crédito?"', () => {
  novoAdiant('cliente', 1, 300);
  novoAdiant('cliente', 1, 200);
  const r = chamar('/api/adiantamentos/saldo', 'get', { query: { pessoaId: '1' } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(perto(r.out.disponivel, 500), 'disponível: ' + r.out.disponivel);
  assert(r.out.adiantamentos.length === 2, 'adiantamentos: ' + r.out.adiantamentos.length);
});

t('saldo de um cliente não vaza para outro', () => {
  const r = chamar('/api/adiantamentos/saldo', 'get', { query: { pessoaId: '2' } });
  assert(r.out.disponivel === 0, 'cliente B não tem crédito: ' + r.out.disponivel);
});

t('saldo exige informar de quem', () => {
  const r = chamar('/api/adiantamentos/saldo', 'get', {});
  assert(r.st === 400, 'status: ' + r.st);
});

// ---------- contas a receber ----------
t('cliente abate título com adiantamento e o título fica pago', () => {
  const cr = novoCR(1, 500);
  const r = chamar('/api/contas-a-receber/:id/abater-adiantamento', 'post', { params: { id: String(cr) } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(perto(r.out.abatido, 500), 'abatido: ' + r.out.abatido);
  assert(r.out.statusTitulo === 'paga', 'status: ' + r.out.statusTitulo);
  // Dois adiantamentos de 300 e 200 cobrem os 500.
  assert(r.out.adiantamentosUsados.length === 2, 'usados: ' + JSON.stringify(r.out.adiantamentosUsados));
});

t('consome o adiantamento mais antigo primeiro', () => {
  const ids = db.prepare("SELECT id, saldo FROM adiantamentos WHERE pessoaId=1 ORDER BY id").all();
  assert(ids.every(a => a.saldo === 0), 'sobrou saldo: ' + JSON.stringify(ids));
  const u = db.prepare('SELECT adiantamentoId, valor FROM adiantamento_utilizacoes ORDER BY id').all();
  assert(u[0].adiantamentoId < u[1].adiantamentoId, 'não consumiu do mais antigo primeiro');
  assert(perto(u[0].valor, 300) && perto(u[1].valor, 200), JSON.stringify(u));
});

t('abatimento não move caixa — o dinheiro entrou quando o adiantamento nasceu', () => {
  const p = db.prepare("SELECT contaFinanceiraId, formaPagamento, origem FROM contas_receber_pagamentos ORDER BY id LIMIT 1").get();
  assert(p.contaFinanceiraId === null, 'vinculou conta financeira: ' + p.contaFinanceiraId);
  assert(p.formaPagamento === 'adiantamento' && p.origem === 'adiantamento', JSON.stringify(p));
});

t('abatimento parcial deixa o título parcial e o saldo certo', () => {
  novoAdiant('cliente', 2, 100);
  const cr = novoCR(2, 250);
  const r = chamar('/api/contas-a-receber/:id/abater-adiantamento', 'post', { params: { id: String(cr) } });
  assert(perto(r.out.abatido, 100), 'abatido: ' + r.out.abatido);
  assert(r.out.statusTitulo === 'parcial', 'status: ' + r.out.statusTitulo);
  assert(perto(r.out.saldoRestanteTitulo, 150), 'restante: ' + r.out.saldoRestanteTitulo);
});

t('valor explícito acima do saldo aberto é recusado', () => {
  novoAdiant('cliente', 2, 1000);
  const cr = novoCR(2, 80);
  const r = chamar('/api/contas-a-receber/:id/abater-adiantamento', 'post',
    { params: { id: String(cr) }, body: { valor: 500 } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/saldo aberto do título/.test(r.out.error), 'erro: ' + r.out.error);
});

t('valor acima do crédito disponível é recusado', () => {
  const cr = novoCR(1, 5000);   // cliente 1 já gastou todo o adiantamento
  const r = chamar('/api/contas-a-receber/:id/abater-adiantamento', 'post', { params: { id: String(cr) } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/não tem saldo de adiantamento/.test(r.out.error), 'erro: ' + r.out.error);
});

t('título já pago não aceita abatimento', () => {
  const cr = novoCR(2, 50);
  chamar('/api/contas-a-receber/:id/abater-adiantamento', 'post', { params: { id: String(cr) } });
  const r = chamar('/api/contas-a-receber/:id/abater-adiantamento', 'post', { params: { id: String(cr) } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/status paga/.test(r.out.error), 'erro: ' + r.out.error);
});

t('crédito de um cliente não quita título de outro', () => {
  const cr = novoCR(1, 100);   // cliente 1 sem saldo; cliente 2 tem
  const r = chamar('/api/contas-a-receber/:id/abater-adiantamento', 'post', { params: { id: String(cr) } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/não tem saldo/.test(r.out.error), 'usou crédito de terceiro: ' + r.out.error);
});

// ---------- contas a pagar ----------
t('fornecedor abate conta a pagar com adiantamento', () => {
  novoAdiant('fornecedor', 1, 400);
  const cp = novoCP(1, 400);
  const r = chamar('/api/contas-a-pagar/:id/abater-adiantamento', 'post', { params: { id: String(cp) } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(perto(r.out.abatido, 400) && r.out.statusTitulo === 'paga', JSON.stringify(r.out));
  const u = db.prepare('SELECT contaPagarId, contaReceberId FROM adiantamento_utilizacoes WHERE contaPagarId = ?').get(cp);
  assert(u && u.contaReceberId === null, 'utilização gravada no lado errado');
});

t('adiantamento a fornecedor não quita conta a receber', () => {
  novoAdiant('fornecedor', 2, 900);
  const cr = novoCR(1, 100);
  const r = chamar('/api/contas-a-receber/:id/abater-adiantamento', 'post', { params: { id: String(cr) } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/não tem saldo/.test(r.out.error), 'cruzou os lados: ' + r.out.error);
});

t('crédito de fornecedor não vaza entre fornecedores', () => {
  const cp = novoCP(1, 500);   // fornecedor 1 já consumiu; o 2 tem 900
  const r = chamar('/api/contas-a-pagar/:id/abater-adiantamento', 'post', { params: { id: String(cp) } });
  assert(r.st === 400, 'status: ' + r.st);
});

t('a assimetria de schema que quebrava o lado fornecedor foi corrigida', () => {
  // contas_receber_pagamentos tinha 'origem' e contas_pagar_pagamentos nao:
  // o mesmo INSERT servia os dois lados e estourava no de pagar.
  const cols = db.prepare('PRAGMA table_info(contas_pagar_pagamentos)').all().map(c => c.name);
  assert(cols.includes('origem'), 'contas_pagar_pagamentos continua sem origem');
  const p = db.prepare("SELECT origem, formaPagamento, contaFinanceiraId FROM contas_pagar_pagamentos ORDER BY id LIMIT 1").get();
  assert(p && p.origem === 'adiantamento', 'origem no CP: ' + JSON.stringify(p));
  assert(p.contaFinanceiraId === null, 'abatimento de CP nao pode mover caixa');
});

// ---------- coerência com o caminho antigo ----------
t('o caminho antigo (da tela de adiantamentos) continua funcionando', () => {
  const aid = novoAdiant('cliente', 2, 70);
  const cr = novoCR(2, 70);
  const r = chamar('/api/adiantamentos/:id/utilizar', 'post',
    { params: { id: String(aid) }, body: { contaReceberId: cr } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(db.prepare('SELECT status FROM contas_a_receber WHERE id=?').get(cr).status === 'paga', 'não quitou');
});

t('soma das utilizações bate com a redução dos saldos', () => {
  const usado = db.prepare('SELECT COALESCE(SUM(valor),0) v FROM adiantamento_utilizacoes').get().v;
  const consumido = db.prepare('SELECT COALESCE(SUM(valor - saldo),0) v FROM adiantamentos').get().v;
  assert(perto(usado, consumido), `utilizações ${usado} x consumido ${consumido}`);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
