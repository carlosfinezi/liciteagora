// marca-portal-backfill.js — 2026-07-06
//
// Backfill em background da MARCA DO VENCEDOR a partir do PORTAL DE ORIGEM
// (BLL Compras / BNC). O PNCP não publica marca no /resultados (0 de ~872k
// vencedores em resultados_bi têm marcaFabricante). Mas o portal onde a
// licitação foi disputada expõe, publicamente e sem login, o relatório
// "Vencedores do Processo" (PDF) com o campo `Marca:` por item.
//
// Cadeia (tudo GET público, sem captcha):
//   PNCP dá licitacoes.linkSistemaOrigem = /Process/ProcessView?param1=[gkz]<proc>
//   1) GET ProcessView (HTML) -> token de doAction('GET','Process','ProcessReport',[<tok>])
//   2) GET /Process/ProcessReport?param1=<tok> (XHR) -> JSON {html} com link do blob
//   3) baixa o PDF "VencedoresProcesso..." -> pdftotext -layout
//   4) parse por item (CNPJ vencedor, Marca, descrição, qtd, valRef)
//   5) mapeia cada item do PDF -> numeroItem canônico da NOSSA tabela `itens`
//      (por descrição + qtd + valRef, restrito ao CNPJ vencedor de resultados_bi;
//       atribuição gulosa garante 1:1 sem colisão de preço)
//   6) UPDATE resultados_bi SET marcaFabricante — SÓ em match confiável
//      (score>=80 OU todos os itens do CNPJ têm a mesma marca) e SÓ onde a
//      marca ainda está vazia. Nunca sobrescreve. Modelo do PDF é ignorado
//      (costuma ser unidade/lixo "gl","pct").
//
// Rate-limit gentil: bate em bllcompras.com/bnccompras.com (portais privados),
// então poucos processos por ciclo + delay entre eles. Nunca em paralelo.
//
// Uso (scheduler master):
//   const mp = require('./marca-portal-backfill');
//   mp.init({ db: catalogDb });
//   mp.iniciarBackfillEngine();
//
// Uso (CLI, roda 1 lote sem restart do serviço):
//   node marca-portal-backfill.js --run [--limit 20] [--dry]
//   node marca-portal-backfill.js --processo <cnpj> <ano> <seq> [--dry]

'use strict';

const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const catalogPg = require('./catalog-pg');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const PORTAIS = ['BLL Compras', 'Bolsa Nacional De Compras - BNC'];

// Rate-limit (portais privados — conservador para não tomar WAF/ban)
const CYCLE_MS = 60 * 1000;      // 1 ciclo por minuto
const PROC_POR_CICLO = 8;        // 8 processos por ciclo
const PROC_DELAY_MS = 1500;      // 1,5s entre processos
const HTTP_TIMEOUT = 20000;

// Política de gravação
const SCORE_MIN = 80;            // abaixo disso, só grava se a marca é única no CNPJ
const RETRY_ERRO_DIAS = 3;       // re-tenta 'erro' após 3d
const RETRY_ERRO_MAX = 5;        // no máx. 5 tentativas
const RETRY_SEM_REL_DIAS = 30;   // 'sem_relatorio' re-tenta após 30d

let _db = null;
let _timer = null;
let _running = false;
let _schemaOk = false;

function init({ db } = {}) {
  _db = db || null; // PG-first; db (SQLite) mantido só por paridade
}

function _usePg() { return process.env.CATALOG_BACKEND_PG === '1'; }

