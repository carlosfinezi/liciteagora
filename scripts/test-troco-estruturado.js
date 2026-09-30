/**
 * Troco estruturado: do checkout ao XML, e a separação do financeiro.
 *
 * Três coisas estão sob prova, e a terceira é a que mais importa:
 *
 *  1. o checkout valida e persiste o valor RECEBIDO (nunca o troco);
 *  2. o montador e o motor produzem `vPag` e `<vTroco>` corretos, na ordem
 *     que o schema exige;
 *  3. o FINANCEIRO nunca enxerga o dinheiro físico. Pedido de R$ 55 pago com
 *     R$ 60 gera R$ 55 de receita, e não R$ 60 — se essa linha se romper, a
 *     empresa passa a declarar como faturamento o troco que devolveu.
 *
 * Banco descartável, SEFAZ substituída por duble, nada transmitido.
 *
 * Roda da raiz do projeto:  node scripts/test-troco-estruturado.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const SCHEMA = require('./schema-de-tenant').schemaDeTenant();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'troco-'));
const abertos = [];

let falhas = 0;
let total = 0;
function ok(nome, condicao, detalhe) {
  total++;
  if (condicao) console.log(`  ok   ${nome}`);
  else { falhas++; console.log(`  FALHA ${nome}${detalhe ? ' — ' + detalhe : ''}`); }
}

// ── tenant descartável, com a loja configurada ──────────────────────────────
function montar(nome) {
  const db = new Database(path.join(tmp, nome + '.db'));
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA);
  require('../db-schema').initSchema(db);
  require('../loja-routes').migrarLojaDB(db);
  try { require('../tipos-operacao-routes').migrar(db); } catch (_) {}
  try {
    const descartavel = { get() {}, post() {}, put() {}, delete() {}, use() {} };
    require('../nfce-routes').registrarRotasNFCe(descartavel, db);
  } catch (_) {}
  db.pragma('foreign_keys = ON');
  abertos.push(db);
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL, caminho TEXT, ordem INTEGER DEFAULT 0)`);
  db.prepare(`INSERT INTO produtos (sku, descricao, categoria, unidade, ativo, publicadoNaLoja,
      precoVenda, ncm, cfopPadrao, csosn, cstPIS, cstCOFINS, origem)
    VALUES ('S1','CESTA','CESTAS','UN',1,1,55,'09109900','5102','102','49','49','0')`).run();
  db.exec("INSERT INTO movimentacoes_estoque (produtoId,tipo,quantidade,data) VALUES (1,'entrada',100,date('now'))");
  db.prepare(`UPDATE loja_config SET ativa=1, nome='LOJA TROCO', whatsapp='44999990000',
    servicoRetirada=1, servicoDelivery=0, freteModo='gratis', mostrarPreco=1 WHERE id=1`).run();
  const nat = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo='VDA-NORMAL' AND ativo=1`).get()
    || db.prepare(`SELECT id FROM tipos_operacao WHERE ativo=1 AND usarEmPedido=1 ORDER BY id LIMIT 1`).get();
  db.prepare('UPDATE loja_config SET tipoOperacaoPedidoId=? WHERE id=1').run(nat.id);
  /* Caixa padrão: sem ele a auto-baixa do dinheiro
     (`faturas-routes.js:396` → `getContaPadrao(db,'caixa')`) lança "Conta
     financeira padrão não configurada" e o faturamento inteiro falha. Um
     tenant de verdade tem essa conta; o banco descartável precisa dela para
     o bloco do financeiro medir o que promete, e não a falta do seed. */
  if (!db.prepare('SELECT 1 FROM contas_financeiras WHERE ehCaixaPadrao=1 AND ativo=1').get()) {
    db.prepare(`INSERT INTO contas_financeiras (nome, tipo, saldoInicial, ehCaixaPadrao, ativo)
      VALUES ('CAIXA DA LOJA', 'caixa', 0, 1, 1)`).run();
  }
  return db;
}

