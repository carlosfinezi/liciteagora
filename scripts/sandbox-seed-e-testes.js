/**
 * Sandbox — massa de teste e validação da Fase 1.
 *
 * Roda SOMENTE no tenant `sandbox` (recusa qualquer outro). Semeia dados
 * fictícios e executa as baterias de desconto, tipo de atendimento, pessoa sem
 * documento e pedido→fatura, imprimindo a tabela de resultados.
 *
 * As faixas de alçada (5% / 15%) são MASSA DE TESTE deste tenant. Não estão na
 * migration nem em nenhum seed de produção.
 *
 *   node scripts/sandbox-seed-e-testes.js
 */
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const DB_PATH = path.join(RAIZ, 'data', 'tenants', 'sandbox', 'pncp.db');

// Trava dura: este script escreve, e só pode escrever no sandbox.
if (!DB_PATH.includes(`${path.sep}sandbox${path.sep}`)) {
  console.error('RECUSADO: este script só opera no tenant sandbox.');
  process.exit(2);
}
const db = new Database(DB_PATH);
if (!db.prepare('PRAGMA table_info(pedidos)').all().some((c) => c.name === 'descontoAplicado')) {
  console.error('RECUSADO: sandbox sem a migration da Fase 1. Rode scripts/migrate-fase1-pedido.js sandbox --aplicar');
  process.exit(2);
}

const { registrarRotasPedidos } = require(path.join(RAIZ, 'pedidos-routes'));
const { registrarRotasProdutos } = require(path.join(RAIZ, 'produtos-routes'));
const { registrarRotasReservas } = require(path.join(RAIZ, 'reservas-routes'));
const { registrarRotasFaturas } = require(path.join(RAIZ, 'faturas-routes'));
const { registrarRotasFinanceiro } = require(path.join(RAIZ, 'financeiro-routes'));
const desconto = require(path.join(RAIZ, 'pedido-desconto'));
const semDoc = require(path.join(RAIZ, 'pessoa-sem-documento'));

const app = express();
registrarRotasPedidos(app, db);
registrarRotasProdutos(app, db);
registrarRotasReservas(app, db);
registrarRotasFaturas(app, db);
registrarRotasFinanceiro(app, db);

const achar = (p, m) => {
  const l = ((app.router || app._router).stack || []).find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                session: o.session || {}, user: o.user, ip: '127.0.0.1', headers: {} },
    { json: x => { out = x; return { json: y => { out = y; } }; },
      status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const titulo = (s) => console.log(`\n═══ ${s} ${'═'.repeat(Math.max(0, 66 - s.length))}`);

const ADMIN = { session: { userId: 0 }, user: null };
const usuario = (username) => {
  const u = db.prepare('SELECT id, username, role, ativo, ehVendedor FROM users WHERE username = ?').get(username);
  return { session: { userId: u.id, username: u.username }, user: u };
};

// ══════════════ FASE 1.4 — MASSA DE TESTE ══════════════
titulo('FASE 1.4 — massa de teste');

const VEND = usuario('vendedor'), GER = usuario('gerente'), ADM = usuario('admin');
console.log(`  usuários: vendedor#${VEND.user.id} (${VEND.user.role}) · gerente#${GER.user.id} · admin#${ADM.user.id}`);

// ---------- clientes ----------
const upsertPessoa = (cpfCnpj, tipo, razao, telefone, semDocumento = 0) => {
  const ja = db.prepare('SELECT id FROM pessoas WHERE cpfCnpj = ?').get(cpfCnpj);
  if (ja) return ja.id;
  return db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, telefone, ativo, semDocumento)
                     VALUES (?, ?, ?, ?, 1, ?)`).run(cpfCnpj, tipo, razao, telefone, semDocumento).lastInsertRowid;
};
const CLI_CPF  = upsertPessoa('11144477735', 'PF', 'Ana Souza (CPF)', '(11) 90000-1111');
const CLI_CNPJ = upsertPessoa('11222333000181', 'PJ', 'Comercio Fictício LTDA (CNPJ)', '(11) 90000-2222');
// Dois clientes distintos com o MESMO telefone — para provar que não há merge.
const CLI_TEL_A = upsertPessoa('52998224725', 'PF', 'Bruno Lima', '(11) 93333-4444');
const CLI_TEL_B = upsertPessoa('87748248800', 'PF', 'Carla Lima', '(11) 93333-4444');
// Cliente sem documento. O identificador é novo a cada geração, então a
// idempotência aqui é por nome+telefone — senão cada execução criaria um Diego.
const jaSemDoc = db.prepare("SELECT id, cpfCnpj FROM pessoas WHERE razaoSocial='Diego do Balcão' AND semDocumento=1").get();
const IDSD = jaSemDoc ? jaSemDoc.cpfCnpj : semDoc.gerarIdentificadorSemDocumento();
const CLI_SEMDOC = jaSemDoc ? jaSemDoc.id : upsertPessoa(IDSD, 'PF', 'Diego do Balcão', '(11) 95555-6666', 1);
console.log(`  clientes: CPF#${CLI_CPF} · CNPJ#${CLI_CNPJ} · mesmo telefone #${CLI_TEL_A}/#${CLI_TEL_B} · sem documento #${CLI_SEMDOC}`);
console.log(`  identificador do sem-documento: ${IDSD}`);

// ---------- produtos ----------
const upsertProduto = (sku, desc, unidade, preco, estoque) => {
  let p = db.prepare('SELECT id FROM produtos WHERE sku = ?').get(sku);
  if (!p) {
    p = { id: db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo)
                          VALUES (?, ?, ?, ?, 1)`).run(sku, desc, unidade, preco).lastInsertRowid };
    if (estoque > 0) {
      db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, origem, observacao, data)
                  VALUES (?, 'entrada', ?, 'ajuste', 'Massa de teste do sandbox', date('now'))`).run(p.id, estoque);
    }
  }
  return p.id;
};
const P100 = upsertProduto('SBX-100', 'Produto 100 reais', 'UN', 100, 500);
upsertProduto('SBX-050', 'Produto 50 reais', 'UN', 50, 500);
upsertProduto('SBX-250', 'Produto 250 reais', 'UN', 250, 200);
upsertProduto('SBX-KG', 'Produto a granel', 'KG', 20, 100);
const P_SEM_ESTOQUE = upsertProduto('SBX-ZERO', 'Produto sem estoque', 'UN', 75, 0);
console.log(`  produtos: 5 cadastrados (um deles, #${P_SEM_ESTOQUE}, sem estoque)`);

