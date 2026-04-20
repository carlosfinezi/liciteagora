// pre-auth-routes.js
//
// NFSE-M06 onda 6.37 (2026-04-20): consolidação do bloco pré-auth do
// server.js. Todas as rotas registradas por este módulo ficam ANTES
// da barreira `app.use(requireAuth(...))` em server.js. A ordem
// interna importa — mantida 1:1 com o que existia em server.js:
//
//   1. Portal do cliente: estático em /portal + rotas públicas do
//      portal (registrarRotasPortal).
//   2. Download público: GET /download/:file (allow-list restrita
//      ao instalador do Electron Browser).
//   3. Comprasnet auto-login: router montado em /api/comprasnet
//      (página de auto-login + introspeção de token).
//   4. Electron remoto: registrarRotasElectron(app, db, { apiKey })
//      — rotas /api/electron/* autenticadas por X-Api-Key.
//
// NÃO extrai o `app.use(express.static(path.join(__dirname, 'public',
// 'auth')))` (login page) porque em server.js ele fica acima da
// inicialização da sessão/bootstrap e movê-lo mudaria a ordem
// relativa com o session middleware. Fica como onda futura.
//
// Dependências recebidas via factory:
//   - app     Express app
//   - db      handle better-sqlite3 (consumido por portal + electron)
//   - apiKey  string, usada por electron-routes para autenticar
//             clientes Windows via header X-Api-Key
//
// Idempotência: o factory pode ser chamado uma única vez por processo
// (registra middlewares, não há reentrância). Em testes de integração
// é responsabilidade do caller criar um app novo.

const path = require('path');
const fs = require('fs');
const express = require('express');

const comprasnetLoginRoutes = require('./comprasnet-login-routes');
const { registrarRotasPortal } = require('./portal-routes');
const { registrarRotasElectron } = require('./electron-routes');

function registerPreAuthRoutes(app, db, { apiKey }) {
  // ==================== PORTAL DO CLIENTE (antes do auth) ====================
  app.use('/portal', express.static(path.join(__dirname, 'public', 'portal')));
  registrarRotasPortal(app, db);

  // ==================== DOWNLOAD PÚBLICO (antes do auth) ====================
  app.get('/download/:file', (req, res) => {
    const allowed = ['LiciteAgora-Browser-win.zip'];
    if (!allowed.includes(req.params.file)) return res.status(404).end();
    const filePath = path.join(__dirname, 'electron-standalone', 'dist', req.params.file);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
    res.download(filePath);
  });

  // ==================== COMPRASNET AUTO-LOGIN (Público - antes do auth) ====================
  app.use('/api/comprasnet', comprasnetLoginRoutes);

  // ==================== ELECTRON REMOTO (antes do auth) ====================
  registrarRotasElectron(app, db, { apiKey });
}

module.exports = { registerPreAuthRoutes };
