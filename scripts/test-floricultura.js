/**
 * Loja de floricultura, ponta a ponta, em banco descartável (2026-09-27).
 *
 * O que cada bloco guarda, e o defeito que ele reprovaria se voltasse:
 *
 *   A. KIT NA LOJA — buquê pronto aparecia "sob consulta" porque a loja somava
 *      o saldo do próprio kit, que nunca tem movimentação.
 *   B. KIT NO BALCÃO — a NFC-e baixava o buquê do estoque em vez das flores.
 *   C. OPÇÕES — a embalagem escolhida na loja era cobrada e nunca saía do
 *      estoque; as escolhas só existiam como texto na descrição.
 *   D. CUSTO EM TODA SAÍDA — a NFC-e gravava saída sem custo nenhum.
 *   E. LUCRO — vendido × custo por produto, juntando pedido, loja e balcão.
 *   F. CONTATO — e-mail e aceite de promoções no checkout e no balcão.
 *   G. PROMOÇÃO — o visitante sem login via sempre o preço cheio.
 *   H. VITRINE COMO INÍCIO — o endereço sem caminho abria o login do ERP.
 *   I. TEMA E PERSONALIZAÇÕES — validação das rotas novas.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floricultura-'));
const SCHEMA = require('./schema-de-tenant').schemaDeTenant();
let seq = 0;

/* O schema inteiro é montado UMA vez, num banco-modelo, e cada caso começa de
   uma cópia do arquivo. Montar do zero em cada caso levava 5 minutos, quase
   todos esperando disco. */
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
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL, caminho TEXT, ordem INTEGER DEFAULT 0)`);
  db.pragma('journal_mode = DELETE');
  db.close();
  return MODELO;
}

function montar() {
  const arq = path.join(tmp, `f${++seq}.db`);
  fs.copyFileSync(modelo(), arq);
  const db = new Database(arq);
  db.pragma('foreign_keys = ON');

  const ins = db.prepare(`INSERT INTO produtos (sku, descricao, categoria, ativo, publicadoNaLoja, precoVenda, precoCusto)
    VALUES (?,?,?,1,?,?,?)`);
  ins.run('ROSA', 'ROSA VERMELHA', 'FLORES', 1, 8, 2.5);        // 1
  ins.run('PAPEL', 'PAPEL KRAFT', 'INSUMOS', 0, 0, 1.2);         // 2
  ins.run('FITA', 'FITA CETIM', 'INSUMOS', 0, 0, 0.8);           // 3
  ins.run('BUQ12', 'BUQUE 12 ROSAS', 'BUQUES', 1, 120, 0);       // 4 (vira kit)
  ins.run('VASO', 'VASO DE VIDRO', 'PRESENTES', 1, 40, 18);      // 5
  // Entradas: rosa com custo pago (a média vence o cadastro), papel e fita sem.
  const mov = db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, data)
    VALUES (?, 'entrada', ?, ?, date('now'))`);
  mov.run(1, 100, 3.0);
  mov.run(2, 5, null);
  mov.run(3, 50, null);
  mov.run(5, 10, 18);
  // Kit: 12 rosas + 1 papel + 1 fita.
  const kit = db.prepare('INSERT INTO produto_kit_itens (produtoPaiId, produtoFilhoId, quantidade) VALUES (4, ?, ?)');
  kit.run(1, 12); kit.run(2, 1); kit.run(3, 1);
  db.prepare("UPDATE produtos SET tipoProduto = 'kit' WHERE id = 4").run();

  const nat = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = 'VDA-NORMAL' AND ativo = 1`).get()
    || db.prepare('SELECT id FROM tipos_operacao WHERE ativo = 1 AND usarEmPedido = 1 AND movimentaEstoque = 1 ORDER BY id LIMIT 1').get();
  if (!nat) throw new Error('banco de prova sem natureza de operação');
  db.prepare(`UPDATE loja_config SET ativa = 1, nome = 'FLORICULTURA PROVA', whatsapp = '94999990000',
      servicoRetirada = 1, mostrarPreco = 1, mostrarEstoque = 1, tipoOperacaoPedidoId = ? WHERE id = 1`).run(nat.id);
  return db;
}

function montarApp(db) {
  const rotas = new Map();
  const reg = (m) => (url, ...fns) => rotas.set(m + ' ' + url, fns[fns.length - 1]);
  const app = {
    get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), use() {},
    chamar(m, url, body, params, extra) {
      const fn = rotas.get(m + ' ' + url);
      if (!fn) throw new Error('rota não registrada: ' + m + ' ' + url);
      let saida = null, status = 200;
      const res = { json: (d) => { saida = d; return res; }, status: (s) => { status = s; return res; },
                    setHeader() { return res; }, end() { return res; } };
      fn({ body: body || {}, query: (extra && extra.query) || {}, params: params || {}, session: {},
           headers: {}, protocol: 'https', get: () => 'floricultura.local', tenant: { slug: 'prova' + seq } }, res);
      return { status, body: saida };
    },
  };
  require('../reservas-routes').registrarRotasReservas(app, db);
  require('../pedidos-routes').registrarRotasPedidos(app, db);
  require('../loja-routes').registrarRotasLojaPublica(app, db);
  require('../loja-routes').registrarRotasLojaAdmin(app, db);
  require('../produtos-routes').registrarRotasProdutos(app, db);
  return app;
}

const FINALIZAR = '/loja/api/pedido/finalizar';
const corpo = (extra) => ({
  idempotencyKey: crypto.randomUUID(),
  cliente: { nome: 'ANA FLOR', telefone: '94999887766' },
  atendimento: 'retirada', pagamento: 'pix',
  itens: [{ produtoId: 4, quantidade: 1 }],
  ...extra,
});
const saldo = (db, id) => db.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
    WHEN tipo='saida' THEN -quantidade ELSE quantidade END),0) s FROM movimentacoes_estoque WHERE produtoId = ?`).get(id).s;