// ---------- tipo de operação ----------
if (!db.prepare("SELECT id FROM tipos_operacao WHERE codigo='VDA-NORMAL'").get()) {
  db.prepare(`INSERT INTO tipos_operacao (codigo, descricao, categoriaOperacao, emiteNFe, geraFinanceiro,
    movimentaEstoque, cfopInterno, cfopInterestadual, usarEmPedido, ativo)
    VALUES ('VDA-NORMAL','Venda normal','venda',1,1,1,'5102','6102',1,1)`).run();
}

// ---------- alçadas: MASSA DE TESTE, só deste tenant ----------
db.prepare("DELETE FROM regras_alcada WHERE tipoEvento='desconto_venda'").run();
db.prepare(`INSERT INTO regras_alcada (tipoEvento, limiteValor, papelAprovador, validadeDias, descricao, ativo)
  VALUES ('desconto_venda', 5, 'gerente-comercial', 7, '[SANDBOX] acima de 5% exige gerente', 1)`).run();
db.prepare(`INSERT INTO regras_alcada (tipoEvento, limiteValor, papelAprovador, validadeDias, descricao, ativo)
  VALUES ('desconto_venda', 15, 'admin', 7, '[SANDBOX] acima de 15% exige admin', 1)`).run();
console.log('  alçadas (MASSA DE TESTE): vendedor até 5% · gerente até 15% · acima, admin');

// ══════════════ FASE 1.5 — DESCONTO ══════════════
titulo('FASE 1.5 — testes de desconto');

const novoPedido = (ator, body = {}) => chamar('/api/pedidos', 'post', { ...ator, body });
const pedidoDe = (ator, clienteId, qtd, origem) => {
  const p = novoPedido(ator, { clienteId, origem }).out.pedido;
  chamar('/api/pedidos/:id/itens', 'post', { ...ator, params: { id: p.id }, body: { produtoId: P100, descricao: 'Produto 100 reais', quantidade: qtd } });
  return db.prepare('SELECT * FROM pedidos WHERE id=?').get(p.id);
};
const subtotalDe = (id) => db.prepare('SELECT COALESCE(SUM(valorTotal),0) s FROM pedido_itens WHERE pedidoId=?').get(id).s;

