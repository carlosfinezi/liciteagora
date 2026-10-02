#!/usr/bin/env node
/**
 * test-ssl-cancelar-ui.js — o botão "Cancelar" da tela de certificados SSL.
 *
 * Por que existe: cancelar é a única ação da tela que gasta dinheiro de verdade
 * ao errar. A NicSRS estorna pedido em processamento e emitido há menos de 30
 * dias; fora disso o valor é perdido, e não há desfazer. Um botão que apareça
 * na linha errada, ou que dispare sem motivo, custa caro — então ele é testado
 * clicando, não lendo.
 *
 * Banco DESCARTÁVEL em /tmp, criado do zero por db-schema.initSchema(). Nada
 * em data/ é tocado.
 *
 * A NicSRS é STUBADA (nicsrs.cancel trocado em memória). Isto não é detalhe de
 * conveniência: sem o stub, cada rodada deste teste cancelaria assinaturas
 * pagas na conta real — e o loop faria isso dezenas de vezes. O teste também
 * verifica que o stub foi de fato chamado, senão um erro que impedisse a
 * chamada passaria por "sucesso".
 *
 * A página roda DENTRO de um iframe: sidebar.js redireciona carga top-level
 * para /app.html.
 *
 * Uso: node scripts/test-ssl-cancelar-ui.js [--loop N]
 */
const BASE = require('path').join(__dirname, '..');
const express = require(BASE + '/node_modules/express');
const Database = require(BASE + '/node_modules/better-sqlite3');
const puppeteer = require(BASE + '/node_modules/puppeteer-core');
const fs = require('fs');

const PORTA = 34141;
const DB_PATH = '/tmp/test-ssl-cancelar.db';

const argLoop = process.argv.indexOf('--loop');
const VOLTAS = argLoop > -1 ? Number(process.argv[argLoop + 1]) || 1 : 1;

let ok = 0, fail = 0;
const falhas = [];
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; falhas.push(msg); console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

// O que NÃO conta como erro de JS da tela. "Failed to load resource" é o Chrome
// narrando um HTTP não-2xx — e um deles é esperado: a seção de erro da NicSRS
// exige que a rota devolva 400. Sem esta exclusão o teste reprovaria justamente
// por ter funcionado.
const NAO_E_RUIDO = (e) => !/favicon|net::ERR|Failed to load resource/i.test(e);

// ─── Banco descartável ──────────────────────────────────────────────────────
for (const suf of ['', '-wal', '-shm']) {
  if (fs.existsSync(DB_PATH + suf)) fs.unlinkSync(DB_PATH + suf);
}
// initSchema() não roda em banco vazio (a ordem das migrações pressupõe tabelas
// que só nascem depois). Clonar o schema de um tenant é mais fiel de qualquer
// forma: testa contra as MESMAS colunas que a produção tem, não contra o que o
// schema idealizado diria. Leitura pura do tenant de laboratório — nada é
// escrito em data/.
const SCHEMA_ORIGEM = BASE + '/data/tenants/labfiscal/pncp.db';
const db = new Database(DB_PATH);
{
  const origem = new Database(SCHEMA_ORIGEM, { readonly: true });
  const ddl = origem.prepare(
    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
  ).all();
  origem.close();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const { sql } of ddl) {
    try { db.exec(sql + ';'); } catch (_) { /* índice/trigger sobre tabela ausente: irrelevante aqui */ }
  }
}
require(BASE + '/ssl-certificados-routes').migrarDB(db);

// ─── Stub da NicSRS ─────────────────────────────────────────────────────────
// Trocar a propriedade no objeto exportado funciona porque
// ssl-certificados-routes guardou a referência do módulo, não das funções.
const nicsrs = require(BASE + '/nicsrs-client');
const { prepararAvisos } = require('./aviso-de-teste');
let chamadasCancel = [];
let proximoErroNicsrs = null;
nicsrs.cancel = async (token, { certId, reason }) => {
  chamadasCancel.push({ token, certId, reason });
  if (proximoErroNicsrs) throw new Error(proximoErroNicsrs);
  return { code: 1, data: {} };
};

