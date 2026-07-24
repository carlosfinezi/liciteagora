// electron-routes.js
//
// Rotas pre-auth do Electron remoto (cliente desktop Windows que
// conecta no servidor via API key). Extraído de server.js em
// NFSE-M06 onda 6.21.
//
// IMPORTANTE: todas as rotas deste módulo ficam ANTES do
// requireAuth(app). Por isso o factory deve ser chamado no estágio
// pré-auth do server.js — mesma área de registrarRotasPortal e do
// comprasnetLoginRoutes. Colocá-lo no cluster principal de
// registrarRotas* (que fica depois do app.use(requireAuth)) QUEBRA
// as rotas públicas de download/auto-update/logs.
//
// Escopo: 8 rotas em /api/electron/*:
//
//   GET  /download                 download público do browser-win.zip
//                                   (legado — NÃO faz parte deste módulo,
//                                   fica inline no server.js em "DOWNLOAD
//                                   PÚBLICO")
//
//   GET  /api/electron/download         download do zip legado (v2)
//   POST /api/electron/error            recebe stack trace do cliente
//                                        (buffer in-memory de 100 itens)
//   GET  /api/electron/errors           lista os erros acumulados
//   GET  /api/electron/check-version    metadata para auto-update
//                                        (retorna ELECTRON_VERSION + url)
//   GET  /api/electron/download-exe     download do executable .exe
//
//   POST /api/electron/logs             recebe logs do cliente.
//                                        SELF-AUTH: exige X-Api-Key no
//                                        header (não depende do requireAuth
//                                        porque alguns clientes rodam sem
//                                        sessão cookie).
//   GET  /api/electron/status           status agregado (logs, state,
//                                        bearerAge, lastSeen). PÚBLICO —
//                                        comportamento 1:1 do monolito.
//
//   GET  /api/electron/credentials      devolve govbr_cpf/govbr_senha para
//                                        o electron auto-logar no Comprasnet.
//                                        SELF-AUTH: exige X-Api-Key. Ver
//                                        comentário SEC-01 original (2026-04-18):
//                                        a apiKey NÃO é mais devolvida no
//                                        corpo — o cliente já precisa tê-la
//                                        para passar na validação.
//
// ESTADO INTERNO (reset a cada restart do worker — comportamento 1:1
// do monolito):
//   - electronErrors  array circular de até 100 itens
//   - electronState   snapshot dos últimos 500 logs + state/bearerAge
//                     /lastSeen
//   - ELECTRON_VERSION constante (incrementar ao publicar build nova)
//
// DEPENDÊNCIAS do factory:
//   - db        better-sqlite3 (apenas /credentials lê config)
//   - apiKey    string já resolvida em server.js (getApiKey(db))
//
// __dirname aqui resolve para o mesmo diretório de server.js.

const fs = require('fs');
const path = require('path');

// Estado interno (reset em restart do worker — 1:1 do monolito)
const electronErrors = [];
const electronState = { logs: [], state: 'offline', bearerAge: null, lastSeen: null };
const ELECTRON_VERSION = '5.2.4'; // Incrementar ao publicar nova versão

