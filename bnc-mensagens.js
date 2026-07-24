// bnc-mensagens.js
//
// Captura as mensagens da sala de disputa BNC e encaminha as relevantes ao
// Telegram (alertas). Duas seções vêm no modal:
//   - MENSAGENS DO PROCESSO — avisos do condutor/pregoeiro (prazos, anexos,
//     negociação). SEM remetente. São os alertas mais críticos (têm deadline).
//   - MENSAGENS DO LOTE — chat entre licitantes e o PREGOEIRO.
//
// Fonte: /BatchListParticipant/ParticipantBatchMessage?param1=<gkz>&param2=<gkz>.
// Os tokens [gkz] saem do mesmo ConvertBatchDataToViewModel usado pra descobrir
// o token de lance (o HTML estático não os traz na disputa viva).
//
// Escopo do alerta (baixo ruído): PROCESSO sempre + LOTE só do PREGOEIRO.
// A tagarelice dos demais participantes é gravada (dedup/histórico) mas NÃO
// vira alerta. Trocar _alertavel() pra encaminhar tudo é 1 linha.
//
// Anti-spam: no 1º ciclo de uma sala grava o histórico como já-notificado
// (backfill silencioso); só mensagens NOVAS a partir daí disparam Telegram.
// Espelha o padrão de sc-sync.js (robô SC).

'use strict';

const crypto = require('crypto');
const { bncFetch } = require('./bnc-client');
const { sendTelegram } = require('./telegram-client');

