// retroativo-antiwaf.js (2026-05-30) — coletor histórico com pacing anti-WAF
//
// Preenche os buracos do catálogo (ex.: Dispensa 2024-2025) que o
// sincronizarCompleta padrão não cobre porque varre rápido demais e o WAF
// do PNCP devolve página de bloqueio (HTTP 200 + HTML) tratada como "vazio".
//
// Diferenças vs sincronizarCompleta:
//   - delay FIXO entre páginas/dias (não rajada)
//   - detecta resposta não-JSON (bloqueio WAF) e faz BACKOFF longo + retry,
//     em vez de tratar como fim do range
//   - checkpoint próprio em catalog_sync_state (retomável), chave 'antiwaf.*'
//   - roda fora do scheduler (standalone), sem restart, sem tocar o incremental
//
// Uso:
//   CATALOG_BACKEND_PG=1 node retroativo-antiwaf.js --inicio 2024-06-01 --fim 2025-12-31 --modalidades 8
//   CATALOG_BACKEND_PG=1 node retroativo-antiwaf.js --inicio 2024-06-01 --fim 2025-12-31 --modalidades 8 --resume
//   (opcional) --so-faltantes   pula dia/modalidade que já tem volume razoável no catálogo

'use strict';

const axios = require('axios');
const catalogPg = require('./catalog-pg');
const { salvarLicitacaoPg, salvarItensPg } = require('./licitacoes-persistence');
const { buscarItensLicitacao } = require('./pncp-sync-scheduler');

const PNCP_API_BASE = 'https://pncp.gov.br/api/consulta/v1';
const PAGE_SIZE = 50;
const PAGINA_TIMEOUT_MS = 15000;
const DELAY_PAGINA_MS = 400;       // entre páginas do mesmo dia
const DELAY_DIA_MS = 800;          // entre dias
const DELAY_ITENS_MS = 250;        // entre buscas de itens (endpoint mais sensível ao WAF)
const WAF_BACKOFF_MS = 15000;      // espera após detectar bloqueio WAF
const MAX_RETRIES = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
  const has = (k) => a.includes(`--${k}`);
  return {
    inicio: get('inicio', '2024-06-01'),
    fim: get('fim', '2025-12-31'),
    modalidades: get('modalidades', '8').split(',').map(s => parseInt(s, 10)),
    resume: has('resume'),
    semItens: has('sem-itens'),
  };
}

