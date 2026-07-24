#!/usr/bin/env node
// import-fiscal-icms-st.js (2026-07-10)
//
// ICMS-ST / MVA por CEST × UF — scraper do Portal Nacional da Substituição
// Tributária (CONFAZ). Só ~8 UFs publicam planilha XLSX estruturada:
//   AP, BA, MS, PR, PE, SC, SE, SP  (SP atualizada mensalmente).
// PA e os demais NÃO publicam aqui (dependem de RICMS estadual — Fase C2).
//
// CONFAZ BLOQUEIA IP DE DATACENTER → download OBRIGATÓRIO via SOCKS residencial
// (socks5://127.0.0.1:1080). Usamos curl --socks5-hostname (já validado).
//
// Cada XLSX tem 1 aba por segmento CEST. Colunas (mapeadas por NOME, variam por aba):
//   CEST | Descrição | Op. Interna (S/N) | [colunas de UF c/ ato] | MVA-ST 1 | Alíq. Interna 1 | PFC 1
//   MVA-ST 1 = "MVA-ST Original aplicada nas operações internas" (Leiaute item 9).
//
//   sudo -u carlosfinezi node scripts/import-fiscal-icms-st.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('../node_modules/xlsx');
const iconv = require('../node_modules/iconv-lite');
const catalogPg = require('../catalog-pg');

const SOCKS = '127.0.0.1:1080';
const PORTAL = 'https://www.confaz.fazenda.gov.br/legislacao/portal-nacional-da-substituicao-tributaria';
// PA não publica no Portal Nacional. A MVA/ST do PA está consolidada no Anexo XIII
// do RICMS-PA (Decreto 4.676/2001). SEFA-PA fora do ar → espelho lefisc (HTML, latin-1).
const URL_PA = 'https://www.lefisc.com.br/regulamentos/ricmsPA/anexoXIII.asp';
// UF -> slug da sub-página (nome do estado)
const UFS = {
  SP: 'sao-paulo', AP: 'amapa', BA: 'bahia', MS: 'mato-grosso-do-sul',
  PR: 'parana', PE: 'pernambuco', SC: 'santa-catarina', SE: 'sergipe',
};

