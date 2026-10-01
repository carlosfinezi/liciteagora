/**
 * Métodos de pagamento do Catálogo Online, em banco descartável (2026-09-30).
 *
 * O que esta suíte guarda, e o defeito que reprovaria se voltasse:
 *
 *   A. MIGRAÇÃO — os quatro valores de `pagamentoModo` viram os métodos que
 *      o checkout antigo oferecia, e NADA além disso. Nenhuma loja passa a
 *      cobrar online por causa da migração. Rodar de novo não reescreve a
 *      escolha do lojista, e método novo no catálogo nasce desligado.
 *   B. CONFIGURAÇÃO — entrega e retirada separadas; `cartao_online` não
 *      ativa nem por requisição direta.
 *   C. CHECKOUT — o que aparece sai do servidor, por atendimento, e online
 *      sem provedor não aparece.
 *   D. VALIDAÇÃO — método desligado, incompatível com o atendimento ou
 *      inventado é recusado ANTES de criar pessoa, pedido ou reserva. O
 *      código fiscal vem do servidor, nunca do corpo da requisição.
 *   E. PIX ONLINE × PIX MANUAL — mesmo tPag 17, e só o online gera cobrança.
 *   F. DINHEIRO — o troco estruturado continua, e só em dinheiro.
 *   G. CÓDIGO FISCAL — crédito 03, débito 04, boleto 15.
 *   H. PEDIDO ANTIGO — `metodoPagamento` NULL continua válido.
 *   I. CONTA A RECEBER — o faturamento do pedido pago por Pix continua
 *      gerando uma só.
 *
 * O Asaas é um servidor falso no lugar do `fetch` global. Nenhuma chamada sai
 * desta máquina, e nenhuma cobrança real é criada.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

/* ───────────── Asaas falso ───────────── */
const ASAAS = { pagamentos: new Map(), chamadas: [], seq: 0 };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
global.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host !== 'api-sandbox.asaas.com') throw new Error('chamada externa na suíte: ' + url);
  const metodo = init.method || 'GET';
  const corpo = init.body ? JSON.parse(init.body) : null;
  ASAAS.chamadas.push({ metodo, caminho: u.pathname, corpo });
  const resp = (s, o) => ({ ok: s < 300, status: s, statusText: String(s), text: async () => JSON.stringify(o) });
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
  if (m && metodo === 'GET') { const x = ASAAS.pagamentos.get(m[1]); return resp(x ? 200 : 404, x || {}); }
  if (m && metodo === 'DELETE') { const x = ASAAS.pagamentos.get(m[1]); if (x) x.status = 'DELETED'; return resp(200, { deleted: true }); }
  return resp(404, { errors: [{ description: 'rota desconhecida: ' + p }] });
};

/* ───────────── banco ───────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metodos-pag-'));
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
  for (const m of ['tipos-operacao-routes', 'precos-routes', 'contas-financeiras-routes']) {
    try { const x = require('../' + m); (x.migrar || x.migrarPrecosDB || x.migrarDB || (() => {}))(db); } catch (_) {}
  }
  db.pragma('journal_mode = DELETE');
  db.close();
  return MODELO;
}

const metodos = require('../loja-metodos-pagamento');

/**
 * Um tenant novo.
 *
 * `pagamentoModo` é gravado ANTES de a tabela de métodos nascer, que é a
 * ordem real de um tenant que já existia: o legado estava lá primeiro. Por
 * isso a tabela é derrubada e remontada — sem isso a semente do `initSchema`
 * já teria rodado sobre o valor padrão, e a migração nunca seria exercida.
 */
