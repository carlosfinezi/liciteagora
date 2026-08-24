/**
 * PIX automático das contas a pagar recorrentes.
 * A maior parte dos casos aqui é do que NÃO pode sair sozinho — é dinheiro
 * deixando a conta sem ninguém clicar.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const T = require('../tesouraria-routes');

const DB = '/tmp/vp-pixauto.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-pixauto-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT,
  acao TEXT, entidade TEXT, entidadeId INTEGER, detalhes TEXT, ip TEXT, dataCriacao TEXT)`);
T.migrarTesourariaDB(db);
T.migrarPagamentoAutomaticoCP(db);

let ok = 0, fail = 0;
const pendentes = [];
const t = (nome, fn) => pendentes.push(async () => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
});
const assert = (c, m) => { if (!c) throw new Error(m); };
const perto = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const dia = (n) => new Date(Date.now() + n * 86400000 - 3 * 3600000).toISOString().slice(0, 10);

// ---------- dublê do Asaas ----------
const fetchReal = global.fetch;
let transferencias = [];
function dublar(resposta = { ok: true, body: { id: 'tr-1' } }) {
  transferencias = [];
  global.fetch = async (url, opts = {}) => {
    transferencias.push({ url: String(url), corpo: opts.body ? JSON.parse(opts.body) : null });
    const r = typeof resposta === 'function' ? resposta() : resposta;
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
  };
}
const restaurar = () => { global.fetch = fetchReal; };

// ---------- seed ----------
const CONTA = db.prepare("INSERT INTO contas_financeiras (nome, tipo, ativo) VALUES ('Banco','corrente',1)").run().lastInsertRowid;
db.prepare(`INSERT INTO contas_financeiras_boleto (contaFinanceiraId, provedor, ambiente, ativo, configJson)
  VALUES (?, 'asaas', 'producao', 1, ?)`).run(CONTA, JSON.stringify({ accessToken: 'tok' }));
const COM_PIX = db.prepare(`INSERT INTO fornecedores (cpfCnpj, razaoSocial, ativo, chavePix)
  VALUES ('00000000000191','Energia SA',1,'energia@x.com')`).run().lastInsertRowid;
const SEM_PIX = db.prepare(`INSERT INTO fornecedores (cpfCnpj, razaoSocial, ativo)
  VALUES ('00000000000272','Sem Pix LTDA',1)`).run().lastInsertRowid;

const novaRec = (o = {}) => db.prepare(`INSERT INTO contas_pagar_recorrencias
  (fornecedorId, descricao, valor, frequencia, proximaGeracao, ativo,
   pagarAutomatico, contaFinanceiraId, limiteValorAuto, diasAntesVencimento)
  VALUES (?, ?, ?, 'mensal', ?, 1, ?, ?, ?, ?)`)
  .run(o.fornecedorId ?? COM_PIX, o.descricao || 'Energia mensal', o.valor ?? 300, hoje,
       o.pagarAutomatico ?? 1, o.contaFinanceiraId === null ? null : (o.contaFinanceiraId ?? CONTA),
       o.limite === null ? null : (o.limite ?? 500), o.diasAntes ?? 0).lastInsertRowid;

const novaCP = (recId, o = {}) => db.prepare(`INSERT INTO contas_a_pagar
  (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem, recorrenciaId)
  VALUES (?, ?, ?, ?, ?, ?, 'recorrente', ?)`)
  .run(o.fornecedorId ?? COM_PIX, o.descricao || 'Energia (08/2026)', o.valor ?? 300,
       hoje, o.vencimento ?? hoje, o.status || 'aberta', recId).lastInsertRowid;

(async () => {

// ---------- caminho feliz ----------
t('conta recorrente elegível é paga por PIX', async () => {
  const rec = novaRec();
  const cp = novaCP(rec);
  dublar();
  const r = await T.pagarRecorrentesPorPix(db, { log: () => {} });
  restaurar();
  assert(r.pagos === 1, 'pagos: ' + r.pagos + ' | recusados: ' + JSON.stringify(r.recusados));
  const tr = transferencias.find(x => x.url.endsWith('/transfers'));
  assert(tr, 'nao chamou o Asaas');
  assert(tr.corpo.pixAddressKey === 'energia@x.com', 'chave: ' + tr.corpo.pixAddressKey);
  assert(perto(tr.corpo.value, 300), 'valor: ' + tr.corpo.value);
  const item = db.prepare('SELECT status, provedorRef FROM lote_pagamento_itens WHERE contaPagarId=?').get(cp);
  assert(item.status === 'enviado' && item.provedorRef === 'tr-1', JSON.stringify(item));
});

t('simular não dispara nada', async () => {
  const rec = novaRec({ descricao: 'Agua' });
  novaCP(rec, { descricao: 'Agua (08/2026)' });
  dublar();
  const r = await T.pagarRecorrentesPorPix(db, { simular: true, log: () => {} });
  restaurar();
  assert(r.pagos === 0, 'pagou na simulacao');
  assert(!transferencias.length, 'chamou o Asaas na simulacao');
  assert(r.simulacao.length >= 1, 'nao listou o que faria');
});

// ---------- travas ----------
t('recorrência sem pagamento automático não sai', async () => {
  const rec = novaRec({ pagarAutomatico: 0, descricao: 'Manual' });
  novaCP(rec, { descricao: 'Manual (08/2026)' });
  dublar();
  const r = await T.pagarRecorrentesPorPix(db, { log: () => {} });
  restaurar();
  assert(!r.recusados.some(x => /Manual/.test(x.descricao || '')), 'nao devia nem ser candidata');
  assert(!transferencias.some(x => x.corpo && x.corpo.description && /Manual/.test(x.corpo.description)), 'pagou sem opt-in');
});

t('valor acima do teto não sai — é a conta que dobrou', async () => {
  const rec = novaRec({ descricao: 'Luz', limite: 500 });
  novaCP(rec, { descricao: 'Luz dobrada', valor: 1200 });
  dublar();
  const r = await T.pagarRecorrentesPorPix(db, { log: () => {} });
  restaurar();
  const rec1 = r.recusados.find(x => /Luz dobrada/.test(x.descricao || ''));
  assert(rec1, 'recusados: ' + JSON.stringify(r.recusados));
  assert(/acima do teto/.test(rec1.motivo), 'motivo: ' + rec1.motivo);
});

t('fornecedor sem chave PIX não sai, e o motivo é dito', async () => {
  const rec = novaRec({ fornecedorId: SEM_PIX, descricao: 'SemChave' });
  novaCP(rec, { fornecedorId: SEM_PIX, descricao: 'SemChave (08/2026)' });
  dublar();
  const r = await T.pagarRecorrentesPorPix(db, { log: () => {} });
  restaurar();
  const rec1 = r.recusados.find(x => /SemChave/.test(x.descricao || ''));
  assert(rec1 && /chave PIX/.test(rec1.motivo), 'motivo: ' + JSON.stringify(rec1));
});

t('sem conta financeira de origem não sai', async () => {
  const rec = novaRec({ contaFinanceiraId: null, descricao: 'SemConta' });
  novaCP(rec, { descricao: 'SemConta (08/2026)' });
  dublar();
  const r = await T.pagarRecorrentesPorPix(db, { log: () => {} });
  restaurar();
  const rec1 = r.recusados.find(x => /SemConta/.test(x.descricao || ''));
  assert(rec1 && /conta financeira/.test(rec1.motivo), 'motivo: ' + JSON.stringify(rec1));
});

t('vencimento futuro além da antecipação espera', async () => {
  const rec = novaRec({ descricao: 'Futura', diasAntes: 2 });
  novaCP(rec, { descricao: 'Futura (09/2026)', vencimento: dia(10) });
  dublar();
  const r = await T.pagarRecorrentesPorPix(db, { log: () => {} });
  restaurar();
  assert(!transferencias.some(x => x.corpo && /Futura/.test(x.corpo.description || '')), 'antecipou demais');
});

t('antecipação configurada é respeitada', async () => {
  const rec = novaRec({ descricao: 'Antecipa', diasAntes: 5 });
  novaCP(rec, { descricao: 'Antecipa (08/2026)', vencimento: dia(3) });
  dublar();
  const r = await T.pagarRecorrentesPorPix(db, { log: () => {} });
  restaurar();
  assert(transferencias.some(x => /Antecipa/.test(x.corpo?.description || '')), 'nao antecipou dentro da janela');
});

t('título já pago não é pago de novo', async () => {
  const rec = novaRec({ descricao: 'Repetida' });
  const cp = novaCP(rec, { descricao: 'Repetida (08/2026)' });
  dublar();
  await T.pagarRecorrentesPorPix(db, { log: () => {} });
  const antes = transferencias.length;
  // Segunda passada: o titulo ja esta em lote vivo.
  dublar();
  const r = await T.pagarRecorrentesPorPix(db, { log: () => {} });
  restaurar();
  assert(!transferencias.some(x => /Repetida/.test(x.corpo?.description || '')), 'PAGOU DUAS VEZES');
  const rec1 = r.recusados.find(x => /Repetida/.test(x.descricao || ''));
  assert(rec1 && /já está no lote/.test(rec1.motivo), 'motivo: ' + JSON.stringify(rec1));
});

t('título parcialmente pago paga só o saldo', async () => {
  const rec = novaRec({ descricao: 'Parcial' });
  const cp = novaCP(rec, { descricao: 'Parcial (08/2026)', valor: 400, status: 'parcial' });
  db.prepare(`INSERT INTO contas_pagar_pagamentos (contaPagarId, dataPagamento, valorPago, valorBase, estornado)
    VALUES (?, ?, 150, 150, 0)`).run(cp, hoje);
  dublar();
  await T.pagarRecorrentesPorPix(db, { log: () => {} });
  restaurar();
  const tr = transferencias.find(x => /Parcial/.test(x.corpo?.description || ''));
  assert(tr && perto(tr.corpo.value, 250), 'pagou ' + tr?.corpo?.value + ', esperado o saldo 250');
});

t('recusa do Asaas fica registrada e não some', async () => {
  const rec = novaRec({ descricao: 'Recusada' });
  const cp = novaCP(rec, { descricao: 'Recusada (08/2026)' });
  dublar({ ok: false, status: 400, body: { errors: [{ description: 'Saldo insuficiente' }] } });
  const r = await T.pagarRecorrentesPorPix(db, { log: () => {} });
  restaurar();
  assert(r.erros.some(e => /Saldo insuficiente/.test(e.erro)), 'erros: ' + JSON.stringify(r.erros));
  const item = db.prepare('SELECT status, erroMensagem FROM lote_pagamento_itens WHERE contaPagarId=?').get(cp);
  assert(item.status === 'erro' && /Saldo insuficiente/.test(item.erroMensagem), JSON.stringify(item));
});

t('conta a pagar avulsa não entra no automático', async () => {
  const cp = db.prepare(`INSERT INTO contas_a_pagar
    (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem)
    VALUES (?, 'Avulsa', 100, ?, ?, 'aberta', 'manual')`).run(COM_PIX, hoje, hoje).lastInsertRowid;
  dublar();
  await T.pagarRecorrentesPorPix(db, { log: () => {} });
  restaurar();
  assert(!transferencias.some(x => /Avulsa/.test(x.corpo?.description || '')), 'pagou conta que nao e recorrente');
});

t('recorrência inativa não paga', async () => {
  const rec = novaRec({ descricao: 'Inativa' });
  novaCP(rec, { descricao: 'Inativa (08/2026)' });
  db.prepare('UPDATE contas_pagar_recorrencias SET ativo = 0 WHERE id = ?').run(rec);
  dublar();
  await T.pagarRecorrentesPorPix(db, { log: () => {} });
  restaurar();
  assert(!transferencias.some(x => /Inativa/.test(x.corpo?.description || '')), 'pagou de recorrencia desligada');
});

for (const caso of pendentes) await caso();
console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
})();
