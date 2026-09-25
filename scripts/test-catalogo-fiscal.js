/**
 * Fundação fiscal do Catálogo Online (Fase 1, 2026-09-21).
 *
 * O que estes casos guardam, e por quê:
 *
 *   NATUREZA NO NASCIMENTO. Até 2026-09-20 o pedido do catálogo nascia com
 *   `tipoOperacaoId` NULL, e o ERP decidia três coisas fiscais por fallback:
 *   gerar financeiro, ser fiscal e movimentar estoque, todas por omissão.
 *   Funcionava por acidente. Agora a natureza é exigida ANTES de existir
 *   pessoa, pedido, item ou reserva.
 *
 *   A REGRA DE ESTOQUE É A CANÔNICA. O catálogo não tem regra própria: quem
 *   decide reservar é `pedidoMovimentaEstoque`, dentro de
 *   `criarReservasPedido`. Se um dia alguém escrever um `if` de estoque no
 *   catálogo, os casos G continuam passando e é isso que os torna fracos —
 *   por isso eles medem a AUSÊNCIA de reserva com natureza que não movimenta,
 *   e não a presença de um `if`.
 *
 *   A FRONTEIRA DO EMISSOR. `emitirNFCe` ganhou três campos OPCIONAIS. Omitir
 *   os três é o caminho de sempre, e é o que PDV e restaurante fazem — os
 *   casos I provam que o comportamento legado não mudou, porque é isso que
 *   uma mudança compatível precisa provar.
 *
 * NADA aqui transmite para a SEFAZ. Os casos do emissor exercitam as funções
 * que decidem natureza, vínculo e efeitos, que são exatamente as que esta fase
 * mexeu; a conversa com o fisco não foi tocada.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };
const FILTRO = process.argv[2] || null;
let ok = 0, fail = 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-fiscal-'));
const abertos = [];
const SCHEMA = require('./schema-de-tenant').schemaDeTenant();

function montar(nome) {
  const db = new Database(path.join(tmp, nome + '.db'));
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA);
  require('../db-schema').initSchema(db);
  require('../loja-routes').migrarLojaDB(db);
  /* As naturezas não vêm do initSchema: quem as semeia é o `migrar` do
     tipos-operacao-routes, que só roda no provisionamento do tenant. Chamado à
     mão aqui para reproduzir um tenant provisionado de verdade. */
  try { require('../tipos-operacao-routes').migrar(db); } catch (_) {}
  /* O mesmo vale para `nfce_config`: a linha id=1 nasce no `migrar` do
     nfce-routes, que NÃO é exportado — quem o dispara é o registro das rotas.
     Registrar num app descartável é o caminho real, e evita este arquivo
     manter uma segunda cópia da semeadura que envelheceria sozinha. */
  try {
    const descartavel = { get() {}, post() {}, put() {}, delete() {}, use() {} };
    require('../nfce-routes').registrarRotasNFCe(descartavel, db);
  } catch (_) {}
  db.pragma('foreign_keys = ON');
  abertos.push(db);
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL, caminho TEXT, urlOrigem TEXT, origem TEXT DEFAULT 'outra',
    autorizadoPor TEXT, autorizadoEm TEXT, largura INTEGER, altura INTEGER, bytes INTEGER,
    ordem INTEGER DEFAULT 0, dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.prepare(`INSERT INTO produtos (sku, descricao, categoria, unidade, ativo, publicadoNaLoja,
      precoVenda, ncm, cfopPadrao, csosn)
    VALUES ('S1','TEMPERO DE PROVA','TEMPEROS','UN',1,1,50,'09109900','5102','102')`).run();
  db.exec("INSERT INTO movimentacoes_estoque (produtoId,tipo,quantidade,data) VALUES (1,'entrada',100,date('now'))");
  db.prepare(`UPDATE loja_config SET ativa=1, nome='LOJA FISCAL', whatsapp='44999990000',
    servicoRetirada=1, servicoDelivery=0, mostrarPreco=1 WHERE id=1`).run();
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
      const res = { json: (d) => { saida = d; return res; }, status: (s) => { status = s; return res; },
                    setHeader() { return res; }, end() { return res; } };
      fn({ body: body || {}, query: {}, params: (body && body.__params) || {},
           session: { userId: 1, perfil: 'admin' }, protocol: 'https', get: () => 'loja.local' }, res);
      return { status, body: saida };
    },
  };
  require('../reservas-routes').registrarRotasReservas(app, db);
  require('../pedidos-routes').registrarRotasPedidos(app, db);
  require('../loja-routes').registrarRotasLojaPublica(app, db);
  require('../loja-routes').registrarRotasLojaAdmin(app, db);
  require('../faturas-routes').registrarRotasFaturas(app, db);
  return app;
}

