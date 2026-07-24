// bi-grupo-membership.js
//
// Pré-computação da associação grupo→item para o modo-grupo do BI.
//
// PROBLEMA (ver memória project_bi_grupo_fts_stopword_pg): casar ao vivo os
// ~27 termos (OR) + ~100 exclusões (NOT) de um grupo custa 3-12s por page view.
// Teto estrutural: ORDER BY data + filtro em `itens` (tabelas diferentes) +
// posting lists grandes de "de/em" (config 'simple', necessária pra preservar
// "nas"). Não dá pra furar só com índice.
//
// SOLUÇÃO: rodar o match caro OFFLINE e materializar (tenant, grupoId, itemId)
// na tabela bi_grupo_item (catalog PG, ao lado de `itens`). A página vira um
// JOIN indexado de ~600 linhas → <100ms.
//
// FRESCOR: TTL. ensureGrupo() dispara rebuild quando a membership passa de
// STALE_MS — assíncrono (serve a versão atual na hora) se já existe, síncrono
// só na 1ª vez (nunca construído). Edição de grupo também dispara rebuild
// (grupos-palavras-routes). O match offline usa o índice idx_itens_desc_simple.
//
// ESCOPO POR TENANT: grupoId é por-tenant (SQLite); `itens` é compartilhado
// (PG). Por isso a membership é chaveada por (tenant, grupoId).

const fs = require('fs');
const { Pool } = require('pg');

const STALE_MS = 6 * 60 * 60 * 1000; // 6h: rebuild assíncrono ao servir stale

// Locks in-process pra evitar rebuilds concorrentes do mesmo grupo (mesmo
// padrão de _classificarLocks em bi-routes).
const _rebuildLocks = new Set();

