/**
 * Uma venda, uma conta a receber.
 *
 * O pagamento online do catálogo cria a CR no fechamento do pedido
 * (`origem='loja'`, `pedidoId` preenchido, Pix do Asaas pendurado nela). O
 * faturamento criava OUTRA, porque as duas não se enxergavam: uma é indexada
 * por `pedidoId`, a outra por `faturaId`. Medido em 29/09: venda de R$ 55
 * com Pix pago virava R$ 110 em recebíveis, sendo a segunda ABERTA — a régua
 * de cobrança voltaria a cobrar quem já tinha pagado.
 *
 * Esta suíte prova a adoção: a CR existente passa a pertencer à fatura, com
 * o pagamento, a baixa e o Pix preservados; e prova os casos em que adotar
 * seria errado, onde o faturamento para em vez de escolher sozinho.
 *
 * Banco descartável, nada transmitido, nada de Asaas real.
 *
 * Roda da raiz do projeto:  node scripts/test-fatura-cr-unica.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const SCHEMA = require('./schema-de-tenant').schemaDeTenant();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-unica-'));
const abertos = [];

let falhas = 0;
let total = 0;
function ok(nome, condicao, detalhe) {
  total++;
  if (condicao) console.log(`  ok   ${nome}`);
  else { falhas++; console.log(`  FALHA ${nome}${detalhe ? ' — ' + detalhe : ''}`); }
}
/** Espera que o faturamento RECUSE, e que a mensagem diga por quê. */
function recusa(nome, r, trecho) {
  total++;
  const msg = (r.body && r.body.error) || '';
  if (r.status !== 200 && new RegExp(trecho).test(msg)) console.log(`  ok   ${nome}`);
  else { falhas++; console.log(`  FALHA ${nome} — status ${r.status}: ${msg.slice(0, 120)}`); }
}

function montar(nome) {
  const db = new Database(path.join(tmp, nome + '.db'));
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA);
  require('../db-schema').initSchema(db);
  require('../loja-routes').migrarLojaDB(db);
  try { require('../tipos-operacao-routes').migrar(db); } catch (_) {}
  db.pragma('foreign_keys = ON');
  abertos.push(db);
  db.prepare(`INSERT INTO produtos (sku, descricao, categoria, unidade, ativo, publicadoNaLoja, precoVenda)
    VALUES ('S1','CESTA','C','UN',1,1,55)`).run();
  db.exec("INSERT INTO movimentacoes_estoque (produtoId,tipo,quantidade,data) VALUES (1,'entrada',200,date('now'))");
  db.prepare(`UPDATE loja_config SET ativa=1, nome='LOJA', whatsapp='44999990000',
    servicoRetirada=1, servicoDelivery=0, freteModo='gratis', mostrarPreco=1 WHERE id=1`).run();
  const nat = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo='VDA-NORMAL'`).get()
    || db.prepare(`SELECT id FROM tipos_operacao WHERE ativo=1 AND usarEmPedido=1 LIMIT 1`).get();
  db.prepare('UPDATE loja_config SET tipoOperacaoPedidoId=? WHERE id=1').run(nat.id);
  db.prepare(`INSERT INTO contas_financeiras (nome, tipo, ehCaixaPadrao, ativo)
    VALUES ('CAIXA','caixa',1,1)`).run();
  return db;
}

function montarApp(db) {
  const rotas = new Map();
  const reg = (m) => (u, ...f) => rotas.set(m + ' ' + u, f[f.length - 1]);
  const app = {
    get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), use() {},
    chamar(m, u, b) {
      const fn = rotas.get(m + ' ' + u);
      if (!fn) throw new Error('rota não registrada: ' + u);
      let saida = null, status = 200;
      const res = { json: (d) => { saida = d; return res; },
                    status: (s) => { status = s; return res; },
                    setHeader() { return res; }, end() { return res; } };
      fn({ body: b || {}, query: {}, params: (b && b.__params) || {},
           session: { username: 'suite' }, protocol: 'https', get: () => 'l' }, res);
      return { status, body: saida };
    },
  };
  require('../reservas-routes').registrarRotasReservas(app, db);
  require('../pedidos-routes').registrarRotasPedidos(app, db);
  require('../loja-routes').registrarRotasLojaPublica(app, db);
  require('../faturas-routes').registrarRotasFaturas(app, db);
  return app;
}

const FINALIZAR = '/loja/api/pedido/finalizar';
const corpo = (extra) => Object.assign({
  idempotencyKey: crypto.randomUUID(),
  cliente: { nome: 'MARIA DA SILVA', telefone: '44999887766', cpfCnpj: '52998224725' },
  atendimento: 'retirada', pagamento: 'pix',
  itens: [{ produtoId: 1, quantidade: 1 }],
}, extra);

/** Cria o pedido pelo catálogo e devolve a linha. */
function pedidoDoCatalogo(db, app, extra) {
  const r = app.chamar('POST', FINALIZAR, corpo(extra));
  if (r.status !== 200) throw new Error('checkout recusou: ' + JSON.stringify(r.body));
  return db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(r.body.numero);
}

/** A CR que o pagamento online criaria. `pago` decide se já veio o webhook. */
function crDaLoja(db, ped, { pago = false, valor = 55, status = null } = {}) {
  return db.prepare(`INSERT INTO contas_a_receber
      (pessoaId, descricao, valor, valorPago, dataEmissao, dataVencimento, status,
       origem, origemTipo, pedidoId, formaPagamento)
    VALUES (?, ?, ?, ?, date('now'), date('now','+1 day'), ?, 'loja', 'pedido', ?, '17')`)
    .run(ped.clienteId, `Pedido ${ped.numero} — loja virtual`, valor,
         pago ? valor : 0, status || (pago ? 'paga' : 'aberta'), ped.id).lastInsertRowid;
}

const entregar = (app, id) => app.chamar('POST', '/api/pedidos/:id/entregar', { __params: { id: String(id) } });
const faturar = (app, id) => app.chamar('POST', '/api/pedidos/:id/faturar', { __params: { id: String(id) } });
const crs = (db) => db.prepare(`SELECT id, origem, valor, valorPago, status, pedidoId, faturaId, formaPagamento
  FROM contas_a_receber ORDER BY id`).all();
const caixa = (db) => db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(valor),0) v
  FROM movimentacoes_financeiras WHERE tipo='entrada'`).get();

