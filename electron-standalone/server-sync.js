// server-sync.js — Comunicação com servidor LiciteAgora + orquestração de sync
'use strict';

const http = require('http');
const https = require('https');
const cnet = require('./comprasnet-api');

// Multi-tenant (Fase 6, 2026-04-22): SERVER_URL vem do init() —
// electron-browser passa a URL resolvida via config/argv/env.
let SERVER_URL = null;
let API_KEY = null;

// ─── State ──────────────────────────────────────────────────────────────────

let syncRunning = false;
let syncCount = 0;
let syncTimer = null;
let keepaliveTimer = null;
let heartbeatTimer = null;
let lastBearerSentAt = 0;
let lastBearerSent = null;
let ssoMorto = false;
let encerradasTracker = {}; // compraId → ciclos ausente

// Auditoria — atualizados ao longo do ciclo, enviados no heartbeat.
let lastCaptureAt = null;       // ISO — último Bearer visto via enviarBearer()
let lastSendAttemptAt = null;   // ISO — última tentativa de POST /api/auth/token
let lastSendStatus = null;      // string — HTTP status (ou 'timeout', '0', 'skip-dedup')

// Callbacks
let _getBearer = null;
let _getBearerTimestamp = null;
let _onSSODead = null;
let _onNewBearer = null;
let _onNeedReload = null;
let _log = console.log;
let _portal = null;
let _versao = null;
let reloginEmAndamento = false;
let aguardandoNovoBearer = false;
let aguardandoDesde = 0;
const AGUARDANDO_TIMEOUT_MS = 90000; // 30s timeout

const SYNC_INTERVAL_MS = 120000;    // 2 min
const KEEPALIVE_INTERVAL_MS = 120000; // 2 min (re-auth SSO estilo Lancer — fluxo de 23s evita trigger hCaptcha)
const RETOKEN_THRESHOLD_MS = 240000;  // 4 min — retoken HTTP proativo (TTL 9 min → ~5 min de buffer)
const RELOAD_LAST_RESORT_MS = 420000; // 7 min — reload SÓ se retoken falhar perto do TTL (v5.2.3: antes recarregava todo ciclo → acionava hCaptcha)
const HEARTBEAT_INTERVAL_MS = 30000;  // 30s — audita estado pra dashboard tokens.html
let lastParticipacoes = [];          // último sync — usada pelo motor timer

// ─── Init ───────────────────────────────────────────────────────────────────

function init(opts) {
  API_KEY = opts.apiKey;
  SERVER_URL = opts.serverUrl;
  if (!SERVER_URL) throw new Error('server-sync: opts.serverUrl é obrigatório');
  _getBearer = opts.getBearer;
  _getBearerTimestamp = opts.getBearerTimestamp;
  _onSSODead = opts.onSSODead || (() => {});
  _onNewBearer = opts.onNewBearer || (() => {});
  _onNeedReload = opts.onNeedReload || null;
  _log = opts.log || console.log;
  _portal = opts.portal || null;
  _versao = opts.versao || null;
}

function start() {
  _log('[Sync] Iniciando sync a cada 2 min + keepalive a cada 60s + heartbeat a cada 30s');
  // Sync imediato (3s delay)
  setTimeout(() => executarSync(), 3000);
  syncTimer = setInterval(() => executarSync(), SYNC_INTERVAL_MS);
  // Keepalive com 30s de delay inicial
  setTimeout(() => executarKeepalive(), 30000);
  keepaliveTimer = setInterval(() => executarKeepalive(), KEEPALIVE_INTERVAL_MS);
  // Heartbeat — primeiro disparo em 5s pra logar boot do Electron
  setTimeout(() => enviarHeartbeat(), 5000);
  heartbeatTimer = setInterval(() => enviarHeartbeat(), HEARTBEAT_INTERVAL_MS);
}

function stop() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function isSSODead() { return ssoMorto; }

// ─── HTTP helper para falar com o servidor ──────────────────────────────────

function serverRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (API_KEY) headers['X-Api-Key'] = API_KEY;

    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 15000,
    };

    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(data) });
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

// ─── Enviar Bearer ao servidor ──────────────────────────────────────────────