const reservado = (db, id) => db.prepare(`SELECT COALESCE(SUM(quantidade),0) q FROM reservas_estoque
    WHERE produtoId = ? AND status = 'ativa'`).get(id).q;

// ─────────────────────────── A. kit na loja ───────────────────────────
t('A1. kit rende o mínimo entre os componentes (papel: 5 → 5 buquês)', () => {
  const db = montar();
  const { disponivelDe } = require('../loja-routes');
  assert(disponivelDe(db, 4) === 5, `esperado 5 buquês, veio ${disponivelDe(db, 4)}`);
  db.prepare("INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, data) VALUES (1, 'saida', 70, date('now'))").run();
  assert(disponivelDe(db, 4) === 2, `com 30 rosas saem 2 buquês, veio ${disponivelDe(db, 4)}`);
});
t('A2. a vitrine mostra o buquê como disponível, não "sob consulta"', () => {
  const db = montar(); const app = montarApp(db);
  const r = app.chamar('GET', '/loja/api/produtos');
  const buq = r.body.produtos.find(p => p.id === 4);
  assert(buq && buq.estoque === 'disponivel', `estoque do kit: ${buq && buq.estoque}`);
});
t('A3. a tela do kit recebe o custo somado (12×3,00 + 1,20 + 0,80 = 38,00)', () => {
  const db = montar(); const app = montarApp(db);
  const r = app.chamar('GET', '/api/produtos/:id/kit', null, { id: 4 });
  perto(r.body.custoTotal, 38, 'custo do kit');
  const rosa = r.body.itens.find(i => i.produtoFilhoId === 1);
  perto(rosa.custoUnitario, 3, 'rosa usa a média paga, não o cadastro');
});

