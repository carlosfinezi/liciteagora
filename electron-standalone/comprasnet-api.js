// comprasnet-api.js — Chamadas à API Comprasnet via Node.js https (sem CORS)
'use strict';

const https = require('https');

const COMPRASNET = 'https://cnetmobile.estaleiro.serpro.gov.br';
const HEADERS_BASE = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'x-device-platform': 'web',
  'x-version-number': '6.0.0',
  'Cache-Control': 'no-cache',
};

// Referências externas
// _wv = webviewContents do webview Comprasnet. Usado por antiIdle() e por
// wvFetchJSON() — fetch executado no contexto do navegador (carrega cookies
// de sessão + Origin/Referer corretos), evitando o 204 que o /participacoes
// devolve quando chamado via Node https direto sem captcha.
let _wv = null;
let _getBearer = null;

function init(webviewContents, getBearerFn) {
  _wv = webviewContents;
  _getBearer = getBearerFn;
}

function wv() {
  if (!_wv) throw new Error('Webview não disponível');
  return _wv;
}

function bearer() {
  const b = _getBearer ? _getBearer() : null;
  if (!b) throw new Error('Bearer não disponível');
  return b;
}

// ─── Fetch genérico via Node.js https (sem CORS) ────────────────────────────

async function comprasnetFetch(method, apiPath, body, timeoutMs = 30000) {
  const b = bearer();
  return new Promise((resolve) => {
    const url = new URL(apiPath, COMPRASNET);
    const headers = { ...HEADERS_BASE, Authorization: b };
    if (body) {
      headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    }
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: timeoutMs,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
        } catch {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
        }
      });
    });
    req.on('error', e => resolve({ ok: false, status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function comprasnetGet(apiPath, timeoutMs = 30000) {
  return comprasnetFetch('GET', apiPath, null, timeoutMs);
}

async function comprasnetPost(apiPath, body, timeoutMs = 15000) {
  return comprasnetFetch('POST', apiPath, body, timeoutMs);
}

async function comprasnetPut(apiPath, body = null, timeoutMs = 10000) {
  return comprasnetFetch('PUT', apiPath, body, timeoutMs);
}

async function comprasnetDelete(apiPath, timeoutMs = 10000) {
  return comprasnetFetch('DELETE', apiPath, null, timeoutMs);
}

// ─── API específicas do Comprasnet ──────────────────────────────────────────

async function datahorabrasilia() {
  return comprasnetGet('/comprasnet-disputa/v1/datahorabrasilia');
}

async function sessaoFornecedor() {
  return comprasnetGet('/comprasnet-usuario/v2/sessao/fornecedor');
}

// ─── Participações (paginado, multi-filtro) ─────────────────────────────────

// GET via executeJavaScript no webview Comprasnet. Carrega cookies de sessão,
// Origin/Referer corretos e TLS fingerprint Chromium — o servidor SERPRO
// trata como request do navegador real e retorna o payload, ao contrário do
// https direto que devolve HTTP 204 sem captcha-token. Mesma assinatura de
// retorno do comprasnetGet ({ ok, status, data }).
async function wvFetchJSON(apiPath, timeoutMs = 20000) {
  if (!_wv) return { ok: false, status: 0, error: 'Webview não disponível' };
  let b;
  try { b = bearer(); } catch (e) { return { ok: false, status: 0, error: e.message }; }
  const url = COMPRASNET + apiPath;
  const js = `
    (async () => {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), ${timeoutMs});
        const r = await fetch(${JSON.stringify(url)}, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Authorization': ${JSON.stringify(b)},
            'x-device-platform': 'web',
            'x-version-number': '6.0.0',
            'Cache-Control': 'no-cache',
          },
          signal: ctrl.signal,
        });
        clearTimeout(tid);
        const status = r.status;
        const text = await r.text();
        let data = null;
        if (text) {
          const ct = (r.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('json')) {
            try { data = JSON.parse(text); } catch { data = text; }
          } else {
            data = text;
          }
        }
        return { ok: status >= 200 && status < 300, status, data };
      } catch (e) {
        return { ok: false, status: 0, error: e && e.message ? e.message : String(e) };
      }
    })()
  `;
  try {
    return await _wv.executeJavaScript(js, true);
  } catch (e) {
    return { ok: false, status: 0, error: 'executeJavaScript: ' + e.message };
  }
}

async function fetchParticipacoes(filtros = [5, 4, 3]) {
  const todas = [];
  const seen = new Set();

  for (const filtro of filtros) {
    let pagina = 0;
    while (true) {
      const r = await wvFetchJSON(
        `/comprasnet-fase-externa/v1/compras/participacoes?filtro=${filtro}&tamanhoPagina=50&pagina=${pagina}`
      );
      if (!r.ok || !Array.isArray(r.data)) break;

      for (const p of r.data) {
        const id = p.compraId || p.id;
        if (id && !seen.has(id)) {
          seen.add(id);
          p._filtro = filtro;
          todas.push(p);
        }
      }

      if (r.data.length < 50) break;
      pagina++;
    }
  }

  return todas;
}

// ─── Mensagens por compra (paginado) ────────────────────────────────────────

async function fetchMensagens(compraId) {
  const todas = [];
  let page = 0;

  while (true) {
    const r = await comprasnetGet(
      `/comprasnet-mensagem/v2/chat/${compraId}?size=50&page=${page}&legadoAsp=false`
    );
    if (!r.ok || !Array.isArray(r.data)) break;
    todas.push(...r.data);
    if (r.data.length < 50) break;
    page++;
  }

  return todas;
}

// ─── Mensagens globais via API v1 (todas do usuário) ────────────────────────

async function fetchMensagensGlobal() {
  const todas = [];
  let page = 0;

  while (true) {
    const r = await comprasnetGet(
      `/comprasnet-mensagem/v1/mensagens?size=50&page=${page}`
    );
    // API retorna 206 Partial Content com paginação
    if ((r.ok || r.status === 206) && Array.isArray(r.data) && r.data.length > 0) {
      todas.push(...r.data);
      if (r.data.length < 50) break;
      page++;
    } else {
      if (page === 0 && !r.ok && r.status !== 206) {
        return { ok: false, mensagens: [], error: r.status };
      }
      break;
    }
  }

  return { ok: true, mensagens: todas };
}

async function fetchMensagensGlobalPage0() {
  const r = await comprasnetGet('/comprasnet-mensagem/v1/mensagens?size=50&page=0');
  if ((r.ok || r.status === 206) && Array.isArray(r.data)) {
    return { ok: true, mensagens: r.data };
  }
  return { ok: false, mensagens: [], error: r.status };
}

// ─── Itens de disputa (estratégia multi-endpoint) ───────────────────────────

async function fetchItensCompra(compraId, autoCompraIds = []) {
  // 1. Detectar fase
  const qtdes = await comprasnetGet(`/comprasnet-disputa/v1/compras/${compraId}/itens/qtdes`);
  if (!qtdes.ok) {
    // SNIPER-H04: propagar 401/403 — caller decide rotear para reautenticar
    if (qtdes.status === 401 || qtdes.status === 403) {
      return { itens: [], fase: 'auth-error', stub: true, authError: true, status: qtdes.status };
    }
    // Fallback: buscar itens genéricos
    const fallback = await comprasnetGet(`/comprasnet-fase-externa/v1/compras/${compraId}/itens/em-selecao-fornecedores`);
    if (fallback.status === 401 || fallback.status === 403) {
      return { itens: [], fase: 'auth-error', stub: true, authError: true, status: fallback.status };
    }
    return { itens: fallback.ok && Array.isArray(fallback.data) ? fallback.data : [], fase: 'selecao', stub: !fallback.ok };
  }

  const q = qtdes.data || {};
  let itens = [];
  let fase = 'desconhecida';

  // 2. Em disputa
  if (q.qtdeItensEmDisputa > 0) {
    fase = 'disputa';
    const r = await comprasnetGet(
      `/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa?tamanhoPagina=50&pagina=0&filtro=1`
    );
    if (r.ok && Array.isArray(r.data)) itens = r.data;

    // Filtros extras para compras com auto-lance
    if (autoCompraIds.includes(compraId)) {
      for (const f of [3, 4, 5]) {
        const rf = await comprasnetGet(
          `/comprasnet-disputa/v1/compras/${compraId}/itens/em-disputa?tamanhoPagina=50&pagina=0&filtro=${f}`
        );
        if (rf.ok && Array.isArray(rf.data)) {
          // Enriquecer itens com flags (SNIPER-M02: coerção String para match robusto)
          for (const item of rf.data) {
            const key = String(item.numero);
            const match = itens.find(i => String(i.numero) === key);
            if (match) {
              if (f === 3) match.estaPerdendo = true;
              if (f === 4) match.emEncAleatoria = true;
              if (f === 5) match.nosDoisMinFinais = true;
            }
          }
        }
      }
    }
  }

  // 3. Disputa encerrada
  if (q.qtdeItensComDisputaEncerrada > 0 && itens.length === 0) {
    fase = 'encerrada';
    const r = await comprasnetGet(
      `/comprasnet-disputa/v1/compras/${compraId}/itens/disputa-encerrada?tamanhoPagina=50&pagina=0&filtro=1`
    );
    if (r.ok && Array.isArray(r.data)) itens = r.data;
  }

  // 4. Classificação (fallback)
  if (itens.length === 0) {
    fase = 'classificacao';
    const r = await comprasnetGet(`/comprasnet-disputa/v1/compras/${compraId}/itens/classificacao`);
    if (r.ok && Array.isArray(r.data)) itens = r.data;
  }

  // 5. Seleção de fornecedores (fallback)
  if (itens.length === 0) {
    fase = 'selecao';
    const r = await comprasnetGet(`/comprasnet-fase-externa/v1/compras/${compraId}/itens/em-selecao-fornecedores`);
    if (r.ok && Array.isArray(r.data)) itens = r.data;
  }

  return { itens, fase, stub: itens.length === 0 };
}

// ─── Enviar lance ───────────────────────────────────────────────────────────

async function enviarLance(compraId, itemNumero, valor, faseItem = 'LA') {
  // Retry curto — a janela de disputa é pequena (segundos) e bloquear o processor
  // com 2+4+8s = 14s é pior que desistir e deixar próximo poll tentar.
  // 400/401/403/422 = fatais (nenhum retry resolve); 429/5xx/0 = retryable.
  const MAX_RETRIES = 2;
  const BACKOFF = [400, 800]; // ms
  const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 0]);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const r = await comprasnetPost(
      `/comprasnet-disputa/v1/compras/${compraId}/itens/${itemNumero}/lances`,
      { valorInformado: valor, faseItem }
    );

    if (r.ok) return r;

    if (RETRYABLE_STATUSES.has(r.status) && attempt < MAX_RETRIES) {
      const wait = BACKOFF[attempt] || 800;
      await new Promise(res => setTimeout(res, wait));
      continue;
    }

    return r;
  }
}

