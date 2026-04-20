// chat-monitoramento-routes.js
//
// Rotas administrativas do fluxo de monitoramento de chat/mensagens
// do Comprasnet (painel web + extensão Chrome). Extraído de server.js
// em NFSE-M06 onda 6.23.
//
// Agrupa 3 subseções do monolito que eram banners distintos mas compõem
// a mesma camada de configuração/estado do monitoramento:
//
// A) PALAVRAS-CHAVE DE ALERTA (3 rotas em /api/chat/palavras-chave)
//    CRUD da whitelist de palavras que, quando aparecem em mensagens
//    capturadas, disparam o flag "importante" no envio Telegram.
//    Tabela: chat_palavras_chave (palavra, ativo).
//      GET    /api/chat/palavras-chave       lista ordenada.
//      POST   /api/chat/palavras-chave       insert OR IGNORE (lower,
//                                             min 2 chars).
//      DELETE /api/chat/palavras-chave/:id
//
// B) SESSÃO DE MONITORAMENTO (EXTENSÃO) (7 rotas)
//    Estado da sessão ativa + progresso de captura + marcação de
//    leitura manual ("rota que funciona" — paths diferentes do
//    chat-leitura-routes.js que usa /api/chat/marcar-lida).
//      GET    /api/chat/monitoramento/sessao     1 ativa (ativo=1).
//      POST   /api/chat/monitoramento/sessao     desativa anteriores
//                                                 e insere nova.
//      DELETE /api/chat/monitoramento/sessao     UPDATE ativo=0.
//      GET    /api/chat/captura/verificar/:compraId
//                                                 consulta capturaCompleta.
//      GET    /api/chat/captura/completas         lista compraIds com
//                                                 capturaCompleta=1.
//      POST   /api/chat/leitura/marcar            UPDATE lido=1 por id.
//      POST   /api/chat/leitura/marcar-todas      UPDATE lido=1 por
//                                                 (cnpjOrgao,ano,seq) ou
//                                                 TUDO se sem filtro.
//
//    Tabelas: monitoramento_sessao, chat_captura_progresso, chat_mensagens.
//
// C) LICITAÇÕES A MONITORAR (5 rotas em /api/chat/licitacoes-monitorar)
//    Lista declarativa do que a extensão deve varrer. A rota POST /url
//    faz parsing heurístico do parâmetro compra= do Comprasnet (formato
//    23 dígitos = CNPJ14+SEQ5+ANO4, com fallback para formato antigo).
//    Tabela: licitacoes_monitorar.
//      GET    /api/chat/licitacoes-monitorar       lista.
//      POST   /api/chat/licitacoes-monitorar       insert OR REPLACE
//                                                   (ativo=1).
//      POST   /api/chat/licitacoes-monitorar/url   parsing de URL.
//      DELETE /api/chat/licitacoes-monitorar/:id
//      PATCH  /api/chat/licitacoes-monitorar/:id   toggle ativo.
//
// DEPENDÊNCIAS do factory: apenas `db` (better-sqlite3). Nenhuma opt
// externa — é 100% CRUD sobre tabelas locais.

