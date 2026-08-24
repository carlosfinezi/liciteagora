/**
 * status-negocio.js — o status que interessa a quem vende para o poder público.
 *
 * A tela de Status responde "a sincronização rodou?" e "quantas licitações
 * existem?". Nenhum dos dois muda o dia de ninguém. O que muda é: tem
 * oportunidade qualificada parada, algum prazo vencendo, o catálogo continua
 * recebendo dado.
 *
 * ---------------------------------------------------------------------------
 * DOIS CATÁLOGOS — e a primeira versão deste arquivo leu o errado.
 *
 * Desde 2026-05-23 o catálogo real é PostgreSQL (CATALOG_BACKEND_PG=1). O
 * `catalog.db` SQLite continua no disco e ATTACHado como view no banco do
 * tenant, mas congelado naquela data.
 *
 * A versão anterior consultava só a view SQLite e concluiu que o catálogo
 * estava "sem licitação nova há 71 dias". Era falso: em 01/08/2026 o PG
 * recebeu 177 licitações, e 20.297 nos sete dias anteriores. Ler a fonte
 * errada e afirmar com confiança é pior que não medir — o alerta mandaria
 * investigar uma parada que não existe.
 *
 * Consequência de desenho: as marcações do tenant (interesse, sem_interesse,
 * análises) vivem no SQLite do tenant e o catálogo no PG. Não dá para cruzar
 * num JOIN só, então o cruzamento é em duas etapas — chaves de um lado,
 * consulta do outro, junção em memória.
 * ---------------------------------------------------------------------------
 *
 * POR QUE NÃO EXISTE AQUI UM "casa meus grupos e ninguém olhou" AO VIVO:
 * medido em 02/08/2026, refazer o casamento de palavras contra o catálogo
 * custa 13s no menor tenant e estoura o statement_timeout de 30s no maior —
 * o casamento por descrição de item passa por 411 mil itens das licitações
 * abertas, ou pelo índice GIN dos 20 milhões do catálogo inteiro. Um painel
 * não paga esse preço, e cachear traria de volta exatamente o problema do
 * catálogo congelado. O que este arquivo usa no lugar é o resultado que o
 * pipeline de descoberta JÁ produziu (`licitacao_analise`) — ver
 * `qualificadasSemDecisao`, que declara a cobertura em vez de fingir que é
 * total.
 */

const DIA = 86400000;

const USE_PG = process.env.CATALOG_BACKEND_PG === '1';
const catalogPg = USE_PG ? require('./catalog-pg') : null;

// Data efetiva de encerramento. O portal pode adiar o que veio do PNCP, e o
// resto do sistema (consulta, análise IA, backfill de resultados) sempre lê o
// COALESCE — usar só `dataEncerramentoProposta` daria um número que não bate
// com a tela que o usuário abre em seguida.
const ENCERRA_PG = 'COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta")';
const ENCERRA_LITE = 'COALESCE(l.dataEncerramentoPortal, l.dataEncerramentoProposta)';

const hojeISO = () => new Date().toISOString().slice(0, 10);
const maisDias = (base, n) => new Date(new Date(base + 'T00:00:00Z').getTime() + n * DIA)
  .toISOString().slice(0, 10);
const soData = (d) => (d == null ? null : String(d instanceof Date ? d.toISOString() : d).slice(0, 10));

/**
 * O catálogo SQLite chega como TEMP VIEW (ATTACH em tenant-manager), e TEMP
 * VIEW não aparece em sqlite_master — consultar o schema dizia que
 * `licitacoes` não existia mesmo com as linhas acessíveis. Testar o acesso é
 * o que vale.
 */
function temTabela(db, nome) {
  try { db.prepare(`SELECT 1 FROM ${nome} LIMIT 1`).get(); return true; }
  catch { return false; }
}

const chave = (cnpj, ano, seq) => `${cnpj}|${Number(ano)}|${Number(seq)}`;

function lerChaves(db, sql) {
  try { return db.prepare(sql).all(); } catch { return []; }
}

/**
 * Busca no catálogo um conjunto conhecido de licitações, pelas chaves do
 * tenant. É o cruzamento que substitui o JOIN que existia quando catálogo e
 * tenant moravam no mesmo arquivo.
 */
