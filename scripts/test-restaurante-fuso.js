/**
 * Restaurante no horário de Marabá, e a cor do CMV% nas duas tabelas.
 *
 * O módulo grava tudo em UTC. Quem lê está em America/Belem (UTC−3). Sem
 * converter, a conta fechada às 22h caía no dia seguinte, o sábado à noite
 * contava como domingo, o pico saía três horas adiantado e o turno aberto às
 * 10:30 aparecia como 13:30.
 *
 * As comandas têm valores distintos para a soma denunciar o dia errado:
 *   C1  R$ 100   sáb 19/09 22:30 em Marabá = 2026-09-20 01:30 UTC
 *   C2  R$  10   sáb 19/09 13:00 em Marabá = 2026-09-19 16:00 UTC
 *   C3  R$1000   sex 18/09 23:00 em Marabá = 2026-09-19 02:00 UTC
 * O sábado certo soma 110. Cortando em UTC, somaria 1010.
 *
 *   A. rotas do restaurante (indicadores, cardápio, garçons, cancelamentos,
 *      gorjeta, delivery, CMV)
 *   B. filtro de período das OS
 *   C. telas: CMV% colorido na Ficha e na aba CMV, horas no fuso de Marabá
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const puppeteer = require('puppeteer-core');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');

const DB = '/tmp/vp-restaurante-fuso.db';
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
const perto = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// ---------- dados ----------
const garcom = db.prepare("INSERT INTO users (username, passwordHash, nome, role, ativo) VALUES ('g1', 'x', 'Garçom Um', 'garcom', 0)").run().lastInsertRowid;
const mesa = db.prepare("INSERT INTO rest_mesas (numero) VALUES ('1')").run().lastInsertRowid;
const insumo = db.prepare("INSERT INTO produtos (sku, descricao, unidade, precoCusto, precoVenda) VALUES ('I1', 'Insumo', 'KG', 10, 0)").run().lastInsertRowid;
const prato = db.prepare("INSERT INTO produtos (sku, descricao, unidade, precoCusto, precoVenda) VALUES ('P1', 'Prato', 'UN', 0, 10)").run().lastInsertRowid;
const ficha = db.prepare('INSERT INTO rest_fichas (produtoId, rendimento) VALUES (?, 1)').run(prato).lastInsertRowid;
db.prepare("INSERT INTO rest_ficha_itens (fichaId, insumoProdutoId, quantidadeBruta, unidade) VALUES (?, ?, 0.3, 'KG')").run(ficha, insumo);

function comanda(fechadaUtc, valor) {
  const id = db.prepare(`INSERT INTO rest_comandas (tipo, mesaId, canal, status, abertaEm, fechadaEm, garcomUserId,
    totalItens, totalTaxaServico, totalGeral, totalPago) VALUES ('mesa', ?, 'salao', 'fechada', ?, ?, ?, ?, ?, ?, ?)`)
    .run(mesa, fechadaUtc, fechadaUtc, garcom, valor, valor / 10, valor, valor).lastInsertRowid;
  db.prepare(`INSERT INTO rest_comanda_itens (comandaId, produtoId, descricao, quantidade, precoUnit, precoTotal, status, garcomUserId, lancadoEm)
    VALUES (?, ?, 'Prato', ?, 10, ?, 'entregue', ?, ?)`).run(id, prato, valor / 10, valor, garcom, fechadaUtc);
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, origem, origemId, data)
    VALUES (?, 'saida', ?, 10, 'comanda', ?, ?)`).run(insumo, 0.3 * valor / 10, id, fechadaUtc);
  return id;
}
const C1 = comanda('2026-09-20 01:30:00', 100);
const C2 = comanda('2026-09-19 16:00:00', 10);
const C3 = comanda('2026-09-19 02:00:00', 1000);
// item cancelado no sábado às 22:40 de Marabá
db.prepare(`INSERT INTO rest_comanda_itens (comandaId, produtoId, descricao, quantidade, precoUnit, precoTotal, status, garcomUserId,
  lancadoEm, canceladoEm, canceladoMotivo) VALUES (?, ?, 'Prato', 1, 10, 10, 'cancelado', ?, '2026-09-20 01:35:00', '2026-09-20 01:40:00', 'desistiu')`)
  .run(C1, prato, garcom);
// entrega concluída no sábado às 22:50 de Marabá
const entregador = db.prepare("INSERT INTO rest_entregadores (nome) VALUES ('Moto 1')").run().lastInsertRowid;
db.prepare(`INSERT INTO rest_entregas (comandaId, entregadorId, status, entregueEm) VALUES (?, ?, 'entregue', '2026-09-20 01:50:00')`).run(C1, entregador);

// ---------- rotas do restaurante, chamadas direto ----------
const app = express();
const gate = (q, r, n) => n();
require('../restaurante/restaurante-indicadores').registrarRotasIndicadores(app, db, gate);
require('../restaurante/restaurante-ficha').registrarRotasFicha(app, db, gate);
require('../restaurante/restaurante-delivery').registrarRotasDelivery(app, db, gate, { lerConfig: () => ({}) });
const { apurar } = require('../restaurante/restaurante-gorjeta');
function chamar(p, query = {}, params = {}) {
  const l = ((app.router || app._router).stack || []).find(x => x.route && x.route.path === p && x.route.methods.get);
  if (!l) throw new Error('rota ausente: ' + p);
  let out = null;
  const res = { json: x => { out = x; return res; }, status: () => res };
  l.route.stack.at(-1).handle({ query, params, body: {} }, res);
  return out;
}
const SAB = { de: '2026-09-19', ate: '2026-09-19' };

t('A1. o sábado soma as contas do sábado em Marabá, inclusive a das 22:30', () => {
  const d = chamar('/api/restaurante/indicadores', SAB);
  assert(perto(d.faturamento, 110), `faturamento do sábado ${d.faturamento} (110 certo; 1010 é o corte em UTC)`);
});
t('A2. dia da semana: a conta de sábado 22:30 é sábado, e a de sexta 23:00 é sexta', () => {
  const d = chamar('/api/restaurante/indicadores');
  const dia = Object.fromEntries(d.porDiaSemana.map(x => [x.dia, x.total]));
  assert(perto(dia[6], 110) && perto(dia[5], 1000) && !dia[0], 'por dia: ' + JSON.stringify(dia));
});
t('A3. horário de pico na hora de Marabá: 22h, 13h e 23h', () => {
  const d = chamar('/api/restaurante/indicadores');
  const horas = d.porHora.map(x => x.hora).sort((a, b) => a - b);
  assert(JSON.stringify(horas) === JSON.stringify([13, 22, 23]), 'horas: ' + JSON.stringify(horas));
});
t('A4. cardápio e garçons usam o mesmo corte do sábado', () => {
  const c = chamar('/api/restaurante/indicadores/cardapio', SAB);
  const receita = (c.linhas || c.items || c.itens || []).reduce((s, l) => s + Number(l.receita || 0), 0);
  assert(perto(receita, 110), 'receita do cardápio no sábado: ' + receita);
  const g = chamar('/api/restaurante/indicadores/garcons', SAB);
  assert(perto(g.items[0].vendido, 110), 'vendido pelo garçom no sábado: ' + JSON.stringify(g.items));
});
t('A5. cancelamento das 22:40 de sábado entra no sábado', () => {
  const d = chamar('/api/restaurante/indicadores/cancelamentos', SAB);
  const itens = d.items || d.itens || [];
  assert(itens.length === 1, 'cancelamentos no sábado: ' + itens.length);
});
t('A6. gorjeta do sábado: 10% de 110', () => {
  const r = apurar(db, SAB.de, SAB.ate);
  const total = r.totalGorjeta != null ? r.totalGorjeta : r.total;
  assert(perto(total > 100 ? total / 100 : total, 11), 'gorjeta: ' + JSON.stringify(total));
});
t('A7. acerto do entregador: a entrega das 22:50 de sábado entra no sábado', () => {
  const d = chamar('/api/restaurante/entregadores/:id/acerto', SAB, { id: entregador });
  assert((d.entregas || []).length === 1, 'entregas no sábado: ' + JSON.stringify(d).slice(0, 200));
});
t('A8. CMV do sábado: receita e custo real das contas de sábado em Marabá', () => {
  const d = chamar('/api/restaurante/cmv', SAB);
  assert(perto(d.receitaTotal, 110), 'receita ' + d.receitaTotal);
  assert(perto(d.cmvReal, 0.3 * 11 * 10), 'CMV real ' + d.cmvReal);
});

// ---------- B. OS ----------
t('B1. relatório de OS: a OS aberta às 22h de sábado entra no filtro de sábado', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'os-routes.js'), 'utf8');
  const m = src.match(/function filtroPeriodo\(req\) \{[\s\S]*?\n  \}/);
  assert(m, 'filtroPeriodo não encontrado');
  const filtroPeriodo = new Function(m[0] + '; return filtroPeriodo;')();
  const f = filtroPeriodo({ query: SAB });
  db.exec("CREATE TABLE IF NOT EXISTS os_t (id INTEGER PRIMARY KEY, dataAbertura TEXT)");
  db.prepare("INSERT INTO os_t (dataAbertura) VALUES ('2026-09-20 01:00:00'), ('2026-09-19 02:00:00')").run();
  const n = db.prepare(`SELECT COUNT(*) n FROM os_t o WHERE 1=1${f.where}`).get(...f.params).n;
  const sab = db.prepare(`SELECT id FROM os_t o WHERE 1=1${f.where}`).get(...f.params);
  assert(n === 1 && sab.id === 1, `OS no sábado: ${n} (a de sábado 22h é a id 1; a de sexta 23h não entra)`);
});

// ---------- C. telas ----------
const CHROME = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
let browser, srv, base;
const FICHAS = [
  { produtoId: 1, descricao: 'Barato', sku: 'A', totalInsumos: 1, rendimento: 1, unidadeRendimento: 'UN', custoPorcao: 3, precoVenda: 10, cmvPct: 30 },
  { produtoId: 2, descricao: 'Médio', sku: 'B', totalInsumos: 1, rendimento: 1, unidadeRendimento: 'UN', custoPorcao: 4, precoVenda: 10, cmvPct: 40 },
  { produtoId: 3, descricao: 'Caro', sku: 'C', totalInsumos: 1, rendimento: 1, unidadeRendimento: 'UN', custoPorcao: 5, precoVenda: 10, cmvPct: 50 },
];
function subir() {
  const w = express();
  w.get('/api/restaurante/fichas', (q, r) => r.json({ success: true, items: FICHAS }));
  w.get('/api/restaurante/cmv', (q, r) => r.json({ success: true, receitaTotal: 30, cmvTeorico: 12, cmvReal: 12, diferenca: 0,
    cmvTeoricoPct: 40, cmvRealPct: 40, referencia: { min: 28, max: 35 },
    itens: FICHAS.map(f => ({ descricao: f.descricao, quantidade: 1, receita: 10, custoUnitario: f.custoPorcao, custoTotal: f.custoPorcao, margem: 10 - f.custoPorcao, cmvPct: f.cmvPct })) }));
  w.get('/api/restaurante/turnos/atual', (q, r) => r.json({ success: true, turno: { id: 7, operadorNome: 'Socorro', abertoEm: '2026-09-24 13:30:00',
    valorAbertura: 200, totalRecebido: 0, sangrias: 0, suprimentos: 0, esperadoEmDinheiro: 200, comandasFechadas: 0, porMeio: [] } }));
  w.use('/api', (q, r) => r.json({ success: true, items: [], contas: [], comandas: [], porDiaSemana: [], porHora: [], porCanal: {}, linhas: [] }));
  w.get('/__e', (q, r) => r.type('html').send(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style><iframe id="tela" src="${q.query.t}"></iframe>`));
  w.use(express.static(PUB));
  return new Promise(res => { const s = http.createServer(w).listen(0, '127.0.0.1', () => res(s)); });
}
async function abrir(tela) {
  const page = await browser.newPage();
  const erros = [];
  page.on('pageerror', e => erros.push(e.message));
  await page.goto(`${base}/__e?t=${encodeURIComponent(tela)}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2500));
  return { page, frame: await (await page.$('#tela')).contentFrame(), erros };
}
// Cor que o navegador calcula para uma variável do tema, para comparar com a da célula
const corDe = (frame, v) => frame.evaluate((v) => { const e = document.createElement('span'); e.style.color = `var(${v})`;
  document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c; }, v);

t('C1. Ficha Técnica: CMV% verde, amarelo e vermelho, visível na lista', async () => {
  const { page, frame, erros } = await abrir('/restaurante/ficha-tecnica.html');
  try {
    const cores = await frame.evaluate(() => [...document.querySelectorAll('#tbFichas tr')].map(tr => {
      const el = tr.children[5].querySelector('span') || tr.children[5];
      return getComputedStyle(el).color;
    }));
    const [ok_, warn, danger] = [await corDe(frame, '--success'), await corDe(frame, '--warn'), await corDe(frame, '--danger')];
    assert(cores[0] === ok_ && cores[1] === warn && cores[2] === danger,
      `cores ${JSON.stringify(cores)} esperadas ${JSON.stringify([ok_, warn, danger])}`);
    assert(!erros.length, 'erros de JS: ' + erros.join(' | '));
  } finally { await page.close(); }
});
t('C2. Indicadores, aba CMV: a coluna CMV% também sai colorida', async () => {
  const { page, frame, erros } = await abrir('/restaurante/indicadores.html');
  try {
    await frame.evaluate(() => carregarCmv());
    await new Promise(r => setTimeout(r, 800));
    const cores = await frame.evaluate(() => [...document.querySelectorAll('#tbCmv tr')].map(tr => {
      const el = tr.children[6].querySelector('span') || tr.children[6];
      return getComputedStyle(el).color;
    }));
    const esperadas = [await corDe(frame, '--success'), await corDe(frame, '--warn'), await corDe(frame, '--danger')];
    assert(JSON.stringify(cores) === JSON.stringify(esperadas), `cores ${JSON.stringify(cores)} esperadas ${JSON.stringify(esperadas)}`);
    assert(!erros.length, 'erros de JS: ' + erros.join(' | '));
  } finally { await page.close(); }
});
t('C3. Caixa: turno aberto às 13:30 UTC aparece como 10:30 de Marabá', async () => {
  const { page, frame, erros } = await abrir('/restaurante/caixa.html');
  try {
    const txt = await frame.evaluate(() => document.getElementById('turnoBox').textContent);
    assert(/24\/09\/2026,? 10:30/.test(txt) && !/13:30/.test(txt), 'caixa: ' + txt.replace(/\s+/g, ' ').slice(0, 160));
    assert(!erros.length, 'erros de JS: ' + erros.join(' | '));
  } finally { await page.close(); }
});
t('C4. as quatro telas convertem para Marabá, de UTC com ou sem "Z"', async () => {
  const { page, frame } = await abrir('/restaurante/salao.html');
  try {
    const r = await frame.evaluate(() => [horaLocal('2026-09-20 01:30:00'), horaLocal('2026-09-20T01:30:00Z'), horaLocal(null)]);
    assert(/19\/09\/2026,? 22:30/.test(r[0]) && r[0] === r[1] && r[2] === '', 'salão: ' + JSON.stringify(r));
  } finally { await page.close(); }
  for (const tela of ['/restaurante/delivery.html', '/restaurante/indicadores.html']) {
    const { page: p, frame: f } = await abrir(tela);
    try {
      const r = await f.evaluate(() => horaLocal('2026-09-20 01:40:00'));
      assert(/19\/09\/2026,? 22:40/.test(r), tela + ': ' + r);
    } finally { await p.close(); }
  }
});

(async () => {
  for (const [nome, fn] of fila) {
    if (nome.startsWith('C1') && !browser) {
      srv = await subir(); base = `http://127.0.0.1:${srv.address().port}`;
      browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], userDataDir: '/tmp/vp-restaurante-fuso-chrome' });
    }
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  if (browser) await browser.close();
  if (srv) srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
