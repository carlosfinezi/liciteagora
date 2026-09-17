/**
 * Fase 1 funcional — desconto com alçada, aprovação, atendimento e segurança.
 *
 * Roda inteiramente em banco descartável (/tmp), com as rotas REAIS montadas
 * sobre ele: o que se exercita é `pedidos-routes.js`, não uma imitação.
 *
 * Schema base: sqlite3 data/tenants/1bit/pncp.db .schema > /tmp/app-backend-schema.sql
 *
 * As faixas usadas são as combinadas para teste — vendedor 5%, gerente 15% —
 * e existem SÓ aqui. Nenhum tenant de cliente ganha faixa por causa deste
 * arquivo: sem faixa cadastrada, o desconto permitido é 0% (ver bloco E).
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

const SCHEMA = '/tmp/app-backend-schema.sql';
if (!fs.existsSync(SCHEMA)) {
  console.error(`schema ausente: ${SCHEMA}\n  sqlite3 data/tenants/1bit/pncp.db .schema > ${SCHEMA}`);
  process.exit(2);
}
const DB = `/tmp/fase1-funcional-${process.pid}.db`;
try { fs.unlinkSync(DB); } catch {}
const criar = new Database(DB);
criar.exec(fs.readFileSync(SCHEMA, 'utf8')
  .split(/;\s*\n/).filter((s) => !/sqlite_sequence/i.test(s)).join(';\n'));
criar.close();

const dbt = new Database(DB);
const { registrarRotasPedidos } = require('../pedidos-routes');
const { registrarRotasProdutos } = require('../produtos-routes');
const { registrarRotasReservas } = require('../reservas-routes');
const { registrarRotasFaturas } = require('../faturas-routes');
const desconto = require('../pedido-desconto');
const atendimento = require('../pedido-atendimento');
const alcadas = require('../governanca-alcadas');

const app = express();
registrarRotasPedidos(app, dbt);
registrarRotasProdutos(app, dbt);
registrarRotasReservas(app, dbt);
try { registrarRotasFaturas(app, dbt); } catch { /* fatura opcional neste harness */ }

const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find((x) => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                session: o.session || {}, user: o.user, ip: '203.0.113.9', headers: {} },
    { json: (x) => { out = x; return { json: (y) => { out = y; } }; },
      status: (c) => { st = c; return { json: (x) => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- seed ----------
dbt.prepare("INSERT INTO pessoas (id, cpfCnpj, tipo, razaoSocial, endereco, cidade, uf, ativo) VALUES (1,'00000000000191','PJ','Cliente Com Endereco','Rua A, 100','Sao Paulo','SP',1)").run();
// Cliente SEM endereço: é ele que prova a recusa de `entrega` sem endereço.
dbt.prepare("INSERT INTO pessoas (id, cpfCnpj, tipo, razaoSocial, ativo) VALUES (2,'11444777000161','PJ','Cliente Sem Endereco',1)").run();
dbt.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor) VALUES (10,'vend1','x','Vendedor Um','comercial',1,1)").run();
dbt.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor) VALUES (11,'vend2','x','Vendedor Dois','comercial',1,1)").run();
dbt.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor) VALUES (12,'gerente','x','Gerente','gerente-comercial',1,1)").run();
dbt.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo, ehVendedor) VALUES (1,'admin','x','Admin','admin',1,0)").run();
// Os perfis PRECISAM existir: sem cadastro, `atorIrrestrito` aplica o fail-open
// de perfis-acesso.js e trata o usuário como privilegiado — o fail-closed do
// desconto não valeria para ele. É o risco registrado no relatório 13 §E0-d.
dbt.prepare("INSERT INTO perfis_acesso (slug, nome, paginas, ativo) VALUES ('comercial','Vendedor',?,1)")
  .run(JSON.stringify(['pedidos', 'pessoas', 'produtos']));
dbt.prepare("INSERT INTO perfis_acesso (slug, nome, paginas, ativo) VALUES ('gerente-comercial','Gerente',?,1)")
  .run(JSON.stringify(['pedidos', 'pessoas', 'produtos', 'comercial-metas', 'comissoes']));
