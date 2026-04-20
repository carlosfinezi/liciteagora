// proposta-routes.js
//
// Rotas HTTP agrupadas sob o tema "minha proposta": interesse por item,
// valores/fabricante/marca por item, e listagem de propostas prontas
// para envio pelo Comprasnet. Extraído de server.js em NFSE-M06
// onda 6.15.
//
// NOMENCLATURA: este módulo é `proposta-routes.js` (singular). NÃO
// confundir com `propostas-participacoes-routes.js` (onda 6.2 — plural),
// que trata de "participações em pregão" (outro subdomínio).
//
// Escopo: 9 rotas em 3 subclusters:
//
//   INTERESSE por item (4 rotas, tabela `interesse`)
//     POST   /api/interesse              UPSERT batch de itens marcados;
//                                        também cria entry em kanban_status
//                                        (status 'analise') de forma
//                                        INSERT OR IGNORE — mantém o
//                                        efeito colateral do monolito
//     GET    /api/interesse              listagem com JOIN em licitacoes,
//                                        itens e grupos_palavras; filtrável
//                                        por cnpj+ano+sequencial via query
//     DELETE /api/interesse/:id          remove 1 registro por id
//     DELETE /api/interesse              TRUNCATE (remove todos)
//
//   VALORES-PROPOSTA (4 rotas, tabela `valores_proposta`)
//     POST   /api/valores-proposta                        UPSERT 1 item
//     POST   /api/valores-proposta/batch                  UPSERT transacional N
//     GET    /api/valores-proposta/:cnpj/:ano/:sequencial devolve objeto
//                                                         indexado por numeroItem
//     DELETE /api/valores-proposta/:cnpj/:ano/:sequencial apaga todos os
//                                                         valores da licitação
//
//   PROPOSTAS PENDENTES (1 rota, listagem read-only)
//     GET    /api/comprasnet/propostas-pendentes   lê kanban_status +
//                                                   valores_proposta +
//                                                   licitacoes. Retorna até
//                                                   10 licitações com status
//                                                   'pronto' agrupadas por
//                                                   licitação + itens[]
//
// DEPENDÊNCIAS: só `db` (better-sqlite3). Nenhum helper/estado
// compartilhado.
//
// EFEITO COLATERAL IMPORTANTE (POST /api/interesse): ao marcar itens
// como de interesse, o módulo também insere na tabela `kanban_status`
// com status='analise' via INSERT OR IGNORE. Esse é o comportamento
// original do monolito — a extração preserva 1:1. kanban_status também
// é manipulado por tracking-routes.js (onda 6.14), mas o INSERT aqui
// só dispara se ainda não houver linha, então os dois módulos
// convivem bem.