// ════════════════════════════════════════════════════════════════════════════
// A. Pedido sem cobrança da loja: o caminho de sempre
// ════════════════════════════════════════════════════════════════════════════
{
  console.log('── A. pedido sem CR prévia (o caminho legado) ──');
  const db = montar('a'); const app = montarApp(db);
  const ped = pedidoDoCatalogo(db, app, { pagamento: 'dinheiro' });
  entregar(app, ped.id);
  const f = faturar(app, ped.id);
  ok('A1 faturou', f.status === 200, JSON.stringify(f.body).slice(0, 120));
  const lista = crs(db);
  ok('A2 criou exatamente UMA conta a receber', lista.length === 1, `${lista.length}`);
  ok('A3 com origem "fatura", como sempre foi',
    lista[0].origem === 'fatura' && lista[0].faturaId != null, JSON.stringify(lista[0]));
  ok('A4 dinheiro deu auto-baixa e uma entrada no caixa',
    lista[0].status === 'paga' && caixa(db).n === 1 && Math.abs(caixa(db).v - 55) < 0.01,
    JSON.stringify(caixa(db)));
}

// ════════════════════════════════════════════════════════════════════════════
// B. PIX online PAGO antes do faturamento — o defeito do enunciado
// ════════════════════════════════════════════════════════════════════════════
{
  console.log('── B. PIX online pago ──');
  const db = montar('b'); const app = montarApp(db);
  const ped = pedidoDoCatalogo(db, app);
  const crId = crDaLoja(db, ped, { pago: true });
  require('../contas-receber-routes').sincronizarPagamentoPedido(db, crId);
  const caixaAntes = caixa(db);

  entregar(app, ped.id);
  const f = faturar(app, ped.id);
  ok('B1 faturou', f.status === 200, JSON.stringify(f.body).slice(0, 140));

  const lista = crs(db);
  const soma = lista.filter((c) => c.status !== 'cancelada').reduce((s, c) => s + c.valor, 0);
  ok('B2 continua UMA só conta a receber', lista.length === 1, JSON.stringify(lista));
  ok('B3 o total financeiro é R$ 55, e não R$ 110', Math.abs(soma - 55) < 0.01, `R$ ${soma}`);
  ok('B4 a CR adotada continua PAGA', lista[0].status === 'paga');
  ok('B5 valorPago intacto em 55', Math.abs(lista[0].valorPago - 55) < 0.01, `${lista[0].valorPago}`);
  ok('B6 vinculada ao pedido E à fatura', lista[0].pedidoId === ped.id && lista[0].faturaId != null,
    JSON.stringify(lista[0]));
  ok('B7 origem preservada como "loja"', lista[0].origem === 'loja', lista[0].origem);
  ok('B8 nenhuma movimentação de caixa NOVA',
    caixa(db).n === caixaAntes.n && Math.abs(caixa(db).v - caixaAntes.v) < 0.01,
    `antes ${JSON.stringify(caixaAntes)} depois ${JSON.stringify(caixa(db))}`);
  ok('B9 a fatura aponta para essa mesma CR', (() => {
    const fat = db.prepare('SELECT contaReceberId FROM faturas WHERE pedidoId = ?').get(ped.id);
    return fat && fat.contaReceberId === lista[0].id;
  })());
  ok('B10 o pedido ficou faturado e pago',
    db.prepare('SELECT status, statusPagamento FROM pedidos WHERE id = ?').get(ped.id).status === 'faturado');
}