const APROVADOR = { 'gerente-comercial': 'gerente (ou admin)', admin: 'admin' };
console.log('\n  ator      %      subtotal   desconto      frete      total   alçada              aprovação   quem aprova');
console.log('  ' + '─'.repeat(104));
const linhaDesconto = (rotulo, ator, pct, frete = 0) => {
  const ped = pedidoDe(ator, CLI_CPF, 5, 'pdv');          // 5 × 100 = 500
  const sub = subtotalDe(ped.id);
  const calc = desconto.calcularDesconto({ subtotal: sub, tipo: 'percentual', valor: pct });
  const alc = desconto.verificarAlcadaDesconto(db, { pedidoId: ped.id, percentual: pct, req: ator });
  const total = alc.liberado ? desconto.totalDoPedido({ subtotalItens: sub, desconto: calc.aplicado, frete })
                             : desconto.totalDoPedido({ subtotalItens: sub, desconto: 0, frete });
  const situacao = alc.liberado ? (alc.autoridade || 'liberado') : (alc.status || 'bloqueado');
  const exigiu = alc.liberado ? 'não' : 'SIM';
  const quem = alc.liberado ? '—' : (APROVADOR[alc.regra?.papelAprovador] || (alc.status === 'sem_alcada' ? 'ninguém: sem alçada' : '—'));
  console.log(`  ${rotulo.padEnd(9)} ${String(pct + '%').padStart(4)}  ${sub.toFixed(2).padStart(9)}  ${calc.aplicado.toFixed(2).padStart(9)}  ${frete.toFixed(2).padStart(9)}  ${total.toFixed(2).padStart(9)}   ${situacao.padEnd(18)} ${exigiu.padEnd(10)} ${quem}`);
  return { ped, sub, calc, alc, total };
};

const r = {};
r.v0 = linhaDesconto('VENDEDOR', VEND, 0);
r.v3 = linhaDesconto('VENDEDOR', VEND, 3);
r.v5 = linhaDesconto('VENDEDOR', VEND, 5);
r.v6 = linhaDesconto('VENDEDOR', VEND, 6);
r.g5 = linhaDesconto('GERENTE', GER, 5);
r.g15 = linhaDesconto('GERENTE', GER, 15);
r.g16 = linhaDesconto('GERENTE', GER, 16);
r.a30 = linhaDesconto('ADMIN', ADM, 30, 25);

t('1.5-a vendedor 0% e 3% aplicam direto (dentro da alçada)', () => {
  assert(r.v0.alc.liberado && r.v3.alc.liberado, 'barrou');
  assert(r.v3.calc.aplicado === 15 && r.v3.total === 485, `desc=${r.v3.calc.aplicado} total=${r.v3.total}`);
});
t('1.5-b vendedor 5% (no limite) aplica direto', () => {
  assert(r.v5.alc.liberado, 'barrou o limite exato');
  assert(r.v5.calc.aplicado === 25 && r.v5.total === 475, `desc=${r.v5.calc.aplicado} total=${r.v5.total}`);
});
t('1.5-c vendedor 6% exige aprovação do GERENTE', () => {
  assert(!r.v6.alc.liberado && r.v6.alc.status === 'pendente', JSON.stringify(r.v6.alc));
  assert(r.v6.alc.regra.papelAprovador === 'gerente-comercial', 'papel=' + r.v6.alc.regra.papelAprovador);
  assert(r.v6.total === 500, 'total nao deveria ter desconto: ' + r.v6.total);
});
t('1.5-d gerente 5% e 15% aplicam direto (própria autoridade)', () => {
  assert(r.g5.alc.liberado && r.g15.alc.liberado, JSON.stringify([r.g5.alc, r.g15.alc]));
  assert(r.g15.alc.autoridade === 'propria', 'autoridade=' + r.g15.alc.autoridade);
  assert(r.g15.calc.aplicado === 75 && r.g15.total === 425, `desc=${r.g15.calc.aplicado} total=${r.g15.total}`);
});
t('1.5-e gerente 16% exige nível superior (admin)', () => {
  assert(!r.g16.alc.liberado, 'gerente passou acima da própria alçada');
  assert(r.g16.alc.regra.papelAprovador === 'admin', 'papel=' + r.g16.alc.regra.papelAprovador);
});
t('1.5-f admin aplica direto, com frete somando', () => {
  assert(r.a30.alc.liberado, 'admin barrado');
  assert(r.a30.calc.aplicado === 150 && r.a30.total === 375, `desc=${r.a30.calc.aplicado} total=${r.a30.total} (500-150+25)`);
});
t('1.5-g desconto não alterou o preço de nenhum item', () => {
  const precos = db.prepare(`SELECT DISTINCT precoUnitario FROM pedido_itens WHERE produtoId=?`).all(P100);
  assert(precos.length === 1 && precos[0].precoUnitario === 100, JSON.stringify(precos));
});

