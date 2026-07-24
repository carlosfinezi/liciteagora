// pcp-datas.js
//
// Datas do PCP × datas do PNCP.
//
// O órgão pode remarcar/reabrir o processo dentro do Portal de Compras Públicas
// sem republicar no PNCP (visto no PE-000023/2026 de São Mateus: PNCP parado em
// 30/06 com encerramento 14/07, PCP remarcado pra 30/07). Como o catálogo
// espelha o PNCP, o prazo fica defasado em silêncio e o usuário descarta um
// edital que ainda está vivo.
//
// Consumidores:
//   - pcp-routes.js       → avisa na tela da proposta quando diverge
//   - pcp-monitor.js      → grava licitacoes.dataEncerramentoPortal (ciclo 6h)
//
// A API pública de detalhe do PCP não exige autenticação.

'use strict';

// A API pública usa o MESMO path do link do PNCP, trocando o host:
//   www.portaldecompraspublicas.com.br/processos/<path>
// → compras.api.portaldecompraspublicas.com.br/v2/licitacao/<path>
function apiDetalheUrl(link) {
  const m = /portaldecompraspublicas\.com\.br\/processos\/(.+?)\/?$/i.exec(String(link || '').trim());
  return m ? `https://compras.api.portaldecompraspublicas.com.br/v2/licitacao/${m[1]}` : null;
}

// Best-effort: qualquer falha (404, timeout, PCP fora do ar) devolve null e o
// chamador segue normalmente — isto é um extra, não pode derrubar tela nem ciclo.
async function fetchPcpDatas(link) {
  const url = apiDetalheUrl(link);
  if (!url) return null;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j) return null;
    return {
      abertura: j.dataHoraInicioRecebimentoPropostas || null,   // ↔ PNCP dataAberturaProposta
      encerramento: j.dataHoraFinalRecebimentoPropostas || null, // ↔ PNCP dataEncerramentoProposta
      sessao: j.dataHoraAbertura || null,                        // sem equivalente no PNCP
    };
  } catch (e) {
    console.error('[PCP datas] falha ao consultar detalhe:', e.message);
    return null;
  }
}

function fmtDataBR(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
}

// Divergência real = diferença >= 1 minuto (ignora ruído de segundos).
function divergem(a, b) {
  if (!a || !b) return false;
  const da = new Date(a), db = new Date(b);
  if (isNaN(da) || isNaN(db)) return false;
  return Math.abs(da.getTime() - db.getTime()) >= 60000;
}

// Compara as datas de proposta do catálogo (PNCP) com as do PCP.
// Devolve null quando não há o que comparar ou quando batem.
async function compararDatas(row) {
  const pcpDatas = await fetchPcpDatas(row.linkSistemaOrigem);
  if (!pcpDatas) return null;
  const abertura = divergem(row.dataAberturaProposta, pcpDatas.abertura);
  const encerramento = divergem(row.dataEncerramentoProposta, pcpDatas.encerramento);
  if (!abertura && !encerramento) return null;
  return {
    divergente: true,
    campos: { abertura, encerramento },
    pncp: {
      abertura: fmtDataBR(row.dataAberturaProposta),
      encerramento: fmtDataBR(row.dataEncerramentoProposta),
    },
    pcp: {
      abertura: fmtDataBR(pcpDatas.abertura),
      encerramento: fmtDataBR(pcpDatas.encerramento),
      sessao: fmtDataBR(pcpDatas.sessao),
    },
    // ISO cru — o monitor grava isto em licitacoes.dataEncerramentoPortal
    encerramentoPortalIso: pcpDatas.encerramento,
  };
}

module.exports = { apiDetalheUrl, fetchPcpDatas, fmtDataBR, divergem, compararDatas };
