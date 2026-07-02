'use strict';

/**
 * portals/comprasnet/utils.js — Helpers human-like + waits usados pelo
 * fluxo de auto-login Comprasnet (gov.br SSO).
 *
 * Extraído de electron-browser.js (linhas ~920-1019, 947-974). Funções
 * puras — não tocam state global. Recebem o webContents como parâmetro.
 *
 * IMPORTANTE: humanType e humanClick injetam JS no webview via
 * executeJavaScript. O HTML/JS injetado interpola variáveis (selector,
 * text, char) com aspas simples. Mantive interpolação como estava no
 * original — caracteres com `'` no input ainda quebrariam, mas isso é
 * aceitável pra CPF/senha numérica.
 */

const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function humanDelay(minMs = 800, maxMs = 2000) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

async function waitForURL(wv, pattern, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = wv.getURL();
    if (url.includes(pattern)) return url;
    await sleep(500);
  }
  throw new Error(`Timeout esperando URL com "${pattern}" (atual: ${wv.getURL()})`);
}

async function waitForSelector(wv, selector, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await wv.executeJavaScript(`!!document.querySelector('${selector}')`).catch(() => false);
    if (found) return true;
    await sleep(300);
  }
  throw new Error(`Timeout esperando selector "${selector}"`);
}

// Digita texto caractere a caractere com delays aleatórios (simula humano)
async function humanType(wv, selector, text) {
  await wv.executeJavaScript(`
    (function() {
      const input = document.querySelector('${selector}');
      if (!input) throw new Error('Campo não encontrado: ${selector}');
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      return true;
    })()
  `);

  for (const char of text) {
    await wv.executeJavaScript(`
      (function() {
        const input = document.querySelector('${selector}');
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, input.value + '${char}');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: '${char}', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: '${char}', bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: '${char}', bubbles: true }));
      })()
    `);
    await sleep(50 + Math.random() * 100); // 50-150ms por tecla
  }

  await wv.executeJavaScript(`
    (function() {
      const input = document.querySelector('${selector}');
      if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
}

// Simula mouse move para coords do elemento antes de clicar
async function humanClick(wv, selector) {
  await wv.executeJavaScript(`
    (function() {
      const el = document.querySelector('${selector}');
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
      const y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
      el.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseover', { clientX: x, clientY: y, bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
      el.click();
      return true;
    })()
  `);
}

// Warmup de perfil novo: visita Google → Gov.br → Comprasnet pra popular
// cookies/histórico antes do primeiro login. hCaptcha é menos agressivo
// com perfis "vivenciados".
async function warmupProfile(wv, userDataDir, log) {
  const profileDefault = path.join(userDataDir, 'Default');
  const isNewProfile = !fs.existsSync(profileDefault);
  if (!isNewProfile) {
    log('Perfil existente — skip warmup');
    return;
  }

  log('Perfil novo detectado — warmup de navegação...');
  const sites = [
    { url: 'https://www.google.com.br', name: 'Google', wait: 2000 },
    { url: 'https://www.gov.br', name: 'Gov.br', wait: 2000 },
    { url: 'https://www.comprasnet.gov.br', name: 'Comprasnet', wait: 2000 },
  ];

  for (const site of sites) {
    try {
      log(`  Warmup: ${site.name}...`);
      wv.loadURL(site.url);
      await sleep(site.wait);
    } catch (e) {
      log(`  Warmup ${site.name} erro: ${e.message}`);
    }
  }
  log('Warmup concluído');
}

module.exports = {
  sleep,
  humanDelay,
  waitForURL,
  waitForSelector,
  humanType,
  humanClick,
  warmupProfile,
};
