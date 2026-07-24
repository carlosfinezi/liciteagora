#!/usr/bin/env node
// import-fiscal-impostos.js (2026-07-10)
//
// Camada de ALÍQUOTAS por NCM (complementa a classificação NCM/CEST):
//   - fiscal_ipi  : IPI por NCM (TIPI oficial da Receita, XLSX)
//   - fiscal_ii   : Imposto de Importação por NCM (TEC — Gecex 272/21 Anexo I, XLSX MDIC)
//   - fiscal_ibpt : carga tributária aproximada Fed/Est/Mun por NCM × UF (IBPT, Lei 12.741)
//
// PIS/COFINS por NCM (monofásico/alíq. zero/ST): NÃO ingerido — não há fonte aberta
// vigente confiável (só tabelas de 2013). Exige curadoria da legislação por setor.
//
// Idempotente (TRUNCATE + reload). Pode virar cron (IBPT muda ~mensal, TIPI/TEC por decreto).
//   sudo -u carlosfinezi node scripts/import-fiscal-impostos.js

'use strict';

const AdmZip = require('adm-zip');
const XLSX = require('xlsx');
const iconv = require('iconv-lite');
const catalogPg = require('../catalog-pg');

const URL_TIPI = 'https://www.gov.br/receitafederal/pt-br/acesso-a-informacao/legislacao/documentos-e-arquivos/tipi.xlsx';
const URL_TEC = 'https://www.gov.br/mdic/pt-br/assuntos/camex/estrategia-comercial/arquivos-listas/anexos-i-a-ix-resolucao-gecex-272-21-4.xlsx/@@download/file';
const IBPT_REPO_TREE = 'https://api.github.com/repos/luizinhoh2o1/tabelas-ibpt/git/trees/HEAD?recursive=1';
const IBPT_RAW_BASE = 'https://raw.githubusercontent.com/luizinhoh2o1/tabelas-ibpt/master/';
const IBPT_VERSAO_FALLBACK = 'TabelaIBPTax_26.1.L.zip';

