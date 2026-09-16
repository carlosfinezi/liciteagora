/**
 * cmed-import.js — Importador da Lista de Preços de Medicamentos da CMED/ANVISA.
 *
 * Fonte: https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos
 *        arquivo "PMC - XLS" (xls_conformidade_site_AAAAMMDD_*.xlsx)
 *
 * Estrutura real do arquivo (conferida na lista de 11/08/2026, 26.001 linhas):
 *
 *   - ~31 linhas de preâmbulo antes do cabeçalho. O tamanho do preâmbulo MUDA
 *     entre publicações, então o cabeçalho é DETECTADO (primeira linha com mais
 *     de 10 células preenchidas), nunca fixado por índice.
 *   - Colunas: SUBSTÂNCIA, CNPJ, LABORATÓRIO, CÓDIGO GGREM, REGISTRO,
 *     EAN 1..3, PRODUTO, APRESENTAÇÃO, CLASSE TERAPÊUTICA,
 *     TIPO DE PRODUTO (STATUS DO PRODUTO), REGIME DE PREÇO,
 *     PF/PMC por alíquota de ICMS, RESTRIÇÃO HOSPITALAR,
 *     LISTA DE CONCESSÃO DE CRÉDITO TRIBUTÁRIO (PIS/COFINS), TARJA.
 *   - Preços são texto em formato brasileiro ("50,90"), vazios quando não há
 *     preço para aquela alíquota (3.913 linhas sem PMC 19% na lista de agosto).
 *   - Há colunas "PMC 19 %  ALC" (Áreas de Livre Comércio) ao lado das normais.
 *     O casamento é exato para não pegar a ALC por engano.
 *
 * O importador NUNCA cria produto. EAN da CMED tem sujeira conhecida (2 códigos
 * fora de 13 dígitos na lista de agosto); criar catálogo a partir disso suja o
 * cadastro de forma irreversível. Linha sem produto correspondente vai para
 * `farmacia_cmed_naocasados`, para conferência humana.
 */

const XLSX = require('xlsx');

// ─── Normalização ────────────────────────────────────────────────────────────