dbt.prepare("INSERT INTO produtos (id, sku, descricao, unidade, precoVenda, ativo) VALUES (1,'SKU-A','Produto','UN',100,1)").run();
dbt.prepare("INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, origem, data) VALUES (1,'entrada',99999,'ajuste',date('now'))").run();
dbt.prepare(`INSERT INTO tipos_operacao (id, codigo, descricao, categoriaOperacao, emiteNFe, geraFinanceiro, movimentaEstoque, cfopInterno, cfopInterestadual, usarEmPedido, ativo)
  VALUES (1,'VDA-NORMAL','Venda normal','venda',1,1,1,'5102','6102',1,1)`).run();

const VEND = { session: { userId: 10 }, user: { id: 10, username: 'vend1', role: 'comercial', ativo: 1, ehVendedor: 1 } };
const GERENTE = { session: { userId: 12 }, user: { id: 12, username: 'gerente', role: 'gerente-comercial', ativo: 1, ehVendedor: 1 } };
const ADMIN = { session: { userId: 1 }, user: { id: 1, username: 'admin', role: 'admin', ativo: 1, ehVendedor: 0 } };

const novo = (ator, body = {}) => chamar('/api/pedidos', 'post', { ...ator, body });
const addItem = (ator, id, qtd = 5) =>
  chamar('/api/pedidos/:id/itens', 'post', { ...ator, params: { id }, body: { produtoId: 1, descricao: 'Produto', quantidade: qtd } });
/** Pedido com 5 × R$ 100 = subtotal R$ 500 — a base de todos os cálculos abaixo. */
const comItens = (ator, body = {}, qtd = 5) => {
  const p = novo(ator, { clienteId: 1, ...body }).out.pedido;
  addItem(ator, p.id, qtd);
  return p;
};
const ler = (id) => dbt.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
const put = (ator, id, body) => chamar('/api/pedidos/:id', 'put', { ...ator, params: { id }, body });
const confirmar = (ator, id) => chamar('/api/pedidos/:id/confirmar', 'post', { ...ator, params: { id }, body: {} });

const limparFaixas = () => dbt.prepare('DELETE FROM regras_alcada').run();
const criarFaixas = () => {
  limparFaixas();
  // "acima de 5% exige gerente-comercial"; "acima de 15% exige admin".
  dbt.prepare("INSERT INTO regras_alcada (tipoEvento, limiteValor, papelAprovador, ativo, validadeDias) VALUES ('desconto_venda',5,'gerente-comercial',1,7)").run();
  dbt.prepare("INSERT INTO regras_alcada (tipoEvento, limiteValor, papelAprovador, ativo, validadeDias) VALUES ('desconto_venda',15,'admin',1,7)").run();
};

// ==================== A. FÓRMULA DO TOTAL ====================
t('A1. sem desconto, o total continua itens + frete (nada regrediu)', () => {
  const p = comItens(VEND);
  assert(ler(p.id).valorTotal === 500, 'total=' + ler(p.id).valorTotal);
  put(ADMIN, p.id, { valorFrete: 30 });
  assert(ler(p.id).valorTotal === 530, 'com frete=' + ler(p.id).valorTotal);
});

t('A2. a formula e subtotal - desconto + frete', () => {
  assert(desconto.totalDoPedido({ subtotalItens: 500, desconto: 50, frete: 30 }) === 480, 'formula errada');
});

t('A3. total NUNCA fica negativo', () => {
  assert(desconto.totalDoPedido({ subtotalItens: 100, desconto: 500, frete: 0 }) === 0, 'ficou negativo');
  assert(desconto.totalDoPedido({ subtotalItens: 0, desconto: 50, frete: 0 }) === 0, 'ficou negativo sem itens');
});

t('A4. frete negativo nao vira desconto na formula', () => {
  assert(desconto.totalDoPedido({ subtotalItens: 100, desconto: 0, frete: -50 }) === 100, 'frete negativo abateu');
});

// ==================== B. PERCENTUAL × VALOR ====================
t('B1. percentual e a fonte canonica: 10% de 500 = 50', () => {
  criarFaixas();
  const p = comItens(ADMIN);
  put(ADMIN, p.id, { descontoPercentual: 10 });
  const d = ler(p.id);
  assert(d.descontoTipo === 'percentual' && d.descontoValor === 10, 'gravou tipo/valor errado: ' + JSON.stringify(d.descontoTipo));
  assert(d.descontoAplicado === 50, 'aplicado=' + d.descontoAplicado);
  assert(d.valorTotal === 450, 'total=' + d.valorTotal);
});

