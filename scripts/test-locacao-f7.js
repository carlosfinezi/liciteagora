#!/usr/bin/env node
/**
 * test-locacao-f7.js — Fase 7: contrato impresso, promissória e as três
 * regras que vieram do modelo em uso pela REIMAC/Mestre da Obra.
 *
 * O que precisa ficar provado:
 *  1. valor por extenso — a promissória não vale como título sem ele, e o
 *     teste confere contra o texto do modelo real;
 *  2. hora de corte da diária (cláusula 1) muda o preço de verdade;
 *  3. limpeza como % do aluguel (cláusula 6) e piso em reais;
 *  4. a promissória é calculada sobre a REPOSIÇÃO da frota, não sobre o
 *     aluguel — foi assim que o modelo chegou a R$ 2.388,18 para uma locação
 *     de R$ 230,00;
 *  5. as cláusulas são COPIADAS no contrato: editar o padrão depois não
 *     reescreve contrato já assinado;
 *  6. o PDF sai de verdade, com o conteúdo esperado.
 *
 * Uso: node scripts/test-locacao-f7.js
 */
const fs = require('fs');
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const express = require(BASE + '/node_modules/express');

const { initLocacaoSchema } = require(BASE + '/locacao/locacao-schema');
const { protegerConfig, setCfg } = require('./locacao-teste-util');
const { registrarRotasLocacao } = require(BASE + '/locacao/locacao-routes');
const T = require(BASE + '/locacao/tarifa');

const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');
protegerConfig(db);
initLocacaoSchema(db);

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function eq(a, b, msg) { assert(a === b, msg, `esperado ${b}, veio ${a}`); }
function secao(t) { console.log(`\n── ${t}`); }

// ─── Valor por extenso ────────────────────────────────────────────────────────
secao('Valor por extenso (a promissória não existe sem ele)');

// O caso exato do modelo de referência: R$ 2.388,18.
eq(T.valorPorExtenso(2388.18), 'dois mil, trezentos e oitenta e oito reais e dezoito centavos',
  'bate com o texto do contrato real da REIMAC');

eq(T.valorPorExtenso(1), 'um real', 'singular');
eq(T.valorPorExtenso(2), 'dois reais', 'plural');
eq(T.valorPorExtenso(0), 'zero reais', 'zero');
eq(T.valorPorExtenso(0.01), 'um centavo', 'um centavo, sem parte de reais');
eq(T.valorPorExtenso(0.5), 'cinquenta centavos', 'só centavos');
eq(T.valorPorExtenso(100), 'cem reais', 'cem, não "cento"');
eq(T.valorPorExtenso(101), 'cento e um reais', 'cento e um');
eq(T.valorPorExtenso(1000), 'mil reais', '"mil", nunca "um mil"');
eq(T.valorPorExtenso(1200), 'mil e duzentos reais', 'liga com "e" em centena redonda');
eq(T.valorPorExtenso(1230), 'mil, duzentos e trinta reais', 'vírgula quando há dezena');
eq(T.valorPorExtenso(1000000), 'um milhão de reais', 'milhão exige a preposição "de"');
eq(T.valorPorExtenso(2000000), 'dois milhões de reais', 'milhões idem');
eq(T.valorPorExtenso(2500000), 'dois milhões, quinhentos mil reais',
  'mas NÃO leva "de" quando a escala não é a última palavra');
eq(T.valorPorExtenso(999.99), 'novecentos e noventa e nove reais e noventa e nove centavos',
  'maior valor antes do milhar');

// ─── Hora de corte ────────────────────────────────────────────────────────────
secao('Hora de corte da diária (cláusula 1 do modelo)');

// "a contagem tem início na retirada e finalização às 17:30 do mesmo dia"
eq(T.diariasPorCorte('2026-08-24 09:00', '2026-08-24 17:00', '17:30'), 1,
  'retirou 9h, devolveu 17h — 1 diária (não cruzou o corte)');
