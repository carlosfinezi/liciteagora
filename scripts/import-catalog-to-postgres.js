// import-catalog-to-postgres.js (2026-05-23)
//
// Importa catalog.db (SQLite) → liciteagora_catalog (Postgres) usando COPY.
// Lê em batches do SQLite, escreve via stream COPY no Postgres (5-10x mais
// rápido que INSERT). Idempotente: TRUNCATE tabela alvo antes de cada.
//
// Uso:
//   node scripts/import-catalog-to-postgres.js                # todas tabelas
//   node scripts/import-catalog-to-postgres.js licitacoes     # só essa
//   node scripts/import-catalog-to-postgres.js --skip-indexes # pula CREATE INDEX no fim
//
// Tempo estimado: 3-4h (15M itens é o gargalo).
// Recursos: ~1 GB RAM, ~50% CPU (1 core), ~50MB/s I/O.

'use strict';

const Database = require('better-sqlite3');
const { Client } = require('pg');
const { from: copyFrom } = require('pg-copy-streams');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

// ===== Config =====
const SQLITE_PATH = '/home/carlosfinezi/web/liciteagora.com.br/private/data/catalog.db';
const PG_PASS_FILE = '/etc/postgresql/16/main/liciteagora_catalog.pass';
const BATCH_SIZE = 50000;  // 50k rows por batch — bom equilíbrio memória/throughput

// ===== Mapeamento tabela → (colunas SQLite, colunas Postgres, transform) =====
//
// transform(row): array de valores na ordem das colunas pg.
// null vai pra `\N` no formato COPY texto.