// ══════════════ FASE 1.6 — TIPO DE ATENDIMENTO ══════════════
titulo('FASE 1.6 — tipo de atendimento');

const ATEND = ['no_local', 'retirada', 'entrega'];
const exigeAtendimento = (tipo) => ['pdv', 'catalogo'].includes(tipo);
const enderecoCompleto = (p) => !!(p.enderecoEntrega && p.cidadeEntrega && p.ufEntrega);
/** A regra aprovada, aplicada sobre o pedido já gravado. */
const validarAtendimento = (ped) => {
  if (exigeAtendimento(ped.tipo) && !ped.tipoAtendimento) {
    return `pedido de origem "${ped.tipo}" exige tipoAtendimento`;
  }
  if (ped.tipoAtendimento && !ATEND.includes(ped.tipoAtendimento)) return 'tipoAtendimento invalido';
  if (ped.tipoAtendimento === 'entrega' && !enderecoCompleto(ped)) return 'entrega exige endereco';
  if (!ped.clienteId) return 'cliente obrigatorio';
  return null;
};
const comAtendimento = (ator, origem, modo, comEndereco = false) => {
  const p = pedidoDe(ator, CLI_CPF, 1, origem);
  if (modo) db.prepare('UPDATE pedidos SET tipoAtendimento=? WHERE id=?').run(modo, p.id);
  if (comEndereco) {
    chamar('/api/pedidos/:id', 'put', { ...ator, params: { id: p.id }, body: {
      enderecoEntrega: 'Rua do Sandbox, 1', bairroEntrega: 'Centro', cidadeEntrega: 'São Paulo',
      ufEntrega: 'SP', cepEntrega: '01000000', valorFrete: 12 } });
  }
  return db.prepare('SELECT * FROM pedidos WHERE id=?').get(p.id);
};

console.log('\n  origem     atendimento   endereço   resultado');
console.log('  ' + '─'.repeat(64));
const casoAtend = (origem, modo, comEnd) => {
  const ped = comAtendimento(VEND, origem, modo, comEnd);
  const erro = validarAtendimento(ped);
  console.log(`  ${origem.padEnd(10)} ${String(modo || '(nenhum)').padEnd(13)} ${(comEnd ? 'sim' : 'não').padEnd(10)} ${erro ? 'RECUSA: ' + erro : 'aceita'}`);
  return erro;
};
const at = {};
at.pdvLocal    = casoAtend('pdv', 'no_local', false);
at.pdvRetirada = casoAtend('pdv', 'retirada', false);
at.pdvEntrega  = casoAtend('pdv', 'entrega', true);
at.catRetirada = casoAtend('manual', 'retirada', false);     // catálogo não é declarável pelo corpo
at.catEntrega  = casoAtend('manual', 'entrega', true);
at.pdvSem      = casoAtend('pdv', null, false);
at.entregaSemEnd = casoAtend('pdv', 'entrega', false);
at.erpNull     = casoAtend('manual', null, false);

t('1.6-a PDV com no_local / retirada / entrega+endereço: aceitos', () => {
  assert(!at.pdvLocal && !at.pdvRetirada && !at.pdvEntrega, JSON.stringify(at));
});
t('1.6-b catálogo com retirada e entrega: aceitos', () => {
  assert(!at.catRetirada && !at.catEntrega, JSON.stringify([at.catRetirada, at.catEntrega]));
});
t('1.6-c PDV SEM tipoAtendimento: recusado', () => assert(/exige tipoAtendimento/.test(at.pdvSem || ''), 'passou'));
t('1.6-d ENTREGA sem endereço: recusada', () => assert(/exige endereco/.test(at.entregaSemEnd || ''), 'passou'));
t('1.6-e ERP manual com tipoAtendimento NULL: continua válido', () => {
  assert(at.erpNull === null, 'recusou pedido legado: ' + at.erpNull);
});
t('1.6-f pedido de catálogo nasce tipo=catalogo pelo caminho interno', () => {
  // Número único por execução: o catálogo grava direto (loja-routes), sem
  // passar pelo gerador de número do pedido comercial.
  const n = () => 'SBX-CAT-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const id = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, origemLoja, tipoAtendimento)
    VALUES (?,'catalogo','pedido',?,'rascunho',date('now'),1,'retirada')`).run(n(), CLI_CPF).lastInsertRowid;
  const p = db.prepare('SELECT * FROM pedidos WHERE id=?').get(id);
  assert(p.tipo === 'catalogo' && validarAtendimento(p) === null, JSON.stringify(p.tipo));
  const semAt = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, origemLoja)
    VALUES (?,'catalogo','pedido',?,'rascunho',date('now'),1)`).run(n(), CLI_CPF).lastInsertRowid;
  assert(/exige tipoAtendimento/.test(validarAtendimento(db.prepare('SELECT * FROM pedidos WHERE id=?').get(semAt)) || ''),
    'catálogo sem atendimento passou');
});

