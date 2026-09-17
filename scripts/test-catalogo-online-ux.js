/**
 * Catálogo Online — UX da central (Fase 47).
 *
 * Interações REAIS no Chrome: clicar, navegar, abrir painel, salvar. Verificar
 * que um elemento existe no DOM não prova que ele funciona — foi a lição do
 * relatório 42, onde 76 cards existiam achatados a 15px e o teste passava.
 *
 * As garantias de arquitetura (um produto só, destaque como coluna, tenant,
 * RBAC) ficam em `test-catalogo-online.js` e continuam valendo. Aqui é o que a
 * pessoa vê e toca.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const TELA = path.join(PUB, 'catalogo/catalogo-online.html');
const CHROME = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
  .find((p) => fs.existsSync(p));

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

/* Catálogo de teste: duas categorias, uma sem categoria, um destaque, um
   produto com saldo de importação (o caso real do produtosbomgosto). */
const prods = (n, ini) => Array.from({ length: n }, (_, i) => ({
  id: ini + i, sku: 'S' + (ini + i),
  descricao: 'PRODUTO COM NOME BEM LONGO PARA TESTAR QUEBRA DE LINHA ' + (ini + i),
  unidade: 'UN', preco: 19.9 + i, foto: null, nFotos: 0,
  publicado: i % 2 === 0, destaque: false, disponivel: 12,
}));
const ESTADO = { salvouProduto: null, publicou: null, destacou: null, config: null };

