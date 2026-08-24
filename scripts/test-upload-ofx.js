/**
 * Upload de OFX na conciliação bancária.
 *
 * O bug: o multer lê o corpo com busboy, e callback de stream não carrega o
 * AsyncLocalStorage — o contexto do tenant sumia entre o middleware e o
 * handler, e o proxy do db estourava "currentDb() chamado fora de contexto".
 * Estes testes rodam a chain HTTP inteira, que é o único jeito de pegar isso:
 * chamar o handler direto não passa pelo multer.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { tenantStorage, createDbProxy, reentrarContextoTenant } = require('../tenant-middleware');

const DB = '/tmp/vp-ofx.db';
try { fs.unlinkSync(DB); } catch {}
const real = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-ofx-schema.sql', 'utf8');
real.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  real.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
real.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT,
  acao TEXT, entidade TEXT, entidadeId INTEGER, detalhes TEXT, ip TEXT, dataCriacao TEXT)`);
const CONTA = real.prepare("INSERT INTO contas_financeiras (nome, tipo, ativo) VALUES ('Banco','corrente',1)").run().lastInsertRowid;

const TENANT = { slug: 'demo', name: 'Demo' };

let ok = 0, fail = 0;
const pendentes = [];
const t = (nome, fn) => pendentes.push(async () => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
});
const assert = (c, m) => { if (!c) throw new Error(m); };

const OFX = [
  'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', '', '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>',
  '<BANKTRANLIST>',
  '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260801120000<TRNAMT>1500.00<FITID>TRX-001<MEMO>PIX RECEBIDO CLIENTE</STMTTRN>',
  '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260802120000<TRNAMT>-35.90<FITID>TRX-002<MEMO>TARIFA MENSALIDADE</STMTTRN>',
  '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
].join('\n');

// Monta o app com a mesma cadeia do servidor: contexto por requisicao,
// depois as rotas (que trazem o multer dentro).
function montarApp() {
  const app = express();
  app.use((req, res, next) => {
    req.tenant = TENANT;
    req.tenantDb = real;
    req.tenantCtx = { kind: 'tenant', slug: 'demo' };
    req.session = { username: 'tester' };
    tenantStorage.run({ kind: 'tenant', tenant: TENANT, db: real }, next);
  });
  const dbProxy = createDbProxy();
  // O registro roda migracoes usando o proxy — precisa de contexto tambem,
  // como o servidor faz no boot.
  tenantStorage.run({ kind: 'tenant', tenant: TENANT, db: real }, () => {
    require('../conciliacao-routes').registrarRotasConciliacao(app, dbProxy);
  });
  return app;
}

async function enviarOfx(base, conteudo, contaId) {
  const fd = new FormData();
  fd.append('arquivo', new Blob([conteudo]), 'extrato.ofx');
  if (contaId != null) fd.append('contaFinanceiraId', String(contaId));
  const r = await fetch(base + '/api/conciliacao/upload', { method: 'POST', body: fd });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
const app = montarApp();
const srv = app.listen(0);
await new Promise(r => srv.once('listening', r));
const base = 'http://127.0.0.1:' + srv.address().port;

t('upload de OFX passa pelo multer sem perder o tenant', async () => {
  const r = await enviarOfx(base, OFX, CONTA);
  // O sintoma era exatamente este 400 com a mensagem do currentDb.
  assert(r.status !== 400 || !/fora de contexto/.test(r.body.error || ''),
    'contexto perdido de novo: ' + JSON.stringify(r.body));
  assert(r.body.success, 'erro: ' + JSON.stringify(r.body));
  assert(r.body.novas === 2, 'novas: ' + r.body.novas);
});

t('as transações do arquivo entraram mesmo', async () => {
  const linhas = real.prepare('SELECT fitid, valor, memo FROM transacoes_bancarias ORDER BY fitid').all();
  assert(linhas.length === 2, 'gravadas: ' + linhas.length);
  assert(linhas[0].fitid === 'TRX-001' && Math.abs(linhas[0].valor - 1500) < 0.01, JSON.stringify(linhas[0]));
  assert(linhas[1].valor < 0, 'debito deveria ser negativo: ' + linhas[1].valor);
});

t('reenviar o mesmo arquivo não duplica', async () => {
  const r = await enviarOfx(base, OFX, CONTA);
  assert(r.body.success, 'erro: ' + JSON.stringify(r.body));
  assert(r.body.novas === 0 && r.body.duplicadas === 2, JSON.stringify(r.body));
  assert(real.prepare('SELECT COUNT(*) n FROM transacoes_bancarias').get().n === 2, 'duplicou no banco');
});

t('sem conta financeira o erro é o de verdade, não o de contexto', async () => {
  const r = await enviarOfx(base, OFX, null);
  assert(r.status === 400, 'status: ' + r.status);
  assert(/contaFinanceiraId/.test(r.body.error || ''), 'erro: ' + r.body.error);
});

t('conta inexistente devolve 404, não 400 de contexto', async () => {
  const r = await enviarOfx(base, OFX, 99999);
  assert(r.status === 404, 'status: ' + r.status + ' — ' + JSON.stringify(r.body));
});

t('o middleware não faz nada quando o contexto está intacto', async () => {
  let dentro = null;
  const fake = { tenantDb: real, tenant: TENANT };
  tenantStorage.run({ kind: 'tenant', tenant: TENANT, db: real }, () => {
    reentrarContextoTenant(fake, {}, () => { dentro = tenantStorage.getStore(); });
  });
  assert(dentro && dentro.tenant === TENANT, 'perdeu o contexto que ja estava certo');
});

t('sem tenant na requisição, deixa o erro original aparecer', async () => {
  let chamou = false;
  reentrarContextoTenant({}, {}, () => { chamou = true; });
  // Nao inventa contexto: quem chamar o db falha com a mensagem de sempre.
  assert(chamou, 'nao chamou o next');
  assert(!tenantStorage.getStore(), 'criou contexto do nada');
});

for (const caso of pendentes) await caso();
srv.close();
console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
})();
