// tenant-manager.js
//
// Infraestrutura multi-tenant do Liciteagora. Cada cliente é um "tenant"
// com seu próprio arquivo SQLite em data/tenants/<slug>/pncp.db. Este
// módulo gerencia:
//
//   1. control.db  — metadados globais (tenants, billing, audit,
//                    super_admins). Um único arquivo em data/control.db.
//   2. Pool lazy   — Map<slug, Database> aberto sob demanda e reusado
//                    durante a vida do processo.
//   3. Resolução   — resolveFromHost('1bit.liciteagora.app') → '1bit'
//   4. CRUD tenant — create/load/list/updateStatus/audit.
//
// O schema do tenant (pncp.db com ~35 tabelas) é aplicado via
// initSchema(db) do módulo db-schema.js — reusamos exatamente o que o
// single-tenant já usa, sem fork.
//
// Não abre nenhum DB até ser chamado. O boot do server cria a instância
// via createTenantManager() e registra o middleware; as conexões ficam
// dormentes até a primeira request.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { attachCatalog, CATALOG_DB_PATH } = require('./catalog-manager');
const { ensurePlanModulesSchema } = require('./plan-modules');
const { ensureOverridesSchema } = require('./module-gate');

const ROOT = path.join(__dirname, 'data');
const CONTROL_DB_PATH = path.join(ROOT, 'control.db');
const TENANTS_DIR = path.join(ROOT, 'tenants');
const APEX_DOMAIN = 'liciteagora.app';

// Hosts que NÃO são tenants — caem em rotas globais (landing, admin).
const RESERVED_SLUGS = new Set(['www', 'admin', 'api', 'static', 'cdn']);

// ========== Schema do control.db ==========

const CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'TRIAL',
  plan TEXT DEFAULT 'basic',
  owner_email TEXT,
  db_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  trial_ends_at INTEGER,
  suspended_at INTEGER,
  notes TEXT,
  provision_status TEXT DEFAULT 'NOT_STARTED',
  provision_message TEXT,
  provision_updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

CREATE TABLE IF NOT EXISTS tenant_billing (
  tenant_id INTEGER NOT NULL,
  method TEXT,
  last_paid_at INTEGER,
  next_due_at INTEGER,
  amount_cents INTEGER,
  notes TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id)
);

