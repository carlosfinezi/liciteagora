/**
 * test-pecas-carregadas.js — a tela que USA uma peça comum CARREGA o arquivo dela.
 *
 * Em 01/10/2026 isso falhou duas vezes, nos dois sentidos, e ninguém viu:
 *
 *  - o 9afb2bb tirou o `toast()` local de `classificacao-fiscal/fiscal-common.js`
 *    contando com o `window.toast` da peça, e o 72d4fa1 tirou o `<script>` das
 *    três telas que carregam esse arquivo — `toast(...)` virou **ReferenceError**
 *    nas três, em produção;
 *  - o mesmo 72d4fa1 tirou o `<script>` de `operacional/lances.html` revertendo
 *    só 2 dos 17 `Aviso.*` dela (os outros 15 vinham em hunk misto), e a tela de
 *    lance ficou com ReferenceError em cada botão de enviar.
 *
 * O commit do revert já nomeava o risco — `pcp-salas.html` e
 * `conciliacao-bancaria.html` ficaram com o `<script>` "de propósito, senão
 * ReferenceError" — mas a conferência era de olho, arquivo por arquivo.
 *
 * O que esta suíte mede é o FIO, e no navegador: a tela usa a peça, e a peça
 * está lá quando a tela abre? Grep não responde isso, porque o uso pode estar
 * num `.js` que a tela carrega (o `fiscal-common.js` é justamente esse caso) e
 * o provedor pode ser outro arquivo (a landing define `window.toast` no
 * `landing.js` dela, e está certa).
 *
 * Roda da raiz do projeto: node scripts/test-pecas-carregadas.js
 */
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const express = require(path.join(RAIZ, 'node_modules', 'express'));
const puppeteer = require(path.join(RAIZ, 'node_modules', 'puppeteer-core'));

const PORTA = Number(process.env.PORTA_TESTE || 39921);
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const PUBLICO = path.join(RAIZ, 'public');

/**
 * `public/loja/` fica fora: a vitrine não carrega a camada do ERP e hoje tem a
 * cópia própria das máscaras, por decisão registrada no CLAUDE.md ("reaplicar a
 * extração da peça de campo na loja" espera o fim da frente do Cantinho Verde).
 */
const FORA = (rel) => rel.startsWith('loja/');

/**
 * `catalogo/loja-montagem.html` usa `data-formato` para OUTRA coisa: o formato
 * do buquê montável, num `<div>`. A peça só olha `input`/`select`/`textarea`,
 * e é por isso que a colisão de nome não faz mal — mas o levantamento aqui
 * precisa saber dela.
 */
const OUTRO_SENTIDO = new Set(['catalogo/loja-montagem.html']);

let falhas = 0, total = 0;
const problemas = [];
function checa(rotulo, condicao, detalhe = '') {
  total++;
  if (condicao) return;
  falhas++;
  problemas.push(`${rotulo}${detalhe ? ' — ' + detalhe : ''}`);
}

function telas(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['img', 'uploads', 'downloads', 'extensions', 'vendor', 'icons'].includes(e.name)) continue;
      telas(p, acc);
    } else if (e.name.endsWith('.html')) acc.push(path.relative(PUBLICO, p));
  }
  return acc;
}

/**
 * Todo o JavaScript que a tela traz: o inline mais os `src` locais.
 *
 * Sem os `src` locais esta suíte não enxergaria o caso que a motivou — quem
 * chama `toast()` é o `fiscal-common.js`, e o HTML das três telas de
 * classificação fiscal não tem uma única menção à palavra.
 */
function javascriptDaTela(rel) {
  const arq = path.join(PUBLICO, rel);
  const html = fs.readFileSync(arq, 'utf8');
  let js = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
    const src = m[1];
    if (/^https?:|^\/\//.test(src)) continue;
    const alvo = src.startsWith('/')
      ? path.join(PUBLICO, src.slice(1))
      : path.join(path.dirname(arq), src);
    if (fs.existsSync(alvo) && alvo.endsWith('.js')) js += '\n' + fs.readFileSync(alvo, 'utf8');
  }
  return { html, js };
}

