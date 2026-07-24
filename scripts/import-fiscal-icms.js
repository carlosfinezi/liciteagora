#!/usr/bin/env node
// import-fiscal-icms.js (2026-07-10)
//
// ICMS — alíquota INTERNA por UF (27 estados). Fonte de comunidade atualizada 2026:
//   github.com/LuckbrjDev/calculadora-icms-2026 → matriz 27×27 origem×destino no app.js;
//   alíquota interna = diagonal valores[i][i].
//
// RESSALVA: os valores já vêm com o FCP/FECP EMBUTIDO (ex.: RJ 22 = 20 + 2% FCP) e
// não desmembrado. Gravamos fcp_incluido=true; a UI sinaliza. Revisar semestralmente
// (dado pequeno e semi-estático; alterações de alíquota interna são por lei estadual).
//
//   sudo -u carlosfinezi node scripts/import-fiscal-icms.js

'use strict';

const catalogPg = require('../catalog-pg');

const URL_APP = 'https://raw.githubusercontent.com/LuckbrjDev/calculadora-icms-2026/HEAD/app.js';

async function baixarTexto(url) {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} em ${url}`);
  return resp.text();
}

// extrai a diagonal (alíquota interna) dos literais `ufs` e `valores` do app.js
function extrairDiagonal(src) {
  const ufsM = src.match(/const\s+ufs\s*=\s*(\[[^\]]*\])/);
  const valM = src.match(/const\s+valores\s*=\s*(\[[\s\S]*?\]\s*\])/);
  if (!ufsM || !valM) throw new Error('arrays ufs/valores não encontrados no app.js (layout mudou)');
  // literais só com números e strings entre aspas — eval seguro sobre o trecho isolado
  const ufs = eval(ufsM[1]); // eslint-disable-line no-eval
  const valores = eval(valM[1]); // eslint-disable-line no-eval
  if (!Array.isArray(ufs) || ufs.length !== 27) throw new Error(`ufs inesperado (${ufs.length})`);
  return ufs.map((uf, i) => ({ uf, aliquota: Number(valores[i][i]) }));
}

async function main() {
  console.log('[icms] baixando tabela de alíquotas...');
  const linhas = extrairDiagonal(await baixarTexto(URL_APP));
  console.log(`[icms] ${linhas.length} UFs · SP=${linhas.find((l) => l.uf === 'SP').aliquota} PA=${linhas.find((l) => l.uf === 'PA').aliquota}`);

  if (linhas.length !== 27 || linhas.some((l) => !(l.aliquota >= 7 && l.aliquota <= 30))) {
    throw new Error('alíquotas fora da faixa esperada (7–30%) — abortando');
  }

  await catalogPg.withTx(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS fiscal_icms_uf (
        uf TEXT PRIMARY KEY,
        aliquota_interna NUMERIC NOT NULL,
        fcp_incluido BOOLEAN NOT NULL DEFAULT true,
        fonte TEXT,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query('TRUNCATE fiscal_icms_uf');
    for (const l of linhas) {
      await client.query(
        `INSERT INTO fiscal_icms_uf (uf, aliquota_interna, fcp_incluido, fonte)
         VALUES ($1, $2, true, $3)`,
        [l.uf, l.aliquota, 'LuckbrjDev/calculadora-icms-2026 (FCP embutido)']
      );
    }
  });

  const [{ n }] = await catalogPg.query('SELECT count(*)::int n FROM fiscal_icms_uf');
  console.log(`[icms] gravado: fiscal_icms_uf=${n}`);
  await catalogPg.close();
}

main().catch((e) => { console.error('[icms] ERRO:', e.message); process.exit(1); });
