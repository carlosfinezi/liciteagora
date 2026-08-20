// control-plane-routes.js
//
// Rotas do painel administrativo multi-tenant, servidas em
// admin.liciteagora.app. Mantém isolamento completo do app de
// cada tenant:
//   - auth própria via tabela super_admins (control.db)
//   - session key própria (req.session.superAdminId), separada de
//     req.session.userId (tenant) e req.session.clienteLoginId (portal)
//   - todas as queries batem em control.db OU delegam ao tenant-manager
//     (que abre o DB do tenant temporariamente via tenantStorage.run)
//
// Montado em auth-pipeline entre registerPreAuthRoutes e o authBarrier:
// rotas /api/admin/* ficam públicas para requireAuth (self-manage
// via requireSuperAdmin) e as páginas HTML moram em public/auth/admin/
// para serem servidas pelo static público em base-middleware.js.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { tenantStorage } = require('./tenant-middleware');
const { initSchema } = require('./db-schema');
const { applyRouteMigrations } = require('./tenant-provision');

const PROVISION_SCRIPT = path.join(__dirname, 'scripts', 'provision-tenant-vhost.sh');

// Dispara o provision de vhost/SSL em background. Não bloqueia a
// resposta HTTP do create. Atualiza provision_status no control.db
// conforme o progresso. Em caso de WAITING_DNS (exit 10), agenda
// retry após 30s — a propagação DNS pode atrapalhar em contas recém-
// configuradas, mesmo com wildcard.
function spawnProvisionVhost(slug, manager, attempt = 1) {
  const MAX_ATTEMPTS = 5;
  manager.setProvisionStatus({ slug, status: 'PROVISIONING', message: `tentativa ${attempt}` });

  // Roda via sudo (NOPASSWD via /etc/sudoers.d/liciteagora-provision)
  // — o worker roda como `carlosfinezi` mas comandos v-* do Hestia
  // precisam ler /usr/local/hestia/conf/hestia.conf (root-only).
  const child = spawn('sudo', ['-n', PROVISION_SCRIPT, slug], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: '/usr/local/hestia/bin:' + (process.env.PATH || '') },
  });
  let stdoutBuf = '', stderrBuf = '';
  child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  child.on('close', (code) => {
    const msg = (stdoutBuf + stderrBuf).split('\n').slice(-5).join('\n').trim();
    if (code === 0 || code === 20) {
      manager.setProvisionStatus({ slug, status: 'READY', message: msg });
      manager.audit({ tenantId: manager.getTenantBySlug(slug)?.id, action: 'PROVISION_VHOST_OK', actor: 'system', payload: { exitCode: code } });
      console.log(`[provision][${slug}] READY`);
    } else if (code === 10 && attempt < MAX_ATTEMPTS) {
      console.log(`[provision][${slug}] WAITING_DNS — retry em 30s (tentativa ${attempt + 1}/${MAX_ATTEMPTS})`);
      manager.setProvisionStatus({ slug, status: 'WAITING_DNS', message: msg });
      setTimeout(() => spawnProvisionVhost(slug, manager, attempt + 1), 30000);
    } else {
      manager.setProvisionStatus({ slug, status: 'FAILED', message: `exit=${code}\n${msg}` });
      manager.audit({ tenantId: manager.getTenantBySlug(slug)?.id, action: 'PROVISION_VHOST_FAIL', actor: 'system', payload: { exitCode: code, msg } });
      console.error(`[provision][${slug}] FAILED (exit ${code}): ${msg}`);
    }
  });
  child.on('error', (err) => {
    manager.setProvisionStatus({ slug, status: 'FAILED', message: err.message });
    console.error(`[provision][${slug}] spawn error:`, err.message);
  });
}

const ADMIN_HOST = 'admin.liciteagora.app';

