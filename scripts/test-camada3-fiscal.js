#!/usr/bin/env node
/**
 * test-camada3-fiscal.js — vigência, cBenef, CEST e DIFAL.
 *
 * Os quatro refinos da Camada 3, cada um com a pergunta que importa:
 *   vigência — a regra vale na data do DOCUMENTO, não na de hoje?
 *   cBenef   — sai no grupo <prod>, na posição que o XSD exige?
 *   CEST     — idem, e só quando tem 7 dígitos?
 *   DIFAL    — calcula certo, e RECUSA calcular quando a alíquota da UF de
 *              destino não está cadastrada, em vez de inventar um número?
 *
 * Roda contra o tenant `labfiscal`.
 *
 * Uso: node scripts/test-camada3-fiscal.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const T = require(BASE + '/fiscal-tributacao');
const { validarXmlLocal, corrigirCstIpiZero } = require(BASE + '/nfe-emit-routes');

const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

function validarIgnorandoAssinatura(xml) {
  const err = validarXmlLocal(xml);
  if (!err) return null;
  const linhas = String(err).split('\n')
    .filter(l => l.trim() && !/Signature/.test(l) && !/fails to validate/.test(l));
  return linhas.length ? linhas.join('\n') : null;
}

const REGRA_VAZIA = {
  descricao: '', prioridade: 10, ativo: 1, regimeEmitente: null, tipoOperacaoId: null,
  cfop: null, ncmPrefixo: null, produtoId: null, ufOrigem: null, ufDestino: null,
  ambito: null, tipoContribuinte: null, consumidorFinal: null,
  cstIcms: null, csosnIcms: null, modBC: null, pIcms: null, pRedBC: null, pFCP: null,
  pDif: null, motDesIcms: null, modBCST: null, pMVAST: null, pRedBCST: null,
  pIcmsST: null, pFCPST: null, cstIpi: null, pIpi: null,
  cstPis: null, pPis: null, cstCofins: null, pCofins: null,
  observacaoFiscal: null, vigenciaInicio: null, vigenciaFim: null,
  codBenef: null, pFcpUFDest: null,
};
const COLS = Object.keys(REGRA_VAZIA);
const insRegra = db.prepare(
  `INSERT INTO fiscal_regras_trib (${COLS.join(', ')}) VALUES (${COLS.map(c => '@' + c).join(', ')})`);

function limpar() {
  db.prepare('DELETE FROM fiscal_regras_trib').run();
  db.prepare('UPDATE fiscal_aliquotas_uf SET aliquotaInterna = NULL, pFcp = NULL').run();
}

const ctxBase = {
  ufOrigem: 'TO', ufDestino: 'TO', origemProduto: '0',
  vProd: 100, vFrete: 0, vDesc: 0, vOutro: 0,
};

// ─── 1. Vigência ────────────────────────────────────────────────────────────
secao('Vigência — a regra vale na data do documento');
limpar();
{
  const idAntiga = insRegra.run({ ...REGRA_VAZIA,
    descricao: 'ICMS 17% ate 2025', regimeEmitente: 3, ncmPrefixo: '3105',
    cstIcms: '00', modBC: 3, pIcms: 17,
    vigenciaInicio: '2020-01-01', vigenciaFim: '2025-12-31',
  }).lastInsertRowid;
  const idNova = insRegra.run({ ...REGRA_VAZIA,
    descricao: 'ICMS 20% a partir de 2026', regimeEmitente: 3, ncmPrefixo: '3105',
    cstIcms: '00', modBC: 3, pIcms: 20,
    vigenciaInicio: '2026-01-01',
  }).lastInsertRowid;

  const emJulho2025 = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '31051000', dataReferencia: '2025-07-15' });
  assert(emJulho2025.regraId === idAntiga, 'nota de 2025 usa a regra vigente em 2025');
  assert(emJulho2025.icms.vICMS === '17.00', `ICMS 17,00 (veio ${emJulho2025.icms.vICMS})`);

  const hoje = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '31051000', dataReferencia: '2026-08-25' });
  assert(hoje.regraId === idNova, 'nota de hoje usa a regra vigente agora');
  assert(hoje.icms.vICMS === '20.00', `ICMS 20,00 (veio ${hoje.icms.vICMS})`);

  const antesDeTudo = T.resolverRegra(db, { crt: 3, ncm: '31051000', dataReferencia: '2019-05-01' });
  assert(antesDeTudo === null, 'antes de qualquer vigência, nenhuma regra se aplica');

  // Sem data no contexto, vale hoje — comportamento de quem não passa a data.
  const semData = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '31051000' });
  assert(semData.regraId === idNova, 'sem data informada, resolve pela data de hoje');
}

secao('Vigência — regra perene continua valendo (sem regressão)');
{
  limpar();
  const idPerene = insRegra.run({ ...REGRA_VAZIA,
    descricao: 'Sempre valida', regimeEmitente: 3, ncmPrefixo: '3105',
    cstIcms: '00', modBC: 3, pIcms: 12,
  }).lastInsertRowid;
  for (const data of ['2019-01-01', '2026-08-25', '2030-12-31']) {
    const r = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '31051000', dataReferencia: data });
    assert(r.regraId === idPerene, `vale em ${data}`);
  }
}

secao('Vigência — desempate: a datada vence a perene');
{
  limpar();
  insRegra.run({ ...REGRA_VAZIA,
    descricao: 'Perene 12%', regimeEmitente: 3, ncmPrefixo: '3105',
    cstIcms: '00', modBC: 3, pIcms: 12 });
  const idDatada = insRegra.run({ ...REGRA_VAZIA,
    descricao: 'Vigente desde 2026 — 20%', regimeEmitente: 3, ncmPrefixo: '3105',
    cstIcms: '00', modBC: 3, pIcms: 20, vigenciaInicio: '2026-01-01' }).lastInsertRowid;

  const r = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '31051000', dataReferencia: '2026-08-25' });
  assert(r.regraId === idDatada, 'com mesma especificidade, a regra com vigência declarada vence');
  assert(r.icms.vICMS === '20.00', `usa a alíquota da datada (${r.icms.vICMS})`);
}

secao('Vigência — a emissão resolve pela data de HOJE, não pela do documento');
{
  // Não existe emissão retroativa: o dhEmi do XML é sempre o instante da
  // transmissão. Um rascunho criado antes da virada e emitido depois precisa
  // usar a alíquota NOVA — usar a data gravada no rascunho produziria uma nota
  // cujo imposto não corresponde à própria data que ela declara.
  limpar();
  const hoje = T.hojeBrasilia();
  const ontem = new Date(Date.parse(hoje + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);

  insRegra.run({ ...REGRA_VAZIA,
    descricao: 'Antiga — encerrada ontem', regimeEmitente: 3, ncmPrefixo: '3105',
    cstIcms: '00', modBC: 3, pIcms: 12, vigenciaFim: ontem });
  const idAtual = insRegra.run({ ...REGRA_VAZIA,
    descricao: 'Nova — em vigor desde hoje', regimeEmitente: 3, ncmPrefixo: '3105',
    cstIcms: '00', modBC: 3, pIcms: 20, vigenciaInicio: hoje }).lastInsertRowid;

  // É assim que a emissão chama: sempre com a data de hoje.
  const naEmissao = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '31051000',
    dataReferencia: T.hojeBrasilia() });
  assert(naEmissao.regraId === idAtual, 'rascunho antigo emitido hoje usa a regra de hoje');
  assert(naEmissao.icms.vICMS === '20.00', `alíquota nova (veio ${naEmissao.icms.vICMS})`);

  // A regra encerrada continua consultável — é para isso que o simulador serve.
  const consulta = T.resolverRegra(db, { crt: 3, ncm: '31051000', dataReferencia: ontem });
  assert(consulta && consulta.pIcms === 12, 'o simulador ainda consegue consultar a alíquota de ontem');
}

secao('Vigência — agendar a virada sem editar na data');
{
  limpar();
  const hoje = T.hojeBrasilia();
  const amanha = new Date(Date.parse(hoje + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);

  const idHoje = insRegra.run({ ...REGRA_VAZIA,
    descricao: 'Vale ate hoje', regimeEmitente: 3, ncmPrefixo: '3105',
    cstIcms: '00', modBC: 3, pIcms: 12, vigenciaFim: hoje }).lastInsertRowid;
  const idFutura = insRegra.run({ ...REGRA_VAZIA,
    descricao: 'Entra amanha', regimeEmitente: 3, ncmPrefixo: '3105',
    cstIcms: '00', modBC: 3, pIcms: 20, vigenciaInicio: amanha }).lastInsertRowid;

  const agora = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '31051000', dataReferencia: hoje });
  assert(agora.regraId === idHoje, 'a regra agendada NÃO se aplica antes da data');
  assert(agora.icms.vICMS === '12.00', `hoje ainda é 12% (veio ${agora.icms.vICMS})`);

  const depois = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '31051000', dataReferencia: amanha });
  assert(depois.regraId === idFutura, 'amanhã ela entra sozinha, sem ninguém editar nada');
  assert(depois.icms.vICMS === '20.00', `amanhã vira 20% (veio ${depois.icms.vICMS})`);
}

// ─── 2. Benefício fiscal (cBenef) ───────────────────────────────────────────
secao('cBenef — código de benefício fiscal');
{
  limpar();
  insRegra.run({ ...REGRA_VAZIA,
    descricao: 'Fertilizante c/ reducao e beneficio', regimeEmitente: 3, ncmPrefixo: '3105',
    cstIcms: '20', modBC: 3, pIcms: 12, pRedBC: 78.95,
    codBenef: 'TO800001', observacaoFiscal: 'Conv. ICMS 100/97',
  });
  const r = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '31051000', vProd: 1 });
  assert(r.codBenef === 'TO800001', `motor devolve o cBenef (${r.codBenef})`);

  const manual = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '31051000', vProd: 1,
    manual: { codBenef: 'TO999999' } });
  assert(manual.codBenef === 'TO999999', 'override manual do cBenef vence a regra');

  // Regra genérica sem benefício, para o item que não casa com a de fertilizante.
  insRegra.run({ ...REGRA_VAZIA,
    descricao: 'Generica sem beneficio', regimeEmitente: 3,
    cstIcms: '00', modBC: 3, pIcms: 18 });
  const semBenef = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '84713012', vProd: 1 });
  assert(semBenef.codBenef === undefined, 'item cuja regra não tem benefício não recebe cBenef');
}

// ─── 3. DIFAL ───────────────────────────────────────────────────────────────
secao('DIFAL — recusa calcular sem alíquota cadastrada');
{
  limpar();
  insRegra.run({ ...REGRA_VAZIA,
    descricao: 'Venda interestadual', regimeEmitente: 3,
    cstIcms: '00', modBC: 3, pIcms: 7 });

  const r = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '84713012', ufDestino: 'GO',
    tipoContribuinte: 'nao_contribuinte', consumidorFinal: 1 });
  assert(!!r.difalErro, 'não calcula DIFAL sem a alíquota interna do destino');
  assert(/GO/.test(r.difalErro || ''), `a mensagem diz qual UF falta ("${r.difalErro}")`);
  assert(!r.icmsUFDest, 'nenhum grupo ICMSUFDest é montado');
  assert(r.memoria.some(m => m.imposto === 'DIFAL'), 'a memória registra que o DIFAL não foi calculado');
}

secao('DIFAL — cálculo com alíquota cadastrada');
{
  db.prepare("UPDATE fiscal_aliquotas_uf SET aliquotaInterna = 19 WHERE uf = 'GO'").run();
  const r = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '84713012', ufDestino: 'GO',
    tipoContribuinte: 'nao_contribuinte', consumidorFinal: 1, vProd: 1000 });
  assert(!r.difalErro, 'calcula sem erro', r.difalErro);
  const u = r.icmsUFDest || {};
  // 1000 × (19% − 7%) = 120,00
  assert(u.vICMSUFDest === '120.00', `DIFAL 120,00 = 1000 × (19% − 7%) (veio ${u.vICMSUFDest})`);
  assert(u.pICMSInterPart === '100.00', '100% ao destino (regra vigente desde 2019)');
  assert(u.vICMSUFRemet === '0.00', 'nada fica com a UF de origem');
  assert(u.pICMSUFDest === '19.00' && u.pICMSInter === '7.00', 'alíquotas registradas nas tags');
  assert(r.totais.vICMSUFDest === 120, 'o total acompanha');
  assert(/PARTILHA: 100%/.test(r.memoria.find(m => m.imposto === 'DIFAL').formula), 'memória explica a partilha');
}

secao('DIFAL — com FCP do destino');
{
  db.prepare("UPDATE fiscal_aliquotas_uf SET aliquotaInterna = 20, pFcp = 2 WHERE uf = 'RJ'").run();
  const r = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '84713012', ufDestino: 'RJ',
    tipoContribuinte: 'nao_contribuinte', consumidorFinal: 1, vProd: 1000 });
  const u = r.icmsUFDest || {};
  assert(u.vICMSUFDest === '130.00', `DIFAL 130,00 = 1000 × (20% − 7%) (veio ${u.vICMSUFDest})`);
  assert(u.vFCPUFDest === '20.00', `FCP 20,00 = 1000 × 2% (veio ${u.vFCPUFDest})`);
  assert(u.vBCFCPUFDest === '1000.00', 'base do FCP presente');
  assert(r.totais.vFCPUFDest === 20, 'total de FCP acompanha');
}

secao('DIFAL — quando NÃO se aplica');
{
  db.prepare("UPDATE fiscal_aliquotas_uf SET aliquotaInterna = 19 WHERE uf = 'GO'").run();
  const contribuinte = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '84713012', ufDestino: 'GO',
    tipoContribuinte: 'contribuinte', consumidorFinal: 0, vProd: 1000 });
  assert(!contribuinte.icmsUFDest && !contribuinte.difalErro, 'venda a contribuinte não gera DIFAL');

  const interna = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '84713012', ufDestino: 'TO',
    tipoContribuinte: 'nao_contribuinte', consumidorFinal: 1, vProd: 1000 });
  assert(!interna.icmsUFDest && !interna.difalErro, 'venda dentro do estado não gera DIFAL');

  const simples = T.calcularItem(db, { ...ctxBase, crt: 1, ncm: '84713012', ufDestino: 'GO',
    tipoContribuinte: 'nao_contribuinte', consumidorFinal: 1, vProd: 1000, csosnFallback: '102' });
  assert(!simples.icmsUFDest && !simples.difalErro,
    'Simples Nacional não recolhe DIFAL (ADI 5464 / LC 190)');

  // Alíquota do destino menor ou igual à interestadual: não há diferença
  db.prepare("UPDATE fiscal_aliquotas_uf SET aliquotaInterna = 7 WHERE uf = 'MG'").run();
  const semDiferenca = T.calcularItem(db, { ...ctxBase, crt: 3, ncm: '84713012', ufDestino: 'MG',
    tipoContribuinte: 'nao_contribuinte', consumidorFinal: 1, vProd: 1000 });
  assert(!semDiferenca.icmsUFDest && !semDiferenca.difalErro,
    'alíquota interna igual à interestadual: sem DIFAL, e sem erro');
}

// ─── 4. O XML: tudo junto passa no XSD ──────────────────────────────────────
secao('XSD — CEST, cBenef e ICMSUFDest no XML');
(async () => {
  const { Make } = await import(BASE + '/node_modules/node-sped-nfe/dist/index.js');

  limpar();
  db.prepare("UPDATE fiscal_aliquotas_uf SET aliquotaInterna = 19 WHERE uf = 'GO'").run();
  insRegra.run({ ...REGRA_VAZIA,
    descricao: 'Bebida ST + beneficio', regimeEmitente: 3, ncmPrefixo: '2202',
    cstIcms: '00', modBC: 3, pIcms: 7, codBenef: 'TO800001',
    cstPis: '01', pPis: 1.65, cstCofins: '01', pCofins: 7.6 });

  const trib = T.calcularItem(db, {
    crt: 3, ncm: '22021000', ufOrigem: 'TO', ufDestino: 'GO', ambito: 'interestadual',
    tipoContribuinte: 'nao_contribuinte', consumidorFinal: 1, origemProduto: '0',
    vProd: 1000, vFrete: 0, vDesc: 0, vOutro: 0, dataReferencia: '2026-08-25',
  });
  assert(trib.codBenef === 'TO800001', 'cBenef resolvido');
  assert(!!trib.icmsUFDest, 'DIFAL resolvido');

  const NFe = new Make();
  NFe.tagInfNFe({ Id: null, versao: '4.00' });
  NFe.tagIde({ cUF: '17', cNF: '12345678', natOp: 'VENDA', mod: '55', serie: '1', nNF: '1',
    dhEmi: NFe.formatData(), tpNF: '1', idDest: '2', cMunFG: '1721000', tpImp: '1', tpEmis: '1',
    cDV: '0', tpAmb: '2', finNFe: '1', indFinal: '1', indPres: '1', indIntermed: '0',
    procEmi: '0', verProc: 'LiciteAgora1.0' });
  NFe.tagEmit({ CNPJ: '11222333000181', xNome: 'LAB FISCAL LTDA', xFant: 'LAB',
    IE: '123456789', CRT: '3' });
  NFe.tagEnderEmit({ xLgr: 'RUA TESTE', nro: '100', xBairro: 'CENTRO', cMun: '1721000',
    xMun: 'PALMAS', UF: 'TO', CEP: '77000000', cPais: '1058', xPais: 'BRASIL' });
  NFe.tagDest({ CPF: '11144477735', xNome: 'CONSUMIDOR FINAL', indIEDest: '9' });
  NFe.tagEnderDest({ xLgr: 'AV GOIAS', nro: '200', xBairro: 'CENTRO', cMun: '5208707',
    xMun: 'GOIANIA', UF: 'GO', CEP: '74000000', cPais: '1058', xPais: 'BRASIL' });

  // Ordem das chaves = ordem do XSD: NCM, CEST, cBenef, CFOP…
  NFe.tagProd([{
    cProd: 'BEB-01', cEAN: 'SEM GTIN', xProd: 'REFRIGERANTE 2L', NCM: '22021000',
    CEST: '0300700', cBenef: trib.codBenef, CFOP: '6108',
    uCom: 'UN', qCom: '1.0000', vUnCom: '1000.0000', vProd: '1000.00',
    cEANTrib: 'SEM GTIN', uTrib: 'UN', qTrib: '1.0000', vUnTrib: '1000.0000', indTot: '1',
  }]);
  NFe.tagProdICMS(0, trib.icms);
  NFe.tagProdPIS(0, trib.pis);
  NFe.tagProdCOFINS(0, trib.cofins);
  NFe.tagProdICMSUFDest(0, trib.icmsUFDest);
  NFe.tagTotal({ ICMSTot: {
    vBC: trib.totais.vBC.toFixed(2), vICMS: trib.totais.vICMS.toFixed(2),
    vBCST: '0.00', vST: '0.00', vProd: '1000.00', vFrete: '0.00', vDesc: '0.00',
    vIPI: '0.00', vPIS: trib.totais.vPIS.toFixed(2), vCOFINS: trib.totais.vCOFINS.toFixed(2),
    vFCPUFDest: trib.totais.vFCPUFDest.toFixed(2),
    vICMSUFDest: trib.totais.vICMSUFDest.toFixed(2),
    vICMSUFRemet: trib.totais.vICMSUFRemet.toFixed(2),
    vNF: '1000.00',
  }});
  NFe.tagTransp({ modFrete: 9 });
  NFe.tagDetPag([{ indPag: 0, tPag: '90', vPag: '1000.00' }]);

  const xml = corrigirCstIpiZero(NFe.xml());
  const erro = validarIgnorandoAssinatura(xml);
  assert(erro === null, 'XML com CEST + cBenef + ICMSUFDest passa no nfe_v4.00.xsd',
    erro ? String(erro).split('\n').slice(0, 4).join('\n      ') : '');
  assert(/<CEST>0300700<\/CEST>/.test(xml), 'CEST no XML');
  assert(/<cBenef>TO800001<\/cBenef>/.test(xml), 'cBenef no XML');
  assert(/<ICMSUFDest>/.test(xml), 'grupo ICMSUFDest no XML');
  assert(/<vICMSUFDest>120\.00<\/vICMSUFDest>/.test(xml), 'DIFAL 120,00 no XML');
  assert(/<pICMSInterPart>100\.00<\/pICMSInterPart>/.test(xml), 'partilha 100% no XML');
  // A ordem importa: cBenef vem depois de CEST e antes de CFOP
  assert(/<CEST>[^<]*<\/CEST><cBenef>[^<]*<\/cBenef><CFOP>/.test(xml.replace(/\s+/g, '')),
    'ordem CEST → cBenef → CFOP respeitada');

  limpar();
  db.close();
  console.log(`\n${'─'.repeat(56)}`);
  console.log(fail === 0 ? `TODOS OS ${ok} ASSERTS PASSARAM` : `${ok} OK · ${fail} FALHARAM`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('ERRO FATAL:', err);
  process.exit(1);
});