// ─── schema (idempotente) ──────────────────────────────────────────────────
async function _ensureSchema() {
  if (_schemaOk) return;
  await catalogPg.execute(`
    CREATE TABLE IF NOT EXISTS marca_portal_backfill (
      "cnpj" text NOT NULL,
      "ano" integer NOT NULL,
      "sequencial" integer NOT NULL,
      "status" text NOT NULL,
      "itensTotal" integer DEFAULT 0,
      "itensGravados" integer DEFAULT 0,
      "itensPulados" integer DEFAULT 0,
      "tentativas" integer DEFAULT 0,
      "erro" text,
      "dataCache" timestamptz DEFAULT now(),
      PRIMARY KEY ("cnpj","ano","sequencial")
    )
  `);
  // Índice parcial: só as ~72k licitações BLL/BNC — barato de construir e
  // deixa a seleção do lote instantânea (licitacoes tem 1,4M linhas).
  await catalogPg.execute(`
    CREATE INDEX IF NOT EXISTS idx_lic_portal_marca
      ON licitacoes ("dataPublicacaoPncp")
      WHERE "usuarioNome" IN ('BLL Compras','Bolsa Nacional De Compras - BNC')
  `);
  // Fila de PRIORIDADE: licitações BLL/BNC cujos itens aparecem em algum grupo
  // de palavras (o que os tenants realmente veem no BI). Semeada por seedFila().
  await catalogPg.execute(`
    CREATE TABLE IF NOT EXISTS marca_portal_fila (
      "cnpj" text NOT NULL, "ano" integer NOT NULL, "sequencial" integer NOT NULL,
      PRIMARY KEY ("cnpj","ano","sequencial")
    )
  `);
  _schemaOk = true;
}