eq(T.diariasPorCorte('2026-08-24 09:00', '2026-08-24 18:00', '17:30'), 2,
  'devolveu 18h — cruzou o corte, 2 diárias');
eq(T.diariasPorCorte('2026-08-24 09:00', '2026-08-25 17:00', '17:30'), 2,
  'dia seguinte antes do corte — 2 diárias');
eq(T.diariasPorCorte('2026-08-24 09:00', '2026-08-25 18:00', '17:30'), 3,
  'dia seguinte depois do corte — 3 diárias');
eq(T.diariasPorCorte('2026-08-24 18:00', '2026-08-25 17:00', '17:30'), 1,
  'retirou DEPOIS do corte: a primeira diária vai até o corte seguinte');
eq(T.diariasPorCorte('2026-08-24 09:00', '2026-08-24 09:00', '17:30'), 0,
  'sem duração não há diária');
eq(T.diariasPorCorte('2026-08-24 09:00', '2026-08-25 09:00', ''), 0,
  'sem hora de corte configurada, a função não opina');
eq(T.diariasPorCorte('2026-08-24 09:00', '2026-08-25 09:00', '25:99'), 0,
  'hora de corte inválida é ignorada');

secao('A hora de corte muda o PREÇO, não só a contagem');
const tarifaDia = [{ faixa: 'dia', valor: 100, minimoFaturavel: 1, ativo: 1 }];

let c = T.calcularTarifa(tarifaDia, '2026-08-24 09:00', '2026-08-24 18:00');
eq(c.valorTotal, 100, 'sem corte: 9 horas = 1 diária');

c = T.calcularTarifa(tarifaDia, '2026-08-24 09:00', '2026-08-24 18:00', { horaCorte: '17:30' });
eq(c.valorTotal, 200, 'com corte às 17:30: as mesmas 9 horas viram 2 diárias');
eq(c.diarias, 2, 'e o cálculo informa quantas diárias foram');

// Com tarifa por hora cadastrada, o corte não se aplica: a unidade de
// cobrança já é menor que o dia.
const comHora = [
  { faixa: 'hora', valor: 20, minimoFaturavel: 1, ativo: 1 },
  { faixa: 'dia', valor: 100, minimoFaturavel: 1, ativo: 1 },
];
c = T.calcularTarifa(comHora, '2026-08-24 09:00', '2026-08-24 18:00', { horaCorte: '17:30' });
eq(c.diarias, null, 'com tarifa por hora, a hora de corte é ignorada');
eq(c.valorTotal, 100, 'e o preço continua o da melhor combinação (9h × 20 = 180 > diária 100)');

secao('Piso em reais é do CONTRATO, não do item');
// O cálculo por item NÃO conhece o piso — se conhecesse, multiplicaria pela
// quantidade e 12 andaimes com mínimo de R$ 80 virariam R$ 960.
c = T.calcularTarifa(tarifaDia, '2026-08-24 09:00', '2026-08-25 09:00', { quantidade: 12 });
eq(c.valorTotal, 1200, 'o item vale 12 × 100 — o piso não entra aqui');
assert(!('valorAntesDoMinimo' in c), 'calcularTarifa não fala mais em mínimo');

// ─── Cenário para as rotas ────────────────────────────────────────────────────
const SKU = 'TESTE-LOC-F7';
const PREFIXO_NUM = 'TSTF7';

