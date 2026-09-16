#!/usr/bin/env node
/**
 * test-farmacia-f6.js — Fase 6: balcão de farmácia.
 *
 * O que o balcão precisa e este teste verifica:
 *   - buscar por PRINCÍPIO ATIVO, não só por descrição (quem chega com receita
 *     pede "losartana", não a marca);
 *   - a busca devolver tarja e PMC junto, para o balconista saber antes de
 *     bipar o que exige receita;
 *   - oferecer genérico e similar da mesma substância, do mais barato;
 *   - travar preço acima do PMC — inclusive quando o preço é editado no PDV,
 *     que é como a trava de tela seria contornada;
 *   - com o módulo desligado, a busca continuar EXATAMENTE a de antes.
 *
 * Roda contra `labfiscal`, cria a própria massa e limpa no fim.
 * Uso: node scripts/test-farmacia-f6.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const express = require(BASE + '/node_modules/express');

const { initFarmaciaSchema } = require(BASE + '/farmacia/farmacia-schema');
const { registrarRotasFarmacia } = require(BASE + '/farmacia/farmacia-routes');
const { registrarRotasNFCe } = require(BASE + '/nfce-routes');
const { conferirPmc } = require(BASE + '/farmacia/preco');

const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

initFarmaciaSchema(db);

const PREFIXO = 'TESTE-FARM-F6-';
function limpar() {
  const ids = db.prepare('SELECT id FROM produtos WHERE sku LIKE ?').all(PREFIXO + '%').map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM farmacia_medicamento_specs WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
  }
}
limpar();

const flagOriginal = db.prepare("SELECT valor FROM config WHERE chave = 'farmacia_enabled'").get();
function setFlag(v) {
  db.prepare(`INSERT INTO config (chave, valor) VALUES ('farmacia_enabled', ?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(String(v));
}
function setCfg(chave, valor) {
  db.prepare(`INSERT INTO config (chave, valor) VALUES (?, ?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(chave, String(valor));
}
setFlag(1);

// ─── Massa: três marcas da mesma substância + um item sem relação ────────────
function criarMed(sufixo, descricao, preco, spec) {
  const id = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, ativo, codigoBarras)
    VALUES (?, ?, 'UN', ?, '30049099', 1, ?)`).run(PREFIXO + sufixo, descricao, preco, spec.ean || null).lastInsertRowid;
  db.prepare(`INSERT INTO farmacia_medicamento_specs
    (produtoId, registroAnvisa, ean, substancia, apresentacao, tarja, pmc, regimePreco, tipoProduto,
     laboratorio, listaPortaria344, antimicrobiano)
    VALUES (?, '1234567890123', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, spec.ean || null, spec.substancia, spec.apresentacao || '50 MG COM CT BL AL PLAS INC X 30',
    spec.tarja || 'livre', spec.pmc, spec.regime || 'regulado', spec.tipo || 'Similar',
    spec.lab || 'LAB TESTE', spec.lista344 || null, spec.antimicrobiano ? 1 : 0);
  return id;
}

const idRef = criarMed('REF', 'CORUS 50MG', 30.00, { substancia: 'LOSARTANA POTASSICA', pmc: 32.00, tipo: 'Novo', ean: '7891111111111' });
const idGen = criarMed('GEN', 'LOSARTANA POTASSICA 50MG', 12.00, { substancia: 'LOSARTANA POTASSICA', pmc: 20.00, tipo: 'Genérico' });
const idSim = criarMed('SIM', 'LOSARFAST 50MG', 18.00, { substancia: 'LOSARTANA POTASSICA', pmc: 25.00, tipo: 'Similar' });
const idOutro = criarMed('OUT', 'DIPIRONA 500MG', 8.00, { substancia: 'DIPIRONA SODICA', pmc: 10.00, tipo: 'Genérico' });
const idLiberado = criarMed('LIB', 'FITOTERAPICO LIVRE', 90.00, { substancia: 'GINKGO BILOBA', pmc: 40.00, regime: 'liberado' });
const idSemPmc = criarMed('NOPMC', 'HOSPITALAR SEM PMC', 500.00, { substancia: 'ABATACEPTE', pmc: null });

// ─── Trava de PMC ────────────────────────────────────────────────────────────
secao('Teto de preço (PMC da CMED)');

let r = conferirPmc(db, [{ produtoId: idRef, precoUnitario: 31.99 }]);
assert(r.erros.length === 0, 'preço abaixo do PMC passa');

r = conferirPmc(db, [{ produtoId: idRef, precoUnitario: 32.00 }]);
assert(r.erros.length === 0, 'preço exatamente no PMC passa');

r = conferirPmc(db, [{ produtoId: idRef, precoUnitario: 32.01 }]);
assert(r.erros.length === 1 && /acima do PMC/.test(r.erros[0]),
  'um centavo acima do PMC é bloqueado', JSON.stringify(r.erros));
assert(/32\.00/.test(r.erros[0]) && /32\.01/.test(r.erros[0]),
  'a mensagem diz o preço praticado e o teto', r.erros[0]);

r = conferirPmc(db, [{ produtoId: idRef, precoUnitario: 32.004 }]);
assert(r.erros.length === 0, 'tolerância de meio centavo evita bloqueio por arredondamento de tela');

r = conferirPmc(db, [{ produtoId: idLiberado, precoUnitario: 999 }]);
assert(r.erros.length === 0,
  'medicamento de REGIME LIBERADO não tem teto de PMC a cobrar (é ~10% da lista da CMED)');

r = conferirPmc(db, [{ produtoId: idSemPmc, precoUnitario: 9999 }]);
assert(r.erros.length === 0,
  'medicamento sem PMC na coluna da UF não é bloqueado (bloquear seria inventar regra)');

// O teto vale sobre o que é EFETIVAMENTE COBRADO. A emissão monta o vProd do
// XML a partir de `valorTotal` quando ele vem preenchido, sem exigir que bata
// com quantidade × precoUnitario — então olhar só o unitário deixava o teto
// virar decoração.
r = conferirPmc(db, [{ produtoId: idRef, precoUnitario: 30, quantidade: 1, valorTotal: 999 }]);
assert(r.erros.length === 1,
  'unitário dentro do teto mas TOTAL inflado é bloqueado', JSON.stringify(r.erros));
assert(/unitário informado/.test(r.erros[0]),
  'a mensagem explica a divergência entre unitário e total', r.erros[0]);

r = conferirPmc(db, [{ produtoId: idRef, precoUnitario: 30, quantidade: 3, valorTotal: 90 }]);
assert(r.erros.length === 0, 'total coerente com quantidade × unitário passa normalmente');

r = conferirPmc(db, [{ produtoId: idRef, precoUnitario: 30, quantidade: 2, valorTotal: 70 }]);
assert(r.erros.length === 1 && /35\.00/.test(r.erros[0]),
  'o preço comparado é o total dividido pela quantidade (35,00), não o unitário digitado',
  JSON.stringify(r.erros));

r = conferirPmc(db, [{ produtoId: idRef, precoUnitario: 31, quantidade: 0, valorTotal: 999 }]);
assert(r.erros.length === 0, 'quantidade zero cai de volta no unitário, sem divisão por zero');

r = conferirPmc(db, [{ produtoId: idRef, precoUnitario: 40 }], { travar: false });
assert(r.erros.length === 0 && r.avisos.length === 1,
  'com a trava desligada vira aviso, não bloqueio');

r = conferirPmc(db, [
  { produtoId: idGen, precoUnitario: 12 },
  { produtoId: idSim, precoUnitario: 99 },
  { produtoId: idRef, precoUnitario: 5 },
]);
assert(r.erros.length === 1 && /LOSARFAST/.test(r.erros[0]),
  'numa venda com vários itens, só o item acima do teto é apontado', JSON.stringify(r.erros));

// ─── Rotas do balcão ─────────────────────────────────────────────────────────
secao('Busca e equivalentes');

const app = express();
app.use(express.json());
registrarRotasFarmacia(app, db);
registrarRotasNFCe(app, db);

function chamar(p, m, o = {}) {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  let out = null, st = 200;
  const res = { json: x => { out = x; return res; }, status: c => { st = c; return res; },
                setHeader: () => {}, send: x => { out = x; return res; } };
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, user: o.user, headers: {} };
  let i = 0; const stack = l.route.stack;
  const next = () => { const h = stack[i++]; if (h) h.handle(req, res, next); };
  next();
  return { out, st };
}

let x = chamar('/api/nfce/produtos/buscar', 'get', { query: { q: 'losartana potassica' } });
assert(x.out.farmacia === true, 'com o módulo ligado a busca entra no modo farmácia');
const achados = x.out.produtos.filter(p => String(p.sku).startsWith(PREFIXO));
assert(achados.length === 3, 'busca por princípio ativo acha as 3 marcas da substância',
  JSON.stringify(achados.map(a => a.descricao)));
assert(achados.some(p => p.id === idRef), 'inclui a marca cujo NOME não contém o princípio ativo (CORUS)');
assert(achados.every(p => p.tarja !== undefined && p.pmc !== undefined),
  'o resultado traz tarja e PMC para o balconista decidir antes de bipar');

x = chamar('/api/nfce/produtos/buscar', 'get', { query: { q: 'CORUS' } });
assert(x.out.produtos.some(p => p.id === idRef), 'busca por nome comercial continua funcionando');

x = chamar('/api/nfce/produtos/buscar', 'get', { query: { q: '7891111111111' } });
assert(x.out.matchExato === true && x.out.produtos[0].id === idRef,
  'leitor de código de barras continua com match exato (caminho de sempre)');

// Com o módulo desligado, a busca tem de voltar a ser a de antes.
setFlag(0);
x = chamar('/api/nfce/produtos/buscar', 'get', { query: { q: 'losartana potassica' } });
assert(!x.out.farmacia, 'com o módulo desligado a busca não entra no modo farmácia');
const achadosOff = x.out.produtos.filter(p => String(p.sku).startsWith(PREFIXO));
assert(achadosOff.length === 1 && achadosOff[0].id === idGen,
  'sem o módulo, busca por princípio ativo só acha o que tem isso na descrição — comportamento histórico preservado',
  JSON.stringify(achadosOff.map(a => a.descricao)));
assert(achadosOff[0].tarja === undefined, 'sem o módulo, o resultado não carrega campo farmacêutico');
setFlag(1);

// Equivalentes
x = chamar('/api/farmacia/equivalentes/:produtoId', 'get', { params: { produtoId: idRef } });
assert(x.st === 200 && x.out.substancia === 'LOSARTANA POTASSICA', 'equivalentes respondem a substância');
const eq = x.out.items.filter(i => String(i.sku).startsWith(PREFIXO));
assert(eq.length === 2, 'traz os 2 equivalentes e não repete o próprio produto',
  JSON.stringify(eq.map(e => e.descricao)));
assert(eq[0].produtoId === idGen && eq[0].precoVenda === 12,
  'o mais barato vem primeiro (é o motivo de o cliente aceitar a troca)',
  JSON.stringify(eq.map(e => e.precoVenda)));
assert(eq.some(e => e.tipoProduto === 'Genérico') && eq.some(e => e.tipoProduto === 'Similar'),
  'a lista distingue genérico de similar');
assert(!eq.some(e => e.produtoId === idOutro), 'medicamento de outra substância fica fora');

x = chamar('/api/farmacia/equivalentes/:produtoId', 'get', { params: { produtoId: 999999 } });
assert(x.st === 200 && x.out.items.length === 0, 'produto sem cadastro devolve lista vazia, não erro');

// Conferência de preço pela rota
x = chamar('/api/farmacia/preco/conferir', 'post', {
  body: { itens: [{ produtoId: idRef, precoUnitario: 50 }] },
});
assert(x.st === 200 && x.out.liberado === false && x.out.erros.length === 1,
  'rota de conferência bloqueia preço acima do teto');

x = chamar('/api/farmacia/preco/conferir', 'post', {
  body: { itens: [{ produtoId: idRef, precoUnitario: 20 }] },
});
assert(x.out.liberado === true, 'rota de conferência libera preço dentro do teto');

// Config farmacia_travar_pmc = 0 → vira aviso também na rota.
setCfg('farmacia_travar_pmc', '0');
x = chamar('/api/farmacia/preco/conferir', 'post', {
  body: { itens: [{ produtoId: idRef, precoUnitario: 50 }] },
});
assert(x.out.liberado === true && x.out.avisos.length === 1,
  'com farmacia_travar_pmc=0 a rota libera mas avisa');
setCfg('farmacia_travar_pmc', '1');

// Gate: sem a flag, as rotas do balcão fecham.
setFlag(0);
x = chamar('/api/farmacia/equivalentes/:produtoId', 'get', { params: { produtoId: idRef } });
assert(x.st === 403 && x.out.error === 'farmacia_disabled', 'equivalentes respeitam o gate do módulo');
setFlag(1);

// ─── Limpeza ─────────────────────────────────────────────────────────────────
limpar();
if (flagOriginal) setFlag(flagOriginal.valor);
else db.prepare("DELETE FROM config WHERE chave = 'farmacia_enabled'").run();
const sobrou = db.prepare('SELECT COUNT(*) n FROM produtos WHERE sku LIKE ?').get(PREFIXO + '%').n;
assert(sobrou === 0, 'massa de teste removida do tenant');

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
