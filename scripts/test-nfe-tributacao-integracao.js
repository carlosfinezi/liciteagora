#!/usr/bin/env node
/**
 * test-nfe-tributacao-integracao.js — o motor de tributação ligado ao emissor.
 *
 * Duas perguntas, e as duas precisam de resposta antes de isso ir para produção:
 *
 *   1. REGRESSÃO — as notas que já são emitidas hoje continuam pelo caminho de
 *      sempre? Roda contra os itens REAIS das faturas já autorizadas dos tenants
 *      do Simples (leitura pura, nenhuma escrita) e exige que a ponte devolva
 *      null para todos — isto é, que o motor não assuma nenhum deles.
 *
 *   2. XSD — as tags que o motor produz para regime normal geram XML que passa
 *      no nfe_v4.00.xsd? Monta uma NF-e completa com a lib e valida com xmllint.
 *
 * Uso: node scripts/test-nfe-tributacao-integracao.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const fs = require('fs');
const Database = require(BASE + '/node_modules/better-sqlite3');
const { calcularTributacaoItem, validarXmlLocal, corrigirCstIpiZero } = require(BASE + '/nfe-emit-routes');

// O XML montado aqui não é assinado — o validarXmlLocal roda, em produção, DEPOIS
// da assinatura. Então o único erro esperado é a falta de <Signature>; qualquer
// outro é falha de verdade.
function validarIgnorandoAssinatura(xml) {
  const err = validarXmlLocal(xml);
  if (!err) return null;
  const linhas = String(err).split('\n')
    .filter(l => l.trim() && !/Signature/.test(l) && !/fails to validate/.test(l));
  return linhas.length ? linhas.join('\n') : null;
}
const T = require(BASE + '/fiscal-tributacao');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

// ─── 1. Regressão contra as notas reais já emitidas ──────────────────────────
secao('Regressão — faturas já autorizadas em produção continuam no caminho antigo');
{
  const tenants = fs.readdirSync(BASE + '/data/tenants');
  let itensChecados = 0, desviados = 0, tenantsComNota = 0;

  for (const slug of tenants) {
    const p = `${BASE}/data/tenants/${slug}/pncp.db`;
    if (!fs.existsSync(p)) continue;
    const db = new Database(p, { readonly: true });
    try {
      const crt = T.crtDoEmitente(db);
      // Só faz sentido para os tenants do Simples: é neles que "não mudar" é o requisito.
      if (!T.ehSimples(crt)) { db.close(); continue; }

      const itens = db.prepare(`
        SELECT fi.*, f.clienteId, p.uf AS clienteUf, f.tipoOperacaoId
          FROM fatura_itens fi
          JOIN faturas f ON f.id = fi.faturaId
          LEFT JOIN pessoas p ON p.id = f.clienteId
         WHERE f.chaveAcesso IS NOT NULL`).all();
      if (!itens.length) { db.close(); continue; }
      tenantsComNota++;

      const emitUf = (db.prepare('SELECT uf FROM fornecedor WHERE id = 1').get() || {}).uf;
      for (const it of itens) {
        itensChecados++;
        const r = calcularTributacaoItem(db, {
          crt, it, cfop: it.cfop || '5102', prod: null, cfopMeta: null,
          emitUf, destUf: it.clienteUf, tipoOpRow: it.tipoOperacaoId ? { id: it.tipoOperacaoId } : null,
          vFreteItem: 0,
        });
        if (r !== null) {
          desviados++;
          console.error(`      desvio: tenant ${slug}, item ${it.id}, CFOP ${it.cfop}, NCM ${it.ncm}`);
        }
      }
    } finally { try { db.close(); } catch {} }
  }

  assert(tenantsComNota > 0, `${tenantsComNota} tenant(s) do Simples com nota autorizada examinados`);
  assert(itensChecados > 0, `${itensChecados} itens reais checados`);
  assert(desviados === 0, `nenhum item existente muda de caminho (desvios: ${desviados})`);
}

// ─── 2. XSD: o XML do regime normal é válido? ────────────────────────────────
secao('XSD — NF-e de regime normal (CST 20 com redução de base)');
(async () => {
  const { Make } = await import(BASE + '/node_modules/node-sped-nfe/dist/index.js');
  const db = new Database(`${BASE}/data/tenants/labfiscal/pncp.db`);

  // Garante a regra do cenário (o teste do motor a semeia; aqui não dependemos disso).
  db.prepare('DELETE FROM fiscal_regras_trib').run();
  db.prepare(`INSERT INTO fiscal_regras_trib
      (descricao, prioridade, ativo, regimeEmitente, ncmPrefixo, cstIcms, modBC, pIcms, pRedBC,
       cstPis, pPis, cstCofins, pCofins)
    VALUES ('Fertilizante 3105 c/ reducao', 10, 1, 3, '3105', '20', 3, 12, 78.95, '01', 1.65, '01', 7.6)`).run();

  const item = { id: 1, produtoId: null, sku: 'FERT-01', descricao: 'BOOSTER INFINITY 10L',
    unidade: 'UN', quantidade: 1, precoUnitario: 1, valorTotal: 1, ncm: '31051000',
    cfop: '5910', origem: '0' };

  const trib = calcularTributacaoItem(db, {
    crt: 3, it: item, cfop: '5910', prod: null, cfopMeta: null,
    emitUf: 'TO', destUf: 'TO', tipoOpRow: null, vFreteItem: 0,
  });
  assert(trib && trib.grupo === 'ICMS', 'motor assumiu o item (grupo ICMS)');
  assert(trib && trib.icms.vICMS === '0.03', `ICMS 0,03 (veio ${trib && trib.icms.vICMS})`);

  const NFe = new Make();
  NFe.tagInfNFe({ Id: null, versao: '4.00' });
  NFe.tagIde({
    cUF: '17', cNF: '12345678', natOp: 'REMESSA EM BONIFICACAO', mod: '55', serie: '1', nNF: '1',
    dhEmi: NFe.formatData(), tpNF: '1', idDest: '1', cMunFG: '1721000', tpImp: '1', tpEmis: '1',
    cDV: '0', tpAmb: '2', finNFe: '1', indFinal: '0', indPres: '1', indIntermed: '0',
    procEmi: '0', verProc: 'LiciteAgora1.0',
  });
  NFe.tagEmit({ CNPJ: '11222333000181', xNome: 'LAB FISCAL LTDA', xFant: 'LAB FISCAL',
    IE: '123456789', CRT: '3' });
  NFe.tagEnderEmit({ xLgr: 'RUA TESTE', nro: '100', xBairro: 'CENTRO', cMun: '1721000',
    xMun: 'PALMAS', UF: 'TO', CEP: '77000000', cPais: '1058', xPais: 'BRASIL' });
  NFe.tagDest({ CNPJ: '11444777000161', xNome: 'CLIENTE TESTE', indIEDest: '1', IE: '987654321' });
  NFe.tagEnderDest({ xLgr: 'AV CLIENTE', nro: '200', xBairro: 'CENTRO', cMun: '1721000',
    xMun: 'PALMAS', UF: 'TO', CEP: '77000000', cPais: '1058', xPais: 'BRASIL' });
  NFe.tagProd([{
    cProd: item.sku, cEAN: 'SEM GTIN', xProd: item.descricao, NCM: item.ncm, CFOP: item.cfop,
    uCom: 'UN', qCom: '1.0000', vUnCom: '1.0000', vProd: '1.00',
    cEANTrib: 'SEM GTIN', uTrib: 'UN', qTrib: '1.0000', vUnTrib: '1.0000', indTot: '1',
  }]);
  NFe.tagProdICMS(0, trib.icms);
  NFe.tagProdPIS(0, trib.pis);
  NFe.tagProdCOFINS(0, trib.cofins);
  NFe.tagTotal({ ICMSTot: {
    vBC: trib.totais.vBC.toFixed(2), vICMS: trib.totais.vICMS.toFixed(2),
    vBCST: '0.00', vST: '0.00', vProd: '1.00', vFrete: '0.00', vDesc: '0.00',
    vIPI: '0.00', vPIS: trib.totais.vPIS.toFixed(2), vCOFINS: trib.totais.vCOFINS.toFixed(2),
    vNF: '1.00',
  }});
  NFe.tagTransp({ modFrete: 9 });
  NFe.tagDetPag([{ indPag: 0, tPag: '90', vPag: '1.00' }]);

  const xml = corrigirCstIpiZero(NFe.xml());
  const erro = validarIgnorandoAssinatura(xml);
  assert(erro === null, 'XML de regime normal passa no nfe_v4.00.xsd',
    erro ? String(erro).split('\n').slice(0, 4).join('\n      ') : '');
  assert(/<CST>20<\/CST>/.test(xml), 'XML traz <CST>20</CST>');
  assert(/<pRedBC>78\.95<\/pRedBC>/.test(xml), 'XML traz a redução de base');
  assert(/<vICMS>0\.03<\/vICMS>/.test(xml), 'XML traz vICMS 0.03');
  assert(/<CRT>3<\/CRT>/.test(xml), 'XML traz CRT 3');
  assert(!/ICMSSN/.test(xml), 'não usa grupo do Simples');

  // ─── 3. ST: o grupo ICMS10 também precisa passar no XSD ───────────────────
  secao('XSD — NF-e com ICMS ST (CST 10 + IPI)');
  db.prepare('DELETE FROM fiscal_regras_trib').run();
  db.prepare(`INSERT INTO fiscal_regras_trib
      (descricao, prioridade, ativo, regimeEmitente, ncmPrefixo, cstIcms, modBC, pIcms,
       modBCST, pMVAST, pIcmsST, cstIpi, pIpi, cstPis, pPis, cstCofins, pCofins)
    VALUES ('Bebida 2202 ST', 10, 1, 3, '2202', '10', 3, 12, 4, 40, 18, '00', 5, '01', 1.65, '01', 7.6)`).run();

  const itemST = { ...item, id: 2, sku: 'BEB-01', descricao: 'REFRIGERANTE 2L', ncm: '22021000',
    cfop: '6404', quantidade: 1, precoUnitario: 100, valorTotal: 100 };
  const tribST = calcularTributacaoItem(db, {
    crt: 3, it: itemST, cfop: '6404', prod: null, cfopMeta: null,
    emitUf: 'TO', destUf: 'GO', tipoOpRow: null, vFreteItem: 0,
  });
  assert(tribST.icms.vICMSST === '13.20', `ST 13,20 (veio ${tribST.icms.vICMSST})`);

  const N2 = new Make();
  N2.tagInfNFe({ Id: null, versao: '4.00' });
  N2.tagIde({ cUF: '17', cNF: '12345679', natOp: 'VENDA', mod: '55', serie: '1', nNF: '2',
    dhEmi: N2.formatData(), tpNF: '1', idDest: '2', cMunFG: '1721000', tpImp: '1', tpEmis: '1',
    cDV: '0', tpAmb: '2', finNFe: '1', indFinal: '0', indPres: '1', indIntermed: '0',
    procEmi: '0', verProc: 'LiciteAgora1.0' });
  N2.tagEmit({ CNPJ: '11222333000181', xNome: 'LAB FISCAL LTDA', xFant: 'LAB FISCAL', IE: '123456789', CRT: '3' });
  N2.tagEnderEmit({ xLgr: 'RUA TESTE', nro: '100', xBairro: 'CENTRO', cMun: '1721000',
    xMun: 'PALMAS', UF: 'TO', CEP: '77000000', cPais: '1058', xPais: 'BRASIL' });
  N2.tagDest({ CNPJ: '11444777000161', xNome: 'CLIENTE GO', indIEDest: '1', IE: '987654321' });
  N2.tagEnderDest({ xLgr: 'AV CLIENTE', nro: '200', xBairro: 'CENTRO', cMun: '5208707',
    xMun: 'GOIANIA', UF: 'GO', CEP: '74000000', cPais: '1058', xPais: 'BRASIL' });
  N2.tagProd([{ cProd: itemST.sku, cEAN: 'SEM GTIN', xProd: itemST.descricao, NCM: itemST.ncm,
    CFOP: itemST.cfop, uCom: 'UN', qCom: '1.0000', vUnCom: '100.0000', vProd: '100.00',
    cEANTrib: 'SEM GTIN', uTrib: 'UN', qTrib: '1.0000', vUnTrib: '100.0000', indTot: '1' }]);
  N2.tagProdICMS(0, tribST.icms);
  N2.tagProdIPI(0, tribST.ipi);
  N2.tagProdPIS(0, tribST.pis);
  N2.tagProdCOFINS(0, tribST.cofins);
  // vNF = 100 (prod) + 13,20 (ST) + 5,00 (IPI) = 118,20
  N2.tagTotal({ ICMSTot: {
    vBC: tribST.totais.vBC.toFixed(2), vICMS: tribST.totais.vICMS.toFixed(2),
    vBCST: tribST.totais.vBCST.toFixed(2), vST: tribST.totais.vICMSST.toFixed(2),
    vProd: '100.00', vFrete: '0.00', vDesc: '0.00', vIPI: tribST.totais.vIPI.toFixed(2),
    vPIS: tribST.totais.vPIS.toFixed(2), vCOFINS: tribST.totais.vCOFINS.toFixed(2),
    vNF: '118.20',
  }});
  N2.tagTransp({ modFrete: 9 });
  N2.tagDetPag([{ indPag: 0, tPag: '90', vPag: '118.20' }]);

  const xml2 = corrigirCstIpiZero(N2.xml());
  const erro2 = validarIgnorandoAssinatura(xml2);
  assert(erro2 === null, 'XML com ST + IPI passa no nfe_v4.00.xsd',
    erro2 ? String(erro2).split('\n').slice(0, 4).join('\n      ') : '');
  assert(/<vICMSST>13\.20<\/vICMSST>/.test(xml2), 'XML traz vICMSST 13.20');
  assert(/<vIPI>5\.00<\/vIPI>/.test(xml2), 'XML traz vIPI 5.00');
  assert(/<IPITrib><CST>00<\/CST>/.test(xml2), 'CST 00 do IPI sobreviveu ao bug da lib');

  db.prepare('DELETE FROM fiscal_regras_trib').run();
  db.close();

  console.log(`\n${'─'.repeat(56)}`);
  console.log(fail === 0 ? `TODOS OS ${ok} ASSERTS PASSARAM` : `${ok} OK · ${fail} FALHARAM`);
  process.exit(fail === 0 ? 0 : 1);
})();
