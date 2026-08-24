/**
 * Boleto a pagar: leitura da linha digitável, dígitos verificadores, fator de
 * vencimento (com o reinício de 2025), caixa de entrada DDA/manual e entrada
 * no lote de pagamento.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const B = require('../boleto-pagamento');
const D = require('../dda-boletos');
const T = require('../tesouraria-routes');

const DB = '/tmp/vp-boleto.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-boleto-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT, acao TEXT, entidade TEXT, entidadeId INTEGER, detalhes TEXT, ip TEXT,
  dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);

const app = express();
T.registrarRotasTesouraria(app, db);
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
const pendentes = [];
const t = (nome, fn) => {
  // Casos assincronos entram na fila e sao aguardados no fim; rodar sem
  // await faria a asserção acontecer depois do proximo teste.
  pendentes.push(async () => {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  });
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const perto = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;

// ---------- gerador de boleto válido, para não depender de dados de terceiros ----------
function montarCobranca({ banco = '341', valor = 100, fator = 1000 }) {
  const valorStr = String(Math.round(valor * 100)).padStart(10, '0');
  const livre = '1234567890123456789012345';                  // campo livre (25)
  const semDv = banco + '9' + String(fator).padStart(4, '0') + valorStr + livre;  // 43
  const dv = B.modulo11(semDv);
  const barras = semDv.slice(0, 4) + dv + semDv.slice(4);      // 44
  // Barras -> linha digitável (47)
  const c1 = barras.slice(0, 4) + barras.slice(19, 24);
  const c2 = barras.slice(24, 34);
  const c3 = barras.slice(34, 44);
  return c1 + B.modulo10(c1) + c2 + B.modulo10(c2) + c3 + B.modulo10(c3)
    + barras[4] + barras.slice(5, 19);
}

// ---------- dígitos verificadores ----------
t('módulo 10 confere com os campos de uma linha real', () => {
  // Campos de 34191.79001 01043.510047 91020.150008 — os três DVs de campo
  // batem, o que valida o algoritmo contra dado de fora.
  assert(B.modulo10('341917900') === 1, 'campo 1: ' + B.modulo10('341917900'));
  assert(B.modulo10('0104351004') === 7, 'campo 2: ' + B.modulo10('0104351004'));
  assert(B.modulo10('9102015000') === 8, 'campo 3: ' + B.modulo10('9102015000'));
});

t('módulo 11 do código de barras segue a regra de resto 0, 1 e 10', () => {
  // A regra manda esses restos virarem DV 1. Construir um bloco com resto
  // conhecido é a única forma de exercitar o caso sem depender de sorte.
  const dv = B.modulo11('0'.repeat(43));
  assert(dv === 1, 'bloco zerado tem resto 0 e DV 1, veio ' + dv);
});

t('fator de vencimento acerta os quatro marcos oficiais', () => {
  const em = (a, m, d) => new Date(Date.UTC(a, m - 1, d));
  assert(B.fatorParaData(1000, em(2001, 1, 1)) === '2000-07-03', 'inicio do ciclo antigo');
  assert(B.fatorParaData(9999, em(2025, 1, 10)) === '2025-02-21', 'fim do ciclo antigo');
  assert(B.fatorParaData(1000, em(2026, 8, 2)) === '2025-02-22', 'reinicio de 2025');
  assert(B.fatorParaData(1001, em(2026, 8, 2)) === '2025-02-23', 'dia seguinte ao reinicio');
});

t('fator zero significa sem vencimento, não data de 1997', () => {
  assert(B.fatorParaData(0) === null, 'fator 0 deveria ser null');
});

// ---------- cobrança ----------
t('lê banco, valor e vencimento da linha de cobrança', () => {
  const linha = montarCobranca({ banco: '341', valor: 1234.56, fator: 1500 });
  const ref = new Date(Date.UTC(2026, 7, 2));
  const r = B.lerBoleto(linha, { referencia: ref });
  assert(r.valido, 'erros: ' + JSON.stringify(r.erros));
  assert(r.tipo === 'cobranca', 'tipo: ' + r.tipo);
  assert(r.banco === '341', 'banco: ' + r.banco);
  assert(perto(r.valor, 1234.56), 'valor: ' + r.valor);
  // Ancorado no marco oficial (fator 1000 = 22/02/2025), não num valor decorado.
  const esperado = new Date(Date.UTC(2025, 1, 22) + 500 * 86400000).toISOString().slice(0, 10);
  assert(r.vencimento === esperado, `vencimento ${r.vencimento}, esperado ${esperado}`);
  assert(B.nomeBanco('341') === 'Itaú', 'nome do banco');
});

t('um dígito trocado é recusado', () => {
  const linha = montarCobranca({ valor: 500 });
  const ruim = linha.slice(0, 5) + (linha[5] === '9' ? '0' : '9') + linha.slice(6);
  const r = B.lerBoleto(ruim);
  assert(!r.valido, 'passou um boleto adulterado');
  assert(r.erros.length, 'sem motivo');
});

t('código de barras de 44 dígitos também é lido', () => {
  const linha = montarCobranca({ valor: 77.7, fator: 1500 });
  const viaLinha = B.lerBoleto(linha);
  const viaBarras = B.lerBoleto(viaLinha.codigoBarras);
  assert(perto(viaBarras.valor, 77.7), 'valor: ' + viaBarras.valor);
  assert(viaBarras.codigoBarras === viaLinha.codigoBarras, 'barras diferentes');
});

t('boleto sem valor no código é marcado como em aberto', () => {
  const linha = montarCobranca({ valor: 0, fator: 1500 });
  const r = B.lerBoleto(linha);
  assert(r.valorEmAberto === true, 'deveria marcar valor em aberto');
  assert(r.valor === null, 'valor: ' + r.valor);
});

t('tamanho fora do padrão é recusado com o número de dígitos', () => {
  const r = B.lerBoleto('12345');
  assert(!r.valido && /5 dígitos/.test(r.erros[0]), 'erro: ' + JSON.stringify(r.erros));
});

// ---------- arrecadação (concessionária) ----------
// Barras de arrecadação: 8 + segmento + idValor + DV + valor(11) + livre(29).
function montarArrecadacao({ segmento = '2', idValor = '6', valor = 100 }) {
  const v = String(Math.round(valor * 100)).padStart(11, '0');
  const livre = '1'.repeat(29);
  const base43 = '8' + segmento + idValor + v + livre;      // 43, sem o DV
  const dv = ['6', '7'].includes(idValor)
    ? B.modulo10(base43) : B.modulo11(base43, { regraBanco: false });
  return base43.slice(0, 3) + dv + base43.slice(3);         // 44
}

t('arrecadação é reconhecida e traz o valor', () => {
  const r = B.lerBoleto(montarArrecadacao({ idValor: '6', valor: 100 }));
  assert(r.tipo === 'arrecadacao', 'tipo: ' + r.tipo);
  assert(perto(r.valor, 100), 'valor: ' + r.valor);
  // Concessionária não carrega vencimento no código — inventar um seria pior.
  assert(r.vencimento === null, 'arrecadação não traz vencimento');
});

t('arrecadação com identificador de referência não tem valor', () => {
  const r = B.lerBoleto(montarArrecadacao({ idValor: '7', valor: 100 }));
  assert(r.valorEmAberto === true, 'identificador 7 é referência, sem valor');
  assert(r.valor === null, 'não podia extrair valor: ' + r.valor);
});

t('arrecadação com identificador 8 usa módulo 11, não 10', () => {
  const r = B.lerBoleto(montarArrecadacao({ idValor: '8', valor: 55.5 }));
  assert(r.tipo === 'arrecadacao' && perto(r.valor, 55.5), JSON.stringify(r));
});

// ---------- caixa de entrada ----------
const FORN = db.prepare("INSERT INTO fornecedores (razaoSocial, cpfCnpj, ativo) VALUES ('Fornecedor','00000000000191',1)").run().lastInsertRowid;
const CONTA_FIN = db.prepare("INSERT INTO contas_financeiras (nome, tipo, ativo) VALUES ('Banco','corrente',1)").run().lastInsertRowid;
const LINHA_A = montarCobranca({ banco: '237', valor: 250.5, fator: 1500 });
const LINHA_B = montarCobranca({ banco: '001', valor: 999.99, fator: 1520 });
// O vencimento vem do fator, não de uma data escolhida a dedo — cravar a data
// no teste faz ele quebrar sempre que a regra do fator mudar.
const VENC_A = B.lerBoleto(LINHA_A).vencimento;
const VENC_B = B.lerBoleto(LINHA_B).vencimento;

t('importação manual aceita várias linhas coladas de uma vez', () => {
  const r = chamar('/api/boletos/importar', 'post', { body: { texto: `${LINHA_A}\n${LINHA_B}` } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.novos.length === 2, 'novos: ' + r.out.novos.length);
  assert(!r.out.invalidos.length, 'invalidos: ' + JSON.stringify(r.out.invalidos));
});

t('linha inválida no meio não derruba as válidas', () => {
  const LINHA_C = montarCobranca({ banco: '033', valor: 10, fator: 1510 });
  const r = chamar('/api/boletos/importar', 'post', { body: { texto: `123-invalido\n${LINHA_C}` } });
  assert(r.out.novos.length === 1, 'novos: ' + r.out.novos.length);
  assert(r.out.invalidos.length === 1, 'invalidos: ' + r.out.invalidos.length);
  assert(r.out.invalidos[0].erros.length, 'sem motivo do inválido');
});

t('o mesmo boleto pelo DDA e pela mão não vira dois', () => {
  const r = chamar('/api/boletos/importar', 'post', { body: { boletos: [LINHA_A], origem: 'dda' } });
  assert(!r.out.novos.length, 'duplicou');
  assert(r.out.duplicados.length === 1, 'duplicados: ' + r.out.duplicados.length);
});

t('boleto novo já vem com a sugestão de título', () => {
  const cp = db.prepare(`INSERT INTO contas_a_pagar (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem)
    VALUES (?, 'Fatura', 250.50, '2026-07-01', ?, 'aberta', 'manual')`).run(FORN, VENC_A).lastInsertRowid;
  const lista = chamar('/api/boletos', 'get', { query: { status: 'novo' } }).out.boletos;
  const b = lista.find(x => Math.round(x.valor * 100) === 25050);
  assert(b.sugestoes.exatos.length === 1, 'exatos: ' + JSON.stringify(b.sugestoes));
  assert(b.sugestoes.exatos[0].id === cp, 'título errado');
});

t('valor igual e vencimento diferente entra como provável, não exato', () => {
  db.prepare(`INSERT INTO contas_a_pagar (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem)
    VALUES (?, 'Outra', 999.99, '2026-07-01', '2026-12-31', 'aberta', 'manual')`).run(FORN);   // vencimento diferente de propósito
  const lista = chamar('/api/boletos', 'get', { query: { status: 'novo' } }).out.boletos;
  const b = lista.find(x => Math.round(x.valor * 100) === 99999);
  assert(!b.sugestoes.exatos.length, 'não podia ser exato');
  assert(b.sugestoes.provaveis.length === 1, 'provaveis: ' + JSON.stringify(b.sugestoes));
});

// ---------- vínculo ----------
let CP_A, DDA_A;
t('vincular grava o código de barras no título', () => {
  const lista = chamar('/api/boletos', 'get', { query: { status: 'novo' } }).out.boletos;
  const b = lista.find(x => Math.round(x.valor * 100) === 25050);
  DDA_A = b.id; CP_A = b.sugestoes.exatos[0].id;
  const r = chamar('/api/boletos/:id/vincular', 'post', { params: { id: String(DDA_A) }, body: { contaPagarId: CP_A } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const cp = db.prepare('SELECT codigoBarras, linhaDigitavel FROM contas_a_pagar WHERE id=?').get(CP_A);
  assert(cp.codigoBarras && cp.linhaDigitavel, 'título ficou sem o boleto: ' + JSON.stringify(cp));
});

t('o mesmo título não aceita dois boletos diferentes', () => {
  const lista = chamar('/api/boletos', 'get', { query: { status: 'novo' } }).out.boletos;
  const outro = lista[0];
  const r = chamar('/api/boletos/:id/vincular', 'post', { params: { id: String(outro.id) }, body: { contaPagarId: CP_A } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/outro boleto/.test(r.out.error), 'erro: ' + r.out.error);
});

t('vincular criando o título usa valor e vencimento do próprio boleto', () => {
  const lista = chamar('/api/boletos', 'get', { query: { status: 'novo' } }).out.boletos;
  const b = lista.find(x => Math.round(x.valor * 100) === 99999);
  const r = chamar('/api/boletos/:id/vincular', 'post', { params: { id: String(b.id) },
    body: { criar: { fornecedorId: FORN, descricao: 'Criado do boleto' } } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const cp = db.prepare('SELECT valor, dataVencimento, origem, codigoBarras FROM contas_a_pagar WHERE id=?').get(r.out.contaPagarId);
  assert(perto(cp.valor, 999.99), 'valor: ' + cp.valor);
  assert(cp.dataVencimento === b.vencimento, 'vencimento: ' + cp.dataVencimento);
  assert(cp.origem === 'dda' && cp.codigoBarras, 'origem/boleto: ' + JSON.stringify(cp));
});

t('ignorar tira o boleto da fila com o motivo', () => {
  const lista = chamar('/api/boletos', 'get', { query: { status: 'novo' } }).out.boletos;
  const r = chamar('/api/boletos/:id/ignorar', 'post', { params: { id: String(lista[0].id) },
    body: { motivo: 'cobrança indevida' } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const b = db.prepare('SELECT status, observacao FROM dda_boletos WHERE id=?').get(lista[0].id);
  assert(b.status === 'ignorado' && /indevida/.test(b.observacao), JSON.stringify(b));
});

// ---------- lote de pagamento ----------
t('boleto entra no lote de pagamento com o código de barras', () => {
  const r = chamar('/api/lotes-pagamento', 'post', { body: {
    contaFinanceiraId: CONTA_FIN, itens: [{ contaPagarId: CP_A, formaPagamento: 'boleto' }] } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const item = db.prepare('SELECT * FROM lote_pagamento_itens WHERE loteId = ?').get(r.out.id);
  assert(item.formaPagamento === 'boleto', 'forma: ' + item.formaPagamento);
  assert(item.codigoBarras, 'sem código de barras — o banco não teria como pagar');
});

t('lote recusa boleto de valor diferente do saldo do título', () => {
  const cp = db.prepare(`INSERT INTO contas_a_pagar (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem, linhaDigitavel, codigoBarras)
    VALUES (?, 'Divergente', 55.00, '2026-07-01', ?, 'aberta', 'manual', ?, ?)`)
    .run(FORN, VENC_B, LINHA_B, B.lerBoleto(LINHA_B).codigoBarras).lastInsertRowid;
  const r = chamar('/api/lotes-pagamento', 'post', { body: {
    contaFinanceiraId: CONTA_FIN, itens: [{ contaPagarId: cp, formaPagamento: 'boleto' }] } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/saldo/.test(r.out.error), 'erro: ' + r.out.error);
});

t('título sem boleto continua indo por PIX', () => {
  const cp = db.prepare(`INSERT INTO contas_a_pagar (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem)
    VALUES (?, 'Por PIX', 30.00, '2026-07-01', ?, 'aberta', 'manual')`).run(FORN, VENC_A).lastInsertRowid;
  const r = chamar('/api/lotes-pagamento', 'post', { body: {
    contaFinanceiraId: CONTA_FIN, itens: [{ contaPagarId: cp }] } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const item = db.prepare('SELECT formaPagamento FROM lote_pagamento_itens WHERE loteId = ?').get(r.out.id);
  assert(item.formaPagamento === 'pix', 'forma: ' + item.formaPagamento);
});

t('boleto inválido não entra no lote', () => {
  const cp = db.prepare(`INSERT INTO contas_a_pagar (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem, codigoBarras)
    VALUES (?, 'Boleto ruim', 10.00, '2026-07-01', ?, 'aberta', 'manual', '123')`).run(FORN, VENC_A).lastInsertRowid;
  const r = chamar('/api/lotes-pagamento', 'post', { body: {
    contaFinanceiraId: CONTA_FIN, itens: [{ contaPagarId: cp, formaPagamento: 'boleto' }] } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/invalido/i.test(r.out.error), 'erro: ' + r.out.error);
});


// ==================== PAGAMENTO PELO ASAAS (/v3/bill) ====================
// A API real e dublada: o teste nao sai para a rede e, por isso, consegue
// exercitar recusa, agendamento e divergencia de valor.
const fetchReal = global.fetch;
let chamadasAsaas = [];
function dublarAsaas(resposta) {
  chamadasAsaas = [];
  global.fetch = async (url, opts = {}) => {
    const corpo = opts.body ? JSON.parse(opts.body) : null;
    chamadasAsaas.push({ url: String(url), method: opts.method || 'GET', corpo });
    const r = typeof resposta === 'function' ? resposta(String(url), corpo) : resposta;
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
  };
}
const restaurarFetch = () => { global.fetch = fetchReal; };

// Conta financeira com Asaas ativo, como no tenant real.
db.prepare(`INSERT INTO contas_financeiras_boleto (contaFinanceiraId, provedor, ambiente, ativo, configJson)
  VALUES (?, 'asaas', 'producao', 1, ?)`).run(CONTA_FIN, JSON.stringify({ accessToken: 'tok-teste' }));

t('boleto do lote é pago pelo /v3/bill, não por PIX', async () => {
  const cp = db.prepare(`INSERT INTO contas_a_pagar (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem, linhaDigitavel, codigoBarras)
    VALUES (?, 'Energia', 250.50, '2026-07-01', ?, 'aberta', 'manual', ?, ?)`)
    .run(FORN, VENC_A, LINHA_A, B.lerBoleto(LINHA_A).codigoBarras).lastInsertRowid;
  const lote = chamar('/api/lotes-pagamento', 'post', { body: {
    contaFinanceiraId: CONTA_FIN, provedor: 'asaas',
    itens: [{ contaPagarId: cp, formaPagamento: 'boleto' }] } });
  assert(lote.out.success, 'lote: ' + lote.out.error);

  dublarAsaas({ body: { id: 'bill-1', status: 'SCHEDULED', value: 250.50 } });
  const r = await achar('/api/lotes-pagamento/:id/processar', 'post')(
    { params: { id: String(lote.out.id) }, body: {}, query: {}, session: { username: 't' } },
    { json: x => x, status: () => ({ json: x => x }) });
  restaurarFetch();

  const chamada = chamadasAsaas.find(c => c.url.endsWith('/bill'));
  assert(chamada, 'nao chamou /bill: ' + JSON.stringify(chamadasAsaas.map(c => c.url)));
  assert(chamada.corpo.identificationField === B.so(LINHA_A), 'linha digitavel errada');
  assert(!chamadasAsaas.some(c => c.url.endsWith('/transfers')), 'mandou PIX para um boleto');
  const item = db.prepare('SELECT status, provedorRef FROM lote_pagamento_itens WHERE loteId = ?').get(lote.out.id);
  assert(item.provedorRef === 'bill-1', 'sem referencia do Asaas: ' + JSON.stringify(item));
  assert(item.status === 'aguardando', 'SCHEDULED deveria virar aguardando, veio ' + item.status);
});

t('valor efetivo do Asaas (com juros e multa) substitui o do título', async () => {
  const cp = db.prepare(`INSERT INTO contas_a_pagar (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem, linhaDigitavel, codigoBarras)
    VALUES (?, 'Atrasada', 118.80, '2026-06-01', ?, 'aberta', 'manual', ?, ?)`)
    .run(FORN, VENC_B, LINHA_B, B.lerBoleto(LINHA_B).codigoBarras).lastInsertRowid;
  db.prepare('UPDATE contas_a_pagar SET valor = 999.99 WHERE id = ?').run(cp);   // casa com o boleto
  const lote = chamar('/api/lotes-pagamento', 'post', { body: {
    contaFinanceiraId: CONTA_FIN, provedor: 'asaas',
    itens: [{ contaPagarId: cp, formaPagamento: 'boleto' }] } });

  // Boleto vencido: o banco cobra juros e multa, e o pago fica maior.
  dublarAsaas({ body: { id: 'bill-2', status: 'BANK_PROCESSING', value: 1010.25, originalValue: 999.99 } });
  await achar('/api/lotes-pagamento/:id/processar', 'post')(
    { params: { id: String(lote.out.id) }, body: {}, query: {}, session: { username: 't' } },
    { json: x => x, status: () => ({ json: x => x }) });
  restaurarFetch();

  const item = db.prepare('SELECT valor, status FROM lote_pagamento_itens WHERE loteId = ?').get(lote.out.id);
  assert(perto(item.valor, 1010.25), 'nao gravou o valor efetivo: ' + item.valor);
  assert(item.status === 'enviado', 'BANK_PROCESSING deveria virar enviado, veio ' + item.status);
});

t('recusa do Asaas fica registrada no item, com o motivo dele', async () => {
  const cp = db.prepare(`INSERT INTO contas_a_pagar (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem, linhaDigitavel, codigoBarras)
    VALUES (?, 'Recusada', 250.50, '2026-07-01', ?, 'aberta', 'manual', ?, ?)`)
    .run(FORN, VENC_A, LINHA_A, B.lerBoleto(LINHA_A).codigoBarras).lastInsertRowid;
  const lote = chamar('/api/lotes-pagamento', 'post', { body: {
    contaFinanceiraId: CONTA_FIN, provedor: 'asaas',
    itens: [{ contaPagarId: cp, formaPagamento: 'boleto' }] } });

  dublarAsaas({ ok: false, status: 400,
    body: { errors: [{ description: 'Saldo insuficiente para o pagamento' }] } });
  await achar('/api/lotes-pagamento/:id/processar', 'post')(
    { params: { id: String(lote.out.id) }, body: {}, query: {}, session: { username: 't' } },
    { json: x => x, status: () => ({ json: x => x }) });
  restaurarFetch();

  const item = db.prepare('SELECT status, erroMensagem FROM lote_pagamento_itens WHERE loteId = ?').get(lote.out.id);
  assert(item.status === 'erro', 'status: ' + item.status);
  assert(/Saldo insuficiente/.test(item.erroMensagem || ''), 'motivo perdido: ' + item.erroMensagem);
});

t('sincronizar traz o status de volta e importa o que foi pago fora do ERP', async () => {
  const LINHA_FORA = montarCobranca({ banco: '104', valor: 77.5, fator: 1530 });
  dublarAsaas({ body: { object: 'list', totalCount: 2, data: [
    { id: 'bill-1', status: 'PAID', value: 250.50, identificationField: B.so(LINHA_A),
      dueDate: VENC_A, paymentDate: '2026-08-02', transactionReceiptUrl: 'https://asaas/x' },
    { id: 'bill-fora', status: 'PAID', value: 77.5, identificationField: B.so(LINHA_FORA),
      dueDate: '2026-08-10', beneficiaryName: 'CONCESSIONARIA X', beneficiaryCpfCnpj: '11222333000181',
      paymentDate: '2026-08-01' },
  ] } });
  const r = await achar('/api/boletos/sincronizar-asaas', 'post')(
    { params: {}, query: {}, body: { contaFinanceiraId: CONTA_FIN }, session: { username: 't' } },
    { json: x => x, status: () => ({ json: x => x }) });
  restaurarFetch();

  // O item que estava aguardando virou pago.
  const item = db.prepare("SELECT status FROM lote_pagamento_itens WHERE provedorRef = 'bill-1'").get();
  assert(item.status === 'pago', 'status do item: ' + item.status);
  // O boleto pago direto no painel entrou na fila, marcado como pago.
  const fora = db.prepare('SELECT status, beneficiarioNome, observacao FROM dda_boletos WHERE linhaDigitavel = ?')
    .get(B.so(LINHA_FORA));
  assert(fora, 'boleto pago fora do ERP nao foi importado');
  assert(fora.status === 'pago', 'status: ' + fora.status);
  assert(fora.beneficiarioNome === 'CONCESSIONARIA X', 'perdeu o beneficiario');
});

t('sincronizar não duplica na segunda passada', async () => {
  const antes = db.prepare('SELECT COUNT(*) n FROM dda_boletos').get().n;
  dublarAsaas({ body: { object: 'list', totalCount: 0, data: [] } });
  await achar('/api/boletos/sincronizar-asaas', 'post')(
    { params: {}, query: {}, body: { contaFinanceiraId: CONTA_FIN }, session: {} },
    { json: x => x, status: () => ({ json: x => x }) });
  restaurarFetch();
  assert(db.prepare('SELECT COUNT(*) n FROM dda_boletos').get().n === antes, 'duplicou');
});

t('conta sem Asaas recusa a sincronização com o motivo', async () => {
  const semAsaas = db.prepare("INSERT INTO contas_financeiras (nome, tipo, ativo) VALUES ('Caixa','caixa',1)").run().lastInsertRowid;
  let out = null;
  await achar('/api/boletos/sincronizar-asaas', 'post')(
    { params: {}, query: {}, body: { contaFinanceiraId: semAsaas }, session: {} },
    { json: x => { out = x; }, status: () => ({ json: x => { out = x; } }) });
  assert(out && !out.success && /Asaas/.test(out.error), 'erro: ' + JSON.stringify(out));
});


// ==================== IMPORTAR LISTA EXPORTADA ====================
t('extrai o código do meio de uma linha com outras colunas', () => {
  const linha = montarCobranca({ banco: '104', valor: 120.5, fator: 1540 });
  const exportada = `CONCESSIONARIA X;R$ 120,50;10/08/2026;${linha};pendente`;
  assert(D.extrairCodigo(exportada) === B.so(linha), 'nao extraiu: ' + D.extrairCodigo(exportada));
});

t('aceita a linha no formato impresso, com pontos e espaços', () => {
  const linha = B.so(montarCobranca({ banco: '341', valor: 33.3, fator: 1545 }));
  const impressa = `${linha.slice(0,5)}.${linha.slice(5,10)} ${linha.slice(10,15)}.${linha.slice(15,21)} `
    + `${linha.slice(21,26)}.${linha.slice(26,32)} ${linha.slice(32,33)} ${linha.slice(33)}`;
  assert(D.extrairCodigo(impressa) === linha, 'nao normalizou o formato impresso');
});

t('texto sem código nenhum não vira boleto', () => {
  const r = chamar('/api/boletos/importar', 'post', { body: { texto: 'Beneficiario;Valor;Vencimento' } });
  assert(!r.out.novos.length, 'inventou boleto de um cabecalho de planilha');
  assert(r.out.invalidos.length === 1, 'deveria reportar a linha invalida');
});

t('importa uma lista exportada inteira, com cabeçalho e tudo', () => {
  const l1 = montarCobranca({ banco: '237', valor: 45.9, fator: 1550 });
  const l2 = montarCobranca({ banco: '001', valor: 88.8, fator: 1551 });
  const texto = [
    'Beneficiario;Valor;Vencimento;Linha digitavel',
    `FORNECEDOR A;R$ 45,90;15/08/2026;${l1}`,
    `FORNECEDOR B;R$ 88,80;16/08/2026;${l2}`,
  ].join('\n');
  const r = chamar('/api/boletos/importar', 'post', { body: { texto, origem: 'dda' } });
  assert(r.out.novos.length === 2, 'novos: ' + r.out.novos.length);
  assert(r.out.invalidos.length === 1, 'o cabecalho deveria ser reportado como invalido');
  assert(r.out.novos.every(x => x.origem === 'dda'), 'origem nao gravada');
});

(async () => {
  for (const caso of pendentes) await caso();
  console.log(`\n${ok} OK, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
