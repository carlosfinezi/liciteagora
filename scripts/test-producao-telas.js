#!/usr/bin/env node
/**
 * test-producao-telas.js — carrega as 10 telas do módulo em Chrome headless
 * e falha se alguma delas quebrar.
 *
 * POR QUE ESTE TESTE EXISTE: `npm run verify` roda `node --check` só nos .js da
 * raiz e de scripts/ — o JavaScript INLINE dos HTML de public/ fica de fora.
 * Um erro de sintaxe ou um `undefined` numa tela passa no verify e derruba a
 * página em produção, onde o arquivo estático já está no ar ao salvar.
 *
 * A receita (perfil de Chrome próprio em /tmp, iframe, stubs de menu) está em
 * scripts/producao-teste-util.js e na memória do harness isolado.
 *
 * Uso: node scripts/test-producao-telas.js
 */

const path = require('path');
const u = require('./producao-teste-util');
const express = require(u.BASE + '/node_modules/express');
const puppeteer = require(u.BASE + '/node_modules/puppeteer-core');

const CHROME = '/usr/bin/google-chrome';

let ok = 0, fail = 0;
const falhas = [];
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else {
    fail++; falhas.push(msg);
    console.error(`  ✗ ${msg}${extra !== undefined ? '\n      ' + JSON.stringify(extra).slice(0, 600) : ''}`);
  }
}

// As telas, com o elemento que prova que o JS rodou até o fim (e não morreu
// no meio do primeiro fetch).
const TELAS = [
  { arq: 'painel.html',       espera: '#resumo .card',  titulo: 'Produtividade' },
  { arq: 'ordens.html',          espera: '#tb tr',         titulo: 'Ordens' },
  { arq: 'apontamento.html',  espera: '#etapas button', titulo: 'Apontamento' },
  { arq: 'fichas.html',       espera: '#tb tr',         titulo: 'Fichas' },
  { arq: 'recursos.html',     espera: '#tb tr',         titulo: 'Recursos' },
  { arq: 'qualidade.html',    espera: '#tb tr',         titulo: 'Qualidade' },
  { arq: 'projetos.html',     espera: '#tb tr',         titulo: 'Projetos' },
  { arq: 'patio.html',        espera: '#resumo .card',  titulo: 'Estoque' },
  { arq: 'expedicao.html',    espera: '#tb tr',         titulo: 'Expedição' },
  { arq: 'config.html',       espera: '#producao_prefixo_ordem', titulo: 'Configuração' },
];

