// resync-itens-null.js (2026-05-29) — uso único
//
// Recupera os itens das licitações cujos itens foram corrompidos pelo bug do
// WAF do PNCP (push de string HTML → itens char-a-char, todos NULL).
// Ver memória project_bi_backfill_numeroitem_null.
//
// Lê a lista cnpj|ano|seq|modal|qtd de licitacoes-itens-null-20260529.txt,
// re-busca os itens no PNCP (via buscarItensLicitacao já corrigido) e regrava
// com salvarItensPg (DELETE + INSERT atômico por numeroControlePNCP).
//
// Delay anti-WAF entre licitações + retry com backoff (o WAF rebloqueia rajadas).
//
// Uso:
//   CATALOG_BACKEND_PG=1 node resync-itens-null.js --limit 2    # teste
//   CATALOG_BACKEND_PG=1 node resync-itens-null.js              # todas

'use strict';

const fs = require('fs');
const { buscarItensLicitacao } = require('./pncp-sync-scheduler');
const { salvarItensPg } = require('./licitacoes-persistence');
const catalogPg = require('./catalog-pg');

const LISTA = './licitacoes-itens-null-20260529.txt';
const DELAY_OK_MS = 1500;        // entre licitações bem-sucedidas
const RETRY_BACKOFF_MS = 8000;   // espera após bloqueio do WAF
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs() {
  const a = process.argv.slice(2);
  const i = a.indexOf('--limit');
  return { limit: i >= 0 ? parseInt(a[i + 1], 10) : Infinity };
}

// numeroControlePNCP no formato {cnpj}-1-{seq:06}/{ano}
async function getNumeroControle(cnpj, ano, seq) {
  const row = await catalogPg.queryOne(
    `SELECT "numeroControlePNCP" FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3 LIMIT 1`,
    [cnpj, Number(ano), Number(seq)]
  );
  return row ? row.numeroControlePNCP : null;
}

async function main() {
  const { limit } = parseArgs();
  const linhas = fs.readFileSync(LISTA, 'utf8').trim().split('\n').filter(Boolean);
  const alvos = linhas.slice(0, limit);
  console.log(`[resync] ${alvos.length} licitações a processar (de ${linhas.length} na lista)`);

  let ok = 0, vazio = 0, falha = 0, totalItens = 0;

  for (let idx = 0; idx < alvos.length; idx++) {
    const [cnpj, ano, seq] = alvos[idx].split('|');
    const tag = `${cnpj}/${ano}/${seq}`;

    const ncp = await getNumeroControle(cnpj, ano, seq);
    if (!ncp) {
      console.warn(`[resync] (${idx + 1}/${alvos.length}) ${tag}: licitação não encontrada no catálogo — pulando`);
      falha++;
      continue;
    }

    let itens = null;
    for (let tentativa = 1; tentativa <= MAX_RETRIES; tentativa++) {
      try {
        itens = await buscarItensLicitacao(cnpj, ano, seq);
        break; // sucesso (array, possivelmente vazio)
      } catch (err) {
        // buscarItensLicitacao já engole erro e retorna []; mas o guard anti-WAF
        // lança, e o catch interno dele converte pra []. Aqui é defesa extra.
        if (tentativa < MAX_RETRIES) {
          await sleep(RETRY_BACKOFF_MS * tentativa);
        }
      }
    }

    if (!Array.isArray(itens)) { falha++; await sleep(RETRY_BACKOFF_MS); continue; }

    if (itens.length === 0) {
      // Pode ser WAF (retornou [] após bloqueio) OU licitação realmente sem itens.
      // Re-tenta após backoff longo pra desambiguar.
      let recuperou = false;
      for (let t = 1; t <= MAX_RETRIES && !recuperou; t++) {
        await sleep(RETRY_BACKOFF_MS * t);
        const retry = await buscarItensLicitacao(cnpj, ano, seq);
        if (Array.isArray(retry) && retry.length > 0) { itens = retry; recuperou = true; }
      }
      if (!recuperou) {
        console.warn(`[resync] (${idx + 1}/${alvos.length}) ${tag}: 0 itens após ${MAX_RETRIES} retries (WAF ou sem itens)`);
        vazio++;
        await sleep(DELAY_OK_MS);
        continue;
      }
    }

    const salvou = await salvarItensPg(ncp, itens);
    if (salvou) {
      ok++; totalItens += itens.length;
      console.log(`[resync] (${idx + 1}/${alvos.length}) ${tag}: OK ${itens.length} itens`);
    } else {
      falha++;
      console.warn(`[resync] (${idx + 1}/${alvos.length}) ${tag}: falha ao salvar`);
    }
    await sleep(DELAY_OK_MS);
  }

  console.log(`[resync] FIM — ok=${ok} vazio=${vazio} falha=${falha} itensGravados=${totalItens}`);
  process.exit(0);
}

main().catch((e) => { console.error('[resync] fatal:', e); process.exit(1); });