function montarApp(db) {
  const rotas = new Map();
  const reg = (m) => (url, ...fns) => rotas.set(m + ' ' + url, fns[fns.length - 1]);
  const app = {
    get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), use() {},
    chamar(m, url, body) {
      const fn = rotas.get(m + ' ' + url);
      if (!fn) throw new Error('rota não registrada: ' + m + ' ' + url);
      let saida = null, status = 200;
      const res = { json: (d) => { saida = d; return res; },
                    status: (s) => { status = s; return res; },
                    setHeader() { return res; }, end() { return res; } };
      fn({ body: body || {}, query: {}, params: (body && body.__params) || {},
           session: { username: 'suite' }, protocol: 'https', get: () => 'loja.local' }, res);
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
/** Uma cesta de R$ 55: o número do exemplo do pedido. */
const pedido = (extra) => ({
  idempotencyKey: crypto.randomUUID(),
  cliente: { nome: 'MARIA DA SILVA', telefone: '44999887766' },
  atendimento: 'retirada', pagamento: 'dinheiro',
  itens: [{ produtoId: 1, quantidade: 1 }],
  ...extra,
});
const doBanco = (db, numero) =>
  db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(numero);

// ════════════════════════════════════════════════════════════════════════════
// A. O checkout: o que é aceito, o que é recusado, o que é persistido
// ════════════════════════════════════════════════════════════════════════════
{
  console.log('── A. checkout ──');

  // A1: o caso do enunciado — R$ 55, cliente entrega R$ 60
  {
    const db = montar('a1'); const app = montarApp(db);
    const r = app.chamar('POST', FINALIZAR, pedido({ precisaTroco: true, trocoPara: 60 }));
    ok('A1 pedido de R$55 com troco para R$60 é aceito', r.status === 200, JSON.stringify(r.body));
    const p = doBanco(db, r.body.numero);
    ok('A1b o valor RECEBIDO ficou estruturado', p.valorRecebidoDinheiro === 60,
      `gravou ${p.valorRecebidoDinheiro}`);
    ok('A1c o total do pedido continua sendo o da venda', p.valorTotal === 55, `${p.valorTotal}`);
    ok('A1d NÃO existe coluna de troco no banco', (() => {
      const cols = db.prepare('PRAGMA table_info(pedidos)').all().map((c) => c.name);
      return !cols.some((c) => /troco/i.test(c));
    })());
    ok('A1e a linha de texto continua na observação (histórico, não fonte)',
      /Troco para: R\$ 60,00/.test(p.observacao), p.observacao);
  }

  // A2: recebe exatamente o total → NULL, porque não há troco
  {
    const db = montar('a2'); const app = montarApp(db);
    const r = app.chamar('POST', FINALIZAR, pedido({ precisaTroco: true, trocoPara: 55 }));
    ok('A2 recebe exatamente R$55: aceito', r.status === 200, JSON.stringify(r.body));
    const p = doBanco(db, r.body.numero);
    ok('A2b e NÃO grava valor recebido (não há troco a dar)',
      p.valorRecebidoDinheiro === null, `gravou ${p.valorRecebidoDinheiro}`);
  }

  // A3: os valores que têm de ser recusados
  {
    const casos = [
      ['menor que o total', 50, /a partir de 55,00/],
      ['zero', 0, /Informe para quanto/],
      ['negativo', -10, /Informe para quanto/],
      ['texto', 'abacaxi', /Informe para quanto/],
      ['vazio', '', /Informe para quanto/],
      ['nulo', null, /Informe para quanto/],
      ['NaN explícito', Number.NaN, /Informe para quanto/],
    ];
    for (const [nome, valor, regex] of casos) {
      const db = montar('a3-' + nome.replace(/\W/g, '')); const app = montarApp(db);
      const antes = db.prepare('SELECT COUNT(*) c FROM pedidos').get().c;
      const r = app.chamar('POST', FINALIZAR, pedido({ precisaTroco: true, trocoPara: valor }));
      ok(`A3 ${nome}: recusado com 422`, r.status === 422 && regex.test(r.body.error || ''),
        `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
      ok(`A3 ${nome}: e nenhum pedido foi criado`,
        db.prepare('SELECT COUNT(*) c FROM pedidos').get().c === antes);
    }
  }

  // A4: não-dinheiro ignora o troco, mesmo adulterado
  {
    for (const pag of ['pix', 'cartao']) {
      const db = montar('a4-' + pag); const app = montarApp(db);
      const r = app.chamar('POST', FINALIZAR,
        pedido({ pagamento: pag, precisaTroco: true, trocoPara: 999 }));
      ok(`A4 ${pag} com trocoPara adulterado: aceito e IGNORADO`, r.status === 200,
        JSON.stringify(r.body).slice(0, 90));
      const p = doBanco(db, r.body.numero);
      ok(`A4 ${pag}: valorRecebidoDinheiro é NULL`, p.valorRecebidoDinheiro === null,
        `gravou ${p.valorRecebidoDinheiro}`);
      ok(`A4 ${pag}: e nada de troco na observação`, !/Troco/.test(p.observacao), p.observacao);
    }
  }

  // A5: dinheiro SEM marcar troco
  {
    const db = montar('a5'); const app = montarApp(db);
    const r = app.chamar('POST', FINALIZAR, pedido({ trocoPara: 90 }));  // sem precisaTroco
    ok('A5 dinheiro sem precisaTroco: trocoPara é ignorado', r.status === 200);
    ok('A5b valorRecebidoDinheiro NULL', doBanco(db, r.body.numero).valorRecebidoDinheiro === null);
  }

  // A6: o total é do SERVIDOR — mandar total no corpo não muda nada
  {
    const db = montar('a6'); const app = montarApp(db);
    const r = app.chamar('POST', FINALIZAR,
      pedido({ precisaTroco: true, trocoPara: 20, total: 10, valorTotal: 10, subtotal: 10 }));
    ok('A6 total forjado no corpo não afeta a validação (20 < 55 → recusa)',
      r.status === 422 && /a partir de 55,00/.test(r.body.error || ''),
      JSON.stringify(r.body).slice(0, 110));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// B. O FINANCEIRO nunca vê o dinheiro físico
// ════════════════════════════════════════════════════════════════════════════
{
  console.log('── B. financeiro ──');
  const db = montar('b1'); const app = montarApp(db);
  const r = app.chamar('POST', FINALIZAR, pedido({ precisaTroco: true, trocoPara: 60 }));
  const p = doBanco(db, r.body.numero);
  const id = p.id;

  app.chamar('POST', '/api/pedidos/:id/entregar', { __params: { id: String(id) } });
  const fat = app.chamar('POST', '/api/pedidos/:id/faturar', { __params: { id: String(id) } });
  ok('B0 (preparo) o pedido foi entregue e faturado', fat.status === 200,
    JSON.stringify(fat.body).slice(0, 140));

  const f = db.prepare('SELECT * FROM faturas WHERE pedidoId = ?').get(id);
  const crs = db.prepare('SELECT * FROM contas_a_receber WHERE faturaId = ?').all(f && f.id);
  const movs = db.prepare(`SELECT * FROM movimentacoes_financeiras WHERE origem='fatura_avista'`).all();

  /* O coração da etapa: R$ 55 em toda parte, nunca R$ 60. */
  ok('B1 a fatura vale o total da venda (55), não o entregue (60)',
    f && Math.abs(f.valorTotal - 55) < 0.01, f ? `${f.valorTotal}` : '(sem fatura)');
  ok('B2 a conta a receber é de 55', crs.length === 1 && Math.abs(crs[0].valor - 55) < 0.01,
    crs.map((c) => c.valor).join(','));
  ok('B3 a baixa automática do dinheiro registrou 55',
    crs.length === 1 && Math.abs((crs[0].valorPago || 0) - 55) < 0.01,
    crs.length ? `${crs[0].valorPago}` : '—');
  ok('B4 o caixa recebeu 55, e não 60',
    movs.length === 1 && Math.abs(movs[0].valor - 55) < 0.01,
    movs.map((m) => m.valor).join(','));
  ok('B5 pedidos.valorPago não foi contaminado pelo entregue',
    (doBanco(db, r.body.numero).valorPago || 0) !== 60,
    `${doBanco(db, r.body.numero).valorPago}`);
  ok('B6 e o valor recebido continua guardado, intacto, só para o fiscal',
    doBanco(db, r.body.numero).valorRecebidoDinheiro === 60);

  /* A prova por escopo: nenhum arquivo do financeiro conhece a coluna. Um
     `SELECT ... valorRecebidoDinheiro` em faturas-routes passaria despercebido
     num teste de valores se a conta desse certo por acaso. */
  for (const arq of ['faturas-routes.js', 'pedidos-routes.js', 'fatura-cancelamento.js']) {
    const src = fs.readFileSync(path.join(RAIZ, arq), 'utf8');
    ok(`B7 ${arq} não conhece valorRecebidoDinheiro`,
      !src.includes('valorRecebidoDinheiro'));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// C. O montador: vPag e vTroco
// ════════════════════════════════════════════════════════════════════════════
{
  console.log('── C. montador ──');
  const { payloadDeNFCeDePedido } = require('../nfce-payload');
  const db = montar('c1'); const app = montarApp(db);
  const emitente = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get()
    || (db.prepare(`INSERT INTO fornecedor (razaoSocial, cnpj, uf, cidade, codigoMunicipio,
         inscricaoEstadual, endereco, numero, bairro, cep)
       VALUES ('LOJA','12345678000199','PA','MARABA','1504208','123','R','1','C','68500000')`).run(),
      db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get());

  const criar = (extra) => {
    const r = app.chamar('POST', FINALIZAR, pedido(extra));
    if (r.status !== 200) throw new Error('checkout recusou: ' + JSON.stringify(r.body));
    return doBanco(db, r.body.numero).id;
  };

  // com troco
  {
    const id = criar({ precisaTroco: true, trocoPara: 60 });
    const { payload } = payloadDeNFCeDePedido(db, id, { emitente });
    ok('C1 vPag é o valor ENTREGUE (60)', payload.pagamentos[0].valor === 60,
      `${payload.pagamentos[0].valor}`);
    ok('C2 vTroco é a diferença (5)', payload.vTroco === 5, `${payload.vTroco}`);
    ok('C3 o meio continua dinheiro', payload.pagamentos[0].tPag === '01');
  }
  // sem troco (recebido igual ao total → coluna NULL)
  {
    const id = criar({ precisaTroco: true, trocoPara: 55 });
    const { payload } = payloadDeNFCeDePedido(db, id, { emitente });
    ok('C4 sem troco: vPag é o total', payload.pagamentos[0].valor === 55);
    ok('C5 e vTroco é null (nenhuma tag será emitida)', payload.vTroco === null);
  }
  // pedido antigo: coluna NULL
  {
    const id = criar({});
    db.prepare('UPDATE pedidos SET valorRecebidoDinheiro = NULL WHERE id = ?').run(id);
    const { payload } = payloadDeNFCeDePedido(db, id, { emitente });
    ok('C6 pedido legado (coluna NULL): comportamento de antes',
      payload.pagamentos[0].valor === 55 && payload.vTroco === null);
  }
  // PIX com a coluna adulterada direto no banco
  {
    const id = criar({ pagamento: 'pix' });
    db.prepare('UPDATE pedidos SET valorRecebidoDinheiro = 999 WHERE id = ?').run(id);
    const { payload } = payloadDeNFCeDePedido(db, id, { emitente });
    ok('C7 PIX ignora a coluna mesmo adulterada no banco',
      payload.pagamentos[0].valor === 55 && payload.vTroco === null,
      `vPag=${payload.pagamentos[0].valor} vTroco=${payload.vTroco}`);
  }
  // centavos: a conta não pode escorregar em ponto flutuante
  {
    db.prepare('UPDATE produtos SET precoVenda = 55.37 WHERE id = 1').run();
    const r = app.chamar('POST', FINALIZAR, pedido({ precisaTroco: true, trocoPara: 60.1 }));
    const id = doBanco(db, r.body.numero).id;
    const { payload } = payloadDeNFCeDePedido(db, id, { emitente });
    ok('C8 centavos: 60,10 − 55,37 = 4,73 exatos', payload.vTroco === 4.73,
      `${payload.vTroco}`);
    db.prepare('UPDATE produtos SET precoVenda = 55 WHERE id = 1').run();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// D. O motor: invariante, ordem no XML e recusa de inconsistência
// ════════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('── D. motor ──');
  const lib = await import('node-sped-nfe');
  let xmlEspiao = null;
  lib.Tools.prototype.xmlSign = async function (x) { xmlEspiao = x; return x; };
  lib.Tools.prototype.sefazEnviaLote = async function (x) {
    const chave = (x.match(/Id="NFe(\d{44})"/) || [])[1] || '0'.repeat(44);
    return '<retEnviNFe><cStat>104</cStat><protNFe><infProt>'
      + `<chNFe>${chave}</chNFe><cStat>100</cStat><xMotivo>Autorizado</xMotivo>`
      + '<nProt>111</nProt></infProt></protNFe></retEnviNFe>';
  };

  const db = montar('d1');
  db.prepare(`INSERT INTO certificado_digital (id, certificadoBase64, senhaCriptografada, titular, validade)
    VALUES (1, ?, ?, 'T', '2030-01-01')`)
    .run(Buffer.from('pfx').toString('base64'), Buffer.from('s').toString('base64'));
  db.prepare(`UPDATE nfce_config SET tpAmb=2, serie=1, proximoNumero=1,
    csc='CSC-TESTE', cscId='000001' WHERE id=1`).run();
  if (!db.prepare('SELECT 1 FROM fornecedor LIMIT 1').get()) {
    db.prepare(`INSERT INTO fornecedor (razaoSocial, cnpj, uf, cidade, codigoMunicipio,
        inscricaoEstadual, endereco, numero, bairro, cep)
      VALUES ('LOJA','12345678000199','PA','MARABA','1504208','123','R','1','C','68500000')`).run();
  }
  const nat = db.prepare(`SELECT * FROM tipos_operacao WHERE emiteNFe=1 AND ativo=1
    AND categoriaOperacao='venda' ORDER BY id LIMIT 1`).get();
  const { emitirNFCe } = require('../nfce-routes');

  const base = (extra) => Object.assign({
    tipoOperacaoId: nat.id,
    itens: [{ produtoId: 1, sku: 'S1', descricao: 'CESTA', ncm: '09109900', unidade: 'UN',
              quantidade: 1, precoUnitario: 55, valorTotal: 55 }],
    consumidorCpfCnpj: '52998224725', consumidorNome: 'MARIA',
    efeitosJaAplicados: true,
  }, extra);

  // D1: o caso do enunciado, ponta a ponta no XML
  {
    xmlEspiao = null;
    const r = await emitirNFCe(db, base({
      pagamentos: [{ tPag: '01', valor: 60 }], vTroco: 5,
    }));
    const pag = (xmlEspiao.match(/<pag>[\s\S]*?<\/pag>/) || [''])[0];
    ok('D1 autorizada com troco', r.cStat === '100', `${r.cStat} ${r.xMotivo}`);
    ok('D2 vPag = 60,00 no XML', /<vPag>60.00<\/vPag>/.test(pag), pag);
    ok('D3 vTroco = 5,00 no XML', /<vTroco>5.00<\/vTroco>/.test(pag), pag);
    ok('D4 <detPag> vem ANTES de <vTroco>', pag.indexOf('<detPag>') < pag.indexOf('<vTroco>'), pag);
    ok('D5 o total da nota continua 55,00',
      /<vNF>55.00<\/vNF>/.test(xmlEspiao), (xmlEspiao.match(/<vNF>[^<]*/) || [''])[0]);
    console.log(`       XML do grupo pag: ${pag}`);
  }

  // D6: sem troco — nenhuma tag
  {
    xmlEspiao = null;
    await emitirNFCe(db, base({ pagamentos: [{ tPag: '01', valor: 55 }] }));
    ok('D6 sem vTroco no payload: nenhuma tag no XML', !/<vTroco>/.test(xmlEspiao));
  }
  // D7: vTroco = 0 explícito — também sem tag
  {
    xmlEspiao = null;
    await emitirNFCe(db, base({ pagamentos: [{ tPag: '01', valor: 55 }], vTroco: 0 }));
    ok('D7 vTroco = 0: nenhuma tag', !/<vTroco>/.test(xmlEspiao));
  }

  // D8-D12: a invariante recusa o que não fecha
  const recusa = async (nome, payload, trecho) => {
    let erro = null;
    try { await emitirNFCe(db, base(payload)); } catch (e) { erro = e.message; }
    ok(nome, erro && new RegExp(trecho).test(erro), erro || '(não recusou)');
  };
  await recusa('D8 soma inconsistente (paga 60, troco 2, total 55) é recusada',
    { pagamentos: [{ tPag: '01', valor: 60 }], vTroco: 2 }, 'não bate com o total');
  await recusa('D9 troco maior que a diferença é recusado',
    { pagamentos: [{ tPag: '01', valor: 60 }], vTroco: 10 }, 'não bate com o total');
  await recusa('D10 troco negativo é recusado',
    { pagamentos: [{ tPag: '01', valor: 60 }], vTroco: -5 }, 'Valor de troco inválido');
  await recusa('D11 troco não finito é recusado',
    { pagamentos: [{ tPag: '01', valor: 60 }], vTroco: Infinity }, 'Valor de troco inválido');
  await recusa('D12 troco em PIX é recusado',
    { pagamentos: [{ tPag: '17', valor: 60 }], vTroco: 5 }, 'só existe em pagamento em dinheiro');
  await recusa('D13 pagamento MENOR que o total continua recusado',
    { pagamentos: [{ tPag: '01', valor: 50 }] }, 'não bate com o total');

  // D14: o legado — PDV/restaurante, que nunca mandam vTroco
  {
    xmlEspiao = null;
    const r = await emitirNFCe(db, base({ pagamentos: [{ tPag: '03', valor: 55 }] }));
    ok('D14 cartão sem troco (PDV/restaurante) emite como antes',
      r.cStat === '100' && !/<vTroco>/.test(xmlEspiao) && /<vPag>55.00<\/vPag>/.test(xmlEspiao));
  }

  // D15: o DANFCe recebe o dado no formato que já sabe ler
  {
    xmlEspiao = null;
    const r = await emitirNFCe(db, base({ pagamentos: [{ tPag: '01', valor: 60 }], vTroco: 5 }));
    const salvo = db.prepare('SELECT xmlAssinado FROM nfce WHERE id = ?').get(r.id).xmlAssinado;
    /* O vendor lê `xml.NFe.infNFe.pag.vTroco` (index.js:984). O que se prova
       aqui é que o XML GRAVADO — o que alimenta o cupom — tem o campo nesse
       caminho, com o valor certo. O PDF em si já foi provado noutra suíte. */
    const { XMLParser } = require('fast-xml-parser');
    const j = new XMLParser({ ignoreAttributes: false }).parse(salvo);
    const raiz = j.nfeProc ? j.nfeProc.NFe : j.NFe;
    /* Comparação NUMÉRICA: o parser devolve `5` (number) para `<vTroco>5.00`,
       e o vendor faz `parseFloat(pag.vTroco)` (index.js:984) — o formato de
       string não importa para ele, o valor sim. Comparar com '5.00' reprovava
       um dado perfeitamente correto. */
    ok('D15 o DANFCe acha o troco em NFe.infNFe.pag.vTroco',
      Number(raiz.infNFe.pag.vTroco) === 5, JSON.stringify(raiz.infNFe.pag));
    ok('D16 e o vPag que o cupom vai imprimir é o entregue',
      Number(raiz.infNFe.pag.detPag.vPag) === 60, JSON.stringify(raiz.infNFe.pag.detPag));
  }

  console.log(`\n${total - falhas}/${total} asserts passaram`);
  for (const d of abertos) { try { d.close(); } catch (_) {} }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (falhas) { console.log(`FALHA: ${falhas} problema(s)`); process.exit(1); }
  console.log('TODOS OS ASSERTS PASSARAM');
})().catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });
