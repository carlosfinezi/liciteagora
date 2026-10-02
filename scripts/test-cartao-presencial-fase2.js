/**
 * Fase 2 — cartão presencial do Catálogo Online chega à agenda de recebíveis.
 *
 * O que esta suíte guarda, e por que ela existe:
 *
 * O pedido do catálogo pago em cartão na entrega nascia sem linha em
 * `pedido_parcelas`. O faturamento montava uma "parcela virtual" em memória,
 * gerava a conta a receber com a adquirente certa, e a parcela morria ali.
 * O gerador de `/api/cartoes/agenda/gerar` varre `pedido_parcelas`, então a
 * venda nunca entrava na agenda: nem taxa da adquirente, nem previsão de
 * liquidação, nem conciliação depois.
 *
 * A correção materializa a parcela 1/1 no faturamento, dentro da mesma
 * transação. O que esta suíte prova é que isso acontece SEM mudar nada do que
 * já funcionava: a conta a receber continua sendo de venda à vista (sem
 * `parcelaNumero`, sem `totalParcelas`, sem grupo), e o plano de parcelas
 * montado pelo lojista continua sendo dele.
 *
 * Guarda também a recusa: faltar a adquirente passou a responder 400, e não
 * o 500 de antes — é dado que o lojista ainda não deu, não falha do servidor.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
process.chdir(RAIZ);

const { schemaDeTenant } = require(path.join(RAIZ, 'scripts/schema-de-tenant'));
const SCHEMA = schemaDeTenant();

let falhas = 0;
let total = 0;
function ok(nome, cond, detalhe) {
  total++;
  if (cond) { console.log(`  ok   ${nome}`); return; }
  falhas++;
  console.log(`  FALHA ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}

/* ───────────────────────── banco e app de teste ───────────────────────── */

