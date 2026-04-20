// telegram-client.js
//
// Helper puro de envio de mensagem via Telegram Bot API.
// Extraído de server.js em NFSE-M06 onda 5C para permitir que o master
// (scheduler.js, sem stack Express) envie alertas sem precisar require
// server.js. Callers em server.js continuam usando o wrapper local
// enviarTelegram(msg), que delega para cá — zero mudança de assinatura
// nos ~20 call-sites existentes.
//
// NFSE-M06 onda 6.30 (2026-04-20): sendNotificacao foi migrado para cá
// também. Era o antigo enviarNotificacaoTelegram de server.js — envio
// formatado HTML de notificação de chat de licitação (órgão, objeto,
// remetente, palavras-chave, alerta CNPJ etc.). Consumidor externo é
// extensao-chrome-routes.js, que recebe a função via opts a partir
// de server.js. server.js agora mantém só um wrapper fino.

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

/**
 * Envia uma notificação formatada de chat de licitação via Telegram.
 *
 * Aceita tanto uma string simples (encaminhada via sendTelegram) quanto
 * um objeto com os campos enriquecidos:
 *   cnpjOrgao, nomeOrgao, sequencial, ano, objetoLicitacao,
 *   remetente, mensagem, dataHoraMensagem, temCnpjFornecedor, palavrasChave
 *
 * Lê as credenciais de telegram_config (id=1, ativo=1) e envia com
 * parse_mode=HTML. Retorna true se enviado, false em qualquer falha.
 * Nunca lança.
 */
async function sendNotificacao(db, dados) {
  try {
    const config = db.prepare('SELECT botToken, chatId FROM telegram_config WHERE id = 1 AND ativo = 1').get();
    if (!config || !config.botToken || !config.chatId) {
      console.log('[Telegram] Não configurado ou desativado');
      return false;
    }

    // Se recebeu uma string simples, envia como está
    if (typeof dados === 'string') {
      return await sendTelegram(db, dados);
    }

    // Formata a mensagem com todos os dados
    const {
      cnpjOrgao,
      nomeOrgao,
      sequencial,
      ano,
      objetoLicitacao,
      remetente,
      mensagem,
      dataHoraMensagem,
      temCnpjFornecedor,
      palavrasChave
    } = dados;

    // Formata data
    let dataFormatada = 'N/A';
    if (dataHoraMensagem) {
      try {
        const data = new Date(dataHoraMensagem);
        dataFormatada = data.toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      } catch (e) {
        dataFormatada = dataHoraMensagem;
      }
    }

    // Monta a mensagem formatada
    let textoMensagem = `📨 <b>NOVA MENSAGEM NO CHAT</b>\n`;
    textoMensagem += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Dados do órgão
    textoMensagem += `🏛️ <b>ÓRGÃO:</b>\n`;
    textoMensagem += `${nomeOrgao || 'Não identificado'}\n`;
    if (cnpjOrgao) {
      textoMensagem += `UASG/CNPJ: ${cnpjOrgao}\n`;
    }
    textoMensagem += `\n`;

    // Dados da licitação
    textoMensagem += `📋 <b>LICITAÇÃO:</b>\n`;
    textoMensagem += `Nº ${sequencial}/${ano}\n`;
    if (objetoLicitacao) {
      const objetoResumido = objetoLicitacao.length > 150
        ? objetoLicitacao.substring(0, 150) + '...'
        : objetoLicitacao;
      textoMensagem += `<i>${objetoResumido}</i>\n`;
    }
    textoMensagem += `\n`;

    // Data e remetente
    textoMensagem += `📅 <b>Data:</b> ${dataFormatada}\n`;
    textoMensagem += `👤 <b>De:</b> ${remetente || 'Sistema'}\n\n`;

    // Mensagem
    textoMensagem += `💬 <b>MENSAGEM:</b>\n`;
    textoMensagem += `━━━━━━━━━━━━━━━━━━━━\n`;
    const mensagemResumida = mensagem.length > 500
      ? mensagem.substring(0, 500) + '...'
      : mensagem;
    textoMensagem += `${mensagemResumida}\n`;
    textoMensagem += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Alertas especiais
    if (temCnpjFornecedor) {
      textoMensagem += `⚠️ <b>ATENÇÃO: Menciona seu CNPJ!</b>\n`;
    }
    if (palavrasChave && palavrasChave.length > 0) {
      textoMensagem += `🔔 <b>Palavras-chave:</b> ${palavrasChave.join(', ')}\n`;
    }

    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const response = await axios.post(url, {
      chat_id: config.chatId,
      text: textoMensagem,
      parse_mode: 'HTML'
    });

    if (response.data.ok) {
      console.log(`[Telegram] Notificação enviada: Licitação ${sequencial}/${ano}`);
    }

    return response.data.ok;
  } catch (error) {
    console.error('[Telegram] Erro ao enviar notificação:', error.message);
    return false;
  }
}

module.exports = { sendTelegram, sendNotificacao };
