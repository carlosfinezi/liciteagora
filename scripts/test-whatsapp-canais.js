#!/usr/bin/env node
/**
 * test-whatsapp-canais.js — vários números de WhatsApp na mesma empresa.
 *
 * Desde 28/09 a empresa pode ter vários números, cada um com seu atendente de
 * IA, seu horário e seu ritmo; a conversa é única por contato E número, e a
 * resposta sai pelo número por onde a pessoa escreveu. Esta suíte roda o
 * código de verdade (adapter, webhook, conversas) com dois números no banco e
 * a Evolution e a IA simuladas: toda chamada à Evolution é anotada com a
 * instância, e é a instância que prova por qual número a mensagem saiu.
 *
 * Banco em memória com o schema real do tenant; nada em data/.
 */
'use strict';

const path = require('path');
const Module = require('module');
const Database = require('better-sqlite3');

// ── IA simulada: devolve o nome do número que pediu, lido do prompt ──────────
const IA = { prompts: [] };
const carregarOriginal = Module._load;
Module._load = function (pedido) {
  const nome = path.basename(String(pedido)).replace(/\.js$/, '');
  if (nome === 'chat-ia') {
    return { chamarChatLLM: async (msgs) => { IA.prompts.push(msgs[0].content); return { content: 'resposta da IA', provider: 't' }; } };
  }
  if (nome === 'ia-modelos') return { resolverModelos: () => ({}) };
  return carregarOriginal.apply(this, arguments);
};

// ── Evolution simulada: anota instância e rota de cada chamada ──────────────
const EVO = [];
let seqMsg = 0;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = u.match(/\/(message\/sendText|message\/sendMedia|instance\/connectionState|instance\/logout|webhook\/set)\/([^/?]+)/);
  EVO.push({ rota: m ? m[1] : u, instance: m ? m[2] : null, corpo: opts.body ? JSON.parse(opts.body) : null });
  // A Evolution devolve o jid COMO ELA CONHECE o número, que pode não ser o que
  // enviamos (o nono dígito cai em muitos números). O E7 mede justamente isso.
  const enviado = String(opts.body ? (JSON.parse(opts.body).number || '') : '').replace(/\D/g, '');
  // Em regra o jid devolvido é o número que enviamos. A exceção é o número do
  // E7, que volta SEM o nono dígito — é o caso do 1bit, onde a conversa real é
  // 559484512288 e o envio vai para 5594984512288.
  const SEM_NONO = { '5594944443333': '559444443333' };
  const jidReal = enviado ? (SEM_NONO[enviado] || enviado) + '@s.whatsapp.net' : null;
  const json = m && m[1] === 'instance/connectionState' ? { instance: { state: 'open' } }
    : { key: { id: 'WA' + (++seqMsg), remoteJid: jidReal } };
  return { status: 200, json: async () => json };
};

const RAIZ = path.join(__dirname, '..');
const adapter = require(path.join(RAIZ, 'whatsapp-adapter'));
const canais = require(path.join(RAIZ, 'whatsapp-canais'));
const webhook = require(path.join(RAIZ, 'whatsapp-webhook'));
const express = require('express');

// ── banco ────────────────────────────────────────────────────────────────────
const db = new Database(':memory:');
const schema = require('./schema-de-tenant').lerSchema(null, '1bit');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
db.exec('CREATE TABLE IF NOT EXISTS optica_flag_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, evento TEXT, valor_antes TEXT, valor_depois TEXT, dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)');
for (const tb of ['whatsapp_queue', 'whatsapp_messages', 'whatsapp_config', 'conv_conversas', 'ia_base', 'wa_campanha_dest']) {
  try { db.exec(`DELETE FROM ${tb}`); } catch (_) {}
}
const setCfg = (k, v) => { db.prepare('DELETE FROM config WHERE chave = ?').run(k); db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?)').run(k, v); };
setCfg('whatsapp_enabled', '1');
setCfg('gemini_api_key', 'chave-falsa');
canais.migrarCanais(db);
db.exec('DELETE FROM whatsapp_canais');
// Número 1: comercial, padrão, IA desligada. Número 2: suporte, IA ligada com
// instruções e tom próprios e limite de 1 envio por hora.
const insCanal = db.prepare('INSERT INTO whatsapp_canais (id, nome, instance, baseUrl, apikey, padrao, config) VALUES (?, ?, ?, ?, ?, ?, ?)');
// Limites curtos no 1 para a suíte não esperar 45 s; o de 2 por hora é o que
// separa o ritmo por número do ritmo somado da empresa (A2 e A3).
insCanal.run(1, 'Comercial', 'le_demo', 'http://evo', 'k', 1, JSON.stringify({
  whatsapp_ai_enabled: '0', intervalo_min_s: '1', limite_hora: '2' }));
