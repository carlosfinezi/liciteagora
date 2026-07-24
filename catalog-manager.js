// catalog-manager.js
//
// Gerencia o catálogo PNCP compartilhado (data/catalog.db) em oposição
// aos DBs de tenant (data/tenants/<slug>/pncp.db). Dados públicos do
// PNCP/ComprasNet (licitações, itens, análises IA) vivem aqui — uma
// única cópia para todos os tenants. Introduzido na Fase 8 (Plano 8,
// 2026-04-22) para eliminar duplicação de ~4.5 GB por tenant e
// centralizar o ciclo de sync do master.
//
// Ligação com tenants:
//   - Master (scheduler.js) abre catalog.db direto para sync.
//   - Workers chamam attachCatalog(tenantDb) logo após abrir cada
//     conexão — faz ATTACH DATABASE + cria TEMP VIEWs para que
//     SELECTs existentes em `licitacoes`/`itens`/etc. continuem
//     funcionando sem mudança de código. VIEWs rejeitam INSERT/
//     UPDATE/DELETE (proteção contra escrita acidental via worker).
//
// Os 3 escritores-exceção do worker (bi-routes, pedidos-routes,
// analise-ia-routes) usam prefixo `catalog.` nas queries.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const CATALOG_DB_PATH = path.join(__dirname, 'data', 'catalog.db');

// Tabelas do catálogo. Estas NÃO ficam mais em cada tenant/pncp.db.
const CATALOG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS licitacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numeroControlePNCP TEXT UNIQUE,
    cnpj TEXT,
    razaoSocial TEXT,
    ufSigla TEXT,
    municipioNome TEXT,
    nomeUnidade TEXT,
    codigoUnidade TEXT,
    anoCompra INTEGER,
    sequencialCompra INTEGER,
    numeroCompra TEXT,
    processo TEXT,
    modalidadeId INTEGER,
    modalidadeNome TEXT,
    objetoCompra TEXT,
    informacaoComplementar TEXT,
    valorTotalEstimado REAL,
    dataPublicacaoPncp TEXT,
    dataAberturaProposta TEXT,
    dataEncerramentoProposta TEXT,
    situacaoCompraNome TEXT,
    linkSistemaOrigem TEXT,
    srp INTEGER,
    usuarioNome TEXT,
    dadosCompletos TEXT,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    licitacaoId INTEGER,
    numeroControlePNCP TEXT,
    numeroItem INTEGER,
    descricao TEXT,
    quantidade REAL,
    unidadeMedida TEXT,
    valorUnitarioEstimado REAL,
    valorTotal REAL,
    dadosCompletos TEXT,
    FOREIGN KEY (licitacaoId) REFERENCES licitacoes(id)
  );

  CREATE TABLE IF NOT EXISTS resultados_bi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    numeroItem INTEGER NOT NULL,
    niFornecedor TEXT,
    nomeRazaoSocialFornecedor TEXT,
    valorUnitarioHomologado REAL,
    valorTotalHomologado REAL,
    marcaFabricante TEXT,
    modeloVersao TEXT,
    dataResultado TEXT,
    dadosCompletos TEXT,
    dataCache TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cnpj, ano, sequencial, numeroItem, niFornecedor)
  );

  -- licitacao_analise MIGRADA para o DB de cada tenant (2026-04-23):
  -- análises de IA agora são privadas por tenant (contexto/privacidade).
  -- Ver db-schema.js.

  CREATE TABLE IF NOT EXISTS orgaos_lookup (
    codigoUasg TEXT PRIMARY KEY,
    dados TEXT,
    dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Estado de sync do master (chaves: lastFullSync, lastIncrementalSync,
  -- lastSyncDate, lastSyncStart, lastSyncEnd). Antes em config.tenant;
  -- agora global — o master roda um ciclo só.
  CREATE TABLE IF NOT EXISTS catalog_sync_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
  );

  -- Plano 10 (2026-04-23): cache de respostas das APIs Dados Abertos
  -- (pesquisa-preco e itens 14.133). TTL de 30 dias; quando expira mas
  -- API externa falha, servimos a linha velha (stale-while-error).
  CREATE TABLE IF NOT EXISTS dadosabertos_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    queryHash TEXT NOT NULL,
    queryParams TEXT NOT NULL,
    resposta TEXT NOT NULL,
    dataCache TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expiresAt TEXT NOT NULL,
    UNIQUE(endpoint, queryHash)
  );

  CREATE INDEX IF NOT EXISTS idx_licitacoes_encerramento ON licitacoes(dataEncerramentoProposta);
  CREATE INDEX IF NOT EXISTS idx_licitacoes_publicacao ON licitacoes(dataPublicacaoPncp);
  CREATE INDEX IF NOT EXISTS idx_licitacoes_modalidade ON licitacoes(modalidadeId);
  CREATE INDEX IF NOT EXISTS idx_licitacoes_cnpj ON licitacoes(cnpj);
  CREATE INDEX IF NOT EXISTS idx_itens_licitacao ON itens(licitacaoId);
  CREATE INDEX IF NOT EXISTS idx_itens_numero ON itens(numeroControlePNCP);
  CREATE INDEX IF NOT EXISTS idx_itens_descricao ON itens(descricao);
  CREATE INDEX IF NOT EXISTS idx_resultados_bi_item ON resultados_bi(cnpj, ano, sequencial, numeroItem);
  CREATE INDEX IF NOT EXISTS idx_dadosabertos_expires ON dadosabertos_cache(expiresAt);

  -- FTS5 para busca de descricao (Onda 3 perf 2026-05-06).
  -- Sem CONTENT=itens (modo external content) - mantemos copia
  -- explicita sincronizada via triggers + backfill. Razao: external
  -- content exige ROWID estavel e dispara reads do itens em cada
  -- query, perdendo metade do ganho.
  -- tokenize unicode61 remove_diacritics 2 -> ignora acentos e case.
  CREATE VIRTUAL TABLE IF NOT EXISTS itens_fts USING fts5(
    descricao,
    content='',
    tokenize = "unicode61 remove_diacritics 2"
  );

  -- Triggers de sync: novas/alteradas linhas em itens entram no FTS.
  -- O backfill inicial é feito pelo fts-backfill.js no master.
  CREATE TRIGGER IF NOT EXISTS itens_fts_insert AFTER INSERT ON itens BEGIN
    INSERT INTO itens_fts(rowid, descricao) VALUES (new.id, new.descricao);
  END;
  CREATE TRIGGER IF NOT EXISTS itens_fts_update AFTER UPDATE OF descricao ON itens BEGIN
    DELETE FROM itens_fts WHERE rowid = old.id;
    INSERT INTO itens_fts(rowid, descricao) VALUES (new.id, new.descricao);
  END;
  CREATE TRIGGER IF NOT EXISTS itens_fts_delete AFTER DELETE ON itens BEGIN
    DELETE FROM itens_fts WHERE rowid = old.id;
  END;
