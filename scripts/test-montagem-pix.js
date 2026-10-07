/**
 * Monte seu buquê, adicionais e Pix da loja, em banco descartável (2026-09-29).
 *
 * O Asaas é um servidor falso no lugar do `fetch` global: o código de produção
 * (boleto-provedores/asaas.js) monta as mesmas chamadas, e o falso responde
 * como a API v3 responde. Nenhuma chamada sai desta máquina.
 *
 * O que cada bloco guarda, e o defeito que reprovaria se voltasse:
 *
 *   M. MONTAGEM — preço da tabela e não multiplicado; quantidade fora da
 *      tabela e cone com 4 rosas recusados; cor sem estoque apagada; mix em
 *      rodízio; cada rosa e o papel baixando do estoque certo, com custo.
 *   P. PIX — CPF exigido; o Pix nasce no checkout da retirada; o aviso do
 *      Asaas deixa o pedido pago, e com token errado não deixa; entrega a
 *      combinar entra sem cobrança e a loja lança a taxa; o Pix trocado cancela
 *      o anterior, e o já pago não é cancelado; falha do provedor não perde o
 *      pedido nem duplica conta a receber.
 *   L. LOJA SEM PROVEDOR — o checkout continua como era.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };
const perto = (a, b, m) => assert(Math.abs(Number(a) - Number(b)) < 0.005, `${m}: esperado ${b}, veio ${a}`);

/* ───────────── Asaas falso ───────────── */
const ASAAS = { pagamentos: new Map(), chamadas: [], falhar: false, seq: 0 };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const fetchReal = global.fetch;
global.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host !== 'api-sandbox.asaas.com') throw new Error('chamada externa na suíte: ' + url);
  const metodo = init.method || 'GET';
  const corpo = init.body ? JSON.parse(init.body) : null;
  ASAAS.chamadas.push({ metodo, caminho: u.pathname + u.search, corpo, token: init.headers && init.headers.access_token });
  const resp = (status, obj) => ({ ok: status < 300, status, statusText: String(status), text: async () => JSON.stringify(obj) });
  if (ASAAS.falhar) return resp(500, { errors: [{ description: 'indisponível' }] });
  const p = u.pathname.replace('/v3', '');
  if (metodo === 'GET' && p === '/customers') return resp(200, { data: [] });
  if (metodo === 'POST' && p === '/customers') return resp(200, { id: 'cus_' + corpo.cpfCnpj });
  if (metodo === 'POST' && p === '/payments') {
    const id = 'pay_' + (++ASAAS.seq);
    ASAAS.pagamentos.set(id, { ...corpo, id, status: 'PENDING' });
    return resp(200, { id, status: 'PENDING', invoiceUrl: 'https://sandbox.asaas.com/i/' + id });
  }
  let m = /^\/payments\/(pay_\d+)\/pixQrCode$/.exec(p);
  if (m) return resp(200, { payload: '00020126PIX' + m[1], encodedImage: PNG, expirationDate: '2099-01-01 23:59:59' });
  m = /^\/payments\/(pay_\d+)$/.exec(p);
  if (m && metodo === 'GET') { const x = ASAAS.pagamentos.get(m[1]); return resp(x ? 200 : 404, x ? { ...x, value: x.value } : {}); }
  if (m && metodo === 'DELETE') { const x = ASAAS.pagamentos.get(m[1]); if (x) x.status = 'DELETED'; return resp(200, { deleted: true, id: m[1] }); }
  return resp(404, { errors: [{ description: 'rota desconhecida no falso: ' + p }] });
};

/* ───────────── banco ───────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'montagem-pix-'));
const SCHEMA = require('./schema-de-tenant').schemaDeTenant();
let seq = 0;
let MODELO = null;
function modelo() {
  if (MODELO) return MODELO;
  MODELO = path.join(tmp, 'modelo.db');
  const db = new Database(MODELO);
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA);
  require('../db-schema').initSchema(db);
  require('../loja-routes').migrarLojaDB(db);
  try { require('../tipos-operacao-routes').migrar(db); } catch (_) {}
  try { require('../precos-routes').migrarPrecosDB(db); } catch (_) {}
  try { require('../contas-financeiras-routes').migrarDB?.(db); } catch (_) {}
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL, caminho TEXT, ordem INTEGER DEFAULT 0)`);
  db.pragma('journal_mode = DELETE');
  db.close();
  return MODELO;
}

/* Produtos: 1 vermelha, 2 cor-de-rosa, 3 branca, 4 papel, 5 papel de cone,
   6 fita, 7 girassol, 8 Ferrero 8 un, 9 buquê de rosas (montável),
   10 girassóis (montável). */