async function enviarBearer() {
  const token = _getBearer();
  if (!token) return;

  // Bearer está em memória — marca captura pra heartbeat (auditoria).
  lastCaptureAt = new Date().toISOString();

  // Dedup: só enviar se mudou ou >60s
  const now = Date.now();
  if (token === lastBearerSent && (now - lastBearerSentAt) < 60000) {
    lastSendStatus = 'skip-dedup';
    return;
  }

  lastSendAttemptAt = new Date().toISOString();
  const r = await serverRequest('POST', '/api/auth/token', {
    token,
    source: 'electron',
    timestamp: lastSendAttemptAt,
  });
  lastSendStatus = r.error ? r.error : String(r.status);

  if (r.ok) {
    lastBearerSent = token;
    lastBearerSentAt = now;
    _log('[Sync] Bearer enviado ao servidor');
  } else {
    _log(`[Sync] Erro ao enviar bearer: ${r.status} ${r.error || ''}`);
  }
}

// ─── Heartbeat (auditoria de fora — operacional/tokens.html) ────────────────
// Envia snapshot do estado interno a cada 30s. Servidor purga >24h.
// Token NUNCA é enviado — só metadados.

async function enviarHeartbeat() {
  try {
    const token = _getBearer && _getBearer();
    const ts = _getBearerTimestamp && _getBearerTimestamp();
    const tokenAgeSec = (token && ts) ? Math.floor((Date.now() - ts) / 1000) : null;

    // Subject (CPF) — best-effort, sem quebrar se token inválido.
    let subject = null;
    try {
      if (token) {
        const raw = token.replace(/^Bearer\s+/, '');
        const parts = raw.split('.');
        if (parts.length === 3) {
          const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
          const padLen = padded.length % 4 === 0 ? 0 : (4 - padded.length % 4);
          const json = Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8');
          const payload = JSON.parse(json);
          subject = payload.sub || payload.preferred_username || null;
        }
      }
    } catch (_) { /* payload corrompido — ok, subject fica null */ }

    await serverRequest('POST', '/api/electron/heartbeat', {
      tokenPresent: !!token,
      tokenAgeSec,
      lastCaptureAt,
      ssoMorto,
      lastSendAttemptAt,
      lastSendStatus,
      portal: _portal,
      versao: _versao,
      subject,
    });
  } catch (_) { /* não logar — heartbeat é silencioso, falha é normal */ }
}

// Envia captcha hCaptcha (P1_...) capturado da query string Comprasnet.
// Usado por endpoints fase-externa/aguardando-abertura-sessao-publica e
// /comprasnet-mensagem. Dedup: só envia se mudou ou >60s.
let lastCaptchaSent = null;
let lastCaptchaSentAt = 0;
async function enviarCaptcha(captchaToken) {
  if (!captchaToken) return;
  const now = Date.now();
  if (captchaToken === lastCaptchaSent && (now - lastCaptchaSentAt) < 60000) return;

  const bearer = _getBearer();
  const r = await serverRequest('POST', '/api/auth/token', {
    token: bearer,
    captchaToken,
    source: 'electron',
    timestamp: new Date().toISOString(),
  });

  if (r.ok) {
    lastCaptchaSent = captchaToken;
    lastCaptchaSentAt = now;
    _log(`[Sync] Captcha enviado ao servidor (${captchaToken.substring(0, 12)}…)`);
  } else {
    _log(`[Sync] Erro ao enviar captcha: ${r.status} ${r.error || ''}`);
  }
}

// ─── Sync principal (participações + mensagens + disputas) ──────────────────

