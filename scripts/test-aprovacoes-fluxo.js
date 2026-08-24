/**
 * Aprovações: o caminho entre bloquear e decidir.
 *
 * TRÊS DEFEITOS, todos reproduzidos antes de corrigir:
 *
 *  1. A baixa em LOTE de contas a pagar não verificava alçada. A individual
 *     verificava. Como a tela tem seleção múltipla, bastava marcar as caixas
 *     para pagar acima do limite sem aprovação — pela interface normal.
 *     (O cabeçalho de governanca-routes.js afirmava que o lote chamava o hook.)
 *  2. Ninguém era avisado quando uma solicitação nascia. Ela ia para uma fila
 *     dentro de Configurações → Alçadas, sem contador e sem link a partir de
 *     Contas a Pagar ou Pedidos de Compra.
 *  3. Aprovação vence e o pedido tem de ser refeito — também em silêncio.
 */
const fs = require('fs');
const Database = require('better-sqlite3');

const alc = require('../governanca-alcadas');
const avisos = require('../governanca-avisos');

const DB = '/tmp/vp-aprov.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(`
CREATE TABLE regras_alcada (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tipoEvento TEXT NOT NULL, limiteValor REAL NOT NULL,
  papelAprovador TEXT NOT NULL DEFAULT 'admin', ativo INTEGER DEFAULT 1,
  dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE aprovacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tipoEvento TEXT NOT NULL, referenciaId INTEGER NOT NULL,
  valorReferencia REAL, solicitante TEXT, status TEXT NOT NULL DEFAULT 'pendente',
  aprovador TEXT, motivo TEXT, dataDecisao TEXT, consumida INTEGER DEFAULT 0,
  dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP);
-- Espelha o schema REAL: o nome do fornecedor nao mora em contas_a_pagar,
-- mora em fornecedores. A primeira versao deste teste inventou uma coluna
-- coluna fornecedor aqui, o teste passou, e em producao a consulta lancava excecao
-- engolida pelo catch: a mensagem saia sem o fornecedor, em silencio.
CREATE TABLE contas_a_pagar (id INTEGER PRIMARY KEY, fornecedorId INTEGER, descricao TEXT, valor REAL, status TEXT);
CREATE TABLE pedidos_compra (id INTEGER PRIMARY KEY, numero TEXT, fornecedorId INTEGER);
CREATE TABLE fornecedores (id INTEGER PRIMARY KEY, razaoSocial TEXT, nomeFantasia TEXT);
`);
alc.migrarDB(db);
avisos.migrarAvisosDB(db);

db.prepare("INSERT INTO regras_alcada (tipoEvento, limiteValor, papelAprovador, validadeDias) VALUES ('pagamento_cp', 600, 'admin', 2)").run();
db.prepare("INSERT INTO fornecedores (id, razaoSocial, nomeFantasia) VALUES (5,'Dell Computadores LTDA','Dell')").run();
db.prepare("INSERT INTO contas_a_pagar (id, fornecedorId, descricao, valor, status) VALUES (1,5,'Servidor rack',1200,'aberta')").run();
db.prepare("INSERT INTO pedidos_compra (id, numero, fornecedorId) VALUES (7,'PC-007',5)").run();

let ok = 0, fail = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m} (esperado ${b}, veio ${a})`);
const limparAprovacoes = () => db.exec('DELETE FROM aprovacoes');

(async () => {
console.log('\n== o lote não pode ser a porta dos fundos ==');

await t('a baixa em lote roda a MESMA verificação da individual', () => {
  // O teste não sobe a rota (ela depende de meio ERP); verifica o contrato
  // que a rota passou a usar: mesmo tipoEvento, mesma referência, mesmo hook.
  const fonte = fs.readFileSync(__dirname + '/../contas-pagar-routes.js', 'utf8');
  const i = fonte.indexOf("app.post('/api/contas-a-pagar/baixar-lote'");
  assert(i > 0, 'rota de lote não encontrada');
  const trecho = fonte.slice(i, fonte.indexOf('app.post', i + 10));
  assert(/verificarAlcada\(/.test(trecho), 'o lote precisa chamar verificarAlcada');
  assert(/tipoEvento: 'pagamento_cp'/.test(trecho), 'mesmo tipoEvento da baixa individual');
  assert(/aprovacaoId/.test(trecho), 'a falha precisa devolver aprovacaoId para a tela linkar');
});

await t('lote e individual concordam: acima do limite, bloqueia', () => {
  limparAprovacoes();
  const r = alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 1, valor: 1200, usuario: 'joao' });
  assert(!r.liberado, 'R$ 1.200 deveria bloquear com limite de 600');
  eq(r.status, 'pendente', 'status');
  assert(r.aprovacaoId > 0, 'deveria criar solicitação');
});

await t('abaixo do limite passa sem criar solicitação', () => {
  limparAprovacoes();
  const r = alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 1, valor: 500, usuario: 'joao' });
  assert(r.liberado, 'R$ 500 deveria passar');
  eq(db.prepare('SELECT COUNT(*) n FROM aprovacoes').get().n, 0, 'nenhuma solicitação');
});

