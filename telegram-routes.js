// telegram-routes.js
//
// Rotas HTTP de configuração do bot do Telegram (status, salvar config,
// testar, desativar). Extraído de server.js em NFSE-M06 onda 6.10.
//
// ESCOPO INTENCIONAL: só as 4 rotas HTTP. Os helpers `enviarTelegram` e
// `enviarNotificacaoTelegram` continuam em server.js porque têm ~18
// callers espalhados (sniper, monitor de chat, login flows, notificação
// de nova mensagem etc.) e movê-los exige rewiring amplo. A centralização
// dos helpers é escopo da onda 7 (helpers/config centralizados).
//
// O factory recebe `enviarTelegram` via DI porque 2 das 4 rotas (POST
// /api/telegram/config e POST /api/telegram/testar) precisam dele para
// enviar mensagem de confirmação/teste após configurar. Assim evitamos
// duplicar a lógica do wrapper dentro deste módulo.

const axios = require('axios');

function registrarRotasTelegram(app, db, { enviarTelegram }) {
  // Verificar status do Telegram
  app.get('/api/telegram/status', (req, res) => {
    try {
      const config = db.prepare('SELECT chatId, ativo FROM telegram_config WHERE id = 1').get();

      if (config && config.chatId) {
        res.json({
          success: true,
          configurado: true,
          ativo: config.ativo === 1
        });
      } else {
        res.json({
          success: true,
          configurado: false
        });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salvar configuração do Telegram
  app.post('/api/telegram/config', async (req, res) => {
    try {
      const { botToken, chatId: chatIdFromForm } = req.body;

      if (!botToken) {
        return res.status(400).json({ success: false, error: 'Token do bot é obrigatório' });
      }

      // Verificar se o token é válido e obter o chat_id
      const getMeUrl = `https://api.telegram.org/bot${botToken}/getMe`;
      const meResponse = await axios.get(getMeUrl);

      if (!meResponse.data.ok) {
        return res.status(400).json({ success: false, error: 'Token inválido' });
      }

      const botUsername = meResponse.data.result.username;

      // Usa chatId do formulário se fornecido, senão tenta auto-descobrir
      let chatId = chatIdFromForm || null;

      if (!chatId) {
        // Tentar obter updates para pegar o chat_id
        const updatesUrl = `https://api.telegram.org/bot${botToken}/getUpdates`;
        const updatesResponse = await axios.get(updatesUrl);

        if (updatesResponse.data.ok && updatesResponse.data.result.length > 0) {
          // Pegar o chat_id da última mensagem recebida
          const lastUpdate = updatesResponse.data.result[updatesResponse.data.result.length - 1];
          chatId = lastUpdate.message?.chat?.id || lastUpdate.channel_post?.chat?.id;
        }
      }

      if (!chatId) {
        return res.status(400).json({
          success: false,
          error: `Envie uma mensagem para o bot @${botUsername} no Telegram e tente novamente`
        });
      }

      // Salvar configuração
      const exists = db.prepare('SELECT id FROM telegram_config WHERE id = 1').get();
      if (exists) {
        db.prepare('UPDATE telegram_config SET botToken = ?, chatId = ?, ativo = 1, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = 1')
          .run(botToken, chatId.toString());
      } else {
        db.prepare('INSERT INTO telegram_config (id, botToken, chatId, ativo) VALUES (1, ?, ?, 1)')
          .run(botToken, chatId.toString());
      }

      // Enviar mensagem de confirmação
      await enviarTelegram('✅ <b>PNCP Monitor conectado!</b>\n\nVocê receberá alertas do chat do Comprasnet aqui.');

      res.json({
        success: true,
        message: 'Telegram configurado com sucesso',
        botUsername
      });

    } catch (error) {
      console.error('Erro ao configurar Telegram:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Testar envio de mensagem
  app.post('/api/telegram/testar', async (req, res) => {
    try {
      const enviado = await enviarTelegram('🔔 <b>Teste de alerta</b>\n\nSe você recebeu esta mensagem, os alertas estão funcionando!');

      if (enviado) {
        res.json({ success: true, message: 'Mensagem de teste enviada' });
      } else {
        res.status(400).json({ success: false, error: 'Falha ao enviar. Verifique a configuração.' });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Desativar Telegram
  app.delete('/api/telegram/config', (req, res) => {
    try {
      db.prepare('UPDATE telegram_config SET ativo = 0 WHERE id = 1').run();
      res.json({ success: true, message: 'Alertas desativados' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Telegram] Rotas registradas');
}

module.exports = { registrarRotasTelegram };
