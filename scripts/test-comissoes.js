/**
 * Comissões: apuração, pagamento e estorno.
 *
 * Bugs que motivaram esta suíte, todos reproduzidos antes de corrigir:
 *
 *  1. `/apuracao/pagar` somava `a.valor` — a coluna é `valorComissao`. O total
 *     dava NaN→0, o `continue` pulava todo mundo, e a rota devolvia
 *     {success:true, marcadas:2} sem pagar nada, sem criar conta a pagar e sem
 *     marcar as apurações. O vendedor não recebia e ninguém via.
 *  2. Pedido `faturado` não entrava na apuração; `cancelado` pago entrava.
 *  3. Estorno só voltava o status: a conta a pagar continuava quitada e o
 *     dinheiro fora do caixa. A comissão podia ser paga duas vezes.
 *  4. `contas_a_pagar.fornecedorId` é NOT NULL e a rota mandava null — pagar
 *     sem informar fornecedor estourava com erro cru de SQLite.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const calc = require('../comissoes-calculo');

const DB = '/tmp/vp-com.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-com-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
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
const tem = (ps, cod) => ps.some((p) => p.codigo === cod);
const codigos = (ps) => ps.map((p) => p.codigo).join(', ') || '(nenhum)';

// ---------- fixture base ----------
db.prepare("INSERT INTO users (id, username, nome, passwordHash, cpfCnpj) VALUES (7, 'ana', 'Ana', 'x', '52998224725')").run();
db.prepare("INSERT INTO users (id, username, nome, passwordHash) VALUES (8, 'bruno', 'Bruno', 'x')").run();
db.prepare("INSERT INTO pessoas (id, razaoSocial, cpfCnpj) VALUES (5, 'Cliente SA', '11111111000191')").run();
db.prepare("INSERT INTO pessoas (id, razaoSocial, cpfCnpj) VALUES (6, 'Cliente B', '22222222000192')").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, categoria) VALUES (3, 'SKU-A', 'Produto A', 'Eletrônicos')").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, categoria) VALUES (4, 'SKU-B', 'Produto B', 'Móveis')").run();
db.prepare("INSERT INTO fornecedores (id, cpfCnpj, tipo, razaoSocial) VALUES (9, '529.982.247-25', 'PF', 'Ana')").run();
const CONTA = db.prepare("INSERT INTO contas_financeiras (nome, tipo, ativo) VALUES ('Banco', 'corrente', 1)").run().lastInsertRowid;

let seq = 0;
const novoPedido = (o = {}) => db.prepare(`INSERT INTO pedidos
  (numero, tipo, clienteId, status, dataPedido, valorTotal, statusPagamento, vendedorId)
  VALUES (@numero, 'venda', @clienteId, @status, @dataPedido, @valorTotal, @statusPagamento, @vendedorId)`)
  .run({ numero: 'P' + (++seq), clienteId: 5, status: 'confirmado', dataPedido: '2026-07-10',
         valorTotal: 1000, statusPagamento: 'pendente', vendedorId: 7, ...o }).lastInsertRowid;
const novoItem = (pedidoId, o = {}) => db.prepare(`INSERT INTO pedido_itens
  (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
  VALUES (?, @produtoId, @descricao, @quantidade, @precoUnitario, @valorTotal)`)
  .run(pedidoId, { produtoId: 3, descricao: 'Produto A', quantidade: 10, precoUnitario: 100, valorTotal: 1000, ...o })
  .lastInsertRowid;
const novaRegra = (o = {}) => db.prepare(`INSERT INTO comissoes_regras
  (nome, vendedorId, produtoId, categoriaProduto, clienteId, tipo, valor, dataInicio, dataFim, ativo,
   metaMinimaPercentual, valorAcelerado)
  VALUES (@nome, @vendedorId, @produtoId, @categoriaProduto, @clienteId, @tipo, @valor, @dataInicio, @dataFim, @ativo,
          @metaMinimaPercentual, @valorAcelerado)`)
  .run({ nome: 'Regra', vendedorId: null, produtoId: null, categoriaProduto: null, clienteId: null,
         tipo: 'percentual_venda', valor: 5, dataInicio: null, dataFim: null, ativo: 1,
         metaMinimaPercentual: null, valorAcelerado: null, ...o }).lastInsertRowid;

function limpar() {
  db.exec(`DELETE FROM comissoes_apuracao; DELETE FROM comissoes_regras; DELETE FROM pedido_itens;
           DELETE FROM pedidos; DELETE FROM contas_a_pagar; DELETE FROM movimentacoes_financeiras;
           DELETE FROM metas_vendas; DELETE FROM movimentacoes_estoque;`);
  db.prepare('UPDATE users SET comissaoPercentual = NULL').run();
}

// ---------- app ----------
const app = express();
app.use(express.json());
require('../comissoes-routes').registrarRotasComissoes(app, db);

function call(m, p, body = {}, params = {}, query = {}) {
  let h = null;
  for (const c of app.router.stack) {
    if (c.route && c.route.path === p && c.route.methods[m]) h = c.route.stack[c.route.stack.length - 1].handle;
  }
  if (!h) throw new Error('rota não encontrada: ' + m + ' ' + p);
  let o = null;
  h({ body, params, query, user: { username: 't' }, session: { username: 't' } },
    { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { o = { status: this.statusCode, body: j }; } },
    () => {});
  if (!o) throw new Error('handler não respondeu');
  return o;
}
const apurar = (body = {}) => call('post', '/api/comissoes/apurar', { periodo: '2026-07', ...body });
const linhas = () => db.prepare('SELECT * FROM comissoes_apuracao ORDER BY id').all();

// ==================== ELEGIBILIDADE ====================
console.log('\n--- que venda gera comissão ---');

t('pedido faturado entra — antes a venda concluída perdia a comissão', () => {
  limpar(); novaRegra({ vendedorId: 7 });
  novoItem(novoPedido({ status: 'faturado' }));
  const r = apurar();
  assert(r.body.geradas === 1, JSON.stringify(r.body));
});

t('pedido confirmado entra', () => {
  limpar(); novaRegra({ vendedorId: 7 });
  novoItem(novoPedido({ status: 'confirmado' }));
  assert(apurar().body.geradas === 1, 'não gerou');
});

t('pedido cancelado NÃO entra, mesmo pago', () => {
  limpar(); novaRegra({ vendedorId: 7 });
  novoItem(novoPedido({ status: 'cancelado', statusPagamento: 'pago' }));
  const r = apurar();
  assert(r.body.geradas === 0 && r.body.pedidos === 0, JSON.stringify(r.body));
});

t('rascunho não entra', () => {
  limpar(); novaRegra({ vendedorId: 7 });
  novoItem(novoPedido({ status: 'rascunho' }));
  assert(apurar().body.geradas === 0, 'rascunho gerou comissão');
});

t('pedido sem vendedor não entra', () => {
  limpar(); novaRegra({});
  novoItem(novoPedido({ vendedorId: null }));
  assert(apurar().body.geradas === 0, 'gerou sem vendedor');
});

t("base 'faturado' exige nota emitida", () => {
  limpar(); novaRegra({ vendedorId: 7 });
  novoItem(novoPedido({ status: 'confirmado' }));
  novoItem(novoPedido({ status: 'faturado' }));
  assert(apurar({ base: 'faturado' }).body.geradas === 1, 'base faturado errada');
});

t("base 'recebido' exige pagamento e diz o que ficou esperando", () => {
  limpar(); novaRegra({ vendedorId: 7 });
  novoItem(novoPedido({ status: 'faturado', statusPagamento: 'pendente' }));
  novoItem(novoPedido({ status: 'faturado', statusPagamento: 'pago' }));
  const r = apurar({ base: 'recebido' });
  assert(r.body.geradas === 1, 'geradas: ' + r.body.geradas);
  const d = call('get', '/api/comissoes/diagnostico', {}, {}, { periodo: '2026-07', base: 'recebido' });
  assert(d.body.diagnostico.pedidosForaDaBase.length === 1, JSON.stringify(d.body.diagnostico.pedidosForaDaBase));
});

t('base inválida é recusada em vez de virar a padrão', () => {
  const r = apurar({ base: 'inventada' });
  assert(r.status === 400, 'status: ' + r.status);
});

// ==================== ESCOLHA DA REGRA ====================
console.log('\n--- qual regra vale ---');

t('regra de vendedor+produto vence a de vendedor sozinho', () => {
  limpar();
  const geral = novaRegra({ nome: 'Geral', vendedorId: 7, valor: 5 });
  const especifica = novaRegra({ nome: 'Produto A', vendedorId: 7, produtoId: 3, valor: 12 });
  novoItem(novoPedido());
  apurar();
  assert(linhas()[0].regraId === especifica, 'usou a regra ' + linhas()[0].regraId + ', esperava ' + especifica);
  assert(perto(linhas()[0].valorComissao, 120), 'valor: ' + linhas()[0].valorComissao);
  assert(geral > 0);
});

t('vendedor+produto vence vendedor+categoria', () => {
  limpar();
  novaRegra({ nome: 'Categoria', vendedorId: 7, categoriaProduto: 'Eletrônicos', valor: 8 });
  const prod = novaRegra({ nome: 'Produto', vendedorId: 7, produtoId: 3, valor: 3 });
  novoItem(novoPedido());
  apurar();
  assert(linhas()[0].regraId === prod, 'escopo mais estreito deveria vencer');
});

t('regra de outro vendedor não se aplica', () => {
  limpar(); novaRegra({ vendedorId: 8, valor: 20 });
  novoItem(novoPedido({ vendedorId: 7 }));
  const r = apurar();
  assert(r.body.geradas === 0 && r.body.itensSemRegra.length === 1, JSON.stringify(r.body.itensSemRegra));
});

t('regra fora da vigência não se aplica', () => {
  limpar(); novaRegra({ vendedorId: 7, dataInicio: '2026-08-01' });
  novoItem(novoPedido({ dataPedido: '2026-07-10' }));
  assert(apurar().body.geradas === 0, 'aplicou regra que ainda não começou');
});

t('empate de especificidade é resolvido de forma estável e reportado', () => {
  limpar();
  const a = novaRegra({ nome: 'A', vendedorId: 7, categoriaProduto: 'Eletrônicos', valor: 5 });
  const b = novaRegra({ nome: 'B', vendedorId: 7, categoriaProduto: 'Eletrônicos', valor: 9 });
  novoItem(novoPedido());
  const r1 = apurar();
  const escolhida1 = linhas()[0].regraId;
  const r2 = apurar();
  const escolhida2 = linhas()[0].regraId;
  // Antes o desempate vinha da ordem que o SQLite devolvia.
  assert(escolhida1 === escolhida2, 'apurações seguidas escolheram regras diferentes');
  assert(escolhida1 === Math.min(a, b), 'esperava a mais antiga');
  assert(r1.body.itensAmbiguos.length === 1 && r2.body.itensAmbiguos.length === 1, 'não reportou ambiguidade');
});

t('item sem regra é listado, não só contado', () => {
  limpar();
  const p = novoPedido();
  novoItem(p, { descricao: 'Item órfão', valorTotal: 750 });
  const r = apurar();
  assert(r.body.ignoradasSemRegra === 1, 'contagem: ' + r.body.ignoradasSemRegra);
  assert(r.body.itensSemRegra[0].descricao === 'Item órfão', JSON.stringify(r.body.itensSemRegra));
  assert(perto(r.body.valorSemRegra, 750), 'valor: ' + r.body.valorSemRegra);
});

t('percentual do cadastro do vendedor vale quando não há regra escrita', () => {
  limpar();
  db.prepare('UPDATE users SET comissaoPercentual = 4 WHERE id = 7').run();
  novoItem(novoPedido());
  const r = apurar();
  assert(r.body.geradas === 1 && r.body.geradasPorCadastro === 1, JSON.stringify(r.body));
  assert(perto(linhas()[0].valorComissao, 40), 'valor: ' + linhas()[0].valorComissao);
  assert(linhas()[0].regraId === null, 'regraId deveria ser nulo');
});

t('regra escrita ganha do percentual do cadastro', () => {
  limpar();
  db.prepare('UPDATE users SET comissaoPercentual = 4 WHERE id = 7').run();
  novaRegra({ vendedorId: 7, valor: 10 });
  novoItem(novoPedido());
  const r = apurar();
  assert(r.body.geradasPorCadastro === 0, 'usou o cadastro tendo regra');
  assert(perto(linhas()[0].valorComissao, 100), 'valor: ' + linhas()[0].valorComissao);
});

// ==================== CÁLCULO ====================
console.log('\n--- como o valor é calculado ---');

t('percentual sobre venda', () => {
  const r = calc.calcularComissao({ tipo: 'percentual_venda', valor: 5 }, { quantidade: 10, valorTotal: 1000 }, {});
  assert(perto(r.valor, 50), JSON.stringify(r));
});

t('fixo por unidade multiplica pela quantidade', () => {
  const r = calc.calcularComissao({ tipo: 'fixo_por_unidade', valor: 3 }, { quantidade: 10, valorTotal: 1000 }, {});
  assert(perto(r.valor, 30) && perto(r.base, 10), JSON.stringify(r));
});

t('percentual sobre lucro usa o custo informado', () => {
  const r = calc.calcularComissao({ tipo: 'percentual_lucro', valor: 20 },
    { quantidade: 10, valorTotal: 1000 }, { custoUnitario: 60, custoEncontrado: true });
  assert(perto(r.base, 400) && perto(r.valor, 80), JSON.stringify(r));
});

t('sem custo conhecido NÃO comissiona a venda inteira como lucro', () => {
  const r = calc.calcularComissao({ tipo: 'percentual_lucro', valor: 20 },
    { quantidade: 10, valorTotal: 1000 }, { custoEncontrado: false });
  // Era aqui que o lucro virava faturamento e a comissão inflava calada.
  assert(r.valor === 0, 'valor: ' + r.valor);
  assert(/sem custo/i.test(r.motivo || ''), 'motivo: ' + r.motivo);
});

t('venda sem lucro não gera comissão, e diz por quê', () => {
  const r = calc.calcularComissao({ tipo: 'percentual_lucro', valor: 20 },
    { quantidade: 10, valorTotal: 1000 }, { custoUnitario: 120, custoEncontrado: true });
  assert(r.valor === 0 && /sem lucro/i.test(r.motivo || ''), JSON.stringify(r));
});

t('custo é o da data da venda, não o de hoje', () => {
  limpar();
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, data, custoMedioPosterior)
    VALUES (3, 'entrada', 100, '2026-07-01', 60)`).run();
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, data, custoMedioPosterior)
    VALUES (3, 'entrada', 100, '2026-09-01', 95)`).run();
  const c = calc.custoNaData(db, 3, '2026-07-10');
  assert(perto(c.custo, 60), 'pegou o custo de setembro: ' + c.custo);
});

t('reapurar um mês fechado dá o mesmo número', () => {
  limpar();
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, data, custoMedioPosterior)
    VALUES (3, 'entrada', 100, '2026-07-01', 60)`).run();
  novaRegra({ vendedorId: 7, tipo: 'percentual_lucro', valor: 20 });
  novoItem(novoPedido());
  apurar();
  const antes = linhas()[0].valorComissao;
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, data, custoMedioPosterior)
    VALUES (3, 'entrada', 50, '2026-09-01', 95)`).run();
  apurar();
  assert(perto(linhas()[0].valorComissao, antes), `mudou de ${antes} para ${linhas()[0].valorComissao}`);
});

// ==================== META ====================
console.log('\n--- gatilho e acelerador de meta ---');

const comMeta = (valorMeta) => db.prepare(
  'INSERT OR REPLACE INTO metas_vendas (vendedorUserId, competencia, valorMeta) VALUES (7, ?, ?)').run('2026-07', valorMeta);

t('abaixo do gatilho não comissiona, e explica', () => {
  limpar(); comMeta(10000);
  novaRegra({ vendedorId: 7, valor: 5, metaMinimaPercentual: 80 });
  novoItem(novoPedido({ valorTotal: 1000 }));   // 10% da meta
  const r = apurar();
  assert(r.body.geradas === 0, 'comissionou abaixo do gatilho');
  assert(/gatilho/i.test(r.body.itensSemValor[0].motivo), JSON.stringify(r.body.itensSemValor));
});

t('acima do gatilho comissiona normalmente', () => {
  limpar(); comMeta(1000);
  novaRegra({ vendedorId: 7, valor: 5, metaMinimaPercentual: 80 });
  novoItem(novoPedido({ valorTotal: 1000 }));
  assert(apurar().body.geradas === 1, 'não comissionou com meta batida');
});

t('gatilho sem meta cadastrada não comissiona e avisa o motivo certo', () => {
  limpar();
  novaRegra({ vendedorId: 7, valor: 5, metaMinimaPercentual: 80 });
  novoItem(novoPedido());
  const r = apurar();
  assert(/não há meta cadastrada/i.test(r.body.itensSemValor[0].motivo), JSON.stringify(r.body.itensSemValor));
});

t('acelerador entra quando a meta é batida', () => {
  limpar(); comMeta(1000);
  novaRegra({ vendedorId: 7, valor: 5, valorAcelerado: 8 });
  novoItem(novoPedido({ valorTotal: 1000 }));
  apurar();
  assert(perto(linhas()[0].valorComissao, 80), 'valor: ' + linhas()[0].valorComissao);
});

t('sem bater a meta, vale o percentual normal', () => {
  limpar(); comMeta(100000);
  novaRegra({ vendedorId: 7, valor: 5, valorAcelerado: 8 });
  novoItem(novoPedido({ valorTotal: 1000 }));
  apurar();
  assert(perto(linhas()[0].valorComissao, 50), 'valor: ' + linhas()[0].valorComissao);
});

t('sem meta cadastrada o acelerador não dispara sozinho', () => {
  limpar();
  novaRegra({ vendedorId: 7, valor: 5, valorAcelerado: 8 });
  novoItem(novoPedido({ valorTotal: 1000 }));
  apurar();
  // Meta ausente não pode contar como "meta batida".
  assert(perto(linhas()[0].valorComissao, 50), 'valor: ' + linhas()[0].valorComissao);
});

t('a apuração devolve a situação da meta de cada vendedor', () => {
  limpar(); comMeta(2000);
  novaRegra({ vendedorId: 7, valor: 5 });
  novoItem(novoPedido({ valorTotal: 1000 }));
  const m = apurar().body.metas;
  assert(m.length === 1 && perto(m[0].percentual, 50) && m[0].atingida === false, JSON.stringify(m));
});

// ==================== SIMULAÇÃO ====================
console.log('\n--- simular antes de gravar ---');

t('simulação não grava nada e devolve a prévia', () => {
  limpar(); novaRegra({ vendedorId: 7, valor: 5 });
  novoItem(novoPedido());
  const r = apurar({ simular: true });
  assert(r.body.simulacao === true && r.body.geradas === 1, JSON.stringify(r.body));
  assert(r.body.previa.length === 1 && perto(r.body.previa[0].valor, 50), JSON.stringify(r.body.previa));
  assert(linhas().length === 0, 'gravou mesmo simulando');
});

t('simulação não apaga o que já estava apurado', () => {
  limpar(); novaRegra({ vendedorId: 7, valor: 5 });
  novoItem(novoPedido());
  apurar();
  assert(linhas().length === 1, 'não apurou');
  apurar({ simular: true });
  assert(linhas().length === 1, 'a simulação apagou a apuração real');
});

// ==================== PAGAMENTO ====================
console.log('\n--- pagamento ---');

function apurarEPagar(extra = {}) {
  limpar(); novaRegra({ vendedorId: 7, valor: 5 });
  novoItem(novoPedido());
  apurar();
  const ids = linhas().map((l) => l.id);
  return { ids, r: call('post', '/api/comissoes/apuracao/pagar', { ids, contaFinanceiraId: CONTA, ...extra }) };
}

t('pagar marca as apurações, cria conta a pagar e movimenta o caixa', () => {
  const { r } = apurarEPagar();
  // Era aqui que a rota devolvia sucesso sem fazer absolutamente nada.
  assert(r.body.success, JSON.stringify(r.body));
  assert(r.body.marcadas === 1, 'marcadas: ' + r.body.marcadas);
  assert(perto(r.body.total, 50), 'total: ' + r.body.total);
  assert(db.prepare("SELECT COUNT(*) n FROM comissoes_apuracao WHERE status='paga'").get().n === 1, 'não marcou paga');
  assert(db.prepare('SELECT COUNT(*) n FROM contas_a_pagar').get().n === 1, 'não criou conta a pagar');
  assert(db.prepare('SELECT COUNT(*) n FROM movimentacoes_financeiras').get().n === 1, 'não movimentou o caixa');
});

t('o valor da conta a pagar bate com a comissão', () => {
  apurarEPagar();
  const cp = db.prepare('SELECT * FROM contas_a_pagar ORDER BY id DESC LIMIT 1').get();
  assert(perto(cp.valor, 50) && perto(cp.valorPago, 50) && cp.status === 'paga', JSON.stringify(cp));
});

t('o fornecedor sai do CPF do vendedor sem precisar informar', () => {
  apurarEPagar();
  const cp = db.prepare('SELECT * FROM contas_a_pagar ORDER BY id DESC LIMIT 1').get();
  assert(cp.fornecedorId === 9, 'fornecedorId: ' + cp.fornecedorId);
});

t('vendedor sem fornecedor recebe erro de cadastro, não erro cru de banco', () => {
  limpar(); novaRegra({ vendedorId: 8, valor: 5 });
  novoItem(novoPedido({ vendedorId: 8 }));
  apurar();
  const r = call('post', '/api/comissoes/apuracao/pagar',
    { ids: linhas().map((l) => l.id), contaFinanceiraId: CONTA });
  assert(r.status === 400, 'status: ' + r.status);
  assert(/fornecedor vinculado/.test(r.body.error), 'erro: ' + r.body.error);
  assert(db.prepare('SELECT COUNT(*) n FROM contas_a_pagar').get().n === 0, 'criou CP mesmo falhando');
});

t('pagar sem conta financeira é recusado', () => {
  const r = call('post', '/api/comissoes/apuracao/pagar', { ids: [1] });
  assert(r.status === 400 && /contaFinanceiraId/.test(r.body.error), JSON.stringify(r.body));
});

t('apuração já paga não é paga de novo', () => {
  const { ids } = apurarEPagar();
  const r2 = call('post', '/api/comissoes/apuracao/pagar', { ids, contaFinanceiraId: CONTA });
  assert(r2.status === 400, 'status: ' + r2.status);
  assert(db.prepare('SELECT COUNT(*) n FROM contas_a_pagar').get().n === 1, 'pagou duas vezes');
});

t('reapurar não apaga linha já paga', () => {
  apurarEPagar();
  apurar();
  assert(db.prepare("SELECT COUNT(*) n FROM comissoes_apuracao WHERE status='paga'").get().n === 1, 'apagou o pago');
});

// ==================== ESTORNO ====================
console.log('\n--- estorno ---');

t('estornar cancela a conta a pagar e devolve o dinheiro à conta', () => {
  apurarEPagar();
  const paga = db.prepare("SELECT * FROM comissoes_apuracao WHERE status='paga'").get();
  const r = call('post', '/api/comissoes/apuracao/:id/estornar', {}, { id: paga.id });
  assert(r.body.success, JSON.stringify(r.body));

  const cp = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(paga.contaPagarId);
  assert(cp.status === 'cancelada' && perto(cp.valorPago, 0), JSON.stringify(cp));

  // Contra-lançamento, não DELETE: extrato conciliado não se reescreve.
  const movs = db.prepare('SELECT * FROM movimentacoes_financeiras ORDER BY id').all();
  assert(movs.length === 2, 'movimentações: ' + movs.length);
  assert(movs[1].tipo === 'entrada' && perto(movs[1].valor, movs[0].valor), JSON.stringify(movs[1]));
});

t('depois do estorno a apuração volta a pendente e sem rastro de pagamento', () => {
  apurarEPagar();
  const paga = db.prepare("SELECT * FROM comissoes_apuracao WHERE status='paga'").get();
  call('post', '/api/comissoes/apuracao/:id/estornar', {}, { id: paga.id });
  const a = db.prepare('SELECT * FROM comissoes_apuracao WHERE id = ?').get(paga.id);
  assert(a.status === 'pendente' && !a.dataPagamento && !a.contaPagarId && !a.movimentacaoId, JSON.stringify(a));
});

t('estornar uma linha do lote desfaz o lote inteiro', () => {
  limpar(); novaRegra({ vendedorId: 7, valor: 5 });
  const p = novoPedido(); novoItem(p); novoItem(p, { produtoId: 4, descricao: 'Produto B' });
  apurar();
  const ids = linhas().map((l) => l.id);
  call('post', '/api/comissoes/apuracao/pagar', { ids, contaFinanceiraId: CONTA });
  assert(db.prepare("SELECT COUNT(*) n FROM comissoes_apuracao WHERE status='paga'").get().n === 2, 'não pagou as duas');
  // A conta a pagar é uma só, pelo total do vendedor: estornar meia dúzia
  // deixaria o documento sem corresponder a nada.
  call('post', '/api/comissoes/apuracao/:id/estornar', {}, { id: ids[0] });
  assert(db.prepare("SELECT COUNT(*) n FROM comissoes_apuracao WHERE status='pendente'").get().n === 2, 'estornou só uma');
});

t('estornar o que não foi pago é recusado', () => {
  limpar(); novaRegra({ vendedorId: 7, valor: 5 });
  novoItem(novoPedido());
  apurar();
  const r = call('post', '/api/comissoes/apuracao/:id/estornar', {}, { id: linhas()[0].id });
  assert(r.status === 400, 'status: ' + r.status);
});

t('depois de estornar dá para pagar de novo, uma única vez', () => {
  const { ids } = apurarEPagar();
  const paga = db.prepare("SELECT * FROM comissoes_apuracao WHERE status='paga'").get();
  call('post', '/api/comissoes/apuracao/:id/estornar', {}, { id: paga.id });
  const r = call('post', '/api/comissoes/apuracao/pagar', { ids, contaFinanceiraId: CONTA });
  assert(r.body.marcadas === 1, JSON.stringify(r.body));
  // Duas CPs no total (uma cancelada, uma ativa) e três movimentações.
  assert(db.prepare("SELECT COUNT(*) n FROM contas_a_pagar WHERE status='paga'").get().n === 1, 'sobrou CP paga duplicada');
});

// ==================== VALIDAÇÃO DE REGRA ====================
console.log('\n--- regras que não deveriam ser gravadas ---');

t('percentual acima de 100 é recusado (15 digitado como 1500)', () => {
  const p = calc.validarRegra(db, { nome: 'X', tipo: 'percentual_venda', valor: 1500 }, { checarSombra: false });
  assert(tem(p, 'percentual_acima_de_100'), codigos(p));
});

t('valor zero ou negativo é recusado', () => {
  assert(tem(calc.validarRegra(db, { nome: 'X', tipo: 'percentual_venda', valor: 0 }, { checarSombra: false }), 'valor_invalido'));
  assert(tem(calc.validarRegra(db, { nome: 'X', tipo: 'percentual_venda', valor: -5 }, { checarSombra: false }), 'valor_invalido'));
});

t('fixo por unidade pode passar de 100 (é reais, não porcentagem)', () => {
  const p = calc.validarRegra(db, { nome: 'X', tipo: 'fixo_por_unidade', valor: 250 }, { checarSombra: false });
  assert(!tem(p, 'percentual_acima_de_100'), codigos(p));
});

t('percentual alto passa com aviso, não com bloqueio', () => {
  const p = calc.validarRegra(db, { nome: 'X', tipo: 'percentual_venda', valor: 70 }, { checarSombra: false });
  const a = p.find((x) => x.codigo === 'percentual_alto');
  assert(a && a.nivel === 'aviso', codigos(p));
});

t('vigência invertida é recusada', () => {
  const p = calc.validarRegra(db, { nome: 'X', tipo: 'percentual_venda', valor: 5,
    dataInicio: '2026-08-01', dataFim: '2026-07-01' }, { checarSombra: false });
  assert(tem(p, 'vigencia_invertida'), codigos(p));
});

t('acelerador menor que o percentual normal é avisado', () => {
  const p = calc.validarRegra(db, { nome: 'X', tipo: 'percentual_venda', valor: 10, valorAcelerado: 6 }, { checarSombra: false });
  assert(tem(p, 'acelerador_menor'), codigos(p));
});

t('regra com mesmo escopo e vigência é apontada como sombreada', () => {
  limpar();
  novaRegra({ nome: 'Primeira', vendedorId: 7, valor: 5 });
  const p = calc.validarRegra(db, { nome: 'Segunda', vendedorId: 7, tipo: 'percentual_venda', valor: 9 });
  assert(tem(p, 'regra_sombreada'), codigos(p));
});

t('escopo diferente não é sombreamento', () => {
  limpar();
  novaRegra({ nome: 'Primeira', vendedorId: 7, valor: 5 });
  const p = calc.validarRegra(db, { nome: 'Outra', vendedorId: 8, tipo: 'percentual_venda', valor: 9 });
  assert(!tem(p, 'regra_sombreada'), codigos(p));
});

t('vigências que não se cruzam não são sombreamento', () => {
  limpar();
  novaRegra({ nome: 'Primeiro semestre', vendedorId: 7, valor: 5, dataInicio: '2026-01-01', dataFim: '2026-06-30' });
  const p = calc.validarRegra(db, { nome: 'Segundo semestre', vendedorId: 7, tipo: 'percentual_venda',
    valor: 9, dataInicio: '2026-07-01', dataFim: '2026-12-31' });
  assert(!tem(p, 'regra_sombreada'), codigos(p));
});

t('a rota recusa a regra inválida e devolve os avisos da válida', () => {
  limpar();
  const ruim = call('post', '/api/comissoes/regras', { nome: 'X', tipo: 'percentual_venda', valor: 300 });
  assert(ruim.status === 400, 'status: ' + ruim.status);
  const boa = call('post', '/api/comissoes/regras', { nome: 'Y', tipo: 'percentual_venda', valor: 70 });
  assert(boa.body.success && boa.body.avisos.length > 0, JSON.stringify(boa.body));
});

// ==================== DIAGNÓSTICO ====================
console.log('\n--- diagnóstico ---');

t('aponta regra ativa que não casou com nada', () => {
  limpar();
  novaRegra({ nome: 'Usada', vendedorId: 7, valor: 5 });
  novaRegra({ nome: 'Morta', vendedorId: 8, valor: 5 });
  novoItem(novoPedido({ vendedorId: 7 }));
  const d = call('get', '/api/comissoes/diagnostico', {}, {}, { periodo: '2026-07' }).body.diagnostico;
  assert(d.regrasSemUso.length === 1 && d.regrasSemUso[0].nome === 'Morta', JSON.stringify(d.regrasSemUso));
});

t('soma quanto de venda ficou sem regra', () => {
  limpar();
  novoItem(novoPedido(), { valorTotal: 1000 });
  novoItem(novoPedido(), { valorTotal: 500 });
  const d = call('get', '/api/comissoes/diagnostico', {}, {}, { periodo: '2026-07' }).body.diagnostico;
  assert(d.itensSemRegra.length === 2 && perto(d.valorSemRegra, 1500), JSON.stringify(d));
});

t('período mal formado é recusado', () => {
  const r = call('get', '/api/comissoes/diagnostico', {}, {}, { periodo: '2026' });
  assert(r.status === 400, 'status: ' + r.status);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
