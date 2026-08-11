// scheduler.js
//
// Entrypoint master-only do LiciteAgora. Fase 8 (2026-04-22):
// sync PNCP deixou de iterar tenants e roda 1x contra catalog.db
// (catálogo compartilhado). Os demais jobs (jornal, cobrança,
// recorrência, polling boletos, reconciliador S6) continuam
// iterando tenants ACTIVE/TRIAL porque são operações específicas
// de cada empresa.
//
// systemd unit: liciteagora.service (ROLE=master). NÃO escuta HTTP.

const { initCatalogDb, CATALOG_DB_PATH } = require('./catalog-manager');
const { createTenantManager } = require('./tenant-manager');
const { initSchema } = require('./db-schema');
const { tenantStorage } = require('./tenant-middleware');
const { processarFilaAnalise } = require('./analise-ia');

const pncpSync = require('./pncp-sync-scheduler');
const resultadosBackfill = require('./resultados-backfill');
const marcaBackfill = require('./marca-backfill');
const marcaPortalBackfill = require('./marca-portal-backfill');
const ftsBackfill = require('./fts-backfill');
const { agendarRecorrencias } = require('./recorrencia-scheduler');
const { agendarCobrancas } = require('./cobranca-scheduler');
const { agendarPollingBoletos } = require('./financeiro-routes');
const { agendarPollingBoletosAsaas } = require('./boleto-orchestrator');
const { iniciarReconciliadorS6 } = require('./nfse-routes');
const { sincronizarInboxNfe } = require('./nfe-entrada-routes');
const { sendTelegram } = require('./telegram-client');
const { agendarPcpMonitor } = require('./pcp-monitor');
const { agendarResolverSalas: agendarResolverSalasBNC } = require('./bnc-sala-resolver');
const { agendarAlertasDisputa } = require('./alertas-disputa-vigilancia');

// Catálogo global — master é o ÚNICO escritor de licitações/itens/etc.
const catalogDb = initCatalogDb(CATALOG_DB_PATH);

// Tenant-manager — usado apenas para iterar tenants nos jobs
// per-tenant (jornal, cobrança, etc.).
const mgr = createTenantManager({ initSchema });

// pncpSync.init com o catalog.db — todos os métodos internos
// (sincronizarIncremental, getConfigValue, salvarLicitacao) escrevem/
// leem direto no catálogo.
pncpSync.init({ db: catalogDb, processarFilaAnalise });

// Plano 10: backfill de resultados_bi (executa em background)
resultadosBackfill.init({ db: catalogDb });

// Onda 3 (2026-05): backfill heurístico de marca em catalog.itens
marcaBackfill.init({ db: catalogDb });
marcaPortalBackfill.init({ db: catalogDb });

// Onda 3 perf (2026-05): backfill do FTS5 itens_fts
ftsBackfill.init({ db: catalogDb });

// ==================== INTROSPECÇÃO ====================

function _listTenantsSafe() {
  try { return mgr.listActive(); }
  catch (err) {
    console.error('[master] falha listando tenants:', err.message);
    return [];
  }
}

// ==================== BOOT BANNER ====================

function _startupBanner() {
  const tenants = _listTenantsSafe();
  console.log('[master] ROLE=master — schedulers-only (NÃO escuta HTTP)');
  console.log(`[master] catalog.db: ${CATALOG_DB_PATH}`);
  try {
    const c = catalogDb.prepare('SELECT COUNT(*) c FROM licitacoes').get().c;
    const i = catalogDb.prepare('SELECT COUNT(*) c FROM itens').get().c;
    const lastSync = pncpSync.getConfigValue ? pncpSync.getConfigValue('lastIncrementalSync') : null;
    console.log(`[master] catálogo: ${c} licitações, ${i} itens, último sync: ${lastSync || 'nunca'}`);
  } catch (err) {
    console.warn(`[master] catálogo ainda sem schema (esperado na 1ª execução pós-migração): ${err.message}`);
  }
  console.log(`[master] tenants ativos: ${tenants.length}`);
  for (const t of tenants) console.log(`  - ${t.slug} (${t.status}) — ${t.name}`);
}

// ==================== SYNC DO CATÁLOGO (1x, não itera tenants) ====================

function ligarSyncPNCP() {
  // iniciarSyncEngine agenda o próprio setTimeout recursivo (a cada 5 min).
  // startMasterOnlyTimers liga watchdog + disputa + verificação diária.
  // Ambos operam SOBRE O CATÁLOGO, sem tenant context.
  pncpSync.iniciarSyncEngine();
  pncpSync.startMasterOnlyTimers();
  console.log('[master] sync PNCP ativo (catalog.db — 1 ciclo compartilhado)');

  // Retoma sync retroativo (720d ou similar) se checkpoint salvo está com
  // status='rodando' — quer dizer que um job estava ativo quando o serviço
  // morreu. Roda em paralelo ao sync incremental normal sem conflito
  // (sincronizarCompleta checa isRunning() e enfileira).
  try {
    if (pncpSync.retomarSyncRetroativoSeAplicavel()) {
      console.log('[master] sync retroativo retomado do checkpoint');
    }
  } catch (e) {
    console.error('[master] falha ao retomar sync retroativo:', e && e.message);
  }

  // WAL checkpoint automático a cada 5min: durante sync retroativo paralelo
  // o WAL cresce rápido (~400-600MB em 1h). Sem checkpoint, o file inflado
  // pressiona page cache do worker que serve HTTP, causando lentidão nas
  // queries. PASSIVE não bloqueia writes — só descarrega o que já está
  // commitado pro main DB.
  setInterval(() => {
    try {
      const r = catalogDb.pragma('wal_checkpoint(PASSIVE)');
      const row = Array.isArray(r) ? r[0] : r;
      if (row && row.checkpointed > 1000) {
        console.log(`[master] WAL checkpoint PASSIVE: ${row.checkpointed}/${row.log} pages (busy=${row.busy})`);
      }
    } catch (e) {
      console.warn('[master] WAL checkpoint falhou:', e && e.message);
    }
  }, 5 * 60 * 1000);
  console.log('[master] WAL checkpoint automático ativo (5min)');
}

// Plano 10: backfill em background de resultados_bi (PNCP resultados homologados).
// Roda 1 lote (10 itens) por minuto; autoajusta janela (últimos 365d → histórico).
function ligarBackfillResultados() {
  resultadosBackfill.iniciarBackfillEngine();
}

