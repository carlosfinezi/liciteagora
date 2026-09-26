/**
 * RBAC da tela Pedidos PDV — fail-closed, com o mapa regenerado.
 *
 * Roda contra o banco do SANDBOX, usando as funções reais de `perfis-acesso.js`
 * e o `perfis-api-map.js` do disco — o mesmo que o worker carregou no boot.
 *
 * Três perguntas, e todas precisam de resposta antes de a tela ser liberada:
 *   A) quem TEM a página consegue abrir e usar as três APIs?
 *   B) quem NÃO tem é barrado na página?
 *   C) ter a página dá alguma API a mais do que as três que ela usa?
 *
 * Os perfis de teste são criados e REMOVIDOS ao final; o sandbox volta ao estado
 * anterior.
 */
const path = require('path');
const Database = require('better-sqlite3');
const { copiaDoTenant } = require('./banco-de-teste');

const RAIZ = path.join(__dirname, '..');
const db = new Database(copiaDoTenant('sandbox'));
const { acessoDoUsuario, podeVerPath, podeChamarApi } = require(RAIZ + '/perfis-acesso');

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

const PAGINA = '/comercial/pedidos-pdv.html';
const APIS_DA_TELA = ['/api/produtos', '/api/pessoas', '/api/pedidos'];

// Perfis de teste, marcados para a limpeza reconhecê-los.
const SLUG_COM = 'zz-teste-pdv-com';
const SLUG_SEM = 'zz-teste-pdv-sem';
const criados = [];

function criarPerfil(slug, nome, paginas) {
  db.prepare('INSERT INTO perfis_acesso (slug, nome, paginas, ativo) VALUES (?,?,?,1)')
    .run(slug, nome, JSON.stringify(paginas));
  criados.push(slug);
}
const acessoDe = (role) => acessoDoUsuario(db, { id: 999, username: 'teste', role });

criarPerfil(SLUG_COM, 'Teste PDV com acesso', ['pedidos-pdv', 'produtos']);
criarPerfil(SLUG_SEM, 'Teste PDV sem acesso', ['produtos', 'pessoas']);

console.log('### RBAC de Pedidos PDV — sandbox\n');

// ==================== A. PERFIL AUTORIZADO ====================
t('A1. perfil COM pedidos-pdv abre a pagina', () => {
  const a = acessoDe(SLUG_COM);
  assert(!a.irrestrito, 'o perfil de teste ficou irrestrito — nao provaria nada');
  assert(podeVerPath(a, PAGINA), 'pagina negada a quem tem a permissao');
});

t('A2. perfil COM pedidos-pdv chama as 3 APIs da tela', () => {
  const a = acessoDe(SLUG_COM);
  for (const api of APIS_DA_TELA) {
    assert(podeChamarApi(a, api + '/qualquer'), 'negou ' + api);
  }
});

t('A3. e consegue os caminhos aninhados que a tela usa', () => {
  const a = acessoDe(SLUG_COM);
  for (const p of ['/api/pedidos/12/itens', '/api/pedidos/12/itens/3', '/api/produtos/disponibilidade']) {
    assert(podeChamarApi(a, p), 'negou ' + p);
  }
});

// ==================== B. PERFIL BLOQUEADO ====================
t('B1. perfil SEM pedidos-pdv NAO abre a pagina', () => {
  const a = acessoDe(SLUG_SEM);
  assert(!podeVerPath(a, PAGINA), 'FAIL-OPEN: abriu a pagina para quem nao tem a permissao');
});

t('B2. o bloqueio e da PAGINA, nao do diretorio inteiro', () => {
  // O perfil SEM tem 'produtos' e 'pessoas', que NÃO moram em /comercial/.
  // Se tivesse alguma página de /comercial/, o fallback por diretório de
  // `podeVerPath` o deixaria entrar — e é justamente por `pedidos-pdv` estar
  // registrada no menu que a checagem é nominal.
  const a = acessoDe(SLUG_SEM);
  assert(!podeVerPath(a, PAGINA), 'entrou mesmo sem a pagina');
});

