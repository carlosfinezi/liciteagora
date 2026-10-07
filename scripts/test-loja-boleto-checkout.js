/**
 * Boleto online no checkout público do Catálogo (Fase 1, 07/10/2026).
 *
 * O defeito que esta suíte existe para reprovar: `boleto_online` podia ser
 * ativado, aparecia ao consumidor, exigia o CPF dele, o checkout aceitava a
 * escolha — e NÃO criava cobrança nenhuma. O pedido nascia sem conta a receber,
 * sem boleto e sem link, e a tela de sucesso ainda afirmava "O boleto foi
 * gerado e o link chega pelo WhatsApp". Estava no ar em dois tenants.
 *
 * A correção não foi acrescentar um `||`: o nome do meio saiu da regra e virou
 * dado (`loja-pagamento.ONLINE`). Por isso os casos aqui medem o COMPORTAMENTO
 * dos dois meios pelo mesmo caminho — um `if` novo escrito à mão para o boleto
 * passaria por B e C e reprovaria em E3 e F.
 *
 * O Asaas é um servidor falso no lugar do `fetch` global: o código de produção
 * (`boleto-provedores/asaas.js`) monta as mesmas chamadas, e o falso responde
 * como a API v3 responde — inclusive o `identificationField`, que é a linha
 * digitável, e que vem de um GET separado. NENHUMA chamada sai desta máquina:
 * host diferente de `api-sandbox.asaas.com` lança.
 *
 * Blocos:
 *   A. o pedido de boleto nasce com cobrança: CR única, por pedidoId, tPag 15
 *   B. o provedor foi chamado como boleto, e o que ele devolveu está gravado
 *   C. o estado público diz "boleto", com linha e URL, e sem dado interno
 *   D. idempotência: a mesma tentativa não duplica pedido, CR nem boleto
 *   E. falha do provedor, e troca de meio
 *   F. o Pix não regrediu, e os manuais continuam sem cobrança
 *   G. `cartao_online` continua recusado
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
const ASAAS = { pagamentos: new Map(), chamadas: [], falhar: false, semLinha: false, seq: 0 };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const LINHA = '34191790010104351004791020150008291070026000';
global.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host !== 'api-sandbox.asaas.com') throw new Error('chamada externa na suíte: ' + url);
  const metodo = init.method || 'GET';
  const corpo = init.body ? JSON.parse(init.body) : null;
  ASAAS.chamadas.push({ metodo, caminho: u.pathname + u.search, corpo });
  const resp = (status, obj) => ({ ok: status < 300, status, statusText: String(status), text: async () => JSON.stringify(obj) });
  if (ASAAS.falhar) return resp(500, { errors: [{ description: 'indisponível' }] });
  const p = u.pathname.replace('/v3', '');
  if (metodo === 'GET' && p === '/customers') return resp(200, { data: [] });
  if (metodo === 'POST' && p === '/customers') return resp(200, { id: 'cus_' + corpo.cpfCnpj });
  if (metodo === 'POST' && p === '/payments') {
    const id = 'pay_' + (++ASAAS.seq);
    ASAAS.pagamentos.set(id, { ...corpo, id, status: 'PENDING' });
    /* O Asaas devolve `bankSlipUrl` no boleto e `invoiceUrl` nos dois. O
       adapter prefere o `bankSlipUrl` no boleto, e é essa a URL que abre o
       documento com o código de barras. */
    const fora = { id, status: 'PENDING', invoiceUrl: 'https://sandbox.asaas.com/i/' + id };
    if (corpo.billingType === 'BOLETO') fora.bankSlipUrl = 'https://sandbox.asaas.com/b/pdf/' + id;
    return resp(200, fora);
  }
  let m = /^\/payments\/(pay_\d+)\/identificationField$/.exec(p);
  if (m) {
    // Linha indisponível é caso real do Asaas: o boleto registrado leva alguns
    // segundos. O adapter avisa no log e devolve o resto.
    if (ASAAS.semLinha) return resp(404, { errors: [{ description: 'ainda não disponível' }] });
    return resp(200, { identificationField: LINHA, barCode: LINHA.slice(0, 44) });
  }
  m = /^\/payments\/(pay_\d+)\/pixQrCode$/.exec(p);
  if (m) return resp(200, { payload: '00020126PIX' + m[1], encodedImage: PNG, expirationDate: '2099-01-01 23:59:59' });
  m = /^\/payments\/(pay_\d+)$/.exec(p);
  if (m && metodo === 'GET') { const x = ASAAS.pagamentos.get(m[1]); return resp(x ? 200 : 404, x || {}); }
  if (m && metodo === 'DELETE') { const x = ASAAS.pagamentos.get(m[1]); if (x) x.status = 'DELETED'; return resp(200, { deleted: true }); }
  return resp(404, { errors: [{ description: 'rota desconhecida no falso: ' + p }] });
};

