/**
 * Engenharia de cardápio classificada dentro de cada categoria.
 *
 * Com a média do cardápio inteiro, a bebida (que sai em unidades muito
 * maiores) puxava a popularidade média para cima e todo prato virava
 * "enigma". O cenário abaixo é montado para os dois cálculos discordarem:
 *
 *   Pratos:  P1 30 un, margem 40 · P2 10 un, margem 20 · P3 15 un, margem 30
 *   Bebidas: B1 300 un, margem 5 · B2 100 un, margem 3
 *
 *   por categoria (certo):  P1 estrela · P3 enigma · P2 peso-morto
 *                           B1 estrela · B2 peso-morto
 *   cardápio inteiro:       P1, P2, P3 enigma · B1, B2 cavalo
 *
 *   A. rota /api/restaurante/indicadores/cardapio
 *   B. de onde vem a categoria (primeiro cardápio; sem cardápio)
 *   C. a tela mostra os quadrantes e a participação na categoria
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const puppeteer = require('puppeteer-core');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const DB = '/tmp/vp-restaurante-engenharia.db';
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch {} }
const db = new Database(DB);
const schema = require('./schema-de-tenant').lerSchema();
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- cardápio ----------
const salao = db.prepare("INSERT INTO rest_cardapios (nome, canal, ordem) VALUES ('Salão', 'salao', 1)").run().lastInsertRowid;
const delivery = db.prepare("INSERT INTO rest_cardapios (nome, canal, ordem) VALUES ('Delivery', 'delivery', 2)").run().lastInsertRowid;
const mesa = db.prepare("INSERT INTO rest_mesas (numero) VALUES ('1')").run().lastInsertRowid;
let sku = 0;
function item(nome, preco, custo, categoria, { cardapio = salao } = {}) {
  sku += 1;
  const insumo = db.prepare("INSERT INTO produtos (sku, descricao, unidade, precoCusto) VALUES (?, ?, 'UN', ?)").run('I' + sku, 'Insumo ' + nome, custo).lastInsertRowid;
  const p = db.prepare("INSERT INTO produtos (sku, descricao, unidade, precoVenda) VALUES (?, ?, 'UN', ?)").run('P' + sku, nome, preco).lastInsertRowid;
  const f = db.prepare('INSERT INTO rest_fichas (produtoId, rendimento) VALUES (?, 1)').run(p).lastInsertRowid;
  db.prepare("INSERT INTO rest_ficha_itens (fichaId, insumoProdutoId, quantidadeBruta, unidade) VALUES (?, ?, 1, 'UN')").run(f, insumo);
  if (categoria) db.prepare('INSERT INTO rest_cardapio_itens (cardapioId, produtoId, categoria, preco) VALUES (?, ?, ?, ?)').run(cardapio, p, categoria, preco);
  return p;
}
const P = {
  P1: item('Prato 1', 50, 10, 'Pratos'),
  P2: item('Prato 2', 30, 10, 'Pratos'),
  P3: item('Prato 3', 40, 10, 'Pratos'),
  B1: item('Bebida 1', 8, 3, 'Bebidas'),
  B2: item('Bebida 2', 6, 3, 'Bebidas'),
};
// Também no delivery, com outra categoria: vale a do salão, que vem primeiro
db.prepare("INSERT INTO rest_cardapio_itens (cardapioId, produtoId, categoria, preco) VALUES (?, ?, 'Combos do delivery', 50)").run(delivery, P.P1);
// Vendido sem estar em cardápio nenhum
const avulso = item('Avulso', 20, 5, null);

function vender(produtoId, qtd) {
  const p = db.prepare('SELECT descricao, precoVenda FROM produtos WHERE id = ?').get(produtoId);
  const c = db.prepare(`INSERT INTO rest_comandas (tipo, mesaId, canal, status, abertaEm, fechadaEm, totalItens, totalGeral, totalPago)
    VALUES ('mesa', ?, 'salao', 'fechada', '2026-09-19 15:00:00', '2026-09-19 16:00:00', ?, ?, ?)`)
    .run(mesa, p.precoVenda * qtd, p.precoVenda * qtd, p.precoVenda * qtd).lastInsertRowid;
  db.prepare(`INSERT INTO rest_comanda_itens (comandaId, produtoId, descricao, quantidade, precoUnit, precoTotal, status, lancadoEm)
    VALUES (?, ?, ?, ?, ?, ?, 'entregue', '2026-09-19 15:05:00')`).run(c, produtoId, p.descricao, qtd, p.precoVenda, p.precoVenda * qtd);
}
vender(P.P1, 30); vender(P.P2, 10); vender(P.P3, 15); vender(P.B1, 300); vender(P.B2, 100); vender(avulso, 4);

// ---------- rota ----------
const app = express();
require('../restaurante/restaurante-indicadores').registrarRotasIndicadores(app, db, (q, r, n) => n());
function cardapio() {
  const l = ((app.router || app._router).stack || []).find(x => x.route && x.route.path === '/api/restaurante/indicadores/cardapio');
  let out = null;
  const res = { json: x => { out = x; return res; }, status: () => res };
  l.route.stack.at(-1).handle({ query: {}, params: {} }, res);
  return out;
}
const porNome = () => Object.fromEntries(cardapio().itens.map(i => [i.descricao, i]));

t('A1. pratos se comparam com pratos: P1 estrela, P3 enigma, P2 peso-morto', () => {
  const i = porNome();
  const got = ['Prato 1', 'Prato 2', 'Prato 3'].map(n => i[n].classificacao);
  assert(JSON.stringify(got) === JSON.stringify(['estrela', 'peso-morto', 'enigma']),
    `pratos: ${JSON.stringify(got)} (com a média do cardápio inteiro seriam todos enigma)`);
});
t('A2. bebidas se comparam com bebidas: B1 estrela, B2 peso-morto', () => {
  const i = porNome();
  const got = [i['Bebida 1'].classificacao, i['Bebida 2'].classificacao];
  assert(JSON.stringify(got) === JSON.stringify(['estrela', 'peso-morto']), `bebidas: ${JSON.stringify(got)} (no cardápio inteiro, cavalos)`);
});
t('A3. popularidade é a participação na própria categoria, e as médias são da categoria', () => {
  const d = cardapio();
  const i = Object.fromEntries(d.itens.map(x => [x.descricao, x]));
  assert(Math.abs(i['Prato 1'].popularidadeCategoriaPct - 54.55) < 0.01, 'P1 na categoria: ' + i['Prato 1'].popularidadeCategoriaPct);
  assert(Math.abs(i['Bebida 1'].popularidadeCategoriaPct - 75) < 0.01, 'B1 na categoria: ' + i['Bebida 1'].popularidadeCategoriaPct);
  const m = d.mediasPorCategoria;
  assert(m.Pratos.itens === 3 && Math.abs(m.Pratos.margemUnitaria - 30) < 0.01 && Math.abs(m.Pratos.popularidadePct - 33.33) < 0.01,
    'médias de Pratos: ' + JSON.stringify(m.Pratos));
  assert(m.Bebidas.itens === 2 && Math.abs(m.Bebidas.margemUnitaria - 4) < 0.01, 'médias de Bebidas: ' + JSON.stringify(m.Bebidas));
});
t('A4. o resumo conta os quadrantes somando as categorias', () => {
  const r = cardapio().resumo;
  assert(r.estrela === 3 && r.enigma === 1 && r['peso-morto'] === 2 && r.cavalo === 0, 'resumo: ' + JSON.stringify(r));
});
t('A5. a curva ABC continua sobre o cardápio inteiro', () => {
  const d = cardapio();
  const soma = d.itens.reduce((s, i) => s + i.popularidadePct, 0);
  assert(Math.abs(soma - 100) < 0.1, 'participação global somando ' + soma);
  assert(d.itens[d.itens.length - 1].acumuladoPct === 100, 'acumulado final ' + d.itens[d.itens.length - 1].acumuladoPct);
});
t('B1. produto em dois cardápios fica com a categoria do primeiro pela ordem', () => {
  assert(porNome()['Prato 1'].categoria === 'Pratos', 'categoria do P1: ' + porNome()['Prato 1'].categoria);
});
t('B2. item vendido fora de cardápio fica em "Sem categoria"', () => {
  assert(porNome().Avulso.categoria === 'Sem categoria', 'avulso: ' + porNome().Avulso.categoria);
});

// ---------- tela ----------
const CHROME = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
let browser, srv, base;
t('C1. a tela mostra os quadrantes com nomes de dono de restaurante, marca na cor do quadro e a participação na categoria', async () => {
  const w = express();
  require('../restaurante/restaurante-indicadores').registrarRotasIndicadores(w, db, (q, r, n) => n());
  w.use('/api', (q, r) => r.json({ success: true, itens: [], items: [], porDiaSemana: [], porHora: [], porCanal: {} }));
  w.get('/__e', (q, r) => r.type('html').send('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style><iframe id="tela" src="/restaurante/indicadores.html"></iframe>'));
  w.use(express.static(PUB));
  srv = await new Promise(res => { const s = http.createServer(w).listen(0, '127.0.0.1', () => res(s)); });
  base = `http://127.0.0.1:${srv.address().port}`;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], userDataDir: '/tmp/vp-restaurante-engenharia-chrome' });
  const page = await browser.newPage();
  const erros = [];
  page.on('pageerror', e => erros.push(e.message));
  await page.goto(base + '/__e', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2500));
  const frame = await (await page.$('#tela')).contentFrame();
  const r = await frame.evaluate(() => {
    const cor = (v) => { const e = document.createElement('span'); e.style.color = `var(${v})`; document.body.appendChild(e);
      const c = getComputedStyle(e).color; e.remove(); return c; };
    const fundo = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).backgroundColor : null; };
    return {
      titulos: [...document.querySelectorAll('#matriz .quad h3')].map(h => h.textContent.trim()),
      estrelas: [...document.querySelectorAll('#matriz .quad.estrela li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
      altura: document.getElementById('matriz').getBoundingClientRect().height,
      // tudo que o usuário lê da engenharia: os quadros e a coluna Classe da curva ABC
      texto: document.getElementById('matriz').textContent + ' ' + document.getElementById('tbCardapio').textContent,
      classes: [...document.querySelectorAll('#tbCardapio tr')].map(tr => tr.children[1].textContent.trim()),
      marcas: {
        estrela: [fundo('#matriz .quad.estrela .marca-quadrante'), cor('--success')],
        cavalo: [fundo('#matriz .quad.cavalo .marca-quadrante'), cor('--warn')],
        'peso-morto': [fundo('#matriz .quad.peso-morto .marca-quadrante'), cor('--danger')],
      },
    };
  });
  assert(r.altura > 0, 'matriz sem altura');
  const esperados = ['Vendem bem e dão lucro (3)', 'Vendem bem, mas dão pouco lucro (0)',
    'Dão lucro, mas vendem pouco (1)', 'Vendem pouco e dão pouco lucro (2)'];
  assert(JSON.stringify(r.titulos) === JSON.stringify(esperados), 'títulos: ' + JSON.stringify(r.titulos));
  assert(!/Estrela|Cavalo|Enigma|Peso.?morto|⭐|🐴|❓|💀/i.test(r.texto), 'nome ou ícone antigo na tela: '
    + (r.texto.match(/Estrela|Cavalo|Enigma|Peso.?morto|⭐|🐴|❓|💀/i) || [])[0]);
  assert(r.classes.includes('Vendem bem e dão lucro') && r.classes.includes('Vendem pouco e dão pouco lucro'),
    'coluna Classe: ' + JSON.stringify([...new Set(r.classes)]));
  for (const [k, [fundo, esperado]] of Object.entries(r.marcas)) {
    assert(fundo && fundo === esperado, `marca de ${k}: ${fundo}, esperada ${esperado}`);
  }
  assert(r.estrelas.some(x => /Prato 1 — 54,[56]% de Pratos/.test(x)), 'itens do primeiro quadro: ' + JSON.stringify(r.estrelas));
  assert(!erros.length, 'erros de JS: ' + erros.join(' | '));
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  if (browser) await browser.close();
  if (srv) srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
