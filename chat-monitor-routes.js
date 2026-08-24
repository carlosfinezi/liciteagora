// chat-monitor-routes.js — config INDIVIDUAL por portal do monitor de chat.
//
//   GET    /api/chat-monitor/:portal/config            → {telegram, notifTodas, palavras}
//   POST   /api/chat-monitor/:portal/telegram          body { botToken?, chatId?, ativo? }
//   POST   /api/chat-monitor/:portal/notif-todas       body { notifTodas: bool }
//   GET    /api/chat-monitor/:portal/palavras          → [{id, palavra, ativo}]
//   POST   /api/chat-monitor/:portal/palavras          body { palavra }
//   DELETE /api/chat-monitor/:portal/palavras/:id
//   POST   /api/chat-monitor/:portal/telegram/testar   envia mensagem de teste

'use strict';

const cm = require('./chat-monitor-config');
const axios = require('axios');

function registrarRotasChatMonitor(app, db) {
  const tdb = (req) => req.tenantDb || db;
  const portalOk = (p) => cm.PORTAIS.includes(p);

  app.get('/api/chat-monitor/:portal/config', (req, res) => {
    try {
      const portal = req.params.portal;
      if (!portalOk(portal)) return res.status(400).json({ success: false, error: 'portal inválido' });
      const c = cm.getConfig(tdb(req), portal);
      res.json({
        success: true,
        telegram: { botToken: c.telegramBotToken ? '••••' + String(c.telegramBotToken).slice(-4) : '', chatId: c.telegramChatId || '', ativo: !!c.telegramAtivo, configurado: !!(c.telegramBotToken && c.telegramChatId) },
        notifTodas: !!c.notifTodas,
        palavras: cm.getPalavras(tdb(req), portal),
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/chat-monitor/:portal/telegram', (req, res) => {
    try {
      const portal = req.params.portal;
      if (!portalOk(portal)) return res.status(400).json({ success: false, error: 'portal inválido' });
      const { botToken, chatId, ativo } = req.body || {};
      // token mascarado (••••) não sobrescreve o salvo
      const tokenReal = botToken && !/^•+/.test(botToken) ? botToken : null;
      cm.setTelegram(tdb(req), portal, { botToken: tokenReal, chatId: chatId ?? null, ativo });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/chat-monitor/:portal/notif-todas', (req, res) => {
    try {
      const portal = req.params.portal;
      if (!portalOk(portal)) return res.status(400).json({ success: false, error: 'portal inválido' });
      cm.setNotifTodas(tdb(req), portal, !!(req.body && req.body.notifTodas));
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/chat-monitor/:portal/palavras', (req, res) => {
    try {
      const portal = req.params.portal;
      if (!portalOk(portal)) return res.status(400).json({ success: false, error: 'portal inválido' });
      res.json({ success: true, palavras: cm.getPalavras(tdb(req), portal) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/chat-monitor/:portal/palavras', (req, res) => {
    try {
      const portal = req.params.portal;
      if (!portalOk(portal)) return res.status(400).json({ success: false, error: 'portal inválido' });
      const palavra = (req.body && req.body.palavra || '').trim();
      if (!palavra) return res.status(400).json({ success: false, error: 'palavra obrigatória' });
      cm.addPalavra(tdb(req), portal, palavra);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.delete('/api/chat-monitor/:portal/palavras/:id', (req, res) => {
    try {
      const portal = req.params.portal;
      if (!portalOk(portal)) return res.status(400).json({ success: false, error: 'portal inválido' });
      cm.delPalavra(tdb(req), portal, req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/chat-monitor/:portal/telegram/testar', async (req, res) => {
    try {
      const portal = req.params.portal;
      if (!portalOk(portal)) return res.status(400).json({ success: false, error: 'portal inválido' });
      const c = cm.getConfig(tdb(req), portal);
      if (!c.telegramBotToken || !c.telegramChatId) return res.status(400).json({ success: false, error: 'Telegram não configurado' });
      const url = `https://api.telegram.org/bot${c.telegramBotToken}/sendMessage`;
      const r = await axios.post(url, { chat_id: c.telegramChatId, text: `✅ Teste do Monitor <b>${portal.toUpperCase()}</b> — Telegram funcionando.`, parse_mode: 'HTML' });
      res.json({ success: !!r.data.ok });
    } catch (e) { res.status(400).json({ success: false, error: e.response?.data?.description || e.message }); }
  });

  console.log('[Chat-Monitor] Rotas de config por portal registradas');
}

module.exports = { registrarRotasChatMonitor };
