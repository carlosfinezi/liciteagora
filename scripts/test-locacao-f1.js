#!/usr/bin/env node
/**
 * test-locacao-f1.js — Fase 1: catálogo alugável e tarifário.
 *
 * O grosso do teste é a precificação, porque é a parte que o cliente confere
 * na calculadora dele. Os casos de borda escolhidos são os que geram
 * reclamação real: 7 diárias que deviam virar semana, devolução no mesmo dia,
 * hora iniciada, franquia de medidor e multa de atraso na fronteira da
 * carência.
 *
 * Uso: node scripts/test-locacao-f1.js
 */
const BASE = require('path').join(__dirname, '..');
const Database = require(BASE + '/node_modules/better-sqlite3');
const { copiaDoTenant } = require('./banco-de-teste');
const express = require(BASE + '/node_modules/express');

const { initLocacaoSchema } = require(BASE + '/locacao/locacao-schema');
const { protegerConfig } = require('./locacao-teste-util');
const { registrarRotasLocacao } = require(BASE + '/locacao/locacao-routes');
const T = require(BASE + '/locacao/tarifa');

const db = new Database(copiaDoTenant('labfiscal'));

// Devolve toda chave `locacao_*` ao estado original na saída do processo —
// inclusive se este teste estourar no meio. Ver locacao-teste-util.js.
protegerConfig(db);
initLocacaoSchema(db);

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function eq(a, b, msg) { assert(a === b, msg, `esperado ${b}, veio ${a}`); }
function secao(t) { console.log(`\n── ${t}`); }

// ─── Normalização de instante ─────────────────────────────────────────────────
secao('Normalização de instante (o formato decide a sobreposição)');
eq(T.normalizarInstante('2026-09-10'), '2026-09-10 00:00:00', 'data pura vira meia-noite');
eq(T.normalizarInstante('2026-09-10T08:30'), '2026-09-10 08:30:00', 'ISO com T é aceito');
eq(T.normalizarInstante('2026-09-10 08:30:45'), '2026-09-10 08:30:45', 'formato canônico passa igual');
eq(T.normalizarInstante('10/09/2026'), null, 'formato brasileiro é recusado (não adivinha)');
eq(T.normalizarInstante(''), null, 'vazio é null');
eq(T.normalizarInstante(new Date(2026, 8, 10, 8, 30, 0)), '2026-09-10 08:30:00', 'Date é aceito');

// ─── Duração ──────────────────────────────────────────────────────────────────
secao('Duração (hora iniciada é hora cheia)');
eq(T.duracaoHoras('2026-09-10 08:00', '2026-09-11 08:00'), 24, '24h exatas são 24, não 25');
eq(T.duracaoHoras('2026-09-10 08:00', '2026-09-10 10:10'), 3, '2h10 viram 3 horas faturáveis');
eq(T.duracaoHoras('2026-09-10 08:00', '2026-09-10 08:00'), 0, 'mesmo instante é zero');
eq(T.duracaoHoras('2026-09-11 08:00', '2026-09-10 08:00'), 0, 'fim antes do início é zero');
eq(T.duracaoHoras('2026-09-10 08:00', '2026-09-17 08:00'), 168, 'uma semana são 168h');

// ─── Precificação ─────────────────────────────────────────────────────────────
secao('Precificação — progressividade');

const tarifasPadrao = [
  { faixa: 'dia', valor: 100, minimoFaturavel: 1, ativo: 1 },
  { faixa: 'semana', valor: 500, minimoFaturavel: 1, ativo: 1 },
  { faixa: 'mes', valor: 1500, minimoFaturavel: 1, ativo: 1 },
];

let c = T.calcularTarifa(tarifasPadrao, '2026-09-10 08:00', '2026-09-11 08:00');
eq(c.valorTotal, 100, '1 dia = 1 diária');

c = T.calcularTarifa(tarifasPadrao, '2026-09-10 08:00', '2026-09-15 08:00');
eq(c.valorTotal, 500, '5 dias (500) já empatam com a semana — cobra a semana');

c = T.calcularTarifa(tarifasPadrao, '2026-09-10 08:00', '2026-09-16 08:00');
eq(c.valorTotal, 500, '6 dias NÃO custam 600: a semana é mais barata');
assert(c.composicao.length === 1 && c.composicao[0].faixa === 'semana',
  'composição de 6 dias mostra 1 semana', JSON.stringify(c.composicao));

c = T.calcularTarifa(tarifasPadrao, '2026-09-10 08:00', '2026-09-17 08:00');
eq(c.valorTotal, 500, '7 dias = 1 semana');

c = T.calcularTarifa(tarifasPadrao, '2026-09-10 08:00', '2026-09-18 08:00');
eq(c.valorTotal, 600, '8 dias = 1 semana + 1 diária');

c = T.calcularTarifa(tarifasPadrao, '2026-09-10 08:00', '2026-10-10 08:00');
eq(c.valorTotal, 1500, '30 dias = 1 mês (3 semanas + 9 diárias custaria mais)');