// ssl/list alimenta a sincronização automática da abertura da tela. Sem stub,
// cada abertura do teste bateria na conta real.
let chamadasList = 0;
let listaNicsrs = [];
let erroNoList = null;
const chamarOriginal = nicsrs.chamar;
nicsrs.chamar = async (caminho, token, corpo) => {
  if (caminho === 'ssl/list') {
    chamadasList++;
    if (erroNoList) throw new Error(erroNoList);
    return { code: 1, data: listaNicsrs };
  }
  return chamarOriginal(caminho, token, corpo);
};

// ─── Massa ──────────────────────────────────────────────────────────────────
// Um certificado por situação que muda o comportamento do botão.
const CASOS = [
  { cn: 'cancelavel-emitido.test',   status: 'emitido',              certId: 'cert-TESTE-1' },
  { cn: 'cancelavel-comprado.test',  status: 'comprado',             certId: 'cert-TESTE-2' },
  { cn: 'cancelavel-validacao.test', status: 'em-validacao',         certId: 'cert-TESTE-3' },
  { cn: 'sem-certid.test',           status: 'aguardando-aprovacao', certId: null },
  { cn: 'final-cancelado.test',      status: 'cancelado',            certId: 'cert-TESTE-4' },
  { cn: 'final-expirado.test',       status: 'expirado',             certId: 'cert-TESTE-5' },
  { cn: 'final-substituido.test',    status: 'substituido',          certId: 'cert-TESTE-6' },
];

function prepararMassa() {
  db.prepare('DELETE FROM ssl_certificados_eventos').run();
  db.prepare('DELETE FROM ssl_certificados').run();
  // Sem zerar o carimbo, a janela de 5 min da volta anterior faria a sync
  // automática pular — e o teste dela mediria o throttle, não a sync.
  db.prepare("DELETE FROM config WHERE chave = 'nicsrs_sync_auto_em'").run();
  const ins = db.prepare(`INSERT INTO ssl_certificados
      (commonName, status, certId, productCode, productName, vendor, anos, custoUsd)
    VALUES (?,?,?,'certum-dv-ssl','Certum Commercial DV SSL','Certum',1,1.86)`);
  const ids = {};
  for (const c of CASOS) ids[c.cn] = ins.run(c.cn, c.status, c.certId).lastInsertRowid;
  return ids;
}

db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('nicsrs_api_token','TOKEN-DE-TESTE')").run();
// O módulo é add-on por tenant: sem esta chave todo /api/ssl/* responde 403 e a
// tela nasce vazia — o teste passaria a medir o gate, não o botão.
db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('ssl_enabled','1')").run();

// ─── Servidor ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, username: 'testerobo', role: 'admin' }; next(); });
require(BASE + '/ssl-certificados-routes').registrarRotasSslCertificados(app, db);

