/**
 * fiscal-tributacao.js — motor de tributação por regime.
 *
 * Antes deste módulo, a emissão montava imposto direto dentro de `emitirNFe`,
 * assumindo Simples Nacional: CSOSN do cadastro do produto e PIS/COFINS zerados.
 * Isso está CORRETO para Simples e não muda — mas não atende regime normal, que
 * precisa de CST de 2 dígitos, base, alíquota, redução de base e ST.
 *
 * O desenho segue o de ERPs maduros (referência: Solution ERP): a tributação é
 * RESOLVIDA por contexto — operação × produto/NCM × UF × perfil do destinatário —
 * a partir da matriz `fiscal_regras_trib`, e o resultado sai acompanhado da
 * memória de cálculo (que fórmula rodou, com que números).
 *
 * Fronteira: este módulo NÃO conhece node-sped-nfe nem banco de faturas. Recebe
 * um contexto puro, devolve números + tags prontas. Quem persiste é o chamador.
 */

const REGIME_PARA_CRT = {
  SIMPLES_NACIONAL: 1,
  SIMPLES_EXCESSO: 2,
  NAO_OPTANTE: 3,
  MEI: 4,
};

// CSTs de ICMS que exigem destaque do imposto próprio.
const CST_COM_ICMS_PROPRIO = new Set(['00', '10', '20', '51', '70', '90']);
// CSTs que carregam grupo de ST.
const CST_COM_ST = new Set(['10', '30', '70', '90']);
// CSTs desonerados (vICMSDeson + motivo).
const CST_DESONERADO = new Set(['40', '41', '50']);

function hojeBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function r2(n) { return Number((Number(n) || 0).toFixed(2)); }
function r4(n) { return Number((Number(n) || 0).toFixed(4)); }
function num(v, fb = 0) { const n = Number(v); return Number.isFinite(n) ? n : fb; }

/**
 * CRT do emitente. Lê `fornecedor.regimeTributario` — a mesma fonte que a entrada
 * de NF-e (crédito de ICMS) e a NFS-e já usam. Sem valor gravado, assume Simples:
 * é o que a emissão fazia fixo antes deste módulo, então tenant não configurado
 * continua emitindo exatamente como emitia.
 */
function crtDoEmitente(db, estabelecimentoId = null) {
  let regime = null;
  try {
    if (estabelecimentoId) {
      const e = db.prepare('SELECT regimeTributario FROM estabelecimentos WHERE id = ?').get(estabelecimentoId);
      regime = e && e.regimeTributario;
    }
    if (!regime) {
      const f = db.prepare('SELECT regimeTributario FROM fornecedor WHERE id = 1').get();
      regime = f && f.regimeTributario;
    }
  } catch { /* coluna/tabela ausente em tenant antigo */ }
  if (!regime) return 1;
  const chave = String(regime).trim().toUpperCase().replace(/[\s-]/g, '_');
  return REGIME_PARA_CRT[chave] || 1;
}

function ehSimples(crt) { return crt === 1 || crt === 2 || crt === 4; }

/**
 * Âmbito da operação a partir das UFs. 'exterior' quando o destino é EX.
 */
function ambitoDe(ufOrigem, ufDestino) {
  const o = String(ufOrigem || '').toUpperCase();
  const d = String(ufDestino || '').toUpperCase();
  if (d === 'EX') return 'exterior';
  if (!d || d === o) return 'interna';
  return 'interestadual';
}

/**
 * Resolve a regra aplicável. Campo de contexto NULL na regra = "qualquer".
 * Vence a mais específica (mais campos de contexto preenchidos); empate resolve
 * por prioridade e depois pelo id mais recente.
 *
 * O NCM casa por PREFIXO: regra com ncmPrefixo='3105' pega o NCM 31051000. É o
 * que permite tributar uma família inteira sem enumerar item a item.
 */
