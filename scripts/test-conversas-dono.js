/**
 * Dono da conversa — quem assumiu o quê, com 953 conversas abertas na fila.
 *
 * ── O que esta suíte protege ───────────────────────────────────────────────
 *
 * A coluna `donoId` existia em `conv_conversas` desde o começo e nunca foi
 * usada por tela nenhuma. Passar a usá-la cria três jeitos novos de errar, e
 * cada um deles tem um teste aqui:
 *
 *  1. **"Minhas" mostrar o que não é meu.** É o defeito caro: o atendente
 *     responde conversa que outro já assumiu, e o cliente recebe duas versões
 *     da mesma resposta. O teste atribui a um usuário e confere que o recorte
 *     do OUTRO não a traz.
 *
 *  2. **"Minhas" sem usuário identificado.** Se a sessão não trouxer id, cair
 *     para "todas" seria pior que falhar: a fila inteira apareceria com o
 *     rótulo de fila pessoal. O recorte devolve vazio, e o teste garante isso.
 *
 *  3. **Atribuir a quem não existe ou está inativo.** A conversa sairia de "sem
 *     dono" sem entrar no "minhas" de ninguém: some calada. A rota recusa, e o
 *     teste confere que o dono anterior fica intacto depois da recusa.
 *
 * Se o defeito existisse, cada um desses testes reprovaria — é essa a pergunta
 * que separa teste de carimbo.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

const DB = '/tmp/vp-conv-dono.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = require('./schema-de-tenant').lerSchema('/tmp/vp-conv-dono-schema.sql');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  try { db.exec(`INSERT OR IGNORE INTO ${m[1]} (id) VALUES (1)`); } catch {}
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

const app = express();
app.use(express.json());
require('../conversas-routes').registrarRotasConversas(app, db);

/** Chama o handler direto, com o `req.user` que a sessão traria. */
function call(metodo, caminho, { body = {}, params = {}, query = {}, user = null } = {}) {
  let h = null;
  for (const c of app.router.stack) {
    if (c.route && c.route.path === caminho && c.route.methods[metodo]) {
      h = c.route.stack[c.route.stack.length - 1].handle;
    }
  }
  if (!h) throw new Error('rota não registrada: ' + metodo.toUpperCase() + ' ' + caminho);
  let resposta = null, status = 200;
  const res = {
    json(o) { resposta = o; return this; },
    status(s) { status = s; return this; },
  };
  h({ body, params, query, user, ip: '127.0.0.1', headers: {} }, res);
  return { status, json: resposta };
}

// ---------- gente e conversas ----------
db.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo)
  VALUES (10, 'ana', 'x', 'Ana', 'comercial', 1)`).run();
db.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo)
  VALUES (11, 'bruno', 'x', 'Bruno', 'comercial', 1)`).run();
