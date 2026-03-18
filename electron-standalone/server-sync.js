// server-sync.js — Comunicação com servidor LiciteAgora + orquestração de sync
'use strict';

const http = require('http');
const https = require('https');
const cnet = require('./comprasnet-api');

const SERVER_URL = 'http://217.216.85.37:8080';
let API_KEY = null;

// ─── State ──────────────────────────────────────────────────────────────────

let syncRunning = false;
let syncCount = 0;
let syncTimer = null;
let keepaliveTimer = null;
let lastBearerSentAt = 0;
let lastBearerSent = null;
let ssoMorto = false;
let encerradasTracker = {}; // compraId → ciclos ausente

// Callbacks
let _getBearer = null;
let _getBearerTimestamp = null;
let _onSSODead = null;
let _onNewBearer = null;
let _log = console.log;

const SYNC_INTERVAL_MS = 120000;    // 2 min
const KEEPALIVE_INTERVAL_MS = 120000; // 2 min

// ─── Init ───────────────────────────────────────────────────────────────────

function init(opts) {
  API_KEY = opts.apiKey;
  _getBearer = opts.getBearer;
  _getBearerTimestamp = opts.getBearerTimestamp;
  _onSSODead = opts.onSSODead || (() => {});
  _onNewBearer = opts.onNewBearer || (() => {});
  _log = opts.log || console.log;
}

function start() {
  _log('[Sync] Iniciando sync a cada 2 min + keepalive a cada 2 min');
  // Sync imediato (3s delay)
  setTimeout(() => executarSync(), 3000);
  syncTimer = setInterval(() => executarSync(), SYNC_INTERVAL_MS);
  // Keepalive com 30s de delay inicial
  setTimeout(() => executarKeepalive(), 30000);
  keepaliveTimer = setInterval(() => executarKeepalive(), KEEPALIVE_INTERVAL_MS);
}

function stop() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
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

  // Dedup: só enviar se mudou ou >60s
  const now = Date.now();
  if (token === lastBearerSent && (now - lastBearerSentAt) < 60000) return;

  const r = await serverRequest('POST', '/api/auth/token', {
    token,
    source: 'electron',
    timestamp: new Date().toISOString(),
  });

  if (r.ok) {
    lastBearerSent = token;
    lastBearerSentAt = now;
    _log('[Sync] Bearer enviado ao servidor');
  } else {
    _log(`[Sync] Erro ao enviar bearer: ${r.status} ${r.error || ''}`);
  }
}

// ─── Sync principal (participações + mensagens + disputas) ──────────────────

async function executarSync() {
  if (syncRunning) return;
  if (ssoMorto) { _log('[Sync] SSO morto — skip sync'); return; }

  const bearer = _getBearer();
  if (!bearer) { _log('[Sync] Sem bearer — skip sync'); return; }

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
    _log(`[Sync] ${participacoes.length} participações encontradas`);

    if (participacoes.length > 0) {
      const r = await serverRequest('POST', '/api/sync/participacoes', { participacoes });
      if (r.ok) {
        _log(`[Sync] Participações: +${r.data?.inseridas || 0} ins, ${r.data?.atualizadas || 0} upd`);
      }
    }

    // Detectar encerradas
    await detectarEncerradas(participacoes);

    // 2. Mensagens (para participações em andamento, filtro=5)
    const emAndamento = participacoes.filter(p => p._filtro === 5);
    for (const p of emAndamento) {
      const compraId = p.compraId || p.id;
      try {
        const msgs = await cnet.fetchMensagens(compraId);
        if (msgs.length > 0) {
          await serverRequest('POST', '/api/sync/mensagens', { compraId, mensagens: msgs });
        }
      } catch (e) {
        _log(`[Sync] Erro mensagens ${compraId}: ${e.message}`);
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
          itens: itens.map(i => ({
            numero: i.numero,
            tipo: i.tipo,
            descricao: i.descricao || '',
            fase: i.fase || fase,
            situacao: i.situacao || '',
            melhorValor: i.melhorLance?.valor ?? i.melhorValor ?? null,
            nossoValor: i.valorInformado ?? i.nossoValor ?? null,
            valorEstimado: i.valorEstimado ?? null,
            situacaoParticipante: i.situacaoParticipante || '',
            variacaoMinima: i.variacaoMinima ?? null,
            podeEnviar: i.podeEnviar ?? false,
            fimContagem: i.fimContagem ?? null,
            quantidadeSolicitada: i.quantidadeSolicitada ?? null,
            disputaPorValorUnitario: i.disputaPorValorUnitario ?? true,
            estaPerdendo: i.estaPerdendo ?? false,
            emEncAleatoria: i.emEncAleatoria ?? false,
            nosDoisMinFinais: i.nosDoisMinFinais ?? false,
          })),
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

// ─── Keepalive (SSO + bearer renewal + anti-idle) ───────────────────────────

async function executarKeepalive() {
  if (ssoMorto) return;

  const bearer = _getBearer();
  if (!bearer) return;

  try {
    // 1. Anti-idle (clicar botões de sessão)
    const idleResult = await cnet.antiIdle();
    if (idleResult) {
      _log(`[Keepalive] Anti-idle: ${idleResult}`);
      await serverLog('idle-dialog', { action: idleResult });
    }

    // 2. Retoken proativo (se bearer > 5 min)
    const bearerTs = _getBearerTimestamp();
    if (bearerTs && (Date.now() - bearerTs) > 300000) {
      _log('[Keepalive] Bearer > 5 min — tentando retoken proativo...');
      const rt = await cnet.retoken();
      if (rt.ok && rt.data?.accessToken) {
        _log('[Keepalive] Retoken OK — novo bearer obtido');
        _onNewBearer(rt.data.accessToken);
        await enviarBearer();
        await serverLog('retoken-proativo', { ok: true });
        return; // Bearer renovado, não precisa keepalive adicional
      } else {
        _log(`[Keepalive] Retoken falhou: ${rt.status}`);
        await serverLog('retoken-proativo', { ok: false, status: rt.status });
      }
    }

    // 3. Keepalive via datahorabrasilia
    const ka = await cnet.datahorabrasilia();
    if (ka.ok) {
      if (syncCount % 5 === 0) _log(`[Keepalive] OK — ${ka.data || ''}`);
      await enviarBearer();
    } else if (ka.status === 401 || ka.status === 403) {
      _log(`[Keepalive] Sessão expirada (${ka.status}) — tentando retoken...`);

      const rt = await cnet.retoken();
      if (rt.ok && rt.data?.accessToken) {
        _log('[Keepalive] Retoken OK após expiração');
        _onNewBearer(rt.data.accessToken);
        await enviarBearer();
        await serverLog('retoken', { ok: true });
      } else {
        _log('[Keepalive] Retoken falhou — SSO morto');
        ssoMorto = true;
        _onSSODead();
        await serverLog('sso-morto', { status: ka.status });
      }
    }

  } catch (e) {
    _log(`[Keepalive] Erro: ${e.message}`);
  }
}

// ─── Reviver SSO (chamado quando novo bearer chega após SSO morto) ──────────

function reviverSSO() {
  if (ssoMorto) {
    ssoMorto = false;
    _log('[Sync] SSO revivido — retomando sync');
    // Sync imediato
    setTimeout(() => executarSync(), 2000);
  }
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
  executarSync,
  executarKeepalive,
  reviverSSO,
  isSSODead,
  serverRequest,
  serverLog,
  get syncCount() { return syncCount; },
};