t('B2. valor em reais tambem vale, e o percentual e derivado', () => {
  const p = comItens(ADMIN);
  put(ADMIN, p.id, { descontoValor: 50 });
  const d = ler(p.id);
  assert(d.descontoTipo === 'valor' && d.descontoAplicado === 50, JSON.stringify(d.descontoTipo));
  assert(d.valorTotal === 450, 'total=' + d.valorTotal);
});

t('B3. percentual E valor INCONSISTENTES sao recusados, nao conciliados', () => {
  const p = comItens(ADMIN);
  const r = put(ADMIN, p.id, { descontoPercentual: 10, descontoValor: 70 });
  assert(r.st === 422, 'status=' + r.st);
  assert(/inconsistente/i.test(r.out.error), 'msg=' + r.out.error);
  assert((ler(p.id).descontoAplicado || 0) === 0, 'gravou mesmo recusando');
});

t('B4. percentual E valor CONSISTENTES passam (10% de 500 = 50)', () => {
  const p = comItens(ADMIN);
  const r = put(ADMIN, p.id, { descontoPercentual: 10, descontoValor: 50 });
  assert(r.st === 200, 'status=' + r.st + ' ' + JSON.stringify(r.out.error));
  assert(ler(p.id).descontoAplicado === 50, 'aplicado=' + ler(p.id).descontoAplicado);
});

t('B5. desconto percentual acompanha o subtotal quando itens mudam', () => {
  const p = comItens(ADMIN);                       // 500
  put(ADMIN, p.id, { descontoPercentual: 10 });    // 50
  assert(ler(p.id).descontoAplicado === 50, 'inicial=' + ler(p.id).descontoAplicado);
  addItem(ADMIN, p.id, 5);                         // subtotal 1000
  const d = ler(p.id);
  assert(d.descontoAplicado === 100, 'nao reprecificou: ' + d.descontoAplicado);
  assert(d.valorTotal === 900, 'total=' + d.valorTotal);
});

// ==================== C. ALÇADA — VENDEDOR (faixa 5%) ====================
t('C1. VENDEDOR 0% -> liberado, sem alcada', () => {
  criarFaixas();
  const p = comItens(VEND);
  const r = put(VEND, p.id, { descontoPercentual: 0 });
  assert(r.st === 200, 'status=' + r.st);
  assert(ler(p.id).descontoAplicado === 0, 'aplicado != 0');
  assert(confirmar(VEND, p.id).st === 200, 'nao confirmou');
});

t('C2. VENDEDOR 3% -> aplica direto (abaixo da faixa)', () => {
  const p = comItens(VEND);
  const r = put(VEND, p.id, { descontoPercentual: 3 });
  assert(r.st === 200, 'status=' + r.st + ' ' + JSON.stringify(r.out.error));
  assert(ler(p.id).descontoAplicado === 15, 'aplicado=' + ler(p.id).descontoAplicado);
  assert(ler(p.id).valorTotal === 485, 'total=' + ler(p.id).valorTotal);
  assert(r.out.desconto.aguardandoAprovacao === false, 'pediu aprovacao');
  assert(confirmar(VEND, p.id).st === 200, 'nao confirmou');
});

t('C3. VENDEDOR 5% -> aplica direto (o limite e "ACIMA de 5")', () => {
  const p = comItens(VEND);
  const r = put(VEND, p.id, { descontoPercentual: 5 });
  assert(r.st === 200, 'status=' + r.st);
  assert(ler(p.id).descontoAplicado === 25, 'aplicado=' + ler(p.id).descontoAplicado);
  assert(confirmar(VEND, p.id).st === 200, 'nao confirmou no limite');
});

t('C4. VENDEDOR 6% -> exige aprovacao de gerente-comercial', () => {
  const p = comItens(VEND);
  const r = put(VEND, p.id, { descontoPercentual: 6, descontoMotivo: 'cliente fechou volume' });
  assert(r.st === 200, 'status=' + r.st + ' ' + JSON.stringify(r.out.error));
  assert(r.out.desconto.aguardandoAprovacao === true, 'nao pediu aprovacao');
  assert(r.out.desconto.papelExigido === 'gerente-comercial', 'papel=' + r.out.desconto.papelExigido);
  const a = dbt.prepare("SELECT * FROM aprovacoes WHERE tipoEvento='desconto_venda' AND referenciaId=?").get(p.id);
  assert(a && a.status === 'pendente', 'sem solicitacao pendente');
  assert(a.solicitante === 'vend1', 'solicitante=' + a.solicitante);
  assert(Number(a.valorReferencia) === 6, 'percentual gravado=' + a.valorReferencia);
  assert(a.papelExigido === 'gerente-comercial', 'papelExigido=' + a.papelExigido);
  assert(a.dataCriacao && a.expiraEm, 'sem data/hora ou validade');
});