insCanal.run(2, 'Suporte', 'le_demo_2', 'http://evo', 'k', 0, JSON.stringify({
  whatsapp_ai_enabled: '1', whatsapp_ai_prompt: 'INSTRUCOES-DO-SUPORTE', whatsapp_ai_tom: 'formal', limite_hora: '1' }));
db.prepare("INSERT INTO ia_base (titulo, conteudo, ativo) VALUES ('Horário', 'BASE-DA-EMPRESA', 1)").run();

// ── rotas e webhook ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
adapter.registrarRotasWhatsApp(app, db);
require('../conversas-routes').registrarRotasConversas(app, db);
const tenantManager = {
  listAll: () => [{ slug: 'demo' }], getDb: () => db, getTenantBySlug: (s) => (s === 'demo' ? { slug: 'demo' } : null),
};
webhook.registrarRotaWebhook(app, { tenantManager });

function chamar(metodo, rota, { params = {}, body = {}, query = {} } = {}) {
  let h = null;
  for (const c of app.router.stack) {
    if (c.route && c.route.path === rota && c.route.methods[metodo]) h = c.route.stack[c.route.stack.length - 1].handle;
  }
  if (!h) throw new Error(`rota ${metodo.toUpperCase()} ${rota} não registrada`);
  return new Promise((ok) => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this; }, json(b) { ok({ status: this.statusCode, body: b }); },
                  sendStatus(s) { ok({ status: s }); } };
    Promise.resolve(h({ params, body, query, tenantCtx: { slug: 'demo' }, tenantDb: db, session: { username: 't' }, user: { id: 1 } }, res))
      .catch((e) => ok({ status: 500, body: { error: e.message } }));
  });
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
// O atendimento só responde depois de conferir que o contato não escreveu de
// novo, para duas mensagens seguidas receberem UMA resposta
// (`aindaEhAUltimaFala`, no whatsapp-webhook). Quem mede a resposta — ou a
// AUSÊNCIA dela — espera mais que isso, senão mede só o atraso e fica verde
// sem provar nada.
const ATENDIMENTO_MS = 8000;
const chegou = (instance, jid, texto, id) => chamar('post', '/api/whatsapp/webhook', { body: {
  event: 'messages.upsert', instance,
  data: { key: { id, remoteJid: jid, fromMe: false }, pushName: 'Maria', message: { conversation: texto }, messageTimestamp: Math.floor(Date.now() / 1000) },
} });

