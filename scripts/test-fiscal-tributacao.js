#!/usr/bin/env node
/**
 * test-fiscal-tributacao.js — motor de tributação por regime.
 *
 * Roda contra o tenant de laboratório `labfiscal` (nunca contra produção).
 * O caso-verdade do regime normal é a pré-nota 197 do Solution ERP da JA
 * Agrícola, item 259: vProd 1,00 · CST 20 · alíquota 12,00 · redução 78,95
 * → base 0,21 e ICMS 0,03. Se o motor divergir disso, divergiu do ERP que
 * ele precisa substituir.
 *
 * Uso: node scripts/test-fiscal-tributacao.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const T = require(BASE + '/fiscal-tributacao');

const DB_PATH = BASE + '/data/tenants/labfiscal/pncp.db';
const db = new Database(DB_PATH);

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

// ─── Preparo: limpa regras do lab e semeia as do cenário ──────────────────────
db.prepare('DELETE FROM fiscal_regras_trib').run();
db.prepare('DELETE FROM fiscal_calculo_memoria').run();

const insRegra = db.prepare(`
  INSERT INTO fiscal_regras_trib
    (descricao, prioridade, regimeEmitente, cfop, ncmPrefixo, ambito, tipoContribuinte,
     cstIcms, modBC, pIcms, pRedBC, pMVAST, pIcmsST, cstIpi, pIpi,
     cstPis, pPis, cstCofins, pCofins, observacaoFiscal)
  VALUES (@descricao, @prioridade, @regimeEmitente, @cfop, @ncmPrefixo, @ambito, @tipoContribuinte,
     @cstIcms, @modBC, @pIcms, @pRedBC, @pMVAST, @pIcmsST, @cstIpi, @pIpi,
     @cstPis, @pPis, @cstCofins, @pCofins, @observacaoFiscal)`);

const REGRA_VAZIA = {
  descricao: '', prioridade: 10, regimeEmitente: null, cfop: null, ncmPrefixo: null,
  ambito: null, tipoContribuinte: null, cstIcms: null, modBC: null, pIcms: null,
  pRedBC: null, pMVAST: null, pIcmsST: null, cstIpi: null, pIpi: null,
  cstPis: null, pPis: null, cstCofins: null, pCofins: null, observacaoFiscal: null,
};

// Genérica do regime normal: tributação integral 18% dentro do estado.
const idGenerica = insRegra.run({ ...REGRA_VAZIA,
  descricao: 'Normal — venda interna tributada', prioridade: 10,
  regimeEmitente: 3, ambito: 'interna',
  cstIcms: '00', modBC: 3, pIcms: 18,
  cstPis: '01', pPis: 1.65, cstCofins: '01', pCofins: 7.6,
}).lastInsertRowid;

// Específica: fertilizante (NCM 3105) com redução de base — o caso da JA.
const idFertilizante = insRegra.run({ ...REGRA_VAZIA,
  descricao: 'Fertilizante NCM 3105 — ICMS c/ reducao de base', prioridade: 10,
  regimeEmitente: 3, ncmPrefixo: '3105',
  cstIcms: '20', modBC: 3, pIcms: 12, pRedBC: 78.95,
  cstPis: '01', pPis: 1.65, cstCofins: '01', pCofins: 7.6,
  observacaoFiscal: 'ICMS com reducao de base — Conv. ICMS 100/97',
}).lastInsertRowid;

// ST: bebida, interestadual, MVA 40% / ST 18%.
insRegra.run({ ...REGRA_VAZIA,
  descricao: 'Bebida NCM 2202 — ST interestadual', prioridade: 20,
  regimeEmitente: 3, ncmPrefixo: '2202', ambito: 'interestadual',
  cstIcms: '10', modBC: 3, pIcms: 12, pMVAST: 40, pIcmsST: 18,
  cstIpi: '00', pIpi: 5,
  cstPis: '01', pPis: 1.65, cstCofins: '01', pCofins: 7.6,
});

const ctxBase = {
  ufOrigem: 'TO', ufDestino: 'TO', tipoContribuinte: 'contribuinte',
  consumidorFinal: 0, origemProduto: '0', vProd: 1.0, vFrete: 0, vDesc: 0, vOutro: 0,
};

// ─── 1. Regime normal: o caso real da JA Agrícola ────────────────────────────
secao('Regime normal — pré-nota 197 do Solution (fertilizante, redução de base)');
{
  const r = T.calcularItem(db, { ...ctxBase, crt: 3, cfop: '5910', ncm: '31051000' });
  assert(r.grupo === 'ICMS', 'usa grupo ICMS (não ICMSSN)');
  assert(r.icms.CST === '20', `CST 20 (veio ${r.icms.CST})`);
  assert(r.icms.vBC === '0.21', `base 0,21 — igual ao ERP (veio ${r.icms.vBC})`);
  assert(r.icms.pRedBC === '78.95', `redução 78,95 (veio ${r.icms.pRedBC})`);
  assert(r.icms.pICMS === '12.00', `alíquota 12,00 (veio ${r.icms.pICMS})`);
  assert(r.icms.vICMS === '0.03', `ICMS 0,03 — igual ao ERP (veio ${r.icms.vICMS})`);
  assert(r.regraId === idFertilizante, 'venceu a regra específica de NCM, não a genérica');
  assert(/BASECALCULO: BASECALCULO \* \(1 - \(REDUCAOBASE/.test(r.memoria[0].formula),
    'memória de cálculo registra a fórmula da redução');
  assert(r.pis.vPIS === '0.02' && r.cofins.vCOFINS === '0.08',
    `PIS 0,02 e COFINS 0,08 (vieram ${r.pis.vPIS} / ${r.cofins.vCOFINS})`);
  assert(r.observacaoFiscal === 'ICMS com reducao de base — Conv. ICMS 100/97', 'observação fiscal da regra chega ao item');
}

// ─── 2. Especificidade: NCM fora da regra cai na genérica ────────────────────
secao('Resolução por especificidade');
{
  const r = T.calcularItem(db, { ...ctxBase, crt: 3, cfop: '5102', ncm: '84713012', vProd: 100 });
  assert(r.regraId === idGenerica, 'NCM sem regra específica cai na genérica');
  assert(r.icms.CST === '00' && r.icms.vBC === '100.00' && r.icms.vICMS === '18.00',
    `CST 00, base 100,00, ICMS 18,00 (veio ${r.icms.CST}/${r.icms.vBC}/${r.icms.vICMS})`);
}

// ─── 3. ST + IPI ─────────────────────────────────────────────────────────────
secao('ICMS ST + IPI (bebida interestadual)');
{
  const r = T.calcularItem(db, { ...ctxBase, crt: 3, ufDestino: 'GO', cfop: '6404', ncm: '22021000', vProd: 100 });
  assert(r.icms.CST === '10', `CST 10 (veio ${r.icms.CST})`);
  assert(r.icms.vICMS === '12.00', `ICMS próprio 12,00 (veio ${r.icms.vICMS})`);
  // BC ST = 100 * 1,40 = 140,00 ; ST = 140 * 18% - 12 = 25,20 - 12 = 13,20
  assert(r.icms.vBCST === '140.00', `base ST 140,00 (veio ${r.icms.vBCST})`);
  assert(r.icms.vICMSST === '13.20', `ST 13,20 = (140 × 18%) − 12 (veio ${r.icms.vICMSST})`);
  assert(r.ipi && r.ipi.vIPI === '5.00', `IPI 5,00 (veio ${r.ipi && r.ipi.vIPI})`);
  assert(r.memoria.some(m => m.imposto === 'ICMSST'), 'memória tem linha de ST');
}

// ─── 4. Regressão do Simples: precisa sair EXATAMENTE como antes ─────────────
secao('Simples Nacional — regressão (comportamento anterior ao motor)');
{
  const r = T.calcularItem(db, { ...ctxBase, crt: 1, cfop: '5102', ncm: '31051000', csosnFallback: '400', vProd: 100 });
  assert(r.grupo === 'ICMSSN', 'usa grupo ICMSSN');
  assert(r.icms.CSOSN === '400', `CSOSN 400 (veio ${r.icms.CSOSN})`);
  assert(Object.keys(r.icms).length === 2, 'CSOSN 400 leva só orig+CSOSN, sem destaque');
  assert(r.pis.CST === '49' && r.pis.vPIS === '0.00', 'PIS CST 49 zerado');
  assert(r.cofins.CST === '49' && r.cofins.vCOFINS === '0.00', 'COFINS CST 49 zerado');
  assert(r.regraId === null, 'regra de regime normal NÃO vaza para o Simples');
}
{
  const r = T.calcularItem(db, { ...ctxBase, crt: 1, cfop: '5102', ncm: '31051000', csosnFallback: '101', vProd: 100 });
  assert(r.icms.CSOSN === '101' && r.icms.pCredSN === '0.00', 'CSOSN 101 mantém pCredSN 0,00 como antes');
}

// ─── 5. Simples com CSOSN 900 e destaque manual ──────────────────────────────
secao('Simples com CSOSN 900 (destaque permitido)');
{
  const r = T.calcularItem(db, { ...ctxBase, crt: 1, cfop: '5102', ncm: '31051000', vProd: 100,
    manual: { csosnIcms: '900', pIcms: 7, pRedBC: 0 } });
  assert(r.icms.CSOSN === '900' && r.icms.vICMS === '7.00', `CSOSN 900 com ICMS 7,00 (veio ${r.icms.vICMS})`);
  assert(r.origem === 'MANUAL', 'marcado como MANUAL');
}

// ─── 6. Override manual vence a regra ────────────────────────────────────────
secao('Override manual no item');
{
  const r = T.calcularItem(db, { ...ctxBase, crt: 3, cfop: '5910', ncm: '31051000', vProd: 100,
    manual: { pIcms: 4, pRedBC: 0 } });
  assert(r.icms.CST === '20', 'CST continua vindo da regra');
  assert(r.icms.vICMS === '4.00', `alíquota manual venceu: 4,00 (veio ${r.icms.vICMS})`);
  assert(r.origem === 'MANUAL', 'marcado como MANUAL');
}

// ─── 7. Regime normal sem regra: precisa FALHAR, não emitir errado ───────────
secao('Regime normal sem regra aplicável');
{
  let erro = null;
  try { T.calcularItem(db, { ...ctxBase, crt: 3, ufDestino: 'SP', cfop: '6102', ncm: '99999999', vProd: 100 }); }
  catch (e) { erro = e.message; }
  assert(erro && /Sem regra tribut/.test(erro), 'erro explícito em vez de imposto zerado silencioso');
  assert(erro && /NCM 99999999/.test(erro), 'mensagem diz qual contexto faltou');
}

// ─── 8. Frete e desconto entram na base ──────────────────────────────────────
secao('Composição da base (frete + outras − desconto)');
{
  const r = T.calcularItem(db, { ...ctxBase, crt: 3, cfop: '5102', ncm: '84713012',
    vProd: 100, vFrete: 20, vOutro: 5, vDesc: 25 });
  assert(r.icms.vBC === '100.00', `base 100 + 20 + 5 − 25 = 100,00 (veio ${r.icms.vBC})`);
}

// ─── 9. CRT lido do cadastro ─────────────────────────────────────────────────
secao('CRT a partir de fornecedor.regimeTributario');
{
  const tem = db.prepare('SELECT COUNT(*) c FROM fornecedor WHERE id = 1').get().c;
  if (!tem) db.prepare("INSERT INTO fornecedor (id, razaoSocial) VALUES (1, 'Lab Fiscal')").run();
  db.prepare("UPDATE fornecedor SET regimeTributario = 'NAO_OPTANTE' WHERE id = 1").run();
  assert(T.crtDoEmitente(db) === 3, 'NAO_OPTANTE → CRT 3');
  db.prepare("UPDATE fornecedor SET regimeTributario = 'SIMPLES_NACIONAL' WHERE id = 1").run();
  assert(T.crtDoEmitente(db) === 1, 'SIMPLES_NACIONAL → CRT 1');
  db.prepare("UPDATE fornecedor SET regimeTributario = 'MEI' WHERE id = 1").run();
  assert(T.crtDoEmitente(db) === 4, 'MEI → CRT 4');
  db.prepare("UPDATE fornecedor SET regimeTributario = NULL WHERE id = 1").run();
  assert(T.crtDoEmitente(db) === 1, 'sem regime gravado → CRT 1 (comportamento legado)');
}

// ─── 10. Memória de cálculo persistida ───────────────────────────────────────
secao('Memória de cálculo (aba Auditoria)');
{
  const r = T.calcularItem(db, { ...ctxBase, crt: 3, cfop: '5910', ncm: '31051000' });
  T.gravarMemoria(db, { documentoId: 999, itemId: 1, resultado: r });
  const linhas = db.prepare('SELECT * FROM fiscal_calculo_memoria WHERE documentoId = 999 ORDER BY id').all();
  assert(linhas.length === r.memoria.length, `${linhas.length} linhas gravadas`);
  const icms = linhas.find(l => l.imposto === 'ICMS');
  assert(icms && icms.base === 0.21 && icms.valor === 0.03, 'linha de ICMS com base e valor corretos');
  assert(icms && icms.regraId === idFertilizante, 'guarda qual regra decidiu');
  assert(icms && icms.origem === 'CALCULADO', 'origem CALCULADO');
  // Recalcular substitui, não acumula
  T.gravarMemoria(db, { documentoId: 999, itemId: 1, resultado: r });
  const n2 = db.prepare('SELECT COUNT(*) c FROM fiscal_calculo_memoria WHERE documentoId = 999').get().c;
  assert(n2 === linhas.length, 'recalcular substitui a memória anterior');
  db.prepare('DELETE FROM fiscal_calculo_memoria WHERE documentoId = 999').run();
}

console.log(`\n${'─'.repeat(56)}`);
console.log(fail === 0 ? `TODOS OS ${ok} ASSERTS PASSARAM` : `${ok} OK · ${fail} FALHARAM`);
process.exit(fail === 0 ? 0 : 1);