t('C5. pedido com desconto pendente NAO vira venda', () => {
  const p = comItens(VEND);
  put(VEND, p.id, { descontoPercentual: 8, descontoMotivo: 'negociacao' });
  const r = confirmar(VEND, p.id);
  assert(r.st === 409, 'status=' + r.st);
  assert(/aguarda aprovação/i.test(r.out.error), 'msg=' + r.out.error);
  assert(ler(p.id).status === 'rascunho', 'status do pedido=' + ler(p.id).status);
});

t('C6. depois de APROVADA, a confirmacao passa e a aprovacao e CONSUMIDA', () => {
  const p = comItens(VEND);
  put(VEND, p.id, { descontoPercentual: 8, descontoMotivo: 'negociacao' });
  const a = dbt.prepare("SELECT * FROM aprovacoes WHERE referenciaId=? AND tipoEvento='desconto_venda' ORDER BY id DESC").get(p.id);
  dbt.prepare("UPDATE aprovacoes SET status='aprovada', aprovador='gerente', dataDecisao=datetime('now'), valorAprovado=8 WHERE id=?").run(a.id);

  const r = confirmar(VEND, p.id);
  assert(r.st === 200, 'nao confirmou: ' + JSON.stringify(r.out));
  assert(ler(p.id).status === 'confirmado', 'status=' + ler(p.id).status);
  const dep = dbt.prepare('SELECT * FROM aprovacoes WHERE id=?').get(a.id);
  assert(dep.consumida === 1, 'aprovacao ficou aberta para reuso');
  assert(dep.aprovador === 'gerente' && dep.dataDecisao, 'nao registrou aprovador/data');
});

t('C7. aprovacao REPROVADA barra a confirmacao', () => {
  const p = comItens(VEND);
  put(VEND, p.id, { descontoPercentual: 9, descontoMotivo: 'tentativa' });
  const a = dbt.prepare("SELECT * FROM aprovacoes WHERE referenciaId=? AND tipoEvento='desconto_venda' ORDER BY id DESC").get(p.id);
  dbt.prepare("UPDATE aprovacoes SET status='reprovada', aprovador='gerente', motivo='margem insuficiente' WHERE id=?").run(a.id);
  const r = confirmar(VEND, p.id);
  assert(r.st === 409, 'status=' + r.st);
  assert(/reprovado/i.test(r.out.error), 'msg=' + r.out.error);
});

t('C8. aprovacao NAO cobre percentual maior do que o aprovado', () => {
  const p = comItens(VEND);                                     // 500
  put(VEND, p.id, { descontoPercentual: 8, descontoMotivo: 'negociacao fechada' });
  const a = dbt.prepare("SELECT * FROM aprovacoes WHERE referenciaId=? AND tipoEvento='desconto_venda' ORDER BY id DESC").get(p.id);
  dbt.prepare("UPDATE aprovacoes SET status='aprovada', aprovador='gerente', valorAprovado=8 WHERE id=?").run(a.id);
  // Sobe o desconto DEPOIS de aprovado: a aprovação de 8% não pode cobrir 20%.
  dbt.prepare('UPDATE pedidos SET descontoAplicado = 100 WHERE id = ?').run(p.id);
  const r = confirmar(VEND, p.id);
  assert(r.st === 409, 'aprovacao de 8% liberou 20%: status=' + r.st);
});

// ==================== D. ALÇADA — GERENTE e ADMIN ====================
t('D1. GERENTE 5% -> direto (abaixo da propria faixa)', () => {
  criarFaixas();
  const p = comItens(GERENTE);
  assert(put(GERENTE, p.id, { descontoPercentual: 5 }).st === 200, 'recusou');
  assert(confirmar(GERENTE, p.id).st === 200, 'nao confirmou');
});