const FINALIZAR = '/loja/api/pedido/finalizar';
const pedido = (extra) => ({
  idempotencyKey: crypto.randomUUID(),
  cliente: { nome: 'CLIENTE DE PROVA', telefone: '44999887766' },
  atendimento: 'retirada', pagamento: 'pix',
  itens: [{ produtoId: 1, quantidade: 2 }],
  ...extra,
});
const natureza = (db, codigo) => db.prepare('SELECT * FROM tipos_operacao WHERE codigo = ?').get(codigo);
const configurar = (db, campo, valor) =>
  db.prepare(`UPDATE loja_config SET ${campo} = ? WHERE id = 1`).run(valor);
const contar = (db) => ({
  pedidos: db.prepare('SELECT COUNT(*) c FROM pedidos').get().c,
  pessoas: db.prepare('SELECT COUNT(*) c FROM pessoas').get().c,
  itens: db.prepare('SELECT COUNT(*) c FROM pedido_itens').get().c,
  reservas: db.prepare('SELECT COUNT(*) c FROM reservas_estoque').get().c,
});

// ============================================================================
// A. Sem natureza configurada, o catálogo não vende
// ============================================================================

t('A1. sem natureza: recusa e NADA é criado', () => {
  const db = montar('a1'); const app = montarApp(db);
  const antes = contar(db);
  const r = app.chamar('POST', FINALIZAR, pedido());

  assert(r.status === 409, `status ${r.status} (esperado 409)`);
  assert(/não está configurada para receber pedidos/i.test(r.body.error),
    `mensagem inesperada: ${r.body.error}`);
  /* A mensagem é lida pelo consumidor: não pode entregar nome de coluna, de
     tabela nem de configuração interna. */
  for (const vazamento of ['tipoOperacao', 'tipos_operacao', 'loja_config', 'natureza', 'SQL']) {
    assert(!r.body.error.includes(vazamento), `a mensagem vazou "${vazamento}": ${r.body.error}`);
  }
  const depois = contar(db);
  assert(JSON.stringify(antes) === JSON.stringify(depois),
    `criou coisa mesmo recusando: ${JSON.stringify(antes)} -> ${JSON.stringify(depois)}`);
});

t('A2. natureza apontando para id inexistente é como não ter', () => {
  const db = montar('a2'); const app = montarApp(db);
  configurar(db, 'tipoOperacaoPedidoId', 99999);
  const r = app.chamar('POST', FINALIZAR, pedido());
  assert(r.status === 409, `status ${r.status}`);
  assert(contar(db).pedidos === 0, 'criou pedido com natureza fantasma');
});

t('A3. natureza INATIVA é como não ter', () => {
  const db = montar('a3'); const app = montarApp(db);
  const vda = natureza(db, 'VDA-NORMAL');
  configurar(db, 'tipoOperacaoPedidoId', vda.id);
  db.prepare('UPDATE tipos_operacao SET ativo = 0 WHERE id = ?').run(vda.id);
  const r = app.chamar('POST', FINALIZAR, pedido());
  assert(r.status === 409, `status ${r.status}`);
  assert(contar(db).pedidos === 0, 'criou pedido com natureza inativa');
});

// ============================================================================
// B. O pedido nasce com a natureza
// ============================================================================

t('B1. o pedido nasce COM tipoOperacaoId, não NULL', () => {
  const db = montar('b1'); const app = montarApp(db);
  const vda = natureza(db, 'VDA-NORMAL');
  configurar(db, 'tipoOperacaoPedidoId', vda.id);

  const r = app.chamar('POST', FINALIZAR, pedido());
  assert(r.status === 200, `status ${r.status}: ${JSON.stringify(r.body)}`);
  const p = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(r.body.numero);
  assert(p.tipoOperacaoId === vda.id, `tipoOperacaoId=${p.tipoOperacaoId}, esperado ${vda.id}`);
  assert(p.tipo === 'catalogo', `tipo=${p.tipo}`);
  assert(p.status === 'confirmado', `status=${p.status}`);
});

