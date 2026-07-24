#!/usr/bin/env node
// import-fiscal-classificacao.js (2026-07-09)
//
// Ingestão do catálogo de classificação fiscal no Postgres (catalog-pg):
//   - fiscal_ncm   : Nomenclatura Comum do Mercosul (fonte oficial Siscomex, JSON)
//   - fiscal_cest  : Código Especificador da ST (fonte comunidade sped-nfe, SQL)
//
// Idempotente e re-executável (pode virar cron diário). Recria o conteúdo das
// tabelas de referência (TRUNCATE + reload) dentro de transação.
//
// Uso:
//   sudo -u carlosfinezi node scripts/import-fiscal-classificacao.js
//
// Fontes:
//   NCM  https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json?perfil=PUBLICO
//   CEST https://raw.githubusercontent.com/nfephp-org/nfephp/master/exemplos/sql/cest.sql
//         (comunidade sped-nfe; ~970 códigos, levemente defasado vs. Convênio ICMS 142/2018 —
//          curadoria contra CONFAZ é trabalho de fase posterior, ver caminho (c))

'use strict';

const catalogPg = require('../catalog-pg');

const URL_NCM = 'https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json?perfil=PUBLICO';
const URL_CEST = 'https://raw.githubusercontent.com/nfephp-org/nfephp/master/exemplos/sql/cest.sql';

// só dígitos
const digs = (s) => String(s || '').replace(/\D/g, '');
// limpa os travessões hierárquicos ("-- Outros" -> "Outros")
const limpaDesc = (s) => String(s || '').replace(/^[-\s]+/, '').trim();