async function executarSync() {
  if (syncRunning) return;
  if (ssoMorto) { _log('[Sync] SSO morto — skip sync'); return; }
  if (reloginEmAndamento) { _log('[Sync] Re-login em andamento — skip sync'); return; }

  const bearer = _getBearer();
  if (!bearer) { _log('[Sync] Sem bearer — skip sync'); return; }

  // 540000ms = TOKEN_SAFE_MARGIN (60s antes do expiry real de 600s no servidor).
  // Alinhado com lance-processor.js e sniper-lance.js TOKEN_SAFE_MARGIN_S.
  const bearerTs = _getBearerTimestamp();
  if (bearerTs && (Date.now() - bearerTs) > 540000) {
    _log('[Sync] Bearer stale (>9min) — skip sync');
    return;
  }

  syncRunning = true;
  syncCount++;
  const isFullSync = syncCount % 5 === 0;

  try {
    // Enviar bearer ao servidor
    await enviarBearer();

    // 1. Participações
    const filtros = isFullSync ? [5, 4, 3, 2, 6] : [5, 4, 3];
    _log(`[Sync] #${syncCount} Buscando participações (filtros: ${filtros.join(',')})...`);

    const participacoes = await cnet.fetchParticipacoes(filtros);
    lastParticipacoes = participacoes;
    _log(`[Sync] ${participacoes.length} participações encontradas`);

    if (participacoes.length > 0) {
      const r = await serverRequest('POST', '/api/sync/participacoes', { participacoes });
      if (r.ok) {
        _log(`[Sync] Participações: +${r.data?.inseridas || 0} ins, ${r.data?.atualizadas || 0} upd`);
      }
    }

    // Detectar encerradas
    await detectarEncerradas(participacoes);

    // 2. Mensagens — v1 global primeiro, fallback v2 por compra
    let mensagensOk = false;
    try {
      const globalResult = await cnet.fetchMensagensGlobal();
      if (globalResult.ok && globalResult.mensagens.length > 0) {
        const r = await serverRequest('POST', '/api/sync/mensagens-global', {
          mensagens: globalResult.mensagens,
        });
        if (r.ok) {
          _log(`[Sync] Mensagens v1 global: ${globalResult.mensagens.length} enviadas, ${r.data?.novas || 0} novas`);
          mensagensOk = true;
        }
      } else if (globalResult.ok) {
        mensagensOk = true;
        _log('[Sync] Mensagens v1 global: 0 mensagens');
      }
    } catch (e) {
      _log(`[Sync] Mensagens v1 falhou: ${e.message}`);
    }

    // Fallback v2 por compra se v1 falhou
    if (!mensagensOk) {
      _log('[Sync] Fallback mensagens v2 por compra...');
      const emAndamento = participacoes.filter(p => p._filtro === 5);
      for (const p of emAndamento) {
        const compraId = p.compraId || p.id;
        try {
          const msgs = await cnet.fetchMensagens(compraId);
          if (msgs.length > 0) {
            await serverRequest('POST', '/api/sync/mensagens', { compraId, mensagens: msgs });
          }
        } catch (e) {
          _log(`[Sync] Erro mensagens v2 ${compraId}: ${e.message}`);
        }
      }
    }

    // 3. Disputas (em andamento + em disputa)
    const paraDisputas = participacoes.filter(p => p._filtro === 5 || p._filtro === 4);

    // Buscar quais compras têm auto-lance configurado
    let autoCompraIds = [];
    try {
      const ac = await serverRequest('GET', '/api/sniper/auto-compras');
      if (ac.ok && Array.isArray(ac.data?.compraIds)) {
        autoCompraIds = ac.data.compraIds;
      }
    } catch {}

    const disputas = [];
    for (const p of paraDisputas) {
      const compraId = p.compraId || p.id;
      try {
        const { itens, fase, stub } = await cnet.fetchItensCompra(compraId, autoCompraIds);
        disputas.push({
          compraId,
          orgao: p.orgao || p.nomeUasg || '',
          objeto: p.objeto || p.descricao || '',
          dataSessao: p.dataHoraInicioSessao || p.dataHoraAbertura || '',
          totalItens: itens.length,
          itensAtivos: itens.filter(i => i.situacao !== 'Encerrado').length,
          stub,
          itens: itens.map(i => {
            // Grupo/lote (numero -1, tipo G): melhor/nosso vêm em valorCalculado
            // dentro de melhorValorGeral/Fornecedor, não nos campos achatados.
            // Fallback restrito a grupo p/ não mexer no item normal.
            const ehGrupo = i.tipo === 'G' || i.numero < 0;
            const mg = i.melhorValorGeral || {};
            const mf = i.melhorValorFornecedor || {};
            return {
              numero: i.numero,
              tipo: i.tipo,
              identificador: i.identificador ?? null,
              descricao: i.descricao || '',
              fase: i.fase || fase,
              situacao: i.situacao || '',
              melhorValor: i.melhorLance?.valor ?? i.melhorValor ?? (ehGrupo ? (mg.valorInformado ?? mg.valorCalculado ?? null) : null),
              nossoValor: i.valorInformado ?? i.nossoValor ?? (ehGrupo ? (mf.valorInformado ?? mf.valorCalculado ?? null) : null),
              valorEstimado: i.valorEstimado ?? null,
              situacaoParticipante: i.situacaoParticipante || i.situacaoParticipanteDisputa || '',
              variacaoMinima: i.variacaoMinima ?? null,
              podeEnviar: i.podeEnviar ?? i.podeEnviarLances ?? false,
              fimContagem: i.fimContagem ?? null,
              quantidadeSolicitada: i.quantidadeSolicitada ?? null,
              disputaPorValorUnitario: i.disputaPorValorUnitario ?? true,
              estaPerdendo: i.estaPerdendo ?? false,
              emEncAleatoria: i.emEncAleatoria ?? false,
              nosDoisMinFinais: i.nosDoisMinFinais ?? false,
            };
          }),
        });
      } catch (e) {
        _log(`[Sync] Erro disputas ${compraId}: ${e.message}`);
      }
    }

    if (disputas.length > 0) {
      const r = await serverRequest('POST', '/api/sync/disputas', { disputas });
      if (r.ok) {
        _log(`[Sync] ${disputas.length} disputas sincronizadas`);
      }
    }

    _log(`[Sync] #${syncCount} concluído — ${participacoes.length} part, ${emAndamento.length} msgs, ${disputas.length} disp`);

  } catch (e) {
    _log(`[Sync] Erro: ${e.message}`);
  } finally {
    syncRunning = false;
  }
}

