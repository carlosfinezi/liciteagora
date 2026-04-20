// chat-mensagens-routes.js
//
// Rotas de leitura/listagem/estatística sobre a tabela `chat_mensagens`
// (mensagens capturadas do chat Comprasnet pela extensão + pelo monitor
// server-side). Extraído de server.js em NFSE-M06 onda 6.24.
//
// 10 rotas, todas em /api/chat/mensagens/*. Dependência única: `db`.
//
//   GET  /api/chat/mensagens/nao-lidas       count de lido=0 (rápido).
//                                             REGISTRADA 2x no monolito
//                                             — Express resolve pela 1ª.
//                                             Preservamos fielmente as
//                                             DUAS registrations (a 2ª é
//                                             dead code mas é 1:1).
//
//   POST /api/chat/mensagens/marcar-lida     UPDATE lido=1 por id (body).
//   POST /api/chat/mensagens/marcar-todas-lidas
//                                             UPDATE lido=1 por
//                                             (cnpjOrgao,ano,seq) ou
//                                             TUDO se sem filtro.
//
//   GET  /api/chat/mensagens                 LISTAGEM com filtros:
//                                             - ?cnpjOrgao
//                                             - ?ano + ?sequencial
//                                             - ?tipo=alerta|para-mim|cnpj
//                                               * para-mim = JOIN com
//                                                 fornecedor.cnpj (só dig)
//                                                 em identificadorDestinatario
//                                               * cnpj = temCnpjFornecedor
//                                                 OR identificadorDestinatario
//                                             - ?data=hoje|7dias|30dias
//                                             - ?busca (LIKE mensagem + remetente)
//                                             - ?limit (default 100)
//                                             - ?action=count-unread
//                                               (early return de count).
//
//   GET  /api/chat/mensagens/licitacoes      agrupa por compraId com
//                                             JOIN em participacoes_comprasnet
//                                             para nome do órgão / UASG /
//                                             ano / sequencial.
//   GET  /api/chat/mensagens/orgaos          agrupa por cnpj do órgão.
//
//   POST /api/chat/mensagens/:id/lido        UPDATE lido=1 por :id.
//   POST /api/chat/mensagens/lidas           idem marcar-todas-lidas
//                                             (paths alternativos legados).
//
//   GET  /api/chat/mensagens/stats           contagens: total, com CNPJ,
//                                             com palavras-chave,
//                                             notificadas, capturadas hoje.
//
// DEPENDÊNCIAS do factory: apenas `db`. Tabelas tocadas: chat_mensagens,
// fornecedor (para resolver meuCnpj no filtro tipo=para-mim/cnpj),
// participacoes_comprasnet (LEFT/INNER JOIN nas agregações).

