// compra-id-resolver.js
//
// Resolvedor de compraId Comprasnet para "Licitações de Interesse".
// Extraído do handler POST /api/proposta/interesses/auto-compra-id
// (propostas-participacoes-routes.js) para ser reaproveitado tanto pela
// rota (worker) quanto por um job periódico no scheduler.js (master),
// resolvendo compraId proativamente sem depender de página aberta.
//
// Métodos, em cascata:
//   1. Extrai compra= do linkSistemaOrigem (catálogo).
//   2. Monta chaveCompraPncp {cnpj}1{seq6}{ano} e casa participacoes_comprasnet.
//   3. LIKE por CNPJ na chaveCompraPncp.
//   4. Construção LOCAL do compraId {uasg:6}{mod:2}{num:5}{ano:4} via catálogo;
//      senão marca NAO_COMPRASNET; 4d = best-effort PNCP consulta/v1 (flaky
//      neste IP), protegido por circuit-breaker de timeouts consecutivos.

const axios = require('axios');
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

// Aborta o loop 4d (PNCP) após N timeouts/erros consecutivos — evita que o
// PNCP estrangulando domine o ciclo (espelha throttleSeguidos do
// cicloReconciliarInteresse em scheduler.js).
const PNCP_THROTTLE_ABORT = 5;

/**
 * Resolve o compraId dos interesses sem resolução, gravando em interesse_compra_id.
 * @param {import('better-sqlite3').Database} db  handle sqlite do tenant
 * @param {{ pncpFallback?: boolean }} [opts]  pncpFallback (default true) habilita o método 4d
 * @returns {Promise<{ resolvidos: Array, naoComprasnet: Array, pendentes: number }>}
 */
