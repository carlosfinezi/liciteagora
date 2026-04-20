// tracking-routes.js
//
// Rotas HTTP do "tracking" de licitações — o conjunto de marcadores
// que o operador usa para acompanhar/ignorar licitações no dia-a-dia.
// Extraído de server.js em NFSE-M06 onda 6.14.
//
// Escopo: 12 rotas organizadas em 5 subclusters que compartilham o
// tema "estado de acompanhamento de uma licitação pelo usuário":
//
//   KANBAN (3 rotas, tabela kanban_status)
//     GET    /api/kanban                              board com joins em licitacoes/interesse
//     PUT    /api/kanban/:cnpj/:ano/:sequencial       UPSERT status + observação
//     DELETE /api/kanban/:cnpj/:ano/:sequencial       remove do board
//
//   AGENDA (1 rota)
//     GET    /api/agenda                              calendário das licitações com
//                                                     interesse, filtrável por mês+ano
//
//   LIDA/LIDAS (3 rotas, tabela licitacao_lida)
//     POST   /api/lida                                marca como lida
//     DELETE /api/lida/:cnpj/:ano/:sequencial         desmarca
//     GET    /api/lidas                               listagem como mapa para lookup O(1)
//
//   INTERESSES LISTING (1 rota, tabela interesse)
//     GET    /api/interesses/licitacoes               mapa licitação→qtdItens para o UI
//
//   SEM-INTERESSE (4 rotas, tabela sem_interesse)
//     POST   /api/sem-interesse                       marca
//     DELETE /api/sem-interesse/:cnpj/:ano/:sequencial desmarca
//     GET    /api/sem-interesse                       mapa para lookup
//     GET    /api/sem-interesse/detalhado             JOIN completo com licitacoes
//
// DEPENDÊNCIAS: só `db` (better-sqlite3). Nenhum helper/estado
// compartilhado — todas as rotas são CRUDs simples/JOINs.
//
// NÃO INCLUI: as rotas de /api/interesse/* (CRUD por item, salva
// marcação item-a-item na tabela `interesse`), que continuam em
// server.js. O que este módulo oferece em /api/interesses/licitacoes é
// um LISTING agregado (GROUP BY licitacao) para o UI saber rapidamente
// quais licitações têm ao menos um item marcado — semântica diferente.
// O CRUD por item fica para uma onda seguinte.
//
// Tabelas lidas/escritas aqui também são lidas de outros lugares
// (agenda/robo enriquecem resultados com JOIN em kanban_status e
// interesse), mas nenhum outro lugar FAZ WRITE nessas tabelas senão
// estas rotas — a extração é segura e atômica por domínio.

