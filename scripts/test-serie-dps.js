/**
 * Serie do DPS e codigo do municipio como dado do cadastro da empresa.
 *
 * O que se quer provar: existe UM lugar onde esses dois campos moram, a emissao
 * le de la, e a tela de NFS-e nao consegue mais gravar por baixo — que era o
 * jeito de duas verdades coexistirem ate a prefeitura reclamar.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

const nfseRoutes = require('../nfse-routes');
const fornRoutes = require('../fornecedor-routes');
const { migrarSerieDps, serieDaEmissao, municipioDaEmissao } = nfseRoutes;

const DB = '/tmp/vp-serie.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-serie-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- fixture ----------
function reset({ serieDps = null, codMun = '1504208', cfgSerie = null, cfgMun = null } = {}) {
  db.exec('DELETE FROM fornecedor; DELETE FROM nfse_config; DELETE FROM estabelecimentos; DELETE FROM estabelecimento_serie;');
  db.prepare('INSERT INTO fornecedor (id, razaoSocial, cnpj) VALUES (1, ?, ?)')
    .run('Empresa Teste LTDA', '12345678000199');
  if (temColuna('serieDps') && serieDps !== null) {
    db.prepare('UPDATE fornecedor SET serieDps = ? WHERE id = 1').run(serieDps);
  }
  db.prepare('UPDATE fornecedor SET codigoMunicipio = ? WHERE id = 1').run(codMun);
  const set = db.prepare('INSERT INTO nfse_config (key, value) VALUES (?, ?)');
  set.run('ambiente', '2');
  set.run('proximo_numero', '1');
  if (cfgSerie !== null) set.run('serie', cfgSerie);
  if (cfgMun !== null) set.run('cod_municipio', cfgMun);
}
const temColuna = (c) => db.prepare('PRAGMA table_info(fornecedor)').all().some(x => x.name === c);
const forn = () => db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();

// ================= MIGRACAO =================
console.log('\n--- migração ---');

t('a coluna serieDps não existia antes da migração', () => {
  assert(!temColuna('serieDps'), 'schema de produção já tinha serieDps — fixture inválida');
});

t('migração cria a coluna e traz a série da config antiga', () => {
  reset({ cfgSerie: '7' });
  const r = migrarSerieDps(db);
  assert(temColuna('serieDps'), 'coluna não criada');
  assert(r.serie === '7', 'retorno: ' + JSON.stringify(r));
  assert(forn().serieDps === '7', 'cadastro: ' + forn().serieDps);
});

t('a chave antiga continua no lugar (fallback de quem não tem cadastro)', () => {
  const v = db.prepare("SELECT value FROM nfse_config WHERE key = 'serie'").get();
  assert(v && v.value === '7', 'apagou a chave legada: ' + JSON.stringify(v));
});

t('não sobrescreve série já preenchida no cadastro', () => {
  reset({ serieDps: '3', cfgSerie: '9' });
  const r = migrarSerieDps(db);
  assert(r.serie === null, 'retorno: ' + JSON.stringify(r));
  assert(forn().serieDps === '3', 'sobrescreveu: ' + forn().serieDps);
});

t("série 'NFSE' da config antiga não vira série do cadastro", () => {
  reset({ cfgSerie: 'NFSE' });
  migrarSerieDps(db);
  assert(!forn().serieDps, 'copiou lixo: ' + forn().serieDps);
});

t('município da config antiga sobe para o cadastro quando o cadastro está vazio', () => {
  reset({ codMun: '', cfgMun: '3550308' });
  const r = migrarSerieDps(db);
  assert(r.municipio === '3550308', JSON.stringify(r));
  assert(forn().codigoMunicipio === '3550308', 'cadastro: ' + forn().codigoMunicipio);
});

t('município já cadastrado vence o da config antiga', () => {
  reset({ codMun: '1504208', cfgMun: '3550308' });
  migrarSerieDps(db);
  assert(forn().codigoMunicipio === '1504208', 'trocou o município do emissor: ' + forn().codigoMunicipio);
});

t('rodar a migração de novo não muda nada', () => {
  reset({ cfgSerie: '4' });
  migrarSerieDps(db);
  const antes = JSON.stringify(forn());
  migrarSerieDps(db);
  migrarSerieDps(db);
  assert(JSON.stringify(forn()) === antes, 'mudou na segunda passada');
});

// ================= RESOLUCAO =================
console.log('\n--- de onde a emissão lê ---');

t('cadastro vence a config antiga', () => {
  reset({ serieDps: '2', cfgSerie: '8' });
  assert(serieDaEmissao(db, null, forn()) === '2', serieDaEmissao(db, null, forn()));
});

t('sem cadastro, cai na config antiga (nota não muda de série sozinha)', () => {
  reset({ serieDps: '', cfgSerie: '8' });
  assert(serieDaEmissao(db, null, forn()) === '8', serieDaEmissao(db, null, forn()));
});

t("sem nada configurado a série é 1, nunca 'NFSE'", () => {
  reset({});
  const s = serieDaEmissao(db, null, forn());
  assert(s === '1', 'série: ' + s);
});

t('série só de espaços conta como vazia', () => {
  reset({ serieDps: '   ', cfgSerie: '5' });
  assert(serieDaEmissao(db, null, forn()) === '5', serieDaEmissao(db, null, forn()));
});

t('filial usa a série do próprio estabelecimento, não a da matriz', () => {
  reset({ serieDps: '1' });
  const id = db.prepare("INSERT INTO estabelecimentos (matriz, tipo_vinculo, razaoSocial, cnpj, codigoMunicipio) VALUES (0, 'FILIAL', 'Filial', '12345678000280', '3550308')").run().lastInsertRowid;
  db.prepare("INSERT INTO estabelecimento_serie (estabelecimentoId, modelo, serie, proximoNumero) VALUES (?, 'NFSE', 4, 1)").run(id);
  const estab = db.prepare('SELECT * FROM estabelecimentos WHERE id = ?').get(id);
  assert(serieDaEmissao(db, estab, estab) === '4', serieDaEmissao(db, estab, estab));
});

t('filial sem série cadastrada não herda a da matriz por engano', () => {
  reset({ serieDps: '9', cfgSerie: '6' });
  const id = db.prepare("INSERT INTO estabelecimentos (matriz, tipo_vinculo, razaoSocial, cnpj) VALUES (0, 'FILIAL', 'Filial 2', '12345678000361')").run().lastInsertRowid;
  const estab = db.prepare('SELECT * FROM estabelecimentos WHERE id = ?').get(id);
  // Cai no legado/default, nao na serie da matriz: sao emissores diferentes.
  const s = serieDaEmissao(db, estab, estab);
  assert(s === '6', 'série da filial: ' + s);
});

t('município sai do cadastro', () => {
  reset({ codMun: '1504208', cfgMun: '3550308' });
  assert(municipioDaEmissao(db, forn()) === '1504208', municipioDaEmissao(db, forn()));
});

t('município ausente devolve vazio (a emissão precisa poder recusar)', () => {
  reset({ codMun: '' });
  assert(municipioDaEmissao(db, forn()) === '', JSON.stringify(municipioDaEmissao(db, forn())));
});

// ================= ROTAS =================
console.log('\n--- rotas ---');

const app = express();
app.use(express.json());
nfseRoutes.registrarRotasNfse(app, db);
fornRoutes.registrarRotasFornecedor(app, db);

function achar(metodo, caminho) {
  for (const c of app.router.stack) {
    if (c.route && c.route.path === caminho && c.route.methods[metodo]) {
      return c.route.stack[c.route.stack.length - 1].handle;
    }
  }
  throw new Error('rota não encontrada: ' + metodo + ' ' + caminho);
}
function chamar(metodo, caminho, body = {}, params = {}) {
  const h = achar(metodo, caminho);
  let out = null;
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(j) { out = { status: this.statusCode, body: j }; return this; },
  };
  h({ body, params, query: {}, session: { username: 'tester' } }, res, () => {});
  return out;
}

t('salvar a empresa grava a série do DPS', () => {
  reset({});
  const r = chamar('post', '/api/fornecedor', { razaoSocial: 'Empresa Teste LTDA', cnpj: '12345678000199', serieDps: '12' });
  assert(r.body.success, JSON.stringify(r.body));
  assert(forn().serieDps === '12', 'gravou: ' + forn().serieDps);
});

t('série não numérica é recusada com motivo, não gravada torta', () => {
  reset({ serieDps: '1' });
  const r = chamar('post', '/api/fornecedor', { razaoSocial: 'X', cnpj: '12345678000199', serieDps: 'A1' });
  assert(r.status === 400, 'status: ' + r.status);
  assert(/numérica/i.test(r.body.error), 'erro: ' + r.body.error);
  assert(forn().serieDps === '1', 'alterou mesmo recusando: ' + forn().serieDps);
});

t('série com mais de 5 dígitos é recusada (não cabe no idDps)', () => {
  reset({});
  const r = chamar('post', '/api/fornecedor', { razaoSocial: 'X', cnpj: '12345678000199', serieDps: '123456' });
  assert(r.status === 400, 'status: ' + r.status);
});

t('série em branco limpa o campo e a emissão volta para 1', () => {
  reset({ serieDps: '5' });
  const r = chamar('post', '/api/fornecedor', { razaoSocial: 'X', cnpj: '12345678000199', serieDps: '' });
  assert(r.body.success, JSON.stringify(r.body));
  assert(forn().serieDps === null, 'ficou: ' + JSON.stringify(forn().serieDps));
  assert(serieDaEmissao(db, null, forn()) === '1', serieDaEmissao(db, null, forn()));
});

t('não mandar serieDps não apaga o que já estava lá', () => {
  reset({ serieDps: '5' });
  chamar('post', '/api/fornecedor', { razaoSocial: 'X', cnpj: '12345678000199' });
  assert(forn().serieDps === '5', 'apagou: ' + JSON.stringify(forn().serieDps));
});

t('a tela de NFS-e não grava mais série — e diz para onde ir', () => {
  reset({ serieDps: '2' });
  const r = chamar('post', '/api/nfse/config', { serie: '99' });
  assert(r.status === 400, 'status: ' + r.status);
  assert(/fiscal\/configuracao/.test(r.body.destino || ''), 'sem destino: ' + JSON.stringify(r.body));
  const cfg = db.prepare("SELECT value FROM nfse_config WHERE key = 'serie'").get();
  assert(!cfg, 'gravou a chave legada mesmo assim');
  assert(forn().serieDps === '2', 'mexeu no cadastro: ' + forn().serieDps);
});

t('a tela de NFS-e não grava mais município', () => {
  reset({ codMun: '1504208' });
  const r = chamar('post', '/api/nfse/config', { codMunicipio: '3550308' });
  assert(r.status === 400, 'status: ' + r.status);
  assert(forn().codigoMunicipio === '1504208', 'trocou o município: ' + forn().codigoMunicipio);
});

t('ambiente continua sendo alterável pela tela de NFS-e', () => {
  reset({});
  const r = chamar('post', '/api/nfse/config', { ambiente: 1 });
  assert(r.body.success, JSON.stringify(r.body));
  assert(db.prepare("SELECT value FROM nfse_config WHERE key = 'ambiente'").get().value === '1', 'não gravou');
});

t('ambiente inválido continua sendo recusado', () => {
  reset({});
  const r = chamar('post', '/api/nfse/config', { ambiente: 5 });
  assert(r.status === 400, 'status: ' + r.status);
});

t('a config devolve os valores do cadastro e diz de onde vieram', () => {
  reset({ serieDps: '3', codMun: '1504208' });
  const r = chamar('get', '/api/nfse/config');
  assert(r.body.success, JSON.stringify(r.body));
  const c = r.body.config;
  assert(c.serie === '3' && c.serieOrigem === 'cadastro', JSON.stringify(c));
  assert(c.codMunicipio === '1504208' && c.codMunicipioOrigem === 'cadastro', JSON.stringify(c));
});

t("valor vindo da config antiga é rotulado 'legado', não passado por cadastro", () => {
  reset({ serieDps: '', codMun: '', cfgSerie: '8', cfgMun: '3550308' });
  const c = chamar('get', '/api/nfse/config').body.config;
  assert(c.serie === '8' && c.serieOrigem === 'legado', JSON.stringify(c));
  assert(c.codMunicipio === '3550308' && c.codMunicipioOrigem === 'legado', JSON.stringify(c));
});

t('sem nada em lugar nenhum, a tela mostra o padrão e a ausência', () => {
  reset({ serieDps: '', codMun: '' });
  const c = chamar('get', '/api/nfse/config').body.config;
  assert(c.serie === '1' && c.serieOrigem === 'padrao', JSON.stringify(c));
  assert(c.codMunicipio === '' && c.codMunicipioOrigem === 'ausente', JSON.stringify(c));
});

t('a empresa devolvida pela API traz serieDps para a tela preencher', () => {
  reset({ serieDps: '6' });
  const r = chamar('get', '/api/fornecedor');
  assert(r.body.data.serieDps === '6', JSON.stringify(r.body.data.serieDps));
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