`;

// Tabelas expostas via TEMP VIEW no worker via attachCatalog. Inclui
// catalog_sync_state para que pncp-sync-scheduler (também carregado
// no worker, para GET /api/sync/status) possa ler o mesmo estado
// que o master escreve.
// itens_fts NÃO entra aqui: TEMP VIEW perde a sintaxe MATCH da virtual
// table FTS5. Workers acessam direto via `catalog.itens_fts` (FROM) +
// `WHERE itens_fts MATCH ?` (sem schema na cláusula MATCH).
const CATALOG_TABLES = [
  'licitacoes',
  'itens',
  'resultados_bi',
  'orgaos_lookup',
  'catalog_sync_state',
  'dadosabertos_cache',
];

// Tabelas que são de fato "dado" do PNCP (para o migrate script copiar
// de um tenant existente). catalog_sync_state é derivado, não copiado.
const CATALOG_DATA_TABLES = [
  'licitacoes',
  'itens',
  'resultados_bi',
  'orgaos_lookup',
];

function initCatalogDb(dbPath = CATALOG_DB_PATH) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 60000');  // 60s pra tolerar contenção do sync histórico massivo + cron de merge + worker pre-warm
  db.pragma('foreign_keys = ON');
  db.exec(CATALOG_SCHEMA);
  _migrarColunasMarcaItens(db);
  return db;
}

// Migração idempotente: colunas de marca extraída pela heurística do
// marca-extractor, gravadas pelo marca-backfill. Como o BI vê catalog.itens
// via TEMP VIEW (`SELECT *`), basta adicionar colunas aqui — as views são
// recriadas a cada attach e passam a expor automaticamente.
//
//   marcaExtraida    : nome da marca normalizado (ex: "Dell", "Brother")
//   marcaConfianca   : 0..1 — quão certo o extrator está
//   marcaExtraidaEm  : ISO timestamp; NULL = item ainda não processado
function _migrarColunasMarcaItens(db) {
  const cols = db.prepare(`PRAGMA table_info(itens)`).all().map(r => r.name);
  if (!cols.includes('marcaExtraida'))    db.exec(`ALTER TABLE itens ADD COLUMN marcaExtraida TEXT`);
  if (!cols.includes('marcaConfianca'))   db.exec(`ALTER TABLE itens ADD COLUMN marcaConfianca REAL`);
  if (!cols.includes('marcaExtraidaEm'))  db.exec(`ALTER TABLE itens ADD COLUMN marcaExtraidaEm TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_itens_marca_extraida ON itens(marcaExtraida) WHERE marcaExtraida IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_itens_marca_pendente ON itens(id) WHERE marcaExtraidaEm IS NULL`);
}

/**
 * Anexa catalog.db como schema `catalog` na conexão do tenant e cria
 * TEMP VIEWs `licitacoes`, `itens`, `resultados_bi`, `licitacao_analise`,
 * `orgaos_lookup` — cada uma aponta para `catalog.<tabela>`. Assim
 * SELECTs existentes no código continuam funcionando sem alteração.
 *
 * INSERT/UPDATE/DELETE em VIEW é rejeitado pelo SQLite — a única maneira
 * de escrever no catálogo a partir do worker é usar explicitamente
 * o prefixo `catalog.<tabela>` (ver bi-routes/pedidos-routes/
 * analise-ia-routes). Isso protege contra escrita acidental.
 *
 * Idempotente: `ATTACH` lança se já attached; `CREATE TEMP VIEW IF NOT EXISTS`
 * absorve a segunda chamada. Capturamos o erro de ATTACH já anexado.
 */
function attachCatalog(tenantDb, catalogPath = CATALOG_DB_PATH) {
  // Fase 3g (2026-05-23): cutover. Quando CATALOG_BACKEND_PG=1, NADA mais lê
  // catalog.db SQLite — todas as rotas/schedulers migraram pra catalogPg.*
  // (Fases 3a-3g). Pular ATTACH + VIEWs economiza ~36GB mmap por tenant
  // e evita corrupção concorrente com PG.
  if (process.env.CATALOG_BACKEND_PG === '1') return;

  if (!fs.existsSync(catalogPath)) {
    throw new Error(`catalog-manager: catalog.db não existe em ${catalogPath}. Rode scripts/migrate-split-catalog.js primeiro.`);
  }

  try {
    tenantDb.exec(`ATTACH DATABASE '${catalogPath.replace(/'/g, "''")}' AS catalog`);
  } catch (err) {
    // "database catalog is already in use" — idempotente, segue em frente.
    if (!/already in use|is already/i.test(err.message)) throw err;
  }

  // TEMP VIEWs: escopo de conexão, não persistem no arquivo pncp.db do
  // tenant. Recriadas em cada abertura pela função attachCatalog.
  for (const t of CATALOG_TABLES) {
    tenantDb.exec(`CREATE TEMP VIEW IF NOT EXISTS ${t} AS SELECT * FROM catalog.${t}`);
  }
}

/**
 * Lê/escreve catalog_sync_state (key-value). Usado pelo master para
 * rastrear lastIncrementalSync, lastFullSync, lastSyncDate, etc.
 * Substitui o antigo config-helpers no contexto do master.
 */
function createSyncStateHelpers(catalogDb) {
  const getStmt = catalogDb.prepare('SELECT value FROM catalog_sync_state WHERE key = ?');
  const setStmt = catalogDb.prepare(
    'INSERT INTO catalog_sync_state (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );

  function getSyncState(key) {
    const row = getStmt.get(key);
    return row ? row.value : null;
  }
  function setSyncState(key, value) {
    setStmt.run(key, String(value == null ? '' : value), Date.now());
  }
  return { getSyncState, setSyncState };
}

module.exports = {
  CATALOG_DB_PATH,
  CATALOG_TABLES,
  CATALOG_DATA_TABLES,
  CATALOG_SCHEMA,
  initCatalogDb,
  attachCatalog,
  createSyncStateHelpers,
};
