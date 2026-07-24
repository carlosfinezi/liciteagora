const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
// NFSE-M06 onda 5C: criarVerificador só era usado pelo motor PNCP; agora é
// instanciado internamente em pncp-sync-scheduler.js. Removido daqui.
const crypto = require('crypto');
const session = require('express-session');
const { createSessionStore, criarUsuarioInicial, getSessionSecret, getApiKey, requireAuth } = require('./auth');
const { registrarRotasAuthPublicas, registrarRotasAuthProtegidas } = require('./auth-routes');
const { iniciarReconciliadorS6 } = require('./nfse-routes');
const { agendarPollingBoletos } = require('./financeiro-routes');
const { agendarRecorrencias } = require('./recorrencia-scheduler');
const { agendarCobrancas } = require('./cobranca-scheduler');
const { agendarJornal } = require('./jornal-scheduler');

const app = express();

const PORT = 3000;

// Middleware
// SEC-05 (2026-04-18): CORS com origem explícita e body limit sensato.
// Chrome extension (chrome-extension://*) continua permitida; Electron e servidor
// interno usam apiKey e não passam pelo navegador.
const _corsAllow = (origin, cb) => {
  if (!origin) return cb(null, true); // curl, Electron, scripts — sem Origin
  if (/^chrome-extension:\/\//.test(origin)) return cb(null, true);
  if (/(^https?:\/\/localhost(:\d+)?$)/.test(origin)) return cb(null, true);
  if (/^https?:\/\/(app\.)?liciteagora\.com\.br(:\d+)?$/.test(origin)) return cb(null, true);
  if (/^https?:\/\/server\.votoaqui\.com\.br(:\d+)?$/.test(origin)) return cb(null, true);
  // Origem desconhecida: NÃO envia headers CORS — navegador bloqueia naturalmente,
  // clientes sem Origin (curl/Electron) não são afetados. Evita 500 visível.
  return cb(null, false);
};
app.use(cors({ origin: _corsAllow, credentials: true }));
// Limite geral 10MB (antes 50mb); rotas de upload de XML/PFX usam esta faixa. Multer
// nos uploads multipart tem limites próprios.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Login page (público, antes do auth)
app.use(express.static(path.join(__dirname, 'public', 'auth')));

// Configuração da API do PNCP
const PNCP_API_BASE = 'https://pncp.gov.br/api/consulta/v1';
const PNCP_API_ITENS = 'https://pncp.gov.br/api/pncp/v1';

// Módulo de análise IA
const { analisarLicitacao, processarFilaAnalise } = require('./analise-ia');

// Banco de dados SQLite
const dbPath = path.join(__dirname, 'pncp.db');

const db = new Database(dbPath);

// Criar tabelas
// NFSE-M06 onda 6.33 (2026-04-20): schema SQL (~35 CREATE TABLE + índices +
// seed jornal_config) e as 4 migrações ad-hoc (grupos_palavras.tipo +
// chat_mensagens.lido aninhado, colunas v1 de chat_mensagens, colunas de
// config do sniper_itens) migraram para db-schema.js. initSchema(db) é
// idempotente — pode ser chamado em qualquer ordem relativa ao restante
// do bootstrap desde que `db` já esteja aberto.
const { initSchema } = require('./db-schema');
initSchema(db);

// NFSE-M06 onda 5C: persistência de licitacao/itens extraída para
// licitacoes-persistence.js (consumida pelo motor PNCP no
// pncp-sync-scheduler.js, pela rota POST /sync-itens aqui, e pelo
// verificador de lacunas). Statements ficam no módulo, factory prepara
// uma vez por processo.
const { createPersistence } = require('./licitacoes-persistence');
const { salvarLicitacao, salvarItens } = createPersistence(db);

// NFSE-M06 onda 5C passo 2 (2026-04-20): motor PNCP + schedulers master-only
// (sincronizarCompleta/Incremental, watchdog, alertas de disputa, verificação
// diária de lacunas) extraídos para pncp-sync-scheduler.js.
// No master (scheduler.js na onda 5C passo 4) chama-se iniciarSyncEngine()
// + startMasterOnlyTimers(). No worker o módulo é carregado apenas para
// atender GET /api/sync/status via pncpSync.getSyncStatus() e as rotas
// POST /api/sync/* respondem 503 — sync manual tem que sair do master.
const pncpSync = require('./pncp-sync-scheduler');
pncpSync.init({ db, processarFilaAnalise });

// NFSE-M06 onda 6.32 (2026-04-20): getConfigValue / setConfigValue /
// getIAKeys migraram para config-helpers.js. Os prepared statements
// getConfig / setConfig ficam escondidos na closure da factory.
const { createConfigHelpers } = require('./config-helpers');
const { getConfigValue, setConfigValue, getIAKeys } = createConfigHelpers(db);

// NFSE-M06 onda 5C passo 2 (2026-04-20): gerarDiasEntre, buscarLicitacoesDoDia,
// buscarItensLicitacao, getIAKeys, dispararAnaliseIA, sincronizarCompleta,
// sincronizarIncremental, agendarProximaSync e iniciarWatchdogSync foram
// integralmente movidos para pncp-sync-scheduler.js. Consulte aquele módulo.


// ==================== AUTENTICAÇÃO ====================
criarUsuarioInicial(db);
const sessionSecret = getSessionSecret(db);
const apiKey = getApiKey(db);

// Session middleware (antes de tudo que precisa de sessão)
app.use(session({
  store: createSessionStore(session, db),
  secret: sessionSecret,
  name: 'liciteagora.sid',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: false }
}));


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

// Auth barrier — tudo abaixo requer autenticação (exceto webhook e X-Api-Key)
app.use(requireAuth(apiKey, db));

// NFSE-M06 onda 6.31 (2026-04-20): rotas protegidas (/api/change-password,
// /api/auth/api-key) migradas para auth-routes.js.
registrarRotasAuthProtegidas(app, db, { apiKey });


// Arquivos estáticos protegidos (APÓS rotas de API para que não intercepte)
app.use(express.static(path.join(__dirname, 'public')));

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
  db, app, PORT, apiKey, dbPath, PNCP_API_BASE, getConfigValue,
  pncpSync, agendarJornal, agendarRecorrencias, agendarCobrancas,
  agendarPollingBoletos, iniciarReconciliadorS6,
}).dispatch();
