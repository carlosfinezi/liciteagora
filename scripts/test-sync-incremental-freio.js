#!/usr/bin/env node
/**
 * test-sync-incremental-freio.js — prova os freios do sync incremental do PNCP.
 *
 * O QUE ISTO GUARDA (23-24/09/2026). Depois que a verificação de lacunas ganhou
 * cooldown, teto e parada no 429, a recomposição do catálogo continuou travada:
 * o dia 21/09 ficou com 285 de 1.575 pregões (18%) e 120 de 2.650 dispensas
 * (5%), a noite inteira, enquanto a varredura de 45 dias repetia
 * `0 licitações corrigidas`. A cota da API não sobrava para ela porque o
 * INCREMENTAL a consumia inteira, por três motivos:
 *
 * 1. CINCO RETRIES IMEDIATOS por página recusada. O comentário no código
 *    admitia: "sem backoff = retry imediato (incremental)". Com até 200 páginas
 *    por dia × 5 modalidades, a cada 5 minutos, isso vira milhares de chamadas
 *    contra uma API que já estava dizendo 429. O log de 23/09 acumulou 477
 *    respostas 429 e 478 timeouts.
 *
 * 2. SEM COOLDOWN. A rodada seguinte começava 5 minutos depois e reabria a
 *    pressão antes de a anterior aliviar, então o bloqueio nunca expirava.
 *
 * 3. PAGINAÇÃO SEMPRE DA PÁGINA 1. Com 4.780 licitações já gravadas em 22/09,
 *    eram ~95 páginas relidas para achar as que faltavam no fim — tudo
 *    regravado por cima (o UPSERT devolve `true` em update, então o log dizia
 *    "750 licitações" sem o catálogo crescer um registro).
 *
 * Uso: node scripts/test-sync-incremental-freio.js
 */

const path = require('path');
const BASE = path.resolve(__dirname, '..');
const express = require(BASE + '/node_modules/express');

let ok = 0, fail = 0;
const falhas = [];
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else {
    fail++; falhas.push(msg);
    console.error(`  ✗ ${msg}${extra !== undefined ? '\n      ' + JSON.stringify(extra).slice(0, 700) : ''}`);
  }
}

const api = {
  paginasPedidas: [],
  chamadas: 0,
  responder429apos: null,
  porPagina: 50,
  totalPaginas: 100,
};

(async () => {
  const app = express();
  app.get('/api/consulta/v1/contratacoes/:endpoint', (req, res) => {
    api.chamadas++;
    const pagina = Number(req.query.pagina || 1);
    api.paginasPedidas.push(pagina);
    if (api.responder429apos !== null && api.chamadas > api.responder429apos) {
      return res.status(429).json({ error: 'Too Many Requests' });
    }
    if (pagina > api.totalPaginas) return res.json({ data: [] });
    const dados = Array.from({ length: api.porPagina }, (_, i) => ({
      orgaoEntidade: { cnpj: '05067274000111' }, anoCompra: 2026,
      sequencialCompra: (pagina - 1) * api.porPagina + i + 1,
      numeroControlePNCP: `x-${pagina}-${i}`, modalidadeId: 6,
    }));
    res.json({ data: dados, totalRegistros: api.totalPaginas * api.porPagina });
  });
  const servidor = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const porta = servidor.address().port;

  require.cache[require.resolve(BASE + '/config.js')] = {
    id: require.resolve(BASE + '/config.js'), filename: require.resolve(BASE + '/config.js'),
    loaded: true, exports: {
      PNCP_API_BASE: `http://127.0.0.1:${porta}/api/consulta/v1`,
      PNCP_API_ITENS: `http://127.0.0.1:${porta}/api/pncp/v1`,
    },
  };

  const sync = require(BASE + '/pncp-sync-scheduler');

  // ── 1. o 429 aborta o dia em vez de render cinco tentativas ───────────────
  console.log('\n── parada no 429');
  {
    api.chamadas = 0; api.paginasPedidas.length = 0;
    api.responder429apos = 2;
    api.totalPaginas = 100;                  // a 3ª chamada já é recusada

    await sync.buscarLicitacoesDoDia('2026-09-21', 6);

    // Antes: 5 retries na página recusada, depois MAX_FALHAS_PAGINAS_SEGUIDAS=3
    // páginas seguidas com 5 retries cada = 15 chamadas recusadas por dia.
    assert(api.chamadas <= 4,
      `a busca para no primeiro 429 (foram ${api.chamadas} chamadas, antes seriam 15+)`,
      api.chamadas);
  }

  // ── 2. o salto de paginação ───────────────────────────────────────────────
  console.log('\n── por onde a busca começa');
  {
    api.chamadas = 0; api.paginasPedidas.length = 0; api.responder429apos = null;
    api.totalPaginas = 3;                      // acaba rápido, o foco é o início

    await sync.buscarLicitacoesDoDia('2026-09-22', 6, 'publicacao', { paginaInicial: 96 });
    assert(api.paginasPedidas[0] === 96,
      `com 4.780 já gravados, a busca entra na página 96 e não na 1 (entrou na ${api.paginasPedidas[0]})`,
      api.paginasPedidas.slice(0, 3));

    api.paginasPedidas.length = 0;
    await sync.buscarLicitacoesDoDia('2026-09-22', 6);
    assert(api.paginasPedidas[0] === 1,
      'sem o parâmetro, o comportamento antigo é preservado (página 1)',
      api.paginasPedidas.slice(0, 3));
  }

  // ── 3. a regra de "a API pediu para parar" é UMA só ───────────────────────
  console.log('\n── mesma regra nas duas rotinas');
  {
    const { eSinalDeExcesso } = require(BASE + '/verificacao-lacunas');
    assert(typeof eSinalDeExcesso === 'function',
      'o scheduler importa a regra da verificação em vez de duplicá-la');
    assert(eSinalDeExcesso({ response: { status: 429 } }) === true, '429 é sinal de excesso');
    assert(eSinalDeExcesso({ response: { status: 503 } }) === true, '503 também');
    assert(eSinalDeExcesso({ code: 'ECONNABORTED' }) === true,
      'e o timeout repetido, que é o mesmo recado sem status');
    assert(eSinalDeExcesso({ response: { status: 404 } }) === false,
      'mas 404 não é — esse é fim de paginação, não excesso');
  }

  servidor.close();
  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${ok} ok, ${fail} falha(s)`);
  if (fail) { falhas.forEach(x => console.error('   - ' + x)); process.exit(1); }
})().catch(e => { console.error('ERRO FATAL:', e); process.exit(1); });
