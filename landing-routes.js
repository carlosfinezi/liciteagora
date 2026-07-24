// landing-routes.js
//
// Rotas servidas no apex `liciteagora.app` (e www.). Inclui:
//   - GET  /              → public/landing/index.html
//   - GET  /<asset>       → public/landing/<asset>
//   - POST /api/landing/signup → recebe lead, grava no control.db
//   - POST /api/landing/trial → Plano 11: cria tenant+vhost self-service
//   - GET  /api/landing/trial/status?slug=X
//   - GET  /api/landing/trial/check-slug?slug=X
//
// Montadas em auth-pipeline antes do authBarrier (pre-auth), com
// host guard que só responde quando req.tenantCtx.kind === 'apex'.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { spawnProvisionVhost, applyRouteMigrations } = require('./control-plane-routes');

const LANDING_DIR = path.join(__dirname, 'public', 'landing');

// Slugs que o visitante não pode usar — reservados para sistema/DNS.
const RESERVED_SLUGS = new Set([
  'admin', 'www', 'api', 'app', 'mail', 'ftp', 'demo', 'test', 'dev',
  'staging', 'blog', 'help', 'support', 'docs', 'status', 'mx',
  'root', 'public', 'private', 'internal', 'portal', 'login', 'auth',
]);

function apexOnly(req, res, next) {
  if (req.tenantCtx && req.tenantCtx.kind === 'apex') return next();
  // Não é apex: delega para o próximo middleware (vai cair em
  // tenant/admin/unknown como de praxe).
  return next('route');
}