function diasEntre(ini, fim) {
  const out = [];
  const d = new Date(ini + 'T12:00:00Z');
  const end = new Date(fim + 'T12:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

async function getState(k, def) {
  const r = await catalogPg.queryOne('SELECT "value" FROM catalog_sync_state WHERE "key"=$1', [k]);
  return r ? r.value : def;
}
async function setState(k, v) {
  await catalogPg.execute(
    `INSERT INTO catalog_sync_state ("key","value","updated_at") VALUES ($1,$2,$3)
     ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value","updated_at"=EXCLUDED."updated_at"`,
    [k, String(v), Date.now()]
  );
}

// Busca uma página. Retorna {ok, data[], fim, waf}.
//   waf=true  → resposta não-JSON (bloqueio); caller faz backoff e retenta
//   fim=true  → 204/vazio/4xx → acabou o range do dia
async function buscarPagina(dia, modalidade, pagina) {
  const diaAPI = dia.replace(/-/g, '');
  try {
    const resp = await axios.get(`${PNCP_API_BASE}/contratacoes/publicacao`, {
      params: { dataInicial: diaAPI, dataFinal: diaAPI, codigoModalidadeContratacao: modalidade, pagina, tamanhoPagina: PAGE_SIZE },
      headers: { 'Accept': 'application/json' },
      timeout: PAGINA_TIMEOUT_MS,
      // axios faz throw em 4xx/5xx por padrão; 2xx cai aqui
      transformResponse: [(d) => d], // mantém string crua p/ detectar HTML do WAF
    });
    const raw = resp.data;
    if (typeof raw === 'string' && raw.trimStart().startsWith('<')) {
      return { ok: false, waf: true };               // página de bloqueio HTML
    }
    let json;
    try { json = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return { ok: false, waf: true }; }        // não-JSON = trata como WAF
    const data = json?.data || [];
    if (!Array.isArray(data) || data.length === 0) return { ok: true, data: [], fim: true };
    return { ok: true, data, fim: data.length < PAGE_SIZE };
  } catch (err) {
    const st = err.response?.status;
    if (st === 204 || st === 400 || st === 422 || st === 404) return { ok: true, data: [], fim: true };
    // 5xx / timeout / rede: trata como falha retentável (pode ser WAF/LB)
    const body = err.response?.data;
    if (typeof body === 'string' && body.trimStart().startsWith('<')) return { ok: false, waf: true };
    return { ok: false, waf: false, erro: err.message };
  }
}

async function coletarDia(dia, modalidade, stats) {
  let pagina = 1;
  while (true) {
    let r = null;
    for (let tent = 1; tent <= MAX_RETRIES; tent++) {
      r = await buscarPagina(dia, modalidade, pagina);
      if (r.ok) break;
      // falha: backoff (longo se WAF) e retenta
      const wait = r.waf ? WAF_BACKOFF_MS * tent : 2000 * tent;
      stats.retries++;
      await sleep(wait);
    }
    if (!r.ok) {
      console.warn(`[antiwaf] ${dia} mod${modalidade} pag${pagina}: falhou após ${MAX_RETRIES} retries (${r.waf ? 'WAF' : r.erro})`);
      stats.diasComFalha++;
      return;
    }
    if (r.fim && r.data.length === 0) return;

    for (const lic of r.data) {
      const salvou = await salvarLicitacaoPg(lic);
      if (salvou) stats.lics++;
      if (!stats.semItens) {
        // só busca itens se a licitação ainda não tem (evita re-trabalho)
        const ja = await catalogPg.queryOne(
          `SELECT 1 FROM itens WHERE "numeroControlePNCP"=$1 LIMIT 1`, [lic.numeroControlePNCP]
        );
        if (!ja) {
          const itens = await buscarItensLicitacao(lic.orgaoEntidade?.cnpj, lic.anoCompra, lic.sequencialCompra);
          if (Array.isArray(itens) && itens.length > 0) {
            if (await salvarItensPg(lic.numeroControlePNCP, itens)) stats.itens += itens.length;
          }
          await sleep(DELAY_ITENS_MS);
        }
      }
    }
    if (r.fim) return;
    pagina++;
    await sleep(DELAY_PAGINA_MS);
  }
}

async function main() {
  const { inicio, fim, modalidades, resume, semItens } = args();
  const dias = diasEntre(inicio, fim);
  const stats = { lics: 0, itens: 0, retries: 0, diasComFalha: 0, semItens };

  const ckKey = `antiwaf.cursor.${inicio}_${fim}_${modalidades.join('-')}`;
  let startIdx = 0;
  if (resume) {
    const c = await getState(ckKey, null);
    if (c) { startIdx = parseInt(c, 10) || 0; console.log(`[antiwaf] retomando do índice ${startIdx}`); }
  }

  const totalUnidades = dias.length * modalidades.length;
  console.log(`[antiwaf] ${dias.length} dias × ${modalidades.length} modalidades = ${totalUnidades} unidades | itens=${!semItens}`);
  const t0 = Date.now();

  let idx = 0;
  for (const modalidade of modalidades) {
    for (const dia of dias) {
      if (idx < startIdx) { idx++; continue; }
      await coletarDia(dia, modalidade, stats);
      idx++;
      await setState(ckKey, idx);
      if (idx % 20 === 0) {
        const min = ((Date.now() - t0) / 60000).toFixed(1);
        console.log(`[antiwaf] ${idx}/${totalUnidades} (${min}min) — lics=${stats.lics} itens=${stats.itens} retries=${stats.retries} falhas=${stats.diasComFalha}`);
      }
      await sleep(DELAY_DIA_MS);
    }
  }

  await setState(`antiwaf.lastRun`, new Date().toISOString());
  console.log(`[antiwaf] FIM — lics=${stats.lics} itens=${stats.itens} retries=${stats.retries} diasComFalha=${stats.diasComFalha}`);
  process.exit(0);
}

main().catch((e) => { console.error('[antiwaf] fatal:', e); process.exit(1); });
