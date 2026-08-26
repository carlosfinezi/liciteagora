'use strict';

/**
 * espelho-fiscal.js — núcleo do "espelho" de nota fiscal.
 *
 * Devolver mercadoria é reproduzir a tributação do documento de origem, não recalculá-la:
 * o que a outra ponta destacou é o que ela precisa creditar de volta. Este módulo faz a
 * parte que independe do sentido da operação — ler o XML autorizado e transformar item +
 * quantidade devolvida nos payloads das tags SEFAZ e nos totais da nota.
 *
 * Os dois sentidos vivem em cima daqui:
 *   - devolucao-compra.js  entrada (fornecedor) → NF-e de saída, CFOP 5xxx/6xxx
 *   - devolucao-venda.js   saída (cliente)      → NF-e de entrada, CFOP 1xxx/2xxx
 *
 * O que muda entre eles é resolvido por `opts`: a chave que identifica o item de origem e
 * o CSOSN a aplicar. O que NÃO muda — parse do XML, rateio proporcional, condicionais de
 * ICMS/ST, IPI tributado vs. não tributado, soma dos totais — mora aqui, uma vez só.
 *
 * Funções puras: nada de banco nem da lib node-sped-nfe, para poderem ser testadas soltas.
 */

// ─── Helpers de XML (regex, mesmo estilo do nfe-entrada-routes.js) ───────────
function tag(str, t) {
  const re = new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i');
  const m = str && str.match(re);
  return m ? m[1].trim() : null;
}
function tagAll(str, t) {
  const re = new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'gi');
  const out = []; let m;
  while ((m = re.exec(str)) !== null) out.push(m[1]);
  return out;
}
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

// ─── Imposto completo de UM item, do XML ─────────────────────────────────────
// Extrai o que o motor precisa pra reproduzir a tributação (não confia nas colunas
// resumidas das tabelas). Cobre ICMS (normal e SN), ST, IPI, PIS, COFINS.
function parseImpostoItem(body) {
  const imp = tagAll(body, 'imposto')[0] || '';
  const icmsGrp = tagAll(imp, 'ICMS')[0] || '';       // wrapper que contém ICMS00/10/.../ICMSSNxxx
  const ipiGrp = tagAll(imp, 'IPI')[0] || '';
  const pisGrp = tagAll(imp, 'PIS')[0] || '';
  const cofinsGrp = tagAll(imp, 'COFINS')[0] || '';

  return {
    origem: tag(icmsGrp, 'orig') || '0',
    cstIcms: tag(icmsGrp, 'CST'),      // null se for Simples (usa CSOSN)
    csosn: tag(icmsGrp, 'CSOSN'),
    modBCIcms: tag(icmsGrp, 'modBC'),
    vBCIcms: num(tag(icmsGrp, 'vBC')),
    pIcms: num(tag(icmsGrp, 'pICMS')),
    vIcms: num(tag(icmsGrp, 'vICMS')),
    // Substituição tributária (quando houver)
    vBCST: num(tag(icmsGrp, 'vBCST')),
    pIcmsST: num(tag(icmsGrp, 'pICMSST')),
    vIcmsST: num(tag(icmsGrp, 'vICMSST')),
    // IPI (destaque em IPITrib; IPINT só tem CST). cEnq = enquadramento legal (obrigatório).
    cstIpi: tag(ipiGrp, 'CST'),
    cEnqIpi: tag(ipiGrp, 'cEnq') || '999',
    vBCIpi: num(tag(ipiGrp, 'vBC')),
    pIpi: num(tag(ipiGrp, 'pIPI')),
    vIpi: num(tag(ipiGrp, 'vIPI')),
    // PIS/COFINS
    cstPis: tag(pisGrp, 'CST'),
    vBCPis: num(tag(pisGrp, 'vBC')),
    pPis: num(tag(pisGrp, 'pPIS')),
    vPis: num(tag(pisGrp, 'vPIS')),
    cstCofins: tag(cofinsGrp, 'CST'),
    vBCCofins: num(tag(cofinsGrp, 'vBC')),
    pCofins: num(tag(cofinsGrp, 'pCOFINS')),
    vCofins: num(tag(cofinsGrp, 'vCOFINS')),
  };
}

