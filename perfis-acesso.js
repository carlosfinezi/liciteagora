/**
 * perfis-acesso.js — RBAC por página.
 *
 * Até aqui o sistema tinha `users.role` com cinco valores fixos
 * ('admin','financeiro','comercial','operacional','licitacoes') e quase nada
 * olhava para ele: fora de `requireRole(['admin'])` em algumas rotas, todo
 * usuário autenticado enxergava o menu inteiro. O que decidia o que aparecia
 * era a feature flag do TENANT — igual para todos os usuários dele.
 *
 * Aqui o perfil vira um cadastro: um registro em `perfis_acesso` com a lista
 * de páginas que ele abre. `users.role` passa a apontar tanto para os cinco
 * perfis nativos quanto para os cadastrados pelo administrador.
 *
 * Fonte do catálogo de páginas: `public/js/menu-config.js`, o mesmo arquivo que
 * desenha o menu. Não há lista paralela — página nova no menu aparece na tela
 * de perfis automaticamente.
 *
 * Três decisões que valem estar explícitas:
 *
 *   1. FAIL-OPEN no perfil: só nega quem tem perfil cadastrado E ativo com
 *      aquele slug. Usuário cujo role não tem cadastro continua vendo tudo.
 *      Isso era o que permitia subir o código sem trancar quem já existia; em
 *      2026-08-19 os usuários que dependiam disso foram migrados para `admin`,
 *      então hoje ninguém está nessa situação — a rede de segurança continua
 *      valendo para um role digitado à mão que não tenha cadastro.
 *   2. `admin` nunca é barrado, mesmo que alguém cadastre um perfil 'admin'
 *      (o cadastro recusa esse slug). É o perfil administrativo do sistema:
 *      quem precisa das funções de administração fica nele.
 *   3. O gate cobre PÁGINAS (.html) e a API. Nas páginas ele é fail-closed
 *      dentro dos diretórios de módulo; na API, fail-closed contra o mapa de
 *      `perfis-api-map.js` — prefixo sem entrada no mapa é negado e logado.
 */

const { menuConfig } = require('./public/js/menu-config');
const { requireRole, ROLES } = require('./auth');
const { logAction } = require('./audit-log');
const { LIBERADOS, MAPA } = require('./perfis-api-map');

const API_LIBERADOS = new Set(LIBERADOS);

// ==================== CATÁLOGO ====================

// page → { texto, link, dir, secao }   e   link → page
const POR_PAGINA = new Map();
const POR_LINK = new Map();
const DIRS_DO_MENU = new Set();

for (const secao of menuConfig.secoes) {
  for (const item of secao.itens) {
    const dir = String(item.link || '').split('/')[1] || '';
    POR_PAGINA.set(item.page, { texto: item.texto, link: item.link, dir, secao: secao.titulo });
    POR_LINK.set(item.link, item.page);
    if (dir) DIRS_DO_MENU.add(dir);
  }
}

/** Seções e páginas como a tela de perfis precisa exibir. */
function catalogo() {
  return menuConfig.secoes.map((s) => ({
    titulo: s.titulo,
    icone: s.icone || null,
    feature: s.feature || null,
    paginas: s.itens.map((i) => ({ page: i.page, texto: i.texto, link: i.link })),
  }));
}

const TODAS_AS_PAGINAS = [...POR_PAGINA.keys()];

