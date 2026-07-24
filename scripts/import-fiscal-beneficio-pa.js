#!/usr/bin/env node
// import-fiscal-beneficio-pa.js (2026-07-10)
//
// Benefícios fiscais de ICMS-PA cruzáveis por NCM (reduzem a carga). Fontes:
//   1) CESTA BÁSICA — Art. 113 (lista NCM) + Art. 126 (crédito presumido 14 p.p.
//      sobre alíq. 17% → carga 3%) do Anexo I do RICMS-PA. Via lefisc (direto).
//   2) CONVÊNIO ICMS 52/91 (adotado pelo PA, RICMS-PA Anexo III) — redução de base:
//      Anexo I  máquinas/equip. INDUSTRIAIS → carga interna 8,80%
//      Anexo II máquinas/implementos AGRÍCOLAS → carga interna 5,60%
//      (interestadual S/SE→N/NE/CO/ES: 5,14% ind / 4,1% agr). Via CONFAZ (SOCKS).
//
// NCMs parciais expandidos p/ folhas de fiscal_ncm. RESSALVA cesta básica: texto cita
// 17%, mas PA hoje é 19% — guardamos crédito em pontos + alíq-base p/ recálculo.
//
//   sudo -u carlosfinezi node scripts/import-fiscal-beneficio-pa.js

'use strict';

const { execFileSync } = require('child_process');
const iconv = require('../node_modules/iconv-lite');
const catalogPg = require('../catalog-pg');

const URL_CESTA = 'http://www.lefisc.com.br/regulamentos/ricmsPA/anexoI.asp';
const URL_CONV52 = 'https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91';
const SOCKS = '127.0.0.1:1080';

