// pcp-client.js
//
// Cliente autenticado para portaldecompraspublicas.com.br.
//
// Mantém uma sessão (jars de cookies por host) por tenant, com TTL de 5 min.
// Re-loga automaticamente se a sessão expira (detectado via redirect pra Keycloak).
//
// Foundation para futuras features: scheduler de sync de participações/sessões,
// parser de mensagens do pregão, submissão de lances etc. Hoje expõe:
//   - listSeusPregoes(db, { pagina })
//   - listSessoesPublicas(db, { pagina })
//   - fetchPcpHtml(db, url)  — raw, pra construir parsers novos

const { loginPcp, PcpLoginError, parseSetCookies, jarToHeader, UA } = require('./pcp-auth');

const SESSION_TTL_MS = 5 * 60 * 1000; // 5 min
const cache = new Map(); // dbPath → { jars, capturedAt }

const OPERACAO_BASE = 'https://operacao.portaldecompraspublicas.com.br';

// ----- session lifecycle -----

function dbKey(db) {
  // better-sqlite3 expõe .name = caminho do arquivo SQLite
  return db.name || db.filename || 'unknown';
}

function getCredenciais(db) {
  const u = db.prepare("SELECT valor FROM config WHERE chave='pcp_usuario'").get();
  const s = db.prepare("SELECT valor FROM config WHERE chave='pcp_senha'").get();
  if (!u?.valor || !s?.valor) {
    throw new PcpLoginError('sem-credenciais', 'Credenciais PCP não configuradas para este tenant');
  }
  return { usuario: u.valor, senha: s.valor };
}

async function ensureSession(db) {
  const key = dbKey(db);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.capturedAt < SESSION_TTL_MS) {
    return cached.jars;
  }
  const { usuario, senha } = getCredenciais(db);
  const { jars } = await loginPcp(usuario, senha);
  cache.set(key, { jars, capturedAt: Date.now() });
  return jars;
}

function invalidate(db) {
  cache.delete(dbKey(db));
}

// ----- HTTP fetcher autenticado, com decode iso-8859-1 e retry-on-expiry -----

async function fetchPcpHtml(db, url, { retryOnExpiry = true } = {}) {
  let jars = await ensureSession(db);
  let r = await fetchWithJars(url, jars);

  // Detect session expiry: PCP redireciona pra Keycloak (host iam.*) quando
  // sessão IIS morre. Como seguimos redirects, o finalUrl revela isso.
  // Há também um segundo caminho de expiração: o portal joga pra
  // operacao.../<n>/loginext/oAuth (não pro host iam.*) — antes não era
  // reconhecido e o ciclo inteiro era pulado com "Redirect inesperado".
  const expirou =
    r.finalUrl.includes('iam.secure.portaldecompraspublicas') ||
    /\/loginext\/oauth/i.test(r.finalUrl) ||
    /id="kc-form-login"|action="[^"]*login-actions\/authenticate/i.test(r.body);

  if (expirou && retryOnExpiry) {
    invalidate(db);
    jars = await ensureSession(db);
    r = await fetchWithJars(url, jars);
  }
  return r;
}

// POST form-urlencoded autenticado (mesma detecção de expiração do GET).
async function postPcpForm(db, url, formStr, { retryOnExpiry = true, extraHeaders = {} } = {}) {
  let jars = await ensureSession(db);
  let r = await fetchWithJars(url, jars, { method: 'POST', body: formStr, extraHeaders });
  const expirou =
    r.finalUrl.includes('iam.secure.portaldecompraspublicas') ||
    /\/loginext\/oauth/i.test(r.finalUrl) ||
    /id="kc-form-login"|action="[^"]*login-actions\/authenticate/i.test(r.body);
  if (expirou && retryOnExpiry) {
    invalidate(db);
    jars = await ensureSession(db);
    r = await fetchWithJars(url, jars, { method: 'POST', body: formStr, extraHeaders });
  }
  return r;
}

