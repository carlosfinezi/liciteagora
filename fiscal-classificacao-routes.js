// fiscal-classificacao-routes.js (2026-07-09)
//
// Módulo "Classificação Fiscal" — assistente de NCM/CEST com busca trigram e
// sugestão por IA (RAG). Caminho (c): entrega classificação sólida (NCM+CEST
// oficiais) e sugere CST; ICMS-ST/MVA NÃO é garantido — sempre com ressalva de
// que depende do estado/operação (não competimos de frente com IOB/Econet no ST).
//
// Dados no Postgres (catalog-pg), populados por scripts/import-fiscal-classificacao.js:
//   fiscal_ncm, fiscal_cest, fiscal_classificacao_cache
//
// Endpoints:
//   GET  /api/fiscal/ncm/busca?q=texto&limit=20   -> NCMs candidatos rankeados + CEST
//   GET  /api/fiscal/ncm/:codigo                   -> detalhe de um NCM + CEST
//   GET  /api/fiscal/cest?ncm=codigo               -> CEST por prefixo mais longo
//   POST /api/fiscal/classificacao/sugerir         -> RAG: produto em texto -> NCM+CEST+CST+confiança

'use strict';

const crypto = require('crypto');
const catalogPg = require('./catalog-pg');
const { chamarDeepSeek } = require('./analise-ia');
const { createConfigHelpers } = require('./config-helpers');

const normalizar = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

// Caminho (c): ST/MVA e CFOP nunca são garantidos — ressalva sempre presente.
const RESSALVA_ST = 'ICMS-ST, MVA e alíquotas dependem do estado (UF) e da operação. Confirme na legislação estadual / Convênio ICMS 142/2018 antes de emitir.';
const RESSALVA_CFOP = 'CFOP depende da operação (finalidade, destino, contribuinte). Use /api/cfops/sugerir com o contexto da operação.';

// --------------------------------------------------------- consultas de dados

// Busca folhas de NCM por texto livre. Recall via OR dos termos (>=3 letras) na
// descrição-caminho; ranqueia por word_similarity (mede quão bem a query casa um
// trecho do texto longo). unaccent nos dois lados -> robusto a acentos ("aco"~"aço",
// "inox"~"inoxidáveis").
async function buscarNcm(qRaw, limit) {
  const q = normalizar(qRaw);
  if (!q) return [];
  const termos = q.split(' ').filter((t) => t.length >= 3);
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);

  // $1 = query (word_similarity). Termos (ou a query inteira se todos forem curtos).
  const params = [q];
  const alvos = termos.length ? termos : [q];
  const conds = alvos.map((t) => {
    params.push(`%${t}%`);
    return `unaccent(LOWER(descricao_caminho)) LIKE unaccent($${params.length})`;
  });
  params.push(lim);

  return catalogPg.query(
    `SELECT codigo, codigo_fmt, descricao, descricao_caminho,
            word_similarity(unaccent($1), unaccent(descricao_caminho)) AS score
       FROM fiscal_ncm
      WHERE folha AND (${conds.join(' OR ')})
      ORDER BY score DESC, codigo ASC
      LIMIT $${params.length}`,
    params
  );
}

// CEST cujos ncm_prefix são prefixo do NCM dado (mais longo = mais específico).
async function cestPorNcm(codigo) {
  const ncm = soDigitos(codigo);
  if (!ncm) return [];
  return catalogPg.query(
    `SELECT cest, ncm_prefix, descricao
       FROM fiscal_cest
      WHERE $1 LIKE ncm_prefix || '%'
      ORDER BY length(ncm_prefix) DESC, cest ASC`,
    [ncm]
  );
}

async function ncmPorCodigo(codigo) {
  return catalogPg.queryOne(
    'SELECT codigo, codigo_fmt, descricao, descricao_caminho, nivel, folha, vigente FROM fiscal_ncm WHERE codigo = $1',
    [soDigitos(codigo)]
  );
}

const UF_PADRAO = 'SP';
const UFS = new Set(['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO']);
const normUf = (uf) => { const u = String(uf || '').toUpperCase().trim(); return UFS.has(u) ? u : UF_PADRAO; };