// Semeia a fila de prioridade a partir de bi_grupo_item (match pré-computado
// grupo→item). Query cara (~1,25M linhas de grupo); roda sob demanda via CLI
// --seed, não no ciclo. Idempotente. Retorna o tamanho da fila.
async function seedFila() {
  await _ensureSchema();
  // O pool compartilhado tem query_timeout=30s (client-side do node-pg), que
  // SET LOCAL não afeta. Esta query é pesada (>30s), então usa um client
  // dedicado e efêmero, sem query_timeout.
  const { Client } = require('pg');
  const senha = fs.readFileSync('/etc/postgresql/16/main/liciteagora_catalog.pass', 'utf8').trim();
  const c = new Client({
    host: process.env.PG_HOST || 'localhost', port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER || 'liciteagora_catalog', password: senha,
    database: process.env.PG_DATABASE || 'liciteagora_catalog',
    statement_timeout: 600000,
  });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO marca_portal_fila ("cnpj","ano","sequencial")
      SELECT DISTINCT l."cnpj", l."anoCompra", l."sequencialCompra"
        FROM bi_grupo_item g
        JOIN itens i ON i."id" = g."itemId"
        JOIN licitacoes l ON l."id" = i."licitacaoId"
       WHERE l."usuarioNome" IN ('BLL Compras','Bolsa Nacional De Compras - BNC')
         AND l."linkSistemaOrigem" IS NOT NULL
         -- só HOMOLOGADAS: precisa ter vencedor real em resultados_bi, senão
         -- não há marca a extrair (licitação aberta/não julgada não faz sentido na fila)
         AND EXISTS (SELECT 1 FROM resultados_bi rb
                      WHERE rb."cnpj"=l."cnpj" AND rb."ano"=l."anoCompra"
                        AND rb."sequencial"=l."sequencialCompra" AND rb."niFornecedor"<>'__sem_resultado__')
      ON CONFLICT DO NOTHING
    `);
    return Number((await c.query(`SELECT count(*) c FROM marca_portal_fila`)).rows[0].c);
  } finally { await c.end(); }
}

// ─── util ──────────────────────────────────────────────────────────────────
function _encParam1(url) {
  const i = url.indexOf('param1=');
  if (i < 0) return url;
  const raw = url.slice(i + 7);
  // decode-then-encode: idempotente venha cru ([gkz]) ou já encodado (%5Bgkz%5D)
  let dec; try { dec = decodeURIComponent(raw); } catch { dec = raw; }
  return url.slice(0, i + 7) + encodeURIComponent(dec);
}

function _norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function _r2(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // pt-BR "1.234,56"
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const _MARCA_LIXO = new Set([
  '', '-', '.', '..', '...', 'ni', 'n/i', 'nao informado', 'naoinformado',
  'sem marca', 'semmarca', 's/marca', 'smarca', 'edital', 'cf edital', 'cfedital',
  'conforme edital', 'conformeedital', 'conf edital', 'confedital', 'cfe edital',
  'a definir', 'adefinir', 'propria', 'propria marca', 'marca propria', 'marcapropria',
  'xxx', 'xxxx', 'nan', 'null',
]);
function _marcaValida(m) {
  const t = String(m || '').trim();
  const n = t.toLowerCase().replace(/\s+/g, ' ').trim();
  if (t.length < 2) return false;
  if (_MARCA_LIXO.has(n) || _MARCA_LIXO.has(_norm(t))) return false;
  if (/^cf\b|^conforme\b|^conf\.?\s*edital/i.test(n)) return false;
  if (!/[a-z0-9]/i.test(t)) return false;
  return true;
}

async function _fetch(url, { xhr = false, binary = false } = {}) {
  const headers = { 'User-Agent': UA, 'Accept': binary ? '*/*' : '*/*' };
  if (xhr) headers['X-Requested-With'] = 'XMLHttpRequest';
  const resp = await axios.get(url, {
    headers, timeout: HTTP_TIMEOUT, maxRedirects: 5,
    responseType: binary ? 'arraybuffer' : 'text',
    // 'text' evita o parse automático de JSON do axios (ProcessReport às vezes
    // vem como text/plain); parseamos manualmente.
    transformResponse: binary ? undefined : [(d) => d],
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return resp.data;
}

function _pdftotext(buffer) {
  return new Promise((resolve, reject) => {
    const base = path.join(os.tmpdir(), 'mpb_' + crypto.randomBytes(6).toString('hex'));
    const pdf = base + '.pdf';
    try { fs.writeFileSync(pdf, buffer); } catch (e) { return reject(e); }
    execFile('pdftotext', ['-layout', pdf, '-'], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      try { fs.unlinkSync(pdf); } catch {}
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// ─── parse do PDF "Vencedores do Processo" ─────────────────────────────────
const RE_FORN  = /(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/;
const RE_ITEM  = /^\s*Item:\s*\d+\s+Unidade:\s*\S+\s+Marca:\s*(.+?)\s{2,}Modelo:\s*(.*)$/;
const RE_QTD   = /^\s*Quantidade:\s*([\d.,]+)\s+Val\.\s*Ref\.:\s*([\d.,]+)/;

function _parsePdf(txt) {
  const itens = [];
  let curCnpj = null, rec = null, desc = [];
  for (const ln of txt.split('\n')) {
    const mc = RE_FORN.exec(ln);
    if (mc && !/Item:/.test(ln)) curCnpj = mc[1].replace(/\D/g, '');
    const mi = RE_ITEM.exec(ln);
    if (mi) {
      rec = { cnpj: curCnpj, marca: mi[1].trim(), modelo: mi[2].trim(), descr: '', qtd: null, valref: null };
      itens.push(rec); desc = []; continue;
    }
    if (rec) {
      const mq = RE_QTD.exec(ln);
      if (mq) {
        rec.qtd = _r2(mq[1]); rec.valref = _r2(mq[2]); rec.descr = desc.join(' '); rec = null;
      } else {
        let d = ln.trim();
        if (d.startsWith('Descrição:')) d = d.slice('Descrição:'.length).trim();
        d = d.split(/Marcas de refer/i)[0]; // trecho do edital, não do vencedor
        if (d) desc.push(d);
      }
    }
  }
  return itens;
}

// ─── mapeamento numeroItem (guloso dentro do CNPJ vencedor) ────────────────
// Similaridade de Dice sobre bigramas de caractere (aproxima difflib, barato).
function _dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const big = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ma = big(a), mb = big(b); let inter = 0, ta = 0, tb = 0;
  for (const v of ma.values()) ta += v;
  for (const [g, v] of mb) { tb += v; const av = ma.get(g) || 0; inter += Math.min(av, v); }
  return (2 * inter) / (ta + tb);
}

// score de identidade do item (0..~200). Descrição dá o grosso; valRef+qtd são
// corroboração independente (números do edital) — ambos batendo já é evidência
// forte de identidade mesmo com texto divergente.
function _score(pit, it) {
  const k = _norm(pit.descr), o = it.nd;
  let s = 0;
  if (k && o && k === o) s += 100;
  else if (k && o && (o.startsWith(k.slice(0, 20)) || k.startsWith(o.slice(0, 20)))) s += 80;
  else s += Math.round(_dice(k, o) * 70);
  if (pit.valref != null && pit.valref === it.valref) s += 40;
  if (pit.qtd != null && pit.qtd === it.qtd) s += 40;
  return s;
}

// itensPdf: [{cnpj,marca,descr,qtd,valref}]
// nossosItens: Map numeroItem -> {nd,qtd,valref}
// venc: Map numeroItem -> niFornecedor
// Retorna: [{numeroItem, niFornecedor, marca, score, confiavel}]
function _mapear(itensPdf, nossosItens, venc) {
  // marcas distintas (válidas) por cnpj — p/ regra "marca única = seguro"
  const marcasPorCnpj = new Map();
  for (const p of itensPdf) {
    if (!_marcaValida(p.marca)) continue;
    const set = marcasPorCnpj.get(p.cnpj) || new Set();
    set.add(_norm(p.marca)); marcasPorCnpj.set(p.cnpj, set);
  }
  // pares candidatos (score, idxPdf, numeroItem) só com mesmo CNPJ
  const pares = [];
  itensPdf.forEach((p, idx) => {
    for (const [ni, forn] of venc) {
      if (forn !== p.cnpj) continue;
      const it = nossosItens.get(ni);
      if (!it) continue;
      pares.push([_score(p, it), idx, ni]);
    }
  });
  pares.sort((a, b) => b[0] - a[0]);
  const usadosPdf = new Set(), usadosNi = new Set(), out = [];
  for (const [sc, idx, ni] of pares) {
    if (usadosPdf.has(idx) || usadosNi.has(ni)) continue;
    usadosPdf.add(idx); usadosNi.add(ni);
    const p = itensPdf[idx];
    const marcaUnica = (marcasPorCnpj.get(p.cnpj) || new Set()).size === 1;
    const confiavel = _marcaValida(p.marca) && (sc >= SCORE_MIN || marcaUnica);
    out.push({ numeroItem: ni, niFornecedor: p.cnpj, marca: p.marca.trim(), score: sc, confiavel });
  }
  return out;
}

// ─── processa 1 licitação ──────────────────────────────────────────────────
async function processarProcesso({ cnpj, ano, sequencial, link, usuarioNome }, { dryRun = false } = {}) {
  const res = { cnpj, ano, sequencial, status: 'erro', itensTotal: 0, itensGravados: 0, itensPulados: 0, plano: [], erro: null };
  try {
    if (!link) { res.status = 'sem_link'; res.erro = 'linkSistemaOrigem vazio'; return res; }
    const netloc = new URL(link).host;

    // 1) ProcessView -> token relatório
    const view = await _fetch(_encParam1(link));
    const mt = /'GET','Process','ProcessReport',\s*\['([^']+)'\]/.exec(view);
    if (!mt) { res.status = 'sem_relatorio'; res.erro = 'token ProcessReport não encontrado'; return res; }

    // 2) ProcessReport -> URL do PDF de vencedores
    const repRaw = await _fetch(`https://${netloc}/Process/ProcessReport?param1=${encodeURIComponent(mt[1])}`, { xhr: true });
    let repHtml = '';
    try { repHtml = JSON.parse(repRaw).html || ''; } catch { repHtml = String(repRaw); }
    repHtml = repHtml.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\"/g, '"').replace(/&amp;/g, '&');
    const mv = /href="(https:\/\/[^"]+VencedoresProcesso[^"]+\.pdf)"/i.exec(repHtml);
    if (!mv) { res.status = 'sem_relatorio'; res.erro = 'PDF de vencedores não listado'; return res; }

    // 3) baixa PDF + pdftotext
    const buf = Buffer.from(await _fetch(mv[1], { binary: true }));
    const txt = await _pdftotext(buf);
    const itensPdf = _parsePdf(txt);
    res.itensTotal = itensPdf.length;
    if (itensPdf.length === 0) { res.status = 'sem_relatorio'; res.erro = 'PDF sem itens parseáveis'; return res; }

    // 4) nossos itens + vencedores atuais
    const nossosItens = new Map();
    for (const r of await catalogPg.query(
      `SELECT i."numeroItem" ni, i."quantidade" q, i."valorUnitarioEstimado" vr, i."descricao" d
         FROM itens i JOIN licitacoes l ON i."licitacaoId"=l."id"
        WHERE l."cnpj"=$1 AND l."anoCompra"=$2 AND l."sequencialCompra"=$3`, [cnpj, ano, sequencial])) {
      nossosItens.set(String(r.ni), { nd: _norm(r.d), qtd: _r2(r.q), valref: _r2(r.vr) });
    }
    const venc = new Map(), marcaAtual = new Map();
    for (const r of await catalogPg.query(
      `SELECT "numeroItem" ni, "niFornecedor" forn, "marcaFabricante" marca
         FROM resultados_bi
        WHERE "cnpj"=$1 AND "ano"=$2 AND "sequencial"=$3 AND "niFornecedor"<>'__sem_resultado__'`,
      [cnpj, ano, sequencial])) {
      venc.set(String(r.ni), r.forn);
      marcaAtual.set(String(r.ni), r.marca || '');
    }
    if (venc.size === 0) { res.status = 'sem_vencedor'; return res; }

    // 5) mapeia + 6) grava só confiável e só onde marca vazia
    const plano = _mapear(itensPdf, nossosItens, venc);
    res.plano = plano;
    for (const p of plano) {
      const jaTem = (marcaAtual.get(String(p.numeroItem)) || '').trim() !== '';
      if (!p.confiavel || jaTem) { res.itensPulados++; continue; }
      if (!dryRun) {
        await catalogPg.execute(
          `UPDATE resultados_bi SET "marcaFabricante"=$5, "dataCache"=now()
            WHERE "cnpj"=$1 AND "ano"=$2 AND "sequencial"=$3 AND "numeroItem"=$4
              AND "niFornecedor"=$6 AND ("marcaFabricante" IS NULL OR "marcaFabricante"='')`,
          [cnpj, ano, sequencial, String(p.numeroItem), p.marca, p.niFornecedor]
        );
      }
      res.itensGravados++;
    }
    res.status = 'ok';
    return res;
  } catch (err) {
    res.status = 'erro';
    res.erro = (err.response ? `HTTP ${err.response.status}` : err.code || err.message || 'erro');
    return res;
  }
}

