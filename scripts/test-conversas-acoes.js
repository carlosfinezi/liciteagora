/**
 * As ações sobre uma mensagem na tela de Conversas (01/10/2026): responder
 * citando, apagar para todos, editar, e o anexo da barra de escrever.
 *
 * Nada disso existia: a conversa só mandava texto novo. As quatro ações passam
 * pela Evolution, e é por isso que as três primeiras têm limites que não são
 * nossos — só mensagem NOSSA se apaga e se edita, e editar só nos primeiros 15
 * minutos. Quem recusa primeiro somos nós, para a recusa chegar dita em vez de
 * voltar como erro cru do portal.
 *
 * A Evolution aqui é simulada e registra o que foi chamado: o teste é sobre o
 * CORPO que sai daqui — trocar `data.key.id` por `data.id`, ou mandar a chave
 * sem o jid, marca ou edita a mensagem errada no aparelho do contato.
 *
 *  A1  apagar para todos: chamada certa, e a mensagem FICA com apagadaEm
 *  A2  apagar recusa mensagem do contato e mensagem sem registro no WhatsApp
 *  A3  editar dentro de 15 min: troca no WhatsApp, no banco e na prévia da lista
 *  A4  editar acima de 15 min é recusado SEM chamar a Evolution
 *  A5  responder citando leva o `quoted` e grava a citação, que volta na listagem
 *  A6  citar mensagem de outra conversa não cita, e a resposta sai
 *  A7  o anexo sai como mídia, com o tipo certo, e o arquivo fica no disco
 *  A8  o id citado sai do contextInfo, em qualquer formato de mensagem
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { tenantStorage, createDbProxy } = require('../tenant-middleware');

require.cache[require.resolve('../audit-log')] = { exports: { logAction: () => {} } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversas-acoes-'));
const real = new Database(path.join(dir, 'pncp.db'));
real.exec(require('./schema-de-tenant').lerSchema());
real.pragma('foreign_keys = OFF');
require('../whatsapp-adapter').migrarQueue(real);
require('../whatsapp-canais').migrarCanais(real);
real.exec('DELETE FROM whatsapp_canais');
real.prepare(`INSERT INTO whatsapp_canais (id, nome, instance, baseUrl, apikey, padrao, config)
  VALUES (1, 'principal', 'inst1', 'http://evolution.teste', 'chave', 1, '{}')`).run();
// A mídia enviada vai para uma pasta descartável, nunca para data/.
const midia = require('../wa-midia');
midia.raiz = path.join(dir, 'tenants');

const JID = '5594991112222@s.whatsapp.net';
const conversaId = Number(real.prepare(`INSERT INTO conv_conversas (canal, canalId, jid, telefone, nome, estado)
  VALUES ('whatsapp', 1, ?, '5594991112222', 'Loja Teste', 'aberta')`).run(JID).lastInsertRowid);

const agora = () => Math.floor(Date.now() / 1000);
const inserir = (waId, deMim, texto, ts = agora(), tipo = 'conversation') =>
  Number(real.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, texto, message_type, timestamp)
    VALUES (?, 'inst1', ?, ?, ?, ?, ?)`).run(waId, JID, deMim ? 1 : 0, texto, tipo, ts).lastInsertRowid);

// --- a Evolution simulada -------------------------------------------------
// Só o que vai para `evolution.teste` é capturado; o resto (as chamadas do
// próprio teste ao app) segue para o fetch de verdade.
const chamadas = [];
const fetchReal = global.fetch;
global.fetch = async (url, opcoes = {}) => {
  const u = String(url);
  if (!u.startsWith('http://evolution.teste')) return fetchReal(url, opcoes);
  const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
  chamadas.push({ url: u, metodo: opcoes.method, corpo });
  const id = 'WAMID' + chamadas.length;
  return { ok: true, status: 201, json: async () => ({ key: { id, remoteJid: JID }, status: 'PENDING' }) };
};

const TENANT = { slug: 'demo', name: 'Demo' };
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.tenant = TENANT;
  req.tenantDb = real;
  req.tenantCtx = { kind: 'tenant', slug: 'demo' };
  req.user = { id: 1, username: 't' };
  req.session = { username: 't' };
  tenantStorage.run({ kind: 'tenant', tenant: TENANT, db: real }, next);
});
const db = createDbProxy();
tenantStorage.run({ kind: 'tenant', tenant: TENANT, db: real }, () => {
  require('../conversas-routes').registrarRotasConversas(app, db);
});

let ok = 0, fail = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const srv = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  const chamar = async (url, opcoes = {}) => {
    const r = await fetchReal(base + url, opcoes);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const json = (url, metodo, corpo) => chamar(url, { method: metodo,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });

  await t('A1 apagar para todos chama a Evolution com a chave certa e a mensagem fica marcada', async () => {
    const id = inserir('MSG-A1', true, 'vou apagar esta');
    chamadas.length = 0;
    const r = await chamar(`/api/conversas/${conversaId}/mensagens/${id}`, { method: 'DELETE' });
    assert(r.body.success, `${r.status} ${JSON.stringify(r.body)}`);
    assert(chamadas.length === 1, `chamadas: ${chamadas.length}`);
    const c = chamadas[0];
    assert(c.url === 'http://evolution.teste/chat/deleteMessageForEveryone/inst1', c.url);
    assert(c.metodo === 'DELETE', String(c.metodo));
    assert(c.corpo.id === 'MSG-A1' && c.corpo.remoteJid === JID && c.corpo.fromMe === true, JSON.stringify(c.corpo));
    const m = real.prepare('SELECT texto, apagadaEm FROM whatsapp_messages WHERE id = ?').get(id);
    assert(m && m.texto === 'vou apagar esta', 'a mensagem saiu da tabela, e ela deve FICAR');
    assert(m.apagadaEm, 'apagadaEm não foi gravada');
  });

  await t('A2 apagar recusa mensagem do contato e mensagem sem registro no WhatsApp', async () => {
    const doContato = inserir('MSG-A2', false, 'mensagem deles');
    const semWa = Number(real.prepare(`INSERT INTO whatsapp_messages (instance, remote_jid, from_me, texto, timestamp)
      VALUES ('inst1', ?, 1, 'sem id', ?)`).run(JID, agora()).lastInsertRowid);
    chamadas.length = 0;

    const r1 = await chamar(`/api/conversas/${conversaId}/mensagens/${doContato}`, { method: 'DELETE' });
    assert(r1.status === 400 && /enviou/.test(r1.body.error || ''), `${r1.status} ${JSON.stringify(r1.body)}`);
    const r2 = await chamar(`/api/conversas/${conversaId}/mensagens/${semWa}`, { method: 'DELETE' });
    assert(r2.status === 400 && /registro no WhatsApp/.test(r2.body.error || ''), `${r2.status} ${JSON.stringify(r2.body)}`);
    assert(chamadas.length === 0, 'recusa não pode chamar a Evolution');
    assert(!real.prepare('SELECT apagadaEm FROM whatsapp_messages WHERE id = ?').get(doContato).apagadaEm,
      'a mensagem do contato não pode ficar marcada como apagada');
  });

  await t('A2b apagar para todos acima de 60 h e recusado sem chamar a Evolution', async () => {
    // Sessenta horas é o limite do WhatsApp. Sem a guarda, a chamada saía, a
    // Evolution devolvia erro cru e a mensagem já tinha sumido da nossa tela.
    const velha = inserir('MSG-A2B', true, 'de tres dias atras', agora() - 72 * 3600);
    chamadas.length = 0;
    const r = await chamar(`/api/conversas/${conversaId}/mensagens/${velha}`, { method: 'DELETE' });
    assert(r.status === 400 && /60 horas/.test(r.body.error || ''), `${r.status} ${JSON.stringify(r.body)}`);
    assert(chamadas.length === 0, 'recusa não pode chamar a Evolution');
    assert(!real.prepare('SELECT apagadaEm FROM whatsapp_messages WHERE id = ?').get(velha).apagadaEm,
      'a mensagem velha ficou marcada como apagada mesmo com a recusa');

    // E DENTRO da janela continua apagando: uma guarda que recusa tudo passaria
    // na checagem de cima.
    const recente = inserir('MSG-A2C', true, 'de ontem', agora() - 10 * 3600);
    chamadas.length = 0;
    const ok = await chamar(`/api/conversas/${conversaId}/mensagens/${recente}`, { method: 'DELETE' });
    assert(ok.body.success, `dentro da janela: ${ok.status} ${JSON.stringify(ok.body)}`);
    assert(chamadas.length === 1, `dentro da janela não chamou a Evolution: ${chamadas.length}`);
  });

  await t('A3 editar dentro de 15 min troca no WhatsApp, no banco e na previa da lista', async () => {
    const id = inserir('MSG-A3', true, 'texto antigo');
    real.prepare('UPDATE conv_conversas SET ultimaMensagem = ? WHERE id = ?').run('texto antigo', conversaId);
    chamadas.length = 0;
    const r = await json(`/api/conversas/${conversaId}/mensagens/${id}`, 'PUT', { texto: 'texto novo' });
    assert(r.body.success, `${r.status} ${JSON.stringify(r.body)}`);
    const c = chamadas[0];
    assert(c && c.url === 'http://evolution.teste/chat/updateMessage/inst1', JSON.stringify(c && c.url));
    assert(c.corpo.text === 'texto novo', JSON.stringify(c.corpo));
    assert(c.corpo.key.id === 'MSG-A3' && c.corpo.key.remoteJid === JID && c.corpo.key.fromMe === true, JSON.stringify(c.corpo.key));
    assert(c.corpo.number === '5594991112222', String(c.corpo.number));
    const m = real.prepare('SELECT texto, editadaEm FROM whatsapp_messages WHERE id = ?').get(id);
    assert(m.texto === 'texto novo' && m.editadaEm, JSON.stringify(m));
    const conv = real.prepare('SELECT ultimaMensagem FROM conv_conversas WHERE id = ?').get(conversaId);
    assert(conv.ultimaMensagem === 'texto novo', `prévia da lista: ${conv.ultimaMensagem}`);
  });

  await t('A4 editar acima de 15 min e recusado sem chamar a Evolution', async () => {
    const id = inserir('MSG-A4', true, 'de meia hora atras', agora() - 30 * 60);
    chamadas.length = 0;
    const r = await json(`/api/conversas/${conversaId}/mensagens/${id}`, 'PUT', { texto: 'tarde demais' });
    assert(r.status === 400 && /15 minutos/.test(r.body.error || ''), `${r.status} ${JSON.stringify(r.body)}`);
    assert(chamadas.length === 0, 'não deve chamar a Evolution');
    assert(real.prepare('SELECT texto FROM whatsapp_messages WHERE id = ?').get(id).texto === 'de meia hora atras',
      'o texto no banco mudou mesmo com a recusa');
  });

  await t('A5 responder citando leva o quoted, grava a citacao e ela volta na listagem', async () => {
    const citada = inserir('MSG-A5', false, 'qual o prazo de entrega?');
    chamadas.length = 0;
    const r = await json(`/api/conversas/${conversaId}/responder`, 'POST',
      { texto: 'em 3 dias úteis', citarId: citada });
    assert(r.body.success, `${r.status} ${JSON.stringify(r.body)}`);
    const envio = chamadas.find(c => c.url.includes('/message/sendText/'));
    assert(envio, 'nenhum envio de texto');
    assert(envio.corpo.quoted && envio.corpo.quoted.key.id === 'MSG-A5', JSON.stringify(envio.corpo.quoted));
    assert(envio.corpo.quoted.key.remoteJid === JID && envio.corpo.quoted.key.fromMe === false, JSON.stringify(envio.corpo.quoted.key));
    assert(envio.corpo.quoted.message.conversation === 'qual o prazo de entrega?', JSON.stringify(envio.corpo.quoted.message));

    const lista = await chamar(`/api/conversas/${conversaId}`);
    const nova = lista.body.mensagens.filter(m => m.texto === 'em 3 dias úteis').pop();
    assert(nova, 'a resposta não apareceu na conversa');
    assert(nova.citaTexto === 'qual o prazo de entrega?', `citaTexto: ${nova.citaTexto}`);
    assert(Number(nova.citaDeMim) === 0, `citaDeMim: ${nova.citaDeMim}`);
  });

  await t('A6 citar mensagem de outra conversa nao cita, e a resposta sai', async () => {
    const outra = Number(real.prepare(`INSERT INTO conv_conversas (canal, canalId, jid, telefone, nome, estado)
      VALUES ('whatsapp', 1, '5511999990000@s.whatsapp.net', '5511999990000', 'Outra', 'aberta')`).run().lastInsertRowid);
    const deOutra = Number(real.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, texto, timestamp)
      VALUES ('MSG-A6', 'inst1', '5511999990000@s.whatsapp.net', 0, 'de outra conversa', ?)`).run(agora()).lastInsertRowid);
    chamadas.length = 0;
    const r = await json(`/api/conversas/${conversaId}/responder`, 'POST', { texto: 'resposta sem citar', citarId: deOutra });
    assert(r.body.success, `${r.status} ${JSON.stringify(r.body)}`);
    const envio = chamadas.find(c => c.url.includes('/message/sendText/'));
    assert(envio && !envio.corpo.quoted, `citou o que não é da conversa: ${JSON.stringify(envio && envio.corpo.quoted)}`);
    assert(outra > 0);
  });

  await t('A7 o anexo sai como midia, com o tipo certo, e o arquivo fica no disco do tenant', async () => {
    chamadas.length = 0;
    const fd = new FormData();
    fd.append('arquivo', new Blob([PNG]), 'foto.png');
    fd.append('texto', 'segue a foto');
    const r = await chamar(`/api/conversas/${conversaId}/anexo`, { method: 'POST', body: fd });
    assert(r.body.success, `${r.status} ${JSON.stringify(r.body)}`);
    const envio = chamadas.find(c => c.url.includes('/message/sendMedia/'));
    assert(envio, 'não saiu por sendMedia');
    assert(envio.corpo.mediatype === 'image' && envio.corpo.mimetype === 'image/png', JSON.stringify({ ...envio.corpo, media: '…' }));
    assert(envio.corpo.caption === 'segue a foto', String(envio.corpo.caption));
    assert(Buffer.from(envio.corpo.media, 'base64').equals(PNG), 'o arquivo que saiu não é o que subiu');
    const m = real.prepare(`SELECT id, message_type FROM whatsapp_messages
      WHERE remote_jid = ? ORDER BY id DESC LIMIT 1`).get(JID);
    assert(m.message_type === 'imageMessage', `message_type: ${m.message_type}`);
    const bin = path.join(midia.pasta('demo'), `${m.id}.bin`);
    assert(fs.existsSync(bin) && fs.readFileSync(bin).equals(PNG), `arquivo não guardado em ${bin}`);

    // Extensão que o WhatsApp não recebe é recusada antes de qualquer envio.
    chamadas.length = 0;
    const fd2 = new FormData();
    fd2.append('arquivo', new Blob([Buffer.from('MZ')]), 'programa.exe');
    const r2 = await chamar(`/api/conversas/${conversaId}/anexo`, { method: 'POST', body: fd2 });
    assert(r2.status === 400 && /\.exe/.test(r2.body.error || ''), `${r2.status} ${JSON.stringify(r2.body)}`);
    assert(chamadas.length === 0, 'arquivo recusado não pode ir à Evolution');
  });

  await t('A9 conversa de numero REMOVIDO em Canais sai da caixa, e das contagens', async () => {
    // Remover um número grava `ativo = 0` e o seletor some junto (listarCanais
    // só traz ativo). As conversas daquele número ficavam na lista, misturadas
    // com as do principal e sem como separá-las: 9 do "Suporte" no 1bit.
    real.prepare(`INSERT INTO whatsapp_canais (id, nome, instance, baseUrl, apikey, padrao, ativo, config)
      VALUES (2, 'Suporte', 'inst2', 'http://evolution.teste', 'chave', 0, 1, '{}')`).run();
    const doSuporte = Number(real.prepare(`INSERT INTO conv_conversas (canal, canalId, jid, telefone, nome, estado)
      VALUES ('whatsapp', 2, '5511888887777@s.whatsapp.net', '5511888887777', 'Cliente do Suporte', 'aberta')`)
      .run().lastInsertRowid);

    const comCanal = await chamar('/api/conversas');
    assert(comCanal.body.conversas.some(c => c.id === doSuporte), 'o canal ativo sumiu da caixa');
    const totalAntes = comCanal.body.contagem.total;

    real.prepare('UPDATE whatsapp_canais SET ativo = 0 WHERE id = 2').run();
    const semCanal = await chamar('/api/conversas');
    assert(!semCanal.body.conversas.some(c => c.id === doSuporte),
      'a conversa do número removido continua na caixa');
    assert(semCanal.body.contagem.total === totalAntes - 1,
      `a contagem não acompanhou: ${semCanal.body.contagem.total} contra ${totalAntes - 1}`);
    // A conversa FICA no banco: remover número não é apagar histórico.
    assert(real.prepare('SELECT 1 FROM conv_conversas WHERE id = ?').get(doSuporte), 'a conversa foi apagada');
    // E a de canalId 0, anterior à migração de canais, continua aparecendo.
    const semNumero = Number(real.prepare(`INSERT INTO conv_conversas (canal, canalId, jid, telefone, nome, estado)
      VALUES ('whatsapp', 0, '5511000001111@s.whatsapp.net', '5511000001111', 'Antiga', 'aberta')`)
      .run().lastInsertRowid);
    const r3 = await chamar('/api/conversas');
    assert(r3.body.conversas.some(c => c.id === semNumero), 'a conversa sem número nenhum sumiu');
  });

  await t('A10 o nicho vem das CAMPANHAS, recorta a caixa e traz quem so recebeu', async () => {
    // Nicho 4 com envio, nicho 9 sem envio nenhum: só o primeiro pode aparecer.
    // O banco de teste sai do SCHEMA do tenant, sem dados: os segmentos que a
    // campanha cita precisam existir, senão o nicho não tem nome para mostrar.
    const seg = real.prepare("INSERT INTO segmentos (id, nome, chave) VALUES (?, ?, ?)");
    seg.run(4, 'Alimentação', 'alimentacao');
    seg.run(9, 'Genérico', 'generico');
    const tpl = Number(real.prepare(
      "INSERT INTO comm_templates (nome, canal, corpo) VALUES ('m', 'whatsapp', 'Oi')").run().lastInsertRowid);
    const listaId = Number(real.prepare(
      "INSERT INTO comm_listas (nome) VALUES ('lista de teste')").run().lastInsertRowid);
    const camp = real.prepare(`INSERT INTO comm_campanhas (id, nome, canal, status, segmentos, templateId, listaId)
      VALUES (?, ?, 'whatsapp', ?, ?, ?, ?)`);
    camp.run(10, 'Alimentação', 'enviada', '[4]', tpl, listaId);
    camp.run(11, 'Rascunho sem envio', 'rascunho', '[9]', tpl, listaId);
    const env = real.prepare(`INSERT INTO comm_envios (campanhaId, canal, destino, status, dataEnvio, mensagemRenderizada)
      VALUES (?, 'whatsapp', ?, 'enviado', '2026-10-01 09:00:00', ?)`);
    env.run(10, '5594991112222', 'Oi, temos novidades');      // este TEM conversa (a do teste)
    env.run(10, '5511955554444', 'Oi, temos novidades');      // este nunca escreveu
    // A 11 tem envio PENDENTE, que é o caso da campanha montada e não disparada:
    // o nicho dela não pode aparecer no seletor.
    real.prepare(`INSERT INTO comm_envios (campanhaId, canal, destino, status, mensagemRenderizada)
      VALUES (11, 'whatsapp', '5511933332222', 'pendente', 'nunca saiu')`).run();

    const lista = await chamar('/api/conversas');
    const nichos = (lista.body.nichos || []).map(n => n.id);
    assert(nichos.includes(4), 'o nicho da campanha que enviou não veio: ' + JSON.stringify(lista.body.nichos));
    assert(!nichos.includes(9), 'veio nicho de campanha que nunca enviou: ' + JSON.stringify(lista.body.nichos));

    const noNicho = await chamar('/api/conversas?nicho=4&situacao=todos');
    const tels = noNicho.body.conversas.map(c => String(c.telefone).slice(-8));
    assert(tels.includes('91112222'), 'quem recebeu e tem conversa sumiu: ' + JSON.stringify(tels));
    const so = noNicho.body.conversas.find(c => String(c.telefone).slice(-8) === '55554444');
    assert(so && so.semConversa && so.id === null, 'quem só recebeu não entrou: ' + JSON.stringify(so || tels));
    assert(so.ultimaMensagem === 'Oi, temos novidades', 'a linha não trouxe a mensagem da campanha');

    // "Responderam" tira quem nunca escreveu; "não responderam" deixa só ele.
    const responderam = await chamar('/api/conversas?nicho=4&situacao=responderam');
    assert(!responderam.body.conversas.some(c => c.semConversa), 'quem só recebeu apareceu em "responderam"');
    const nao = await chamar('/api/conversas?nicho=4&situacao=naoResponderam');
    assert(nao.body.conversas.every(c => c.semConversa || !c.id),
      'alguém que respondeu entrou em "não responderam"');

    // O clique nele cria a conversa, com o histórico que já existia.
    const abriu = await json('/api/conversas/abrir-destino', 'POST', { telefone: '5511955554444', canalId: 1 });
    assert(abriu.body.success && abriu.body.id, JSON.stringify(abriu.body));
    const c = real.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(abriu.body.id);
    assert(c && c.telefone === '5511955554444', 'a conversa não nasceu: ' + JSON.stringify(c));
    const denovo = await json('/api/conversas/abrir-destino', 'POST', { telefone: '5511955554444', canalId: 1 });
    assert(denovo.body.id === abriu.body.id, 'abrir duas vezes criou duas conversas');
    // E agora ela deixa de ser "só recebeu": tem conversa.
    const depois = await chamar('/api/conversas?nicho=4&situacao=todos');
    assert(!depois.body.conversas.some(x => x.semConversa && String(x.telefone).slice(-8) === '55554444'),
      'continuou listado como quem só recebeu');
  });

  await t('A11 a REACAO nao vira balao: ela marca a mensagem reagida', async () => {
    // Até 02/10 a reação era gravada com texto vazio e sem referência, e virava
    // um balão "(sem texto)" no meio da conversa (44 em 30 dias, no 1bit).
    const { daReacao } = require('../whatsapp-webhook');
    const r = daReacao({ reactionMessage: { text: '👍', key: { id: 'MSG-A11' } } });
    assert(r && r.emoji === '👍' && r.alvo === 'MSG-A11', JSON.stringify(r));
    assert(daReacao({ conversation: 'oi' }) === null, 'mensagem comum virou reação');
    // Retirar a reação chega com texto vazio: é o que apaga o emoji de lá.
    assert(daReacao({ reactionMessage: { text: '', key: { id: 'X' } } }).emoji === '', 'reação retirada');

    const alvo = inserir('MSG-A11', true, 'mensagem que recebeu reação');
    real.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, texto, message_type, timestamp, citaWaId)
      VALUES ('REACT-1', 'inst1', ?, 0, '👍', 'reactionMessage', ?, 'MSG-A11')`).run(JID, agora());

    const d = await chamar(`/api/conversas/${conversaId}`);
    const msgs = d.body.mensagens;
    assert(!msgs.some(m => m.message_type === 'reactionMessage'), 'a reação apareceu como mensagem na conversa');
    const reagida = msgs.find(m => m.id === alvo);
    assert(reagida && reagida.reacoes === '👍', `a mensagem reagida não traz a reação: ${JSON.stringify(reagida && reagida.reacoes)}`);
  });

  await t('A12 a situacao recorta COM e SEM nicho, e o roteiro entra nela', async () => {
    // O seletor de situação passou a valer fora do nicho (02/10): antes, em
    // "Todos os nichos" ele sumia da tela e não recortava nada.
    const semResposta = Number(real.prepare(`INSERT INTO conv_conversas (canal, canalId, jid, telefone, nome, estado)
      VALUES ('whatsapp', 1, '5511700001111@s.whatsapp.net', '5511700001111', 'Nunca escreveu', 'aberta')`)
      .run().lastInsertRowid);
    real.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, texto, timestamp)
      VALUES ('SO-NOSSA', 'inst1', '5511700001111@s.whatsapp.net', 1, 'oi, tudo bem?', ?)`).run(agora());

    const naoResp = await chamar('/api/conversas?situacao=naoResponderam');
    assert(naoResp.body.conversas.some(c => c.id === semResposta), 'quem nunca escreveu ficou fora de "não responderam"');
    assert(!naoResp.body.conversas.some(c => c.id === conversaId), 'quem respondeu entrou em "não responderam"');

    const resp = await chamar('/api/conversas?situacao=responderam');
    assert(resp.body.conversas.some(c => c.id === conversaId), 'quem respondeu ficou fora de "responderam"');
    assert(!resp.body.conversas.some(c => c.id === semResposta), 'quem nunca escreveu entrou em "responderam"');

    // Qualificado: era um chip à parte e virou opção da mesma lista.
    real.prepare(`INSERT INTO roteiros (id, nome, canal, ativo, config) VALUES (7, 'WhatsApp', 'whatsapp', 1, '{}')`).run();
    real.prepare(`INSERT INTO roteiro_visitas (roteiroId, conversaId, resultado) VALUES (7, ?, 'qualificado')`).run(conversaId);
    const qual = await chamar('/api/conversas?situacao=qualificados');
    assert(qual.body.conversas.length === 1 && qual.body.conversas[0].id === conversaId,
      'qualificados: ' + JSON.stringify(qual.body.conversas.map(c => c.id)));
    assert(qual.body.contagem.qualificados === 1, 'contagem: ' + JSON.stringify(qual.body.contagem.qualificados));
  });

  await t('A13 a pausa da IA na LISTA diz o mesmo que na conversa', async () => {
    // O selo da lista e o botão da conversa leem a mesma pausa, e por isso têm
    // de concordar. A primeira versão do selo olhava só "existe mensagem humana
    // nas últimas 4 h": marcava como pausada a conversa já retomada e a que
    // recebeu a mensagem por outro número, e a tela se contradizia.
    const pausada = Number(real.prepare(`INSERT INTO conv_conversas (canal, canalId, jid, telefone, nome, estado)
      VALUES ('whatsapp', 1, '5511600002222@s.whatsapp.net', '5511600002222', 'Em pausa', 'aberta')`)
      .run().lastInsertRowid);
    // Mensagem NOSSA e escrita à mão (from_bot = 0) agora mesmo: é o que pausa.
    real.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, from_bot, texto, timestamp)
      VALUES ('PAUSA-1', 'inst1', '5511600002222@s.whatsapp.net', 1, 0, 'já respondo', ?)`).run(agora());

    const comoAListaVe = async (id) => {
      const r = await chamar('/api/conversas');
      const c = r.body.conversas.find((x) => x.id === id);
      return !!(c && c.iaPausada);
    };
    const comoAConversaVe = async (id) => {
      const r = await chamar('/api/conversas/' + id);
      return !!(r.body.pausaIA && r.body.pausaIA.pausada);
    };

    assert(await comoAListaVe(pausada) && await comoAConversaVe(pausada),
      'a conversa com resposta humana recente não aparece pausada nos dois lugares');

    // A RETOMADA anula a pausa — e tem de anular nos dois.
    await chamar(`/api/conversas/${pausada}/retomar-ia`, { method: 'POST' });
    assert(!(await comoAConversaVe(pausada)), 'a conversa continuou pausada depois do retomar');
    assert(!(await comoAListaVe(pausada)), 'a LISTA continuou com o selo de pausada depois do retomar');

    // Mensagem da IA (`from_bot = 1`) não pausa, e mensagem de OUTRO número
    // também não: a conversa é do canal 1.
    const outra = Number(real.prepare(`INSERT INTO conv_conversas (canal, canalId, jid, telefone, nome, estado)
      VALUES ('whatsapp', 1, '5511600003333@s.whatsapp.net', '5511600003333', 'Sem pausa', 'aberta')`)
      .run().lastInsertRowid);
    real.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, from_bot, texto, timestamp)
      VALUES ('PAUSA-2', 'inst1', '5511600003333@s.whatsapp.net', 1, 1, 'resposta da IA', ?)`).run(agora());
    real.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, from_bot, texto, timestamp)
      VALUES ('PAUSA-3', 'outra-inst', '5511600003333@s.whatsapp.net', 1, 0, 'de outro numero', ?)`).run(agora());
    assert(!(await comoAListaVe(outra)) && !(await comoAConversaVe(outra)),
      'resposta da IA ou de outro número pausou a conversa');
  });

  await t('A8 o id citado sai do contextInfo em qualquer formato de mensagem', () => {
    const { idCitado } = require('../whatsapp-webhook');
    const casos = [
      [{ extendedTextMessage: { text: 'sim', contextInfo: { stanzaId: 'Q1' } } }, 'Q1'],
      [{ imageMessage: { caption: 'foto', contextInfo: { stanzaId: 'Q2' } } }, 'Q2'],
      [{ ephemeralMessage: { message: { extendedTextMessage: { text: 'x', contextInfo: { stanzaId: 'Q3' } } } } }, 'Q3'],
      [{ conversation: 'sem citação' }, null],
      [{ extendedTextMessage: { text: 'sem contexto' } }, null],
      [null, null],
    ];
    for (const [msg, esperado] of casos) {
      const r = idCitado(msg);
      assert(r === esperado, `${JSON.stringify(msg).slice(0, 70)} → ${JSON.stringify(r)}`);
    }
  });

  await t('A14 o pedaco DEPOIS do ultimo balao traz so o que chegou, em ordem e sem lacuna', async () => {
    const jid = '5511600004444@s.whatsapp.net';
    const conv = Number(real.prepare(`INSERT INTO conv_conversas (canal, canalId, jid, telefone, nome, estado, naoLidas)
      VALUES ('whatsapp', 1, ?, '5511600004444', 'Pelo celular', 'aberta', 2)`).run(jid).lastInsertRowid);
    const por = (waId, deMim, texto) => Number(real.prepare(`INSERT INTO whatsapp_messages
      (wa_message_id, instance, remote_jid, from_me, texto, message_type, timestamp)
      VALUES (?, 'inst1', ?, ?, ?, 'conversation', ?)`)
      .run(waId, jid, deMim ? 1 : 0, texto, agora()).lastInsertRowid);
    const pintadas = [por('N-1', false, 'bom dia'), por('N-2', true, 'bom dia!'), por('N-3', false, 'tem em estoque?')];
    const ultimo = pintadas[2];

    // Nada chegou ainda: o tique da tela não pode trazer balão nenhum.
    const vazio = await chamar(`/api/conversas/${conv}/mensagens?depoisDe=${ultimo}`);
    assert(vazio.body.mensagens.length === 0, 'o pedaço seguinte veio com mensagem sem nada ter chegado');

    // Duas chegaram: a do contato e a que ele mesmo mandou pelo celular.
    const nova1 = por('N-4', false, 'chegou pelo celular');
    const nova2 = por('N-5', true, 'respondi pelo celular');
    const r = await chamar(`/api/conversas/${conv}/mensagens?depoisDe=${ultimo}`);
    const ids = r.body.mensagens.map((m) => m.id);
    assert(JSON.stringify(ids) === JSON.stringify([nova1, nova2]), 'o pedaço seguinte veio errado: ' + ids.join(','));
    // `temMais` fala do histórico antigo: dito aqui, a tela ofereceria o botão
    // de carregar anteriores depois da mensagem nova.
    assert(r.body.temMais === false, 'o pedaço seguinte prometeu histórico anterior');
    assert(real.prepare('SELECT naoLidas FROM conv_conversas WHERE id = ?').get(conv).naoLidas === 0,
      'a conversa aberta continuou com não lidas depois de entregar a mensagem nova');

    // Aba escondida por muito tempo: mais mensagens novas do que o pedaço
    // aguenta. O corte tem de pegar as MAIS ANTIGAS das novas — cortando pelo
    // outro lado, o meio da conversa some sem ninguém saber.
    // Numa transação só: 401 inserções com fsync cada passam dos 5 s de
    // keep-alive do servidor, e o `fetch` seguinte morre em ECONNRESET
    // reusando um socket que o servidor já fechou.
    const muitas = real.transaction(() => {
      const ids = [];
      for (let i = 0; i < 401; i++) ids.push(por('N-M' + i, false, 'mensagem ' + i));
      return ids;
    })();
    const cheio = await chamar(`/api/conversas/${conv}/mensagens?depoisDe=${nova2}`);
    assert(cheio.body.mensagens.length === 400, 'o pedaço seguinte não respeitou o limite: ' + cheio.body.mensagens.length);
    assert(cheio.body.mensagens[0].id === muitas[0],
      'o pedaço seguinte começou pela mais recente e deixou lacuna no meio da conversa');
    // E o tique seguinte completa o resto, sem pular nada.
    const resto = await chamar(`/api/conversas/${conv}/mensagens?depoisDe=${muitas[399]}`);
    assert(resto.body.mensagens.length === 1 && resto.body.mensagens[0].id === muitas[400],
      'o que sobrou do pedaço seguinte não veio no tique seguinte');
  });

  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
});
