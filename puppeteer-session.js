'use strict';

/**
 * puppeteer-session.js — Sessão Puppeteer para envio de lances no Comprasnet
 *
 * Substitui a extensão Chrome para:
 *  - Manter sessão SSO viva (keepalive a cada 60s)
 *  - Capturar Bearer tokens automaticamente via CDP
 *  - Enviar lances via page.evaluate (mesmo IP/cookies)
 *  - Auto-login via certificado digital (.pfx em NSS database)
 *
 * O Chrome roda no servidor (mesmo IP que o usuário configurou no Comprasnet).
 * Puppeteer nunca dorme — ao contrário do MV3 service worker.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ─── Constantes ─────────────────────────────────────────────────────────────

const COMPRASNET = 'https://cnetmobile.estaleiro.serpro.gov.br';
const COMPRASNET_SSO = 'https://cnetmobile.estaleiro.serpro.gov.br/seguro/fornecedor/compras';
const GOV_BR_LOGIN = 'https://sso.acesso.gov.br';
const TOKEN_MAX_AGE_MS = 540000; // 9 min (extensão usa o mesmo)
const KEEPALIVE_INTERVAL_MS = 60000; // 60s
const RELAUNCH_DELAY_MS = 5000;
const USER_DATA_DIR = path.join(os.homedir(), '.puppeteer-session-data');
const DEBUGGING_PORT = 9333; // diferente do 9222 usado pelo MonitorMensagens

const API_HEADERS_BASE = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'x-device-platform': 'web',
  'x-version-number': '6.0.0',
  'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
};

// ─── Estado ─────────────────────────────────────────────────────────────────

/** @type {PuppeteerSession|null} */
let instance = null;

class PuppeteerSession {
  constructor() {
    this.browser = null;
    this.page = null;
    this.cdpSession = null;

    // Estado da sessão
    this.state = 'idle'; // idle | launching | connected | logged_in | error
    this.bearerToken = null;
    this.bearerTimestamp = null;
    this.lastKeepalive = null;
    this.lastKeepaliveOk = false;
    this.launchedAt = null;
    this.loginAt = null;
    this.pageUrl = null;
    this.headless = true;

    // Timers
    this._keepaliveTimer = null;
    this._autoRelaunch = true;

    // Logs (últimos 200)
    this.logs = [];
    this.maxLogs = 200;

    // Callbacks
    this.onBearerCaptured = null; // (bearer) => void — set by sniper-lance-routes
  }

  // ─── Logging ──────────────────────────────────────────────────────────────

  log(msg) {
    const ts = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    const entry = { ts, msg, time: Date.now() };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    console.log(`[PuppeteerSession] [${ts}] ${msg}`);
  }

  // ─── Launch ───────────────────────────────────────────────────────────────

