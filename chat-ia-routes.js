// chat-ia-routes.js (2026-05-22)
//
// Endpoints HTTP do chat-IA (copiloto do sistema). NÃO confundir com
// chat-mensagens-routes.js (chat com pregoeiros via Comprasnet).
//
// Rotas:
//   POST   /api/chat-ia/mensagem        - envia pergunta; cria sessão se necessário
//   GET    /api/chat-ia/sessoes         - lista sessões do tenant
//   GET    /api/chat-ia/sessao/:id      - mensagens de uma sessão
//   DELETE /api/chat-ia/sessao/:id      - apaga sessão e suas mensagens

'use strict';

const chatIa = require('./chat-ia');

function registrarRotasChatIa(app, db, { getIAKeys }) {
  // Garante schema ao registrar
  try { chatIa.inicializarSchema(db); } catch (e) { /* multi-tenant: ok */ }

  app.post('/api/chat-ia/mensagem', async (req, res) => {
    try {
      // Garante schema no contexto do tenant (multi-tenant requer init lazy)
      chatIa.inicializarSchema(req.tenantDb || db);
      const tdb = req.tenantDb || db;
      const { sessaoId, mensagem, contextoTipo, contextoId } = req.body || {};
      if (!mensagem || !String(mensagem).trim()) {
        return res.status(400).json({ success: false, error: 'mensagem obrigatória' });
      }
      const keys = getIAKeys();
      if (!keys) return res.status(400).json({ success: false, error: 'Nenhuma chave de IA configurada' });

      // 1) Resolve sessão (cria nova se sessaoId vazio)
      let sId = Number(sessaoId) || null;
      if (!sId) {
        const titulo = String(mensagem).substring(0, 80);
        const r = tdb.prepare(`INSERT INTO chat_ia_sessoes (titulo, contextoTipo, contextoId)
                               VALUES (?, ?, ?)`).run(titulo, contextoTipo || null, contextoId ? String(contextoId) : null);
        sId = r.lastInsertRowid;
      } else {
        // Atualiza contexto se mudou (nova página)
        if (contextoTipo) {
          tdb.prepare(`UPDATE chat_ia_sessoes SET contextoTipo = ?, contextoId = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(contextoTipo, contextoId ? String(contextoId) : null, sId);
        }
      }

      // 2) Salva mensagem do usuário
      tdb.prepare(`INSERT INTO chat_ia_mensagens (sessaoId, papel, conteudo) VALUES (?, 'user', ?)`)
        .run(sId, String(mensagem));

      // 3) Carrega histórico (últimas 20 mensagens — chat-history sliding window)
      const historico = tdb.prepare(`SELECT papel AS role, conteudo AS content
                                       FROM chat_ia_mensagens
                                      WHERE sessaoId = ?
                                      ORDER BY id DESC LIMIT 20`).all(sId).reverse();

      // 4) Monta system prompt com contexto + perfil
      const produtos = chatIa.getProdutosQueVendo(tdb);
      const ctxTxt = await chatIa.carregarContexto(tdb, contextoTipo, contextoId);
      const systemPrompt = chatIa.montarSystemPrompt(req.tenantCtx?.slug || null, produtos, ctxTxt);

      const messages = [
        { role: 'system', content: systemPrompt },
        ...historico.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      ];

      // 5) Chama LLM (chain de fallback)
      const { provider, content } = await chatIa.chamarChatLLM(messages, keys);

      // 6) Salva resposta
      tdb.prepare(`INSERT INTO chat_ia_mensagens (sessaoId, papel, conteudo, provider)
                   VALUES (?, 'assistant', ?, ?)`).run(sId, content, provider);
      tdb.prepare(`UPDATE chat_ia_sessoes SET dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(sId);

      res.json({ success: true, sessaoId: sId, resposta: content, provider });
    } catch (e) {
      console.error('[chat-ia] erro:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/chat-ia/sessoes', (req, res) => {
    try {
      chatIa.inicializarSchema(req.tenantDb || db);
      const tdb = req.tenantDb || db;
      const sessoes = tdb.prepare(`
        SELECT s.id, s.titulo, s.contextoTipo, s.contextoId, s.dataCriacao, s.dataAtualizacao,
               (SELECT COUNT(*) FROM chat_ia_mensagens m WHERE m.sessaoId = s.id) AS qtdMensagens
          FROM chat_ia_sessoes s
         ORDER BY s.dataAtualizacao DESC LIMIT 50
      `).all();
      res.json({ success: true, sessoes });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/chat-ia/sessao/:id', (req, res) => {
    try {
      chatIa.inicializarSchema(req.tenantDb || db);
      const tdb = req.tenantDb || db;
      const sId = Number(req.params.id);
      const sessao = tdb.prepare(`SELECT * FROM chat_ia_sessoes WHERE id = ?`).get(sId);
      if (!sessao) return res.status(404).json({ success: false, error: 'Sessão não encontrada' });
      const mensagens = tdb.prepare(`SELECT id, papel, conteudo, provider, dataCriacao
                                       FROM chat_ia_mensagens
                                      WHERE sessaoId = ? ORDER BY id ASC`).all(sId);
      res.json({ success: true, sessao, mensagens });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/api/chat-ia/sessao/:id', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const sId = Number(req.params.id);
      tdb.prepare(`DELETE FROM chat_ia_mensagens WHERE sessaoId = ?`).run(sId);
      tdb.prepare(`DELETE FROM chat_ia_sessoes WHERE id = ?`).run(sId);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('[ChatIA] Rotas registradas');
}

module.exports = { registrarRotasChatIa };
