#!/usr/bin/env node
/**
 * test-fiscal-diagnostico.js — o diagnóstico fiscal, rota + tela.
 *
 * A pergunta que o teste responde: o diagnóstico diz a verdade sobre o tenant?
 * Para isso ele MONTA cenários no laboratório (regime normal sem regra, com
 * regra, produto sem NCM…) e exige que os achados apareçam e sumam conforme
 * o estado muda. Um diagnóstico que sempre diz a mesma coisa não vale nada.
 *
 * Também confere que os 12 tenants reais passam pelo diagnóstico sem estourar
 * — leitura pura, nenhuma escrita fora do labfiscal.
 *
 * Uso: node scripts/test-fiscal-diagnostico.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const fs = require('fs');
const express = require(BASE + '/node_modules/express');
const Database = require(BASE + '/node_modules/better-sqlite3');
const puppeteer = require(BASE + '/node_modules/puppeteer-core');
const { registrarRotasFiscalDiagnostico, gerarDiagnostico } = require(BASE + '/fiscal-diagnostico-routes');

const PORTA = 34125;
const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }
const tem = (d, id) => d.achados.some(a => a.id === id);
const pega = (d, id) => d.achados.find(a => a.id === id);

// ─── Cenário base no laboratório ────────────────────────────────────────────
function prepararEmpresa({ regime, comCertificado = true }) {
  if (!db.prepare('SELECT COUNT(*) c FROM fornecedor WHERE id = 1').get().c) {
    db.prepare("INSERT INTO fornecedor (id, razaoSocial) VALUES (1, 'Lab Fiscal')").run();
  }
  // Zera também os campos que OUTRAS suítes gravam (o teste de PIS/COFINS
  // define regimeApuracaoPISCOFINS). Quem afirma a precondição precisa montá-la:
  // depender do estado deixado por outra suíte torna o resultado dependente da
  // ordem de execução.
  db.prepare(`UPDATE fornecedor SET regimeTributario = ?, razaoSocial = 'LAB FISCAL LTDA',
      cnpj = '11222333000181', inscricaoEstadual = '123456789', uf = 'TO',
      codigoMunicipio = '1721000', regimeApuracaoPISCOFINS = NULL, contribuinteIPI = NULL
    WHERE id = 1`).run(regime);
  db.prepare('DELETE FROM certificado_digital WHERE id = 1').run();
  if (comCertificado) {
    try {
      db.prepare(`INSERT INTO certificado_digital (id, certificadoBase64, senhaCriptografada)
        VALUES (1, 'ZmFrZQ==', 'ZmFrZQ==')`).run();
    } catch { /* schema diferente — o assert de certificado é pulado */ }
  }
}

