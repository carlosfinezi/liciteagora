const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { initAuthAndSession, installAuthBarrier, installProtectedStatic } = require('./auth-bootstrap');
const { registrarRotasAuthPublicas, registrarRotasAuthProtegidas } = require('./auth-routes');

const app = express();

const PORT = 3000;

// NFSE-M06 onda 6.39 (2026-04-20): middleware base (CORS allow-list +
// body parsers + static da login page) extraido para base-middleware.js.
const { applyBaseMiddleware } = require('./base-middleware');
applyBaseMiddleware(app);

// Configuração da API do PNCP
const PNCP_API_BASE = 'https://pncp.gov.br/api/consulta/v1';
const PNCP_API_ITENS = 'https://pncp.gov.br/api/pncp/v1';

// Módulo de análise IA
const { processarFilaAnalise } = require('./analise-ia');

// NFSE-M06 onda 6.41 (2026-04-20): DB open + schema + persistência +
// pncpSync.init + configHelpers consolidados em db-bootstrap.js.
const { bootstrapDatabase } = require('./db-bootstrap');
const { db, dbPath, salvarItens, pncpSync, getConfigValue, setConfigValue, getIAKeys } = bootstrapDatabase({ processarFilaAnalise });


// NFSE-M06 onda 6.40 (2026-04-20): criarUsuarioInicial + sessionSecret +
// apiKey + session middleware foram consolidados em auth-bootstrap.js.
const { apiKey } = initAuthAndSession(app, db);


// NFSE-M06 onda 6.31 (2026-04-20): rotas públicas (/api/login com rate
// limit SEC-03 + /api/logout) migradas para auth-routes.js. Middleware
// session() e barreira requireAuth continuam no bootstrap abaixo.
registrarRotasAuthPublicas(app, db);

// NFSE-M06 onda 6.37 (2026-04-20): bloco pre-auth (Portal do Cliente +
// download publico do Browser + Comprasnet auto-login + Electron remoto)
// migrou para pre-auth-routes.js. Fica antes de app.use(requireAuth()) e
// preserva a ordem portal > download > comprasnet > electron.
const { registerPreAuthRoutes } = require('./pre-auth-routes');
registerPreAuthRoutes(app, db, { apiKey });

installAuthBarrier(app, db, { apiKey });

// NFSE-M06 onda 6.31 (2026-04-20): rotas protegidas (/api/change-password,
// /api/auth/api-key) migradas para auth-routes.js.
registrarRotasAuthProtegidas(app, db, { apiKey });


installProtectedStatic(app);

// NFSE-M06 onda 6.36 (2026-04-20): ~55 registros de rotas protegidas
// (MonitorV2, Licitacoes, Sniper, NFSe, Cobrancas, Financeiro, suprimentos,
// fiscais, wiring do robô monitor-mensagens etc.) + wrappers enviarTelegram /
// enviarNotificacaoTelegram migraram para route-registry.js. Dependências
// passadas uma vez; a ordem interna de registro é preservada 1:1.
const { registerProtectedRoutes } = require('./route-registry');
registerProtectedRoutes(app, {
  db, dbPath, PORT,
  pncpSync, salvarItens,
  PNCP_API_BASE, PNCP_API_ITENS,
  getConfigValue, setConfigValue, getIAKeys,
});


// NFSE-M06 onda 6.34 (2026-04-20): _logStartupBanner,
// _iniciarSchedulersMaster, _iniciarWorkerHttp e o dispatch de
// process.env.ROLE migraram para role-dispatch.js. O factory recebe
// todas as dependências (db, app, PORT, schedulers...) uma vez e expõe
// dispatch(role?) que roda o ramo correto. Produção: consulta-licitacoes
// (ROLE=worker) aterra aqui; liciteagora.service usa scheduler.js direto.
const { createRoleDispatch } = require('./role-dispatch');
createRoleDispatch({
  db, app, PORT, apiKey, dbPath, PNCP_API_BASE, getConfigValue, pncpSync,
}).dispatch();
