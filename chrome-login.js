'use strict';

/**
 * chrome-login.js — Login Comprasnet via Chrome real + CDP
 *
 * COMO FUNCIONA:
 *   1. Spawna Google Chrome real como processo separado (NÃO via Puppeteer.launch)
 *   2. Conecta via CDP (puppeteer.connect) apenas para escutar e executar JS
 *   3. Chrome roda 100% limpo — ZERO markers de automação
 *   4. hCaptcha invisible passa porque fingerprint é genuíno
 *   5. Bearer capturado via Network.requestWillBeSent (CDP)
 *
 * Uso:
 *   DISPLAY=:1 node chrome-login.js
 *
 * API HTTP (porta 9600):
 *   GET  /status   — estado da sessão
 *   GET  /bearer   — token atual
 *   POST /login    — { cpf, senha } inicia login automático
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');
const puppeteer = require('puppeteer');
const { saveBearer, isTokenValid, tokenTTL, loadToken, clearToken, parseJWT } = require('./token-manager');

// ─── Config ──────────────────────────────────────────────────────────────────

const CDP_PORT = 9222;
const API_PORT = 9600;
const API_BASE = 'https://cnetmobile.estaleiro.serpro.gov.br';
const TOKEN_MAX_AGE_MS = 540000; // 9 min
const KEEPALIVE_INTERVAL_MS = 60000; // 60s
const LOGIN_URL = 'https://comprasnet.gov.br/seguro/loginPortal.asp';

const USER_DATA_DIR = path.join(__dirname, '.chrome-profile');
if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });

// ─── State ───────────────────────────────────────────────────────────────────

let chromeProcess = null;
let browser = null;
let page = null;
let cdpSession = null;
let bearerToken = null;
let bearerTimestamp = null;
let keepaliveTimer = null;
let keepaliveCount = 0;
let state = 'idle'; // idle | starting | connected | logging_in | logged_in | error
let loginAt = null;
const startTime = Date.now();

function log(msg) {
  const t = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

function tokenFresco() {
  return bearerToken && bearerTimestamp && (Date.now() - bearerTimestamp) < TOKEN_MAX_AGE_MS;
}

// ─── Chrome spawn + CDP connect ──────────────────────────────────────────────

async function startChrome() {
  state = 'starting';

  // Matar Chrome anterior se houver
  try { execSync('pkill -f "chrome.*remote-debugging-port" 2>/dev/null'); } catch (e) {}
  await sleep(1000);

  log('Abrindo Google Chrome real...');
  chromeProcess = spawn('/usr/bin/google-chrome-stable', [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-sandbox',
    '--lang=pt-BR',
    '--window-size=1366,768',
    '--disable-blink-features=AutomationControlled',
    '--ignore-certificate-errors',
    LOGIN_URL,
  ], {
    detached: false,
    stdio: 'ignore',
    env: { ...process.env },
  });

  chromeProcess.on('error', (e) => {
    log(`Erro ao abrir Chrome: ${e.message}`);
    state = 'error';
  });

  chromeProcess.on('exit', (code) => {
    log(`Chrome encerrou (code: ${code})`);
    browser = null;
    page = null;
    cdpSession = null;
    state = 'idle';
  });

  // Aguardar Chrome ficar pronto
  log(`Aguardando Chrome na porta ${CDP_PORT}...`);
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${CDP_PORT}`,
        defaultViewport: null,
      });
      break;
    } catch (e) {
      if (i === 29) {
        log('Timeout esperando Chrome. Abortando.');
        state = 'error';
        return false;
      }
    }
  }

  log('Conectado ao Chrome via CDP');

  // Pegar a página ativa
  let pages = [];
  for (let i = 0; i < 10; i++) {
    pages = await browser.pages();
    if (pages.length > 0) break;
    await sleep(500);
  }
  if (pages.length === 0) {
    log('Nenhuma aba encontrada.');
    state = 'error';
    return false;
  }
  page = pages[0];

  // Attach CDP para capturar Bearer via Network
  cdpSession = await page.createCDPSession();
  await cdpSession.send('Network.enable', { maxPostDataSize: 65536 });

  cdpSession.on('Network.requestWillBeSent', (params) => {
    const { request } = params;
    const auth = request.headers['Authorization'] || request.headers['authorization'];
    if (auth && auth.startsWith('Bearer ') && request.url.includes('cnetmobile.estaleiro.serpro.gov.br')) {
      const agora = Date.now();
      if (auth !== bearerToken || !bearerTimestamp || (agora - bearerTimestamp) > 30000) {
        bearerToken = auth;
        bearerTimestamp = agora;

        const tokenData = saveBearer(auth);
        const claims = parseJWT(auth);
        const ttl = tokenTTL(tokenData);
        log(`Bearer capturado: ${auth.substring(0, 40)}... (TTL: ${ttl}s, sub: ${claims?.sub || '?'})`);

        if (state === 'connected' || state === 'logging_in') {
          state = 'logged_in';
          loginAt = new Date().toISOString();
          log('Estado → logged_in');
          startKeepalive();
        }
      }
    }
  });

  // Rastrear navegação
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      log(`Navegação: ${frame.url()}`);
    }
  });

  // Attach CDP em novas abas
  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      try {
        const newPage = await target.page();
        if (newPage) {
          const newCdp = await newPage.createCDPSession();
          await newCdp.send('Network.enable', { maxPostDataSize: 65536 });
          newCdp.on('Network.requestWillBeSent', (params) => {
            const { request } = params;
            const auth = request.headers['Authorization'] || request.headers['authorization'];
            if (auth && auth.startsWith('Bearer ') && request.url.includes('cnetmobile.estaleiro.serpro.gov.br')) {
              const agora = Date.now();
              if (auth !== bearerToken || !bearerTimestamp || (agora - bearerTimestamp) > 30000) {
                bearerToken = auth;
                bearerTimestamp = agora;
                const tokenData = saveBearer(auth);
                const ttl = tokenTTL(tokenData);
                log(`Bearer capturado (nova aba): ${auth.substring(0, 40)}... (TTL: ${ttl}s)`);
                if (state === 'connected' || state === 'logging_in') {
                  state = 'logged_in';
                  loginAt = new Date().toISOString();
                  startKeepalive();
                }
              }
            }
          });
          log(`CDP attached em nova aba: ${newPage.url()}`);
        }
      } catch (e) { /* ok */ }
    }
  });

  browser.on('disconnected', () => {
    log('CDP desconectou.');
    browser = null;
    page = null;
    cdpSession = null;
    state = 'idle';
  });

  // Verificar sessão salva em disco
  const savedToken = loadToken();
  if (savedToken && isTokenValid(savedToken)) {
    const ttl = tokenTTL(savedToken);
    log(`Sessão anterior encontrada! TTL: ${ttl}s`);
    bearerToken = savedToken.token;
    bearerTimestamp = savedToken.issuedAt;
    state = 'logged_in';
    loginAt = new Date(savedToken.issuedAt).toISOString();
    startKeepalive();
  } else {
    if (savedToken) {
      log('Sessão anterior expirada.');
      clearToken();
    }
    state = 'connected';
  }

  log('Chrome pronto!');
  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function evaluate(js) {
  if (!page) throw new Error('Página não disponível');
  return page.evaluate(js);
}

