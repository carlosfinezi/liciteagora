'use strict';

/**
 * profile-recovery.js — Wipe TOTAL do perfil + relaunch, rate-limited (v5.2.17).
 *
 * A limpeza PARCIAL (session.clearStorageData) NÃO zera o flag do hCaptcha — só o wipe
 * do diretório do perfil inteiro zera. Como não dá pra apagar o perfil em uso, escrevemos
 * o marcador `wipe-profile-on-start` (que o electron-browser.js consome no startup, antes
 * de abrir qualquer session, pra apagar Partitions/) e relançamos o app.
 *
 * Usado nos DOIS caminhos de travamento:
 *  - COLD BOOT: o auto-login desiste no hCaptcha (auto-login.js). É o único caminho que
 *    roda quando NUNCA houve Bearer (server-sync/keepalive não dispara sem token).
 *  - WARM: server-sync detecta SSO morto após perder a sessão (integration.js onSSODead).
 *
 * Rate-limit compartilhado (arquivo last-profile-wipe) evita loop de relaunch entre os
 * dois caminhos.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const RATE_LIMIT_MS = 900000; // 15 min

// Retorna { done, motivo }. done=false se dentro do rate-limit ou erro (caller segue vivo).
function wipeAndRelaunch(reason, log) {
  const _log = typeof log === 'function' ? log : () => {};
  try {
    const UDIR = app.getPath('userData');
    const lastWipeFile = path.join(UDIR, 'last-profile-wipe');
    let lastWipe = 0;
    try { lastWipe = parseInt(fs.readFileSync(lastWipeFile, 'utf8'), 10) || 0; } catch {}
    const now = Date.now();
    if (now - lastWipe < RATE_LIMIT_MS) {
      _log(`[Recuperação] Wipe de perfil recente (<15min) — aguardando (${reason}).`);
      return { done: false, motivo: 'rate-limited' };
    }
    try {
      fs.writeFileSync(path.join(UDIR, 'wipe-profile-on-start'), '1');
      fs.writeFileSync(lastWipeFile, String(now));
    } catch (e) { _log(`[Recuperação] falha ao marcar wipe: ${e.message}`); }
    _log(`[Recuperação] WIPE TOTAL do perfil + relaunch (${reason}).`);
    app.relaunch();
    app.exit(0);
    return { done: true, motivo: reason };
  } catch (e) {
    _log(`[Recuperação] wipeAndRelaunch erro: ${e.message}`);
    return { done: false, motivo: 'erro' };
  }
}

module.exports = { wipeAndRelaunch, RATE_LIMIT_MS };