async function porChaves(db, chaves) {
  if (!chaves.length) return [];

  if (USE_PG) {
    // Arrays paralelos em vez de N cláusulas OR: o SQL fica com tamanho fixo
    // independentemente de o tenant ter 100 ou 10 mil marcações.
    return await catalogPg.query(`
      SELECT l.cnpj, l."anoCompra" AS ano, l."sequencialCompra" AS sequencial,
             l."razaoSocial", l."ufSigla", l."valorTotalEstimado",
             substring(l."objetoCompra" for 140) AS objeto,
             ${ENCERRA_PG} AS encerra
        FROM licitacoes l
       WHERE (l.cnpj, l."anoCompra", l."sequencialCompra")
             IN (SELECT * FROM unnest($1::text[], $2::int[], $3::bigint[]))`,
      [chaves.map((c) => String(c.cnpj)),
       chaves.map((c) => Number(c.ano)),
       chaves.map((c) => Number(c.sequencial))]);
  }

  if (!temTabela(db, 'licitacoes')) return [];
  const cond = chaves.map(() => '(l.cnpj = ? AND l.anoCompra = ? AND l.sequencialCompra = ?)').join(' OR ');
  return db.prepare(`
    SELECT l.cnpj, l.anoCompra AS ano, l.sequencialCompra AS sequencial,
           l.razaoSocial AS "razaoSocial", l.ufSigla AS "ufSigla",
           l.valorTotalEstimado AS "valorTotalEstimado",
           substr(l.objetoCompra, 1, 140) AS objeto,
           ${ENCERRA_LITE} AS encerra
      FROM licitacoes l WHERE ${cond}`)
    .all(...chaves.flatMap((c) => [c.cnpj, Number(c.ano), Number(c.sequencial)]));
}

// ==================== OPORTUNIDADE QUALIFICADA E PARADA ====================

/**
 * O que a IA já qualificou e ninguém decidiu.
 *
 * Escolha deliberada de fonte: `licitacao_analise` é o que o pipeline de
 * descoberta efetivamente produziu, não uma varredura nova do catálogo. Isso
 * torna a conta barata (uma consulta por chave) e — mais importante — mede o
 * funil que a empresa realmente opera.
 *
 * A cobertura é parcial por construção: o agendamento analisa até
 * `limite_diario` por grupo por dia. Por isso a resposta devolve `cobertura`,
 * para a tela poder dizer de onde veio o número em vez de sugerir que é todo
 * o catálogo.
 *
 * O número mais duro daqui não é o das abertas: é `encerradasSemDecisao` — a
 * IA disse que servia, o prazo passou, e ninguém marcou nada.
 */
async function qualificadasSemDecisao(db, opts = {}) {
  let analises;
  try {
    analises = db.prepare(`SELECT cnpj, ano, sequencial, viabilidade_score AS score,
        produto_compativel AS compativel, dataAnalise
        FROM licitacao_analise WHERE cnpj IS NOT NULL`).all();
  } catch {
    return { disponivel: false, motivo: 'sem análises da IA neste tenant' };
  }

  const interesse = new Set(lerChaves(db, 'SELECT DISTINCT cnpj, ano, sequencial FROM interesse')
    .map((r) => chave(r.cnpj, r.ano, r.sequencial)));
  const semInteresse = new Set(lerChaves(db, 'SELECT cnpj, ano, sequencial FROM sem_interesse')
    .map((r) => chave(r.cnpj, r.ano, r.sequencial)));

  const semDecisao = analises.filter((a) => {
    const k = chave(a.cnpj, a.ano, a.sequencial);
    return !interesse.has(k) && !semInteresse.has(k);
  });

  const base = {
    analisadas: analises.length,
    semDecisao: semDecisao.length,
    cobertura: coberturaDaDescoberta(db),
  };
  if (!semDecisao.length) {
    return { ...base, disponivel: true, abertas: 0, encerradasSemDecisao: 0, valorAberto: 0, amostra: [] };
  }

  let linhas;
  try { linhas = await porChaves(db, semDecisao); }
  catch (e) { return { ...base, disponivel: false, erro: e.message }; }

  const score = new Map(semDecisao.map((a) => [chave(a.cnpj, a.ano, a.sequencial), a.score]));
  const hoje = opts.hoje || hojeISO();
  const abertas = [];
  let encerradas = 0;
  for (const l of linhas) {
    const enc = soData(l.encerra);
    if (enc && enc >= hoje) abertas.push({ ...l, encerra: enc, score: score.get(chave(l.cnpj, l.ano, l.sequencial)) });
    else encerradas++;
  }

  // Ordena por score da IA: o painel mostra poucas, e as poucas têm de ser as
  // que ela considerou melhores — não as primeiras que o banco devolveu.
  abertas.sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.encerra).localeCompare(String(b.encerra)));

  return {
    ...base,
    disponivel: true,
    abertas: abertas.length,
    encerradasSemDecisao: encerradas,
    // Só as que a IA analisou e sumiram do catálogo entrariam nesta diferença;
    // declarar evita que a soma pareça não fechar.
    naoEncontradasNoCatalogo: semDecisao.length - linhas.length,
    valorAberto: abertas.reduce((s, l) => s + (Number(l.valorTotalEstimado) || 0), 0),
    amostra: abertas.slice(0, opts.limite || 8),
  };
}