function montar({ provedor = true, frete = 'combinar' } = {}) {
  const arq = path.join(tmp, `m${++seq}.db`);
  fs.copyFileSync(modelo(), arq);
  const db = new Database(arq);
  db.pragma('foreign_keys = ON');
  const ins = db.prepare(`INSERT INTO produtos (sku, descricao, categoria, ativo, publicadoNaLoja, precoVenda, precoCusto)
    VALUES (?,?,?,1,?,?,?)`);
  ins.run('R-VERM', 'Rosa vermelha', 'Flores', 0, 0, 4);
  ins.run('R-ROSA', 'Rosa cor-de-rosa', 'Flores', 0, 0, 4);
  ins.run('R-BRAN', 'Rosa branca', 'Flores', 0, 0, 4.5);
  ins.run('PAPEL', 'Papel de embalagem', 'Insumos', 0, 0, 3);
  ins.run('CONE', 'Papel para cone', 'Insumos', 0, 0, 2);
  ins.run('FITA', 'Fita de cetim', 'Insumos', 0, 0, 1.5);
  ins.run('GIRA', 'Girassol', 'Flores', 0, 0, 6);
  ins.run('FERR8', 'Ferrero Rocher 8 un', 'Presentes', 0, 0, 30);
  ins.run('BQ-ROSAS', 'Buquê de rosas', 'Monte seu buquê', 1, 0, 0);
  ins.run('BQ-GIRA', 'Girassóis', 'Monte seu buquê', 1, 0, 0);
  const mov = db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, data)
    VALUES (?, 'entrada', ?, ?, date('now'))`);
  mov.run(1, 30, 4); mov.run(2, 30, 4); mov.run(3, 0.0001, 4.5);   // branca: praticamente zerada
  db.prepare("INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, data) VALUES (3, 'saida', 0.0001, date('now'))").run();
  mov.run(4, 50, 3); mov.run(5, 50, 2); mov.run(6, 50, 1.5); mov.run(7, 40, 6); mov.run(8, 10, 30);

  const { gravarMontavel } = require('../loja-montagem');
  gravarMontavel(db, 9, {
    unidade: 'rosa', plural: 'rosas',
    formatos: [
      { nome: 'Avulsa', precos: [{ quantidade: 1, preco: 20 }], insumos: [] },
      { nome: 'Cone', precos: [{ quantidade: 1, preco: 55 }, { quantidade: 2, preco: 75 }, { quantidade: 3, preco: 100 }],
        insumos: [{ insumoProdutoId: 5, quantidade: 1 }] },
      { nome: 'Buquê', precos: [4, 5, 6, 7, 12].map((q, i) => ({ quantidade: q, preco: [135, 155, 175, 189.9, 250][i] })),
        insumos: [{ insumoProdutoId: 4, quantidade: 1 }, { insumoProdutoId: 6, quantidade: 1 }] },
    ],
    cores: [
      { nome: 'Vermelha', corHex: '#c6284e', insumoProdutoId: 1 },
      { nome: 'Cor-de-rosa', corHex: '#e57b9b', insumoProdutoId: 2 },
      { nome: 'Branca', corHex: '#fff7f2', insumoProdutoId: 3 },
      { nome: 'Mix', mix: true },
    ],
  });
  gravarMontavel(db, 10, {
    unidade: 'girassol', plural: 'girassóis',
    formatos: [{ nome: 'Buquê', precos: [{ quantidade: 1, preco: 64.9 }, { quantidade: 3, preco: 130 }],
      insumos: [{ insumoProdutoId: 4, quantidade: 1 }] }],
    cores: [{ nome: 'Girassol', corHex: '#f7c51e', insumoProdutoId: 7 }],
  });
  // Adicionais: Ferrero (baixa o item 8) e a mensagem do cartão (texto).
  const g1 = db.prepare("INSERT INTO rest_grupos_opcao (nome, minEscolhas, maxEscolhas, ativo, tipo) VALUES ('Bombom Ferrero Rocher', 0, 1, 1, 'escolha')").run().lastInsertRowid;
  const o1 = db.prepare('INSERT INTO rest_opcoes (grupoId, nome, precoAdicional, ativo, insumoProdutoId, quantidadeInsumo) VALUES (?, ?, 55, 1, 8, 1)').run(g1, '8 unidades').lastInsertRowid;
  const g2 = db.prepare("INSERT INTO rest_grupos_opcao (nome, minEscolhas, maxEscolhas, ativo, tipo) VALUES ('Mensagem do cartão', 0, 1, 1, 'texto')").run().lastInsertRowid;
  for (const [g, o] of [[g1, 0], [g2, 1]]) db.prepare('INSERT INTO rest_produto_grupos (produtoId, grupoId, ordem) VALUES (9, ?, ?)').run(g, o);

  const nat = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = 'VDA-NORMAL' AND ativo = 1`).get()
    || db.prepare('SELECT id FROM tipos_operacao WHERE ativo = 1 AND usarEmPedido = 1 AND movimentaEstoque = 1 ORDER BY id LIMIT 1').get();
  db.prepare(`UPDATE loja_config SET ativa = 1, nome = 'CANTINHO PROVA', whatsapp = '94991769924',
      servicoRetirada = 1, servicoDelivery = 1, freteModo = ?, freteValor = 10, mostrarPreco = 1, mostrarEstoque = 1,
      pagamentoModo = 'pix', pagamentoVencimentoDias = 1, tipoOperacaoPedidoId = ? WHERE id = 1`).run(frete, nat.id);
  db.prepare("INSERT INTO rest_bairros_taxa (nome, taxa, ativo) VALUES ('Nova Marabá', 8, 1)").run();

  if (provedor) {
    const conta = db.prepare("INSERT INTO contas_financeiras (nome, tipo) VALUES ('Asaas', 'banco')").run().lastInsertRowid;
    db.prepare(`INSERT INTO contas_financeiras_boleto (contaFinanceiraId, provedor, ambiente, ativo, ehPadrao, configJson)
      VALUES (?, 'asaas', 'homologacao', 1, 1, ?)`).run(conta, JSON.stringify({ accessToken: '$aact_hmlg_teste', webhookToken: 'tok-webhook' }));
  }

  /* `loja_metodos_pagamento` é a fonte do que o checkout aceita desde
     30/09, e ela nasce no boot traduzindo o `pagamentoModo`. Aqui o modelo
     é montado ANTES de o `pagamentoModo` e a conta Asaas serem gravados, e
     a tabela já ficaria com os manuais — o Pix do checkout nunca sairia.
     Refazer a migração reproduz o boot, que é o que esta suíte mede. */
  db.exec('DELETE FROM loja_metodos_pagamento');
  require('../loja-metodos-pagamento').migrarMetodos(db);

  return { db, grupos: { ferrero: g1, ferrero8: o1, mensagem: g2 } };
}

