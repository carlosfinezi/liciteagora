/**
 * Contrato -> pedido de compra: a guarda contra duplicata.
 *
 * O caso que originou: o botão "Gerar pedido de compra" de contrato.html criava
 * um pedido a cada clique, sem olhar o que já existia. No tenant 1bit o item 3
 * acabou com TRÊS pedidos (PC-2026-0001/0002/0003), dois cancelados à mão
 * depois; o item 6, com dois.
 *
 * O que a guarda NÃO pode fazer é proibir: item anual num contrato de vários
 * anos precisa de uma compra por ciclo, e essa é uma duplicata legítima. Por
 * isso o servidor responde 409 com o que já existe e espera `confirmar: true`,
 * em vez de recusar.
 *
 * Banco DESCARTÁVEL em /tmp — nada aqui toca data/.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const RAIZ = path.join(__dirname, '..');
const Database = require(path.join(RAIZ, 'node_modules/better-sqlite3'));
const express = require(path.join(RAIZ, 'node_modules/express'));
const { registrarRotasContratos } = require(path.join(RAIZ, 'contratos-routes.js'));

let okN = 0, falhas = 0;
const t = (n, f) => { try { f(); console.log('  OK  ' + n); okN++; } catch (e) { falhas++; console.log('FALHA ' + n + ' -> ' + e.message); } };
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'contrato-pc-'));
const db = new Database(path.join(TMP, 'teste.db'));

// Schema real do tenant, e não um recorte escrito à mão: é o mesmo caminho que
// `scripts/test-catalogo-fase52.js` usa. Recorte manual passa a medir o recorte
// — uma coluna que exista só aqui, ou só lá, e o teste deixa de falar do
// sistema.
db.pragma('foreign_keys = OFF');
// initSchema e migrarDB narram cada ALTER; o que interessa aqui é o resultado.
const logReal = console.log;
console.log = () => {};
require(path.join(RAIZ, 'db-schema')).initSchema(db);
db.pragma('foreign_keys = ON');

const app = express();
app.use(express.json());
// `contratos` tem FOREIGN KEY para nfse_recorrencias, e as conexões do servidor
// rodam com foreign_keys = ON (tenant-manager.js:138). Quem cria essa tabela é
// o módulo de recorrência — chamado aqui pela via real, em vez de um CREATE
// escrito à mão que sairia do ar no dia em que o schema de lá mudar.
require(path.join(RAIZ, 'recorrencia-routes.js')).registrarRotasRecorrencia(app, db);
// `pedidos_compra` e `pedido_compra_itens` nascem do módulo de Compras, não do
// db-schema — e é nele que o pedido gerado aqui vai aterrissar.
require(path.join(RAIZ, 'compras-routes.js')).migrarPedidosCompraDB(db);
registrarRotasContratos(app, db);   // migrarDB() roda aqui
console.log = logReal;

db.prepare("INSERT INTO pessoas (id, razaoSocial, cpfCnpj) VALUES (1,'CLIENTE TESTE LTDA','00000000000191')").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, precoVenda, precoCusto, fornecedorId) VALUES (1,'SSL-WILD-OV','Certificado Wildcard OV',500,319.47,1)").run();
// Produto sem fornecedor: prova que a guarda de duplicata não atropela as
// validações que vêm antes dela.
db.prepare("INSERT INTO produtos (id, sku, descricao, precoVenda, precoCusto, fornecedorId) VALUES (2,'ORFAO-1','Produto orfao',10,5,NULL)").run();

const colsContrato = db.prepare('PRAGMA table_info(contratos)').all().map((c) => c.name);
ok(colsContrato.includes('clienteId'), 'migrarDB() não criou contratos como esperado');
db.prepare(`INSERT INTO contratos (id, numero, clienteId, descricao, valorMensal, status, dataInicio)
            VALUES (1,'CT-2026-0001',1,'Contrato de teste',650,'ativo','2026-01-01')`).run();

const novoItem = (produtoId, periodicidade) => db.prepare(`
  INSERT INTO contratos_itens (contratoId, produtoId, descricao, quantidade, valorUnitario, periodicidade)
  VALUES (1, ?, 'Certificado Wildcard OV', 1, 319.47, ?)`).run(produtoId, periodicidade).lastInsertRowid;

const ITEM_A = novoItem(1, 'anual');    // o fluxo normal
const ITEM_B = novoItem(1, 'anual');    // para o caso "só cancelado"
const ITEM_C = novoItem(1, 'anual');    // para o caso "recebido"
const ITEM_SEM_FORN = novoItem(2, 'anual');

const srv = http.createServer(app);

function gerar(itemId, body) {
  return fetch(`${BASE}/api/contratos/1/itens/${itemId}/pedido-compra`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
const pedidosDo = (itemId) => db.prepare('SELECT numero, status FROM pedidos_compra WHERE contratoItemId = ? ORDER BY id').all(itemId);

let BASE;
(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + srv.address().port;

  // ---- o caminho normal ----
  const r1 = await gerar(ITEM_A);
  t('1. o primeiro pedido do item é criado sem atrito', () => {
    eq(r1.status, 200, 'status');
    ok(r1.body.success, 'success');
    ok(/^PC-\d{4}-0001$/.test(r1.body.numero), 'numeração: ' + r1.body.numero);
    eq(pedidosDo(ITEM_A).length, 1, 'pedidos no banco');
  });

  // ---- o defeito relatado ----
  const r2 = await gerar(ITEM_A);
  t('2. o segundo clique NÃO cria pedido — devolve 409 e a decisão', () => {
    eq(r2.status, 409, 'status');
    eq(r2.body.success, false, 'success');
    eq(r2.body.precisaDecisao, true, 'precisaDecisao');
    eq(pedidosDo(ITEM_A).length, 1, 'nada pode ter sido criado');
  });

  t('3. o 409 diz QUAL pedido já existe, não só que existe', () => {
    ok(Array.isArray(r2.body.pedidos), 'lista de pedidos ausente');
    eq(r2.body.pedidos.length, 1, 'pedidos listados');
    const p = r2.body.pedidos[0];
    eq(p.numero, r1.body.numero, 'número do pedido existente');
    eq(p.status, 'rascunho', 'status');
    ok(p.dataEmissao, 'data de emissão ausente — a tela a imprime na confirmação');
  });

  // ---- a duplicata legítima: renovação de ciclo ----
  const r3 = await gerar(ITEM_A, { confirmar: true });
  t('4. com `confirmar` o pedido é criado — renovação de ciclo não pode ser proibida', () => {
    eq(r3.status, 200, 'status');
    ok(r3.body.success, 'success');
    eq(pedidosDo(ITEM_A).length, 2, 'pedidos no banco');
    ok(r3.body.numero !== r1.body.numero, 'o segundo pedido repetiu a numeração do primeiro');
  });

  // ---- pedido cancelado não é compra ----
  t('5. pedido cancelado não dispara o aviso', () => {
    db.prepare(`INSERT INTO pedidos_compra (numero, fornecedorId, status, dataEmissao, valorTotal, contratoItemId)
                VALUES ('PC-2026-9001', 1, 'cancelado', '2026-08-21', 319.47, ?)`).run(ITEM_B);
  });
  const r5 = await gerar(ITEM_B);
  t('5b. item cujo único pedido foi cancelado gera direto, sem 409', () => {
    eq(r5.status, 200, 'status — cancelado não é compra e não deveria avisar');
    ok(r5.body.success, 'success');
  });

  // ---- o caso que uma guarda ingênua deixaria passar ----
  t('6. pedido RECEBIDO também dispara o aviso', () => {
    db.prepare(`INSERT INTO pedidos_compra (numero, fornecedorId, status, dataEmissao, valorTotal, contratoItemId)
                VALUES ('PC-2026-9002', 1, 'recebido', '2026-08-20', 319.47, ?)`).run(ITEM_C);
  });
  const r6 = await gerar(ITEM_C);
  t('6b. a duplicata real nasceu 1 dia após um pedido já recebido — tem de avisar', () => {
    eq(r6.status, 409, 'status — guarda que só olha pedido em aberto não pegaria o PC-2026-0002 real');
    eq(r6.body.pedidos[0].status, 'recebido', 'status listado');
  });

  // ---- a guarda não pode atropelar as validações anteriores ----
  const r7 = await gerar(ITEM_SEM_FORN);
  t('7. erro de fornecedor continua vindo antes do aviso de duplicata', () => {
    eq(r7.status, 400, 'status');
    ok(/fornecedor/i.test(r7.body.error), 'mensagem: ' + r7.body.error);
    ok(!r7.body.precisaDecisao, 'não deveria pedir decisão sobre um pedido que nem pode existir');
  });

  const r8 = await gerar(99999);
  t('8. item inexistente continua 404', () => {
    eq(r8.status, 404, 'status');
  });

  // ---- o rastro ----
  t('9. o log distingue a duplicata confirmada do pedido comum', () => {
    const rotas = fs.readFileSync(path.join(RAIZ, 'contratos-routes.js'), 'utf8');
    ok(/duplicataConfirmada: !!req\.body\.confirmar/.test(rotas),
       'sem esse campo, renovação de ciclo e clique repetido ficam idênticos no audit_log');
  });

  // ---- a ponta da tela ----
  //
  // A sintaxe deste inline já é checada pelo passo 3 do verify; o que falta é o
  // significado: que a tela reconheça o 409 em vez de mostrá-lo como erro seco,
  // e que reenvie confirmando. Sem isso o backend guarda e a tela não sabe.
  const vm = require('vm');
  const HTML = fs.readFileSync(path.join(RAIZ, 'public/comercial/contrato.html'), 'utf8');
  const inline = [...HTML.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const js = inline.join('\n');

  t('10. o script inline da tela parseia', () => {
    ok(inline.length > 0, 'nenhum script inline encontrado');
    inline.forEach((src, i) => {
      try { new vm.Script(src, { filename: `contrato.html#${i}` }); }
      catch (e) { throw new Error(`bloco ${i}: ${e.message}`); }
    });
  });

  t('11. a tela trata o 409 e reenvia com `confirmar`', () => {
    ok(/precisaDecisao/.test(js), 'a tela ignora o 409 — o usuário veria só "erro"');
    ok(/confirm\(/.test(js), 'sem confirmação, o escape vira clique cego');
    ok(/gerarPedidoCompra\(itemId,\s*true\)/.test(js), 'a tela não reenvia confirmando');
    // A lista tem de chegar ao texto da confirmação: "tem certeza?" sem dizer
    // o que já existe não é decisão informada.
    ok(/d\.pedidos/.test(js), 'a confirmação não mostra os pedidos existentes');
  });

  srv.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n  ${okN} ok, ${falhas} falha(s)\n`);
  process.exit(falhas ? 1 : 0);
})();
