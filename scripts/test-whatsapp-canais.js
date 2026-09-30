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
  const json = m && m[1] === 'instance/connectionState' ? { instance: { state: 'open' } } : { key: { id: 'WA' + (++seqMsg) } };
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
    await esperar(300);
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
    await esperar(300);
    const conv = db.prepare('SELECT canalId FROM conv_conversas WHERE jid = ? ORDER BY canalId').all(JID).map(c => c.canalId).join(',');
    assert(conv === '1,2', 'conversas do contato: ' + conv);
    assert(envios(de).length === 0, 'o comercial respondeu com a IA desligada');
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

  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERRO: ' + e.stack); process.exit(1); });