// ─── seleção do lote ───────────────────────────────────────────────────────
// Fragmentos compartilhados entre a tier de prioridade e a cronológica (l = licitacoes).
const _EXISTS_GAP = `EXISTS (
  SELECT 1 FROM resultados_bi rb
   WHERE rb."cnpj"=l."cnpj" AND rb."ano"=l."anoCompra" AND rb."sequencial"=l."sequencialCompra"
     AND rb."niFornecedor"<>'__sem_resultado__'
     AND (rb."marcaFabricante" IS NULL OR rb."marcaFabricante"=''))`;
const _NOTEXISTS_DONE = `NOT EXISTS (
  SELECT 1 FROM marca_portal_backfill mp
   WHERE mp."cnpj"=l."cnpj" AND mp."ano"=l."anoCompra" AND mp."sequencial"=l."sequencialCompra"
     AND (mp."status"='ok'
          OR (mp."status" IN ('sem_vencedor','sem_link'))
          OR (mp."status"='sem_relatorio' AND mp."dataCache" > now() - interval '${RETRY_SEM_REL_DIAS} days')
          OR (mp."status"='erro' AND (mp."tentativas">=${RETRY_ERRO_MAX} OR mp."dataCache" > now() - interval '${RETRY_ERRO_DIAS} days'))))`;