// Impostos aplicáveis ao NCM:
//   - ipi (TIPI) e ii (TEC): alíquotas legais OFICIAIS.
//   - icms: alíquota interna por UF (FCP embutido).
//   - pis_cofins: regime especial por NCM (monofásico/ST/alíq. zero) — SPED + comunidade.
// ICMS-ST/MVA (por CEST×UF) ainda em estruturação (scraper CONFAZ).
async function impostosPorNcm(codigo, ufRaw) {
  const cod = soDigitos(codigo);
  if (cod.length !== 8) return null;
  const uf = normUf(ufRaw);
  const [ipi, ii, icms, pc, cests, ben] = await Promise.all([
    catalogPg.queryOne('SELECT aliquota, nt FROM fiscal_ipi WHERE ncm=$1', [cod]),
    catalogPg.queryOne('SELECT aliquota FROM fiscal_ii WHERE ncm=$1', [cod]),
    catalogPg.queryOne('SELECT aliquota_interna, fcp_incluido FROM fiscal_icms_uf WHERE uf=$1', [uf]),
    catalogPg.queryOne('SELECT regime, pis_aliquota, cofins_aliquota, fundamentacao, tabela_origem FROM fiscal_pis_cofins WHERE ncm=$1', [cod]),
    cestPorNcm(cod), // CESTs do NCM, mais específico (prefixo mais longo) primeiro
    catalogPg.queryOne('SELECT tipo, descricao, credito_pontos, aliquota_base, carga_efetiva, fundamentacao, observacao FROM fiscal_beneficio_pa WHERE ncm=$1 AND uf=$2', [cod, uf]),
  ]);

  // ICMS-ST por CEST × UF (Fase C — CONFAZ). Pega o 1º CEST que tenha registro na UF.
  let icms_st = null;
  for (const c of cests) {
    const st = await catalogPg.queryOne(
      'SELECT tem_st, mva_original, aliquota_interna, ato, segmento FROM fiscal_icms_st WHERE cest=$1 AND uf=$2', [c.cest, uf]);
    if (st) {
      icms_st = {
        cest: c.cest, cest_fmt: fmtCest(c.cest), segmento: st.segmento, tem_st: st.tem_st,
        mva_original: st.mva_original == null ? null : Number(st.mva_original),
        aliquota_interna: st.aliquota_interna == null ? null : Number(st.aliquota_interna),
        ato: st.ato, fonte: 'CONFAZ Portal Nacional ST',
      };
      break;
    }
  }

  return {
    uf,
    ipi: ipi ? (ipi.nt ? { nt: true } : { aliquota: Number(ipi.aliquota) }) : null,
    ii: ii ? { aliquota: Number(ii.aliquota) } : null,
    icms: icms ? { aliquota_interna: Number(icms.aliquota_interna), fcp_incluido: icms.fcp_incluido } : null,
    pis_cofins: pc
      ? { regime: pc.regime, pis: pc.pis_aliquota == null ? null : Number(pc.pis_aliquota), cofins: pc.cofins_aliquota == null ? null : Number(pc.cofins_aliquota), fundamentacao: pc.fundamentacao, fonte: pc.tabela_origem }
      : { regime: 'normal', pis: null, cofins: null }, // ausente = regime normal (sem regime especial)
    icms_st, // null = UF sem planilha (ex.: PA) ou CEST sem ST cadastrado
    // benefício fiscal estadual (só PA por ora: cesta básica). Reduz a carga de ICMS.
    beneficio: ben ? {
      tipo: ben.tipo, descricao: ben.descricao,
      credito_pontos: ben.credito_pontos == null ? null : Number(ben.credito_pontos),
      aliquota_base: ben.aliquota_base == null ? null : Number(ben.aliquota_base),
      carga_efetiva: ben.carga_efetiva == null ? null : Number(ben.carga_efetiva),
      // redução vs. alíquota interna vigente da UF (ex.: 19% no PA)
      reducao_pp: (icms && ben.carga_efetiva != null) ? Number((Number(icms.aliquota_interna) - Number(ben.carga_efetiva)).toFixed(2)) : null,
      fundamentacao: ben.fundamentacao, observacao: ben.observacao,
    } : null,
    obs: 'IPI/II oficiais; ICMS interno por UF (FCP embutido); PIS/COFINS = regime especial; ICMS-ST/MVA da planilha CONFAZ (só 8 UFs). Confirme conforme a operação.',
  };
}