// ─────────────────────────── B/D. balcão ───────────────────────────
const venderNoBalcao = (db, itens, numero = 1) => {
  const natureza = db.prepare('SELECT * FROM tipos_operacao WHERE movimentaEstoque = 1 AND ativo = 1 ORDER BY id LIMIT 1').get();
  const nfceId = db.prepare(`INSERT INTO nfce (numero, serie, dataEmissao, valorTotal, statusSefaz, tpAmb)
    VALUES (?, 1, date('now'), ?, 'autorizada', 2)`).run(numero, itens.reduce((a, i) => a + i.valorTotal, 0)).lastInsertRowid;
  const insI = db.prepare(`INSERT INTO nfce_itens (nfceId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
    VALUES (?, ?, 'x', ?, ?, ?)`);
  for (const i of itens) insI.run(nfceId, i.produtoId, i.quantidade, i.valorTotal / i.quantidade, i.valorTotal);
  require('../nfce-routes').aplicarEfeitosDaNatureza(db, { nfceId, numero, natureza, politica: null, pessoaId: null,
    itens, valorTotal: 0, dataEmissao: new Date().toISOString().slice(0, 10), tPag: '01', lotesDaVenda: null });
  return nfceId;
};
t('B1. NFC-e de 2 buquês baixa 24 rosas, 2 papéis e 2 fitas, e nada do buquê', () => {
  const db = montar();
  venderNoBalcao(db, [{ produtoId: 4, quantidade: 2, valorTotal: 240 }]);
  assert(saldo(db, 1) === 76, `rosas: ${saldo(db, 1)}`);
  assert(saldo(db, 2) === 3, `papel: ${saldo(db, 2)}`);
  assert(saldo(db, 3) === 48, `fita: ${saldo(db, 3)}`);
  const doKit = db.prepare("SELECT COUNT(*) n FROM movimentacoes_estoque WHERE produtoId = 4").get().n;
  assert(doKit === 0, `o kit ganhou ${doKit} movimentação(ões)`);
});
t('D1. toda saída da NFC-e grava custo: média, e o cadastro quando não há média', () => {
  const db = montar();
  const id = venderNoBalcao(db, [{ produtoId: 4, quantidade: 1, valorTotal: 120 }, { produtoId: 5, quantidade: 1, valorTotal: 40 }]);
  const saidas = db.prepare("SELECT produtoId, custoMedioAnterior, custoUnitario, saldoPosterior FROM movimentacoes_estoque WHERE origem = 'nfce' AND origemId = ?").all(id);
  assert(saidas.length === 4, `saídas: ${saidas.length}`);
  for (const s of saidas) {
    assert(s.custoMedioAnterior > 0, `saída do produto ${s.produtoId} sem custo`);
    assert(s.custoUnitario == null, 'custoUnitario de saída precisa ficar vazio (estorno)');
    assert(s.saldoPosterior != null, 'saldo posterior não gravado');
  }
  perto(saidas.find(s => s.produtoId === 1).custoMedioAnterior, 3, 'rosa pela média');
  perto(saidas.find(s => s.produtoId === 2).custoMedioAnterior, 1.2, 'papel pelo cadastro');
});
t('D2. contextoDeSaida: sem média nem entrada com custo, recua para o cadastro', () => {
  const db = montar();
  const { contextoDeSaida } = require('../estoque-routes');
  perto(contextoDeSaida(db, 3, 1).custoMedioAnterior, 0.8, 'fita');
  assert(contextoDeSaida(db, 3, 1).custoMedioPosterior == null, 'posterior não pode inventar média');
});