// Catálogo canônico de features alternáveis pelo super-admin.
// Cada feature.key vira `<key>_enabled` na tabela config do tenant
// ('1' = ativa, qualquer outra coisa = inativa).
const FEATURES = [
  { key: 'optica', label: 'Módulo Ótica',
    desc: 'Catálogo de armações/lentes, receitas oftalmológicas e ordens de montagem.' },
  { key: 'licitacoes', label: 'Módulo Licitações',
    desc: 'Buscar, marcar interesse, agenda e descarte de licitações públicas (Comprasnet/PNCP).' },
  { key: 'operacional', label: 'Módulo Operacional (Licitações)',
    desc: 'Propostas, lances automáticos, monitor de chat, inteligência e análises IA. Add-on do módulo Licitações.' },
  { key: 'habilitacao', label: 'Módulo Certidões & Habilitação',
    desc: 'Gestão das certidões negativas e documentos de habilitação da empresa (jurídica, fiscal, econômico-financeira, técnica) com controle de validade e alertas de vencimento.' },
  { key: 'comercial', label: 'Módulo Comercial',
    desc: 'Clientes & Fornecedores, CRM (funil/oportunidades), Pedidos, Contratos e Devoluções.' },
  { key: 'os', label: 'Módulo Ordens de Serviço',
    desc: 'Abertura, acompanhamento, faturamento de OS; cadastros de tipos de OS e serviços; notificações e relatórios.' },
  { key: 'produtos', label: 'Módulo Catálogo, Estoque & Compras',
    desc: 'Catálogo (produtos, marcas, modelos, cores, materiais, gêneros), Estoque (saldo, movimentações, inventário, lotes, serial, reservas, análises) e Compras (pedidos de compra, sugestão de compra, fornecedores).' },
  { key: 'comunicacao', label: 'Módulo Comunicação',
    desc: 'Envio de comunicação para clientes/fornecedores, log de e-mails enviados e auditoria de ações.' },
  { key: 'rh', label: 'Módulo RH',
    desc: 'Funcionários, ponto, férias, atestados e comissões de vendedores.' },
  { key: 'patrimonio', label: 'Módulo Patrimônio',
    desc: 'Ativo imobilizado: cadastro de bens, depreciação linear, transferências, manutenções e baixas.' },
  { key: 'varejo', label: 'Módulo Varejo',
    desc: 'PDV (NFC-e), TEF, marketplaces e romaneios.' },
  { key: 'cobranca', label: 'Módulo Cobrança',
    desc: 'Régua de cobrança automática (e-mail/WhatsApp), boletos de cobrança, juros e multa por atraso.' },
  { key: 'fiscal', label: 'Módulo Fiscal',
    desc: 'NFS-e, NFC-e/NF-e (emissão e entrada), MDF-e, CT-e, CFOPs, retenções, apuração SN, DRE, DEFIS e arquivamento fiscal.' },
  { key: 'classificacao_fiscal', label: 'Módulo Classificação Fiscal',
    desc: 'Classificação de NCM/CEST (busca + IA) e impostos por NCM: IPI, II, ICMS interno por UF, PIS/COFINS por regime, ICMS-ST/MVA e benefícios fiscais (ex.: cesta básica/Convênio 52/91 do PA). Add-on vendido separadamente.' },
  { key: 'financeiro', label: 'Módulo Financeiro',
    desc: 'Contas a receber/pagar, contas financeiras, plano de contas, centros de custo, fluxo de caixa, livro caixa, conciliação bancária, faturas, cobranças, adquirentes e recorrências.' },
  { key: 'ssl', label: 'Módulo Certificados SSL (NicSRS)',
    desc: 'Compra e ciclo de vida de certificados SSL na NicSRS amarrados a contratos de cliente: fila de aprovação de compra, reemissão automática dentro da assinatura (o arquivo vale ~200 dias, o contrato vale 12+ meses), alerta de vencimento e entrega ao cliente. Add-on por tenant.' },
];

function lerFeaturesDoTenant(tenantDb) {
  if (!tenantDb) return Object.fromEntries(FEATURES.map(f => [f.key, false]));
  const out = {};
  for (const f of FEATURES) {
    try {
      const row = tenantDb.prepare("SELECT valor FROM config WHERE chave = ?").get(f.key + '_enabled');
      out[f.key] = !!(row && row.valor === '1');
    } catch { out[f.key] = false; }
  }
  return out;
}

