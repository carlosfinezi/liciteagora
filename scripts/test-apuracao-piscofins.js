#!/usr/bin/env node
/**
 * test-apuracao-piscofins.js — Apuração de PIS e COFINS.
 *
 * O que este teste existe para provar: que a MESMA massa de documentos produz
 * apurações diferentes conforme o regime. No cumulativo não há crédito nenhum;
 * no não-cumulativo o crédito das aquisições abate o débito. Errar isso é a
 * diferença entre recolher o valor certo e recolher a maior (ou a menor, que é
 * pior).
 *
 * Roda contra o tenant `labfiscal`.
 *
 * Uso: node scripts/test-apuracao-piscofins.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const express = require(BASE + '/node_modules/express');
const Database = require(BASE + '/node_modules/better-sqlite3');
const P = require(BASE + '/fiscal-apuracao-piscofins');

const PORTA = 34131;
const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

P.migrar(db);

function limpar() {
  db.exec(`
    DELETE FROM contas_a_receber WHERE faturaId IN (SELECT id FROM faturas WHERE numero LIKE 'PC-%');
    DELETE FROM fatura_itens WHERE faturaId IN (SELECT id FROM faturas WHERE numero LIKE 'PC-%');
    DELETE FROM faturas WHERE numero LIKE 'PC-%';
    DELETE FROM nfe_entrada_itens WHERE nfeId IN (SELECT id FROM nfe_entrada WHERE numero LIKE '8%');
    DELETE FROM nfe_entrada WHERE numero LIKE '8%';
    DELETE FROM fiscal_apuracao_piscofins;
    DELETE FROM fiscal_apuracao_piscofins_ajustes;
  `);
}
limpar();

if (!db.prepare('SELECT COUNT(*) c FROM fornecedor WHERE id = 1').get().c) {
  db.prepare("INSERT INTO fornecedor (id, razaoSocial) VALUES (1, 'Lab Fiscal')").run();
}
function setRegime(r) {
  db.prepare('UPDATE fornecedor SET regimeApuracaoPISCOFINS = ? WHERE id = 1').run(r);
}

let cli = db.prepare("SELECT id FROM pessoas WHERE cpfCnpj = '11444777000161'").get();
if (!cli) {
  cli = { id: db.prepare(`INSERT INTO pessoas (razaoSocial, cpfCnpj, tipo, uf)
    VALUES ('CLIENTE LAB LTDA', '11444777000161', 'juridica', 'TO')`).run().lastInsertRowid };
}

function saida({ numero, data, receita, vPis, vCofins, status = 'autorizada' }) {
  const fid = db.prepare(`INSERT INTO faturas
    (numero, pedidoId, clienteId, dataEmissao, dataVencimento, valorBruto, valorTotal,
     status, statusSefaz, chaveAcesso, origemDocumento)
    VALUES (?, NULL, ?, ?, ?, ?, ?, 'emitida', ?, ?, 'avulsa')`)
    .run(numero, cli.id, data, data, receita, receita, status, 'CH' + numero).lastInsertRowid;
  db.prepare(`INSERT INTO fatura_itens
    (faturaId, descricao, quantidade, precoUnitario, valorTotal, ncm, cfop,
     cstPis, pPis, vPis, cstCofins, pCofins, vCofins)
    VALUES (?, 'ITEM', 1, ?, ?, '31051000', '5102', '01', 1.65, ?, '01', 7.6, ?)`)
    .run(fid, receita, receita, vPis, vCofins);
  return fid;
}

function entrada({ numero, data, cfop, valorPis, valorCofins }) {
  const eid = db.prepare(`INSERT INTO nfe_entrada
    (chaveAcesso, numero, dataEmissao, emitenteCnpj, emitenteRazaoSocial, valorTotal)
    VALUES (?, ?, ?, '11222333000181', 'FORNECEDOR LAB', 1000)`)
    .run('CHE' + numero, numero, data).lastInsertRowid;
  db.prepare(`INSERT INTO nfe_entrada_itens
    (nfeId, numero, descricao, ncm, cfop, valorPis, valorCofins)
    VALUES (?, 1, 'ITEM ENTRADA', '31051000', ?, ?, ?)`).run(eid, cfop, valorPis, valorCofins);
  return eid;
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, username: 'tester', role: 'admin' }; next(); });
P.registrarRotasFiscalApuracaoPisCofins(app, db);
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
  // ─── 1. Regime não definido ───────────────────────────────────────────────
  secao('Regime não definido');
  {
    db.prepare('UPDATE fornecedor SET regimeApuracaoPISCOFINS = NULL WHERE id = 1').run();
    const r = await get('/api/fiscal/apuracao-piscofins/2026-06');
    assert(r.status === 400 && /não definido/.test(r.json.error), 'recusa apurar sem saber o regime');
    assert(/cumulativa|não-cumulativa/.test(r.json.error), 'explica a escolha', r.json.error);
  }

  // ─── Massa comum aos dois regimes ─────────────────────────────────────────
  // Saídas: receita 100.000, PIS 1.650 e COFINS 7.600 (alíquotas do não-cumulativo)
  saida({ numero: 'PC-001', data: '2026-06-10', receita: 60000, vPis: 990, vCofins: 4560 });
  saida({ numero: 'PC-002', data: '2026-06-20', receita: 40000, vPis: 660, vCofins: 3040 });
  saida({ numero: 'PC-003', data: '2026-06-22', receita: 50000, vPis: 825, vCofins: 3800, status: 'cancelada_sefaz' });
  // Entradas: 1102 credita, 1556 (uso e consumo) não
  entrada({ numero: '8001', data: '2026-06-05', cfop: '1102', valorPis: 400, valorCofins: 1840 });
  entrada({ numero: '8002', data: '2026-06-08', cfop: '1556', valorPis: 100, valorCofins: 460 });

  // ─── 2. Não-cumulativo ────────────────────────────────────────────────────
  secao('Não-cumulativo (Lucro Real) — crédito abate o débito');
  setRegime('nao_cumulativo');
  {
    const a = (await get('/api/fiscal/apuracao-piscofins/2026-06')).json.apuracao;
    assert(a.regime === 'nao_cumulativo' && a.naoCumulativo === true, 'regime detectado');
    assert(a.receitaBruta === 100000, `receita bruta 100.000 — sem a nota cancelada (veio ${a.receitaBruta})`);
    assert(a.pis.vDebitos === 1650, `PIS débitos 1.650,00 (veio ${a.pis.vDebitos})`);
    assert(a.cofins.vDebitos === 7600, `COFINS débitos 7.600,00 (veio ${a.cofins.vDebitos})`);
    assert(a.pis.vCreditos === 400, `PIS créditos 400,00 — só o CFOP 1102 (veio ${a.pis.vCreditos})`);
    assert(a.cofins.vCreditos === 1840, `COFINS créditos 1.840,00 (veio ${a.cofins.vCreditos})`);
    assert(a.pisSemCredito === 100, `PIS sem direito 100,00 — uso e consumo (veio ${a.pisSemCredito})`);
    assert(a.pis.saldo === 1250, `PIS saldo 1.250,00 = 1650 − 400 (veio ${a.pis.saldo})`);
    assert(a.cofins.saldo === 5760, `COFINS saldo 5.760,00 = 7600 − 1840 (veio ${a.cofins.saldo})`);
    assert(a.aliquotasReferencia.pis === 1.65 && a.aliquotasReferencia.cofins === 7.6,
      'alíquotas de referência do regime');
  }

  // ─── 3. Cumulativo: MESMA massa, resultado diferente ──────────────────────
  secao('Cumulativo (Lucro Presumido) — a mesma massa, sem crédito nenhum');
  setRegime('cumulativo');
  {
    const a = (await get('/api/fiscal/apuracao-piscofins/2026-06')).json.apuracao;
    assert(a.naoCumulativo === false, 'regime detectado');
    assert(a.pis.vCreditos === 0 && a.cofins.vCreditos === 0,
      'NENHUM crédito — no cumulativo o PIS/COFINS da compra é custo');
    assert(a.pis.saldo === 1650, `PIS saldo vira 1.650,00, o débito cheio (veio ${a.pis.saldo})`);
    assert(a.cofins.saldo === 7600, `COFINS saldo vira 7.600,00 (veio ${a.cofins.saldo})`);
    assert(a.pisSemCredito === 500, `todo o PIS das entradas fica sem direito: 500,00 (veio ${a.pisSemCredito})`);
    assert(a.cofinsSemCredito === 2300, `idem COFINS: 2.300,00 (veio ${a.cofinsSemCredito})`);
    assert(a.aliquotasReferencia.pis === 0.65 && a.aliquotasReferencia.cofins === 3.00,
      'alíquotas de referência mudam com o regime');
    assert(/nao se recupera/.test(a.memoria), 'a memória explica por que não há crédito');

    const d = (await get('/api/fiscal/apuracao-piscofins/2026-06/detalhe')).json;
    assert(d.creditos.length === 2, 'as entradas continuam listadas para conferência');
    assert(d.creditos.every(c => Number(c.vPis) === 0),
      'mas com crédito zerado — o valor aparece na coluna "sem direito"');
  }

  // ─── 4. Ajustes ───────────────────────────────────────────────────────────
  secao('Ajustes');
  {
    const credNoCumulativo = await post('/api/fiscal/apuracao-piscofins/2026-06/ajustes',
      { tributo: 'pis', tipo: 'outros_creditos', descricao: 'x', valor: 100 });
    assert(credNoCumulativo.status === 400 && /cumulativo não admite crédito/.test(credNoCumulativo.json.error),
      'regime cumulativo recusa lançamento de crédito');

    setRegime('nao_cumulativo');
    const semTributo = await post('/api/fiscal/apuracao-piscofins/2026-06/ajustes',
      { tipo: 'outros_creditos', descricao: 'x', valor: 100 });
    assert(semTributo.status === 400 && /pis, cofins ou ambos/.test(semTributo.json.error),
      'exige dizer a qual tributo o ajuste se refere');

    const soPis = await post('/api/fiscal/apuracao-piscofins/2026-06/ajustes',
      { tributo: 'pis', tipo: 'outros_creditos', descricao: 'Credito extemporaneo', valor: 250 });
    assert(soPis.json.success, 'ajuste só de PIS lançado', soPis.json.error);
    assert(soPis.json.apuracao.pis.saldo === 1000, `PIS cai para 1.000,00 (veio ${soPis.json.apuracao.pis.saldo})`);
    assert(soPis.json.apuracao.cofins.saldo === 5760, 'COFINS não é afetado — saldos independentes');

    const ambos = await post('/api/fiscal/apuracao-piscofins/2026-06/ajustes',
      { tributo: 'ambos', tipo: 'outros_debitos', descricao: 'Receita financeira', valor: 40 });
    assert(ambos.json.apuracao.pis.saldo === 1040 && ambos.json.apuracao.cofins.saldo === 5800,
      'ajuste "ambos" atinge os dois tributos');

    await post(`/api/fiscal/apuracao-piscofins/ajustes/${soPis.json.id}/excluir`);
    await post(`/api/fiscal/apuracao-piscofins/ajustes/${ambos.json.id}/excluir`);
  }

  // ─── 5. Transporte de crédito ─────────────────────────────────────────────
  secao('Transporte de crédito entre competências');
  {
    // Junho vira credor de PIS e COFINS: entrada grande.
    entrada({ numero: '8003', data: '2026-06-25', cfop: '1102', valorPis: 3000, valorCofins: 9000 });
    let jun = (await get('/api/fiscal/apuracao-piscofins/2026-06')).json.apuracao;
    assert(jun.pis.saldo === -1750, `PIS credor: −1.750,00 (veio ${jun.pis.saldo})`);
    assert(jun.pis.creditoTransportar === 1750, 'crédito de PIS a transportar');
    assert(jun.cofins.creditoTransportar === 3240, `crédito de COFINS: 3.240,00 (veio ${jun.cofins.creditoTransportar})`);

    saida({ numero: 'PC-004', data: '2026-07-10', receita: 200000, vPis: 3300, vCofins: 15200 });

    let jul = (await get('/api/fiscal/apuracao-piscofins/2026-07')).json.apuracao;
    assert(jul.pis.creditoAnterior === 0, 'junho aberto: julho não recebe o crédito');
    assert(jul.pis.saldo === 3300, `julho fica com o débito cheio (veio ${jul.pis.saldo})`);

    const f = await post('/api/fiscal/apuracao-piscofins/2026-06/fechar');
    assert(f.json.success, 'junho fechado', f.json.error);

    jul = (await get('/api/fiscal/apuracao-piscofins/2026-07')).json.apuracao;
    assert(jul.pis.creditoAnterior === 1750, 'agora julho recebe o crédito de PIS');
    assert(jul.pis.saldo === 1550, `PIS julho: 3300 − 1750 = 1.550,00 (veio ${jul.pis.saldo})`);
    assert(jul.cofins.saldo === 11960, `COFINS julho: 15200 − 3240 = 11.960,00 (veio ${jul.cofins.saldo})`);
  }

  // ─── 6. Travas ────────────────────────────────────────────────────────────
  secao('Travas de competência fechada');
  {
    const aj = await post('/api/fiscal/apuracao-piscofins/2026-06/ajustes',
      { tributo: 'pis', tipo: 'outros_debitos', descricao: 'tardio', valor: 10 });
    assert(aj.status === 400 && /fechada/.test(aj.json.error), 'não aceita ajuste em competência fechada');

    const ag = await post('/api/fiscal/apuracao-piscofins/2026-08/fechar');
    assert(ag.status === 400 && /2026-07 está aberta e tem movimento/.test(ag.json.error),
      'não fecha agosto com julho aberto e com movimento');

    await post('/api/fiscal/apuracao-piscofins/2026-07/fechar');
    const reab = await post('/api/fiscal/apuracao-piscofins/2026-06/reabrir');
    assert(reab.status === 400 && /posteriores fechadas/.test(reab.json.error),
      'não reabre junho com julho fechado');
  }

  // ─── 7. Troca de regime depois de fechar ──────────────────────────────────
  secao('Troca de regime depois do fechamento');
  {
    setRegime('cumulativo');
    const a = (await get('/api/fiscal/apuracao-piscofins/2026-06')).json.apuracao;
    assert(a.regimeMudouAposFechamento !== null,
      'acusa que a competência foi fechada num regime e a empresa está em outro');
    assert(a.regimeMudouAposFechamento.fechadoComo === 'nao_cumulativo'
      && a.regimeMudouAposFechamento.hoje === 'cumulativo',
      `diz qual era e qual é (${a.regimeMudouAposFechamento.fechadoComo} → ${a.regimeMudouAposFechamento.hoje})`);
    setRegime('nao_cumulativo');
  }

  // ─── 8. Rastreabilidade ───────────────────────────────────────────────────
  secao('Rastreabilidade');
  {
    const d = (await get('/api/fiscal/apuracao-piscofins/2026-06/detalhe')).json;
    assert(d.debitos.length === 2, `2 saídas válidas (veio ${d.debitos.length})`);
    const somaPis = d.debitos.reduce((s, x) => s + Number(x.vPis), 0);
    assert(somaPis === 1650, `soma do detalhe bate com o total (${somaPis})`);
    const usoConsumo = d.creditos.find(c => c.cfops === '1556');
    assert(usoConsumo && Number(usoConsumo.vPis) === 0 && Number(usoConsumo.vPisSemCredito) === 100,
      'uso e consumo aparece com o valor separado');
    assert(d.debitos.every(x => x.numero && x.dataEmissao && x.receita), 'cada linha identifica o documento');
  }

  // ─── 9. A tela ────────────────────────────────────────────────────────────
  secao('Tela em Chrome headless — o regime muda a leitura');
  {
    const puppeteer = require(BASE + '/node_modules/puppeteer-core');
    const expressUI = require(BASE + '/node_modules/express');
    const appUI = expressUI();
    appUI.use(expressUI.json());
    appUI.use((rq, _rs, nx) => { rq.user = { id: 1, username: 'tester', role: 'admin' }; nx(); });
    P.registrarRotasFiscalApuracaoPisCofins(appUI, db);
    appUI.get('/__wrapper', (_rq, rs) => {
      rs.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <script>window.__liciteShell = true;</scr` + `ipt></head>
        <body style="margin:0"><iframe src="/fiscal/apuracao-piscofins.html"
          style="width:100vw;height:100vh;border:0"></iframe></body></html>`);
    });
    appUI.use(expressUI.static(BASE + '/public'));
    const srvUI = appUI.listen(34133);

    const browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome', headless: 'new',
      userDataDir: '/tmp/chrome-test-piscofins',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errosJS = [];
    page.on('pageerror', e => errosJS.push(String(e.message)));
    page.on('console', m => { if (m.type() === 'error') errosJS.push('console: ' + m.text()); });

    await page.goto('http://127.0.0.1:34133/__wrapper', { waitUntil: 'networkidle0' });
    const frame = page.frames().find(f => f.url().includes('apuracao-piscofins.html'));
    assert(!!frame, 'iframe carregou');

    async function irPara(comp) {
      await frame.evaluate((c) => {
        document.getElementById('competencia').value = c;
        window.carregar();
      }, comp);
      await frame.waitForFunction(
        () => !document.getElementById('conteudo').textContent.includes('Apurando'), { timeout: 8000 });
      return frame.$eval('#conteudo', el => el.textContent);
    }

    await frame.waitForSelector('#competencia', { timeout: 5000 });
    let txt = await irPara('2026-06');
    assert(/PIS/.test(txt) && /COFINS/.test(txt), 'os dois tributos lado a lado');
    assert(/Não-cumulativo/.test(txt), 'faixa mostra o regime não-cumulativo');
    assert(/aquisições geram crédito/.test(txt), 'explica o que o regime permite');
    assert(/Receita bruta do período/.test(txt), 'mostra a receita');

    // A MESMA competência, no outro regime, precisa ler diferente
    db.prepare("UPDATE fornecedor SET regimeApuracaoPISCOFINS = 'cumulativo' WHERE id = 1").run();
    txt = await irPara('2026-06');
    assert(/Cumulativo/.test(txt), 'faixa muda para cumulativo');
    assert(/não há crédito/.test(txt), 'explica que não há crédito');
    assert(/não se aplica/.test(txt), 'a linha de créditos aparece como "não se aplica"');
    db.prepare("UPDATE fornecedor SET regimeApuracaoPISCOFINS = 'nao_cumulativo' WHERE id = 1").run();

    await irPara('2026-06');
    await frame.evaluate(() => window.verDetalhe('creditos'));
    const det = await frame.$eval('#detConteudo', el => el.textContent);
    assert(/CFOP/.test(det) && /Sem direito/.test(det), 'detalhe das entradas separa o que não credita');
    await frame.evaluate(() => window.fecharDet());

    const inesperados = errosJS.filter(e => !/favicon|404/i.test(e));
    assert(inesperados.length === 0, 'nenhum erro de JS na tela', inesperados.slice(0, 4).join('\n      '));

    await browser.close();
    srvUI.close();
  }

  limpar();
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
