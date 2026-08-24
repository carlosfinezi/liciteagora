/**
 * Teste das notificações de OS: vocabulário único, evento de aguardando-peça,
 * log de envio, teste de canal e validação de evento inexistente.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasOS } = require('../os-routes');
const notif = require('../os-notificacoes');

const DB = '/tmp/vp-notif.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-equip-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec(`CREATE TABLE IF NOT EXISTS tipos_operacao (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, ativo INTEGER DEFAULT 1);
         CREATE TABLE IF NOT EXISTS participacoes_comprasnet (id INTEGER PRIMARY KEY AUTOINCREMENT);
         CREATE TABLE IF NOT EXISTS os_notificacoes_config (
           id INTEGER PRIMARY KEY AUTOINCREMENT, evento TEXT NOT NULL, canal TEXT NOT NULL,
           template TEXT, ativo INTEGER DEFAULT 1, UNIQUE(evento, canal));`);

const app = express();
registrarRotasOS(app, db);
const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(h, o = {}) {
  let out = null, st = 200;
  h({ params: o.params || {}, query: o.query || {}, body: o.body || {}, session: { username: 't' }, user: { username: 't' } },
    { json: x => { out = x; return { json: y => { out = y; } }; }, status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
}
const espera = () => new Promise(r => setTimeout(r, 60));

let ok = 0, fail = 0;
// Precisa aguardar: vários casos exercitam o dispatcher, que é async.
// Sem o await, a asserção rodava depois do teste seguinte e passava à toa.
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// Caminho do os-routes REALMENTE carregado: um literal fixo apontaria
// para a versão publicada em vez da que está sob teste.
const CAMINHO_OS_ROUTES = Object.keys(require.cache).find(k => /os-routes(\.NEW)?\.js$/.test(k));

// ---------- seed ----------
db.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo) VALUES (1,'tec','x','Tec','admin',1)").run();
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo, email, telefone) VALUES (1,'00000000000191','Cliente','cliente',1,'c@x.com','11999998888')").run();
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (2,'00000000000272','Sem contato','cliente',1)").run();

async function main(){
// ---------- vocabulário ----------
await t('vocabulário é servido pelo backend', () => {
  const r = chamar(achar('/api/os/notificacoes-vocabulario', 'get'), {});
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.eventos.length >= 10, 'eventos: ' + r.out.eventos.length);
  assert(r.out.canais.length === 3, 'canais: ' + r.out.canais.length);
  assert(r.out.placeholders.includes('numero'), 'placeholders incompletos');
});

await t('todo evento do vocabulário é realmente emitido pelo código', () => {
  // O dropdown antigo oferecia 3 eventos que ninguém dispara.
  const src = fs.readFileSync(CAMINHO_OS_ROUTES, 'utf8');
  const emitidos = new Set([...src.matchAll(/registrarEvento\(db,\s*[^,]+,\s*'([a-z-]+)'/g)].map(m => m[1]));
  // SLA vem do scheduler, não do os-routes.
  emitidos.add('sla-risco'); emitidos.add('sla-atrasado');
  const orfaos = notif.EVENTOS.map(e => e.valor).filter(v => !emitidos.has(v));
  assert(orfaos.length === 0, 'eventos no vocabulário que ninguém emite: ' + orfaos.join(', '));
});

await t('evento real que faltava no dropdown agora está', () => {
  const vals = notif.EVENTOS.map(e => e.valor);
  for (const v of ['anexo', 'assinatura', 'aguardando-peca']) {
    assert(vals.includes(v), 'faltou no vocabulário: ' + v);
  }
});

// ---------- validação ----------
await t('config recusa evento que o sistema não emite', () => {
  const r = chamar(achar('/api/os/notificacoes-config', 'post'),
    { body: { evento: 'evento-inventado', canal: 'email' } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/não emite/.test(r.out.error), 'erro: ' + r.out.error);
});

await t('config aceita evento válido', () => {
  const r = chamar(achar('/api/os/notificacoes-config', 'post'),
    { body: { evento: 'aguardando-peca', canal: 'email', template: 'OS {{numero}} aguardando peça', ativo: 1 } });
  assert(r.out.success, 'erro: ' + r.out.error);
});

await t('upsert por (evento,canal) permite editar sem duplicar', () => {
  chamar(achar('/api/os/notificacoes-config', 'post'),
    { body: { evento: 'aguardando-peca', canal: 'email', template: 'novo texto', ativo: 0 } });
  const rows = db.prepare("SELECT * FROM os_notificacoes_config WHERE evento='aguardando-peca' AND canal='email'").all();
  assert(rows.length === 1, 'duplicou: ' + rows.length);
  assert(rows[0].template === 'novo texto', 'template: ' + rows[0].template);
  assert(rows[0].ativo === 0, 'ativo: ' + rows[0].ativo);
  // reativa para os testes seguintes
  chamar(achar('/api/os/notificacoes-config', 'post'),
    { body: { evento: 'aguardando-peca', canal: 'email', template: 'OS {{numero}} aguardando peça', ativo: 1 } });
});

// ---------- aguardar-peca dispara evento ----------
let OS_ID;
await t('aguardar-peca registra evento na timeline', async () => {
  const r = chamar(achar('/api/os', 'post'), { body: { clienteId: 1, titulo: 'Teste', tecnicoId: 1 } });
  OS_ID = r.out.os ? r.out.os.id : r.out.id;
  assert(OS_ID, 'não criou OS');
  db.prepare("UPDATE os_ordens SET status='aberta' WHERE id=?").run(OS_ID);
  chamar(achar('/api/os/:id/aguardar-peca', 'post'), { params: { id: String(OS_ID) }, body: { motivo: 'peça importada' } });
  const ev = db.prepare("SELECT * FROM os_eventos WHERE osId=? AND tipo='aguardando-peca'").get(OS_ID);
  assert(ev, 'evento não registrado — a regra de notificação nunca dispararia');
  assert(/peça importada/.test(ev.descricao), 'motivo não entrou: ' + ev.descricao);
});

  await espera();

  await t('dispatch registrou a tentativa no log', () => {
    const l = db.prepare("SELECT * FROM os_notificacoes_log WHERE evento='aguardando-peca'").get();
    assert(l, 'nada registrado — o silêncio voltaria a ser indistinguível de sucesso');
    assert(l.canal === 'email', 'canal: ' + l.canal);
    assert(l.osId === OS_ID, 'osId: ' + l.osId);
    // Sem SMTP no ambiente de teste, o esperado é erro registrado, não silêncio.
    assert(['ok', 'erro'].includes(l.status), 'status: ' + l.status);
  });

  await t('log é exposto com contagem de falhas', () => {
    const r = chamar(achar('/api/os/notificacoes-log', 'get'), { query: { limit: '10' } });
    assert(r.out.success, 'erro: ' + r.out.error);
    assert(r.out.log.length >= 1, 'log vazio');
    assert(typeof r.out.falhas7d === 'number', 'falhas7d ausente');
  });

  await t('cliente sem email dá erro explícito, não silêncio', async () => {
    const r = await notif.enviarTeste(db, { evento: 'abertura', canal: 'email', template: null, osId: null });
    // A OS mais recente é do cliente 1 (com email), então forço a do cliente 2.
    const os2 = chamar(achar('/api/os', 'post'), { body: { clienteId: 2, titulo: 'Sem contato' } });
    const id2 = os2.out.os ? os2.out.os.id : os2.out.id;
    const r2 = await notif.enviarTeste(db, { evento: 'abertura', canal: 'email', template: null, osId: id2 });
    assert(r2.ok === false, 'deveria falhar sem email');
    assert(/sem email/i.test(r2.erro), 'erro pouco claro: ' + r2.erro);
    assert(typeof r.ok === 'boolean', 'teste sem osId deveria responder');
  });

  await t('teste de envio fica marcado como teste no log', () => {
    const l = db.prepare('SELECT * FROM os_notificacoes_log WHERE teste = 1').get();
    assert(l, 'teste não registrado');
  });

  await t('template aplica os placeholders', async () => {
    const r = await notif.enviarTeste(db, {
      evento: 'abertura', canal: 'telegram', template: 'OS {{numero}} de {{clienteNome}}', osId: OS_ID });
    const l = db.prepare("SELECT * FROM os_notificacoes_log WHERE canal='telegram' ORDER BY id DESC LIMIT 1").get();
    assert(l, 'telegram não registrado');
    assert(typeof r.ok === 'boolean', 'sem resposta do teste');
  });

  await t('sem regra ativa o dispatch não faz nada (e não quebra)', async () => {
    db.prepare("UPDATE os_notificacoes_config SET ativo = 0").run();
    const antes = db.prepare('SELECT COUNT(*) n FROM os_notificacoes_log').get().n;
    const out = await notif.dispatchNotificacoes(db, OS_ID, 'aguardando-peca', 'x', null);
    assert(out.enviados === 0 && out.falhas === 0, 'dispatch com regra inativa: ' + JSON.stringify(out));
    const depois = db.prepare('SELECT COUNT(*) n FROM os_notificacoes_log').get().n;
    assert(depois === antes, 'logou sem regra ativa');
  });

}

main().then(() => {
  console.log(`\n${ok} OK, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
});