const CAMPOS_CONTEXTO = ['regimeEmitente', 'tipoOperacaoId', 'cfop', 'ncmPrefixo', 'produtoId',
  'ufOrigem', 'ufDestino', 'ambito', 'tipoContribuinte', 'consumidorFinal'];

/** Nº de campos de contexto preenchidos — é o critério primário de desempate. */
function especificidadeDe(regra) {
  return CAMPOS_CONTEXTO.reduce((n, c) =>
    n + (regra[c] === null || regra[c] === undefined ? 0 : 1), 0);
}

/**
 * Versão detalhada de `resolverRegra`: devolve a vencedora E o ranking completo
 * de candidatas. Existe para a tela de simulação poder mostrar POR QUE uma regra
 * ganhou — sem reimplementar o matching, que é onde uma cópia divergiria.
 */
function resolverRegraDetalhado(db, ctx) {
  let regras;
  try {
    regras = db.prepare(`
      SELECT * FROM fiscal_regras_trib
       WHERE ativo = 1
         AND (regimeEmitente   IS NULL OR regimeEmitente   = @crt)
         AND (tipoOperacaoId   IS NULL OR tipoOperacaoId   = @tipoOperacaoId)
         AND (cfop             IS NULL OR cfop             = @cfop)
         AND (produtoId        IS NULL OR produtoId        = @produtoId)
         AND (ufOrigem         IS NULL OR ufOrigem         = @ufOrigem)
         AND (ufDestino        IS NULL OR ufDestino        = @ufDestino)
         AND (ambito           IS NULL OR ambito           = @ambito)
         AND (tipoContribuinte IS NULL OR tipoContribuinte = @tipoContribuinte)
         AND (consumidorFinal  IS NULL OR consumidorFinal  = @consumidorFinal)
    `).all({
      crt: ctx.crt,
      tipoOperacaoId: ctx.tipoOperacaoId ?? null,
      cfop: ctx.cfop ?? null,
      produtoId: ctx.produtoId ?? null,
      ufOrigem: ctx.ufOrigem ?? null,
      ufDestino: ctx.ufDestino ?? null,
      ambito: ctx.ambito ?? null,
      tipoContribuinte: ctx.tipoContribuinte ?? null,
      consumidorFinal: ctx.consumidorFinal ?? null,
    });
  } catch {
    return { vencedora: null, candidatas: [] };  // tabela ainda não migrada — chamador cai no fallback
  }

  const ncm = String(ctx.ncm || '').replace(/\D/g, '');
  // Vigência (2026-08-25). NÃO existe emissão retroativa — o dhEmi do XML é
  // sempre o instante da transmissão, e a SEFAZ recusa data anterior. Então na
  // EMISSÃO a data de referência é sempre hoje, e a vigência serve a outra coisa:
  //   - agendar a virada: cadastrar hoje a alíquota que passa a valer em 01/01,
  //     sem depender de alguém lembrar de editar a regra na data;
  //   - aposentar regra: com fim de vigência ela sai de circulação sozinha;
  //   - consultar o passado: o simulador responde "qual era a alíquota em X";
  //   - e, adiante, os livros de apuração, que recalculam competência fechada.
  // Regra sem vigência gravada vale sempre — é o comportamento anterior.
  const dataRef = String(ctx.dataReferencia || '').slice(0, 10) || hojeBrasilia();
  const candidatas = regras.filter(r => {
    if (r.ncmPrefixo && !ncm.startsWith(String(r.ncmPrefixo).replace(/\D/g, ''))) return false;
    if (r.vigenciaInicio && dataRef < String(r.vigenciaInicio).slice(0, 10)) return false;
    if (r.vigenciaFim && dataRef > String(r.vigenciaFim).slice(0, 10)) return false;
    return true;
  });
  if (!candidatas.length) return { vencedora: null, candidatas: [] };

  candidatas.sort((a, b) => {
    const d = especificidadeDe(b) - especificidadeDe(a);
    if (d) return d;
    const p = num(b.prioridade) - num(a.prioridade);
    if (p) return p;
    // Empate real: a regra com vigência declarada vence a perene. Uma alíquota
    // publicada com data é sempre mais específica que "vale desde sempre".
    const vig = (r) => (r.vigenciaInicio ? 1 : 0);
    const v = vig(b) - vig(a);
    if (v) return v;
    // Entre duas vigentes, a de início mais recente é a que está em vigor.
    if (a.vigenciaInicio && b.vigenciaInicio && a.vigenciaInicio !== b.vigenciaInicio) {
      return String(b.vigenciaInicio).localeCompare(String(a.vigenciaInicio));
    }
    return b.id - a.id;
  });
  return {
    vencedora: candidatas[0],
    candidatas: candidatas.map(r => ({ regra: r, especificidade: especificidadeDe(r) })),
  };
}