t('B3. perfil com OUTRA pagina de /comercial/ ainda assim e barrado', () => {
  const slug = 'zz-teste-pdv-vizinho';
  criarPerfil(slug, 'Teste vizinho de diretorio', ['pedidos']);   // /comercial/pedidos.html
  const a = acessoDe(slug);
  assert(podeVerPath(a, '/comercial/pedidos.html'), 'nao ve a propria pagina');
  assert(!podeVerPath(a, PAGINA),
    'FAIL-OPEN por diretorio: ter /comercial/pedidos.html liberou /comercial/pedidos-pdv.html');
});

// ==================== C. NÃO AMPLIA PERMISSÃO ====================
t('C1. ter SO pedidos-pdv nao libera API fora das 3 da tela', () => {
  const slug = 'zz-teste-pdv-isolado';
  criarPerfil(slug, 'Teste so PDV', ['pedidos-pdv']);
  const a = acessoDe(slug);
  for (const api of APIS_DA_TELA) assert(podeChamarApi(a, api + '/x'), 'deveria permitir ' + api);

  // Amostra de APIs sensíveis que a tela NÃO usa.
  const proibidas = ['/api/contas-a-pagar', '/api/tesouraria', '/api/alcadas', '/api/usuarios-admin',
    '/api/nfe', '/api/faturas', '/api/contas-a-receber', '/api/compras', '/api/estoque',
    '/api/comissoes', '/api/contratos', '/api/devolucoes'];
  const vazou = proibidas.filter((p) => podeChamarApi(a, p + '/x'));
  assert(vazou.length === 0, 'pedidos-pdv liberou APIs alheias: ' + vazou.join(', '));
});

t('C2. ter so pedidos-pdv nao abre outras paginas', () => {
  const a = acessoDe('zz-teste-pdv-isolado');
  for (const p of ['/comercial/pedidos.html', '/financeiro/contas-a-pagar.html',
                   '/configuracoes/alcadas.html', '/fiscal/nova-nota.html']) {
    assert(!podeVerPath(a, p), 'abriu ' + p);
  }
});

t('C3. prefixo sem mapa continua NEGADO (fail-closed preservado)', () => {
  const a = acessoDe('zz-teste-pdv-isolado');
  assert(!podeChamarApi(a, '/api/rota-que-nao-existe/x'), 'prefixo desconhecido foi liberado');
});

// ==================== D. O MAPA EM SI ====================
t('D1. o mapa libera EXATAMENTE 3 prefixos para pedidos-pdv', () => {
  const mapa = require(RAIZ + '/perfis-api-map.js');
  const tabela = mapa.MAPA || mapa.API_PARA_PAGINAS || mapa;
  const libs = Object.entries(tabela)
    .filter(([, pgs]) => Array.isArray(pgs) && pgs.includes('pedidos-pdv'))
    .map(([p]) => p).sort();
  assert(libs.length === 3, 'prefixos=' + JSON.stringify(libs));
  assert(libs.join(',') === '/api/pedidos,/api/pessoas,/api/produtos', libs.join(','));
});

t('D2. admin (irrestrito) continua passando por tudo', () => {
  const a = acessoDoUsuario(db, { id: 1, username: 'admin', role: 'admin' });
  assert(a.irrestrito, 'admin deixou de ser irrestrito');
  assert(podeVerPath(a, PAGINA) && podeChamarApi(a, '/api/pedidos/x'), 'admin barrado');
});

// ==================== limpeza ====================
for (const slug of criados) {
  try { db.prepare('DELETE FROM perfis_acesso WHERE slug = ?').run(slug); } catch {}
}
const sobrou = db.prepare("SELECT COUNT(*) n FROM perfis_acesso WHERE slug LIKE 'zz-teste-pdv%'").get().n;
console.log(`\n  limpeza: ${criados.length} perfil(is) de teste removido(s); sobraram ${sobrou}`);
console.log(`  perfis do sandbox agora: ${db.prepare("SELECT GROUP_CONCAT(slug) g FROM perfis_acesso").get().g}`);

db.close();
console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
