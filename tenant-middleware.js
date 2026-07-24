// tenant-middleware.js
//
// Middleware Express + utilitários para runtime multi-tenant.
//
// Estratégia: usamos AsyncLocalStorage para manter o tenant atual
// "pendurado" na chain async da request. Um Proxy sobre better-sqlite3
// delega toda propriedade/método para o DB do tenant ativo no store.
//
// Isso permite manter as ~50 rotas existentes (que recebem `db`
// como parâmetro fixo em registerProtectedRoutes) sem reescrever
// cada handler. No boot passamos o PROXY em vez de um Database real;
// a cada request, o middleware popula o store e todas as chamadas
// subsequentes resolvem para o DB correto.
//
// Edge case conhecido: se algum módulo chamar `db.prepare(...)` no
// momento do REQUIRE (fora de um handler), o store está vazio e o
// proxy lança. Precisa ser dentro de função, acionada por request.
// Código atual do projeto segue esse padrão (verificado no registry).

const { AsyncLocalStorage } = require('async_hooks');

const tenantStorage = new AsyncLocalStorage();

function getStore() {
  return tenantStorage.getStore() || null;
}

function currentTenant() {
  const s = getStore();
  return s ? s.tenant : null;
}

function currentDb() {
  const s = getStore();
  if (!s || !s.db) {
    throw new Error('tenant-middleware: currentDb() chamado fora de contexto de tenant');
  }
  return s.db;
}

// Proxy que delega para o DB do tenant atual. Repassa prepare/exec/
// transaction/pragma/etc. Propriedades diretas (ex.: db.name) também
// funcionam via Reflect.get.
// Stub de DB usado em contexto de BOOT: todas as chamadas viram no-op.
// Objetivo: permitir que ~30 módulos de rota chamem db.exec(CREATE...),
// db.prepare(SQL).run(...) etc. no escopo de registro sem crashar o
// boot. Essas migrations/seeds JÁ são aplicadas em cada tenant via
// db-schema.js durante o provisionamento — aqui são pura redundância
// do tempo single-tenant. Em runtime (dentro de um request), o proxy
// cai no caminho real e usa o DB do tenant resolvido.
// Retornamos {} (não undefined) do .get() para que código comum como
// `row.valor` seja `undefined` (falsy, igual a registro não encontrado)
// em vez de quebrar com "Cannot read properties of undefined". Para
// checagens tipo `count.c === 0`, `undefined === 0` é false — skip
// do seed, comportamento correto para contexto de boot.
const BOOT_STUB_STMT = {
  run: () => ({ changes: 0, lastInsertRowid: 0 }),
  get: () => ({}),
  all: () => [],
  iterate: function* () { /* empty */ },
  finalize: () => {},
  pluck: function () { return this; },
  expand: function () { return this; },
  raw: function () { return this; },
  columns: () => [],
  bind: function () { return this; },
  safeIntegers: function () { return this; },
};

const BOOT_STUB = {
  exec: () => {},
  prepare: () => BOOT_STUB_STMT,
  pragma: () => [],
  transaction: (fn) => fn,
  function: () => {},
  aggregate: () => {},
  loadExtension: () => {},
  close: () => {},
  backup: () => Promise.resolve(),
  serialize: () => Buffer.alloc(0),
  inTransaction: false,
  readonly: false,
  memory: false,
  open: false,
};

function createDbProxy() {
  return new Proxy(Object.create(null), {
    get(_, prop) {
      const store = tenantStorage.getStore();
      // Contexto de BOOT: retorna stubs no-op. As migrations/seeds
      // que rodam aqui são idempotentes e redundantes (db-schema.js
      // aplica por-tenant no provisionamento).
      if (store && store.kind === 'boot') {
        if (prop === '__real') return null;
        return BOOT_STUB[prop];
      }
      // Convenção: __real expõe o DB cru (não proxificado) para quem
      // precisa chave estável de WeakMap (ver stmt-cache.js). Retorna
      // null em contextos sem tenant (admin, apex) para que o chamador
      // possa fazer fallback (ver createSessionStore).
      if (prop === '__real') {
        const s = tenantStorage.getStore();
        return s && s.db ? s.db : null;
      }
      const db = currentDb();
      const value = db[prop];
      if (typeof value === 'function') return value.bind(db);
      return value;
    },
    set(_, prop, value) {
      const store = tenantStorage.getStore();
      if (store && store.kind === 'boot') return true; // no-op
      currentDb()[prop] = value;
      return true;
    },
    has(_, prop) {
      const store = tenantStorage.getStore();
      if (store && store.kind === 'boot') return prop in BOOT_STUB;
      return prop in currentDb();
    },
  });
}