function montarApp(db) {
  const rotas = new Map();
  const reg = (m) => (url, ...fns) => rotas.set(m + ' ' + url, fns[fns.length - 1]);
  const app = {
    get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), use() {},
    async chamar(m, url, body, params) {
      const fn = rotas.get(m + ' ' + url);
      if (!fn) throw new Error('rota não registrada: ' + m + ' ' + url);
      let saida = null, status = 200;
      const res = { json: (d) => { saida = d; return res; }, status: (s) => { status = s; return res; },
                    set() { return res; }, setHeader() { return res; }, end() { return res; } };
      await fn({ body: body || {}, query: {}, params: params || {}, session: {}, headers: {}, protocol: 'https',
                 get: () => 'cantinho.local', tenant: { slug: 'prova' + seq } }, res);
      return { status, body: saida };
    },
  };
  require('../reservas-routes').registrarRotasReservas(app, db);
  require('../pedidos-routes').registrarRotasPedidos(app, db);
  require('../loja-routes').registrarRotasLojaPublica(app, db);
  require('../loja-routes').registrarRotasLojaAdmin(app, db);
  return app;
}

const FINALIZAR = '/loja/api/pedido/finalizar';
const CALC = '/loja/api/carrinho/calcular';
const CPF = '52998224725';
const buque = (extra) => ({ produtoId: 9, quantidade: 1, opcoes: [], textos: {}, ...extra });
const corpo = (extra) => ({
  idempotencyKey: crypto.randomUUID(),
  cliente: { nome: 'ANA FLOR', telefone: '94999887766', cpfCnpj: CPF },
  atendimento: 'retirada', pagamento: 'pix',
  itens: [buque({ montagem: { formatoId: formato(null, 'Buquê'), quantidade: 6, corId: cor(null, 'Vermelha') } })],
  ...extra,
});
let DB_ATUAL = null;
const formato = (db, nome) => (db || DB_ATUAL).prepare('SELECT id FROM loja_montavel_formatos WHERE produtoId = 9 AND nome = ?').get(nome).id;
const cor = (db, nome) => (db || DB_ATUAL).prepare('SELECT id FROM loja_montavel_cores WHERE produtoId = 9 AND nome = ?').get(nome).id;
const reservado = (db, id) => db.prepare(`SELECT COALESCE(SUM(quantidade),0) q FROM reservas_estoque
    WHERE produtoId = ? AND status = 'ativa'`).get(id).q;