c = T.calcularTarifa(tarifasPadrao, '2026-09-10 08:00', '2026-10-05 08:00');
eq(c.valorTotal, 1500, '25 dias já custam o mês — nunca cobra mais que a faixa maior');

secao('Precificação — mínimo faturável e piso');

c = T.calcularTarifa(tarifasPadrao, '2026-09-10 08:00', '2026-09-10 11:00');
eq(c.valorTotal, 100, '3 horas com tarifa só de diária cobram 1 diária');
eq(c.horasFaturaveis, 24, 'horas faturáveis sobem ao piso de 1 diária');

const comHora = [
  { faixa: 'hora', valor: 30, minimoFaturavel: 4, ativo: 1 },
  { faixa: 'dia', valor: 100, minimoFaturavel: 1, ativo: 1 },
];
c = T.calcularTarifa(comHora, '2026-09-10 08:00', '2026-09-10 09:00');
eq(c.horasFaturaveis, 4, 'mínimo de 4 horas é respeitado');
eq(c.valorTotal, 100, '4 horas a 30 custariam 120 — a diária de 100 é mais barata');

c = T.calcularTarifa(comHora, '2026-09-10 08:00', '2026-09-10 12:00');
eq(c.valorTotal, 100, '4 horas cheias também caem na diária');

const soHora = [{ faixa: 'hora', valor: 30, minimoFaturavel: 2, ativo: 1 }];
c = T.calcularTarifa(soHora, '2026-09-10 08:00', '2026-09-10 09:00');
eq(c.valorTotal, 60, 'sem diária cadastrada, 1 hora cobra o mínimo de 2 horas');

secao('Precificação — recusas');

c = T.calcularTarifa([], '2026-09-10 08:00', '2026-09-11 08:00');
assert(c.ok === false && /sem tarifa/.test(c.erro), 'produto sem tarifa é recusado', JSON.stringify(c));

c = T.calcularTarifa(tarifasPadrao, '2026-09-11 08:00', '2026-09-10 08:00');
assert(c.ok === false && /depois da saída/.test(c.erro), 'retorno antes da saída é recusado', JSON.stringify(c));

c = T.calcularTarifa(tarifasPadrao, 'ontem', '2026-09-10 08:00');
assert(c.ok === false, 'data ilegível é recusada', JSON.stringify(c));

c = T.calcularTarifa(tarifasPadrao, '2026-09-10 08:00', '2026-09-11 08:00', { quantidade: 3 });
eq(c.valorTotal, 300, 'quantidade multiplica o total');
eq(c.valorUnitario, 100, 'valor unitário permanece o do item');

secao('Precificação — período longo');
c = T.calcularTarifa(tarifasPadrao, '2026-01-01 08:00', '2027-01-01 08:00');
// 365 dias: 12 meses (360 dias, 18000) + 5 dias (500) = 18500
eq(c.valorTotal, 18500, '365 dias = 12 meses + 5 diárias');

// REGRESSÃO (bug encontrado na validação): a DP mudava para passo de 1 DIA
// acima de 60 dias, e `Math.round(1/24)` mapeava a faixa `hora` para um passo
// inteiro — a tarifa horária passava a cobrir um dia pelo preço de uma hora.
// Resultado: alugar por MAIS tempo ficava MAIS BARATO, e cadastrar tarifa de
// hora barateava a locação longa. Este bloco só existe porque o teste antigo
// usava `tarifasPadrao`, que não tem faixa `hora` — o bug vivia exatamente na
// interseção não coberta.
const comTudo = [
  { faixa: 'hora', valor: 15, minimoFaturavel: 1, ativo: 1 },
  ...tarifasPadrao,
];
const p60 = T.calcularTarifa(comTudo, '2026-01-01 08:00', new Date(2026, 0, 61, 8)).valorTotal;
const p61 = T.calcularTarifa(comTudo, '2026-01-01 08:00', new Date(2026, 0, 62, 8)).valorTotal;
const p90 = T.calcularTarifa(comTudo, '2026-01-01 08:00', new Date(2026, 0, 91, 8)).valorTotal;
eq(p60, 3000, '60 dias com tarifa de hora = 2 meses');
assert(p61 >= p60, `61 dias (${p61}) NÃO pode custar menos que 60 dias (${p60})`);
assert(p90 >= p61, `90 dias (${p90}) NÃO pode custar menos que 61 dias (${p61})`);

// Monotonicidade em toda a faixa crítica, não só nos pontos escolhidos.
let anterior = 0, quebras = [];
for (let d = 1; d <= 130; d++) {
  const v = T.calcularTarifa(comTudo, '2026-01-01 08:00', new Date(2026, 0, 1 + d, 8)).valorTotal;
  if (v < anterior) quebras.push(`${d}d=${v} < ${d - 1}d=${anterior}`);
  anterior = v;
}
assert(quebras.length === 0, 'preço nunca cai ao alugar por mais tempo (1..130 dias)', quebras.join('; '));