// ══════════════ FASE 1.7 — PESSOA SEM DOCUMENTO ══════════════
titulo('FASE 1.7 — pessoa sem documento');

const buscaPessoas = (q) => {
  const h = achar('/api/pessoas', 'get');
  let out = null;
  h({ query: { q }, params: {}, body: {}, session: {}, user: ADM.user, headers: {} },
    { json: x => { out = x; }, status: () => ({ json: x => { out = x; } }) });
  return out.pessoas || [];
};

t('1.7-a cadastro sem documento existe, com semDocumento=1', () => {
  const p = db.prepare('SELECT * FROM pessoas WHERE id=?').get(CLI_SEMDOC);
  assert(p.semDocumento === 1 && p.cpfCnpj.startsWith('SD-'), JSON.stringify({ s: p.semDocumento, c: p.cpfCnpj }));
});
t('1.7-b UNIQUE continua valendo (identificador repetido é barrado)', () => {
  let barrou = false;
  try { db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, ativo) VALUES (?, 'PF', 'Clone', 1)`).run(IDSD); }
  catch (e) { barrou = /UNIQUE/i.test(e.message); }
  assert(barrou, 'aceitou identificador duplicado');
});
t('1.7-c busca por NOME encontra', () => assert(buscaPessoas('Diego').some(p => p.id === CLI_SEMDOC), 'nao achou'));
t('1.7-d busca por TELEFONE encontra', () => assert(buscaPessoas('11955556666').some(p => p.id === CLI_SEMDOC), 'nao achou'));
t('1.7-e telefone repetido devolve as DUAS pessoas, sem fundir', () => {
  const achados = buscaPessoas('11933334444');
  assert(achados.length === 2, 'esperava 2, veio ' + achados.length);
  assert(db.prepare('SELECT COUNT(*) n FROM pessoas WHERE id IN (?,?) AND ativo=1').get(CLI_TEL_A, CLI_TEL_B).n === 2,
    'alguma pessoa foi mesclada ou inativada');
});
t('1.7-f pessoa sem documento pode ser usada em pedido', () => {
  const p = pedidoDe(VEND, CLI_SEMDOC, 2, 'pdv');
  assert(p.clienteId === CLI_SEMDOC, 'clienteId=' + p.clienteId);
  db.prepare("UPDATE pedidos SET tipoAtendimento='retirada' WHERE id=?").run(p.id);
  const c = chamar('/api/pedidos/:id/confirmar', 'post', { ...VEND, params: { id: p.id }, body: {} });
  assert(c.out.success, 'não confirmou: ' + c.out.error);
});
t('1.7-g aparece na listagem de Clientes & Fornecedores como qualquer outro', () => {
  assert(buscaPessoas('Diego').length === 1, 'sumiu da listagem');
});

// --- caminho fiscal ---
t('1.7-h documentoFiscalDe() devolve AUSENTE para semDocumento=1', () => {
  const p = db.prepare('SELECT * FROM pessoas WHERE id=?').get(CLI_SEMDOC);
  assert(semDoc.documentoFiscalDe(p) === null, 'devolveu documento');
  assert(semDoc.rotuloDocumento(p) === 'sem documento', 'rotulo errado');
  const comDoc = db.prepare('SELECT * FROM pessoas WHERE id=?').get(CLI_CPF);
  assert(semDoc.documentoFiscalDe(comDoc) === '11144477735', 'quebrou quem TEM documento');
});
t('1.7-i o identificador NUNCA vira CPF/CNPJ ao passar pela limpeza dos emissores', () => {
  // É esta a limpeza que nfe-emit-routes.js:521, nfse-routes.js:332 e
  // nfce-routes.js:294 fazem. Nenhum resultado pode ter 11 ou 14 dígitos.
  for (let i = 0; i < 5000; i++) {
    const n = semDoc.gerarIdentificadorSemDocumento().replace(/\D/g, '').length;
    assert(n !== 11 && n !== 14, `gerou identificador que vira documento de ${n} digitos`);
  }
});

// ══════════════ FASE 1.8 — PEDIDO → FATURA ══════════════
titulo('FASE 1.8 — pedido → fatura');

const faturarPedido = (pedidoId, body = {}) => {
  const h = achar('/api/pedidos/:id/faturar', 'post');
  let out = null, st = 200;
  h({ params: { id: pedidoId }, query: {}, body, session: ADM.session, user: ADM.user, headers: {}, ip: '127.0.0.1' },
    { json: x => { out = x; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
};
const pedidoFaturavel = (descontoAplicado) => {
  const p = pedidoDe(ADM, CLI_CNPJ, 5, 'manual');      // 5 × 100 = 500
  if (descontoAplicado != null) {
    db.prepare('UPDATE pedidos SET descontoTipo=?, descontoValor=?, descontoAplicado=? WHERE id=?')
      .run('valor', descontoAplicado, descontoAplicado, p.id);
  }
  chamar('/api/pedidos/:id/confirmar', 'post', { ...ADM, params: { id: p.id }, body: {} });
  chamar('/api/pedidos/:id/entregar', 'post', { ...ADM, params: { id: p.id }, body: {} });
  return p;
};
const ultimaFatura = (pedidoId) => db.prepare('SELECT * FROM faturas WHERE pedidoId=? ORDER BY id DESC LIMIT 1').get(pedidoId);

console.log('\n  caso                              bruto   desconto      total   origem do desconto');
console.log('  ' + '─'.repeat(76));
t('1.8-a fatura HERDA o desconto do pedido (500 − 50 = 450)', () => {
  const p = pedidoFaturavel(50);
  const r2 = faturarPedido(p.id, {});
  assert(r2.out && r2.out.success, JSON.stringify(r2));
  const f = ultimaFatura(p.id);
  console.log(`  herdado (corpo sem desconto)   ${f.valorBruto.toFixed(2).padStart(9)}  ${f.valorDesconto.toFixed(2).padStart(9)}  ${f.valorTotal.toFixed(2).padStart(9)}   pedido`);
  assert(f.valorBruto === 500 && f.valorDesconto === 50 && f.valorTotal === 450,
    `bruto=${f.valorBruto} desc=${f.valorDesconto} total=${f.valorTotal}`);
});
t('1.8-b desconto manual SUBSTITUI o herdado — nunca soma', () => {
  const p = pedidoFaturavel(50);
  faturarPedido(p.id, { valorDesconto: 80 });
  const f = ultimaFatura(p.id);
  console.log(`  manual 80 (pedido tinha 50)    ${f.valorBruto.toFixed(2).padStart(9)}  ${f.valorDesconto.toFixed(2).padStart(9)}  ${f.valorTotal.toFixed(2).padStart(9)}   corpo (substitui)`);
  assert(f.valorDesconto === 80, `desconto=${f.valorDesconto} — 130 seria SOMA, e é o que não pode`);
  assert(f.valorTotal === 420, 'total=' + f.valorTotal);
});
t('1.8-c corpo com desconto ZERO fatura sem desconto', () => {
  const p = pedidoFaturavel(50);
  faturarPedido(p.id, { valorDesconto: 0 });
  const f = ultimaFatura(p.id);
  console.log(`  manual 0 (pedido tinha 50)     ${f.valorBruto.toFixed(2).padStart(9)}  ${f.valorDesconto.toFixed(2).padStart(9)}  ${f.valorTotal.toFixed(2).padStart(9)}   corpo (zero explícito)`);
  assert(f.valorDesconto === 0 && f.valorTotal === 500, `desc=${f.valorDesconto} total=${f.valorTotal}`);
});
t('1.8-d pedido sem desconto fatura como sempre', () => {
  const p = pedidoFaturavel(null);
  faturarPedido(p.id, {});
  const f = ultimaFatura(p.id);
  console.log(`  sem desconto                   ${f.valorBruto.toFixed(2).padStart(9)}  ${(f.valorDesconto || 0).toFixed(2).padStart(9)}  ${f.valorTotal.toFixed(2).padStart(9)}   —`);
  assert((f.valorDesconto || 0) === 0 && f.valorTotal === 500, `desc=${f.valorDesconto} total=${f.valorTotal}`);
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
