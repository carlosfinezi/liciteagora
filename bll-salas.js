// bll-salas.js
//
// CRUD de salas BLL (bllcompras.com) + descoberta de info via sessão
// autenticada do tenant (reusa bll-client.js). Porta de bnc-salas.js.
//
// API:
//   parseSalaUrl(url) → { processId, sParam2 }
//   descobrirInfo(db, processId, sParam2?) → { processNumber, title, statusName, pid, uid, lotes, rawHtmlLen }
//   cadastrarSala(db, { url, notas })
//   listarSalas(db, { ativo? })
//   getSala(db, idOrCompraId)
//   deletarSala(db, id) / setAtivo(db, id, ativo)
//
// ⚠️ DIFERENÇAS BLL vs BNC (confirmadas in-vivo 2026-06-29):
//   - Uid ROTACIONA a cada page-load → re-extrair sempre (scheduler busca fresh
//     antes de cada engine.start()). Pid (param1) é estável.
//   - O batchId [gkz] do lote (usado no PerformBid) NÃO está no HTML estático da
//     sala (lá só há o token do PROCESSO). Ele chega via SignalR (UpdateStatus)
//     ou ConvertBatchDataToViewModel. Logo descobrirInfo NÃO popula batchTokens
//     de lote de forma confiável — os lotes/tokens preenchem ao vivo no scheduler.

'use strict';

const { bllFetch } = require('./bll-client');

const BLL_HOST_RE = /bllcompras\.com$/i;

function parseSalaUrl(url) {
  if (!url || typeof url !== 'string') throw new Error('URL obrigatória');
  let normalizado = url.trim();
  if (!/^https?:\/\//i.test(normalizado)) {
    normalizado = 'https://' + normalizado.replace(/^\/+/, '');
  }
  let u;
  try { u = new URL(normalizado); } catch { throw new Error('URL inválida: ' + url); }
  if (!BLL_HOST_RE.test(u.hostname)) throw new Error('URL não é bllcompras.com: ' + u.hostname);
  if (!/\/BatchList/i.test(u.pathname)) throw new Error('URL não é de sala de disputa (esperado /BatchList): ' + u.pathname);
  const processId = u.searchParams.get('param1');
  const sParam2 = u.searchParams.get('param2') || '7';
  if (!processId || !processId.startsWith('[gkz]')) {
    throw new Error('param1 ausente ou não é token [gkz]');
  }
  return { processId, sParam2 };
}