function registrarRotasChatMensagens(app, db) {
  // Contar mensagens não lidas (DEVE vir antes da rota com parâmetros)
  app.get('/api/chat/mensagens/nao-lidas', (req, res) => {
    try {
      const result = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE lido = 0 OR lido IS NULL').get();
      res.json({ success: true, total: result.total || 0 });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Marcar mensagem específica como lida
  app.post('/api/chat/mensagens/marcar-lida', (req, res) => {
    try {
      const { id } = req.body;
      const agora = new Date().toISOString();
      db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE id = ?').run(agora, id);
      console.log(`[Chat] Mensagem ${id} marcada como lida`);
      res.json({ success: true, message: 'Mensagem marcada como lida' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Marcar todas mensagens como lidas
  app.post('/api/chat/mensagens/marcar-todas-lidas', (req, res) => {
    try {
      const { cnpjOrgao, ano, sequencial } = req.body;
      const agora = new Date().toISOString();

      if (cnpjOrgao && ano && sequencial) {
        db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE cnpjOrgao = ? AND ano = ? AND sequencial = ? AND (lido = 0 OR lido IS NULL)')
          .run(agora, cnpjOrgao, parseInt(ano), parseInt(sequencial));
      } else {
        db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE lido = 0 OR lido IS NULL').run(agora);
      }

      res.json({ success: true, message: 'Mensagens marcadas como lidas' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Listar mensagens capturadas (histórico)
  app.get('/api/chat/mensagens', (req, res) => {
    try {
      const { cnpjOrgao, ano, sequencial, tipo, data, busca, limit = 100, action } = req.query;

      // Ação especial: contar não lidas
      if (action === 'count-unread') {
        const result = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE lido = 0 OR lido IS NULL').get();
        return res.json({ success: true, total: result ? result.total : 0 });
      }

      let sql = 'SELECT * FROM chat_mensagens WHERE 1=1';
      const params = [];

      // Filtro por órgão (mesmo sem ano/sequencial)
      if (cnpjOrgao) {
        sql += ' AND cnpjOrgao = ?';
        params.push(cnpjOrgao);
      }

      // Filtro por licitação específica
      if (ano && sequencial) {
        sql += ' AND ano = ? AND sequencial = ?';
        params.push(parseInt(ano), parseInt(sequencial));
      }

      // Filtro por tipo
      if (tipo === 'alerta') {
        sql += ' AND palavrasChaveEncontradas IS NOT NULL AND palavrasChaveEncontradas != ""';
      } else if (tipo === 'para-mim') {
        // Mensagens direcionadas especificamente ao fornecedor
        let meuCnpj = '';
        try {
          const f = db.prepare('SELECT cnpj FROM fornecedor WHERE id = 1').get();
          meuCnpj = (f?.cnpj || '').replace(/\D/g, '');
        } catch(e) {}
        if (meuCnpj) {
          sql += ' AND identificadorDestinatario = ?';
          params.push(meuCnpj);
        }
      } else if (tipo === 'cnpj') {
        // Mensagens direcionadas ao fornecedor (por identificadorDestinatario ou temCnpjFornecedor)
        let meuCnpj = '';
        try {
          const f = db.prepare('SELECT cnpj FROM fornecedor WHERE id = 1').get();
          meuCnpj = (f?.cnpj || '').replace(/\D/g, '');
        } catch(e) {}
        if (meuCnpj) {
          sql += ' AND (temCnpjFornecedor = 1 OR identificadorDestinatario = ?)';
          params.push(meuCnpj);
        } else {
          sql += ' AND temCnpjFornecedor = 1';
        }
      }

      // Filtro por data
      if (data === 'hoje') {
        sql += " AND date(dataCaptura) = date('now')";
      } else if (data === '7dias') {
        sql += " AND date(dataCaptura) >= date('now', '-7 days')";
      } else if (data === '30dias') {
        sql += " AND date(dataCaptura) >= date('now', '-30 days')";
      }

      // Filtro por busca de texto
      if (busca && busca.trim()) {
        sql += ' AND (mensagem LIKE ? OR remetente LIKE ?)';
        const buscaTermo = `%${busca.trim()}%`;
        params.push(buscaTermo, buscaTermo);
      }

      sql += ' ORDER BY dataHoraMensagem DESC, id DESC LIMIT ?';
      params.push(parseInt(limit));

      const mensagens = db.prepare(sql).all(...params);
      res.json({ success: true, data: mensagens, total: mensagens.length });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Listar licitações distintas com mensagens (para filtro)
  app.get('/api/chat/mensagens/licitacoes', (req, res) => {
    try {
      const licitacoes = db.prepare(`
        SELECT
          cm.compraId,
          COUNT(*) as totalMensagens,
          MAX(cm.dataHoraMensagem) as ultimaMensagem,
          p.orgao as nomeOrgao,
          p.codigoUnidade as uasg,
          p.ano,
          p.sequencial,
          p.cnpj as cnpjOrgao
        FROM chat_mensagens cm
        LEFT JOIN participacoes_comprasnet p ON cm.compraId = p.compraId
        WHERE cm.compraId IS NOT NULL AND cm.compraId != ''
        GROUP BY cm.compraId
        ORDER BY ultimaMensagem DESC
      `).all();

      res.json({ success: true, data: licitacoes });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Listar órgãos distintos com mensagens
  app.get('/api/chat/mensagens/orgaos', (req, res) => {
    try {
      const orgaos = db.prepare(`
        SELECT
          p.orgao as nomeOrgao,
          p.cnpj as cnpjOrgao,
          p.codigoUnidade as uasg,
          COUNT(DISTINCT cm.compraId) as totalLicitacoes,
          COUNT(*) as totalMensagens
        FROM chat_mensagens cm
        INNER JOIN participacoes_comprasnet p ON cm.compraId = p.compraId
        WHERE cm.compraId IS NOT NULL AND cm.compraId != ''
        GROUP BY p.cnpj
        ORDER BY totalMensagens DESC
      `).all();

      res.json({ success: true, data: orgaos });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Estatísticas de mensagens
  // Marcar mensagem como lida
  app.post('/api/chat/mensagens/:id/lido', (req, res) => {
    try {
      const { id } = req.params;
      const agora = new Date().toISOString();

      db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE id = ?').run(agora, id);

      console.log(`[Chat] Mensagem ${id} marcada como lida`);
      res.json({ success: true, message: 'Mensagem marcada como lida' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Marcar todas mensagens de uma licitação como lidas
  app.post('/api/chat/mensagens/lidas', (req, res) => {
    try {
      const { cnpjOrgao, ano, sequencial } = req.body;
      const agora = new Date().toISOString();

      if (cnpjOrgao && ano && sequencial) {
        db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE cnpjOrgao = ? AND ano = ? AND sequencial = ? AND lido = 0')
          .run(agora, cnpjOrgao, parseInt(ano), parseInt(sequencial));
      } else {
        // Marca todas como lidas
        db.prepare('UPDATE chat_mensagens SET lido = 1, dataLeitura = ? WHERE lido = 0').run(agora);
      }

      res.json({ success: true, message: 'Mensagens marcadas como lidas' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Contar mensagens não lidas
  app.get('/api/chat/mensagens/nao-lidas', (req, res) => {
    try {
      const result = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE lido = 0').get();
      res.json({ success: true, total: result.total });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/chat/mensagens/stats', (req, res) => {
    try {
      const total = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens').get();
      const comCnpj = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE temCnpjFornecedor = 1').get();
      const comPalavras = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE palavrasChaveEncontradas IS NOT NULL').get();
      const notificadas = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE notificado = 1').get();
      const hoje = db.prepare(`SELECT COUNT(*) as total FROM chat_mensagens WHERE date(dataCaptura) = date('now')`).get();

      res.json({
        success: true,
        data: {
          total: total.total,
          comCnpjCitado: comCnpj.total,
          comPalavrasChave: comPalavras.total,
          notificadas: notificadas.total,
          capturadasHoje: hoje.total
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[ChatMensagens] Rotas registradas');
}

module.exports = { registrarRotasChatMensagens };
