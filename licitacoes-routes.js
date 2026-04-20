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

      // Configurar ordenação (NULLS LAST para colocar valores nulos no final)
      const ordenacaoValida = {
        'dataEncerramentoProposta_asc': 'CASE WHEN dataEncerramentoProposta IS NULL THEN 1 ELSE 0 END, dataEncerramentoProposta ASC',
        'dataEncerramentoProposta_desc': 'dataEncerramentoProposta DESC',
        'dataPublicacaoPncp_asc': 'CASE WHEN dataPublicacaoPncp IS NULL THEN 1 ELSE 0 END, dataPublicacaoPncp ASC',
        'dataPublicacaoPncp_desc': 'dataPublicacaoPncp DESC',
        'valorTotalEstimado_asc': 'CASE WHEN valorTotalEstimado IS NULL THEN 1 ELSE 0 END, valorTotalEstimado ASC',
        'valorTotalEstimado_desc': 'valorTotalEstimado DESC'
      };
      const orderBy = ordenacaoValida[ordenacao] || 'CASE WHEN dataEncerramentoProposta IS NULL THEN 1 ELSE 0 END, dataEncerramentoProposta ASC';

      // Versão com alias 'l.' para queries com JOIN
      const ordenacaoValidaAlias = {
        'dataEncerramentoProposta_asc': 'CASE WHEN l.dataEncerramentoProposta IS NULL THEN 1 ELSE 0 END, l.dataEncerramentoProposta ASC',
        'dataEncerramentoProposta_desc': 'l.dataEncerramentoProposta DESC',
        'dataPublicacaoPncp_asc': 'CASE WHEN l.dataPublicacaoPncp IS NULL THEN 1 ELSE 0 END, l.dataPublicacaoPncp ASC',
        'dataPublicacaoPncp_desc': 'l.dataPublicacaoPncp DESC',
        'valorTotalEstimado_asc': 'CASE WHEN l.valorTotalEstimado IS NULL THEN 1 ELSE 0 END, l.valorTotalEstimado ASC',
        'valorTotalEstimado_desc': 'l.valorTotalEstimado DESC'
      };
      const orderByAlias = ordenacaoValidaAlias[ordenacao] || 'CASE WHEN l.dataEncerramentoProposta IS NULL THEN 1 ELSE 0 END, l.dataEncerramentoProposta ASC';

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
        conditions.push('dataEncerramentoProposta >= ?');
        params.push(dataAberturaInicial);
      }
      if (dataAberturaFinal) {
        conditions.push('dataEncerramentoProposta <= ?');
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
            dateCondition = 'dataEncerramentoProposta >= ? AND dataEncerramentoProposta <= ?';
            dateParams = [dataAberturaInicial, dataAberturaFinal + 'T23:59:59'];
          } else {
            const dataLimite = new Date();
            dataLimite.setDate(dataLimite.getDate() - 60);
            dateCondition = 'dataPublicacaoPncp >= ?';
            dateParams = [dataLimite.toISOString().split('T')[0]];
          }

          // Etapa 1: Busca rápida no objetoCompra
          const conditionsObjeto = palavras.map(() => `objetoCompra LIKE ?`).join(' OR ');
          const paramsObjeto = palavras.map(p => `%${p}%`);

          const licitacoesObjeto = db.prepare(`
            SELECT * FROM licitacoes
            WHERE ${dateCondition} AND (${conditionsObjeto})
            ORDER BY ${orderBy}
            LIMIT 300
          `).all(...dateParams, ...paramsObjeto);

          // Etapa 2: Busca nos itens
          const conditionsItens = palavras.map(() => `i.descricao LIKE ?`).join(' OR ');
          const paramsItens = palavras.map(p => `%${p}%`);

          const licitacoesItens = db.prepare(`
            SELECT DISTINCT l.* FROM licitacoes l
            WHERE l.id IN (
              SELECT DISTINCT i.licitacaoId FROM itens i
              WHERE i.licitacaoId IN (SELECT id FROM licitacoes WHERE ${dateCondition})
                AND (${conditionsItens})
              LIMIT 300
            )
            ORDER BY ${orderBy}
          `).all(...dateParams, ...paramsItens);

          // Combinar resultados únicos
          const licitacoesMap = new Map();
          [...licitacoesObjeto, ...licitacoesItens].forEach(l => {
            if (!licitacoesMap.has(l.id)) licitacoesMap.set(l.id, l);
          });

          let todasLicitacoes = Array.from(licitacoesMap.values());

          // Aplicar ordenação aos resultados combinados (NULL sempre por último)
          const { field: orderField, dir: orderDir } = orderConfig;
          todasLicitacoes.sort((a, b) => {
            let valA = a[orderField];
            let valB = b[orderField];
            // NULL sempre por último
            if (valA == null && valB == null) return 0;
            if (valA == null) return 1;
            if (valB == null) return -1;
            if (typeof valA === 'string') valA = valA.toLowerCase();
            if (typeof valB === 'string') valB = valB.toLowerCase();
            if (orderDir === 'DESC') return valA > valB ? -1 : valA < valB ? 1 : 0;
            return valA < valB ? -1 : valA > valB ? 1 : 0;
          });

          // Aplicar filtros adicionais se houver
          if (conditions.length > 0) {
            // Re-filtrar com as condições adicionais usando SQL
            const idsEncontrados = todasLicitacoes.map(l => l.id);
            if (idsEncontrados.length > 0) {
              const placeholders = idsEncontrados.map(() => '?').join(',');
              todasLicitacoes = db.prepare(`
                SELECT * FROM licitacoes
                ${whereClause}
                ${conditions.length > 0 ? 'AND' : 'WHERE'} id IN (${placeholders})
                ORDER BY ${orderBy}
              `).all(...params, ...idsEncontrados);
            } else {
              todasLicitacoes = [];
            }
          }

          // Pular para o processamento de exclusão e paginação
          sql = null; // Sinaliza que já temos os resultados
          var resultadosPreProcessados = todasLicitacoes;
        } else {
          // Palavra única - busca normal
          const palavraParam = `%${palavraChave.toLowerCase()}%`;
          sql = `
            SELECT DISTINCT l.* FROM licitacoes l
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
          SELECT * FROM licitacoes
          ${whereClause}
          ORDER BY ${orderBy}
        `;
      }

      // Se sql é null, já temos os resultados pré-processados
      let todasLicitacoes = sql ? db.prepare(sql).all(...params) : resultadosPreProcessados;

      // Filtrar palavras de exclusão (inclui busca nos itens)
      if (palavraExclusao) {
        const exclusoes = palavraExclusao.toLowerCase().split(',').map(p => p.trim()).filter(p => p);
        if (exclusoes.length > 0) {
          todasLicitacoes = todasLicitacoes.filter(lic => {
            // Texto da licitação
            let texto = (
              (lic.objetoCompra || '') + ' ' +
              (lic.informacaoComplementar || '') + ' ' +
              (lic.razaoSocial || '') + ' ' +
              (lic.nomeUnidade || '')
            ).toLowerCase();

            // Adicionar descrição dos itens
            const itensRows = db.prepare('SELECT descricao FROM itens WHERE licitacaoId = ?').all(lic.id);
            itensRows.forEach(item => {
              texto += ' ' + (item.descricao || '').toLowerCase();
            });

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

              const itensRows = db.prepare('SELECT descricao FROM itens WHERE licitacaoId = ?').all(lic.id);
              itensRows.forEach(item => {
                texto += ' ' + (item.descricao || '').toLowerCase();
              });

              return !exclusoesGrupo.some(exc => texto.includes(exc));
            });
          }
        }
      }

      const licitacoesFormatadas = todasLicitacoes.map(row => {
        let dados = {};

        // Se dadosCompletos existir e não estiver vazio, usar ele
        if (row.dadosCompletos && row.dadosCompletos !== '{}') {
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
          const itensRows = db.prepare('SELECT dadosCompletos FROM itens WHERE licitacaoId = ?').all(row.id);
          dados.itens = itensRows.map(i => JSON.parse(i.dadosCompletos || '{}'));
        }

        return dados;
      });

      const tamanho = parseInt(tamanhoPagina);
      const paginaInt = parseInt(pagina);
      const inicio = (paginaInt - 1) * tamanho;
      const fim = inicio + tamanho;
      const licitacoesPaginadas = licitacoesFormatadas.slice(inicio, fim);

      res.json({
        success: true,
        data: {
          data: licitacoesPaginadas,
          totalRegistros: licitacoesFormatadas.length,
          totalPaginas: Math.ceil(licitacoesFormatadas.length / tamanho),
          numeroPagina: paginaInt,
          empty: licitacoesPaginadas.length === 0
        },
        // NFSE-M06 onda 5C passo 2: syncStatus vem do módulo pncp-sync-scheduler.
        // No worker (quem serve HTTP) os campos in-memory ficam zerados pois sync
        // roda no master; os campos persistidos abaixo + GET /api/sync/status
        // preenchem o estado real da UI.
        syncStatus: (() => {
          const _ss = pncpSync.getSyncStatus();
          return {
            running: _ss.running,
            type: _ss.type,
            progress: _ss.progress,
            total: _ss.total,
            lastSync: _ss.lastSync,
            lastIncrementalSync: _ss.lastIncrementalSync,
            nextScheduledSync: _ss.nextScheduledSync,
            licitacoesNoBanco: db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count,
            itensNoBanco: db.prepare('SELECT COUNT(*) as count FROM itens').get().count
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
      const local = db.prepare('SELECT dadosCompletos FROM licitacoes WHERE numeroControlePNCP = ?').get(numeroControlePNCP);

      if (local) {
        return res.json({
          success: true,
          data: JSON.parse(local.dadosCompletos),
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
      const localItems = db.prepare(`
        SELECT i.* FROM itens i
        INNER JOIN licitacoes l ON i.licitacaoId = l.id
        WHERE l.numeroControlePNCP = ?
      `).all(numeroControlePNCP);

      if (localItems.length > 0) {
        const items = localItems.map(item => {
          // Se dadosCompletos existir e não estiver vazio, usar ele
          if (item.dadosCompletos && item.dadosCompletos !== '{}' && item.dadosCompletos.length > 2) {
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