async function baixar(url, comoTexto) {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} em ${url}`);
  return comoTexto ? resp.text() : resp.json();
}

// ---------------------------------------------------------------- NCM
// Constrói descrição-caminho concatenando os ancestrais na hierarquia
// (um nó "-- Outros" só faz sentido junto dos pais). Ancestral = código cujo
// dígito-string é prefixo próprio do nó, entre os comprimentos {2,4,5,6,7}.
function montarNcm(nomenclaturas) {
  const entradas = nomenclaturas.map((n) => ({
    dig: digs(n.Codigo),
    fmt: n.Codigo,
    desc: limpaDesc(n.Descricao),
    vigente: (n.Data_Fim || '') === '31/12/9999',
  })).filter((e) => e.dig.length >= 2);

  const porDig = new Map(entradas.map((e) => [e.dig, e]));
  const comprimentos = [2, 4, 5, 6, 7]; // possíveis níveis de ancestral

  return entradas.map((e) => {
    const caminho = [];
    for (const len of comprimentos) {
      if (len >= e.dig.length) break;
      const anc = porDig.get(e.dig.slice(0, len));
      if (anc) caminho.push(anc.desc);
    }
    caminho.push(e.desc);
    return {
      codigo: e.dig,
      codigo_fmt: e.fmt,
      descricao: e.desc,
      descricao_caminho: caminho.join(' > '),
      nivel: e.dig.length,
      folha: e.dig.length === 8,
      vigente: e.vigente,
    };
  });
}

// ---------------------------------------------------------------- CEST
// Parse dos INSERTs: INSERT INTO `tabelacest` VALUES (id, cest, ncm, 'desc');
// cest perde zero à esquerda (0100100) -> pad p/ 7; ncm pode ser prefixo (2..8).
function montarCest(sql) {
  const re = /VALUES\s*\(\s*\d+\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.|'')*)'\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(sql)) !== null) {
    const cest = m[1].padStart(7, '0');
    const ncmPrefix = m[2]; // já é dígito puro; comprimento variável = nível de match
    const desc = m[3].replace(/''/g, "'").replace(/\\'/g, "'").trim();
    if (cest.length !== 7) continue;
    out.push({ cest, ncm_prefix: ncmPrefix, descricao: desc });
  }
  return out;
}

async function criarSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS fiscal_ncm (
      codigo            TEXT PRIMARY KEY,
      codigo_fmt        TEXT,
      descricao         TEXT NOT NULL,
      descricao_caminho TEXT NOT NULL,
      nivel             INT  NOT NULL,
      folha             BOOLEAN NOT NULL DEFAULT false,
      vigente           BOOLEAN NOT NULL DEFAULT true,
      atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS fiscal_cest (
      id          SERIAL PRIMARY KEY,
      cest        TEXT NOT NULL,
      ncm_prefix  TEXT NOT NULL,
      descricao   TEXT NOT NULL
    );
    -- busca textual por trigram (mesmo padrão GIN+ILIKE do catálogo)
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS unaccent;
    CREATE INDEX IF NOT EXISTS idx_fiscal_ncm_caminho_trgm
      ON fiscal_ncm USING gin (LOWER(descricao_caminho) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_fiscal_ncm_folha ON fiscal_ncm (folha) WHERE folha;
    CREATE INDEX IF NOT EXISTS idx_fiscal_cest_prefix ON fiscal_cest (ncm_prefix);
    -- cache das sugestões de IA (classificação independe de tenant -> cache compartilhado)
    CREATE TABLE IF NOT EXISTS fiscal_classificacao_cache (
      texto_hash TEXT PRIMARY KEY,
      texto      TEXT NOT NULL,
      resultado  JSONB NOT NULL,
      criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function carregarNcm(client, rows) {
  await client.query('TRUNCATE fiscal_ncm');
  // insere em lotes de 1000 via multi-row VALUES
  const cols = 7;
  for (let i = 0; i < rows.length; i += 1000) {
    const lote = rows.slice(i, i + 1000);
    const params = [];
    const tuples = lote.map((r, j) => {
      const b = j * cols;
      params.push(r.codigo, r.codigo_fmt, r.descricao, r.descricao_caminho, r.nivel, r.folha, r.vigente);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
    });
    await client.query(
      `INSERT INTO fiscal_ncm (codigo, codigo_fmt, descricao, descricao_caminho, nivel, folha, vigente)
       VALUES ${tuples.join(',')} ON CONFLICT (codigo) DO NOTHING`,
      params
    );
  }
}

async function carregarCest(client, rows) {
  await client.query('TRUNCATE fiscal_cest');
  const cols = 3;
  for (let i = 0; i < rows.length; i += 1000) {
    const lote = rows.slice(i, i + 1000);
    const params = [];
    const tuples = lote.map((r, j) => {
      const b = j * cols;
      params.push(r.cest, r.ncm_prefix, r.descricao);
      return `($${b + 1},$${b + 2},$${b + 3})`;
    });
    await client.query(
      `INSERT INTO fiscal_cest (cest, ncm_prefix, descricao) VALUES ${tuples.join(',')}`,
      params
    );
  }
}

async function main() {
  console.log('[fiscal] baixando NCM (Siscomex)...');
  const ncmJson = await baixar(URL_NCM, false);
  const ncmRows = montarNcm(ncmJson.Nomenclaturas || []);
  console.log(`[fiscal] NCM: ${ncmRows.length} entradas (${ncmRows.filter((r) => r.folha).length} folhas) · ${ncmJson.Data_Ultima_Atualizacao_NCM}`);

  console.log('[fiscal] baixando CEST (sped-nfe)...');
  const cestSql = await baixar(URL_CEST, true);
  const cestRows = montarCest(cestSql);
  console.log(`[fiscal] CEST: ${cestRows.length} códigos`);

  if (ncmRows.length < 10000 || cestRows.length < 800) {
    throw new Error(`contagens suspeitas (ncm=${ncmRows.length}, cest=${cestRows.length}) — abortando sem gravar`);
  }

  await catalogPg.withTx(async (client) => {
    await criarSchema(client);
    await carregarNcm(client, ncmRows);
    await carregarCest(client, cestRows);
  });

  // verificação pós-carga
  const [{ n: nNcm }] = await catalogPg.query('SELECT count(*)::int n FROM fiscal_ncm');
  const [{ n: nFolha }] = await catalogPg.query('SELECT count(*)::int n FROM fiscal_ncm WHERE folha');
  const [{ n: nCest }] = await catalogPg.query('SELECT count(*)::int n FROM fiscal_cest');
  const [{ n: nNull }] = await catalogPg.query("SELECT count(*)::int n FROM fiscal_ncm WHERE codigo IS NULL OR descricao_caminho IS NULL OR descricao_caminho=''");
  console.log(`[fiscal] gravado: fiscal_ncm=${nNcm} (folhas=${nFolha}), fiscal_cest=${nCest}, nulos_ncm=${nNull}`);
  await catalogPg.close();
}

main().catch((e) => { console.error('[fiscal] ERRO:', e.message); process.exit(1); });
