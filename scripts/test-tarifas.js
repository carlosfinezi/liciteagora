/**
 * Tarifas que não são cartão: o conjunto padrão de regras de conciliação
 * (tarifa bancária avulsa, que só chega pelo extrato) e a tarifa por boleto
 * liquidado (que nasce do título e vira CP quitada em despesa financeira).
 *
 * Schema: gere antes o dump de um tenant real —
 *   sqlite3 data/tenants/1bit/pncp.db .schema > /tmp/tarifa-schema.sql
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const T = require('../tesouraria-routes');
const orchestrator = require('../boleto-orchestrator');

const SCHEMA = '/tmp/tarifa-schema.sql';
if (!fs.existsSync(SCHEMA)) {
  console.error(`schema ausente: ${SCHEMA}\n  sqlite3 data/tenants/1bit/pncp.db .schema > ${SCHEMA}`);
  process.exit(2);
}
const DB = '/tmp/tarifa-teste.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(fs.readFileSync(SCHEMA, 'utf8'));

// Os ALTERs novos (tarifaBoleto / contaPagarTarifaId) entram por aqui — o dump
// é de um banco que ainda não os tem, então isto também testa a migração.
orchestrator.migrarSchema(db);

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
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- seed ----------
const CONTA = db.prepare("INSERT INTO contas_financeiras (nome, tipo, ativo) VALUES ('Banco','corrente',1)").run().lastInsertRowid;
db.prepare("INSERT INTO plano_contas (codigo, nome, tipo, nivel, ativo) VALUES ('5.2','Despesas Financeiras','financeiro_despesa',2,1)").run();
const PC_TARIFA = db.prepare("SELECT id FROM plano_contas WHERE codigo='5.2'").get().id;

// ==================== regras padrão de tarifa ====================

t('cria o conjunto padrão apontando para a conta de despesa financeira', () => {
  const { out, st } = chamar('/api/conciliacao/regras/padroes-tarifa', 'post');
  assert(st === 200 && out.success, `esperava 200, veio ${st} ${out && out.error}`);
  assert(out.criadas.length === 4, `esperava 4 criadas, veio ${out.criadas.length}`);
  const regras = db.prepare('SELECT * FROM conciliacao_regras').all();
  assert(regras.length === 4, `esperava 4 regras, veio ${regras.length}`);
  for (const r of regras) {
    assert(r.planoContaId === PC_TARIFA, `${r.padraoTexto} sem a conta 5.2`);
    assert(r.ativo === 1, `${r.padraoTexto} nasceu inativa — não classificaria nada`);
    assert(r.modo === 'palavra', `${r.padraoTexto} em modo contém pega palavra dentro de palavra`);
    assert(r.tipoLancamento === 'saida', `${r.padraoTexto} deveria valer só para saídas`);
    assert(r.valorMax === 500, `${r.padraoTexto} sem teto pega transferência junto`);
  }
});

t('as regras criadas casam a tarifa e não a transferência de mesmo texto', () => {
  const regra = db.prepare("SELECT * FROM conciliacao_regras WHERE padraoTexto='TARIFA'").get();
  assert(T.regraCasa(regra, { descricao: 'TARIFA PACOTE SERVICOS', memo: '', valor: -34.9 }),
    'tarifa de pacote deveria casar');
  assert(!T.regraCasa(regra, { descricao: 'TARIFA COBRANCA LOTE', memo: '', valor: -4200 }),
    'valor acima do teto não pode entrar como tarifa');
  assert(!T.regraCasa(regra, { descricao: 'ESTORNO TARIFA', memo: '', valor: 34.9 }),
    'crédito não é tarifa');
});

t('rodar de novo não duplica', () => {
  const { out } = chamar('/api/conciliacao/regras/padroes-tarifa', 'post');
  assert(out.criadas.length === 0, `criou de novo: ${out.criadas.join(', ')}`);
  assert(out.puladas.length === 4, `esperava 4 puladas, veio ${out.puladas.length}`);
  assert(db.prepare('SELECT COUNT(*) n FROM conciliacao_regras').get().n === 4, 'duplicou regra');
});

t('regra que categorizava sem conta do plano é completada, não duplicada', () => {
  const id = db.prepare(`INSERT INTO conciliacao_regras (padraoTexto, acao, ativo, planoContaId)
    VALUES ('TARIFA BOLETO', 'categorizar', 0, NULL)`).run().lastInsertRowid;
  const { out } = chamar('/api/conciliacao/regras/padroes-tarifa', 'post');
  assert(out.adotadas.includes('TARIFA BOLETO'), `não adotou: ${JSON.stringify(out)}`);
  const r = db.prepare('SELECT * FROM conciliacao_regras WHERE id = ?').get(id);
  assert(r.planoContaId === PC_TARIFA, 'continuou sem a conta do plano');
  assert(r.ativo === 0, 'reativou sozinha — a escolha de quem desativou tem de ficar de pé');
});

t('regra de ignorar não é tocada — ela não usa conta do plano', () => {
  const id = db.prepare(`INSERT INTO conciliacao_regras (padraoTexto, acao, ativo, planoContaId)
    VALUES ('TARIFA INTERNA', 'ignorar', 1, NULL)`).run().lastInsertRowid;
  chamar('/api/conciliacao/regras/padroes-tarifa', 'post');
  assert(db.prepare('SELECT planoContaId FROM conciliacao_regras WHERE id = ?').get(id).planoContaId === null,
    'pôs conta do plano numa regra de ignorar');
});

// ==================== tarifa por boleto liquidado ====================

const CLIENTE = db.prepare("INSERT INTO pessoas (tipo, cpfCnpj, razaoSocial) VALUES ('PJ','11111111111111','Cliente')").run().lastInsertRowid;
const CR = db.prepare(`INSERT INTO contas_a_receber (pessoaId, descricao, valor, dataEmissao, dataVencimento, status)
  VALUES (?, 'Venda', 1000, '2026-08-25', '2026-08-25', 'paga')`).run(CLIENTE).lastInsertRowid;
db.prepare(`INSERT INTO contas_financeiras_boleto (contaFinanceiraId, provedor, ativo, tarifaBoleto)
  VALUES (?, 'asaas', 1, 3.49)`).run(CONTA);

let seqNN = 0;
const novoBoleto = (tipo = 'boleto', conta = CONTA) => db.prepare(`INSERT INTO boletos
  (contaReceberId, amount, expirationDate, customerDocument, customerName, status,
   provedor, contaFinanceiraId, nossoNumero, tipoCobranca)
  VALUES (?, 100000, '2026-08-25', '00000000000', 'Cliente', 'pago', 'asaas', ?, ?, ?)`)
  .run(CR, conta, 'pay_' + (++seqNN), tipo).lastInsertRowid;

t('boleto liquidado gera CP quitada em 5.2 e saída na conta', () => {
  const b = novoBoleto();
  const r = orchestrator.lancarTarifaBoleto(db, b, '2026-08-25', 'teste');
  assert(r && r.valor === 3.49, `não lançou: ${JSON.stringify(r)}`);
  const cp = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(r.contaPagarId);
  assert(cp.status === 'paga', `CP ficou ${cp.status} — a tarifa já foi debitada pelo banco`);
  assert(cp.valor === 3.49 && cp.valorPago === 3.49, 'valor errado na CP');
  assert(cp.planoContaId === PC_TARIFA, 'CP fora da despesa financeira não chega ao DRE');
  assert(cp.origem === 'tarifa_boleto', `origem ${cp.origem}`);
  const pg = db.prepare('SELECT * FROM contas_pagar_pagamentos WHERE contaPagarId = ?').all(r.contaPagarId);
  assert(pg.length === 1 && pg[0].contaFinanceiraId === CONTA, 'pagamento da CP não saiu da conta do boleto');
  const mov = db.prepare(`SELECT * FROM movimentacoes_financeiras
    WHERE origem = 'tarifa_boleto' AND origemId = ?`).get(b);
  assert(mov && mov.tipo === 'saida' && mov.valor === 3.49, 'sem saída no caixa');
  assert(db.prepare('SELECT contaPagarTarifaId FROM boletos WHERE id = ?').get(b).contaPagarTarifaId === r.contaPagarId,
    'boleto não guardou a CP da tarifa');
});

t('a receita continua cheia — a tarifa não abate a conta a receber', () => {
  assert(db.prepare('SELECT valor FROM contas_a_receber WHERE id = ?').get(CR).valor === 1000,
    'a CR encolheu: baixar pelo líquido esconde o custo de cobrança');
});

t('webhook e polling no mesmo boleto lançam a tarifa uma vez só', () => {
  const b = novoBoleto();
  const p = orchestrator.lancarTarifaBoleto(db, b, '2026-08-25', 'webhook_asaas');
  const s = orchestrator.lancarTarifaBoleto(db, b, '2026-08-25', 'polling_asaas');
  assert(p && !s, 'a segunda passada lançou de novo');
  assert(db.prepare(`SELECT COUNT(*) n FROM contas_a_pagar WHERE descricao LIKE ?`)
    .get(`%boleto #${b}`).n === 1, 'duas CPs para o mesmo boleto');
});

t('cobrança PIX não paga tarifa de boleto', () => {
  const b = novoBoleto('pix');
  assert(!orchestrator.lancarTarifaBoleto(db, b, '2026-08-25', 'teste'), 'cobrou tarifa de boleto num PIX');
});

t('conta sem tarifa configurada não lança nada', () => {
  const outra = db.prepare("INSERT INTO contas_financeiras (nome, tipo, ativo) VALUES ('Banco 2','corrente',1)").run().lastInsertRowid;
  db.prepare(`INSERT INTO contas_financeiras_boleto (contaFinanceiraId, provedor, ativo, tarifaBoleto)
    VALUES (?, 'asaas', 1, 0)`).run(outra);
  const b = novoBoleto('boleto', outra);
  assert(!orchestrator.lancarTarifaBoleto(db, b, '2026-08-25', 'teste'), 'lançou tarifa zero');
  assert(db.prepare('SELECT contaPagarTarifaId FROM boletos WHERE id = ?').get(b).contaPagarTarifaId === null,
    'marcou o boleto sem ter lançado');
});

t('o fornecedor da tarifa é criado uma vez e reusado', () => {
  const n = db.prepare("SELECT COUNT(*) n FROM pessoas WHERE cpfCnpj = 'TARIFA-asaas'").get().n;
  assert(n === 1, `esperava 1 fornecedor da tarifa, veio ${n}`);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
