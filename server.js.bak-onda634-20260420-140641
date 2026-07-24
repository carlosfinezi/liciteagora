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
const { registrarRotasUsuarios } = require('./usuarios-routes');
const { registrarRotasAuditoria } = require('./audit-log');
const { registrarRotasDevolucoes } = require('./devolucoes-routes');
const { registrarRotasCrm } = require('./crm-routes');
const { registrarRotasGerencial } = require('./gerencial-routes');
const { registrarRotasConciliacao } = require('./conciliacao-routes');
const { registrarRotasComissoes } = require('./comissoes-routes');
const { registrarRotasContratos } = require('./contratos-routes');
const { registrarRotasOS } = require('./os-routes');
const { registrarRotasComm } = require('./comm-routes');
const { registrarRotasMDFe } = require('./mdfe-routes');
const { registrarRotasRH } = require('./rh-routes');
const { registrarRotasPatrimonio } = require('./patrimonio-routes');
const { registrarRotasRoteirizacao } = require('./roteirizacao-routes');
const { registrarRotasCTe } = require('./cte-routes');
const { registrarRotasMarketplaces } = require('./marketplaces-routes');
const { registrarRotasTEF } = require('./tef-routes');
const { registrarRotasMonitorV2, inicializarMonitorV2, getMonitor } = require('./monitor-v2-routes');
const { registrarRotasLicitacoes } = require('./licitacoes-routes');
const { registrarRotasAuthPublicas, registrarRotasAuthProtegidas } = require('./auth-routes');
const { createMonitorMensagens } = require('./monitor-mensagens-core');
const { registrarRotasGovBr } = require('./govbr-routes');
const { registrarRotasMonitorMensagens } = require('./monitor-mensagens-routes');
const { registrarRotasSniper, getSniper, getPuppeteerSession } = require('./sniper-lance-routes');
const { registrarRotasNfse, iniciarReconciliadorS6 } = require('./nfse-routes');
const { registrarRotasFinanceiro, agendarPollingBoletos } = require('./financeiro-routes');
const { registrarRotasRecorrencia } = require('./recorrencia-routes');
const { registrarRotasProdutos } = require('./produtos-routes');
const { registrarRotasEstoque } = require('./estoque-routes');
const { registrarRotasLotes } = require('./lotes-routes');
const { registrarRotasSerial } = require('./serial-routes');
const { registrarRotasReservas } = require('./reservas-routes');
const { registrarRotasInventario } = require('./inventario-routes');
const { registrarRotasPedidosCompra } = require('./pedidos-compra-routes');
const { registrarRotasPedidos } = require('./pedidos-routes');
const { registrarRotasFaturas } = require('./faturas-routes');
const { registrarRotasContasFinanceiras } = require('./contas-financeiras-routes');
const { registrarRotasNfeEmit } = require('./nfe-emit-routes');
const { registrarRotasNfeEntrada } = require('./nfe-entrada-routes');
const { registrarRotasContasPagar } = require('./contas-pagar-routes');
const { registrarRotasContasReceber } = require('./contas-receber-routes');
const { registrarRotasFluxoCaixa } = require('./fluxo-caixa-routes');
const { registrarRotasFiscalSN } = require('./fiscal-sn-routes');
const { registrarRotasLivroCaixa } = require('./livro-caixa-routes');
const { registrarRotasFiscalArquivamento } = require('./fiscal-arquivamento-routes');
const { registrarRotasRetencoes } = require('./retencoes-routes');
const { registrarRotasDefis } = require('./defis-routes');
const { registrarRotasNFCe } = require('./nfce-routes');
const { registrarRotasImportacao } = require('./importacao-routes');
const { registrarRotasCFOPs } = require('./cfops-routes');
const { agendarRecorrencias } = require('./recorrencia-scheduler');
const { registrarRotasCobrancas } = require('./cobrancas-routes');
const { registrarRotasBi } = require('./bi-routes');
const { registrarRotasPropostasParticipacoes } = require('./propostas-participacoes-routes');
const { registrarRotasGruposPalavras } = require('./grupos-palavras-routes');
const { registrarRotasBackup } = require('./backup-routes');
const { registrarRotasAnaliseIa } = require('./analise-ia-routes');
const { registrarRotasJornal } = require('./jornal-routes');
const { registrarRotasCertificado } = require('./certificado-routes');
const { registrarRotasProxy } = require('./proxy-routes');
const { registrarRotasFornecedor } = require('./fornecedor-routes');
const { registrarRotasTelegram } = require('./telegram-routes');
const { registrarRotasLances } = require('./lances-routes');
const { registrarRotasCredenciais } = require('./credenciais-routes');
const { registrarRotasRobo } = require('./robo-routes');
const { registrarRotasTracking } = require('./tracking-routes');
const { registrarRotasProposta } = require('./proposta-routes');
const { registrarRotasSync } = require('./sync-routes');
const { registrarRotasPdf } = require('./pdf-routes');
const { registrarRotasAdmin } = require('./admin-routes');
const { registrarRotasChatLeitura } = require('./chat-leitura-routes');
const { registrarRotasExtensoes } = require('./extensoes-routes');
const { registrarRotasExtensaoChrome } = require('./extensao-chrome-routes');
const { registrarRotasChatMonitoramento } = require('./chat-monitoramento-routes');
const { registrarRotasChatMensagens } = require('./chat-mensagens-routes');
const { registrarRotasParticipacaoMonitoramento } = require('./participacao-monitoramento-routes');
const { agendarCobrancas } = require('./cobranca-scheduler');
const { agendarJornal } = require('./jornal-scheduler');
const { registrarRotasWhatsApp } = require('./whatsapp-adapter');
const comprasnetLoginRoutes = require('./comprasnet-login-routes');

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

