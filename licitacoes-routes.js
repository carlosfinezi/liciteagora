/**
 * licitacoes-routes.js
 * ------------------------------------------------------------------
 * Extraído do server.js (NFSE-M06 onda 6.29).
 *
 * 5 rotas do catálogo PNCP (consulta + itens + sync pontual):
 *   - GET  /api/licitacoes
 *   - GET  /api/licitacoes/:cnpj/:sequencial/:ano
 *   - GET  /api/orgaos
 *   - GET  /api/licitacoes/:cnpj/:sequencial/:ano/itens
 *   - POST /api/licitacoes/:cnpj/:sequencial/:ano/sync-itens
 *
 * Assinatura: registrarRotasLicitacoes(app, db, {
 *               pncpSync,
 *               salvarItens,
 *               PNCP_API_BASE,
 *               PNCP_API_ITENS
 *             })
 *
 * Observações:
 *   - axios entra como require top-level aqui mesmo (mesma instância
 *     usada pelo server.js; compartilhada via require cache).
 *   - `db`, `salvarItens` (do createPersistence) e `pncpSync`
 *     (sync-scheduler) vêm via closure.
 *   - O grande handler GET /api/licitacoes monta WHERE dinâmico baseado
 *     em query params; copiado byte-a-byte para evitar regressão.
 */

const axios = require('axios');

// Fase 3g (2026-05-23): leitura de catalog (licitacoes/itens) via PG quando
// CATALOG_BACKEND_PG=1. Helper abaixo transforma SQL SQLite genérico em PG
// — quota camelCase + troca ? por $N — pra reaproveitar builder dinâmico.
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

// Colunas das tabelas catalog que precisam de quoting em PG (case-sensitive).
const _CATALOG_QUOTED_COLS = [
  'numeroControlePNCP','razaoSocial','ufSigla','municipioNome','nomeUnidade','codigoUnidade',
  'anoCompra','sequencialCompra','numeroCompra','modalidadeId','modalidadeNome','objetoCompra',
  'informacaoComplementar','valorTotalEstimado','dataPublicacaoPncp','dataAberturaProposta',
  'dataEncerramentoPortal','dataEncerramentoProposta','situacaoCompraNome','linkSistemaOrigem','usuarioNome','dadosCompletos',
  'dataAtualizacao','licitacaoId','numeroItem','unidadeMedida','valorUnitarioEstimado','valorTotal',
  'marcaExtraida','marcaConfianca','marcaExtraidaEm','niFornecedor','nomeRazaoSocialFornecedor',
  'valorUnitarioHomologado','valorTotalHomologado','marcaFabricante','modeloVersao',
  'dataResultado','dataCache',
];
const _CATALOG_QUOTE_RE = new RegExp(`\\b(${_CATALOG_QUOTED_COLS.join('|')})\\b`, 'g');

function _sqliteToPg(sql) {
  // Auto-quota colunas camelCase + datetime('now') → now() + LIKE → ILIKE
  // (SQLite LIKE é case-insensitive ASCII por default; PG LIKE é case-sensitive
  // — ILIKE é o equivalente mais próximo.)
  let out = sql.replace(_CATALOG_QUOTE_RE, '"$1"');
  out = out.replace(/datetime\(\s*'now'\s*\)/g, 'now()');
  out = out.replace(/\bLIKE\b/gi, 'ILIKE');
  return out;
}