// ─── Detectar participações encerradas ──────────────────────────────────────

async function detectarEncerradas(participacoesAtuais) {
  const idsAtuais = new Set(participacoesAtuais.map(p => p.compraId || p.id));

  // Incrementar contador para compras ausentes
  for (const id of Object.keys(encerradasTracker)) {
    if (!idsAtuais.has(id)) {
      encerradasTracker[id]++;
    } else {
      delete encerradasTracker[id]; // voltou, resetar
    }
  }

  // Adicionar novas ao tracker (compras que sumiram)
  // Na 1ª execução, popular o tracker com todas as compras vistas
  if (syncCount === 1) {
    for (const id of idsAtuais) {
      encerradasTracker[id] = 0;
    }
    return;
  }

  // Reportar compras ausentes por 4+ ciclos
  const encerradas = Object.entries(encerradasTracker)
    .filter(([, count]) => count >= 4)
    .map(([id]) => id);

  if (encerradas.length > 0) {
    await serverRequest('POST', '/api/sync/participacoes-encerradas', { compraIds: encerradas });
    _log(`[Sync] ${encerradas.length} participações reportadas como encerradas`);
    for (const id of encerradas) delete encerradasTracker[id];
  }
}

// ─── Retoken via HTTP direto (Node.js, sem browser/CORS) ────────────────────
// Reintroduzido na v5.1.8 (originalmente commit 2fab745, removido em 6fdea27).
// Renova bearer chamando PUT no endpoint SERPRO. Resposta tem novo accessToken.
// Sem reload de webview, sem risco de hCaptcha, sem fluxo Lancer 3-passos.

// Lê os cookies de sessão do cnetmobile (session do webview, no processo MAIN) e monta
// o header Cookie. É o que faltava no retoken via Node: o endpoint /retoken valida o
// cookie de sessão do SERPRO/gov.br; sem ele = 401. (v5.2.15)
async function getCookieHeaderCnetmobile(wv) {
  try {
    if (!wv || !wv.session || !wv.session.cookies) return '';
    const cookies = await wv.session.cookies.get({ url: 'https://cnetmobile.estaleiro.serpro.gov.br' });
    return (cookies || []).map(c => `${c.name}=${c.value}`).join('; ');
  } catch { return ''; }
}

function retokenHTTP(currentBearer, cookieHeader) {
  return new Promise((resolve) => {
    const headers = {
      'Authorization': currentBearer,
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'x-device-platform': 'web',
      'x-version-number': '6.0.2',
    };
    // O /retoken valida o cookie de sessão; sem ele = 401. (v5.2.15: Node + cookies)
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    const options = {
      method: 'PUT',
      hostname: 'cnetmobile.estaleiro.serpro.gov.br',
      path: '/comprasnet-usuario/v2/sessao/fornecedor/retoken',
      timeout: 15000,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200 && json.accessToken) {
            resolve({ ok: true, status: 200, token: json.accessToken });
          } else {
            resolve({ ok: false, status: res.statusCode, error: data.substring(0, 200) });
          }
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, error: data.substring(0, 200) });
        }
      });
    });

    req.on('error', e => resolve({ ok: false, status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    req.end();
  });
}