// Onda 3: extração heurística de marca em itens.descricao (CPU-bound, sem I/O).
function ligarBackfillMarca() {
  marcaBackfill.iniciarBackfillEngine();
}

// Marca do vencedor via PORTAL DE ORIGEM (BLL/BNC): relatório público
// "Vencedores do Processo" (PDF). Preenche resultados_bi.marcaFabricante que o
// PNCP não fornece. Rede (portais privados) — poucos processos/min.
function ligarBackfillMarcaPortal() {
  marcaPortalBackfill.iniciarBackfillEngine();
}

// Onda 3 perf: backfill do FTS5 (busca rápida por palavra). Cursor por id ASC.
function ligarBackfillFts() {
  ftsBackfill.iniciarBackfillEngine();
}

// ==================== JOBS POR TENANT ====================

function ligarJobsPorTenant() {
  const tenants = _listTenantsSafe();
  console.log(`[master] ligando jobs recorrentes por tenant para ${tenants.length} tenant(s)`);
  for (const t of tenants) {
    let db;
    try { db = mgr.getDb(t.slug); }
    catch (err) { console.error(`[master][${t.slug}] skip jobs: ${err.message}`); continue; }

    // Executa dentro do storage do tenant — os módulos de job usam
    // o DB direto recebido; o storage é garantia extra para handlers
    // internos que porventura consultem currentDb().
    tenantStorage.run({ kind: 'tenant', tenant: t, db }, () => {
      // Jornal de Licitações removido (2026-08-02): a descoberta por IA
      // varre os mesmos grupos e usa os mesmos canais.
      try { agendarRecorrencias(db); } catch (err) { console.error(`[master][${t.slug}] recorrencias:`, err.message); }
      try { agendarCobrancas(db); } catch (err) { console.error(`[master][${t.slug}] cobrancas:`, err.message); }
      try { agendarPollingBoletos(db); } catch (err) { console.error(`[master][${t.slug}] boletos:`, err.message); }
      try { agendarPollingBoletosAsaas(db); } catch (err) { console.error(`[master][${t.slug}] boletos-asaas:`, err.message); }
      try { iniciarReconciliadorS6(db); } catch (err) { console.error(`[master][${t.slug}] nfse-s6:`, err.message); }
      try { agendarPcpMonitor(db); } catch (err) { console.error(`[master][${t.slug}] pcp-monitor:`, err.message); }
      try { agendarResolverSalasBNC(db, t); } catch (err) { console.error(`[master][${t.slug}] bnc-resolver:`, err.message); }
      try { agendarAlertasDisputa(db, t); } catch (err) { console.error(`[master][${t.slug}] vigia-disputa:`, err.message); }
    });
  }
}

// ==================== SYNC DIÁRIO: Participações → Funil CRM ====================
//
// A cada 6h percorre os tenants e propaga resultados de resultados_bi (que é
// alimentado pelo backfill do PNCP) para o funil CRM "Licitações": move cards
// para Ganha/Perdida conforme niFornecedor bateu com CNPJ do fornecedor.
// Idempotente — pula quando a etapa já está correta.
const SYNC_FUNIL_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function cicloSincronizarFunilParticipacoes() {
  const { sincronizarParticipacoesFunil } = require('./sniper-lance-routes');
  const tenants = _listTenantsSafe();
  for (const t of tenants) {
    let db;
    try { db = mgr.getDb(t.slug); }
    catch (_) { continue; }
    try {
      await tenantStorage.run({ kind: 'tenant', tenant: t, db }, async () => {
        const stats = await sincronizarParticipacoesFunil(db);
        if (stats.movidas + stats.criadas > 0) {
          console.log(`[master][${t.slug}] sync-funil: candidatas=${stats.candidatas} movidas=${stats.movidas} criadas=${stats.criadas} semAlteracao=${stats.semAlteracao} erros=${stats.erros}`);
        }
      });
    } catch (err) {
      // Alguns tenants podem não ter fornecedor/CNPJ cadastrado — ok, ignorar
      if (!err.message.includes('CNPJ do fornecedor')) {
        console.error(`[master][${t.slug}] sync-funil erro:`, err.message);
      }
    }
  }
}

// ==================== RETRY 1x/DIA DE __sem_resultado__ DAS PARTICIPAÇÕES ====================
//
// O backfill principal grava `__sem_resultado__` quando o PNCP ainda não
// publicou. Por causa do LEFT JOIN do seletor, o item nunca mais é
// reconsultado — isso fazia participações homologadas DEPOIS do primeiro
// fetch ficarem congeladas como "Pendente".
//
// Esta rotina varre 1x/dia (24h) só os itens das participações ATIVAS
// do tenant que ainda estão `__sem_resultado__`, e re-consulta o PNCP.
// Universo pequeno (centenas, não milhões) — rápido e barato.
async function cicloRetryParticipacoes() {
  const tenants = _listTenantsSafe();
  for (const t of tenants) {
    let db;
    try { db = mgr.getDb(t.slug); } catch (_) { continue; }
    try {
      const stats = await resultadosBackfill.retentarSemResultadoParticipacoes(db, { tenantSlug: t.slug });
      if (stats.items > 0) {
        console.log(`[master][${t.slug}] retry-participacoes: participacoes=${stats.participacoes} items=${stats.items} atualizados=${stats.atualizados} ainda_sem=${stats.ainda_sem} erros=${stats.erros}`);
      }
    } catch (err) {
      console.error(`[master][${t.slug}] retry-participacoes erro:`, err.message);
    }
  }
}

function ligarRetryParticipacoes() {
  // 1ª execução 3 min após boot (catch-up)
  setTimeout(() => { cicloRetryParticipacoes().catch(() => {}); }, 3 * 60 * 1000);
  setInterval(() => { cicloRetryParticipacoes().catch(() => {}); }, 24 * 60 * 60 * 1000);
  console.log('[master] retry diário de __sem_resultado__ ativo (24h)');
}

function ligarSincronizacaoFunil() {
  // Primeiro ciclo 90s após boot para dar tempo de tudo warmup
  setTimeout(() => {
    cicloSincronizarFunilParticipacoes().catch(() => {});
  }, 90 * 1000);
  setInterval(() => {
    cicloSincronizarFunilParticipacoes().catch(() => {});
  }, SYNC_FUNIL_INTERVAL_MS);
  console.log('[master] sync participações → funil CRM: a cada 6h');
}

