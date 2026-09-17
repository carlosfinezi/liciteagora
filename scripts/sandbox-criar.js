/**
 * Cria o tenant `sandbox` — ambiente INTERNO de teste do Licite Agora.
 *
 * Usa o MESMO mecanismo do control plane (`manager.createTenant` +
 * `applyRouteMigrations`), para o sandbox representar fielmente a arquitetura
 * de produção. Duas coisas ficam de fora, de propósito:
 *
 *   1. **`spawnProvisionVhost`** — o provisionamento de vhost + SSL roda
 *      `sudo /usr/local/hestia/...` e mexe em nginx e Let's Encrypt. É o único
 *      efeito externo do fluxo de criação, e um ambiente de teste não precisa
 *      de domínio público. Também evita mexer num Hestia que se auto-atualiza
 *      e regera vhosts.
 *   2. **status ACTIVE/TRIAL** — o scheduler (`liciteagora.service`) varre
 *      `listActive()`, que é `status IN ('ACTIVE','TRIAL')`. Nascendo
 *      **SUSPENDED**, o sandbox é INVISÍVEL para todos os jobs: cobrança,
 *      polling de boleto, PCP, alertas de disputa, recorrências. Nenhuma
 *      comunicação externa pode partir dele.
 *
 * Para usar o sandbox pelo navegador um dia, basta mudar o status — e aí ele
 * entra nos jobs. É decisão de quem o fizer; hoje fica trancado.
 *
 *   node scripts/sandbox-criar.js            dry-run (não escreve nada)
 *   node scripts/sandbox-criar.js --aplicar  cria de verdade
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SLUG = process.argv.find(a => a.startsWith('--slug='))?.split('=')[1] || 'sandbox';
const aplicar = process.argv.includes('--aplicar');

const RAIZ = path.join(__dirname, '..');
const DIR = path.join(RAIZ, 'data', 'tenants', SLUG);
const DB_PATH = path.join(DIR, 'pncp.db');

const log = (...a) => console.log(...a);

log(aplicar ? '### CRIANDO o tenant sandbox\n' : '### DRY-RUN — nada será escrito. Use --aplicar.\n');

const { createTenantManager } = require(path.join(RAIZ, 'tenant-manager'));
const { initSchema } = require(path.join(RAIZ, 'db-schema'));
const manager = createTenantManager({ initSchema });

if (manager.getTenantBySlug(SLUG)) {
  log(`tenant "${SLUG}" já existe — nada a fazer.`);
  process.exit(0);
}
if (fs.existsSync(DB_PATH)) {
  console.error(`RECUSADO: ${DB_PATH} já existe mas o tenant não está registrado.`);
  process.exit(2);
}

log('O que será feito:');
log(`  1. linha em data/control.db  → slug=${SLUG}, status=SUSPENDED (invisível ao scheduler)`);
log(`  2. banco novo                → data/tenants/${SLUG}/pncp.db (schema do db-schema.js)`);
log('  3. applyRouteMigrations      → as ~40 tabelas dos *-routes.js');
log('  4. usuários                  → admin / vendedor / gerente, senhas aleatórias desta execução');
log('  5. perfis de acesso          → vendedor (restrito) e gerente (com metas/comissões)');
log('  NÃO será feito: vhost, SSL, DNS, e-mail, cobrança, assinatura, webhook, WhatsApp.\n');

if (!aplicar) { log('Dry-run encerrado. Nada foi escrito.'); process.exit(0); }

// ---------- 1 e 2: tenant + banco ----------
const tenant = manager.createTenant({
  slug: SLUG,
  name: `[INTERNO] Sandbox de testes (${SLUG}) — Licite Agora`,
  ownerEmail: null,                    // sem e-mail: nada a notificar
  plan: 'enterprise',                  // todos os módulos, para poder testar tudo
  status: 'SUSPENDED',                 // trava contra os jobs do scheduler
  trialDays: 0,
  actor: 'sandbox-script',
});
log(`✔ tenant criado: id=${tenant.id} status=${tenant.status}`);

manager.setNotes && manager.setNotes({ slug: SLUG, notes: 'AMBIENTE INTERNO DE TESTE — não é cliente.' });

const db = manager.getDb(SLUG);

// ---------- 3: migrations dos módulos ----------
const { applyRouteMigrations } = require(path.join(RAIZ, 'tenant-provision'));
applyRouteMigrations(db, tenant);
const nTabelas = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;
log(`✔ applyRouteMigrations: ${nTabelas} tabelas`);

// ---------- 4: usuários ----------
// Senhas aleatórias desta execução, impressas uma vez. Nenhuma senha de
// cliente é reaproveitada, e nada fica fixo no código.
const senha = () => crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
const criados = [];
for (const u of [
  { username: 'admin', nome: 'Administrador Sandbox', role: 'admin', ehVendedor: 0 },
  { username: 'vendedor', nome: 'Vendedor Sandbox', role: 'comercial', ehVendedor: 1 },
  { username: 'gerente', nome: 'Gerente Sandbox', role: 'gerente-comercial', ehVendedor: 1 },
]) {
  const p = senha();
  db.prepare(`INSERT OR REPLACE INTO users (username, passwordHash, nome, role, ativo, ehVendedor)
              VALUES (?, ?, ?, ?, 1, ?)`)
    .run(u.username, bcrypt.hashSync(p, 10), u.nome, u.role, u.ehVendedor);
  criados.push({ ...u, senha: p });
}
log('✔ usuários criados');

// ---------- 5: perfis de acesso ----------
// Cadastrados de verdade para que vendedor e gerente sejam atores RESTRITOS.
// Sem cadastro, `atorIrrestrito` aplica o fail-open de perfis-acesso.js e os
// dois virariam privilegiados — e o fail-closed do desconto não valeria.
const perfil = (slug, nome, paginas) =>
  db.prepare('INSERT OR REPLACE INTO perfis_acesso (slug, nome, paginas, ativo) VALUES (?, ?, ?, 1)')
    .run(slug, nome, JSON.stringify(paginas));
perfil('comercial', 'Vendedor', ['pedidos', 'pessoas', 'produtos', 'meu-perfil']);
perfil('gerente-comercial', 'Gerente Comercial',
  ['pedidos', 'pessoas', 'produtos', 'meu-perfil', 'comercial-metas', 'comissoes', 'aprovacoes']);
log('✔ perfis de acesso cadastrados');

// api_key do tenant, como o control plane faz.
if (!db.prepare("SELECT valor FROM config WHERE chave='api_key'").get()) {
  db.prepare("INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES ('api_key', ?, CURRENT_TIMESTAMP)")
    .run(crypto.randomBytes(32).toString('hex'));
}

log('\n=== CREDENCIAIS (só aparecem agora) ===');
for (const c of criados) log(`  ${c.username.padEnd(9)} ${c.role.padEnd(18)} ${c.senha}`);
log('\nsandbox criado. Nenhum vhost, DNS, e-mail, cobrança ou webhook foi disparado.');

// applyRouteMigrations registra rotas num app descartável, e alguns módulos
// criam timers (sniper ~2min, wa-scheduler 120s). Saímos antes de qualquer um
// disparar — nada externo chega a ser chamado.
process.exit(0);