(async () => {
  // ─── 1. Simples: matriz não é cobrada ─────────────────────────────────────
  secao('Simples Nacional — a matriz não é exigida');
  prepararEmpresa({ regime: 'SIMPLES_NACIONAL' });
  db.prepare('DELETE FROM fiscal_regras_trib').run();
  {
    const d = gerarDiagnostico(db);
    assert(d.empresa.regime === 'simples', `regime detectado: ${d.empresa.regime}`);
    assert(tem(d, 'matriz-nao-se-aplica'), 'explica que a matriz não se aplica no Simples');
    assert(!tem(d, 'matriz-vazia'), 'NÃO cobra regra tributária de quem é do Simples');
    assert(!tem(d, 'regime-ausente'), 'não reclama de regime, que está informado');
    const m = pega(d, 'matriz-nao-se-aplica');
    assert(/não é destacado/.test(m.detalhe), 'diz o porquê, não só o quê');
  }

  // ─── 2. Regime normal sem regra: bloqueio ─────────────────────────────────
  secao('Regime normal sem regra — precisa bloquear');
  prepararEmpresa({ regime: 'NAO_OPTANTE' });
  {
    const d = gerarDiagnostico(db);
    assert(d.empresa.regime === 'normal' && d.empresa.crt === 3, `CRT 3 (veio ${d.empresa.crt})`);
    assert(tem(d, 'matriz-vazia'), 'acusa matriz vazia');
    assert(pega(d, 'matriz-vazia').severidade === 'bloqueio', 'classificado como bloqueio');
    assert(d.prontoParaEmitir === false, 'veredito: não está pronto para emitir');
    assert(tem(d, 'piscofins-regime-ausente') || tem(d, 'ipi-indefinido'),
      'cobra as definições de PIS/COFINS e IPI que o custo de aquisição usa');
  }

  // ─── 3. Regime normal COM regra que cobre: some o bloqueio ────────────────
  secao('Regime normal com regra cobrindo — bloqueio some');
  {
    // Produto e cliente do cenário
    if (!db.prepare("SELECT id FROM produtos WHERE sku = 'LAB-FERT-01'").get()) {
      db.prepare(`INSERT INTO produtos (sku, descricao, ncm, unidade, precoVenda, origem)
        VALUES ('LAB-FERT-01', 'FERTILIZANTE LAB 10L', '31051000', 'UN', 100, '0')`).run();
    }
    db.prepare(`INSERT INTO fiscal_regras_trib
        (descricao, prioridade, ativo, regimeEmitente, ncmPrefixo, cstIcms, modBC, pIcms, pRedBC,
         cstPis, pPis, cstCofins, pCofins)
      VALUES ('Fertilizante 3105', 10, 1, 3, '3105', '20', 3, 12, 78.95, '01', 1.65, '01', 7.6)`).run();

    const d = gerarDiagnostico(db);
    assert(!tem(d, 'matriz-vazia'), 'não acusa mais matriz vazia');
    const cobertura = pega(d, 'matriz-cobre-tudo') || pega(d, 'matriz-sem-cobertura');
    assert(!!cobertura, 'avalia a cobertura da matriz');
    if (tem(d, 'matriz-sem-cobertura')) {
      // Só produtos fora do NCM 3105 podem restar descobertos.
      const ex = pega(d, 'matriz-sem-cobertura').exemplos.join(' ');
      assert(!/LAB-FERT-01/.test(ex), 'o produto coberto pela regra NÃO aparece como descoberto');
    }
  }

  // ─── 4. Produto sem NCM aparece, e some quando classificado ───────────────
  secao('Produto sem NCM — achado aparece e some');
  {
    const r = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, origem)
      VALUES ('LAB-SEM-NCM', 'PRODUTO SEM NCM', 'UN', 10, '0')`).run();
    const idSemNcm = r.lastInsertRowid;

    let d = gerarDiagnostico(db);
    assert(tem(d, 'produtos-sem-ncm'), 'acusa produto sem NCM');
    const a = pega(d, 'produtos-sem-ncm');
    assert(a.exemplos.some(x => /LAB-SEM-NCM/.test(x)), 'nomeia o produto, não só a contagem');
    assert(a.quantidade >= 1, `informa a quantidade (${a.quantidade})`);

    db.prepare("UPDATE produtos SET ncm = '31051000' WHERE id = ?").run(idSemNcm);
    d = gerarDiagnostico(db);
    const a2 = pega(d, 'produtos-sem-ncm');
    assert(!a2 || !a2.exemplos.some(x => /LAB-SEM-NCM/.test(x)), 'some depois de classificar');

    db.prepare('DELETE FROM produtos WHERE id = ?').run(idSemNcm);
  }

  // ─── 5. Regime ausente é risco, não silêncio ──────────────────────────────
  secao('Regime não informado');
  {
    db.prepare('UPDATE fornecedor SET regimeTributario = NULL WHERE id = 1').run();
    const d = gerarDiagnostico(db);
    assert(tem(d, 'regime-ausente'), 'acusa regime não informado');
    assert(pega(d, 'regime-ausente').severidade === 'risco', 'classificado como risco');
    assert(/CRT=1/.test(pega(d, 'regime-ausente').detalhe), 'explica a consequência concreta (CRT=1)');
    assert(d.empresa.crt === 1, 'o diagnóstico mostra qual CRT sairia de fato');
  }

  // ─── 6. Emitente incompleto bloqueia ──────────────────────────────────────
  secao('Emitente incompleto');
  {
    db.prepare('UPDATE fornecedor SET cnpj = NULL WHERE id = 1').run();
    const d = gerarDiagnostico(db);
    assert(tem(d, 'emit-cnpj') && pega(d, 'emit-cnpj').severidade === 'bloqueio',
      'CNPJ ausente é bloqueio');
    db.prepare("UPDATE fornecedor SET cnpj = '11222333000181' WHERE id = 1").run();
  }

  // ─── 7. Os 12 tenants reais passam sem estourar ───────────────────────────
  secao('Tenants reais — o diagnóstico roda em todos (leitura pura)');
  {
    let n = 0, erros = [];
    for (const t of fs.readdirSync(BASE + '/data/tenants')) {
      const p = `${BASE}/data/tenants/${t}/pncp.db`;
      if (!fs.existsSync(p)) continue;
      const tdb = new Database(p, { readonly: true });
      try {
        const d = gerarDiagnostico(tdb);
        n++;
        if (!d.empresa || !Array.isArray(d.achados)) erros.push(`${t}: resposta malformada`);
        if (typeof d.prontoParaEmitir !== 'boolean') erros.push(`${t}: veredito ausente`);
      } catch (e) { erros.push(`${t}: ${e.message}`); }
      finally { tdb.close(); }
    }
    assert(n >= 10, `${n} tenants diagnosticados`);
    assert(erros.length === 0, 'nenhum tenant estourou', erros.slice(0, 4).join('\n      '));
  }

  // ─── 8. A tela ────────────────────────────────────────────────────────────
  secao('Tela em Chrome headless');
  prepararEmpresa({ regime: 'NAO_OPTANTE' });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, role: 'admin' }; next(); });
  registrarRotasFiscalDiagnostico(app, db);
  app.get('/__wrapper', (_req, res) => {
    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <script>window.__liciteShell = true;</script></head>
      <body style="margin:0"><iframe src="/fiscal/diagnostico.html"
        style="width:100vw;height:100vh;border:0"></iframe></body></html>`);
  });
  app.use(express.static(BASE + '/public'));
  const server = app.listen(PORTA);

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    userDataDir: '/tmp/chrome-test-diagnostico',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });
  const errosJS = [];
  page.on('pageerror', e => errosJS.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error') errosJS.push('console: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${PORTA}/__wrapper`, { waitUntil: 'networkidle0' });
  const frame = page.frames().find(f => f.url().includes('diagnostico.html'));
  assert(!!frame, 'iframe carregou');

  await frame.waitForFunction(
    () => !document.getElementById('conteudo').textContent.includes('Conferindo'), { timeout: 8000 });
  const txt = await frame.$eval('#conteudo', el => el.textContent);

  assert(/LAB FISCAL LTDA/.test(txt), 'mostra a empresa diagnosticada');
  assert(/regime normal/.test(txt), 'mostra o regime detectado');
  assert(/bloqueio|Bloqueio/.test(txt), 'mostra a contagem por severidade');
  const veredito = await frame.$eval('.veredito', el => el.textContent);
  assert(veredito.length > 0, `veredito exibido ("${veredito.trim().slice(0, 50)}…")`);
  const nAchados = await frame.$$eval('.achado', els => els.length);
  assert(nAchados > 0, `${nAchados} achados renderizados`);
  const nLinks = await frame.$$eval('.achado .acoes a', els => els.length);
  assert(nLinks > 0, `${nLinks} achados com link "Resolver" — acionável, não só descritivo`);

  const inesperados = errosJS.filter(e => !/favicon|404/i.test(e));
  assert(inesperados.length === 0, 'nenhum erro de JS na tela', inesperados.slice(0, 4).join('\n      '));

  // Limpeza do laboratório
  db.prepare('DELETE FROM fiscal_regras_trib').run();
  db.prepare('DELETE FROM certificado_digital WHERE id = 1').run();

  await browser.close();
  server.close();
  db.close();
  console.log(`\n${'─'.repeat(56)}`);
  console.log(fail === 0 ? `TODOS OS ${ok} ASSERTS PASSARAM` : `${ok} OK · ${fail} FALHARAM`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('ERRO FATAL:', err);
  process.exit(1);
});
