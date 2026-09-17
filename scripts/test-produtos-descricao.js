/**
 * Listagem de Produtos: a descrição é cortada na tela, nunca no dado.
 *
 * A coluna trunca com "…" para a tabela caber. O pedido (13/09/2026) foi manter
 * o corte e devolver a leitura: tooltip no computador, descrição inteira no
 * celular.
 *
 * ── O que este teste protege ────────────────────────────────────────────────
 *
 * Que o texto COMPLETO continue no DOM mesmo quando a tela mostra "…". É a
 * garantia que sustenta as duas pontas: se a descrição fosse cortada na
 * montagem (`.slice(0, 40)`), o tooltip mostraria o mesmo texto truncado e o
 * celular também — e ninguém perceberia, porque a tela continuaria parecendo
 * certa.
 *
 * Roda a tela real no Chrome, com hover de verdade. Verificar que existe um
 * atributo no HTML não provaria nada: `title=` está proibido nesta base
 * justamente porque o tooltip nativo do navegador atropela o nosso.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const TELA = path.join(PUB, 'catalogo/produtos.html');
const CHROME = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
  .find((p) => fs.existsSync(p));

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

/** Curta, longa, e duas quase iguais — o caso que motivou o pedido. */
// Longa o bastante para a coluna cortar mesmo numa tela larga — com poucos
// produtos a coluna estica e uma descrição de 80 caracteres ainda caberia,
// e o teste de corte não exercitaria nada.
const LONGA = 'MEIO TEMPERO COMPLETO COM AÇAFRÃO - FARDO COM 24 UNIDADES DE 400G CADA, '
            + 'LOTE ESPECIAL COM EMBALAGEM REFORÇADA PARA TRANSPORTE E ARMAZENAMENTO '
            + 'PROLONGADO EM AMBIENTE SECO E VENTILADO, VALIDADE DE 18 MESES';
