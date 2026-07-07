'use strict';

/**
 * marketplaces-ml.js — Integração Mercado Livre, Fase 0 (autenticação OAuth real).
 *
 * Modelo (verificado na doc do ML 2026-07):
 *   - OAuth 2.0 authorization code + PKCE (S256).
 *   - Autorização: https://auth.mercadolivre.com.br/authorization?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256
 *   - Token/refresh: POST https://api.mercadolibre.com/oauth/token (x-www-form-urlencoded)
 *   - access_token TTL 6h; refresh_token é de USO ÚNICO (cada refresh devolve um novo).
 *   - scopes exigidos no app: offline_access + read + write.
 *
 * Arquitetura multi-tenant:
 *   - UM app de plataforma (ML_APP_ID/SECRET em env). redirect_uri FIXO no apex
 *     (não pode variar): https://liciteagora.app/api/marketplaces/ml/callback
 *   - /connect roda no subdomínio do tenant (sabe o slug) → gera state+PKCE, guarda o
 *     pendente no control.db, redireciona ao ML.
 *   - /callback é rota GLOBAL no apex (pública, sem sessão) → lê o state no control.db,
 *     resolve o tenant, troca code→token, GET /users/me, grava os tokens (cifrados) no DB
 *     daquele tenant. Cada lojista autoriza o app na conta ML dele.
 *
 * Env necessárias (no consulta-licitacoes.service):
 *   ML_APP_ID, ML_APP_SECRET, ML_REDIRECT_URI (default = apex), ML_TOKEN_KEY (cripto dos tokens).
 */

const crypto = require('crypto');
const Database = require('better-sqlite3');
const { CONTROL_DB_PATH } = require('./tenant-manager');

const AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';
const TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const API_BASE = 'https://api.mercadolibre.com';
const DEFAULT_REDIRECT = 'https://liciteagora.app/api/marketplaces/ml/callback';
const ACCESS_TTL_FALLBACK = 6 * 3600; // 6h (a resposta traz expires_in; fallback)

function mlConfig() {
  return {
    appId: process.env.ML_APP_ID || '',
    secret: process.env.ML_APP_SECRET || '',
    redirectUri: process.env.ML_REDIRECT_URI || DEFAULT_REDIRECT,
  };
}
function configOk() { const c = mlConfig(); return !!(c.appId && c.secret); }