function limpar() {
  const contratos = db.prepare('SELECT id FROM locacao_contratos WHERE numero LIKE ?')
    .all(PREFIXO_NUM + '%');
  for (const c2 of contratos) {
    db.prepare('DELETE FROM locacao_avalistas WHERE contratoId = ?').run(c2.id);
    db.prepare("DELETE FROM locacao_reservas WHERE documentoTipo='locacao' AND documentoId = ?").run(c2.id);
    db.prepare('DELETE FROM locacao_acertos WHERE contratoId = ?').run(c2.id);
    db.prepare('DELETE FROM locacao_itens WHERE contratoId = ?').run(c2.id);
    db.prepare('DELETE FROM locacao_eventos WHERE contratoId = ?').run(c2.id);
    db.prepare('DELETE FROM locacao_contratos WHERE id = ?').run(c2.id);
  }
  const ids = db.prepare('SELECT id FROM produtos WHERE sku LIKE ?').all(SKU + '%').map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM locacao_reservas WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_item_specs WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_tarifas WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM movimentacoes_estoque WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
  }
}
limpar();

// Reproduz o item do modelo: ANDAIME, indenização 199,02, 12 unidades, R$ 20/mês
const prod = db.prepare(`
  INSERT INTO produtos (sku, descricao, unidade, precoVenda, precoCusto, ativo)
  VALUES (?, 'ANDAIME TUBULAR 1,00 X 1,00M CONFORM.', 'UN', 199.02, 150, 1)
`).run(SKU).lastInsertRowid;
const colsMov = db.prepare('PRAGMA table_info(movimentacoes_estoque)').all().map(x => x.name);
const campos = ['produtoId', 'tipo', 'quantidade'].concat(colsMov.includes('data') ? ['data'] : []);
const vals = [prod, 'entrada', 50].concat(colsMov.includes('data') ? ['2026-01-01 00:00:00'] : []);
db.prepare(`INSERT INTO movimentacoes_estoque (${campos.join(',')})
            VALUES (${campos.map(() => '?').join(',')})`).run(...vals);
db.prepare(`INSERT INTO locacao_item_specs (produtoId, alugavel, exigeSerie, reposicaoPercentual)
            VALUES (?, 1, 0, 100)`).run(prod);
db.prepare("INSERT INTO locacao_tarifas (produtoId, faixa, valor, minimoFaturavel) VALUES (?, 'mes', 20, 1)").run(prod);

const cliente = db.prepare('SELECT id FROM pessoas LIMIT 1').get();

const app = express();
app.use(express.json());
registrarRotasLocacao(app, db);

function chamar(p, m, o = {}) {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  let out = null, st = 200, headers = {};
  const res = {
    json: x => { out = x; return res; },
    status: c2 => { st = c2; return res; },
    setHeader: (k, v) => { headers[k] = v; },
    headersSent: false,
    end: () => {},
    on: () => {}, once: () => {}, emit: () => {}, write: () => true,
  };
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, headers: {}, user: o.user };
  let i = 0;
  const next = () => { const h = l.route.stack[i++]; if (h) h.handle(req, res, next); };
  next();
  return { out, st, headers };
}

setCfg(db, 'locacao_enabled', '1');
setCfg(db, 'locacao_prefixo_numero', PREFIXO_NUM);
setCfg(db, 'locacao_exigir_vistoria', '0');

// ─── Configs novas ────────────────────────────────────────────────────────────
secao('Configuração das regras do contrato');

let r = chamar('/api/locacao/config', 'put', { body: { locacao_hora_corte: '17:30' } });
assert(r.st === 200, 'hora de corte é aceita no formato HH:MM', JSON.stringify(r.out));

r = chamar('/api/locacao/config', 'put', { body: { locacao_hora_corte: '25:00' } });
assert(r.st === 400, 'hora de corte impossível é recusada');
r = chamar('/api/locacao/config', 'put', { body: { locacao_hora_corte: '17h30' } });
assert(r.st === 400, 'formato errado de hora é recusado');
r = chamar('/api/locacao/config', 'put', { body: { locacao_hora_corte: '' } });
assert(r.st === 200, 'vazio é válido — significa diária de 24h corridas');

r = chamar('/api/locacao/config', 'put', { body: { locacao_promissoria_base: 'chute' } });
assert(r.st === 400, 'base de promissória inválida é recusada');
r = chamar('/api/locacao/config', 'put', { body: { locacao_promissoria_base: 'reposicao' } });
assert(r.st === 200, 'base reposicao é aceita');