(async () => {
  const { db, app, servidor, porta } = await u.montar();
  const ids = u.seed(db);
  u.ligarFlag(db);

  // Estáticos + os dois stubs sem os quais a sidebar não desenha.
  app.use(express.static(path.join(u.BASE, 'public')));
  app.get('/api/features/status', (_req, res) =>
    res.json({ success: true, features: { producao: true } }));
  app.get('/api/perfis/meu-acesso', (_req, res) =>
    res.json({ success: true, irrestrito: true }));

  // O wrapper: sidebar.js manda qualquer carga top-level para /app.html#..., e
  // a tela só roda de verdade dentro do shell.
  app.get('/wrap', (req, res) => {
    const p = String(req.query.p || '');
    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <script>window.__liciteShell = true;</script></head>
      <body style="margin:0"><iframe id="f" src="${p}" style="width:100vw;height:100vh;border:0"></iframe></body></html>`);
  });

  // Massa: uma peça, uma ficha, uma forma, uma OP, uma obra e um lote — o
  // suficiente para nenhuma tela abrir vazia e esconder um erro de render.
  const req = async (m, r, b) => {
    const x = await fetch(`http://127.0.0.1:${porta}${r}`, {
      method: m, headers: { 'content-type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    return x.json();
  };
  await req('PUT', `/api/producao/pecas/${ids.bloco}`, {
    modo: 'estoque', quantidadeBase: 0.01, pesoKg: 12,
    tempoProcessoHoras: 24, unidadesPorCiclo: 40, ensaioLimiteConformidade: 25,
  });
  await req('POST', `/api/producao/pecas/${ids.bloco}/ficha`,
    { insumoProdutoId: ids.cimento, quantidade: 1.5, unidade: 'KG', perdaPercentual: 4, grupo: 'concreto' });
  await req('POST', '/api/producao/formas',
    { codigo: 'FOR-01', descricao: 'Forma de bloco', capacidadePecas: 40 });
  await req('POST', '/api/producao/lotes', { data: '2026-08-20', volumeM3: 3, ensaioLimiteConformidade: 25 });
  await req('POST', '/api/producao/equipes', { nome: 'Equipe A', especialidade: 'processo' });
  await req('POST', '/api/producao/obras', { clienteId: ids.cliente, nome: 'Obra de teste' });
  const op = await req('POST', '/api/producao/ordens',
    { produtoId: ids.bloco, quantidadePlanejada: 40, dataPlanejada: '2026-08-20 07:00' });
  await req('POST', `/api/producao/ordens/${op.op.id}/liberar`);
  await req('POST', '/api/producao/romaneios', { data: '2026-08-21', capacidadeKg: 5000 });

  const navegador = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    // Perfil próprio em /tmp: NUNCA os perfis dos session-services do BLL/BNC.
    userDataDir: `/tmp/pmo-chrome-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  for (const tela of TELAS) {
    console.log(`\n── ${tela.arq}`);
    const page = await navegador.newPage();
    const erros = [];
    page.on('pageerror', e => erros.push(String(e.message)));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // 4xx de API não é erro de JS — e há telas que provocam 4xx de propósito.
      if (/Failed to load resource/i.test(t)) return;
      erros.push(t);
    });

    try {
      await page.goto(`http://127.0.0.1:${porta}/wrap?p=/producao/${tela.arq}`,
        { waitUntil: 'networkidle2', timeout: 20000 });

      // O mainFrame é o wrapper e a URL dele TAMBÉM casa com o filtro (a página
      // vai no query string): excluí-lo é obrigatório, senão find() devolve o
      // pai, que não tem elemento nenhum da tela.
      const frame = page.frames().find(f => f !== page.mainFrame() && f.url().includes(tela.arq));
      assert(!!frame, `${tela.arq}: iframe carregou`);
      if (!frame) { await page.close(); continue; }

      await frame.waitForSelector(tela.espera, { timeout: 8000 });
      assert(true, `${tela.arq}: renderizou "${tela.espera}" (o JS rodou até o fim)`);

      const h1 = await frame.$eval('h1', e => e.innerText).catch(() => '');
      assert(h1.toLowerCase().includes(tela.titulo.toLowerCase()),
        `${tela.arq}: título "${tela.titulo}"`, h1);

      // O erro que mais aparece em tela ligada a API: "undefined" impresso na
      // página porque um campo mudou de nome no backend.
      const corpo = await frame.$eval('body', e => e.innerText).catch(() => '');
      assert(!/\bundefined\b/.test(corpo),
        `${tela.arq}: nenhum "undefined" visível na tela`,
        (corpo.match(/.{0,60}undefined.{0,60}/) || [])[0]);
      assert(!/\[object Object\]/.test(corpo),
        `${tela.arq}: nenhum "[object Object]" visível`);

      assert(erros.length === 0, `${tela.arq}: sem erro de JavaScript`, erros);
    } catch (e) {
      assert(false, `${tela.arq}: carregou sem exceção`, e.message);
    }
    await page.close();
  }

  // O menu só desenha em /app.html (dentro do iframe o sidebar.js sai cedo:
  // a sidebar é do pai). Testar o grupo do módulo lá é o único jeito honesto.
  console.log('\n── menu (app.html)');
  {
    const page = await navegador.newPage();
    try {
      await page.goto(`http://127.0.0.1:${porta}/app.html`, { waitUntil: 'networkidle2', timeout: 20000 });
      await page.waitForSelector('.sidebar, nav, aside', { timeout: 8000 });
      // innerText vem em MAIÚSCULAS: o CSS aplica text-transform.
      const menu = await page.$eval('.sidebar, nav, aside', e => e.innerText).catch(() => '');
      assert(/produ[çc][ãa]o/i.test(menu), 'o grupo "Produção" aparece na sidebar',
        menu.slice(0, 400));

      // Os itens ficam DENTRO do grupo colapsado, então não entram no
      // innerText (que ignora display:none). textContent os alcança — o que
      // se testa aqui é que o menu foi montado, não que está aberto.
      const html = await page.$eval('.sidebar, nav, aside', e => e.textContent).catch(() => '');
      assert(/produtividade/i.test(html), 'e o item "Produtividade" foi montado no grupo');
      const links = await page.$$eval('a[href^="/producao/"]', as => as.map(a => a.getAttribute('href')));
      assert(links.length === 10,
        'os 10 itens do módulo têm link na sidebar', links);
    } catch (e) {
      assert(false, 'app.html carregou', e.message);
    }
    await page.close();
  }

  await navegador.close();
  servidor.close();
  db.close();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Telas: ${ok} passaram, ${fail} falharam`);
  if (fail) { console.log('\nFalhas:'); falhas.forEach(f => console.log(`  - ${f}`)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO FATAL:', e.stack); process.exit(1); });
