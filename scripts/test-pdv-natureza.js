#!/usr/bin/env node
/**
 * test-pdv-natureza.js — os efeitos que a natureza de operação dispara no PDV.
 *
 * A emissão em si depende de certificado + SEFAZ e não cabe em teste; o que cabe
 * — e é o que mudou em 2026-08-26 — é a parte determinística: a resolução da
 * natureza e da política do balcão, as parcelas da conta a receber e a baixa de
 * estoque. Essas funções são exportadas por nfce-routes justamente para isto.
 *
 * Roda contra o tenant `labfiscal`, cria a massa que precisa e limpa no fim.
 *
 * Uso: node scripts/test-pdv-natureza.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const {
  naturezaDoPdv, politicaDoPdv, parcelasDaPolitica, aplicarEfeitosDaNatureza,
} = require(BASE + '/nfce-routes');

const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

// ─── Schema exigido pela mudança (o db-schema roda no boot; aqui é explícito) ──
function alterSafe(sql) { try { db.exec(sql); } catch { /* já existe */ } }
alterSafe('ALTER TABLE nfce_config ADD COLUMN pdvTipoOperacaoId INTEGER');
alterSafe('ALTER TABLE nfce_config ADD COLUMN pdvPoliticaPrazoId INTEGER');
alterSafe('ALTER TABLE nfce ADD COLUMN tipoOperacaoId INTEGER');
alterSafe('ALTER TABLE contas_a_receber ADD COLUMN nfceId INTEGER');

secao('Schema');
const colsCfg = db.prepare('PRAGMA table_info(nfce_config)').all().map(c => c.name);
assert(colsCfg.includes('pdvTipoOperacaoId') && colsCfg.includes('pdvPoliticaPrazoId'),
  'nfce_config tem pdvTipoOperacaoId e pdvPoliticaPrazoId');
assert(db.prepare('PRAGMA table_info(contas_a_receber)').all().some(c => c.name === 'nfceId'),
  'contas_a_receber tem nfceId (rastro da NFC-e no financeiro)');

// ─── Massa ────────────────────────────────────────────────────────────────────
const cfgOriginal = db.prepare('SELECT pdvTipoOperacaoId, pdvPoliticaPrazoId FROM nfce_config WHERE id = 1').get() || {};
const natureza = db.prepare(`SELECT * FROM tipos_operacao
  WHERE ativo = 1 AND emiteNFe = 1 AND geraFinanceiro = 1 AND movimentaEstoque = 1
  ORDER BY id LIMIT 1`).get();
if (!natureza) { console.error('Sem tipo de operação utilizável no labfiscal'); process.exit(1); }

let politica = db.prepare(`SELECT * FROM politicas_prazo WHERE ativo = 1 AND aplicaPdv = 1 AND tipo = 'prazo'`).get();
let politicaCriada = false;
if (!politica) {
  const r = db.prepare(`INSERT INTO politicas_prazo (nome, tipo, prazoDias, aplicaPdv, aplicaVendas, ativo)
    VALUES ('TESTE PDV 30/60', 'prazo', '30/60', 1, 1, 1)`).run();
  politica = db.prepare('SELECT * FROM politicas_prazo WHERE id = ?').get(r.lastInsertRowid);
  politicaCriada = true;
}

const produto = db.prepare("SELECT id FROM produtos WHERE sku = 'LAB-FERT-01'").get()
  || db.prepare('SELECT id FROM produtos ORDER BY id LIMIT 1').get();
const pessoa = db.prepare("SELECT id FROM pessoas ORDER BY id LIMIT 1").get();

db.prepare('UPDATE nfce_config SET pdvTipoOperacaoId = ?, pdvPoliticaPrazoId = ? WHERE id = 1')
  .run(natureza.id, politica.id);

secao('Resolução da config do balcão');
const nat = naturezaDoPdv(db);
assert(nat && nat.id === natureza.id, `naturezaDoPdv devolve a natureza gravada (${nat && nat.descricao})`);
const pol = politicaDoPdv(db);
assert(pol && pol.id === politica.id, `politicaDoPdv devolve a política gravada (${pol && pol.nome})`);

db.prepare('UPDATE nfce_config SET pdvTipoOperacaoId = NULL WHERE id = 1').run();
assert(naturezaDoPdv(db) === null, 'sem natureza gravada, naturezaDoPdv devolve null (a emissão vai parar)');
db.prepare('UPDATE nfce_config SET pdvTipoOperacaoId = ? WHERE id = 1').run(natureza.id);

secao('Parcelas conforme a política');
const umaSo = parcelasDaPolitica(null, 150, '2026-08-26');
assert(umaSo.length === 1 && umaSo[0].dataVencimento === '2026-08-26' && umaSo[0].valor === 150,
  'sem política: parcela única vencendo no dia da venda');

const aVista = parcelasDaPolitica({ tipo: 'vista' }, 99.9, '2026-08-26');
assert(aVista.length === 1 && aVista[0].dataVencimento === '2026-08-26',
  'política à vista: parcela única no dia da venda');