// A composição precisa fechar com o total — senão o documento mostra uma
// conta que não bate com o valor cobrado.
for (const dias of [3, 6, 7, 13, 30, 61, 95]) {
  const cc = T.calcularTarifa(comTudo, '2026-01-01 08:00', new Date(2026, 0, 1 + dias, 8));
  const soma = cc.composicao.reduce((a, x) => a + x.valorTotal, 0);
  assert(Math.abs(soma - cc.valorUnitario) < 0.01,
    `composição fecha com o total em ${dias} dias`, `soma=${soma} total=${cc.valorUnitario}`);
}

// Faixa duplicada no array (o banco tem UNIQUE, mas a função é pura e
// documentada como tal): a composição não pode somar mais que o total.
const dup = [
  { faixa: 'dia', valor: 120, minimoFaturavel: 1, ativo: 1 },
  { faixa: 'dia', valor: 90, minimoFaturavel: 1, ativo: 1 },
];
const cdup = T.calcularTarifa(dup, '2026-01-01 08:00', '2026-01-03 08:00');
const somaDup = cdup.composicao.reduce((a, x) => a + x.valorTotal, 0);
assert(Math.abs(somaDup - cdup.valorUnitario) < 0.01,
  'faixa duplicada não infla a composição', `soma=${somaDup} total=${cdup.valorUnitario}`);

// ─── Caução e reposição: fixo ou percentual ───────────────────────────────────
secao('Caução e reposição — valor fixo ou percentual');

// Regra geral: o percentual VENCE o fixo quando preenchido; o fixo continua
// valendo sozinho e como fallback de quando a base não existe.
const bem = { precoVenda: 10000, precoCusto: 6000 };
const semPreco = { precoVenda: 0, precoCusto: 0 };

eq(T.valorDoBem(bem), 10000, 'valor do bem usa o preço de venda');
eq(T.valorDoBem({ precoVenda: 0, precoCusto: 6000 }), 6000,
  'sem preço de venda, cai no de custo (o caso da maioria dos produtos do 1bit)');
eq(T.valorDoBem(semPreco), 0, 'sem nenhum preço, não há base');
eq(T.valorDoBem(null), 0, 'produto ausente não estoura');

// ── Caução: só fixo ──
let cc = T.calcularCaucao({ caucaoPadrao: 500 }, { valorLocacao: 2000, produto: bem });
eq(cc.valor, 500, 'só valor fixo: cobra o fixo');
eq(cc.modo, 'fixo', 'modo fixo');

cc = T.calcularCaucao({ caucaoPadrao: 500 }, { valorLocacao: 2000, produto: bem, quantidade: 3 });
eq(cc.valor, 1500, 'o fixo multiplica pela quantidade');

// ── Caução: percentual sobre o ALUGUEL ──
cc = T.calcularCaucao(
  { caucaoPadrao: 500, caucaoPercentual: 30, caucaoPercentualBase: 'locacao' },
  { valorLocacao: 2000, produto: bem });
eq(cc.valor, 600, '30% de 2000 de aluguel = 600');
eq(cc.modo, 'percentual', 'o percentual venceu o fixo de 500');
eq(cc.baseValor, 2000, 'base é o valor da locação');

// ── Caução: percentual sobre o BEM ──
cc = T.calcularCaucao(
  { caucaoPadrao: 500, caucaoPercentual: 10, caucaoPercentualBase: 'bem' },
  { valorLocacao: 2000, produto: bem });
eq(cc.valor, 1000, '10% de 10000 do bem = 1000');
eq(cc.baseValor, 10000, 'base é o valor do bem');

cc = T.calcularCaucao(
  { caucaoPadrao: 500, caucaoPercentual: 10, caucaoPercentualBase: 'bem' },
  { valorLocacao: 2000, produto: bem, quantidade: 2 });
eq(cc.valor, 2000, 'a base do bem multiplica pela quantidade');

// ── Caução: base inexistente cai no fixo, avisando ──
cc = T.calcularCaucao(
  { caucaoPadrao: 500, caucaoPercentual: 10, caucaoPercentualBase: 'bem' },
  { valorLocacao: 2000, produto: semPreco });
eq(cc.valor, 500, 'produto sem preço: o percentual do bem cai no valor fixo');
assert(!!cc.aviso && /sem preço/.test(cc.aviso), 'e avisa por quê', JSON.stringify(cc));

cc = T.calcularCaucao(
  { caucaoPadrao: 0, caucaoPercentual: 10, caucaoPercentualBase: 'bem' },
  { valorLocacao: 2000, produto: semPreco });
eq(cc.modo, 'indefinido', 'sem base e sem fixo, o modo é indefinido (não inventa zero silencioso)');

cc = T.calcularCaucao(
  { caucaoPadrao: 300, caucaoPercentual: 25, caucaoPercentualBase: 'locacao' },
  { valorLocacao: 0, produto: bem });
