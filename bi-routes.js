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

// URL base da PNCP API v1 — duplicada aqui para o módulo ficar
// autocontido; a mesma constante existe em server.js para outras rotas
// que ainda consultam itens diretamente.
const PNCP_API_ITENS = 'https://pncp.gov.br/api/pncp/v1';

function registrarRotasBi(app, db) {
  // Pesquisar itens por palavra-chave (busca local)
  app.get('/api/bi/pesquisar', async (req, res) => {
    try {
      const { q, pagina = 1, tamanhoPagina = 50, apenasHomologados } = req.query;
      if (!q || q.trim().length < 3) {
        return res.status(400).json({ error: 'Termo de busca deve ter pelo menos 3 caracteres' });
      }

      const palavras = q.trim().toLowerCase().split(/\s+/).filter(p => p.length >= 2);
      if (palavras.length === 0) {
        return res.status(400).json({ error: 'Termos de busca inválidos' });
      }

      // Buscar itens que contenham TODAS as palavras
      const conditions = palavras.map(() => `LOWER(i.descricao) LIKE ?`).join(' AND ');
      const params = palavras.map(p => `%${p}%`);

      const offset = (parseInt(pagina) - 1) * parseInt(tamanhoPagina);

      // Só licitações com proposta já encerrada
      const filtroEncerrada = `AND l.dataEncerramentoProposta < datetime('now')`;

      // Filtro de apenas homologados: JOIN com cache de resultados
      const joinHomologados = apenasHomologados === '1'
        ? `JOIN resultados_bi rb ON rb.cnpj = l.cnpj AND rb.ano = l.anoCompra AND rb.sequencial = l.sequencialCompra AND rb.numeroItem = i.numeroItem AND rb.niFornecedor != '__sem_resultado__'`
        : '';
      const distinctClause = apenasHomologados === '1' ? 'DISTINCT' : '';

      const countRow = db.prepare(`
        SELECT COUNT(${distinctClause} i.id) as total FROM itens i
        JOIN licitacoes l ON i.licitacaoId = l.id
        ${joinHomologados}
        WHERE ${conditions} ${filtroEncerrada}
      `).get(...params);

      const selectResultados = apenasHomologados === '1'
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
          l.cnpj,
          l.anoCompra,
          l.sequencialCompra,
          l.razaoSocial as orgao,
          l.nomeUnidade,
          l.codigoUnidade as uasg,
          l.ufSigla,
          l.municipioNome,
          l.modalidadeNome,
          l.objetoCompra,
          l.situacaoCompraNome,
          l.dataPublicacaoPncp,
          l.dataEncerramentoProposta,
          l.numeroControlePNCP
          ${selectResultados}
        FROM itens i
        JOIN licitacoes l ON i.licitacaoId = l.id
        ${joinHomologados}
        WHERE ${conditions} ${filtroEncerrada}
        ORDER BY l.dataPublicacaoPncp DESC
        LIMIT ? OFFSET ?
      `).all(...params, parseInt(tamanhoPagina), offset);

      res.json({
        total: countRow.total,
        pagina: parseInt(pagina),
        tamanhoPagina: parseInt(tamanhoPagina),
        totalPaginas: Math.ceil(countRow.total / parseInt(tamanhoPagina)),
        itens,
        apenasHomologados: apenasHomologados === '1'
      });

    } catch (error) {
      console.error('Erro BI pesquisar:', error);
      res.status(500).json({ error: error.message });
    }
  });

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

      const stmtBuscarCache = db.prepare(`
        SELECT * FROM resultados_bi WHERE cnpj = ? AND ano = ? AND sequencial = ? AND numeroItem = ?
      `);
      const stmtInserirCache = db.prepare(`
        INSERT OR REPLACE INTO resultados_bi (cnpj, ano, sequencial, numeroItem, niFornecedor, nomeRazaoSocialFornecedor, valorUnitarioHomologado, valorTotalHomologado, marcaFabricante, modeloVersao, dataResultado, dadosCompletos)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // Marca que item foi consultado mas não tem resultado (para não reconsultar)
      const stmtMarcarSemResultado = db.prepare(`
        INSERT OR IGNORE INTO resultados_bi (cnpj, ano, sequencial, numeroItem, niFornecedor, nomeRazaoSocialFornecedor)
        VALUES (?, ?, ?, ?, '__sem_resultado__', '')
      `);

      for (const item of lote) {
        // Verificar cache primeiro
        const cached = stmtBuscarCache.all(item.cnpj, item.ano, item.sequencial, item.numeroItem);
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
            for (const r of resData) {
              stmtInserirCache.run(
                item.cnpj, item.ano, item.sequencial, item.numeroItem,
                r.niFornecedor || '', r.nomeRazaoSocialFornecedor || '',
                r.valorUnitarioHomologado || null, r.valorTotalHomologado || null,
                r.marcaFabricante || r.marca || '', r.modeloVersao || '',
                r.dataResultado || '', JSON.stringify(r)
              );
            }
          } else {
            stmtMarcarSemResultado.run(item.cnpj, item.ano, item.sequencial, item.numeroItem);
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
          if (err.response?.status === 404) {
            stmtMarcarSemResultado.run(item.cnpj, item.ano, item.sequencial, item.numeroItem);
          }
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

      const params = { pagina, tamanhoPagina: Math.min(parseInt(tamanhoPagina) || 50, 100) };
      if (descricao) params.descricaoItem = descricao;

      const url = `https://dadosabertos.compras.gov.br/modulo-contratacao/2_consultarItemContratacaoPncp14133`;
      const response = await axios.get(url, {
        params,
        headers: { 'Accept': 'application/json' },
        timeout: 15000
      });

      res.json(response.data || {});
    } catch (error) {
      console.error('Erro BI dadosabertos itens:', error.message);
      res.status(error.response?.status || 500).json({ error: error.message });
    }
  });

  // Pesquisa de Preço - histórico de preços praticados (tem marca/modelo)
  app.get('/api/bi/pesquisa-preco', async (req, res) => {
    try {
      const { descricao, codigoItem, pagina = 1, tamanhoPagina = 50 } = req.query;

      const params = { pagina, tamanhoPagina: Math.min(parseInt(tamanhoPagina) || 50, 100) };
      if (descricao) params.descricaoItem = descricao;
      if (codigoItem) params.codigoItemCatalogo = codigoItem;

      const url = `https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarPesquisaPrecoMaterial`;
      const response = await axios.get(url, {
        params,
        headers: { 'Accept': 'application/json' },
        timeout: 15000
      });

      res.json(response.data || {});
    } catch (error) {
      console.error('Erro BI pesquisa-preco:', error.message);
      res.status(error.response?.status || 500).json({ error: error.message });
    }
  });

  console.log('[BI] Rotas registradas');
}

module.exports = { registrarRotasBi };
