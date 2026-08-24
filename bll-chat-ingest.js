// bll-chat-ingest.js
//
// Captura/persistência/notificação do chat das salas BLL (bllcompras.com).
// Delega a lógica genérica a portal-chat-ingest (compartilhada com o BNC —
// mesma plataforma batchScreenHub). Notificação individual do portal 'bll'
// via chat-monitor-config (palavras-chave + Telegram próprios).
//
// Protocolo detalhado + parsers: ver portal-chat-ingest.js.

'use strict';

const { bllFetch } = require('./bll-client');
const { makeIngest, parseScopes, parseProcessMessages, parseBatchMessages, decodeEntidades } = require('./portal-chat-ingest');

const capturarChat = makeIngest({
  portal: 'bll',
  fetchFn: (db, url, opts) => bllFetch(db, url, opts),
  tabela: 'bll_chat_mensagens',
  label: 'BLL',
});

module.exports = { capturarChat, parseScopes, parseProcessMessages, parseBatchMessages, decodeEntidades };