// ==================== PORTAL DO CLIENTE (antes do auth) ====================
app.use('/portal', express.static(path.join(__dirname, 'public', 'portal')));
const { registrarRotasPortal, registrarRotasPortalAdmin } = require('./portal-routes');
registrarRotasPortal(app, db);

// ==================== DOWNLOAD PÚBLICO (antes do auth) ====================
app.get('/download/:file', (req, res) => {
  const allowed = ['LiciteAgora-Browser-win.zip'];
  if (!allowed.includes(req.params.file)) return res.status(404).end();
  const filePath = path.join(__dirname, 'electron-standalone', 'dist', req.params.file);
  if (!require('fs').existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
  res.download(filePath);
});

// ==================== COMPRASNET AUTO-LOGIN (Público - antes do auth) ====================
app.use('/api/comprasnet', comprasnetLoginRoutes);
// ==================== ELECTRON REMOTO (antes do auth) ====================
const { registrarRotasElectron } = require('./electron-routes');
registrarRotasElectron(app, db, { apiKey });

// Auth barrier — tudo abaixo requer autenticação (exceto webhook e X-Api-Key)
app.use(requireAuth(apiKey, db));

// NFSE-M06 onda 6.31 (2026-04-20): rotas protegidas (/api/change-password,
// /api/auth/api-key) migradas para auth-routes.js.
registrarRotasAuthProtegidas(app, db, { apiKey });


// Arquivos estáticos protegidos (APÓS rotas de API para que não intercepte)
app.use(express.static(path.join(__dirname, 'public')));

// NFSE-M06 onda 6.29 (2026-04-20): 5 rotas do catálogo PNCP migradas
// para licitacoes-routes.js (GET /api/licitacoes, /orgaos, detalhes,
// itens e POST sync-itens pontual).
registrarRotasLicitacoes(app, db, { pncpSync, salvarItens, PNCP_API_BASE, PNCP_API_ITENS });

// ==================== CERTIFICADO DIGITAL — extraído ====================
// NFSE-M06 onda 6.7 (2026-04-20): 3 rotas (status/save/delete) migradas
// para certificado-routes.js.

// ==================== TELEGRAM / ALERTAS ====================

// Função para enviar mensagem no Telegram (HTML)
// NFSE-M06 onda 5C: corpo extraído para telegram-client.js para que o
// scheduler.js (processo master sem Express) possa usar a mesma lógica
// sem require server.js. Callers aqui continuam chamando enviarTelegram(msg).
const { sendTelegram: _sendTelegramViaClient, sendNotificacao: _sendNotificacaoViaClient } = require('./telegram-client');
async function enviarTelegram(mensagem) {
  return _sendTelegramViaClient(db, mensagem);
}

// Função para enviar notificação formatada do chat de licitação
// NFSE-M06 onda 6.30 (2026-04-20): corpo migrado para telegram-client.js
// (sendNotificacao). Mantemos o wrapper local para não mexer no opts
// passado para registrarRotasExtensaoChrome.
async function enviarNotificacaoTelegram(dados) {
  return _sendNotificacaoViaClient(db, dados);
}

// ==================== ALERTA DISPUTA (Telegram 30 min antes) ====================
// NFSE-M06 onda 5C passo 2: verificarAlertasDisputa + timer (setInterval 5min
// e setTimeout 30s pós-boot) migraram para pncp-sync-scheduler.js. O master
// liga tudo via pncpSync.startMasterOnlyTimers(). No worker não roda — o gate
// ROLE=master que existia aqui desde a onda 5B deixa de ser necessário porque
// o módulo só dispara os timers quando o master explicitamente solicita.

// ==================== MONITOR V2 (API direta Comprasnet) ====================
registrarRotasMonitorV2(app, db, {
  enviarTelegram: enviarTelegram,
  getConfigValue: getConfigValue,
  intervaloMinutos: 3,
});

// ==================== SNIPER DE LANCES ====================
registrarRotasSniper(app, getMonitor, db);

// ==================== NFSE NACIONAL ====================
registrarRotasNfse(app, db);

// ==================== COBRANCAS + WHATSAPP ====================
registrarRotasCobrancas(app, db);
registrarRotasWhatsApp(app, db);

// ==================== FINANCEIRO (Pessoas, Contas a Receber, Boletos, MercadoPago) ====================
registrarRotasFinanceiro(app, db);

// ==================== RECORRENCIAS NFSE ====================
registrarRotasRecorrencia(app, db);

// ==================== SUPRIMENTOS (Produtos, Estoque, Pedidos) ====================
registrarRotasProdutos(app, db);
registrarRotasEstoque(app, db);
registrarRotasLotes(app, db);
registrarRotasSerial(app, db);
registrarRotasReservas(app, db);
registrarRotasInventario(app, db);
registrarRotasPedidosCompra(app, db);
registrarRotasPedidos(app, db);
registrarRotasContasFinanceiras(app, db);
registrarRotasFaturas(app, db);
registrarRotasNfeEmit(app, db);
registrarRotasNfeEntrada(app, db);
registrarRotasContasPagar(app, db);
registrarRotasContasReceber(app, db);
registrarRotasFluxoCaixa(app, db);
registrarRotasFiscalSN(app, db);
registrarRotasLivroCaixa(app, db);
registrarRotasFiscalArquivamento(app, db);
registrarRotasRetencoes(app, db);
registrarRotasDefis(app, db);
registrarRotasNFCe(app, db);
registrarRotasImportacao(app, db);
registrarRotasCFOPs(app, db);
registrarRotasUsuarios(app, db);
registrarRotasAuditoria(app, db);
registrarRotasDevolucoes(app, db);
registrarRotasCrm(app, db);
registrarRotasGerencial(app, db);
registrarRotasConciliacao(app, db);
registrarRotasComissoes(app, db);
registrarRotasContratos(app, db);
registrarRotasPortalAdmin(app, db);
registrarRotasOS(app, db);
registrarRotasComm(app, db);
registrarRotasMDFe(app, db);
registrarRotasRH(app, db);
registrarRotasPatrimonio(app, db);
registrarRotasRoteirizacao(app, db);
registrarRotasCTe(app, db);
registrarRotasMarketplaces(app, db);
registrarRotasTEF(app, db);
registrarRotasBi(app, db);
registrarRotasPropostasParticipacoes(app, db);
registrarRotasGruposPalavras(app, db);
registrarRotasBackup(app, db, { dbPath, PORT });
registrarRotasAnaliseIa(app, db, { getConfigValue, setConfigValue, getIAKeys });
registrarRotasJornal(app, db);
registrarRotasCertificado(app, db);
registrarRotasProxy(app, db);
registrarRotasFornecedor(app, db);
registrarRotasTelegram(app, db, { enviarTelegram });
registrarRotasLances(app, db, { enviarTelegram });
registrarRotasCredenciais(app, db);
registrarRotasRobo(app, db);
registrarRotasTracking(app, db);
registrarRotasProposta(app, db);
registrarRotasSync(app, db, { pncpSync });
registrarRotasPdf(app, db);
registrarRotasAdmin(app, db, { getConfigValue, setConfigValue });
registrarRotasChatLeitura(app, db);
registrarRotasExtensoes(app, { getConfigValue });
// ==================== ROBÔ DE MONITORAMENTO DE MENSAGENS + CREDENCIAIS GOV.BR ====================
// NFSE-M06 onda 6.28 (2026-04-20): consolidação.
//  - classes MonitorMensagensComprasnet + MonitorChat vêm de monitor-mensagens-core.js (6.26)
//  - 4 rotas do robô (/iniciar, /parar, /status, /ativos) em monitor-mensagens-routes.js (6.27)
//  - 3 rotas gov.br (/api/govbr/*) + estado monitorMensagens em govbr-routes.js (6.28)
//  - extensao-chrome usa getMonitor exposto por govbr-routes
const { MonitorMensagensComprasnet, MonitorChat } = createMonitorMensagens({
  db, getConfigValue, enviarTelegram
});
const govbrApi = registrarRotasGovBr(app, db, { getConfigValue, setConfigValue, MonitorMensagensComprasnet });
registrarRotasMonitorMensagens(app, db, { MonitorChat });

registrarRotasExtensaoChrome(app, db, { getConfigValue, enviarNotificacaoTelegram, getMonitor: govbrApi.getMonitor });
registrarRotasChatMonitoramento(app, db);
registrarRotasChatMensagens(app, db);
registrarRotasParticipacaoMonitoramento(app, db, { enviarTelegram });


// NFSE-M06 onda 5C passo 2: o verificador de lacunas (verificarECorrigirLacunas
// e verificacaoCompletaDiaria) agora é criado dentro de pncp-sync-scheduler.js
// no init — ele era o único consumidor destas funções em server.js. A terceira
// função retornada (corrigirItensFaltantes) era desde sempre dead code aqui.
// A verificação diária às 03:00 + o watchdog de sync pararem de rodar no
// worker vieram da onda 5B; 5C apenas move a implementação para o módulo.

// PROPOSTAS (v1 /api/proposta/enviar + v2 via participações)
// Extraído em NFSE-M06 onda 6.2 para propostas-participacoes-routes.js.
// Factory registrado no topo junto a registrarRotasBi / registrarRotasTEF.


// GRUPOS DE PALAVRAS-CHAVE (pesquisa/exclusão) + rota /pesquisar
// Extraído em NFSE-M06 onda 6.3 para grupos-palavras-routes.js.
// Factory registrado no topo junto a registrarRotasPropostasParticipacoes.


// ==================== JORNAL DE LICITAÇÕES — extraído ====================
// NFSE-M06 onda 6.6 (2026-04-20): 5 rotas migradas para jornal-routes.js.
// agendarJornal() continua chamado pelo master via _iniciarSchedulersMaster.


// SISTEMA DE BACKUP E VERSIONAMENTO (backup SQLite + git tags)
// Extraído em NFSE-M06 onda 6.4 para backup-routes.js.
// Factory registrado no topo junto a registrarRotasGruposPalavras.

// ==================== ANÁLISE IA (rotas) — extraído ====================
// NFSE-M06 onda 6.5 (2026-04-20): 7 rotas migradas para analise-ia-routes.js.
// Factory registrarRotasAnaliseIa chamada no topo junto aos outros módulos.

// BI — registrado via bi-routes.js (NFSE-M06 onda 6.1, 2026-04-20).
// Bloco de ~291 linhas com 6 rotas (pesquisa local, resultados PNCP,
// Dados Abertos, pesquisa de preço) migrado para módulo dedicado.

// ─── ROTAS DE ANÁLISE IA (Bloco B) — extraído ──────────────────────────────
// NFSE-M06 onda 6.5 (2026-04-20): 6 rotas migradas para analise-ia-routes.js,
// registradas após o Bloco A (mesma ordem original) para preservar quem
// vence em /api/analise/stats e quem responde aos endpoints com ordem de
// parâmetros :cnpj/:sequencial/:ano.

// NFSE-M06 (2026-04-20): cada systemd unit tinha sua própria corrida para bindar
// :3000 dentro de app.listen(). Só quem ganhava o bind chegava a executar o
// callback — e com isso, os schedulers dependiam da sorte do EADDRINUSE. Agora:
//  - master NÃO escuta HTTP: roda apenas schedulers (sync PNCP, jornal,
//    recorrências, cobranças, polling boletos). Libera ~180MB de RSS ocioso.
//  - worker escuta :3000 normalmente e não agenda nada.
// Benefício colateral: pronto para multi-tenant (um master por instalação,
// vários workers horizontal-scale) sem re-arranjar o código.
function _logStartupBanner(role) {
  const stats = {
    licitacoes: db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count,
    itens: db.prepare('SELECT COUNT(*) as count FROM itens').get().count
  };
  console.log(`[${role}] Banco de dados: ${dbPath}`);
  console.log(`[${role}] API do PNCP: ${PNCP_API_BASE}`);
  console.log(`[${role}] API Key extensão: ${apiKey}`);
  console.log(`[${role}] Dados no banco: ${stats.licitacoes} licitações, ${stats.itens} itens`);
  const lastSyncDate = getConfigValue('lastSyncDate');
  if (lastSyncDate) {
    console.log(`[${role}] Última sincronização: ${lastSyncDate}`);
  }
  return stats;
}

function _iniciarSchedulersMaster() {
  _logStartupBanner('master');
  console.log('[master] ROLE=master — schedulers-only (NÃO escuta HTTP)');

  // NFSE-M06 onda 5C passo 2: motor PNCP + 3 timers master-only (watchdog,
  // disputa-alert, verificação diária de lacunas) vivem em
  // pncp-sync-scheduler.js. Na onda 5C passo 4 o entrypoint vira
  // scheduler.js (sem Express) chamando essas mesmas funções.
  pncpSync.iniciarSyncEngine();
  pncpSync.startMasterOnlyTimers();

  // Jornal de Licitações
  agendarJornal(db);
  // Recorrências NFSe
  agendarRecorrencias(db);
  // Cobranças (régua diária)
  agendarCobrancas(db);
  // Polling boletos MercadoPago (a cada 30 min)
  agendarPollingBoletos(db);
  // NFSE-M06: Reconciliador S6 NFSe — decouplado de registrarRotasNfse.
  // Chamada explícita aqui para que o scheduler.js possa chamar o mesmo
  // helper sem precisar montar Express app.
  iniciarReconciliadorS6(db);
}

function _iniciarWorkerHttp() {
  app.listen(PORT, () => {
    _logStartupBanner('worker');
    console.log(`[worker] Servidor rodando em http://localhost:${PORT}`);
    console.log('[worker] Endpoints disponíveis:');
    console.log(`  GET  http://localhost:${PORT}/api/licitacoes`);
    console.log(`  GET  http://localhost:${PORT}/api/licitacoes/:cnpj/:sequencial/:ano`);
    console.log(`  GET  http://localhost:${PORT}/api/orgaos`);
    console.log(`  GET  http://localhost:${PORT}/api/sync/status`);
    console.log(`  POST http://localhost:${PORT}/api/sync/start        (auto: incremental ou completa)`);
    console.log(`  POST http://localhost:${PORT}/api/sync/full         (força sync completa)`);
    console.log(`  POST http://localhost:${PORT}/api/sync/incremental  (força sync incremental)`);
    console.log('[worker] ROLE=worker — HTTP-only (nenhum scheduler rodando aqui)');
  }).on('error', (err) => {
    // Quando o worker perde a corrida do bind, queremos log explícito
    // ao invés de stacktrace cru no uncaughtException.
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[worker] FATAL EADDRINUSE :${PORT} — outro processo já escuta. Abortando.`);
    } else {
      console.error('[worker] FATAL erro no listen:', err);
    }
    process.exit(1);
  });
}

const _SERVER_ROLE = process.env.ROLE || 'master';
if (_SERVER_ROLE === 'master') {
  _iniciarSchedulersMaster();
} else {
  _iniciarWorkerHttp();
}