function registrarRotasElectron(app, db, { apiKey }) {
  // Multi-tenant (2026-04-22): quando apiKey é null, resolve em runtime
  // a partir do req.tenantDb (cada tenant tem seu api_key). Single-tenant
  // legado: apiKey é a chave fixa do db único.
  function resolveApiKey(req) {
    if (apiKey) return apiKey;
    if (req.tenantDb) {
      try {
        const row = req.tenantDb.prepare("SELECT valor FROM config WHERE chave = 'api_key'").get();
        return row ? row.valor : null;
      } catch (_) { return null; }
    }
    return null;
  }

  // ─── Download do Electron para Windows ─────────────────────────────────────
  app.get('/api/electron/download', (req, res) => {
    const paths = [
      path.join(__dirname, 'electron-standalone', 'dist', 'LiciteAgora-v2.zip'),
      path.join(__dirname, '..', 'public_html', 'LiciteAgora-v2.zip'),
    ];
    const filePath = paths.find(p => fs.existsSync(p));
    if (!filePath) return res.status(404).json({ error: 'Build não encontrado' });
    res.setHeader('Content-Disposition', 'attachment; filename=LiciteAgora-Electron.zip');
    res.sendFile(filePath);
  });

  // ─── Erros do Electron remoto (sem auth) ───────────────────────────────────
  app.post('/api/electron/error', (req, res) => {
    const err = req.body || {};
    err.receivedAt = new Date().toISOString();
    electronErrors.push(err);
    if (electronErrors.length > 100) electronErrors.shift();
    console.error('[Electron Error] ' + (err.context || '') + ': ' + (err.error || ''));
    res.json({ ok: true });
  });
  app.get('/api/electron/errors', (req, res) => { res.json(electronErrors); });

  // ─── Versão do Electron (para auto-update, sem auth) ────────────────────────
  app.get('/api/electron/check-version', (req, res) => {
    const downloadUrl = (req.protocol + '://' + req.get('host')) + '/api/electron/download-exe';
    res.json({
      version: ELECTRON_VERSION,
      downloadUrl,
      releaseNotes: 'v5.2.1 — diagnóstico de crashes: log persistente em arquivo (userData/logs/main.log, com rotação) + handlers de uncaughtException/unhandledRejection/render-process-gone/child-process-gone + crashReporter (minidumps locais). O app deixa de encerrar silenciosamente: a causa fica registrada e crashes de renderer recarregam a janela em vez de matar a UI. Sobre v5.2.0: auto-update via electron-updater + NSIS per-user (%LOCALAPPDATA%), atualização silenciosa com salvaguarda durante disputa/lance.',
    });
  });

  app.get('/api/electron/download-exe', (req, res) => {
    const paths = [
      path.join(__dirname, 'electron-standalone', 'dist', 'LiciteAgora-Browser.exe'),
      path.join(__dirname, '..', 'public_html', 'downloads', 'LiciteAgora-Browser.exe'),
    ];
    const filePath = paths.find(p => fs.existsSync(p));
    if (!filePath) return res.status(404).json({ error: 'Exe não encontrado' });
    // Serve como .zip: o arquivo atual em /download-exe é o estável v1.0.0 (zip
    // portable), não um .exe único. Nome .exe fazia o Windows tentar executar o
    // zip → "arquivo corrompido". Nome .zip deixa extrair normalmente.
    res.setHeader('Content-Disposition', 'attachment; filename=LiciteAgora-Browser-estavel.zip');
    res.sendFile(filePath);
  });

  // Build NSIS installer (v5+, 2026-04-30): instala em Program Files,
  // persiste config em %APPDATA% (não some no reboot) e registra Task
  // Scheduler /sc onlogon pra subir sozinho após reiniciar o Windows.
  // É a build "preferida" pra clientes finais; o /download-exe portable
  // continua disponível como fallback caso o installer dê problema.
  app.get('/api/electron/download-installer', (req, res) => {
    const paths = [
      path.join(__dirname, 'electron-standalone', 'dist', 'LiciteAgora-Setup.exe'),
      path.join(__dirname, '..', 'public_html', 'downloads', 'LiciteAgora-Setup.exe'),
    ];
    const filePath = paths.find(p => fs.existsSync(p));
    if (!filePath) return res.status(404).json({ error: 'Installer não encontrado (rode build:win:nsis primeiro)' });
    res.setHeader('Content-Disposition', 'attachment; filename=LiciteAgora-Setup.exe');
    res.sendFile(filePath);
  });

  // Fallback v4 portable (2026-04-30): build estável anterior preservada
  // antes do refactor v5. Usar caso o installer NSIS ou o portable v5
  // dê problema. Não muda automaticamente — só se o cliente baixar deste
  // endpoint explicitamente.
  app.get('/api/electron/download-exe-v4', (req, res) => {
    const paths = [
      path.join(__dirname, 'electron-standalone', 'dist', 'LiciteAgora-Browser-v4.exe'),
      path.join(__dirname, '..', 'public_html', 'downloads', 'LiciteAgora-Browser-v4.exe'),
    ];
    const filePath = paths.find(p => fs.existsSync(p));
    if (!filePath) return res.status(404).json({ error: 'Build v4 não encontrada' });
    res.setHeader('Content-Disposition', 'attachment; filename=LiciteAgora-Browser-v4.exe');
    res.sendFile(filePath);
  });

  // ─── Feed do electron-updater (generic provider) ────────────────────────────
  // Cliente NSIS per-user (v5.2+) lê latest.yml + instalador + blockmap a partir
  // do feedUrl (.../api/electron/updates). Sem auth: é só o binário público.
  // Whitelist de nomes evita path traversal (e o :file do Express não casa '/').
  app.get('/api/electron/updates/:file', (req, res) => {
    const allow = new Set(['latest.yml', 'LiciteAgora-Setup.exe', 'LiciteAgora-Setup.exe.blockmap', 'hCaptcha-Test-LiciteAgora.exe']);
    const file = req.params.file;
    if (!allow.has(file)) return res.status(404).json({ error: 'arquivo não permitido' });
    const candidates = [
      path.join(__dirname, 'electron-standalone', 'dist', file),
      path.join(__dirname, '..', 'public_html', 'downloads', file),
    ];
    const filePath = candidates.find(p => fs.existsSync(p));
    if (!filePath) return res.status(404).json({ error: 'arquivo não encontrado' });
    if (file.endsWith('.yml')) res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    res.sendFile(filePath);
  });

  // ─── Status/Logs do Electron remoto ────────────────────────────────────────
  app.post('/api/electron/logs', (req, res) => {
    const key = req.headers['x-api-key'];
    const expected = resolveApiKey(req);
    if (!expected || key !== expected) return res.status(401).json({ error: 'API key inválida' });
    const { logs, state: elState, bearerAge } = req.body || {};
    if (Array.isArray(logs)) {
      electronState.logs.push(...logs);
      if (electronState.logs.length > 500) electronState.logs = electronState.logs.slice(-500);
    }
    if (elState) electronState.state = elState;
    if (bearerAge !== undefined) electronState.bearerAge = bearerAge;
    electronState.lastSeen = new Date().toISOString();
    res.json({ ok: true });
  });
  app.get('/api/electron/status', (req, res) => {
    const since = req.query.since ? new Date(req.query.since).toISOString() : null;
    let logs = electronState.logs;
    if (since) logs = logs.filter(l => l.time > since);
    res.json({ state: electronState.state, bearerAge: electronState.bearerAge, lastSeen: electronState.lastSeen, logCount: electronState.logs.length, logs });
  });

  // ─── Gravador de rede (modo captura) ───────────────────────────────────────
  // O app Electron grava requisições+respostas (HAR) de um portal e envia aqui.
  // Uso: reverter/validar fluxos de portais (proposta, lance, etc.) com dados reais.
  // Segredos são mascarados no app por padrão. Salva em private/captures/<slug>/.
  app.post('/api/electron/capture', (req, res) => {
    const key = req.headers['x-api-key'];
    const expected = resolveApiKey(req);
    if (!expected || key !== expected) return res.status(401).json({ error: 'API key inválida' });
    try {
      const { har, portal, label, appVersion } = req.body || {};
      if (!har || typeof har !== 'object' || !har.log) {
        return res.status(400).json({ error: 'har (objeto HAR) obrigatório' });
      }
      const clean = (s, max) => String(s || '').replace(/[^a-z0-9_-]/gi, '_').slice(0, max);
      const slug = clean(req.tenant?.slug || 'sem-tenant', 40);
      const dir = path.join(__dirname, 'captures', slug);
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safePortal = clean(portal, 30) || 'portal';
      const safeLabel = clean(label, 40);
      const fname = `${ts}__${safePortal}${safeLabel ? '__' + safeLabel : ''}.har`;
      const entradas = Array.isArray(har.log.entries) ? har.log.entries.length : 0;
      fs.writeFileSync(path.join(dir, fname), JSON.stringify(har, null, 2));
      console.log(`[electron capture] ${slug}/${fname} — ${entradas} req (app v${appVersion || '?'})`);
      res.json({ ok: true, arquivo: fname, entradas });
    } catch (e) {
      console.error('[electron capture] erro:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Gravador de rede passivo (BLL/BNC): recebe lotes de eventos e anexa em JSONL
  // por portal/dia em private/captures/<slug>/. Segredos já vêm mascarados do app.
  app.post('/api/electron/capture-event', (req, res) => {
    const key = req.headers['x-api-key'];
    const expected = resolveApiKey(req);
    if (!expected || key !== expected) return res.status(401).json({ error: 'API key inválida' });
    try {
      const { events, portal } = req.body || {};
      if (!Array.isArray(events) || !events.length) return res.status(400).json({ error: 'events (array) obrigatório' });
      const clean = (s, max) => String(s || '').replace(/[^a-z0-9_-]/gi, '_').slice(0, max);
      const slug = clean(req.tenant?.slug || 'sem-tenant', 40);
      const safePortal = clean(portal, 20) || 'portal';
      const dir = path.join(__dirname, 'captures', slug);
      fs.mkdirSync(dir, { recursive: true });
      const dia = new Date().toISOString().slice(0, 10);
      const rx = new Date().toISOString();
      const linhas = events.map((e) => JSON.stringify({ ...e, _rx: rx })).join('\n') + '\n';
      fs.appendFileSync(path.join(dir, `${safePortal}-${dia}.jsonl`), linhas);
      res.json({ ok: true, n: events.length });
    } catch (e) {
      console.error('[electron capture-event] erro:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Endpoint para Electron remoto buscar credenciais ──────────────────────
  // SEC-01 (2026-04-18): exige X-Api-Key. Electron que ainda não tem a chave deve
  // receber via --api-key, LICITEAGORA_API_KEY ou configuração manual inicial.
  // NUNCA devolver apiKey no corpo — rotaciona-la exige deploy manual.
  app.get('/api/electron/credentials', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const cpf = db.prepare("SELECT valor FROM config WHERE chave = 'govbr_cpf'").get();
      const senha = db.prepare("SELECT valor FROM config WHERE chave = 'govbr_senha'").get();
      if (!cpf || !senha) return res.json({ error: 'Credenciais não configuradas' });
      // apiKey NÃO é mais devolvida aqui — o cliente já precisa tê-la para passar na validação acima.
      res.json({ cpf: cpf.valor, senha: senha.valor });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Endpoints do app electron-bnc/ (paralelo ao Comprasnet) ───────────────
  // Mesmo padrão de self-auth via X-Api-Key. Fluxo:
  //   1) electron-bnc lê usuario+senha de /api/electron/bnc/credentials
  //   2) loga em bnccompras.com via webview (Chromium real, captcha invisível)
  //   3) lê cookies de bnccompras.com da sessão e POST em /api/electron/bnc/cookies
  //   4) servidor persiste em config.bnc_session_cookie pra uso por bnc-client.js
  //
  // Resolução de DB: multi-tenant respeita req.tenantDb (igual /credentials acima).
  function resolveTenantDb(req) {
    return req.tenantDb || db;
  }

  app.get('/api/electron/bnc/credentials', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const tdb = resolveTenantDb(req);
      const usuario = tdb.prepare("SELECT valor FROM config WHERE chave = 'bnc_usuario'").get();
      const senha = tdb.prepare("SELECT valor FROM config WHERE chave = 'bnc_senha'").get();
      const perfilPreferido = tdb.prepare("SELECT valor FROM config WHERE chave = 'bnc_perfil_preferido'").get();
      if (!usuario?.valor || !senha?.valor) {
        return res.json({ error: 'Credenciais BNC não configuradas' });
      }
      res.json({
        usuario: usuario.valor,
        senha: senha.valor,
        perfilPreferido: perfilPreferido?.valor || null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/electron/bnc/cookies', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const { cookie, usuario, perfil } = req.body || {};
      if (!cookie || typeof cookie !== 'string' || !/=/.test(cookie)) {
        return res.status(400).json({ error: 'cookie obrigatório (string no formato "name=value; ...")' });
      }
      const tdb = resolveTenantDb(req);
      const upsert = tdb.prepare(
        "INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)"
      );
      upsert.run('bnc_session_cookie', cookie);
      upsert.run('bnc_session_at', new Date().toISOString());
      if (usuario) upsert.run('bnc_session_user', String(usuario));
      if (perfil) upsert.run('bnc_session_perfil', String(perfil));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Status da sessão BNC pro app electron-bnc decidir se relogar
  app.get('/api/electron/bnc/session', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const tdb = resolveTenantDb(req);
      const { getSessionInfo } = require('./bnc-client');
      res.json(getSessionInfo(tdb));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Endpoints do app electron-bll/ (paralelo ao BNC) ──────────────────────
  // Mesmo padrão de self-auth via X-Api-Key e mesmo fluxo de captura de sessão:
  //   1) Electron lê usuario+senha de /api/electron/bll/credentials
  //   2) loga em bllcompras.com via webview (Chromium real, captcha)
  //   3) lê cookies de bllcompras.com e POST em /api/electron/bll/cookies
  //   4) servidor persiste em config.bll_session_cookie pra uso por bll-client.js

  app.get('/api/electron/bll/credentials', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const tdb = resolveTenantDb(req);
      const usuario = tdb.prepare("SELECT valor FROM config WHERE chave = 'bll_usuario'").get();
      const senha = tdb.prepare("SELECT valor FROM config WHERE chave = 'bll_senha'").get();
      const perfilPreferido = tdb.prepare("SELECT valor FROM config WHERE chave = 'bll_perfil_preferido'").get();
      if (!usuario?.valor || !senha?.valor) {
        return res.json({ error: 'Credenciais BLL não configuradas' });
      }
      res.json({
        usuario: usuario.valor,
        senha: senha.valor,
        perfilPreferido: perfilPreferido?.valor || null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/electron/bll/cookies', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const { cookie, usuario, perfil } = req.body || {};
      if (!cookie || typeof cookie !== 'string' || !/=/.test(cookie)) {
        return res.status(400).json({ error: 'cookie obrigatório (string no formato "name=value; ...")' });
      }
      const tdb = resolveTenantDb(req);
      const upsert = tdb.prepare(
        "INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)"
      );
      upsert.run('bll_session_cookie', cookie);
      upsert.run('bll_session_at', new Date().toISOString());
      if (usuario) upsert.run('bll_session_user', String(usuario));
      if (perfil) upsert.run('bll_session_perfil', String(perfil));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Status da sessão BLL pro app electron-bll decidir se relogar
  app.get('/api/electron/bll/session', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const tdb = resolveTenantDb(req);
      const { getSessionInfo } = require('./bll-client');
      res.json(getSessionInfo(tdb));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Captcha bridge: Electron BNC polla pendings, executa grecaptcha.execute
  // no webview da sala, devolve token. Usado pelo motor de disputa pra obter
  // token reCAPTCHA v3 (action=performBid) sob demanda.
  //
  // Estado global (bnc-captcha-bridge mantém Map<reqId, ...>). Pra hoje, um
  // Electron BNC por servidor — multi-tenant fica pra futuro.

  app.get('/api/electron/bnc/captcha-pending', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const { getNextPending } = require('./bnc-captcha-bridge');
      const next = getNextPending();
      res.json(next || {});
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/electron/bnc/captcha-token', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const { id, token, error } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id obrigatório' });
      const { deliverToken } = require('./bnc-captcha-bridge');
      const r = deliverToken(id, token, error);
      res.status(r.ok ? 200 : 410).json(r);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Debug/observabilidade — stats da fila de captcha (sem requerer X-Api-Key
  // pra facilitar diagnóstico do dev; comentar em prod se preocupação)
  app.get('/api/electron/bnc/captcha-stats', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const { stats } = require('./bnc-captcha-bridge');
      res.json(stats());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Captcha bridge BLL: Electron BLL polla pendings, executa grecaptcha.execute
  // no webview da sala bllcompras.com, devolve token reCAPTCHA v3 (action=performBid).
  // Espelha o bridge BNC (bll-captcha-bridge mantém Map<reqId,...>). Só 1bit roda Electron.
  app.get('/api/electron/bll/captcha-pending', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const { getNextPending } = require('./bll-captcha-bridge');
      const next = getNextPending();
      res.json(next || {});
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/electron/bll/captcha-token', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const { id, token, error } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id obrigatório' });
      const { deliverToken } = require('./bll-captcha-bridge');
      const r = deliverToken(id, token, error);
      res.status(r.ok ? 200 : 410).json(r);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/electron/bll/captcha-stats', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const { stats } = require('./bll-captcha-bridge');
      res.json(stats());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DEBUG: enfileira um requestToken e aguarda o relay (Electron BLL) cunhar o
  // token reCAPTCHA v3. Valida o captcha-bridge↔relay E2E sem o scheduler.
  // Não envia lance — só cunha e devolve. Remover quando o scheduler existir.
  app.get('/api/electron/bll/captcha-test', async (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const action = (req.query.action && String(req.query.action)) || 'performBid';
      const timeoutMs = Math.min(Number(req.query.timeoutMs) || 25000, 60000);
      const { requestToken } = require('./bll-captcha-bridge');
      const t0 = Date.now();
      const token = await requestToken({ action, timeoutMs });
      const isStr = typeof token === 'string';
      res.json({
        ok: true, action, elapsedMs: Date.now() - t0,
        tokenType: typeof token,
        isString: isStr,
        tokenLen: isStr ? token.length : null,
        tokenPrefix: isStr ? token.slice(0, 30) : null,
        raw: isStr ? undefined : String(JSON.stringify(token)).slice(0, 400),
      });
    } catch (e) {
      res.status(504).json({ ok: false, error: e.message });
    }
  });

  // Auto-cadastro de sala BNC ao navegar pra /BatchList no Electron portal=bnc.
  // Idempotente — bncSalas.cadastrarSala faz upsert por compraId.
  // Self-auth X-Api-Key (mesmo padrão dos outros /api/electron/bnc/*).
  app.post('/api/electron/bnc/sala-auto-cadastrar', async (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      const expected = resolveApiKey(req);
      if (!headerKey || !expected || headerKey !== expected) {
        return res.status(401).json({ error: 'X-Api-Key obrigatório' });
      }
      const { url } = req.body || {};
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url obrigatória' });
      }
      const tdb = resolveTenantDb(req);
      const bncSalas = require('./bnc-salas');
      const bncScheduler = require('./bnc-dispute-scheduler');
      const r = await bncSalas.cadastrarSala(tdb, { url, notas: 'Auto-cadastro do Electron BNC' });
      // Refresca o scheduler pra subir engine pra essa sala se for nova
      try {
        const slug = req.tenant?.slug || req.tenantSlug;
        if (slug) bncScheduler.refreshTenant(slug);
      } catch (e) { /* swallow */ }
      res.json({ ok: true, compraId: r.sala.compraId, salaId: r.sala.id, lotesInseridos: r.lotesInseridos });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Licitanet: ponte de coleta de MARCA (ver project_licitanet_marca_scraping) ─
  // licitanet.com.br bloqueia o IP do servidor (403); o Electron (IP residencial
  // + sessão) faz as 2 chamadas de API do Licitanet pra obter a URL do relatório
  // "Extrato de Ata" no CloudFront, e devolve pro servidor processar.
  //   1) GET  /api/electron/licitanet/pendentes  → fila {cnpj,ano,seq,processId}
  //   2) POST /api/electron/licitanet/ata         → recebe ataUrl e grava marca
  // Self-auth via X-Api-Key (igual /credentials).
  const _lnAuth = (req, res) => {
    const headerKey = req.headers['x-api-key'];
    const expected = resolveApiKey(req);
    if (!headerKey || !expected || headerKey !== expected) {
      res.status(401).json({ error: 'X-Api-Key obrigatório' }); return false;
    }
    return true;
  };

  app.get('/api/electron/licitanet/pendentes', async (req, res) => {
    if (!_lnAuth(req, res)) return;
    try {
      const catalogPg = require('./catalog-pg');
      const licitanet = require('./licitanet-marca');
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);
      // Licitanet homologadas, com marca faltando, que aparecem em algum grupo.
      const rows = await catalogPg.query(`
        SELECT l."cnpj" AS cnpj, l."anoCompra" AS ano, l."sequencialCompra" AS seq,
               left(l."objetoCompra",60) AS objeto
          FROM licitacoes l
         WHERE l."linkSistemaOrigem" ILIKE '%licitanet%'
           AND EXISTS (SELECT 1 FROM resultados_bi rb
                        WHERE rb."cnpj"=l."cnpj" AND rb."ano"=l."anoCompra" AND rb."sequencial"=l."sequencialCompra"
                          AND rb."niFornecedor"<>'__sem_resultado__'
                          AND ((rb."marcaFabricante" IS NULL OR rb."marcaFabricante"='') OR (rb."modeloVersao" IS NULL OR rb."modeloVersao"='')))
           AND EXISTS (SELECT 1 FROM itens i2 JOIN bi_grupo_item g ON g."itemId"=i2."id"
                        WHERE i2."licitacaoId"=l."id")
         ORDER BY l."dataPublicacaoPncp" DESC
         LIMIT $1`, [limit]);
      // deriva o processId de cada (chamada PNCP; nº limitado)
      const out = [];
      for (const r of rows) {
        let processId = null;
        try { processId = await licitanet.getProcessId(r.cnpj, r.ano, r.seq); } catch { /* ignora */ }
        if (processId) out.push({ cnpj: r.cnpj, ano: r.ano, sequencial: r.seq, processId, objeto: r.objeto });
      }
      res.json({ pendentes: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/electron/licitanet/ata', async (req, res) => {
    if (!_lnAuth(req, res)) return;
    try {
      const licitanet = require('./licitanet-marca');
      const { cnpj, ano, sequencial, ataUrl } = req.body || {};
      if (!cnpj || !ano || !sequencial || !ataUrl) {
        return res.status(400).json({ error: 'cnpj, ano, sequencial e ataUrl obrigatórios' });
      }
      const r = await licitanet.processarAtaUrl({ cnpj, ano, sequencial, ataUrl });
      res.json({ ok: true, status: r.status, itensAta: r.itensAta, mapeados: r.mapeados, gravados: r.gravados });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[Electron] Rotas registradas');
}

module.exports = { registrarRotasElectron };