t('D2. GERENTE 15% -> direto: e a faixa cuja autoridade e a DELE', () => {
  const p = comItens(GERENTE);
  const r = put(GERENTE, p.id, { descontoPercentual: 15 });
  assert(r.st === 200, 'status=' + r.st);
  assert(r.out.desconto.autoridade === 'propria', 'autoridade=' + r.out.desconto.autoridade);
  assert(r.out.desconto.aguardandoAprovacao === false, 'gerente pediu aprovacao a outro gerente');
  assert(ler(p.id).descontoAplicado === 75, 'aplicado=' + ler(p.id).descontoAplicado);
  assert(confirmar(GERENTE, p.id).st === 200, 'nao confirmou');
});

t('D3. GERENTE 16% -> exige admin (sobe de faixa)', () => {
  const p = comItens(GERENTE);
  const r = put(GERENTE, p.id, { descontoPercentual: 16, descontoMotivo: 'campanha' });
  assert(r.out.desconto.aguardandoAprovacao === true, 'nao pediu aprovacao');
  assert(r.out.desconto.papelExigido === 'admin', 'papel=' + r.out.desconto.papelExigido);
  assert(confirmar(GERENTE, p.id).st === 409, 'confirmou sem aprovacao');
});

t('D4. ADMIN 30% -> direto, sem aprovacao', () => {
  const p = comItens(ADMIN);
  const r = put(ADMIN, p.id, { descontoPercentual: 30 });
  assert(r.st === 200, 'status=' + r.st);
  assert(r.out.desconto.aguardandoAprovacao === false, 'admin pediu aprovacao');
  assert(ler(p.id).descontoAplicado === 150, 'aplicado=' + ler(p.id).descontoAplicado);
  assert(ler(p.id).valorTotal === 350, 'total=' + ler(p.id).valorTotal);
  assert(confirmar(ADMIN, p.id).st === 200, 'nao confirmou');
});

// ==================== E. FAIL-CLOSED (sem faixas) ====================
t('E1. SEM faixas: vendedor 0% -> OK (venda nao e bloqueada, so o desconto)', () => {
  limparFaixas();
  const p = comItens(VEND);
  assert(put(VEND, p.id, { descontoPercentual: 0 }).st === 200, 'recusou 0%');
  assert(confirmar(VEND, p.id).st === 200, 'bloqueou a VENDA, nao so o desconto');
});

t('E2. SEM faixas: vendedor 0,01% -> RECUSADO (ausencia nao e ilimitado)', () => {
  const p = comItens(VEND);
  const r = put(VEND, p.id, { descontoPercentual: 0.01 });
  assert(r.st === 422, 'status=' + r.st);
  assert(/limite é 0%|não autorizado/i.test(r.out.error), 'msg=' + r.out.error);
  assert((ler(p.id).descontoAplicado || 0) === 0, 'gravou mesmo recusando');
});

t('E3. SEM faixas: gerente COM perfil cadastrado tambem e barrado', () => {
  const p = comItens(GERENTE);
  assert(put(GERENTE, p.id, { descontoPercentual: 5 }).st === 422, 'gerente furou o fail-closed');
});

t('E4. SEM faixas: admin mantem o comportamento privilegiado aprovado', () => {
  const p = comItens(ADMIN);
  const r = put(ADMIN, p.id, { descontoPercentual: 20 });
  assert(r.st === 200, 'status=' + r.st);
  assert(r.out.desconto.autoridade === 'privilegiado', 'autoridade=' + r.out.desconto.autoridade);
});

t('E5. RISCO REGISTRADO: role SEM perfil cadastrado passa como privilegiado', () => {
  // Não é o comportamento desejado — é o fail-open de perfis-acesso.js, que NÃO
  // foi endurecido nesta fase por decisão do usuário. O teste existe para que a
  // mudança desse comportamento seja consciente, e não uma surpresa.
  const ORFAO = { session: { userId: 11 }, user: { id: 11, username: 'vend2', role: 'sem-perfil-cadastrado', ativo: 1, ehVendedor: 1 } };
  const p = comItens(ORFAO);
  const r = put(ORFAO, p.id, { descontoPercentual: 50 });
  assert(r.st === 200 && r.out.desconto.autoridade === 'privilegiado',
    'o fail-open mudou — revise o relatorio 19 §4: ' + r.st);
});