// IBS/CBS (reforma tributária, grupo UB). Só existe em nota emitida com o grupo ligado —
// devolver nota anterior à reforma cai no `null`, e quem chama decide o que fazer.
function parseIbsCbsItem(body) {
  const imp = tagAll(body, 'imposto')[0] || '';
  const grp = tagAll(imp, 'IBSCBS')[0] || '';
  if (!grp) return null;
  const g = tagAll(grp, 'gIBSCBS')[0] || '';
  const gUF = tagAll(g, 'gIBSUF')[0] || '';
  const gMun = tagAll(g, 'gIBSMun')[0] || '';
  const gCBS = tagAll(g, 'gCBS')[0] || '';
  return {
    cst: tag(grp, 'CST'),
    cClassTrib: tag(grp, 'cClassTrib'),
    vBC: num(tag(g, 'vBC')),
    pIBSUF: num(tag(gUF, 'pIBSUF')), vIBSUF: num(tag(gUF, 'vIBSUF')),
    pIBSMun: num(tag(gMun, 'pIBSMun')), vIBSMun: num(tag(gMun, 'vIBSMun')),
    vIBS: num(tag(g, 'vIBS')),
    pCBS: num(tag(gCBS, 'pCBS')), vCBS: num(tag(gCBS, 'vCBS')),
  };
}

// Um registro por <det> do XML: prod + imposto espelhado (+ IBS/CBS quando houver).
// `cfopXml` é o CFOP de quem EMITIU aquele documento — nunca é o CFOP da devolução;
// cada lado resolve o seu (ver cfopDevolucao em devolucao-compra.js / devolucao-venda.js).
function parseEspelho(xmlOriginal) {
  const out = [];
  const regex = /<det\s+nItem="(\d+)"[^>]*>([\s\S]*?)<\/det>/g;
  let m;
  while ((m = regex.exec(xmlOriginal)) !== null) {
    const numero = Number(m[1]);
    const body = m[2];
    const prod = tagAll(body, 'prod')[0] || '';
    out.push({
      numero,
      codigoProduto: tag(prod, 'cProd'),
      descricao: tag(prod, 'xProd'),
      ncm: tag(prod, 'NCM'),
      cfopXml: tag(prod, 'CFOP'),
      unidade: tag(prod, 'uCom'),
      quantidade: num(tag(prod, 'qCom')),
      valorUnitario: num(tag(prod, 'vUnCom')),
      valorTotal: num(tag(prod, 'vProd')),
      valorDesconto: num(tag(prod, 'vDesc')),
      valorFrete: num(tag(prod, 'vFrete')),
      imposto: parseImpostoItem(body),
      ibsCbs: parseIbsCbsItem(body),
    });
  }
  return out;
}

// CSTs de IPI que levam valor (IPITrib); o resto é IPINT (só CST). Espelha o switch da lib.
const IPI_TRIBUTADO = new Set(['00', '49', '50', '99']);

/**
 * Motor do espelho. Dado o espelho dos itens e as quantidades a devolver (parcial → rateio
 * proporcional), devolve POR ITEM os payloads prontos das tags SEFAZ (ICMS c/ destaque, IPI,
 * PIS, COFINS) + os TOTAIS (ICMSTot) já somados. As alíquotas NÃO são rateadas; bases,
 * valores, desconto e frete sim.
 *
 * quantidades: Map(chaveItem → qtd) = seleção EXPLÍCITA (só os itens do mapa entram; ausentes
 * ficam de fora). Sem o argumento (null/undefined) = devolução TOTAL (todos cheios).
 *
 * opts:
 *   chaveItem  nome do campo que identifica o item de origem ('nfeEntradaItemId' | 'faturaItemOrigemId')
 *   csosn      CSOSN a aplicar no grupo ICMS do Simples (default '900')
 *   devolverFrete    rateia o frete do item para a devolução (default false — frete via de
 *                    regra não volta; o Solution também pergunta antes)
 *   espelharDesconto rateia o desconto do item (default true — sem isso a devolução vale
 *                    mais que o que foi cobrado)
 */