function normalizarTexto(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// "50,90" → 50.9 · "1.234,56" → 1234.56 · "" → null
function parseNumeroBr(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * A CMED escreve a tarja por extenso, mas a coluna NÃO é confiável linha a
 * linha: na lista de 11/08/2026, 4.692 das 26.001 linhas trazem "- (*)", que
 * significa "sem informação / ver nota", e não "venda livre".
 *
 * Tratar "- (*)" como livre seria um buraco de segurança concreto: 58 dessas
 * linhas são de substâncias que a PRÓPRIA CMED marca como Tarja Preta em
 * outras linhas — controlado entrando no sistema como venda livre e escapando
 * da exigência de receita. Por isso "- (*)" devolve null (desconhecida), e o
 * importador infere pela substância (ver inferirTarjaPorSubstancia).
 *
 * `null` = não informada · 'livre' = a CMED diz "Tarja Sem Tarja".
 */
function normalizarTarja(v) {
  const t = normalizarTexto(v);
  if (!t || t.startsWith('-')) return null;
  if (t.includes('SEM TARJA')) return 'livre';
  if (t.includes('PRETA')) return 'preta';
  if (t.includes('VERMELHA') && (t.includes('RESTRICAO') || t.includes('RETENCAO'))) return 'vermelha_retencao';
  if (t.includes('VERMELHA')) return 'vermelha';
  return null;
}

// Da menos para a mais restritiva. Na dúvida entre duas linhas da mesma
// substância, vale a mais restritiva — errar para o lado de exigir receita
// custa um atrito no balcão; errar para o outro é dispensar controlado sem
// receita.
const ORDEM_TARJA = ['livre', 'vermelha', 'vermelha_retencao', 'preta'];

function tarjaMaisRestritiva(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return ORDEM_TARJA.indexOf(a) >= ORDEM_TARJA.indexOf(b) ? a : b;
}

/**
 * Monta substância → tarja mais restritiva observada na lista inteira.
 * Recupera 3.807 das 4.692 linhas sem informação; as 885 restantes ficam com
 * tarja nula e vão para a curadoria do farmacêutico.
 */
function inferirTarjaPorSubstancia(linhas) {
  const mapa = new Map();
  for (const l of linhas) {
    if (!l.tarja || !l.substancia) continue;
    const chave = normalizarTexto(l.substancia);
    mapa.set(chave, tarjaMaisRestritiva(mapa.get(chave), l.tarja));
  }
  return mapa;
}

function normalizarLista(v) {
  const t = normalizarTexto(v);
  if (t.startsWith('POSITIVA')) return 'positiva';
  if (t.startsWith('NEGATIVA')) return 'negativa';
  if (t.startsWith('NEUTRA')) return 'neutra';
  return null;
}

function normalizarRegime(v) {
  const t = normalizarTexto(v);
  if (t.startsWith('LIBERADO')) return 'liberado';
  if (t.startsWith('REGULADO')) return 'regulado';
  return null;
}

function ehSim(v) {
  return normalizarTexto(v).startsWith('SIM') ? 1 : 0;
}

/**
 * Antimicrobianos da RDC 20/2011 — subconjunto dos mais dispensados no varejo.
 *
 * ATENÇÃO: esta lista é um PONTO DE PARTIDA, não o Anexo I completo da RDC 20.
 * A CMED não publica essa informação, então ela não tem de onde vir por
 * importação. O flag é editável no cadastro e o Anexo I precisa ser carregado
 * por inteiro antes de o SNGPC ir a produção — senão um antimicrobiano fora
 * desta lista deixa de exigir receita e de ser escriturado.
 */
const ANTIMICROBIANOS_PARCIAL = [
  'AMOXICILINA', 'AMPICILINA', 'AZITROMICINA', 'BENZILPENICILINA', 'CEFACLOR',
  'CEFADROXILA', 'CEFALEXINA', 'CEFTRIAXONA', 'CEFUROXIMA', 'CIPROFLOXACINO',
  'CLARITROMICINA', 'CLINDAMICINA', 'CLORANFENICOL', 'DOXICICLINA',
  'ERITROMICINA', 'ESPIRAMICINA', 'ESTREPTOMICINA', 'ETAMBUTOL',
  'FOSFOMICINA', 'GENTAMICINA', 'ISONIAZIDA', 'LEVOFLOXACINO', 'LINCOMICINA',
  'MEROPENEM', 'METRONIDAZOL', 'MOXIFLOXACINO', 'NEOMICINA', 'NITROFURANTOINA',
  'NORFLOXACINO', 'OFLOXACINO', 'OXACILINA', 'PENICILINA', 'PIRAZINAMIDA',
  'RIFAMPICINA', 'SECNIDAZOL', 'SULFADIAZINA', 'SULFAMETOXAZOL',
  'TETRACICLINA', 'TIANFENICOL', 'TOBRAMICINA', 'TRIMETOPRIMA', 'VANCOMICINA',
];

function ehAntimicrobiano(substancia) {
  const s = normalizarTexto(substancia);
  if (!s) return 0;
  return ANTIMICROBIANOS_PARCIAL.some(a => s.includes(a)) ? 1 : 0;
}

// ─── Leitura da planilha ─────────────────────────────────────────────────────

// O preâmbulo varia entre publicações: detecta a linha de cabeçalho pelo número
// de células preenchidas em vez de confiar num índice fixo.
function detectarCabecalho(rows) {
  for (let i = 0; i < rows.length; i++) {
    const preenchidas = rows[i].filter(c => String(c).trim() !== '').length;
    if (preenchidas > 10) return i;
  }
  return -1;
}

function mapearColunas(header, colunaPmc) {
  const H = header.map(normalizarTexto);
  const achar = (alvo) => H.indexOf(normalizarTexto(alvo));

  // Casamento EXATO para não capturar a variante "PMC 19 %  ALC".
  const alvoPmc = normalizarTexto(`PMC ${colunaPmc} %`);
  const alvoPf = normalizarTexto(`PF ${colunaPmc} %`);

  const cols = {
    substancia: achar('SUBSTÂNCIA'),
    cnpj: achar('CNPJ'),
    laboratorio: achar('LABORATÓRIO'),
    registro: achar('REGISTRO'),
    ean1: achar('EAN 1'),
    ean2: achar('EAN 2'),
    ean3: achar('EAN 3'),
    produto: achar('PRODUTO'),
    apresentacao: achar('APRESENTAÇÃO'),
    classe: achar('CLASSE TERAPÊUTICA'),
    tipoProduto: achar('TIPO DE PRODUTO (STATUS DO PRODUTO)'),
    regime: achar('REGIME DE PREÇO'),
    pf: H.indexOf(alvoPf),
    pmc: H.indexOf(alvoPmc),
    restricaoHospitalar: achar('RESTRIÇÃO HOSPITALAR'),
    lista: achar('LISTA DE CONCESSÃO DE CRÉDITO TRIBUTÁRIO (PIS/COFINS)'),
    tarja: achar('TARJA'),
  };

  const faltando = ['substancia', 'registro', 'ean1', 'produto', 'pmc']
    .filter(k => cols[k] < 0);
  if (faltando.length) {
    throw new Error(
      `Planilha CMED sem as colunas esperadas: ${faltando.join(', ')}` +
      (cols.pmc < 0 ? ` (coluna de PMC procurada: "PMC ${colunaPmc} %")` : '')
    );
  }
  return cols;
}

/**
 * Lê a planilha e devolve as linhas já normalizadas. Não toca no banco.
 */
function lerPlanilhaCmed(caminho, { colunaPmc = '19' } = {}) {
  const wb = XLSX.readFile(caminho);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });

  const iHeader = detectarCabecalho(rows);
  if (iHeader < 0) throw new Error('Cabeçalho não encontrado na planilha CMED');

  const cols = mapearColunas(rows[iHeader], colunaPmc);
  const val = (r, i) => (i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : '');

  const linhas = [];
  for (let i = iHeader + 1; i < rows.length; i++) {
    const r = rows[i];
    const substancia = val(r, cols.substancia);
    const registro = val(r, cols.registro);
    // Rodapés e notas depois dos dados: sem substância e sem registro não é linha de produto.
    if (!substancia && !registro) continue;

    const eans = [val(r, cols.ean1), val(r, cols.ean2), val(r, cols.ean3)]
      .map(e => e.replace(/\D/g, ''))
      .filter(Boolean);

    linhas.push({
      substancia,
      cnpjLaboratorio: val(r, cols.cnpj),
      laboratorio: val(r, cols.laboratorio),
      registroAnvisa: registro.replace(/\D/g, ''),
      eans,
      produto: val(r, cols.produto),
      apresentacao: val(r, cols.apresentacao),
      classeTerapeutica: val(r, cols.classe),
      tipoProduto: val(r, cols.tipoProduto),
      regimePreco: normalizarRegime(val(r, cols.regime)),
      pf: parseNumeroBr(val(r, cols.pf)),
      pmc: parseNumeroBr(val(r, cols.pmc)),
      restricaoHospitalar: ehSim(val(r, cols.restricaoHospitalar)),
      listaCmed: normalizarLista(val(r, cols.lista)),
      tarja: normalizarTarja(val(r, cols.tarja)),
      antimicrobiano: ehAntimicrobiano(substancia),
    });
  }

  // Segunda passada: preenche a tarja das linhas em que a CMED não informou,
  // usando o que ela mesma diz sobre a substância em outras linhas.
  const porSubstancia = inferirTarjaPorSubstancia(linhas);
  for (const l of linhas) {
    if (l.tarja) { l.tarjaOrigem = 'cmed'; continue; }
    const inferida = porSubstancia.get(normalizarTexto(l.substancia));
    if (inferida) { l.tarja = inferida; l.tarjaOrigem = 'inferida'; }
    else { l.tarjaOrigem = 'desconhecida'; }
  }

  return { linhas, colunaPmc, linhaCabecalho: iHeader, tarjasPorSubstancia: porSubstancia };
}