// Status da sessão pro badge da UI (mirror de bnc-client.getSessionInfo).
function getPcpSessionInfo(db) {
  let usuario = null;
  let configurado = false;
  try {
    const u = db.prepare("SELECT valor FROM config WHERE chave='pcp_usuario'").get();
    const s = db.prepare("SELECT valor FROM config WHERE chave='pcp_senha'").get();
    usuario = u?.valor || null;
    configurado = !!(u?.valor && s?.valor);
  } catch (e) {}
  const cached = cache.get(dbKey(db));
  const idadeMs = cached ? Date.now() - cached.capturedAt : null;
  return {
    configurado,
    usuario,
    sessaoAtiva: !!cached,
    idadeMs,
    expirando: idadeMs != null && idadeMs > SESSION_TTL_MS,
  };
}

// GET (default) ou POST form-urlencoded. Numa resposta de redirect o método
// vira GET e o body é descartado (comportamento de browser p/ 302/303).
async function fetchWithJars(url, jars, { method = 'GET', body = null, extraHeaders = {} } = {}) {
  let cur = url;
  let curMethod = method;
  let curBody = body;
  let bodyBuf = null;
  let ct = '';
  let finalUrl = url;
  let status = 0;

  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(cur);
    if (!jars[u.host]) jars[u.host] = {};

    const headers = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      Cookie: jarToHeader(jars[u.host]),
      ...extraHeaders,
    };
    if (curBody != null) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
    }
    const resp = await fetch(cur, {
      method: curMethod,
      headers,
      body: curBody != null ? curBody : undefined,
      redirect: 'manual',
    });
    status = resp.status;
    finalUrl = cur;
    Object.assign(jars[u.host], parseSetCookies(resp.headers));

    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get('location');
      if (!loc) break;
      cur = loc.startsWith('http') ? loc : new URL(loc, cur).toString();
      curMethod = 'GET';
      curBody = null;
      continue;
    }

    bodyBuf = await resp.arrayBuffer();
    ct = resp.headers.get('content-type') || '';
    break;
  }

  // Decode conforme content-type. PCP envia iso-8859-1 nas páginas operacionais.
  const charset = /charset=([\w-]+)/i.exec(ct)?.[1]?.toLowerCase() || 'iso-8859-1';
  const decoded = bodyBuf ? new TextDecoder(charset).decode(bodyBuf) : '';
  return { status, body: decoded, finalUrl, ct };
}

// ----- parser de tabela #searchTableSorter (compartilhado entre Seus Pregões e Sessões Públicas) -----

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html, attr = 'title') {
  // procura o primeiro title="..." (do <a> ou <img>) — usado pra Situação e Tipo
  const m = html.match(new RegExp(`${attr}="([^"]+)"`, 'i'));
  return m ? m[1] : null;
}

