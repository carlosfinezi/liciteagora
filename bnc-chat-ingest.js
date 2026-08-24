// bnc-chat-ingest.js
//
// Captura/persistência/notificação do chat das salas BNC (bnccompras.com).
// Mesma plataforma do BLL (batchScreenHub) — delega a portal-chat-ingest.
// Notificação individual do portal 'bnc' via chat-monitor-config.
//
// (Existe também bnc-mensagens.js, acoplado ao fluxo de disputa e inerte; este
// módulo usa a via GetMsgCountDetailedView — só precisa do processId estável.)

'use strict';

const { bncFetch } = require('./bnc-client');
const { makeIngest } = require('./portal-chat-ingest');

const capturarChat = makeIngest({
  portal: 'bnc',
  fetchFn: (db, url, opts) => bncFetch(db, url, opts),
  tabela: 'bnc_chat_mensagens',
  label: 'BNC',
});

module.exports = { capturarChat };