/** Tira comentário de linha e de bloco: menção em comentário não quebra nada. */
function semComentario(js) {
  return js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

(async () => {
  const app = express();
  app.get('/api/features/status', (_q, s) => s.json({ features: {} }));
  app.get('/api/perfis/meu-acesso', (_q, s) => s.json({ irrestrito: true, acessos: {} }));
  app.all('/api/*splat', (_q, s) => s.json({ success: true, dados: [], itens: [] }));
  // A landing é servida com a pasta dela na raiz (é assim em produção).
  /**
   * A alavanca da prova por sabotagem: `ANTES=<dir>` serve a tela daquele
   * diretório quando ela existir lá, e de `public/` no resto. É assim que se
   * mede se esta suíte reprova o defeito que a motivou — as quatro telas que o
   * 72d4fa1 deixou chamando `toast()`/`Aviso.*` sem o arquivo — sem escrever
   * nada na árvore, que aqui É a produção.
   */
  if (process.env.ANTES) {
    const ANTES = process.env.ANTES;
    console.log(`(telas de ${ANTES} quando existirem lá — rodada de sabotagem)\n`);
    app.use((q, s, prox) => {
      if (!q.path.endsWith('.html')) return prox();
      const alt = path.join(ANTES, decodeURI(q.path).replace(/^\//, ''));
      if (!fs.existsSync(alt)) return prox();
      s.type('html').send(fs.readFileSync(alt, 'utf8'));
    });
  }
  /**
   * `index.html` existe em DOIS lugares: `public/index.html` é o painel do ERP
   * e `public/landing/index.html` é a landing. Em produção quem escolhe é o
   * HOST — a landing responde só no apex (`apexOnly`, em `landing-routes.js`),
   * e no host do tenant `/index.html` é o painel. Com a landing montada na
   * raiz aqui, a medição de `index.html` abria a landing: título "ERP completo
   * para empresas que vivem de licitações", `/landing.js` como único script, e
   * `window.Aviso` ausente com razão, porque a landing tem o toast dela. A
   * checagem reprovava uma tela que não era a medida. Esta rota devolve o
   * painel; a landing continua medida pelo caminho dela.
   */
  app.get('/index.html', (_q, s) => s.sendFile(path.join(PUBLICO, 'index.html')));
  app.use(express.static(path.join(PUBLICO, 'landing')));
  app.use(express.static(path.join(PUBLICO, 'auth')));
  app.use(express.static(PUBLICO));
  const srv = app.listen(PORTA);

  /* --- quem usa o quê, lido do JavaScript que a tela traz --- */
  const usos = [];
  for (const rel of telas(PUBLICO)) {
    if (FORA(rel)) continue;
    const { html, js } = javascriptDaTela(rel);
    const limpo = semComentario(js);
    const usa = {
      Aviso: /\bAviso\s*\.\s*\w/.test(limpo),
      toast: /\btoast\s*\(/.test(limpo),
      CampoFormato: /\bCampoFormato\s*\.\s*\w/.test(limpo)
        // Campo de dado declarado por atributo: a peça é quem o faz funcionar.
        || (!OUTRO_SENTIDO.has(rel)
            && /<(?:input|select|textarea)\b[^>]*\bdata-formato="/.test(html)),
    };
    if (usa.Aviso || usa.toast || usa.CampoFormato) usos.push({ rel, usa });
  }
  const soEsta = process.env.TELA;
  if (soEsta) usos.splice(0, usos.length, ...usos.filter((u) => u.rel === soEsta));
  console.log(`telas que usam alguma peça comum: ${usos.length}\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    userDataDir: `/tmp/pecas-carregadas-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  const DENTRO_DO_SHELL = (t) => !/^(landing|portal|auth)\//.test(t);
  const naoMedidas = [];

  try {
    for (const { rel, usa } of usos) {
      const page = await browser.newPage();
      // Abrir a tela não pode disparar caixa nenhuma, e uma caixa pendurada
      // trava a medição inteira (ver a memória do alert() em headless).
      page.on('dialog', async (d) => { try { await d.dismiss(); } catch (e) { /* já foi */ } });
      try {
        if (DENTRO_DO_SHELL(rel)) await page.evaluateOnNewDocument(() => { window.__liciteShell = true; });
        await page.setViewport({ width: 1280, height: 800 });
        const pedida = `http://127.0.0.1:${PORTA}/${encodeURI(rel)}`;
        await page.goto(pedida, { waitUntil: 'load', timeout: 20000 });
        await new Promise((r) => setTimeout(r, 400));
        /* O painel de super-admin manda para a própria tela de login sem
           sessão: medir ali seria medir OUTRA tela, e foi o que fez esta suíte
           acusar `auth/admin/index.html` de usar `toast` sem o arquivo — ela
           carrega o `aviso-sistema.js`, e quem não carrega é o login. */
        if (!page.url().startsWith(pedida)) {
          console.log(`\n  (${rel}: foi para ${page.url().replace(`http://127.0.0.1:${PORTA}`, '')} — exige sessão, não medida)`);
          naoMedidas.push(rel);
          await page.close();
          continue;
        }
        const tem = await page.evaluate(() => ({
          Aviso: typeof window.Aviso === 'object' && window.Aviso !== null,
          toast: typeof window.toast === 'function',
          CampoFormato: typeof window.CampoFormato === 'object' && window.CampoFormato !== null,
        }));
        for (const peca of ['Aviso', 'toast', 'CampoFormato']) {
          if (!usa[peca]) continue;
          checa(`${rel}: usa ${peca} e ele existe quando a tela abre`, tem[peca],
            `window.${peca} é ${tem[peca] ? 'ok' : 'ausente'}`);
        }
      } catch (e) {
        checa(`${rel}: a tela abre`, false, String(e.message).slice(0, 90));
      }
      await page.close();
      process.stdout.write('.');
    }
  } finally {
    await browser.close();
    srv.close();
  }

  console.log('\n');
  if (problemas.length) {
    console.log('PROBLEMAS:');
    for (const p of problemas) console.log('  ' + p);
    console.log('');
  }
  if (naoMedidas.length) console.log(`não medidas (exigem sessão): ${naoMedidas.join(', ')}`);
  console.log(`${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens em ${usos.length - naoMedidas.length} de ${usos.length} telas`);
  process.exit(falhas ? 1 : 0);
})();