function registrarRotasProposta(app, db) {
  // ==================== INTERESSE ====================
  app.post('/api/interesse', (req, res) => {
    try {
      const { cnpj, ano, sequencial, itens, grupoId } = req.body;

      if (!cnpj || !ano || !sequencial || !itens || !Array.isArray(itens)) {
        return res.status(400).json({
          success: false,
          error: 'Dados incompletos. Necessario: cnpj, ano, sequencial, itens[]'
        });
      }

      const insertInteresse = db.prepare(`
        INSERT OR REPLACE INTO interesse (cnpj, ano, sequencial, numeroItem, grupoId, dataCriacao)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      // Adicionar automaticamente ao Kanban
      const insertKanban = db.prepare(`
        INSERT OR IGNORE INTO kanban_status (cnpj, ano, sequencial, status, dataAtualizacao)
        VALUES (?, ?, ?, 'analise', CURRENT_TIMESTAMP)
      `);

      const parsedGrupoId = grupoId ? parseInt(grupoId) : null;

      const transaction = db.transaction(() => {
        for (const numeroItem of itens) {
          insertInteresse.run(cnpj, ano, sequencial, numeroItem, parsedGrupoId);
        }
        // Adiciona ao kanban (ignora se já existir)
        insertKanban.run(cnpj, ano, sequencial);
      });
      transaction();

      res.json({
        success: true,
        message: itens.length + ' item(s) salvo(s) com interesse',
        data: { cnpj, ano, sequencial, itens }
      });

    } catch (error) {
      console.error('Erro ao salvar interesse:', error.message);
      res.status(500).json({
        success: false,
        error: 'Erro ao salvar interesse',
        details: error.message
      });
    }
  });

  app.get('/api/interesse', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.query;

      let sql = `
        SELECT
          i.id,
          i.cnpj,
          i.ano,
          i.sequencial,
          i.numeroItem,
          i.dataCriacao,
          i.grupoId,
          g.nome as grupoNome,
          l.objetoCompra,
          l.razaoSocial as nomeOrgao,
          l.codigoUnidade as codigoUnidadeCompradora,
          l.valorTotalEstimado as valorTotalLicitacao,
          l.dataAberturaProposta,
          l.dataEncerramentoProposta,
          l.linkSistemaOrigem,
          l.modalidadeNome,
          l.numeroCompra,
          it.descricao,
          it.quantidade,
          it.unidadeMedida,
          it.valorUnitarioEstimado,
          it.valorTotal
        FROM interesse i
        LEFT JOIN grupos_palavras g ON g.id = i.grupoId
        LEFT JOIN licitacoes l ON i.cnpj = l.cnpj AND i.ano = l.anoCompra AND i.sequencial = l.sequencialCompra
        LEFT JOIN itens it ON l.id = it.licitacaoId AND i.numeroItem = it.numeroItem
      `;
      let params = [];

      if (cnpj && ano && sequencial) {
        sql += ' WHERE i.cnpj = ? AND i.ano = ? AND i.sequencial = ?';
        params = [cnpj, ano, sequencial];
      }

      sql += ' ORDER BY l.dataAberturaProposta ASC, i.dataCriacao DESC';

      const interesses = db.prepare(sql).all(...params);

      res.json({
        success: true,
        data: interesses
      });

    } catch (error) {
      console.error('Erro ao listar interesse:', error.message);
      res.status(500).json({
        success: false,
        error: 'Erro ao listar interesse',
        details: error.message
      });
    }
  });

  app.delete('/api/interesse/:id', (req, res) => {
    try {
      const { id } = req.params;

      const result = db.prepare('DELETE FROM interesse WHERE id = ?').run(id);

      if (result.changes > 0) {
        res.json({ success: true, message: 'Interesse removido' });
      } else {
        res.status(404).json({ success: false, error: 'Interesse nao encontrado' });
      }

    } catch (error) {
      console.error('Erro ao remover interesse:', error.message);
      res.status(500).json({
        success: false,
        error: 'Erro ao remover interesse',
        details: error.message
      });
    }
  });

  app.delete('/api/interesse', (req, res) => {
    try {
      const result = db.prepare('DELETE FROM interesse').run();

      res.json({
        success: true,
        message: `${result.changes} interesse(s) removido(s)`,
        removidos: result.changes
      });

    } catch (error) {
      console.error('Erro ao remover todos interesses:', error.message);
      res.status(500).json({
        success: false,
        error: 'Erro ao remover interesses',
        details: error.message
      });
    }
  });

  // ==================== VALORES-PROPOSTA ====================
  app.post('/api/valores-proposta', (req, res) => {
    try {
      const { cnpj, ano, sequencial, numeroItem, valorUnitario, marca, modelo, fabricante, selecionado } = req.body;

      if (!cnpj || !ano || !sequencial || numeroItem === undefined) {
        return res.status(400).json({
          success: false,
          error: 'Dados incompletos. Necessário: cnpj, ano, sequencial, numeroItem'
        });
      }

      const stmt = db.prepare(`
        INSERT OR REPLACE INTO valores_proposta
        (cnpj, ano, sequencial, numeroItem, valorUnitario, marca, modelo, fabricante, selecionado, dataAtualizacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      stmt.run(cnpj, ano, sequencial, numeroItem, valorUnitario || null, marca || '', modelo || '', fabricante || '', selecionado ? 1 : 0);

      res.json({
        success: true,
        message: 'Valor da proposta salvo'
      });

    } catch (error) {
      console.error('Erro ao salvar valor da proposta:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/valores-proposta/batch', (req, res) => {
    try {
      const { cnpj, ano, sequencial, itens } = req.body;

      if (!cnpj || !ano || !sequencial || !itens || !Array.isArray(itens)) {
        return res.status(400).json({
          success: false,
          error: 'Dados incompletos. Necessário: cnpj, ano, sequencial, itens[]'
        });
      }

      const stmt = db.prepare(`
        INSERT OR REPLACE INTO valores_proposta
        (cnpj, ano, sequencial, numeroItem, valorUnitario, marca, modelo, fabricante, selecionado, dataAtualizacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      const transaction = db.transaction(() => {
        for (const item of itens) {
          stmt.run(
            cnpj, ano, sequencial, item.numeroItem,
            item.valorUnitario || null,
            item.marca || '',
            item.modelo || '',
            item.fabricante || '',
            item.selecionado ? 1 : 0
          );
        }
      });
      transaction();

      res.json({
        success: true,
        message: `${itens.length} valor(es) salvo(s)`
      });

    } catch (error) {
      console.error('Erro ao salvar valores da proposta:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/valores-proposta/:cnpj/:ano/:sequencial', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.params;

      const valores = db.prepare(`
        SELECT numeroItem, valorUnitario, marca, modelo, fabricante, selecionado
        FROM valores_proposta
        WHERE cnpj = ? AND ano = ? AND sequencial = ?
      `).all(cnpj, ano, sequencial);

      // Converter para objeto indexado por numeroItem
      const valoresObj = {};
      for (const v of valores) {
        valoresObj[v.numeroItem] = {
          valorUnitario: v.valorUnitario,
          marca: v.marca || '',
          modelo: v.modelo || '',
          fabricante: v.fabricante || '',
          selecionado: v.selecionado === 1
        };
      }

      res.json({
        success: true,
        valores: valoresObj
      });

    } catch (error) {
      console.error('Erro ao buscar valores da proposta:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/valores-proposta/:cnpj/:ano/:sequencial', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.params;

      const result = db.prepare(`
        DELETE FROM valores_proposta
        WHERE cnpj = ? AND ano = ? AND sequencial = ?
      `).run(cnpj, ano, sequencial);

      res.json({
        success: true,
        message: `${result.changes} valor(es) removido(s)`
      });

    } catch (error) {
      console.error('Erro ao remover valores da proposta:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== PROPOSTAS PENDENTES ====================
  app.get('/api/comprasnet/propostas-pendentes', (req, res) => {
    try {
      // Busca licitacoes que estao prontas para enviar proposta
      const sql = `
        SELECT DISTINCT
          k.cnpj, k.ano, k.sequencial,
          l.objetoCompra,
          l.codigoUnidade as uasg,
          l.linkSistemaOrigem,
          vp.numeroItem as numero,
          vp.valor
        FROM kanban_status k
        JOIN licitacoes l ON k.cnpj = l.cnpj AND k.ano = l.anoCompra AND k.sequencial = l.sequencialCompra
        JOIN valores_proposta vp ON k.cnpj = vp.cnpj AND k.ano = vp.ano AND k.sequencial = vp.sequencial
        WHERE k.status = 'pronto'
        ORDER BY l.dataEncerramentoProposta ASC
        LIMIT 10
      `;

      const rows = db.prepare(sql).all();

      // Agrupa por licitacao
      const licitacoes = {};
      for (const row of rows) {
        const key = row.cnpj + '-' + row.ano + '-' + row.sequencial;
        if (!licitacoes[key]) {
          licitacoes[key] = {
            cnpj: row.cnpj,
            ano: row.ano,
            sequencial: row.sequencial,
            uasg: row.uasg,
            objetoCompra: row.objetoCompra,
            linkSistemaOrigem: row.linkSistemaOrigem,
            itens: []
          };
        }
        licitacoes[key].itens.push({
          numero: row.numero,
          valor: row.valor
        });
      }

      res.json(Object.values(licitacoes));
    } catch (error) {
      console.error('Erro ao buscar propostas pendentes:', error.message);
      res.json([]);
    }
  });

  console.log('[Proposta] Rotas registradas');
}

module.exports = { registrarRotasProposta };