function registrarRotasChatMonitoramento(app, db) {
  // ==================== PALAVRAS-CHAVE DE ALERTA ====================

  // Listar palavras-chave
  app.get('/api/chat/palavras-chave', (req, res) => {
    try {
      const palavras = db.prepare('SELECT * FROM chat_palavras_chave ORDER BY palavra').all();
      res.json({ success: true, data: palavras });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Adicionar palavra-chave
  app.post('/api/chat/palavras-chave', (req, res) => {
    try {
      const { palavra } = req.body;
      if (!palavra || palavra.trim().length < 2) {
        return res.status(400).json({ success: false, error: 'Palavra deve ter pelo menos 2 caracteres' });
      }
      db.prepare('INSERT OR IGNORE INTO chat_palavras_chave (palavra) VALUES (?)').run(palavra.trim().toLowerCase());
      res.json({ success: true, message: 'Palavra-chave adicionada' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Remover palavra-chave
  app.delete('/api/chat/palavras-chave/:id', (req, res) => {
    try {
      const { id } = req.params;
      db.prepare('DELETE FROM chat_palavras_chave WHERE id = ?').run(id);
      res.json({ success: true, message: 'Palavra-chave removida' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== SESSÃO DE MONITORAMENTO (EXTENSÃO) ====================

  // Obter sessão de monitoramento ativa
  app.get('/api/chat/monitoramento/sessao', (req, res) => {
    try {
      const sessao = db.prepare('SELECT * FROM monitoramento_sessao WHERE ativo = 1 ORDER BY dataAtualizacao DESC LIMIT 1').get();
      if (sessao) {
        sessao.licitacoesProcessadas = JSON.parse(sessao.licitacoesProcessadas || '[]');
      }
      res.json({ success: true, data: sessao || null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salvar progresso da sessão de monitoramento
  app.post('/api/chat/monitoramento/sessao', (req, res) => {
    try {
      const { statusAtual, paginaAtual, indiceLicitacao, totalLicitacoes, licitacoesProcessadas } = req.body;

      // Desativa sessões anteriores
      db.prepare('UPDATE monitoramento_sessao SET ativo = 0').run();

      // Insere nova sessão
      db.prepare(`
        INSERT INTO monitoramento_sessao (statusAtual, paginaAtual, indiceLicitacao, totalLicitacoes, licitacoesProcessadas, ativo, dataAtualizacao)
        VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      `).run(
        statusAtual || 'Em andamento',
        paginaAtual || 1,
        indiceLicitacao || 0,
        totalLicitacoes || 0,
        JSON.stringify(licitacoesProcessadas || [])
      );

      console.log('[Sessão] Progresso salvo: ' + statusAtual + ', lic ' + indiceLicitacao + '/' + totalLicitacoes);
      res.json({ success: true, message: 'Sessão salva' });
    } catch (error) {
      console.error('[Sessão] Erro ao salvar:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Limpar sessão de monitoramento
  app.delete('/api/chat/monitoramento/sessao', (req, res) => {
    try {
      db.prepare('UPDATE monitoramento_sessao SET ativo = 0').run();
      console.log('[Sessão] Sessão encerrada');
      res.json({ success: true, message: 'Sessão encerrada' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Verificar se licitação já foi capturada completamente
  app.get('/api/chat/captura/verificar/:compraId', (req, res) => {
    try {
      const { compraId } = req.params;
      const progresso = db.prepare('SELECT capturaCompleta, totalMensagensCapturadas FROM chat_captura_progresso WHERE compraId = ?').get(compraId);

      if (progresso && progresso.capturaCompleta) {
        res.json({ success: true, capturada: true, totalMensagens: progresso.totalMensagensCapturadas });
      } else {
        res.json({ success: true, capturada: false });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Listar licitações já capturadas (para pular)
  app.get('/api/chat/captura/completas', (req, res) => {
    try {
      const completas = db.prepare('SELECT compraId FROM chat_captura_progresso WHERE capturaCompleta = 1').all();
      res.json({ success: true, data: completas.map(c => c.compraId) });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Marcar mensagem como lida (rota que funciona)
  app.post('/api/chat/leitura/marcar', (req, res) => {
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
  app.post('/api/chat/leitura/marcar-todas', (req, res) => {
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

  // ==================== ROTAS DE LICITAÇÕES A MONITORAR ====================

  // Listar licitações a monitorar
  app.get('/api/chat/licitacoes-monitorar', (req, res) => {
    try {
      const licitacoes = db.prepare('SELECT * FROM licitacoes_monitorar ORDER BY dataCriacao DESC').all();
      res.json({ success: true, data: licitacoes });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Adicionar licitação para monitorar
  app.post('/api/chat/licitacoes-monitorar', (req, res) => {
    try {
      const { cnpjOrgao, ano, sequencial, descricao, urlCompra } = req.body;

      if (!cnpjOrgao || !ano || !sequencial) {
        return res.status(400).json({ success: false, error: 'CNPJ, ano e sequencial são obrigatórios' });
      }

      db.prepare(`
        INSERT OR REPLACE INTO licitacoes_monitorar (cnpjOrgao, ano, sequencial, descricao, urlCompra, ativo)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(cnpjOrgao, ano, sequencial, descricao || '', urlCompra || '');

      res.json({ success: true, message: 'Licitação adicionada para monitoramento' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Adicionar licitação a partir de URL do Comprasnet
  app.post('/api/chat/licitacoes-monitorar/url', (req, res) => {
    try {
      const { url, descricao } = req.body;

      if (!url) {
        return res.status(400).json({ success: false, error: 'URL é obrigatória' });
      }

      // Tentar extrair dados da URL
      // Formato padrão: compra=CNPJ(14)+SEQUENCIAL(5)+ANO(4) = 23 dígitos
      // Formato antigo: compra=UASG+NUMERO = menos dígitos
      let cnpjOrgao, sequencial, ano;

      // Tentar formato completo (23 dígitos)
      let match = url.match(/compra=(\d{14})(\d{5})(\d{4})/);
      if (match) {
        cnpjOrgao = match[1];
        sequencial = parseInt(match[2], 10);
        ano = parseInt(match[3], 10);
      } else {
        // Tentar formato alternativo - extrair qualquer código numérico
        match = url.match(/compra=(\d+)/);
        if (!match) {
          return res.status(400).json({ success: false, error: 'URL inválida. Não foi possível extrair o código da compra.' });
        }
        const codigo = match[1];
        // Usar o código como identificador único
        cnpjOrgao = codigo.substring(0, Math.max(8, codigo.length - 7)); // Primeiros dígitos como "CNPJ/UASG"
        const resto = codigo.substring(cnpjOrgao.length);
        sequencial = resto.length >= 6 ? parseInt(resto.substring(0, resto.length - 4), 10) : parseInt(resto.substring(0, 2) || '1', 10);
        ano = resto.length >= 4 ? parseInt(resto.substring(resto.length - 4), 10) : new Date().getFullYear();
      }

      db.prepare(`
        INSERT OR REPLACE INTO licitacoes_monitorar (cnpjOrgao, ano, sequencial, descricao, urlCompra, ativo)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(cnpjOrgao, ano, sequencial, descricao || '', url);

      res.json({
        success: true,
        message: 'Licitação adicionada para monitoramento',
        data: { cnpjOrgao, ano, sequencial }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Remover licitação do monitoramento
  app.delete('/api/chat/licitacoes-monitorar/:id', (req, res) => {
    try {
      const { id } = req.params;
      db.prepare('DELETE FROM licitacoes_monitorar WHERE id = ?').run(id);
      res.json({ success: true, message: 'Licitação removida do monitoramento' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Ativar/desativar licitação
  app.patch('/api/chat/licitacoes-monitorar/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { ativo } = req.body;
      db.prepare('UPDATE licitacoes_monitorar SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, id);
      res.json({ success: true, message: 'Status atualizado' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[ChatMonitoramento] Rotas registradas');
}

module.exports = { registrarRotasChatMonitoramento };
