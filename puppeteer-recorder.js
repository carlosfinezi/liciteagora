'use strict';

/**
 * puppeteer-recorder.js — Captura APIs do Comprasnet sem interferir no browser
 *
 * COMO FUNCIONA:
 *   1. Abre o Google Chrome real com --remote-debugging-port (NÃO via Puppeteer.launch)
 *   2. Conecta via CDP (puppeteer.connect) apenas para ESCUTAR requisições
 *   3. O Chrome roda 100% limpo — sem flags de automação, sem injection
 *   4. hCaptcha não detecta nada porque o Chrome é genuíno
 *
 * Uso:
 *   DISPLAY=:1 XAUTHORITY=/run/user/0/gdm/Xauthority node puppeteer-recorder.js [--url URL] [--name NOME]
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const puppeteer = require('puppeteer');

// ─── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'https://cnetmobile.estaleiro.serpro.gov.br';
const nameArg = args.includes('--name') ? args[args.indexOf('--name') + 1] : 'session';
const DEBUG_PORT = 9222;

const RECORDINGS_DIR = path.join(__dirname, 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
const baseFilename = `${nameArg}-${timestamp}`;

// Filtrar assets
const IGNORE_PATTERNS = [
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.css', '.woff', '.woff2', '.ttf', '.eot', '.map',
  'fonts.googleapis.com', 'fonts.gstatic.com',
  'google-analytics.com', 'googletagmanager.com',
  'gstatic.com/recaptcha', 'hcaptcha.com/1/',
];

function shouldCapture(url) {
  const lower = url.toLowerCase();
  return !IGNORE_PATTERNS.some(p => lower.includes(p));
}

// ─── State ───────────────────────────────────────────────────────────────────

const startTime = Date.now();
const apiCalls = [];
const pendingRequests = new Map();
let pageUrl = '';
let navigationCount = 0;

function ts() { return Date.now() - startTime; }

function log(msg) {
  const t = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// ─── Save ────────────────────────────────────────────────────────────────────

function save() {
  const result = {
    name: nameArg,
    startedAt: new Date(startTime).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: ts(),
    startUrl: urlArg,
    totalApiCalls: apiCalls.length,
    apiCalls,
  };

  const jsonFile = path.join(RECORDINGS_DIR, `${baseFilename}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(result, null, 2));
  log(`JSON salvo: ${jsonFile}`);

  const summaryFile = path.join(RECORDINGS_DIR, `${baseFilename}.txt`);
  const lines = [];
  lines.push(`═══ Captura de APIs — ${nameArg} ═══`);
  lines.push(`Início: ${result.startedAt}`);
  lines.push(`Duração: ${Math.floor(result.durationMs / 1000)}s`);
  lines.push(`Total de chamadas: ${apiCalls.length}`);
  lines.push('');

  let currentNav = '';
  for (const call of apiCalls) {
    if (call.pageUrl !== currentNav) {
      currentNav = call.pageUrl;
      lines.push(`\n──── Página: ${currentNav} ────`);
    }

    const arrow = (call.responseStatus || 0) >= 400 ? '✗' : '→';
    lines.push(`  ${arrow} ${call.method} ${call.url}`);
    lines.push(`    Status: ${call.responseStatus} | ${call.responseTimeMs}ms`);

    if (call.requestBody) {
      const body = typeof call.requestBody === 'string' ? call.requestBody : JSON.stringify(call.requestBody);
      lines.push(`    Request Body: ${body.length < 500 ? body : body.substring(0, 500) + '...'}`);
    }

    if (call.responseBody) {
      const body = typeof call.responseBody === 'string' ? call.responseBody : JSON.stringify(call.responseBody);
      lines.push(`    Response: ${body.length < 500 ? body : body.substring(0, 500) + '...'}`);
    }
    lines.push('');
  }

  lines.push('\n═══ Endpoints únicos ═══');
  const endpoints = new Map();
  for (const call of apiCalls) {
    try {
      const u = new URL(call.url);
      const key = `${call.method} ${u.pathname}`;
      if (!endpoints.has(key)) endpoints.set(key, { count: 0, statuses: new Set() });
      const ep = endpoints.get(key);
      ep.count++;
      ep.statuses.add(call.responseStatus);
    } catch (e) { /* */ }
  }
  for (const [ep, info] of [...endpoints.entries()].sort()) {
    lines.push(`  ${ep}  (${info.count}x) [${[...info.statuses].join(', ')}]`);
  }

  fs.writeFileSync(summaryFile, lines.join('\n'));
  log(`Resumo salvo: ${summaryFile}`);
  console.log(`\n✓ ${apiCalls.length} chamadas de API capturadas`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  API RECORDER — Chrome real + CDP listener          ║');
  console.log('║  O Chrome abre 100% limpo (sem automação).          ║');
  console.log('║  Navegue normalmente. APIs são capturadas via CDP.  ║');
  console.log('║  Feche o Chrome ou Ctrl+C para salvar.              ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`\nURL: ${urlArg}`);
  console.log(`Nome: ${nameArg}\n`);

  // 1. Matar Chrome anterior se houver
  try { execSync('pkill -f "chrome.*remote-debugging-port" 2>/dev/null'); } catch(e) {}
  await new Promise(r => setTimeout(r, 1000));

  // 2. Abrir Chrome real como processo separado (NÃO via Puppeteer)
  const userDataDir = path.join(__dirname, '.chrome-profile');
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  log('Abrindo Google Chrome...');
  const chromeProcess = spawn('/usr/bin/google-chrome-stable', [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox',
    '--lang=pt-BR',
    '--window-size=1366,768',
    urlArg,
  ], {
    detached: false,
    stdio: 'ignore',
    env: { ...process.env },
  });

  chromeProcess.on('error', (e) => {
    log(`Erro ao abrir Chrome: ${e.message}`);
    process.exit(1);
  });

  // 3. Aguardar Chrome ficar pronto na porta de debug
  log(`Aguardando Chrome na porta ${DEBUG_PORT}...`);
  let browser = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${DEBUG_PORT}`,
        defaultViewport: null,
      });
      break;
    } catch (e) {
      if (i === 29) {
        log('Timeout esperando Chrome. Abortando.');
        chromeProcess.kill();
        process.exit(1);
      }
    }
  }

  log('Conectado ao Chrome via CDP (modo escuta apenas)');

  // 4. Pegar a página ativa (aguardar se necessário)
  let pages = [];
  for (let i = 0; i < 10; i++) {
    pages = await browser.pages();
    if (pages.length > 0) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (pages.length === 0) {
    log('Nenhuma aba encontrada. Abortando.');
    chromeProcess.kill();
    process.exit(1);
  }
  let page = pages.find(p => {
    try { return p.url().includes('cnetmobile') || p.url().includes('serpro'); } catch(e) { return false; }
  }) || pages[0];
  try { pageUrl = page.url(); } catch(e) { pageUrl = urlArg; }

  // 5. CDP: escutar requisições em TODAS as páginas/abas
  async function attachCDP(target) {
    try {
      const cdp = await target.createCDPSession();
      await cdp.send('Network.enable', { maxPostDataSize: 65536 });

      cdp.on('Network.requestWillBeSent', (params) => {
        const { requestId, request } = params;
        if (!shouldCapture(request.url)) return;

        pendingRequests.set(requestId, {
          url: request.url,
          method: request.method,
          headers: request.headers,
          requestBody: request.postData || null,
          pageUrl: pageUrl,
          sentAt: ts(),
        });
      });

      cdp.on('Network.responseReceived', (params) => {
        const { requestId, response } = params;
        const req = pendingRequests.get(requestId);
        if (!req) return;
        req.responseStatus = response.status;
        req.responseHeaders = response.headers;
        req.responseMimeType = response.mimeType;
        req.responseTimeMs = ts() - req.sentAt;
      });

      cdp.on('Network.loadingFinished', async (params) => {
        const { requestId } = params;
        const req = pendingRequests.get(requestId);
        if (!req) return;
        pendingRequests.delete(requestId);

        try {
          const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId });
          if (!base64Encoded) {
            try { req.responseBody = JSON.parse(body); }
            catch (e) { req.responseBody = body.length > 2000 ? body.substring(0, 2000) + '...' : body; }
          } else {
            req.responseBody = '[binary]';
          }
        } catch (e) { req.responseBody = null; }

        if (req.requestBody) {
          try { req.requestBody = JSON.parse(req.requestBody); } catch (e) { /* string */ }
        }

        delete req.sentAt;
        apiCalls.push(req);

        const status = req.responseStatus || '?';
        const timeMs = req.responseTimeMs || 0;
        const urlShort = req.url.length > 80 ? req.url.substring(0, 80) + '...' : req.url;
        const icon = status >= 400 ? '✗' : '→';
        log(`${icon} ${req.method} ${status} ${urlShort} (${timeMs}ms)`);
      });

      cdp.on('Network.loadingFailed', (params) => {
        const req = pendingRequests.get(params.requestId);
        if (req) {
          req.responseStatus = 0;
          req.responseBody = params.errorText;
          req.responseTimeMs = ts() - req.sentAt;
          delete req.sentAt;
          apiCalls.push(req);
          pendingRequests.delete(params.requestId);
        }
      });

      return cdp;
    } catch (e) {
      // Pode falhar em páginas de sistema do Chrome
      return null;
    }
  }

  // Attach na página atual
  await attachCDP(page);

  // Attach em novas abas
  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      try {
        const newPage = await target.page();
        if (newPage) {
          await attachCDP(newPage);
          log(`CDP attached em nova aba: ${newPage.url()}`);
        }
      } catch (e) { /* ok */ }
    }
  });

  // Rastrear navegação
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      pageUrl = frame.url();
      navigationCount++;
      log(`\n══ Navegação #${navigationCount}: ${pageUrl} ══\n`);
    }
  });

  log('✓ Chrome aberto e gravando APIs. Navegue normalmente.\n');

  // ─── Cleanup ────────────────────────────────────────────────────────────

  let saved = false;
  function cleanup() {
    if (saved) return;
    saved = true;
    log('Parando gravação...');
    save();
    try { chromeProcess.kill(); } catch(e) {}
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  chromeProcess.on('exit', () => {
    log('Chrome fechou.');
    if (!saved) { save(); }
    process.exit(0);
  });

  browser.on('disconnected', () => {
    log('CDP desconectou.');
    if (!saved) { save(); }
    process.exit(0);
  });

  process.stdin.resume();
})().catch(e => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