console.log('\n== avisar quem decide ==');

await t('a solicitação NOVA é sinalizada como criada', () => {
  limparAprovacoes();
  const r = alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 1, valor: 1200, usuario: 'joao' });
  assert(r.criada === true, 'a primeira vez precisa avisar que nasceu');
});

await t('tentar de novo NÃO sinaliza criação (senão o alerta repete)', () => {
  const r = alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 1, valor: 1200, usuario: 'joao' });
  assert(!r.criada, 'segunda tentativa não pode disparar aviso de novo');
  eq(r.status, 'pendente', 'continua pendente');
});

await t('o aviso de criação sai uma vez só', async () => {
  limparAprovacoes();
  const r = alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 1, valor: 1200, usuario: 'joao' });
  const enviados = [];
  const despachar = async (_db, msg) => { enviados.push(msg); return { ok: true }; };
  await avisos.avisarCriacao(db, r.aprovacaoId, { despachar });
  await avisos.avisarCriacao(db, r.aprovacaoId, { despachar });
  eq(enviados.length, 1, 'avisos enviados');
});

await t('a mensagem diz o documento, o valor e quem decide', async () => {
  limparAprovacoes();
  const r = alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 1, valor: 1200, usuario: 'joao' });
  let msg = null;
  await avisos.avisarCriacao(db, r.aprovacaoId, { despachar: async (_d, m) => { msg = m; return {}; } });
  assert(/Dell/.test(msg.body), 'fornecedor no corpo: ' + msg.body);
  assert(/Servidor rack/.test(msg.body), 'descrição no corpo');
  assert(/1\.200,00/.test(msg.body), 'valor formatado no corpo: ' + msg.body);
  assert(/joao/.test(msg.body), 'solicitante no corpo');
  assert(/admin/.test(msg.body), 'papel que decide no corpo');
  assert(/Aprova/i.test(msg.subject), 'assunto: ' + msg.subject);
});

await t('conta sem fornecedor amarrado mantém a descrição', async () => {
  limparAprovacoes();
  db.prepare("INSERT INTO contas_a_pagar (id, fornecedorId, descricao, valor, status) VALUES (2,NULL,'Aluguel sala',5000,'aberta')").run();
  const r = alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 2, valor: 5000, usuario: 'ana' });
  let msg = null;
  await avisos.avisarCriacao(db, r.aprovacaoId, { despachar: async (_d, m) => { msg = m; return {}; } });
  assert(/Aluguel sala/.test(msg.body), 'descrição deveria aparecer mesmo sem fornecedor: ' + msg.body);
});

await t('referência sem cadastro não quebra a mensagem', async () => {
  limparAprovacoes();
  const r = alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 999, valor: 1200, usuario: 'ana' });
  let msg = null;
  await avisos.avisarCriacao(db, r.aprovacaoId, { despachar: async (_d, m) => { msg = m; return {}; } });
  assert(/#999/.test(msg.body), 'deveria cair no identificador cru: ' + msg.body);
});

await t('pedido de compra usa o número, não o id', async () => {
  limparAprovacoes();
  db.prepare("INSERT INTO regras_alcada (tipoEvento, limiteValor, papelAprovador, validadeDias) VALUES ('pedido_compra', 100, 'admin', 5)").run();
  const r = alc.verificarAlcada(db, { tipoEvento: 'pedido_compra', referenciaId: 7, valor: 900, usuario: 'joao' });
  let msg = null;
  await avisos.avisarCriacao(db, r.aprovacaoId, { despachar: async (_d, m) => { msg = m; return {}; } });
  assert(/PC-007/.test(msg.body), 'número do pedido: ' + msg.body);
  db.prepare("DELETE FROM regras_alcada WHERE tipoEvento = 'pedido_compra'").run();
});