t('B2. a natureza existe já no INSERT, não num UPDATE posterior', () => {
  const db = montar('b2'); const app = montarApp(db);
  const vda = natureza(db, 'VDA-NORMAL');
  configurar(db, 'tipoOperacaoPedidoId', vda.id);

  /* O gatilho dispara na INSERÇÃO e guarda o valor que chegou na linha. Se o
     código criasse o pedido sem natureza para atualizar depois, o registrado
     aqui seria NULL — e a reserva, que roda na confirmação, já teria sido
     decidida pelo fallback. */
  db.exec(`CREATE TABLE _espia (tipoOperacaoId INTEGER)`);
  db.exec(`CREATE TRIGGER espia_insert AFTER INSERT ON pedidos BEGIN
    INSERT INTO _espia (tipoOperacaoId) VALUES (NEW.tipoOperacaoId); END`);

  app.chamar('POST', FINALIZAR, pedido());
  const visto = db.prepare('SELECT tipoOperacaoId FROM _espia ORDER BY rowid DESC LIMIT 1').get();
  assert(visto, 'nenhum pedido foi inserido');
  assert(visto.tipoOperacaoId === vda.id,
    `no INSERT a natureza era ${visto.tipoOperacaoId} — foi atribuída depois`);
});

// ============================================================================
// G. Estoque: quem decide é a regra canônica
// ============================================================================

t('G1. natureza com movimentaEstoque=1 -> reserva criada', () => {
  const db = montar('g1'); const app = montarApp(db);
  const vda = natureza(db, 'VDA-NORMAL');
  assert(Number(vda.movimentaEstoque) === 1, 'VDA-NORMAL deveria movimentar estoque');
  configurar(db, 'tipoOperacaoPedidoId', vda.id);

  const r = app.chamar('POST', FINALIZAR, pedido());
  const p = db.prepare('SELECT id FROM pedidos WHERE numero = ?').get(r.body.numero);
  const n = db.prepare("SELECT COUNT(*) c FROM reservas_estoque WHERE pedidoId=? AND status='ativa'").get(p.id).c;
  assert(n === 1, `reservas ativas: ${n}`);
});

t('G2. natureza com movimentaEstoque=0 -> NENHUMA reserva', () => {
  const db = montar('g2'); const app = montarApp(db);
  const rem = db.prepare('SELECT * FROM tipos_operacao WHERE movimentaEstoque = 0 AND ativo = 1').get();
  assert(rem, 'o tenant não tem natureza com movimentaEstoque=0 para provar o caso');
  configurar(db, 'tipoOperacaoPedidoId', rem.id);

  const r = app.chamar('POST', FINALIZAR, pedido());
  assert(r.status === 200, `status ${r.status}: ${JSON.stringify(r.body)}`);
  const p = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(r.body.numero);
  assert(p.tipoOperacaoId === rem.id, `natureza gravada: ${p.tipoOperacaoId}`);

  const n = db.prepare('SELECT COUNT(*) c FROM reservas_estoque WHERE pedidoId = ?').get(p.id).c;
  assert(n === 0, `criou ${n} reserva(s) para natureza que não movimenta estoque`);
  /* E o pedido continua válido: não reservar não é falhar. */
  assert(p.status === 'confirmado', `status=${p.status}`);
});

// ============================================================================
// C. Os efeitos posteriores continuam sendo da natureza
// ============================================================================

t('C1. geraFinanceiro=0 -> faturar NÃO abre conta a receber', () => {
  const db = montar('c1'); const app = montarApp(db);
  const bonif = db.prepare(`SELECT * FROM tipos_operacao
    WHERE geraFinanceiro = 0 AND movimentaEstoque = 1 AND usarEmPedido = 1 AND ativo = 1`).get();
  assert(bonif, 'sem natureza geraFinanceiro=0 para provar');
  configurar(db, 'tipoOperacaoPedidoId', bonif.id);

  const r = app.chamar('POST', FINALIZAR, pedido());
  const id = db.prepare('SELECT id FROM pedidos WHERE numero = ?').get(r.body.numero).id;
  app.chamar('POST', '/api/pedidos/:id/entregar', { __params: { id: String(id) } });
  const f = app.chamar('POST', '/api/pedidos/:id/faturar', { __params: { id: String(id) } });
  assert(f.status === 200, `faturar: ${f.status} ${JSON.stringify(f.body)}`);
  const n = db.prepare('SELECT COUNT(*) c FROM contas_a_receber').get().c;
  assert(n === 0, `abriu ${n} conta(s) a receber com geraFinanceiro=0`);
});

