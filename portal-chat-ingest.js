// portal-chat-ingest.js
//
// Captura/persistência/notificação de chat GENÉRICA para portais que rodam a
// plataforma "batchScreenHub" (BLL e BNC — mesmo protocolo de mensagens).
// Fábrica: makeIngest({ portal, fetchFn, tabela, label }) → capturarChat.
//
// Protocolo (mapeado in-vivo 2026-08-05, idêntico em bllcompras.com e
// bnccompras.com):
//   POST /BatchList/GetMsgCountDetailedView?param1=<processId>&param2=
//        → escopos (LOTE N, PROCESSO) + tokens [gkz] dos botões de leitura.
//   GET  /BatchList/GetProcessMessageView?param1=<procToken>   (avisos sistema)
//   GET  /BatchList/GetBatchMessageView?param1=<batchToken>&param2=<procToken>
//        (chat do lote: Horário | Autor | Mensagem)
//
// Dedup por hash(salaId+escopo+dataHora+texto). seed=true grava histórico como
// já-notificado. Notificação individual por portal via chat-monitor-config
// (palavras-chave + Telegram próprios).

'use strict';

const crypto = require('crypto');
const cm = require('./chat-monitor-config');

function decodeEntidades(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function unwrap(bodyJsonOrHtml) {
  let html = bodyJsonOrHtml;
  try { const j = JSON.parse(bodyJsonOrHtml); if (j && typeof j.html === 'string') html = j.html; } catch { /* já é html */ }
  return String(html || '');
}

function tds(rowHtml) {
  return [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
    .map(m => decodeEntidades(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
}

const DT_RE = /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(:\d{2})?/;

function parseScopes(bodyJsonOrHtml) {
  const html = unwrap(bodyJsonOrHtml);
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const scopes = [];
  for (const row of rows) {
    const cells = tds(row);
    const label = (cells.find(c => /LOTE|PROCESSO/i.test(c)) || '').toUpperCase().replace(/\s+/g, ' ').trim();
    if (!label) continue;
    if (/GetProcessMessageView/i.test(row)) {
      const m = row.match(/GetProcessMessageView'\s*,\s*\[\s*'(\[gkz\][^']+)'/i);
      if (m) scopes.push({ escopo: label || 'PROCESSO', view: 'process', param1: m[1] });
    } else if (/GetBatchMessageView/i.test(row)) {
      const m = row.match(/GetBatchMessageView'\s*,\s*\[\s*\[\s*'(\[gkz\][^']+)'\s*\]\s*,\s*\[\s*'(\[gkz\][^']+)'/i);
      if (m) {
        const loteM = label.match(/LOTE\s+(\d+)/i);
        scopes.push({ escopo: label, view: 'batch', param1: m[1], param2: m[2], lote: loteM ? Number(loteM[1]) : null });
      }
    }
  }
  return scopes;
}

function parseProcessMessages(bodyJsonOrHtml) {
  const html = unwrap(bodyJsonOrHtml).replace(/<script[\s\S]*?<\/script>/gi, '');
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  for (const row of rows) {
    const cells = tds(row).filter(c => c !== '');
    const dt = cells.find(c => DT_RE.test(c));
    if (!dt) continue;
    const texto = cells.filter(c => c !== dt).join(' ').trim();
    if (texto) out.push({ autor: 'SISTEMA', dataHora: (dt.match(DT_RE) || [dt])[0], texto });
  }
  return out;
}

function parseBatchMessages(bodyJsonOrHtml) {
  const html = unwrap(bodyJsonOrHtml).replace(/<script[\s\S]*?<\/script>/gi, '');
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  for (const row of rows) {
    const cells = tds(row);
    if (cells.length < 3) continue;
    if (!DT_RE.test(cells[0])) continue;
    const dataHora = (cells[0].match(DT_RE) || [cells[0]])[0];
    const autor = cells[1] || '—';
    const texto = cells.slice(2).join(' ').trim();
    if (texto) out.push({ autor, dataHora, texto });
  }
  return out;
}

function hashMsg(salaId, escopo, dataHora, texto) {
  return crypto.createHash('sha1').update(`${salaId}|${escopo}|${dataHora}|${texto}`).digest('hex').slice(0, 16);
}

function escHtml(s) { return String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

function montarHtml(label, sala, m, palavras) {
  const orgao = decodeEntidades(sala.title || '') || sala.processNumber || `Sala ${label}`;
  let t =
    `💬 <b>Chat ${label} — ${escHtml(sala.processNumber || '')}</b>\n` +
    `🏛️ ${escHtml(orgao)}\n` +
    `📍 ${escHtml(m.escopo)}${m.autor ? ` · 👤 <b>${escHtml(m.autor)}</b>` : ''}\n` +
    `🕒 ${escHtml(m.dataHora || '')}\n` +
    `━━━━━━━━━━━━━━\n${escHtml(String(m.texto).slice(0, 900))}`;
  if (palavras && palavras.length) t += `\n🔔 <b>Palavras-chave:</b> ${escHtml(palavras.join(', '))}`;
  return t;
}

// Fábrica: liga o protocolo genérico a um portal concreto.
//   fetchFn(db, urlPath, opts) → { status, body }  (bllFetch / bncFetch)
//   tabela: nome da tabela de mensagens (bll_chat_mensagens / bnc_chat_mensagens)
function makeIngest({ portal, fetchFn, tabela, label }) {
  async function capturarChat(db, sala, { seed = false, log = () => {} } = {}) {
    const processId = sala.processId;
    if (!processId) return { novas: 0, notificadas: 0 };

    let scopes;
    try {
      const r = await fetchFn(db, '/BatchList/GetMsgCountDetailedView?param1=' + encodeURIComponent(processId) + '&param2=', {
        method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json,*/*' },
      });
      scopes = parseScopes(r.body || '');
    } catch (e) { log('chat: GetMsgCountDetailedView falhou:', e.message); return { novas: 0, notificadas: 0 }; }
    if (!scopes.length) return { novas: 0, notificadas: 0 };

    const mensagens = [];
    for (const sc of scopes) {
      try {
        let url, parse;
        if (sc.view === 'process') { url = '/BatchList/GetProcessMessageView?param1=' + encodeURIComponent(sc.param1); parse = parseProcessMessages; }
        else { url = '/BatchList/GetBatchMessageView?param1=' + encodeURIComponent(sc.param1) + '&param2=' + encodeURIComponent(sc.param2); parse = parseBatchMessages; }
        const r = await fetchFn(db, url, { method: 'GET', headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json,*/*' } });
        for (const m of parse(r.body || '')) mensagens.push({ ...m, escopo: sc.escopo, lote: sc.lote ?? null });
      } catch (e) { log(`chat: leitura ${sc.escopo} falhou:`, e.message); }
    }

    const ins = db.prepare(`INSERT OR IGNORE INTO ${tabela}
      (salaId, processId, escopo, lote, autor, texto, dataHora, hash, notificado, criadoEm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    const novasParaNotificar = [];
    const tx = db.transaction((msgs) => {
      for (const m of msgs) {
        const h = hashMsg(sala.id, m.escopo, m.dataHora, m.texto);
        const res = ins.run(sala.id, processId, m.escopo, m.lote, m.autor, m.texto, m.dataHora, h, seed ? 1 : 0, now);
        if (res.changes > 0 && !seed) novasParaNotificar.push({ ...m, hash: h });
      }
    });
    tx(mensagens);

    let notificadas = 0;
    if (!seed && novasParaNotificar.length) {
      for (const m of novasParaNotificar) {
        const dec = cm.shouldNotify(db, portal, m.texto);
        let enviado = false;
        if (dec.notify) enviado = await cm.enviarTelegram(db, portal, montarHtml(label, sala, m, dec.palavras));
        const flag = enviado ? 1 : (dec.notify ? 0 : 1);
        db.prepare(`UPDATE ${tabela} SET notificado=? WHERE salaId=? AND hash=?`).run(flag, sala.id, m.hash);
        if (enviado) notificadas++;
      }
    }
    if (novasParaNotificar.length || seed) log(`chat: ${mensagens.length} lidas, ${novasParaNotificar.length} novas${seed ? ' (seed)' : `, ${notificadas} notificadas`}`);
    return { novas: novasParaNotificar.length, notificadas };
  }
  return capturarChat;
}

module.exports = { makeIngest, parseScopes, parseProcessMessages, parseBatchMessages, decodeEntidades };
