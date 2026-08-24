/**
 * Recorrência de NFS-e: criar, editar e excluir pela própria tela.
 * O backend já tinha o CRUD; o que faltava era caminho para chegar nele.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasRecorrencia } = require('../recorrencia-routes');

const DB = '/tmp/vp-recorr.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-recorr-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}

const app = express();
registrarRotasRecorrencia(app, db);
const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                session: { username: 'tester' }, user: { username: 'tester' } },
    { json: x => { out = x; return { json: y => { out = y; } }; },
      status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const perto = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

const CLIENTE = db.prepare("INSERT INTO pessoas (cpfCnpj, razaoSocial, tipo, ativo) VALUES ('00000000000191','Cliente A','cliente',1)").run().lastInsertRowid;
const INATIVO = db.prepare("INSERT INTO pessoas (cpfCnpj, razaoSocial, tipo, ativo) VALUES ('00000000000272','Cliente Off','cliente',0)").run().lastInsertRowid;

const BASE = { pessoaId: null, descricao: 'Mensalidade de suporte', valorServico: 500,
               codigoTributacaoNacional: '010101' };

let REC;
t('criar recorrência pela tela funciona', () => {
  const r = chamar('/api/recorrencias', 'post', { body: { ...BASE, pessoaId: CLIENTE,
    codigoListaServico: '01.01', aliquota: 5, diaVencimentoBoleto: 15,
    gerarBoleto: true, enviarEmail: true } });
  assert(r.out.success, 'erro: ' + r.out.error);
  REC = r.out.id;
  const g = db.prepare('SELECT * FROM nfse_recorrencias WHERE id = ?').get(REC);
  assert(g.pessoaId === CLIENTE && perto(g.valorServico, 500), JSON.stringify(g));
  assert(g.gerarBoleto === 1 && g.enviarEmail === 1, 'flags: ' + JSON.stringify(g));
  assert(g.diaVencimentoBoleto === 15, 'dia: ' + g.diaVencimentoBoleto);
});

t('sem cliente é recusado com o motivo', () => {
  const r = chamar('/api/recorrencias', 'post', { body: { ...BASE } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/pessoaId/.test(r.out.error), 'erro: ' + r.out.error);
});

t('sem código de tributação é recusado', () => {
  const r = chamar('/api/recorrencias', 'post', {
    body: { ...BASE, pessoaId: CLIENTE, codigoTributacaoNacional: '' } });
  assert(r.st === 400, 'status: ' + r.st);
});

t('cliente inativo é recusado', () => {
  const r = chamar('/api/recorrencias', 'post', { body: { ...BASE, pessoaId: INATIVO } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/inativa|nao encontrada/i.test(r.out.error), 'erro: ' + r.out.error);
});

t('valor zero é recusado', () => {
  const r = chamar('/api/recorrencias', 'post', { body: { ...BASE, pessoaId: CLIENTE, valorServico: 0 } });
  assert(r.st === 400, 'status: ' + r.st);
});

// ---------- edição ----------
t('o detalhe devolve o que a tela precisa para editar', () => {
  const r = chamar('/api/recorrencias/:id', 'get', { params: { id: String(REC) } });
  assert(r.out.success, 'erro: ' + r.out.error);
  // A tela le d.recorrencia — se o nome mudar, o formulario abre vazio.
  assert(r.out.recorrencia && r.out.recorrencia.id === REC, 'chave "recorrencia" ausente');
  assert(r.out.recorrencia.descricao === 'Mensalidade de suporte', 'descricao');
  assert(Array.isArray(r.out.logs), 'logs deveria vir junto');
});

t('editar altera só o que foi enviado', () => {
  const r = chamar('/api/recorrencias/:id', 'put', { params: { id: String(REC) },
    body: { valorServico: 750, descricao: 'Mensalidade revisada' } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const g = db.prepare('SELECT * FROM nfse_recorrencias WHERE id = ?').get(REC);
  assert(perto(g.valorServico, 750), 'valor: ' + g.valorServico);
  assert(g.descricao === 'Mensalidade revisada', 'descricao: ' + g.descricao);
  // O que nao foi enviado tem de sobreviver.
  assert(g.codigoTributacaoNacional === '010101', 'perdeu o codigo de tributacao');
  assert(g.diaVencimentoBoleto === 15, 'perdeu o dia de vencimento');
});

t('desativar pela edição', () => {
  chamar('/api/recorrencias/:id', 'put', { params: { id: String(REC) }, body: { ativo: 0 } });
  assert(db.prepare('SELECT ativo FROM nfse_recorrencias WHERE id=?').get(REC).ativo === 0, 'nao desativou');
  chamar('/api/recorrencias/:id', 'put', { params: { id: String(REC) }, body: { ativo: 1 } });
  assert(db.prepare('SELECT ativo FROM nfse_recorrencias WHERE id=?').get(REC).ativo === 1, 'nao reativou');
});

t('editar recorrência inexistente devolve 404', () => {
  const r = chamar('/api/recorrencias/:id', 'put', { params: { id: '99999' }, body: { valorServico: 1 } });
  assert(r.st === 404, 'status: ' + r.st);
});

// ---------- listagem ----------
t('a recorrência criada aparece na lista com o nome do cliente', () => {
  const r = chamar('/api/recorrencias', 'get', {});
  assert(r.out.success, 'erro: ' + r.out.error);
  const achada = r.out.recorrencias.find(x => x.id === REC);
  assert(achada, 'nao apareceu na lista');
  // A tela mostra pessoaNome; sem o join a coluna sai vazia.
  assert(achada.pessoaNome === 'Cliente A', 'pessoaNome: ' + achada.pessoaNome);
});

// ---------- exclusão ----------
t('o DELETE desativa em vez de apagar, preservando o histórico', () => {
  const nova = chamar('/api/recorrencias', 'post', { body: { ...BASE, pessoaId: CLIENTE } }).out.id;
  const r = chamar('/api/recorrencias/:id', 'delete', { params: { id: String(nova) } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const g = db.prepare('SELECT ativo FROM nfse_recorrencias WHERE id=?').get(nova);
  // Apagar de vez levaria junto o vinculo com as NFS-e ja emitidas.
  assert(g, 'apagou o registro em vez de desativar');
  assert(g.ativo === 0, 'nao desativou: ativo=' + g.ativo);
});

t('recorrência desativada pode ser reativada', () => {
  const nova = chamar('/api/recorrencias', 'post', { body: { ...BASE, pessoaId: CLIENTE } }).out.id;
  chamar('/api/recorrencias/:id', 'delete', { params: { id: String(nova) } });
  chamar('/api/recorrencias/:id', 'put', { params: { id: String(nova) }, body: { ativo: 1 } });
  assert(db.prepare('SELECT ativo FROM nfse_recorrencias WHERE id=?').get(nova).ativo === 1, 'nao reativou');
});

t('excluir inexistente devolve 404', () => {
  const r = chamar('/api/recorrencias/:id', 'delete', { params: { id: '99999' } });
  assert(r.st === 404, 'status: ' + r.st);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
