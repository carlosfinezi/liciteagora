/**
 * nopecha-recognition.js — resolve o hCaptcha IMAGE challenge (grade 3x3) via a
 * NopeCHA *Recognition API* dirigindo o iframe do desafio na sessão real.
 *
 * Diferente da Token API: aqui a NopeCHA só CLASSIFICA as imagens (diz quais
 * quadros marcar) e NÓS clicamos no widget real → o token do hCaptcha nasce no
 * browser real (IP/rqdata corretos) e passa na validação enterprise do gov.br.
 *
 * Uso:
 *   const { solveHcaptcha } = require('./nopecha-recognition');
 *   const r = await solveHcaptcha(page, { key: NOPECHA_KEY, log, shot });
 *   // r.ok === true e input[type=password] apareceu quando resolveu.
 */
const https = require('https');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));

// ─── API HTTP ───────────────────────────────────────────────────────────────
function apiReq(method, apiPath, key, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.nopecha.com', path: apiPath, method,
      headers: Object.assign({ Authorization: 'Basic ' + key, Accept: 'application/json' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      timeout: 30000,
    }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: d.slice(0, 300) }); }); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (payload) req.write(payload); req.end();
  });
}

// Baixa uma imagem (URL pública do CDN do hCaptcha) e devolve data:URI base64.
// Feito no Node (não no browser) pra fugir de CORS/CSP do iframe do hCaptcha.
function fetchImageDataUri(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const ct = res.headers['content-type'] || 'image/jpeg';
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(`data:${ct};base64,${Buffer.concat(chunks).toString('base64')}`));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// POST recognition + poll. Devolve { ok, bools:[9] } ou { ok:false, error }.
async function recognize(key, question, dataUris) {
  const tasklist = dataUris.map((u, i) => ({ datapoint_uri: u, task_key: String(i) }));
  const sub = await apiReq('POST', '/v1/recognition/hcaptcha', key, {
    key,
    data: { request_type: 'image_label_binary', requester_question: { en: question }, tasklist },
  });
  if (sub.status === 402) return { ok: false, error: 'Recognition fora do plano (402)' };
  if (sub.status === 403) return { ok: false, error: 'sem crédito / IP banido (403)' };
  if (!sub.body || typeof sub.body.data !== 'string') return { ok: false, error: `submit HTTP ${sub.status} ${sub.body ? JSON.stringify(sub.body).slice(0, 140) : sub.raw}` };
  const id = sub.body.data;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await sleep(1200);
    const r = await apiReq('GET', `/v1/recognition/hcaptcha?id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`, key, null);
    if (r.status === 409) continue; // ainda processando
    if (r.body && Array.isArray(r.body.data)) {
      const flat = Array.isArray(r.body.data[0]) ? r.body.data[0] : r.body.data;
      return { ok: true, bools: flat.map((b) => !!b) };
    }
    if (r.body && (r.body.error || r.body.message)) return { ok: false, error: JSON.stringify(r.body.error || r.body.message) };
  }
  return { ok: false, error: 'timeout recognition 60s' };
}

// ─── DOM do desafio (iframe cross-origin, acessível via CDP/puppeteer) ────────
async function findChallengeFrame(page) {
  // o iframe do desafio (bframe) tem a grade; o do checkbox não.
  const frames = page.frames().filter((f) => /hcaptcha\.com/.test(f.url()));
  for (const f of frames) {
    const hasGrid = await f.$('.task-grid, .challenge-view .task-image, .task-image').then((h) => !!h).catch(() => false);
    if (hasGrid) return f;
  }
  return null;
}

async function readChallenge(frame) {
  return frame.evaluate(() => {
    const p = document.querySelector('.prompt-text, h2.prompt-text, .challenge-prompt .prompt-text, .challenge-prompt');
    const cells = Array.from(document.querySelectorAll('.task-image'));
    const urls = cells.map((c) => {
      const img = c.querySelector('.image') || c;
      const bg = img.style.backgroundImage || getComputedStyle(img).backgroundImage || '';
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      return m ? m[1] : null;
    });
    return { prompt: p ? p.textContent.trim() : null, urls };
  }).catch(() => null);
}

/**
 * Resolve o hCaptcha via recognition. Retorna { ok, solved, error }.
 * ok/solved === true quando input[type=password] aparece na página principal.
 */
async function solveHcaptcha(page, opts) {
  const { key, log = () => {}, shot = async () => {}, maxRounds = 5 } = opts;
  const passwordAppeared = () => page.evaluate(() => !!document.querySelector('input[type="password"]')).catch(() => false);

  for (let round = 0; round < maxRounds; round++) {
    // 1) espera o iframe do desafio com grade pronta (ou senha, se já resolveu)
    let frame = null, ch = null;
    for (let w = 0; w < 20; w++) {
      if (await passwordAppeared()) return { ok: true, solved: true };
      frame = await findChallengeFrame(page);
      if (frame) {
        ch = await readChallenge(frame);
        if (ch && ch.prompt && ch.urls.filter(Boolean).length >= 9) break;
      }
      await sleep(1000);
    }
    if (!frame || !ch || ch.urls.filter(Boolean).length < 9) {
      if (await passwordAppeared()) return { ok: true, solved: true };
      return { ok: false, error: `sem grade 3x3 pronta (round ${round + 1}) — challenge não-binário ou DOM mudou` };
    }

    // 2) baixa as 9 imagens → base64 (no Node, sem CORS)
    const uris = [];
    for (const u of ch.urls.slice(0, 9)) uris.push(await fetchImageDataUri(u));
    if (uris.filter(Boolean).length < 9) return { ok: false, error: `baixei só ${uris.filter(Boolean).length}/9 imagens do desafio` };

    // 3) recognition
    log(`  [rec] round ${round + 1}: "${ch.prompt}" → NopeCHA (${uris.length} imgs)...`);
    const rec = await recognize(key, ch.prompt, uris);
    if (!rec.ok) return { ok: false, error: 'recognition: ' + rec.error };
    log(`  [rec] marcar: ${rec.bools.map((b) => (b ? '■' : '·')).join('')}`);

    // 4) clica os quadros marcados no widget real
    const cells = await frame.$$('.task-image');
    for (let i = 0; i < cells.length && i < rec.bools.length; i++) {
      if (rec.bools[i]) { await cells[i].click().catch(() => {}); await sleep(rnd(140, 360)); }
    }
    await shot(page, `rec-round${round + 1}`);

    // 5) Verify / Next
    const btn = await frame.$('.button-submit, .challenge-actions .button-submit');
    if (btn) await btn.click().catch(() => {});
    await sleep(2500);

    // 6) resolveu? (senha apareceu). Senão, próxima rodada.
    if (await passwordAppeared()) return { ok: true, solved: true };
  }
  return { ok: false, error: `não resolveu em ${maxRounds} rounds` };
}

module.exports = { solveHcaptcha, recognize, fetchImageDataUri };