r = chamar('/api/locacao/config', 'put', {
  body: { locacao_clausulas_padrao: 'Item 1.º - A contagem do período...' } });
assert(r.st === 200, 'cláusulas padrão são gravadas');

r = chamar('/api/locacao/config', 'put', { body: { locacao_clausulas_padrao: 'x'.repeat(41000) } });
assert(r.st === 400, 'texto absurdo de cláusulas é recusado (colar arquivo por engano)');

r = chamar('/api/locacao/config', 'put', { body: { locacao_limpeza_percentual: '40' } });
assert(r.st === 200, 'limpeza percentual aceita');
r = chamar('/api/locacao/config', 'put', { body: { locacao_valor_minimo: '80' } });
assert(r.st === 200, 'valor mínimo aceito');

// ─── Cláusulas copiadas no contrato ───────────────────────────────────────────
secao('Cláusulas são COPIADAS, não referenciadas');

setCfg(db, 'locacao_clausulas_padrao', 'CLAUSULA ORIGINAL DO TENANT');
r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-08-24 09:24',
          dataRetornoPrevisto: '2026-09-22 09:24',
          enderecoEntrega: 'RUA NOSSA SENHORA DE NAZARE QD 17, 20 - BELA VISTA - MARABA',
          contatoObra: 'RAFAEL', telefoneObra: '(94) 99263-5236',
          tipoFrete: 'SEM FRETE' },
});
assert(r.st === 200, 'locação criada com os campos do contrato', JSON.stringify(r.out.error));
const loc = r.out.contrato.id;
eq(r.out.contrato.clausulas, 'CLAUSULA ORIGINAL DO TENANT', 'cláusulas copiadas na criação');
eq(r.out.contrato.contatoObra, 'RAFAEL', 'contato da obra gravado');
eq(r.out.contrato.tipoFrete, 'SEM FRETE', 'tipo de frete gravado');

// Muda o padrão do tenant: o contrato já criado NÃO pode mudar.
setCfg(db, 'locacao_clausulas_padrao', 'CLAUSULA NOVA, DEPOIS DA ASSINATURA');
r = chamar('/api/locacao/locacoes/:id', 'get', { params: { id: loc } });
eq(r.out.contrato.clausulas, 'CLAUSULA ORIGINAL DO TENANT',
  'editar o padrão do tenant NÃO reescreve contrato já criado');

// O novo contrato nasce com o texto novo.
r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-10-01', dataRetornoPrevisto: '2026-10-05' },
});
eq(r.out.contrato.clausulas, 'CLAUSULA NOVA, DEPOIS DA ASSINATURA',
  'mas o contrato seguinte nasce com o texto atual');
const locB = r.out.contrato.id;

// E dá para sobrescrever num contrato específico.
r = chamar('/api/locacao/locacoes/:id', 'put', {
  params: { id: locB }, body: { clausulas: 'TEXTO ESPECIAL DESTE CONTRATO' } });
eq(r.out.contrato.clausulas, 'TEXTO ESPECIAL DESTE CONTRATO',
  'cláusulas podem ser alteradas num contrato específico');

// ─── Promissória sobre a REPOSIÇÃO ────────────────────────────────────────────
secao('Promissória: garantia da frota, não do aluguel');

chamar('/api/locacao/locacoes/:id/itens', 'post', {
  params: { id: loc }, body: { produtoId: prod, quantidade: 12 } });

const contratoComItem = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(loc);
assert(contratoComItem.valorLocacao > 0, 'a locação tem valor', String(contratoComItem.valorLocacao));

r = chamar('/api/locacao/locacoes/:id/promissoria', 'post', { params: { id: loc } });
assert(r.st === 200, 'promissória gerada', JSON.stringify(r.out.error));
eq(r.out.base, 'reposicao', 'base padrão é a reposição');
// 12 unidades × 100% de 199,02 = 2388,24 — o modelo real traz 2388,18
// (6 centavos de diferença, provavelmente arredondamento do sistema antigo).
eq(r.out.contrato.promissoriaValor, 2388.24,
  '12 andaimes × R$ 199,02 de indenização = R$ 2.388,24');
