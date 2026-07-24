'use strict';
/**
 * bearer-health.js — Relatório de saúde do Bearer do govbr-bearer.service.
 * Analisa GAPS reais (token expirado antes da próxima entrega) a partir do
 * bearer_history do tenant + correlaciona com eventos de falha no
 * govbr-bearer.log. Zero-risco: só leitura.
 *
 * Uso:  node bearer-health.js [tenant] [horas]
 *   node bearer-health.js            → 1bit, últimas 24h
 *   node bearer-health.js 1bit 6     → 1bit, últimas 6h
 *   node bearer-health.js 1bit 24 json  → saída JSON
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TENANT = process.argv[2] || '1bit';
const HORAS = parseFloat(process.argv[3] || '24');
const JSON_OUT = process.argv[4] === 'json';
const LINE_OUT = process.argv[4] === 'line'; // saída compacta de 1 linha (p/ cron)
const DB = path.join(__dirname, 'data', 'tenants', TENANT, 'pncp.db');
const LOG = path.join(__dirname, 'govbr-bearer.log');

function fmtDur(s) {
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}min${r}s` : `${m}min`;
}

function main() {
  const desdeMs = Date.now() - HORAS * 3600 * 1000;
  const desdeISO = new Date(desdeMs).toISOString();
  const db = new Database(DB, { readonly: true });
  const rows = db.prepare(
    `SELECT recebidoEm, expEm, source, motivoRejeicao FROM bearer_history
      WHERE recebidoEm > ? ORDER BY recebidoEm ASC`
  ).all(desdeISO);
  db.close();

  // ── gaps: token expirou antes da próxima entrega ──
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const prevExp = rows[i - 1].expEm ? new Date(rows[i - 1].expEm).getTime() : null;
    const rec = new Date(rows[i].recebidoEm).getTime();
    if (prevExp && rec > prevExp) gaps.push({ inicio: rows[i - 1].expEm, fim: rows[i].recebidoEm, seg: (rec - prevExp) / 1000 });
  }

  // ── estado atual ──
  const ultima = rows[rows.length - 1];
  const agora = Date.now();
  let atual = { entregue: null, expEm: null, restanteSeg: null, valido: false };
  if (ultima) {
    const exp = ultima.expEm ? new Date(ultima.expEm).getTime() : 0;
    atual = { entregue: ultima.recebidoEm, expEm: ultima.expEm, restanteSeg: Math.round((exp - agora) / 1000), valido: exp > agora };
  }

  // ── uptime: fração do período com token válido (aproxima cobertura pelos intervalos [recebido, exp]) ──
  const janelaIni = Math.max(desdeMs, rows.length ? new Date(rows[0].recebidoEm).getTime() : desdeMs);
  const janelaFim = agora;
  const gapSegTotal = gaps.reduce((s, g) => s + g.seg, 0);
  const janelaSeg = (janelaFim - janelaIni) / 1000;
  const uptimePct = janelaSeg > 0 ? (100 * (1 - gapSegTotal / janelaSeg)) : 100;

  // ── eventos de falha no log (tail, best-effort — log tem HH:MM:SS sem data) ──
  let ev = { naoCapturado: 0, reauthFalhou: 0, solveEmperrou: 0, ctxDestroyed: 0, internalError: 0, connClosed: 0, restarts: 0 };
  try {
    const txt = fs.readFileSync(LOG, 'utf8');
    const tail = txt.slice(-400000); // ~últimas linhas
    ev.naoCapturado = (tail.match(/bearer não capturado/g) || []).length;
    ev.reauthFalhou = (tail.match(/reauth falhou/g) || []).length;
    ev.solveEmperrou = (tail.match(/solve emperrou/g) || []).length;
    ev.ctxDestroyed = (tail.match(/Execution context was destroyed/g) || []).length;
    ev.internalError = (tail.match(/Internal error/g) || []).length;
    ev.connClosed = (tail.match(/Connection closed/g) || []).length;
    ev.restarts = (tail.match(/govbr-bearer-service — tenant=/g) || []).length;
  } catch (e) {}

  const relatorio = {
    tenant: TENANT, janelaHoras: HORAS, geradoEm: new Date().toISOString(),
    entregas: rows.length,
    atual,
    gaps: gaps.map(g => ({ inicio: g.inicio, fim: g.fim, duracao: fmtDur(g.seg), seg: Math.round(g.seg) })),
    gapsTotal: gaps.length, gapSegTotal: Math.round(gapSegTotal),
    uptimePct: Number(uptimePct.toFixed(3)),
    eventosLog: ev,
  };

  if (JSON_OUT) { console.log(JSON.stringify(relatorio, null, 2)); return; }

  if (LINE_OUT) {
    const st = atual.valido ? `VALIDO ttl=${atual.restanteSeg}s` : `🔴EXPIRADO há ${fmtDur(-atual.restanteSeg)}`;
    const ult = gaps.length ? `ultimo-gap ${gaps[gaps.length - 1].inicio.slice(11, 19)}→${gaps[gaps.length - 1].fim.slice(11, 19)}(${fmtDur(gaps[gaps.length - 1].seg)})` : 'sem-gaps';
    console.log(`${new Date().toISOString()} | ${TENANT} | ${st} | ${HORAS}h: uptime=${relatorio.uptimePct}% gaps=${gaps.length} totalGap=${fmtDur(relatorio.gapSegTotal)} entregas=${rows.length} | ${ult}`);
    return;
  }

  const P = (...a) => console.log(...a);
  P(`\n════ SAÚDE DO BEARER — ${TENANT} (últimas ${HORAS}h) ════`);
  P(`gerado: ${relatorio.geradoEm}`);
  P(`\nESTADO ATUAL: ${atual.valido ? '🟢 VÁLIDO' : '🔴 SEM TOKEN VÁLIDO'}`);
  if (atual.entregue) P(`  última entrega: ${atual.entregue}  | expira: ${atual.expEm}  | restante: ${atual.valido ? fmtDur(atual.restanteSeg) : 'EXPIRADO há ' + fmtDur(-atual.restanteSeg)}`);
  P(`\nENTREGAS na janela: ${relatorio.entregas}`);
  P(`UPTIME (com token válido): ${relatorio.uptimePct}%   |   tempo total em gap: ${fmtDur(relatorio.gapSegTotal)}`);
  P(`\nGAPS (${relatorio.gapsTotal}):`);
  if (!gaps.length) P('  — nenhum gap na janela 🎉');
  else relatorio.gaps.forEach(g => P(`  🔴 ${g.inicio} → ${g.fim}  (${g.duracao})`));
  P(`\nEVENTOS DE FALHA no log (tail): bearer_não_capturado=${ev.naoCapturado}  reauth_falhou=${ev.reauthFalhou}  solve_emperrou=${ev.solveEmperrou}  ctx_destroyed=${ev.ctxDestroyed}  internal_error=${ev.internalError}  conn_closed=${ev.connClosed}  restarts=${ev.restarts}`);
  P('');
}

main();