const aPrazo = parcelasDaPolitica({ tipo: 'prazo', prazoDias: '30/60/90' }, 100, '2026-08-26');
assert(aPrazo.length === 3, `política 30/60/90: três parcelas (veio ${aPrazo.length})`);
assert(aPrazo.map(p => p.dataVencimento).join(' ') === '2026-09-25 2026-10-25 2026-11-24',
  `vencimentos somados à data da venda (${aPrazo.map(p => p.dataVencimento).join(' ')})`);
assert(Number(aPrazo.reduce((s, p) => s + p.valor, 0).toFixed(2)) === 100,
  'soma das parcelas fecha o total');

const centavos = parcelasDaPolitica({ tipo: 'prazo', prazoDias: '30/60/90' }, 100.01, '2026-08-26');
assert(Number(centavos.reduce((s, p) => s + p.valor, 0).toFixed(2)) === 100.01,
  'total quebrado em centavos não se perde no rateio');

secao('Efeitos da natureza');
const itens = [{ produtoId: produto.id, quantidade: 2, precoUnitario: 50, valorTotal: 100, descricao: 'ITEM TESTE' }];
const NFCE_ID = 999901;   // id sintético: não gravo NFC-e, só os efeitos que ela dispara

db.transaction(() => {
  aplicarEfeitosDaNatureza(db, {
    nfceId: NFCE_ID, numero: 4242, natureza, politica,
    pessoaId: pessoa.id, itens, valorTotal: 100,
    dataEmissao: '2026-08-26', tPag: '17',
  });
})();

const crs = db.prepare('SELECT * FROM contas_a_receber WHERE nfceId = ? ORDER BY parcelaNumero').all(NFCE_ID);
assert(crs.length === 2, `conta a receber aberta pela natureza geraFinanceiro=1 (${crs.length} parcelas)`);
assert(crs.every(c => c.origem === 'nfce' && c.status === 'pendente'),
  "CR nasce com origem='nfce' e status='pendente'");
assert(crs.every(c => c.pessoaId === pessoa.id && c.formaPagamento === '17'),
  'CR carrega a pessoa da venda e o meio de pagamento usado');
assert(crs[0].descricao === 'NFC-e 4242', `descrição aponta o número da NFC-e (${crs[0].descricao})`);
assert(Number(crs.reduce((s, c) => s + c.valor, 0).toFixed(2)) === 100, 'CRs somam o total da venda');

const movs = db.prepare("SELECT * FROM movimentacoes_estoque WHERE origem = 'nfce' AND origemId = ?").all(NFCE_ID);
assert(movs.length === 1, `baixa de estoque pela natureza movimentaEstoque=1 (${movs.length} movimento)`);
assert(movs[0].tipo === 'saida' && Number(movs[0].quantidade) === 2,
  `saída de 2 unidades (veio ${movs[0] && movs[0].tipo} ${movs[0] && movs[0].quantidade})`);

secao('Natureza sem efeitos não movimenta nada');
const NFCE_ID2 = 999902;
db.transaction(() => {
  aplicarEfeitosDaNatureza(db, {
    nfceId: NFCE_ID2, numero: 4243,
    natureza: { ...natureza, geraFinanceiro: 0, movimentaEstoque: 0 },
    politica, pessoaId: pessoa.id, itens, valorTotal: 100,
    dataEmissao: '2026-08-26', tPag: '01',
  });
})();
assert(db.prepare('SELECT COUNT(*) c FROM contas_a_receber WHERE nfceId = ?').get(NFCE_ID2).c === 0,
  'geraFinanceiro=0: nenhuma conta a receber');
assert(db.prepare("SELECT COUNT(*) c FROM movimentacoes_estoque WHERE origem='nfce' AND origemId=?").get(NFCE_ID2).c === 0,
  'movimentaEstoque=0: nenhuma baixa de estoque');

// ─── Limpeza ──────────────────────────────────────────────────────────────────
db.prepare('DELETE FROM contas_a_receber WHERE nfceId IN (?, ?)').run(NFCE_ID, NFCE_ID2);
db.prepare("DELETE FROM movimentacoes_estoque WHERE origem = 'nfce' AND origemId IN (?, ?)").run(NFCE_ID, NFCE_ID2);
if (politicaCriada) db.prepare('DELETE FROM politicas_prazo WHERE id = ?').run(politica.id);
db.prepare('UPDATE nfce_config SET pdvTipoOperacaoId = ?, pdvPoliticaPrazoId = ? WHERE id = 1')
  .run(cfgOriginal.pdvTipoOperacaoId || null, cfgOriginal.pdvPoliticaPrazoId || null);
db.close();

console.log(`\n${'─'.repeat(56)}`);
console.log(fail === 0 ? `TODOS OS ${ok} ASSERTS PASSARAM` : `${ok} OK · ${fail} FALHARAM`);
process.exit(fail === 0 ? 0 : 1);
