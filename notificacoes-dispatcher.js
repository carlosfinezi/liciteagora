// notificacoes-dispatcher.js (2026-05-21)
//
// Despacha notificações pros canais habilitados do tenant — fonte única
// de verdade para Telegram + Email.
//
// 2026-08-02: passou a ser fonte única DE FATO. Antes o arquivo dizia isso e
// não era: sniper-lance-routes.js e alertas-disputa-vigilancia.js tinham
// cópias idênticas de lerCanais/enviarAlerta, e outros nove pontos do sistema
// (OS, PCP, preventivas, BNC, propostas, habilitação, sync PNCP) chamavam
// sendTelegram direto, sem consultar canal nenhum. As cópias foram removidas
// e o interruptor do Telegram passou a ser verificado no transporte
// (telegram-client.canalTelegramLigado), onde nenhum emissor escapa.
//
// Consumidores diretos: alertas de disputa (sniper-lance-routes), vigia de
// disputa (alertas-disputa-vigilancia), descoberta IA (analise-ia-scheduler),
// teste de canais (notificacoes-routes).
//
// Config (tabela `config`):
//   alerta_canal_telegram   '1' | '0'   (default '1')
//   alerta_canal_email      '1' | '0'   (default '0')
//   alerta_email_destinatarios  string  (CSV/semicolon)
//
// Configurada em /configuracoes/notificacoes.html. O mesmo HTML (mesmo
// HTML body) é mandado pros dois canais — Telegram aceita um subset de HTML,
// o email envelopa em template.
//
// Erros num canal não bloqueiam o outro (cada um loga e segue).

'use strict';

const { sendTelegram } = require('./telegram-client');
const { enviarEmailAlerta } = require('./email-client');

function lerCanais(db) {
  const get = (chave) => {
    try {
      const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
      return row ? row.valor : null;
    } catch (_) { return null; }
  };
  const telegram = get('alerta_canal_telegram');
  const email = get('alerta_canal_email');
  const destinatariosRaw = get('alerta_email_destinatarios') || '';
  return {
    telegram: telegram == null ? true : telegram === '1',  // default ON
    email: email === '1',
    destinatarios: destinatariosRaw.split(/[,;]/).map(s => s.trim()).filter(Boolean),
  };
}

/**
 * Despacha pros canais habilitados. No-op silencioso se nenhum canal ativo.
 *
 * @param {Database} db - tenant DB
 * @param {object} opts
 * @param {string} opts.subject - assunto (usado no email)
 * @param {string} opts.body - HTML/text (subset HTML aceito pelo Telegram)
 * @param {string} [opts.logTag] - tag pra console.error (ex: 'AnaliseIA', 'ALERTA')
 */
async function enviarAlerta(db, { subject, body, logTag = 'NOTIF' } = {}) {
  const cfg = lerCanais(db);
  const tarefas = [];
  if (cfg.telegram) {
    tarefas.push(
      sendTelegram(db, body).catch(e => console.error(`[${logTag}] telegram falhou: ${e.message}`))
    );
  }
  if (cfg.email && cfg.destinatarios.length > 0) {
    tarefas.push(
      enviarEmailAlerta(db, { subject: subject || 'Notificação LiciteAgora', htmlBody: body, to: cfg.destinatarios })
        .catch(e => console.error(`[${logTag}] email falhou: ${e.message}`))
    );
  }
  if (tarefas.length === 0) return { skipped: true, motivo: 'nenhum canal ativo ou sem destinatários' };
  await Promise.all(tarefas);
  return { ok: true, canais: tarefas.length };
}

module.exports = { lerCanais, enviarAlerta };
