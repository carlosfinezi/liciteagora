#!/usr/bin/env node
/**
 * test-apuracao-ipi.js — Apuração do IPI.
 *
 * O ponto que este teste existe para fixar: no IPI, comprar para REVENDA não
 * gera crédito. Só insumo de industrialização gera. É o erro clássico de quem
 * reaproveita a regra do ICMS — e a mesma nota, com o mesmo CFOP, credita num
 * imposto e não credita no outro.
 *
 * Roda contra o tenant `labfiscal`.
 *
 * Uso: node scripts/test-apuracao-ipi.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const express = require(BASE + '/node_modules/express');
const Database = require(BASE + '/node_modules/better-sqlite3');
const I = require(BASE + '/fiscal-apuracao-ipi');

const PORTA = 34135;
const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

I.migrar(db);

function limpar() {
  db.exec(`
    DELETE FROM contas_a_receber WHERE faturaId IN (SELECT id FROM faturas WHERE numero LIKE 'IPI-%');
    DELETE FROM fatura_itens WHERE faturaId IN (SELECT id FROM faturas WHERE numero LIKE 'IPI-%');
    DELETE FROM faturas WHERE numero LIKE 'IPI-%';
    DELETE FROM nfe_entrada_itens WHERE nfeId IN (SELECT id FROM nfe_entrada WHERE numero LIKE '7%');
    DELETE FROM nfe_entrada WHERE numero LIKE '7%';
    DELETE FROM fiscal_apuracao_ipi;
    DELETE FROM fiscal_apuracao_ipi_ajustes;
  `);
}
limpar();

if (!db.prepare('SELECT COUNT(*) c FROM fornecedor WHERE id = 1').get().c) {
  db.prepare("INSERT INTO fornecedor (id, razaoSocial) VALUES (1, 'Lab Fiscal')").run();
}
const setContribuinte = v => db.prepare('UPDATE fornecedor SET contribuinteIPI = ? WHERE id = 1').run(v);

let cli = db.prepare("SELECT id FROM pessoas WHERE cpfCnpj = '11444777000161'").get();
if (!cli) {
  cli = { id: db.prepare(`INSERT INTO pessoas (razaoSocial, cpfCnpj, tipo, uf)
    VALUES ('CLIENTE LAB LTDA', '11444777000161', 'juridica', 'TO')`).run().lastInsertRowid };
}

function saida({ numero, data, produtos, vIpi, cstIpi = '00', status = 'autorizada' }) {
  const fid = db.prepare(`INSERT INTO faturas
    (numero, pedidoId, clienteId, dataEmissao, dataVencimento, valorBruto, valorTotal,
     status, statusSefaz, chaveAcesso, origemDocumento)
    VALUES (?, NULL, ?, ?, ?, ?, ?, 'emitida', ?, ?, 'avulsa')`)
    .run(numero, cli.id, data, data, produtos, produtos, status, 'CHI' + numero).lastInsertRowid;
  db.prepare(`INSERT INTO fatura_itens
    (faturaId, descricao, quantidade, precoUnitario, valorTotal, ncm, cfop, cstIpi, pIpi, vIpi)
    VALUES (?, 'PRODUTO INDUSTRIALIZADO', 1, ?, ?, '22021000', '5101', ?, 10, ?)`)
    .run(fid, produtos, produtos, cstIpi, vIpi);
  return fid;
}

function entrada({ numero, data, cfop, valorIpi }) {
  const eid = db.prepare(`INSERT INTO nfe_entrada
    (chaveAcesso, numero, dataEmissao, emitenteCnpj, emitenteRazaoSocial, valorTotal, valorIpi)
    VALUES (?, ?, ?, '11222333000181', 'FORNECEDOR LAB', 1000, ?)`)
    .run('CHIE' + numero, numero, data, valorIpi).lastInsertRowid;
  db.prepare(`INSERT INTO nfe_entrada_itens
    (nfeId, numero, descricao, ncm, cfop, valorIpi)
    VALUES (?, 1, 'ITEM ENTRADA', '22021000', ?, ?)`).run(eid, cfop, valorIpi);
  return eid;
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, username: 'tester', role: 'admin' }; next(); });
I.registrarRotasFiscalApuracaoIpi(app, db);
const server = app.listen(PORTA);

const API = p => `http://127.0.0.1:${PORTA}${p}`;
async function req(m, p, b) {
  const r = await fetch(API(p), { method: m, headers: { 'Content-Type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, json: await r.json() };
}
const get = p => req('GET', p);
const post = (p, b) => req('POST', p, b || {});

(async () => {
  // ─── 1. Só contribuinte apura ─────────────────────────────────────────────
  secao('Quem apura IPI');
  {
    setContribuinte(0);
    const r = await get('/api/fiscal/apuracao-ipi/2026-06');
    assert(r.status === 400 && /não é contribuinte do IPI/.test(r.json.error),
      'comércio não apura IPI');
    assert(/é custo/.test(r.json.error), 'explica que no comércio o IPI da compra é custo', r.json.error);
    assert(/Minha Empresa/.test(r.json.error), 'diz onde marcar se for indústria');
  }

  setContribuinte(1);

  // ─── 2. O seed distingue industrialização de revenda ──────────────────────
  secao('Direito a crédito por CFOP — o que separa o IPI do ICMS');
  {
    const q = c => db.prepare('SELECT geraCreditoIpi, geraCreditoIcms FROM cfops WHERE codigo = ?').get(c);
    const c1101 = q('1101'), c1102 = q('1102'), c1556 = q('1556');
    assert(c1101 && c1101.geraCreditoIpi === 1, '1101 (industrialização) credita IPI');
    assert(c1102 && c1102.geraCreditoIpi === 0, '1102 (comercialização) NÃO credita IPI');
    assert(c1102 && c1102.geraCreditoIcms === 1,
      'e o MESMO CFOP 1102 credita ICMS — é o erro que o seed próprio evita');
    assert(c1556 && c1556.geraCreditoIpi === 0, '1556 (uso e consumo) não credita');
  }

  // ─── 3. Débitos e créditos ────────────────────────────────────────────────
  secao('Apuração');
  saida({ numero: 'IPI-001', data: '2026-06-08', produtos: 10000, vIpi: 1000 });
  saida({ numero: 'IPI-002', data: '2026-06-18', produtos: 5000, vIpi: 500 });
  saida({ numero: 'IPI-003', data: '2026-06-19', produtos: 8000, vIpi: 800, status: 'cancelada_sefaz' });
  entrada({ numero: '7001', data: '2026-06-05', cfop: '1101', valorIpi: 300 });  // insumo → credita
  entrada({ numero: '7002', data: '2026-06-06', cfop: '2101', valorIpi: 200 });  // insumo → credita
  entrada({ numero: '7003', data: '2026-06-10', cfop: '1102', valorIpi: 700 });  // revenda → NÃO
  entrada({ numero: '7004', data: '2026-06-12', cfop: '1556', valorIpi: 150 });  // uso/consumo → NÃO
  {
    const a = (await get('/api/fiscal/apuracao-ipi/2026-06')).json.apuracao;
    assert(a.vDebitos === 1500, `débitos 1.500,00 — sem a nota cancelada (veio ${a.vDebitos})`);
    assert(a.vCreditos === 500, `créditos 500,00 = só os CFOPs de industrialização (veio ${a.vCreditos})`);
    assert(a.creditoNegado === 850, `850,00 sem direito = 700 revenda + 150 uso/consumo (veio ${a.creditoNegado})`);
    assert(a.vCreditos !== 1350, 'compra para REVENDA não entrou no crédito');
    assert(a.saldoApurado === 1000, `saldo 1.000,00 = 1500 − 500 (veio ${a.saldoApurado})`);
    assert(a.vRecolher === 1000, 'IPI a recolher');
    assert(/insumos de industrializacao/.test(a.memoria), 'a memória nomeia a natureza do crédito');
    assert(/SEM DIREITO A CREDITO: 850/.test(a.memoria), 'a memória registra o crédito negado');
  }

  // ─── 4. Rastreabilidade ───────────────────────────────────────────────────
  secao('Rastreabilidade');
  {
    const d = (await get('/api/fiscal/apuracao-ipi/2026-06/detalhe')).json;
    assert(d.debitos.length === 2, `2 saídas com IPI (veio ${d.debitos.length})`);
    assert(d.creditos.length === 4, `4 entradas listadas (veio ${d.creditos.length})`);
    const revenda = d.creditos.find(c => c.cfops === '1102');
    assert(revenda && Number(revenda.vIpi) === 0 && Number(revenda.vIpiSemCredito) === 700,
      'a entrada de revenda aparece com o valor na coluna "sem direito"');
    const insumo = d.creditos.find(c => c.cfops === '1101');
    assert(insumo && Number(insumo.vIpi) === 300, 'a entrada de insumo aparece como crédito');
    assert(d.debitos.every(x => x.numero && x.dataEmissao && x.baseProdutos),
      'cada linha identifica o documento e a base');
  }

  // ─── 5. Ajustes ───────────────────────────────────────────────────────────
  secao('Ajustes');
  {
    const ruim = await post('/api/fiscal/apuracao-ipi/2026-06/ajustes',
      { tipo: 'deducao', descricao: 'x', valor: 10 });
    assert(ruim.status === 400 && /Tipo inválido/.test(ruim.json.error),
      'recusa tipo que não existe no IPI');

    const cred = await post('/api/fiscal/apuracao-ipi/2026-06/ajustes',
      { tipo: 'outros_creditos', descricao: 'Credito presumido de exportacao', valor: 200 });
    assert(cred.json.success && cred.json.apuracao.saldoApurado === 800,
      `saldo cai para 800,00 (veio ${cred.json.apuracao.saldoApurado})`);

    const estorno = await post('/api/fiscal/apuracao-ipi/2026-06/ajustes',
      { tipo: 'estorno_credito', descricao: 'Estorno de insumo aplicado em isento', valor: 100 });
    assert(estorno.json.apuracao.saldoApurado === 900,
      `estorno de crédito AUMENTA o saldo: 900,00 (veio ${estorno.json.apuracao.saldoApurado})`);

    await post(`/api/fiscal/apuracao-ipi/ajustes/${cred.json.id}/excluir`);
    await post(`/api/fiscal/apuracao-ipi/ajustes/${estorno.json.id}/excluir`);
  }

  // ─── 6. Transporte de saldo ───────────────────────────────────────────────
  secao('Transporte de saldo credor');
  {
    entrada({ numero: '7005', data: '2026-06-25', cfop: '1101', valorIpi: 2000 });
    let jun = (await get('/api/fiscal/apuracao-ipi/2026-06')).json.apuracao;
    assert(jun.saldoApurado === -1000, `junho vira credor: −1.000,00 (veio ${jun.saldoApurado})`);
    assert(jun.saldoCredorTransportar === 1000, 'saldo credor a transportar');

    saida({ numero: 'IPI-004', data: '2026-07-05', produtos: 30000, vIpi: 3000 });
    let jul = (await get('/api/fiscal/apuracao-ipi/2026-07')).json.apuracao;
    assert(jul.saldoCredorAnterior === 0, 'junho aberto: julho não recebe o crédito');

    await post('/api/fiscal/apuracao-ipi/2026-06/fechar');
    jul = (await get('/api/fiscal/apuracao-ipi/2026-07')).json.apuracao;
    assert(jul.saldoCredorAnterior === 1000, 'julho recebe os 1.000,00');
    assert(jul.saldoApurado === 2000, `julho: 3000 − 1000 = 2.000,00 (veio ${jul.saldoApurado})`);
  }

  // ─── 7. Travas ────────────────────────────────────────────────────────────
  secao('Travas');
  {
    const aj = await post('/api/fiscal/apuracao-ipi/2026-06/ajustes',
      { tipo: 'outros_debitos', descricao: 'tardio', valor: 10 });
    assert(aj.status === 400 && /fechada/.test(aj.json.error), 'não aceita ajuste em competência fechada');

    const ag = await post('/api/fiscal/apuracao-ipi/2026-08/fechar');
    assert(ag.status === 400 && /2026-07 está aberta e tem movimento/.test(ag.json.error),
      'não fecha agosto com julho aberto e com movimento');

    await post('/api/fiscal/apuracao-ipi/2026-07/fechar');
    const reab = await post('/api/fiscal/apuracao-ipi/2026-06/reabrir');
    assert(reab.status === 400 && /posteriores fechadas/.test(reab.json.error),
      'não reabre junho com julho fechado');

    await post('/api/fiscal/apuracao-ipi/2026-07/reabrir');
    const okReab = await post('/api/fiscal/apuracao-ipi/2026-06/reabrir');
    assert(okReab.json.success, 'reabrindo da mais recente para a mais antiga, funciona');
  }

  // ─── 8. Divergência após fechamento ───────────────────────────────────────
  secao('Documento alterado depois do fechamento');
  {
    await post('/api/fiscal/apuracao-ipi/2026-06/fechar');
    saida({ numero: 'IPI-005', data: '2026-06-30', produtos: 2000, vIpi: 200 });
    const a = (await get('/api/fiscal/apuracao-ipi/2026-06')).json.apuracao;
    assert(a.divergenciaAposFechamento !== null, 'acusa a divergência');
    assert(a.divergenciaAposFechamento.recalculado === -800,
      `recalculado −800,00 contra gravado ${a.divergenciaAposFechamento.gravado}`);
  }

  // ─── 9. Competência inválida ──────────────────────────────────────────────
  secao('Validação');
  {
    for (const c of ['2026-13', '2026', 'xx']) {
      const r = await get('/api/fiscal/apuracao-ipi/' + c);
      assert(r.status === 400 && /Competência inválida/.test(r.json.error), `recusa "${c}"`);
    }
  }

  // ─── 10. A tela ───────────────────────────────────────────────────────────
  secao('Tela em Chrome headless');
  {
    limpar();
    setContribuinte(1);
    saida({ numero: 'IPI-010', data: '2026-06-08', produtos: 10000, vIpi: 1000 });
    entrada({ numero: '7010', data: '2026-06-05', cfop: '1101', valorIpi: 300 });
    entrada({ numero: '7011', data: '2026-06-10', cfop: '1102', valorIpi: 700 });

    const puppeteer = require(BASE + '/node_modules/puppeteer-core');
    const expressUI = require(BASE + '/node_modules/express');
    const appUI = expressUI();
    appUI.use(expressUI.json());
    appUI.use((rq, _rs, nx) => { rq.user = { id: 1, username: 'tester', role: 'admin' }; nx(); });
    I.registrarRotasFiscalApuracaoIpi(appUI, db);
    appUI.get('/__wrapper', (_rq, rs) => {
      rs.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <script>window.__liciteShell = true;</scr` + `ipt></head>
        <body style="margin:0"><iframe src="/fiscal/apuracao-ipi.html"
          style="width:100vw;height:100vh;border:0"></iframe></body></html>`);
    });
    appUI.use(expressUI.static(BASE + '/public'));
    const srvUI = appUI.listen(34137);

    const browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome', headless: 'new',
      userDataDir: '/tmp/chrome-test-ipi',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errosJS = [];
    page.on('pageerror', e => errosJS.push(String(e.message)));
    page.on('console', m => { if (m.type() === 'error') errosJS.push('console: ' + m.text()); });

    await page.goto('http://127.0.0.1:34137/__wrapper', { waitUntil: 'networkidle0' });
    const frame = page.frames().find(f => f.url().includes('apuracao-ipi.html'));
    assert(!!frame, 'iframe carregou');

    await frame.waitForSelector('#competencia', { timeout: 5000 });
    await frame.evaluate(() => {
      document.getElementById('competencia').value = '2026-06';
      window.carregar();
    });
    await frame.waitForFunction(
      () => !document.getElementById('conteudo').textContent.includes('Apurando'), { timeout: 8000 });

    const txt = await frame.$eval('#conteudo', el => el.textContent);
    assert(/IPI a recolher/.test(txt), 'mostra o veredito com o nome do imposto certo');
    assert(/insumos de industrialização/.test(txt), 'a linha de crédito nomeia a natureza');
    assert(/sem direito a crédito/.test(txt), 'destaca o crédito negado');
    assert(/ao contrário do ICMS/.test(txt), 'explica a diferença que confunde quem vem do ICMS');
    assert(!/DIFAL|ICMS ST/.test(txt), 'não mostra ST nem DIFAL — não existem no IPI');

    await frame.evaluate(() => window.verDetalhe('creditos'));
    const det = await frame.$eval('#detConteudo', el => el.textContent);
    assert(/1101/.test(det) && /1102/.test(det), 'detalhe lista as duas entradas');
    assert(/Sem direito/.test(det), 'coluna de crédito negado presente');
    await frame.evaluate(() => window.fecharDet());

    const inesperados = errosJS.filter(e => !/favicon|404/i.test(e));
    assert(inesperados.length === 0, 'nenhum erro de JS na tela', inesperados.slice(0, 4).join('\n      '));

    await browser.close();
    srvUI.close();
  }

  limpar();
  setContribuinte(null);
  server.close();
  db.close();
  console.log(`\n${'─'.repeat(56)}`);
  console.log(fail === 0 ? `TODOS OS ${ok} ASSERTS PASSARAM` : `${ok} OK · ${fail} FALHARAM`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('ERRO FATAL:', err);
  try { server.close(); } catch {}
  process.exit(1);
});