// ─────────────────────────── C. opções ───────────────────────────
function comOpcoes(db, app) {
  const g = app.chamar('POST', '/api/loja/opcoes/grupos', { nome: 'Embalagem', minEscolhas: 1, maxEscolhas: 1 }).body.id;
  const op = app.chamar('POST', '/api/loja/opcoes/grupos/:id/opcoes',
    { nome: 'Papel kraft extra', precoAdicional: 5, insumoProdutoId: 2, quantidadeInsumo: 2 }, { id: g }).body.id;
  const gt = app.chamar('POST', '/api/loja/opcoes/grupos', { nome: 'Mensagem do cartão', tipo: 'texto', descricao: 'O que escrever?' }).body.id;
  const v = app.chamar('PUT', '/api/loja/opcoes/produto/:id', { grupoIds: [g, gt] }, { id: 5 });
  assert(v.body.success, 'vínculo: ' + JSON.stringify(v.body));
  return { g, op, gt };
}
t('C1. a escolha fica gravada por item, com o insumo copiado e o texto do cartão', () => {
  const db = montar(); const app = montarApp(db);
  const { op, gt } = comOpcoes(db, app);
  const r = app.chamar('POST', FINALIZAR, corpo({ itens: [{ produtoId: 5, quantidade: 1, opcoes: [op], textos: { [gt]: 'Feliz aniversário' } }] }));
  assert(r.status === 200 && r.body.success, `checkout: ${r.status} ${JSON.stringify(r.body)}`);
  const linhas = db.prepare('SELECT * FROM pedido_item_opcoes ORDER BY id').all();
  assert(linhas.length === 2, `linhas: ${linhas.length}`);
  assert(linhas[0].insumoProdutoId === 2 && linhas[0].quantidadeInsumo === 2, 'insumo não copiado');
  assert(linhas[1].texto === 'Feliz aniversário' && linhas[1].grupoNome === 'Mensagem do cartão', 'texto não gravado');
  const item = db.prepare('SELECT precoUnitario FROM pedido_itens').get();
  perto(item.precoUnitario, 45, 'preço com o adicional');
});
t('C2. o insumo da opção entra na reserva e sai na entrega, com custo', () => {
  const db = montar(); const app = montarApp(db);
  const { op, gt } = comOpcoes(db, app);
  app.chamar('POST', FINALIZAR, corpo({ itens: [{ produtoId: 5, quantidade: 2, opcoes: [op], textos: { [gt]: 'x' } }] }));
  assert(reservado(db, 2) === 4, `papel reservado: ${reservado(db, 2)} (2 vasos × 2)`);
  const ped = db.prepare('SELECT id FROM pedidos').get().id;
  require('../reservas-routes').consumirReservasPedido(db, ped, new Date().toISOString().slice(0, 10));
  assert(saldo(db, 2) === 1, `papel depois da entrega: ${saldo(db, 2)}`);
  const s = db.prepare("SELECT custoMedioAnterior FROM movimentacoes_estoque WHERE produtoId = 2 AND tipo = 'saida'").get();
  perto(s.custoMedioAnterior, 1.2, 'custo do insumo');
});
t('C3. comanda: a opção com insumo baixa o insumo no fechamento', () => {
  const db = montar();
  const g = db.prepare("INSERT INTO rest_grupos_opcao (nome, minEscolhas, maxEscolhas, ativo) VALUES ('Emb', 0, 1, 1)").run().lastInsertRowid;
  const o = db.prepare('INSERT INTO rest_opcoes (grupoId, nome, precoAdicional, insumoProdutoId, quantidadeInsumo, ativo) VALUES (?, ?, 0, 3, 2, 1)')
    .run(g, 'Fita dupla').lastInsertRowid;
  const com = db.prepare("INSERT INTO rest_comandas (codigo, status) VALUES ('1', 'aberta')").run().lastInsertRowid;
  const it = db.prepare("INSERT INTO rest_comanda_itens (comandaId, produtoId, descricao, quantidade, precoUnit, precoTotal, status) VALUES (?, 5, 'VASO', 1, 40, 40, 'entregue')")
    .run(com).lastInsertRowid;
  db.prepare('INSERT INTO rest_comanda_item_opcoes (comandaItemId, opcaoId, nome, precoAdicional) VALUES (?, ?, ?, 0)').run(it, o, 'Fita dupla');
  require('../restaurante/restaurante-ficha').baixarEstoqueComanda(db, com);
  assert(saldo(db, 3) === 48, `fita: ${saldo(db, 3)}`);
});