// ==================== RECONCILIADOR FISCAL DE OS (Fase 9.3) ====================
//
// A cada 15 minutos, varre todos os tenants ACTIVE/TRIAL em busca de
// OS faturadas com NFSe ou NF-e PENDENTES (falha ao emitir no momento
// do faturamento) e tenta re-emitir. Limita 5 OS por tenant por ciclo
// para não travar o master se a SEFAZ estiver lenta. Registra evento
// para cada tentativa.

const RECONCILIADOR_INTERVAL_MS = 15 * 60 * 1000;

async function cicloReconciliadorFiscal() {
  const tenants = _listTenantsSafe();
  for (const t of tenants) {
    let db;
    try { db = mgr.getDb(t.slug); }
    catch (_) { continue; }

    try {
      const pendentes = db.prepare(`
        SELECT id, numero, valorPecas, valorServicos
        FROM os_ordens
        WHERE status = 'faturada'
          AND statusFiscal IN ('pendente','rejeitada','mista_parcial')
        ORDER BY dataFaturamento ASC LIMIT 5
      `).all();
      if (!pendentes.length) continue;

      console.log(`[master][${t.slug}] reconciliador fiscal: ${pendentes.length} OS pendente(s)`);
      for (const p of pendentes) {
        await new Promise((resolve) => {
          tenantStorage.run({ kind: 'tenant', tenant: t, db }, async () => {
            try {
              // Requer o worker (os-routes) para usar os helpers — reusa
              // lógica invocando via "POST interno". Alternativa: re-exportar
              // helpers. Simpler: chama os endpoints locais via HTTP seria
              // overkill. Solução: chama nfse/nfe emit direto, marcando.
              // Aqui basta disparar via worker: deixamos isso como opcional
              // por ora — master marca statusFiscal='reagendada' para que o
              // admin veja e re-tente manualmente. Emissão reativa continua
              // sendo via os botões manuais ou pelo próprio faturar.
              db.prepare(`UPDATE os_ordens SET statusFiscal = 'reagendada' WHERE id = ?`).run(p.id);
            } catch (err) {
              console.error(`[master][${t.slug}] reconciliador OS#${p.id}: ${err.message}`);
            }
            resolve();
          });
        });
      }
    } catch (err) {
      console.error(`[master][${t.slug}] reconciliador fiscal:`, err.message);
    }
  }
}

function ligarReconciliadorFiscal() {
  setInterval(() => { cicloReconciliadorFiscal().catch(e => console.error('[master] reconciliador:', e.message)); }, RECONCILIADOR_INTERVAL_MS);
  // 1ª execução com delay de 2 min após boot
  setTimeout(() => { cicloReconciliadorFiscal().catch(()=>{}); }, 2 * 60 * 1000);
  console.log('[master] reconciliador fiscal de OS ativo (a cada 15 min)');
}

// ==================== SLA SWEEP (Fase 9.4) ====================
//
// A cada 30 min, varre OS ativas com dataPromessa vencida, marca
// slaStatus='atrasado' e notifica (1x) via Telegram + evento na timeline.
// OS que ainda estão a <=24h do prazo viram 'risco'.

const SLA_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

async function cicloSLASweep() {
  const tenants = _listTenantsSafe();
  for (const t of tenants) {
    let db;
    try { db = mgr.getDb(t.slug); } catch (_) { continue; }

    try {
      // Atrasadas novas: status ativo + dataPromessa < hoje + slaStatus != 'atrasado'
      const atrasadas = db.prepare(`
        SELECT o.id, o.numero, o.titulo, o.dataPromessa, o.slaStatus,
               u.username AS tecnicoUser, u.nome AS tecnicoNome
        FROM os_ordens o LEFT JOIN users u ON u.id = o.tecnicoId
        WHERE o.status IN ('rascunho','orcamento','aberta','em-andamento','aguardando-peca')
          AND o.dataPromessa IS NOT NULL
          AND date(o.dataPromessa) < date('now')
          AND (o.slaStatus IS NULL OR o.slaStatus != 'atrasado')
      `).all();

      // Em risco (dentro de 24h): idem
      const emRisco = db.prepare(`
        SELECT o.id, o.numero, o.slaStatus
        FROM os_ordens o
        WHERE o.status IN ('rascunho','orcamento','aberta','em-andamento','aguardando-peca')
          AND o.dataPromessa IS NOT NULL
          AND date(o.dataPromessa) >= date('now')
          AND date(o.dataPromessa) <= date('now', '+1 day')
          AND (o.slaStatus IS NULL OR o.slaStatus NOT IN ('risco','atrasado'))
      `).all();

      if (atrasadas.length) {
        console.log(`[master][${t.slug}] SLA sweep: ${atrasadas.length} OS atrasada(s) detectada(s)`);
        const updSt = db.prepare(`UPDATE os_ordens SET slaStatus = 'atrasado' WHERE id = ?`);
        const insEvt = db.prepare(`INSERT INTO os_eventos (osId, tipo, descricao, usuario) VALUES (?, 'sla-atrasado', ?, 'sistema')`);
        const msgs = [];
        for (const o of atrasadas) {
          updSt.run(o.id);
          insEvt.run(o.id, `OS ${o.numero} ultrapassou o prazo (${o.dataPromessa})`);
          msgs.push(`🚨 <b>${o.numero}</b> — ${o.titulo || ''} | prazo: ${o.dataPromessa} | técnico: ${o.tecnicoNome || o.tecnicoUser || '—'}`);
        }
        if (msgs.length) {
          try {
            const txt = `⚠️ <b>OS atrasadas — ${t.slug}</b>\n\n` + msgs.slice(0, 10).join('\n');
            await sendTelegram(db, txt).catch(() => {});
          } catch (_) {}
        }
      }

      if (emRisco.length) {
        const updRisc = db.prepare(`UPDATE os_ordens SET slaStatus = 'risco' WHERE id = ?`);
        const insEvt = db.prepare(`INSERT INTO os_eventos (osId, tipo, descricao, usuario) VALUES (?, 'sla-risco', ?, 'sistema')`);
        for (const o of emRisco) {
          updRisc.run(o.id);
          insEvt.run(o.id, `OS ${o.numero} em risco de atraso (<=24h)`);
        }
      }
    } catch (err) {
      console.error(`[master][${t.slug}] SLA sweep:`, err.message);
    }
  }
}