function decodeQueryParam(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

// Decodifica entidades HTML (numéricas + nomeadas comuns) — o HTML da BLL manda
// o nome do órgão como "C&#194;MARA MUNICIPAL ... MIGUEL&#211;POLIS".
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

/**
 * GET autenticado em /BatchList e extrai Pid/Uid do $.connection.hub.qs +
 * processNumber/title/statusName do HTML.
 * Uid rotaciona — sempre re-extrair.
 */
async function descobrirInfo(db, processId, sParam2 = '7') {
  const r = await bllFetch(db, '/BatchList?param1=' + encodeURIComponent(processId) + '&param2=' + encodeURIComponent(sParam2), {
    method: 'GET',
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  if (r.status !== 200) throw new Error(`GET /BatchList HTTP ${r.status}`);
  const html = r.body || '';

  // $.connection.hub.qs = "Pid=<[gkz]>&Uid=<[gkz]>"
  const qsM = html.match(/\$\.connection\.hub\.qs\s*=\s*"([^"]+)"/);
  let pid = null, uid = null;
  if (qsM) {
    const qs = qsM[1];
    const pidM = qs.match(/Pid=([^&]+)/);
    const uidM = qs.match(/Uid=([^&]+)/);
    pid = pidM ? decodeQueryParam(pidM[1]) : null;
    uid = uidM ? decodeQueryParam(uidM[1]) : null;
  }

  // Lotes vêm de BatchList/PartialUnique?idProcess=&idStatus=&startingNumber=0
  // (descoberto in-vivo 2026-06-29). Cada <tr id="rowN"> tem células com id =
  // nome do campo (BatchNumber, Title, CurrentStatusName, WinnerBidderId,
  // WinnerBidValue) e o batchToken do FastBid no onclick. Iteramos os status
  // de fase relevantes e mergeamos por batchNumber.
  const lotesMap = new Map(); // batchNumber → lote
  for (const st of [7, 1, 6, 2, 3, 16, 40, 41]) {
    let pu;
    try {
      pu = await bllFetch(db, '/BatchList/PartialUnique?idProcess=' + encodeURIComponent(processId) + '&idStatus=' + st + '&startingNumber=0', {
        method: 'GET', headers: { Accept: 'text/html,*/*' },
      });
    } catch (e) { continue; }
    const ph = pu.body || '';
    if (/"modal"\s*:\s*"error"/.test(ph.trim().slice(0, 80))) continue; // status sem lotes
    parsePartialLotes(ph, lotesMap);
  }

  // processNumber + title do <title> (heurística: "<num> - <órgão> - BLLCOMPRAS")
  const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let processNumber = null, title = null;
  if (titleM) {
    const partes = titleM[1].trim().split(/\s*[-—]\s*/);
    if (partes.length && /^\d{4,}/.test(partes[0])) {
      processNumber = partes[0].trim();
      partes.shift();
    }
    if (partes[partes.length - 1] && /^BLL(COMPRAS)?$/i.test(partes[partes.length - 1].trim())) {
      partes.pop();
    }
    title = decodeEntidades(partes.join(' - ').trim()) || null;
  }

  let statusName = null;
  const statusM = html.match(/CurrentStatusName["\s:]+["']([^"']+)["']/);
  if (statusM) statusName = statusM[1];

  // Status da sala: se não veio do HTML, usa o do 1º lote em disputa
  if (!statusName) {
    const emDisputa = Array.from(lotesMap.values()).find(l => /DISPUTA/i.test(l.statusName || ''));
    if (emDisputa) statusName = emDisputa.statusName;
  }

  return {
    processNumber,
    title,
    statusName,
    pid: pid || processId,
    uid,
    lotes: Array.from(lotesMap.values()).sort((a, b) => (a.batchNumber || 0) - (b.batchNumber || 0)),
    rawHtmlLen: html.length,
  };
}

// Parseia as linhas de lote do HTML do PartialUnique/PartialPrimary. Cada
// <td id="CAMPO"> tem o valor da coluna; o batchToken sai do onclick do FastBid.
function parsePartialLotes(html, map) {
  const rows = html.match(/<tr[^>]*id="row\d+"[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const td = (id) => {
      const m = row.match(new RegExp('<td[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)<\\/td>', 'i'));
      return m ? m[1].replace(/<[^>]+>/g, '').replace(/&#\d+;|&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim() : null;
    };
    const batchNumber = td('BatchNumber') ? Number(td('BatchNumber')) : null;
    if (batchNumber == null || Number.isNaN(batchNumber)) continue;
    const fbM = row.match(/'FastBid'\s*,\s*\[\s*'(\[gkz\][^']+)'/);
    const bestStr = td('WinnerBidValue');
    const best = bestStr ? Number(bestStr.replace(/\./g, '').replace(',', '.')) : null;
    const prev = map.get(batchNumber) || {};
    map.set(batchNumber, {
      batchNumber,
      title: decodeEntidades(td('Title')) || prev.title || ('LOTE ' + batchNumber),
      statusName: td('CurrentStatusName') || prev.statusName || null,
      winnerBidderId: td('WinnerBidderId') || prev.winnerBidderId || null,
      currentBest: Number.isFinite(best) ? best : (prev.currentBest ?? null),
      batchTokenGkz: (fbM && fbM[1]) || prev.batchTokenGkz || null,
    });
  }
}

async function cadastrarSala(db, { url, notas }) {
  const { processId } = parseSalaUrl(url);
  const info = await descobrirInfo(db, processId);
  if (!info.uid) {
    throw new Error('Não consegui extrair Uid da página (precisa estar logado no BLL pelo Electron)');
  }

  const compraId = info.processNumber
    ? 'bll:' + info.processNumber
    : 'bll:' + Buffer.from(processId).toString('base64').slice(0, 20);
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT id FROM bll_salas WHERE compraId = ?').get(compraId);
  let salaId;
  if (existing) {
    db.prepare(`UPDATE bll_salas SET processId=?, uid=?, title=?, statusName=?, ativo=1, url=?, updatedAt=?, notas=COALESCE(?, notas) WHERE id=?`)
      .run(processId, info.uid, info.title, info.statusName, url, now, notas || null, existing.id);
    salaId = existing.id;
  } else {
    const r = db.prepare(`INSERT INTO bll_salas (compraId, processId, uid, processNumber, title, statusName, ativo, url, cadastradoEm, updatedAt, notas)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .run(compraId, processId, info.uid, info.processNumber, info.title, info.statusName, url, now, now, notas || null);
    salaId = r.lastInsertRowid;
  }

  // Lotes (best-effort; normalmente vazio no BLL — preenche via SignalR depois)
  const findLote = db.prepare(`SELECT id FROM bll_salas_lotes WHERE salaId=? AND batchNumber=?`);
  const insLote = db.prepare(`INSERT INTO bll_salas_lotes (salaId, batchTokenGkz, batchNumber, title, lastUpdate) VALUES (?, ?, ?, ?, ?)`);
  const updLote = db.prepare(`UPDATE bll_salas_lotes SET batchTokenGkz=?, lastUpdate=? WHERE salaId=? AND batchNumber=?`);
  let lotesInseridos = 0;
  for (const lote of info.lotes) {
    const ex = findLote.get(salaId, lote.batchNumber);
    if (ex) updLote.run(lote.batchTokenGkz, now, salaId, lote.batchNumber);
    else { insLote.run(salaId, lote.batchTokenGkz, lote.batchNumber, lote.title, now); lotesInseridos++; }
  }

  return { sala: getSala(db, salaId), lotesInseridos, lotesTotal: info.lotes.length };
}

function listarSalas(db, { ativo = null } = {}) {
  let sql = 'SELECT * FROM bll_salas';
  const params = [];
  if (ativo !== null) { sql += ' WHERE ativo = ?'; params.push(ativo ? 1 : 0); }
  sql += ' ORDER BY id DESC';
  const salas = db.prepare(sql).all(...params);
  const lotesStm = db.prepare('SELECT * FROM bll_salas_lotes WHERE salaId = ? ORDER BY batchNumber');
  return salas.map(s => ({ ...s, lotes: lotesStm.all(s.id) }));
}

function getSala(db, idOrCompraId) {
  const sala = typeof idOrCompraId === 'number'
    ? db.prepare('SELECT * FROM bll_salas WHERE id = ?').get(idOrCompraId)
    : db.prepare('SELECT * FROM bll_salas WHERE compraId = ?').get(idOrCompraId);
  if (!sala) return null;
  sala.lotes = db.prepare('SELECT * FROM bll_salas_lotes WHERE salaId = ? ORDER BY batchNumber').all(sala.id);
  return sala;
}

function deletarSala(db, id) {
  db.prepare('DELETE FROM bll_salas WHERE id = ?').run(id);
}

function setAtivo(db, id, ativo) {
  db.prepare('UPDATE bll_salas SET ativo = ?, updatedAt = ? WHERE id = ?')
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
