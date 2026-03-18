/**
 * webview-preload.js — Preload script para BrowserWindow do Electron
 *
 * Com contextIsolation: false, este script roda no MESMO mundo que a página.
 * Executa ANTES de qualquer script da página, incluindo hCaptcha.
 */
'use strict';

const fs = require('fs');
const path = require('path');

try {
  const stealthCode = fs.readFileSync(path.join(__dirname, 'stealth-preload.js'), 'utf8');
  // Executar diretamente no escopo global (mesmo mundo da página)
  const script = new Function(stealthCode);
  script();
} catch (e) {
  // Silently fail — backup injection via dom-ready
}