/** Teto e último resultado do agendamento — explica de onde vem a cobertura. */
function coberturaDaDescoberta(db) {
  try {
    const r = db.prepare(`SELECT COUNT(*) grupos, SUM(limite_diario) teto,
        MAX(ultimo_scan_em) ultimoScan,
        SUM(CASE WHEN ultimo_scan_status = 'sucesso' THEN 0 ELSE 1 END) comFalha
        FROM analise_ia_agendamento WHERE ativo = 1`).get();
    if (!r || !r.grupos) return { ativa: false };
    return { ativa: true, grupos: r.grupos, tetoDiario: r.teto, ultimoScan: r.ultimoScan, comFalha: r.comFalha };
  } catch { return { ativa: false }; }
}

// ==================== PRAZOS ====================

/**
 * Interesses com prazo curto e interesses cujo prazo já passou.
 * Perder a data de encerramento é o erro mais caro do ramo, e nada avisava.
 */
async function prazos(db, opts = {}) {
  const hoje = opts.hoje || hojeISO();
  const ate = maisDias(hoje, opts.dias || 3);
  const desde = maisDias(hoje, -(opts.diasVencidos || 15));

  const chaves = lerChaves(db, 'SELECT DISTINCT cnpj, ano, sequencial FROM interesse');
  if (!chaves.length) return { ate, vencendo: [], vencidos: [] };

  let linhas;
  try { linhas = await porChaves(db, chaves); }
  catch (e) { return { ate, erro: e.message }; }

  const vencendo = [];
  const vencidos = [];
  for (const l of linhas) {
    const enc = soData(l.encerra);
    if (!enc) continue;
    if (enc >= hoje && enc <= ate) vencendo.push({ ...l, encerra: enc });
    else if (enc < hoje && enc >= desde) vencidos.push({ ...l, encerra: enc });
  }
  vencendo.sort((a, b) => a.encerra.localeCompare(b.encerra));
  vencidos.sort((a, b) => b.encerra.localeCompare(a.encerra));

  return { ate, desde, vencendo: vencendo.slice(0, 30), vencidos: vencidos.slice(0, 30) };
}

// ==================== FRESCOR DO CATÁLOGO ====================

/**
 * O catálogo continua recebendo licitação nova?
 *
 * "Sync rodando" não é o mesmo que "chegando dado". E como este é justamente
 * o número que a versão anterior errou lendo a cópia congelada, a resposta
 * declara a fonte junto do valor.
 */
async function frescorDoCatalogo(db, opts = {}) {
  const hoje = opts.hoje || hojeISO();
  const idade = (d) => {
    const iso = soData(d);
    return iso ? Math.floor((new Date(hoje + 'T00:00:00Z') - new Date(iso + 'T00:00:00Z')) / DIA) : null;
  };

  try {
    let r;
    if (USE_PG) {
      // O recorte de 7 dias fica no WHERE para o índice de publicação servir;
      // MAX() sobre a tabela inteira varreria 1,5 milhão de linhas.
      r = await catalogPg.queryOne(`SELECT
          MAX("dataPublicacaoPncp") AS ultima,
          COUNT(*)::int AS sete,
          COUNT(*) FILTER (WHERE "dataPublicacaoPncp" >= $2::date)::int AS hoje
        FROM licitacoes WHERE "dataPublicacaoPncp" >= $1::date`,
        [maisDias(hoje, -7), hoje]);
    } else {
      if (!temTabela(db, 'licitacoes')) return null;
      r = db.prepare(`SELECT MAX(dataPublicacaoPncp) AS ultima,
          COUNT(*) AS sete,
          SUM(CASE WHEN substr(dataPublicacaoPncp,1,10) >= ? THEN 1 ELSE 0 END) AS hoje
        FROM licitacoes WHERE substr(dataPublicacaoPncp,1,10) >= ?`)
        .get(hoje, maisDias(hoje, -7));
    }

    const publicadas7d = Number(r && r.sete) || 0;
    const publicadasHoje = Number(r && r.hoje) || 0;
    return {
      fonte: USE_PG ? 'postgres' : 'sqlite',
      ultimaPublicacao: soData(r && r.ultima),
      diasSemPublicacaoNova: idade(r && r.ultima),
      publicadasHoje,
      publicadas7d,
      // Média de 7 dias vira o parâmetro: "hoje entrou muito menos que o
      // normal" é sinal de coleta quebrada, e nenhum contador absoluto mostra.
      mediaDiaria7d: Math.round(publicadas7d / 7),
      // Fim de semana quase não tem publicação — avisar todo sábado que a
      // coleta parou treinaria o usuário a ignorar o alerta.
      fimDeSemana: [0, 6].includes(new Date(hoje + 'T12:00:00Z').getUTCDay()),
      suspeito: publicadas7d > 0 && publicadasHoje === 0,
    };
  } catch (e) { return { erro: e.message }; }
}

