/**
 * Venda rápida: a grade SEMPRE sai do estado de carregamento.
 *
 * ── O defeito ───────────────────────────────────────────────────────────────
 *
 * Relatado em 12/09/2026, no computador e no celular: a tela abre, as
 * categorias aparecem com as contagens, e a área dos produtos fica
 * indefinidamente com os esqueletos cinza. Sem erro na tela, sem botão, sem
 * saída.
 *
 * ── Por que nenhum teste pegava ─────────────────────────────────────────────
 *
 * O `verify` pergunta se o arquivo parseia, e ele parseia. As suítes de PDV
 * existentes leem o código à procura de padrões. Nenhuma delas RODAVA a tela
 * com uma resposta hostil da API — e o esqueleto infinito só nasce do que a
 * resposta faz, não do que o código diz.
 *
 * Este teste sobe a tela real no Chrome e responde `/api/produtos` de cinco
 * formas diferentes, incluindo uma que NUNCA responde. A regra é uma só, e vale
 * para todas: **a grade não pode terminar com um `.skel` na tela**. Ou cards, ou
 * "nenhum produto", ou erro com botão de tentar de novo.
 *
 * Os produtos são os do tenant `produtosbomgosto`, lido em modo somente-leitura
 * — o catálogo que o usuário tinha na mão quando o defeito apareceu.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const TELA = path.join(PUB, 'comercial/pedidos-pdv.html');
const CHROME = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
  .find((p) => fs.existsSync(p));

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

/**
 * Catálogo real do tenant do relato; se o banco não estiver aqui, um substituto
 * com a mesma forma. O teste não pode depender de um tenant existir.
 */
function catalogo() {
  const db = path.join(RAIZ, 'data/tenants/produtosbomgosto/pncp.db');
  if (fs.existsSync(db)) {
    try {
      const js = execFileSync('sqlite3', ['-json', `file:${db}?mode=ro`,
        'SELECT id, sku, descricao, categoria, precoVenda, imagemPath, ativo FROM produtos WHERE ativo=1 LIMIT 80;'
      ]).toString().trim();
      const arr = JSON.parse(js || '[]');
      if (arr.length) return arr.map((p) => ({ ...p, saldo: 10 }));
    } catch (_) { /* cai no substituto */ }
  }
  return Array.from({ length: 12 }, (_, i) => ({
    id: i + 1, sku: String(3000 + i), descricao: `PRODUTO DE TESTE ${i + 1}`,
    categoria: i % 3 === 0 ? null : 'MERCEARIA', precoVenda: 10 + i, imagemPath: null,
    ativo: 1, saldo: 5,
  }));
}
const PRODUTOS = catalogo();

/** Produtos que já derrubaram a grade inteira, e os que poderiam derrubar. */
const HOSTIS = [
  // O que causava o TypeError: categoria numérica, e `.trim()` não existe em
  // número. A coluna é TEXT, mas o SQLite guarda o que lhe derem.
  { id: 90001, sku: 'X1', descricao: 'CATEGORIA NUMERICA', categoria: 123, precoVenda: 9.9, ativo: 1, saldo: 1 },
  { id: 90002, sku: null, descricao: null, categoria: null, precoVenda: null, imagemPath: null, ativo: 1, saldo: null },
  { id: 90003, sku: 'X3', descricao: '', categoria: '  ', precoVenda: 'abc', ativo: 1, saldo: 'x' },
  { id: 90004, sku: 'X4', descricao: 'IMAGEM QUEBRADA', imagemPath: '/nao/existe.png', categoria: 'A', precoVenda: 1, ativo: 1, saldo: 1 },
  { id: 90005, sku: 'X5', descricao: 'ASPAS "E" <TAGS> & ÇÃO ' + 'M'.repeat(220), categoria: 'A', precoVenda: 2, ativo: 1, saldo: 1 },
];

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

/**
 * Servidor local. `cenario` decide o que `/api/produtos` responde.
 * Porta efêmera: subir na porta de produção para testar é proibido aqui.
 */
