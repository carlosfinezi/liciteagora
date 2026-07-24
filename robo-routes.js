// robo-routes.js
//
// Rotas HTTP do "Robô de Lances" — configuração por item do que/quando/
// quanto o operador autoriza o sistema a lançar nas disputas do PNCP.
// Extraído de server.js em NFSE-M06 onda 6.13.
//
// Tabela central: `config_lances` (chave natural: cnpj+ano+sequencial+
// numeroItem). Todas as rotas são CRUD sobre essa tabela, às vezes com
// JOINs em `licitacoes`, `itens`, `interesse` e `kanban_status` para
// enriquecer o resultado.
//
// Escopo: 7 rotas /api/robo/*:
//   GET    /api/robo/config/:cnpj/:ano/:sequencial   → configs de 1 licitação
//   GET    /api/robo/config                          → todas as configs ativas
//   POST   /api/robo/config                          → UPSERT de 1 item
//   POST   /api/robo/config/batch                    → UPSERT transacional de N itens
//   DELETE /api/robo/config/:cnpj/:ano/:sequencial/:numeroItem
//   GET    /api/robo/licitacoes                      → licitações com interesse,
//                                                       ainda abertas, com contagem
//                                                       de itens configurados
//   GET    /api/robo/itens/:cnpj/:ano/:sequencial    → itens de interesse +
//                                                       config_lances (se houver)
//
// DEPENDÊNCIAS: só `db` (better-sqlite3). Nenhum helper/estado
// compartilhado.
//
// RELAÇÃO COM OUTROS MÓDULOS QUE MEXEM EM config_lances:
//   - lances-routes.js (onda 6.11): GET/POST /api/lance/limites/:compraId
//     também lê/escreve config_lances, mas por outra chave (compraId
//     decodificado, e só campos precoMinimo/descontoPercentual). Os
//     módulos são independentes; o schema da tabela tem campos
//     suficientes para ambos os casos de uso.
//   - lance-engine.js (sniper): lê config_lances para saber o mínimo
//     autorizado em cada item antes de enviar lance ao Comprasnet.
//
// Os UPSERTs usam `ON CONFLICT(cnpj, ano, sequencial, numeroItem) DO
// UPDATE` — a chave única precisa existir na tabela (definida na
// migração inicial, ver server.js seção de DDL).

// Fase 3g (2026-05-23): JOIN licitacoes via PG
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