const _COLS = `l."cnpj" AS cnpj, l."anoCompra" AS ano, l."sequencialCompra" AS sequencial,
               l."linkSistemaOrigem" AS link, l."usuarioNome" AS "usuarioNome"`;

// Seleção em 2 tiers: PRIORIDADE (licitações nos grupos de palavras, via
// marca_portal_fila) primeiro; se esgotar, cai pro cronológico (mais recentes).
async function _selecionarLote(n) {
  const tier1 = await catalogPg.query(`
    SELECT ${_COLS}
      FROM marca_portal_fila f
      JOIN licitacoes l ON l."cnpj"=f."cnpj" AND l."anoCompra"=f."ano" AND l."sequencialCompra"=f."sequencial"
     WHERE l."linkSistemaOrigem" IS NOT NULL AND ${_EXISTS_GAP} AND ${_NOTEXISTS_DONE}
     ORDER BY l."dataPublicacaoPncp" DESC
     LIMIT $1
  `, [n]);
  if (tier1.length >= n) return tier1;

  const tier2 = await catalogPg.query(`
    SELECT ${_COLS}
      FROM licitacoes l
     WHERE l."usuarioNome" IN ('BLL Compras','Bolsa Nacional De Compras - BNC')
       AND l."linkSistemaOrigem" IS NOT NULL AND ${_EXISTS_GAP} AND ${_NOTEXISTS_DONE}
     ORDER BY l."dataPublicacaoPncp" DESC
     LIMIT $1
  `, [n - tier1.length]);
  const vistos = new Set(tier1.map(x => `${x.cnpj}/${x.ano}/${x.sequencial}`));
  return tier1.concat(tier2.filter(x => !vistos.has(`${x.cnpj}/${x.ano}/${x.sequencial}`)));
}