const pedidoPorNumero = (db, n) => db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(n);
const webhook = (db, id, token, evento = 'PAYMENT_RECEIVED') => require('../boleto-orchestrator').processarWebhook(db, 'asaas', {
  body: { event: evento, payment: { id, value: ASAAS.pagamentos.get(id)?.value, paymentDate: '2026-09-29' } },
  headers: { 'asaas-access-token': token }, get: (h) => (h === 'asaas-access-token' ? token : undefined),
});
function novo(opts) {
  ASAAS.chamadas = []; ASAAS.falhar = false;
  const r = montar(opts);
  DB_ATUAL = r.db;
  return { ...r, app: montarApp(r.db) };
}

// ─────────────────────────── M. montagem ───────────────────────────
t('M1. vitrine: cor sem estoque sai apagada, girassol sem escolha, card com "a partir de"', async () => {
  const { app } = novo();
  const r = await app.chamar('GET', '/loja/api/montagem');
  const rosas = r.body.montaveis.find((m) => m.produtoId === 9);
  const branca = rosas.cores.find((c) => c.nome === 'Branca');
  assert(branca.quantidades.length === 0, 'branca sem estoque devia vir sem quantidades');
  assert(rosas.cores.find((c) => c.nome === 'Vermelha').quantidades.includes(12), 'vermelha fecha 12');
  const gira = r.body.montaveis.find((m) => m.produtoId === 10);
  assert(gira.cores.length === 1, 'girassol tem uma cor só');
  assert(!JSON.stringify(r.body).includes('"disponivel"'), 'saldo de estoque não pode ir à vitrine');
  const lista = await app.chamar('GET', '/loja/api/produtos');
  const card = lista.body.produtos.find((p) => p.id === 9);
  assert(card.montavel && card.preco === 20, `card do montável: ${JSON.stringify(card)}`);
});
t('M2. preço é o da tabela: 7 rosas = R$ 189,90, e não 7 × 20', async () => {
  const { app } = novo();
  const r = await app.chamar('POST', CALC, { itens: [buque({ precoUnitario: 1, montagem: { formatoId: formato(null, 'Buquê'), quantidade: 7, corId: cor(null, 'Vermelha') } })] });
  assert(r.status === 200, JSON.stringify(r.body));
  perto(r.body.total, 189.9, 'total de 7 rosas');
  assert(/Buquê, 7 rosas, Vermelha/.test(r.body.itens[0].descricao), r.body.itens[0].descricao);
});
t('M3. cone só existe de 1 a 3, e quantidade fora da tabela é recusada', async () => {
  const { app } = novo();
  const cone4 = await app.chamar('POST', CALC, { itens: [buque({ montagem: { formatoId: formato(null, 'Cone'), quantidade: 4, corId: cor(null, 'Vermelha') } })] });
  assert(cone4.status === 422, 'cone com 4 rosas devia ser recusado');
  const q13 = await app.chamar('POST', CALC, { itens: [buque({ montagem: { formatoId: formato(null, 'Buquê'), quantidade: 13, corId: cor(null, 'Vermelha') } })] });
  assert(q13.status === 422, '13 rosas não está na tabela');
  const cone3 = await app.chamar('POST', CALC, { itens: [buque({ montagem: { formatoId: formato(null, 'Cone'), quantidade: 3, corId: cor(null, 'Vermelha') } })] });
  perto(cone3.body.total, 100, 'cone de 3');
});
t('M4. cor sem estoque é recusada no servidor, mesmo forçada', async () => {
  const { app } = novo();
  const r = await app.chamar('POST', CALC, { itens: [buque({ montagem: { formatoId: formato(null, 'Buquê'), quantidade: 4, corId: cor(null, 'Branca') } })] });
  assert(r.status === 422 && /branca/i.test(r.body.error), JSON.stringify(r.body));
});
t('M5. mix reparte em rodízio entre as cores com estoque (5 → 3 vermelhas + 2 cor-de-rosa)', async () => {
  const { db, app } = novo();
  const r = await app.chamar('POST', FINALIZAR, corpo({ itens: [buque({ montagem: { formatoId: formato(db, 'Buquê'), quantidade: 5, corId: cor(db, 'Mix') } })] }));
  assert(r.body.success, JSON.stringify(r.body));
  const ped = pedidoPorNumero(db, r.body.numero);
  const flores = db.prepare("SELECT insumoProdutoId id, quantidadeInsumo q FROM pedido_item_opcoes WHERE pedidoId = ? AND grupoNome = 'Flores' ORDER BY id").all(ped.id);
  const mapa = Object.fromEntries(flores.map((f) => [f.id, f.q]));
  assert(mapa[1] === 3 && mapa[2] === 2 && !mapa[3], `rodízio: ${JSON.stringify(mapa)}`);
  assert(reservado(db, 1) === 3 && reservado(db, 2) === 2, 'reserva das rosas do mix');
});
t('M6. pedido: rosas, papel, fita e Ferrero reservados; mensagem com o nome do grupo; data desejada', async () => {
  const { db, app, grupos } = novo();
  const amanha = new Date(Date.now() - 3 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  const r = await app.chamar('POST', FINALIZAR, corpo({ itens: [buque({
    opcoes: [grupos.ferrero8], textos: { [grupos.mensagem]: 'Feliz aniversário, mãe!' },
    montagem: { formatoId: formato(db, 'Buquê'), quantidade: 6, corId: cor(db, 'Vermelha'), dataDesejada: amanha } })] }));
  assert(r.body.success, JSON.stringify(r.body));
  perto(r.body.total, 175 + 55, 'buquê de 6 + Ferrero');
  const ped = pedidoPorNumero(db, r.body.numero);
  assert(ped.dataEntregaPrevista === amanha, `data desejada: ${ped.dataEntregaPrevista}`);
  const it = db.prepare('SELECT descricao FROM pedido_itens WHERE pedidoId = ?').get(ped.id);
  assert(it.descricao.includes('Mensagem do cartão: Feliz aniversário, mãe!'), it.descricao);
  assert(reservado(db, 1) === 6 && reservado(db, 4) === 1 && reservado(db, 6) === 1 && reservado(db, 8) === 1,
    `reservas: rosa ${reservado(db, 1)}, papel ${reservado(db, 4)}, fita ${reservado(db, 6)}, ferrero ${reservado(db, 8)}`);
  assert(reservado(db, 9) === 0, 'o montável em si não pode ser reservado');
});
t('M7. a baixa grava o custo de cada rosa e do papel', async () => {
  const { db, app } = novo();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPorNumero(db, r.body.numero);
  require('../reservas-routes').consumirReservasPedido(db, ped.id, new Date().toISOString().slice(0, 10));
  const saidas = db.prepare("SELECT produtoId, quantidade, custoMedioAnterior c FROM movimentacoes_estoque WHERE tipo = 'saida' AND produtoId IN (1, 4, 6) ORDER BY produtoId").all();
  const rosa = saidas.find((s) => s.produtoId === 1);
  assert(rosa && rosa.quantidade === 6, 'saída de 6 rosas vermelhas');
  perto(rosa.c, 4, 'custo da rosa na saída');
  perto(saidas.find((s) => s.produtoId === 4).c, 3, 'custo do papel na saída');
});
t('M8. montagem entra uma vez na sacola; girassol dispensa cor', async () => {
  const { app } = novo();
  const dois = await app.chamar('POST', CALC, { itens: [buque({ quantidade: 2, montagem: { formatoId: formato(null, 'Buquê'), quantidade: 4, corId: cor(null, 'Vermelha') } })] });
  assert(dois.status === 422, 'quantidade 2 de uma montagem devia ser recusada');
  const fg = DB_ATUAL.prepare('SELECT id FROM loja_montavel_formatos WHERE produtoId = 10').get().id;
  const g = await app.chamar('POST', CALC, { itens: [{ produtoId: 10, quantidade: 1, montagem: { formatoId: fg, quantidade: 3 } }] });
  assert(g.status === 200, JSON.stringify(g.body));
  perto(g.body.total, 130, '3 girassóis');
});
t('M9. painel: tabela com quantidade repetida e mix sem duas cores são recusados; ids preservados', async () => {
  const { db, app } = novo();
  const antes = formato(db, 'Cone');
  const cfg = require('../loja-montagem').lerMontavel(db, 9);
  const repetida = JSON.parse(JSON.stringify(cfg));
  repetida.formatos[1].precos.push({ quantidade: 2, preco: 80 });
  assert((await app.chamar('PUT', '/api/loja/montagem/:produtoId', repetida, { produtoId: 9 })).status === 400, 'quantidade repetida');
  const mixSo = JSON.parse(JSON.stringify(cfg));
  mixSo.cores = [mixSo.cores[0], mixSo.cores[3]];
  assert((await app.chamar('PUT', '/api/loja/montagem/:produtoId', mixSo, { produtoId: 9 })).status === 400, 'mix com uma cor só');
  const r = await app.chamar('PUT', '/api/loja/montagem/:produtoId', cfg, { produtoId: 9 });
  assert(r.status === 200 && formato(db, 'Cone') === antes, 'regravar a mesma configuração preserva o id do formato');
});

// ─────────────────────────── P. Pix ───────────────────────────
t('P1. com Pix no site, sem CPF e com dinheiro são recusados', async () => {
  const { app } = novo();
  const semCpf = await app.chamar('POST', FINALIZAR, corpo({ cliente: { nome: 'ANA', telefone: '94999887766' } }));
  assert(semCpf.status === 422 && /CPF/.test(semCpf.body.error), JSON.stringify(semCpf.body));
  const din = await app.chamar('POST', FINALIZAR, corpo({ pagamento: 'dinheiro' }));
  assert(din.status === 422, 'dinheiro com Pix no site');
  const cfg = await app.chamar('GET', '/loja/api/config');
  assert(cfg.body.loja.pixNoSite === true, 'config pública anuncia o Pix no site');
});
t('P2. retirada: o Pix nasce no checkout, no valor do pedido, e o link não expõe dado pessoal', async () => {
  const { db, app } = novo();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  assert(r.body.success && r.body.cobranca && r.body.cobranca.pix, JSON.stringify(r.body));
  const pay = [...ASAAS.pagamentos.values()].pop();
  assert(pay.billingType === 'PIX', 'cobrança Pix');
  perto(pay.value, 175, 'valor enviado ao Asaas');
  assert(ASAAS.chamadas.some((c) => c.caminho === '/v3/customers' && c.corpo.cpfCnpj === CPF), 'cliente com CPF no Asaas');
  assert(r.body.cobranca.pix.copiaECola.startsWith('00020126PIX'), 'copia e cola');
  const pg = await app.chamar('GET', '/loja/api/pagamento/:token', null, { token: r.body.link });
  const txt = JSON.stringify(pg.body);
  assert(pg.body.success && !/ANA FLOR|94999887766|52998224725/.test(txt), 'o link público vazou dado pessoal: ' + txt);
  const ped = pedidoPorNumero(db, r.body.numero);
  assert(ped.statusPagamento !== 'pago', 'ainda não pago');
});
t('P3. aviso do Asaas com o token certo deixa o pedido pago, e a baixa entra como Pix', async () => {
  const { db, app } = novo();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const id = [...ASAAS.pagamentos.keys()].pop();
  const w = await webhook(db, id, 'tok-webhook');
  /* Desde 07/10/2026 o webhook responde a MESMA coisa em todos os casos, para
     a URL não virar oráculo de `pay_id` (ver `boleto-orchestrator`). O que
     prova que o aviso foi aplicado é o EFEITO, medido logo abaixo, e não o
     retorno — que antes trazia `contaReceberId` e `boletoId` a quem postou. */
  assert(w && Object.keys(w).length === 0, 'a resposta do webhook devia ser neutra: ' + JSON.stringify(w));
  const ped = pedidoPorNumero(db, r.body.numero);
  assert(ped.statusPagamento === 'pago', `statusPagamento: ${ped.statusPagamento}`);
  const baixa = db.prepare(`SELECT crp.formaPagamento FROM contas_receber_pagamentos crp
    JOIN contas_a_receber cr ON cr.id = crp.contaReceberId WHERE cr.pedidoId = ?`).get(ped.id);
  assert(baixa && baixa.formaPagamento === 'pix', `forma da baixa: ${baixa && baixa.formaPagamento}`);
  const pg = await app.chamar('GET', '/loja/api/pagamento/:token', null, { token: r.body.link });
  assert(pg.body.pagamento.pago === true, 'a página de pagamento mostra pago');
  const tela = await app.chamar('GET', '/api/pedidos/:id/pix', null, { id: ped.id });
  assert(tela.body.estado.pago === true, 'a tela do pedido mostra pago');
});
t('P4. aviso com token errado não mexe em nada', async () => {
  const { db, app } = novo();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const id = [...ASAAS.pagamentos.keys()].pop();
  const w = await webhook(db, id, 'outro-token');
  // Mesma resposta do caso aceito: de fora, recusa e sucesso são indistinguíveis.
  assert(w && Object.keys(w).length === 0, 'a resposta devia ser neutra: ' + JSON.stringify(w));
  assert(pedidoPorNumero(db, r.body.numero).statusPagamento !== 'pago', 'não pode virar pago');
});
t('P5. o mesmo checkout reenviado devolve o mesmo pedido, sem segundo Pix', async () => {
  const { db, app } = novo();
  const c = corpo();
  const a = await app.chamar('POST', FINALIZAR, c);
  const n = ASAAS.pagamentos.size;
  const b = await app.chamar('POST', FINALIZAR, c);
  assert(b.body.repetido && b.body.numero === a.body.numero && b.body.link === a.body.link, JSON.stringify(b.body));
  assert(ASAAS.pagamentos.size === n, 'reenvio criou outro Pix');
  assert(b.body.cobranca.pix, 'o reenvio devolve o Pix');
  assert(db.prepare('SELECT COUNT(*) n FROM pedidos').get().n === 1, 'um pedido só');
});
t('P6. entrega a combinar: entra sem cobrança; a loja lança a taxa e o Pix sai no total', async () => {
  const { db, app } = novo();
  const r = await app.chamar('POST', FINALIZAR, corpo({ atendimento: 'entrega',
    endereco: { logradouro: 'Rua das Flores', numero: '10', bairro: 'Cidade Nova', cidade: 'Marabá', uf: 'PA' } }));
  assert(r.body.success && r.body.freteACombinar && !r.body.cobranca.pix, JSON.stringify(r.body));
  assert(ASAAS.pagamentos.size === 0 || ![...ASAAS.chamadas].some((x) => x.metodo === 'POST' && x.caminho === '/v3/payments'), 'não podia cobrar');
  const ped = pedidoPorNumero(db, r.body.numero);
  const sem = await app.chamar('POST', '/api/pedidos/:id/pix', {}, { id: ped.id });
  assert(sem.status === 422, 'gerar sem taxa devia ser recusado');
  const com = await app.chamar('POST', '/api/pedidos/:id/pix', { taxaEntrega: '12,50' }, { id: ped.id });
  assert(com.body.success, JSON.stringify(com.body));
  perto(com.body.estado.total, 187.5, 'total com a taxa');
  perto([...ASAAS.pagamentos.values()].pop().value, 187.5, 'Pix no total');
  assert(com.body.estado.aCombinar === false && com.body.token, 'deixa de estar a combinar e tem link');
});
t('P7. trocar a taxa cancela o Pix anterior; Pix já pago não é cancelado', async () => {
  const { db, app } = novo();
  const r = await app.chamar('POST', FINALIZAR, corpo({ atendimento: 'entrega',
    endereco: { logradouro: 'Rua A', numero: '1', bairro: 'B', cidade: 'Marabá', uf: 'PA' } }));
  const ped = pedidoPorNumero(db, r.body.numero);
  await app.chamar('POST', '/api/pedidos/:id/pix', { taxaEntrega: 10 }, { id: ped.id });
  const primeiro = [...ASAAS.pagamentos.keys()].pop();
  await app.chamar('POST', '/api/pedidos/:id/pix', { taxaEntrega: 15 }, { id: ped.id });
  assert(ASAAS.pagamentos.get(primeiro).status === 'DELETED', 'o Pix anterior devia ser cancelado no Asaas');
  const crs = db.prepare('SELECT status, valor FROM contas_a_receber WHERE pedidoId = ? ORDER BY id').all(ped.id);
  assert(crs.length === 2 && crs[0].status === 'cancelada' && crs[1].valor === 190, JSON.stringify(crs));
  const segundo = [...ASAAS.pagamentos.keys()].pop();
  ASAAS.pagamentos.get(segundo).status = 'RECEIVED';
  const troca = await app.chamar('POST', '/api/pedidos/:id/pix', { taxaEntrega: 20 }, { id: ped.id });
  assert(troca.status === 409, `Pix pago não pode ser trocado: ${troca.status}`);
});
t('P8. frete por bairro: a taxa entra no Pix do checkout', async () => {
  const { db, app } = novo({ frete: 'bairro' });
  const r = await app.chamar('POST', FINALIZAR, corpo({ atendimento: 'entrega',
    endereco: { logradouro: 'Rua A', numero: '1', bairro: 'Nova Marabá', cidade: 'Marabá', uf: 'PA' } }));
  assert(r.body.success && !r.body.freteACombinar, JSON.stringify(r.body));
  perto([...ASAAS.pagamentos.values()].pop().value, 183, 'buquê 175 + bairro 8');
  assert(pedidoPorNumero(db, r.body.numero).valorFrete === 8, 'frete gravado');
});
t('P9. falha do Asaas no checkout não perde o pedido; gerar de novo não duplica conta a receber', async () => {
  const { db, app } = novo();
  ASAAS.falhar = true;
  const r = await app.chamar('POST', FINALIZAR, corpo());
  assert(r.body.success && r.body.pixFalhou, JSON.stringify(r.body));
  ASAAS.falhar = false;
  const ped = pedidoPorNumero(db, r.body.numero);
  const g = await app.chamar('POST', '/api/pedidos/:id/pix', {}, { id: ped.id });
  assert(g.body.success && g.body.estado.pix, JSON.stringify(g.body));
  const n = db.prepare("SELECT COUNT(*) n FROM contas_a_receber WHERE pedidoId = ? AND status != 'cancelada'").get(ped.id).n;
  assert(n === 1, `contas a receber abertas: ${n}`);
});
t('P10. cliente sem CPF: a tela do pedido recusa com o motivo', async () => {
  const { db, app } = novo({ provedor: false });
  const r = await app.chamar('POST', FINALIZAR, corpo({ cliente: { nome: 'SEM DOC', telefone: '94999887766' }, pagamento: 'dinheiro' }));
  assert(r.body.success, JSON.stringify(r.body));
  const conta = db.prepare("INSERT INTO contas_financeiras (nome, tipo) VALUES ('Asaas', 'banco')").run().lastInsertRowid;
  db.prepare(`INSERT INTO contas_financeiras_boleto (contaFinanceiraId, provedor, ambiente, ativo, ehPadrao, configJson)
    VALUES (?, 'asaas', 'homologacao', 1, 1, '{"accessToken":"$aact_hmlg_x","webhookToken":"tok-webhook"}')`).run(conta);
  /* O `webhookToken` entrou em 07/10: sem ele a conta deixou de ser provedor
     pronto para cobrança online, e a recusa que sai é a da segurança, não a do
     CPF. O que este caso mede é a falta do CPF, então o cenário precisa ser
     seguro em tudo o mais. */
  const ped = pedidoPorNumero(db, r.body.numero);
  const g = await app.chamar('POST', '/api/pedidos/:id/pix', {}, { id: ped.id });
  assert(g.status === 422 && /CPF/.test(g.body.error), JSON.stringify(g.body));
});

// ─────────────────────────── L. loja sem provedor ───────────────────────────
t('L1. sem provedor, o checkout aceita dinheiro, não exige CPF e não cria conta a receber', async () => {
  const { db, app } = novo({ provedor: false, frete: 'gratis' });
  const cfg = await app.chamar('GET', '/loja/api/config');
  assert(cfg.body.loja.pixNoSite === false, 'sem provedor não há Pix no site');
  const r = await app.chamar('POST', FINALIZAR, corpo({ cliente: { nome: 'ANA', telefone: '94999887766' }, pagamento: 'dinheiro' }));
  assert(r.body.success && !r.body.cobranca, JSON.stringify(r.body));
  assert(db.prepare('SELECT COUNT(*) n FROM contas_a_receber').get().n === 0, 'nenhuma conta a receber');
  assert(ASAAS.chamadas.length === 0, 'nenhuma chamada ao provedor');
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); ok++; console.log('  ok   ' + nome); }
    catch (e) { fail++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
  }
  global.fetch = fetchReal;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