// Decodifica os escapes do JSON/HTML que o BNC devolve (aspas, < >, entidades
// numéricas &#199; e quebras) pra texto limpo.
function _dec(s) {
  return String(s)
    .replace(/\\u0027/g, "'")
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\"/g, '"')
    .replace(/&#(\d+);?/g, (m, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\\[nrt]/g, ' ');
}

// Busca o HTML do modal de mensagens a partir do payload UpdateStatus (com
// idBatch e os UUIDs). Retorna [{ bloco, horario, remetente, texto }].
async function buscarMensagens(db, data) {
  const r1 = await bncFetch(db, '/BatchList/ConvertBatchDataToViewModel', {
    method: 'POST',
    body: data,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json, text/javascript, */*; q=0.01' },
  });
  if (r1.status !== 200) throw new Error(`ConvertBatchDataToViewModel HTTP ${r1.status}`);
  const b1 = _dec(typeof r1.body === 'string' ? r1.body : JSON.stringify(r1.body));
  const m = b1.match(/'ParticipantBatchMessage'\s*,\s*\[\s*'(\[gkz\][^']+)'\s*,\s*'(\[gkz\][^']+)'/);
  if (!m) throw new Error('tokens ParticipantBatchMessage ausentes na resposta ConvertBatchDataToViewModel');

  const r2 = await bncFetch(db, '/BatchListParticipant/ParticipantBatchMessage?param1=' + encodeURIComponent(m[1]) + '&param2=' + encodeURIComponent(m[2]), {
    method: 'GET',
    headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (r2.status !== 200) throw new Error(`ParticipantBatchMessage HTTP ${r2.status}`);
  const html = _dec(typeof r2.body === 'string' ? r2.body : JSON.stringify(r2.body));
  return parseMensagens(html);
}

// Parseia os dois blocos do HTML. Cada linha de dados tem uma célula com
// DD/MM/AAAA HH:MM:SS; no LOTE há coluna de remetente, no PROCESSO não.
function parseMensagens(html) {
  const idxProc = html.indexOf('MENSAGENS DO PROCESSO');
  const loteHtml = idxProc >= 0 ? html.slice(0, idxProc) : html;
  const procHtml = idxProc >= 0 ? html.slice(idxProc) : '';
  const out = [];

  const parseBloco = (frag, bloco) => {
    for (const tr of frag.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
        .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      const hi = cells.findIndex((c) => /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}$/.test(c));
      if (hi < 0) continue;
      const horario = cells[hi];
      const resto = cells.slice(hi + 1).filter(Boolean);
      let remetente = null;
      let texto;
      if (bloco === 'LOTE' && resto.length >= 2) {
        remetente = resto[0];
        texto = resto.slice(1).join(' ');
      } else {
        texto = resto.join(' ');
      }
      texto = (texto || '').trim();
      if (!texto) continue;
      out.push({ bloco, horario, remetente, texto });
    }
  };

  parseBloco(loteHtml, 'LOTE');
  parseBloco(procHtml, 'PROCESSO');
  return out;
}

function _hash(salaId, m) {
  return crypto.createHash('sha1')
    .update(`${salaId}|${m.bloco}|${m.horario}|${m.remetente || ''}|${m.texto}`)
    .digest('hex');
}

// Escopo do alerta: PROCESSO sempre; LOTE só do PREGOEIRO.
function _alertavel(m) {
  if (m.bloco === 'PROCESSO') return true;
  return m.bloco === 'LOTE' && /PREGOEIRO/i.test(m.remetente || '');
}

function _formatar(row, processNumber) {
  const tag = row.bloco === 'PROCESSO' ? '🏛️ <b>PREGÃO — Condutor</b>' : '🗣️ <b>PREGÃO — Pregoeiro</b>';
  const cab = processNumber ? ` (${processNumber})` : '';
  const quem = row.remetente ? `\n<i>${row.remetente}</i>` : '';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `${tag}${cab}\n🕒 ${row.horario}${quem}\n${esc(row.texto)}`;
}

// Sincroniza mensagens de uma sala: dedup por hash + encaminha novas alertáveis
// ao Telegram. No 1º ciclo faz backfill silencioso. Nunca lança (best-effort).
async function sincronizarMensagens(db, { salaId, idBatch = null, processNumber = null }, data) {
  let msgs;
  try {
    msgs = await buscarMensagens(db, data);
  } catch (e) {
    return { erro: e.message, novas: 0, alertadas: 0 };
  }
  if (!msgs.length) return { novas: 0, alertadas: 0 };

  const primeiraVez = !db.prepare('SELECT 1 FROM bnc_dispute_mensagens WHERE salaId = ? LIMIT 1').get(salaId);
  const ins = db.prepare(`INSERT OR IGNORE INTO bnc_dispute_mensagens
      (salaId, idBatch, bloco, horario, remetente, texto, hash, notificadoTelegram, criadoEm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const now = new Date().toISOString();

  let novas = 0;
  const gravar = db.transaction(() => {
    for (const m of msgs) {
      // 1ª vez pra essa sala: backfill silencioso (notificado=1). Senão, entra
      // na fila (0) pra ser encaminhado abaixo.
      const notif = primeiraVez ? 1 : 0;
      const info = ins.run(salaId, idBatch, m.bloco, m.horario, m.remetente, m.texto, _hash(salaId, m), notif, now);
      if (info.changes) novas++;
    }
  });
  gravar();

  // Encaminha pendentes (só alertáveis; não-alertáveis são marcados como
  // tratados pra não reprocessar). Para na 1ª falha de envio → tenta no próximo
  // ciclo (não perde alerta por falha transitória do Telegram).
  let alertadas = 0;
  if (!primeiraVez) {
    const pend = db.prepare('SELECT * FROM bnc_dispute_mensagens WHERE salaId = ? AND notificadoTelegram = 0 ORDER BY id ASC').all(salaId);
    const marcar = db.prepare('UPDATE bnc_dispute_mensagens SET notificadoTelegram = 1 WHERE id = ?');
    for (const row of pend) {
      if (!_alertavel(row)) { marcar.run(row.id); continue; }
      const ok = await sendTelegram(db, _formatar(row, processNumber));
      if (!ok) break;
      marcar.run(row.id);
      alertadas++;
    }
  }
  return { novas, alertadas };
}

module.exports = { buscarMensagens, parseMensagens, sincronizarMensagens };