// Pool DEDICADO pros rebuilds. O pool do catalog-pg tem statement_timeout e
// query_timeout de 30s (protege as queries de request); rebuilds de grupos
// grandes (ex: EPIs ~50k, 66 palavras) levam minutos, então não cabem nele.
// Sem query_timeout; statement_timeout alto só como teto de segurança.
const PG_PASS_FILE = '/etc/postgresql/16/main/liciteagora_catalog.pass';
let _rebuildPool = null;
function rebuildPool() {
  if (_rebuildPool) return _rebuildPool;
  const senha = fs.readFileSync(PG_PASS_FILE, 'utf8').trim();
  _rebuildPool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER || 'liciteagora_catalog',
    password: senha,
    database: process.env.PG_DATABASE || 'liciteagora_catalog',
    max: 3,
    idleTimeoutMillis: 30000,
    statement_timeout: 600000, // 10min — teto de segurança, não limite operacional
  });
  _rebuildPool.on('error', (err) => console.error('[bi-grupo] rebuildPool error:', err.message));
  return _rebuildPool;
}
async function withRebuildTx(fn) {
  const client = await rebuildPool().connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// Tokeniza igual ao caminho FTS do bi-routes (alfanum + acentuação latina).
function wsClean(p) {
  return String(p).replace(/["()]/g, '').trim();
}

// Lê inclusões (palavras do grupo) + exclusões (grupos de exclusão vinculados)
// do SQLite do tenant e monta a expr websearch_to_tsquery('simple'): inclusões
// em OR, exclusões com prefixo '-'. Frases (multi-token) entre aspas.
// Retorna { expr, palavras, palavrasExclusao } ou null se grupo sem palavras.
function buildSimpleExpr(tenantDb, grupoId) {
  const gid = parseInt(grupoId, 10);
  if (!gid || isNaN(gid)) return null;
  const grupo = tenantDb.prepare(`SELECT id, tipo FROM grupos_palavras WHERE id = ?`).get(gid);
  if (!grupo) return null;

  const palavras = tenantDb.prepare(`SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?`)
    .all(gid).map(r => String(r.palavra || '').trim().toLowerCase()).filter(Boolean);
  if (palavras.length === 0) return null;

  let palavrasExclusao = [];
  if (!grupo.tipo || grupo.tipo === 'pesquisa') {
    palavrasExclusao = tenantDb.prepare(`
      SELECT gpi.palavra
        FROM grupos_pesquisa_exclusao gpe
        JOIN grupos_palavras_itens gpi ON gpi.grupoId = gpe.grupoExclusaoId
       WHERE gpe.grupoPesquisaId = ?
    `).all(gid).map(r => String(r.palavra || '').trim().toLowerCase()).filter(Boolean);
  }

  const palCleans = palavras.map(wsClean).filter(Boolean);
  const exclCleans = palavrasExclusao.map(wsClean).filter(Boolean);
  if (palCleans.length === 0) return null;

  // BUG FIX (2026-06-08): exclusões NÃO podem ir na MESMA expr websearch que as
  // inclusões. Em websearch_to_tsquery a precedência é NOT>AND>OR, então em
  // `incl1 OR incl2 OR ... OR inclN -excl` o `-excl` liga só ao ÚLTIMO termo
  // (inclN), não ao grupo todo — as exclusões filtravam quase nada (medido: 7 de
  // 608k no g4 reimac; 1bit "APENAS SERVIDORES" ficava 1840 em vez de 496). E
  // websearch não aceita parênteses pra agrupar. Solução: devolver inclusões e
  // exclusões SEPARADAS; o rebuild aplica `@@ ws(exprIncl) AND NOT @@ ws(exprExcl)`.
  const includeParts = palCleans.map(pl => pl.includes(' ') ? `"${pl}"` : pl);
  const excludeParts = exclCleans.map(pl => pl.includes(' ') ? `"${pl}"` : pl);
  const exprIncl = includeParts.join(' OR ');
  const exprExcl = excludeParts.join(' OR ');
  return { exprIncl, exprExcl, palavras, palavrasExclusao };
}

// DDL idempotente. Chamado uma vez no registro das rotas.
async function ensureSchema(catalogPg) {
  await catalogPg.execute(`
    CREATE TABLE IF NOT EXISTS bi_grupo_item (
      tenant    text    NOT NULL,
      "grupoId" integer NOT NULL,
      "itemId"  bigint  NOT NULL,
      PRIMARY KEY (tenant, "grupoId", "itemId")
    )
  `);
  await catalogPg.execute(`
    CREATE TABLE IF NOT EXISTS bi_grupo_membership_meta (
      tenant    text    NOT NULL,
      "grupoId" integer NOT NULL,
      "builtAt" timestamptz NOT NULL DEFAULT now(),
      "qtdItens" integer NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant, "grupoId")
    )
  `);
}

// Recomputa a membership de (tenant, grupoId): roda o match 'simple' offline e
// substitui as linhas. Idempotente. Retorna { ok, qtd } ou { ok:false, reason }.
async function rebuildGrupo({ catalogPg, tenantDb, tenant, grupoId }) {
  if (!tenant) return { ok: false, reason: 'sem tenant' };
  const gid = parseInt(grupoId, 10);
  const built = buildSimpleExpr(tenantDb, gid);
  if (!built) {
    // Grupo sem palavras: limpa membership pra não servir resultado fantasma.
    await withRebuildTx(async (client) => {
      await client.query(`DELETE FROM bi_grupo_item WHERE tenant=$1 AND "grupoId"=$2`, [tenant, gid]);
      await client.query(`
        INSERT INTO bi_grupo_membership_meta (tenant, "grupoId", "builtAt", "qtdItens")
        VALUES ($1,$2, now(), 0)
        ON CONFLICT (tenant, "grupoId") DO UPDATE SET "builtAt"=now(), "qtdItens"=0
      `, [tenant, gid]);
    });
    return { ok: true, qtd: 0 };
  }

  let qtd = 0;
  await withRebuildTx(async (client) => {
    await client.query(`DELETE FROM bi_grupo_item WHERE tenant=$1 AND "grupoId"=$2`, [tenant, gid]);
    const temExcl = !!built.exprExcl;
    const ins = await client.query(`
      INSERT INTO bi_grupo_item (tenant, "grupoId", "itemId")
      SELECT $1, $2, i."id"
        FROM itens i
       WHERE to_tsvector('simple', coalesce(i."descricao",'')) @@ websearch_to_tsquery('simple', $3)
       ${temExcl ? `AND NOT to_tsvector('simple', coalesce(i."descricao",'')) @@ websearch_to_tsquery('simple', $4)` : ''}
      ON CONFLICT DO NOTHING
    `, temExcl ? [tenant, gid, built.exprIncl, built.exprExcl] : [tenant, gid, built.exprIncl]);
    qtd = ins.rowCount || 0;
    await client.query(`
      INSERT INTO bi_grupo_membership_meta (tenant, "grupoId", "builtAt", "qtdItens")
      VALUES ($1,$2, now(), $3)
      ON CONFLICT (tenant, "grupoId") DO UPDATE SET "builtAt"=now(), "qtdItens"=$3
    `, [tenant, gid, qtd]);
  });
  return { ok: true, qtd };
}

// Dispara rebuild protegido por lock in-process. Best-effort (loga erro, não
// propaga). Usado pelo refresh por TTL e pelos hooks de edição de grupo.
function rebuildGrupoAsync({ catalogPg, tenantDb, tenant, grupoId }) {
  const key = `${tenant}|${grupoId}`;
  if (_rebuildLocks.has(key)) return;
  _rebuildLocks.add(key);
  // Captura uma referência estável ao db do tenant (o proxy resolve no momento
  // da captura; rebuildGrupo só usa prepare síncrono antes do await).
  Promise.resolve()
    .then(() => rebuildGrupo({ catalogPg, tenantDb, tenant, grupoId }))
    .then(r => { if (r && r.ok) console.log(`[bi-grupo] membership ${key} rebuild: ${r.qtd} itens`); })
    .catch(e => console.error(`[bi-grupo] rebuild ${key} falhou:`, e.message))
    .finally(() => _rebuildLocks.delete(key));
}

// Garante membership utilizável antes de uma consulta do grupo:
//   - nunca construída → rebuild SÍNCRONO (1ª vez paga o custo).
//   - stale (>STALE_MS) → rebuild ASSÍNCRONO; serve a versão atual na hora.
// Retorna sem lançar; em erro, loga (a query do grupo cai em 0 resultados,
// melhor que derrubar a página).
async function ensureGrupo({ catalogPg, tenantDb, tenant, grupoId }) {
  try {
    if (!tenant) return;
    const gid = parseInt(grupoId, 10);
    if (!gid || isNaN(gid)) return;
    const meta = await catalogPg.query(
      `SELECT "builtAt" FROM bi_grupo_membership_meta WHERE tenant=$1 AND "grupoId"=$2`, [tenant, gid]
    );
    if (!meta.length) {
      // Nunca construído: dispara rebuild ASSÍNCRONO (não bloqueia a request;
      // grupos grandes levam minutos). Esta 1ª visualização vem vazia e se
      // corrige na próxima. Grupos novos já disparam rebuild no hook de criação,
      // então isto é só rede de segurança (ex: tenant não backfillado).
      rebuildGrupoAsync({ catalogPg, tenantDb, tenant, grupoId: gid });
      return;
    }
    const age = Date.now() - new Date(meta[0].builtAt).getTime();
    if (age > STALE_MS) rebuildGrupoAsync({ catalogPg, tenantDb, tenant, grupoId: gid });
  } catch (e) {
    console.error(`[bi-grupo] ensureGrupo ${tenant}|${grupoId} falhou:`, e.message);
  }
}

async function closeRebuildPool() {
  if (_rebuildPool) { await _rebuildPool.end(); _rebuildPool = null; }
}

module.exports = { ensureSchema, buildSimpleExpr, rebuildGrupo, rebuildGrupoAsync, ensureGrupo, closeRebuildPool, STALE_MS };