// ==================== FUNIL, GRUPOS, CERTIFICADO ====================

/** Do que entrou até virar interesse. Sem isso não dá para saber onde trava. */
function funil(db, opts = {}) {
  const conta = (sql, params = []) => {
    try { return db.prepare(sql).get(...params).n; } catch { return null; }
  };
  const desde = maisDias(opts.hoje || hojeISO(), -(opts.dias || 30));
  return {
    periodoDias: opts.dias || 30,
    lidas: conta('SELECT COUNT(*) n FROM licitacao_lida WHERE dataLeitura >= ?', [desde]),
    analisadas: conta('SELECT COUNT(*) n FROM licitacao_analise'),
    analisadasNoPeriodo: conta('SELECT COUNT(*) n FROM licitacao_analise WHERE dataAnalise >= ?', [desde]),
    // O interesse é por item; a licitação distinta é o que importa no funil.
    interesses: conta('SELECT COUNT(DISTINCT cnpj || ano || sequencial) n FROM interesse'),
    interessesNoPeriodo: conta(
      'SELECT COUNT(DISTINCT cnpj || ano || sequencial) n FROM interesse WHERE dataCriacao >= ?', [desde]),
    descartadas: conta('SELECT COUNT(*) n FROM sem_interesse'),
    descartadasNoPeriodo: conta('SELECT COUNT(*) n FROM sem_interesse WHERE dataCriacao >= ?', [desde]),
  };
}

/**
 * Monta a expressão websearch de um grupo. Mesma construção de
 * bi-grupo-membership.js: inclusões em OR, exclusões SEPARADAS.
 *
 * Juntar as duas numa expressão só está errado — em websearch_to_tsquery a
 * precedência é NOT > AND > OR, então `a OR b OR c -x` liga o `-x` apenas ao
 * `c`. O bug foi medido em 2026-06-08 (o grupo "APENAS SERVIDORES" do 1bit
 * marcava 1840 em vez de 496) e não vale a pena reintroduzir aqui.
 */
