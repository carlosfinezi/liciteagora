// bi-routes.js
//
// Rotas de Inteligência de Negócio (BI) — pesquisa local de itens,
// consulta de resultados via PNCP API e Dados Abertos Compras.gov.br.
// Extraído de server.js em NFSE-M06 onda 6.1 (2026-04-20). Bloco
// autocontido: só depende de `db` (better-sqlite3) e `axios`.
//
// Uso:
//   const { registrarRotasBi } = require('./bi-routes');
//   registrarRotasBi(app, db);
//
// DDL: a tabela `resultados_bi` (cache local de resultados homologados)
// continua sendo criada no bootstrap do worker (server.js), então esse
// módulo pode assumir que o schema existe.

const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const { chamarDeepSeek } = require('./analise-ia');
const { createConfigHelpers } = require('./config-helpers');
// Fase 3a (2026-05-23): adapter Postgres pro catalog. Substitui chamadas
// SQLite ao catálogo (licitacoes, itens, resultados_bi) por queries async
// no Postgres, eliminando o problema de event loop bloqueado em scans.
// Flag CATALOG_BACKEND_PG=1 ativa por rota refatorada (default SQLite legado).
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';
// Membership pré-computada do modo-grupo (bi_grupo_item). Substitui o match
// ao vivo (3-12s) por um lookup indexado. Ver bi-grupo-membership.js.
const grupoMembership = require('./bi-grupo-membership');
const { currentTenant } = require('./tenant-middleware');
// Catálogo TerraMaster com specs reais + validação de código (motor de sugestão).
const { montarPromptSugestao, validarSugestoes, TERRAMASTER_SEED } = require('./terramaster-catalog');

// Conexão DIRETA com catalog.db (read-only) para pre-warm dos caches
// e refreshes em background. Não passa pelo Proxy db do tenant-middleware,
// que retorna stubs vazios fora de contexto de request (ex: setTimeout
// do pre-warm roda em contexto de 'boot').
const CATALOG_DB_PATH = path.join(__dirname, 'data', 'catalog.db');
let _catalogDirectDb = null;
function _getCatalogDirectDb() {
  if (!_catalogDirectDb) {
    _catalogDirectDb = new Database(CATALOG_DB_PATH, { readonly: true, fileMustExist: true });
    _catalogDirectDb.pragma('journal_mode = WAL');
    _catalogDirectDb.pragma('busy_timeout = 5000');
  }
  return _catalogDirectDb;
}

// Conexão read-write direta com catalog.db — usada por rotas do worker que
// PRECISAM escrever em catalog (ex: bi_item_classificacao_ia). O attached
// `catalog.` via tenant-middleware é readonly; pra INSERT/UPDATE usar este.
// better-sqlite3 com WAL aceita múltiplas conexões; busy_timeout maior
// porque o sync principal grava intensamente no catalog.
let _catalogWriteDb = null;
function _getCatalogWriteDb() {
  if (!_catalogWriteDb) {
    _catalogWriteDb = new Database(CATALOG_DB_PATH);
    _catalogWriteDb.pragma('journal_mode = WAL');
    _catalogWriteDb.pragma('busy_timeout = 30000');
  }
  return _catalogWriteDb;
}

// URL base da PNCP API v1 — duplicada aqui para o módulo ficar
// autocontido; a mesma constante existe em server.js para outras rotas
// que ainda consultam itens diretamente.
const PNCP_API_ITENS = 'https://pncp.gov.br/api/pncp/v1';

// Plano 10: gera hash estável dos parâmetros de query (ignora pagina/tamanhoPagina
// para agrupar em um único cache por descrição; pagina entra na chave final).
function _queryHash(obj) {
  const norm = {};
  Object.keys(obj).sort().forEach(k => {
    const v = obj[k];
    if (v === undefined || v === null || v === '') return;
    norm[k] = String(v).trim().toLowerCase();
  });
  return crypto.createHash('sha1').update(JSON.stringify(norm)).digest('hex');
}