// ════════════════════════════════════════════════════════════════════════════
// C. PIX online PENDENTE — e o webhook que chega depois do faturamento
// ════════════════════════════════════════════════════════════════════════════
{
  console.log('── C. PIX online pendente, webhook posterior ──');
  const db = montar('c'); const app = montarApp(db);
  const ped = pedidoDoCatalogo(db, app);
  const crId = crDaLoja(db, ped, { pago: false });
  /* O Pix do Asaas, pendurado na CR. É ele que não pode ser emitido de novo.
     `amount`, `expirationDate`, `customerDocument` e `customerName` são NOT
     NULL na tabela — um INSERT enxuto estoura, e o fixture tem de refletir a
     linha que o orquestrador realmente grava. */
  db.prepare(`INSERT INTO boletos (contaReceberId, tipoCobranca, status, pixPayload, nossoNumero,
      amount, expirationDate, customerDocument, customerName)
    VALUES (?, 'pix', 'registrado', '00020126BR.GOV.BCB.PIX...', 'asaas-123',
      5500, date('now','+1 day'), '52998224725', 'MARIA DA SILVA')`).run(crId);

  entregar(app, ped.id);
  const f = faturar(app, ped.id);
  ok('C1 faturou com a cobrança ainda aberta', f.status === 200, JSON.stringify(f.body).slice(0, 140));

  let lista = crs(db);
  ok('C2 não duplicou', lista.length === 1, JSON.stringify(lista));
  ok('C3 a CR continua ABERTA', lista[0].status === 'aberta', lista[0].status);
  ok('C4 e agora pertence à fatura', lista[0].faturaId != null);
  ok('C5 o Pix do Asaas continua apontando para ela', (() => {
    const b = db.prepare('SELECT contaReceberId, status FROM boletos WHERE contaReceberId = ?').get(crId);
    return b && b.status === 'registrado';
  })());
  ok('C6 nenhum SEGUNDO Pix foi criado para a mesma CR',
    db.prepare('SELECT COUNT(*) c FROM boletos WHERE contaReceberId = ?').get(crId).c === 1,
    `${db.prepare('SELECT COUNT(*) c FROM boletos WHERE contaReceberId = ?').get(crId).c} cobranças`);

  /* O teste essencial: o webhook chega DEPOIS da vinculação. A baixa tem de
     funcionar igual — é o mesmo `contaReceberId` de sempre. */
  const { registrarBaixaCR, sincronizarPagamentoPedido } = require('../contas-receber-routes');
  registrarBaixaCR(db, {
    contaReceberId: crId,
    contaFinanceiraId: db.prepare('SELECT id FROM contas_financeiras LIMIT 1').get().id,
    formaPagamento: 'pix',
    origem: 'webhook_asaas',
    observacoes: 'Baixa automática via webhook (teste)',
  });
  sincronizarPagamentoPedido(db, crId);

  lista = crs(db);
  ok('C7 o webhook posterior BAIXOU a CR vinculada', lista[0].status === 'paga', lista[0].status);
  ok('C8 com o valor certo', Math.abs(lista[0].valorPago - 55) < 0.01, `${lista[0].valorPago}`);
  ok('C9 e o pedido virou pago',
    db.prepare('SELECT statusPagamento FROM pedidos WHERE id = ?').get(ped.id).statusPagamento === 'pago');
  ok('C10 uma única entrada no caixa', caixa(db).n === 1 && Math.abs(caixa(db).v - 55) < 0.01,
    JSON.stringify(caixa(db)));
  ok('C11 e continua sendo UMA conta a receber', crs(db).length === 1);
}

