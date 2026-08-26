/**
 * Núcleo do espelho fiscal (espelho-fiscal.js).
 *
 * O motor foi extraído de devolucao-compra.js para ser usado nos dois sentidos da
 * devolução. Estes testes travam o que não pode mudar na extração — parse do XML,
 * rateio proporcional, condicionais de ICMS/ST, IPI tributado vs. isento — e o que
 * mudou de propósito: desconto passa a ser espelhado e frete virou opção.
 *
 * Função pura, sem banco: roda solto com `node scripts/test-espelho-fiscal.js`.
 */
const {
  parseEspelho, parseImpostoItem, parseIbsCbsItem, calcularImpostoEspelho,
} = require('../espelho-fiscal');

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: esperado ${b}, veio ${a}`); };

// NF-e de duas linhas: item 1 com ICMS destacado, IPI tributado, desconto e frete;
// item 2 isento de IPI e com ST. Cobre os dois ramos condicionais do motor.
const XML = `<nfeProc><NFe><infNFe>
<det nItem="1"><prod>
  <cProd>SKU-1</cProd><xProd>PARAFUSO SEXTAVADO</xProd><NCM>73181500</NCM><CFOP>5102</CFOP>
  <uCom>UN</uCom><qCom>10.0000</qCom><vUnCom>25.0000</vUnCom><vProd>250.00</vProd>
  <vDesc>25.00</vDesc><vFrete>10.00</vFrete>
</prod><imposto>
  <ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>250.00</vBC><pICMS>18.00</pICMS><vICMS>45.00</vICMS></ICMS00></ICMS>
  <IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vBC>250.00</vBC><pIPI>5.0000</pIPI><vIPI>12.50</vIPI></IPITrib></IPI>
  <PIS><PISAliq><CST>01</CST><vBC>250.00</vBC><pPIS>1.6500</pPIS><vPIS>4.13</vPIS></PISAliq></PIS>
  <COFINS><COFINSAliq><CST>01</CST><vBC>250.00</vBC><pCOFINS>7.6000</pCOFINS><vCOFINS>19.00</vCOFINS></COFINSAliq></COFINS>
</imposto></det>
<det nItem="2"><prod>
  <cProd>SKU-2</cProd><xProd>ARRUELA LISA</xProd><NCM>73182100</NCM><CFOP>5403</CFOP>
  <uCom>CX</uCom><qCom>4.0000</qCom><vUnCom>100.0000</vUnCom><vProd>400.00</vProd>
</prod><imposto>
  <ICMS><ICMS10><orig>0</orig><CST>10</CST><modBC>3</modBC><vBC>400.00</vBC><pICMS>18.00</pICMS><vICMS>72.00</vICMS>
    <modBCST>4</modBCST><vBCST>520.00</vBCST><pICMSST>18.00</pICMSST><vICMSST>21.60</vICMSST></ICMS10></ICMS>
  <IPI><cEnq>999</cEnq><IPINT><CST>53</CST></IPINT></IPI>
  <PIS><PISNT><CST>07</CST></PISNT></PIS>
  <COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>
