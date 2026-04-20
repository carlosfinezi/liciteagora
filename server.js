const express = require('express');

// NFSE-M06 onda 6.46 (2026-04-20): bootstrap do puppeteer-extra +
// StealthPlugin extraido para puppeteer-init.js. O require e puro
// side effect -- registra StealthPlugin no singleton global do
// puppeteer-extra antes de qualquer modulo que dependa disso (ex.:
// monitor-mensagens-core.js via route-registry).
require('./puppeteer-init');

const app = express();


// NFSE-M06 onda 6.39 (2026-04-20): middleware base (CORS allow-list +
// body parsers + static da login page) extraido para base-middleware.js.
const { applyBaseMiddleware } = require('./base-middleware');
applyBaseMiddleware(app);


// Módulo de análise IA
const { processarFilaAnalise } = require('./analise-ia');

// NFSE-M06 onda 6.41 (2026-04-20): DB open + schema + persistência +
// pncpSync.init + configHelpers consolidados em db-bootstrap.js.
const { bootstrapDatabase } = require('./db-bootstrap');
const { db, dbPath, salvarItens, pncpSync, getConfigValue, setConfigValue, getIAKeys } = bootstrapDatabase({ processarFilaAnalise });


// NFSE-M06 onda 6.43 (2026-04-20): wiring completo da autenticação
// (initAuthAndSession + rotas públicas + pre-auth + barrier +
// rotas protegidas + static protegido) consolidado em auth-pipeline.js.
const { installAuthPipeline } = require('./auth-pipeline');
const { apiKey } = installAuthPipeline(app, db);

// NFSE-M06 onda 6.36 (2026-04-20): ~55 registros de rotas protegidas
// (MonitorV2, Licitacoes, Sniper, NFSe, Cobrancas, Financeiro, suprimentos,
// fiscais, wiring do robô monitor-mensagens etc.) + wrappers enviarTelegram /
// enviarNotificacaoTelegram migraram para route-registry.js. Dependências
// passadas uma vez; a ordem interna de registro é preservada 1:1.
const { registerProtectedRoutes } = require('./route-registry');
registerProtectedRoutes(app, {
  db, dbPath, pncpSync, salvarItens, getConfigValue, setConfigValue, getIAKeys,
});


// NFSE-M06 onda 6.34 (2026-04-20): _logStartupBanner,
// _iniciarSchedulersMaster, _iniciarWorkerHttp e o dispatch de
// process.env.ROLE migraram para role-dispatch.js. O factory recebe
// todas as dependências (db, app, PORT, schedulers...) uma vez e expõe
// dispatch(role?) que roda o ramo correto. Produção: consulta-licitacoes
// (ROLE=worker) aterra aqui; liciteagora.service usa scheduler.js direto.
const { createRoleDispatch } = require('./role-dispatch');
createRoleDispatch({
  db, app, apiKey, dbPath, getConfigValue, pncpSync,
}).dispatch();