// ════════════════════════════════════════════════════════════════════════════
// D. Idempotência: faturar de novo
// ════════════════════════════════════════════════════════════════════════════
{
  console.log('── D. repetição ──');
  const db = montar('d'); const app = montarApp(db);
  const ped = pedidoDoCatalogo(db, app);
  crDaLoja(db, ped, { pago: true });
  entregar(app, ped.id);
  faturar(app, ped.id);
  const antes = crs(db).length;
  const f2 = faturar(app, ped.id);
  ok('D1 faturar de novo é recusado', f2.status !== 200, JSON.stringify(f2.body).slice(0, 110));
  ok('D2 e não criou CR nenhuma a mais', crs(db).length === antes, `${antes} → ${crs(db).length}`);
  ok('D3 nem uma segunda fatura',
    db.prepare('SELECT COUNT(*) c FROM faturas WHERE pedidoId = ?').get(ped.id).c === 1);
}

// ════════════════════════════════════════════════════════════════════════════
// E. Estados em que adotar seria errado: fail closed
// ════════════════════════════════════════════════════════════════════════════
{
  console.log('── E. fail closed ──');

  // duas cobranças vivas para o mesmo pedido
  {
    const db = montar('e1'); const app = montarApp(db);
    const ped = pedidoDoCatalogo(db, app);
    crDaLoja(db, ped, { pago: false });
    crDaLoja(db, ped, { pago: false });
    entregar(app, ped.id);
    recusa('E1 duas cobranças da loja: recusa em vez de escolher uma',
      faturar(app, ped.id), 'cobranças da loja');
    ok('E1b e nada foi criado', crs(db).length === 2, `${crs(db).length}`);
  }

  // estados que não podem ser adotados em silêncio
  for (const st of ['parcial', 'incobravel', 'renegociada']) {
    const db = montar('e-' + st); const app = montarApp(db);
    const ped = pedidoDoCatalogo(db, app);
    crDaLoja(db, ped, { status: st, valor: 55 });
    entregar(app, ped.id);
    recusa(`E2 CR "${st}": recusa, não adota em silêncio`,
      faturar(app, ped.id), 'não pode ser reaproveitada');
    ok(`E2 ${st}: nenhuma CR nova`, crs(db).length === 1, `${crs(db).length}`);
  }

  // cancelada NÃO bloqueia: deixou de ser cobrança, e a venda segue sem nota
  {
    const db = montar('e-cancel'); const app = montarApp(db);
    const ped = pedidoDoCatalogo(db, app);
    crDaLoja(db, ped, { status: 'cancelada' });
    entregar(app, ped.id);
    const f = faturar(app, ped.id);
    ok('E3 CR cancelada não bloqueia: o faturamento cria a dele', f.status === 200,
      JSON.stringify(f.body).slice(0, 110));
    const lista = crs(db);
    ok('E3b e a cancelada continua cancelada, sem vínculo',
      lista.length === 2 && lista[0].status === 'cancelada' && lista[0].faturaId === null,
      JSON.stringify(lista));
  }

  // valor incompatível
  {
    const db = montar('e-valor'); const app = montarApp(db);
    const ped = pedidoDoCatalogo(db, app);
    crDaLoja(db, ped, { valor: 40 });
    entregar(app, ped.id);
    recusa('E4 valor da cobrança diferente do total: recusa',
      faturar(app, ped.id), 'não confere com o');
  }

  // CR já pertencente a outra fatura
  {
    const db = montar('e-outra'); const app = montarApp(db);
    const ped = pedidoDoCatalogo(db, app);
    const crId = crDaLoja(db, ped, { pago: true });
    db.prepare('UPDATE contas_a_receber SET faturaId = 999 WHERE id = ?').run(crId);
    entregar(app, ped.id);
    recusa('E5 CR já vinculada a outra fatura: recusa',
      faturar(app, ped.id), 'já pertence à fatura');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// F. Pedido offline: nada muda
// ════════════════════════════════════════════════════════════════════════════
{
  console.log('── F. offline ──');

  // dinheiro: o caminho de sempre, com auto-baixa
  {
    const db = montar('f-dinheiro'); const app = montarApp(db);
    const ped = pedidoDoCatalogo(db, app, { pagamento: 'dinheiro' });
    entregar(app, ped.id);
    const f = faturar(app, ped.id);
    const lista = crs(db);
    ok('F1 dinheiro: faturou com uma CR de origem "fatura"',
      f.status === 200 && lista.length === 1 && lista[0].origem === 'fatura',
      `${f.status} ${JSON.stringify(lista)}`);
    ok('F2 dinheiro: auto-baixa preservada', lista[0].status === 'paga', lista[0].status);
  }

  /* ── LIMITAÇÃO CONHECIDA, anterior a esta correção ──────────────────────
   *
   * Pedido de catálogo pago com CARTÃO na entrega NÃO consegue ser faturado.
   * `faturas-routes.js` exige `bandeiraId` para meio '03' (a CR de cartão
   * precisa saber qual adquirente vai liquidar), e o checkout público não
   * pergunta a bandeira — o cliente escolhe "Cartão", não "Visa".
   *
   * Isto NÃO foi introduzido nem corrigido aqui: o erro nasce no laço das
   * parcelas, que só roda quando NÃO há cobrança da loja a adotar. O teste
   * fica, afirmando o comportamento real, para que o dia em que o cartão
   * for resolvido esta expectativa falhe e alguém venha atualizá-la.
   * Descoberto em 29/09/2026, ao cobrir o defeito da CR duplicada.
   */
  {
    const db = montar('f-cartao'); const app = montarApp(db);
    const ped = pedidoDoCatalogo(db, app, { pagamento: 'cartao' });
    entregar(app, ped.id);
    const f = faturar(app, ped.id);
    ok('F3 cartão do catálogo é RECUSADO no faturamento (limitação conhecida: sem bandeira)',
      f.status === 500 && /bandeira do cartão obrigatória/.test((f.body && f.body.error) || ''),
      `${f.status} ${JSON.stringify(f.body)}`);
    ok('F4 e a recusa não deixa conta a receber pela metade',
      crs(db).length === 0, JSON.stringify(crs(db)));
    ok('F5 o pedido também não ficou marcado como faturado',
      db.prepare('SELECT status FROM pedidos WHERE id = ?').get(ped.id).status === 'entregue');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// G. Troco: o financeiro continua sendo o da venda
// ════════════════════════════════════════════════════════════════════════════
{
  console.log('── G. troco ──');
  const db = montar('g'); const app = montarApp(db);
  const ped = pedidoDoCatalogo(db, app, { pagamento: 'dinheiro', precisaTroco: true, trocoPara: 60 });
  ok('G1 o valor entregue ficou guardado', ped.valorRecebidoDinheiro === 60,
    `${ped.valorRecebidoDinheiro}`);
  entregar(app, ped.id);
  faturar(app, ped.id);
  const lista = crs(db);
  ok('G2 a CR é de R$ 55 (a venda), não de R$ 60 (o entregue)',
    lista.length === 1 && Math.abs(lista[0].valor - 55) < 0.01, JSON.stringify(lista));
  ok('G3 e o caixa recebeu R$ 55', Math.abs(caixa(db).v - 55) < 0.01, JSON.stringify(caixa(db)));
}

console.log(`\n${total - falhas}/${total} asserts passaram`);
for (const d of abertos) { try { d.close(); } catch (_) {} }
fs.rmSync(tmp, { recursive: true, force: true });
if (falhas) { console.log(`FALHA: ${falhas} problema(s)`); process.exit(1); }
console.log('TODOS OS ASSERTS PASSARAM');
