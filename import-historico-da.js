// import-historico-da.js
//
// Importação histórica de licitações + itens do PNCP via API Dados Abertos
// do Compras.gov.br. Usado para popular o catálogo retroativamente filtrando
// por descrição (ex.: todas as licitações com "synology" desde 2024).
//
// Fluxo:
//   1. Para cada palavra do grupo, página o endpoint
//      /modulo-contratacao/2_consultarItemContratacaoPncp14133?descricaoItem=X
//      que retorna itens com numeroControlePNCP.
//   2. Para cada numeroControlePNCP novo, busca detalhes via
//      /1_consultarContratacaoPncp14133 e popula `catalog.licitacoes`.
//   3. Busca todos os itens da licitação via PNCP API (mesmo motor do sync
//      regular em pncp-sync-scheduler.js:169) e popula `catalog.itens`.
//   4. Estado do job é persistido em `catalog_sync_state` (chaves daImport.*).
//
// Reuso (zero duplicação de SQL):
//   - licitacoes-persistence.js → salvarLicitacao(), salvarItens()
//
// Multi-tenant: opera direto em catalog.db (shared); não envolve tenant DB
// exceto pra ler `grupos_palavras_itens` quando importar por grupoId.

const axios = require('axios');
const path = require('path');
const Database = require('better-sqlite3');
const { createPersistence } = require('./licitacoes-persistence');

const CATALOG_DB_PATH = path.join(__dirname, 'data', 'catalog.db');
const DA_BASE = 'https://dadosabertos.compras.gov.br/modulo-contratacao';
const PNCP_ITENS_BASE = 'https://pncp.gov.br/api/pncp/v1';

// Rate limit conservador: ~5 req/s (Dados Abertos não publica limite, mas é
// gentil). PNCP API aceita um pouco mais; deixamos similar pra consistência.
const DA_DELAY_MS = 200;
const PNCP_DELAY_MS = 100;
const DA_PAGE_SIZE = 100;
const PNCP_TIMEOUT = 15000;

