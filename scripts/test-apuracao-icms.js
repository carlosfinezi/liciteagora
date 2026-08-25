#!/usr/bin/env node
/**
 * test-apuracao-icms.js — Livro de Apuração do ICMS.
 *
 * Monta um cenário completo no laboratório — saídas com débito, entradas com e
 * sem direito a crédito, ajustes, duas competências encadeadas — e confere a
 * aritmética do livro contra números calculados à mão no próprio teste.
 *
 * As perguntas que importam:
 *   - nota CANCELADA entra na apuração? (não pode)
 *   - entrada de uso e consumo gera crédito? (não pode)
 *   - o saldo credor transporta só quando a competência é FECHADA?
 *   - ST e DIFAL ficam FORA da conta principal?
 *   - o total abre nos documentos que o compõem?
 *
 * Uso: node scripts/test-apuracao-icms.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const express = require(BASE + '/node_modules/express');
const Database = require(BASE + '/node_modules/better-sqlite3');
const A = require(BASE + '/fiscal-apuracao-icms');

const PORTA = 34127;
const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

// ─── Massa ──────────────────────────────────────────────────────────────────
A.migrar(db);

function limpar() {
  db.exec(`
    DELETE FROM contas_a_receber WHERE faturaId IN (SELECT id FROM faturas WHERE numero LIKE 'APUR-%');
    DELETE FROM fatura_itens WHERE faturaId IN (SELECT id FROM faturas WHERE numero LIKE 'APUR-%');
    DELETE FROM faturas WHERE numero LIKE 'APUR-%';
    DELETE FROM nfe_entrada_itens WHERE nfeId IN (SELECT id FROM nfe_entrada WHERE numero LIKE '9%');
    DELETE FROM nfe_entrada WHERE numero LIKE '9%';
    DELETE FROM fiscal_apuracao_icms;
    DELETE FROM fiscal_apuracao_icms_ajustes;
  `);
}
limpar();

if (!db.prepare('SELECT COUNT(*) c FROM fornecedor WHERE id = 1').get().c) {
  db.prepare("INSERT INTO fornecedor (id, razaoSocial) VALUES (1, 'Lab Fiscal')").run();
}
db.prepare("UPDATE fornecedor SET regimeTributario = 'NAO_OPTANTE', uf = 'TO' WHERE id = 1").run();

let cli = db.prepare("SELECT id FROM pessoas WHERE cpfCnpj = '11444777000161'").get();
if (!cli) {
  cli = { id: db.prepare(`INSERT INTO pessoas (razaoSocial, cpfCnpj, tipo, uf)
    VALUES ('CLIENTE LAB LTDA', '11444777000161', 'juridica', 'TO')`).run().lastInsertRowid };
}

/** Cria uma saída autorizada com ICMS destacado. */
function saida({ numero, data, vIcms, vST = 0, vDifal = 0, vFcp = 0, status = 'autorizada' }) {
  const fid = db.prepare(`INSERT INTO faturas
    (numero, pedidoId, clienteId, dataEmissao, dataVencimento, valorBruto, valorTotal,
     status, statusSefaz, chaveAcesso, origemDocumento)
    VALUES (?, NULL, ?, ?, ?, 1000, 1000, 'emitida', ?, ?, 'avulsa')`)
    .run(numero, cli.id, data, data, status, 'CHAVE' + numero).lastInsertRowid;
  db.prepare(`INSERT INTO fatura_itens
    (faturaId, descricao, quantidade, precoUnitario, valorTotal, ncm, cfop,
     vIcms, vBcIcms, vIcmsST, vIcmsUFDest, vFcp)
    VALUES (?, 'ITEM', 1, 1000, 1000, '31051000', '5102', ?, 1000, ?, ?, ?)`)
    .run(fid, vIcms, vST, vDifal, vFcp);
  return fid;
}

