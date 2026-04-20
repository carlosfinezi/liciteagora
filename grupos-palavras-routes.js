// grupos-palavras-routes.js
//
// CRUD de grupos de palavras-chave (pesquisa/exclusão) + vínculos entre
// grupos de pesquisa e grupos de exclusão + rota de pesquisa que usa as
// palavras para buscar licitações na tabela `licitacoes` (com janela de
// 30 dias em dataPublicacaoPncp). Extraído de server.js em NFSE-M06
// onda 6.3.
//
// Dependências externas: apenas `app` (Express) e `db` (better-sqlite3).
// Nada de axios, telegram ou filesystem aqui.

function registrarRotasGruposPalavras(app, db) {

  // Listar todos os grupos (filtrar por tipo via query param: ?tipo=pesquisa ou ?tipo=exclusao)
  app.get('/api/grupos-palavras', (req, res) => {
    try {
      const { tipo } = req.query;
      let query = `
        SELECT g.*,
          (SELECT COUNT(*) FROM grupos_palavras_itens WHERE grupoId = g.id) as totalPalavras
        FROM grupos_palavras g
      `;
      const params = [];

      if (tipo) {
        query += ` WHERE g.tipo = ?`;
        params.push(tipo);
      }

      query += ` ORDER BY g.tipo, g.nome`;

      const grupos = db.prepare(query).all(...params);

      // Buscar palavras e vínculos de cada grupo
      const gruposComPalavras = grupos.map(grupo => {
        const palavras = db.prepare(`
          SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ? ORDER BY palavra
        `).all(grupo.id).map(p => p.palavra);

        // Se for grupo de pesquisa, buscar grupos de exclusão vinculados
        let gruposExclusaoVinculados = [];
        if (grupo.tipo === 'pesquisa' || !grupo.tipo) {
          gruposExclusaoVinculados = db.prepare(`
            SELECT ge.id, ge.nome, ge.cor
            FROM grupos_pesquisa_exclusao gpe
            INNER JOIN grupos_palavras ge ON ge.id = gpe.grupoExclusaoId
            WHERE gpe.grupoPesquisaId = ?
            ORDER BY ge.nome
          `).all(grupo.id);
        }

        return { ...grupo, palavras, gruposExclusaoVinculados };
      });

      res.json({ success: true, data: gruposComPalavras });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Obter um grupo específico
  app.get('/api/grupos-palavras/:id', (req, res) => {
    try {
      const { id } = req.params;

      const grupo = db.prepare(`SELECT * FROM grupos_palavras WHERE id = ?`).get(id);

      if (!grupo) {
        return res.status(404).json({ success: false, error: 'Grupo não encontrado' });
      }

      const palavras = db.prepare(`
        SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ? ORDER BY palavra
      `).all(id).map(p => p.palavra);

      // Se for grupo de pesquisa, buscar grupos de exclusão vinculados
      let gruposExclusaoVinculados = [];
      if (grupo.tipo === 'pesquisa' || !grupo.tipo) {
        gruposExclusaoVinculados = db.prepare(`
          SELECT ge.id, ge.nome, ge.cor,
            (SELECT COUNT(*) FROM grupos_palavras_itens WHERE grupoId = ge.id) as totalPalavras
          FROM grupos_pesquisa_exclusao gpe
          INNER JOIN grupos_palavras ge ON ge.id = gpe.grupoExclusaoId
          WHERE gpe.grupoPesquisaId = ?
          ORDER BY ge.nome
        `).all(id);
      }

      res.json({ success: true, data: { ...grupo, palavras, gruposExclusaoVinculados } });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Criar novo grupo
  app.post('/api/grupos-palavras', (req, res) => {
    try {
      const { nome, descricao, cor, palavras, tipo, gruposExclusaoIds } = req.body;

      if (!nome) {
        return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
      }

      const tipoGrupo = tipo || 'pesquisa'; // 'pesquisa' ou 'exclusao'

      // Inserir grupo
      const result = db.prepare(`
        INSERT INTO grupos_palavras (nome, descricao, cor, tipo) VALUES (?, ?, ?, ?)
      `).run(nome, descricao || '', cor || '#1a5f7a', tipoGrupo);

      const grupoId = result.lastInsertRowid;

      // Inserir palavras se fornecidas
      if (palavras && Array.isArray(palavras)) {
        const insertPalavra = db.prepare(`
          INSERT OR IGNORE INTO grupos_palavras_itens (grupoId, palavra) VALUES (?, ?)
        `);

        palavras.forEach(palavra => {
          if (palavra.trim()) {
            insertPalavra.run(grupoId, palavra.trim().toLowerCase());
          }
        });
      }

      // Inserir vínculos com grupos de exclusão (apenas para grupos de pesquisa)
      if (tipoGrupo === 'pesquisa' && Array.isArray(gruposExclusaoIds) && gruposExclusaoIds.length > 0) {
        const insertVinculo = db.prepare(`
          INSERT OR IGNORE INTO grupos_pesquisa_exclusao (grupoPesquisaId, grupoExclusaoId) VALUES (?, ?)
        `);

        gruposExclusaoIds.forEach(grupoExclusaoId => {
          if (grupoExclusaoId) {
            insertVinculo.run(grupoId, grupoExclusaoId);
          }
        });

        console.log(`[Grupos] Grupo "${nome}" vinculado a ${gruposExclusaoIds.length} grupo(s) de exclusão`);
      }

      console.log(`[Grupos] Grupo "${nome}" (${tipoGrupo}) criado com ID ${grupoId}`);
      res.json({ success: true, id: grupoId });
    } catch (error) {
      if (error.message.includes('UNIQUE')) {
        return res.status(400).json({ success: false, error: 'Já existe um grupo com este nome' });
      }
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Atualizar grupo
  app.put('/api/grupos-palavras/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { nome, descricao, cor, palavras, ativo, gruposExclusaoIds } = req.body;

      // Verificar se grupo existe
      const grupo = db.prepare(`SELECT * FROM grupos_palavras WHERE id = ?`).get(id);
      if (!grupo) {
        return res.status(404).json({ success: false, error: 'Grupo não encontrado' });
      }

      // Atualizar grupo
      db.prepare(`
        UPDATE grupos_palavras
        SET nome = ?, descricao = ?, cor = ?, ativo = ?, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        nome || grupo.nome,
        descricao !== undefined ? descricao : grupo.descricao,
        cor || grupo.cor,
        ativo !== undefined ? (ativo ? 1 : 0) : grupo.ativo,
        id
      );

      // Atualizar palavras se fornecidas
      if (palavras && Array.isArray(palavras)) {
        // Remove palavras antigas
        db.prepare(`DELETE FROM grupos_palavras_itens WHERE grupoId = ?`).run(id);

        // Insere novas palavras
        const insertPalavra = db.prepare(`
          INSERT OR IGNORE INTO grupos_palavras_itens (grupoId, palavra) VALUES (?, ?)
        `);

        palavras.forEach(palavra => {
          if (palavra.trim()) {
            insertPalavra.run(id, palavra.trim().toLowerCase());
          }
        });
      }

      // Atualizar vínculos com grupos de exclusão (apenas para grupos de pesquisa)
      if ((grupo.tipo === 'pesquisa' || !grupo.tipo) && Array.isArray(gruposExclusaoIds)) {
        // Remove vínculos antigos
        db.prepare(`DELETE FROM grupos_pesquisa_exclusao WHERE grupoPesquisaId = ?`).run(id);

        // Insere novos vínculos
        const insertVinculo = db.prepare(`
          INSERT OR IGNORE INTO grupos_pesquisa_exclusao (grupoPesquisaId, grupoExclusaoId) VALUES (?, ?)
        `);

        gruposExclusaoIds.forEach(grupoExclusaoId => {
          if (grupoExclusaoId) {
            insertVinculo.run(id, grupoExclusaoId);
          }
        });

        console.log(`[Grupos] Grupo "${nome || grupo.nome}" vinculado a ${gruposExclusaoIds.length} grupo(s) de exclusão`);
      }

      console.log(`[Grupos] Grupo "${nome || grupo.nome}" atualizado`);
      res.json({ success: true });
    } catch (error) {
      if (error.message.includes('UNIQUE')) {
        return res.status(400).json({ success: false, error: 'Já existe um grupo com este nome' });
      }
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Excluir grupo
  app.delete('/api/grupos-palavras/:id', (req, res) => {
    try {
      const { id } = req.params;

      // Verificar se grupo existe
      const grupo = db.prepare(`SELECT nome FROM grupos_palavras WHERE id = ?`).get(id);
      if (!grupo) {
        return res.status(404).json({ success: false, error: 'Grupo não encontrado' });
      }

      // Excluir palavras do grupo
      db.prepare(`DELETE FROM grupos_palavras_itens WHERE grupoId = ?`).run(id);

      // Excluir grupo
      db.prepare(`DELETE FROM grupos_palavras WHERE id = ?`).run(id);

      console.log(`[Grupos] Grupo "${grupo.nome}" excluído`);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Adicionar palavra a um grupo
  app.post('/api/grupos-palavras/:id/palavras', (req, res) => {
    try {
      const { id } = req.params;
      const { palavra } = req.body;

      if (!palavra || !palavra.trim()) {
        return res.status(400).json({ success: false, error: 'Palavra é obrigatória' });
      }

      db.prepare(`
        INSERT OR IGNORE INTO grupos_palavras_itens (grupoId, palavra) VALUES (?, ?)
      `).run(id, palavra.trim().toLowerCase());

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Remover palavra de um grupo
  app.delete('/api/grupos-palavras/:id/palavras/:palavra', (req, res) => {
    try {
      const { id, palavra } = req.params;

      db.prepare(`
        DELETE FROM grupos_palavras_itens WHERE grupoId = ? AND palavra = ?
      `).run(id, decodeURIComponent(palavra));

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Buscar licitações usando palavras de um grupo
  app.get('/api/grupos-palavras/:id/pesquisar', async (req, res) => {
    try {
      const { id } = req.params;

      // Buscar informações do grupo
      const grupo = db.prepare(`SELECT * FROM grupos_palavras WHERE id = ?`).get(id);
      if (!grupo) {
        return res.status(404).json({ success: false, error: 'Grupo não encontrado' });
      }

      // Buscar palavras do grupo
      const palavras = db.prepare(`
        SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?
      `).all(id).map(p => p.palavra);

      if (palavras.length === 0) {
        return res.json({ success: true, data: [], message: 'Grupo sem palavras configuradas' });
      }

      // Buscar grupos de exclusão vinculados e suas palavras
      let palavrasExclusao = [];
      if (grupo.tipo === 'pesquisa' || !grupo.tipo) {
        const gruposExclusaoVinculados = db.prepare(`
          SELECT grupoExclusaoId FROM grupos_pesquisa_exclusao WHERE grupoPesquisaId = ?
        `).all(id);

        if (gruposExclusaoVinculados.length > 0) {
          const idsExclusao = gruposExclusaoVinculados.map(g => g.grupoExclusaoId);
          palavrasExclusao = db.prepare(`
            SELECT DISTINCT palavra FROM grupos_palavras_itens
            WHERE grupoId IN (${idsExclusao.map(() => '?').join(',')})
          `).all(...idsExclusao).map(p => p.palavra.toLowerCase().trim());
        }
      }

      // Busca otimizada em duas etapas para performance
      // 1. Primeiro busca em objetoCompra (rápido)
      // 2. Depois busca em itens para licitações recentes

      const dataLimite = new Date();
      dataLimite.setDate(dataLimite.getDate() - 30);
      const dataLimiteStr = dataLimite.toISOString().split('T')[0];

      // Etapa 1: Busca rápida no objetoCompra
      const conditionsObjeto = palavras.map(() => `objetoCompra LIKE ?`).join(' OR ');
      const paramsObjeto = palavras.map(p => `%${p}%`);

      const licitacoesObjeto = db.prepare(`
        SELECT * FROM licitacoes
        WHERE dataPublicacaoPncp >= ? AND (${conditionsObjeto})
        ORDER BY dataPublicacaoPncp DESC
        LIMIT 100
      `).all(dataLimiteStr, ...paramsObjeto);

      // Etapa 2: Busca nos itens - usando subquery para limitar primeiro as licitações
      const idsEncontrados = new Set(licitacoesObjeto.map(l => l.id));

      const conditionsItens = palavras.map(() => `i.descricao LIKE ?`).join(' OR ');
      const paramsItens = palavras.map(p => `%${p}%`);

      // Primeiro pega os IDs das licitações recentes, depois busca nos itens
      const licitacoesItens = db.prepare(`
        SELECT DISTINCT l.* FROM licitacoes l
        WHERE l.id IN (
          SELECT DISTINCT i.licitacaoId FROM itens i
          WHERE i.licitacaoId IN (SELECT id FROM licitacoes WHERE dataPublicacaoPncp >= ?)
            AND (${conditionsItens})
          LIMIT 100
        )
        ORDER BY l.dataPublicacaoPncp DESC
      `).all(dataLimiteStr, ...paramsItens);

      // Combinar resultados únicos
      const licitacoesMap = new Map();
      [...licitacoesObjeto, ...licitacoesItens].forEach(l => {
        if (!licitacoesMap.has(l.id)) licitacoesMap.set(l.id, l);
      });

      let licitacoesRaw = Array.from(licitacoesMap.values())
        .sort((a, b) => new Date(b.dataPublicacaoPncp) - new Date(a.dataPublicacaoPncp))
        .slice(0, 100);

      // Aplicar filtro de exclusão automático (grupos de exclusão vinculados)
      if (palavrasExclusao.length > 0) {
        licitacoesRaw = licitacoesRaw.filter(lic => {
          let texto = (
            (lic.objetoCompra || '') + ' ' +
            (lic.informacaoComplementar || '') + ' ' +
            (lic.razaoSocial || '') + ' ' +
            (lic.nomeUnidade || '')
          ).toLowerCase();

          // Buscar itens da licitação para verificar também
          const itensRows = db.prepare('SELECT descricao FROM itens WHERE licitacaoId = ?').all(lic.id);
          itensRows.forEach(item => {
            texto += ' ' + (item.descricao || '').toLowerCase();
          });

          // Retorna TRUE se NENHUMA palavra de exclusão está no texto
          return !palavrasExclusao.some(exc => texto.includes(exc));
        });

        console.log(`[Grupos] Pesquisa do grupo ${id}: ${palavrasExclusao.length} palavras de exclusão aplicadas`);
      }

      // Formatar dados para o frontend
      const licitacoes = licitacoesRaw.map(row => {
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
              ufNome: row.ufSigla,
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

        return dados;
      });

      res.json({
        success: true,
        data: licitacoes,
        totalPalavras: palavras.length,
        exclusoesAplicadas: palavrasExclusao.length,
        grupoNome: grupo.nome
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Grupos] Rotas registradas');
}

module.exports = { registrarRotasGruposPalavras };