function subirServidor(estado) {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/produtos') {
      res.setHeader('Content-Type', 'application/json');
      const c = estado.cenario;
      if (c === 'pendurado') return;                       // nunca responde
      if (c === 'vazio')  return res.end(JSON.stringify({ success: true, produtos: [] }));
      if (c === 'erro') { res.statusCode = 500; return res.end(JSON.stringify({ success: false, error: 'falha interna' })); }
      if (c === 'lixo')   return res.end('<html>não é json</html>');
      if (c === 'semCampo') return res.end(JSON.stringify({ success: true }));   // sem `produtos`
      const lista = c === 'hostis' ? PRODUTOS.concat(HOSTIS) : PRODUTOS;
      return res.end(JSON.stringify({ success: true, produtos: lista }));
    }
    if (url.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ success: true, pedidos: [], itens: [], pessoas: [], total: 0 }));
    }
    if (url === '/__envelope') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>
        <iframe id="tela" src="/comercial/pedidos-pdv.html"></iframe>`);
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

let browser, srv, estado, base;

/** Abre a Venda rápida no cenário pedido e devolve o que ficou na tela. */
async function abrir(cenario, largura = 1280, esperaMs = 3000) {
  estado.cenario = cenario;
  const page = await browser.newPage();
  const erros = [];
  page.on('pageerror', (e) => erros.push(`${e.name}: ${e.message}`));
  try {
    await page.setViewport({ width: largura, height: 860, isMobile: largura < 700, hasTouch: largura < 700 });
    await page.goto(base + '/__envelope', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise((r) => setTimeout(r, esperaMs));
    const frame = await (await page.$('#tela')).contentFrame();
    if (!frame) throw new Error('a tela não carregou');
    const r = await frame.evaluate(() => {
      const g = document.getElementById('grade');
      const doc = document.documentElement;
      const cards = [...document.querySelectorAll('#grade .card-prod')];
      const skel = document.querySelector('#grade .skel');
      return {
        skeletons: document.querySelectorAll('#grade .skel').length,
        cards: cards.length,
        // ── Geometria, não só contagem ──────────────────────────────────
        // Contar `.card-prod` no DOM NÃO prova que alguém os vê. Em 13/09 os
        // 76 cards existiam e estavam achatados a 15px de altura, com a foto
        // em 0 — na tela, tiras cinza idênticas aos esqueletos. O teste
        // passava e o usuário via o defeito.
        alturaCard: cards.length ? Math.round(cards[0].getBoundingClientRect().height) : 0,
        alturaFoto: cards.length && cards[0].querySelector('.foto')
          ? Math.round(cards[0].querySelector('.foto').getBoundingClientRect().height) : 0,
        alturaSkel: skel ? Math.round(skel.getBoundingClientRect().height) : 0,
        // Um card precisa mostrar preço e nome com área de verdade.
        precoVisivel: cards.length ? (() => {
          const p = cards[0].querySelector('.preco');
          const c = p && p.getBoundingClientRect();
          return !!(c && c.height > 8 && c.width > 8 && p.textContent.trim());
        })() : false,
        rolagem: g ? g.scrollHeight : 0,
        estados: [...document.querySelectorAll('#grade .estado .tit')].map((e) => e.textContent.trim()),
        sub: [...document.querySelectorAll('#grade .estado .sub')].map((e) => e.textContent.trim()).join(' | '),
        temBotaoRetry: !![...document.querySelectorAll('#grade .estado button')]
          .find((b) => /tentar novamente/i.test(b.textContent)),
        cats: document.querySelectorAll('#cats .cat-item').length,
        estouro: doc.scrollWidth - doc.clientWidth,
        gradeVazia: !g || !g.innerHTML.trim(),
      };
    });
    return { ...r, erros };
  } finally { await page.close(); }
}

/** A regra que vale para TODOS os cenários. */
function exigirDesfecho(r, cenario) {
  assert(r.skeletons === 0, `${cenario}: a grade ficou com ${r.skeletons} esqueleto(s) — loading infinito`);
  assert(!r.gradeVazia, `${cenario}: a grade terminou vazia, sem cards e sem mensagem`);
  assert(r.cards > 0 || r.estados.length > 0,
    `${cenario}: nem cards nem mensagem — o usuário fica sem saber o que houve`);
}

// ============================================================================
// A. Todo cenário termina — nenhum deixa esqueleto
// ============================================================================

t('A1. resposta normal: os cards aparecem e o esqueleto some', async () => {
  const r = await abrir('normal');
  exigirDesfecho(r, 'normal');
  assert(r.cards === PRODUTOS.length, `esperava ${PRODUTOS.length} cards, veio ${r.cards}`);
  assert(r.cats >= 2, `só ${r.cats} categoria(s) — "Todos" mais as do catálogo deveriam estar lá`);
  assert(r.erros.length === 0, 'exceção não tratada: ' + r.erros.join(' | '));
});

t('A1b. os cards sao VISIVEIS, nao tiras achatadas', async () => {
  // ── O defeito que passou pelo teste anterior ────────────────────────────
  //
  // Os 76 cards existiam no DOM e o teste os contava: passava verde. Na tela,
  // cada um tinha 15px de altura e a foto 0px — o `aspect-ratio: 1/1` não
  // resolvia contra a linha do grid, e o `overflow: hidden` cortava o resto.
  // O resultado eram tiras cinza empilhadas, do mesmo tom dos esqueletos.
  //
  // Contagem no DOM não é evidência de que alguém vê. Aqui se mede geometria.
  const r = await abrir('normal');
  assert(r.alturaCard >= 120,
    `card com ${r.alturaCard}px de altura — achatado, o usuário vê uma tira cinza`);
  assert(r.alturaFoto >= 80,
    `a área da foto tem ${r.alturaFoto}px — o aspect-ratio não resolveu`);
  assert(r.precoVisivel, 'o preço não tem área na tela — o card não é legível');
  // Um card tem de ser bem mais alto que uma linha de texto.
  assert(r.alturaCard > 8 * 15, `card de ${r.alturaCard}px é fino demais para conter foto + preço + nome`);
  // Com dezenas de produtos a grade precisa ROLAR; se tudo "coube" sem
  // rolagem, é porque as linhas foram espremidas.
  assert(r.rolagem > 1000,
    `a grade inteira coube em ${r.rolagem}px com ${r.cards} produtos — as linhas foram comprimidas`);
});

t('A1c. o card carregado NAO se parece com o esqueleto', async () => {
  // Os dois são cinza e do mesmo formato; o que os distingue é o tamanho e o
  // texto. Se o card ficar da altura do esqueleto, ninguém percebe que
  // carregou — foi exatamente o relato "continua mostrando skeletons".
  const skel = await abrir('pendurado', 1280, 2000);   // ainda carregando
  const cheio = await abrir('normal');
  assert(skel.alturaSkel > 100, `o esqueleto mede ${skel.alturaSkel}px — cenário inválido`);
  assert(cheio.alturaCard >= skel.alturaSkel * 0.9,
    `card (${cheio.alturaCard}px) muito menor que o esqueleto (${skel.alturaSkel}px): ` +
    'na tela a grade carregada parece continuar carregando');
});

t('A2. catalogo vazio: mensagem propria, nao esqueleto', async () => {
  const r = await abrir('vazio');
  exigirDesfecho(r, 'vazio');
  assert(r.cards === 0, 'apareceram cards com catálogo vazio');
  assert(/nenhum produto cadastrado/i.test(r.estados.join(' ')),
    'não avisa que o catálogo está vazio: ' + r.estados.join(' '));
});

t('A3. erro 500 da API: mensagem em portugues e botao de tentar novamente', async () => {
  const r = await abrir('erro');
  exigirDesfecho(r, 'erro');
  assert(/não foi possível carregar/i.test(r.estados.join(' ')), 'sem mensagem de erro compreensível');
  assert(r.temBotaoRetry, 'sem botão "Tentar novamente" — o usuário fica sem saída');
  // Nada de vocabulário de máquina na tela.
  const tela = (r.estados.join(' ') + ' ' + r.sub).toLowerCase();
  for (const proibido of ['load failed', 'failed to fetch', 'typeerror', 'referenceerror',
                          'undefined', 'null', 'stack', 'http 500']) {
    assert(!tela.includes(proibido), `mensagem técnica vazou para a tela: "${proibido}" em "${r.sub}"`);
  }
});

t('A4. resposta que NUNCA chega: o relogio corta e a tela sai do loading', async () => {
  // Este é o cenário do relato. Sem o `AbortController`, a promessa nunca
  // assenta e o esqueleto fica na tela para sempre — sem erro no console e sem
  // nada em que clicar.
  const r = await abrir('pendurado', 1280, 16000);
  exigirDesfecho(r, 'pendurado');
  assert(r.temBotaoRetry, 'sem botão para tentar de novo depois do tempo esgotado');
  assert(/demorou|conexão/i.test(r.sub), 'a mensagem não explica que o servidor não respondeu: ' + r.sub);
});

t('A5. resposta que nao e JSON: nao deixa esqueleto', async () => {
  const r = await abrir('lixo');
  exigirDesfecho(r, 'lixo');
  assert(r.temBotaoRetry, 'sem botão para tentar de novo');
});

t('A6. resposta sem o campo produtos: nao deixa esqueleto', async () => {
  const r = await abrir('semCampo');
  exigirDesfecho(r, 'semCampo');
});

// ============================================================================
// B. Um produto ruim não derruba os outros
// ============================================================================

t('B1. produtos com campos invalidos NAO apagam o catalogo', async () => {
  // Antes desta correção, um único produto com `categoria` numérica lançava
  // TypeError em `.trim()` e a grade inteira ficava sem nada.
  const r = await abrir('hostis');
  exigirDesfecho(r, 'hostis');
  assert(r.cards >= PRODUTOS.length,
    `os produtos válidos sumiram: ${r.cards} cards para ${PRODUTOS.length} produtos sãos + ${HOSTIS.length} hostis`);
  assert(r.erros.length === 0, 'exceção não tratada com dados hostis: ' + r.erros.join(' | '));
});

t('B2. categoria numerica nao quebra a barra de categorias', async () => {
  const r = await abrir('hostis');
  assert(r.cats >= 2, `a lista de categorias ficou com ${r.cats} item(ns) — o TypeError voltou`);
});

t('B3. produto sem imagem e com nome vazio renderiza mesmo assim', async () => {
  estado.cenario = 'hostis';
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 860 });
    await page.goto(base + '/__envelope', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 3000));
    const frame = await (await page.$('#tela')).contentFrame();
    const r = await frame.evaluate(() => {
      const cards = [...document.querySelectorAll('#grade .card-prod')];
      return {
        total: cards.length,
        semFoto: cards.filter((c) => c.querySelector('.foto.sem-img')).length,
        semNome: cards.filter((c) => !(c.querySelector('.nome') || {}).textContent.trim()).length,
        // Nenhum card pode sair sem preço legível.
        semPreco: cards.filter((c) => !/R\$/.test((c.querySelector('.preco') || {}).textContent || '')).length,
      };
    });
    assert(r.semFoto > 0, 'nenhum card usou o monograma — o fallback de imagem não está sendo exercitado');
    assert(r.semNome === 0, `${r.semNome} card(s) sem nome nenhum na tela`);
    assert(r.semPreco === 0, `${r.semPreco} card(s) sem preço`);
  } finally { await page.close(); }
});

// ============================================================================
// C. A tela continua utilizável
// ============================================================================

/**
 * Abre a tela e devolve o frame, para os testes que precisam interagir.
 */
async function abrirFrame(page, largura = 1280) {
  await page.setViewport({ width: largura, height: 860, isMobile: largura < 700, hasTouch: largura < 700 });
  await page.goto(base + '/__envelope', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await new Promise((r) => setTimeout(r, 3000));
  return (await (await page.$('#tela')).contentFrame());
}

t('C0. CLICAR em cada categoria filtra a grade de verdade', async () => {
  // ── O defeito ───────────────────────────────────────────────────────────
  //
  // O botão trazia `onclick="filtrarCat(${JSON.stringify(c)})"`. O
  // `JSON.stringify` devolve aspas DUPLAS e o atributo também é delimitado por
  // aspas duplas, então o HTML saía partido — o atributo terminava em
  // `filtrarCat(` e o clique lançava `SyntaxError: Unexpected end of input`.
  // Só "Todos" funcionava, por ser `filtrarCat(null)`, sem aspas.
  //
  // Verificar que existe `onclick` no HTML não pegaria isto: o atributo
  // EXISTIA. Só clicando de verdade.
  estado.cenario = 'normal';
  const page = await browser.newPage();
  const erros = [];
  page.on('pageerror', (e) => erros.push(`${e.name}: ${e.message}`));
  try {
    const frame = await abrirFrame(page);
    const r = await frame.evaluate(async () => {
      const bs = () => [...document.querySelectorAll('#cats .cat-item')];
      const cards = () => document.querySelectorAll('#grade .card-prod').length;
      const ativo = () => {
        const a = document.querySelector('#cats .cat-item[aria-pressed="true"] .rot');
        return a ? a.textContent.trim() : null;
      };
      const conta = (b) => Number((b.querySelector('.n') || {}).textContent || 0);

      const total = cards();
      const out = { total, ativoInicial: ativo(), cliques: [] };
      for (let i = 1; i < bs().length; i++) {
        const b = bs()[i];
        const nome = (b.querySelector('.rot') || {}).textContent.trim();
        const esperado = conta(b);
        b.click();
        await new Promise((s) => setTimeout(s, 150));
        out.cliques.push({ nome, esperado, obtido: cards(), ativo: ativo(),
                           skel: document.querySelectorAll('#grade .skel').length,
                           altura: (() => { const c = document.querySelector('#grade .card-prod');
                             return c ? Math.round(c.getBoundingClientRect().height) : 0; })() });
      }
      // Voltar para "Todos"
      bs()[0].click();
      await new Promise((s) => setTimeout(s, 150));
      out.voltouTodos = { cards: cards(), ativo: ativo() };
      return out;
    });

    assert(r.ativoInicial === 'Todos', `a categoria inicial deveria ser "Todos", é "${r.ativoInicial}"`);
    assert(r.cliques.length >= 2, `só ${r.cliques.length} categoria(s) além de "Todos" — cenário fraco`);
    for (const c of r.cliques) {
      assert(c.obtido === c.esperado,
        `"${c.nome}": a barra diz ${c.esperado} produto(s) e a grade mostrou ${c.obtido}`);
      assert(c.obtido !== r.total || c.esperado === r.total,
        `"${c.nome}": a grade continuou com todos os ${r.total} — o clique não filtrou`);
      assert(c.ativo === c.nome, `"${c.nome}": o destaque ficou em "${c.ativo}"`);
      assert(c.skel === 0, `"${c.nome}": trocar de categoria trouxe esqueleto de volta`);
      // A correção dos cards não pode se perder ao repintar a grade.
      assert(c.altura >= 120, `"${c.nome}": os cards voltaram a ficar achatados (${c.altura}px)`);
    }
    assert(r.voltouTodos.cards === r.total,
      `voltar em "Todos" mostrou ${r.voltouTodos.cards} de ${r.total}`);
    assert(r.voltouTodos.ativo === 'Todos', 'o destaque não voltou para "Todos"');
    assert(erros.length === 0, 'exceção ao clicar na categoria: ' + erros.join(' | '));
  } finally { await page.close(); }
});

t('C0b. categoria + busca se combinam (intersecao)', async () => {
  estado.cenario = 'normal';
  const page = await browser.newPage();
  try {
    const frame = await abrirFrame(page);
    const r = await frame.evaluate(async () => {
      const bs = () => [...document.querySelectorAll('#cats .cat-item')];
      const cards = () => document.querySelectorAll('#grade .card-prod').length;
      const buscar = async (t) => {
        const b = document.getElementById('busca');
        b.value = t; b.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((s) => setTimeout(s, 400));
      };
      // A maior categoria, para ter o que interseccionar.
      //
      // Selecionada pelo NOME a cada uso: `pintarCategorias` reescreve o
      // innerHTML, então guardar a referência do botão daria um elemento que
      // já saiu do documento — clicar nele não faz nada.
      const nomeCat = bs().slice(1).sort((a, z) =>
        Number(z.querySelector('.n').textContent) - Number(a.querySelector('.n').textContent))[0]
        .querySelector('.rot').textContent.trim();
      const clicarCat = async (nome) => {
        const b = bs().find((x) => (x.querySelector('.rot') || {}).textContent.trim() === nome);
        if (!b) throw new Error('categoria sumiu da barra: ' + nome);
        b.click();
        await new Promise((s) => setTimeout(s, 200));
      };
      await clicarCat(nomeCat);
      const soCategoria = cards();

      // Um termo tirado de um produto que está NESTA categoria.
      const alvo = document.querySelector('#grade .card-prod .nome').textContent.trim();
      const termo = alvo.split(/\s+/)[0];

      await buscar(termo);
      const catMaisBusca = cards();

      // O mesmo termo sem filtro de categoria: tem de ser >= a interseção.
      await clicarCat('Todos');
      const soBusca = cards();

      // Limpar a busca com a categoria de volta.
      await clicarCat(nomeCat);
      await buscar('');
      const voltou = cards();

      // "Todos" preserva a busca digitada.
      await buscar(termo);
      const comBusca = cards();
      await clicarCat('Todos');
      const todosComBusca = {
        cards: cards(),
        buscaNoCampo: document.getElementById('busca').value,
      };
      return { nomeCat, termo, soCategoria, catMaisBusca, soBusca, voltou, comBusca, todosComBusca };
    });

    assert(r.catMaisBusca >= 1, `"${r.nomeCat}" + "${r.termo}" não achou nada — a interseção zerou`);
    assert(r.catMaisBusca <= r.soCategoria,
      `a busca dentro da categoria (${r.catMaisBusca}) devolveu mais que a categoria inteira (${r.soCategoria})`);
    assert(r.catMaisBusca <= r.soBusca,
      `a interseção (${r.catMaisBusca}) é maior que a busca sem categoria (${r.soBusca}) — não é interseção`);
    assert(r.voltou === r.soCategoria,
      `limpar a busca devolveu ${r.voltou}, mas a categoria tem ${r.soCategoria}`);
    // Clicar em "Todos" tira só a categoria; o texto digitado continua valendo.
    assert(r.todosComBusca.buscaNoCampo === r.termo,
      'clicar em "Todos" apagou o texto da busca');
    assert(r.todosComBusca.cards === r.soBusca,
      `"Todos" com a busca "${r.termo}" mostrou ${r.todosComBusca.cards}, esperado ${r.soBusca}`);
  } finally { await page.close(); }
});

t('C0c. "Sem categoria" traz exatamente os produtos sem categoria', async () => {
  estado.cenario = 'hostis';   // inclui categoria numérica, null e só espaços
  const page = await browser.newPage();
  try {
    const frame = await abrirFrame(page);
    const r = await frame.evaluate(async () => {
      const b = [...document.querySelectorAll('#cats .cat-item')]
        .find((x) => (x.querySelector('.rot') || {}).textContent.trim() === 'Sem categoria');
      if (!b) return { erro: 'a categoria "Sem categoria" não apareceu' };
      const esperado = Number(b.querySelector('.n').textContent);
      b.click();
      await new Promise((s) => setTimeout(s, 200));
      return {
        esperado,
        obtido: document.querySelectorAll('#grade .card-prod').length,
        ativo: (document.querySelector('#cats .cat-item[aria-pressed="true"] .rot') || {}).textContent.trim(),
      };
    });
    assert(!r.erro, r.erro);
    assert(r.obtido === r.esperado,
      `"Sem categoria" diz ${r.esperado} e a grade mostrou ${r.obtido} — null, "" e espaços precisam cair todos aqui`);
    assert(r.ativo === 'Sem categoria', `o destaque ficou em "${r.ativo}"`);
  } finally { await page.close(); }
});

t('C0d. nenhum nome de categoria pode quebrar o HTML do botao', () => {
  const src = fs.readFileSync(TELA, 'utf8');
  // Recorta a partir de `function pintarCategorias` até o `.join('')` que fecha
  // a montagem. Ancorar na função importa: existe um `$('cats').innerHTML = ''`
  // antes dela (no estado de catálogo vazio), e começar por ele arrastava o
  // `onclick` de outro botão para dentro do trecho examinado.
  const ini = src.indexOf('function pintarCategorias');
  assert(ini >= 0, 'pintarCategorias sumiu');
  const fim = src.indexOf(".join('');", ini);
  assert(fim > ini, 'a montagem dos botões de categoria sumiu');
  // Sem os comentários: o bloco explica o defeito CITANDO
  // `onclick="filtrarCat(${JSON.stringify(c)})"`, e a busca casaria com a
  // própria explicação em vez de com o código.
  const bloco = [src.slice(ini, fim)
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')];

  // Interpolar o nome dentro de um atributo executável é o defeito de origem:
  // `JSON.stringify` devolve aspas duplas e o atributo se fecha no meio.
  assert(!/onclick=/.test(bloco[0]),
    'os botões de categoria voltaram a ter onclick embutido — use data-idx e delegação');
  assert(!/JSON\.stringify/.test(bloco[0]),
    'o nome da categoria voltou para dentro do HTML via JSON.stringify');
  assert(/data-idx="\$\{i\}"/.test(bloco[0]), 'o botão não guarda mais o índice');

  // A delegação tem de estar no CONTÊINER, que sobrevive ao innerHTML.
  assert(/\$\('cats'\)\.addEventListener\('click'/.test(src),
    'não há ouvinte delegado em #cats — repintar destruiria os handlers');
});

for (const w of [320, 360, 375, 390, 430]) {
  t(`C0e. as categorias respondem ao toque em ${w}px, sem nada por cima`, async () => {
    estado.cenario = 'normal';
    const page = await browser.newPage();
    try {
      const frame = await abrirFrame(page, w);
      const r = await frame.evaluate(async () => {
        const bs = () => [...document.querySelectorAll('#cats .cat-item')];
        if (bs().length < 2) return { erro: 'a barra de categorias não montou' };
        const alvo = bs()[1];
        const nome = alvo.querySelector('.rot').textContent.trim();
        const esperado = Number(alvo.querySelector('.n').textContent);
        const cx = alvo.getBoundingClientRect();

        // Quem realmente recebe o toque no centro do botão? Se for outro
        // elemento, há algo por cima interceptando.
        const noPonto = document.elementFromPoint(cx.left + cx.width / 2, cx.top + cx.height / 2);
        const emCima = noPonto ? (noPonto.closest('.cat-item') === alvo) : false;
        const est = getComputedStyle(alvo);

        alvo.click();
        await new Promise((s) => setTimeout(s, 250));
        return {
          nome, esperado, emCima,
          quemRecebe: noPonto ? (noPonto.tagName.toLowerCase() + '.' + (noPonto.className || '')).slice(0, 40) : null,
          pointerEvents: est.pointerEvents,
          desabilitado: alvo.disabled,
          alturaBotao: Math.round(cx.height),
          visivel: cx.width > 0 && cx.height > 0,
          obtido: document.querySelectorAll('#grade .card-prod').length,
          ativo: (document.querySelector('#cats .cat-item[aria-pressed="true"] .rot') || {}).textContent.trim(),
        };
      });
      assert(!r.erro, r.erro);
      assert(r.visivel, `em ${w}px o botão de categoria tem área zero`);
      assert(r.pointerEvents !== 'none', `em ${w}px o botão está com pointer-events:none`);
      assert(!r.desabilitado, `em ${w}px o botão de categoria está disabled`);
      assert(r.emCima, `em ${w}px algo cobre o botão: quem recebe o toque é ${r.quemRecebe}`);
      assert(r.obtido === r.esperado,
        `em ${w}px, "${r.nome}" mostrou ${r.obtido} em vez de ${r.esperado}`);
      assert(r.ativo === r.nome, `em ${w}px o destaque ficou em "${r.ativo}"`);
    } finally { await page.close(); }
  });
}

t('C1. trocar de categoria e buscar continuam funcionando', async () => {
  estado.cenario = 'normal';
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 860 });
    await page.goto(base + '/__envelope', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 3000));
    const frame = await (await page.$('#tela')).contentFrame();
    const r = await frame.evaluate(async () => {
      const total = document.querySelectorAll('#grade .card-prod').length;
      // Segunda categoria (a primeira é "Todos").
      const cat = document.querySelectorAll('#cats .cat-item')[1];
      cat.click();
      await new Promise((s) => setTimeout(s, 200));
      const filtrado = document.querySelectorAll('#grade .card-prod').length;
      const skelAoFiltrar = document.querySelectorAll('#grade .skel').length;

      document.querySelectorAll('#cats .cat-item')[0].click();
      await new Promise((s) => setTimeout(s, 200));

      const b = document.getElementById('busca');
      b.value = 'zzzznaoexiste';
      b.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((s) => setTimeout(s, 500));
      const buscaVazia = {
        cards: document.querySelectorAll('#grade .card-prod').length,
        estado: (document.querySelector('#grade .estado .tit') || {}).textContent || '',
        skel: document.querySelectorAll('#grade .skel').length,
      };
      return { total, filtrado, skelAoFiltrar, buscaVazia };
    });
    assert(r.total > 0, 'não havia cards para começar');
    assert(r.skelAoFiltrar === 0, 'filtrar por categoria deixou esqueleto na tela');
    assert(r.filtrado > 0 && r.filtrado <= r.total,
      `filtro de categoria devolveu ${r.filtrado} de ${r.total}`);
    assert(r.buscaVazia.skel === 0, 'busca sem resultado deixou esqueleto');
    assert(/nenhum produto encontrado/i.test(r.buscaVazia.estado),
      'busca sem resultado não avisa nada: ' + r.buscaVazia.estado);
  } finally { await page.close(); }
});

t('C2. o card do produto leva ao fluxo de pedido', async () => {
  // Sem pedido aberto os cards ficam desabilitados, com a razão no `title` —
  // é o comportamento existente, e o que não pode é o card não existir.
  const r = await abrir('normal');
  assert(r.cards > 0, 'sem cards para clicar');
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 860 });
    await page.goto(base + '/__envelope', { waitUntil: 'domcontentloaded' });
    await new Promise((s) => setTimeout(s, 3000));
    const frame = await (await page.$('#tela')).contentFrame();
    const d = await frame.evaluate(() => {
      const c = document.querySelector('#grade .card-prod');
      return { desabilitado: c.disabled, dica: c.getAttribute('title') || '',
               chama: (c.getAttribute('onclick') || '') };
    });
    assert(/addItem\(\d+\)/.test(d.chama), 'o card não chama addItem com um id numérico: ' + d.chama);
    if (d.desabilitado) {
      assert(/comece um pedido/i.test(d.dica),
        'o card está desabilitado sem dizer por quê: ' + d.dica);
    }
  } finally { await page.close(); }
});

// ============================================================================
// D. Larguras
// ============================================================================

for (const w of [320, 360, 375, 390, 430, 1280]) {
  t(`D. a grade carrega e cabe em ${w}px`, async () => {
    const r = await abrir('normal', w);
    exigirDesfecho(r, `${w}px`);
    assert(r.cards > 0, `nenhum card em ${w}px`);
    assert(r.estouro <= 1, `estoura ${r.estouro}px além da largura em ${w}px`);
    // O achatamento acontecia em toda largura: medir só em 1280 deixaria
    // passar um colapso que só aparece no celular.
    assert(r.alturaCard >= 120, `em ${w}px o card ficou com ${r.alturaCard}px — achatado`);
    assert(r.precoVisivel, `em ${w}px o preço do card não tem área na tela`);
  });
}

// ============================================================================
// E. Nada de tenant fixo
// ============================================================================

t('E1. a tela nao carrega slug, tenant nem organizacao fixos', () => {
  const src = fs.readFileSync(TELA, 'utf8');
  const semCom = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const proibido of ['produtosbomgosto', 'organizationId', 'tenantId=', 'tenant=']) {
    assert(!semCom.includes(proibido),
      `a Venda rápida passou a carregar "${proibido}" — o tenant vem do Host, e só dele`);
  }
  // Toda chamada é relativa: caminho absoluto para outro host sairia do tenant.
  const externas = [...semCom.matchAll(/fetch\(\s*['"`](https?:)?\/\//g)];
  assert(externas.length === 0, 'a tela faz fetch para fora da própria origem');
});

(async () => {
  if (!CHROME) {
    console.log('  Chrome ausente — teste da Venda rápida não pode rodar');
    console.log('\n0 ok, 0 falha(s) (pulado)');
    process.exit(0);
  }
  estado = { cenario: 'normal' };
  srv = await subirServidor(estado);
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