eq(cc.valor, 300, 'item ainda sem valor de aluguel: percentual cai no fixo');

// ── Caução: base default e inválida ──
cc = T.calcularCaucao({ caucaoPercentual: 50 }, { valorLocacao: 1000, produto: bem });
eq(cc.base, 'locacao', 'sem base declarada, o padrão é o valor do aluguel');
eq(cc.valor, 500, 'e calcula sobre ele');

cc = T.calcularCaucao({ caucaoPercentual: 50, caucaoPercentualBase: 'lua' },
  { valorLocacao: 1000, produto: bem });
eq(cc.base, 'locacao', 'base desconhecida volta ao padrão em vez de estourar');

// ── Reposição ──
let rr = T.calcularReposicao({ valorReposicao: 8000 }, { produto: bem });
eq(rr.valor, 8000, 'reposição só com valor fixo');
eq(rr.modo, 'fixo', 'modo fixo');

rr = T.calcularReposicao({ valorReposicao: 8000, reposicaoPercentual: 120 }, { produto: bem });
eq(rr.valor, 12000, 'reposição de 120% do bem (10000) = 12000, vencendo o fixo');
eq(rr.modo, 'percentual', 'modo percentual');

rr = T.calcularReposicao({ reposicaoPercentual: 100 }, { produto: bem, quantidade: 3 });
eq(rr.valorUnitario, 10000, 'unitário é 100% do bem');
eq(rr.valor, 30000, 'e o total multiplica pela quantidade');

rr = T.calcularReposicao({ valorReposicao: 500, reposicaoPercentual: 100 }, { produto: semPreco });
eq(rr.valor, 500, 'sem preço no produto, a reposição percentual cai no fixo');
assert(!!rr.aviso, 'e avisa');

rr = T.calcularReposicao({}, { produto: bem });
eq(rr.modo, 'indefinido', 'sem fixo e sem percentual, indefinido');
eq(rr.valor, 0, 'e valor zero');

// Percentual sobre o custo quando não há venda — o caso real do 1bit.
rr = T.calcularReposicao({ reposicaoPercentual: 110 }, { produto: { precoVenda: 0, precoCusto: 2761 } });
eq(rr.valorUnitario, 3037.1, '110% do preço de custo quando não há preço de venda');

// ─── Excedente de medidor ─────────────────────────────────────────────────────
secao('Excedente de medidor');

const specHorimetro = { medidorTipo: 'horimetro', franquiaPorDia: 8 };
const extras = [{ tipo: 'hora_extra', valor: 25, ativo: 1 }];

let e = T.calcularExcedenteMedidor(specHorimetro, extras,
  { medidorSaida: 1000, medidorRetorno: 1040, dias: 5 });
assert(e.aplicavel === false, '40h em 5 dias (franquia 40) não gera excedente', JSON.stringify(e));

e = T.calcularExcedenteMedidor(specHorimetro, extras,
  { medidorSaida: 1000, medidorRetorno: 1050, dias: 5 });
assert(e.aplicavel === true, '50h em 5 dias gera excedente');
eq(e.excedente, 10, 'excedente é 10 horas');
eq(e.valorTotal, 250, '10 horas × 25 = 250');

e = T.calcularExcedenteMedidor(specHorimetro, extras,
  { medidorSaida: 1000, medidorRetorno: 900, dias: 5 });
assert(!!e.erro, 'leitura de retorno menor que a de saída é erro', JSON.stringify(e));

e = T.calcularExcedenteMedidor({ medidorTipo: 'nenhum' }, extras,
  { medidorSaida: 1000, medidorRetorno: 2000, dias: 5 });
assert(e.aplicavel === false, 'produto sem medidor nunca cobra excedente');

e = T.calcularExcedenteMedidor({ medidorTipo: 'km' }, extras,
  { medidorSaida: 1000, medidorRetorno: 2000, dias: 5 });
assert(e.aplicavel === false && /sem franquia/.test(e.motivo || ''),
  'sem franquia cadastrada não cobra excedente', JSON.stringify(e));

e = T.calcularExcedenteMedidor(specHorimetro, extras,
  { medidorSaida: 1000, medidorRetorno: 1050 }); // sem dias
assert(e.aplicavel === true && e.franquiaTotal === 8,
  'sem dias informados a franquia mínima é de 1 dia', JSON.stringify(e));

// ─── Multa de atraso ──────────────────────────────────────────────────────────
secao('Multa de atraso (carência e fronteira)');

const cfg = { locacao_carencia_atraso_horas: '3', locacao_multa_atraso_percentual: '100' };

let m = T.calcularMultaAtraso(cfg, 100, '2026-09-10 08:00', '2026-09-10 08:00');
assert(m.aplicavel === false && m.valorTotal === 0, 'devolução na hora não gera multa');