/* ───────────── banco ───────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loja-boleto-'));
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
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL, caminho TEXT, ordem INTEGER DEFAULT 0)`);
  db.pragma('journal_mode = DELETE');
  db.close();
  return MODELO;
}

/**
 * Uma loja com um produto publicado, retirada ligada e o provedor configurado.
 *
 * `modo` é o `loja_config.pagamentoModo`, e a tabela de métodos é refeita
 * depois dele: é assim que o boot traduz o legado, e usar a tradução real em
 * vez de gravar as linhas à mão é o que faz esta suíte medir o caminho que a
 * loja percorre de verdade.
 */
function montar({ modo = 'boleto', provedor = true } = {}) {
  const arq = path.join(tmp, `b${++seq}.db`);
  fs.copyFileSync(modelo(), arq);
  const db = new Database(arq);
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO produtos (sku, descricao, categoria, ativo, publicadoNaLoja, precoVenda, precoCusto)
    VALUES ('CAD-01', 'Cadeira de praia', 'Lazer', 1, 1, 80, 40)`).run();
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, data)
    VALUES (1, 'entrada', 50, 40, date('now'))`).run();

  const nat = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = 'VDA-NORMAL' AND ativo = 1`).get()
    || db.prepare('SELECT id FROM tipos_operacao WHERE ativo = 1 AND usarEmPedido = 1 AND movimentaEstoque = 1 ORDER BY id LIMIT 1').get();
  db.prepare(`UPDATE loja_config SET ativa = 1, nome = 'LOJA PROVA', whatsapp = '94991769924',
      servicoRetirada = 1, servicoDelivery = 0, freteModo = 'gratis', mostrarPreco = 1,
      pagamentoModo = ?, pagamentoVencimentoDias = 3, tipoOperacaoPedidoId = ? WHERE id = 1`).run(modo, nat.id);

  if (provedor) {
    const conta = db.prepare("INSERT INTO contas_financeiras (nome, tipo) VALUES ('Asaas', 'banco')").run().lastInsertRowid;
    db.prepare(`INSERT INTO contas_financeiras_boleto (contaFinanceiraId, provedor, ambiente, ativo, ehPadrao, configJson)
      VALUES (?, 'asaas', 'homologacao', 1, 1, ?)`).run(conta, JSON.stringify({ accessToken: '$aact_hmlg_teste', webhookToken: 'tok-webhook' }));
  }
  db.exec('DELETE FROM loja_metodos_pagamento');
  require('../loja-metodos-pagamento').migrarMetodos(db);
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
      await fn({ body: body || {}, query: {}, params: params || {}, session: {}, headers: {}, protocol: 'https',
                 get: () => 'loja.local', tenant: { slug: 'prova' + seq } }, res);
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
const CPF = '52998224725';
const corpo = (extra) => ({
  idempotencyKey: crypto.randomUUID(),
  cliente: { nome: 'JOANA COMPRADORA', telefone: '94999887766', cpfCnpj: CPF },
  atendimento: 'retirada', metodo: 'boleto_online',
  itens: [{ produtoId: 1, quantidade: 2, opcoes: [], textos: {} }],
  ...extra,
});
const crsDo = (db, pedidoId) => db.prepare(
  "SELECT * FROM contas_a_receber WHERE pedidoId = ? AND status != 'cancelada' ORDER BY id").all(pedidoId);
const boletosDa = (db, crId) => db.prepare('SELECT * FROM boletos WHERE contaReceberId = ? ORDER BY id').all(crId);
const pedidoPor = (db, numero) => db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(numero);
const zerarAsaas = () => { ASAAS.chamadas.length = 0; ASAAS.falhar = false; ASAAS.semLinha = false; };

/* ═════════════ A. o pedido de boleto nasce COM cobrança ═════════════ */

t('A1. boleto_online finaliza o pedido e devolve a cobrança no corpo', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  assert(r.status === 200 && r.body.success, JSON.stringify(r.body));
  assert(r.body.pagamento.codigo === 'boleto_online', 'método gravado: ' + r.body.pagamento.codigo);
  assert(r.body.cobrancaFalhou === false, 'a emissão falhou');
  assert(r.body.cobranca, 'o checkout não devolveu cobrança — é o defeito original');
  assert(r.body.cobranca.cobranca, 'estado sem o campo `cobranca`');
  assert(r.body.cobranca.cobranca.tipo === 'boleto', 'tipo: ' + r.body.cobranca.cobranca.tipo);
  db.close();
});

t('A2. nasce UMA conta a receber, vinculada ao pedidoId, origem loja', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  const crs = crsDo(db, ped.id);
  assert(crs.length === 1, `${crs.length} conta(s) a receber, esperado 1`);
  assert(crs[0].pedidoId === ped.id, 'CR não aponta o pedido');
  assert(crs[0].origem === 'loja' && crs[0].origemTipo === 'pedido', `origem ${crs[0].origem}/${crs[0].origemTipo}`);
  assert(crs[0].status === 'aberta', 'status ' + crs[0].status);
  perto(crs[0].valor, 160, 'valor da CR');
  db.close();
});

t('A3. a CR do boleto grava tPag 15, e não o 17 do Pix', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const cr = crsDo(db, pedidoPor(db, r.body.numero).id)[0];
  assert(cr.formaPagamento === '15', 'formaPagamento da CR: ' + cr.formaPagamento);
  db.close();
});

t('A4. o pedido fica pendente de pagamento, nunca pago pela emissão', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  assert(ped.statusPagamento === 'pendente', 'statusPagamento: ' + ped.statusPagamento);
  perto(ped.valorPago || 0, 0, 'valorPago');
  assert(ped.meioPagamento === '15', 'meioPagamento do pedido: ' + ped.meioPagamento);
  db.close();
});

t('A5. o pedido ganha o token do link de pagamento', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  assert(r.body.pagarNoSite === true, 'pagarNoSite: ' + r.body.pagarNoSite);
  assert(typeof r.body.link === 'string' && r.body.link.length >= 16, 'link: ' + r.body.link);
  const lp = db.prepare('SELECT * FROM loja_pagamentos WHERE token = ?').get(r.body.link);
  assert(lp && lp.pedidoId === pedidoPor(db, r.body.numero).id, 'token não aponta o pedido');
  db.close();
});

/* ═════════════ B. o provedor foi chamado como BOLETO ═════════════ */

t('B1. a chamada ao provedor foi billingType BOLETO, no valor do pedido', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  await app.chamar('POST', FINALIZAR, corpo());
  const pagamentos = ASAAS.chamadas.filter((c) => c.metodo === 'POST' && c.caminho.endsWith('/payments'));
  assert(pagamentos.length === 1, `${pagamentos.length} cobranças criadas no provedor, esperado 1`);
  assert(pagamentos[0].corpo.billingType === 'BOLETO', 'billingType: ' + pagamentos[0].corpo.billingType);
  perto(pagamentos[0].corpo.value, 160, 'valor mandado ao provedor');
  assert(/^CR-\d+$/.test(pagamentos[0].corpo.externalReference), 'externalReference: ' + pagamentos[0].corpo.externalReference);
  // O QR do Pix não é pedido num boleto: seria chamada paga sem uso.
  assert(!ASAAS.chamadas.some((c) => /pixQrCode/.test(c.caminho)), 'pediu QR de Pix num boleto');
  db.close();
});

t('B2. a cobrança gravada é tipoCobranca=boleto, com nossoNumero do provedor', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const cr = crsDo(db, pedidoPor(db, r.body.numero).id)[0];
  const bs = boletosDa(db, cr.id);
  assert(bs.length === 1, `${bs.length} cobranças gravadas, esperado 1`);
  assert(bs[0].tipoCobranca === 'boleto', 'tipoCobranca: ' + bs[0].tipoCobranca);
  assert(bs[0].provedor === 'asaas', 'provedor: ' + bs[0].provedor);
  assert(/^pay_\d+$/.test(bs[0].nossoNumero), 'nossoNumero: ' + bs[0].nossoNumero);
  assert(bs[0].status === 'registrado', 'status: ' + bs[0].status);
  assert(bs[0].contaFinanceiraId, 'cobrança sem conta financeira');
  db.close();
});

t('B3. linha digitável e URL do boleto ficam gravadas', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const b = boletosDa(db, crsDo(db, pedidoPor(db, r.body.numero).id)[0].id)[0];
  assert(b.linhaDigitavel === LINHA, 'linhaDigitavel: ' + b.linhaDigitavel);
  assert(b.externalUrl && b.externalUrl.includes('/b/pdf/'), 'externalUrl: ' + b.externalUrl);
  db.close();
});

/* ═════════════ C. o estado PÚBLICO do pagamento ═════════════ */

t('C1. a página pública devolve a cobrança como boleto, com linha e URL', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const g = await app.chamar('GET', '/loja/api/pagamento/:token', null, { token: r.body.link });
  assert(g.status === 200 && g.body.success, JSON.stringify(g.body));
  const c = g.body.pagamento.cobranca;
  assert(c && c.tipo === 'boleto', 'tipo: ' + (c && c.tipo));
  assert(c.linhaDigitavel === LINHA, 'linha: ' + c.linhaDigitavel);
  assert(c.url && c.url.startsWith('https://'), 'url: ' + c.url);
  assert(c.vencimento && /^\d{4}-\d{2}-\d{2}$/.test(c.vencimento), 'vencimento: ' + c.vencimento);
  perto(c.valor, 160, 'valor');
  db.close();
});

t('C2. no boleto o campo `pix` fica NULO: a tela não desenha QR que não existe', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const g = await app.chamar('GET', '/loja/api/pagamento/:token', null, { token: r.body.link });
  assert(g.body.pagamento.pix === null, 'pix veio preenchido no boleto: ' + JSON.stringify(g.body.pagamento.pix));
  assert(!('qr' in g.body.pagamento.cobranca), 'cobrança de boleto trouxe qr');
  assert(!('copiaECola' in g.body.pagamento.cobranca), 'cobrança de boleto trouxe copia e cola');
  db.close();
});

t('C3. nenhum dado interno vaza na API pública', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const g = await app.chamar('GET', '/loja/api/pagamento/:token', null, { token: r.body.link });
  /* A URL do provedor sai da varredura, e não por conveniência: ela É pública
     por construção — é o endereço do documento que o cliente abre, e o Asaas
     põe o id da cobrança (`pay_…`) no caminho. Varrer o resto continua valendo,
     e é onde dado nosso apareceria.
     O que isso revela, e fica anotado: quem tem o link do boleto conhece o
     `pay_id`. Com `webhookToken` ausente na conta, esse id é o bastante para
     forjar um PAYMENT_RECEIVED — a razão pela qual tornar o token obrigatório
     é pré-requisito do cartão (Fase 4 da auditoria), e não um detalhe. */
  const semUrl = { ...g.body, pagamento: { ...g.body.pagamento,
    cobranca: { ...g.body.pagamento.cobranca, url: '(url do provedor)' } } };
  const bruto = JSON.stringify(semUrl);
  for (const proibido of ['JOANA', '94999887766', CPF, 'contaReceberId', 'contaFinanceiraId',
                          'nossoNumero', 'pay_', 'pessoaId', 'clienteId', 'accessToken', 'aact_']) {
    assert(!bruto.includes(proibido), `a resposta pública contém "${proibido}": ${bruto.slice(0, 300)}`);
  }
  // E o conjunto de chaves é o esperado, para campo novo não entrar sem decisão.
  const chaves = Object.keys(g.body.pagamento).sort().join(',');
  assert(chaves === 'aCombinar,atendimento,cancelado,cobranca,frete,numero,pagoEm,pago,pix,total'
      .split(',').sort().join(','), 'chaves do estado público: ' + chaves);
  db.close();
});

t('C4. token inventado não revela nada', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  await app.chamar('POST', FINALIZAR, corpo());
  const g = await app.chamar('GET', '/loja/api/pagamento/:token', null, { token: 'a'.repeat(22) });
  assert(g.status === 404, 'status: ' + g.status);
  assert(!g.body.pagamento, 'devolveu pagamento para token inválido');
  db.close();
});

/* ═════════════ D. idempotência ═════════════ */

t('D1. a MESMA tentativa reenviada não cria segundo pedido, CR nem boleto', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const c = corpo();
  const a = await app.chamar('POST', FINALIZAR, c);
  const b = await app.chamar('POST', FINALIZAR, c);
  assert(b.status === 200 && b.body.success && b.body.repetido, JSON.stringify(b.body));
  assert(a.body.numero === b.body.numero, `pedidos diferentes: ${a.body.numero} e ${b.body.numero}`);
  assert(db.prepare("SELECT COUNT(*) n FROM pedidos WHERE tipo = 'catalogo'").get().n === 1, 'pedido duplicado');
  const ped = pedidoPor(db, a.body.numero);
  assert(crsDo(db, ped.id).length === 1, 'CR duplicada na retentativa');
  assert(boletosDa(db, crsDo(db, ped.id)[0].id).length === 1, 'boleto duplicado na retentativa');
  const pagamentos = ASAAS.chamadas.filter((x) => x.metodo === 'POST' && x.caminho.endsWith('/payments'));
  assert(pagamentos.length === 1, `${pagamentos.length} chamadas de criação no provedor, esperado 1`);
  db.close();
});

t('D2. a retentativa devolve o MESMO boleto, não um vazio', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const c = corpo();
  const a = await app.chamar('POST', FINALIZAR, c);
  const b = await app.chamar('POST', FINALIZAR, c);
  assert(b.body.pagarNoSite === true, 'pagarNoSite na retentativa: ' + b.body.pagarNoSite);
  assert(b.body.link === a.body.link, 'o link mudou na retentativa');
  assert(b.body.cobranca && b.body.cobranca.cobranca, 'retentativa sem cobrança');
  assert(b.body.cobranca.cobranca.tipo === 'boleto', 'tipo na retentativa: ' + b.body.cobranca.cobranca.tipo);
  assert(b.body.cobranca.cobranca.linhaDigitavel === LINHA, 'linha na retentativa');
  db.close();
});

t('D3. mesma chave com pedido DIFERENTE é recusada, e não emite nada', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const chave = crypto.randomUUID();
  await app.chamar('POST', FINALIZAR, corpo({ idempotencyKey: chave }));
  const antes = ASAAS.chamadas.length;
  const r = await app.chamar('POST', FINALIZAR, corpo({ idempotencyKey: chave,
    itens: [{ produtoId: 1, quantidade: 5, opcoes: [], textos: {} }] }));
  assert(r.status === 409, 'status: ' + r.status);
  assert(ASAAS.chamadas.length === antes, 'chamou o provedor numa tentativa recusada');
  assert(db.prepare("SELECT COUNT(*) n FROM pedidos WHERE tipo = 'catalogo'").get().n === 1, 'criou segundo pedido');
  db.close();
});

/**
 * D4 mede a REEMISSÃO, e o que ele guarda não é a contagem de CRs vivas.
 *
 * A primeira versão deste caso contava CRs vivas e boletos da CR viva, e uma
 * sabotagem passou por ele: tirando o retorno antecipado, a função cancelava a
 * CR e criava outra — uma viva, um boleto, contagem intacta. Só que no provedor
 * o boleto do cliente tinha sido CANCELADO, e a linha digitável que ele já
 * tinha copiado não valia mais.
 *
 * O que prova idempotência aqui é a IDENTIDADE da cobrança (`nossoNumero`) e o
 * silêncio no provedor: reemitir não pode criar cobrança nova nem apagar a que
 * o cliente está pagando.
 */
t('D4. gerar de novo devolve a MESMA cobrança, sem tocar o provedor', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  const crAntes = crsDo(db, ped.id)[0];
  const bAntes = boletosDa(db, crAntes.id)[0];
  zerarAsaas();                       // o que vier daqui é da reemissão

  const { emitirCobrancaDoPedido } = require('../loja-pagamento');
  const e = await emitirCobrancaDoPedido(db, ped.id, 'boleto_online', { vencimentoDias: 3 });
  assert(e.cobranca.tipo === 'boleto', 'tipo: ' + e.cobranca.tipo);

  // Nenhuma chamada ao provedor: nem criar, nem cancelar, nem consultar.
  assert(ASAAS.chamadas.length === 0,
    'a reemissão falou com o provedor: ' + ASAAS.chamadas.map((c) => c.metodo + ' ' + c.caminho).join(', '));
  const crs = crsDo(db, ped.id);
  assert(crs.length === 1 && crs[0].id === crAntes.id, 'a CR mudou de identidade: ' + JSON.stringify(crs.map((x) => x.id)));
  assert(db.prepare("SELECT COUNT(*) n FROM contas_a_receber WHERE pedidoId = ? AND status = 'cancelada'").get(ped.id).n === 0,
    'cancelou a CR do cliente para emitir outra');
  const bs = boletosDa(db, crAntes.id);
  assert(bs.length === 1 && bs[0].nossoNumero === bAntes.nossoNumero,
    `a cobrança trocou de nossoNumero: ${bAntes.nossoNumero} -> ${bs.map((x) => x.nossoNumero).join(',')}`);
  assert(bs[0].status === 'registrado', 'a cobrança saiu de registrado: ' + bs[0].status);
  // E o que volta ao cliente é a mesma linha digitável que ele já copiou.
  assert(e.cobranca.linhaDigitavel === LINHA, 'a linha digitável mudou: ' + e.cobranca.linhaDigitavel);
  db.close();
});

/* ═════════════ E. falha do provedor, e troca de meio ═════════════ */

t('E1. provedor fora do ar: o pedido entra, e NÃO vira pago', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  ASAAS.falhar = true;
  const r = await app.chamar('POST', FINALIZAR, corpo());
  assert(r.status === 200 && r.body.success, 'o pedido foi perdido por falha do provedor: ' + JSON.stringify(r.body));
  assert(r.body.cobrancaFalhou === true, 'cobrancaFalhou: ' + r.body.cobrancaFalhou);
  const ped = pedidoPor(db, r.body.numero);
  assert(ped.statusPagamento === 'pendente', 'pedido virou ' + ped.statusPagamento);
  assert(ped.status === 'confirmado', 'status do pedido: ' + ped.status);
  // A CR existe (é dela que a loja cobra depois), mas cobrança nenhuma foi gravada.
  const crs = crsDo(db, ped.id);
  assert(crs.length === 1, `${crs.length} CRs após falha`);
  assert(boletosDa(db, crs[0].id).length === 0, 'gravou cobrança com o provedor fora do ar');
  db.close();
});

t('E2. depois da falha, a emissão de novo aproveita a MESMA CR', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  ASAAS.falhar = true;
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  const crPrimeira = crsDo(db, ped.id)[0].id;
  ASAAS.falhar = false;
  const { emitirCobrancaDoPedido } = require('../loja-pagamento');
  const e = await emitirCobrancaDoPedido(db, ped.id, 'boleto_online', { vencimentoDias: 3 });
  assert(e.cobranca && e.cobranca.tipo === 'boleto', 'não emitiu na segunda tentativa');
  const crs = crsDo(db, ped.id);
  assert(crs.length === 1 && crs[0].id === crPrimeira, 'criou CR nova em vez de reusar: ' + JSON.stringify(crs.map((x) => x.id)));
  db.close();
});

t('E3. linha indisponível no provedor: a URL sozinha ainda paga o boleto', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  ASAAS.semLinha = true;
  const r = await app.chamar('POST', FINALIZAR, corpo());
  assert(r.body.success && !r.body.cobrancaFalhou, JSON.stringify(r.body));
  const g = await app.chamar('GET', '/loja/api/pagamento/:token', null, { token: r.body.link });
  const c = g.body.pagamento.cobranca;
  assert(c && c.tipo === 'boleto', 'tipo: ' + (c && c.tipo));
  assert(!c.linhaDigitavel, 'linha veio, e o falso não a devolveu');
  assert(c.url, 'sem linha E sem url: o cliente não tem como pagar');
  db.close();
});

t('E4. trocar o meio cancela a cobrança anterior e não deixa duas vivas', async () => {
  const db = montar({ modo: 'pix-ou-boleto' }); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo());
  const ped = pedidoPor(db, r.body.numero);
  const { emitirCobrancaDoPedido } = require('../loja-pagamento');
  const e = await emitirCobrancaDoPedido(db, ped.id, 'pix_online', { vencimentoDias: 1 });
  assert(e.cobranca.tipo === 'pix', 'não trocou para Pix: ' + e.cobranca.tipo);
  /* A condição que o faturamento recusa (`faturas-routes.js`, fail closed) é
     ter duas CRs vivas no mesmo pedido. A troca de meio não pode criá-la. */
  const vivas = crsDo(db, ped.id);
  assert(vivas.length === 1, `${vivas.length} CRs vivas depois da troca de meio`);
  assert(vivas[0].formaPagamento === '17', 'a CR nova não ficou em tPag 17: ' + vivas[0].formaPagamento);
  const canceladas = db.prepare("SELECT COUNT(*) n FROM contas_a_receber WHERE pedidoId = ? AND status = 'cancelada'").get(ped.id).n;
  assert(canceladas === 1, `${canceladas} CRs canceladas, esperado 1`);
  db.close();
});

t('E5. sem provedor, boleto não é oferecido e o checkout recusa a escolha', async () => {
  const db = montar({ provedor: false }); const app = montarApp(db); zerarAsaas();
  const cfg = await app.chamar('GET', '/loja/api/config');
  const oferecidos = (cfg.body.metodosPagamento || []).map((m) => m.metodo);
  assert(!oferecidos.includes('boleto_online'), 'ofereceu boleto sem provedor: ' + oferecidos.join(','));
  const r = await app.chamar('POST', FINALIZAR, corpo());
  assert(r.status === 422 && /forma de pagamento/i.test(r.body.error || ''), JSON.stringify(r.body));
  assert(db.prepare("SELECT COUNT(*) n FROM pedidos WHERE tipo = 'catalogo'").get().n === 0, 'criou pedido sem poder cobrar');
  db.close();
});

t('E6. boleto exige o documento do cliente, e recusa antes de criar pedido', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo({
    cliente: { nome: 'SEM DOCUMENTO', telefone: '94999887766' } }));
  assert(r.status === 422 && r.body.campo === 'documento', JSON.stringify(r.body));
  assert(db.prepare('SELECT COUNT(*) n FROM pedidos').get().n === 0, 'criou pedido sem documento');
  assert(ASAAS.chamadas.length === 0, 'chamou o provedor sem documento');
  db.close();
});

t('E7. o boleto de um pedido não é confundido com a cobrança de outro', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const a = await app.chamar('POST', FINALIZAR, corpo());
  const b = await app.chamar('POST', FINALIZAR, corpo({
    itens: [{ produtoId: 1, quantidade: 3, opcoes: [], textos: {} }] }));
  assert(a.body.link !== b.body.link, 'os dois pedidos têm o mesmo token');
  const ea = await app.chamar('GET', '/loja/api/pagamento/:token', null, { token: a.body.link });
  const eb = await app.chamar('GET', '/loja/api/pagamento/:token', null, { token: b.body.link });
  perto(ea.body.pagamento.cobranca.valor, 160, 'valor do pedido A');
  perto(eb.body.pagamento.cobranca.valor, 240, 'valor do pedido B');
  assert(ea.body.pagamento.numero !== eb.body.pagamento.numero, 'o mesmo número nos dois');
  // E cada CR tem a sua própria cobrança, sem cruzar.
  const crA = crsDo(db, pedidoPor(db, a.body.numero).id)[0];
  const crB = crsDo(db, pedidoPor(db, b.body.numero).id)[0];
  const bA = boletosDa(db, crA.id)[0], bB = boletosDa(db, crB.id)[0];
  assert(bA.nossoNumero !== bB.nossoNumero, 'as duas cobranças têm o mesmo nossoNumero');
  db.close();
});

/* ═════════════ F. o Pix não regrediu, manuais seguem sem cobrança ═════════════ */

t('F1. pix_online continua emitindo QR, copia e cola e tPag 17', async () => {
  const db = montar({ modo: 'pix' }); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo({ metodo: 'pix_online' }));
  assert(r.status === 200 && r.body.success, JSON.stringify(r.body));
  const c = r.body.cobranca.cobranca;
  assert(c && c.tipo === 'pix', 'tipo: ' + (c && c.tipo));
  assert(c.copiaECola && c.copiaECola.startsWith('00020126PIX'), 'copia e cola: ' + c.copiaECola);
  assert(c.qr === PNG, 'QR não veio');
  const pagamentos = ASAAS.chamadas.filter((x) => x.metodo === 'POST' && x.caminho.endsWith('/payments'));
  assert(pagamentos[0].corpo.billingType === 'PIX', 'billingType: ' + pagamentos[0].corpo.billingType);
  const cr = crsDo(db, pedidoPor(db, r.body.numero).id)[0];
  assert(cr.formaPagamento === '17', 'tPag do Pix: ' + cr.formaPagamento);
  db.close();
});

t('F2. o campo `pix` do estado público continua preenchido no Pix (aba antiga)', async () => {
  const db = montar({ modo: 'pix' }); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo({ metodo: 'pix_online' }));
  const g = await app.chamar('GET', '/loja/api/pagamento/:token', null, { token: r.body.link });
  const p = g.body.pagamento;
  assert(p.pix && p.pix.copiaECola && p.pix.qr, 'o `pix` de compatibilidade sumiu: ' + JSON.stringify(p.pix));
  // E ele diz exatamente o mesmo que o campo novo: uma fonte, duas leituras.
  assert(p.pix.copiaECola === p.cobranca.copiaECola && p.pix.qr === p.cobranca.qr
    && p.pix.valor === p.cobranca.valor && p.pix.vencimento === p.cobranca.vencimento,
    '`pix` e `cobranca` divergem');
  db.close();
});

t('F3. dinheiro na retirada não cria CR, nem boleto, nem chama o provedor', async () => {
  const db = montar({ modo: 'nenhum' }); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo({ metodo: 'dinheiro',
    cliente: { nome: 'PAGA EM ESPECIE', telefone: '94999887766' } }));
  assert(r.status === 200 && r.body.success, JSON.stringify(r.body));
  assert(r.body.pagarNoSite === false, 'pagarNoSite no dinheiro: ' + r.body.pagarNoSite);
  assert(r.body.cobranca === null, 'dinheiro veio com cobrança');
  const ped = pedidoPor(db, r.body.numero);
  assert(crsDo(db, ped.id).length === 0, 'dinheiro criou conta a receber');
  assert(ASAAS.chamadas.length === 0, 'dinheiro chamou o provedor');
  assert(ped.meioPagamento === '01', 'meioPagamento: ' + ped.meioPagamento);
  db.close();
});

t('F4. pix_manual não gera cobrança no provedor, e é o mesmo tPag 17', async () => {
  const db = montar({ modo: 'nenhum' }); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo({ metodo: 'pix_manual',
    cliente: { nome: 'PIX NA MAO', telefone: '94999887766' } }));
  assert(r.status === 200 && r.body.success, JSON.stringify(r.body));
  assert(r.body.cobranca === null, 'pix_manual gerou cobrança');
  assert(ASAAS.chamadas.length === 0, 'pix_manual chamou o provedor');
  assert(pedidoPor(db, r.body.numero).meioPagamento === '17', 'tPag do pix_manual');
  db.close();
});

t('F5. cartão presencial continua sem cobrança online, em tPag 03', async () => {
  const db = montar({ modo: 'nenhum' }); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo({ metodo: 'credito_presencial',
    cliente: { nome: 'MAQUININHA', telefone: '94999887766' } }));
  assert(r.status === 200 && r.body.success, JSON.stringify(r.body));
  assert(r.body.cobranca === null, 'cartão presencial gerou cobrança online');
  assert(ASAAS.chamadas.length === 0, 'cartão presencial chamou o provedor');
  assert(pedidoPor(db, r.body.numero).meioPagamento === '03', 'tPag do crédito presencial');
  db.close();
});

/* ═════════════ G. cartao_online continua fora ═════════════ */

t('G1. cartao_online não é ativável nem por requisição direta', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('PUT', '/api/loja/metodos-pagamento',
    { metodos: [{ metodo: 'cartao_online', ativo: true, entrega: true, retirada: true }] });
  assert(r.status === 200, 'status: ' + r.status);
  const linha = db.prepare("SELECT ativo FROM loja_metodos_pagamento WHERE metodo = 'cartao_online'").get();
  assert(Number(linha.ativo) === 0, 'cartao_online ficou ativo');
  db.close();
});

t('G2. o checkout recusa cartao_online, e o despacho não o conhece', async () => {
  const db = montar(); const app = montarApp(db); zerarAsaas();
  const r = await app.chamar('POST', FINALIZAR, corpo({ metodo: 'cartao_online' }));
  assert(r.status === 422, 'status: ' + r.status);
  assert(db.prepare('SELECT COUNT(*) n FROM pedidos').get().n === 0, 'criou pedido de cartão online');
  const { ONLINE } = require('../loja-pagamento');
  assert(!ONLINE.cartao_online, 'cartao_online entrou na tabela de meios online antes da fase dele');
  db.close();
});

/* ───────────── execução ───────────── */
(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); ok++; console.log('  ok   ' + nome); }
    catch (e) { fail++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