/** A resolução como o motor a usa: só a regra vencedora, ou null. */
function resolverRegra(db, ctx) {
  return resolverRegraDetalhado(db, ctx).vencedora;
}

/**
 * Calcula os impostos de UM item.
 *
 * ctx: {
 *   crt, tipoOperacaoId, cfop, ncm, produtoId, ufOrigem, ufDestino,
 *   tipoContribuinte, consumidorFinal, origemProduto,
 *   vProd, vFrete, vDesc, vOutro,
 *   manual  // overrides digitados na nota (vencem a regra)
 * }
 *
 * Devolve { grupo, icms, st, ipi, pis, cofins, totais, memoria, regraId, origem }.
 */
function calcularItem(db, ctx) {
  const crt = ctx.crt || 1;
  const ambito = ctx.ambito || ambitoDe(ctx.ufOrigem, ctx.ufDestino);
  const regra = resolverRegra(db, { ...ctx, crt, ambito });
  const manual = ctx.manual || {};
  const temManual = Object.keys(manual).length > 0;

  // Precedência: override manual do item → regra da matriz → cadastro do produto/CFOP.
  const v = (campo, fallback = null) => {
    if (manual[campo] !== undefined && manual[campo] !== null && manual[campo] !== '') return manual[campo];
    if (regra && regra[campo] !== null && regra[campo] !== undefined) return regra[campo];
    return fallback;
  };

  const vProd = num(ctx.vProd);
  const vFrete = num(ctx.vFrete);
  const vDesc = num(ctx.vDesc);
  const vOutro = num(ctx.vOutro);
  const memoria = [];
  const registrar = (imposto, dados) => memoria.push({ imposto, ...dados });

  // Base da operação — a mesma composição que o Solution imprime na auditoria:
  // BASECALCULO: VALORPRODUTO + ACRESCIMOS - DESCONTOS + FRETEEMBUTIR
  const baseOperacao = r2(vProd + vFrete + vOutro - vDesc);
  const linhaBase = `BASECALCULO: VALORPRODUTO + ACRESCIMOS - DESCONTOS + FRETEEMBUTIR = ${baseOperacao.toFixed(2)}`;

  const orig = String(ctx.origemProduto ?? '0');
  const resultado = {
    grupo: ehSimples(crt) ? 'ICMSSN' : 'ICMS',
    regraId: regra ? regra.id : null,
    origem: temManual ? 'MANUAL' : 'CALCULADO',
    icms: null, st: null, ipi: null, pis: null, cofins: null,
    totais: { vBC: 0, vICMS: 0, vBCST: 0, vICMSST: 0, vFCP: 0, vIPI: 0, vPIS: 0, vCOFINS: 0, vICMSDeson: 0,
               vICMSUFDest: 0, vICMSUFRemet: 0, vFCPUFDest: 0 },
    memoria,
  };

  // ─── ICMS ──────────────────────────────────────────────────────────────────
  if (ehSimples(crt)) {
    // Simples Nacional: CSOSN, sem destaque de ICMS. Caminho idêntico ao que a
    // emissão fazia antes deste módulo — regressão zero para quem já emite.
    const csosn = String(v('csosnIcms', ctx.csosnFallback || '400')).trim();
    resultado.icms = { orig, CSOSN: csosn };
    if (csosn === '101' || csosn === '201') {
      const pCred = num(v('pIcms', 0));
      const vCred = r2(baseOperacao * pCred / 100);
      resultado.icms.pCredSN = pCred.toFixed(2);
      resultado.icms.vCredICMSSN = vCred.toFixed(2);
      registrar('ICMS', { cst: csosn, base: baseOperacao, aliquota: pCred, reducao: 0, valor: vCred,
        formula: [`CALCULANDO CREDITO SIMPLES NACIONAL`, linhaBase,
          `VALORCREDITO: BASECALCULO * PCREDSN / 100 = ${vCred.toFixed(2)}`].join('\n') });
    } else if (csosn === '500') {
      resultado.icms.vBCSTRet = '0.00'; resultado.icms.vICMSSTRet = '0.00';
      resultado.icms.vBCSTDest = '0.00'; resultado.icms.vICMSSTDest = '0.00';
      registrar('ICMS', { cst: csosn, base: 0, aliquota: 0, reducao: 0, valor: 0,
        formula: 'ICMS ST RETIDO ANTERIORMENTE — SEM NOVO DESTAQUE' });
    } else if (csosn === '900') {
      // 900 = "outros": aceita destaque. É por aqui que um Simples com ST ou com
      // permissão de crédito emite algo diferente de zero.
      const pIcms = num(v('pIcms', 0));
      const pRed = num(v('pRedBC', 0));
      const bc = r2(baseOperacao * (1 - pRed / 100));
      const vIcms = r2(bc * pIcms / 100);
      Object.assign(resultado.icms, {
        modBC: String(num(v('modBC', 3))), vBC: bc.toFixed(2), pRedBC: pRed.toFixed(2),
        pICMS: pIcms.toFixed(2), vICMS: vIcms.toFixed(2),
        modBCST: '0', pMVAST: '0.00', pRedBCST: '0.00', vBCST: '0.00', pICMSST: '0.00', vICMSST: '0.00',
        pCredSN: '0.00', vCredICMSSN: '0.00',
      });
      resultado.totais.vBC = bc; resultado.totais.vICMS = vIcms;
      registrar('ICMS', { cst: csosn, base: bc, aliquota: pIcms, reducao: pRed, valor: vIcms,
        formula: ['CALCULANDO ICMS SIMPLES — CSOSN 900', linhaBase,
          `BASECALCULO: BASECALCULO * (1 - (REDUCAOBASE / 100)) = ${bc.toFixed(2)}`,
          `VALORICMS: BASECALCULO * ALIQUOTA / 100 = ${vIcms.toFixed(2)}`].join('\n') });
    } else {
      // 102, 103, 300, 400 — sem permissão a crédito / isenta / imune / não tributada
      registrar('ICMS', { cst: csosn, base: 0, aliquota: 0, reducao: 0, valor: 0,
        formula: `SIMPLES NACIONAL — CSOSN ${csosn}: SEM DESTAQUE DE ICMS` });
    }
  } else {
    // Regime normal: CST de 2 dígitos. Sem regra na matriz não há como adivinhar
    // alíquota — falhar aqui é melhor que emitir nota com imposto errado calado.
    const cst = manual.cstIcms || (regra && regra.cstIcms);
    if (!cst) {
      throw new Error(
        `Sem regra tributária para o item (CFOP ${ctx.cfop || '?'}, NCM ${ctx.ncm || '?'}, ` +
        `destino ${ctx.ufDestino || '?'}). Cadastre a regra em Fiscal › Regras Tributárias ` +
        `ou informe o CST manualmente no item.`);
    }
    const cstN = String(cst).padStart(2, '0');
    resultado.icms = { orig, CST: cstN };

    if (CST_COM_ICMS_PROPRIO.has(cstN)) {
      const pIcms = num(v('pIcms', 0));
      const pRed = num(v('pRedBC', 0));
      const bc = r2(baseOperacao * (1 - pRed / 100));
      const vIcmsOp = r2(bc * pIcms / 100);
      const pDif = num(v('pDif', 0));
      const vDif = r2(vIcmsOp * pDif / 100);
      const vIcms = r2(vIcmsOp - vDif);

      // ORDEM IMPORTA: o XSD do ICMS é uma <xs:sequence>, e a lib serializa na
      // ordem de inserção das chaves. pRedBC vem ANTES de vBC — inverter isso
      // reprova no nfe_v4.00.xsd ("Element vBC: this element is not expected").
      resultado.icms.modBC = String(num(v('modBC', 3)));
      if (pRed > 0) resultado.icms.pRedBC = pRed.toFixed(2);
      resultado.icms.vBC = bc.toFixed(2);
      resultado.icms.pICMS = pIcms.toFixed(2);
      if (cstN === '51' && pDif > 0) {
        resultado.icms.vICMSOp = vIcmsOp.toFixed(2);
        resultado.icms.pDif = pDif.toFixed(2);
        resultado.icms.vICMSDif = vDif.toFixed(2);
      }
      resultado.icms.vICMS = vIcms.toFixed(2);
      resultado.totais.vBC = bc;
      resultado.totais.vICMS = vIcms;

      const passos = ['CALCULANDO ICMS PADRAO', `FORMACALCULO: ICMS NORMAL — CST ${cstN}`, linhaBase];
      if (pRed > 0) passos.push(`BASECALCULO: BASECALCULO * (1 - (REDUCAOBASE / 100)) = ${bc.toFixed(2)}`);
      passos.push(`VALORICMS: (BASECALCULO * ALIQUOTA) / 100 = ${vIcmsOp.toFixed(2)}`);
      if (pDif > 0) passos.push(`VALORDIFERIDO: VALORICMS * ${pDif.toFixed(2)} / 100 = ${vDif.toFixed(2)}`,
        `VALORICMS: VALORICMS - VALORDIFERIDO = ${vIcms.toFixed(2)}`);
      registrar('ICMS', { cst: cstN, base: bc, aliquota: pIcms, reducao: pRed, valor: vIcms, formula: passos.join('\n') });

      // FCP acompanha a base do ICMS próprio.
      const pFcp = num(v('pFCP', 0));
      if (pFcp > 0) {
        const vFcp = r2(bc * pFcp / 100);
        resultado.icms.vBCFCP = bc.toFixed(2);   // sequência do XSD: vBCFCP, pFCP, vFCP
        resultado.icms.pFCP = pFcp.toFixed(2);
        resultado.icms.vFCP = vFcp.toFixed(2);
        resultado.totais.vFCP = vFcp;
        registrar('FCP', { cst: cstN, base: bc, aliquota: pFcp, reducao: 0, valor: vFcp,
          formula: `VALORFCP: BASEICMS * ALIQUOTAFCP / 100 = ${vFcp.toFixed(2)}` });
      }
    } else if (CST_DESONERADO.has(cstN)) {
      const mot = v('motDesIcms', null);
      if (mot !== null) {
        resultado.icms.vICMSDeson = '0.00';
        resultado.icms.motDesICMS = String(mot);
      }
      registrar('ICMS', { cst: cstN, base: 0, aliquota: 0, reducao: 0, valor: 0,
        formula: `CST ${cstN}: OPERACAO ISENTA / NAO TRIBUTADA / SUSPENSA` });
    } else if (cstN === '60') {
      resultado.icms.vBCSTRet = '0.00';
      resultado.icms.vICMSSTRet = '0.00';
      registrar('ICMS', { cst: cstN, base: 0, aliquota: 0, reducao: 0, valor: 0,
        formula: 'CST 60: ICMS COBRADO ANTERIORMENTE POR SUBSTITUICAO TRIBUTARIA' });
    }

    // ─── ICMS ST ────────────────────────────────────────────────────────────
    if (CST_COM_ST.has(cstN)) {
      const pMVA = num(v('pMVAST', 0));
      const pIcmsST = num(v('pIcmsST', 0));
      if (pIcmsST > 0) {
        const pRedST = num(v('pRedBCST', 0));
        const baseST0 = r2(baseOperacao * (1 + pMVA / 100));
        const bcST = r2(baseST0 * (1 - pRedST / 100));
        const vST = r2(Math.max(0, bcST * pIcmsST / 100 - resultado.totais.vICMS));
        Object.assign(resultado.icms, {
          modBCST: String(num(v('modBCST', 4))),
          pMVAST: pMVA.toFixed(2),
          ...(pRedST > 0 ? { pRedBCST: pRedST.toFixed(2) } : {}),
          vBCST: bcST.toFixed(2),
          pICMSST: pIcmsST.toFixed(2),
          vICMSST: vST.toFixed(2),
        });
        resultado.totais.vBCST = bcST;
        resultado.totais.vICMSST = vST;
        registrar('ICMSST', { cst: cstN, base: bcST, aliquota: pIcmsST, reducao: pRedST, valor: vST,
          formula: ['CALCULANDO ICMS ST', linhaBase,
            `BASEST: BASECALCULO * (1 + (MVA / 100)) = ${baseST0.toFixed(2)}`,
            ...(pRedST > 0 ? [`BASEST: BASEST * (1 - (REDUCAOBASEST / 100)) = ${bcST.toFixed(2)}`] : []),
            `VALORST: (BASEST * ALIQUOTAST / 100) - VALORICMS = ${vST.toFixed(2)}`].join('\n') });
      }
    }
  }

  // ─── IPI ───────────────────────────────────────────────────────────────────
  const cstIpi = v('cstIpi', null);
  if (cstIpi) {
    const cstIpiN = String(cstIpi).padStart(2, '0');
    const pIpi = num(v('pIpi', 0));
    // CSTs tributados levam base/alíquota; o resto é só o código (IPINT).
    if (['00', '49', '50', '99'].includes(cstIpiN) && pIpi > 0) {
      const vIpi = r2(baseOperacao * pIpi / 100);
      resultado.ipi = { cEnq: '999', CST: cstIpiN, vBC: baseOperacao.toFixed(2), pIPI: pIpi.toFixed(2), vIPI: vIpi.toFixed(2) };
      resultado.totais.vIPI = vIpi;
      registrar('IPI', { cst: cstIpiN, base: baseOperacao, aliquota: pIpi, reducao: 0, valor: vIpi,
        formula: `VALORIPI: BASECALCULO * ALIQUOTAIPI / 100 = ${vIpi.toFixed(2)}` });
    } else {
      resultado.ipi = { cEnq: '999', CST: cstIpiN };
      registrar('IPI', { cst: cstIpiN, base: 0, aliquota: 0, reducao: 0, valor: 0,
        formula: `CST IPI ${cstIpiN}: SEM DESTAQUE` });
    }
  }

  // ─── PIS / COFINS ──────────────────────────────────────────────────────────
  // No Simples saem zerados com CST 49 (o que a emissão já fazia). No regime
  // normal, alíquota vinda da regra produz destaque real.
  for (const [nome, campoCst, campoAliq, chaveP, chaveV] of [
    ['PIS', 'cstPis', 'pPis', 'pPIS', 'vPIS'],
    ['COFINS', 'cstCofins', 'pCofins', 'pCOFINS', 'vCOFINS'],
  ]) {
    const cst = String(v(campoCst, ctx[`${campoCst}Fallback`] || '49')).trim();
    const aliq = num(v(campoAliq, 0));
    const base = aliq > 0 ? baseOperacao : 0;
    const valor = r2(base * aliq / 100);
    const tag = { CST: cst, vBC: base.toFixed(2), [chaveP]: aliq.toFixed(2), [chaveV]: valor.toFixed(2) };
    if (nome === 'PIS') { resultado.pis = tag; resultado.totais.vPIS = valor; }
    else { resultado.cofins = tag; resultado.totais.vCOFINS = valor; }
    registrar(nome, { cst, base, aliquota: aliq, reducao: 0, valor,
      formula: aliq > 0
        ? `VALOR${nome}: BASECALCULO * ALIQUOTA / 100 = ${valor.toFixed(2)}`
        : `CST ${cst}: SEM DESTAQUE DE ${nome}` });
  }

  // ─── DIFAL — partilha da EC 87/2015 ────────────────────────────────────────
  // Devido na venda INTERESTADUAL a NÃO contribuinte de ICMS. Desde 2019 a
  // partilha é 100% para a UF de destino, então não há mais rateio a fazer:
  // o remetente recolhe a diferença inteira para o destino.
  //
  // Não se aplica ao Simples Nacional: o STF (ADI 5464) suspendeu a cobrança
  // de DIFAL de optante, e a LC 190/2022 manteve a exclusão.
  if (!ehSimples(crt) && ambito === 'interestadual' && ctx.consumidorFinal === 1
      && ctx.tipoContribuinte === 'nao_contribuinte') {
    const difal = calcularDifal(db, {
      ufDestino: ctx.ufDestino,
      baseOperacao,
      pIcmsInter: num(v('pIcms', 0)),
      pFcpRegra: regra && regra.pFcpUFDest != null ? num(regra.pFcpUFDest) : null,
    });
    if (difal.erro) {
      resultado.difalErro = difal.erro;
      registrar('DIFAL', { cst: null, base: baseOperacao, aliquota: 0, reducao: 0, valor: 0,
        formula: `DIFAL NAO CALCULADO: ${difal.erro}` });
    } else if (difal.tags) {
      resultado.icmsUFDest = difal.tags;
      resultado.totais.vICMSUFDest = difal.vICMSUFDest;
      resultado.totais.vICMSUFRemet = difal.vICMSUFRemet;
      resultado.totais.vFCPUFDest = difal.vFCPUFDest;
      registrar('DIFAL', { cst: null, base: baseOperacao, aliquota: difal.pIcmsUFDest,
        reducao: 0, valor: difal.vICMSUFDest, formula: difal.formula });
    }
  }

  if (regra && regra.observacaoFiscal) resultado.observacaoFiscal = regra.observacaoFiscal;
  if (regra && regra.codBenef) resultado.codBenef = String(regra.codBenef).trim();
  if (manual.codBenef) resultado.codBenef = String(manual.codBenef).trim();
  return resultado;
}