t('C2. emiteNFe=0 -> a fatura nasce nao_fiscal', () => {
  const db = montar('c2'); const app = montarApp(db);
  const naoFiscal = db.prepare(`SELECT * FROM tipos_operacao
    WHERE emiteNFe = 0 AND usarEmPedido = 1 AND ativo = 1`).get();
  assert(naoFiscal, 'sem natureza emiteNFe=0 para provar');
  configurar(db, 'tipoOperacaoPedidoId', naoFiscal.id);

  const r = app.chamar('POST', FINALIZAR, pedido());
  const id = db.prepare('SELECT id FROM pedidos WHERE numero = ?').get(r.body.numero).id;
  app.chamar('POST', '/api/pedidos/:id/entregar', { __params: { id: String(id) } });
  app.chamar('POST', '/api/pedidos/:id/faturar', { __params: { id: String(id) } });
  const f = db.prepare('SELECT statusSefaz FROM faturas ORDER BY id DESC LIMIT 1').get();
  assert(f && f.statusSefaz === 'nao_fiscal', `statusSefaz=${f && f.statusSefaz}`);
});

// ============================================================================
// D. A configuração
// ============================================================================

t('D1. salva e devolve as duas naturezas', () => {
  const db = montar('d1'); const app = montarApp(db);
  const vda = natureza(db, 'VDA-NORMAL');
  const r = app.chamar('PUT', '/api/loja/config',
    { tipoOperacaoPedidoId: vda.id, tipoOperacaoNfceId: vda.id });
  assert(r.status === 200, `status ${r.status}: ${JSON.stringify(r.body)}`);

  const g = app.chamar('GET', '/api/loja/config');
  assert(g.body.config.tipoOperacaoPedidoId === vda.id, 'não persistiu a do pedido');
  assert(g.body.config.tipoOperacaoNfceId === vda.id, 'não persistiu a da NFC-e');
  assert(Array.isArray(g.body.naturezas) && g.body.naturezas.length > 0,
    'o GET não devolve a lista para o select');
});

t('D2. id inexistente e id inválido são recusados', () => {
  const db = montar('d2'); const app = montarApp(db);
  for (const valor of [99999, -1, 'abc', 0]) {
    const r = app.chamar('PUT', '/api/loja/config', { tipoOperacaoPedidoId: valor });
    assert(r.status === 400, `valor ${JSON.stringify(valor)}: status ${r.status}`);
  }
  const c = db.prepare('SELECT tipoOperacaoPedidoId FROM loja_config WHERE id=1').get();
  assert(c.tipoOperacaoPedidoId == null, `gravou mesmo recusando: ${c.tipoOperacaoPedidoId}`);
});

t('D3. natureza da NFC-e exige emiteNFe=1', () => {
  const db = montar('d3'); const app = montarApp(db);
  const naoEmite = db.prepare('SELECT * FROM tipos_operacao WHERE emiteNFe = 0 AND ativo = 1').get();
  assert(naoEmite, 'sem natureza emiteNFe=0 para provar');
  const r = app.chamar('PUT', '/api/loja/config', { tipoOperacaoNfceId: naoEmite.id });
  assert(r.status === 400, `status ${r.status}`);
  assert(/não emite documento fiscal/i.test(r.body.error), `mensagem: ${r.body.error}`);

  /* E a MESMA natureza é aceita para o PEDIDO: é justamente para isso que
     "pedido sem emissão fiscal" existe. */
  const ok2 = app.chamar('PUT', '/api/loja/config', { tipoOperacaoPedidoId: naoEmite.id });
  assert(ok2.status === 200, `a natureza sem emissão foi recusada no pedido: ${JSON.stringify(ok2.body)}`);
});