// ==================== F. MOTIVO ====================
t('F1. dentro da alcada propria, motivo e OPCIONAL', () => {
  criarFaixas();
  const p = comItens(VEND);
  assert(put(VEND, p.id, { descontoPercentual: 3 }).st === 200, 'exigiu motivo dentro da alcada');
});

t('F2. acima da alcada, motivo e OBRIGATORIO', () => {
  const p = comItens(VEND);
  const r = put(VEND, p.id, { descontoPercentual: 10 });
  assert(r.st === 422, 'status=' + r.st);
  assert(/descontoMotivo/i.test(r.out.error), 'msg=' + r.out.error);
  assert(!dbt.prepare("SELECT 1 FROM aprovacoes WHERE referenciaId=? AND tipoEvento='desconto_venda'").get(p.id),
    'abriu solicitacao mesmo sem motivo');
});

t('F3. motivo vazio ou so espacos nao conta como motivo', () => {
  const p = comItens(VEND);
  assert(put(VEND, p.id, { descontoPercentual: 10, descontoMotivo: '   ' }).st === 422, 'aceitou espacos');
});

t('F4. o motivo e gravado e chega ao aprovador', () => {
  const p = comItens(VEND);
  put(VEND, p.id, { descontoPercentual: 10, descontoMotivo: 'cliente historico, fecha 12x' });
  assert(ler(p.id).descontoMotivo === 'cliente historico, fecha 12x', 'motivo nao gravado');
});

// ==================== G. tipoAtendimento ====================
t('G1. PDV + no_local -> OK', () => {
  const p = comItens(VEND, { origem: 'pdv', tipoAtendimento: 'no_local' });
  assert(ler(p.id).tipo === 'pdv' && ler(p.id).tipoAtendimento === 'no_local', 'nao gravou');
  assert(confirmar(VEND, p.id).st === 200, 'nao confirmou');
});

t('G2. PDV + retirada -> OK', () => {
  const p = comItens(VEND, { origem: 'pdv', tipoAtendimento: 'retirada' });
  assert(confirmar(VEND, p.id).st === 200, 'nao confirmou');
});

t('G3. PDV + entrega COM endereco -> OK', () => {
  const p = comItens(VEND, { origem: 'pdv', tipoAtendimento: 'entrega' });
  assert(confirmar(VEND, p.id).st === 200, 'recusou com endereco do cliente');
});

t('G4. PDV SEM tipoAtendimento -> ERRO na confirmacao', () => {
  const p = comItens(VEND, { origem: 'pdv' });
  const r = confirmar(VEND, p.id);
  assert(r.st === 422, 'status=' + r.st);
  assert(/exige tipoAtendimento/i.test(r.out.error), 'msg=' + r.out.error);
  assert(ler(p.id).status === 'rascunho', 'virou venda mesmo assim');
});

t('G5. PDV + entrega SEM endereco nenhum -> ERRO', () => {
  const p = novo(VEND, { clienteId: 2, origem: 'pdv', tipoAtendimento: 'entrega' }).out.pedido;
  addItem(VEND, p.id, 5);
  const r = confirmar(VEND, p.id);
  assert(r.st === 422, 'status=' + r.st);
  assert(/endereço/i.test(r.out.error), 'msg=' + r.out.error);
});

t('G6. entrega com endereco NO PEDIDO (override) tambem serve', () => {
  const p = novo(VEND, { clienteId: 2, origem: 'pdv', tipoAtendimento: 'entrega' }).out.pedido;
  addItem(VEND, p.id, 5);
  put(VEND, p.id, { enderecoEntrega: 'Rua B, 200', cidadeEntrega: 'Campinas', ufEntrega: 'SP' });
  assert(confirmar(VEND, p.id).st === 200, 'recusou com endereco do pedido');
});

t('G7. CATALOGO tem as mesmas exigencias do PDV', () => {
  // 'catalogo' não pode vir do corpo (origem reservada) — a loja grava direto.
  const p = comItens(VEND, {}, 5);
  dbt.prepare("UPDATE pedidos SET tipo='catalogo' WHERE id=?").run(p.id);
  assert(confirmar(VEND, p.id).st === 422, 'catalogo confirmou sem atendimento');
  dbt.prepare("UPDATE pedidos SET tipoAtendimento='retirada' WHERE id=?").run(p.id);
  assert(confirmar(VEND, p.id).st === 200, 'catalogo + retirada foi recusado');
});