/** Cria uma entrada. O CFOP decide se gera crédito. */
function entrada({ numero, data, cfop, valorIcms }) {
  const eid = db.prepare(`INSERT INTO nfe_entrada
    (chaveAcesso, numero, dataEmissao, emitenteCnpj, emitenteRazaoSocial, valorTotal, valorIcms)
    VALUES (?, ?, ?, '11222333000181', 'FORNECEDOR LAB', 1000, ?)`)
    .run('CHAVEENT' + numero, numero, data, valorIcms).lastInsertRowid;
  db.prepare(`INSERT INTO nfe_entrada_itens
    (nfeId, numero, descricao, ncm, cfop, valorIcms)
    VALUES (?, 1, 'ITEM ENTRADA', '31051000', ?, ?)`).run(eid, cfop, valorIcms);
  return eid;
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, username: 'tester', role: 'admin' }; next(); });
A.registrarRotasFiscalApuracaoIcms(app, db);
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
  // ─── 1. Débitos: só o que é documento fiscal válido ───────────────────────
  secao('Débitos — o que entra e o que não entra');
  saida({ numero: 'APUR-001', data: '2026-06-05', vIcms: 180 });
  saida({ numero: 'APUR-002', data: '2026-06-20', vIcms: 120 });
  saida({ numero: 'APUR-003', data: '2026-06-25', vIcms: 500, status: 'cancelada_sefaz' });
  saida({ numero: 'APUR-004', data: '2026-06-28', vIcms: 300, status: 'nao_fiscal' });
  saida({ numero: 'APUR-005', data: '2026-07-02', vIcms: 999 });   // fora da competência
  {
    const r = await get('/api/fiscal/apuracao-icms/2026-06');
    const a = r.json.apuracao;
    assert(a.vDebitos === 300, `débitos 300,00 = 180 + 120 (veio ${a.vDebitos})`);
    assert(a.contagem.saidas === 2, `só 2 documentos entraram (veio ${a.contagem.saidas})`);
    assert(a.vDebitos !== 800, 'nota CANCELADA na SEFAZ não soma');
    assert(a.vDebitos !== 600, 'documento não-fiscal não soma');
    assert(a.vDebitos !== 1299, 'nota de julho não entra em junho');
  }

  // ─── 2. Créditos: o CFOP decide ───────────────────────────────────────────
  secao('Créditos — o direito vem do CFOP, não do valor destacado');
  entrada({ numero: '9001', data: '2026-06-10', cfop: '1102', valorIcms: 100 });  // compra p/ revenda
  entrada({ numero: '9002', data: '2026-06-12', cfop: '2102', valorIcms: 80 });   // idem, interestadual
  entrada({ numero: '9003', data: '2026-06-15', cfop: '1556', valorIcms: 50 });   // uso e consumo
  entrada({ numero: '9004', data: '2026-06-18', cfop: '1403', valorIcms: 40 });   // já substituída
  {
    const r = await get('/api/fiscal/apuracao-icms/2026-06');
    const a = r.json.apuracao;
    assert(a.vCreditos === 180, `créditos 180,00 = 100 + 80 (veio ${a.vCreditos})`);
    assert(a.creditoNegado === 90, `90,00 de ICMS sem direito a crédito (veio ${a.creditoNegado})`);
    assert(a.vCreditos !== 270, 'compra para uso e consumo NÃO credita');
    assert(a.vCreditos !== 220, 'mercadoria com ST já recolhido NÃO credita');
  }

  // ─── 3. Saldo ─────────────────────────────────────────────────────────────
  secao('Saldo da competência');
  {
    const r = await get('/api/fiscal/apuracao-icms/2026-06');
    const a = r.json.apuracao;
    assert(a.saldoApurado === 120, `saldo 120,00 = 300 − 180 (veio ${a.saldoApurado})`);
    assert(a.vRecolher === 120, 'saldo devedor vira ICMS a recolher');
    assert(a.saldoCredorTransportar === 0, 'nada a transportar');
    assert(/SALDO: TOTALDEBITOS - TOTALCREDITOS/.test(a.memoria), 'memória traz a fórmula do livro');
  }

  // ─── 4. ST e DIFAL ficam fora da conta ────────────────────────────────────
  secao('ST e DIFAL — apurados à parte');
  saida({ numero: 'APUR-006', data: '2026-06-29', vIcms: 0, vST: 250, vDifal: 90, vFcp: 15 });
  {
    const r = await get('/api/fiscal/apuracao-icms/2026-06');
    const a = r.json.apuracao;
    assert(a.vIcmsST === 250, `ST 250,00 registrado (veio ${a.vIcmsST})`);
    assert(a.vDifal === 90, `DIFAL 90,00 registrado (veio ${a.vDifal})`);
    assert(a.vFcp === 15, `FCP 15,00 registrado (veio ${a.vFcp})`);
    assert(a.saldoApurado === 120, 'ST e DIFAL NÃO alteram o saldo do ICMS próprio — guia própria');
  }

  // ─── 5. Ajustes ───────────────────────────────────────────────────────────
  secao('Ajustes manuais');
  {
    const ruim = await post('/api/fiscal/apuracao-icms/2026-06/ajustes', { tipo: 'inventado', descricao: 'x', valor: 10 });
    assert(ruim.status === 400 && /Tipo inválido/.test(ruim.json.error), 'recusa tipo de ajuste inexistente');

    const negativo = await post('/api/fiscal/apuracao-icms/2026-06/ajustes',
      { tipo: 'outros_creditos', descricao: 'x', valor: -10 });
    assert(negativo.status === 400 && /maior que zero/.test(negativo.json.error),
      'recusa valor negativo — o sinal vem do tipo');

    const cred = await post('/api/fiscal/apuracao-icms/2026-06/ajustes',
      { tipo: 'outros_creditos', descricao: 'Credito extemporaneo de maio', valor: 50, codigoAjuste: 'TO020001' });
    assert(cred.json.success, 'ajuste de crédito lançado', cred.json.error);
    assert(cred.json.apuracao.saldoApurado === 70, `saldo cai para 70,00 (veio ${cred.json.apuracao.saldoApurado})`);

    const deb = await post('/api/fiscal/apuracao-icms/2026-06/ajustes',
      { tipo: 'outros_debitos', descricao: 'Diferencial de aliquota uso e consumo', valor: 30 });
    assert(deb.json.apuracao.saldoApurado === 100, `saldo sobe para 100,00 (veio ${deb.json.apuracao.saldoApurado})`);

    const det = await get('/api/fiscal/apuracao-icms/2026-06/detalhe');
    assert(det.json.ajustes.length === 2, 'os dois ajustes aparecem no detalhamento');

    const del = await post(`/api/fiscal/apuracao-icms/ajustes/${cred.json.id}/excluir`);
    assert(del.json.apuracao.saldoApurado === 150, `removendo o crédito, saldo volta a 150,00 (veio ${del.json.apuracao.saldoApurado})`);

    // Deixa só o débito de 30 → saldo 150
  }

  // ─── 6. Rastreabilidade ───────────────────────────────────────────────────
  secao('Rastreabilidade — o total abre nos documentos');
  {
    const d = await get('/api/fiscal/apuracao-icms/2026-06/detalhe');
    assert(d.json.debitos.length === 3, `3 saídas no detalhe (veio ${d.json.debitos.length})`);
    assert(d.json.creditos.length === 4, `4 entradas no detalhe (veio ${d.json.creditos.length})`);
    const soma = d.json.debitos.reduce((s, x) => s + Number(x.vIcms), 0);
    assert(soma === 300, `a soma do detalhe bate com o total (${soma})`);
    const semCredito = d.json.creditos.find(c => c.cfops === '1556');
    assert(semCredito && Number(semCredito.vIcms) === 0 && Number(semCredito.vIcmsSemCredito) === 50,
      'entrada sem direito aparece com o valor separado, não escondida');
    assert(d.json.debitos.every(x => x.numero && x.dataEmissao), 'cada linha identifica o documento');
  }

  // ─── 7. Fechamento e transporte de saldo ──────────────────────────────────
  secao('Fechamento — o saldo credor só transporta quando a competência fecha');
  {
    // Julho: só a APUR-005 (999 de débito) e nenhuma entrada → devedor.
    // Antes disso, faz junho virar CREDOR para testar o transporte.
    entrada({ numero: '9005', data: '2026-06-19', cfop: '1102', valorIcms: 400 });
    let jun = (await get('/api/fiscal/apuracao-icms/2026-06')).json.apuracao;
    assert(jun.saldoApurado === -250, `junho vira credor: −250,00 (veio ${jun.saldoApurado})`);
    assert(jun.saldoCredorTransportar === 250, 'saldo credor de 250,00 a transportar');
    assert(jun.vRecolher === 0, 'nada a recolher');

    // Com junho ABERTO, julho não recebe o crédito.
    let jul = (await get('/api/fiscal/apuracao-icms/2026-07')).json.apuracao;
    assert(jul.saldoCredorAnterior === 0, 'junho aberto: julho NÃO recebe o saldo credor');
    assert(jul.saldoApurado === 999, `julho fica com o débito cheio (veio ${jul.saldoApurado})`);

    const f = await post('/api/fiscal/apuracao-icms/2026-06/fechar');
    assert(f.json.success && f.json.apuracao.status === 'fechada', 'junho fechado');

    jul = (await get('/api/fiscal/apuracao-icms/2026-07')).json.apuracao;
    assert(jul.saldoCredorAnterior === 250, 'agora julho recebe os 250,00 de crédito');
    assert(jul.saldoApurado === 749, `julho: 999 − 250 = 749,00 (veio ${jul.saldoApurado})`);
  }

  // ─── 8. Travas ────────────────────────────────────────────────────────────
  secao('Travas de competência fechada');
  {
    const aj = await post('/api/fiscal/apuracao-icms/2026-06/ajustes',
      { tipo: 'outros_debitos', descricao: 'tardio', valor: 10 });
    assert(aj.status === 400 && /fechada/.test(aj.json.error), 'não aceita ajuste em competência fechada');

    const refechar = await post('/api/fiscal/apuracao-icms/2026-06/fechar');
    assert(refechar.status === 400 && /já está fechada/.test(refechar.json.error), 'não fecha duas vezes');

    // Agosto não tem movimento nenhum, mas JULHO tem (a APUR-005) e está aberta.
    const fecharJulSemJun = await post('/api/fiscal/apuracao-icms/2026-08/fechar');
    assert(fecharJulSemJun.status === 400 && /2026-07 está aberta e tem movimento/.test(fecharJulSemJun.json.error),
      'não fecha agosto com julho aberto — o saldo de julho não teria sido transportado');

    await post('/api/fiscal/apuracao-icms/2026-07/fechar');
    const reabrirJun = await post('/api/fiscal/apuracao-icms/2026-06/reabrir');
    assert(reabrirJun.status === 400 && /posteriores fechadas/.test(reabrirJun.json.error),
      'não reabre junho com julho fechado — reabrir invalidaria o transporte');

    await post('/api/fiscal/apuracao-icms/2026-07/reabrir');
    const okReabrir = await post('/api/fiscal/apuracao-icms/2026-06/reabrir');
    assert(okReabrir.json.success && okReabrir.json.apuracao.status === 'aberta',
      'reabrindo da mais recente para a mais antiga, funciona');
  }

  // ─── 9. Divergência após fechamento ───────────────────────────────────────
  secao('Documento alterado depois do fechamento');
  {
    await post('/api/fiscal/apuracao-icms/2026-06/fechar');
    saida({ numero: 'APUR-007', data: '2026-06-30', vIcms: 77 });   // chegou atrasada
    const a = (await get('/api/fiscal/apuracao-icms/2026-06')).json.apuracao;
    assert(a.divergenciaAposFechamento !== null,
      'acusa que o número gravado não bate mais com o recalculado');
    assert(a.divergenciaAposFechamento.recalculado !== a.divergenciaAposFechamento.gravado,
      `gravado ${a.divergenciaAposFechamento.gravado} × recalculado ${a.divergenciaAposFechamento.recalculado}`);
  }

  // ─── 10. Simples Nacional não usa este livro ──────────────────────────────
  secao('Simples Nacional');
  {
    db.prepare("UPDATE fornecedor SET regimeTributario = 'SIMPLES_NACIONAL' WHERE id = 1").run();
    const r = await get('/api/fiscal/apuracao-icms/2026-06');
    assert(r.status === 400 && /Simples Nacional/.test(r.json.error),
      'recusa apurar e aponta a tela certa', r.json.error);
    assert(/Apuração SN/.test(r.json.error), 'a mensagem diz para onde ir');
    db.prepare("UPDATE fornecedor SET regimeTributario = 'NAO_OPTANTE' WHERE id = 1").run();
  }

  // ─── 11. Competência inválida ─────────────────────────────────────────────
  secao('Validação de competência');
  {
    for (const c of ['2026-13', '2026', '08-2026', 'abc']) {
      const r = await get('/api/fiscal/apuracao-icms/' + c);
      assert(r.status === 400 && /Competência inválida/.test(r.json.error), `recusa "${c}"`);
    }
  }

  // ─── 12. A tela ───────────────────────────────────────────────────────────
  secao('Tela em Chrome headless');
  {
    const puppeteer = require(BASE + '/node_modules/puppeteer-core');
    const expressUI = require(BASE + '/node_modules/express');
    const appUI = expressUI();
    appUI.use(expressUI.json());
    appUI.use((rq, _rs, nx) => { rq.user = { id: 1, username: 'tester', role: 'admin' }; nx(); });
    A.registrarRotasFiscalApuracaoIcms(appUI, db);
    appUI.get('/__wrapper', (_rq, rs) => {
      rs.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <script>window.__liciteShell = true;</scr` + `ipt></head>
        <body style="margin:0"><iframe src="/fiscal/apuracao-icms.html"
          style="width:100vw;height:100vh;border:0"></iframe></body></html>`);
    });
    appUI.use(expressUI.static(BASE + '/public'));
    const srvUI = appUI.listen(34129);

    const browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome', headless: 'new',
      userDataDir: '/tmp/chrome-test-apuracao',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errosJS = [];
    page.on('pageerror', e => errosJS.push(String(e.message)));
    page.on('console', m => { if (m.type() === 'error') errosJS.push('console: ' + m.text()); });

    await page.goto('http://127.0.0.1:34129/__wrapper', { waitUntil: 'networkidle0' });
    const frame = page.frames().find(f => f.url().includes('apuracao-icms.html'));
    assert(!!frame, 'iframe carregou');

    // Vai para junho, onde está a massa
    await frame.waitForSelector('#competencia', { timeout: 5000 });
    await frame.evaluate(() => {
      document.getElementById('competencia').value = '2026-06';
      window.carregar();
    });
    await frame.waitForFunction(
      () => !document.getElementById('conteudo').textContent.includes('Apurando'), { timeout: 8000 });

    const txt = await frame.$eval('#conteudo', el => el.textContent);
    assert(/Débitos/.test(txt) && /Créditos/.test(txt), 'livro em duas colunas');
    assert(/Saldo credor do período anterior/.test(txt), 'mostra o saldo transportado');
    assert(/ICMS a recolher|Saldo credor a transportar/.test(txt), 'mostra o veredito do saldo');
    assert(/guia própria/.test(txt), 'ST e DIFAL aparecem fora da conta principal');

    // Abre o detalhamento dos débitos
    await frame.evaluate(() => window.verDetalhe('debitos'));
    const detAberto = await frame.$eval('#modalDet', el => el.style.display === 'flex');
    assert(detAberto, 'detalhamento abre');
    const det = await frame.$eval('#detConteudo', el => el.textContent);
    assert(/APUR-00/.test(det), 'o detalhe lista os documentos por número');
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