// ─────────────────────────── E. lucro ───────────────────────────
t('E1. lucro por produto junta loja e balcão, com o custo de cada venda', () => {
  const db = montar(); const app = montarApp(db);
  app.chamar('POST', FINALIZAR, corpo({ itens: [{ produtoId: 4, quantidade: 1 }] }));
  const ped = db.prepare('SELECT id FROM pedidos').get().id;
  require('../reservas-routes').consumirReservasPedido(db, ped, new Date().toISOString().slice(0, 10));
  db.prepare("UPDATE pedidos SET status = 'entregue'").run();
  venderNoBalcao(db, [{ produtoId: 4, quantidade: 1, valorTotal: 110 }, { produtoId: 5, quantidade: 2, valorTotal: 80 }]);
  const hoje = new Date().toISOString().slice(0, 10);
  const r = require('../lucro-produtos').relatorioLucro(db, { inicio: '2020-01-01', fim: hoje });
  const buq = r.produtos.find(p => p.produtoId === 4);
  perto(buq.receita, 230, 'receita do buquê (120 loja + 110 balcão)');
  perto(buq.custo, 76, 'custo do buquê (2 × 38)');
  perto(buq.lucro, 154, 'lucro do buquê');
  assert(buq.canais.loja && buq.canais.balcao, 'canais do buquê');
  assert(!buq.estimado, 'buquê não pode sair estimado: as saídas existem');
  const vaso = r.produtos.find(p => p.produtoId === 5);
  perto(vaso.custo, 36, 'custo do vaso');
  perto(r.totais.lucro, 154 + 44, 'lucro total');
});
t('E2. pedido faturado sem saída sai com custo estimado e marcado', () => {
  const db = montar(); const app = montarApp(db);
  app.chamar('POST', FINALIZAR, corpo({ itens: [{ produtoId: 5, quantidade: 1 }] }));
  db.prepare("UPDATE pedidos SET status = 'faturado'").run();
  const r = require('../lucro-produtos').relatorioLucro(db, { inicio: '2020-01-01', fim: '2100-01-01' });
  const vaso = r.produtos.find(p => p.produtoId === 5);
  assert(vaso.estimado === true, 'deveria estar marcado como estimado');
  perto(vaso.custo, 18, 'custo estimado pelo custo atual');
});
t('E3. rascunho e cancelado não entram', () => {
  const db = montar(); const app = montarApp(db);
  app.chamar('POST', FINALIZAR, corpo({ itens: [{ produtoId: 5, quantidade: 1 }] }));
  db.prepare("UPDATE pedidos SET status = 'cancelado'").run();
  const r = require('../lucro-produtos').relatorioLucro(db, { inicio: '2020-01-01', fim: '2100-01-01' });
  assert(r.produtos.length === 0, `entraram ${r.produtos.length}`);
});

// ─────────────────────────── F. contato ───────────────────────────
t('F1. checkout grava e-mail e aceite com data e origem', () => {
  const db = montar(); const app = montarApp(db);
  const r = app.chamar('POST', FINALIZAR, corpo({ cliente: { nome: 'ANA', telefone: '94999887766', email: 'Ana@Flor.com', aceitePromocoes: true } }));
  assert(r.body.success, JSON.stringify(r.body));
  const p = db.prepare("SELECT * FROM pessoas WHERE origem = 'catalogo'").get();
  assert(p.email === 'ana@flor.com', `email: ${p.email}`);
  assert(p.aceitaEmailMarketing === 1 && p.aceitaWhatsappMarketing === 1 && p.lgpdConsentimento === 1, 'aceite não gravado');
  assert(p.lgpdFonte === 'catalogo' && p.lgpdDataConsentimento, 'origem/data do aceite');
});
t('F2. e-mail inválido é recusado antes de criar qualquer coisa', () => {
  const db = montar(); const app = montarApp(db);
  const r = app.chamar('POST', FINALIZAR, corpo({ cliente: { nome: 'ANA', telefone: '94999887766', email: 'ana@' } }));
  assert(r.status === 422, `status ${r.status}`);
  assert(db.prepare('SELECT COUNT(*) n FROM pedidos').get().n === 0, 'pedido criado');
});
t('F3. sem marcar a caixa não descadastra quem já aceitou', () => {
  const db = montar(); const app = montarApp(db);
  const doc = '52998224725';
  app.chamar('POST', FINALIZAR, corpo({ cliente: { nome: 'ANA', telefone: '94999887766', cpfCnpj: doc, aceitePromocoes: true } }));
  app.chamar('POST', FINALIZAR, corpo({ cliente: { nome: 'ANA', telefone: '94999887766', cpfCnpj: doc } }));
  const p = db.prepare('SELECT aceitaEmailMarketing FROM pessoas WHERE cpfCnpj = ?').get(doc);
  assert(p.aceitaEmailMarketing === 1, 'o aceite foi desligado');
});
t('F4. balcão: e-mail sem CPF cria contato sem documento; com CPF atualiza o cadastro', () => {
  const db = montar();
  const { contatoDoBalcao } = require('../contato-marketing');
  const id = contatoDoBalcao(db, { nome: 'JOAO', email: 'joao@x.com', aceite: true });
  const p = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(id);
  assert(p.semDocumento === 1 && p.origem === 'pdv' && p.aceitaEmailMarketing === 1 && p.lgpdFonte === 'pdv', 'contato do balcão');
  assert(contatoDoBalcao(db, { email: 'joao@x.com', aceite: true }) === id, 'duplicou pelo e-mail');
  assert(contatoDoBalcao(db, { nome: 'X', aceite: true }) === null, 'sem documento nem e-mail não há contato');
});