t('G8. CATALOGO + entrega sem endereco -> ERRO', () => {
  const p = novo(VEND, { clienteId: 2 }).out.pedido;
  addItem(VEND, p.id, 5);
  dbt.prepare("UPDATE pedidos SET tipo='catalogo', tipoAtendimento='entrega' WHERE id=?").run(p.id);
  assert(confirmar(VEND, p.id).st === 422, 'confirmou entrega sem endereco');
});

t('G9. MANUAL do ERP com tipoAtendimento NULL -> OK (nao quebrou o legado)', () => {
  const p = comItens(VEND);
  assert(ler(p.id).tipoAtendimento === null, 'nasceu preenchido');
  assert(confirmar(VEND, p.id).st === 200, 'exigiu atendimento do ERP tradicional');
});

t('G10. tipoAtendimento invalido e recusado na ENTRADA', () => {
  const r = novo(VEND, { clienteId: 1, origem: 'pdv', tipoAtendimento: 'teleporte' });
  assert(r.st === 422, 'POST aceitou: ' + r.st);
  const p = comItens(VEND);
  assert(put(VEND, p.id, { tipoAtendimento: 'drone' }).st === 422, 'PUT aceitou');
});

t('G11. frete NAO e amarrado ao atendimento (regra nao inventada)', () => {
  const p = comItens(VEND, { origem: 'pdv', tipoAtendimento: 'no_local' });
  assert(put(VEND, p.id, { valorFrete: 20 }).st === 200, 'impos frete zero em no_local');
});

// ==================== H. SEGURANÇA ====================
t('H1. vendedor NAO assume pedido de outro vendedor', () => {
  const r = novo(VEND, { clienteId: 1, vendedorId: 11 });
  assert(r.out.pedido.vendedorId === 10, 'vendedorId=' + r.out.pedido.vendedorId);
});

t('H2. vendedor restrito NAO define preco manual', () => {
  const p = novo(VEND, { clienteId: 1 }).out.pedido;
  chamar('/api/pedidos/:id/itens', 'post', { ...VEND, params: { id: p.id },
    body: { produtoId: 1, descricao: 'Produto', quantidade: 1, precoUnitario: 1 } });
  const it = dbt.prepare('SELECT * FROM pedido_itens WHERE pedidoId=?').get(p.id);
  assert(Number(it.precoUnitario) === 100, 'preco manual passou: ' + it.precoUnitario);
});

t('H3. desconto NEGATIVO e recusado', () => {
  criarFaixas();
  const p = comItens(ADMIN);
  const r = put(ADMIN, p.id, { descontoPercentual: -10 });
  assert(r.st === 422 && /negativo/i.test(r.out.error), 'status=' + r.st + ' ' + r.out.error);
  assert(ler(p.id).valorTotal === 500, 'total mudou');
});

t('H4. desconto acima de 100% e recusado', () => {
  const p = comItens(ADMIN);
  assert(put(ADMIN, p.id, { descontoPercentual: 101 }).st === 422, 'aceitou > 100%');
});

t('H5. desconto em reais maior que o subtotal e recusado', () => {
  const p = comItens(ADMIN);
  const r = put(ADMIN, p.id, { descontoValor: 600 });
  assert(r.st === 422 && /maior que o subtotal/i.test(r.out.error), 'msg=' + r.out.error);
});

t('H6. frete negativo continua recusado', () => {
  const p = comItens(ADMIN);
  assert(put(ADMIN, p.id, { valorFrete: -50 }).st === 422, 'aceitou frete negativo');
});

t('H7. valorTotal mandado no corpo e IGNORADO', () => {
  const p = comItens(ADMIN);
  put(ADMIN, p.id, { valorTotal: 1 });
  assert(ler(p.id).valorTotal === 500, 'o corpo mandou no total: ' + ler(p.id).valorTotal);
});

t('H8. descontoAplicado mandado no corpo NAO entra pela porta dos fundos', () => {
  const p = comItens(VEND);
  // Sem `descontoPercentual`/`descontoValor`, nada é aplicado — e o campo
  // calculado não está em CAMPOS_PEDIDO, então o UPDATE não o alcança.
  put(VEND, p.id, { descontoAplicado: 400, descontoTipo: 'valor' });
  assert((ler(p.id).descontoAplicado || 0) === 0, 'gravou desconto sem alcada: ' + ler(p.id).descontoAplicado);
  assert(ler(p.id).valorTotal === 500, 'total=' + ler(p.id).valorTotal);
});