t('D4. vazio limpa a escolha, e ausente preserva', () => {
  const db = montar('d4'); const app = montarApp(db);
  const vda = natureza(db, 'VDA-NORMAL');
  app.chamar('PUT', '/api/loja/config', { tipoOperacaoPedidoId: vda.id });

  // Ausente: a outra tela salvando não pode apagar esta configuração.
  app.chamar('PUT', '/api/loja/config', { nome: 'OUTRO NOME' });
  let c = db.prepare('SELECT * FROM loja_config WHERE id=1').get();
  assert(c.tipoOperacaoPedidoId === vda.id, 'salvar outra tela apagou a natureza');

  // Vazio: é como o lojista desfaz.
  app.chamar('PUT', '/api/loja/config', { tipoOperacaoPedidoId: null });
  c = db.prepare('SELECT * FROM loja_config WHERE id=1').get();
  assert(c.tipoOperacaoPedidoId == null, `não limpou: ${c.tipoOperacaoPedidoId}`);
});

t('D5. a config de um tenant não aparece no outro', () => {
  const a = montar('d5a'); const b = montar('d5b');
  const appA = montarApp(a); const appB = montarApp(b);
  const vdaA = natureza(a, 'VDA-NORMAL');
  appA.chamar('PUT', '/api/loja/config', { tipoOperacaoPedidoId: vdaA.id });

  const cB = b.prepare('SELECT tipoOperacaoPedidoId FROM loja_config WHERE id=1').get();
  assert(cB.tipoOperacaoPedidoId == null,
    `a escolha do tenant A vazou para o B: ${cB.tipoOperacaoPedidoId}`);
  // E o B continua recusando pedido, porque para ele nada foi configurado.
  assert(appB.chamar('POST', FINALIZAR, pedido()).status === 409, 'o tenant B vendeu sem configurar');
});

// ============================================================================
// I. A fronteira do emissor — sem SEFAZ
// ============================================================================

t('I1. sem os campos novos, a natureza continua sendo a do PDV', () => {
  const db = montar('i1');
  const { naturezaDaEmissao, naturezaDoPdv } = require('../nfce-routes');
  const vda = natureza(db, 'VDA-NORMAL');
  db.prepare('UPDATE nfce_config SET pdvTipoOperacaoId = ? WHERE id = 1').run(vda.id);

  const semParametro = naturezaDaEmissao(db, undefined);
  assert(semParametro && semParametro.id === vda.id,
    `omitir devolveu ${semParametro && semParametro.id}, esperado a do PDV (${vda.id})`);
  assert(naturezaDoPdv(db).id === semParametro.id, 'divergiu do naturezaDoPdv');
  // null e string vazia são o mesmo que omitir.
  assert(naturezaDaEmissao(db, null).id === vda.id, 'null não caiu no fallback');
  assert(naturezaDaEmissao(db, '').id === vda.id, 'string vazia não caiu no fallback');
});

t('I2. natureza explícita é usada, e nfce_config NÃO muda', () => {
  const db = montar('i2');
  const { naturezaDaEmissao } = require('../nfce-routes');
  const doPdv = natureza(db, 'VDA-NORMAL');
  const outra = db.prepare(`SELECT * FROM tipos_operacao
    WHERE emiteNFe = 1 AND ativo = 1 AND id <> ? LIMIT 1`).get(doPdv.id);
  db.prepare('UPDATE nfce_config SET pdvTipoOperacaoId = ? WHERE id = 1').run(doPdv.id);

  const escolhida = naturezaDaEmissao(db, outra.id);
  assert(escolhida.id === outra.id, `usou ${escolhida.id}, esperado ${outra.id}`);
  const cfg = db.prepare('SELECT pdvTipoOperacaoId FROM nfce_config WHERE id = 1').get();
  assert(cfg.pdvTipoOperacaoId === doPdv.id,
    `a emissão alterou a configuração do PDV: ${cfg.pdvTipoOperacaoId}`);
});

t('I3. natureza explícita inexistente ou inativa é recusada', () => {
  const db = montar('i3');
  const { naturezaDaEmissao } = require('../nfce-routes');
  const solta = () => { try { naturezaDaEmissao(db, 99999); return null; } catch (e) { return e.message; } };
  assert(solta(), 'aceitou natureza inexistente');

  const vda = natureza(db, 'VDA-NORMAL');
  db.prepare('UPDATE tipos_operacao SET ativo = 0 WHERE id = ?').run(vda.id);
  let erro = null;
  try { naturezaDaEmissao(db, vda.id); } catch (e) { erro = e.message; }
  assert(erro && /inativa/i.test(erro), `aceitou natureza inativa: ${erro}`);
});

