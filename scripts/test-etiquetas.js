/**
 * Teste das opções de etiqueta: catálogo de modelos, campos configuráveis,
 * QR, ZPL derivado do tamanho em mm e limites de validação.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const et = require('../etiquetas-routes');

const DB = '/tmp/vp-etiq.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(`CREATE TABLE produtos (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT, descricao TEXT,
  precoVenda REAL, codigoBarras TEXT, unidade TEXT, ativo INTEGER DEFAULT 1)`);

const app = express();
et.registrarRotasEtiquetas(app, db);
const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};

function chamar(h, query = {}) {
  return new Promise(resolve => {
    let out = null, st = 200, headers = {};
    const res = {
      json: x => { out = x; resolve({ out, st, headers, texto: null }); return res; },
      status: c => { st = c; return res; },
      setHeader: (k, v) => { headers[k] = v; },
      send: t => { resolve({ out: null, st, headers, texto: t }); },
    };
    const r = h({ query, params: {}, body: {}, session: {}, user: {} }, res);
    if (r && typeof r.then === 'function') r.then(() => { if (out) resolve({ out, st, headers, texto: null }); });
  });
}

let ok = 0, fail = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- seed ----------
db.prepare("INSERT INTO produtos (id, sku, descricao, precoVenda, codigoBarras, unidade) VALUES (1,'SKU-1','Produto com EAN',19.9,'7891234567895','UN')").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, precoVenda, codigoBarras, unidade) VALUES (2,'SKU-2','Produto sem EAN',5,NULL,'CX')").run();

(async () => {

await t('catálogo de modelos é servido pelo backend', async () => {
  const r = await chamar(achar('/api/etiquetas/modelos', 'get'));
  assert(r.out.success, 'erro');
  assert(r.out.a4.length >= 8, 'modelos A4: ' + r.out.a4.length);
  assert(r.out.zpl.length >= 5, 'modelos ZPL: ' + r.out.zpl.length);
  assert(r.out.campos.length === 5, 'campos: ' + r.out.campos.length);
  assert(r.out.tiposCodigo.length === 3, 'tipos de código: ' + r.out.tiposCodigo.length);
  assert(r.out.folha.larguraMm === 210, 'folha A4');
});

await t('toda grade A4 cabe na folha', async () => {
  for (const m of et.MODELOS_A4) {
    const larg = m.cols * m.larguraMm + (m.cols - 1) * m.gapXMm;
    const alt = m.rows * m.alturaMm + (m.rows - 1) * m.gapYMm;
    assert(larg <= 210.01, `${m.id} estoura a largura: ${larg}`);
    assert(alt <= 297.01, `${m.id} estoura a altura: ${alt}`);
  }
});

await t('modelos têm id único', async () => {
  const ids = [...et.MODELOS_A4, ...et.MODELOS_ZPL].map(m => m.id);
  assert(new Set(ids).size === ids.length, 'id duplicado entre modelos');
});

// ---------- dados / QR ----------
await t('dados escolhem EAN quando válido e SKU quando não', async () => {
  const r = await chamar(achar('/api/etiquetas/dados', 'get'), { ids: '1,2' });
  const p1 = r.out.produtos.find(p => p.id === 1);
  const p2 = r.out.produtos.find(p => p.id === 2);
  assert(p1.simbologia === 'ean' && p1.codigo === '7891234567895', 'p1: ' + JSON.stringify(p1));
  assert(p2.simbologia === 'code128' && p2.codigo === 'SKU-2', 'p2: ' + JSON.stringify(p2));
  assert(p1.unidade === 'UN', 'unidade não veio');
});

await t('QR é gerado no servidor quando pedido', async () => {
  const r = await chamar(achar('/api/etiquetas/dados', 'get'), { ids: '1', qr: '1' });
  assert(r.out.qrDisponivel === true, 'qrcode indisponível neste ambiente');
  const p = r.out.produtos[0];
  assert(p.qrSvg && p.qrSvg.startsWith('<svg'), 'QR não veio como SVG');
  assert(p.qrSvg.length > 200, 'SVG suspeito de vazio: ' + p.qrSvg.length);
});

await t('sem qr=1 não gera SVG (payload leve)', async () => {
  const r = await chamar(achar('/api/etiquetas/dados', 'get'), { ids: '1' });
  assert(!r.out.produtos[0].qrSvg, 'gerou QR sem pedir');
});

// ---------- ZPL ----------
await t('ZPL declara largura e altura do rolo', async () => {
  const r = await chamar(achar('/api/etiquetas/zpl', 'get'), { itens: '1:1', larguraMm: '50', alturaMm: '30', colunas: '1' });
  assert(r.texto, 'sem corpo');
  // 50mm * 8 dots/mm = 400; 30mm = 240
  assert(/\^PW400/.test(r.texto), '^PW ausente/errado: ' + r.texto.slice(0, 120));
  assert(/\^LL24[0-9]/.test(r.texto), '^LL ausente/errado');
});

await t('ZPL 2 colunas desloca a segunda etiqueta', async () => {
  const r = await chamar(achar('/api/etiquetas/zpl', 'get'), { itens: '1:2', larguraMm: '33', alturaMm: '22', colunas: '2' });
  const blocos = r.texto.split('^XA').filter(Boolean);
  assert(blocos.length === 1, 'esperava 1 bloco com 2 etiquetas, veio ' + blocos.length);
  // Em vez de fixar o número, compara as duas posições: a 2ª coluna tem
  // de estar adiante da 1ª por aproximadamente a largura da etiqueta.
  // Cada etiqueta gera várias linhas no mesmo x — interessa o conjunto de
  // colunas distintas, não a ordem das linhas.
  const colunas = [...new Set([...r.texto.matchAll(/\^FO(\d+),\d+\^A0N/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  assert(colunas.length === 2, 'esperava 2 colunas distintas, veio ' + JSON.stringify(colunas));
  const largura = Math.round(33 * 203 / 25.4);   // 203dpi, não 8 dots/mm redondos
  assert(Math.abs((colunas[1] - colunas[0]) - largura) <= 2,
    `deslocamento ${colunas[1] - colunas[0]} != ~${largura}`);
});

await t('ZPL respeita os campos escolhidos', async () => {
  const so = await chamar(achar('/api/etiquetas/zpl', 'get'),
    { itens: '1:1', campos: 'descricao', tipoCodigo: 'nenhum' });
  assert(/Produto com EAN/.test(so.texto), 'descrição ausente');
  assert(!/R\$/.test(so.texto), 'preço apareceu sem ser pedido');
  assert(!/\^BE|\^BC|\^BQ/.test(so.texto), 'código apareceu com tipoCodigo=nenhum');

  const comPreco = await chamar(achar('/api/etiquetas/zpl', 'get'),
    { itens: '1:1', campos: 'preco,sku', tipoCodigo: 'nenhum' });
  assert(/R\$ 19,90/.test(comPreco.texto), 'preço não formatado: ' + comPreco.texto);
  assert(/SKU-1/.test(comPreco.texto), 'sku ausente');
});

await t('ZPL usa ^BQ para QR e ^BE para EAN', async () => {
  const qr = await chamar(achar('/api/etiquetas/zpl', 'get'), { itens: '1:1', tipoCodigo: 'qr' });
  assert(/\^BQN,2,\d+/.test(qr.texto), 'QR ZPL ausente: ' + qr.texto);
  const barras = await chamar(achar('/api/etiquetas/zpl', 'get'), { itens: '1:1', tipoCodigo: 'barras' });
  assert(/\^BEN,/.test(barras.texto), 'EAN ausente para produto com código válido');
  const code128 = await chamar(achar('/api/etiquetas/zpl', 'get'), { itens: '2:1', tipoCodigo: 'barras' });
  assert(/\^BCN,/.test(code128.texto), 'Code128 ausente para produto sem EAN');
});

await t('ZPL usa o modelo quando informado', async () => {
  const r = await chamar(achar('/api/etiquetas/zpl', 'get'), { itens: '1:1', modelo: 'rolo-100x50-1' });
  // 100mm a 203dpi = 799,2 dots — arredonda para 799, não 800.
  const pw = Number(r.texto.match(/\^PW(\d+)/)[1]);
  const esperado = Math.round(100 * 203 / 25.4);
  assert(Math.abs(pw - esperado) <= 1, `^PW${pw} != ~${esperado}`);
});

await t('ZPL recusa tamanho fora do suportado', async () => {
  const r = await chamar(achar('/api/etiquetas/zpl', 'get'), { itens: '1:1', larguraMm: '500', alturaMm: '22' });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/fora do suportado/.test(r.out.error), 'erro: ' + r.out.error);
});

await t('ZPL limita cópias e exige itens', async () => {
  const vazio = await chamar(achar('/api/etiquetas/zpl', 'get'), {});
  assert(vazio.st === 400, 'sem itens deveria dar 400');
  const muitas = await chamar(achar('/api/etiquetas/zpl', 'get'), { itens: '1:9999', colunas: '1' });
  const blocos = (muitas.texto.match(/\^XA/g) || []).length;
  assert(blocos === 500, 'teto de 500 cópias não aplicado: ' + blocos);
});

await t('caracteres de controle do ZPL são neutralizados', async () => {
  db.prepare("INSERT INTO produtos (id, sku, descricao, precoVenda) VALUES (3,'X^Y~Z','Desc ^com ~controle',1)").run();
  const r = await chamar(achar('/api/etiquetas/zpl', 'get'), { itens: '3:1', campos: 'descricao,sku', tipoCodigo: 'barras' });
  const corpo = r.texto.split('^FD').slice(1).join('^FD');
  assert(!/\^com/.test(corpo), 'circunflexo do dado sobreviveu e quebraria o ZPL');
  assert(!/~controle/.test(corpo), 'til do dado sobreviveu');
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
})();