function registrarRotasBi(app, db) {
  // Bootstrap da membership pré-computada do modo-grupo (idempotente).
  if (USE_PG) {
    grupoMembership.ensureSchema(catalogPg)
      .catch(e => console.error('[bi-grupo] ensureSchema falhou:', e.message));
  }

  // Catálogo de sugestão de produto por MARCA (compartilhado entre tenants que
  // vendem a mesma marca; a pré-computação bi_item_sugestao_produto já é por
  // marca). Cada tenant escolhe a sua marca via config sugestao_produto_marca.
  // Semeia a marca TerraMaster (1bit) idempotentemente.
  async function _ensureSugestaoCatalogo() {
    const seed = TERRAMASTER_SEED;
    const modelosTxt = (seed.modelos || []).join('\n');
    if (USE_PG) {
      await catalogPg.execute(`CREATE TABLE IF NOT EXISTS bi_sugestao_catalogo (
        marca TEXT PRIMARY KEY, categoria TEXT, regras TEXT, specs TEXT, modelos TEXT,
        ativo INTEGER DEFAULT 1, atualizadoEm TIMESTAMP DEFAULT now())`);
      await catalogPg.execute(
        `INSERT INTO bi_sugestao_catalogo (marca, categoria, regras, specs, modelos, ativo)
         VALUES ($1,$2,$3,$4,$5,1) ON CONFLICT (marca) DO NOTHING`,
        [seed.marca, seed.categoria, seed.regras, seed.specs, modelosTxt]
      );
    } else {
      const wdb = _getCatalogWriteDb();
      wdb.exec(`CREATE TABLE IF NOT EXISTS bi_sugestao_catalogo (
        marca TEXT PRIMARY KEY, categoria TEXT, regras TEXT, specs TEXT, modelos TEXT,
        ativo INTEGER DEFAULT 1, atualizadoEm TEXT DEFAULT CURRENT_TIMESTAMP)`);
      wdb.prepare(`INSERT OR IGNORE INTO bi_sugestao_catalogo (marca, categoria, regras, specs, modelos, ativo)
        VALUES (?,?,?,?,?,1)`).run(seed.marca, seed.categoria, seed.regras, seed.specs, modelosTxt);
    }
  }
  _ensureSugestaoCatalogo().catch(e => console.error('[bi-sugestao] ensure falhou:', e.message));

  // Carrega a config de catálogo de uma marca (ou {marca} se não cadastrada).
  async function _carregarCatalogoMarca(marca) {
    if (!marca) return { marca };
    if (USE_PG) {
      const row = await catalogPg.queryOne(
        `SELECT marca, categoria, regras, specs, modelos, ativo FROM bi_sugestao_catalogo WHERE lower(marca) = lower($1)`,
        [marca]
      );
      return row || { marca };
    }
    const row = db.prepare(
      `SELECT marca, categoria, regras, specs, modelos, ativo FROM catalog.bi_sugestao_catalogo WHERE lower(marca) = lower(?)`
    ).get(marca);
    return row || { marca };
  }

  // Config self-serve da sugestão de produto do tenant: marca escolhida (no
  // SQLite do tenant) + catálogo da marca (PG/SQLite catalog compartilhado).
  app.get('/api/bi/sugestao-config', async (req, res) => {
    try {
      const { getConfigValue } = createConfigHelpers(db);
      const marca = String(getConfigValue('sugestao_produto_marca') || '').trim();
      let catalogo = null;
      if (marca) catalogo = await _carregarCatalogoMarca(marca);
      res.json({ marca: marca || null, catalogo: catalogo || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/bi/sugestao-config', async (req, res) => {
    try {
      const b = req.body || {};
      const marca = String(b.marca || '').trim();
      if (!marca) return res.status(400).json({ error: 'marca obrigatória' });
      const ativo = (b.ativo === false || b.ativo === 0) ? 0 : 1;
      const categoria = b.categoria != null ? String(b.categoria).slice(0, 200) : null;
      const regras = b.regras != null ? String(b.regras).slice(0, 8000) : null;
      const specs = b.specs != null ? String(b.specs).slice(0, 20000) : null;
      const modelos = b.modelos != null ? String(b.modelos).slice(0, 8000) : null;

      const { setConfigValue } = createConfigHelpers(db);
      setConfigValue('sugestao_produto_marca', marca);

      if (USE_PG) {
        await catalogPg.execute(
          `INSERT INTO bi_sugestao_catalogo (marca, categoria, regras, specs, modelos, ativo, atualizadoEm)
           VALUES ($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (marca) DO UPDATE SET categoria=EXCLUDED.categoria, regras=EXCLUDED.regras,
             specs=EXCLUDED.specs, modelos=EXCLUDED.modelos, ativo=EXCLUDED.ativo, atualizadoEm=now()`,
          [marca, categoria, regras, specs, modelos, ativo]
        );
      } else {
        const wdb = _getCatalogWriteDb();
        wdb.prepare(`INSERT INTO bi_sugestao_catalogo (marca, categoria, regras, specs, modelos, ativo, atualizadoEm)
          VALUES (?,?,?,?,?,?, CURRENT_TIMESTAMP)
          ON CONFLICT (marca) DO UPDATE SET categoria=excluded.categoria, regras=excluded.regras,
            specs=excluded.specs, modelos=excluded.modelos, ativo=excluded.ativo, atualizadoEm=CURRENT_TIMESTAMP`)
          .run(marca, categoria, regras, specs, modelos, ativo);
      }
      res.json({ success: true, marca, ativo });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Garante membership utilizável antes de uma consulta em modo-grupo:
  // 1ª vez constrói síncrono; stale dispara rebuild assíncrono (serve stale).
  async function _ensureGrupoSeNecessario(req) {
    if (!USE_PG || !req.query || !req.query.grupoId) return;
    await grupoMembership.ensureGrupo({
      catalogPg, tenantDb: db,
      tenant: (currentTenant() || {}).slug,
      grupoId: req.query.grupoId,
    });
  }

  // Plano 10: middleware de cache das APIs Dados Abertos. Lê cache válido,
  // em miss chama a API externa e escreve cache; em erro com entrada
  // expirada, serve stale-while-error.
  async function servirComCache({ endpoint, queryParams, apiCall }) {
    const queryHash = _queryHash({ endpoint, ...queryParams });
    let cached;
    if (USE_PG) {
      // PG: jsonb retorna objeto já parseado
      cached = await catalogPg.queryOne(
        `SELECT "resposta","expiresAt" FROM dadosabertos_cache WHERE "endpoint"=$1 AND "queryHash"=$2`,
        [endpoint, queryHash]
      );
    } else {
      cached = db.prepare(`
        SELECT resposta, expiresAt FROM dadosabertos_cache
         WHERE endpoint = ? AND queryHash = ?
      `).get(endpoint, queryHash);
    }
    const agora = Date.now();
    if (cached) {
      const exp = new Date(cached.expiresAt).getTime();
      if (exp > agora) {
        const data = USE_PG ? cached.resposta : JSON.parse(cached.resposta);
        return { data, cache: 'hit' };
      }
    }
    try {
      const data = await apiCall();
      if (USE_PG) {
        await catalogPg.execute(
          `INSERT INTO dadosabertos_cache ("endpoint","queryHash","queryParams","resposta","dataCache","expiresAt")
           VALUES ($1,$2,$3::jsonb,$4::jsonb, now(), now() + interval '30 days')
           ON CONFLICT ("endpoint","queryHash") DO UPDATE SET
             "resposta"=EXCLUDED."resposta","dataCache"=now(),"expiresAt"=now() + interval '30 days'`,
          [endpoint, queryHash, JSON.stringify(queryParams), JSON.stringify(data)]
        );
      } else {
        db.prepare(`
          INSERT INTO catalog.dadosabertos_cache (endpoint, queryHash, queryParams, resposta, dataCache, expiresAt)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, datetime('now','+30 days'))
          ON CONFLICT(endpoint, queryHash) DO UPDATE SET
            resposta = excluded.resposta,
            dataCache = CURRENT_TIMESTAMP,
            expiresAt = datetime('now','+30 days')
        `).run(endpoint, queryHash, JSON.stringify(queryParams), JSON.stringify(data));
      }
      return { data, cache: 'miss' };
    } catch (err) {
      if (cached) {
        // Stale-while-error: prefere dado antigo a 5xx
        console.warn(`[bi] ${endpoint}: API falhou, servindo stale (${cached.expiresAt}): ${err.message}`);
        const data = USE_PG ? cached.resposta : JSON.parse(cached.resposta);
        return { data, cache: 'stale' };
      }
      throw err;
    }
  }

  // Helper: monta cláusula WHERE/JOIN compartilhada entre /pesquisar e
  // /aggregates a partir dos filtros da query.
  //
  // status pode ser:
  //   - 'homologado'    : INNER JOIN, vencedor real (exclui marcador __sem_resultado__)
  //   - 'sem_resultado' : INNER JOIN, marcador __sem_resultado__ (PNCP retornou 404 ou vazio)
  //   - 'pendente'      : LEFT JOIN, sem entrada em resultados_bi (ainda não consultado pelo backfill)
  //   - 'qualquer' (default) : sem restrição; só junta se houver filtro derivado de rb
  //
  // Filtros que exigem dados de rb (marca, fornecedor, valorHomol*) implicam
  // status=homologado quando o usuário não escolheu nada — não faz sentido
  // filtrar por marca em itens sem vencedor.
  function _construirFiltros(query) {
    const {
      q, apenasHomologados,
      dataInicio, dataFim, uf, modalidadeId, situacao,
      marca, fornecedor, valorHomolMin, valorHomolMax,
      grupoId, apenasIaValidados, marcaColetada,
    } = query;
    let { status } = query;

    // Modo grupo: usuário escolheu um grupo de palavras-chave em vez de digitar
    // um termo. Inclusões = palavras do grupo (combinadas com OR, são sinônimos).
    // Exclusões = palavras dos grupos de exclusão vinculados (NOT, removem ruído
    // do OR amplo). Quando grupoId está setado, `q` é ignorado.
    let palavras = [];
    let palavrasExclusao = [];
    let grupoNome = null;
    const modoGrupo = !!grupoId;
    if (modoGrupo) {
      const gid = parseInt(grupoId, 10);
      if (!gid || isNaN(gid)) {
        const e = new Error('grupoId inválido');
        e.statusCode = 400;
        throw e;
      }
      const grupo = db.prepare(`SELECT id, nome, tipo FROM grupos_palavras WHERE id = ?`).get(gid);
      if (!grupo) {
        const e = new Error('Grupo não encontrado');
        e.statusCode = 404;
        throw e;
      }
      grupoNome = grupo.nome;
      palavras = db.prepare(`SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?`)
        .all(gid).map(r => String(r.palavra || '').trim().toLowerCase()).filter(Boolean);
      if (palavras.length === 0) {
        const e = new Error('Grupo sem palavras cadastradas');
        e.statusCode = 400;
        throw e;
      }
      // Exclusões só fazem sentido em grupos do tipo "pesquisa"; um grupo de
      // exclusão usado como filtro principal vira só inclusão (caso de uso raro
      // mas válido — "me mostre tudo que matchou na lista de exclusão").
      if (!grupo.tipo || grupo.tipo === 'pesquisa') {
        palavrasExclusao = db.prepare(`
          SELECT gpi.palavra
            FROM grupos_pesquisa_exclusao gpe
            JOIN grupos_palavras_itens gpi ON gpi.grupoId = gpe.grupoExclusaoId
           WHERE gpe.grupoPesquisaId = ?
        `).all(gid).map(r => String(r.palavra || '').trim().toLowerCase()).filter(Boolean);
      }
    } else {
      if (!q || String(q).trim().length < 3) {
        const e = new Error('Termo de busca deve ter pelo menos 3 caracteres');
        e.statusCode = 400;
        throw e;
      }
      palavras = String(q).trim().toLowerCase().split(/\s+/).filter(p => p.length >= 2);
      if (palavras.length === 0) {
        const e = new Error('Termos de busca inválidos');
        e.statusCode = 400;
        throw e;
      }
    }

    // Compat: ?apenasHomologados=1 = ?status=homologado
    if (!status && apenasHomologados === '1') status = 'homologado';

    // Filtros que dependem de resultados_bi (vencedor cacheado) — exigem
    // status=homologado quando o usuário não escolheu nada. Marca está
    // em itens.marcaExtraida (extraído do edital), NÃO depende de vencedor.
    // marcaColetada entra aqui para forçar status=homologado: filtrar por marca
    // do vencedor em item sem vencedor não faz sentido (mesma regra do fornecedor).
    const usaResultadosFilter = !!(fornecedor || valorHomolMin || valorHomolMax || marcaColetada);
    if (usaResultadosFilter && (!status || status === 'qualquer' || status === 'pendente' || status === 'sem_resultado')) {
      status = 'homologado';
    }

    // Onda 3 perf: usa FTS5 (itens_fts) quando todas as palavras viram tokens
    // alfanuméricos. Fallback para LIKE caso alguma palavra fique vazia depois
    // de tokenizar (caracteres exóticos que o tokenizer FTS5 não indexa).
    //
    // Combinação:
    //   - Busca livre (q): palavras unidas por AND (mais termos = mais específico).
    //   - Modo grupo: palavras de inclusão unidas por OR (sinônimos), depois
    //     NOT contra palavras dos grupos de exclusão vinculados.
    //
    // Cada palavra é convertida pra FTS5 da forma mais restritiva:
    //   - 1 token  → `"token"` (phrase com 1 palavra)
    //   - N tokens → `"tok1 tok2 tokN"` (phrase EXATA, tokens consecutivos)
    //
    // Versão antiga usava AND entre tokens (`"a" AND "b" AND "c"`) — mas isso
    // casava qualquer documento contendo as 3 palavras em qualquer posição.
    // Causou catastrofic match: palavra "solução de armazenamento" pegava
    // QUALQUER medicamento ("solução injetável... uso... armazenamento") porque
    // todos os tokens são triviais. Phrase exata exige consecutividade na ordem
    // certa: "solução de armazenamento" só casa se as 3 palavras aparecerem
    // nessa sequência, eliminando o ruído.
    //
    // Quoting defensivo continua importante: hífen em "all-in-one" é parseado
    // como unário NOT do FTS5 quando não-quotado, e phrase quotada lida bem
    // com hífen, acentos e tokens stop-wordish.
    const TOKEN_RE = /[a-zA-Z0-9çãõáéíóúâêîôûàèìòùäëïöüñ]+/gi;
    function palavraToFts(p) {
      const tokens = String(p).toLowerCase().match(TOKEN_RE);
      if (!tokens || tokens.length === 0) return null;
      return `"${tokens.join(' ')}"`;
    }
    const palavrasFts = palavras.map(palavraToFts);
    const palavrasExclFts = palavrasExclusao.map(palavraToFts);
    const todasValidasFts = palavrasFts.every(t => t !== null)
      && palavrasExclFts.every(t => t !== null);

    const where = [];
    const params = [];
    if (todasValidasFts) {
      const operador = modoGrupo ? ' OR ' : ' AND ';
      let termoFts = palavrasFts.join(operador);
      if (palavrasFts.length > 1 || palavrasExclFts.length > 0) {
        termoFts = `(${termoFts})`;
      }
      if (palavrasExclFts.length > 0) {
        termoFts = `${termoFts} NOT (${palavrasExclFts.join(' OR ')})`;
      }
      where.push(`i.id IN (SELECT rowid FROM catalog.itens_fts WHERE itens_fts MATCH ?)`);
      params.push(termoFts);
    } else {
      // LIKE fallback. Inclusões com OR em modo grupo, AND em busca livre.
      if (palavras.length > 0) {
        const placeholders = palavras.map(() => `LOWER(i.descricao) LIKE ?`);
        const op = modoGrupo ? ' OR ' : ' AND ';
        where.push(palavras.length > 1 ? `(${placeholders.join(op)})` : placeholders[0]);
        palavras.forEach(p => params.push(`%${p}%`));
      }
      palavrasExclusao.forEach(p => {
        where.push(`LOWER(i.descricao) NOT LIKE ?`);
        params.push(`%${p}%`);
      });
    }

    where.push(`l.dataEncerramentoProposta < datetime('now')`);
    if (dataInicio) { where.push(`l.dataEncerramentoProposta >= ?`); params.push(dataInicio); }
    if (dataFim)    { where.push(`l.dataEncerramentoProposta <= ?`); params.push(`${dataFim} 23:59:59`); }
    if (uf)             { where.push(`l.ufSigla = ?`);            params.push(String(uf).toUpperCase()); }
    if (modalidadeId)   { where.push(`l.modalidadeId = ?`);       params.push(parseInt(modalidadeId, 10)); }
    if (situacao)       { where.push(`l.situacaoCompraNome = ?`); params.push(situacao); }
    // Marca: filtro sobre i.marcaExtraida (heurística do marca-backfill).
    // Independe de status pois mora em itens, não em resultados_bi.
    if (marca) {
      where.push(`LOWER(i.marcaExtraida) = ?`);
      params.push(String(marca).toLowerCase());
    }

    // Filtro IA: só itens classificados como "ehAprovado=1" pelo DeepSeek
    // (via /api/bi/classificar-ia). Escopo é por grupo. Sem grupoId não faz
    // sentido — silenciosamente ignora.
    if ((apenasIaValidados === 'true' || apenasIaValidados === '1') && modoGrupo) {
      where.push(`i.id IN (SELECT itemId FROM catalog.bi_item_classificacao_ia WHERE escopo = ? AND ehAprovado = 1)`);
      params.push(`grupo_${parseInt(grupoId, 10)}`);
    }

    let joinClause = '';
    let distinctClause = '';
    let hasResultsJoin = false;

    // Subquery que devolve UMA linha de resultados_bi por item (a primeira
    // pelo id) entre os vencedores reais — evita duplicar item quando
    // houver múltiplos resultados homologados, mantendo paginação correta.
    const PICK_ONE_VENCEDOR = `(
      SELECT MIN(rb2.id) FROM resultados_bi rb2
       WHERE rb2.cnpj = l.cnpj AND rb2.ano = l.anoCompra
         AND rb2.sequencial = l.sequencialCompra AND rb2.numeroItem = i.numeroItem
         AND rb2.niFornecedor != '__sem_resultado__'
    )`;

    if (status === 'pendente') {
      joinClause = `LEFT JOIN resultados_bi rb ON rb.cnpj = l.cnpj AND rb.ano = l.anoCompra AND rb.sequencial = l.sequencialCompra AND rb.numeroItem = i.numeroItem`;
      where.push(`rb.id IS NULL`);
    } else if (status === 'sem_resultado') {
      joinClause = `JOIN resultados_bi rb ON rb.cnpj = l.cnpj AND rb.ano = l.anoCompra AND rb.sequencial = l.sequencialCompra AND rb.numeroItem = i.numeroItem`;
      where.push(`rb.niFornecedor = '__sem_resultado__'`);
      distinctClause = 'DISTINCT';
      hasResultsJoin = true;
    } else if (status === 'homologado' || usaResultadosFilter) {
      joinClause = `JOIN resultados_bi rb ON rb.id = ${PICK_ONE_VENCEDOR}`;
      hasResultsJoin = true;
      if (fornecedor) {
        const f = String(fornecedor).trim();
        const onlyDigits = f.replace(/\D/g, '');
        if (onlyDigits.length >= 11) {
          where.push(`rb.niFornecedor = ?`);
          params.push(onlyDigits);
        } else {
          where.push(`LOWER(rb.nomeRazaoSocialFornecedor) LIKE ?`);
          params.push(`%${f.toLowerCase()}%`);
        }
      }
      if (valorHomolMin) { where.push(`rb.valorUnitarioHomologado >= ?`); params.push(parseFloat(valorHomolMin)); }
      if (valorHomolMax) { where.push(`rb.valorUnitarioHomologado <= ?`); params.push(parseFloat(valorHomolMax)); }
      // Paridade com o backend PG — ver comentário lá sobre string vazia.
      if (marcaColetada === '1') where.push(`length(coalesce(rb.marcaFabricante,'')) > 0`);
      if (marcaColetada === '0') where.push(`length(coalesce(rb.marcaFabricante,'')) = 0`);
    } else {
      // status='qualquer' (default): LEFT JOIN para que o item venha com
      // dados do vencedor SE já estiverem no cache local. Não filtra fora
      // itens sem vencedor — usuário queria ver tudo localmente sem
      // chamar PNCP ao vivo.
      joinClause = `LEFT JOIN resultados_bi rb ON rb.id = ${PICK_ONE_VENCEDOR}`;
      hasResultsJoin = true;
    }

    return {
      whereSql: where.join(' AND '),
      joinClause,
      distinctClause,
      params,
      hasResultsJoin,
      status: status || 'qualquer',
      filtrosEcho: {
        q, dataInicio, dataFim, uf, modalidadeId, situacao, marca, fornecedor, valorHomolMin, valorHomolMax,
        status: status || 'qualquer',
        grupoId: modoGrupo ? parseInt(grupoId, 10) : null,
        grupoNome,
        grupoPalavras: modoGrupo ? palavras : null,
        grupoPalavrasExclusao: modoGrupo ? palavrasExclusao : null,
        apenasIaValidados: (apenasIaValidados === 'true' || apenasIaValidados === '1') && modoGrupo,
      },
    };
  }

  // ============================================================
  // Versão Postgres de _construirFiltros (Fase 3a — 2026-05-23)
  //
  // Mesma semântica da função SQLite original, mas:
  //   - Placeholders $1, $2, ... (em vez de ?)
  //   - FTS5 MATCH → to_tsvector('portuguese', col) @@ websearch_to_tsquery
  //   - datetime('now') → now()
  //   - Colunas quoted ("camelCase" pra preservar case do PG)
  //
  // Grupos de palavras ainda vêm do tenant SQLite (sync), o WHERE gerado
  // vai pro pool Postgres (async).
  // ============================================================
  function _construirFiltrosPg(query) {
    const {
      q, apenasHomologados,
      dataInicio, dataFim, uf, modalidadeId, situacao,
      marca, fornecedor, valorHomolMin, valorHomolMax,
      grupoId, apenasIaValidados, marcaColetada,
    } = query;
    let { status } = query;

    let palavras = [];
    let palavrasExclusao = [];
    let grupoNome = null;
    const modoGrupo = !!grupoId;
    if (modoGrupo) {
      const gid = parseInt(grupoId, 10);
      if (!gid || isNaN(gid)) { const e = new Error('grupoId inválido'); e.statusCode = 400; throw e; }
      const grupo = db.prepare(`SELECT id, nome, tipo FROM grupos_palavras WHERE id = ?`).get(gid);
      if (!grupo) { const e = new Error('Grupo não encontrado'); e.statusCode = 404; throw e; }
      grupoNome = grupo.nome;
      palavras = db.prepare(`SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?`)
        .all(gid).map(r => String(r.palavra || '').trim().toLowerCase()).filter(Boolean);
      if (palavras.length === 0) { const e = new Error('Grupo sem palavras cadastradas'); e.statusCode = 400; throw e; }
      if (!grupo.tipo || grupo.tipo === 'pesquisa') {
        palavrasExclusao = db.prepare(`
          SELECT gpi.palavra
            FROM grupos_pesquisa_exclusao gpe
            JOIN grupos_palavras_itens gpi ON gpi.grupoId = gpe.grupoExclusaoId
           WHERE gpe.grupoPesquisaId = ?
        `).all(gid).map(r => String(r.palavra || '').trim().toLowerCase()).filter(Boolean);
      }
    } else {
      if (!q || String(q).trim().length < 3) { const e = new Error('Termo de busca deve ter pelo menos 3 caracteres'); e.statusCode = 400; throw e; }
      palavras = String(q).trim().toLowerCase().split(/\s+/).filter(p => p.length >= 2);
      if (palavras.length === 0) { const e = new Error('Termos de busca inválidos'); e.statusCode = 400; throw e; }
    }

    if (!status && apenasHomologados === '1') status = 'homologado';
    // marcaColetada entra aqui para forçar status=homologado: filtrar por marca
    // do vencedor em item sem vencedor não faz sentido (mesma regra do fornecedor).
    const usaResultadosFilter = !!(fornecedor || valorHomolMin || valorHomolMax || marcaColetada);
    if (usaResultadosFilter && (!status || status === 'qualquer' || status === 'pendente' || status === 'sem_resultado')) {
      status = 'homologado';
    }

    // Postgres tem placeholders numerados ($1, $2, ...) — usamos contador
    const where = [];
    const params = [];
    let p = 1;
    const ph = (v) => { params.push(v); return '$' + (p++); };

    // Busca textual — estratégia depende do modo:
    //
    //   - MODO GRUPO: usa a membership PRÉ-COMPUTADA (bi_grupo_item). O match
    //     caro (OR inclusões + NOT exclusões, config 'simple' p/ preservar
    //     "nas") roda offline em bi-grupo-membership.js; aqui é só um lookup
    //     indexado por (tenant, grupoId) — vira <100ms em vez de 3-12s.
    //     A frescura é garantida por _ensureGrupoSeNecessario() no handler.
    //
    //   - BUSCA LIVRE (q): FTS tsvector + websearch_to_tsquery 'simple' (não
    //     'portuguese'): o stemmer português dropa stopwords ("nas"/"de"/"em"),
    //     degradando "servidor nas"→'servidor' e inundando de lixo. Trade-off:
    //     perde stemming de plural. Usa idx_itens_desc_simple.
    if (modoGrupo) {
      const tenantSlug = (currentTenant() || {}).slug || null;
      where.push(`i."id" IN (SELECT "itemId" FROM bi_grupo_item WHERE tenant = ${ph(tenantSlug)} AND "grupoId" = ${ph(parseInt(grupoId, 10))})`);
    } else {
      function wsClean(p) {
        // Mantém alfanum + acentuação latina + espaço. Aspas viram nada (evita break).
        return String(p).replace(/["()]/g, '').trim();
      }
      const palCleans = palavras.map(wsClean).filter(Boolean);
      if (palCleans.length > 0) {
        // Palavras com múltiplos tokens viram "frase exata" entre aspas; espaço = AND
        const includeParts = palCleans.map(pl => pl.includes(' ') ? `"${pl}"` : pl);
        const expr = includeParts.join(' ');
        where.push(`to_tsvector('simple', coalesce(i."descricao",'')) @@ websearch_to_tsquery('simple', ${ph(expr)})`);
      }
    }

    where.push(`COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") < now()`);
    if (dataInicio)   { where.push(`COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") >= ${ph(dataInicio)}`); }
    if (dataFim)      { where.push(`COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") <= ${ph(dataFim + ' 23:59:59')}`); }
    if (uf)           { where.push(`l."ufSigla" = ${ph(String(uf).toUpperCase())}`); }
    if (modalidadeId) { where.push(`l."modalidadeId" = ${ph(parseInt(modalidadeId, 10))}`); }
    if (situacao)     { where.push(`l."situacaoCompraNome" = ${ph(situacao)}`); }
    if (marca)        { where.push(`lower(i."marcaExtraida") = ${ph(String(marca).toLowerCase())}`); }

    if ((apenasIaValidados === 'true' || apenasIaValidados === '1') && modoGrupo) {
      where.push(`i."id" IN (SELECT "itemId" FROM bi_item_classificacao_ia WHERE "escopo" = ${ph('grupo_' + parseInt(grupoId, 10))} AND "ehAprovado" = 1)`);
    }

    let joinClause = '';
    let distinctClause = '';
    let hasResultsJoin = false;
    const PICK_ONE_VENCEDOR = `(
      SELECT MIN(rb2."id") FROM resultados_bi rb2
       WHERE rb2."cnpj" = l."cnpj" AND rb2."ano" = l."anoCompra"
         AND rb2."sequencial" = l."sequencialCompra" AND rb2."numeroItem" = i."numeroItem"
         AND rb2."niFornecedor" != '__sem_resultado__'
    )`;

    if (status === 'pendente') {
      joinClause = `LEFT JOIN resultados_bi rb ON rb."cnpj" = l."cnpj" AND rb."ano" = l."anoCompra" AND rb."sequencial" = l."sequencialCompra" AND rb."numeroItem" = i."numeroItem"`;
      where.push(`rb."id" IS NULL`);
    } else if (status === 'sem_resultado') {
      joinClause = `JOIN resultados_bi rb ON rb."cnpj" = l."cnpj" AND rb."ano" = l."anoCompra" AND rb."sequencial" = l."sequencialCompra" AND rb."numeroItem" = i."numeroItem"`;
      where.push(`rb."niFornecedor" = '__sem_resultado__'`);
      distinctClause = 'DISTINCT';
      hasResultsJoin = true;
    } else if (status === 'homologado' || usaResultadosFilter) {
      joinClause = `JOIN resultados_bi rb ON rb."id" = ${PICK_ONE_VENCEDOR}`;
      hasResultsJoin = true;
      if (fornecedor) {
        const f = String(fornecedor).trim();
        const onlyDigits = f.replace(/\D/g, '');
        if (onlyDigits.length >= 11) where.push(`rb."niFornecedor" = ${ph(onlyDigits)}`);
        else                          where.push(`lower(rb."nomeRazaoSocialFornecedor") LIKE ${ph('%' + f.toLowerCase() + '%')}`);
      }
      if (valorHomolMin) { where.push(`rb."valorUnitarioHomologado" >= ${ph(parseFloat(valorHomolMin))}`); }
      if (valorHomolMax) { where.push(`rb."valorUnitarioHomologado" <= ${ph(parseFloat(valorHomolMax))}`); }
      // Marca do VENCEDOR (rb.marcaFabricante), não a extraída do edital
      // (i.marcaExtraida, filtro `marca`). Testa por comprimento e não por
      // IS NULL: o PNCP grava STRING VAZIA no lugar de nulo — 871.956 linhas
      // "não-nulas" estão vazias, e `IS NOT NULL` daria 16% de cobertura onde
      // a real é 0,74%.
      if (marcaColetada === '1') where.push(`length(coalesce(rb."marcaFabricante",'')) > 0`);
      if (marcaColetada === '0') where.push(`length(coalesce(rb."marcaFabricante",'')) = 0`);
    } else {
      joinClause = `LEFT JOIN resultados_bi rb ON rb."id" = ${PICK_ONE_VENCEDOR}`;
      hasResultsJoin = true;
    }

    return {
      whereSql: where.join(' AND '),
      joinClause,
      distinctClause,
      params,
      nextParam: p,  // próximo $N livre (pra append LIMIT/OFFSET)
      hasResultsJoin,
      status: status || 'qualquer',
      filtrosEcho: {
        q, dataInicio, dataFim, uf, modalidadeId, situacao, marca, fornecedor, valorHomolMin, valorHomolMax,
        status: status || 'qualquer',
        grupoId: modoGrupo ? parseInt(grupoId, 10) : null,
        grupoNome,
        grupoPalavras: modoGrupo ? palavras : null,
        grupoPalavrasExclusao: modoGrupo ? palavrasExclusao : null,
        apenasIaValidados: (apenasIaValidados === 'true' || apenasIaValidados === '1') && modoGrupo,
      },
    };
  }

  // Pesquisar itens por palavra-chave (busca local)
  //
  // Performance: o COUNT exato em busca ampla (`LIKE '%termo%'` em 4.6M itens)
  // custa 30-90s. Removemos o COUNT — pegamos `tamanhoPagina + 1` itens; se
  // veio o extra, sabemos que há mais sem precisar contar tudo. UX:
  // mostramos paginação por "próxima página" em vez de "página X de Y".
  app.get('/api/bi/pesquisar', async (req, res) => {
    try {
      await _ensureGrupoSeNecessario(req);
      const { pagina = 1, tamanhoPagina = 50 } = req.query;
      const offset = (parseInt(pagina) - 1) * parseInt(tamanhoPagina);
      const limit = parseInt(tamanhoPagina);

      // === Postgres backend (Fase 3a) ===
      if (USE_PG) {
        const { whereSql, joinClause, distinctClause, params, nextParam, hasResultsJoin, filtrosEcho } = _construirFiltrosPg(req.query);
        const selectResultados = hasResultsJoin
          ? `, rb."niFornecedor", rb."nomeRazaoSocialFornecedor", rb."valorUnitarioHomologado", rb."valorTotalHomologado", rb."marcaFabricante", rb."modeloVersao", rb."dataResultado"`
          : '';

        // Resultado de origem (coletor de portais — fallback quando PNCP não
        // homologou). Vem da linha marcador, enriquecida com fonte/situacaoOrigem.
        const selectOrigem = `, rbo."fonte" AS "fonteOrigem", rbo."situacaoOrigem", rbo."valorUnitarioHomologado" AS "valorOrigem"`;
        const joinOrigem = `LEFT JOIN resultados_bi rbo ON rbo."cnpj"=l."cnpj" AND rbo."ano"=l."anoCompra" AND rbo."sequencial"=l."sequencialCompra" AND rbo."numeroItem"=i."numeroItem" AND rbo."niFornecedor"='__sem_resultado__'`;

        const sql = `
          SELECT ${distinctClause}
            i."id" as "itemId",
            i."numeroItem",
            i."descricao" as "itemDescricao",
            i."quantidade",
            i."unidadeMedida",
            i."valorUnitarioEstimado",
            i."valorTotal" as "valorTotalEstimado",
            i."marcaExtraida",
            i."marcaConfianca",
            l."cnpj",
            l."anoCompra",
            l."sequencialCompra",
            l."razaoSocial" as orgao,
            l."nomeUnidade",
            l."codigoUnidade" as uasg,
            l."ufSigla",
            l."municipioNome",
            l."modalidadeId",
            l."modalidadeNome",
            l."objetoCompra",
            l."situacaoCompraNome",
            l."dataPublicacaoPncp",
            COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") AS "dataEncerramentoProposta",
            l."numeroControlePNCP"
            ${selectResultados}
            ${selectOrigem}
          FROM itens i
          JOIN licitacoes l ON i."licitacaoId" = l."id"
          ${joinClause}
          ${joinOrigem}
          WHERE ${whereSql}
          ORDER BY l."dataPublicacaoPncp" DESC
          LIMIT $${nextParam} OFFSET $${nextParam + 1}
        `;
        const itens = await catalogPg.query(sql, [...params, limit + 1, offset]);
        const temMais = itens.length > limit;
        if (temMais) itens.pop();

        return res.json({
          total: null, totalPaginas: null, temMais,
          pagina: parseInt(pagina), tamanhoPagina: limit,
          itens, filtros: filtrosEcho, backend: 'pg',
        });
      }

      // === Legado SQLite (default enquanto refactor não completo) ===
      const { whereSql, joinClause, distinctClause, params, hasResultsJoin, filtrosEcho } = _construirFiltros(req.query);

      const selectResultados = hasResultsJoin
        ? `, rb.niFornecedor, rb.nomeRazaoSocialFornecedor, rb.valorUnitarioHomologado, rb.valorTotalHomologado, rb.marcaFabricante, rb.modeloVersao, rb.dataResultado`
        : '';

      const itens = db.prepare(`
        SELECT ${distinctClause}
          i.id as itemId,
          i.numeroItem,
          i.descricao as itemDescricao,
          i.quantidade,
          i.unidadeMedida,
          i.valorUnitarioEstimado,
          i.valorTotal as valorTotalEstimado,
          i.marcaExtraida,
          i.marcaConfianca,
          l.cnpj,
          l.anoCompra,
          l.sequencialCompra,
          l.razaoSocial as orgao,
          l.nomeUnidade,
          l.codigoUnidade as uasg,
          l.ufSigla,
          l.municipioNome,
          l.modalidadeId,
          l.modalidadeNome,
          l.objetoCompra,
          l.situacaoCompraNome,
          l.dataPublicacaoPncp,
          l.dataEncerramentoProposta,
          l.numeroControlePNCP
          ${selectResultados}
        FROM itens i
        JOIN licitacoes l ON i.licitacaoId = l.id
        ${joinClause}
        WHERE ${whereSql}
        ORDER BY l.dataPublicacaoPncp DESC
        LIMIT ? OFFSET ?
      `).all(...params, limit + 1, offset);

      const temMais = itens.length > limit;
      if (temMais) itens.pop();

      res.json({
        total: null, totalPaginas: null, temMais,
        pagina: parseInt(pagina), tamanhoPagina: limit,
        itens, filtros: filtrosEcho,
      });

    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error('Erro BI pesquisar:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ===== Exportação Excel (.xlsx) do universo FILTRADO completo =====
  // Reusa _construirFiltrosPg → aplica exatamente os mesmos filtros do
  // /api/bi/pesquisar, mas sem paginação (cap EXPORT_MAX_LINHAS). Gera o .xlsx
  // server-side com a lib `xlsx` (require lazy: não carrega 880KB no boot).
  // Roda async no PG; filtro muito amplo pode bater no statement_timeout=30s.
  const EXPORT_MAX_LINHAS = 20000;

  function _fmtDataBR(v) {
    if (!v) return '';
    const d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }
  function _fmtCNPJ(ni) {
    if (!ni) return '';
    const s = String(ni).replace(/\D/g, '');
    if (s.length === 14) return s.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    if (s.length === 11) return s.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    return String(ni);
  }
  // Espelha a derivação de status/vencedor do renderResults do front.
  function _linhaExportXlsx(it) {
    const o = { status: 'Não consultado', fornecedor: '', cnpj: '', marca: '', modelo: '', vUnit: '', vTotal: '', dataRes: '' };
    if (it.niFornecedor && it.niFornecedor !== '__sem_resultado__') {
      o.status = 'Homologado';
      o.fornecedor = it.nomeRazaoSocialFornecedor || 'N/I';
      o.cnpj = _fmtCNPJ(it.niFornecedor);
      o.marca = it.marcaFabricante || it.marcaExtraida || '';
      o.modelo = it.modeloVersao || '';
      if (it.valorUnitarioHomologado != null) o.vUnit = Number(it.valorUnitarioHomologado);
      if (it.valorTotalHomologado != null) o.vTotal = Number(it.valorTotalHomologado);
      o.dataRes = _fmtDataBR(it.dataResultado);
    } else if (it.situacaoOrigem) {
      o.status = it.situacaoOrigem + (it.fonteOrigem ? ` (via ${it.fonteOrigem})` : ' (via origem)');
      if (it.valorOrigem != null) { o.vUnit = Number(it.valorOrigem); o.fornecedor = 'vencedor não publicado no PNCP'; }
    } else if (it.niFornecedor === '__sem_resultado__') {
      o.status = 'Sem resultado';
    }
    return {
      'Item': it.itemDescricao || '',
      'Nº': it.numeroItem,
      'Qtd': it.quantidade ?? '',
      'Unid.': it.unidadeMedida || '',
      'Órgão': it.nomeUnidade || it.orgao || '',
      'Modalidade': it.modalidadeNome || '',
      'UASG': it.uasg || '',
      'UF': it.ufSigla || '',
      'Município': it.municipioNome || '',
      'Publicação': _fmtDataBR(it.dataPublicacaoPncp),
      'Valor Estimado (R$)': it.valorUnitarioEstimado != null ? Number(it.valorUnitarioEstimado) : '',
      'Status': o.status,
      'Fornecedor': o.fornecedor,
      'CNPJ': o.cnpj,
      'Marca': o.marca,
      'Modelo': o.modelo,
      'Valor Homol. Unit. (R$)': o.vUnit,
      'Valor Homol. Total (R$)': o.vTotal,
      'Data Resultado': o.dataRes,
      'Link PNCP': `https://pncp.gov.br/app/editais/${it.cnpj}/${it.anoCompra}/${String(it.sequencialCompra).padStart(6, '0')}`,
    };
  }

  app.get('/api/bi/exportar-xlsx', async (req, res) => {
    try {
      await _ensureGrupoSeNecessario(req);
      if (!USE_PG) { return res.status(501).json({ error: 'Exportação disponível apenas no backend Postgres' }); }

      const { whereSql, joinClause, distinctClause, params, nextParam, hasResultsJoin } = _construirFiltrosPg(req.query);
      const selectResultados = hasResultsJoin
        ? `, rb."niFornecedor", rb."nomeRazaoSocialFornecedor", rb."valorUnitarioHomologado", rb."valorTotalHomologado", rb."marcaFabricante", rb."modeloVersao", rb."dataResultado"`
        : '';
      const selectOrigem = `, rbo."fonte" AS "fonteOrigem", rbo."situacaoOrigem", rbo."valorUnitarioHomologado" AS "valorOrigem"`;
      const joinOrigem = `LEFT JOIN resultados_bi rbo ON rbo."cnpj"=l."cnpj" AND rbo."ano"=l."anoCompra" AND rbo."sequencial"=l."sequencialCompra" AND rbo."numeroItem"=i."numeroItem" AND rbo."niFornecedor"='__sem_resultado__'`;

      const sql = `
        SELECT ${distinctClause}
          i."numeroItem", i."descricao" as "itemDescricao", i."quantidade", i."unidadeMedida",
          i."valorUnitarioEstimado", i."marcaExtraida",
          l."cnpj", l."anoCompra", l."sequencialCompra",
          l."razaoSocial" as orgao, l."nomeUnidade", l."codigoUnidade" as uasg,
          l."ufSigla", l."municipioNome", l."modalidadeNome", l."situacaoCompraNome",
          l."dataPublicacaoPncp", l."numeroControlePNCP"
          ${selectResultados}
          ${selectOrigem}
        FROM itens i
        JOIN licitacoes l ON i."licitacaoId" = l."id"
        ${joinClause}
        ${joinOrigem}
        WHERE ${whereSql}
        ORDER BY l."dataPublicacaoPncp" DESC
        LIMIT $${nextParam}
      `;
      const itens = await catalogPg.query(sql, [...params, EXPORT_MAX_LINHAS]);

      const XLSX = require('xlsx');
      const linhas = itens.length ? itens.map(_linhaExportXlsx) : [{ 'Item': 'Nenhum resultado para os filtros aplicados' }];
      const ws = XLSX.utils.json_to_sheet(linhas);
      ws['!cols'] = [{ wch: 50 }, { wch: 5 }, { wch: 8 }, { wch: 8 }, { wch: 30 }, { wch: 16 }, { wch: 8 }, { wch: 5 }, { wch: 18 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 34 }, { wch: 20 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 50 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, itens.length >= EXPORT_MAX_LINHAS ? `Resultados (top ${EXPORT_MAX_LINHAS})` : 'Resultados');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="inteligencia_${new Date().toISOString().slice(0, 10)}.xlsx"`);
      res.send(buf);
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error('Erro BI exportar-xlsx:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Agregados sobre o universo filtrado (Top Fornecedores/Marcas/UFs + faixa
  // de preços). Substitui o agregado client-side que só via a página atual.
  // Sempre opera sobre itens com vencedor real (rb.niFornecedor != marcador),
  // independente do status do filtro principal — top de marca/fornecedor sem
  // vencedor não tem sentido.
  // Agregados são CAROS sobre `descricao LIKE`. Estratégia:
  //   1. CTE limita o universo aos 5000 itens mais recentes que batem no filtro
  //      (sem JOIN com vencedor).
  //   2. INNER JOIN direto com resultados_bi (sem subquery correlacionada) +
  //      COUNT(DISTINCT) pra deduplicar quando há múltiplos vencedores.
  //   3. UI deve indicar que agregados são sobre amostra dos N mais recentes.
  //
  // Em testes: query de notebook que levava 54s+ → ~2-3s com CTE limitada.
  const AGG_UNIVERSE_LIMIT = 5000;

  // Função pura reusável (sem req/res): materializa temp.bi_universe a partir
  // do filtro e devolve totais + top* + mediana. Chamada pela rota HTTP de
  // aggregates E pela rota de analise-precos (que reusa a mesma temp pra
  // selecionar a amostra estratificada sem pagar o MATCH de novo).
  //
  // `keepTemp=true` → não dropa temp.bi_universe no final; chamador é
  // responsável por dropar (usado pelo analise-precos pra evitar 4 re-MATCHes
  // de ~10s cada nas queries de amostra).
  function _calcularAggregates(query, keepTemp = false) {
    const aggQuery = { ...query };
    delete aggQuery.status;
    delete aggQuery.fornecedor;
    delete aggQuery.valorHomolMin;
    delete aggQuery.valorHomolMax;
    delete aggQuery.apenasHomologados;
    const { whereSql, params } = _construirFiltros(aggQuery);

    db.exec('DROP TABLE IF EXISTS temp.bi_universe');
    try {
      db.prepare(`
        CREATE TEMP TABLE bi_universe AS
        SELECT i.id, i.licitacaoId, i.numeroItem, i.marcaExtraida,
               l.cnpj, l.anoCompra, l.sequencialCompra, l.ufSigla
          FROM itens i
          JOIN licitacoes l ON i.licitacaoId = l.id
         WHERE ${whereSql}
         ORDER BY l.dataPublicacaoPncp DESC
         LIMIT ${AGG_UNIVERSE_LIMIT}
      `).run(...params);
      db.exec('CREATE INDEX temp.idx_bi_universe_key ON bi_universe (cnpj, anoCompra, sequencialCompra, numeroItem)');

      const joinRb = `
        JOIN resultados_bi rb ON rb.cnpj = u.cnpj AND rb.ano = u.anoCompra
                             AND rb.sequencial = u.sequencialCompra
                             AND rb.numeroItem = u.numeroItem
                             AND rb.niFornecedor != '__sem_resultado__'
      `;

      const totais = db.prepare(`
        SELECT COUNT(DISTINCT u.id)                       AS itensTotal,
               COUNT(DISTINCT CASE WHEN rb.id IS NOT NULL THEN u.id END) AS itensComResultado,
               COUNT(DISTINCT rb.niFornecedor)            AS fornecedoresUnicos,
               MIN(rb.valorUnitarioHomologado)            AS precoMin,
               MAX(rb.valorUnitarioHomologado)            AS precoMax,
               AVG(rb.valorUnitarioHomologado)            AS precoMedio,
               SUM(rb.valorTotalHomologado)               AS valorTotalGlobal
          FROM temp.bi_universe u
          LEFT JOIN resultados_bi rb
            ON rb.cnpj = u.cnpj AND rb.ano = u.anoCompra
           AND rb.sequencial = u.sequencialCompra AND rb.numeroItem = u.numeroItem
           AND rb.niFornecedor != '__sem_resultado__'
      `).get();

      const topFornecedores = db.prepare(`
        SELECT rb.nomeRazaoSocialFornecedor AS nome,
               rb.niFornecedor AS cnpj,
               COUNT(DISTINCT u.id) AS itens,
               SUM(rb.valorTotalHomologado) AS valorTotal
          FROM temp.bi_universe u ${joinRb}
         GROUP BY rb.niFornecedor, rb.nomeRazaoSocialFornecedor
         ORDER BY itens DESC, valorTotal DESC
         LIMIT 50
      `).all();

      const topMarcas = db.prepare(`
        SELECT u.marcaExtraida AS marca,
               COUNT(DISTINCT u.id) AS itens,
               SUM(rb.valorTotalHomologado) AS valorTotal
          FROM temp.bi_universe u ${joinRb}
         WHERE u.marcaExtraida IS NOT NULL
         GROUP BY u.marcaExtraida
         ORDER BY itens DESC
         LIMIT 30
      `).all();

      const topUFs = db.prepare(`
        SELECT u.ufSigla AS uf,
               COUNT(DISTINCT u.id) AS itens,
               SUM(rb.valorTotalHomologado) AS valorTotal
          FROM temp.bi_universe u ${joinRb}
         WHERE u.ufSigla IS NOT NULL AND u.ufSigla != ''
         GROUP BY u.ufSigla
         ORDER BY itens DESC
         LIMIT 30
      `).all();

      const precos = db.prepare(`
        SELECT rb.valorUnitarioHomologado AS v
          FROM temp.bi_universe u ${joinRb}
         WHERE rb.valorUnitarioHomologado > 0
         ORDER BY rb.valorUnitarioHomologado
      `).all().map(r => r.v);
      const mediana = precos.length === 0 ? null : precos[Math.floor(precos.length / 2)];

      return {
        totais,
        precos: { mediana, amostra: precos.length },
        topFornecedores,
        topMarcas,
        topUFs,
        meta: {
          universeCap: AGG_UNIVERSE_LIMIT,
          truncado: totais.itensTotal === AGG_UNIVERSE_LIMIT,
        },
      };
    } finally {
      if (!keepTemp) db.exec('DROP TABLE IF EXISTS temp.bi_universe');
    }
  }

  // Postgres version: usa CTE compartilhada (planner reescreve como subquery,
  // sem precisar materializar TEMP TABLE). Tudo em paralelo via Promise.all.
  async function _calcularAggregatesPg(query) {
    const aggQuery = { ...query };
    delete aggQuery.status;
    delete aggQuery.fornecedor;
    delete aggQuery.valorHomolMin;
    delete aggQuery.valorHomolMax;
    delete aggQuery.apenasHomologados;
    const { whereSql, params } = _construirFiltrosPg(aggQuery);

    // CTE com o universo + LIMIT — cabe em cada query (postgres planner inline).
    const universeCte = `
      WITH bi_universe AS (
        SELECT i."id", i."licitacaoId", i."numeroItem", i."marcaExtraida",
               l."cnpj", l."anoCompra", l."sequencialCompra", l."ufSigla"
          FROM itens i
          JOIN licitacoes l ON i."licitacaoId" = l."id"
         WHERE ${whereSql}
         ORDER BY l."dataPublicacaoPncp" DESC
         LIMIT ${AGG_UNIVERSE_LIMIT}
      )
    `;
    const joinRb = `
      JOIN resultados_bi rb ON rb."cnpj" = u."cnpj" AND rb."ano" = u."anoCompra"
                           AND rb."sequencial" = u."sequencialCompra"
                           AND rb."numeroItem" = u."numeroItem"
                           AND rb."niFornecedor" != '__sem_resultado__'
    `;

    const [totaisRow, topFornecedores, topMarcas, topUFs, precosRows] = await Promise.all([
      catalogPg.queryOne(`${universeCte}
        SELECT COUNT(DISTINCT u."id")                       AS "itensTotal",
               COUNT(DISTINCT CASE WHEN rb."id" IS NOT NULL THEN u."id" END) AS "itensComResultado",
               COUNT(DISTINCT rb."niFornecedor")            AS "fornecedoresUnicos",
               MIN(rb."valorUnitarioHomologado")            AS "precoMin",
               MAX(rb."valorUnitarioHomologado")            AS "precoMax",
               AVG(rb."valorUnitarioHomologado")            AS "precoMedio",
               SUM(rb."valorTotalHomologado")               AS "valorTotalGlobal"
          FROM bi_universe u
          LEFT JOIN resultados_bi rb
            ON rb."cnpj" = u."cnpj" AND rb."ano" = u."anoCompra"
           AND rb."sequencial" = u."sequencialCompra" AND rb."numeroItem" = u."numeroItem"
           AND rb."niFornecedor" != '__sem_resultado__'
      `, params),
      catalogPg.query(`${universeCte}
        SELECT rb."nomeRazaoSocialFornecedor" AS nome,
               rb."niFornecedor" AS cnpj,
               COUNT(DISTINCT u."id") AS itens,
               SUM(rb."valorTotalHomologado") AS "valorTotal"
          FROM bi_universe u ${joinRb}
         GROUP BY rb."niFornecedor", rb."nomeRazaoSocialFornecedor"
         ORDER BY itens DESC, "valorTotal" DESC
         LIMIT 50
      `, params),
      catalogPg.query(`${universeCte}
        SELECT u."marcaExtraida" AS marca,
               COUNT(DISTINCT u."id") AS itens,
               SUM(rb."valorTotalHomologado") AS "valorTotal"
          FROM bi_universe u ${joinRb}
         WHERE u."marcaExtraida" IS NOT NULL
         GROUP BY u."marcaExtraida"
         ORDER BY itens DESC
         LIMIT 30
      `, params),
      catalogPg.query(`${universeCte}
        SELECT u."ufSigla" AS uf,
               COUNT(DISTINCT u."id") AS itens,
               SUM(rb."valorTotalHomologado") AS "valorTotal"
          FROM bi_universe u ${joinRb}
         WHERE u."ufSigla" IS NOT NULL AND u."ufSigla" != ''
         GROUP BY u."ufSigla"
         ORDER BY itens DESC
         LIMIT 30
      `, params),
      catalogPg.query(`${universeCte}
        SELECT rb."valorUnitarioHomologado" AS v
          FROM bi_universe u ${joinRb}
         WHERE rb."valorUnitarioHomologado" > 0
         ORDER BY rb."valorUnitarioHomologado"
      `, params),
    ]);

    const precos = precosRows.map(r => Number(r.v));
    const mediana = precos.length === 0 ? null : precos[Math.floor(precos.length / 2)];
    const totais = totaisRow || {};
    // Postgres COUNT/SUM retornam string em JS (lib pg) — converte
    return {
      totais: {
        itensTotal:        Number(totais.itensTotal || 0),
        itensComResultado: Number(totais.itensComResultado || 0),
        fornecedoresUnicos:Number(totais.fornecedoresUnicos || 0),
        precoMin:          totais.precoMin != null ? Number(totais.precoMin) : null,
        precoMax:          totais.precoMax != null ? Number(totais.precoMax) : null,
        precoMedio:        totais.precoMedio != null ? Number(totais.precoMedio) : null,
        valorTotalGlobal:  totais.valorTotalGlobal != null ? Number(totais.valorTotalGlobal) : 0,
      },
      precos: { mediana, amostra: precos.length },
      topFornecedores: topFornecedores.map(r => ({ ...r, itens: Number(r.itens), valorTotal: Number(r.valorTotal || 0) })),
      topMarcas:       topMarcas.map(r       => ({ ...r, itens: Number(r.itens), valorTotal: Number(r.valorTotal || 0) })),
      topUFs:          topUFs.map(r          => ({ ...r, itens: Number(r.itens), valorTotal: Number(r.valorTotal || 0) })),
      meta: {
        universeCap: AGG_UNIVERSE_LIMIT,
        truncado: Number(totais.itensTotal || 0) === AGG_UNIVERSE_LIMIT,
      },
    };
  }

  app.get('/api/bi/aggregates', async (req, res) => {
    try {
      await _ensureGrupoSeNecessario(req);
      if (USE_PG) return res.json(await _calcularAggregatesPg(req.query));
      res.json(_calcularAggregates(req.query));
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error('Erro BI aggregates:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Análise IA dos preços via DeepSeek. Estratégia de 3 camadas:
  //
  //  1. Cache (bi_analise_cache, TTL meia-noite): se mesma busca já foi analisada
  //     hoje, retorna direto em <100ms.
  //  2. Pré-digestão: chama _calcularAggregates() pra ter totais/top fornecedores/
  //     top marcas/top UFs/mediana JÁ CALCULADOS pelo SQL. A IA não precisa contar.
  //  3. Amostra estratificada: em vez de 30 itens recentes, pega 5 mais baratos +
  //     5 mais caros + 10 ao redor da mediana + 5 mais recentes (dedup, ~20).
  //     Cobre toda a faixa de preço pra IA inferir subtipos sem dados redundantes.
  //
  //  Output schema cortado: só {subtipos, ruido, insights, resumo_executivo}.
  //  por_marca/outliers/top fornecedores já vêm do SQL e são renderizados via
  //  /api/bi/aggregates no front. Resultado: ~1k-1.5k tokens de output (era ~3k).
  //
  //  Latência alvo: 40-60s primeira chamada, <100ms recall.
  //  Custo: ~$0.003-0.006 por análise primária; $0 nas cacheadas.
  const ANALISE_IA_MAX_TOKENS = 3000;
  const SAMPLE_LOW = 5;       // 5 mais baratos
  const SAMPLE_HIGH = 5;      // 5 mais caros
  const SAMPLE_MEDIAN = 10;   // 10 ao redor da mediana
  const SAMPLE_RECENT = 5;    // 5 mais recentes (top-up no fim)

  app.get('/api/bi/analise-precos', async (req, res) => {
    const t0 = Date.now();
    try {
      const { getIAKeys } = createConfigHelpers(db);
      const keys = getIAKeys();
      if (!keys || !keys.deepseek) {
        return res.status(400).json({
          error: 'Análise IA requer chave DeepSeek configurada em Config → API Keys',
        });
      }

      // Cache key: hash do filtro normalizado. NÃO inclui maxItens — amostra
      // estratificada é determinística pelo filtro só.
      const cacheKeyObj = { ...req.query };
      delete cacheKeyObj.maxItens;
      const queryHash = _queryHash(cacheKeyObj);
      const cached = db.prepare(`
        SELECT resposta FROM bi_analise_cache
         WHERE queryHash = ? AND expiresAt > datetime('now')
      `).get(queryHash);
      if (cached) {
        const cachedPayload = JSON.parse(cached.resposta);
        return res.json({
          ...cachedPayload,
          meta: { ...cachedPayload.meta, cache: 'hit', tempo_ms: Date.now() - t0 },
        });
      }

      // Aggregates já-calculados pelo SQL. Em SQLite usa temp.bi_universe;
      // em Postgres usa CTE inline em cada query (planner Postgres otimiza
      // bem com os índices GIN trigram + tsvector).
      let agg;
      let amostra = [];
      if (USE_PG) {
        agg = await _calcularAggregatesPg(req.query);
        if (!agg.totais || agg.totais.itensComResultado === 0) {
          return res.status(404).json({
            error: 'Nenhum item com vencedor real foi encontrado nesse filtro pra analisar.',
          });
        }

        // Refaz o WHERE pra construir o CTE inline (cada amostra é 1 query).
        const aggQuery = { ...req.query };
        delete aggQuery.status; delete aggQuery.fornecedor;
        delete aggQuery.valorHomolMin; delete aggQuery.valorHomolMax;
        delete aggQuery.apenasHomologados;
        const { whereSql, params } = _construirFiltrosPg(aggQuery);

        const universeCte = `
          WITH bi_universe AS (
            SELECT i."id", i."licitacaoId", i."numeroItem", i."marcaExtraida",
                   l."cnpj", l."anoCompra", l."sequencialCompra", l."ufSigla", l."dataPublicacaoPncp"
              FROM itens i
              JOIN licitacoes l ON i."licitacaoId" = l."id"
             WHERE ${whereSql}
             ORDER BY l."dataPublicacaoPncp" DESC
             LIMIT ${AGG_UNIVERSE_LIMIT}
          )
        `;
        const baseFrom = `
          FROM bi_universe u
          JOIN itens i ON i."id" = u."id"
          JOIN resultados_bi rb ON rb."cnpj" = u."cnpj" AND rb."ano" = u."anoCompra"
                               AND rb."sequencial" = u."sequencialCompra"
                               AND rb."numeroItem" = u."numeroItem"
                               AND rb."niFornecedor" != '__sem_resultado__'
                               AND rb."valorUnitarioHomologado" > 0`;
        const selectCols = `
          SELECT i."id" AS "itemId", i."descricao", i."quantidade", i."unidadeMedida",
                 u."ufSigla",
                 rb."nomeRazaoSocialFornecedor" AS fornecedor,
                 rb."marcaFabricante" AS marca,
                 rb."modeloVersao" AS modelo,
                 rb."valorUnitarioHomologado" AS "valorUnit",
                 u."dataPublicacaoPncp"`;

        const offsetMeio = Math.max(0, Math.floor((agg.totais.itensComResultado || 0) / 2) - Math.floor(SAMPLE_MEDIAN / 2));
        const [baratos, caros, meio, recentes] = await Promise.all([
          catalogPg.query(`${universeCte} ${selectCols} ${baseFrom} ORDER BY rb."valorUnitarioHomologado" ASC LIMIT ${SAMPLE_LOW}`, params),
          catalogPg.query(`${universeCte} ${selectCols} ${baseFrom} ORDER BY rb."valorUnitarioHomologado" DESC LIMIT ${SAMPLE_HIGH}`, params),
          catalogPg.query(`${universeCte} ${selectCols} ${baseFrom} ORDER BY rb."valorUnitarioHomologado" ASC LIMIT ${SAMPLE_MEDIAN} OFFSET ${offsetMeio}`, params),
          catalogPg.query(`${universeCte} ${selectCols} ${baseFrom} ORDER BY u."dataPublicacaoPncp" DESC LIMIT ${SAMPLE_RECENT}`, params),
        ]);

        const vistos = new Set();
        for (const lista of [baratos, meio, caros, recentes]) {
          for (const it of lista) {
            if (!vistos.has(it.itemId)) {
              vistos.add(it.itemId);
              amostra.push(it);
            }
          }
        }
      } else {
        // Legado SQLite com temp.bi_universe
        try {
          agg = _calcularAggregates(req.query, true);
          if (!agg.totais || agg.totais.itensComResultado === 0) {
            return res.status(404).json({
              error: 'Nenhum item com vencedor real foi encontrado nesse filtro pra analisar.',
            });
          }

          const baseFrom = `
            FROM temp.bi_universe u
            JOIN itens i ON i.id = u.id
            JOIN resultados_bi rb ON rb.cnpj = u.cnpj AND rb.ano = u.anoCompra
                                 AND rb.sequencial = u.sequencialCompra
                                 AND rb.numeroItem = u.numeroItem
                                 AND rb.niFornecedor != '__sem_resultado__'
                                 AND rb.valorUnitarioHomologado > 0
            JOIN licitacoes l ON l.id = i.licitacaoId`;
          const selectCols = `
            SELECT i.id AS itemId, i.descricao, i.quantidade, i.unidadeMedida,
                   u.ufSigla,
                   rb.nomeRazaoSocialFornecedor AS fornecedor,
                   rb.marcaFabricante AS marca,
                   rb.modeloVersao AS modelo,
                   rb.valorUnitarioHomologado AS valorUnit,
                   l.dataPublicacaoPncp`;

          const baratos = db.prepare(`${selectCols} ${baseFrom} ORDER BY rb.valorUnitarioHomologado ASC LIMIT ${SAMPLE_LOW}`).all();
          const caros = db.prepare(`${selectCols} ${baseFrom} ORDER BY rb.valorUnitarioHomologado DESC LIMIT ${SAMPLE_HIGH}`).all();
          const offsetMeio = Math.max(0, Math.floor((agg.totais.itensComResultado || 0) / 2) - Math.floor(SAMPLE_MEDIAN / 2));
          const meio = db.prepare(`${selectCols} ${baseFrom} ORDER BY rb.valorUnitarioHomologado ASC LIMIT ${SAMPLE_MEDIAN} OFFSET ${offsetMeio}`).all();
          const recentes = db.prepare(`${selectCols} ${baseFrom} ORDER BY l.dataPublicacaoPncp DESC LIMIT ${SAMPLE_RECENT}`).all();

          const vistos = new Set();
          for (const lista of [baratos, meio, caros, recentes]) {
            for (const it of lista) {
              if (!vistos.has(it.itemId)) {
                vistos.add(it.itemId);
                amostra.push(it);
              }
            }
          }
        } finally {
          db.exec('DROP TABLE IF EXISTS temp.bi_universe');
        }
      }

      const grupoNome = req.query.grupoId
        ? (db.prepare('SELECT nome FROM grupos_palavras WHERE id = ?').get(parseInt(req.query.grupoId, 10))?.nome || `grupo ${req.query.grupoId}`)
        : (req.query.q || 'busca livre');

      const fmtBR = v => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const t = agg.totais;
      const topMarcasTxt = (agg.topMarcas || []).slice(0, 8).map(m => `${m.marca}(${m.itens})`).join(', ') || '—';
      const topFornTxt = (agg.topFornecedores || []).slice(0, 5).map(f => f.nome).join('; ') || '—';
      const topUfTxt = (agg.topUFs || []).slice(0, 5).map(u => `${u.uf}(${u.itens})`).join(', ') || '—';

      const linhas = amostra.map((it, idx) => {
        const desc = String(it.descricao || '').replace(/\s+/g, ' ').substring(0, 160);
        const qtd = it.quantidade ? `${it.quantidade}${it.unidadeMedida ? ' ' + it.unidadeMedida : ''}` : '-';
        const marca = it.marca || '-';
        const modelo = it.modelo ? ` ${it.modelo}` : '';
        return `[${idx + 1}] ${it.ufSigla || '??'} R$ ${fmtBR(it.valorUnit)} (qtd ${qtd}) | ${marca}${modelo} | ${desc}`;
      }).join('\n');

      const prompt = `Analista de mercado de licitações: escopo "${grupoNome}".

ESTATÍSTICAS GLOBAIS (já calculadas, não precisa recontar):
- Universo: ${t.itensTotal} itens, ${t.itensComResultado} homologados, ${t.fornecedoresUnicos} fornecedores únicos.
- Preço unit: mín R$ ${fmtBR(t.precoMin)}, mediana R$ ${fmtBR(agg.precos?.mediana || 0)}, médio R$ ${fmtBR(t.precoMedio)}, máx R$ ${fmtBR(t.precoMax)}.
- Top marcas (cadastro): ${topMarcasTxt}.
- Top fornecedores: ${topFornTxt}.
- Por UF: ${topUfTxt}.

AMOSTRA ESTRATIFICADA (${amostra.length} itens cobrindo a faixa de preço):
${linhas}

Retorne JSON conciso (sem markdown):
{
  "subtipos": [ {"nome":"string curta (ex: NAS rack 2U, NAS desktop, sistema de backup)","n_itens_amostra":int,"faixa_preco":"R$ X-Y","comentario":"1 frase técnica"} ],
  "ruido": [ {"indice":int,"motivo":"por que não é ${grupoNome}"} ],
  "insights": [ "string acionável pra quem vende ${grupoNome}" ],
  "resumo_executivo": "2-3 frases sobre o que esses preços revelam"
}

Regras:
- Máximo: 6 subtipos, 6 ruido, 5 insights. Seja conciso.
- Agrupe subtipos por característica técnica (capacidade/formato/finalidade), não por marca.
- "ruido" só pra itens claramente fora do escopo. Vazio se todos coerentes.
- Insights práticos pra comercialização. Não invente dados que não estão na amostra ou nas estatísticas.`;

      const analise = await chamarDeepSeek(keys.deepseek, prompt, 1, { max_tokens: ANALISE_IA_MAX_TOKENS });
      if (!analise) {
        return res.status(502).json({
          error: 'DeepSeek não retornou resposta válida. Verifique a chave/cota.',
        });
      }

      const payload = {
        success: true,
        analise,
        agregados: agg,
        meta: {
          n_amostra: amostra.length,
          n_itens_universo: t.itensComResultado,
          modelo: 'deepseek-chat',
          tempo_ms: Date.now() - t0,
          escopo: grupoNome,
          cache: 'miss',
        },
      };

      // Cache até próxima meia-noite. Mesmo filtro no mesmo dia = mesma resposta.
      try {
        db.prepare(`
          INSERT INTO bi_analise_cache (queryHash, queryParams, resposta, dataCache, expiresAt)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP, datetime('now','start of day','+1 day'))
          ON CONFLICT(queryHash) DO UPDATE SET
            resposta = excluded.resposta,
            dataCache = CURRENT_TIMESTAMP,
            expiresAt = excluded.expiresAt
        `).run(queryHash, JSON.stringify(cacheKeyObj), JSON.stringify(payload));
      } catch (cacheErr) {
        console.warn('[bi] Falha ao gravar cache de analise:', cacheErr.message);
      }

      res.json(payload);
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error('Erro BI analise-precos:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Facets para popular selects da UI (modalidades, UFs, situações distintas).
  // Cache 30 min + stale-while-revalidate + pre-warm: o COUNT(*) GROUP BY
  // sobre 1.5M licitacoes custa ~28s na primeira execução fria. Cacheamos
  // agressivo porque a lista de modalidades/UFs/situações praticamente
  // não muda.
  let _facetsCache = null;
  let _facetsCacheAt = 0;
  let _facetsInflight = null;
  function _calcularFacets() {
    // Usa conexão direta para funcionar tanto em contexto de request
    // (Proxy resolveria para tenant DB) quanto em pre-warm/setImmediate
    // (Proxy retornaria BOOT_STUB → arrays vazios). Catalog data é a
    // mesma para todos tenants, então conexão direta é semanticamente
    // equivalente.
    const cdb = _getCatalogDirectDb();
    const modalidades = cdb.prepare(`
      SELECT modalidadeId AS id, modalidadeNome AS nome, COUNT(*) AS total
        FROM licitacoes
       WHERE modalidadeId IS NOT NULL AND modalidadeNome IS NOT NULL
       GROUP BY modalidadeId, modalidadeNome
       ORDER BY total DESC
    `).all();
    const ufs = cdb.prepare(`
      SELECT ufSigla AS uf, COUNT(*) AS total
        FROM licitacoes
       WHERE ufSigla IS NOT NULL AND ufSigla != ''
       GROUP BY ufSigla
       ORDER BY ufSigla
    `).all();
    const situacoes = cdb.prepare(`
      SELECT situacaoCompraNome AS nome, COUNT(*) AS total
        FROM licitacoes
       WHERE situacaoCompraNome IS NOT NULL
       GROUP BY situacaoCompraNome
       ORDER BY total DESC
    `).all();
    return { modalidades, ufs, situacoes };
  }

  // ============================================================
  // Classificação IA de itens (Nível 2 do filtro de ruído).
  //
  // POST /api/bi/classificar-ia?grupoId=N&maxItens=100
  //   Pega N itens do grupo AINDA não classificados (LEFT JOIN
  //   bi_item_classificacao_ia), manda em batches de 30 pro DeepSeek,
  //   persiste classificação em catalog.bi_item_classificacao_ia.
  //   Retorna { processados, restantes, totalAprovados, totalRuido }.
  //
  // GET /api/bi/classificar-ia/status?grupoId=N
  //   Retorna { total_universo, classificados, aprovados, ruido, pendentes }.
  //
  // O escopo da classificação é 'grupo_{grupoId}'. Mesmo item em outro grupo
  // (mesmo número de controle PNCP) pode ter classificação distinta —
  // catalog.db é compartilhado entre tenants mas escopo separa.
  //
  // Lock in-memory simples evita 2 classificações simultâneas no mesmo escopo
  // (que duplicariam chamadas pro DeepSeek). Não persiste entre restarts.
  const CLASSIFICAR_IA_BATCH = 15;
  const CLASSIFICAR_IA_MAX_TOKENS_BATCH = 1500;
  const _classificarLocks = new Set();

  // grupoDef: { nome, descricao, inclusoes:[], exclusoes:[] }. A definição do
  // grupo (inclusões/exclusões/descrição) é montada no handler e injetada aqui
  // pra a IA julgar conforme O GRUPO, não conforme exemplos chumbados.
  async function _classificarBatch(itens, escopo, grupoDef, deepseekKey) {
    const nome = (grupoDef && grupoDef.nome) || 'grupo';
    const linhas = itens.map((it, idx) => {
      const desc = String(it.descricao || '').replace(/\s+/g, ' ').substring(0, 220);
      return `[${idx + 1}] ${desc}`;
    }).join('\n');

    const partesDef = [];
    if (grupoDef && grupoDef.descricao) partesDef.push(`Descrição: ${grupoDef.descricao}`);
    if (grupoDef && grupoDef.inclusoes && grupoDef.inclusoes.length)
      partesDef.push(`Termos de INCLUSÃO (o grupo trata disto): ${grupoDef.inclusoes.join(', ')}`);
    if (grupoDef && grupoDef.exclusoes && grupoDef.exclusoes.length)
      partesDef.push(`Termos de EXCLUSÃO (NÃO é o grupo / é ruído): ${grupoDef.exclusoes.join(', ')}`);
    const definicao = partesDef.length ? partesDef.join('\n') : '(sem definição além do nome)';

    const prompt = `Você classifica itens de licitação pra determinar se pertencem REALMENTE ao grupo "${nome}" ou são ruído (a palavra-chave bateu, mas o item não é do grupo).

DEFINIÇÃO DO GRUPO "${nome}":
${definicao}

ITENS (formato [#] descrição):
${linhas}

Retorne JSON conciso (sem markdown):
{
  "classificacoes": [
    {"indice": 1, "eh_grupo": true|false, "motivo": "5-15 palavras"},
    ...
  ]
}

Regras:
- eh_grupo=true SÓ se o item é claramente do escopo do grupo "${nome}" conforme a definição acima (sobretudo os termos de inclusão).
- eh_grupo=false pra ruído: itens que só citam a palavra de passagem, acessórios/serviços desconexos, ou que batem nos termos de exclusão.
- Em caso de dúvida, marque false e justifique ("desc ambígua/genérica").
- TODOS os itens da lista DEVEM aparecer na resposta com o respectivo índice.`;

    const resp = await chamarDeepSeek(deepseekKey, prompt, 1, { max_tokens: CLASSIFICAR_IA_MAX_TOKENS_BATCH });
    if (!resp || !Array.isArray(resp.classificacoes)) return null;
    return resp.classificacoes;
  }

  app.post('/api/bi/classificar-ia', async (req, res) => {
    const t0 = Date.now();
    try {
      await _ensureGrupoSeNecessario(req);
      const grupoId = parseInt(req.query.grupoId, 10);
      if (!grupoId || isNaN(grupoId)) {
        return res.status(400).json({ error: 'grupoId obrigatório' });
      }
      const maxItens = Math.min(Math.max(parseInt(req.query.maxItens, 10) || 100, 30), 200);
      const escopo = `grupo_${grupoId}`;

      if (_classificarLocks.has(escopo)) {
        return res.status(409).json({ error: 'Já há classificação em andamento pra esse grupo' });
      }
      _classificarLocks.add(escopo);

      try {
        const { getIAKeys } = createConfigHelpers(db);
        const keys = getIAKeys();
        if (!keys || !keys.deepseek) {
          return res.status(400).json({ error: 'Requer chave DeepSeek configurada' });
        }

        // Definição do grupo p/ contexto do prompt da IA: nome + descrição +
        // palavras de inclusão + palavras de exclusão. Antes só o nome ia, e o
        // prompt tinha exemplos de NAS chumbados (viés pra todo grupo não-NAS).
        const grupo = db.prepare('SELECT nome, descricao, tipo FROM grupos_palavras WHERE id = ?').get(grupoId);
        if (!grupo) return res.status(404).json({ error: 'Grupo não encontrado' });
        const grupoNome = grupo.nome;
        const grupoDef = {
          nome: grupo.nome,
          descricao: grupo.descricao || '',
          inclusoes: db.prepare('SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?')
            .all(grupoId).map(r => String(r.palavra || '').trim()).filter(Boolean),
          exclusoes: (!grupo.tipo || grupo.tipo === 'pesquisa')
            ? db.prepare(`SELECT gpi.palavra FROM grupos_pesquisa_exclusao gpe
                            JOIN grupos_palavras_itens gpi ON gpi.grupoId = gpe.grupoExclusaoId
                           WHERE gpe.grupoPesquisaId = ?`).all(grupoId).map(r => String(r.palavra || '').trim()).filter(Boolean)
            : [],
        };

        let itens, restantes, processados = 0, aprovados = 0, ruido = 0, errosBatch = 0;

        if (USE_PG) {
          // PG path: usa _construirFiltrosPg ($N), insere via catalogPg
          const { whereSql, params } = _construirFiltrosPg({ grupoId });
          const escopoIdx = params.length + 1;
          const limitIdx = params.length + 2;
          const itensSql = `
            SELECT i."id" AS "itemId", i."descricao" AS descricao
              FROM itens i
              JOIN licitacoes l ON i."licitacaoId" = l."id"
         LEFT JOIN bi_item_classificacao_ia c ON c."itemId" = i."id" AND c."escopo" = $${escopoIdx}
             WHERE ${whereSql}
               AND COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") < now()
               AND c."id" IS NULL
          ORDER BY l."dataPublicacaoPncp" DESC
             LIMIT $${limitIdx}
          `;
          itens = await catalogPg.query(itensSql, [...params, escopo, maxItens]);
          if (itens.length === 0) {
            return res.json({ processados: 0, restantes: 0, msg: 'Nada a classificar' });
          }

          for (let i = 0; i < itens.length; i += CLASSIFICAR_IA_BATCH) {
            const batch = itens.slice(i, i + CLASSIFICAR_IA_BATCH);
            const classifs = await _classificarBatch(batch, escopo, grupoDef, keys.deepseek);
            if (!classifs) { errosBatch++; continue; }
            await catalogPg.withTx(async (client) => {
              for (const c of classifs) {
                const idx = (c.indice || 0) - 1;
                if (idx < 0 || idx >= batch.length) continue;
                const itemId = batch[idx].itemId;
                const eh = c.eh_grupo === true || c.eh_grupo === 'true' || c.eh_grupo === 1 ? 1 : 0;
                const motivo = String(c.motivo || '').substring(0, 200);
                await client.query(
                  `INSERT INTO bi_item_classificacao_ia ("itemId","escopo","ehAprovado","motivo","modelo","classificadoEm")
                   VALUES ($1,$2,$3,$4,'deepseek-chat', now())
                   ON CONFLICT ("itemId","escopo") DO UPDATE SET
                     "ehAprovado"=EXCLUDED."ehAprovado","motivo"=EXCLUDED."motivo","classificadoEm"=now()`,
                  [itemId, escopo, eh, motivo]
                );
                if (eh) aprovados++; else ruido++;
                processados++;
              }
            });
          }

          const restIdx = params.length + 1;
          const restRow = await catalogPg.queryOne(`
            SELECT COUNT(*) AS c FROM (
              SELECT i."id"
                FROM itens i
                JOIN licitacoes l ON i."licitacaoId" = l."id"
           LEFT JOIN bi_item_classificacao_ia c ON c."itemId" = i."id" AND c."escopo" = $${restIdx}
               WHERE ${whereSql}
                 AND COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") < now()
                 AND c."id" IS NULL
            ) sub
          `, [...params, escopo]);
          restantes = Number(restRow?.c || 0);
        } else {
          // SQLite path (legado)
          const { whereSql, params } = _construirFiltros({ grupoId });
          const itensSql = `
            SELECT i.id AS itemId, i.descricao
              FROM itens i
              JOIN licitacoes l ON i.licitacaoId = l.id
              LEFT JOIN bi_item_classificacao_ia c ON c.itemId = i.id AND c.escopo = ?
             WHERE ${whereSql}
               AND l.dataEncerramentoProposta < datetime('now')
               AND c.id IS NULL
             ORDER BY l.dataPublicacaoPncp DESC
             LIMIT ?
          `;
          itens = db.prepare(itensSql).all(escopo, ...params, maxItens);

          if (itens.length === 0) {
            return res.json({ processados: 0, restantes: 0, msg: 'Nada a classificar' });
          }

          const wdb = _getCatalogWriteDb();
          const stmtUpsert = wdb.prepare(`
            INSERT OR REPLACE INTO bi_item_classificacao_ia (itemId, escopo, ehAprovado, motivo, modelo, classificadoEm)
            VALUES (?, ?, ?, ?, 'deepseek-chat', CURRENT_TIMESTAMP)
          `);

          for (let i = 0; i < itens.length; i += CLASSIFICAR_IA_BATCH) {
            const batch = itens.slice(i, i + CLASSIFICAR_IA_BATCH);
            const classifs = await _classificarBatch(batch, escopo, grupoDef, keys.deepseek);
            if (!classifs) { errosBatch++; continue; }
            const tx = wdb.transaction(() => {
              for (const c of classifs) {
                const idx = (c.indice || 0) - 1;
                if (idx < 0 || idx >= batch.length) continue;
                const itemId = batch[idx].itemId;
                const eh = c.eh_grupo === true || c.eh_grupo === 'true' || c.eh_grupo === 1 ? 1 : 0;
                const motivo = String(c.motivo || '').substring(0, 200);
                stmtUpsert.run(itemId, escopo, eh, motivo);
                if (eh) aprovados++; else ruido++;
                processados++;
              }
            });
            tx();
          }

          restantes = db.prepare(`
            SELECT COUNT(*) AS c FROM (
              SELECT i.id
                FROM itens i
                JOIN licitacoes l ON i.licitacaoId = l.id
                LEFT JOIN bi_item_classificacao_ia c ON c.itemId = i.id AND c.escopo = ?
               WHERE ${whereSql}
                 AND l.dataEncerramentoProposta < datetime('now')
                 AND c.id IS NULL
            )
          `).get(escopo, ...params).c;
        }

        res.json({
          processados, aprovados, ruido, errosBatch, restantes,
          tempo_ms: Date.now() - t0,
          escopo, grupoNome,
        });
      } finally {
        _classificarLocks.delete(escopo);
      }
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error('Erro classificar-ia:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/bi/classificar-ia/status', async (req, res) => {
    try {
      await _ensureGrupoSeNecessario(req);
      const grupoId = parseInt(req.query.grupoId, 10);
      if (!grupoId || isNaN(grupoId)) {
        return res.status(400).json({ error: 'grupoId obrigatório' });
      }
      const escopo = `grupo_${grupoId}`;

      let counts;
      if (USE_PG) {
        const { whereSql, params } = _construirFiltrosPg({ grupoId });
        const escopoIdx = params.length + 1;
        counts = await catalogPg.queryOne(`
          SELECT
            COUNT(*)::int AS total_universo,
            SUM(CASE WHEN c."id" IS NOT NULL THEN 1 ELSE 0 END)::int AS classificados,
            SUM(CASE WHEN c."ehAprovado" = 1 THEN 1 ELSE 0 END)::int AS aprovados,
            SUM(CASE WHEN c."ehAprovado" = 0 THEN 1 ELSE 0 END)::int AS ruido
            FROM itens i
            JOIN licitacoes l ON i."licitacaoId" = l."id"
       LEFT JOIN bi_item_classificacao_ia c ON c."itemId" = i."id" AND c."escopo" = $${escopoIdx}
           WHERE ${whereSql}
             AND COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") < now()
        `, [...params, escopo]);
      } else {
        const { whereSql, params } = _construirFiltros({ grupoId });
        counts = db.prepare(`
          SELECT
            COUNT(*) AS total_universo,
            SUM(CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END) AS classificados,
            SUM(CASE WHEN c.ehAprovado = 1 THEN 1 ELSE 0 END) AS aprovados,
            SUM(CASE WHEN c.ehAprovado = 0 THEN 1 ELSE 0 END) AS ruido
            FROM itens i
            JOIN licitacoes l ON i.licitacaoId = l.id
            LEFT JOIN bi_item_classificacao_ia c ON c.itemId = i.id AND c.escopo = ?
           WHERE ${whereSql}
             AND l.dataEncerramentoProposta < datetime('now')
        `).get(escopo, ...params);
      }

      res.json({
        ...counts,
        pendentes: (counts.total_universo || 0) - (counts.classificados || 0),
        escopo,
        rodando: _classificarLocks.has(escopo),
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error('Erro classificar-ia/status:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // Sugestão de produto por marca (matching pedido x catálogo).
  //
  // POST /api/bi/sugerir-produto?grupoId=N&marca=TerraMaster&maxItens=60
  //   Pra cada item APROVADO pela IA do grupo (bi_item_classificacao_ia.ehAprovado=1)
  //   e ainda sem sugestão pra essa marca (bi_item_sugestao_produto), pede pro
  //   DeepSeek extrair requisitos do edital e sugerir o modelo mais compatível.
  //   Persiste em catalog.bi_item_sugestao_produto.
  //
  // GET /api/bi/sugerir-produto/status?grupoId=N&marca=TerraMaster
  //   Retorna { universo, sugeridos, pendentes, comMatch, semMatch }.
  //
  // Lock in-memory por (escopo, marca) evita duplo processamento.
  const SUGERIR_BATCH = 8;  // Prompt maior — manter batch pequeno pra não estourar token
  const SUGERIR_MAX_TOKENS = 2200;
  const _sugerirLocks = new Set();

  async function _sugerirBatch(itens, catalogo, deepseekKey) {
    // Prompt e validação ficam em terramaster-catalog.js (fonte única, dirigida
    // pela config da marca — catalogo = linha de bi_sugestao_catalogo).
    const prompt = montarPromptSugestao(itens, catalogo);
    const resp = await chamarDeepSeek(deepseekKey, prompt, 1, { max_tokens: SUGERIR_MAX_TOKENS });
    if (!resp || !Array.isArray(resp.sugestoes)) return null;
    return validarSugestoes(resp.sugestoes, catalogo);
  }

  app.post('/api/bi/sugerir-produto', async (req, res) => {
    const t0 = Date.now();
    try {
      await _ensureGrupoSeNecessario(req);
      const grupoId = parseInt(req.query.grupoId, 10);
      const marca = String(req.query.marca || '').trim();
      if (!grupoId || isNaN(grupoId)) return res.status(400).json({ error: 'grupoId obrigatório' });
      if (!marca) return res.status(400).json({ error: 'marca obrigatória' });
      const maxItens = Math.min(Math.max(parseInt(req.query.maxItens, 10) || 60, 8), 120);
      const escopo = `grupo_${grupoId}`;
      const lockKey = `${escopo}::${marca}`;

      if (_sugerirLocks.has(lockKey)) {
        return res.status(409).json({ error: 'Já há sugestão em andamento pra esse grupo+marca' });
      }
      _sugerirLocks.add(lockKey);

      try {
        const { getIAKeys } = createConfigHelpers(db);
        const keys = getIAKeys();
        if (!keys || !keys.deepseek) return res.status(400).json({ error: 'Requer chave DeepSeek configurada' });

        const catalogo = await _carregarCatalogoMarca(marca);
        let itens, restantes, processados = 0, comMatch = 0, semMatch = 0, errosBatch = 0;

        if (USE_PG) {
          const { whereSql, params } = _construirFiltrosPg({ grupoId });
          const escIdx = params.length + 1;
          const marcaIdx = params.length + 2;
          const limitIdx = params.length + 3;
          itens = await catalogPg.query(`
            SELECT i."id" AS "itemId", i."descricao" AS descricao
              FROM itens i
              JOIN licitacoes l ON i."licitacaoId" = l."id"
              JOIN bi_item_classificacao_ia c ON c."itemId" = i."id" AND c."escopo" = $${escIdx} AND c."ehAprovado" = 1
         LEFT JOIN bi_item_sugestao_produto s ON s."itemId" = i."id" AND s."marca" = $${marcaIdx}
             WHERE ${whereSql}
               AND s."id" IS NULL
          ORDER BY l."dataPublicacaoPncp" DESC
             LIMIT $${limitIdx}
          `, [...params, escopo, marca, maxItens]);

          if (itens.length === 0) return res.json({ processados: 0, restantes: 0, msg: 'Nada a sugerir' });

          for (let i = 0; i < itens.length; i += SUGERIR_BATCH) {
            const batch = itens.slice(i, i + SUGERIR_BATCH);
            const sugestoes = await _sugerirBatch(batch, catalogo, keys.deepseek);
            if (!sugestoes) { errosBatch++; continue; }
            await catalogPg.withTx(async (client) => {
              for (const s of sugestoes) {
                const idx = (s.indice || 0) - 1;
                if (idx < 0 || idx >= batch.length) continue;
                const modelo = String(s.modelo_sugerido || 'nenhum').substring(0, 60);
                const score = parseInt(s.score, 10) || 0;
                const requisitos = String(s.requisitos || '').substring(0, 300);
                const motivo = String(s.motivo || '').substring(0, 400);
                await client.query(
                  `INSERT INTO bi_item_sugestao_produto ("itemId","marca","modelo_sugerido","score","requisitos","motivo","modelo_ia","classificadoEm")
                   VALUES ($1,$2,$3,$4,$5::jsonb,$6,'deepseek-chat', now())
                   ON CONFLICT ("itemId","marca") DO UPDATE SET
                     "modelo_sugerido"=EXCLUDED."modelo_sugerido","score"=EXCLUDED."score",
                     "requisitos"=EXCLUDED."requisitos","motivo"=EXCLUDED."motivo","classificadoEm"=now()`,
                  [batch[idx].itemId, marca, modelo, score, JSON.stringify(requisitos), motivo]
                );
                if (modelo.toLowerCase() !== 'nenhum' && score >= 50) comMatch++; else semMatch++;
                processados++;
              }
            });
          }

          const restEscIdx = params.length + 1;
          const restMarcaIdx = params.length + 2;
          const restRow = await catalogPg.queryOne(`
            SELECT COUNT(*) AS c FROM (
              SELECT i."id"
                FROM itens i
                JOIN licitacoes l ON i."licitacaoId" = l."id"
                JOIN bi_item_classificacao_ia c ON c."itemId" = i."id" AND c."escopo" = $${restEscIdx} AND c."ehAprovado" = 1
           LEFT JOIN bi_item_sugestao_produto s ON s."itemId" = i."id" AND s."marca" = $${restMarcaIdx}
               WHERE ${whereSql}
                 AND s."id" IS NULL
            ) sub
          `, [...params, escopo, marca]);
          restantes = Number(restRow?.c || 0);
        } else {
          const { whereSql, params } = _construirFiltros({ grupoId });
          const itensSql = `
            SELECT i.id AS itemId, i.descricao
              FROM itens i
              JOIN licitacoes l ON i.licitacaoId = l.id
              JOIN catalog.bi_item_classificacao_ia c ON c.itemId = i.id AND c.escopo = ? AND c.ehAprovado = 1
              LEFT JOIN catalog.bi_item_sugestao_produto s ON s.itemId = i.id AND s.marca = ?
             WHERE ${whereSql}
               AND s.id IS NULL
             ORDER BY l.dataPublicacaoPncp DESC
             LIMIT ?
          `;
          itens = db.prepare(itensSql).all(escopo, marca, ...params, maxItens);

          if (itens.length === 0) return res.json({ processados: 0, restantes: 0, msg: 'Nada a sugerir' });

          const wdb = _getCatalogWriteDb();
          const stmtUpsert = wdb.prepare(`
            INSERT OR REPLACE INTO bi_item_sugestao_produto (itemId, marca, modelo_sugerido, score, requisitos, motivo, modelo_ia, classificadoEm)
            VALUES (?, ?, ?, ?, ?, ?, 'deepseek-chat', CURRENT_TIMESTAMP)
          `);

          for (let i = 0; i < itens.length; i += SUGERIR_BATCH) {
            const batch = itens.slice(i, i + SUGERIR_BATCH);
            const sugestoes = await _sugerirBatch(batch, catalogo, keys.deepseek);
            if (!sugestoes) { errosBatch++; continue; }
            const tx = wdb.transaction(() => {
              for (const s of sugestoes) {
                const idx = (s.indice || 0) - 1;
                if (idx < 0 || idx >= batch.length) continue;
                const modelo = String(s.modelo_sugerido || 'nenhum').substring(0, 60);
                const score = parseInt(s.score, 10) || 0;
                const requisitos = String(s.requisitos || '').substring(0, 300);
                const motivo = String(s.motivo || '').substring(0, 400);
                stmtUpsert.run(batch[idx].itemId, marca, modelo, score, requisitos, motivo);
                if (modelo.toLowerCase() !== 'nenhum' && score >= 50) comMatch++; else semMatch++;
                processados++;
              }
            });
            tx();
          }

          restantes = db.prepare(`
            SELECT COUNT(*) AS c FROM (
              SELECT i.id
                FROM itens i
                JOIN licitacoes l ON i.licitacaoId = l.id
                JOIN catalog.bi_item_classificacao_ia c ON c.itemId = i.id AND c.escopo = ? AND c.ehAprovado = 1
                LEFT JOIN catalog.bi_item_sugestao_produto s ON s.itemId = i.id AND s.marca = ?
               WHERE ${whereSql}
                 AND s.id IS NULL
            )
          `).get(escopo, marca, ...params).c;
        }

        res.json({ processados, comMatch, semMatch, errosBatch, restantes, tempo_ms: Date.now() - t0, escopo, marca });
      } finally {
        _sugerirLocks.delete(lockKey);
      }
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error('Erro sugerir-produto:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/bi/sugestoes-mapa?grupoId=N&marca=TerraMaster&itemIds=1,2,3...
  // Retorna mapa { itemId: {modelo_sugerido, score, motivo, requisitos} } pra
  // overlay na tabela do frontend. Lê apenas — não chama IA.
  app.get('/api/bi/sugestoes-mapa', async (req, res) => {
    try {
      const grupoId = parseInt(req.query.grupoId, 10);
      const marca = String(req.query.marca || '').trim();
      if (!grupoId || isNaN(grupoId)) return res.status(400).json({ error: 'grupoId obrigatório' });
      if (!marca) return res.status(400).json({ error: 'marca obrigatória' });

      const idsParam = String(req.query.itemIds || '').trim();
      if (!idsParam) return res.status(400).json({ error: 'itemIds obrigatório (lista separada por vírgula)' });
      const ids = idsParam.split(',').map(x => parseInt(x, 10)).filter(x => x > 0);
      if (ids.length === 0) return res.json({ mapa: {} });
      if (ids.length > 500) return res.status(400).json({ error: 'máximo 500 itemIds por chamada' });

      let rows;
      if (USE_PG) {
        rows = await catalogPg.query(
          `SELECT "itemId","modelo_sugerido","score","motivo","requisitos"
             FROM bi_item_sugestao_produto
            WHERE "marca" = $1 AND "itemId" = ANY($2::bigint[])`,
          [marca, ids]
        );
      } else {
        const placeholders = ids.map(() => '?').join(',');
        rows = db.prepare(`
          SELECT itemId, modelo_sugerido, score, motivo, requisitos
            FROM catalog.bi_item_sugestao_produto
           WHERE marca = ? AND itemId IN (${placeholders})
        `).all(marca, ...ids);
      }

      const mapa = {};
      for (const r of rows) {
        mapa[r.itemId] = {
          modelo: r.modelo_sugerido,
          score: r.score,
          motivo: r.motivo,
          requisitos: r.requisitos,
        };
      }
      res.json({ mapa, total: rows.length, marca });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error('Erro sugestoes-mapa:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/bi/sugerir-produto/status', async (req, res) => {
    try {
      await _ensureGrupoSeNecessario(req);
      const grupoId = parseInt(req.query.grupoId, 10);
      const marca = String(req.query.marca || '').trim();
      if (!grupoId || isNaN(grupoId)) return res.status(400).json({ error: 'grupoId obrigatório' });
      if (!marca) return res.status(400).json({ error: 'marca obrigatória' });
      const escopo = `grupo_${grupoId}`;

      let counts;
      if (USE_PG) {
        const { whereSql, params } = _construirFiltrosPg({ grupoId });
        const escIdx = params.length + 1;
        const marcaIdx = params.length + 2;
        counts = await catalogPg.queryOne(`
          SELECT
            COUNT(*)::int AS universo,
            SUM(CASE WHEN s."id" IS NOT NULL THEN 1 ELSE 0 END)::int AS sugeridos,
            SUM(CASE WHEN s."score" >= 50 AND LOWER(s."modelo_sugerido") != 'nenhum' THEN 1 ELSE 0 END)::int AS "comMatch",
            SUM(CASE WHEN s."score" < 50 OR LOWER(s."modelo_sugerido") = 'nenhum' THEN 1 ELSE 0 END)::int AS "semMatch"
            FROM itens i
            JOIN licitacoes l ON i."licitacaoId" = l."id"
            JOIN bi_item_classificacao_ia c ON c."itemId" = i."id" AND c."escopo" = $${escIdx} AND c."ehAprovado" = 1
       LEFT JOIN bi_item_sugestao_produto s ON s."itemId" = i."id" AND s."marca" = $${marcaIdx}
           WHERE ${whereSql}
        `, [...params, escopo, marca]);
      } else {
        const { whereSql, params } = _construirFiltros({ grupoId });
        counts = db.prepare(`
          SELECT
            COUNT(*) AS universo,
            SUM(CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END) AS sugeridos,
            SUM(CASE WHEN s.score >= 50 AND LOWER(s.modelo_sugerido) != 'nenhum' THEN 1 ELSE 0 END) AS comMatch,
            SUM(CASE WHEN s.score < 50 OR LOWER(s.modelo_sugerido) = 'nenhum' THEN 1 ELSE 0 END) AS semMatch
            FROM itens i
            JOIN licitacoes l ON i.licitacaoId = l.id
            JOIN catalog.bi_item_classificacao_ia c ON c.itemId = i.id AND c.escopo = ? AND c.ehAprovado = 1
            LEFT JOIN catalog.bi_item_sugestao_produto s ON s.itemId = i.id AND s.marca = ?
           WHERE ${whereSql}
        `).get(escopo, marca, ...params);
      }

      res.json({
        ...counts,
        pendentes: (counts.universo || 0) - (counts.sugeridos || 0),
        escopo, marca,
        rodando: _sugerirLocks.has(`${escopo}::${marca}`),
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error('Erro sugerir-produto/status:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Postgres: 3 GROUP BY em paralelo, totalmente async (não trava event loop).
  // Mesmo schema da versão SQLite original.
  async function _calcularFacetsPg() {
    const [modalidades, ufs, situacoes] = await Promise.all([
      catalogPg.query(`
        SELECT "modalidadeId" AS id, "modalidadeNome" AS nome, COUNT(*) AS total
          FROM licitacoes
         WHERE "modalidadeId" IS NOT NULL AND "modalidadeNome" IS NOT NULL
         GROUP BY "modalidadeId", "modalidadeNome"
         ORDER BY total DESC
      `),
      catalogPg.query(`
        SELECT "ufSigla" AS uf, COUNT(*) AS total
          FROM licitacoes
         WHERE "ufSigla" IS NOT NULL AND "ufSigla" != ''
         GROUP BY "ufSigla"
         ORDER BY "ufSigla"
      `),
      catalogPg.query(`
        SELECT "situacaoCompraNome" AS nome, COUNT(*) AS total
          FROM licitacoes
         WHERE "situacaoCompraNome" IS NOT NULL
         GROUP BY "situacaoCompraNome"
         ORDER BY total DESC
      `),
    ]);
    return { modalidades, ufs, situacoes };
  }

  app.get('/api/bi/facets', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const agora = Date.now();
      // Cache fresco (30 min)
      if (_facetsCache && agora - _facetsCacheAt < 30 * 60 * 1000) {
        return res.json(_facetsCache);
      }
      // Stale-while-revalidate
      if (_facetsCache) {
        res.json(_facetsCache);
        if (!_facetsInflight) {
          _facetsInflight = (USE_PG ? _calcularFacetsPg() : Promise.resolve(_calcularFacets()))
            .then(r => { _facetsCache = r; _facetsCacheAt = Date.now(); })
            .catch(e => console.error('[BI] recalc facets falhou:', e.message))
            .finally(() => { _facetsInflight = null; });
        }
        return;
      }
      // Boot frio: paga o custo (async no PG, não bloqueia event loop)
      _facetsCache = USE_PG ? await _calcularFacetsPg() : _calcularFacets();
      _facetsCacheAt = agora;
      res.json(_facetsCache);
    } catch (error) {
      console.error('Erro BI facets:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Pre-warm dos facets em background.
  // - SQLite legado: tinha problema de travar event loop por ~1m45s (skippable via SKIP_BI_PREWARM=1)
  // - Postgres: query é async + bem indexada, prewarm não bloqueia worker
  if (process.env.SKIP_BI_PREWARM !== '1') {
    const prewarmDelay = USE_PG ? 5000 : 60000;
    setTimeout(async () => {
      try {
        _facetsCache = USE_PG ? await _calcularFacetsPg() : _calcularFacets();
        _facetsCacheAt = Date.now();
        console.log(`[BI] facets pré-aquecidos (${USE_PG ? 'pg' : 'sqlite'}): ${_facetsCache.modalidades.length} modalidades, ${_facetsCache.ufs.length} UFs, ${_facetsCache.situacoes.length} situações`);
      } catch (e) { console.warn('[BI] pre-warm facets falhou:', e.message); }
    }, prewarmDelay);
  } else {
    console.log('[BI] pre-warm facets SKIPPED (SKIP_BI_PREWARM=1)');
  }

  // Buscar resultado (vencedor) de um item específico via PNCP API
  app.get('/api/bi/resultado/:cnpj/:ano/:sequencial/:numeroItem', async (req, res) => {
    try {
      const { cnpj, ano, sequencial, numeroItem } = req.params;
      const url = `${PNCP_API_ITENS}/orgaos/${cnpj}/compras/${ano}/${sequencial}/itens/${numeroItem}/resultados`;

      const response = await axios.get(url, {
        headers: { 'Accept': 'application/json' },
        timeout: 15000
      });

      res.json(response.data || []);
    } catch (error) {
      if (error.response?.status === 404) {
        res.json([]); // Sem resultado ainda
      } else {
        console.error(`Erro BI resultado ${req.params.cnpj}/${req.params.ano}/${req.params.sequencial}/item${req.params.numeroItem}:`, error.message);
        res.status(error.response?.status || 500).json({ error: error.message });
      }
    }
  });

  // Buscar resultados em lote (até 10 itens por vez)
  // Usa cache local (resultados_bi) e só consulta PNCP para itens não cacheados
  app.post('/api/bi/resultados-lote', async (req, res) => {
    try {
      const { itens } = req.body; // [{cnpj, ano, sequencial, numeroItem}]
      if (!itens || !Array.isArray(itens) || itens.length === 0) {
        return res.status(400).json({ error: 'Lista de itens obrigatória' });
      }

      const lote = itens.slice(0, 10); // Máximo 10 por vez
      const resultados = [];

      // Fase 3e (2026-05-23): dual-stack — PG via catalogPg, SQLite via attached catalog.
      const stmtBuscarCache = USE_PG ? null : db.prepare(`
        SELECT * FROM resultados_bi WHERE cnpj = ? AND ano = ? AND sequencial = ? AND numeroItem = ?
      `);
      const stmtInserirCache = USE_PG ? null : db.prepare(`
        INSERT OR REPLACE INTO catalog.resultados_bi (cnpj, ano, sequencial, numeroItem, niFornecedor, nomeRazaoSocialFornecedor, valorUnitarioHomologado, valorTotalHomologado, marcaFabricante, modeloVersao, dataResultado, dadosCompletos)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const stmtMarcarSemResultado = USE_PG ? null : db.prepare(`
        INSERT OR IGNORE INTO catalog.resultados_bi (cnpj, ano, sequencial, numeroItem, niFornecedor, nomeRazaoSocialFornecedor)
        VALUES (?, ?, ?, ?, '__sem_resultado__', '')
      `);

      const buscarCache = async (item) => {
        if (USE_PG) {
          return await catalogPg.query(
            `SELECT * FROM resultados_bi WHERE "cnpj"=$1 AND "ano"=$2 AND "sequencial"=$3 AND "numeroItem"=$4`,
            [item.cnpj, item.ano, item.sequencial, item.numeroItem]
          );
        }
        return stmtBuscarCache.all(item.cnpj, item.ano, item.sequencial, item.numeroItem);
      };
      const inserirCache = async (item, r) => {
        if (USE_PG) {
          await catalogPg.execute(
            `INSERT INTO resultados_bi ("cnpj","ano","sequencial","numeroItem","niFornecedor","nomeRazaoSocialFornecedor","valorUnitarioHomologado","valorTotalHomologado","marcaFabricante","modeloVersao","dataResultado","dadosCompletos","dataCache")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb, now())
             ON CONFLICT ("cnpj","ano","sequencial","numeroItem","niFornecedor") DO UPDATE SET
               "nomeRazaoSocialFornecedor"=EXCLUDED."nomeRazaoSocialFornecedor",
               "valorUnitarioHomologado"=EXCLUDED."valorUnitarioHomologado",
               "valorTotalHomologado"=EXCLUDED."valorTotalHomologado",
               "marcaFabricante"=EXCLUDED."marcaFabricante",
               "modeloVersao"=EXCLUDED."modeloVersao",
               "dataResultado"=EXCLUDED."dataResultado",
               "dadosCompletos"=EXCLUDED."dadosCompletos","dataCache"=now()`,
            [item.cnpj, item.ano, item.sequencial, item.numeroItem,
             r.niFornecedor || '', r.nomeRazaoSocialFornecedor || '',
             r.valorUnitarioHomologado || null, r.valorTotalHomologado || null,
             r.marcaFabricante || r.marca || '', r.modeloVersao || '',
             r.dataResultado || null, JSON.stringify(r)]
          );
        } else {
          stmtInserirCache.run(
            item.cnpj, item.ano, item.sequencial, item.numeroItem,
            r.niFornecedor || '', r.nomeRazaoSocialFornecedor || '',
            r.valorUnitarioHomologado || null, r.valorTotalHomologado || null,
            r.marcaFabricante || r.marca || '', r.modeloVersao || '',
            r.dataResultado || '', JSON.stringify(r)
          );
        }
      };
      const marcarSemResultado = async (item) => {
        if (USE_PG) {
          await catalogPg.execute(
            `INSERT INTO resultados_bi ("cnpj","ano","sequencial","numeroItem","niFornecedor","nomeRazaoSocialFornecedor","dataCache")
             VALUES ($1,$2,$3,$4,'__sem_resultado__','', now())
             ON CONFLICT ("cnpj","ano","sequencial","numeroItem","niFornecedor") DO NOTHING`,
            [item.cnpj, item.ano, item.sequencial, item.numeroItem]
          );
        } else {
          stmtMarcarSemResultado.run(item.cnpj, item.ano, item.sequencial, item.numeroItem);
        }
      };

      for (const item of lote) {
        const cached = await buscarCache(item);
        if (cached.length > 0) {
          // Filtrar marcador de sem_resultado
          const reais = cached.filter(c => c.niFornecedor !== '__sem_resultado__');
          resultados.push({
            cnpj: item.cnpj,
            ano: item.ano,
            sequencial: item.sequencial,
            numeroItem: item.numeroItem,
            resultados: reais.map(c => ({
              niFornecedor: c.niFornecedor,
              nomeRazaoSocialFornecedor: c.nomeRazaoSocialFornecedor,
              valorUnitarioHomologado: c.valorUnitarioHomologado,
              valorTotalHomologado: c.valorTotalHomologado,
              marcaFabricante: c.marcaFabricante,
              modeloVersao: c.modeloVersao,
              dataResultado: c.dataResultado
            })),
            cache: true
          });
          continue;
        }

        // Sem cache — consultar PNCP
        try {
          const url = `${PNCP_API_ITENS}/orgaos/${item.cnpj}/compras/${item.ano}/${item.sequencial}/itens/${item.numeroItem}/resultados`;
          const response = await axios.get(url, {
            headers: { 'Accept': 'application/json' },
            timeout: 10000
          });
          const resData = response.data || [];
          resultados.push({
            cnpj: item.cnpj,
            ano: item.ano,
            sequencial: item.sequencial,
            numeroItem: item.numeroItem,
            resultados: resData
          });
          // Salvar no cache
          if (resData.length > 0) {
            for (const r of resData) await inserirCache(item, r);
          } else {
            await marcarSemResultado(item);
          }
        } catch (err) {
          resultados.push({
            cnpj: item.cnpj,
            ano: item.ano,
            sequencial: item.sequencial,
            numeroItem: item.numeroItem,
            resultados: [],
            erro: err.response?.status === 404 ? 'sem_resultado' : err.message
          });
          // Marcar sem resultado no cache para 404
          if (err.response?.status === 404) await marcarSemResultado(item);
        }
        // Pequeno delay entre chamadas para não sobrecarregar PNCP
        await new Promise(r => setTimeout(r, 100));
      }

      res.json({ resultados });
    } catch (error) {
      console.error('Erro BI resultados-lote:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Buscar resultados via Dados Abertos Compras.gov.br (seção 10.7 do manual v2.0)
  // Pode retornar marca/modelo que o PNCP não tem
  app.get('/api/bi/dadosabertos/resultados', async (req, res) => {
    try {
      const { cnpj, ano, sequencial, pagina = 1 } = req.query;

      // Construir o numeroControlePNCP no formato esperado
      const numControle = cnpj && ano && sequencial
        ? `${cnpj}-${ano}-${String(sequencial).padStart(6, '0')}`
        : null;

      const params = { pagina, tamanhoPagina: 50 };
      if (numControle) params.numeroControlePNCP = numControle;

      const url = `https://dadosabertos.compras.gov.br/modulo-contratacao/3_consultarResultadoItemContratacaoPncp14133`;
      const response = await axios.get(url, {
        params,
        headers: { 'Accept': 'application/json' },
        timeout: 15000
      });

      res.json(response.data || {});
    } catch (error) {
      if (error.response?.status === 404) {
        res.json({ resultado: [], totalRegistros: 0 });
      } else {
        console.error('Erro BI dadosabertos:', error.message);
        res.status(error.response?.status || 500).json({ error: error.message });
      }
    }
  });

  // Buscar itens de contratações via Dados Abertos (seção 10.6)
  // Permite pesquisa por descrição com marca/modelo nos resultados
  app.get('/api/bi/dadosabertos/itens', async (req, res) => {
    try {
      const { descricao, pagina = 1, tamanhoPagina = 50 } = req.query;
      const queryParams = {
        descricao: descricao || null,
        pagina: parseInt(pagina) || 1,
        tamanhoPagina: Math.min(parseInt(tamanhoPagina) || 50, 100),
      };
      const result = await servirComCache({
        endpoint: 'dadosabertos-itens',
        queryParams,
        apiCall: async () => {
          const params = { pagina: queryParams.pagina, tamanhoPagina: queryParams.tamanhoPagina };
          if (queryParams.descricao) params.descricaoItem = queryParams.descricao;
          const r = await axios.get(
            'https://dadosabertos.compras.gov.br/modulo-contratacao/2_consultarItemContratacaoPncp14133',
            { params, headers: { 'Accept': 'application/json' }, timeout: 15000 }
          );
          return r.data || {};
        },
      });
      res.json({ ...result.data, _cache: result.cache });
    } catch (error) {
      console.error('Erro BI dadosabertos itens:', error.message);
      res.status(error.response?.status || 500).json({ error: error.message });
    }
  });

  // Pesquisa de Preço - histórico de preços praticados (tem marca/modelo)
  app.get('/api/bi/pesquisa-preco', async (req, res) => {
    try {
      const { descricao, codigoItem, pagina = 1, tamanhoPagina = 50 } = req.query;
      const queryParams = {
        descricao: descricao || null,
        codigoItem: codigoItem || null,
        pagina: parseInt(pagina) || 1,
        tamanhoPagina: Math.min(parseInt(tamanhoPagina) || 50, 100),
      };
      const result = await servirComCache({
        endpoint: 'pesquisa-preco',
        queryParams,
        apiCall: async () => {
          const params = { pagina: queryParams.pagina, tamanhoPagina: queryParams.tamanhoPagina };
          if (queryParams.descricao) params.descricaoItem = queryParams.descricao;
          if (queryParams.codigoItem) params.codigoItemCatalogo = queryParams.codigoItem;
          const r = await axios.get(
            'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarPesquisaPrecoMaterial',
            { params, headers: { 'Accept': 'application/json' }, timeout: 15000 }
          );
          return r.data || {};
        },
      });
      res.json({ ...result.data, _cache: result.cache });
    } catch (error) {
      console.error('Erro BI pesquisa-preco:', error.message);
      res.status(error.response?.status || 500).json({ error: error.message });
    }
  });

  // Plano 10: status do backfill de resultados_bi (master escreve, worker lê).
  // Cache 5min: a página chama isso a cada 60s — sem cache cada chamada custa
  // 45s+ por causa dos COUNT(*) sobre 4.6M itens / 1.9M resultados_bi.
  let _statusCache = null;
  let _statusCacheAt = 0;
  let _statusInflight = null;
  function _calcularStatus() {
    // Conexão direta — ver comentário em _calcularFacets sobre por quê.
    const cdb = _getCatalogDirectDb();
    const totalCacheados = cdb.prepare(`SELECT COUNT(*) c FROM resultados_bi`).get().c;
    const comResultado = cdb.prepare(`SELECT COUNT(*) c FROM resultados_bi WHERE niFornecedor != '__sem_resultado__'`).get().c;
    const totalItens = cdb.prepare(`
      SELECT COUNT(*) c FROM itens i
      JOIN licitacoes l ON l.id = i.licitacaoId
      WHERE l.dataEncerramentoProposta < datetime('now')
    `).get().c;
    const lastRun = cdb.prepare(`SELECT value FROM catalog_sync_state WHERE key = 'resultadosBackfillLastRun'`).get();
    const contador = cdb.prepare(`SELECT value FROM catalog_sync_state WHERE key = 'resultadosBackfillCount'`).get();
    const erros = cdb.prepare(`SELECT value FROM catalog_sync_state WHERE key = 'resultadosBackfillErrors'`).get();
    const dadosAbertosEntradas = cdb.prepare(`SELECT COUNT(*) c FROM dadosabertos_cache`).get().c;
    const uma24h = cdb.prepare(`
      SELECT COUNT(*) c FROM resultados_bi WHERE dataCache > datetime('now','-24 hours')
    `).get().c;
    const pendentes = totalItens - totalCacheados;
    const etaDias = uma24h > 0 && pendentes > 0 ? Math.ceil(pendentes / uma24h) : null;
    const totalItensCatalog = cdb.prepare(`SELECT COUNT(*) c FROM itens`).get().c;
    const itensComMarca = cdb.prepare(`SELECT COUNT(*) c FROM itens WHERE marcaExtraida IS NOT NULL`).get().c;
    const itensProcessados = cdb.prepare(`SELECT COUNT(*) c FROM itens WHERE marcaExtraidaEm IS NOT NULL`).get().c;
    const marcaLastRun = cdb.prepare(`SELECT value FROM catalog_sync_state WHERE key = 'marcaBackfillLastRun'`).get();
    return { totalCacheados, comResultado, totalItens, lastRun, contador, erros,
      dadosAbertosEntradas, uma24h, pendentes, etaDias,
      totalItensCatalog, itensComMarca, itensProcessados, marcaLastRun };
  }

  // Versão Postgres do _calcularStatus (espelha _calcularFacetsPg): async, NÃO
  // trava o event loop. Os COUNT(*) de tabela inteira (itens ~17M, resultados_bi
  // ~3.5M) levam 30-80s no PG e estouram o statement_timeout=30s — então usa
  // estimativa `reltuples` (instantânea, ~1% de erro, adequada pra barra de
  // progresso) nos totalizadores de tabela inteira, e contagem exata só nos
  // filtros baratos (<10s). Derivados: itens encerrados = est − itens-de-abertas
  // (poucas, índice idx_lic_encerramento); itens processados = est − count(NULL)
  // (índice parcial idx_itens_marca_pend).
  // Estimativa reltuples de qualquer relação (tabela `r` ou índice `i`/`p`).
  // Pra índice PARCIAL, reltuples ≈ nº de linhas que casam o WHERE do índice —
  // usado pra estimar count(marcaExtraidaEm IS NULL) via idx_itens_marca_pend
  // sem varrer 8.3M linhas (scan de ~9s que estourava o query_timeout no boot
  // quando várias rodavam concorrentes no Promise.all).
  async function _estReltuples(relname) {
    const r = await catalogPg.queryOne(
      `SELECT reltuples::bigint AS est FROM pg_class WHERE relname = $1 AND relkind IN ('r','i','p')`, [relname]);
    return Math.max(0, Number(r?.est || 0));
  }
  async function _calcularStatusPg() {
    const [
      estResultadosBi, comResultadoRow, itensAbertasRow, lastRun, contador, erros,
      dadosAbertosRow, uma24hRow, estItens, itensComMarcaRow, estItensNull, marcaLastRun,
    ] = await Promise.all([
      _estReltuples('resultados_bi'),
      catalogPg.queryOne(`SELECT COUNT(*) AS c FROM resultados_bi WHERE "niFornecedor" != '__sem_resultado__'`),
      catalogPg.queryOne(`SELECT COUNT(*) AS c FROM itens i JOIN licitacoes l ON l.id = i."licitacaoId" WHERE COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") >= now()`),
      catalogPg.queryOne(`SELECT "value" FROM catalog_sync_state WHERE "key" = 'resultadosBackfillLastRun'`),
      catalogPg.queryOne(`SELECT "value" FROM catalog_sync_state WHERE "key" = 'resultadosBackfillCount'`),
      catalogPg.queryOne(`SELECT "value" FROM catalog_sync_state WHERE "key" = 'resultadosBackfillErrors'`),
      catalogPg.queryOne(`SELECT COUNT(*) AS c FROM dadosabertos_cache`),
      catalogPg.queryOne(`SELECT COUNT(*) AS c FROM resultados_bi WHERE "dataCache" > now() - interval '24 hours'`),
      _estReltuples('itens'),
      catalogPg.queryOne(`SELECT COUNT(*) AS c FROM itens WHERE "marcaExtraida" IS NOT NULL`),
      _estReltuples('idx_itens_marca_pend'),
      catalogPg.queryOne(`SELECT "value" FROM catalog_sync_state WHERE "key" = 'marcaBackfillLastRun'`),
    ]);

    const totalCacheados = estResultadosBi;
    const comResultado = Number(comResultadoRow?.c || 0);
    const totalItensCatalog = estItens;
    const totalItens = Math.max(0, totalItensCatalog - Number(itensAbertasRow?.c || 0));
    const dadosAbertosEntradas = Number(dadosAbertosRow?.c || 0);
    const uma24h = Number(uma24hRow?.c || 0);
    const itensComMarca = Number(itensComMarcaRow?.c || 0);
    const itensProcessados = Math.max(0, totalItensCatalog - estItensNull);
    const pendentes = totalItens - totalCacheados;
    const etaDias = uma24h > 0 && pendentes > 0 ? Math.ceil(pendentes / uma24h) : null;

    return { totalCacheados, comResultado, totalItens, lastRun, contador, erros,
      dadosAbertosEntradas, uma24h, pendentes, etaDias,
      totalItensCatalog, itensComMarca, itensProcessados, marcaLastRun };
  }

  function _serializarStatus(s) {
    return {
      success: true,
      resultadosBi: {
        cacheadosTotal: s.totalCacheados,
        comResultado: s.comResultado,
        totalItensEncerrados: s.totalItens,
        pendentes: s.pendentes,
        progresso: s.totalItens > 0 ? s.totalCacheados / s.totalItens : 0,
        lastRun: s.lastRun ? s.lastRun.value : null,
        contador: s.contador ? parseInt(s.contador.value, 10) || 0 : 0,
        erros: s.erros ? parseInt(s.erros.value, 10) || 0 : 0,
        ultimas24h: s.uma24h,
        etaDias: s.etaDias,
      },
      marcaBackfill: {
        totalItens: s.totalItensCatalog,
        processados: s.itensProcessados,
        pendentes: s.totalItensCatalog - s.itensProcessados,
        comMarca: s.itensComMarca,
        progresso: s.totalItensCatalog > 0 ? s.itensProcessados / s.totalItensCatalog : 0,
        taxaCaptura: s.itensProcessados > 0 ? s.itensComMarca / s.itensProcessados : 0,
        lastRun: s.marcaLastRun ? s.marcaLastRun.value : null,
      },
      dadosAbertos: { entradasCache: s.dadosAbertosEntradas },
    };
  }

  app.get('/api/bi/backfill-status', async (req, res) => {
    try {
      const agora = Date.now();
      // Cache hit
      if (_statusCache && agora - _statusCacheAt < 5 * 60 * 1000) {
        return res.json(_serializarStatus(_statusCache));
      }
      // Cache stale-while-revalidate: serve cache antigo enquanto recalcula
      // em background. Só a primeira chamada absoluta paga o custo total.
      if (_statusCache) {
        res.json(_serializarStatus(_statusCache));
        if (!_statusInflight) {
          _statusInflight = setImmediate(async () => {
            try { _statusCache = USE_PG ? await _calcularStatusPg() : _calcularStatus(); _statusCacheAt = Date.now(); }
            catch (e) { console.error('[BI] recalc status falhou:', e.message); }
            finally { _statusInflight = null; }
          });
        }
        return;
      }
      // Sem cache (boot frio): paga o custo uma vez
      _statusCache = USE_PG ? await _calcularStatusPg() : _calcularStatus();
      _statusCacheAt = agora;
      res.json(_serializarStatus(_statusCache));
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Pre-warm: dispara o cálculo de status logo após o boot, sem esperar
  // a primeira request. Reduz o "primeiro acesso lento" pra zero.
  // No modo PG roda async (não trava o event loop); no SQLite legado o
  // _calcularStatus síncrono varria o catalog.db de 35GB e bloqueava o boot.
  setTimeout(async () => {
    try { _statusCache = USE_PG ? await _calcularStatusPg() : _calcularStatus(); _statusCacheAt = Date.now();
          console.log(`[BI] backfill-status pré-aquecido (${USE_PG ? 'pg' : 'sqlite'})`); }
    catch (e) { console.warn('[BI] pre-warm status falhou:', e.message); }
  }, 5000);

  // Marcas disponíveis (para popular o select/autocomplete da UI)
  let _marcasCache = null;
  let _marcasCacheAt = 0;
  app.get('/api/bi/marcas-disponiveis', (req, res) => {
    try {
      const agora = Date.now();
      if (_marcasCache && agora - _marcasCacheAt < 5 * 60 * 1000) {
        return res.json(_marcasCache);
      }
      const rows = db.prepare(`
        SELECT marcaExtraida AS marca, COUNT(*) AS total
          FROM itens
         WHERE marcaExtraida IS NOT NULL
         GROUP BY marcaExtraida
         ORDER BY total DESC
         LIMIT 200
      `).all();
      _marcasCache = { marcas: rows };
      _marcasCacheAt = agora;
      res.json(_marcasCache);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[BI] Rotas registradas');
}

module.exports = { registrarRotasBi };