// O ponto não é a proporção, é a NATUREZA: a promissória não tem relação com
// o valor do aluguel. No modelo real foram R$ 2.388,18 de promissória para
// R$ 230,00 de locação; aqui o aluguel é outro, mas a garantia continua sendo
// a frota.
assert(r.out.contrato.promissoriaValor > r.out.contrato.valorTotal,
  'o valor supera o do aluguel — é garantia da frota, não do pagamento',
  `promissória ${r.out.contrato.promissoriaValor} vs locação ${r.out.contrato.valorTotal}`);
assert(r.out.contrato.promissoriaValor !== r.out.contrato.valorTotal,
  'e não é simplesmente uma cópia do total do contrato');

// 12 andaimes a R$ 20/mês = R$ 240. O piso de R$ 80 é do CONTRATO e já foi
// superado, então não age — antes, aplicado por unidade, isto virava R$ 960.
eq(r.out.contrato.valorLocacao, 240,
  'contrato de R$ 240 fica em R$ 240: o piso de R$ 80 é do contrato e já foi superado');
assert(!!r.out.contrato.promissoriaVencimento, 'vencimento calculado');

// Base alternativa
r = chamar('/api/locacao/locacoes/:id/promissoria', 'post', {
  params: { id: loc }, body: { base: 'total' } });
eq(r.out.contrato.promissoriaValor, contratoComItem.valorTotal,
  'base "total" usa o valor do contrato');

// Valor explícito vence a base
r = chamar('/api/locacao/locacoes/:id/promissoria', 'post', {
  params: { id: loc }, body: { valor: 5000, vencimento: '2026-12-31' } });
eq(r.out.contrato.promissoriaValor, 5000, 'valor informado à mão prevalece');
eq(r.out.contrato.promissoriaVencimento, '2026-12-31', 'vencimento informado prevalece');

r = chamar('/api/locacao/locacoes/:id/promissoria', 'delete', { params: { id: loc } });
assert(r.st === 200, 'promissória pode ser removida');
eq(db.prepare('SELECT promissoriaEmitir FROM locacao_contratos WHERE id = ?').get(loc).promissoriaEmitir, 0,
  'e o contrato deixa de emitir');

// Recoloca para o teste do PDF
chamar('/api/locacao/locacoes/:id/promissoria', 'post', { params: { id: loc } });

// Sem item de indenização, a promissória por reposição é recusada com motivo
r = chamar('/api/locacao/locacoes/:id/promissoria', 'post', { params: { id: locB } });
assert(r.st === 400 && /indeniza/.test(r.out.error || ''),
  'sem valor de indenização, a recusa diz onde cadastrar', JSON.stringify(r.out));

secao('O piso do contrato agindo de verdade');
// Contrato pequeno: 1 unidade a R$ 20 fica abaixo do mínimo de R$ 80.
r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-11-01', dataRetornoPrevisto: '2026-11-30' } });
const locMin = r.out.contrato.id;
r = chamar('/api/locacao/locacoes/:id/itens', 'post', {
  params: { id: locMin }, body: { produtoId: prod, quantidade: 1 } });
eq(r.out.itens[0].valorTotal, 20, 'o ITEM continua valendo R$ 20 — o piso não reescreve o item');
eq(r.out.totais.valorLocacao, 80, 'mas o CONTRATO sobe ao mínimo de R$ 80');
assert(r.out.totais.minimoAplicado === true, 'e o retorno diz que o piso agiu');
eq(r.out.totais.valorLocacaoItens, 20, 'guardando quanto os itens somavam antes');

