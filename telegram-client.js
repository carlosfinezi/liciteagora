// telegram-client.js
//
// Helper puro de envio de mensagem via Telegram Bot API.
// Extraído de server.js em NFSE-M06 onda 5C para permitir que o master
// (scheduler.js, sem stack Express) envie alertas sem precisar require
// server.js. Callers em server.js continuam usando o wrapper local
// enviarTelegram(msg), que delega para cá — zero mudança de assinatura
// nos ~20 call-sites existentes.

const axios = require('axios');

/**
 * Envia uma mensagem de texto HTML via Telegram Bot API usando as
 * credenciais gravadas em telegram_config (id=1, ativo=1).
 * Retorna true se a API retornou ok, false em qualquer falha (config
 * ausente, erro de rede, resposta não-ok). Nunca lança.
 */
async function sendTelegram(db, mensagem) {
  try {
    const config = db.prepare('SELECT botToken, chatId FROM telegram_config WHERE id = 1 AND ativo = 1').get();
    if (!config || !config.botToken || !config.chatId) return false;

    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const response = await axios.post(url, {
      chat_id: config.chatId,
      text: mensagem,
      parse_mode: 'HTML'
    });

    return response.data.ok;
  } catch (error) {
    console.error('Erro ao enviar Telegram:', error.message);
    return false;
  }
}

module.exports = { sendTelegram };