const digs = (s) => String(s || '').replace(/\D/g, '');
const celulas = (tr) => (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map((td) =>
  td.replace(/<[^>]+>/g, ' ').replace(/&#160;|&nbsp;/g, ' ').replace(/ /g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim());

function curlBuf(url, socks) {
  const args = ['-sL', '--max-time', '90'];
  if (socks) args.push('--socks5-hostname', SOCKS);
  return execFileSync('curl', [...args, url], { timeout: 100000, maxBuffer: 48 * 1024 * 1024 });
}

function expandeNcm(token, folhas, folhasArr) {
  const d = digs(token);
  if (d.length === 8) return folhas.has(d) ? [d] : [];
  if (d.length >= 4 && d.length < 8) return folhasArr.filter((f) => f.startsWith(d));
  return [];
}

// aplica um registro se o NCM ainda não tiver benefício (1º a chegar vence)
function aplicar(registros, ncms, reg) {
  for (const ncm of ncms) if (!registros.has(ncm)) registros.set(ncm, reg);
}

// ---- Fonte 1: cesta básica (Art. 113 do RICMS-PA, lefisc win1252)
function ingerirCestaBasica(registros, folhas, folhasArr) {
  const html = iconv.decode(curlBuf(URL_CESTA, false), 'win1252');
  const i = html.search(/art\.?\s*113/i);
  if (i < 0) throw new Error('cesta básica: Art. 113 não encontrado');
  const resto = html.slice(i + 50);
  const j = resto.search(/art\.?\s*11[4-9]/i);
  const regiao = html.slice(i, j >= 0 ? i + 50 + j : i + 400000);
  const FUND = 'Cesta básica — Art. 113 e 126 do Anexo I do RICMS-PA (Dec. 85/2019 e 37/2019)';
  const OBS = 'Crédito presumido de 14 p.p. sobre alíquota 17% (carga 3%); 11 p.p. sobre 12% (carga 1%). Alíquota-padrão do PA passou a 19% em 2024 — confirmar carga vigente.';
  let itens = 0;
  for (const tr of regiao.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const c = celulas(tr);
    if (c.length < 4 || !/^\d+\.?$/.test(c[0].trim())) continue;
    const toks = c[2].match(/\d{4}(?:\.\d{1,2}){0,2}/g) || [];
    if (!toks.length) continue;
    itens++;
    const desc = c[3].trim() || null;
    const ncms = [...new Set(toks.flatMap((t) => expandeNcm(t, folhas, folhasArr)))];
    aplicar(registros, ncms, { tipo: 'cesta_basica', descricao: desc, credito_pontos: 14, aliquota_base: 17, carga_efetiva: 3, fundamentacao: FUND, observacao: OBS });
  }
  return itens;
}

// ---- Fonte 2: Convênio 52/91 (CONFAZ via SOCKS)
function ingerirConv52(registros, folhas, folhasArr) {
  const html = curlBuf(URL_CONV52, true).toString('utf8');
  // fronteira do Anexo II (agrícolas): o título "(CLÁUSULA SEGUNDA DO CONVÊNIO...)".
  // Âncora ASCII "SEGUNDA DO CONV" (ocorrência única, robusta a tags/acento).
  const iAgr = html.search(/SEGUNDA DO CONV/i);
  if (iAgr < 0) throw new Error('conv52: início do Anexo II (agrícola) não encontrado');
  // fim do Anexo II = próximo "PRIMEIRA DO CONV" (repetição/versão antiga) ou janela
  const dep = html.slice(iAgr + 50);
  const iFim = dep.search(/PRIMEIRA DO CONV/i);
  const segIndustrial = html.slice(0, iAgr);
  const segAgricola = html.slice(iAgr, iFim >= 0 ? iAgr + 50 + iFim : iAgr + 60000);
  const FUND = 'Redução de base de cálculo — Convênio ICMS 52/91 (RICMS-PA Anexo III)';
  const OBS_I = 'Máquinas/equipamentos industriais (Anexo I). Carga interna 8,80%; interestadual S/SE→N/NE/CO/ES 5,14%, demais 8,80%.';
  const OBS_II = 'Máquinas/implementos agrícolas (Anexo II). Carga interna 5,60%; interestadual S/SE→N/NE/CO/ES 4,1%, demais 7,0%.';

  const parseSeg = (seg) => {
    const rows = [];
    for (const tr of seg.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
      const c = celulas(tr);
      if (c.length < 2) continue;
      const ultima = c[c.length - 1];
      const toks = ultima.match(/\d{4}\.\d{2}(?:\.\d{2})?/g) || [];
      if (!toks.length) continue;
      rows.push({ desc: (c[c.length - 2] || '').slice(0, 200) || null, toks });
    }
    return rows;
  };

  let nI = 0, nII = 0;
  // industrial primeiro (vence os ~7 overlaps com agrícola)
  for (const r of parseSeg(segIndustrial)) {
    const ncms = [...new Set(r.toks.flatMap((t) => expandeNcm(t, folhas, folhasArr)))];
    const antes = registros.size;
    aplicar(registros, ncms, { tipo: 'reducao_base_industrial', descricao: r.desc, credito_pontos: null, aliquota_base: null, carga_efetiva: 8.80, fundamentacao: FUND, observacao: OBS_I });
    nI += registros.size - antes;
  }
  for (const r of parseSeg(segAgricola)) {
    const ncms = [...new Set(r.toks.flatMap((t) => expandeNcm(t, folhas, folhasArr)))];
    const antes = registros.size;
    aplicar(registros, ncms, { tipo: 'reducao_base_agricola', descricao: r.desc, credito_pontos: null, aliquota_base: null, carga_efetiva: 5.60, fundamentacao: FUND, observacao: OBS_II });
    nII += registros.size - antes;
  }
  return { nI, nII };
}

async function main() {
  const folhasArr = (await catalogPg.query('SELECT codigo FROM fiscal_ncm WHERE folha')).map((r) => r.codigo);
  const folhas = new Set(folhasArr);
  const registros = new Map();

  console.log('[beneficio-pa] cesta básica (lefisc)...');
  const itensCesta = ingerirCestaBasica(registros, folhas, folhasArr);
  console.log(`  ${itensCesta} itens → ${registros.size} NCMs acum.`);

  console.log('[beneficio-pa] Convênio 52/91 (CONFAZ via SOCKS)...');
  try {
    const { nI, nII } = ingerirConv52(registros, folhas, folhasArr);
    console.log(`  industrial +${nI}, agrícola +${nII} → ${registros.size} NCMs acum.`);
  } catch (e) {
    // SOCKS fora/erro do CONFAZ não deve derrubar a cesta básica (já ingerida)
    console.error(`  Conv 52/91 falhou (mantendo só cesta básica): ${e.message.slice(0, 100)}`);
  }

  if (registros.size < 100) throw new Error(`poucos NCMs (${registros.size}) — abortando sem gravar`);

  await catalogPg.withTx(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS fiscal_beneficio_pa (
        ncm TEXT PRIMARY KEY, uf TEXT NOT NULL DEFAULT 'PA', tipo TEXT NOT NULL, descricao TEXT,
        credito_pontos NUMERIC, aliquota_base NUMERIC, carga_efetiva NUMERIC,
        fundamentacao TEXT, observacao TEXT, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query('TRUNCATE fiscal_beneficio_pa');
    const cols = ['ncm', 'uf', 'tipo', 'descricao', 'credito_pontos', 'aliquota_base', 'carga_efetiva', 'fundamentacao', 'observacao'];
    const rows = [...registros.entries()];
    for (let i = 0; i < rows.length; i += 500) {
      const lote = rows.slice(i, i + 500);
      const params = [];
      const tuples = lote.map(([ncm, r], j) => {
        const b = j * cols.length;
        params.push(ncm, 'PA', r.tipo, r.descricao, r.credito_pontos, r.aliquota_base, r.carga_efetiva, r.fundamentacao, r.observacao);
        return `(${cols.map((_, k) => `$${b + k + 1}`).join(',')})`;
      });
      await client.query(`INSERT INTO fiscal_beneficio_pa (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (ncm) DO NOTHING`, params);
    }
  });

  const porTipo = await catalogPg.query('SELECT tipo, count(*)::int n FROM fiscal_beneficio_pa GROUP BY tipo ORDER BY n DESC');
  console.log('[beneficio-pa] gravado:', porTipo.map((r) => `${r.tipo}=${r.n}`).join(' '));
  await catalogPg.close();
}

main().catch((e) => { console.error('[beneficio-pa] ERRO:', e.message); process.exit(1); });