const TABELAS = [
  // (pequenas primeiro pra validar pipeline)
  {
    nome: 'catalog_sync_state',
    sqlSelect: 'SELECT key, value, updated_at FROM catalog_sync_state',
    pgCols: ['key', 'value', 'updated_at'],
    transform: r => [r.key, r.value, r.updated_at],
  },
  {
    nome: 'orgaos_lookup',
    sqlSelect: 'SELECT codigoUasg, dados, dataAtualizacao FROM orgaos_lookup',
    pgCols: ['codigoUasg', 'dados', 'dataAtualizacao'],
    transform: r => [r.codigoUasg, r.dados, r.dataAtualizacao],
  },
  {
    nome: 'dadosabertos_cache',
    sqlSelect: 'SELECT endpoint, queryHash, queryParams, resposta, dataCache, expiresAt FROM dadosabertos_cache',
    pgCols: ['endpoint', 'queryHash', 'queryParams', 'resposta', 'dataCache', 'expiresAt'],
    transform: r => [r.endpoint, r.queryHash, r.queryParams, r.resposta, r.dataCache, r.expiresAt],
  },
  {
    nome: 'bi_aborts',
    sqlSelect: 'SELECT dia, modalidade, servidor, motivo, primeiraAbortEm, ultimaTentativaEm, tentativasRetry, resolvidoEm FROM bi_aborts',
    pgCols: ['dia', 'modalidade', 'servidor', 'motivo', 'primeiraAbortEm', 'ultimaTentativaEm', 'tentativasRetry', 'resolvidoEm'],
    transform: r => [r.dia, r.modalidade, r.servidor, r.motivo, r.primeiraAbortEm, r.ultimaTentativaEm, r.tentativasRetry, r.resolvidoEm],
  },
  {
    nome: 'bi_item_classificacao_ia',
    sqlSelect: 'SELECT itemId, escopo, ehAprovado, motivo, modelo, classificadoEm FROM bi_item_classificacao_ia',
    pgCols: ['itemId', 'escopo', 'ehAprovado', 'motivo', 'modelo', 'classificadoEm'],
    transform: r => [r.itemId, r.escopo, r.ehAprovado, r.motivo, r.modelo, r.classificadoEm],
  },
  {
    nome: 'bi_item_sugestao_produto',
    sqlSelect: 'SELECT itemId, marca, modelo_sugerido, score, requisitos, motivo, modelo_ia, classificadoEm FROM bi_item_sugestao_produto',
    pgCols: ['itemId', 'marca', 'modelo_sugerido', 'score', 'requisitos', 'motivo', 'modelo_ia', 'classificadoEm'],
    transform: r => [r.itemId, r.marca, r.modelo_sugerido, r.score, r.requisitos, r.motivo, r.modelo_ia, r.classificadoEm],
  },
  // Grandes
  {
    nome: 'licitacoes',
    sqlSelect: `SELECT id, numeroControlePNCP, cnpj, razaoSocial, ufSigla, municipioNome, nomeUnidade,
                codigoUnidade, anoCompra, sequencialCompra, numeroCompra, processo, modalidadeId, modalidadeNome,
                objetoCompra, informacaoComplementar, valorTotalEstimado, dataPublicacaoPncp, dataAberturaProposta,
                dataEncerramentoProposta, situacaoCompraNome, linkSistemaOrigem, srp, usuarioNome, dadosCompletos,
                dataAtualizacao FROM licitacoes`,
    pgCols: ['id', 'numeroControlePNCP', 'cnpj', 'razaoSocial', 'ufSigla', 'municipioNome', 'nomeUnidade',
             'codigoUnidade', 'anoCompra', 'sequencialCompra', 'numeroCompra', 'processo', 'modalidadeId', 'modalidadeNome',
             'objetoCompra', 'informacaoComplementar', 'valorTotalEstimado', 'dataPublicacaoPncp', 'dataAberturaProposta',
             'dataEncerramentoProposta', 'situacaoCompraNome', 'linkSistemaOrigem', 'srp', 'usuarioNome', 'dadosCompletos',
             'dataAtualizacao'],
    transform: r => [r.id, r.numeroControlePNCP, r.cnpj, r.razaoSocial, r.ufSigla, r.municipioNome, r.nomeUnidade,
                     r.codigoUnidade, r.anoCompra, r.sequencialCompra, r.numeroCompra, r.processo, r.modalidadeId, r.modalidadeNome,
                     r.objetoCompra, r.informacaoComplementar, r.valorTotalEstimado, r.dataPublicacaoPncp, r.dataAberturaProposta,
                     r.dataEncerramentoProposta, r.situacaoCompraNome, r.linkSistemaOrigem, r.srp, r.usuarioNome, r.dadosCompletos,
                     r.dataAtualizacao],
  },
  {
    nome: 'resultados_bi',
    sqlSelect: `SELECT cnpj, ano, sequencial, numeroItem, niFornecedor, nomeRazaoSocialFornecedor,
                valorUnitarioHomologado, valorTotalHomologado, marcaFabricante, modeloVersao, dataResultado,
                dadosCompletos, dataCache FROM resultados_bi`,
    pgCols: ['cnpj', 'ano', 'sequencial', 'numeroItem', 'niFornecedor', 'nomeRazaoSocialFornecedor',
             'valorUnitarioHomologado', 'valorTotalHomologado', 'marcaFabricante', 'modeloVersao', 'dataResultado',
             'dadosCompletos', 'dataCache'],
    transform: r => [r.cnpj, r.ano, r.sequencial, r.numeroItem, r.niFornecedor, r.nomeRazaoSocialFornecedor,
                     r.valorUnitarioHomologado, r.valorTotalHomologado, r.marcaFabricante, r.modeloVersao, r.dataResultado,
                     r.dadosCompletos, r.dataCache],
  },
  {
    nome: 'itens',
    sqlSelect: `SELECT id, licitacaoId, numeroControlePNCP, numeroItem, descricao, quantidade, unidadeMedida,
                valorUnitarioEstimado, valorTotal, dadosCompletos, marcaExtraida, marcaConfianca, marcaExtraidaEm
                FROM itens`,
    pgCols: ['id', 'licitacaoId', 'numeroControlePNCP', 'numeroItem', 'descricao', 'quantidade', 'unidadeMedida',
             'valorUnitarioEstimado', 'valorTotal', 'dadosCompletos', 'marcaExtraida', 'marcaConfianca', 'marcaExtraidaEm'],
    transform: r => [r.id, r.licitacaoId, r.numeroControlePNCP, r.numeroItem, r.descricao, r.quantidade, r.unidadeMedida,
                     r.valorUnitarioEstimado, r.valorTotal, r.dadosCompletos, r.marcaExtraida, r.marcaConfianca, r.marcaExtraidaEm],
  },
];

