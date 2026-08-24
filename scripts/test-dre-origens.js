/**
 * DRE: o que entra no resultado e o que fica de fora.
 *
 * Três defeitos motivaram estes testes:
 *  1. regime de caixa somava o valor de face do título e exigia status='paga',
 *     então título parcialmente recebido sumia inteiro (no 1bit, R$ 3.613,33
 *     recebidos que o relatório não mostrava);
 *  2. movimento bancário sem título por trás (tarifa, IOF, rendimento) nunca
 *     chegava ao DRE, mesmo classificado numa conta do plano;
 *  3. nada disso era dito — o relatório parecia completo.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasGerencial } = require('../gerencial-routes');

const DB = '/tmp/vp-dre.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-dre-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  // Stub das tabelas referenciadas, com a linha 1 semeada: as FKs de pessoa e
  // fornecedor sao NOT NULL nos titulos.
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  try { db.exec(`INSERT OR IGNORE INTO ${m[1]} (id) VALUES (1)`); } catch {}
}

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const perto = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;

// ---------- plano de contas ----------
const conta = (codigo, nome, tipo, parentId, nivel) =>
  db.prepare('INSERT INTO plano_contas (codigo, nome, tipo, parentId, nivel, ativo, ordem) VALUES (?,?,?,?,?,1,?)')
    .run(codigo, nome, tipo, parentId, nivel, codigo).lastInsertRowid;

const RECEITA = conta('1', 'Receita de Serviços', 'receita', null, 1);
const DESPESA = conta('4', 'Despesas Operacionais', 'despesa', null, 1);
const FIN_REC = conta('5', 'Receitas Financeiras', 'financeiro_receita', null, 1);
const FIN_DESP = conta('6', 'Despesas Financeiras', 'financeiro_despesa', null, 1);
const TARIFA = conta('6.1', 'Tarifas Bancárias', 'financeiro_despesa', FIN_DESP, 2);
const RENDIMENTO = conta('5.1', 'Rendimento de Aplicação', 'financeiro_receita', FIN_REC, 2);

const CONTA_FIN = db.prepare("INSERT INTO contas_financeiras (nome, tipo, ativo) VALUES ('Banco', 'corrente', 1)").run().lastInsertRowid;

// ---------- app ----------
const app = express();
app.use(express.json());
registrarRotasGerencial(app, db);

function dre(query) {
  let h = null;
  for (const c of app.router.stack) {
    if (c.route && c.route.path === '/api/dre' && c.route.methods.get) h = c.route.stack[c.route.stack.length - 1].handle;
  }
  if (!h) throw new Error('rota /api/dre não encontrada');
  let out = null;
  h({ query, params: {}, body: {} },
    { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { out = j; } },
    () => {});
  if (!out) throw new Error('sem resposta');
  if (!out.success) throw new Error('erro: ' + out.error);
  return out;
}
const PERIODO = { dataIni: '2026-07-01', dataFim: '2026-07-31' };
const caixa = (extra = {}) => dre({ ...PERIODO, regime: 'caixa', ...extra });
const competencia = (extra = {}) => dre({ ...PERIODO, regime: 'competencia', ...extra });

function limpar() {
  db.exec(`DELETE FROM contas_receber_pagamentos; DELETE FROM contas_pagar_pagamentos;
    DELETE FROM contas_a_receber; DELETE FROM contas_a_pagar; DELETE FROM transacoes_bancarias;`);
}
const addCR = (o) => db.prepare(`INSERT INTO contas_a_receber
  (pessoaId, descricao, valor, dataEmissao, dataVencimento, dataPagamento, valorPago, status, planoContaId, centroCustoId)
  VALUES (1, @descricao, @valor, @dataEmissao, @dataVencimento, @dataPagamento, @valorPago, @status, @planoContaId, @centroCustoId)`)
  .run({ descricao: 'CR', dataEmissao: '2026-07-05', dataVencimento: '2026-07-20',
         dataPagamento: null, valorPago: null, planoContaId: RECEITA, centroCustoId: null, ...o });
const addCP = (o) => db.prepare(`INSERT INTO contas_a_pagar
  (fornecedorId, descricao, valor, dataEmissao, dataVencimento, dataPagamento, valorPago, status, planoContaId, centroCustoId)
  VALUES (1, @descricao, @valor, @dataEmissao, @dataVencimento, @dataPagamento, @valorPago, @status, @planoContaId, @centroCustoId)`)
  .run({ descricao: 'CP', dataEmissao: '2026-07-05', dataVencimento: '2026-07-20',
         dataPagamento: null, valorPago: null, planoContaId: DESPESA, centroCustoId: null, ...o });
const addPagCR = (o) => db.prepare(`INSERT INTO contas_receber_pagamentos
  (contaReceberId, dataPagamento, valorPago, valorBase, juros, multa, desconto, formaPagamento, estornado)
  VALUES (@contaReceberId, @dataPagamento, @valorPago, @valorBase, @juros, @multa, @desconto, 'pix', @estornado)`)
  .run({ dataPagamento: '2026-07-10', juros: 0, multa: 0, desconto: 0, estornado: 0,
         valorPago: null, ...o, valorPago: o.valorPago != null ? o.valorPago
           : (o.valorBase + (o.juros || 0) + (o.multa || 0) - (o.desconto || 0)) });
const addPagCP = (o) => db.prepare(`INSERT INTO contas_pagar_pagamentos
  (contaPagarId, dataPagamento, valorPago, valorBase, juros, multa, desconto, formaPagamento, estornado)
  VALUES (@contaPagarId, @dataPagamento, @valorPago, @valorBase, @juros, @multa, @desconto, 'pix', @estornado)`)
  .run({ dataPagamento: '2026-07-10', juros: 0, multa: 0, desconto: 0, estornado: 0,
         valorPago: null, ...o, valorPago: o.valorPago != null ? o.valorPago
           : (o.valorBase + (o.juros || 0) + (o.multa || 0) - (o.desconto || 0)) });

let seqFit = 0;
const addTx = (o) => db.prepare(`INSERT INTO transacoes_bancarias
  (contaFinanceiraId, fitid, data, valor, tipo, descricao, conciliadaCom, conciliadaId, planoContaIdSugerido)
  VALUES (@contaFinanceiraId, @fitid, @data, @valor, @tipo, @descricao, @conciliadaCom, @conciliadaId, @planoContaIdSugerido)`)
  .run({ contaFinanceiraId: CONTA_FIN, fitid: 'FIT' + (++seqFit), data: '2026-07-10', tipo: 'DEBIT',
         descricao: 'MOV', conciliadaCom: null, conciliadaId: null, planoContaIdSugerido: null, ...o });

// ================= TÍTULOS =================
console.log('\n--- caixa: o que realmente entrou e saiu ---');

t('titulo recebido em duas vezes aparece no mes de cada pagamento', () => {
  limpar();
  const cr = addCR({ valor: 5000, status: 'parcial' }).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 2000, dataPagamento: '2026-06-20' });
  addPagCR({ contaReceberId: cr, valorBase: 3000, dataPagamento: '2026-07-15' });
  // O cabecalho guarda um valorPago so; ler dele jogava tudo num mes ou em nenhum.
  assert(perto(caixa().sumario.totalReceitas, 3000), 'julho: ' + caixa().sumario.totalReceitas);
});

t('titulo parcial sem dataPagamento no cabecalho nao some mais', () => {
  limpar();
  // Exatamente o caso do 1bit: valorPago preenchido, dataPagamento NULA.
  const cr = addCR({ valor: 5000, valorPago: 3613.33, status: 'parcial', dataPagamento: null }).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 3613.33, juros: 556.67, multa: 100, dataPagamento: '2026-07-10' });
  assert(perto(caixa().sumario.totalReceitas, 3613.33), 'receita: ' + caixa().sumario.totalReceitas);
});

t('juros e multa recebidos viram receita financeira, nao receita de servico', () => {
  limpar();
  const cr = addCR({ valor: 1000, status: 'paga' }).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 1000, juros: 80, multa: 20 });
  const d = caixa();
  assert(perto(d.sumario.totalReceitas, 1000), 'receita operacional: ' + d.sumario.totalReceitas);
  assert(perto(d.sumario.finReceita, 100), 'financeira: ' + d.sumario.finReceita);
  assert(perto(d.origens.encargos.receita, 100), JSON.stringify(d.origens.encargos));
});

t('desconto concedido ao cliente e despesa financeira', () => {
  limpar();
  const cr = addCR({ valor: 1000, status: 'paga' }).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 1000, desconto: 50 });
  const d = caixa();
  assert(perto(d.sumario.finDespesa, 50), 'finDespesa: ' + d.sumario.finDespesa);
  assert(perto(d.sumario.totalReceitas, 1000), d.sumario.totalReceitas);
});

t('juros pagos ao fornecedor sao despesa financeira', () => {
  limpar();
  const cp = addCP({ valor: 2000, status: 'paga' }).lastInsertRowid;
  addPagCP({ contaPagarId: cp, valorBase: 2000, juros: 150, multa: 30 });
  const d = caixa();
  assert(perto(d.sumario.totalDespesas, 2000), 'despesa operacional: ' + d.sumario.totalDespesas);
  assert(perto(d.sumario.finDespesa, 180), 'financeira: ' + d.sumario.finDespesa);
});

t('desconto obtido do fornecedor e receita financeira', () => {
  limpar();
  const cp = addCP({ valor: 2000, status: 'paga' }).lastInsertRowid;
  addPagCP({ contaPagarId: cp, valorBase: 2000, desconto: 120 });
  assert(perto(caixa().sumario.finReceita, 120), caixa().sumario.finReceita);
});

t('pagamento estornado nao conta', () => {
  limpar();
  const cr = addCR({ valor: 1000, status: 'paga' }).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 1000, juros: 50, estornado: 1 });
  const d = caixa();
  assert(perto(d.sumario.totalReceitas, 0), 'receita: ' + d.sumario.totalReceitas);
  assert(perto(d.sumario.finReceita, 0), 'juros de estorno entraram: ' + d.sumario.finReceita);
});

t('pagamento fora do periodo nao entra', () => {
  limpar();
  const cr = addCR({ valor: 1000, status: 'paga' }).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 1000, dataPagamento: '2026-06-30' });
  assert(perto(caixa().sumario.totalReceitas, 0), caixa().sumario.totalReceitas);
});

t('o total do DRE bate com o dinheiro que passou pela conta', () => {
  limpar();
  const cr = addCR({ valor: 1000, status: 'paga' }).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 1000, juros: 80, multa: 20, desconto: 30 });
  const d = caixa();
  // valorPago = 1000 + 80 + 20 - 30 = 1070
  const liquido = d.sumario.totalReceitas + d.sumario.finReceita - d.sumario.finDespesa;
  assert(perto(liquido, 1070), 'entrou 1070, DRE diz ' + liquido);
});

t('titulo sem conta do plano e reportado, nao somado as escondidas', () => {
  limpar();
  const cr = addCR({ valor: 4000, status: 'paga', planoContaId: null }).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 4000 });
  const d = caixa();
  assert(perto(d.sumario.totalReceitas, 0), 'somou sem classificacao: ' + d.sumario.totalReceitas);
  assert(perto(d.semClassificacao.receitas, 4000), 'nao reportou: ' + d.semClassificacao.receitas);
});

console.log('\n--- competencia continua pelo valor de face ---');

t('competencia usa o valor do titulo e a data de emissao', () => {
  limpar();
  const cr = addCR({ valor: 5000, status: 'parcial', dataEmissao: '2026-07-05' }).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 3613.33, dataPagamento: '2026-08-20' });
  assert(perto(competencia().sumario.totalReceitas, 5000), competencia().sumario.totalReceitas);
});

t('competencia ignora encargos: o titulo ainda nao foi acertado', () => {
  limpar();
  const cr = addCR({ valor: 1000, status: 'paga', dataEmissao: '2026-07-05' }).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 1000, juros: 80 });
  const d = competencia();
  assert(perto(d.sumario.finReceita, 0), 'juros em competencia: ' + d.sumario.finReceita);
  assert(perto(d.origens.encargos.receita, 0), JSON.stringify(d.origens.encargos));
});

t('titulo cancelado fica fora dos dois regimes', () => {
  limpar();
  addCR({ valor: 900, status: 'cancelada', dataEmissao: '2026-07-05' });
  assert(perto(competencia().sumario.totalReceitas, 0), competencia().sumario.totalReceitas);
  assert(perto(caixa().sumario.totalReceitas, 0), caixa().sumario.totalReceitas);
});

// ================= BANCO =================
console.log('\n--- movimento bancário sem título ---');

t('tarifa importada do extrato entra como despesa financeira', () => {
  limpar();
  addTx({ valor: -35.90, descricao: 'TARIFA MENSALIDADE', planoContaIdSugerido: TARIFA });
  const d = caixa();
  assert(perto(d.sumario.finDespesa, 35.90), 'finDespesa: ' + d.sumario.finDespesa);
  assert(perto(d.sumario.resultado, -35.90), 'resultado: ' + d.sumario.resultado);
});

t('rendimento de aplicação entra como receita financeira', () => {
  limpar();
  addTx({ valor: 120.45, tipo: 'CREDIT', descricao: 'RENDIMENTO', planoContaIdSugerido: RENDIMENTO });
  assert(perto(caixa().sumario.finReceita, 120.45), caixa().sumario.finReceita);
});

t('estorno de tarifa abate a despesa em vez de virar receita', () => {
  limpar();
  addTx({ valor: -35.90, planoContaIdSugerido: TARIFA });
  addTx({ valor: 35.90, tipo: 'CREDIT', descricao: 'ESTORNO TARIFA', planoContaIdSugerido: TARIFA });
  const d = caixa();
  assert(perto(d.sumario.finDespesa, 0), 'finDespesa: ' + d.sumario.finDespesa);
  assert(perto(d.sumario.finReceita, 0), 'virou receita: ' + d.sumario.finReceita);
});

t('transação conciliada com um título NÃO é contada de novo', () => {
  limpar();
  const cr = addCR({ valor: 1000, status: 'paga' }).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 1000 });
  addTx({ valor: 1000, tipo: 'CREDIT', conciliadaCom: 'cr', conciliadaId: cr, planoContaIdSugerido: RECEITA });
  const d = caixa();
  assert(perto(d.sumario.totalReceitas, 1000), 'dobrou a receita: ' + d.sumario.totalReceitas);
});

t('conciliação avulsa (sem título) entra — é o caso que justifica a fonte', () => {
  limpar();
  addTx({ valor: -80, conciliadaCom: 'avulsa', planoContaIdSugerido: TARIFA });
  assert(perto(caixa().sumario.finDespesa, 80), caixa().sumario.finDespesa);
});

t("transação marcada 'ignorada' pela regra fica fora", () => {
  limpar();
  addTx({ valor: -500, conciliadaCom: 'ignorada', planoContaIdSugerido: TARIFA });
  assert(perto(caixa().sumario.finDespesa, 0), 'entrou o que a regra mandou ignorar');
});

t('movimento sem conta do plano não entra no resultado', () => {
  limpar();
  addTx({ valor: -222, planoContaIdSugerido: null });
  assert(perto(caixa().sumario.resultado, 0), caixa().sumario.resultado);
});

t('movimento bancário fora do período não entra', () => {
  limpar();
  addTx({ valor: -10, data: '2026-06-15', planoContaIdSugerido: TARIFA });
  addTx({ valor: -20, data: '2026-08-15', planoContaIdSugerido: TARIFA });
  assert(perto(caixa().sumario.finDespesa, 0), caixa().sumario.finDespesa);
});

t('banco também entra no regime de competência (a tarifa existiu de qualquer jeito)', () => {
  limpar();
  addTx({ valor: -35.90, planoContaIdSugerido: TARIFA });
  assert(perto(competencia().sumario.finDespesa, 35.90), competencia().sumario.finDespesa);
});

t('título e banco somam juntos no mesmo resultado', () => {
  limpar();
  addPagCR({ contaReceberId: addCR({ valor: 10000, status: 'paga' }).lastInsertRowid, valorBase: 10000 });
  addPagCP({ contaPagarId: addCP({ valor: 3000, status: 'paga' }).lastInsertRowid, valorBase: 3000 });
  addTx({ valor: -35.90, planoContaIdSugerido: TARIFA });
  addTx({ valor: 120.45, tipo: 'CREDIT', planoContaIdSugerido: RENDIMENTO });
  const d = caixa();
  assert(perto(d.sumario.resultado, 10000 - 3000 - 35.90 + 120.45), 'resultado: ' + d.sumario.resultado);
});

// ================= TRANSPARÊNCIA =================
console.log('\n--- o relatório diz o que ficou de fora ---');

t('conta quantos movimentos do extrato ficaram sem classificação', () => {
  limpar();
  addTx({ valor: -222, planoContaIdSugerido: null });
  addTx({ valor: -111, planoContaIdSugerido: null });
  addTx({ valor: -35.90, planoContaIdSugerido: TARIFA });
  const b = caixa().origens.banco;
  assert(b.naoClassificado.qtd === 2, 'qtd: ' + b.naoClassificado.qtd);
  assert(perto(b.naoClassificado.valor, 333), 'valor: ' + b.naoClassificado.valor);
});

t('avisa quando o movimento entrou por regra mas ninguém conciliou', () => {
  limpar();
  addTx({ valor: -35.90, conciliadaCom: null, planoContaIdSugerido: TARIFA });
  addTx({ valor: -12.00, conciliadaCom: 'avulsa', planoContaIdSugerido: TARIFA });
  assert(caixa().origens.banco.pendenteRevisao === 1, caixa().origens.banco.pendenteRevisao);
});

t('separa quanto veio de título e quanto veio do banco', () => {
  limpar();
  addPagCR({ contaReceberId: addCR({ valor: 1000, status: 'paga' }).lastInsertRowid, valorBase: 1000 });
  addTx({ valor: -35.90, planoContaIdSugerido: TARIFA });
  const o = caixa().origens;
  assert(perto(o.titulos.receitas, 1000), 'titulos: ' + o.titulos.receitas);
  assert(perto(o.banco.despesas, 35.90), 'banco despesas: ' + o.banco.despesas);
  assert(perto(o.banco.receitas, 0), 'banco receitas: ' + o.banco.receitas);
  assert(o.banco.lancamentos === 1, 'lancamentos: ' + o.banco.lancamentos);
});

t('filtrar por centro de custo exclui o banco E diz por quê', () => {
  limpar();
  addTx({ valor: -35.90, planoContaIdSugerido: TARIFA });
  const d = caixa({ centroCustoId: 1 });
  // transacoes_bancarias não tem centro de custo: somar seria atribuir a nota
  // fiscal de alguém a um centro que ninguém escolheu.
  assert(perto(d.sumario.finDespesa, 0), 'somou banco com filtro de centro: ' + d.sumario.finDespesa);
  assert(d.origens.banco.incluido === false, JSON.stringify(d.origens.banco));
  assert(/centro de custo/.test(d.origens.banco.motivoExclusao || ''), d.origens.banco.motivoExclusao);
});

t('sem filtro de centro, o banco volta e não há motivo de exclusão', () => {
  const b = caixa().origens.banco;
  assert(b.incluido === true && b.motivoExclusao === null, JSON.stringify(b));
});

console.log('\n--- tenant sem conciliação bancária ---');

t('banco sem a tabela de transações não derruba o DRE e explica a ausência', () => {
  try { fs.unlinkSync('/tmp/vp-dre-sem-banco.db'); } catch {}
  const db2 = new Database('/tmp/vp-dre-sem-banco.db');
  db2.exec(schema);
  for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
    db2.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  }
  db2.exec('DROP TABLE transacoes_bancarias');
  const app2 = express();
  app2.use(express.json());
  registrarRotasGerencial(app2, db2);
  let h = null;
  for (const c of app2.router.stack) {
    if (c.route && c.route.path === '/api/dre' && c.route.methods.get) h = c.route.stack[c.route.stack.length - 1].handle;
  }
  let out = null;
  h({ query: { ...PERIODO, regime: 'caixa' }, params: {}, body: {} },
    { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { out = j; } }, () => {});
  assert(out && out.success, JSON.stringify(out));
  assert(out.origens.banco.incluido === false, JSON.stringify(out.origens.banco));
  assert(/não instalado/.test(out.origens.banco.motivoExclusao || ''), out.origens.banco.motivoExclusao);
  db2.close();
  try { fs.unlinkSync('/tmp/vp-dre-sem-banco.db'); } catch {}
});


// ================= CLASSIFICAÇÃO NA ORIGEM =================
console.log('\n--- a receita de NFS-e nasce classificada ---');

const { categoriaReceitaServico } = require('../nfse-routes');

function comCategorias(linhas) {
  db.exec('DELETE FROM categorias_cr');
  for (const l of linhas) {
    db.prepare('INSERT INTO categorias_cr (nome, planoContaId) VALUES (?, ?)').run(l[0], l[1]);
  }
}

t('escolhe a categoria de serviço quando ela existe', () => {
  comCategorias([['Vendas', RECEITA], ['Serviços', RECEITA], ['Outros', RECEITA]]);
  const c = categoriaReceitaServico(db);
  assert(c && c.nome === 'Serviços', JSON.stringify(c));
});

t('acha a categoria mesmo escrita sem acento ou em caixa alta', () => {
  comCategorias([['Vendas', RECEITA], ['SERVICOS PRESTADOS', RECEITA]]);
  assert(categoriaReceitaServico(db).nome === 'SERVICOS PRESTADOS', JSON.stringify(categoriaReceitaServico(db)));
});

t('sem categoria de serviço, cai em outra ligada a conta de receita', () => {
  comCategorias([['Vendas', RECEITA]]);
  const c = categoriaReceitaServico(db);
  assert(c && c.nome === 'Vendas', JSON.stringify(c));
});

t('categoria ligada a conta de despesa não serve de receita', () => {
  comCategorias([['Reembolso', DESPESA]]);
  assert(categoriaReceitaServico(db) === null, JSON.stringify(categoriaReceitaServico(db)));
});

t('categoria sem conta do plano não é escolhida', () => {
  comCategorias([['Solta', null]]);
  assert(categoriaReceitaServico(db) === null, JSON.stringify(categoriaReceitaServico(db)));
});

t('tenant sem plano de contas devolve null em vez de estourar', () => {
  db.exec('DELETE FROM categorias_cr');
  assert(categoriaReceitaServico(db) === null, 'deveria ser null');
});

t('a conta a receber classificada aparece na receita do DRE', () => {
  limpar();
  comCategorias([['Serviços', RECEITA]]);
  const cat = categoriaReceitaServico(db);
  const cr = db.prepare(`INSERT INTO contas_a_receber
    (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, categoriaId, planoContaId)
    VALUES (1, 'NFSe 1 - Consultoria', 1200, '2026-07-05', '2026-07-20', 'paga', ?, ?)`)
    .run(cat.id, cat.planoContaId).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 1200 });
  const d = caixa();
  assert(perto(d.sumario.totalReceitas, 1200), 'receita: ' + d.sumario.totalReceitas);
  assert(perto(d.semClassificacao.receitas, 0), 'foi para sem classificação: ' + d.semClassificacao.receitas);
});

t('só a categoria já basta — o DRE cai nela quando não há plano direto', () => {
  limpar();
  comCategorias([['Serviços', RECEITA]]);
  const cat = categoriaReceitaServico(db);
  const cr = db.prepare(`INSERT INTO contas_a_receber
    (pessoaId, descricao, valor, dataEmissao, dataVencimento, status, categoriaId, planoContaId)
    VALUES (1, 'NFSe 2', 500, '2026-07-05', '2026-07-20', 'paga', ?, NULL)`).run(cat.id).lastInsertRowid;
  addPagCR({ contaReceberId: cr, valorBase: 500 });
  assert(perto(caixa().sumario.totalReceitas, 500), caixa().sumario.totalReceitas);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