function expressaoDoGrupo(db, grupoId) {
  const limpar = (p) => String(p).replace(/["()]/g, '').trim().toLowerCase();
  const juntar = (arr) => arr.map(limpar).filter(Boolean)
    .map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' OR ');

  const palavras = lerChaves(db, `SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ${Number(grupoId)}`)
    .map((r) => r.palavra);
  if (!palavras.length) return null;
  const exclusoes = lerChaves(db, `SELECT gpi.palavra FROM grupos_pesquisa_exclusao gpe
      JOIN grupos_palavras_itens gpi ON gpi.grupoId = gpe.grupoExclusaoId
      WHERE gpe.grupoPesquisaId = ${Number(grupoId)}`).map((r) => r.palavra);

  const incl = juntar(palavras);
  if (!incl) return null;
  return { incl, excl: juntar(exclusoes), palavras: palavras.length, exclusoes: exclusoes.length };
}

/**
 * Grupo ativo que não casou nada no período: palavra errada ou mercado parado.
 * Um grupo mudo passa despercebido para sempre se ninguém contar.
 *
 * Casa apenas o OBJETO da licitação, não a descrição dos itens. É uma escolha
 * de custo, declarada no retorno (`escopo`): incluir itens levaria a consulta
 * de ~1s para dezenas de segundos, e para a pergunta "este grupo está mudo?"
 * o objeto basta — se casa no objeto, o grupo não está mudo.
 *
 * Só grupos de PESQUISA entram. Os de exclusão também têm `ativo = 1` e
 * tratá-los como busca contaria justamente o que o usuário mandou ignorar.
 */
async function grupoImprodutivo(db, opts = {}) {
  const hoje = opts.hoje || hojeISO();
  const dias = opts.dias || 30;
  const desde = maisDias(hoje, -dias);
  const desdeAno = maisDias(hoje, -365);

  const grupos = lerChaves(db,
    "SELECT id, nome FROM grupos_palavras WHERE ativo = 1 AND (tipo = 'pesquisa' OR tipo IS NULL)");

  const contar = async (e, apartirDe) => {
    if (USE_PG) {
      const params = [e.incl, apartirDe];
      let cond = `to_tsvector('simple', coalesce("objetoCompra",'')) @@ websearch_to_tsquery('simple', $1)`;
      if (e.excl) {
        params.push(e.excl);
        cond += ` AND NOT to_tsvector('simple', coalesce("objetoCompra",'')) @@ websearch_to_tsquery('simple', $3)`;
      }
      const r = await catalogPg.queryOne(
        `SELECT COUNT(*)::int AS n FROM licitacoes WHERE "dataPublicacaoPncp" >= $2::date AND ${cond}`, params);
      return r ? r.n : 0;
    }
    if (!temTabela(db, 'licitacoes')) return null;
    // Sem tsvector no SQLite: LIKE por palavra, que é o que a consulta usa lá.
    const termos = e.incl.split(' OR ').map((p) => `%${p.replace(/"/g, '')}%`);
    const cond = termos.map(() => 'UPPER(objetoCompra) LIKE ?').join(' OR ');
    const r = db.prepare(`SELECT COUNT(*) n FROM licitacoes
      WHERE (${cond}) AND dataPublicacaoPncp >= ?`).get(...termos.map((t) => t.toUpperCase()), apartirDe);
    return r.n;
  };

  const mudos = [];
  for (const g of grupos) {
    const e = expressaoDoGrupo(db, g.id);
    if (!e) {
      mudos.push({ ...g, palavras: 0, casaram: 0, motivo: 'grupo ativo sem nenhuma palavra cadastrada' });
      continue;
    }
    try {
      const n = await contar(e, desde);
      if (n == null || n > 0) continue;
      // Distinguir "palavra errada" de "mercado parado". A janela de um ano
      // mantém o recorte de data na frente do texto.
      const noAno = await contar(e, desdeAno);
      mudos.push({
        ...g, palavras: e.palavras, exclusoes: e.exclusoes, casaram: 0, casouNoAno: noAno > 0,
        motivo: noAno
          ? `nada em ${dias} dias, mas ${noAno} no último ano — mercado parado ou janela curta`
          : 'nada no último ano — revise as palavras do grupo',
      });
    } catch (err) {
      mudos.push({ ...g, erro: err.message });
    }
  }
  return { escopo: 'objeto da licitação (não inclui descrição dos itens)', dias, grupos: mudos };
}

/** Certificado A1 vencido trava emissão fiscal e assinatura de proposta. */
function certificado(db, opts = {}) {
  try {
    const c = db.prepare('SELECT titular, validade FROM certificado_digital WHERE id = 1').get();
    if (!c || !c.validade) return { configurado: false };
    const hoje = opts.hoje || hojeISO();
    // A validade é gravada em dd/mm/aaaa (vem do certificado), não em ISO.
    // Tratar como ISO devolvia NaN e o alerta nunca aparecia.
    const bruto = String(c.validade).trim();
    const br = bruto.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    const val = br ? `${br[3]}-${br[2]}-${br[1]}` : bruto.slice(0, 10);
    const dias = /^\d{4}-\d{2}-\d{2}$/.test(val)
      ? Math.floor((new Date(val + 'T00:00:00Z') - new Date(hoje + 'T00:00:00Z')) / DIA)
      : null;
    return { configurado: true, titular: c.titular, validade: val, diasParaVencer: dias,
             vencido: dias != null && dias < 0, aVencer: dias != null && dias >= 0 && dias <= 30 };
  } catch { return { configurado: false }; }
}

/**
 * Painel. A análise de grupos mudos fica de fora de propósito: ela consulta o
 * catálogo por grupo e leva segundos — a tela busca à parte para não travar o
 * carregamento.
 */
async function painel(db, opts = {}) {
  const [oportunidades, prazosR, catalogo] = await Promise.all([
    qualificadasSemDecisao(db, opts),
    prazos(db, opts),
    frescorDoCatalogo(db, opts),
  ]);
  return {
    referencia: opts.hoje || hojeISO(),
    backendCatalogo: USE_PG ? 'postgres' : 'sqlite',
    oportunidades,
    prazos: prazosR,
    catalogo,
    funil: funil(db, opts),
    certificado: certificado(db, opts),
  };
}

module.exports = {
  USE_PG,
  painel,
  qualificadasSemDecisao, prazos, grupoImprodutivo, funil, frescorDoCatalogo, certificado,
  coberturaDaDescoberta, expressaoDoGrupo, porChaves,
};