/**
 * DIFAL da EC 87/2015.
 *
 * A alíquota INTERNA da UF de destino não pode ser deduzida do cadastro do
 * emitente — é uma informação da outra UF. Vem de `fiscal_aliquotas_uf`, que
 * nasce vazia de propósito: sem o valor cadastrado o cálculo NÃO acontece e o
 * chamador recebe o motivo. Chutar alíquota aqui produziria imposto errado
 * numa nota autorizada, que é o pior desfecho possível.
 */
function calcularDifal(db, { ufDestino, baseOperacao, pIcmsInter, pFcpRegra }) {
  const uf = String(ufDestino || '').toUpperCase();
  if (!uf) return { erro: 'UF de destino não informada' };

  let linha = null;
  try {
    linha = db.prepare('SELECT aliquotaInterna, pFcp FROM fiscal_aliquotas_uf WHERE uf = ?').get(uf);
  } catch { return { erro: 'tabela de alíquotas por UF ainda não migrada' }; }

  if (!linha || linha.aliquotaInterna == null) {
    return { erro: `alíquota interna de ${uf} não cadastrada em Fiscal › Alíquotas por UF` };
  }
  const pInterna = num(linha.aliquotaInterna);
  const pInter = num(pIcmsInter);
  if (!(pInterna > 0)) return { erro: `alíquota interna de ${uf} está zerada` };
  if (pInterna <= pInter) {
    // Sem diferença a partilhar — não é erro, apenas não há DIFAL.
    return { tags: null, vICMSUFDest: 0, vICMSUFRemet: 0, vFCPUFDest: 0 };
  }

  const pFcp = pFcpRegra != null ? pFcpRegra : num(linha.pFcp);
  const vDif = r2(baseOperacao * (pInterna - pInter) / 100);
  const vFcp = pFcp > 0 ? r2(baseOperacao * pFcp / 100) : 0;

  // Ordem do XSD em ICMSUFDest: vBCUFDest, vBCFCPUFDest, pFCPUFDest,
  // pICMSUFDest, pICMSInter, pICMSInterPart, vFCPUFDest, vICMSUFDest, vICMSUFRemet.
  const tags = { vBCUFDest: baseOperacao.toFixed(2) };
  if (pFcp > 0) {
    tags.vBCFCPUFDest = baseOperacao.toFixed(2);
    tags.pFCPUFDest = pFcp.toFixed(2);
  }
  tags.pICMSUFDest = pInterna.toFixed(2);
  tags.pICMSInter = pInter.toFixed(2);
  tags.pICMSInterPart = '100.00';   // 100% ao destino desde 2019
  if (pFcp > 0) tags.vFCPUFDest = vFcp.toFixed(2);
  tags.vICMSUFDest = vDif.toFixed(2);
  tags.vICMSUFRemet = '0.00';

  const passos = [
    'CALCULANDO DIFAL — EC 87/2015 (venda interestadual a nao contribuinte)',
    `BASECALCULO: ${baseOperacao.toFixed(2)}`,
    `ALIQUOTAS: interna ${uf} ${pInterna.toFixed(2)} - interestadual ${pInter.toFixed(2)}`,
    `VALORDIFAL: BASECALCULO * (ALIQINTERNA - ALIQINTER) / 100 = ${vDif.toFixed(2)}`,
    'PARTILHA: 100% PARA A UF DE DESTINO (desde 2019)',
  ];
  if (pFcp > 0) passos.push(`VALORFCP: BASECALCULO * ${pFcp.toFixed(2)} / 100 = ${vFcp.toFixed(2)}`);

  return {
    tags, vICMSUFDest: vDif, vICMSUFRemet: 0, vFCPUFDest: vFcp,
    pIcmsUFDest: pInterna, formula: passos.join('\n'),
  };
}

/**
 * Grava a memória de cálculo de um item. Apaga a anterior do mesmo item — recalcular
 * substitui, não acumula.
 */
function gravarMemoria(db, { documento = 'fatura', documentoId, itemId, resultado }) {
  db.prepare('DELETE FROM fiscal_calculo_memoria WHERE documento = ? AND documentoId = ? AND itemId IS ?')
    .run(documento, documentoId, itemId ?? null);
  const ins = db.prepare(`
    INSERT INTO fiscal_calculo_memoria
      (documento, documentoId, itemId, imposto, origem, regraId, cst, base, aliquota, reducao, valor, formula)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const m of resultado.memoria) {
    ins.run(documento, documentoId, itemId ?? null, m.imposto, resultado.origem, resultado.regraId,
      m.cst ?? null, r2(m.base), r4(m.aliquota), r4(m.reducao), r2(m.valor), m.formula || null);
  }
}

module.exports = {
  crtDoEmitente, ehSimples, ambitoDe, resolverRegra, resolverRegraDetalhado,
  especificidadeDe, calcularItem, gravarMemoria, calcularDifal, hojeBrasilia,
  REGIME_PARA_CRT, CAMPOS_CONTEXTO,
};