async function _registrar(res) {
  await catalogPg.execute(`
    INSERT INTO marca_portal_backfill ("cnpj","ano","sequencial","status","itensTotal","itensGravados","itensPulados","tentativas","erro","dataCache")
    VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8, now())
    ON CONFLICT ("cnpj","ano","sequencial") DO UPDATE SET
      "status"=EXCLUDED."status", "itensTotal"=EXCLUDED."itensTotal",
      "itensGravados"=EXCLUDED."itensGravados", "itensPulados"=EXCLUDED."itensPulados",
      "tentativas"=marca_portal_backfill."tentativas"+1, "erro"=EXCLUDED."erro", "dataCache"=now()
  `, [res.cnpj, res.ano, res.sequencial, res.status, res.itensTotal, res.itensGravados, res.itensPulados, res.erro]);
}

// ─── ciclo / engine ────────────────────────────────────────────────────────
async function _ciclo() {
  if (_running) return;
  _running = true;
  const t0 = Date.now();
  try {
    await _ensureSchema();
    const lote = await _selecionarLote(PROC_POR_CICLO);
    if (lote.length === 0) { return; }
    let grav = 0, ok = 0, erro = 0;
    for (const proc of lote) {
      const r = await processarProcesso(proc, { dryRun: false });
      await _registrar(r);
      grav += r.itensGravados;
      if (r.status === 'ok') ok++; else erro++;
      await new Promise(res => setTimeout(res, PROC_DELAY_MS));
    }
    console.log(`[marca-portal] ciclo: ${ok} ok / ${erro} falha, +${grav} marcas gravadas em ${Date.now() - t0}ms`);
  } catch (err) {
    console.error('[marca-portal] ciclo falhou:', err.message);
  } finally {
    _running = false;
  }
}

function iniciarBackfillEngine() {
  if (!_usePg()) { console.log('[marca-portal] engine inativo (só PG)'); return; }
  _timer = setTimeout(async function loop() {
    await _ciclo();
    _timer = setTimeout(loop, CYCLE_MS);
  }, 45000); // 45s após boot
  console.log(`[marca-portal] engine iniciado (${PROC_POR_CICLO} processos a cada ${CYCLE_MS / 1000}s — BLL/BNC)`);
}

function pararBackfillEngine() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

