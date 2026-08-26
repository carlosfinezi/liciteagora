const express = require('express');

const app = express();

// Multi-tenant (2026-04-22): confia no proxy nginx para identificar HTTPS
// via X-Forwarded-Proto. Sem isso, cookie.secure=true faz Express recusar
// setar Set-Cookie (Node não vê TLS direto, só o loopback HTTP do proxy).
app.set('trust proxy', 1);


// NFSE-M06 onda 6.39 (2026-04-20): middleware base (CORS allow-list +
// body parsers + static da login page) extraido para base-middleware.js.
const { applyBaseMiddleware } = require('./base-middleware');
applyBaseMiddleware(app);


// Módulo de análise IA
const { processarFilaAnalise } = require('./analise-ia');


// Multi-tenant (2026-04-22): quando MULTI_TENANT=true, o worker roda
// em modo multi-tenant — tenant-bootstrap cria control.db + pool +
// middleware que resolve tenant por subdomínio. Cada request carrega
// req.tenant/req.tenantDb e o `db` global é um Proxy que delega via
// AsyncLocalStorage.
//
// Default FALSE (legado single-tenant) enquanto a Fase 2c ainda não
// estiver concluída: 5 módulos (portal-routes, contas-receber-routes,
// pedidos-routes, produtos-routes, sniper-lance-routes) ainda fazem
// db.exec/db.prepare em escopo de registro, o que quebra o boot
// sem contexto de tenant. Feito isso, trocar default para 'true'.
const MULTI_TENANT = process.env.MULTI_TENANT === 'true';

let db, dbPath, salvarItens, pncpSync, getConfigValue, setConfigValue, getIAKeys;
let tenantManager = null;
let controlDb = null;

if (MULTI_TENANT) {
  const { bootstrapTenantAware } = require('./tenant-bootstrap');
  const ctx = bootstrapTenantAware({ processarFilaAnalise });
  db = ctx.db;
  dbPath = ctx.dbPath;
  salvarItens = ctx.salvarItens;
  pncpSync = ctx.pncpSync;
  getConfigValue = ctx.getConfigValue;
  setConfigValue = ctx.setConfigValue;
  getIAKeys = ctx.getIAKeys;
  tenantManager = ctx.manager;
  controlDb = ctx.manager.controlDb;

  // Middleware tenant-aware ANTES de qualquer coisa que acesse o db.
  // Rotas de landing (apex) e control-plane (admin) serão instaladas
  // no ramo `allowWithoutTenant` via checagem de req.tenantCtx.kind.
  app.use(ctx.middleware);

  // Feature-gate por modulo (Fase 2B) — DESATIVADO em 2026-05-21 apos 2
  // tentativas causarem travamento prolongado. Causa raiz nao identificada
  // (talvez interacao com sync PNCP pesado). Tabelas plan_modules e
  // tenant_module_overrides continuam populadas — Fase 1 entregue.
  // const { createModuleGate } = require('./module-gate');
  // app.use(createModuleGate(ctx.manager));
} else {
  const { bootstrapDatabase } = require('./db-bootstrap');
  const ctx = bootstrapDatabase({ processarFilaAnalise });
  db = ctx.db;
  dbPath = ctx.dbPath;
  salvarItens = ctx.salvarItens;
  pncpSync = ctx.pncpSync;
  getConfigValue = ctx.getConfigValue;
  setConfigValue = ctx.setConfigValue;
  getIAKeys = ctx.getIAKeys;
}


// dataEncerramentoPortal: prazo remarcado pelo portal de origem (PCP) quando o
// órgão altera o edital sem republicar no PNCP — ver pcp-monitor/reconciliarDatasPcp.
// Toda leitura de prazo virou COALESCE(portal, pncp), então a coluna precisa
// existir antes das rotas subirem. Idempotente; o catálogo PG não tem migrador.
require('./catalog-pg')
  .execute('ALTER TABLE licitacoes ADD COLUMN IF NOT EXISTS "dataEncerramentoPortal" timestamptz')
  .catch((e) => console.error('[catalog] ensure dataEncerramentoPortal:', e.message));

// NFSE-M06 onda 6.43 (2026-04-20): wiring completo da autenticação
// consolidado em auth-pipeline.js. Multi-tenant: passa controlDb
// (fonte do session_secret único). Em multi-tenant o registro de rotas
// roda dentro de runInBootContext → o DB proxy vira no-op para todas
// as chamadas de migração/seed (já aplicadas por db-schema.js em cada
// tenant). Em runtime, dentro de um request, o proxy resolve normal.
const { installAuthPipeline } = require('./auth-pipeline');
const { registerProtectedRoutes } = require('./route-registry');

let apiKey;
function installPipeline() {
  const pipelineResult = installAuthPipeline(app, db, { controlDb, tenantManager });
  apiKey = pipelineResult.apiKey;
  registerProtectedRoutes(app, {
    db, dbPath, pncpSync, salvarItens, getConfigValue, setConfigValue, getIAKeys,
  });
}

