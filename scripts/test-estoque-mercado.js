/**
 * Estoque, lotes e sugestão de compra, como um dono de mercado lê.
 *
 * Nasceu do levantamento do vídeo de mercado de 28/09/2026: a tela de
 * Análises abria em branco, a sugestão de compra mostrava NAS de licitação
 * do 1bit, item por quilo zerado dava giro de trilhões, lote vencido ontem
 * aparecia como "0 dias", e as listas cortavam o nome com reticências.
 *
 *   A. API: saldo arredondado, giro e cobertura, parado, ordem com acento
 *   B. API: lotes pela data de Marabá, cartões sobre todos os lotes, busca
 *   C. API: sugestão de mercado só com configuração do tenant
 *   D. telas: Análises com as cinco abas visíveis, cores e datas
 *   E. telas: Lotes, Estoque e Sugestão sem texto cortado nem termo técnico
 *   F. as outras telas com o mesmo padrão de abas abrem com uma aba visível
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const puppeteer = require('puppeteer-core');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const DB = '/tmp/vp-estoque-mercado.db';
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

// ---------- datas pela folhinha de Marabá ----------
const HOJE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Belem' }).format(new Date());
const dia = (n) => new Date(Date.parse(HOJE + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const br = (iso) => iso.split('-').reverse().join('/');

// ---------- cadastro ----------
db.prepare("INSERT OR IGNORE INTO depositos (id, nome, tipo, padrao, ativo) VALUES (1, 'Loja', 'interno', 1, 1)").run();
const forn = db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, nomeFantasia, ativo, categorias)
  VALUES ('11222333000181', 'PJ', 'DISTRIBUIDORA DE ALIMENTOS ESTRELA DO NORTE LTDA', 'Estrela do Norte', 1, '["fornecedor"]')`).run().lastInsertRowid;
// Nome fantasia do tamanho dos de verdade: é ele que empurra a tabela para fora da tela
const fornLongo = db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, nomeFantasia, ativo, categorias)
  VALUES ('44555666000181', 'PJ', 'CUIDAR DISTRIBUIDORA DE HIGIENE E PERFUMARIA LTDA', 'Cuidar Higiene e Perfumaria', 1, '["fornecedor"]')`).run().lastInsertRowid;
function produto(sku, descricao, o = {}) {
  return db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoCusto, precoVenda, estoqueMinimo, estoqueMaximo,
    rastreiaLote, fornecedorId, ativo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(sku, descricao, o.un || 'UN', o.custo ?? 5, o.preco ?? 8, o.min ?? 0, o.max ?? 0, o.lote ? 1 : 0, forn).lastInsertRowid;
}
const mov = (p, tipo, qtd, data, custo = 5) => db.prepare(`INSERT INTO movimentacoes_estoque
  (produtoId, tipo, quantidade, custoUnitario, custoMedioAnterior, custoMedioPosterior, origem, data, depositoId)
  VALUES (?, ?, ?, ?, ?, ?, 'teste', ?, 1)`).run(p, tipo, qtd, tipo === 'entrada' ? custo : null, custo, custo, data);

// Goiaba por quilo, zerada: 12,35 − 4,11 − 3,07 − 5,17 não fecha em zero no ponto flutuante
const GOIABA = produto('10001', 'Goiaba vermelha', { un: 'KG', min: 3, max: 20 });
mov(GOIABA, 'entrada', 12.35, dia(-20)); mov(GOIABA, 'saida', 4.11, dia(-15)); mov(GOIABA, 'saida', 3.07, dia(-8)); mov(GOIABA, 'saida', 5.17, dia(-2));
// Vassoura: vendeu há 140 dias e parou, com 40 no estoque
const VASSOURA = produto('10002', 'Vassoura de pelo', { min: 2, max: 10 });
mov(VASSOURA, 'entrada', 50, dia(-150)); mov(VASSOURA, 'saida', 10, dia(-140));
// Café: 60 dias de história, 2 por dia, 30 no estoque → cobertura de 15 dias
const CAFE = produto('10003', 'Café torrado 500 g', { min: 10, max: 80 });
mov(CAFE, 'entrada', 150, dia(-60));
for (let d = -59; d <= 0; d++) mov(CAFE, 'saida', 2, dia(d));
// Chiclete: zerou e tem mínimo
const CHICLETE = produto('10004', 'Chiclete (caixa com 100)', { min: 2, max: 10 });
mov(CHICLETE, 'entrada', 5, dia(-30)); mov(CHICLETE, 'saida', 5, dia(-1));
// Açúcar abaixo do mínimo
const ACUCAR = produto('10005', 'Açúcar refinado 1 kg', { min: 10, max: 40 });
mov(ACUCAR, 'entrada', 30, dia(-40)); mov(ACUCAR, 'saida', 26, dia(-3));
// Nomes com acento, para a ordem
for (const [sku, n] of [['10006', 'Água mineral 500 ml'], ['10007', 'Óleo de soja 900 ml'], ['10008', 'Arroz branco 5 kg'], ['10009', 'Ovos brancos (dúzia)'], ['10010', 'Zabumba de brinquedo']]) {
  const p = produto(sku, n, { min: 1, max: 50 }); mov(p, 'entrada', 30, dia(-10)); mov(p, 'saida', 1, dia(-1));
}
// Iogurte com lotes: vencido ontem, vence hoje, em 5, em 20, em 60, e um lote zerado
const IOGURTE = produto('10011', 'Iogurte morango com nome comprido para quebrar linha 1 kg', { lote: 1, min: 2, max: 40 });
const lote = (num, val, saldo) => db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial,
  saldoAtual, custoUnitario, fornecedorId, ativo, depositoId) VALUES (?, ?, ?, ?, 10, ?, 7.5, ?, 1, 1)`)
  .run(IOGURTE, num, dia(-40), val, saldo, forn).lastInsertRowid;
lote('260901-1A', dia(-1), 5); lote('260915-2B', dia(0), 3); lote('260920-3C', dia(5), 2);
lote('260925-4D', dia(20), 1); lote('260926-5E', dia(60), 4); lote('260910-6F', dia(10), 0);
// Um lote do fornecedor de nome longo, vencido há 13 dias: o selo mais largo que existe
db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, custoUnitario,
  fornecedorId, ativo, depositoId) VALUES (?, '260902-9H', ?, ?, 24, 11, 12.34, ?, 1, 1)`).run(IOGURTE, dia(-60), dia(-13), fornLongo);
db.prepare('UPDATE produtos SET fornecedorId = ? WHERE id IN (?, ?)').run(fornLongo, ACUCAR, CHICLETE);
mov(IOGURTE, 'entrada', 15, dia(-40));

// ---------- rotas ----------
const montar = (app) => {
  require('../estoque-routes').registrarRotasEstoque(app, db);
  require('../lotes-routes').registrarRotasLotes(app, db);
  require('../compras-routes').registrarRotasCompras(app, db);
};
const api = express();
montar(api);
function chamar(p, query = {}) {
  const l = ((api.router || api._router).stack || []).find(x => x.route && x.route.path === p && x.route.methods.get);
  if (!l) throw new Error('rota ausente: ' + p);
  return new Promise((ok2, erro) => {
    const res = { json: (x) => ok2(x), status: () => res };
    try { const r = l.route.stack.at(-1).handle({ query, params: {}, body: {}, session: {}, user: {} }, res); if (r && r.catch) r.catch(erro); }
    catch (e) { erro(e); }
  });
}
const achar = (itens, id) => itens.find(i => i.id === id);

t('A0. o cenário da goiaba tem mesmo resíduo: a soma crua não fecha em zero', () => {
  const s = db.prepare(`SELECT SUM(CASE WHEN tipo='entrada' THEN quantidade ELSE -quantidade END) s FROM movimentacoes_estoque WHERE produtoId = ?`).get(GOIABA).s;
  assert(s !== 0, 'a soma crua deu zero exato; o cenário não prova nada');
});
t('A1. item por quilo zerado tem saldo 0, e não -0 ou 1e-15, na lista, no alerta e no giro', async () => {
  const e = achar((await chamar('/api/estoque')).itens, GOIABA);
  assert(Object.is(e.saldo, 0) && Object.is(e.disponivel, 0), `lista: saldo ${e.saldo}, disponível ${e.disponivel}`);
  const g = achar((await chamar('/api/estoque/giro')).itens, GOIABA);
  assert(Object.is(g.saldoAtual, 0), 'giro: saldo ' + g.saldoAtual);
  assert(g.giro === null || g.giro < 1000, 'giro astronômico: ' + g.giro);
  const a = (await chamar('/api/estoque/alertas')).alertas.find(x => x.id === GOIABA);
  assert(a && Object.is(a.saldo, 0), 'alerta: ' + JSON.stringify(a));
  const { calcularSaldo } = require('../estoque-routes');
  assert(Object.is(calcularSaldo(db, GOIABA), 0), 'calcularSaldo: ' + calcularSaldo(db, GOIABA));
});
t('A2. produto parado há mais de 90 dias tem giro 0 e cobertura vazia', async () => {
  const g = achar((await chamar('/api/estoque/giro')).itens, VASSOURA);
  assert(g.parado === true, 'não saiu parado');
  assert(g.giro === 0 && g.coberturaDias === null, `giro ${g.giro}, cobertura ${g.coberturaDias}`);
  assert(g.ultimaSaida === dia(-140), 'última saída ' + g.ultimaSaida);
});
t('A3. cobertura divide pelo histórico que existe na janela, e não por 360 dias', async () => {
  const g = achar((await chamar('/api/estoque/giro', { meses: 12 })).itens, CAFE);
  assert(g.saldoAtual === 30, 'saldo ' + g.saldoAtual);
  assert(Math.abs(g.coberturaDias - 15) < 0.6, `cobertura ${g.coberturaDias} (dividindo por 360 dias daria 90)`);
});
t('A4. listas por nome respeitam acento: Água perto do A, Óleo perto do O', async () => {
  const nomes = (await chamar('/api/estoque')).itens.map(i => i.descricao);
  const pos = (n) => nomes.findIndex(x => x.startsWith(n));
  assert(pos('Açúcar') < pos('Água') && pos('Água') < pos('Arroz'), 'ordem do A: ' + nomes.join(' | '));
  assert(pos('Óleo') < pos('Ovos') && pos('Ovos') < pos('Vassoura'), 'ordem do O: ' + nomes.join(' | '));
  const sug = (await chamar('/api/compras/sugestao')).itens.map(i => i.descricao);
  const ord = [...sug].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
  assert(JSON.stringify(sug) === JSON.stringify(ord), 'sugestão fora de ordem: ' + sug.join(' | '));
});
t('A5. a lista informa se o tenant tem reserva e rastreio', async () => {
  const p = (await chamar('/api/estoque')).presenca;
  assert(p && p.reserva === false && p.lote === true && p.serial === false, 'presença: ' + JSON.stringify(p));
});

t('B1. validade conta pela data de Marabá: ontem é vencido, hoje vence hoje', async () => {
  const r = await chamar('/api/lotes', { comSaldo: '1' });
  assert(r.hoje === HOJE, `hoje da API ${r.hoje}, esperado ${HOJE}`);
  assert(r.resumo.vencidos === 2, 'vencidos (ontem e há 13 dias): ' + r.resumo.vencidos);
  assert(r.resumo.vencendo30 === 3, 'vencendo em 30 dias (hoje, 5 e 20): ' + r.resumo.vencendo30);
});
t('B2. os cartões contam todos os lotes, e não a lista filtrada', async () => {
  const r = await chamar('/api/lotes', { comSaldo: '1', vencendoDias: '30' });
  assert(r.lotes.length === 3, 'lista filtrada: ' + r.lotes.map(l => l.numero).join(', '));
  assert(r.resumo.total === 7 && r.resumo.comSaldo === 6 && r.resumo.vencidos === 2 && r.resumo.vencendo30 === 3,
    'resumo: ' + JSON.stringify(r.resumo));
});
t('B3. o filtro de 30 dias não traz o lote vencido', async () => {
  const r = await chamar('/api/lotes', { vencendoDias: '30' });
  assert(!r.lotes.some(l => l.dataValidade < HOJE), 'veio vencido: ' + r.lotes.map(l => l.dataValidade).join(', '));
});
t('B4. a busca de lotes acha pelo nome e pelo código do produto', async () => {
  assert((await chamar('/api/lotes', { q: 'iogurte' })).lotes.length === 7, 'por nome');
  assert((await chamar('/api/lotes', { q: '10011' })).lotes.length === 7, 'por código');
  assert((await chamar('/api/lotes', { q: 'vassoura' })).lotes.length === 0, 'produto sem lote');
});
t('B5. o fornecedor aparece pelo nome fantasia', async () => {
  const l = (await chamar('/api/lotes')).lotes.find(x => x.numero === '260901-1A');
  assert(l.fornecedorNome === 'Estrela do Norte', 'fornecedor: ' + l.fornecedorNome);
});

t('C1. sem configuração do tenant, a sugestão de mercado não devolve nada', async () => {
  const r = await chamar('/api/compras/sugestao-mercado');
  assert(r.success && r.configurado === false && r.oportunidades.length === 0, JSON.stringify(r));
});
t('C2. nem a tela nem a rota assumem o grupo 14 e a TerraMaster', () => {
  const tela = fs.readFileSync(path.join(PUB, 'compras/sugestao.html'), 'utf8');
  assert(!/\|\|\s*'14'|\|\|\s*'TerraMaster'/.test(tela), 'padrão fixo na tela');
  const rota = fs.readFileSync(path.join(RAIZ, 'compras-routes.js'), 'utf8');
  assert(!/grupoId\s*=\s*14|'TerraMaster'/.test(rota), 'padrão fixo na rota');
});

// ---------- telas ----------
const CHROME = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
let browser, srv, base;
async function abrir(tela, largura = 1190) {
  if (!browser) {
    const w = express();
    montar(w);
    w.use('/api', (q, r) => r.json({ success: true, itens: [], depositos: [], pontos: [], produtos: [], porMes: [], porProduto: [] }));
    // O pai se declara shell, como o app.html: a tela não desenha o próprio
    // menu e fica com a largura que tem no sistema de verdade.
    w.get('/__e', (q, r) => r.type('html').send(`<!doctype html><meta charset="utf-8"><script>window.__liciteShell = true;</script><style>html,body{margin:0;height:100%}
      iframe{border:0;width:${q.query.w}px;height:100%;display:block}</style><iframe id="tela" src="${q.query.t}"></iframe>`));
    w.use(express.static(PUB));
    srv = await new Promise(res => { const s = http.createServer(w).listen(0, '127.0.0.1', () => res(s)); });
    base = `http://127.0.0.1:${srv.address().port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], userDataDir: '/tmp/vp-estoque-mercado-chrome', protocolTimeout: 60000 });
  }
  const page = await browser.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.setViewport({ width: 1440, height: 900 });
  const erros = [];
  page.on('pageerror', e => erros.push(e.message));
  // Largura de coluna salva de outra rodada não pode mascarar o corte
  await page.goto(base + '/__e?w=1&t=about:blank');
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/__e?w=${largura}&t=${encodeURIComponent(tela)}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 3000));
  const frame = await (await page.$('#tela')).contentFrame();
  return { page, frame, erros };
}
// Nenhuma célula (fora a do nome do produto) e nenhum título com texto escondido
const cortes = (frame, sel) => frame.evaluate((sel) => {
  const wrap = document.querySelector(sel);
  const out = [];
  if (wrap.scrollWidth > wrap.clientWidth + 1) out.push(`rolagem horizontal: ${wrap.scrollWidth} > ${wrap.clientWidth}`);
  // O .tbl-wrap recorta o que passa da borda sem mostrar barra: a tabela
  // tem de caber nele, ou a última coluna some sem aviso.
  const larg = wrap.querySelector('table').getBoundingClientRect().width;
  if (larg > wrap.clientWidth + 1) out.push(`tabela mais larga que a tela: ${Math.round(larg)} > ${wrap.clientWidth}`);
  const medir = (el) => {
    if (el.offsetParent === null) return;
    const r = document.createRange(); r.selectNodeContents(el);
    const txt = r.getBoundingClientRect().width;
    const cs = getComputedStyle(el);
    const util = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (txt > util + 1 || el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName} "${el.textContent.trim().slice(0, 30)}" (${Math.round(txt)} > ${Math.round(util)})`);
  };
  wrap.querySelectorAll('th, td').forEach(medir);
  return out;
}, sel);
const cor = (frame, expr) => frame.evaluate((expr) => {
  const e = document.createElement('span'); e.style.color = expr; document.body.appendChild(e);
  const c = getComputedStyle(e).color; e.remove(); return c;
}, expr);

t('D1. Análises: as cinco abas aparecem, cada uma quando é aberta', async () => {
  const { frame, erros } = await abrir('/estoque/analises.html');
  const res = [];
  for (const aba of ['valorizacao', 'abc', 'giro', 'cmv', 'lucro']) {
    await frame.evaluate((a) => document.querySelector(`.tab[data-tab="${a}"]`).click(), aba);
    await new Promise(r => setTimeout(r, 900));
    res.push(await frame.evaluate((a) => {
      const vis = [...document.querySelectorAll('.tab-content')].filter(x => x.getBoundingClientRect().height > 0).map(x => x.id);
      return `${a}: ${vis.join(',') || 'nenhuma'}`;
    }, aba));
  }
  const esperado = ['valorizacao', 'abc', 'giro', 'cmv', 'lucro'].map(a => `${a}: tab-${a}`);
  assert(JSON.stringify(res) === JSON.stringify(esperado), res.join(' · '));
  assert(!erros.length, 'erros de JS: ' + erros.join(' | '));
});
t('D2. Análises/giro: parado com giro 0 e cobertura "—", zerado SEM ESTOQUE, última saída em data', async () => {
  const { frame } = await abrir('/estoque/analises.html');
  await frame.evaluate(() => document.querySelector('.tab[data-tab="giro"]').click());
  await new Promise(r => setTimeout(r, 1500));
  const linhas = await frame.evaluate(() => Object.fromEntries([...document.querySelectorAll('#tbGiro tr')]
    .map(tr => [tr.children[1].textContent.trim(), [...tr.children].map(td => td.textContent.trim())])));
  const v = linhas['Vassoura de pelo'];
  assert(v && v[4] === '0,00' && v[5] === '—' && v[7] === 'PARADO', 'vassoura: ' + JSON.stringify(v));
  assert(v[6] === br(dia(-140)), 'última saída da vassoura: ' + v[6]);
  for (const n of ['Goiaba vermelha', 'Chiclete (caixa com 100)']) {
    assert(linhas[n] && linhas[n][7] === 'SEM ESTOQUE', n + ': ' + JSON.stringify(linhas[n]));
  }
  assert(linhas['Goiaba vermelha'][2] === '0,00', 'saldo da goiaba: ' + linhas['Goiaba vermelha'][2]);
  const texto = await frame.evaluate(() => document.getElementById('tbGiro').textContent);
  assert(!/-0,00/.test(texto), 'apareceu "-0,00"');
  assert(!/\b\d+d\b/.test(texto), 'ainda há "132d": ' + (texto.match(/\b\d+d\b/) || [])[0]);
});
t('D3. Análises/ABC: total em cor neutra, classe C no mesmo cinza da legenda', async () => {
  const { frame } = await abrir('/estoque/analises.html');
  await frame.evaluate(() => document.querySelector('.tab[data-tab="abc"]').click());
  await new Promise(r => setTimeout(r, 1500));
  const r = await frame.evaluate(() => {
    const k = [...document.querySelectorAll('#kpisAbc .kpi')];
    const borda = (x) => getComputedStyle(x).borderLeftColor;
    const seg = document.querySelector('#abcBarra .seg-c');
    return { total: borda(k[3]), c: borda(k[2]), segC: seg ? getComputedStyle(seg).backgroundColor : null,
      legenda: document.getElementById('abcLegenda').textContent, cabec: document.querySelector('#tab-abc thead').textContent };
  });
  assert(r.total !== await cor(frame, 'var(--danger)'), 'total ainda vermelho');
  assert(r.c === r.segC && r.c === await cor(frame, 'var(--text-3)'), `classe C: cartão ${r.c}, barra ${r.segC}`);
  assert(/C \(cinza\)/.test(r.legenda), 'legenda: ' + r.legenda);
  assert(/Código/.test(r.cabec) && !/SKU/.test(r.cabec), 'cabeçalho: ' + r.cabec);
});

t('E1. Lotes: cartões sobre todos os lotes, validade por data, laranja até 7 dias', async () => {
  const { frame, erros } = await abrir('/estoque/lotes.html');
  await frame.select('#filtVencimento', '30');
  await new Promise(r => setTimeout(r, 1500));
  const r = await frame.evaluate(() => ({
    cartoes: [...document.querySelectorAll('#kpis .kpi')].map(k => k.querySelector('.label').textContent.trim() + '=' + k.querySelector('.value').textContent.trim()),
    selos: [...document.querySelectorAll('#tb .badge')].map(b => [b.className, b.textContent.trim(), getComputedStyle(b).color]),
    placeholder: document.getElementById('filtProduto').placeholder,
    texto: document.body.innerText,
  }));
  assert(JSON.stringify(r.cartoes) === JSON.stringify(['Total de lotes=7', 'Com saldo=6', 'Vencendo em 30d=3', 'Vencidos=2']),
    'cartões com filtro de 30 dias: ' + r.cartoes.join(', '));
  const hoje = r.selos.find(s => s[1].includes('vence hoje'));
  const cinco = r.selos.find(s => s[1].includes('em 5 dias'));
  const vinte = r.selos.find(s => s[1].includes('em 20 dias'));
  assert(hoje && cinco && vinte, 'selos: ' + JSON.stringify(r.selos.map(s => s[1])));
  const laranja = hoje[2], vermelho = await cor(frame, 'var(--danger)'), ambar = await cor(frame, 'var(--warn)');
  assert(cinco[2] === laranja && laranja !== vermelho && laranja !== ambar, `até 7 dias: ${laranja} (vermelho ${vermelho}, âmbar ${ambar})`);
  assert(vinte[2] === ambar, 'até 30 dias: ' + vinte[2]);
  assert(r.placeholder === 'Filtrar por produto (nome ou código)', 'placeholder: ' + r.placeholder);
  assert(!/produtoId|SKU/.test(r.texto), 'termo técnico na tela');
  assert(!erros.length, 'erros de JS: ' + erros.join(' | '));
});
t('E2. Lotes: vencido ontem sai vermelho como vencido, e a busca filtra pelo nome', async () => {
  const { frame } = await abrir('/estoque/lotes.html');
  const selo = await frame.evaluate(() => [...document.querySelectorAll('#tb .badge')].map(b => [b.className, b.textContent.trim()]));
  const ontem = selo.find(s => /há 1 dia/.test(s[1]));
  assert(ontem && /cancelado/.test(ontem[0]) && /há 1 dia/.test(ontem[1]), 'lote de ontem: ' + JSON.stringify(ontem));
  await frame.type('#filtProduto', 'vassoura');
  await new Promise(r => setTimeout(r, 1500));
  const n = await frame.evaluate(() => document.querySelectorAll('#tb tr td.col-produto').length);
  assert(n === 0, 'a busca por "vassoura" trouxe ' + n + ' lote(s)');
});
t('E3. Lotes: nada cortado, só o nome do produto quebra linha', async () => {
  const { frame } = await abrir('/estoque/lotes.html');
  const c = await cortes(frame, '.tbl-nao-corta');
  assert(!c.length, c.join(' · '));
});
t('E4. Estoque: SEM ESTOQUE no zerado, nome no aviso, sem reserva, ordem com acento, nada cortado', async () => {
  const { frame, erros } = await abrir('/estoque/estoque.html');
  const r = await frame.evaluate(() => ({
    aviso: document.getElementById('alertasBox').textContent,
    cabec: [...document.querySelectorAll('thead th')].filter(th => th.offsetParent !== null).map(th => th.textContent.trim()),
    cartoes: [...document.querySelectorAll('#kpis .label')].map(l => l.textContent.trim()),
    status: Object.fromEntries([...document.querySelectorAll('#tbSaldo tr')].map(tr => [tr.children[1].textContent.trim(), tr.lastElementChild.textContent.trim()])),
    nomes: [...document.querySelectorAll('#tbSaldo tr')].map(tr => tr.children[1].textContent.trim()),
    serial: getComputedStyle(document.getElementById('rotRastreiaSerial')).display,
    lote: getComputedStyle(document.getElementById('rotRastreiaLote')).display,
    texto: document.body.innerText,
  }));
  assert(r.status['Chiclete (caixa com 100)'] === 'SEM ESTOQUE' && r.status['Goiaba vermelha'] === 'SEM ESTOQUE', 'status: ' + JSON.stringify(r.status));
  assert(/Açúcar refinado 1 kg/.test(r.aviso), 'aviso sem o nome: ' + r.aviso);
  assert(!r.cabec.includes('Reservado') && !r.cartoes.some(x => /reserv/i.test(x)), 'reserva à mostra: ' + r.cabec.join('|') + ' / ' + r.cartoes.join('|'));
  assert(r.cabec.includes('Rastreio') && r.lote !== 'none' && r.serial === 'none', `rastreio: coluna ${r.cabec.includes('Rastreio')}, lote ${r.lote}, serial ${r.serial}`);
  assert(r.cabec[0] === 'Código', 'cabeçalho: ' + r.cabec.join('|'));
  assert(r.nomes.indexOf('Água mineral 500 ml') < r.nomes.indexOf('Arroz branco 5 kg'), 'ordem: ' + r.nomes.join(' | '));
  assert(!/-0,00|SKU/.test(r.texto), 'texto: -0,00 ou SKU na tela');
  const c = await cortes(frame, '.tbl-nao-corta');
  assert(!c.length, c.join(' · '));
  assert(!erros.length, 'erros de JS: ' + erros.join(' | '));
});
t('E5. Sugestão: a lista vem primeiro, sem oportunidades de mercado, e nada cortado', async () => {
  const { frame, erros } = await abrir('/compras/sugestao.html');
  const r = await frame.evaluate(() => {
    const lista = document.querySelector('.tbl-nao-corta').getBoundingClientRect().top;
    const mercado = document.getElementById('mercadoSection');
    return { lista, mercadoVisivel: mercado.getBoundingClientRect().height > 0,
      mercadoDepois: !!(mercado.compareDocumentPosition(document.querySelector('.tbl-nao-corta')) & Node.DOCUMENT_POSITION_PRECEDING),
      texto: document.body.innerText, linhas: document.querySelectorAll('#tb tr .qtd-input').length };
  });
  assert(!r.mercadoVisivel && !/Oportunidades|Sync histórico|Mercado total/.test(r.texto), 'bloco de mercado à mostra');
  assert(r.mercadoDepois, 'o bloco de mercado vem antes da lista no HTML');
  assert(r.linhas > 0, 'nenhum item sugerido');
  assert(!/SKU/.test(r.texto), 'SKU na tela');
  const c = await cortes(frame, '.tbl-nao-corta');
  assert(!c.length, c.join(' · '));
  assert(!erros.length, 'erros de JS: ' + erros.join(' | '));
});

t('F1. as outras telas com .tab-content abrem com uma aba visível', async () => {
  const telas = require('child_process')
    .execFileSync('grep', ['-rl', '--include=*.html', 'class="tab-content', PUB]).toString().trim().split('\n')
    .map(f => '/' + path.relative(PUB, f));
  const vazias = [];
  for (const tela of telas) {
    const { page, frame } = await abrir(tela);
    // Por grupo de abas: se o contêiner está à mostra, uma aba dele tem de
    // aparecer. Aba dentro de modal fechado (contas a pagar e a receber) não conta.
    const vis = await frame.evaluate(() => {
      const grupos = new Map();
      document.querySelectorAll('.tab-content').forEach(x => grupos.set(x.parentElement, [...(grupos.get(x.parentElement) || []), x]));
      return [...grupos].filter(([pai]) => pai.getBoundingClientRect().height > 0)
        .every(([, abas]) => abas.some(x => x.getBoundingClientRect().height > 0));
    });
    if (!vis) vazias.push(tela);
    await page.close();
  }
  assert(telas.length >= 9, 'achei só ' + telas.length + ' telas');
  assert(!vazias.length, 'abrem sem aba: ' + vazias.join(', '));
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