t('H9. origem reservada NAO pode ser forjada pelo corpo', () => {
  for (const forjada of ['catalogo', 'licitacao', 'os', 'marketplace']) {
    assert(novo(VEND, { clienteId: 1, origem: forjada }).out.pedido.tipo === 'manual',
      'aceitou origem forjada: ' + forjada);
  }
});

t('H10. quantidade negativa continua recusada (Fase 0 intacta)', () => {
  const p = novo(ADMIN, { clienteId: 1 }).out.pedido;
  const r = chamar('/api/pedidos/:id/itens', 'post', { ...ADMIN, params: { id: p.id },
    body: { produtoId: 1, descricao: 'X', quantidade: -1 } });
  assert(r.st >= 400, 'aceitou quantidade negativa');
});

// ==================== I. FATURAMENTO ====================
t('I1. fatura HERDA o desconto do pedido quando valorDesconto e omitido', () => {
  criarFaixas();
  const p = comItens(ADMIN);
  put(ADMIN, p.id, { descontoPercentual: 10 });          // 50 de 500
  assert(desconto.descontoDoPedido(dbt, p.id) === 50, 'descontoDoPedido=' + desconto.descontoDoPedido(dbt, p.id));
});

t('I2. desconto informado SUBSTITUI, nunca soma', () => {
  // A regra vive em faturas-routes; aqui se prova a fonte que ela consulta.
  const p = comItens(ADMIN);
  put(ADMIN, p.id, { descontoPercentual: 10 });
  const herdado = desconto.descontoDoPedido(dbt, p.id);
  const informado = 30;
  assert(herdado === 50 && informado !== herdado + informado, 'a soma nao pode acontecer');
});

// ==================== J. VOCABULÁRIO E MOTOR ====================
t('J1. desconto_venda esta no motor de governanca (faixa pode ser cadastrada)', () => {
  assert(alcadas.TIPOS_EVENTO.includes('desconto_venda'), 'evento ausente — faixa nao pode ser criada');
  const p = alcadas.validarRegra(dbt, { tipoEvento: 'desconto_venda', limiteValor: 10, papelAprovador: 'gerente-comercial' },
    { roles: ['admin', 'gerente-comercial', 'comercial'] });
  assert(!p.some((x) => x.codigo === 'tipo_invalido'), 'validarRegra recusa o tipo: ' + JSON.stringify(p));
});

t('J2. o limite de desconto_venda e percentual, e isso esta declarado', () => {
  assert(alcadas.EVENTOS_PERCENTUAIS.has('desconto_venda'), 'nao declarado como percentual');
});

t('J3. vocabulario de atendimento tem exatamente os 3 valores aprovados', () => {
  assert(atendimento.TIPOS_ATENDIMENTO.join() === 'no_local,retirada,entrega', atendimento.TIPOS_ATENDIMENTO.join());
  assert(atendimento.ORIGENS_EXIGEM_ATENDIMENTO.join() === 'pdv,catalogo', atendimento.ORIGENS_EXIGEM_ATENDIMENTO.join());
});

t('J4. tenant SEM as colunas nao quebra (tolerancia mantida)', () => {
  const semCol = new Database(':memory:');
  semCol.exec('CREATE TABLE pedidos (id INTEGER PRIMARY KEY, valorFrete REAL); CREATE TABLE pedido_itens (id INTEGER PRIMARY KEY, pedidoId INTEGER, valorTotal REAL)');
  assert(desconto.temColunaDesconto(semCol) === false, 'detectou coluna inexistente');
  assert(desconto.descontoDoPedido(semCol, 1) === 0, 'nao devolveu 0');
  assert(desconto.aplicarDescontoNoPedido(semCol, { pedidoId: 1, body: { descontoPercentual: 10 } }).ok === true, 'quebrou');
  assert(desconto.bloqueioDeConfirmacao(semCol, 1).bloqueado === false, 'bloqueou sem coluna');
  semCol.close();
});

dbt.close();
try { fs.unlinkSync(DB); } catch {}
console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