// ==================== SCHEMA ====================

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS perfis_acesso (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      slug      TEXT NOT NULL UNIQUE,
      nome      TEXT NOT NULL,
      descricao TEXT,
      paginas   TEXT NOT NULL DEFAULT '[]',
      ativo     INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT
    );
  `);
}

// ==================== DECISÃO DE ACESSO ====================

function lerPaginas(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((p) => POR_PAGINA.has(p)) : [];
  } catch { return []; }
}

/**
 * O que este usuário alcança.
 * `irrestrito: true` = comportamento antigo (nada é barrado).
 */
function acessoDoUsuario(db, user) {
  if (!user) return { irrestrito: true, motivo: 'sistema' };          // X-Api-Key
  if (user.role === 'admin') return { irrestrito: true, motivo: 'admin' };
  let row = null;
  try {
    row = db.prepare('SELECT slug, nome, paginas, ativo FROM perfis_acesso WHERE slug = ?').get(user.role);
  } catch { /* tenant ainda sem a tabela */ }
  if (!row || !row.ativo) return { irrestrito: true, motivo: 'sem-perfil' };
  return { irrestrito: false, perfil: row.slug, nome: row.nome, paginas: lerPaginas(row.paginas) };
}

// Caminhos que não pertencem a módulo nenhum e precisam abrir para qualquer um:
// o shell (/app.html, /index.html), a tela de login, o portal do cliente e a
// loja pública.
const DIRS_ABERTOS = new Set(['auth', 'portal', 'landing', 'loja']);

/**
 * Páginas de detalhe (contrato.html, pedido.html, produto.html...) não estão no
 * menu e por isso não existem como permissão. Elas são abertas a partir da
 * listagem do próprio módulo, então herdam o acesso dele: quem pode ver alguma
 * página de `/comercial/` pode abrir os detalhes de `/comercial/`.
 *
 * Fora disso é negado — inclusive diretório desconhecido. É o que impede que
 * `/backups/<tela-velha>.html`, que ninguém lembra que existe, sirva de porta
 * dos fundos para um módulo fechado.
 */
function podeVerPath(acesso, pathname) {
  if (acesso.irrestrito) return true;
  const permitidas = new Set(acesso.paginas);

  const page = POR_LINK.get(pathname);
  if (page) return permitidas.has(page);

  const partes = pathname.split('/');
  const dir = partes.length > 2 ? partes[1] : '';
  if (!dir) return true;                    // /app.html, /index.html — o shell
  if (DIRS_ABERTOS.has(dir)) return true;

  for (const p of permitidas) {
    if (POR_PAGINA.get(p)?.dir === dir) return true;
  }
  return false;
}

/**
 * API. Mesma pergunta, outra porta: o perfil alcança este endpoint?
 *
 * fail-CLOSED — prefixo fora do mapa é negado. É o oposto da regra de perfil
 * (fail-open): lá o risco de errar é trancar quem já usava o sistema; aqui o
 * risco de errar é deixar aberto o dado que a tela acabou de esconder.
 */
function podeChamarApi(acesso, pathname) {
  if (acesso.irrestrito) return true;
  const prefixo = '/api/' + (pathname.split('/')[2] || '');
  if (API_LIBERADOS.has(prefixo)) return true;
  const paginas = MAPA[prefixo];
  if (!paginas) {
    console.warn(`[RBAC] prefixo sem mapa: ${prefixo} (perfil ${acesso.perfil}) — ver perfis-api-map.js`);
    return false;
  }
  const permitidas = new Set(acesso.paginas);
  return paginas.some((p) => permitidas.has(p));
}

const HTML_403 = (nomePerfil) => `<!doctype html><meta charset="utf-8">
<title>Sem acesso · Licite Agora</title>
<style>
 body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f1115;color:#e6e8eb;
      display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
 .box{max-width:420px;padding:32px;border:1px solid #262b33;border-radius:12px;background:#161a20}
 h1{font-size:1.2em;margin:0 0 12px} p{color:#9aa3ad;line-height:1.6;margin:0 0 20px}
 a{color:#4c8dff;text-decoration:none}
</style>
<div class="box">
  <h1>🔒 Esta página não faz parte do seu perfil</h1>
  <p>Seu acesso é definido pelo perfil <strong>${nomePerfil}</strong>.
     Se você precisa desta tela, peça ao administrador para incluí-la no perfil.</p>
  <a href="/">← Voltar ao início</a>
</div>`;

/**
 * Middleware único das duas portas. Vai depois do requireAuth (precisa de
 * req.user) e antes do express.static e das rotas de API — o que está
 * registrado acima dele (login, portal, electron, control plane) não passa
 * por aqui de propósito.
 */
function criarGateAcesso(db) {
  return function gateAcesso(req, res, next) {
    if (!req.user) return next();                     // X-Api-Key: atua como sistema
    const ehApi = req.path.startsWith('/api/');
    const ehPagina = (req.method === 'GET' || req.method === 'HEAD') && req.path.endsWith('.html');
    if (!ehApi && !ehPagina) return next();

    let acesso;
    try {
      acesso = acessoDoUsuario(db, req.user);
    } catch {
      return next();   // falha ao ler o perfil não pode trancar o sistema
    }
    if (acesso.irrestrito) return next();

    if (ehApi) {
      if (podeChamarApi(acesso, req.path)) return next();
      return res.status(403).json({
        success: false,
        error: `Seu perfil (${acesso.nome || acesso.perfil}) não tem acesso a esta função`,
      });
    }
    if (podeVerPath(acesso, req.path)) return next();
    res.status(403).type('text/html').send(HTML_403(acesso.nome || acesso.perfil));
  };
}

// ==================== ROTAS ====================

const SLUG_OK = /^[a-z][a-z0-9_-]{2,31}$/;

function validar(db, dados, { id = null } = {}) {
  const erros = [];
  const slug = String(dados.slug || '').trim().toLowerCase();
  const nome = String(dados.nome || '').trim();

  if (!SLUG_OK.test(slug)) {
    erros.push('Identificador inválido: 3 a 32 caracteres, começando por letra, só letras minúsculas, números, hífen e underline');
  }
  // 'admin' é irrestrito por definição em acessoDoUsuario — um cadastro com
  // esse slug daria a impressão de restringir o administrador e não faria nada.
  if (slug === 'admin') erros.push('O perfil "admin" é fixo (acesso total) e não pode ser cadastrado');
  if (!nome) erros.push('Informe o nome do perfil');

  if (SLUG_OK.test(slug)) {
    const outro = db.prepare('SELECT id FROM perfis_acesso WHERE slug = ? AND id <> ?').get(slug, id ?? -1);
    if (outro) erros.push(`Já existe um perfil com o identificador "${slug}"`);
  }

  const paginas = Array.isArray(dados.paginas) ? dados.paginas : [];
  const desconhecidas = paginas.filter((p) => !POR_PAGINA.has(p));
  if (desconhecidas.length) erros.push(`Páginas inexistentes no menu: ${desconhecidas.join(', ')}`);

  return { erros, slug, nome, paginas: paginas.filter((p) => POR_PAGINA.has(p)) };
}

/**
 * Perfis que `users.role` aceita: os cinco nativos mais os cadastrados e ativos.
 * `restrito` diz se o perfil já tem lista de páginas — nativo sem cadastro
 * continua vendo tudo.
 */
function perfisDisponiveis(db) {
  let cadastrados = [];
  try {
    cadastrados = db.prepare('SELECT slug, nome FROM perfis_acesso WHERE ativo = 1 ORDER BY nome').all();
  } catch { /* tenant ainda sem a tabela */ }
  const porSlug = new Map(cadastrados.map((p) => [p.slug, p.nome]));
  const nativos = ROLES.map((r) => ({ slug: r, nome: porSlug.get(r) || r, restrito: porSlug.has(r) && r !== 'admin' }));
  const extras = cadastrados
    .filter((p) => !ROLES.includes(p.slug))
    .map((p) => ({ slug: p.slug, nome: p.nome, restrito: true }));
  return [...nativos, ...extras];
}

function usuariosDoPerfil(db, slug) {
  try {
    return db.prepare('SELECT COUNT(*) n FROM users WHERE role = ? AND ativo = 1').get(slug).n;
  } catch { return 0; }
}

function registrarRotasPerfis(app, db) {
  // Catálogo do menu — o que a tela de perfis oferece para marcar.
  app.get('/api/perfis/catalogo', requireRole(['admin']), (req, res) => {
    res.json({ success: true, secoes: catalogo(), nativos: ROLES });
  });

  // O que o próprio usuário alcança. Usado pela sidebar para não mostrar
  // item que vai bater em 403.
  app.get('/api/perfis/meu-acesso', (req, res) => {
    if (!req.user) return res.json({ success: true, irrestrito: true, paginas: TODAS_AS_PAGINAS });
    const a = acessoDoUsuario(db, req.user);
    res.json({
      success: true,
      irrestrito: a.irrestrito,
      perfil: a.perfil || req.user.role,
      paginas: a.irrestrito ? TODAS_AS_PAGINAS : a.paginas,
    });
  });

  app.get('/api/perfis', requireRole(['admin']), (req, res) => {
    try {
      const perfis = db.prepare('SELECT * FROM perfis_acesso ORDER BY ativo DESC, nome').all()
        .map((p) => ({
          id: p.id, slug: p.slug, nome: p.nome, descricao: p.descricao,
          ativo: p.ativo, createdAt: p.createdAt, updatedAt: p.updatedAt,
          paginas: lerPaginas(p.paginas),
          usuarios: usuariosDoPerfil(db, p.slug),
        }));

      // Os cinco perfis nativos não têm cadastro: aparecem como "sem restrição"
      // até que alguém os cadastre. Mostrar isso evita a leitura errada de que
      // um usuário 'comercial' já está restrito só porque o perfil existe no
      // cadastro de usuários.
      const cadastrados = new Set(perfis.map((p) => p.slug));
      const nativosSemCadastro = ROLES
        .filter((r) => r !== 'admin' && !cadastrados.has(r))
        .map((r) => ({ slug: r, usuarios: usuariosDoPerfil(db, r) }));

      // `admin` existe e é o perfil de acesso total — só não é um registro desta
      // tabela. Sem mostrá-lo, a tela dava a impressão de que ele não existia e
      // de que os administradores estavam sem perfil.
      const fixo = {
        slug: 'admin',
        nome: 'Administrador',
        descricao: 'Perfil fixo do sistema: todas as páginas e as funções de administração.',
        paginas: TODAS_AS_PAGINAS,
        usuarios: usuariosDoPerfil(db, 'admin'),
      };

      res.json({ success: true, perfis, fixo, nativosSemCadastro, totalPaginas: TODAS_AS_PAGINAS.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/perfis', requireRole(['admin']), (req, res) => {
    try {
      const { erros, slug, nome, paginas } = validar(db, req.body);
      if (erros.length) return res.status(400).json({ success: false, error: erros[0], erros });

      const r = db.prepare(`INSERT INTO perfis_acesso (slug, nome, descricao, paginas, ativo)
                            VALUES (?, ?, ?, ?, 1)`)
        .run(slug, nome, req.body.descricao || null, JSON.stringify(paginas));
      logAction(db, req, 'criar', 'perfil-acesso', r.lastInsertRowid, { slug, nome, paginas: paginas.length });
      res.json({ success: true, perfil: db.prepare('SELECT * FROM perfis_acesso WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/perfis/:id', requireRole(['admin']), (req, res) => {
    try {
      const id = Number(req.params.id);
      const atual = db.prepare('SELECT * FROM perfis_acesso WHERE id = ?').get(id);
      if (!atual) return res.status(404).json({ success: false, error: 'Perfil não encontrado' });

      // `atual.paginas` é JSON em texto; sem montar o objeto campo a campo, um
      // PUT que não mandasse `paginas` cairia no filtro de array e zeraria a lista.
      const { erros, slug, nome, paginas } = validar(db, {
        slug: req.body.slug ?? atual.slug,
        nome: req.body.nome ?? atual.nome,
        paginas: Array.isArray(req.body.paginas) ? req.body.paginas : lerPaginas(atual.paginas),
      }, { id });
      if (erros.length) return res.status(400).json({ success: false, error: erros[0], erros });

      // Trocar o slug de um perfil em uso deixaria os usuários apontando para um
      // perfil que não existe mais — e, pelo fail-open, com acesso total.
      const emUso = usuariosDoPerfil(db, atual.slug);
      if (slug !== atual.slug && emUso) {
        return res.status(400).json({ success: false,
          error: `O identificador não pode mudar: ${emUso} usuário(s) usam "${atual.slug}"` });
      }

      const ativo = req.body.ativo === undefined ? atual.ativo : (req.body.ativo ? 1 : 0);
      db.prepare(`UPDATE perfis_acesso
                  SET slug = ?, nome = ?, descricao = ?, paginas = ?, ativo = ?, updatedAt = CURRENT_TIMESTAMP
                  WHERE id = ?`)
        .run(slug, nome, req.body.descricao ?? atual.descricao, JSON.stringify(paginas), ativo, id);
      logAction(db, req, 'editar', 'perfil-acesso', id, { slug, nome, paginas: paginas.length, ativo });
      res.json({ success: true, perfil: db.prepare('SELECT * FROM perfis_acesso WHERE id = ?').get(id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/perfis/:id', requireRole(['admin']), (req, res) => {
    try {
      const id = Number(req.params.id);
      const atual = db.prepare('SELECT * FROM perfis_acesso WHERE id = ?').get(id);
      if (!atual) return res.status(404).json({ success: false, error: 'Perfil não encontrado' });

      // Apagar o perfil de quem o usa devolveria acesso total a essas contas
      // (fail-open) sem ninguém perceber.
      const emUso = usuariosDoPerfil(db, atual.slug);
      if (emUso) {
        return res.status(400).json({ success: false,
          error: `${emUso} usuário(s) ativos usam este perfil. Troque o perfil deles antes de excluir.` });
      }
      db.prepare('DELETE FROM perfis_acesso WHERE id = ?').run(id);
      logAction(db, req, 'excluir', 'perfil-acesso', id, { slug: atual.slug });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = {
  ensureSchema,
  catalogo,
  acessoDoUsuario,
  podeVerPath,
  criarGateAcesso,
  podeChamarApi,
  registrarRotasPerfis,
  perfisDisponiveis,
  TODAS_AS_PAGINAS,
};
