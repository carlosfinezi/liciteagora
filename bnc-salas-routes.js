// bnc-salas-routes.js — Rotas REST pra CRUD de salas BNC.
//
// Endpoints (todos auth via middleware de tenant existente):
//   POST   /api/bnc/salas/cadastrar   body { url, notas? }
//   GET    /api/bnc/salas             ?ativo=1
//   GET    /api/bnc/salas/:id         (id numérico ou compraId)
//   DELETE /api/bnc/salas/:id
//   POST   /api/bnc/salas/:id/ativo   body { ativo: bool }
//   POST   /api/bnc/salas/:id/redescobrir   refaz GET /BatchList e atualiza
//
// O cadastro exige sessão BNC ativa (cookie em config). Sem isso retorna 400
// com mensagem orientando abrir o Electron BNC.

'use strict';

const bncSalas = require('./bnc-salas');
const bncScheduler = require('./bnc-dispute-scheduler');
const bncResolver = require('./bnc-sala-resolver');
const { BncSessaoIndisponivelError, BncSessaoExpiradaError } = require('./bnc-client');

function tenantSlugFromReq(req) {
  return req.tenant?.slug || req.tenantSlug || (req.tenant && req.tenant.slug) || null;
}

function registrarRotasBNCSalas(app, db) {
  app.post('/api/bnc/salas/cadastrar', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const { url, notas } = req.body || {};
      if (!url) return res.status(400).json({ success: false, error: 'url obrigatória' });
      const r = await bncSalas.cadastrarSala(tdb, { url, notas });
      // Acorda scheduler pra subir engine pra essa sala imediatamente
      const slug = tenantSlugFromReq(req);
      if (slug) bncScheduler.refreshTenant(slug);
      res.json({ success: true, ...r });
    } catch (e) {
      if (e instanceof BncSessaoIndisponivelError || e instanceof BncSessaoExpiradaError) {
        return res.status(400).json({ success: false, error: e.message, code: e.code });
      }
      console.error('[BNC salas] cadastrar erro:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Resolver automático: cadastra as salas de todos os processos com proposta
  // enviada, sem link colado. Trigger manual do mesmo job que roda no scheduler.
  app.post('/api/bnc/salas/resolver', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const slug = tenantSlugFromReq(req);
      const r = await bncResolver.resolverSalasTenant(tdb, { tenantSlug: slug });
      res.json({ success: true, ...r });
    } catch (e) {
      console.error('[BNC salas] resolver erro:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/bnc/salas', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const ativo = req.query.ativo === '1' ? true : (req.query.ativo === '0' ? false : null);
      res.json({ success: true, salas: bncSalas.listarSalas(tdb, { ativo }) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/bnc/salas/:id', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const id = isNaN(req.params.id) ? req.params.id : Number(req.params.id);
      const sala = bncSalas.getSala(tdb, id);
      if (!sala) return res.status(404).json({ success: false, error: 'Sala não encontrada' });
      res.json({ success: true, sala });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/api/bnc/salas/:id', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      bncSalas.deletarSala(tdb, Number(req.params.id));
      const slug = tenantSlugFromReq(req);
      if (slug) bncScheduler.refreshTenant(slug);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/bnc/salas/:id/ativo', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const ativo = !!(req.body && req.body.ativo);
      bncSalas.setAtivo(tdb, Number(req.params.id), ativo);
      const slug = tenantSlugFromReq(req);
      if (slug) bncScheduler.refreshTenant(slug);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Toggle dryRun da sala. dryRun=1 (default) → engine só loga decisões.
  // dryRun=0 → engine pode enviar PerformBid REAL (lance valendo).
  app.post('/api/bnc/salas/:id/dry-run', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const dryRun = req.body && req.body.dryRun !== undefined
        ? (req.body.dryRun ? 1 : 0)
        : 1;
      tdb.prepare('UPDATE bnc_salas SET dryRun = ?, updatedAt = ? WHERE id = ?')
        .run(dryRun, new Date().toISOString(), Number(req.params.id));
      const slug = tenantSlugFromReq(req);
      if (slug) bncScheduler.refreshTenant(slug);
      res.json({ success: true, dryRun: !!dryRun });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ─── Auto-lance por lote (bnc_auto_lance) ───
  app.get('/api/bnc/salas/:id/auto-lance', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const salaId = Number(req.params.id);
      const lotes = tdb.prepare(`
        SELECT l.id as loteId, l.batchNumber, l.title, l.baseValue, l.currentBest,
               a.ativo, a.limiteMinimo, a.decremento, a.throttleMs, a.atualizadoEm
          FROM bnc_salas_lotes l
          LEFT JOIN bnc_auto_lance a ON a.loteId = l.id
         WHERE l.salaId = ?
         ORDER BY l.batchNumber
      `).all(salaId);
      res.json({ success: true, lotes });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/bnc/lotes/:loteId/auto-lance', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const loteId = Number(req.params.loteId);
      const { ativo, limiteMinimo, decremento, throttleMs } = req.body || {};
      const now = new Date().toISOString();
      const existing = tdb.prepare('SELECT id FROM bnc_auto_lance WHERE loteId = ?').get(loteId);
      if (existing) {
        tdb.prepare(`UPDATE bnc_auto_lance SET
          ativo = COALESCE(?, ativo),
          limiteMinimo = COALESCE(?, limiteMinimo),
          decremento = COALESCE(?, decremento),
          throttleMs = COALESCE(?, throttleMs),
          atualizadoEm = ?
          WHERE loteId = ?`)
          .run(
            ativo === undefined ? null : (ativo ? 1 : 0),
            limiteMinimo === undefined ? null : Number(limiteMinimo),
            decremento === undefined ? null : Number(decremento),
            throttleMs === undefined ? null : Number(throttleMs),
            now, loteId
          );
      } else {
        tdb.prepare(`INSERT INTO bnc_auto_lance (loteId, ativo, limiteMinimo, decremento, throttleMs, atualizadoEm)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(
            loteId,
            ativo ? 1 : 0,
            limiteMinimo === undefined ? 0 : Number(limiteMinimo),
            decremento === undefined ? 1 : Number(decremento),
            throttleMs === undefined ? 2000 : Number(throttleMs),
            now
          );
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Cache em memória do scheduler (lances.html consome via /api/bnc/disputas).
  // Filtra só salas com statusName='DISPUTA' — não faz sentido mostrar sala em
  // HABILITAÇÃO/RECEPÇÃO/etc na tela de lances (não dá pra dar lance fora da fase).
  app.get('/api/bnc/disputas', (req, res) => {
    try {
      const slug = tenantSlugFromReq(req);
      if (!slug) return res.json({ success: true, disputas: [], updatedAt: null });
      const cache = bncScheduler.getDisputasCache(slug);
      const disputas = (cache.disputas || []).filter(s => (s.statusName || '').toUpperCase() === 'DISPUTA');
      res.json({ success: true, disputas, updatedAt: cache.updatedAt });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Feed de chat capturado (todas as salas ou uma). Mais recentes primeiro.
  app.get('/api/bnc/chat', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const limit = Math.min(Number(req.query.limit) || 200, 500);
      const salaId = req.query.salaId ? Number(req.query.salaId) : null;
      let sql = `SELECT m.id, m.salaId, m.escopo, m.lote, m.autor, m.texto, m.dataHora, m.criadoEm,
                        s.processNumber, s.title
                   FROM bnc_chat_mensagens m JOIN bnc_salas s ON s.id = m.salaId`;
      const params = [];
      if (salaId) { sql += ' WHERE m.salaId = ?'; params.push(salaId); }
      sql += ' ORDER BY m.id DESC LIMIT ?'; params.push(limit);
      res.json({ success: true, mensagens: tdb.prepare(sql).all(...params) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/bnc/salas/:id/redescobrir', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const sala = bncSalas.getSala(tdb, Number(req.params.id));
      if (!sala) return res.status(404).json({ success: false, error: 'Sala não encontrada' });
      const r = await bncSalas.cadastrarSala(tdb, { url: sala.url, notas: sala.notas });
      res.json({ success: true, ...r });
    } catch (e) {
      if (e instanceof BncSessaoIndisponivelError || e instanceof BncSessaoExpiradaError) {
        return res.status(400).json({ success: false, error: e.message, code: e.code });
      }
      res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('[BNC-Salas] Rotas registradas');
}

module.exports = { registrarRotasBNCSalas };