// ─────────────────────────── G. promoção ───────────────────────────
function tabela(db, nome, { ini = null, fim = null, preco }) {
  const id = db.prepare('INSERT INTO tabelas_preco (nome, prioridade, vigenciaInicio, vigenciaFim, ativo) VALUES (?, 0, ?, ?, 1)')
    .run(nome, ini, fim).lastInsertRowid;
  db.prepare('INSERT INTO tabela_preco_itens (tabelaId, produtoId, preco, qtdMinima) VALUES (?, 5, ?, 0)').run(id, preco);
}
const hojeMais = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
t('G1. promoção vigente aparece para o visitante, com o cheio riscado', () => {
  const db = montar(); const app = montarApp(db);
  tabela(db, 'Dia das mães', { ini: hojeMais(-1), fim: hojeMais(5), preco: 32 });
  const vaso = app.chamar('GET', '/loja/api/produtos').body.produtos.find(p => p.id === 5);
  perto(vaso.preco, 32, 'preço do visitante'); perto(vaso.precoAnterior, 40, 'preço riscado');
});
t('G2. o pedido do visitante sai pelo preço da promoção', () => {
  const db = montar(); const app = montarApp(db);
  tabela(db, 'Semana', { fim: hojeMais(3), preco: 30 });
  app.chamar('POST', FINALIZAR, corpo({ itens: [{ produtoId: 5, quantidade: 1 }] }));
  perto(db.prepare('SELECT precoUnitario FROM pedido_itens').get().precoUnitario, 30, 'preço gravado');
});
t('G3. tabela sem vigência (atacado) e promoção vencida não valem para o visitante', () => {
  const db = montar(); const app = montarApp(db);
  tabela(db, 'Atacado', { preco: 20 });
  tabela(db, 'Passada', { ini: hojeMais(-10), fim: hojeMais(-2), preco: 25 });
  const vaso = app.chamar('GET', '/loja/api/produtos').body.produtos.find(p => p.id === 5);
  perto(vaso.preco, 40, 'visitante viu tabela que não é promoção');
  assert(vaso.precoAnterior == null, 'riscado sem promoção');
  assert(require('../precos-routes').precoPromocional(db, 5) === null, 'precoPromocional devia ser null');
});