function registrarRotasRobo(app, db) {
  // Listar configurações de lances de uma licitação
  app.get('/api/robo/config/:cnpj/:ano/:sequencial', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.params;

      const configs = db.prepare(`
        SELECT cl.*, it.descricao, it.quantidade, it.unidadeMedida, it.valorUnitarioEstimado
        FROM config_lances cl
        LEFT JOIN licitacoes l ON cl.cnpj = l.cnpj AND cl.ano = l.anoCompra AND cl.sequencial = l.sequencialCompra
        LEFT JOIN itens it ON l.id = it.licitacaoId AND cl.numeroItem = it.numeroItem
        WHERE cl.cnpj = ? AND cl.ano = ? AND cl.sequencial = ?
        ORDER BY cl.numeroItem
      `).all(cnpj, parseInt(ano), parseInt(sequencial));

      res.json({ success: true, data: configs });
    } catch (error) {
      console.error('Erro ao buscar config lances:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Listar todas as configurações ativas
  app.get('/api/robo/config', (req, res) => {
    try {
      const configs = db.prepare(`
        SELECT cl.*,
          l.objetoCompra, l.razaoSocial as nomeOrgao, l.dataEncerramentoProposta, l.linkSistemaOrigem, l.modalidadeNome,
          it.descricao, it.quantidade, it.unidadeMedida, it.valorUnitarioEstimado
        FROM config_lances cl
        LEFT JOIN licitacoes l ON cl.cnpj = l.cnpj AND cl.ano = l.anoCompra AND cl.sequencial = l.sequencialCompra
        LEFT JOIN itens it ON l.id = it.licitacaoId AND cl.numeroItem = it.numeroItem
        WHERE cl.ativo = 1
        ORDER BY l.dataEncerramentoProposta ASC
      `).all();

      res.json({ success: true, data: configs });
    } catch (error) {
      console.error('Erro ao buscar configs:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salvar/atualizar configuração de lance
  app.post('/api/robo/config', (req, res) => {
    try {
      const { cnpj, ano, sequencial, numeroItem, precoMinimo, descontoPercentual, descontoFixo, tipoDesconto, horaExataTermino, tempoAntecedencia, observacao, ativo } = req.body;

      if (!cnpj || !ano || !sequencial || !numeroItem) {
        return res.status(400).json({ success: false, error: 'Campos obrigatórios: cnpj, ano, sequencial, numeroItem' });
      }

      const stmt = db.prepare(`
        INSERT INTO config_lances (cnpj, ano, sequencial, numeroItem, precoMinimo, descontoPercentual, descontoFixo, tipoDesconto, horaExataTermino, tempoAntecedencia, observacao, ativo, dataAtualizacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(cnpj, ano, sequencial, numeroItem) DO UPDATE SET
          precoMinimo = excluded.precoMinimo,
          descontoPercentual = excluded.descontoPercentual,
          descontoFixo = excluded.descontoFixo,
          tipoDesconto = excluded.tipoDesconto,
          horaExataTermino = excluded.horaExataTermino,
          tempoAntecedencia = excluded.tempoAntecedencia,
          observacao = excluded.observacao,
          ativo = excluded.ativo,
          dataAtualizacao = CURRENT_TIMESTAMP
      `);

      stmt.run(
        cnpj, parseInt(ano), parseInt(sequencial), parseInt(numeroItem),
        precoMinimo || null,
        descontoPercentual || null,
        descontoFixo || null,
        tipoDesconto || 'percentual',
        horaExataTermino || null,
        tempoAntecedencia || 5,
        observacao || null,
        ativo !== undefined ? (ativo ? 1 : 0) : 1
      );

      res.json({ success: true, message: 'Configuração salva' });
    } catch (error) {
      console.error('Erro ao salvar config:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salvar múltiplas configurações de uma vez
  app.post('/api/robo/config/batch', (req, res) => {
    try {
      const { configs } = req.body;

      if (!configs || !Array.isArray(configs)) {
        return res.status(400).json({ success: false, error: 'configs deve ser um array' });
      }

      const stmt = db.prepare(`
        INSERT INTO config_lances (cnpj, ano, sequencial, numeroItem, precoMinimo, descontoPercentual, descontoFixo, tipoDesconto, horaExataTermino, tempoAntecedencia, observacao, ativo, dataAtualizacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(cnpj, ano, sequencial, numeroItem) DO UPDATE SET
          precoMinimo = excluded.precoMinimo,
          descontoPercentual = excluded.descontoPercentual,
          descontoFixo = excluded.descontoFixo,
          tipoDesconto = excluded.tipoDesconto,
          horaExataTermino = excluded.horaExataTermino,
          tempoAntecedencia = excluded.tempoAntecedencia,
          observacao = excluded.observacao,
          ativo = excluded.ativo,
          dataAtualizacao = CURRENT_TIMESTAMP
      `);

      const transaction = db.transaction(() => {
        for (const c of configs) {
          stmt.run(
            c.cnpj, parseInt(c.ano), parseInt(c.sequencial), parseInt(c.numeroItem),
            c.precoMinimo || null,
            c.descontoPercentual || null,
            c.descontoFixo || null,
            c.tipoDesconto || 'percentual',
            c.horaExataTermino || null,
            c.tempoAntecedencia || 5,
            c.observacao || null,
            c.ativo !== undefined ? (c.ativo ? 1 : 0) : 1
          );
        }
      });
      transaction();

      res.json({ success: true, message: `${configs.length} configurações salvas` });
    } catch (error) {
      console.error('Erro ao salvar configs batch:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Remover configuração
  app.delete('/api/robo/config/:cnpj/:ano/:sequencial/:numeroItem', (req, res) => {
    try {
      const { cnpj, ano, sequencial, numeroItem } = req.params;

      db.prepare('DELETE FROM config_lances WHERE cnpj = ? AND ano = ? AND sequencial = ? AND numeroItem = ?')
        .run(cnpj, parseInt(ano), parseInt(sequencial), parseInt(numeroItem));

      res.json({ success: true, message: 'Configuração removida' });
    } catch (error) {
      console.error('Erro ao remover config:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Listar licitações com interesse para configurar robô
  app.get('/api/robo/licitacoes', async (req, res) => {
    try {
      let rows;
      if (USE_PG) {
        // Cross-DB: pega interesses + kanban + config_lances no tenant, lookup PG
        const intRows = db.prepare(`
          SELECT DISTINCT i.cnpj, i.ano, i.sequencial,
                 (SELECT COUNT(*) FROM interesse i2 WHERE i2.cnpj=i.cnpj AND i2.ano=i.ano AND i2.sequencial=i.sequencial) AS qtdItensInteresse,
                 (SELECT COUNT(*) FROM config_lances cl WHERE cl.cnpj=i.cnpj AND cl.ano=i.ano AND cl.sequencial=i.sequencial AND cl.ativo=1) AS qtdItensConfigurados,
                 (SELECT status FROM kanban_status k WHERE k.cnpj=i.cnpj AND k.ano=i.ano AND k.sequencial=i.sequencial) AS kanbanStatus
            FROM interesse i
        `).all();
        if (intRows.length === 0) return res.json({ success: true, data: [] });
        const values = intRows.map((_, j) => `($${j*3+1}::text,$${j*3+2}::int,$${j*3+3}::bigint)`).join(',');
        const params = [];
        for (const r of intRows) params.push(String(r.cnpj), Number(r.ano), Number(r.sequencial));
        const lic = await catalogPg.query(`
          WITH keys(cnpj, ano, sequencial) AS (VALUES ${values})
          SELECT k.cnpj, k.ano, k.sequencial,
                 l."objetoCompra" AS "objetoCompra", l."razaoSocial" AS "nomeOrgao",
                 COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") AS "dataEncerramentoProposta",
                 l."linkSistemaOrigem" AS "linkSistemaOrigem", l."modalidadeNome" AS "modalidadeNome"
            FROM keys k
            JOIN licitacoes l ON l."cnpj"=k.cnpj AND l."anoCompra"=k.ano AND l."sequencialCompra"=k.sequencial
           WHERE COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") >= now()
        ORDER BY COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") ASC
        `, params);
        const intMap = new Map();
        for (const r of intRows) intMap.set(`${r.cnpj}|${r.ano}|${r.sequencial}`, r);
        rows = lic.map(l => {
          const t = intMap.get(`${l.cnpj}|${l.ano}|${l.sequencial}`) || {};
          return { ...l, kanbanStatus: t.kanbanStatus || null, qtdItensInteresse: t.qtdItensInteresse || 0, qtdItensConfigurados: t.qtdItensConfigurados || 0 };
        });
      } else {
        const sql = `
          SELECT DISTINCT
            l.cnpj,
            l.anoCompra as ano,
            l.sequencialCompra as sequencial,
            l.objetoCompra,
            l.razaoSocial as nomeOrgao,
            l.dataEncerramentoProposta,
            l.linkSistemaOrigem,
            l.modalidadeNome,
            k.status as kanbanStatus,
            (SELECT COUNT(*) FROM interesse i WHERE i.cnpj = l.cnpj AND i.ano = l.anoCompra AND i.sequencial = l.sequencialCompra) as qtdItensInteresse,
            (SELECT COUNT(*) FROM config_lances cl WHERE cl.cnpj = l.cnpj AND cl.ano = l.anoCompra AND cl.sequencial = l.sequencialCompra AND cl.ativo = 1) as qtdItensConfigurados
          FROM licitacoes l
          INNER JOIN interesse i ON l.cnpj = i.cnpj AND l.anoCompra = i.ano AND l.sequencialCompra = i.sequencial
          LEFT JOIN kanban_status k ON l.cnpj = k.cnpj AND l.anoCompra = k.ano AND l.sequencialCompra = k.sequencial
          WHERE l.dataEncerramentoProposta >= datetime('now')
          ORDER BY l.dataEncerramentoProposta ASC
        `;
        rows = db.prepare(sql).all();
      }
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('Erro ao buscar licitações robô:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Buscar itens de interesse de uma licitação para configurar
  app.get('/api/robo/itens/:cnpj/:ano/:sequencial', async (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.params;

      if (USE_PG) {
        // Cross-DB: lê interesse + config_lances tenant, busca catalog itens em PG por par (licitacaoId, numeroItem)
        const intRows = db.prepare(`
          SELECT i.numeroItem,
                 cl.id as configId, cl.precoMinimo, cl.descontoPercentual, cl.descontoFixo,
                 cl.tipoDesconto, cl.horaExataTermino, cl.tempoAntecedencia, cl.observacao, cl.ativo
            FROM interesse i
       LEFT JOIN config_lances cl ON i.cnpj = cl.cnpj AND i.ano = cl.ano AND i.sequencial = cl.sequencial AND i.numeroItem = cl.numeroItem
           WHERE i.cnpj = ? AND i.ano = ? AND i.sequencial = ?
        ORDER BY i.numeroItem
        `).all(cnpj, parseInt(ano), parseInt(sequencial));
        if (intRows.length === 0) return res.json({ success: true, data: [] });

        // Busca licitação + itens em PG
        const lic = await catalogPg.queryOne(
          `SELECT "id" FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3`,
          [cnpj, parseInt(ano), parseInt(sequencial)]
        );
        const itens = lic ? await catalogPg.query(
          `SELECT "numeroItem" AS "numeroItem", "descricao" AS descricao, "quantidade" AS quantidade,
                  "unidadeMedida" AS "unidadeMedida", "valorUnitarioEstimado" AS "valorUnitarioEstimado",
                  "valorTotal" AS "valorTotal"
             FROM itens WHERE "licitacaoId"=$1`,
          [lic.id]
        ) : [];
        const itMap = new Map();
        for (const it of itens) itMap.set(it.numeroItem, it);
        const rows = intRows.map(i => ({ ...i, ...(itMap.get(i.numeroItem) || {}) }));
        return res.json({ success: true, data: rows });
      }

      const sql = `
        SELECT
          i.numeroItem,
          it.descricao,
          it.quantidade,
          it.unidadeMedida,
          it.valorUnitarioEstimado,
          it.valorTotal,
          cl.id as configId,
          cl.precoMinimo,
          cl.descontoPercentual,
          cl.descontoFixo,
          cl.tipoDesconto,
          cl.horaExataTermino,
          cl.tempoAntecedencia,
          cl.observacao,
          cl.ativo
        FROM interesse i
        LEFT JOIN licitacoes l ON i.cnpj = l.cnpj AND i.ano = l.anoCompra AND i.sequencial = l.sequencialCompra
        LEFT JOIN itens it ON l.id = it.licitacaoId AND i.numeroItem = it.numeroItem
        LEFT JOIN config_lances cl ON i.cnpj = cl.cnpj AND i.ano = cl.ano AND i.sequencial = cl.sequencial AND i.numeroItem = cl.numeroItem
        WHERE i.cnpj = ? AND i.ano = ? AND i.sequencial = ?
        ORDER BY i.numeroItem
      `;

      const rows = db.prepare(sql).all(cnpj, parseInt(ano), parseInt(sequencial));
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('Erro ao buscar itens:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Robo] Rotas registradas');
}

module.exports = { registrarRotasRobo };