db.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo)
  VALUES (12, 'ex', 'x', 'Ex-funcionário', 'comercial', 0)`).run();

const nova = (jid, nome) => db.prepare(`INSERT INTO conv_conversas (canal, jid, telefone, nome, estado, ultimaEm)
  VALUES ('whatsapp', ?, ?, ?, 'aberta', CURRENT_TIMESTAMP)`).run(jid, jid.slice(0, 11), nome).lastInsertRowid;

const c1 = nova('5511900000001@s.whatsapp.net', 'Cliente Um');
const c2 = nova('5511900000002@s.whatsapp.net', 'Cliente Dois');
const c3 = nova('5511900000003@s.whatsapp.net', 'Cliente Três');

const ANA = { id: 10, username: 'ana', role: 'comercial' };
const BRUNO = { id: 11, username: 'bruno', role: 'comercial' };

// ==================== A. a lista de atendentes ====================

t('A1. lista so quem esta ativo', () => {
  const r = call('get', '/api/conversas/atendentes', { user: ANA });
  const nomes = r.json.atendentes.map(a => a.nome);
  assert(nomes.includes('Ana') && nomes.includes('Bruno'), 'faltou atendente ativo: ' + nomes.join(', '));
  assert(!nomes.includes('Ex-funcionário'),
    'inativo apareceu na lista — atribuir a ele criaria fila que ninguém vê');
});

t('A2. nao devolve credencial nem papel', () => {
  const r = call('get', '/api/conversas/atendentes', { user: ANA });
  const campos = Object.keys(r.json.atendentes[0]);
  assert(campos.length === 2 && campos.includes('id') && campos.includes('nome'),
    'a rota devolveu além de id e nome: ' + campos.join(', '));
});

t('A3. diz quem esta perguntando, para a tela oferecer "assumir"', () => {
  assert(call('get', '/api/conversas/atendentes', { user: BRUNO }).json.eu === 11, 'o `eu` não voltou');
});

// ==================== B. atribuir ====================

t('B1. atribuir grava e a listagem devolve o nome do dono', () => {
  const r = call('put', '/api/conversas/:id', { params: { id: c1 }, body: { donoId: 10 }, user: ANA });
  assert(r.json.success, 'a atribuição falhou: ' + (r.json.error || ''));
  const lista = call('get', '/api/conversas', { user: ANA }).json.conversas;
  const achada = lista.find(x => x.id === c1);
  assert(achada.donoId === 10, `donoId veio ${achada.donoId}`);
  assert(achada.donoNome === 'Ana', `donoNome veio "${achada.donoNome}" — a tela mostraria o id cru`);
});

t('B2. atribuir a atendente inativo e recusado, e o dono anterior fica intacto', () => {
  const r = call('put', '/api/conversas/:id', { params: { id: c1 }, body: { donoId: 12 }, user: ANA });
  assert(r.status === 400, `deveria recusar o inativo (veio ${r.status})`);
  const c = db.prepare('SELECT donoId FROM conv_conversas WHERE id = ?').get(c1);
  assert(c.donoId === 10, `a recusa mexeu no dono: ficou ${c.donoId} em vez de 10`);
});

t('B3. atribuir a usuario inexistente e recusado', () => {
  const r = call('put', '/api/conversas/:id', { params: { id: c2 }, body: { donoId: 99999 }, user: ANA });
  assert(r.status === 400, `deveria recusar id inexistente (veio ${r.status})`);
  const c = db.prepare('SELECT donoId FROM conv_conversas WHERE id = ?').get(c2);
  assert(c.donoId == null, 'a conversa ganhou um dono que não existe');
});

t('B4. liberar a conversa devolve ela para a fila sem dono', () => {
  call('put', '/api/conversas/:id', { params: { id: c3 }, body: { donoId: 11 }, user: BRUNO });
  call('put', '/api/conversas/:id', { params: { id: c3 }, body: { donoId: null }, user: BRUNO });
  const c = db.prepare('SELECT donoId FROM conv_conversas WHERE id = ?').get(c3);
  assert(c.donoId == null, `a conversa continuou com dono ${c.donoId}`);
});

t('B5. a troca de dono fica na auditoria', () => {
  const evs = db.prepare(`SELECT detalhe FROM conv_eventos WHERE conversaId = ? AND tipo = 'dono'
    ORDER BY id`).all(c3).map(e => e.detalhe);
  assert(evs.length >= 2 && evs.includes('11') && evs.includes('ninguém'),
    'a passagem de mão não ficou registrada: ' + JSON.stringify(evs));
});

// ==================== C. o recorte ====================

t('C1. "minhas" da Ana traz so o que e da Ana', () => {
  const r = call('get', '/api/conversas', { query: { recorte: 'minhas' }, user: ANA });
  const ids = r.json.conversas.map(c => c.id);
  assert(ids.includes(c1), 'a conversa da Ana não apareceu no "minhas" dela');
  assert(ids.length === 1, 'veio conversa que não é dela: ' + ids.join(', '));
});

t('C2. "minhas" do Bruno NAO traz a conversa da Ana', () => {
  const ids = call('get', '/api/conversas', { query: { recorte: 'minhas' }, user: BRUNO })
    .json.conversas.map(c => c.id);
  assert(!ids.includes(c1),
    'o "minhas" do Bruno trouxe conversa da Ana — é assim que dois atendentes respondem o mesmo cliente');
});

t('C3. sem usuario identificado, "minhas" devolve VAZIO e nao a fila inteira', () => {
  const r = call('get', '/api/conversas', { query: { recorte: 'minhas' }, user: null });
  assert(r.json.conversas.length === 0,
    `veio ${r.json.conversas.length} conversa(s) rotuladas como "minhas" sem ninguém logado`);
});

t('C4. "sem dono" traz exatamente as que ninguem assumiu', () => {
  const ids = call('get', '/api/conversas', { query: { recorte: 'semDono' }, user: ANA })
    .json.conversas.map(c => c.id).sort();
  assert(JSON.stringify(ids) === JSON.stringify([c2, c3].sort()),
    'a fila sem dono veio errada: ' + ids.join(', '));
});

t('C5. as contagens dos filtros batem com o que eles devolvem', () => {
  const c = call('get', '/api/conversas', { user: ANA }).json.contagem;
  assert(c.minhas === 1, `contagem de "minhas" da Ana veio ${c.minhas}`);
  assert(c.semDono === 2, `contagem de "sem dono" veio ${c.semDono}`);
  const doBruno = call('get', '/api/conversas', { user: BRUNO }).json.contagem;
  assert(doBruno.minhas === 0,
    `a contagem de "minhas" do Bruno veio ${doBruno.minhas} — contagem não pode ser global`);
});

t('C6. dono nao vira permissao: a lista geral continua trazendo tudo', () => {
  // Dono organiza fila. Se um dia isto reprovar, alguém transformou atribuição
  // em restrição de acesso, e o plantão passa a não enxergar a fila do colega.
  const ids = call('get', '/api/conversas', { user: BRUNO }).json.conversas.map(c => c.id);
  assert(ids.length === 3, `a lista geral do Bruno veio com ${ids.length} de 3 conversas`);
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
