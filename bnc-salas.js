// bnc-salas.js
//
// CRUD de salas BNC (bnccompras.com) + descoberta de info via sessão
// autenticada do tenant (reusa bnc-client.js).
//
// API:
//   parseSalaUrl(url) → { processId, sParam2 }      — parse query string
//   descobrirInfo(db, processId)                    — GET /BatchList autenticado
//     → { processNumber, title, statusName, uid, lotes: [{idBatchUuid?, batchTokenGkz, batchNumber?, title?}], rawHtmlLen }
//   cadastrarSala(db, { url, notas })               — pipeline completo + INSERT
//   listarSalas(db, { ativo? })
//   getSala(db, idOrCompraId)
//   deletarSala(db, id)
//   atualizarStatus(db, id, statusName)
//
// Caveat dos tokens [gkz]:
//   - processId/Pid: parseado da URL pública (cliente cola)
//   - uid: lido do HTML da sala (var $.connection.hub.qs="Pid=...&Uid=...")
//   - batchTokenGkz: parseado dos onclick="doAction(...,'FastBid', ['[gkz]<X>', '1'])"
//   - Tokens são dinâmicos. Re-extrair quando necessário.

'use strict';

const { bncFetch } = require('./bnc-client');

/**
 * Parse URL pública da sala BNC.
 * Aceita formatos típicos:
 *   https://bnccompras.com/BatchList?param1=[gkz]<...>&param2=7
 *   bnccompras.com/BatchList?param1=...
 * Retorna { processId, sParam2 }
 */
function parseSalaUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('URL obrigatória');
  }
  // Normaliza: garante https://
  let normalizado = url.trim();
  if (!/^https?:\/\//i.test(normalizado)) {
    normalizado = 'https://' + normalizado.replace(/^\/+/, '');
  }
  let u;
  try { u = new URL(normalizado); } catch { throw new Error('URL inválida: ' + url); }
  if (!/bnccompras\.com$/i.test(u.hostname)) {
    throw new Error('URL não é bnccompras.com: ' + u.hostname);
  }
  if (!/\/BatchList/i.test(u.pathname)) {
    throw new Error('URL não é de sala de disputa (esperado /BatchList): ' + u.pathname);
  }
  const processId = u.searchParams.get('param1');
  const sParam2 = u.searchParams.get('param2') || '7';
  if (!processId || !processId.startsWith('[gkz]')) {
    throw new Error('param1 ausente ou não é token [gkz]');
  }
  return { processId, sParam2 };
}

/**
 * Faz GET autenticado em /BatchList e extrai:
 *   - processNumber  (do title da página ou texto)
 *   - title          (nome do órgão/processo)
 *   - statusName     (DISPUTA, AGUARDANDO DISPUTA, etc.)
 *   - uid            (token [gkz] do user logado, da var $.connection.hub.qs)
 *   - lotes          (tokens [gkz] dos FastBid buttons)
 */
