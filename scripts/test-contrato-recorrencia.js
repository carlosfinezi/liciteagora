/**
 * Teste do vínculo contrato × recorrência NFSe já existente.
 * Chama os handlers reais com req/res falsos, contra SQLite temporário
 * com o schema de produção.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasContratos } = require('../contratos-routes');

const DB = '/tmp/vp-vincrec.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(fs.readFileSync('/tmp/vp-vincrec-schema.sql', 'utf8'));

const app = express();
registrarRotasContratos(app, db);
const achar = (path, metodo) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === path && x.route.methods[metodo]);
  if (!l) throw new Error(`rota nao registrada: ${metodo.toUpperCase()} ${path}`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const hDisp = achar('/api/contratos/:id/recorrencias-disponiveis', 'get');
const hVinc = achar('/api/contratos/:id/vincular-recorrencia', 'post');
const hDesv = achar('/api/contratos/:id/vincular-recorrencia', 'delete');
const hDetalhe = achar('/api/contratos/:id', 'get');
const hPut = achar('/api/contratos/:id', 'put');

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
const rec = (r, id) => r.out.recorrencias.find(x => x.id === id);

// ---------- seed ----------
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (1,'00000000000191','Cliente A','cliente',1)").run();
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (2,'00000000000272','Cliente B','cliente',1)").run();

const insRec = db.prepare(`INSERT INTO nfse_recorrencias
  (id, pessoaId, ativo, codigoTributacaoNacional, descricao, valorServico, diaVencimentoBoleto)
  VALUES (?, ?, ?, '010101', ?, ?, 10)`);
insRec.run(1, 1, 1, 'Suporte mensal A', 220);      // mesmo cliente, mesmo valor
insRec.run(2, 1, 1, 'Hospedagem A', 500);          // mesmo cliente, valor diferente
insRec.run(3, 2, 1, 'Servico do cliente B', 220);  // outro cliente
insRec.run(4, 1, 0, 'Inativa do A', 100);          // mesmo cliente, inativa
insRec.run(5, 1, 1, 'Ja usada por outro', 900);    // será ocupada

const insCt = db.prepare(`INSERT INTO contratos (id, numero, clienteId, descricao, valorMensal, dataInicio, status, recorrenciaNfseId)
  VALUES (?, ?, ?, ?, ?, '2026-01-01', 'ativo', ?)`);
insCt.run(1, 'CT-0001', 1, 'Contrato A', 220, null);
insCt.run(2, 'CT-0002', 1, 'Outro contrato', 900, 5);   // já segura a recorrência 5

// ---------- disponíveis ----------
t('lista classifica mesmo cliente, ocupada, inativa e divergência', () => {
  const r = chamar(hDisp, { params: { id: '1' } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  assert(r.out.recorrencias.length === 5, 'recorrências: ' + r.out.recorrencias.length);
  assert(rec(r, 1).mesmoCliente === true && rec(r, 1).vinculavel === true, 'rec 1 deveria ser vinculável');
  assert(rec(r, 1).valorDivergente === false, 'rec 1 tem o mesmo valor do contrato');
  assert(rec(r, 2).valorDivergente === true && rec(r, 2).diferencaValor === 280, 'divergência rec 2: ' + rec(r, 2).diferencaValor);
  assert(rec(r, 3).mesmoCliente === false, 'rec 3 é de outro cliente');
  assert(rec(r, 4).ativo === 0, 'rec 4 deveria estar inativa');
  assert(rec(r, 5).ocupada === true, 'rec 5 deveria estar ocupada');
  assert(rec(r, 5).contratoVinculadoNumero === 'CT-0002', 'contrato que ocupa: ' + rec(r, 5).contratoVinculadoNumero);
  assert(rec(r, 5).vinculavel === false, 'rec 5 não é vinculável');
});

t('ordenação põe mesmo cliente e livres na frente', () => {
  const r = chamar(hDisp, { params: { id: '1' } });
  assert(r.out.recorrencias[0].mesmoCliente === true, 'primeira deveria ser do mesmo cliente');
  assert(r.out.recorrencias[r.out.recorrencias.length - 1].mesmoCliente === false, 'outro cliente deveria ir pro fim');
});

t('contrato inexistente devolve 404', () => {
  const r = chamar(hDisp, { params: { id: '999' } });
  assert(r.st === 404, 'status: ' + r.st);
});

// ---------- vincular ----------
t('vincula recorrência do mesmo cliente', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: { recorrenciaNfseId: 1 } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  const c = db.prepare('SELECT recorrenciaNfseId FROM contratos WHERE id = 1').get();
  assert(c.recorrenciaNfseId === 1, 'não gravou: ' + c.recorrenciaNfseId);
  assert(r.out.avisoValor === null, 'não deveria avisar divergência: ' + r.out.avisoValor);
});

t('vínculo registra evento no histórico do contrato', () => {
  const ev = db.prepare("SELECT * FROM contratos_eventos WHERE contratoId = 1 ORDER BY id DESC LIMIT 1").get();
  assert(ev && /Recorrência #1 vinculada/.test(ev.descricao), 'evento: ' + (ev && ev.descricao));
});

t('recorrência já usada por outro contrato é recusada (409)', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: { recorrenciaNfseId: 5 } });
  assert(r.st === 409, 'status: ' + r.st);
  assert(/CT-0002/.test(r.out.error), 'erro deveria citar o contrato: ' + r.out.error);
  const c = db.prepare('SELECT recorrenciaNfseId FROM contratos WHERE id = 1').get();
  assert(c.recorrenciaNfseId === 1, 'vínculo anterior foi corrompido: ' + c.recorrenciaNfseId);
});

t('cliente diferente é bloqueado sem confirmação', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: { recorrenciaNfseId: 3 } });
  assert(r.st === 409, 'status: ' + r.st);
  assert(r.out.clienteDivergente === true, 'deveria sinalizar clienteDivergente');
  assert(/Cliente B/.test(r.out.error), 'erro deveria nomear o cliente: ' + r.out.error);
});

t('cliente diferente passa com confirmação explícita', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: { recorrenciaNfseId: 3, permitirClienteDiferente: true } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  const c = db.prepare('SELECT recorrenciaNfseId FROM contratos WHERE id = 1').get();
  assert(c.recorrenciaNfseId === 3, 'não gravou: ' + c.recorrenciaNfseId);
});

t('trocar de recorrência libera a anterior', () => {
  const r = chamar(hDisp, { params: { id: '2' } });
  assert(rec(r, 1).ocupada === false, 'rec 1 deveria ter sido liberada ao trocar');
});

t('divergência de valor avisa mas não bloqueia', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: { recorrenciaNfseId: 2 } });
  assert(r.out.success, 'deveria vincular: ' + r.out.error);
  assert(r.out.avisoValor && /500/.test(r.out.avisoValor), 'aviso de valor: ' + r.out.avisoValor);
});

t('recorrência inexistente devolve 404', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: { recorrenciaNfseId: 9999 } });
  assert(r.st === 404, 'status: ' + r.st);
});

t('recorrenciaNfseId ausente devolve 400', () => {
  const r = chamar(hVinc, { params: { id: '1' }, body: {} });
  assert(r.st === 400, 'status: ' + r.st);
});

// ---------- detalhe ----------
t('detalhe do contrato devolve a recorrência vinculada', () => {
  const r = chamar(hDetalhe, { params: { id: '1' } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  assert(r.out.recorrencia && r.out.recorrencia.id === 2, 'recorrência no detalhe: ' + JSON.stringify(r.out.recorrencia));
});

t('agregados do log usam status "sucesso" e competência', () => {
  db.prepare(`INSERT INTO nfse_recorrencias_log (recorrenciaId, competencia, status) VALUES (2,'2026-05','sucesso')`).run();
  db.prepare(`INSERT INTO nfse_recorrencias_log (recorrenciaId, competencia, status) VALUES (2,'2026-06','sucesso')`).run();
  db.prepare(`INSERT INTO nfse_recorrencias_log (recorrenciaId, competencia, status) VALUES (2,'2026-07','erro')`).run();
  const r = chamar(hDetalhe, { params: { id: '1' } });
  assert(r.out.recorrencia.ultimaEmissao === '2026-06', 'última emissão: ' + r.out.recorrencia.ultimaEmissao);
  assert(r.out.recorrencia.totalEmissoes === 2, 'total (erro não conta): ' + r.out.recorrencia.totalEmissoes);
});

t('sem a tabela de log a recorrência ainda aparece (sem agregados)', () => {
  const P2 = '/tmp/vp-vincrec2.db';
  try { fs.unlinkSync(P2); } catch {}
  const db2 = new Database(P2);
  db2.exec(fs.readFileSync('/tmp/vp-vincrec-schema.sql', 'utf8'));
  db2.exec('DROP TABLE nfse_recorrencias_log');
  db2.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (1,'00000000000191','C','cliente',1)").run();
  db2.prepare(`INSERT INTO nfse_recorrencias (id, pessoaId, ativo, codigoTributacaoNacional, descricao, valorServico)
    VALUES (7,1,1,'010101','Rec sem log',300)`).run();
  db2.prepare(`INSERT INTO contratos (id, numero, clienteId, descricao, valorMensal, dataInicio, status, recorrenciaNfseId)
    VALUES (9,'CT-0009',1,'C',300,'2026-01-01','ativo',7)`).run();
  const app2 = express();
  registrarRotasContratos(app2, db2);
  const h2 = ((app2.router || app2._router).stack || [])
    .find(x => x.route && x.route.path === '/api/contratos/:id' && x.route.methods.get)
    .route.stack.at(-1).handle;
  let out = null;
  h2({ params: { id: '9' }, body: {}, query: {}, session: {} },
     { json: o => { out = o; }, status: () => ({ json: o => { out = o; } }) });
  assert(out && out.success, 'falhou: ' + (out && out.error));
  assert(out.recorrencia && out.recorrencia.id === 7, 'recorrência sumiu sem a tabela de log');
  db2.close();
});

// ---------- desvincular ----------
t('desvincula sem desativar a recorrência', () => {
  const r = chamar(hDesv, { params: { id: '1' } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  const c = db.prepare('SELECT recorrenciaNfseId FROM contratos WHERE id = 1').get();
  assert(c.recorrenciaNfseId === null, 'vínculo não foi removido');
  // Cortar o faturamento do cliente seria efeito colateral de uma ação
  // que só falava de vínculo.
  const rr = db.prepare('SELECT ativo FROM nfse_recorrencias WHERE id = 2').get();
  assert(rr.ativo === 1, 'a recorrência foi desativada indevidamente');
});

t('desvincular registra evento', () => {
  const ev = db.prepare("SELECT * FROM contratos_eventos WHERE contratoId = 1 ORDER BY id DESC LIMIT 1").get();
  assert(/desvinculada/.test(ev.descricao), 'evento: ' + ev.descricao);
});

t('desvincular sem vínculo devolve 400', () => {
  const r = chamar(hDesv, { params: { id: '1' } });
  assert(r.st === 400, 'status: ' + r.st);
});

// ---------- proteção no PUT ----------
t('PUT genérico não altera mais recorrenciaNfseId', () => {
  chamar(hPut, { params: { id: '1' }, body: { recorrenciaNfseId: 5, descricao: 'Nova descrição' } });
  const c = db.prepare('SELECT recorrenciaNfseId, descricao FROM contratos WHERE id = 1').get();
  assert(c.recorrenciaNfseId === null, 'PUT furou a regra 1:1: ' + c.recorrenciaNfseId);
  assert(c.descricao === 'Nova descrição', 'PUT deveria seguir salvando os demais campos');
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