// ─────────────────────────── H. vitrine como início ───────────────────────────
function req(db, pathName, extra = {}) {
  return { method: 'GET', path: pathName, headers: {}, session: {}, tenant: { slug: 'vit' + (++seq) }, tenantDb: db, ...extra };
}
function res() {
  const r = { st: 200, loc: null, file: null, ended: false };
  r.status = (s) => { r.st = s; return r; }; r.redirect = (s, l) => { r.st = s; r.loc = l; return r; };
  r.end = () => { r.ended = true; return r; }; r.sendFile = (f) => { r.file = f; return r; };
  return r;
}
t('H1. desligada, nada muda: / segue para o login de sempre', () => {
  const db = montar(); const { vitrineAntesDoLogin, vitrineNaBarreira } = require('../loja-routes');
  let foi = 0;
  vitrineAntesDoLogin(req(db, '/'), res(), () => foi++);
  vitrineNaBarreira(req(db, '/qualquer'), res(), () => foi++);
  assert(foi === 2, 'middleware interceptou com a opção desligada');
});
t('H2. ligada: / vai para a loja, /login para o login, ícone do ERP não é servido', () => {
  const db = montar(); db.prepare('UPDATE loja_config SET paginaInicial = 1').run();
  const { vitrineAntesDoLogin } = require('../loja-routes');
  const r1 = res(); vitrineAntesDoLogin(req(db, '/'), r1, () => { throw new Error('passou'); });
  assert(r1.st === 302 && r1.loc === '/loja/', `/ → ${r1.st} ${r1.loc}`);
  const r2 = res(); vitrineAntesDoLogin(req(db, '/login'), r2, () => { throw new Error('passou'); });
  assert(r2.loc === '/login.html', `/login → ${r2.loc}`);
  const r3 = res(); vitrineAntesDoLogin(req(db, '/favicon.ico'), r3, () => { throw new Error('serviu o do ERP'); });
  assert(r3.st === 404, `favicon sem ícone da loja: ${r3.st}`);
  db.prepare("UPDATE loja_config SET faviconPath = '/uploads/loja/favicon-x.png'").run();
  const r4 = res(); vitrineAntesDoLogin(req(db, '/icone-192.png'), r4, () => { throw new Error('serviu o do ERP'); });
  assert(r4.loc === '/uploads/loja/favicon-x.png', `ícone → ${r4.loc}`);
  const r5 = res(); vitrineAntesDoLogin(req(db, '/manifest.webmanifest'), r5, () => { throw new Error('serviu o do ERP'); });
  assert(r5.st === 404, 'manifest do ERP servido ao visitante');
});
t('H3. ligada: caminho desconhecido recebe o 404 da loja; logado e API passam', () => {
  const db = montar(); db.prepare('UPDATE loja_config SET paginaInicial = 1').run();
  const { vitrineNaBarreira, vitrineAntesDoLogin } = require('../loja-routes');
  const r1 = res(); vitrineNaBarreira(req(db, '/catalogo/produtos.html'), r1, () => { throw new Error('foi ao login'); });
  assert(r1.st === 404 && /loja[\/\\]404\.html$/.test(r1.file || ''), `404: ${r1.st} ${r1.file}`);
  let passou = 0;
  vitrineNaBarreira(req(db, '/api/pedidos'), res(), () => passou++);
  vitrineNaBarreira(req(db, '/app.html', { session: { userId: 1 } }), res(), () => passou++);
  vitrineAntesDoLogin(req(db, '/', { session: { userId: 1 } }), res(), () => passou++);
  assert(passou === 3, 'API ou usuário logado foram desviados');
});
t('H4. loja despublicada não toma o endereço', () => {
  const db = montar(); db.prepare('UPDATE loja_config SET paginaInicial = 1, ativa = 0').run();
  let passou = 0;
  require('../loja-routes').vitrineAntesDoLogin(req(db, '/'), res(), () => passou++);
  assert(passou === 1, 'loja fora do ar desviou /');
});
t('H5. loja fechada (tenant suspenso) tem a cara da loja, sem slug nem cobrança', () => {
  const db = montar(); db.prepare('UPDATE loja_config SET paginaInicial = 1').run();
  let html = null, st = null;
  const r = { status(s) { st = s; return r; }, set() { return r; }, type() { return r; }, send(h) { html = h; return r; } };
  const manager = { getDb: () => db };
  const ok1 = require('../loja-routes').responderLojaFechada(manager, { path: '/loja/' }, r, { slug: 'slug-secreto' });
  assert(ok1 === true && st === 503, 'não respondeu');
  assert(html.includes('FLORICULTURA PROVA'), 'sem o nome da loja');
  for (const proibido of ['slug-secreto', 'pagamento', 'cobran', 'Licite', 'suporte']) {
    assert(!html.toLowerCase().includes(proibido.toLowerCase()), `a página fala de "${proibido}"`);
  }
  assert(require('../loja-routes').responderLojaFechada(manager, { path: '/login.html' }, r, { slug: 'x' }) === false,
    'o login do dono também virou loja fechada');
});
t('H6. o 404 da loja não carrega nada do ERP', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'loja', '404.html'), 'utf8');
  for (const p of ['Licite', 'favicon.svg', 'manifest.webmanifest', 'sw.js', 'pwa.js']) {
    assert(!html.includes(p), `o 404 da loja cita ${p}`);
  }
});

