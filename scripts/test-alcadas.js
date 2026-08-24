/**
 * Alçadas: quem precisa aprovar o quê, e o que a aprovação libera.
 *
 * Quatro defeitos motivaram esta suíte, todos reproduzidos antes de corrigir:
 *
 *  1. A regra aplicada era sempre a de MENOR limite. Com faixas de 1k e 50k,
 *     um pagamento de R$ 500.000 caía na alçada do financeiro.
 *  2. A aprovação não travava o valor: aprovava-se R$ 5.000 e, alterando o
 *     título, a mesma aprovação liberava R$ 500.000.
 *  3. Reprovar matava o documento — toda execução seguinte reencontrava a
 *     reprovação e devolvia "reprovado" para sempre.
 *  4. Aprovação não expirava: uma de 2024 liberava um pagamento hoje.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const alc = require('../governanca-alcadas');

const DB = '/tmp/vp-alc.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-alc-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  try { db.exec(`INSERT OR IGNORE INTO ${m[1]} (id) VALUES (1)`); } catch {}
}

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const perto = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;
const tem = (ps, cod) => ps.some((p) => p.codigo === cod);
const codigos = (ps) => ps.map((p) => p.codigo).join(', ') || '(nenhum)';

const app = express();
app.use(express.json());
require('../governanca-routes').registrarRotasGovernanca(app, db);

let SESSAO = null;
function call(m, p, body = {}, params = {}, query = {}) {
  let h = null;
  for (const c of app.router.stack) {
    if (c.route && c.route.path === p && c.route.methods[m]) h = c.route.stack[c.route.stack.length - 1].handle;
  }
  if (!h) throw new Error('rota não encontrada: ' + m + ' ' + p);
  let o = null;
  h({ body, params, query, session: SESSAO || {}, user: null },
    { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { o = { status: this.statusCode, body: j }; } },
    () => {});
  if (!o) throw new Error('handler não respondeu');
  return o;
}

let seqU = 0;
const novoUsuario = (username, role) => db.prepare(
  'INSERT INTO users (username, passwordHash, role, ativo) VALUES (?, ?, ?, 1)')
  .run(username, 'x' + (++seqU), role).lastInsertRowid;
const novaRegra = (o = {}) => db.prepare(`INSERT INTO regras_alcada
  (tipoEvento, limiteValor, papelAprovador, ativo, validadeDias)
  VALUES (@tipoEvento, @limiteValor, @papelAprovador, @ativo, @validadeDias)`)
  .run({ tipoEvento: 'pagamento_cp', limiteValor: 1000, papelAprovador: 'financeiro',
         ativo: 1, validadeDias: 7, ...o }).lastInsertRowid;

function limpar() {
  db.exec('DELETE FROM aprovacoes; DELETE FROM regras_alcada; DELETE FROM users;');
  seqU = 0; SESSAO = null;
}
const verificar = (o) => alc.verificarAlcada(db, { tipoEvento: 'pagamento_cp', ...o });
const aprovacaoDe = (id) => db.prepare('SELECT * FROM aprovacoes WHERE id = ?').get(id);

// ==================== FAIXAS ====================
console.log('\n--- qual faixa vale ---');

function cenarioFaixas() {
  limpar();
  novoUsuario('fin', 'financeiro');
  novoUsuario('chefe', 'admin');
  novaRegra({ limiteValor: 1000, papelAprovador: 'financeiro' });
  novaRegra({ limiteValor: 50000, papelAprovador: 'admin' });
}

t('abaixo de todas as faixas passa sem aprovação', () => {
  cenarioFaixas();
  assert(verificar({ referenciaId: 1, valor: 500 }).liberado, 'bloqueou valor baixo');
});

t('valor entre as faixas cai na de baixo', () => {
  const r = verificar({ referenciaId: 2, valor: 5000 });
  assert(!r.liberado && perto(r.regra.limiteValor, 1000), JSON.stringify(r.regra));
  assert(r.regra.papelAprovador === 'financeiro', r.regra.papelAprovador);
});

t('valor alto cai na faixa de cima — era aqui que R$ 500.000 ia para o financeiro', () => {
  const r = verificar({ referenciaId: 3, valor: 500000 });
  assert(!r.liberado && perto(r.regra.limiteValor, 50000), JSON.stringify(r.regra));
  assert(r.regra.papelAprovador === 'admin', r.regra.papelAprovador);
});

t('valor exatamente no limite não exige aprovação', () => {
  // "acima de 1000" é acima; 1000 redondo passa.
  assert(verificar({ referenciaId: 4, valor: 1000 }).liberado, 'bloqueou o valor exato do limite');
});

t('um centavo acima do limite já exige', () => {
  assert(!verificar({ referenciaId: 5, valor: 1000.01 }).liberado, 'deixou passar');
});

t('regra inativa não entra na conta', () => {
  limpar();
  novaRegra({ limiteValor: 1000, ativo: 0 });
  assert(verificar({ referenciaId: 6, valor: 99999 }).liberado, 'usou regra inativa');
});

t('evento sem regra nenhuma passa direto', () => {
  limpar();
  novaRegra({ tipoEvento: 'pedido_compra', limiteValor: 100 });
  assert(verificar({ referenciaId: 7, valor: 99999 }).liberado, 'regra de outro evento bloqueou');
});

t('o papel exigido fica gravado na aprovação', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 8, valor: 500000, usuario: 'joao' });
  const a = aprovacaoDe(r.aprovacaoId);
  assert(a.papelExigido === 'admin' && a.regraId === r.regra.id, JSON.stringify(a));
});

// ==================== VALOR TRAVADO ====================
console.log('\n--- a aprovação vale para qual valor ---');

function aprovar(aprovacaoId) {
  db.prepare("UPDATE aprovacoes SET status='aprovada', aprovador='chefe' WHERE id = ?").run(aprovacaoId);
}

t('aprovação libera o valor aprovado', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 10, valor: 5000, usuario: 'joao' });
  aprovar(r.aprovacaoId);
  assert(verificar({ referenciaId: 10, valor: 5000 }).liberado, 'não liberou o valor aprovado');
});

t('aprovação de R$ 5.000 NÃO libera R$ 500.000', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 11, valor: 5000, usuario: 'joao' });
  aprovar(r.aprovacaoId);
  const exec = verificar({ referenciaId: 11, valor: 500000 });
  // Era a falha mais cara: alterava-se o título depois de aprovado.
  assert(!exec.liberado && exec.status === 'valor_excedido', JSON.stringify(exec));
  assert(perto(exec.valorAprovado, 5000) && perto(exec.valorSolicitado, 500000), JSON.stringify(exec));
});

t('pagar MENOS que o aprovado é permitido', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 12, valor: 9000, usuario: 'joao' });
  aprovar(r.aprovacaoId);
  assert(verificar({ referenciaId: 12, valor: 4000 }).liberado, 'bloqueou valor menor');
});

t('a aprovação é consumida: serve para uma execução só', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 13, valor: 5000, usuario: 'joao' });
  aprovar(r.aprovacaoId);
  assert(verificar({ referenciaId: 13, valor: 5000 }).liberado, 'primeira execução');
  const segunda = verificar({ referenciaId: 13, valor: 5000 });
  assert(!segunda.liberado && segunda.status === 'pendente', JSON.stringify(segunda));
  assert(segunda.aprovacaoId !== r.aprovacaoId, 'reusou a mesma aprovação');
});

t('valor alterado enquanto pendente atualiza o que o aprovador vê', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 14, valor: 5000, usuario: 'joao' });
  verificar({ referenciaId: 14, valor: 8000 });
  // Aprovar às cegas um número desatualizado é o mesmo que não aprovar.
  assert(perto(aprovacaoDe(r.aprovacaoId).valorReferencia, 8000),
    'valor na fila: ' + aprovacaoDe(r.aprovacaoId).valorReferencia);
});

// ==================== EXPIRAÇÃO ====================
console.log('\n--- prazo da aprovação ---');

t('aprovação dentro do prazo libera', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 20, valor: 5000, usuario: 'joao', agora: '2026-08-01 10:00:00' });
  aprovar(r.aprovacaoId);
  assert(verificar({ referenciaId: 20, valor: 5000, agora: '2026-08-05 10:00:00' }).liberado, 'bloqueou no prazo');
});

t('aprovação vencida não libera', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 21, valor: 5000, usuario: 'joao', agora: '2026-08-01 10:00:00' });
  aprovar(r.aprovacaoId);
  const exec = verificar({ referenciaId: 21, valor: 5000, agora: '2026-09-01 10:00:00' });
  assert(!exec.liberado && exec.status === 'expirada', JSON.stringify(exec));
});

t('a validade da regra define o prazo', () => {
  limpar();
  novaRegra({ limiteValor: 1000, validadeDias: 1 });
  const r = verificar({ referenciaId: 22, valor: 5000, usuario: 'joao', agora: '2026-08-01 10:00:00' });
  const a = aprovacaoDe(r.aprovacaoId);
  assert(a.expiraEm.startsWith('2026-08-02'), 'expiraEm: ' + a.expiraEm);
});

// ==================== REPROVAÇÃO ====================
console.log('\n--- reprovar não pode matar o documento ---');

function reprovar(id, motivo) {
  db.prepare("UPDATE aprovacoes SET status='reprovada', motivo=? WHERE id = ?").run(motivo, id);
}

t('reprovar barra a reexecução do mesmo valor', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 31, valor: 9000, usuario: 'joao' });
  reprovar(r.aprovacaoId, 'fornecedor errado');
  const exec = verificar({ referenciaId: 31, valor: 9000 });
  // Senão bastaria reenviar em loop até passar.
  assert(!exec.liberado && exec.status === 'reprovada', JSON.stringify(exec));
  assert(/fornecedor errado/.test(exec.motivo || ''), 'não devolveu o motivo');
});

t('valor corrigido gera NOVA solicitação em vez de ficar morto', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 32, valor: 9000, usuario: 'joao' });
  reprovar(r.aprovacaoId, 'valor errado');
  const nova = verificar({ referenciaId: 32, valor: 2000, usuario: 'joao' });
  // Antes o documento ficava reprovado para sempre.
  assert(!nova.liberado && nova.status === 'pendente', JSON.stringify(nova));
  assert(nova.aprovacaoId !== r.aprovacaoId, 'reusou a reprovada');
  assert(db.prepare('SELECT COUNT(*) n FROM aprovacoes WHERE referenciaId = 32').get().n === 2, 'não criou a segunda');
});

t('corrigir para abaixo do limite dispensa aprovação', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 33, valor: 9000, usuario: 'joao' });
  reprovar(r.aprovacaoId, 'muito caro');
  assert(verificar({ referenciaId: 33, valor: 800 }).liberado, 'bloqueou valor abaixo da faixa');
});

// ==================== QUEM DECIDE ====================
console.log('\n--- quem pode decidir ---');

t('o papel gravado na aprovação manda, não uma regra qualquer', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 40, valor: 500000, usuario: 'joao' });   // faixa admin
  const a = aprovacaoDe(r.aprovacaoId);
  // Antes o papel vinha de `LIMIT 1` sem ordem: podia trazer 'financeiro'.
  assert(alc.podeDecidir(db, a, { username: 'fin', role: 'financeiro' }).pode === false, 'financeiro decidiu faixa de admin');
  assert(alc.podeDecidir(db, a, { username: 'chefe', role: 'admin' }).pode === true, 'admin não pôde decidir');
});

t('admin decide qualquer faixa', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 41, valor: 5000, usuario: 'joao' });     // faixa financeiro
  assert(alc.podeDecidir(db, aprovacaoDe(r.aprovacaoId), { username: 'chefe', role: 'admin' }).pode, 'admin barrado');
});

t('sem usuário não decide', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 42, valor: 5000, usuario: 'joao' });
  assert(alc.podeDecidir(db, aprovacaoDe(r.aprovacaoId), null).pode === false, 'decidiu sem sessão');
});

t('solicitante não aprova a própria solicitação', () => {
  cenarioFaixas();
  const idFin = db.prepare("SELECT id FROM users WHERE username='fin'").get().id;
  const r = verificar({ referenciaId: 43, valor: 5000, usuario: 'fin' });
  SESSAO = { userId: idFin };
  const resp = call('post', '/api/alcadas/aprovacoes/:id/aprovar', {}, { id: String(r.aprovacaoId) });
  assert(resp.status === 403 && /própria/.test(resp.body.error), JSON.stringify(resp.body));
});

t('solicitante PODE reprovar a própria (desistir)', () => {
  cenarioFaixas();
  const idFin = db.prepare("SELECT id FROM users WHERE username='fin'").get().id;
  const r = verificar({ referenciaId: 44, valor: 5000, usuario: 'fin' });
  SESSAO = { userId: idFin };
  const resp = call('post', '/api/alcadas/aprovacoes/:id/reprovar', { motivo: 'desisti da compra' }, { id: String(r.aprovacaoId) });
  assert(resp.body.success, JSON.stringify(resp.body));
});

t('reprovar sem motivo é recusado', () => {
  cenarioFaixas();
  const idChefe = db.prepare("SELECT id FROM users WHERE username='chefe'").get().id;
  const r = verificar({ referenciaId: 45, valor: 5000, usuario: 'joao' });
  SESSAO = { userId: idChefe };
  const resp = call('post', '/api/alcadas/aprovacoes/:id/reprovar', {}, { id: String(r.aprovacaoId) });
  assert(resp.status === 400 && /Motivo/i.test(resp.body.error), JSON.stringify(resp.body));
});

// ==================== VALIDAÇÃO DE REGRA ====================
console.log('\n--- regras que não deveriam ser gravadas ---');

const ROLES = ['admin', 'financeiro', 'comercial', 'operacional', 'licitacoes'];

t('papel inexistente é recusado — seria trava eterna', () => {
  limpar(); novoUsuario('chefe', 'admin');
  const p = alc.validarRegra(db, { tipoEvento: 'pagamento_cp', limiteValor: 1000, papelAprovador: 'diretor' }, { roles: ROLES });
  assert(tem(p, 'papel_invalido'), codigos(p));
});

t('papel sem nenhum usuário ativo é recusado', () => {
  limpar(); novoUsuario('op', 'operacional');
  // Não há admin nem financeiro: nada acima do limite seria aprovável.
  const p = alc.validarRegra(db, { tipoEvento: 'pagamento_cp', limiteValor: 1000, papelAprovador: 'financeiro' }, { roles: ROLES });
  assert(tem(p, 'sem_aprovador'), codigos(p));
});

t('duas faixas no mesmo limite é recusado', () => {
  limpar(); novoUsuario('chefe', 'admin');
  novaRegra({ limiteValor: 1000, papelAprovador: 'admin' });
  const p = alc.validarRegra(db, { tipoEvento: 'pagamento_cp', limiteValor: 1000, papelAprovador: 'admin' }, { roles: ROLES });
  assert(tem(p, 'faixa_duplicada'), codigos(p));
});

t('limite negativo é recusado', () => {
  assert(tem(alc.validarRegra(db, { tipoEvento: 'pagamento_cp', limiteValor: -1 }, { roles: ROLES }), 'limite_invalido'));
});

t('validade fora de 1 a 365 dias é recusada', () => {
  limpar(); novoUsuario('chefe', 'admin');
  assert(tem(alc.validarRegra(db, { tipoEvento: 'pagamento_cp', limiteValor: 1000, papelAprovador: 'admin', validadeDias: 0 }, { roles: ROLES }), 'validade_invalida'));
  assert(tem(alc.validarRegra(db, { tipoEvento: 'pagamento_cp', limiteValor: 1000, papelAprovador: 'admin', validadeDias: 999 }, { roles: ROLES }), 'validade_invalida'));
});

t('a rota recusa a regra inválida', () => {
  limpar(); novoUsuario('chefe', 'admin');
  const r = call('post', '/api/alcadas/regras', { tipoEvento: 'pagamento_cp', limiteValor: 1000, papelAprovador: 'diretor' });
  assert(r.status === 400, 'status: ' + r.status);
  assert(db.prepare('SELECT COUNT(*) n FROM regras_alcada').get().n === 0, 'gravou mesmo assim');
});

// ==================== DIAGNÓSTICO E SIMULAÇÃO ====================
console.log('\n--- diagnóstico ---');

t('aponta faixa cujo papel não tem ninguém', () => {
  limpar(); novoUsuario('op', 'operacional');
  novaRegra({ limiteValor: 1000, papelAprovador: 'financeiro' });
  const d = alc.diagnostico(db);
  assert(d.problemas.some((p) => p.codigo === 'faixa_sem_aprovador'), JSON.stringify(d.problemas));
});

t('avisa quando só uma pessoa pode aprovar a faixa', () => {
  limpar(); novoUsuario('chefe', 'admin');
  novaRegra({ limiteValor: 1000, papelAprovador: 'admin' });
  const d = alc.diagnostico(db);
  // Se for ela quem solicitar, ninguém decide.
  assert(d.problemas.some((p) => p.codigo === 'aprovador_unico'), JSON.stringify(d.problemas));
});

t('lista aprovação parada há dias', () => {
  cenarioFaixas();
  verificar({ referenciaId: 50, valor: 5000, usuario: 'joao', agora: '2026-07-20 10:00:00' });
  const d = alc.diagnostico(db, { agora: '2026-08-01 10:00:00', diasParado: 3 });
  assert(d.paradas.length === 1 && d.paradas[0].dias === 12, JSON.stringify(d.paradas));
});

t('lista aprovação vencida sem uso', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 51, valor: 5000, usuario: 'joao', agora: '2026-07-01 10:00:00' });
  aprovar(r.aprovacaoId);
  const d = alc.diagnostico(db, { agora: '2026-08-01 10:00:00' });
  assert(d.expiradas.length === 1 && d.expiradas[0].id === r.aprovacaoId, JSON.stringify(d.expiradas));
});

t('lista reprovação que está travando documento', () => {
  cenarioFaixas();
  const r = verificar({ referenciaId: 52, valor: 5000, usuario: 'joao' });
  reprovar(r.aprovacaoId, 'sem orçamento');
  const d = alc.diagnostico(db);
  assert(d.reprovadasAbertas.length === 1 && /sem orçamento/.test(d.reprovadasAbertas[0].motivo), JSON.stringify(d.reprovadasAbertas));
});

t('as faixas aparecem ordenadas por evento', () => {
  cenarioFaixas();
  const d = alc.diagnostico(db);
  const pg = d.faixasPorEvento.find((x) => x.tipoEvento === 'pagamento_cp');
  assert(pg.faixas.length === 2 && pg.faixas[0].acimaDe === 1000 && pg.faixas[1].acimaDe === 50000,
    JSON.stringify(pg.faixas));
});

console.log('\n--- simulação ---');

t('simula valor abaixo de tudo', () => {
  cenarioFaixas();
  const s = alc.simular(db, 'pagamento_cp', 500);
  assert(s.exigeAprovacao === false, JSON.stringify(s));
});

t('simula e diz quem aprovaria', () => {
  cenarioFaixas();
  const s = alc.simular(db, 'pagamento_cp', 500000);
  assert(s.exigeAprovacao && s.papel === 'admin', JSON.stringify(s));
  assert(s.podemAprovar.includes('chefe'), JSON.stringify(s.podemAprovar));
});

t('simula faixa sem ninguém e diz isso', () => {
  limpar(); novoUsuario('op', 'operacional');
  novaRegra({ limiteValor: 1000, papelAprovador: 'financeiro' });
  const s = alc.simular(db, 'pagamento_cp', 5000);
  assert(s.podemAprovar.length === 0 && /não há ninguém/.test(s.explicacao), JSON.stringify(s));
});

t('a rota de simular recusa evento inválido', () => {
  const r = call('get', '/api/alcadas/simular', {}, {}, { tipoEvento: 'inventado', valor: 100 });
  assert(r.status === 400, 'status: ' + r.status);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
