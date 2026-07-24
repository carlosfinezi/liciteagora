'use strict';

/**
 * portals/licitanet/index.js — Coletor de MARCA do Licitanet (Abordagem A do
 * PLANO_COLETOR_LICITANET.md). Roda dentro do Electron do cliente, cujo IP é
 * residencial — o `licitanet.com.br` bloqueia (403) o IP do servidor, mas não
 * o do cliente. O download+parse+gravação já é feito NO SERVIDOR; aqui só
 * geramos/descobrimos a URL do relatório "Extrato de Ata" (CloudFront) e a
 * devolvemos.
 *
 * Fluxo por ciclo:
 *   1) GET  /api/electron/licitanet/pendentes?limit=N          (fila do servidor)
 *   2) p/ cada pendente: janela OCULTA em https://licitanet.com.br/sessao/{processId}
 *      → executa 2 chamadas NO CONTEXTO DA PÁGINA (cookies/XSRF/fingerprint vão
 *        automáticos): POST /report/{processId} → {identifier};
 *                      GET  /report/{identifier}/download/2 → {url CloudFront}
 *   3) POST /api/electron/licitanet/ata { cnpj, ano, sequencial, ataUrl }
 *
 * Rate-limit do /report = 60/min → espaçamos ~1,5s entre processos.
 * NUNCA reconstruímos token: rodar in-page resolve XSRF/CSRF/fingerprint sozinho
 * (preferimos window.axios da SPA, que tem os interceptors; fallback = fetch com
 * X-XSRF-TOKEN lido do cookie).
 */

const { BrowserWindow } = require('electron');
const serverBridge = require('./server-bridge');