function registrarRotasTracking(app, db) {
  // ==================== KANBAN ====================
  app.get('/api/kanban', (req, res) => {
    try {
      const sql = `
        SELECT
          k.*,
          l.objetoCompra,
          l.razaoSocial as nomeOrgao,
          l.codigoUnidade,
          l.dataEncerramentoProposta,
          l.linkSistemaOrigem,
          l.modalidadeNome,
          (SELECT COUNT(*) FROM interesse i WHERE i.cnpj = k.cnpj AND i.ano = k.ano AND i.sequencial = k.sequencial) as qtdItens
        FROM kanban_status k
        LEFT JOIN licitacoes l ON k.cnpj = l.cnpj AND k.ano = l.anoCompra AND k.sequencial = l.sequencialCompra
        ORDER BY l.dataEncerramentoProposta ASC
      `;
      const rows = db.prepare(sql).all();
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('Erro ao buscar kanban:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.put('/api/kanban/:cnpj/:ano/:sequencial', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.params;
      const { status, observacao } = req.body;

      const stmt = db.prepare(`
        INSERT INTO kanban_status (cnpj, ano, sequencial, status, observacao, dataAtualizacao)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(cnpj, ano, sequencial) DO UPDATE SET
          status = excluded.status,
          observacao = excluded.observacao,
          dataAtualizacao = CURRENT_TIMESTAMP
      `);
      stmt.run(cnpj, ano, sequencial, status || 'analise', observacao || '');

      res.json({ success: true, message: 'Status atualizado' });
    } catch (error) {
      console.error('Erro ao atualizar kanban:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/kanban/:cnpj/:ano/:sequencial', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.params;
      db.prepare('DELETE FROM kanban_status WHERE cnpj = ? AND ano = ? AND sequencial = ?').run(cnpj, ano, sequencial);
      res.json({ success: true, message: 'Removido do kanban' });
    } catch (error) {
      console.error('Erro ao remover do kanban:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== AGENDA ====================
  app.get('/api/agenda', (req, res) => {
    try {
      const { mes, ano } = req.query;

      let sql = `
        SELECT DISTINCT
          l.cnpj,
          l.anoCompra as ano,
          l.sequencialCompra as sequencial,
          l.objetoCompra,
          l.razaoSocial as nomeOrgao,
          l.dataEncerramentoProposta,
          l.linkSistemaOrigem,
          l.modalidadeNome,
          k.status,
          (SELECT COUNT(*) FROM interesse i WHERE i.cnpj = l.cnpj AND i.ano = l.anoCompra AND i.sequencial = l.sequencialCompra) as qtdItens
        FROM licitacoes l
        INNER JOIN interesse i ON l.cnpj = i.cnpj AND l.anoCompra = i.ano AND l.sequencialCompra = i.sequencial
        LEFT JOIN kanban_status k ON l.cnpj = k.cnpj AND l.anoCompra = k.ano AND l.sequencialCompra = k.sequencial
        WHERE l.dataEncerramentoProposta IS NOT NULL
      `;

      const params = [];
      if (mes && ano) {
        sql += ` AND strftime('%Y-%m', l.dataEncerramentoProposta) = ?`;
        params.push(`${ano}-${mes.toString().padStart(2, '0')}`);
      }

      sql += ' ORDER BY l.dataEncerramentoProposta ASC';

      const rows = db.prepare(sql).all(...params);
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('Erro ao buscar agenda:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== LIDA / LIDAS ====================
  app.post('/api/lida', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.body;

      if (!cnpj || !ano || !sequencial) {
        return res.status(400).json({
          success: false,
          error: 'cnpj, ano e sequencial são obrigatórios'
        });
      }

      const stmt = db.prepare(`
        INSERT OR REPLACE INTO licitacao_lida (cnpj, ano, sequencial, dataLeitura)
        VALUES (?, ?, ?, datetime('now'))
      `);

      stmt.run(cnpj, parseInt(ano), parseInt(sequencial));

      res.json({
        success: true,
        message: 'Licitação marcada como lida'
      });

    } catch (error) {
      console.error('Erro ao marcar como lida:', error.message);
      res.status(500).json({
        success: false,
        error: 'Erro ao marcar como lida',
        details: error.message
      });
    }
  });

  app.delete('/api/lida/:cnpj/:ano/:sequencial', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.params;

      const result = db.prepare(
        'DELETE FROM licitacao_lida WHERE cnpj = ? AND ano = ? AND sequencial = ?'
      ).run(cnpj, parseInt(ano), parseInt(sequencial));

      res.json({
        success: true,
        message: result.changes > 0 ? 'Desmarcada' : 'Não encontrada'
      });

    } catch (error) {
      console.error('Erro ao desmarcar:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/lidas', (req, res) => {
    try {
      const lidas = db.prepare('SELECT cnpj, ano, sequencial FROM licitacao_lida').all();

      // Retorna um Set-like object para fácil verificação
      const lidasMap = {};
      lidas.forEach(l => {
        lidasMap[l.cnpj + '-' + l.ano + '-' + l.sequencial] = true;
      });

      res.json({
        success: true,
        data: lidasMap,
        total: lidas.length
      });

    } catch (error) {
      console.error('Erro ao listar lidas:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== INTERESSES LISTING ====================
  app.get('/api/interesses/licitacoes', (req, res) => {
    try {
      const interesses = db.prepare(`
        SELECT DISTINCT cnpj, ano, sequencial, COUNT(*) as qtdItens
        FROM interesse
        GROUP BY cnpj, ano, sequencial
      `).all();

      // Retorna um Map-like object para fácil verificação
      const interessesMap = {};
      interesses.forEach(i => {
        interessesMap[i.cnpj + '-' + i.ano + '-' + i.sequencial] = i.qtdItens;
      });

      res.json({
        success: true,
        data: interessesMap,
        total: interesses.length
      });

    } catch (error) {
      console.error('Erro ao listar interesses:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== SEM-INTERESSE ====================
  app.post('/api/sem-interesse', (req, res) => {
    try {
      const { cnpj, ano, sequencial, motivo } = req.body;

      if (!cnpj || !ano || !sequencial) {
        return res.status(400).json({
          success: false,
          error: 'cnpj, ano e sequencial são obrigatórios'
        });
      }

      db.prepare(`
        INSERT OR REPLACE INTO sem_interesse (cnpj, ano, sequencial, motivo, dataCriacao)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(cnpj, parseInt(ano), parseInt(sequencial), motivo || null);

      res.json({ success: true, message: 'Marcada como sem interesse' });

    } catch (error) {
      console.error('Erro ao marcar sem interesse:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/sem-interesse/:cnpj/:ano/:sequencial', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.params;

      const result = db.prepare(
        'DELETE FROM sem_interesse WHERE cnpj = ? AND ano = ? AND sequencial = ?'
      ).run(cnpj, parseInt(ano), parseInt(sequencial));

      res.json({
        success: true,
        message: result.changes > 0 ? 'Removida' : 'Não encontrada'
      });

    } catch (error) {
      console.error('Erro ao remover sem interesse:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/sem-interesse', (req, res) => {
    try {
      const rows = db.prepare('SELECT cnpj, ano, sequencial, motivo, dataCriacao FROM sem_interesse').all();

      const mapa = {};
      rows.forEach(r => {
        mapa[r.cnpj + '-' + r.ano + '-' + r.sequencial] = { motivo: r.motivo, data: r.dataCriacao };
      });

      res.json({ success: true, data: mapa, total: rows.length });

    } catch (error) {
      console.error('Erro ao listar sem interesse:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/sem-interesse/detalhado', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT s.cnpj, s.ano, s.sequencial, s.motivo, s.dataCriacao,
          l.objetoCompra, l.nomeUnidade, l.razaoSocial, l.ufSigla, l.municipioNome,
          l.valorTotalEstimado, l.dataEncerramentoProposta, l.modalidadeNome,
          l.situacaoCompraNome, l.linkSistemaOrigem, l.numeroCompra
        FROM sem_interesse s
        LEFT JOIN licitacoes l ON s.cnpj = l.cnpj AND s.ano = l.anoCompra AND s.sequencial = l.sequencialCompra
        ORDER BY s.dataCriacao DESC
      `).all();
      res.json({ success: true, licitacoes: rows, total: rows.length });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Tracking] Rotas registradas');
}

module.exports = { registrarRotasTracking };