function hostOk(req) {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  return host === ADMIN_HOST;
}

// Guard que exige host == admin.liciteagora.app. Em dev/local,
// aceita via header X-Admin-Host=true (só se ADMIN_ALLOW_ANY_HOST=true).
function hostGuard(req, res, next) {
  if (hostOk(req)) return next();
  if (process.env.ADMIN_ALLOW_ANY_HOST === 'true') return next();
  res.status(404).type('text/plain').send('Not found');
}

function requireSuperAdmin(controlDb) {
  return (req, res, next) => {
    if (!hostOk(req) && process.env.ADMIN_ALLOW_ANY_HOST !== 'true') {
      return res.status(404).json({ error: 'Not found' });
    }
    if (!req.session || !req.session.superAdminId) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    const admin = controlDb.prepare('SELECT id, email, name FROM super_admins WHERE id = ?')
      .get(req.session.superAdminId);
    if (!admin) {
      req.session.destroy?.(() => {});
      return res.status(401).json({ error: 'Sessão inválida' });
    }
    req.superAdmin = admin;
    next();
  };
}

function registerControlPlaneRoutes(app, { controlDb, manager }) {
  if (!controlDb || !manager) {
    throw new Error('control-plane-routes: controlDb e manager são obrigatórios');
  }

  // ==================== LOGIN / LOGOUT ====================

  app.post('/api/admin/login', hostGuard, (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'email e password obrigatórios' });

      const row = controlDb.prepare('SELECT id, email, password_hash, name FROM super_admins WHERE email = ?')
        .get(email.toLowerCase().trim());
      if (!row || !bcrypt.compareSync(password, row.password_hash)) {
        return res.status(401).json({ error: 'Credenciais inválidas' });
      }

      controlDb.prepare('UPDATE super_admins SET last_login_at = ? WHERE id = ?')
        .run(Date.now(), row.id);

      // regenerate: SID novo a cada login (previne session fixation e
      // reforça isolamento entre tenants/admin no mesmo browser).
      req.session.regenerate((err) => {
        if (err) return res.status(500).json({ error: 'Falha ao criar sessão' });
        req.session.superAdminId = row.id;
        res.json({ success: true, admin: { id: row.id, email: row.email, name: row.name } });
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/logout', hostGuard, (req, res) => {
    if (req.session) {
      req.session.destroy(() => {
        // Cookie agora é por subdomínio (sem `domain`) — clearCookie
        // default bate com o escopo correto.
        res.clearCookie('liciteagora.sid');
        res.json({ success: true });
      });
    } else {
      res.json({ success: true });
    }
  });

  app.get('/api/admin/me', hostGuard, (req, res) => {
    if (!req.session || !req.session.superAdminId) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    const admin = controlDb.prepare('SELECT id, email, name FROM super_admins WHERE id = ?')
      .get(req.session.superAdminId);
    if (!admin) return res.status(401).json({ error: 'Sessão inválida' });
    res.json({ admin });
  });

  // ==================== TENANTS ====================

  const protect = requireSuperAdmin(controlDb);

  app.get('/api/admin/tenants', protect, (req, res) => {
    try {
      const tenants = controlDb.prepare(`
        SELECT t.*,
          (SELECT last_paid_at FROM tenant_billing WHERE tenant_id = t.id) AS last_paid_at,
          (SELECT next_due_at  FROM tenant_billing WHERE tenant_id = t.id) AS next_due_at,
          p.slug   AS plano_slug,
          p.nome   AS plano_nome,
          p.tipo   AS plano_tipo,
          p.duracao_dias  AS plano_duracao_dias,
          p.dias_carencia AS plano_dias_carencia
        FROM tenants t
        LEFT JOIN planos p ON p.id = t.plano_id
        ORDER BY t.created_at DESC
      `).all();
      // Anexa features de cada tenant (best-effort: se DB não existir/estiver
      // travado, retorna tudo desativado pra não quebrar a listagem).
      for (const t of tenants) {
        try { t.features = lerFeaturesDoTenant(manager.getDb(t.slug)); }
        catch { t.features = Object.fromEntries(FEATURES.map(f => [f.key, false])); }
      }
      const planos = manager.listPlanos({ apenasAtivos: false });
      // splitGlobal vai junto pra coluna Split mostrar o percentual efetivo
      // sem um segundo round-trip.
      res.json({ tenants, featuresCatalog: FEATURES, planos, splitGlobal: lerSplitGlobal() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ========== Planos (catálogo) ==========

  app.get('/api/admin/planos', protect, (req, res) => {
    try {
      res.json({ planos: manager.listPlanos({ apenasAtivos: req.query.ativos === '1' }) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/planos', protect, (req, res) => {
    try {
      const plano = manager.criarPlano(req.body || {});
      res.status(201).json({ plano });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/admin/planos/:id', protect, (req, res) => {
    try {
      const plano = manager.atualizarPlano(Number(req.params.id), req.body || {});
      res.json({ plano });
    } catch (err) {
      res.status(err.message.includes('não existe') ? 404 : 400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/planos/:id', protect, (req, res) => {
    try {
      const plano = manager.desativarPlano(Number(req.params.id));
      res.json({ plano });
    } catch (err) {
      res.status(err.message.includes('não existe') ? 404 : 400).json({ error: err.message });
    }
  });

  // ========== Vencimento por tenant ==========

  // Trocar plano: recalcula periodo_termina_em a partir de agora (a menos que
  // novoVencimento seja passado explicitamente como override).
  app.patch('/api/admin/tenants/:slug/plano', protect, (req, res) => {
    try {
      const { planoId, novoVencimento } = req.body || {};
      if (!planoId) return res.status(400).json({ error: 'planoId obrigatório' });
      const tenant = manager.setPlanoTenant({
        slug: req.params.slug,
        planoId: Number(planoId),
        novoVencimento,
        actor: req.superAdmin.email,
      });
      res.json({ tenant });
    } catch (err) {
      res.status(err.message.includes('não existe') ? 404 : 400).json({ error: err.message });
    }
  });

  // Renova: adiciona duracao_dias do plano atual ao vencimento.
  app.post('/api/admin/tenants/:slug/renovar', protect, (req, res) => {
    try {
      const tenant = manager.renovarTenant({ slug: req.params.slug, actor: req.superAdmin.email });
      res.json({ tenant });
    } catch (err) {
      res.status(err.message.includes('não existe') ? 404 : 400).json({ error: err.message });
    }
  });

  // Override manual de vencimento (sem mexer em plano).
  app.patch('/api/admin/tenants/:slug/vencimento', protect, (req, res) => {
    try {
      const { periodoTerminaEm } = req.body || {};
      const tenant = manager.estenderVencimento({
        slug: req.params.slug,
        periodoTerminaEm: periodoTerminaEm == null ? null : Number(periodoTerminaEm),
        actor: req.superAdmin.email,
      });
      res.json({ tenant });
    } catch (err) {
      res.status(err.message.includes('não existe') ? 404 : 400).json({ error: err.message });
    }
  });

  // Dispara o cron de expiração sob demanda (útil pra QA).
  app.post('/api/admin/expiry-check', protect, (req, res) => {
    try {
      const result = manager.runExpiryCheck({ actor: req.superAdmin.email });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/tenants/:slug/features', protect, (req, res) => {
    try {
      const tenant = manager.getTenantBySlug(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'tenant não existe' });
      const features = lerFeaturesDoTenant(manager.getDb(req.params.slug));
      res.json({
        features: FEATURES.map(f => ({ ...f, enabled: !!features[f.key] })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/admin/tenants/:slug/features', protect, (req, res) => {
    console.error('[features-patch]', {
      slug: req.params.slug,
      body: req.body,
      ip: req.ip,
      ua: req.get('user-agent'),
      ts: new Date().toISOString(),
      actor: req.superAdmin && req.superAdmin.email,
    });
    console.trace('[features-patch] stack');
    try {
      const { key, enabled } = req.body || {};
      if (!key || !FEATURES.find(f => f.key === key)) {
        return res.status(400).json({ error: `feature inválida (use uma de: ${FEATURES.map(f => f.key).join(', ')})` });
      }
      const tenant = manager.getTenantBySlug(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'tenant não existe' });
      const tenantDb = manager.getDb(req.params.slug);
      tenantDb.prepare(
        'INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)'
      ).run(key + '_enabled', enabled ? '1' : '0');
      manager.audit({
        tenantId: tenant.id, action: 'SET_FEATURE', actor: req.superAdmin.email,
        payload: { key, enabled: !!enabled },
      });
      res.json({ success: true, key, enabled: !!enabled });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ========== Split Asaas (taxa da plataforma) ==========
  //
  // Config global no control.db. O boleto-orchestrator lê daqui a cada emissão
  // e cai no env da unit enquanto uma chave não estiver gravada.

  const SPLIT_KEYS = {
    ativo: 'asaas_split_ativo',
    walletId: 'asaas_split_wallet_id',
    percentual: 'asaas_split_percentual',
    tetoBoleto: 'asaas_split_teto_boleto',
  };
  // Espelha TETO_BOLETO_PADRAO do boleto-orchestrator: enquanto a chave não
  // for gravada, é esse o teto que vale na emissão.
  const TETO_BOLETO_PADRAO = 2.00;

  function lerSplitGlobal() {
    const rows = controlDb.prepare(
      `SELECT chave, valor FROM config WHERE chave IN (?, ?, ?, ?)`
    ).all(SPLIT_KEYS.ativo, SPLIT_KEYS.walletId, SPLIT_KEYS.percentual, SPLIT_KEYS.tetoBoleto);
    const m = Object.fromEntries(rows.map(r => [r.chave, r.valor]));
    const gravado = k => m[k] != null && m[k] !== '';
    return {
      ativo: gravado(SPLIT_KEYS.ativo) ? m[SPLIT_KEYS.ativo] === '1' : true,
      walletId: gravado(SPLIT_KEYS.walletId)
        ? m[SPLIT_KEYS.walletId] : (process.env.ASAAS_PLATFORM_WALLET_ID || ''),
      percentual: gravado(SPLIT_KEYS.percentual)
        ? Number(m[SPLIT_KEYS.percentual]) : Number(process.env.ASAAS_PLATFORM_FEE_PERCENT),
      tetoBoleto: gravado(SPLIT_KEYS.tetoBoleto)
        ? Number(m[SPLIT_KEYS.tetoBoleto]) : TETO_BOLETO_PADRAO,
      origem: {
        ativo: gravado(SPLIT_KEYS.ativo) ? 'banco' : 'default',
        walletId: gravado(SPLIT_KEYS.walletId) ? 'banco' : 'env',
        percentual: gravado(SPLIT_KEYS.percentual) ? 'banco' : 'env',
        tetoBoleto: gravado(SPLIT_KEYS.tetoBoleto) ? 'banco' : 'default',
      },
    };
  }

  app.get('/api/admin/split-asaas', protect, (req, res) => {
    try {
      const global = lerSplitGlobal();
      const tenants = controlDb.prepare(`
        SELECT slug, name, split_asaas_modo AS modo, split_asaas_percentual AS percentual
          FROM tenants ORDER BY slug
      `).all();
      res.json({ global, tenants });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/split-asaas', protect, (req, res) => {
    try {
      const { ativo, walletId, percentual, tetoBoleto } = req.body || {};
      const wallet = String(walletId || '').trim();
      const pct = Number(percentual);
      const teto = Number(tetoBoleto);
      if (ativo) {
        if (!wallet) return res.status(400).json({ error: 'walletId obrigatório para ativar o split' });
        if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
          return res.status(400).json({ error: 'percentual deve ser > 0 e < 100' });
        }
        // Abaixo de R$ 0,01 o Asaas recusa o split; o teto seria um bloqueio total.
        if (!Number.isFinite(teto) || teto < 0.01) {
          return res.status(400).json({ error: 'teto por boleto deve ser >= 0,01' });
        }
      }
      const set = controlDb.prepare(
        'INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)'
      );
      controlDb.transaction(() => {
        set.run(SPLIT_KEYS.ativo, ativo ? '1' : '0');
        set.run(SPLIT_KEYS.walletId, wallet);
        set.run(SPLIT_KEYS.percentual, Number.isFinite(pct) ? String(pct) : '');
        set.run(SPLIT_KEYS.tetoBoleto, Number.isFinite(teto) ? String(teto) : '');
      })();
      manager.audit({
        tenantId: null, action: 'SET_SPLIT_ASAAS', actor: req.superAdmin.email,
        payload: { ativo: !!ativo, walletId: wallet, percentual: pct, tetoBoleto: teto },
      });
      res.json({ global: lerSplitGlobal() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/admin/tenants/:slug/split', protect, (req, res) => {
    try {
      const { modo, percentual } = req.body || {};
      if (!['padrao', 'isento', 'proprio'].includes(modo)) {
        return res.status(400).json({ error: "modo deve ser 'padrao', 'isento' ou 'proprio'" });
      }
      const pct = Number(percentual);
      if (modo === 'proprio' && (!Number.isFinite(pct) || pct <= 0 || pct >= 100)) {
        return res.status(400).json({ error: 'percentual deve ser > 0 e < 100' });
      }
      const tenant = manager.getTenantBySlug(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'tenant não existe' });
      controlDb.prepare(
        'UPDATE tenants SET split_asaas_modo = ?, split_asaas_percentual = ? WHERE slug = ?'
      ).run(modo, modo === 'proprio' ? pct : null, req.params.slug);
      manager.audit({
        tenantId: tenant.id, action: 'SET_SPLIT_TENANT', actor: req.superAdmin.email,
        payload: { modo, percentual: modo === 'proprio' ? pct : null },
      });
      res.json({ success: true, modo, percentual: modo === 'proprio' ? pct : null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/tenants', protect, (req, res) => {
    try {
      const { slug, name, ownerEmail, plan = 'basic', trialDays = 14, planoId } = req.body || {};
      if (!slug || !name) return res.status(400).json({ error: 'slug e name obrigatórios' });
      if (!manager.isValidSlug(slug)) {
        return res.status(400).json({ error: 'slug inválido (use a-z, 0-9, hífens, 2–32 chars)' });
      }
      if (manager.getTenantBySlug(slug)) {
        return res.status(409).json({ error: 'slug já existe' });
      }

      // Resolve status: se planoId aponta para TRIAL → TRIAL; senão usa trialDays legado.
      let status;
      if (planoId) {
        const plano = manager.getPlano(Number(planoId));
        if (!plano) return res.status(400).json({ error: 'planoId não existe' });
        status = plano.tipo === 'TRIAL' ? 'TRIAL' : 'ACTIVE';
      } else {
        status = trialDays > 0 ? 'TRIAL' : 'ACTIVE';
      }
      const tenant = manager.createTenant({
        slug, name, ownerEmail: ownerEmail || null, plan, status, trialDays,
        planoId: planoId ? Number(planoId) : null,
        actor: req.superAdmin.email,
      });

      const tenantDb = manager.getDb(slug);
      // Aplica migrations de TODOS os *-routes.js no DB novo. Re-registra
      // rotas num app throwaway só para executar os db.exec/seed que
      // vivem no escopo de registro de cada módulo. Sem isso, o tenant
      // teria só as tabelas de db-schema.js — ~40 tabelas a mais ficariam
      // de fora (contas_a_receber, comissoes, cte, etc.).
      applyRouteMigrations(tenantDb, tenant);
      const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
      const hash = bcrypt.hashSync(tempPassword, 10);
      tenantDb.prepare(
        "INSERT OR REPLACE INTO users (username, passwordHash, nome, role, ativo) VALUES (?, ?, ?, 'admin', 1)"
      ).run('admin', hash, 'Administrador');

      // Também garante um api_key do tenant (usado pelo Electron).
      let apiKeyRow = tenantDb.prepare("SELECT valor FROM config WHERE chave = 'api_key'").get();
      if (!apiKeyRow) {
        const apiKey = crypto.randomBytes(32).toString('hex');
        tenantDb.prepare(
          'INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)'
        ).run('api_key', apiKey);
        apiKeyRow = { valor: apiKey };
      }

      // Dispara provisionamento de vhost + SSL em background — não
      // bloqueia a resposta; UI consulta GET /api/admin/tenants para
      // ver provision_status evoluir (NOT_STARTED → PROVISIONING →
      // WAITING_DNS|READY|FAILED).
      spawnProvisionVhost(slug, manager);

      res.status(201).json({
        tenant,
        loginUrl: `https://${slug}.liciteagora.app/`,
        ownerCredentials: { username: 'admin', password: tempPassword },
        apiKey: apiKeyRow.valor,
        provisioning: true,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/admin/tenants/:slug/status', protect, (req, res) => {
    try {
      const { status } = req.body || {};
      const allowed = ['ACTIVE', 'TRIAL', 'OVERDUE', 'SUSPENDED', 'CANCELLED'];
      if (!allowed.includes(status)) {
        return res.status(400).json({ error: `status inválido (use um de: ${allowed.join(', ')})` });
      }
      const updated = manager.setStatus({ slug: req.params.slug, status, actor: req.superAdmin.email });
      res.json({ tenant: updated });
    } catch (err) {
      res.status(err.message.includes('não existe') ? 404 : 500).json({ error: err.message });
    }
  });

  app.post('/api/admin/tenants/:slug/reset-password', protect, (req, res) => {
    try {
      const tenant = manager.getTenantBySlug(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'tenant não existe' });
      const tenantDb = manager.getDb(req.params.slug);
      const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
      const hash = bcrypt.hashSync(tempPassword, 10);
      const info = tenantDb.prepare(
        "UPDATE users SET passwordHash = ? WHERE username = 'admin'"
      ).run(hash);
      if (info.changes === 0) {
        // Se não existe admin, cria
        tenantDb.prepare(
          "INSERT INTO users (username, passwordHash, nome, role, ativo) VALUES (?, ?, ?, 'admin', 1)"
        ).run('admin', hash, 'Administrador');
      }
      manager.audit({ tenantId: tenant.id, action: 'RESET_ADMIN_PASSWORD', actor: req.superAdmin.email });
      res.json({ username: 'admin', password: tempPassword });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/tenants/:slug/billing/paid', protect, (req, res) => {
    try {
      const { method = 'PIX', amountCents = 0, nextDueAt = null, notes = null } = req.body || {};
      const tenant = manager.getTenantBySlug(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'tenant não existe' });
      controlDb.prepare(`
        INSERT INTO tenant_billing (tenant_id, method, last_paid_at, next_due_at, amount_cents, notes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
          method = excluded.method,
          last_paid_at = excluded.last_paid_at,
          next_due_at = excluded.next_due_at,
          amount_cents = excluded.amount_cents,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `).run(tenant.id, method, Date.now(), nextDueAt, amountCents, notes, Date.now());
      manager.audit({
        tenantId: tenant.id,
        action: 'BILLING_PAID',
        actor: req.superAdmin.email,
        payload: { method, amountCents, nextDueAt },
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Re-dispara o provisionamento de vhost/SSL (caso inicial falhou
  // por DNS ou bug). Idempotente graças ao exit 20 do script.
  app.post('/api/admin/tenants/:slug/reprovision', protect, (req, res) => {
    try {
      const tenant = manager.getTenantBySlug(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'tenant não existe' });
      spawnProvisionVhost(req.params.slug, manager);
      res.json({ success: true, message: 'reprovisionamento iniciado em background' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/tenants/:slug/audit', protect, (req, res) => {
    try {
      const tenant = manager.getTenantBySlug(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'tenant não existe' });
      const rows = controlDb.prepare(
        'SELECT id, action, actor, payload, at FROM tenant_audit WHERE tenant_id = ? ORDER BY at DESC LIMIT 200'
      ).all(tenant.id);
      res.json({ audit: rows.map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[ControlPlane] Rotas /api/admin/* registradas');
}

module.exports = { registerControlPlaneRoutes, ADMIN_HOST, spawnProvisionVhost, applyRouteMigrations };