async function waitForURL(pattern, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    if (url.includes(pattern)) return url;
    await sleep(500);
  }
  throw new Error(`Timeout esperando URL com "${pattern}" (atual: ${page.url()})`);
}

async function waitForSelector(selector, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await page.evaluate((sel) => !!document.querySelector(sel), selector).catch(() => false);
    if (found) return true;
    await sleep(300);
  }
  throw new Error(`Timeout esperando selector "${selector}"`);
}

// ─── Login Automático ─────────────────────────────────────────────────────────

async function autoLogin(cpf, senha) {
  if (!page) throw new Error('Chrome não está rodando');
  state = 'logging_in';
  log('═══ LOGIN AUTOMÁTICO ═══');
  log(`CPF: ${cpf.substring(0, 3)}...`);

  try {
    // 1. Navegar ao loginPortal.asp
    log('Passo 1: Navegando ao loginPortal.asp...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);

    // Verificar se já está logado
    const currentUrl = page.url();
    if (currentUrl.includes('cnetmobile') && !currentUrl.includes('acesso-nao-autorizado')) {
      log('Já está logado! (sessão anterior válida)');
      state = 'logged_in';
      loginAt = new Date().toISOString();
      startKeepalive();
      return { success: true, message: 'Sessão anterior válida' };
    }

    // 2. Expandir card "Fornecedor" e clicar em "Entrar com Gov.br"
    log('Passo 2: Expandindo card Fornecedor...');
    await sleep(2000);

    await page.evaluate(() => {
      if (typeof mudaPerfilBotao === 'function') {
        mudaPerfilBotao(1);
        return 'mudaPerfilBotao(1)';
      }
      const btn = document.querySelector('button.fornecedor, button.expand.fornecedor');
      if (btn) { btn.click(); return 'button.fornecedor'; }
      return null;
    }).catch(() => null);
    log('Card Fornecedor expandido');
    await sleep(2000);

    log('Clicando em Entrar com Gov.br...');
    const clicked = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
      const govBtn = els.find(el => {
        const text = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return (text.includes('entrar') && text.includes('gov')) || text === 'entrar';
      });
      if (govBtn) {
        govBtn.click();
        return (govBtn.textContent || govBtn.value || '').trim().substring(0, 80);
      }
      const ssoLink = document.querySelector('a[href*="acesso.gov.br"], a[href*="loginPortalFornecedor"]');
      if (ssoLink) {
        ssoLink.click();
        return 'href: ' + ssoLink.href.substring(0, 80);
      }
      const card = document.querySelector('.fornecedor-card, .card.fornecedor, [class*="fornecedor"]');
      if (card) {
        const btn = card.querySelector('a, button');
        if (btn) { btn.click(); return 'card btn: ' + (btn.textContent || btn.href || '').substring(0, 80); }
      }
      return null;
    }).catch(() => null);

    if (clicked) {
      log('Clicou em: ' + clicked);
    } else {
      log('Botão Entrar não encontrado — erro');
      state = 'error';
      return { success: false, message: 'Botão Entrar com Gov.br não encontrado' };
    }

    // 3. Aguardar SSO gov.br
    log('Passo 3: Aguardando SSO gov.br...');
    await waitForURL('acesso.gov.br', 30000);
    log('Página SSO carregada: ' + page.url());
    await sleep(4000); // Esperar hCaptcha, TSPD, etc

    // 4. Preencher CPF
    log('Passo 4: Preenchendo CPF...');
    await waitForSelector('input[name="accountId"], input#accountId, input[type="text"]', 15000);

    await page.evaluate((cpfVal) => {
      const input = document.querySelector('input[name="accountId"]')
        || document.querySelector('input#accountId')
        || document.querySelector('input[inputmode="numeric"]')
        || document.querySelector('input[type="text"]');
      if (!input) throw new Error('Campo CPF não encontrado');
      input.focus();
      input.value = '';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, cpfVal);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, cpf);
    log('CPF preenchido');
    await sleep(1500);

    // 5. Clicar Continuar
    log('Passo 5: Clicando Continuar...');
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]')
        || document.querySelector('input[type="submit"]')
        || document.querySelector('.btn-primary')
        || Array.from(document.querySelectorAll('button')).find(b => {
          const t = (b.textContent || '').toLowerCase();
          return t.includes('continuar') || t.includes('avançar') || t.includes('entrar');
        });
      if (!btn) throw new Error('Botão Continuar não encontrado');
      btn.click();
    });
    log('Continuar clicado');

    // 6. Aguardar tela de senha
    log('Passo 6: Aguardando campo de senha...');
    let senhaEncontrada = false;
    for (let i = 0; i < 40; i++) {
      const pageState = await page.evaluate(() => ({
        temSenha: !!document.querySelector('input[type="password"]'),
        url: window.location.href,
        erro: (document.querySelector('.msg-erro, .alert-danger, [class*="error"], [class*="erro"]') || {}).textContent || null,
      })).catch(() => ({ temSenha: false }));

      if (pageState.temSenha) {
        senhaEncontrada = true;
        log('Campo de senha encontrado!');
        break;
      }

      // Já redirecionou ao Comprasnet (sessão SSO válida)
      if (pageState.url && pageState.url.includes('cnetmobile') && !pageState.url.includes('acesso-nao-autorizado')) {
        log('Redirecionou direto ao Comprasnet (SSO válido)!');
        state = 'logged_in';
        loginAt = new Date().toISOString();
        startKeepalive();
        return { success: true, message: 'SSO válido, login automático' };
      }

      if (pageState.erro && i % 5 === 0) {
        log(`Info página: ${(pageState.erro || '').substring(0, 100)}`);
      }

      await sleep(1000);
    }

    if (!senhaEncontrada) {
      const url = page.url();
      log(`Campo de senha não apareceu após 40s. URL: ${url}`);
      state = 'connected';
      return { success: false, message: 'Campo de senha não apareceu', url };
    }

    // 7. Preencher senha
    log('Passo 7: Preenchendo senha...');
    await page.evaluate((senhaVal) => {
      const input = document.querySelector('input[type="password"]');
      if (!input) throw new Error('Campo senha não encontrado');
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, senhaVal);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, senha);
    log('Senha preenchida');
    await sleep(800);

    // 8. Clicar Entrar
    log('Passo 8: Clicando Entrar...');
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]')
        || document.querySelector('input[type="submit"]')
        || Array.from(document.querySelectorAll('button')).find(b => {
          const t = (b.textContent || '').toLowerCase();
          return t.includes('entrar') || t.includes('acessar') || t.includes('login');
        });
      if (!btn) throw new Error('Botão Entrar não encontrado');
      btn.click();
    });
    log('Entrar clicado');

    // 9. Aguardar redirecionamento ao Comprasnet
    log('Passo 9: Aguardando redirecionamento ao Comprasnet...');
    try {
      await waitForURL('cnetmobile', 60000);
      log('Redirecionado ao Comprasnet!');
    } catch (e) {
      const url = page.url();
      log(`Timeout no redirecionamento. URL: ${url}`);
      state = 'connected';
      return { success: false, message: 'Timeout no redirecionamento', url };
    }

    // 10. Aguardar Bearer ser capturado
    log('Passo 10: Aguardando captura do Bearer...');
    for (let i = 0; i < 20; i++) {
      if (bearerToken && state === 'logged_in') {
        log('══ LOGIN CONCLUÍDO COM SUCESSO! ══');
        return { success: true, message: 'Login OK', bearerAge: 0 };
      }
      await sleep(500);
    }

    // Bearer não capturado — forçar uma chamada API
    log('Bearer não capturado automaticamente — forçando chamada...');
    await page.evaluate(() => {
      fetch('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-disputa/v1/datahorabrasilia', {
        credentials: 'include',
      }).catch(() => {});
    });
    await sleep(3000);

    if (bearerToken) {
      state = 'logged_in';
      loginAt = new Date().toISOString();
      log('══ LOGIN CONCLUÍDO COM SUCESSO! (Bearer capturado via força) ══');
      startKeepalive();
      return { success: true, message: 'Login OK (forçado)' };
    }

    state = 'connected';
    log('Login aparenta OK mas Bearer não capturado');
    return { success: false, message: 'Bearer não capturado' };

  } catch (e) {
    log(`Erro no login automático: ${e.message}`);
    state = 'error';
    return { success: false, message: e.message };
  }
}