// Conexão direta com catalog.db (não passa pelo Proxy do tenant-middleware).
// readonly:false pra escrever; better-sqlite3 é síncrono então requests
// concorrentes serializam naturalmente.
let _catalogDb = null;
function getCatalogDb() {
  if (!_catalogDb) {
    _catalogDb = new Database(CATALOG_DB_PATH);
    _catalogDb.pragma('journal_mode = WAL');
    _catalogDb.pragma('busy_timeout = 5000');
  }
  return _catalogDb;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function setState(db, chave, valor) {
  db.prepare(
    `INSERT INTO catalog_sync_state (key, value, updated_at) VALUES (?, ?, ?) ` +
    `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(chave, String(valor == null ? '' : valor), Date.now());
}

function getState(db, chave, fallback) {
  const r = db.prepare('SELECT value FROM catalog_sync_state WHERE key = ?').get(chave);
  return r ? r.value : (fallback ?? null);
}

// Mapeia resposta Dados Abertos /1 para o formato que salvarLicitacao espera
// (igual ao endpoint PNCP /contratacoes/publicacao). Os campos do DA usam
// nomes flat (ex.: cnpjOrgao) enquanto o PNCP usa aninhado (orgaoEntidade.cnpj).
function normalizarLicDA(da) {
  if (!da) return null;
  return {
    numeroControlePNCP: da.numeroControlePNCP || da.numeroControlePncp,
    orgaoEntidade: {
      cnpj: da.cnpjOrgao || da.orgaoEntidade?.cnpj,
      razaoSocial: da.razaoSocialOrgao || da.orgaoEntidade?.razaoSocial,
    },
    unidadeOrgao: {
      ufSigla: da.siglaUf || da.ufNome || da.unidadeOrgao?.ufSigla,
      municipioNome: da.municipioNome || da.unidadeOrgao?.municipioNome,
      nomeUnidade: da.nomeUnidadeOrgao || da.unidadeOrgao?.nomeUnidade,
      codigoUnidade: da.codigoUnidadeOrgao || da.unidadeOrgao?.codigoUnidade,
    },
    anoCompra: da.anoCompra,
    sequencialCompra: da.sequencialCompra,
    numeroCompra: da.numeroCompra,
    processo: da.processo,
    modalidadeId: da.codigoModalidadeContratacao || da.modalidadeId,
    modalidadeNome: da.nomeModalidadeContratacao || da.modalidadeNome,
    objetoCompra: da.objetoCompra,
    informacaoComplementar: da.informacaoComplementar,
    valorTotalEstimado: da.valorTotalEstimado,
    dataPublicacaoPncp: da.dataPublicacaoPncp,
    dataAberturaProposta: da.dataAberturaProposta,
    dataEncerramentoProposta: da.dataEncerramentoProposta,
    situacaoCompraNome: da.nomeSituacaoCompra || da.situacaoCompraNome,
    linkSistemaOrigem: da.linkSistemaOrigem,
    usuarioNome: da.usuarioNome,
    srp: da.srp,
  };
}

// Busca todos os itens de uma licitação via PNCP API (paginado).
// Idêntico ao buscarItensLicitacao em pncp-sync-scheduler.js, replicado aqui
// pra esse módulo ser autocontido (sem precisar do scheduler inteiro).
async function buscarItensPNCP(cnpj, ano, sequencial) {
  const todos = [];
  let pagina = 1;
  while (true) {
    try {
      const resp = await axios.get(
        `${PNCP_ITENS_BASE}/orgaos/${cnpj}/compras/${ano}/${sequencial}/itens`,
        { params: { pagina, tamanhoPagina: 100 }, headers: { 'Accept': 'application/json' }, timeout: PNCP_TIMEOUT }
      );
      const itens = resp.data || [];
      // Guard anti-WAF: PNCP pode devolver página HTML de bloqueio com HTTP 200.
      // Sem isto, `push(...string)` espalharia o HTML char a char (itens NULL).
      if (!Array.isArray(itens)) {
        throw new Error('resposta de itens não é array (provável bloqueio WAF do PNCP)');
      }
      if (itens.length === 0) break;
      todos.push(...itens);
      if (itens.length < 100) break;
      pagina++;
      await sleep(PNCP_DELAY_MS);
    } catch (err) {
      // 404 é normal (licitação muito antiga sem itens registrados)
      if (err.response?.status !== 404) {
        console.warn(`[da-import] buscarItensPNCP ${cnpj}/${ano}/${sequencial} pag ${pagina}: ${err.message}`);
      }
      break;
    }
  }
  return todos;
}

// Importação por palavra: paginate DA, dedup numeroControlePNCP, busca
// licitação + itens se faltam, persiste. Retorna métricas detalhadas.
async function importarPalavra(palavra, opts = {}) {
  const db = getCatalogDb();
  const { salvarLicitacao, salvarItens } = createPersistence(db);
  const maxPaginas = opts.maxPaginas || 200;  // hard cap
  const metricas = {
    palavra,
    paginasLidas: 0,
    itensConsultados: 0,
    licitacoesNovas: 0,
    licitacoesJaExistiam: 0,
    itensInseridos: 0,
    erros: 0,
  };

  const stmtCheckLic = db.prepare('SELECT id FROM licitacoes WHERE numeroControlePNCP = ?');

  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    let resp;
    try {
      resp = await axios.get(`${DA_BASE}/2_consultarItemContratacaoPncp14133`, {
        params: { descricaoItem: palavra, pagina, tamanhoPagina: DA_PAGE_SIZE },
        headers: { 'Accept': 'application/json' },
        timeout: PNCP_TIMEOUT,
      });
    } catch (err) {
      // 404 no DA = página vazia (fim natural)
      if (err.response?.status === 404) break;
      console.warn(`[da-import] DA pag ${pagina} "${palavra}": ${err.message}`);
      metricas.erros++;
      break;
    }

    const itens = resp.data?.resultado || [];
    metricas.paginasLidas++;
    metricas.itensConsultados += itens.length;

    if (itens.length === 0) break;

    // Dedup numeroControlePNCP nesta página (mesma licitação pode ter vários
    // itens — só baixamos os detalhes 1x).
    const ncpsUnicos = [...new Set(itens.map(it => it.numeroControlePNCP || it.numeroControlePncp).filter(Boolean))];

    for (const ncp of ncpsUnicos) {
      const ja = stmtCheckLic.get(ncp);
      if (ja) {
        metricas.licitacoesJaExistiam++;
        continue;
      }
      // Busca detalhes via /1
      try {
        const detalhesResp = await axios.get(`${DA_BASE}/1_consultarContratacaoPncp14133`, {
          params: { numeroControlePNCP: ncp, pagina: 1, tamanhoPagina: 1 },
          headers: { 'Accept': 'application/json' },
          timeout: PNCP_TIMEOUT,
        });
        const lic = detalhesResp.data?.resultado?.[0];
        await sleep(DA_DELAY_MS);
        if (!lic) {
          metricas.erros++;
          continue;
        }
        const normalizada = normalizarLicDA(lic);
        if (!normalizada?.numeroControlePNCP || !normalizada.orgaoEntidade?.cnpj || !normalizada.anoCompra || !normalizada.sequencialCompra) {
          metricas.erros++;
          continue;
        }
        if (!salvarLicitacao(normalizada)) {
          metricas.erros++;
          continue;
        }
        metricas.licitacoesNovas++;

        // Busca itens completos via PNCP API e salva
        const itensCompletos = await buscarItensPNCP(
          normalizada.orgaoEntidade.cnpj,
          normalizada.anoCompra,
          normalizada.sequencialCompra,
        );
        if (itensCompletos.length > 0 && salvarItens(normalizada.numeroControlePNCP, itensCompletos)) {
          metricas.itensInseridos += itensCompletos.length;
        }
      } catch (err) {
        metricas.erros++;
        console.warn(`[da-import] detalhes ${ncp}: ${err.message}`);
      }
    }

    await sleep(DA_DELAY_MS);
    if (itens.length < DA_PAGE_SIZE) break;  // última página
  }

  return metricas;
}

// Lê palavras do grupo (em tenant DB), itera importarPalavra, persiste estado.
async function importarGrupo(grupoId, opts = {}) {
  if (!opts.tenantDbPath) throw new Error('importarGrupo: opts.tenantDbPath obrigatório');
  const db = getCatalogDb();
  const tenantDb = new Database(opts.tenantDbPath, { readonly: true });

  const palavras = tenantDb.prepare('SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?')
    .all(grupoId).map(r => r.palavra);
  tenantDb.close();

  if (palavras.length === 0) {
    throw new Error(`Grupo ${grupoId} sem palavras cadastradas no tenant ${opts.tenantDbPath}`);
  }

  const jobId = `da-import-${Date.now()}`;
  const consolidado = {
    jobId,
    grupoId,
    tenantDbPath: opts.tenantDbPath,
    palavrasTotal: palavras.length,
    palavrasProcessadas: 0,
    iniciado: new Date().toISOString(),
    metricas: [],
    totais: { licitacoesNovas: 0, licitacoesJaExistiam: 0, itensInseridos: 0, erros: 0 },
  };
  setState(db, 'daImport.status', 'rodando');
  setState(db, 'daImport.jobId', jobId);
  setState(db, 'daImport.grupoId', grupoId);
  setState(db, 'daImport.iniciado', consolidado.iniciado);
  setState(db, 'daImport.progresso', JSON.stringify(consolidado));

  try {
    for (const palavra of palavras) {
      console.log(`[da-import] processando "${palavra}" (${consolidado.palavrasProcessadas + 1}/${palavras.length})`);
      const m = await importarPalavra(palavra, opts);
      consolidado.metricas.push(m);
      consolidado.palavrasProcessadas++;
      consolidado.totais.licitacoesNovas += m.licitacoesNovas;
      consolidado.totais.licitacoesJaExistiam += m.licitacoesJaExistiam;
      consolidado.totais.itensInseridos += m.itensInseridos;
      consolidado.totais.erros += m.erros;
      setState(db, 'daImport.progresso', JSON.stringify(consolidado));
    }
    consolidado.terminado = new Date().toISOString();
    setState(db, 'daImport.status', 'concluido');
    setState(db, 'daImport.progresso', JSON.stringify(consolidado));
    console.log(`[da-import] CONCLUÍDO grupo ${grupoId}: ${consolidado.totais.licitacoesNovas} novas licitações, ${consolidado.totais.itensInseridos} itens`);
    return consolidado;
  } catch (err) {
    consolidado.erro = err.message;
    consolidado.terminado = new Date().toISOString();
    setState(db, 'daImport.status', 'erro');
    setState(db, 'daImport.progresso', JSON.stringify(consolidado));
    throw err;
  }
}

function getStatus() {
  const db = getCatalogDb();
  const status = getState(db, 'daImport.status', 'nunca rodou');
  const progresso = getState(db, 'daImport.progresso', null);
  return {
    status,
    progresso: progresso ? JSON.parse(progresso) : null,
  };
}

module.exports = { importarPalavra, importarGrupo, getStatus };