async function getBackfillStatus() {
  await _ensureSchema();
  const q = async (sql) => Number((await catalogPg.queryOne(sql))?.c || 0);
  const totalPortais = await q(`SELECT count(*) c FROM licitacoes WHERE "usuarioNome" IN ('BLL Compras','Bolsa Nacional De Compras - BNC')`);
  const processados = await q(`SELECT count(*) c FROM marca_portal_backfill WHERE "status"='ok'`);
  const marcasGravadas = await q(`SELECT coalesce(sum("itensGravados"),0) c FROM marca_portal_backfill`);
  const comMarca = await q(`SELECT count(*) c FROM resultados_bi WHERE "niFornecedor"<>'__sem_resultado__' AND "marcaFabricante" IS NOT NULL AND "marcaFabricante"<>''`);
  return { totalLicitacoesPortais: totalPortais, processosOk: processados, marcasGravadas, vencedoresComMarca: comMarca };
}

module.exports = {
  init, iniciarBackfillEngine, pararBackfillEngine, getBackfillStatus, seedFila,
  processarProcesso, _parsePdf, _mapear, _marcaValida, // exportados p/ teste
};

// ─── CLI (roda sem restart do serviço) ─────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const dry = args.includes('--dry');
    try {
      await _ensureSchema();
      if (args.includes('--seed')) {
        console.log('semeando fila de prioridade (grupos de palavras)...');
        const t = Date.now();
        const total = await seedFila();
        console.log(`### fila de prioridade: ${total} licitações BLL/BNC em grupos (${Date.now() - t}ms)`);
      } else if (args.includes('--processo')) {
        const i = args.indexOf('--processo');
        const [cnpj, ano, seq] = [args[i + 1], parseInt(args[i + 2], 10), parseInt(args[i + 3], 10)];
        const row = await catalogPg.queryOne(
          `SELECT "linkSistemaOrigem" link, "usuarioNome" FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3`,
          [cnpj, ano, seq]);
        const r = await processarProcesso({ cnpj, ano, sequencial: seq, link: row?.link, usuarioNome: row?.usuarioNome }, { dryRun: dry });
        console.log(`\n### ${cnpj}/${ano}/${seq} — status=${r.status} total=${r.itensTotal} gravados=${r.itensGravados} pulados=${r.itensPulados}${dry ? '  (DRY-RUN)' : ''}`);
        for (const p of r.plano.sort((a, b) => a.numeroItem - b.numeroItem)) {
          console.log(`  item ${String(p.numeroItem).padStart(3)}  score=${String(p.score).padStart(3)}  ${p.confiavel ? '✔grava' : '·pula '}  ${p.marca}`);
        }
        if (r.erro) console.log('  erro:', r.erro);
      } else if (args.includes('--run')) {
        const li = args.indexOf('--limit');
        const limit = li >= 0 ? parseInt(args[li + 1], 10) : 20;
        const lote = await _selecionarLote(limit);
        console.log(`### --run: ${lote.length} processos${dry ? ' (DRY-RUN)' : ''}\n`);
        let grav = 0, ok = 0, erro = 0;
        for (const proc of lote) {
          const r = await processarProcesso(proc, { dryRun: dry });
          if (!dry) await _registrar(r);
          grav += r.itensGravados; if (r.status === 'ok') ok++; else erro++;
          console.log(`  ${proc.cnpj}/${proc.ano}/${proc.sequencial}  ${r.status.padEnd(13)} +${r.itensGravados} marcas (${r.itensPulados} pulados)${r.erro ? '  ['+r.erro+']' : ''}`);
          await new Promise(res => setTimeout(res, PROC_DELAY_MS));
        }
        console.log(`\n### total: ${ok} ok / ${erro} falha, +${grav} marcas${dry ? ' (nada gravado — DRY)' : ' gravadas'}`);
      } else {
        console.log('uso: node marca-portal-backfill.js --run [--limit N] [--dry]');
        console.log('     node marca-portal-backfill.js --processo <cnpj> <ano> <seq> [--dry]');
      }
    } catch (e) {
      console.error('CLI erro:', e.message);
    } finally {
      await catalogPg.close().catch(() => {});
    }
  })();
}
