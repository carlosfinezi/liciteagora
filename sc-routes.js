/**
 * sc-routes.js — Rotas Express do robô SC.
 *
 * Phase 1 — credenciais + teste de login + status de sessão.
 * Phase 2 — sync (participações, disputa, chat) sob trigger manual.
 *
 * Ainda sem scheduler automático: o robô só atua quando alguém chama
 * POST /api/sc/sync/...; Phase 2.5 vai amarrar setInterval por-tenant.
 */
const { SCClient } = require('./sc-client');
const { syncParticipacoes, syncDisputa, syncChat } = require('./sc-sync');
const { ensureScheduleForTenant, setSCTelegramFn, getScheduleStatus } = require('./sc-scheduler');
const { dispararManual } = require('./sc-sniper');
const { currentTenant, currentDb } = require('./tenant-middleware');

function registrarRotasSC(app, db, deps = {}) {
  const enviarTelegram = typeof deps.enviarTelegram === 'function' ? deps.enviarTelegram : null;
  setSCTelegramFn(enviarTelegram);

  // Boot lazy do scheduler: dispara em qualquer request SC do tenant.
  // Idempotente — só agenda se ainda não houver schedule pra esse slug.
  app.use('/api/sc', (req, res, next) => {
    try {
      const tenant = currentTenant();
      if (tenant && tenant.slug) {
        const tenantDb = (() => { try { return currentDb(); } catch (_) { return null; } })();
        if (tenantDb) ensureScheduleForTenant(tenant, tenantDb);
      }
    } catch (_) {}
    next();
  });

  // ==================== Credenciais ====================

  app.post('/api/sc/credenciais', (req, res) => {
    try {
      const { usuario, senha } = req.body || {};
      if (!usuario || !senha) {
        return res.status(400).json({ success: false, error: 'usuario (CNPJ) e senha são obrigatórios' });
      }
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)`
      );
      stmt.run('sc_usuario', String(usuario).replace(/\D/g, ''));
      stmt.run('sc_senha', String(senha));
      db.prepare(`DELETE FROM config WHERE chave IN ('sc_access_token','sc_token_expires_at','sc_usuario_json','sc_refresh_token')`).run();
      res.json({ success: true, message: 'Credenciais SC salvas' });
    } catch (e) {
      console.error('[SC] erro ao salvar credenciais:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sc/credenciais/status', (req, res) => {
    try {
      const u = db.prepare(`SELECT valor FROM config WHERE chave = 'sc_usuario'`).get();
      const s = db.prepare(`SELECT valor FROM config WHERE chave = 'sc_senha'`).get();
      res.json({
        success: true,
        configurado: !!(u && u.valor && s && s.valor),
        usuario: u?.valor || null,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/api/sc/credenciais', (req, res) => {
    try {
      db.prepare(
        `DELETE FROM config WHERE chave IN ('sc_usuario','sc_senha','sc_access_token','sc_token_expires_at','sc_usuario_json','sc_refresh_token')`
      ).run();
      res.json({ success: true, message: 'Credenciais e token SC removidos' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sc/teste-login', async (req, res) => {
    try {
      const client = new SCClient(db);
      client.forceExpireToken();
      const result = await client.loginComCredenciaisSalvas();
      res.json({
        success: true,
        usuario: result.usuario,
        expiresInSeconds: result.expiresIn,
        sessaoExpiraEm: new Date(Date.now() + result.expiresIn * 1000).toISOString(),
      });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sc/sessao/status', async (req, res) => {
    try {
      const client = new SCClient(db);
      const v = await client.validarSessao();
      res.json({
        success: true,
        valida: v.valid,
        httpStatus: v.status,
        dataServidor: v.dataServidor || null,
        usuario: client.usuario,
        tokenExpiraEm: client.tokenExpiresAt ? new Date(client.tokenExpiresAt).toISOString() : null,
        erro: v.error || null,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== Sync (Phase 2) ====================

  app.post('/api/sc/sync/participacoes', async (req, res) => {
    try {
      const client = new SCClient(db);
      const stats = await syncParticipacoes(client, db);
      res.json({ success: true, ...stats });
    } catch (e) {
      console.error('[SC sync participacoes]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sc/sync/disputa/:cotacaoId', async (req, res) => {
    try {
      const cotacaoId = parseInt(req.params.cotacaoId, 10);
      if (!Number.isFinite(cotacaoId)) return res.status(400).json({ success: false, error: 'cotacaoId inválido' });
      const client = new SCClient(db);
      const stats = await syncDisputa(client, db, cotacaoId);
      res.json({ success: true, ...stats });
    } catch (e) {
      console.error('[SC sync disputa]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sc/sync/chat/:cotacaoId', async (req, res) => {
    try {
      const cotacaoId = parseInt(req.params.cotacaoId, 10);
      if (!Number.isFinite(cotacaoId)) return res.status(400).json({ success: false, error: 'cotacaoId inválido' });
      const client = new SCClient(db);
      const stats = await syncChat(client, db, cotacaoId, enviarTelegram);
      res.json({ success: true, ...stats });
    } catch (e) {
      console.error('[SC sync chat]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== Leitura do estado cacheado ====================

  app.get('/api/sc/participacoes', (req, res) => {
    try {
      const onlyAtivas = req.query.ativo !== '0';
      const where = onlyAtivas ? 'WHERE ativo = 1' : '';
      const rows = db.prepare(`SELECT * FROM sc_participacoes ${where} ORDER BY dataFimLances ASC`).all();
      res.json({ success: true, total: rows.length, participacoes: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sc/cotacao/:cotacaoId/lotes', (req, res) => {
    try {
      const cotacaoId = parseInt(req.params.cotacaoId, 10);
      if (!Number.isFinite(cotacaoId)) return res.status(400).json({ success: false, error: 'cotacaoId inválido' });
      const lotes = db.prepare(`SELECT * FROM sc_lotes_cache WHERE cotacaoId = ? ORDER BY numero ASC`).all(cotacaoId);
      res.json({ success: true, cotacaoId, lotes });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sc/cotacao/:cotacaoId/chat', (req, res) => {
    try {
      const cotacaoId = parseInt(req.params.cotacaoId, 10);
      if (!Number.isFinite(cotacaoId)) return res.status(400).json({ success: false, error: 'cotacaoId inválido' });
      const msgs = db.prepare(`SELECT * FROM sc_chat_mensagens WHERE cotacaoId = ? ORDER BY dataCriacao ASC`).all(cotacaoId);
      res.json({ success: true, cotacaoId, mensagens: msgs });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sc/sync/state', (req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM sc_sync_state ORDER BY job ASC`).all();
      res.json({ success: true, jobs: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sc/scheduler/status', (req, res) => {
    try {
      const tenant = currentTenant();
      const slug = tenant?.slug || null;
      const status = slug ? getScheduleStatus(slug) : null;
      res.json({ success: true, slug, scheduler: status });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ==================== Sniper (Phase 3) ====================

  app.get('/api/sc/sniper/config', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT c.*, p.numeroEdital, p.anoEdital, p.orgaoSigla, p.dataFimLances, p.cotacaoPorItem
        FROM sc_sniper_config c
        LEFT JOIN sc_participacoes p ON p.cotacaoId = c.cotacaoId
        ORDER BY p.dataFimLances ASC
      `).all();
      res.json({ success: true, total: rows.length, configs: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sc/sniper/config', (req, res) => {
    try {
      const { cotacaoId, loteOuItemId, valor, antecedenciaMs, ativo, observacao } = req.body || {};
      if (!Number.isFinite(+cotacaoId) || !Number.isFinite(+loteOuItemId) || !Number.isFinite(+valor)) {
        return res.status(400).json({ success: false, error: 'cotacaoId, loteOuItemId, valor são obrigatórios e numéricos' });
      }
      // Garante que a cotação está nas minhas participações ativas
      const p = db.prepare(`SELECT cotacaoId, dataFimLances, cotacaoPorItem FROM sc_participacoes WHERE cotacaoId = ? AND ativo = 1`).get(+cotacaoId);
      if (!p) return res.status(400).json({ success: false, error: 'cotacaoId não está em sc_participacoes ativas' });

      db.prepare(`
        INSERT INTO sc_sniper_config (cotacaoId, loteOuItemId, valor, antecedenciaMs, ativo, observacao, atualizadoEm)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(cotacaoId, loteOuItemId) DO UPDATE SET
          valor = excluded.valor,
          antecedenciaMs = excluded.antecedenciaMs,
          ativo = excluded.ativo,
          observacao = excluded.observacao,
          disparadoEm = NULL,           -- reativar = re-armar
          atualizadoEm = CURRENT_TIMESTAMP
      `).run(
        +cotacaoId, +loteOuItemId, +valor,
        Number.isFinite(+antecedenciaMs) ? +antecedenciaMs : 1500,
        ativo === false || ativo === 0 ? 0 : 1,
        observacao || null
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/api/sc/sniper/config/:cotacaoId/:loteOuItemId', (req, res) => {
    try {
      const cotacaoId = parseInt(req.params.cotacaoId, 10);
      const loteOuItemId = parseInt(req.params.loteOuItemId, 10);
      const r = db.prepare(`DELETE FROM sc_sniper_config WHERE cotacaoId = ? AND loteOuItemId = ?`).run(cotacaoId, loteOuItemId);
      res.json({ success: true, removidos: r.changes });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/sc/sniper/historico', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const cotacaoId = parseInt(req.query.cotacaoId, 10);
      let rows;
      if (Number.isFinite(cotacaoId)) {
        rows = db.prepare(`SELECT * FROM sc_sniper_historico WHERE cotacaoId = ? ORDER BY id DESC LIMIT ?`).all(cotacaoId, limit);
      } else {
        rows = db.prepare(`SELECT * FROM sc_sniper_historico ORDER BY id DESC LIMIT ?`).all(limit);
      }
      res.json({ success: true, total: rows.length, historico: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sc/sniper/disparar/:cotacaoId/:loteOuItemId', async (req, res) => {
    try {
      const cotacaoId = parseInt(req.params.cotacaoId, 10);
      const loteOuItemId = parseInt(req.params.loteOuItemId, 10);
      const valor = +(req.body?.valor);
      if (!Number.isFinite(valor)) return res.status(400).json({ success: false, error: 'valor obrigatório' });
      const client = new SCClient(db);
      const r = await dispararManual(client, db, cotacaoId, loteOuItemId, valor);
      res.json({ success: r.status === 'sucesso', ...r });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('[SC] Rotas registradas (Phase 1+2+2.5+3: credenciais, sessão, sync, leitura, scheduler, sniper)');
}

module.exports = { registrarRotasSC };