function ligarSLASweep() {
  setInterval(() => { cicloSLASweep().catch(e => console.error('[master] sla-sweep:', e.message)); }, SLA_SWEEP_INTERVAL_MS);
  setTimeout(() => { cicloSLASweep().catch(()=>{}); }, 90 * 1000);
  console.log('[master] SLA sweep de OS ativo (a cada 30 min)');
}

// ==================== PREVENTIVAS RECORRENTES (Fase 9.4) ====================
//
// Uma vez por dia, às 07:00, verifica contratos ativos com osPadraoTipoId e
// osPeriodicidadeDias definidos. Se (osUltimaGeracao + periodicidade) já
// passou, cria automaticamente uma OS do tipo configurado, clona o
// checklist do tipo, vincula contratoId, registra evento.

function _calcularProximaPreventiva(ultimaGeracao, periodicidade) {
  if (!periodicidade) return null;
  if (!ultimaGeracao) return new Date(0); // nunca gerou → sempre vencida
  const d = new Date(ultimaGeracao + 'T00:00:00');
  d.setDate(d.getDate() + Number(periodicidade));
  return d;
}

async function cicloPreventivas() {
  const tenants = _listTenantsSafe();
  const hojeStr = new Date().toISOString().slice(0, 10);
  for (const t of tenants) {
    let db;
    try { db = mgr.getDb(t.slug); } catch (_) { continue; }

    try {
      // Verifica se a tabela contratos e as colunas novas existem (compat)
      const contratos = db.prepare(`
        SELECT c.*, p.razaoSocial AS clienteNome, p.endereco AS clienteEndereco,
               p.numero AS clienteNumero, p.bairro AS clienteBairro,
               p.cidade AS clienteCidade, p.uf AS clienteUf, p.cep AS clienteCep
        FROM contratos c
        JOIN pessoas p ON p.id = c.clienteId
        WHERE c.status = 'ativo'
          AND c.osPadraoTipoId IS NOT NULL
          AND c.osPeriodicidadeDias IS NOT NULL
      `).all();

      if (!contratos.length) continue;

      let geradas = 0;
      for (const ct of contratos) {
        const proxima = _calcularProximaPreventiva(ct.osUltimaGeracao, ct.osPeriodicidadeDias);
        if (!proxima || proxima > new Date()) continue;

        // Buscar tipo
        const tipo = db.prepare('SELECT * FROM os_tipos WHERE id = ? AND ativo = 1').get(ct.osPadraoTipoId);
        if (!tipo) continue;

        const numero = (() => {
          const ano = new Date().getFullYear();
          const prefix = `OS-${ano}-`;
          const u = db.prepare(`SELECT numero FROM os_ordens WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix + '%');
          let n = 1;
          if (u) { const m = u.numero.match(/-(\d+)$/); if (m) n = parseInt(m[1], 10) + 1; }
          return prefix + String(n).padStart(4, '0');
        })();

        // Prazo promessa = hoje + sla do tipo
        let promessa = null;
        if (tipo.slaDiasPadrao) {
          const d = new Date(); d.setDate(d.getDate() + Number(tipo.slaDiasPadrao));
          promessa = d.toISOString().slice(0, 10);
        }

        const trx = db.transaction(() => {
          const r = db.prepare(`
            INSERT INTO os_ordens (
              numero, clienteId, status, titulo, usuarioCriacao,
              tipoId, contratoId,
              enderecoExecucao, numeroExecucao, bairroExecucao,
              municipioExecucao, ufExecucao, cepExecucao,
              prazoSLADias, dataPromessa, ambienteFiscal, orcamentoStatus
            ) VALUES (?, ?, 'aberta', ?, 'sistema', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          `).run(
            numero, ct.clienteId,
            `Preventiva — contrato ${ct.numero || ct.id}`,
            tipo.id, ct.id,
            ct.clienteEndereco, ct.clienteNumero, ct.clienteBairro,
            ct.clienteCidade, ct.clienteUf, ct.clienteCep,
            tipo.slaDiasPadrao || null, promessa, tipo.modoFiscal
          );
          const osId = r.lastInsertRowid;

          // Clona checklist do tipo
          try {
            const items = JSON.parse(tipo.checklistPadrao || '[]');
            const stmtChk = db.prepare('INSERT INTO os_checklist (osId, ordem, descricao, obrigatorio) VALUES (?, ?, ?, ?)');
            for (const ck of items) {
              stmtChk.run(osId, Number(ck.ordem) || 0, ck.descricao, ck.obrigatorio ? 1 : 0);
            }
          } catch (_) {}

          db.prepare(`INSERT INTO os_eventos (osId, tipo, descricao, usuario, payload) VALUES (?, 'abertura', ?, 'sistema', ?)`)
            .run(osId, `OS preventiva gerada automaticamente a partir do contrato ${ct.numero || ct.id}`, JSON.stringify({ contratoId: ct.id, tipoId: tipo.id }));

          // Atualiza última geração do contrato
          db.prepare(`UPDATE contratos SET osUltimaGeracao = ? WHERE id = ?`).run(hojeStr, ct.id);

          return osId;
        });
        const newOsId = trx();
        geradas++;
        console.log(`[master][${t.slug}] preventiva gerada: OS #${newOsId} (contrato ${ct.numero || ct.id}, tipo ${tipo.nome})`);
      }
      if (geradas) {
        try {
          await sendTelegram(db, `🔁 <b>${geradas} preventiva(s) gerada(s)</b> — ${t.slug}`).catch(() => {});
        } catch (_) {}
      }
    } catch (err) {
      console.error(`[master][${t.slug}] preventivas:`, err.message);
    }
  }
}

function ligarPreventivas() {
  // Agenda próxima execução: 07:00 do dia seguinte OU hoje 07:00 se ainda não passou.
  function agendarProxima() {
    const agora = new Date();
    const alvo = new Date();
    alvo.setHours(7, 0, 0, 0);
    if (alvo.getTime() <= agora.getTime()) alvo.setDate(alvo.getDate() + 1);
    const delay = alvo.getTime() - agora.getTime();
    setTimeout(async () => {
      try { await cicloPreventivas(); }
      catch (e) { console.error('[master] preventivas:', e.message); }
      agendarProxima();
    }, delay);
    console.log(`[master] preventivas de OS: próxima execução ${alvo.toISOString()}`);
  }
  agendarProxima();
  // Também roda 5 min após boot — útil quando o tenant precisa catch-up
  // de uma preventiva que ficou pendurada (master caído por mais de 1 dia).
  setTimeout(() => { cicloPreventivas().catch(() => {}); }, 5 * 60 * 1000);
}

// ==================== PREFETCH DADOS ABERTOS (Plano 10) ====================
//
// Pré-aquece `catalog.dadosabertos_cache` com as 5.000 descrições mais
// comuns do catálogo — para que a 1ª busca no inteligencia.html de um
// item popular já retorne cache hit em <10ms.
// Executa todo dia às 03:00. Throttle 500 ms entre chamadas.

const axiosDA = require('axios');
const PREFETCH_TOP_N = 5000;
const PREFETCH_DELAY_MS = 500;
const DA_URLS = {
  'pesquisa-preco': 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarPesquisaPrecoMaterial',
  'dadosabertos-itens': 'https://dadosabertos.compras.gov.br/modulo-contratacao/2_consultarItemContratacaoPncp14133',
};

const cryptoMaster = require('crypto');
function _queryHashMaster(obj) {
  const norm = {};
  Object.keys(obj).sort().forEach(k => {
    const v = obj[k];
    if (v === undefined || v === null || v === '') return;
    norm[k] = String(v).trim().toLowerCase();
  });
  return cryptoMaster.createHash('sha1').update(JSON.stringify(norm)).digest('hex');
}

// Fase 3g (2026-05-23): prefetch usa PG quando flag ativa
const _SCHED_USE_PG = process.env.CATALOG_BACKEND_PG === '1';
const _SCHED_CATALOGPG = _SCHED_USE_PG ? require('./catalog-pg') : null;

async function cicloPrefetchDadosAbertos() {
  const inicio = Date.now();
  console.log('[master] prefetch Dados Abertos: selecionando top descrições…');

  let descricoes;
  if (_SCHED_USE_PG) {
    descricoes = await _SCHED_CATALOGPG.query(`
      SELECT TRIM(LOWER("descricao")) AS "desc", COUNT(*) c
        FROM itens
       WHERE "descricao" IS NOT NULL AND LENGTH(TRIM("descricao")) >= 3
       GROUP BY TRIM(LOWER("descricao"))
       ORDER BY c DESC
       LIMIT $1
    `, [PREFETCH_TOP_N]);
  } else {
    descricoes = catalogDb.prepare(`
      SELECT TRIM(LOWER(descricao)) AS desc, COUNT(*) c
      FROM itens
      WHERE descricao IS NOT NULL AND LENGTH(TRIM(descricao)) >= 3
      GROUP BY desc
      ORDER BY c DESC
      LIMIT ?
    `).all(PREFETCH_TOP_N);
  }
  console.log(`[master] prefetch Dados Abertos: ${descricoes.length} descrições selecionadas`);

  const stmtUpsert = _SCHED_USE_PG ? null : catalogDb.prepare(`
    INSERT INTO dadosabertos_cache (endpoint, queryHash, queryParams, resposta, dataCache, expiresAt)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, datetime('now','+30 days'))
    ON CONFLICT(endpoint, queryHash) DO UPDATE SET
      resposta = excluded.resposta,
      dataCache = CURRENT_TIMESTAMP,
      expiresAt = datetime('now','+30 days')
  `);
  const stmtJaTem = _SCHED_USE_PG ? null : catalogDb.prepare(`
    SELECT expiresAt FROM dadosabertos_cache WHERE endpoint = ? AND queryHash = ?
  `);

  let novas = 0, puladas = 0, erros = 0;
  for (let i = 0; i < descricoes.length; i++) {
    const desc = descricoes[i].desc;
    for (const endpoint of Object.keys(DA_URLS)) {
      const queryParams = { descricao: desc, pagina: 1, tamanhoPagina: 50 };
      const queryHash = _queryHashMaster({ endpoint, ...queryParams });

      let ja;
      if (_SCHED_USE_PG) {
        ja = await _SCHED_CATALOGPG.queryOne(
          `SELECT "expiresAt" FROM dadosabertos_cache WHERE "endpoint"=$1 AND "queryHash"=$2`,
          [endpoint, queryHash]
        );
      } else {
        ja = stmtJaTem.get(endpoint, queryHash);
      }
      if (ja && new Date(ja.expiresAt).getTime() > Date.now()) {
        puladas++;
        continue;
      }
      const paramsApi = { pagina: 1, tamanhoPagina: 50 };
      if (endpoint === 'dadosabertos-itens') paramsApi.descricaoItem = desc;
      if (endpoint === 'pesquisa-preco')   paramsApi.descricaoItem = desc;
      try {
        const r = await axiosDA.get(DA_URLS[endpoint], {
          params: paramsApi,
          headers: { 'Accept': 'application/json' },
          timeout: 15000,
        });
        if (_SCHED_USE_PG) {
          await _SCHED_CATALOGPG.execute(
            `INSERT INTO dadosabertos_cache ("endpoint","queryHash","queryParams","resposta","dataCache","expiresAt")
             VALUES ($1,$2,$3::jsonb,$4::jsonb, now(), now() + interval '30 days')
             ON CONFLICT ("endpoint","queryHash") DO UPDATE SET
               "resposta"=EXCLUDED."resposta","dataCache"=now(),"expiresAt"=now() + interval '30 days'`,
            [endpoint, queryHash, JSON.stringify(queryParams), JSON.stringify(r.data || {})]
          );
        } else {
          stmtUpsert.run(endpoint, queryHash, JSON.stringify(queryParams), JSON.stringify(r.data || {}));
        }
        novas++;
      } catch (err) {
        erros++;
      }
      await new Promise(res => setTimeout(res, PREFETCH_DELAY_MS));
    }
    if ((i + 1) % 100 === 0) {
      console.log(`[master] prefetch Dados Abertos: ${i+1}/${descricoes.length} descrições processadas (novas=${novas}, puladas=${puladas}, erros=${erros})`);
    }
  }

  if (_SCHED_USE_PG) {
    await _SCHED_CATALOGPG.execute(
      `INSERT INTO catalog_sync_state ("key","value","updated_at") VALUES ('prefetchDadosAbertosLastRun', $1, $2)
       ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value", "updated_at"=EXCLUDED."updated_at"`,
      [new Date().toISOString(), Date.now()]
    );
  } else {
    catalogDb.prepare(`
      INSERT INTO catalog_sync_state (key, value, updated_at) VALUES ('prefetchDadosAbertosLastRun', ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(new Date().toISOString());
  }
  const segundos = Math.round((Date.now() - inicio) / 1000);
  console.log(`[master] prefetch Dados Abertos terminado: novas=${novas}, puladas=${puladas}, erros=${erros} em ${segundos}s`);
}

function ligarPrefetchDadosAbertos() {
  function agendarProxima() {
    const agora = new Date();
    const alvo = new Date();
    alvo.setHours(3, 0, 0, 0);
    if (alvo.getTime() <= agora.getTime()) alvo.setDate(alvo.getDate() + 1);
    const delay = alvo.getTime() - agora.getTime();
    setTimeout(async () => {
      try { await cicloPrefetchDadosAbertos(); }
      catch (e) { console.error('[master] prefetch Dados Abertos:', e.message); }
      agendarProxima();
    }, delay);
    console.log(`[master] prefetch Dados Abertos: próxima execução ${alvo.toISOString()}`);
  }
  agendarProxima();
}

// ==================== EXPURGO CACHE DADOS ABERTOS (Plano 10) ====================
//
// Remove entradas em catalog.dadosabertos_cache expiradas há mais de 7 dias.
// Entradas expiradas <7d são mantidas para servir stale-while-error.

async function cicloExpurgoCache() {
  try {
    let changes;
    if (_SCHED_USE_PG) {
      const r = await _SCHED_CATALOGPG.execute(
        `DELETE FROM dadosabertos_cache WHERE "expiresAt" < now() - interval '7 days'`
      );
      changes = r.rowCount;
    } else {
      const r = catalogDb.prepare(`
        DELETE FROM dadosabertos_cache WHERE expiresAt < datetime('now','-7 days')
      `).run();
      changes = r.changes;
    }
    if (changes > 0) {
      console.log(`[master] expurgo dadosabertos_cache: ${changes} entrada(s) removida(s)`);
    }
  } catch (err) {
    console.error('[master] expurgo cache:', err.message);
  }
}

function ligarExpurgoCache() {
  function agendarProxima() {
    const agora = new Date();
    const alvo = new Date();
    alvo.setHours(4, 0, 0, 0);
    if (alvo.getTime() <= agora.getTime()) alvo.setDate(alvo.getDate() + 1);
    const delay = alvo.getTime() - agora.getTime();
    setTimeout(async () => {
      await cicloExpurgoCache();
      agendarProxima();
    }, delay);
    console.log(`[master] expurgo cache: próxima execução ${alvo.toISOString()}`);
  }
  agendarProxima();
}

// ==================== EXPIRAÇÃO DE PLANOS (2026-04-29) ====================
//
// Diariamente às 03:00, varre tenants e aplica transição automática:
//   - Vencimento + carência ainda dentro: status = OVERDUE (mas continua acessível).
//   - Passou da carência: status = SUSPENDED (middleware bloqueia o tenant).
//   - Tenant em OVERDUE que recebeu renovação volta a ACTIVE/TRIAL.
// Auditoria registrada em tenant_audit (action = AUTO_EXPIRE).

function ligarExpiracaoTenants() {
  function executar() {
    try {
      const r = mgr.runExpiryCheck({ actor: 'cron' });
      if (r.transitions.length) {
        console.log(`[master] expiry-check: ${r.transitions.length} transição(ões) — ${r.transitions.map(t => `${t.slug}: ${t.from}→${t.to}`).join(', ')}`);
      }
    } catch (err) {
      console.error('[master] expiry-check falhou:', err.message);
    }
  }
  function agendarProxima() {
    const agora = new Date();
    const alvo = new Date();
    alvo.setHours(3, 0, 0, 0);
    if (alvo.getTime() <= agora.getTime()) alvo.setDate(alvo.getDate() + 1);
    const delay = alvo.getTime() - agora.getTime();
    setTimeout(() => { executar(); agendarProxima(); }, delay);
    console.log(`[master] expiração de planos: próxima execução ${alvo.toISOString()}`);
  }
  agendarProxima();
  // Catch-up no boot (5 min após), para pegar transições perdidas se o
  // master ficou caído por mais de um dia.
  setTimeout(executar, 5 * 60 * 1000);
}

// ==================== DISTRIBUIÇÃO DFe NF-e (2026-04-23) ====================
//
// Baixa XMLs de NF-e destinadas ao CNPJ do tenant via `NFeDistribuicaoDFe`
// (SEFAZ). Roda a cada 6h em cada tenant ACTIVE/TRIAL que tenha certificado
// A1 válido. Só popula o inbox — **não manifesta ciência automaticamente**
// (a manifestação segue manual por tela, preservando a decisão do usuário
// de aceitar/desconhecer a operação). Objetivo: não perder a janela de
// 10 dias da SEFAZ sem XMLs baixados.

const DFE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

async function cicloDistDFe() {
  const tenants = _listTenantsSafe();
  for (const t of tenants) {
    let db;
    try { db = mgr.getDb(t.slug); }
    catch (_) { continue; }

    try {
      const cert = db.prepare(`SELECT valor FROM config WHERE chave = 'nfe_certificado_arquivo'`).get();
      if (!cert) continue;
    } catch (_) { continue; }

    try {
      const r = await tenantStorage.run({ kind: 'tenant', tenant: t, db }, () => sincronizarInboxNfe(db));
      if (r.novos > 0) {
        console.log(`[master][${t.slug}] DistDFe: +${r.novos} novo(s) XML(s) no inbox (ultNSU=${r.ultNSU})`);
      }
    } catch (err) {
      const msg = err.cStat ? `cStat ${err.cStat}: ${err.xMotivo}` : err.message;
      console.error(`[master][${t.slug}] DistDFe:`, msg);
    }
  }
}

function ligarDistDFeInbox() {
  // 1ª execução 2min após boot, depois a cada 6h
  setTimeout(() => { cicloDistDFe().catch(e => console.error('[master] DistDFe inicial:', e.message)); }, 2 * 60 * 1000);
  setInterval(() => { cicloDistDFe().catch(e => console.error('[master] DistDFe:', e.message)); }, DFE_INTERVAL_MS);
  console.log(`[master] DistDFe NF-e: download automático a cada ${DFE_INTERVAL_MS/3600000}h (ciência NÃO é automática)`);
}

// ==================== SHUTDOWN ====================

function _gracefulShutdown(signal) {
  console.log(`[master] recebido ${signal}, encerrando...`);
  try { catalogDb.close(); } catch (_) { /* */ }
  try { mgr.closeAll(); } catch (_) { /* */ }
  setImmediate(() => process.exit(0));
}
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => _gracefulShutdown('SIGINT'));

// SIGUSR2: dispara sincronizarCompleta(720, 0) — usado pra sync retroativo
// histórico sob demanda. Pega janela do env SYNC_DIAS_ATRAS (default 720).
// Idempotente — se sync já está rodando, ignora.
process.on('SIGUSR2', () => {
  const diasAtras = parseInt(process.env.SYNC_DIAS_ATRAS, 10) || 720;
  if (pncpSync.isRunning && pncpSync.isRunning()) {
    console.log('[master] SIGUSR2 ignorado — sync já em andamento');
    return;
  }
  console.log(`[master] SIGUSR2 — disparando sincronizarCompleta(${diasAtras}, 0)`);
  pncpSync.sincronizarCompleta(diasAtras, 0).catch(err => {
    console.error('[master] sync retroativo falhou:', err && err.message);
  });
});
process.on('uncaughtException', (err) => {
  console.error('[master] uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[master] unhandledRejection:', reason);
});

// ==================== RECONCILIADOR DIRECIONADO DE INTERESSE ====================
// Refresca SÓ as licitações que algum tenant marcou em `interesse`, relendo o
// detalhe por-compra do PNCP e atualizando os campos voláteis no catálogo
// (data de encerramento/abertura, situação). Universo pequeno (dezenas–centenas)
// → leve e raramente bate no rate-limit (429) do PNCP. Pega edições do órgão que
// o sync por publicação não revisita. Complementa o sweep nacional (1x/dia).
// UPDATE focado (não UPSERT) → nunca insere lixo nem zera dataPublicacaoPncp.
const { execute: _pgExecute } = require('./catalog-pg');
const _axiosPNCP = require('axios');
const { PNCP_API_BASE: _PNCP_BASE } = require('./config');
const { resolverCompraIdsTenant } = require('./compra-id-resolver');
const { fetchMensagensGlobais, ingerirMensagensGlobais } = require('./chat-mensagens-ingest');

const RECONCILIAR_INTERESSE_INTERVAL_MS = 30 * 60 * 1000;

// PNCP devolve datas sem timezone — assume Brasília (igual licitacoes-persistence).
function _normDataBR(s) {
  if (!s || typeof s !== 'string') return null;
  return /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + '-03:00';
}

let _reconciliarRodando = false; // guarda anti-concorrência (ciclo pode exceder o intervalo sob throttle)

// Detalhe por-compra. Timeout curto (responde <4s quando não estrangulado) e
// poucas tentativas pra não moer 80s/licitação sob throttle.
// Retorna: objeto detalhe | {_removida} (404/204) | null (timeout/throttle).
async function _buscarDetalheCompra(cnpj, ano, sequencial) {
  const url = `${_PNCP_BASE}/orgaos/${cnpj}/compras/${ano}/${sequencial}`;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const resp = await _axiosPNCP.get(url, { headers: { 'Accept': 'application/json' }, timeout: 8000 });
      return resp.data || null;
    } catch (err) {
      const st = err.response?.status;
      if (st === 404 || st === 204) return { _removida: true };
      if (tentativa < 3) await new Promise(r => setTimeout(r, 2000 * tentativa));
    }
  }
  return null;
}

async function cicloReconciliarInteresse() {
  if (_reconciliarRodando) { console.log('[master] reconciliar-interesse: ciclo anterior ainda rodando, pulando'); return; }
  _reconciliarRodando = true;
  try {
    const tenants = _listTenantsSafe();
    const chaves = new Map();
    for (const t of tenants) {
      let db;
      try { db = mgr.getDb(t.slug); } catch (_) { continue; }
      try {
        const rows = db.prepare(
          'SELECT DISTINCT cnpj, ano, sequencial FROM interesse WHERE cnpj IS NOT NULL AND ano IS NOT NULL AND sequencial IS NOT NULL'
        ).all();
        for (const r of rows) chaves.set(`${r.cnpj}|${r.ano}|${r.sequencial}`, r);
      } catch (_) { /* tenant sem tabela interesse — ignora */ }
    }
    if (chaves.size === 0) return;

    let atualizadas = 0, semDetalhe = 0, erros = 0, throttleSeguidos = 0, abortou = false;
    for (const { cnpj, ano, sequencial } of chaves.values()) {
      try {
        const det = await _buscarDetalheCompra(cnpj, ano, sequencial);
        if (det === null) {
          // timeout/throttle — circuit breaker: 5 seguidos = PNCP estrangulando, aborta o ciclo
          semDetalhe++;
          if (++throttleSeguidos >= 5) { abortou = true; break; }
        } else if (det._removida || !det.numeroControlePNCP) {
          throttleSeguidos = 0;
          semDetalhe++;
        } else {
          throttleSeguidos = 0;
          const r = await _pgExecute(
            `UPDATE licitacoes
                SET "dataEncerramentoProposta"=$1,
                    "dataAberturaProposta"=$2,
                    "situacaoCompraNome"=$3,
                    "dataAtualizacao"=now()
              WHERE "cnpj"=$4 AND "anoCompra"=$5 AND "sequencialCompra"=$6`,
            [_normDataBR(det.dataEncerramentoProposta), _normDataBR(det.dataAberturaProposta),
             det.situacaoCompraNome || null, String(cnpj), Number(ano), Number(sequencial)]
          );
          if (r.rowCount > 0) atualizadas++;
        }
      } catch (err) { erros++; throttleSeguidos = 0; }
      await new Promise(r => setTimeout(r, 700)); // pacing gentil com o WAF
    }
    console.log(`[master] reconciliar-interesse: ${chaves.size} licitações, ${atualizadas} atualizadas, ${semDetalhe} sem detalhe, ${erros} erros${abortou ? ' (ABORTADO por throttle — tenta de novo no próximo ciclo)' : ''}`);
  } finally {
    _reconciliarRodando = false;
  }
}

function ligarReconciliarInteresse() {
  setTimeout(() => { cicloReconciliarInteresse().catch(err => console.error('[master] reconciliar-interesse erro:', err.message)); }, 4 * 60 * 1000);
  setInterval(() => { cicloReconciliarInteresse().catch(err => console.error('[master] reconciliar-interesse erro:', err.message)); }, RECONCILIAR_INTERESSE_INTERVAL_MS);
  console.log('[master] reconciliador direcionado de interesse ativo (1ª em 4min, depois a cada 30min)');
}

// Resolve proativamente o compraId Comprasnet dos interesses (sem depender de
// página aberta). Reusa compra-id-resolver.js — o mesmo módulo do endpoint
// POST /api/proposta/interesses/auto-compra-id. Métodos 1-3 e 4a-c são locais;
// o 4d (PNCP consulta/v1) roda com circuit-breaker interno.
let _resolverCompraIdRodando = false;

async function cicloResolverCompraIds() {
  if (_resolverCompraIdRodando) { console.log('[master] resolver-compra-id: ciclo anterior ainda rodando, pulando'); return; }
  _resolverCompraIdRodando = true;
  try {
    const tenants = _listTenantsSafe();
    let tenantsOk = 0, totResolvidos = 0, totNaoCS = 0, totPendentes = 0;
    for (const t of tenants) {
      let db;
      try { db = mgr.getDb(t.slug); } catch (_) { continue; }
      try {
        const r = await resolverCompraIdsTenant(db); // pncpFallback true (cobertura máx); breaker do 4d protege o ciclo
        tenantsOk++;
        totResolvidos += r.resolvidos.length;
        totNaoCS += r.naoComprasnet.length;
        totPendentes += r.pendentes;
      } catch (_) { /* tenant sem tabela interesse/participacoes — ignora */ }
    }
    console.log(`[master] resolver-compra-id: ${tenantsOk} tenants, ${totResolvidos} resolvidos, ${totNaoCS} não-Comprasnet, ${totPendentes} ainda pendentes`);
  } finally {
    _resolverCompraIdRodando = false;
  }
}

function ligarResolverCompraIds() {
  setTimeout(() => { cicloResolverCompraIds().catch(err => console.error('[master] resolver-compra-id erro:', err.message)); }, 6 * 60 * 1000);
  setInterval(() => { cicloResolverCompraIds().catch(err => console.error('[master] resolver-compra-id erro:', err.message)); }, RECONCILIAR_INTERESSE_INTERVAL_MS);
  console.log('[master] resolvedor de compraId ativo (1ª em 6min, depois a cada 30min)');
}

// Captura server-side de mensagens do chat do Comprasnet, off o Bearer que a
// worker persiste em config.bearer_token (o endpoint /comprasnet-mensagem/v1 aceita
// só Bearer, sem captcha). Substitui a captura via Electron, que parou de alimentar.
// Reusa chat-mensagens-ingest.js — o mesmo writer do endpoint /api/sync/mensagens-global.
const CAPTURAR_MSG_INTERVAL_MS = 90 * 1000;
let _capturarMsgRodando = false;

async function cicloCapturarMensagens() {
  if (_capturarMsgRodando) return; // roda a cada 90s — pula silenciosamente se o anterior atrasou
  _capturarMsgRodando = true;
  try {
    const tenants = _listTenantsSafe();
    let tenantsOk = 0, totNovas = 0, totAlertas = 0;
    for (const t of tenants) {
      let db;
      try { db = mgr.getDb(t.slug); } catch (_) { continue; }
      let bearer;
      try {
        bearer = (db.prepare("SELECT valor FROM config WHERE chave='bearer_token'").get() || {}).valor;
      } catch (_) { continue; } // tenant sem tabela config — ignora
      if (!bearer) continue;    // só tenants com Bearer (hoje só 1bit)
      try {
        const f = await fetchMensagensGlobais(bearer);
        if (!f.ok) {
          // 401 = token expirado (próximo push do Electron renova) — silencioso pra não spammar
          if (f.status && f.status !== 401) console.log(`[master][${t.slug}] capturar-mensagens: fetch HTTP ${f.status}`);
          continue;
        }
        const r = await ingerirMensagensGlobais(db, f.mensagens, { origemCaptura: 'servidor-v1' });
        tenantsOk++;
        totNovas += r.novas;
        totAlertas += r.alertas.length;
      } catch (e) { console.error(`[master][${t.slug}] capturar-mensagens erro: ${e.message}`); }
    }
    if (totNovas > 0 || totAlertas > 0) {
      console.log(`[master] capturar-mensagens: ${tenantsOk} tenants, ${totNovas} novas, ${totAlertas} alertas`);
    }
  } finally {
    _capturarMsgRodando = false;
  }
}

function ligarCapturarMensagens() {
  setTimeout(() => { cicloCapturarMensagens().catch(err => console.error('[master] capturar-mensagens erro:', err.message)); }, 2 * 60 * 1000);
  setInterval(() => { cicloCapturarMensagens().catch(err => console.error('[master] capturar-mensagens erro:', err.message)); }, CAPTURAR_MSG_INTERVAL_MS);
  console.log('[master] captura de mensagens Comprasnet ativa (1ª em 2min, depois a cada 90s)');
}

// ==================== BOOT ====================

try {
  _startupBanner();
  ligarSyncPNCP();
  ligarBackfillResultados();
  ligarBackfillMarca();
  ligarBackfillMarcaPortal();
  ligarBackfillFts();
  ligarJobsPorTenant();
  ligarReconciliadorFiscal();
  ligarSLASweep();
  ligarPreventivas();
  ligarPrefetchDadosAbertos();
  ligarExpurgoCache();
  ligarDistDFeInbox();
  ligarRetryParticipacoes();
  ligarSincronizacaoFunil();
  ligarExpiracaoTenants();
  ligarReconciliarInteresse();
  ligarResolverCompraIds();
  ligarCapturarMensagens();
  console.log('[master] todos os schedulers ativos');
} catch (err) {
  console.error('[master] FATAL erro no bootstrap:', err && err.stack || err);
  process.exit(1);
}