// Executa fn dentro de um contexto de BOOT — proxy vira no-op.
// Usado por tenant-bootstrap para rodar registerProtectedRoutes sem
// um tenant real no storage.
function runInBootContext(fn) {
  return tenantStorage.run({ kind: 'boot', tenant: null, db: null }, fn);
}

// Middleware que detecta o tenant pelo Host e corre o restante da
// chain dentro de tenantStorage.run(). Hosts reservados (apex, admin)
// populam um marker no store ao invés de falhar — rotas específicas
// podem checar tenantCtx.kind.
//
// opts:
//   manager     — createTenantManager() instance
//   onUnknown   — (req,res) → void. Default: 404 HTML neutro.
//   onSuspended — (req,res,tenant) → void. Default: 402 "pagamento pendente".
//   allowWithoutTenant — (req) => bool. Retorne true para bypass (ex.:
//                                        rotas /admin/*, /health, ACME challenge).
function createTenantMiddleware({
  manager,
  onUnknown,
  onSuspended,
  allowWithoutTenant,
} = {}) {
  if (!manager) throw new Error('tenant-middleware: opts.manager é obrigatório');

  const defaultOnUnknown = (req, res) => {
    res.status(404).type('text/html').send(
      '<!doctype html><meta charset="utf-8"><title>Não encontrado</title>' +
      '<h1>404 — Tenant não encontrado</h1>' +
      '<p>O subdomínio <code>' +
      escapeHtml(req.headers.host || '') +
      '</code> não está associado a nenhum cliente ativo.</p>'
    );
  };

  const defaultOnSuspended = (req, res, tenant) => {
    res.status(402).type('text/html').send(
      '<!doctype html><meta charset="utf-8"><title>Pagamento pendente</title>' +
      '<h1>Acesso suspenso</h1>' +
      '<p>A conta <strong>' + escapeHtml(tenant.slug) + '</strong> está com pagamento pendente. ' +
      'Fale com o suporte para reativar.</p>'
    );
  };

  const doneUnknown = typeof onUnknown === 'function' ? onUnknown : defaultOnUnknown;
  const doneSuspended = typeof onSuspended === 'function' ? onSuspended : defaultOnSuspended;
  const bypass = typeof allowWithoutTenant === 'function' ? allowWithoutTenant : () => false;

  return function tenantMiddleware(req, res, next) {
    const resolved = manager.resolveFromHost(req.headers.host);
    req.tenantCtx = resolved;

    // Hosts globais (landing, admin) — não têm DB; só marker no store.
    if (resolved.kind === 'apex' || resolved.kind === 'admin') {
      return tenantStorage.run({ kind: resolved.kind, tenant: null, db: null }, next);
    }

    if (resolved.kind === 'tenant') {
      const tenant = manager.getTenantBySlug(resolved.slug);
      if (!tenant) {
        if (bypass(req)) return next();
        return doneUnknown(req, res);
      }
      if (tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED') {
        return doneSuspended(req, res, tenant);
      }
      let db;
      try {
        db = manager.getDb(resolved.slug);
      } catch (err) {
        console.error('[tenant-middleware] erro abrindo DB:', err.message);
        return doneUnknown(req, res);
      }
      req.tenant = tenant;
      req.tenantDb = db;
      return tenantStorage.run({ kind: 'tenant', tenant, db }, next);
    }

    // kind === 'unknown' | 'reserved'
    if (bypass(req)) return next();
    return doneUnknown(req, res);
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  tenantStorage,
  getStore,
  currentTenant,
  currentDb,
  createDbProxy,
  createTenantMiddleware,
  runInBootContext,
};