// ─── Importação ──────────────────────────────────────────────────────────────

/**
 * Casa uma linha da CMED com um produto do catálogo, por EAN.
 * Procura nos dois lugares em que o EAN vive neste ERP: `produtos.codigoBarras`
 * e `produto_codigos` com tipo 'ean'.
 */
function acharProdutoPorEan(db, eans) {
  for (const ean of eans) {
    const p = db.prepare('SELECT id FROM produtos WHERE codigoBarras = ? AND ativo = 1').get(ean);
    if (p) return { produtoId: p.id, eanCasado: ean };
    const c = db.prepare(
      "SELECT produtoId FROM produto_codigos WHERE codigo = ? AND tipo = 'ean' AND ativo = 1"
    ).get(ean);
    if (c) return { produtoId: c.produtoId, eanCasado: ean };
  }
  return null;
}

/**
 * Importa a lista para o tenant. Idempotente por competência: reimportar a
 * mesma competência atualiza a versão e recalcula os specs.
 */
function importarCmed(db, caminho, opts = {}) {
  const colunaPmc = String(opts.colunaPmc || '19');
  const uf = opts.uf || 'PA';
  const competencia = opts.competencia || new Date().toISOString().slice(0, 7);
  const arquivoNome = opts.arquivoNome || caminho.split('/').pop();

  const { linhas } = lerPlanilhaCmed(caminho, { colunaPmc });

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO farmacia_cmed_versoes
        (competencia, arquivoNome, colunaPmc, ufReferencia, linhasLidas, importadoPor, importadoEm)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(competencia) DO UPDATE SET
        arquivoNome = excluded.arquivoNome,
        colunaPmc = excluded.colunaPmc,
        ufReferencia = excluded.ufReferencia,
        linhasLidas = excluded.linhasLidas,
        importadoPor = excluded.importadoPor,
        importadoEm = excluded.importadoEm
    `).run(competencia, arquivoNome, colunaPmc, uf, linhas.length, opts.usuario || null);

    const versao = db.prepare('SELECT id FROM farmacia_cmed_versoes WHERE competencia = ?').get(competencia);
    const versaoId = versao.id;

    // Reimportação da mesma competência: limpa os não-casados anteriores para
    // não duplicar a fila de conferência.
    db.prepare('DELETE FROM farmacia_cmed_naocasados WHERE cmedVersaoId = ?').run(versaoId);

    const upsertSpec = db.prepare(`
      INSERT INTO farmacia_medicamento_specs
        (produtoId, registroAnvisa, ean, substancia, classeTerapeutica, laboratorio,
         cnpjLaboratorio, apresentacao, tarja, tarjaOrigem, listaCmed, regimePreco, pf, pmc,
         restricaoHospitalar, antimicrobiano, tipoProduto, cmedVersaoId, atualizadoEm)
      VALUES (@produtoId, @registroAnvisa, @ean, @substancia, @classeTerapeutica, @laboratorio,
              @cnpjLaboratorio, @apresentacao, @tarja, @tarjaOrigem, @listaCmed, @regimePreco, @pf, @pmc,
              @restricaoHospitalar, @antimicrobiano, @tipoProduto, @cmedVersaoId, datetime('now'))
      ON CONFLICT(produtoId) DO UPDATE SET
        registroAnvisa = excluded.registroAnvisa,
        ean = excluded.ean,
        substancia = excluded.substancia,
        classeTerapeutica = excluded.classeTerapeutica,
        laboratorio = excluded.laboratorio,
        cnpjLaboratorio = excluded.cnpjLaboratorio,
        apresentacao = excluded.apresentacao,
        -- Tarja corrigida à mão pelo farmacêutico não é sobrescrita pela
        -- reimportação: a curadoria dele vale mais que a coluna da CMED, que
        -- é justamente o dado que costuma faltar.
        tarja = CASE WHEN farmacia_medicamento_specs.tarjaOrigem = 'manual'
                     THEN farmacia_medicamento_specs.tarja ELSE excluded.tarja END,
        tarjaOrigem = CASE WHEN farmacia_medicamento_specs.tarjaOrigem = 'manual'
                           THEN 'manual' ELSE excluded.tarjaOrigem END,
        listaCmed = excluded.listaCmed,
        regimePreco = excluded.regimePreco,
        pf = excluded.pf,
        pmc = excluded.pmc,
        restricaoHospitalar = excluded.restricaoHospitalar,
        tipoProduto = excluded.tipoProduto,
        cmedVersaoId = excluded.cmedVersaoId,
        atualizadoEm = datetime('now')
    `);
    // `antimicrobiano` e `listaPortaria344` ficam DE FORA do UPDATE de propósito:
    // são curadoria local (a CMED não os publica) e uma reimportação não pode
    // apagar o que o farmacêutico corrigiu à mão.

    const insNaoCasado = db.prepare(`
      INSERT INTO farmacia_cmed_naocasados
        (cmedVersaoId, ean, produto, laboratorio, apresentacao, registroAnvisa, substancia, pmc, motivo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let casadas = 0, naoCasadas = 0, semPmc = 0;
    for (const l of linhas) {
      const achado = l.eans.length ? acharProdutoPorEan(db, l.eans) : null;
      if (!achado) {
        naoCasadas++;
        insNaoCasado.run(versaoId, l.eans[0] || null, l.produto, l.laboratorio,
          l.apresentacao, l.registroAnvisa, l.substancia, l.pmc,
          l.eans.length ? 'EAN sem produto no catálogo' : 'linha sem EAN');
        continue;
      }
      if (l.pmc == null) semPmc++;
      upsertSpec.run({
        produtoId: achado.produtoId,
        registroAnvisa: l.registroAnvisa || null,
        ean: achado.eanCasado,
        substancia: l.substancia || null,
        classeTerapeutica: l.classeTerapeutica || null,
        laboratorio: l.laboratorio || null,
        cnpjLaboratorio: l.cnpjLaboratorio || null,
        apresentacao: l.apresentacao || null,
        tarja: l.tarja || null,
        tarjaOrigem: l.tarjaOrigem || 'desconhecida',
        listaCmed: l.listaCmed || null,
        regimePreco: l.regimePreco || null,
        pf: l.pf,
        pmc: l.pmc,
        restricaoHospitalar: l.restricaoHospitalar,
        antimicrobiano: l.antimicrobiano,
        tipoProduto: l.tipoProduto || null,
        cmedVersaoId: versaoId,
      });
      casadas++;
    }

    db.prepare(`UPDATE farmacia_cmed_versoes
                SET linhasCasadas = ?, linhasNaoCasadas = ? WHERE id = ?`)
      .run(casadas, naoCasadas, versaoId);

    return { versaoId, competencia, colunaPmc, uf, lidas: linhas.length, casadas, naoCasadas, semPmc };
  });

  return tx();
}

module.exports = {
  importarCmed,
  lerPlanilhaCmed,
  acharProdutoPorEan,
  normalizarTexto,
  parseNumeroBr,
  normalizarTarja,
  normalizarLista,
  normalizarRegime,
  ehAntimicrobiano,
  detectarCabecalho,
  mapearColunas,
  tarjaMaisRestritiva,
  inferirTarjaPorSubstancia,
  ORDEM_TARJA,
  ANTIMICROBIANOS_PARCIAL,
};