  async launch({ headless = true } = {}) {
    if (this.browser) {
      this.log('Chrome já está rodando');
      return { success: true, message: 'Já conectado' };
    }

    this.state = 'launching';
    this.headless = headless;
    this.log(`Iniciando Chrome (headless=${headless})...`);

    try {
      // Garantir user data dir
      if (!fs.existsSync(USER_DATA_DIR)) {
        fs.mkdirSync(USER_DATA_DIR, { recursive: true });
      }

      const browserArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--ignore-certificate-errors',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--window-size=1366,768',
        '--disable-popup-blocking',
        `--remote-debugging-port=${DEBUGGING_PORT}`,
        // Certificado: auto-seleciona para gov.br
        '--auto-select-certificate-for-urls={"pattern":"*gov.br*","filter":{}}',
      ];

      // Display virtual (Xvfb) para headed mode no servidor sem X
      if (!headless && !process.env.DISPLAY) {
        process.env.DISPLAY = ':99';
        this.log('DISPLAY definido como :99 (Xvfb)');
      }

      this.browser = await puppeteer.launch({
        headless: headless ? 'new' : false,
        defaultViewport: headless ? { width: 1366, height: 768 } : null,
        args: browserArgs,
        userDataDir: USER_DATA_DIR,
        ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=IdleDetection'],
      });

      this.launchedAt = new Date().toISOString();
      this.log('Chrome iniciado');

      // Event: crash/disconnect → auto-relaunch
      this.browser.on('disconnected', () => {
        this.log('Chrome desconectou!');
        this._cleanup();
        if (this._autoRelaunch) {
          this.log(`Auto-relaunch em ${RELAUNCH_DELAY_MS / 1000}s...`);
          setTimeout(() => this.launch({ headless: this.headless }), RELAUNCH_DELAY_MS);
        }
      });

      // Pegar ou criar página
      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();
      this.page.setDefaultTimeout(30000);

      // Bypass CSP + SSL
      try {
        await this.page.setBypassCSP(true);
      } catch (e) { /* ok */ }

      // Iniciar captura de token via CDP
      await this.startTokenCapture();

      this.state = 'connected';
      this.log('Sessão pronta — execute login() para autenticar');

      return { success: true, state: this.state };
    } catch (e) {
      this.state = 'error';
      this.log(`Erro ao iniciar: ${e.message}`);
      throw e;
    }
  }

  // ─── Token Capture via CDP ────────────────────────────────────────────────

  async startTokenCapture() {
    if (!this.page) return;

    try {
      this.cdpSession = await this.page.createCDPSession();
      await this.cdpSession.send('Network.enable');

      this.cdpSession.on('Network.requestWillBeSent', (params) => {
        const url = params.request?.url || '';
        const auth = params.request?.headers?.Authorization || params.request?.headers?.authorization;

        if (auth && auth.startsWith('Bearer ') && url.includes('cnetmobile.estaleiro.serpro.gov.br')) {
          const agora = Date.now();
          // Evitar spam — só captura se mudou ou se >30s desde o último
          if (auth !== this.bearerToken || !this.bearerTimestamp || (agora - this.bearerTimestamp) > 30000) {
            this.bearerToken = auth;
            this.bearerTimestamp = agora;
            this.log(`Bearer capturado: ${auth.substring(0, 30)}...`);

            if (this.onBearerCaptured) {
              try { this.onBearerCaptured(auth); } catch (e) { /* callback error */ }
            }
          }
        }
      });

      this.log('Captura de token CDP ativa');
    } catch (e) {
      this.log(`Erro ao iniciar captura CDP: ${e.message}`);
    }
  }

  // ─── Login ────────────────────────────────────────────────────────────────

  async login() {
    if (!this.page) throw new Error('Chrome não está rodando. Execute launch() primeiro.');

    this.log('Iniciando login no Comprasnet via gov.br...');

    try {
      // 1. Navegar ao Comprasnet (redireciona para gov.br)
      await this.page.goto(COMPRASNET_SSO, { waitUntil: 'networkidle2', timeout: 60000 });
      this.pageUrl = this.page.url();
      this.log(`Página após navegação: ${this.pageUrl}`);

      // 2. Se já estiver logado (URL do cnetmobile sem "acesso-nao-autorizado")
      if (this.pageUrl.includes('cnetmobile') && !this.pageUrl.includes('acesso-nao-autorizado')) {
        this.log('Já está logado no Comprasnet!');
        this.state = 'logged_in';
        this.loginAt = new Date().toISOString();
        this._startKeepalive();
        return { success: true, message: 'Já logado' };
      }

      // 3. Se redirecionou para gov.br — aguardar login via certificado
      if (this.pageUrl.includes('acesso.gov.br') || this.pageUrl.includes('sso.')) {
        this.log('Página gov.br detectada — aguardando fluxo de certificado...');

        // Certificado é selecionado automaticamente via --auto-select-certificate-for-urls
        // Clicar em "Certificado Digital" se o botão existir
        try {
          await this.page.waitForSelector('a[href*="certificado"], button:has-text("Certificado"), [data-toggle="certificado"]', { timeout: 5000 });
          const certBtn = await this.page.$('a[href*="certificado"]') ||
                          await this.page.$('button:has-text("Certificado")');
          if (certBtn) {
            await certBtn.click();
            this.log('Clicou em "Certificado Digital"');
          }
        } catch (e) {
          this.log('Botão de certificado não encontrado — pode já ter selecionado automaticamente');
        }

        // Aguardar redirect de volta ao Comprasnet (até 60s)
        try {
          await this.page.waitForFunction(
            () => window.location.href.includes('cnetmobile') && !window.location.href.includes('acesso-nao-autorizado'),
            { timeout: 60000 }
          );
          this.pageUrl = this.page.url();
          this.log(`Login concluído! URL: ${this.pageUrl}`);
        } catch (e) {
          this.pageUrl = this.page.url();
          this.log(`Timeout aguardando login. URL atual: ${this.pageUrl}`);

          // Se ainda está no gov.br, pode ser que precisa de intervenção manual
          if (this.pageUrl.includes('acesso.gov.br')) {
            this.state = 'error';
            return { success: false, message: 'Login requer intervenção manual (gov.br)', url: this.pageUrl };
          }
        }
      }

      // 4. Verificar se login teve sucesso
      this.pageUrl = this.page.url();
      if (this.pageUrl.includes('cnetmobile') && !this.pageUrl.includes('acesso-nao-autorizado')) {
        this.state = 'logged_in';
        this.loginAt = new Date().toISOString();
        this.log('Login OK — iniciando keepalive');
        this._startKeepalive();

        // Forçar uma chamada API para capturar o Bearer
        await this._triggerBearerCapture();

        return { success: true, state: this.state };
      }

      this.state = 'connected'; // conectado mas não logado
      return { success: false, message: 'Login não completou', url: this.pageUrl };

    } catch (e) {
      this.log(`Erro no login: ${e.message}`);
      this.state = 'error';
      throw e;
    }
  }

  // ─── Keepalive ────────────────────────────────────────────────────────────

  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveTimer = setInterval(() => this._keepaliveStep(), KEEPALIVE_INTERVAL_MS);
    this.log(`Keepalive ativo (cada ${KEEPALIVE_INTERVAL_MS / 1000}s)`);
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  async _keepaliveStep() {
    if (!this.page || this.state !== 'logged_in') return;

    try {
      // 1. Dismiss idle dialogs primeiro
      await this.dismissIdleDialogs();

      // 2. Chamar datahorabrasilia para manter sessão
      const result = await this.fetchComprasnet('/comprasnet-disputa/v1/datahorabrasilia');

      if (result.ok) {
        this.lastKeepalive = new Date().toISOString();
        this.lastKeepaliveOk = true;
        // Não logar a cada 60s para não poluir — logar a cada 5 min
        const now = Date.now();
        if (!this._lastKeepaliveLog || (now - this._lastKeepaliveLog) > 300000) {
          this.log(`Keepalive OK (${result.status})`);
          this._lastKeepaliveLog = now;
        }
      } else if (result.status === 401 || result.status === 403) {
        this.log(`Keepalive: sessão expirada (${result.status}) — tentando retoken...`);
        this.lastKeepaliveOk = false;

        // Tentar retoken
        const retokenOk = await this.retoken();
        if (!retokenOk) {
          this.log('Retoken falhou — tentando re-login automático...');
          try {
            await this.login();
          } catch (e) {
            this.log(`Re-login falhou: ${e.message}`);
            this.state = 'connected'; // degradar estado
          }
        }
      } else {
        this.lastKeepaliveOk = false;
        this.log(`Keepalive: status inesperado ${result.status}`);
      }
    } catch (e) {
      this.lastKeepaliveOk = false;
      this.log(`Keepalive erro: ${e.message}`);
    }
  }

  // ─── Trigger Bearer Capture ───────────────────────────────────────────────

  async _triggerBearerCapture() {
    try {
      // Fazer uma chamada leve para forçar o browser a enviar Authorization header
      await this.fetchComprasnet('/comprasnet-disputa/v1/datahorabrasilia');
      this.log('Trigger de captura de bearer executado');
    } catch (e) {
      this.log(`Trigger bearer falhou: ${e.message}`);
    }
  }

  // ─── Fetch no contexto da página ──────────────────────────────────────────

  /**
   * Executa fetch GET no contexto do browser (mesmo IP, cookies, sessão SSO).
   * Equivalente ao comprasnetFetch() da extensão.
   */
  async fetchComprasnet(apiPath) {
    if (!this.page) throw new Error('Página não disponível');

    const bearer = this.bearerToken || '';
    const baseUrl = COMPRASNET;

    const result = await this.page.evaluate(async (path, token, base, headers) => {
      try {
        const h = { ...headers };
        if (token) h['Authorization'] = token;
        // SEM Origin/Referer (causa 400 no Comprasnet)

        const resp = await fetch(base + path, {
          method: 'GET',
          credentials: 'include',
          headers: h,
        });

        let body;
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('json')) {
          body = await resp.json();
        } else {
          body = await resp.text();
        }

        return { ok: resp.ok, status: resp.status, body };
      } catch (e) {
        return { ok: false, status: 0, body: null, error: e.message };
      }
    }, apiPath, bearer, baseUrl, API_HEADERS_BASE);

    return result;
  }

  /**
   * Envia um lance via fetch POST no contexto do browser.
   * Equivalente ao comprasnetPost() da extensão.
   */
  async enviarLance(compraId, itemNumero, valor, faseItem = 'LA') {
    if (!this.page) throw new Error('Página não disponível');
    if (!this.bearerToken) throw new Error('Sem Bearer token');
    if (!this.tokenEstaFresco()) throw new Error('Bearer expirado');

    const apiPath = `/comprasnet-disputa/v1/compras/${compraId}/itens/${itemNumero}/lances`;
    const body = { valorInformado: valor, faseItem };
    const bearer = this.bearerToken;
    const baseUrl = COMPRASNET;
    const inicio = Date.now();

    this.log(`Enviando lance: R$ ${valor.toFixed(2)} item ${itemNumero} compra ${compraId}`);

    const result = await this.page.evaluate(async (path, token, base, headers, reqBody) => {
      try {
        const h = { ...headers };
        h['Authorization'] = token;

        const resp = await fetch(base + path, {
          method: 'POST',
          credentials: 'include',
          headers: h,
          body: JSON.stringify(reqBody),
        });

        let data;
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('json')) {
          data = await resp.json();
        } else {
          data = await resp.text();
        }

        return { ok: resp.ok, status: resp.status, data };
      } catch (e) {
        return { ok: false, status: 0, data: null, error: e.message };
      }
    }, apiPath, bearer, baseUrl, API_HEADERS_BASE, body);

    const tempoMs = Date.now() - inicio;

    if (result.ok) {
      this.log(`Lance OK! R$ ${valor.toFixed(2)} item ${itemNumero} (${tempoMs}ms)`);
    } else {
      const errMsg = typeof result.data === 'string' ? result.data : JSON.stringify(result.data || result.error || '');
      this.log(`Lance falhou: HTTP ${result.status} — ${errMsg.substring(0, 150)} (${tempoMs}ms)`);
    }

    return {
      sucesso: result.ok,
      httpStatus: result.status,
      resposta: typeof result.data === 'string' ? result.data : JSON.stringify(result.data || ''),
      tempoMs,
      error: result.error || null,
    };
  }

  // ─── Retoken ──────────────────────────────────────────────────────────────

  async retoken() {
    if (!this.page) return false;

    this.log('Tentando retoken...');
    try {
      const bearer = this.bearerToken || '';
      const baseUrl = COMPRASNET;

      const result = await this.page.evaluate(async (token, base, headers) => {
        try {
          const h = { ...headers };
          if (token) h['Authorization'] = token;

          const resp = await fetch(base + '/comprasnet-disputa/v1/retoken', {
            method: 'PUT',
            credentials: 'include',
            headers: h,
          });

          let data;
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('json')) {
            data = await resp.json();
          } else {
            data = await resp.text();
          }

          return { ok: resp.ok, status: resp.status, data };
        } catch (e) {
          return { ok: false, status: 0, error: e.message };
        }
      }, bearer, baseUrl, API_HEADERS_BASE);

      if (result.ok) {
        this.log(`Retoken OK (${result.status})`);
        // Novo bearer será capturado via CDP automaticamente
        return true;
      } else {
        this.log(`Retoken falhou: ${result.status}`);
        return false;
      }
    } catch (e) {
      this.log(`Retoken erro: ${e.message}`);
      return false;
    }
  }

  // ─── Dismiss Idle Dialogs ─────────────────────────────────────────────────

  async dismissIdleDialogs() {
    if (!this.page) return;

    try {
      // Clicar em botões de dialogs comuns do Comprasnet
      const dismissed = await this.page.evaluate(() => {
        const selectors = [
          // Modal genérico
          '.modal.show button.btn-primary',
          '.modal.show button.btn-close',
          // Dialogs de sessão
          'button[data-dismiss="modal"]',
          // Alertas
          '.swal2-confirm',
          '.swal2-popup button',
          // Genérico OK/Continuar
          'button:not([disabled])',
        ];

        let clicked = 0;

        // Procurar modais visíveis
        const modals = document.querySelectorAll('.modal.show, .swal2-popup, [role="dialog"]');
        for (const modal of modals) {
          // Procurar botão OK, Continuar, ou Fechar dentro do modal
          const btns = modal.querySelectorAll('button');
          for (const btn of btns) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text === 'ok' || text === 'continuar' || text === 'fechar' || text === 'sim') {
              btn.click();
              clicked++;
              break;
            }
          }
        }

        return clicked;
      });

      if (dismissed > 0) {
        this.log(`Dismiss: ${dismissed} dialog(s) fechado(s)`);
      }
    } catch (e) {
      // Silencioso — dialog dismiss não deve derrubar keepalive
    }
  }

  // ─── Token Freshness ──────────────────────────────────────────────────────

  tokenEstaFresco() {
    if (!this.bearerToken || !this.bearerTimestamp) return false;
    return (Date.now() - this.bearerTimestamp) < TOKEN_MAX_AGE_MS;
  }

  tokenIdadeSegundos() {
    if (!this.bearerTimestamp) return Infinity;
    return Math.floor((Date.now() - this.bearerTimestamp) / 1000);
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  getStatus() {
    return {
      state: this.state,
      connected: !!this.browser,
      loggedIn: this.state === 'logged_in',
      bearerFresh: this.tokenEstaFresco(),
      bearerAge: this.bearerTimestamp ? this.tokenIdadeSegundos() : null,
      bearerToken: this.bearerToken ? this.bearerToken.substring(0, 30) + '...' : null,
      lastKeepalive: this.lastKeepalive,
      lastKeepaliveOk: this.lastKeepaliveOk,
      launchedAt: this.launchedAt,
      loginAt: this.loginAt,
      pageUrl: this.pageUrl,
      headless: this.headless,
      uptime: this.launchedAt ? Math.floor((Date.now() - new Date(this.launchedAt).getTime()) / 1000) : null,
    };
  }

  // ─── Close ────────────────────────────────────────────────────────────────

  async close() {
    this._autoRelaunch = false;
    this._stopKeepalive();

    if (this.cdpSession) {
      try { await this.cdpSession.detach(); } catch (e) { /* ok */ }
      this.cdpSession = null;
    }

    if (this.browser) {
      try { await this.browser.close(); } catch (e) { /* ok */ }
      this.browser = null;
    }

    this._cleanup();
    this.log('Sessão encerrada');
    return { success: true };
  }

  _cleanup() {
    this._stopKeepalive();
    this.browser = null;
    this.page = null;
    this.cdpSession = null;
    this.state = 'idle';
    this.pageUrl = null;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

function getPuppeteerSession() {
  if (!instance) {
    instance = new PuppeteerSession();
  }
  return instance;
}

module.exports = { PuppeteerSession, getPuppeteerSession };