// ─── Participação detalhes ──────────────────────────────────────────────────

async function fetchParticipacao(compraId) {
  return comprasnetGet(`/comprasnet-fase-externa/v1/compras/${compraId}/participacao`);
}

// ─── Proposta ───────────────────────────────────────────────────────────────

async function enviarDeclaracao(compraId) {
  return comprasnetPost(`/comprasnet-fase-externa/v1/compras/${compraId}/participacao`, {
    declaracaoEquidadeGenero: null,
  });
}

async function enviarProposta(compraId, itemNumero, valorUnitario, quantidade) {
  return comprasnetPost(`/comprasnet-fase-externa/v1/compras/${compraId}/itens/${itemNumero}/proposta`, {
    valorUnitario,
    quantidade,
  });
}

// ─── Anti-idle (clicar botões de sessão expirada) ───────────────────────────

async function antiIdle() {
  try {
    return await wv().executeJavaScript(`
      (function() {
        const texts = ['ok', 'continuar', 'permanecer conectado', 'sim'];
        const btns = Array.from(document.querySelectorAll('button, a.btn, input[type="button"]'));
        for (const btn of btns) {
          const t = (btn.textContent || btn.value || '').trim().toLowerCase();
          if (texts.some(x => t.includes(x)) && btn.offsetParent !== null) {
            btn.click();
            return 'clicked: ' + t;
          }
        }
        // Simular atividade
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
        return null;
      })()
    `);
  } catch {
    return null;
  }
}

module.exports = {
  init,
  comprasnetGet,
  comprasnetPost,
  comprasnetPut,
  comprasnetDelete,
  datahorabrasilia,
  sessaoFornecedor,
  fetchParticipacoes,
  fetchMensagens,
  fetchMensagensGlobal,
  fetchMensagensGlobalPage0,
  fetchItensCompra,
  enviarLance,
  fetchParticipacao,
  enviarDeclaracao,
  enviarProposta,
  antiIdle,
  COMPRASNET,
  _getWV: () => _wv,
};