m = T.calcularMultaAtraso(cfg, 100, '2026-09-10 08:00', '2026-09-10 10:59');
assert(m.aplicavel === false && m.dentroDaCarencia === true,
  '2h59 de atraso ficam dentro da carência de 3h', JSON.stringify(m));

m = T.calcularMultaAtraso(cfg, 100, '2026-09-10 08:00', '2026-09-10 11:00');
assert(m.aplicavel === false, 'exatamente 3h ainda é carência (a fronteira não multa)', JSON.stringify(m));

m = T.calcularMultaAtraso(cfg, 100, '2026-09-10 08:00', '2026-09-10 11:30');
assert(m.aplicavel === true, '3h30 passam da carência');
eq(m.diasCobrados, 1, 'atraso de horas cobra 1 dia inteiro');
eq(m.valorTotal, 100, '1 dia × 100% da diária = 100');

m = T.calcularMultaAtraso(cfg, 100, '2026-09-10 08:00', '2026-09-12 08:00');
eq(m.diasCobrados, 2, '48h de atraso são 2 dias');
eq(m.valorTotal, 200, '2 dias de multa = 200');

m = T.calcularMultaAtraso({ ...cfg, locacao_multa_atraso_percentual: '150' }, 100,
  '2026-09-10 08:00', '2026-09-11 08:00');
eq(m.valorTotal, 150, 'multa de 150% da diária');

m = T.calcularMultaAtraso({ ...cfg, locacao_multa_atraso_percentual: '0' }, 100,
  '2026-09-10 08:00', '2026-09-15 08:00');
assert(m.aplicavel === false, 'multa 0% desliga a cobrança mesmo com atraso grande');

m = T.calcularMultaAtraso(cfg, 0, '2026-09-10 08:00', '2026-09-15 08:00');
assert(m.aplicavel === false, 'sem valor de diária não há base para multar');

// ─── Rotas ────────────────────────────────────────────────────────────────────
secao('Rotas do catálogo e do tarifário');

const app = express();
app.use(express.json());
registrarRotasLocacao(app, db);

function chamar(p, m, o = {}) {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  let out = null, st = 200;
  const res = { json: x => { out = x; return res; }, status: c2 => { st = c2; return res; } };
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, headers: {} };
  let i = 0;
  const next = () => { const h = l.route.stack[i++]; if (h) h.handle(req, res, next); };
  next();
  return { out, st };
}

const flagOriginal = db.prepare("SELECT valor FROM config WHERE chave = 'locacao_enabled'").get();
db.prepare(`INSERT INTO config (chave, valor) VALUES ('locacao_enabled','1')
            ON CONFLICT(chave) DO UPDATE SET valor='1'`).run();

// Produto de teste — criado e removido pelo próprio teste.
const SKU = 'TESTE-LOCACAO-F1';
db.prepare('DELETE FROM locacao_item_specs WHERE produtoId IN (SELECT id FROM produtos WHERE sku = ?)').run(SKU);
db.prepare('DELETE FROM produtos WHERE sku = ?').run(SKU);
const prodId = db.prepare(`
  INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo, rastreiaSerial)
  VALUES (?, 'Betoneira 400L (teste automatizado)', 'UN', 0, 1, 1)
`).run(SKU).lastInsertRowid;

let r = chamar('/api/locacao/itens/:produtoId', 'put', {
  params: { produtoId: prodId },
  body: { alugavel: 1, exigeSerie: 1, caucaoPadrao: 500,
          horasPreparo: 4, medidorTipo: 'horimetro', franquiaPorDia: 8, valorReposicao: 6000 },
});
assert(r.st === 200 && r.out.success, 'PUT item cria a spec', JSON.stringify(r.out));
eq(r.out.item.horasPreparo, 4, 'horasPreparo gravado');
eq(r.out.item.medidorTipo, 'horimetro', 'medidorTipo gravado');

r = chamar('/api/locacao/itens/:produtoId', 'put', {
  params: { produtoId: prodId }, body: { medidorTipo: 'sensor-magico' },
});
assert(r.st === 400, 'medidorTipo inválido é recusado', `st=${r.st}`);

r = chamar('/api/locacao/itens/:produtoId', 'put', {
  params: { produtoId: prodId }, body: { horasPreparo: -5 },
});
assert(r.st === 400, 'horasPreparo negativo é recusado', `st=${r.st}`);

// exigeSerie num produto que não rastreia série
const prodSemSerie = db.prepare(`
  INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo, rastreiaSerial)
  VALUES ('TESTE-LOCACAO-F1-B', 'Cadeira (teste)', 'UN', 0, 1, 0)
`).run().lastInsertRowid;
r = chamar('/api/locacao/itens/:produtoId', 'put', {
  params: { produtoId: prodSemSerie }, body: { exigeSerie: 1 },
});
assert(r.st === 400 && /rastreiaSerial/.test(r.out.error || ''),
  'exigir série em produto que não rastreia série é recusado', JSON.stringify(r.out));