function calcularImpostoEspelho(itensEspelho, quantidades, opts = {}) {
  const chaveItem = opts.chaveItem || 'nfeEntradaItemId';
  const csosnDev = String(opts.csosn || '900');
  const devolverFrete = !!opts.devolverFrete;
  const espelharDesconto = opts.espelharDesconto !== false;

  const total = !quantidades;               // sem seleção → devolução total
  const q = quantidades || new Map();
  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const itens = [];
  const tot = { vProd: 0, vBC: 0, vICMS: 0, vBCST: 0, vST: 0, vIPI: 0, vPIS: 0, vCOFINS: 0, vDesc: 0, vFrete: 0 };

  for (const it of itensEspelho) {
    const chave = it[chaveItem];
    // Quantidade do documento de origem: recebida (entrada) ou vendida (saída).
    const qtdOrigem = Number(it.quantidadeOrigem != null ? it.quantidadeOrigem : it.quantidadeRecebida) || 0;
    let qtdDev;
    if (total) qtdDev = qtdOrigem;
    else if (q.has(chave)) qtdDev = Number(q.get(chave));
    else continue;                          // item não selecionado → fora da devolução
    if (!(qtdDev > 0)) continue;
    const f = qtdOrigem > 0 ? qtdDev / qtdOrigem : 0;
    const imp = it.imposto || {};

    const vProd = r2(Number(it.valorTotal) * f);
    const vDesc = espelharDesconto ? r2((it.valorDesconto || 0) * f) : 0;
    const vFrete = devolverFrete ? r2((it.valorFrete || 0) * f) : 0;
    const vBCicms = r2((imp.vBCIcms || 0) * f);
    const vICMS = r2((imp.vIcms || 0) * f);
    const vBCST = r2((imp.vBCST || 0) * f);
    const vST = r2((imp.vIcmsST || 0) * f);
    const vBCipi = r2((imp.vBCIpi || 0) * f);
    const vIPI = r2((imp.vIpi || 0) * f);
    const vBCpis = r2((imp.vBCPis || 0) * f);
    const vPIS = r2((imp.vPis || 0) * f);
    const vBCcof = r2((imp.vBCCofins || 0) * f);
    const vCOFINS = r2((imp.vCofins || 0) * f);

    // ICMS: CSOSN do chamador. Blocos ICMS/ST são CONDICIONAIS: só entram quando há valor.
    // Motivo: campos enum (modBC/modBCST) que a lib coage p/ "0.00" quando 0 quebram o XSD; e
    // sem ICMS/ST reproduzir zeros nesses grupos é fiscalmente incorreto (não havia destaque).
    const temICMS = vICMS > 0 || vBCicms > 0;
    const temST = vST > 0 || vBCST > 0;
    const icms = { orig: String(imp.origem || '0'), CSOSN: csosnDev };
    if (temICMS) {
      icms.modBC = String(imp.modBCIcms || '3');
      icms.vBC = vBCicms.toFixed(2);
      icms.pICMS = Number(imp.pIcms || 0).toFixed(2);
      icms.vICMS = vICMS.toFixed(2);
    }
    if (temST) {
      icms.modBCST = String(imp.modBCST || '4');
      icms.vBCST = vBCST.toFixed(2);
      icms.pICMSST = Number(imp.pIcmsST || 0).toFixed(2);
      icms.vICMSST = vST.toFixed(2);
    }

    // IPI: reproduz no grupo do item. Tributado → IPITrib c/ valor; senão IPINT só CST.
    let ipi = null;
    if (imp.cstIpi) {
      ipi = IPI_TRIBUTADO.has(String(imp.cstIpi))
        ? { cEnq: String(imp.cEnqIpi || '999'), CST: String(imp.cstIpi), vBC: vBCipi.toFixed(2), pIPI: Number(imp.pIpi || 0).toFixed(4), vIPI: vIPI.toFixed(2) }
        : { cEnq: String(imp.cEnqIpi || '999'), CST: String(imp.cstIpi) };
    }

    const pis = { CST: String(imp.cstPis || '49'), vBC: vBCpis.toFixed(2), pPIS: Number(imp.pPis || 0).toFixed(4), vPIS: vPIS.toFixed(2) };
    const cofins = { CST: String(imp.cstCofins || '49'), vBC: vBCcof.toFixed(2), pCOFINS: Number(imp.pCofins || 0).toFixed(4), vCOFINS: vCOFINS.toFixed(2) };

    // IBS/CBS rateado junto — quem monta o XML decide se usa (só faz sentido com o grupo
    // ligado no emitente). Nota pré-reforma não tem o grupo e sai null.
    let ibsCbs = null;
    if (it.ibsCbs) {
      const b = it.ibsCbs;
      ibsCbs = {
        CST: String(b.cst || '000'),
        cClassTrib: String(b.cClassTrib || '000001'),
        gIBSCBS: {
          vBC: r2(b.vBC * f).toFixed(2),
          gIBSUF: { pIBSUF: Number(b.pIBSUF || 0).toFixed(4), vIBSUF: r2(b.vIBSUF * f).toFixed(2) },
          gIBSMun: { pIBSMun: Number(b.pIBSMun || 0).toFixed(4), vIBSMun: r2(b.vIBSMun * f).toFixed(2) },
          vIBS: r2(b.vIBS * f).toFixed(2),
          gCBS: { pCBS: Number(b.pCBS || 0).toFixed(4), vCBS: r2(b.vCBS * f).toFixed(2) },
        },
      };
    }

    itens.push({
      [chaveItem]: chave, produtoId: it.produtoId, descricao: it.descricao,
      ncm: it.ncm, unidade: it.unidade, cfop: it.cfopDevolucao,
      quantidade: qtdDev, valorUnitario: it.valorUnitario, vProd, vDesc, vFrete,
      icms, ipi, pis, cofins, ibsCbs,
    });
    tot.vProd = r2(tot.vProd + vProd); tot.vBC = r2(tot.vBC + vBCicms); tot.vICMS = r2(tot.vICMS + vICMS);
    tot.vBCST = r2(tot.vBCST + vBCST); tot.vST = r2(tot.vST + vST); tot.vIPI = r2(tot.vIPI + vIPI);
    tot.vPIS = r2(tot.vPIS + vPIS); tot.vCOFINS = r2(tot.vCOFINS + vCOFINS);
    tot.vDesc = r2(tot.vDesc + vDesc); tot.vFrete = r2(tot.vFrete + vFrete);
  }

  // vNF = produtos − desconto + frete + IPI + ICMS-ST (contador: IPI/ST entram no total).
  const vNF = r2(tot.vProd - tot.vDesc + tot.vFrete + tot.vIPI + tot.vST);
  const totais = {
    vBC: tot.vBC.toFixed(2), vICMS: tot.vICMS.toFixed(2), vBCST: tot.vBCST.toFixed(2), vST: tot.vST.toFixed(2),
    vProd: tot.vProd.toFixed(2), vFrete: tot.vFrete.toFixed(2), vSeg: '0.00', vDesc: tot.vDesc.toFixed(2), vII: '0.00',
    vIPI: tot.vIPI.toFixed(2), vPIS: tot.vPIS.toFixed(2), vCOFINS: tot.vCOFINS.toFixed(2),
    vOutro: '0.00', vNF: vNF.toFixed(2),
  };
  return { itens, totais };
}

module.exports = {
  tag, tagAll, num,
  parseImpostoItem, parseIbsCbsItem, parseEspelho,
  calcularImpostoEspelho,
  IPI_TRIBUTADO,
};