const temporarios = [];
function montar(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `f2-${tag}-`));
  temporarios.push(dir);
  const db = new Database(path.join(dir, 'pncp.db'));
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA);
  require(path.join(RAIZ, 'db-schema')).initSchema(db);
  require(path.join(RAIZ, 'loja-routes')).migrarLojaDB(db);
  /* Os tipos de operação, os preços e a tesouraria semeiam o que o pedido e a
     agenda precisam. Em produção isso vem do registro das rotas; aqui as
     migrações são chamadas direto, porque o app de teste não as dispara. */
  for (const m of ['tipos-operacao-routes', 'precos-routes', 'contas-financeiras-routes', 'tesouraria-routes']) {
    const x = require(path.join(RAIZ, m));
    const f = x.migrar || x.migrarPrecosDB || x.migrarDB || x.migrarTesouraria;
    if (typeof f === 'function') { try { f(db); } catch { /* já migrado */ } }
  }
  db.pragma('foreign_keys = ON');

  // Produto com estoque, para o pedido poder ser entregue.
  db.prepare(`INSERT INTO produtos (sku, descricao, categoria, ativo, publicadoNaLoja, precoVenda, precoCusto)
    VALUES ('CAFE','Café 500g','Mercearia',1,1,100,40)`).run();
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, data)
    VALUES (1,'entrada',50,40,date('now'))`).run();

  const nat = db.prepare(`SELECT id FROM tipos_operacao
    WHERE ativo=1 AND usarEmPedido=1 AND movimentaEstoque=1 ORDER BY id LIMIT 1`).get();
  db.prepare(`UPDATE loja_config SET ativa=1, nome='FASE2', whatsapp='94991769924',
    servicoRetirada=1, servicoDelivery=0, freteModo='gratis', mostrarPreco=1,
    pagamentoModo='nenhum', tipoOperacaoPedidoId=? WHERE id=1`).run(nat.id);

  /* Caixa padrão: a venda em dinheiro se auto-baixa no faturamento e recusa
     sem ele. Em produção o tenant o cadastra em Financeiro. */
  db.prepare(`INSERT INTO contas_financeiras (nome, tipo, ehCaixaPadrao, ativo)
    VALUES ('Caixa da loja','caixa',1,1)`).run();

  // Os métodos presenciais de cartão, ligados.
  require(path.join(RAIZ, 'loja-metodos-pagamento')).migrarMetodos(db);
  db.prepare(`UPDATE loja_metodos_pagamento SET ativo=1, entrega=1, retirada=1
    WHERE metodo IN ('credito_presencial','debito_presencial','dinheiro')`).run();

  // Duas adquirentes com taxas diferentes: nenhuma escolha automática pode
  // acertar as duas, e é isso que faz a prova valer.
  db.prepare("UPDATE adquirentes_cartao SET taxaPercentual=3.0, prazoLiquidacaoDias=30 WHERE nome='Stone'").run();
  db.prepare("UPDATE adquirentes_cartao SET taxaPercentual=2.5, prazoLiquidacaoDias=15 WHERE nome='Cielo'").run();
  return db;
}

function montarApp(db) {
  const rotas = new Map();
  const reg = (m) => (url, ...f) => rotas.set(m + ' ' + url, f[f.length - 1]);
  const app = {
    get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), use() {},
    async chamar(m, url, body, params) {
      const fn = rotas.get(m + ' ' + url);
      if (!fn) throw new Error('rota não registrada: ' + m + ' ' + url);
      let saida = null; let status = 200;
      const res = {
        json: (d) => { saida = d; return res; },
        status: (s) => { status = s; return res; },
        set() { return res; }, setHeader() { return res; }, end() { return res; },
      };
      await fn({
        body: body || {}, query: {}, params: params || {}, session: { usuarioId: 1 },
        headers: {}, protocol: 'https', get: () => 'd.local', tenant: { slug: 'f2' },
      }, res);
      return { status, body: saida };
    },
  };
  for (const m of ['reservas-routes', 'pedidos-routes', 'faturas-routes', 'tesouraria-routes']) {
    const x = require(path.join(RAIZ, m));
    const f = x.registrarRotasReservas || x.registrarRotasPedidos
           || x.registrarRotasFaturas || x.registrarRotasTesouraria;
    if (f) f(app, db);
  }
  const loja = require(path.join(RAIZ, 'loja-routes'));
  loja.registrarRotasLojaPublica(app, db);
  loja.registrarRotasLojaAdmin(app, db);
  return app;
}

const adq = (db, nome) => db.prepare('SELECT * FROM adquirentes_cartao WHERE nome = ?').get(nome);
const parcelasDe = (db, pedidoId) => db.prepare(
  'SELECT * FROM pedido_parcelas WHERE pedidoId = ? ORDER BY numeroParcela').all(pedidoId);
const crsDe = (db) => db.prepare('SELECT * FROM contas_a_receber ORDER BY id').all();

let seqChave = 0;
async function pedidoDoCatalogo(db, app, metodo) {
  const r = await app.chamar('POST', '/loja/api/pedido/finalizar', {
    idempotencyKey: 'fase2-cartao-' + (++seqChave),  // o checkout exige 8+ caracteres
    cliente: { nome: 'Cliente Fase 2', telefone: '94991769924', cpfCnpj: '19131243000197' },
    atendimento: 'retirada', metodo,
    itens: [{ produtoId: 1, quantidade: 1 }],
  });
  if (r.status !== 200 || !r.body || !r.body.success) {
    throw new Error('checkout recusou: ' + r.status + ' ' + JSON.stringify(r.body));
  }
  return db.prepare('SELECT * FROM pedidos ORDER BY id DESC LIMIT 1').get();
}

const entregar = (db, id) => db.prepare("UPDATE pedidos SET status='entregue' WHERE id=?").run(id);
const faturar = (app, id, body) => app.chamar('POST', '/api/pedidos/:id/faturar', body || {}, { id: String(id) });

/* ════════════════════════════ A. crédito 1/1 ════════════════════════════ */

async function blocoCredito() {
  console.log('\nA. crédito presencial, parcela única');
  const db = montar('credito'); const app = montarApp(db);
  const stone = adq(db, 'Stone');

  const ped = await pedidoDoCatalogo(db, app, 'credito_presencial');
  ok('A1 o checkout público não cria parcela nenhuma',
    parcelasDe(db, ped.id).length === 0);
  ok('A1b e o pedido guarda o meio de cartão de crédito',
    ped.meioPagamento === '03', `meioPagamento=${ped.meioPagamento}`);

  entregar(db, ped.id);

  const sem = await faturar(app, ped.id);
  ok('A2 faturar sem a adquirente responde 400, e não 500',
    sem.status === 400, `${sem.status} ${JSON.stringify(sem.body)}`);
  ok('A2b e a mensagem diz o que falta',
    /bandeira do cartão obrigatória/.test((sem.body && sem.body.error) || ''),
    JSON.stringify(sem.body));
  ok('A3 a recusa não deixa parcela pela metade',
    parcelasDe(db, ped.id).length === 0);
  ok('A3b nem conta a receber',
    crsDe(db).length === 0, JSON.stringify(crsDe(db)));
  ok('A3c nem marca o pedido como faturado',
    db.prepare('SELECT status FROM pedidos WHERE id=?').get(ped.id).status === 'entregue');

  const com = await faturar(app, ped.id, { bandeiraId: stone.id });
  ok('A4 com a adquirente escolhida, o faturamento passa',
    com.status === 200 && com.body && com.body.success,
    `${com.status} ${JSON.stringify(com.body && com.body.error)}`);

  const parc = parcelasDe(db, ped.id);
  ok('A5 nasce exatamente UMA parcela', parc.length === 1, `n=${parc.length}`);
  ok('A5b ela é a 1 e vale o total do pedido',
    parc[0] && parc[0].numeroParcela === 1
    && Math.abs(Number(parc[0].valor) - Number(ped.valorTotal)) < 0.01,
    JSON.stringify(parc[0]));
  ok('A5c com a adquirente que o LOJISTA escolheu, não uma qualquer',
    parc[0] && parc[0].bandeiraId === stone.id, `bandeiraId=${parc[0] && parc[0].bandeiraId}`);
  ok('A5d e o meio do pedido, não um default',
    parc[0] && parc[0].meioPagamento === '03');

  const cr = crsDe(db);
  ok('A6 a conta a receber continua sendo UMA', cr.length === 1, `n=${cr.length}`);
  ok('A6b e continua sendo de venda à vista: sem número de parcela',
    cr[0] && cr[0].parcelaNumero == null && cr[0].totalParcelas == null
    && cr[0].grupoParcelaId == null, JSON.stringify(cr[0]));
  ok('A6c a descrição não diz "parcela"',
    cr[0] && !/parcela/i.test(cr[0].descricao || ''), cr[0] && cr[0].descricao);
  ok('A6d ela aponta a adquirente e a origem de cartão',
    cr[0] && cr[0].adquirenteCartaoId === stone.id && cr[0].origem === 'cartao_adquirente',
    JSON.stringify({ a: cr[0] && cr[0].adquirenteCartaoId, o: cr[0] && cr[0].origem }));

  const g = await app.chamar('POST', '/api/cartoes/agenda/gerar', {});
  ok('A7 a agenda de recebíveis passa a ter a venda',
    g.status === 200 && g.body && g.body.geradas === 1, JSON.stringify(g.body));

  const ag = db.prepare('SELECT * FROM agenda_recebiveis_cartao').all();
  const esperadaTaxa = Number((Number(ped.valorTotal) * 3.0 / 100).toFixed(2));
  ok('A7b com a taxa da Stone, e não a da Cielo',
    ag.length === 1 && Math.abs(Number(ag[0].taxa) - esperadaTaxa) < 0.01,
    `taxa=${ag[0] && ag[0].taxa} esperada=${esperadaTaxa}`);
  ok('A7c e o líquido descontado dela',
    ag[0] && Math.abs(Number(ag[0].valorLiquido) - (Number(ped.valorTotal) - esperadaTaxa)) < 0.01,
    `liquido=${ag[0] && ag[0].valorLiquido}`);
  ok('A7d a previsão fica 30 dias à frente da venda',
    ag[0] && diasEntre(ag[0].dataVenda, ag[0].dataPrevistaLiquidacao) === 30,
    `${ag[0] && ag[0].dataVenda} → ${ag[0] && ag[0].dataPrevistaLiquidacao}`);
  ok('A7e e a linha acha a conta a receber da venda',
    ag[0] && ag[0].contaReceberId === cr[0].id,
    `contaReceberId=${ag[0] && ag[0].contaReceberId} cr=${cr[0].id}`);

  const g2 = await app.chamar('POST', '/api/cartoes/agenda/gerar', {});
  ok('A8 gerar de novo não duplica a previsão',
    g2.body && g2.body.geradas === 0
    && db.prepare('SELECT COUNT(*) c FROM agenda_recebiveis_cartao').get().c === 1,
    JSON.stringify(g2.body));
}

function diasEntre(a, b) {
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
}

/* ════════════════════════════ B. débito ════════════════════════════ */

async function blocoDebito() {
  console.log('\nB. débito presencial');
  const db = montar('debito'); const app = montarApp(db);
  const cielo = adq(db, 'Cielo');

  const ped = await pedidoDoCatalogo(db, app, 'debito_presencial');
  ok('B1 o pedido guarda o meio de débito',
    ped.meioPagamento === '04', `meioPagamento=${ped.meioPagamento}`);
  entregar(db, ped.id);

  const f = await faturar(app, ped.id, { bandeiraId: cielo.id });
  ok('B2 o faturamento passa', f.status === 200 && f.body && f.body.success,
    `${f.status} ${JSON.stringify(f.body && f.body.error)}`);

  const parc = parcelasDe(db, ped.id);
  ok('B3 materializa a parcela de débito também',
    parc.length === 1 && parc[0].meioPagamento === '04' && parc[0].bandeiraId === cielo.id,
    JSON.stringify(parc));

  await app.chamar('POST', '/api/cartoes/agenda/gerar', {});
  const ag = db.prepare('SELECT * FROM agenda_recebiveis_cartao').all();
  ok('B4 a agenda usa os 15 dias da Cielo, e não os 30 da Stone',
    ag.length === 1 && diasEntre(ag[0].dataVenda, ag[0].dataPrevistaLiquidacao) === 15,
    JSON.stringify(ag[0]));
}

/* ═════════════════════ C. adquirente que não serve ═════════════════════ */

async function blocoAdquirenteInvalida() {
  console.log('\nC. adquirente inativa ou de outro tenant');

  {
    const db = montar('inativa'); const app = montarApp(db);
    const stone = adq(db, 'Stone');
    db.prepare('UPDATE adquirentes_cartao SET ativo=0 WHERE id=?').run(stone.id);
    const ped = await pedidoDoCatalogo(db, app, 'credito_presencial');
    entregar(db, ped.id);
    const f = await faturar(app, ped.id, { bandeiraId: stone.id });
    ok('C1 adquirente inativa é recusada com 400',
      f.status === 400 && /não cadastrada/.test((f.body && f.body.error) || ''),
      `${f.status} ${JSON.stringify(f.body)}`);
    ok('C1b e nada fica gravado',
      parcelasDe(db, ped.id).length === 0 && crsDe(db).length === 0
      && db.prepare('SELECT COUNT(*) c FROM faturas').get().c === 0);
  }

  {
    /* O id que existe no banco do VIZINHO não pode valer aqui. Como cada
       tenant tem o seu arquivo, o teste é o id que não existe neste: se o
       faturamento aceitasse um id sem conferir, a parcela nasceria apontando
       adquirente de ninguém e a agenda calcularia taxa zero em silêncio. */
    const db = montar('outrotenant'); const app = montarApp(db);
    const maior = db.prepare('SELECT MAX(id) m FROM adquirentes_cartao').get().m;
    const ped = await pedidoDoCatalogo(db, app, 'credito_presencial');
    entregar(db, ped.id);
    const f = await faturar(app, ped.id, { bandeiraId: maior + 500 });
    ok('C2 adquirente que não é deste tenant é recusada com 400',
      f.status === 400 && /não cadastrada/.test((f.body && f.body.error) || ''),
      `${f.status} ${JSON.stringify(f.body)}`);
    ok('C2b e nada fica gravado',
      parcelasDe(db, ped.id).length === 0 && crsDe(db).length === 0);
  }
}

/* ══════════════════ D. o que NÃO pode mudar de comportamento ══════════════════ */

async function blocoRegressao() {
  console.log('\nD. o que a materialização não pode tocar');

  {
    const db = montar('plano'); const app = montarApp(db);
    const stone = adq(db, 'Stone'); const cielo = adq(db, 'Cielo');
    const ped = await pedidoDoCatalogo(db, app, 'credito_presencial');
    const metade = Number((Number(ped.valorTotal) / 2).toFixed(2));
    const resto = Number((Number(ped.valorTotal) - metade).toFixed(2));
    const put = await app.chamar('PUT', '/api/pedidos/:id/parcelas', {
      parcelas: [
        { valor: metade, dataVencimento: '2026-11-10', meioPagamento: '03', bandeiraId: stone.id },
        { valor: resto, dataVencimento: '2026-12-10', meioPagamento: '03', bandeiraId: cielo.id },
      ],
    }, { id: String(ped.id) });
    ok('D1 o lojista monta um plano de 2 parcelas',
      put.status === 200 && parcelasDe(db, ped.id).length === 2, JSON.stringify(put.body));

    entregar(db, ped.id);
    const f = await faturar(app, ped.id, { bandeiraId: stone.id });
    ok('D1b o faturamento passa', f.status === 200 && f.body && f.body.success,
      JSON.stringify(f.body && f.body.error));
    const parc = parcelasDe(db, ped.id);
    ok('D1c o plano dele continua com 2 linhas, não vira 3',
      parc.length === 2, `n=${parc.length}`);
    ok('D1d e a segunda continua na adquirente que ELE escolheu',
      parc[1] && parc[1].bandeiraId === cielo.id,
      `bandeiraId=${parc[1] && parc[1].bandeiraId}`);
    const cr = crsDe(db);
    ok('D1e com duas contas a receber, numeradas',
      cr.length === 2 && cr[0].parcelaNumero === 1 && cr[0].totalParcelas === 2,
      JSON.stringify(cr.map((c) => [c.parcelaNumero, c.totalParcelas])));
  }

  {
    const db = montar('dinheiro'); const app = montarApp(db);
    const ped = await pedidoDoCatalogo(db, app, 'dinheiro');
    entregar(db, ped.id);
    const f = await faturar(app, ped.id);
    ok('D2 o pedido em dinheiro fatura sem pedir adquirente',
      f.status === 200 && f.body && f.body.success,
      `${f.status} ${JSON.stringify(f.body && f.body.error)}`);
    ok('D2b e NÃO materializa parcela nenhuma: só cartão entra na agenda',
      parcelasDe(db, ped.id).length === 0, JSON.stringify(parcelasDe(db, ped.id)));
    const g = await app.chamar('POST', '/api/cartoes/agenda/gerar', {});
    ok('D2c a agenda de cartões continua vazia',
      g.body && g.body.geradas === 0
      && db.prepare('SELECT COUNT(*) c FROM agenda_recebiveis_cartao').get().c === 0);
  }
}

/* ════════════════════════════ execução ════════════════════════════ */

(async () => {
  try {
    await blocoCredito();
    await blocoDebito();
    await blocoAdquirenteInvalida();
    await blocoRegressao();
  } catch (e) {
    falhas++;
    console.log('  FALHA erro não tratado — ' + e.message);
    console.log(e.stack);
  }
  for (const d of temporarios) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* já foi */ } }
  console.log(`\n${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens`);
  process.exit(falhas ? 1 : 0);
})();