const digs = (s) => String(s || '').replace(/\D/g, '');
const ehNcm8 = (s) => digs(s).length === 8;
// "13.45" ou 13.45 -> número; vazio/inválido -> null
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
// "31/07/2026" -> "2026-07-31"
const dataBr = (s) => {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

async function baixarBuffer(url, tentativas = 3) {
  let ultimoErro;
  for (let i = 1; i <= tentativas; i++) {
    try {
      const resp = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'liciteagora-fiscal/1.0' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      ultimoErro = e;
      console.log(`  retry ${i}/${tentativas} (${e.message})`);
      await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
  throw new Error(`falha ao baixar ${url}: ${ultimoErro.message}`);
}

// planilha XLSX -> linhas como arrays, a partir da linha de cabeçalho detectada.
// procura a linha cujo 1º campo casa "NCM"; retorna as linhas seguintes.
function linhasXlsx(buf, nomeSheet) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[nomeSheet] || wb.Sheets[wb.SheetNames.find((n) => n.includes(nomeSheet)) || wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  const iHead = linhas.findIndex((l) => String(l[0] || '').trim().toUpperCase() === 'NCM');
  return iHead >= 0 ? linhas.slice(iHead + 1) : linhas;
}

// ---------------------------------------------------------------- TIPI (IPI)
function montarIpi(buf) {
  const out = [];
  for (const l of linhasXlsx(buf, 'Tabela Completa')) {
    const ncm = digs(l[0]);
    if (ncm.length !== 8) continue;                 // só folhas 8 díg carregam alíquota
    const raw = String(l[3] ?? '').trim();          // coluna ALÍQUOTA (%)
    const nt = /^NT$/i.test(raw);
    out.push({ ncm, aliquota: nt ? null : num(raw), nt });
  }
  return out;
}

// ---------------------------------------------------------------- TEC (II)
function montarIi(buf) {
  const out = [];
  for (const l of linhasXlsx(buf, 'Anexo I - TEC')) {
    const ncm = digs(l[0]);
    if (ncm.length !== 8) continue;
    const al = num(l[2]);                            // coluna TEC (%)
    if (al == null) continue;
    out.push({ ncm, aliquota: al });
  }
  return out;
}

// ---------------------------------------------------------------- IBPT
// parser CSV mínimo respeitando aspas; separador ';'
function csvLinha(linha) {
  const campos = [];
  let atual = '', dentro = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') { if (dentro && linha[i + 1] === '"') { atual += '"'; i++; } else dentro = !dentro; }
    else if (c === ';' && !dentro) { campos.push(atual); atual = ''; }
    else atual += c;
  }
  campos.push(atual);
  return campos;
}

async function descobrirIbptZip() {
  try {
    const tree = JSON.parse((await baixarBuffer(IBPT_REPO_TREE)).toString('utf8'));
    const zips = (tree.tree || []).map((n) => n.path).filter((p) => /TabelaIBPTax_[\d.]+[A-Z]\.zip$/.test(p));
    if (zips.length) {
      // ordena por versão numérica embutida; pega a maior
      zips.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return zips[zips.length - 1];
    }
  } catch (e) { console.log(`  (auto-detect IBPT falhou: ${e.message}; usando fallback)`); }
  return `repositorio-ibpt/${IBPT_VERSAO_FALLBACK}`;
}

function montarIbpt(buf) {
  const zip = new AdmZip(buf);
  const out = [];
  for (const entry of zip.getEntries()) {
    if (!/\.csv$/i.test(entry.entryName)) continue;
    const mUf = entry.entryName.match(/TabelaIBPTax([A-Z]{2})/i);
    if (!mUf) continue;
    const uf = mUf[1].toUpperCase();
    const texto = iconv.decode(entry.getData(), 'latin1');
    const linhas = texto.split(/\r?\n/);
    for (let i = 1; i < linhas.length; i++) {          // pula cabeçalho
      if (!linhas[i].trim()) continue;
      const f = csvLinha(linhas[i]);
      // codigo;ex;tipo;descricao;nacionalfederal;importadosfederal;estadual;municipal;vigenciainicio;vigenciafim;chave;versao;fonte
      if (f[2] !== '0') continue;                       // tipo 0 = NCM (1=NBS, 2=LC116)
      if ((f[1] || '').trim() !== '') continue;         // só a linha base (sem exceção tarifária 'ex')
      if (!ehNcm8(f[0])) continue;
      out.push({
        ncm: digs(f[0]), uf,
        nac_federal: num(f[4]), imp_federal: num(f[5]), estadual: num(f[6]), municipal: num(f[7]),
        vigencia_fim: dataBr(f[9]), versao: (f[11] || '').trim(), fonte: (f[12] || '').trim(),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- carga PG
async function criarSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS fiscal_ipi (
      ncm TEXT PRIMARY KEY, aliquota NUMERIC, nt BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS fiscal_ii (
      ncm TEXT PRIMARY KEY, aliquota NUMERIC
    );
    CREATE TABLE IF NOT EXISTS fiscal_ibpt (
      ncm TEXT NOT NULL, uf TEXT NOT NULL,
      nac_federal NUMERIC, imp_federal NUMERIC, estadual NUMERIC, municipal NUMERIC,
      vigencia_fim DATE, versao TEXT, fonte TEXT,
      PRIMARY KEY (ncm, uf)
    );
    CREATE INDEX IF NOT EXISTS idx_fiscal_ibpt_ncm ON fiscal_ibpt (ncm);
  `);
}

async function bulk(client, tabela, colunas, rows) {
  await client.query(`TRUNCATE ${tabela}`);
  const nc = colunas.length;
  for (let i = 0; i < rows.length; i += 1000) {
    const lote = rows.slice(i, i + 1000);
    const params = [];
    const tuples = lote.map((r, j) => {
      const b = j * nc;
      colunas.forEach((c) => params.push(r[c]));
      return '(' + colunas.map((_, k) => `$${b + k + 1}`).join(',') + ')';
    });
    await client.query(`INSERT INTO ${tabela} (${colunas.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params);
  }
}

async function main() {
  console.log('[impostos] baixando TIPI (IPI)...');
  const ipi = montarIpi(await baixarBuffer(URL_TIPI));
  console.log(`  IPI: ${ipi.length} NCMs (${ipi.filter((x) => x.nt).length} NT)`);

  console.log('[impostos] baixando TEC (II)...');
  const ii = montarIi(await baixarBuffer(URL_TEC));
  console.log(`  II: ${ii.length} NCMs`);

  console.log('[impostos] baixando IBPT...');
  const zipPath = await descobrirIbptZip();
  console.log(`  usando ${zipPath}`);
  const ibpt = montarIbpt(await baixarBuffer(IBPT_RAW_BASE + zipPath));
  const ufs = [...new Set(ibpt.map((x) => x.uf))];
  console.log(`  IBPT: ${ibpt.length} linhas · ${ufs.length} UFs (${ufs.sort().join(',')})`);

  if (ipi.length < 5000 || ii.length < 5000 || ibpt.length < 100000) {
    throw new Error(`contagens suspeitas (ipi=${ipi.length}, ii=${ii.length}, ibpt=${ibpt.length}) — abortando`);
  }

  await catalogPg.withTx(async (client) => {
    await criarSchema(client);
    await bulk(client, 'fiscal_ipi', ['ncm', 'aliquota', 'nt'], ipi);
    await bulk(client, 'fiscal_ii', ['ncm', 'aliquota'], ii);
    await bulk(client, 'fiscal_ibpt', ['ncm', 'uf', 'nac_federal', 'imp_federal', 'estadual', 'municipal', 'vigencia_fim', 'versao', 'fonte'], ibpt);
  });

  // cobertura vs folhas de NCM
  const [{ n: cobIpi }] = await catalogPg.query('SELECT count(*)::int n FROM fiscal_ncm n WHERE n.folha AND EXISTS (SELECT 1 FROM fiscal_ipi i WHERE i.ncm=n.codigo)');
  const [{ n: totFolha }] = await catalogPg.query('SELECT count(*)::int n FROM fiscal_ncm WHERE folha');
  const [{ n: cobIbpt }] = await catalogPg.query("SELECT count(*)::int n FROM fiscal_ncm n WHERE n.folha AND EXISTS (SELECT 1 FROM fiscal_ibpt b WHERE b.ncm=n.codigo AND b.uf='SP')");
  console.log(`[impostos] gravado. Cobertura das ${totFolha} folhas NCM: IPI=${cobIpi}, IBPT(SP)=${cobIbpt}`);
  await catalogPg.close();
}

main().catch((e) => { console.error('[impostos] ERRO:', e.message); process.exit(1); });