const PARECIDA_A = 'MOLHO DE PIMENTA ARTESANAL EXTRA FORTE COM ALHO E ERVAS FINAS - FD 12UN 150ML';
const PARECIDA_B = 'MOLHO DE PIMENTA ARTESANAL EXTRA FORTE COM ALHO E ERVAS FINAS - FD 12UN 250ML';
const PRODUTOS = [
  { id: 1, sku: '3001', descricao: 'SAL', categoria: 'A', precoVenda: 5, saldo: 3, ativo: 1 },
  { id: 2, sku: '3066', descricao: LONGA, categoria: 'A', precoVenda: 42.5, saldo: 10, ativo: 1 },
  { id: 3, sku: '3070', descricao: PARECIDA_A, categoria: 'A', precoVenda: 18.9, saldo: 4, ativo: 1 },
  { id: 4, sku: '3071', descricao: PARECIDA_B, categoria: 'A', precoVenda: 19.9, saldo: 4, ativo: 1 },
  { id: 5, sku: '3080', descricao: 'ASPAS "E" <TAGS> & ÇÃO — ' + 'X'.repeat(120), categoria: 'B', precoVenda: 7, saldo: 1, ativo: 1 },
];

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function subirServidor() {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/produtos') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ success: true, produtos: PRODUTOS }));
    }
    if (url.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ success: true, produtos: [], pessoas: [], itens: [], total: 0 }));
    }
    if (url === '/__envelope') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>
        <iframe id="tela" src="/catalogo/produtos.html"></iframe>`);
    }
    const arq = path.join(PUB, url.replace(/^\//, ''));
    if (!arq.startsWith(PUB) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) {
      res.statusCode = 404; return res.end('x');
    }
    res.setHeader('Content-Type', TIPOS[path.extname(arq)] || 'application/octet-stream');
    res.end(fs.readFileSync(arq));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

let browser, srv, base;

async function abrir(largura = 1280) {
  const page = await browser.newPage();
  const erros = [];
  page.on('pageerror', (e) => erros.push(`${e.name}: ${e.message}`));
  await page.setViewport({ width: largura, height: 860, isMobile: largura < 700, hasTouch: largura < 700 });
  await page.goto(base + '/__envelope', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await new Promise((r) => setTimeout(r, 2500));
  const frame = await (await page.$('#tela')).contentFrame();
  if (!frame) throw new Error('a tela não carregou');
  return { page, frame, erros };
}

// ============================================================================
// A. O dado inteiro continua no DOM
// ============================================================================

t('A1. a descricao COMPLETA esta no DOM, mesmo cortada na tela', async () => {
  // A garantia central. Se um dia alguém "resolver" o corte truncando na
  // montagem, o tooltip passaria a mostrar o texto cortado e este teste cai.
  const { page, frame } = await abrir(1280);
  try {
    const r = await frame.evaluate((longa) => {
      const tds = [...document.querySelectorAll('#tb td[data-col="descricao"]')];
      const alvo = tds.find((x) => x.textContent.includes('MEIO TEMPERO'));
      return {
        n: tds.length,
        texto: alvo ? alvo.textContent.trim() : null,
        completo: alvo ? alvo.textContent.trim() === longa : false,
        // O corte é visual: o conteúdo é mais largo que a caixa.
        cortadoNaTela: alvo ? alvo.scrollWidth > alvo.clientWidth + 1 : false,
        ellipsis: alvo ? getComputedStyle(alvo).textOverflow : null,
      };
    }, LONGA);
    assert(r.n >= 5, `só ${r.n} célula(s) de descrição — a listagem não montou`);
    assert(r.completo, `a descrição no DOM não é a completa: "${r.texto}"`);
    assert(r.cortadoNaTela, 'a descrição longa não está sendo cortada — cenário inválido para o teste');
    assert(r.ellipsis === 'ellipsis', `a coluna deixou de usar reticências (${r.ellipsis})`);
  } finally { await page.close(); }
});

t('A2. nomes parecidos ficam distinguiveis pelo texto completo', async () => {
  const { page, frame } = await abrir(1280);
  try {
    const r = await frame.evaluate(() => {
      const tds = [...document.querySelectorAll('#tb td[data-col="descricao"]')]
        .map((x) => x.textContent.trim())
        .filter((x) => x.startsWith('MOLHO DE PIMENTA'));
      return { qtd: tds.length, iguais: tds.length === 2 && tds[0] === tds[1], textos: tds };
    });
    assert(r.qtd === 2, `esperava 2 descrições parecidas, achei ${r.qtd}`);
    assert(!r.iguais, 'as duas descrições parecidas chegaram idênticas ao DOM — o sufixo se perdeu');
    assert(r.textos.some((x) => x.endsWith('150ML')) && r.textos.some((x) => x.endsWith('250ML')),
      'o que distingue os dois produtos (150ML / 250ML) foi cortado: ' + JSON.stringify(r.textos));
  } finally { await page.close(); }
});

// ============================================================================
// B. Desktop: hover
// ============================================================================

t('B1. hover na descricao LONGA abre o tooltip com o texto inteiro', async () => {
  const { page, frame, erros } = await abrir(1280);
  try {
    const alvo = await frame.evaluateHandle(() =>
      [...document.querySelectorAll('#tb td[data-col="descricao"]')]
        .find((x) => x.textContent.includes('MEIO TEMPERO')));
    const el = alvo.asElement();
    assert(el, 'não achei a célula da descrição longa');
    await el.hover();                       // hover de VERDADE, não evento sintético
    await new Promise((r) => setTimeout(r, 350));

    const r = await frame.evaluate(() => {
      const t = document.querySelector('.tip-truncado');
      if (!t) return { existe: false };
      const c = t.getBoundingClientRect();
      const est = getComputedStyle(t);
      return {
        existe: true, visivel: t.classList.contains('visivel'),
        texto: t.textContent.trim(),
        opacidade: Number(est.opacity), zIndex: Number(est.zIndex),
        pointerEvents: est.pointerEvents,
        // `display` e área REAIS. Classe e opacidade não bastam: uma regra
        // `@media (hover: none) { display: none }` deixava o elemento marcado
        // como visível, com opacidade 1, medindo 0x0 — e o teste passava.
        display: est.display,
        dentroDaTela: c.left >= 0 && c.top >= 0
          && c.right <= window.innerWidth + 1 && c.bottom <= window.innerHeight + 1,
        largura: Math.round(c.width), altura: Math.round(c.height),
      };
    });
    assert(r.existe, 'o tooltip não foi criado no hover');
    assert(r.visivel && r.opacidade > 0.9, `o tooltip não ficou visível (opacidade ${r.opacidade})`);
    assert(r.display !== 'none', 'o tooltip está com display:none — marcado como visível mas não desenhado');
    assert(r.largura > 40 && r.altura > 12,
      `o tooltip mede ${r.largura}x${r.altura} — não há balão nenhum na tela`);
    assert(r.texto === LONGA, `o tooltip mostra texto truncado: "${r.texto}"`);
    assert(r.zIndex >= 1000, `z-index ${r.zIndex} — ficaria atrás de outros elementos`);
    assert(r.pointerEvents === 'none', 'o tooltip captura o mouse e piscaria');
    assert(r.dentroDaTela, `o tooltip saiu da janela (${r.largura}x${r.altura})`);
    assert(erros.length === 0, 'exceção no hover: ' + erros.join(' | '));
  } finally { await page.close(); }
});

t('B2. descricao CURTA nao abre tooltip', async () => {
  // "não deve mostrar tooltip desnecessário quando o texto já couber".
  const { page, frame } = await abrir(1280);
  try {
    const alvo = await frame.evaluateHandle(() =>
      [...document.querySelectorAll('#tb td[data-col="descricao"]')]
        .find((x) => x.textContent.trim() === 'SAL'));
    const el = alvo.asElement();
    assert(el, 'não achei a célula com descrição curta');
    await el.hover();
    await new Promise((r) => setTimeout(r, 350));
    const visivel = await frame.evaluate(() => {
      const t = document.querySelector('.tip-truncado');
      return !!(t && t.classList.contains('visivel'));
    });
    assert(!visivel, 'apareceu tooltip numa descrição que já cabe inteira na célula');
  } finally { await page.close(); }
});

t('B3. sair da celula esconde o tooltip', async () => {
  const { page, frame } = await abrir(1280);
  try {
    const longa = await frame.evaluateHandle(() =>
      [...document.querySelectorAll('#tb td[data-col="descricao"]')]
        .find((x) => x.textContent.includes('MEIO TEMPERO')));
    await longa.asElement().hover();
    await new Promise((r) => setTimeout(r, 300));
    const antes = await frame.evaluate(() =>
      !!document.querySelector('.tip-truncado.visivel'));
    assert(antes, 'o tooltip não abriu — cenário inválido');

    const outro = await frame.evaluateHandle(() => document.getElementById('filtBusca'));
    await outro.asElement().hover();
    await new Promise((r) => setTimeout(r, 300));
    const depois = await frame.evaluate(() =>
      !!document.querySelector('.tip-truncado.visivel'));
    assert(!depois, 'o tooltip continuou na tela depois de o mouse sair da célula');
  } finally { await page.close(); }
});

t('B4. nao usa title (o nativo se sobrepoe ao nosso)', () => {
  const src = fs.readFileSync(TELA, 'utf8');
  const semCom = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Na CÉLULA de descrição. Os `title` de botões de ação (Abrir produto) são
  // anteriores e não estão em disputa com tooltip nenhum.
  assert(!/data-col="descricao"[^>]*\btitle=/.test(semCom),
    'a célula de descrição voltou a emitir title — o balão nativo cobriria o nosso');
  assert(/class = 'tip-truncado'|className = 'tip-truncado'/.test(semCom),
    'a tela não usa o componente .tip-truncado do CSS global');
});

// ============================================================================
// C. Mobile: sem hover, a descrição vem inteira
// ============================================================================

for (const w of [320, 360, 375, 390, 430]) {
  t(`C. em ${w}px a descricao aparece inteira, sem overflow novo`, async () => {
    const { page, frame } = await abrir(w);
    try {
      const r = await frame.evaluate((longa) => {
        const doc = document.documentElement;
        const td = [...document.querySelectorAll('#tb td[data-col="descricao"]')]
          .find((x) => x.textContent.includes('MEIO TEMPERO'));
        if (!td) return { erro: 'célula não encontrada' };
        const est = getComputedStyle(td);
        return {
          texto: td.textContent.trim(),
          completo: td.textContent.trim() === longa,
          quebra: est.whiteSpace,           // 'normal' = quebra em várias linhas
          cortado: td.scrollWidth > td.clientWidth + 1,
          linhas: Math.round(td.getBoundingClientRect().height),
          estouroPagina: doc.scrollWidth - doc.clientWidth,
          // Os botões de ação continuam alcançáveis.
          temEditar: !!document.querySelector('#tb .col-editar button'),
          temExcluir: [...document.querySelectorAll('#tb button')]
            .some((b) => /excluir/i.test(b.textContent)),
        };
      }, LONGA);
      assert(!r.erro, r.erro);
      assert(r.completo, 'a descrição no DOM não é a completa no celular');
      assert(r.quebra === 'normal',
        `em ${w}px a descrição continua em uma linha só (white-space: ${r.quebra})`);
      assert(!r.cortado, `em ${w}px a descrição ainda está sendo cortada`);
      assert(r.linhas > 20, `em ${w}px a célula tem ${r.linhas}px — não quebrou em várias linhas`);
      // A tabela rola dentro do próprio quadro; a PÁGINA não pode estourar.
      assert(r.estouroPagina <= 1, `em ${w}px a página estourou ${r.estouroPagina}px`);
      assert(r.temEditar, `em ${w}px o botão de editar sumiu`);
      assert(r.temExcluir, `em ${w}px o botão de excluir sumiu`);
    } finally { await page.close(); }
  });
}

// ============================================================================
// D. Nada mais mudou
// ============================================================================

t('D1. a busca continua filtrando a listagem', async () => {
  const { page, frame } = await abrir(1280);
  try {
    const r = await frame.evaluate(async () => {
      const linhas = () => document.querySelectorAll('#tb tr').length;
      const antes = linhas();
      const b = document.getElementById('filtBusca');
      b.value = 'MOLHO';
      b.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((s) => setTimeout(s, 900));
      return { antes, depois: linhas(), valor: b.value };
    });
    // A busca desta tela consulta a API; o servidor de teste devolve a lista
    // toda. O que se verifica é que o caminho continua vivo e não quebrou.
    assert(r.antes > 0, 'a listagem não montou');
    assert(r.depois > 0, 'a busca esvaziou a listagem — o caminho quebrou');
    assert(r.valor === 'MOLHO', 'o campo de busca perdeu o texto digitado');
  } finally { await page.close(); }
});

t('D2. a descricao NAO e truncada na montagem (so na tela)', () => {
  const src = fs.readFileSync(TELA, 'utf8');
  const semCom = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Um `.slice()` na descrição da LISTAGEM cortaria o dado, e aí nem o tooltip
  // nem o celular teriam o texto inteiro para mostrar.
  const render = /function renderCell\([\s\S]*?\n\}/.exec(semCom);
  assert(render, 'renderCell sumiu');
  assert(!/descricao[^\n]*\.(slice|substring)\(/.test(render[0]),
    'a descrição passou a ser cortada na montagem — o dado se perderia');
});

t('D2b. nenhum nome global da tela colide com o sidebar.js', () => {
  // ── O defeito que este teste existe para impedir ────────────────────────
  //
  // A primeira versão desta correção declarou `let _tipEl`, nome que o
  // /js/sidebar.js JÁ declara no escopo global. Duas declarações `let` do
  // mesmo nome no mesmo escopo são `SyntaxError: Identifier '_tipEl' has
  // already been declared` — e isso não derruba só o tooltip: **derruba o
  // script inteiro da tela**, que ficou sem listagem nenhuma.
  //
  // O `verify` não pega: cada arquivo, sozinho, parseia perfeitamente. A
  // colisão só existe quando os dois são carregados juntos.
  const tela = fs.readFileSync(TELA, 'utf8');
  const sb = fs.readFileSync(path.join(PUB, 'js/sidebar.js'), 'utf8');

  const topoDe = (src) => {
    const nomes = new Set();
    // Só declarações na coluna 0: as indentadas estão dentro de função ou
    // bloco e não disputam o escopo global.
    for (const m of src.matchAll(/^(?:let|const|var)\s+([A-Za-z_$][\w$]*)/gm)) nomes.add(m[1]);
    for (const m of src.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) nomes.add(m[1]);
    return nomes;
  };
  const daTela = topoDe(tela.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
  const doSb = topoDe(sb.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));

  const colisoes = [...daTela].filter((n) => doSb.has(n));
  assert(colisoes.length === 0,
    'nome declarado nos dois arquivos — `let` duplicado é SyntaxError e derruba a tela: '
    + colisoes.join(', '));
});

