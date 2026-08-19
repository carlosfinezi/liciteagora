/**
 * Rotas novas de configuração de emissão por estabelecimento (Fiscal >
 * Configuração de Emissão): GET/PUT /api/estabelecimentos/:id/emissao e
 * PUT /api/nfse/serie-dps. Banco descartável em /tmp.
 *
 * Depende do mesmo dump de schema que test-serie-dps.js:
 *   sqlite3 "file:data/tenants/<tenant>/pncp.db?mode=ro" .schema \
 *     | grep -v sqlite_sequence > /tmp/vp-serie-schema.sql
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

const estabRoutes = require('../estabelecimentos-routes');
const nfseRoutes = require('../nfse-routes');

const DB = '/tmp/vp-emissao.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-serie-schema.sql', 'utf8');
db.exec(schema);

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

db.exec('DELETE FROM fornecedor; DELETE FROM estabelecimentos; DELETE FROM estabelecimento_serie;');
db.prepare('INSERT INTO fornecedor (id, razaoSocial, cnpj) VALUES (1, ?, ?)').run('Matriz LTDA', '12345678000199');
db.prepare("INSERT INTO estabelecimentos (id, matriz, tipo_vinculo, ativo, bloqueado, razaoSocial, cnpj) VALUES (1, 1, 'MATRIZ', 1, 0, 'Matriz LTDA', '12345678000199')").run();
db.prepare("INSERT INTO estabelecimentos (id, matriz, tipo_vinculo, ativo, bloqueado, razaoSocial, cnpj) VALUES (2, 0, 'FILIAL_MESMA_PJ', 1, 0, 'Filial Sul', '12345678000280')").run();

const app = express();
app.use(express.json());
estabRoutes.registrarRotasEstabelecimentos(app, db);
nfseRoutes.registrarRotasNfse(app, db);

function achar(metodo, caminho) {
  for (const c of app.router.stack) {
    if (c.route && c.route.path === caminho && c.route.methods[metodo]) {
      return c.route.stack[c.route.stack.length - 1].handle;
    }
  }
  throw new Error('rota não encontrada: ' + metodo + ' ' + caminho);
}
function chamar(metodo, caminho, body = {}, params = {}, user = null) {
  const h = achar(metodo, caminho);
  let out = null;
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(j) { out = { status: this.statusCode, body: j }; return this; },
  };
  h({ body, params, query: {}, session: {}, user }, res, () => {});
  return out;
}
const serieDe = (estabId, modelo) =>
  db.prepare('SELECT serie, proximoNumero FROM estabelecimento_serie WHERE estabelecimentoId = ? AND modelo = ?').get(estabId, modelo);

t('filial sem linha gravada mostra o mesmo default que a emissão usaria (1/1)', () => {
  const r = chamar('get', '/api/estabelecimentos/:id/emissao', {}, { id: '2' });
  assert(r.body.success, JSON.stringify(r.body));
  assert(r.body.series['55'].serie === 1 && r.body.series['55'].proximoNumero === 1, JSON.stringify(r.body.series));
  assert(r.body.series['55'].gravado === false, 'disse que estava gravado sem estar');
  assert(!serieDe(2, '55'), 'o GET criou linha no banco — leitura não pode escrever');
});

t('PUT grava série e numeração dos três modelos da filial', () => {
  const r = chamar('put', '/api/estabelecimentos/:id/emissao', {
    series: { '55': { serie: 2, proximoNumero: 500 }, '65': { serie: 3, proximoNumero: 10 }, 'NFSE': { serie: 4, proximoNumero: 7 } },
    cscId: '000123', csc: 'TOKEN-SECRETO',
  }, { id: '2' });
  assert(r.body.success, JSON.stringify(r.body));
  assert(serieDe(2, '55').proximoNumero === 500, JSON.stringify(serieDe(2, '55')));
  assert(serieDe(2, '65').serie === 3, JSON.stringify(serieDe(2, '65')));
  assert(serieDe(2, 'NFSE').serie === 4, JSON.stringify(serieDe(2, 'NFSE')));
});

t('CSC não é devolvido no GET — só o flag de cadastrado', () => {
  const r = chamar('get', '/api/estabelecimentos/:id/emissao', {}, { id: '2' });
  assert(r.body.cscCadastrado === true, JSON.stringify(r.body));
  assert(!JSON.stringify(r.body).includes('TOKEN-SECRETO'), 'vazou o token do CSC');
  assert(r.body.cscId === '000123', JSON.stringify(r.body.cscId));
});

t('CSC em branco preserva o token guardado', () => {
  chamar('put', '/api/estabelecimentos/:id/emissao', { series: {}, cscId: '000123' }, { id: '2' });
  const row = db.prepare('SELECT csc FROM estabelecimentos WHERE id = 2').get();
  assert(row.csc === 'TOKEN-SECRETO', 'apagou o CSC ao salvar sem preencher: ' + row.csc);
});

t('cscLimpar apaga de fato', () => {
  chamar('put', '/api/estabelecimentos/:id/emissao', { series: {}, cscLimpar: true }, { id: '2' });
  const row = db.prepare('SELECT csc FROM estabelecimentos WHERE id = 2').get();
  assert(row.csc === null, 'não apagou: ' + row.csc);
});

t('PUT recusa a matriz (ela usa nfe_config/nfce_config)', () => {
  const r = chamar('put', '/api/estabelecimentos/:id/emissao', { series: { '55': { serie: 9, proximoNumero: 9 } } }, { id: '1' });
  assert(r.status === 400, 'status: ' + r.status);
  assert(!serieDe(1, '55'), 'gravou série da matriz em estabelecimento_serie');
});

t('série ou número inválido é recusado, não gravado torto', () => {
  const antes = JSON.stringify(serieDe(2, '55'));
  const r = chamar('put', '/api/estabelecimentos/:id/emissao', { series: { '55': { serie: 0, proximoNumero: 5 } } }, { id: '2' });
  assert(r.status === 400, 'status: ' + r.status);
  assert(JSON.stringify(serieDe(2, '55')) === antes, 'alterou mesmo recusando');
});

t('usuário restrito a uma loja não lê a configuração de outra', () => {
  const r = chamar('get', '/api/estabelecimentos/:id/emissao', {}, { id: '2' }, { estabelecimentoId: 1 });
  assert(r.status === 403, 'status: ' + r.status);
});

t('usuário restrito não grava em lugar nenhum', () => {
  const r = chamar('put', '/api/estabelecimentos/:id/emissao', { series: {} }, { id: '2' }, { estabelecimentoId: 2 });
  assert(r.status === 403, 'status: ' + r.status);
});

t('estabelecimento inexistente devolve 404', () => {
  const r = chamar('get', '/api/estabelecimentos/:id/emissao', {}, { id: '99' });
  assert(r.status === 404, 'status: ' + r.status);
});

console.log('\n--- série do DPS da matriz ---');

t('PUT /api/nfse/serie-dps grava só a série, sem tocar no resto do cadastro', () => {
  const r = chamar('put', '/api/nfse/serie-dps', { serieDps: '7' });
  assert(r.body.success, JSON.stringify(r.body));
  const f = db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();
  assert(f.serieDps === '7', 'série: ' + f.serieDps);
  assert(f.razaoSocial === 'Matriz LTDA', 'apagou a razão social: ' + f.razaoSocial);
  assert(f.cnpj === '12345678000199', 'apagou o CNPJ: ' + f.cnpj);
});

t('série não numérica é recusada', () => {
  const r = chamar('put', '/api/nfse/serie-dps', { serieDps: 'A1' });
  assert(r.status === 400, 'status: ' + r.status);
  assert(db.prepare('SELECT serieDps FROM fornecedor WHERE id = 1').get().serieDps === '7', 'gravou torto');
});

t('série com mais de 5 dígitos é recusada', () => {
  const r = chamar('put', '/api/nfse/serie-dps', { serieDps: '123456' });
  assert(r.status === 400, 'status: ' + r.status);
});

t('série em branco limpa o campo (emissão volta para 1)', () => {
  const r = chamar('put', '/api/nfse/serie-dps', { serieDps: '' });
  assert(r.body.success, JSON.stringify(r.body));
  assert(db.prepare('SELECT serieDps FROM fornecedor WHERE id = 1').get().serieDps === null, 'não limpou');
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
