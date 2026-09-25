/**
 * Vincular certificado a contrato — inclusive depois de emitido.
 *
 * O caso: em 24/09/2026 o vínculo do `secom.df.gov.br` (já emitido) foi trocado
 * na tela, a tela respondeu "Certificado atualizado", e o contrato continuou
 * vazio. Dois defeitos independentes, cada um capaz de produzir esse sintoma
 * sozinho:
 *
 *   1. `salvarEdicao()` montava o corpo do PUT sem contratoId/clienteId/
 *      contratoItemId. O campo nem saía do navegador.
 *   2. no backend, `contratoItemId` estava em SO_GESTAO (a validação o aceitava
 *      depois da emissão) e FORA da lista `campos` que monta o UPDATE. Aceito
 *      e descartado: resposta `success`, dado intacto.
 *
 * O que os dois têm em comum é o pior sintoma possível — sucesso relatado, nada
 * gravado. Por isso as checagens abaixo conferem o BANCO depois do PUT, e não a
 * resposta da rota.
 *
 * Vincular é retroativo por natureza: diz qual contrato pagou o certificado, e
 * não muda nada do que a CA validou. É por isso que o backend permite isso com
 * o certificado emitido.
 *
 * Banco descartável; nada aqui chama a NicSRS.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const RAIZ = path.join(__dirname, '..');
const Database = require(path.join(RAIZ, 'node_modules/better-sqlite3'));
const express = require(path.join(RAIZ, 'node_modules/express'));

let okN = 0, falhas = 0;
const t = (n, f) => { try { f(); console.log('  OK  ' + n); okN++; } catch (e) { falhas++; console.log('FALHA ' + n + ' -> ' + e.message); } };
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-vinculo-'));
const db = new Database(path.join(TMP, 'teste.db'));
const logReal = console.log;
console.log = () => {};
db.pragma('foreign_keys = OFF');
require(path.join(RAIZ, 'db-schema')).initSchema(db);

const app = express();
app.use(express.json());
require(path.join(RAIZ, 'recorrencia-routes.js')).registrarRotasRecorrencia(app, db);
require(path.join(RAIZ, 'contratos-routes.js')).registrarRotasContratos(app, db);
require(path.join(RAIZ, 'ssl-certificados-routes.js')).registrarRotasSslCertificados(app, db);
console.log = logReal;

// O gate de módulo: sem isto toda rota /api/ssl responde 403.
db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('ssl_enabled','1')").run();

db.prepare("INSERT INTO pessoas (id, razaoSocial, cpfCnpj) VALUES (7,'SECRETARIA DE COMUNICACAO','00000000000191')").run();
db.prepare(`INSERT INTO contratos (id, numero, clienteId, descricao, valorMensal, status, dataInicio)
            VALUES (3,'CT-2026-0003',7,'SSL',100,'ativo','2026-01-01')`).run();
const itemId = db.prepare(`INSERT INTO contratos_itens (contratoId, descricao, quantidade, periodicidade)
                           VALUES (3,'Certificado SSL',1,'anual')`).run().lastInsertRowid;

// O certificado do caso real: JÁ EMITIDO e sem vínculo nenhum.
db.prepare(`INSERT INTO ssl_certificados (id, commonName, productCode, status, certId, dcvMethod)
            VALUES (60,'secom.df.gov.br','instantssl-ov','emitido','cert-123','CNAME_CSR_HASH')`).run();

const doCert = () => db.prepare('SELECT contratoId, clienteId, contratoItemId, status FROM ssl_certificados WHERE id=60').get();

let BASE;
const srv = http.createServer(app);
const put = (corpo) => fetch(`${BASE}/api/ssl/certificados/60`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + srv.address().port;

  t('1. o certificado começa emitido e sem vínculo', () => {
    const c = doCert();
    eq(c.status, 'emitido', 'status');
    ok(!c.contratoId && !c.clienteId && !c.contratoItemId, 'não deveria ter vínculo ainda');
  });

  // O defeito 2: contratoItemId era aceito e descartado.
  const r = await put({ contratoId: 3, clienteId: 7, contratoItemId: Number(itemId) });

  t('2. o PUT aceita vínculo em certificado EMITIDO', () => {
    eq(r.status, 200, 'status HTTP: ' + JSON.stringify(r.body).slice(0, 160));
    ok(r.body.success, 'success');
  });

  // A checagem que importa: o BANCO, não a resposta. Os dois defeitos
  // respondiam `success` sem gravar.
  t('3. os TRÊS campos chegaram ao banco', () => {
    const c = doCert();
    eq(c.contratoId, 3, 'contratoId');
    eq(c.clienteId, 7, 'clienteId');
    eq(c.contratoItemId, Number(itemId), 'contratoItemId — era aceito e descartado no UPDATE');
  });

  t('4. vincular não mexe no que a CA validou', () => {
    eq(doCert().status, 'emitido', 'o status não pode mudar por causa de um vínculo');
  });

  // Desvincular é a operação inversa e precisa funcionar igual.
  const r2 = await put({ contratoId: null, clienteId: null, contratoItemId: null });
  t('5. dá para desvincular', () => {
    ok(r2.body.success, 'success: ' + JSON.stringify(r2.body).slice(0, 120));
    const c = doCert();
    ok(!c.contratoId && !c.clienteId && !c.contratoItemId, 'o vínculo deveria ter saído');
  });

  // ---- a ponta da tela: o corpo do PUT precisa levar o vínculo ----
  const vm = require('vm');
  const HTML = fs.readFileSync(path.join(RAIZ, 'public/ssl/certificados.html'), 'utf8');
  const inline = [...HTML.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const js = inline.join('\n');

  t('6. o script inline da tela parseia', () => {
    ok(inline.length > 0, 'nenhum script inline');
    inline.forEach((src, i) => {
      try { new vm.Script(src, { filename: `certificados.html#${i}` }); }
      catch (e) { throw new Error(`bloco ${i}: ${e.message}`); }
    });
  });

  // O defeito 1: o campo não saía do navegador.
  t('7. salvarEdicao() envia o vínculo no corpo do PUT', () => {
    const i = js.indexOf('async function salvarEdicao(');
    ok(i >= 0, 'salvarEdicao ausente');
    const corpo = js.slice(i, js.indexOf('const r = await fetch', i));
    for (const campo of ['contratoId', 'clienteId', 'contratoItemId']) {
      ok(new RegExp(`${campo}:`).test(corpo), `${campo} não vai no corpo do PUT`);
    }
  });

  // As duas listas do backend têm de concordar: aceitar e gravar o mesmo conjunto.
  t('8. SO_GESTAO e a lista do UPDATE não divergem', () => {
    const rotas = fs.readFileSync(path.join(RAIZ, 'ssl-certificados-routes.js'), 'utf8');
    const bloco = (marca) => {
      const i = rotas.indexOf(marca);
      return rotas.slice(i, rotas.indexOf('];', i));
    };
    const soGestao = bloco('const SO_GESTAO =');
    const campos = bloco('const campos = [');
    for (const campo of ['contratoId', 'clienteId', 'contratoItemId', 'custoUsd', 'observacoes']) {
      ok(soGestao.includes(`'${campo}'`), `${campo} fora de SO_GESTAO`);
      ok(campos.includes(`'${campo}'`), `${campo} aceito por SO_GESTAO e ausente do UPDATE — seria descartado calado`);
    }
  });

  srv.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n  ${okN} ok, ${falhas} falha(s)\n`);
  process.exit(falhas ? 1 : 0);
})();
