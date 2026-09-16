#!/usr/bin/env node
/**
 * test-farmacia-f3.js — Fase 3: grupos <med> e <rastro> na NFC-e/NF-e.
 *
 * O que este teste prova, sem depender de certificado nem da SEFAZ:
 *   1. o XML sai com os dois grupos, no lugar e na ordem do schema 4.00;
 *   2. só o item de medicamento recebe os grupos — o resto da nota fica intacto,
 *      byte a byte;
 *   3. a nota é BARRADA localmente quando falta registro ANVISA, PMC ou lote,
 *      que é o conjunto exato das causas da rejeição 840;
 *   4. o XML resultante continua sendo XML válido e assinável.
 *
 * O XML de entrada é gerado pela MESMA lib da produção (node-sped-nfe), com a
 * mesma sequência de chamadas do nfce-routes — não é um XML de mentira.
 *
 * Roda contra `labfiscal`, cria a própria massa e limpa no fim.
 * Uso: node scripts/test-farmacia-f3.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const { XMLParser, XMLValidator } = require(BASE + '/node_modules/fast-xml-parser');

const { initFarmaciaSchema } = require(BASE + '/farmacia/farmacia-schema');
const { resolverLotesDaVenda, hojeBrasilia } = require(BASE + '/farmacia/fefo');
const {
  ehNcmMedicamento, montarDadosMedicamento, injetarMedRastro,
} = require(BASE + '/farmacia/nfe-med-rastro');

const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

initFarmaciaSchema(db);

const hoje = hojeBrasilia();
const dia = (n) => new Date(Date.parse(hoje + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const PREFIXO = 'TESTE-FARM-F3-';
function limpar() {
  const ids = db.prepare('SELECT id FROM produtos WHERE sku LIKE ?').all(PREFIXO + '%').map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM lotes WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM farmacia_medicamento_specs WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
  }
}
limpar();

// ─── Classificação por NCM ───────────────────────────────────────────────────
secao('Quem é medicamento para a NT 2021.004');
assert(ehNcmMedicamento('30049099'), 'NCM 3004 é medicamento');
assert(ehNcmMedicamento('3003.90.99'), 'NCM 3003 com pontuação é medicamento');
assert(ehNcmMedicamento('30012010'), 'NCM 3001 é medicamento');
assert(ehNcmMedicamento('30066000'), 'NCM 3006 é medicamento');
assert(!ehNcmMedicamento('96081000'), 'caneta (9608) não é medicamento');
assert(!ehNcmMedicamento('30079999'), 'NCM 3007 não existe na faixa — não é medicamento');
assert(!ehNcmMedicamento(''), 'NCM vazio não é medicamento');

// ─── Massa ───────────────────────────────────────────────────────────────────
const idMed = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, ativo, rastreiaLote)
  VALUES (?, 'DIPIRONA 500MG C/10', 'UN', 12.5, '30049099', 1, 1)`).run(PREFIXO + 'MED').lastInsertRowid;
db.prepare(`INSERT INTO farmacia_medicamento_specs
  (produtoId, registroAnvisa, ean, substancia, tarja, listaCmed, regimePreco, pf, pmc)
  VALUES (?, '1023505440029', '7896004703497', 'DIPIRONA SODICA', 'livre', 'positiva', 'regulado', 9.10, 15.90)`).run(idMed);
const loteMed = db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, ativo)
  VALUES (?, 'L2026A', ?, ?, 100, 100, 1)`).run(idMed, dia(-60), dia(300)).lastInsertRowid;

const idCaneta = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, ativo, rastreiaLote)
  VALUES (?, 'CANETA AZUL', 'UN', 3, '96081000', 1, 0)`).run(PREFIXO + 'CAN').lastInsertRowid;

const itens = [
  { produtoId: idMed, sku: PREFIXO + 'MED', descricao: 'DIPIRONA 500MG C/10', ncm: '30049099', unidade: 'UN', quantidade: 2, precoUnitario: 12.5, valorTotal: 25 },
  { produtoId: idCaneta, sku: PREFIXO + 'CAN', descricao: 'CANETA AZUL', ncm: '96081000', unidade: 'UN', quantidade: 1, precoUnitario: 3, valorTotal: 3 },
];

// ─── Dados dos grupos ────────────────────────────────────────────────────────
secao('Montagem dos grupos');

const lotesDaVenda = resolverLotesDaVenda(db, itens);
const dados = montarDadosMedicamento(db, itens, lotesDaVenda);
assert(dados.length === 1, 'só o item de medicamento gera grupos', `n=${dados.length}`);
assert(dados[0].indice === 0, 'o grupo aponta para o índice certo do item');
assert(dados[0].med.cProdANVISA === '1023505440029', 'cProdANVISA vem do registro ANVISA da spec');
assert(dados[0].med.vPMC === '15.90', 'vPMC vem do PMC da CMED, com 2 casas', dados[0].med.vPMC);
assert(dados[0].rastro.length === 1 && dados[0].rastro[0].nLote === 'L2026A', 'rastro traz o lote que saiu');
assert(dados[0].rastro[0].qLote === '2.000', 'qLote é a quantidade daquele lote, com 3 casas', dados[0].rastro[0].qLote);
assert(dados[0].rastro[0].dVal === dia(300) && dados[0].rastro[0].dFab === dia(-60),
  'dFab e dVal saem do lote em AAAA-MM-DD');

// ─── As três faltas que geram rejeição 840 ───────────────────────────────────
secao('Bloqueio local das causas da rejeição 840');

function esperarErro(fn, regex, msg) {
  let e = null;
  try { fn(); } catch (err) { e = err.message; }
  assert(e && regex.test(e), msg, String(e));
}

// (a) medicamento sem cadastro farmacêutico nenhum
const idSemSpec = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, ativo, rastreiaLote)
  VALUES (?, 'GENERICO SEM CADASTRO', 'UN', 8, '30049099', 1, 1)`).run(PREFIXO + 'NOSPEC').lastInsertRowid;
db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, ativo)
  VALUES (?, 'LX', ?, ?, 5, 5, 1)`).run(idSemSpec, dia(-10), dia(200));
const itensSemSpec = [{ produtoId: idSemSpec, descricao: 'GENERICO SEM CADASTRO', ncm: '30049099', quantidade: 1, precoUnitario: 8 }];
esperarErro(() => montarDadosMedicamento(db, itensSemSpec, resolverLotesDaVenda(db, itensSemSpec)),
  /sem cadastro farmacêutico/, 'medicamento sem cadastro farmacêutico é barrado');

// (b) sem registro e sem isenção
const idSemReg = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, ativo, rastreiaLote)
  VALUES (?, 'SEM REGISTRO', 'UN', 8, '30049099', 1, 1)`).run(PREFIXO + 'NOREG').lastInsertRowid;
db.prepare('INSERT INTO farmacia_medicamento_specs (produtoId, pmc) VALUES (?, 10)').run(idSemReg);
db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, ativo)
  VALUES (?, 'LY', ?, ?, 5, 5, 1)`).run(idSemReg, dia(-10), dia(200));
const itensSemReg = [{ produtoId: idSemReg, descricao: 'SEM REGISTRO', ncm: '30049099', quantidade: 1, precoUnitario: 8 }];
esperarErro(() => montarDadosMedicamento(db, itensSemReg, resolverLotesDaVenda(db, itensSemReg)),
  /sem registro ANVISA/, 'medicamento sem registro e sem isenção é barrado');

// (b2) isento COM motivo passa e emite ISENTO
db.prepare("UPDATE farmacia_medicamento_specs SET isentoRegistro = 1, motivoIsencao = 'DECISAO 42/2026' WHERE produtoId = ?").run(idSemReg);
const dadosIsento = montarDadosMedicamento(db, itensSemReg, resolverLotesDaVenda(db, itensSemReg));
assert(dadosIsento[0].med.cProdANVISA === 'ISENTO' && dadosIsento[0].med.xMotivoIsencao === 'DECISAO 42/2026',
  'isento com motivo emite cProdANVISA=ISENTO + xMotivoIsencao');

// (b3) isento SEM motivo é barrado
db.prepare("UPDATE farmacia_medicamento_specs SET motivoIsencao = '' WHERE produtoId = ?").run(idSemReg);
esperarErro(() => montarDadosMedicamento(db, itensSemReg, resolverLotesDaVenda(db, itensSemReg)),
  /motivo da isenção/, 'isento sem motivo é barrado (a NT exige o motivo)');

// (c) sem PMC
const idSemPmc = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, ativo, rastreiaLote)
  VALUES (?, 'SEM PMC', 'UN', 8, '30049099', 1, 1)`).run(PREFIXO + 'NOPMC').lastInsertRowid;
db.prepare("INSERT INTO farmacia_medicamento_specs (produtoId, registroAnvisa) VALUES (?, '1234567890123')").run(idSemPmc);
db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, ativo)
  VALUES (?, 'LZ', ?, ?, 5, 5, 1)`).run(idSemPmc, dia(-10), dia(200));
const itensSemPmc = [{ produtoId: idSemPmc, descricao: 'SEM PMC', ncm: '30049099', quantidade: 1, precoUnitario: 8 }];
esperarErro(() => montarDadosMedicamento(db, itensSemPmc, resolverLotesDaVenda(db, itensSemPmc)),
  /sem PMC/, 'medicamento sem PMC é barrado');

// (d) sem lote
const idSemLote = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, ativo, rastreiaLote)
  VALUES (?, 'SEM LOTE', 'UN', 8, '30049099', 1, 0)`).run(PREFIXO + 'NOLOTE').lastInsertRowid;
db.prepare("INSERT INTO farmacia_medicamento_specs (produtoId, registroAnvisa, pmc) VALUES (?, '1234567890123', 10)").run(idSemLote);
const itensSemLote = [{ produtoId: idSemLote, descricao: 'SEM LOTE', ncm: '30049099', quantidade: 1, precoUnitario: 8 }];
esperarErro(() => montarDadosMedicamento(db, itensSemLote, resolverLotesDaVenda(db, itensSemLote)),
  /sem lote/, 'medicamento sem lote é barrado (rastro é obrigatório)');

// (e) lote com data podre
const idDataRuim = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, ativo, rastreiaLote)
  VALUES (?, 'DATA RUIM', 'UN', 8, '30049099', 1, 1)`).run(PREFIXO + 'DTRUIM').lastInsertRowid;
db.prepare("INSERT INTO farmacia_medicamento_specs (produtoId, registroAnvisa, pmc) VALUES (?, '1234567890123', 10)").run(idDataRuim);
db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, ativo)
  VALUES (?, 'LW', '10/05/2026', ?, 5, 5, 1)`).run(idDataRuim, dia(200));
const itensDataRuim = [{ produtoId: idDataRuim, descricao: 'DATA RUIM', ncm: '30049099', quantidade: 1, precoUnitario: 8 }];
esperarErro(() => montarDadosMedicamento(db, itensDataRuim, resolverLotesDaVenda(db, itensDataRuim)),
  /AAAA-MM-DD/, 'data de lote em formato brasileiro é recusada antes da SEFAZ');

// ─── Injeção no XML gerado pela lib de produção ──────────────────────────────
secao('Injeção no XML real da node-sped-nfe');

(async () => {
  const { Make } = await import(BASE + '/node_modules/node-sped-nfe/dist/index.js');
  const N = new Make();
  N.tagInfNFe({ versao: '4.00' });
  N.tagIde({ cUF: 15, cNF: '12345678', natOp: 'VENDA', mod: '65', serie: 1, nNF: 1,
    dhEmi: '2026-08-26T10:00:00-03:00', tpNF: 1, idDest: 1, cMunFG: '1501402', tpImp: 4,
    tpEmis: 1, cDV: 0, tpAmb: 2, finNFe: 1, indFinal: 1, indPres: 1, procEmi: 0, verProc: '1' });
  N.tagEmit({ CNPJ: '11222333000181', xNome: 'FARMACIA TESTE', xFant: 'FARMACIA TESTE', IE: '123456', CRT: '1' });
  N.tagEnderEmit({ xLgr: 'RUA', nro: '1', xBairro: 'CENTRO', cMun: '1501402', xMun: 'BELEM',
    UF: 'PA', CEP: '66000000', cPais: '1058', xPais: 'BRASIL' });
  N.tagProd(itens.map(it => ({
    cProd: it.sku, cEAN: 'SEM GTIN', xProd: it.descricao, NCM: it.ncm, CFOP: '5102',
    uCom: it.unidade, qCom: Number(it.quantidade).toFixed(4), vUnCom: Number(it.precoUnitario).toFixed(4),
    vProd: Number(it.valorTotal).toFixed(2), cEANTrib: 'SEM GTIN', uTrib: it.unidade,
    qTrib: Number(it.quantidade).toFixed(4), vUnTrib: Number(it.precoUnitario).toFixed(4), indTot: '1',
  })));
  itens.forEach((_, i) => {
    N.tagProdICMSSN(i, { orig: '0', CSOSN: '102' });
    N.tagProdPIS(i, { CST: '49', vBC: '0.00', pPIS: '0.00', vPIS: '0.00' });
    N.tagProdCOFINS(i, { CST: '49', vBC: '0.00', pCOFINS: '0.00', vCOFINS: '0.00' });
  });
  N.tagTotal({ ICMSTot: { vNF: '28.00' } });
  N.tagTransp({ modFrete: 9 });
  N.tagDetPag([{ indPag: 0, tPag: '01', vPag: '28.00' }]);

  const xmlOriginal = N.xml();
  const xmlNovo = injetarMedRastro(xmlOriginal, dados);

  assert(xmlNovo !== xmlOriginal, 'XML foi alterado');
  assert(XMLValidator.validate(xmlNovo) === true, 'XML resultante continua válido (assinável)',
    JSON.stringify(XMLValidator.validate(xmlNovo)));

  const det1 = xmlNovo.slice(xmlNovo.indexOf('<det nItem="1"'), xmlNovo.indexOf('</det>') + 6);
  assert(/<rastro><nLote>L2026A<\/nLote><qLote>2\.000<\/qLote>/.test(det1),
    'item 1 recebeu <rastro> com lote e quantidade');
  assert(/<med><cProdANVISA>1023505440029<\/cProdANVISA><vPMC>15\.90<\/vPMC><\/med>/.test(det1),
    'item 1 recebeu <med> com registro e PMC');

  // Ordem do schema: indTot → rastro → med → fim de prod.
  const ordem = det1.indexOf('<indTot>') < det1.indexOf('<rastro>')
    && det1.indexOf('<rastro>') < det1.indexOf('<med>')
    && det1.indexOf('<med>') < det1.indexOf('</prod>');
  assert(ordem, 'ordem dentro de <prod>: indTot, rastro, med, </prod> — como manda o layout 4.00', det1);
  assert(det1.indexOf('<med>') < det1.indexOf('<imposto>'),
    'os grupos ficam dentro de <prod>, antes de <imposto>');

  // O item que não é medicamento tem de sair intocado, byte a byte.
  const corte = (x) => x.slice(x.indexOf('<det nItem="2"'), x.indexOf('</NFe>'));
  assert(corte(xmlOriginal) === corte(xmlNovo), 'item 2 (caneta) permanece byte a byte igual');
  assert(!/rastro|med>/.test(corte(xmlNovo)), 'item não-medicamento não ganhou grupo nenhum');

  // Nada fora dos <det> mudou.
  const cabeca = (x) => x.slice(0, x.indexOf('<det nItem="1"'));
  assert(cabeca(xmlOriginal) === cabeca(xmlNovo), 'ide/emit/dest permanecem intactos');

  // O parser confirma a estrutura (não só a regex).
  const p = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  const doc = p.parse(xmlNovo);
  const det = doc.NFe.infNFe.det;
  assert(det[0].prod.med && det[0].prod.med.cProdANVISA === '1023505440029',
    'parser lê med.cProdANVISA no item 1');
  assert(det[0].prod.rastro && det[0].prod.rastro.nLote === 'L2026A',
    'parser lê rastro.nLote no item 1');
  assert(!det[1].prod.med && !det[1].prod.rastro, 'parser confirma que o item 2 não tem os grupos');

  // Dois lotes no mesmo item: o layout aceita rastro repetido.
  const dadosDoisLotes = [{
    indice: 0,
    rastro: [
      { nLote: 'LA', qLote: '1.000', dFab: dia(-90), dVal: dia(100) },
      { nLote: 'LB', qLote: '1.000', dFab: dia(-30), dVal: dia(200) },
    ],
    med: { cProdANVISA: '1023505440029', xMotivoIsencao: null, vPMC: '15.90' },
  }];
  const xmlDois = injetarMedRastro(xmlOriginal, dadosDoisLotes);
  const docDois = p.parse(xmlDois);
  const rastroDois = docDois.NFe.infNFe.det[0].prod.rastro;
  assert(Array.isArray(rastroDois) && rastroDois.length === 2,
    'quantidade que atravessa dois lotes vira dois <rastro> no mesmo item',
    JSON.stringify(rastroDois));

  // Texto com & e < no motivo não pode quebrar o XML.
  const xmlEscape = injetarMedRastro(xmlOriginal, [{
    indice: 0, rastro: dados[0].rastro,
    med: { cProdANVISA: 'ISENTO', xMotivoIsencao: 'DECISAO 1 & 2 <teste>', vPMC: '10.00' },
  }]);
  assert(XMLValidator.validate(xmlEscape) === true, 'motivo com & e < é escapado e não quebra o XML');
  assert(/DECISAO 1 &amp; 2 &lt;teste&gt;/.test(xmlEscape), 'caracteres especiais viram entidades');

  // Sem medicamento na nota, o XML não é tocado.
  assert(injetarMedRastro(xmlOriginal, []) === xmlOriginal, 'nota sem medicamento sai idêntica');

  // ─── Limpeza ───────────────────────────────────────────────────────────────
  limpar();
  const sobrou = db.prepare('SELECT COUNT(*) n FROM produtos WHERE sku LIKE ?').get(PREFIXO + '%').n;
  assert(sobrou === 0, 'massa de teste removida do tenant');

  console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
  process.exit(fail === 0 ? 0 : 1);
})();