// ─── Retoken via WEBVIEW (executeJavaScript fetch) ──────────────────────────
// O retoken via Node (retokenHTTP) sempre dava 401: o endpoint /sessao/fornecedor/
// retoken valida o COOKIE de sessão, e o https.request do Node não manda cookies.
// Aqui o fetch roda no webview com credentials:'include' → carrega os cookies da
// sessão gov.br/SERPRO (mesmo padrão de wvFetchJSON do comprasnet-api.js, que
// funciona). x-version-number alinhado a 6.0.0 (resto do app). Resposta tem o novo
// accessToken no corpo (json.accessToken) — não passa pelo interceptor de Bearer.
function retokenWebview(wv, currentBearer) {
  const url = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-usuario/v2/sessao/fornecedor/retoken';
  const js = `
    (async () => {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 15000);
        const r = await fetch(${JSON.stringify(url)}, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Authorization': ${JSON.stringify(currentBearer)},
            'x-device-platform': 'web',
            'x-version-number': '6.0.0',
          },
          signal: ctrl.signal,
        });
        clearTimeout(tid);
        const status = r.status;
        const text = await r.text();
        let token = null;
        try { const j = JSON.parse(text); if (j && j.accessToken) token = j.accessToken; } catch (_) {}
        return { ok: status >= 200 && status < 300 && !!token, status, token, error: token ? '' : (text || '').slice(0, 150) };
      } catch (e) {
        return { ok: false, status: 0, error: e && e.message ? e.message : String(e) };
      }
    })()
  `;
  return wv.executeJavaScript(js, true).catch(e => ({ ok: false, status: 0, error: 'executeJavaScript: ' + e.message }));
}

// Detecta se o webview escorregou para o fluxo de login gov.br (sso.acesso.gov.br /
// loginPortal / intro). Nesse estado o retoken cross-origin SEMPRE falha ("Failed to
// fetch") e o reload só re-dispara o hCaptcha em loop — então tratamos como sessão
// perdida (ssoMorto) em vez de recarregar. (v5.2.15)
function webviewNoLogin(wv) {
  try {
    const url = (wv && wv.getURL) ? String(wv.getURL() || '') : '';
    return /sso\.acesso\.gov\.br|acesso\.gov\.br\/login|loginPortal|loginPortalFornecedor|intro\.htm/i.test(url);
  } catch { return false; }
}

// ─── Keepalive (SSO + bearer renewal + anti-idle + legado) ──────────────────

let keepaliveCount = 0;