console.log('\n== aviso de vencimento ==');

await t('aprovação que vence amanhã entra na varredura', async () => {
  limparAprovacoes();
  const r = alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 1, valor: 1200,
    usuario: 'joao', agora: '2026-08-01' });   // validade 2 dias -> expira 2026-08-03
  const enviados = [];
  const out = await avisos.avisarExpirando(db, { hoje: '2026-08-02', diasAntes: 1,
    despachar: async (_d, m) => { enviados.push(m); return {}; } });
  eq(out.enviados, 1, 'avisos enviados');
  assert(/vencer|vence/i.test(enviados[0].subject + enviados[0].body), 'deveria falar de vencimento');
  assert(r.aprovacaoId > 0, 'solicitação criada');
});

await t('o aviso de vencimento não repete no dia seguinte', async () => {
  const out = await avisos.avisarExpirando(db, { hoje: '2026-08-03', diasAntes: 1,
    despachar: async () => ({}) });
  eq(out.enviados, 0, 'não deveria avisar de novo');
});

await t('aprovação longe do vencimento não é avisada', async () => {
  limparAprovacoes();
  alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 1, valor: 1200,
    usuario: 'joao', agora: '2026-08-02' });   // expira 2026-08-04
  const out = await avisos.avisarExpirando(db, { hoje: '2026-08-02', diasAntes: 1, despachar: async () => ({}) });
  eq(out.enviados, 0, 'ainda não é véspera');
});

await t('aprovação JÁ vencida não gera aviso (avisar depois não ajuda)', async () => {
  limparAprovacoes();
  alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 1, valor: 1200,
    usuario: 'joao', agora: '2026-07-01' });
  const out = await avisos.avisarExpirando(db, { hoje: '2026-08-02', diasAntes: 1, despachar: async () => ({}) });
  eq(out.enviados, 0, 'vencida há tempos');
});

await t('já decidida sai da varredura', async () => {
  limparAprovacoes();
  const r = alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 1, valor: 1200,
    usuario: 'joao', agora: '2026-08-01' });
  db.prepare("UPDATE aprovacoes SET status = 'aprovada' WHERE id = ?").run(r.aprovacaoId);
  const out = await avisos.avisarExpirando(db, { hoje: '2026-08-02', diasAntes: 1, despachar: async () => ({}) });
  eq(out.enviados, 0, 'aprovada não precisa de aviso de vencimento');
});

console.log('\n== a tela certa para cada coisa ==');

await t('a fila saiu da tela de configuração', () => {
  const s = fs.readFileSync(__dirname + '/../public/configuracoes/alcadas.html', 'utf8');
  assert(!/carregarFila|tbFila/.test(s), 'a fila não pode ter sobrado em Configurações');
  assert(/aprovacoes\/aprovacoes\.html/.test(s), 'deveria linkar para a fila');
});

await t('a tela de aprovações existe e não cadastra regra', () => {
  const s = fs.readFileSync(__dirname + '/../public/aprovacoes/aprovacoes.html', 'utf8');
  assert(/tbFila/.test(s), 'precisa ter a fila');
  assert(!/addRegra|rLimite/.test(s), 'cadastro de regra não é tarefa do dia');
  assert(/configuracoes\/alcadas\.html/.test(s), 'deveria linkar de volta para as regras');
});

await t('as telas de trabalho levam até a solicitação', () => {
  for (const f of ['public/financeiro/contas-a-pagar-detalhe.html', 'public/compras/pedido.html']) {
    const s = fs.readFileSync(__dirname + '/../' + f, 'utf8');
    assert(/aprovacaoId/.test(s), `${f} precisa tratar o bloqueio por alçada`);
    assert(/aprovacoes\/aprovacoes\.html/.test(s), `${f} precisa linkar para a fila`);
  }
});

await t('o menu tem a fila com contador', () => {
  const s = fs.readFileSync(__dirname + '/../public/js/menu-config.js', 'utf8');
  assert(/aprovacoesCount/.test(s), 'badge no item de menu');
  assert(/aprovacoes\/aprovacoes\.html/.test(s), 'link da fila');
  const sb = fs.readFileSync(__dirname + '/../public/js/sidebar.js', 'utf8');
  assert(/carregarContadorAprovacoes/.test(sb), 'função do contador');
  assert(sb.match(/carregarContadorAprovacoes\(\);/g).length >= 3, 'chamada nos pontos de navegação');
});

console.log(`\n${ok} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
})();
