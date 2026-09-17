/**
 * Isolamento multi-tenant — travas de segurança.
 *
 * ── Por que este arquivo existe ─────────────────────────────────────────────
 *
 * A auditoria de 2026-09-12 verificou que o isolamento está correto: tenant
 * resolvido pelo subdomínio, banco por tenant, sessão por tenant, e nenhum
 * fallback. Mas "está correto hoje" não é garantia nenhuma — a falha aqui é
 * silenciosa: um `|| 'produtosbomgosto'` posto por engano não quebra tela
 * nenhuma, e o sistema continua respondendo. Só que responde com os dados da
 * empresa errada.
 *
 * Estes testes falham ALTO quando alguém encosta nas quatro coisas que
 * sustentam o isolamento:
 *
 *   1. o tenant vem do Host, e só dele;
 *   2. não existe tenant padrão nem fallback;
 *   3. o acesso ao banco é escopado, e estourar fora do contexto é ERRO;
 *   4. o cookie de sessão não atravessa subdomínio.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };
const semCom = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ler = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
const TENANT_MGR = ler('tenant-manager.js');
const TENANT_MW = ler('tenant-middleware.js');
const AUTH = ler('auth.js');
const AUTH_BOOT = ler('auth-bootstrap.js');
const SERVER = ler('server.js');

// ============================================================================
// A. O tenant vem do Host — e só dele
// ============================================================================

t('A1. resolveFromHost decide SO pelo hostname', () => {
  const fn = /function resolveFromHost\(host\)[\s\S]*?\n\}/.exec(TENANT_MGR)[0];
  // Nada de ler cabeçalho, query, corpo ou variável de ambiente aqui dentro.
  for (const proibido of ['req.query', 'req.body', 'req.headers', 'process.env', 'cookie']) {
    assert(!fn.includes(proibido),
      `resolveFromHost passou a considerar "${proibido}" — o tenant deixaria de vir só do Host`);
  }
  assert(/hostname\.endsWith\(suffix\)/.test(fn), 'a checagem do domínio sumiu');
  assert(/sub\.includes\('\.'\)/.test(fn),
    'sub-subdomínio deixou de ser recusado — "a.b.liciteagora.app" viraria tenant "a.b"');
});

t('A2. host desconhecido NAO vira tenant', () => {
  const fn = /function resolveFromHost\(host\)[\s\S]*?\n\}/.exec(TENANT_MGR)[0];
  const retornos = [...fn.matchAll(/return \{ kind: '([^']+)'/g)].map((m) => m[1]);
  assert(retornos.includes('unknown'), 'o caminho "unknown" sumiu — host estranho cairia em algum tenant');
  // O último retorno é o único que produz um tenant, e depende do subdomínio.
  assert(/return \{ kind: 'tenant', slug: sub \}/.test(fn),
    'o slug deixou de vir do subdomínio');
});

t('A3. host sem tenant é RECUSADO, nao redirecionado para um padrao', () => {
  const fn = /const defaultOnUnknown = [\s\S]*?\n  \};/.exec(TENANT_MW)[0];
  assert(/res\.status\(404\)/.test(fn), 'host desconhecido deixou de responder 404');
  assert(!/redirect/.test(fn), 'host desconhecido passou a ser redirecionado — para onde?');
});

// ============================================================================
// B. Não existe tenant padrão — a trava mais importante
// ============================================================================

t('B1. NENHUM tenant aparece fixo no caminho de autenticacao', () => {
  // Um slug escrito à mão em qualquer um destes arquivos seria um fallback em
  // potencial. Comentários são removidos: citar um tenant ao explicar algo não
  // é fixá-lo.
  const criticos = ['tenant-manager.js', 'tenant-middleware.js', 'auth.js',
                    'auth-bootstrap.js', 'base-middleware.js', 'perfis-acesso.js'];
  const slugs = fs.readdirSync(path.join(RAIZ, 'data/tenants'));
  for (const arq of criticos) {
    const src = semCom(ler(arq));
    for (const slug of slugs) {
      assert(!src.includes(`'${slug}'`) && !src.includes(`"${slug}"`),
        `o slug "${slug}" está escrito em ${arq} — fallback em potencial`);
    }
  }
});

t('B2. nao existe variavel de tenant padrao', () => {
  const todos = fs.readdirSync(RAIZ).filter((f) => f.endsWith('.js'));
  const suspeitos = [];
  for (const f of todos) {
    const src = semCom(ler(f));
    for (const nome of ['DEFAULT_TENANT', 'TENANT_PADRAO', 'defaultTenant',
                        'tenantPadrao', 'FALLBACK_TENANT', 'fallbackTenant']) {
      if (src.includes(nome)) suspeitos.push(`${f}: ${nome}`);
    }
  }
  assert(suspeitos.length === 0, 'tenant padrão encontrado — ' + suspeitos.join(', '));
});

t('B3. getTenantBySlug nao inventa tenant quando nao acha', () => {
  const fn = /getTenantBySlug\(slug\)\s*\{[\s\S]*?\n    \}/.exec(TENANT_MGR);
  if (!fn) return; // implementação mudou de forma; B4 cobre o efeito
  assert(!/\|\|\s*['"]/.test(fn[0]), 'getTenantBySlug tem um `|| "algum-slug"`');
});

t('B4. o middleware recusa tenant inexistente', () => {
  assert(/if \(!tenant\) \{[\s\S]{0,160}doneUnknown/.test(TENANT_MW),
    'tenant não encontrado deixou de cair em doneUnknown');
  assert(/status === 'SUSPENDED' \|\| tenant\.status === 'CANCELLED'/.test(TENANT_MW),
    'tenant suspenso/cancelado deixou de ser barrado');
});

// ============================================================================
// C. O acesso ao banco é escopado — e sair do escopo é erro
// ============================================================================

t('C1. currentDb LANCA fora do contexto de tenant', () => {
  // É esta linha que faz o isolamento não depender de cada rota lembrar de
  // validar: sem contexto, não há banco.
  const fn = /function currentDb\(\)[\s\S]*?\n\}/.exec(TENANT_MW)[0];
  assert(/throw new Error/.test(fn),
    'currentDb deixou de lançar fora de contexto — uma rota poderia ler o banco errado');
  assert(!/return .*controlDb|return null/.test(fn),
    'currentDb passou a devolver um banco de reserva em vez de falhar');
});

t('C2. o contexto e por requisicao (AsyncLocalStorage)', () => {
  assert(/AsyncLocalStorage/.test(TENANT_MW), 'o isolamento por requisição sumiu');
  assert(/tenantStorage\.run\(/.test(TENANT_MW), 'o contexto deixou de ser aberto por requisição');
});

t('C3. o db das rotas e o Proxy, nao um banco fixo', () => {
  assert(/new Proxy\(/.test(TENANT_MW), 'o Proxy de banco sumiu');
  assert(/currentDb\(\)\[prop\]|const db = currentDb\(\)/.test(TENANT_MW),
    'o Proxy deixou de resolver pelo tenant atual');
});

// ============================================================================
// D. Sessão não atravessa tenant
// ============================================================================

t('D1. o cookie NAO tem domain (nao vaza entre subdominios)', () => {
  const cfg = /app\.use\(session\(\{[\s\S]*?\}\)\);/.exec(AUTH_BOOT)[0];
  assert(!/domain:/.test(semCom(cfg)),
    'o cookie ganhou `domain` — passaria a valer em TODOS os subdomínios, e a sessão de um tenant abriria outro');
  assert(/httpOnly: true/.test(cfg), 'o cookie deixou de ser httpOnly');
  assert(/sameSite:/.test(cfg), 'o cookie perdeu sameSite');
  assert(/secure: isProd/.test(cfg), 'o cookie deixou de exigir HTTPS em produção');
});

t('D2. a sessao e gravada no banco DO TENANT', () => {
  const fn = /function resolveDb\(\)[\s\S]*?\n  \}/.exec(AUTH)[0];
  assert(/db\.__real/.test(fn),
    'o store de sessão deixou de resolver pelo tenant atual — sessões de tenants diferentes se misturariam');
});

t('D3. o usuario e buscado no banco do tenant, nunca num global', () => {
  const fn = /if \(req\.session && req\.session\.userId\) \{[\s\S]*?\n      \}/.exec(AUTH)[0];
  assert(/req\.tenantDb \|\| db/.test(fn), 'a busca do usuário deixou de usar o banco do tenant');
  assert(/user && user\.ativo/.test(fn), 'usuário inativo deixou de ser barrado');
});

t('D4. nao existe tabela global de usuarios', () => {
  // Se alguém criar uma, o login deixa de ser por tenant e passa a ser central
  // — outra arquitetura, com outro risco. Este teste força a conversa antes.
  const ctl = new Database(path.join(RAIZ, 'data/control.db'), { readonly: true });
  try {
    const tabelas = ctl.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%user%' OR name LIKE '%usuario%')"
    ).all().map((r) => r.name);
    assert(tabelas.length === 0,
      'apareceu tabela de usuários no control.db: ' + tabelas.join(', '));
  } finally { ctl.close(); }
});

// ============================================================================
// E. Identificação do tenant aberto — o que a auditoria acrescentou
// ============================================================================

t('E1. /api/tenant-atual sai do CONTEXTO, nunca de parametro', () => {
  const rota = /app\.get\('\/api\/tenant-atual'[\s\S]*?\n  \}\);/.exec(SERVER)[0];
  for (const proibido of ['req.query', 'req.body', 'req.params', 'req.headers']) {
    assert(!rota.includes(proibido),
      `a rota de identificação lê "${proibido}" — daria para perguntar por OUTRO tenant`);
  }
  assert(/req\.tenant\b/.test(rota), 'a rota deixou de usar o tenant do contexto');
});

t('E2. a identificacao devolve so slug, nome e status', () => {
  const rota = /app\.get\('\/api\/tenant-atual'[\s\S]*?\n  \}\);/.exec(SERVER)[0];
  const campos = [...rota.matchAll(/^\s{8}(\w+):/gm)].map((m) => m[1]);
  const permitidos = new Set(['slug', 'nome', 'status']);
  for (const c of campos) {
    assert(permitidos.has(c), `a rota de identificação expõe "${c}"`);
  }
  // Nada de db_path, owner_email, plano ou qualquer coluna de cobrança.
  for (const proibido of ['db_path', 'owner_email', 'plan', 'trial', 'asaas', 'notes']) {
    assert(!new RegExp('\\b' + proibido, 'i').test(rota),
      `a rota expõe "${proibido}", que é do plano de controle`);
  }
});

t('E3. o login mostra a empresa antes de autenticar', () => {
  const login = semCom(ler('public/auth/login.html'));
  assert(/\/api\/tenant-atual/.test(login), 'o login não identifica a empresa');
  assert(/id="empresaTenant"/.test(login), 'o bloco de identificação sumiu');
  assert(/hidden/.test(login), 'o bloco nasce visível — mostraria vazio enquanto carrega');
});

t('E4. a topbar identifica a empresa mesmo sem estabelecimento cadastrado', () => {
  const sb = ler('public/js/sidebar.js');
  assert(/\/api\/tenant-atual/.test(sb), 'a topbar não tem o fallback de identificação');
  // Não pode sobrescrever o nome do estabelecimento, que é mais preciso.
  assert(/!el\.textContent\.trim\(\)/.test(sb),
    'o fallback sobrescreve o nome do estabelecimento em vez de completar');
});

// ============================================================================
// F. Estado real dos tenants
// ============================================================================

t('F1. cada tenant tem banco proprio, com usuarios proprios', () => {
  const base = path.join(RAIZ, 'data/tenants');
  const vistos = new Map();
  for (const slug of fs.readdirSync(base)) {
    const p = path.join(base, slug, 'pncp.db');
    if (!fs.existsSync(p)) continue;
    const real = fs.realpathSync(p);
    assert(!vistos.has(real),
      `${slug} e ${vistos.get(real)} apontam para o MESMO arquivo de banco`);
    vistos.set(real, slug);
  }
  assert(vistos.size >= 2, 'menos de dois bancos de tenant — o teste não prova nada');
});

t('F2. nenhum usuario ativo com a senha inicial', () => {
  const bcrypt = require('bcryptjs');
  const base = path.join(RAIZ, 'data/tenants');
  const fracos = [];
  for (const slug of fs.readdirSync(base)) {
    const p = path.join(base, slug, 'pncp.db');
    if (!fs.existsSync(p)) continue;
    const db = new Database(p, { readonly: true });
    try {
      for (const u of db.prepare('SELECT username, passwordHash FROM users WHERE ativo = 1').all()) {
        if (u.passwordHash && bcrypt.compareSync('admin', u.passwordHash)) fracos.push(`${slug}/${u.username}`);
      }
    } catch (_) { /* tenant sem users ainda */ } finally { db.close(); }
  }
  assert(fracos.length === 0, 'senha inicial admin/admin ainda ativa em: ' + fracos.join(', '));
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