t('I4. efeitos: o padrão aplica, o sinalizador não', () => {
  const { aplicarEfeitosDaNatureza } = require('../nfce-routes');
  const efeitos = (db, nfceId) => ({
    saidas: db.prepare("SELECT COUNT(*) c FROM movimentacoes_estoque WHERE origem='nfce' AND origemId=?").get(nfceId).c,
    crs: db.prepare('SELECT COUNT(*) c FROM contas_a_receber WHERE nfceId=?').get(nfceId).c,
  });
  /* O sinalizador vive dentro de `emitirNFCe`, que fala com a SEFAZ. O que se
     prova aqui é o que ele PROTEGE: chamar os efeitos duplica: não chamar, não.
     A prova de que o `if` está no lugar certo é a sabotagem que o remove. */
  const db = montar('i4'); const app = montarApp(db);
  const vda = natureza(db, 'VDA-NORMAL');
  configurar(db, 'tipoOperacaoPedidoId', vda.id);
  const r = app.chamar('POST', FINALIZAR, pedido());
  const id = db.prepare('SELECT id FROM pedidos WHERE numero = ?').get(r.body.numero).id;
  app.chamar('POST', '/api/pedidos/:id/entregar', { __params: { id: String(id) } });

  const saldoAntes = db.prepare("SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade ELSE -quantidade END),0) s FROM movimentacoes_estoque WHERE produtoId=1").get().s;
  db.prepare(`INSERT INTO nfce (numero,serie,tpAmb,valorProdutos,valorDesconto,valorTotal,statusSefaz,tipoOperacaoId,pedidoId)
    VALUES (9001,1,2,100,0,100,'autorizada',?,?)`).run(vda.id, id);
  const nfceId = db.prepare('SELECT id FROM nfce ORDER BY id DESC LIMIT 1').get().id;

  assert(efeitos(db, nfceId).saidas === 0, 'nasceu com efeito sem ninguém aplicar');
  aplicarEfeitosDaNatureza(db, { nfceId, numero: 9001, natureza: vda, politica: null,
    pessoaId: db.prepare('SELECT clienteId FROM pedidos WHERE id=?').get(id).clienteId,
    itens: db.prepare('SELECT produtoId, quantidade FROM pedido_itens WHERE pedidoId=?').all(id),
    valorTotal: 100, dataEmissao: '2026-09-21', tPag: '17', lotesDaVenda: null });
  const dep = efeitos(db, nfceId);
  const saldoDepois = db.prepare("SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade ELSE -quantidade END),0) s FROM movimentacoes_estoque WHERE produtoId=1").get().s;
  assert(dep.saidas > 0 && dep.crs > 0, 'aplicar os efeitos não fez nada — o caso perdeu o sentido');
  assert(saldoDepois < saldoAntes, 'o estoque não caiu: a dupla baixa não está sendo medida');
});

/* ── I5 e I6 são ESTRUTURAIS, e isso é uma escolha, não um descuido ────────
 *
 * As duas amarras que esta fase prepara vivem DENTRO de `emitirNFCe`, e para
 * chegar até elas o código passa antes por `getTools`, que exige CSC, CSCid e
 * certificado digital. Não há harness que alcance esse ponto sem um
 * certificado de verdade, e transmitir não é opção.
 *
 * Mover a resolução para antes do `getTools` tornaria tudo testável por
 * comportamento — e mudaria a mensagem de erro do PDV no caso em que faltam
 * CSC e natureza ao mesmo tempo. Compatibilidade do PDV vale mais do que a
 * conveniência destes dois casos.
 *
 * Então eles leem o código. São específicos de propósito: não procuram uma
 * palavra solta, procuram a EXPRESSÃO que a sabotagem trocaria. Sabotagem
 * medida em 2026-09-21: sem eles, trocar `payload.tipoOperacaoId` por
 * `undefined` e `if (!payload.efeitosJaAplicados)` por `if (true)` passava
 * pela suíte inteira sem uma falha. */
