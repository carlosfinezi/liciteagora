// bll-salas-routes.js — Rotas REST pra CRUD de salas BLL. Porta de bnc-salas-routes.js.
//
// Endpoints (auth via middleware de tenant existente):
//   POST   /api/bll/salas/cadastrar         body { url, notas? }
//   GET    /api/bll/salas                    ?ativo=1
//   GET    /api/bll/salas/:id                (id numérico ou compraId)
//   DELETE /api/bll/salas/:id
//   POST   /api/bll/salas/:id/ativo          body { ativo: bool }
//   POST   /api/bll/salas/:id/dry-run        body { dryRun: bool }
//   GET    /api/bll/salas/:id/auto-lance     lotes + config bll_auto_lance
//   POST   /api/bll/lotes/:loteId/auto-lance body { ativo, limiteMinimo, decremento, throttleMs }
//   GET    /api/bll/disputas                 cache do scheduler (statusName=DISPUTA)
//   POST   /api/bll/salas/:id/redescobrir    refaz GET /BatchList e atualiza
//
// O cadastro exige sessão BLL ativa (cookie em config). Sem isso retorna 400.

'use strict';

const bllSalas = require('./bll-salas');
const bllScheduler = require('./bll-dispute-scheduler');
const { BllSessaoIndisponivelError, BllSessaoExpiradaError } = require('./bll-client');

function tenantSlugFromReq(req) {
  return req.tenant?.slug || req.tenantSlug || (req.tenant && req.tenant.slug) || null;
}

function registrarRotasBLLSalas(app, db) {
  app.post('/api/bll/salas/cadastrar', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const { url, notas } = req.body || {};
      if (!url) return res.status(400).json({ success: false, error: 'url obrigatória' });
      const r = await bllSalas.cadastrarSala(tdb, { url, notas });
      const slug = tenantSlugFromReq(req);
      if (slug) bllScheduler.refreshTenant(slug);
      res.json({ success: true, ...r });
    } catch (e) {
      if (e instanceof BllSessaoIndisponivelError || e instanceof BllSessaoExpiradaError) {
        return res.status(400).json({ success: false, error: e.message, code: e.code });
      }
      console.error('[BLL salas] cadastrar erro:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/bll/salas', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const ativo = req.query.ativo === '1' ? true : (req.query.ativo === '0' ? false : null);
      res.json({ success: true, salas: bllSalas.listarSalas(tdb, { ativo }) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/bll/salas/:id', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const id = isNaN(req.params.id) ? req.params.id : Number(req.params.id);
      const sala = bllSalas.getSala(tdb, id);
      if (!sala) return res.status(404).json({ success: false, error: 'Sala não encontrada' });
      res.json({ success: true, sala });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/api/bll/salas/:id', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      bllSalas.deletarSala(tdb, Number(req.params.id));
      const slug = tenantSlugFromReq(req);
      if (slug) bllScheduler.refreshTenant(slug);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/bll/salas/:id/ativo', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const ativo = !!(req.body && req.body.ativo);
      bllSalas.setAtivo(tdb, Number(req.params.id), ativo);
      const slug = tenantSlugFromReq(req);
      if (slug) bllScheduler.refreshTenant(slug);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Toggle dryRun da sala. dryRun=1 (default) → engine só loga. dryRun=0 → PerformBid REAL.
  app.post('/api/bll/salas/:id/dry-run', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const dryRun = req.body && req.body.dryRun !== undefined ? (req.body.dryRun ? 1 : 0) : 1;
      tdb.prepare('UPDATE bll_salas SET dryRun = ?, updatedAt = ? WHERE id = ?')
        .run(dryRun, new Date().toISOString(), Number(req.params.id));
      const slug = tenantSlugFromReq(req);
      if (slug) bllScheduler.refreshTenant(slug);
      res.json({ success: true, dryRun: !!dryRun });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ─── Auto-lance por lote (bll_auto_lance) ───
  app.get('/api/bll/salas/:id/auto-lance', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const salaId = Number(req.params.id);
      const lotes = tdb.prepare(`
        SELECT l.id as loteId, l.batchNumber, l.title, l.baseValue, l.currentBest,
               a.ativo, a.limiteMinimo, a.decremento, a.throttleMs, a.atualizadoEm
          FROM bll_salas_lotes l
          LEFT JOIN bll_auto_lance a ON a.loteId = l.id
         WHERE l.salaId = ?
         ORDER BY l.batchNumber
      `).all(salaId);
      res.json({ success: true, lotes });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/bll/lotes/:loteId/auto-lance', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const loteId = Number(req.params.loteId);
      const { ativo, limiteMinimo, decremento, throttleMs } = req.body || {};
      const now = new Date().toISOString();
      const existing = tdb.prepare('SELECT id FROM bll_auto_lance WHERE loteId = ?').get(loteId);
      if (existing) {
        tdb.prepare(`UPDATE bll_auto_lance SET
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
        tdb.prepare(`INSERT INTO bll_auto_lance (loteId, ativo, limiteMinimo, decremento, throttleMs, atualizadoEm)
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

  // Cache em memória do scheduler — filtra só salas em DISPUTA.
  app.get('/api/bll/disputas', (req, res) => {
    try {
      const slug = tenantSlugFromReq(req);
      if (!slug) return res.json({ success: true, disputas: [], updatedAt: null });
      const cache = bllScheduler.getDisputasCache(slug);
      const disputas = (cache.disputas || []).filter(s => (s.statusName || '').toUpperCase() === 'DISPUTA');
      res.json({ success: true, disputas, updatedAt: cache.updatedAt });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/bll/salas/:id/redescobrir', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const sala = bllSalas.getSala(tdb, Number(req.params.id));
      if (!sala) return res.status(404).json({ success: false, error: 'Sala não encontrada' });
      const r = await bllSalas.cadastrarSala(tdb, { url: sala.url, notas: sala.notas });
      res.json({ success: true, ...r });
    } catch (e) {
      if (e instanceof BllSessaoIndisponivelError || e instanceof BllSessaoExpiradaError) {
        return res.status(400).json({ success: false, error: e.message, code: e.code });
      }
      res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('[BLL-Salas] Rotas registradas');
}

module.exports = { registrarRotasBLLSalas };