async function resolverCompraIdsTenant(db, opts = {}) {
  const { pncpFallback = true } = opts;

  const iRows = db.prepare(`
    SELECT DISTINCT i.cnpj, i.ano, i.sequencial
    FROM interesse i
    LEFT JOIN interesse_compra_id ic ON i.cnpj = ic.cnpj AND i.ano = ic.ano AND i.sequencial = ic.sequencial
    WHERE ic.compraId IS NULL
  `).all();

  // Também incluir os que têm linkSistemaOrigem com compra=
  let licitacoes;
  if (USE_PG) {
    // Cross-DB: pega interesse no tenant, lookup em PG via VALUES
    const intRows = db.prepare(`SELECT DISTINCT cnpj, ano, sequencial FROM interesse`).all();
    if (intRows.length === 0) {
      licitacoes = [];
    } else {
      const values = intRows.map((_, j) => `($${j*3+1}::text,$${j*3+2}::int,$${j*3+3}::bigint)`).join(',');
      const params = [];
      for (const r of intRows) params.push(String(r.cnpj), Number(r.ano), Number(r.sequencial));
      licitacoes = await catalogPg.query(`
        WITH keys(cnpj, ano, sequencial) AS (VALUES ${values})
        SELECT l."cnpj" AS cnpj, l."anoCompra" AS "anoCompra", l."sequencialCompra" AS "sequencialCompra",
               l."linkSistemaOrigem" AS "linkSistemaOrigem"
          FROM licitacoes l
          JOIN keys k ON l."cnpj"=k.cnpj AND l."anoCompra"=k.ano AND l."sequencialCompra"=k.sequencial
         WHERE l."linkSistemaOrigem" ILIKE '%compra=%'
      `, params);
    }
  } else {
    licitacoes = db.prepare(`
      SELECT l.cnpj, l.anoCompra, l.sequencialCompra, l.linkSistemaOrigem
      FROM licitacoes l
      INNER JOIN interesse i ON l.cnpj = i.cnpj AND l.anoCompra = i.ano AND l.sequencialCompra = i.sequencial
      WHERE l.linkSistemaOrigem LIKE '%compra=%'
    `).all();
  }

  const resolvidos = [];

  // Método 1: Extrair compraId do linkSistemaOrigem
  for (const lic of licitacoes) {
    const m = lic.linkSistemaOrigem.match(/[?&]compra=(\d{14,20})/);
    if (m) {
      const compraId = m[1];
      try {
        db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 0)`)
          .run(lic.cnpj, lic.anoCompra, lic.sequencialCompra, compraId);
        resolvidos.push({ cnpj: lic.cnpj, ano: lic.anoCompra, seq: lic.sequencialCompra, compraId, metodo: 'link' });
      } catch (e) {}
    }
  }

  // Método 2: Construir chaveCompraPncp esperada e buscar nas participações
  // Formato da chave: {cnpjPncp14}{1}{seqPncp padded 6}{ano4} = 25 chars
  for (const row of iRows) {
    const jaResolvido = resolvidos.find(r => r.cnpj === row.cnpj && r.ano === row.ano && r.seq === row.sequencial);
    if (jaResolvido) continue;

    const seqPadded = String(row.sequencial).padStart(6, '0');
    const chaveEsperada = `${row.cnpj}1${seqPadded}${row.ano}`;

    const part = db.prepare(`SELECT compraId FROM participacoes_comprasnet WHERE chaveCompraPncp = ?`).get(chaveEsperada);
    if (part) {
      try {
        db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 0)`)
          .run(row.cnpj, row.ano, row.sequencial, part.compraId);
        resolvidos.push({ cnpj: row.cnpj, ano: row.ano, seq: row.sequencial, compraId: part.compraId, metodo: 'chave' });
      } catch (e) {}
    }
  }

  // Método 3: Buscar por LIKE no início da chaveCompraPncp (cnpj match)
  for (const row of iRows) {
    const jaResolvido = resolvidos.find(r => r.cnpj === row.cnpj && r.ano === row.ano && r.seq === row.sequencial);
    if (jaResolvido) continue;

    const part = db.prepare(`SELECT compraId, chaveCompraPncp FROM participacoes_comprasnet WHERE chaveCompraPncp LIKE ? AND ano = ?`)
      .get(`${row.cnpj}%`, row.ano);
    if (part) {
      // Extrair sequencial PNCP da chave (pos 15..21 = depois do cnpj14 + "1")
      const seqFromChave = parseInt(part.chaveCompraPncp.substring(15, 21), 10);
      if (seqFromChave === row.sequencial) {
        try {
          db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 0)`)
            .run(row.cnpj, row.ano, row.sequencial, part.compraId);
          resolvidos.push({ cnpj: row.cnpj, ano: row.ano, seq: row.sequencial, compraId: part.compraId, metodo: 'cnpj-match' });
        } catch (e) {}
      }
    }
  }

  // Método 4: Construção LOCAL primeiro (independente da API PNCP). O compraId do
  // Comprasnet = {uasg:6}{modalidade:2}{numero:5}{ano:4} e UASG/modalidade/numeroCompra
  // já estão no catálogo licitacoes (sync) — não dependem do consulta/v1 (timeout deste
  // IP). Só cai no PNCP quem nem está no catálogo; e mesmo aí o pncp-api/v1 NÃO traz
  // linkSistemaOrigem (só o consulta/v1, flaky), então é best-effort de timeout curto.
  const aindaPendentes = iRows.filter(r => !resolvidos.find(x => x.cnpj === r.cnpj && x.ano === r.ano && x.seq === r.sequencial));
  const naoComprasnet = [];
  const mapMod = { 1:'01', 2:'02', 3:'03', 4:'04', 5:'05', 6:'05', 7:'05', 8:'06', 9:'09' };

  async function lookupLicLocal(cnpj, ano, seq) {
    if (USE_PG) {
      return await catalogPg.queryOne(
        `SELECT "codigoUnidade" AS "codigoUnidade", "modalidadeId" AS "modalidadeId",
                "numeroCompra" AS "numeroCompra", "linkSistemaOrigem" AS "linkSistemaOrigem"
           FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3`,
        [cnpj, ano, seq]
      );
    }
    return db.prepare(
      `SELECT codigoUnidade, modalidadeId, numeroCompra, linkSistemaOrigem
         FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?`
    ).get(cnpj, ano, seq);
  }

  // Resolve/classifica a partir de dados (licLocal e/ou link). Retorna true se decidiu
  // (resolveu compraId ou marcou não-Comprasnet); false se faltam dados pra decidir.
  function resolverPorDados(row, licLocal, linkHint) {
    const link = (licLocal && licLocal.linkSistemaOrigem) || linkHint || '';
    // 4a. Link já traz o compraId do Comprasnet
    const m = link.match(/[?&]compra=(\d{14,20})/);
    if (m) {
      db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 0)`)
        .run(row.cnpj, row.ano, row.sequencial, m[1]);
      resolvidos.push({ cnpj: row.cnpj, ano: row.ano, seq: row.sequencial, compraId: m[1], metodo: 'link' });
      return true;
    }
    // 4b. Construir via UASG+modalidade+numero (precisam ser numéricos pro Comprasnet;
    // sistemas estaduais/municipais com número alfanumérico tipo "DLE 001", "029/2026"
    // caem fora e viram NAO_COMPRASNET — construir com não-dígitos gera path inválido).
    const uasgRaw = licLocal && licLocal.codigoUnidade != null ? String(licLocal.codigoUnidade) : '';
    const numRaw  = licLocal && licLocal.numeroCompra  != null ? String(licLocal.numeroCompra)  : '';
    const uasgValido = /^\d+$/.test(uasgRaw) && uasgRaw.length <= 6;
    const numValido  = /^\d+$/.test(numRaw)  && numRaw.length  <= 5;
    if (licLocal && uasgValido && numValido) {
      const uasg = uasgRaw.padStart(6, '0');
      const modComprasnet = mapMod[licLocal.modalidadeId] || '05';
      const numCompra = numRaw.padStart(5, '0');
      const compraIdConstruido = `${uasg}${modComprasnet}${numCompra}${row.ano}`;
      db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 0)`)
        .run(row.cnpj, row.ano, row.sequencial, compraIdConstruido);
      resolvidos.push({ cnpj: row.cnpj, ano: row.ano, seq: row.sequencial, compraId: compraIdConstruido, metodo: 'construido-local' });
      console.log(`[AUTO-COMPRA-ID] Construído local: ${compraIdConstruido} (UASG=${uasg}, mod=${modComprasnet}, num=${numCompra})`);
      return true;
    }
    if (licLocal && (uasgRaw || numRaw) && (!uasgValido || !numValido)) {
      const motivo = !uasgValido ? `uasg=${uasgRaw}` : `num=${numRaw}`;
      db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 1)`)
        .run(row.cnpj, row.ano, row.sequencial, `NAO_COMPRASNET:formato-invalido(${motivo})`);
      naoComprasnet.push({ cnpj: row.cnpj, ano: row.ano, seq: row.sequencial, sistema: `formato-invalido(${motivo})` });
      console.log(`[AUTO-COMPRA-ID] Formato inválido pra Comprasnet (${motivo}): ${row.cnpj}/${row.ano}/${row.sequencial}`);
      return true;
    }
    // 4c. Tem link de outro portal, sem dados numéricos → estadual/municipal
    if (link) {
      try {
        const sistema = new URL(link).hostname;
        db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 1)`)
          .run(row.cnpj, row.ano, row.sequencial, `NAO_COMPRASNET:${sistema}`);
        naoComprasnet.push({ cnpj: row.cnpj, ano: row.ano, seq: row.sequencial, sistema });
        return true;
      } catch (_) { /* URL inválida — deixa pendente */ }
    }
    return false;
  }

  let throttleSeguidos = 0;
  for (const row of aindaPendentes) {
    try {
      // 4a-c via dados LOCAIS (catálogo) — sem PNCP
      const licLocal = await lookupLicLocal(row.cnpj, row.ano, row.sequencial);
      if (resolverPorDados(row, licLocal, null)) continue;

      if (!pncpFallback) continue;

      // 4d. Sem dados locais utilizáveis: best-effort consulta/v1 (única fonte do
      // linkSistemaOrigem; flaky neste IP, timeout curto). Se falhar, fica pendente
      // e re-tenta no próximo ciclo. (pncp-api/v1 não retorna o link.)
      const url = `https://pncp.gov.br/api/consulta/v1/orgaos/${row.cnpj}/compras/${row.ano}/${row.sequencial}`;
      const resp = await axios.get(url, { timeout: 4000, validateStatus: () => true }).catch(() => null);
      if (resp && resp.status === 200 && resp.data) {
        throttleSeguidos = 0;
        resolverPorDados(row, null, resp.data.linkSistemaOrigem || '');
        await new Promise(r => setTimeout(r, 300));
      } else {
        // timeout/throttle — circuit breaker: N seguidos = PNCP estrangulando, aborta o 4d
        if (++throttleSeguidos >= PNCP_THROTTLE_ABORT) {
          console.log(`[AUTO-COMPRA-ID] ${PNCP_THROTTLE_ABORT} timeouts PNCP seguidos — abortando 4d neste ciclo`);
          break;
        }
      }
    } catch (e) {
      console.log(`[AUTO-COMPRA-ID] Erro ${row.cnpj}/${row.ano}/${row.sequencial}: ${e.message}`);
    }
  }

  console.log(`[AUTO-COMPRA-ID] ${resolvidos.length} resolvidos, ${naoComprasnet.length} não-Comprasnet, de ${iRows.length} pendentes`);
  return { resolvidos, naoComprasnet, pendentes: iRows.length - resolvidos.length - naoComprasnet.length };
}

module.exports = { resolverCompraIdsTenant };
