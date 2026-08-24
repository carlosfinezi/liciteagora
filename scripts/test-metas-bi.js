/**
 * Teste das metas com projeção, estágios, margem e perdas.
 * Chama os handlers reais com req/res falsos, contra SQLite temporário
 * com o schema de produção.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasPlanejamento } = require('../planejamento-routes');

const DB = '/tmp/vp-metas.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(fs.readFileSync('/tmp/vp-metas-schema.sql', 'utf8'));
db.exec(`CREATE TABLE IF NOT EXISTS participacoes_comprasnet (id INTEGER PRIMARY KEY AUTOINCREMENT);`);

const app = express();
registrarRotasPlanejamento(app, db);
const achar = (path) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === path && x.route.methods.get);
  if (!l) throw new Error('rota nao registrada: ' + path);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const hAting = achar('/api/metas/atingimento');
const hHist = achar('/api/metas/historico');

function chamar(handler, query) {
  let out = null;
  const res = { json: o => { out = o; return res; }, status: () => res };
  handler({ query, session: {} }, res);
  if (!out) throw new Error('sem resposta');
  if (!out.success) throw new Error('endpoint: ' + out.error);
  return out;
}

let ok = 0, fail = 0;
function t(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }
const linha = (d, nome) => d.linhas.find(l => l.vendedor === nome);

// ---------- seed ----------
db.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo) VALUES (1,'ana','x','Ana','admin',1)").run();
db.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo) VALUES (2,'bruno','x','Bruno','admin',1)").run();
db.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo) VALUES (3,'carla','x','Carla','admin',1)").run();
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (1,'00000000000191','Cliente 1','cliente',1)").run();
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (2,'00000000000272','Cliente 2','cliente',1)").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, ativo, precoCusto) VALUES (1,'P1','Produto 1',1,60)").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, ativo, precoCusto) VALUES (2,'P2','Produto 2',1,0)").run();

const COMP = '2026-05';   // competência fechada — projeção = realizado
let seqPed = 0;
function pedido(vendedorId, status, valor, { modo = 'pedido', clienteId = 1, comp = COMP, produtoId = 1, qtd = 1 } = {}) {
  const num = 'PED-' + (++seqPed);
  const id = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal, vendedorId)
    VALUES (?, 'manual', ?, ?, ?, ?, ?, ?)`)
    .run(num, modo, clienteId, status, comp + '-10', valor, vendedorId).lastInsertRowid;
  db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
    VALUES (?, ?, 'item', ?, ?, ?)`).run(id, produtoId, qtd, valor / qtd, valor);
  return id;
}

// Ana: 10.000 realizado (faturado+entregue), 3.000 carteira, 5.000 funil
const PED_ANA_1 = pedido(1, 'faturado', 6000);
pedido(1, 'entregue', 4000, { clienteId: 2 });
pedido(1, 'confirmado', 3000);
pedido(1, 'orcamento_ignorado' === '' ? 'rascunho' : 'rascunho', 5000, { modo: 'orcamento' });
// Ana: rascunho e cancelado não podem entrar em lugar nenhum
pedido(1, 'rascunho', 99999);
pedido(1, 'cancelado', 88888);
// Bruno: 3.000 realizado, sem meta. O segundo pedido usa o produto 2
// (sem precoCusto e sem movimentação) — custo desconhecido de propósito,
// para exercitar a cobertura parcial da margem.
pedido(2, 'faturado', 2000);
pedido(2, 'faturado', 1000, { produtoId: 2 });
// Carla: só orçamento
pedido(3, 'rascunho', 1500, { modo: 'orcamento' });
// Sem vendedor
db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal, vendedorId)
  VALUES ('PED-SV','manual','pedido',1,'faturado',?,7000,NULL)`).run(COMP + '-11');

db.prepare('INSERT INTO metas_vendas (vendedorUserId, competencia, valorMeta, valorMetaMargem) VALUES (1,?,20000,5000)').run(COMP);

// Custo real da venda: saída de estoque vinculada ao pedido da Ana.
db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, origem, origemId, data, custoMedioPosterior, estornada)
  VALUES (1,'saida',1,'pedido',?,?,4000,0)`).run(PED_ANA_1, COMP + '-10');

// ---------- testes ----------
t('realizado = entregue + faturado (não soma confirmado nem orçamento)', () => {
  const a = linha(chamar(hAting, { competencia: COMP }), 'Ana');
  assert(a.realizado === 10000, 'realizado: ' + a.realizado);
  assert(a.carteira === 3000, 'carteira: ' + a.carteira);
  assert(a.funil === 5000, 'funil: ' + a.funil);
});

t('rascunho e cancelado ficam fora de todos os estágios', () => {
  const a = linha(chamar(hAting, { competencia: COMP }), 'Ana');
  assert(a.realizado + a.carteira === 13000, 'vazou rascunho/cancelado: ' + (a.realizado + a.carteira));
});

t('atingimento e ranking', () => {
  const d = chamar(hAting, { competencia: COMP });
  const a = linha(d, 'Ana');
  assert(a.atingimento === 50, 'atingimento: ' + a.atingimento);
  assert(a.posicao === 1, 'Ana deveria liderar, veio ' + a.posicao);
  assert(linha(d, 'Bruno').posicao === 2, 'Bruno deveria ser 2º');
});

t('vendedor sem meta é sinalizado, não zerado', () => {
  const d = chamar(hAting, { competencia: COMP });
  const b = linha(d, 'Bruno');
  assert(b.semMeta === true, 'Bruno deveria estar sem meta');
  assert(b.atingimento === null, 'atingimento sem meta deve ser null, veio ' + b.atingimento);
  assert(b.realizado === 3000, 'realizado do Bruno: ' + b.realizado);
  assert(d.equipe.vendedoresSemMeta >= 1, 'contador de sem meta');
});

t('quem só tem orçamento aparece (não some do painel)', () => {
  const c = linha(chamar(hAting, { competencia: COMP }), 'Carla');
  assert(c, 'Carla sumiu');
  assert(c.funil === 1500 && c.realizado === 0, 'funil da Carla: ' + c.funil);
});

t('ticket médio e clientes distintos', () => {
  const a = linha(chamar(hAting, { competencia: COMP }), 'Ana');
  assert(a.pedidos === 2, 'pedidos: ' + a.pedidos);
  assert(a.ticketMedio === 5000, 'ticket: ' + a.ticketMedio);
  assert(a.clientes === 2, 'clientes distintos: ' + a.clientes);
});

t('pedidos sem vendedor são reportados à parte', () => {
  const d = chamar(hAting, { competencia: COMP });
  assert(d.semVendedor.pedidos === 1, 'pedidos sem vendedor: ' + d.semVendedor.pedidos);
  assert(d.semVendedor.valor === 7000, 'valor: ' + d.semVendedor.valor);
  assert(d.equipe.realizado === 13000, 'equipe não deve incluir sem-vendedor: ' + d.equipe.realizado);
});

t('competência fechada não projeta (projeção = realizado)', () => {
  const d = chamar(hAting, { competencia: COMP });
  assert(d.tempo.fechada === true, 'deveria estar fechada');
  assert(linha(d, 'Ana').projecao === 10000, 'projeção: ' + linha(d, 'Ana').projecao);
  assert(linha(d, 'Ana').tendencia === 'nao_batida', 'tendência: ' + linha(d, 'Ana').tendencia);
});

t('dias úteis descontam feriado nacional', () => {
  // Maio/2026: 21 dias seg-sex, menos 1º de maio (sexta) = 20.
  const d = chamar(hAting, { competencia: '2026-05' });
  assert(d.tempo.uteisTotal === 20, 'dias úteis de 2026-05: ' + d.tempo.uteisTotal);
  assert(d.tempo.feriadosNoMes.includes('2026-05-01'), 'feriado não listado: ' + JSON.stringify(d.tempo.feriadosNoMes));
});

t('feriado móvel (Corpus Christi) também conta', () => {
  // Junho/2026: 22 dias seg-sex, menos Corpus Christi em 04/06 (quinta).
  const d = chamar(hAting, { competencia: '2026-06' });
  assert(d.tempo.feriadosNoMes.includes('2026-06-04'), 'Corpus Christi ausente: ' + JSON.stringify(d.tempo.feriadosNoMes));
  assert(d.tempo.uteisTotal === 21, 'dias úteis de 2026-06: ' + d.tempo.uteisTotal);
});

t('feriado da empresa entra no cálculo', () => {
  const antes = chamar(hAting, { competencia: '2026-07' }).tempo.uteisTotal;
  db.prepare("INSERT INTO feriados (data, descricao, ativo) VALUES ('2026-07-09','Revolução Constitucionalista',1)").run();
  const depois = chamar(hAting, { competencia: '2026-07' }).tempo.uteisTotal;
  assert(depois === antes - 1, `esperava ${antes - 1}, veio ${depois}`);
  db.prepare("DELETE FROM feriados WHERE data='2026-07-09'").run();
});

t('perda avulsa com vendedor entra na conversão', () => {
  // Mede o delta em vez de um total fixo: assim não depende de quais
  // perdas outros testes já criaram.
  const COMP_AV = '2026-05';
  const antes = linha(chamar(hAting, { competencia: COMP_AV }), 'Ana').perdaValor;
  db.prepare(`INSERT INTO vendas_perdidas (data, produtoId, quantidade, precoAlvo, motivo, origem, vendedorUserId)
    VALUES (?, 1, 2, 250, 'preco', 'manual', 1)`).run(COMP_AV + '-18');
  const depois = linha(chamar(hAting, { competencia: COMP_AV }), 'Ana').perdaValor;
  assert(depois === antes + 500, `avulsa deveria somar 500: ${antes} -> ${depois}`);
  db.prepare("DELETE FROM vendas_perdidas WHERE origem='manual'").run();
  const volta = linha(chamar(hAting, { competencia: COMP_AV }), 'Ana').perdaValor;
  assert(volta === antes, 'não limpou: ' + volta);
});

t('margem: custo da movimentação do próprio pedido tem prioridade', () => {
  const a = linha(chamar(hAting, { competencia: COMP }), 'Ana');
  // Pedido 6.000 → custo 4.000 (movimentação do pedido).
  // Pedido 4.000 → sem movimentação; cai no último custo médio conhecido
  // do produto (4.000), que vence precoCusto=60. Base 10.000, custo 8.000.
  assert(a.margemValor === 2000, 'margem: ' + a.margemValor);
  assert(a.margemPct === 20, 'margem %: ' + a.margemPct);
  assert(a.margemCobertura === 1, 'ambos os itens têm custo: ' + a.margemCobertura);
  assert(a.atingimentoMargem === 40, 'atingimento de margem (2000/5000): ' + a.atingimentoMargem);
});

t('item sem custo sai da base e derruba a cobertura', () => {
  const b = linha(chamar(hAting, { competencia: COMP }), 'Bruno');
  // 3.000 faturados, só 2.000 com custo conhecido.
  assert(b.margemCobertura === 0.667, 'cobertura (2000/3000): ' + b.margemCobertura);
  assert(b.margemItensSemCusto === 1, 'itens sem custo: ' + b.margemItensSemCusto);
  // A margem % vale sobre a base coberta, não sobre os 3.000.
  assert(b.margemPct != null, 'margem % deveria existir sobre a parte coberta');
});

t('meta de equipe explícita substitui a soma das individuais', () => {
  let d = chamar(hAting, { competencia: COMP });
  assert(d.equipe.metaDefinida === false, 'não deveria ter meta de equipe ainda');
  assert(d.equipe.meta === 20000, 'fallback = soma individuais: ' + d.equipe.meta);
  db.prepare('INSERT INTO metas_equipe (competencia, valorMeta) VALUES (?, 50000)').run(COMP);
  d = chamar(hAting, { competencia: COMP });
  assert(d.equipe.metaDefinida === true, 'meta de equipe não reconhecida');
  assert(d.equipe.meta === 50000, 'meta de equipe: ' + d.equipe.meta);
  assert(d.equipe.metaSomaIndividuais === 20000, 'soma individuais: ' + d.equipe.metaSomaIndividuais);
  db.prepare('DELETE FROM metas_equipe WHERE competencia = ?').run(COMP);
});

t('perdas por vendedor e conversão', () => {
  db.prepare(`INSERT INTO vendas_perdidas (data, produtoId, quantidade, precoAlvo, motivo, origem, pedidoId)
    VALUES (?, 1, 10, 500, 'concorrente', 'pedido_cancelado', 1)`).run(COMP + '-15');
  db.prepare(`INSERT INTO vendas_perdidas (data, produtoId, quantidade, precoAlvo, motivo, origem, pedidoId)
    VALUES (?, 1, 1, 1000, 'preco', 'pedido_item', 1)`).run(COMP + '-16');
  const a = linha(chamar(hAting, { competencia: COMP }), 'Ana');
  assert(a.perdaValor === 6000, 'perda total (5000+1000): ' + a.perdaValor);
  assert(a.perdaRegistros === 2, 'registros: ' + a.perdaRegistros);
  assert(a.perdaMotivoTop === 'concorrente', 'motivo dominante: ' + a.perdaMotivoTop);
  // conversão = 10000 / (10000 + 6000)
  assert(a.conversaoPct === 62.5, 'conversão: ' + a.conversaoPct);
});

t('projeção por run-rate na competência corrente', () => {
  const hoje = new Date(Date.now() - 3 * 3600 * 1000);
  const compAtual = hoje.toISOString().slice(0, 7);
  pedido(2, 'faturado', 1000, { comp: compAtual });
  const d = chamar(hAting, { competencia: compAtual });
  const b = linha(d, 'Bruno');
  if (d.tempo.emAndamento && d.tempo.uteisDecorridos > 0) {
    const esperado = Number((1000 / d.tempo.uteisDecorridos * d.tempo.uteisTotal).toFixed(2));
    assert(Math.abs(b.projecao - esperado) < 0.02, `projeção ${b.projecao} != ${esperado}`);
    assert(b.projecao >= b.realizado, 'projeção não pode ser menor que o realizado');
  } else if (d.tempo.emAndamento) {
    // Rodando num dia 1º que caiu em fim de semana não há dia útil decorrido,
    // então não existe ritmo a extrapolar: a projeção é o próprio realizado.
    // A asserção antiga dividia por zero e esperava Infinity.
    assert(b.projecao === b.realizado,
      `sem dia útil decorrido a projeção deveria ser o realizado (${b.realizado}), veio ${b.projecao}`);
  }
});

t('histórico devolve 12 meses com ano anterior e variação', () => {
  const d = chamar(hHist, { meses: 12, ate: COMP });
  assert(d.serie.length === 12, 'meses: ' + d.serie.length);
  assert(d.serie[11].competencia === COMP, 'último mês: ' + d.serie[11].competencia);
  assert(d.serie[0].competencia === '2025-06', 'primeiro mês: ' + d.serie[0].competencia);
  const atual = d.serie.find(s => s.competencia === COMP);
  assert(atual.realizado === 13000, 'realizado no histórico: ' + atual.realizado);
  assert(atual.pedidos === 4, 'pedidos: ' + atual.pedidos);
});

t('histórico filtrado por vendedor', () => {
  const d = chamar(hHist, { meses: 12, ate: COMP, vendedorUserId: 1 });
  const atual = d.serie.find(s => s.competencia === COMP);
  assert(atual.realizado === 10000, 'só Ana: ' + atual.realizado);
  assert(atual.meta === 20000, 'meta da Ana: ' + atual.meta);
});

t('histórico traz perdido e melhor mês', () => {
  const d = chamar(hHist, { meses: 12, ate: COMP });
  assert(d.resumo.totalPerdido === 6000, 'perdido: ' + d.resumo.totalPerdido);
  assert(d.resumo.melhorMes.competencia === COMP, 'melhor mês: ' + d.resumo.melhorMes.competencia);
});

t('competência inválida é recusada', () => {
  let st = null;
  const res = { json: () => res, status: c => { st = c; return res; } };
  hAting({ query: { competencia: '2026' }, session: {} }, res);
  assert(st === 400, 'status: ' + st);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