t('I5. dentro da emissão, a natureza vem do payload — não do PDV direto', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'nfce-routes.js'), 'utf8');
  const corpo = src.slice(src.indexOf('async function emitirNFCe'));
  const linha = corpo.split('\n').find((l) => l.includes('naturezaDaEmissao(db,'));
  assert(linha, 'emitirNFCe não resolve mais a natureza por naturezaDaEmissao');
  assert(linha.includes('payload.tipoOperacaoId'),
    `a emissão ignora a natureza informada: ${linha.trim()}`);
});

t('I6. dentro da emissão, os efeitos são condicionados ao sinalizador', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'nfce-routes.js'), 'utf8');
  const corpo = src.slice(src.indexOf('async function emitirNFCe'));
  const i = corpo.indexOf('aplicarEfeitosDaNatureza(db, {');
  assert(i > 0, 'emitirNFCe não aplica mais os efeitos — isso é outra mudança');

  /* A guarda tem de estar ACIMA da chamada e perto dela: um `if` do payload em
     qualquer outro lugar do arquivo não protegeria nada. */
  const antes = corpo.slice(Math.max(0, i - 600), i);
  assert(antes.includes('if (!payload.efeitosJaAplicados)'),
    'os efeitos rodam incondicionalmente: estoque e financeiro seriam aplicados '
    + 'de novo para quem já os aplicou');
});

// ============================================================================
// J. O vínculo com o pedido
// ============================================================================

t('J1. pedidoId ausente continua null', () => {
  const db = montar('j1');
  const { pedidoDaEmissao } = require('../nfce-routes');
  assert(pedidoDaEmissao(db, undefined) === null, 'undefined virou vínculo');
  assert(pedidoDaEmissao(db, null) === null, 'null virou vínculo');
  assert(pedidoDaEmissao(db, '') === null, 'vazio virou vínculo');
});

t('J2. pedidoId válido é aceito e persiste na nota', () => {
  const db = montar('j2'); const app = montarApp(db);
  const vda = natureza(db, 'VDA-NORMAL');
  configurar(db, 'tipoOperacaoPedidoId', vda.id);
  const r = app.chamar('POST', FINALIZAR, pedido());
  const id = db.prepare('SELECT id FROM pedidos WHERE numero = ?').get(r.body.numero).id;

  const { pedidoDaEmissao } = require('../nfce-routes');
  assert(pedidoDaEmissao(db, id) === id, 'não aceitou pedido válido');

  db.prepare(`INSERT INTO nfce (numero,serie,tpAmb,valorProdutos,valorDesconto,valorTotal,statusSefaz,tipoOperacaoId,pedidoId)
    VALUES (9100,1,2,100,0,100,'autorizada',?,?)`).run(vda.id, id);
  const n = db.prepare('SELECT pedidoId FROM nfce ORDER BY id DESC LIMIT 1').get();
  assert(n.pedidoId === id, `gravou ${n.pedidoId}, esperado ${id}`);
});

t('J3. pedidoId inexistente é recusado', () => {
  const db = montar('j3');
  const { pedidoDaEmissao } = require('../nfce-routes');
  for (const valor of [99999, -1, 'abc']) {
    let erro = null;
    try { pedidoDaEmissao(db, valor); } catch (e) { erro = e.message; }
    assert(erro, `aceitou pedido ${JSON.stringify(valor)}`);
  }
});

t('J4. pedido do tenant A é recusado no banco do tenant B', () => {
  const a = montar('j4a'); const b = montar('j4b');
  const appA = montarApp(a);
  const vdaA = natureza(a, 'VDA-NORMAL');
  configurar(a, 'tipoOperacaoPedidoId', vdaA.id);
  const r = appA.chamar('POST', FINALIZAR, pedido());
  const idA = a.prepare('SELECT id FROM pedidos WHERE numero = ?').get(r.body.numero).id;

  /* O isolamento não é uma checagem que alguém precisa lembrar de escrever: o
     `db` já é o do tenant, e o id simplesmente não existe nele. Para o caso não
     passar por acidente, o banco B é deixado SEM pedido nenhum — se o id
     coincidisse, a prova não valeria nada. */
  assert(b.prepare('SELECT COUNT(*) c FROM pedidos').get().c === 0, 'o tenant B não está vazio');
  const { pedidoDaEmissao } = require('../nfce-routes');
  let erro = null;
  try { pedidoDaEmissao(b, idA); } catch (e) { erro = e.message; }
  assert(erro, `o pedido ${idA} do tenant A foi aceito no tenant B`);
});

