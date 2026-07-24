#!/usr/bin/env node
// import-fiscal-pis-cofins.js (2026-07-10)
//
// PIS/COFINS por NCM — regime especial (monofásico / ST / alíquota zero) + alíquotas.
// Fonte OFICIAL: Portal SPED da Receita, tabelas 4.3.x (http puro, sem 443):
//   4.3.10 (1638) monofásico alíq. diferenciadas (CST 02/04) — PIS/COFINS em %
//   4.3.11 (5786) monofásico por unidade de medida (CST 03/04) — valores em R$/unid (não %)
//   4.3.12 (1642) Substituição Tributária (CST 05) — PIS/COFINS em %
//   4.3.13 (1643) Alíquota Zero (CST 06) — sem alíquota (0/0)
// Cada .doc é convertido p/ HTML via LibreOffice e parseado por <tr>/<td>.
// NCMs parciais (posição/subposição) são expandidos p/ as folhas de fiscal_ncm.
//
//   sudo -u carlosfinezi node scripts/import-fiscal-pis-cofins.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const catalogPg = require('../catalog-pg');

const BASE = 'http://sped.rfb.gov.br/arquivo/download/';
// lista comunidade (NCMs monofásicos ATUAIS 2026 + base legal) — amplia onde o SPED,
// por referenciar NCMs antigos, subenumera. SPED continua autoritativo nas alíquotas.
const URL_COM = 'https://raw.githubusercontent.com/silvioalbqrq/consulta-pis-cofins-monofasico-icms/HEAD/index.html';
// prioridade de regime quando um NCM aparece em mais de uma tabela
const PRIO = { monofasico: 3, st: 2, aliquota_zero: 1 };
const TABELAS = [
  { id: 1638, tabela: '4.3.10', regime: 'monofasico', ncm: 2, pis: 3, cofins: 4, term: 6 },
  { id: 5786, tabela: '4.3.11', regime: 'monofasico', ncm: 2, pis: null, cofins: null, term: 7 }, // por unidade → sem %
  { id: 1642, tabela: '4.3.12', regime: 'st', ncm: 2, pis: 3, cofins: 4, term: 6 },
  { id: 1643, tabela: '4.3.13', regime: 'aliquota_zero', ncm: 2, pis: null, cofins: null, term: 4, zero: true },
];

