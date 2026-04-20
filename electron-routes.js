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
const ELECTRON_VERSION = '1.1.0'; // Incrementar ao publicar nova versão

function registrarRotasElectron(app, db, { apiKey }) {
  if (!apiKey) {
    throw new Error('electron-routes: apiKey é obrigatório');
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
      releaseNotes: 'Session timers, mensagens v1 global, auto-update',
    });
  });

  app.get('/api/electron/download-exe', (req, res) => {
    const paths = [
      path.join(__dirname, 'electron-standalone', 'dist', 'LiciteAgora-Browser.exe'),
      path.join(__dirname, '..', 'public_html', 'downloads', 'LiciteAgora-Browser.exe'),
    ];
    const filePath = paths.find(p => fs.existsSync(p));
    if (!filePath) return res.status(404).json({ error: 'Exe não encontrado' });
    res.setHeader('Content-Disposition', 'attachment; filename=LiciteAgora-Browser.exe');
    res.sendFile(filePath);
  });

  // ─── Status/Logs do Electron remoto ────────────────────────────────────────
  app.post('/api/electron/logs', (req, res) => {
    const key = req.headers['x-api-key'];
    if (key !== apiKey) return res.status(401).json({ error: 'API key inválida' });
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

  // ─── Endpoint para Electron remoto buscar credenciais ──────────────────────
  // SEC-01 (2026-04-18): exige X-Api-Key. Electron que ainda não tem a chave deve
  // receber via --api-key, LICITEAGORA_API_KEY ou configuração manual inicial.
  // NUNCA devolver apiKey no corpo — rotaciona-la exige deploy manual.
  app.get('/api/electron/credentials', (req, res) => {
    try {
      const headerKey = req.headers['x-api-key'];
      if (!headerKey || headerKey !== apiKey) {
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

  console.log('[Electron] Rotas registradas');
}

module.exports = { registrarRotasElectron };
