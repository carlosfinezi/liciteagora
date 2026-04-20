// chat-leitura-routes.js
//
// Rotas de leitura de mensagens do chat (marcar como lida / contar não
// lidas). Extraído de server.js em NFSE-M06 onda 6.19.
//
// Escopo: 3 rotas sobre a tabela chat_mensagens, todas relativas a
// status de leitura (campo `lido` 0/1 + timestamp `dataLeitura`):
//
//   GET  /api/chat/nao-lidas            COUNT(*) WHERE lido=0 OR NULL
//                                        Usado pelo frontend v1 para
//                                        mostrar badge de pendentes.
//   POST /api/chat/marcar-lida          UPDATE SET lido=1, dataLeitura=now
//                                        WHERE id=?. Body: {id}.
//   POST /api/chat/marcar-todas-lidas   UPDATE bulk. Com {cnpjOrgao,ano,
//                                        sequencial} filtra por licitação;
//                                        sem filtro marca TODAS as não
//                                        lidas do sistema.
//
// OBS: existem rotas quase idênticas em /api/chat/mensagens/* (banner
// "ROTAS DE MENSAGENS CAPTURADAS") usadas pelo monitoramento-chat v2.
// Aquelas ficam em outro módulo (onda posterior) e operam sobre a
// mesma tabela chat_mensagens — ambas coexistem intencionalmente
// (paths diferentes, comportamento 1:1 equivalente).
//
// ORDEM NO EXPRESS 5: o comentário original "Definidas no início para
// funcionar corretamente com Express 5" refere-se ao posicionamento
// dessas rotas logo após `app.use(express.static)` — necessário para
// não serem mascaradas por matching de arquivo estático. Como o
// factory é chamado no cluster principal de registrarRotas* (linha
// ~1933 do server.js atual, depois do static), o posicionamento
// relativo é preservado.
//
// DEPENDÊNCIAS: apenas `db` (better-sqlite3). Sem helpers externos.

function registrarRotasChatLeitura(app, db) {
  // Contar mensagens não lidas
  app.get('/api/chat/nao-lidas', (req, res) => {
    try {
      const result = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens WHERE lido = 0 OR lido IS NULL').get();
      res.json({ success: true, total: result ? result.total : 0 });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Marcar mensagem específica como lida
  app.post('/api/chat/marcar-lida', (req, res) => {
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
  app.post('/api/chat/marcar-todas-lidas', (req, res) => {
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

  console.log('[ChatLeitura] Rotas registradas');
}

module.exports = { registrarRotasChatLeitura };