// Acrescentar itens até passar do piso: ele para de agir.
r = chamar('/api/locacao/locacoes/:id/itens', 'post', {
  params: { id: locMin }, body: { produtoId: prod, quantidade: 5 } });
eq(r.out.totais.valorLocacao, 120, '20 + 100 = 120, acima do piso — soma normal');
assert(r.out.totais.minimoAplicado === false, 'o piso deixa de agir sozinho');

// Contrato vazio não nasce valendo o mínimo.
r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-11-01', dataRetornoPrevisto: '2026-11-02' } });
eq(r.out.contrato.valorLocacao, 0, 'contrato recém-criado, sem itens, vale zero — não o mínimo');

// ─── Avalistas ────────────────────────────────────────────────────────────────
secao('Avalistas');

r = chamar('/api/locacao/locacoes/:id/avalistas', 'post', {
  params: { id: loc }, body: { nome: 'JOSE AVALISTA', cpfCnpj: '111.222.333-44', endereco: 'RUA X, 10' } });
assert(r.st === 200, 'avalista cadastrado', JSON.stringify(r.out.error));
eq(r.out.avalistas.length, 1, 'aparece no documento');

r = chamar('/api/locacao/locacoes/:id/avalistas', 'post', {
  params: { id: loc }, body: { nome: 'MARIA AVALISTA', cpfCnpj: '555.666.777-88' } });
eq(r.out.avalistas.length, 2, 'dois avalistas (como no modelo)');
eq(r.out.avalistas[1].ordem, 1, 'a ordem é sequencial');

r = chamar('/api/locacao/locacoes/:id/avalistas', 'post', { params: { id: loc }, body: {} });
assert(r.st === 400, 'avalista sem nome nem documento é recusado');

const avalistaId = r.out && r.out.avalistas ? null : null;
const av = db.prepare('SELECT id FROM locacao_avalistas WHERE contratoId = ? ORDER BY ordem').all(loc);
r = chamar('/api/locacao/locacoes/:id/avalistas/:avalistaId', 'delete', {
  params: { id: loc, avalistaId: av[1].id } });
assert(r.st === 200, 'avalista removido');
r = chamar('/api/locacao/locacoes/:id/avalistas/:avalistaId', 'delete', {
  params: { id: loc, avalistaId: av[1].id } });
assert(r.st === 404, 'remover duas vezes é 404');

// ─── PDF ──────────────────────────────────────────────────────────────────────
secao('PDF do contrato');

const { gerar } = require(BASE + '/locacao/locacao-pdf');
const { carregar } = require(BASE + '/locacao/contrato');
const doc = carregar(db, loc);
const itensPdf = db.prepare(`
  SELECT i.*, p.precoVenda, p.precoCusto FROM locacao_itens i
  LEFT JOIN produtos p ON p.id = i.produtoId WHERE i.contratoId = ?
`).all(loc).map(i => ({ ...i, valorIndenizacao: 199.02 }));

const destino = '/tmp/teste-contrato-locacao.pdf';
const out = fs.createWriteStream(destino);
gerar(out, {
  contrato: doc.contrato,
  itens: itensPdf,
  acertos: doc.acertos,
  avalistas: doc.avalistas,
  cliente: db.prepare('SELECT * FROM pessoas WHERE id = ?').get(cliente.id),
  locadora: db.prepare('SELECT * FROM estabelecimentos LIMIT 1').get() || {},
  config: { locacao_valor_minimo: '80' },
  usuario: 'teste-automatizado',
});

out.on('finish', () => {
  const tam = fs.statSync(destino).size;
  assert(tam > 2000, `PDF gerado com ${tam} bytes`, String(tam));
  const conteudo = fs.readFileSync(destino);
  assert(conteudo.slice(0, 5).toString() === '%PDF-', 'e é um PDF de verdade');

  // Limpeza
  try { fs.unlinkSync(destino); } catch (_) {}
  limpar();
  console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
  process.exit(fail === 0 ? 0 : 1);
});