const SESSAO_URL = (processId) => `https://licitanet.com.br/sessao/${processId}`;
const LOOP_INTERVAL_MS = 15 * 60 * 1000; // ciclo completo a cada 15 min
const FIRST_RUN_DELAY_MS = 90 * 1000;    // espera o app assentar antes do 1º ciclo
const BATCH_LIMIT = 10;
const SPACING_MS = 1500;                 // entre processos (respeita 60/min do /report)
const NAV_TIMEOUT_MS = 30000;
const SPA_BOOT_WAIT_MS = 3500;           // deixa a SPA setar cookie XSRF + fingerprint
const COLLECT_TIMEOUT_MS = 25000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start({ ctx }) {
  if (!ctx) throw new Error('portals/licitanet: ctx obrigatório');
  const log = ctx.log;
  let stopped = false;
  let running = false;
  let win = null;
  let timer = null;

  serverBridge.init({ serverUrl: ctx.getServerUrl(), apiKey: ctx.getApiKey(), log });
  log('[Licitanet] Coletor de marca iniciado (Abordagem A — janela oculta, IP residencial)');

  function refreshAuth() {
    serverBridge.setServerUrl(ctx.getServerUrl());
    serverBridge.setApiKey(ctx.getApiKey());
  }

  function getWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: {
        partition: 'persist:licitanet',
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    // UA limpo (remove Electron/<ver>) — mesmo tratamento dos outros webviews.
    const ua = win.webContents.getUserAgent().replace(/Electron\/[\d.]+\s?/g, '').replace(/\s{2,}/g, ' ');
    win.webContents.setUserAgent(ua);
    win.on('closed', () => { win = null; });
    return win;
  }

  function navigate(w, url) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(t); w.webContents.removeListener('did-stop-loading', onStop); resolve(); };
      const onStop = () => finish();
      const t = setTimeout(finish, NAV_TIMEOUT_MS);
      w.webContents.on('did-stop-loading', onStop);
      // loadURL pode rejeitar com ERR_ABORTED em redirect de SPA — ignoramos.
      w.loadURL(url).catch(() => {});
    });
  }

  // Injeta o coletor no contexto da página e resulta em window.__licitanetResult.
  // Kick+poll (não retornamos promise direto: a página pode trocar o Promise
  // global, e o executeJavaScript só aguarda promise nativa — mesmo cuidado do
  // captcha-relay do BLL).
  function kick(w, processId) {
    const js = `(function(){
      window.__licitanetResult = null;
      (async function(){
        var diag = { step: 'start', href: location.href };
        try {
          function xsrf(){ var m = document.cookie.match(/XSRF-TOKEN=([^;]+)/); return m ? decodeURIComponent(m[1]) : null; }
          var hasAxios = (typeof window.axios !== 'undefined' && window.axios && typeof window.axios.post === 'function');
          diag.hasAxios = hasAxios; diag.hasXsrf = !!xsrf();
          var pid = ${JSON.stringify(String(processId))};

          // (1) gerar relatório Extrato de Ata
          diag.step = 'report';
          var identifier = null;
          if (hasAxios) {
            var r1 = await window.axios.post('/report/' + pid, { relatorio: 'RELATORIO_EXTRATO_ATA', dados: '' });
            diag.reportStatus = r1 && r1.status;
            identifier = r1 && r1.data && (r1.data.identifier || r1.data.id);
          } else {
            var f1 = await fetch('/report/' + pid, {
              method: 'POST', credentials: 'same-origin',
              headers: Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, xsrf() ? { 'X-XSRF-TOKEN': xsrf() } : {}),
              body: JSON.stringify({ relatorio: 'RELATORIO_EXTRATO_ATA', dados: '' })
            });
            diag.reportStatus = f1.status;
            var t1 = await f1.text(); diag.reportBody = t1.slice(0, 300);
            try { var j1 = JSON.parse(t1); identifier = j1 && (j1.identifier || j1.id); } catch(e){}
          }
          diag.identifier = identifier || null;
          if (!identifier) { window.__licitanetResult = { ok: false, error: 'sem identifier', diag: diag }; return; }

          // (2) resolver URL do CloudFront
          diag.step = 'download';
          var url = null;
          if (hasAxios) {
            var r2 = await window.axios.get('/report/' + identifier + '/download/2');
            diag.downloadStatus = r2 && r2.status;
            url = r2 && r2.data && (r2.data.url || (typeof r2.data === 'string' ? r2.data : null));
          } else {
            var f2 = await fetch('/report/' + identifier + '/download/2', {
              credentials: 'same-origin',
              headers: Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, xsrf() ? { 'X-XSRF-TOKEN': xsrf() } : {})
            });
            diag.downloadStatus = f2.status;
            var t2 = await f2.text(); diag.downloadBody = t2.slice(0, 300);
            try { var j2 = JSON.parse(t2); url = j2 && j2.url; } catch(e){}
          }
          diag.url = url || null;
          if (!url) { window.__licitanetResult = { ok: false, error: 'sem url', diag: diag }; return; }
          window.__licitanetResult = { ok: true, ataUrl: url, diag: diag };
        } catch (e) {
          diag.error = e && e.message ? e.message : String(e);
          window.__licitanetResult = { ok: false, error: diag.error, diag: diag };
        }
      })();
      return 'kicked';
    })();`;
    return w.webContents.executeJavaScript(js, true);
  }

  async function collectAtaUrl(w, processId) {
    await kick(w, processId);
    const deadline = Date.now() + COLLECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(400);
      let res = null;
      try { res = await w.webContents.executeJavaScript('window.__licitanetResult', true); } catch (e) { continue; }
      if (res) return res;
    }
    return { ok: false, error: `timeout ${COLLECT_TIMEOUT_MS}ms`, diag: null };
  }

  async function processarPendente(w, p) {
    const tag = `${p.cnpj}/${p.ano}/${p.sequencial} pid=${p.processId}`;
    if (!p.processId) { log(`[Licitanet] pulando (sem processId): ${tag}`); return; }
    await navigate(w, SESSAO_URL(p.processId));
    await sleep(SPA_BOOT_WAIT_MS);
    const res = await collectAtaUrl(w, p.processId);
    if (!res.ok) {
      const d = res.diag || {};
      log(`[Licitanet] ✗ ${tag} — ${res.error} (report=${d.reportStatus} download=${d.downloadStatus} axios=${d.hasAxios} xsrf=${d.hasXsrf})`);
      if (d.reportBody) log(`[Licitanet]   reportBody: ${d.reportBody}`);
      return;
    }
    log(`[Licitanet] ataUrl obtida ${tag} → ${res.ataUrl.slice(0, 80)}...`);
    try {
      const grav = await serverBridge.sendAta({ cnpj: p.cnpj, ano: p.ano, sequencial: p.sequencial, ataUrl: res.ataUrl });
      log(`[Licitanet] ✓ ${tag} — servidor gravou: itensAta=${grav.itensAta} mapeados=${grav.mapeados} gravados=${grav.gravados}`);
    } catch (e) {
      log(`[Licitanet] ✗ ${tag} — POST /ata falhou: ${e.message}`);
    }
  }

  async function runOnce() {
    if (stopped || running) return;
    if (!ctx.getApiKey()) { log('[Licitanet] sem apiKey ainda — aguardando próximo ciclo'); return; }
    running = true;
    refreshAuth();
    try {
      const pendentes = await serverBridge.fetchPendentes(BATCH_LIMIT);
      if (!pendentes.length) { log('[Licitanet] fila vazia — nada a coletar'); return; }
      log(`[Licitanet] ${pendentes.length} pendente(s) — coletando...`);
      const w = getWindow();
      for (const p of pendentes) {
        if (stopped) break;
        try { await processarPendente(w, p); }
        catch (e) { log(`[Licitanet] erro em ${p.processId}: ${e.message}`); serverBridge.reportError('licitanet-collector', e); }
        await sleep(SPACING_MS);
      }
    } catch (e) {
      log(`[Licitanet] ciclo falhou: ${e.message}`);
      serverBridge.reportError('licitanet-cycle', e);
    } finally {
      running = false;
    }
  }

  function schedule(delay) {
    if (stopped) return;
    timer = setTimeout(async () => { await runOnce(); schedule(LOOP_INTERVAL_MS); }, delay);
  }
  schedule(FIRST_RUN_DELAY_MS);

  return {
    runOnce,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (win && !win.isDestroyed()) win.close();
      win = null;
      log('[Licitanet] coletor parado');
    },
  };
}

module.exports = { name: 'licitanet', start };