r = chamar('/api/locacao/itens/:produtoId', 'put', {
  params: { produtoId: 99999999 }, body: { alugavel: 1 },
});
assert(r.st === 404, 'produto inexistente devolve 404', `st=${r.st}`);

// Tarifas
r = chamar('/api/locacao/itens/:produtoId/tarifas', 'put', {
  params: { produtoId: prodId },
  body: { tarifas: [
    { faixa: 'dia', valor: 180, minimoFaturavel: 1 },
    { faixa: 'semana', valor: 900 },
    { faixa: 'mes', valor: 2700 },
  ] },
});
assert(r.st === 200 && r.out.tarifas.length === 3, 'tarifário gravado com 3 faixas', JSON.stringify(r.out));

r = chamar('/api/locacao/itens/:produtoId/tarifas', 'put', {
  params: { produtoId: prodId },
  body: { tarifas: [{ faixa: 'dia', valor: 100 }, { faixa: 'dia', valor: 120 }] },
});
assert(r.st === 400 && /repetida/.test(r.out.error || ''), 'faixa repetida é recusada', JSON.stringify(r.out));

r = chamar('/api/locacao/itens/:produtoId/tarifas', 'put', {
  params: { produtoId: prodId }, body: { tarifas: [{ faixa: 'decada', valor: 100 }] },
});
assert(r.st === 400 && /inválida/.test(r.out.error || ''), 'faixa inexistente é recusada');

r = chamar('/api/locacao/itens/:produtoId/tarifas', 'put', {
  params: { produtoId: prodId }, body: { tarifas: [{ faixa: 'dia', valor: 0 }] },
});
assert(r.st === 400, 'valor zero é recusado');

r = chamar('/api/locacao/itens/:produtoId/tarifas', 'put', {
  params: { produtoId: prodId }, body: { tarifas: 'nao-e-lista' },
});
assert(r.st === 400, 'tarifas fora de lista é recusado');

secao('Categoria vem do cadastro do produto, e a busca substitui o select');

// A categoria do item alugável é a `produtos.categoria`. Não existe campo
// próprio no módulo: eram duas verdades para a mesma pergunta.
db.prepare("UPDATE produtos SET categoria = 'maquinas-teste' WHERE id = ?").run(prodId);

r = chamar('/api/locacao/itens', 'get', { query: { busca: 'Betoneira' } });
const linhaCat = r.out.itens.find(i => i.produtoId === Number(prodId));
eq(linhaCat.categoria, 'maquinas-teste', 'a listagem devolve a categoria DO PRODUTO');

r = chamar('/api/locacao/itens', 'get', { query: { categoria: 'maquinas-teste' } });
assert(r.out.itens.some(i => i.produtoId === Number(prodId)),
  'o filtro por categoria usa produtos.categoria');

r = chamar('/api/locacao/itens', 'get', { query: { categoria: 'categoria-que-nao-existe' } });
eq(r.out.itens.length, 0, 'categoria inexistente não devolve nada');

// Mudar a categoria no cadastro do produto reflete na locação, sem
// recadastrar nada — que é o ponto de não ter campo próprio.
db.prepare("UPDATE produtos SET categoria = 'outra-categoria' WHERE id = ?").run(prodId);
r = chamar('/api/locacao/itens', 'get', { query: { categoria: 'outra-categoria' } });
assert(r.out.itens.some(i => i.produtoId === Number(prodId)),
  'trocar a categoria no catálogo reflete na locação na hora');

// A tela de Preços troca o item por busca combinada (texto + categoria +
// só alugáveis). Os três parâmetros precisam funcionar juntos.
r = chamar('/api/locacao/itens', 'get', {
  query: { busca: 'Betoneira', categoria: 'outra-categoria', alugavel: '1' } });
assert(r.st === 200 && r.out.itens.some(i => i.produtoId === Number(prodId)),
  'busca + categoria + alugavel combinam na listagem de itens', JSON.stringify(r.out.itens.length));

r = chamar('/api/locacao/itens', 'get', {
  query: { busca: 'Betoneira', categoria: 'categoria-errada' } });
eq(r.out.itens.length, 0, 'categoria que não bate zera o resultado mesmo com texto certo');

r = chamar('/api/locacao/itens', 'get', { query: { alugavel: '0' } });
assert(r.out.itens.every(i => i.alugavel === 0),
  'alugavel=0 traz só os desativados (o filtro não é ignorado)');

r = chamar('/api/locacao/categorias', 'get', { query: { apenasAlugaveis: '1' } });
assert(r.st === 200 && r.out.categorias.some(c => c.categoria === 'outra-categoria'),
  'GET categorias lista as do cadastro que têm item alugável', JSON.stringify(r.out.categorias));
assert(r.out.categorias.every(c => c.categoria && c.categoria.trim()),
  'e nunca devolve categoria vazia (ruído no seletor)');