async function descobrirInfo(db, processId, sParam2 = '7') {
  const r = await bncFetch(db, '/BatchList?param1=' + encodeURIComponent(processId) + '&param2=' + encodeURIComponent(sParam2), {
    method: 'GET',
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  if (r.status !== 200) throw new Error(`GET /BatchList HTTP ${r.status}`);
  const html = r.body || '';

  // ─── Uid (do query string do SignalR hub)
  // $.connection.hub.qs = "Pid=...&Uid=[gkz]<token>"
  const uidM = html.match(/\$\.connection\.hub\.qs\s*=\s*"[^"]*Uid=([^"&]+)"/);
  const uid = uidM ? decodeQueryParam(uidM[1]) : null;

  // ─── Lotes (botão FastBid de cada lote)
  // onclick="doAction(false,'GET','BatchListParticipant','FastBid', ['[gkz]<batchToken>', '1']);"
  const loteTokens = new Set();
  const reFB = /'FastBid'\s*,\s*\[\s*'(\[gkz\][^']+)'\s*,\s*'(\d+)'\s*\]/g;
  let m;
  while ((m = reFB.exec(html)) !== null) {
    loteTokens.add(m[1]);
  }

  // ─── ProcessNumber + title (do <title>)
  // Formato típico: "000000332026 - FESURV - UNIVERSIDADE DE RIO VERDE - BNC"
  // Estratégia: split em " - ", primeira parte que vira número = processNumber;
  // o resto (menos o sufixo "BNC" final, se houver) = title.
  const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let processNumber = null;
  let title = null;
  if (titleM) {
    const partes = titleM[1].trim().split(/\s*[-—]\s*/);
    // processNumber é a 1ª parte quando é toda numérica: aceita "000000332026"
    // e também "003/2026" (formato NNN/AAAA). Começa e termina em dígito, só
    // dígitos/barra/ponto/traço no meio.
    if (partes.length && /^\d[\d/.\-]*\d$/.test(partes[0].trim())) {
      processNumber = partes[0].trim();
      partes.shift();
    }
    // remove sufixo "BNC" se aparecer
    if (partes[partes.length - 1] && /^BNC$/i.test(partes[partes.length - 1].trim())) {
      partes.pop();
    }
    title = partes.join(' - ').trim() || null;
  }

  // ─── Status (procurar "CurrentStatusName" ou heurística)
  // Pode vir só pelo SignalR — deixar null se não achar
  let statusName = null;
  const statusM = html.match(/CurrentStatusName["\s:]+["']([^"']+)["']/);
  if (statusM) statusName = statusM[1];

  return {
    processNumber,
    title,
    statusName,
    uid,
    lotes: Array.from(loteTokens).map((tokenGkz, idx) => ({
      batchTokenGkz: tokenGkz,
      batchNumber: idx + 1,  // ordem de aparição (heurística — pode falhar multi-lote)
      title: `LOTE ${idx + 1}`,
    })),
    rawHtmlLen: html.length,
  };
}

function decodeQueryParam(s) {
  // O HTML escapa certos chars; aqui só tira HTML entity se houver
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

/**
 * Pipeline completo: parse URL → descobre info autenticado → INSERT.
 * Retorna { sala, lotesInseridos }.
 */
async function cadastrarSala(db, { url, notas }) {
  const { processId } = parseSalaUrl(url);
  const info = await descobrirInfo(db, processId);
  if (!info.uid) {
    throw new Error('Não consegui extrair Uid da página (precisa estar logado no BNC pelo Electron)');
  }

  const compraId = info.processNumber
    ? 'bnc:' + info.processNumber
    : 'bnc:' + Buffer.from(processId).toString('base64').slice(0, 20);
  const now = new Date().toISOString();

  // upsert (se já existe, atualiza tokens e marca ativo)
  const existing = db.prepare('SELECT id FROM bnc_salas WHERE compraId = ?').get(compraId);
  let salaId;
  if (existing) {
    db.prepare(`UPDATE bnc_salas SET processId=?, uid=?, title=?, statusName=?, ativo=1, url=?, updatedAt=?, notas=COALESCE(?, notas) WHERE id=?`)
      .run(processId, info.uid, info.title, info.statusName, url, now, notas || null, existing.id);
    salaId = existing.id;
  } else {
    const r = db.prepare(`INSERT INTO bnc_salas (compraId, processId, uid, processNumber, title, statusName, ativo, url, cadastradoEm, updatedAt, notas)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .run(compraId, processId, info.uid, info.processNumber, info.title, info.statusName, url, now, now, notas || null);
    salaId = r.lastInsertRowid;
  }

  // upsert dos lotes (por batchTokenGkz, único por sala)
  const insLote = db.prepare(`INSERT INTO bnc_salas_lotes (salaId, batchTokenGkz, batchNumber, title, lastUpdate)
    VALUES (?, ?, ?, ?, ?)`);
  const updLote = db.prepare(`UPDATE bnc_salas_lotes SET batchTokenGkz=?, lastUpdate=? WHERE salaId=? AND batchNumber=?`);
  const findLote = db.prepare(`SELECT id FROM bnc_salas_lotes WHERE salaId=? AND batchNumber=?`);
  let lotesInseridos = 0;
  for (const lote of info.lotes) {
    const existing = findLote.get(salaId, lote.batchNumber);
    if (existing) {
      updLote.run(lote.batchTokenGkz, now, salaId, lote.batchNumber);
    } else {
      insLote.run(salaId, lote.batchTokenGkz, lote.batchNumber, lote.title, now);
      lotesInseridos++;
    }
  }

  return {
    sala: getSala(db, salaId),
    lotesInseridos,
    lotesTotal: info.lotes.length,
  };
}

function listarSalas(db, { ativo = null } = {}) {
  let sql = 'SELECT * FROM bnc_salas';
  const params = [];
  if (ativo !== null) {
    sql += ' WHERE ativo = ?';
    params.push(ativo ? 1 : 0);
  }
  sql += ' ORDER BY id DESC';
  const salas = db.prepare(sql).all(...params);
  // Anexa lotes
  const lotesStm = db.prepare('SELECT * FROM bnc_salas_lotes WHERE salaId = ? ORDER BY batchNumber');
  return salas.map(s => ({ ...s, lotes: lotesStm.all(s.id) }));
}

function getSala(db, idOrCompraId) {
  const sala = typeof idOrCompraId === 'number'
    ? db.prepare('SELECT * FROM bnc_salas WHERE id = ?').get(idOrCompraId)
    : db.prepare('SELECT * FROM bnc_salas WHERE compraId = ?').get(idOrCompraId);
  if (!sala) return null;
  sala.lotes = db.prepare('SELECT * FROM bnc_salas_lotes WHERE salaId = ? ORDER BY batchNumber').all(sala.id);
  return sala;
}

function deletarSala(db, id) {
  db.prepare('DELETE FROM bnc_salas WHERE id = ?').run(id);
}

function setAtivo(db, id, ativo) {
  db.prepare('UPDATE bnc_salas SET ativo = ?, updatedAt = ? WHERE id = ?')
    .run(ativo ? 1 : 0, new Date().toISOString(), id);
}

module.exports = {
  parseSalaUrl,
  descobrirInfo,
  cadastrarSala,
  listarSalas,
  getSala,
  deletarSala,
  setAtivo,
};
