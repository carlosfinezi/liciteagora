/**
 * sniper-lance-routes.js — Endpoints REST para o Sniper de Lances
 *
 * O sniper funciona de forma autônoma:
 * - Recebe Bearer token via POST /api/auth/token (Electron Standalone)
 * - Faz chamadas HTTP diretas ao Comprasnet (sem Puppeteer — removido
 *   em 2026-04-22)
 *
 * Uso no server.js:
 *   const { registrarRotasSniper } = require('./sniper-lance-routes');
 *   registrarRotasSniper(app, db);
 */

const SniperLance = require('./sniper-lance');
const { buildCompraId, classificar422 } = require('./sniper-lance');
const { currentTenant, currentDb, tenantStorage } = require('./tenant-middleware');
const { sendTelegram } = require('./telegram-client');
const { enviarEmailAlerta } = require('./email-client');
const blitzHist = require('./blitz-historico');
const bncScheduler = require('./bnc-dispute-scheduler');
// Fase 3g (2026-05-23): resultados_bi/itens/licitacoes vão pra PG
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

// Extrai (situacao, fase, objeto, orgao) do payload de
// GET /comprasnet-fase-externa/v1/compras/{compraId}/participacao.
// Fonte única usada pelo guard de /qtdes (fetchItensDirecto), pelo refresh
// periódico (executarRefreshParticipacoes) e pelo backfill manual
// (/api/sniper/resync-encerradas).
function extrairFaseFromParticipacao(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    situacao: data.situacaoCompraFaseExterna || '',
    fase: data.faseCompraFaseExterna || '',
    objeto: data.objetoCompra || '',
    orgao: data.nomeOrgao || data.nomeUasg || '',
  };
}

// Handler de lance BNC. compraId vem como 'bnc:<processNumber>', itemNumero
// é o batchNumber do lote (1, 2, ...). Reusa a engine SignalR (que tem o
// bridge de captcha pra obter token reCAPTCHA via Electron).
async function handleBNCLance(tdb, tenantSlug, { compraId, batchNumber, valor }, res) {
  try {
    if (!tenantSlug) return res.status(400).json({ success: false, error: 'tenant slug indisponível no contexto' });
    const engine = bncScheduler.getEngineForSala(tenantSlug, compraId);
    if (!engine) return res.status(400).json({ success: false, error: `Engine BNC não está rodando pra ${compraId}. Garanta que a sala está ativa em /configuracoes/bnc-salas.html` });

    // Achar o lote pelo batchNumber. Engine mantém Map<idBatchUuid, gkz>; precisamos
    // descobrir o idBatchUuid correspondente ao batchNumber.
    const sala = require('./bnc-salas').getSala(tdb, compraId);
    if (!sala) return res.status(404).json({ success: false, error: 'Sala não encontrada' });
    const lote = (sala.lotes || []).find(l => l.batchNumber === batchNumber);
    if (!lote) return res.status(404).json({ success: false, error: `Lote ${batchNumber} não encontrado na sala` });
    if (!lote.batchTokenGkz) return res.status(400).json({ success: false, error: `Token [gkz] do lote ${batchNumber} ainda desconhecido — re-cadastre a sala ou aguarde descoberta automática` });

    // sendBid da engine espera batchToken já registrado por uuid; injeta agora
    if (lote.idBatchUuid) engine.setBatchToken(lote.idBatchUuid, lote.batchTokenGkz);

    // Construir decision pra forçar envio independente da lógica dryRun
    const decisionId = lote.idBatchUuid || `__nouuid__:${batchNumber}`;
    if (!lote.idBatchUuid) engine.setBatchToken(decisionId, lote.batchTokenGkz);

    const decision = {
      batchId: decisionId,
      myNextBid: valor,
      currentBest: lote.currentBest,
      action: 'bid',
      reason: 'manual via /api/sniper/lance',
    };

    // Promise wrapper sobre os events bidSent/bidFailed
    const result = await new Promise((resolve) => {
      let done = false;
      const onSent = (info) => { if (done) return; done = true; cleanup(); resolve({ ok: true, info }); };
      const onFailed = (info) => { if (done) return; done = true; cleanup(); resolve({ ok: false, info }); };
      const onUnknown = (info) => { if (done) return; done = true; cleanup(); resolve({ ok: false, info, unknown: true }); };
      function cleanup() {
        engine.removeListener('bidSent', onSent);
        engine.removeListener('bidFailed', onFailed);
        engine.removeListener('bidUnknown', onUnknown);
      }
      engine.on('bidSent', onSent);
      engine.on('bidFailed', onFailed);
      engine.on('bidUnknown', onUnknown);

      // Dispara — não passa pelo dryRun pois sendBid é exposto publicamente
      engine.sendBid(decision).catch(e => onFailed({ ...decision, error: e.message, stage: 'throw' }));
    });

    if (result.ok) {
      res.json({ success: true, via: 'bnc-engine', resultado: result.info });
    } else {
      const err = (result.info && result.info.error) || 'falha desconhecida';
      const stage = (result.info && result.info.stage) || 'unknown';
      res.json({ success: false, via: 'bnc-engine', error: `${stage}: ${err}`, resultado: result.info });
    }
  } catch (e) {
    console.error('[BNC lance handler]', e);
    res.status(500).json({ success: false, error: e.message });
  }
}

// Phase A (2026-04-23): pool de SniperLance por tenant — corrige leak onde
// o Bearer capturado pelo Electron de um tenant vazava para todos os outros.
// Cada tenant agora mantém seu próprio estado (token, captcha, agendamentos,
// logs). O `sniper` exportado abaixo é um Proxy que resolve dinamicamente a
// instância correta via AsyncLocalStorage do tenant-middleware.
//
// Phase B pendente: timers setInterval (sniper.autoLanceTimerNormal, iniciarAutoRefresh,
// guardPoll, etc.) registrados em boot ainda perdem o contexto de tenant ao
// disparar — até que sejam reescritos para agendar por-tenant dentro de
// tenantStorage.run(), auto-refresh e auto-lance scheduler ficam desligados
// em multi-tenant. Token capture + request-path continuam OK.
const _sniperPool = new Map();   // tenantSlug -> SniperLance
const _bootSniper = new SniperLance();   // usado só em contexto sem tenant (boot/timers legados)
const _refreshSchedules = new Map();  // tenantSlug -> interval id

function _iniciarAgendamentoTenant(tenant, db) {
  if (_refreshSchedules.has(tenant.slug)) return;
  // Modo emergencial 2026-05-23: DISABLE_SCHEDULERS=1 pula todos os
  // timers per-tenant (SniperRefresh, AutoLance, ScanAlertas, proposta-sync).
  // UI continua respondendo; só ações automáticas ficam off.
  if (process.env.DISABLE_SCHEDULERS === '1') {
    _refreshSchedules.set(tenant.slug, null); // marca como "já iniciado" pra não tentar de novo
    console.log(`[SniperRefresh] DESABILITADO para tenant "${tenant.slug}" (DISABLE_SCHEDULERS=1)`);
    return;
  }

  // Refresh de participações a cada 2 min (Phase B)
  const tickRefresh = async () => {
    try {
      await tenantStorage.run({ kind: 'tenant', tenant, db }, async () => {
        if (!_refreshParticipacoesRef) return;
        await _refreshParticipacoesRef();
      });
    } catch (e) {
      console.error(`[SniperRefresh ${tenant.slug}] ${e.message}`);
    }
  };
  const refreshTimer = setInterval(tickRefresh, 120000);
  if (refreshTimer.unref) refreshTimer.unref();
  _refreshSchedules.set(tenant.slug, refreshTimer);
  setTimeout(tickRefresh, 10000);

  // Auto-lance engine check (Phase C): 5s após primeira ativação, verifica se
  // o tenant tem configs de auto-lance e inicia engine. AsyncLocalStorage
  // propaga tenant/db para os timers criados por iniciarAutoLance, então os
  // callbacks subsequentes (executarCicloAutoLance, guardPoll) rodam no
  // contexto certo automaticamente.
  setTimeout(() => {
    tenantStorage.run({ kind: 'tenant', tenant, db }, () => {
      try { if (_verificarAutoLanceRef) _verificarAutoLanceRef(); }
      catch (e) { console.error(`[AutoLance ${tenant.slug}] boot check: ${e.message}`); }
    });
  }, 5000);

  // Recovery de blitz agendadas (Phase C multi-tenant fix): só uma vez por tenant.
  // Re-arma os setTimeouts in-memory dos agendamentos persistidos que sobreviveram
  // ao restart. Corre 2s após primeira ativação, dentro do tenantStorage.
  if (!_recuperacoesFeitas.has(tenant.slug)) {
    _recuperacoesFeitas.add(tenant.slug);
    setTimeout(() => {
      tenantStorage.run({ kind: 'tenant', tenant, db }, async () => {
        try { if (_recuperarBlitzesRef) await _recuperarBlitzesRef(); }
        catch (e) { console.error(`[BLITZ-RECOVERY ${tenant.slug}] ${e.message}`); }
      });
    }, 2000);
  }

  // Scanner de alertas (Telegram): token inválido + disputa sem blitz.
  // Roda a cada 30s dentro de tenantStorage pro sniper resolver no tenant correto.
  const tickAlertas = async () => {
    try {
      await tenantStorage.run({ kind: 'tenant', tenant, db }, async () => {
        if (!_scanAlertasRef) return;
        await _scanAlertasRef();
      });
    } catch (e) {
      console.error(`[ScanAlertas ${tenant.slug}] ${e.message}`);
    }
  };
  const alertasTimer = setInterval(tickAlertas, 30000);
  if (alertasTimer.unref) alertasTimer.unref();
  setTimeout(tickAlertas, 15000); // primeira passada 15s após boot

  // Sync diário do status de propostas no Comprasnet (Fix B):
  // detecta propostas enviadas direto pelo portal (sem passar pelo LiciteAgora)
  // e atualiza participacoes_comprasnet.propostaEnviadaEm. Precisa do Bearer,
  // então pula silenciosamente quando não tem.
  const propostaStatusSync = require('./proposta-status-sync');
  const tickPropostaSync = async () => {
    try {
      await tenantStorage.run({ kind: 'tenant', tenant, db }, async () => {
        const s = _getSniperForContext();
        const r = await propostaStatusSync.rodarSync(s, db, { tenantSlug: tenant.slug });
        if (r && !r.skipped && (r.confirmadas > 0 || r.erros > 0)) {
          console.log(`[proposta-sync ${tenant.slug}] candidatos=${r.candidatos} confirmadas=${r.confirmadas} semProposta=${r.semProposta} erros=${r.erros}`);
        }
      });
    } catch (e) {
      console.error(`[proposta-sync ${tenant.slug}] ${e.message}`);
    }
  };
  const propostaSyncTimer = setInterval(tickPropostaSync, 24 * 60 * 60 * 1000);
  if (propostaSyncTimer.unref) propostaSyncTimer.unref();
  setTimeout(tickPropostaSync, 2 * 60 * 1000); // 1ª passada 2 min após boot

  // Ping ativo de saúde Comprasnet (30s) — roda NO CONTEXTO do tenant para que os
  // Proxies sniper/db resolvam. Fix 2026-06-26: antes era um setTimeout global
  // (sniper=_bootSniper sem token, db Proxy sem tenant) → INSERT engolido, 0 amostras.
  const pingHealthTimer = setInterval(() => {
    try { if (_pingHealthTickRef) _pingHealthTickRef(tenant, db).catch(() => {}); } catch (_) {}
  }, 30000);
  if (pingHealthTimer.unref) pingHealthTimer.unref();

  console.log(`[SniperRefresh] agendado para tenant "${tenant.slug}" (a cada 2 min)`);
  console.log(`[AutoLance] boot check agendado para tenant "${tenant.slug}" (em 5s)`);
  console.log(`[ScanAlertas] agendado para tenant "${tenant.slug}" (a cada 30s)`);
  console.log(`[proposta-sync] agendado para tenant "${tenant.slug}" (1ª em 2min, depois 24h)`);
}

function _getSniperForContext() {
  const tenant = currentTenant();
  if (!tenant || !tenant.slug) return _bootSniper;
  let s = _sniperPool.get(tenant.slug);
  if (!s) {
    s = new SniperLance();
    const tenantDb = (() => { try { return currentDb(); } catch (_) { return null; } })();
    if (tenantDb) {
      try { s.initDb(tenantDb); } catch (_) {}
      _iniciarAgendamentoTenant(tenant, tenantDb);
    }
    _sniperPool.set(tenant.slug, s);
    console.log(`[Sniper] Instância criada para tenant "${tenant.slug}"`);
  }
  return s;
}

const sniper = new Proxy({}, {
  get(_, prop) {
    const s = _getSniperForContext();
    const v = s[prop];
    return typeof v === 'function' ? v.bind(s) : v;
  },
  set(_, prop, value) {
    _getSniperForContext()[prop] = value;
    return true;
  },
  has(_, prop) { return prop in _getSniperForContext(); },
});
console.log('[Sniper] Pool multi-tenant inicializado');

// Phase B: referência module-scope para executarRefreshParticipacoes (definida
// dentro de registrarRotasSniper). Após primeira chamada de registrarRotasSniper,
// o scheduler master pode invocar via agendarSniperRefresh(db).
let _refreshParticipacoesRef = null;
let _scanAlertasRef = null;

// Phase C: referência para verificarAutoLanceNecessario. Cada tenant dispara
// seu próprio check 5s após primeira atividade no worker.
let _verificarAutoLanceRef = null;

// Ping de saúde Comprasnet (30s). Definido dentro de registrarRotasSniper (precisa
// de _registrarHealth/sniper), disparado per-tenant em _iniciarAgendamentoTenant.
let _pingHealthTickRef = null;

// Recovery de blitz agendadas — dispara por tenant no primeiro acesso
// para re-armar timers perdidos no restart do processo.
let _recuperarBlitzesRef = null;
const _recuperacoesFeitas = new Set(); // tenantSlug → já rodou, evita duplicar

/**
 * Sincroniza status das participações com o funil CRM "Licitações".
 * Para cada participação com resultado homologado em resultados_bi:
 *   - Ganha  → move oportunidade para etapa tipo='ganho'
 *   - Perdida → move para etapa tipo='perdido' + registra motivoPerda
 * Oportunidades sem linha no CRM são criadas com título/descrição derivados.
 *
 * Idempotente: só altera etapa quando difere da atual.
 * Chamada tanto pelo endpoint on-demand (worker) quanto pelo scheduler diário.
 *
 * @param {Database} db — tenant DB (com catalog attached)
 * @returns {object} stats: { candidatas, movidas, criadas, semAlteracao, erros }
 */
async function sincronizarParticipacoesFunil(db) {
  const fornecedor = db.prepare('SELECT cnpj FROM fornecedor LIMIT 1').get();
  const nossoCnpj = fornecedor ? (fornecedor.cnpj || '').replace(/\D/g, '') : '';
  if (!nossoCnpj) throw new Error('CNPJ do fornecedor não cadastrado — impossível distinguir vitórias');

  const funil = db.prepare("SELECT id FROM crm_funis WHERE nome = 'Licitações' AND ativo = 1").get();
  if (!funil) throw new Error('Funil "Licitações" não encontrado no CRM');

  const etapas = db.prepare('SELECT id, tipo FROM crm_etapas WHERE funilId = ? AND ativo = 1').all(funil.id);
  const etapaGanho = etapas.find(e => e.tipo === 'ganho');
  const etapaPerdido = etapas.find(e => e.tipo === 'perdido');
  if (!etapaGanho || !etapaPerdido) throw new Error('Funil "Licitações" sem etapa de ganho/perdido');

  // Candidatas: participações com resultado homologado (pelo menos 1 item)
  // Fase 3g: em PG mode separa em 2 passos (tenant + catalog PG) — JOIN cross-DB.
  let candidatas;
  if (USE_PG) {
    const parts = db.prepare(`
      SELECT p.compraId, p.cnpj, p.ano, p.sequencial, p.numero, p.orgao, p.objeto, p.dataHoraFimDisputa
        FROM participacoes_comprasnet p
       WHERE p.ativo = 1
    `).all();
    if (parts.length === 0) {
      candidatas = [];
    } else {
      // Agrega resultados_bi por (cnpj,ano,sequencial) no PG, restringindo ao
      // universo das participações ativas via VALUES + JOIN.
      const values = parts.map((_, i) => `($${i*3+2}::text,$${i*3+3}::int,$${i*3+4}::bigint)`).join(',');
      const params = [nossoCnpj];
      for (const p of parts) params.push(String(p.cnpj), Number(p.ano), Number(p.sequencial));
      const agg = await catalogPg.query(`
        WITH keys(cnpj, ano, sequencial) AS (VALUES ${values})
        SELECT k.cnpj, k.ano, k.sequencial,
               COUNT(*)::int AS itens_homol,
               SUM(CASE WHEN REPLACE(REPLACE(r."niFornecedor",'.',''),'/','') = $1 THEN 1 ELSE 0 END)::int AS itens_ganhos,
               COALESCE(SUM(CASE WHEN REPLACE(REPLACE(r."niFornecedor",'.',''),'/','') = $1
                                 THEN r."valorTotalHomologado" ELSE 0 END), 0) AS valor_ganho
          FROM resultados_bi r
          JOIN keys k ON r."cnpj"=k.cnpj AND r."ano"=k.ano AND r."sequencial"=k.sequencial
         GROUP BY k.cnpj, k.ano, k.sequencial
      `, params);
      const aggMap = new Map();
      for (const a of agg) aggMap.set(`${a.cnpj}|${a.ano}|${a.sequencial}`, a);
      candidatas = parts.map(p => {
        const a = aggMap.get(`${p.cnpj}|${p.ano}|${p.sequencial}`) || { itens_homol: 0, itens_ganhos: 0, valor_ganho: 0 };
        return { ...p, itens_homol: a.itens_homol, itens_ganhos: a.itens_ganhos, valor_ganho: Number(a.valor_ganho) };
      }).filter(r => r.itens_homol > 0);
    }
  } else {
    candidatas = db.prepare(`
      SELECT p.compraId, p.cnpj, p.ano, p.sequencial, p.numero, p.orgao, p.objeto,
             p.dataHoraFimDisputa,
             (SELECT COUNT(*) FROM resultados_bi r WHERE r.cnpj=p.cnpj AND r.ano=p.ano AND r.sequencial=p.sequencial) AS itens_homol,
             (SELECT COUNT(*) FROM resultados_bi r WHERE r.cnpj=p.cnpj AND r.ano=p.ano AND r.sequencial=p.sequencial
                AND REPLACE(REPLACE(r.niFornecedor,'.',''),'/','') = ?) AS itens_ganhos,
             (SELECT COALESCE(SUM(r.valorTotalHomologado),0) FROM resultados_bi r
                WHERE r.cnpj=p.cnpj AND r.ano=p.ano AND r.sequencial=p.sequencial
                AND REPLACE(REPLACE(r.niFornecedor,'.',''),'/','') = ?) AS valor_ganho
      FROM participacoes_comprasnet p
      WHERE p.ativo = 1
    `).all(nossoCnpj, nossoCnpj).filter(r => r.itens_homol > 0);
  }

  const selOp = db.prepare(`
    SELECT id, etapaId, titulo FROM crm_oportunidades
    WHERE licitacaoCnpj = ? AND licitacaoAno = ? AND licitacaoSequencial = ? AND ativo = 1
  `);
  const updEtapa = db.prepare(`
    UPDATE crm_oportunidades
    SET etapaId = ?, dataFechamento = CURRENT_TIMESTAMP, dataAtualizacao = CURRENT_TIMESTAMP,
        valor = COALESCE(NULLIF(?, 0), valor),
        motivoPerda = ?
    WHERE id = ?
  `);
  const insOp = db.prepare(`
    INSERT INTO crm_oportunidades
      (funilId, etapaId, titulo, descricao, valor, probabilidade, fonte,
       licitacaoCnpj, licitacaoAno, licitacaoSequencial,
       dataAbertura, dataFechamento)
    VALUES (?, ?, ?, ?, ?, ?, 'licitacao', ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const stats = { candidatas: candidatas.length, movidas: 0, criadas: 0, semAlteracao: 0, erros: 0 };

  for (const c of candidatas) {
    const ganhou = c.itens_ganhos > 0;
    const etapaAlvo = ganhou ? etapaGanho : etapaPerdido;
    const motivoPerda = ganhou ? null : 'Licitação homologada para outro fornecedor';

    try {
      const op = selOp.get(c.cnpj, Number(c.ano), Number(c.sequencial));
      if (op) {
        if (op.etapaId === etapaAlvo.id) { stats.semAlteracao++; continue; }
        updEtapa.run(etapaAlvo.id, c.valor_ganho || 0, motivoPerda, op.id);
        stats.movidas++;
      } else {
        const titulo = (c.numero ? `${c.numero} — ` : '') + (c.orgao || '').slice(0, 80) || `Licitação ${c.cnpj}/${c.ano}/${c.sequencial}`;
        const descricao = c.objeto || null;
        insOp.run(
          funil.id, etapaAlvo.id,
          titulo.slice(0, 200), descricao,
          c.valor_ganho || 0, 100,
          c.cnpj, Number(c.ano), Number(c.sequencial),
          c.dataHoraFimDisputa || new Date().toISOString(),
        );
        stats.criadas++;
      }
    } catch (e) {
      stats.erros++;
      console.error(`[sync-funil] ${c.compraId}: ${e.message}`);
    }
  }
  return stats;
}

function registrarRotasSniper(app, db) {
  // Phase A: initDb é chamado LAZY por tenant em _getSniperForContext.
  // A chamada abaixo só afeta o _bootSniper (contexto boot) e é mantida
  // apenas como no-op compatível — não carrega bearer de nenhum tenant.
  try { _bootSniper.initDb(db); } catch (_) {}

  // Plano 16 (2026-04-24): seed do toggle do Motor de lances. Default ON.
  try {
    db.prepare(`INSERT OR IGNORE INTO config (chave, valor) VALUES ('sniper_motor_enabled', '1')`).run();
  } catch (_) { /* config pode não existir em bootstrap — ok */ }

  // Tracking da extensão
  let ultimoSyncExtensao = null; // timestamp do último POST da extensão

  // ==================== AUTH / TOKEN ====================

  /**
   * POST /api/auth/token
   * Recebe Bearer token do Electron Standalone (server-sync.js).
   * Também aceita envio manual.
   */
  app.post('/api/auth/token', async (req, res) => {
    try {
      const { token, captchaToken, source } = req.body;
      if (!token) {
        return res.status(400).json({ success: false, error: 'Token obrigatório' });
      }

      const normalizedToken = token.startsWith('Bearer ') ? token : `Bearer ${token}`;

      // Validar token contra Comprasnet antes de aceitar
      const validation = await sniper.validateToken(normalizedToken);

      if (!validation.valid) {
        sniper.log(`🚫 Token REJEITADO de ${source || 'api'} (HTTP ${validation.status})`);
        // Auditoria: grava entrada em bearer_history com motivoRejeicao pra
        // distinguir "token nunca chegou" de "chegou e foi recusado".
        try {
          const payload = sniper._decodeJwtPayload(normalizedToken) || {};
          const fp = sniper._fingerprint(normalizedToken);
          const expEm = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
          const subject = payload.sub || payload.preferred_username || null;
          const jti = payload.jti || null;
          const duracao = payload.exp && payload.iat ? (payload.exp - payload.iat) : null;
          const agora = new Date().toISOString();
          db.prepare(`INSERT OR IGNORE INTO bearer_history
            (source, tokenFingerprint, jti, subject, recebidoEm, expEm, duracaoEsperadaSeg,
             substituidoEm, motivoRejeicao, httpStatusRejeicao)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(source || 'api', fp, jti, subject, agora, expEm, duracao,
                 agora, `Comprasnet HTTP ${validation.status}`, validation.status);
        } catch (_) { /* não bloquear resposta por falha de auditoria */ }
        return res.json({
          success: false,
          validated: false,
          error: `Token inválido (Comprasnet retornou ${validation.status})`,
          needsToken: !sniper.temToken() || sniper.tokenExpirado(),
          tokenSource: sniper.tokenSource,
          tokenAge: sniper.tokenRecebidoEm ? Math.floor(sniper.idadeTokenSegundos()) : null,
        });
      }

      sniper.setToken(token, source || 'api');
      if (source === 'extension') ultimoSyncExtensao = Date.now();

      // Captcha token (hCaptcha) — para APIs de mensagem/fase-externa
      if (captchaToken) {
        sniper.setCaptchaToken(captchaToken);
      }

      res.json({
        success: true,
        validated: !validation.cached,
        cached: validation.cached,
        message: 'Token recebido' + (captchaToken ? ' + captcha' : ''),
        needsToken: false,
        tokenSource: sniper.tokenSource,
        tokenAge: Math.floor(sniper.idadeTokenSegundos()),
        temCaptcha: sniper.temCaptcha(),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== STATUS ====================

  app.get('/api/sniper/status', (req, res) => {
    try {
      res.json({ success: true, ...sniper.getStatus() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== ALERTAS — CONFIG DE CANAIS ====================
  // GET → estado atual dos canais (telegram on/off, email on/off, destinatários)
  app.get('/api/alertas/config', (req, res) => {
    try {
      res.json({ success: true, config: lerAlertasConfig() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST { telegram: bool, email: bool, destinatarios: string|string[] }
  app.post('/api/alertas/config', (req, res) => {
    try {
      const b = req.body || {};
      const upsert = db.prepare('INSERT OR REPLACE INTO config (chave, valor) VALUES (?, ?)');
      if (b.telegram !== undefined)  upsert.run('alerta_canal_telegram', b.telegram ? '1' : '0');
      if (b.email !== undefined)     upsert.run('alerta_canal_email',    b.email    ? '1' : '0');
      if (b.destinatarios !== undefined) {
        const lista = Array.isArray(b.destinatarios)
          ? b.destinatarios
          : String(b.destinatarios || '').split(/[,;]/);
        const limpos = lista.map(s => String(s).trim()).filter(s => /@.+\./.test(s));
        upsert.run('alerta_email_destinatarios', limpos.join(', '));
      }
      res.json({ success: true, config: lerAlertasConfig() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST → envia um alerta de teste pra exercitar os canais configurados
  app.post('/api/alertas/teste', async (req, res) => {
    try {
      const ts = new Date().toLocaleString('pt-BR');
      await enviarAlerta({
        subject: `[LiciteAgora] ✅ Teste de notificação`,
        body: `✅ <b>Teste de notificação</b>\n` +
              `Hora: <i>${ts}</i>\n\n` +
              `<i>Se você recebeu isso, seus canais de alerta estão funcionando.</i>`,
      });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sniper/logs', (req, res) => {
    try {
      res.json({ success: true, logs: sniper.logs });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== CALIBRAÇÃO ====================

  app.post('/api/sniper/calibrar', async (req, res) => {
    try {
      const resultado = await sniper.calibrarTempo();
      res.json({ success: true, ...resultado });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== LANCE ====================

  // ==================== FILA DE LANCES (via Electron) ====================

  // Phase C (2026-04-23): state movido para instance fields de SniperLance.
  // Acessado via `sniper.X` que o Proxy do sniper roteia pro tenant atual.

  // Phase B (2026-04-23): disputasCache agora é instance field de SniperLance
  // (per-tenant). Alias local delega via Proxy para sniper.disputasCache do
  // tenant atual — toda leitura/escrita fica isolada.
  const disputasCache = new Proxy({}, {
    get(_, prop) { return sniper.disputasCache[prop]; },
    set(_, prop, value) { sniper.disputasCache[prop] = value; return true; },
  });

  // ==================== AUTO-LANCE ENGINE (Phase C: state per-tenant) ====================
  // sniper.autoLanceAtivo, sniper.autoLanceTimerNormal/Rapido/Ultra, sniper.autoLancePendentes,
  // sniper.autoLanceComprasFast, sniper.autoLanceLog, sniper.autoLanceStats, sniper.guardLoops, sniper.guardStats,
  // sniper.blitzDisparados, sniper.filaLances, sniper.resultadosLances, sniper.filaTarefas, sniper.tarefaIdCounter
  // todos vivem em sniper.X (instance field de SniperLance, via Proxy do sniper).

  // Parsear timestamp de Brasília (UTC-3) para Date.
  // Comprasnet retorna datas sem timezone suffix — são sempre horário de Brasília.
  function parseBrasilia(dateStr) {
    if (!dateStr) return null;
    // Se já tem timezone suffix no final (Z, +HH:MM, -HH:MM), parsear direto
    // NÃO usar includes('-0') pois match o mês/dia (ex: 2026-03-05)
    if (/Z$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(dateStr)) return new Date(dateStr);
    // Senão, é Brasília (UTC-3): adicionar sufixo
    return new Date(dateStr + '-03:00');
  }

  function logAuto(msg) {
    const entry = { ts: new Date().toISOString(), msg };
    sniper.autoLanceLog.unshift(entry);
    if (sniper.autoLanceLog.length > 100) sniper.autoLanceLog.pop();
    console.log(`[AutoLance] ${msg}`);
  }

  // ==================== BLITZ MODE ====================
  // sniper.blitzDisparados e sniper.autoLanceTimerUltra são instance fields (Phase C).

  /**
   * A7: Calcula média de tempo real por lance usando sniper_historico.
   * Retorna tempo médio em ms (default 800ms se sem dados).
   */
  function calcularMediaTempoLance(compraId, itemNumero) {
    try {
      const rows = db.prepare(
        `SELECT tempoMs FROM sniper_historico
         WHERE compraId = ? AND itemNumero = ? AND sucesso = 1 AND tempoMs > 0
         ORDER BY timestamp DESC LIMIT 20`
      ).all(compraId, itemNumero);
      if (rows.length === 0) return 800;
      const soma = rows.reduce((s, r) => s + r.tempoMs, 0);
      return Math.round(soma / rows.length);
    } catch (e) {
      return 800;
    }
  }

  // Calcula o próximo degrau respeitando o intervalo mínimo do Comprasnet.
  // Why: Math.round em modo percentual pode arredondar PARA CIMA (ex: 2220,39 * 0,99 = 2198,1861 → 2198,19),
  // violando o intervalo mínimo exigido (Comprasnet responde 422 "Intervalo Mínimo Entre Lances").
  // Math.floor garante que o valor é estritamente abaixo do mínimo permitido pelo último lance.
  function calcularProximoDegrau(valorBase, varMin, tipoVar) {
    if (tipoVar === 'P') {
      const novo = valorBase * (1 - varMin / 100);
      return Math.floor(novo * 100) / 100;
    } else {
      const novo = valorBase - varMin;
      return Math.round(novo * 100) / 100;
    }
  }

  /**
   * A1: Pré-calcula degraus de lance para cobrir o concorrente até valorMinimo.
   * Se estamos ganhando (melhorGeral === nossoValor), retorna vazio — não concorrer consigo mesmo.
   * Se estamos perdendo, começa de melhorGeral - varMin (pula direto para cobrir).
   * Retorna array de lances prontos para enfileirar.
   */
  function calcularBatchLances(cfgItem, liveItem, compraId, maxSteps = 50, modo = 'cobrir') {
    const nossoValor = liveItem.nossoValor;
    const melhorValor = liveItem.melhorValor;
    const varMin = liveItem.variacaoMinima != null ? liveItem.variacaoMinima : cfgItem.variacaoMinima;
    const tipoVar = liveItem.tipoVariacao || 'V';
    const valorMinimo = cfgItem.valorMinimo;
    const situacao = liveItem.situacaoParticipante || liveItem.situacaoParticipanteDisputa;

    if (nossoValor == null || varMin == null || valorMinimo == null) return [];
    if (nossoValor <= valorMinimo) return [];

    // Modo sequencial: descer do nossoValor, ignorando concorrente e situação
    if (modo === 'sequencial') {
      const lances = [];
      let valorAtual = nossoValor;
      let step = 0;
      while (valorAtual > valorMinimo && step < maxSteps) {
        let novoValor = calcularProximoDegrau(valorAtual, varMin, tipoVar);
        // Se o próximo degrau natural já ultrapassa o piso, parar — clampar para valorMinimo
        // criaria step < varMin e o Comprasnet responde 422 "Intervalo Mínimo Entre Lances".
        if (novoValor < valorMinimo) break;
        if (novoValor >= valorAtual) break;
        step++;
        lances.push({
          id: `blitz-${Date.now()}-${step}-${Math.random().toString(36).substring(2, 5)}`,
          compraId, itemNumero: cfgItem.itemNumero, valor: novoValor,
          faseItem: cfgItem.faseItem || 'LA', criadoEm: new Date().toISOString(),
          status: 'pendente', fonte: 'blitz', batchIndex: step - 1, batchTotal: 0,
        });
        valorAtual = novoValor;
        if (novoValor <= valorMinimo) break;
      }
      for (const l of lances) l.batchTotal = lances.length;
      return lances;
    }

    // Se estamos ganhando (melhorGeral é nosso), não dar lance
    if (melhorValor != null && nossoValor <= melhorValor) return [];
    if (situacao === 'G') return [];

    // Ponto de partida: cobrir o concorrente, não descer do nosso valor
    let valorInicial;
    if (melhorValor != null && melhorValor < nossoValor) {
      // Concorrente está na frente — começar abaixo dele
      valorInicial = calcularProximoDegrau(melhorValor, varMin, tipoVar);
    } else {
      // melhorValor desconhecido — fallback para nossoValor
      valorInicial = nossoValor;
    }

    // Cobertura do concorrente caiu abaixo do piso do usuário.
    // O primeiro lance precisa estar em [valorMinimo, calcularProximoDegrau(nossoValor, varMin, tipoVar)]
    // — abaixo do piso é vetado pelo usuário, acima do próximo degrau é vetado pelo Comprasnet.
    if (valorInicial < valorMinimo) {
      const maxRespeitandoVarMin = calcularProximoDegrau(nossoValor, varMin, tipoVar);
      if (maxRespeitandoVarMin < valorMinimo) return [];
      valorInicial = valorMinimo;
    }

    const lances = [];
    let valorAtual = valorInicial;
    let step = 0;

    // Primeiro lance: o valor inicial calculado (cobertura do concorrente)
    if (valorAtual > 0 && valorAtual < nossoValor) {
      // Pular se igual ao melhorValor (Comprasnet rejeita lance igual ao de outro fornecedor)
      const melhorValorRound = melhorValor != null ? Math.round(melhorValor * 100) / 100 : null;
      if (melhorValorRound == null || valorAtual !== melhorValorRound) {
        step++;
        lances.push({
          id: `blitz-${Date.now()}-${step}-${Math.random().toString(36).substring(2, 5)}`,
          compraId,
          itemNumero: cfgItem.itemNumero,
          valor: valorAtual,
          faseItem: cfgItem.faseItem || 'LA',
          criadoEm: new Date().toISOString(),
          status: 'pendente',
          fonte: 'blitz',
          batchIndex: step - 1,
          batchTotal: 0,
        });
      }
    }

    // Degraus seguintes até valorMinimo (limitado por maxSteps)
    while (valorAtual > valorMinimo && step < maxSteps) {
      let novoValor = calcularProximoDegrau(valorAtual, varMin, tipoVar);
      // Se o próximo degrau natural já ultrapassa o piso, parar — clampar para valorMinimo
      // criaria step < varMin e o Comprasnet responde 422 "Intervalo Mínimo Entre Lances".
      if (novoValor < valorMinimo) break;

      if (novoValor >= valorAtual) break;

      // Pular valor igual ao melhorValor
      const melhorValorRound = melhorValor != null ? Math.round(melhorValor * 100) / 100 : null;
      if (melhorValorRound != null && novoValor === melhorValorRound) {
        valorAtual = novoValor;
        continue;
      }

      step++;
      lances.push({
        id: `blitz-${Date.now()}-${step}-${Math.random().toString(36).substring(2, 5)}`,
        compraId,
        itemNumero: cfgItem.itemNumero,
        valor: novoValor,
        faseItem: cfgItem.faseItem || 'LA',
        criadoEm: new Date().toISOString(),
        status: 'pendente',
        fonte: 'blitz',
        batchIndex: step - 1,
        batchTotal: 0,
      });

      valorAtual = novoValor;
      if (novoValor <= valorMinimo) break;
    }

    // Update batchTotal
    for (const l of lances) l.batchTotal = lances.length;

    return lances;
  }

  // ==================== GUARD MODE FUNCTIONS ====================

  // Rastreia mudanças no estado do mercado (melhorGeral, situação)
  // Só registra quando há mudança, não a cada poll
  let guardUltimoEstado = {}; // { 'compraId-itemNum': { melhorGeral, nossoValor, situacao } }

  function registrarEstadoMercado(compraId, apiData, fonte) {
    try {
      const insertStmt = db.prepare(
        `INSERT INTO sniper_classificacao (compraId, itemNumero, melhorGeral, nossoValor, situacao, fonte, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      );

      for (const apiItem of apiData) {
        const itemNum = apiItem.numero || apiItem.identificador;
        const melhorGeral = (apiItem.melhorValorGeral || {}).valorInformado;
        const nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado;
        const situacao = apiItem.situacaoParticipanteDisputa || null;

        const key = `${compraId}-${itemNum}`;
        const anterior = guardUltimoEstado[key];

        // Só registrar se houve mudança
        if (anterior &&
            anterior.melhorGeral === melhorGeral &&
            anterior.nossoValor === nossoValor &&
            anterior.situacao === situacao) {
          continue;
        }

        guardUltimoEstado[key] = { melhorGeral, nossoValor, situacao };
        insertStmt.run(compraId, itemNum, melhorGeral, nossoValor, situacao, fonte);
      }
    } catch (e) {
      // Best-effort
    }
  }

  function updateCacheFromGuardPoll(compraId, apiData) {
    let cached = disputasCache.disputas.find(d => d.compraId === compraId);
    if (!cached) {
      cached = { compraId, itens: [], totalItens: 0, itensAtivos: 0 };
      disputasCache.disputas.push(cached);
    }

    for (const apiItem of apiData) {
      const num = apiItem.numero || apiItem.identificador;
      let cachedItem = cached.itens.find(i => i.numero === num);
      if (!cachedItem) {
        cachedItem = { numero: num };
        cached.itens.push(cachedItem);
      }
      cachedItem.melhorValor = (apiItem.melhorValorGeral || {}).valorInformado ?? cachedItem.melhorValor;
      cachedItem.nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado ?? cachedItem.nossoValor;
      cachedItem.variacaoMinima = apiItem.variacaoMinimaEntreLances ?? cachedItem.variacaoMinima;
      cachedItem.tipoVariacao = apiItem.tipoVariacaoMinimaEntreLances || cachedItem.tipoVariacao || 'V';
      cachedItem.podeEnviar = apiItem.podeEnviarLances ?? cachedItem.podeEnviar;
      cachedItem.fase = apiItem.fase || cachedItem.fase;
      cachedItem.fimContagem = apiItem.dataHoraFimContagem || cachedItem.fimContagem;
      cachedItem.situacaoParticipante = apiItem.situacaoParticipanteDisputa || null;
      cachedItem.estaPerdendo = apiItem.situacaoParticipanteDisputa === 'P';
      cachedItem.emEncAleatoria = (apiItem.situacaoAposContagem === 'EA');
      cachedItem.nosDoisMinFinais = !!(apiItem.dataHoraFimContagem && (parseBrasilia(apiItem.dataHoraFimContagem).getTime() - Date.now()) < 120000);
    }

    cached.totalItens = cached.itens.length;
    cached.itensAtivos = cached.itens.filter(i => i.podeEnviar || i.fase === 'LA').length;
    disputasCache.atualizadoEm = new Date().toISOString();
  }

  async function guardPoll(compraId) {
    const guard = sniper.guardLoops[compraId];
    if (!guard || !guard.active) return;

    // Token check
    if (!sniper.temToken()) {
      logAuto(`GUARD ${compraId}: sem token, pausa 5s`);
      guard.timer = setTimeout(() => guardPoll(compraId), 5000);
      return;
    }

    const inicio = Date.now();
    const endpoint = `/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`;
    try {
      const { status, data } = await sniper.apiGet(endpoint);
      const elapsed = Date.now() - inicio;
      sniper.guardStats.totalPolls++;
      _registrarHealth('guard', endpoint, status, elapsed, status >= 200 && status < 400, null);

      if (status !== 200 && status !== 206) {
        logAuto(`GUARD ${compraId}: HTTP ${status} (${elapsed}ms)`);
        if (status === 401 || status === 403) {
          alertarTokenInvalido(`GUARD ${compraId}`, status).catch(() => {});
        }
        guard.timer = setTimeout(() => guardPoll(compraId), 2000);
        return;
      }

      if (!Array.isArray(data) || data.length === 0) {
        reagendarGuardPoll(compraId, Date.now() - inicio);
        return;
      }

      // Atualizar cache com dados frescos
      updateCacheFromGuardPoll(compraId, data);

      // Registrar mudanças no estado do mercado
      registrarEstadoMercado(compraId, data, 'guard');

      // Alerta proativo: se tem rajada agendada e concorrente já está abaixo do piso,
      // avisa no Telegram (1 vez por agendamento) pra o usuário poder reagir.
      for (const itemNum of guard.itens) {
        const blitzInfo = _proxBlitzFutura(compraId, itemNum);
        if (!blitzInfo) continue;
        const apiItem = data.find(i => (i.numero || i.identificador) === itemNum);
        if (!apiItem) continue;
        const melhorGeral = (apiItem.melhorValorGeral || {}).valorInformado;
        if (melhorGeral == null) continue;
        const cfg = db.prepare('SELECT valorMinimo FROM sniper_itens WHERE compraId = ? AND itemNumero = ?').get(compraId, itemNum);
        if (!cfg || cfg.valorMinimo == null) continue;
        if (melhorGeral < cfg.valorMinimo) {
          alertarMercadoAbaixoDoPiso(compraId, itemNum, blitzInfo, melhorGeral, cfg.valorMinimo);
        }
      }

      // Buscar config dos itens monitorados
      const autoItens = db.prepare(
        `SELECT compraId, itemNumero, valorMinimo, variacaoMinima, tipoVariacao, faseItem
         FROM sniper_itens WHERE compraId = ? AND modoAuto = 'continuo' AND valorMinimo IS NOT NULL`
      ).all(compraId);

      // Auto-stop: remover itens onde disputa fechou — EXCETO se há blitz futuro
      // agendado pro item (caso pré-abertura: API retorna podeEnviarLances=false
      // até o horário marcado da disputa). Manter no Set garante que o GUARD
      // continue armado até o T-0 e tenha cache fresco quando a rajada disparar.
      let anyActive = false;
      for (const itemNum of [...guard.itens]) {
        const apiItem = data.find(i => (i.numero || i.identificador) === itemNum);
        if (apiItem && apiItem.podeEnviarLances) {
          anyActive = true;
        } else if (apiItem && !apiItem.podeEnviarLances) {
          const blitzFuturo = _proxBlitzFutura(compraId, itemNum);
          if (blitzFuturo) {
            // Pré-abertura: segura o item, vai reagendar polling lá embaixo
            continue;
          }
          guard.itens.delete(itemNum);
          logAuto(`GUARD: item ${itemNum} disputa fechou, removido`);
        }
      }
      if (!anyActive || guard.itens.size === 0) {
        // Antes de parar: se algum item tem blitz futuro, reagenda o poll
        // pra acordar perto do disparo (cache fresco no T-0) em vez de desmontar.
        let blitzMaisCedo = null;
        for (const itemNum of guard.itens) {
          const bi = _proxBlitzFutura(compraId, itemNum);
          if (bi && (blitzMaisCedo == null || bi.alvoMs < blitzMaisCedo)) {
            blitzMaisCedo = bi.alvoMs;
          }
        }
        if (blitzMaisCedo != null) {
          const restanteAteT60 = blitzMaisCedo - 60000 - Date.now();
          // Dorme até T-60s (cap 30s pra não ficar surdo demais); se faltam <60s,
          // já entra em modo agressivo via ramp.
          const sleep = restanteAteT60 > 0 ? Math.min(restanteAteT60, 30000) : 2000;
          logAuto(`GUARD ${compraId}: aguardando abertura, próximo poll em ${Math.round(sleep/1000)}s (blitz T=${new Date(blitzMaisCedo).toISOString()})`);
          guard.timer = setTimeout(() => guardPoll(compraId), sleep);
          return;
        }
        pararGuard(compraId, null);
        return;
      }

      // Verificar cada item monitorado
      for (const cfgItem of autoItens) {
        if (!guard.itens.has(cfgItem.itemNumero)) continue;

        const apiItem = data.find(i => (i.numero || i.identificador) === cfgItem.itemNumero);
        if (!apiItem) continue;

        const sit = apiItem.situacaoParticipanteDisputa;
        const melhorGeral = (apiItem.melhorValorGeral || {}).valorInformado;
        const nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado;
        const varMin = apiItem.variacaoMinimaEntreLances;
        const tipoVar = apiItem.tipoVariacaoMinimaEntreLances || 'V';

        if (sit === 'P' && melhorGeral != null && varMin != null) {
          // Perdendo — calcular lance reativo
          let novoValor = calcularProximoDegrau(melhorGeral, varMin, tipoVar);

          // Respeitar piso — mas sem violar varMin em relação ao nossoValor.
          // Se a cobertura cai abaixo do piso, só clampa se o clamp respeitar varMin.
          if (novoValor < cfgItem.valorMinimo) {
            if (nossoValor != null) {
              const maxRespeitandoVarMin = calcularProximoDegrau(nossoValor, varMin, tipoVar);
              if (maxRespeitandoVarMin < cfgItem.valorMinimo) continue; // impossível descer respeitando as duas regras
            }
            novoValor = cfgItem.valorMinimo;
          }
          // Já no piso
          if (nossoValor != null && nossoValor <= cfgItem.valorMinimo) continue;
          // Valor não melhora
          if (nossoValor != null && novoValor >= nossoValor) continue;
          // Pular valor igual ao melhorGeral (Comprasnet rejeita)
          const melhorGeralRound = Math.round(melhorGeral * 100) / 100;
          if (novoValor === melhorGeralRound) {
            // Tentar um degrau a mais
            novoValor = calcularProximoDegrau(novoValor, varMin, tipoVar);
            if (novoValor < cfgItem.valorMinimo) continue;
          }

          // Não duplicar na fila
          const jaEnfileirado = sniper.filaLances.some(l =>
            l.compraId === compraId && l.itemNumero === cfgItem.itemNumero &&
            (l.status === 'pendente' || l.status === 'processando')
          );
          if (jaEnfileirado) continue;

          // Não interferir com blitz em execução (últimos 5s)
          const blitzKey = `${compraId}-${cfgItem.itemNumero}`;
          const blitzRecente = sniper.blitzDisparados[blitzKey];
          if (blitzRecente && (Date.now() - blitzRecente) < 5000) continue;

          sniper.guardStats.detections++;
          sniper.autoLanceStats.lancesEnviados++;

          logAuto(`⚡ GUARD DETECTED: ${compraId} item ${cfgItem.itemNumero} sit=P — ` +
            `lance R$${novoValor.toFixed(2)} DIRETO (melhor=R$${melhorGeral}, nosso=R$${nossoValor}, var=${varMin}, ${elapsed}ms)`);

          // Enviar direto pelo servidor (async, não bloqueia o loop)
          sniper.enviarLance(compraId, cfgItem.itemNumero, novoValor, cfgItem.faseItem || 'LA').then(resultado => {
            const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
            try { db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, cfgItem.itemNumero, novoValor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'guard-servidor', new Date().toISOString()); } catch (e) {}
            sniper.guardStats.lancesEnqueued++;
            if (resultado.sucesso) logAuto(`⚡ GUARD OK: ${compraId} item ${cfgItem.itemNumero} R$${novoValor.toFixed(2)} (${resultado.tempoMs}ms)`);
            else logAuto(`⚡ GUARD FALHA: ${compraId} item ${cfgItem.itemNumero} HTTP ${resultado.status}`);
          }).catch(() => {});
        }
      }

      reagendarGuardPoll(compraId, elapsed);

    } catch (e) {
      const elapsed = Date.now() - inicio;
      logAuto(`GUARD ${compraId}: erro ${e.message}`);
      _registrarHealth('guard', endpoint, 0, elapsed, false, e.message);
      guard.timer = setTimeout(() => guardPoll(compraId), 2000);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // HEALTH COMPRASNET — capture, ping ativo, alerta degradação
  // ════════════════════════════════════════════════════════════════════
  // Rolling window pra detectar degradação. Mantém últimos N eventos.
  const _healthBuffer = []; // {ts, ok}
  const _HEALTH_WINDOW_MS = 60000; // 60s
  const _HEALTH_ALERT_RATE = 0.5;  // alerta se >50% falham na janela
  const _HEALTH_MIN_SAMPLES = 4;   // mín amostras pra avaliar
  let _ultimoHealthAlertMs = 0;
  const _HEALTH_ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5min entre alertas

  function _registrarHealth(tipo, endpoint, httpStatus, tempoMs, ok, erro) {
    try {
      db.prepare(`INSERT INTO comprasnet_health (tipo, endpoint, httpStatus, tempoMs, ok, erro)
                  VALUES (?, ?, ?, ?, ?, ?)`).run(tipo, endpoint, httpStatus, tempoMs, ok ? 1 : 0, erro || null);
    } catch (_) { /* table pode não existir ainda em tenants antigos */ }
    // Mantém buffer in-memory pra avaliar degradação
    const agora = Date.now();
    _healthBuffer.push({ ts: agora, ok: !!ok });
    while (_healthBuffer.length > 0 && (agora - _healthBuffer[0].ts) > _HEALTH_WINDOW_MS) {
      _healthBuffer.shift();
    }
    if (_healthBuffer.length >= _HEALTH_MIN_SAMPLES) {
      const falhas = _healthBuffer.filter(h => !h.ok).length;
      const taxa = falhas / _healthBuffer.length;
      if (taxa >= _HEALTH_ALERT_RATE && (agora - _ultimoHealthAlertMs) > _HEALTH_ALERT_COOLDOWN_MS) {
        _ultimoHealthAlertMs = agora;
        const msg = `🚨 Comprasnet DEGRADADO: ${falhas}/${_healthBuffer.length} falhas em ${Math.round(_HEALTH_WINDOW_MS/1000)}s (taxa ${Math.round(taxa*100)}%)`;
        console.error(`[HEALTH] ${msg}`);
        logAuto(msg);
        // Telegram só em horário comercial (seg-sex 08h-18h, TZ do servidor = America/Sao_Paulo)
        const _ag = new Date();
        const _dia = _ag.getDay(), _h = _ag.getHours();
        const _comercial = _dia >= 1 && _dia <= 5 && _h >= 8 && _h < 18;
        if (_comercial) {
          try { sendTelegram(db, msg).catch(() => {}); } catch (_) {}
        }
      }
    }
  }

  // Ping ativo: a cada 30s bate em /datahorabrasilia (endpoint trivial) pra ter
  // sinal contínuo de saúde mesmo sem GUARDs ativos. Disparado per-tenant em
  // _iniciarAgendamentoTenant via _pingHealthTickRef, DENTRO de tenantStorage.run —
  // assim os Proxies sniper/db resolvem pro tenant certo (senão o INSERT é engolido
  // e nenhuma amostra 'ping' é gravada, como acontecia no setTimeout global anterior).
  async function _pingHealthTick(tenant, tenantDb) {
    await tenantStorage.run({ kind: 'tenant', tenant, db: tenantDb }, async () => {
      if (!sniper.temToken()) return;
      const t0 = Date.now();
      try {
        const { status } = await sniper.apiGet('/comprasnet-disputa/v1/datahorabrasilia');
        _registrarHealth('ping', '/datahorabrasilia', status, Date.now() - t0, status >= 200 && status < 400, null);
      } catch (e) {
        _registrarHealth('ping', '/datahorabrasilia', 0, Date.now() - t0, false, e.message);
      }
    });
  }
  _pingHealthTickRef = _pingHealthTick;

  // Reagenda o próximo poll do Guard aplicando:
  //  1) Ramp dinâmico via calcularIntervalGuard(alvoMs) — longe é barato, perto é agressivo
  //  2) Auto-backoff: 3 polls seguidos mais lentos que o interval dobram o próximo sleep (até 2s)
  //     Previne pile-up quando Comprasnet degrada.
  function reagendarGuardPoll(compraId, elapsed) {
    const guard = sniper.guardLoops[compraId];
    if (!guard || !guard.active) return;

    // Recalcula interval-base pelo alvoMs (pode ter avançado pra próxima fase)
    guard.intervalMs = calcularIntervalGuard(guard.alvoMs);

    // Backoff adaptativo
    if (elapsed != null && elapsed > guard.intervalMs) {
      guard.lentidaoSeguida = (guard.lentidaoSeguida || 0) + 1;
    } else {
      guard.lentidaoSeguida = 0;
    }

    let intervalEfetivo = guard.intervalMs;
    if (guard.lentidaoSeguida >= 3) {
      intervalEfetivo = Math.min(intervalEfetivo * 2, 2000);
    }

    guard.timer = setTimeout(() => guardPoll(compraId), intervalEfetivo);
  }

  // Gate compartilhado: motor de lances ligado?
  // Cache simples de 5s (mesma cadência do cache no sniper-lance.js).
  let _motorCache = null;
  function motorLigado() {
    const agora = Date.now();
    if (!_motorCache || agora > _motorCache.expira) {
      let ligado = true;
      try {
        const row = db.prepare("SELECT valor FROM config WHERE chave='sniper_motor_enabled'").get();
        ligado = row ? row.valor !== '0' : true;
      } catch (_) { ligado = true; }
      _motorCache = { valor: ligado, expira: agora + 5000 };
    }
    return _motorCache.valor;
  }

  // Calcula interval de poll conforme tempo até o disparo (alvoMs).
  // Sem alvoMs → fallback 200ms (modo contínuo/pós-blitz).
  // Com alvoMs → ramp: longe é barato, perto é agressivo, no disparo é o mínimo viável com keep-alive.
  function calcularIntervalGuard(alvoMs) {
    if (!alvoMs) return 200;
    const restante = alvoMs - Date.now();
    if (restante < 0) return 200;                 // pós-disparo
    if (restante <= 3000) return 60;              // janela de rajada
    if (restante <= 10000) return 100;            // crítico
    if (restante <= 60000) return 250;            // close
    if (restante <= 300000) return 800;           // mid
    return 2000;                                  // far
  }

  // Plano 16: Guard é sempre ligado (removido toggle). Decisão de usuário
  // passou a ser o motor de lances (enviarLance gate). O Guard continua
  // vital para manter cache fresco e apoiar precisão de rajadas.
  // alvoMs opcional — quando informado, liga o polling degradê (ramp-up próximo do disparo).
  function iniciarGuard(compraId, itemNumero, alvoMs = null) {
    if (!sniper.guardLoops[compraId]) {
      const intervalInicial = calcularIntervalGuard(alvoMs);
      sniper.guardLoops[compraId] = {
        active: true,
        timer: null,
        itens: new Set(),
        intervalMs: intervalInicial,
        alvoMs: alvoMs,
        lentidaoSeguida: 0,
        iniciadoEm: new Date().toISOString(),
      };
      const alvoStr = alvoMs ? ` (disparo em ${Math.round((alvoMs - Date.now())/1000)}s, ramp dinâmico)` : ` (polling ${intervalInicial}ms)`;
      logAuto(`⚡ GUARD START: ${compraId}${alvoStr}`);
      guardPoll(compraId);
    } else if (alvoMs && !sniper.guardLoops[compraId].alvoMs) {
      // Guard já existe mas sem alvoMs — upgrade para ramp dinâmico
      sniper.guardLoops[compraId].alvoMs = alvoMs;
    }
    sniper.guardLoops[compraId].itens.add(itemNumero);
  }

  // Agenda tarefas de pré-disparo para uma rajada:
  //   T−30s: recalibração de clock com Comprasnet (offsetServidorMs)
  //   T−1s:  warmup TLS — abre (itensCount+2) sockets em paralelo no pool
  //
  // Padrão usado por:
  //   - agendarBlitz (individual)
  //   - agendar-blitz-global
  //   - agendarBlitzRecuperada (recovery após restart)
  //
  // Retorna lista de timer IDs para o chamador poder cancelar se precisar.
  function agendarPreDisparoTasks(alvoMs, itensCount = 1, tag = 'BLITZ', compraIds = []) {
    const timers = [];
    const delayMs = alvoMs - Date.now();
    const agendados = [];

    // Alerta T−30min: se ainda não há token Bearer, manda Telegram/email pedindo
    // pro usuário abrir o Electron. Sem isso, a rajada vai abortar em "sem live
    // data" (incidente 2026-05-19 com licitação 98092106000282026).
    // Só dispara se o agendamento foi feito com >31min de antecedência —
    // blitz agendada in extremis não tem tempo de alertar.
    if (delayMs > 31 * 60 * 1000) {
      timers.push(setTimeout(() => {
        if (sniper.temToken()) return; // token chegou no meio do caminho, tudo bem
        const minutosRestantes = Math.max(1, Math.round((alvoMs - Date.now()) / 60000));
        const compraIdsStr = Array.isArray(compraIds) && compraIds.length > 0
          ? compraIds.slice(0, 3).join(', ') + (compraIds.length > 3 ? ` +${compraIds.length - 3}` : '')
          : '?';
        const alvoBrt = new Date(alvoMs).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const corpo =
          `⚠️ <b>BLITZ SEM TOKEN — abra o Electron agora</b>\n\n` +
          `Faltam <b>~${minutosRestantes} min</b> para o disparo e o servidor não tem token Bearer do Comprasnet. Sem token, a rajada <b>vai abortar</b>.\n\n` +
          `Compra(s): <code>${compraIdsStr}</code>\n` +
          `Itens: ${itensCount}\n` +
          `Alvo: ${alvoBrt}\n\n` +
          `<b>Ação:</b> abra o Comprasnet pelo Electron LiciteAgora e faça login.`;
        enviarAlerta({
          subject: `[LiciteAgora] ⚠️ Blitz em ${minutosRestantes}min sem token Bearer`,
          body: corpo,
        }).catch(e => console.error(`[${tag}] alerta T-30min sem-token falhou: ${e.message}`));
        console.log(`[${tag}] ⚠️ Alerta T-30min disparado: sem token Bearer (compraIds=${compraIdsStr})`);
        try { logAuto(`⚠️ Alerta T-30min: blitz sem token (${compraIdsStr})`); } catch (e) {}
      }, delayMs - 30 * 60 * 1000));
      agendados.push('alerta-sem-token@T-30min');
    }

    // Recalibração T−30s: só faz sentido se ainda dá tempo (>35s de margem).
    if (delayMs > 35000) {
      timers.push(setTimeout(() => {
        sniper.calibrarTempo()
          .then(r => console.log(`[${tag}] ✅ Recalibração pré-disparo: offset=${r.offset}ms, latência=${r.latencia}ms`))
          .catch(() => {});
      }, delayMs - 30000));
      agendados.push('recalibração@T-30s');
    }

    // Warmup TLS T−1s: abre (itensCount+2) sockets em paralelo no pool.
    // Health-check ativo (2026-05-25): detecta 502/timeout/4xx em vez de
    // engolir silenciosamente. Se >50% das chamadas falharem, agenda retry
    // automático em T-500ms (talvez Comprasnet recupere antes do disparo).
    if (delayMs > 2000) {
      const numConexoes = Math.max(3, itensCount + 2);
      const doWarmup = async (label, recheckTimer) => {
        const t0 = Date.now();
        const resultados = await Promise.all(
          Array.from({ length: numConexoes }, () =>
            sniper.apiGet('/comprasnet-disputa/v1/datahorabrasilia')
              .then(r => ({ ok: r.status >= 200 && r.status < 400, status: r.status, ms: Date.now() - t0 }))
              .catch(e => ({ ok: false, status: 0, ms: Date.now() - t0, err: e.message }))
          )
        );
        const ok = resultados.filter(r => r.ok).length;
        const totalMs = Date.now() - t0;
        const statuses = resultados.map(r => r.status || 'TO').join(',');
        if (ok === numConexoes) {
          console.log(`[${tag}] ✅ Warmup ${label} ${numConexoes}/${numConexoes} OK em ${totalMs}ms`);
        } else if (ok / numConexoes >= 0.5) {
          console.warn(`[${tag}] ⚠️ Warmup ${label} parcial ${ok}/${numConexoes} (statuses=${statuses}, ${totalMs}ms) — Comprasnet instável`);
          logAuto(`⚠️ Warmup ${label} parcial ${ok}/${numConexoes} (${statuses})`);
        } else {
          console.error(`[${tag}] 🚨 Warmup ${label} FALHOU ${ok}/${numConexoes} (statuses=${statuses}, ${totalMs}ms) — Comprasnet provavelmente fora`);
          logAuto(`🚨 Warmup ${label} FALHOU ${ok}/${numConexoes} — disparo pode falhar`);
        }
        return { ok, total: numConexoes };
      };
      // Warmup T-1s
      timers.push(setTimeout(async () => {
        const r = await doWarmup('T-1s');
        // Retry T-500ms se ≤50% sucesso
        if (r.ok / r.total < 0.5) {
          timers.push(setTimeout(() => doWarmup('T-500ms-RETRY'), 500));
        }
      }, delayMs - 1000));
      agendados.push(`warmup-${numConexoes}x@T-1s(+retry)`);
    }

    // Cache refresh T−200ms: GET /itens/em-disputa por compraId pra ter
    // melhorValor/nossoValor o mais frescos possível na hora do disparo.
    // Latência média ~120ms → resposta volta em T−80ms, updateCacheFromGuardPoll
    // roda em <5ms, disparo a T-0 com mercado atual. Sem isso o cache pode estar
    // até 10s velho (frequência do tickRefresh) — bug clássico de race com o
    // concorrente que motivou esse refresh.
    if (delayMs > 500 && Array.isArray(compraIds) && compraIds.length > 0) {
      timers.push(setTimeout(() => {
        if (!sniper.temToken()) return;
        for (const cId of compraIds) {
          sniper.apiGet(`/comprasnet-disputa/v1/compras/${cId}/itens/em-disputa`)
            .then(({ status, data }) => {
              if ((status === 200 || status === 206) && Array.isArray(data)) {
                updateCacheFromGuardPoll(cId, data);
                console.log(`[${tag}] ✅ Cache refresh T-200ms: ${cId} (${data.length} itens)`);
              }
            })
            .catch(() => {});
        }
      }, delayMs - 200));
      agendados.push('cache-refresh@T-200ms');
    }

    if (agendados.length > 0) {
      console.log(`[${tag}] Pré-disparo agendado para T=${new Date(alvoMs).toISOString()}: ${agendados.join(', ')}`);
    }

    return timers;
  }

  // Notifica via Telegram o resultado de uma rajada.
  // Pós-blitz: lê o estado atualizado do cache (melhorValorGeral, nossoValor)
  // e manda mensagem formatada. Silencioso em erro (nunca atrapalha o fluxo).
  async function notificarResultadoBlitz(compraId, itemNumero, extras = {}) {
    try {
      // Refresh do estado pós-blitz: última resposta da API vem como array de itens
      let snapshot = null;
      if (sniper.temToken()) {
        try {
          const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`);
          if ((status === 200 || status === 206) && Array.isArray(data)) {
            snapshot = data.find(i => (i.numero || i.identificador) === itemNumero);
          }
        } catch (_) {}
      }

      // Fallback: usa cache se o GET falhou
      if (!snapshot) {
        const cached = disputasCache.disputas.find(d => d.compraId === compraId);
        const liveItem = cached && cached.itens ? cached.itens.find(i => i.numero === itemNumero) : null;
        if (liveItem) {
          snapshot = {
            numero: itemNumero,
            melhorValorGeral: { valorInformado: liveItem.melhorValor },
            melhorValorFornecedor: { valorInformado: liveItem.nossoValor },
            situacaoParticipanteDisputa: liveItem.situacaoParticipante,
          };
        }
      }

      if (!snapshot) {
        console.warn(`[TELEGRAM] sem snapshot para ${compraId} item ${itemNumero} — notificação abortada`);
        return;
      }

      const melhor = (snapshot.melhorValorGeral || {}).valorInformado;
      const nosso = (snapshot.melhorValorFornecedor || {}).valorInformado;
      const sit = snapshot.situacaoParticipanteDisputa;
      const ganhando = nosso != null && melhor != null && nosso <= melhor;
      const sucessos = extras.sucessos || 0;
      const falhas = extras.falhas || 0;

      const titulo = ganhando ? '🏆 <b>MELHOR COLOCADO</b>' : '⚠️ <b>Não ganhamos</b>';
      const fmtR$ = v => v != null ? `R$ ${Number(v).toFixed(2).replace('.', ',')}` : '—';
      const linhaMotivo = extras.motivo ? `\nMotivo: <i>${extras.motivo}</i>` : '';

      const mensagem =
        `${titulo}\n` +
        `Compra: <code>${compraId}</code>\n` +
        `Item: <b>${itemNumero}</b>\n` +
        `Nosso: <b>${fmtR$(nosso)}</b>\n` +
        `Melhor: ${fmtR$(melhor)}\n` +
        `Situação: ${sit || '—'}\n` +
        `Rajada: ${sucessos} ✅ / ${falhas} ❌` +
        linhaMotivo;

      const subject = ganhando
        ? `[LiciteAgora] 🏆 Melhor colocado — ${compraId} item ${itemNumero}`
        : `[LiciteAgora] ⚠️ Não ganhamos — ${compraId} item ${itemNumero}`;
      await enviarAlerta({ subject, body: mensagem });
      console.log(`[ALERTA] notificação enviada: ${compraId} item ${itemNumero} — ganhando=${ganhando}`);
    } catch (e) {
      console.error(`[ALERTA] erro ao notificar: ${e.message}`);
    }
  }

  // Dedup: 1 alerta de "mercado abaixo do piso" por blitz agendada.
  // Chave inclui agendadoEm pra re-alertar se o usuário reagenda (nova rajada = nova chance de ajustar).
  const _alertasPisoEnviados = new Set();

  // Dedup de "disputa iniciou sem blitz agendado". Chave: tenant-compraId-item-fase.
  // Reset quando a fase muda ou quando o item é removido da config.
  const _alertasDisputaIniciada = new Set();

  // Hora do dia (BRT) em que o digest diário de interesses pendentes deve disparar.
  const HORA_DIGEST_INTERESSES = 8;

  // Lê config per-tenant dos canais de alerta. Defaults preservam compatibilidade:
  //   telegram ON, email OFF, destinatarios vazio.
  function lerAlertasConfig() {
    const get = (chave) => {
      const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
      return row ? row.valor : null;
    };
    const telegram = get('alerta_canal_telegram');
    const email = get('alerta_canal_email');
    const destinatariosRaw = get('alerta_email_destinatarios') || '';
    return {
      telegram: telegram == null ? true : telegram === '1',
      email: email === '1',
      destinatarios: destinatariosRaw.split(/[,;]/).map(s => s.trim()).filter(Boolean),
    };
  }

  // Despacha alertas pros canais habilitados do tenant. Mesmo corpo HTML é
  // usado em ambos (Telegram aceita um subset de HTML; o email envelopa).
  // Erros num canal não bloqueiam o outro — cada um loga e segue.
  async function enviarAlerta({ subject, body }) {
    const cfg = lerAlertasConfig();
    const tarefas = [];
    if (cfg.telegram) {
      tarefas.push(
        sendTelegram(db, body).catch(e => console.error(`[ALERTA] telegram falhou: ${e.message}`))
      );
    }
    if (cfg.email && cfg.destinatarios.length > 0) {
      tarefas.push(
        enviarEmailAlerta(db, { subject, htmlBody: body, to: cfg.destinatarios })
          .catch(e => console.error(`[ALERTA] email falhou: ${e.message}`))
      );
    }
    if (tarefas.length === 0) return; // nenhum canal ativo, no-op silencioso
    await Promise.all(tarefas);
  }

  async function alertarMercadoAbaixoDoPiso(compraId, itemNumero, blitzInfo, melhorGeral, piso) {
    try {
      const dedupKey = `${compraId}-${itemNumero}@${blitzInfo.agendadoEm || ''}`;
      if (_alertasPisoEnviados.has(dedupKey)) return;
      _alertasPisoEnviados.add(dedupKey);

      const secUntilDisparo = blitzInfo.alvoMs ? Math.round((blitzInfo.alvoMs - Date.now()) / 1000) : null;
      const tempoTexto = secUntilDisparo != null
        ? (secUntilDisparo > 60 ? `${Math.round(secUntilDisparo/60)}min` : `${secUntilDisparo}s`)
        : blitzInfo.horario || '—';
      const fmtR$ = v => v != null ? `R$ ${Number(v).toFixed(2).replace('.', ',')}` : '—';

      const mensagem =
        `🚨 <b>RAJADA SEM EFEITO</b>\n` +
        `Compra: <code>${compraId}</code>\n` +
        `Item: <b>${itemNumero}</b>\n` +
        `Concorrente: <b>${fmtR$(melhorGeral)}</b>\n` +
        `Seu piso: <b>${fmtR$(piso)}</b>\n` +
        `Disparo: <b>${blitzInfo.horario || '—'}</b> (em ${tempoTexto})\n\n` +
        `<i>O concorrente já está abaixo do seu piso. A rajada vai gerar 0 lances. ` +
        `Abaixe o piso agora ou cancele se não quiser disputar.</i>`;

      await enviarAlerta({ subject: `[LiciteAgora] 🚨 Rajada sem efeito — ${compraId} item ${itemNumero}`, body: mensagem });
      console.log(`[ALERTA] 🚨 piso abaixo do concorrente: ${compraId} item ${itemNumero} — melhor=${melhorGeral} piso=${piso}`);
    } catch (e) {
      console.error(`[ALERTA] erro ao alertar piso: ${e.message}`);
    }
  }

  // Alerta de token inválido / morto. Dedup via flag em sniper instance (per-tenant).
  // Flag reseta quando setToken() é chamado com bearer novo (sniper-lance.js).
  async function alertarTokenInvalido(motivo, status) {
    try {
      if (sniper._tokenMortoAlertado) return;
      sniper._tokenMortoAlertado = true;

      const idade = sniper.tokenRecebidoEm ? Math.round(sniper.idadeTokenSegundos()) : null;
      const idadeTexto = idade != null
        ? (idade < 60 ? `${idade}s` : `${Math.round(idade/60)}min`)
        : '—';
      const fonteTexto = sniper.tokenSource || '—';

      const mensagem =
        `🔐 <b>TOKEN COMPRASNET INVÁLIDO</b>\n` +
        `Status: <b>HTTP ${status}</b>\n` +
        `Origem da detecção: <code>${motivo}</code>\n` +
        `Fonte do token atual: <b>${fonteTexto}</b>\n` +
        `Idade: <b>${idadeTexto}</b>\n\n` +
        `<i>Renove o bearer no Electron (qualquer ação autenticada no Comprasnet ` +
        `dispara o interceptor). Sem token válido, polling e disparos falham.</i>`;

      await enviarAlerta({ subject: `[LiciteAgora] 🔐 Token Comprasnet inválido`, body: mensagem });
      console.log(`[ALERTA] 🔐 token inválido alertado (${motivo}, HTTP ${status})`);
    } catch (e) {
      console.error(`[ALERTA] erro ao alertar token: ${e.message}`);
    }
  }

  // Alerta de SSO morto (Electron preso no login gov.br/hCaptcha, parou de capturar
  // Bearer). Dedup por episódio via flag no sniper — reseta quando o heartbeat volta
  // com ssoMorto=0 (login manual feito).
  async function alertarSSOMorto(hb) {
    try {
      if (sniper._ssoMortoAlertado) return;
      sniper._ssoMortoAlertado = true;

      const idadeMin = hb.tokenAgeSec != null ? Math.round(hb.tokenAgeSec / 60) : null;
      const mensagem =
        `🔴 <b>ELECTRON — SSO COMPRASNET MORTO</b>\n` +
        `O robô parou de capturar o Bearer e está preso no login gov.br (hCaptcha).\n` +
        `Versão: <b>${hb.versao || '—'}</b> · Token: <b>${hb.tokenPresent ? 'presente' : 'ausente'}</b>` +
        (idadeMin != null ? ` (idade ${idadeMin} min)` : '') + `\n\n` +
        `<i>Ação: abra a janela do Electron e faça o login gov.br manualmente (resolver o hCaptcha + senha). ` +
        `NÃO recarregue páginas do Comprasnet. Assim que logar, a captura volta sozinha.</i>`;

      const subject = `[LiciteAgora] 🔴 Electron SSO morto — precisa login manual`;
      await enviarAlerta({ subject, body: mensagem });
      // Fallback: sem destinatário de alerta configurado → envia pro e-mail do próprio
      // tenant (SMTP fromEmail) pra garantir que o alerta chegue.
      if (!lerAlertasConfig().destinatarios.length) {
        try {
          const { loadSmtpConfig, enviarEmailAlerta } = require('./email-client');
          const smtp = loadSmtpConfig(db);
          if (smtp && smtp.fromEmail) {
            await enviarEmailAlerta(db, { subject, htmlBody: mensagem.replace(/\n/g, '<br>'), to: [smtp.fromEmail] });
          }
        } catch (e) { console.error(`[ALERTA] fallback SSO morto falhou: ${e.message}`); }
      }
      console.log('[ALERTA] 🔴 SSO morto alertado');
    } catch (e) {
      console.error(`[ALERTA] erro ao alertar SSO morto: ${e.message}`);
    }
  }

  // Alerta de "disputa iniciou mas item ativo não tem blitz agendado".
  // Item ativo = sniper_itens.ativo=1 com valorMinimo configurado.
  // Dedup: tenant-compraId-item-fase (re-alerta se a fase muda).
  async function alertarDisputaIniciadaSemBlitz(compraId, itemNumero, apiItem, cfgItem) {
    try {
      const tenant = currentTenant();
      const slug = tenant && tenant.slug ? tenant.slug : 'unknown';
      const fase = apiItem.fase || 'LA';
      const dedupKey = `${slug}-${compraId}-${itemNumero}-${fase}`;
      if (_alertasDisputaIniciada.has(dedupKey)) return;
      _alertasDisputaIniciada.add(dedupKey);

      const fmtR$ = v => v != null ? `R$ ${Number(v).toFixed(2).replace('.', ',')}` : '—';
      const melhorGeral = (apiItem.melhorValorGeral || {}).valorInformado;
      const nossoValor  = (apiItem.melhorValorFornecedor || {}).valorInformado;

      const mensagem =
        `⚠️ <b>DISPUTA INICIOU SEM AGENDAMENTO</b>\n` +
        `Compra: <code>${compraId}</code>\n` +
        `Item: <b>${itemNumero}</b>\n` +
        `Fase: <b>${fase}</b>\n` +
        `Seu piso: <b>${fmtR$(cfgItem.valorMinimo)}</b>\n` +
        `Concorrente: <b>${fmtR$(melhorGeral)}</b>\n` +
        `Seu valor: <b>${fmtR$(nossoValor)}</b>\n\n` +
        `<i>O item está aceitando lances agora mas você não tem blitz agendada. ` +
        `Agende uma rajada ou mude o item pro modo contínuo se quiser proteção reativa.</i>`;

      await enviarAlerta({ subject: `[LiciteAgora] ⚠️ Disputa iniciou sem agendamento — ${compraId} item ${itemNumero}`, body: mensagem });
      console.log(`[ALERTA] ⚠️ disputa-sem-blitz alertado: ${compraId} item ${itemNumero} (fase ${fase})`);
    } catch (e) {
      console.error(`[ALERTA] erro ao alertar disputa-sem-blitz: ${e.message}`);
    }
  }

  // Digest diário (Telegram): lista licitações em "interesse" cuja proposta
  // ainda não foi enviada (participacoes_comprasnet.situacao != 'PE').
  // Agrupado por licitação. Cada licitação lista os itens pendentes.
  async function enviarDigestInteressesPendentes() {
    let rows;
    try {
      rows = db.prepare(`
        SELECT
          i.cnpj, i.ano, i.sequencial, i.numeroItem,
          l.objetoCompra,
          l.razaoSocial as nomeOrgao,
          l.dataEncerramentoProposta,
          l.numeroCompra,
          l.modalidadeNome,
          l.codigoUnidade,
          it.descricao as itemDescricao,
          pc.situacao as situacaoParticipacao
        FROM interesse i
        LEFT JOIN licitacoes l ON i.cnpj = l.cnpj
          AND i.ano = l.anoCompra AND i.sequencial = l.sequencialCompra
        LEFT JOIN itens it ON l.id = it.licitacaoId AND i.numeroItem = it.numeroItem
        LEFT JOIN participacoes_comprasnet pc
          ON pc.cnpj = substr(i.cnpj, 1, 8)
          AND pc.ano = i.ano AND pc.sequencial = i.sequencial
        WHERE
          (pc.situacao IS NULL OR pc.situacao != 'PE')
          AND (l.dataEncerramentoProposta IS NULL
               OR l.dataEncerramentoProposta = ''
               OR l.dataEncerramentoProposta > datetime('now'))
        ORDER BY l.dataEncerramentoProposta ASC, i.cnpj, i.ano, i.sequencial, i.numeroItem
      `).all();
    } catch (e) {
      console.error(`[DIGEST] erro na query: ${e.message}`);
      return;
    }

    if (!rows || rows.length === 0) return; // Nada pendente, não envia digest vazio

    // Agrupar por licitação (cnpj-ano-sequencial)
    const grupos = new Map();
    for (const r of rows) {
      const key = `${r.cnpj}-${r.ano}-${r.sequencial}`;
      if (!grupos.has(key)) {
        grupos.set(key, {
          objetoCompra: r.objetoCompra || 'Objeto não disponível',
          nomeOrgao: r.nomeOrgao || '',
          numeroCompra: r.numeroCompra || '',
          modalidadeNome: r.modalidadeNome || '',
          dataEncerramentoProposta: r.dataEncerramentoProposta || '',
          itens: [],
        });
      }
      if (r.numeroItem) {
        grupos.get(key).itens.push({
          numero: r.numeroItem,
          descricao: r.itemDescricao || '',
        });
      }
    }

    const fmtData = iso => {
      if (!iso) return 'sem data';
      try {
        const d = new Date(iso);
        return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch (_) { return iso; }
    };
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const linhas = [];
    linhas.push(`📋 <b>RESUMO DIÁRIO — Interesses pendentes</b>`);
    linhas.push(`<i>${grupos.size} licitação(ões) sem proposta enviada</i>\n`);

    for (const [, g] of grupos) {
      const cabecalho = `▪ <b>${esc(g.modalidadeNome || 'Licitação')} ${esc(g.numeroCompra || '?')}</b> · ${esc(g.nomeOrgao || '?')}`;
      const enc = `   <i>Encerra: ${fmtData(g.dataEncerramentoProposta)}</i>`;
      const obj = `   ${esc((g.objetoCompra || '').substring(0, 120))}${g.objetoCompra && g.objetoCompra.length > 120 ? '…' : ''}`;
      linhas.push(cabecalho);
      linhas.push(enc);
      linhas.push(obj);
      const maxItens = 5;
      const itensMostrados = g.itens.slice(0, maxItens);
      for (const it of itensMostrados) {
        const desc = (it.descricao || '').substring(0, 80);
        linhas.push(`   • Item ${it.numero}: ${esc(desc)}${it.descricao && it.descricao.length > 80 ? '…' : ''}`);
      }
      if (g.itens.length > maxItens) linhas.push(`   <i>+ ${g.itens.length - maxItens} item(ns)…</i>`);
      linhas.push('');
    }

    const mensagem = linhas.join('\n');
    try {
      await enviarAlerta({ subject: `[LiciteAgora] 📋 Resumo diário — ${grupos.size} interesse(s) pendente(s)`, body: mensagem });
      console.log(`[ALERTA] 📋 digest interesses: ${grupos.size} licitação(ões), ${rows.length} item(ns)`);
    } catch (e) {
      console.error(`[ALERTA] erro ao enviar digest: ${e.message}`);
      throw e; // propaga pra scanAlertas não marcar como enviado
    }
  }

  // Scanner periódico (30s) chamado per-tenant em _iniciarAgendamentoTenant.
  // Cobre os alertas:
  //   1) Token: se validateToken inválido, dispara alertarTokenInvalido
  //   2) Disputa iniciada sem blitz agendado: pra cada compraId com sniper_itens.ativo=1
  //      sem blitz pendente, chama /itens/em-disputa e alerta itens com podeEnviarLances=true
  //   3) Digest diário (uma vez por dia às 8h): lista interesses sem proposta enviada
  async function scanAlertas() {
    // Digest diário: roda uma vez por dia perto das 8h. Dedup por data ISO em config.
    const agora = new Date();
    if (agora.getHours() === HORA_DIGEST_INTERESSES) {
      try {
        const hoje = agora.toISOString().slice(0, 10);
        const row = db.prepare("SELECT valor FROM config WHERE chave = 'digest_interesses_ultimo_envio'").get();
        const ultimoEnvio = row ? row.valor : null;
        if (!ultimoEnvio || ultimoEnvio < hoje) {
          await enviarDigestInteressesPendentes();
          db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('digest_interesses_ultimo_envio', ?)").run(hoje);
        }
      } catch (e) {
        console.error(`[DIGEST] tick falhou: ${e.message}`);
      }
    }


    // 1) Token check
    if (sniper.temToken() && !sniper.tokenExpirado()) {
      try {
        const validation = await sniper.validateToken(sniper.bearerToken);
        if (!validation.valid && !validation.cached) {
          await alertarTokenInvalido('scanner periódico', validation.status || 0);
        }
      } catch (_) { /* silencioso */ }
    } else if (sniper.temToken() && sniper.tokenExpirado()) {
      // Token cadastrado mas considerado expirado pelo cliente — também avisar
      await alertarTokenInvalido('token marcado como expirado', 0);
    }

    // 2) Disputa sem blitz: scan por compraIds distintos com items ativos.
    // Basta o item estar ATIVO (acompanhado); piso (valorMinimo) NÃO é exigido —
    // o objetivo é justamente avisar de item aberto sem nada preparado, inclusive
    // antes de o piso ser configurado.
    let compras;
    try {
      compras = db.prepare(
        `SELECT DISTINCT compraId FROM sniper_itens WHERE ativo = 1`
      ).all();
    } catch (_) { return; }

    if (!compras || compras.length === 0) return;
    if (!sniper.temToken()) return; // sem token não dá pra checar

    for (const { compraId } of compras) {
      // Fonte de verdade: tabela blitz_agendadas no DB. Antes consultava só
      // o objeto in-memory `blitzAgendadas` — incidente 2026-05-22 mostrou
      // que ele pode ficar dessincronizado do DB (recovery não populou ou
      // alguém limpou indevidamente) e gerar falso "DISPUTA SEM AGENDAMENTO"
      // mesmo com a blitz no DB. Em caso de divergência, loga warning pra
      // permitir investigação posterior.
      let blitzNoDb;
      try {
        blitzNoDb = db.prepare(
          'SELECT blitzKey FROM blitz_agendadas WHERE compraId = ? LIMIT 1'
        ).get(compraId);
      } catch (_) { blitzNoDb = null; }
      const blitzNaMemoria = Object.keys(blitzAgendadas).some(k => k.startsWith(compraId + '-'));
      if (blitzNoDb && !blitzNaMemoria) {
        console.warn(`[ScanAlertas] divergência ${compraId}: blitz no DB (${blitzNoDb.blitzKey}) mas ausente do in-memory blitzAgendadas — fonte DB prevalece`);
      }
      if (blitzNoDb || blitzNaMemoria) continue;

      try {
        const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`);
        if (!(status === 200 || status === 206) || !Array.isArray(data)) continue;

        for (const apiItem of data) {
          if (!apiItem.podeEnviarLances) continue;
          const itemNum = apiItem.numero || apiItem.identificador;
          // Item tem config ativo?
          const cfg = db.prepare(
            `SELECT itemNumero, valorMinimo FROM sniper_itens WHERE compraId = ? AND itemNumero = ? AND ativo = 1`
          ).get(compraId, itemNum);
          if (!cfg) continue; // piso (valorMinimo) opcional — alerta mesmo sem ele
          // Tem blitz específica pra esse item? Mesmo padrão: DB é fonte
          // de verdade, in-memory é apenas fallback.
          let blitzItemNoDb;
          try {
            blitzItemNoDb = db.prepare(
              'SELECT 1 FROM blitz_agendadas WHERE compraId = ? AND itemNumero = ? LIMIT 1'
            ).get(compraId, itemNum);
          } catch (_) { blitzItemNoDb = null; }
          if (blitzItemNoDb) continue;
          if (Object.keys(blitzAgendadas).some(k => k.startsWith(_itemPrefix(compraId, itemNum)))) continue;
          await alertarDisputaIniciadaSemBlitz(compraId, itemNum, apiItem, cfg);
        }
      } catch (_) { /* silencioso */ }
    }
  }

  _scanAlertasRef = scanAlertas;

  function pararGuard(compraId, itemNumero) {
    const guard = sniper.guardLoops[compraId];
    if (!guard) return;

    if (itemNumero != null) {
      guard.itens.delete(itemNumero);
    }

    if (guard.itens.size === 0 || itemNumero == null) {
      guard.active = false;
      if (guard.timer) { clearTimeout(guard.timer); guard.timer = null; }
      delete sniper.guardLoops[compraId];
      logAuto(`GUARD STOP: ${compraId}`);
    }
  }

  function pararTodosGuards() {
    for (const compraId of Object.keys(sniper.guardLoops)) {
      pararGuard(compraId, null);
    }
  }

  /**
   * Busca itens de uma compra diretamente da API Comprasnet e popula o cache.
   * Usado como fallback quando a extensão não sincronizou os dados.
   * Usa /qtdes primeiro (leve) para decidir qual endpoint chamar.
   */
  let fetchDirectoCooldown = {}; // { compraId: timestamp } — evita spam na API
  async function fetchItensDirecto(compraId) {
    // Cooldown de 60s por compra
    if (fetchDirectoCooldown[compraId] && (Date.now() - fetchDirectoCooldown[compraId]) < 60000) return null;
    fetchDirectoCooldown[compraId] = Date.now();

    if (!sniper.temToken()) return null;

    // Passo 1: /qtdes para detectar fase (chamada leve)
    let qtdes = null;
    try {
      const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${compraId}/itens/qtdes`);
      if (status === 200 || status === 206) qtdes = data;
    } catch (e) {}

    // Se /qtdes mostra 0 itens em disputa, não vale buscar itens detalhados.
    if (qtdes && qtdes.qtdeItensEmDisputa === 0 && qtdes.qtdeItensAguardandoDisputa === 0) {
      logAuto(`Fetch direto: ${compraId} sem itens em disputa (qtdes: disputa=${qtdes.qtdeItensEmDisputa}, encerrada=${qtdes.qtdeItensComDisputaEncerrada})`);
      // Antes de marcar faseCompra=4 confirmar com /participacao. /qtdes é
      // contagem de itens — pode dar 0 em disputa durante suspensão ou
      // intervalo aleatório entre fases, mesmo que a compra continue em
      // aberto. A fonte de verdade é faseCompraFaseExterna do /participacao.
      if (qtdes.qtdeItensComDisputaEncerrada > 0) {
        try {
          const { status: stPart, data: dataPart } = await sniper.apiGet(`/comprasnet-fase-externa/v1/compras/${compraId}/participacao`);
          if (stPart === 200) {
            const parsed = extrairFaseFromParticipacao(dataPart);
            if (parsed && parsed.fase) {
              db.prepare(`UPDATE participacoes_comprasnet SET
                situacao = ?, faseCompra = ?,
                objeto = COALESCE(NULLIF(?, ''), objeto),
                orgao = COALESCE(NULLIF(?, ''), orgao),
                dataAtualizacao = CURRENT_TIMESTAMP
                WHERE compraId = ?`).run(parsed.situacao, parsed.fase, parsed.objeto, parsed.orgao, compraId);
              if (parsed.fase !== '4') {
                logAuto(`Fetch direto: ${compraId} /qtdes sugeriu fim mas /participacao confirma faseCompra=${parsed.fase} — não marcado encerrado`);
              }
            }
          }
        } catch (e) {}
      }
      return null;
    }

    // Passo 2: escolher endpoint baseado em /qtdes
    const endpoints = [];
    if (qtdes && qtdes.qtdeItensEmDisputa > 0) {
      endpoints.push(`/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`);
    }
    // Fallbacks
    endpoints.push(`/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`);
    endpoints.push(`/comprasnet-disputa/v1/compras/${compraId}/itens`);

    // Deduplica
    const uniqueEndpoints = [...new Set(endpoints)];

    for (const path of uniqueEndpoints) {
      try {
        const { status, data } = await sniper.apiGet(path);
        if ((status === 200 || status === 206) && Array.isArray(data) && data.length > 0) {
          // Derivar flags direto da resposta (filtro=3,4,5 não funciona para fornecedor)
          const itens = data.map(i => {
            const num = i.numero || i.identificador;
            // Grupo/lote: total vem em valorCalculado, não valorInformado. Fallback só p/ grupo.
            const ehGrupo = i.tipo === 'G' || i.numero < 0;
            const pickV = o => (o || {}).valorInformado != null
              ? o.valorInformado
              : (ehGrupo && (o || {}).valorCalculado != null ? o.valorCalculado : null);
            return {
              numero: num,
              tipo: i.tipo || null,
              identificador: i.identificador || null,
              descricao: (i.descricao || i.objetoItem || '').substring(0, 200),
              fase: i.fase || '',
              melhorValor: pickV(i.melhorValorGeral),
              nossoValor: pickV(i.melhorValorFornecedor),
              valorEstimado: i.valorEstimadoUnitario || i.valorEstimado || null,
              situacaoParticipante: i.situacaoParticipanteDisputa || null,
              variacaoMinima: i.variacaoMinimaEntreLances != null ? i.variacaoMinimaEntreLances : null,
              tipoVariacao: i.tipoVariacaoMinimaEntreLances || 'V',
              podeEnviar: i.podeEnviarLances || false,
              fimContagem: i.dataHoraFimContagem || null,
              versaoParticipante: i.versaoParticipante || null,
              estaPerdendo: i.situacaoParticipanteDisputa === 'P',
              emEncAleatoria: (i.situacaoAposContagem === 'EA'),
              nosDoisMinFinais: !!(i.dataHoraFimContagem && (parseBrasilia(i.dataHoraFimContagem).getTime() - Date.now()) < 120000),
            };
          });
          const disputaData = {
            compraId,
            totalItens: itens.length,
            itensAtivos: itens.filter(i => i.podeEnviar || i.fase === 'LA').length,
            itens,
            qtdes, // guardar dados do /qtdes no cache
          };
          const idx = disputasCache.disputas.findIndex(d => d.compraId === compraId);
          if (idx >= 0) {
            disputasCache.disputas[idx] = { ...disputasCache.disputas[idx], ...disputaData };
          } else {
            disputasCache.disputas.push(disputaData);
          }
          disputasCache.atualizadoEm = new Date().toISOString();
          // Registrar estado do mercado
          registrarEstadoMercado(compraId, data, 'fetch-direto');
          logAuto(`Fetch direto OK: ${compraId} — ${itens.length} itens (${disputaData.itensAtivos} ativos)`);
          return disputaData;
        }
      } catch (e) { /* tentar próximo */ }
    }
    return null;
  }

  // ============ FASE 2: AUTO-LANCE EM GRUPO (lance POR ITEM) ============
  // Grupo disputaPorValorUnitario=false: ranking pelo TOTAL, mas o lance é por item
  // (unitário). Estratégia PRESERVAR MARGEM: reduz o item de MAIOR folga primeiro,
  // 1 item por ciclo, aprendendo a quantidade q_i pelo ΔM (só nosso lance muda M).
  // SEGURANÇA: nunca abaixo do piso f_i (sniper_itens.valorMinimo por item) — limite
  // duro de dinheiro; guarda-de-voo (8s) + backoff 429; 1 lance/ciclo.
  async function executarGrupoContinuo(compraId, grupoCfg) {
    const gkey = `grp-${compraId}`;
    sniper.continuoEstado = sniper.continuoEstado || {};
    const est = sniper.continuoEstado[gkey] || (sniper.continuoEstado[gkey] = { inFlight: false, sentAt: 0, backoffUntil: 0, backoffLevel: 0, qtd: {}, pend: null });
    const agora = Date.now();
    if (est.backoffUntil > agora) return;
    if (est.inFlight && (agora - est.sentAt) < 8000) return;

    // 1) Grupo fresco: total nosso (M) e melhor concorrente (B)
    let grupo;
    try {
      const g = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${compraId}/itens/-1`);
      if (g.status !== 200 || !g.data) return;
      grupo = g.data;
    } catch (e) { return; }
    const N = grupo.qtdeItensDoGrupo || 0;
    if (N < 1 || !grupo.podeEnviarLances) return;
    const M = (grupo.melhorValorFornecedor || {}).valorCalculado;
    const B = (grupo.melhorValorGeral || {}).valorCalculado;
    if (M == null || B == null) return;

    // 2) Sub-itens frescos (valor unitário atual)
    const subs = [];
    for (let n = 1; n <= N; n++) {
      try {
        const s = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${compraId}/itens/${n}`);
        if (s.status === 200 && s.data && s.data.numero != null) subs.push(s.data);
      } catch (e) {}
    }
    if (!subs.length) return;
    const uNow = {};
    subs.forEach(s => { uNow[s.numero] = (s.melhorValorFornecedor || {}).valorInformado != null ? (s.melhorValorFornecedor || {}).valorInformado : (s.melhorValorFornecedor || {}).valorCalculado; });

    // 2b) Aprender q_i do lance anterior (só nosso lance muda M entre ciclos)
    if (est.pend && est.pend.mAntes != null) {
      const p = est.pend, uDep = uNow[p.item];
      if (uDep != null && p.uAntes != null && p.uAntes !== uDep) {
        const q = Math.abs((p.mAntes - M) / (p.uAntes - uDep));
        if (isFinite(q) && q > 0) est.qtd[p.item] = q;
      }
      est.pend = null;
    }

    // 3) Ganhando? margem = quanto ficar ABAIXO do melhor (descontoMinimo do grupo, default 0,01)
    let margem = parseFloat(grupoCfg.descontoMinimo);
    if (!(margem > 0)) margem = 0.01;
    if (M <= B - margem) return; // já na frente pelo total
    const need = M - (B - margem); // reais a cortar do total

    // 4) Pisos por item + q estimado (fallback uniforme grupoEst/ΣunitEst)
    const somaUEst = subs.reduce((a, s) => a + (s.valorEstimado || 0), 0);
    const qUnif = (somaUEst > 0 && grupo.valorEstimado) ? grupo.valorEstimado / somaUEst : 1;
    const pisos = {};
    try {
      db.prepare(`SELECT itemNumero, valorMinimo FROM sniper_itens WHERE compraId = ? AND itemNumero > 0`).all(compraId)
        .forEach(r => { pisos[r.itemNumero] = r.valorMinimo; });
    } catch (e) {}

    const elig = subs.map(s => {
      const u = uNow[s.numero];
      const delta = s.variacaoMinimaEntreLances != null ? s.variacaoMinimaEntreLances : 0.3;
      const f = pisos[s.numero];
      const q = (est.qtd[s.numero] > 0) ? est.qtd[s.numero] : qUnif;
      return { n: s.numero, u, delta, f, q, pode: s.podeEnviarLances };
    }).filter(it => it.f != null && it.pode && it.u != null && (it.u - it.f) >= it.delta);

    if (!elig.length) {
      logAuto(`GRUPO ${compraId}: sem item elegível (defina piso < preço atual nos itens). nosso=R$${M} melhor=R$${B}`);
      return;
    }

    // 4b) VIABILIDADE: se nem descendo tudo ao piso cobre o melhor, NÃO lança —
    // jogar a margem fora perdendo do mesmo jeito é pior. (Baixe os pisos p/ competir.)
    const folgaTotal = elig.reduce((a, x) => a + (x.u - x.f) * x.q, 0);
    if (need > folgaTotal) {
      logAuto(`GRUPO ${compraId}: INVIÁVEL — precisa cortar R$${need.toFixed(2)} > folga total R$${folgaTotal.toFixed(2)}; NÃO lança (preserva margem). nosso=R$${M} melhor=R$${B}`);
      return;
    }

    // 5) PRESERVAR MARGEM: item de MAIOR folga total (u-f)*q primeiro
    elig.sort((a, b) => ((b.u - b.f) * b.q) - ((a.u - a.f) * a.q));
    const it = elig[0];
    let dropUnit = need / it.q;                 // reduzir só o necessário
    if (dropUnit < it.delta) dropUnit = it.delta;
    let alvo = Math.round((it.u - dropUnit) * 100) / 100;
    if (alvo < it.f) alvo = it.f;               // TRAVA DURA: nunca abaixo do piso
    if (alvo >= it.u) return;

    // 6) UM lance (1 item/ciclo) + guarda-de-voo/backoff + marca p/ aprender q_i
    est.inFlight = true; est.sentAt = agora;
    est.pend = { item: it.n, uAntes: it.u, mAntes: M };
    try {
      const r = await sniper.enviarLance(compraId, it.n, alvo, 'LA');
      est.inFlight = false;
      if (r.status === 429) { est.backoffLevel = Math.min((est.backoffLevel || 0) + 1, 6); est.backoffUntil = Date.now() + Math.min(1000 * Math.pow(2, est.backoffLevel - 1), 30000); est.pend = null; }
      else { est.backoffLevel = 0; est.backoffUntil = 0; }
      const rs = typeof r.resposta === 'string' ? r.resposta.substring(0, 1500) : (r.resposta ? JSON.stringify(r.resposta).substring(0, 1500) : '');
      try { db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, it.n, alvo, r.status, r.sucesso ? 1 : 0, r.tempoMs, rs, 'grupo-continuo', new Date().toISOString()); } catch (e) {}
      logAuto(`GRUPO ${compraId}: item #${it.n} R$${it.u}→R$${alvo} (need=R$${need.toFixed(2)}, q≈${it.q.toFixed(1)}, piso=R$${it.f}, nosso=R$${M} melhor=R$${B}) → HTTP ${r.status}`);
    } catch (e) { est.inFlight = false; est.pend = null; }
  }

  /**
   * Core loop: checks all items with modoAuto set and enqueues bids when losing.
   * @param {boolean} modoRapido - If true, only processes compras in sniper.autoLanceComprasFast
   */
  async function executarCicloAutoLance(modoRapido = false) {
    try {
      // Query DB for compras with auto items
      const autoItens = db.prepare(
        `SELECT si.compraId, si.itemNumero, si.valorMinimo, si.valorLance, si.modoAuto, si.faseItem, si.antecedenciaMs, si.variacaoMinima, si.tipoVariacao
         FROM sniper_itens si
         WHERE si.modoAuto IS NOT NULL AND si.modoAuto != ''`
      ).all();

      if (autoItens.length === 0) return;

      // Group by compraId
      const porCompra = {};
      for (const item of autoItens) {
        if (!porCompra[item.compraId]) porCompra[item.compraId] = [];
        porCompra[item.compraId].push(item);
      }

      // In fast mode, only process compras near end
      const compraIds = modoRapido
        ? Object.keys(porCompra).filter(id => sniper.autoLanceComprasFast[id])
        : Object.keys(porCompra);

      if (compraIds.length === 0) return;

      sniper.autoLanceStats.ciclos++;
      sniper.autoLanceStats.ultimoCiclo = new Date().toISOString();

      // Log diagnóstico a cada 20 ciclos (~5min) ou nos primeiros 3 ciclos
      const logDiag = (sniper.autoLanceStats.ciclos <= 3 || sniper.autoLanceStats.ciclos % 20 === 0);

      // Reset fast list (will be rebuilt)
      if (!modoRapido) sniper.autoLanceComprasFast = {};

      for (const compraId of compraIds) {
        try {
          // Usar dados do cache (populado pela extensão via POST /api/sync/disputas)
          let cached = disputasCache.disputas.find(d => d.compraId === compraId);
          if (!cached || !cached.itens || cached.itens.length === 0) {
            // Fallback: buscar direto da API Comprasnet
            const direto = await fetchItensDirecto(compraId);
            if (direto) {
              cached = direto;
            } else {
              if (logDiag) logAuto(`Cache vazio: ${compraId} (extensão não sincronizou, fetch direto falhou ou em cooldown)`);
              continue;
            }
          }

          const itensAuto = porCompra[compraId];

          for (const cfgItem of itensAuto) {
            // FASE 2: grupo (-1) com auto-lance → distribuição POR ITEM (preservar margem),
            // não trata o -1 como item único (o Comprasnet não aceita lance no total).
            if (cfgItem.itemNumero < 0 && cfgItem.modoAuto) {
              await executarGrupoContinuo(compraId, cfgItem);
              continue;
            }
            let liveItem = cached.itens.find(i => i.numero === cfgItem.itemNumero);
            if (!liveItem) {
              // Grupo fallback: sub-items (1,2,3) inherit data from grupo (-1)
              const grupoItem = cached.itens.find(i => i.numero === -1 || i.tipo === 'G');
              if (grupoItem) {
                // Get last known nossoValor from successful lance history
                let ultimoValor = null;
                try {
                  const lastLance = db.prepare(
                    `SELECT valor FROM sniper_historico WHERE compraId = ? AND itemNumero = ? AND sucesso = 1 ORDER BY rowid DESC LIMIT 1`
                  ).get(compraId, cfgItem.itemNumero);
                  if (lastLance) ultimoValor = parseFloat(lastLance.valor);
                } catch (e) {}
                // Fallback: use valorLance from config
                if (ultimoValor == null && cfgItem.valorLance != null) {
                  ultimoValor = parseFloat(cfgItem.valorLance);
                }

                liveItem = {
                  numero: cfgItem.itemNumero,
                  tipo: 'S',
                  melhorValor: null,
                  nossoValor: ultimoValor,
                  variacaoMinima: grupoItem.variacaoMinima,
                  tipoVariacao: grupoItem.tipoVariacao,
                  fimContagem: grupoItem.fimContagem,
                  podeEnviar: grupoItem.podeEnviar,
                  fase: grupoItem.fase,
                  estaPerdendo: grupoItem.estaPerdendo || false,
                  emEncAleatoria: grupoItem.emEncAleatoria || false,
                  nosDoisMinFinais: grupoItem.nosDoisMinFinais || false,
                  sintetico: true,
                };
                // Persist synthetic sub-item to cache so resultado-lance can find and update it
                cached.itens.push(liveItem);
                if (logDiag) logAuto(`Item ${cfgItem.itemNumero} sintético (grupo) nosso=${ultimoValor} var=${grupoItem.variacaoMinima}`);
              } else {
                if (logDiag) logAuto(`Item ${cfgItem.itemNumero} não no cache de ${compraId} (${cached.itens.length} itens: ${cached.itens.slice(0,5).map(i=>i.numero).join(',')})`);
                continue;
              }
            }

            const melhorGeral = liveItem.melhorValor;
            const nossoValor = liveItem.nossoValor;
            const varMin = liveItem.variacaoMinima;
            const tipoVar = liveItem.tipoVariacao || 'V';
            const fimContagem = liveItem.fimContagem;
            const podeEnviar = liveItem.podeEnviar;

            // Filter flags do Comprasnet
            const estaPerdendo = !!liveItem.estaPerdendo;
            const emEncAleatoria = !!liveItem.emEncAleatoria;
            const nosDoisMinFinais = !!liveItem.nosDoisMinFinais;

            if (!podeEnviar) {
              if (logDiag) logAuto(`Item ${cfgItem.itemNumero}: podeEnviar=false fase=${liveItem.fase||'?'}`);
              continue;
            }

            // Log filtros do Comprasnet quando ativos
            if (logDiag && (estaPerdendo || emEncAleatoria || nosDoisMinFinais)) {
              const flags = [estaPerdendo && 'PERDENDO', emEncAleatoria && 'ENC.ALEATORIA', nosDoisMinFinais && '2MIN'].filter(Boolean).join(' ');
              logAuto(`Item ${cfgItem.itemNumero}: [${flags}]`);
            }

            // Check countdown for sniper mode
            let segRestantes = null;
            if (fimContagem) {
              segRestantes = Math.floor((parseBrasilia(fimContagem).getTime() - Date.now()) / 1000);
            }

            // Sniper mode: only act in last N seconds (configurable via antecedenciaMs, default 60s)
            // nosDoisMinFinais do Comprasnet serve como gatilho adicional (mais confiável que cálculo de clock)
            if (cfgItem.modoAuto === 'sniper') {
              const sniperSeg = Math.round((cfgItem.antecedenciaMs || 60000) / 1000);
              const dentroJanela = (segRestantes != null && segRestantes <= sniperSeg && segRestantes > 0);
              const gatilho2min = nosDoisMinFinais && sniperSeg >= 120;
              if (!dentroJanela && !gatilho2min) continue;
              // Fast polling when approaching sniper window
              if ((segRestantes != null && segRestantes < sniperSeg + 30 && segRestantes > 0) || nosDoisMinFinais) {
                sniper.autoLanceComprasFast[compraId] = true;
              }
            }

            // nosDoisMinFinais: ativar fast polling mesmo em modo contínuo
            if (nosDoisMinFinais) {
              sniper.autoLanceComprasFast[compraId] = true;
            }

            // emEncAleatoria: ativar ultra-fast timer (1s) — pode fechar a qualquer momento
            if (emEncAleatoria) {
              sniper.autoLanceComprasFast[compraId] = true;
              if (!sniper.autoLanceTimerUltra) {
                sniper.autoLanceTimerUltra = setInterval(() => executarCicloAutoLance(true), 1000);
                logAuto(`ULTRA-FAST timer ativado (1s) — item ${cfgItem.itemNumero} em ENC.ALEATÓRIA`);
              }
            }

            // A3: Ultra-fast polling when < 30s from end
            if (segRestantes != null && segRestantes > 0 && segRestantes < 30) {
              sniper.autoLanceComprasFast[compraId] = true;
              if (!sniper.autoLanceTimerUltra) {
                sniper.autoLanceTimerUltra = setInterval(() => executarCicloAutoLance(true), 1000);
                logAuto(`ULTRA-FAST timer ativado (1s) — item ${cfgItem.itemNumero} a ${segRestantes}s do fim`);
              }
            }

            // Already at best price — nothing to do
            // EXCETO se Comprasnet diz que estamos perdendo (cache stale)
            if (nossoValor != null && melhorGeral != null && nossoValor <= melhorGeral && !estaPerdendo) continue;

            // Need valorMinimo to know where to bid
            if (cfgItem.valorMinimo == null) continue;

            // Already at our floor
            if (nossoValor != null && nossoValor <= cfgItem.valorMinimo) continue;

            // A2: BLITZ MODE — sniper with batch pre-calculation
            const blitzKey = `${compraId}-${cfgItem.itemNumero}`;
            if (cfgItem.modoAuto === 'sniper' && segRestantes != null && segRestantes > 0 && !sniper.blitzDisparados[blitzKey]) {
              // Calculate batch
              const batchLances = calcularBatchLances(cfgItem, liveItem, compraId, 50);
              if (batchLances.length > 0) {
                // Calculate timing: steps * avgBidTime + safety margin
                const avgMs = calcularMediaTempoLance(compraId, cfgItem.itemNumero);
                const tempoEstimadoMs = batchLances.length * avgMs;
                const safetyMs = 3000;
                const momentoIdealSeg = Math.ceil((tempoEstimadoMs + safetyMs) / 1000);

                if (segRestantes <= momentoIdealSeg) {
                  // DISPARA BLITZ! Enqueue ALL at once
                  const jaEnfileirado = sniper.filaLances.some(l =>
                    l.compraId === compraId &&
                    l.itemNumero === cfgItem.itemNumero &&
                    (l.status === 'pendente' || l.status === 'processando')
                  );
                  if (!jaEnfileirado) {
                    for (const lance of batchLances) {
                      sniper.filaLances.push(lance);
                    }
                    sniper.blitzDisparados[blitzKey] = Date.now();
                    sniper.autoLanceStats.lancesEnviados += batchLances.length;
                    liveItem.nossoValor = batchLances[batchLances.length - 1].valor;

                    logAuto(`🚀 BLITZ: ${compraId} item ${cfgItem.itemNumero} — ${batchLances.length} lances enfileirados! ` +
                      `R$${nossoValor.toFixed(2)} → R$${batchLances[batchLances.length - 1].valor.toFixed(2)} ` +
                      `(avg ${avgMs}ms/lance, estimado ${Math.round(tempoEstimadoMs/1000)}s, restam ${segRestantes}s)`);
                    continue; // blitz handled this item
                  }
                } else if (logDiag) {
                  logAuto(`BLITZ aguardando: item ${cfgItem.itemNumero} — ${batchLances.length} passos, momento ideal T-${momentoIdealSeg}s, restam ${segRestantes}s`);
                }
                continue; // sniper waits for blitz moment
              }
            }

            // Check if already in sniper.filaLances (pendente or processando)
            const jaEnfileirado = sniper.filaLances.some(l =>
              l.compraId === compraId &&
              l.itemNumero === cfgItem.itemNumero &&
              (l.status === 'pendente' || l.status === 'processando')
            );
            if (jaEnfileirado) continue;

            // MODO CONTÍNUO: lance único reativo — envia UM degrau por vez, espera resultado, re-avalia
            if (cfgItem.modoAuto === 'continuo') {
              // Contínuo sempre entra no fast polling (para setImmediate pós-lance funcionar)
              sniper.autoLanceComprasFast[compraId] = true;
              // Não enviar sem dados reais do Comprasnet (stub = extensão não sincronizou)
              if (!cached || cached.stub) {
                if (logDiag) logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — aguardando sync (dados stub)`);
                continue;
              }
              // Não enviar se disputa já encerrou
              if (fimContagem) {
                const segRest = Math.floor((parseBrasilia(fimContagem).getTime() - Date.now()) / 1000);
                if (segRest < -60) { // margem de 60s por clock drift
                  if (logDiag) logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — disputa encerrada há ${Math.abs(segRest)}s`);
                  continue;
                }
              }
              // Precisa de nossoValor e variacaoMinima reais para calcular degraus
              // Fallback varMin: usar campo da config do item (sniper_itens.variacaoMinima)
              let varMinEfetivo = varMin;
              let tipoVarEfetivo = tipoVar;
              if (varMinEfetivo == null && cfgItem.variacaoMinima != null) {
                varMinEfetivo = parseFloat(cfgItem.variacaoMinima);
                tipoVarEfetivo = cfgItem.tipoVariacao || 'V';
              }

              if (nossoValor == null || varMinEfetivo == null) {
                // Grupo sub-item: enviar valorLance como primeiro lance (só se nossoValor desconhecido)
                if (liveItem.sintetico && nossoValor == null && cfgItem.valorLance != null && cfgItem.valorLance > 0) {
                  const initVal = parseFloat(cfgItem.valorLance);
                  if (initVal >= cfgItem.valorMinimo) {
                    sniper.autoLanceStats.lancesEnviados++;
                    logAuto(`CONTÍNUO INIT DIRETO: ${compraId} item ${cfgItem.itemNumero} — R$${initVal.toFixed(2)} (primeiro lance grupo)`);
                    sniper.enviarLance(compraId, cfgItem.itemNumero, initVal, cfgItem.faseItem || 'LA').then(r => {
                      const rs = typeof r.resposta === 'string' ? r.resposta.substring(0, 1500) : (r.resposta ? JSON.stringify(r.resposta).substring(0, 1500) : '');
                      try { db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, cfgItem.itemNumero, initVal, r.status, r.sucesso ? 1 : 0, r.tempoMs, rs, 'continuo-servidor', new Date().toISOString()); } catch (e) {}
                    }).catch(() => {});
                    continue;
                  }
                }
                if (logDiag) logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — dados insuficientes (nosso=${nossoValor}, var=${varMinEfetivo})`);
                continue;
              }

              // Não dar lance se estamos GANHANDO — guard mode vigia e reage em <270ms.
              // Confia no sinal OBJETIVO (nosso <= melhor), não só na flag estaPerdendo do feed:
              // o feed do Comprasnet CONGELA (melhor + estaPerdendo=PERDENDO desatualizados) e o
              // motor descia o PRÓPRIO preço 1%/ciclo mesmo já sendo o melhor colocado
              // (feedback usuário 2026-07-01: "deu lances desnecessários, já éramos o melhor").
              // Ao entrar em GUARD o poll de ~200ms revalida o feed; se de fato perdermos, o Guard reage.
              if (!estaPerdendo || (melhorGeral != null && nossoValor <= melhorGeral)) {
                iniciarGuard(compraId, cfgItem.itemNumero);
                if (logDiag) logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — ganhando (nosso=R$${nossoValor.toFixed(2)} <= melhor=R$${melhorGeral != null ? melhorGeral.toFixed(2) : '?'}), GUARD ativo`);
                continue;
              }

              // MODO CONTÍNUO reativo: UM lance por ciclo (cobre o melhor concorrente em 1 lance),
              // protegido por guarda-de-voo + backoff em 429.
              // Antes (bug, incidente 2026-07-01): "Batch sizing" despejava até 50 lances em
              // PARALELO por ciclo, sem esperar resultado. Como os 429 (rate limit) não mudam nossa
              // posição, cada ciclo (ultra-timer 1s) re-disparava a escada inteira → ~2.000 req/min,
              // ~95% recusadas (429 + 422 auto-corrida). O comentário acima já dizia "UM degrau por vez".
              const _ckey = `${compraId}-${cfgItem.itemNumero}`;
              sniper.continuoEstado = sniper.continuoEstado || {};
              let _est = sniper.continuoEstado[_ckey];
              if (!_est) _est = sniper.continuoEstado[_ckey] = { inFlight: false, sentAt: 0, backoffUntil: 0, backoffLevel: 0 };
              const _agora = Date.now();

              // Backoff pós-429: pausa o item por tempo crescente (1s→30s) até o Comprasnet liberar.
              if (_est.backoffUntil > _agora) {
                if (logDiag) logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — backoff 429 +${Math.ceil((_est.backoffUntil - _agora) / 1000)}s`);
                continue;
              }
              // Guarda-de-voo: no máximo 1 lance contínuo em trânsito por item
              // (timeout de segurança 8s, abaixo dos 10s de timeout do enviarLance/apiPost).
              if (_est.inFlight && (_agora - _est.sentAt) < 8000) continue;

              // Alvo: cobrir o melhor concorrente em UM lance (1 degrau abaixo dele), clampado ao piso.
              // Se o melhor é desconhecido, desce 1 degrau do nosso valor.
              let _alvo;
              if (melhorGeral != null && melhorGeral < nossoValor) {
                _alvo = calcularProximoDegrau(melhorGeral, varMinEfetivo, tipoVarEfetivo);
              } else {
                _alvo = calcularProximoDegrau(nossoValor, varMinEfetivo, tipoVarEfetivo);
              }
              // Cobrir o concorrente furaria o piso → só lançar se o próprio piso ainda for um
              // degrau válido (respeitando varMin) abaixo do nosso valor atual.
              if (_alvo < cfgItem.valorMinimo) {
                if (calcularProximoDegrau(nossoValor, varMinEfetivo, tipoVarEfetivo) < cfgItem.valorMinimo) {
                  if (logDiag) logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — piso R$${cfgItem.valorMinimo} não cobre (nosso R$${nossoValor.toFixed(2)})`);
                  continue;
                }
                _alvo = cfgItem.valorMinimo;
              }
              if (_alvo >= nossoValor || _alvo <= 0) continue; // sem espaço para baixar

              _est.inFlight = true;
              _est.sentAt = _agora;
              sniper.autoLanceStats.lancesEnviados++;
              const _cid = compraId, _inum = cfgItem.itemNumero, _nv = _alvo, _fi = cfgItem.faseItem || 'LA';
              sniper.enviarLance(_cid, _inum, _nv, _fi).then(r => {
                _est.inFlight = false;
                if (r.status === 429) {
                  _est.backoffLevel = Math.min((_est.backoffLevel || 0) + 1, 6);
                  _est.backoffUntil = Date.now() + Math.min(1000 * Math.pow(2, _est.backoffLevel - 1), 30000);
                } else {
                  _est.backoffLevel = 0;
                  _est.backoffUntil = 0;
                }
                // O feed do Comprasnet atrasa a atualização do nosso valor: com lance aceito (200)
                // OU 422 "deve ser melhor que o último" (= já detemos esse valor), registrar
                // otimisticamente pra não re-lançar o mesmo valor a cada ciclo (loop de 422).
                // Mesmo padrão já usado no path sniper/ambos (liveItem.nossoValor = ...).
                if (r.sucesso || r.status === 422) { try { liveItem.nossoValor = _nv; } catch (e) {} }
                const rs = typeof r.resposta === 'string' ? r.resposta.substring(0, 1500) : (r.resposta ? JSON.stringify(r.resposta).substring(0, 1500) : '');
                try { db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(_cid, _inum, _nv, r.status, r.sucesso ? 1 : 0, r.tempoMs, rs, 'continuo-servidor', new Date().toISOString()); } catch (e) {}
              }).catch(() => { _est.inFlight = false; });

              const flagsStr = [estaPerdendo && 'PERDENDO', emEncAleatoria && 'ENC.ALEATORIA', nosDoisMinFinais && '2MIN'].filter(Boolean).join(' ');
              logAuto(`CONTÍNUO: ${compraId} item ${cfgItem.itemNumero} — 1 lance R$${nossoValor.toFixed(2)}→R$${_alvo.toFixed(2)} ` +
                `(var ${tipoVarEfetivo}=${varMinEfetivo}, min=R$${cfgItem.valorMinimo}, melhor=${melhorGeral != null ? 'R$' + melhorGeral.toFixed(2) : '?'})` +
                `${flagsStr ? ' [' + flagsStr + ']' : ''}`);
              continue;
            }

            // Fallback: lance único (primeiro lance sem nossoValor, ou caso especial)
            let novoLance;
            if (nossoValor != null && varMin != null) {
              novoLance = calcularProximoDegrau(nossoValor, varMin, tipoVar);
            } else if (nossoValor == null && cfgItem.valorLance != null && cfgItem.valorLance > 0) {
              novoLance = parseFloat(cfgItem.valorLance);
            } else {
              continue;
            }

            if (novoLance < cfgItem.valorMinimo) novoLance = cfgItem.valorMinimo;

            const id = 'auto-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
            const lance = {
              id,
              compraId,
              itemNumero: cfgItem.itemNumero,
              valor: novoLance,
              faseItem: cfgItem.faseItem || 'LA',
              criadoEm: new Date().toISOString(),
              status: 'pendente',
              fonte: 'auto-lance',
            };
            sniper.filaLances.push(lance);
            sniper.autoLanceStats.lancesEnviados++;
            liveItem.nossoValor = novoLance;

            const logMelhor = melhorGeral != null ? `melhor R$${melhorGeral.toFixed(2)}` : 'sem melhor';
            const flagsStr = [estaPerdendo && 'PERDENDO', emEncAleatoria && 'ENC.ALEATORIA', nosDoisMinFinais && '2MIN'].filter(Boolean).join(' ');
            logAuto(`LANCE: ${compraId} item ${cfgItem.itemNumero} — ${logMelhor}, nosso R$${(nossoValor||0).toFixed(2)} → R$${novoLance.toFixed(2)} (var ${tipoVar}=${varMin}, modo=${cfgItem.modoAuto})${flagsStr ? ' [' + flagsStr + ']' : ''}`);
          }
        } catch (e) {
          logAuto(`ERRO compra ${compraId}: ${e.message}`);
        }
      }
      // A3: Check if ultra timer still needed (only on normal cycles)
      if (!modoRapido) verificarUltraTimer();
    } catch (e) {
      logAuto(`ERRO ciclo: ${e.message}`);
    }
  }

  function iniciarAutoLance() {
    if (sniper.autoLanceAtivo) return;
    sniper.autoLanceAtivo = true;
    logAuto('Engine LIGADO');

    // Normal cycle every 15s
    sniper.autoLanceTimerNormal = setInterval(() => executarCicloAutoLance(false), 15000);
    // Fast cycle every 5s (for sniper/ambos near end)
    sniper.autoLanceTimerRapido = setInterval(() => executarCicloAutoLance(true), 5000);
    // Run immediately
    executarCicloAutoLance(false);
  }

  function pararAutoLance() {
    if (!sniper.autoLanceAtivo) return;
    sniper.autoLanceAtivo = false;
    if (sniper.autoLanceTimerNormal) { clearInterval(sniper.autoLanceTimerNormal); sniper.autoLanceTimerNormal = null; }
    if (sniper.autoLanceTimerRapido) { clearInterval(sniper.autoLanceTimerRapido); sniper.autoLanceTimerRapido = null; }
    if (sniper.autoLanceTimerUltra) { clearInterval(sniper.autoLanceTimerUltra); sniper.autoLanceTimerUltra = null; }
    sniper.autoLanceComprasFast = {};
    sniper.blitzDisparados = {};
    pararTodosGuards();
    logAuto('Engine DESLIGADO');
  }

  // A3: Auto-cleanup ultra timer when no items near end or in encerramento aleatório
  function verificarUltraTimer() {
    if (!sniper.autoLanceTimerUltra) return;
    // Check if any item is still < 30s from end OR in encerramento aleatório
    let precisaUltra = false;
    for (const d of disputasCache.disputas) {
      if (!d.itens) continue;
      for (const item of d.itens) {
        if (item.emEncAleatoria) { precisaUltra = true; break; }
        if (item.fimContagem) {
          const seg = Math.floor((parseBrasilia(item.fimContagem).getTime() - Date.now()) / 1000);
          if (seg > 0 && seg < 30) { precisaUltra = true; break; }
        }
      }
      if (precisaUltra) break;
    }
    if (!precisaUltra) {
      clearInterval(sniper.autoLanceTimerUltra);
      sniper.autoLanceTimerUltra = null;
      logAuto('ULTRA-FAST timer desativado (nenhum item próximo do fim ou em enc.aleatória)');
    }
  }

  function verificarAutoLanceNecessario() {
    try {
      const count = db.prepare(
        `SELECT COUNT(*) as n FROM sniper_itens WHERE modoAuto IS NOT NULL AND modoAuto != ''`
      ).get();
      if (count.n > 0 && !sniper.autoLanceAtivo) {
        iniciarAutoLance();
      } else if (count.n === 0 && sniper.autoLanceAtivo) {
        pararAutoLance();
      }
    } catch (e) {}
  }

  // Phase C (2026-04-23): boot-time verificarAutoLanceNecessario foi movido
  // para _iniciarAgendamentoTenant — cada tenant que aparecer no worker recebe
  // sua própria verificação per-tenant com contexto preservado. AsyncLocalStorage
  // propaga contexto através de setInterval/setTimeout, então os timers criados
  // por iniciarAutoLance dentro do contexto do tenant herdam o contexto em
  // todas as disparadas.
  _verificarAutoLanceRef = verificarAutoLanceNecessario;

  /**
   * POST /api/sniper/lance
   * Adiciona lance à fila (Electron processa via webview Comprasnet).
   * Também tenta enviar direto (fallback se servidor tiver acesso).
   */
  app.post('/api/sniper/lance', async (req, res) => {
    try {
      const { compraId, itemNumero, valor, faseItem } = req.body;
      if (!compraId || !itemNumero || valor == null) {
        return res.status(400).json({ success: false, error: 'compraId, itemNumero e valor obrigatórios' });
      }

      // ─── Roteamento BNC: compraId 'bnc:<processNumber>' usa engine SignalR + captcha bridge ───
      if (typeof compraId === 'string' && compraId.startsWith('bnc:')) {
        const tdb = req.tenantDb || db;
        const tenantSlug = req.tenant?.slug || req.tenantSlug || null;
        return handleBNCLance(tdb, tenantSlug, { compraId, batchNumber: parseInt(itemNumero), valor: parseFloat(valor) }, res);
      }

      if (!sniper.temToken()) return res.status(400).json({ success: false, error: 'Sem Bearer token' });

      // Enviar direto pelo servidor
      const resultado = await sniper.enviarLance(compraId, parseInt(itemNumero), parseFloat(valor), faseItem || 'LA');
      const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
      try {
        db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, parseInt(itemNumero), parseFloat(valor), resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'manual-servidor', new Date().toISOString());
      } catch (dbErr) {}

      console.log(`[Sniper] 🎯 Lance direto: ${compraId} item ${itemNumero} R$${parseFloat(valor).toFixed(2)} — ${resultado.sucesso ? 'OK' : 'FALHA ' + resultado.status} (${resultado.tempoMs}ms)`);

      res.json({ success: resultado.sucesso, via: 'servidor', resultado, tempoMs: resultado.tempoMs });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/disparar-blitz
   * Disparo manual da rajada blitz — calcula batch e enfileira lances REAIS.
   * Permite testar o modo sniper a qualquer momento, sem esperar o timer automático.
   */
  // Blitz agendadas: { 'compraId-itemNumero-alvoMs': { timer, horario, compraId, itemNumero, alvoMs, ... } }
  // Formato 2026-05-25: blitzKey inclui alvoMs pra permitir múltiplos agendamentos
  // do MESMO item em horários diferentes (testes / estratégias múltiplas).
  var blitzAgendadas = {};

  function _mkBlitzKey(compraId, itemNumero, alvoMs) {
    return `${compraId}-${itemNumero}-${alvoMs}`;
  }
  // Modalidade Comprasnet no compraId {uasg:6}{mod:2}{num:5}{ano:4}.
  // 05 = Pregão (encerramento ALEATÓRIO), 06 = Dispensa (hora exata). Confirmado pelo usuário 2026-06-24.
  // participacoes_comprasnet.modalidade/modoDisputa estão vazios em ~95% das linhas → decodificar do compraId.
  function isPregaoCompraId(cid) {
    return typeof cid === 'string' && cid.length >= 8 && cid.substring(6, 8) === '05';
  }
  // Prefix usado por scan-alertas e dedupe-por-item (sem alvoMs).
  function _itemPrefix(compraId, itemNumero) {
    return `${compraId}-${itemNumero}-`;
  }
  // Retorna a blitz futura mais próxima pra esse item (ou null). Usado por
  // guard/alertas que antes pegavam blitzAgendadas[compraId-itemNum] direto.
  function _proxBlitzFutura(compraId, itemNumero) {
    const prefixo = _itemPrefix(compraId, itemNumero);
    const agora = Date.now();
    let melhor = null;
    for (const k of Object.keys(blitzAgendadas)) {
      if (!k.startsWith(prefixo)) continue;
      const b = blitzAgendadas[k];
      if (b.alvoMs <= agora) continue;
      if (melhor == null || b.alvoMs < melhor.alvoMs) melhor = b;
    }
    return melhor;
  }

  // Coalescing por alvoMs: vários blitz-individuais agendados pro MESMO instante
  // compartilham 1 timer e disparam em round-robin entre os itens (igual o global).
  // Estrutura: Map<alvoMs, { items: [{compraId, itemNumero, maxLances, modoBlitz, capPorItem}], timer, horarioEfetivo, tag }>
  var blitzGruposPorAlvo = new Map();

  // ─────────────────────────────────────────────────────────────────────
  // Helper: dado um horário do ÚLTIMO LANCE (com ou sem ms), calcula:
  //   - alvoUltimoLance: timestamp em que o último lance deve CHEGAR ao Comprasnet
  //   - dispatchAlvo:    timestamp em que o setTimeout deve disparar (PRIMEIRO lance sai)
  //   - duracaoTotalMs:  recuo aplicado = oneWay + (N-1)*intervaloRR + bufferSpike
  //
  // Diferença vs versão antiga: ANTES o ms do horário era usado como dispatch
  // direto (causava chegada do último lance MUITO depois do alvo). AGORA o
  // ms do horário (ou milesimoAlvo default=970) é o ALVO DE CHEGADA, e o
  // dispatch é calculado recuando. Bug fix 2026-05-25 (15:00 falhou +118ms).
  // ─────────────────────────────────────────────────────────────────────
  function _calcularMilesimoAuto({ horario, itensCount, maxLancesArr, milesimoAlvo }) {
    const agora = new Date();
    const partes = horario.split(':');
    const hh = parseInt(partes[0]) || 0;
    const mm = parseInt(partes[1]) || 0;
    const secParts = (partes[2] || '0').split('.');
    const ss = parseInt(secParts[0]) || 0;
    // Se o usuário forneceu ms → esse é o alvo de chegada. Senão usa milesimoAlvo (default 970).
    const msExplicito = secParts[1] != null && secParts[1] !== '';
    const msTarget = msExplicito
      ? parseInt(secParts[1].padEnd(3, '0').substring(0, 3))
      : (milesimoAlvo || 970);

    // alvoUltimoLance = quando o último lance precisa CHEGAR ao Comprasnet
    const alvoUltimoLance = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), hh, mm, ss, msTarget);

    // Cálculo de recuo (mesmas constantes calibradas):
    const oneWay = 76;          // mediana RTT/2 (lance servidor → Comprasnet)
    const intervaloRR = 157;    // gap entre rodadas round-robin
    const rttMediana = 153;     // RTT puro (1 item sequencial)
    const bufferSpike = 30;     // tolerância jitter
    const lancesValidos = (maxLancesArr || []).filter(m => m > 0);
    const maxLancesReal = lancesValidos.length > 0 ? Math.max(...lancesValidos) : 5;
    const numRodadas = Math.max(0, maxLancesReal - 1);
    const intervalo = (itensCount || 1) > 1 ? intervaloRR : rttMediana;
    const duracaoTotalMs = oneWay + (numRodadas * intervalo) + bufferSpike;

    // dispatchAlvo = recua a duração total do alvo de chegada
    const dispatchAlvo = new Date(alvoUltimoLance.getTime() - duracaoTotalMs);

    // horarioEfetivo (humano) — mostra o ALVO DE CHEGADA do último lance
    const horarioEfetivo = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}.${String(msTarget).padStart(3,'0')}`;
    const dispatchHora = dispatchAlvo.toTimeString().slice(0,8) + '.' + String(dispatchAlvo.getMilliseconds()).padStart(3,'0');

    // Compat: campo `alvo` antigo continua = alvoUltimoLance (pra callers existentes)
    return {
      alvo: alvoUltimoLance,
      alvoUltimoLance,
      dispatchAlvo,
      duracaoTotalMs,
      horarioEfetivo,
      dispatchHora,
      msCalculado: dispatchAlvo.getMilliseconds(),  // pra compat
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Helper compartilhado: prepara batches dos itens (com refresh API se faltar
  // dado live) e executa round-robin de lances com Promise.all por rodada.
  // Usado pelo blitz-global e pelo timer coalescido do individual.
  // `itensConfig`: [{ compraId, itemNumero, valorMinimo, faseItem, variacaoMinima, tipoVariacao, maxLances }, ...]
  // ─────────────────────────────────────────────────────────────────────
  async function _executarRoundRobinBlitz({ itensConfig, modo, capPorItem, tag, fonte, alvoMs }) {
    // Telemetria: marca tempo real de dispatch + snapshot fimContagem por item
    const dispatchMs = Date.now();
    const desvioInicialMs = alvoMs != null ? (dispatchMs - alvoMs) : null;
    const fimContagemSnapshot = {}; // { 'compraId-itemNumero': fimContagemString }
    const itensBatches = [];
    for (const item of itensConfig) {
      // blitzKey específico desse agendamento (suporta múltiplas blitzes pro mesmo item)
      const blitzKey = alvoMs != null ? _mkBlitzKey(item.compraId, item.itemNumero, alvoMs) : `${item.compraId}-${item.itemNumero}`;
      const cached = disputasCache.disputas.find(d => d.compraId === item.compraId);
      const liveItem = cached && cached.itens ? cached.itens.find(i => i.numero === item.itemNumero) : null;
      // Snapshot do encerramento previsto no T=0 (pra comparar depois com chegada real)
      fimContagemSnapshot[`${item.compraId}-${item.itemNumero}`] = liveItem?.fimContagem || null;
      if (!liveItem || liveItem.nossoValor == null) {
        const motivo = sniper.temToken()
          ? 'Aborto: sem dados live (cache não populado e API não respondeu)'
          : 'Aborto: sem dados live (token Bearer ausente — Electron offline?)';
        blitzHist.finalizarStatus(db, blitzKey, 'executada', {
          compraId: item.compraId, itemNumero: item.itemNumero,
          lancesEnviados: 0, observacao: motivo,
        });
        try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(blitzKey); } catch (e) {}
        delete blitzAgendadas[blitzKey];
        notificarResultadoBlitz(item.compraId, item.itemNumero, { sucessos: 0, falhas: 0, motivo: 'sem live data' });
        continue;
      }

      // Refresh direto da API se faltar tipoVariacao (extensão antiga)
      if (liveItem.tipoVariacao == null && sniper.temToken()) {
        try {
          const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${item.compraId}/itens/em-disputa`);
          if ((status === 200 || status === 206) && Array.isArray(data)) {
            const apiItem = data.find(i => (i.numero || i.identificador) === item.itemNumero);
            if (apiItem) {
              liveItem.variacaoMinima = apiItem.variacaoMinimaEntreLances ?? liveItem.variacaoMinima;
              liveItem.tipoVariacao = apiItem.tipoVariacaoMinimaEntreLances || liveItem.tipoVariacao;
              liveItem.melhorValor = (apiItem.melhorValorGeral || {}).valorInformado ?? liveItem.melhorValor;
              liveItem.nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado ?? liveItem.nossoValor;
              liveItem.situacaoParticipante = apiItem.situacaoParticipanteDisputa || liveItem.situacaoParticipante;
              logAuto(`🔄 ${tag} refresh: ${item.compraId} item ${item.itemNumero} — varMin=${liveItem.variacaoMinima} tipo=${liveItem.tipoVariacao} nosso=${liveItem.nossoValor}`);
            }
          }
        } catch (e) {
          logAuto(`⚠️ ${tag} refresh falhou: ${e.message}`);
        }
      }

      const itemParaCalculo = {
        ...liveItem,
        variacaoMinima: liveItem.variacaoMinima != null ? liveItem.variacaoMinima : item.variacaoMinima,
        tipoVariacao: liveItem.tipoVariacao || item.tipoVariacao || 'V',
      };
      const itemMaxLances = capPorItem != null ? capPorItem : (item.maxLances || 5);
      const batchLances = calcularBatchLances(item, itemParaCalculo, item.compraId, itemMaxLances, modo);
      if (batchLances.length === 0) {
        const dbg = `nosso=${itemParaCalculo.nossoValor} melhor=${itemParaCalculo.melhorValor} varMin=${itemParaCalculo.variacaoMinima} valMin=${item.valorMinimo} sit=${itemParaCalculo.situacaoParticipante} modo=${modo}`;
        blitzHist.finalizarStatus(db, blitzKey, 'executada', {
          compraId: item.compraId, itemNumero: item.itemNumero,
          lancesEnviados: 0, observacao: `Aborto: batch vazio — ${dbg}`,
        });
        try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(blitzKey); } catch (e) {}
        delete blitzAgendadas[blitzKey];
        notificarResultadoBlitz(item.compraId, item.itemNumero, { sucessos: 0, falhas: 0, motivo: 'batch vazio (piso/varMin)' });
        continue;
      }
      sniper.blitzDisparados[blitzKey] = Date.now();
      delete blitzAgendadas[blitzKey];
      try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(blitzKey); } catch (e) {}
      const histIdBlitz = blitzHist.finalizarStatus(db, blitzKey, 'executada', {
        compraId: item.compraId, itemNumero: item.itemNumero,
        observacao: `Disparada (${tag.toLowerCase()})`,
      });
      const vi = itemParaCalculo.nossoValor.toFixed(2);
      const vf = batchLances[batchLances.length - 1].valor.toFixed(2);
      logAuto(`📋 ${tag} ${item.compraId} item ${item.itemNumero} pré-disparo: fase=${itemParaCalculo.fase || '?'} sit=${itemParaCalculo.situacaoParticipante || '?'} nosso=${itemParaCalculo.nossoValor} varMin=${itemParaCalculo.variacaoMinima} batch=[${batchLances.slice(0,3).map(l => l.valor.toFixed(2)).join(', ')}${batchLances.length > 3 ? ', …' : ''}]`);
      console.log(`[${tag}] DIRETO: ${item.compraId} item ${item.itemNumero} — ${batchLances.length} lances (R$${vi} → R$${vf})`);
      itensBatches.push({ compraId: item.compraId, itemNumero: item.itemNumero, batchLances, liveItem, historicoId: histIdBlitz });
    }

    if (itensBatches.length === 0) return { itemOk: {}, itemFalha: {} };

    const maxRodadas = Math.max(...itensBatches.map(ib => ib.batchLances.length));
    const itemFalhou = new Set();
    const itemOk = {};
    const itemFalha = {};
    // Telemetria: acumular RTT por item + timestamp da última chegada
    const itemRtts = {};            // key → [tempoMs, ...]
    const itemUltimaChegadaMs = {}; // key → timestamp absoluto (Date.now()) da última resposta
    for (const ib of itensBatches) {
      const k = ib.compraId + '-' + ib.itemNumero;
      itemOk[k] = 0; itemFalha[k] = 0;
      itemRtts[k] = []; itemUltimaChegadaMs[k] = null;
    }

    for (let rodada = 0; rodada < maxRodadas; rodada++) {
      const lancesRodada = [];
      for (const ib of itensBatches) {
        const key = ib.compraId + '-' + ib.itemNumero;
        if (itemFalhou.has(key)) continue;
        if (rodada >= ib.batchLances.length) continue;
        lancesRodada.push({ ib, lance: ib.batchLances[rodada], key });
      }
      if (lancesRodada.length === 0) break;

      const rodadaInicio = Date.now();
      const resultados = await Promise.all(lancesRodada.map(({ ib, lance, key }) =>
        sniper.enviarLance(ib.compraId, ib.itemNumero, lance.valor, lance.faseItem || 'LA')
          .then(r => ({ key, ib, lance, resultado: r, chegadaMs: Date.now() }))
          .catch(e => ({ key, ib, lance, resultado: { sucesso: false, status: 0, resposta: e.message, tempoMs: 0 }, chegadaMs: Date.now() }))
      ));
      const rodadaDur = Date.now() - rodadaInicio;
      const maxRttRodada = Math.max(...resultados.map(r => r.resultado.tempoMs || 0));
      console.log(`[${tag}-TIMING] rodada ${rodada+1}/${maxRodadas}: ${lancesRodada.length} lance(s) — duração=${rodadaDur}ms, RTT máx=${maxRttRodada}ms (alvo=${alvoMs ? new Date(alvoMs).toISOString() : '?'})`);

      for (const { key, ib, lance, resultado, chegadaMs } of resultados) {
        const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
        try { db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ib.compraId, ib.itemNumero, lance.valor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, fonte || 'blitz-servidor', new Date().toISOString()); } catch (e) {}
        if (resultado.tempoMs > 0) itemRtts[key].push(resultado.tempoMs);
        itemUltimaChegadaMs[key] = chegadaMs;
        if (resultado.sucesso) {
          itemOk[key]++;
        } else {
          itemFalha[key]++;
          if (resultado.status === 401 || resultado.status === 403) itemFalhou.add(key);
          else if (resultado.status === 422) {
            const tipo = classificar422(resultado.resposta);
            logAuto(`🩹 ${tag} 422 ${tipo}: ${ib.compraId} item ${ib.itemNumero} R$ ${lance.valor.toFixed(2)}`);
            if (tipo !== 'colisao') itemFalhou.add(key);
          }
        }
      }
    }

    for (const ib of itensBatches) {
      const key = ib.compraId + '-' + ib.itemNumero;
      ib.liveItem.nossoValor = ib.batchLances[ib.batchLances.length - 1].valor;
      console.log(`[${tag}] DIRETO resultado: ${ib.compraId} item ${ib.itemNumero} — ${itemOk[key]} ✅ ${itemFalha[key]} ❌`);
      blitzHist.atualizarLances(db, ib.historicoId, itemOk[key] + itemFalha[key],
        `Disparada (${tag.toLowerCase()}): ${itemOk[key]} OK, ${itemFalha[key]} falhas`);

      // ───── Telemetria fina (2026-05-25): salva métricas pra análise/calibração ─────
      try {
        const rtts = itemRtts[key];
        const rttMedio = rtts.length > 0 ? Math.round(rtts.reduce((s,v)=>s+v,0) / rtts.length) : null;
        const rttMax = rtts.length > 0 ? Math.max(...rtts) : null;
        const rttMin = rtts.length > 0 ? Math.min(...rtts) : null;
        const fimContagemNoT0 = fimContagemSnapshot[key];
        let deltaVsEnc = null;
        if (fimContagemNoT0 && itemUltimaChegadaMs[key]) {
          try {
            const encMs = parseBrasilia(fimContagemNoT0).getTime();
            if (!isNaN(encMs)) deltaVsEnc = itemUltimaChegadaMs[key] - encMs;
          } catch (_) {}
        }
        const numLances = itemOk[key] + itemFalha[key];
        db.prepare(`INSERT INTO blitz_telemetria
          (blitzKey, compraId, itemNumero, tag, alvoMs, dispatchMs, desvioInicialMs,
           fimContagemNoT0, numLances, sucessos, falhas,
           rttMedioMs, rttMaxMs, rttMinMs, ultimoChegadaMs, deltaVsEncerramentoMs,
           numItensCoalescidos)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            alvoMs != null ? _mkBlitzKey(ib.compraId, ib.itemNumero, alvoMs) : null,
            ib.compraId, ib.itemNumero, tag,
            alvoMs || 0, dispatchMs, desvioInicialMs,
            fimContagemNoT0, numLances, itemOk[key], itemFalha[key],
            rttMedio, rttMax, rttMin,
            itemUltimaChegadaMs[key], deltaVsEnc,
            itensBatches.length
          );
        if (deltaVsEnc != null) {
          const sinal = deltaVsEnc > 0 ? '+' : '';
          console.log(`[${tag}-TIMING] ${ib.compraId} item ${ib.itemNumero}: desvio_inicial=${desvioInicialMs}ms, RTT méd=${rttMedio}ms, último_lance ${sinal}${deltaVsEnc}ms vs fimContagem (${fimContagemNoT0})`);
        }
      } catch (e) { console.warn(`[${tag}-TIMING] save fail:`, e.message); }

      iniciarGuard(ib.compraId, ib.itemNumero);
      notificarResultadoBlitz(ib.compraId, ib.itemNumero, { sucessos: itemOk[key], falhas: itemFalha[key] });
    }
    return { itemOk, itemFalha };
  }

  app.post('/api/sniper/disparar-blitz', (req, res) => {
    try {
      // Plano: alinhamento com blitz-global (2026-05-25)
      //   - milesimoAlvo: alvo do milésimo de chegada do último lance (default 970).
      //     Auto-calcula o segundo/ms de início recuando por rodadas × intervalo.
      //   - ignoreMax: ignora maxLances do item e desce até valorMinimo.
      //   - Coalescing: se outra blitz-individual já tem timer no mesmo alvoMs,
      //     este item entra no MESMO grupo (round-robin entre todos os coalescidos).
      const { compraId, itemNumero, horario, maxLances, modoBlitz, milesimoAlvo, ignoreMax } = req.body;
      if (!compraId || itemNumero == null) {
        return res.status(400).json({ success: false, error: 'compraId e itemNumero obrigatórios' });
      }

      // Ler config do item
      const cfgItem = db.prepare('SELECT * FROM sniper_itens WHERE compraId = ? AND itemNumero = ?').get(compraId, parseInt(itemNumero));
      if (!cfgItem || !cfgItem.valorMinimo) {
        return res.status(400).json({ success: false, error: 'Item sem valorMinimo configurado' });
      }

      // ── Camada 2: pregão (05) fecha em horário ALEATÓRIO — blitz de horário fixo não protege.
      if (isPregaoCompraId(compraId) && !req.body.overridePregao) {
        return res.status(400).json({ success: false,
          error: 'PREGAO_BLITZ_FIXA: pregão (05) encerra em horário ALEATÓRIO — blitz de horário fixo não protege. Use Auto-Lance Contínuo (modoAuto=continuo) + Valor Mínimo. Para forçar, envie overridePregao:true.' });
      }

      const capPorItem = ignoreMax ? 99999 : null;

      // Ler dados live do cache de disputas
      const cached = disputasCache.disputas.find(d => d.compraId === compraId);
      const liveItem = cached && cached.itens ? cached.itens.find(i => i.numero === parseInt(itemNumero)) : null;

      // Para agendamento futuro, não exigir cache agora — será lido na hora do disparo
      if (!horario) {
        if (!cached || !cached.itens) {
          return res.status(400).json({ success: false, error: 'Sem dados de disputa no cache. Aguarde sync da extensão.' });
        }
        if (!liveItem) {
          return res.status(400).json({ success: false, error: `Item ${itemNumero} não encontrado no cache de disputas` });
        }
        if (liveItem.nossoValor == null) {
          return res.status(400).json({ success: false, error: 'nossoValor desconhecido para este item' });
        }
      }

      // Verificar se já tem lances pendentes para este item
      const jaEnfileirado = sniper.filaLances.some(l =>
        l.compraId === compraId &&
        l.itemNumero === parseInt(itemNumero) &&
        (l.status === 'pendente' || l.status === 'processando')
      );
      if (jaEnfileirado) {
        return res.status(409).json({ success: false, error: 'Já existem lances pendentes para este item' });
      }

      // Função que calcula e envia lances DIRETO pelo servidor (sem Electron)
      const executarBlitz = async () => {
        let cachedAgora = disputasCache.disputas.find(d => d.compraId === compraId);
        let liveItemAgora = cachedAgora && cachedAgora.itens ? cachedAgora.itens.find(i => i.numero === parseInt(itemNumero)) : null;

        // Se faltam dados críticos (tipoVariacao) — provavelmente extensão antiga que não envia o campo —
        // puxar direto da API para evitar calcular com fallback 'V' errado
        if (liveItemAgora && liveItemAgora.tipoVariacao == null && sniper.temToken()) {
          try {
            const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`);
            if ((status === 200 || status === 206) && Array.isArray(data)) {
              const apiItem = data.find(i => (i.numero || i.identificador) === parseInt(itemNumero));
              if (apiItem) {
                liveItemAgora.variacaoMinima = apiItem.variacaoMinimaEntreLances ?? liveItemAgora.variacaoMinima;
                liveItemAgora.tipoVariacao = apiItem.tipoVariacaoMinimaEntreLances || liveItemAgora.tipoVariacao;
                liveItemAgora.melhorValor = (apiItem.melhorValorGeral || {}).valorInformado ?? liveItemAgora.melhorValor;
                liveItemAgora.nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado ?? liveItemAgora.nossoValor;
                liveItemAgora.situacaoParticipante = apiItem.situacaoParticipanteDisputa || liveItemAgora.situacaoParticipante;
                logAuto(`🔄 BLITZ refresh: ${compraId} item ${itemNumero} — varMin=${liveItemAgora.variacaoMinima} tipo=${liveItemAgora.tipoVariacao} nosso=${liveItemAgora.nossoValor}`);
              }
            }
          } catch (e) {
            logAuto(`⚠️ BLITZ refresh falhou: ${e.message}`);
          }
        }

        const itemAtual = liveItemAgora || liveItem;
        if (!itemAtual || itemAtual.nossoValor == null) {
          const motivo = sniper.temToken()
            ? 'Aborto: sem dados live (cache não populado e API não respondeu)'
            : 'Aborto: sem dados live (token Bearer ausente — Electron offline?)';
          console.log(`[Sniper] 🚀 BLITZ: ${compraId} item ${itemNumero} — sem dados live, abortando`);
          logAuto(`🚀 BLITZ: ${compraId} item ${itemNumero} — sem dados live, abortando`);
          const blitzKeyAbort = `${compraId}-${parseInt(itemNumero)}`;
          blitzHist.finalizarStatus(db, blitzKeyAbort, 'executada', {
            compraId, itemNumero: parseInt(itemNumero),
            lancesEnviados: 0, observacao: motivo,
          });
          try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(blitzKeyAbort); } catch (e) {}
          delete blitzAgendadas[blitzKeyAbort];
          notificarResultadoBlitz(compraId, parseInt(itemNumero), { sucessos: 0, falhas: 0, motivo: 'sem live data' });
          return 0;
        }

        const itemParaCalculo = {
          ...itemAtual,
          variacaoMinima: itemAtual.variacaoMinima != null ? itemAtual.variacaoMinima : cfgItem.variacaoMinima,
          tipoVariacao: itemAtual.tipoVariacao || cfgItem.tipoVariacao || 'V',
        };

        const cap = capPorItem != null ? capPorItem : (maxLances || 50);
        const batchLances = calcularBatchLances(cfgItem, itemParaCalculo, compraId, cap, modoBlitz || 'cobrir');
        if (batchLances.length === 0) {
          const dbg = `nosso=${itemParaCalculo.nossoValor} melhor=${itemParaCalculo.melhorValor} varMin=${itemParaCalculo.variacaoMinima} valMin=${cfgItem.valorMinimo} sit=${itemParaCalculo.situacaoParticipante} modo=${modoBlitz||'cobrir'}`;
          console.log(`[Sniper] 🚀 BLITZ: ${compraId} item ${itemNumero} — 0 lances (${dbg})`);
          logAuto(`🚀 BLITZ: ${compraId} item ${itemNumero} — 0 lances (${dbg})`);
          const blitzKeyAbort = `${compraId}-${parseInt(itemNumero)}`;
          blitzHist.finalizarStatus(db, blitzKeyAbort, 'executada', {
            compraId, itemNumero: parseInt(itemNumero),
            lancesEnviados: 0, observacao: `Aborto: batch vazio — ${dbg}`,
          });
          try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(blitzKeyAbort); } catch (e) {}
          delete blitzAgendadas[blitzKeyAbort];
          notificarResultadoBlitz(compraId, parseInt(itemNumero), { sucessos: 0, falhas: 0, motivo: 'batch vazio (piso/varMin)' });
          return 0;
        }

        const blitzKey = `${compraId}-${parseInt(itemNumero)}`;
        sniper.blitzDisparados[blitzKey] = Date.now();
        delete blitzAgendadas[blitzKey];
        try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(blitzKey); } catch (e) {}
        // Marca histórico como executada — count será atualizado após o loop.
        const histId_2053 = blitzHist.finalizarStatus(db, blitzKey, 'executada', {
          compraId, itemNumero: parseInt(itemNumero),
          observacao: 'Disparada (individual)',
        });

        const valorInicial = itemParaCalculo.nossoValor.toFixed(2);
        const valorFinal = batchLances[batchLances.length - 1].valor.toFixed(2);
        logAuto(`📋 BLITZ ${compraId} item ${itemNumero} estado pré-disparo: fase=${itemParaCalculo.fase || '?'} sit=${itemParaCalculo.situacaoParticipante || '?'} melhorGeral=${itemParaCalculo.melhorValor} nosso=${itemParaCalculo.nossoValor} varMin=${itemParaCalculo.variacaoMinima} tipoVar=${itemParaCalculo.tipoVariacao} batch=[${batchLances.slice(0,3).map(l => l.valor.toFixed(2)).join(', ')}${batchLances.length > 3 ? ', …' : ''}]`);
        console.log(`[Sniper] 🚀 BLITZ DIRETO: ${compraId} item ${itemNumero} — ${batchLances.length} lances (R$${valorInicial} → R$${valorFinal}) varMin=${itemParaCalculo.variacaoMinima}`);
        logAuto(`🚀 BLITZ DIRETO: ${compraId} item ${itemNumero} — ${batchLances.length} lances (R$${valorInicial} → R$${valorFinal})`);

        // Enviar lances direto pelo servidor
        let sucessos = 0, falhas = 0;
        for (const lance of batchLances) {
          try {
            const resultado = await sniper.enviarLance(compraId, parseInt(itemNumero), lance.valor, lance.faseItem || 'LA');
            // Salvar no histórico
            const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
            try {
              db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, parseInt(itemNumero), lance.valor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'blitz-servidor', new Date().toISOString());
            } catch (dbErr) {}

            if (resultado.sucesso) {
              sucessos++;
            } else {
              falhas++;
              if (resultado.status === 401 || resultado.status === 403) break; // sem token → para
              if (resultado.status === 422) {
                const tipo = classificar422(resultado.resposta);
                logAuto(`🩹 BLITZ 422 ${tipo}: ${compraId} item ${itemNumero} R$ ${lance.valor.toFixed(2)}`);
                if (tipo === 'colisao')       continue;   // próximo lance é varMin abaixo → diferente
                if (tipo === 'valor-baixo')   break;      // demais valores ainda menores → todos vão falhar
                if (tipo === 'fase-invalida') break;      // disputa encerrou
                break;                                    // tipo desconhecido: conservador
              }
            }
          } catch (e) {
            falhas++;
            break;
          }
        }

        itemAtual.nossoValor = batchLances[batchLances.length - 1].valor;
        console.log(`[Sniper] 🚀 BLITZ DIRETO resultado: ${compraId} item ${itemNumero} — ${sucessos} ✅ ${falhas} ❌`);
        logAuto(`🚀 BLITZ DIRETO: ${compraId} item ${itemNumero} — ${sucessos} ✅ ${falhas} ❌`);

        // Histórico: atualiza contagem real de lances enviados.
        blitzHist.atualizarLances(db, histId_2053, sucessos + falhas,
          `Disparada (individual): ${sucessos} OK, ${falhas} falhas`);

        iniciarGuard(compraId, parseInt(itemNumero));
        // Telegram: pós-blitz notifica se somos melhor colocado
        notificarResultadoBlitz(compraId, parseInt(itemNumero), { sucessos, falhas });
        return sucessos;
      };

      // Se horário foi especificado, agendar em vez de disparar imediatamente
      if (horario) {
        const itemNum = parseInt(itemNumero);
        const modo = modoBlitz || 'cobrir';
        const maxLancesEfetivo = maxLances || 50;

        // Auto-cálculo (2026-05-25 fix): `alvoMs` = momento de CHEGADA do último
        // lance. `dispatchAlvo` = quando setTimeout dispara (recuado pra que
        // a rajada inteira termine em alvoMs).
        const { alvoUltimoLance, dispatchAlvo, horarioEfetivo, dispatchHora, duracaoTotalMs, msCalculado } = _calcularMilesimoAuto({
          horario,
          itensCount: 1,
          maxLancesArr: [maxLancesEfetivo],
          milesimoAlvo,
        });
        const alvoMs = alvoUltimoLance.getTime();        // pra DB/telemetria/grupo
        const dispatchMs = dispatchAlvo.getTime();
        const delayMs = dispatchMs - sniper.tempoServidorAgora();

        if (delayMs < -5000) {
          const agoraStr = new Date().toTimeString().slice(0,8);
          return res.status(400).json({ success: false, error: `Horário ${horarioEfetivo} (dispatch ${dispatchHora}) já passou (agora: ${agoraStr}, offset: ${sniper.offsetServidorMs}ms)` });
        }

        // blitzKey inclui alvoMs → múltiplas blitzes pro mesmo item são permitidas.
        // Se já existe blitz com mesmo (compraId, itemNumero, alvoMs), é re-agendamento
        // exato — substitui (cancela timer antigo do grupo, idêntico ao update).
        const blitzKey = _mkBlitzKey(compraId, itemNum, alvoMs);
        if (blitzAgendadas[blitzKey]) {
          const oldAlvoMs = blitzAgendadas[blitzKey].alvoMs;
          const oldGrupo = blitzGruposPorAlvo.get(oldAlvoMs);
          if (oldGrupo) {
            oldGrupo.items = oldGrupo.items.filter(i => !(i.compraId === compraId && i.itemNumero === itemNum));
            if (oldGrupo.items.length === 0) {
              if (oldGrupo.timer) clearTimeout(oldGrupo.timer);
              blitzGruposPorAlvo.delete(oldAlvoMs);
            }
          }
          delete blitzAgendadas[blitzKey];
        }

        const itemConfig = {
          compraId,
          itemNumero: itemNum,
          valorMinimo: cfgItem.valorMinimo,
          faseItem: cfgItem.faseItem,
          variacaoMinima: cfgItem.variacaoMinima,
          tipoVariacao: cfgItem.tipoVariacao,
          maxLances: maxLancesEfetivo,
        };

        // Coalescing: existe grupo no mesmo alvoMs? Anexa.
        let grupo = blitzGruposPorAlvo.get(alvoMs);
        let timerCompartilhado;
        if (grupo) {
          // Anexa ao grupo existente — não cria novo timer
          grupo.items.push(itemConfig);
          timerCompartilhado = grupo.timer;
          console.log(`[Sniper] ⏰ BLITZ COALESCIDA: ${compraId} item ${itemNum} anexada ao timer existente (alvoMs=${alvoMs}, total no grupo=${grupo.items.length})`);
          logAuto(`⏰ BLITZ COALESCIDA: ${compraId} item ${itemNum} (grupo tem ${grupo.items.length} item(ns))`);
        } else {
          // Cria grupo novo + timer
          grupo = { items: [itemConfig], timer: null, horarioEfetivo, modo, capPorItem };
          blitzGruposPorAlvo.set(alvoMs, grupo);
          agendarPreDisparoTasks(alvoMs, 1, 'Sniper', [compraId]);

          timerCompartilhado = setTimeout(async () => {
            const agoraMs = Date.now();
            // desvioDispatch: timer real vs alvo dispatch (recuado). Pra avaliar precisão do setTimeout.
            const desvioDispatchMs = Math.round(sniper.tempoServidorAgora() - dispatchMs);
            const d = new Date(agoraMs); const horaReal = d.toTimeString().slice(0,8) + '.' + String(d.getMilliseconds()).padStart(3,'0');
            const itens = grupo.items;
            console.log(`[Sniper] ⏰ BLITZ DIRETO disparando ${itens.length} item(ns) — alvo último=${horarioEfetivo} dispatch real=${horaReal} (recuo=${duracaoTotalMs}ms, desvio dispatch=${desvioDispatchMs}ms, offset=${sniper.offsetServidorMs}ms)`);
            logAuto(`⏰ BLITZ DIRETO: ${itens.length} item(ns) — recuo=${duracaoTotalMs}ms, desvio=${desvioDispatchMs}ms`);
            try {
              await _executarRoundRobinBlitz({
                itensConfig: itens,
                modo: grupo.modo,
                capPorItem: grupo.capPorItem,
                tag: itens.length > 1 ? 'BLITZ-COALESCIDA' : 'BLITZ',
                fonte: 'blitz-servidor',
                alvoMs,
              });
            } finally {
              blitzGruposPorAlvo.delete(alvoMs);
            }
          }, Math.max(0, delayMs));
          grupo.timer = timerCompartilhado;
        }

        blitzAgendadas[blitzKey] = {
          timer: timerCompartilhado, horario: horarioEfetivo, compraId, itemNumero: itemNum,
          maxLances: maxLancesEfetivo, modoBlitz: modo, agendadoEm: new Date().toISOString(), alvoMs,
        };

        // Persistir no banco
        try {
          db.prepare(`INSERT OR REPLACE INTO blitz_agendadas
            (blitzKey, compraId, itemNumero, horario, alvoMs, maxLances, modoBlitz, agendadoEm)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(blitzKey, compraId, itemNum, horarioEfetivo, alvoMs, maxLancesEfetivo, modo, new Date().toISOString());
        } catch (e) { console.warn('[BLITZ] persist falhou:', e.message); }
        blitzHist.registrarAgendada(db, {
          blitzKey, compraId, itemNumero: itemNum, horario: horarioEfetivo, alvoMs,
          maxLances: maxLancesEfetivo, modoBlitz: modo,
          agendadoEm: new Date().toISOString(),
        });

        if (motorLigado() && delayMs > 0) {
          iniciarGuard(compraId, itemNum, alvoMs);
        }

        console.log(`[Sniper] ⏰ BLITZ AGENDADA: ${compraId} item ${itemNum} para ${horarioEfetivo} (em ${Math.round(delayMs/1000)}s)${msCalculado != null ? ' [auto-calc]' : ''}`);
        logAuto(`⏰ BLITZ AGENDADA: ${compraId} item ${itemNum} para ${horarioEfetivo} (em ${Math.round(delayMs/1000)}s)`);

        return res.json({
          success: true,
          agendado: true,
          horario: horarioEfetivo,
          horarioAjustadoAuto: msCalculado != null,
          milesimoAlvo: milesimoAlvo || (msCalculado != null ? 970 : null),
          maxLances: maxLancesEfetivo,
          ignoreMax: !!ignoreMax,
          coalesced: grupo.items.length > 1,
          itensNoGrupo: grupo.items.length,
          delayMs,
          message: `Blitz agendada para ${horarioEfetivo} (em ${Math.round(delayMs/1000)}s${grupo.items.length > 1 ? `, coalescida com ${grupo.items.length - 1} outra(s)` : ''})`,
        });
      }

      // Disparo imediato — direto pelo servidor
      const itemParaCalculo = {
        ...liveItem,
        variacaoMinima: liveItem.variacaoMinima != null ? liveItem.variacaoMinima : cfgItem.variacaoMinima,
        tipoVariacao: liveItem.tipoVariacao || cfgItem.tipoVariacao || 'V',
      };

      const capImediato = capPorItem != null ? capPorItem : (maxLances || 50);
      const batchLances = calcularBatchLances(cfgItem, itemParaCalculo, compraId, capImediato, modoBlitz || 'cobrir');
      if (batchLances.length === 0) {
        return res.json({ success: true, totalLances: 0, message: 'Nenhum lance a enviar (já no mínimo ou sem variação)' });
      }

      const blitzKey = `${compraId}-${parseInt(itemNumero)}`;
      sniper.blitzDisparados[blitzKey] = Date.now();

      logAuto(`📋 BLITZ ${compraId} item ${itemNumero} estado pré-disparo: fase=${itemParaCalculo.fase || '?'} sit=${itemParaCalculo.situacaoParticipante || '?'} melhorGeral=${itemParaCalculo.melhorValor} nosso=${itemParaCalculo.nossoValor} varMin=${itemParaCalculo.variacaoMinima} tipoVar=${itemParaCalculo.tipoVariacao} batch=[${batchLances.slice(0,3).map(l => l.valor.toFixed(2)).join(', ')}${batchLances.length > 3 ? ', …' : ''}]`);
      console.log(`[Sniper] 🚀 BLITZ DIRETO: ${compraId} item ${itemNumero} — ${batchLances.length} lances (R$${itemParaCalculo.nossoValor.toFixed(2)} → R$${batchLances[batchLances.length - 1].valor.toFixed(2)})`);
      logAuto(`🚀 BLITZ DIRETO: ${compraId} item ${itemNumero} — ${batchLances.length} lances`);

      // Enviar em background (não bloquear response)
      setImmediate(async () => {
        let sucessos = 0, falhas = 0;
        for (const lance of batchLances) {
          try {
            const resultado = await sniper.enviarLance(compraId, parseInt(itemNumero), lance.valor, lance.faseItem || 'LA');
            const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
            try {
              db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, parseInt(itemNumero), lance.valor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'blitz-servidor', new Date().toISOString());
            } catch (dbErr) {}
            if (resultado.sucesso) {
              sucessos++;
            } else {
              falhas++;
              if (resultado.status === 401 || resultado.status === 403) break;
              if (resultado.status === 422) {
                const tipo = classificar422(resultado.resposta);
                logAuto(`🩹 BLITZ 422 ${tipo}: ${compraId} item ${itemNumero} R$ ${lance.valor.toFixed(2)}`);
                if (tipo === 'colisao')       continue;
                if (tipo === 'valor-baixo')   break;
                if (tipo === 'fase-invalida') break;
                break;
              }
            }
          } catch (e) { falhas++; break; }
        }
        liveItem.nossoValor = batchLances[batchLances.length - 1].valor;
        console.log(`[Sniper] 🚀 BLITZ DIRETO resultado: ${compraId} item ${itemNumero} — ${sucessos} ✅ ${falhas} ❌`);
        iniciarGuard(compraId, parseInt(itemNumero));
      });

      res.json({
        success: true,
        totalLances: batchLances.length,
        via: 'servidor',
        lances: batchLances.map(l => ({ id: l.id, valor: l.valor, batchIndex: l.batchIndex })),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Cancelar blitz agendada
  // POST /api/sniper/cancelar-blitz { compraId, itemNumero, alvoMs?, blitzKey? }
  // Sem alvoMs/blitzKey: cancela TODAS as blitzes pendentes desse item.
  app.post('/api/sniper/cancelar-blitz', (req, res) => {
    const { compraId, itemNumero, alvoMs, blitzKey: blitzKeyParam } = req.body;
    const itemNum = parseInt(itemNumero);
    const prefixo = _itemPrefix(compraId, itemNum);

    // Acha alvos a cancelar
    let alvos;
    if (blitzKeyParam) {
      alvos = blitzAgendadas[blitzKeyParam] ? [blitzKeyParam] : [];
    } else if (alvoMs != null) {
      const k = _mkBlitzKey(compraId, itemNum, alvoMs);
      alvos = blitzAgendadas[k] ? [k] : [];
    } else {
      alvos = Object.keys(blitzAgendadas).filter(k => k.startsWith(prefixo));
    }

    if (alvos.length === 0) {
      return res.json({ success: false, error: 'Nenhuma blitz agendada para este item' });
    }

    const canceladas = [];
    for (const k of alvos) {
      const agendada = blitzAgendadas[k];
      if (!agendada) continue;
      const timer = agendada.timer;
      const aMs = agendada.alvoMs;
      // BUG FIX 2026-07-01: cancelando via blitzKey só, compraId/itemNumero do req.body
      // vinham undefined → o filtro de grupo.items não removia nada e o timer COMPARTILHADO
      // (coalescência por alvoMs) disparava a blitz mesmo "cancelada" (blitzAgendadas já
      // esvaziado dava falso "success"). Usar sempre os dados do próprio registro.
      const cId = agendada.compraId;
      const iNum = agendada.itemNumero;
      delete blitzAgendadas[k];
      try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(k); } catch (e) {}
      blitzHist.finalizarStatus(db, k, 'cancelada', {
        observacao: `Cancelada manualmente (era para ${agendada.horario})`,
      });
      const grupo = blitzGruposPorAlvo.get(aMs);
      if (grupo) {
        grupo.items = grupo.items.filter(i => !(i.compraId === cId && i.itemNumero === iNum));
        if (grupo.items.length === 0) {
          if (grupo.timer) clearTimeout(grupo.timer);
          blitzGruposPorAlvo.delete(aMs);
        }
      } else {
        const outrosUsam = Object.values(blitzAgendadas).some(b => b.timer === timer);
        if (!outrosUsam && timer) clearTimeout(timer);
      }
      canceladas.push({ blitzKey: k, horario: agendada.horario });
    }
    logAuto(`❌ BLITZ${canceladas.length > 1 ? 'ES' : ''} CANCELADA${canceladas.length > 1 ? 'S' : ''}: ${compraId} item ${itemNumero} — ${canceladas.length} (${canceladas.map(c => c.horario).join(', ')})`);
    res.json({ success: true, canceladas, message: `${canceladas.length} blitz(es) cancelada(s) (${canceladas.map(c => c.horario).join(', ')})` });
  });

  // Agendar lance único para horário específico
  var lancesAgendados = {};

  app.post('/api/sniper/agendar-lance', (req, res) => {
    try {
      const { compraId, itemNumero, valor, horario } = req.body;
      if (!compraId || itemNumero == null || !valor || !horario) {
        return res.status(400).json({ success: false, error: 'compraId, itemNumero, valor e horario obrigatórios' });
      }

      const agora = new Date();
      let h = horario;
      if (h.length === 5) h += ':00.500';
      else if (h.length === 8) h += '.500';

      const partes = h.split(':');
      const hh = parseInt(partes[0]) || 0;
      const mm = parseInt(partes[1]) || 0;
      const secParts = (partes[2] || '0').split('.');
      const ss = parseInt(secParts[0]) || 0;
      const ms = parseInt((secParts[1] || '0').padEnd(3, '0').substring(0, 3)) || 0;
      const alvo = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), hh, mm, ss, ms);
      const delayMs = alvo.getTime() - agora.getTime();

      if (delayMs < 0) {
        return res.status(400).json({ success: false, error: `Horário ${horario} já passou (agora: ${agora.toTimeString().slice(0,8)})` });
      }

      const lanceKey = `${compraId}-${parseInt(itemNumero)}`;

      if (lancesAgendados[lanceKey]) {
        clearTimeout(lancesAgendados[lanceKey].timer);
      }

      const alvoMs = alvo.getTime();
      const valorFloat = parseFloat(valor);
      // Usar relógio calibrado
      const delayCalibrado = alvoMs - sniper.tempoServidorAgora();
      const timer = setTimeout(async () => {
        const desvioMs = Math.round(sniper.tempoServidorAgora() - alvoMs);
        console.log(`[Sniper] ⏰ LANCE AGENDADO DIRETO: ${compraId} item ${itemNumero} R$${valorFloat.toFixed(2)} — alvo=${h} desvio=${desvioMs}ms`);
        logAuto(`⏰ LANCE AGENDADO DIRETO: ${compraId} item ${itemNumero} R$${valorFloat.toFixed(2)} — desvio=${desvioMs}ms`);

        try {
          const resultado = await sniper.enviarLance(compraId, parseInt(itemNumero), valorFloat, 'LA');
          const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
          db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, parseInt(itemNumero), valorFloat, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'agendado-servidor', new Date().toISOString());
          console.log(`[Sniper] ⏰ LANCE AGENDADO: ${resultado.sucesso ? '✅' : '❌'} R$${valorFloat.toFixed(2)} (${resultado.tempoMs}ms)`);
        } catch (e) {
          console.error(`[Sniper] ⏰ LANCE AGENDADO erro: ${e.message}`);
        }
        delete lancesAgendados[lanceKey];
      }, Math.max(0, delayCalibrado));

      lancesAgendados[lanceKey] = { timer, horario: h, compraId, itemNumero: parseInt(itemNumero), valor: valorFloat, agendadoEm: agora.toISOString() };

      console.log(`[Sniper] ⏰ LANCE AGENDADO: ${compraId} item ${itemNumero} R$${valorFloat.toFixed(2)} para ${h} (em ${Math.round(delayMs/1000)}s)`);
      logAuto(`⏰ LANCE AGENDADO: ${compraId} item ${itemNumero} R$${valorFloat.toFixed(2)} para ${h} (em ${Math.round(delayMs/1000)}s)`);

      res.json({ success: true, horario: h, valor: valorFloat, delayMs, message: `Lance R$${valorFloat.toFixed(2)} agendado para ${h} (em ${Math.round(delayMs/1000)}s)` });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sniper/cancelar-lance-agendado', (req, res) => {
    const { compraId, itemNumero } = req.body;
    const lanceKey = `${compraId}-${parseInt(itemNumero)}`;
    const agendado = lancesAgendados[lanceKey];
    if (!agendado) {
      return res.json({ success: false, error: 'Nenhum lance agendado para este item' });
    }
    clearTimeout(agendado.timer);
    delete lancesAgendados[lanceKey];
    logAuto(`❌ LANCE CANCELADO: ${compraId} item ${itemNumero} R$${agendado.valor.toFixed(2)} (era para ${agendado.horario})`);
    res.json({ success: true, message: `Lance cancelado (era para ${agendado.horario})` });
  });

  /**
   * POST /api/sniper/blitz-global
   * Agenda blitz para TODOS os itens com valorMinimo de todas as compras em disputa.
   */
  app.post('/api/sniper/blitz-global', (req, res) => {
    try {
      const { horario, modoBlitz, maxLancesDefault, milesimoAlvo, ignoreMax } = req.body;
      // ignoreMax: Plano 15 — ignora o Máx lances por item. Desce até o Valor Mínimo.
      // calcularBatchLances para quando valor <= valorMinimo; o 99999 aqui é só
      // um integer grande persistível no SQLite (Infinity não serializa).
      const capPorItem = ignoreMax ? 99999 : null;
      if (!horario) return res.status(400).json({ success: false, error: 'Horário obrigatório' });

      // Calcular milésimo automaticamente se não informado
      // Usa latência medida e número de lances para acertar o milésimo alvo (~900)
      const agora = new Date();
      const partes = horario.split(':');
      const hh = parseInt(partes[0]) || 0, mm = parseInt(partes[1]) || 0;
      const secParts = (partes[2] || '0').split('.');
      const ss = parseInt(secParts[0]) || 0;
      let msInput = secParts[1] ? parseInt((secParts[1] || '0').padEnd(3, '0').substring(0, 3)) : -1; // -1 = não informado

      // Buscar itens elegíveis ANTES do auto-cálculo (precisa do maxLances)
      const itensElegiveis = db.prepare(`
        SELECT si.compraId, si.itemNumero, si.valorMinimo, si.faseItem, si.variacaoMinima, si.tipoVariacao, si.maxLances
        FROM sniper_itens si
        JOIN participacoes_comprasnet pc ON si.compraId = pc.compraId
        WHERE si.valorMinimo IS NOT NULL AND si.valorMinimo > 0
          AND pc.ativo = 1 AND pc.faseCompra = '3' AND pc.situacao IN ('PD', 'AB', '5')
        ORDER BY si.compraId, si.itemNumero
      `).all();

      if (itensElegiveis.length === 0) {
        return res.json({ success: false, error: 'Nenhum item elegível (sem valorMinimo ou sem compra em disputa)' });
      }

      let msCalculado = null;
      const milesimoTarget = milesimoAlvo || 970;

      if (msInput < 0) {
        // Calcular automaticamente com valores calibrados
        const oneWay = 76;          // mediana RTT/2
        const rttMediana = 153;     // mediana RTT (para 1 item sequencial)
        const intervaloRR = 157;    // mediana entre rodadas round-robin (2+ itens)
        const bufferSpike = 30;     // compensar jitter residual

        // maxLances: usar o do item (ignorar itens sem configuração no cálculo)
        const lancesConfigurados = itensElegiveis.map(i => i.maxLances).filter(m => m > 0);
        const maxLancesReal = lancesConfigurados.length > 0
          ? Math.max(...lancesConfigurados)
          : (maxLancesDefault || 5);
        const numRodadas = maxLancesReal - 1;

        // Intervalo depende de quantos itens: 1 item = RTT puro, 2+ = round-robin
        const numItens = itensElegiveis.length;
        const intervalo = numItens > 1 ? intervaloRR : rttMediana;
        const duracaoTotal = oneWay + (numRodadas * intervalo) + bufferSpike;

        msCalculado = milesimoTarget - duracaoTotal;
        // Se negativo (rajada > 1s), começar no segundo anterior
        let ssAjustado = ss;
        if (msCalculado < 0) {
          ssAjustado = ss - 1;
          msCalculado = 1000 + msCalculado;
        }
        if (ssAjustado < 0) { ssAjustado = 59; }

        msInput = Math.max(0, Math.round(msCalculado));
        console.log(`[BLITZ-GLOBAL] Auto-cálculo: alvo=${milesimoTarget}ms, oneWay=${oneWay}ms, intervalo=${intervalo}ms, rodadas=${numRodadas}, duração=${duracaoTotal}ms → milésimo=${msInput} (segundo=${ssAjustado})`);

        // Reconstruir partes com segundo ajustado
        partes[2] = String(ssAjustado);
      }

      const ms = Math.max(0, msInput);
      const alvo = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), hh, mm, parseInt(partes[2]) || ss, ms);
      const delayMs = alvo.getTime() - sniper.tempoServidorAgora();
      if (delayMs < -5000) return res.status(400).json({ success: false, error: `Horário ${horario} já passou` });

      const horarioEfetivo = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(parseInt(partes[2])||ss).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;

      const agendados = [];
      const erros = [];
      const modo = modoBlitz || 'sequencial';
      const alvoMs = alvo.getTime();

      const agendadosList = [];

      // ── Camada 2: pregão (05) fecha aleatório — fora da rajada de horário fixo (use Contínuo).
      const elegiveis = req.body.overridePregao ? itensElegiveis : itensElegiveis.filter(it => {
        if (isPregaoCompraId(it.compraId)) { erros.push(`${it.compraId} item ${it.itemNumero}: pregão (fecha aleatório) — pulado; use Contínuo`); return false; }
        return true;
      });

      for (const item of elegiveis) {
        const blitzKey = _mkBlitzKey(item.compraId, item.itemNumero, alvoMs);
        // Mesmo alvoMs + item já agendado = re-agendamento exato — substitui (cancela timer)
        if (blitzAgendadas[blitzKey] && blitzAgendadas[blitzKey].timer) clearTimeout(blitzAgendadas[blitzKey].timer);
        const jaEnfileirado = sniper.filaLances.some(l =>
          l.compraId === item.compraId && l.itemNumero === item.itemNumero &&
          (l.status === 'pendente' || l.status === 'processando')
        );
        if (jaEnfileirado) { erros.push(`${item.compraId} item ${item.itemNumero}: já tem lances pendentes`); continue; }
        agendadosList.push(item);
        // capPorItem = Infinity quando ignoreMax=true (desce até Valor Mínimo);
        // senão usa o Máx do item (ou default do body, ou fallback 5).
        const itemMaxLances = capPorItem != null ? capPorItem : (item.maxLances || maxLancesDefault || 5);
        agendados.push({ compraId: item.compraId, itemNumero: item.itemNumero, maxLances: itemMaxLances });
        blitzAgendadas[blitzKey] = { timer: null, horario, compraId: item.compraId, itemNumero: item.itemNumero, maxLances: itemMaxLances, modoBlitz: modo, agendadoEm: agora.toISOString(), alvoMs };
        // Persistir no banco para sobreviver a restart
        try {
          db.prepare(`INSERT OR REPLACE INTO blitz_agendadas
            (blitzKey, compraId, itemNumero, horario, alvoMs, maxLances, modoBlitz, agendadoEm)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(blitzKey, item.compraId, item.itemNumero, horario, alvoMs, itemMaxLances, modo, agora.toISOString());
        } catch (e) { console.warn('[BLITZ-GLOBAL] persist falhou:', e.message); }
        // Histórico permanente — registro do agendamento (status='agendada').
        blitzHist.registrarAgendada(db, {
          blitzKey, compraId: item.compraId, itemNumero: item.itemNumero,
          horario, alvoMs, maxLances: itemMaxLances, modoBlitz: modo,
          agendadoEm: agora.toISOString(),
        });
      }

      if (agendadosList.length === 0) {
        return res.json({ success: false, error: erros.length > 0 ? erros.join('; ') : 'Nenhum item elegível' });
      }

      // Helper: enviar lances de um item sequencialmente e salvar no histórico
      const enviarLancesItem = async (compraId, itemNumero, batchLances) => {
        let sucessos = 0, falhas = 0;
        for (const lance of batchLances) {
          try {
            const resultado = await sniper.enviarLance(compraId, itemNumero, lance.valor, lance.faseItem || 'LA');
            const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
            try { db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, itemNumero, lance.valor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'blitz-servidor', new Date().toISOString()); } catch (e) {}
            if (resultado.sucesso) {
              sucessos++;
            } else {
              falhas++;
              if (resultado.status === 401 || resultado.status === 403) break;
              if (resultado.status === 422) {
                const tipo = classificar422(resultado.resposta);
                logAuto(`🩹 BLITZ 422 ${tipo}: ${compraId} item ${itemNumero} R$ ${lance.valor.toFixed(2)}`);
                if (tipo === 'colisao')       continue;
                if (tipo === 'valor-baixo')   break;
                if (tipo === 'fase-invalida') break;
                break;
              }
            }
          } catch (e) { falhas++; break; }
        }
        return { sucessos, falhas };
      };

      agendarPreDisparoTasks(alvoMs, agendadosList.length, 'BLITZ-GLOBAL', [...new Set(agendadosList.map(i => i.compraId))]);

      // Guard liga imediatamente com ramp dinâmico — polling degradê até o disparo.
      // Motor desligado → não polla (usuário optou por ficar passivo).
      if (motorLigado()) {
        for (const item of agendadosList) {
          iniciarGuard(item.compraId, item.itemNumero, alvoMs);
        }
        logAuto(`🛡️ GUARD ramped ativado para ${agendadosList.length} item(ns) — disparo em ${Math.round(delayMs/1000)}s`);
      }

      // Um único timer para TODOS os itens
      const timer = setTimeout(async () => {
        const desvioMs = Math.round(sniper.tempoServidorAgora() - alvoMs);
        console.log(`[BLITZ-GLOBAL] DIRETO disparando ${agendadosList.length} itens — desvio=${desvioMs}ms (offset=${sniper.offsetServidorMs}ms)`);
        logAuto(`⏰ BLITZ-GLOBAL DIRETO: ${agendadosList.length} itens — desvio=${desvioMs}ms`);

        // Calcular batches para todos os itens
        const itensBatches = [];
        for (const item of agendadosList) {
          const blitzKey = _mkBlitzKey(item.compraId, item.itemNumero, alvoMs);
          const cached = disputasCache.disputas.find(d => d.compraId === item.compraId);
          const liveItem = cached && cached.itens ? cached.itens.find(i => i.numero === item.itemNumero) : null;
          if (!liveItem || liveItem.nossoValor == null) {
            const motivo = sniper.temToken()
              ? 'Aborto: sem dados live (cache não populado e API não respondeu)'
              : 'Aborto: sem dados live (token Bearer ausente — Electron offline?)';
            blitzHist.finalizarStatus(db, blitzKey, 'executada', {
              compraId: item.compraId, itemNumero: item.itemNumero,
              lancesEnviados: 0, observacao: motivo,
            });
            try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(blitzKey); } catch (e) {}
            delete blitzAgendadas[blitzKey];
            notificarResultadoBlitz(item.compraId, item.itemNumero, { sucessos: 0, falhas: 0, motivo: 'sem live data' });
            continue;
          }

          // Refresh direto da API se faltar tipoVariacao (extensão antiga que não envia o campo)
          if (liveItem.tipoVariacao == null && sniper.temToken()) {
            try {
              const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${item.compraId}/itens/em-disputa`);
              if ((status === 200 || status === 206) && Array.isArray(data)) {
                const apiItem = data.find(i => (i.numero || i.identificador) === item.itemNumero);
                if (apiItem) {
                  liveItem.variacaoMinima = apiItem.variacaoMinimaEntreLances ?? liveItem.variacaoMinima;
                  liveItem.tipoVariacao = apiItem.tipoVariacaoMinimaEntreLances || liveItem.tipoVariacao;
                  liveItem.melhorValor = (apiItem.melhorValorGeral || {}).valorInformado ?? liveItem.melhorValor;
                  liveItem.nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado ?? liveItem.nossoValor;
                  liveItem.situacaoParticipante = apiItem.situacaoParticipanteDisputa || liveItem.situacaoParticipante;
                  logAuto(`🔄 BLITZ-GLOBAL refresh: ${item.compraId} item ${item.itemNumero} — varMin=${liveItem.variacaoMinima} tipo=${liveItem.tipoVariacao} nosso=${liveItem.nossoValor}`);
                }
              }
            } catch (e) {
              logAuto(`⚠️ BLITZ-GLOBAL refresh falhou: ${e.message}`);
            }
          }

          const itemParaCalculo = {
            ...liveItem,
            variacaoMinima: liveItem.variacaoMinima != null ? liveItem.variacaoMinima : item.variacaoMinima,
            tipoVariacao: liveItem.tipoVariacao || item.tipoVariacao || 'V',
          };
          const itemMaxLances = capPorItem != null ? capPorItem : (item.maxLances || maxLancesDefault || 5);
          const batchLances = calcularBatchLances(item, itemParaCalculo, item.compraId, itemMaxLances, modo);
          if (batchLances.length === 0) {
            const dbg = `nosso=${itemParaCalculo.nossoValor} melhor=${itemParaCalculo.melhorValor} varMin=${itemParaCalculo.variacaoMinima} valMin=${item.valorMinimo} sit=${itemParaCalculo.situacaoParticipante} modo=${modo}`;
            blitzHist.finalizarStatus(db, blitzKey, 'executada', {
              compraId: item.compraId, itemNumero: item.itemNumero,
              lancesEnviados: 0, observacao: `Aborto: batch vazio — ${dbg}`,
            });
            try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(blitzKey); } catch (e) {}
            delete blitzAgendadas[blitzKey];
            notificarResultadoBlitz(item.compraId, item.itemNumero, { sucessos: 0, falhas: 0, motivo: 'batch vazio (piso/varMin)' });
            continue;
          }
          sniper.blitzDisparados[blitzKey] = Date.now();
          delete blitzAgendadas[blitzKey];
          try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(blitzKey); } catch (e) {}
          // Histórico: marca executada (count atualizado após o loop round-robin)
          const histIdBlitz = blitzHist.finalizarStatus(db, blitzKey, 'executada', {
            compraId: item.compraId, itemNumero: item.itemNumero,
            observacao: 'Disparada (global/batch)',
          });
          const vi = itemParaCalculo.nossoValor.toFixed(2);
          const vf = batchLances[batchLances.length - 1].valor.toFixed(2);
          logAuto(`📋 BLITZ-GLOBAL ${item.compraId} item ${item.itemNumero} estado pré-disparo: fase=${itemParaCalculo.fase || '?'} sit=${itemParaCalculo.situacaoParticipante || '?'} melhorGeral=${itemParaCalculo.melhorValor} nosso=${itemParaCalculo.nossoValor} varMin=${itemParaCalculo.variacaoMinima} tipoVar=${itemParaCalculo.tipoVariacao} batch=[${batchLances.slice(0,3).map(l => l.valor.toFixed(2)).join(', ')}${batchLances.length > 3 ? ', …' : ''}]`);
          console.log(`[BLITZ-GLOBAL] DIRETO: ${item.compraId} item ${item.itemNumero} — ${batchLances.length} lances (R$${vi} → R$${vf})`);
          itensBatches.push({ compraId: item.compraId, itemNumero: item.itemNumero, batchLances, liveItem, historicoId: histIdBlitz });
        }

        if (itensBatches.length === 0) return;

        // Round-robin paralelo: cada rodada envia 1 lance de cada item via Promise.all
        const maxRodadas = Math.max(...itensBatches.map(ib => ib.batchLances.length));
        const itemFalhou = new Set(); // itens que falharam (422/401) — skip nas próximas rodadas
        const itemOk = {};
        const itemFalha = {};
        for (const ib of itensBatches) { itemOk[ib.compraId + '-' + ib.itemNumero] = 0; itemFalha[ib.compraId + '-' + ib.itemNumero] = 0; }

        for (let rodada = 0; rodada < maxRodadas; rodada++) {
          // Coletar 1 lance de cada item ativo nesta rodada
          const lancesRodada = [];
          for (const ib of itensBatches) {
            const key = ib.compraId + '-' + ib.itemNumero;
            if (itemFalhou.has(key)) continue;
            if (rodada >= ib.batchLances.length) continue;
            lancesRodada.push({ ib, lance: ib.batchLances[rodada], key });
          }
          if (lancesRodada.length === 0) break;

          // Promise.all: todos os itens desta rodada simultaneamente
          const resultados = await Promise.all(lancesRodada.map(({ ib, lance, key }) =>
            sniper.enviarLance(ib.compraId, ib.itemNumero, lance.valor, lance.faseItem || 'LA')
              .then(r => ({ key, ib, lance, resultado: r }))
              .catch(e => ({ key, ib, lance, resultado: { sucesso: false, status: 0, resposta: e.message, tempoMs: 0 } }))
          ));

          // Processar resultados da rodada
          for (const { key, ib, lance, resultado } of resultados) {
            const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
            try { db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ib.compraId, ib.itemNumero, lance.valor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'blitz-servidor', new Date().toISOString()); } catch (e) {}
            if (resultado.sucesso) {
              itemOk[key]++;
            } else {
              itemFalha[key]++;
              if (resultado.status === 401 || resultado.status === 403) itemFalhou.add(key);
              else if (resultado.status === 422) {
                const tipo = classificar422(resultado.resposta);
                logAuto(`🩹 BLITZ-GLOBAL 422 ${tipo}: ${ib.compraId} item ${ib.itemNumero} R$ ${lance.valor.toFixed(2)}`);
                // colisao: deixa o item continuar nas próximas rodadas (cada rodada
                // pega o próximo valor do batch, que está varMin abaixo do anterior)
                if (tipo !== 'colisao') itemFalhou.add(key);
              }
            }
          }
        }

        // Log resultados e cleanup
        for (const ib of itensBatches) {
          const key = ib.compraId + '-' + ib.itemNumero;
          ib.liveItem.nossoValor = ib.batchLances[ib.batchLances.length - 1].valor;
          console.log(`[BLITZ-GLOBAL] DIRETO resultado: ${ib.compraId} item ${ib.itemNumero} — ${itemOk[key]} ✅ ${itemFalha[key]} ❌`);
          // Histórico: atualiza contagem real
          blitzHist.atualizarLances(db, ib.historicoId, itemOk[key] + itemFalha[key],
            `Disparada (global/batch): ${itemOk[key]} OK, ${itemFalha[key]} falhas`);
          iniciarGuard(ib.compraId, ib.itemNumero);
          // Telegram: pós-blitz notifica se somos melhor colocado (1 por item)
          notificarResultadoBlitz(ib.compraId, ib.itemNumero, { sucessos: itemOk[key], falhas: itemFalha[key] });
        }
      }, Math.max(0, delayMs));

      // Registrar timer único no blitzAgendadas (para cancelamento)
      for (const item of agendadosList) {
        const blitzKey = `${item.compraId}-${item.itemNumero}`;
        if (blitzAgendadas[blitzKey]) blitzAgendadas[blitzKey].timer = timer;
      }

      console.log(`[BLITZ-GLOBAL] ${agendados.length} itens agendados para ${horarioEfetivo} (modo: ${modo})${msCalculado !== null ? ' [auto-calc]' : ''}`);
      res.json({
        success: agendados.length > 0,
        message: `${agendados.length} itens agendados para ${horarioEfetivo}${msCalculado !== null ? ' (auto)' : ''}`,
        agendados, erros: erros.length > 0 ? erros : undefined,
        horario: horarioEfetivo, modoBlitz: modo,
        autoCalc: msCalculado !== null ? { milesimoAlvo: milesimoTarget, milesimoCalculado: ms } : undefined,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Status das blitz agendadas
  app.get('/api/sniper/blitz-agendadas', (req, res) => {
    const lista = Object.entries(blitzAgendadas).map(([blitzKey, b]) => ({
      blitzKey,
      compraId: b.compraId,
      itemNumero: b.itemNumero,
      horario: b.horario,
      alvoMs: b.alvoMs,
      maxLances: b.maxLances || 50,
      modoBlitz: b.modoBlitz || 'cobrir',
      agendadoEm: b.agendadoEm,
    }));
    res.json({ success: true, agendadas: lista });
  });

  /**
   * GET /api/sniper/blitz-historico?compraId=...&itemNumero=...&limit=100&status=executada
   * Histórico permanente de blitzes (todas as instâncias passadas + ativas).
   * Filtros opcionais: compraId, itemNumero, status.
   */
  app.get('/api/sniper/blitz-historico', (req, res) => {
    try {
      const { compraId, itemNumero, status } = req.query;
      const limite = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
      const where = [];
      const params = [];
      if (compraId) { where.push('compraId = ?'); params.push(String(compraId)); }
      if (itemNumero) { where.push('itemNumero = ?'); params.push(Number(itemNumero)); }
      if (status) { where.push('status = ?'); params.push(String(status)); }
      const sql = `
        SELECT id, blitzKey, compraId, itemNumero, horarioAlvo, alvoMs,
               maxLances, modoBlitz, status,
               agendadoEm, executadoEm, canceladoEm,
               lancesEnviados, observacao
          FROM blitz_historico
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY agendadoEm DESC
         LIMIT ?
      `;
      const rows = db.prepare(sql).all(...params, limite);
      res.json({ success: true, historico: rows, total: rows.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/tokens/historico?limite=50
   * Histórico de tokens Bearer recebidos + decodificação JWT do atual.
   */
  app.get('/api/sniper/tokens/historico', (req, res) => {
    try {
      const limite = Math.max(1, Math.min(500, parseInt(req.query.limite) || 50));
      const rows = db.prepare(`
        SELECT id, source, tokenFingerprint, jti, subject, recebidoEm,
               expEm, substituidoEm, duracaoEsperadaSeg,
               motivoRejeicao, httpStatusRejeicao
          FROM bearer_history
         ORDER BY recebidoEm DESC
         LIMIT ?
      `).all(limite);

      // Calcula duração efetiva de cada token (substituidoEm - recebidoEm) ou (expEm - recebidoEm)
      const historico = rows.map(r => {
        let duracaoEfetivaSeg = null;
        if (r.substituidoEm) {
          duracaoEfetivaSeg = Math.floor((new Date(r.substituidoEm).getTime() - new Date(r.recebidoEm).getTime()) / 1000);
        } else if (!r.substituidoEm) {
          // Token atual — usa idade
          duracaoEfetivaSeg = Math.floor((Date.now() - new Date(r.recebidoEm).getTime()) / 1000);
        }
        const restanteSeg = r.expEm ? Math.floor((new Date(r.expEm).getTime() - Date.now()) / 1000) : null;
        return {
          ...r,
          duracaoEfetivaSeg,
          restanteSeg,
          atual: !r.substituidoEm,
        };
      });

      // Stats agregados
      const expirados = historico.filter(r => r.expEm && new Date(r.expEm) < new Date()).length;
      const completos = historico.filter(r => r.duracaoEsperadaSeg);
      const duracaoMediaSeg = completos.length
        ? Math.round(completos.reduce((s,r) => s + r.duracaoEsperadaSeg, 0) / completos.length)
        : null;

      // Estado atual
      const atual = historico.find(r => r.atual);
      const atualInfo = atual ? {
        source: atual.source,
        recebidoEm: atual.recebidoEm,
        expEm: atual.expEm,
        restanteSeg: atual.restanteSeg,
        restanteHumano: atual.restanteSeg != null
          ? (atual.restanteSeg < 0 ? `expirou há ${Math.abs(atual.restanteSeg)}s`
             : atual.restanteSeg < 60 ? `expira em ${atual.restanteSeg}s`
             : `expira em ${Math.floor(atual.restanteSeg/60)}m${atual.restanteSeg%60}s`)
          : null,
        valido: atual.restanteSeg != null ? atual.restanteSeg > 0 : null,
      } : null;

      res.json({
        success: true,
        total: rows.length,
        expirados,
        duracaoMediaSeg,
        atual: atualInfo,
        historico,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/electron/heartbeat
   * Recebe snapshot do estado interno do Electron Standalone a cada ~30s.
   * Permite auditar de fora "Electron está vivo? Está capturando bearer?"
   * Body: { tokenPresent, tokenAgeSec, lastCaptureAt, ssoMorto,
   *         lastSendAttemptAt, lastSendStatus, portal, versao, subject }
   */
  app.post('/api/electron/heartbeat', (req, res) => {
    try {
      const b = req.body || {};
      const agora = new Date().toISOString();
      db.prepare(`INSERT INTO electron_heartbeat
        (recebidoEm, tokenPresent, tokenAgeSec, lastCaptureAt, ssoMorto,
         lastSendAttemptAt, lastSendStatus, portal, versao, subject)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        agora,
        b.tokenPresent ? 1 : 0,
        b.tokenAgeSec != null ? Math.floor(b.tokenAgeSec) : null,
        b.lastCaptureAt || null,
        b.ssoMorto ? 1 : 0,
        b.lastSendAttemptAt || null,
        b.lastSendStatus != null ? String(b.lastSendStatus) : null,
        b.portal || null,
        b.versao || null,
        b.subject || null,
      );
      // Purge antigos: manter só últimas 24h (heartbeat é alto volume).
      db.prepare(`DELETE FROM electron_heartbeat WHERE recebidoEm < datetime('now', '-1 day')`).run();

      // Alerta de SSO morto (dedup por episódio; reseta quando o Electron recupera).
      if (b.ssoMorto) {
        alertarSSOMorto(b).catch(() => {});
      } else if (sniper._ssoMortoAlertado) {
        sniper._ssoMortoAlertado = false;
      }

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/electron/heartbeat-historico?limite=60
   * Histórico de heartbeats + estado atual derivado pra dashboard.
   */
  app.get('/api/sniper/electron/heartbeat-historico', (req, res) => {
    try {
      const limite = Math.max(1, Math.min(500, parseInt(req.query.limite) || 60));
      const rows = db.prepare(`
        SELECT id, recebidoEm, tokenPresent, tokenAgeSec, lastCaptureAt,
               ssoMorto, lastSendAttemptAt, lastSendStatus, portal, versao, subject
          FROM electron_heartbeat
         ORDER BY recebidoEm DESC
         LIMIT ?
      `).all(limite);

      const ultimo = rows[0] || null;
      const gapDesdeUltimoSeg = ultimo
        ? Math.floor((Date.now() - new Date(ultimo.recebidoEm).getTime()) / 1000)
        : null;

      // Status agregado:
      //  - gap > 90s OU sem heartbeat: 'offline'
      //  - sso morto: 'sso-morto'
      //  - sem token (mas Electron vivo): 'sem-token'
      //  - tudo ok: 'online'
      let status = 'offline';
      if (ultimo && gapDesdeUltimoSeg != null && gapDesdeUltimoSeg <= 90) {
        if (ultimo.ssoMorto) status = 'sso-morto';
        else if (!ultimo.tokenPresent) status = 'sem-token';
        else status = 'online';
      }

      // Alerta dedup-travado (2026-05-27): cruzar heartbeats da janela pra
      // detectar quando o Electron está vivo, mandando POST /api/auth/token
      // dedup'ado mas o bearer NÃO está sendo renovado em memória — sinal
      // que o interceptor parou de capturar. Critério:
      //   - últimos N >= 5 heartbeats todos com lastSendStatus='skip-dedup'
      //   - tokenAgeSec do mais antigo da janela < do mais recente (sobe)
      //   - tokenAgeSec atual > 300s
      let alertaDedup = null;
      const ultimos = rows.slice(0, 10).reverse(); // do mais antigo pro mais novo
      if (ultimos.length >= 5) {
        const todosSkip = ultimos.every(r => r.lastSendStatus === 'skip-dedup');
        const ageSubindo = ultimos[ultimos.length - 1].tokenAgeSec > (ultimos[0].tokenAgeSec || 0);
        const ageAlto = (ultimos[ultimos.length - 1].tokenAgeSec || 0) > 300;
        if (todosSkip && ageSubindo && ageAlto) {
          alertaDedup = {
            ativo: true,
            mensagem: `Electron envia mesmo bearer há ${ultimos.length} ciclos (skip-dedup). Bearer já com ${ultimos[ultimos.length-1].tokenAgeSec}s de idade — interceptor parece não estar capturando token novo.`,
            tokenAgeSec: ultimos[ultimos.length - 1].tokenAgeSec,
            ciclosSemBearerNovo: ultimos.length,
          };
        }
      }

      res.json({
        success: true,
        status,
        gapDesdeUltimoSeg,
        ultimo,
        alertaDedup,
        total: rows.length,
        historico: rows,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Watchdog: alerta T-2min antes da expiração do token (uma vez por token).
  // Roda a cada 30s.
  let _tokenExpAlertadoFp = null;
  setInterval(() => {
    if (!sniper.temToken) return;
    try {
      const segRest = sniper.segundosAteExpirar?.();
      if (segRest != null && segRest > 0 && segRest <= 120) {
        const fp = sniper._fingerprint?.(sniper.bearerToken);
        if (fp && fp !== _tokenExpAlertadoFp) {
          _tokenExpAlertadoFp = fp;
          const msg = `⚠️ Bearer Comprasnet expira em ${segRest}s — Electron precisa renovar antes!`;
          console.warn(`[TOKEN-WATCHDOG] ${msg}`);
          logAuto(msg);
          try { sendTelegram(db, msg).catch(() => {}); } catch (_) {}
        }
      }
    } catch (_) {}
  }, 30000);

  /**
   * GET /api/sniper/comprasnet-health?janela=60 (segundos)
   * Retorna stats agregados + timeline pra dashboard de saúde.
   */
  app.get('/api/sniper/comprasnet-health', (req, res) => {
    try {
      const janelaSeg = Math.max(60, Math.min(86400, parseInt(req.query.janela) || 600));
      const rows = db.prepare(`
        SELECT tipo, httpStatus, tempoMs, ok, erro, ts
          FROM comprasnet_health
         WHERE ts > datetime('now', '-${janelaSeg} seconds')
         ORDER BY ts DESC
         LIMIT 1000
      `).all();
      const total = rows.length;
      const okCount = rows.filter(r => r.ok).length;
      const failCount = total - okCount;
      const tempos = rows.filter(r => r.ok && r.tempoMs > 0).map(r => r.tempoMs);
      const tempoMedio = tempos.length ? Math.round(tempos.reduce((s,v)=>s+v,0)/tempos.length) : null;
      const tempoMax = tempos.length ? Math.max(...tempos) : null;

      // Agrupa por minuto pra timeline gráfico
      const porMinuto = {};
      for (const r of rows) {
        const min = r.ts ? r.ts.substring(0, 16) : null;
        if (!min) continue;
        if (!porMinuto[min]) porMinuto[min] = { ts: min, total: 0, ok: 0, falha: 0, statuses: {} };
        porMinuto[min].total++;
        if (r.ok) porMinuto[min].ok++; else porMinuto[min].falha++;
        const stKey = String(r.httpStatus || 'TO');
        porMinuto[min].statuses[stKey] = (porMinuto[min].statuses[stKey] || 0) + 1;
      }
      const timeline = Object.values(porMinuto).sort((a,b) => a.ts.localeCompare(b.ts));

      // Top status codes
      const statusCount = {};
      for (const r of rows) {
        const k = r.ok ? `OK_${r.httpStatus}` : `FAIL_${r.httpStatus || 'TO'}`;
        statusCount[k] = (statusCount[k] || 0) + 1;
      }

      const taxaSucesso = total > 0 ? Math.round(okCount / total * 100) : null;
      const veredito =
        total === 0 ? 'sem dados' :
        taxaSucesso >= 95 ? 'saudável' :
        taxaSucesso >= 80 ? 'instável' :
        'degradado';

      res.json({
        success: true,
        janelaSeg, total, okCount, failCount,
        taxaSucesso, tempoMedio, tempoMax,
        veredito,
        statusCount,
        timeline,
        ultimasFalhas: rows.filter(r => !r.ok).slice(0, 20),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/test-warmup?n=5&modo=imediato|agendado
   *   - modo=imediato (default): faz N pings agora e retorna diagnóstico
   *   - modo=agendado: simula o pre-disparo COMPLETO (agendarPreDisparoTasks)
   *     alvo daqui a 5s — você acompanha pelos logs
   * Não envia lances reais. Apenas pings GET ao Comprasnet.
   */
  app.get('/api/sniper/test-warmup', async (req, res) => {
    const n = Math.max(1, Math.min(20, parseInt(req.query.n) || 5));
    const modo = req.query.modo === 'agendado' ? 'agendado' : 'imediato';
    if (!sniper.temToken()) {
      return res.status(400).json({ success: false, error: 'Sem Bearer token — Electron offline?' });
    }
    if (modo === 'agendado') {
      // Simula o ciclo completo de pre-disparo (recalibração + warmup + retry).
      // Alvo daqui a 5s. Você vê os logs no journalctl.
      const alvoMs = Date.now() + 5000;
      console.log(`[TEST-WARMUP] modo=agendado — alvo=${new Date(alvoMs).toISOString()} (em 5s). Veja logs [TEST-PREDISPARO] pra resultados.`);
      agendarPreDisparoTasks(alvoMs, n, 'TEST-PREDISPARO', ['TEST']);
      return res.json({
        success: true,
        modo: 'agendado',
        alvoMs,
        alvoIso: new Date(alvoMs).toISOString(),
        n,
        message: `Pre-disparo agendado pra ${new Date(alvoMs).toISOString()} (em 5s). Acompanhe logs com: journalctl -u consulta-licitacoes -f | grep TEST-PREDISPARO`,
      });
    }
    const t0 = Date.now();
    const resultados = await Promise.all(
      Array.from({ length: n }, (_, i) => {
        const reqStart = Date.now();
        return sniper.apiGet('/comprasnet-disputa/v1/datahorabrasilia')
          .then(r => ({ idx: i+1, ok: r.status >= 200 && r.status < 400, status: r.status, ms: Date.now() - reqStart, dataHora: r.data || null }))
          .catch(e => ({ idx: i+1, ok: false, status: 0, ms: Date.now() - reqStart, err: e.message }));
      })
    );
    const totalMs = Date.now() - t0;
    const ok = resultados.filter(r => r.ok).length;
    const rtts = resultados.filter(r => r.ms > 0 && r.ok).map(r => r.ms);
    const rttMedio = rtts.length ? Math.round(rtts.reduce((s,v)=>s+v,0) / rtts.length) : null;
    const rttMin = rtts.length ? Math.min(...rtts) : null;
    const rttMax = rtts.length ? Math.max(...rtts) : null;
    const veredito =
      ok === n ? 'saudável' :
      ok / n >= 0.5 ? 'instável (warmup ainda dispara, mas log warning)' :
      'CAÍDO (warmup vai agendar retry T-500ms)';
    console.log(`[TEST-WARMUP] ${ok}/${n} OK em ${totalMs}ms — veredito: ${veredito}`);
    res.json({
      success: true,
      modo: 'imediato',
      veredito,
      ok, n, totalMs,
      rttMedio, rttMin, rttMax,
      resultados,
    });
  });

  /**
   * GET /api/sniper/timing-analise?ultimas=20&compraId=...
   * Análise de timing das últimas blitzes pra calibração:
   *   - Desvio inicial (timer dispatch vs alvoMs) — quanto o setTimeout atrasou
   *   - RTT médio/máx por lance — latência rede + servidor Comprasnet
   *   - Delta vs encerramento — quão perto do fim a rajada chegou
   * Retorna também sugestões de ajuste (oneWay, bufferSpike, intervaloRR).
   */
  app.get('/api/sniper/timing-analise', (req, res) => {
    try {
      const ultimas = Math.max(1, Math.min(200, Number(req.query.ultimas) || 20));
      const where = [];
      const params = [];
      if (req.query.compraId) { where.push('compraId = ?'); params.push(String(req.query.compraId)); }
      if (req.query.itemNumero) { where.push('itemNumero = ?'); params.push(Number(req.query.itemNumero)); }
      const sql = `
        SELECT id, blitzKey, compraId, itemNumero, tag,
               alvoMs, dispatchMs, desvioInicialMs,
               fimContagemNoT0, numLances, sucessos, falhas,
               rttMedioMs, rttMaxMs, rttMinMs,
               ultimoChegadaMs, deltaVsEncerramentoMs,
               numItensCoalescidos, criadoEm
          FROM blitz_telemetria
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY criadoEm DESC
         LIMIT ?
      `;
      const rows = db.prepare(sql).all(...params, ultimas);

      // Agregados
      const validos = rows.filter(r => r.desvioInicialMs != null);
      const desvios = validos.map(r => r.desvioInicialMs);
      const rttMedios = rows.filter(r => r.rttMedioMs != null).map(r => r.rttMedioMs);
      const rttMaxs = rows.filter(r => r.rttMaxMs != null).map(r => r.rttMaxMs);
      const deltas = rows.filter(r => r.deltaVsEncerramentoMs != null).map(r => r.deltaVsEncerramentoMs);
      const avg = (a) => a.length ? Math.round(a.reduce((s,v)=>s+v,0)/a.length) : null;
      const p95 = (a) => {
        if (!a.length) return null;
        const sorted = [...a].sort((x,y)=>x-y);
        return sorted[Math.min(sorted.length-1, Math.floor(sorted.length*0.95))];
      };
      const agregados = {
        amostras: rows.length,
        desvioInicialMedioMs: avg(desvios),
        desvioInicialP95Ms: p95(desvios),
        rttMedioMs: avg(rttMedios),
        rttP95Ms: p95(rttMaxs),
        deltaVsEncMedioMs: avg(deltas),
        deltaVsEncP95Ms: p95(deltas),
        deltasAtrasados: deltas.filter(d => d > 0).length,
        deltasTotal: deltas.length,
        sucessosTotal: rows.reduce((s,r)=>s+(r.sucessos||0),0),
        falhasTotal: rows.reduce((s,r)=>s+(r.falhas||0),0),
        lancesTotal: rows.reduce((s,r)=>s+(r.numLances||0),0),
      };

      // Sugestões automáticas (regras simples)
      const sugestoes = [];
      if (agregados.desvioInicialMedioMs != null && Math.abs(agregados.desvioInicialMedioMs) > 30) {
        sugestoes.push({
          tipo: 'desvio_inicial',
          mensagem: `Timer dispara em média ${agregados.desvioInicialMedioMs > 0 ? '+' : ''}${agregados.desvioInicialMedioMs}ms vs alvo. Considere ${agregados.desvioInicialMedioMs > 0 ? 'compensar atraso no auto-cálculo' : 'reduzir o adiantamento'}.`,
        });
      }
      if (agregados.rttMedioMs != null && agregados.rttMedioMs > 200) {
        sugestoes.push({
          tipo: 'rtt_alto',
          mensagem: `RTT médio = ${agregados.rttMedioMs}ms. Backend está com latência alta — verifique conexão com Comprasnet ou pool TCP.`,
        });
      }
      if (agregados.deltaVsEncMedioMs != null && agregados.deltaVsEncMedioMs > 0) {
        sugestoes.push({
          tipo: 'atrasou',
          mensagem: `Último lance está chegando em média ${agregados.deltaVsEncMedioMs}ms DEPOIS do encerramento. Diminua \`milesimoAlvo\` (atual default 970) por ${Math.ceil(agregados.deltaVsEncMedioMs / 10) * 10}ms.`,
        });
      }
      if (agregados.deltaVsEncMedioMs != null && agregados.deltaVsEncMedioMs < -200) {
        sugestoes.push({
          tipo: 'muito_cedo',
          mensagem: `Último lance está chegando ${Math.abs(agregados.deltaVsEncMedioMs)}ms ANTES do encerramento. Você está deixando margem de segurança grande — pode aumentar \`milesimoAlvo\` se quiser mais lances.`,
        });
      }
      if (agregados.deltaVsEncP95Ms != null && agregados.deltaVsEncP95Ms > 50 && agregados.deltaVsEncMedioMs != null && agregados.deltaVsEncMedioMs < 0) {
        sugestoes.push({
          tipo: 'jitter',
          mensagem: `Variação alta no delta (p95 = +${agregados.deltaVsEncP95Ms}ms, média ${agregados.deltaVsEncMedioMs}ms). Aumente \`bufferSpike\` (atual 30ms) pra cobrir picos.`,
        });
      }

      res.json({ success: true, agregados, sugestoes, amostras: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/fila-lances
   * Retorna lances pendentes (para extensão processar).
   */
  app.get('/api/sniper/fila-lances', (req, res) => {
    // Limpar lances travados em 'processando' há mais de 30s (extensão não respondeu)
    const agora = Date.now();
    for (let i = sniper.filaLances.length - 1; i >= 0; i--) {
      const l = sniper.filaLances[i];
      if (l.status === 'processando' && l.processandoDesde) {
        const timeout = (l.fonte === 'auto-continuo' || l.fonte === 'guard') ? 10000 : 60000;
        if (agora - l.processandoDesde > timeout) {
          sniper.filaLances.splice(i, 1);
        }
      }
    }

    // Só entregar lances cujo fireAt já chegou (ou sem fireAt)
    const pendentes = sniper.filaLances.filter(l => l.status === 'pendente' && (!l.fireAt || l.fireAt <= agora));
    // Marcar como "processando" com timestamp
    pendentes.forEach(l => { l.status = 'processando'; l.processandoDesde = agora; });

    // A4: Determine poll interval — fast when contínuo/guard/blitz has pending lances or blitz imminent
    let pollIntervalMs = 5000; // default
    const temFastPendente = sniper.filaLances.some(l =>
      (l.fonte === 'auto-continuo' || l.fonte === 'guard' || l.fonte === 'blitz' || l.fonte === 'agendado') &&
      (l.status === 'pendente' || l.status === 'processando')
    );
    // Blitz iminente (< 10s): extensão deve estar pronta para pegar lances instantaneamente
    let blitzIminente = false;
    for (const bk in blitzAgendadas) {
      const b = blitzAgendadas[bk];
      if (b.horario) {
        const agr = new Date();
        const [hh2, mm2, ss2] = b.horario.split(':').map(Number);
        const alvo2 = new Date(agr.getFullYear(), agr.getMonth(), agr.getDate(), hh2, mm2, ss2 || 0);
        if (alvo2.getTime() - agr.getTime() < 30000 && alvo2.getTime() - agr.getTime() > -5000) {
          blitzIminente = true;
          break;
        }
      }
    }
    // Lance agendado iminente (< 30s)
    let lanceAgendadoIminente = false;
    for (const lk in lancesAgendados) {
      const la = lancesAgendados[lk];
      if (la.horario) {
        const agr2 = new Date();
        const parts2 = la.horario.split(':');
        const hh3 = parseInt(parts2[0]) || 0, mm3 = parseInt(parts2[1]) || 0;
        const secP2 = (parts2[2] || '0').split('.'); const ss3 = parseInt(secP2[0]) || 0;
        const alvo3 = new Date(agr2.getFullYear(), agr2.getMonth(), agr2.getDate(), hh3, mm3, ss3);
        if (alvo3.getTime() - agr2.getTime() < 30000 && alvo3.getTime() - agr2.getTime() > -5000) {
          lanceAgendadoIminente = true;
          break;
        }
      }
    }
    if (temFastPendente || blitzIminente || lanceAgendadoIminente || pendentes.some(l => l.fonte === 'auto-continuo' || l.fonte === 'guard' || l.fonte === 'blitz' || l.fonte === 'agendado')) {
      pollIntervalMs = 200; // tight loop
    } else {
      for (const d of disputasCache.disputas) {
        if (!d.itens) continue;
        for (const item of d.itens) {
          if (item.fimContagem) {
            const seg = Math.floor((parseBrasilia(item.fimContagem).getTime() - Date.now()) / 1000);
            if (seg > 0 && seg < 60) { pollIntervalMs = 1000; break; }
          }
        }
        if (pollIntervalMs === 1000) break;
      }
    }

    // Incluir info de blitz agendadas para extensão criar alarms precisos
    var proximaBlitz = null;
    for (var bk in blitzAgendadas) {
      var b = blitzAgendadas[bk];
      if (b.horario) {
        var agr = new Date();
        var [hh, mm, ss] = b.horario.split(':').map(Number);
        var alvo = new Date(agr.getFullYear(), agr.getMonth(), agr.getDate(), hh, mm, ss || 0);
        var diffMs = alvo.getTime() - agr.getTime();
        if (diffMs > 0 && (!proximaBlitz || diffMs < proximaBlitz.diffMs)) {
          proximaBlitz = { horario: b.horario, diffMs, timestamp: alvo.getTime() };
        }
      }
    }

    // Incluir info de lances agendados (similar a blitz)
    var proximoLanceAgendado = null;
    for (var lk in lancesAgendados) {
      var la = lancesAgendados[lk];
      if (la.horario) {
        var agr3 = new Date();
        var parts3 = la.horario.split(':');
        var hh4 = parseInt(parts3[0])||0, mm4 = parseInt(parts3[1])||0;
        var secP3 = (parts3[2]||'0').split('.'); var ss4 = parseInt(secP3[0])||0;
        var alvo4 = new Date(agr3.getFullYear(), agr3.getMonth(), agr3.getDate(), hh4, mm4, ss4);
        var diffMs4 = alvo4.getTime() - agr3.getTime();
        if (diffMs4 > 0 && (!proximoLanceAgendado || diffMs4 < proximoLanceAgendado.diffMs)) {
          proximoLanceAgendado = { horario: la.horario, diffMs: diffMs4, timestamp: alvo4.getTime() };
        }
      }
    }

    res.json({ success: true, lances: pendentes, total: sniper.filaLances.length, pollIntervalMs, proximaBlitz, proximoLanceAgendado });
  });

  /**
   * POST /api/sniper/log
   * Recebe logs da extensão (idle dialogs, erros, eventos).
   */
  app.post('/api/sniper/log', (req, res) => {
    const { tipo, msg, detalhes, source } = req.body;
    const entry = `[EXT:${tipo || 'info'}] ${msg || ''}`;
    sniper.log(entry);
    logAuto(entry);
    console.log(`[Extensão] ${entry}`, detalhes ? JSON.stringify(detalhes).substring(0, 200) : '');
    // Auditoria (2026-05-27): persistir eventos do Electron pra timeline em
    // tokens.html. Resto do payload (status, error, action, etc) vai em JSON.
    if (source === 'electron' && tipo) {
      try {
        const det = { ...req.body };
        delete det.tipo; delete det.msg; delete det.source; delete det.timestamp;
        db.prepare(`INSERT INTO electron_eventos (recebidoEm, tipo, msg, detalhes, source)
                    VALUES (?, ?, ?, ?, ?)`).run(
          new Date().toISOString(),
          String(tipo).substring(0, 80),
          msg ? String(msg).substring(0, 500) : null,
          Object.keys(det).length ? JSON.stringify(det).substring(0, 1000) : null,
          'electron',
        );
        // Purge: manter só últimos 7 dias
        db.prepare(`DELETE FROM electron_eventos WHERE recebidoEm < datetime('now', '-7 days')`).run();
      } catch (_) { /* não bloquear resposta */ }
    }
    res.json({ success: true });
  });

  /**
   * GET /api/sniper/electron/eventos-historico?limite=100&janelaMin=60
   * Timeline de eventos do Electron (retoken, idle-dialog, reload-keepalive,
   * sso-morto, etc). Usado pra responder "por que o SSO morreu?".
   */
  app.get('/api/sniper/electron/eventos-historico', (req, res) => {
    try {
      const limite = Math.max(1, Math.min(500, parseInt(req.query.limite) || 100));
      const janelaMin = Math.max(1, Math.min(10080, parseInt(req.query.janelaMin) || 1440)); // default 24h
      const rows = db.prepare(`
        SELECT id, recebidoEm, tipo, msg, detalhes
          FROM electron_eventos
         WHERE recebidoEm > datetime('now', ?)
         ORDER BY recebidoEm DESC
         LIMIT ?
      `).all(`-${janelaMin} minutes`, limite);
      // Stats agregados por tipo
      const porTipo = {};
      for (const r of rows) {
        porTipo[r.tipo] = (porTipo[r.tipo] || 0) + 1;
      }
      res.json({ success: true, total: rows.length, porTipo, eventos: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/comprasnet-uso-bearer?janelaMin=10
   * Agrega comprasnet_health pra distinguir "bearer aceito em /api/auth/token"
   * de "bearer rejeitado em uso real" (ex: AutoLance.GUARD recebendo 401 em
   * loop mesmo com token aceito pelo servidor).
   */
  app.get('/api/sniper/comprasnet-uso-bearer', (req, res) => {
    try {
      const janelaMin = Math.max(1, Math.min(1440, parseInt(req.query.janelaMin) || 10));
      const rows = db.prepare(`
        SELECT httpStatus, COUNT(*) as qtd, MAX(ts) as ultimoTs
          FROM comprasnet_health
         WHERE ts > datetime('now', ?)
         GROUP BY httpStatus
         ORDER BY qtd DESC
      `).all(`-${janelaMin} minutes`);
      const total = rows.reduce((s, r) => s + r.qtd, 0);
      const ok = rows.filter(r => r.httpStatus >= 200 && r.httpStatus < 300).reduce((s, r) => s + r.qtd, 0);
      const _401 = rows.find(r => r.httpStatus === 401)?.qtd || 0;
      const _403 = rows.find(r => r.httpStatus === 403)?.qtd || 0;
      const _429 = rows.find(r => r.httpStatus === 429)?.qtd || 0;
      const _5xx = rows.filter(r => r.httpStatus >= 500).reduce((s, r) => s + r.qtd, 0);
      // Sinal de problema: > 20% das chamadas com 401/403 indica bearer rejeitado
      // em uso real (mesmo que /api/auth/token tenha aceitado).
      const taxaRejeicao = total > 0 ? Math.round(((_401 + _403) / total) * 100) : 0;
      res.json({
        success: true,
        janelaMin,
        total,
        ok,
        _401, _403, _429, _5xx,
        taxaRejeicao,
        porStatus: rows,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * SNIPER-C05: helper compartilhado para processar um resultado de lance.
   * Extraído de /resultado-lance (single) e /resultado-lances-batch (loop) para
   * eliminar ~200 linhas de duplicação. Retorna { sucesso, isContinuo, fonteOriginal }
   * para orquestração pelo caller (trigger reativo do ciclo auto-lance).
   */
  function processarResultadoLance(r) {
    const { id, compraId, itemNumero, valor, status, sucesso, resposta, tempoMs, enviadoMs, recebidoMs } = r;

    // 1. Atualizar na fila + recuperar fonte original
    const idx = sniper.filaLances.findIndex(l => l.id === id);
    let fonteOriginal = 'browser';
    if (idx >= 0) {
      fonteOriginal = sniper.filaLances[idx].fonte || 'browser';
      sniper.filaLances[idx].status = sucesso ? 'sucesso' : 'falha';
      sniper.filaLances[idx].httpStatus = status;
      sniper.filaLances[idx].resposta = resposta;
      sniper.filaLances[idx].tempoMs = tempoMs;
      sniper.filaLances[idx].processadoEm = new Date().toISOString();
    }

    // 2. Histórico recente (in-memory)
    sniper.resultadosLances.unshift({
      id, compraId, itemNumero, valor, status, sucesso, resposta, tempoMs,
      timestamp: new Date().toISOString(),
      fonte: fonteOriginal,
    });
    if (sniper.resultadosLances.length > 50) sniper.resultadosLances.pop();

    // 3. Log
    const fonteTag = fonteOriginal !== 'browser' ? ' [' + fonteOriginal.toUpperCase() + ']' : ' (browser)';
    const envIso = enviadoMs ? new Date(enviadoMs).toISOString().substring(11, 23) : '?';
    const recIso = recebidoMs ? new Date(recebidoMs).toISOString().substring(11, 23) : '?';
    const hasTiming = enviadoMs || recebidoMs;
    if (sucesso) {
      sniper.log(hasTiming
        ? `🎯✅ LANCE${fonteTag}! R$ ${parseFloat(valor).toFixed(2)} item ${itemNumero} HTTP ${status} (${tempoMs}ms) env=${envIso} rec=${recIso}`
        : `🎯✅ LANCE ENVIADO${fonteTag}! R$ ${parseFloat(valor).toFixed(2)} item ${itemNumero} (${tempoMs}ms)`);
    } else {
      sniper.log(hasTiming
        ? `🎯❌ Lance falhou${fonteTag}: HTTP ${status} item ${itemNumero} (${tempoMs}ms) env=${envIso} rec=${recIso}`
        : `🎯❌ Lance falhou${fonteTag}: HTTP ${status} item ${itemNumero} (${tempoMs}ms) — ${String(resposta || '').substring(0, 100)}`);
    }

    // 4. Sniper historico in-memory
    sniper.historico.unshift({ compraId, itemNumero, valor, status, sucesso, tempoMs, timestamp: new Date().toISOString(), fonte: fonteOriginal });
    if (sniper.historico.length > 50) sniper.historico.pop();

    // 5. Persist
    try {
      const respostaStr = typeof resposta === 'string' ? resposta.substring(0, 1500) : (resposta ? JSON.stringify(resposta).substring(0, 1500) : '');
      if (hasTiming) {
        db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp, enviadoEm, recebidoEm)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            compraId, itemNumero, valor, status, sucesso ? 1 : 0, tempoMs || 0, respostaStr, fonteOriginal, new Date().toISOString(),
            enviadoMs ? new Date(enviadoMs).toISOString() : null,
            recebidoMs ? new Date(recebidoMs).toISOString() : null);
      } else {
        db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(compraId, itemNumero, valor, status, sucesso ? 1 : 0, tempoMs || 0, respostaStr, fonteOriginal, new Date().toISOString());
      }
      db.prepare(`UPDATE sniper_itens SET status = ?, ultimoResultado = ?, ultimoEnvio = CURRENT_TIMESTAMP, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE compraId = ? AND itemNumero = ?`).run(sucesso ? 'enviado' : 'erro', `HTTP ${status} (${tempoMs}ms)`, compraId, itemNumero);
    } catch (dbErr) { console.error('[Sniper] Erro salvando no banco:', dbErr.message); }

    // 6. disputasCache update
    if (compraId && itemNumero != null) {
      const cachedD = disputasCache.disputas.find(d => d.compraId === compraId);
      if (cachedD && cachedD.itens) {
        if (sucesso) {
          let cachedItem = cachedD.itens.find(i => i.numero === parseInt(itemNumero));
          if (cachedItem) {
            cachedItem.nossoValor = parseFloat(valor);
          } else {
            const grupoItem = cachedD.itens.find(i => i.numero === -1 || i.tipo === 'G');
            if (grupoItem) {
              cachedD.itens.push({
                numero: parseInt(itemNumero), tipo: 'S', melhorValor: null,
                nossoValor: parseFloat(valor), variacaoMinima: grupoItem.variacaoMinima,
                tipoVariacao: grupoItem.tipoVariacao, fimContagem: grupoItem.fimContagem,
                podeEnviar: grupoItem.podeEnviar, fase: grupoItem.fase,
                estaPerdendo: false, emEncAleatoria: grupoItem.emEncAleatoria || false,
                nosDoisMinFinais: grupoItem.nosDoisMinFinais || false,
              });
              console.log(`[Sniper] Cache: added sub-item ${itemNumero} to grupo ${compraId} nosso=R$${valor}`);
            }
          }
        } else if (status === 422 && resposta && String(resposta).includes('melhor que seu')) {
          const tentado = parseFloat(valor);
          let cachedItem = cachedD.itens.find(i => i.numero === parseInt(itemNumero));
          if (cachedItem) {
            if (cachedItem.nossoValor == null || tentado < cachedItem.nossoValor) {
              console.log(`[Sniper] Cache: 422 "melhor que seu" — ajustando nossoValor item ${itemNumero} de R$${cachedItem.nossoValor} para R$${tentado}`);
              cachedItem.nossoValor = tentado;
            }
          } else {
            const grupoItem = cachedD.itens.find(i => i.numero === -1 || i.tipo === 'G');
            if (grupoItem) {
              cachedD.itens.push({
                numero: parseInt(itemNumero), tipo: 'S', melhorValor: null,
                nossoValor: tentado, variacaoMinima: grupoItem.variacaoMinima,
                tipoVariacao: grupoItem.tipoVariacao, fimContagem: grupoItem.fimContagem,
                podeEnviar: grupoItem.podeEnviar, fase: grupoItem.fase,
                estaPerdendo: false, emEncAleatoria: grupoItem.emEncAleatoria || false,
                nosDoisMinFinais: grupoItem.nosDoisMinFinais || false,
              });
              console.log(`[Sniper] Cache: 422 — criado sub-item ${itemNumero} com nosso=R$${tentado}`);
            }
          }
        }

        // Propagar estaPerdendo reativamente após lance bem-sucedido
        if (sucesso) {
          const grupoItem = cachedD.itens.find(i => i.numero === -1 || i.tipo === 'G');
          if (grupoItem && grupoItem.melhorValor != null && grupoItem.nossoValor != null) {
            const ganhando = grupoItem.nossoValor <= grupoItem.melhorValor;
            cachedD.itens.forEach(i => { i.estaPerdendo = !ganhando; });
          }
        }
      }

      // GUARD MODE: após lance contínuo/guard aceito, ativar guard
      if (sucesso) {
        const cfgGuard = db.prepare(
          'SELECT modoAuto, valorMinimo FROM sniper_itens WHERE compraId = ? AND itemNumero = ?'
        ).get(compraId, parseInt(itemNumero));
        if (cfgGuard && cfgGuard.modoAuto === 'continuo' && cfgGuard.valorMinimo != null) {
          iniciarGuard(compraId, parseInt(itemNumero));
        }
      }
    }

    // 7. Cooldown/fila cleanup
    const pendingKey = `${compraId}-${itemNumero}`;
    const lanceObj = idx >= 0 ? sniper.filaLances[idx] : null;
    const isBatchFonte = lanceObj && (lanceObj.fonte === 'blitz' || lanceObj.fonte === 'auto-continuo' || lanceObj.fonte === 'guard');
    if (sucesso) {
      if (isBatchFonte) delete sniper.autoLancePendentes[pendingKey];
      else sniper.autoLancePendentes[pendingKey] = Date.now();
    } else {
      delete sniper.autoLancePendentes[pendingKey];
    }

    const isContinuo = lanceObj && (lanceObj.fonte === 'auto-continuo' || lanceObj.fonte === 'guard');
    if (isContinuo) {
      const i2 = sniper.filaLances.findIndex(l => l.id === id);
      if (i2 >= 0) sniper.filaLances.splice(i2, 1);
    } else {
      setTimeout(() => {
        const i = sniper.filaLances.findIndex(l => l.id === id);
        if (i >= 0) sniper.filaLances.splice(i, 1);
      }, isBatchFonte ? 5000 : 30000);
    }

    return { sucesso, isContinuo, fonteOriginal };
  }

  /**
   * POST /api/sniper/resultado-lance
   * Recebe resultado do lance enviado pela extensão.
   */
  app.post('/api/sniper/resultado-lance', (req, res) => {
    try {
      const r = req.body || {};
      const { sucesso, isContinuo } = processarResultadoLance(r);

      console.log(`[Sniper] Lance resultado: ${sucesso ? '✅' : '❌'} ${r.compraId} item ${r.itemNumero} R$${r.valor} HTTP ${r.status} (${r.tempoMs}ms)`);

      // A6: trigger reativo
      if (sniper.autoLanceAtivo) {
        if (sucesso) {
          setImmediate(() => executarCicloAutoLance(true));
        } else if (isContinuo) {
          setTimeout(() => executarCicloAutoLance(true), 3000);
        }
      }

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== A8: BATCH RESULT ENDPOINT ====================

  /**
   * POST /api/sniper/resultado-lances-batch
   * Recebe array de resultados de lances de uma vez (extensão envia batch).
   */
  app.post('/api/sniper/resultado-lances-batch', (req, res) => {
    try {
      const { resultados } = req.body;
      if (!Array.isArray(resultados) || resultados.length === 0) {
        return res.status(400).json({ success: false, error: 'resultados deve ser array não-vazio' });
      }

      let sucessos = 0, falhas = 0;

      // SNIPER-C05: delega processamento individual para helper compartilhado
      for (const r of resultados) {
        try {
          const out = processarResultadoLance(r);
          if (out.sucesso) sucessos++; else falhas++;
        } catch (rowErr) {
          falhas++;
          console.warn(`[Sniper] Erro processando resultado lance ${r && r.id}: ${rowErr.message}`);
        }
      }

      console.log(`[Sniper] Batch resultado: ${sucessos} ✅ ${falhas} ❌ (${resultados.length} total)`);

      // Reactive trigger after batch
      if (sniper.autoLanceAtivo) {
        if (sucessos > 0) {
          setImmediate(() => executarCicloAutoLance(true));
        } else if (falhas > 0) {
          setTimeout(() => executarCicloAutoLance(true), 3000);
        }
      }

      res.json({ success: true, sucessos, falhas, total: resultados.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== AUTO-LANCE ROUTES ====================

  /**
   * GET /api/sniper/mercado?compraId=...&itemNumero=...
   * Histórico do estado do mercado — cada mudança em melhorGeral/nossoValor/situação.
   * Permite reconstruir a timeline de lances nossos vs concorrentes.
   */
  app.get('/api/sniper/mercado', (req, res) => {
    try {
      const { compraId, itemNumero } = req.query;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });

      let query = `SELECT * FROM sniper_classificacao WHERE compraId = ?`;
      const params = [compraId];
      if (itemNumero) {
        query += ` AND itemNumero = ?`;
        params.push(parseInt(itemNumero));
      }
      query += ` ORDER BY timestamp, id LIMIT 1000`;

      const rows = db.prepare(query).all(...params);
      res.json({ success: true, total: rows.length, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/auto/status
   * Estado do auto-lance engine + log.
   */
  app.get('/api/sniper/auto/status', (req, res) => {
    try {
      const autoItens = db.prepare(
        `SELECT compraId, itemNumero, modoAuto, valorMinimo FROM sniper_itens WHERE modoAuto IS NOT NULL AND modoAuto != ''`
      ).all();
      res.json({
        success: true,
        ativo: sniper.autoLanceAtivo,
        itensMonitorados: autoItens.length,
        itens: autoItens,
        stats: sniper.autoLanceStats,
        comprasFastPoll: Object.keys(sniper.autoLanceComprasFast),
        pendentes: Object.keys(sniper.autoLancePendentes).length,
        blitzDisparados: Object.keys(sniper.blitzDisparados),
        ultraTimerAtivo: !!sniper.autoLanceTimerUltra,
        guardLoops: Object.keys(sniper.guardLoops).map(cid => ({
          compraId: cid,
          itens: [...sniper.guardLoops[cid].itens],
          intervalMs: sniper.guardLoops[cid].intervalMs,
          iniciadoEm: sniper.guardLoops[cid].iniciadoEm,
        })),
        guardStats: sniper.guardStats,
        log: sniper.autoLanceLog.slice(0, 200),
        filaLances: sniper.filaLances.length,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/auto/toggle
   * Ligar/desligar engine manualmente.
   */
  app.post('/api/sniper/auto/toggle', (req, res) => {
    try {
      if (sniper.autoLanceAtivo) {
        pararAutoLance();
      } else {
        iniciarAutoLance();
      }
      res.json({ success: true, ativo: sniper.autoLanceAtivo });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/auto-compras
   * Retorna lista de compraIds com auto-lance ativo.
   * Usado pela extensão para decidir quais compras precisam de filtros extras.
   */
  app.get('/api/sniper/auto-compras', (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT DISTINCT compraId FROM sniper_itens WHERE modoAuto IS NOT NULL AND modoAuto != ''`
      ).all();
      res.json({ success: true, compraIds: rows.map(r => r.compraId) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/log-filtro
   * Recebe log de filtro da extensão para visibilidade centralizada.
   */
  app.post('/api/sniper/log-filtro', (req, res) => {
    try {
      const { compraId, filtro, nome, qtde, itens } = req.body;
      logAuto(`[EXT] FILTRO=${filtro} (${nome}) ${compraId}: ${qtde} itens — ${JSON.stringify(itens)}`);
      res.json({ success: true });
    } catch (e) {
      res.json({ success: true }); // não falhar para não atrapalhar extensão
    }
  });

  /**
   * Plano 16: toggle global do MOTOR DE LANCES.
   * Quando desligado, sniper.enviarLance() retorna { bloqueado: true } e
   * nenhum lance vai para o Comprasnet — válido para manual, agendado,
   * rajada individual e Rajada Global. Dados do mercado continuam
   * atualizando via Guard (que agora é sempre ligado).
   */
  app.get('/api/sniper/motor-config', (req, res) => {
    try {
      const row = db.prepare("SELECT valor FROM config WHERE chave='sniper_motor_enabled'").get();
      const enabled = row ? (row.valor !== '0' ? 1 : 0) : 1;
      res.json({ success: true, enabled });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/sniper/motor-config', (req, res) => {
    try {
      const en = req.body && (req.body.enabled === 1 || req.body.enabled === '1' || req.body.enabled === true) ? '1' : '0';
      db.prepare(`INSERT INTO config (chave, valor) VALUES ('sniper_motor_enabled', ?)
        ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(en);
      if (sniper && typeof sniper.invalidarMotorCache === 'function') sniper.invalidarMotorCache();
      logAuto(`MOTOR DE LANCES ${en === '1' ? 'LIGADO' : 'DESLIGADO'} — ${en === '1' ? 'lances podem ser enviados' : 'lances bloqueados no gate'}`);
      res.json({ success: true, enabled: Number(en) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * GET /api/sniper/fila-status
   * Status completo da fila de lances.
   */
  app.get('/api/sniper/fila-status', (req, res) => {
    const sniperStatus = sniper.getStatus();
    const extensaoConectada = !!(ultimoSyncExtensao && (Date.now() - ultimoSyncExtensao) < 5 * 60 * 1000);
    res.json({
      success: true,
      fila: sniper.filaLances,
      resultados: sniper.resultadosLances.slice(0, 20),
      totalResultados: sniper.resultadosLances.length,
      extensaoConectada,
      temBearer: sniperStatus.temToken,
      bearerIdade: sniperStatus.tokenIdadeSegundos,
      tokenExpirado: sniperStatus.tokenExpirado,
      disputasCache: {
        total: disputasCache.disputas.length,
        atualizadoEm: disputasCache.atualizadoEm,
        idadeSegundos: disputasCache.atualizadoEm ? Math.floor((Date.now() - new Date(disputasCache.atualizadoEm).getTime()) / 1000) : null,
      },
      stats: {
        pendentes: sniper.filaLances.filter(l => l.status === 'pendente').length,
        processando: sniper.filaLances.filter(l => l.status === 'processando').length,
        sucesso: sniper.filaLances.filter(l => l.status === 'sucesso').length,
        falha: sniper.filaLances.filter(l => l.status === 'falha').length,
      },
    });
  });

  // ==================== AGENDAMENTO ====================

  app.post('/api/sniper/agendar', (req, res) => {
    try {
      const { compraId, itemNumero, valor, faseItem, horarioAlvo, antecedenciaMs, tentativas, intervaloTentativasMs } = req.body;
      if (!compraId || !itemNumero || !valor || !horarioAlvo) {
        return res.status(400).json({ success: false, error: 'compraId, itemNumero, valor e horarioAlvo obrigatórios' });
      }

      if (!sniper.temToken()) {
        return res.status(400).json({
          success: false,
          error: 'Sem Bearer token. Abra o Comprasnet pelo Electron LiciteAgora.',
        });
      }

      const id = `sniper-${compraId}-${itemNumero}-${Date.now()}`;
      const resultado = sniper.agendar({
        id,
        compraId,
        itemNumero,
        valor,
        faseItem: faseItem || 'LA',
        horarioAlvo,
        antecedenciaMs: antecedenciaMs || 300,
        tentativas: tentativas || 5,
        intervaloTentativasMs: intervaloTentativasMs || 50,
      });

      res.json(resultado);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // FASE 2b: agendar RAJADA DE GRUPO — no horário, desce CADA item do grupo ao seu
  // piso individual (sniper_itens.valorMinimo). 1 lance agendado por item (sniper.agendar).
  // É o que dá pra ganhar num grupo por lance-por-item, no último segundo, respeitando
  // o mínimo que o usuário setou em cada item.
  app.post('/api/sniper/agendar-grupo', (req, res) => {
    try {
      const { compraId, horario, antecedenciaMs, tentativas } = req.body;
      if (!compraId || !horario) return res.status(400).json({ success: false, error: 'compraId e horario obrigatórios' });
      if (!sniper.temToken()) return res.status(400).json({ success: false, error: 'Sem Bearer token. Abra o Comprasnet pelo Electron.' });

      // horarioAlvo ISO: aceita "HH:MM:SS(.mmm)" (monta com a data de hoje, TZ do servidor = Brasília)
      // ou uma string já parseável por new Date().
      let horarioAlvo = horario;
      if (/^\d{2}:\d{2}:\d{2}/.test(horario) && !String(horario).includes('T')) {
        const h = new Date();
        const y = h.getFullYear(), mo = String(h.getMonth() + 1).padStart(2, '0'), da = String(h.getDate()).padStart(2, '0');
        horarioAlvo = `${y}-${mo}-${da}T${horario}-03:00`;
      }

      // Itens do grupo COM piso definido (o piso É o alvo do lance)
      const itens = db.prepare(`SELECT itemNumero, valorMinimo FROM sniper_itens WHERE compraId = ? AND itemNumero > 0 AND valorMinimo IS NOT NULL`).all(compraId);
      if (!itens.length) return res.json({ success: false, error: 'Nenhum item do grupo com Valor Mínimo (piso) definido' });

      const agendados = [];
      for (const it of itens) {
        const id = `grupo-${compraId}-${it.itemNumero}-${Date.now()}`;
        const r = sniper.agendar({
          id, compraId, itemNumero: it.itemNumero, valor: it.valorMinimo, faseItem: 'LA',
          horarioAlvo, antecedenciaMs: antecedenciaMs || 300, tentativas: tentativas || 6, intervaloTentativasMs: 50,
        });
        agendados.push({ itemNumero: it.itemNumero, valor: it.valorMinimo, ok: r && r.success !== false, erro: r && r.error });
      }
      logAuto(`🚀 RAJADA GRUPO agendada: ${compraId} — ${agendados.filter(a => a.ok).length}/${agendados.length} item(ns) → piso @ ${horarioAlvo}`);
      res.json({ success: true, compraId, horarioAlvo, agendados });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sniper/cancelar/:id', (req, res) => {
    try {
      const ok = sniper.cancelar(req.params.id);
      res.json({ success: true, cancelado: ok });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sniper/cancelar-todos', (req, res) => {
    try {
      let cancelados = 0;
      for (const [id, ag] of sniper.agendamentos) {
        if (!ag.executado) {
          sniper.cancelar(id);
          cancelados++;
        }
      }
      res.json({ success: true, cancelados });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sniper/agendamentos', (req, res) => {
    try {
      res.json({ success: true, agendamentos: sniper.listarAgendamentos() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== CONSULTA DE DISPUTA ====================

  app.get('/api/sniper/participacoes', (req, res) => {
    try {
      const busca = req.query.busca || '';
      const emDisputa = req.query.emDisputa === 'true';
      let query = 'SELECT compraId, cnpj, ano, sequencial, orgao, objeto, etapa, situacao, faseCompra, dataSessao, dataAtualizacao, modoDisputa, dataHoraFimDisputa, linkPncp, exclusivaMeEpp, criterioJulgamento FROM participacoes_comprasnet WHERE ativo = 1';
      const params = [];

      if (emDisputa) {
        // Filtrar apenas participações em fase de disputa (faseCompra = '3')
        query += " AND faseCompra = '3' AND situacao NOT IN ('FR', 'EN', 'SU')";
      }

      if (busca) {
        query += ' AND (objeto LIKE ? OR orgao LIKE ? OR compraId LIKE ?)';
        const like = `%${busca}%`;
        params.push(like, like, like);
      }
      query += ' ORDER BY dataAtualizacao DESC';
      const lista = db.prepare(query).all(...params);
      res.json({ success: true, participacoes: lista, total: lista.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/refresh-participacoes
   * Atualiza participações consultando a API Comprasnet diretamente do servidor.
   * Usa GET /compras/{compraId}/participacao (funciona sem captcha) para cada compra ativa.
   * Também verifica compraIds de interesses que ainda não estão em participacoes_comprasnet.
   */
  // ==================== REFRESH AUTOMÁTICO DE PARTICIPAÇÕES ====================

  async function executarRefreshParticipacoes() {
    if (!sniper.temToken() || sniper.tokenExpirado()) return null;

    const delay = ms => new Promise(r => setTimeout(r, ms));

    // 1. Coletar compraIds para verificar (prioridade: em disputa/ativas recentes).
    // A última OR clause (faseCompra='4' AND homologada=0 AND dataAtualizacao>now-30d)
    // garante que compras marcadas como encerradas continuem sendo re-checadas
    // por até 30 dias — protege contra falsos positivos do /qtdes e contra
    // remarcações/suspensões que reabrem a disputa. homologada=0 evita
    // ressuscitar compras de fato terminadas.
    const comprasDB = db.prepare(`
      SELECT compraId, cnpj, ano, sequencial, situacao, faseCompra
      FROM participacoes_comprasnet
      WHERE ativo = 1 AND situacao NOT IN ('FR', 'EX')
        AND (
          faseCompra IN ('1', '2', '3')
          OR situacao IN ('PD', 'AB', 'PE', '5', 'SU', '')
          OR dataAtualizacao > datetime('now', '-7 days')
          OR (faseCompra = '4' AND homologada = 0 AND dataAtualizacao > datetime('now', '-30 days'))
        )
      ORDER BY CASE WHEN faseCompra = '3' THEN 0 WHEN situacao IN ('PD', 'PE') THEN 1 ELSE 2 END,
               dataAtualizacao DESC
      LIMIT 80
    `).all();

    const interesseCompras = db.prepare(`
      SELECT ic.compraId, ic.cnpj, ic.ano, ic.sequencial
      FROM interesse_compra_id ic
      WHERE ic.compraId IS NOT NULL AND ic.compraId != ''
        AND ic.compraId NOT LIKE 'NAO_COMPRASNET:%'
        AND NOT EXISTS (SELECT 1 FROM participacoes_comprasnet p WHERE p.compraId = ic.compraId)
    `).all();

    const todosCompraIds = new Map();
    for (const c of comprasDB) todosCompraIds.set(c.compraId, c);
    for (const c of interesseCompras) if (!todosCompraIds.has(c.compraId)) todosCompraIds.set(c.compraId, c);

    if (todosCompraIds.size === 0) return { verificadas: 0 };

    let atualizadas = 0, inseridas = 0, erros = 0;

    const stmtSelect = db.prepare('SELECT id, situacao, faseCompra FROM participacoes_comprasnet WHERE compraId = ?');
    const stmtUpdate = db.prepare(`UPDATE participacoes_comprasnet SET
      situacao = ?, faseCompra = ?,
      objeto = COALESCE(?, objeto), orgao = COALESCE(?, orgao),
      ativo = 1, dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ?`);
    const stmtInsert = db.prepare(`INSERT INTO participacoes_comprasnet
      (compraId, cnpj, ano, sequencial, orgao, objeto, situacao, faseCompra, ativo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);

    for (const [compraId, info] of todosCompraIds) {
      try {
        const { status, data } = await sniper.apiGet(`/comprasnet-fase-externa/v1/compras/${compraId}/participacao`);
        const parsed = status === 200 ? extrairFaseFromParticipacao(data) : null;
        if (parsed) {
          const { situacao: sit, fase, objeto, orgao } = parsed;
          const existe = stmtSelect.get(compraId);
          if (existe) {
            if (existe.situacao !== sit || existe.faseCompra !== fase) {
              stmtUpdate.run(sit, fase, objeto || null, orgao || null, compraId);
              atualizadas++;
            }
          } else {
            stmtInsert.run(compraId, info.cnpj || '', info.ano || 0, info.sequencial || 0, orgao, objeto, sit, fase);
            inseridas++;
          }
        }
        await delay(100); // 100ms entre requests (era 300ms)
      } catch (e) { erros++; }
    }

    // Fase 2: Buscar itens de disputa para popular disputasCache
    const comprasEmDisputa = db.prepare(`
      SELECT compraId, orgao, objeto, dataSessao
      FROM participacoes_comprasnet
      WHERE ativo = 1 AND faseCompra = '3' AND situacao IN ('PD', 'AB', '5')
    `).all();

    let disputasAtualizadas = 0;
    for (const compra of comprasEmDisputa) {
      try {
        const result = await sniper.consultarItens(compra.compraId);
        if (result.success && result.itens?.length > 0) {
          const itens = result.itens.map(i => {
            const mv = i.melhorValorGeral || i.melhorLanceGeral;
            const nv = i.melhorValorFornecedor || i.melhorLanceFornecedor;
            const melhorValor = mv?.valorInformado ?? mv?.valor ?? i.valorMelhorLance ?? null;
            const nossoValor = nv?.valorInformado ?? nv?.valor ?? null;
            const fase = i.fase || i.faseItem || '';
            return {
              numero: i.numero ?? i.identificador, tipo: i.tipo || null,
              descricao: (i.descricao || i.objetoItem || '').substring(0, 120),
              fase, situacao: i.situacao || '', melhorValor, nossoValor,
              valorEstimado: i.valorEstimadoUnitario || i.valorEstimado || null,
              situacaoParticipante: i.situacaoParticipanteDisputa || null,
              variacaoMinima: i.variacaoMinimaEntreLances ?? null,
              podeEnviar: i.podeEnviarLances || false,
              fimContagem: i.dataHoraFimContagem || null,
              quantidadeSolicitada: i.quantidadeSolicitada || null,
              disputaPorValorUnitario: !!i.disputaPorValorUnitario,
              estaPerdendo: nossoValor != null && melhorValor != null ? nossoValor > melhorValor : false,
            };
          });
          const faseAtiva = f => ['LA', 'D1', 'D2'].includes((f || '').toUpperCase());
          const itensAtivos = itens.filter(i => faseAtiva(i.fase) || i.podeEnviar).length;
          const disputa = {
            compraId: compra.compraId, orgao: compra.orgao || '', objeto: compra.objeto || '',
            dataSessao: compra.dataSessao || '', totalItens: itens.length, itensAtivos, itens,
            _atualizadoEm: new Date().toISOString(), _fonte: 'servidor',
          };
          const idx = disputasCache.disputas.findIndex(d => d.compraId === compra.compraId);
          if (idx >= 0) {
            const existente = disputasCache.disputas[idx];
            const idadeExistente = existente._atualizadoEm ? Date.now() - new Date(existente._atualizadoEm).getTime() : Infinity;
            if (idadeExistente > 120000) { disputasCache.disputas[idx] = disputa; disputasAtualizadas++; }
          } else {
            disputasCache.disputas.push(disputa); disputasAtualizadas++;
          }
        }
        await delay(100);
      } catch (e) {}
    }

    if (disputasAtualizadas > 0) disputasCache.atualizadoEm = new Date().toISOString();

    const msg = `${todosCompraIds.size} compras, ${atualizadas} atualizadas, ${inseridas} novas, ${disputasAtualizadas} disputas`;
    if (atualizadas > 0 || inseridas > 0 || disputasAtualizadas > 0) console.log(`[REFRESH] ${msg}`);
    return { success: true, verificadas: todosCompraIds.size, atualizadas, inseridas, erros, disputasAtualizadas, message: msg };
  }

  // Auto-refresh: roda no startup (5s após token) e a cada 2 min
  let refreshInterval = null;
  function iniciarAutoRefresh() {
    if (refreshInterval) return;
    refreshInterval = setInterval(async () => {
      try { await executarRefreshParticipacoes(); } catch (e) {}
    }, 120000); // 2 min
    // Primeiro refresh imediato
    executarRefreshParticipacoes().catch(() => {});
    // Calibrar relógio com Comprasnet (e recalibrar a cada 10 min)
    sniper.calibrarTempo().then(r => console.log(`[CALIBRAÇÃO] offset=${r.offset}ms, latência=${r.latencia}ms`)).catch(() => {});
    setInterval(() => { sniper.calibrarTempo().catch(() => {}); }, 600000);
    console.log('[REFRESH] Auto-refresh ativado (a cada 2 min) + calibração de relógio');
  }

  // Phase B (2026-04-23): expõe referência para agendarSniperRefresh
  // iterar tenants e chamar periodicamente (a cada 2 min) dentro do
  // contexto de cada tenant.
  _refreshParticipacoesRef = executarRefreshParticipacoes;

  // Endpoint manual (botão Sync API)
  app.post('/api/sniper/refresh-participacoes', async (req, res) => {
    try {
      if (!sniper.temToken()) return res.status(400).json({ success: false, error: 'Sem Bearer token.' });
      if (sniper.tokenExpirado()) return res.status(400).json({ success: false, error: 'Bearer token expirado.' });
      const result = await executarRefreshParticipacoes();
      res.json(result || { success: false, error: 'Sem token' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sniper/consultar/:compraId', async (req, res) => {
    try {
      const result = await sniper.consultarItens(req.params.compraId);
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== DISPUTAS (dados da extensão) ====================

  /**
   * POST /api/sync/disputas
   * Recebe dados de disputas do Electron (consulta feita pelo webview Comprasnet).
   */
  app.post('/api/sync/disputas', (req, res) => {
    try {
      const { disputas, merge } = req.body;
      if (!Array.isArray(disputas)) {
        return res.status(400).json({ success: false, error: 'disputas deve ser array' });
      }

      ultimoSyncExtensao = Date.now();

      // Helper: preserve accumulated sub-items when sync only brings grupo (-1)
      function mergeDisputa(existing, incoming) {
        if (!existing || !existing.itens || !incoming.itens) return incoming;
        // Derivar estaPerdendo quando ausente (merge de resposta de lance não traz filtros)
        for (const item of incoming.itens) {
          if (item.estaPerdendo === undefined || item.estaPerdendo === null) {
            if (item.melhorValor != null && item.nossoValor != null) {
              item.estaPerdendo = item.nossoValor > item.melhorValor;
            } else {
              const existItem = existing.itens.find(e => e.numero === item.numero);
              if (existItem) item.estaPerdendo = existItem.estaPerdendo;
            }
          }
        }
        // Find sub-items in existing cache that are NOT in incoming data
        const incomingNums = new Set(incoming.itens.map(i => i.numero));
        const preservados = existing.itens.filter(i =>
          i.tipo === 'S' && !incomingNums.has(i.numero)
        );
        if (preservados.length > 0) {
          incoming.itens = incoming.itens.concat(preservados);
        }
        return incoming;
      }

      if (merge) {
        // Merge: add/update individual items without replacing full cache
        for (const d of disputas) {
          const idx = disputasCache.disputas.findIndex(c => c.compraId === d.compraId);
          if (idx >= 0) {
            disputasCache.disputas[idx] = mergeDisputa(disputasCache.disputas[idx], d);
          } else {
            disputasCache.disputas.push(d);
          }
        }
        disputasCache.atualizadoEm = new Date().toISOString();
      } else {
        // Full replace — but preserve sub-items for groups
        const oldMap = {};
        for (const d of disputasCache.disputas) {
          if (d.compraId) oldMap[d.compraId] = d;
        }
        for (let i = 0; i < disputas.length; i++) {
          const old = oldMap[disputas[i].compraId];
          if (old) disputas[i] = mergeDisputa(old, disputas[i]);
        }
        disputasCache = {
          disputas: disputas,
          atualizadoEm: new Date().toISOString(),
        };
      }
      const ativas = disputasCache.disputas.filter(d => d.itensAtivos > 0);
      console.log(`[Sync] Disputas: ${disputas.length} ${merge ? 'merged' : 'replaced'}, ${ativas.length} com itens ativos (total: ${disputasCache.disputas.length})`);
      res.json({ success: true, recebidas: disputas.length, ativas: ativas.length, total: disputasCache.disputas.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/disputas-ativas
   * Retorna disputas do cache (preenchido pela extensão).
   * Não faz mais chamadas API do servidor (captcha IP-bound ao browser).
   */
  app.get('/api/sniper/disputas-ativas', async (req, res) => {
    try {
      // Se tem cache recente (< 5 min), retorna direto
      if (disputasCache.atualizadoEm) {
        const idadeMs = Date.now() - new Date(disputasCache.atualizadoEm).getTime();
        const idadeMin = Math.round(idadeMs / 60000);
        res.json({
          success: true,
          disputas: disputasCache.disputas,
          atualizadoEm: disputasCache.atualizadoEm,
          idadeMinutos: idadeMin,
          fonte: 'extensao',
        });
      } else {
        // Sem cache — orienta o usuário
        res.json({
          success: true,
          disputas: [],
          atualizadoEm: null,
          fonte: 'sem-dados',
          mensagem: 'Aguardando sync do Electron. Verifique se o Electron LiciteAgora está aberto e logado no Comprasnet.',
        });
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/diagnostico?compraId=XXXX
   * Testa TODOS os endpoints possíveis e mostra o resultado bruto.
   * Para debug quando itens não são encontrados.
   */
  app.get('/api/sniper/diagnostico', async (req, res) => {
    try {
      const { compraId } = req.query;
      if (!compraId) return res.status(400).json({ error: 'compraId obrigatório' });

      const status = sniper.getStatus();
      const resultados = [];

      const endpoints = [
        { path: `/comprasnet-disputa/v1/compras/${compraId}/itens`, tipo: 'disputa-itens', needsCaptcha: false },
        { path: `/comprasnet-disputa/v1/compras/${compraId}/itens/classificacao`, tipo: 'disputa-classificacao', needsCaptcha: false },
        { path: `/comprasnet-fase-externa/v1/compras/${compraId}/itens`, tipo: 'fase-externa-itens', needsCaptcha: false },
        { path: `/comprasnet-fase-externa/v1/compras/${compraId}/itens/em-selecao-fornecedores`, tipo: 'fase-externa-selecao', needsCaptcha: false },
      ];

      // Com captcha
      if (status.temCaptcha) {
        endpoints.push(
          { path: `/comprasnet-fase-externa/v1/compras/${compraId}/itens/em-selecao-fornecedores`, tipo: 'fase-externa-selecao+captcha', needsCaptcha: true },
          { path: `/comprasnet-fase-externa/v1/compras/${compraId}/itens`, tipo: 'fase-externa-itens+captcha', needsCaptcha: true },
        );
      }

      for (const ep of endpoints) {
        try {
          const result = ep.needsCaptcha
            ? await sniper.apiGetCaptcha(ep.path)
            : await sniper.apiGet(ep.path);

          const data = result.data;
          const isArray = Array.isArray(data);
          const itens = isArray ? data : (data ? [data] : []);

          resultados.push({
            tipo: ep.tipo,
            status: result.status,
            isArray,
            totalItens: itens.length,
            primeiroItem: itens[0] ? {
              numero: itens[0].numero,
              identificador: itens[0].identificador,
              fase: itens[0].fase || itens[0].faseItem,
              situacao: itens[0].situacao,
              podeEnviarLances: itens[0].podeEnviarLances,
              descricao: (itens[0].descricao || itens[0].objetoItem || '').substring(0, 80),
              melhorValorGeral: itens[0].melhorValorGeral,
              dataHoraFimContagem: itens[0].dataHoraFimContagem,
              // Dump all keys
              _keys: Object.keys(itens[0]),
            } : null,
            rawPreview: JSON.stringify(data).substring(0, 500),
          });
        } catch (e) {
          resultados.push({
            tipo: ep.tipo,
            error: e.message,
          });
        }
      }

      // Também checar no cache
      const cached = disputasCache.disputas.find(d => d.compraId === compraId);

      res.json({
        compraId,
        tokenStatus: { temToken: status.temToken, temCaptcha: status.temCaptcha, tokenIdade: status.tokenIdade },
        cacheDisputa: cached || null,
        totalCacheDisputas: disputasCache.disputas.length,
        cacheAtualizadoEm: disputasCache.atualizadoEm,
        resultados,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  let pendingItemQueries = []; // { compraId, requestedAt, status }

  /**
   * GET /api/sniper/consultar-itens?compraId=XXXX
   * Retorna do cache, ou enfileira para extensão consultar.
   */
  app.get('/api/sniper/consultar-itens', async (req, res) => {
    try {
      const { compraId } = req.query;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });

      // 1. Verificar cache de disputas
      const cached = disputasCache.disputas.find(d => d.compraId === compraId);
      if (cached && cached.itens?.length > 0) {
        const idadeMs = Date.now() - new Date(disputasCache.atualizadoEm).getTime();
        return res.json({
          success: true,
          fonte: 'cache-extensao',
          idadeSegundos: Math.round(idadeMs / 1000),
          compraId,
          ...cached,
        });
      }

      // 2. Enfileirar para extensão consultar (se não já na fila)
      const jaEnfileirado = pendingItemQueries.some(q => q.compraId === compraId && q.status === 'pendente');
      if (!jaEnfileirado) {
        pendingItemQueries.push({ compraId, requestedAt: new Date().toISOString(), status: 'pendente' });
        console.log(`[Sniper] 🔍 Query enfileirada para extensão: ${compraId}`);
      }

      // 3. Responder que está na fila
      res.json({
        success: false,
        fonte: 'aguardando-extensao',
        compraId,
        error: 'Itens enfileirados para consulta via extensão (~5s). Tente novamente em instantes.',
        cacheDisputas: {
          totalNoCache: disputasCache.disputas.length,
          atualizadoEm: disputasCache.atualizadoEm,
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/itens-comprasnet?compraId=XXXX&captcha=P1_...
   * Busca itens da compra na API Comprasnet PRÉ-DISPUTA (fase externa).
   * Funciona quando o fornecedor já cadastrou proposta — mesmo endpoint
   * que a tela /comprasnet-web/seguro/fornecedor/cadastro-propostas usa.
   *
   * O endpoint primário (aguardando-abertura-sessao-publica) EXIGE captcha
   * hCaptcha. Hoje o Electron não captura captcha automaticamente — então
   * o usuário pode passar via query (?captcha=P1_...) copiando do Network
   * tab do navegador. TODO: capturar no Electron via webRequest.
   *
   * Tentativas em ordem (cai pro próximo se vazio/erro):
   *   1. fase-externa/itens/aguardando-abertura-sessao-publica  ← com captcha
   *   2. fase-externa/itens/em-selecao-fornecedores
   *   3. disputa/itens                                          ← fallback
   *
   * Retorno: { itens: [{numero, descricao, valorEstimado, fase, propostaItem, ...}] }
   */
  app.get('/api/sniper/itens-comprasnet', async (req, res) => {
    try {
      const { compraId, captcha: captchaQuery } = req.query;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      if (!sniper.temToken()) {
        return res.json({ success: false, error: 'Sem Bearer token. Renove no Electron.' });
      }

      // Se cliente passou captcha por query (test manual), grava em memória
      if (captchaQuery) sniper.setCaptchaToken(captchaQuery);

      const mapearItens = arr => arr.map(i => ({
        numero: i.numero || i.identificador || i.numeroItem || 0,
        descricao: String(i.descricao || i.objetoItem || i.descricaoItem || '').substring(0, 500),
        fase: i.fase || i.faseItem || 'LA',
        valorEstimado: i.valorEstimadoUnitario || i.valorEstimado || i.valorTotalEstimado || null,
        unidadeMedida: i.unidadeFornecimento || i.unidadeMedida || i.unidade || '',
        quantidade: i.quantidadeSolicitada || i.quantidade || null,
        propostaItem: i.propostaItem || null,
      }));

      const tentativas = [];

      // 1) ENDPOINT PRINCIPAL: pré-abertura da sessão pública (REQUER CAPTCHA)
      if (sniper.temCaptcha()) {
        // Paginar até esgotar (pages-count vem no header, mas iteramos por size)
        try {
          let pagina = 0;
          const tamanho = 100;
          const todos = [];
          while (true) {
            const path = `/comprasnet-fase-externa/v1/compras/${compraId}/itens/aguardando-abertura-sessao-publica?tamanhoPagina=${tamanho}&pagina=${pagina}`;
            const { status, data } = await sniper.apiGetCaptcha(path);
            const isArray = Array.isArray(data);
            tentativas.push({ endpoint: `aguardando-abertura-sessao-publica?pagina=${pagina}`, status, len: isArray ? data.length : 0 });
            if (!(status === 200 || status === 206) || !isArray) break;
            todos.push(...data);
            if (data.length < tamanho) break; // última página
            pagina++;
            if (pagina > 50) break; // sanity
          }
          if (todos.length > 0) {
            return res.json({ success: true, fonte: 'aguardando-abertura-sessao-publica', compraId, itens: mapearItens(todos), tentativas });
          }
        } catch (e) {
          tentativas.push({ endpoint: 'aguardando-abertura-sessao-publica', error: e.message });
        }
      } else {
        tentativas.push({ endpoint: 'aguardando-abertura-sessao-publica', skipped: 'sem captcha — passe ?captcha=P1_... copiado do Network tab' });
      }

      // 2) Fallback sem captcha: em-selecao-fornecedores (vale em fases mais avançadas)
      try {
        const path = `/comprasnet-fase-externa/v1/compras/${compraId}/itens/em-selecao-fornecedores`;
        const { status, data } = await sniper.apiGet(path);
        const isArray = Array.isArray(data);
        tentativas.push({ endpoint: 'em-selecao-fornecedores', status, len: isArray ? data.length : 0 });
        if ((status === 200 || status === 206) && isArray && data.length > 0) {
          return res.json({ success: true, fonte: 'em-selecao-fornecedores', compraId, itens: mapearItens(data), tentativas });
        }
      } catch (e) {
        tentativas.push({ endpoint: 'em-selecao-fornecedores', error: e.message });
      }

      // 3) Fallback: já em disputa
      try {
        const path = `/comprasnet-disputa/v1/compras/${compraId}/itens`;
        const { status, data } = await sniper.apiGet(path);
        const isArray = Array.isArray(data);
        tentativas.push({ endpoint: 'disputa/itens', status, len: isArray ? data.length : 0 });
        if ((status === 200 || status === 206) && isArray && data.length > 0) {
          return res.json({ success: true, fonte: 'disputa/itens', compraId, itens: mapearItens(data), tentativas });
        }
      } catch (e) {
        tentativas.push({ endpoint: 'disputa/itens', error: e.message });
      }

      return res.json({
        success: false,
        error: sniper.temCaptcha()
          ? 'Itens não encontrados em nenhum endpoint (fase-externa nem disputa).'
          : 'Endpoint primário (aguardando-abertura-sessao-publica) exige captcha hCaptcha. Cole o token P1_... do Network tab do navegador via ?captcha=P1_... ou aguarde o Electron capturar.',
        tentativas,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/itens-live?compraId=XXXX
   * Busca itens em disputa DIRETO da API Comprasnet usando Bearer token.
   * Retorna melhorValor, nossoValor, variacaoMinima, fimContagem etc.
   * Não depende do cache da extensão.
   */
  app.get('/api/sniper/itens-live', async (req, res) => {
    try {
      const { compraId } = req.query;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      if (!sniper.temToken()) return res.json({ success: false, error: 'Sem Bearer token' });

      // Tentar /itens/em-disputa primeiro (tem preços live), fallback para /itens e /itens/classificacao
      const endpoints = [
        `/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa`,
        `/comprasnet-disputa/v1/compras/${compraId}/itens`,
        `/comprasnet-disputa/v1/compras/${compraId}/itens/classificacao`,
      ];

      const tentativas = [];
      for (const path of endpoints) {
        try {
          const { status, data } = await sniper.apiGet(path);
          tentativas.push({ endpoint: path.split('/v1/')[1], status, isArray: Array.isArray(data), len: Array.isArray(data) ? data.length : 0 });
          if ((status === 200 || status === 206) && Array.isArray(data) && data.length > 0) {
            const itens = data.map(i => {
              // Grupo/lote (disputaPorValorUnitario=false) traz o total em
              // valorCalculado, não valorInformado. Fallback restrito a grupo
              // p/ não mudar o display de item normal.
              const ehGrupo = i.tipo === 'G' || i.numero < 0;
              const mg = i.melhorValorGeral || {};
              const mf = i.melhorValorFornecedor || {};
              const pick = o => o.valorInformado != null
                ? o.valorInformado
                : (ehGrupo && o.valorCalculado != null ? o.valorCalculado : null);
              return {
                numero: i.numero || i.identificador,
                tipo: i.tipo || null,
                identificador: i.identificador || null,
                descricao: (i.descricao || i.objetoItem || '').substring(0, 200),
                fase: i.fase || '',
                melhorValor: pick(mg),
                nossoValor: pick(mf),
                valorEstimado: i.valorEstimadoUnitario || i.valorEstimado || null,
                situacaoParticipante: i.situacaoParticipanteDisputa || null,
                variacaoMinima: i.variacaoMinimaEntreLances != null ? i.variacaoMinimaEntreLances : null,
                tipoVariacao: i.tipoVariacaoMinimaEntreLances || 'V',
                podeEnviar: i.podeEnviarLances || false,
                fimContagem: i.dataHoraFimContagem || null,
                versaoParticipante: i.versaoParticipante || null,
              };
            });

            // GRUPO: em-disputa devolve só a linha do grupo (-1). Buscar os
            // sub-itens individuais (/itens/{n}) pra permitir LANCE POR ITEM —
            // grupo disputaPorValorUnitario=false = ranking pelo TOTAL, mas o
            // lance é unitário por item (o sub-item traz disputaPorValorUnitario=true).
            for (const g of data) {
              const ehGrupoG = g.tipo === 'G' || g.numero < 0;
              const qtdG = g.qtdeItensDoGrupo || 0;
              if (!ehGrupoG || qtdG < 1) continue;
              for (let n = 1; n <= qtdG; n++) {
                try {
                  const { status: stSub, data: sub } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${compraId}/itens/${n}`);
                  if (stSub !== 200 || !sub || sub.numero == null) continue;
                  const smg = sub.melhorValorGeral || {};
                  const smf = sub.melhorValorFornecedor || {};
                  const spick = o => o.valorInformado != null ? o.valorInformado : (o.valorCalculado != null ? o.valorCalculado : null);
                  itens.push({
                    numero: sub.numero,
                    tipo: sub.tipo || 'S',
                    identificador: sub.identificador || String(sub.numero),
                    grupoPai: g.numero,
                    descricao: (sub.descricao || '').substring(0, 200),
                    fase: sub.fase || '',
                    melhorValor: spick(smg),
                    nossoValor: spick(smf),
                    valorEstimado: sub.valorEstimadoUnitario || sub.valorEstimado || null,
                    situacaoParticipante: sub.situacaoParticipanteDisputa || null,
                    variacaoMinima: sub.variacaoMinimaEntreLances != null ? sub.variacaoMinimaEntreLances : null,
                    tipoVariacao: sub.tipoVariacaoMinimaEntreLances || 'V',
                    podeEnviar: sub.podeEnviarLances || false,
                    fimContagem: sub.dataHoraFimContagem || null,
                    versaoParticipante: sub.versaoParticipante || null,
                  });
                } catch (e) { /* pular sub-item que falhar */ }
              }
            }

            // Atualizar cache de disputas também
            const idx = disputasCache.disputas.findIndex(d => d.compraId === compraId);
            const disputaData = {
              compraId,
              totalItens: itens.length,
              itensAtivos: itens.filter(i => i.podeEnviar || i.fase === 'LA').length,
              itens,
            };
            if (idx >= 0) {
              disputasCache.disputas[idx] = { ...disputasCache.disputas[idx], ...disputaData };
            } else {
              disputasCache.disputas.push(disputaData);
            }
            disputasCache.atualizadoEm = new Date().toISOString();

            return res.json({ success: true, itens, fonte: 'api-direta', endpoint: path.split('/v1/')[1] });
          }
        } catch (e) {
          // Tentar próximo endpoint
        }
      }

      return res.json({ success: false, error: 'Nenhum endpoint retornou dados de itens', tentativas });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/fila-queries
   * Retorna queries pendentes (extensão consulta).
   * TTL: queries em 'processando' há >60s são descartadas (extensão caiu ou falhou silenciosamente).
   */
  app.get('/api/sniper/fila-queries', (req, res) => {
    const agora = Date.now();
    const TTL_PROCESSANDO_MS = 60 * 1000;

    const pendentes = pendingItemQueries.filter(q => q.status === 'pendente');
    pendentes.forEach(q => {
      q.status = 'processando';
      q.processandoDesde = agora;
    });
    res.json({ success: true, queries: pendentes });

    // Limpar: mantém pendentes e processando recentes (<60s).
    pendingItemQueries = pendingItemQueries.filter(q => {
      if (q.status === 'pendente') return true;
      if (q.status === 'processando') {
        return q.processandoDesde && (agora - q.processandoDesde) < TTL_PROCESSANDO_MS;
      }
      return false;
    });
  });

  // ==================== SYNC & MENSAGENS ====================

  /**
   * POST /api/sync/participacoes
   * Recebe participações em bulk do Electron Standalone (server-sync.js).
   * O Electron coleta via fetchParticipacoes(filtros=[5,4,3]) e posta aqui
   * a cada 2 min. Filtros: 5=em andamento, 4=em disputa, 3=proposta enviada.
   * A extensão busca direto da API Comprasnet (mesmo IP = captcha válido).
   */
  app.post('/api/sync/participacoes', (req, res) => {
    try {
      const { participacoes } = req.body;
      if (!Array.isArray(participacoes)) {
        return res.status(400).json({ success: false, error: 'participacoes deve ser array' });
      }

      ultimoSyncExtensao = Date.now();
      let inseridas = 0, atualizadas = 0;

      const stmtSelect = db.prepare('SELECT id, situacao, faseCompra FROM participacoes_comprasnet WHERE compraId = ?');
      const stmtUpdate = db.prepare(`UPDATE participacoes_comprasnet SET
        situacao = COALESCE(?, situacao), faseCompra = COALESCE(?, faseCompra),
        objeto = COALESCE(?, objeto), orgao = COALESCE(?, orgao),
        dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ?`);
      // Quando vem do filtro=5 (em andamento), forçar remoção do status encerrado
      const stmtReativar = db.prepare(`UPDATE participacoes_comprasnet SET
        situacao = CASE WHEN situacao IN ('EN', 'FR', 'SU') THEN '' ELSE situacao END,
        faseCompra = CASE WHEN faseCompra IN ('encerrada', 'ENCERRADA', '4', '99') THEN '3' ELSE COALESCE(?, faseCompra) END,
        objeto = COALESCE(?, objeto), orgao = COALESCE(?, orgao),
        ativo = 1, dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ?`);
      const stmtInsert = db.prepare(`INSERT INTO participacoes_comprasnet
        (compraId, cnpj, ano, sequencial, orgao, objeto, situacao, faseCompra, ativo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);

      const syncTransaction = db.transaction((items) => {
        for (const item of items) {
          const compra = item.compra || item;
          const compraId = buildCompraId(compra);
          if (!compraId || compraId.length < 10) continue;

          const filtro = item._filtro; // 5=em andamento, 4=em disputa, 3=proposta enviada
          const existe = stmtSelect.get(compraId);
          if (existe) {
            // Se veio do filtro=5 e está marcada como encerrada, reativar
            if (filtro === 5 && (existe.situacao === 'EN' || existe.situacao === 'FR' || existe.situacao === 'SU' ||
                ['encerrada', 'ENCERRADA', '4', '99'].includes(existe.faseCompra))) {
              console.log(`[Sync] Reativando ${compraId} (estava ${existe.situacao}/${existe.faseCompra}, voltou no filtro=5)`);
              stmtReativar.run(
                compra.faseCompraFaseExterna || compra.faseCompra || null,
                compra.objetoCompra || compra.objeto || null,
                compra.nomeOrgao || compra.nomeUasg || compra.orgao || null,
                compraId,
              );
            } else if (filtro === 3 && existe.situacao !== 'PE') {
              // filtro=3 = Comprasnet confirma proposta enviada
              console.log(`[Sync] Proposta confirmada ${compraId} (era ${existe.situacao} → PE)`);
              stmtUpdate.run('PE',
                compra.faseCompraFaseExterna || compra.faseCompra || null,
                compra.objetoCompra || compra.objeto || null,
                compra.nomeOrgao || compra.nomeUasg || compra.orgao || null,
                compraId,
              );
            } else {
              stmtUpdate.run(
                filtro === 3 ? 'PE' : (compra.situacaoCompraFaseExterna || compra.situacao || null),
                compra.faseCompraFaseExterna || compra.faseCompra || null,
                compra.objetoCompra || compra.objeto || null,
                compra.nomeOrgao || compra.nomeUasg || compra.orgao || null,
                compraId,
              );
            }
            atualizadas++;
          } else {
            stmtInsert.run(
              compraId,
              compra.numeroUasg || compra.cnpj || '',
              compra.ano || 0,
              compra.numero || compra.sequencial || 0,
              compra.nomeOrgao || compra.nomeUasg || compra.orgao || '',
              compra.objetoCompra || compra.objeto || '',
              filtro === 3 ? 'PE' : (compra.situacaoCompraFaseExterna || compra.situacao || ''),
              compra.faseCompraFaseExterna || compra.faseCompra || '',
            );
            inseridas++;
          }
        }
      });
      syncTransaction(participacoes);

      console.log(`[Sync] Participações: ${inseridas} novas, ${atualizadas} atualizadas (de ${participacoes.length} recebidas)`);

      res.json({ success: true, inseridas, atualizadas, total: participacoes.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sync/participacoes-encerradas
   * Recebe IDs de compras que sumiram do filtro=5 por 2 ciclos consecutivos.
   * Marca como encerradas no banco e remove do cache de disputas.
   */
  app.post('/api/sync/participacoes-encerradas', (req, res) => {
    try {
      const { compraIds } = req.body;
      if (!Array.isArray(compraIds) || compraIds.length === 0) {
        return res.status(400).json({ success: false, error: 'compraIds deve ser array não-vazio' });
      }

      ultimoSyncExtensao = Date.now();
      let atualizadas = 0;

      for (const compraId of compraIds) {
        const result = db.prepare(
          `UPDATE participacoes_comprasnet SET situacao = 'EN', faseCompra = 'encerrada', dataAtualizacao = CURRENT_TIMESTAMP
           WHERE compraId = ? AND situacao != 'EN'`
        ).run(compraId);
        if (result.changes > 0) atualizadas++;

        // Remover do cache de disputas em memória
        const idx = disputasCache.disputas.findIndex(d => d.compraId === compraId);
        if (idx >= 0) disputasCache.disputas.splice(idx, 1);
      }

      console.log(`[Sync] Encerradas: ${atualizadas} de ${compraIds.length} marcadas como EN`);
      res.json({ success: true, atualizadas, total: compraIds.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sync/participacao-detalhes
   * Recebe dados detalhados da API /participacao do Comprasnet.
   * Salva campos extras (modoDisputa, horários, linkPncp, etc.) no banco.
   */
  app.post('/api/sync/participacao-detalhes', (req, res) => {
    try {
      const {
        compraId, modoDisputa, criterioJulgamento,
        dataHoraInicioDisputa, dataHoraFimDisputa, dataHoraAbertura,
        chaveCompraPncp, linkPncp, exclusivaMeEpp,
        fundamentoLegal, situacaoCompra, faseCompra, objeto, orgao,
      } = req.body;

      if (!compraId) {
        return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      }

      const existe = db.prepare('SELECT id FROM participacoes_comprasnet WHERE compraId = ?').get(compraId);
      if (existe) {
        db.prepare(`UPDATE participacoes_comprasnet SET
          modoDisputa = COALESCE(?, modoDisputa),
          criterioJulgamento = COALESCE(?, criterioJulgamento),
          dataHoraInicioDisputa = COALESCE(?, dataHoraInicioDisputa),
          dataHoraFimDisputa = COALESCE(?, dataHoraFimDisputa),
          dataSessao = COALESCE(?, dataSessao),
          chaveCompraPncp = COALESCE(?, chaveCompraPncp),
          linkPncp = COALESCE(?, linkPncp),
          exclusivaMeEpp = COALESCE(?, exclusivaMeEpp),
          fundamentoLegal = COALESCE(?, fundamentoLegal),
          situacao = COALESCE(?, situacao),
          faseCompra = COALESCE(?, faseCompra),
          objeto = COALESCE(?, objeto),
          orgao = COALESCE(?, orgao),
          dataAtualizacao = CURRENT_TIMESTAMP
          WHERE compraId = ?`).run(
          modoDisputa, criterioJulgamento,
          dataHoraInicioDisputa, dataHoraFimDisputa, dataHoraAbertura,
          chaveCompraPncp, linkPncp, exclusivaMeEpp,
          fundamentoLegal, situacaoCompra, faseCompra, objeto, orgao,
          compraId,
        );
        console.log(`[Sync] Participação detalhes: ${compraId} atualizada (modo=${modoDisputa}, fim=${dataHoraFimDisputa})`);
      } else {
        // Se não existe no banco, criar registro básico
        db.prepare(`INSERT INTO participacoes_comprasnet
          (compraId, cnpj, ano, sequencial, orgao, objeto, situacao, faseCompra,
           modoDisputa, criterioJulgamento, dataHoraInicioDisputa, dataHoraFimDisputa,
           dataSessao, chaveCompraPncp, linkPncp, exclusivaMeEpp, fundamentoLegal, ativo)
          VALUES (?, '', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
          compraId, orgao || '', objeto || '', situacaoCompra || '', faseCompra || '',
          modoDisputa, criterioJulgamento,
          dataHoraInicioDisputa, dataHoraFimDisputa, dataHoraAbertura,
          chaveCompraPncp, linkPncp, exclusivaMeEpp || 0, fundamentoLegal,
        );
        console.log(`[Sync] Participação detalhes: ${compraId} inserida (modo=${modoDisputa})`);
      }

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sync/mensagens
   * Recebe mensagens de uma licitação em bulk do Electron.
   */
  app.post('/api/sync/mensagens', async (req, res) => {
    try {
      const { compraId, mensagens } = req.body;
      if (!compraId || !Array.isArray(mensagens)) {
        return res.status(400).json({ success: false, error: 'compraId e mensagens[] obrigatórios' });
      }

      // Obter CNPJ do fornecedor para detectar mensagens direcionadas
      let meuCnpj = '';
      try {
        const fornConfig = db.prepare('SELECT cnpj FROM fornecedor WHERE id = 1').get();
        meuCnpj = (fornConfig?.cnpj || '').replace(/\D/g, '');
        if (!meuCnpj) {
          const configVal = db.prepare("SELECT valor FROM config WHERE chave = 'fornecedor_cnpj'").get();
          meuCnpj = (configVal?.valor || '').replace(/\D/g, '');
        }
      } catch (e) {}

      let novas = 0;
      const alertas = []; // mensagens direcionadas a mim

      // Pregão silenciado pelo usuário não gera alerta Telegram (captura segue normal)
      let silenciado = false;
      try {
        silenciado = !!db.prepare('SELECT 1 FROM chat_pregoes_silenciados WHERE compraId = ?').get(compraId);
      } catch (e) { /* tabela pode não existir */ }

      for (const msg of mensagens) {
        const conteudo = msg.mensagem || msg.conteudo || msg.texto || '';
        const remetente = msg.remetente || msg.nomeRemetente || msg.identificadorRemetente || '';
        const dataHora = msg.dataHora || msg.dataHoraMensagem || msg.dataEnvio || new Date().toISOString();
        const destinatario = msg.identificadorDestinatario || '';

        // Gerar hash para deduplicação
        const hashMensagem = require('crypto').createHash('md5')
          .update(compraId + '|' + dataHora + '|' + remetente + '|' + conteudo)
          .digest('hex');

        const existe = db.prepare('SELECT id FROM chat_mensagens WHERE hashMensagem = ?').get(hashMensagem);
        if (existe) continue;

        try {
          db.prepare(`INSERT INTO chat_mensagens
            (compraId, cnpjOrgao, ano, sequencial, dataHoraMensagem,
             remetente, mensagem, hashMensagem, tipoRemetente,
             identificadorRemetente, identificadorDestinatario, notificado)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
            compraId,
            msg.cnpjOrgao || '',
            msg.ano || 0,
            msg.sequencial || 0,
            dataHora,
            remetente,
            conteudo,
            hashMensagem,
            msg.tipoRemetente || '',
            msg.identificadorRemetente || '',
            destinatario,
          );
          novas++;

          // Detectar mensagem direcionada a mim
          if (meuCnpj && destinatario === meuCnpj && !silenciado) {
            alertas.push({ conteudo, dataHora, compraId });
          }
        } catch (e) {
          // Duplicate hash — skip
        }
      }

      if (novas > 0) {
        console.log(`[Sync] Mensagens ${compraId}: ${novas} novas (de ${mensagens.length})`);
      }

      // Enviar alertas Telegram para mensagens direcionadas
      if (alertas.length > 0) {
        try {
          const telegramConfig = db.prepare('SELECT botToken, chatId FROM telegram_config WHERE id = 1 AND ativo = 1').get();
          if (telegramConfig?.botToken && telegramConfig?.chatId) {
            // Buscar info da participação
            const participacao = db.prepare('SELECT orgao, objeto FROM participacoes_comprasnet WHERE compraId = ?').get(compraId);
            const orgao = participacao?.orgao || compraId;
            const objeto = participacao?.objeto || '';

            for (const alerta of alertas) {
              const texto = `🚨 <b>MENSAGEM DIRECIONADA A VOCÊ!</b>\n\n` +
                `📋 <b>Compra:</b> ${compraId}\n` +
                `🏢 <b>Órgão:</b> ${orgao}\n` +
                (objeto ? `📝 <b>Objeto:</b> ${objeto.substring(0, 100)}...\n` : '') +
                `⏰ <b>Hora:</b> ${alerta.dataHora}\n\n` +
                `💬 ${alerta.conteudo}\n\n` +
                `⚠️ <b>RESPONDA IMEDIATAMENTE — prazo pode ser de apenas 10 minutos!</b>`;

              const axios = require('axios');
              await axios.post(`https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage`, {
                chat_id: telegramConfig.chatId,
                text: texto,
                parse_mode: 'HTML'
              });
              console.log(`[ALERTA] Telegram enviado: mensagem direcionada em ${compraId}`);
            }
          }
        } catch (telegramErr) {
          console.error('[ALERTA] Erro Telegram:', telegramErr.message);
        }
      }

      res.json({ success: true, novas, total: mensagens.length, alertas: alertas.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sync/mensagens-global
   * Recebe mensagens do endpoint global /comprasnet-mensagem/v1/mensagens
   * Formato diferente do v2/chat — campos: id, titulo, texto, origemMensagem, categoria, etc.
   */
  app.post('/api/sync/mensagens-global', async (req, res) => {
    try {
      const { mensagens } = req.body;
      if (!Array.isArray(mensagens)) {
        return res.status(400).json({ success: false, error: 'mensagens[] obrigatório' });
      }

      // Obter CNPJ do fornecedor para detectar mensagens direcionadas
      let meuCnpj = '';
      try {
        const fornConfig = db.prepare('SELECT cnpj FROM fornecedor WHERE id = 1').get();
        meuCnpj = (fornConfig?.cnpj || '').replace(/\D/g, '');
        if (!meuCnpj) {
          const configVal = db.prepare("SELECT valor FROM config WHERE chave = 'fornecedor_cnpj'").get();
          meuCnpj = (configVal?.valor || '').replace(/\D/g, '');
        }
      } catch (e) {}

      let novas = 0;
      const alertas = [];

      // Carregar palavras-chave ativas do tenant uma vez (caches na ingestão do batch)
      let palavrasChaveAtivas = [];
      try {
        palavrasChaveAtivas = db.prepare("SELECT palavra FROM chat_palavras_chave WHERE ativo = 1").all()
          .map(r => String(r.palavra || '').toLowerCase()).filter(p => p.length >= 2);
      } catch (e) { /* tabela pode não existir */ }

      // Pregões silenciados pelo usuário — não geram alerta Telegram (captura segue normal)
      let silenciados = new Set();
      try {
        silenciados = new Set(db.prepare('SELECT compraId FROM chat_pregoes_silenciados').all().map(r => r.compraId));
      } catch (e) { /* tabela pode não existir */ }

      // Categorias do Comprasnet consideradas "importantes" para alerta Telegram.
      // 810 = impugnação / pedido esclarecimento
      // 820 = resposta / aviso do pregoeiro
      // 830 = convocação formal (anexos, propostas)
      // 840 = mensagem do agente de contratação (pregoeiro conduzindo a sessão)
      // 850 = ata / julgamento
      const CATEGORIAS_ALERTA = new Set(['810', '820', '830', '840', '850']);

      // Normaliza CNPJ (só dígitos). Também prepara variação formatada para busca.
      const meuCnpjDigits = meuCnpj; // já vem limpo acima
      const meuCnpjFormatado = meuCnpjDigits.length === 14
        ? `${meuCnpjDigits.substring(0,2)}.${meuCnpjDigits.substring(2,5)}.${meuCnpjDigits.substring(5,8)}/${meuCnpjDigits.substring(8,12)}-${meuCnpjDigits.substring(12,14)}`
        : '';

      const insertStmt = db.prepare(`INSERT OR IGNORE INTO chat_mensagens
        (compraId, cnpjOrgao, ano, sequencial, dataHoraMensagem,
         remetente, mensagem, hashMensagem, titulo, categoria,
         origemMensagem, lidaComprasnet, tipoCompra, excluida,
         vinculadaADiligencia, descricaoModalidade, numeroCompraFormatado,
         identificadorItem, mensagemIdComprasnet, origemCaptura, notificado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extensao-v1', 0)`);

      for (const msg of mensagens) {
        // Montar compraId via helper centralizado (SNIPER-C01)
        const compraId = buildCompraId(msg);
        if (!compraId || compraId.length < 10) continue;
        const uasg = String(msg.numeroUasg || '').padStart(6, '0');

        const conteudo = msg.texto || '';
        const remetente = msg.remetente || '';
        const dataHora = msg.dataHoraPublicacao || new Date().toISOString();

        // Hash para deduplicação (fallback se não tiver id do Comprasnet)
        const hashMensagem = require('crypto').createHash('md5')
          .update(compraId + '|' + dataHora + '|' + remetente + '|' + conteudo)
          .digest('hex');

        // Se já temos pelo ID do Comprasnet, skip
        if (msg.id) {
          const existe = db.prepare('SELECT id FROM chat_mensagens WHERE mensagemIdComprasnet = ?').get(msg.id);
          if (existe) continue;
        }

        try {
          insertStmt.run(
            compraId,
            uasg,                               // cnpjOrgao (aqui é UASG, não CNPJ)
            parseInt(msg.anoCompra) || 0,        // ano
            parseInt(msg.numeroCompra) || 0,     // sequencial
            dataHora,
            remetente,
            conteudo,
            hashMensagem,
            msg.titulo || '',
            msg.categoria || '',
            msg.origemMensagem || '',
            msg.lida ? 1 : 0,
            msg.tipoCompra || '',
            msg.excluida ? 1 : 0,
            msg.vinculadaADiligencia ? 1 : 0,
            msg.descricaoModalidade || '',
            msg.numeroCompraFormatado || '',
            msg.identificadorItem || '',
            msg.id || null
          );
          novas++;

          // Avalia motivos de alerta (qualquer match já qualifica)
          const motivos = [];
          const tituloMsg = msg.titulo || '';
          const conteudoLower = String(conteudo).toLowerCase();
          const tituloLower = tituloMsg.toLowerCase();
          const textoCombinado = conteudoLower + ' ' + tituloLower;

          if (CATEGORIAS_ALERTA.has(String(msg.categoria))) {
            motivos.push(`categoria ${msg.categoria}`);
          }
          if (msg.identificadorParticipante && meuCnpjDigits) {
            motivos.push('direcionada ao fornecedor');
          }
          if (meuCnpjDigits && (textoCombinado.includes(meuCnpjDigits) ||
              (meuCnpjFormatado && textoCombinado.includes(meuCnpjFormatado.toLowerCase())))) {
            motivos.push('menção ao CNPJ');
          }
          const palavrasMatch = palavrasChaveAtivas.filter(p => textoCombinado.includes(p));
          if (palavrasMatch.length) {
            motivos.push('palavra-chave');
          }

          if (motivos.length > 0 && !silenciados.has(compraId)) {
            alertas.push({
              conteudo, dataHora, compraId,
              titulo: tituloMsg,
              categoria: msg.categoria || '',
              motivos,
              palavrasMatch,
              mensagemId: msg.id || null,
              hashMensagem,
            });
          }
        } catch (e) {
          // Duplicate hash ou id — skip
        }
      }

      if (novas > 0) {
        console.log(`[Sync] Mensagens global: ${novas} novas (de ${mensagens.length})`);
      }

      // Enviar alertas Telegram para mensagens que bateram critérios
      if (alertas.length > 0) {
        try {
          const telegramConfig = db.prepare('SELECT botToken, chatId FROM telegram_config WHERE id = 1 AND ativo = 1').get();
          if (telegramConfig?.botToken && telegramConfig?.chatId) {
            const axios = require('axios');
            const stmtMarcarNotificado = db.prepare(
              `UPDATE chat_mensagens SET notificado = 1
               WHERE (mensagemIdComprasnet = ? AND ? IS NOT NULL)
                  OR hashMensagem = ?`
            );
            for (const alerta of alertas) {
              const participacao = db.prepare('SELECT orgao, objeto FROM participacoes_comprasnet WHERE compraId = ?').get(alerta.compraId);
              const orgao = participacao?.orgao || alerta.compraId;
              const objeto = participacao?.objeto || '';

              const conteudoLimitado = alerta.conteudo.length > 500
                ? alerta.conteudo.substring(0, 500) + '…'
                : alerta.conteudo;

              const linhasExtras = [];
              if (alerta.palavrasMatch?.length) {
                linhasExtras.push(`🔔 <b>Palavras-chave:</b> ${alerta.palavrasMatch.join(', ')}`);
              }
              if (alerta.motivos?.length) {
                linhasExtras.push(`🏷️ <b>Motivos:</b> ${alerta.motivos.join(' · ')}`);
              }

              const texto = `🚨 <b>${alerta.titulo || 'MENSAGEM IMPORTANTE'}</b>\n\n` +
                `📋 <b>Compra:</b> ${alerta.compraId}\n` +
                `🏢 <b>Órgão:</b> ${orgao}\n` +
                (objeto ? `📝 <b>Objeto:</b> ${objeto.substring(0, 100)}${objeto.length > 100 ? '…' : ''}\n` : '') +
                `⏰ <b>Hora:</b> ${alerta.dataHora}\n` +
                (linhasExtras.length ? linhasExtras.join('\n') + '\n' : '') +
                `\n💬 ${conteudoLimitado}\n\n` +
                `⚠️ <b>VERIFIQUE NO COMPRASNET!</b>`;

              try {
                await axios.post(`https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage`, {
                  chat_id: telegramConfig.chatId,
                  text: texto,
                  parse_mode: 'HTML'
                });
                // Marca como notificado para evitar reenvio se Electron repostar
                try { stmtMarcarNotificado.run(alerta.mensagemId, alerta.mensagemId, alerta.hashMensagem); }
                catch (_) {}
                console.log(`[ALERTA] Telegram enviado: ${alerta.motivos.join('+')} em ${alerta.compraId}`);
              } catch (axiosErr) {
                console.error(`[ALERTA] Telegram falhou em ${alerta.compraId}: ${axiosErr.message}`);
              }
            }
          } else {
            console.log(`[ALERTA] ${alertas.length} alerta(s) candidatos mas Telegram não configurado/ativo neste tenant`);
          }
        } catch (telegramErr) {
          console.error('[ALERTA] Erro Telegram:', telegramErr.message);
        }
      }

      res.json({ success: true, novas, total: mensagens.length, alertas: alertas.length });
    } catch (e) {
      console.error('[Sync] Erro mensagens-global:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/sync-participacoes — legacy (server-side, requer captcha IP)
   */
  app.post('/api/sniper/sync-participacoes', async (req, res) => {
    try {
      const result = await sniper.syncParticipacoes(db);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/sniper/resync-encerradas — backfill imediato pra destravar compras
  // que ficaram marcadas como faseCompra='4' indevidamente (heurística do /qtdes
  // marcando 4 durante suspensão/intervalo, ou Comprasnet retornando 4 num
  // momento transitório). Itera as candidatas (faseCompra=4, não homologada,
  // janela 30d) e re-consulta /participacao pra ler faseCompraFaseExterna real.
  app.post('/api/sniper/resync-encerradas', async (req, res) => {
    if (!sniper.temToken() || sniper.tokenExpirado()) {
      return res.status(401).json({ success: false, error: 'Bearer ausente/expirado' });
    }
    try {
      const candidatas = db.prepare(`
        SELECT compraId FROM participacoes_comprasnet
        WHERE ativo = 1 AND faseCompra = '4' AND homologada = 0
          AND dataAtualizacao > datetime('now', '-30 days')
        ORDER BY dataAtualizacao DESC LIMIT 200
      `).all();
      const stmtUpdate = db.prepare(`UPDATE participacoes_comprasnet SET
        situacao = ?, faseCompra = ?,
        objeto = COALESCE(NULLIF(?, ''), objeto),
        orgao = COALESCE(NULLIF(?, ''), orgao),
        dataAtualizacao = CURRENT_TIMESTAMP
        WHERE compraId = ?`);
      const resultado = { verificadas: candidatas.length, reativadas: 0, mantidas: 0, erros: 0, detalhes: [] };
      const delay = ms => new Promise(r => setTimeout(r, ms));
      for (const { compraId } of candidatas) {
        try {
          const { status, data } = await sniper.apiGet(`/comprasnet-fase-externa/v1/compras/${compraId}/participacao`);
          const parsed = status === 200 ? extrairFaseFromParticipacao(data) : null;
          if (parsed && parsed.fase) {
            stmtUpdate.run(parsed.situacao, parsed.fase, parsed.objeto, parsed.orgao, compraId);
            if (parsed.fase !== '4') {
              resultado.reativadas++;
              resultado.detalhes.push({ compraId, faseAntes: '4', faseDepois: parsed.fase, situacao: parsed.situacao });
            } else {
              resultado.mantidas++;
            }
          } else {
            resultado.erros++;
          }
          await delay(150);
        } catch (e) { resultado.erros++; }
      }
      res.json({ success: true, ...resultado });
    } catch (e) {
      console.error('[resync-encerradas] erro:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sniper/capturar-mensagens', async (req, res) => {
    try {
      const { compraId } = req.body;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      const novas = await sniper.capturarMensagens(compraId, db);
      res.json({ success: true, novasMensagens: novas });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sniper/capturar-todas-mensagens', async (req, res) => {
    try {
      const total = await sniper.capturarTodasMensagens(db);
      res.json({ success: true, novasMensagens: total });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== SNIPER ITENS (config por item no banco) ====================

  /**
   * GET /api/sniper/itens?compraId=XXXX
   * Lista itens configurados para uma compra.
   */
  app.get('/api/sniper/itens', (req, res) => {
    try {
      const { compraId } = req.query;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      const itens = db.prepare('SELECT * FROM sniper_itens WHERE compraId = ? ORDER BY itemNumero').all(compraId);
      res.json({ success: true, itens });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/itens
   * Cria ou atualiza um item (upsert por compraId+itemNumero).
   */
  app.post('/api/sniper/itens', (req, res) => {
    try {
      const { compraId, itemNumero, descricao, valorLance, faseItem, horarioAlvo,
              antecedenciaMs, tentativas, intervaloMs, ativo,
              valorMinimo, descontoMinimo, descontoMaximo, valorEstimado, modoAuto, custo,
              variacaoMinima, tipoVariacao, maxLances } = req.body;
      if (!compraId || !itemNumero) return res.status(400).json({ success: false, error: 'compraId e itemNumero obrigatórios' });

      const stmt = db.prepare(`INSERT INTO sniper_itens (compraId, itemNumero, descricao, valorLance, faseItem, horarioAlvo, antecedenciaMs, tentativas, intervaloMs, ativo, valorMinimo, descontoMinimo, descontoMaximo, valorEstimado, custo, variacaoMinima, tipoVariacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(compraId, itemNumero) DO UPDATE SET
          descricao = COALESCE(excluded.descricao, descricao),
          valorLance = COALESCE(excluded.valorLance, valorLance),
          faseItem = COALESCE(excluded.faseItem, faseItem),
          horarioAlvo = COALESCE(excluded.horarioAlvo, horarioAlvo),
          antecedenciaMs = COALESCE(excluded.antecedenciaMs, antecedenciaMs),
          tentativas = COALESCE(excluded.tentativas, tentativas),
          intervaloMs = COALESCE(excluded.intervaloMs, intervaloMs),
          ativo = COALESCE(excluded.ativo, ativo),
          valorMinimo = COALESCE(excluded.valorMinimo, valorMinimo),
          descontoMinimo = COALESCE(excluded.descontoMinimo, descontoMinimo),
          descontoMaximo = COALESCE(excluded.descontoMaximo, descontoMaximo),
          valorEstimado = COALESCE(excluded.valorEstimado, valorEstimado),
          custo = COALESCE(excluded.custo, custo),
          variacaoMinima = COALESCE(excluded.variacaoMinima, variacaoMinima),
          tipoVariacao = COALESCE(excluded.tipoVariacao, tipoVariacao),
          dataAtualizacao = CURRENT_TIMESTAMP`);

      stmt.run(compraId, itemNumero, descricao || null, valorLance || null, faseItem || 'LA',
               horarioAlvo || null, antecedenciaMs || 3000, tentativas || 3, intervaloMs || 500,
               ativo !== undefined ? (ativo ? 1 : 0) : 1,
               valorMinimo !== undefined ? valorMinimo : null,
               descontoMinimo !== undefined ? descontoMinimo : null,
               descontoMaximo !== undefined ? descontoMaximo : null,
               valorEstimado !== undefined ? valorEstimado : null,
               custo !== undefined ? custo : null,
               variacaoMinima !== undefined ? variacaoMinima : null,
               tipoVariacao || null);

      // Campos que permitem limpar (null = explicitly clear, undefined = don't touch)
      if ('modoAuto' in req.body) {
        db.prepare(`UPDATE sniper_itens SET modoAuto = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ? AND itemNumero = ?`)
          .run(modoAuto || null, compraId, itemNumero);
      }
      if ('maxLances' in req.body) {
        db.prepare(`UPDATE sniper_itens SET maxLances = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ? AND itemNumero = ?`)
          .run(maxLances || null, compraId, itemNumero);
      }
      if ('valorMinimo' in req.body) {
        db.prepare(`UPDATE sniper_itens SET valorMinimo = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ? AND itemNumero = ?`)
          .run(valorMinimo != null ? valorMinimo : null, compraId, itemNumero);
      }

      // ── Camada 2: auto-roteamento por modalidade. Pregão (fecha aleatório) → Contínuo.
      // Só dispara quando o usuário definiu Valor Mínimo num pregão e NÃO escolheu modo
      // (se escolheu explicitamente, respeita — Camada 1 já avisou).
      let autoRoteado = null;
      if (isPregaoCompraId(compraId) && !('modoAuto' in req.body)) {
        const it = db.prepare('SELECT modoAuto, valorMinimo FROM sniper_itens WHERE compraId = ? AND itemNumero = ?').get(compraId, itemNumero);
        if (it && it.valorMinimo != null && (it.modoAuto == null || it.modoAuto === '')) {
          db.prepare(`UPDATE sniper_itens SET modoAuto = 'continuo', dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ? AND itemNumero = ?`).run(compraId, itemNumero);
          autoRoteado = 'continuo';
        }
      }

      const item = db.prepare('SELECT * FROM sniper_itens WHERE compraId = ? AND itemNumero = ?').get(compraId, itemNumero);

      // Check if auto-lance engine needs to start/stop
      verificarAutoLanceNecessario();

      res.json({ success: true, item, autoRoteado });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/sniper/itens/bulk
   * Cria/atualiza vários itens de uma vez.
   */
  app.post('/api/sniper/itens/bulk', (req, res) => {
    try {
      const { compraId, itens } = req.body;
      if (!compraId || !itens?.length) return res.status(400).json({ success: false, error: 'compraId e itens obrigatórios' });

      const stmt = db.prepare(`INSERT INTO sniper_itens (compraId, itemNumero, descricao, valorLance, faseItem, ativo, valorEstimado)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(compraId, itemNumero) DO UPDATE SET
          descricao = COALESCE(excluded.descricao, descricao),
          valorLance = COALESCE(excluded.valorLance, valorLance),
          faseItem = COALESCE(excluded.faseItem, faseItem),
          ativo = COALESCE(excluded.ativo, ativo),
          valorEstimado = COALESCE(excluded.valorEstimado, valorEstimado),
          dataAtualizacao = CURRENT_TIMESTAMP`);

      const numerosRecebidos = itens.map(i => i.itemNumero);
      const inserir = db.transaction((itens) => {
        for (const i of itens) {
          stmt.run(compraId, i.itemNumero, i.descricao || null, i.valorLance || null, i.faseItem || 'LA', i.ativo !== undefined ? (i.ativo ? 1 : 0) : 1, i.valorEstimado || null);
        }
        // Remover itens que não existem mais na fonte (evita itens fantasma)
        if (numerosRecebidos.length > 0) {
          const placeholders = numerosRecebidos.map(() => '?').join(',');
          db.prepare(`DELETE FROM sniper_itens WHERE compraId = ? AND itemNumero NOT IN (${placeholders})`).run(compraId, ...numerosRecebidos);
        }
      });
      inserir(itens);

      const saved = db.prepare('SELECT * FROM sniper_itens WHERE compraId = ? ORDER BY itemNumero').all(compraId);
      res.json({ success: true, itens: saved });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * DELETE /api/sniper/itens/:compraId/:itemNumero
   */
  app.delete('/api/sniper/itens/:compraId/:itemNumero', (req, res) => {
    try {
      const { compraId, itemNumero } = req.params;
      db.prepare('DELETE FROM sniper_itens WHERE compraId = ? AND itemNumero = ?').run(compraId, parseInt(itemNumero));
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/itens-pncp?compraId=XXXX
   * Busca itens da tabela PNCP (licitacoes + itens) para uma participação Comprasnet.
   * Usa codigoUnidade + ano + objeto para encontrar a licitação correspondente.
   */
  app.get('/api/sniper/itens-pncp', async (req, res) => {
    try {
      const { compraId } = req.query;
      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });

      // Extrair UASG e ano do compraId (formato: UASG6 + MOD2 + NUM5 + ANO4)
      const participacao = db.prepare(
        'SELECT compraId, cnpj, codigoUnidade, ano, sequencial, objeto FROM participacoes_comprasnet WHERE compraId = ?'
      ).get(compraId);
      if (!participacao) return res.json({ success: false, error: 'Participação não encontrada' });

      // Extrair UASG do compraId (primeiros 6 dígitos)
      const uasg = compraId.substring(0, 6);

      // Buscar licitação no PNCP: codigoUnidade contém a UASG, mesmo ano, objeto similar
      const palavrasObjeto = (participacao.objeto || '').split(/\s+/).filter(p => p.length > 4).slice(0, 3);
      let licitacao = null;

      if (palavrasObjeto.length > 0) {
        if (USE_PG) {
          const likeClause = palavrasObjeto.map((_, i) => `"objetoCompra" ILIKE $${i + 3}`).join(' AND ');
          const likeParams = palavrasObjeto.map(p => `%${p}%`);
          licitacao = await catalogPg.queryOne(
            `SELECT "id" AS id, "codigoUnidade" AS "codigoUnidade", "anoCompra" AS "anoCompra",
                    "sequencialCompra" AS "sequencialCompra", "objetoCompra" AS "objetoCompra",
                    "numeroControlePNCP" AS "numeroControlePNCP"
               FROM licitacoes WHERE "codigoUnidade" ILIKE $1 AND "anoCompra" = $2 AND ${likeClause}
              ORDER BY "id" DESC LIMIT 1`,
            [`%${uasg}%`, participacao.ano, ...likeParams]
          );
        } else {
          const likeClause = palavrasObjeto.map(() => 'objetoCompra LIKE ?').join(' AND ');
          const likeParams = palavrasObjeto.map(p => `%${p}%`);
          licitacao = db.prepare(
            `SELECT id, codigoUnidade, anoCompra, sequencialCompra, objetoCompra, numeroControlePNCP
             FROM licitacoes WHERE codigoUnidade LIKE ? AND anoCompra = ? AND ${likeClause}
             ORDER BY id DESC LIMIT 1`
          ).get(`%${uasg}%`, participacao.ano, ...likeParams);
        }
      }

      if (!licitacao) {
        return res.json({ success: false, error: 'Licitação PNCP não encontrada para esta participação' });
      }

      let itens;
      if (USE_PG) {
        itens = await catalogPg.query(
          `SELECT "numeroItem" AS "numeroItem", "descricao" AS descricao, "quantidade" AS quantidade,
                  "unidadeMedida" AS "unidadeMedida", "valorUnitarioEstimado" AS "valorUnitarioEstimado",
                  "valorTotal" AS "valorTotal"
             FROM itens WHERE "licitacaoId" = $1 ORDER BY "numeroItem"`,
          [licitacao.id]
        );
      } else {
        itens = db.prepare(
          'SELECT numeroItem, descricao, quantidade, unidadeMedida, valorUnitarioEstimado, valorTotal FROM itens WHERE licitacaoId = ? ORDER BY numeroItem'
        ).all(licitacao.id);
      }

      res.json({
        success: true,
        licitacaoId: licitacao.id,
        numeroControlePNCP: licitacao.numeroControlePNCP,
        itens: itens.map(i => ({
          itemNumero: i.numeroItem,
          descricao: i.descricao,
          quantidade: i.quantidade,
          unidadeMedida: i.unidadeMedida,
          valorEstimado: i.valorUnitarioEstimado,
          valorTotal: i.valorTotal,
        })),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/sniper/historico?compraId=XXXX
   * Histórico de lances enviados.
   */
  app.get('/api/sniper/historico', (req, res) => {
    try {
      const { compraId, itemNumero, limit } = req.query;
      let query = 'SELECT id, compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp FROM sniper_historico WHERE 1=1';
      const params = [];
      if (compraId) { query += ' AND compraId = ?'; params.push(compraId); }
      if (itemNumero) { query += ' AND itemNumero = ?'; params.push(parseInt(itemNumero)); }
      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(parseInt(limit) || 50);
      const rows = db.prepare(query).all(...params);
      res.json({ success: true, historico: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/relatorio-lances
   * Relatório detalhado de lances com filtros e resumo.
   */
  app.get('/api/relatorio-lances', (req, res) => {
    try {
      const { compraId, itemNumero, sucesso, fonte, dataInicio, dataFim, limit } = req.query;
      let query = 'SELECT id, compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp FROM sniper_historico WHERE 1=1';
      const params = [];

      if (compraId) { query += ' AND compraId LIKE ?'; params.push(`%${compraId}%`); }
      if (itemNumero) { query += ' AND itemNumero = ?'; params.push(parseInt(itemNumero)); }
      if (sucesso === '1' || sucesso === '0') { query += ' AND sucesso = ?'; params.push(parseInt(sucesso)); }
      if (fonte) { query += ' AND fonte = ?'; params.push(fonte); }
      if (dataInicio) { query += ' AND timestamp >= ?'; params.push(dataInicio + 'T00:00:00Z'); }
      if (dataFim) { query += ' AND timestamp <= ?'; params.push(dataFim + 'T23:59:59Z'); }

      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(parseInt(limit) || 100);

      const lances = db.prepare(query).all(...params);

      // Extrair hora Comprasnet de cada lance
      for (const l of lances) {
        if (l.resposta) {
          try {
            const resp = typeof l.resposta === 'string' ? JSON.parse(l.resposta) : l.resposta;
            const item0 = Array.isArray(resp) ? resp[0] : resp;
            if (item0 && item0.dataHoraAtualizacao) {
              l.comprasnetHora = item0.dataHoraAtualizacao.substring(11, 23);
            }
          } catch (e) {}
          delete l.resposta; // não enviar resposta completa (pesada)
        }
      }

      // Resumo
      const ok = lances.filter(l => l.sucesso).length;
      const falha = lances.length - ok;
      const avgMs = lances.length > 0 ? Math.round(lances.filter(l => l.sucesso && l.tempoMs < 500).reduce((a, l) => a + (l.tempoMs || 0), 0) / Math.max(1, lances.filter(l => l.sucesso && l.tempoMs < 500).length)) : 0;
      const compras = new Set(lances.map(l => l.compraId)).size;
      const itens = new Set(lances.map(l => l.compraId + '-' + l.itemNumero)).size;

      res.json({
        success: true,
        lances,
        resumo: {
          total: lances.length,
          ok, falha,
          taxa: lances.length > 0 ? Math.round(ok / lances.length * 100) : 0,
          avgMs, compras, itens,
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/relatorios/participacoes
   * Relatório das licitações em que o fornecedor participou.
   * Cruza participacoes_comprasnet × catalog.resultados_bi × sniper_historico
   * para mostrar: disputadas, ganhas, perdidas, pendentes de homologação.
   *
   * Query params:
   *   dataInicio / dataFim — intervalo baseado em dataHoraFimDisputa (YYYY-MM-DD)
   *   status — 'ganha' | 'perdida' | 'pendente' | 'sem-disputa' | '' (todas)
   *   q — busca livre em orgao/objeto/numero
   *   limit — default 500
   */
  app.get('/api/relatorios/participacoes', async (req, res) => {
    try {
      const { dataInicio, dataFim, status, q, limit } = req.query;

      // CNPJ do fornecedor do tenant — discrimina vitórias
      const fornecedor = db.prepare('SELECT cnpj FROM fornecedor LIMIT 1').get();
      const nossoCnpj = fornecedor ? (fornecedor.cnpj || '').replace(/\D/g, '') : '';

      const where = ['p.ativo = 1'];
      const params = [];
      if (dataInicio) { where.push('p.dataHoraFimDisputa >= ?'); params.push(dataInicio + 'T00:00:00'); }
      if (dataFim)    { where.push('p.dataHoraFimDisputa <= ?'); params.push(dataFim + 'T23:59:59'); }
      if (q) {
        where.push('(p.orgao LIKE ? OR p.objeto LIKE ? OR p.numero LIKE ?)');
        const like = `%${q}%`;
        params.push(like, like, like);
      }

      let rows;
      if (USE_PG) {
        // Fase 3g: cross-DB resolvido em 2 passos. Query base só com tenant tables.
        const sqlBase = `
          SELECT
            p.compraId, p.cnpj, p.ano, p.sequencial, p.numero, p.orgao, p.objeto,
            p.modalidade, p.situacao, p.etapa, p.faseCompra, p.homologada,
            p.dataHoraInicioDisputa, p.dataHoraFimDisputa, p.linkPncp, p.urlCompra,
            (SELECT COUNT(*) FROM sniper_historico h WHERE h.compraId = p.compraId AND h.sucesso = 1) AS lances_ok,
            (SELECT COUNT(*) FROM sniper_historico h WHERE h.compraId = p.compraId AND h.sucesso = 0) AS lances_falha,
            (SELECT k.dataAtualizacao FROM kanban_status k
              WHERE k.cnpj = p.cnpj AND k.ano = p.ano AND k.sequencial = p.sequencial AND k.status = 'enviada') AS propostaEnviadaEm
          FROM participacoes_comprasnet p
          WHERE ${where.join(' AND ')}
          ORDER BY COALESCE(p.dataHoraFimDisputa, p.dataCriacao) DESC
          LIMIT ?
        `;
        rows = db.prepare(sqlBase).all(...params, parseInt(limit) || 500);

        // Agrega resultados_bi em PG por (cnpj,ano,sequencial) via VALUES
        if (rows.length > 0) {
          const values = rows.map((_, i) => `($${i*3+2}::text,$${i*3+3}::int,$${i*3+4}::bigint)`).join(',');
          const aggParams = [nossoCnpj];
          for (const r of rows) aggParams.push(String(r.cnpj), Number(r.ano), Number(r.sequencial));
          const agg = await catalogPg.query(`
            WITH keys(cnpj, ano, sequencial) AS (VALUES ${values})
            SELECT k.cnpj, k.ano, k.sequencial,
                   COUNT(DISTINCT r."numeroItem")::int AS itens_homologados,
                   COUNT(DISTINCT r."numeroItem") FILTER (WHERE REPLACE(REPLACE(r."niFornecedor",'.',''),'/','') = $1)::int AS itens_ganhos,
                   COALESCE(SUM(CASE WHEN REPLACE(REPLACE(r."niFornecedor",'.',''),'/','') = $1
                                     THEN r."valorTotalHomologado" ELSE 0 END), 0) AS valor_ganho
              FROM resultados_bi r
              JOIN keys k ON r."cnpj"=k.cnpj AND r."ano"=k.ano AND r."sequencial"=k.sequencial
             GROUP BY k.cnpj, k.ano, k.sequencial
          `, aggParams);
          const aggMap = new Map();
          for (const a of agg) aggMap.set(`${a.cnpj}|${a.ano}|${a.sequencial}`, a);
          rows = rows.map(r => {
            const a = aggMap.get(`${r.cnpj}|${r.ano}|${r.sequencial}`) || {};
            return {
              ...r,
              itens_homologados: a.itens_homologados || 0,
              itens_ganhos: a.itens_ganhos || 0,
              valor_ganho: Number(a.valor_ganho || 0),
            };
          });
        }
      } else {
        const sql = `
          SELECT
            p.compraId, p.cnpj, p.ano, p.sequencial, p.numero, p.orgao, p.objeto,
            p.modalidade, p.situacao, p.etapa, p.faseCompra, p.homologada,
            p.dataHoraInicioDisputa, p.dataHoraFimDisputa, p.linkPncp, p.urlCompra,
            (
              SELECT COUNT(DISTINCT r.numeroItem)
              FROM resultados_bi r
              WHERE r.cnpj = p.cnpj AND r.ano = p.ano AND r.sequencial = p.sequencial
            ) AS itens_homologados,
            (
              SELECT COUNT(DISTINCT r.numeroItem)
              FROM resultados_bi r
              WHERE r.cnpj = p.cnpj AND r.ano = p.ano AND r.sequencial = p.sequencial
                AND REPLACE(REPLACE(r.niFornecedor,'.',''),'/','') = ?
            ) AS itens_ganhos,
            (
              SELECT COALESCE(SUM(r.valorTotalHomologado), 0)
              FROM resultados_bi r
              WHERE r.cnpj = p.cnpj AND r.ano = p.ano AND r.sequencial = p.sequencial
                AND REPLACE(REPLACE(r.niFornecedor,'.',''),'/','') = ?
            ) AS valor_ganho,
            (
              SELECT COUNT(*) FROM sniper_historico h
              WHERE h.compraId = p.compraId AND h.sucesso = 1
            ) AS lances_ok,
            (
              SELECT COUNT(*) FROM sniper_historico h
              WHERE h.compraId = p.compraId AND h.sucesso = 0
            ) AS lances_falha,
            (
              SELECT k.dataAtualizacao FROM kanban_status k
              WHERE k.cnpj = p.cnpj AND k.ano = p.ano AND k.sequencial = p.sequencial
                AND k.status = 'enviada'
            ) AS propostaEnviadaEm
          FROM participacoes_comprasnet p
          WHERE ${where.join(' AND ')}
          ORDER BY COALESCE(p.dataHoraFimDisputa, p.dataCriacao) DESC
          LIMIT ?
        `;
        rows = db.prepare(sql).all(nossoCnpj, nossoCnpj, ...params, parseInt(limit) || 500);
      }

      // Deriva status lógico por linha:
      //   ganha      — homologadas > 0 e ganhamos ≥ 1 item
      //   perdida    — homologadas > 0 e ganhamos 0 itens
      //   pendente   — tem dataHoraFimDisputa mas nenhum item homologado ainda
      //   sem-disputa— sem dataHoraFimDisputa (interesse/cadastrada mas não disputou)
      const agora = new Date();
      const participacoes = rows.map(r => {
        let statusLogico;
        if (r.itens_homologados > 0) {
          statusLogico = r.itens_ganhos > 0 ? 'ganha' : 'perdida';
        } else if (r.dataHoraFimDisputa) {
          const fim = new Date(r.dataHoraFimDisputa);
          statusLogico = fim < agora ? 'pendente' : 'agendada';
        } else {
          statusLogico = 'sem-disputa';
        }
        return { ...r, statusLogico };
      });

      const filtradas = status
        ? participacoes.filter(p => p.statusLogico === status)
        : participacoes;

      // KPIs (sobre o conjunto filtrado por período, ignorando filtro de status)
      const disputadas = participacoes.filter(p => p.statusLogico !== 'sem-disputa' && p.statusLogico !== 'agendada');
      const ganhas = disputadas.filter(p => p.statusLogico === 'ganha');
      const valorTotalGanho = ganhas.reduce((s, p) => s + (Number(p.valor_ganho) || 0), 0);
      const kpis = {
        total: participacoes.length,
        disputadas: disputadas.length,
        ganhas: ganhas.length,
        perdidas: disputadas.filter(p => p.statusLogico === 'perdida').length,
        pendentes: disputadas.filter(p => p.statusLogico === 'pendente').length,
        semDisputa: participacoes.filter(p => p.statusLogico === 'sem-disputa').length,
        taxaVitoria: disputadas.length > 0 ? Math.round((ganhas.length / disputadas.length) * 100) : 0,
        valorTotalGanho,
        ticketMedio: ganhas.length > 0 ? Math.round(valorTotalGanho / ganhas.length) : 0,
      };

      res.json({ success: true, participacoes: filtradas, kpis, nossoCnpj });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/relatorios/participacoes/sincronizar-funil', async (req, res) => {
    try {
      const stats = await sincronizarParticipacoesFunil(db);
      res.json({ success: true, ...stats });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/timeline-lances
   * Linha do tempo unificada: nossos lances + transições do concorrente.
   */
  app.get('/api/timeline-lances', (req, res) => {
    try {
      const { compraId, itemNumero, dataInicio, dataFim, quem } = req.query;
      const diDefault = dataInicio || new Date(Date.now() - 7*86400000 - 3*3600000).toISOString().slice(0,10);
      const eventos = [];

      if (quem !== 'concorrente') {
        let q = `SELECT compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, fonte, timestamp
                 FROM sniper_historico WHERE date(timestamp,'-3 hours') >= ?`;
        const p = [diDefault];
        if (dataFim)    { q += ` AND date(timestamp,'-3 hours') <= ?`; p.push(dataFim); }
        if (compraId)   { q += ' AND compraId = ?'; p.push(compraId); }
        if (itemNumero) { q += ' AND itemNumero = ?'; p.push(Number(itemNumero)); }
        for (const r of db.prepare(q).all(...p)) {
          eventos.push({ quem: 'nosso', timestamp: r.timestamp, compraId: r.compraId, itemNumero: r.itemNumero, valor: r.valor, httpStatus: r.httpStatus, sucesso: r.sucesso, tempoMs: r.tempoMs, fonte: r.fonte });
        }
      }

      if (quem !== 'nosso') {
        let q = `SELECT compraId, itemNumero, melhorGeral, nossoValor, situacao, timestamp
                 FROM sniper_classificacao WHERE date(timestamp,'-3 hours') >= ?`;
        const p = [diDefault];
        if (dataFim)    { q += ` AND date(timestamp,'-3 hours') <= ?`; p.push(dataFim); }
        if (compraId)   { q += ' AND compraId = ?'; p.push(compraId); }
        if (itemNumero) { q += ' AND itemNumero = ?'; p.push(Number(itemNumero)); }
        q += ' ORDER BY timestamp ASC';
        let prev = null;
        for (const r of db.prepare(q).all(...p)) {
          const key = r.compraId + '|' + r.itemNumero;
          if (!prev || prev.key !== key || prev.valor !== r.melhorGeral) {
            eventos.push({ quem: 'concorrente', timestamp: r.timestamp, compraId: r.compraId, itemNumero: r.itemNumero, valor: r.melhorGeral, situacao: r.situacao, nossoValor: r.nossoValor });
            prev = { key, valor: r.melhorGeral };
          }
        }
      }

      // Normaliza timestamps para ISO (alguns antigos vieram sem T / sem ms)
      for (const e of eventos) {
        let t = String(e.timestamp || '').trim();
        if (t.indexOf('T') < 0) t = t.replace(' ', 'T');
        if (!/[Z+\-]\d{2}:?\d{2}$/.test(t) && !t.endsWith('Z')) t += 'Z';
        e.timestamp = t;
      }
      eventos.sort((a,b) => a.timestamp.localeCompare(b.timestamp));
      res.json({ success: true, eventos });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/relatorio-concorrentes
   * Histórico de mudanças do melhor lance geral (guard) com transições de preço.
   */
  app.get('/api/relatorio-concorrentes', (req, res) => {
    try {
      const { compraId, itemNumero, dataInicio, dataFim } = req.query;
      const diDefault = dataInicio || new Date(Date.now() - 7*86400000 - 3*3600000).toISOString().slice(0,10);
      let sql = `SELECT compraId, itemNumero, melhorGeral, nossoValor, situacao, timestamp FROM sniper_classificacao WHERE date(timestamp,'-3 hours') >= ?`;
      const params = [diDefault];
      if (dataFim)    { sql += ` AND date(timestamp,'-3 hours') <= ?`; params.push(dataFim); }
      if (compraId)   { sql += ' AND compraId = ?';   params.push(compraId); }
      if (itemNumero) { sql += ' AND itemNumero = ?'; params.push(Number(itemNumero)); }
      sql += ' ORDER BY timestamp ASC';
      const rows = db.prepare(sql).all(...params);

      const grupos = {};
      for (const r of rows) {
        const k = r.compraId + '|' + r.itemNumero;
        if (!grupos[k]) grupos[k] = { compraId: r.compraId, itemNumero: r.itemNumero, transicoes: [] };
        const t = grupos[k].transicoes;
        const ult = t[t.length - 1];
        if (!ult || ult.melhorGeral !== r.melhorGeral) {
          t.push({ melhorGeral: r.melhorGeral, nossoValor: r.nossoValor, situacao: r.situacao, timestamp: r.timestamp });
        }
      }
      // Filtra grupos com ≥2 transições (movimentação real) e ordena por última transição
      const out = Object.values(grupos)
        .filter(g => g.transicoes.length >= 2)
        .sort((a,b) => (b.transicoes[b.transicoes.length-1].timestamp).localeCompare(a.transicoes[a.transicoes.length-1].timestamp))
        .slice(0, 50);
      res.json({ success: true, grupos: out, totalGruposEncontrados: Object.keys(grupos).length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== ENVIO DE PROPOSTA VIA API ====================

  /**
   * POST /api/proposta/enviar-api
   * Envia proposta diretamente via API Comprasnet usando o Bearer token.
   *
   * Fluxo correto (HAR-verified):
   *  1. GET  .../compras/{compraId}/participacao        → verifica status
   *  2. POST .../compras/{compraId}/participacao        → aceita declarações (se necessário)
   *  3. POST .../compras/{compraId}/itens/{n}/participacao → envia proposta por item
   *
   * Body: {
   *   compraId: string,
   *   itens: [{ numero, valor, quantidade?, marca?, modelo? }],
   *   declaracoes?: { declaracaoMeEpp, declaracaoProgramasIntegridade, declaracaoEquidadeGenero }
   * }
   */
  app.post('/api/proposta/enviar-api', async (req, res) => {
    try {
      const { compraId, itens, declaracoes } = req.body;

      if (!compraId) return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      if (!itens || !Array.isArray(itens) || itens.length === 0) return res.status(400).json({ success: false, error: 'Array de itens obrigatório' });
      if (!sniper.temToken()) return res.status(400).json({ success: false, error: 'Sem Bearer token. Abra o Comprasnet pelo Electron LiciteAgora.' });
      if (sniper.tokenExpirado()) return res.status(400).json({ success: false, error: 'Bearer token expirado. Recarregue o Comprasnet.' });

      // Guard de portal: a API fase-externa só conhece compras do Comprasnet
      // (compras.gov.br). Pra licitações de outros portais (ex: Portal de Compras
      // Públicas) o POST de participação dá 404 "Compra não encontrada". Lookup
      // autoritativo: interesse_compra_id (compraId→PNCP) + catalog (portal de origem).
      // Fail-open: se não der pra determinar o portal, segue o fluxo normal.
      if (USE_PG) {
        try {
          const k = db.prepare('SELECT cnpj, ano, sequencial FROM interesse_compra_id WHERE compraId = ?').get(compraId);
          if (k) {
            const lic = await catalogPg.queryOne(
              `SELECT "linkSistemaOrigem", "usuarioNome" FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3 LIMIT 1`,
              [String(k.cnpj), Number(k.ano), Number(k.sequencial)]
            );
            if (lic && (lic.linkSistemaOrigem || lic.usuarioNome)) {
              const link = String(lic.linkSistemaOrigem || '').toLowerCase();
              const usr = String(lic.usuarioNome || '').toLowerCase();
              const ehComprasnet = /comprasnet|compras\.gov|cnetmobile/.test(link) || usr === 'compras.gov.br';
              if (!ehComprasnet) {
                const portal =
                  (/portaldecompraspublicas/.test(link) || /governan[çc]abrasil/.test(usr)) ? 'Portal de Compras Públicas' :
                  (/licitacoes-e|bb\.com/.test(link) || /licitacoes-e|banco do brasil/.test(usr)) ? 'Licitações-e (Banco do Brasil)' :
                  (/bll\.org|bllcompras|bnccompras/.test(link) || /bll compras|bolsa nacional/.test(usr)) ? 'BLL / BNC' :
                  (/licitardigital/.test(link)) ? 'Licitar Digital' :
                  (lic.usuarioNome || 'outro portal (não Comprasnet)');
                sniper.log(`🚫 Guard portal: ${compraId} é do "${portal}", não Comprasnet — envio bloqueado`);
                return res.status(400).json({
                  success: false,
                  naoComprasnet: true,
                  portalOrigem: portal,
                  error: `Esta licitação é do portal "${portal}", não do Comprasnet. O envio automático por aqui não funciona — envie a proposta diretamente no portal de origem.`,
                });
              }
            }
          }
        } catch (e) {
          sniper.log(`⚠️ Guard portal falhou (segue fluxo): ${e.message}`);
        }
      }

      const basePath = `/comprasnet-fase-externa/v1/compras/${compraId}`;
      const resultados = [];
      let sucessos = 0;
      const delay = ms => new Promise(r => setTimeout(r, ms));

      // Helper: POST/PUT via https nativo (axios causa 400 "Failed to read request" no Comprasnet)
      const https = require('https');
      const rawPost = (method, path, body) => new Promise((resolve) => {
        const bodyStr = JSON.stringify(body);
        const opts = {
          hostname: 'cnetmobile.estaleiro.serpro.gov.br',
          path, method,
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Authorization': sniper.getToken(),
            'x-device-platform': 'web',
            'x-version-number': '6.0.0',
            'Content-Length': Buffer.byteLength(bodyStr),
          },
        };
        const r = https.request(opts, (resp) => {
          let data = '';
          resp.on('data', c => data += c);
          resp.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(data); } catch(e) { parsed = data; }
            resolve({ status: resp.statusCode, data: parsed });
          });
        });
        r.on('error', e => resolve({ status: 0, data: e.message }));
        r.write(bodyStr);
        r.end();
      });

      // --- Passo 1: Verificar estado da compra e garantir participação ---
      // Primeiro GET para saber se já participa e quais declarações a compra exige
      let jaParticipando = false;
      let compraInfo = null;
      try {
        const getResp = await sniper.apiGet(`${basePath}/participacao`);
        sniper.log(`ℹ️ GET participação: HTTP ${getResp.status}`);
        if (getResp.status === 200 && getResp.data && typeof getResp.data === 'object') {
          compraInfo = getResp.data;
          // Só considerar "já participando" se a resposta indicar participação real
          // (itensParticipacao presente, ou situação que implica participação ativa)
          const sit = compraInfo.situacaoCompraFaseExterna;
          jaParticipando = !!(compraInfo.itensParticipacao || sit === 'AB' || sit === 'PE' || sit === 'EN');
          sniper.log(`ℹ️ Compra: situacao=${sit}, fase=${compraInfo.faseCompraFaseExterna}, exigeEquidade=${compraInfo.exigeDeclaracaoEquidadeGenero}, jaParticipando=${jaParticipando}`);
        }
      } catch (e) {
        sniper.log(`⚠️ GET participação erro: ${e.message}`);
      }

      // Montar declarações respeitando exigências e tipos da API Comprasnet
      // declaracaoEquidadeGenero: NÃO aceita boolean! Aceita: null (quando não exigido), "N" (não), 1 (sim)
      const exigeEquidade = compraInfo?.exigeDeclaracaoEquidadeGenero === true;
      const exigeIntegridade = compraInfo?.exigeDeclaracaoProgramasIntegridade === true;
      const declBody = {
        declaracaoMeEpp: declaracoes?.declaracaoMeEpp ?? false,
        declaracaoProgramasIntegridade: declaracoes?.declaracaoProgramasIntegridade ?? false,
        declaracaoEquidadeGenero: exigeEquidade
          ? (declaracoes?.declaracaoEquidadeGenero ? 1 : "N")
          : (declaracoes?.declaracaoEquidadeGenero ? 1 : null),
      };
      sniper.log(`ℹ️ Declarações body: ${JSON.stringify(declBody)} (exigeEquidade=${exigeEquidade}, exigeIntegridade=${exigeIntegridade})`);

      try {
        // POST via https nativo (axios causa 400 no Comprasnet)
        let { status, data } = await rawPost('POST', `${basePath}/participacao`, declBody);
        sniper.log(`ℹ️ POST participação (nativo): HTTP ${status} — ${JSON.stringify(data).substring(0, 300)}`);

        if (status >= 200 && status < 300) {
          resultados.push({ fase: 'declaracoes', sucesso: true, status });
          jaParticipando = true;
        } else if (jaParticipando) {
          // POST falhou mas já participa — tentar PUT
          const putResp = await rawPost('PUT', `${basePath}/participacao`, declBody);
          sniper.log(`ℹ️ PUT participação (nativo): HTTP ${putResp.status} — ${JSON.stringify(putResp.data).substring(0, 300)}`);
          if (putResp.status >= 200 && putResp.status < 300) {
            resultados.push({ fase: 'declaracoes', sucesso: true, status: putResp.status, info: 'Atualizado via PUT' });
          } else {
            // POST e PUT falharam — propagar o erro real, não mascarar como sucesso
            const erroMsg = JSON.stringify(putResp.data || data).substring(0, 300);
            resultados.push({ fase: 'declaracoes', sucesso: false, status: putResp.status || status, erro: erroMsg });
            jaParticipando = false;
          }
        } else {
          resultados.push({ fase: 'declaracoes', sucesso: false, status, erro: JSON.stringify(data).substring(0, 300) });
        }
        await delay(1500);
      } catch (e) {
        resultados.push({ fase: 'declaracoes', sucesso: false, erro: e.message });
      }

      // --- Passo 2: GET itens para inicializar participação (fluxo igual ao Comprasnet web) ---
      try {
        const getItensResp = sniper.temCaptcha()
          ? await sniper.apiGetCaptcha(`${basePath}/itens/aguardando-abertura-sessao-publica`)
          : await sniper.apiGet(`${basePath}/itens/aguardando-abertura-sessao-publica`);
        sniper.log(`ℹ️ GET itens aguardando: HTTP ${getItensResp.status} (${Array.isArray(getItensResp.data) ? getItensResp.data.length + ' itens' : 'não-array'})`);
        await delay(500);
      } catch (e) {
        sniper.log(`⚠️ GET itens aguardando falhou: ${e.message}`);
      }

      // --- Passo 3: Enviar proposta item a item ---
      for (const item of itens) {
        if (!item.numero || !item.valor || item.valor <= 0) {
          resultados.push({ numero: item.numero, sucesso: false, erro: 'Valor inválido' });
          continue;
        }

        // quantidadeOfertada deve ser número (Jackson rejeita string → 400 "Failed to read request").
        // Frontend geralmente passa string vinda do GET itens da Comprasnet (ex.: "1.0000");
        // converter pra Number antes do JSON.stringify.
        const qtdNum = parseFloat(item.quantidade);
        const itemBody = {
          quantidadeOfertada: Number.isFinite(qtdNum) && qtdNum > 0 ? qtdNum : 1,
          valor: parseFloat(item.valor),
          marcaFabricante: item.marca || null,
          modeloVersao: item.modelo || null,
          codigoPaisOrigemItem: null,
          propostaTrabalhoMre: null,
          declaracoesMargemPreferencia: null,
          declaracaoConteudoNacional: false,
          modificado: true,
        };
        sniper.log(`ℹ️ Item ${item.numero} body: ${JSON.stringify(itemBody)}`);

        const itemPath = `${basePath}/itens/${item.numero}/participacao`;
        try {
          // POST via https nativo
          let { status, data } = await rawPost('POST', itemPath, itemBody);
          sniper.log(`ℹ️ POST item ${item.numero}: HTTP ${status}`);

          // Se 500, tentar PUT
          if (status === 500) {
            await delay(1000);
            ({ status, data } = await rawPost('PUT', itemPath, itemBody));
            sniper.log(`ℹ️ PUT item ${item.numero}: HTTP ${status}`);
          }

          if (status >= 200 && status < 300) {
            resultados.push({ numero: item.numero, sucesso: true, status });
            sucessos++;
            sniper.log(`✅ Item ${item.numero}: R$ ${item.valor} (HTTP ${status})`);
          } else {
            const erro = typeof data === 'string' ? data.substring(0, 500) : JSON.stringify(data).substring(0, 500);
            resultados.push({ numero: item.numero, sucesso: false, status, erro });
            sniper.log(`❌ Item ${item.numero}: HTTP ${status} — ${erro}`);
          }
        } catch (e) {
          resultados.push({ numero: item.numero, sucesso: false, erro: e.message });
        }

        await delay(1500);
      }

      // Salvar status e valores no banco apenas se houve sucesso
      if (sucessos > 0) {
        // Resolve cnpj/ano/sequencial do compraId — usado pra UPSERT em
        // participacoes_comprasnet (Fix A: garante linha mesmo se a licitação
        // veio só do PNCP/interesse e nunca foi visitada pela extensão), além
        // de valores_proposta e kanban_status.
        let participacao = null;
        try {
          participacao = db.prepare(
            'SELECT cnpj, ano, sequencial FROM participacoes_comprasnet WHERE compraId = ?'
          ).get(compraId);
        } catch (e) {}
        if (!participacao) {
          try {
            participacao = db.prepare(
              'SELECT cnpj, ano, sequencial FROM interesse_compra_id WHERE compraId = ?'
            ).get(compraId);
          } catch (e) {}
        }

        // UPSERT em participacoes_comprasnet. Antes só fazia UPDATE: se a linha
        // não existisse (caso comum: licitação veio do PNCP e foi enviada via
        // API sem visita prévia pela extensão), o UPDATE retornava 0 linhas
        // silenciosamente, e o card continuava como "🟡 A enviar" pra sempre.
        try {
          // Tenta UPDATE primeiro. Se não afetar linha, faz INSERT com dados
          // enriquecidos do PNCP (licitacoes) quando cnpj/ano/sequencial conhecidos.
          const upd = db.prepare(`UPDATE participacoes_comprasnet
            SET situacao = 'PE', propostaEnviadaEm = CURRENT_TIMESTAMP, dataAtualizacao = CURRENT_TIMESTAMP
            WHERE compraId = ?`).run(compraId);
          if (upd.changes === 0 && participacao) {
            // Enriquece com dados da licitação PNCP se disponível
            let lic = null;
            try {
              if (USE_PG) {
                lic = await catalogPg.queryOne(
                  `SELECT "numeroCompra" AS "numeroCompra", "modalidadeNome" AS "modalidadeNome",
                          "razaoSocial" AS orgao, "objetoCompra" AS "objetoCompra",
                          "linkSistemaOrigem" AS "linkSistemaOrigem",
                          "dataEncerramentoProposta" AS "dataEncerramentoProposta",
                          "codigoUnidade" AS "codigoUnidade"
                     FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3 LIMIT 1`,
                  [participacao.cnpj, participacao.ano, participacao.sequencial]
                );
              } else {
                lic = db.prepare(`SELECT numeroCompra, modalidadeNome, razaoSocial AS orgao, objetoCompra, linkSistemaOrigem, dataEncerramentoProposta, codigoUnidade
                  FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ? LIMIT 1`)
                  .get(participacao.cnpj, participacao.ano, participacao.sequencial);
              }
            } catch (_) {}
            db.prepare(`INSERT INTO participacoes_comprasnet
              (compraId, cnpj, codigoUnidade, ano, sequencial, tipo, numero, orgao, objeto,
               etapa, situacao, urlCompra, dataSessao, propostaEnviadaEm, ativo, dataAtualizacao)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'PE', ?, ?, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`)
              .run(
                compraId, participacao.cnpj, lic?.codigoUnidade || '',
                participacao.ano, participacao.sequencial,
                lic?.modalidadeNome || '', lic?.numeroCompra || '',
                lic?.orgao || '', lic?.objetoCompra || '',
                lic?.linkSistemaOrigem || '',
                lic?.dataEncerramentoProposta || ''
              );
            console.log(`[PROPOSTA-API] participacoes_comprasnet INSERT pra ${compraId} (não existia antes)`);
          }
        } catch (e) {
          console.warn('[PROPOSTA-API] upsert participacoes_comprasnet:', e.message);
        }

        // Salvar valores enviados (marca, modelo, etc.) em valores_proposta
        if (participacao) {
          try {
            const stmtVP = db.prepare(`
              INSERT OR REPLACE INTO valores_proposta
              (cnpj, ano, sequencial, numeroItem, valorUnitario, marca, modelo, fabricante, selecionado, dataAtualizacao)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
            `);
            for (const r of resultados) {
              if (r.sucesso && r.numero) {
                const item = itens.find(i => i.numero === r.numero);
                if (item) {
                  stmtVP.run(
                    participacao.cnpj, participacao.ano, participacao.sequencial,
                    item.numero, item.valor, item.marca || null, item.modelo || null, null
                  );
                }
              }
            }
          } catch (e) {
            console.warn('[PROPOSTA-API] Erro ao salvar valores_proposta:', e.message);
          }

          // Atualiza kanban_status → 'enviada' (mesmo status usado pelo fluxo
          // via extensão). Faz a /licitacoes/agenda.html mostrar "Proposta
          // enviada" pra licitações cuja proposta foi mandada pela API.
          // Idempotente: INSERT OR IGNORE garante a linha, depois UPDATE.
          try {
            db.prepare(`
              INSERT OR IGNORE INTO kanban_status (cnpj, ano, sequencial, status, dataAtualizacao)
              VALUES (?, ?, ?, 'enviada', CURRENT_TIMESTAMP)
            `).run(participacao.cnpj, participacao.ano, participacao.sequencial);
            db.prepare(`
              UPDATE kanban_status
                 SET status = 'enviada',
                     observacao = 'Proposta enviada via API Comprasnet',
                     dataAtualizacao = CURRENT_TIMESTAMP
               WHERE cnpj = ? AND ano = ? AND sequencial = ?
            `).run(participacao.cnpj, participacao.ano, participacao.sequencial);
            console.log(`[PROPOSTA-API] kanban_status → 'enviada' para ${participacao.cnpj}/${participacao.ano}/${participacao.sequencial}`);
          } catch (e) {
            console.warn('[PROPOSTA-API] Erro ao atualizar kanban_status:', e.message);
          }
        } else {
          console.warn(`[PROPOSTA-API] compraId ${compraId} não mapeado em participacoes_comprasnet nem interesse_compra_id — agenda não será atualizada`);
        }
      }

      console.log(`[PROPOSTA-API] ${compraId}: ${sucessos}/${itens.length} OK`);

      res.json({
        success: sucessos > 0,
        message: `${sucessos} de ${itens.length} itens enviados com sucesso`,
        compraId, sucessos, total: itens.length, resultados
      });

    } catch (error) {
      console.error('[PROPOSTA-API] Erro:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * DELETE /api/proposta/excluir/:compraId
   * Exclui participação e todas as propostas de itens da compra.
   * Endpoint Comprasnet: DELETE /comprasnet-fase-externa/v1/compras/{compraId}/participacao
   */
  app.delete('/api/proposta/excluir/:compraId', async (req, res) => {
    try {
      const { compraId } = req.params;
      if (!sniper.temToken()) return res.status(400).json({ success: false, error: 'Sem Bearer token.' });
      if (sniper.tokenExpirado()) return res.status(400).json({ success: false, error: 'Bearer token expirado.' });

      const basePath = `/comprasnet-fase-externa/v1/compras/${compraId}`;

      // DELETE via https nativo (mesmo padrão do enviar-api)
      const https = require('https');
      const result = await new Promise((resolve) => {
        const opts = {
          hostname: 'cnetmobile.estaleiro.serpro.gov.br',
          path: `${basePath}/participacao`,
          method: 'DELETE',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Authorization': sniper.getToken(),
            'x-device-platform': 'web',
            'x-version-number': '6.0.0',
          },
        };
        const r = https.request(opts, (resp) => {
          let data = '';
          resp.on('data', c => data += c);
          resp.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(data); } catch(e) { parsed = data; }
            resolve({ status: resp.statusCode, data: parsed });
          });
        });
        r.on('error', e => resolve({ status: 0, data: e.message }));
        r.end();
      });

      sniper.log(`🗑️ DELETE participação ${compraId}: HTTP ${result.status}`);

      if (result.status >= 200 && result.status < 300) {
        // Atualizar banco local
        try {
          db.prepare(`UPDATE participacoes_comprasnet SET situacao = 'EX', propostaEnviadaEm = NULL, dataAtualizacao = CURRENT_TIMESTAMP WHERE compraId = ?`).run(compraId);
        } catch (e) {}

        console.log(`[PROPOSTA-API] DELETE ${compraId}: OK`);
        res.json({
          success: true,
          message: `Participação excluída. isFornecedorParticipante: ${result.data?.isFornecedorParticipante}`,
        });
      } else {
        const erro = typeof result.data === 'string' ? result.data : JSON.stringify(result.data).substring(0, 500);
        console.log(`[PROPOSTA-API] DELETE ${compraId}: FALHA HTTP ${result.status}`);
        res.json({ success: false, error: `HTTP ${result.status}: ${erro}` });
      }
    } catch (error) {
      console.error('[PROPOSTA-API] DELETE erro:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/proposta/diagnostico/:compraId
   * Diagnóstico completo: testa cada chamada à API Comprasnet e retorna resultados.
   */
  app.get('/api/proposta/diagnostico/:compraId', async (req, res) => {
    const https = require('https');
    const { compraId } = req.params;
    const token = sniper.getToken();
    const diag = { token: !!token };

    if (!token) return res.json({ success: false, error: 'Sem token', diagnostico: diag });

    // Helper: request via Node https nativo (bypass axios)
    const rawRequest = (method, path, body) => new Promise((resolve) => {
      const bodyStr = body ? JSON.stringify(body) : null;
      const opts = {
        hostname: 'cnetmobile.estaleiro.serpro.gov.br',
        path,
        method,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'Authorization': token,
          'x-device-platform': 'web',
          'x-version-number': '6.0.0',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      };
      const r = https.request(opts, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => resolve({ status: resp.statusCode, data: data.substring(0, 1000) }));
      });
      r.on('error', e => resolve({ status: 0, error: e.message }));
      if (bodyStr) r.write(bodyStr);
      r.end();
    });

    const delay = ms => new Promise(r => setTimeout(r, ms));
    const basePath = `/comprasnet-fase-externa/v1/compras/${compraId}`;

    // 1. GET participacao
    diag['1_GET'] = await rawRequest('GET', `${basePath}/participacao`);
    // Parse flags do GET completo (não do truncado)
    let compraFull = {};
    try {
      const fullGet = await rawRequest('GET', `${basePath}/participacao`);
      compraFull = typeof fullGet.data === 'string' ? JSON.parse(fullGet.data) : fullGet.data;
    } catch(e) {}
    diag.exigeEquidade = compraFull.exigeDeclaracaoEquidadeGenero;
    diag.exigeIntegridade = compraFull.exigeDeclaracaoProgramasIntegridade;

    // Testar tipos para declaracaoEquidadeGenero (boolean causa 400)
    const base = { declaracaoMeEpp: true, declaracaoProgramasIntegridade: true };
    const tests = {
      'A_string_S': { ...base, declaracaoEquidadeGenero: "S" },
      'B_string_N': { ...base, declaracaoEquidadeGenero: "N" },
      'C_string_true': { ...base, declaracaoEquidadeGenero: "true" },
      'D_number_1': { ...base, declaracaoEquidadeGenero: 1 },
      'E_object': { ...base, declaracaoEquidadeGenero: { valor: true } },
    };

    for (const [label, body] of Object.entries(tests)) {
      await delay(2000);
      const r = await rawRequest('POST', `${basePath}/participacao`, body);
      diag[label] = { status: r.status, body: JSON.stringify(body), resp: typeof r.data === 'string' ? r.data.substring(0, 250) : JSON.stringify(r.data).substring(0, 250) };
    }

    res.json({ success: true, compraId, diagnostico: diag });
  });

  /**
   * POST /api/proposta/backfill-chave-pncp
   * Busca chaveCompraPncp via API para participações que não a têm.
   * Foca nos interesses sem compraId — busca nas participações por CNPJ/objeto.
   * Requer Bearer token ativo.
   */
  app.post('/api/proposta/backfill-chave-pncp', async (req, res) => {
    try {
      if (!sniper.temToken()) {
        return res.status(400).json({ success: false, error: 'Sem Bearer token' });
      }

      // Buscar participações sem chaveCompraPncp
      const semChave = db.prepare(`
        SELECT compraId FROM participacoes_comprasnet
        WHERE (chaveCompraPncp IS NULL OR chaveCompraPncp = '') AND ativo = 1
        ORDER BY dataAtualizacao DESC
      `).all();

      let atualizados = 0;
      let erros = 0;
      const maxRequests = Math.min(semChave.length, 50); // Limitar para não gastar rate limit

      for (let i = 0; i < maxRequests; i++) {
        const { compraId } = semChave[i];
        try {
          const { status, data } = await sniper.apiGet(
            `/comprasnet-fase-externa/v1/compras/${compraId}/participacao`
          );
          if (status === 200 && data && data.chaveCompraPncp) {
            db.prepare(`UPDATE participacoes_comprasnet SET chaveCompraPncp = ? WHERE compraId = ?`)
              .run(data.chaveCompraPncp, compraId);
            atualizados++;
          } else if (status === 401 || status === 403 || status === 429) {
            break; // Parar se rate limited ou sem acesso
          }
        } catch (e) {
          erros++;
        }
      }

      console.log(`[BACKFILL] ${atualizados}/${maxRequests} chaveCompraPncp atualizadas (${erros} erros)`);
      res.json({ success: true, atualizados, total: semChave.length, processados: maxRequests, erros });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/proposta/participar-e-listar/:compraId
   * Aceita declarações de participação e depois lista itens via fase-externa.
   * Resolve o 401 em compras na fase de propostas onde o fornecedor ainda não participou.
   *
   * Body (opcional): { declaracaoMeEpp?, declaracaoProgramasIntegridade?, declaracaoEquidadeGenero? }
   */
  app.post('/api/proposta/participar-e-listar/:compraId', async (req, res) => {
    try {
      const { compraId } = req.params;
      if (!sniper.temToken()) {
        return res.status(400).json({ success: false, error: 'Sem Bearer token' });
      }
      if (sniper.tokenExpirado()) {
        return res.status(400).json({ success: false, error: 'Bearer token expirado' });
      }

      const basePath = `/comprasnet-fase-externa/v1/compras/${compraId}`;
      const etapas = [];

      // Passo 1: Verificar participação
      let jaParticipando = false;
      try {
        const { status, data } = await sniper.apiGet(`${basePath}/participacao`);
        etapas.push({ etapa: 'verificar', status, jaParticipando: status === 200 });
        if (status === 200 && data) {
          jaParticipando = true;
          const preview = typeof data === 'string' ? data.substring(0, 500) : JSON.stringify(data).substring(0, 500);
          etapas[etapas.length - 1].body = preview;
        }
      } catch (e) {
        etapas.push({ etapa: 'verificar', erro: e.message });
      }

      // Passo 2: Aceitar declarações se necessário
      if (!jaParticipando) {
        // Verificar se compra exige equidade (da resposta do GET)
        const compraData = etapas[0]?.body ? (() => { try { return JSON.parse(etapas[0].body); } catch(e) { return null; } })() : null;
        const exigeEquidade = compraData?.exigeDeclaracaoEquidadeGenero === true;
        const declBody = {
          declaracaoMeEpp: req.body?.declaracaoMeEpp ?? false,
          declaracaoProgramasIntegridade: req.body?.declaracaoProgramasIntegridade ?? false,
          declaracaoEquidadeGenero: exigeEquidade
            ? (req.body?.declaracaoEquidadeGenero ? 1 : "N")
            : (req.body?.declaracaoEquidadeGenero ? 1 : null),
        };
        try {
          const { status, data } = await sniper.apiPost(`${basePath}/participacao`, declBody);
          etapas.push({ etapa: 'participar', status, sucesso: status >= 200 && status < 300 });
          if (status < 200 || status >= 300) {
            const erro = typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300);
            return res.json({
              success: false,
              error: `Não foi possível aceitar participação (HTTP ${status}): ${erro}`,
              etapas
            });
          }
        } catch (e) {
          etapas.push({ etapa: 'participar', erro: e.message });
          return res.json({ success: false, error: `Erro ao participar: ${e.message}`, etapas });
        }
      }

      // Passo 3: Listar itens via fase-externa (vários paths possíveis)
      const endpointsItens = [
        `${basePath}/itens?situacoes=1,2,3,4`,
        `${basePath}/itens?situacoes=PD,AB,EN`,
        `${basePath}/itens/em-selecao-fornecedores`,
      ];

      // Passo 3b: Se nenhum endpoint de lista funcionar, tentar itens individuais (1..20)
      let tentarItensIndividuais = true;

      for (const path of endpointsItens) {
        try {
          const { status, data } = await sniper.apiGet(path);
          const bodyPreview = typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300);
          etapas.push({ etapa: 'listar-itens', path: path.split('/v1/')[1], status, body: bodyPreview });

          if ((status === 200 || status === 206) && data) {
            const arr = Array.isArray(data) ? data : (data.itens || data.content || []);
            if (arr.length > 0) {
              const itens = arr.map(i => ({
                numero: i.numero || i.identificador || i.sequencialItem,
                descricao: (i.descricao || i.objetoItem || i.descricaoDetalhada || '').substring(0, 300),
                quantidade: i.quantidadeEstimada || i.quantidadeOfertada || i.quantidade || 1,
                unidadeMedida: i.unidadeMedida || i.siglaUnidadeMedida || '',
                valorEstimado: i.valorEstimadoUnitario || i.valorEstimado || i.valorUnitarioEstimado || null,
                valorTotal: i.valorTotalEstimado || null,
                situacao: i.situacao || i.situacaoItem || '',
                criterioJulgamento: i.criterioJulgamento || '',
              }));

              console.log(`[PARTICIPAR-E-LISTAR] ${compraId}: ${itens.length} itens encontrados via ${path.split('/v1/')[1]}`);
              return res.json({ success: true, compraId, itens, etapas });
            }
          }
        } catch (e) {
          etapas.push({ etapa: 'listar-itens', path: path.split('/v1/')[1], erro: e.message });
        }
      }

      // Se fase-externa não retornou, tentar disputa como fallback
      try {
        const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${compraId}/itens`);
        etapas.push({ etapa: 'listar-itens-disputa', status });
        if ((status === 200 || status === 206) && Array.isArray(data) && data.length > 0) {
          const itens = data.map(i => ({
            numero: i.numero || i.identificador,
            descricao: (i.descricao || i.objetoItem || '').substring(0, 300),
            quantidade: i.quantidadeEstimada || i.quantidade || 1,
            unidadeMedida: i.unidadeMedida || '',
            valorEstimado: i.valorEstimadoUnitario || i.valorEstimado || null,
            situacao: i.situacao || i.fase || '',
          }));
          return res.json({ success: true, compraId, itens, etapas, fonte: 'disputa' });
        }
      } catch (e) {
        etapas.push({ etapa: 'listar-itens-disputa', erro: e.message });
      }

      // Passo 3c: Tentar buscar itens individuais (GET .../itens/1, .../itens/2, etc.)
      // Útil quando nenhum endpoint de lista retorna itens (compras na fase PD)
      const itensIndividuais = [];
      for (let n = 1; n <= 30; n++) {
        try {
          const { status, data } = await sniper.apiGet(`${basePath}/itens/${n}/participacao`);
          if (status === 200 && data) {
            itensIndividuais.push({
              numero: data.numero || data.identificador || n,
              descricao: (data.descricao || data.objetoItem || data.descricaoDetalhada || `Item ${n}`).substring(0, 300),
              quantidade: data.quantidadeEstimada || data.quantidadeSolicitada || data.quantidade || 1,
              unidadeMedida: data.unidadeMedida || data.siglaUnidadeMedida || '',
              valorEstimado: data.valorEstimadoUnitario || data.valorEstimado || data.valor || null,
              situacao: data.situacao || data.situacaoItem || '',
              criterioJulgamento: data.criterioJulgamento || '',
              _raw: typeof data === 'object' ? JSON.stringify(data).substring(0, 1500) : '',
            });
          } else if (status === 404 || status === 400) {
            // Não existe mais itens
            break;
          }
          // 401/403/429 = parar para não gastar rate limit
          if (status === 401 || status === 403 || status === 429) break;
        } catch (e) {
          break;
        }
      }

      if (itensIndividuais.length > 0) {
        etapas.push({ etapa: 'itens-individuais', total: itensIndividuais.length });
        console.log(`[PARTICIPAR-E-LISTAR] ${compraId}: ${itensIndividuais.length} itens encontrados via busca individual`);
        return res.json({ success: true, compraId, itens: itensIndividuais, etapas, fonte: 'individual' });
      }

      res.json({ success: false, error: 'Participação aceita mas não foi possível listar itens', etapas });

    } catch (error) {
      console.error('[PARTICIPAR-E-LISTAR] Erro:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/proposta/valores-compra/:compraId
   * Retorna valores salvos em valores_proposta para um compraId (marca, modelo, valor).
   */
  app.get('/api/proposta/valores-compra/:compraId', (req, res) => {
    try {
      const { compraId } = req.params;
      const participacao = db.prepare(
        'SELECT cnpj, ano, sequencial FROM participacoes_comprasnet WHERE compraId = ?'
      ).get(compraId);
      if (!participacao) return res.json({ success: true, valores: {} });

      const rows = db.prepare(`
        SELECT numeroItem, valorUnitario, marca, modelo, fabricante, selecionado
        FROM valores_proposta
        WHERE cnpj = ? AND ano = ? AND sequencial = ?
      `).all(participacao.cnpj, participacao.ano, participacao.sequencial);

      const valores = {};
      for (const v of rows) {
        valores[v.numeroItem] = {
          valor: v.valorUnitario, marca: v.marca || '', modelo: v.modelo || '',
          fabricante: v.fabricante || '', selecionado: v.selecionado === 1,
        };
      }
      res.json({ success: true, valores });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/proposta/itens-compra/:compraId
   * Busca itens de uma compra via API Comprasnet (usando bearer token do servidor).
   * Tenta vários endpoints por fase.
   */
  app.get('/api/proposta/itens-compra/:compraId', async (req, res) => {
    try {
      const { compraId } = req.params;
      if (!sniper.temToken()) {
        return res.status(400).json({ success: false, error: 'Sem Bearer token' });
      }

      // Primeiro, verificar cache de disputas
      const cached = disputasCache.disputas.find(d => d.compraId === compraId);
      if (cached && cached.itens?.length > 0) {
        return res.json({
          success: true,
          fonte: 'cache',
          compraId,
          itens: cached.itens,
          totalItens: cached.totalItens,
          orgao: cached.orgao,
          objeto: cached.objeto,
        });
      }

      // Sem cache — tentar via API
      const result = await sniper.consultarItens(compraId);
      if (!result.success) {
        return res.status(404).json({ success: false, error: 'Não foi possível obter itens' });
      }

      const itens = result.itens.map(i => ({
        numero: i.numero || i.identificador,
        descricao: (i.descricao || '').substring(0, 200),
        fase: i.fase || '',
        situacao: i.situacao || '',
        melhorValor: i.melhorValorGeral?.valorInformado || null,
        nossoValor: i.melhorValorFornecedor?.valorInformado || null,
        valorEstimado: i.valorEstimado || null,
        situacaoParticipante: i.situacaoParticipanteDisputa || null,
        variacaoMinima: i.variacaoMinimaEntreLances || null,
        podeEnviar: i.podeEnviarLances || false,
        fimContagem: i.dataHoraFimContagem || null,
        quantidade: i.quantidade || 1,
        unidadeMedida: i.unidadeMedida || 'UN',
      }));

      res.json({
        success: true,
        fonte: 'api',
        compraId,
        endpoint: result.endpoint,
        itens,
        totalItens: itens.length,
      });

    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== LANCE DIRETO (via extensão/Electron) ====================
  // Puppeteer server-side removido em 2026-04-22. Lances são sempre
  // enfileirados e executados pelo Electron Standalone (webview Comprasnet).

  async function executarLanceDireto(compraId, itemNumero, valor, faseItem, fonte) {
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const lance = {
      id, compraId, itemNumero: parseInt(itemNumero),
      valor: parseFloat(valor), faseItem: faseItem || 'LA',
      criadoEm: new Date().toISOString(), status: 'pendente',
      fonte: fonte || 'browser',
    };
    sniper.filaLances.push(lance);
    return { direto: false, lanceId: id };
  }

  // ==================== TESTE DE CONEXÃO ====================

  /**
   * GET /api/conexao/status
   * Retorna status completo de todas as conexões: servidor, extensão, bearer, Comprasnet.
   */
  app.get('/api/conexao/status', (req, res) => {
    try {
      const sniperStatus = sniper.getStatus();
      const extensaoConectada = !!(ultimoSyncExtensao && (Date.now() - ultimoSyncExtensao) < 5 * 60 * 1000);
      res.json({
        success: true,
        servidor: { online: true, timestamp: new Date().toISOString() },
        extensao: {
          conectada: extensaoConectada,
          ultimoSync: ultimoSyncExtensao ? new Date(ultimoSyncExtensao).toISOString() : null,
          idadeSegundos: ultimoSyncExtensao ? Math.floor((Date.now() - ultimoSyncExtensao) / 1000) : null,
        },
        bearer: {
          presente: sniperStatus.temToken,
          fonte: sniperStatus.tokenSource,
          idade: sniperStatus.tokenIdade,
          idadeSegundos: sniperStatus.tokenIdadeSegundos,
          expirado: sniperStatus.tokenExpirado,
          recebidoEm: sniperStatus.tokenRecebidoEm,
        },
        captcha: {
          presente: sniperStatus.temCaptcha,
          idade: sniperStatus.captchaIdade,
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * POST /api/conexao/testar-comprasnet
   * Testa a conectividade real com o Comprasnet fazendo um GET /datahorabrasilia.
   * Opcionalmente testa GET participação de uma compra específica.
   * Body: { compraId?: string }
   */
  app.post('/api/conexao/testar-comprasnet', async (req, res) => {
    try {
      if (!sniper.temToken()) {
        return res.json({ success: false, erro: 'sem_bearer', mensagem: 'Sem Bearer token. Abra o Comprasnet pelo Electron LiciteAgora.' });
      }
      if (sniper.tokenExpirado()) {
        return res.json({ success: false, erro: 'bearer_expirado', mensagem: 'Bearer token expirado. Recarregue o Comprasnet.' });
      }

      const testes = [];

      // Teste 1: GET /datahorabrasilia (não requer captcha)
      try {
        const inicio = Date.now();
        const { status, data } = await sniper.apiGet('/comprasnet-disputa/v1/datahorabrasilia');
        const tempoMs = Date.now() - inicio;
        testes.push({
          nome: 'Data/Hora Brasília',
          endpoint: '/comprasnet-disputa/v1/datahorabrasilia',
          status,
          sucesso: status === 200,
          tempoMs,
          resposta: status === 200 ? data : null,
        });
      } catch (e) {
        testes.push({ nome: 'Data/Hora Brasília', sucesso: false, erro: e.message });
      }

      // Teste 2: Se compraId fornecido, testa GET participação
      const { compraId } = req.body || {};
      if (compraId) {
        try {
          const inicio = Date.now();
          const path = `/comprasnet-fase-externa/v1/compras/${compraId}/participacao`;
          const { status, data } = await sniper.apiGet(path);
          const tempoMs = Date.now() - inicio;
          const resumo = status === 200 && data
            ? { situacao: data.situacaoCompraFaseExterna, fase: data.faseCompraFaseExterna, itens: data.itensParticipacao?.length }
            : null;
          testes.push({
            nome: `Participação (${compraId})`,
            endpoint: path,
            status,
            sucesso: status === 200,
            tempoMs,
            resumo,
            erro: status !== 200 ? (typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200)) : null,
          });
        } catch (e) {
          testes.push({ nome: `Participação (${compraId})`, sucesso: false, erro: e.message });
        }
      }

      const todosSucesso = testes.every(t => t.sucesso);
      res.json({
        success: true,
        conectado: todosSucesso,
        bearerIdade: sniper.idadeTokenSegundos() + 's',
        testes,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== FILA DE TAREFAS GENÉRICA ====================

  /**
   * POST /api/tarefas/criar
   * Cria uma tarefa na fila para o Electron executar no webview Comprasnet.
   * Body: { tipo: 'testar-conexao'|'testar-participacao'|'enviar-proposta', dados: {...} }
   */
  app.post('/api/tarefas/criar', (req, res) => {
    try {
      const { tipo, dados } = req.body;
      if (!tipo) return res.status(400).json({ success: false, error: 'tipo obrigatório' });

      const tiposValidos = ['testar-conexao', 'testar-participacao', 'enviar-proposta'];
      if (!tiposValidos.includes(tipo)) {
        return res.status(400).json({ success: false, error: `Tipo inválido. Válidos: ${tiposValidos.join(', ')}` });
      }

      const tarefa = {
        id: ++sniper.tarefaIdCounter,
        tipo,
        dados: dados || {},
        status: 'pendente',
        criadoEm: new Date().toISOString(),
        processadoEm: null,
        resultado: null,
      };
      sniper.filaTarefas.push(tarefa);

      // Limpar tarefas antigas (> 5 min, já concluídas/falhas)
      const cincoMinAtras = Date.now() - 5 * 60 * 1000;
      sniper.filaTarefas = sniper.filaTarefas.filter(t =>
        t.status === 'pendente' || t.status === 'processando' ||
        new Date(t.criadoEm).getTime() > cincoMinAtras
      );

      console.log(`[Tarefas] Criada tarefa #${tarefa.id} tipo=${tipo}`);
      res.json({ success: true, id: tarefa.id, status: 'pendente' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/tarefas/pendentes
   * Extensão busca tarefas pendentes (como fila-lances).
   * Marca como 'processando' ao entregar. Cleanup por TTL também aqui — se não houver
   * POST /criar por muito tempo, esta rota ainda limpa tarefas antigas.
   */
  app.get('/api/tarefas/pendentes', (req, res) => {
    const agora = Date.now();
    const TTL_PROCESSANDO_MS = 2 * 60 * 1000;   // 2min stuck = perdida
    const TTL_CONCLUIDA_MS   = 5 * 60 * 1000;   // 5min após concluída

    // Descartar tarefas stuck em 'processando' ou já terminadas há tempo
    sniper.filaTarefas = sniper.filaTarefas.filter(t => {
      if (t.status === 'pendente') return true;
      if (t.status === 'processando') {
        const idade = agora - new Date(t.criadoEm).getTime();
        return idade < TTL_PROCESSANDO_MS;
      }
      // concluida | falha
      const idade = agora - new Date(t.processadoEm || t.criadoEm).getTime();
      return idade < TTL_CONCLUIDA_MS;
    });

    const pendentes = sniper.filaTarefas.filter(t => t.status === 'pendente');
    pendentes.forEach(t => { t.status = 'processando'; });
    res.json({ success: true, tarefas: pendentes, total: sniper.filaTarefas.length });
  });

  /**
   * POST /api/tarefas/resultado
   * Extensão reporta resultado de uma tarefa.
   * Body: { id, sucesso, resultado, erro, tempoMs }
   */
  app.post('/api/tarefas/resultado', (req, res) => {
    try {
      const { id, sucesso, resultado, erro, tempoMs } = req.body;
      const tarefa = sniper.filaTarefas.find(t => t.id === id);
      if (!tarefa) return res.status(404).json({ success: false, error: 'Tarefa não encontrada' });

      tarefa.status = sucesso ? 'concluida' : 'falha';
      tarefa.resultado = resultado || null;
      tarefa.erro = erro || null;
      tarefa.tempoMs = tempoMs || null;
      tarefa.processadoEm = new Date().toISOString();

      console.log(`[Tarefas] Resultado tarefa #${id}: ${tarefa.status} (${tempoMs}ms)`);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /**
   * GET /api/tarefas/:id
   * Página consulta resultado de uma tarefa.
   */
  app.get('/api/tarefas/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const tarefa = sniper.filaTarefas.find(t => t.id === id);
    if (!tarefa) return res.status(404).json({ success: false, error: 'Tarefa não encontrada' });
    res.json({ success: true, tarefa });
  });

  // ==================== HEALTH CHECK PERIÓDICO DO TOKEN ====================

  const HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutos

  setInterval(async () => {
    if (!sniper.temToken() || sniper.tokenExpirado()) return;

    try {
      const validation = await sniper.validateToken(sniper.bearerToken);
      if (!validation.valid && !validation.cached) {
        sniper.log(`💀 Health check: token inválido (HTTP ${validation.status}) — marcando expirado`);
        sniper.forceExpireToken();
        // Limpar cache de validação para que o próximo token não seja cached
        sniper._lastValidatedToken = null;
        sniper._lastValidatedAt = null;
      }
    } catch (e) {
      sniper.log(`⚠️ Health check erro: ${e.message}`);
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  sniper.log('🏥 Health check de token ativado (a cada 2 min)');

  // ===== Recuperação de blitz agendadas após restart =====
  // NÃO roda em boot — o `db` aqui é o Proxy sem contexto de tenant.
  // A recovery é disparada per-tenant em `_iniciarAgendamentoTenant` (2s
  // após o primeiro acesso) onde tenantStorage resolve o db corretamente.
  _recuperarBlitzesRef = recuperarBlitzesAgendadas;

  async function recuperarBlitzesAgendadas() {
    try {
      const now = Date.now();
      const rows = db.prepare('SELECT * FROM blitz_agendadas ORDER BY alvoMs').all();
      if (rows.length === 0) return;

      // Limpar expiradas
      const expiradas = rows.filter(r => r.alvoMs <= now);
      if (expiradas.length > 0) {
        const stmt = db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?');
        for (const r of expiradas) {
          blitzHist.finalizarStatus(db, r.blitzKey, 'expirada', {
            observacao: 'Servidor estava fora no horário do disparo',
          });
          stmt.run(r.blitzKey);
        }
        console.log(`[BLITZ-RECOVERY] ${expiradas.length} agendamento(s) expirado(s) removido(s)`);
      }

      const ativas = rows.filter(r => r.alvoMs > now);
      if (ativas.length === 0) return;

      console.log(`[BLITZ-RECOVERY] Recuperando ${ativas.length} agendamento(s) pendente(s)`);

      for (const row of ativas) {
        agendarBlitzRecuperada(row);
      }
    } catch (e) {
      console.error('[BLITZ-RECOVERY] Erro:', e.message);
    }
  }

  function agendarBlitzRecuperada(row) {
    // Recuo do dispatch: alvoMs no DB = chegada último lance. Dispatch é recuado.
    const oneWay = 76, intervaloRR = 157, rttMediana = 153, bufferSpike = 30;
    const maxLancesRow = row.maxLances || 5;
    const numRodadas = Math.max(0, maxLancesRow - 1);
    // Sem saber ainda quantos itens vão coalescer, assume RTT puro (1 item).
    // Se coalescer mais itens, o primeiro grupo wins (timer já agendado).
    const duracaoRecuo = oneWay + (numRodadas * rttMediana) + bufferSpike;
    const dispatchMs = row.alvoMs - duracaoRecuo;
    const delayMs = dispatchMs - Date.now();
    if (delayMs <= 0) {
      blitzHist.finalizarStatus(db, row.blitzKey, 'expirada', {
        observacao: `Expirou entre o restart e a recovery (recuo=${duracaoRecuo}ms já passou)`,
      });
      try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(row.blitzKey); } catch (e) {}
      return;
    }

    const cfgItem = db.prepare('SELECT * FROM sniper_itens WHERE compraId = ? AND itemNumero = ?').get(row.compraId, row.itemNumero);
    if (!cfgItem || !cfgItem.valorMinimo) {
      console.log(`[BLITZ-RECOVERY] ${row.blitzKey} sem config válida — descartando`);
      blitzHist.finalizarStatus(db, row.blitzKey, 'cancelada', {
        observacao: 'Recovery descartou — config do item ausente/inválida',
      });
      try { db.prepare('DELETE FROM blitz_agendadas WHERE blitzKey = ?').run(row.blitzKey); } catch (e) {}
      return;
    }

    // Guard liga imediatamente com ramp dinâmico — polling degradê até o disparo.
    if (motorLigado()) {
      iniciarGuard(row.compraId, row.itemNumero, row.alvoMs);
      logAuto(`🛡️ GUARD ramped (recuperado) ativado para ${row.compraId} item ${row.itemNumero} (disparo em ${Math.round(delayMs/1000)}s)`);
    }

    // Coalescing na recovery: se já existe grupo com este alvoMs, anexa.
    const itemConfig = {
      compraId: row.compraId,
      itemNumero: row.itemNumero,
      valorMinimo: cfgItem.valorMinimo,
      faseItem: cfgItem.faseItem,
      variacaoMinima: cfgItem.variacaoMinima,
      tipoVariacao: cfgItem.tipoVariacao,
      maxLances: row.maxLances || 50,
    };
    let grupo = blitzGruposPorAlvo.get(row.alvoMs);
    let timer;
    if (grupo) {
      grupo.items.push(itemConfig);
      timer = grupo.timer;
      console.log(`[BLITZ-RECOVERY] ${row.compraId} item ${row.itemNumero} COALESCIDA no grupo existente (alvoMs=${row.alvoMs}, total=${grupo.items.length})`);
    } else {
      agendarPreDisparoTasks(row.alvoMs, 1, 'BLITZ-RECOVERY', [row.compraId]);
      grupo = { items: [itemConfig], timer: null, horarioEfetivo: row.horario, modo: row.modoBlitz || 'cobrir', capPorItem: null, dispatchMs };
      blitzGruposPorAlvo.set(row.alvoMs, grupo);
      timer = setTimeout(async () => {
        const itens = grupo.items;
        try {
          await _executarRoundRobinBlitz({
            itensConfig: itens,
            modo: grupo.modo,
            capPorItem: grupo.capPorItem,
            tag: itens.length > 1 ? 'BLITZ-RECOVERY-COALESCIDA' : 'BLITZ-RECOVERY',
            fonte: 'blitz-servidor',
            alvoMs: row.alvoMs,
          });
        } finally {
          blitzGruposPorAlvo.delete(row.alvoMs);
        }
      }, delayMs);
      grupo.timer = timer;
      console.log(`[BLITZ-RECOVERY] ${row.compraId} item ${row.itemNumero} dispatch recuado ${duracaoRecuo}ms (de ${new Date(row.alvoMs).toISOString()} pra ${new Date(dispatchMs).toISOString()})`);
    }

    blitzAgendadas[row.blitzKey] = {
      timer, horario: row.horario, compraId: row.compraId, itemNumero: row.itemNumero,
      maxLances: row.maxLances, modoBlitz: row.modoBlitz, agendadoEm: row.agendadoEm,
      alvoMs: row.alvoMs,
    };

    console.log(`[BLITZ-RECOVERY] ${row.compraId} item ${row.itemNumero} reagendado para ${row.horario} (em ${Math.round(delayMs/1000)}s)`);
    logAuto(`⏰ BLITZ RECUPERADA: ${row.compraId} item ${row.itemNumero} para ${row.horario}`);
  }

  async function executarBlitzRecuperada(row, cfgItem, historicoId) {
    let cached = disputasCache.disputas.find(d => d.compraId === row.compraId);
    let liveItem = cached && cached.itens ? cached.itens.find(i => i.numero === row.itemNumero) : null;

    // Refresh API se faltar tipoVariacao (cache antigo sem o campo)
    if (liveItem && liveItem.tipoVariacao == null && sniper.temToken()) {
      try {
        const { status, data } = await sniper.apiGet(`/comprasnet-disputa/v1/compras/${row.compraId}/itens/em-disputa`);
        if ((status === 200 || status === 206) && Array.isArray(data)) {
          const apiItem = data.find(i => (i.numero || i.identificador) === row.itemNumero);
          if (apiItem) {
            liveItem.variacaoMinima = apiItem.variacaoMinimaEntreLances ?? liveItem.variacaoMinima;
            liveItem.tipoVariacao = apiItem.tipoVariacaoMinimaEntreLances || liveItem.tipoVariacao;
            liveItem.melhorValor = (apiItem.melhorValorGeral || {}).valorInformado ?? liveItem.melhorValor;
            liveItem.nossoValor = (apiItem.melhorValorFornecedor || {}).valorInformado ?? liveItem.nossoValor;
            liveItem.situacaoParticipante = apiItem.situacaoParticipanteDisputa || liveItem.situacaoParticipante;
            logAuto(`🔄 BLITZ-RECOVERY refresh: ${row.compraId} item ${row.itemNumero} — varMin=${liveItem.variacaoMinima} tipo=${liveItem.tipoVariacao}`);
          }
        }
      } catch (e) {}
    }

    // Se ainda não há dados live, tentar fetch completo
    if (!liveItem || liveItem.nossoValor == null) {
      if (sniper.temToken()) {
        try {
          const d = await fetchItensDirecto(row.compraId);
          if (d) {
            liveItem = d.itens.find(i => i.numero === row.itemNumero);
          }
        } catch (e) {}
      }
    }

    if (!liveItem || liveItem.nossoValor == null) {
      const motivo = sniper.temToken()
        ? 'Recovery aborto: sem dados live (cache não populado e API não respondeu)'
        : 'Recovery aborto: sem dados live (token Bearer ausente — Electron offline?)';
      console.log(`[BLITZ-RECOVERY] ${row.compraId} item ${row.itemNumero} — sem live data, abortando`);
      logAuto(`🚀 BLITZ-RECOVERY: ${row.compraId} item ${row.itemNumero} — sem live data, abortando`);
      blitzHist.atualizarLances(db, historicoId, 0, motivo);
      // Telegram mesmo sem dados — usuário precisa saber que a rajada rodou
      notificarResultadoBlitz(row.compraId, row.itemNumero, { sucessos: 0, falhas: 0, motivo: 'sem live data' });
      return;
    }

    const itemParaCalculo = {
      ...liveItem,
      variacaoMinima: liveItem.variacaoMinima != null ? liveItem.variacaoMinima : cfgItem.variacaoMinima,
      tipoVariacao: liveItem.tipoVariacao || cfgItem.tipoVariacao || 'V',
    };

    const batchLances = calcularBatchLances(cfgItem, itemParaCalculo, row.compraId, row.maxLances || 50, row.modoBlitz || 'cobrir');
    if (batchLances.length === 0) {
      const dbg = `nosso=${itemParaCalculo.nossoValor} melhor=${itemParaCalculo.melhorValor} varMin=${itemParaCalculo.variacaoMinima} valMin=${cfgItem.valorMinimo} sit=${itemParaCalculo.situacaoParticipante} modo=${row.modoBlitz||'cobrir'}`;
      console.log(`[BLITZ-RECOVERY] ${row.compraId} item ${row.itemNumero} — 0 lances calculados`);
      blitzHist.atualizarLances(db, historicoId, 0, `Recovery aborto: batch vazio — ${dbg}`);
      // Telegram mesmo com batch vazio — cenário típico quando concorrente foi
      // abaixo do piso ou varMin não permite mais descer respeitando o piso.
      notificarResultadoBlitz(row.compraId, row.itemNumero, { sucessos: 0, falhas: 0, motivo: 'batch vazio (piso/varMin)' });
      return;
    }

    sniper.blitzDisparados[row.blitzKey] = Date.now();
    delete blitzAgendadas[row.blitzKey];

    const vi = itemParaCalculo.nossoValor.toFixed(2);
    const vf = batchLances[batchLances.length - 1].valor.toFixed(2);
    logAuto(`📋 BLITZ-RECOVERY ${row.compraId} item ${row.itemNumero} estado pré-disparo: fase=${itemParaCalculo.fase || '?'} sit=${itemParaCalculo.situacaoParticipante || '?'} melhorGeral=${itemParaCalculo.melhorValor} nosso=${itemParaCalculo.nossoValor} varMin=${itemParaCalculo.variacaoMinima} tipoVar=${itemParaCalculo.tipoVariacao} batch=[${batchLances.slice(0,3).map(l => l.valor.toFixed(2)).join(', ')}${batchLances.length > 3 ? ', …' : ''}]`);
    console.log(`[BLITZ-RECOVERY] DIRETO: ${row.compraId} item ${row.itemNumero} — ${batchLances.length} lances (R$${vi} → R$${vf})`);
    logAuto(`🚀 BLITZ-RECOVERY DIRETO: ${row.compraId} item ${row.itemNumero} — ${batchLances.length} lances`);

    let sucessos = 0, falhas = 0;
    for (const lance of batchLances) {
      try {
        const resultado = await sniper.enviarLance(row.compraId, row.itemNumero, lance.valor, lance.faseItem || 'LA');
        const respostaStr = typeof resultado.resposta === 'string' ? resultado.resposta.substring(0, 1500) : (resultado.resposta ? JSON.stringify(resultado.resposta).substring(0, 1500) : '');
        try {
          db.prepare(`INSERT INTO sniper_historico (compraId, itemNumero, valor, httpStatus, sucesso, tempoMs, resposta, fonte, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.compraId, row.itemNumero, lance.valor, resultado.status, resultado.sucesso ? 1 : 0, resultado.tempoMs, respostaStr, 'blitz-servidor', new Date().toISOString());
        } catch (e) {}
        if (resultado.sucesso) {
          sucessos++;
        } else {
          falhas++;
          if (resultado.status === 401 || resultado.status === 403) break;
          if (resultado.status === 422) {
            const tipo = classificar422(resultado.resposta);
            logAuto(`🩹 BLITZ-RECOVERY 422 ${tipo}: ${row.compraId} item ${row.itemNumero} R$ ${lance.valor.toFixed(2)}`);
            if (tipo === 'colisao')       continue;
            if (tipo === 'valor-baixo')   break;
            if (tipo === 'fase-invalida') break;
            break;
          }
        }
      } catch (e) { falhas++; break; }
    }
    console.log(`[BLITZ-RECOVERY] DIRETO resultado: ${row.compraId} item ${row.itemNumero} — ${sucessos} ✅ ${falhas} ❌`);
    // Histórico: atualiza contagem real de lances enviados.
    blitzHist.atualizarLances(db, historicoId, sucessos + falhas,
      `Recovery: ${sucessos} OK, ${falhas} falhas`);
    iniciarGuard(row.compraId, row.itemNumero);
    // Telegram: pós-blitz notifica se somos melhor colocado
    notificarResultadoBlitz(row.compraId, row.itemNumero, { sucessos, falhas });
  }

} // end registrarRotasSniper

function getSniper() {
  return sniper;
}

module.exports = { registrarRotasSniper, getSniper, sincronizarParticipacoesFunil };