// Busca de produto (o que substituiu o <select> de catálogo inteiro)
r = chamar('/api/locacao/produtos-busca', 'get', { query: { q: 'Betoneira' } });
assert(r.st === 200 && r.out.produtos.length >= 1, 'busca acha por descrição', JSON.stringify(r.out.error));
const achado = r.out.produtos.find(p => p.id === Number(prodId));
assert(!!achado, 'o produto de teste aparece');
eq(achado.jaAlugavel, 1, 'e vem marcado como já alugável (evita recadastro)');

r = chamar('/api/locacao/produtos-busca', 'get', { query: { q: SKU } });
assert(r.out.produtos.some(p => p.id === Number(prodId)), 'busca acha por SKU');

r = chamar('/api/locacao/produtos-busca', 'get', { query: { q: 'Betoneira', somenteNovos: '1' } });
assert(!r.out.produtos.some(p => p.id === Number(prodId)),
  'somenteNovos exclui quem já é alugável');

// A categoria dentro do cadastro é FILTRO da busca, não um campo de leitura:
// escolher a categoria lista os produtos dela sem digitar nada.
r = chamar('/api/locacao/produtos-busca', 'get', { query: { categoria: 'outra-categoria' } });
assert(r.st === 200 && r.out.produtos.some(p => p.id === Number(prodId)),
  'busca só por categoria (sem termo) lista os produtos dela', JSON.stringify(r.out.produtos.length));

r = chamar('/api/locacao/produtos-busca', 'get', {
  query: { categoria: 'outra-categoria', q: 'Betoneira' } });
assert(r.out.produtos.some(p => p.id === Number(prodId)), 'categoria + termo se combinam');

r = chamar('/api/locacao/produtos-busca', 'get', {
  query: { categoria: 'outra-categoria', q: 'zzz-nao-existe' } });
eq(r.out.produtos.length, 0, 'categoria + termo sem match devolve vazio');

r = chamar('/api/locacao/categorias', 'get', {});
assert(r.st === 200 && r.out.categorias.length >= 1,
  'GET categorias SEM apenasAlugaveis traz o catálogo inteiro (é o filtro da busca)');

r = chamar('/api/locacao/produtos-busca', 'get', { query: { q: 'zzz-nao-existe-zzz' } });
eq(r.out.produtos.length, 0, 'busca sem resultado devolve lista vazia, não erro');

r = chamar('/api/locacao/produtos-busca', 'get', {});
assert(r.st === 200 && r.out.produtos.length <= 30,
  'busca sem termo devolve no máximo 30 (o teto que torna a tela viável)',
  String(r.out.produtos.length));
assert('truncado' in r.out, 'e informa se truncou, para a tela pedir refino');

secao('Rota: percentuais de caução e reposição');

r = chamar('/api/locacao/itens/:produtoId', 'put', {
  params: { produtoId: prodId },
  body: { alugavel: 1, caucaoPadrao: 500, caucaoPercentual: 30, caucaoPercentualBase: 'locacao',
          valorReposicao: 5000, reposicaoPercentual: 110 },
});
assert(r.st === 200, 'percentuais são aceitos junto dos valores fixos', JSON.stringify(r.out.error));
eq(r.out.item.caucaoPercentual, 30, 'caucaoPercentual gravado');
eq(r.out.item.caucaoPercentualBase, 'locacao', 'base gravada');
eq(r.out.item.reposicaoPercentual, 110, 'reposicaoPercentual gravado');
eq(r.out.item.caucaoPadrao, 500, 'e o valor fixo continua gravado ao lado');
assert(!!r.out.previa, 'a resposta traz uma prévia com números reais', JSON.stringify(r.out.previa));

r = chamar('/api/locacao/itens/:produtoId', 'put', {
  params: { produtoId: prodId }, body: { caucaoPercentual: 5000 },
});
assert(r.st === 400 && /0\.\.1000/.test(r.out.error || ''),
  'percentual absurdo é recusado (erro de digitação vira cobrança indevida)', JSON.stringify(r.out));

r = chamar('/api/locacao/itens/:produtoId', 'put', {
  params: { produtoId: prodId }, body: { reposicaoPercentual: -10 },
});
assert(r.st === 400, 'percentual negativo é recusado');

r = chamar('/api/locacao/itens/:produtoId', 'put', {
  params: { produtoId: prodId }, body: { caucaoPercentual: 10, caucaoPercentualBase: 'chute' },
});
assert(r.st === 400 && /caucaoPercentualBase/.test(r.out.error || ''),
  'base de percentual inválida é recusada', JSON.stringify(r.out));

// Limpar o percentual volta ao fixo.
r = chamar('/api/locacao/itens/:produtoId', 'put', {
  params: { produtoId: prodId }, body: { caucaoPadrao: 500, caucaoPercentual: '' },
});
assert(r.st === 200 && r.out.item.caucaoPercentual === null,
  'mandar percentual vazio limpa o campo e devolve o comando ao valor fixo');