if (MULTI_TENANT) {
  const { runInBootContext } = require('./tenant-middleware');

  // ML Fase 0: rota GLOBAL do callback OAuth (apex, pública). Registrada ANTES do
  // installPipeline de propósito — o landing instala um catch-all SPA (serve index.html
  // pra qualquer path no apex) dentro do installPipeline; registrar aqui garante que o
  // /callback vem na frente. Resolve o tenant pelo state e grava os tokens no DB dele.
  try { require('./marketplaces-ml').registrarRotasGlobal(app, { tenantManager }); } catch (e) { console.error('[ML callback global]', e.message); }

  // Webhook público do WhatsApp (Evolution -> inbox por tenant). Antes da barreira de
  // auth, como o callback ML acima. Path liberado no bypass do tenant-middleware.
  try { require('./whatsapp-webhook').registrarRotaWebhook(app, { tenantManager }); } catch (e) { console.error('[whatsapp webhook]', e.message); }
  try { require('./wa-scheduler').iniciarScheduler(tenantManager); } catch (e) { console.error('[wa-scheduler]', e.message); }

  runInBootContext(installPipeline);

  // Força criação da instância SniperLance por tenant 3s após o boot.
  // Sem isso, `_iniciarAgendamentoTenant` (que recupera blitzes agendadas,
  // liga auto-lance, etc.) só dispara no primeiro request tenant-scoped —
  // e agendamentos persistidos podem perder o momento do disparo.
  const { tenantStorage } = require('./tenant-middleware');
  const { getSniper } = require('./sniper-lance-routes');
  // Modo emergencial 2026-05-23: SKIP_TENANT_BOOT=1 pula a inicialização
  // pré-emptiva dos tenants. Cada tenant fica lazy (cria sniper só na 1ª request).
  if (process.env.SKIP_TENANT_BOOT === '1') {
    console.log('[worker] SKIP_TENANT_BOOT=1 — inicialização pré-emptiva de tenants pulada');
  } else
  setTimeout(() => {
    try {
      const tenants = tenantManager.listAll();
      const { ensureScheduleForTenant } = require('./sc-scheduler');
      const { createConfigHelpers } = require('./config-helpers');
      const { iniciarSchedulerAnaliseIa } = require('./analise-ia-scheduler');
      for (const t of tenants) {
        try {
          const tdb = tenantManager.getDb(t.slug);
          // Schema de cobranças/boletos (tabela `boletos` + colunas provedor/pix/etc.) é
          // dono do boleto-orchestrator, não do db-schema. migrarSchema no registro roda
          // contra o proxy (no-op fora de contexto) → aplicamos por-tenant aqui (idempotente).
          try { require('./boleto-orchestrator').migrarSchema(tdb); } catch (e) { console.error(`[boleto migrar ${t.slug}] ${e.message}`); }
          // Schema espelho da devolução de compra (mesmo motivo: migrarSchema no registro roda
          // contra o proxy). Aplicado por-tenant aqui, idempotente.
          try { require('./devolucao-compra').migrarSchema(tdb); } catch (e) { console.error(`[devolucao-compra migrar ${t.slug}] ${e.message}`); }
          // Espelho da devolução de VENDA: vínculo fatura↔devolução (faturaOrigemId,
          // faturaItemOrigemId) em faturas/fatura_itens e no RMA. Mesmo motivo do de cima.
          try { require('./devolucao-venda').migrarSchema(tdb); } catch (e) { console.error(`[devolucao-venda migrar ${t.slug}] ${e.message}`); }
          // ML Fase 0: colunas de token (cifrado) em marketplaces_integracoes. Idempotente.
          try { require('./marketplaces-ml').migrarSchemaTenant(tdb); } catch (e) { console.error(`[ml migrar ${t.slug}] ${e.message}`); }
          tenantStorage.run({ kind: 'tenant', tenant: t, db: tdb }, () => {
            // Acesso a qualquer propriedade do Proxy força _getSniperForContext,
            // que cria a instância e chama _iniciarAgendamentoTenant (recovery + auto-lance).
            void getSniper().autoLanceLog;
          });
          // Boot do scheduler do robô SC. Idempotente — se o tenant não tem
          // credenciais sc_*, o tick sai sem fazer nada (mas continua agendado
          // para o caso de credenciais serem cadastradas no futuro).
          ensureScheduleForTenant(t, tdb);
          // Scheduler diário de análise IA por grupo de palavras (6h da manhã).
          // No-op se nenhum grupo do tenant tem agendamento ativo.
          const helpers = createConfigHelpers(tdb);
          iniciarSchedulerAnaliseIa(tdb, helpers.getIAKeys);
          // Scheduler de disputa BNC — instancia 1 engine SignalR por sala
          // ativa em bnc_salas. Idempotente (no-op se tenant não tem sala).
          require('./bnc-dispute-scheduler').ensureSchedulerForTenant(t, tdb);
          // Scheduler de disputa BLL (Fase 3) — idem para bll_salas. dryRun
          // default; no-op se tenant não tem sala BLL cadastrada.
          require('./bll-dispute-scheduler').ensureSchedulerForTenant(t, tdb);
        } catch (e) { console.error(`[Sniper boot ${t.slug}] ${e.message}`); }
      }
    } catch (e) { console.error(`[Sniper boot global] ${e.message}`); }
  }, 3000);

  // ML Fase 0: refresh de token a cada 30min. refreshVencendo só age se faltar <1h pro
  // access token (6h) vencer, e é no-op se o tenant não conectou o Mercado Livre.
  setInterval(() => {
    try {
      const ml = require('./marketplaces-ml');
      for (const t of tenantManager.listAll()) {
        try {
          const tdb = tenantManager.getDb(t.slug);
          ml.refreshVencendo(tdb).catch(() => {});
          ml.pushEstoqueML(tdb, () => {}).catch(() => {}); // gated: no-op se sincronizarEstoque=0
        } catch {}
      }
    } catch {}
  }, 30 * 60 * 1000);
} else {
  installPipeline();
}


// NFSE-M06 onda 6.34 (2026-04-20): dispatch de process.env.ROLE
// em role-dispatch.js. Produção: consulta-licitacoes (ROLE=worker)
// aterra aqui; liciteagora.service (ROLE=master) usa scheduler.js
// direto, que ainda é single-tenant até a Fase 5.
const { createRoleDispatch } = require('./role-dispatch');
createRoleDispatch({
  db, app, apiKey, dbPath, getConfigValue, pncpSync,
}).dispatch();