// ─── Keepalive ───────────────────────────────────────────────────────────────

function startKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveCount = 0;
  keepaliveTimer = setInterval(keepaliveStep, KEEPALIVE_INTERVAL_MS);
  log(`Keepalive ativo (cada ${KEEPALIVE_INTERVAL_MS / 1000}s)`);
}

async function keepaliveStep() {
  if (!page || state !== 'logged_in') return;
  keepaliveCount++;

  try {
    // Keepalive via fetch no contexto da página (mesmos cookies/IP)
    const result = await page.evaluate((bearer) => {
      return fetch('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-disputa/v1/datahorabrasilia', {
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'x-device-platform': 'web',
          'x-version-number': '6.0.0',
          'Authorization': bearer || '',
        },
      }).then(r => r.text().then(t => ({ ok: r.ok, status: r.status, body: t.substring(0, 50) })))
        .catch(e => ({ ok: false, status: 0, error: e.message }));
    }, bearerToken).catch(e => ({ ok: false, status: 0, error: e.message }));

    if (result.ok) {
      if (keepaliveCount % 5 === 0) {
        const saved = loadToken();
        const ttl = saved ? tokenTTL(saved) : 0;
        log(`Keepalive #${keepaliveCount} OK — TTL: ${ttl}s — ${result.body || ''}`);
      }
    } else if (result.status === 401 || result.status === 403) {
      log(`Keepalive: sessão expirada (${result.status}) — tentando retoken...`);
      // Tentar retoken
      const retokenResult = await page.evaluate((bearer) => {
        return fetch('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-disputa/v1/retoken', {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'x-device-platform': 'web',
            'x-version-number': '6.0.0',
            'Authorization': bearer || '',
          },
        }).then(r => ({ ok: r.ok, status: r.status }))
          .catch(e => ({ ok: false, status: 0, error: e.message }));
      }, bearerToken).catch(e => ({ ok: false, status: 0, error: e.message }));

      if (retokenResult.ok) {
        log('Retoken OK');
        // Forçar uma chamada para capturar novo token via CDP
        await sleep(500);
        await page.evaluate((bearer) => {
          fetch('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-disputa/v1/datahorabrasilia', {
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'x-device-platform': 'web', 'x-version-number': '6.0.0', 'Authorization': bearer || '' },
          }).catch(() => {});
        }, bearerToken).catch(() => {});
      } else {
        log('Retoken falhou. Sessão perdida.');
        state = 'connected';
      }
    } else {
      log(`Keepalive: status ${result.status} — ${result.error || ''}`);
    }

    // Keepalive legado (main.asp) a cada 2 ciclos
    if (keepaliveCount % 2 === 0) {
      await page.evaluate(() => {
        fetch('https://www.comprasnet.gov.br/main.asp?login=keepalive', {
          credentials: 'include', mode: 'no-cors',
        }).catch(() => {});
      }).catch(() => {});
    }

  } catch (e) {
    log(`Keepalive erro: ${e.message}`);
  }
}