r = chamar('/api/locacao/itens', 'get', { query: { busca: 'Betoneira' } });
const linhaPct = r.out.itens.find(i => i.produtoId === Number(prodId));
assert('caucaoPercentual' in linhaPct && 'reposicaoPercentual' in linhaPct,
  'a listagem devolve os campos de percentual (senão a tela não mostra)');
assert('precoCusto' in linhaPct, 'e o preço de custo, que é a base de fallback');

// Repõe o tarifário bom para o simulador
chamar('/api/locacao/itens/:produtoId/tarifas', 'put', {
  params: { produtoId: prodId },
  body: { tarifas: [
    { faixa: 'dia', valor: 180 }, { faixa: 'semana', valor: 900 }, { faixa: 'mes', valor: 2700 },
  ] },
});

// Extras
r = chamar('/api/locacao/extras', 'put', { body: { tipo: 'hora_extra', valor: 45, produtoId: prodId } });
assert(r.st === 200, 'extra por produto é gravado', JSON.stringify(r.out));
r = chamar('/api/locacao/extras', 'put', { body: { tipo: 'entrega', valor: 150 } });
assert(r.st === 200, 'extra global (produtoId nulo) é gravado');
// As cobranças avulsas passaram para a configuração do módulo, onde padrões
// da locadora e exceções por item convivem — a API precisa separar os dois e
// dizer de que produto é cada exceção.
r = chamar('/api/locacao/extras', 'get', {});
assert(Array.isArray(r.out.padroes) && Array.isArray(r.out.excecoes),
  'GET extras separa padrões (todos os itens) de exceções (item específico)');
assert(r.out.padroes.every(e => !e.produtoId), 'padrões não têm produtoId');
assert(r.out.excecoes.every(e => !!e.produtoId), 'exceções têm produtoId');
const excecaoDoTeste = r.out.excecoes.find(e => e.produtoId === Number(prodId));
assert(!!excecaoDoTeste && !!excecaoDoTeste.produto,
  'a exceção vem com a DESCRIÇÃO do produto ("produtoId 47" seria ilegível na tela)',
  JSON.stringify(excecaoDoTeste));

r = chamar('/api/locacao/extras', 'put', { body: { tipo: 'teletransporte', valor: 10 } });
assert(r.st === 400, 'tipo de extra inválido é recusado');
r = chamar('/api/locacao/extras', 'get', { query: { produtoId: prodId } });
assert(r.st === 200 && r.out.extras.length >= 2, 'GET extras traz o do produto e o global',
  JSON.stringify(r.out.extras));

// Idempotência do upsert de extra: gravar duas vezes não duplica.
chamar('/api/locacao/extras', 'put', { body: { tipo: 'entrega', valor: 200 } });
const nEntrega = db.prepare("SELECT COUNT(*) n FROM locacao_tarifa_extras WHERE produtoId IS NULL AND tipo='entrega'").get().n;
eq(nEntrega, 1, 'upsert de extra global não duplica a linha');

// Listagem
r = chamar('/api/locacao/itens', 'get', { query: { busca: 'Betoneira' } });
assert(r.st === 200 && r.out.itens.some(i => i.produtoId === Number(prodId)),
  'GET itens encontra o produto alugável');
const linha = r.out.itens.find(i => i.produtoId === Number(prodId));
eq(linha.tarifas, 3, 'listagem conta as 3 tarifas ativas');

// Simulador
r = chamar('/api/locacao/simular', 'post', {
  body: { produtoId: prodId, inicio: '2026-09-10 08:00', fim: '2026-09-16 08:00' },
});
assert(r.st === 200 && r.out.calculo.valorTotal === 900,
  'simulador aplica a semana em 6 dias (900, não 1080)', JSON.stringify(r.out));

r = chamar('/api/locacao/simular', 'post', {
  body: { produtoId: prodId, inicio: '2026-09-16 08:00', fim: '2026-09-10 08:00' },
});
assert(r.st === 400, 'simulador recusa período invertido');

// Remoção
r = chamar('/api/locacao/itens/:produtoId', 'delete', { params: { produtoId: prodSemSerie } });
assert(r.st === 200, 'DELETE remove a spec de item sem locação');

// ─── Limpeza ──────────────────────────────────────────────────────────────────
db.prepare('DELETE FROM locacao_tarifa_extras WHERE produtoId = ?').run(prodId);
db.prepare("DELETE FROM locacao_tarifa_extras WHERE produtoId IS NULL AND tipo = 'entrega'").run();
db.prepare('DELETE FROM locacao_tarifas WHERE produtoId = ?').run(prodId);
db.prepare('DELETE FROM locacao_item_specs WHERE produtoId IN (?, ?)').run(prodId, prodSemSerie);
db.prepare('DELETE FROM produtos WHERE id IN (?, ?)').run(prodId, prodSemSerie);
if (flagOriginal) {
  db.prepare("UPDATE config SET valor = ? WHERE chave = 'locacao_enabled'").run(flagOriginal.valor);
} else {
  db.prepare("DELETE FROM config WHERE chave = 'locacao_enabled'").run();
}

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