function _placeholdize(sql) {
  // Substitui ? por $1, $2, ... mantendo ordem
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

function _pgSql(sql) {
  return _placeholdize(_sqliteToPg(sql));
}

function registrarRotasLicitacoes(app, db, opts = {}) {
  const { pncpSync, salvarItens, PNCP_API_BASE, PNCP_API_ITENS } = opts;

  /**
   * Endpoint para buscar licitações do banco local
   */
  app.get('/api/licitacoes', async (req, res) => {
    try {
      let {
        dataAberturaInicial,
        dataAberturaFinal,
        dataPublicacaoInicial,
        dataPublicacaoFinal,
        palavraChave,
        palavraExclusao,
        grupoExclusaoId,
        codigoModalidadeContratacao,
        uf,
        municipio,
        buscaDetalhada,
        numeroLicitacao,
        uasg,
        ordenacao,
        pagina = 1,
        tamanhoPagina = 50
      } = req.query;

      const usarBuscaDetalhada = buscaDetalhada === 'true';

      // Limitar tamanho da página (evitar queries pesadas)
      tamanhoPagina = Math.min(parseInt(tamanhoPagina) || 50, 100);

      // Configurar ordenação. NULLS LAST nativo do PG/SQLite — usar CASE WHEN
      // quebra SELECT DISTINCT no PG (expressão derivada fora do select list).
      const ordenacaoValida = {
        'dataEncerramentoProposta_asc': 'COALESCE(dataEncerramentoPortal, dataEncerramentoProposta) ASC NULLS LAST',
        'dataEncerramentoProposta_desc': 'COALESCE(dataEncerramentoPortal, dataEncerramentoProposta) DESC NULLS LAST',
        'dataPublicacaoPncp_asc': 'dataPublicacaoPncp ASC NULLS LAST',
        'dataPublicacaoPncp_desc': 'dataPublicacaoPncp DESC NULLS LAST',
        'valorTotalEstimado_asc': 'valorTotalEstimado ASC NULLS LAST',
        'valorTotalEstimado_desc': 'valorTotalEstimado DESC NULLS LAST'
      };
      const orderBy = ordenacaoValida[ordenacao] || 'COALESCE(dataEncerramentoPortal, dataEncerramentoProposta) ASC NULLS LAST';

      // Versão com alias 'l.' para queries com JOIN
      const ordenacaoValidaAlias = {
        'dataEncerramentoProposta_asc': 'COALESCE(l.dataEncerramentoPortal, l.dataEncerramentoProposta) ASC NULLS LAST',
        'dataEncerramentoProposta_desc': 'COALESCE(l.dataEncerramentoPortal, l.dataEncerramentoProposta) DESC NULLS LAST',
        'dataPublicacaoPncp_asc': 'l.dataPublicacaoPncp ASC NULLS LAST',
        'dataPublicacaoPncp_desc': 'l.dataPublicacaoPncp DESC NULLS LAST',
        'valorTotalEstimado_asc': 'l.valorTotalEstimado ASC NULLS LAST',
        'valorTotalEstimado_desc': 'l.valorTotalEstimado DESC NULLS LAST'
      };
      const orderByAlias = ordenacaoValidaAlias[ordenacao] || 'COALESCE(l.dataEncerramentoPortal, l.dataEncerramentoProposta) ASC NULLS LAST';

      // Versão simplificada para JavaScript sort
      const orderBySimple = {
        'dataEncerramentoProposta_asc': { field: 'dataEncerramentoProposta', dir: 'ASC' },
        'dataEncerramentoProposta_desc': { field: 'dataEncerramentoProposta', dir: 'DESC' },
        'dataPublicacaoPncp_asc': { field: 'dataPublicacaoPncp', dir: 'ASC' },
        'dataPublicacaoPncp_desc': { field: 'dataPublicacaoPncp', dir: 'DESC' },
        'valorTotalEstimado_asc': { field: 'valorTotalEstimado', dir: 'ASC' },
        'valorTotalEstimado_desc': { field: 'valorTotalEstimado', dir: 'DESC' }
      };
      const orderConfig = orderBySimple[ordenacao] || { field: 'dataEncerramentoProposta', dir: 'ASC' };

      let conditions = [];
      let params = [];

      // Filtro por número da licitação
      if (numeroLicitacao) {
        conditions.push("(numeroCompra LIKE ? OR numeroCompra = ?)");
        params.push('%' + numeroLicitacao + '%', numeroLicitacao);
      }

      // Filtro por UASG (padded to 6 digits for exact match, also try without padding)
      if (uasg) {
        const uasgPadded = uasg.padStart(6, '0');
        conditions.push("(codigoUnidade = ? OR codigoUnidade = ?)");
        params.push(uasg, uasgPadded);
      }

      if (dataAberturaInicial) {
        conditions.push('COALESCE(dataEncerramentoPortal, dataEncerramentoProposta) >= ?');
        params.push(dataAberturaInicial);
      }
      if (dataAberturaFinal) {
        conditions.push('COALESCE(dataEncerramentoPortal, dataEncerramentoProposta) <= ?');
        params.push(dataAberturaFinal + 'T23:59:59');
      }

      // Filtro por data de publicação
      if (dataPublicacaoInicial) {
        conditions.push('dataPublicacaoPncp >= ?');
        params.push(dataPublicacaoInicial);
      }
      if (dataPublicacaoFinal) {
        conditions.push('dataPublicacaoPncp <= ?');
        params.push(dataPublicacaoFinal + 'T23:59:59');
      }

      if (codigoModalidadeContratacao) {
        conditions.push('modalidadeId = ?');
        params.push(parseInt(codigoModalidadeContratacao));
      }

      if (uf) {
        conditions.push('ufSigla = ?');
        params.push(uf.toUpperCase());
      }

      if (municipio && String(municipio).trim()) {
        conditions.push('municipioNome LIKE ?');
        params.push(`%${String(municipio).trim()}%`);
      }

      // Filtro por portal/sistema (usa linkSistemaOrigem e usuarioNome)
      const { portal } = req.query;
      if (portal) {
        switch (portal) {
          case 'comprasnet':
            // Compras.gov.br / Comprasnet
            conditions.push("(linkSistemaOrigem LIKE '%comprasnet%' OR linkSistemaOrigem LIKE '%compras.gov%' OR linkSistemaOrigem LIKE '%cnetmobile%' OR LOWER(usuarioNome) = 'compras.gov.br')");
            break;
          case 'portalcompras':
            // Portal de Compras Públicas (Governança Brasil)
            conditions.push("(linkSistemaOrigem LIKE '%portaldecompraspublicas%' OR LOWER(usuarioNome) LIKE '%governançabrasil%' OR LOWER(usuarioNome) LIKE '%governancabrasil%')");
            break;
          case 'licitacoese':
            // Licitações-e (Banco do Brasil)
            conditions.push("(linkSistemaOrigem LIKE '%licitacoes-e%' OR linkSistemaOrigem LIKE '%bb.com%' OR LOWER(usuarioNome) LIKE '%licitacoes-e%' OR LOWER(usuarioNome) LIKE '%banco do brasil%')");
            break;
          case 'bll':
            // BLL Compras / BNC
            conditions.push("(linkSistemaOrigem LIKE '%bll.org%' OR linkSistemaOrigem LIKE '%bllcompras%' OR linkSistemaOrigem LIKE '%bnccompras%' OR LOWER(usuarioNome) LIKE '%bll compras%' OR LOWER(usuarioNome) LIKE '%bolsa nacional de compras%')");
            break;
          case 'licitardigital':
            // Licitar Digital
            conditions.push("(linkSistemaOrigem LIKE '%licitardigital%' OR linkSistemaOrigem LIKE '%app2-compras.licita%' OR LOWER(usuarioNome) LIKE '%licitar digital%')");
            break;
          case 'licitanet':
            // Licitanet
            conditions.push("(linkSistemaOrigem LIKE '%licitanet%' OR LOWER(usuarioNome) LIKE '%licitanet%')");
            break;
          case 'banrisul':
            // Pregão Banrisul
            conditions.push("(linkSistemaOrigem LIKE '%pregaobanrisul%' OR LOWER(usuarioNome) LIKE '%banrisul%')");
            break;
          case 'comprasrs':
            // Compras RS
            conditions.push("(linkSistemaOrigem LIKE '%compras.rs.gov%' OR LOWER(usuarioNome) LIKE '%compras rs%' OR LOWER(usuarioNome) LIKE '%rio grande do sul%')");
            break;
          case 'comprasmg':
            // Portal Compras MG
            conditions.push("(linkSistemaOrigem LIKE '%compras.mg.gov%' OR LOWER(usuarioNome) LIKE '%minas gerais%' OR LOWER(usuarioNome) LIKE '%compras mg%')");
            break;
          case 'compraspa':
            // Compras Pará
            conditions.push("(LOWER(usuarioNome) LIKE '%compras pará%' OR LOWER(usuarioNome) LIKE '%compras para%')");
            break;
          case 'centralpb':
            // Central de Compras da Paraíba
            conditions.push("(LOWER(usuarioNome) LIKE '%central de compras da paraíba%' OR LOWER(usuarioNome) LIKE '%central de compras da paraiba%')");
            break;
          case 'outros':
            // Outros sistemas (inclui sistemas municipais: Fiorilli, IPM, Betha, etc.)
            conditions.push("(linkSistemaOrigem IS NOT NULL OR usuarioNome IS NOT NULL) AND NOT (linkSistemaOrigem LIKE '%comprasnet%' OR linkSistemaOrigem LIKE '%compras.gov%' OR LOWER(usuarioNome) = 'compras.gov.br' OR LOWER(usuarioNome) LIKE '%governançabrasil%' OR LOWER(usuarioNome) LIKE '%bll compras%' OR LOWER(usuarioNome) LIKE '%licitar digital%')");
            break;
        }
      }

      let whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      let sql;
      if (palavraChave) {
        // Verificar se são múltiplas palavras separadas por vírgula
        const palavras = palavraChave.split(',').map(p => p.trim().toLowerCase()).filter(p => p.length > 0);

        if (palavras.length > 1) {
          // Múltiplas palavras - busca otimizada com OR
          // Usar filtros de data do usuário ou últimos 60 dias como fallback
          let dateCondition = '';
          let dateParams = [];

          if (dataAberturaInicial && dataAberturaFinal) {
            dateCondition = 'COALESCE(dataEncerramentoPortal, dataEncerramentoProposta) >= ? AND COALESCE(dataEncerramentoPortal, dataEncerramentoProposta) <= ?';
            dateParams = [dataAberturaInicial, dataAberturaFinal + 'T23:59:59'];
          } else {
            const dataLimite = new Date();
            dataLimite.setDate(dataLimite.getDate() - 60);
            dateCondition = 'dataPublicacaoPncp >= ?';
            dateParams = [dataLimite.toISOString().split('T')[0]];
          }

          // FTS (Postgres) ou substring (SQLite legado). O substring trigram sobre
          // ~17M itens batia no query_timeout de 30s; FTS usa idx_lic_objeto_fts /
          // idx_itens_desc_fts (medido ~2x mais rápido). Casa por palavra/radical.
          if (USE_PG) {
            // Config 'simple' (não 'portuguese'): o stemmer português DROPA stopwords
            // como "nas"/"de"/"em", degradando frases discriminantes a tokens genéricos
            // ("servidor nas"→'servidor', "nas dedicado"→'dedic') e inundando o
            // resultado de lixo. 'simple' mantém a frase como adjacência precisa.
            // Índices: idx_itens_desc_simple + idx_lic_objeto_simple.
            // Cada palavra multi-token (ex "servidor nas") vira frase entre aspas; OR entre elas.
            const ftsExpr = palavras
              .map(p => p.includes(' ') ? `"${p.replace(/"/g, ' ')}"` : p.replace(/"/g, ' '))
              .join(' OR ');

            // Etapa 1 (objetoCompra) e Etapa 2 (itens) trazem só colunas leves (id +
            // chaves de ordenação); as linhas completas vêm de um re-fetch único por id
            // (evita puxar a coluna dadosCompletos de até 600 linhas à toa).
            const sqlObjeto = `
              SELECT id, dataEncerramentoProposta, dataPublicacaoPncp, valorTotalEstimado
              FROM licitacoes
              WHERE ${dateCondition}
                AND to_tsvector('simple', coalesce(objetoCompra,'')) @@ websearch_to_tsquery('simple', ?)
              ORDER BY ${orderBy}
              LIMIT 300
            `;
            const rowsObjeto = await catalogPg.query(_pgSql(sqlObjeto), [...dateParams, ftsExpr]);

            const sqlItens = `
              SELECT DISTINCT l.id, l.dataEncerramentoProposta, l.dataPublicacaoPncp, l.valorTotalEstimado
              FROM licitacoes l
              WHERE l.id IN (
                SELECT DISTINCT i.licitacaoId FROM itens i
                WHERE i.licitacaoId IN (SELECT id FROM licitacoes WHERE ${dateCondition})
                  AND to_tsvector('simple', coalesce(i.descricao,'')) @@ websearch_to_tsquery('simple', ?)
                LIMIT 300
              )
            `;
            const rowsItens = await catalogPg.query(_pgSql(sqlItens), [...dateParams, ftsExpr]);

            const idSet = new Set();
            [...rowsObjeto, ...rowsItens].forEach(l => idSet.add(l.id));
            const idsEncontrados = Array.from(idSet);

            if (idsEncontrados.length === 0) {
              var resultadosPreProcessados = [];
            } else {
              const sqlFinal = conditions.length > 0
                ? `SELECT *, COALESCE(dataEncerramentoPortal, dataEncerramentoProposta) AS dataEncerramentoProposta FROM licitacoes ${whereClause} AND id = ANY($${params.length + 1}::bigint[]) ORDER BY ${orderBy}`
                : `SELECT *, COALESCE(dataEncerramentoPortal, dataEncerramentoProposta) AS dataEncerramentoProposta FROM licitacoes WHERE id = ANY($1::bigint[]) ORDER BY ${orderBy}`;
              const finalParams = conditions.length > 0 ? [...params, idsEncontrados] : [idsEncontrados];
              var resultadosPreProcessados = await catalogPg.query(_pgSql(sqlFinal), finalParams);
            }
          } else {
            // SQLite legado — substring (comportamento inalterado)
            const conditionsObjeto = palavras.map(() => `objetoCompra LIKE ?`).join(' OR ');
            const paramsObjeto = palavras.map(p => `%${p}%`);
            const sqlObjeto = `SELECT *, COALESCE(dataEncerramentoPortal, dataEncerramentoProposta) AS dataEncerramentoProposta FROM licitacoes WHERE ${dateCondition} AND (${conditionsObjeto}) ORDER BY ${orderBy} LIMIT 300`;
            const licitacoesObjeto = db.prepare(sqlObjeto).all(...dateParams, ...paramsObjeto);

            const conditionsItens = palavras.map(() => `i.descricao LIKE ?`).join(' OR ');
            const paramsItens = palavras.map(p => `%${p}%`);
            const sqlItens = `SELECT DISTINCT l.*, COALESCE(l.dataEncerramentoPortal, l.dataEncerramentoProposta) AS dataEncerramentoProposta FROM licitacoes l WHERE l.id IN (SELECT DISTINCT i.licitacaoId FROM itens i WHERE i.licitacaoId IN (SELECT id FROM licitacoes WHERE ${dateCondition}) AND (${conditionsItens}) LIMIT 300) ORDER BY ${orderBy}`;
            const licitacoesItens = db.prepare(sqlItens).all(...dateParams, ...paramsItens);

            const licitacoesMap = new Map();
            [...licitacoesObjeto, ...licitacoesItens].forEach(l => {
              if (!licitacoesMap.has(l.id)) licitacoesMap.set(l.id, l);
            });
            let todasLicitacoes = Array.from(licitacoesMap.values());

            const { field: orderField, dir: orderDir } = orderConfig;
            todasLicitacoes.sort((a, b) => {
              let valA = a[orderField];
              let valB = b[orderField];
              if (valA == null && valB == null) return 0;
              if (valA == null) return 1;
              if (valB == null) return -1;
              if (typeof valA === 'string') valA = valA.toLowerCase();
              if (typeof valB === 'string') valB = valB.toLowerCase();
              if (orderDir === 'DESC') return valA > valB ? -1 : valA < valB ? 1 : 0;
              return valA < valB ? -1 : valA > valB ? 1 : 0;
            });

            if (conditions.length > 0) {
              const idsEncontrados = todasLicitacoes.map(l => l.id);
              if (idsEncontrados.length > 0) {
                const placeholders = idsEncontrados.map(() => '?').join(',');
                todasLicitacoes = db.prepare(`SELECT * FROM licitacoes ${whereClause} AND id IN (${placeholders}) ORDER BY ${orderBy}`).all(...params, ...idsEncontrados);
              } else {
                todasLicitacoes = [];
              }
            }
            var resultadosPreProcessados = todasLicitacoes;
          }

          // Pular para o processamento de exclusão e paginação
          sql = null; // Sinaliza que já temos os resultados
        } else {
          // Palavra única - busca normal
          const palavraParam = `%${palavraChave.toLowerCase()}%`;
          sql = `
            SELECT DISTINCT l.*, COALESCE(l.dataEncerramentoPortal, l.dataEncerramentoProposta) AS dataEncerramentoProposta FROM licitacoes l
            LEFT JOIN itens i ON l.id = i.licitacaoId
            ${whereClause}
            ${conditions.length > 0 ? 'AND' : 'WHERE'} (
              LOWER(l.objetoCompra) LIKE ?
              OR LOWER(l.informacaoComplementar) LIKE ?
              OR LOWER(l.razaoSocial) LIKE ?
              OR LOWER(l.nomeUnidade) LIKE ?
              OR LOWER(i.descricao) LIKE ?
            )
            ORDER BY ${orderByAlias}
          `;
          params.push(palavraParam, palavraParam, palavraParam, palavraParam, palavraParam);
        }
      } else {
        sql = `
          SELECT *, COALESCE(dataEncerramentoPortal, dataEncerramentoProposta) AS dataEncerramentoProposta FROM licitacoes
          ${whereClause}
          ORDER BY ${orderBy}
        `;
      }

      // Fast path: sem filtros JS pós-query (palavraChave, palavraExclusao,
      // grupoExclusaoId), aplica LIMIT direto no SQL. Carregar 447k linhas com
      // JSON.parse de cada dadosCompletos estourava heap V8 (OOM kill do
      // worker). Aqui só carregamos a página requisitada (~20 linhas).
      // totalRegistros vem de COUNT separado nesse caminho.
      let totalFastPath = null;
      let todasLicitacoes;
      if (sql && !palavraChave && !palavraExclusao && !grupoExclusaoId) {
        const tamanhoN = parseInt(tamanhoPagina) || 50;
        const offsetN = ((parseInt(pagina) || 1) - 1) * tamanhoN;
        if (USE_PG) {
          // Fase 3g: transforma SQL SQLite (?, camelCase) pra PG ($N, "camelCase")
          const countRow = await catalogPg.queryOne(_pgSql(`SELECT COUNT(*) AS c FROM licitacoes ${whereClause}`), params);
          totalFastPath = Number(countRow?.c || 0);
          const pagSql = _pgSql(sql) + ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
          todasLicitacoes = await catalogPg.query(pagSql, [...params, tamanhoN, offsetN]);
        } else {
          totalFastPath = db.prepare(`SELECT COUNT(*) AS c FROM licitacoes ${whereClause}`).get(...params).c;
          todasLicitacoes = db.prepare(sql + ' LIMIT ? OFFSET ?').all(...params, tamanhoN, offsetN);
        }
      } else {
        if (sql) {
          todasLicitacoes = USE_PG
            ? await catalogPg.query(_pgSql(sql), params)
            : db.prepare(sql).all(...params);
        } else {
          todasLicitacoes = resultadosPreProcessados;
        }
      }

      // Helper: batch-prefetch descricoes de itens p/ várias licitacoes (evita N+1)
      const _prefetchItensDesc = async (licIds) => {
        if (!licIds || licIds.length === 0) return new Map();
        let rows;
        if (USE_PG) {
          rows = await catalogPg.query(
            `SELECT "licitacaoId","descricao" FROM itens WHERE "licitacaoId" = ANY($1::bigint[])`,
            [licIds]
          );
        } else {
          const placeholders = licIds.map(() => '?').join(',');
          rows = db.prepare(`SELECT licitacaoId, descricao FROM itens WHERE licitacaoId IN (${placeholders})`).all(...licIds);
        }
        const map = new Map();
        for (const r of rows) {
          const id = r.licitacaoId;
          if (!map.has(id)) map.set(id, '');
          map.set(id, map.get(id) + ' ' + (r.descricao || '').toLowerCase());
        }
        return map;
      };

      // Prefetch ÚNICO das descrições de itens — reusado pelos dois filtros de
      // exclusão abaixo (palavraExclusao + grupoExclusao), evitando uma segunda
      // leitura pesada de itens. O map cobre o superconjunto de ids (os filtros só
      // removem linhas, nunca adicionam).
      let itensDescPorLic = new Map();
      if (palavraExclusao || grupoExclusaoId) {
        itensDescPorLic = await _prefetchItensDesc(todasLicitacoes.map(l => l.id));
      }

      // Filtrar palavras de exclusão (inclui busca nos itens)
      if (palavraExclusao) {
        const exclusoes = palavraExclusao.toLowerCase().split(',').map(p => p.trim()).filter(p => p);
        if (exclusoes.length > 0) {
          todasLicitacoes = todasLicitacoes.filter(lic => {
            let texto = (
              (lic.objetoCompra || '') + ' ' +
              (lic.informacaoComplementar || '') + ' ' +
              (lic.razaoSocial || '') + ' ' +
              (lic.nomeUnidade || '')
            ).toLowerCase();
            texto += itensDescPorLic.get(lic.id) || '';
            return !exclusoes.some(exc => texto.includes(exc));
          });
        }
      }


      // Filtrar por grupo de exclusão
      if (grupoExclusaoId) {
        const grupoExclusao = db.prepare('SELECT id FROM grupos_palavras WHERE id = ? AND tipo = ?').get(grupoExclusaoId, 'exclusao');
        if (grupoExclusao) {
          const palavrasGrupo = db.prepare('SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?').all(grupoExclusaoId);
          const exclusoesGrupo = palavrasGrupo.map(p => p.palavra.toLowerCase().trim()).filter(p => p);

          if (exclusoesGrupo.length > 0) {
            todasLicitacoes = todasLicitacoes.filter(lic => {
              let texto = (
                (lic.objetoCompra || '') + ' ' +
                (lic.informacaoComplementar || '') + ' ' +
                (lic.razaoSocial || '') + ' ' +
                (lic.nomeUnidade || '')
              ).toLowerCase();
              texto += itensDescPorLic.get(lic.id) || '';
              return !exclusoesGrupo.some(exc => texto.includes(exc));
            });
          }
        }
      }

      // Batch-prefetch dadosCompletos dos itens se buscaDetalhada (evita N+1)
      const _itensDadosPorLic = usarBuscaDetalhada
        ? await (async () => {
            const ids = todasLicitacoes.map(l => l.id);
            if (ids.length === 0) return new Map();
            let rows;
            if (USE_PG) {
              rows = await catalogPg.query(
                `SELECT "licitacaoId","dadosCompletos" FROM itens WHERE "licitacaoId" = ANY($1::bigint[])`,
                [ids]
              );
            } else {
              const ph = ids.map(() => '?').join(',');
              rows = db.prepare(`SELECT licitacaoId, dadosCompletos FROM itens WHERE licitacaoId IN (${ph})`).all(...ids);
            }
            const m = new Map();
            for (const r of rows) {
              if (!m.has(r.licitacaoId)) m.set(r.licitacaoId, []);
              const d = (typeof r.dadosCompletos === 'object' && r.dadosCompletos)
                ? r.dadosCompletos
                : JSON.parse(r.dadosCompletos || '{}');
              m.get(r.licitacaoId).push(d);
            }
            return m;
          })()
        : null;

      const licitacoesFormatadas = todasLicitacoes.map(row => {
        let dados = {};

        // Se dadosCompletos existir e não estiver vazio, usar ele
        if (row.dadosCompletos && typeof row.dadosCompletos === 'object') {
          dados = row.dadosCompletos;
        } else if (row.dadosCompletos && row.dadosCompletos !== '{}') {
          dados = JSON.parse(row.dadosCompletos);
        } else {
          // Construir objeto a partir dos campos da tabela
          dados = {
            orgaoEntidade: {
              cnpj: row.cnpj,
              razaoSocial: row.razaoSocial
            },
            unidadeOrgao: {
              ufSigla: row.ufSigla,
              ufNome: row.ufSigla, // Usar sigla como fallback
              municipioNome: row.municipioNome,
              nomeUnidade: row.nomeUnidade,
              codigoUnidade: row.codigoUnidade
            },
            numeroControlePNCP: row.numeroControlePNCP,
            anoCompra: row.anoCompra,
            sequencialCompra: row.sequencialCompra,
            numeroCompra: row.numeroCompra,
            processo: row.processo,
            modalidadeId: row.modalidadeId,
            modalidadeNome: row.modalidadeNome,
            objetoCompra: row.objetoCompra,
            informacaoComplementar: row.informacaoComplementar,
            valorTotalEstimado: row.valorTotalEstimado,
            dataPublicacaoPncp: row.dataPublicacaoPncp,
            dataAberturaProposta: row.dataAberturaProposta,
            dataEncerramentoProposta: row.dataEncerramentoProposta,
            situacaoCompraNome: row.situacaoCompraNome,
            linkSistemaOrigem: row.linkSistemaOrigem,
            srp: row.srp === 1,
            dataAtualizacao: row.dataAtualizacao,
            usuarioNome: row.usuarioNome
          };
        }

        if (usarBuscaDetalhada) {
          dados.itens = _itensDadosPorLic ? (_itensDadosPorLic.get(row.id) || []) : [];
        }

        return dados;
      });

      const tamanho = parseInt(tamanhoPagina);
      const paginaInt = parseInt(pagina);
      // Fast path: SQL já trouxe a página exata. Slow path: precisamos fatiar.
      const licitacoesPaginadas = totalFastPath != null
        ? licitacoesFormatadas
        : licitacoesFormatadas.slice((paginaInt - 1) * tamanho, paginaInt * tamanho);
      const totalRegistros = totalFastPath != null ? totalFastPath : licitacoesFormatadas.length;

      res.json({
        success: true,
        data: {
          data: licitacoesPaginadas,
          totalRegistros,
          totalPaginas: Math.ceil(totalRegistros / tamanho),
          numeroPagina: paginaInt,
          empty: licitacoesPaginadas.length === 0
        },
        // NFSE-M06 onda 5C passo 2: syncStatus vem do módulo pncp-sync-scheduler.
        // No worker (quem serve HTTP) os campos in-memory ficam zerados pois sync
        // roda no master; os campos persistidos abaixo + GET /api/sync/status
        // preenchem o estado real da UI.
        syncStatus: await (async () => {
          const _ss = pncpSync.getSyncStatus();
          let licitacoesNoBanco, itensNoBanco;
          if (USE_PG) {
            // COUNT(*) exato em `itens` (18M+ linhas) é seq scan de ~66s e estoura
            // o statement_timeout de 30s, derrubando TODA request /api/licitacoes.
            // São só números de display ("X no banco"): usar estimativa de
            // pg_class.reltuples (atualizada por autovacuum/analyze) — instantâneo.
            const _est = await catalogPg.queryOne(
              `SELECT
                 (SELECT reltuples::bigint FROM pg_class WHERE oid = 'licitacoes'::regclass) AS lic,
                 (SELECT reltuples::bigint FROM pg_class WHERE oid = 'itens'::regclass) AS itens`
            );
            licitacoesNoBanco = Number(_est?.lic || 0);
            itensNoBanco = Number(_est?.itens || 0);
          } else {
            licitacoesNoBanco = db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count;
            itensNoBanco = db.prepare('SELECT COUNT(*) as count FROM itens').get().count;
          }
          return {
            running: _ss.running,
            type: _ss.type,
            progress: _ss.progress,
            total: _ss.total,
            lastSync: _ss.lastSync,
            lastIncrementalSync: _ss.lastIncrementalSync,
            nextScheduledSync: _ss.nextScheduledSync,
            licitacoesNoBanco,
            itensNoBanco,
          };
        })()
      });

    } catch (error) {
      console.error('Erro ao buscar licitações:', error.message);
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar licitações',
        details: error.message
      });
    }
  });



  /**
   * Endpoint para buscar detalhes de uma licitação específica
   */
  app.get('/api/licitacoes/:cnpj/:sequencial/:ano', async (req, res) => {
    try {
      const { cnpj, sequencial, ano } = req.params;

      const numeroControlePNCP = `${cnpj}-1-${String(sequencial).padStart(6, '0')}/${ano}`;
      let local;
      if (USE_PG) {
        local = await catalogPg.queryOne(
          'SELECT "dadosCompletos" FROM licitacoes WHERE "numeroControlePNCP" = $1',
          [numeroControlePNCP]
        );
      } else {
        local = db.prepare('SELECT dadosCompletos FROM licitacoes WHERE numeroControlePNCP = ?').get(numeroControlePNCP);
      }

      if (local) {
        // PG retorna jsonb já parseado; SQLite retorna TEXT
        const data = (USE_PG && typeof local.dadosCompletos === 'object')
          ? local.dadosCompletos
          : JSON.parse(local.dadosCompletos);
        return res.json({
          success: true,
          data,
          source: 'local'
        });
      }

      const response = await axios.get(
        `${PNCP_API_BASE}/orgaos/${cnpj}/compras/${ano}/${sequencial}`,
        {
          headers: { 'Accept': 'application/json' },
          timeout: 30000
        }
      );

      res.json({
        success: true,
        data: response.data,
        source: 'api'
      });

    } catch (error) {
      console.error('Erro ao buscar detalhes da licitação:', error.message);
      res.status(error.response?.status || 500).json({
        success: false,
        error: 'Erro ao buscar detalhes da licitação',
        details: error.message
      });
    }
  });

  /**
   * Endpoint para buscar órgãos
   */
  app.get('/api/orgaos', async (req, res) => {
    try {
      const { q, pagina = 1, tamanhoPagina = 50 } = req.query;

      const params = {
        pagina: parseInt(pagina),
        tamanhoPagina: parseInt(tamanhoPagina)
      };

      if (q) params.q = q;

      const response = await axios.get(`${PNCP_API_BASE}/orgaos`, {
        params,
        headers: { 'Accept': 'application/json' },
        timeout: 30000
      });

      res.json({
        success: true,
        data: response.data
      });

    } catch (error) {
      console.error('Erro ao buscar órgãos:', error.message);
      res.status(error.response?.status || 500).json({
        success: false,
        error: 'Erro ao buscar órgãos',
        details: error.message
      });
    }
  });



  /**
   * Endpoint para buscar itens de uma licitacao
   */
  app.get('/api/licitacoes/:cnpj/:sequencial/:ano/itens', async (req, res) => {
    try {
      const { cnpj, sequencial, ano } = req.params;

      // Primeiro tenta buscar do banco local
      const numeroControlePNCP = cnpj + '-1-' + String(sequencial).padStart(6, '0') + '/' + ano;
      let localItems;
      if (USE_PG) {
        localItems = await catalogPg.query(`
          SELECT i.* FROM itens i
          INNER JOIN licitacoes l ON i."licitacaoId" = l."id"
          WHERE l."numeroControlePNCP" = $1
        `, [numeroControlePNCP]);
      } else {
        localItems = db.prepare(`
          SELECT i.* FROM itens i
          INNER JOIN licitacoes l ON i.licitacaoId = l.id
          WHERE l.numeroControlePNCP = ?
        `).all(numeroControlePNCP);
      }

      if (localItems.length > 0) {
        const items = localItems.map(item => {
          // PG retorna jsonb como obj; SQLite retorna text
          if (item.dadosCompletos && typeof item.dadosCompletos === 'object' && Object.keys(item.dadosCompletos).length > 0) {
            return item.dadosCompletos;
          }
          if (item.dadosCompletos && typeof item.dadosCompletos === 'string' && item.dadosCompletos !== '{}' && item.dadosCompletos.length > 2) {
            try {
              return JSON.parse(item.dadosCompletos);
            } catch (e) {
              // Fall through to use table fields
            }
          }

          // Construir objeto a partir dos campos da tabela
          return {
            numeroItem: item.numeroItem,
            descricao: item.descricao,
            descricaoDetalhada: item.descricao,
            quantidade: item.quantidade,
            unidadeMedida: item.unidadeMedida,
            valorUnitarioEstimado: item.valorUnitarioEstimado,
            valorTotal: item.valorTotal
          };
        });

        return res.json({
          success: true,
          data: items,
          source: 'local'
        });
      }

      // Se nao encontrou localmente, busca da API com paginação
      const todosItens = [];
      let pagina = 1;
      let temMais = true;

      while (temMais) {
        const response = await axios.get(
          PNCP_API_ITENS + '/orgaos/' + cnpj + '/compras/' + ano + '/' + sequencial + '/itens',
          {
            params: { pagina, tamanhoPagina: 100 },
            headers: { 'Accept': 'application/json' },
            timeout: 30000
          }
        );

        const itens = response.data || [];
        if (itens.length > 0) {
          todosItens.push(...itens);
          pagina++;
          if (itens.length < 100) temMais = false;
        } else {
          temMais = false;
        }
      }

      res.json({
        success: true,
        data: todosItens,
        source: 'api'
      });

    } catch (error) {
      console.error('Erro ao buscar itens:', error.message);
      res.status(error.response?.status || 500).json({
        success: false,
        error: 'Erro ao buscar itens',
        details: error.message
      });
    }
  });

  /**
   * Endpoint para ressincronizar itens de uma licitação específica
   */
  app.post('/api/licitacoes/:cnpj/:sequencial/:ano/sync-itens', async (req, res) => {
    try {
      const { cnpj, sequencial, ano } = req.params;

      // Buscar itens da API do PNCP
      // NFSE-M06 onda 5C passo 2: helper puro exportado pelo pncp-sync-scheduler.
      const itens = await pncpSync.buscarItensLicitacao(cnpj, parseInt(ano), parseInt(sequencial));

      if (itens.length === 0) {
        return res.json({ success: false, error: 'Nenhum item encontrado na API' });
      }

      // Construir número de controle PNCP
      const numeroControlePNCP = `${cnpj}-1-${String(sequencial).padStart(6, '0')}/${ano}`;

      // Salvar itens no banco
      const salvou = salvarItens(numeroControlePNCP, itens);

      if (salvou) {
        res.json({
          success: true,
          message: `${itens.length} itens sincronizados com sucesso`,
          totalItens: itens.length
        });
      } else {
        res.json({ success: false, error: 'Erro ao salvar itens no banco' });
      }

    } catch (error) {
      console.error('Erro ao sincronizar itens:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Licitacoes] Rotas registradas');
}

module.exports = { registrarRotasLicitacoes };