// ─── Cripto dos tokens (AES-256-GCM; chave em ML_TOKEN_KEY) ──────────────────
function getKey() {
  const raw = process.env.ML_TOKEN_KEY || '';
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw, 'utf8').digest(); // deriva 32 bytes
}
function cifrar(txt) {
  const key = getKey();
  if (!key) throw new Error('ML_TOKEN_KEY não configurada');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(txt), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decifrar(blob) {
  const key = getKey();
  if (!key || !blob || !String(blob).startsWith('v1:')) return null;
  try {
    const buf = Buffer.from(String(blob).slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}

// ─── PKCE (RFC 7636, S256) + state ───────────────────────────────────────────
function gerarPKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url'); // 43 chars, [A-Za-z0-9-_]
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
function gerarState() { return crypto.randomBytes(24).toString('base64url'); }

function buildAuthorizeUrl({ state, codeChallenge }) {
  const c = mlConfig();
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: c.appId,
    redirect_uri: c.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${p.toString()}`;
}

// ─── Chamadas ao ML ──────────────────────────────────────────────────────────
async function postToken(params) {
  const c = mlConfig();
  const body = new URLSearchParams({ client_id: c.appId, client_secret: c.secret, ...params });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json };
}
function trocarCodePorToken(code, codeVerifier) {
  const c = mlConfig();
  return postToken({ grant_type: 'authorization_code', code, redirect_uri: c.redirectUri, code_verifier: codeVerifier });
}
function refreshAccessToken(refreshToken) {
  return postToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
}
async function getUsuarioMe(accessToken) {
  const r = await fetch(`${API_BASE}/users/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return r.ok ? r.json().catch(() => null) : null;
}

// ─── control.db: pendências do OAuth (state→tenant+verifier) ──────────────────
let _control = null;
function control() {
  if (!_control) {
    _control = new Database(CONTROL_DB_PATH);
    _control.exec(`CREATE TABLE IF NOT EXISTS ml_oauth_pending (
      state TEXT PRIMARY KEY, tenantSlug TEXT NOT NULL, codeVerifier TEXT NOT NULL, criadoEm INTEGER NOT NULL );`);
  }
  return _control;
}
function salvarPendente(state, tenantSlug, codeVerifier) {
  control().prepare('INSERT OR REPLACE INTO ml_oauth_pending (state, tenantSlug, codeVerifier, criadoEm) VALUES (?,?,?,?)')
    .run(state, tenantSlug, codeVerifier, Date.now());
}
function consumirPendente(state) {
  const db = control();
  const row = db.prepare('SELECT * FROM ml_oauth_pending WHERE state = ?').get(state);
  if (row) db.prepare('DELETE FROM ml_oauth_pending WHERE state = ?').run(state);
  // Limpeza de pendências velhas (>1h)
  db.prepare('DELETE FROM ml_oauth_pending WHERE criadoEm < ?').run(Date.now() - 3600000);
  return row || null;
}

// ─── Schema do tenant: tokens em marketplaces_integracoes ────────────────────
function migrarSchemaTenant(db) {
  const cols = {
    mlUserId: 'TEXT', mlNickname: 'TEXT', accessTokenEnc: 'TEXT', refreshTokenEnc: 'TEXT',
    expiresAt: 'INTEGER', scopes: 'TEXT', conectadoEm: 'TEXT',
  };
  for (const [c, t] of Object.entries(cols)) { try { db.exec(`ALTER TABLE marketplaces_integracoes ADD COLUMN ${c} ${t}`); } catch {} }
}

// Grava/atualiza a integração ML de um tenant a partir da resposta de token.
function gravarTokens(db, tokenJson, me) {
  const expiresAt = Date.now() + ((Number(tokenJson.expires_in) || ACCESS_TTL_FALLBACK) * 1000);
  const accessEnc = cifrar(tokenJson.access_token);
  const refreshEnc = cifrar(tokenJson.refresh_token);
  const existe = db.prepare("SELECT id FROM marketplaces_integracoes WHERE canal='mercado-livre'").get();
  if (existe) {
    db.prepare(`UPDATE marketplaces_integracoes SET accessTokenEnc=?, refreshTokenEnc=?, expiresAt=?, scopes=?,
      mlUserId=?, mlNickname=?, ativo=1, conectadoEm=COALESCE(conectadoEm, CURRENT_TIMESTAMP), ultimaSync=CURRENT_TIMESTAMP WHERE id=?`)
      .run(accessEnc, refreshEnc, expiresAt, tokenJson.scope || null,
        String(me?.id || tokenJson.user_id || ''), me?.nickname || null, existe.id);
    return existe.id;
  }
  const r = db.prepare(`INSERT INTO marketplaces_integracoes
    (canal, apelido, ativo, accessTokenEnc, refreshTokenEnc, expiresAt, scopes, mlUserId, mlNickname, conectadoEm)
    VALUES ('mercado-livre', ?, 1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
    .run(me?.nickname || 'Mercado Livre', accessEnc, refreshEnc, expiresAt, tokenJson.scope || null,
      String(me?.id || tokenJson.user_id || ''), me?.nickname || null);
  return r.lastInsertRowid;
}

// Refresh proativo dos tokens que vencem em <1h (chamado pelo scheduler per-tenant).
async function refreshVencendo(db, log = () => {}) {
  const linha = db.prepare("SELECT id, refreshTokenEnc, expiresAt FROM marketplaces_integracoes WHERE canal='mercado-livre' AND ativo=1 AND refreshTokenEnc IS NOT NULL").get();
  if (!linha) return { skip: 'sem integração' };
  if (Number(linha.expiresAt || 0) - Date.now() > 3600000) return { skip: 'ainda válido' };
  const refresh = decifrar(linha.refreshTokenEnc);
  if (!refresh) return { erro: 'refresh não decifrável (ML_TOKEN_KEY mudou?)' };
  const r = await refreshAccessToken(refresh);
  if (!r.ok || !r.json?.access_token) {
    db.prepare('INSERT INTO marketplaces_logs (canal, tipo, mensagem, sucesso) VALUES (?,?,?,0)')
      .run('mercado-livre', 'refresh', `Falha refresh: ${r.status} ${JSON.stringify(r.json || {}).slice(0, 200)}`);
    return { erro: `refresh falhou (${r.status})` };
  }
  gravarTokens(db, r.json, null);
  log('[ML] token renovado');
  return { ok: true };
}

// ─── Rotas ───────────────────────────────────────────────────────────────────
// Per-tenant (autenticada): inicia o OAuth. Registrada no route-registry.
function registrarRotasTenant(app, db) {
  app.get('/api/marketplaces/ml/connect', (req, res) => {
    try {
      if (!configOk()) return res.status(503).send('Integração ML não configurada no servidor (ML_APP_ID/SECRET).');
      const slug = req.tenant?.slug || req.tenantCtx?.slug;
      if (!slug) return res.status(400).send('Tenant não resolvido.');
      const state = gerarState();
      const { verifier, challenge } = gerarPKCE();
      salvarPendente(state, slug, verifier);
      res.redirect(buildAuthorizeUrl({ state, codeChallenge: challenge }));
    } catch (e) { res.status(500).send('Erro ao iniciar conexão ML: ' + e.message); }
  });

  // Status da integração (pra UI saber se está conectado).
  app.get('/api/marketplaces/ml/status', (req, res) => {
    try {
      const r = db.prepare("SELECT mlUserId, mlNickname, ativo, expiresAt, conectadoEm, scopes FROM marketplaces_integracoes WHERE canal='mercado-livre'").get();
      res.json({ success: true, conectado: !!(r && r.ativo && r.mlUserId), integracao: r || null, configurado: configOk() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
}

// Global (apex, pública): recebe o callback do ML. Registrada no server.js com tenantManager.
function registrarRotasGlobal(app, { tenantManager }) {
  app.get('/api/marketplaces/ml/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send('Autorização negada no Mercado Livre: ' + error);
    if (!code || !state) return res.status(400).send('Callback inválido (faltou code/state).');
    const pend = consumirPendente(String(state));
    if (!pend) return res.status(400).send('State inválido ou expirado. Recomece a conexão.');
    try {
      const tok = await trocarCodePorToken(String(code), pend.codeVerifier);
      if (!tok.ok || !tok.json?.access_token) {
        return res.status(502).send('Falha ao trocar code por token: ' + JSON.stringify(tok.json || tok.status));
      }
      const me = await getUsuarioMe(tok.json.access_token);
      const tdb = tenantManager.getDb(pend.tenantSlug);
      gravarTokens(tdb, tok.json, me);
      res.redirect(`https://${pend.tenantSlug}.liciteagora.app/varejo/marketplaces.html?ml=conectado`);
    } catch (e) {
      res.status(500).send('Erro no callback ML: ' + e.message);
    }
  });
}

module.exports = {
  registrarRotasTenant,
  registrarRotasGlobal,
  migrarSchemaTenant,
  refreshVencendo,
  configOk,
  // expostos p/ teste
  _internal: { cifrar, decifrar, gerarPKCE, gerarState, buildAuthorizeUrl, mlConfig },
};
