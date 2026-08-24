/**
 * Orçamento × plano de contas: herança da classificação, o que fica de fora
 * do relatório, e o compromissado que ainda não virou pagamento.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const C = require('../orcamento-classificacao');
const { registrarRotasPlanejamento } = require('../planejamento-routes');

const DB = '/tmp/vp-orcamento.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-orcamento-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}

const app = express();
registrarRotasPlanejamento(app, db);
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

const ANO = '2026';
const dia = (d) => `${ANO}-03-${String(d).padStart(2, '0')}`;

// ---------- seed ----------
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (1,'00000000000191','Cliente','cliente',1)").run();
db.prepare("INSERT INTO fornecedores (id, razaoSocial, cpfCnpj, ativo) VALUES (1,'Fornecedor','00000000000272',1)").run();
const pc = db.prepare("INSERT INTO plano_contas (codigo, nome, tipo) VALUES (?,?,?)");
const PC_VENDAS = pc.run('3.1', 'Receita de vendas', 'receita').lastInsertRowid;
const PC_ALUGUEL = pc.run('4.1', 'Aluguel', 'despesa').lastInsertRowid;

const CAT_VENDAS = db.prepare("INSERT INTO categorias_cr (nome, planoContaId, ativo) VALUES ('Vendas', ?, 1)").run(PC_VENDAS).lastInsertRowid;
const CAT_SEMPLANO = db.prepare("INSERT INTO categorias_cr (nome, ativo) VALUES ('Sem plano', 1)").run().lastInsertRowid;
const CATP_ALUGUEL = db.prepare("INSERT INTO categorias_cp (nome, planoContaId, ativo) VALUES ('Aluguel', ?, 1)").run(PC_ALUGUEL).lastInsertRowid;

const novoCR = (valor, o = {}) => db.prepare(`INSERT INTO contas_a_receber
  (pessoaId, categoriaId, planoContaId, descricao, valor, dataEmissao, dataVencimento, status, origem)
  VALUES (1, ?, ?, 'CR', ?, ?, ?, ?, 'manual')`)
  .run(o.categoriaId ?? null, o.planoContaId ?? null, valor, dia(1), o.vencimento || dia(20),
       o.status || 'aberta').lastInsertRowid;

const novoCP = (valor, o = {}) => db.prepare(`INSERT INTO contas_a_pagar
  (fornecedorId, categoriaId, planoContaId, descricao, valor, dataEmissao, dataVencimento, status, origem)
  VALUES (1, ?, ?, 'CP', ?, ?, ?, ?, 'manual')`)
  .run(o.categoriaId ?? null, o.planoContaId ?? null, valor, dia(1), o.vencimento || dia(20),
       o.status || 'aberta').lastInsertRowid;

const pagarCR = (id, valor, data) => db.prepare(`INSERT INTO contas_receber_pagamentos
  (contaReceberId, dataPagamento, valorPago, valorBase, estornado) VALUES (?,?,?,?,0)`).run(id, data, valor, valor);
const pagarCP = (id, valor, data) => db.prepare(`INSERT INTO contas_pagar_pagamentos
  (contaPagarId, dataPagamento, valorPago, valorBase, estornado) VALUES (?,?,?,?,0)`).run(id, data, valor, valor);

// ---------- herança ----------
t('título com categoria herda o plano de contas dela', () => {
  const id = novoCR(1000, { categoriaId: CAT_VENDAS });
  const c = db.prepare('SELECT planoContaId FROM contas_a_receber WHERE id=?').get(id);
  assert(c.planoContaId === PC_VENDAS, 'não herdou: ' + c.planoContaId);
});

t('classificação explícita não é sobrescrita pela categoria', () => {
  const id = novoCR(500, { categoriaId: CAT_VENDAS, planoContaId: PC_ALUGUEL });
  const c = db.prepare('SELECT planoContaId FROM contas_a_receber WHERE id=?').get(id);
  assert(c.planoContaId === PC_ALUGUEL, 'sobrescreveu a escolha do usuário: ' + c.planoContaId);
});

t('categoria sem plano deixa o título sem plano, sem inventar', () => {
  const id = novoCR(700, { categoriaId: CAT_SEMPLANO });
  const c = db.prepare('SELECT planoContaId FROM contas_a_receber WHERE id=?').get(id);
  assert(c.planoContaId === null, 'inventou classificação: ' + c.planoContaId);
});

t('a herança vale para contas a pagar também', () => {
  const id = novoCP(300, { categoriaId: CATP_ALUGUEL });
  const c = db.prepare('SELECT planoContaId FROM contas_a_pagar WHERE id=?').get(id);
  assert(c.planoContaId === PC_ALUGUEL, 'CP não herdou: ' + c.planoContaId);
});

t('definir o plano na categoria classifica os títulos que estavam sem', () => {
  const id = novoCR(900, { categoriaId: CAT_SEMPLANO });
  db.prepare('UPDATE categorias_cr SET planoContaId = ? WHERE id = ?').run(PC_VENDAS, CAT_SEMPLANO);
  const c = db.prepare('SELECT planoContaId FROM contas_a_receber WHERE id=?').get(id);
  assert(c.planoContaId === PC_VENDAS, 'não propagou: ' + c.planoContaId);
  // Volta ao estado anterior para os próximos casos.
  db.prepare('UPDATE categorias_cr SET planoContaId = NULL WHERE id = ?').run(CAT_SEMPLANO);
});

t('mudar a categoria não reescreve título classificado à mão', () => {
  const id = novoCR(400, { categoriaId: CAT_SEMPLANO, planoContaId: PC_ALUGUEL });
  db.prepare('UPDATE categorias_cr SET planoContaId = ? WHERE id = ?').run(PC_VENDAS, CAT_SEMPLANO);
  const c = db.prepare('SELECT planoContaId FROM contas_a_receber WHERE id=?').get(id);
  assert(c.planoContaId === PC_ALUGUEL, 'reescreveu o manual: ' + c.planoContaId);
  db.prepare('UPDATE categorias_cr SET planoContaId = NULL WHERE id = ?').run(CAT_SEMPLANO);
});

// ---------- previsto x realizado ----------
t('realizado agrega o pagamento pela conta do título', () => {
  const id = novoCR(2000, { categoriaId: CAT_VENDAS });
  pagarCR(id, 2000, dia(15));
  chamar('/api/orcamento', 'post', { body: { planoContaId: PC_VENDAS, competencia: ANO + '-03', valorPrevisto: 5000 } });
  const d = chamar('/api/orcamento/previsto-realizado', 'get', { query: { ano: ANO } }).out;
  const l = d.linhas.find(x => x.planoContaId === PC_VENDAS && x.competencia === ANO + '-03');
  assert(l, 'linha não veio');
  assert(perto(l.previsto, 5000), 'previsto: ' + l.previsto);
  assert(perto(l.realizado, 2000), 'realizado: ' + l.realizado);
  assert(perto(l.desvio, -3000), 'desvio: ' + l.desvio);
});

t('o que ficou sem classificação é reportado, não escondido', () => {
  const semClas = novoCR(8000);          // sem categoria e sem plano
  pagarCR(semClas, 8000, dia(16));
  const d = chamar('/api/orcamento/previsto-realizado', 'get', { query: { ano: ANO } }).out;
  assert(perto(d.semClassificacao.receber.valorPago, 8000), JSON.stringify(d.semClassificacao.receber));
  assert(d.semClassificacao.receber.titulosPagos === 1, 'títulos: ' + d.semClassificacao.receber.titulosPagos);
  assert(perto(d.semClassificacao.valorPagoTotal, 8000), 'total fora: ' + d.semClassificacao.valorPagoTotal);
});

t('a cobertura diz quanto do dinheiro o relatório está enxergando', () => {
  const d = chamar('/api/orcamento/previsto-realizado', 'get', { query: { ano: ANO } }).out;
  // 2000 classificados de 10000 movimentados = 20%
  assert(perto(d.cobertura.classificado, 2000), 'classificado: ' + d.cobertura.classificado);
  assert(perto(d.cobertura.naoClassificado, 8000), 'não classificado: ' + d.cobertura.naoClassificado);
  assert(perto(d.cobertura.percentual, 20), 'percentual: ' + d.cobertura.percentual);
});

t('categoria sem conta aparece nominalmente, para resolver num lugar só', () => {
  novoCR(1500, { categoriaId: CAT_SEMPLANO });
  const d = chamar('/api/orcamento/previsto-realizado', 'get', { query: { ano: ANO } }).out;
  const cat = d.semClassificacao.receber.categoriasSemConta.find(c => c.id === CAT_SEMPLANO);
  assert(cat, 'categoria sem conta não foi listada');
  assert(cat.nome === 'Sem plano', 'nome: ' + cat.nome);
  assert(cat.titulos >= 1, 'títulos: ' + cat.titulos);
});

t('título sem categoria nenhuma é contado à parte', () => {
  const d = chamar('/api/orcamento/previsto-realizado', 'get', { query: { ano: ANO } }).out;
  assert(d.semClassificacao.receber.semCategoria.titulos >= 1, JSON.stringify(d.semClassificacao.receber.semCategoria));
});

// ---------- compromissado ----------
t('título aberto entra como a realizar, não como realizado', () => {
  const id = novoCP(1200, { categoriaId: CATP_ALUGUEL, vencimento: ANO + '-04-10' });
  chamar('/api/orcamento', 'post', { body: { planoContaId: PC_ALUGUEL, competencia: ANO + '-04', valorPrevisto: 1000 } });
  const d = chamar('/api/orcamento/previsto-realizado', 'get', { query: { ano: ANO } }).out;
  const l = d.linhas.find(x => x.planoContaId === PC_ALUGUEL && x.competencia === ANO + '-04');
  assert(l, 'linha de abril não veio');
  assert(perto(l.realizado, 0), 'não pode contar como realizado: ' + l.realizado);
  assert(perto(l.aRealizar, 1200), 'a realizar: ' + l.aRealizar);
  // Projetado é o que decide se vai estourar: 1200 contra 1000 previstos.
  assert(perto(l.projetado, 1200), 'projetado: ' + l.projetado);
  assert(l.projetado > l.previsto, 'o estouro deveria ser visível antes de pagar');
});

t('pagamento parcial move só a parte paga para realizado', () => {
  const id = novoCP(1000, { categoriaId: CATP_ALUGUEL, vencimento: ANO + '-05-10' });
  pagarCP(id, 400, ANO + '-05-05');
  db.prepare("UPDATE contas_a_pagar SET status='parcial', valorPago=400 WHERE id=?").run(id);
  const d = chamar('/api/orcamento/previsto-realizado', 'get', { query: { ano: ANO } }).out;
  const l = d.linhas.find(x => x.planoContaId === PC_ALUGUEL && x.competencia === ANO + '-05');
  assert(perto(l.realizado, 400), 'realizado: ' + l.realizado);
  assert(perto(l.aRealizar, 600), 'a realizar deveria ser o saldo: ' + l.aRealizar);
});

t('título cancelado não entra em a realizar', () => {
  const id = novoCP(9999, { categoriaId: CATP_ALUGUEL, vencimento: ANO + '-06-10' });
  db.prepare("UPDATE contas_a_pagar SET status='cancelada' WHERE id=?").run(id);
  const d = chamar('/api/orcamento/previsto-realizado', 'get', { query: { ano: ANO } }).out;
  const l = d.linhas.find(x => x.planoContaId === PC_ALUGUEL && x.competencia === ANO + '-06');
  assert(!l || !(l.aRealizar > 0), 'cancelado entrou: ' + JSON.stringify(l));
});

// ---------- backfill ----------
t('classificar pendentes aplica a herança no histórico', () => {
  const orfao = db.prepare(`INSERT INTO contas_a_receber
    (pessoaId, categoriaId, descricao, valor, dataEmissao, dataVencimento, status, origem)
    VALUES (1, ?, 'antigo', 100, ?, ?, 'aberta', 'manual')`).run(CAT_SEMPLANO, dia(1), dia(20)).lastInsertRowid;
  db.prepare('UPDATE contas_a_receber SET planoContaId = NULL WHERE id = ?').run(orfao);
  db.prepare('UPDATE categorias_cr SET planoContaId = ? WHERE id = ?').run(PC_VENDAS, CAT_SEMPLANO);
  db.prepare('UPDATE contas_a_receber SET planoContaId = NULL WHERE id = ?').run(orfao);

  const r = chamar('/api/orcamento/classificar-pendentes', 'post', {});
  assert(r.out.success, 'erro: ' + r.out.error);
  const c = db.prepare('SELECT planoContaId FROM contas_a_receber WHERE id=?').get(orfao);
  assert(c.planoContaId === PC_VENDAS, 'backfill não classificou: ' + c.planoContaId);
});

t('rodar o backfill duas vezes não muda mais nada', () => {
  chamar('/api/orcamento/classificar-pendentes', 'post', {});
  const r = chamar('/api/orcamento/classificar-pendentes', 'post', {});
  assert(r.out.receber === 0 && r.out.pagar === 0, 'não é idempotente: ' + JSON.stringify(r.out));
});


// ==================== CATEGORIAS PADRÃO ====================
const PAD = require('../plano-categorias-padrao');
const PDB = '/tmp/vp-orc-padrao.db';

function baseComPlano() {
  try { fs.unlinkSync(PDB); } catch {}
  const d2 = new Database(PDB);
  d2.exec(schema);
  const ins = d2.prepare('INSERT INTO plano_contas (codigo, nome, tipo, parentId, nivel, ordem, ativo) VALUES (?,?,?,?,?,?,1)');
  const pais = {};
  for (const [cod, nome, tipo] of [['1','RECEITA OPERACIONAL','receita'],['2','DEDUCOES','deducao'],
      ['3','CUSTO','custo'],['4','DESPESAS','despesa'],['5','RESULTADO FINANCEIRO','financeiro_receita'],
      ['6','INVESTIMENTOS','investimento']]) {
    pais[cod] = ins.run(cod, nome, tipo, null, 1, 0).lastInsertRowid;
  }
  for (const [cod, nome, tipo] of [['1.1','Receita de Vendas','receita'],['1.2','Outras Receitas','receita'],
      ['2.1','Impostos','deducao'],['3.1','CMV','custo'],['3.2','Custo Servicos','custo'],
      ['4.1','Pessoal','despesa'],['4.2','Administrativas','despesa'],['4.3','Comerciais','despesa'],
      ['4.4','Tecnologia','despesa'],['4.5','Outras Despesas','despesa'],
      ['5.1','Receitas Financeiras','financeiro_receita'],['5.2','Despesas Financeiras','financeiro_despesa'],
      ['6.1','Imobilizado','investimento']]) {
    ins.run(cod, nome, tipo, pais[cod.split('.')[0]], 2, 0);
  }
  return d2;
}

t('padrão liga toda categoria a uma conta ANALÍTICA', () => {
  const d2 = baseComPlano();
  const r = PAD.aplicarPadrao(d2);
  assert(r.contasCriadas.includes('1.3'),
    'não criou a conta de receita de serviços: ' + JSON.stringify(r.contasCriadas));

  for (const tabela of ['categorias_cr', 'categorias_cp']) {
    const soltas = d2.prepare('SELECT nome FROM ' + tabela + ' WHERE planoContaId IS NULL').all();
    assert(!soltas.length, tabela + ' com categoria sem conta: ' + soltas.map(x => x.nome).join(', '));
    // Conta sintética some a natureza da despesa dentro do cabeçalho do grupo.
    const sinteticas = d2.prepare('SELECT c.nome, pc.codigo FROM ' + tabela + ' c'
      + ' JOIN plano_contas pc ON pc.id = c.planoContaId'
      + ' WHERE (SELECT COUNT(*) FROM plano_contas f WHERE f.parentId = pc.id) > 0').all();
    assert(!sinteticas.length, tabela + ' apontando para sintética: ' + JSON.stringify(sinteticas));
  }
  d2.close();
});

t('padrão não sobrescreve o que o tenant já mapeou', () => {
  const d2 = baseComPlano();
  PAD.aplicarPadrao(d2);
  const alvo = d2.prepare("SELECT id FROM categorias_cp WHERE nome='Energia'").get();
  const outra = d2.prepare("SELECT id FROM plano_contas WHERE codigo='4.5'").get();
  d2.prepare('UPDATE categorias_cp SET planoContaId = ? WHERE id = ?').run(outra.id, alvo.id);
  PAD.aplicarPadrao(d2);
  const depois = d2.prepare("SELECT planoContaId FROM categorias_cp WHERE nome='Energia'").get();
  assert(depois.planoContaId === outra.id, 'reescreveu a escolha do tenant');
  d2.close();
});

t('forcar remapeia, mas só quando pedido explicitamente', () => {
  const d2 = baseComPlano();
  PAD.aplicarPadrao(d2);
  const alvo = d2.prepare("SELECT id FROM categorias_cp WHERE nome='Energia'").get();
  const outra = d2.prepare("SELECT id FROM plano_contas WHERE codigo='4.5'").get();
  d2.prepare('UPDATE categorias_cp SET planoContaId = ? WHERE id = ?').run(outra.id, alvo.id);
  const r = PAD.aplicarPadrao(d2, { forcar: true });
  assert(r.remapeadas >= 1, 'não remapeou com forcar: ' + r.remapeadas);
  const energia = d2.prepare('SELECT pc.codigo FROM categorias_cp c JOIN plano_contas pc ON pc.id=c.planoContaId'
    + " WHERE c.nome='Energia'").get();
  assert(energia.codigo === '4.2', 'não voltou ao padrão: ' + energia.codigo);
  d2.close();
});

t('aplicar duas vezes não duplica categoria', () => {
  const d2 = baseComPlano();
  PAD.aplicarPadrao(d2);
  const antes = d2.prepare('SELECT COUNT(*) n FROM categorias_cp').get().n;
  PAD.aplicarPadrao(d2);
  const depois = d2.prepare('SELECT COUNT(*) n FROM categorias_cp').get().n;
  assert(antes === depois, 'duplicou: ' + antes + ' -> ' + depois);
  d2.close();
});

t('categoria apontando para sintética é corrigida para a analítica', () => {
  const d2 = baseComPlano();
  PAD.aplicarPadrao(d2);
  const sint = d2.prepare("SELECT id FROM plano_contas WHERE codigo='5'").get();
  const cat = d2.prepare("SELECT id FROM categorias_cr WHERE nome='Juros/Rendimentos'").get();
  d2.prepare('UPDATE categorias_cr SET planoContaId = ? WHERE id = ?').run(sint.id, cat.id);
  PAD.aplicarPadrao(d2);
  const c = d2.prepare('SELECT pc.codigo FROM categorias_cr c JOIN plano_contas pc ON pc.id=c.planoContaId'
    + ' WHERE c.id = ?').get(cat.id);
  assert(c.codigo === '5.1', 'continuou na sintética: ' + c.codigo);
  d2.close();
});

t('nenhuma conta de despesa fica sem categoria alimentando', () => {
  const d2 = baseComPlano();
  PAD.aplicarPadrao(d2);
  const d = PAD.diagnostico(d2);
  assert(!d.semConta.receber.length && !d.semConta.pagar.length,
    'sobrou categoria sem conta: ' + JSON.stringify(d.semConta));
  const codigos = d.contasSemCategoria.map(c => c.codigo);
  for (const c of ['4.1', '4.2', '4.3', '4.4', '4.5', '5.2', '6.1', '3.1', '3.2']) {
    assert(!codigos.includes(c), 'conta sem categoria alimentando: ' + c);
  }
  d2.close();
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