// ─── API Server ──────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const apiServer = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  try {
    // GET /status
    if (url.pathname === '/status') {
      const saved = loadToken();
      const ttl = saved ? tokenTTL(saved) : 0;
      res.writeHead(200);
      res.end(JSON.stringify({
        state,
        bearerFresh: tokenFresco(),
        bearerAge: bearerTimestamp ? Math.floor((Date.now() - bearerTimestamp) / 1000) : null,
        bearerToken: bearerToken ? bearerToken.substring(0, 40) + '...' : null,
        tokenTTL: ttl,
        tokenSavedToDisk: !!saved,
        loginAt,
        keepaliveCount,
        url: page ? page.url() : null,
        chromeRunning: !!chromeProcess,
        browserConnected: !!browser,
      }));
      return;
    }

    // GET /bearer
    if (url.pathname === '/bearer') {
      res.writeHead(200);
      res.end(JSON.stringify({
        bearer: bearerToken,
        fresh: tokenFresco(),
        age: bearerTimestamp ? Math.floor((Date.now() - bearerTimestamp) / 1000) : null,
      }));
      return;
    }

    // POST /login  { cpf, senha }
    if (url.pathname === '/login' && req.method === 'POST') {
      const body = await readBody(req);
      const { cpf, senha } = JSON.parse(body);
      if (!cpf || !senha) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'cpf e senha obrigatórios' }));
        return;
      }
      // Responder imediatamente, login em background
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: 'Login iniciado...' }));
      autoLogin(cpf, senha).catch(e => log(`Login erro: ${e.message}`));
      return;
    }

    // POST /fetch  { path, method, body }
    if (url.pathname === '/fetch' && req.method === 'POST') {
      const body = await readBody(req);
      const { path: apiPath, method, body: reqBody } = JSON.parse(body);
      if (!page) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Chrome não disponível' }));
        return;
      }
      const result = await page.evaluate((apiBase, apiPath, method, reqBody, bearer) => {
        const headers = {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'x-device-platform': 'web',
          'x-version-number': '6.0.0',
        };
        if (bearer) headers['Authorization'] = bearer;
        const opts = { method: method || 'GET', credentials: 'include', headers };
        if (reqBody) opts.body = JSON.stringify(reqBody);
        return fetch(apiBase + apiPath, opts)
          .then(r => {
            const ct = r.headers.get('content-type') || '';
            return (ct.includes('json') ? r.json() : r.text())
              .then(data => ({ ok: r.ok, status: r.status, data }));
          })
          .catch(e => ({ ok: false, status: 0, error: e.message }));
      }, API_BASE, apiPath, method || 'GET', reqBody || null, bearerToken);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // POST /navigate  { url }
    if (url.pathname === '/navigate' && req.method === 'POST') {
      const body = await readBody(req);
      const { url: navUrl } = JSON.parse(body);
      if (!page) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Chrome não disponível' }));
        return;
      }
      await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, url: page.url() }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  CHROME LOGIN — Chrome real + CDP (sem automação)   ║');
  console.log('║  hCaptcha invisible passa (fingerprint limpo).      ║');
  console.log('║  Bearer capturado via CDP Network.                  ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  // Iniciar API server primeiro
  apiServer.listen(API_PORT, '127.0.0.1', () => {
    log(`API local em http://127.0.0.1:${API_PORT}`);
    log('  GET  /status   — estado da sessão');
    log('  GET  /bearer   — token atual');
    log('  POST /login    — { cpf, senha }');
    log('  POST /fetch    — { path, method, body }');
    log('  POST /navigate — { url }');
  });

  // Iniciar Chrome
  const ok = await startChrome();
  if (!ok) {
    log('Falha ao iniciar Chrome. API continua ativa para retry.');
  }

  // Auto-login do banco se disponível
  if (state === 'connected') {
    try {
      const { execSync } = require('child_process');
      const dbPath = path.join(__dirname, 'pncp.db');
      if (fs.existsSync(dbPath)) {
        const cpf = execSync(`sqlite3 "${dbPath}" "SELECT valor FROM config WHERE chave='govbr_cpf'"`, { encoding: 'utf8' }).trim();
        const senha = execSync(`sqlite3 "${dbPath}" "SELECT valor FROM config WHERE chave='govbr_senha'"`, { encoding: 'utf8' }).trim();
        if (cpf && senha) {
          log('Credenciais encontradas no banco — iniciando login automático...');
          await sleep(3000);
          await autoLogin(cpf, senha);
        }
      }
    } catch (e) {
      log(`Erro ao ler credenciais do banco: ${e.message}`);
    }
  }

})().catch(e => {
  console.error('ERRO:', e.message);
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup() {
  log('Encerrando...');
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  try { if (chromeProcess) chromeProcess.kill(); } catch (e) {}
  try { apiServer.close(); } catch (e) {}
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