app.get('/__wrapper', (_req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <script>window.__liciteShell = true;</script></head>
    <body style="margin:0"><iframe id="f" src="/ssl/certificados.html"
      style="width:100vw;height:100vh;border:0"></iframe></body></html>`);
});
app.use(express.static(BASE + '/public'));

const server = app.listen(PORTA);

// ─── Execução ───────────────────────────────────────────────────────────────
(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    userDataDir: '/tmp/chrome-test-ssl-cancelar',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  /* O `confirm()` do navegador era dispensado pelo puppeteer sozinho, e com
     isso a suíte clicava em "excluir" e o fluxo seguia. Desde 01/10/2026 a
     confirmação é a caixa do sistema (`Aviso.confirmar`), que é uma PROMESSA
     esperando alguém clicar: sem isto, o `evaluate` fica pendurado e a suíte
     morre com "Runtime.callFunctionOn timed out". `prepararAvisos` responde
     SIM, que é o que o diálogo nativo fazia, e registra o que foi pedido em
     `window.__confirmacoes`. */
  await prepararAvisos(page);

  await page.setViewport({ width: 1600, height: 1000 });

  const errosJS = [];
  page.on('pageerror', e => errosJS.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error') errosJS.push('console: ' + m.text()); });

  /** Recarrega a tela e devolve o frame da página. */
  async function abrirTela() {
    await page.goto(`http://127.0.0.1:${PORTA}/__wrapper`, { waitUntil: 'networkidle0' });
    const frame = page.frames().find(f => f.url().includes('certificados.html'));
    if (!frame) throw new Error('iframe da tela não carregou');
    await frame.waitForFunction(
      () => document.querySelectorAll('#tb tr').length > 0 && !/Carregando/.test(document.getElementById('tb').textContent),
      { timeout: 10000 });
    return frame;
  }

  /**
   * Neutraliza confirm/prompt e devolve o que a tela perguntou.
   * `motivo: null` simula o Cancelar do prompt; string vazia simula OK vazio.
   */
  async function armarDialogos(frame, { confirmar = true, motivo = 'motivo de teste' } = {}) {
    await frame.evaluate((confirmar, motivo) => {
      window.__perguntas = [];
      /* A tela pergunta pelo `confirm()` do navegador OU pela caixa do sistema
         (`Aviso.confirmar`, uma promessa), e as duas formas já valeram aqui: o
         9afb2bb trocou para a caixa e o 72d4fa1 desfez. Armar as duas é o que
         faz esta suíte medir a GARANTIA — "cancelar pede confirmação" — em vez
         de qual das duas está no arquivo hoje. `window.Aviso` só é substituído
         quando existe: sem a peça carregada, mexer nele é TypeError e a suíte
         morre antes de medir nada. */
      if (window.Aviso) {
        window.Aviso.confirmar = (o) => {
          const texto = typeof o === 'string' ? o : ((o && o.texto) || '');
          window.__perguntas.push({ tipo: 'confirm', texto });
          return Promise.resolve(confirmar);
        };
      }
      window.confirm = (m) => { window.__perguntas.push({ tipo: 'confirm', texto: m }); return confirmar; };
      window.prompt = (m) => { window.__perguntas.push({ tipo: 'prompt', texto: m }); return motivo; };
    }, confirmar, motivo);
  }

  /** Clica no botão Cancelar da linha cujo commonName casa. */
  async function clicarCancelar(frame, cn) {
    return frame.evaluate((cn) => {
      const linha = [...document.querySelectorAll('#tb tr')]
        .find(tr => tr.textContent.includes(cn));
      if (!linha) return { erro: 'linha não encontrada' };
      const btn = [...linha.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancelar');
      if (!btn) return { erro: 'botão Cancelar ausente' };
      btn.click();
      return { ok: true };
    }, cn);
  }

  /** Lista os rótulos de ação visíveis na linha. */
  async function acoesDaLinha(frame, cn) {
    return frame.evaluate((cn) => {
      const linha = [...document.querySelectorAll('#tb tr')].find(tr => tr.textContent.includes(cn));
      if (!linha) return null;
      return [...linha.querySelectorAll('button, a')].map(b => b.textContent.trim()).filter(Boolean);
    }, cn);
  }

  const esperar = (ms) => new Promise(r => setTimeout(r, ms));

  for (let volta = 1; volta <= VOLTAS; volta++) {
    if (VOLTAS > 1) console.log(`\n══════ VOLTA ${volta}/${VOLTAS} ══════`);
    const ids = prepararMassa();
    chamadasCancel = [];
    proximoErroNicsrs = null;
    chamadasList = 0;
    listaNicsrs = [];
    erroNoList = null;

    let frame = await abrirTela();

    secao('Carga da tela');
    const fatais = errosJS.filter(NAO_E_RUIDO);
    assert(fatais.length === 0, 'nenhum erro de JavaScript na carga',
      fatais.slice(0, 3).join('\n      '));
    errosJS.length = 0;

    secao('Correlação com o pedido de compra');
    // Os dois caminhos de vínculo, porque só o primeiro é óbvio e foi ignorar
    // o segundo que deixou o CREADF com o pedido em aberto.
    //   direto  — ssl_certificados.pedidoCompraId
    //   via assinatura — ssl_certificados.pedidoNicsrsId -> ssl_pedidos_nicsrs.pedidoCompraId
    db.prepare("INSERT OR REPLACE INTO pedidos_compra (id, numero, status, dataEmissao, valorTotal) VALUES (901,'PC-TESTE-DIRETO','enviado','2026-08-31',120.84)").run();
    db.prepare("INSERT OR REPLACE INTO pedidos_compra (id, numero, status, dataEmissao, valorTotal) VALUES (902,'PC-TESTE-ASSIN','enviado','2026-08-31',319.47)").run();
    db.prepare("INSERT OR REPLACE INTO ssl_pedidos_nicsrs (id, pedidoCompraId, productCode, status, refId) VALUES (911,902,'certum-ov-wildcard-ssl','aguardando-compra','LA-PC902-1')").run();
    db.prepare("UPDATE ssl_certificados SET pedidoCompraId = 901 WHERE id = ?").run(ids['cancelavel-comprado.test']);
    db.prepare("UPDATE ssl_certificados SET pedidoNicsrsId = 911 WHERE id = ?").run(ids['cancelavel-validacao.test']);

    frame = await abrirTela();
    const linhaDireto = await frame.evaluate(() =>
      [...document.querySelectorAll('#tb tr')].find(tr => tr.textContent.includes('cancelavel-comprado.test'))?.innerText || '');
    assert(/PC-TESTE-DIRETO/.test(linhaDireto), 'vínculo direto aparece na coluna', linhaDireto.slice(0,120));
    const linhaAssin = await frame.evaluate(() =>
      [...document.querySelectorAll('#tb tr')].find(tr => tr.textContent.includes('cancelavel-validacao.test'))?.innerText || '');
    assert(/PC-TESTE-ASSIN/.test(linhaAssin), 'vínculo via assinatura aparece na coluna (o caso do CREADF)',
      linhaAssin.slice(0,120));

    // Buscar pelo número do pedido é o caminho que o link da tela de compras usa.
    const achouPorNumero = await frame.evaluate(async () => {
      document.getElementById('fQ').value = 'PC-TESTE-ASSIN';
      await carregar();
      const linhas = [...document.querySelectorAll('#tb tr')];
      return { n: linhas.length, texto: linhas.map(t => t.innerText).join(' ') };
    });
    assert(achouPorNumero.n === 1 && /cancelavel-validacao/.test(achouPorNumero.texto),
      'buscar pelo número do pedido acha o certificado', JSON.stringify(achouPorNumero).slice(0,160));

    const achouPorOrdem = await frame.evaluate(async () => {
      document.getElementById('fQ').value = 'RC-BUSCA-TESTE';
      await carregar();
      return document.querySelectorAll('#tb tr').length;
    });
    db.prepare("UPDATE ssl_certificados SET orderNum = 'RC-BUSCA-TESTE' WHERE id = ?").run(ids['cancelavel-emitido.test']);
    const achouOrdem2 = await frame.evaluate(async () => {
      await carregar();
      const l = [...document.querySelectorAll('#tb tr')];
      return { n: l.length, texto: l.map(t => t.innerText).join(' ') };
    });
    assert(achouPorOrdem >= 0 && achouOrdem2.n === 1 && /cancelavel-emitido/.test(achouOrdem2.texto),
      'buscar pela ordem da NicSRS (RC…) acha o certificado', JSON.stringify(achouOrdem2).slice(0,160));

    await frame.evaluate(async () => { document.getElementById('fQ').value = ''; await carregar(); });
    db.prepare('DELETE FROM ssl_pedidos_nicsrs WHERE id = 911').run();
    db.prepare('DELETE FROM pedidos_compra WHERE id IN (901,902)').run();
    // Sem soltar os vínculos, a seção seguinte encontraria estes certificados
    // já amarrados e mediria a recusa por duplicidade em vez do que quer medir.
    db.prepare('UPDATE ssl_certificados SET pedidoCompraId = NULL, pedidoNicsrsId = NULL').run();

    secao('Vínculo manual de compra a pedido de compra');
    db.prepare("INSERT OR REPLACE INTO pedidos_compra (id, numero, status, dataEmissao, valorTotal) VALUES (903,'PC-VINC-ASSIN','enviado','2026-08-31',319.47)").run();
    db.prepare("INSERT OR REPLACE INTO pedidos_compra (id, numero, status, dataEmissao, valorTotal) VALUES (904,'PC-VINC-DIRETO','enviado','2026-08-31',1.86)").run();
    db.prepare("INSERT OR REPLACE INTO pedidos_compra (id, numero, status, dataEmissao, valorTotal) VALUES (905,'PC-VINC-CANCELADO','cancelado','2026-08-31',1.86)").run();
    // Assinatura esperando: o vínculo deve ir para ELA, não para o certificado.
    db.prepare("INSERT OR REPLACE INTO ssl_pedidos_nicsrs (id, pedidoCompraId, productCode, status, refId, dataCriacao) VALUES (912,903,'certum-dv-ssl','aguardando-compra','LA-PC903-1','2026-08-01 00:00:00')").run();
    db.prepare("UPDATE ssl_certificados SET orderNum='RC-VINC-1' WHERE id = ?").run(ids['cancelavel-emitido.test']);
    db.prepare("UPDATE ssl_certificados SET orderNum='RC-VINC-2' WHERE id = ?").run(ids['cancelavel-comprado.test']);

    frame = await abrirTela();
    const post = (id, pedidoCompraId) => frame.evaluate(async (id, pedidoCompraId) => {
      const r = await fetch(`/api/ssl/certificados/${id}/vincular-pedido-compra`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ pedidoCompraId }) });
      return { status: r.status, corpo: await r.json() };
    }, id, pedidoCompraId);

    const rCancelado = await post(ids['cancelavel-emitido.test'], 905);
    assert(rCancelado.status === 409 && /cancelado/.test(rCancelado.corpo.error || ''),
      'recusa vincular a pedido cancelado', JSON.stringify(rCancelado));

    const rAssin = await post(ids['cancelavel-emitido.test'], 903);
    assert(rAssin.corpo.success && rAssin.corpo.via === 'assinatura LA-PC903-1',
      'com assinatura esperando, o vínculo vai para ela', JSON.stringify(rAssin.corpo));
    const assinDepois = db.prepare('SELECT orderNum, status FROM ssl_pedidos_nicsrs WHERE id = 912').get();
    assert(assinDepois.orderNum === 'RC-VINC-1' && assinDepois.status === 'aguardando-dados',
      'a assinatura recebeu orderNum e saiu de aguardando-compra', JSON.stringify(assinDepois));
    const certDepois = db.prepare('SELECT pedidoNicsrsId, pedidoCompraId FROM ssl_certificados WHERE id = ?')
      .get(ids['cancelavel-emitido.test']);
    assert(certDepois.pedidoNicsrsId === 912 && certDepois.pedidoCompraId == null,
      'o certificado aponta para a assinatura, não direto para o pedido', JSON.stringify(certDepois));

    // Produto trocado: o pedido espera outra coisa. Tem de recusar, não cair no
    // vínculo direto — senão a assinatura fica pendente para sempre.
    db.prepare("INSERT OR REPLACE INTO pedidos_compra (id, numero, status, dataEmissao, valorTotal) VALUES (906,'PC-VINC-OUTRO','enviado','2026-08-31',61.6)").run();
    db.prepare("INSERT OR REPLACE INTO ssl_pedidos_nicsrs (id, pedidoCompraId, productCode, productName, status, refId, dataCriacao) VALUES (913,906,'certum-ov-wildcard-ssl','Certum Trusted Wildcard OV SSL','aguardando-compra','LA-PC906-1','2026-08-01 00:00:00')").run();
    const rTrocado = await post(ids['cancelavel-validacao.test'], 906);
    assert(rTrocado.status === 409 && /espera/.test(rTrocado.corpo.error || ''),
      'recusa vincular compra de produto diferente do que o pedido espera',
      JSON.stringify(rTrocado.corpo));
    assert(db.prepare('SELECT pedidoCompraId, pedidoNicsrsId FROM ssl_certificados WHERE id = ?')
      .get(ids['cancelavel-validacao.test']).pedidoCompraId == null,
      'a recusa não deixou vínculo pela metade');
    db.prepare('DELETE FROM ssl_pedidos_nicsrs WHERE id = 913').run();
    db.prepare('DELETE FROM pedidos_compra WHERE id = 906').run();

    const rRepetido = await post(ids['cancelavel-emitido.test'], 904);
    assert(rRepetido.status === 409 && /já está vinculado/.test(rRepetido.corpo.error || ''),
      'recusa vincular o que já tem pedido', JSON.stringify(rRepetido));

    const rDireto = await post(ids['cancelavel-comprado.test'], 904);
    assert(rDireto.corpo.success && rDireto.corpo.via === 'vínculo direto',
      'sem assinatura esperando, cai no vínculo direto', JSON.stringify(rDireto.corpo));
    assert(db.prepare('SELECT pedidoCompraId FROM ssl_certificados WHERE id = ?')
      .get(ids['cancelavel-comprado.test']).pedidoCompraId === 904, 'vínculo direto gravado');

    const evVinc = db.prepare("SELECT COUNT(*) n FROM ssl_certificados_eventos WHERE tipo = 'vinculo-pedido'").get();
    assert(evVinc.n === 2, `os dois vínculos deixaram evento (achou ${evVinc.n})`);

    // A lista de "sem vínculo" não pode mais oferecer os dois que já foram.
    const semVinc = await frame.evaluate(async () => {
      const r = await fetch('/api/ssl/compras-sem-vinculo');
      const d = await r.json();
      return (d.compras || []).map(c => c.orderNum);
    });
    assert(!semVinc.includes('RC-VINC-1') && !semVinc.includes('RC-VINC-2'),
      'compras já vinculadas somem da lista de pendentes', JSON.stringify(semVinc));

    db.prepare('DELETE FROM ssl_pedidos_nicsrs WHERE id = 912').run();
    db.prepare('DELETE FROM pedidos_compra WHERE id IN (903,904,905)').run();

    secao('Sincronização automática ao abrir');
    // Zera o que as seções acima consumiram: aqui o que se mede é uma abertura
    // limpa, não o acumulado do teste.
    db.prepare("DELETE FROM config WHERE chave = 'nicsrs_sync_auto_em'").run();
    chamadasList = 0;
    await abrirTela();
    assert(chamadasList === 1, `a abertura chamou ssl/list uma vez (chamou ${chamadasList})`);
    const antesDoThrottle = chamadasList;
    await abrirTela();
    assert(chamadasList === antesDoThrottle,
      'reabrir dentro da janela NÃO chama a NicSRS de novo', `chamadas: ${chamadasList}`);
    const carimbo = db.prepare("SELECT valor FROM config WHERE chave = 'nicsrs_sync_auto_em'").get();
    assert(!!carimbo && Number(carimbo.valor) > 0, 'carimbo da última sync gravado');

    secao('A sync traz compra nova e a tela mostra sozinha');
    db.prepare("DELETE FROM config WHERE chave = 'nicsrs_sync_auto_em'").run();
    listaNicsrs = [{
      certId: 'cert-CHEGOU-AGORA', productName: 'Certum Commercial DV SSL',
      productCode: 'certum-dv-ssl', brand: 'Certum', status: 'PENDING',
      period: '1year', created: '2026-08-31 10:00:00', beginDate: '2026-08-31 10:00:00',
      endDate: '2027-08-31 10:00:00', orderNum: 'RC-NOVO-123', amount: 1.86,
      commonName: 'chegou-sozinho.test', domains: ['chegou-sozinho.test'],
    }];
    frame = await abrirTela();
    await frame.waitForFunction(
      () => document.getElementById('tb').textContent.includes('chegou-sozinho.test'),
      { timeout: 8000 }).catch(() => {});
    const apareceu = await frame.evaluate(
      () => document.getElementById('tb').textContent.includes('chegou-sozinho.test'));
    assert(apareceu, 'a compra nova aparece na tela sem ninguém clicar em Importar');
    const avisoSync = await frame.$eval('#alertGlobal', el => el.textContent);
    assert(/compra\(s\) nova\(s\)/.test(avisoSync), 'a tela avisa que chegou algo novo',
      `alerta: "${avisoSync}"`);
    const novo = db.prepare("SELECT orderNum, certId FROM ssl_certificados WHERE commonName = 'chegou-sozinho.test'").get();
    assert(novo && novo.orderNum === 'RC-NOVO-123', 'orderNum veio junto (é o que correlaciona)',
      JSON.stringify(novo));
    listaNicsrs = [];

    secao('NicSRS fora do ar não quebra a tela');
    db.prepare("DELETE FROM config WHERE chave = 'nicsrs_sync_auto_em'").run();
    erroNoList = 'NicSRS ssl/list: falha de rede (timeout)';
    frame = await abrirTela();
    const listaViva = await frame.evaluate(() => document.querySelectorAll('#tb tr').length);
    assert(listaViva > 0, 'a lista continua renderizada mesmo com a NicSRS fora');
    const alertaSilencioso = await frame.$eval('#alertGlobal', el => el.style.display);
    assert(alertaSilencioso === 'none' || alertaSilencioso === '',
      'falha da sync não vira alerta vermelho', `display: "${alertaSilencioso}"`);
    erroNoList = null;

    secao('Onde o botão aparece');
    for (const c of CASOS) {
      const acoes = await acoesDaLinha(frame, c.cn);
      const temCancelar = (acoes || []).includes('Cancelar');
      const deveTer = !['cancelado', 'expirado', 'substituido'].includes(c.status);
      assert(temCancelar === deveTer,
        `${c.status}: botão ${deveTer ? 'presente' : 'ausente'}`,
        `ações vistas: ${JSON.stringify(acoes)}`);
    }

    secao('Desistir na confirmação não cancela nada');
    await armarDialogos(frame, { confirmar: false });
    await clicarCancelar(frame, 'cancelavel-emitido.test');
    await esperar(300);
    assert(chamadasCancel.length === 0, 'confirm=false não chama a NicSRS');
    assert(db.prepare('SELECT status FROM ssl_certificados WHERE id = ?')
      .get(ids['cancelavel-emitido.test']).status === 'emitido', 'status intacto após desistir');

    secao('Motivo vazio aborta');
    await armarDialogos(frame, { confirmar: true, motivo: '   ' });
    await clicarCancelar(frame, 'cancelavel-emitido.test');
    await esperar(300);
    assert(chamadasCancel.length === 0, 'motivo em branco não chama a NicSRS');
    assert(db.prepare('SELECT status FROM ssl_certificados WHERE id = ?')
      .get(ids['cancelavel-emitido.test']).status === 'emitido', 'status intacto com motivo vazio');
    const alerta = await frame.$eval('#alertGlobal', el => el.textContent);
    assert(/motivo é obrigatório/i.test(alerta), 'a tela explica por que abortou', `alerta: "${alerta}"`);

    secao('Fechar o prompt (Esc) aborta em silêncio');
    await armarDialogos(frame, { confirmar: true, motivo: null });
    await clicarCancelar(frame, 'cancelavel-emitido.test');
    await esperar(300);
    assert(chamadasCancel.length === 0, 'prompt cancelado não chama a NicSRS');

    secao('Cancelamento efetivo, com certId');
    await armarDialogos(frame, { confirmar: true, motivo: 'ordem de teste do robô' });
    await clicarCancelar(frame, 'cancelavel-emitido.test');
    await frame.waitForFunction(
      () => !/Carregando/.test(document.getElementById('tb').textContent), { timeout: 8000 });
    await esperar(400);
    assert(chamadasCancel.length === 1, 'a NicSRS foi chamada exatamente uma vez');
    assert(chamadasCancel[0]?.certId === 'cert-TESTE-1', 'certId correto foi para a NicSRS',
      JSON.stringify(chamadasCancel[0]));
    assert(chamadasCancel[0]?.reason === 'ordem de teste do robô', 'motivo digitado chegou à NicSRS',
      JSON.stringify(chamadasCancel[0]?.reason));
    const dep = db.prepare('SELECT status FROM ssl_certificados WHERE id = ?').get(ids['cancelavel-emitido.test']);
    assert(dep.status === 'cancelado', `status local virou cancelado (veio ${dep.status})`);

    secao('Rastro: evento e auditoria');
    const ev = db.prepare("SELECT * FROM ssl_certificados_eventos WHERE certificadoId = ? AND tipo = 'cancelamento'")
      .get(ids['cancelavel-emitido.test']);
    assert(!!ev, 'evento de cancelamento registrado');
    assert(ev && /ordem de teste do robô/.test(ev.descricao || ''), 'o motivo ficou no evento',
      ev && ev.descricao);
    const aud = db.prepare("SELECT * FROM audit_log WHERE entity = 'ssl-certificado' AND action = 'cancelar' ORDER BY id DESC").get();
    assert(!!aud, 'audit_log registrou o cancelamento');
    assert(aud && aud.username === 'testerobo', 'auditoria guardou quem cancelou', aud && aud.username);

    secao('Botão some depois de cancelar');
    frame = await abrirTela();
    const acoesDepois = await acoesDaLinha(frame, 'cancelavel-emitido.test');
    assert(!(acoesDepois || []).includes('Cancelar'), 'linha cancelada não oferece Cancelar de novo',
      JSON.stringify(acoesDepois));

    secao('Sem certId: cancela só localmente');
    chamadasCancel = [];
    await armarDialogos(frame, { confirmar: true, motivo: 'nunca foi comprado' });
    await clicarCancelar(frame, 'sem-certid.test');
    await frame.waitForFunction(
      () => !/Carregando/.test(document.getElementById('tb').textContent), { timeout: 8000 });
    await esperar(400);
    assert(chamadasCancel.length === 0, 'sem certId a NicSRS não é chamada');
    assert(db.prepare('SELECT status FROM ssl_certificados WHERE id = ?')
      .get(ids['sem-certid.test']).status === 'cancelado', 'status local virou cancelado mesmo assim');

    secao('A API recusa cancelar estado final (a tela não é a única porta)');
    chamadasCancel = [];
    for (const st of ['cancelado', 'expirado', 'substituido']) {
      const alvo = CASOS.find(c => c.status === st).cn;
      const resp = await frame.evaluate(async (id) => {
        const r = await fetch(`/api/ssl/certificados/${id}/cancelar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'tentativa direta na API' })
        });
        return { status: r.status, corpo: await r.json() };
      }, ids[alvo]);
      assert(resp.status === 409, `${st}: POST direto devolve 409`, JSON.stringify(resp));
      assert(/já está/.test(resp.corpo?.error || ''), `${st}: erro explica o motivo`,
        resp.corpo?.error);
    }
    assert(chamadasCancel.length === 0, 'nenhuma dessas tentativas chegou à NicSRS');

    secao('Erro da NicSRS não mente para o usuário');
    chamadasCancel = [];
    proximoErroNicsrs = 'NicSRS ssl/cancel: a autoridade certificadora recusou o pedido';
    frame = await abrirTela();
    await armarDialogos(frame, { confirmar: true, motivo: 'teste de falha' });
    await clicarCancelar(frame, 'cancelavel-comprado.test');
    await esperar(700);
    assert(chamadasCancel.length === 1, 'tentou chamar a NicSRS');
    const st = db.prepare('SELECT status FROM ssl_certificados WHERE id = ?').get(ids['cancelavel-comprado.test']);
    assert(st.status === 'comprado',
      `falha na NicSRS NÃO marca cancelado localmente (status ${st.status})`);
    const alertaErro = await frame.$eval('#alertGlobal', el => el.textContent);
    assert(/recusou/.test(alertaErro), 'o erro da NicSRS aparece na tela', `alerta: "${alertaErro}"`);
    proximoErroNicsrs = null;

    secao('Erros de JavaScript ao longo do fluxo');
    const fatais2 = errosJS.filter(NAO_E_RUIDO);
    assert(fatais2.length === 0, 'nenhum erro de JS durante as interações',
      fatais2.slice(0, 3).join('\n      '));
    errosJS.length = 0;
  }

  await browser.close();
  server.close();
  db.close();

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`${ok} passaram, ${fail} falharam  (${VOLTAS} volta(s))`);
  if (fail) {
    console.log('\nFalhas:');
    for (const f of [...new Set(falhas)]) console.log(`  · ${f}`);
  }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nERRO FATAL:', e.message);
  console.error(e.stack);
  server.close();
  process.exit(1);
});
