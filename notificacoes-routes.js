// notificacoes-routes.js (2026-08-02)
//
// Rotas de /configuracoes/notificacoes.html — quais canais o tenant usa para
// receber alertas, e para quem vai o email.
//
// POR QUE ESTE ARQUIVO EXISTE: as três rotas viviam dentro de
// sniper-lance-routes.js. A tela fica em Configurações e o interruptor agora
// vale para o sistema inteiro (OS, PCP, preventivas, sync, disputa,
// descoberta por IA), então hospedá-las no robô de lances dizia a coisa
// errada sobre o escopo — e escondia a configuração de quem fosse procurá-la.
//
// A leitura e o despacho ficam em notificacoes-dispatcher.js, que é a fonte
// única de verdade. Aqui só há HTTP.

'use strict';

const { lerCanais, enviarAlerta } = require('./notificacoes-dispatcher');

function registrarRotasNotificacoes(app, db) {
  // GET → estado atual dos canais (telegram on/off, email on/off, destinatários)
  app.get('/api/alertas/config', (req, res) => {
    try {
      res.json({ success: true, config: lerCanais(db) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST { telegram: bool, email: bool, destinatarios: string|string[] }
  app.post('/api/alertas/config', (req, res) => {
    try {
      const b = req.body || {};
      const upsert = db.prepare('INSERT OR REPLACE INTO config (chave, valor) VALUES (?, ?)');
      if (b.telegram !== undefined) upsert.run('alerta_canal_telegram', b.telegram ? '1' : '0');
      if (b.email !== undefined) upsert.run('alerta_canal_email', b.email ? '1' : '0');
      if (b.destinatarios !== undefined) {
        const lista = Array.isArray(b.destinatarios)
          ? b.destinatarios
          : String(b.destinatarios || '').split(/[,;]/);
        // Descartar em silêncio o que não é email deixava o usuário achar que
        // salvou; devolvemos os ignorados para a tela poder dizer.
        const limpos = [];
        const ignorados = [];
        for (const bruto of lista) {
          const t = String(bruto).trim();
          if (!t) continue;
          if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) limpos.push(t);
          else ignorados.push(t);
        }
        upsert.run('alerta_email_destinatarios', limpos.join(', '));
        return res.json({ success: true, config: lerCanais(db), ignorados });
      }
      res.json({ success: true, config: lerCanais(db), ignorados: [] });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST → exercita os canais configurados.
  app.post('/api/alertas/teste', async (req, res) => {
    try {
      const ts = new Date().toLocaleString('pt-BR');
      const r = await enviarAlerta(db, {
        subject: '[LiciteAgora] ✅ Teste de notificação',
        body: '✅ <b>Teste de notificação</b>\n'
            + `Hora: <i>${ts}</i>\n\n`
            + '<i>Se você recebeu isso, seus canais de alerta estão funcionando.</i>',
        logTag: 'TesteAlerta',
      });
      // Um teste que devolve success sem ter enviado nada é pior que um erro:
      // o usuário conclui que está tudo certo e o alerta real nunca chega.
      if (r && r.skipped) {
        return res.json({ success: false, error: `Nada foi enviado — ${r.motivo}.` });
      }
      res.json({ success: true, canais: (r && r.canais) || 0 });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('[Notificações] Rotas registradas');
}

module.exports = { registrarRotasNotificacoes };