let ok = 0, fail = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const envios = (de) => EVO.slice(de).filter(e => /^message\//.test(e.rota));

(async () => {
  console.log('\n--- envio e ritmo por número ---');

  await t('A1. sem numero pedido, sai pelo padrao; pedido, sai pelo pedido', async () => {
    const de = EVO.length;
    const a = await adapter.enviarWhatsApp(db, { telefone: '94999990001', texto: 'oi' });
    const b = await adapter.enviarWhatsApp(db, { telefone: '94999990002', texto: 'oi', canalId: 2 });
    const e = envios(de);
    assert(a.success && b.success, JSON.stringify([a, b]));
    assert(e[0].instance === 'le_demo' && e[1].instance === 'le_demo_2', 'saiu por ' + e.map(x => x.instance).join(','));
    const fila = db.prepare('SELECT canalId FROM whatsapp_queue ORDER BY id').all().map(r => r.canalId).join(',');
    assert(fila === '1,2', 'a fila não registrou o número: ' + fila);
  });

  await t('A2. o ritmo e de cada numero: o 2 no limite nao segura o 1', async () => {
    const r2 = await adapter.enviarWhatsApp(db, { telefone: '94999990003', texto: 'oi', canalId: 2 });
    assert(r2.segurado && r2.canalId === 2, 'o número 2 (limite 1/hora) devia segurar: ' + JSON.stringify(r2));
    // O 1 tem limite de 2 por hora e mandou 1; a empresa mandou 2. Somando a
    // empresa, como antes de 28/09, este envio seria segurado.
    await esperar(1100);
    const r1 = await adapter.enviarWhatsApp(db, { telefone: '94999990004', texto: 'oi', canalId: 1 });
    assert(r1.success, 'o número 1 foi segurado pelo limite do 2: ' + JSON.stringify(r1));
  });

  await t('A3. imagem passa pelo ritmo e entra na fila (antes nao passava)', async () => {
    const fs = require('fs');
    const img = '/tmp/test-whatsapp-canais.png';
    fs.writeFileSync(img, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]));
    const r = await adapter.enviarWhatsAppMidia(db, { telefone: '94999990005', texto: 'com foto', imagePath: img, canalId: 2 });
    assert(r.segurado, 'a imagem furou o limite do número: ' + JSON.stringify(r));
    canais.salvarConfigCanal(db, 1, { limite_hora: '3' });   // o 1 tem 2 envios; cabe mais um
    await esperar(1100);
    const de = EVO.length;
    const r1 = await adapter.enviarWhatsAppMidia(db, { telefone: '94999990006', texto: 'com foto', imagePath: img, canalId: 1 });
    assert(r1.success && envios(de)[0].rota === 'message/sendMedia', JSON.stringify(r1));
    const naFila = db.prepare("SELECT COUNT(*) n FROM whatsapp_queue WHERE texto = 'com foto' AND status = 'enviado' AND canalId = 1").get().n;
    assert(naFila === 1, 'a imagem enviada não entrou na fila');
  });

  await t('A3b. video sai como mediatype video, e nao como imagem quebrada', async () => {
    const fs = require('fs');
    // Pasta própria, e não nome fixo em /tmp: arquivo fixo deixado por outra
    // rodada, de outro usuário, reprova a suíte sem defeito nenhum (é o que
    // acontece com o .png da A3).
    const vid = path.join(fs.mkdtempSync(require('os').tmpdir() + '/wa-canais-'), 'promo.mp4');
    fs.writeFileSync(vid, Buffer.concat([Buffer.from('0000001c', 'hex'), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(16)]));
    canais.salvarConfigCanal(db, 1, { limite_hora: '9' });
    await esperar(1100);
    const de = EVO.length;
    const r = await adapter.enviarWhatsAppMidia(db, { telefone: '94999990008', texto: 'com vídeo', imagePath: vid, canalId: 1 });
    const c = envios(de)[0];
    assert(r.success && c.rota === 'message/sendMedia', JSON.stringify(r));
    assert(c.corpo.mediatype === 'video' && c.corpo.mimetype === 'video/mp4',
      'o vídeo saiu como ' + c.corpo.mediatype + '/' + c.corpo.mimetype);
    assert(c.corpo.caption === 'com vídeo', 'a mensagem não foi a legenda do vídeo');
  });

  await t('A4. numero removido: recusa, e nao cai no padrao', async () => {
    const r = await adapter.enviarWhatsApp(db, { telefone: '94999990007', texto: 'oi', canalId: 99 });
    assert(!r.success && /não encontrado/.test(r.error), JSON.stringify(r));
  });

  console.log('\n--- o webhook e o atendente de cada número ---');

  await t('B1. o nome do numero extra (le_<empresa>_<n>) chega na empresa certa', () => {
    assert(webhook.slugFromInstance('le_demo_2', tenantManager) === 'demo', webhook.slugFromInstance('le_demo_2', tenantManager));
    assert(webhook.slugFromInstance('le_demo', tenantManager) === 'demo', 'o número original deixou de resolver');
  });

  const JID = '5594988887777@s.whatsapp.net';
  await t('B2. mensagem pelo suporte vira conversa do suporte, e a IA dele responde PELO suporte', async () => {
    const de = EVO.length, p0 = IA.prompts.length;
    await chegou('le_demo_2', JID, 'quero ajuda', 'IN1');
    await esperar(ATENDIMENTO_MS);
    const conv = db.prepare('SELECT canalId FROM conv_conversas WHERE jid = ?').all(JID);
    assert(conv.length === 1 && conv[0].canalId === 2, 'conversa: ' + JSON.stringify(conv));
    const e = envios(de);
    assert(e.length === 1 && e[0].instance === 'le_demo_2', 'a resposta saiu por ' + e.map(x => x.instance).join(','));
    const prompt = IA.prompts[p0] || '';
    assert(/INSTRUCOES-DO-SUPORTE/.test(prompt), 'o prompt não usou as instruções do número');
    assert(/senhor ou senhora/.test(prompt), 'o prompt não usou o tom do número (formal)');
    assert(/BASE-DA-EMPRESA/.test(prompt), 'a Base da IA da empresa ficou de fora');
  });

  await t('B3. o mesmo contato pelo comercial e outra conversa, e a IA do comercial (desligada) nao responde', async () => {
    const de = EVO.length;
    await chegou('le_demo', JID, 'quero comprar', 'IN2');
    await esperar(ATENDIMENTO_MS);
    const conv = db.prepare('SELECT canalId FROM conv_conversas WHERE jid = ? ORDER BY canalId').all(JID).map(c => c.canalId).join(',');
    assert(conv === '1,2', 'conversas do contato: ' + conv);
    assert(envios(de).length === 0, 'o comercial respondeu com a IA desligada');
  });

  console.log('\n--- a pausa da IA e a mensagem vista pelos dois números ---');

  // 30/09: o teste de campanha do 1bit pareceu quebrado por duas razões que
  // ninguém via. Estas quatro medem as duas, e o que se fez com elas.
  await t('E1. a mesma mensagem nos dois numeros da empresa conta como duas visoes', async () => {
    const jid2 = '5594977776666@s.whatsapp.net';
    // Um número da empresa mandando para o outro: o WhatsApp entrega o MESMO id
    // às duas instâncias, uma como própria e a outra como recebida. O único em
    // wa_message_id sozinho engolia a segunda, e a resposta nunca era tratada
    // como recebida.
    await chamar('post', '/api/whatsapp/webhook', { body: { event: 'messages.upsert', instance: 'le_demo_2',
      data: { key: { id: 'DUP1', remoteJid: jid2, fromMe: true }, message: { conversation: 'Sim' },
              messageTimestamp: Math.floor(Date.now() / 1000) } } });
    await esperar(200);
    const de = EVO.length;
    await chegou('le_demo', jid2, 'Sim', 'DUP1');
    await esperar(ATENDIMENTO_MS);
    const linhas = db.prepare("SELECT instance, from_me FROM whatsapp_messages WHERE wa_message_id = 'DUP1' ORDER BY instance").all();
    assert(linhas.length === 2, 'visões gravadas: ' + JSON.stringify(linhas));
    assert(linhas.some(l => l.instance === 'le_demo' && l.from_me === 0), 'a visão de quem recebeu não entrou');
    assert(envios(de).length === 0, 'o comercial tem a IA desligada e respondeu');
  });

  await t('E2. resposta humana pausa a IA, e a pausa e dita com hora', async () => {
    const jid3 = '5594966665555@s.whatsapp.net';
    await chegou('le_demo_2', jid3, 'oi', 'P1');              // cria a conversa no suporte (IA ligada)
    await esperar(ATENDIMENTO_MS);
    const conv = db.prepare("SELECT id FROM conv_conversas WHERE jid = ? AND canalId = 2").get(jid3);
    // O atendente responde à mão pela tela: é o que arma a pausa de 4 horas.
    await chamar('post', '/api/conversas/:id/responder', { params: { id: conv.id }, body: { texto: 'eu assumo' } });
    const aberta = await chamar('get', '/api/conversas/:id', { params: { id: conv.id } });
    assert(aberta.body.pausaIA && aberta.body.pausaIA.pausada, 'a tela não recebeu a pausa: ' + JSON.stringify(aberta.body.pausaIA));
    assert(aberta.body.pausaIA.ate > Math.floor(Date.now() / 1000), 'a pausa não diz até quando');
    // E a IA se cala mesmo: a próxima mensagem do contato não é respondida.
    const de = EVO.length;
    await chegou('le_demo_2', jid3, 'Sim', 'P2');
    await esperar(ATENDIMENTO_MS);
    assert(envios(de).length === 0, 'a IA respondeu durante a pausa');
  });

  await t('E3. "Retomar a IA" anula a pausa, e a proxima mensagem e respondida', async () => {
    const jid3 = '5594966665555@s.whatsapp.net';
    const conv = db.prepare("SELECT id FROM conv_conversas WHERE jid = ? AND canalId = 2").get(jid3);
    const r = await chamar('post', '/api/conversas/:id/retomar-ia', { params: { id: conv.id } });
    assert(r.body.success && !r.body.pausa.pausada, 'a pausa continuou: ' + JSON.stringify(r.body));
    const de = EVO.length;
    await chegou('le_demo_2', jid3, 'Sim de novo', 'P3');
    await esperar(ATENDIMENTO_MS);
    assert(envios(de).length === 1, 'a IA continuou calada depois do retomar');
  });

  await t('E4. a tela mostra a pausa e o botao de retomar', () => {
    const tela = require('fs').readFileSync(path.join(RAIZ, 'public/comunicacao/conversas.html'), 'utf8');
    assert(/pausaIA/.test(tela), 'a tela não lê a pausa');
    assert(/retomarIA\(/.test(tela) && /retomar-ia/.test(tela), 'a tela não tem o botão de retomar');
  });



  // 30/09: com o escopo em 'campanha', a IA só respondia a quem veio da campanha
  // LEGADO. A nova grava em `comm_envios`, e o atendimento nem olhava lá: todo
  // lead de campanha nova ficava sem resposta, e foi isso que fez os testes do
  // 1bit parecerem quebrados três vezes.
  await t('E6. escopo "campanha": quem veio da campanha NOVA tambem e atendido', async () => {
    const jid4 = '5594955554444@s.whatsapp.net';
    canais.salvarConfigCanal(db, 2, { whatsapp_ai_escopo: 'campanha' });
    // Contato sem campanha nenhuma: o escopo o exclui, e isso continua valendo.
    const de0 = EVO.length;
    await chegou('le_demo_2', jid4, 'oi', 'ESC0');
    await esperar(ATENDIMENTO_MS);
    assert(envios(de0).length === 0, 'o escopo campanha respondeu a quem não veio de campanha');

    // Agora o mesmo contato como destinatário JÁ ENVIADO de uma campanha nova.
    const tpl = Number(db.prepare("INSERT INTO comm_templates (nome, canal, corpo) VALUES ('e6','whatsapp','Oi')").run().lastInsertRowid);
    const lst = Number(db.prepare("INSERT INTO comm_listas (nome) VALUES ('e6')").run().lastInsertRowid);
    const camp = Number(db.prepare(`INSERT INTO comm_campanhas (nome, templateId, listaId, canal, status, tipo)
      VALUES ('e6', ?, ?, 'whatsapp', 'enviada', 'marketing')`).run(tpl, lst).lastInsertRowid);
    // O `canalId` é o do número que disparou, como o envio real grava
    // (comm-routes, ao marcar 'enviado'). Aqui é o 2, o mesmo por onde a
    // conversa chega: campanha conta pelo número por onde ela saiu.
    const envio = Number(db.prepare(`INSERT INTO comm_envios (campanhaId, canal, destino, mensagemRenderizada, status, dataEnvio, rodada, canalId)
      VALUES (?, 'whatsapp', ?, 'Oi', 'enviado', ?, 1, 2)`).run(camp, '5594955554444', new Date().toISOString()).lastInsertRowid);
    const de = EVO.length;
    await chegou('le_demo_2', jid4, 'Sim', 'ESC1');
    await esperar(ATENDIMENTO_MS);
    assert(envios(de).length === 1, 'a IA não respondeu a quem veio da campanha nova');

    // E a campanha que saiu por OUTRO número não vale (05/10/2026): no 1bit a
    // campanha saiu pelo Principal, o contato escreveu para o número pessoal do
    // atendente e a IA respondeu lá, porque o casamento era só pelo telefone.
    db.prepare('UPDATE comm_envios SET canalId = 1 WHERE id = ?').run(envio);
    const de2 = EVO.length;
    await chegou('le_demo_2', jid4, 'E agora', 'ESC2');
    await esperar(ATENDIMENTO_MS);
    assert(envios(de2).length === 0, 'a campanha de outro número fez a IA responder, e o escopo vaza');
    // Limpa para não mexer na contagem das provas de conversa.
    const c = db.prepare('SELECT id FROM conv_conversas WHERE jid = ?').all(jid4).map(x => x.id);
    for (const id of c) db.prepare('DELETE FROM conv_eventos WHERE conversaId = ?').run(id);
    db.prepare('DELETE FROM conv_conversas WHERE jid = ?').run(jid4);
    db.prepare('DELETE FROM whatsapp_messages WHERE remote_jid = ?').run(jid4);
    canais.salvarConfigCanal(db, 2, { whatsapp_ai_escopo: 'todos' });
  });

  // 30/09: o que o sistema mandava ia só para `whatsapp_queue`, então a tela
  // mostrava a resposta do contato sem a mensagem que a provocou, e a IA, que lê
  // o mesmo histórico, respondia fora do assunto por não saber o que foi
  // oferecido. Foi o que aconteceu com a campanha de alimentação do 1bit.
  await t('E7. o que o sistema envia entra no historico, com o jid que o WhatsApp devolve', async () => {
    const jid5 = '559444443333@s.whatsapp.net';          // sem o nono dígito, como o WhatsApp responde
    // Enviamos para o número COM o nono; a Evolution devolve o jid real.
    const r = await adapter.enviarWhatsApp(db, { telefone: '5594944443333', texto: 'Oi, tudo bem?', canalId: 1, ignorarRitmo: true });
    assert(r.success, JSON.stringify(r));
    const m = db.prepare("SELECT remote_jid, from_me, from_bot, texto FROM whatsapp_messages WHERE texto = 'Oi, tudo bem?'").get();
    assert(m, 'o enviado não entrou no histórico');
    assert(m.remote_jid === jid5, `gravou em ${m.remote_jid}, e a conversa real é ${jid5}`);
    assert(m.from_me === 1 && m.from_bot === 1, 'não ficou marcado como mensagem nossa: ' + JSON.stringify(m));
    // E não inventa conversa: campanha de 27 mil contatos não cria 27 mil linhas na tela.
    const conv = db.prepare('SELECT COUNT(*) n FROM conv_conversas WHERE jid = ?').get(jid5).n;
    assert(conv === 0, 'criou conversa para quem só recebeu');
    db.prepare('DELETE FROM whatsapp_messages WHERE remote_jid = ?').run(jid5);
  });

  await t('E5. as provas da pausa nao deixam conversa de teste para tras', () => {
    // A C1 conta as conversas existentes: as três criadas aqui a fariam reprovar
    // sem defeito nenhum (é o que aconteceu ao escrever este bloco).
    for (const j of ['5594977776666@s.whatsapp.net', '5594966665555@s.whatsapp.net']) {
      const c = db.prepare('SELECT id FROM conv_conversas WHERE jid = ?').all(j).map(x => x.id);
      for (const id of c) db.prepare('DELETE FROM conv_eventos WHERE conversaId = ?').run(id);
      db.prepare('DELETE FROM conv_conversas WHERE jid = ?').run(j);
      db.prepare('DELETE FROM whatsapp_messages WHERE remote_jid = ?').run(j);
    }
    const restou = db.prepare("SELECT COUNT(*) n FROM conv_conversas WHERE jid LIKE '%7776666%' OR jid LIKE '%6665555%'").get().n;
    assert(restou === 0, `ficaram ${restou} conversas de teste`);
  });

  console.log('\n--- a caixa de conversas ---');

  await t('C1. filtro por numero, com o nome do numero em cada conversa', async () => {
    const todos = await chamar('get', '/api/conversas');
    const doSuporte = await chamar('get', '/api/conversas', { query: { canal: '2' } });
    assert(todos.body.conversas.length === 2, `sem filtro: ${todos.body.conversas.length}`);
    assert(doSuporte.body.conversas.length === 1 && doSuporte.body.conversas[0].canalNome === 'Suporte', JSON.stringify(doSuporte.body.conversas));
    assert(doSuporte.body.contagem.total === 1, 'a contagem não seguiu o filtro: ' + doSuporte.body.contagem.total);
    assert(todos.body.canais.length === 2, 'a tela não recebeu os números para o filtro');
  });

  await t('C2. a conversa mostra so as mensagens do seu numero', async () => {
    const c = db.prepare('SELECT id FROM conv_conversas WHERE jid = ? AND canalId = 1').get(JID);
    const r = await chamar('get', '/api/conversas/:id', { params: { id: c.id } });
    const textos = r.body.mensagens.map(m => m.texto);
    assert(textos.includes('quero comprar') && !textos.includes('quero ajuda'), 'mensagens: ' + textos.join(' | '));
  });

  await t('C3. responder sai pelo numero da conversa', async () => {
    const c = db.prepare('SELECT id FROM conv_conversas WHERE jid = ? AND canalId = 1').get(JID);
    const de = EVO.length;
    const r = await chamar('post', '/api/conversas/:id/responder', { params: { id: c.id }, body: { texto: 'do comercial' } });
    assert(r.body.success, JSON.stringify(r.body));
    assert(envios(de)[0].instance === 'le_demo', 'saiu por ' + envios(de).map(x => x.instance).join(','));
    const gravada = db.prepare("SELECT instance FROM whatsapp_messages WHERE texto = 'do comercial'").get();
    assert(gravada && gravada.instance === 'le_demo', 'a mensagem enviada ficou sem o número');
  });

  console.log('\n--- configuração e cadastro dos números ---');

  await t('D1. configurar o atendente de um numero nao mexe no outro', async () => {
    const r = await chamar('post', '/api/whatsapp/ai-config', { body: { canalId: 1, enabled: true, prompt: 'SO-DO-COMERCIAL' } });
    assert(r.body.success, JSON.stringify(r.body));
    const c1 = await chamar('get', '/api/whatsapp/ai-config', { query: { canal: '1' } });
    const c2 = await chamar('get', '/api/whatsapp/ai-config', { query: { canal: '2' } });
    assert(c1.body.prompt === 'SO-DO-COMERCIAL' && c1.body.enabled, JSON.stringify(c1.body.prompt));
    assert(c2.body.prompt === 'INSTRUCOES-DO-SUPORTE', 'o suporte mudou junto: ' + c2.body.prompt);
  });

  await t('D2. ritmo do numero: grava, e numero invalido e recusado', async () => {
    const r = await chamar('post', '/api/whatsapp/ai-config', { body: { canalId: 1, ritmo: { limiteHora: 10, intervaloMinS: '', limiteDia: 100 } } });
    assert(r.body.success, JSON.stringify(r.body));
    const c1 = canais.canalPorId(db, 1);
    assert(c1.config.limite_hora === '10' && c1.config.limite_dia === '100' && !('intervalo_min_s' in c1.config), JSON.stringify(c1.config));
    const ruim = await chamar('post', '/api/whatsapp/ai-config', { body: { canalId: 1, ritmo: { limiteHora: 0 } } });
    assert(ruim.status === 400, 'aceitou limite 0: ' + JSON.stringify(ruim.body));
  });

  await t('D2b. a tela Canal recebe os tetos que valem e o padrao de cada um', async () => {
    // Depois do D2: o número 1 tem 10 por hora e 100 por dia configurados, e o
    // intervalo em branco. O padrão do dia depende da idade do número.
    const r = await chamar('get', '/api/whatsapp/ritmo', { query: { canal: '1' } });
    const b = r.body;
    assert(b.success && b.limiteHora === 10 && b.limiteDia === 100 && b.intervaloMinS === 45, JSON.stringify(b));
    assert(b.padrao && b.padrao.limiteHora === 25 && b.padrao.intervaloMinS === 45
      && [40, 90, 180, 300].includes(b.padrao.limiteDia), 'padrão: ' + JSON.stringify(b.padrao));
  });

  await t('D3. numero novo ganha instancia le_<empresa>_<n>, nasce com a IA desligada e nao padrao', async () => {
    const r = await chamar('post', '/api/whatsapp/canais', { body: { nome: 'Financeiro' } });
    assert(r.body.success && r.body.canal.instance === 'le_demo_3' && !r.body.canal.padrao, JSON.stringify(r.body));
    const cfg = await chamar('get', '/api/whatsapp/ai-config', { query: { canal: String(r.body.canal.id) } });
    assert(cfg.body.enabled === false, 'o número novo nasceu com a IA ligada');
    // Herda a configuração do padrão (o número 1, depois do D1 e do D2), menos
    // a IA ligada e o teto do dia, que no número novo é o do aquecimento.
    const novo = canais.canalPorId(db, r.body.canal.id);
    const padrao = canais.canalPadrao(db);
    assert(padrao.config.whatsapp_ai_prompt && padrao.config.limite_hora, 'o padrão não tem o que herdar: ' + JSON.stringify(padrao.config));
    assert(novo.config.whatsapp_ai_prompt === padrao.config.whatsapp_ai_prompt && novo.config.limite_hora === padrao.config.limite_hora,
      'não herdou: ' + JSON.stringify(novo.config));
    assert(!('limite_dia' in novo.config) && !('whatsapp_ai_enabled' in novo.config), 'herdou o que não devia: ' + JSON.stringify(novo.config));
  });

  await t('D4. so um padrao por vez, e o padrao nao pode ser removido', async () => {
    const p = await chamar('put', '/api/whatsapp/canais/:id', { params: { id: 2 }, body: { padrao: true } });
    assert(p.body.success, JSON.stringify(p.body));
    const padroes = db.prepare('SELECT id FROM whatsapp_canais WHERE padrao = 1').all().map(r => r.id).join(',');
    assert(padroes === '2', 'padrões: ' + padroes);
    const del = await chamar('delete', '/api/whatsapp/canais/:id', { params: { id: 2 } });
    assert(del.status === 400 && /padrão/.test(del.body.error), JSON.stringify(del));
    const outro = await chamar('delete', '/api/whatsapp/canais/:id', { params: { id: 1 } });
    assert(outro.body.success && !canais.canalPorId(db, 1), 'o não padrão não saiu');
  });

  await t('D5. a lista de numeros traz a situacao de cada um, sem a apikey', async () => {
    const r = await chamar('get', '/api/whatsapp/canais');
    assert(r.body.success && r.body.canais.every(c => c.state === 'open' && !('apikey' in c)), JSON.stringify(r.body));
  });

  await t('D6. numero nunca usado sai de vez; com historico, a linha fica desativada', async () => {
    const linha = (id) => db.prepare('SELECT id, ativo FROM whatsapp_canais WHERE id = ?').get(id);
    // O 1 saiu no D4 carregando conversas e envios: a linha tem de ficar, senão
    // a caixa de Conversas perde a regra que esconde o que é dele.
    assert(db.prepare('SELECT COUNT(*) n FROM conv_conversas WHERE canalId = 1').get().n > 0, 'o 1 não tem histórico para guardar');
    const guardado = linha(1);
    assert(guardado && guardado.ativo === 0, 'o número com histórico devia ficar desativado: ' + JSON.stringify(guardado));
    // O 3 (Financeiro, criado no D3) nunca enviou nem recebeu nada.
    const del = await chamar('delete', '/api/whatsapp/canais/:id', { params: { id: 3 } });
    assert(del.body.success, JSON.stringify(del.body));
    assert(!linha(3), 'o número nunca usado continuou no banco');
  });

  console.log('\n--- a pausa da IA e a mensagem vista pelos dois números ---');

  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERRO: ' + e.stack); process.exit(1); });