async function executarKeepalive() {
  if (ssoMorto) return;
  if (reloginEmAndamento) return;

  const bearer = _getBearer();
  if (!bearer) return;

  keepaliveCount++;

  const bearerTs = _getBearerTimestamp();
  const bearerIdade = bearerTs ? (Date.now() - bearerTs) : 0;

  // 1+2. Anti-idle + ping main.asp mantêm o SSO vivo SEM reload de página
  // (reload do webview Comprasnet aciona hCaptcha no gov.br). Rodam todo ciclo.
  try {
    const idleResult = await cnet.antiIdle();
    if (idleResult) {
      _log(`[Keepalive] Anti-idle: ${idleResult}`);
      await serverLog('idle-dialog', { action: idleResult });
    }
    if (keepaliveCount % 2 === 0) {
      try {
        const wv = cnet._getWV();
        if (wv) {
          await wv.executeJavaScript(`
            fetch('https://www.comprasnet.gov.br/main.asp?login=keepalive', {
              credentials: 'include', mode: 'no-cors'
            }).catch(() => {});
          `);
        }
      } catch {}
    }
  } catch (e) {
    _log(`[Keepalive] Erro anti-idle: ${e.message}`);
  }

  // 3. Se aguardando novo bearer após um reload de último recurso, checar timeout.
  if (aguardandoNovoBearer) {
    if (Date.now() - aguardandoDesde > AGUARDANDO_TIMEOUT_MS) {
      _log('[Keepalive] Timeout aguardando novo bearer após reload — SSO morto');
      aguardandoNovoBearer = false;
      ssoMorto = true;
      _onSSODead();
      await serverLog('reload-timeout-sso-morto', {});
    }
    return;
  }

  // 4. Renovação do Bearer: retoken HTTP é o caminho PRIMÁRIO (sem reload, zero
  // hCaptcha). Dispara aos 4 min de idade do token (TTL 9 min).
  if (bearerTs && bearerIdade > RETOKEN_THRESHOLD_MS) {
    // PRIMÁRIO: retoken via webview (carrega cookies → evita o 401 crônico do
    // Node). Fallback p/ Node só se o webview não estiver disponível.
    const wv = cnet._getWV();

    // Guard (v5.2.15): se o webview já está no login gov.br, o retoken cross-origin
    // falha ("Failed to fetch") e o reload só re-dispara hCaptcha em loop (queimando o
    // profile). Reconhece sessão perdida → ssoMorto + alerta, SEM retoken nem reload.
    if (webviewNoLogin(wv)) {
      if (!ssoMorto) {
        _log('[Keepalive] Webview no login gov.br — retoken impossível; SSO morto (precisa login manual)');
        ssoMorto = true;
        _onSSODead();
        await serverLog('sso-morto-login-page', { url: (wv && wv.getURL) ? String(wv.getURL()).slice(0, 120) : '' });
      }
      return;
    }

    // Retoken via Node COM cookies de sessão do webview (v5.2.15): resolve o 401 do
    // Node-sem-cookie E o CORS do webview-fetch. Sem reload → sem hCaptcha.
    const cookieHeader = await getCookieHeaderCnetmobile(wv);
    const via = cookieHeader ? 'node+cookie' : 'node';
    _log(`[Retoken] Bearer > 4min — renovando via ${via} (${cookieHeader ? cookieHeader.split(';').length + ' cookies' : 'sem cookie'})...`);
    const rt = await retokenHTTP(bearer, cookieHeader);
    if (rt.ok && rt.token) {
      _log(`[Retoken] OK (${via}) — novo Bearer sem reload`);
      _onNewBearer(rt.token);
      await enviarBearer();
      await serverLog('retoken-http-ok', { via });
      return;
    }
    _log(`[Retoken] FALHOU (${via}) status=${rt.status}: ${rt.error || ''}`);
    await serverLog('retoken-http-fail', { via, status: rt.status, error: rt.error });

    // 5. Último recurso: só recarrega o webview se o retoken FALHOU E o token
    // está perto de expirar (> 7 min). v5.2.3: antes o passo 4 recarregava todo
    // ciclo (~200-700 reloads/dia) e era o gatilho do hCaptcha de renovação.
    // Reload SÓ se ainda estiver no app (não no login — senão re-dispara hCaptcha) e
    // perto do TTL. Se o retoken falhou porque o webview drifou pro login, o guard
    // acima já cuidou; aqui é a última checagem antes de recarregar. (v5.2.15)
    if (_onNeedReload && bearerIdade > RELOAD_LAST_RESORT_MS && !webviewNoLogin(wv)) {
      _log(`[Keepalive] #${keepaliveCount} Retoken falhou e bearer perto do TTL — reload de último recurso`);
      aguardandoNovoBearer = true;
      aguardandoDesde = Date.now();
      await serverLog('reload-keepalive', { motivo: 'retoken-fail-near-ttl', idadeMs: bearerIdade });
      _onNeedReload();
    }
  }
}

// ─── Reviver SSO (chamado quando novo bearer chega após SSO morto) ──────────

function resetAguardando() {
  aguardandoNovoBearer = false;
  aguardandoDesde = 0;
}

function reviverSSO() {
  reloginEmAndamento = false;
  resetAguardando();
  if (ssoMorto) {
    ssoMorto = false;
    _log('[Sync] SSO revivido — retomando sync');
    // Sync imediato
    setTimeout(() => executarSync(), 2000);
  }
}

function marcarSSOmorto() {
  reloginEmAndamento = false;
  ssoMorto = true;
  _log('[Sync] Re-login falhou — SSO morto');
  _onSSODead();
}

// ─── Server log ─────────────────────────────────────────────────────────────

async function serverLog(tipo, dados = {}) {
  try {
    await serverRequest('POST', '/api/sniper/log', { tipo, ...dados, source: 'electron', timestamp: new Date().toISOString() });
  } catch {}
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  init,
  start,
  stop,
  enviarBearer,
  enviarCaptcha,
  enviarHeartbeat,
  executarSync,
  executarKeepalive,
  reviverSSO,
  resetAguardando,
  marcarSSOmorto,
  isSSODead,
  serverRequest,
  serverLog,
  get syncCount() { return syncCount; },
  getActiveCompraIds() {
    return lastParticipacoes
      .filter(p => p._filtro === 5 || p._filtro === 4)
      .map(p => p.compraId || p.id)
      .filter(Boolean);
  },
};
