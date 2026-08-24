// chat-monitor-config.js
//
// Configuração INDIVIDUAL por portal do monitor de chat (Comprasnet, BLL, BNC,
// PCP). Cada portal tem: sua própria whitelist de palavras-chave e seu próprio
// bot/chat do Telegram. O Telegram GLOBAL (telegram_config) continua existindo
// para os demais alertas (OS, PCP-disputa, sniper, etc.) — isto aqui é só do
// monitor de chat.
//
// Tabelas:
//   chat_monitor_config  (portal PK, telegramBotToken, telegramChatId,
//                         telegramAtivo, notifTodas, atualizadoEm)
//   chat_monitor_palavras(id, portal, palavra, ativo)  UNIQUE(portal, palavra)
//
// Seed idempotente (ensureSchema): na 1ª vez, copia a config atual do Comprasnet
// — palavras-chave globais (chat_palavras_chave) + Telegram global
// (telegram_config) — para os 4 portais, como ponto de partida deste tenant.

'use strict';

const axios = require('axios');

const PORTAIS = ['comprasnet', 'bll', 'bnc', 'pcp'];

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_monitor_config (
      portal TEXT PRIMARY KEY,
      telegramBotToken TEXT,
      telegramChatId TEXT,
      telegramAtivo INTEGER NOT NULL DEFAULT 0,
      notifTodas INTEGER NOT NULL DEFAULT 0,   -- 1=notifica todas; 0=só palavra-chave
      atualizadoEm TEXT
    );
    CREATE TABLE IF NOT EXISTS chat_monitor_palavras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portal TEXT NOT NULL,
      palavra TEXT NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_monitor_palavra ON chat_monitor_palavras(portal, palavra);
    CREATE INDEX IF NOT EXISTS idx_chat_monitor_palavras_portal ON chat_monitor_palavras(portal);
  `);

  // Seed: só para portais ainda sem config (não sobrescreve ajustes do usuário).
  const globalTg = safeGet(db, 'SELECT botToken, chatId, ativo FROM telegram_config WHERE id = 1');
  const globalPalavras = safeAll(db, 'SELECT palavra FROM chat_palavras_chave WHERE ativo = 1')
    .map(r => String(r.palavra || '').toLowerCase().trim()).filter(p => p.length >= 2);

  const insCfg = db.prepare(`INSERT INTO chat_monitor_config
    (portal, telegramBotToken, telegramChatId, telegramAtivo, notifTodas, atualizadoEm)
    VALUES (?, ?, ?, ?, 0, ?)`);
  const insPal = db.prepare('INSERT OR IGNORE INTO chat_monitor_palavras (portal, palavra) VALUES (?, ?)');
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    for (const portal of PORTAIS) {
      const existe = db.prepare('SELECT portal FROM chat_monitor_config WHERE portal = ?').get(portal);
      if (!existe) {
        insCfg.run(portal, globalTg?.botToken || null, globalTg?.chatId || null, globalTg?.ativo ? 1 : 0, now);
        for (const p of globalPalavras) insPal.run(portal, p);
      }
    }
  });
  tx();
}

function safeGet(db, sql) { try { return db.prepare(sql).get(); } catch { return null; } }
function safeAll(db, sql) { try { return db.prepare(sql).all(); } catch { return []; } }

function getConfig(db, portal) {
  ensureRow(db, portal);
  return db.prepare('SELECT portal, telegramBotToken, telegramChatId, telegramAtivo, notifTodas, atualizadoEm FROM chat_monitor_config WHERE portal = ?').get(portal);
}

function ensureRow(db, portal) {
  const r = db.prepare('SELECT portal FROM chat_monitor_config WHERE portal = ?').get(portal);
  if (!r) db.prepare('INSERT INTO chat_monitor_config (portal, telegramAtivo, notifTodas, atualizadoEm) VALUES (?, 0, 0, ?)').run(portal, new Date().toISOString());
}

function setTelegram(db, portal, { botToken, chatId, ativo }) {
  ensureRow(db, portal);
  db.prepare(`UPDATE chat_monitor_config SET
    telegramBotToken = COALESCE(?, telegramBotToken),
    telegramChatId = COALESCE(?, telegramChatId),
    telegramAtivo = COALESCE(?, telegramAtivo),
    atualizadoEm = ? WHERE portal = ?`)
    .run(botToken ?? null, chatId ?? null, ativo == null ? null : (ativo ? 1 : 0), new Date().toISOString(), portal);
}

function setNotifTodas(db, portal, notifTodas) {
  ensureRow(db, portal);
  db.prepare('UPDATE chat_monitor_config SET notifTodas = ?, atualizadoEm = ? WHERE portal = ?')
    .run(notifTodas ? 1 : 0, new Date().toISOString(), portal);
}

function getPalavras(db, portal) {
  return db.prepare('SELECT id, palavra, ativo FROM chat_monitor_palavras WHERE portal = ? ORDER BY palavra').all(portal);
}
function addPalavra(db, portal, palavra) {
  const p = String(palavra || '').toLowerCase().trim();
  if (p.length < 2) throw new Error('palavra muito curta');
  db.prepare('INSERT OR IGNORE INTO chat_monitor_palavras (portal, palavra) VALUES (?, ?)').run(portal, p);
}
function delPalavra(db, portal, id) {
  db.prepare('DELETE FROM chat_monitor_palavras WHERE portal = ? AND id = ?').run(portal, Number(id));
}

// Decide se uma mensagem deve notificar. Retorna { notify, palavras }.
function shouldNotify(db, portal, texto) {
  const cfg = getConfig(db, portal);
  if (!cfg.telegramAtivo) return { notify: false, palavras: [] };
  if (cfg.notifTodas) return { notify: true, palavras: [] };
  const ativas = getPalavras(db, portal).filter(p => p.ativo).map(p => p.palavra);
  const t = String(texto || '').toLowerCase();
  const match = ativas.filter(p => t.includes(p));
  return { notify: match.length > 0, palavras: match };
}

// Envia HTML para o Telegram PRÓPRIO do portal. Retorna true/false. Nunca lança.
async function enviarTelegram(db, portal, htmlMensagem) {
  try {
    const cfg = getConfig(db, portal);
    if (!cfg.telegramAtivo || !cfg.telegramBotToken || !cfg.telegramChatId) return false;
    const url = `https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`;
    const resp = await axios.post(url, { chat_id: cfg.telegramChatId, text: htmlMensagem, parse_mode: 'HTML' });
    return !!resp.data.ok;
  } catch (e) {
    console.error(`[chat-monitor ${portal}] Telegram falhou:`, e.message);
    return false;
  }
}

module.exports = {
  PORTAIS,
  ensureSchema,
  getConfig, setTelegram, setNotifTodas,
  getPalavras, addPalavra, delPalavra,
  shouldNotify, enviarTelegram,
};