// formata CEST "0100100" -> "01.001.00" e NCM "01012100" -> "0101.21.00"
const fmtCest = (c) => String(c || '').replace(/^(\d{2})(\d{3})(\d{2})$/, '$1.$2.$3');
const fmtNcm = (c) => String(c || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3');

// folhas válidas sob o mesmo prefixo (subposição de 6 díg, senão posição de 4).
async function folhasIrmas(codigo) {
  const ncm = soDigitos(codigo);
  for (const len of [6, 4]) {
    if (ncm.length <= len) continue;
    const rows = await catalogPg.query(
      'SELECT codigo, codigo_fmt, descricao_caminho FROM fiscal_ncm WHERE folha AND codigo LIKE $1 ORDER BY codigo LIMIT 8',
      [ncm.slice(0, len) + '%']
    );
    if (rows.length) return rows.map((r) => ({ ncm: r.codigo, ncm_fmt: r.codigo_fmt, descricao: r.descricao_caminho }));
  }
  return [];
}

// --------------------------------------------------------- sugestão por IA

function montarPrompt(produto, candidatos) {
  const lista = candidatos
    .map((c) => `- ${c.codigo} | ${c.descricao_caminho}`)
    .join('\n');
  return `Você é um classificador fiscal brasileiro especialista em NCM (Nomenclatura Comum do Mercosul).
Dada a descrição de um produto e uma lista de NCMs candidatos (código de 8 dígitos + hierarquia), escolha o NCM mais adequado.

PRODUTO: "${produto}"

CANDIDATOS:
${lista}

Regras:
- Prefira SEMPRE um dos códigos candidatos acima quando algum for adequado (copie os 8 dígitos exatamente, sem pontos).
- Se NENHUM candidato servir (a busca pode ter falhado por vocabulário), indique o NCM de 8 dígitos CORRETO pelo seu conhecimento técnico de classificação fiscal. Nesse caso marque confianca no máximo "media".
- Justifique citando a lógica de classificação (capítulo/posição), não invente norma.

Responda SOMENTE com JSON válido neste formato:
{
  "ncm": "8 dígitos sem pontos",
  "confianca": "alta" | "media" | "baixa",
  "justificativa": "1 a 2 frases objetivas",
  "cst_icms_sugerido": "código CST (3 díg) ou CSOSN, típico para o produto, ou null se não souber"
}`;
}

async function sugerir(db, produtoRaw) {
  const produto = String(produtoRaw || '').trim();
  if (!produto) return { erro: 'produto vazio' };

  const hash = crypto.createHash('sha1').update(normalizar(produto)).digest('hex');

  // cache compartilhado (classificação independe de tenant)
  const cached = await catalogPg.queryOne(
    'SELECT resultado FROM fiscal_classificacao_cache WHERE texto_hash = $1',
    [hash]
  );
  if (cached) return { ...cached.resultado, cache: true };

  const candidatos = await buscarNcm(produto, 15);
  if (!candidatos.length) {
    return { erro: 'nenhum NCM candidato encontrado para o texto informado', candidatos: [] };
  }

  const { getIAKeys } = createConfigHelpers(db);
  const keys = getIAKeys();
  if (!keys || !keys.deepseek) {
    // sem IA configurada: devolve os candidatos da busca como fallback
    return {
      erro: 'IA não configurada (deepseek_api_key ausente) — retornando candidatos da busca',
      candidatos: candidatos.slice(0, 5).map((c) => ({ ncm: c.codigo, ncm_fmt: c.codigo_fmt, descricao: c.descricao_caminho })),
    };
  }

  const ia = await chamarDeepSeek(keys.deepseek, montarPrompt(produto, candidatos));
  if (!ia || !ia.ncm) {
    return { erro: 'IA não retornou classificação', candidatos: candidatos.slice(0, 5).map((c) => ({ ncm: c.codigo, ncm_fmt: c.codigo_fmt, descricao: c.descricao_caminho })) };
  }

  const ncmEscolhido = soDigitos(ia.ncm);
  const ncmRow = await ncmPorCodigo(ncmEscolhido);
  const cests = await cestPorNcm(ncmEscolhido);
  const veioDeCandidato = candidatos.some((c) => c.codigo === ncmEscolhido);

  // NCM fora da base vigente (IA costuma citar código de tabela antiga): rebaixa e oferece irmãs.
  const alternativas = ncmRow ? [] : await folhasIrmas(ncmEscolhido);

  const resultado = {
    produto,
    ncm: ncmEscolhido,
    ncm_fmt: ncmRow?.codigo_fmt || fmtNcm(ncmEscolhido),
    ncm_descricao: ncmRow?.descricao_caminho || null,
    ncm_valido: !!ncmRow,           // false = IA devolveu código fora da base (não confiar)
    fonte: veioDeCandidato ? 'busca' : 'conhecimento_ia', // conhecimento_ia = fora da lista, validado na base
    confianca: ncmRow ? (ia.confianca || 'baixa') : 'baixa',
    justificativa: ia.justificativa || null,
    ...(ncmRow ? {} : { aviso: 'Código sugerido pela IA não consta na base NCM vigente (provável código de tabela antiga). Confirme entre as alternativas.', alternativas }),
    cst_icms_sugerido: ia.cst_icms_sugerido || null,
    cest: cests.map((c) => ({ cest: c.cest, cest_fmt: fmtCest(c.cest), ncm_prefix: c.ncm_prefix, descricao: c.descricao })),
    ressalva_st: RESSALVA_ST,
    ressalva_cfop: RESSALVA_CFOP,
  };

  // grava cache só quando a classificação é confiável (NCM existe na base)
  if (ncmRow) {
    await catalogPg.execute(
      `INSERT INTO fiscal_classificacao_cache (texto_hash, texto, resultado)
       VALUES ($1, $2, $3) ON CONFLICT (texto_hash) DO UPDATE SET resultado = EXCLUDED.resultado, criado_em = now()`,
      [hash, produto, JSON.stringify(resultado)]
    );
  }
  return resultado;
}

// --------------------------------------------------------- lote / código direto

// Classifica UMA entrada. Se for um código NCM de 8 dígitos -> lookup exato na
// base (sem IA, de graça). Senão -> descrição -> sugestão por IA.
async function classificarUm(db, entradaRaw) {
  const entrada = String(entradaRaw || '').trim();
  if (!entrada) return { entrada, erro: 'vazio' };
  const dig = soDigitos(entrada);

  if (dig.length === 8 && /^[\d.\s]+$/.test(entrada)) {
    const row = await ncmPorCodigo(dig);
    const cests = await cestPorNcm(dig);
    if (row) {
      return {
        entrada, produto: entrada, ncm: dig, ncm_fmt: row.codigo_fmt,
        ncm_descricao: row.descricao_caminho, ncm_valido: true,
        fonte: 'codigo', confianca: 'exato', cst_icms_sugerido: null,
        cest: cests.map((c) => ({ cest: c.cest, cest_fmt: fmtCest(c.cest), ncm_prefix: c.ncm_prefix, descricao: c.descricao })),
        ressalva_st: RESSALVA_ST, ressalva_cfop: RESSALVA_CFOP,
      };
    }
    return {
      entrada, produto: entrada, ncm: dig, ncm_fmt: fmtNcm(dig), ncm_valido: false,
      fonte: 'codigo', confianca: 'baixa', cest: [],
      aviso: 'Código NCM não consta na base vigente (provável tabela antiga).',
      alternativas: await folhasIrmas(dig),
    };
  }

  return { entrada, ...(await sugerir(db, entrada)) };
}

// Lote: dedup por chave normalizada (reusa cache dentro do arquivo), cap 100,
// processa sequencial — respeita o rate-limit da IA (aguardarGapProvider).
async function classificarLote(db, itens) {
  const lista = (Array.isArray(itens) ? itens : []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!lista.length) return { erro: 'lista vazia' };
  if (lista.length > 100) return { erro: `lote de ${lista.length} itens excede o limite de 100 por requisição — divida em partes` };

  const memo = new Map();
  const resultados = [];
  for (const entrada of lista) {
    const chave = normalizar(entrada);
    if (!memo.has(chave)) memo.set(chave, await classificarUm(db, entrada));
    resultados.push(memo.get(chave));
  }
  return { resultados };
}

// --------------------------------------------------------- relatórios (tabelas navegáveis)
// Catálogo whitelisted das tabelas fiscais importadas. base/select/ordem e o `sql` de
// cada coluna são strings de CONFIG (nunca entrada do usuário). Cada coluna traz:
//   c=chave/alias · l=rótulo · t=tipo de exibição · sql=expressão p/ WHERE · f=tipo de filtro
const RELATORIOS = {
  ipi: {
    titulo: 'IPI por NCM (TIPI)', base: 'fiscal_ipi t JOIN fiscal_ncm n ON n.codigo=t.ncm',
    select: 'n.codigo_fmt AS ncm, n.descricao_caminho AS descricao, t.aliquota, t.nt',
    busca: [{ col: 't.ncm', tipo: 'ncm' }, { col: 'n.descricao_caminho', tipo: 'texto' }], ordem: 't.ncm',
    colunas: [
      { c: 'ncm', l: 'NCM', sql: 't.ncm', f: 'ncm' },
      { c: 'descricao', l: 'Descrição', sql: 'n.descricao_caminho', f: 'texto' },
      { c: 'aliquota', l: 'IPI %', t: 'pct', sql: 't.aliquota', f: 'num' },
      { c: 'nt', l: 'NT', t: 'bool', sql: 't.nt', f: 'bool' },
    ],
  },
  ii: {
    titulo: 'Imposto de Importação (II/TEC) por NCM', base: 'fiscal_ii t JOIN fiscal_ncm n ON n.codigo=t.ncm',
    select: 'n.codigo_fmt AS ncm, n.descricao_caminho AS descricao, t.aliquota',
    busca: [{ col: 't.ncm', tipo: 'ncm' }, { col: 'n.descricao_caminho', tipo: 'texto' }], ordem: 't.ncm',
    colunas: [
      { c: 'ncm', l: 'NCM', sql: 't.ncm', f: 'ncm' },
      { c: 'descricao', l: 'Descrição', sql: 'n.descricao_caminho', f: 'texto' },
      { c: 'aliquota', l: 'II %', t: 'pct', sql: 't.aliquota', f: 'num' },
    ],
  },
  pis_cofins: {
    titulo: 'PIS/COFINS (regime especial) por NCM', base: 'fiscal_pis_cofins t JOIN fiscal_ncm n ON n.codigo=t.ncm',
    select: 'n.codigo_fmt AS ncm, n.descricao_caminho AS descricao, t.regime, t.pis_aliquota AS pis, t.cofins_aliquota AS cofins',
    busca: [{ col: 't.ncm', tipo: 'ncm' }, { col: 'n.descricao_caminho', tipo: 'texto' }], ordem: 't.ncm',
    colunas: [
      { c: 'ncm', l: 'NCM', sql: 't.ncm', f: 'ncm' },
      { c: 'descricao', l: 'Descrição', sql: 'n.descricao_caminho', f: 'texto' },
      { c: 'regime', l: 'Regime', sql: 't.regime', f: 'texto' },
      { c: 'pis', l: 'PIS %', t: 'pct', sql: 't.pis_aliquota', f: 'num' },
      { c: 'cofins', l: 'COFINS %', t: 'pct', sql: 't.cofins_aliquota', f: 'num' },
    ],
  },
  icms_st: {
    titulo: 'ICMS-ST / MVA por CEST × UF', base: 'fiscal_icms_st t',
    select: 't.cest, t.uf, t.segmento, t.descricao, t.mva_original, t.aliquota_interna, t.tem_st',
    busca: [{ col: 't.cest', tipo: 'ncm' }, { col: 't.descricao', tipo: 'texto' }, { col: 't.segmento', tipo: 'texto' }], ordem: 't.uf, t.cest',
    colunas: [
      { c: 'cest', l: 'CEST', t: 'cest', sql: 't.cest', f: 'ncm' },
      { c: 'uf', l: 'UF', sql: 't.uf', f: 'texto' },
      { c: 'segmento', l: 'Segmento', sql: 't.segmento', f: 'texto' },
      { c: 'descricao', l: 'Descrição', sql: 't.descricao', f: 'texto' },
      { c: 'mva_original', l: 'MVA %', t: 'pct', sql: 't.mva_original', f: 'num' },
      { c: 'aliquota_interna', l: 'Alíq. int. %', t: 'pct', sql: 't.aliquota_interna', f: 'num' },
      { c: 'tem_st', l: 'ST', t: 'bool', sql: 't.tem_st', f: 'bool' },
    ],
  },
  beneficio_pa: {
    titulo: 'Benefícios fiscais do Pará por NCM', base: 'fiscal_beneficio_pa t JOIN fiscal_ncm n ON n.codigo=t.ncm',
    select: 'n.codigo_fmt AS ncm, n.descricao_caminho AS descricao, t.tipo, t.carga_efetiva',
    busca: [{ col: 't.ncm', tipo: 'ncm' }, { col: 'n.descricao_caminho', tipo: 'texto' }, { col: 't.descricao', tipo: 'texto' }], ordem: 't.tipo, t.ncm',
    colunas: [
      { c: 'ncm', l: 'NCM', sql: 't.ncm', f: 'ncm' },
      { c: 'descricao', l: 'Descrição', sql: 'n.descricao_caminho', f: 'texto' },
      { c: 'tipo', l: 'Tipo', sql: 't.tipo', f: 'texto' },
      { c: 'carga_efetiva', l: 'Carga efetiva %', t: 'pct', sql: 't.carga_efetiva', f: 'num' },
    ],
  },
  icms_uf: {
    titulo: 'ICMS interno por UF', base: 'fiscal_icms_uf t',
    select: 't.uf, t.aliquota_interna, t.fcp_incluido', busca: [{ col: 't.uf', tipo: 'texto' }], ordem: 't.uf',
    colunas: [
      { c: 'uf', l: 'UF', sql: 't.uf', f: 'texto' },
      { c: 'aliquota_interna', l: 'ICMS interno %', t: 'pct', sql: 't.aliquota_interna', f: 'num' },
      { c: 'fcp_incluido', l: 'FCP incluído', t: 'bool', sql: 't.fcp_incluido', f: 'bool' },
    ],
  },
  cest: {
    titulo: 'CEST ↔ NCM', base: 'fiscal_cest t',
    select: 't.cest, t.ncm_prefix, t.descricao', busca: [{ col: 't.cest', tipo: 'ncm' }, { col: 't.ncm_prefix', tipo: 'ncm' }, { col: 't.descricao', tipo: 'texto' }], ordem: 't.cest',
    colunas: [
      { c: 'cest', l: 'CEST', t: 'cest', sql: 't.cest', f: 'ncm' },
      { c: 'ncm_prefix', l: 'NCM (prefixo)', sql: 't.ncm_prefix', f: 'ncm' },
      { c: 'descricao', l: 'Descrição', sql: 't.descricao', f: 'texto' },
    ],
  },
};

function construirRelatorio(rel, query) {
  const params = [];
  const conds = [];
  const byC = Object.fromEntries(rel.colunas.map((c) => [c.c, c]));
  // busca global (q) sobre as colunas de busca
  const q = String(query.q || '').trim();
  if (q) {
    const or = [];
    for (const b of rel.busca) {
      if (b.tipo === 'ncm') { params.push(soDigitos(q) + '%'); or.push(`${b.col} LIKE $${params.length}`); }
      else { params.push('%' + q.toLowerCase() + '%'); or.push(`unaccent(LOWER(${b.col})) LIKE unaccent($${params.length})`); }
    }
    if (or.length) conds.push('(' + or.join(' OR ') + ')');
  }
  // filtros POR COLUNA: params col_<c>. Só colunas whitelisted (com sql+f).
  for (const [k, raw] of Object.entries(query)) {
    if (!k.startsWith('col_')) continue;
    const col = byC[k.slice(4)];
    const val = String(raw == null ? '' : raw).trim();
    if (!col || !col.sql || !col.f || !val) continue;
    if (col.f === 'ncm') { params.push(soDigitos(val) + '%'); conds.push(`${col.sql} LIKE $${params.length}`); }
    else if (col.f === 'texto') { params.push('%' + val.toLowerCase() + '%'); conds.push(`unaccent(LOWER(${col.sql})) LIKE unaccent($${params.length})`); }
    else if (col.f === 'num') {
      const m = val.match(/^(>=|<=|<>|>|<|=)?\s*(-?\d+(?:[.,]\d+)?)$/);
      if (m) { params.push(Number(m[2].replace(',', '.'))); conds.push(`${col.sql} ${m[1] || '='} $${params.length}`); }
    } else if (col.f === 'bool') {
      if (val === 'true' || val === 'false') { params.push(val === 'true'); conds.push(`${col.sql} = $${params.length}`); }
    }
  }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

// --------------------------------------------------------- rotas

function registrarRotas(app, db) {
  // Relatórios — meta (tabelas + filtros disponíveis) e dados paginados/filtrados
  app.get('/api/fiscal/relatorio/meta', (req, res) => {
    const tabelas = Object.entries(RELATORIOS).map(([id, r]) => ({
      id, titulo: r.titulo,
      // expõe c/l/t/f por coluna (nunca o sql interno)
      colunas: r.colunas.map((c) => ({ c: c.c, l: c.l, t: c.t || null, f: c.f || null })),
    }));
    res.json({ success: true, tabelas });
  });

  app.get('/api/fiscal/relatorio', async (req, res) => {
    try {
      const rel = RELATORIOS[req.query.tabela];
      if (!rel) return res.status(400).json({ success: false, error: 'tabela inválida', tabelas: Object.keys(RELATORIOS) });
      const { where, params } = construirRelatorio(rel, req.query);
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 5000);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const [{ n: total }] = await catalogPg.query(`SELECT count(*)::int n FROM ${rel.base} ${where}`, params);
      const rows = await catalogPg.query(`SELECT ${rel.select} FROM ${rel.base} ${where} ORDER BY ${rel.ordem} LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
      const colunas = rel.colunas.map((c) => ({ c: c.c, l: c.l, t: c.t || null, f: c.f || null }));
      res.json({ success: true, titulo: rel.titulo, colunas, total, page, limit, rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Fase 2 — busca
  app.get('/api/fiscal/ncm/busca', async (req, res) => {
    try {
      const rows = await buscarNcm(req.query.q, req.query.limit);
      const resultados = await Promise.all(rows.map(async (r) => ({
        ncm: r.codigo,
        ncm_fmt: r.codigo_fmt,
        descricao: r.descricao,
        descricao_caminho: r.descricao_caminho,
        score: Number(r.score),
        cest: (await cestPorNcm(r.codigo)).map((c) => ({ cest: c.cest, cest_fmt: fmtCest(c.cest), ncm_prefix: c.ncm_prefix, descricao: c.descricao })),
      })));
      res.json({ success: true, total: resultados.length, resultados });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/fiscal/cest', async (req, res) => {
    try {
      if (!req.query.ncm) return res.status(400).json({ success: false, error: 'parâmetro ncm obrigatório' });
      const cests = await cestPorNcm(req.query.ncm);
      res.json({ success: true, cest: cests.map((c) => ({ cest: c.cest, cest_fmt: fmtCest(c.cest), ncm_prefix: c.ncm_prefix, descricao: c.descricao })) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/fiscal/ncm/:codigo', async (req, res) => {
    try {
      const ncm = await ncmPorCodigo(req.params.codigo);
      if (!ncm) return res.status(404).json({ success: false, error: 'NCM não encontrado' });
      const cests = await cestPorNcm(ncm.codigo);
      const impostos = await impostosPorNcm(ncm.codigo, req.query.uf);
      res.json({ success: true, ncm: { ...ncm, cest: cests.map((c) => ({ cest: c.cest, cest_fmt: fmtCest(c.cest), ncm_prefix: c.ncm_prefix, descricao: c.descricao })), impostos } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Fase 3 — sugestão por IA
  app.post('/api/fiscal/classificacao/sugerir', async (req, res) => {
    try {
      const r = await sugerir(db, req.body?.produto);
      if (r.erro && !r.ncm) return res.status(r.candidatos ? 200 : 422).json({ success: false, ...r });
      // impostos anexados FORA do cache (são por-UF; cache é só por texto)
      if (r.ncm && r.ncm_valido !== false) r.impostos = await impostosPorNcm(r.ncm, req.body?.uf);
      res.json({ success: true, ...r });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Lote — lista de descrições e/ou códigos NCM (parse de arquivo é feito no front)
  app.post('/api/fiscal/classificacao/lote', async (req, res) => {
    try {
      const r = await classificarLote(db, req.body?.itens);
      if (r.erro) return res.status(400).json({ success: false, error: r.erro });
      const uf = req.body?.uf;
      const resultados = await Promise.all(r.resultados.map(async (x) => (
        x.ncm && x.ncm_valido !== false ? { ...x, impostos: await impostosPorNcm(x.ncm, uf) } : x
      )));
      res.json({ success: true, total: resultados.length, resultados });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[fiscal-classificacao] Rotas registradas');
}

module.exports = { registrarRotasFiscalClassificacao: registrarRotas, buscarNcm, cestPorNcm, impostosPorNcm, sugerir, classificarUm, classificarLote };