function parsePregaoTable(html, opts = {}) {
  // Captura tbody (apenas o primeiro #searchTableSorter)
  const tableMatch = html.match(/<table[^>]*id="searchTableSorter"[\s\S]*?<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tableMatch) return { pregoes: [], pagina: opts.pagina || 1, paginas: 1, total: 0 };

  const tbody = tableMatch[1];
  const trs = tbody.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];

  // "Nenhum registro encontrado" aparece como linha única com colspan
  const emptyRow = trs.length === 1 && /colspan/i.test(trs[0]) && /nenhum|sem registros/i.test(stripTags(trs[0]));
  if (emptyRow) return { pregoes: [], pagina: opts.pagina || 1, paginas: 1, total: 0 };

  const pregoes = trs
    .map((tr) => {
      const tds = tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
      if (tds.length < 7) return null;

      // col 0: número curto + (opcional) #numeroTexto<ID> com número longo
      const numeroLongo =
        tds[0].match(/<p[^>]*id="numeroTexto\d+"[^>]*>([^<]+)<\/p>/)?.[1]?.trim() ||
        stripTags(tds[0]);
      const numero = tds[0].match(/<a[^>]*>([^<]+)<\/a>/)?.[1]?.trim() || numeroLongo;
      // chaveId aparece em numeroTexto<ID> (linhas longas) OU no link ttCD_CHAVE=<ID> (col 6).
      // Como col 6 sempre tem o link, usar lá é mais robusto. Cai pro col 0 só se link faltar.
      const chaveId =
        tr.match(/ttCD_CHAVE=(\d+)/)?.[1] ||
        tr.match(/numeroTexto(\d+)/)?.[1] ||
        null;

      // col 1: unidade — pega o <p> que tem a string longa
      const unidade =
        tds[1].match(/<p[^>]*id="unidadeTexto\d+"[^>]*>([^<]+)<\/p>/)?.[1]?.trim() ||
        stripTags(tds[1]);

      // col 2: objeto
      const objeto =
        tds[2].match(/<p[^>]*id="objetoTexto\d+"[^>]*>([^<]+)<\/p>/)?.[1]?.trim() ||
        stripTags(tds[2]);

      // col 3: tipo — sigla (PE) + title completo (Pregão Eletrônico)
      const tipoSigla = stripTags(tds[3]);
      const tipoCompleto = extractTitle(tds[3]) || tipoSigla;

      // col 4: data abertura
      const abertura = stripTags(tds[4]);

      // col 5: situação — title da <a> ou alt do <img>
      const situacao =
        tds[5].match(/<a[^>]*title="([^"]+)"/)?.[1] ||
        tds[5].match(/<img[^>]*alt="([^"]+)"/)?.[1] ||
        '';

      // col 6: ações — links interessantes
      const linkVisualizar =
        tds[6].match(/href="([^"]*\/Pregoes\/DadosPregao\/[^"]+)"/)?.[1]?.replace(/&amp;/g, '&') || null;
      const linkAtas =
        tds[6].match(/href="([^"]*\/Atas\/\?[^"]+)"/)?.[1]?.replace(/&amp;/g, '&') || null;
      const acoes = (tds[6].match(/<a[^>]+title="([^"]+)"/g) || [])
        .map((m) => m.match(/title="([^"]+)"/)?.[1])
        .filter(Boolean);

      return {
        chaveId,
        numero,
        numeroLongo,
        unidade,
        objeto,
        tipoSigla,
        tipoCompleto,
        abertura,
        situacao,
        linkVisualizar: linkVisualizar ? OPERACAO_BASE + linkVisualizar : null,
        linkAtas: linkAtas ? OPERACAO_BASE + linkAtas : null,
        acoes,
      };
    })
    .filter(Boolean);

  // Paginação: olha pagesBlock pra contar paginas
  const paginaAtualMatch = html.match(/<a[^>]*class="[^"]*highLight[^"]*"[^>]*>(\d+)<\/a>/);
  const paginaAtual = paginaAtualMatch ? parseInt(paginaAtualMatch[1], 10) : opts.pagina || 1;
  const todasPaginas = [...html.matchAll(/ttPagina=(\d+)/g)].map((m) => parseInt(m[1], 10));
  const paginas = todasPaginas.length ? Math.max(...todasPaginas) : 1;

  return { pregoes, pagina: paginaAtual, paginas, total: pregoes.length };
}

// ----- API pública -----

async function listSeusPregoes(db, { pagina = 1 } = {}) {
  const url = `${OPERACAO_BASE}/4/SeusPregoes/?ttPagina=${pagina}`;
  const { body, finalUrl } = await fetchPcpHtml(db, url);
  if (!finalUrl.includes('/SeusPregoes')) {
    throw new Error(`Redirect inesperado: ${finalUrl}`);
  }
  return parsePregaoTable(body, { pagina });
}

async function listSessoesPublicas(db, { pagina = 1 } = {}) {
  const url = `${OPERACAO_BASE}/4/SessoesPublicas/?ttPagina=${pagina}`;
  const { body, finalUrl } = await fetchPcpHtml(db, url);
  if (!finalUrl.includes('/SessoesPublicas')) {
    throw new Error(`Redirect inesperado: ${finalUrl}`);
  }
  return parsePregaoTable(body, { pagina });
}

module.exports = {
  listSeusPregoes,
  listSessoesPublicas,
  fetchPcpHtml,
  postPcpForm,
  getPcpSessionInfo,
  invalidate,
  // exposto pra testes
  parsePregaoTable,
};