</imposto></det>
</infNFe></NFe></nfeProc>`;

// Espelho como os montadores entregam: item de origem + CFOP já resolvido.
function espelhoDe(xmlItens, chave) {
  return xmlItens.map((x, i) => ({
    [chave]: 100 + i,
    numero: x.numero,
    produtoId: 500 + i,
    descricao: x.descricao,
    ncm: x.ncm,
    unidade: x.unidade,
    quantidadeOrigem: x.quantidade,
    valorUnitario: x.valorUnitario,
    valorTotal: x.valorTotal,
    valorDesconto: x.valorDesconto,
    valorFrete: x.valorFrete,
    cfopDevolucao: x.cfopXml === '5102' ? '1202' : '1411',
    imposto: x.imposto,
    ibsCbs: x.ibsCbs,
  }));
}

const itensXml = parseEspelho(XML);

// ==================== PARSE ====================

t('parse lê os dois itens com prod completo', () => {
  eq(itensXml.length, 2, 'quantidade de itens');
  eq(itensXml[0].descricao, 'PARAFUSO SEXTAVADO', 'descrição item 1');
  eq(itensXml[0].valorTotal, 250, 'vProd item 1');
  eq(itensXml[0].valorDesconto, 25, 'vDesc item 1');
  eq(itensXml[0].valorFrete, 10, 'vFrete item 1');
  eq(itensXml[1].valorDesconto, 0, 'item sem vDesc vira 0');
});

t('parse do imposto cobre ICMS, ST, IPI, PIS e COFINS', () => {
  const a = itensXml[0].imposto;
  eq(a.cstIcms, '00', 'CST ICMS'); eq(a.vIcms, 45, 'vICMS'); eq(a.pIcms, 18, 'pICMS');
  eq(a.cstIpi, '50', 'CST IPI'); eq(a.vIpi, 12.5, 'vIPI'); eq(a.cEnqIpi, '999', 'cEnq');
  eq(a.cstPis, '01', 'CST PIS'); eq(a.vPis, 4.13, 'vPIS');
  eq(a.cstCofins, '01', 'CST COFINS'); eq(a.vCofins, 19, 'vCOFINS');
  const b = itensXml[1].imposto;
  eq(b.vBCST, 520, 'vBCST'); eq(b.vIcmsST, 21.6, 'vICMSST'); eq(b.cstIpi, '53', 'IPI isento');
});

t('nota sem grupo IBS/CBS devolve null', () => {
  assert(parseIbsCbsItem('<imposto><ICMS/></imposto>') === null, 'deveria ser null');
  assert(itensXml[0].ibsCbs === null, 'item pré-reforma não tem IBS/CBS');
});

t('IBS/CBS é lido quando existe', () => {
  const b = parseIbsCbsItem(`<imposto><IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib>
    <gIBSCBS><vBC>250.00</vBC><gIBSUF><pIBSUF>0.1000</pIBSUF><vIBSUF>0.25</vIBSUF></gIBSUF>
    <gIBSMun><pIBSMun>0.0500</pIBSMun><vIBSMun>0.13</vIBSMun></gIBSMun><vIBS>0.38</vIBS>
    <gCBS><pCBS>0.9000</pCBS><vCBS>2.25</vCBS></gCBS></gIBSCBS></IBSCBS></imposto>`);
  eq(b.cClassTrib, '000001', 'cClassTrib'); eq(b.vCBS, 2.25, 'vCBS'); eq(b.vBC, 250, 'vBC');
});

// ==================== DEVOLUÇÃO TOTAL ====================

t('total espelha os valores cheios da nota', () => {
  const { itens, totais } = calcularImpostoEspelho(espelhoDe(itensXml, 'nfeEntradaItemId'), null);
  eq(itens.length, 2, 'itens devolvidos');
  eq(totais.vProd, '650.00', 'vProd');
  eq(totais.vICMS, '117.00', 'vICMS');
  eq(totais.vST, '21.60', 'vST');
  eq(totais.vIPI, '12.50', 'vIPI');
  // vNF = produtos − desconto + IPI + ST (frete fora por padrão)
  eq(totais.vNF, '659.10', 'vNF');
  eq(totais.vDesc, '25.00', 'desconto espelhado');
  eq(totais.vFrete, '0.00', 'frete não devolvido por padrão');
});

t('alíquota não é rateada; ICMS/ST só aparecem quando houve destaque', () => {
  const { itens } = calcularImpostoEspelho(espelhoDe(itensXml, 'nfeEntradaItemId'), null);
  eq(itens[0].icms.pICMS, '18.00', 'pICMS do item 1');
  assert(itens[0].icms.vBCST === undefined, 'item sem ST não pode ter grupo ST');
  eq(itens[1].icms.vICMSST, '21.60', 'ST do item 2');
  eq(itens[0].icms.CSOSN, '900', 'CSOSN padrão');
});

t('IPI: tributado leva valor, isento leva só CST', () => {
  const { itens } = calcularImpostoEspelho(espelhoDe(itensXml, 'nfeEntradaItemId'), null);
  eq(itens[0].ipi.vIPI, '12.50', 'IPI tributado');
  eq(itens[1].ipi.CST, '53', 'IPI isento');
  assert(itens[1].ipi.vIPI === undefined, 'IPINT não pode ter valor');
});

// ==================== DEVOLUÇÃO PARCIAL ====================

t('parcial rateia bases e valores proporcionalmente', () => {
  // Metade do item 1 (5 de 10), item 2 fora.
  const q = new Map([[100, 5]]);
  const { itens, totais } = calcularImpostoEspelho(espelhoDe(itensXml, 'nfeEntradaItemId'), q);
  eq(itens.length, 1, 'só o item selecionado entra');
  eq(itens[0].vProd, 125, 'vProd rateado');
  eq(itens[0].icms.vICMS, '22.50', 'ICMS rateado');
  eq(itens[0].icms.pICMS, '18.00', 'alíquota intacta');
  eq(itens[0].vDesc, 12.5, 'desconto rateado');
  eq(totais.vNF, '118.75', 'vNF = 125 − 12,50 + 6,25 de IPI');
});

t('item ausente do mapa fica de fora; quantidade zero também', () => {
  const { itens } = calcularImpostoEspelho(espelhoDe(itensXml, 'nfeEntradaItemId'), new Map([[101, 0]]));
  eq(itens.length, 0, 'nada a devolver');
});

// ==================== OPÇÕES ====================

t('devolverFrete traz o frete do item para o total', () => {
  const { itens, totais } = calcularImpostoEspelho(
    espelhoDe(itensXml, 'nfeEntradaItemId'), null, { devolverFrete: true });
  eq(itens[0].vFrete, 10, 'frete do item');
  eq(totais.vFrete, '10.00', 'vFrete no total');
  eq(totais.vNF, '669.10', 'frete soma ao vNF');
});

t('espelharDesconto:false volta ao comportamento antigo (vDesc zerado)', () => {
  const { totais } = calcularImpostoEspelho(
    espelhoDe(itensXml, 'nfeEntradaItemId'), null, { espelharDesconto: false });
  eq(totais.vDesc, '0.00', 'sem desconto');
  eq(totais.vNF, '684.10', 'vNF sem abater desconto');
});

t('chaveItem troca o campo de origem — é o que separa compra de venda', () => {
  const esp = espelhoDe(itensXml, 'faturaItemOrigemId');
  const { itens } = calcularImpostoEspelho(esp, new Map([[100, 2]]), { chaveItem: 'faturaItemOrigemId' });
  eq(itens.length, 1, 'seleção pela chave de venda');
  eq(itens[0].faturaItemOrigemId, 100, 'chave preservada no retorno');
  assert(itens[0].nfeEntradaItemId === undefined, 'não deve vazar a chave de compra');
});

t('csosn é do chamador (regime do emitente manda)', () => {
  const { itens } = calcularImpostoEspelho(espelhoDe(itensXml, 'nfeEntradaItemId'), null, { csosn: '102' });
  eq(itens[0].icms.CSOSN, '102', 'CSOSN aplicado');
});

t('CFOP de devolução vem do montador, não do XML de origem', () => {
  const { itens } = calcularImpostoEspelho(espelhoDe(itensXml, 'nfeEntradaItemId'), null);
  eq(itens[0].cfop, '1202', 'CFOP item 1');
  eq(itens[1].cfop, '1411', 'CFOP item 2 (ST)');
});

t('IBS/CBS é rateado junto quando a nota de origem tem o grupo', () => {
  const esp = espelhoDe(itensXml, 'nfeEntradaItemId');
  esp[0].ibsCbs = { cst: '000', cClassTrib: '000001', vBC: 250, pIBSUF: 0.1, vIBSUF: 0.25,
                    pIBSMun: 0.05, vIBSMun: 0.13, vIBS: 0.38, pCBS: 0.9, vCBS: 2.25 };
  const { itens } = calcularImpostoEspelho(esp, new Map([[100, 5]]));
  eq(itens[0].ibsCbs.gIBSCBS.vBC, '125.00', 'base rateada');
  eq(itens[0].ibsCbs.gIBSCBS.gCBS.vCBS, '1.13', 'CBS rateado');
  eq(itens[0].ibsCbs.gIBSCBS.gCBS.pCBS, '0.9000', 'alíquota intacta');
});

console.log(`\n${ok} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