function catalogo() {
  const cestas = prods(4, 1);
  const doces = prods(3, 10);
  cestas[0].destaque = true;
  cestas[1].disponivel = 9999999974;       // o saldo de importação
  const sem = prods(1, 20).map((p) => ({ ...p, publicado: false }));
  return {
    success: true,
    loja: { ativa: false, nome: 'EMPRESA TESTE LTDA', nomeProprio: false,
      descricao: null, logo: null, logoProprio: false, whatsapp: '44999990000',
      tema: { corPrimaria: '#0E6B63' }, mostrarPreco: true, mostrarEstoque: true,
      pagamento: 'nenhum', url: 'https://empresa.liciteagora.app/loja/' },
    resumo: { total: 8, publicados: 4, ocultos: 4, destaques: 1, semFoto: 8, categorias: 2 },
    // Destaque carrega os MESMOS campos da linha de categoria (corrigido na
    // Fase 47): sem `sku`/`unidade` a linha saía como "sem SKU".
    destaques: [{ id: 1, sku: cestas[0].sku, descricao: cestas[0].descricao,
                  unidade: 'UN', preco: cestas[0].preco, foto: null,
                  publicado: true, destaque: true, disponivel: 12 }],
    categorias: [
      { categoria: 'CESTAS', produtos: cestas, total: 4, publicados: 2 },
      { categoria: 'DOCES', produtos: doces, total: 3, publicados: 2 },
      { categoria: null, produtos: sem, total: 1, publicados: 0 },
    ],
  };
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function subirServidor() {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const ler = (cb) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => cb(b)); };
    if (url === '/api/loja/catalogo') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(catalogo()));
    }
    if (url === '/api/loja/produtos/publicar' || url === '/api/loja/produtos/destacar') {
      return ler((b) => {
        const alvo = url.endsWith('publicar') ? 'publicou' : 'destacou';
        try { ESTADO[alvo] = JSON.parse(b); } catch (_) {}
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, alterados: 1 }));
      });
    }
    if (url === '/api/loja/config' && req.method === 'PUT') {
      return ler((b) => { try { ESTADO.config = JSON.parse(b); } catch (_) {}
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true })); });
    }
    if (/^\/api\/produtos\/\d+$/.test(url)) {
      if (req.method === 'PUT') {
        return ler((b) => { try { ESTADO.salvouProduto = JSON.parse(b); } catch (_) {}
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true })); });
      }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ success: true, produto: {
        id: 1, sku: 'S1', descricao: 'PRODUTO COM NOME BEM LONGO PARA TESTAR QUEBRA DE LINHA 1',
        observacoes: 'descrição da vitrine', precoVenda: 19.9, unidade: 'UN',
        codigoBarras: '789', categoria: 'CESTAS', estoqueMinimo: 2, precoCusto: 5,
        imagemPath: null, publicadoNaLoja: 1, destaqueNaLoja: 1 } }));
    }
    if (url.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ success: true, produtos: [], itens: [] }));
    }
    if (url === '/__e') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>
        <iframe id="tela" src="/catalogo/catalogo-online.html"></iframe>`);
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
  await page.setViewport({ width: largura, height: 900, isMobile: largura < 700, hasTouch: largura < 700 });
  await page.goto(base + '/__e', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await new Promise((r) => setTimeout(r, 2300));
  const frame = await (await page.$('#tela')).contentFrame();
  if (!frame) throw new Error('a tela não carregou');
  return { page, frame, erros };
}

// ============================================================================
// A. Identidade e resumo
// ============================================================================

t('A. capa: banner, logo, nome, status, link e resumo em UMA linha', async () => {
  const { page, frame, erros } = await abrir();
  try {
    const r = await frame.evaluate(() => {
      const txt = (s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
      const banner = document.getElementById('capBanner');
      return {
        nome: txt('#capNome'), sub: txt('#capSub'), status: txt('#capStatus'),
        url: txt('#capUrl'), resumo: txt('#capResumo'),
        bannerAltura: Math.round(banner.getBoundingClientRect().height),
        logoVisivel: !document.getElementById('capLogo').hidden
          || document.getElementById('capLogoSem').style.display !== 'none',
        // Os cinco cards de dashboard tinham de sair.
        cards: document.querySelectorAll('.cat-resumo .bloco, .bloco .n').length,
      };
    });
    assert(r.nome === 'EMPRESA TESTE LTDA', `nome: ${r.nome}`);
    assert(/nome da empresa/i.test(r.sub), 'não avisa que o nome é recuo da empresa: ' + r.sub);
    assert(r.status === 'Não publicado', `status: ${r.status}`);
    assert(r.url.includes('/loja/'), 'link público ausente');
    assert(r.bannerAltura >= 90, `banner com ${r.bannerAltura}px — sem presença de capa`);
    assert(r.logoVisivel, 'logo/monograma não aparece');
    assert(r.cards === 0, `sobraram ${r.cards} cards de dashboard na área principal`);
    // Resumo discreto, numa linha, com os números certos.
    assert(/8 produto\(s\)/.test(r.resumo) && /2 categoria\(s\)/.test(r.resumo)
        && /4 publicado\(s\)/.test(r.resumo), 'resumo incompleto: ' + r.resumo);
    assert(erros.length === 0, 'exceção: ' + erros.join(' | '));
  } finally { await page.close(); }
});

// ============================================================================
// B. Barra horizontal de categorias
// ============================================================================

t('B. a barra traz Categorias, Destaques e as categorias REAIS', async () => {
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(() => ({
      botoes: [...document.querySelectorAll('#navCats button')].map((b) => b.textContent.trim()),
      rolavel: document.getElementById('navCats').scrollWidth
             > document.getElementById('navCats').clientWidth,
    }));
    assert(/Categorias/.test(r.botoes[0]), 'o primeiro botão deveria ser Categorias: ' + r.botoes[0]);
    assert(r.botoes.some((b) => /Destaques/.test(b)), 'Destaques não está na barra');
    assert(r.botoes.some((b) => b === 'CESTAS') && r.botoes.some((b) => b === 'DOCES'),
      'as categorias reais não estão na barra: ' + r.botoes.join(', '));
    assert(r.botoes.some((b) => b === 'Sem categoria'), '"Sem categoria" sumiu da barra');
    // Destaques não pode ter virado categoria de texto.
    assert(!r.botoes.filter((b) => b === 'Destaques').length || r.botoes.includes('★ Destaques'),
      'Destaques aparece como categoria comum');
  } finally { await page.close(); }
});

t('B2. clicar numa categoria abre e foca a secao dela', async () => {
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(async () => {
      const b = [...document.querySelectorAll('#navCats button')].find((x) => x.textContent.trim() === 'DOCES');
      b.click();
      await new Promise((s) => setTimeout(s, 500));
      const sec = document.querySelector('[data-bloco="c:DOCES"]');
      return {
        aberta: sec && sec.classList.contains('aberta'),
        linhas: sec ? sec.querySelectorAll('.lp').length : 0,
        ativo: (document.querySelector('#navCats button.ativo') || {}).textContent,
      };
    });
    assert(r.aberta, 'a categoria não abriu ao clicar na barra');
    assert(r.linhas === 3, `DOCES mostrou ${r.linhas} produtos, esperado 3`);
    assert((r.ativo || '').trim() === 'DOCES', `o botão ativo é "${r.ativo}"`);
  } finally { await page.close(); }
});

// ============================================================================
// C. Painel de categorias
// ============================================================================

t('C. o painel Categorias tem adicionar, abrir/fechar todas e a lista', async () => {
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(async () => {
      document.querySelector('[data-abrircats]').click();
      await new Promise((s) => setTimeout(s, 350));
      const pn = document.getElementById('pnCats');
      const corpo = document.getElementById('pnCatsCorpo');
      return {
        aberto: pn.classList.contains('open'),
        texto: corpo.textContent.replace(/\s+/g, ' '),
        itens: [...corpo.querySelectorAll('[data-ir]')].map((b) => b.textContent.trim().replace(/\s+/g, ' ')),
        temAdicionar: /Adicionar categoria/.test(corpo.textContent),
        temTodas: corpo.querySelectorAll('[data-todas]').length,
      };
    });
    assert(r.aberto, 'o painel não abriu');
    assert(r.temAdicionar, 'falta "+ Adicionar categoria"');
    assert(r.temTodas === 2, 'faltam Abrir todas / Fechar todas');
    assert(/2 categoria\(s\) · 8 produto\(s\)/.test(r.texto), 'falta o total: ' + r.texto);
    assert(r.itens.some((i) => /Destaques/.test(i)), 'Destaques não está no painel');
    assert(r.itens.some((i) => /CESTAS/.test(i)), 'as categorias reais não estão no painel');
  } finally { await page.close(); }
});

t('C2. abrir todas e fechar todas funcionam de verdade', async () => {
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(async () => {
      const espera = () => new Promise((s) => setTimeout(s, 300));
      document.querySelector('[data-abrircats]').click(); await espera();
      document.querySelector('[data-todas="1"]').click(); await espera();
      const abertas = document.querySelectorAll('.bloco-cat.aberta').length;
      const linhas = document.querySelectorAll('.lp').length;
      document.querySelector('[data-todas="0"]').click(); await espera();
      return { abertas, linhas, fechadas: document.querySelectorAll('.bloco-cat.aberta').length };
    });
    assert(r.abertas === 4, `abriu ${r.abertas} blocos (3 categorias + destaques)`);
    assert(r.linhas === 9, `mostrou ${r.linhas} linhas, esperado 9 (8 produtos + 1 destaque)`);
    assert(r.fechadas === 0, `sobraram ${r.fechadas} blocos abertos`);
  } finally { await page.close(); }
});

// ============================================================================
// D. Destaques
// ============================================================================

t('D. Destaques e a PRIMEIRA secao, e nao e categoria de texto', async () => {
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(() => {
      const blocos = [...document.querySelectorAll('.bloco-cat')];
      return {
        primeiro: blocos[0] ? blocos[0].querySelector('.bc-nome').textContent.trim() : null,
        chaves: blocos.map((b) => b.dataset.bloco),
        catsDoDatalist: [...document.querySelectorAll('#catList option')].map((o) => o.value),
      };
    });
    assert(/Destaques/.test(r.primeiro), `a primeira seção é "${r.primeiro}"`);
    assert(r.chaves[0] === 'destaques', 'a chave do bloco de destaques mudou');
    // Nunca vira categoria: não pode estar entre as chaves `c:`.
    assert(!r.chaves.includes('c:Destaques'), 'Destaques virou categoria de texto');
  } finally { await page.close(); }
});

t('D2. a estrela alterna o destaque e chama o endpoint certo', async () => {
  ESTADO.destacou = null;
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(async () => {
      document.querySelector('[data-abrircats]').click();
      await new Promise((s) => setTimeout(s, 250));
      document.querySelector('[data-todas="1"]').click();
      await new Promise((s) => setTimeout(s, 300));
      const b = document.querySelector('[data-destaque]');
      const antes = { classe: b.className, rotulo: b.getAttribute('aria-label'),
                      pressed: b.getAttribute('aria-pressed') };
      b.click();
      await new Promise((s) => setTimeout(s, 700));
      return { antes, id: b.dataset.destaque };
    });
    assert(/estrela/.test(r.antes.classe), 'o botão de destaque perdeu a classe');
    assert(/destaque/i.test(r.antes.rotulo), 'a estrela não tem aria-label: ' + r.antes.rotulo);
    assert(r.antes.pressed === 'true' || r.antes.pressed === 'false', 'falta aria-pressed na estrela');
    assert(ESTADO.destacou, 'a estrela não chamou /api/loja/produtos/destacar');
    assert(Array.isArray(ESTADO.destacou.ids), 'o corpo não manda ids');
    assert(typeof ESTADO.destacou.destaque === 'boolean', 'o corpo não manda o novo estado');
  } finally { await page.close(); }
});

// ============================================================================
// E. Linha do produto
// ============================================================================

t('E. a linha e compacta: foto, nome, SKU, preco — e NADA de fiscal', async () => {
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(async () => {
      document.querySelector('[data-abrircats]').click();
      await new Promise((s) => setTimeout(s, 250));
      document.querySelector('[data-todas="1"]').click();
      await new Promise((s) => setTimeout(s, 300));
      const l = document.querySelector('.lp');
      const c = l.getBoundingClientRect();
      return {
        altura: Math.round(c.height),
        texto: l.textContent.replace(/\s+/g, ' '),
        temFoto: !!l.querySelector('.lp-foto'),
        fotoAltura: Math.round(l.querySelector('.lp-foto').getBoundingClientRect().height),
        preco: (l.querySelector('.lp-preco') || {}).textContent,
        meta: (l.querySelector('.lp-meta') || {}).textContent,
      };
    });
    assert(r.temFoto && r.fotoAltura >= 40, `foto com ${r.fotoAltura}px`);
    assert(/R\$/.test(r.preco || ''), 'preço ausente na linha: ' + r.preco);
    assert(/S\d/.test(r.meta || ''), 'SKU ausente na linha: ' + r.meta);
    assert(r.altura >= 50 && r.altura <= 130, `linha com ${r.altura}px — nem compacta nem legível`);
    // O que NÃO pode aparecer na central.
    for (const proibido of ['CFOP', 'NCM', 'custo', 'Custo', 'ICMS', 'CEST', 'origem fiscal']) {
      assert(!r.texto.includes(proibido), `a linha mostra "${proibido}" — isso é de Produtos`);
    }
  } finally { await page.close(); }
});

t('E2. o olho alterna a visibilidade e usa publicadoNaLoja', async () => {
  ESTADO.publicou = null;
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(async () => {
      document.querySelector('[data-abrircats]').click();
      await new Promise((s) => setTimeout(s, 250));
      document.querySelector('[data-todas="1"]').click();
      await new Promise((s) => setTimeout(s, 300));
      const b = document.querySelector('[data-vis]');
      const est = { rotulo: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'),
                    dica: b.dataset.dica, alt: Math.round(b.getBoundingClientRect().height) };
      b.click();
      await new Promise((s) => setTimeout(s, 700));
      return est;
    });
    assert(/catálogo/i.test(r.rotulo), 'o olho não tem aria-label claro: ' + r.rotulo);
    assert(/Mostrar no catálogo|Ocultar do catálogo/.test(r.dica), 'dica errada: ' + r.dica);
    assert(r.pressed === 'true' || r.pressed === 'false', 'falta aria-pressed no olho');
    assert(r.alt >= 40, `alvo de toque com ${r.alt}px`);
    assert(ESTADO.publicou, 'o olho não chamou /api/loja/produtos/publicar');
    assert(typeof ESTADO.publicou.publicado === 'boolean', 'o corpo não manda `publicado`');
  } finally { await page.close(); }
});

// ============================================================================
// F. Painel de produto
// ============================================================================

t('F. o painel abre em BLOCOS, com foto grande e descricao confortavel', async () => {
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(async () => {
      document.querySelector('[data-abrircats]').click();
      await new Promise((s) => setTimeout(s, 250));
      document.querySelector('[data-todas="1"]').click();
      await new Promise((s) => setTimeout(s, 300));
      document.querySelector('[data-abrir]').click();
      await new Promise((s) => setTimeout(s, 1100));
      const ta = document.getElementById('fObservacoes');
      const foto = document.querySelector('.pp-foto');
      return {
        aberto: document.getElementById('pnProd').classList.contains('open'),
        secoes: [...document.querySelectorAll('.pp-sec > h4')].map((h) => h.textContent.trim()),
        fotoLado: foto ? Math.round(foto.getBoundingClientRect().width) : 0,
        descAltura: ta ? Math.round(ta.getBoundingClientRect().height) : 0,
        nome: (document.getElementById('fDescricao') || {}).value,
        preco: (document.getElementById('fPrecoVenda') || {}).value,
        larguraPainel: Math.round(document.querySelector('#pnProd .pn').getBoundingClientRect().width),
      };
    });
    assert(r.aberto, 'o painel não abriu');
    // A ordem dos blocos é a da referência.
    assert(r.secoes.join(' > ') === 'Preço > Estoque > Identificação > Vitrine > Personalizações',
      'blocos fora de ordem: ' + r.secoes.join(' > '));
    assert(r.fotoLado >= 90, `foto do painel com ${r.fotoLado}px — pequena demais`);
    assert(r.descAltura >= 55, `descrição com ${r.descAltura}px — textarea minúsculo`);
    assert(r.nome && r.preco, 'os campos não carregaram do produto real');
    assert(r.larguraPainel >= 420, `painel com ${r.larguraPainel}px — formulário apertado`);
  } finally { await page.close(); }
});

t('F2. salvar manda os campos ao endpoint do PRODUTO', async () => {
  ESTADO.salvouProduto = null;
  const { page, frame } = await abrir();
  try {
    await frame.evaluate(async () => {
      document.querySelector('[data-abrircats]').click();
      await new Promise((s) => setTimeout(s, 250));
      document.querySelector('[data-todas="1"]').click();
      await new Promise((s) => setTimeout(s, 300));
      document.querySelector('[data-abrir]').click();
      await new Promise((s) => setTimeout(s, 1100));
      document.getElementById('fDescricao').value = 'NOME EDITADO';
      document.getElementById('btSalvar').click();
      await new Promise((s) => setTimeout(s, 1200));
    });
    assert(ESTADO.salvouProduto, 'o salvar não chamou PUT /api/produtos/:id');
    assert(ESTADO.salvouProduto.descricao === 'NOME EDITADO', 'não mandou o nome editado');
    assert('precoVenda' in ESTADO.salvouProduto, 'não manda o preço');
    // Nada de custo pela central: ele saiu do painel nesta fase.
    assert(!('precoCusto' in ESTADO.salvouProduto), 'a central voltou a mandar preço de custo');
    // Nem saldo de estoque: ele vem das movimentações.
    for (const proibido of ['saldo', 'estoque', 'quantidade']) {
      assert(!(proibido in ESTADO.salvouProduto), `a central manda "${proibido}" — isso é do estoque`);
    }
  } finally { await page.close(); }
});

t('F3. saldo de IMPORTACAO aparece marcado, nao escondido', async () => {
  // Auditado em 14/09: os saldos bilionários do produtosbomgosto vêm de uma
  // entrada única "Importação inicial do export Bling/Tiny". NÃO é sentinela do
  // sistema — não há `controlaEstoque` em `produtos`. Esconder seria mascarar
  // dado real; o certo é mostrar e sinalizar.
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(async () => {
      document.querySelector('[data-abrircats]').click();
      await new Promise((s) => setTimeout(s, 250));
      document.querySelector('[data-todas="1"]').click();
      await new Promise((s) => setTimeout(s, 300));
      // O segundo produto de CESTAS é o do saldo de importação.
      const linhas = [...document.querySelectorAll('[data-bloco="c:CESTAS"] [data-abrir]')];
      linhas[1].click();
      await new Promise((s) => setTimeout(s, 1100));
      const sec = [...document.querySelectorAll('.pp-sec')].find((s) => /Estoque/.test(s.textContent));
      return { texto: sec ? sec.textContent.replace(/\s+/g, ' ') : null };
    });
    assert(r.texto, 'bloco de estoque ausente');
    // O número real continua na tela.
    assert(/9\.999\.999\.974/.test(r.texto), 'o saldo real sumiu da tela: ' + r.texto);
    assert(/importação/i.test(r.texto), 'não sinaliza que o saldo veio de importação');
  } finally { await page.close(); }
});

// ============================================================================
// G. Acessibilidade e proibições do projeto
// ============================================================================

t('G. icones tem aria-label e NAO usam title', () => {
  const src = fs.readFileSync(TELA, 'utf8');
  const semCom = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/<!--[\s\S]*?-->/g, '');
  // `title=` está proibido nesta base desde a Fase 3.2.1: o balão nativo
  // aparece por cima do nosso, branco e atrasado.
  assert(!/\stitle="/.test(semCom), 'a tela voltou a usar title=');
  assert(/class="dica"/.test(src), 'não há tooltip próprio');
  for (const marca of ['data-dica', 'aria-label', 'aria-pressed', 'aria-expanded']) {
    assert(semCom.includes(marca), `falta ${marca} nos controles`);
  }
});

t('G2. o botao Produtos saiu do topo (era redundante)', () => {
  const src = fs.readFileSync(TELA, 'utf8');
  const cab = /<div class="page-header">[\s\S]*?<\/div>\s*<\/div>/.exec(src);
  assert(cab, 'cabeçalho não encontrado');
  assert(!/catalogo\/produtos\.html/.test(cab[0]),
    'o botão Produtos continua no topo — a própria central administra os produtos');
  assert(/abrirAparencia/.test(cab[0]), 'o acesso a Aparência sumiu do topo');
  // A rota não foi removida: continua alcançável pelo "+ Produto" da categoria.
  assert(/catalogo\/produto\.html/.test(src), 'o caminho para o cadastro real sumiu da tela');
});

// ============================================================================
// H. Larguras
// ============================================================================

for (const w of [320, 360, 375, 390, 430, 768, 1280, 1440]) {
  t(`H. cabe em ${w}px, com alvos de toque e painel adaptado`, async () => {
    const { page, frame, erros } = await abrir(w);
    try {
      const r = await frame.evaluate(async () => {
        const d = document.documentElement;
        document.querySelector('[data-abrircats]').click();
        await new Promise((s) => setTimeout(s, 250));
        document.querySelector('[data-todas="1"]').click();
        await new Promise((s) => setTimeout(s, 350));
        const estouroLista = d.scrollWidth - d.clientWidth;
        document.querySelector('[data-abrir]').click();
        await new Promise((s) => setTimeout(s, 1000));
        const pn = document.querySelector('#pnProd .pn').getBoundingClientRect();
        const vis = (e) => e.offsetParent !== null;
        return {
          estouro: Math.max(estouroLista, d.scrollWidth - d.clientWidth),
          painelCabe: pn.width <= window.innerWidth + 1 && pn.left >= -1,
          painelLargura: Math.round(pn.width),
          campos: [...document.querySelectorAll('.pn-corpo input, .pn-corpo textarea')]
            .filter((e) => vis(e) && parseFloat(getComputedStyle(e).fontSize) < 15.9).length,
          iconesPequenos: [...document.querySelectorAll('.ic-btn')]
            .filter((e) => vis(e) && e.getBoundingClientRect().height < 40).length,
          rodapeVisivel: (() => {
            const p = document.querySelector('.pn-pe').getBoundingClientRect();
            return p.bottom <= window.innerHeight + 1 && p.height > 0;
          })(),
        };
      });
      assert(r.estouro <= 1, `estoura ${r.estouro}px em ${w}px`);
      assert(r.painelCabe, `o painel sai da tela em ${w}px (${r.painelLargura}px)`);
      assert(r.rodapeVisivel, `o rodapé Salvar não está acessível em ${w}px`);
      assert(r.iconesPequenos === 0, `${r.iconesPequenos} ícone(s) abaixo de 40px em ${w}px`);
      if (w < 700) assert(r.campos === 0, `${r.campos} campo(s) abaixo de 16px em ${w}px — o iOS daria zoom`);
      assert(erros.length === 0, `exceção em ${w}px: ` + erros.join(' | '));
    } finally { await page.close(); }
  });
}

// ============================================================================
// I. Busca
// ============================================================================

t('I. a busca filtra e limpar devolve tudo', async () => {
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(async () => {
      const espera = () => new Promise((s) => setTimeout(s, 350));
      document.querySelector('[data-abrircats]').click(); await espera();
      document.querySelector('[data-todas="1"]').click(); await espera();
      const total = document.querySelectorAll('.lp').length;
      const b = document.getElementById('busca');
      b.value = 'S10'; b.dispatchEvent(new Event('input', { bubbles: true })); await espera();
      const filtrado = document.querySelectorAll('.lp').length;
      b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); await espera();
      return { total, filtrado, voltou: document.querySelectorAll('.lp').length };
    });
    assert(r.total === 9, `esperava 9 linhas, veio ${r.total}`);
    assert(r.filtrado > 0 && r.filtrado < r.total, `a busca devolveu ${r.filtrado} de ${r.total}`);
    assert(r.voltou === r.total, `limpar devolveu ${r.voltou} de ${r.total}`);
  } finally { await page.close(); }
});

(async () => {
  if (!CHROME) {
    console.log('  Chrome ausente — teste de UX não pode rodar');
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
