/**
 * Canais de notificação — o interruptor que não desligava nada.
 *
 * O DEFEITO: /configuracoes/notificacoes.html oferece "Enviar pelo Telegram".
 * Só três emissores consultavam a chave `alerta_canal_telegram` (sniper,
 * vigia de disputa, descoberta por IA). Outros nove chamavam sendTelegram
 * direto — OS, PCP, preventivas, BNC, propostas, habilitação e o sync do
 * PNCP. Desmarcar a caixa desligava três e deixava nove enviando: o usuário
 * desligava o canal e continuava recebendo.
 *
 * Além disso havia TRÊS cópias de lerCanais/enviarAlerta (dispatcher, sniper,
 * vigia), e o dispatcher se declarava "fonte única de verdade".
 *
 * A checagem passou para o transporte (telegram-client.sendTelegram), onde
 * nenhum emissor escapa por esquecimento, com uma única exceção declarada:
 * o teste de credenciais do bot.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const express = require('express');

const RAIZ = path.join(__dirname, '..');

// ---- intercepta o axios para não tocar a rede ----
const axios = require('axios');
let enviados = [];
axios.post = async (url, body) => {
  enviados.push({ url, body });
  return { data: { ok: true } };
};

const tg = require('../telegram-client');
const disp = require('../notificacoes-dispatcher');
const { registrarRotasNotificacoes } = require('../notificacoes-routes');

const DB = '/tmp/vp-notif.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(`
CREATE TABLE config (chave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE telegram_config (id INTEGER PRIMARY KEY, botToken TEXT, chatId TEXT, ativo INTEGER);
INSERT INTO telegram_config (id, botToken, chatId, ativo) VALUES (1, 'tok', 'chat', 1);
`);

const setCfg = (chave, valor) => db.prepare('INSERT OR REPLACE INTO config (chave, valor) VALUES (?,?)').run(chave, valor);
const limpar = () => { db.exec('DELETE FROM config'); enviados = []; };

const app = express();
app.use(express.json());
registrarRotasNotificacoes(app, db);
function chamar(metodo, caminho, body = {}) {
  const camada = app.router.stack.find((l) => l.route && l.route.path === caminho
    && l.route.methods[metodo.toLowerCase()]);
  if (!camada) throw new Error('rota não registrada: ' + caminho);
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); } };
    Promise.resolve(camada.route.stack[0].handle({ body, query: {} }, res, reject)).catch(reject);
  });
}

let ok = 0, fail = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m} (esperado ${b}, veio ${a})`);

(async () => {
console.log('\n== o interruptor agora vale no transporte ==');

await t('canal ligado (padrão) envia', async () => {
  limpar();
  eq(await tg.sendTelegram(db, 'oi'), true, 'deveria enviar');
  eq(enviados.length, 1, 'mensagens enviadas');
});

await t('canal desligado NÃO envia, mesmo chamando sendTelegram direto', async () => {
  limpar();
  setCfg('alerta_canal_telegram', '0');
  eq(await tg.sendTelegram(db, 'oi'), false, 'não deveria enviar');
  eq(enviados.length, 0, 'nada deveria sair');
});

await t('tenant que nunca abriu a tela continua recebendo', async () => {
  limpar();  // sem nenhuma chave gravada
  eq(tg.canalTelegramLigado(db), true, 'default deve ser ligado');
  eq(await tg.sendTelegram(db, 'oi'), true, 'deveria enviar');
});

await t('config ausente (banco em migração) não engole alerta', async () => {
  const sem = new Database(':memory:');
  sem.exec(`CREATE TABLE telegram_config (id INTEGER PRIMARY KEY, botToken TEXT, chatId TEXT, ativo INTEGER);
            INSERT INTO telegram_config VALUES (1,'tok','chat',1);`);
  eq(tg.canalTelegramLigado(sem), true, 'sem tabela config deve assumir ligado');
});

console.log('\n== a exceção declarada: testar credenciais ==');

await t('teste de token passa mesmo com o canal desligado', async () => {
  limpar();
  setCfg('alerta_canal_telegram', '0');
  eq(await tg.sendTelegram(db, 'teste', { ignorarCanal: true }), true, 'deveria enviar');
  eq(enviados.length, 1, 'mensagens enviadas');
});

await t('bot desativado continua bloqueando, mesmo ignorando o canal', async () => {
  limpar();
  db.prepare('UPDATE telegram_config SET ativo = 0 WHERE id = 1').run();
  eq(await tg.sendTelegram(db, 'teste', { ignorarCanal: true }), false, 'sem credencial não envia');
  db.prepare('UPDATE telegram_config SET ativo = 1 WHERE id = 1').run();
});

console.log('\n== fonte única: uma implementação só ==');

await t('não existe outra cópia de enviarAlerta no projeto', () => {
  const defs = [];
  for (const f of fs.readdirSync(RAIZ).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(RAIZ, f), 'utf8');
    // Só a definição de verdade conta; wrapper de uma linha (arrow que delega) não.
    if (/^\s*async function enviarAlerta\s*\(/m.test(src)) defs.push(f);
  }
  eq(defs.join(','), 'notificacoes-dispatcher.js', 'implementações de enviarAlerta');
});

await t('sniper e vigia leem a mesma config do dispatcher', () => {
  limpar();
  setCfg('alerta_canal_email', '1');
  setCfg('alerta_email_destinatarios', 'a@b.com');
  const c = disp.lerCanais(db);
  eq(c.email, true, 'email');
  eq(c.destinatarios.join(','), 'a@b.com', 'destinatários');
  eq(c.telegram, true, 'telegram default');
});

console.log('\n== rotas: o que a tela grava e lê ==');

await t('salvar destinatários filtra o que não é email e DIZ o que ignorou', async () => {
  limpar();
  const r = await chamar('post', '/api/alertas/config',
    { destinatarios: 'bom@empresa.com.br, lixo, outro@empresa.com' });
  eq(r.body.config.destinatarios.length, 2, 'aceitos');
  eq(r.body.ignorados.join(','), 'lixo', 'ignorados reportados');
});

await t('desligar telegram persiste como 0', async () => {
  limpar();
  await chamar('post', '/api/alertas/config', { telegram: false });
  eq(db.prepare("SELECT valor FROM config WHERE chave='alerta_canal_telegram'").get().valor, '0', 'gravado');
  eq(tg.canalTelegramLigado(db), false, 'transporte enxerga');
});

await t('teste sem nenhum canal ativo NÃO responde sucesso', async () => {
  limpar();
  setCfg('alerta_canal_telegram', '0');   // email já vem off
  const r = await chamar('post', '/api/alertas/teste');
  eq(r.body.success, false, 'não pode dizer que enviou');
  assert(/nenhum canal/i.test(r.body.error), 'motivo deveria explicar: ' + r.body.error);
  eq(enviados.length, 0, 'nada saiu');
});

await t('teste com telegram ligado envia e reporta o canal', async () => {
  limpar();
  const r = await chamar('post', '/api/alertas/teste');
  eq(r.body.success, true, 'sucesso');
  eq(r.body.canais, 1, 'canais');
  eq(enviados.length, 1, 'mensagens enviadas');
});

await t('email ligado sem destinatário não conta como canal', async () => {
  limpar();
  setCfg('alerta_canal_telegram', '0');
  setCfg('alerta_canal_email', '1');       // sem destinatários
  const r = await chamar('post', '/api/alertas/teste');
  eq(r.body.success, false, 'não deveria dizer que enviou');
});

console.log('\n== despacho ==');

await t('dispatcher informa quando não enviou nada', async () => {
  limpar();
  setCfg('alerta_canal_telegram', '0');
  const r = await disp.enviarAlerta(db, { subject: 's', body: 'b' });
  assert(r.skipped === true, 'deveria reportar skipped');
});

await t('dispatcher envia pelo telegram quando ligado', async () => {
  limpar();
  const r = await disp.enviarAlerta(db, { subject: 's', body: 'b' });
  eq(r.ok, true, 'ok');
  eq(enviados.length, 1, 'mensagens');
  assert(String(enviados[0].body.text).includes('b'), 'corpo enviado');
});

console.log(`\n${ok} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
})();