function montar({ modo = 'nenhum', entrega = true, retirada = true, provedor = true } = {}) {
  const arq = path.join(tmp, `m${++seq}.db`);
  fs.copyFileSync(modelo(), arq);
  const db = new Database(arq);
  db.pragma('foreign_keys = ON');

  const ins = db.prepare(`INSERT INTO produtos (sku, descricao, categoria, ativo, publicadoNaLoja, precoVenda, precoCusto)
    VALUES (?,?,?,1,1,?,?)`);
  ins.run('CAFE', 'Café 500g', 'Mercearia', 25, 15);
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, data)
    VALUES (1, 'entrada', 100, 15, date('now'))`).run();

  const nat = db.prepare("SELECT id FROM tipos_operacao WHERE codigo = 'VDA-NORMAL' AND ativo = 1").get()
    || db.prepare(`SELECT id FROM tipos_operacao WHERE ativo = 1 AND usarEmPedido = 1
                     AND movimentaEstoque = 1 ORDER BY id LIMIT 1`).get();
  db.prepare(`UPDATE loja_config SET ativa = 1, nome = 'PROVA', whatsapp = '94991769924',
      servicoRetirada = ?, servicoDelivery = ?, freteModo = 'fixo', freteValor = 10,
      mostrarPreco = 1, pagamentoModo = ?, pagamentoVencimentoDias = 1,
      tipoOperacaoPedidoId = ? WHERE id = 1`)
    .run(retirada ? 1 : 0, entrega ? 1 : 0, modo, nat.id);

  if (provedor) {
    const conta = db.prepare("INSERT INTO contas_financeiras (nome, tipo) VALUES ('Asaas', 'banco')").run().lastInsertRowid;
    db.prepare(`INSERT INTO contas_financeiras_boleto (contaFinanceiraId, provedor, ambiente, ativo, ehPadrao, configJson)
      VALUES (?, 'asaas', 'homologacao', 1, 1, ?)`)
      .run(conta, JSON.stringify({ accessToken: '$aact_hmlg_teste', webhookToken: 'tok' }));
  }

  // O legado precisa ser lido com a tabela ainda inexistente, como num tenant real.
  db.exec('DROP TABLE IF EXISTS loja_metodos_pagamento');
  metodos.migrarMetodos(db);
  return db;
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
      await fn({ body: body || {}, query: {}, params: params || {}, session: { usuarioId: 1 }, headers: {},
                 protocol: 'https', get: () => 'prova.local', tenant: { slug: 'prova' + seq } }, res);
      return { status, body: saida };
    },
  };
  require('../reservas-routes').registrarRotasReservas(app, db);
  require('../pedidos-routes').registrarRotasPedidos(app, db);
  require('../loja-routes').registrarRotasLojaPublica(app, db);
  require('../loja-routes').registrarRotasLojaAdmin(app, db);
  return app;
}

let chaveSeq = 0;
const pedir = (app, extra = {}) => app.chamar('POST', '/loja/api/pedido/finalizar', {
  idempotencyKey: 'chave-de-prova-' + (++chaveSeq),
  cliente: { nome: 'Cliente Prova', telefone: '94991769924', cpfCnpj: '19131243000197' },
  atendimento: 'retirada',
  itens: [{ produtoId: 1, quantidade: 1 }],
  ...extra,
});

const lig = (db, metodo, { entrega = 1, retirada = 1 } = {}) =>
  db.prepare('UPDATE loja_metodos_pagamento SET ativo=1, entrega=?, retirada=? WHERE metodo=?')
    .run(entrega, retirada, metodo);
const linha = (db, m) => db.prepare('SELECT * FROM loja_metodos_pagamento WHERE metodo=?').get(m);
const ativos = (db) => db.prepare('SELECT metodo FROM loja_metodos_pagamento WHERE ativo=1 ORDER BY metodo')
  .all().map((r) => r.metodo);

/* ═══════════ A. migração do legado ═══════════ */

t('A1. modo "nenhum": só os manuais, e nenhum online', () => {
  const db = montar({ modo: 'nenhum' });
  const a = ativos(db);
  assert(a.join(',') === 'credito_presencial,debito_presencial,dinheiro,pix_manual',
    'os manuais não vieram: ' + a.join(','));
  assert(!a.some((m) => m.endsWith('_online')), 'a migração ligou cobrança online em loja que não cobrava');
});

t('A2. modo "pix": só pix_online — era o que aquele checkout oferecia', () => {
  const db = montar({ modo: 'pix' });
  assert(ativos(db).join(',') === 'pix_online', 'veio ' + ativos(db).join(','));
});

t('A3. modo "boleto": só boleto_online', () => {
  const db = montar({ modo: 'boleto' });
  assert(ativos(db).join(',') === 'boleto_online', 'veio ' + ativos(db).join(','));
});

t('A4. modo "pix-ou-boleto": os dois online', () => {
  const db = montar({ modo: 'pix-ou-boleto' });
  assert(ativos(db).join(',') === 'boleto_online,pix_online', 'veio ' + ativos(db).join(','));
});

t('A5. o método nasce nos DOIS atendimentos, e quem esconde é o serviço da loja', () => {
  /* Amarrar a coluna ao serviço do dia da migração congelava um retrato: a
     loja que ligasse a entrega depois ficaria com tudo marcado só para
     retirada, e o checkout da entrega não ofereceria nada. São duas camadas,
     e o filtro por serviço vive em `disponiveis` (ver C5). */
  const db = montar({ modo: 'nenhum', entrega: false, retirada: true });
  const d = linha(db, 'dinheiro');
  assert(d.entrega === 1 && d.retirada === 1,
    `o método precisa nascer nos dois: entrega=${d.entrega}, retirada=${d.retirada}`);
  const cfg = db.prepare('SELECT * FROM loja_config WHERE id=1').get();
  assert(metodos.disponiveis(db, 'entrega', cfg).length === 0,
    'a loja não entrega, mas o método apareceu para entrega');
  assert(metodos.disponiveis(db, 'retirada', cfg).some((m) => m.metodo === 'dinheiro'),
    'a loja retira, e o método não apareceu para retirada');
});

t('A12. modo online SEM provedor migra também os manuais', () => {
  /* O checkout antigo exigia as duas coisas juntas para esconder o resto
     (`pixNoCheckout && provedorPixPronto`). Sem provedor ele mostrava os
     três manuais, e migrar só o online deixaria a loja sem forma nenhuma.
     Medido em 30/09 no `cantinhoverde`: modo 'pix', nenhuma conta Asaas. */
  const db = montar({ modo: 'pix', provedor: false });
  const a = ativos(db);
  assert(a.includes('dinheiro'),
    'sem provedor, a loja ficou sem forma manual e o checkout não ofereceria nada: ' + a.join(','));
  assert(a.includes('pix_online'),
    'o Pix online deve ficar ligado, para aparecer no dia em que a conta for configurada');
  const cfg = db.prepare('SELECT * FROM loja_config WHERE id=1').get();
  assert(metodos.disponiveis(db, 'retirada', cfg).length > 0, 'o checkout ficaria vazio');
});

t('A13. modo online COM provedor NÃO liga manual — não amplia o que a loja aceita', () => {
  const db = montar({ modo: 'pix-ou-boleto', provedor: true });
  const a = ativos(db);
  assert(a.join(',') === 'boleto_online,pix_online',
    'a migração ampliou o que a loja aceitava: ' + a.join(','));
});

t('A11. tenant NOVO termina com método, e não vazio', () => {
  /* O `db-schema.initSchema` roda a migração ANTES de `migrarLojaDB` criar a
     `loja_config`. Semear ali deixaria a tabela não-vazia com o legado nunca
     lido, e a loja ficaria sem método NENHUM para sempre — foi exatamente o
     que aconteceu em 30/09, e o que o test-troco-estruturado pegou. */
  const arq = path.join(tmp, `novo${++seq}.db`);
  fs.copyFileSync(modelo(), arq);
  const db = new Database(arq);
  db.exec('DROP TABLE IF EXISTS loja_metodos_pagamento');
  db.exec('DROP TABLE IF EXISTS loja_config');
  require('../db-schema').initSchema(db);          // ainda sem loja_config
  assert(db.prepare('SELECT COUNT(*) c FROM loja_metodos_pagamento').get().c === 0,
    'semeou sem loja_config: a tabela deixa de estar vazia e o legado nunca é lido');
  require('../loja-routes').migrarLojaDB(db);      // agora a config existe
  const a = ativos(db);
  assert(a.length > 0, 'o tenant novo ficou sem método de pagamento nenhum');
  assert(a.includes('dinheiro'), 'o tenant novo não recebeu os manuais: ' + a.join(','));
});

t('A6. NENHUM método online é ligado quando o legado não pedia', () => {
  for (const modo of ['nenhum', 'boleto']) {
    const db = montar({ modo });
    assert(linha(db, 'pix_online').ativo === 0, `modo "${modo}" ligou pix_online sozinho`);
  }
  assert(linha(montar({ modo: 'nenhum' }), 'boleto_online').ativo === 0, 'modo "nenhum" ligou boleto_online');
});

t('A7. cartao_online nunca nasce ligado', () => {
  for (const modo of ['nenhum', 'pix', 'boleto', 'pix-ou-boleto']) {
    assert(linha(montar({ modo }), 'cartao_online').ativo === 0, `modo "${modo}" ligou o cartão online`);
  }
});

t('A8. idempotente: rodar de novo não reescreve a escolha do lojista', () => {
  const db = montar({ modo: 'pix' });
  // O lojista desliga o Pix online e liga dinheiro — o contrário do legado.
  db.prepare("UPDATE loja_metodos_pagamento SET ativo=0 WHERE metodo='pix_online'").run();
  lig(db, 'dinheiro');
  metodos.migrarMetodos(db);
  metodos.migrarMetodos(db);
  assert(ativos(db).join(',') === 'dinheiro',
    'a migração repetida desfez a escolha do lojista: ' + ativos(db).join(','));
});

t('A9. método novo no catálogo nasce desligado em quem já migrou', () => {
  const db = montar({ modo: 'nenhum' });
  db.prepare("DELETE FROM loja_metodos_pagamento WHERE metodo='debito_presencial'").run();
  metodos.migrarMetodos(db);
  const d = linha(db, 'debito_presencial');
  assert(d, 'o método que faltava não foi semeado de volta');
  assert(d.ativo === 0, 'o método semeado depois nasceu LIGADO, mudando o que a loja aceita sem ninguém pedir');
});

t('A10. tenant sem loja_config não quebra a migração', () => {
  const arq = path.join(tmp, `sem-loja${++seq}.db`);
  fs.copyFileSync(modelo(), arq);
  const db = new Database(arq);
  db.exec('DROP TABLE IF EXISTS loja_metodos_pagamento');
  db.exec('DROP TABLE IF EXISTS loja_config');
  metodos.migrarMetodos(db);          // não pode lançar
  assert(ativos(db).length === 0, 'sem loja_config nada deveria ser ligado');
});

/* ═══════════ B. configuração do lojista ═══════════ */

t('B2. salvar liga por atendimento, separadamente', async () => {
  const db = montar({ modo: 'nenhum' });
  const app = montarApp(db);
  await app.chamar('PUT', '/api/loja/metodos-pagamento', {
    metodos: [{ metodo: 'dinheiro', ativo: true, entrega: true, retirada: false }],
  });
  const d = linha(db, 'dinheiro');
  assert(d.ativo === 1 && d.entrega === 1 && d.retirada === 0,
    `entrega e retirada não foram gravadas em separado: ${JSON.stringify(d)}`);
});

t('B3. cartao_online não ativa nem por requisição direta', async () => {
  const db = montar({ modo: 'nenhum' });
  const app = montarApp(db);
  await app.chamar('PUT', '/api/loja/metodos-pagamento', {
    metodos: [{ metodo: 'cartao_online', ativo: true, entrega: true, retirada: true }],
  });
  assert(linha(db, 'cartao_online').ativo === 0,
    'o cartão online foi ativado, e não há como cobrá-lo');
});

t('B4. método inventado na requisição é ignorado, sem criar linha', async () => {
  const db = montar({ modo: 'nenhum' });
  const app = montarApp(db);
  await app.chamar('PUT', '/api/loja/metodos-pagamento', {
    metodos: [{ metodo: 'cripto', ativo: true, entrega: true, retirada: true }],
  });
  assert(!linha(db, 'cripto'), 'um método fora do catálogo entrou na tabela');
});

t('B5. a listagem traz os sete, com o código fiscal certo', async () => {
  const db = montar({ modo: 'nenhum' });
  const app = montarApp(db);
  const r = await app.chamar('GET', '/api/loja/metodos-pagamento');
  const por = Object.fromEntries(r.body.metodos.map((m) => [m.metodo, m]));
  assert(r.body.metodos.length === 7, 'vieram ' + r.body.metodos.length + ' métodos');
  assert(por.pix_online.meioFiscal === '17' && por.pix_manual.meioFiscal === '17',
    'os dois Pix precisam do mesmo tPag 17');
  assert(por.boleto_online.meioFiscal === '15', 'boleto não é 15');
  assert(por.cartao_online.indisponivel === true, 'o cartão online não está marcado como indisponível');
});

/* ═══════════ C. o que o checkout enxerga ═══════════ */

t('C1. a vitrine recebe os métodos por atendimento', async () => {
  const db = montar({ modo: 'nenhum' });
  lig(db, 'dinheiro', { entrega: 1, retirada: 0 });
  db.prepare("UPDATE loja_metodos_pagamento SET ativo=0 WHERE metodo!='dinheiro'").run();
  const app = montarApp(db);
  const r = await app.chamar('GET', '/loja/api/config');
  const mp = r.body.loja.metodosPagamento;
  assert(mp.entrega.length === 1 && mp.entrega[0].metodo === 'dinheiro', 'entrega deveria ter só dinheiro');
  assert(mp.retirada.length === 0, 'retirada não deveria ter método nenhum');
});

t('C2. online sem provedor NÃO aparece', async () => {
  const db = montar({ modo: 'pix', provedor: false });
  const app = montarApp(db);
  const r = await app.chamar('GET', '/loja/api/config');
  const todos = [...r.body.loja.metodosPagamento.entrega, ...r.body.loja.metodosPagamento.retirada];
  assert(!todos.some((m) => m.metodo === 'pix_online'),
    'o Pix online apareceu sem provedor, e o cliente esperaria um QR que ninguém emite');
});

t('C3. online COM provedor aparece', async () => {
  const db = montar({ modo: 'pix', provedor: true });
  const app = montarApp(db);
  const r = await app.chamar('GET', '/loja/api/config');
  assert(r.body.loja.metodosPagamento.retirada.some((m) => m.metodo === 'pix_online'),
    'o Pix online não apareceu mesmo com provedor');
});

t('C4. online e manual convivem — era o que o modelo antigo impedia', async () => {
  const db = montar({ modo: 'pix' });
  lig(db, 'dinheiro');
  const app = montarApp(db);
  const r = await app.chamar('GET', '/loja/api/config');
  const nomes = r.body.loja.metodosPagamento.retirada.map((m) => m.metodo).sort();
  assert(nomes.join(',') === 'dinheiro,pix_online',
    'Pix online e dinheiro não convivem: ' + nomes.join(','));
  assert(r.body.loja.pixNoSite === false,
    'com método manual ativo, `pixNoSite` não pode ser verdadeiro — ele esconde dinheiro na tela antiga');
});

t('C5. serviço desligado na loja zera os métodos daquele atendimento', async () => {
  const db = montar({ modo: 'nenhum', entrega: false });
  lig(db, 'dinheiro');   // ativo para entrega, mas a loja não entrega
  const app = montarApp(db);
  const r = await app.chamar('GET', '/loja/api/config');
  assert(r.body.loja.metodosPagamento.entrega.length === 0,
    'a loja não entrega, mas o checkout ofereceria método de entrega');
});

/* ═══════════ D. validação no servidor ═══════════ */

t('D1. método desligado é recusado', async () => {
  const db = montar({ modo: 'nenhum' });
  db.prepare('UPDATE loja_metodos_pagamento SET ativo=0').run();
  lig(db, 'dinheiro');
  const app = montarApp(db);
  const r = await pedir(app, { metodo: 'credito_presencial' });
  assert(r.status === 422, 'esperado 422, veio ' + r.status);
  assert(db.prepare("SELECT COUNT(*) c FROM pedidos").get().c === 0,
    'o pedido foi criado apesar da recusa');
});

t('D2. método incompatível com o atendimento é recusado', async () => {
  const db = montar({ modo: 'nenhum' });
  db.prepare('UPDATE loja_metodos_pagamento SET ativo=0').run();
  lig(db, 'dinheiro', { entrega: 1, retirada: 0 });
  const app = montarApp(db);
  const r = await pedir(app, { metodo: 'dinheiro', atendimento: 'retirada' });
  assert(r.status === 422, 'dinheiro só vale na entrega, mas a retirada passou: ' + r.status);
});

t('D3. método inventado é recusado', async () => {
  const db = montar({ modo: 'nenhum' });
  lig(db, 'dinheiro');
  const app = montarApp(db);
  const r = await pedir(app, { metodo: 'boleto_do_amigo' });
  assert(r.status === 422, 'veio ' + r.status);
});

t('D4. requisição adulterada não cria pessoa, pedido nem reserva', async () => {
  const db = montar({ modo: 'nenhum' });
  db.prepare('UPDATE loja_metodos_pagamento SET ativo=0').run();
  lig(db, 'dinheiro');
  const app = montarApp(db);
  const antes = {
    pessoas: db.prepare('SELECT COUNT(*) c FROM pessoas').get().c,
    pedidos: db.prepare('SELECT COUNT(*) c FROM pedidos').get().c,
  };
  // Manda o método desligado E um código fiscal por fora, como faria um curl.
  await pedir(app, { metodo: 'pix_online', meioPagamento: '01', pagamento: 'dinheiro' });
  assert(db.prepare('SELECT COUNT(*) c FROM pessoas').get().c === antes.pessoas,
    'a recusa deixou uma pessoa criada');
  assert(db.prepare('SELECT COUNT(*) c FROM pedidos').get().c === antes.pedidos,
    'a recusa deixou um pedido criado');
});

t('D5. o código fiscal vem do SERVIDOR, e o do corpo é ignorado', async () => {
  const db = montar({ modo: 'nenhum' });
  lig(db, 'dinheiro');
  const app = montarApp(db);
  const r = await pedir(app, { metodo: 'dinheiro', meioPagamento: '99', meioFiscal: '99' });
  assert(r.status === 200, 'o pedido não foi criado: ' + JSON.stringify(r.body));
  const p = db.prepare('SELECT meioPagamento, metodoPagamento FROM pedidos ORDER BY id DESC LIMIT 1').get();
  assert(p.meioPagamento === '01',
    `o tPag veio do navegador: esperado 01, gravado ${p.meioPagamento}`);
  assert(p.metodoPagamento === 'dinheiro', 'metodoPagamento não foi persistido: ' + p.metodoPagamento);
});

/* ═══════════ E. Pix online × Pix manual ═══════════ */

t('E1. pix_online gera cobrança no provedor', async () => {
  const db = montar({ modo: 'pix' });
  const app = montarApp(db);
  ASAAS.chamadas.length = 0;
  const r = await pedir(app, { metodo: 'pix_online' });
  assert(r.status === 200, 'pedido recusado: ' + JSON.stringify(r.body));
  const cr = db.prepare("SELECT COUNT(*) c FROM contas_a_receber WHERE origem='loja'").get().c;
  assert(cr === 1, `esperava 1 conta a receber da loja, tem ${cr}`);
  assert(ASAAS.chamadas.some((c) => c.caminho.endsWith('/payments')), 'nenhuma cobrança foi pedida ao provedor');
});

t('E2. pix_manual NÃO gera cobrança, e é o mesmo tPag 17', async () => {
  const db = montar({ modo: 'nenhum' });
  lig(db, 'pix_manual');
  const app = montarApp(db);
  ASAAS.chamadas.length = 0;
  const r = await pedir(app, { metodo: 'pix_manual' });
  assert(r.status === 200, 'pedido recusado: ' + JSON.stringify(r.body));
  const p = db.prepare('SELECT meioPagamento, metodoPagamento FROM pedidos ORDER BY id DESC LIMIT 1').get();
  assert(p.meioPagamento === '17', 'o Pix manual precisa do mesmo tPag 17, veio ' + p.meioPagamento);
  assert(p.metodoPagamento === 'pix_manual', 'o método não distinguiu o Pix manual do online');
  const cr = db.prepare("SELECT COUNT(*) c FROM contas_a_receber WHERE origem='loja'").get().c;
  assert(cr === 0, `o Pix manual criou ${cr} conta(s) a receber — ninguém vai emitir essa cobrança`);
  assert(!ASAAS.chamadas.some((c) => c.caminho.endsWith('/payments')),
    'o Pix manual chamou o provedor');
});

t('E3. online sem provedor não finaliza', async () => {
  const db = montar({ modo: 'pix', provedor: false });
  const app = montarApp(db);
  const r = await pedir(app, { metodo: 'pix_online' });
  assert(r.status === 422, 'o pedido online passou sem provedor: ' + r.status);
});

t('E4. online exige o documento do cliente', async () => {
  const db = montar({ modo: 'pix' });
  const app = montarApp(db);
  const r = await pedir(app, {
    metodo: 'pix_online',
    cliente: { nome: 'Sem Documento', telefone: '94991769924' },
  });
  assert(r.status === 422, 'cobrança online sem CPF passou: ' + r.status);
});

t('E5. manual NÃO exige documento', async () => {
  const db = montar({ modo: 'nenhum' });
  lig(db, 'dinheiro');
  const app = montarApp(db);
  const r = await pedir(app, {
    metodo: 'dinheiro',
    cliente: { nome: 'Sem Documento', telefone: '94991769924' },
  });
  assert(r.status === 200, 'dinheiro na entrega passou a exigir CPF: ' + JSON.stringify(r.body));
});

/* ═══════════ F. dinheiro e troco ═══════════ */

t('F1. o troco estruturado continua gravado', async () => {
  const db = montar({ modo: 'nenhum' });
  lig(db, 'dinheiro');
  const app = montarApp(db);
  const r = await pedir(app, { metodo: 'dinheiro', precisaTroco: true, trocoPara: 100 });
  assert(r.status === 200, 'pedido recusado: ' + JSON.stringify(r.body));
  const p = db.prepare('SELECT valorRecebidoDinheiro, valorTotal, observacao FROM pedidos ORDER BY id DESC LIMIT 1').get();
  assert(Number(p.valorRecebidoDinheiro) === 100,
    'valorRecebidoDinheiro não foi gravado: ' + p.valorRecebidoDinheiro);
  assert(/Troco para/.test(p.observacao), 'a linha de texto do troco sumiu da observação');
});

t('F2. troco não influencia o valor do pedido', async () => {
  const db = montar({ modo: 'nenhum' });
  lig(db, 'dinheiro');
  const app = montarApp(db);
  const r = await pedir(app, { metodo: 'dinheiro', precisaTroco: true, trocoPara: 500 });
  const p = db.prepare('SELECT valorTotal FROM pedidos ORDER BY id DESC LIMIT 1').get();
  assert(Number(p.valorTotal) === Number(r.body.total),
    'o valor entregue em dinheiro mexeu no total do pedido');
  assert(Number(p.valorTotal) < 500, 'o total virou o valor entregue');
});

t('F3. troco NÃO vale para Pix, crédito nem débito', async () => {
  for (const m of ['pix_manual', 'credito_presencial', 'debito_presencial']) {
    const db = montar({ modo: 'nenhum' });
    lig(db, m);
    const app = montarApp(db);
    const r = await pedir(app, { metodo: m, precisaTroco: true, trocoPara: 500 });
    assert(r.status === 200, `${m} recusado: ` + JSON.stringify(r.body));
    const p = db.prepare('SELECT valorRecebidoDinheiro FROM pedidos ORDER BY id DESC LIMIT 1').get();
    assert(p.valorRecebidoDinheiro == null,
      `${m} gravou valorRecebidoDinheiro = ${p.valorRecebidoDinheiro}`);
  }
});

/* ═══════════ G. códigos fiscais ═══════════ */

t('G1. crédito grava 03 e débito grava 04', async () => {
  for (const [m, cod] of [['credito_presencial', '03'], ['debito_presencial', '04']]) {
    const db = montar({ modo: 'nenhum' });
    lig(db, m);
    const app = montarApp(db);
    const r = await pedir(app, { metodo: m });
    assert(r.status === 200, `${m} recusado: ` + JSON.stringify(r.body));
    const p = db.prepare('SELECT meioPagamento, metodoPagamento FROM pedidos ORDER BY id DESC LIMIT 1').get();
    assert(p.meioPagamento === cod, `${m} deveria gravar ${cod}, gravou ${p.meioPagamento}`);
    assert(p.metodoPagamento === m, `${m} não foi persistido: ${p.metodoPagamento}`);
  }
});

t('G2. o código do boleto é o mesmo que o ERP já usa (15)', () => {
  const { codigosDoMeio } = require('../meios-pagamento');
  assert(codigosDoMeio('boleto').join(',') === '15',
    'o ERP mudou o código do boleto, e a tabela de métodos ficou para trás');
  assert(metodos.CATALOGO.boleto_online.meioFiscal === '15', 'boleto_online não está em 15');
});

/* ═══════════ H. pedido antigo ═══════════ */

t('H1. pedido com metodoPagamento NULL continua válido e legível', async () => {
  const db = montar({ modo: 'nenhum' });
  lig(db, 'dinheiro');
  const app = montarApp(db);
  await pedir(app, { metodo: 'dinheiro' });
  // Vira um pedido "de antes": o método some, o código fiscal fica.
  db.prepare('UPDATE pedidos SET metodoPagamento = NULL').run();
  const p = db.prepare('SELECT meioPagamento, metodoPagamento FROM pedidos ORDER BY id DESC LIMIT 1').get();
  assert(p.metodoPagamento === null, 'o pedido não ficou NULL para a prova');
  assert(p.meioPagamento === '01', 'o código fiscal do pedido antigo se perdeu');
  const r = await app.chamar('GET', '/api/pedidos/:id', null, { id: '1' });
  assert(r.status === 200, 'ler um pedido sem metodoPagamento quebrou: ' + r.status);
  assert(r.body && r.body.pedido, 'o pedido antigo não voltou na leitura');
});

t('H2. a migração não preenche metodoPagamento de pedido antigo', async () => {
  const db = montar({ modo: 'nenhum' });
  lig(db, 'dinheiro');
  await pedir(montarApp(db), { metodo: 'dinheiro' });
  db.prepare('UPDATE pedidos SET metodoPagamento = NULL').run();
  metodos.migrarMetodos(db);
  require('../db-schema').initSchema(db);
  const n = db.prepare('SELECT COUNT(*) c FROM pedidos WHERE metodoPagamento IS NOT NULL').get().c;
  assert(n === 0, `a migração inventou método para ${n} pedido(s) histórico(s)`);
});

/* ═══════════ I. conta a receber única ═══════════ */

t('I1. o Pix online cria UMA conta a receber, e ela continua uma', async () => {
  const db = montar({ modo: 'pix' });
  const app = montarApp(db);
  await pedir(app, { metodo: 'pix_online' });
  const crs = db.prepare(`SELECT id, valor, faturaId, origem FROM contas_a_receber
    WHERE pedidoId = 1 AND status != 'cancelada'`).all();
  assert(crs.length === 1, `esperava 1 conta a receber, tem ${crs.length}`);
  assert(crs[0].origem === 'loja', "a conta a receber precisa nascer com origem 'loja' para o faturamento a adotar");
  assert(crs[0].faturaId == null, 'a conta nasceu já presa a uma fatura');
});

/* ═══════════ corrida ═══════════ */
(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); ok++; console.log('  ok   ' + nome); }
    catch (e) { fail++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
  }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