// ===== Conversão pra COPY format =====
//
// Postgres COPY texto: campos separados por TAB, \N = null, escape \t \n \r \\.
function copyEscape(v) {
  if (v === null || v === undefined) return '\\N';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (v instanceof Date) return v.toISOString();
  // string
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function rowToCopyLine(values) {
  return values.map(copyEscape).join('\t') + '\n';
}

// ===== Stream-based: produz linhas COPY em pull mode =====
async function importarTabela(sqliteDb, pgClient, tabela) {
  const stmt = sqliteDb.prepare(`SELECT COUNT(*) AS c FROM ${tabela.nome}`);
  const total = stmt.get().c;
  console.log(`\n[${tabela.nome}] ${total.toLocaleString('pt-BR')} linhas a importar`);

  if (total === 0) {
    console.log(`[${tabela.nome}] tabela vazia, skip`);
    return;
  }

  // TRUNCATE alvo (idempotente — re-rodar o import limpa antes)
  await pgClient.query(`TRUNCATE TABLE ${tabela.nome} RESTART IDENTITY CASCADE`);
  console.log(`[${tabela.nome}] TRUNCATE OK`);

  // COPY stream
  const cols = tabela.pgCols.map(c => `"${c}"`).join(', ');
  const copySql = `COPY ${tabela.nome} (${cols}) FROM STDIN WITH (FORMAT text, NULL '\\N')`;
  const copyStream = pgClient.query(copyFrom(copySql));

  // Source: itera SQLite em batches (lazy via iterate)
  const t0 = Date.now();
  let importadas = 0;
  let lastLog = Date.now();

  const sourceIter = sqliteDb.prepare(tabela.sqlSelect).iterate();

  for (const row of sourceIter) {
    const values = tabela.transform(row);
    const line = rowToCopyLine(values);
    if (!copyStream.write(line)) {
      // backpressure
      await new Promise(resolve => copyStream.once('drain', resolve));
    }
    importadas++;
    if (Date.now() - lastLog > 5000) {
      const pct = ((importadas / total) * 100).toFixed(1);
      const taxa = Math.round(importadas / ((Date.now() - t0) / 1000));
      console.log(`[${tabela.nome}] ${importadas.toLocaleString('pt-BR')}/${total.toLocaleString('pt-BR')} (${pct}%) — ${taxa.toLocaleString('pt-BR')} rows/s`);
      lastLog = Date.now();
    }
  }

  copyStream.end();
  await new Promise((resolve, reject) => {
    copyStream.on('finish', resolve);
    copyStream.on('error', reject);
  });

  const seg = ((Date.now() - t0) / 1000).toFixed(1);
  const taxa = Math.round(importadas / ((Date.now() - t0) / 1000));
  console.log(`[${tabela.nome}] ✅ ${importadas.toLocaleString('pt-BR')} rows em ${seg}s (${taxa.toLocaleString('pt-BR')} rows/s)`);

  // Reseta sequence pra próximo INSERT seguir do ID máx
  try {
    await pgClient.query(`SELECT setval(pg_get_serial_sequence('${tabela.nome}', 'id'), COALESCE(MAX(id), 1)) FROM ${tabela.nome}`);
  } catch (_) { /* tabela sem coluna id/serial */ }
}

// ===== Índices Postgres-otimizados (criar DEPOIS do import) =====
const INDICES_SQL = `
-- licitacoes: lookups frequentes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lic_encerramento ON licitacoes USING brin (dataEncerramentoProposta);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lic_publicacao ON licitacoes USING brin (dataPublicacaoPncp);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lic_modalidade ON licitacoes (modalidadeId);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lic_cnpj ON licitacoes (cnpj);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lic_cnpj_ano_seq ON licitacoes (cnpj, anoCompra, sequencialCompra);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lic_uf ON licitacoes (ufSigla);
-- busca em objetoCompra: trigram (LIKE) + tsvector (full-text)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lic_objeto_trgm ON licitacoes USING gin (objetoCompra gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lic_objeto_fts ON licitacoes USING gin (to_tsvector('portuguese', coalesce(objetoCompra,'')));

-- itens: JOIN com licitacoes + busca textual
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_itens_licitacao ON itens (licitacaoId);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_itens_numero ON itens (numeroControlePNCP);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_itens_desc_trgm ON itens USING gin (descricao gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_itens_desc_fts ON itens USING gin (to_tsvector('portuguese', coalesce(descricao,'')));
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_itens_marca_extraida ON itens (marcaExtraida) WHERE marcaExtraida IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_itens_marca_pendente ON itens (id) WHERE marcaExtraidaEm IS NULL;

-- resultados_bi
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_res_item ON resultados_bi (cnpj, ano, sequencial, numeroItem);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_res_fornecedor ON resultados_bi (niFornecedor);

-- bi_aborts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bi_aborts_pend ON bi_aborts (resolvidoEm) WHERE resolvidoEm IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bi_aborts_dia_mod ON bi_aborts (dia, modalidade);

-- bi_item_classificacao_ia
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bi_class_escopo_aprovado ON bi_item_classificacao_ia (escopo, ehAprovado);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bi_class_itemId ON bi_item_classificacao_ia (itemId);

-- bi_item_sugestao_produto
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sugestao_item ON bi_item_sugestao_produto (itemId);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sugestao_marca ON bi_item_sugestao_produto (marca, score);

-- dadosabertos_cache
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dadosabertos_expires ON dadosabertos_cache (expiresAt);
`;

async function criarIndices(pgClient) {
  console.log('\n[indices] criando índices Postgres-otimizados...');
  // CONCURRENTLY não pode rodar em transação implícita; psql -c faz autocommit.
  // Aqui via pg client, cada CREATE INDEX é uma statement autocommit.
  const statements = INDICES_SQL.split(';').map(s => s.trim()).filter(s => s && !s.startsWith('--'));
  for (const sql of statements) {
    const m = sql.match(/CREATE INDEX[^I]+IF NOT EXISTS\s+(\w+)/i);
    const nome = m ? m[1] : sql.substring(0, 60);
    process.stdout.write(`  ${nome}... `);
    const t0 = Date.now();
    try {
      await pgClient.query(sql);
      console.log(`OK (${((Date.now()-t0)/1000).toFixed(1)}s)`);
    } catch (e) {
      console.log(`ERRO: ${e.message}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const skipIndexes = args.includes('--skip-indexes');
  const onlyTable = args.find(a => !a.startsWith('--'));

  const senha = fs.readFileSync(PG_PASS_FILE, 'utf8').trim();
  const pgClient = new Client({
    host: 'localhost',
    port: 5432,
    user: 'liciteagora_catalog',
    password: senha,
    database: 'liciteagora_catalog',
  });
  await pgClient.connect();
  console.log('[pg] conectado');

  const sqliteDb = new Database(SQLITE_PATH, { readonly: true });
  sqliteDb.pragma('journal_mode = WAL'); // só pra evitar erros
  console.log(`[sqlite] aberto: ${SQLITE_PATH}`);

  const t0 = Date.now();
  const tabelasFiltradas = onlyTable
    ? TABELAS.filter(t => t.nome === onlyTable)
    : TABELAS;

  for (const tab of tabelasFiltradas) {
    try {
      await importarTabela(sqliteDb, pgClient, tab);
    } catch (e) {
      console.error(`[${tab.nome}] FALHA: ${e.message}`);
      console.error(e.stack);
    }
  }

  if (!skipIndexes && !onlyTable) {
    await criarIndices(pgClient);
  }

  await pgClient.query('ANALYZE');
  console.log(`\n[done] total: ${((Date.now()-t0)/1000/60).toFixed(1)} min`);

  await pgClient.end();
  sqliteDb.close();
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
