/**
 * Teste do vínculo contrato × NFSe avulsa (nfse.contratoId).
 *
 * A recorrência só fatura mês a mês. Contrato anual — 5 dos 6 do 1bit — fatura
 * por nota avulsa, e contrato anual de vigência trienal rende TRÊS notas. Por
 * isso o vínculo aqui é 1:N, ao contrário do 1:1 da recorrência, e é isso que
 * os casos abaixo prendem.
 *
 * Chama os handlers reais com req/res falsos, contra SQLite temporário com o
 * schema de produção.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasContratos } = require('../contratos-routes');

const DB = '/tmp/vp-ct-nfse.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(require('./schema-de-tenant').lerSchema('/tmp/vp-ct-nfse-schema.sql'));

// O schema sai de um tenant vivo, e lá a coluna só nasce no restart que roda o
// db-schema.js. Aplicar aqui destravaria a suíte mesmo que alguém tivesse
// esquecido a migration — por isso o primeiro caso confere o db-schema.js
// diretamente, e é ele que reprova o esquecimento.
try { db.exec('ALTER TABLE nfse ADD COLUMN contratoId INTEGER'); } catch (_) {}

const app = express();
registrarRotasContratos(app, db);
const achar = (rota, metodo) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === rota && x.route.methods[metodo]);
  if (!l) throw new Error(`rota nao registrada: ${metodo.toUpperCase()} ${rota}`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const hDisp = achar('/api/contratos/:id/nfse-disponiveis', 'get');
const hVinc = achar('/api/contratos/:id/vincular-nfse', 'post');
const hDesv = achar('/api/contratos/:id/vincular-nfse/:nfseId', 'delete');
const hDetalhe = achar('/api/contratos/:id', 'get');

function chamar(handler, { params = {}, body = {}, query = {} } = {}) {
  let out = null, st = 200;
  const res = { json: o => { out = o; return res; }, status: c => { st = c; return res; } };
  handler({ params, body, query, session: {}, user: { username: 'teste' } }, res);
  if (!out) throw new Error('sem resposta');
  return { out, st };
}

let ok = 0, fail = 0;
function t(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }
const temNota = (r, id) => r.out.notas.some(n => n.id === id);

// ---------- seed ----------
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (1,'05940740000121','TRE-MG','cliente',1)").run();
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (2,'00304725000173','CREA-DF','cliente',1)").run();

const insCt = db.prepare(`INSERT INTO contratos (id, numero, clienteId, descricao, valorMensal, periodicidade, dataInicio, status)
  VALUES (?, ?, ?, ?, ?, 'anual', '2026-01-01', 'ativo')`);
insCt.run(1, 'CT-0003', 1, 'Certificados', 1600);
insCt.run(2, 'CT-0005', 2, 'Certificado SSL', 650);

const insNota = db.prepare(`INSERT INTO nfse
  (id, nNFSe, nDPS, serie, tomadorCpfCnpj, tomadorRazaoSocial, descricaoServico, valorServico, dataCompetencia, status, contratoId)
  VALUES (?, ?, ?, '1', ?, ?, ?, ?, ?, ?, ?)`);
insNota.run(10, '210', 210, '05940740000121', 'TRE-MG', 'Certificados 2026', 1600, '2026-01-15', 'autorizada', null);
insNota.run(11, '211', 211, '05940740000121', 'TRE-MG', 'Certificados 2027', 1600, '2027-01-15', 'autorizada', null);
insNota.run(12, '212', 212, '00304725000173', 'CREA-DF', 'SSL do CREA',       650,  '2026-02-10', 'autorizada', null);
insNota.run(13, '213', 213, '05940740000121', 'TRE-MG', 'Ja e de outro contrato', 900, '2026-03-01', 'autorizada', 2);
// CNPJ com máscara: a nota pode ter sido gravada formatada, e o filtro precisa
// enxergá-la mesmo assim.
insNota.run(14, '214', 214, '05.940.740/0001-21', 'TRE-MG', 'Com mascara', 300, '2026-04-01', 'cancelada', null);

// ---------- a migration ----------
t('db-schema.js declara a coluna contratoId em nfse', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db-schema.js'), 'utf8');
  assert(/ALTER TABLE nfse ADD COLUMN contratoId/.test(src),
    'sem o ALTER no db-schema.js o tenant existente nunca ganha a coluna');
});

// ---------- disponíveis ----------
t('lista só notas sem contrato do mesmo CNPJ', () => {
  const r = chamar(hDisp, { params: { id: '1' } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  assert(temNota(r, 10) && temNota(r, 11), 'notas livres do cliente deveriam aparecer');
  assert(!temNota(r, 12), 'nota de outro tomador nao pode aparecer');
  assert(!temNota(r, 13), 'nota ja vinculada a outro contrato nao pode aparecer');
});

t('CNPJ com máscara na nota ainda casa com o cliente', () => {
  const r = chamar(hDisp, { params: { id: '1' } });
  assert(temNota(r, 14), 'nota com CNPJ formatado ficou de fora do filtro');
});

t('contrato inexistente devolve 404', () => {
  const r = chamar(hDisp, { params: { id: '999' } });
  assert(r.st === 404, 'status: ' + r.st);
});

// ---------- vincular ----------
t('vincula nota do mesmo cliente', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: { nfseId: 10 } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  const n = db.prepare('SELECT contratoId FROM nfse WHERE id = 10').get();
  assert(n.contratoId === 1, 'nao gravou: ' + n.contratoId);
});

t('o mesmo contrato aceita uma SEGUNDA nota', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: { nfseId: 11 } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  const qtd = db.prepare('SELECT COUNT(*) AS n FROM nfse WHERE contratoId = 1').get().n;
  assert(qtd === 2, 'contrato trienal precisa de N notas, tem: ' + qtd);
});

t('nota vinculada sai da lista de disponíveis', () => {
  const r = chamar(hDisp, { params: { id: '1' } });
  assert(!temNota(r, 10) && !temNota(r, 11), 'nota ja vinculada continua sendo oferecida');
});

t('nota de outro tomador é recusada (409)', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: { nfseId: 12 } });
  assert(r.st === 409, 'status: ' + r.st);
  assert(/CREA-DF/.test(r.out.error), 'erro deveria nomear o tomador: ' + r.out.error);
  const n = db.prepare('SELECT contratoId FROM nfse WHERE id = 12').get();
  assert(n.contratoId === null, 'gravou mesmo recusando: ' + n.contratoId);
});

t('nota de outro contrato é recusada citando o número (409)', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: { nfseId: 13 } });
  assert(r.st === 409, 'status: ' + r.st);
  assert(/CT-0005/.test(r.out.error), 'erro deveria citar o contrato: ' + r.out.error);
  const n = db.prepare('SELECT contratoId FROM nfse WHERE id = 13').get();
  assert(n.contratoId === 2, 'vinculo do outro contrato foi corrompido: ' + n.contratoId);
});

t('nota inexistente devolve 404', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: { nfseId: 9999 } });
  assert(r.st === 404, 'status: ' + r.st);
});

t('nfseId ausente devolve 400', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: {} });
  assert(r.st === 400, 'status: ' + r.st);
});

// ---------- detalhe ----------
t('detalhe do contrato devolve as notas, da mais nova para a mais velha', () => {
  const r = chamar(hDetalhe, { params: { id: '1' } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  assert(Array.isArray(r.out.notasAvulsas), 'notasAvulsas deveria ser lista');
  assert(r.out.notasAvulsas.length === 2, 'notas no detalhe: ' + r.out.notasAvulsas.length);
  assert(r.out.notasAvulsas[0].id === 11, 'ordem: ' + r.out.notasAvulsas.map(n => n.id).join(','));
  assert(r.out.notasAvulsas[0].nNFSe === '211', 'numero da nota: ' + r.out.notasAvulsas[0].nNFSe);
});

t('detalhe não quebra em base sem a coluna contratoId', () => {
  const P2 = '/tmp/vp-ct-nfse2.db';
  try { fs.unlinkSync(P2); } catch {}
  const db2 = new Database(P2);
  db2.exec(require('./schema-de-tenant').lerSchema('/tmp/vp-ct-nfse-schema.sql'));
  // O schema vem do tenant, que ganha a coluna no primeiro restart. Derrubá-la
  // aqui deixa o caso valendo nos dois mundos: antes e depois desse restart.
  // O índice sai primeiro porque o SQLite recusa dropar coluna indexada.
  try {
    db2.exec('DROP INDEX IF EXISTS idx_nfse_contrato');
    db2.exec('ALTER TABLE nfse DROP COLUMN contratoId');
  } catch (_) { /* base que ainda não tem a coluna */ }
  const cols = db2.prepare('PRAGMA table_info(nfse)').all().map(c => c.name);
  assert(!cols.includes('contratoId'), 'o preparo do caso falhou: a coluna continua lá');
  db2.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (1,'05940740000121','C','cliente',1)").run();
  db2.prepare(`INSERT INTO contratos (id, numero, clienteId, descricao, valorMensal, dataInicio, status)
    VALUES (9,'CT-0009',1,'C',300,'2026-01-01','ativo')`).run();
  const app2 = express();
  registrarRotasContratos(app2, db2);
  const h2 = ((app2.router || app2._router).stack || [])
    .find(x => x.route && x.route.path === '/api/contratos/:id' && x.route.methods.get)
    .route.stack.at(-1).handle;
  let out = null;
  h2({ params: { id: '9' }, body: {}, query: {}, session: {} },
     { json: o => { out = o; }, status: () => ({ json: o => { out = o; } }) });
  assert(out && out.success, 'falhou: ' + (out && out.error));
  assert(out.notasAvulsas === null, 'sem a coluna, notasAvulsas deveria ser null: ' + JSON.stringify(out.notasAvulsas));
  db2.close();
});

// ---------- desvincular ----------
t('desvincula sem mexer na nota', () => {
  const r = chamar(hDesv, { params: { id: '1', nfseId: '10' } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  const n = db.prepare('SELECT contratoId, status, nNFSe FROM nfse WHERE id = 10').get();
  assert(n.contratoId === null, 'vinculo nao foi removido');
  // A nota segue emitida: soltar o vínculo não pode parecer cancelamento.
  assert(n.status === 'autorizada' && n.nNFSe === '210', 'a nota foi alterada indevidamente');
});

t('desvincular nota de outro contrato devolve 400', () => {
  const r = chamar(hDesv, { params: { id: '1', nfseId: '13' } });
  assert(r.st === 400, 'status: ' + r.st);
  const n = db.prepare('SELECT contratoId FROM nfse WHERE id = 13').get();
  assert(n.contratoId === 2, 'soltou o vinculo do outro contrato: ' + n.contratoId);
});

t('desvincular nota inexistente devolve 404', () => {
  const r = chamar(hDesv, { params: { id: '1', nfseId: '9999' } });
  assert(r.st === 404, 'status: ' + r.st);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