t('J5. o índice barra a SEGUNDA nota autorizada, e deixa passar rejeitada', () => {
  const db = montar('j5'); const app = montarApp(db);
  const vda = natureza(db, 'VDA-NORMAL');
  configurar(db, 'tipoOperacaoPedidoId', vda.id);
  const r = app.chamar('POST', FINALIZAR, pedido());
  const id = db.prepare('SELECT id FROM pedidos WHERE numero = ?').get(r.body.numero).id;
  const gravar = (numero, status) => db.prepare(
    `INSERT INTO nfce (numero,serie,tpAmb,valorProdutos,valorDesconto,valorTotal,statusSefaz,tipoOperacaoId,pedidoId)
     VALUES (?,1,2,100,0,100,?,?,?)`).run(numero, status, vda.id, id);

  gravar(1, 'rejeitada');
  gravar(2, 'rejeitada');   // rejeitar várias vezes é normal e não pode travar
  gravar(3, 'autorizada');
  let erro = null;
  try { gravar(4, 'autorizada'); } catch (e) { erro = e.message; }
  assert(erro && /UNIQUE/i.test(erro), `a segunda nota autorizada passou: ${erro}`);

  /* Cancelar tira a linha do índice: a reemissão volta a ser possível sem
     ninguém precisar apagar nada. */
  db.prepare("UPDATE nfce SET statusSefaz='cancelada' WHERE numero = 3").run();
  gravar(5, 'autorizada');
  assert(db.prepare("SELECT COUNT(*) c FROM nfce WHERE pedidoId=? AND statusSefaz='autorizada'").get(id).c === 1,
    'depois do cancelamento deveria haver exatamente uma autorizada');
});

// ============================================================================
// K. Nada mudou para quem já existia
// ============================================================================

t('K1. o PDV continua com a natureza dele, intocada', () => {
  const db = montar('k1'); const app = montarApp(db);
  const doPdv = natureza(db, 'VDA-NORMAL');
  const outra = db.prepare('SELECT * FROM tipos_operacao WHERE emiteNFe=1 AND ativo=1 AND id<>? LIMIT 1').get(doPdv.id);
  db.prepare('UPDATE nfce_config SET pdvTipoOperacaoId = ? WHERE id = 1').run(doPdv.id);

  // O catálogo escolhe OUTRA natureza para si.
  app.chamar('PUT', '/api/loja/config', { tipoOperacaoPedidoId: outra.id, tipoOperacaoNfceId: outra.id });

  const cfg = db.prepare('SELECT pdvTipoOperacaoId FROM nfce_config WHERE id = 1').get();
  assert(cfg.pdvTipoOperacaoId === doPdv.id,
    `configurar o catálogo mexeu no PDV: ${cfg.pdvTipoOperacaoId}`);
  const { naturezaDoPdv } = require('../nfce-routes');
  assert(naturezaDoPdv(db).id === doPdv.id, 'o PDV passou a resolver outra natureza');
});

t('K2. o catálogo NÃO emite NFC-e nesta fase', () => {
  /* A garantia é de escopo, e é o que impede a fase seguinte de chegar cedo
     demais: nenhuma linha do loja-routes chama o emissor. */
  const src = fs.readFileSync(path.join(RAIZ, 'loja-routes.js'), 'utf8');
  for (const proibido of ['emitirNFCe', 'nfce-routes', 'efeitosJaAplicados']) {
    assert(!src.includes(proibido),
      `o catálogo já fala com a NFC-e ("${proibido}") — esta fase não deveria emitir`);
  }
});

t('K3. o restaurante continua sem informar natureza (fallback do PDV)', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'restaurante/restaurante-fechamento.js'), 'utf8');
  const i = src.indexOf('emitirNFCe(db,');
  assert(i > 0, 'o restaurante não chama mais o emissor — isso é outra mudança');
  for (const novo of ['tipoOperacaoId', 'efeitosJaAplicados']) {
    assert(!src.includes(novo),
      `o restaurante passou a informar "${novo}" — o fallback dele mudou de comportamento`);
  }
});

(async () => {
  for (const [nome, fn] of fila.filter(([n]) => !FILTRO || n.startsWith(FILTRO))) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  for (const db of abertos) { try { db.close(); } catch (_) {} }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