const digs = (s) => String(s || '').replace(/\D/g, '');
const pctNum = (v) => {
  // fonte usa ponto decimal e sufixo % (ex.: "46.68%"); '-'/'' -> null
  const n = Number(String(v == null ? '' : v).replace('%', '').replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
};

function curlSocks(url, outFile) {
  const args = ['-sL', '--socks5-hostname', SOCKS, '--max-time', '120'];
  if (outFile) { args.push('-o', outFile); execFileSync('curl', [...args, url], { timeout: 130000, stdio: 'ignore' }); return null; }
  return execFileSync('curl', [...args, url], { timeout: 130000, maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
}

// download direto (lefisc responde a datacenter), retorna Buffer
function curlDireto(url) {
  return execFileSync('curl', ['-sL', '--max-time', '120', url], { timeout: 130000, maxBuffer: 32 * 1024 * 1024 });
}

// Anexo XIII do RICMS-PA (HTML latin-1). Presença = sujeito a ST no PA. Dois formatos:
//   6 colunas: item | CEST | NCM | descrição | MVA-ind (%) | MVA-dist  → MVA inline.
//   4 colunas: item | CEST | NCM | descrição                          → MVA remetida ao
//     convênio/protocolo (não publicada aqui) → mva_original null (não inventamos).
// MVA em % com vírgula decimal. Alíq. interna PA = 19%.
function parsePA(buf) {
  const html = iconv.decode(buf, 'latin1');
  const out = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const c = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map((td) =>
      td.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim());
    if (c.length < 4) continue;
    const cest = digs(c[1]);
    if (cest.length !== 7) continue;
    const mva = c.length >= 6 ? pctNum(c[4]) : null;
    out.push({
      cest, uf: 'PA', segmento: null, descricao: c[3] || null, tem_st: true,
      mva_original: mva, aliquota_interna: 19,
      ato: mva == null ? 'RICMS-PA Anexo XIII (MVA no convênio)' : 'RICMS-PA Anexo XIII',
    });
  }
  return out;
}

// resolve o link .xlsx mais recente (1º da lista = maior versão) na sub-página da UF
function resolverXlsx(html, uf) {
  const hrefs = [...html.matchAll(/href="([^"]+\.xlsx)"/gi)].map((m) => m[1]);
  if (!hrefs.length) return null;
  const h = hrefs[0];
  if (h.startsWith('http')) return h;
  if (h.startsWith('/')) return 'https://www.confaz.fazenda.gov.br' + h;
  return `${PORTAL}/${UFS[uf]}/${h}`;
}

// mapeia colunas por nome no cabeçalho
function mapaColunas(hdr) {
  const idx = (re) => hdr.findIndex((c) => re.test(String(c).trim()));
  return {
    cest: idx(/^CEST$/i),
    desc: idx(/^Descri/i),
    op: idx(/^Op\.?\s*Interna/i),
    mva: idx(/^MVA-?ST/i),
    aliq: idx(/^Al[íi]q\.?\s*Interna/i),
  };
}

function parseWorkbook(buf, uf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const out = [];
  for (const nome of wb.SheetNames) {
    if (/leiaute/i.test(nome)) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: false, defval: '' });
    const hi = rows.findIndex((r) => r.some((c) => /^CEST$/i.test(String(c).trim())));
    if (hi < 0) continue;
    const col = mapaColunas(rows[hi]);
    if (col.cest < 0) continue;
    for (const r of rows.slice(hi + 1)) {
      const cest = digs(r[col.cest]);
      if (cest.length !== 7) continue;
      const op = String(r[col.op] || '').trim().toUpperCase();
      const temSt = op === 'S';
      const mva = temSt && col.mva >= 0 ? pctNum(r[col.mva]) : null;
      const aliq = col.aliq >= 0 ? pctNum(r[col.aliq]) : null;
      // ato = 1ª coluna de UF preenchida entre Op.Interna e MVA (ex.: "CV 102/17")
      let ato = null;
      for (let k = col.op + 1; k < col.mva; k++) { const v = String(r[k] || '').trim(); if (v && v !== '-') { ato = v; break; } }
      out.push({ cest, uf, segmento: nome, descricao: String(r[col.desc] || '').trim() || null, tem_st: temSt, mva_original: mva, aliquota_interna: aliq, ato });
    }
  }
  return out;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confaz-st-'));
  const todos = [];
  const cobertura = [];

  for (const uf of Object.keys(UFS)) {
    try {
      const pagina = curlSocks(`${PORTAL}/${UFS[uf]}`);
      const url = resolverXlsx(pagina, uf);
      if (!url) { cobertura.push(`${uf}:sem-xlsx`); continue; }
      const dest = path.join(dir, `${uf}.xlsx`);
      curlSocks(url, dest);
      const buf = fs.readFileSync(dest);
      if (buf.length < 10000) { cobertura.push(`${uf}:download-vazio`); continue; }
      const regs = parseWorkbook(buf, uf);
      const comSt = regs.filter((r) => r.tem_st && r.mva_original != null).length;
      todos.push(...regs);
      cobertura.push(`${uf}:${regs.length}(ST ${comSt})`);
      console.log(`[icms-st] ${uf}: ${regs.length} CEST, ${comSt} com MVA`);
    } catch (e) {
      cobertura.push(`${uf}:ERRO`);
      console.error(`[icms-st] ${uf} falhou: ${e.message.slice(0, 120)}`);
    }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  // PA — Anexo XIII do RICMS (fonte estadual; lefisc, direto)
  try {
    const regsPA = parsePA(curlDireto(URL_PA));
    todos.push(...regsPA);
    cobertura.push(`PA:${regsPA.length}(RICMS)`);
    console.log(`[icms-st] PA: ${regsPA.length} CEST (Anexo XIII RICMS)`);
  } catch (e) {
    cobertura.push('PA:ERRO');
    console.error(`[icms-st] PA falhou: ${e.message.slice(0, 120)}`);
  }

  if (todos.length < 200) throw new Error(`poucos registros (${todos.length}) — abortando sem gravar. Cobertura: ${cobertura.join(' ')}`);

  await catalogPg.withTx(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS fiscal_icms_st (
        cest TEXT NOT NULL,
        uf TEXT NOT NULL,
        segmento TEXT,
        descricao TEXT,
        tem_st BOOLEAN NOT NULL DEFAULT false,
        mva_original NUMERIC,
        aliquota_interna NUMERIC,
        ato TEXT,
        fonte TEXT,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (cest, uf)
      );
      CREATE INDEX IF NOT EXISTS idx_fiscal_icms_st_cest ON fiscal_icms_st (cest);
    `);
    await client.query('TRUNCATE fiscal_icms_st');
    const cols = ['cest', 'uf', 'segmento', 'descricao', 'tem_st', 'mva_original', 'aliquota_interna', 'ato', 'fonte'];
    // dedup por (cest,uf) — a planilha repete CEST em linhas de especificação (nacional/
    // importado, N vs S). Mantém a linha MAIS informativa: prioriza tem_st com MVA.
    const escore = (r) => (r.tem_st && r.mva_original != null ? 2 : r.mva_original != null ? 1 : 0);
    const melhor = new Map();
    for (const r of todos) {
      const k = r.cest + r.uf;
      const at = melhor.get(k);
      if (!at || escore(r) > escore(at)) melhor.set(k, r);
    }
    const unicos = [...melhor.values()];
    for (let i = 0; i < unicos.length; i += 1000) {
      const lote = unicos.slice(i, i + 1000);
      const params = [];
      const tuples = lote.map((r, j) => {
        const b = j * cols.length;
        params.push(r.cest, r.uf, r.segmento, r.descricao, r.tem_st, r.mva_original, r.aliquota_interna, r.ato, 'CONFAZ Portal Nacional ST');
        return `(${cols.map((_, k) => `$${b + k + 1}`).join(',')})`;
      });
      await client.query(`INSERT INTO fiscal_icms_st (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (cest, uf) DO NOTHING`, params);
    }
  });

  const porUf = await catalogPg.query('SELECT uf, count(*)::int n, count(*) FILTER (WHERE tem_st AND mva_original IS NOT NULL)::int com_mva FROM fiscal_icms_st GROUP BY uf ORDER BY uf');
  console.log('[icms-st] gravado por UF:', porUf.map((r) => `${r.uf}=${r.n}/${r.com_mva}`).join(' '));
  console.log('[icms-st] cobertura:', cobertura.join(' '));
  await catalogPg.close();
}

main().catch((e) => { console.error('[icms-st] ERRO:', e.message); process.exit(1); });