function registerLandingRoutes(app, { controlDb, tenantManager = null }) {
  if (!controlDb) {
    throw new Error('landing-routes: controlDb é obrigatório');
  }

  // Garante tabela landing_leads no control.db (idempotente).
  controlDb.exec(`
    CREATE TABLE IF NOT EXISTS landing_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa TEXT NOT NULL,
      cnpj TEXT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL,
      telefone TEXT,
      plano TEXT,
      observacoes TEXT,
      status TEXT NOT NULL DEFAULT 'NEW',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leads_status ON landing_leads(status);
  `);

  const insertLead = controlDb.prepare(`
    INSERT INTO landing_leads (empresa, cnpj, nome, email, telefone, plano, observacoes, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'NEW', ?)
  `);

  // Signup lead.
  app.post('/api/landing/signup', express.json(), apexOnly, (req, res) => {
    try {
      const { empresa, cnpj, nome, email, telefone, plano, observacoes } = req.body || {};
      if (!empresa || !nome || !email) {
        return res.status(400).json({ error: 'empresa, nome e email obrigatórios' });
      }
      insertLead.run(
        String(empresa).trim(),
        cnpj ? String(cnpj).trim() : null,
        String(nome).trim(),
        String(email).trim().toLowerCase(),
        telefone ? String(telefone).trim() : null,
        plano ? String(plano).trim() : null,
        observacoes ? String(observacoes).trim() : null,
        Date.now(),
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[landing] signup error:', err.message);
      res.status(500).json({ error: 'erro ao gravar lead' });
    }
  });

  // ================== PLANO 11: TRIAL SELF-SERVICE ==================

  // Tabela de rate-limit por IP (anti-abuse de provisionamento).
  controlDb.exec(`
    CREATE TABLE IF NOT EXISTS landing_trial_rate (
      ip TEXT PRIMARY KEY,
      count INTEGER DEFAULT 0,
      window_start INTEGER
    );
  `);

  const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hora
  const RATE_MAX = 5;
  function checkRate(ip) {
    const now = Date.now();
    const row = controlDb.prepare('SELECT count, window_start FROM landing_trial_rate WHERE ip = ?').get(ip);
    if (!row || (now - row.window_start) > RATE_WINDOW_MS) {
      controlDb.prepare(`
        INSERT INTO landing_trial_rate (ip, count, window_start) VALUES (?, 1, ?)
        ON CONFLICT(ip) DO UPDATE SET count = 1, window_start = excluded.window_start
      `).run(ip, now);
      return { ok: true, remaining: RATE_MAX - 1 };
    }
    if (row.count >= RATE_MAX) return { ok: false, remaining: 0 };
    controlDb.prepare('UPDATE landing_trial_rate SET count = count + 1 WHERE ip = ?').run(ip);
    return { ok: true, remaining: RATE_MAX - row.count - 1 };
  }

  function slugDisponivel(slug) {
    if (!/^[a-z][a-z0-9-]{2,29}$/.test(slug)) return { ok: false, reason: 'Use 3–30 caracteres, só letras minúsculas, números e hífens — começando com letra.' };
    if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: 'Esse subdomínio é reservado — escolha outro.' };
    const existe = controlDb.prepare('SELECT id FROM tenants WHERE slug = ?').get(slug);
    if (existe) return { ok: false, reason: 'Subdomínio já em uso.' };
    return { ok: true };
  }

  app.get('/api/landing/trial/check-slug', apexOnly, (req, res) => {
    const slug = String(req.query.slug || '').trim().toLowerCase();
    if (!slug) return res.json({ available: false, reason: 'Informe o subdomínio.' });
    const r = slugDisponivel(slug);
    res.json({ available: r.ok, reason: r.reason || null });
  });

  app.get('/api/landing/trial/status', apexOnly, (req, res) => {
    const slug = String(req.query.slug || '').trim().toLowerCase();
    if (!slug) return res.status(400).json({ error: 'slug obrigatório' });
    const t = controlDb.prepare('SELECT slug, status, provision_status, db_path FROM tenants WHERE slug = ?').get(slug);
    if (!t) return res.status(404).json({ error: 'tenant não encontrado' });
    const provisionStatus = t.provision_status || 'NOT_STARTED';
    const ready = provisionStatus === 'READY';
    res.json({
      slug: t.slug,
      status: ready ? 'ready' : (provisionStatus === 'FAILED' ? 'failed' : 'provisioning'),
      provision_status: provisionStatus,
      subdomainUrl: `https://${slug}.liciteagora.app/`,
    });
  });

  app.post('/api/landing/trial', express.json(), apexOnly, (req, res) => {
    if (!tenantManager) {
      return res.status(503).json({ error: 'Trial indisponível temporariamente.' });
    }
    try {
      const { empresa, cnpj, nome, email, telefone, slug: slugRaw, plano } = req.body || {};
      if (!empresa || !nome || !email || !slugRaw) {
        return res.status(400).json({ error: 'empresa, nome, email e slug obrigatórios' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
        return res.status(400).json({ error: 'email inválido' });
      }
      const slug = String(slugRaw).trim().toLowerCase();
      const disp = slugDisponivel(slug);
      if (!disp.ok) return res.status(400).json({ error: disp.reason });

      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const rate = checkRate(ip);
      if (!rate.ok) {
        return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em 1 hora.' });
      }

      const planoFinal = ['starter', 'profissional', 'avancado', 'enterprise'].includes(String(plano || '').toLowerCase())
        ? String(plano).toLowerCase() : 'profissional';

      // Cria o tenant + schema base (segue o mesmo padrão do admin).
      const tenant = tenantManager.createTenant({
        slug,
        name: String(empresa).trim(),
        ownerEmail: String(email).trim().toLowerCase(),
        plan: planoFinal,
        status: 'TRIAL',
        trialDays: 14,
        actor: 'self-service',
      });

      const tenantDb = tenantManager.getDb(slug);
      applyRouteMigrations(tenantDb, tenant);

      // Gera senha temporária e cria usuário admin.
      const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
      const hash = bcrypt.hashSync(tempPassword, 10);
      tenantDb.prepare(
        "INSERT OR REPLACE INTO users (username, passwordHash, nome, role, ativo) VALUES (?, ?, ?, 'admin', 1)"
      ).run('admin', hash, String(nome).trim());

      // api_key para Electron (padrão do admin).
      let apiKeyRow = tenantDb.prepare("SELECT valor FROM config WHERE chave = 'api_key'").get();
      if (!apiKeyRow) {
        const apiKey = crypto.randomBytes(32).toString('hex');
        tenantDb.prepare(
          'INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)'
        ).run('api_key', apiKey);
      }

      // Registra o lead no log também (para CRM).
      try {
        insertLead.run(
          String(empresa).trim(),
          cnpj ? String(cnpj).trim() : null,
          String(nome).trim(),
          String(email).trim().toLowerCase(),
          telefone ? String(telefone).trim() : null,
          planoFinal,
          `self-service trial · slug=${slug}`,
          Date.now(),
        );
      } catch (_) { /* já gravado */ }

      // Dispara provisionamento vhost/SSL em background.
      spawnProvisionVhost(slug, tenantManager);

      console.log(`[landing][trial] tenant "${slug}" criado (plano=${planoFinal}, owner=${email})`);
      res.status(202).json({
        success: true,
        slug,
        status: 'provisioning',
        subdomainUrl: `https://${slug}.liciteagora.app/`,
        // Retorna credenciais para /aguardando.html exibir — usuário já está
        // autenticado no fluxo (submeteu form do próprio browser). Também
        // registramos no log para auditoria.
        username: 'admin',
        senhaTemp: tempPassword,
      });
    } catch (err) {
      console.error('[landing][trial] erro:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Static + SPA fallback para index.html quando o host é apex.
  // Usa um mini-middleware próprio para não interferir com tenants.
  app.use((req, res, next) => {
    if (!req.tenantCtx || req.tenantCtx.kind !== 'apex') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const reqPath = req.path === '/' ? '/index.html' : req.path;
    const filePath = path.join(LANDING_DIR, path.normalize(reqPath).replace(/^\/+/, ''));
    // Proteção contra path traversal
    if (!filePath.startsWith(LANDING_DIR)) return res.status(403).end();

    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        // fallback: sempre serve index.html para rotas sem match
        return res.sendFile(path.join(LANDING_DIR, 'index.html'), (e) => {
          if (e) next();
        });
      }
      res.sendFile(filePath, (e) => { if (e) next(); });
    });
  });

  console.log('[Landing] Rotas do apex liciteagora.app registradas');
}

module.exports = { registerLandingRoutes };