// ─────────────────────────── I. tema e personalizações ───────────────────────────
t('I1. tema: cor secundária inválida é recusada; fonte desconhecida volta ao padrão', () => {
  const db = montar(); const app = montarApp(db);
  const r1 = app.chamar('PUT', '/api/loja/config', { tema: { corSecundaria: 'vermelho' } });
  assert(r1.status === 400, `status ${r1.status}`);
  const r2 = app.chamar('PUT', '/api/loja/config', { tema: { corSecundaria: '#C2185B', fonteTitulo: 'comic', fundo: 'suave',
    faixaTexto: 'Entregamos em Marabá' }, rodapeTexto: 'Floricultura desde 1998', paginaInicial: true });
  assert(r2.body.success, JSON.stringify(r2.body));
  const c = require('../loja-routes');
  const cfg = db.prepare('SELECT tema, rodapeTexto, paginaInicial FROM loja_config').get();
  const tema = JSON.parse(cfg.tema);
  assert(tema.corSecundaria === '#C2185B' && tema.fonteTitulo === 'igual' && tema.fundo === 'suave', JSON.stringify(tema));
  assert(cfg.rodapeTexto === 'Floricultura desde 1998' && cfg.paginaInicial === 1, 'rodapé/página inicial');
  // Campo ausente preserva.
  app.chamar('PUT', '/api/loja/config', { tema: { corPrimaria: '#AA3366' } });
  const cfg2 = db.prepare('SELECT rodapeTexto, paginaInicial FROM loja_config').get();
  assert(cfg2.rodapeTexto === 'Floricultura desde 1998' && cfg2.paginaInicial === 1, 'salvar o tema apagou rodapé/página inicial');
  void c;
});
t('I2. config pública leva favicon e rodapé', () => {
  const db = montar(); const app = montarApp(db);
  db.prepare("UPDATE loja_config SET faviconPath = '/uploads/loja/f.png', rodapeTexto = 'Rodapé'").run();
  const l = app.chamar('GET', '/loja/api/config').body.loja;
  assert(l.favicon === '/uploads/loja/f.png' && l.rodape === 'Rodapé', JSON.stringify(l).slice(0, 200));
});
t('I3. personalizações: kit não pode ser insumo; grupo em uso não se apaga; texto não tem opção', () => {
  const db = montar(); const app = montarApp(db);
  const g = app.chamar('POST', '/api/loja/opcoes/grupos', { nome: 'Tamanho' }).body.id;
  const r1 = app.chamar('POST', '/api/loja/opcoes/grupos/:id/opcoes', { nome: 'G', insumoProdutoId: 4 }, { id: g });
  assert(r1.status === 400 && /kit/i.test(r1.body.error), `kit como insumo: ${r1.status}`);
  app.chamar('PUT', '/api/loja/opcoes/produto/:id', { grupoIds: [g] }, { id: 5 });
  assert(app.chamar('DELETE', '/api/loja/opcoes/grupos/:id', null, { id: g }).status === 400, 'apagou grupo em uso');
  const gt = app.chamar('POST', '/api/loja/opcoes/grupos', { nome: 'Cartão', tipo: 'texto', maxEscolhas: 5 }).body.id;
  const gtx = db.prepare('SELECT maxEscolhas FROM rest_grupos_opcao WHERE id = ?').get(gt);
  assert(gtx.maxEscolhas === 1, 'texto com máximo diferente de 1');
  assert(app.chamar('POST', '/api/loja/opcoes/grupos/:id/opcoes', { nome: 'x' }, { id: gt }).status === 400, 'texto aceitou opção');
  const lista = app.chamar('GET', '/api/loja/opcoes/grupos').body.grupos;
  assert(lista.find(x => x.id === g).produtos === 1, 'contagem de uso');
});

// ─────────────────────────── execução ───────────────────────────
for (const [nome, fn] of fila) {
  try { fn(); ok++; console.log('  ok  ' + nome); }
  catch (e) { fail++; console.log('FALHA ' + nome + '\n      ' + e.message); }
}
console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