const digs = (s) => String(s || '').replace(/\D/g, '');
const num = (v) => {
  const s = String(v == null ? '' : v).trim().replace(/\./g, '').replace(',', '.');
  if (!/\d/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const limpaCel = (c) => c.replace(/<[^>]+>/g, '').replace(/&#160;|&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function baixarDoc(id, dir) {
  const dest = path.join(dir, `t${id}.doc`);
  const resp = await fetch(BASE + id, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ao baixar tabela id=${id}`);
  fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
  return dest;
}

function docParaHtml(docPath, dir) {
  const profile = path.join(dir, 'lo-profile');
  execFileSync('libreoffice', [
    '--headless', `-env:UserInstallation=file://${profile}`,
    '--convert-to', 'html', '--outdir', dir, docPath,
  ], { timeout: 180000, stdio: 'ignore' });
  const html = docPath.replace(/\.doc$/, '.html');
  if (!fs.existsSync(html)) throw new Error(`conversão falhou: ${html}`);
  return fs.readFileSync(html, 'utf8');
}

function linhasHtml(html) {
  return (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []).map((tr) =>
    (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map((td) =>
      limpaCel(td.replace(/^<td[^>]*>/, '').replace(/<\/td>$/, ''))));
}

// extrai TODOS os NCMs de uma célula. Pontos são OPCIONAIS (a fonte mistura
// "2710.11.59" e "27101259"), e corridas concatenadas de 8 díg são quebradas
// pela captura gulosa de 4+2+2: "220710002208900001" -> 22071000, 22089000...
function ncmsDaCelula(cel) {
  return cel.match(/\d{4}\.?\d{2}(?:\.?\d{2})?/g) || [];
}

// expande um token de NCM (8 díg = folha; posição 6 díg = prefixo → folhas)
function expandeNcm(token, folhas, folhasArr) {
  const d = digs(token);
  if (d.length === 8) return folhas.has(d) ? [d] : [];
  if (d.length >= 4 && d.length < 8) return folhasArr.filter((f) => f.startsWith(d));
  return [];
}

async function main() {
  const folhasArr = (await catalogPg.query('SELECT codigo FROM fiscal_ncm WHERE folha')).map((r) => r.codigo);
  const folhas = new Set(folhasArr);
  console.log(`[pis-cofins] ${folhas.size} folhas NCM carregadas p/ expansão`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sped-'));
  const registros = new Map(); // ncm -> {regime, pis, cofins, fundamentacao, tabela_origem}

  for (const t of TABELAS) {
    console.log(`[pis-cofins] baixando ${t.tabela} (id ${t.id})...`);
    const html = docParaHtml(await baixarDoc(t.id, dir), dir);
    const linhas = linhasHtml(html);
    let add = 0;
    for (const c of linhas) {
      const cel = c[t.ncm] || '';
      if (!/\d{4}\.?\d{2}/.test(cel)) continue;               // linha sem NCM
      if ((c[t.term] || '').trim() !== '') continue;          // término preenchido = expirado → pula
      const pis = t.zero ? 0 : (t.pis != null ? num(c[t.pis]) : null);
      const cofins = t.zero ? 0 : (t.cofins != null ? num(c[t.cofins]) : null);
      const fundamentacao = `SPED ${t.tabela}` + (t.pis == null && !t.zero ? ' (alíq. por unidade de medida)' : '');
      // a célula de NCM pode listar vários (por vírgula/espaço/quebra de linha) e parciais
      for (const tok of ncmsDaCelula(cel)) {
        for (const ncm of expandeNcm(tok, folhas, folhasArr)) {
          const atual = registros.get(ncm);
          if (!atual || PRIO[t.regime] > PRIO[atual.regime]) {
            registros.set(ncm, { regime: t.regime, pis, cofins, fundamentacao, tabela_origem: t.tabela });
            add++;
          }
        }
      }
    }
    console.log(`  ${t.tabela}: ${linhas.length} linhas → ${add} atribuições (acum. ${registros.size} NCMs)`);
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  // 5ª fonte: lista comunidade de monofásico (NCMs atuais) — só preenche ausentes
  console.log('[pis-cofins] baixando lista comunidade (silvioalbqrq)...');
  const comHtml = await (await fetch(URL_COM, { redirect: 'follow' })).text();
  const m = comHtml.match(/const\s+PIS_DATA\s*=\s*(\[[\s\S]*?\])\s*;/);
  const comData = m ? JSON.parse(m[1]) : [];
  let addCom = 0;
  for (const d of comData) {
    const ncm = digs(d.ncm);
    if (ncm.length !== 8 || !folhas.has(ncm) || registros.has(ncm)) continue;
    registros.set(ncm, { regime: 'monofasico', pis: null, cofins: null, fundamentacao: String(d.leg || '').slice(0, 200), tabela_origem: 'comunidade silvioalbqrq' });
    addCom++;
  }
  console.log(`  comunidade: ${comData.length} itens → +${addCom} NCMs (acum. ${registros.size})`);

  if (registros.size < 300) throw new Error(`poucos NCMs (${registros.size}) — abortando sem gravar`);

  await catalogPg.withTx(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS fiscal_pis_cofins (
        ncm TEXT PRIMARY KEY,
        cst TEXT,
        pis_aliquota NUMERIC,
        cofins_aliquota NUMERIC,
        regime TEXT NOT NULL,
        fundamentacao TEXT,
        tabela_origem TEXT
      );
    `);
    await client.query('TRUNCATE fiscal_pis_cofins');
    const rows = [...registros.entries()];
    const cols = ['ncm', 'cst', 'pis_aliquota', 'cofins_aliquota', 'regime', 'fundamentacao', 'tabela_origem'];
    for (let i = 0; i < rows.length; i += 1000) {
      const lote = rows.slice(i, i + 1000);
      const params = [];
      const tuples = lote.map(([ncm, r], j) => {
        const b = j * 7;
        params.push(ncm, null, r.pis, r.cofins, r.regime, r.fundamentacao, r.tabela_origem);
        return `(${cols.map((_, k) => `$${b + k + 1}`).join(',')})`;
      });
      await client.query(`INSERT INTO fiscal_pis_cofins (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (ncm) DO NOTHING`, params);
    }
  });

  const porRegime = await catalogPg.query('SELECT regime, count(*)::int n FROM fiscal_pis_cofins GROUP BY regime ORDER BY n DESC');
  console.log('[pis-cofins] gravado por regime:', porRegime.map((r) => `${r.regime}=${r.n}`).join(' '));
  await catalogPg.close();
}

main().catch((e) => { console.error('[pis-cofins] ERRO:', e.message); process.exit(1); });