CREATE TABLE IF NOT EXISTS tenant_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER,
  action TEXT NOT NULL,
  actor TEXT,
  payload TEXT,
  at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant ON tenant_audit(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON tenant_audit(at);

CREATE TABLE IF NOT EXISTS super_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS super_admin_sessions (
  sid TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (admin_id) REFERENCES super_admins(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT,
  dataAtualizacao TEXT
);

CREATE TABLE IF NOT EXISTS planos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  descricao TEXT,
  tipo TEXT NOT NULL,                       -- 'TRIAL' | 'MENSAL' | 'ANUAL' | 'VITALICIO' | 'CUSTOM'
  duracao_dias INTEGER,                     -- NULL = vitalício/sem vencimento
  dias_carencia INTEGER NOT NULL DEFAULT 0,
  preco_centavos INTEGER,                   -- informativo (não cobra automaticamente)
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_planos_ativo ON planos(ativo);
`;

const PLANOS_DEFAULT = [
  { slug: 'trial-14',  nome: 'Trial 14 dias',     tipo: 'TRIAL',     duracao_dias: 14,   dias_carencia: 0, preco_centavos: 0 },
  { slug: 'mensal',    nome: 'Mensal',            tipo: 'MENSAL',    duracao_dias: 30,   dias_carencia: 3, preco_centavos: null },
  { slug: 'anual',     nome: 'Anual',             tipo: 'ANUAL',     duracao_dias: 365,  dias_carencia: 7, preco_centavos: null },
  { slug: 'vitalicio', nome: 'Vitalício/Interno', tipo: 'VITALICIO', duracao_dias: null, dias_carencia: 0, preco_centavos: 0 },
];

function ensureDirs() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
  if (!fs.existsSync(TENANTS_DIR)) fs.mkdirSync(TENANTS_DIR, { recursive: true });
}

function initControlDb(dbPath = CONTROL_DB_PATH) {
  ensureDirs();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CONTROL_SCHEMA);
  // Migrações idempotentes em tenants (para DBs criados antes).
  for (const sql of [
    "ALTER TABLE tenants ADD COLUMN provision_status TEXT DEFAULT 'NOT_STARTED'",
    'ALTER TABLE tenants ADD COLUMN provision_message TEXT',
    'ALTER TABLE tenants ADD COLUMN provision_updated_at INTEGER',
    // Vencimento por plano (2026-04-29).
    'ALTER TABLE tenants ADD COLUMN plano_id INTEGER REFERENCES planos(id)',
    'ALTER TABLE tenants ADD COLUMN periodo_termina_em INTEGER',
    // Split Asaas por tenant (2026-08-20): 'padrao' | 'isento' | 'proprio'.
    // NULL = nunca configurado no admin → segue o percentual global.
    'ALTER TABLE tenants ADD COLUMN split_asaas_modo TEXT',
    'ALTER TABLE tenants ADD COLUMN split_asaas_percentual REAL',
  ]) {
    try { db.exec(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }

  // Migra a isenção que hoje vive em ASAAS_PLATFORM_TENANT_SLUG para o banco,
  // uma única vez — só onde ainda não há escolha gravada. Sem isso o admin
  // mostraria o tenant da plataforma como "padrão" enquanto o env o isenta.
  const slugIsentoEnv = process.env.ASAAS_PLATFORM_TENANT_SLUG;
  if (slugIsentoEnv) {
    db.prepare(
      "UPDATE tenants SET split_asaas_modo = 'isento' WHERE slug = ? AND split_asaas_modo IS NULL"
    ).run(slugIsentoEnv);
  }

  // Seed dos planos default (idempotente via INSERT OR IGNORE pelo slug UNIQUE).
  const insPlano = db.prepare(`
    INSERT OR IGNORE INTO planos
      (slug, nome, descricao, tipo, duracao_dias, dias_carencia, preco_centavos, ativo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const seedAt = Date.now();
  for (const p of PLANOS_DEFAULT) {
    insPlano.run(p.slug, p.nome, null, p.tipo, p.duracao_dias, p.dias_carencia, p.preco_centavos, seedAt);
  }

  // Backfill de tenants pré-existentes: atribui plano_id e periodo_termina_em
  // baseado em status atual e dados que já tinha (trial_ends_at / next_due_at).
  // Idempotente: só preenche quem está com plano_id NULL.
  const idTrial = db.prepare("SELECT id FROM planos WHERE slug = 'trial-14'").get()?.id;
  const idMensal = db.prepare("SELECT id FROM planos WHERE slug = 'mensal'").get()?.id;
  if (idTrial && idMensal) {
    // Tenants TRIAL → trial-14 + periodo = trial_ends_at
    db.prepare(`
      UPDATE tenants
         SET plano_id = ?,
             periodo_termina_em = COALESCE(trial_ends_at, periodo_termina_em)
       WHERE plano_id IS NULL AND status = 'TRIAL'
    `).run(idTrial);
    // Tenants ACTIVE → mensal + periodo = next_due_at (se houver)
    db.prepare(`
      UPDATE tenants
         SET plano_id = ?,
             periodo_termina_em = COALESCE(
               (SELECT next_due_at FROM tenant_billing WHERE tenant_id = tenants.id),
               periodo_termina_em
             )
       WHERE plano_id IS NULL AND status = 'ACTIVE'
    `).run(idMensal);
  }

  // Seed dos módulos por tier + tabela de overrides (idempotente).
  ensurePlanModulesSchema(db);
  ensureOverridesSchema(db);

  return db;
}

// ========== Resolução de host ==========
//
// liciteagora.app        → { kind: 'apex' }
// www.liciteagora.app    → { kind: 'apex' }
// admin.liciteagora.app  → { kind: 'admin' }
// <slug>.liciteagora.app → { kind: 'tenant', slug }
// qualquer outra         → { kind: 'unknown' }

function resolveFromHost(host) {
  if (!host) return { kind: 'unknown' };
  // host pode vir com porta: "1bit.liciteagora.app:3000"
  const hostname = host.split(':')[0].toLowerCase();

  if (hostname === APEX_DOMAIN) return { kind: 'apex' };

  const suffix = '.' + APEX_DOMAIN;
  if (!hostname.endsWith(suffix)) return { kind: 'unknown' };

  const sub = hostname.slice(0, -suffix.length);
  if (!sub || sub.includes('.')) return { kind: 'unknown' };

  if (sub === 'www') return { kind: 'apex' };
  if (sub === 'admin') return { kind: 'admin' };
  if (RESERVED_SLUGS.has(sub)) return { kind: 'reserved', slug: sub };

  return { kind: 'tenant', slug: sub };
}

function isValidSlug(slug) {
  return /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(slug) && !RESERVED_SLUGS.has(slug);
}

// ========== Manager (fábrica) ==========

function createTenantManager({ initSchema, controlDbPath = CONTROL_DB_PATH } = {}) {
  if (typeof initSchema !== 'function') {
    throw new Error('tenant-manager: initSchema (de db-schema.js) é obrigatório');
  }

  ensureDirs();
  const control = initControlDb(controlDbPath);

  // Pool de conexões por-tenant. Map<slug, Database>.
  const pool = new Map();

  const stmtGetBySlug = control.prepare('SELECT * FROM tenants WHERE slug = ?');
  const stmtListActive = control.prepare(
    "SELECT * FROM tenants WHERE status IN ('ACTIVE','TRIAL') ORDER BY slug"
  );
  const stmtListAll = control.prepare('SELECT * FROM tenants ORDER BY created_at DESC');
  const stmtInsertTenant = control.prepare(`
    INSERT INTO tenants (slug, name, status, plan, owner_email, db_path, created_at, trial_ends_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtUpdateStatus = control.prepare(
    'UPDATE tenants SET status = ?, suspended_at = ? WHERE slug = ?'
  );
  const stmtAudit = control.prepare(
    'INSERT INTO tenant_audit (tenant_id, action, actor, payload, at) VALUES (?, ?, ?, ?, ?)'
  );

  // ========== Planos ==========

  const stmtListPlanos = control.prepare('SELECT * FROM planos ORDER BY ativo DESC, nome');
  const stmtListPlanosAtivos = control.prepare('SELECT * FROM planos WHERE ativo = 1 ORDER BY nome');
  const stmtGetPlano = control.prepare('SELECT * FROM planos WHERE id = ?');
  const stmtGetPlanoBySlug = control.prepare('SELECT * FROM planos WHERE slug = ?');
  const stmtInsertPlano = control.prepare(`
    INSERT INTO planos (slug, nome, descricao, tipo, duracao_dias, dias_carencia, preco_centavos, ativo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const stmtSetPlanoTenant = control.prepare(
    'UPDATE tenants SET plano_id = ?, periodo_termina_em = ? WHERE slug = ?'
  );
  const stmtUpdatePeriodo = control.prepare(
    'UPDATE tenants SET periodo_termina_em = ? WHERE slug = ?'
  );
  const stmtUpdateStatusComPeriodo = control.prepare(
    'UPDATE tenants SET status = ?, suspended_at = ?, periodo_termina_em = COALESCE(?, periodo_termina_em) WHERE slug = ?'
  );

  const PLANO_TIPOS = new Set(['TRIAL', 'MENSAL', 'ANUAL', 'VITALICIO', 'CUSTOM']);

  function listPlanos({ apenasAtivos = false } = {}) {
    return apenasAtivos ? stmtListPlanosAtivos.all() : stmtListPlanos.all();
  }
  function getPlano(id) {
    return stmtGetPlano.get(id) || null;
  }
  function getPlanoBySlug(slug) {
    return stmtGetPlanoBySlug.get(slug) || null;
  }

  function criarPlano({ slug, nome, descricao = null, tipo, duracao_dias = null, dias_carencia = 0, preco_centavos = null }) {
    if (!slug || !nome || !tipo) throw new Error('planos: slug, nome e tipo obrigatórios');
    if (!PLANO_TIPOS.has(tipo)) throw new Error(`planos: tipo inválido (use ${[...PLANO_TIPOS].join(', ')})`);
    if (tipo !== 'VITALICIO' && (duracao_dias == null || Number(duracao_dias) <= 0)) {
      throw new Error('planos: duracao_dias > 0 obrigatório quando tipo != VITALICIO');
    }
    if (getPlanoBySlug(slug)) throw new Error(`planos: slug "${slug}" já existe`);
    const r = stmtInsertPlano.run(
      slug, nome, descricao, tipo,
      tipo === 'VITALICIO' ? null : Number(duracao_dias),
      Number(dias_carencia) || 0,
      preco_centavos == null ? null : Number(preco_centavos),
      Date.now()
    );
    return getPlano(r.lastInsertRowid);
  }

  function atualizarPlano(id, patch) {
    const atual = getPlano(id);
    if (!atual) throw new Error(`planos: id ${id} não existe`);
    const sets = [], vals = [];
    if (patch.nome !== undefined)      { sets.push('nome = ?');      vals.push(patch.nome); }
    if (patch.descricao !== undefined) { sets.push('descricao = ?'); vals.push(patch.descricao || null); }
    if (patch.tipo !== undefined) {
      if (!PLANO_TIPOS.has(patch.tipo)) throw new Error(`planos: tipo inválido`);
      sets.push('tipo = ?'); vals.push(patch.tipo);
    }
    if (patch.duracao_dias !== undefined) {
      sets.push('duracao_dias = ?'); vals.push(patch.duracao_dias == null ? null : Number(patch.duracao_dias));
    }
    if (patch.dias_carencia !== undefined) {
      sets.push('dias_carencia = ?'); vals.push(Number(patch.dias_carencia) || 0);
    }
    if (patch.preco_centavos !== undefined) {
      sets.push('preco_centavos = ?'); vals.push(patch.preco_centavos == null ? null : Number(patch.preco_centavos));
    }
    if (patch.ativo !== undefined) {
      sets.push('ativo = ?'); vals.push(patch.ativo ? 1 : 0);
    }
    if (!sets.length) return atual;
    vals.push(id);
    control.prepare(`UPDATE planos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return getPlano(id);
  }

  function desativarPlano(id) {
    return atualizarPlano(id, { ativo: 0 });
  }

  // ========== Vencimento de tenant ==========

  function _calcularVencimento(plano, baseTs = Date.now()) {
    if (!plano || plano.tipo === 'VITALICIO' || !plano.duracao_dias) return null;
    return baseTs + Number(plano.duracao_dias) * 86400 * 1000;
  }

  // Define plano do tenant. Recalcula periodo_termina_em a partir de agora
  // (a menos que `novoVencimento` seja passado explicitamente — admin override).
  function setPlanoTenant({ slug, planoId, novoVencimento = undefined, actor = 'system' }) {
    const tenant = getTenantBySlug(slug);
    if (!tenant) throw new Error(`tenant-manager: tenant "${slug}" não existe`);
    const plano = getPlano(planoId);
    if (!plano) throw new Error(`planos: id ${planoId} não existe`);
    const venc = novoVencimento !== undefined
      ? (novoVencimento == null ? null : Number(novoVencimento))
      : _calcularVencimento(plano);
    stmtSetPlanoTenant.run(plano.id, venc, slug);
    audit({
      tenantId: tenant.id,
      action: 'SET_PLANO',
      actor,
      payload: { from: tenant.plano_id, to: plano.id, slug: plano.slug, periodo_termina_em: venc },
    });
    return getTenantBySlug(slug);
  }

  // Adiciona duracao_dias do plano atual ao vencimento (ou ao now se já passou).
  function renovarTenant({ slug, actor = 'system' }) {
    const tenant = getTenantBySlug(slug);
    if (!tenant) throw new Error(`tenant-manager: tenant "${slug}" não existe`);
    if (!tenant.plano_id) throw new Error(`tenant "${slug}" sem plano definido`);
    const plano = getPlano(tenant.plano_id);
    if (!plano || plano.tipo === 'VITALICIO' || !plano.duracao_dias) {
      throw new Error(`plano do tenant "${slug}" não é renovável`);
    }
    const now = Date.now();
    const base = (tenant.periodo_termina_em && tenant.periodo_termina_em > now)
      ? tenant.periodo_termina_em : now;
    const novoVenc = base + Number(plano.duracao_dias) * 86400 * 1000;
    // Se estava SUSPENDED ou OVERDUE, volta a ACTIVE/TRIAL conforme plano.
    const novoStatus = (tenant.status === 'SUSPENDED' || tenant.status === 'OVERDUE')
      ? (plano.tipo === 'TRIAL' ? 'TRIAL' : 'ACTIVE')
      : tenant.status;
    stmtUpdateStatusComPeriodo.run(novoStatus, null, novoVenc, slug);
    audit({
      tenantId: tenant.id,
      action: 'RENOVAR',
      actor,
      payload: { plano: plano.slug, from: tenant.periodo_termina_em, to: novoVenc, status: novoStatus },
    });
    return getTenantBySlug(slug);
  }

  // Override manual da data de vencimento (sem mexer em plano).
  function estenderVencimento({ slug, periodoTerminaEm, actor = 'system' }) {
    const tenant = getTenantBySlug(slug);
    if (!tenant) throw new Error(`tenant-manager: tenant "${slug}" não existe`);
    const ts = periodoTerminaEm == null ? null : Number(periodoTerminaEm);
    stmtUpdatePeriodo.run(ts, slug);
    audit({
      tenantId: tenant.id,
      action: 'ESTENDER_VENCIMENTO',
      actor,
      payload: { from: tenant.periodo_termina_em, to: ts },
    });
    return getTenantBySlug(slug);
  }

  // Varre tenants e aplica transição automática:
  //   periodo_termina_em < now <= periodo_termina_em + carencia → OVERDUE
  //   now > periodo_termina_em + carencia                       → SUSPENDED
  //   now < periodo_termina_em e estava OVERDUE                  → volta para ACTIVE/TRIAL
  function runExpiryCheck({ actor = 'cron' } = {}) {
    const now = Date.now();
    const tenants = control.prepare(`
      SELECT t.*, p.tipo AS plano_tipo, p.dias_carencia AS plano_carencia
      FROM tenants t
      LEFT JOIN planos p ON p.id = t.plano_id
      WHERE t.status IN ('ACTIVE', 'TRIAL', 'OVERDUE')
    `).all();
    const transitions = [];
    for (const t of tenants) {
      const venc = t.periodo_termina_em;
      if (!venc) continue; // vitalício / sem vencimento
      const carenciaMs = (Number(t.plano_carencia) || 0) * 86400 * 1000;
      const limiteSuspensao = venc + carenciaMs;
      let novoStatus = t.status;
      if (now < venc) {
        // Voltou para dentro da validade — só transita se estava OVERDUE.
        if (t.status === 'OVERDUE') {
          novoStatus = (t.plano_tipo === 'TRIAL') ? 'TRIAL' : 'ACTIVE';
        }
      } else if (now <= limiteSuspensao) {
        if (t.status !== 'OVERDUE') novoStatus = 'OVERDUE';
      } else {
        if (t.status !== 'SUSPENDED') novoStatus = 'SUSPENDED';
      }
      if (novoStatus !== t.status) {
        const suspendedAt = novoStatus === 'SUSPENDED' ? now : null;
        stmtUpdateStatus.run(novoStatus, suspendedAt, t.slug);
        audit({
          tenantId: t.id,
          action: 'AUTO_EXPIRE',
          actor,
          payload: { from: t.status, to: novoStatus, vencimento: venc, carenciaDias: t.plano_carencia || 0 },
        });
        transitions.push({ slug: t.slug, from: t.status, to: novoStatus });
      }
    }
    return { checkedAt: now, total: tenants.length, transitions };
  }

  function tenantDbPath(slug) {
    return path.join(TENANTS_DIR, slug, 'pncp.db');
  }

  function getTenantBySlug(slug) {
    if (!slug) return null;
    const row = stmtGetBySlug.get(slug);
    return row || null;
  }

  function listActive() {
    return stmtListActive.all();
  }

  function listAll() {
    return stmtListAll.all();
  }

  function getDb(slug) {
    let db = pool.get(slug);
    if (db) return db;

    const tenant = getTenantBySlug(slug);
    if (!tenant) {
      throw new Error(`tenant-manager: tenant "${slug}" não existe`);
    }
    if (!fs.existsSync(tenant.db_path)) {
      throw new Error(`tenant-manager: db_path "${tenant.db_path}" não encontrado`);
    }

    db = new Database(tenant.db_path);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');

    // Auto-migração no primeiro open de cada tenant (2026-04-23):
    // rodar initSchema é idempotente (CREATE TABLE IF NOT EXISTS +
    // alterSafe ignora coluna existente). Isso evita que tenants
    // criados antes de uma nova coluna fiquem defasados — problema
    // que causou erro "table X has no column named Y" em produção.
    // FK OFF durante initSchema porque alguns seeds inserem antes
    // das FKs existirem; ligamos de volta depois.
    db.pragma('foreign_keys = OFF');
    try {
      initSchema(db);
    } catch (err) {
      console.error(`[tenant-manager] initSchema falhou em "${slug}":`, err.message);
    }
    db.pragma('foreign_keys = ON');

    // Fase 8 (2026-04-22): ATTACH catalog.db + cria TEMP VIEWs para
    // licitacoes/itens/resultados_bi/orgaos_lookup + catalog_sync_state.
    // Após isso, SELECTs existentes em qualquer dessas tabelas no tenant
    // DB funcionam sem mudança de código. Writes nelas via tenant DB são
    // rejeitados (view). Os writers do worker (bi/pedidos/analise-ia)
    // usam prefix catalog.<tabela>.
    if (fs.existsSync(CATALOG_DB_PATH)) {
      try { attachCatalog(db); }
      catch (err) { console.error(`[tenant-manager] attachCatalog falhou em "${slug}":`, err.message); }
    }

    pool.set(slug, db);
    return db;
  }

  function audit({ tenantId = null, action, actor = null, payload = null }) {
    const payloadStr = payload == null ? null : JSON.stringify(payload);
    stmtAudit.run(tenantId, action, actor, payloadStr, Date.now());
  }

  // Cria um tenant novo: diretório, pncp.db vazio, schema, registro
  // em control.db. NÃO cria usuário admin nem vhost — isso fica no
  // tenant-provision.js (que também roda `v-add-web-domain`).
  function createTenant({ slug, name, ownerEmail = null, plan = 'basic', status = 'TRIAL', trialDays = 14, planoId = null, actor = 'system' }) {
    if (!isValidSlug(slug)) {
      throw new Error(`tenant-manager: slug inválido "${slug}"`);
    }
    if (getTenantBySlug(slug)) {
      throw new Error(`tenant-manager: slug "${slug}" já existe`);
    }

    const dir = path.join(TENANTS_DIR, slug);
    const dbPath = tenantDbPath(slug);

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(dbPath)) {
      throw new Error(`tenant-manager: ${dbPath} já existe mas tenant não está registrado`);
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // foreign_keys DESLIGADO durante initSchema porque há seeds que
    // INSERT em tabelas com FK para outras que serão criadas depois
    // (via applyRouteMigrations no control-plane). Depois de popular
    // tudo, foreign_keys volta a ON.
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    db.close(); // pool abrirá de novo com FK ON (ver getDb)

    const now = Date.now();

    // Resolve plano: explícito > default por status (TRIAL → trial-14, ACTIVE → mensal).
    let plano = planoId ? getPlano(planoId) : null;
    if (!plano) {
      const slugDefault = status === 'TRIAL' ? 'trial-14' : 'mensal';
      plano = getPlanoBySlug(slugDefault);
    }
    // Vencimento vem do plano; legado: se ainda for TRIAL e plano falhar, usa trialDays.
    let periodoTerminaEm = _calcularVencimento(plano, now);
    if (periodoTerminaEm == null && status === 'TRIAL' && trialDays > 0) {
      periodoTerminaEm = now + trialDays * 86400 * 1000;
    }
    // Compat: trial_ends_at antigo continua sendo populado quando faz sentido.
    const trialEnds = status === 'TRIAL' ? periodoTerminaEm : null;

    const info = stmtInsertTenant.run(
      slug, name, status, plan, ownerEmail, dbPath, now, trialEnds
    );
    if (plano && periodoTerminaEm !== null) {
      stmtSetPlanoTenant.run(plano.id, periodoTerminaEm, slug);
    } else if (plano) {
      stmtSetPlanoTenant.run(plano.id, null, slug);
    }

    audit({
      tenantId: info.lastInsertRowid,
      action: 'CREATE',
      actor,
      payload: { slug, name, plan, status, planoId: plano?.id, planoSlug: plano?.slug, periodoTerminaEm },
    });

    return getTenantBySlug(slug);
  }

  // Registra um tenant para um DB que JÁ EXISTE no disco (sem criar
  // schema novo). Usado na migração inicial: data/tenants/1bit/pncp.db
  // já foi movido do lugar antigo, só precisa registro.
  function registerExistingTenant({ slug, name, ownerEmail = null, plan = 'basic', status = 'ACTIVE', actor = 'system' }) {
    if (!isValidSlug(slug)) {
      throw new Error(`tenant-manager: slug inválido "${slug}"`);
    }
    if (getTenantBySlug(slug)) {
      throw new Error(`tenant-manager: slug "${slug}" já existe`);
    }
    const dbPath = tenantDbPath(slug);
    if (!fs.existsSync(dbPath)) {
      throw new Error(`tenant-manager: db_path "${dbPath}" não existe — mova o arquivo primeiro`);
    }

    const now = Date.now();
    const info = stmtInsertTenant.run(
      slug, name, status, plan, ownerEmail, dbPath, now, null
    );

    audit({
      tenantId: info.lastInsertRowid,
      action: 'REGISTER',
      actor,
      payload: { slug, name, dbPath },
    });

    return getTenantBySlug(slug);
  }

  const stmtUpdateProvision = control.prepare(
    'UPDATE tenants SET provision_status = ?, provision_message = ?, provision_updated_at = ? WHERE slug = ?'
  );

  function setProvisionStatus({ slug, status, message = null }) {
    stmtUpdateProvision.run(status, message, Date.now(), slug);
  }

  function setStatus({ slug, status, actor = 'system' }) {
    const tenant = getTenantBySlug(slug);
    if (!tenant) throw new Error(`tenant-manager: tenant "${slug}" não existe`);
    const suspendedAt = status === 'SUSPENDED' ? Date.now() : null;
    stmtUpdateStatus.run(status, suspendedAt, slug);
    audit({
      tenantId: tenant.id,
      action: 'SET_STATUS',
      actor,
      payload: { from: tenant.status, to: status },
    });
    return getTenantBySlug(slug);
  }

  function closeAll() {
    for (const [, db] of pool) {
      try { db.close(); } catch (_) { /* ignora */ }
    }
    pool.clear();
    try { control.close(); } catch (_) { /* ignora */ }
  }

  return {
    // Resolução
    resolveFromHost,
    isValidSlug,
    // Leitura
    getTenantBySlug,
    listActive,
    listAll,
    getDb,
    // Mutação
    createTenant,
    registerExistingTenant,
    setStatus,
    setProvisionStatus,
    audit,
    // Planos
    listPlanos,
    getPlano,
    getPlanoBySlug,
    criarPlano,
    atualizarPlano,
    desativarPlano,
    // Vencimento
    setPlanoTenant,
    renovarTenant,
    estenderVencimento,
    runExpiryCheck,
    // Baixo nível
    controlDb: control,
    pool,
    closeAll,
    // Constantes
    APEX_DOMAIN,
    RESERVED_SLUGS,
  };
}

module.exports = {
  createTenantManager,
  resolveFromHost,
  isValidSlug,
  APEX_DOMAIN,
  RESERVED_SLUGS,
  CONTROL_DB_PATH,
  TENANTS_DIR,
};