t('D3. o componente do tooltip vive no CSS global, nao solto na tela', () => {
  const css = fs.readFileSync(path.join(PUB, 'css/app-modern.css'), 'utf8');
  assert(/\.tip-truncado \{/.test(css), 'o estilo do tooltip saiu do CSS global');
  assert(/pointer-events: none/.test(/\.tip-truncado \{[^}]*\}/.exec(css)[0]),
    'o tooltip pode roubar o mouse e piscar');
  // Nada de desligar por media query de hover: ela casa em laptop com tela
  // sensível ao toque (e no Chrome headless), escondendo o balão justamente
  // onde ele deve funcionar. Quem decide é `estaTruncado()`.
  assert(!/@media \(hover: none\)[\s\S]{0,140}\.tip-truncado \{[^}]*display: none/.test(css),
    'o tooltip voltou a ser escondido por media query de hover');
  const tela = fs.readFileSync(TELA, 'utf8');
  assert(!/\.tip-truncado\s*\{/.test(tela), 'o estilo foi duplicado dentro da tela');
});

(async () => {
  if (!CHROME) {
    console.log('  Chrome ausente — teste da listagem de produtos não pode rodar');
    console.log('\n0 ok, 0 falha(s) (pulado)');
    process.exit(0);
  }
  srv = await subirServidor();
  base = `http://127.0.0.1:${srv.address().port}`;
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  await browser.close();
  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
