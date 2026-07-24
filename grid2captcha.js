/**
 * grid2captcha.js — resolve o hCaptcha via 2Captcha GridTask (worker HUMANO).
 * O worker vê a grade 3x3 + a imagem de referência + o enunciado e devolve QUAIS
 * quadros clicar. NÓS clicamos no widget real → solve in-page (mantém o PAT do
 * nosso browser). Diferente do token (HCaptchaTaskProxyless), que o gov.br rejeita.
 */
const https = require('https');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tc2Req(pathn, body) {
  return new Promise((resolve) => {
    const p = JSON.stringify(body);
    const req = https.request({ hostname: 'api.2captcha.com', path: pathn, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) }, timeout: 30000 },
      (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: r.statusCode, body: j, raw: d.slice(0, 300) }); }); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.write(p); req.end();
  });
}

// Localiza o frame do desafio (bframe com a grade).
async function findChallengeFrame(page) {
  const frames = page.frames().filter((f) => /hcaptcha\.com/.test(f.url()));
  for (const f of frames) {
    const hasGrid = await f.$('.task-grid, .challenge-view .task-image, .task-image').then((h) => !!h).catch(() => false);
    if (hasGrid) return f;
  }
  return null;
}

// Lê enunciado e tira screenshot da grade + referência (base64, sem prefixo).
async function readGrid(frame) {
  const prompt = await frame.evaluate(() => {
    const p = document.querySelector('.prompt-text, h2.prompt-text, .challenge-prompt .prompt-text, .challenge-prompt');
    return p ? p.textContent.trim() : null;
  }).catch(() => null);
  // grade 3x3
  let gridB64 = null;
  const gridEl = (await frame.$('.task-grid')) || (await frame.$('.challenge-view'));
  if (gridEl) gridB64 = await gridEl.screenshot({ encoding: 'base64' }).catch(() => null);
  // imagem de referência (exemplo no cabeçalho dos desafios difíceis)
  let refB64 = null;
  const refEl = (await frame.$('.challenge-example .image')) || (await frame.$('.challenge-example')) || (await frame.$('.example-image')) || (await frame.$('.prompt-image'));
  if (refEl) refB64 = await refEl.screenshot({ encoding: 'base64' }).catch(() => null);
  const nCells = await frame.$$eval('.task-image', (els) => els.length).catch(() => 0);
  return { prompt, gridB64, refB64, nCells };
}

// Resolve via GridTask. Devolve { ok, cells:[1..9] } (1-indexado) ou { ok:false }.
async function solveGrid2captcha(page, { key, log = () => {} }) {
  const frame = await findChallengeFrame(page);
  if (!frame) return { ok: false, error: 'sem frame de desafio' };
  // espera grade pronta
  let g = null;
  for (let i = 0; i < 15; i++) { g = await readGrid(frame); if (g.gridB64 && g.nCells >= 9 && g.prompt) break; await sleep(1000); }
  if (!g || !g.gridB64 || g.nCells < 9) return { ok: false, error: `grade não pronta (cells=${g ? g.nCells : 0})` };
  log(`  [grid] "${g.prompt}" ref=${g.refB64 ? 'sim' : 'não'} — enviando ao 2Captcha GridTask...`);
  const task = { type: 'GridTask', body: g.gridB64, comment: g.prompt || 'Select matching images', rows: 3, columns: 3, minClicks: 1 };
  if (g.refB64) task.imgInstructions = g.refB64;
  const c = await tc2Req('/createTask', { clientKey: key, task });
  if (!c.body || c.body.errorId) return { ok: false, error: `createTask: ${c.body ? c.body.errorCode : c.raw}` };
  const id = c.body.taskId; const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    await sleep(5000);
    const r = await tc2Req('/getTaskResult', { clientKey: key, taskId: id });
    if (r.body && r.body.status === 'ready') {
      const sol = r.body.solution || {};
      const cells = sol.click || sol.cells || (Array.isArray(sol) ? sol : null);
      if (Array.isArray(cells)) { log(`  [grid] resolvido em ${Math.round((Date.now() - t0) / 1000)}s → quadros ${JSON.stringify(cells)}`); return { ok: true, cells, frame }; }
      return { ok: false, error: 'solução sem click: ' + JSON.stringify(sol).slice(0, 120) };
    }
    if (r.body && r.body.errorId) return { ok: false, error: `getResult: ${r.body.errorCode}` };
  }
  return { ok: false, error: 'timeout 150s' };
}

// Clica os quadros (1-indexado), depois Verify/Avançar. Retorna true se clicou.
// Clique "humano": move o mouse por uma trajetória com passos + jitter até o centro
// do elemento, dá uma pausa curta e clica. O hCaptcha enterprise pontua o comportamento
// do mouse; um element.click() (teleporte CDP, sem trajetória) gera token de baixa
// confiança que o gov.br rejeita (ERL0000900). A trajetória eleva esse score.
let _mx = 12, _my = 12; // posição corrente do mouse (persistida entre cliques)
async function humanClick(page, handle) {
  const box = await handle.boundingBox().catch(() => null);
  if (!box) { await handle.click().catch(() => {}); return; }
  // alvo = centro com pequeno desvio aleatório (humano não acerta o pixel central)
  const tx = box.x + box.width * (0.35 + Math.random() * 0.3);
  const ty = box.y + box.height * (0.35 + Math.random() * 0.3);
  const steps = 14 + Math.floor(Math.random() * 12);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-in-out + jitter perpendicular → curva, não linha reta
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const jx = (Math.random() - 0.5) * 6 * Math.sin(t * Math.PI);
    const jy = (Math.random() - 0.5) * 6 * Math.sin(t * Math.PI);
    await page.mouse.move(_mx + (tx - _mx) * e + jx, _my + (ty - _my) * e + jy);
    await sleep(6 + Math.floor(Math.random() * 14));
  }
  await page.mouse.move(tx, ty);
  _mx = tx; _my = ty;
  await sleep(60 + Math.floor(Math.random() * 120)); // dwell antes de clicar
  await page.mouse.down(); await sleep(40 + Math.floor(Math.random() * 60)); await page.mouse.up();
}

async function clickCellsAndVerify(frame, cells, log = () => {}) {
  const page = frame.page();
  const tiles = await frame.$$('.task-image');
  let clicked = 0;
  for (const n of cells) {
    const idx = parseInt(n, 10) - 1;
    if (idx >= 0 && idx < tiles.length) { await humanClick(page, tiles[idx]); clicked++; await sleep(250 + Math.floor(Math.random() * 400)); }
  }
  await sleep(400 + Math.floor(Math.random() * 400));
  const btn = await frame.$('.button-submit, .challenge-actions .button-submit');
  if (btn) await humanClick(page, btn);
  log(`  [grid] cliquei ${clicked}/${cells.length} quadros + Verify`);
  return clicked > 0;
}

module.exports = { solveGrid2captcha, clickCellsAndVerify, findChallengeFrame };
